"""Transport, retries, handshake headers, PKCE loopback login and Keychain storage (task addon-transport-auth, HFY-TSK-180).

Standard library only; no Gramps and no real network. Local servers on 127.0.0.1 stand in for the website (an https one with a
throwaway self-signed certificate for the TLS tests, plain http ones for the rest), and a small Python script stands in for
/usr/bin/security so the tests can see exactly what the addon puts on its argv and stdin. Every token here is made up.
"""
import json
import os
import re
import shlex
import shutil
import ssl
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
GRAMPS = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, GRAMPS)
sys.path.insert(0, HERE)

import test_addon_runtime as R  # noqa: E402
from hfygramps.addon import consts, keychain, oauth, runner, transport  # noqa: E402

TRUSTED = "/Applications/Gramps.app/Contents/MacOS/Gramps"
ITEM = "us.harrisonfamily.hfy_sync/https://harrisonfamily.us/auth|owner"  # sync.md 6, account simplified to <issuer>|owner
VERSIONS = transport.Versions("6.0.6", 21, tree_id="11111111-2222-4333-8444-555555555555")


# ------------------------------------------------------------------------------------------------ a scripted server


class Script:
    """Answers requests from a list of (status, body_dict_or_None, extra_headers); the last entry repeats. Records every request."""

    def __init__(self, *answers):
        self.answers = list(answers)
        self.seen = []  # (method, path, lower-cased headers, body bytes)

    def next(self):
        i = min(len(self.seen) - 1, len(self.answers) - 1)
        return self.answers[i]


def serve(script, tls=None):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):
            pass

        def handle_any(self):
            n = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(n) if n else b""
            script.seen.append((self.command, self.path, {k.lower(): v for k, v in self.headers.items()}, body))
            status, payload, extra = script.next()
            raw = json.dumps(payload).encode() if payload is not None else b""
            self.send_response(status)
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        do_GET = do_POST = do_PUT = handle_any  # noqa: N815

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    if tls:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(*tls)
        httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
    threading.Thread(target=httpd.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True).start()
    return httpd


class NetCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="hfy-transport-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.sleeps = []

    def start(self, script, tls=None):
        httpd = serve(script, tls)
        self.addCleanup(httpd.server_close)
        self.addCleanup(httpd.shutdown)
        return httpd

    def http(self, **kw):
        return transport.Http(ssl_context=ssl.create_default_context(), sleep=self.sleeps.append, **kw)

    def client(self, httpd, token="tok-1"):
        return transport.Client("http://127.0.0.1:%d" % httpd.server_port, VERSIONS, lambda: token, http=self.http())


# -------------------------------------------------------------------------------------------------------------- TLS


def make_cert(directory):
    """A self-signed certificate for 127.0.0.1, or None when openssl is not available."""
    if not shutil.which("openssl"):
        return None
    cert, key = os.path.join(directory, "cert.pem"), os.path.join(directory, "key.pem")
    proc = subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "2",
                           "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"],
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return (cert, key) if proc.returncode == 0 and os.path.exists(cert) else None


def empty_store_context():
    """What Gramps' bundled Python gives: a verifying context with no trusted roots."""
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = True
    ctx.verify_mode = ssl.CERT_REQUIRED
    return ctx


class Tls(NetCase):
    def setUp(self):
        super().setUp()
        self.pair = make_cert(self.tmp)
        if self.pair is None:
            self.skipTest("openssl is not available to make a throwaway certificate")

    def url(self, httpd):
        return "https://127.0.0.1:%d/api/sync/meta" % httpd.server_port

    def test_an_untrusted_certificate_is_refused_and_nothing_is_sent(self):
        script = Script((200, {"ok": True}, None))
        httpd = self.start(script, tls=self.pair)
        ctx = transport.make_ssl_context(cafile=None, factory=empty_store_context)  # no roots, no fallback file
        with self.assertRaises(transport.TransportError) as cm:
            transport.Http(ssl_context=ctx, sleep=self.sleeps.append).send("GET", self.url(httpd), {}, idempotent=True)
        self.assertEqual((cm.exception.code, cm.exception.exit_code), ("tls_verify_failed", 78))
        self.assertEqual(script.seen, [], "the request never got past the handshake")
        self.assertEqual(self.sleeps, [], "a certificate failure is not transient: no retry")

    def test_an_empty_default_store_falls_back_to_the_system_file_and_still_verifies(self):
        script = Script((200, {"api_version": 1}, None))
        httpd = self.start(script, tls=self.pair)
        # the "system file" is the throwaway certificate: it stands in for /etc/ssl/cert.pem
        ctx = transport.make_ssl_context(cafile=self.pair[0], factory=empty_store_context)
        self.assertEqual((ctx.verify_mode, ctx.check_hostname), (ssl.CERT_REQUIRED, True))
        resp = transport.Http(ssl_context=ctx, sleep=self.sleeps.append).send("GET", self.url(httpd), {}, idempotent=True)
        self.assertEqual((resp.status, resp.body), (200, {"api_version": 1}))
        self.assertEqual(len(script.seen), 1)

    def test_a_populated_default_store_is_used_as_is(self):
        def populated():
            ctx = empty_store_context()
            ctx.load_verify_locations(cafile=self.pair[0])
            return ctx
        other_dir = os.path.join(self.tmp, "other")
        os.mkdir(other_dir)
        other = make_cert(other_dir)
        made = transport.make_ssl_context(cafile=other[0], factory=populated)  # the fallback file must NOT be consulted
        self.assertEqual(made.cert_store_stats()["x509_ca"], 1)

    def test_the_fallback_does_not_trust_a_certificate_for_another_host(self):
        script = Script((200, {}, None))
        httpd = self.start(script, tls=self.pair)
        ctx = transport.make_ssl_context(cafile=self.pair[0], factory=empty_store_context)
        with self.assertRaises(transport.TransportError) as cm:  # the certificate names 127.0.0.1, not "localhost"
            transport.Http(ssl_context=ctx, sleep=self.sleeps.append, delays=()).send(
                "GET", "https://localhost:%d/x" % httpd.server_port, {}, idempotent=False)
        self.assertIn(cm.exception.code, ("tls_verify_failed", "network"))
        self.assertEqual(script.seen, [])

    def test_a_context_that_does_not_verify_is_refused(self):
        def off():
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            return ctx
        with self.assertRaises(transport.TransportError):
            transport.make_ssl_context(factory=off)

    def test_the_source_never_switches_verification_off(self):
        for name in ("transport.py", "oauth.py", "keychain.py", "runner.py"):
            with open(os.path.join(GRAMPS, "hfygramps", "addon", name), encoding="utf-8") as fh:
                text = fh.read()
            for bad in ("CERT_NONE", "_create_unverified_context", "check_hostname = False", "verify=False", "_https_verify_certificates"):
                self.assertNotIn(bad, text, "%s must not contain %s" % (name, bad))


