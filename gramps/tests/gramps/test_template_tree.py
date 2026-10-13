"""Gramps-integration self-test for the fixture import and the per-test copy (HFY-TSK-228).

Run by run.sh inside the bundled Python, once per test file, against a private copy of the
template tree (env HFY_TREE_NAME names the copy). Most checks need only sqlite3; the ones that open
the copy with the Gramps API skip outside the bundle.
"""
import hashlib
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.abspath(os.path.join(HERE, "..", "fixtures"))
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

    def test_every_object_equals_its_jsonl_line(self):
        """Every object in the tree equals its JSONL line, field for field, the two rect cases included.

        The XML format drops the 0,0,100,100 rect and floors the float rect (fixture_trees._xml_rect),
        exactly on two objects; run.sh's prepare_template.py puts both back after the import.
        """
        got = ft.json_objects(self.dir)
        lossy = [o["gramps_id"] for o in self.jsonl if ft.expected_after_xml_import(o) != o]
        self.assertEqual(len(lossy), 2, "exactly the full-frame-rect and float-rect persons lose data in XML")
        for o in self.jsonl:
            key = (o["_class"].lower(), o["handle"])
            self.assertEqual(got.get(key), o, "%s %s" % (o["_class"], o.get("gramps_id") or o.get("name")))

    def test_every_census_case_is_in_the_tree(self):
        """The census of the tree itself, not of the JSONL: the Gramps lane holds every case."""
        result = census.run_census(list(ft.json_objects(self.dir).values()))
        self.assertEqual(census.missing(result), [])
        self.assertTrue(result["rect_full_frame_0_0_100_100"])
        self.assertTrue(result["rect_float"])

    def test_media_resolve_to_the_committed_fixture_files(self):
        """The media path is the fixtures directory; each Media object reads its own committed bytes."""
        try:
            from gramps.gen.db.dbconst import DBMODE_R
            from gramps.gen.db.utils import make_database
            from gramps.gen.utils.file import media_path_full
        except ImportError:
            self.skipTest("needs the bundled Gramps")
        forbid = [p for p in os.environ.get("HFY_SHIM_FORBID", "").split(":") if p]
        self.assertTrue(any(p.endswith("/Pictures") for p in forbid), "run.sh must forbid the real Pictures folder")
        db = make_database("sqlite")
        db.load(self.dir, None, DBMODE_R)
        data = {}
        try:
            self.assertEqual(os.path.realpath(db.get_mediapath() or ""), os.path.realpath(FIXTURES))
            n = 0
            for m in db.iter_media():
                n += 1
                full = media_path_full(db, m.get_path())
                self.assertTrue(_under(full, os.path.join(FIXTURES, "media")), m.get_gramps_id())
                for p in forbid:
                    self.assertFalse(_under(full, p), m.get_gramps_id())
                with open(full, "rb") as fh:
                    data[m.get_gramps_id()] = (os.path.basename(full), fh.read())
                self.assertEqual(hashlib.md5(data[m.get_gramps_id()][1]).hexdigest(), m.get_checksum(),
                                 m.get_gramps_id())
            self.assertEqual(n, sum(o["_class"] == "Media" for o in self.jsonl))
        finally:
            db.close()
        by_name = dict(data.values())
        self.assertEqual(by_name["synthetic-placeholder.jpg"], b"")
        self.assertTrue(by_name["synthetic-birth-certificate.pdf"].startswith(b"%PDF-"))
        self.assertTrue(by_name["synthetic-photo-gps.jpg"].startswith(b"\xff\xd8"))
        self.assertIn(b"Exif", by_name["synthetic-photo-gps.jpg"])
        # Every Media object has bytes of its own, so tests can tell them apart.
        self.assertEqual(len({hashlib.md5(b).hexdigest() for _, b in data.values()}), len(data))

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
