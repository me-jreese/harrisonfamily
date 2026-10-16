"""The `rebase` action (HFY-TSK-275, error catalog D50): a tree meets a recovered or re-seeded website store, on the synthetic fixture.

The cloud gets a new tree id (what `sync-admin.mjs bump-tree-id` does). Pull stops at the handshake with D50 and `next_action: rebase`.
The rebase re-bases the objects both sides agree on, turns the rest into conflicts, leaves the tree and the website alone, and sends nothing.
Everything runs against a fake tree and a fake cloud (addon_pull_support.py); the end-to-end lane (gramps/tests/e2e/scenario_rebase.py)
repeats it against the real Gramps CLI and the dev server. Every value is fictional.
"""
import copy
import os
import unittest

import addon_pull_support as S
from hfygramps.addon import backup, consts, runner, sidecar, status, transport

NEW_TREE = "99999999-aaaa-4bbb-8ccc-dddddddddddd"
EXTRA_NOTE = "ee" * 14


def by_gid(objects, gid):
    return next(o for o in objects.values() if o.get("gramps_id") == gid)


def cloud_objects(env):
    return {h: v["obj"] for h, v in env.cloud.heads.items() if not v["deleted"]}


class RebaseCase(S.PullCase):
    """A bound, settled tree (the first pull recorded the base), then a cloud that was recovered: a new tree, a lower seq, versions from 1."""

    def recover(self, drop=(), edit=None, add=()):
        e = self.env
        old = e.cloud
        heads = copy.deepcopy(old.heads)
        for h in drop:
            heads.pop(h)
        for h, fn in (edit or {}).items():
            fn(heads[h]["obj"])
        for obj in add:
            heads[obj["handle"]] = {"class": obj["_class"], "handle": obj["handle"], "gramps_id": obj.get("gramps_id", ""), "version": 1, "seq": 1,
                                    "deleted": False, "obj": obj}
        for i, head in enumerate(sorted(heads.values(), key=lambda x: x["handle"]), 1):
            head["version"], head["seq"] = 1, i  # a re-seeded store: versions and seqs start again
        e.cloud = S.FakeCloud(e.tree.dbid, heads=heads, seq=len(heads), tree_id=NEW_TREE)
        e.cloud.calls.clear()

    def meta(self):
        con = self.env.side()
        try:
            return sidecar.meta(con)
        finally:
            con.close()

    def table(self, name):
        con = self.env.side()
        try:
            return con.execute("SELECT * FROM %s ORDER BY 1, 2" % name).fetchall()
        finally:
            con.close()


class Refusal(RebaseCase):
    def test_pull_and_sync_stop_at_the_handshake_with_d50_and_name_the_rebase(self):
        self.recover()
        for action in ("check", "pull", "sync"):
            doc = self.env.run(action, yes=True)
            self.assertEqual((doc["result"], doc["exit_code"], doc["error"]["code"], doc["next_action"]), ("refused", 78, "D50", "rebase"), action)
        self.assertEqual(self.env.tree.applies, 0)
        self.assertEqual(self.env.cloud.calls, ["meta", "meta", "meta"])  # no snapshot was fetched

    def test_the_server_s_403_tree_mismatch_maps_to_the_rebase_too(self):
        self.assertEqual(transport.map_error(403, "tree_mismatch"), (consts.EXIT_CONFIG, "rebase"))

    def test_rebase_is_an_implemented_action_and_the_wrapper_treats_it_as_a_look_unless_yes(self):
        self.assertIn("rebase", consts.ACTIONS)
        self.assertIn("rebase", consts.IMPLEMENTED_ACTIONS)
        self.assertIn("rebase", consts.NEXT_ACTIONS)
        self.assertNotIn("rebase", consts.PULL_ACTIONS)  # it is not a pull: it writes no Gramps object


