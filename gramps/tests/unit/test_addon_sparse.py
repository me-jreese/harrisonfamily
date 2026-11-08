"""Sparse objects from the website and the no-data-loss rule (HFY-TSK-409).

The website's record editor created Events with six keys (Gramps' own code reads thirteen), and Gramps raised KeyError on the pull. The
fix completes what Gramps loads, and the rule it keeps is that a MISSING key is "no information", never "empty":

    * an object new to the tree takes the blank object of its class for the keys it lacks (create_local);
    * an object already in the tree keeps its own value for every key the website did not send;
    * the blank value stands in for an absence only where the base and the desktop both hold nothing but the blank, so a pulled
      sparse object is never read as a desktop edit and the next push sends nothing for it.

Four layers, CI-safe (stock python3, fakes, the synthetic fixture only, every value fictional): `blank.complete` (the completion
Gramps' loader gets), `merge.reconcile_sparse` (what the three-way rule compares), `merge.merge_object` (the decision) and whole pulls
over the fixture tree (the byte-for-byte assertions). The Gramps lane repeats the apply in Gramps' own interpreter
(gramps/tests/gramps/test_addon_blank.py).
"""
import copy
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import addon_pull_support as S  # noqa: E402
from hfygramps import blank  # noqa: E402
from hfygramps import merge as M  # noqa: E402
from test_addon_pull import by_gid  # noqa: E402

SIX = ("_class", "date", "gramps_id", "handle", "place", "type")
REAL_DATE = {"_class": "Date", "calendar": 0, "dateval": [0, 0, 1900, False], "format": 3, "modifier": 0, "newyear": 0, "quality": 0,
             "sortval": 2415000, "text": "about 1900"}
EDITOR_DATE = {"_class": "Date", "calendar": 0, "dateval": [0, 0, 0, False], "modifier": 0, "newyear": 0, "quality": 0, "text": ""}


def sparse_event(handle, gid, *, place="", date=None, description=None, type_value=7):
    """An Event as the record editor created it: six keys (and `description` only when filled in); no list fields, no `private`."""
    ev = {"_class": "Event", "handle": handle, "gramps_id": gid, "place": place, "date": copy.deepcopy(date or EDITOR_DATE),
          "type": {"_class": "EventType", "string": "", "value": type_value}}
    if description is not None:
        ev["description"] = description
    return ev


def drop_keys(obj, keep=SIX):
    return {k: copy.deepcopy(v) for k, v in obj.items() if k in keep}


def kinds(tree_objs):
    return {h: json.dumps(o, sort_keys=True) for h, o in tree_objs.items()}


def changed_handles(before, after):
    return sorted(h for h in set(before) | set(after) if before.get(h) != after.get(h))


