"""The three-way merge engine, lift, symmetry checks and conflict model (task merge-engine-py): gramps/hfygramps/merge.py.

Nothing here imports Gramps, so any worker or CI job can run it:

    python3 -m unittest discover gramps/tests/unit

One test class per piece of sync.md section 6 as amended by BRD2 section 11.1: the merge view and its keyed, set and bag lists,
the three-way rule per path with the composite rule, the object-level table (every row), lift (every local-only part, and a
property test over the synthetic tree and 1,000 seeded random edit pairs), pinned conflicts across several runs, convergence of
a web edit and a desktop edit in one run, the tombstone rule, the composite date conflict's three offers, and the relationship
symmetry and reference checks. Branch coverage of merge.py is measured with

    python3 -m coverage run --branch --include='*/hfygramps/merge.py' -m unittest discover gramps/tests/unit -p test_merge.py
    python3 -m coverage report -m

Every value is fictional.
"""
import copy
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
from hfygramps import merge as M  # noqa: E402
from hfygramps import projection as P  # noqa: E402
from hfygramps import rules as R  # noqa: E402

FIXTURE = os.path.join(REPO, "gramps", "tests", "fixtures", "synthetic-tree.jsonl")
POLICY = R.load_policy()
TOMB = M.TOMBSTONE


def proj1(obj, **ctx):
    """P of one object alone (right for objects that need no other object's context)."""
    return P.project_tree([copy.deepcopy(obj)], **ctx)[0][obj["handle"]]


def projt(objs, **ctx):
    return P.project_tree(copy.deepcopy(list(objs)), **ctx)[0]


def ed(obj, fn):
    """A copy of ``obj`` after ``fn(copy)``."""
    out = copy.deepcopy(obj)
    fn(out)
    return out


def person(h="p1", first="Alder", evs=(), **kw):
    kw.setdefault("tag_list", [])
    return MV.PE(h, evs=evs, first=first, **kw)


def rename(first):
    return lambda o: o["primary_name"].__setitem__("first_name", first)


def mo(base, local, cloud, lp="auto", **kw):
    """merge_object with P(L) worked out from the local object alone unless given."""
    if lp == "auto":
        lp = None if local is None else proj1(local)
    return M.merge_object(base, local, lp, cloud, **kw)


def conflict_paths(result):
    return [c["path"] for c in result.conflicts]


def set_in(obj, *keys_and_value):
    *keys, value = keys_and_value
    node = obj
    for k in keys[:-1]:
        node = node[k]
    node[keys[-1]] = value


class MergeView(unittest.TestCase):
    def test_a_person_view_has_birth_and_death_refs_and_no_change_stamp(self):
        p = person(evs=("e1", "e2", "e3"), birth=1, death=2, change=1700000000)
        v = M.merge_view(p)
        self.assertNotIn("change", v)
        self.assertNotIn("birth_ref_index", v)
        self.assertEqual((v["_birth_ref"], v["_death_ref"]), ("e2#0", "e3#0"))
        self.assertIsInstance(v["event_ref_list"], M.LV)
        self.assertEqual(v["event_ref_list"].order, ["e1#0", "e2#0", "e3#0"])

    def test_the_view_renders_back_to_the_same_object_without_the_change_stamp(self):
        p = person(evs=("e1", "e2"), birth=0, death=-1, change=5, urls=[MV.URL("https://example.org/a")], tag_list=["t1", "t2"])
        out = M.render_view(M.merge_view(p))
        self.assertEqual(out, {k: v for k, v in p.items() if k != "change"})

    def test_out_of_range_and_boolean_indexes_name_no_event(self):
        v = M.merge_view(person(evs=("e1",), birth=5, death=True))
        self.assertEqual((v["_birth_ref"], v["_death_ref"]), (None, None))
        self.assertEqual(M.render_view(v)["birth_ref_index"], -1)

    def test_a_birth_ref_whose_event_is_gone_renders_as_minus_one(self):
        v = M.merge_view(person(evs=("e1", "e2"), birth=1))
        v["event_ref_list"] = M.LV("keyed", ["e1#0"], {"e1#0": v["event_ref_list"].items["e1#0"]})
        self.assertEqual(M.render_view(v)["birth_ref_index"], -1)

    def test_repeated_refs_are_keyed_by_occurrence(self):
        p = person(media_list=[MV.MR("m1", [0, 0, 5, 5]), MV.MR("m2"), MV.MR("m1", [1, 1, 9, 9])])
        self.assertEqual(M.merge_view(p)["media_list"].order, ["m1#0", "m2#0", "m1#1"])

    def test_a_child_ref_is_keyed_by_its_ref(self):
        f = MV.FA("f1", children=("c1", "c2"))
        self.assertEqual(M.merge_view(f)["child_ref_list"].order, ["c1#0", "c2#0"])

    def test_sets_and_bags_are_keyed_by_content_not_position(self):
        a = person(tag_list=["t1", "t2"], urls=[MV.URL("https://example.org/a"), MV.URL("https://example.org/b")])
        b = ed(a, lambda o: (o["tag_list"].reverse(), o["urls"].reverse()))
        va, vb = M.merge_view(a), M.merge_view(b)
        self.assertEqual(set(va["tag_list"].items), set(vb["tag_list"].items))
        self.assertEqual(set(va["urls"].items), set(vb["urls"].items))
        self.assertEqual(va["tag_list"].kind, "set")
        self.assertEqual(va["urls"].kind, "bag")

    def test_equal_set_elements_get_distinct_keys(self):
        v = M.merge_view(person(tag_list=["t1", "t1"]))
        self.assertEqual(len(v["tag_list"].items), 2)

    def test_dates_types_and_styled_text_stay_whole(self):
        e = MV.EV("e1", MV.BIRTH, MV.DATE(3, 4, 1900))
        v = M.merge_view(e)
        self.assertEqual(v["date"], e["date"])
        self.assertEqual(v["type"], e["type"])
        n = MV.NOTE("n1", "text")
        self.assertEqual(M.merge_view(n)["text"], n["text"])

    def test_keyed_lists_match_the_base_by_content_then_by_order(self):
        base = M.merge_view(person(media_list=[MV.MR("m1", [0, 0, 5, 5]), MV.MR("m2"), MV.MR("m1", [1, 1, 9, 9])]))
        # the first m1 is removed; the second keeps its key m1#1 because its content matches
        side = person(media_list=[MV.MR("m2"), MV.MR("m1", [1, 1, 9, 9])])
        self.assertEqual(M.merge_view(side, base)["media_list"].order, ["m2#0", "m1#1"])
        # a modified element is paired with the base's leftover of the same ref
        side = person(media_list=[MV.MR("m1", [0, 0, 6, 6]), MV.MR("m2"), MV.MR("m1", [1, 1, 9, 9])])
        lv = M.merge_view(side, base)["media_list"]
        self.assertEqual(lv.order, ["m1#0", "m2#0", "m1#1"])
        self.assertEqual(lv.stale, [])

    def test_a_leftover_count_that_disagrees_is_a_stale_key(self):
        base = M.merge_view(person(media_list=[MV.MR("m1", [0, 0, 5, 5]), MV.MR("m1", [1, 1, 9, 9])]))
        side = person(media_list=[MV.MR("m1", [2, 2, 8, 8])])
        lv = M.merge_view(side, base)["media_list"]
        self.assertEqual(lv.stale, ["m1"])

    def test_new_elements_get_content_keys_so_equal_additions_converge(self):
        base = M.merge_view(person(media_list=[MV.MR("m1")]))
        side = person(media_list=[MV.MR("m1"), MV.MR("m9", [1, 2, 3, 4]), MV.MR("m9", [1, 2, 3, 4])])
        order = M.merge_view(side, base)["media_list"].order
        self.assertEqual(order[0], "m1#0")
        self.assertTrue(order[1].startswith("m9#+") and order[2].startswith("m9#+") and order[1] != order[2])
        other = M.merge_view(person(media_list=[MV.MR("m1"), MV.MR("m9", [1, 2, 3, 4])]), base)["media_list"].order
        self.assertEqual(other[1], order[1])

    def test_a_reference_view_of_another_kind_is_ignored(self):
        ref = M.merge_view(person(tag_list=["t1"]))["tag_list"]
        v = M.merge_view(person(media_list=[MV.MR("m1")]), {"media_list": ref})
        self.assertEqual(v["media_list"].order, ["m1#0"])


class Equality(unittest.TestCase):
    def test_sortval_is_ignored_in_dates_only(self):
        a, b = MV.DATE(1, 2, 1900), MV.DATE(1, 2, 1900)
        b["sortval"] = 7
        self.assertTrue(M._eq(a, b))
        self.assertFalse(M._eq({"x": 1, "sortval": 1}, {"x": 1, "sortval": 2}))

    def test_values_of_different_shape_are_not_equal(self):
        lv = M.merge_view(person(tag_list=["t1"]))["tag_list"]
        for a, b in ((lv, [1]), ([1], lv), (M.MISSING, None), (None, M.MISSING), ({}, []), ([], {}), ([1], [1, 2]), ([1], {"a": 1}),
                     (True, 1), (1, 1.0), ({"a": 1}, {"b": 1}), ({"a": 1}, {"a": 2})):
            with self.subTest(a=a, b=b):
                self.assertFalse(M._eq(a, b))

    def test_list_views_compare_kind_order_and_elements(self):
        a = M.merge_view(person(tag_list=["t1", "t2"]))["tag_list"]
        b = M.merge_view(person(tag_list=["t2", "t1"]))["tag_list"]
        c = M.merge_view(person(tag_list=["t1", "t3"]))["tag_list"]
        self.assertTrue(M._eq(a, a))
        self.assertTrue(M._eq(a, M.merge_view(person(tag_list=["t1", "t2"]))["tag_list"]))
        self.assertFalse(M._eq(a, b))
        self.assertFalse(M._eq(a, c))

    def test_missing_prints_as_missing(self):
        self.assertEqual(repr(M.MISSING), "MISSING")


