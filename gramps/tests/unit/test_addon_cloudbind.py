"""The `cloud-bind` action (HFY-TSK-369): `hfy-sync cloud-bind` binds the website's store to the locally bound tree (POST /api/sync/bind).

The network is faked under the real transport: `FakeHttp` replaces only `Http._once`, so the real `Http.send`, its error mapping
(`transport.map_error`), the real `Client` (handshake headers, bearer token) and the real `TokenManager` (refresh from a fake Keychain) all
run. Every outcome of the action is covered, and so is the rule that nothing the action prints, logs or stores carries the tree's ids,
its name, the digest, a tree id from the website or a token. Every value is fictional.
"""
import contextlib
import hashlib
import io
import json
import logging
import os
import sys
import unittest
import urllib.parse

import addon_pull_support as S
from hfygramps.addon import consts, sidecar, status, transport

ACCESS = "access-canary-7f3a91c2d4e8b605"
REFRESH = "refresh-canary-0b6d4e1a9c3f7285"
ROTATED = "rotated-canary-5e2c8a7d1f4b9036"
CLOUD_TREE = "c10ud000-1111-4222-8333-444444444444"
FINGERPRINT = hashlib.sha256(b"fingerprint canary").hexdigest()
OTHER_FINGERPRINT = hashlib.sha256(b"another tree").hexdigest()
BIND = ("POST", "/api/sync/bind")
META = ("GET", "/api/sync/meta")
TOKEN = ("POST", "/auth/token")


def ok(status_code=200, body=None):
    return ("ok", status_code, body)


def http_error(status_code, code, details=None):
    body = {"error": code, "message": "a body the addon must never print"}
    if details:
        body["details"] = details
    return ("http", status_code, body)


NETWORK = ("net",)


class FakeHttp(transport.Http):
    """The real Http with only the wire replaced. `routes` maps (method, path) to a reply or a list of replies (used in order)."""

    def __init__(self, routes):
        self.delays, self.sleep, self.timeout, self.attempts, self.ssl_context = (), lambda _s: None, 1, 0, None
        self.routes = {k: (list(v) if isinstance(v, list) else [v]) for k, v in routes.items()}
        self.sent = []   # {"method", "path", "headers", "body"}

    def _once(self, method, url, headers, data, raw=False):
        path = urllib.parse.urlsplit(url).path
        body = None
        if data is not None:
            body = json.loads(data.decode("utf-8")) if "json" in headers.get("Content-Type", "") else urllib.parse.parse_qs(data.decode("ascii"))
        self.sent.append({"method": method, "path": path, "headers": dict(headers), "body": body})
        replies = self.routes.get((method, path))
        if not replies:
            raise AssertionError("an unexpected call: %s %s" % (method, path))
        reply = replies.pop(0) if len(replies) > 1 else replies[0]
        if reply[0] == "ok":
            return transport.Response(reply[1], {}, reply[2])
        if reply[0] == "http":
            return self._http_error(reply[1], reply[2], {})
        if reply[0] == "raise":
            raise reply[1]
        raise transport._Retryable(transport.TransportError("network", consts.EXIT_TEMPORARY, "retry", message="The network call failed."))

    def calls(self):
        return [(c["method"], c["path"]) for c in self.sent]

    def of(self, route):
        return [c for c in self.sent if (c["method"], c["path"]) == route]


class FakeKeychain:
    def __init__(self, token=REFRESH):
        self.token, self.stored, self.deleted = token, [], 0

    def read(self):
        return self.token

    def store(self, value):
        self.token = value
        self.stored.append(value)

    def delete(self):
        self.token = None
        self.deleted += 1


def routes(bind=None, meta=None, token=None):
    out = {TOKEN: token or ok(200, {"access_token": ACCESS, "refresh_token": ROTATED, "expires_in": 600})}
    if bind is not None:
        out[BIND] = bind
    if meta is not None:
        out[META] = meta
    return out


