"""hfy-sync-render (HFY-TSK-176): the store view fold, the reference walk and the person mapping behind the render outbox.

``collect_refs`` is a port of ``collectRefs`` in api/src/records/semantics.js; when node is installed the test runs both on the same
objects and requires the same handles, so the renderer's idea of "what references what" cannot drift from the API's.
"""

import json
import os
import shutil
import subprocess
import unittest

import render_lambda_support as sup
import render_support as rs
from hfy_render.refs import collect_refs
from hfy_render.view import StoreView, closure_from, people_of, reverse_refs

SEMANTICS = os.path.join(sup.REPO, "api", "src", "records", "semantics.js")


def entry(seq, op, cls="Note", handle="n1", gid="N1", obj=None, **extra):
    item = {"seq": seq, "op": op, "class": cls, "handle": handle, "gramps_id": gid, "version": seq, "at": "2026-01-01T00:00:0%d.000Z" % (seq % 10),
            "principal": "p", "origin": "desktop", "obj_json": json.dumps(obj) if obj is not None else None}
    item.update(extra)
    return item


class Fold(unittest.TestCase):
    def test_the_newest_entry_of_an_object_wins_and_tombstones_stay(self):
        v = StoreView()
        v.fold(entry(1, "create", obj={"_class": "Note", "handle": "n1", "text": "a"}))
        v.fold(entry(2, "update", obj={"_class": "Note", "handle": "n1", "text": "b"}))
        v.fold(entry(3, "create", handle="n2", gid="N2", obj={"_class": "Note", "handle": "n2"}))
        v.fold(entry(4, "delete", handle="n2", gid="N2"))
        self.assertEqual(v.seq, 4)
        self.assertEqual(json.loads(v.heads[("Note", "n1")].obj_json)["text"], "b")
        self.assertTrue(v.heads[("Note", "n2")].deleted)
        self.assertEqual([h.handle for h in v.live_heads()], ["n1"])

    def test_a_marker_only_moves_the_seq(self):
        v = StoreView()
        v.fold({"seq": 5, "op": "marker", "obj_json": None, "at": "2026-01-01T00:00:05.000Z", "principal": "p", "origin": "desktop"})
        self.assertEqual((v.seq, v.heads, v.last_at), (5, {}, "2026-01-01T00:00:05.000Z"))

    def test_an_expunged_entry_leaves_no_object(self):
        v = StoreView()
        v.fold(entry(1, "create", obj={"_class": "Note", "handle": "n1"}))
        v.fold(entry(2, "update", obj=None, expunged=True))
        self.assertTrue(v.heads[("Note", "n1")].deleted)
        self.assertEqual(v.parsed_objects(), {})

    def test_a_replayed_or_older_entry_never_moves_a_head_back(self):
        v = StoreView()
        v.fold(entry(5, "update", obj={"_class": "Note", "handle": "n1", "text": "new"}))
        v.fold(entry(3, "update", obj={"_class": "Note", "handle": "n1", "text": "old"}))
        self.assertEqual(json.loads(v.heads[("Note", "n1")].obj_json)["text"], "new")

    def test_the_range_records_what_changed_and_the_object_before_it(self):
        v = StoreView(track_after=2)
        v.fold(entry(1, "create", obj={"_class": "Note", "handle": "n1", "text": "before"}))
        v.fold(entry(2, "create", handle="n2", gid="N2", obj={"_class": "Note", "handle": "n2"}))
        v.fold(entry(3, "update", obj={"_class": "Note", "handle": "n1", "text": "after"}, principal="p-a", origin="self"))
        v.fold(entry(4, "update", obj={"_class": "Note", "handle": "n1", "text": "again"}, principal="p-b", origin="admin"))
        v.fold(entry(5, "withdraw", handle="n2", gid="N2"))
        self.assertEqual(set(v.touched), {("Note", "n1"), ("Note", "n2")})
        t = v.touched[("Note", "n1")]
        self.assertEqual(json.loads(t.prev_json)["text"], "before", "the object as it was before the range, not before the last entry")
        self.assertEqual((v.touched[("Note", "n2")].op, v.touched[("Note", "n2")].gramps_id), ("withdraw", "N2"))
        self.assertEqual((v.principals, v.origins, v.range_entries), ({"p", "p-a", "p-b"}, {"desktop", "self", "admin"}, 3))