class FieldRules(unittest.TestCase):
    """The table of sync.md 6.3, one test per row."""

    def setUp(self):
        self.l0 = person()
        self.b = proj1(self.l0)

    def test_l_equals_c_is_converged(self):
        l, c = ed(self.l0, rename("Zed")), proj1(ed(self.l0, rename("Zed")))
        r = mo(self.b, l, c)
        self.assertEqual((r.action, r.conflicts, r.local_obj, r.push), ("update", [], None, None))
        self.assertEqual(r.base_after, c)

    def test_l_equals_b_and_c_changed_takes_the_cloud_value(self):
        c = proj1(ed(self.l0, rename("Zed")))
        r = mo(self.b, self.l0, c, cloud_version=3)
        self.assertEqual(r.local_obj["primary_name"]["first_name"], "Zed")
        self.assertIsNone(r.push)
        self.assertEqual(r.base_after, c)
        self.assertEqual(r.conflicts, [])

    def test_c_equals_b_and_l_changed_takes_the_local_value(self):
        l = ed(self.l0, rename("Zed"))
        r = mo(self.b, l, self.b, cloud_version=3)
        self.assertIsNone(r.local_obj)
        self.assertEqual(r.push["op"], "update")
        self.assertEqual(r.push["base_version"], 3)
        self.assertEqual(r.push["obj"]["primary_name"]["first_name"], "Zed")
        self.assertEqual(r.base_after, r.push["obj"])

    def test_all_three_different_is_a_conflict_the_local_value_stays_and_the_cloud_value_is_pushed(self):
        l, c = ed(self.l0, rename("Zed")), proj1(ed(self.l0, rename("Quill")))
        r = mo(self.b, l, c, cloud_version=4)
        self.assertEqual(conflict_paths(r), ["/primary_name/first_name"])
        cf = r.conflicts[0]
        self.assertEqual((cf["kind"], cf["base"], cf["cloud"], cf["local"]), ("field", "Alder", "Quill", "Zed"))
        self.assertEqual((cf["base_json"], cf["cloud_json"], cf["local_json"]), ('"Alder"', '"Quill"', '"Zed"'))
        self.assertEqual(cf["disposition"], "parked")
        self.assertIsNone(r.local_obj)         # the local value stays
        self.assertIsNone(r.push)              # the push carries the cloud value there, so nothing differs from C
        self.assertEqual(r.base_after, c)

    def test_a_gui_conflict_is_open_not_parked_and_the_id_is_stable(self):
        l, c = ed(self.l0, rename("Zed")), proj1(ed(self.l0, rename("Quill")))
        a, b = mo(self.b, l, c, mode="gui"), mo(self.b, l, c)
        self.assertEqual(a.conflicts[0]["disposition"], "open")
        self.assertEqual(a.conflicts[0]["id"], b.conflicts[0]["id"])
        self.assertTrue(a.conflicts[0]["id"].startswith("cf-"))

    def test_a_conflict_does_not_drop_unrelated_changes(self):
        l = ed(self.l0, lambda o: (rename("Zed")(o), o.__setitem__("gender", 2)))
        c = proj1(ed(self.l0, lambda o: (rename("Quill")(o), o["urls"].append(MV.URL("https://example.org/w")))))
        r = mo(self.b, l, c, cloud_version=1)
        self.assertEqual(conflict_paths(r), ["/primary_name/first_name"])
        self.assertEqual(r.push["obj"]["gender"], 2)                       # the desktop change goes up
        self.assertEqual(r.push["obj"]["primary_name"]["first_name"], "Quill")
        self.assertEqual(len(r.local_obj["urls"]), 1)                      # the web change comes down
        self.assertEqual(r.local_obj["primary_name"]["first_name"], "Zed")

    def test_a_field_missing_on_one_side_and_changed_on_the_other(self):
        b = ed(self.b, lambda o: o.__setitem__("extra", 1))
        l = ed(self.l0, lambda o: o.__setitem__("extra", 2))
        r = mo(b, l, self.b)
        self.assertEqual(conflict_paths(r), ["/extra"])
        self.assertEqual(r.conflicts[0]["absent"], ["cloud"])

    def test_a_note_text_is_one_atomic_value(self):
        n0 = MV.NOTE("n1", "plain text")
        b = proj1(n0)
        l = ed(n0, lambda o: o["text"].__setitem__("string", "local text"))
        c = proj1(ed(n0, lambda o: o["text"].__setitem__("tags", [{"_class": "StyledTextTag", "name": {"_class": "StyledTextTagType", "string": "", "value": 0}, "ranges": [[0, 3]], "value": True}])))
        r = mo(b, l, c)
        self.assertEqual(conflict_paths(r), ["/text"])

    def test_a_date_that_differs_only_in_sortval_is_not_a_change(self):
        e0 = MV.EV("e1", MV.RESIDENCE, MV.DATE(3, 4, 1900))
        b = proj1(e0)
        c = ed(b, lambda o: o["date"].__setitem__("sortval", 1))
        r = mo(b, e0, c)
        self.assertEqual((r.conflicts, r.local_obj, r.push), ([], None, None))

    def test_a_cloud_change_to_a_non_birth_like_event_type_is_taken(self):
        e0 = MV.EV("e1", MV.RESIDENCE, MV.DATE(3, 4, 1900))
        b = proj1(e0)
        c = ed(b, lambda o: o["type"].__setitem__("value", MV.MARRIAGE))
        r = mo(b, e0, c, ctx=M.merge_context([e0], [b]))
        self.assertEqual(r.conflicts, [])
        self.assertEqual(r.local_obj["type"]["value"], MV.MARRIAGE)


class DerivedChecksum(unittest.TestCase):
    """6.1: Media.checksum of a file the addon could not read is derived and never compared."""

    def setUp(self):
        self.m0 = MV.MED("m1", checksum="a" * 32)
        self.b = proj1(self.m0)

    def test_a_checksum_changed_on_both_sides_is_a_conflict_when_the_file_was_readable(self):
        l = ed(self.m0, lambda o: o.__setitem__("checksum", "b" * 32))
        c = ed(self.b, lambda o: o.__setitem__("checksum", "c" * 32))
        self.assertEqual(conflict_paths(mo(self.b, l, c)), ["/checksum"])

    def test_an_unreadable_file_keeps_each_sides_checksum_with_no_conflict(self):
        ctx = M.merge_context([self.m0], [self.b], unreadable=["m1"])
        l = ed(self.m0, lambda o: o.__setitem__("checksum", "b" * 32))
        c = ed(self.b, lambda o: o.__setitem__("checksum", "c" * 32))
        r = mo(self.b, l, c, ctx=ctx)
        self.assertEqual((r.conflicts, r.local_obj, r.push), ([], None, None))
        r = mo(self.b, l, c, ctx=ctx, project_fn=None)
        self.assertEqual(r.base_after["checksum"], "c" * 32)
        # the same checksum rule through merge_tree
        res = M.merge_tree({"m1": self.b}, {"m1": l}, {"m1": proj1(l)}, {"m1": c}, unreadable=["m1"])
        self.assertEqual(res.conflicts, [])


class CompositeRule(unittest.TestCase):
    """6.3 composite rows and the birth-like rows of BRD2 11.1: never auto-taken, parked by the CLI."""

    def test_a_cloud_change_to_a_birth_date_with_a_local_day_and_month_is_a_composite_conflict(self):
        l = MV.EV("e1", MV.BIRTH, MV.DATE(14, 2, 1900))
        b = proj1(l)
        self.assertEqual(b["date"]["dateval"][:3], [0, 0, 1900])
        c = ed(b, lambda o: o.__setitem__("date", MV.DY(1901)))
        r = mo(b, l, c)
        self.assertEqual(conflict_paths(r), ["/date"])
        cf = r.conflicts[0]
        self.assertEqual((cf["kind"], cf["disposition"]), ("composite", "parked"))
        self.assertEqual(cf["local"]["dateval"][:3], [0, 0, 1900])         # projected values only
        self.assertIsNone(r.local_obj)                                    # the day and month stay
        self.assertIsNone(r.push)

    def test_a_cloud_change_to_a_date_with_no_local_part_is_taken(self):
        l = MV.EV("e1", MV.RESIDENCE, MV.DATE(14, 2, 1900))
        b = proj1(l)
        c = ed(b, lambda o: o.__setitem__("date", MV.DATE(14, 2, 1901)))
        r = mo(b, l, c)
        self.assertEqual(r.conflicts, [])
        self.assertEqual(r.local_obj["date"]["dateval"][:3], [14, 2, 1901])

    def test_a_cloud_change_to_the_place_of_an_event_at_a_street_level_descendant_is_composite(self):
        city, other = MV.PL("pc", "Fixtureland"), MV.PL("po", "Elsewhere")
        street = MV.PL("ps", "1 Fixture Lane", t=MV.PL_STREET, parent="pc")
        l = MV.EV("e1", MV.RESIDENCE, place="ps")
        tree = projt([l, city, other, street])
        self.assertEqual(tree["e1"]["place"], "pc")
        c = ed(tree["e1"], lambda o: o.__setitem__("place", "po"))
        r = M.merge_object(tree["e1"], l, tree["e1"], c)
        self.assertEqual((conflict_paths(r), r.conflicts[0]["kind"]), (["/place"], "composite"))
        self.assertIsNone(r.local_obj)

    def test_a_cloud_change_to_a_held_field_is_composite(self):
        base_note = MV.NOTE("n1", "plain text")
        b = proj1(base_note)
        l = ed(base_note, lambda o: o["text"].__setitem__("string", "call 555-0142 today"))
        lp = proj1(l, base={"n1": b})
        self.assertEqual(lp, b)                                            # held: the cloud keeps the last synced text
        c = ed(b, lambda o: o["text"].__setitem__("string", "web text"))
        r = mo(b, l, c, lp=lp)
        self.assertEqual((conflict_paths(r), r.conflicts[0]["kind"]), (["/text"], "composite"))
        self.assertIsNone(r.local_obj)

    def test_a_cloud_change_to_the_type_of_an_event_that_is_birth_like_locally_or_at_base_is_composite(self):
        l = MV.EV("e1", MV.BIRTH, MV.DY(1900))
        b = proj1(l)
        c = ed(b, lambda o: o["type"].__setitem__("value", MV.RESIDENCE))
        for ctx in (M.merge_context([l], []), M.merge_context([], [b])):
            with self.subTest(ctx=sorted(ctx.birthlike)):
                r = mo(b, l, c, ctx=ctx)
                self.assertEqual((conflict_paths(r), r.conflicts[0]["kind"]), (["/type"], "composite"))
                self.assertEqual(r.conflicts[0]["disposition"], "parked")
                self.assertIsNone(r.local_obj)
        self.assertEqual(M.merge_context([], []).birthlike, frozenset())

    def test_a_sticky_event_counts_as_birth_like_in_the_context(self):
        self.assertEqual(M.merge_context([], [], sticky=["e9"]).birthlike, frozenset({"e9"}))

    def test_a_cloud_change_to_the_role_of_a_reference_to_a_birth_like_event_is_composite(self):
        ev = MV.EV("e1", MV.BIRTH, MV.DY(1900))
        l = person(evs=("e1",), birth=0)
        b = proj1(l)
        c = ed(b, lambda o: o["event_ref_list"][0]["role"].__setitem__("value", 2))
        r = mo(b, l, c, ctx=M.merge_context([ev, l], []))
        self.assertEqual((conflict_paths(r), r.conflicts[0]["kind"]), (["/event_ref_list/e1#0/role"], "composite"))
        # the same change on a reference to an event that is not birth-like is taken
        quiet = MV.EV("e1", MV.RESIDENCE, MV.DY(1900))
        l2 = person(evs=("e1",))
        r = mo(proj1(l2), l2, ed(proj1(l2), lambda o: o["event_ref_list"][0]["role"].__setitem__("value", 2)),
               ctx=M.merge_context([quiet, l2], []))
        self.assertEqual(r.conflicts, [])
        self.assertEqual(r.local_obj["event_ref_list"][0]["role"]["value"], 2)

    def test_a_cloud_change_to_the_birth_ref_of_a_person_is_composite_when_either_event_is_birth_like(self):
        birth = MV.EV("e1", MV.BIRTH, MV.DY(1900))
        res = MV.EV("e2", MV.RESIDENCE, MV.DY(1901))
        l = person(evs=("e1", "e2"), birth=0)
        b = proj1(l)
        c = ed(b, lambda o: o.__setitem__("birth_ref_index", 1))
        r = mo(b, l, c, ctx=M.merge_context([birth, res, l], []))
        self.assertEqual((conflict_paths(r), r.conflicts[0]["kind"]), (["/_birth_ref"], "composite"))
        self.assertEqual((r.conflicts[0]["base"], r.conflicts[0]["cloud"]), ("e1#0", "e2#0"))
        self.assertIsNone(r.local_obj)
        # from none to an event that is birth-like by its type
        none = person(evs=("e1", "e2"), birth=-1)
        r = mo(proj1(none), none, ed(proj1(none), lambda o: o.__setitem__("birth_ref_index", 0)),
               ctx=M.merge_context([birth, res, none], []))
        self.assertEqual(conflict_paths(r), ["/_birth_ref"])

    def test_a_birth_ref_change_between_events_that_are_not_birth_like_is_taken(self):
        a, b_ = MV.EV("e1", MV.RESIDENCE, MV.DY(1900)), MV.EV("e2", MV.MARRIAGE, MV.DY(1901))
        l = person(evs=("e1", "e2"), birth=-1)
        r = mo(proj1(l), l, ed(proj1(l), lambda o: o.__setitem__("birth_ref_index", 1)), ctx=M.merge_context([a, b_, l], []))
        self.assertEqual(r.conflicts, [])
        self.assertEqual(r.local_obj["birth_ref_index"], 1)

    def test_a_composite_conflict_is_listed_again_each_run_and_never_resolves_itself(self):
        l = MV.EV("e1", MV.BIRTH, MV.DATE(14, 2, 1900))
        b = proj1(l)
        c = ed(b, lambda o: o.__setitem__("date", MV.DY(1901)))
        for _ in range(3):
            r = mo(b, l, c)
            self.assertEqual(conflict_paths(r), ["/date"])


