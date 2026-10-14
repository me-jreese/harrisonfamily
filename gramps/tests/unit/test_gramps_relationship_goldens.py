"""relationship-compiler (HFY-TSK-251): the Gramps-generated relationship goldens, verified without Gramps.
Standard library only.

`api/test/records/fixtures/gramps-relationships.golden.json` holds what Gramps 6.0.6 left in a synthetic tree after
the steps its own editors perform for a relationship. `scripts/records/check_relationship_goldens.py` re-derives what
the answers must satisfy (two-sided links, no cycles, the slot rule, append order, the stub shape), so CI and any
worker can trust the file without Gramps.app. Regenerating it needs Gramps: see
`scripts/records/gen-gramps-relationship-goldens.py` (and `--check`, which compares a fresh run byte for byte).

Run: python3 -m unittest discover gramps/tests/unit
"""

import copy
import hashlib
import json
import pathlib
import sys
import tempfile
import unittest

REPO = pathlib.Path(__file__).resolve().parents[3]
SCRIPTS = REPO / "scripts" / "records"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import check_relationship_goldens as chk  # noqa: E402

GOLDEN = REPO / "api" / "test" / "records" / "fixtures" / "gramps-relationships.golden.json"


def load():
    return json.loads(GOLDEN.read_text(encoding="utf-8"))


def scenario(doc, sid):
    return next(s for s in doc["scenarios"] if s["id"] == sid)


