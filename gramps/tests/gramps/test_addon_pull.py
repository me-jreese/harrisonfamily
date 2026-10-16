"""The pull's local apply against a real Gramps database (HFY-TSK-205): one DbTxn, one undo entry, a full rollback on any failure.

Run by run.sh inside the bundled Python on a copy of the fixture tree, with the installed addon's `GrampsTree`. The cloud is the
in-memory fake of tests/unit (a pull needs one; the real dev server is the e2e lane's). What this file proves that the unit tests
cannot: `object_to_dict` reads the tree the way the fixture JSONL says it is, `data_to_object` + `commit_*` write what the plan
asks, the transaction is named for the seq and is ONE entry of Edit > Undo, and an exception inside it (a failed relationship check,
a changed object, a fault) leaves the database file byte for byte as it was.
"""
import copy
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "unit"))
import addon_support as S  # noqa: E402
import fixture_trees as ft  # noqa: E402
from test_addon_skeleton import AddonCase  # noqa: E402

try:
    import addon_pull_support as UP  # noqa: E402
except ImportError:  # pragma: no cover
    UP = None


def load_tool():
    sys.path.insert(0, S.PLUGIN_DIR)
    try:
        import hfy_sync_tool
        from hfygramps.addon import consts, errors, faults, runner
        from hfygramps import merge as M
    finally:
        if S.PLUGIN_DIR in sys.path:
            sys.path.remove(S.PLUGIN_DIR)
    return hfy_sync_tool, consts, errors, faults, runner, M


def unreferenced(objects):
    """(class, handle) of an object nothing else names, so a delete cannot dangle (in the fixture, a Place)."""
    text = {h: json.dumps(o, sort_keys=True) for h, o in objects.items()}
    for h, o in sorted(objects.items()):
        if not any(h in t for k, t in text.items() if k != h):
            return o["_class"], h
    return None