# --------------------------------------------------------------------------------------------- retries and exit codes


class Retries(NetCase):
    def test_a_503_retryable_retries_three_times_at_1_4_16_then_succeeds(self):
        script = Script(*([(503, {"error": "retryable", "message": "m"}, None)] * 3 + [(200, {"head_seq": 5}, None)]))
        resp = self.client(self.start(script)).get("/api/sync/meta")
        self.assertEqual(resp.body, {"head_seq": 5})
        self.assertEqual(len(script.seen), 4)
        self.assertEqual(self.sleeps, [1, 4, 16])

    def test_gives_up_after_three_retries_with_exit_75(self):
        script = Script((503, {"error": "retryable", "message": "m"}, None))
        with self.assertRaises(transport.TransportError) as cm:
            self.client(self.start(script)).get("/api/sync/meta")
        self.assertEqual((cm.exception.exit_code, cm.exception.code), (75, "retryable"))
        self.assertEqual(len(script.seen), 4, "one call and three retries")
        self.assertEqual(self.sleeps, [1, 4, 16])

    def test_network_errors_retry_the_same_way(self):
        httpd = serve(Script((200, {}, None)))
        port = httpd.server_port
        httpd.shutdown()
        httpd.server_close()  # nothing listens on this port any more
        client = transport.Client("http://127.0.0.1:%d" % port, VERSIONS, lambda: "t", http=self.http())
        with self.assertRaises(transport.TransportError) as cm:
            client.get("/api/sync/meta")
        self.assertEqual((cm.exception.exit_code, cm.exception.code), (75, "network"))
        self.assertEqual(self.sleeps, [1, 4, 16])

    def test_a_post_with_an_idempotency_key_retries_and_replays_the_same_key(self):
        script = Script((503, {"error": "retryable", "message": "m"}, None), (200, {"batch_id": "b"}, None))
        resp = self.client(self.start(script)).post("/api/sync/batches", {"ops": []}, idempotency_key="key-1")
        self.assertEqual(resp.body, {"batch_id": "b"})
        self.assertEqual([s[2]["idempotency-key"] for s in script.seen], ["key-1", "key-1"])
        self.assertEqual([s[3] for s in script.seen][0], [s[3] for s in script.seen][1])
        self.assertEqual(self.sleeps, [1])

    def test_a_post_without_a_key_is_never_retried(self):
        script = Script((503, {"error": "retryable", "message": "m"}, None))
        with self.assertRaises(transport.TransportError) as cm:
            self.client(self.start(script)).post("/api/sync/status", {"x": 1})
        self.assertEqual(cm.exception.exit_code, 75)
        self.assertEqual((len(script.seen), self.sleeps), (1, []))

    def test_nothing_else_is_retried_and_each_maps_to_its_exit_code(self):
        cases = [
            (401, {"error": "unauthenticated", "message": "m"}, 77, "login"),
            (403, {"error": "step_up_required", "message": "m"}, 77, "step_up"),
            (426, {"error": "upgrade_required", "message": "m"}, 78, "update_addon"),
            (403, {"error": "not_owner", "message": "m"}, 78, "none"),
            (403, {"error": "tree_mismatch", "message": "m"}, 78, "open_bound_tree"),
            (409, {"error": "redaction_version_mismatch", "message": "m"}, 78, "update_addon"),
            (503, {"error": "sync_paused", "message": "m"}, 69, "none"),
            (404, {"error": "not_enabled", "message": "m"}, 69, "none"),
            (422, {"error": "privacy_violation", "message": "m"}, 65, "none"),
            (400, {"error": "validation", "message": "m"}, 65, "none"),
            (409, {"error": "version_conflict", "message": "m"}, 75, "retry"),
            (428, {"error": "idempotency_key_required", "message": "m"}, 70, "none"),
            (500, None, 75, "retry"),
        ]
        for status, body, exit_code, nxt in cases:
            with self.subTest(status=status, code=(body or {}).get("error")):
                script = Script((status, body, None))
                with self.assertRaises(transport.TransportError) as cm:
                    self.client(self.start(script)).get("/api/sync/meta")
                self.assertEqual((cm.exception.exit_code, cm.exception.next_action), (exit_code, nxt))
                self.assertEqual((len(script.seen), self.sleeps), (1, []), "one attempt, no sleeping")

    def test_a_redirect_is_not_followed_and_the_token_goes_nowhere_else(self):
        other = Script((200, {}, None))
        other_server = self.start(other)
        script = Script((302, None, {"Location": "http://127.0.0.1:%d/steal" % other_server.server_port}))
        with self.assertRaises(transport.TransportError) as cm:
            self.client(self.start(script)).get("/api/sync/meta")
        self.assertEqual(cm.exception.code, "unexpected_redirect")
        self.assertEqual(other.seen, [])

    def test_an_error_message_carries_no_body_text(self):
        script = Script((422, {"error": "privacy_violation", "message": "Jane Q. Example born 1900-01-01"}, None))
        with self.assertRaises(transport.TransportError) as cm:
            self.client(self.start(script)).get("/api/sync/meta")
        self.assertNotIn("Example", str(cm.exception))
        self.assertNotIn("1900", str(cm.exception))

    def test_only_https_or_a_loopback_dev_server_is_accepted(self):
        for bad in ("http://example.org", "ftp://127.0.0.1", "https://user:pw@example.org", "https://example.org/?a=1"):
            with self.assertRaises(ValueError, msg=bad):
                transport.check_server(bad)
        self.assertEqual(transport.check_server("https://harrisonfamily.us/"), "https://harrisonfamily.us")
        self.assertEqual(transport.check_server("http://127.0.0.1:8089"), "http://127.0.0.1:8089")