class Lists(unittest.TestCase):
    def media(self, *refs):
        return person(media_list=list(refs))

    def test_a_rect_edited_on_the_web_and_a_note_edited_on_the_desktop_both_survive(self):
        l0 = self.media(MV.MR("m1", [0, 0, 50, 50]))
        b = proj1(l0)
        l = ed(l0, lambda o: o["media_list"][0]["note_list"].append("n1"))
        c = ed(b, lambda o: o["media_list"][0].__setitem__("rect", [0, 0, 60, 60]))
        r = mo(b, l, c, cloud_version=2)
        self.assertEqual(r.conflicts, [])
        for got in (r.local_obj, r.push["obj"]):
            self.assertEqual(got["media_list"][0]["rect"], [0, 0, 60, 60])
            self.assertEqual(got["media_list"][0]["note_list"], ["n1"])

    def test_additions_on_both_sides_keep_the_local_order_and_the_cloud_ones_go_after_their_predecessor(self):
        l0 = self.media(MV.MR("m1"), MV.MR("m2"))
        b = proj1(l0)
        l = ed(l0, lambda o: o["media_list"].insert(1, MV.MR("m3")))
        c = ed(b, lambda o: o["media_list"].insert(1, MV.MR("m4")))
        r = mo(b, l, c, cloud_version=1)
        order = lambda o: [e["ref"] for e in o["media_list"]]  # noqa: E731
        self.assertEqual(order(r.local_obj), ["m1", "m4", "m3", "m2"])
        self.assertEqual(order(r.push["obj"]), ["m1", "m4", "m3", "m2"])

    def test_a_removal_of_an_unchanged_element_is_taken_from_either_side(self):
        l0 = self.media(MV.MR("m1"), MV.MR("m2"))
        b = proj1(l0)
        c = ed(b, lambda o: o["media_list"].pop(0))
        r = mo(b, l0, c)
        self.assertEqual([e["ref"] for e in r.local_obj["media_list"]], ["m2"])
        l = ed(l0, lambda o: o["media_list"].pop(1))
        r = mo(b, l, b, cloud_version=1)
        self.assertEqual([e["ref"] for e in r.push["obj"]["media_list"]], ["m1"])

    def test_a_removal_against_an_edit_of_the_same_element_is_a_list_conflict(self):
        l0 = self.media(MV.MR("m1", [0, 0, 50, 50]))
        b = proj1(l0)
        gone = ed(l0, lambda o: o["media_list"].pop())
        edited = ed(b, lambda o: o["media_list"][0].__setitem__("rect", [0, 0, 60, 60]))
        r = mo(b, gone, edited, cloud_version=1)
        self.assertEqual((conflict_paths(r), r.conflicts[0]["kind"]), (["/media_list/m1#0"], "list"))
        self.assertEqual(r.conflicts[0]["absent"], ["local"])
        self.assertIsNone(r.push)                          # the cloud element stays; nothing differs from C
        edited_local = ed(l0, lambda o: o["media_list"][0].__setitem__("rect", [0, 0, 70, 70]))
        r = mo(b, edited_local, ed(b, lambda o: o["media_list"].pop()), cloud_version=1)
        self.assertEqual((conflict_paths(r), r.conflicts[0]["absent"]), (["/media_list/m1#0"], ["cloud"]))
        self.assertIsNone(r.local_obj)

    def test_the_same_field_of_one_element_edited_on_both_sides_is_a_field_conflict_below_the_element(self):
        l0 = self.media(MV.MR("m1", [0, 0, 50, 50]))
        b = proj1(l0)
        l = ed(l0, lambda o: o["media_list"][0].__setitem__("rect", [0, 0, 70, 70]))
        c = ed(b, lambda o: o["media_list"][0].__setitem__("rect", [0, 0, 60, 60]))
        r = mo(b, l, c)
        self.assertEqual((conflict_paths(r), r.conflicts[0]["kind"]), (["/media_list/m1#0/rect"], "field"))

    def test_elements_that_cannot_be_matched_to_the_base_are_a_stale_key_conflict(self):
        l0 = self.media(MV.MR("m1", [0, 0, 5, 5]), MV.MR("m1", [1, 1, 9, 9]))
        b = proj1(l0)
        l = ed(l0, lambda o: [e.__setitem__("rect", [2, 2, 8, 8]) for e in o["media_list"]])
        c = ed(b, lambda o: (o["media_list"].pop(), o["media_list"][0].__setitem__("rect", [3, 3, 4, 4])))
        for local, cloud in ((l, c), (c, l)):
            r = mo(b, local, cloud)
            self.assertEqual((conflict_paths(r), r.conflicts[0]["kind"]), (["/media_list"], "list"))
            self.assertIn("stale key", r.conflicts[0]["reason"])

    def test_sets_take_additions_from_both_sides_and_removals_from_either(self):
        l0 = person(tag_list=["t1", "t2"], family_list=[], note_list=["n1"])
        b = proj1(l0)
        l = ed(l0, lambda o: (o["tag_list"].append("t3"), o["note_list"].clear()))
        c = ed(b, lambda o: (o["tag_list"].remove("t1"), o["tag_list"].append("t4")))
        r = mo(b, l, c, cloud_version=1)
        self.assertEqual(r.conflicts, [])
        self.assertEqual(sorted(r.local_obj["tag_list"]), ["t2", "t3", "t4"])
        self.assertEqual(sorted(r.push["obj"]["tag_list"]), ["t2", "t3", "t4"])
        self.assertEqual(r.push["obj"]["note_list"], [])

    def test_bags_take_additions_and_removals_by_content(self):
        l0 = person(urls=[MV.URL("https://example.org/a"), MV.URL("https://example.org/b")])
        b = proj1(l0)
        l = ed(l0, lambda o: (o["urls"].pop(0), o["urls"].append(MV.URL("https://example.org/l"))))
        c = ed(b, lambda o: o["urls"].append(MV.URL("https://example.org/c")))
        r = mo(b, l, c, cloud_version=1)
        paths = lambda o: sorted(x["path"] for x in o["urls"])  # noqa: E731
        want = ["https://example.org/b", "https://example.org/c", "https://example.org/l"]
        self.assertEqual((paths(r.local_obj), paths(r.push["obj"])), (want, want))

    def test_a_base_element_replaced_differently_on_both_sides_is_an_ambiguous_pairing_conflict(self):
        l0 = person(urls=[MV.URL("https://example.org/a")])
        b = proj1(l0)
        l = ed(l0, lambda o: o["urls"][0].__setitem__("path", "https://example.org/l"))
        c = ed(b, lambda o: o["urls"][0].__setitem__("path", "https://example.org/c"))
        r = mo(b, l, c)
        self.assertEqual((conflict_paths(r), r.conflicts[0]["kind"]), (["/urls"], "list"))
        self.assertIn("ambiguous pairing", r.conflicts[0]["reason"])
        # the same replacement on both sides, or a replacement on one side and a plain removal on the other, is not ambiguous
        r = mo(b, l, ed(b, lambda o: o["urls"][0].__setitem__("path", "https://example.org/l")))
        self.assertEqual(r.conflicts, [])
        r = mo(b, l, ed(b, lambda o: o["urls"].clear()))
        self.assertEqual(r.conflicts, [])

    def test_a_bag_element_both_sides_dropped_with_an_unrelated_addition_each_is_conservatively_a_conflict(self):
        # An edited bag element is a removal plus an addition, so this cannot be told from "both replaced it": the engine asks.
        l0 = person(urls=[MV.URL("https://example.org/a")])
        b = proj1(l0)
        l = ed(l0, lambda o: o["urls"].__setitem__(0, MV.URL("https://example.org/x")))
        c = ed(b, lambda o: o["urls"].__setitem__(0, MV.URL("https://example.org/y")))
        r = mo(b, l, c)
        self.assertEqual((conflict_paths(r), r.conflicts[0]["kind"]), (["/urls"], "list"))
        self.assertEqual((r.local_obj, r.push), (None, None))

    def test_a_private_duplicate_of_a_keyed_element_does_not_freeze_the_object_while_the_public_one_matches_the_base(self):
        l = ed(person(media_list=[]), lambda o: o["media_list"].extend([MV.MR("m1", private=True), MV.MR("m1")]))
        lp = proj1(l)
        self.assertEqual(len(lp["media_list"]), 1)
        b = copy.deepcopy(lp)
        c = ed(b, lambda o: o.__setitem__("gender", 2))
        r = M.merge_object(b, l, lp, c, cloud_version=2, project_fn=proj1)
        self.assertEqual((r.action, r.conflicts), ("update", []))
        self.assertEqual(r.local_obj["gender"], 2)
        self.assertEqual([m.get("private") for m in r.local_obj["media_list"]], [True, False])      # the private copy survives
        self.assertIsNone(r.push)

    def test_a_bag_inside_a_nested_object_merges_too(self):
        l0 = person()
        b = proj1(l0)
        extra = lambda name: {"_class": "Surname", "primary": False, "surname": name}  # noqa: E731
        l = ed(l0, lambda o: o["primary_name"]["surname_list"].append(extra("Local")))
        c = ed(b, lambda o: o["primary_name"]["surname_list"].append(extra("Cloud")))
        r = mo(b, l, c, cloud_version=1)
        self.assertEqual(sorted(s["surname"] for s in r.push["obj"]["primary_name"]["surname_list"]), ["Cloud", "Local", "Testwood"])

    @staticmethod
    def kids(obj):
        return [e["ref"] for e in obj["child_ref_list"]]

    def test_a_list_reordered_on_one_side_keeps_that_order_and_the_other_sides_additions_go_after_their_predecessor(self):
        l0 = MV.FA("f1", children=("a", "b"))
        b = proj1(l0)
        reversed_ = ed(l0, lambda o: o["child_ref_list"].reverse())
        # the cloud adds at the front, the desktop reordered
        r = mo(b, reversed_, ed(b, lambda o: o["child_ref_list"].insert(0, MV.CHREF("x"))), cloud_version=1)
        self.assertEqual(self.kids(r.push["obj"]), ["x", "b", "a"])
        # the cloud adds after a, the desktop reordered
        r = mo(b, reversed_, ed(b, lambda o: o["child_ref_list"].insert(1, MV.CHREF("y"))), cloud_version=1)
        self.assertEqual(self.kids(r.push["obj"]), ["b", "a", "y"])
        self.assertEqual(r.autos, [])
        # the cloud reordered, the desktop adds at the end: the cloud order wins
        r = mo(b, ed(l0, lambda o: o["child_ref_list"].append(MV.CHREF("z"))), ed(b, lambda o: o["child_ref_list"].reverse()),
               cloud_version=1)
        self.assertEqual(self.kids(r.local_obj), ["b", "z", "a"])

    def test_a_list_reordered_on_both_sides_keeps_the_local_order_appends_cloud_only_keys_and_logs_it(self):
        l0 = MV.FA("f1", children=("a", "b", "c"))
        b = proj1(l0)
        l = ed(l0, lambda o: o["child_ref_list"].reverse())
        c = ed(b, lambda o: (o["child_ref_list"].append(o["child_ref_list"].pop(0)), o["child_ref_list"].append(MV.CHREF("d"))))
        r = mo(b, l, c, cloud_version=1)
        self.assertEqual(self.kids(r.push["obj"]), ["c", "b", "a", "d"])
        self.assertEqual(r.autos, [{"path": "/child_ref_list", "kind": "order",
                                    "detail": "both sides reordered; the local order is kept and the cloud-only keys are appended"}])
        self.assertEqual(r.conflicts, [])