class PullApply(AddonCase):
    def setUp(self):
        super().setUp()
        try:
            self.tool, self.consts, self.errors, self.faults, self.runner, self.M = load_tool()
        except ImportError:
            self.skipTest("needs the bundled Gramps")
        self.fixture = {h: o for h, o in UP.load_fixture().items()}

    def objects(self):
        return self.edit(lambda db, DbTxn: self.tool.GrampsTree(db).objects())

    def test_the_tree_reads_back_as_the_fixture_says_it_is(self):
        got = self.objects()
        self.assertEqual(len(got), len(self.fixture))
        self.assertEqual(got, self.fixture)

    def test_apply_is_one_transaction_named_for_the_seq_and_one_undo_entry(self):
        before = self.objects()
        note = copy.deepcopy(before[next(h for h, o in before.items() if o.get("gramps_id") == "N0004")])
        note["text"]["string"] = "Edited by the website sync test."
        fresh = copy.deepcopy(note)
        fresh.update(handle="a" * 28, gramps_id="N8001")
        fresh.pop("change", None)  # a created object arrives without Gramps' change stamp
        gone = unreferenced({h: o for h, o in before.items() if h != note["handle"]})
        self.assertIsNotNone(gone)

        def run(db, DbTxn):
            tree = self.tool.GrampsTree(db)
            seen = []
            tree.apply("Website sync: pull seq 7", {note["handle"]: note, fresh["handle"]: fresh}, [gone],
                       precheck=lambda read: seen.append(read("Note", note["handle"])["text"]["string"]),
                       verify=lambda now: seen.append(len(now)), hook=lambda step: seen.append(step))
            self.assertEqual(seen[0], before[note["handle"]]["text"]["string"], "precheck reads the tree as it was")
            self.assertEqual(seen[1], "mid_apply")
            self.assertEqual(seen[2], len(before) + 1 - 1, "verify sees the transaction's own result")
            after = tree.objects()
            self.assertEqual(after[note["handle"]]["text"]["string"], "Edited by the website sync test.")
            self.assertEqual(after[fresh["handle"]]["text"]["string"], "Edited by the website sync test.")
            self.assertNotIn(gone[1], after)
            undo = db.get_undodb()
            self.assertEqual(len(undo.undoq), 1, "the whole sync is one entry of Edit > Undo")
            self.assertEqual(undo.undoq[-1].get_description(), "Website sync: pull seq 7")
            self.assertTrue(db.undo(), "undo succeeds")
            self.assertEqual(tree.objects(), before, "one Undo puts back all three changes")
            self.assertTrue(db.redo(), "redo succeeds")
            self.assertEqual(tree.objects(), after)
            self.assertTrue(db.undo())
            self.assertFalse(db.undo(), "there was only one entry")
            self.assertEqual(tree.objects(), before)
            return after

        self.edit(run)
        self.assertTrue(self.integrity_ok())

    def integrity_ok(self):
        con = S.sqlite_ro(os.path.join(self.dir, "sqlite.db"))
        try:
            return con.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        finally:
            con.close()

    def rolled_back(self, **kw):
        """Runs an apply that must fail; returns the exception. The database directory is compared byte for byte."""
        before = self.objects()
        before_digest = ft.db_digest(self.dir)  # after the first open: merely opening the tree rewrites its metadata
        errors = []

        def run(db, DbTxn):
            tree = self.tool.GrampsTree(db)
            h = next(h for h, o in before.items() if o.get("gramps_id") == "N0004")
            o = copy.deepcopy(before[h])
            o["text"]["string"] = "This must not survive."
            try:
                tree.apply("Website sync: pull seq 9", {h: o}, kw.pop("removals", []), **kw)
            except BaseException as exc:  # noqa: BLE001
                errors.append(exc)
            self.assertEqual(len(db.get_undodb().undoq), 0, "an aborted transaction leaves no undo entry")
            return tree.objects()

        during = self.edit(run)
        self.assertEqual(during, before, "rolled back inside the open session")
        self.assertEqual(ft.db_digest(self.dir), before_digest, "and the files on disk are byte for byte as they were")
        self.assertEqual(len(errors), 1)
        return errors[0]

    def test_a_symmetry_violation_aborts_the_transaction_and_leaves_the_database_unchanged(self):
        before = self.objects()
        person = copy.deepcopy(next(o for o in before.values() if o.get("gramps_id") == "I0001"))
        existing = {v["key"] for v in self.M.check_integrity(before)}

        def verify(now):
            new = [v for v in self.M.check_integrity(now) if v["key"] not in existing]
            if new:
                raise self.errors.ApplyAborted("integrity", "broken")

        person["family_list"] = []  # the family still names this person as a parent
        before_digest = ft.db_digest(self.dir)

        def run(db, DbTxn):
            tree = self.tool.GrampsTree(db)
            with self.assertRaises(self.errors.ApplyAborted):
                tree.apply("Website sync: pull seq 9", {person["handle"]: person}, [], verify=verify)
            return tree.objects()

        self.assertEqual(self.edit(run), before)
        self.assertEqual(ft.db_digest(self.dir), before_digest)

    def test_a_changed_object_a_fault_and_a_failed_check_each_roll_everything_back(self):
        exc = self.rolled_back(precheck=lambda read: (_ for _ in ()).throw(self.errors.StaleTree()))
        self.assertIsInstance(exc, self.errors.StaleTree)
        exc = self.rolled_back(hook=faults_hit(self.faults, "mid_apply"))
        self.assertIsInstance(exc, self.faults.FaultInjected)
        exc = self.rolled_back(verify=lambda now: (_ for _ in ()).throw(self.errors.ApplyAborted("integrity", "x")))
        self.assertIsInstance(exc, self.errors.ApplyAborted)

    def test_check_pull_and_the_fault_boundaries_on_the_real_database(self):
        """The runner end to end, in this process, over the real database and the fake cloud; the e2e lane does it across processes."""
        self.bind()
        before_objects = self.objects()
        projected = UP.project_all(before_objects)
        cloud = UP.FakeCloud(self.dbid, UP.heads_of(projected))
        env = dict(os.environ, HFY_SYNC_PS_CMD="true")

        def go(action, services=None, **opt):
            def run(db, DbTxn):
                return self.runner.run(self.tool.GrampsTree(db), "cli", self.runner.Options(action, **opt), argv=["gramps"], environ=env,
                                       services=dict({"cloud": cloud}, **(services or {})))
            return self.edit(run)

        first = go("pull", yes=True)
        self.assertEqual((first["result"], first["exit_code"]), ("ok", 0), first["error"])
        note = copy.deepcopy(cloud.heads[next(h for h, o in before_objects.items() if o.get("gramps_id") == "N0004")]["obj"])
        note["text"]["string"] = "Edited on the website."
        cloud.put(note)
        digest = ft.db_digest(self.dir)
        checked = go("check")
        self.assertEqual((checked["result"], checked["exit_code"]), ("changes_pending", 10))
        self.assertEqual(ft.db_digest(self.dir), digest, "a check leaves the tree alone")
        crashed = go("pull", yes=True, services={"faults": self.faults.Faults({"HFY_SYNC_TEST": "1", "HFY_SYNC_FAULT": "mid_apply"})})
        self.assertEqual((crashed["result"], crashed["exit_code"]), ("failed", 70))
        self.assertEqual(self.objects()[note["handle"]]["text"]["string"], before_objects[note["handle"]]["text"]["string"])
        done = go("pull", yes=True)
        self.assertEqual((done["result"], done["exit_code"]), ("ok", 0), done["error"])
        self.assertEqual(self.objects()[note["handle"]]["text"]["string"], "Edited on the website.")
        self.assertTrue(done["backup"] and os.path.exists(done["backup"]))
        con = S.sqlite_ro(done["backup"])
        try:
            self.assertEqual(con.execute("PRAGMA integrity_check").fetchone()[0], "ok")
        finally:
            con.close()
        again = go("pull", yes=True)
        self.assertEqual(again["counts"]["pulled"], {"create": 0, "update": 0, "delete": 0})
        self.assertTrue(self.integrity_ok())

    def test_the_editors_window_check_is_false_without_a_window_manager(self):
        def run(db, DbTxn):
            return self.tool.GrampsTree(db).editors_open()

        self.assertFalse(self.edit(run))


def faults_hit(faults_module, step):
    return faults_module.Faults({"HFY_SYNC_TEST": "1", "HFY_SYNC_FAULT": step}).hit


if __name__ == "__main__":
    unittest.main()