class Handshake(NetCase):
    def test_every_request_carries_the_handshake_headers_and_the_bearer_token(self):
        script = Script((200, {"ok": 1}, None))
        client = self.client(self.start(script), token="tok-abc")
        client.get("/api/sync/meta")
        client.post("/api/sync/status", {"a": 1})
        client.get("/api/sync/changes", query={"since": 3, "limit": 10})
        client.post("/api/sync/batches", {"ops": []}, idempotency_key="k")
        self.assertEqual(len(script.seen), 4)
        for method, path, headers, body in script.seen:
            self.assertEqual(headers["x-hfy-sync-client"], "hfy_sync/%s" % consts.ADDON_VERSION, path)
            self.assertEqual(headers["x-hfy-gramps-version"], "6.0.6", path)
            self.assertEqual(headers["x-hfy-gramps-schema"], "21", path)
            self.assertEqual(headers["x-hfy-redaction-version"], "1", path)
            self.assertEqual(headers["x-hfy-tree-id"], "11111111-2222-4333-8444-555555555555", path)
            self.assertEqual(headers["authorization"], "Bearer tok-abc", path)
        self.assertEqual(script.seen[2][1], "/api/sync/changes?since=3&limit=10")

    def test_requests_never_use_urllibs_default_agent_which_cloudflare_blocks(self):
        script = Script((200, {"ok": 1}, None))
        self.client(self.start(script)).get("/api/sync/meta")
        self.assertEqual(script.seen[0][2]["user-agent"], "hfy_sync/%s" % consts.ADDON_VERSION)
        auth = AuthServer(self)
        results = []
        oauth.login(auth.base, keychain.Keychain(trusted_app=TRUSTED, security=self.fake_security()), http=self.http(),
                    open_browser=browser_follows(results))
        self.assertEqual(auth.token_agents, ["hfy_sync/%s" % consts.ADDON_VERSION])

    def fake_security(self):
        path = os.path.join(self.tmp, "security")
        with open(path, "w") as fh:
            fh.write(FAKE_SECURITY)
        os.chmod(path, 0o755)
        os.environ["FAKE_SECURITY_STATE"] = os.path.join(self.tmp, "kc.json")
        self.addCleanup(os.environ.pop, "FAKE_SECURITY_STATE", None)
        return path

    def test_the_header_values_are_built_from_the_running_versions(self):
        v = transport.Versions("6.0.7", 22, tree_id=None, addon_version="9.9.9", redaction_version=2)
        self.assertEqual(v.headers(), {"X-HFY-Sync-Client": "hfy_sync/9.9.9", "X-HFY-Gramps-Version": "6.0.7",
                                       "X-HFY-Gramps-Schema": "22", "X-HFY-Redaction-Version": "2"})

    def test_only_sync_paths_are_callable(self):
        client = transport.Client("https://harrisonfamily.us", VERSIONS, lambda: "t", http=self.http())
        with self.assertRaises(ValueError):
            client.get("/api/records/Person/x")