class Complete(unittest.TestCase):
    """blank.complete: present keys are never changed; a missing key takes the tree's value, then the blank."""

    def test_a_six_key_event_gets_the_other_keys_and_keeps_its_own(self):
        ev = sparse_event("e" * 28, "E9001", place="p" * 28, description="Fictional note")
        out = blank.complete(ev)
        for key in ("attribute_list", "citation_list", "media_list", "note_list", "tag_list"):
            self.assertEqual(out[key], [], key)
        self.assertEqual((out["private"], out["description"], out["place"]), (False, "Fictional note", "p" * 28))
        self.assertEqual(out["date"]["format"], None)
        self.assertEqual(out["date"]["dateval"], [0, 0, 0, False])
        self.assertNotIn("change", out, "Gramps stamps `change` itself")
        self.assertEqual({k: out[k] for k in ev if k != "date"}, {k: ev[k] for k in ev if k != "date"})

    def test_a_present_key_is_never_replaced_not_even_by_a_falsy_value(self):
        full = blank.complete(sparse_event("e" * 28, "E9001"))
        for key, val in (("description", ""), ("private", True), ("note_list", ["n" * 28]), ("place", ""), ("gramps_id", None)):
            obj = copy.deepcopy(full)
            obj[key] = val
            self.assertEqual(blank.complete(obj)[key], val)
            self.assertEqual(blank.complete(obj, existing={"_class": "Event", key: "held by the tree"})[key], val)

    def test_a_missing_key_of_an_object_the_tree_holds_takes_the_trees_value_not_the_blank(self):
        held = blank.complete(sparse_event("e" * 28, "E9001"))
        held.update(description="Held by the tree", private=True, note_list=["n" * 28], tag_list=["t" * 28])
        state = sparse_event("e" * 28, "E9001", place="p" * 28)
        out = blank.complete(state, existing=held)
        self.assertEqual((out["description"], out["private"], out["note_list"], out["tag_list"]),
                         ("Held by the tree", True, ["n" * 28], ["t" * 28]))
        self.assertEqual(out["place"], "p" * 28, "a key the state has wins over the tree")
        # without the tree's object (a create) the same keys are the blanks
        fresh = blank.complete(state)
        self.assertEqual((fresh["description"], fresh["private"], fresh["note_list"]), ("", False, []))

    def test_nested_plain_objects_take_the_trees_values_and_value_classes_are_replaced_whole(self):
        person = copy.deepcopy(next(o for o in S.load_fixture().values() if o["_class"] == "Person"))
        state = copy.deepcopy(person)
        del state["primary_name"]["nick"]
        state["primary_name"]["call"] = "Kept"
        held = copy.deepcopy(person)
        held["primary_name"]["nick"] = "Held nick"
        held["primary_name"]["call"] = "Held call"
        out = blank.complete(state, existing=held)
        self.assertEqual((out["primary_name"]["nick"], out["primary_name"]["call"]), ("Held nick", "Kept"))
        # a Date is a value: its new content is not mixed with the old date's `sortval`
        ev = blank.complete(sparse_event("e" * 28, "E9001", date={"_class": "Date", "calendar": 0, "dateval": [0, 0, 1850, False],
                                                                  "modifier": 0, "newyear": 0, "quality": 0, "text": ""}))
        held_ev = copy.deepcopy(ev)
        held_ev["date"] = {"_class": "Date", "calendar": 0, "dateval": [0, 0, 1900, False], "format": 3, "modifier": 0, "newyear": 0,
                           "quality": 0, "sortval": 2415000, "text": ""}
        out = blank.complete(drop_keys(ev, SIX), existing=held_ev)
        self.assertEqual(out["date"]["sortval"], 0)
        self.assertEqual(out["date"]["format"], None)
        self.assertEqual(out["date"]["dateval"], [0, 0, 1850, False])

    def test_a_cut_down_value_that_agrees_with_the_trees_value_takes_its_missing_keys_from_it(self):
        """A Date, StyledText or type object the website sends cut down is the SAME value when every key it holds equals the tree's."""
        held = blank.complete(sparse_event("e" * 28, "E9001"), existing=None)
        held["date"] = copy.deepcopy(REAL_DATE)
        held["description"] = "Held by the tree"
        for cut in ({"_class": "Date"}, {"_class": "Date", "dateval": [0, 0, 1900, False]},
                    {"_class": "Date", "dateval": [0, 0, 1900, False], "calendar": 0, "modifier": 0}, {"_class": "Date", "text": "about 1900"}):
            state = sparse_event("e" * 28, "E9001")
            state["date"] = cut
            out = blank.complete(state, existing=held)
            self.assertEqual(out["date"], REAL_DATE, "a cut-down copy of the tree's own Date loses no key: %r" % (cut,))
        # a StyledText and a type the same way
        note = {"_class": "Note", "handle": "n" * 28, "text": {"_class": "StyledText", "string": "Held text", "tags": [{"x": 1}]}}
        held_note = blank.complete(note)
        cut_note = {"_class": "Note", "handle": "n" * 28, "text": {"_class": "StyledText", "string": "Held text"}}
        self.assertEqual(blank.complete(cut_note, existing=held_note)["text"]["tags"], [{"x": 1}])

    def test_a_value_that_differs_from_the_trees_in_any_key_is_a_new_value_replaced_whole(self):
        """RULING (raised on the record): a Date the website changed is the website's whole new value. Its keys it did not send are the
        blank, not the old date's, because the old `sortval` and `text` describe a date that no longer stands. No other key is touched."""
        held = blank.complete(sparse_event("e" * 28, "E9001"))
        held["date"] = copy.deepcopy(REAL_DATE)
        held["description"] = "Held by the tree"
        state = sparse_event("e" * 28, "E9001")
        state["date"] = {"_class": "Date", "dateval": [0, 0, 1850, False]}
        out = blank.complete(state, existing=held)
        self.assertEqual((out["date"]["dateval"], out["date"]["sortval"], out["date"]["text"]), ([0, 0, 1850, False], 0, ""))
        self.assertEqual(out["description"], "Held by the tree", "the rest of the object is the tree's")
        self.assertEqual(blank.complete(state)["date"], out["date"], "the same value as for an object new to the tree")

    def test_carry_keeps_the_previous_keys_of_a_cut_down_copy_of_the_same_value_only(self):
        same = blank.carry({"_class": "Date", "dateval": [0, 0, 1900, False], "sortval": 5, "text": "x"}, {"_class": "Date", "dateval": [0, 0, 1900, False]})
        self.assertEqual((same["sortval"], same["text"]), (5, "x"))
        new = blank.carry({"_class": "Date", "dateval": [0, 0, 1900, False], "sortval": 5, "text": "x"}, {"_class": "Date", "dateval": [0, 0, 1850, False]})
        self.assertNotIn("sortval", new)

    def test_a_sparse_reference_of_an_existing_list_takes_the_trees_element_with_the_same_ref(self):
        role = {"_class": "EventRoleType", "value": 2, "string": ""}
        held = {"_class": "Person", "event_ref_list": [{"_class": "EventRef", "ref": "e1", "private": True, "note_list": ["n" * 28], "role": role}]}
        state = {"_class": "Person", "event_ref_list": [{"_class": "EventRef", "ref": "e1", "role": role}, {"_class": "EventRef", "ref": "e2"}]}
        out = blank.complete(state, existing=held)["event_ref_list"]
        self.assertEqual((out[0]["private"], out[0]["note_list"]), (True, ["n" * 28]), "the tree's reference keeps its values")
        self.assertEqual((out[1]["private"], out[1]["note_list"]), (False, []), "a new reference takes the blanks")

    def test_the_event_type_is_never_invented_and_a_type_value_is_never_made_up(self):
        ev = sparse_event("e" * 28, "E9001")
        del ev["type"]
        self.assertNotIn("type", blank.complete(ev), "a blank Gramps event is a Birth: Gramps refuses the object instead")
        out = blank.complete({"_class": "Event", "handle": "e" * 28, "type": {"_class": "EventType"}})
        self.assertEqual(out["type"], {"_class": "EventType", "string": ""})
        self.assertNotIn("value", out["type"])

    def test_list_elements_are_completed_and_keep_what_they_have(self):
        ref = {"_class": "EventRef", "ref": "e" * 28, "role": {"_class": "EventRoleType", "value": 1, "string": ""}, "private": True}
        out = blank.complete({"_class": "Person", "handle": "p" * 28, "event_ref_list": [ref]})["event_ref_list"][0]
        self.assertEqual((out["private"], out["attribute_list"], out["note_list"], out["citation_list"]), (True, [], [], []))

    def test_the_committed_table_is_the_one_for_the_gramps_version_the_repository_pins(self):
        """A Gramps upgrade must regenerate hfygramps/blanks.py (gramps/scripts/gen-blanks.py): CI uses the table, the apply asks Gramps."""
        from hfygramps import blanks, schema_check
        self.assertEqual("gramps-" + blanks.GRAMPS_VERSION, schema_check.STEM)

    def test_an_event_without_a_type_is_refused_with_a_name_and_no_value(self):
        ev = sparse_event("e" * 28, "E9001", description="Fictional text that must not be echoed")
        del ev["type"]
        with self.assertRaises(blank.SparseObjectRefused) as caught:
            blank.refuse_invented(blank.complete(ev))
        self.assertEqual(str(caught.exception), "'Event without type'")
        self.assertIsInstance(caught.exception, KeyError)
        blank.refuse_invented(blank.complete(sparse_event("e" * 28, "E9001")))      # with a type: nothing raised
        # an existing event keeps the type the tree holds, so a sparse copy without one is not refused
        held = blank.complete(sparse_event("e" * 28, "E9001"))
        blank.refuse_invented(blank.complete(ev, existing=held))

    def test_the_committed_table_matches_the_class_schemas(self):
        for name, blank_obj in blank.BLANKS.items():
            self.assertEqual(blank_obj["_class"], name)
        self.assertEqual(len(blank.BLANKS), 28)