class Dry(RebaseCase):
    def test_a_dry_run_classifies_and_changes_nothing(self):
        e = self.env
        target = by_gid(e.tree.objects(), "I0002")
        e.tree.edit(target["handle"], lambda o: o["primary_name"].update(nick="Birdie"))  # differs from the recovered store: a conflict
        note = by_gid(e.tree.objects(), "N0004")
        extra = copy.deepcopy(by_gid(cloud_objects(e), "N0004"))
        extra.update(handle=EXTRA_NOTE, gramps_id="N9001")
        self.recover(drop=[note["handle"]], add=[extra])  # the desktop's note is gone from the store; a note exists only there
        base_before, meta_before, runs_before = self.table("base"), self.meta(), self.table("conflicts")
        objects_before = e.tree.objects()
        for opt in ({}, {"dry_run": True, "yes": True}):
            doc = e.run("rebase", **opt)
            self.assertEqual((doc["result"], doc["exit_code"], doc["next_action"]), ("changes_pending", 10, "none"), opt)
            r = doc["counts"]["rebase"]
            self.assertEqual((r["needed"], r["conflicts"], r["cloud_only"], r["desktop_only"]), (True, 1, 1, 1), opt)
            self.assertGreater(r["rebased"], 70)
        self.assertEqual(self.table("base"), base_before)
        self.assertEqual(self.table("conflicts"), runs_before)
        meta_after = self.meta()
        for k in ("cloud_tree_id", "last_pull_seq", "last_snapshot_sha256", "pull_n"):
            self.assertEqual(meta_after.get(k), meta_before.get(k), k)
        self.assertEqual(e.tree.objects(), objects_before)
        self.assertEqual(os.listdir(e.tp.backups), [])
        self.assertEqual(e.cloud.calls.count("fetch"), 2)

    def test_nothing_to_rebase_when_the_cloud_tree_is_the_one_last_synced(self):
        e = self.env
        before = self.table("base")
        e.cloud.calls.clear()
        doc = e.run("rebase", yes=True)
        self.assertEqual((doc["result"], doc["exit_code"]), ("ok", 0))
        self.assertEqual(doc["counts"]["rebase"], {"needed": False})
        self.assertEqual(self.table("base"), before)
        self.assertEqual(os.listdir(e.tp.backups), [])
        self.assertNotIn("snapshot", e.cloud.calls)