class Probe(NetCase):
    """gramps/scripts/probe-cloudflare.py (DL-31): tells an origin answer from an edge block."""

    def probe(self, script, *args):
        httpd = self.start(script)
        proc = subprocess.run([sys.executable, os.path.join(GRAMPS, "scripts", "probe-cloudflare.py"), "--server",
                               "http://127.0.0.1:%d" % httpd.server_port] + list(args),
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
        return proc.returncode, json.loads(proc.stdout.strip().splitlines()[-1]), script

    def test_a_house_format_error_is_the_origin_answering(self):
        code, out, script = self.probe(Script((401, {"error": "unauthenticated", "message": "m"}, None)))
        self.assertEqual((code, out["result"], out["status"], out["cf_mitigated_header"]), (0, "answered_by_origin", 401, False))
        self.assertEqual(out["error_body"], {"error": "unauthenticated", "message": "m"})
        self.assertEqual(script.seen[0][2]["user-agent"], "hfy_sync/%s" % consts.ADDON_VERSION)
        self.assertNotIn("authorization", script.seen[0][2], "no token unless one is given")

    def test_a_cloudflare_style_block_is_not(self):
        code, out, _ = self.probe(Script((403, {"type": "https://example.org/err", "title": "Forbidden", "status": 403}, None)))
        self.assertEqual((code, out["result"], out["body_is_house_error"]), (1, "challenged_or_unexpected", False))

    def test_the_mitigated_header_marks_a_challenge_even_with_json(self):
        code, out, _ = self.probe(Script((403, {"error": "x", "message": "m"}, {"cf-mitigated": "challenge"})))
        self.assertEqual((code, out["cf_mitigated_header"]), (1, True))

    def test_the_default_agent_can_be_sent_for_comparison(self):
        _, out, script = self.probe(Script((404, {"error": "not_found", "message": "m"}, None)), "--default-user-agent")
        self.assertTrue(script.seen[0][2]["user-agent"].startswith("Python-urllib/"))
        self.assertEqual(out["user_agent"], "urllib-default")


# ------------------------------------------------------------------------------------------------- the fake Keychain

FAKE_SECURITY = r'''#!/usr/bin/env python3
import json, os, shlex, sys
state = os.environ["FAKE_SECURITY_STATE"]
with open(state + ".log", "a") as fh:
    fh.write(json.dumps({"argv": sys.argv[1:], "stdin": None if sys.stdin.isatty() else "see below"}) + "\n")
items = json.load(open(state)) if os.path.exists(state) else {}
mode = os.environ.get("FAKE_SECURITY_MODE", "ok")

def save():
    json.dump(items, open(state, "w"))

def add(args, update):
    opts = dict(zip(args[::2], args[1::2]))
    key = opts["-s"] + "/" + opts["-a"]
    if key in items:
        if not update:  # the real tool: errSecDuplicateItem
            print("security: SecKeychainItemCreateFromContent: The specified item already exists in the keychain.", file=sys.stderr)
            return
        items[key]["password"] = opts["-w"]  # -U updates the secret and keeps the old access list
    else:
        items[key] = {"password": opts["-w"], "trusted": opts.get("-T")}
    save()

argv = sys.argv[1:]
if argv[:1] == ["-i"]:
    text = sys.stdin.read()
    with open(state + ".stdin", "a") as fh:
        fh.write(text)
    if mode == "locked":
        print("security: SecKeychainItemCreateFromContent: User interaction is not allowed.", file=sys.stderr)
        sys.exit(0)  # interactive mode really does exit 0 after printing an error
    for line in text.splitlines():
        parts = shlex.split(line)
        if parts and parts[0] == "add-generic-password":
            add([p for p in parts[1:] if p != "-U"], "-U" in parts)
elif argv[0] == "find-generic-password":
    key = argv[argv.index("-s") + 1] + "/" + argv[argv.index("-a") + 1]
    if mode == "locked":
        print("security: User interaction is not allowed.", file=sys.stderr)
        sys.exit(36)
    if key not in items:
        print("security: The specified item could not be found in the keychain.", file=sys.stderr)
        sys.exit(44)
    print(items[key]["password"])
elif argv[0] == "delete-generic-password":
    key = argv[argv.index("-s") + 1] + "/" + argv[argv.index("-a") + 1]
    if key not in items:
        sys.exit(44)
    del items[key]
    save()
else:
    sys.exit(2)
'''


class KeychainCase(NetCase):
    def setUp(self):
        super().setUp()
        self.state = os.path.join(self.tmp, "kc.json")
        self.security = os.path.join(self.tmp, "security")
        with open(self.security, "w") as fh:
            fh.write(FAKE_SECURITY)  # runs under the system python3; the code under test is what runs in the bundle
        os.chmod(self.security, os.stat(self.security).st_mode | stat.S_IXUSR)
        os.environ["FAKE_SECURITY_STATE"] = self.state
        self.addCleanup(os.environ.pop, "FAKE_SECURITY_STATE", None)
        os.environ.pop("FAKE_SECURITY_MODE", None)
        self.addCleanup(os.environ.pop, "FAKE_SECURITY_MODE", None)

    def kc(self):
        return keychain.Keychain(trusted_app=TRUSTED, security=self.security)

    def calls(self):
        with open(self.state + ".log") as fh:
            return [json.loads(line)["argv"] for line in fh]

    def stdin_text(self):
        with open(self.state + ".stdin") as fh:
            return fh.read()


class KeychainStorage(KeychainCase):
    TOKEN = "hfyrt_AbCdEf0123456789-_AbCdEf0123456789"

    def test_the_token_goes_on_stdin_never_on_argv_and_is_read_back(self):
        kc = self.kc()
        kc.store(self.TOKEN)
        self.assertEqual(kc.read(), self.TOKEN)
        for argv in self.calls():
            self.assertFalse(any(self.TOKEN in a for a in argv), "the token must never appear in argv: %r" % (argv,))
        self.assertEqual(self.calls()[0], ["-i"])
        self.assertIn(self.TOKEN, self.stdin_text())

    def test_the_item_is_limited_to_the_gramps_python_with_T(self):
        self.kc().store(self.TOKEN)
        command = shlex.split(self.stdin_text().splitlines()[0])
        self.assertEqual(command[0], "add-generic-password")
        self.assertEqual(command[command.index("-T") + 1], TRUSTED)
        with open(self.state) as fh:
            item = json.load(fh)[ITEM]
        self.assertEqual(item["trusted"], TRUSTED)

    def test_a_rotated_token_replaces_the_old_one(self):
        kc = self.kc()
        kc.store(self.TOKEN)
        kc.store(self.TOKEN[:-4] + "ZZZZ")
        self.assertEqual(kc.read(), self.TOKEN[:-4] + "ZZZZ")

    def test_the_item_name_is_the_designed_one(self):
        self.assertEqual((consts.KEYCHAIN_SERVICE, consts.KEYCHAIN_ACCOUNT), ("us.harrisonfamily.hfy_sync", "https://harrisonfamily.us/auth|owner"))
        self.assertEqual(keychain.account_for("http://127.0.0.1:9/"), "http://127.0.0.1:9/auth|owner")
        keychain.Keychain(account=keychain.account_for("https://harrisonfamily.us"), trusted_app=TRUSTED)

    def test_a_sign_in_recreates_an_existing_item_so_T_always_applies(self):
        with open(self.state, "w") as fh:
            json.dump({ITEM: {"password": "hfyrt_old000000000001", "trusted": "/old/other-tool"}}, fh)
        kc = self.kc()
        kc.store(self.TOKEN, recreate=True)
        with open(self.state) as fh:
            self.assertEqual(json.load(fh)[ITEM], {"password": self.TOKEN, "trusted": TRUSTED})
        self.assertEqual(kc.read(), self.TOKEN)
        self.assertNotIn(" -U ", self.stdin_text())
        order = [c[0] for c in self.calls()]
        self.assertLess(order.index("delete-generic-password"), order.index("-i"))

    def test_rotation_keeps_the_item_and_does_not_delete_first(self):
        kc = self.kc()
        kc.store(self.TOKEN, recreate=True)
        kc.store(self.TOKEN[:-4] + "ZZZZ")
        self.assertEqual(kc.read(), self.TOKEN[:-4] + "ZZZZ")
        self.assertEqual([c[0] for c in self.calls()].count("delete-generic-password"), 1)  # the one before the first store
        self.assertIn(" -U ", self.stdin_text().splitlines()[-1])

    def test_a_missing_item_reads_as_none_and_delete_is_quiet(self):
        kc = self.kc()
        self.assertIsNone(kc.read())
        kc.delete()
        kc.store(self.TOKEN)
        kc.delete()
        self.assertIsNone(kc.read())

    def test_a_locked_keychain_is_an_error_even_though_interactive_mode_exits_0(self):
        os.environ["FAKE_SECURITY_MODE"] = "locked"
        with self.assertRaises(keychain.KeychainError) as cm:
            self.kc().store(self.TOKEN)
        self.assertTrue(cm.exception.locked)
        self.assertNotIn(self.TOKEN, str(cm.exception))

    def test_a_token_that_would_need_quoting_is_refused_before_anything_runs(self):
        for bad in ('abc"def' * 3, "has space 12345678", "line\nbreak12345678", "short", ""):
            with self.assertRaises(keychain.KeychainError, msg=repr(bad)):
                self.kc().store(bad)
        self.assertFalse(os.path.exists(self.state + ".log"), "security was never started")

    def test_the_trusted_app_must_be_an_absolute_safe_path(self):
        for bad in ("python3", "", '/x"; rm -rf /', "/x\ny"):
            with self.assertRaises(ValueError, msg=bad):
                keychain.Keychain(trusted_app=bad, security=self.security)


# ------------------------------------------------------------------------------------------------ the fake auth server


class AuthServer:
    """/auth/authorize (redirects with a code) and /auth/token (PKCE check, rotation, reuse detection), plus /api/sync/meta."""

    def __init__(self, case):
        self.case = case
        self.codes = {}  # code -> (challenge, redirect_uri)
        self.refresh = {}  # refresh token -> alive
        self.counter = 0
        self.authorize_query = None
        self.token_posts = []
        self.token_agents = []
        self.token_status = None  # force a status on /auth/token
        self.api_seen = []
        self.reject_access = set()  # access tokens the API answers 401 to
        auth = self

        class H(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *a):
                pass

            def send_json(self, status, payload):
                raw = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_GET(self):  # noqa: N802
                parts = urllib.parse.urlsplit(self.path)
                q = dict(urllib.parse.parse_qsl(parts.query))
                if parts.path == "/auth/authorize":
                    auth.authorize_query = q
                    auth.counter += 1
                    code = "code-%d" % auth.counter
                    auth.codes[code] = (q["code_challenge"], q["redirect_uri"])
                    loc = q["redirect_uri"] + "?" + urllib.parse.urlencode({"code": code, "state": q["state"], "iss": auth.base + "/auth"})
                    self.send_response(302)
                    self.send_header("Location", loc)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                elif parts.path == "/api/sync/meta":
                    seen = {k.lower(): v for k, v in self.headers.items()}
                    auth.api_seen.append(seen)
                    if seen.get("authorization", "")[len("Bearer "):] in auth.reject_access:
                        return self.send_json(401, {"error": "invalid_token", "message": "m"})
                    self.send_json(200, {"api_version": 1})
                else:
                    self.send_json(404, {"error": "not_found", "message": "m"})

            def do_POST(self):  # noqa: N802
                n = int(self.headers.get("Content-Length") or 0)
                if self.path.startswith("/api/sync/"):
                    self.rfile.read(n)
                    return self.send_json(401, {"error": "invalid_token", "message": "m"})
                form = dict(urllib.parse.parse_qsl(self.rfile.read(n).decode()))
                auth.token_posts.append(form)
                auth.token_agents.append(self.headers.get("User-Agent"))
                if auth.token_status:
                    return self.send_json(auth.token_status, {"error": "retryable", "message": "m"})
                if form.get("grant_type") == "authorization_code":
                    import base64
                    import hashlib
                    challenge, redirect = auth.codes.pop(form.get("code"), (None, None))
                    mine = base64.urlsafe_b64encode(hashlib.sha256(form.get("code_verifier", "").encode()).digest()).rstrip(b"=").decode()
                    if challenge is None or redirect != form.get("redirect_uri") or mine != challenge:
                        return self.send_json(400, {"error": "invalid_grant", "message": "m"})
                    return self.send_json(200, auth.issue())
                if form.get("grant_type") == "refresh_token":
                    if not auth.refresh.get(form.get("refresh_token")):
                        return self.send_json(400, {"error": "invalid_grant", "message": "m"})
                    auth.refresh[form["refresh_token"]] = False  # rotation: the old one is dead
                    return self.send_json(200, auth.issue())
                self.send_json(400, {"error": "unsupported_grant_type", "message": "m"})

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True).start()
        case.addCleanup(self.httpd.server_close)
        case.addCleanup(self.httpd.shutdown)
        self.base = "http://127.0.0.1:%d" % self.httpd.server_port

    def issue(self):
        self.counter += 1
        refresh = "hfyrt_fake%020d" % self.counter
        self.refresh[refresh] = True
        return {"access_token": "access-%d" % self.counter, "token_type": "Bearer", "expires_in": 3600, "refresh_token": refresh, "scope": "sync"}