class CloudBindCase(unittest.TestCase):
    def setUp(self):
        self.env = S.Env(self, seed=False)
        self.keychain = FakeKeychain()
        con = self.env.side()  # a distinctive fingerprint, so a leak of it is visible (the fixture's is all zeros)
        sidecar.set_meta(con, "fingerprint", FINGERPRINT)
        con.commit()
        con.close()
        self.name_hash = hashlib.sha256(self.env.tree.name.encode("utf-8")).hexdigest()
        self.captured = []
        self.records = []

    def sidecar_state(self):
        con = self.env.side()
        try:
            return (sidecar.meta(con), [con.execute("SELECT * FROM %s ORDER BY 1, 2" % t).fetchall() for t in ("base", "outbox", "conflicts", "holds")])
        finally:
            con.close()

    def go(self, reply_routes, **opt):
        """Runs `cloud-bind --yes` (or what `opt` says) against a fake website; returns (status doc, FakeHttp)."""
        http = FakeHttp(reply_routes)
        out, err = io.StringIO(), io.StringIO()
        handler = logging.Handler()
        handler.emit = lambda record: self.records.append(record.getMessage())
        root = logging.getLogger()
        old_level = root.level
        root.addHandler(handler)
        root.setLevel(logging.DEBUG)
        try:
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                doc = self.env.run("cloud-bind", services={"http": http, "keychain": self.keychain}, **dict({"yes": True}, **opt))
                print(status.summary_line(doc))
        finally:
            root.removeHandler(handler)
            root.setLevel(old_level)
        self.captured.append(out.getvalue() + err.getvalue())
        return doc, http

    # ---- everything a run leaves where a person or an agent could read it
    def leftovers(self):
        text = list(self.captured) + list(self.records)
        with open(self.env.tp.status, encoding="utf-8") as fh:
            doc = json.load(fh)
        doc.pop("tree", None)   # status.json names the tree's folder (`tree.dbid`) for every action, by its contract; nothing else may
        text.append(json.dumps(doc, sort_keys=True))
        for name in os.listdir(self.env.tp.logs):
            with open(os.path.join(self.env.tp.logs, name), encoding="utf-8") as fh:
                text.append(fh.read())
        con = self.env.side()
        try:
            text.append(json.dumps(con.execute("SELECT run_id, action, mode, result, exit_code, counts_json, error_json FROM runs").fetchall()))
        finally:
            con.close()
        return "\n".join(text)

    def assert_nothing_leaks(self):
        blob = self.leftovers().lower()
        secrets = {"dbid": self.env.tree.dbid, "fingerprint": FINGERPRINT, "tree name": self.env.tree.name, "name digest": self.name_hash,
                   "access token": ACCESS, "refresh token": REFRESH, "rotated token": ROTATED, "cloud tree id": CLOUD_TREE,
                   "other fingerprint": OTHER_FINGERPRINT, "the body of an error": "a body the addon must never print"}
        for what, value in secrets.items():
            if value.lower() in blob:   # not assertNotIn: its failure message would print the whole blob
                self.fail("%s reached a status file, a log, a record or the console" % what)
        if "bearer" in blob:
            self.fail("an Authorization header reached a status file, a log, a record or the console")


class Dry(CloudBindCase):
    def test_it_looks_by_default_prints_field_names_and_byte_lengths_and_uses_no_network(self):
        before = self.sidecar_state()
        doc, http = self.go(routes(), yes=False)
        self.assertEqual((doc["result"], doc["exit_code"], doc["next_action"], doc["error"]), ("changes_pending", 10, "none", None))
        self.assertEqual(http.sent, [])
        self.assertEqual(self.keychain.token, REFRESH)
        self.assertEqual(doc["counts"]["cloud_bind"], {
            "fields": {"dbid": len(self.env.tree.dbid), "fingerprint": 64, "tree_name_sha256": 64}, "sent": False, "outcome": "dry_run"})
        line = status.summary_line(doc)
        self.assertIn("would send: dbid (%d bytes), fingerprint (64 bytes), tree_name_sha256 (64 bytes)" % len(self.env.tree.dbid), line)
        self.assertIn("(exit 10)", line)
        self.assertEqual(self.sidecar_state(), before)
        self.assert_nothing_leaks()

    def test_dry_run_with_yes_is_still_a_look(self):
        doc, http = self.go(routes(), yes=True, dry_run=True)
        self.assertEqual((doc["exit_code"], http.sent), (10, []))