class Apply(RebaseCase):
    def prepare(self):
        e = self.env
        objects = e.tree.objects()
        self.edited = by_gid(objects, "I0002")["handle"]
        self.dropped = by_gid(objects, "N0004")["handle"]
        e.tree.edit(self.edited, lambda o: o["primary_name"].update(nick="Birdie"))
        extra = copy.deepcopy(by_gid(cloud_objects(e), "N0004"))
        extra.update(handle=EXTRA_NOTE, gramps_id="N9001")
        self.recover(drop=[self.dropped], add=[extra])
        self.objects_before = e.tree.objects()
        self.heads_before = copy.deepcopy(e.cloud.heads)

    def test_converged_objects_become_the_new_base_the_rest_become_conflicts_and_nothing_is_changed_or_sent(self):
        e = self.env
        self.prepare()
        con = e.side()
        con.execute("INSERT INTO outbox (batch_key, created_at, state, request_json) VALUES ('old-pending', '2026-10-01T00:00:00Z', 'pending', '{}')")
        con.execute("INSERT INTO outbox (batch_key, created_at, state, request_json) VALUES ('old-acked', '2026-10-01T00:00:00Z', 'acked', '{}')")
        con.commit()
        con.close()
        doc = e.run("rebase", yes=True)
        self.assertEqual((doc["result"], doc["exit_code"], doc["next_action"], doc["error"]["code"]), ("partial", 20, "resolve_conflicts", "conflicts_open"))
        self.assertEqual(doc["counts"]["rebase"]["conflicts"], 1)
        self.assertEqual(doc["counts"]["rebase"]["needed"], False)
        self.assertTrue(doc["backup"])
        # the tree and the website are exactly as they were; nothing was pushed (the fake cloud has no push call, and no call but a read)
        self.assertEqual(e.tree.objects(), self.objects_before)
        self.assertEqual(e.tree.applies, 0)
        self.assertEqual(e.cloud.heads, self.heads_before)
        self.assertEqual(set(e.cloud.calls), {"meta", "snapshot", "fetch"})
        # the base: the objects both sides hold equal, at the NEW store's versions and seqs; not the edited object, not the missing one
        base = {row[1]: row for row in self.table("base")}
        self.assertNotIn(self.edited, base)
        self.assertNotIn(self.dropped, base)
        self.assertNotIn(EXTRA_NOTE, base)
        self.assertGreater(len(base), 70)
        for handle, row in base.items():
            head = e.cloud.heads[handle]
            self.assertEqual((row[2], row[3], row[4]), (head["version"], head["seq"], S.canonical.object_hash(head["obj"])), handle)
        # one conflict, parked (command line), on the edited object
        conflicts = self.table("conflicts")
        self.assertEqual([(c[2], c[8]) for c in conflicts], [(self.edited, "parked")])
        # the meta follows the new tree; the guard against going back is moved to the new store's seq
        meta = self.meta()
        self.assertEqual(meta["cloud_tree_id"], NEW_TREE)
        self.assertEqual(int(meta["last_pull_seq"]), e.cloud.seq)
        self.assertEqual(meta["rebase_n"], "1")
        # unsent entries addressed to the old tree are rejected; sent-and-acked history stays
        self.assertEqual(dict(self.table_rows("outbox", "batch_key, state")), {"old-pending": "rejected", "old-acked": "acked"})
        self.assertEqual(len(os.listdir(e.tp.backups)), 3)  # database, sidecar copy, sha256
        self.assertTrue(any("-rebase-seq" in n for n in os.listdir(e.tp.backups)))

    def table_rows(self, name, cols):
        con = self.env.side()
        try:
            return con.execute("SELECT %s FROM %s" % (cols, name)).fetchall()
        finally:
            con.close()

    def test_an_object_deleted_in_this_tree_since_the_last_sync_is_counted_apart_not_as_only_on_the_website(self):
        e = self.env
        gone = by_gid(e.tree.objects(), "N0004")["handle"]
        e.tree.remove(gone)  # deleted on the desktop, not yet pushed
        self.recover()  # the recovered store still holds it
        objects_before = e.tree.objects()
        for opt in ({}, {"yes": True}):
            doc = e.run("rebase", **opt)
            r = doc["counts"]["rebase"]
            self.assertEqual((r["cloud_only"], r["deleted_on_desktop"], r["conflicts"]), (0, 1, 0), opt)
            self.assertEqual(e.tree.objects(), objects_before)
        self.assertRegex(status.summary_line(doc), r"only on the website: 0, only on the desktop: 0, deleted on the desktop but still on the website: 1")
        self.assertNotIn(gone, {row[1] for row in self.table("base")})  # the base forgot it, as the dialog says
        self.assertEqual(self.meta()["cloud_tree_id"], NEW_TREE)

    def test_after_the_rebase_a_pull_works_brings_in_what_only_the_website_has_and_keeps_the_conflict(self):
        e = self.env
        self.prepare()
        e.run("rebase", yes=True)
        doc = e.run("check")
        self.assertEqual(doc["error"] and doc["error"]["code"], None if not doc["error"] else doc["error"]["code"])
        self.assertNotEqual((doc["error"] or {}).get("code"), "D50")
        self.assertEqual(doc["counts"]["pulled"], {"create": 1, "update": 0, "delete": 0})  # the note that exists only on the website
        doc = e.run("pull", yes=True)
        self.assertEqual(doc["exit_code"], 20)  # the conflict is still open
        self.assertIn(EXTRA_NOTE, e.tree.objects())
        self.assertEqual(e.tree.objects()[self.edited], self.objects_before[self.edited])  # the desktop's edit is untouched
        self.assertEqual(e.cloud.heads[self.edited]["obj"], self.heads_before[self.edited]["obj"])
        self.assertEqual(doc["counts"]["conflicts_open"], 1)

    def test_in_the_window_the_conflicts_stay_open_instead_of_parked(self):
        e = self.env
        self.prepare()
        doc = e.run("rebase", mode="gui", yes=True)
        self.assertEqual(doc["exit_code"], 20)
        self.assertEqual([c[8] for c in self.table("conflicts")], ["open"])

    def test_old_open_conflicts_are_closed_and_the_pull_window_is_cleared(self):
        e = self.env
        self.prepare()
        con = e.side()
        con.execute("INSERT INTO conflicts (id, class, handle, path, kind, state, detected_at) VALUES ('old-1', 'Note', 'zz', '/text', 'field', 'parked', '2026-10-01T00:00:00Z')")
        sidecar.ensure_pull_tables(con)
        con.execute("INSERT INTO pulled (run_n, class, handle, kind, prepull_json, at) VALUES (1, 'Note', 'zz', 'update', '{}', '2026-10-01T00:00:00Z')")
        con.commit()
        con.close()
        e.run("rebase", yes=True)
        rows = {c[0]: (c[8], c[9]) for c in self.table("conflicts")}
        self.assertEqual(rows["old-1"], ("resolved", "rebase"))
        self.assertEqual(self.table("pulled"), [])

    def test_a_clean_rebase_is_ok_and_a_second_one_has_nothing_to_do(self):
        e = self.env
        self.recover()  # a recovered store equal to the desktop's: everything converges
        doc = e.run("rebase", yes=True)
        self.assertEqual((doc["result"], doc["exit_code"], doc["next_action"]), ("ok", 0, "none"))
        self.assertEqual(doc["counts"]["rebase"]["conflicts"], 0)
        self.assertEqual(len(self.table("base")), 82)
        self.assertEqual(e.run("pull", yes=True)["result"], "ok")
        again = e.run("rebase", yes=True)
        self.assertEqual(again["counts"]["rebase"], {"needed": False})

    def test_a_failed_rebase_before_the_sidecar_write_leaves_the_old_base_in_place(self):
        e = self.env
        self.prepare()
        base_before = self.table("base")
        meta_before = self.meta()
        e.environ["HFY_SYNC_FAULT"] = "after_backup"  # honoured only with HFY_SYNC_TEST=1, which Env sets
        doc = e.run("rebase", yes=True)
        self.assertEqual((doc["result"], doc["exit_code"]), ("failed", 70))
        self.assertEqual(self.table("base"), base_before)
        self.assertEqual(self.meta().get("cloud_tree_id"), meta_before.get("cloud_tree_id"))
        del e.environ["HFY_SYNC_FAULT"]
        doc = e.run("rebase", yes=True)  # the next run starts again and finishes
        self.assertEqual(doc["exit_code"], 20)
        self.assertEqual(self.meta()["cloud_tree_id"], NEW_TREE)


