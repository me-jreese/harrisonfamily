"""Smoke scenario of the end-to-end lane (HFY-TSK-181): bind, status, and the empty check, with the dev server's request log greped.

    bind     `hfy-sync bind --yes` on a copy of the fixture tree (the real Gramps CLI and the installed addon): the marker, the sidecar and
             config.json; then the cloud bind with what the sidecar recorded (POST /api/sync/bind through the addon's own transport).
    status   `hfy-sync status` exits 0 and reports the tree bound; the cloud's handshake says the same.
    check    the empty check: the cloud holds nothing, and a snapshot of it verifies the way the addon will (gzip, header, hash, count 0).
    log      the dev server's log holds every request, and nothing of the tree's content or any credential.

Fictional data only. The names searched for in the log are read from the committed fixture at run time and never printed.
"""
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import e2e_case as C  # noqa: E402
import e2e_support as E  # noqa: E402
from hfygramps.addon import consts, transport  # noqa: E402

FIXTURE_JSONL = os.path.join(HERE, "..", "fixtures", "synthetic-tree.jsonl")


def fixture_words():
    """Distinctive strings of the fixture tree that must never reach the server in this scenario: given and family names, note text."""
    words = set()
    with open(FIXTURE_JSONL, encoding="utf-8") as fh:
        for line in fh:
            obj = json.loads(line)
            if obj.get("_class") == "Person":
                name = obj.get("primary_name") or {}
                words.add(name.get("first_name") or "")
                for sn in name.get("surname_list") or []:
                    words.add(sn.get("surname") or "")
            elif obj.get("_class") == "Note":
                words.add(((obj.get("text") or {}).get("string") or "")[:24])
    return sorted(w for w in words if len(w) >= 4)


class Smoke(C.E2ECase):
    def test_bind_then_status(self):
        meta = self.bind_local()
        self.assertEqual(meta["dbid"], self.dbid)
        doc = C.S.read_status(self.dbid)
        self.assertEqual((doc["action"], doc["result"], doc["exit_code"]), ("bind", "ok", 0))
        self.assertTrue(doc["tree"]["bound"])
        self.assertEqual(C.S.tree_metadata(self.dir, consts.TREE_MARKER_KEY), meta["tree_id"])
        proc = self.wrapper("status", "--json")
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        status = json.loads(proc.stdout)
        self.assertEqual((status["action"], status["result"], status["tree"]), ("status", "ok", {"dbid": self.dbid, "bound": True}))

    def test_cloud_bind_and_the_empty_check(self):
        local = self.bind_local()
        server = self.start_server()
        self.point_config_at(server)
        self.assertEqual(self.wrapper("status").returncode, 0)  # the edited config still binds the tree

        session = E.sign_in(server)
        client = session.client()
        meta = client.meta()
        self.assertEqual(meta["api_version"], 1)
        self.assertEqual((meta["tree_id"], meta["bound"], meta["head_seq"], meta["seeded"], meta["writes_enabled"]), (None, None, 0, False, True))
        self.assertEqual(meta["id_block"]["Person"], "I8000-I8999")
        self.assertEqual(meta["retired_person_ids"], [])

        resp = client.post("/api/sync/bind", {"dbid": local["dbid"], "fingerprint": local["fingerprint"], "tree_name_sha256": self.tree_name_sha256()})
        self.assertEqual(resp.status, 200)
        cloud_tree = resp.body["tree_id"]
        meta = client.meta()
        self.assertEqual(meta["tree_id"], cloud_tree)
        self.assertEqual(meta["bound"], {"dbid": local["dbid"], "fingerprint": local["fingerprint"]})
        with self.assertRaises(transport.TransportError) as ctx:  # a second bind is refused, not repeated
            client.post("/api/sync/bind", {"dbid": local["dbid"], "fingerprint": local["fingerprint"], "tree_name_sha256": self.tree_name_sha256()})
        self.assertEqual((ctx.exception.status, ctx.exception.code), (409, "already_bound"))

        # The empty check: the cloud has no objects, so a snapshot of it has a header and nothing else.
        client = session.client(tree_id=cloud_tree)
        snap = client.get("/api/sync/snapshot").body
        self.assertEqual((snap["seq"], snap["count"]), (0, 0))
        header, lines = E.read_snapshot(snap["url"], snap)
        self.assertEqual(lines, [])
        self.assertEqual((header["tree_id"], header["count"], header["seq"]), (cloud_tree, 0, 0))
        self.assertEqual(server.state()["s3_objects"]["hfy-dev-sync"], 2)  # the snapshot file and the checkpoint the store views start from

        # The heartbeat the addon sends after a run.
        status = C.S.read_status(self.dbid)
        with open(C.S.tree_paths(self.dbid)["config"], encoding="utf-8") as fh:
            instance = json.load(fh)["client_instance_id"]
        beat = client.post("/api/sync/status", {
            "client_instance_id": instance,
            "dbid": local["dbid"], "fingerprint": local["fingerprint"], "addon_version": consts.ADDON_VERSION, "gramps_version": status["versions"]["gramps"],
            "schema": status["versions"]["db_schema"],
            "last_run": {"run_id": status["run_id"], "action": status["action"], "result": status["result"], "exit_code": status["exit_code"], "finished_at": status["finished_at"]},
        })
        self.assertEqual(beat.status, 204)

    def test_the_request_log_holds_the_requests_and_no_tree_content_or_credential(self):
        local = self.bind_local()
        server = self.start_server()
        session = E.sign_in(server)
        client = session.client()
        client.meta()
        client.post("/api/sync/bind", {"dbid": local["dbid"], "fingerprint": local["fingerprint"], "tree_name_sha256": self.tree_name_sha256()})

        # Every request is in the log, with its body as written.
        paths = [(e["method"], e["path"]) for e in server.entries()]
        self.assertEqual(paths, [("GET", "/auth/authorize"), ("POST", "/auth/token"), ("GET", "/api/sync/meta"), ("POST", "/api/sync/bind")])
        self.assertTrue(server.grep('"dbid":"%s"' % local["dbid"]), "the bind body is not greppable")
        bind = server.requests(method="POST", path="/api/sync/bind")[0]
        self.assertEqual((bind["status"], bind["body"]["dbid"], bind["auth"]), (200, local["dbid"], "bearer"))
        self.assertEqual(bind["headers"]["x-hfy-gramps-schema"], "21")

        # Nothing of the tree's content was sent (a bind sends ids and hashes), and no credential was written down.
        words = fixture_words()
        self.assertGreater(len(words), 3, "the fixture has no names to look for")
        for word in words:
            self.assertEqual(server.grep(word), [], "a fixture name or note reached the server")
        for secret in (session.keychain.token, session.tokens.access_token(), "Bearer "):
            self.assertEqual(server.grep(secret), [], "a credential was logged")


if __name__ == "__main__":
    unittest.main()