class Sent(CloudBindCase):
    def test_the_first_bind_sends_the_three_values_the_server_and_the_e2e_helper_expect(self):
        before = self.sidecar_state()
        doc, http = self.go(routes(bind=ok(200, {"tree_id": CLOUD_TREE})))
        self.assertEqual((doc["result"], doc["exit_code"], doc["next_action"], doc["error"]), ("ok", 0, "none", None))
        (bind,) = http.of(BIND)
        # exactly the body of api/src/sync/routes.js bindBody, with the e2e helper's digest (tests/e2e/e2e_case.py tree_name_sha256)
        self.assertEqual(bind["body"], {"dbid": self.env.tree.dbid, "fingerprint": FINGERPRINT,
                                        "tree_name_sha256": hashlib.sha256("Fixture Tree".encode("utf-8")).hexdigest()})
        self.assertNotIn("rebind", bind["body"])
        self.assertEqual(bind["headers"]["Authorization"], "Bearer " + ACCESS)
        self.assertEqual(bind["headers"]["X-HFY-Sync-Client"], "hfy_sync/%s" % consts.ADDON_VERSION)
        self.assertNotIn("X-HFY-Tree-Id", bind["headers"])   # the call that precedes the bind names no tree
        self.assertNotIn("Idempotency-Key", bind["headers"])
        self.assertEqual(http.calls(), [TOKEN, BIND])        # one refresh, one bind: no handshake first
        self.assertEqual(self.keychain.stored, [ROTATED])    # the stored sign-in rotated the way every other action's does
        self.assertEqual(doc["counts"]["cloud_bind"]["outcome"], "bound")
        self.assertIs(doc["counts"]["cloud_bind"]["sent"], True)
        self.assertIn("sent: dbid", status.summary_line(doc))
        self.assertEqual(self.sidecar_state(), before)       # it changes neither the tree's sync state nor the tree
        self.assertEqual(self.env.tree.applies, 0)
        self.assert_nothing_leaks()

    def test_a_201_is_a_bind_too(self):
        doc, _ = self.go(routes(bind=ok(201, {"tree_id": CLOUD_TREE})))
        self.assertEqual((doc["result"], doc["exit_code"]), ("ok", 0))

    def test_check_works_after_the_bind_and_says_what_was_missing_before(self):
        self.env.cloud.bound = False
        doc = self.env.run("check")
        self.assertEqual((doc["result"], doc["exit_code"], doc["error"]["code"], doc["next_action"]), ("refused", 78, "cloud_unbound", "cloud_bind"))
        self.assertIn("hfy-sync cloud-bind", doc["error"]["message"])
        self.assertIn("next: cloud_bind", status.summary_line(doc))
        self.env.cloud.bound = True
        self.env.seed_cloud()
        doc = self.env.run("check")
        self.assertNotEqual(doc["exit_code"], 78)


class AlreadyBound(CloudBindCase):
    def test_a_repeat_for_the_same_tree_is_exit_0(self):
        doc, http = self.go(routes(bind=http_error(409, "already_bound"),
                                   meta=ok(200, {"api_version": 1, "tree_id": CLOUD_TREE, "bound": {"dbid": self.env.tree.dbid, "fingerprint": FINGERPRINT}})))
        self.assertEqual((doc["result"], doc["exit_code"], doc["next_action"], doc["error"]), ("ok", 0, "none", None))
        self.assertEqual(http.calls(), [TOKEN, BIND, META])
        self.assertEqual(doc["counts"]["cloud_bind"]["outcome"], "already_bound")
        self.assertIn("already_bound", self.leftovers())    # the code word is in the run log and in status.json
        self.assert_nothing_leaks()

    def test_a_different_tree_is_78_bound_other_tree_and_changes_nothing(self):
        for bound in ({"dbid": "anotherdb", "fingerprint": FINGERPRINT}, {"dbid": self.env.tree.dbid, "fingerprint": OTHER_FINGERPRINT}):
            doc, _ = self.go(routes(bind=http_error(409, "already_bound"), meta=ok(200, {"tree_id": CLOUD_TREE, "bound": bound})))
            self.assertEqual((doc["result"], doc["exit_code"], doc["error"]["code"], doc["next_action"]), ("refused", 78, "bound_other_tree", "open_bound_tree"))
            self.assertIn("rebind", doc["error"]["message"])
        self.assert_nothing_leaks()

    def test_an_unreadable_handshake_after_the_409_is_never_taken_for_the_same_tree(self):
        doc, _ = self.go(routes(bind=http_error(409, "already_bound"), meta=ok(200, {"tree_id": CLOUD_TREE})))   # no `bound` member
        self.assertEqual((doc["exit_code"], doc["error"]["code"]), (78, "bound_other_tree"))
        doc, _ = self.go(routes(bind=http_error(409, "already_bound"), meta=NETWORK))
        self.assertEqual((doc["result"], doc["exit_code"], doc["error"]["code"], doc["next_action"]), ("failed", 75, "network", "retry"))
        self.assert_nothing_leaks()

    def test_another_409_is_not_an_already_bound(self):
        doc, http = self.go(routes(bind=http_error(409, "version_conflict")))
        self.assertEqual((doc["result"], doc["exit_code"], doc["error"]["code"]), ("failed", 75, "version_conflict"))
        self.assertEqual(http.of(META), [])