class ObjectTable(unittest.TestCase):
    """The object-level table of sync.md 6.4, every row, and the cases around it."""

    def setUp(self):
        self.l0 = person()
        self.b = proj1(self.l0)
        self.c = proj1(ed(self.l0, rename("Zed")))

    # ---- B absent, L absent, C present
    def test_row_absent_absent_present_creates_locally(self):
        r = mo(None, None, self.c)
        self.assertEqual(json.loads(json.dumps(r.as_dict()))["action"], "create_local")
        self.assertEqual((r.action, r.local_obj, r.push, r.base_after), ("create_local", self.c, None, self.c))
        self.assertIsNot(r.local_obj, self.c)

    # ---- B absent, L present, C absent
    def test_row_absent_present_absent_pushes_a_create(self):
        r = mo(None, self.l0, None)
        self.assertEqual(r.action, "push_create")
        self.assertEqual(r.push, {"op": "create", "class": "Person", "handle": "p1", "base_version": None, "obj": self.b})
        self.assertEqual(r.base_after, self.b)

    def test_an_object_nobody_changed_is_left_alone_without_building_views(self):
        r = mo(self.b, self.l0, copy.deepcopy(self.b))
        self.assertEqual((r.action, r.local_obj, r.push, r.conflicts, r.base_after), ("unchanged", None, None, [], self.b))
        # an open pin on a path keeps the object out of the fast path, so the pin can be found closed
        pinned = mo(self.b, self.l0, copy.deepcopy(self.b), pins=[{"path": "/primary_name/first_name", "base_json": '"Old"'}])
        self.assertEqual((pinned.action, pinned.closed), ("update", ["/primary_name/first_name"]))

    def test_a_local_create_against_a_tombstone_resurrects_it_at_the_tombstone_version(self):
        r = mo(None, self.l0, TOMB, cloud_version=5)
        self.assertEqual((r.action, r.push["op"], r.push["base_version"]), ("push_create", "create", 5))

    # ---- B present, L present, C tombstone
    def test_row_present_present_tombstone_deletes_locally_when_the_local_object_is_unchanged(self):
        gui = mo(self.b, self.l0, TOMB, mode="gui")
        self.assertEqual((gui.action, gui.needs_confirmation, gui.base_after), ("delete_local", True, None))
        cli = mo(self.b, self.l0, TOMB, mode="cli", allow_deletes=True)
        self.assertEqual((cli.action, cli.needs_confirmation), ("delete_local", False))
        held = mo(self.b, self.l0, TOMB, mode="cli")
        self.assertEqual(held.action, "delete_deferred")
        self.assertIn("allow_deletes", held.deferred)
        self.assertIsNone(held.local_obj)

    def test_row_present_present_tombstone_is_a_delete_edit_conflict_when_the_local_object_changed(self):
        l = ed(self.l0, rename("Zed"))
        for mode in ("cli", "gui"):
            r = mo(self.b, l, TOMB, mode=mode)
            cf = r.conflicts[0]
            self.assertEqual((r.action, cf["kind"], cf["path"]), ("conflict", "delete_edit", ""))
            self.assertEqual(cf["reason"], "edited on the desktop, deleted on the website")
            self.assertEqual(cf["lost"], ["/primary_name/first_name"])
            self.assertEqual((cf["cloud"], cf["cloud_json"], r.base_after), (TOMB, None, self.b))
            self.assertEqual(cf["disposition"], "parked" if mode == "cli" else "open")

    def test_a_tombstone_for_an_object_with_a_local_only_part_is_a_delete_edit_with_the_desktop_only_reason(self):
        for part in (lambda o: o["address_list"].append(MV.ADDR()),
                     lambda o: o["alternate_names"].append(MV.NAME("Hid", "Den", private=True)),
                     lambda o: o["lds_ord_list"].append(MV.LDS())):
            l = ed(self.l0, part)
            self.assertEqual(proj1(l), self.b)
            r = mo(self.b, l, TOMB)
            self.assertEqual((r.action, r.conflicts[0]["kind"], r.conflicts[0]["reason"]),
                             ("conflict", "delete_edit", "has desktop-only data"))
            self.assertEqual(r.conflicts[0]["disposition"], "parked")
            self.assertIsNone(r.local_obj)

    def test_a_tombstone_for_an_object_with_a_shared_edit_and_a_desktop_only_part_names_both(self):
        l = ed(self.l0, lambda o: (rename("Zed")(o), o["address_list"].append(MV.ADDR())))
        lp = proj1(l)
        self.assertNotEqual(lp, self.b)
        r = mo(self.b, l, TOMB)
        cf = r.conflicts[0]
        self.assertEqual((r.action, cf["kind"], cf["reason"]), ("conflict", "delete_edit", "has desktop-only data"))
        self.assertEqual(cf["lost_edited"], ["/primary_name/first_name"])
        self.assertEqual(cf["lost_desktop_only"], ["/address_list"])
        self.assertEqual(cf["lost"], ["/primary_name/first_name", "/address_list"])
        self.assertIsNone(r.local_obj)
        # a shared edit alone keeps its own reason, and its desktop-only list is empty
        only = mo(self.b, ed(self.l0, rename("Zed")), TOMB).conflicts[0]
        self.assertEqual((only["reason"], only["lost_desktop_only"]), ("edited on the desktop, deleted on the website", []))

    def test_a_tombstone_for_a_held_object_part_is_a_delete_edit_with_the_desktop_only_reason(self):
        n0 = MV.NOTE("n1", "plain text")
        b = proj1(n0)
        l = ed(n0, lambda o: o["text"].__setitem__("string", "call 555-0142 today"))
        r = mo(b, l, TOMB, lp=proj1(l, base={"n1": b}))
        self.assertEqual(r.conflicts[0]["reason"], "has desktop-only data")
        self.assertEqual(r.conflicts[0]["lost"], ["/text/string"])

    # ---- B present, L absent, C present
    def test_row_present_absent_present_pushes_a_delete_when_the_cloud_is_unchanged(self):
        r = mo(self.b, None, copy.deepcopy(self.b), cloud_version=4)
        self.assertEqual((r.action, r.needs_step_up, r.base_after), ("push_delete", True, None))
        self.assertEqual(r.push, {"op": "delete", "class": "Person", "handle": "p1", "base_version": 4, "obj": None})

    def test_row_present_absent_present_is_a_delete_edit_conflict_when_the_cloud_changed(self):
        r = mo(self.b, None, self.c)
        cf = r.conflicts[0]
        self.assertEqual((r.action, cf["kind"], cf["reason"]), ("conflict", "delete_edit", "deleted on the desktop, edited on the website"))
        self.assertEqual((cf["local"], cf["absent"], r.base_after, r.push), (None, ["local"], self.b, None))

    # ---- B present, L absent, C tombstone
    def test_row_present_absent_tombstone_drops_the_base_row(self):
        r = mo(self.b, None, TOMB)
        self.assertEqual((r.action, r.base_after, r.push, r.local_obj), ("drop_base", None, None, None))

    # ---- B absent, L present, C present
    def test_row_absent_present_present_is_converged_when_the_projection_equals_the_cloud_object(self):
        r = mo(None, self.l0, copy.deepcopy(self.b))
        self.assertEqual((r.action, r.base_after, r.push, r.local_obj), ("converged", self.b, None, None))

    def test_row_absent_present_present_is_a_conflict_otherwise_and_is_never_auto_pushed(self):
        r = mo(None, self.l0, self.c)
        cf = r.conflicts[0]
        self.assertEqual((r.action, cf["kind"], cf["absent"]), ("conflict", "field", ["base"]))
        self.assertEqual(cf["differs"], ["/primary_name/first_name"])
        self.assertEqual((r.push, r.local_obj, r.base_after), (None, None, None))

    # ---- the cases around the table
    def test_nothing_anywhere_is_nothing(self):
        for cloud in (None, TOMB):
            r = mo(None, None, cloud)
            self.assertEqual((r.action, r.local_obj, r.push, r.base_after, r.conflicts), ("noop", None, None, None, []))

    def test_a_local_object_the_cloud_must_not_have_is_left_alone(self):
        priv = person(private=True)
        self.assertIsNone(proj1(priv))
        r = M.merge_object(None, priv, None, None)
        self.assertEqual((r.action, r.local_obj, r.push, r.base_after), ("excluded", None, None, None))

    def test_an_object_that_became_excluded_after_it_was_synced_is_withdrawn_without_a_step_up(self):
        priv = ed(self.l0, lambda o: o.__setitem__("private", True))
        self.assertIsNone(proj1(priv))
        for cloud in (copy.deepcopy(self.b), self.c):                       # whatever the website did to the copy meanwhile
            r = M.merge_object(self.b, priv, None, cloud, cloud_version=6)
            self.assertEqual((r.action, r.needs_step_up, r.base_after, r.local_obj, r.conflicts), ("withdraw", False, None, None, []))
            self.assertEqual(r.push, {"op": "withdraw", "class": "Person", "handle": "p1", "base_version": 6, "obj": None})
        for cloud in (TOMB, None):                                          # nothing left in the cloud to withdraw
            r = M.merge_object(self.b, priv, None, cloud)
            self.assertEqual((r.action, r.push, r.base_after), ("drop_base", None, None))

    def test_a_missing_cloud_head_for_a_known_object_is_an_identity_conflict(self):
        r = mo(self.b, self.l0, None)
        self.assertEqual((r.action, r.conflicts[0]["kind"], r.base_after), ("conflict", "identity", self.b))

    def test_a_pin_on_the_whole_object_is_re_evaluated_and_derives_its_kind_and_reason(self):
        # the sidecar stores only a path and a base; the kind and the reason come from the object's situation each run
        l = ed(self.l0, rename("Zed"))
        for pin in ({"path": "", "base_json": None}, {"path": "", "base_json": None, "kind": "integrity", "reason": "stale text"}):
            r = mo(self.b, l, TOMB, pins=[pin], mode="gui")
            cf = r.conflicts[0]
            self.assertEqual((r.action, r.local_obj, r.push, r.base_after), ("conflict", None, None, self.b))
            self.assertEqual((cf["kind"], cf["reason"], cf["disposition"]), ("delete_edit", "edited on the desktop, deleted on the website", "open"))
            self.assertEqual((cf["id"], r.closed), (mo(self.b, l, TOMB).conflicts[0]["id"], []))
        missing = mo(self.b, self.l0, None, pins=[{"path": ""}])
        self.assertEqual((missing.conflicts[0]["kind"], missing.closed), ("identity", []))
        gone = mo(self.b, None, self.c, pins=[{"path": ""}])
        self.assertEqual((gone.conflicts[0]["kind"], gone.closed), ("delete_edit", []))

    def test_a_pin_on_the_whole_object_closes_when_its_cause_is_gone(self):
        l = ed(self.l0, rename("Zed"))
        r = mo(self.b, l, copy.deepcopy(self.b), pins=[{"path": ""}], cloud_version=3)          # the website undeleted it
        self.assertEqual((r.closed, r.conflicts), ([""], []))
        self.assertEqual(r.action, "update")
        self.assertEqual(r.push["obj"]["primary_name"]["first_name"], "Zed")
        r = mo(self.b, None, copy.deepcopy(self.b), pins=[{"path": ""}])                        # an identity or delete cause that moved on
        self.assertEqual((r.closed, r.action), ([""], "push_delete"))

    def test_a_parked_delete_edit_conflict_stays_open_and_unchanged_for_three_more_runs(self):
        for mode in ("cli", "gui"):
            with self.subTest(mode=mode):
                side = Sidecar(self.b, TOMB, ed(self.l0, rename("Zed")))
                local_before = M._dump(side.local)
                first = side.run(mode)
                self.assertEqual((first.action, conflict_paths(first)), ("conflict", [""]))
                self.assertEqual(side.pins, [{"path": "", "base_json": M._dump(self.b)}])
                for _ in range(3):
                    r = side.run(mode)
                    self.assertEqual((r.action, conflict_paths(r), r.closed), ("conflict", [""], []))
                    self.assertEqual((r.conflicts[0]["kind"], r.conflicts[0]["id"]), ("delete_edit", first.conflicts[0]["id"]))
                    self.assertEqual((r.local_obj, r.push), (None, None))
                self.assertEqual((M._dump(side.local), side.cloud, side.base), (local_before, TOMB, self.b))
                # the website brings the object back: the pin closes and the desktop edit is pushed
                side.cloud, side.version = copy.deepcopy(self.b), 7
                r = side.run(mode)
                self.assertEqual((r.closed, r.conflicts, r.action), ([""], [], "update"))
                self.assertEqual(side.pins, [])
                self.assertEqual(side.cloud["primary_name"]["first_name"], "Zed")

    def test_a_parked_identity_conflict_stays_open_and_a_transient_one_closes(self):
        side = Sidecar(self.b, None, self.l0)
        for _ in range(4):
            r = side.run()
            self.assertEqual((r.conflicts[0]["kind"], r.closed), ("identity", []))
        side.cloud = copy.deepcopy(self.b)
        r = side.run()
        self.assertEqual((r.closed, r.conflicts), ([""], []))

    def test_a_lift_that_cannot_be_made_safely_becomes_an_integrity_conflict(self):
        l = ed(person(media_list=[]), lambda o: o["media_list"].extend([MV.MR("m1", private=True), MV.MR("m1", [1.5, 0, 5, 5])]))
        lp = proj1(l)
        self.assertEqual(len(lp["media_list"]), 1)
        b = copy.deepcopy(lp)
        with self.assertRaises(M.LiftError):
            M.lift(lp, l, lp)
        r = M.merge_object(b, l, lp, ed(b, lambda o: o.__setitem__("gender", 2)))
        self.assertEqual((r.action, r.conflicts[0]["kind"], r.base_after), ("conflict", "integrity", b))
        self.assertIn("cannot lift safely", r.conflicts[0]["reason"])


