"""Canonical JSON and object hashes (task projection-py): gramps/hfygramps/canonical.py against shared/canonical.vectors.json.

The vectors are shared with shared/canonical.mjs (shared/canonical.test.mjs runs them in JavaScript). Here they run in Python, and
when ``node`` is installed the JavaScript module is run too, on the vectors and on every projected object of the synthetic tree,
so a byte difference between the two implementations fails this suite as well as the JavaScript one.

    python3 -m unittest discover gramps/tests/unit
"""
import hashlib
import json
import math
import os
import shutil
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
sys.path.insert(0, os.path.join(REPO, "gramps"))
sys.path.insert(0, os.path.join(REPO, "gramps", "tests", "fixtures"))
sys.path.insert(0, os.path.join(REPO, "gramps", "redaction"))

from hfygramps import canonical as C  # noqa: E402
from hfygramps import projection as P  # noqa: E402
import census  # noqa: E402

VECTORS = os.path.join(REPO, "shared", "canonical.vectors.json")
MODULE = os.path.join(REPO, "shared", "canonical.mjs")
FIXTURE = os.path.join(REPO, "gramps", "tests", "fixtures", "synthetic-tree.jsonl")

NODE = shutil.which("node")


def vectors():
    with open(VECTORS, encoding="utf-8") as fh:
        doc = json.load(fh)
    assert doc["format"] == "canonical-json-v1"
    return doc["vectors"]


class SharedVectors(unittest.TestCase):
    def test_enough_vectors_with_unique_ids(self):
        v = vectors()
        self.assertGreaterEqual(len(v), 30)
        self.assertEqual(len({x["id"] for x in v}), len(v))

    def test_every_vector_matches_in_text_bytes_and_sha256(self):
        for v in vectors():
            with self.subTest(v["id"]):
                if v["stored"]:
                    text, digest = C.object_json(v["value"]), C.object_hash(v["value"])
                else:
                    text, digest = C.canonical_json(v["value"]), C.sha256_hex(v["value"])
                self.assertEqual(text, v["canonical"])
                self.assertEqual(digest, v["sha256"])
                self.assertEqual(digest, hashlib.sha256(v["canonical"].encode("utf-8")).hexdigest())
                if not v["stored"]:
                    self.assertEqual(C.canonical_bytes(v["value"]), v["canonical"].encode("utf-8"))

    def test_the_vectors_are_what_the_generator_writes(self):
        r = subprocess.run([sys.executable, os.path.join(REPO, "gramps", "redaction", "make_canonical_vectors.py"), "--check"],
                           capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_the_vectors_cover_the_edges_that_differ_between_languages(self):
        ids = {v["id"] for v in vectors()}
        for must in ("order.astral_after_bmp", "order.astral_pair", "escape.control", "escape.line_separators", "scalar.max_safe",
                     "scalar.min_safe", "unicode.combining", "object.drops_change", "object.nested_change_kept"):
            self.assertIn(must, ids)

    def test_a_negative_control_notices_a_changed_vector(self):
        v = next(x for x in vectors() if x["id"] == "order.astral_after_bmp")
        by_utf16 = sorted(v["value"], key=lambda k: k.encode("utf-16-be"))
        self.assertNotEqual(by_utf16, sorted(v["value"]), "the vector tells code point order from UTF-16 order")
        wrong = json.dumps({k: v["value"][k] for k in by_utf16}, separators=(",", ":"), ensure_ascii=False)
        self.assertNotEqual(wrong, v["canonical"])
        self.assertEqual(C.canonical_json({"b": 1, "a": 2}), '{"a":2,"b":1}')


class Behaviour(unittest.TestCase):
    def test_it_is_json_dumps_with_sorted_keys_and_compact_separators(self):
        value = {"b": [1, {"d": None, "c": True}], "a": "é名", "": 0}
        self.assertEqual(C.canonical_json(value), json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False))

    def test_tuples_are_arrays_and_booleans_are_not_integers(self):
        self.assertEqual(C.canonical_json((1, True, False, 0)), "[1,true,false,0]")

    def test_floats_nan_infinity_and_huge_integers_are_refused(self):
        for bad in (1.5, 1.0, float("nan"), float("inf"), -math.inf, 2 ** 53, -(2 ** 53), 10 ** 30, [1, 2.5], {"a": {"b": [0.1]}}):
            with self.subTest(bad), self.assertRaises(C.CanonicalError):
                C.canonical_json(bad)
        self.assertEqual(C.canonical_json(2 ** 53 - 1), "9007199254740991")

    def test_lone_surrogates_non_string_keys_and_unsupported_types_are_refused(self):
        for bad in ("\ud800", "a\udfffb", {"\ud800": 1}, {1: "a"}, {None: 1}, {("a",): 1}, b"x", {1, 2}, object(), {"a": b"x"}):
            with self.subTest(repr(bad)), self.assertRaises(C.CanonicalError):
                C.canonical_json(bad)
        self.assertEqual(C.canonical_json("😀".encode("utf-16", "surrogatepass").decode("utf-16")), '"\U0001f600"')

    def test_the_error_is_a_value_error_and_never_echoes_the_value(self):
        with self.assertRaises(ValueError) as cm:
            C.canonical_json({"secret": 1.5})
        self.assertNotIn("secret", str(cm.exception))
        self.assertNotIn("1.5", str(cm.exception))

    def test_deep_nesting_is_refused_rather_than_overflowing(self):
        v = []
        for _ in range(300):
            v = [v]
        with self.assertRaises(C.CanonicalError):
            C.canonical_json(v)

    def test_stored_form_drops_only_the_top_level_change_key(self):
        obj = {"_class": "Note", "change": 5, "handle": "n1", "text": {"change": 9, "string": "x"}}
        self.assertEqual(C.stored_form(obj), {"_class": "Note", "handle": "n1", "text": {"change": 9, "string": "x"}})
        self.assertIn("change", obj, "the input is not changed")
        self.assertEqual(C.object_hash({"a": 1}), C.object_hash({"a": 1, "change": 99}))
        self.assertNotEqual(C.object_hash({"a": 1}), C.object_hash({"a": 2}))

    def test_equal_objects_give_equal_bytes_whatever_the_insertion_order(self):
        a = {"x": 1, "y": {"p": 1, "q": 2}}
        b = {"y": {"q": 2, "p": 1}, "x": 1}
        self.assertEqual(C.canonical_bytes(a), C.canonical_bytes(b))
        self.assertEqual(C.sha256_hex(a), C.sha256_hex(b))

    def test_a_projected_synthetic_tree_has_a_canonical_form(self):
        objs = census.load_jsonl(FIXTURE)
        files = {m["handle"]: {"exif_gps": m["path"].endswith("gps.jpg"), "readable": False} for m in objs if m["_class"] == "Media"}
        projected, _ = P.project_tree(objs, files=files)
        got = [o for o in projected.values() if o is not None]
        self.assertGreater(len(got), 50)
        for o in got:
            self.assertNotIn('"change"', C.object_json(o))
            self.assertEqual(json.loads(C.object_json(o)), o)
            self.assertEqual(len(C.object_hash(o)), 64)