class Refused(CloudBindCase):
    def test_every_failure_has_a_code_word_an_exit_code_and_a_fix_hint(self):
        cases = [
            # (name, routes, result, exit code, code word, next_action, text the hint must contain)
            ("not the owner", routes(bind=http_error(403, "not_owner")), "refused", 78, "not_owner", "login", "owner"),
            ("step-up needed", routes(bind=http_error(403, "step_up_required")), "refused", 77, "step_up_required", "step_up", "login --step-up"),
            ("sync switched off", routes(bind=http_error(404, "not_enabled")), "refused", 69, "not_enabled", "none", "switched off or paused"),
            ("sync paused", routes(bind=http_error(503, "sync_paused")), "refused", 69, "sync_paused", "none", "switched off or paused"),
            ("401 from the API", routes(bind=http_error(401, "unauthenticated")), "refused", 77, "unauthenticated", "login", "hfy-sync login"),
            ("the sign-in was revoked", routes(token=http_error(400, "invalid_grant")), "refused", 77, "invalid_grant", "login", "login"),
            ("a network failure", routes(bind=NETWORK), "failed", 75, "network", "retry", "network"),
            ("the website is busy", routes(bind=http_error(503, "retryable")), "failed", 75, "retryable", "retry", "busy"),
            ("a server error", routes(bind=http_error(500, "internal")), "failed", 75, "internal", "retry", "again"),
            ("the website refused the values", routes(bind=http_error(400, "validation", {"fields": [{"field": "dbid", "code": "invalid"}]})), "refused", 65, "validation", "none", "refused"),
            ("an addon that is too old", routes(bind=http_error(426, "upgrade_required")), "refused", 78, "upgrade_required", "update_addon", "Update the addon"),
            ("a certificate that does not verify", routes(bind=("raise", transport.TransportError("tls_verify_failed", consts.EXIT_CONFIG, message="The server's certificate could not be verified; nothing was sent."))), "refused", 78, "tls_verify_failed", "none", "certificate"),
        ]
        for name, reply_routes, result, exit_code, code, next_action, hint in cases:
            with self.subTest(name):
                http = FakeHttp(reply_routes)
                self.keychain = FakeKeychain()   # a dead sign-in is deleted from it, as the real one is
                doc = self.env.run("cloud-bind", services={"http": http, "keychain": self.keychain}, yes=True)
                self.assertEqual((doc["result"], doc["exit_code"], doc["error"]["code"], doc["next_action"]), (result, exit_code, code, next_action))
                self.assertIn(hint.lower(), doc["error"]["message"].lower())
                self.assertNotIn("\n", doc["error"]["message"])
                self.assertIn(exit_code, (65, 69, 75, 77, 78))
                self.captured.append(status.summary_line(doc))
        self.assert_nothing_leaks()

    def test_no_sign_in_at_all_is_77_not_signed_in_and_sends_nothing(self):
        self.keychain.token = None
        doc, http = self.go(routes(bind=ok(200, {"tree_id": CLOUD_TREE})))
        self.assertEqual((doc["result"], doc["exit_code"], doc["error"]["code"], doc["next_action"]), ("refused", 77, "not_signed_in", "login"))
        self.assertEqual(http.sent, [])
        self.assert_nothing_leaks()

    def test_a_locked_keychain_is_77_and_sends_nothing(self):
        class Locked(FakeKeychain):
            def read(self):
                from hfygramps.addon import keychain
                raise keychain.KeychainError("locked", locked=True)
        self.keychain = Locked()
        doc, http = self.go(routes(bind=ok(200, {"tree_id": CLOUD_TREE})))
        self.assertEqual((doc["result"], doc["exit_code"], doc["error"]["code"], doc["next_action"]), ("refused", 77, "keychain_unavailable", "login"))
        self.assertEqual(http.of(BIND), [])

    def test_an_answer_that_is_not_a_tree_id_is_70_and_names_the_check(self):
        for body in (None, {}, {"tree_id": ""}, ["x"]):
            doc, _ = self.go(routes(bind=ok(200, body)))
            self.assertEqual((doc["result"], doc["exit_code"], doc["error"]["code"]), ("failed", 70, "bad_bind_answer"))
            self.assertIn("hfy-sync check", doc["error"]["message"])
        self.assert_nothing_leaks()

    def test_a_tree_that_is_not_bound_here_is_refused_before_any_call(self):
        os.unlink(self.env.tp.config)
        doc, http = self.go(routes(bind=ok(200, {"tree_id": CLOUD_TREE})))
        self.assertEqual((doc["result"], doc["exit_code"], doc["error"]["code"], doc["next_action"]), ("refused", 78, "unbound", "bind"))
        self.assertEqual(http.sent, [])

    def test_a_server_that_is_not_https_is_refused_before_any_call(self):
        cfg = dict(self.env.config, server="http://example.org")
        with open(self.env.tp.config, "w", encoding="utf-8") as fh:
            json.dump(cfg, fh)
        doc, http = self.go(routes(bind=ok(200, {"tree_id": CLOUD_TREE})))
        self.assertEqual((doc["result"], doc["exit_code"], doc["error"]["code"]), ("refused", 78, "config_unreadable"))
        self.assertEqual(http.sent, [])

    def test_a_local_binding_the_server_would_refuse_is_not_sent(self):
        con = self.env.side()
        sidecar.set_meta(con, "fingerprint", "short")   # the server wants 8 to 256 characters
        con.commit()
        con.close()
        doc, http = self.go(routes(bind=ok(200, {"tree_id": CLOUD_TREE})))
        self.assertEqual((doc["result"], doc["exit_code"], doc["error"]["code"], doc["next_action"]), ("refused", 78, "D13", "rebase"))
        self.assertEqual(http.sent, [])

    def test_a_sidecar_for_another_tree_is_d03(self):
        con = self.env.side()
        sidecar.set_meta(con, "dbid", "anotherdb")
        con.commit()
        con.close()
        doc, http = self.go(routes(bind=ok(200, {"tree_id": CLOUD_TREE})))
        self.assertEqual(http.sent, [])
        self.assertEqual(doc["exit_code"], 78)


