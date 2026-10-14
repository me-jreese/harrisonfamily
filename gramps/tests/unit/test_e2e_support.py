"""The end-to-end lane's own plumbing (HFY-TSK-181). Standard library only; no Gramps.

A stub process stands in for the sync dev server, so CI proves the harness: the ready line, the failure modes of starting and stopping, the
request-log readers the privacy greps use, the in-memory Keychain, and the shape of gramps/tests/e2e/run.sh. The one test that starts the
real server (node 22 and api/node_modules, which CI lacks) is skipped there; on a worker it runs the addon's own PKCE login against it,
with no Gramps. The scenarios themselves need the Gramps 6.0.6 bundle and run through gramps/tests/e2e/run.sh.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
GRAMPS = os.path.abspath(os.path.join(HERE, "..", ".."))
E2E = os.path.join(GRAMPS, "tests", "e2e")
sys.path.insert(0, E2E)

import e2e_support as E  # noqa: E402

STUB = r'''
import json, sys, time
log = %(log)r
open(log, "w").close()
if %(mode)r == "die":
    sys.stderr.write("boom: cannot start\n"); sys.exit(3)
if %(mode)r == "slow":
    time.sleep(60)
print("not json, ignored", flush=True)
print(json.dumps({"event": "ready", "origin": "http://127.0.0.1:1", "port": 1, "data_dir": %(dir)r, "log_file": log, "owner_sub": "I9001"}), flush=True)
time.sleep(60)
'''

LOG_LINES = [
    {"seq": 1, "method": "GET", "path": "/api/sync/meta", "status": 200, "auth": "bearer"},
    {"seq": 2, "method": "POST", "path": "/api/sync/bind", "status": 200, "auth": "bearer", "body": {"dbid": "db-synthetic-1"}},
    {"seq": 3, "method": "POST", "path": "/api/sync/bind", "status": 409, "auth": "bearer", "error": "already_bound", "body": {"dbid": "db-synthetic-1"}},
    {"seq": 4, "method": "PUT", "path": "/_s3/bkt.test/media/x", "status": 200, "auth": "none", "body_binary": True},
]


class Stubbed(unittest.TestCase):
    def server(self, mode="ok", **kw):
        tmp = tempfile.mkdtemp(prefix="hfy-e2e-unit-")
        self.addCleanup(shutil.rmtree, tmp, True)
        log = os.path.join(tmp, "requests.jsonl")
        cmd = [sys.executable, "-c", STUB % {"log": log, "mode": mode, "dir": tmp}]
        s = E.DevServer(command=cmd, **kw)
        return s, log

    def test_start_reads_the_ready_line_skips_noise_and_stop_removes_the_work_dir(self):
        s, _ = self.server()
        with s:
            self.assertEqual((s.origin, s.ready["port"]), ("http://127.0.0.1:1", 1))
            work = s.work_dir
            self.assertTrue(os.path.isdir(work))
            self.assertEqual(os.stat(work).st_mode & 0o777, 0o700)
            proc = s.proc
        self.assertIsNone(s.proc)
        self.assertIsNotNone(proc.poll())  # terminated
        self.assertFalse(os.path.exists(work))

    def test_a_server_that_dies_before_it_is_ready_is_a_clear_error_with_its_stderr(self):
        s, _ = self.server("die")
        with self.assertRaises(E.DevServerError) as ctx:
            s.start()
        self.assertIn("boom: cannot start", str(ctx.exception))
        self.assertIsNone(s.proc)
        self.assertFalse(os.path.exists(s.work_dir))

    def test_a_server_that_never_says_ready_times_out_and_is_stopped(self):
        s, _ = self.server("slow", start_timeout=1)
        t0 = time.monotonic()
        with self.assertRaises(E.DevServerError) as ctx:
            s.start()
        self.assertIn("not ready within 1 s", str(ctx.exception))
        self.assertLess(time.monotonic() - t0, 30)
        self.assertIsNone(s.proc)

    def test_a_command_that_cannot_run_is_a_dev_server_error(self):
        s = E.DevServer(command=["/nonexistent/hfy-no-such-binary"])
        with self.assertRaises(E.DevServerError):
            s.start()
        self.assertFalse(os.path.exists(s.work_dir))

    def test_starting_twice_is_refused(self):
        s, _ = self.server()
        with s:
            with self.assertRaises(E.DevServerError):
                s.start()

    def test_the_log_readers(self):
        s, log = self.server()
        with s:
            with open(log, "w", encoding="utf-8") as fh:
                for e in LOG_LINES:
                    fh.write(json.dumps(e, separators=(",", ":")) + "\n")
            self.assertEqual([e["seq"] for e in s.entries()], [1, 2, 3, 4])
            self.assertEqual([e["seq"] for e in s.requests(method="POST", path="/api/sync/bind")], [2, 3])
            self.assertEqual([e["seq"] for e in s.requests(path="/api/sync/*")], [1, 2, 3])
            self.assertEqual([e["seq"] for e in s.requests(path="/api/sync/bind", status=409)], [3])
            self.assertEqual([e["seq"] for e in s.requests(method="PUT")], [4])
            # grep is a plain substring search over the lines as written: the body is embedded JSON, so no escaping gets in the way
            self.assertEqual([n for n, _ in s.grep('"dbid":"db-synthetic-1"')], [2, 3])
            self.assertEqual(s.grep("a name that was never sent"), [])

    def test_the_memory_keychain_has_the_keychain_interface(self):
        from hfygramps.addon import keychain

        kc = E.MemoryKeychain()
        self.assertIsNone(kc.read())
        kc.store("hfyrt_abcdefgh", recreate=True)
        self.assertEqual((kc.read(), kc.stores), ("hfyrt_abcdefgh", 1))
        kc.delete()
        self.assertIsNone(kc.read())
        for name in ("store", "read", "delete"):
            self.assertTrue(callable(getattr(kc, name)) and callable(getattr(keychain.Keychain, name)))

    def test_proxies_are_bypassed_for_loopback(self):
        self.assertIn("127.0.0.1", os.environ["no_proxy"])
        self.assertIn("127.0.0.1", os.environ["NO_PROXY"])


class SnapshotCheck(unittest.TestCase):
    def snapshot(self, count=0, tamper=False):
        import gzip
        import hashlib

        body = b"".join(json.dumps({"class": "Note", "handle": "%028x" % i, "obj": {"n": i}}, sort_keys=True).encode() + b"\n" for i in range(count))
        sha = hashlib.sha256(body).hexdigest()
        header = json.dumps({"type": "header", "tree_id": "t", "seq": 3, "schema": 21, "redaction": 1, "count": count, "body_sha256": sha}).encode() + b"\n"
        if tamper:
            body = body + b'{"extra":1}\n'
        return gzip.compress(header + body), {"seq": 3, "count": count, "body_sha256": sha}

    def read(self, raw, expect):
        saved = E.fetch_bytes
        E.fetch_bytes = lambda url: raw
        try:
            return E.read_snapshot("http://127.0.0.1:1/x", expect)
        finally:
            E.fetch_bytes = saved

    def test_a_good_snapshot_verifies_and_an_empty_one_has_no_lines(self):
        raw, expect = self.snapshot(0)
        self.assertEqual(self.read(raw, expect)[1], [])
        raw, expect = self.snapshot(2)
        header, lines = self.read(raw, expect)
        self.assertEqual((header["count"], len(lines)), (2, 2))

    def test_a_tampered_or_miscounted_snapshot_is_refused(self):
        raw, expect = self.snapshot(2, tamper=True)
        with self.assertRaises(ValueError):
            self.read(raw, expect)
        raw, expect = self.snapshot(2)
        with self.assertRaises(ValueError):
            self.read(raw, dict(expect, count=3))
        with self.assertRaises(ValueError):
            self.read(raw, dict(expect, seq=4))


class LaneShape(unittest.TestCase):
    def test_run_sh_is_executable_syntactically_valid_and_lists_the_scenarios(self):
        run = os.path.join(E2E, "run.sh")
        self.assertTrue(os.access(run, os.X_OK))
        subprocess.run(["bash", "-n", run], check=True)
        out = subprocess.run(["bash", run, "--list"], stdout=subprocess.PIPE, universal_newlines=True, check=True).stdout.split()
        self.assertEqual(out, sorted(f for f in os.listdir(E2E) if f.startswith("scenario_") and f.endswith(".py")))
        self.assertIn("scenario_smoke.py", out)

    def test_run_sh_reuses_the_gramps_lane_so_a_failing_scenario_fails_the_run(self):
        with open(os.path.join(E2E, "run.sh"), encoding="utf-8") as fh:
            text = fh.read()
        self.assertIn('HFY_LANE_DIR="$HERE"', text)
        self.assertIn("scenario_*.py", text)
        self.assertIn("exec bash", text)
        with open(os.path.join(GRAMPS, "tests", "gramps", "run.sh"), encoding="utf-8") as fh:
            lane = fh.read()
        self.assertIn('HFY_LANE_DIR:-$HERE', lane)
        self.assertIn('|| fail "$base failed"', lane)  # a failing test file ends the run with status 1

    def test_the_files_compile_and_only_the_scenario_base_needs_the_lane(self):
        import ast

        for name in sorted(os.listdir(E2E)):
            if not name.endswith(".py"):
                continue
            with open(os.path.join(E2E, name), encoding="utf-8") as fh:
                tree = ast.parse(fh.read(), name)
            imported = set()
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    imported.update(a.name.split(".")[0] for a in node.names)
                elif isinstance(node, ast.ImportFrom) and node.module:
                    imported.add(node.module.split(".")[0])
            self.assertNotIn("gramps", imported, name)  # the bundle's package; the addon core is hfygramps
            if name == "e2e_support.py":
                self.assertNotIn("addon_support", imported)  # importable here, without the lane

    def test_the_scenarios_skip_themselves_outside_run_sh(self):
        env = {k: v for k, v in os.environ.items() if k not in ("GRAMPSHOME", "HFY_TREE_NAME")}
        proc = subprocess.run([sys.executable, os.path.join(E2E, "scenario_smoke.py")], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, universal_newlines=True)
        self.assertEqual(proc.returncode, 0, proc.stdout)
        self.assertIn("skipped", proc.stdout)


@unittest.skipUnless(E.node_available() and E.server_dependencies_installed(), "needs node 22 and api/node_modules (not in CI)")
class RealServer(unittest.TestCase):
    def test_the_addons_own_login_works_against_the_real_dev_server_and_the_log_is_greppable(self):
        with E.DevServer() as s:
            status, doc = s.get_json("/_dev/health")
            self.assertEqual((status, doc["ok"]), (200, True))
            session = E.sign_in(s)
            self.assertEqual(session.client().meta()["api_version"], 1)
            self.assertEqual(s.state()["head"], None)
            s.set_head(writes_enabled=False)
            self.assertFalse(session.client().meta()["writes_enabled"])
            self.assertEqual([e["path"] for e in s.entries()][:2], ["/_dev/health", "/auth/authorize"])
            self.assertEqual(s.grep(session.keychain.token), [])
            work = s.work_dir
        self.assertFalse(os.path.exists(work))


if __name__ == "__main__":
    unittest.main()