class Sidecar:
    """The little of the addon's sidecar and Gramps the multi-run tests need: the base row, the open pins, the cloud head and the
    local object, to which a run applies what it decided."""

    def __init__(self, base, cloud, local):
        self.base, self.cloud, self.local, self.version, self.pins = base, cloud, local, 2, []

    def run(self, mode="cli"):
        r = M.merge_object(self.base, self.local, proj1(self.local), self.cloud, cloud_version=self.version, pins=self.pins,
                           project_fn=proj1, mode=mode)
        for c in r.conflicts:
            if not any(p["path"] == c["path"] for p in self.pins):
                self.pins.append({"path": c["path"], "base_json": c["base_json"]})
        self.pins = [p for p in self.pins if p["path"] not in r.closed]
        if r.push:
            assert r.push["base_version"] == self.version, "409"
            self.cloud, self.version = r.push["obj"], self.version + 1
        if r.local_obj:
            self.local = r.local_obj
        self.base = r.base_after
        return r


class Pinning(unittest.TestCase):
    """BRD2 11.1 (6.7): an open conflict pins its path; a base row that advances can never settle it silently."""

    def setUp(self):
        self.l0 = person()
        self.b = proj1(self.l0)
        self.mine = ed(self.l0, rename("Zed"))
        self.theirs = proj1(ed(self.l0, rename("Quill")))

    def test_without_a_pin_the_next_run_would_silently_push_the_local_value_over_the_website_change(self):
        silent = mo(self.theirs, self.mine, self.theirs, cloud_version=2)    # the base row advanced to the cloud copy
        self.assertEqual(silent.conflicts, [])
        self.assertEqual(silent.push["obj"]["primary_name"]["first_name"], "Zed")

    def test_a_parked_cli_conflict_and_a_skipped_gui_conflict_stay_open_and_unchanged_for_three_more_runs(self):
        for mode in ("cli", "gui"):
            with self.subTest(mode=mode):
                side = Sidecar(self.b, self.theirs, self.mine)
                local_before, cloud_before = M._dump(self.mine), M._dump(self.theirs)
                first = side.run(mode)
                self.assertEqual(conflict_paths(first), ["/primary_name/first_name"])
                self.assertEqual(side.base, self.theirs)                  # the base row advanced; the pin holds the old base
                self.assertEqual(side.pins, [{"path": "/primary_name/first_name", "base_json": '"Alder"'}])
                ids = {first.conflicts[0]["id"]}
                for _ in range(3):
                    r = side.run(mode)
                    self.assertEqual(conflict_paths(r), ["/primary_name/first_name"])
                    self.assertEqual({c["id"] for c in r.conflicts}, ids)
                    self.assertEqual((r.local_obj, r.push, r.closed), (None, None, []))   # no write, no push op
                    self.assertEqual(r.conflicts[0]["disposition"], "parked" if mode == "cli" else "open")
                self.assertEqual((M._dump(side.local), M._dump(side.cloud)), (local_before, cloud_before))
                self.assertEqual(side.version, 2)

    def test_the_push_carries_the_cloud_value_at_the_pinned_path_while_other_edits_go_up_and_come_down(self):
        side = Sidecar(self.b, self.theirs, self.mine)
        side.run()
        side.local = ed(side.local, lambda o: o.__setitem__("gender", 2))
        r = side.run()
        self.assertEqual(r.push["obj"]["primary_name"]["first_name"], "Quill")
        self.assertEqual(r.push["obj"]["gender"], 2)
        self.assertIsNone(r.local_obj)
        # a later website change elsewhere comes down, and the pinned path keeps the local value
        side.cloud = ed(side.cloud, lambda o: o["urls"].append(MV.URL("https://example.org/w")))
        side.version += 1
        r = side.run()
        self.assertEqual(r.local_obj["primary_name"]["first_name"], "Zed")
        self.assertEqual(len(r.local_obj["urls"]), 1)
        self.assertEqual(conflict_paths(r), ["/primary_name/first_name"])

    def test_a_pin_closes_when_the_path_converges_or_becomes_one_sided(self):
        for name, local, cloud, want_first_name in (
                ("converged", ed(self.l0, rename("Quill")), self.theirs, "Quill"),
                ("local back to base", self.l0, self.theirs, "Quill"),
                ("cloud back to base", self.mine, self.b, "Zed")):
            with self.subTest(name):
                side = Sidecar(self.b, self.theirs, self.mine)
                side.run()
                side.local, side.cloud = local, cloud
                r = side.run()
                self.assertEqual((r.conflicts, r.closed), ([], ["/primary_name/first_name"]))
                self.assertEqual(side.pins, [])
                self.assertEqual(side.local["primary_name"]["first_name"], want_first_name)

    def test_a_pin_on_a_bag_and_a_pin_on_a_path_absent_at_the_base_both_hold(self):
        l0 = person(urls=[MV.URL("https://example.org/a")])
        b = proj1(l0)
        mine = ed(l0, lambda o: o["urls"][0].__setitem__("path", "https://example.org/l"))
        theirs = ed(b, lambda o: o["urls"][0].__setitem__("path", "https://example.org/c"))
        side = Sidecar(b, theirs, mine)
        for _ in range(3):
            r = side.run()
            self.assertEqual((conflict_paths(r), r.local_obj, r.push), (["/urls"], None, None))
        # a field the base does not have, added differently on both sides
        side = Sidecar(self.b, ed(self.b, lambda o: o.__setitem__("extra", 2)), ed(self.l0, lambda o: o.__setitem__("extra", 1)))
        for _ in range(3):
            r = side.run()
            self.assertEqual((conflict_paths(r), r.conflicts[0]["absent"], r.push), (["/extra"], ["base"], None))
        self.assertEqual(side.pins, [{"path": "/extra", "base_json": None}])

    def test_a_composite_conflict_is_pinned_too(self):
        l = MV.EV("e1", MV.BIRTH, MV.DATE(14, 2, 1900))
        b = proj1(l)
        side = Sidecar(b, ed(b, lambda o: o.__setitem__("date", MV.DY(1901))), l)
        for _ in range(4):
            r = side.run()
            self.assertEqual((conflict_paths(r), r.local_obj, r.push), (["/date"], None, None))
        self.assertEqual(side.local, l)


class FakeCloud:
    """A store with versions: a push whose base_version is not the head's is a 409."""

    def __init__(self, obj):
        self.obj, self.version = obj, 1

    def edit(self, fn):
        self.obj = ed(self.obj, fn)
        self.version += 1

    def push(self, op):
        if op["base_version"] != self.version:
            raise AssertionError("409")
        self.obj, self.version = op["obj"], self.version + 1


class Convergence(unittest.TestCase):
    def test_a_web_edit_to_field_a_and_a_desktop_edit_to_field_b_converge_in_one_run_without_a_409(self):
        l0 = person()
        b = proj1(l0)
        cloud = FakeCloud(b)
        cloud.edit(lambda o: o.__setitem__("gender", 2))                      # the web edits field a
        local = ed(l0, rename("Zed"))                                         # the desktop edits field b
        r = M.merge_object(b, local, proj1(local), cloud.obj, cloud_version=cloud.version, project_fn=proj1)
        self.assertEqual(r.conflicts, [])
        self.assertEqual(r.push["base_version"], cloud.version)               # C.version
        cloud.push(r.push)                                                    # no 409
        self.assertEqual((cloud.obj["gender"], cloud.obj["primary_name"]["first_name"]), (2, "Zed"))
        self.assertEqual((r.local_obj["gender"], r.local_obj["primary_name"]["first_name"]), (2, "Zed"))
        self.assertEqual(proj1(r.local_obj), cloud.obj)                       # Gramps and the cloud agree
        # base after the ack is the pushed object; the next run has nothing to do
        again = M.merge_object(r.base_after, r.local_obj, proj1(r.local_obj), cloud.obj, cloud_version=cloud.version, project_fn=proj1)
        self.assertEqual((again.conflicts, again.local_obj, again.push), ([], None, None))

    def test_the_push_object_is_the_projection_of_the_lifted_merge_with_the_desktop_only_parts_removed(self):
        l0 = person()
        b = proj1(l0)
        local = ed(l0, lambda o: (rename("Zed")(o), o["address_list"].append(MV.ADDR())))
        c = ed(b, lambda o: o.__setitem__("gender", 2))
        r = M.merge_object(b, local, proj1(local), c, cloud_version=7, project_fn=proj1)
        self.assertEqual(r.push["obj"]["address_list"], [])
        self.assertEqual(len(r.local_obj["address_list"]), 1)
        self.assertEqual(r.push["obj"]["primary_name"]["first_name"], "Zed")
        self.assertEqual(r.push["obj"]["gender"], 2)

    def test_a_project_fn_that_holds_a_field_changes_what_is_pushed(self):
        l0 = person()
        b = proj1(l0)
        local = ed(l0, rename("Zed"))
        r = M.merge_object(b, local, proj1(local), b, cloud_version=1, project_fn=lambda o: ed(o, rename("Alder")))
        self.assertIsNone(r.push)                 # held back: the projection of the lifted merge equals the cloud object


class TombstoneOfFixtureBirthEvent(unittest.TestCase):
    """AC: an incoming tombstone for an object that holds desktop-only data is a delete_edit conflict (CLI always parks)."""

    def test_a_birth_event_with_a_day_and_a_month_is_not_deleted_by_a_website_delete(self):
        fixture = {o["handle"]: o for o in census.load_jsonl(FIXTURE)}
        event = fixture["06eb48e82e4e53f23d7154dadc6f"]
        self.assertEqual(event["date"]["dateval"][:3], [14, 2, 1840])
        lp = projt(fixture.values())[event["handle"]]
        self.assertEqual(lp["date"]["dateval"][:3], [0, 0, 1840])
        for mode in ("cli", "gui"):
            r = M.merge_object(copy.deepcopy(lp), event, lp, TOMB, mode=mode, allow_deletes=True)
            cf = r.conflicts[0]
            self.assertEqual((r.action, cf["kind"], cf["reason"]), ("conflict", "delete_edit", "has desktop-only data"))
            self.assertEqual(cf["disposition"], "parked" if mode == "cli" else "open")
            self.assertIn("/date/dateval/0", cf["lost"])
            self.assertIn("/date/dateval/1", cf["lost"])
            self.assertIsNone(r.local_obj)
            self.assertEqual(M._dump(cf["local"]["date"]["dateval"][:2]), "[0,0]")      # the preview holds projected values only