class People(unittest.TestCase):
    def setUp(self):
        self.objs = {(o["_class"], o["handle"]): o for o in rs.p_fixture()}
        self.rev = reverse_refs(self.objs)
        self.gid = lambda key: self.objs[key]["gramps_id"] if key in self.objs else ""

    def key(self, cls, gramps_id):
        return [k for k, o in self.objs.items() if k[0] == cls and o.get("gramps_id") == gramps_id][0]

    def test_a_person_maps_to_itself_and_the_people_of_the_families_that_hold_it(self):
        out = people_of([self.key("Person", "I0026")], self.objs, self.rev, self.gid)
        self.assertEqual(out, {"I0026"}, "a person in no family reaches nobody else")
        out = people_of([self.key("Person", "I0001")], self.objs, self.rev, self.gid)
        self.assertIn("I0001", out)
        self.assertIn("I0002", out, "the spouse's page shows this person")
        self.assertLess(len(out), len(self.objs) // 2, "a change never spreads across the whole tree")

    def test_a_note_maps_to_the_person_that_holds_it(self):
        self.assertEqual(people_of([self.key("Note", "N0001")], self.objs, self.rev, self.gid), {"I0012"})

    def test_a_place_maps_through_its_events(self):
        self.assertEqual(people_of([self.key("Place", "P0003")], self.objs, self.rev, self.gid), {"I0001", "I0002"})

    def test_a_dangling_reference_still_maps(self):
        gone = ("Note", "deadbeef")
        person = dict(self.objs[self.key("Person", "I0012")])
        person["note_list"] = list(person["note_list"]) + ["deadbeef"]
        objs = dict(self.objs)
        objs[self.key("Person", "I0012")] = person
        self.assertEqual(people_of([gone], objs, reverse_refs(objs), self.gid), {"I0012"})

    def test_the_closure_of_a_person_is_what_their_page_was_built_from(self):
        person = self.objs[self.key("Person", "I0012")]
        closure = closure_from(person, self.objs)
        for note in person["note_list"]:
            self.assertIn(note, closure)
        for ref in person["event_ref_list"]:
            self.assertIn(ref["ref"], closure)
        other = self.objs[self.key("Person", "I0001")]["handle"]
        self.assertNotIn(other, closure)


class RefsParity(unittest.TestCase):
    CASES = [
        {"_class": "Person", "handle": "p", "family_list": ["f1", "f2"], "parent_family_list": ["f3"], "note_list": ["n1", ""],
         "event_ref_list": [{"ref": "e1", "citation_list": ["c1"], "note_list": ["n2"]}, {"ref": ""}, "x"], "media_list": [{"ref": "m1", "note_list": ["n3"]}],
         "person_ref_list": [{"ref": "p2"}], "tag_list": ["t1"], "citation_list": ["c2"]},
        {"_class": "Family", "handle": "f", "father_handle": "a", "mother_handle": "", "child_ref_list": [{"ref": "c1"}, {"ref": "c2", "x": 1}],
         "event_ref_list": [{"ref": "e9"}], "source_handle": "wrong-place-but-scalar"},
        {"_class": "Place", "handle": "pl", "placeref_list": [{"ref": "up"}], "place": "not-a-list-scalar", "urls": [{"path": "x"}]},
        {"_class": "Source", "handle": "s", "reporef_list": [{"ref": "r1", "media_list": ["not-a-ref-in-here"]}], "nested": {"deep": [[{"ref": "z"}]]}},
        {"_class": "Event", "handle": "e", "place": "pl", "citation_list": ["c1", 2, None], "note_list": "not-a-list", "media_list": "no"},
    ]

    def test_known_cases(self):
        self.assertEqual(collect_refs(self.CASES[0]), [
            ("Family", "f1"), ("Family", "f2"), ("Family", "f3"), ("Note", "n1"), ("Event", "e1"), ("Citation", "c1"), ("Note", "n2"),
            ("Media", "m1"), ("Note", "n3"), ("Person", "p2"), ("Tag", "t1"), ("Citation", "c2")])

    @unittest.skipUnless(shutil.which("node") and os.path.exists(SEMANTICS), "node is not installed")
    def test_the_javascript_original_finds_the_same_handles(self):
        objects = self.CASES + list(rs.p_fixture())
        script = (
            "import {collectRefs} from %s; const objs = JSON.parse(await new Promise(r => {let s=''; process.stdin.on('data', d => s += d); process.stdin.on('end', () => r(s));}));"
            "console.log(JSON.stringify(objs.map(o => collectRefs(o).map(r => [r.cls, r.handle]))));" % json.dumps("file://" + SEMANTICS)
        )
        res = subprocess.run(["node", "--input-type=module", "-e", script], input=json.dumps(objects), capture_output=True, text=True, timeout=60)
        self.assertEqual(res.returncode, 0, res.stderr[-500:])
        js = json.loads(res.stdout)
        py = [[list(r) for r in collect_refs(o)] for o in objects]
        self.assertEqual(py, js)


if __name__ == "__main__":
    unittest.main()
