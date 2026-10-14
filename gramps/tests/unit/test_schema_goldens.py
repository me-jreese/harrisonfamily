"""Stdlib-only tests of the Gramps schema goldens (HFY-TSK-231): no Gramps needed.

    python3 -m unittest discover gramps/tests/unit

Checks the committed gramps/schema files against their sha256 manifest and the recorded version
(Gramps 6.0.6, DB schema 21), the class and label-table inventory, that the synthetic fixture tree
validates, that mutated objects do not, and that the generator never opens a database. On a Mac
with the Gramps 6.0.6 bundle it also regenerates the files and fails if one byte differs.
"""
import copy
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
sys.path.insert(0, os.path.join(REPO, "gramps"))
from hfygramps import schema_check as sc  # noqa: E402

GEN = os.path.join(REPO, "gramps", "scripts", "gen-schema.py")
SCHEMA = sc.load(sc.STEM + ".schema.json")
LABELS = sc.load(sc.STEM + ".labels.json")


def fixture():
    with open(sc.JSONL, encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def first(cls):
    return next(o for o in fixture() if o["_class"] == cls)


class Goldens(unittest.TestCase):
    def test_sha256_manifest_matches(self):
        self.assertEqual(sc.verify_hashes(), [])

    def test_manifest_check_catches_a_changed_byte(self):
        with tempfile.TemporaryDirectory() as d:
            for n in os.listdir(sc.SCHEMA_DIR):
                shutil.copy(os.path.join(sc.SCHEMA_DIR, n), d)
            path = os.path.join(d, sc.STEM + ".labels.json")
            with open(path, "ab") as fh:
                fh.write(b" ")
            self.assertEqual(sc.verify_hashes(d), ["sha256 mismatch: " + sc.STEM + ".labels.json"])

    def test_records_gramps_version_and_db_schema(self):
        for doc in (SCHEMA, LABELS):
            self.assertEqual(doc["x-gramps"]["gramps_version"], "6.0.6")
            self.assertEqual(doc["x-gramps"]["db_schema"], 21)

    def test_all_27_classes(self):
        classes = SCHEMA["x-gramps"]["classes"]
        self.assertEqual(len(classes), 27)
        self.assertEqual(sorted(SCHEMA["$defs"]), classes)
        for cls in ("Person", "Family", "Event", "Place", "Source", "Citation", "Repository", "Media", "Note", "Tag",
                    "Name", "Surname", "Date", "EventRef", "ChildRef", "MediaRef", "PlaceRef", "RepoRef", "Url"):
            self.assertIn(cls, classes)
        self.assertEqual(len(SCHEMA["oneOf"]), 10)

    def test_every_object_schema_is_closed(self):
        def walk(node, path):
            if isinstance(node, dict):
                if node.get("type") == "object" and "properties" in node:
                    self.assertIs(node.get("additionalProperties"), False, path)
                    if "_class" in node["properties"]:
                        self.assertEqual(node.get("required"), ["_class"], path)
                for k, v in node.items():
                    walk(v, path + "/" + k)
            elif isinstance(node, list):
                for i, v in enumerate(node):
                    walk(v, "%s/%d" % (path, i))
        walk(SCHEMA["$defs"], "#/$defs")

    def test_label_tables(self):
        want = {"EventType": 47, "PlaceType": 22, "ChildRefType": 8, "FamilyRelType": 5, "EventRoleType": 20,
                "UrlType": 6, "AttributeType": 17, "NameType": 5, "NoteType": 29, "RepositoryType": 11,
                "SourceMediaType": 15, "NameOriginType": 14, "SrcAttributeType": 2}
        self.assertEqual({k: len(v["entries"]) for k, v in LABELS["tables"].items()}, want)
        by_value = {e["value"]: e["label"] for e in LABELS["tables"]["EventType"]["entries"]}
        self.assertEqual((by_value[0], by_value[-1]), ("Custom", "Unknown"))
        self.assertEqual(LABELS["tables"]["ChildRefType"]["custom"], 7)
        self.assertEqual({e["label"] for e in LABELS["tables"]["FamilyRelType"]["entries"]},
                         {"Married", "Unmarried", "Civil Union", "Unknown", "Custom"})
        for name, table in LABELS["tables"].items():
            values = [e["value"] for e in table["entries"]]
            self.assertEqual(len(set(values)), len(values), name)
            self.assertIn(table["custom"], values, name)

    def test_generator_opens_no_database(self):
        import ast
        with open(GEN, encoding="utf-8") as fh:
            tree = ast.parse(fh.read())
        names = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Name):
                names.add(node.id)
            elif isinstance(node, ast.Attribute):
                names.add(node.attr)
            elif isinstance(node, (ast.Import, ast.ImportFrom)):
                names.update(a.name.split(".")[-1] for a in node.names)
                if isinstance(node, ast.ImportFrom):
                    names.update((node.module or "").split("."))
        banned = {"sqlite3", "open_database", "make_database", "DbState", "import_xml", "ImportXml", "load", "connect",
                  "__import__", "eval", "exec", "importlib", "subprocess"}
        self.assertEqual(sorted(names & banned), [])
        self.assertIn("DbGeneric", names)  # imported only for its VERSION constant, never instantiated
        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                func = node.func
                called = func.id if isinstance(func, ast.Name) else getattr(func, "attr", None)
                self.assertNotEqual(called, "DbGeneric", "the generator must not instantiate DbGeneric")


