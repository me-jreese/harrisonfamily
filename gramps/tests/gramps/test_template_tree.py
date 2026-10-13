"""Gramps-integration self-test for the fixture import and the per-test copy (HFY-TSK-228).

Run by run.sh inside the bundled Python, once per test file, against a private copy of the
template tree (env HFY_TREE_NAME names the copy). It needs no Gramps API, only sqlite3, so it also
runs under a plain Python 3.12 if the env is set by hand.
"""
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, "..", "fixtures")
sys.path.insert(0, HERE)
sys.path.insert(0, FIXTURES)
import census  # noqa: E402
import fixture_trees as ft  # noqa: E402

GRAMPSHOME = os.environ.get("GRAMPSHOME", "")
TREE = os.environ.get("HFY_TREE_NAME", "")


@unittest.skipUnless(GRAMPSHOME and TREE, "run through gramps/tests/gramps/run.sh")
class ImportedTreeCopy(unittest.TestCase):
    def setUp(self):
        self.dir = ft.find_tree(GRAMPSHOME, TREE)
        self.assertIsNotNone(self.dir, "copy tree %s missing" % TREE)

    def test_runs_in_throwaway_home(self):
        self.assertTrue(os.path.realpath(self.dir).startswith(os.path.realpath(GRAMPSHOME)))
        self.assertNotIn("Application Support", os.path.realpath(self.dir))

    def test_import_matches_jsonl(self):
        objs = census.load_jsonl(os.path.join(FIXTURES, "synthetic-tree.jsonl"))
        want = {(o["_class"].lower(), o["handle"], o.get("gramps_id", "")) for o in objs}
        self.assertEqual(ft.identities(self.dir), want)

    def test_counts(self):
        objs = census.load_jsonl(os.path.join(FIXTURES, "synthetic-tree.jsonl"))
        per_class = {}
        for o in objs:
            per_class[o["_class"].lower()] = per_class.get(o["_class"].lower(), 0) + 1
        self.assertEqual(ft.counts(self.dir), {t: per_class.get(t, 0) for t in ft.TABLES})

    def test_mutating_the_copy_does_not_touch_the_template(self):
        import sqlite3
        con = sqlite3.connect(os.path.join(self.dir, "sqlite.db"))
        con.execute("DELETE FROM person")
        con.commit()
        con.close()
        self.assertEqual(ft.counts(self.dir)["person"], 0)
        # run.sh checks the template's digest after the copy test; see its final assertion.


if __name__ == "__main__":
    unittest.main()
