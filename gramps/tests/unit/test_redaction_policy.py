"""Redaction policy v1 (task redaction-policy-v1): the rule file, its schema, the golden vectors and the generated reference page.

Nothing here imports Gramps, so any worker or CI job can run it:

    python3 -m unittest discover gramps/tests/unit

It checks that gramps/redaction/redaction-v1.json validates against its own JSON Schema; that it encodes the rules the design
fixes (sync.md section 5 as amended by BRD2 section 11.1); that the one isBirthLike predicate answers for every type, for
deceased people, RANGE/SPAN, TEXTONLY, custom types and birth_ref fallbacks; that at least 90 golden vectors cover every rule
id and agree with the reference oracle (projection, holds, server verdict, idempotence, and the projection passing the server);
that the vectors and docs/reference/redaction-policy.md are exactly what their generators write; and that the section 5.6
invariants hold on the whole synthetic fixture tree. Negative controls prove the vectors notice a changed rule.
"""
import copy
import datetime
import glob
import json
import os
import re
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(REPO, "gramps"))
sys.path.insert(0, os.path.join(REPO, "gramps", "redaction"))

import jsonschema_lite  # noqa: E402
import redaction_oracle as O  # noqa: E402
from hfygramps import rules as R  # noqa: E402
from hfygramps import scanner  # noqa: E402
from test_synthetic_fixture import fictional_violations  # noqa: E402
import census  # noqa: E402
import render_reference  # noqa: E402

RED = os.path.join(REPO, "gramps", "redaction")
POLICY_FILE = os.path.join(RED, "redaction-v1.json")
SCHEMA_FILE = os.path.join(RED, "redaction-v1.schema.json")
PAGE = os.path.join(REPO, "docs", "reference", "redaction-policy.md")
FIXTURE = os.path.join(REPO, "gramps", "tests", "fixtures", "synthetic-tree.jsonl")

ACTIONS = {"exclude_object", "filter_element", "local_only", "reduce_date", "repoint_place", "round_coordinates", "hold_media", "scan"}