class DateChoices(unittest.TestCase):
    def test_a_composite_date_conflict_offers_three_choices_and_the_default_keeps_the_local_day_and_month(self):
        choices = M.date_choices()
        self.assertEqual([c["id"] for c in choices], ["keep_mine", "take_year_keep_daymonth", "clear_daymonth"])
        self.assertEqual([c["default"] for c in choices], [False, True, False])
        self.assertEqual([c["needs_confirmation"] for c in choices], [False, False, True])
        self.assertEqual(M.DEFAULT_DATE_CHOICE, "take_year_keep_daymonth")
        local_event = MV.EV("e1", MV.BIRTH, MV.DATE(14, 2, 1900))
        b = proj1(local_event)
        c = ed(b, lambda o: o.__setitem__("date", MV.DY(1901)))
        conflict = mo(b, local_event, c).conflicts[0]
        self.assertEqual(conflict["kind"], "composite")
        out = M.resolve_date(conflict["cloud"], local_event["date"])             # no choice: the default
        self.assertEqual(out["local"]["dateval"], [14, 2, 1901, False])           # the website year, my day and month
        self.assertEqual(out["local"]["sortval"], MV.sort_value(0, 1901, 2, 14))
        self.assertEqual(out["cloud"], c["date"])                                 # the cloud keeps the website value
        self.assertEqual(R.reduce_date(out["local"], POLICY), c["date"])         # so the next projection equals the cloud

    def test_keep_mine_keeps_the_local_date_and_pushes_its_projection(self):
        mine = MV.DATE(14, 2, 1900, text="14 Feb 1900")
        out = M.resolve_date(MV.DY(1901), mine, "keep_mine")
        self.assertEqual(out["local"], mine)
        self.assertEqual(out["cloud"], MV.DY(1900))

    def test_clearing_the_local_day_and_month_needs_the_extra_confirmation(self):
        with self.assertRaises(ValueError):
            M.resolve_date(MV.DY(1901), MV.DATE(14, 2, 1900), "clear_daymonth")
        out = M.resolve_date(MV.DY(1901), MV.DATE(14, 2, 1900), "clear_daymonth", confirmed=True)
        self.assertEqual((out["local"], out["cloud"]), (MV.DY(1901), MV.DY(1901)))

    def test_an_unknown_choice_is_refused_and_odd_dates_keep_a_zero_sort_value(self):
        with self.assertRaises(ValueError):
            M.resolve_date(MV.DY(1901), MV.DATE(1, 1, 1900), "something_else")
        non_greg = MV.DY(1901, cal=2)
        self.assertEqual(M.resolve_date(non_greg, MV.DATE(3, 4, 1900, cal=2))["local"]["sortval"], 0)
        no_year = M.resolve_date(MV.DY(0), MV.DATE(3, 4, 1900))
        self.assertEqual((no_year["local"]["dateval"][:3], no_year["local"]["sortval"]), ([3, 4, 0], 0))
        # a range keeps both halves' day and month; a day-less month sorts at the first of the month
        rng = M.resolve_date(MV.DY(1901, mod=MV.RANGE, second_year=1905), MV.DATE(0, 5, 1900, mod=MV.RANGE, second=(7, 8, 1904)))
        self.assertEqual(rng["local"]["dateval"], [0, 5, 1901, False, 7, 8, 1905, False])
        self.assertEqual(rng["local"]["sortval"], MV.sort_value(0, 1901, 5, 1))
        # shapes that do not match (a range against a single date, a text-only local date) cannot take the day and month: keep mine
        short = {"_class": "Date", "dateval": [3, 4, 1900, False], "text": "", "modifier": 0}
        out = M.resolve_date(MV.DY(1901, mod=MV.RANGE, second_year=1905), short)
        self.assertEqual((out["fallback"], out["local"], out["cloud"]), ("keep_mine", short, R.reduce_date(short, POLICY)))
        text_only = MV.DATE(3, 4, 1900, text="about 3 Apr 1900", mod=6)
        self.assertEqual(M.resolve_date(MV.DY(1901), text_only)["fallback"], "keep_mine")
        self.assertNotIn("fallback", M.resolve_date(MV.DY(1901), MV.DATE(3, 4, 1900)))

    def test_the_default_keeps_the_website_text_so_it_never_names_the_old_year(self):
        local = MV.DATE(14, 2, 1900, text="14 Feb 1900")
        cloud = ed(MV.DY(1901), lambda o: o.__setitem__("text", "1901"))
        out = M.resolve_date(cloud, local)
        self.assertEqual((out["local"]["dateval"][:3], out["local"]["text"]), ([14, 2, 1901], "1901"))
        self.assertEqual(M.resolve_date(MV.DY(1901), local)["local"]["text"], "")

    def test_resolve_conflict_keeps_mine_takes_the_website_or_skips(self):
        cf = {"local": "Zed", "cloud": "Quill"}
        self.assertEqual(M.resolve_conflict(cf, "keep_mine", local_raw="Zed"), {"local": "Zed", "cloud": "Zed"})
        self.assertEqual(M.resolve_conflict(cf, "take_website"), {"local": "Quill", "cloud": "Quill"})
        self.assertIsNone(M.resolve_conflict(cf, "skip"))
        with self.assertRaises(ValueError):
            M.resolve_conflict(cf, "later")
        with self.assertRaises(ValueError):                     # keeping mine without the raw value could overwrite desktop-only parts
            M.resolve_conflict(cf, "keep_mine")

    def test_keep_mine_on_a_composite_conflict_keeps_the_raw_desktop_value_and_pushes_only_its_projection(self):
        city, other = MV.PL("pc", "Fixtureland"), MV.PL("po", "Elsewhere")
        street = MV.PL("ps", "1 Fixture Lane", t=MV.PL_STREET, parent="pc")
        l = MV.EV("e1", MV.RESIDENCE, place="ps")
        tree = projt([l, city, other, street])
        b = tree["e1"]
        c = ed(b, lambda o: o.__setitem__("place", "po"))
        r = M.merge_object(b, l, b, c)
        cf = r.conflicts[0]
        self.assertEqual((cf["kind"], cf["local"]), ("composite", "pc"))          # the conflict holds the projected value only
        self.assertNotIn("ps", M._dump(cf))
        raw = M.local_value(cf, l, b, b)
        self.assertEqual(raw, "ps")
        out = M.resolve_conflict(cf, "keep_mine", local_raw=raw)
        self.assertEqual(out, {"local": "ps", "cloud": "pc"})                      # Gramps keeps the street, the cloud the city
        self.assertEqual(M.resolve_conflict(cf, "take_website"), {"local": "po", "cloud": "po"})

    def test_local_value_finds_a_raw_value_by_path_through_keyed_lists_bags_and_the_whole_object(self):
        l0 = person(media_list=[MV.MR("m1")], urls=[MV.URL("https://example.org/a")])
        b = proj1(l0)
        raw_rect = [1.5, 0, 5, 5]
        l = ed(l0, lambda o: (o["media_list"][0].__setitem__("rect", raw_rect), rename("Zed")(o)))
        lp = proj1(l)
        c = ed(b, lambda o: o["media_list"][0].__setitem__("rect", [2, 0, 6, 6]))
        r = M.merge_object(b, l, lp, c)
        paths = conflict_paths(r)
        self.assertEqual(paths, ["/media_list/m1#0/rect"])
        self.assertEqual(M.local_value(r.conflicts[0], l, lp, b), raw_rect)
        self.assertEqual(M.local_value({"path": "/primary_name/first_name"}, l, lp, b), "Zed")
        self.assertIsNone(M.local_value({"path": "/primary_name/nothing"}, l, lp, b))
        self.assertIsNone(M.local_value({"path": "/gender/deeper"}, l, lp, b))
        whole = M.local_value({"path": ""}, l, lp, b)
        self.assertEqual(whole, strip(l))
        self.assertNotIn("change", whole)


class Lift(unittest.TestCase):
    """6.5: lift(C, L) restores every local-only part."""

    def rich_person(self):
        """A person with a local-only part of every kind, in the middle of lists."""
        return person(
            evs=(MV.ER("e0", private=True), "e1", "e2"), birth=1, death=2,
            address_list=[MV.ADDR()], lds_ord_list=[MV.LDS()],
            alternate_names=[MV.NAME("Aldo", "One", t=MV.NAME_MARRIED), MV.NAME("Hid", "Den", private=True),
                             MV.NAME("Ola", "Two", t=MV.NAME_MARRIED)],
            attribute_list=[MV.ATTR(0, "kept", "Hobby"), MV.ATTR(MV.ATTR_AGE, "30"), MV.ATTR(MV.ATTR_SSN, "000-00-0000")],
            urls=[MV.URL("https://example.org/home"), MV.URL("mailto:a@example.org", MV.URL_EMAIL)], change=1700000000)

    def test_lift_of_the_projection_is_the_local_object(self):
        l = self.rich_person()
        lp = proj1(l)
        self.assertNotEqual(strip(lp), strip(l))
        self.assertEqual(M.lift(lp, l, lp), l)

    def test_every_local_only_part_survives_a_cloud_change_and_the_projection_of_the_lift_is_the_cloud_object(self):
        l = self.rich_person()
        lp = proj1(l)
        c = ed(lp, lambda o: (rename("Zed")(o), o["event_ref_list"].append(MV.ER("e3")), o["urls"].append(MV.URL("https://example.org/w")),
                              o["alternate_names"].pop(0), o["attribute_list"].append(MV.ATTR(0, "added", "Pet"))))
        out = M.lift(c, l, lp)
        self.assertEqual(proj1(out), c)
        self.assertEqual(out["change"], 1700000000)
        self.assertEqual(len(out["address_list"]), 1)
        self.assertEqual(len(out["lds_ord_list"]), 1)
        self.assertEqual([n["private"] for n in out["alternate_names"]], [True, False])
        self.assertEqual({a["type"]["value"] for a in out["attribute_list"]}, {0, MV.ATTR_AGE, MV.ATTR_SSN})
        self.assertEqual({u["type"]["value"] for u in out["urls"]}, {MV.URL_WEB_HOME, MV.URL_EMAIL})

    def test_a_private_event_reference_keeps_its_place_and_the_indexes_are_recomputed(self):
        l = self.rich_person()
        lp = proj1(l)
        self.assertEqual((lp["birth_ref_index"], lp["death_ref_index"]), (0, 1))
        c = ed(lp, lambda o: (o["event_ref_list"].insert(0, MV.ER("e9")), o.__setitem__("birth_ref_index", 1), o.__setitem__("death_ref_index", 2)))
        out = M.lift(c, l, lp)
        self.assertEqual([e["ref"] for e in out["event_ref_list"]], ["e9", "e0", "e1", "e2"])
        self.assertEqual((out["birth_ref_index"], out["death_ref_index"]), (2, 3))
        self.assertEqual(proj1(out), c)

    def test_date_parts_come_back_while_the_shared_year_is_unchanged_and_not_otherwise(self):
        l = MV.EV("e1", MV.BIRTH, MV.DATE(14, 2, 1900, text="14 Feb 1900"))
        lp = proj1(l)
        self.assertEqual(M.lift(lp, l, lp)["date"], l["date"])
        c = ed(lp, lambda o: o.__setitem__("date", MV.DY(1901)))
        out = M.lift(c, l, lp)
        self.assertEqual(out["date"], MV.DY(1901))
        self.assertEqual(proj1(out), c)

    def test_coordinates_keep_their_precision_while_the_rounded_value_is_unchanged(self):
        l = MV.PL("pl1", "Fixtureland", lat="12.34567", long="-45.6789")
        lp = proj1(l)
        self.assertEqual((lp["lat"], lp["long"]), ("12.35", "-45.68"))
        self.assertEqual(M.lift(lp, l, lp), l)
        c = ed(lp, lambda o: o.__setitem__("lat", "13.00"))
        out = M.lift(c, l, lp)
        self.assertEqual((out["lat"], out["long"]), ("13.00", "-45.6789"))
        self.assertEqual(proj1(out), c)

    def test_blanked_location_fields_a_local_place_code_and_street_level_parents_come_back(self):
        city = MV.PL("pc", "Fixtureland")
        street = MV.PL("ps", "1 Fixture Lane", t=MV.PL_STREET, parent="pc")
        l = MV.PL("pl1", "Annex", t=MV.PL_CITY, code="X-1", parent="ps", alt_loc=[MV.LOC(street="5 Fixture Rd", city="Annex City")])
        tree = projt([city, street, l])
        lp = tree["pl1"]
        self.assertEqual((lp["code"], lp["placeref_list"][0]["ref"], lp["alt_loc"]), ("", "pc", [MV.LOC(city="Annex City")]))
        self.assertEqual(M.lift(lp, l, lp), l)
        c = ed(lp, lambda o: o["name"].__setitem__("value", "Renamed"))
        out = M.lift(c, l, lp)
        self.assertEqual((out["code"], out["placeref_list"][0]["ref"], out["alt_loc"][0]["street"]), ("X-1", "ps", "5 Fixture Rd"))
        self.assertEqual(projt([city, street, out])["pl1"], c)

    def test_media_paths_held_fields_and_hidden_rectangles_come_back(self):
        media = MV.MED("m1", path="media/local.jpg")
        mlp = proj1(media)
        self.assertEqual(mlp["path"], "")
        c = ed(mlp, lambda o: o.__setitem__("desc", "web caption"))
        out = M.lift(c, media, mlp)
        self.assertEqual((out["path"], out["desc"]), ("media/local.jpg", "web caption"))
        # a held note keeps its local text while the cloud still has the last synced one
        n0 = MV.NOTE("n1", "plain")
        nb = proj1(n0)
        n = ed(n0, lambda o: o["text"].__setitem__("string", "call 555-0142 today"))
        nlp = proj1(n, base={"n1": nb})
        self.assertEqual(M.lift(nlp, n, nlp), n)
        # the full-frame rectangle and a float rectangle
        p = person(media_list=[MV.MR("m1", [0, 0, 100, 100]), MV.MR("m2", [1.5, 0, 5, 5])])
        lp = proj1(p)
        self.assertEqual([e["rect"] for e in lp["media_list"]], [None, None])
        self.assertEqual(M.lift(lp, p, lp), p)
        c = ed(lp, lambda o: o["media_list"][0].__setitem__("rect", [1, 2, 30, 40]))
        out = M.lift(c, p, lp)
        self.assertEqual([e["rect"] for e in out["media_list"]], [[1, 2, 30, 40], [1.5, 0, 5, 5]])

    def test_an_object_new_to_the_desktop_is_a_copy_of_the_cloud_object(self):
        c = proj1(person())
        out = M.lift(c, None)
        self.assertEqual(out, c)
        self.assertIsNot(out, c)

    def test_without_a_projection_the_object_is_projected_alone_and_an_excluded_object_cannot_be_lifted(self):
        l = MV.EV("e1", MV.BIRTH, MV.DATE(14, 2, 1900))
        c = ed(proj1(l), lambda o: o.__setitem__("description", "web"))
        out = M.lift(c, l)
        self.assertEqual((out["description"], out["date"]), ("web", l["date"]))
        with self.assertRaises(ValueError):
            M.lift(c, person(private=True))

    def test_lift_does_not_change_its_inputs(self):
        l = self.rich_person()
        lp = proj1(l)
        c = ed(lp, rename("Zed"))
        snap = [copy.deepcopy(x) for x in (l, lp, c)]
        M.lift(c, l, lp)
        self.assertEqual([l, lp, c], snap)