class RelationshipGoldens(unittest.TestCase):
    def test_committed_goldens_are_sound(self):
        self.assertEqual(chk.check(GOLDEN), [])

    def test_the_acceptance_cases_are_there(self):
        doc = load()
        tags = {t for s in doc["scenarios"] for t in s["tags"]}
        for t in ("reuse", "single-parent", "never-fill", "unknown-parent", "married", "divorced", "unlink", "stub", "already-recorded"):
            self.assertIn(t, tags)
        self.assertGreaterEqual(len(doc["scenarios"]), 30)

    def _tampered(self, mutate, rehash=True):
        doc = load()
        mutate(doc)
        if rehash:
            doc["sha256"] = hashlib.sha256(chk.canonical({"tree": doc["tree"], "scenarios": doc["scenarios"]}).encode("utf-8")).hexdigest()
        with tempfile.TemporaryDirectory() as d:
            p = pathlib.Path(d) / "g.json"
            p.write_text(json.dumps(doc), encoding="utf-8")
            return chk.check(p)

    def test_a_hand_edit_without_rehashing_is_caught(self):
        def m(doc):
            doc["scenarios"][0]["title"] += " "

        self.assertTrue(any("sha256" in p for p in self._tampered(m, rehash=False)))

    def test_a_one_sided_link_is_caught(self):
        def m(doc):
            sc = scenario(doc, "parents-001")
            sc["gramps"]["objects"]["Person:9a000000000000009012"]["parent_family_list"] = []

        self.assertTrue(any("not its child" not in p and "lacks it" in p for p in self._tampered(m)))

    def test_swapped_slots_are_caught(self):
        def m(doc):
            sc = scenario(doc, "parents-008")
            fam = next(o for k, o in sc["gramps"]["objects"].items() if k in sc["gramps"]["created"] and k.startswith("Family"))
            fam["father_handle"], fam["mother_handle"] = fam["mother_handle"], fam["father_handle"]

        self.assertTrue(any("slot rule" in p for p in self._tampered(m)))

    def test_selection_order_is_checked_for_two_men(self):
        def m(doc):
            sc = scenario(doc, "parents-011")
            fam = next(o for k, o in sc["gramps"]["objects"].items() if k in sc["gramps"]["created"] and k.startswith("Family"))
            fam["father_handle"], fam["mother_handle"] = fam["mother_handle"], fam["father_handle"]

        self.assertTrue(any("slot rule" in p for p in self._tampered(m)))

    def test_a_reordered_parent_family_list_is_caught(self):
        def m(doc):
            sc = scenario(doc, "parents-009")
            p = sc["gramps"]["objects"]["Person:9a000000000000009004"]
            p["parent_family_list"] = list(reversed(p["parent_family_list"]))

        self.assertTrue(any("did not grow by appending" in p for p in self._tampered(m)))

    def test_a_stub_with_an_id_is_caught(self):
        def m(doc):
            sc = scenario(doc, "parents-015")
            k = next(k for k in sc["gramps"]["created"] if k.startswith("Person"))
            sc["gramps"]["objects"][k]["gramps_id"] = "I8000"

        self.assertTrue(any("gramps_id" in p for p in self._tampered(m)))

    def test_a_wrong_sortval_is_caught_even_when_rehashed(self):
        def m(doc):
            sc = scenario(doc, "parents-015")
            k = next(k for k in sc["gramps"]["created"] if k.startswith("Event"))
            sc["gramps"]["objects"][k]["date"]["sortval"] += 1

        self.assertTrue(any("sortval" in p for p in self._tampered(m)))

    def test_a_wrong_relation_is_caught(self):
        def m(doc):
            sc = scenario(doc, "parents-010")
            fam = next(o for k, o in sc["gramps"]["objects"].items() if k in sc["gramps"]["created"] and k.startswith("Family"))
            fam["child_ref_list"][0]["mrel"]["value"] = 1

        self.assertTrue(any("relation" in p for p in self._tampered(m)))

    def test_an_unlink_that_removes_two_entries_is_caught(self):
        def m(doc):
            sc = scenario(doc, "unlink-001")
            sc["gramps"]["objects"]["Family:9b000000000000009001"]["child_ref_list"] = []

        self.assertTrue(any("exactly one" in p or "lacks it" in p or "not its child" in p for p in self._tampered(m)))

    def test_a_changed_already_recorded_scenario_is_caught(self):
        def m(doc):
            sc = scenario(doc, "parents-017")
            sc["gramps"]["touched"] = ["Person:9a000000000000009003"]
            sc["gramps"]["objects"]["Person:9a000000000000009003"] = copy.deepcopy(doc["tree"]["Person:9a000000000000009003"])

        self.assertTrue(any("already-recorded" in p or "did not change" in p for p in self._tampered(m)))

    def test_an_ancestry_cycle_is_caught(self):
        def person(h, fl, pfl):
            return {"_class": "Person", "handle": h, "family_list": fl, "parent_family_list": pfl, "event_ref_list": []}

        def family(h, father, kids):
            return {"_class": "Family", "handle": h, "father_handle": father, "mother_handle": None, "child_ref_list": [{"ref": c} for c in kids], "event_ref_list": []}

        tree = {
            "Person:a": person("a", ["f1"], ["f2"]),
            "Person:b": person("b", ["f2"], ["f1"]),
            "Family:f1": family("f1", "a", ["b"]),
            "Family:f2": family("f2", "b", ["a"]),
        }
        self.assertTrue(any("own ancestor" in p for p in chk.link_problems(tree, "t")))

    def test_a_parent_who_is_their_own_child_is_caught(self):
        def m(doc):
            sc = scenario(doc, "parents-008")
            fam = next(o for k, o in sc["gramps"]["objects"].items() if k in sc["gramps"]["created"] and k.startswith("Family"))
            fam["child_ref_list"].append({**fam["child_ref_list"][0], "ref": fam["father_handle"]})

        self.assertTrue(any("also its child" in p for p in self._tampered(m)))

    def test_too_few_scenarios_for_an_acceptance_case_is_caught(self):
        def m(doc):
            doc["scenarios"] = [s for s in doc["scenarios"] if "never-fill" not in s["tags"]]
            doc["counts"]["scenarios"] = len(doc["scenarios"])

        self.assertTrue(any("never-fill" in p for p in self._tampered(m)))


if __name__ == "__main__":
    unittest.main()