class Reconcile(unittest.TestCase):
    """merge.reconcile_sparse: a missing key reads as a change only where it is one."""

    def setUp(self):
        self.full = blank.complete(sparse_event("e" * 28, "E9001", place="p" * 28))
        self.full["change"] = 1700000000

    def sparse(self):
        return drop_keys(self.full)

    def test_sparse_base_and_cloud_against_a_completed_desktop_object_reconcile_to_equal(self):
        b, c = M.reconcile_sparse(self.sparse(), self.full, self.sparse())
        self.assertTrue(M._eq(b, M.strip_change(self.full)) and M._eq(c, M.strip_change(self.full)))

    def test_a_key_the_cloud_left_out_takes_the_base_value_never_the_blank(self):
        base = copy.deepcopy(self.full)
        base["description"] = "A real description"
        base["note_list"] = ["n" * 28]
        local = copy.deepcopy(base)
        cloud = self.sparse()
        b, c = M.reconcile_sparse(base, local, cloud)
        self.assertEqual((c["description"], c["note_list"]), ("A real description", ["n" * 28]))
        self.assertEqual(b, base, "the base is not changed where it had the key")

    def test_a_desktop_value_that_is_not_the_blank_is_never_stood_in_for(self):
        local = copy.deepcopy(self.full)
        local["description"] = "Typed on the desktop"
        b, c = M.reconcile_sparse(self.sparse(), local, self.sparse())
        self.assertNotIn("description", b)
        self.assertNotIn("description", c)

    def test_a_cut_down_cloud_date_equal_to_the_base_date_reads_as_unchanged(self):
        base = copy.deepcopy(self.full)
        base["date"] = copy.deepcopy(REAL_DATE)
        local = copy.deepcopy(base)
        cloud = drop_keys(base)
        cloud["date"] = {"_class": "Date", "dateval": [0, 0, 1900, False]}
        b, c = M.reconcile_sparse(base, local, cloud)
        self.assertEqual(c["date"], REAL_DATE)
        self.assertEqual(b["date"], REAL_DATE)

    def test_a_changed_cloud_date_is_the_websites_whole_new_value(self):
        base = copy.deepcopy(self.full)
        base["date"] = copy.deepcopy(REAL_DATE)
        cloud = drop_keys(base)
        cloud["date"] = {"_class": "Date", "dateval": [0, 0, 1850, False]}
        b, c = M.reconcile_sparse(base, copy.deepcopy(base), cloud)
        self.assertNotIn("sortval", c["date"])
        self.assertEqual(b["date"], REAL_DATE, "the base is not touched")

    def test_the_originals_are_not_modified(self):
        base, cloud = self.sparse(), self.sparse()
        snap = (copy.deepcopy(base), copy.deepcopy(cloud))
        M.reconcile_sparse(base, self.full, cloud)
        self.assertEqual((base, cloud), snap)

    def test_what_is_not_three_plain_objects_is_returned_as_it_is(self):
        self.assertEqual(M.reconcile_sparse(None, self.full, M.TOMBSTONE), (None, M.TOMBSTONE))
        self.assertEqual(M.reconcile_sparse(self.full, None, self.sparse()), (self.full, self.sparse()))

    def test_sparse_list_elements_that_are_a_desktop_element_without_its_blanks_become_that_element(self):
        ref = {"_class": "EventRef", "ref": "e" * 28, "role": {"_class": "EventRoleType", "value": 1, "string": ""}}
        person = {"_class": "Person", "handle": "p" * 28, "event_ref_list": [ref]}
        local = {"_class": "Person", "handle": "p" * 28, "event_ref_list": [blank.complete(ref)]}
        b, c = M.reconcile_sparse(copy.deepcopy(person), local, copy.deepcopy(person))
        self.assertEqual(c["event_ref_list"], local["event_ref_list"])
        self.assertEqual(b["event_ref_list"], local["event_ref_list"])

    def test_a_sparse_list_element_is_not_turned_into_an_element_the_desktop_edited(self):
        ref = {"_class": "EventRef", "ref": "e" * 28, "role": {"_class": "EventRoleType", "value": 1, "string": ""}}
        edited = blank.complete(ref)
        edited["private"] = True
        person = {"_class": "Person", "handle": "p" * 28, "event_ref_list": [ref]}
        local = {"_class": "Person", "handle": "p" * 28, "event_ref_list": [edited]}
        b, c = M.reconcile_sparse(copy.deepcopy(person), local, copy.deepcopy(person))
        # the keyed element is reconciled field by field: the blank `private` of the base and cloud is not the desktop's `private`
        self.assertNotEqual(c["event_ref_list"][0].get("private"), True)
        self.assertTrue(c["event_ref_list"][0].get("note_list", []) == [])


