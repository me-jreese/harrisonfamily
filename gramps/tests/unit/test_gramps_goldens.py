"""edit-gramps-semantics (HFY-TSK-249): the Gramps-generated goldens, verified without Gramps. Standard library only.

`api/test/records/fixtures/gramps-semantics.golden.json` holds what Gramps 6.0.6 computed for synthetic dates and
synthetic birth/death scenarios. `scripts/records/check_gramps_goldens.py` re-derives them independently, so CI and any
worker can trust the file without Gramps.app. Regenerating it needs Gramps: see
`scripts/records/gen-gramps-semantics-goldens.py` (and `--check`, which compares a fresh run byte for byte).

Run: python3 -m unittest discover gramps/tests/unit
"""

import json
import pathlib
import sys
import tempfile
import unittest

REPO = pathlib.Path(__file__).resolve().parents[3]
SCRIPTS = REPO / "scripts" / "records"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import check_gramps_goldens as chk  # noqa: E402

GOLDEN = REPO / "api" / "test" / "records" / "fixtures" / "gramps-semantics.golden.json"


class GrampsGoldens(unittest.TestCase):
    def test_committed_goldens_are_sound(self):
        self.assertEqual(chk.check(GOLDEN), [])

    def test_at_least_200_gregorian_and_julian_dates(self):
        doc = json.loads(GOLDEN.read_text(encoding="utf-8"))
        n = sum(1 for c in doc["dates"] if c["gramps"]["valid"] and c["date"]["calendar"] in (0, 1))
        self.assertGreaterEqual(n, 200)

    def _tampered(self, mutate, rehash=True):
        doc = json.loads(GOLDEN.read_text(encoding="utf-8"))
        mutate(doc)
        if rehash:
            doc["sha256"] = chk.hashlib.sha256(
                chk.canonical({"dates": doc["dates"], "birth_death": doc["birth_death"]}).encode("utf-8")
            ).hexdigest()
        with tempfile.TemporaryDirectory() as d:
            p = pathlib.Path(d) / "g.json"
            p.write_text(json.dumps(doc), encoding="utf-8")
            return chk.check(p)

    def test_a_hand_edit_without_rehashing_is_caught(self):
        def m(doc):
            doc["dates"][0]["gramps"]["sortval"] += 1

        self.assertTrue(any("sha256" in p for p in self._tampered(m, rehash=False)))

    def test_a_wrong_sortval_is_caught_even_when_rehashed(self):
        def m(doc):
            c = next(x for x in doc["dates"] if x["gramps"]["valid"] and x["date"]["calendar"] == 0)
            c["gramps"]["sortval"] += 1

        self.assertTrue(any("sortval" in p for p in self._tampered(m)))

    def test_a_wrong_valid_flag_is_caught(self):
        def m(doc):
            c = next(x for x in doc["dates"] if "day-beyond-month" in x["tags"])
            c["gramps"] = {"valid": True, "sortval": 1, "calendar": 0}

        self.assertTrue(any("valid" in p for p in self._tampered(m)))

    def test_a_wrong_birth_death_index_is_caught(self):
        def m(doc):
            c = next(x for x in doc["birth_death"] if x["kind"] == "state" and x["after"]["gramps"]["birth_ref_index"] != -1)
            c["after"]["gramps"]["birth_ref_index"] = -1

        self.assertTrue(any("indexes" in p for p in self._tampered(m)))

    def test_too_few_dates_is_caught(self):
        def m(doc):
            doc["dates"] = doc["dates"][:100]
            doc["counts"]["dates"] = 100

        self.assertTrue(any("200" in p for p in self._tampered(m)))


if __name__ == "__main__":
    unittest.main()