def load(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def policy():
    return copy.deepcopy(load(POLICY_FILE))


def all_vectors():
    out = []
    for path in sorted(glob.glob(os.path.join(RED, "vectors", "*.json"))):
        doc = load(path)
        for v in doc["vectors"]:
            v["_group"] = doc["group"]
            out.append(v)
    return out


def diff(a, b, path=""):
    if isinstance(a, dict) and isinstance(b, dict):
        out = []
        for k in sorted(set(a) | set(b)):
            out += diff(a.get(k, "<missing>"), b.get(k, "<missing>"), path + "/" + k)
        return out
    return [] if a == b else ["%s: got %r want %r" % (path, a, b)]


class PolicySchema(unittest.TestCase):
    def test_policy_validates_against_its_own_schema(self):
        self.assertEqual(jsonschema_lite.validate(load(POLICY_FILE), load(SCHEMA_FILE)), [])

    def test_the_policy_names_its_schema(self):
        self.assertEqual(load(POLICY_FILE)["$schema"], "./" + os.path.basename(SCHEMA_FILE))
        self.assertTrue(os.path.exists(SCHEMA_FILE))

    def test_negative_controls_the_schema_rejects_broken_policies(self):
        schema = load(SCHEMA_FILE)

        def broken(mutate):
            p = policy()
            mutate(p)
            return jsonschema_lite.validate(p, schema)

        self.assertTrue(broken(lambda p: p["rules"][0].update(action="rewrite")))
        self.assertTrue(broken(lambda p: p["rules"][0].update(id="Bad Id")))
        self.assertTrue(broken(lambda p: p["rules"][0].update(phase="later")))
        self.assertTrue(broken(lambda p: p["rules"][0].update(server="maybe")))
        self.assertTrue(broken(lambda p: p["rules"][0].pop("path")))
        self.assertTrue(broken(lambda p: p["rules"][0].update(path="no-slash")))
        self.assertTrue(broken(lambda p: p["rules"][0].update(surprise=1)))
        self.assertTrue(broken(lambda p: p.pop("birthLike")))
        self.assertTrue(broken(lambda p: p["birthLike"].update(birthRefIndex=False)))
        self.assertTrue(broken(lambda p: p["birthLike"]["eventTypes"].append({"value": "x", "name": "y"})))
        self.assertTrue(broken(lambda p: p["places"].update(coordinateDecimals=2.5)))
        self.assertTrue(broken(lambda p: p.update(policy="redaction-v2")))
        self.assertTrue(broken(lambda p: p.update(extra=True)))
        self.assertTrue(broken(lambda p: p["rules"].clear()))
        self.assertTrue(broken(lambda p: p["scan"]["kinds"].append("phone")))  # not unique

    def test_the_validator_refuses_keywords_it_does_not_implement(self):
        with self.assertRaises(ValueError):
            jsonschema_lite.validate({}, {"type": "object", "oneOf": []})


class PolicyContent(unittest.TestCase):
    def setUp(self):
        self.p = load(POLICY_FILE)
        self.rules = {r["id"]: r for r in self.p["rules"]}

    def test_rule_ids_are_unique_and_every_rule_has_a_known_phase_and_action(self):
        ids = [r["id"] for r in self.p["rules"]]
        self.assertEqual(len(ids), len(set(ids)))
        phases = {ph["id"] for ph in self.p["phases"]}
        self.assertEqual({r["phase"] for r in self.p["rules"]} - phases, set())
        self.assertEqual({r["action"] for r in self.p["rules"]} - ACTIONS, set())

    def test_all_eight_actions_are_used(self):
        self.assertEqual({r["action"] for r in self.p["rules"]}, ACTIONS)

    def test_phase_orders_are_a_sequence(self):
        self.assertEqual(sorted(ph["order"] for ph in self.p["phases"]), list(range(1, len(self.p["phases"]) + 1)))

    def test_birth_like_list(self):
        bl = self.p["birthLike"]
        self.assertEqual({t["value"]: t["name"] for t in bl["eventTypes"]},
                         {12: "Birth", 14: "Adult Christening", 15: "Baptism", 18: "Bless", 22: "Christen", 45: "Stillbirth"})
        self.assertEqual(bl["customType"], {"value": 0, "pattern": "birth|bapt|christen|naissance|geburt|nacimiento", "flags": "i"})
        self.assertTrue(bl["birthRefIndex"])
        self.assertIn("deceased", bl["appliesTo"])

    def test_day_and_month_mean_indexes_0_1_4_5(self):
        self.assertEqual(self.p["dates"]["dayMonthIndexes"], [0, 1, 4, 5])

    def test_the_rules_added_by_the_review_are_present(self):
        for rid in ("birth.citation.date", "birth.name.date", "media.birth_linked.hold", "media.pdf.hold", "private.orphan.exclude",
                    "place.exclude.type", "place.exclude.custom_home_like", "place.code.local_only", "place.coordinates.round",
                    "birth.dob_exact.date", "birth.sticky", "scan.dob_exact", "media.exif_gps.hold"):
            self.assertIn(rid, self.rules)
        places = self.p["places"]
        self.assertEqual({t["value"] for t in places["excludedTypes"]}, {7, 18, 19, 20})
        self.assertEqual(places["customHomeLike"]["pattern"], "house|home|residence|address|apartment|apt|lot|farm")
        self.assertEqual(places["customHomeLike"]["flags"], "i")
        self.assertEqual({t["name"]: t["value"] for t in places["administrativeTypes"]},
                         {"Country": 1, "State": 2, "County": 3, "Province": 8, "Region": 9, "Department": 10})
        self.assertEqual(places["coordinateDecimals"], 2)
        self.assertEqual(self.rules["private.orphan.exclude"]["params"]["exempt"], ["Place", "Source", "Repository"])
        self.assertEqual(set(self.rules["private.orphan.exclude"]["objectClass"]), {"Event", "Note", "Media", "Citation", "Family"})
        self.assertEqual(self.p["media"]["heldMime"], ["application/pdf"])

    def test_every_section_5_item_has_a_rule(self):
        want = {
            "5.1 private object": "private.object.exclude", "5.1 primary name": "private.name.hold_person",
            "5.1 elements": "private.element.reporef_list", "5.1 references": "private.reference.handle_lists",
            "5.2 dates": "birth.date.daymonth", "5.2 attributes": "birth.attribute.age_time", "5.2 LDS": "birth.lds_ord",
            "5.2 exact": "birth.dob_exact.date", "5.3 address": "contact.address_list", "5.3 url": "contact.url.channel",
            "5.3 alt_loc": "contact.alt_loc.fields", "5.3 places": "place.exclude.type", "5.3 ssn": "contact.attribute.government_id",
            "5.3 researcher": "contact.researcher", "5.4 scan": "scan.phone", "5.5 path": "media.path.local_only",
            "5.5 checksum": "media.checksum.derive", "5.5 rect": "media.rect.full_frame",
        }
        for label, rid in want.items():
            self.assertIn(rid, self.rules, label)

    def test_scan_rules_name_known_kinds_and_the_fields_table(self):
        s = self.p["scan"]
        known = set(s["kinds"]) | set(s["desktopOnlyKinds"])
        scan_rules = [r for r in self.p["rules"] if r["action"] == "scan"]
        self.assertEqual({r["params"]["kind"] for r in scan_rules}, known)
        for r in scan_rules:
            self.assertEqual(r["id"], "scan." + r["params"]["kind"])
            self.assertEqual(r["params"]["fields"], "scan.fields")
            self.assertEqual(r.get("desktopOnly", False), r["params"]["kind"] in s["desktopOnlyKinds"])
        self.assertEqual(set(s["kinds"]) - set(scanner.KINDS), set())

    def test_params_that_name_policy_tables_resolve(self):
        for r in self.p["rules"]:
            for key, ref in r.get("params", {}).items():
                if isinstance(ref, str) and re.fullmatch(r"(attributes|places|media|urls|scan)\.[A-Za-z]+", ref) and key in ("types", "mime", "fields", "pattern", "keepForTypes"):
                    node = self.p
                    for part in ref.split("."):
                        self.assertIn(part, node, "%s: %s" % (r["id"], ref))
                        node = node[part]

    def test_desktop_only_rules_cannot_be_detected_by_the_server(self):
        for r in self.p["rules"]:
            if r.get("desktopOnly"):
                self.assertEqual(r["server"], "none", r["id"])

    def test_every_pointer_pattern_expands_and_sources_are_cited(self):
        for r in self.p["rules"]:
            self.assertTrue(R.expand_braces(r["path"]), r["id"])
            self.assertRegex(r["source"], r"sync\.md|BRD2|Q2-")

    def test_the_file_names_no_real_values(self):
        text = read(POLICY_FILE)
        self.assertEqual(scanner.scan_text(text, kinds=("email", "street_address", "po_box", "dob_heuristic")), [])


class BirthLikePredicate(unittest.TestCase):
    def ev(self, value, string="", handle="e"):
        return {"_class": "Event", "handle": handle, "type": {"value": value, "string": string}}

    def test_every_standard_type(self):
        t = R.Tree([])
        for v in (12, 14, 15, 18, 22, 45):
            self.assertTrue(R.is_birth_like(self.ev(v), t), v)
        for v in (-1, 1, 7, 13, 16, 17, 19, 20, 21, 23, 29, 44, 46):
            self.assertFalse(R.is_birth_like(self.ev(v), t), v)

    def test_custom_types(self):
        t = R.Tree([])
        for s in ("Birth", "BIRTH Registration", "naissance", "Geburtsurkunde", "Acta de Nacimiento", "Bapt.", "christened"):
            self.assertTrue(R.is_birth_like(self.ev(0, s), t), s)
        for s in ("", "Residence", "Census", "Graduation", "Bırth", "Kaptism"):
            self.assertFalse(R.is_birth_like(self.ev(0, s), t), s)
        # the type name of a non-custom type is not looked at
        self.assertFalse(R.is_birth_like(self.ev(29, "Birth"), t))

    def test_birth_ref_fallback_for_any_type(self):
        e = self.ev(29, "", "e1")
        p = {"_class": "Person", "handle": "p1", "birth_ref_index": 1, "event_ref_list": [{"ref": "x"}, {"ref": "e1"}]}
        self.assertTrue(R.is_birth_like(e, R.Tree([e, p])))
        for idx in (0, 2, -1, None, True):
            p2 = dict(p, birth_ref_index=idx)
            self.assertFalse(R.is_birth_like(e, R.Tree([e, p2])), idx)

    def test_the_design_name_is_exported(self):
        self.assertIs(R.isBirthLike, R.is_birth_like)

    def test_a_list_of_objects_is_accepted_as_the_tree(self):
        e = self.ev(29, "", "e1")
        p = {"_class": "Person", "handle": "p1", "birth_ref_index": 0, "event_ref_list": [{"ref": "e1"}]}
        self.assertTrue(R.is_birth_like(e, [e, p]))

    def test_living_or_deceased_makes_no_difference(self):
        e = self.ev(12, "", "e1")
        d = self.ev(13, "", "e2")
        living = {"_class": "Person", "handle": "p1", "birth_ref_index": 0, "death_ref_index": -1, "event_ref_list": [{"ref": "e1"}]}
        dead = dict(living, death_ref_index=1, event_ref_list=[{"ref": "e1"}, {"ref": "e2"}])
        self.assertTrue(R.is_birth_like(e, R.Tree([e, living])))
        self.assertTrue(R.is_birth_like(e, R.Tree([e, d, dead])))


class RulesHelpers(unittest.TestCase):
    def test_day_numbers_match_the_standard_library_and_known_julian_values(self):
        for y, m, d in ((1, 1, 1), (1582, 10, 15), (1900, 1, 1), (1900, 3, 5), (2000, 2, 29), (2024, 12, 31)):
            self.assertEqual(R.sdn(0, y, m, d), datetime.date(y, m, d).toordinal() + 1721425, (y, m, d))
        self.assertEqual(R.sdn(1, 1900, 1, 1), 2415033)
        self.assertEqual(R.sdn(1, 1582, 10, 5), R.sdn(0, 1582, 10, 15))
        self.assertIsNone(R.sdn(2, 1900, 1, 1))

    def test_reduce_date_shapes(self):
        pol = R.load_policy()
        d = {"_class": "Date", "calendar": 0, "dateval": [5, 3, 1900, True, 20, 4, 1901, False], "format": None, "modifier": 4, "newyear": 0,
             "quality": 1, "sortval": 2415084, "text": "c. 1900"}
        r = R.reduce_date(d, pol)
        self.assertEqual(r["dateval"], [0, 0, 1900, True, 0, 0, 1901, False])
        self.assertEqual((r["modifier"], r["quality"], r["text"], r["sortval"]), (4, 1, "", 2415021))
        self.assertEqual(R.reduce_date(r, pol), r)
        self.assertEqual(d["dateval"][0], 5, "the input is not changed")
        t = dict(d, modifier=6, dateval=[0, 0, 0, False], text="March 1899 or 1900")
        self.assertEqual(R.reduce_date(t, pol)["dateval"], [0, 0, 1899, False])
        self.assertEqual(R.reduce_date(dict(t, text="12345"), pol)["dateval"], [0, 0, 0, False])
        self.assertEqual(R.reduce_date(dict(t, text="in 1900"), pol)["modifier"], 0)

    def test_date_violations(self):
        pol = R.load_policy()
        base = {"dateval": [0, 0, 1900, False], "text": ""}
        self.assertEqual(R.date_violations(base, pol), [])
        self.assertEqual(R.date_violations(dict(base, text="1900"), pol), [])
        self.assertEqual(R.date_violations(dict(base, text="June 1900"), pol), ["/text"])
        self.assertEqual(R.date_violations(dict(base, dateval=[1, 2, 1900, False, 3, 4, 1901, False]), pol),
                         ["/dateval/0", "/dateval/1", "/dateval/4", "/dateval/5"])

    def test_coordinates(self):
        cases = {"40.123456": "40.12", "-111.987654": "-111.99", "40.1": "40.1", "40": "40", "40.005": "40.01", "-0.004": "0.00", "12.995": "13.00",
                 "179.999999": "180.00", "": "", "+40.126": "40.13", "-0.005": "-0.01", "0.001": "0.00", "99.994": "99.99", "99.995": "100.00"}
        for text, want in cases.items():
            self.assertEqual(R.round_coordinate(text), want, text)
        for text in ("40°7'24.4\"N", "1e5", "40,5", " 40.5", "40.5\n", "N40.5", "--1", "."):
            self.assertIsNone(R.round_coordinate(text), repr(text))
        self.assertTrue(R.coordinate_is_fine("40.123"))
        self.assertFalse(R.coordinate_is_fine("40.12"))
        self.assertFalse(R.coordinate_is_fine(""))
        self.assertTrue(R.coordinate_is_fine("40°"))

    def test_rounding_is_idempotent(self):
        for text in ("40.123456", "-0.004", "12.995", "99.995"):
            once = R.round_coordinate(text)
            self.assertEqual(R.round_coordinate(once), once)

    def test_rects(self):
        self.assertIsNone(R.rect_problem(None))
        self.assertIsNone(R.rect_problem([10, 10, 50, 60]))
        self.assertEqual(R.rect_problem([0, 0, 100, 100]), "full_frame")
        self.assertEqual(R.rect_problem([0.0, 0.0, 100.0, 100.0]), "full_frame")
        for bad in ([12.5, 10, 50, 60], [60, 10, 50, 70], [10, 70, 50, 60], [10, 10, 101, 60], [-1, 0, 5, 5], [10, 10, 50], "x", [True, 0, 5, 5], [5, 5, 5, 9]):
            self.assertEqual(R.rect_problem(bad), "degenerate_or_float", bad)

    def test_url_parts_and_rules(self):
        scan = lambda t: scanner.scan_text(t)  # noqa: E731
        got = lambda path, t=2, desc="": R.url_rules({"path": path, "type": {"value": t}, "desc": desc}, scan)  # noqa: E731
        self.assertEqual(got("https://example.org/about"), [])
        self.assertEqual(got("https://example.org/search?q=1", 3), [])
        self.assertIn("contact.url.email_type", got("anyone@example.org", 1))
        self.assertIn("contact.url.channel", got("mailto:anyone@example.org"))
        self.assertIn("contact.url.channel", got("TEL:+15550100"))
        self.assertIn("contact.url.channel", got("https://WA.ME/15550100"))
        self.assertIn("contact.url.channel", got("https://x.t.me/a"))
        self.assertIn("contact.url.channel", got("https://user@m.me:443/a"))
        self.assertIn("contact.url.channel", got("www.instagram.com/m/alder"))
        self.assertNotIn("contact.url.channel", got("https://www.instagram.com/alder"))
        self.assertNotIn("contact.url.channel", got("https://notwa.me/x"))
        self.assertNotIn("contact.url.channel", got("https://wa.me.example.org/x"))
        self.assertNotIn("contact.url.channel", got("https://example.org/wa.me"))
        self.assertEqual(got("https://example.org/a", 2, "Call 555-0123"), ["contact.url.scan_hit"])

    def test_pointer_patterns(self):
        o = {"a": [{"private": True, "x": 1}, {"x": 2}], "b": {"c": [1, 2]}}
        self.assertEqual(R.match_pointers(o, "/a/*"), ["/a/0", "/a/1"])
        self.assertEqual(R.match_pointers(o, "/**/x"), ["/a/0/x", "/a/1/x"])
        self.assertEqual(R.match_pointers(o, "/{a/1/x,b/c/0}"), ["/a/1/x", "/b/c/0"])
        self.assertEqual(R.match_pointers(o, "/"), [""])
        self.assertEqual(R.match_pointers(o, "/a/5"), [])
        self.assertEqual(R.match_pointers(o, "/b/c/*"), ["/b/c/0", "/b/c/1"])
        self.assertEqual(R.expand_braces("/a/{b,c}/{d,e}"), ["/a/b/d", "/a/b/e", "/a/c/d", "/a/c/e"])
        self.assertEqual(R.pointer_get(o, "/a/1/x"), 2)
        self.assertEqual(R.pointer_get(o, "/nope", "d"), "d")
        R.pointer_set(o, "/a/1/x", 9)
        R.pointer_remove(o, ["/a/0", "/b/c/1", "/b/c/0"])
        self.assertEqual(o, {"a": [{"x": 9}], "b": {"c": []}})

    def test_attribute_rule(self):
        mk = lambda t, cls="Attribute": {"_class": cls, "type": {"value": t}}  # noqa: E731
        self.assertEqual(R.attribute_rule(mk(10)), "birth.attribute.age_time")
        self.assertEqual(R.attribute_rule(mk(14)), "birth.attribute.age_time")
        self.assertEqual(R.attribute_rule(mk(6)), "contact.attribute.government_id")
        self.assertEqual(R.attribute_rule(mk(3)), "contact.attribute.government_id")
        self.assertIsNone(R.attribute_rule(mk(0)))
        self.assertIsNone(R.attribute_rule(mk(6, "SrcAttribute")))

    def test_place_helpers(self):
        mk = lambda v, s="": {"place_type": {"value": v, "string": s}}  # noqa: E731
        for v in (7, 18, 19, 20):
            self.assertEqual(R.place_exclusion_rule(mk(v)), "place.exclude.type")
        for s in ("Home", "farmhouse", "APT 5", "Plot of land", "Chapter"):
            self.assertEqual(R.place_exclusion_rule(mk(0, s)), "place.exclude.custom_home_like", s)
        for v, s in ((4, ""), (4, "Home"), (0, "Campground"), (0, ""), (1, "")):
            self.assertIsNone(R.place_exclusion_rule(mk(v, s)), (v, s))
        for v in (1, 2, 3, 8, 9, 10):
            self.assertFalse(R.place_code_is_local(mk(v)))
        for v in (-1, 0, 4, 5, 6, 11, 15, 16, 17):
            self.assertTrue(R.place_code_is_local(mk(v)))

    def test_loading_another_path_does_not_replace_the_cached_policy(self):
        other = R.load_policy(POLICY_FILE)
        other["birthLike"]["eventTypes"] = []
        self.assertTrue(R.load_policy()["birthLike"]["eventTypes"])


class Vectors(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.vectors = all_vectors()
        cls.policy = load(POLICY_FILE)

    def test_at_least_90_vectors_with_unique_ids(self):
        ids = [v["id"] for v in self.vectors]
        self.assertGreaterEqual(len(ids), 90)
        self.assertEqual(len(ids), len(set(ids)))

    def test_vector_shape(self):
        for v in self.vectors:
            self.assertEqual(set(v) - {"_group"}, {"id", "title", "rules", "context", "input", "expected"}, v["id"])
            self.assertEqual(set(v["expected"]) - {"birth_like"}, {"projection", "excluded", "holds", "server"}, v["id"])
            self.assertEqual(sorted(v["expected"]["projection"]), sorted(o["handle"] for o in v["input"]), v["id"])
            self.assertEqual(set(v["expected"]["server"]), {"ok", "violations"}, v["id"])
            self.assertEqual(v["expected"]["server"]["ok"], not v["expected"]["server"]["violations"], v["id"])
            for h in v["expected"]["holds"]:
                self.assertIn(h["scope"], ("object", "field"), v["id"])
            self.assertTrue(v["title"], v["id"])

    def test_every_rule_id_is_covered_and_no_vector_names_an_unknown_rule(self):
        ids = {r["id"] for r in self.policy["rules"]}
        named = set()
        for v in self.vectors:
            self.assertEqual(set(v["rules"]) - ids, set(), v["id"])
            named.update(v["rules"])
        self.assertEqual(ids - named, set())

    def test_expected_rules_exist(self):
        ids = {r["id"] for r in self.policy["rules"]}
        for v in self.vectors:
            e = v["expected"]
            for x in e["excluded"] + e["holds"] + e["server"]["violations"]:
                self.assertIn(x["rule"], ids, v["id"])

    def test_the_review_scenarios_are_covered(self):
        by_event_type = set()
        deceased = ranged = spanned = textonly = custom = birth_ref = False
        for v in self.vectors:
            tree = R.Tree(v["input"])
            like = set(v["expected"].get("birth_like", []))
            for o in v["input"]:
                if o["_class"] == "Event" and o["handle"] in like:
                    t = o["type"]["value"]
                    by_event_type.add(t)
                    custom |= t == 0
                    birth_ref |= t not in (12, 14, 15, 18, 22, 45, 0) and o["handle"] in tree.birth_ref_handles
                    mod = o["date"].get("modifier")
                    ranged |= mod == 4
                    spanned |= mod == 5
                    textonly |= mod == 6
            for p in v["input"]:
                if p["_class"] == "Person" and like:
                    deceased |= any(o["_class"] == "Event" and o["type"]["value"] == 13 and o["handle"] in [r["ref"] for r in p["event_ref_list"]]
                                    for o in v["input"]) and any(r["ref"] in like for r in p["event_ref_list"])
        self.assertEqual(by_event_type >= {12, 14, 15, 18, 22, 45}, True, by_event_type)
        self.assertTrue(deceased and ranged and spanned and textonly and custom and birth_ref)

    def test_cross_object_vectors_are_numerous(self):
        cross = [v for v in self.vectors if any(r.startswith(("birth.citation", "birth.name", "birth.dob_exact", "birth.sticky", "private.orphan", "media.birth_linked")) for r in v["rules"])
                 or v["id"].startswith("birth.ref.")]
        self.assertGreaterEqual(len(cross), 10)

    def test_the_oracle_reproduces_every_expected_value(self):
        for v in self.vectors:
            with self.subTest(v["id"]):
                got = O.project(v["input"], v["context"])
                e = v["expected"]
                self.assertEqual(diff(got["projection"], e["projection"]), [], "projection")
                self.assertEqual(got["excluded"], e["excluded"], "excluded")
                self.assertEqual(got["holds"], e["holds"], "holds")
                self.assertEqual(O.check(v["input"]), e["server"], "server verdict on the input")

    def test_every_claimed_rule_actually_fires(self):
        for v in self.vectors:
            with self.subTest(v["id"]):
                fired = set(O.project(v["input"], v["context"])["fired"]) | {x["rule"] for x in O.check(v["input"])["violations"]}
                self.assertEqual(set(v["rules"]) - fired, set())

    def test_every_projection_passes_the_server_and_is_idempotent(self):
        for v in self.vectors:
            with self.subTest(v["id"]):
                projected = [o for o in v["expected"]["projection"].values() if o is not None]
                self.assertEqual(O.check(projected), {"ok": True, "violations": []})
                again = O.project(projected, v["context"])
                self.assertEqual(diff({h: o for h, o in again["projection"].items() if o is not None}, {o["handle"]: o for o in projected}), [])
                self.assertEqual(again["excluded"], [])

    def test_birth_like_lists_are_exact(self):
        for v in self.vectors:
            if "birth_like" not in v["expected"]:
                continue
            tree = R.Tree(v["input"])
            got = sorted(o["handle"] for o in v["input"] if o["_class"] == "Event" and R.is_birth_like(o, tree, self.policy))
            self.assertEqual(got, v["expected"]["birth_like"], v["id"])

    def test_server_violations_carry_rfc6901_pointers_that_exist_or_are_roots(self):
        for v in self.vectors:
            by_handle = {o["handle"]: o for o in v["input"]}
            for x in v["expected"]["server"]["violations"]:
                self.assertRegex(x["pointer"], r"^(/[^/]+)*$", v["id"])
                self.assertIn(x["handle"], by_handle, v["id"])
                if x["rule"] != "place.repoint" or "ref" not in x["pointer"]:
                    self.assertIsNotNone(R.pointer_get(by_handle[x["handle"]], x["pointer"], None) if x["pointer"] else 0, "%s %s" % (v["id"], x))

    def test_vectors_are_fictional(self):
        objs = [o for v in self.vectors for o in v["input"] + [x for x in v["expected"]["projection"].values() if x]]
        bad, checked = fictional_violations(objs)
        # an ISO or year-first date is a run of eight digits to the plain phone rule; it is a date, not a number
        bad = [b for b in bad if not re.fullmatch(r"[0-9]{4}[-/][0-9]{2}[-/][0-9]{2}", b[1])]
        self.assertEqual(bad, [])
        self.assertGreater(checked, 20)

    def test_vectors_only_name_fictional_people(self):
        given = {"Alder", "Birch", "Cedar", "Dahlia", "Elm", "Hazel"}
        for v in self.vectors:
            for o in v["input"]:
                if o["_class"] == "Person":
                    self.assertIn(o["primary_name"]["first_name"], given, v["id"])
                    self.assertEqual(o["primary_name"]["surname_list"][0]["surname"] in ("Testwood", "555-0127"), True)

    # --- negative controls: the vectors notice a changed rule
    def run_with(self, vector_id, mutate):
        v = next(x for x in self.vectors if x["id"] == vector_id)
        pol = copy.deepcopy(self.policy)
        mutate(pol)
        got = O.project(v["input"], v["context"], pol)
        e = v["expected"]
        return diff(got["projection"], e["projection"]) or got["excluded"] != e["excluded"] or got["holds"] != e["holds"] or O.check(v["input"], pol) != e["server"]

    def test_negative_control_dropping_stillbirth_is_noticed(self):
        self.assertFalse(self.run_with("birth.type.stillbirth_45", lambda p: None))
        self.assertTrue(self.run_with("birth.type.stillbirth_45", lambda p: p["birthLike"]["eventTypes"].remove({"value": 45, "name": "Stillbirth"})))

    def test_negative_control_dropping_adult_christening_is_noticed(self):
        self.assertTrue(self.run_with("birth.type.adult_christening_14", lambda p: p["birthLike"]["eventTypes"].remove({"value": 14, "name": "Adult Christening"})))

    def test_negative_control_dropping_a_custom_word_is_noticed(self):
        self.assertTrue(self.run_with("birth.type.custom_pattern", lambda p: p["birthLike"]["customType"].update(pattern="birth|bapt|christen|naissance|geburt")))

    def test_negative_control_ignoring_birth_ref_is_noticed(self):
        def off(p):
            p["birthLike"]["birthRefIndex"] = False
        # the oracle has no switch for birthRefIndex: the policy file requires it (schema const true), so this is the schema's job
        bad = policy()
        off(bad)
        self.assertTrue(jsonschema_lite.validate(bad, load(SCHEMA_FILE)))

    def test_negative_control_a_looser_place_pattern_is_noticed(self):
        self.assertTrue(self.run_with("place.exclude.custom_home_like", lambda p: p["places"]["customHomeLike"].update(pattern="house|home|residence")))

    def test_negative_control_a_missing_excluded_type_is_noticed(self):
        self.assertTrue(self.run_with("place.exclude.farm", lambda p: p["places"].update(excludedTypes=[t for t in p["places"]["excludedTypes"] if t["value"] != 18])))

    def test_negative_control_a_wider_admin_list_is_noticed(self):
        self.assertTrue(self.run_with("place.code.local_only", lambda p: p["places"]["administrativeTypes"].append({"value": 4, "name": "City"})))

    def test_negative_control_three_decimals_are_noticed(self):
        self.assertTrue(self.run_with("place.coordinates.round", lambda p: p["places"].update(coordinateDecimals=3)))

    def test_negative_control_dropping_a_day_month_index_is_noticed(self):
        self.assertTrue(self.run_with("birth.date.range", lambda p: p["dates"].update(dayMonthIndexes=[0, 1])))
        self.assertTrue(self.run_with("birth.date.span", lambda p: p["dates"].update(dayMonthIndexes=[0, 1, 4])))

    def test_negative_control_a_dropped_attribute_type_is_noticed(self):
        self.assertTrue(self.run_with("birth.attribute.age_time", lambda p: p["attributes"].update(ageAndTime=p["attributes"]["ageAndTime"][:3])))

    def test_negative_control_a_dropped_contact_host_is_noticed(self):
        self.assertTrue(self.run_with("contact.url.channel", lambda p: p["urls"].update(hosts=[h for h in p["urls"]["hosts"] if h != "wa.me"])))

    def test_negative_control_a_dropped_held_mime_is_noticed(self):
        self.assertTrue(self.run_with("media.pdf", lambda p: p["media"].update(heldMime=["application/x-none"])))

    def test_negative_control_an_unlisted_scan_field_is_noticed(self):
        self.assertTrue(self.run_with("scan.phone.new_object", lambda p: p["scan"].update(fields=[f for f in p["scan"]["fields"] if f["class"] != "Note"])))

    def test_negative_control_a_wrong_oracle_input_is_noticed(self):
        v = next(x for x in self.vectors if x["id"] == "birth.type.birth_12")
        broken = copy.deepcopy(v["input"])
        broken[0]["date"]["dateval"][0] = 9
        self.assertTrue(O.check(broken)["violations"])


class Drift(unittest.TestCase):
    def test_vectors_are_what_the_generator_writes(self):
        r = subprocess.run([sys.executable, os.path.join(RED, "make_vectors.py"), "--check"], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_the_reference_page_is_what_the_generator_writes(self):
        self.assertEqual(read(PAGE), render_reference.render(load(POLICY_FILE)))
        r = subprocess.run([sys.executable, os.path.join(RED, "render_reference.py"), "--check"], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_the_page_follows_the_policy_when_it_changes(self):
        p = policy()
        p["rules"][0]["summary"] = "A changed summary"
        self.assertNotEqual(render_reference.render(p), read(PAGE))
        p = policy()
        p["birthLike"]["eventTypes"].append({"value": 99, "name": "Invented"})
        self.assertNotEqual(render_reference.render(p), read(PAGE))
        p = policy()
        p["places"]["coordinateDecimals"] = 3
        self.assertNotEqual(render_reference.render(p), read(PAGE))

    def test_the_page_names_every_rule_and_every_birth_like_type(self):
        text = read(PAGE)
        pol = load(POLICY_FILE)
        for r in pol["rules"]:
            self.assertIn("`%s`" % r["id"], text)
        for t in pol["birthLike"]["eventTypes"]:
            self.assertIn("%s %d" % (t["name"], t["value"]), text)

    def test_the_page_states_no_test_counts_and_no_live_state(self):
        text = read(PAGE)
        self.assertNotRegex(text, r"\b\d+ (vectors|tests)\b")
        self.assertNotRegex(text, r"authV2|data gate")
        self.assertNotIn("—", text)


class FixtureTree(unittest.TestCase):
    """sync.md 5.6 on the whole synthetic tree: the properties the projection must keep."""

    @classmethod
    def setUpClass(cls):
        cls.objs = census.load_jsonl(FIXTURE)
        cls.files = {m["handle"]: {"exif_gps": m["path"].endswith("gps.jpg"), "readable": False} for m in cls.objs if m["_class"] == "Media"}
        cls.result = O.project(cls.objs, {"files": cls.files})
        cls.projected = [o for o in cls.result["projection"].values() if o is not None]

    def test_the_raw_tree_is_refused_and_the_projection_is_accepted(self):
        raw = O.check(self.objs)
        self.assertFalse(raw["ok"])
        rules = {v["rule"] for v in raw["violations"]}
        for rid in ("birth.date.daymonth", "birth.citation.date", "birth.name.date", "contact.address_list", "contact.url.email_type",
                    "contact.attribute.government_id", "birth.attribute.age_time", "birth.lds_ord", "place.exclude.type",
                    "place.exclude.custom_home_like", "place.coordinates.round", "place.code.local_only", "private.object.exclude",
                    "scan.phone", "scan.email", "scan.street_address", "scan.po_box"):
            self.assertIn(rid, rules)
        self.assertEqual(O.check(self.projected), {"ok": True, "violations": []})

    def test_projecting_twice_changes_nothing(self):
        again = O.project(self.projected, {"files": self.files})
        self.assertEqual(diff({h: o for h, o in again["projection"].items() if o is not None}, {o["handle"]: o for o in self.projected}), [])
        self.assertEqual(again["excluded"], [])

    def test_private_and_home_like_objects_are_gone(self):
        proj = self.result["projection"]
        for o in self.objs:
            if o.get("private"):
                self.assertIsNone(proj[o["handle"]], o["handle"])
            if o["_class"] == "Place" and o["place_type"]["value"] in (7, 18, 19, 20):
                self.assertIsNone(proj[o["handle"]], o["handle"])
        excluded = {x["rule"] for x in self.result["excluded"]}
        self.assertTrue({"private.object.exclude", "private.orphan.exclude", "place.exclude.type", "place.exclude.custom_home_like"} <= excluded)

    def test_no_projected_birth_like_event_shows_a_day_or_month(self):
        tree = R.Tree(self.objs)
        like = {o["handle"] for o in self.objs if o["_class"] == "Event" and R.is_birth_like(o, tree)}
        self.assertGreater(len(like), 3)
        for h in like:
            e = self.result["projection"][h]
            if e is not None:
                self.assertEqual(R.date_violations(e["date"]), [], h)
                self.assertEqual([e["date"]["dateval"][i] for i in (0, 1)], [0, 0])

    def test_no_local_full_birth_date_survives_anywhere_in_the_projection(self):
        tree = R.Tree(self.objs)
        text = json.dumps(self.projected)
        seen = 0
        for dob in O.local_dobs(tree, R.load_policy()):
            y, m, d = dob["ymd"]
            for rendering in census.dob_renderings(y, m, d):
                seen += 1
                self.assertNotIn(rendering, text)
        self.assertGreater(seen, 9)

    def test_no_contact_data_survives_anywhere_in_the_projection(self):
        for o in self.projected:
            self.assertEqual(o.get("address_list", []), [], o["handle"])
            self.assertEqual(o.get("lds_ord_list", []), [], o["handle"])
            self.assertFalse(o.get("private"), o["handle"])
        text = json.dumps(self.projected)
        self.assertEqual(scanner.scan_text(text, kinds=("email", "po_box", "contact_url")), [])
        self.assertNotRegex(text, r"555-01[0-9][0-9]")
        for o in self.projected:
            if o["_class"] == "Place":
                self.assertEqual(len(o["lat"].partition(".")[2]) <= 2 and len(o["long"].partition(".")[2]) <= 2, True, o["handle"])

    def test_the_held_objects_are_the_ones_the_fixture_plants(self):
        rules = {h["rule"] for h in self.result["holds"]}
        for rid in ("private.name.hold_person", "media.pdf.hold", "media.exif_gps.hold", "media.rect.degenerate_or_float", "scan.phone", "scan.email",
                    "scan.street_address", "scan.po_box", "scan.dob_exact", "scan.dob_heuristic"):
            self.assertIn(rid, rules)

    def test_media_paths_are_empty(self):
        for o in self.projected:
            if o["_class"] == "Media":
                self.assertEqual(o["path"], "")


if __name__ == "__main__":
    unittest.main()