class Decision(unittest.TestCase):
    """merge.merge_object over sparse sides: the decision, the local object and the push."""

    def setUp(self):
        self.full = blank.complete(sparse_event("e" * 28, "E9001", place="p" * 28))
        self.full["change"] = 1700000000
        self.full["description"] = "A real description"
        self.full["note_list"] = ["n" * 28]

    def merge(self, base, local, cloud):
        return M.merge_object(base, local, local, cloud, cloud_version=3, project_fn=lambda o: o)

    def test_a_sparse_cloud_over_a_complete_base_is_no_change_and_clears_nothing(self):
        r = self.merge(copy.deepcopy(self.full), copy.deepcopy(self.full), drop_keys(self.full))
        self.assertEqual(r.action, "unchanged")
        self.assertIsNone(r.local_obj)
        self.assertIsNone(r.push)

    def test_a_sparse_cloud_with_a_desktop_edit_keeps_the_edit_and_pushes_it(self):
        local = copy.deepcopy(self.full)
        local["description"] = "Edited on the desktop"
        r = self.merge(copy.deepcopy(self.full), local, drop_keys(self.full))
        self.assertEqual(r.action, "update")
        self.assertIsNone(r.local_obj, "the desktop object is the result")
        self.assertEqual(r.push["obj"]["description"], "Edited on the desktop")
        self.assertEqual(r.push["obj"]["note_list"], ["n" * 28], "the key the website left out is not sent as blank")

    def test_a_sparse_cloud_with_a_website_change_applies_that_change_and_nothing_else(self):
        cloud = drop_keys(self.full)
        cloud["place"] = "q" * 28
        r = self.merge(copy.deepcopy(self.full), copy.deepcopy(self.full), cloud)
        self.assertEqual(r.action, "update")
        want = copy.deepcopy(self.full)
        want["place"] = "q" * 28
        self.assertEqual(M.strip_change(r.local_obj), M.strip_change(want))

    def test_a_sparse_cloud_and_sparse_base_with_a_complete_desktop_object_is_no_change(self):
        local = blank.complete(sparse_event("e" * 28, "E9001", place="p" * 28))
        sp = drop_keys(local)
        r = self.merge(copy.deepcopy(sp), local, copy.deepcopy(sp))
        self.assertEqual(r.action, "unchanged")
        self.assertIsNone(r.push)

    def test_base_after_is_the_object_that_was_passed_in_not_the_completed_copy(self):
        local = blank.complete(sparse_event("e" * 28, "E9001", place="p" * 28))
        sp = drop_keys(local)
        cloud = copy.deepcopy(sp)
        r = self.merge(copy.deepcopy(sp), local, cloud)
        self.assertEqual(r.base_after, sp)
        self.assertNotIn("description", r.base_after)

    def test_a_desktop_value_back_at_the_blank_where_the_website_has_no_key_is_no_change(self):
        """DOCUMENTED EDGE: where the base and the cloud lack a key, a desktop value equal to the key's blank is "nothing" on both sides, so
        it is not pushed (a key the website never had is not created just to hold a blank). A desktop value that is not the blank is pushed."""
        local = blank.complete(sparse_event("e" * 28, "E9001", place="p" * 28))
        sparse = drop_keys(local)
        local["description"] = "Typed on the desktop"
        self.assertEqual(self.merge(copy.deepcopy(sparse), local, copy.deepcopy(sparse)).action, "update")
        local["description"] = ""
        r = self.merge(copy.deepcopy(sparse), local, copy.deepcopy(sparse))
        self.assertEqual((r.action, r.push, r.local_obj), ("unchanged", None, None))

    def test_a_cut_down_cloud_date_equal_to_the_base_date_is_no_change_and_a_desktop_date_edit_is_pushed(self):
        base = copy.deepcopy(self.full)
        base["date"] = copy.deepcopy(REAL_DATE)
        cloud = drop_keys(base)
        cloud["date"] = {"_class": "Date", "dateval": [0, 0, 1900, False]}
        r = self.merge(copy.deepcopy(base), copy.deepcopy(base), copy.deepcopy(cloud))
        self.assertEqual((r.action, r.push, r.local_obj), ("unchanged", None, None))
        local = copy.deepcopy(base)
        local["date"]["text"] = "edited on the desktop"
        r = self.merge(copy.deepcopy(base), local, copy.deepcopy(cloud))
        self.assertEqual(r.action, "update")
        self.assertEqual(r.push["obj"]["date"]["text"], "edited on the desktop")
        self.assertEqual(r.push["obj"]["date"]["sortval"], 2415000, "the keys the website's cut-down Date lacks are not sent as blank")

    def test_a_website_value_for_a_key_the_base_lacked_is_taken_not_a_conflict(self):
        local = blank.complete(sparse_event("e" * 28, "E9001", place="p" * 28))
        cloud = drop_keys(local)
        cloud["description"] = "Typed on the website"
        r = self.merge(drop_keys(local), local, cloud)
        self.assertEqual((r.action, r.conflicts), ("update", []))
        self.assertEqual(r.local_obj["description"], "Typed on the website")

    def test_a_desktop_value_and_a_different_website_value_for_a_key_the_base_lacked_is_a_conflict_not_a_loss(self):
        local = blank.complete(sparse_event("e" * 28, "E9001", place="p" * 28))
        local["description"] = "Typed on the desktop"
        cloud = drop_keys(local)
        cloud["description"] = "Typed on the website"
        r = self.merge(drop_keys(blank.complete(sparse_event("e" * 28, "E9001", place="p" * 28))), local, cloud)
        self.assertEqual([c["path"] for c in r.conflicts], ["/description"])
        self.assertIsNone(r.local_obj, "mode cli keeps the desktop value")


