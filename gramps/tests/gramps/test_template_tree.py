"""Gramps-integration self-test for the fixture import and the per-test copy (HFY-TSK-228).

Run by run.sh inside the bundled Python, once per test file, against a private copy of the
template tree (env HFY_TREE_NAME names the copy). Most checks need only sqlite3; the one that opens
the copy with the Gramps API skips outside the bundle.
"""
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


def _under(path, root):
    path, root = os.path.realpath(path), os.path.realpath(root)
    return path == root or path.startswith(root.rstrip("/") + "/")


@unittest.skipUnless(GRAMPSHOME and TREE, "run through gramps/tests/gramps/run.sh")
class ImportedTreeCopy(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = ft.find_tree(GRAMPSHOME, TREE)
        if cls.dir is None:
            raise AssertionError("copy tree %s missing" % TREE)
        cls.jsonl = census.load_jsonl(os.path.join(FIXTURES, "synthetic-tree.jsonl"))

    def test_runs_in_throwaway_home(self):
        self.assertTrue(_under(self.dir, GRAMPSHOME))
        self.assertNotIn("Application Support", os.path.realpath(self.dir))

    def test_gramps_database_path_is_the_throwaway_one(self):
        """Gramps itself looks for trees under the temporary GRAMPSHOME, never the real grampsdb."""
        try:
            from gramps.gen.config import config
            from gramps.gen.const import USER_DATA
        except ImportError:
            self.skipTest("needs the bundled Gramps")
        self.assertTrue(_under(USER_DATA, GRAMPSHOME), USER_DATA)
        self.assertTrue(_under(config.get("database.path"), GRAMPSHOME), config.get("database.path"))
        forbid = [p for p in os.environ.get("HFY_SHIM_FORBID", "").split(":") if p]
        self.assertTrue(any(p.endswith("/Library/Application Support/gramps") for p in forbid),
                        "run.sh must forbid the real Gramps folder")
        for p in forbid:
            self.assertFalse(_under(config.get("database.path"), p))

    def test_import_matches_jsonl(self):
        want = {(o["_class"].lower(), o["handle"], o.get("gramps_id", "")) for o in self.jsonl}
        self.assertEqual(ft.identities(self.dir), want)

    def test_counts(self):
        per_class = {}
        for o in self.jsonl:
            per_class[o["_class"].lower()] = per_class.get(o["_class"].lower(), 0) + 1
        self.assertEqual(ft.counts(self.dir), {t: per_class.get(t, 0) for t in ft.TABLES})

    def test_imported_objects_equal_the_jsonl_up_to_the_documented_rect_loss(self):
        """Every object the CLI imported from the XML equals its JSONL line, field for field.

        The one difference allowed is the XML format's MediaRef rect loss (fixture_trees._xml_rect):
        the 0,0,100,100 rect comes back as None and the float rect is floored. Both must show up, so
        the JSONL-only cases stay documented.
        """
        got = ft.json_objects(self.dir)
        changed = 0
        for o in self.jsonl:
            key = (o["_class"].lower(), o["handle"])
            want = ft.expected_after_xml_import(o)
            changed += want != o
            self.assertEqual(got.get(key), want, "%s %s" % (o["_class"], o.get("gramps_id") or o.get("name")))
        self.assertEqual(changed, 2, "exactly the full-frame-rect and float-rect persons lose data in XML")

    def test_copy_opens_with_the_gramps_api(self):
        try:
            from gramps.gen.db.dbconst import DBMODE_R
            from gramps.gen.db.utils import make_database
        except ImportError:
            self.skipTest("needs the bundled Gramps")
        persons = [o for o in self.jsonl if o["_class"] == "Person"]
        db = make_database("sqlite")
        db.load(self.dir, None, DBMODE_R)
        try:
            self.assertEqual(db.get_number_of_people(), len(persons))
            for o in persons:
                p = db.get_person_from_gramps_id(o["gramps_id"])
                self.assertIsNotNone(p, o["gramps_id"])
                self.assertEqual(p.handle, o["handle"])
                self.assertEqual(p.get_privacy(), o["private"])
        finally:
            db.close()

    def test_mutating_a_copy_does_not_touch_the_template_or_this_file_copy(self):
        # A per-method copy (fixture_trees.fresh_copy), so the other tests here keep an intact tree.
        import sqlite3
        scratch = ft.fresh_copy(self, GRAMPSHOME)
        self.assertNotEqual(os.path.realpath(scratch), os.path.realpath(self.dir))
        con = sqlite3.connect(os.path.join(scratch, "sqlite.db"))
        con.execute("DELETE FROM person")
        con.commit()
        con.close()
        self.assertEqual(ft.counts(scratch)["person"], 0)
        persons = sum(o["_class"] == "Person" for o in self.jsonl)
        self.assertEqual(ft.counts(ft.find_tree(GRAMPSHOME, ft.TEMPLATE))["person"], persons)
        self.assertEqual(ft.counts(self.dir)["person"], persons)
        # run.sh also compares the template's digest before and after every test file.


if __name__ == "__main__":
    unittest.main()
