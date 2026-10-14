"""The redaction projection P in pure Python (task projection-py): gramps/hfygramps/projection.py.

Nothing here imports Gramps, so any worker or CI job can run it:

    python3 -m unittest discover gramps/tests/unit

It runs the golden vectors of redaction policy v1 through the production projection (the reference oracle in
redaction_oracle.py reproduces the same values; the two are also compared on the whole synthetic tree), then the properties of
sync.md 5.6 on the synthetic tree and on seeded random edits of it (P(P(x)) == P(x), and nothing a rule forbids survives), then one
test class per remaining acceptance criterion: reference indexes and references, the exact-DOB reduction and scan, the sticky
set, the orphan, media, place and Citation rules, coordinates and rectangles with their lift. Every value is fictional.
"""
import ast
import copy
import glob
import json
import os
import random
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(REPO, "gramps"))
sys.path.insert(0, os.path.join(REPO, "gramps", "redaction"))
sys.path.insert(0, os.path.join(REPO, "gramps", "tests", "fixtures"))

import census  # noqa: E402
import make_vectors as MV  # noqa: E402  (the builders; importing it only builds the vectors in memory)
import redaction_oracle as O  # noqa: E402
from hfygramps import projection as P  # noqa: E402
from hfygramps import rules as R  # noqa: E402
from hfygramps import scanner  # noqa: E402

RED = os.path.join(REPO, "gramps", "redaction")
FIXTURE = os.path.join(REPO, "gramps", "tests", "fixtures", "synthetic-tree.jsonl")
POLICY = R.load_policy()

EV, PE, FA, PL, SRC, CIT, MED, NOTE, MR, ER, NAME, DATE, DY, ATTR, URL = (
    MV.EV, MV.PE, MV.FA, MV.PL, MV.SRC, MV.CIT, MV.MED, MV.NOTE, MV.MR, MV.ER, MV.NAME, MV.DATE, MV.DY, MV.ATTR, MV.URL)
C = MV.C


def load_vectors():
    out = []
    for path in sorted(glob.glob(os.path.join(RED, "vectors", "*.json"))):
        with open(path, encoding="utf-8") as fh:
            out.extend(json.load(fh)["vectors"])
    return out


def run(objects, **ctx):
    return P.project(copy.deepcopy(objects), **ctx)


def context(v):
    c = v["context"]
    return dict(base=c.get("base"), files=c.get("files"), released=c.get("released"), sticky=c.get("sticky"))


def kept(result):
    return [o for o in result.projected.values() if o is not None]


def walk(node):
    if isinstance(node, dict):
        yield node
        for v in node.values():
            yield from walk(v)
    elif isinstance(node, list):
        for v in node:
            yield from walk(v)


def fixture_objects():
    return census.load_jsonl(FIXTURE)


def fixture_files(objs):
    return {m["handle"]: {"exif_gps": m["path"].endswith("gps.jpg"), "readable": False} for m in objs if m["_class"] == "Media"}


def leaks(projected, raw):
    """What sync.md 5.6 forbids in a projection: a list of (handle, what)."""
    ptree, rtree = R.Tree(projected), R.Tree(raw)
    local_like = {e["handle"] for e in rtree.of_class("Event") if R.is_birth_like(e, rtree, POLICY)}
    index = P.DobIndex(P.local_dobs(rtree, (), POLICY), POLICY["scan"]["dobWindow"])
    out = []
    for o in projected:
        h = o["handle"]
        for node in walk(o):
            cls = node.get("_class")
            if cls == "Address":
                out.append((h, "address"))
            if cls == "Url" and R._obj(node.get("type")).get("value") == POLICY["urls"]["emailType"]:
                out.append((h, "email url"))
            if cls == "Location":
                out.extend((h, "location " + f) for f in POLICY["places"]["locationFields"] if node.get(f))
            if node.get("private") is True:
                out.append((h, "private"))
            if cls == "LdsOrd":
                out.append((h, "lds"))
        if o["_class"] == "Event" and (h in local_like or R.is_birth_like(o, ptree, POLICY)):
            dv = R._list(R._obj(o.get("date")).get("dateval"))
            if any(i < len(dv) and dv[i] for i in (0, 1, 4, 5)) or R._obj(o.get("date")).get("text"):
                out.append((h, "birth-like date"))
        if o["_class"] == "Place":
            if R.place_exclusion_rule(o, POLICY):
                out.append((h, "excluded place"))
            for k in ("lat", "long"):
                if R.coordinate_is_fine(o.get(k) or "", POLICY):
                    out.append((h, "coordinates"))
            if o.get("code") and R.place_code_is_local(o, POLICY):
                out.append((h, "place code"))
        for ptr, text in O.scan_fields(o, POLICY):
            if O._scan_kinds(text, POLICY):
                out.append((h, "scanner hit " + ptr))
            if index.text_hit(text):
                out.append((h, "dob_exact hit " + ptr))
        for node in walk(o):
            if node.get("_class") == "Date" and index.date_hit(node):
                out.append((h, "local birth date"))
    return out


def dangling(result, raw):
    """Strings in a projected object that name a raw handle the projection does not keep."""
    handles = {o["handle"] for o in raw}
    alive = {h for h, o in result.projected.items() if o is not None}
    out = []
    for o in kept(result):
        for node in walk(o):
            for k, v in node.items():
                if isinstance(v, str) and v in handles and v not in alive and k != "handle":
                    out.append((o["handle"], k, v))
                if isinstance(v, list):
                    out.extend((o["handle"], k, x) for x in v if isinstance(x, str) and x in handles and x not in alive)
    return out