class BaseRows(unittest.TestCase):
    """The base row keeps the website's hash and, as obj_json, the website's object plus the keys it left out that the row held."""

    def test_nothing_rehashes_a_base_rows_object(self):
        """A row's `hash` is the website's hash of its sparse object, `obj_json` can hold more, so no code may compare the two. The only
        callers of object_hash outside canonical.py hash the website's own object (the snapshot, the push check, the row's hash)."""
        root = os.path.join(HERE, "..", "..")
        callers = set()
        for base_dir in ("hfygramps", "hfy_sync"):
            for dirpath, _dirs, files in os.walk(os.path.join(root, base_dir)):
                for name in files:
                    if name.endswith(".py") and name not in ("canonical.py", "blanks.py"):
                        with open(os.path.join(dirpath, name), encoding="utf-8") as fh:
                            if "object_hash(" in fh.read():
                                callers.add(name)
        self.assertEqual(callers, {"pushstate.py", "snapshot.py", "push.py"})

    def test_a_carried_row_keeps_the_websites_hash_and_a_load_of_the_row_matches_the_stored_hash(self):
        import sqlite3
        from hfygramps import canonical
        from hfygramps.addon import pushstate, sidecar
        full = blank.complete(sparse_event("e" * 28, "E9001", place="p" * 28))
        full["description"] = "Held by the row"
        full.pop("change", None)
        web = drop_keys(full)
        con = sqlite3.connect(":memory:")
        con.executescript(sidecar.DDL)
        pushstate._put_base(con, "Event", "e" * 28, 1, 1, full)
        pushstate._put_base(con, "Event", "e" * 28, 2, 2, web)
        (cls, handle, version, seq, hsh, obj_json, deleted), = con.execute("SELECT class, handle, version, seq, hash, obj_json, deleted FROM base")
        self.assertEqual(hsh, canonical.object_hash(web), "the hash stays the website's")
        self.assertEqual(json.loads(obj_json)["description"], "Held by the row", "the row keeps the key the website's object left out")
        self.assertNotEqual(canonical.object_hash(json.loads(obj_json)), hsh, "which is why nothing may rehash obj_json")