@unittest.skipUnless(NODE, "node is not installed")
class JavaScriptParity(unittest.TestCase):
    SCRIPT = """
import { canonicalJson, canonicalSha256, objectJson, objectHash } from %(module)s;
const items = JSON.parse(await new Response(process.stdin).text());
const out = [];
for (const it of items) {
  const text = it.stored ? objectJson(it.value) : canonicalJson(it.value);
  const hash = it.stored ? await objectHash(it.value) : await canonicalSha256(it.value);
  out.push([text, hash]);
}
process.stdout.write(JSON.stringify(out));
"""

    def run_node(self, items):
        script = self.SCRIPT % {"module": json.dumps("file://" + MODULE)}
        r = subprocess.run([NODE, "--input-type=module", "-e", script], input=json.dumps(items), capture_output=True, text=True,
                           encoding="utf-8")
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout)

    def test_node_and_python_write_the_same_bytes_for_every_vector(self):
        items = [{"value": v["value"], "stored": v["stored"]} for v in vectors()]
        for v, (text, digest) in zip(vectors(), self.run_node(items)):
            with self.subTest(v["id"]):
                self.assertEqual(text, v["canonical"])
                self.assertEqual(digest, v["sha256"])

    def test_node_and_python_agree_on_every_projected_object_of_the_synthetic_tree(self):
        objs = census.load_jsonl(FIXTURE)
        files = {m["handle"]: {"exif_gps": m["path"].endswith("gps.jpg"), "readable": False} for m in objs if m["_class"] == "Media"}
        projected, _ = P.project_tree(objs, files=files)
        got = [o for o in projected.values() if o is not None]
        got += [dict(o, change=1700000000) for o in got[:5]]
        theirs = self.run_node([{"value": o, "stored": True} for o in got])
        for o, (text, digest) in zip(got, theirs):
            self.assertEqual(text, C.object_json(o), o["handle"])
            self.assertEqual(digest, C.object_hash(o), o["handle"])

    def test_node_and_python_agree_on_generated_unicode_and_key_orders(self):
        pieces = ["a", "Z", "_", "0", "é", "中", "", "￿", "\U00010000", "\U0001f600", " ", "\x00", "\x1f", "\x7f", '"', "\\", "/"]
        values = []
        for i, a in enumerate(pieces):
            for b in pieces[i:]:
                values.append({a + b: 1, b + a: 2, a: [b, {b: a}], "": None})
        theirs = self.run_node([{"value": v, "stored": False} for v in values])
        for v, (text, digest) in zip(values, theirs):
            self.assertEqual(text, C.canonical_json(v))
            self.assertEqual(digest, C.sha256_hex(v))


if __name__ == "__main__":
    unittest.main()