def strip(obj):
    return {k: v for k, v in obj.items() if k != "change"}


class Integrity(unittest.TestCase):
    def tree(self):
        f = MV.FA("f1", father="p1", mother="p2", children=("c1",))
        return {o["handle"]: o for o in (
            person("p1", family_list=["f1"]), person("p2", "Wren", family_list=["f1"]),
            person("c1", "Birch", parent_family_list=["f1"]), f)}

    def problems(self, objs, removed=()):
        return [(v["problem"], v["involves"]) for v in M.check_integrity(objs, removed)]

    def test_the_synthetic_tree_and_a_consistent_family_have_no_violations(self):
        self.assertEqual(M.check_integrity(self.tree()), [])
        self.assertEqual(M.check_integrity({o["handle"]: o for o in census.load_jsonl(FIXTURE)}), [])

    def test_a_person_whose_family_does_not_list_the_person_as_a_parent(self):
        t = self.tree()
        t["f1"]["mother_handle"] = None
        self.assertEqual(self.problems(t), [("asymmetric_family", ["f1", "p2"])])

    def test_a_family_naming_a_parent_whose_family_list_does_not_include_it(self):
        t = self.tree()
        t["p1"]["family_list"] = []
        self.assertEqual(self.problems(t), [("asymmetric_family", ["f1", "p1"])])

    def test_a_family_listing_a_child_whose_parent_family_list_does_not_include_it_and_the_reverse(self):
        t = self.tree()
        t["c1"]["parent_family_list"] = []
        self.assertEqual(self.problems(t), [("asymmetric_child", ["c1", "f1"])])
        t = self.tree()
        t["f1"]["child_ref_list"] = []
        self.assertEqual(self.problems(t), [("asymmetric_child", ["c1", "f1"])])

    def test_a_reference_to_nothing_or_to_an_object_of_the_wrong_class(self):
        t = self.tree()
        t["p1"]["event_ref_list"] = [MV.ER("e404")]
        t["p1"]["media_list"] = [MV.MR("p2")]
        t["p1"]["note_list"] = ["n404"]
        t["p1"]["citation_list"] = ["c404"]
        t["p1"]["tag_list"] = ["t404"]
        t["p1"]["primary_name"]["citation_list"] = ["c405"]
        got = self.problems(t)
        self.assertEqual(len(got), 6)
        self.assertTrue(all(p == ("dangling_reference", ["p1"]) for p in got))

    def test_event_places_citation_sources_and_parent_handles_are_checked(self):
        objs = {o["handle"]: o for o in (MV.EV("e1", place="p404"), MV.CIT("ci1", source="s404"), MV.FA("f1", father="x404"))}
        self.assertEqual(sorted(h for v in M.check_integrity(objs) for h in v["involves"]), ["ci1", "e1", "f1"])

    def test_an_index_outside_the_event_reference_list(self):
        t = self.tree()
        t["p1"]["event_ref_list"] = [MV.ER("e1")]
        t["e1"] = MV.EV("e1")
        t["p1"]["birth_ref_index"] = 1
        t["p1"]["death_ref_index"] = -2
        self.assertEqual(self.problems(t), [("index_out_of_range", ["p1"]), ("index_out_of_range", ["p1"])])

    def test_a_reference_to_a_handle_this_run_deletes_names_both_objects(self):
        t = self.tree()
        del t["c1"]
        self.assertEqual(self.problems(t), [("dangling_reference", ["f1"])])
        self.assertEqual(self.problems(t, removed={"c1"}), [("dangling_reference", ["c1", "f1"])])


class MergeTree(unittest.TestCase):
    """6.6: a violation becomes an integrity conflict for the objects involved; the rest of the plan proceeds."""

    def setUp(self):
        f = MV.FA("f1", father="p1", mother="p2", children=("c1",))
        self.local = {o["handle"]: o for o in (
            person("p1", family_list=["f1"]), person("p2", "Wren", family_list=["f1"]),
            person("c1", "Birch", parent_family_list=["f1"]), person("p9", "Quill"), f)}
        self.lp = projt(self.local.values())
        self.base = copy.deepcopy(self.lp)

    def run_tree(self, cloud, **kw):
        return M.merge_tree(self.base, self.local, self.lp, cloud, project_fn=proj1, **kw)

    def test_a_clean_run_applies_and_pushes_every_object_and_reports_the_actions(self):
        cloud = {"p9": ed(self.base["p9"], rename("Zed"))}
        local = dict(self.local)
        local["p2"] = ed(self.local["p2"], rename("Fern"))
        lp = projt(local.values())
        res = M.merge_tree(self.base, local, lp, cloud, project_fn=proj1, versions={"p9": 3, "p2": 1})
        self.assertEqual(res.results["p9"].local_obj["primary_name"]["first_name"], "Zed")
        self.assertEqual(res.results["p2"].push["obj"]["primary_name"]["first_name"], "Fern")
        self.assertEqual((res.integrity, res.conflicts, res.autos), ([], [], []))
        self.assertEqual(res.actions(), {"unchanged": 3, "update": 2})

    def test_a_cloud_change_that_breaks_symmetry_freezes_only_the_changed_object(self):
        new_family = ed(self.base["f1"], lambda o: (o.__setitem__("father_handle", "p9"), o["child_ref_list"].append(MV.CHREF("p9"))))
        cloud = {"f1": new_family, "p2": ed(self.base["p2"], rename("Fern"))}
        res = self.run_tree(cloud, versions={"f1": 2, "p2": 2}, mode="gui")
        f1 = res.results["f1"]
        self.assertEqual((f1.action, f1.local_obj, f1.push, f1.base_after), ("conflict", None, None, self.base["f1"]))
        cf = f1.conflicts[0]
        self.assertEqual((cf["kind"], cf["path"], cf["disposition"]), ("integrity", "", "open"))
        self.assertEqual(cf["involves"], ["f1", "p1", "p9"])
        self.assertTrue(res.integrity)
        self.assertEqual(res.results["p2"].local_obj["primary_name"]["first_name"], "Fern")      # unrelated change stands
        self.assertEqual(res.conflicts, [cf])

    def test_a_cloud_delete_of_a_person_a_family_still_lists_is_not_applied(self):
        res = self.run_tree({"c1": TOMB}, mode="cli", allow_deletes=True)
        r = res.results["c1"]
        self.assertEqual((r.action, r.conflicts[0]["kind"]), ("conflict", "integrity"))
        self.assertEqual(r.base_after, self.base["c1"])
        # with the family updated in the same run, the delete goes through
        family = ed(self.base["f1"], lambda o: o["child_ref_list"].clear())
        res = self.run_tree({"c1": TOMB, "f1": family}, mode="cli", allow_deletes=True)
        self.assertEqual((res.results["c1"].action, res.results["f1"].action), ("delete_local", "update"))
        self.assertEqual(res.integrity, [])

    def test_two_changed_objects_that_break_each_other_are_both_frozen(self):
        cloud = {"p1": ed(self.base["p1"], lambda o: o.__setitem__("family_list", [])),
                 "c1": ed(self.base["c1"], lambda o: o.__setitem__("parent_family_list", []))}
        res = self.run_tree(cloud)
        self.assertEqual({h: r.action for h, r in res.results.items() if r.action == "conflict"}, {"p1": "conflict", "c1": "conflict"})
        self.assertEqual(len(res.integrity), 2)

    def test_a_violation_that_was_already_in_the_local_tree_does_not_freeze_an_unrelated_cloud_edit(self):
        local = dict(self.local)
        local["p9"] = ed(self.local["p9"], lambda o: o.__setitem__("note_list", ["n404"]))          # dangling before the run
        lp = projt(local.values())
        base = copy.deepcopy(lp)
        self.assertEqual(len(M.check_integrity(local)), 1)
        rename_p9 = {"p9": ed(base["p9"], rename("Zed"))}
        res = M.merge_tree(base, local, lp, rename_p9, project_fn=proj1)
        self.assertEqual((res.results["p9"].action, res.integrity, res.conflicts), ("update", [], []))
        self.assertEqual(res.results["p9"].local_obj["primary_name"]["first_name"], "Zed")
        self.assertEqual(res.results["p9"].local_obj["note_list"], ["n404"])
        # a violation the run itself adds is still caught, on the same object, and a moved reference is not a new one
        worse = {"p9": ed(base["p9"], lambda o: o.__setitem__("citation_list", ["c404"]))}
        res = M.merge_tree(base, local, lp, worse, project_fn=proj1)
        self.assertEqual((res.results["p9"].action, len(res.integrity)), ("conflict", 1))
        local2 = dict(self.local)
        local2["p9"] = ed(self.local["p9"], lambda o: o.__setitem__("media_list", [MV.MR("m405"), MV.MR("m404")]))
        res = M.check_integrity({"p9": local2["p9"]})
        shifted = M.check_integrity({"p9": ed(local2["p9"], lambda o: o["media_list"].reverse())})
        self.assertEqual(sorted(v["key"] for v in res), sorted(v["key"] for v in shifted))

    def test_an_integrity_freeze_is_re_checked_each_run_and_ends_when_the_cause_is_gone(self):
        new_family = ed(self.base["f1"], lambda o: (o.__setitem__("father_handle", "p9"), o["child_ref_list"].append(MV.CHREF("p9"))))
        cloud = {"f1": new_family}
        first = self.run_tree(cloud, mode="gui")
        self.assertEqual(first.results["f1"].action, "conflict")
        pins = {"f1": [{"path": c["path"], "base_json": c["base_json"]} for c in first.results["f1"].conflicts]}
        self.assertEqual(pins["f1"][0]["path"], "")
        for _ in range(3):                                                    # the violation stands: frozen every run
            again = self.run_tree(cloud, mode="gui", pins=pins)
            self.assertEqual((again.results["f1"].action, again.results["f1"].conflicts[0]["kind"]), ("conflict", "integrity"))
            self.assertEqual(again.results["f1"].conflicts[0]["id"], first.results["f1"].conflicts[0]["id"])
        # the cause goes: p9 and p1 now agree with the family, so the same cloud change is applied and the pin is reported closed
        local = dict(self.local)
        local["p9"] = ed(self.local["p9"], lambda o: (o.__setitem__("family_list", ["f1"]), o.__setitem__("parent_family_list", ["f1"])))
        local["p1"] = ed(self.local["p1"], lambda o: o.__setitem__("family_list", []))
        lp = projt(local.values())
        res = M.merge_tree(self.base, local, lp, cloud, project_fn=proj1, mode="gui", pins=pins)
        self.assertEqual((res.results["f1"].action, res.results["f1"].closed, res.integrity), ("update", [""], []))
        self.assertEqual(res.results["f1"].local_obj["father_handle"], "p9")

    def test_an_index_that_is_not_an_integer_is_a_violation_and_not_a_crash(self):
        t = {"p1": ed(person(), lambda o: o.__setitem__("birth_ref_index", "0"))}
        self.assertEqual(self.problems_of(t), [("index_out_of_range", ["p1"])])
        t = {"p1": ed(person(), lambda o: o.__setitem__("death_ref_index", True))}
        self.assertEqual(self.problems_of(t), [("index_out_of_range", ["p1"])])

    def problems_of(self, objs):
        return [(v["problem"], v["involves"]) for v in M.check_integrity(objs)]

    def test_handles_the_cloud_does_not_list_are_unchanged_there_or_absent_from_a_complete_cloud(self):
        res = M.merge_tree(self.base, self.local, self.lp, {}, cloud_is_delta=True)
        self.assertEqual(res.actions(), {"unchanged": 5})
        self.assertTrue(all(r.local_obj is None and r.push is None for r in res.results.values()))
        res = M.merge_tree(self.base, self.local, self.lp, {}, cloud_is_delta=False)
        self.assertEqual(res.actions(), {"conflict": 5})
        self.assertEqual({c["kind"] for c in res.conflicts}, {"identity"})

    def test_pins_and_the_sticky_set_reach_the_object_merge(self):
        pins = {"p9": [{"path": "/primary_name/first_name", "base_json": '"Quill"'}]}
        local = dict(self.local)
        local["p9"] = ed(self.local["p9"], rename("Zed"))
        lp = projt(local.values())
        cloud = {"p9": ed(self.base["p9"], rename("Wick"))}
        res = M.merge_tree(self.base, local, lp, cloud, pins=pins)
        self.assertEqual(conflict_paths(res.results["p9"]), ["/primary_name/first_name"])
        ev = MV.EV("e1", MV.RESIDENCE, MV.DY(1900))
        base = {"e1": proj1(ev)}
        cloud = {"e1": ed(base["e1"], lambda o: o["type"].__setitem__("value", MV.MARRIAGE))}
        taken = M.merge_tree(base, {"e1": ev}, base, cloud)
        self.assertEqual(taken.conflicts, [])
        parked = M.merge_tree(base, {"e1": ev}, base, cloud, sticky=["e1"])
        self.assertEqual([c["kind"] for c in parked.conflicts], ["composite"])