class Wiring(CloudBindCase):
    def test_the_action_is_listed_and_the_next_action_is_known(self):
        self.assertIn("cloud-bind", consts.ACTIONS)
        self.assertIn("cloud-bind", consts.IMPLEMENTED_ACTIONS)
        self.assertIn("cloud_bind", consts.NEXT_ACTIONS)
        self.assertNotIn("cloud-bind", consts.PULL_ACTIONS)

    def test_the_local_bind_is_unchanged_and_sends_nothing(self):
        http = FakeHttp({})
        doc = self.env.run("bind", services={"http": http, "keychain": self.keychain}, yes=True)
        self.assertEqual((doc["result"], doc["exit_code"]), ("ok", 0))   # already bound: nothing to do, and still no call
        self.assertEqual(http.sent, [])

    def test_the_gramplet_s_last_sync_ignores_it(self):
        self.go(routes(bind=ok(200, {"tree_id": CLOUD_TREE})))
        con = self.env.side()
        try:
            self.assertEqual(con.execute("SELECT COUNT(*) FROM runs WHERE action IN ('pull', 'push', 'sync')").fetchone()[0], 0)
            self.assertEqual(con.execute("SELECT COUNT(*) FROM runs WHERE action = 'cloud-bind'").fetchone()[0], 1)
        finally:
            con.close()


if __name__ == "__main__":
    unittest.main()