def browser_follows(results):
    """open_browser stand-in: GETs the authorize URL (urllib follows the redirect to the loopback callback) in a thread."""
    def open_browser(url):
        def go():
            try:
                with urllib.request.urlopen(url, timeout=10) as r:
                    results.append(r.status)
            except Exception as exc:  # noqa: BLE001
                results.append(exc)
        t = threading.Thread(target=go, daemon=True)
        t.start()
        results.append(t)
        return True
    return open_browser


class LoginFlow(KeychainCase):
    def setUp(self):
        super().setUp()
        self.auth = AuthServer(self)

    def login(self, **kw):
        results = []
        out = oauth.login(self.auth.base, self.kc(), http=self.http(), open_browser=kw.pop("open_browser", browser_follows(results)), **kw)
        results[0].join(5)
        return out

    def test_pkce_loopback_login_stores_the_refresh_token_in_the_keychain(self):
        out = self.login()
        q = self.auth.authorize_query
        self.assertEqual((q["response_type"], q["client_id"], q["code_challenge_method"], q["resource"], q["scope"]),
                         ("code", "hfy-sync-desktop", "S256", self.auth.base + "/api/sync", "sync"))
        self.assertRegex(q["code_challenge"], r"^[A-Za-z0-9_-]{43}$")
        self.assertNotIn("prompt", q)
        self.assertEqual(out["expires_in"], 3600)
        stored = self.kc().read()
        self.assertTrue(stored.startswith("hfyrt_"))
        self.assertTrue(self.auth.refresh[stored], "the token in the Keychain is the live one the server issued")
        for argv in self.calls():
            self.assertFalse(any(stored in a for a in argv), "the refresh token must never be on argv")
        self.assertIn(stored, self.stdin_text())
        self.assertEqual(self.auth.token_posts[0]["client_id"], "hfy-sync-desktop")

    def test_the_redirect_is_an_ephemeral_port_on_127_0_0_1(self):
        self.login()
        uri = urllib.parse.urlsplit(self.auth.authorize_query["redirect_uri"])
        self.assertEqual((uri.scheme, uri.hostname, uri.path), ("http", "127.0.0.1", "/callback"))
        first = uri.port
        self.assertNotEqual(first, 53682, "the design's fixed port is gone (SI-39)")
        self.login()
        self.assertTrue(urllib.parse.urlsplit(self.auth.authorize_query["redirect_uri"]).port > 0)

    def test_step_up_asks_for_a_fresh_sign_in(self):
        self.login(step_up=True)
        self.assertEqual((self.auth.authorize_query["prompt"], self.auth.authorize_query["max_age"]), ("login", "300"))

    def test_a_callback_with_the_wrong_state_is_ignored_and_the_real_one_still_works(self):
        results = []

        def open_browser(url):
            q = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query))
            redirect = q["redirect_uri"]

            def go():
                try:
                    urllib.request.urlopen(redirect + "?code=evil&state=wrong", timeout=10)
                except Exception as exc:  # noqa: BLE001
                    results.append(exc)
                urllib.request.urlopen(url, timeout=10).read()
            t = threading.Thread(target=go, daemon=True)
            t.start()
            results.append(t)
            return True
        out = oauth.login(self.auth.base, self.kc(), http=self.http(), open_browser=open_browser)
        self.assertTrue(out["access_token"])
        self.assertEqual([p["grant_type"] for p in self.auth.token_posts], ["authorization_code"])
        self.assertNotIn("evil", json.dumps(self.auth.token_posts))

    def test_a_denied_sign_in_and_a_timeout_are_exit_77(self):
        def deny(url):
            q = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query))
            threading.Thread(target=lambda: urllib.request.urlopen(q["redirect_uri"] + "?error=access_denied&iss=" + urllib.parse.quote(self.auth.base + "/auth", safe="") + "&state=" + q["state"], timeout=10).read(),
                             daemon=True).start()
            return True
        # the state is read from the URL above, so the denial is authentic
        with self.assertRaises(oauth.LoginError) as cm:
            oauth.login(self.auth.base, self.kc(), http=self.http(), open_browser=deny)
        self.assertEqual((cm.exception.code, cm.exception.exit_code), ("login_denied", 77))
        ticks = iter(range(0, 10000, 100))
        with self.assertRaises(oauth.LoginError) as cm:
            oauth.login(self.auth.base, self.kc(), http=self.http(), open_browser=lambda url: True, timeout=300, clock=lambda: next(ticks))
        self.assertEqual((cm.exception.code, cm.exception.exit_code), ("login_timeout", 77))

    def test_a_silent_connection_cannot_stall_the_login(self):
        import socket
        socks = []
        self.addCleanup(lambda: [x.close() for x in socks])
        orig = oauth._Callback.timeout
        oauth._Callback.timeout = 0.3
        self.addCleanup(setattr, oauth._Callback, "timeout", orig)
        results = []
        follow = browser_follows(results)

        def open_browser(url):
            q = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query))
            port = urllib.parse.urlsplit(q["redirect_uri"]).port
            c = socket.create_connection(("127.0.0.1", port), timeout=5)  # connects, sends nothing (a preconnect)
            socks.append(c)
            return follow(url)
        started = time.monotonic()
        out = oauth.login(self.auth.base, self.kc(), http=self.http(), open_browser=open_browser)
        self.assertTrue(out["access_token"])
        self.assertLess(time.monotonic() - started, 4)

    def test_a_silent_connection_does_not_hide_the_deadline(self):
        import socket
        socks = []
        self.addCleanup(lambda: [x.close() for x in socks])
        orig = oauth._Callback.timeout
        oauth._Callback.timeout = 0.2
        self.addCleanup(setattr, oauth._Callback, "timeout", orig)
        wall = time.monotonic

        def open_browser(url):
            port = urllib.parse.urlsplit(dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query))["redirect_uri"]).port
            socks.append(socket.create_connection(("127.0.0.1", port), timeout=5))
            return True
        t0 = wall()
        with self.assertRaises(oauth.LoginError) as cm:
            oauth.login(self.auth.base, self.kc(), http=self.http(), open_browser=open_browser, timeout=1.0)
        self.assertEqual(cm.exception.code, "login_timeout")
        self.assertLess(wall() - t0, 4)

    def test_a_callback_without_iss_is_refused(self):
        seen = []

        def open_browser(url):
            q = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query))

            def go():
                try:
                    urllib.request.urlopen(q["redirect_uri"] + "?code=x&state=" + q["state"], timeout=10)
                except urllib.error.HTTPError as exc:
                    seen.append(exc.code)
                urllib.request.urlopen(url, timeout=10).read()
            threading.Thread(target=go, daemon=True).start()
            return True
        oauth.login(self.auth.base, self.kc(), http=self.http(), open_browser=open_browser)
        self.assertEqual(seen, [400])

    def test_a_sign_in_replaces_an_item_with_an_old_access_list(self):
        with open(self.state, "w") as fh:
            json.dump({ITEM: {"password": "hfyrt_old000000000001", "trusted": "/old/other-tool"}}, fh)
        self.login()
        with open(self.state) as fh:
            self.assertEqual(json.load(fh)[ITEM]["trusted"], TRUSTED)

    def test_the_resource_follows_the_server(self):
        self.login()
        self.assertEqual(self.auth.authorize_query["resource"], self.auth.base + "/api/sync")
        self.assertEqual(self.auth.token_posts[0]["resource"], self.auth.base + "/api/sync")
        self.assertEqual(oauth.sync_resource("https://harrisonfamily.us"), consts.SYNC_RESOURCE)

    def test_the_loopback_server_is_closed_afterwards(self):
        self.login()
        port = urllib.parse.urlsplit(self.auth.authorize_query["redirect_uri"]).port
        with self.assertRaises(OSError):
            urllib.request.urlopen("http://127.0.0.1:%d/callback" % port, timeout=2)

    def test_a_wrong_host_header_is_refused_by_the_callback(self):
        seen = []

        def open_browser(url):
            q = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query))
            port = urllib.parse.urlsplit(q["redirect_uri"]).port

            def go():
                req = urllib.request.Request(q["redirect_uri"] + "?code=x&state=" + q["state"], headers={"Host": "evil.example"})
                try:
                    urllib.request.urlopen(req, timeout=10)
                except urllib.error.HTTPError as exc:
                    seen.append(exc.code)
                urllib.request.urlopen(url, timeout=10).read()
            threading.Thread(target=go, daemon=True).start()
            return True
        oauth.login(self.auth.base, self.kc(), http=self.http(), open_browser=open_browser)
        self.assertEqual(seen, [400])