class Baseline(unittest.TestCase):
    def test_update_baseline_keeps_the_sticky_set_across_runs_and_honours_a_release(self):
        birth = MV.EV("e1", MV.BIRTH, MV.DATE(14, 2, 1900))
        base = {"e1": proj1(birth)}
        retyped = ed(birth, lambda o: o["type"].__setitem__("value", MV.RESIDENCE))
        stored = M.update_baseline((), [retyped], base)
        self.assertEqual(stored, frozenset({"e1"}))                    # birth-like at the base: still protected after the retype
        again = M.update_baseline(stored, [retyped], {"e1": proj1(retyped)})
        self.assertEqual(again, frozenset({"e1"}))                     # and it stays when the next base no longer says birth
        self.assertEqual(M.update_baseline(stored, [retyped], {"e1": proj1(retyped)}, released=["e1"]), frozenset())
        self.assertEqual(M.update_baseline({"e7"}, [], None), frozenset({"e7"}))
        # the stored set feeds both the projection and the merge
        self.assertEqual(P.project_tree([retyped], sticky=again)[0]["e1"]["date"]["dateval"][:2], [0, 0])
        self.assertIn("e1", M.merge_context([retyped], [], sticky=again).birthlike)


class LiftProperty(unittest.TestCase):
    """sync.md 5.6 / 6.5: P(lift(C, L)) == C for every C the checker accepts, over the fixture and seeded random edit pairs.

    The checker is the projection itself: C is accepted when it is a fixed point of P with no hold, as an object of the tree
    (the cloud holds only such objects; the server validator is its detection-only twin). A trial edits one object of the synthetic
    tree twice: L gets desktop edits, local-only ones among them (an address, a birth day and month, a precise coordinate, a private
    name, an AGE attribute, a media path), and C = P(L) gets website edits. The tree around the object is its neighbourhood (what it
    names and what names it), the same for every projection of the trial."""

    TRIALS = 1000

    @classmethod
    def setUpClass(cls):
        cls.objs = census.load_jsonl(FIXTURE)
        cls.by = {o["handle"]: o for o in cls.objs}
        out = {h: set() for h in cls.by}
        for h, o in cls.by.items():
            for s in cls.strings(o):
                if s in cls.by and s != h:
                    out[h].add(s)
        cls.near = {h: set(v) for h, v in out.items()}
        for h, v in out.items():
            for t in v:
                cls.near[t].add(h)

    @staticmethod
    def strings(node):
        if isinstance(node, str):
            yield node
        elif isinstance(node, dict):
            for v in node.values():
                yield from LiftProperty.strings(v)
        elif isinstance(node, list):
            for v in node:
                yield from LiftProperty.strings(v)

    def cluster(self, h):
        return [copy.deepcopy(self.by[x]) for x in sorted(self.near[h] | {h})]

    @staticmethod
    def project_in(cluster, h, obj):
        r = P.project([obj if o["handle"] == h else o for o in cluster])
        return r.projected[h], [x for x in r.holds if x["handle"] == h]

    def test_the_lift_of_the_projection_is_the_local_object_for_every_object_of_the_tree(self):
        projected = P.project_tree(copy.deepcopy(self.objs))[0]
        seen = 0
        for o in self.objs:
            lp = projected[o["handle"]]
            if lp is None:
                continue
            seen += 1
            self.assertEqual(M.lift(lp, o, lp), o, o["handle"])
        self.assertGreater(seen, 80)

    def test_an_unchanged_cloud_after_a_pull_and_a_push_leaves_every_object_with_nothing_to_do(self):
        projected = P.project_tree(copy.deepcopy(self.objs))[0]
        res = M.merge_tree({h: p for h, p in projected.items() if p}, self.by, projected, {}, project_fn=None)
        self.assertTrue(all(r.local_obj is None and r.push is None and not r.conflicts for r in res.results.values()
                            if r.action == "update"))
        self.assertEqual(res.integrity, [])

    # ---- the edits
    def local_edits(self, rng, o):
        """Desktop edits, as functions of the object; each returns True when it changed something."""
        cls, out = o["_class"], list(self.shared_edits(rng, o))
        add = lambda f: out.append(f)  # noqa: E731
        if cls == "Person":
            add(lambda: o["address_list"].append(MV.ADDR()) or True)
            add(lambda: o["lds_ord_list"].append(MV.LDS()) or True)
            add(lambda: o["urls"].append(MV.URL("mailto:a@example.org", MV.URL_EMAIL)) or True)
            add(lambda: o["attribute_list"].append(MV.ATTR(MV.ATTR_AGE, "3")) or True)
            add(lambda: o["attribute_list"].insert(0, MV.ATTR(MV.ATTR_SSN, "9")) or True)
            add(lambda: o["alternate_names"].append(MV.NAME("Hid", "Den", private=True)) or True)
        if cls == "Event":
            add(lambda: o["date"].__setitem__("dateval", [3, 4, o["date"]["dateval"][2] or 1900, False]) or True)
            add(lambda: o["attribute_list"].append(MV.ATTR(11, "30")) or True)
        if cls == "Place":
            add(lambda: o.__setitem__("lat", "12.34567") or True)
            add(lambda: o["alt_loc"].append(MV.LOC(street="5 Fixture Rd", city="Annex")) or True)
        if cls == "Media":
            add(lambda: o.__setitem__("path", "media/local-%d.jpg" % rng.randrange(9)) or True)
        return out

    def shared_edits(self, rng, o):
        cls = o["_class"]
        if cls == "Person":
            yield lambda: self.set_(o["primary_name"], "first_name", rng.choice(["Zed", "Quill", "Mara"]))
            yield lambda: self.set_(o, "gender", rng.choice([0, 1, 2]))
            yield lambda: o["primary_name"]["surname_list"].append({"_class": "Surname", "primary": False, "surname": "Extra"}) or True
            yield lambda: o["attribute_list"].append(MV.ATTR(0, "v", "k%d" % rng.randrange(5))) or True
            yield lambda: o["urls"].append(MV.URL("https://example.org/p%d" % rng.randrange(5))) or True
            yield lambda: o["tag_list"].append("tag-%d" % rng.randrange(4)) or True
        if cls == "Event":
            yield lambda: self.set_(o, "description", rng.choice(["alpha", "beta", "gamma"]))
            yield lambda: self.bump_year(o)
        if cls == "Note":
            yield lambda: o["text"].__setitem__("string", o["text"]["string"] + " x") or True
        if cls == "Place":
            yield lambda: self.set_(o["name"], "value", rng.choice(["Mapleton", "Birchford"]))
            yield lambda: self.set_(o, "lat", "12.35")
        if cls == "Media":
            yield lambda: self.set_(o, "desc", rng.choice(["a", "b"]))
        if cls == "Family":
            yield lambda: (o["child_ref_list"].reverse() or True) if len(o["child_ref_list"]) > 1 else False
            yield lambda: o["attribute_list"].append(MV.ATTR(0, "v", "k%d" % rng.randrange(5))) or True
        if cls == "Source":
            yield lambda: self.set_(o, "title", rng.choice(["T1", "T2"]))

    @staticmethod
    def set_(d, k, v):
        changed = d.get(k) != v
        d[k] = v
        return changed

    @staticmethod
    def bump_year(o):
        dv = o["date"]["dateval"]
        if not dv[2]:
            return False
        dv[2] += 1
        return True

    def edited(self, rng, obj, shared):
        """Apply 0 to 2 random edits to a copy of ``obj``; returns ``(copy, whether one changed it)``."""
        out, changed = copy.deepcopy(obj), False
        for _ in range(rng.randrange(0, 3)):
            edits = list(self.shared_edits(rng, out)) if shared else self.local_edits(rng, out)
            changed = bool(rng.choice(edits)()) if edits else changed
        return out, changed

    def pairs(self, rng, from_base, wanted):
        """``wanted`` accepted trials ``(handle, cluster, B, L, P(L), C, local edited, cloud edited)``. C is B (``from_base``) or
        P(L) with website edits; the trial is dropped when the checker refuses C."""
        handles, got, tried = sorted(self.by), 0, 0
        while got < wanted:
            tried += 1
            self.assertLess(tried, wanted * 4, "too few accepted trials")
            h = rng.choice(handles)
            cl = self.cluster(h)
            b, _ = self.project_in(cl, h, self.by[h])
            l, edited_l = self.edited(rng, self.by[h], False)
            lp, _ = self.project_in(cl, h, l)
            if b is None or lp is None:
                continue
            c, edited_c = self.edited(rng, b if from_base else lp, True)
            accepted, holds = self.project_in(cl, h, c)
            if accepted != c or holds:
                continue
            got += 1
            yield h, cl, b, l, lp, c, edited_l, edited_c

    def test_p_of_lift_equals_c_for_1000_seeded_random_edit_pairs(self):
        stats = {"both": 0, "local_only": 0}
        for h, cl, b, l, lp, c, edited_l, edited_c in self.pairs(random.Random(20261013), False, self.TRIALS):
            got, _ = self.project_in(cl, h, M.lift(c, l, lp))
            if got != c:
                self.fail("%s: P(lift(C, L)) != C at %s" % (h, M.diff_pointers(c, got)))
            stats["both"] += edited_l and edited_c
            stats["local_only"] += not M._eq(M.strip_change(l), lp)
        self.assertGreater(stats["both"], 200, stats)          # the trials are not vacuous
        self.assertGreater(stats["local_only"], 500, stats)

    def test_a_run_without_conflicts_leaves_gramps_and_the_cloud_agreeing_for_seeded_random_edits_on_both_sides(self):
        stats = {"conflicts": 0, "pushes": 0, "writes": 0, "both": 0}
        for h, cl, b, l, lp, c, edited_l, edited_c in self.pairs(random.Random(77), True, 500):
            tree = [l if o["handle"] == h else o for o in cl]
            r = M.merge_object(b, l, lp, c, cloud_version=2, project_fn=lambda o: self.project_in(cl, h, o)[0],
                               ctx=M.merge_context(tree, [b]))
            if r.conflicts:
                stats["conflicts"] += 1
                continue
            final_local, final_cloud = r.local_obj or l, r.push["obj"] if r.push else c
            self.assertEqual(self.project_in(cl, h, final_local)[0], final_cloud, h)
            self.assertEqual(r.base_after, final_cloud)
            stats["pushes"] += bool(r.push)
            stats["writes"] += bool(r.local_obj)
            stats["both"] += bool(r.push and r.local_obj)
        self.assertGreater(stats["pushes"], 60, stats)
        self.assertGreater(stats["writes"], 60, stats)
        self.assertGreater(stats["both"], 5, stats)