class FullTree(S.PullCase):
    """Whole pulls over the fixture tree: what changed is what was meant to change, and nothing else, byte for byte."""

    def cloud_objs(self):
        return {h: copy.deepcopy(v["obj"]) for h, v in self.env.cloud.heads.items()}

    def tree(self):
        return self.env.tree.objects()

    def events(self, objs):
        return [o for o in objs.values() if o["_class"] == "Event"]

    def plain_events(self, objs):
        """Events of the fixture that no rule treats specially (no birth-like type), as stable subjects of edits."""
        return [o for o in self.events(objs) if o["type"]["value"] not in (12, 13, 14, 15) and not o["private"]
                and o["handle"] in self.env.cloud.heads]

    def push_ops(self):
        doc = self.env.run("check")
        return len(self.env.preview(doc)["to_website"])

    def pulled(self, doc):
        return doc["counts"]["pulled"]

    # ---- the incident: six-key Events, a Tag, a Media
    def sparse_creates(self):
        place = next(v["obj"]["place"] for v in self.env.cloud.heads.values() if v["class"] == "Event" and v["obj"]["place"])   # a place the website holds
        evs = [
            sparse_event("a1" * 14, "E9101"),
            sparse_event("a2" * 14, "E9102", place=place),
            sparse_event("a3" * 14, "E9103", description="Fictional gathering"),
            sparse_event("a4" * 14, "E9104", place=place, description="Another fictional gathering",
                         date={"_class": "Date", "calendar": 0, "dateval": [0, 0, 1850, False], "modifier": 0, "newyear": 0, "quality": 0, "text": ""}),
        ]
        tag = {"_class": "Tag", "handle": "b1" * 14, "name": "Fixture New Tag", "color": "#aa0000", "priority": 2}
        media = next(copy.deepcopy(v["obj"]) for v in self.env.cloud.heads.values() if v["class"] == "Media")   # the website's form of a Media
        media.update(handle="b2" * 14, gramps_id="O9101", desc="Fictional new picture")
        return evs, tag, media

    def test_six_key_events_a_tag_and_a_media_pull_and_apply_without_an_error(self):
        e = self.env
        evs, tag, media = self.sparse_creates()
        before = self.tree()
        for o in evs + [tag, media]:
            e.cloud.put(o)
        doc = e.run("pull", yes=True)
        self.assertEqual((doc["result"], doc["exit_code"]), ("ok", 0), doc)
        self.assertEqual(self.pulled(doc)["create"], 6)
        after = self.tree()
        self.assertEqual(changed_handles(before, after), sorted(o["handle"] for o in evs + [tag, media]))
        for ev in evs:
            got = after[ev["handle"]]
            self.assertEqual(sorted(k for k in got if k != "change"), sorted(k for k in blank.BLANKS["Event"] if k != "change"), "every key of the class")
            for key in ev:
                if key != "date":
                    self.assertEqual(got[key], ev[key], "the website's own values are kept")
            self.assertEqual(got["private"], False)
            self.assertEqual(got["tag_list"], [])
        self.assertEqual(after[evs[3]["handle"]]["date"]["dateval"], [0, 0, 1850, False])
        self.assertEqual(after[evs[0]["handle"]]["description"], "")
        self.assertEqual(after[evs[2]["handle"]]["description"], "Fictional gathering")
        self.assertEqual({k: v for k, v in after[tag["handle"]].items() if k != "change"}, {k: v for k, v in tag.items() if k != "change"})
        self.assertEqual({k: v for k, v in after[media["handle"]].items() if k != "change"}, {k: v for k, v in media.items() if k != "change"})

    def test_a_second_pull_is_a_no_op_and_the_next_push_plan_has_no_ops(self):
        e = self.env
        evs, tag, media = self.sparse_creates()
        for o in evs + [tag, media]:
            e.cloud.put(o)
        self.assertEqual(e.run("pull", yes=True)["exit_code"], 0)
        after_first = self.tree()
        base_first = e.base_dump()
        doc = e.run("pull", yes=True)
        self.assertEqual((doc["result"], doc["exit_code"]), ("ok", 0))
        self.assertEqual(self.pulled(doc), {"create": 0, "update": 0, "delete": 0})
        self.assertEqual(self.tree(), after_first, "byte for byte")
        self.assertEqual(e.base_dump(), base_first, "the base rows still hold the website's sparse objects")
        self.assertEqual(self.push_ops(), 0, "the defaults the pull added are not a desktop edit")
        # the base row of a sparse event is the website's sparse object, not the completed one
        row = next(r for r in e.base_dump() if r[1] == evs[0]["handle"])
        self.assertEqual(sorted(json.loads(row[5])), sorted(SIX))

    def test_a_sparse_event_the_person_points_at_with_a_sparse_event_ref_pulls_and_settles(self):
        e = self.env
        evs, _tag, _media = self.sparse_creates()
        person = copy.deepcopy(next(o for o in self.cloud_objs().values() if o["_class"] == "Person" and o["event_ref_list"]))
        ref = {"_class": "EventRef", "ref": evs[1]["handle"], "role": {"_class": "EventRoleType", "value": 1, "string": ""}}
        person["event_ref_list"].append(ref)
        e.cloud.put(evs[1])
        e.cloud.put(person)
        before = self.tree()
        doc = e.run("pull", yes=True)
        self.assertEqual((doc["result"], doc["exit_code"]), ("ok", 0), doc)
        after = self.tree()
        self.assertEqual(changed_handles(before, after), sorted([evs[1]["handle"], person["handle"]]))
        got = after[person["handle"]]["event_ref_list"]
        self.assertEqual(got[:-1], before[person["handle"]]["event_ref_list"], "the Person's other event references are untouched")
        self.assertEqual(got[-1]["private"], False)
        self.assertEqual(got[-1]["note_list"], [])
        self.assertEqual(self.pulled(e.run("pull", yes=True)), {"create": 0, "update": 0, "delete": 0})
        self.assertEqual(self.push_ops(), 0)

    # ---- NO DATA LOSS (AC4)
    def plain_cloud_events(self, n):
        """The website's copies of `n` events no rule treats specially."""
        cloud = self.cloud_objs()
        return [copy.deepcopy(cloud[o["handle"]]) for o in self.plain_events(self.tree())[:n]]

    def year_only_cloud_event(self):
        """The website's copy of an event no rule treats specially whose desktop date is a bare year (a day and month are a local-only part:
        a website change over them is a composite conflict by design, and not what these tests are about)."""
        cloud = self.cloud_objs()
        for o in self.plain_events(self.tree()):
            if o["date"]["dateval"][:2] == [0, 0] and len(o["date"]["dateval"]) == 4:
                return copy.deepcopy(cloud[o["handle"]])
        raise AssertionError("the fixture holds no year-only event")

    def put_full_values(self, ev, **values):
        """The website holds real, non-blank values in keys a sparse copy will lack; one pull brings them to the tree and the base."""
        full = copy.deepcopy(ev)
        full.update(values)
        self.env.cloud.put(full)
        doc = self.env.run("pull", yes=True)
        self.assertEqual((doc["result"], doc["exit_code"]), ("ok", 0), doc)
        return full

    def test_a_sparse_website_copy_of_an_existing_event_clears_nothing(self):
        """(a) and (b): the website's object lacks keys the tree holds with real values; the tree keeps every one."""
        e = self.env
        ev = self.plain_cloud_events(1)[0]
        note = next(o for o in self.tree().values() if o["_class"] == "Note" and o["handle"] in e.cloud.heads)["handle"]
        tag = next(o for o in self.tree().values() if o["_class"] == "Tag" and o["handle"] in e.cloud.heads)["handle"]
        full = self.put_full_values(ev, description="Held on the website", note_list=[note], tag_list=[tag])
        self.assertEqual(self.tree()[ev["handle"]]["description"], "Held on the website")
        e.cloud.put(drop_keys(ev))                              # the website now sends six keys for the same event
        before = self.tree()
        base_before = e.base_dump()
        doc = e.run("pull", yes=True)
        self.assertEqual((doc["result"], doc["exit_code"]), ("ok", 0), doc)
        self.assertEqual(self.tree(), before, "nothing in the tree changed, byte for byte")
        got = self.tree()[ev["handle"]]
        self.assertEqual((got["description"], got["note_list"], got["tag_list"], got["private"]), (full["description"], [note], [tag], False))
        self.assertEqual(self.pulled(doc), {"create": 0, "update": 0, "delete": 0})
        self.assertEqual(self.push_ops(), 0, "(e) and nothing is sent back")
        self.assertNotEqual(e.base_dump(), base_before, "the base follows the website's version")
        row = next(r for r in e.base_dump() if r[1] == ev["handle"])
        self.assertEqual(json.loads(row[5])["description"], "Held on the website", "the base row keeps what the website's sparse copy left out")
        self.assertEqual(self.pulled(e.run("pull", yes=True)), {"create": 0, "update": 0, "delete": 0})
        self.assertEqual(self.tree(), before)

    def test_a_sparse_website_date_that_is_a_cut_down_copy_of_the_trees_date_clears_nothing(self):
        """AC4 (a) for value classes: a Date with no sortval, format or text, equal to the tree's in every key it holds, keeps them all."""
        e = self.env
        ev = self.year_only_cloud_event()
        self.put_full_values(ev, date=copy.deepcopy(REAL_DATE))
        self.assertEqual(self.tree()[ev["handle"]]["date"]["sortval"], 2415000)
        sp = drop_keys(ev)
        sp["date"] = {"_class": "Date", "dateval": [0, 0, 1900, False]}
        e.cloud.put(sp)
        before = self.tree()
        doc = e.run("pull", yes=True)
        self.assertEqual((doc["result"], doc["exit_code"]), ("ok", 0), doc)
        self.assertEqual(self.tree(), before, "the tree's Date keeps its sortval, format and text, byte for byte")
        self.assertEqual(self.pulled(doc), {"create": 0, "update": 0, "delete": 0})
        self.assertEqual(self.push_ops(), 0)
        self.assertEqual(self.pulled(e.run("pull", yes=True)), {"create": 0, "update": 0, "delete": 0})
        self.assertEqual(self.tree(), before)

    def test_a_sparse_website_date_that_was_really_changed_is_the_websites_whole_new_value(self):
        """The ruling: a changed Date replaces the Date whole (the old sortval and text describe a date that no longer stands); nothing else changes."""
        e = self.env
        ev = self.year_only_cloud_event()
        self.put_full_values(ev, date=copy.deepcopy(REAL_DATE), description="Held on the website")
        sp = drop_keys(ev)
        sp["date"] = {"_class": "Date", "dateval": [0, 0, 1850, False]}
        e.cloud.put(sp)
        before = self.tree()
        doc = e.run("pull", yes=True)
        self.assertEqual((doc["result"], doc["exit_code"]), ("ok", 0), doc)
        got = self.tree()[ev["handle"]]
        self.assertEqual((got["date"]["dateval"], got["date"]["text"]), ([0, 0, 1850, False], ""))
        want = {k: v for k, v in before[ev["handle"]].items() if k not in ("date", "change")}
        self.assertEqual({k: v for k, v in got.items() if k not in ("date", "change")}, want)
        self.assertEqual(changed_handles(before, self.tree()), [ev["handle"]])
        self.assertEqual(self.push_ops(), 0)

    def test_a_sparse_website_copy_with_one_real_change_changes_that_field_only(self):
        e = self.env
        ev = self.plain_cloud_events(1)[0]
        self.put_full_values(ev, description="Held on the website")
        other_place = next(o for o in self.tree().values() if o["_class"] == "Place" and o["handle"] != ev["place"])["handle"]
        sp = drop_keys(ev)
        sp["place"] = other_place
        before = self.tree()
        e.cloud.put(sp)
        doc = e.run("pull", yes=True)
        self.assertEqual((doc["result"], doc["exit_code"]), ("ok", 0), doc)
        want = copy.deepcopy(before[ev["handle"]])
        want["place"] = other_place
        got = self.tree()[ev["handle"]]
        self.assertEqual({k: v for k, v in got.items() if k != "change"}, {k: v for k, v in want.items() if k != "change"})
        self.assertEqual(got["description"], "Held on the website")
        self.assertEqual(changed_handles(before, self.tree()), [ev["handle"]])
        self.assertEqual(self.push_ops(), 0)

    def test_a_desktop_edit_survives_a_sparse_website_copy_and_goes_to_the_website(self):
        e = self.env
        ev = self.plain_cloud_events(1)[0]
        e.tree.edit(ev["handle"], lambda o: o.update(description="Edited on the desktop"))
        e.cloud.put(drop_keys(ev))
        doc = e.run("pull", yes=True)
        self.assertEqual((doc["result"], doc["exit_code"]), ("ok", 0), doc)
        self.assertEqual(self.tree()[ev["handle"]]["description"], "Edited on the desktop")
        self.assertEqual(self.push_ops(), 1, "the one real difference")

    def test_the_whole_tree_pull_changes_only_the_intended_objects_and_fields(self):
        """(d) and (e): sparse and full objects in one snapshot; the tree before and after differ only by the creates and the website's changes."""
        e = self.env
        evs = self.plain_cloud_events(4)
        tag_handle = next(o for o in self.tree().values() if o["_class"] == "Tag" and o["handle"] in e.cloud.heads)["handle"]
        for ev in evs:   # the website holds real values in the keys its sparse copies will lack
            full = copy.deepcopy(ev)
            full.update(description="Held on the website", tag_list=[tag_handle])
            e.cloud.put(full)
        self.assertEqual(e.run("pull", yes=True)["exit_code"], 0)
        before = self.tree()
        cloud = self.cloud_objs()
        e.cloud.put(drop_keys(cloud[evs[0]["handle"]]))                            # sparse, no change
        e.cloud.put(drop_keys(cloud[evs[1]["handle"]], SIX + ("description",)))    # sparse with its description, no change
        changed = drop_keys(cloud[evs[2]["handle"]])
        changed["description"] = "Changed on the website"                          # sparse and really changed
        e.cloud.put(changed)
        full = copy.deepcopy(cloud[evs[3]["handle"]])
        full["description"] = "Changed on the website, full object"                 # a full object, really changed
        e.cloud.put(full)
        note = copy.deepcopy(by_gid(cloud, "N0004"))
        note["text"]["string"] = "A fictional note edited on the website."          # a full object of another class
        e.cloud.put(note)
        creates, tag, media = self.sparse_creates()
        for o in creates + [tag, media]:
            e.cloud.put(o)
        doc = e.run("pull", yes=True)
        self.assertEqual((doc["result"], doc["exit_code"]), ("ok", 0), doc)
        after = self.tree()
        new = sorted(o["handle"] for o in creates + [tag, media])
        edited = sorted([evs[2]["handle"], evs[3]["handle"], note["handle"]])
        self.assertEqual(changed_handles(before, after), sorted(new + edited))
        for h in before:
            if h not in edited:
                self.assertEqual(json.dumps(after[h], sort_keys=True), json.dumps(before[h], sort_keys=True), "untouched, byte for byte: " + h)

        def without_change(o):
            return {k: v for k, v in o.items() if k != "change"}
        want2 = without_change(before[evs[2]["handle"]])
        want2["description"] = "Changed on the website"
        self.assertEqual(without_change(after[evs[2]["handle"]]), want2)
        want3 = without_change(before[evs[3]["handle"]])
        want3["description"] = "Changed on the website, full object"
        self.assertEqual(without_change(after[evs[3]["handle"]]), want3)
        want_note = without_change(before[note["handle"]])
        want_note["text"]["string"] = "A fictional note edited on the website."
        self.assertEqual(without_change(after[note["handle"]]), want_note)
        for h in (evs[0]["handle"], evs[1]["handle"]):
            self.assertEqual((after[h]["description"], after[h]["tag_list"]), ("Held on the website", [tag_handle]))
        self.assertEqual(self.pulled(doc), {"create": 6, "update": 3, "delete": 0})
        # (e) the push plan after the pull has no ops, and a second pull changes nothing
        self.assertEqual(self.push_ops(), 0)
        again = self.tree()
        self.assertEqual(self.pulled(e.run("pull", yes=True)), {"create": 0, "update": 0, "delete": 0})
        self.assertEqual(kinds(self.tree()), kinds(again))


if __name__ == "__main__":
    unittest.main()