class Tokens(KeychainCase):
    def setUp(self):
        super().setUp()
        self.auth = AuthServer(self)
        self.kc().store("hfyrt_seed00000000000001")
        self.auth.refresh["hfyrt_seed00000000000001"] = True
        self.now = [1000.0]

    def manager(self, kc=None):
        return oauth.TokenManager(self.auth.base, kc or self.kc(), http=self.http(), clock=lambda: self.now[0])

    def test_the_access_token_is_cached_and_refreshed_near_expiry(self):
        m = self.manager()
        first = m()
        self.assertEqual(m(), first)
        self.assertEqual(len(self.auth.token_posts), 1)
        self.now[0] += 3600 - 30  # inside the 60 s skew
        self.assertNotEqual(m(), first)
        self.assertEqual(len(self.auth.token_posts), 2)

    def test_a_rotated_token_is_persisted_before_the_new_access_token_is_used(self):
        events = []
        real = keychain.Keychain.store

        class Spy(keychain.Keychain):
            def store(spy, token):  # noqa: N805
                events.append(("store", token))
                real(spy, token)
                events.append(("stored", token))

        m = oauth.TokenManager(self.auth.base, Spy(trusted_app=TRUSTED, security=self.security), http=self.http(), clock=lambda: self.now[0])
        access = m()
        events.append(("use", access))
        kinds = [e[0] for e in events]
        self.assertEqual(kinds, ["store", "stored", "use"])
        self.assertEqual(self.kc().read(), events[0][1])
        self.assertTrue(self.auth.refresh[self.kc().read()])

    def test_if_the_rotated_token_cannot_be_saved_the_new_access_token_is_not_used(self):
        class Broken(keychain.Keychain):
            def store(self, token):
                raise keychain.KeychainError("no")
        m = oauth.TokenManager(self.auth.base, Broken(trusted_app=TRUSTED, security=self.security), http=self.http(), clock=lambda: self.now[0])
        with self.assertRaises(transport.TransportError) as cm:
            m()
        self.assertEqual((cm.exception.exit_code, cm.exception.code), (77, "keychain_unavailable"))
        self.assertIsNone(m._token)

    def test_a_reused_refresh_token_means_sign_in_again_and_the_dead_token_is_removed(self):
        self.auth.refresh["hfyrt_seed00000000000001"] = False  # the family was revoked / the token was already used
        m = self.manager()
        with self.assertRaises(oauth.AuthRequired) as cm:
            m()
        self.assertEqual((cm.exception.exit_code, cm.exception.next_action), (77, "login"))
        self.assertIsNone(self.kc().read())
        with self.assertRaises(oauth.AuthRequired):  # and now there is nothing to try
            self.manager()()
        self.assertEqual(len(self.auth.token_posts), 1)

    def test_a_concurrent_rotation_by_another_process_is_kept_and_retried(self):
        """Process B rotates the token between our read and our send: we must not delete B's live token."""
        auth = self.auth
        winner = {}
        real_post = oauth._token_post
        calls = []

        def racing_post(http, server, fields):
            calls.append(fields["refresh_token"])
            if len(calls) == 1:  # B wins the race: it spends the seed and stores its rotated token
                body = real_post(http, server, fields)
                self.kc().store(body["refresh_token"])
                winner.update(body)
            return real_post(http, server, fields)  # for us the first send is now a reuse -> invalid_grant
        oauth._token_post = racing_post
        self.addCleanup(setattr, oauth, "_token_post", real_post)
        m = self.manager()
        token = m()
        self.assertTrue(token.startswith("access-"))
        self.assertEqual(calls[0], "hfyrt_seed00000000000001")
        self.assertEqual(calls[1], winner["refresh_token"], "the retry carries the token B stored")
        self.assertEqual(len(calls), 2)  # our send, then the retry with B's token
        self.assertTrue(auth.refresh[self.kc().read()], "the Keychain holds a live token, not nothing")

    def test_a_dead_token_that_is_still_the_stored_one_is_deleted(self):
        self.auth.refresh["hfyrt_seed00000000000001"] = False
        with self.assertRaises(oauth.AuthRequired):
            self.manager()()
        self.assertIsNone(self.kc().read())

    def test_a_401_refreshes_once_and_replays_a_get(self):
        m = self.manager()
        client = transport.Client(self.auth.base, VERSIONS, m, http=self.http())
        self.auth.reject_access = {"access-1"}  # the first access token is rejected despite its local expiry
        self.assertEqual(client.meta(), {"api_version": 1})
        self.assertEqual([h["authorization"] for h in self.auth.api_seen], ["Bearer access-1", "Bearer access-2"])
        self.assertEqual(len(self.auth.token_posts), 2)

    def test_a_second_401_is_not_replayed_again_and_a_keyless_post_is_never_replayed(self):
        m = self.manager()
        client = transport.Client(self.auth.base, VERSIONS, m, http=self.http())
        self.auth.reject_access = {"access-1", "access-2"}
        with self.assertRaises(transport.TransportError) as cm:
            client.meta()
        self.assertEqual((cm.exception.status, cm.exception.exit_code), (401, 77))
        self.assertEqual(len(self.auth.api_seen), 2)
        before = len(self.auth.token_posts)
        with self.assertRaises(transport.TransportError):
            client.post("/api/sync/anything", {"a": 1})
        self.assertEqual(len(self.auth.token_posts), before)

    def test_a_server_url_with_a_path_is_not_a_bare_origin(self):
        with self.assertRaises(ValueError):
            transport.check_server("https://harrisonfamily.us/api")
        self.assertEqual(transport.check_server("https://harrisonfamily.us/"), "https://harrisonfamily.us")

    def test_no_stored_token_is_sign_in_needed(self):
        self.kc().delete()
        with self.assertRaises(oauth.AuthRequired) as cm:
            self.manager()()
        self.assertEqual(cm.exception.exit_code, 77)
        self.assertEqual(self.auth.token_posts, [])

    def test_a_refresh_is_never_retried(self):
        self.auth.token_status = 503
        m = self.manager()
        with self.assertRaises(transport.TransportError) as cm:
            m()
        self.assertEqual(cm.exception.exit_code, 75)
        self.assertEqual(len(self.auth.token_posts), 1)
        self.assertEqual(self.sleeps, [])
        self.assertEqual(self.kc().read(), "hfyrt_seed00000000000001", "the saved token survives a failed refresh")

    def test_a_locked_keychain_stops_the_refresh_with_exit_77(self):
        os.environ["FAKE_SECURITY_MODE"] = "locked"
        with self.assertRaises(transport.TransportError) as cm:
            self.manager()()
        self.assertEqual((cm.exception.code, cm.exception.exit_code), ("keychain_unavailable", 77))
        self.assertEqual(self.auth.token_posts, [])

    def test_a_client_built_on_the_manager_sends_the_fresh_token_and_the_headers(self):
        client = transport.Client(self.auth.base, VERSIONS, self.manager(), http=self.http())
        self.assertEqual(client.meta(), {"api_version": 1})
        seen = self.auth.api_seen[0]
        self.assertTrue(seen["authorization"].startswith("Bearer access-"))
        self.assertEqual(seen["x-hfy-sync-client"], "hfy_sync/%s" % consts.ADDON_VERSION)