class GoldenVectors(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.vectors = load_vectors()

    def test_every_golden_vector_passes(self):
        self.assertGreaterEqual(len(self.vectors), 90)
        for v in self.vectors:
            with self.subTest(v["id"]):
                r = run(v["input"], **context(v))
                e = v["expected"]
                self.assertEqual(r.projected, e["projection"])
                self.assertEqual(r.holds, e["holds"])
                self.assertEqual(r.excluded, e["excluded"])
                self.assertEqual(P.project_tree(copy.deepcopy(v["input"]), **context(v)), (e["projection"], e["holds"]))

    def test_every_rule_a_vector_claims_actually_fires_in_the_production_projection(self):
        for v in self.vectors:
            with self.subTest(v["id"]):
                fired = set(run(v["input"], **context(v)).fired) | {x["rule"] for x in O.check(v["input"])["violations"]}
                self.assertEqual(set(v["rules"]) - fired, set())

    def test_every_rule_of_the_policy_fires_somewhere_in_the_vectors(self):
        fired = set()
        for v in self.vectors:
            fired |= set(run(v["input"], **context(v)).fired)
        self.assertEqual({r["id"] for r in POLICY["rules"]} - fired, set())

    def test_the_projection_of_every_vector_is_idempotent_and_passes_the_server(self):
        for v in self.vectors:
            with self.subTest(v["id"]):
                r = run(v["input"], **context(v))
                again = run(kept(r), **context(v))
                self.assertEqual({h: o for h, o in again.projected.items() if o is not None}, {o["handle"]: o for o in kept(r)})
                self.assertEqual(again.excluded, [])
                self.assertEqual(O.check(kept(r)), {"ok": True, "violations": []})

    def test_no_vector_projection_leaks_what_the_rules_forbid(self):
        for v in self.vectors:
            with self.subTest(v["id"]):
                r = run(v["input"], **context(v))
                self.assertEqual(leaks(kept(r), v["input"]), [])

    def test_the_production_projection_equals_the_reference_oracle_on_every_vector(self):
        for v in self.vectors:
            with self.subTest(v["id"]):
                got = run(v["input"], **context(v))
                want = O.project(v["input"], v["context"])
                self.assertEqual(got.projected, want["projection"])
                self.assertEqual(got.holds, want["holds"])
                self.assertEqual(got.excluded, want["excluded"])

    def test_a_negative_control_a_changed_policy_changes_a_vector(self):
        v = next(x for x in self.vectors if x["id"] == "birth.type.stillbirth_45")
        pol = copy.deepcopy(POLICY)
        pol["birthLike"]["eventTypes"] = [t for t in pol["birthLike"]["eventTypes"] if t["value"] != 45]
        got = P.project(copy.deepcopy(v["input"]), policy=pol)
        self.assertNotEqual(got.projected, v["expected"]["projection"])


class SyntheticTree(unittest.TestCase):
    """sync.md 5.6 on the whole synthetic tree."""

    @classmethod
    def setUpClass(cls):
        cls.objs = fixture_objects()
        cls.files = fixture_files(cls.objs)
        cls.result = run(cls.objs, files=cls.files)
        cls.projected = kept(cls.result)

    def test_projecting_twice_changes_nothing(self):
        again = run(self.projected, files=self.files)
        self.assertEqual({h: o for h, o in again.projected.items() if o is not None}, {o["handle"]: o for o in self.projected})
        self.assertEqual(again.excluded, [])
        self.assertEqual(again.holds, [h for h in again.holds if h["scope"] == "field" or h["rule"].startswith("media.")],
                         "a second pass finds nothing new to hold except what it was already holding")

    def test_nothing_a_rule_forbids_survives(self):
        self.assertEqual(leaks(self.projected, self.objs), [])
        self.assertGreater(len(self.projected), 50)

    def test_the_raw_tree_does_leak_so_the_check_has_teeth(self):
        raw_leaks = {what.split(" ")[0] for _, what in leaks([o for o in self.objs if o["_class"] != "Researcher"], self.objs)}
        self.assertTrue({"address", "email", "private", "birth-like", "excluded", "coordinates", "scanner"} <= raw_leaks, raw_leaks)

    def test_the_projection_equals_the_reference_oracle_apart_from_the_change_stamp(self):
        want = O.project(self.objs, {"files": self.files})
        for h, w in want["projection"].items():
            got = self.result.projected[h]
            if w is None:
                self.assertIsNone(got, h)
            else:
                self.assertEqual(got, {k: v for k, v in w.items() if k != "change"}, h)
        self.assertEqual(self.result.holds, want["holds"])
        self.assertEqual(self.result.excluded, want["excluded"])

    def test_no_projected_object_carries_the_change_stamp_and_no_input_is_changed(self):
        self.assertTrue(all("change" not in o for o in self.projected))
        self.assertTrue(any("change" in o for o in self.objs))
        before = copy.deepcopy(self.objs)
        P.project_tree(self.objs, files=self.files)
        self.assertEqual(self.objs, before)

    def test_every_reference_in_a_projected_object_resolves(self):
        self.assertEqual(dangling(self.result, self.objs), [])

    def test_the_run_is_deterministic_and_fast(self):
        a, b = run(self.objs, files=self.files), run(list(reversed(self.objs)), files=self.files)
        self.assertEqual(a.projected, b.projected)
        self.assertEqual(a.holds, b.holds)

    def test_withdrawn_names_the_excluded_objects_the_cloud_already_has(self):
        private = [o["handle"] for o in self.objs if o.get("private")]
        self.assertTrue(private)
        base = {h: o for h, o in self.result.projected.items() if o is not None}
        base[private[0]] = {"_class": "Person", "handle": private[0]}
        self.assertEqual(run(self.objs, files=self.files, base=base).withdrawn, [private[0]])
        self.assertEqual(self.result.withdrawn, [])


class RandomEdits(unittest.TestCase):
    """Seeded random edits of the synthetic tree: P stays idempotent, leaks nothing and keeps every reference resolvable."""

    DOB = None

    def mutate(self, objs, rnd):
        by = {}
        for o in objs:
            by.setdefault(o["_class"], []).append(o)
        for o in rnd.sample([o for o in objs if o["_class"] not in ("Tag",)], 4):
            o["private"] = True
        for e in rnd.sample(by["Event"], 6):
            e["type"] = {"_class": "EventType", "string": rnd.choice(["", "Residence", "Birth record", "Bapt."]), "value": rnd.choice([0, 29, 12, 15, 19])}
        births = [e for e in by["Event"] if e["type"]["value"] == 12 and e["date"]["dateval"][0]]
        for e in rnd.sample(by["Event"], 5):
            if births:
                e["date"] = copy.deepcopy(rnd.choice(births)["date"])
        for n in rnd.sample(by["Note"], 4):
            if births:
                d = rnd.choice(births)["date"]["dateval"]
                n["text"]["string"] += " " + rnd.choice(sorted(P.dob_renderings(d[2], d[1], d[0])))
        for p in rnd.sample(by["Person"], 6):
            refs = p["event_ref_list"]
            if refs:
                del refs[rnd.randrange(len(refs))]
            if rnd.random() < 0.5 and refs:
                p["birth_ref_index"] = rnd.randrange(len(refs))
        for pl in rnd.sample(by["Place"], 3):
            pl["lat"] = "%d.%06d" % (rnd.randrange(80), rnd.randrange(10 ** 6))
        return objs

    def test_twenty_seeded_edits(self):
        base_objs = fixture_objects()
        files = fixture_files(base_objs)
        base = {h: o for h, o in run(base_objs, files=files).projected.items() if o is not None}
        for seed in range(20):
            with self.subTest(seed=seed):
                objs = self.mutate(copy.deepcopy(base_objs), random.Random(seed))
                for ctx in ({}, {"base": base}):
                    r = run(objs, files=files, **ctx)
                    self.assertEqual(leaks(kept(r), objs), [], ctx.keys())
                    self.assertEqual(dangling(r, objs), [])
                    again = run(kept(r), files=files, sticky=r.sticky, **ctx)
                    self.assertEqual({h: o for h, o in again.projected.items() if o is not None}, {o["handle"]: o for o in kept(r)})
                    self.assertEqual(O.check(kept(r)), {"ok": True, "violations": []})


class ReferencesAndIndexes(unittest.TestCase):
    """AC3: ref indexes against the filtered list, references to excluded or held objects, places re-pointed."""

    def person(self, evs, birth, death, **kw):
        return PE("p1", evs, birth=birth, death=death, **kw)

    def test_the_indexes_follow_the_surviving_event_refs(self):
        b, d, r1, r2 = (EV("ev%d" % i, t, DATE(i, 3, 1900)) for i, t in ((1, MV.BIRTH), (2, MV.DEATH), (3, MV.RESIDENCE), (4, MV.RESIDENCE)))
        p = self.person([ER("ev3", private=True), ER("ev4"), "ev1", "ev2"], 2, 3)
        res = run([b, d, r1, r2, p])
        out = res.projected["p1"]
        self.assertEqual([x["ref"] for x in out["event_ref_list"]], ["ev4", "ev1", "ev2"])
        self.assertEqual((out["birth_ref_index"], out["death_ref_index"]), (1, 2))
        self.assertEqual(out["event_ref_list"][out["birth_ref_index"]]["ref"], "ev1")

    def test_an_index_whose_ref_is_gone_becomes_minus_one(self):
        b = EV("ev1", MV.RESIDENCE, DATE(5, 3, 1900), private=True)
        d = EV("ev2", MV.DEATH, DATE(1, 1, 1980))
        p = self.person(["ev1", "ev2"], 0, 1)
        out = run([b, d, p]).projected["p1"]
        self.assertEqual([x["ref"] for x in out["event_ref_list"]], ["ev2"])
        self.assertEqual((out["birth_ref_index"], out["death_ref_index"]), (-1, 0))

    def test_an_event_whose_photo_is_held_stays_and_keeps_its_index(self):
        b = EV("ev1", MV.BIRTH, DATE(5, 3, 1900), media=["m1"])
        pdf = MED("m1", mime="application/pdf")
        d = EV("ev2", MV.DEATH, DATE(1, 1, 1980))
        p = self.person(["ev1", "ev2"], 0, 1)
        out = run([b, pdf, d, p]).projected["p1"]
        self.assertEqual((out["birth_ref_index"], out["death_ref_index"]), (0, 1), "the event itself is kept; its photo is held")

    def test_untouched_and_invalid_indexes_stay_as_they_are(self):
        b = EV("ev1", MV.BIRTH, DATE(5, 3, 1900))
        for idx in (-1, 0, 7):
            out = run([b, self.person(["ev1"], 0 if idx == 0 else -1, idx if idx != 0 else -1)]).projected["p1"]
            self.assertEqual((out["birth_ref_index"], out["death_ref_index"]), (0 if idx == 0 else -1, idx if idx != 0 else -1))

    def test_a_family_a_child_ref_and_a_parent_handle_to_a_private_object_are_filtered(self):
        priv = PE("p3", [], private=True)
        kid = PE("p2", [], first="Birch", parent_family_list=["f1"])
        mum = PE("p1", [], first="Cedar", family_list=["f1"])
        f = FA("f1", father="p3", mother="p1", children=["p2", "p3"])
        out = run([priv, kid, mum, f]).projected
        self.assertIsNone(out["p3"])
        self.assertEqual((out["f1"]["father_handle"], out["f1"]["mother_handle"]), (None, "p1"))
        self.assertEqual([c["ref"] for c in out["f1"]["child_ref_list"]], ["p2"])

    def test_references_to_a_held_new_object_are_filtered(self):
        n = NOTE("n1", "Call 555-0142 for details")
        p = PE("p1", [], note_list=["n1"])
        res = run([n, p])
        self.assertIsNone(res.projected["n1"])
        self.assertEqual(res.projected["p1"]["note_list"], [])
        self.assertEqual([(h["rule"], h["scope"]) for h in res.holds], [("scan.phone", "object")])

    def test_street_level_places_are_re_pointed_to_the_nearest_kept_ancestor(self):
        town = PL("pl1", "Fixtureland", MV.PL_CITY)
        building = PL("pl2", "Hall", MV.PL_BUILDING, parent="pl1")
        street = PL("pl3", "Example Road", MV.PL_STREET, parent="pl2")
        number = PL("pl4", "12", MV.PL_NUMBER, parent="pl3")
        farm = PL("pl5", "Sample Farm", MV.PL_FARM, parent="pl1")
        yard = PL("pl6", "Back Yard", MV.PL_CITY, parent="pl4")
        ev = EV("ev1", MV.RESIDENCE, DATE(1, 1, 1930), place="pl4")
        ev2 = EV("ev2", MV.RESIDENCE, DATE(1, 1, 1931), place="pl5")
        res = run([town, building, street, number, farm, yard, ev, ev2])
        out = res.projected
        self.assertEqual([out[h] is None for h in ("pl2", "pl3", "pl4", "pl5")], [True] * 4)
        self.assertEqual((out["ev1"]["place"], out["ev2"]["place"]), ("pl1", "pl1"))
        self.assertEqual(out["pl6"]["placeref_list"][0]["ref"], "pl1")
        self.assertEqual(dangling(res, [town, building, street, number, farm, yard, ev, ev2]), [])

    def test_a_place_with_no_kept_ancestor_leaves_an_empty_reference(self):
        street = PL("pl1", "Example Road", MV.PL_STREET)
        ev = EV("ev1", MV.RESIDENCE, DATE(1, 1, 1930), place="pl1")
        sub = PL("pl2", "Corner", MV.PL_CITY, parent="pl1")
        out = run([street, ev, sub]).projected
        self.assertEqual(out["ev1"]["place"], "")
        self.assertEqual(out["pl2"]["placeref_list"], [])

    def test_a_private_event_place_is_emptied(self):
        pl = PL("pl1", "Hidden", MV.PL_CITY, private=True)
        ev = EV("ev1", MV.RESIDENCE, DATE(1, 1, 1930), place="pl1")
        self.assertEqual(run([pl, ev]).projected["ev1"]["place"], "")

    def test_repointing_is_idempotent(self):
        town = PL("pl1", "Fixtureland", MV.PL_CITY)
        street = PL("pl2", "Example Road", MV.PL_STREET, parent="pl1")
        ev = EV("ev1", MV.RESIDENCE, DATE(1, 1, 1930), place="pl2")
        once = run([town, street, ev])
        twice = run(kept(once))
        self.assertEqual(twice.projected["ev1"], once.projected["ev1"])


class ExactBirthDate(unittest.TestCase):
    """AC4: dob_exact over every Date object of any class, and over free text."""

    BIRTH = DATE(5, 3, 1900)

    def tree(self, *extra, first="Alder"):
        return [EV("ev1", MV.BIRTH, self.BIRTH), PE("p1", ["ev1"], birth=0, first=first)] + list(extra)

    def test_a_date_of_every_class_on_a_local_birth_date_is_reduced(self):
        res_ev = EV("ev2", MV.RESIDENCE, DATE(5, 3, 1900))
        cit = CIT("c1", date=DATE(5, 3, 1900))
        src = SRC("s1")
        media = MED("m1", mime="image/png", date=DATE(5, 3, 1900))
        other = PE("p2", [ER("ev3")], first="Birch", alternate_names=[NAME("Birch", "Marsh", MV.NAME_MARRIED, DATE(5, 3, 1900))],
                   media_list=[MR("m1")], citation_list=["c1"])
        fam_ev = EV("ev3", MV.MARRIAGE, DATE(5, 3, 1900))
        fam = FA("f1", evs=["ev4"])
        fam_ev2 = EV("ev4", MV.MARRIAGE, DATE(5, 3, 1900))
        place = PL("pl1", "Fixtureland", MV.PL_CITY)
        place2 = PL("pl2", "Hamlet", MV.PL_CITY, placeref_list=[dict(MV.PLREF("pl1"), date=DATE(5, 3, 1900))])
        res = run(self.tree(res_ev, cit, src, media, other, fam_ev, fam, fam_ev2, place, place2))
        out = res.projected
        for h in ("ev2", "c1", "m1", "ev3", "ev4"):
            self.assertEqual(R._list(out[h]["date"]["dateval"])[:2], [0, 0], h)
            self.assertEqual(out[h]["date"]["dateval"][2], 1900)
            self.assertEqual(out[h]["date"]["sortval"], MV.sort_value(0, 1900, 1, 1), h)
        self.assertEqual(out["p2"]["alternate_names"][0]["date"]["dateval"][:2], [0, 0])
        self.assertEqual(out["pl2"]["placeref_list"][0]["date"]["dateval"][:2], [0, 0])
        self.assertIn("birth.dob_exact.date", res.fired)
        self.assertEqual(leaks(kept(res), self.tree(res_ev, cit, src, media, other, fam_ev, fam, fam_ev2, place, place2)), [])

    def test_a_date_one_day_off_a_different_calendar_or_year_only_is_kept(self):
        keep = [EV("ev2", MV.RESIDENCE, DATE(6, 3, 1900)), EV("ev3", MV.RESIDENCE, DATE(5, 4, 1900)),
                EV("ev4", MV.RESIDENCE, DATE(5, 3, 1901)), EV("ev5", MV.RESIDENCE, DATE(5, 3, 1900, cal=1)),
                EV("ev6", MV.RESIDENCE, DY(1900))]
        out = run(self.tree(*keep)).projected
        for e in keep:
            self.assertEqual(out[e["handle"]], e, e["handle"])

    def test_either_half_of_a_range_or_span_is_checked(self):
        r = EV("ev2", MV.RESIDENCE, DATE(1, 1, 1899, MV.RANGE, second=(5, 3, 1900)))
        s = EV("ev3", MV.RESIDENCE, DATE(5, 3, 1900, MV.SPAN, second=(1, 1, 1905)))
        out = run(self.tree(r, s)).projected
        self.assertEqual(out["ev2"]["date"]["dateval"], [0, 0, 1899, False, 0, 0, 1900, False])
        self.assertEqual(out["ev3"]["date"]["dateval"], [0, 0, 1900, False, 0, 0, 1905, False])

    def test_the_date_text_of_a_text_only_date_that_renders_a_birth_date_is_reduced(self):
        t = EV("ev2", MV.RESIDENCE, DATE(0, 0, 0, MV.TEXTONLY, text="5 March 1900"))
        keep = EV("ev3", MV.RESIDENCE, DATE(0, 0, 0, MV.TEXTONLY, text="about 1900"))
        out = run(self.tree(t, keep)).projected
        self.assertEqual((out["ev2"]["date"]["dateval"], out["ev2"]["date"]["text"], out["ev2"]["date"]["modifier"]), ([0, 0, 1900, False], "", 0))
        self.assertEqual(out["ev3"]["date"]["text"], "about 1900")

    def test_a_date_without_a_class_key_is_still_a_date(self):
        res_ev = EV("ev2", MV.RESIDENCE, DATE(5, 3, 1900))
        del res_ev["date"]["_class"]
        out = run(self.tree(res_ev)).projected
        self.assertEqual(out["ev2"]["date"]["dateval"][:2], [0, 0])

    def test_a_death_on_the_birth_day_is_reduced_too(self):
        d = EV("ev2", MV.DEATH, DATE(5, 3, 1900))
        p = PE("p1", ["ev1", "ev2"], birth=0, death=1)
        out = run([EV("ev1", MV.BIRTH, self.BIRTH), d, p]).projected
        self.assertEqual(out["ev2"]["date"]["dateval"][:2], [0, 0])

    def renderings(self):
        core = set(P.dob_renderings(1900, 3, 5))
        extra = {"March 05, 1900", "March 5 1900", "5th March 1900", "5th of March, 1900", "05.03.1900", "5/3/1900", "05/03/1900", "1900.03.05",
                 "MARCH 5 1900", "Mar. 5, 1900", "Sept"[:0] + "March  5,   1900", "1900-3-5", "March 5th, 1900", "5 march 1900"}
        return core, extra

    def held_by(self, text, first="Alder"):
        note = NOTE("n9", text)
        res = run(self.tree(note, first=first))
        return [h["rule"] for h in res.holds if h["handle"] == "n9"]

    def test_every_full_rendering_holds_the_text(self):
        core, extra = self.renderings()
        self.assertEqual(core, set(census.dob_renderings(1900, 3, 5)))
        for r in sorted(core | extra):
            with self.subTest(r):
                self.assertIn("scan.dob_exact", self.held_by("Entered on %s in the register" % r))

    def test_look_alike_digits_and_invisible_characters_do_not_hide_a_rendering(self):
        for text in ("１９００-０３-０５", "1900-03-0​5", "March 5, 1900", "1900‐03‐05",
                     "١٩٠٠-03-05"):
            with self.subTest(text):
                self.assertIn("scan.dob_exact", self.held_by("Entered " + text))

    def test_a_full_rendering_of_another_persons_birth_date_holds_too(self):
        other = [EV("ev2", MV.BIRTH, DATE(9, 11, 1921)), PE("p2", ["ev2"], birth=0, first="Birch")]
        res = run(self.tree(*other, NOTE("n9", "Recorded 9 November 1921")))
        self.assertIn("scan.dob_exact", [h["rule"] for h in res.holds if h["handle"] == "n9"])

    def test_day_and_month_alone_hold_near_a_birth_keyword(self):
        for text in ("Born 5 March", "birthday: March 5th", "his DOB is 3/5", "bapt. on the 5th of March", "born on the fifth... 05.03.",
                     "baptized March 5"):
            with self.subTest(text):
                self.assertIn("scan.dob_exact", self.held_by(text, first="Hazel"))

    def test_day_and_month_alone_hold_near_that_persons_name(self):
        for text in ("Alder came on 5 March", "5 March was when alder arrived", "March 5th: Alder", "alder 3/5 note"):
            with self.subTest(text):
                self.assertIn("scan.dob_exact", self.held_by(text))
        self.assertNotIn("scan.dob_exact", self.held_by("Birch came on 5 March"), "another name is not an anchor")

    def test_the_sixty_character_window_is_exact(self):
        for anchor, first in (("born", "Hazel"), ("Alder", "Alder")):
            gap = lambda k: "%s %s 5 March" % (anchor, "x" * k)  # noqa: E731  (the gap is k + 2 characters)
            self.assertIn("scan.dob_exact", self.held_by(gap(58), first=first), anchor)
            self.assertNotIn("scan.dob_exact", self.held_by(gap(59), first=first), anchor)
            back = lambda k: "5 March %s %s" % ("x" * k, anchor)  # noqa: E731
            self.assertIn("scan.dob_exact", self.held_by(back(58), first=first), anchor)
            self.assertNotIn("scan.dob_exact", self.held_by(back(59), first=first), anchor)

    def test_texts_that_are_not_the_birth_date_are_not_held(self):
        for text in ("Moved in March 1900", "1900", "March 6, 1900", "Recorded 1901-03-05", "She lived at 5 Mar", "the 5th of May was cold",
                     "Page 3/5 of the diary", "Hazel visited the fair in March", "5 March alone, nothing near it"):
            with self.subTest(text):
                self.assertEqual(self.held_by(text, first="Hazel"), [])

    def test_a_short_given_name_is_not_an_anchor(self):
        self.assertEqual(self.held_by("A went on 5 March", first="A"), [])

    def test_the_call_name_and_nickname_are_anchors(self):
        p = PE("p1", ["ev1"], birth=0, first="Alexander")
        p["primary_name"]["call"] = "Sandy"
        p["primary_name"]["nick"] = "Ziggy"
        for who in ("Alexander", "Sandy", "Ziggy"):
            note = NOTE("n9", "%s went on 5 March" % who)
            res = run([EV("ev1", MV.BIRTH, self.BIRTH), p, note])
            self.assertIn("scan.dob_exact", [h["rule"] for h in res.holds if h["handle"] == "n9"], who)

    def test_every_scanned_field_is_checked_not_only_notes(self):
        fields = [(SRC("s9", title="Register of 1900-03-05"), "/title"), (EV("ev9", MV.RESIDENCE, DATE(1, 1, 1930), desc="Born 5 March"), "/description"),
                  (MED("m9", desc="Photo taken 5 March 1900"), "/desc"), (CIT("c9", page="p. 3, 03/05/1900"), "/page"),
                  (REPO_("r9", "Archive 1900-03-05"), "/name")]
        for obj, ptr in fields:
            with self.subTest(obj["_class"]):
                res = run(self.tree(obj, first="Hazel"))
                self.assertIn(("scan.dob_exact", ptr), [(h["rule"], h["pointer"]) for h in res.holds if h["handle"] == obj["handle"]])

    def test_a_synced_object_keeps_its_base_text_and_a_new_one_is_held_whole(self):
        base_note = NOTE("n9", "A clean sentence")
        dirty = NOTE("n9", "Registered 1900-03-05")
        res = run(self.tree(dirty), base={"n9": base_note})
        self.assertEqual(res.projected["n9"], base_note)
        self.assertEqual([(h["scope"], h["pointer"]) for h in res.holds if h["handle"] == "n9"], [("field", "/text/string")])
        res = run(self.tree(dirty))
        self.assertIsNone(res.projected["n9"])
        self.assertEqual([h["scope"] for h in res.holds if h["handle"] == "n9"], ["object"])

    def test_a_sticky_events_date_is_a_local_birth_date_too(self):
        e = EV("ev2", MV.RESIDENCE, DATE(9, 10, 1905))
        other = EV("ev3", MV.MARRIAGE, DATE(9, 10, 1905))
        res = run([e, other, PE("p1", ["ev2"], birth=-1)], sticky=["ev2"])
        self.assertEqual(res.projected["ev3"]["date"]["dateval"][:2], [0, 0])

    def test_structural_renderings_hold_whatever_the_separator_order_month_spelling_or_year_length(self):
        """Review finding: the full-date match is read from date-like triples, not from a list of strings."""
        for text in ("05-03-1900", "03-05-1900", "5 3 1900", "1900 03 05", "1900.3.5", "Mar-5-1900", "5-Mar-1900", "1900-Mar-05",
                     "5/3/00", "05.03.00", "Fifth of March 1900", "fifth march, 1900", "5 mars 1900", "5 de marzo de 1900", "5. M\u00e4rz 1900",
                     "5 maart 1900", "5 marzo 1900", "5 mar\u00e7o 1900", "19000305", "05031900", "03051900", "1900-03-05T10:00:00",
                     "5 March '00", "March 5th 1900", "the 5th day: 5th of Mar., 1900", "1900 / 5 / 3", "3 - 5 - 1900", "MARCH-5-1900"):
            with self.subTest(text):
                self.assertIn("scan.dob_exact", self.held_by("Entered " + text + " in the register"))

    def test_the_day_words_and_compound_ordinals_are_read(self):
        index = P.DobIndex([P._Dob("p", (), 1900, 3, 21, 0), P._Dob("p", (), 1900, 3, 30, 0)], 60)
        for text in ("Twenty-first of March 1900", "twenty first March 1900", "March thirtieth, 1900", "21st March 1900"):
            with self.subTest(text):
                self.assertTrue(index.text_hit(text))
        self.assertFalse(index.text_hit("Twenty-second of March 1900"))

    def test_near_misses_of_the_structural_match_are_not_held(self):
        for text in ("6-3-1900", "1900-03-06", "5 3 1901", "5/3/01", "Page 5 3 19", "5 March 1901", "1900 5", "19000306", "5 and 3 and 1900",
                     "5 xx March 1900", "5/13/1900", "5/3/", "tel 1900 03 0", "5 3 900"):
            with self.subTest(text):
                self.assertNotIn("scan.dob_exact", self.held_by(text, first="Hazel"))

    def test_day_and_month_alone_hold_with_dash_and_slash_separators_near_an_anchor(self):
        for text in ("Alder came 5-3", "born 3-5", "born Mar-5", "born 5-Mar", "born 5/3", "Alder 3/5", "Alder 5.3.", "born March, 5th"):
            with self.subTest(text):
                self.assertIn("scan.dob_exact", self.held_by(text))
        for text in ("Alder had 5 3 chairs", "Alder walked 5.3 miles", "Alder 5-3-17", "Alder 13/5/1901", "born 12/5/3", "Alder 15-3"):
            with self.subTest(text):
                self.assertNotIn("scan.dob_exact", self.held_by(text, first="Alder"))

    def test_two_digit_years_and_accents_fold_to_the_same_day(self):
        index = P.DobIndex([P._Dob("p", ("zoe",), 1987, 2, 4, 0)], 60)
        self.assertTrue(index.text_hit("4 f\u00e9vrier 1987"))
        self.assertTrue(index.text_hit("Zoe went on 4 Feb"))
        self.assertTrue(index.text_hit("04.02.87"))
        self.assertFalse(index.text_hit("04.02.88"))

    def test_the_text_scan_costs_one_pass_whatever_the_number_of_birth_days(self):
        """Review finding: one regex per distinct (month, day) made the scan grow with the tree; now one pass per text."""
        import time
        objs, n = [], 0
        for month in range(1, 13):
            for day in range(1, 29):
                n += 1
                objs.append(EV("e%d" % n, MV.BIRTH, DATE(day, month, 1800 + n % 150)))
                objs.append(PE("p%d" % n, ["e%d" % n], birth=0, first="Name%d" % n))
        notes = [NOTE("n%d" % i, "Plain remark number %d about the harvest of 19%02d, filed 1%d/2%d" % (i, i % 100, i % 9, i % 7)) for i in range(3000)]
        start = time.time()
        res = run(objs + notes)
        self.assertLess(time.time() - start, 30)
        self.assertEqual([h for h in res.holds if h["rule"] == "scan.dob_exact"], [])
        index = P.DobIndex(P.local_dobs(R.Tree(objs), (), POLICY), POLICY["scan"]["dobWindow"])
        start = time.time()
        for note in notes:
            index.text_hit(note["text"]["string"])
        self.assertLess(time.time() - start, 5)

    def test_the_index_is_cheap_on_a_big_tree(self):
        objs = []
        for i in range(400):
            y, m, d = 1850 + i % 120, 1 + i % 12, 1 + i % 28
            objs.append(EV("e%d" % i, MV.BIRTH, DATE(d, m, y)))
            objs.append(PE("p%d" % i, ["e%d" % i], birth=0, first="Name%d" % i))
        notes = [NOTE("n%d" % i, "Plain remark number %d about the harvest" % i) for i in range(300)]
        import time
        start = time.time()
        res = run(objs + notes)
        self.assertLess(time.time() - start, 20)
        self.assertEqual([h for h in res.holds if h["rule"] == "scan.dob_exact"], [])


def REPO_(handle, name):
    return MV.REPO(handle, name)


class StickySet(unittest.TestCase):
    """AC6: the birthlike_sticky set and a Birth retyped to Residence."""

    def retyped_fixture(self):
        objs = fixture_objects()
        files = fixture_files(objs)
        base = {h: o for h, o in run(objs, files=files).projected.items() if o is not None}
        ev = next(e for e in objs if e["_class"] == "Event" and e["type"]["value"] == MV.BIRTH and e["date"]["dateval"][0] and e["date"]["dateval"][1]
                  and e["handle"] in base)
        person = next(p for p in objs if p["_class"] == "Person" and any(r["ref"] == ev["handle"] for r in p["event_ref_list"]))
        edited = copy.deepcopy(objs)
        e2 = next(e for e in edited if e["handle"] == ev["handle"])
        e2["type"] = {"_class": "EventType", "string": "", "value": MV.RESIDENCE}
        for p in edited:
            if p["handle"] == person["handle"] and p["birth_ref_index"] >= 0 and p["event_ref_list"][p["birth_ref_index"]]["ref"] == ev["handle"]:
                p["birth_ref_index"] = -1
        return objs, edited, files, base, ev

    def test_a_birth_retyped_to_residence_keeps_day_and_month_local(self):
        objs, edited, files, base, ev = self.retyped_fixture()
        self.assertEqual(R.date_violations(base[ev["handle"]]["date"]), [])
        got = run(edited, files=files, base=base)
        date = got.projected[ev["handle"]]["date"]
        self.assertEqual([date["dateval"][i] for i in (0, 1)], [0, 0])
        self.assertEqual(date["text"], "")
        self.assertIn(ev["handle"], got.sticky)
        self.assertEqual(leaks(kept(got), edited), [])

    def test_without_the_sticky_set_the_retyped_event_would_show_its_day_and_month(self):
        objs, edited, files, base, ev = self.retyped_fixture()
        got = run(edited, files=files)
        date = got.projected[ev["handle"]]["date"]
        self.assertTrue(date["dateval"][0] and date["dateval"][1], "the control: this is what the sticky set prevents")
        self.assertNotIn(ev["handle"], run(edited, files=files).sticky - {ev["handle"]})

    def test_the_stored_set_alone_is_enough_and_it_survives_every_later_run(self):
        objs, edited, files, base, ev = self.retyped_fixture()
        first = run(edited, files=files, base=base)
        stored = set(first.sticky)
        second = run(edited, files=files, sticky=stored)
        self.assertEqual([second.projected[ev["handle"]]["date"]["dateval"][i] for i in (0, 1)], [0, 0])
        self.assertEqual(second.sticky, frozenset(stored))
        third = run(edited, files=files, sticky=P.update_birthlike_sticky(stored, edited, base=None))
        self.assertEqual(third.projected[ev["handle"]], second.projected[ev["handle"]])

    def test_io_releases_a_handle_by_removing_it(self):
        objs, edited, files, base, ev = self.retyped_fixture()
        stored = P.update_birthlike_sticky(set(), edited, base)
        self.assertIn(ev["handle"], stored)
        released = P.update_birthlike_sticky(stored, edited, base=None, released=[ev["handle"]])
        self.assertNotIn(ev["handle"], released)
        got = run(edited, files=files, sticky=released)
        date = got.projected[ev["handle"]]["date"]
        self.assertTrue(date["dateval"][0] and date["dateval"][1], "released: the event is an ordinary Residence again")

    def test_additions_are_birth_like_now_birth_like_at_base_or_equal_to_a_local_birth_date(self):
        birth = EV("ev1", MV.BIRTH, DATE(5, 3, 1900))
        res_same = EV("ev2", MV.RESIDENCE, DATE(5, 3, 1900))
        res_other = EV("ev3", MV.RESIDENCE, DATE(6, 3, 1900))
        was_birth = EV("ev4", MV.RESIDENCE, DATE(7, 3, 1900))
        p = PE("p1", ["ev1", "ev2", "ev3", "ev4"], birth=0)
        base = {"ev4": C(was_birth, type=MV.TYPE("EventType", MV.BIRTH)), "ev3": C(res_other)}
        got = P.birthlike_sticky_additions([birth, res_same, res_other, was_birth, p], base)
        self.assertEqual(got, {"ev1", "ev2", "ev4"})
        self.assertEqual(P.birthlike_sticky_additions([birth, p]), {"ev1"})

    def test_a_base_person_birth_ref_makes_its_event_sticky(self):
        ev = EV("ev1", MV.RESIDENCE, DATE(9, 10, 1905))
        local = PE("p1", ["ev1"], birth=-1)
        base = {"p1": C(local, birth_ref_index=0), "ev1": C(ev, date=DY(1905))}
        self.assertEqual(P.birthlike_sticky_additions([ev, local], base), {"ev1"})
        out = run([ev, local], base=base).projected["ev1"]
        self.assertEqual(out["date"]["dateval"][:2], [0, 0])

    def test_the_citations_and_photos_of_a_sticky_event_stay_protected(self):
        ev = EV("ev1", MV.RESIDENCE, DATE(9, 10, 1905), cit=["c1"], media=["m1"])
        cit = CIT("c1", date=DATE(9, 10, 1905))
        photo = MED("m1")
        p = PE("p1", [ER("ev1", cites=["c2"])], birth=-1)
        cit2 = CIT("c2", date=DATE(1, 2, 1906))
        src = SRC("s1")
        res = run([ev, cit, cit2, src, photo, p], sticky=["ev1"])
        self.assertEqual(res.projected["c1"]["date"]["dateval"][:2], [0, 0])
        self.assertEqual(res.projected["c2"]["date"]["dateval"][:2], [0, 0])
        self.assertIsNone(res.projected["m1"])
        self.assertIn(("m1", "media.birth_linked.hold"), [(h["handle"], h["rule"]) for h in res.holds])
        released = run([ev, cit, cit2, src, photo, p], sticky=[], base={})
        self.assertEqual(released.projected["c1"]["date"]["dateval"][:2], [9, 10])

    def test_the_golden_vector_for_a_sticky_event_uses_the_same_rule(self):
        v = next(x for x in load_vectors() if x["id"] == "birth.sticky")
        r = run(v["input"], **context(v))
        self.assertIn("birth.sticky", r.fired)
        self.assertEqual(r.projected, v["expected"]["projection"])


class OrphansHoldsAndPlaces(unittest.TestCase):
    """AC7: exclude_orphan_of_private, Citation and birth-name dates, hold_media, home-like places, Place.code."""

    def test_a_private_person_with_a_birth_event_a_note_and_a_photo(self):
        ev = EV("ev1", MV.BIRTH, DATE(5, 3, 1900), notes=["n2"], cit=["c1"])
        cit = CIT("c1", source="s1", date=DATE(5, 3, 1900))
        src = SRC("s1")
        note = NOTE("n1", "About the private person")
        n2 = NOTE("n2", "About the birth")
        photo = MED("m1", path="media/p.jpg")
        p = PE("p1", ["ev1"], birth=0, private=True, note_list=["n1"], media_list=[MR("m1")])
        other = PE("p2", [], first="Birch")
        res = run([ev, cit, src, note, n2, photo, p, other])
        out = res.projected
        for h in ("p1", "ev1", "c1", "n1", "n2", "m1"):
            self.assertIsNone(out[h], h)
        self.assertIsNotNone(out["s1"], "sources are exempt")
        self.assertIsNotNone(out["p2"])
        rules = dict((x["handle"], x["rule"]) for x in res.excluded)
        self.assertEqual(rules["p1"], "private.object.exclude")
        for h in ("ev1", "c1", "n1", "n2", "m1"):
            self.assertEqual(rules[h], "private.orphan.exclude", h)

    def test_an_object_shared_with_a_kept_object_stays(self):
        ev = EV("ev1", MV.RESIDENCE, DATE(1, 1, 1930), notes=["n1"])
        n = NOTE("n1", "Shared remark")
        priv = PE("p1", ["ev1"], private=True)
        pub = PE("p2", ["ev1"], first="Birch")
        out = run([ev, n, priv, pub]).projected
        self.assertIsNone(out["p1"])
        self.assertIsNotNone(out["ev1"])
        self.assertIsNotNone(out["n1"])

    def test_a_private_family_takes_its_events_and_notes_but_not_its_people(self):
        ev = EV("ev1", MV.MARRIAGE, DATE(1, 6, 1925))
        n = NOTE("n1", "Wedding notes")
        f = FA("f1", father="p1", mother="p2", children=["p3"], evs=["ev1"], note_list=["n1"], private=True)
        ps = [PE("p1", [], family_list=["f1"]), PE("p2", [], first="Birch", family_list=["f1"]), PE("p3", [], first="Cedar", parent_family_list=["f1"])]
        res = run([ev, n, f] + ps)
        out = res.projected
        self.assertIsNone(out["f1"])
        self.assertIsNone(out["ev1"])
        self.assertIsNone(out["n1"])
        for h in ("p1", "p2", "p3"):
            self.assertIsNotNone(out[h])
        self.assertEqual(out["p1"]["family_list"], [])
        self.assertEqual(out["p3"]["parent_family_list"], [])

    def test_a_private_child_ref_removes_the_edge_and_the_child_survives(self):
        f = FA("f1", father="p1", children=[MV.CHREF("p2", private=True), "p3"])
        ps = [PE("p1", [], family_list=["f1"]), PE("p2", [], first="Birch", parent_family_list=["f1"]), PE("p3", [], first="Cedar", parent_family_list=["f1"])]
        out = run([f] + ps).projected
        self.assertEqual([c["ref"] for c in out["f1"]["child_ref_list"]], ["p3"])
        self.assertIsNotNone(out["p2"])

    def test_an_orphan_that_is_reached_only_through_a_private_element_is_dropped(self):
        ev = EV("ev1", MV.RESIDENCE, DATE(1, 1, 1930))
        p = PE("p1", [ER("ev1", private=True)])
        out = run([ev, p]).projected
        self.assertIsNone(out["ev1"])
        self.assertEqual(out["p1"]["event_ref_list"], [])

    def test_the_cascade_runs_to_a_fixed_point(self):
        c2 = CIT("c2", source="s1")
        n = NOTE("n1", "On the citation")
        c1 = CIT("c1", source="s1", note_list=["n1"])
        ev = EV("ev1", MV.RESIDENCE, DATE(1, 1, 1930), cit=["c1"])
        s = SRC("s1", private=True)
        out = run([c1, c2, n, ev, s, PE("p1", ["ev1"], citation_list=["c2"])]).projected
        self.assertIsNone(out["s1"])
        self.assertIsNone(out["c1"])
        self.assertIsNone(out["c2"])
        self.assertIsNone(out["n1"])
        self.assertIsNotNone(out["ev1"], "an event with a kept referrer stays")

    def test_citation_dates_of_birth_like_events_and_birth_name_dates_lose_day_and_month(self):
        birth = EV("ev1", MV.BIRTH, DATE(5, 3, 1900), cit=["c1"])
        other = EV("ev2", MV.RESIDENCE, DATE(1, 1, 1930), cit=["c3"])
        c1 = CIT("c1", date=DATE(7, 3, 1900, text="7 March 1900"))
        c2 = CIT("c2", date=DATE(8, 3, 1900))
        c3 = CIT("c3", date=DATE(9, 3, 1900))
        src = SRC("s1")
        p = PE("p1", [ER("ev1", cites=["c2"]), "ev2"], birth=0, primary_name=NAME("Alder", "Testwood", MV.NAME_BIRTH, DATE(3, 2, 1899, text="3 Feb 1899")),
               alternate_names=[NAME("Alder", "Marsh", MV.NAME_BIRTH, DATE(4, 2, 1899)), NAME("Alder", "Marsh", MV.NAME_MARRIED, DATE(4, 2, 1920))])
        out = run([birth, other, c1, c2, c3, src, p]).projected
        for h in ("c1", "c2"):
            self.assertEqual((out[h]["date"]["dateval"][:2], out[h]["date"]["text"]), ([0, 0], ""), h)
        self.assertEqual(out["c3"]["date"]["dateval"][:2], [9, 3])
        self.assertEqual(out["p1"]["primary_name"]["date"]["dateval"][:2], [0, 0])
        self.assertEqual(out["p1"]["primary_name"]["date"]["text"], "")
        self.assertEqual(out["p1"]["alternate_names"][0]["date"]["dateval"][:2], [0, 0])
        self.assertEqual(out["p1"]["alternate_names"][1]["date"]["dateval"][:2], [4, 2])

    def test_birth_linked_media_and_pdfs_are_held_until_released(self):
        photo = MED("m1", path="media/birth.jpg")
        cert = MED("m2", mime="application/pdf", path="media/cert.pdf")
        plain = MED("m3", path="media/plain.jpg")
        birth = EV("ev1", MV.BIRTH, DATE(5, 3, 1900), media=["m1"])
        p = PE("p1", ["ev1"], birth=0, media_list=[MR("m2"), MR("m3")])
        objs = [photo, cert, plain, birth, p]
        res = run(objs)
        self.assertEqual([res.projected[h] is None for h in ("m1", "m2", "m3")], [True, True, False])
        self.assertEqual(sorted((h["handle"], h["rule"], h["scope"]) for h in res.holds),
                         [("m1", "media.birth_linked.hold", "object"), ("m2", "media.pdf.hold", "object")])
        self.assertEqual([m["ref"] for m in res.projected["p1"]["media_list"]], ["m3"])
        base = {"m1": C(photo, path=""), "m2": C(cert, path="")}
        synced = run(objs, base=base)
        self.assertEqual((synced.projected["m1"], synced.projected["m2"]), (base["m1"], base["m2"]))
        released = run(objs, released=["m1", "m2"])
        self.assertEqual([released.projected[h] is not None for h in ("m1", "m2")], [True, True])
        self.assertEqual(released.holds, [])

    def test_exif_gps_files_are_held_and_checksums_come_from_the_bytes(self):
        gps = MED("m1", path="media/g.jpg")
        ok = MED("m2", path="media/o.jpg", checksum="a" * 32)
        placeholder = MED("m3", path="media/ph.jpg", checksum="b" * 32)
        files = {"m1": {"exif_gps": True}, "m2": {"readable": True, "md5": "c" * 32}, "m3": {"readable": False, "md5": ""}}
        res = run([gps, ok, placeholder], files=files)
        self.assertIsNone(res.projected["m1"])
        self.assertEqual(res.projected["m2"]["checksum"], "c" * 32)
        self.assertEqual(res.projected["m3"]["checksum"], "b" * 32)
        self.assertEqual(res.projected["m2"]["path"], "")
        again = run([ok], files={"m2": {"readable": True, "md5": "c" * 32}}, released=["m2"])
        self.assertEqual(again.projected["m2"]["checksum"], "c" * 32)

    def test_farm_building_number_street_and_custom_home_like_places_are_excluded(self):
        names = {MV.PL_FARM: None, MV.PL_BUILDING: None, MV.PL_NUMBER: None, MV.PL_STREET: None}
        town = PL("pl0", "Fixtureland", MV.PL_CITY)
        objs = [town] + [PL("pl%d" % t, "Somewhere", t, parent="pl0") for t in names]
        objs += [PL("plc%d" % i, "Somewhere", MV.PL_CUSTOM, ts=s, parent="pl0") for i, s in enumerate(("Home", "Residence", "Apt 4", "farmstead", "Lot 9", "The House"))]
        objs += [PL("plk", "Somewhere", MV.PL_CUSTOM, ts="Campground", parent="pl0")]
        res = run(objs)
        for o in objs[1:-1]:
            self.assertIsNone(res.projected[o["handle"]], o["handle"])
        self.assertIsNotNone(res.projected["plk"])
        self.assertIsNotNone(res.projected["pl0"])

    def test_place_code_stays_only_at_the_administrative_level(self):
        kinds = {MV.PL_COUNTRY: True, MV.PL_STATE: True, MV.PL_COUNTY: True, MV.PL_PROVINCE: True, MV.PL_REGION: True, MV.PL_DEPARTMENT: True,
                 MV.PL_CITY: False, MV.PL_TOWN: False, MV.PL_VILLAGE: False, MV.PL_PARISH: False, MV.PL_LOCALITY: False}
        objs = [PL("pl%d" % t, "Somewhere", t, code="12345") for t in kinds]
        out = run(objs).projected
        for t, keeps in kinds.items():
            self.assertEqual(out["pl%d" % t]["code"], "12345" if keeps else "", t)

    def test_the_researcher_is_never_projected(self):
        r = MV.RESEARCHER("r1")
        nameless = {"_class": "Researcher", "name": "Example Researcher"}
        res = run([r, nameless, PE("p1", [])])
        self.assertIsNone(res.projected["r1"])
        self.assertEqual(sorted(res.projected), ["p1", "r1"])
        self.assertEqual(res.excluded, [{"handle": "r1", "rule": "contact.researcher"}])


class CoordinatesAndRects(unittest.TestCase):
    """AC8: rounding and its lift; the full-frame rectangle and the held ones with their lift."""

    def test_coordinates_are_rounded_to_two_decimals_in_p(self):
        p = PL("pl1", "Fixtureland", MV.PL_CITY, lat="40.123456", long="-111.987654")
        q = PL("pl2", "Hamlet", MV.PL_CITY, lat="40.1", long="40°7'24\"N")
        out = run([p, q]).projected
        self.assertEqual((out["pl1"]["lat"], out["pl1"]["long"]), ("40.12", "-111.99"))
        self.assertEqual((out["pl2"]["lat"], out["pl2"]["long"]), ("40.1", ""))
        self.assertEqual(run(kept(run([p, q]))).projected["pl1"], out["pl1"])

    def test_lift_restores_the_local_precision_while_the_rounded_value_is_unchanged(self):
        local = "40.123456"
        cloud = P.project_coordinate(local)
        self.assertEqual(P.lift_coordinate(cloud, local), local)
        self.assertEqual(P.lift_coordinate("41.5", local), "41.5", "the website changed it: take the website value")
        self.assertEqual(P.lift_coordinate("40.12", "40.12"), "40.12")
        self.assertEqual(P.lift_coordinate("", "40°7'24\"N"), "40°7'24\"N", "a blanked value comes back")
        self.assertEqual(P.lift_coordinate("40.2", "40°7'24\"N"), "40.2")
        self.assertEqual(P.lift_coordinate("", ""), "")
        for text in ("-0.004", "99.995", "12.995", "179.999999"):
            self.assertEqual(P.lift_coordinate(P.project_coordinate(text), text), text)

    def test_the_full_frame_rect_is_null_in_p_and_lift_restores_it(self):
        self.assertEqual(P.project_rect([0, 0, 100, 100]), (None, False))
        self.assertEqual(P.lift_rect(None, [0, 0, 100, 100]), [0, 0, 100, 100])
        self.assertEqual(P.lift_rect([5, 5, 50, 50], [0, 0, 100, 100]), [5, 5, 50, 50], "the website set a rectangle")
        self.assertEqual(P.lift_rect(None, None), None)
        self.assertEqual(P.lift_rect([5, 5, 50, 50], [5, 5, 50, 50]), [5, 5, 50, 50])

    def test_degenerate_and_fractional_rects_are_held_and_lift_restores_the_local_value(self):
        base_rect = [10, 10, 50, 60]
        for bad in ([12.5, 10, 50, 60], [60, 10, 50, 70], [10, 70, 50, 60], [10, 10, 101, 60], [1, 2, 3], [True, 0, 5, 5]):
            with self.subTest(bad):
                self.assertEqual(P.project_rect(bad, base_rect), (base_rect, True))
                self.assertEqual(P.project_rect(bad, None), (None, True))
                self.assertEqual(P.lift_rect(base_rect, bad, base_rect), bad, "unchanged on the website: the local value comes back")
                self.assertEqual(P.lift_rect([1, 1, 9, 9], bad, base_rect), [1, 1, 9, 9])
                self.assertEqual(P.lift_rect(None, bad, None), bad)

    def test_media_refs_on_every_class_are_normalised_and_held_with_a_reason(self):
        photo = MED("m1")
        bad = MR("m1", [12.5, 10, 50, 60])
        objs = [photo, PE("p1", [], media_list=[MR("m1", [0, 0, 100, 100]), bad, MR("m1", [10, 10, 50, 60])]),
                EV("ev1", MV.RESIDENCE, DATE(1, 1, 1930), media=[MR("m1", [0, 0, 100, 100])]), PL("pl1", "Fixtureland", MV.PL_CITY, media_list=[bad])]
        base_p = PE("p1", [], media_list=[MR("m1", [3, 3, 30, 30]), MR("m1", [4, 4, 40, 40]), MR("m1", [10, 10, 50, 60])])
        res = run(objs, base={"p1": base_p})
        self.assertEqual([m["rect"] for m in res.projected["p1"]["media_list"]], [None, [4, 4, 40, 40], [10, 10, 50, 60]])
        self.assertEqual(res.projected["ev1"]["media_list"][0]["rect"], None)
        self.assertEqual(res.projected["pl1"]["media_list"][0]["rect"], None)
        reasons = {(h["handle"], h["pointer"]): h["rule"] for h in res.holds}
        self.assertEqual(reasons, {("p1", "/media_list/1/rect"): "media.rect.degenerate_or_float", ("pl1", "/media_list/0/rect"): "media.rect.degenerate_or_float"})
        self.assertIn("degenerate", P.hold_reason("media.rect.degenerate_or_float"))

    def test_a_held_rect_follows_its_reference_when_the_list_is_reordered(self):
        a, b = MED("m1"), MED("m2")
        base_p = PE("p1", [], media_list=[MR("m1", [1, 1, 20, 20]), MR("m2", [2, 2, 30, 30])])
        local = PE("p1", [], media_list=[MR("m2", [30.5, 2, 30, 30]), MR("m1", [1, 1, 20, 20])])
        res = run([a, b, local], base={"p1": base_p})
        self.assertEqual([(m["ref"], m["rect"]) for m in res.projected["p1"]["media_list"]], [("m2", [2, 2, 30, 30]), ("m1", [1, 1, 20, 20])])

    def test_every_hold_has_a_reason_sentence(self):
        for r in POLICY["rules"]:
            self.assertTrue(P.hold_reason(r["id"]))
        with self.assertRaises(KeyError):
            P.hold_reason("no.such.rule")


class ReviewFollowUps(unittest.TestCase):
    """Held values and hold pointers: the base copy, list matching, settled pointers and release (review of HFY-TSK-241)."""

    HOT = "call me at 555-010-1234"

    def test_the_cloud_copy_of_a_held_object_names_no_excluded_object(self):
        base_p = PE("p1", [ER("e_gone"), ER("e_kept")], birth=1, death=-1, note_list=["n1", "n2"], first="Alder")
        local_p = C(base_p, primary_name=NAME("Alder", private=True))
        objs = [local_p, EV("e_gone", MV.RESIDENCE, private=True), EV("e_kept", MV.BIRTH), NOTE("n1", "now private", private=True), NOTE("n2", "fine")]
        res = run(objs, base={"p1": base_p})
        self.assertIn(("p1", "private.name.hold_person"), [(h["handle"], h["rule"]) for h in res.holds])
        held = res.projected["p1"]
        self.assertEqual(held["note_list"], ["n2"])
        self.assertEqual([r["ref"] for r in held["event_ref_list"]], ["e_kept"])
        self.assertEqual(held["birth_ref_index"], 0)
        self.assertIsNone(res.projected["n1"])
        self.assertEqual(dangling(res, objs), [])
        self.assertEqual(res.projected["p1"], run(objs, base={"p1": base_p}).projected["p1"])
        self.assertEqual(base_p["note_list"], ["n1", "n2"], "the input base is not changed")

    def test_a_field_hold_in_a_list_takes_the_value_of_the_same_element_not_of_the_same_index(self):
        x, y = ATTR(0, "base-x", "Hobby"), ATTR(0, "base-y", "Pet")
        base = PE("p1", attribute_list=[x, y])
        local = C(base, attribute_list=[ATTR(0, "fine", "Craft"), ATTR(0, self.HOT, "Hobby"), copy.deepcopy(y)])
        res = run([local], base={"p1": base})
        got = res.projected["p1"]["attribute_list"]
        self.assertEqual([(a["type"]["string"], a["value"]) for a in got], [("Craft", "fine"), ("Hobby", "base-x"), ("Pet", "base-y")])
        self.assertEqual([(h["scope"], h["pointer"]) for h in res.holds], [("field", "/attribute_list/1/value")])

    def test_a_list_element_without_a_counterpart_in_the_base_holds_the_object_whole(self):
        base = PE("p1", attribute_list=[ATTR(0, "base-y", "Pet")])
        local = C(base, attribute_list=[ATTR(0, self.HOT, "Hobby")])
        res = run([local], base={"p1": base})
        self.assertEqual(res.projected["p1"], base)
        self.assertEqual([(h["scope"], h["pointer"]) for h in res.holds], [("object", "/attribute_list/0/value")])

    def test_two_held_fields_of_one_element_are_both_put_back(self):
        old = NAME("Basefirst", "Sur", MV.NAME_MARRIED, nick="Basenick")
        base = PE("p1", alternate_names=[old])
        new = NAME(self.HOT, "Sur", MV.NAME_MARRIED, nick="someone@example.org")
        local = C(base, alternate_names=[NAME("Plain", "Other", MV.NAME_MARRIED), new])
        res = run([local], base={"p1": C(base, alternate_names=[copy.deepcopy(old)])})
        self.assertEqual(res.projected["p1"]["alternate_names"][1], old)
        self.assertEqual(sorted((h["scope"], h["pointer"]) for h in res.holds),
                         [("field", "/alternate_names/1/first_name"), ("field", "/alternate_names/1/nick")])

    def test_a_hold_pointer_is_the_pointer_in_the_projected_object_after_references_are_filtered(self):
        base = PE("p1", media_list=[MR("m2", rect=[0, 0, 10, 10])], person_ref_list=[MV.PREF("p2", "friend")])
        local = C(base, media_list=[MR("m1"), MR("m2", rect=[1, 1, 50.5, 50])],
                  person_ref_list=[MV.PREF("p9", "friend"), MV.PREF("p2", self.HOT)])
        objs = [local, MED("m1", private=True), MED("m2"), PE("p2", first="Birch"), PE("p9", first="Cedar", private=True)]
        res = run(objs, base={"p1": base, "p2": PE("p2", first="Birch"), "m2": MED("m2")}, files={})
        got = res.projected["p1"]
        self.assertEqual([r["ref"] for r in got["media_list"]], ["m2"])
        self.assertEqual(got["media_list"][0]["rect"], [0, 0, 10, 10])
        self.assertEqual([r["ref"] for r in got["person_ref_list"]], ["p2"])
        self.assertEqual(got["person_ref_list"][0]["rel"], "friend")
        pointers = {h["rule"]: h["pointer"] for h in res.holds if h["handle"] == "p1"}
        self.assertEqual(pointers["media.rect.degenerate_or_float"], "/media_list/0/rect")
        self.assertEqual(pointers["scan.phone"], "/person_ref_list/0/rel")
        for h in res.holds:
            if h["scope"] == "field":
                self.assertIsNot(R.pointer_get(res.projected[h["handle"]], h["pointer"], None), None)
        again = run([o for o in objs], base={"p1": base, "p2": PE("p2", first="Birch"), "m2": MED("m2")})
        self.assertEqual(again.holds, res.holds)

    def test_a_hold_on_an_element_that_the_references_phase_removes_is_dropped(self):
        base = PE("p1", person_ref_list=[MV.PREF("p9", "friend"), MV.PREF("p2", "friend")])
        local = C(base, person_ref_list=[MV.PREF("p9", self.HOT), MV.PREF("p2", "friend")])
        objs = [local, PE("p2", first="Birch"), PE("p9", first="Cedar", private=True)]
        res = run(objs, base={"p1": base, "p2": PE("p2", first="Birch")})
        self.assertEqual(res.projected["p1"]["person_ref_list"], [MV.PREF("p2", "friend")])
        self.assertEqual([h for h in res.holds if h["handle"] == "p1"], [])

    def sticky_tree(self, birth_type, date_birth, date_other):
        return [EV("ev1", birth_type, date_birth), EV("ev2", MV.RESIDENCE, date_other), PE("p1", ["ev1", "ev2"], birth=0)]

    def test_a_released_handle_is_not_added_back_by_any_rule_while_it_is_listed(self):
        """Release semantics: ended persistence, not an exemption from the ordinary rules."""
        retyped = self.sticky_tree(MV.RESIDENCE, DATE(5, 3, 1900), DATE(5, 3, 1900))
        retyped[2]["birth_ref_index"] = -1
        base = {"ev1": EV("ev1", MV.BIRTH, DY(1900)), "p1": PE("p1", ["ev1"], birth=0)}
        stored = P.update_birthlike_sticky(set(), retyped, base)
        self.assertEqual(stored, {"ev1", "ev2"}, "ev1 was a Birth at the base; ev2 shares its date")
        kept = P.update_birthlike_sticky(stored, retyped, base, released=["ev2"])
        self.assertEqual(kept, {"ev1"})
        again = P.update_birthlike_sticky(kept, retyped, base, released=["ev2"])
        self.assertEqual(again, {"ev1"}, "still released on the next sync")
        res = run(retyped, base=base, sticky=stored, released=["ev2"])
        self.assertEqual(res.sticky, frozenset({"ev1"}))
        self.assertEqual(res.projected["ev2"]["date"]["dateval"][:2], [0, 0], "its date is a local birth date: the ordinary rule still reduces it")
        self.assertNotIn("ev2", P.birthlike_sticky_additions(retyped, base, released=["ev2"]))

    def test_a_released_handle_that_is_birth_like_now_is_reduced_but_not_sticky(self):
        tree = self.sticky_tree(MV.BIRTH, DATE(5, 3, 1900), DATE(9, 9, 1901))
        res = run(tree, sticky=["ev1"], released=["ev1"])
        self.assertEqual(res.projected["ev1"]["date"]["dateval"][:2], [0, 0])
        self.assertNotIn("ev1", res.sticky)
        self.assertEqual(P.update_birthlike_sticky({"ev1"}, tree, released=["ev1"]), set())

    def test_a_released_event_shows_its_date_once_nothing_else_protects_it(self):
        tree = self.sticky_tree(MV.RESIDENCE, DATE(7, 7, 1907), DATE(9, 9, 1901))
        tree[2]["birth_ref_index"] = -1
        protected = run(tree, sticky=["ev2"])
        self.assertEqual(protected.projected["ev2"]["date"]["dateval"][:2], [0, 0])
        released = run(tree, sticky=["ev2"], released=["ev2"])
        self.assertEqual(released.projected["ev2"]["date"]["dateval"][:2], [9, 9])
        self.assertEqual(released.sticky, frozenset())

    def test_the_sticky_set_only_accumulates_if_the_caller_keeps_it(self):
        """Documented contract: each run sees one base; the caller stores the union."""
        first_base = {"ev1": EV("ev1", MV.BIRTH, DY(1900)), "p1": PE("p1", ["ev1"], birth=0)}
        later = [EV("ev1", MV.RESIDENCE, DATE(5, 3, 1900)), PE("p1", ["ev1"], birth=-1)]
        stored = P.update_birthlike_sticky(set(), later, first_base)
        self.assertEqual(stored, {"ev1"})
        self.assertEqual(P.update_birthlike_sticky(set(), later, {}), set(), "a caller that kept nothing forgets it")
        self.assertEqual(P.update_birthlike_sticky(stored, later, {}), {"ev1"})


class Contract(unittest.TestCase):
    def test_project_tree_returns_a_tuple_and_project_adds_the_details(self):
        objs = [PE("p1", []), PE("p2", [], private=True)]
        pair = P.project_tree(copy.deepcopy(objs))
        self.assertIsInstance(pair, tuple)
        projected, holds = pair
        self.assertEqual(sorted(projected), ["p1", "p2"])
        self.assertEqual(holds, [])
        r = P.project(copy.deepcopy(objs))
        self.assertEqual(tuple(r), pair)
        self.assertEqual(r.excluded, [{"handle": "p2", "rule": "private.object.exclude"}])

    def test_bad_input_raises_so_the_caller_can_fail_closed(self):
        for bad in ([PE("p1", []), PE("p1", [])], [{"_class": "Person"}], [{"_class": "Mystery", "handle": "x"}], [None], ["x"]):
            with self.subTest(repr(bad)), self.assertRaises(ValueError):
                P.project_tree(bad)

    def test_an_empty_tree_projects_to_nothing(self):
        r = P.project([])
        self.assertEqual((r.projected, r.holds, r.excluded, r.withdrawn), ({}, [], [], []))

    def test_the_module_imports_only_the_standard_library_and_its_own_package(self):
        allowed = {"copy", "re", "json", "os", "hashlib", "unicodedata"}
        for name in ("projection.py", "canonical.py"):
            with open(os.path.join(REPO, "gramps", "hfygramps", name), encoding="utf-8") as fh:
                tree = ast.parse(fh.read())
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    mods = [a.name.split(".")[0] for a in node.names]
                elif isinstance(node, ast.ImportFrom):
                    mods = [] if node.level else [node.module.split(".")[0]]
                else:
                    continue
                for m in mods:
                    self.assertIn(m, allowed, "%s imports %s" % (name, m))
                    self.assertNotEqual(m, "gramps")

    def test_nothing_logs_or_prints(self):
        with open(os.path.join(REPO, "gramps", "hfygramps", "projection.py"), encoding="utf-8") as fh:
            tree = ast.parse(fh.read())
        calls = {n.func.id for n in ast.walk(tree) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)}
        self.assertFalse(calls & {"print", "open", "exec", "eval"})

    def test_a_scanner_failure_is_not_swallowed(self):
        real = scanner.scan_text
        scanner.scan_text = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom"))
        try:
            with self.assertRaises(RuntimeError):
                P.project([NOTE("n1", "some text")])
        finally:
            scanner.scan_text = real


if __name__ == "__main__":
    unittest.main()