class Other(RebaseCase):
    def test_another_trees_store_is_d03_and_an_unbound_store_is_refused_and_nothing_changes(self):
        e = self.env
        self.recover()
        e.cloud.dbid = "another"
        doc = e.run("rebase", yes=True)
        self.assertEqual((doc["result"], doc["error"]["code"]), ("refused", "D03"))
        e.cloud.dbid = e.tree.dbid
        e.cloud.bound = False
        doc = e.run("rebase", yes=True)
        self.assertEqual((doc["result"], doc["error"]["code"]), ("refused", "cloud_unbound"))
        self.assertEqual(self.meta()["cloud_tree_id"], S.CLOUD_TREE)

    def test_an_unbound_tree_is_refused_without_reading_the_website(self):
        e = S.Env(self, seed=False)
        os.unlink(e.tp.config)
        doc = e.run("rebase", yes=True)
        self.assertEqual((doc["result"], doc["error"]["code"]), ("refused", "unbound"))
        self.assertEqual(e.cloud.calls, [])

    def test_the_summary_line_names_the_counts_only(self):
        self.recover()
        doc = self.env.run("rebase")
        line = status.summary_line(doc)
        self.assertRegex(line, r"re-based: \d+, conflicts: 0, only on the website: 0, only on the desktop: 0")


if __name__ == "__main__":
    unittest.main()