# ------------------------------------------------------------------------------------------------------ the runner


class RunnerLogin(R.HomeCase, KeychainCase):
    def setUp(self):
        R.HomeCase.setUp(self)
        KeychainCase.setUp(self)
        self.auth = AuthServer(self)
        results = []
        self.services = {"keychain": self.kc(), "http": self.http(), "server": self.auth.base, "open_browser": browser_follows(results)}

    def test_login_works_on_an_unbound_tree_and_writes_an_ok_status(self):
        tree = R.FakeTree()
        doc = runner.run(tree, "cli", runner.Options("login"), argv=["gramps"], environ=self.env, services=self.services)
        self.assertEqual((doc["result"], doc["exit_code"], doc["error"]), ("ok", 0, None), doc)
        self.assertTrue(self.kc().read().startswith("hfyrt_"))
        self.assertNotIn(self.kc().read(), json.dumps(doc))
        with open(self.tp(tree).status) as fh:
            self.assertEqual(json.load(fh)["exit_code"], 0)

    def test_login_dry_run_opens_nothing(self):
        self.services["open_browser"] = lambda url: self.fail("no browser on a dry run")
        doc = runner.run(R.FakeTree(), "cli", runner.Options("login", dry_run=True), argv=["gramps"], environ=self.env, services=self.services)
        self.assertEqual(doc["exit_code"], 0)
        self.assertIsNone(self.kc().read())

    def test_a_locked_keychain_is_d42_exit_77(self):
        os.environ["FAKE_SECURITY_MODE"] = "locked"
        doc = runner.run(R.FakeTree(), "cli", runner.Options("login"), argv=["gramps"], environ=self.env, services=self.services)
        self.assertEqual((doc["result"], doc["exit_code"], doc["error"]["code"], doc["next_action"]), ("refused", 77, "D42", "login"))

    def test_a_timeout_is_exit_77_with_next_action_login(self):
        self.services["open_browser"] = lambda url: True
        self.services["timeout"] = 0.3
        doc = runner.run(R.FakeTree(), "cli", runner.Options("login"), argv=["gramps"], environ=self.env, services=self.services)
        self.assertEqual((doc["exit_code"], doc["error"]["code"], doc["next_action"]), (77, "login_timeout", "login"))

    def test_an_unusable_server_in_config_is_a_config_refusal(self):
        self.services.pop("server")
        tree = self.bound_tree()
        cfg = R.paths.read_json(self.tp(tree).config)
        cfg["server"] = "http://example.org"
        R.paths.atomic_write_json(self.tp(tree).config, cfg)
        doc = runner.run(tree, "cli", runner.Options("login"), argv=["gramps"], environ=self.env, services=self.services)
        self.assertEqual(doc["exit_code"], 78)

    def test_no_secret_reaches_status_or_the_log(self):
        tree = R.FakeTree()
        runner.run(tree, "cli", runner.Options("login"), run_id="r1", argv=["gramps"], environ=self.env, services=self.services)
        token = self.kc().read()
        for root, _dirs, files in os.walk(self.env["HOME"]):
            for f in files:
                if f in ("state.sqlite",):
                    continue
                with open(os.path.join(root, f), "rb") as fh:
                    data = fh.read()
                self.assertNotIn(token.encode(), data, f)
                self.assertNotIn(b"code_verifier", data, f)