class Fixture(unittest.TestCase):
    def test_stdlib_check_passes(self):
        r = subprocess.run([sys.executable, "-I", os.path.join(REPO, "gramps", "hfygramps", "schema_check.py")],
                           capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_every_fixture_object_validates_except_the_census_float_rects(self):
        count, invalid, problems = sc.check_fixture(SCHEMA)
        self.assertEqual(problems, [])
        self.assertEqual(sorted(invalid), sc.expected_invalid_ids())
        self.assertEqual(len(invalid), 1)
        self.assertGreater(count, 100)

    def test_enum_does_not_accept_bool_or_float_for_an_integer(self):
        node = {"enum": [1, 2]}
        self.assertEqual(sc.validate(1, node, {}), [])
        self.assertTrue(sc.validate(True, node, {}))
        self.assertTrue(sc.validate(1.0, node, {}))
        self.assertTrue(sc.validate(10.0, {"type": "integer"}, {}))

    def test_wrong_class_fails(self):
        person = copy.deepcopy(first("Person"))
        person["_class"] = "Family"
        self.assertTrue(sc.validate_object(person, SCHEMA))
        person["_class"] = "Nonsense"
        self.assertTrue(sc.validate_object(person, SCHEMA))
        nested = copy.deepcopy(first("Person"))
        nested["primary_name"]["_class"] = "Surname"
        self.assertTrue(sc.validate_object(nested, SCHEMA))

    def test_unknown_key_fails(self):
        person = copy.deepcopy(first("Person"))
        person["nickname_extra"] = "x"
        self.assertTrue(any("unknown key" in e for e in sc.validate_object(person, SCHEMA)))
        person = copy.deepcopy(first("Person"))
        person["primary_name"]["bogus"] = 1
        self.assertTrue(sc.validate_object(person, SCHEMA))

    def test_float_rect_fails_and_integer_rect_passes(self):
        person = next(o for o in fixture() if o["_class"] == "Person"
                      and any(r.get("rect") == [10, 10, 40, 40] for r in o["media_list"]))
        self.assertEqual(sc.validate_object(person, SCHEMA), [])
        mutated = copy.deepcopy(person)
        for ref in mutated["media_list"]:
            if ref.get("rect"):
                ref["rect"] = [10.5, 10, 40, 40]
        self.assertTrue(any("/rect" in e for e in sc.validate_object(mutated, SCHEMA)))

    def test_census_rect_float_matches_the_objects_that_carry_a_float_rect(self):
        floats = [o["gramps_id"] for o in fixture()
                  if any(isinstance(c, float) for r in o.get("media_list", []) if r.get("rect") for c in r["rect"])]
        self.assertEqual(sorted(floats), sc.expected_invalid_ids())


APP = os.environ.get("HFY_GRAMPS_APP", "/Applications/Gramps.app")


def _bundle_is_606():
    try:
        with open(os.path.join(APP, "Contents", "Info.plist"), "rb") as fh:
            return b"Gramps-6.0.6" in fh.read()
    except OSError:
        return False


@unittest.skipUnless(sys.platform == "darwin" and _bundle_is_606() and not os.environ.get("HFY_SKIP_REGEN"),
                     "regeneration only runs on a Mac with the Gramps 6.0.6 bundle (io-mac-gramps)")
class Reproducible(unittest.TestCase):
    def test_regenerated_output_is_byte_identical(self):
        home = tempfile.mkdtemp(prefix="hfy-schema-regen-")
        try:
            log = os.path.join(home, "audit.log")
            real = os.path.expanduser("~")
            forbid = ":".join(os.path.join(real, p) for p in ("Library/Application Support/gramps", ".gramps", "Pictures"))
            env = dict(os.environ, HOME=home, GRAMPSHOME=home, HFY_SHIM_FORBID=forbid, HFY_SHIM_AUDIT_LOG=log)
            shim = os.path.join(REPO, "gramps", "tests", "gramps", "gramps-shim.sh")
            r = subprocess.run([shim, "--script", GEN, "--check"], capture_output=True, text=True, env=env, timeout=300)
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            with open(log, encoding="utf-8") as fh:
                self.assertNotIn("VIOLATION", fh.read())
        finally:
            shutil.rmtree(home, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
