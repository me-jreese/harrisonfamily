"""Rebase scenario of the end-to-end lane (HFY-TSK-275, error catalog D50): the installed addon, the real Gramps CLI and the sync dev server.

A tree is bound, seeded to the cloud and synced. The cloud then gets a new tree id (the dev server's stand-in for `sync-admin.mjs
bump-tree-id` on a recovered store) and the website's copy of a note differs. On a private copy of the fixture tree:

    pull       stops at the handshake: D50, exit 78, next action `rebase`; the database file and the sidecar are byte for byte as they were
    rebase     without --yes it only looks (exit 10) and changes nothing; with --yes it re-bases the objects both sides agree on, turns the
               rest into parked conflicts (exit 20), takes a verified backup, leaves the database file and the website untouched, and
               makes no write request to the website
    pull       afterwards works against the new store (no D50), keeps the conflicts, and still pushes nothing

Fictional data only; no field value is printed.
"""
import copy
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import e2e_case as C  # noqa: E402
import e2e_cloud as K  # noqa: E402
import scenario_pull as P  # noqa: E402

NEW_TREE = "99999999-aaaa-4bbb-8ccc-dddddddddddd"


class RebaseE2E(P.PullE2E):
    def writes(self):
        """Write requests the website answered 2xx to: the addon pushed or opened a session."""
        return [e for e in self.server.requests(method="POST") if e["path"].startswith("/api/sync/batches") or e["path"].startswith("/api/sync/sessions")]

    def test_rebase_after_a_recovery_rebases_the_converged_objects_and_turns_the_rest_into_conflicts(self):
        self.bring_up()
        self.settle()
        self.local_edit_note("N0004", "The desktop's version.")
        self.cloud.edit("N0001", lambda o: o.update(format=1 - o.get("format", 0)))  # the website differs on a second object
        self.server.set_head(tree_id=NEW_TREE)  # the store was recovered: a new cloud tree
        self.cloud.follow_tree(NEW_TREE)
        self.opened_once()
        db_before, base_before, cloud_before = self.db_sha(), self.base_dump(), self.cloud_digest()
        meta_before = self.table("SELECT key, value FROM meta ORDER BY key")
        posts_before = len(self.writes())

        # 1. pull and sync stop at the handshake and name the rebase
        for action in ("pull", "sync"):
            proc, doc = self.hfy(action, "--yes")
            self.assertEqual((proc.returncode, doc["result"], doc["error"]["code"], doc["next_action"]), (78, "refused", "D50", "rebase"), proc.stdout + proc.stderr)
        self.assertEqual(self.db_sha(), db_before)
        self.assertEqual(self.base_dump(), base_before)

        # 2. without --yes the rebase only looks
        proc, doc = self.hfy("rebase")
        self.assertEqual((proc.returncode, doc["result"], doc["dry_run"]), (10, "changes_pending", True), proc.stdout + proc.stderr)
        r = doc["counts"]["rebase"]
        self.assertEqual((r["needed"], r["conflicts"], r["cloud_only"], r["desktop_only"]), (True, 2, 0, 0))
        self.assertGreater(r["rebased"], 50)
        self.assertEqual(self.db_sha(), db_before)
        self.assertEqual(self.base_dump(), base_before)
        self.assertEqual(self.table("SELECT key, value FROM meta ORDER BY key"), meta_before)
        self.assertIsNone(doc["backup"])

        # 3. with --yes it re-bases
        proc, doc = self.hfy("rebase", "--yes")
        self.assertEqual((proc.returncode, doc["result"], doc["next_action"], doc["error"]["code"]), (20, "partial", "resolve_conflicts", "conflicts_open"),
                         proc.stdout + proc.stderr)
        self.assertEqual(doc["counts"]["rebase"]["rebased"], r["rebased"])
        self.assertTrue(doc["backup"] and os.path.isfile(doc["backup"]))
        self.assertEqual(self.db_sha(), db_before, "the tree is not written")
        self.assertEqual(self.cloud_digest(), cloud_before, "the website is not written")
        self.assertEqual(len(self.writes()), posts_before, "no push and no session: nothing is sent")
        self.assertEqual(self.local_note_text(), "The desktop's version.")
        base = self.base_dump()
        self.assertEqual(len(base), r["rebased"])
        conflicts = self.table("SELECT state, path, kind FROM conflicts ORDER BY handle")  # no common base: the whole object differs
        self.assertEqual(conflicts, [("parked", "", "field")] * 2)
        meta = dict(self.table("SELECT key, value FROM meta"))
        self.assertEqual(meta["cloud_tree_id"], NEW_TREE)
        self.assertEqual(meta["rebase_n"], "1")
        heads = self.cloud.heads()
        for _cls, handle, version, seq, _hash, _obj, deleted in base:
            self.assertEqual((version, seq, deleted), (heads[handle]["version"], heads[handle]["seq"], 0), "the base follows the new store")
        self.assertNotIn("version.", proc.stdout + proc.stderr + json.dumps(doc), "the CLI prints no field values")

        # 4. a pull now works against the new store; the conflicts wait and nothing is pushed
        proc, doc = self.hfy("pull", "--yes")
        self.assertEqual((proc.returncode, doc["result"], doc["counts"]["conflicts_open"]), (20, "partial", 2), proc.stdout + proc.stderr)
        self.assertNotEqual((doc["error"] or {}).get("code"), "D50")
        self.assertEqual(self.db_sha(), db_before)
        self.assertEqual(len(self.writes()), posts_before)
        self.assertEqual(self.cloud_digest(), cloud_before)

    def test_a_second_rebase_has_nothing_to_do(self):
        self.bring_up()
        self.settle()
        self.server.set_head(tree_id=NEW_TREE)
        proc, doc = self.hfy("rebase", "--yes")
        self.assertEqual((proc.returncode, doc["result"], doc["counts"]["rebase"]["conflicts"]), (0, "ok", 0), proc.stdout + proc.stderr)
        again, doc2 = self.hfy("rebase", "--yes")
        self.assertEqual((again.returncode, doc2["counts"]["rebase"]), (0, {"needed": False}))
        self.assertEqual(self.hfy("pull", "--yes")[0].returncode, 0)


if __name__ == "__main__":
    unittest.main()