class WrapperStepUp(unittest.TestCase):
    def test_the_wrapper_passes_step_up_to_the_tool(self):
        from importlib.machinery import SourceFileLoader
        wrapper = SourceFileLoader("hfy_sync_wrapper", os.path.join(GRAMPS, "bin", "hfy-sync")).load_module()
        parsed = wrapper.parse(["login", "--step-up", "--tree", "T"])
        self.assertEqual((parsed[0], parsed[1], parsed[7]), ("login", "T", True))
        self.assertFalse(wrapper.parse(["login"])[7])


class Constants(unittest.TestCase):
    def test_the_design_numbers(self):
        self.assertEqual(consts.RETRY_DELAYS_S, (1, 4, 16))
        self.assertEqual((consts.LOGIN_TIMEOUT_S, consts.STEP_UP_MAX_AGE_S), (300, 300))
        self.assertEqual(consts.SYSTEM_CA_FILE, "/etc/ssl/cert.pem")
        self.assertEqual((consts.OAUTH_CLIENT_ID, consts.SYNC_RESOURCE), ("hfy-sync-desktop", "https://harrisonfamily.us/api/sync"))

    def test_the_client_constants_match_the_auth_service(self):
        """The server side is defined in auth/src/oauth.js; keep the two in step without a network."""
        path = os.path.abspath(os.path.join(GRAMPS, "..", "auth", "src", "oauth.js"))
        if not os.path.exists(path):
            self.skipTest("auth/ is not in this checkout")
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
        self.assertIn('DESKTOP_CLIENT_ID = "%s"' % consts.OAUTH_CLIENT_ID, text)
        self.assertIn('DESKTOP_SYNC_RESOURCE = "%s"' % consts.SYNC_RESOURCE, text)
        self.assertRegex(text, r"loopback: true")


if __name__ == "__main__":
    unittest.main()
