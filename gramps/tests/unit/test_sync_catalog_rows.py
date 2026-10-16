"""Catalog rows that had no test of their own (HFY-TSK-150, review SI-21; error catalog D19, D34, D39, D40).

scripts/ci/sync-error-catalog.json maps every row of the sync error catalog to named tests. Most rows were covered where the behaviour was
built; these four were not, and D39 had no behaviour: a class or a field from a newer website made the whole snapshot unusable. Each test
names its row. Fake tree, fake cloud, the synthetic fixture; every value is fictional.
"""
import copy
import json
import os
import unittest

import addon_pull_support as S
import push_support as PS
from hfygramps.addon import consts, knownfields, plan as plan_mod, pushplan, snapshot
from test_addon_media import JPEG, new_media
from test_addon_pull import by_gid, load_cloud_objs, set_text
from test_addon_push import PushCase


class DanglingReferences(S.PullCase):
    """D19 (repaired): a reference that would dangle is found when the plan is made, not when the transaction is half done."""

    def cloud_person_with_a_missing_note(self):
        e = self.env
        p = copy.deepcopy(by_gid(load_cloud_objs(e), "I0001"))
        p["note_list"] = list(p.get("note_list") or []) + ["z" * 28]       # a Note the website does not have
        e.cloud.put(p)
        return p

    def test_d19_a_dangling_reference_is_an_integrity_conflict_naming_class_and_gramps_id_on_every_run(self):
        e = self.env
        self.cloud_person_with_a_missing_note()
        note = copy.deepcopy(by_gid(load_cloud_objs(e), "N0001"))
        note["format"] = 1
        e.cloud.put(note)                                                   # an unrelated website edit in the same pull
        before = e.tree.objects()
        for attempt in range(3):
            doc = e.run("pull", yes=True)
            # a plan-stage conflict (partial, exit 20), not an apply-time abort (refused, exit 65 "integrity") that would repeat for ever
            self.assertEqual((doc["result"], doc["exit_code"], doc["error"]["code"]), ("partial", 20, "conflicts_open"), attempt)
            pv = e.preview(doc)
            self.assertEqual([(c["kind"], c["class"], c["gramps_id"]) for c in pv["conflicts"]], [("integrity", "Person", "I0001")], attempt)
            self.assertIn("Note", pv["conflicts"][0]["reason"])
            self.assertEqual([i["problem"] for i in pv["integrity"]], ["dangling_reference"])
        after = e.tree.objects()
        self.assertEqual(after[note["handle"]]["format"], 1, "the rest of the plan applied, once")
        self.assertEqual({h: o for h, o in after.items() if h != note["handle"]}, {h: o for h, o in before.items() if h != note["handle"]},
                         "the person with the dangling reference was left as it is")
        self.assertEqual(len(e.tree.undo), 1, "the first pull applied the edit; no later run applied or aborted anything")

    def test_d19_the_conflict_ends_when_the_website_drops_the_reference(self):
        e = self.env
        self.cloud_person_with_a_missing_note()
        self.assertEqual(e.run("pull", yes=True)["exit_code"], 20)
        fixed = copy.deepcopy(by_gid(load_cloud_objs(e), "I0001"))
        fixed["note_list"] = [h for h in fixed["note_list"] if h != "z" * 28]
        fixed["gender"] = 2 if fixed.get("gender") != 2 else 1
        e.cloud.put(fixed)
        doc = e.run("pull", yes=True)
        self.assertEqual((doc["result"], doc["exit_code"]), ("ok", 0), doc["error"])
        self.assertEqual(by_gid(e.tree.objects(), "I0001")["gender"], fixed["gender"])

    def test_d19_an_incoming_delete_of_a_note_the_desktop_still_uses_is_an_integrity_conflict_not_a_delete(self):
        e = self.env
        objs = e.tree.objects()
        person = by_gid(objs, "I0012")                       # the one person of the fixture the website holds with a note
        note_handle = by_gid(load_cloud_objs(e), "I0012")["note_list"][0]
        note = objs[note_handle]
        e.cloud.tombstone(note_handle)
        doc = e.run("pull", yes=True, allow_deletes=True)
        self.assertEqual((doc["result"], doc["exit_code"]), ("partial", 20), doc["error"])
        pv = e.preview(doc)
        named = {(c["class"], c["gramps_id"]) for c in pv["conflicts"] if c["kind"] == "integrity"}
        self.assertEqual(named, {("Note", note["gramps_id"])}, "the object this run would remove is the one frozen")
        self.assertIn(person["handle"], [i for x in pv["integrity"] for i in x["involves"]], "and the person that still uses it is named")
        self.assertIn(note_handle, e.tree.objects(), "nothing was deleted")
        self.assertEqual(e.run("pull", yes=True, allow_deletes=True)["exit_code"], 20, "and the next run is the same, not an abort")


class MediaRoot(S.PullCase):
    def test_d34_a_media_root_that_cannot_be_written_defers_that_media_and_the_rest_of_the_pull_goes_on(self):
        e = self.env
        m = new_media(e)
        e.cloud.blobs[m["handle"]] = {"bytes": JPEG, "content_type": "image/jpeg"}
        e.cloud.put(m)
        note = copy.deepcopy(by_gid(load_cloud_objs(e), "N0001"))
        note["format"] = 1
        e.cloud.put(note)
        root = e.config["media_root"]
        with open(root, "w", encoding="utf-8") as fh:        # a file where the folder should be: every write under it fails with an OSError
            fh.write("not a folder")
        doc = e.run("pull", yes=True)
        self.assertEqual((doc["result"], doc["exit_code"]), ("partial", 20), doc["error"])
        self.assertNotIn(m["handle"], e.tree.objects())
        self.assertEqual(e.tree.objects()[note["handle"]]["format"], 1, "the rest of the plan applied")
        self.assertEqual([d["handle"] for d in e.preview(doc)["deferred"]], [m["handle"]])
        os.unlink(root)                                      # the person fixes the folder
        done = e.run("pull", yes=True)
        self.assertEqual((done["result"], done["counts"]["media_down"]), ("ok", 1))
        self.assertIn(m["handle"], e.tree.objects())


class UnknownKinds(S.PullCase):
    """D39: a class or a field this addon does not know is parked; nothing else about the run changes."""

    def a_widget(self):
        S.CLASS_RANK["Widget"] = len(S.CLASS_RANK)           # the fake snapshot writer sorts by the addon's classes
        self.addCleanup(S.CLASS_RANK.pop, "Widget", None)
        handle = "w" * 28
        self.env.cloud.heads[handle] = {"class": "Widget", "handle": handle, "gramps_id": "W0001", "version": 1, "seq": 2, "deleted": False,
                                        "obj": {"_class": "Widget", "handle": handle, "gramps_id": "W0001"}}
        self.env.cloud.seq = 2
        return handle

    def test_d39_an_object_of_a_class_this_addon_does_not_know_is_parked_and_the_rest_of_the_pull_goes_on(self):
        e = self.env
        widget = self.a_widget()
        note = copy.deepcopy(by_gid(load_cloud_objs(e), "N0004"))
        set_text(note, "Edited on the website.")
        e.cloud.put(note)
        for attempt in range(2):
            doc = e.run("pull", yes=True)
            self.assertEqual((doc["result"], doc["exit_code"], doc["error"]["code"]), ("partial", 20, "blocked"), attempt)
            deferred = e.preview(doc)["deferred"]
            self.assertEqual([(d["class"], d["handle"], d["gramps_id"]) for d in deferred], [("Widget", widget, "W0001")])
            self.assertIn("update the addon", deferred[0]["reason"])
            self.assertNotIn(widget, e.tree.objects())
            self.assertEqual(by_gid(e.tree.objects(), "N0004")["text"]["string"], "Edited on the website.")
        self.assertEqual(len(e.tree.undo), 1, "applied once; the second run found nothing to apply")
        self.assertEqual(e.run("check")["counts"]["blocked"], 1)

    def test_d39_the_snapshot_parser_counts_an_unknown_class_but_still_refuses_a_line_with_no_class(self):
        e = self.env
        self.a_widget()
        raw = S.snapshot_bytes(S.CLOUD_TREE, 2, list(e.cloud.heads.values()))[0]
        snap = snapshot.parse(raw)
        self.assertEqual([(p["class"], p["gramps_id"]) for p in snap.parked], [("Widget", "W0001")])
        self.assertEqual(len(snap.heads) + 1, snap.header["count"])
        bad = copy.deepcopy(e.cloud.heads[next(iter(e.cloud.heads))])
        bad["class"] = ""
        S.CLASS_RANK[""] = 99
        self.addCleanup(S.CLASS_RANK.pop, "", None)
        raw = S.snapshot_bytes(S.CLOUD_TREE, 2, [bad])[0]
        with self.assertRaises(snapshot.SnapshotError):
            snapshot.parse(raw)

    def test_d39_an_object_with_a_field_this_addon_does_not_know_is_parked_and_the_rest_of_the_pull_goes_on(self):
        e = self.env
        objs = load_cloud_objs(e)
        edited = copy.deepcopy(by_gid(objs, "N0004"))
        edited["sparkle"] = 1                                 # a field a later Gramps added
        set_text(edited, "Edited with a field from the future.")
        e.cloud.put(edited)
        fresh = copy.deepcopy(by_gid(objs, "N0004"))
        fresh.update(handle="a" * 28, gramps_id="N8101", sparkle=2)
        e.cloud.put(fresh)
        user = copy.deepcopy(by_gid(objs, "I0014"))
        user.update(handle="d" * 28, gramps_id="I8101", family_list=[], media_list=[], note_list=[fresh["handle"]])
        e.cloud.put(user)
        plain = copy.deepcopy(by_gid(objs, "N0001"))
        set_text(plain, "An ordinary edit.")
        e.cloud.put(plain)
        before = e.tree.objects()
        doc = e.run("pull", yes=True)
        self.assertEqual((doc["result"], doc["exit_code"], doc["error"]["code"]), ("partial", 20, "blocked"), doc["error"])
        after = e.tree.objects()
        self.assertEqual(after[edited["handle"]], before[edited["handle"]], "the object with the unknown field was left as the desktop has it")
        self.assertNotIn(fresh["handle"], after)
        self.assertNotIn(user["handle"], after, "what refers to a parked new object waits with it")
        self.assertEqual(after[plain["handle"]]["text"]["string"], "An ordinary edit.")
        by = {d["handle"]: d for d in e.preview(doc)["deferred"]}
        self.assertEqual(sorted(by), sorted([edited["handle"], fresh["handle"], user["handle"]]))
        self.assertEqual(by[edited["handle"]]["fields"], ["sparkle"])
        self.assertEqual(by[user["handle"]]["reason"], "refers to an object that is parked")
        again = e.run("pull", yes=True)
        self.assertEqual((again["exit_code"], again["counts"]["blocked"]), (20, 3))
        self.assertEqual(len(e.tree.undo), 1, "the second run changed nothing")

    def test_d39_the_known_fields_are_the_schema_exports(self):
        path = os.path.join(S.GRAMPS_DIR, "schema", "gramps-6.0.6.schema.json")
        with open(path, encoding="utf-8") as fh:
            defs = json.load(fh)["$defs"]
        self.assertEqual(sorted(knownfields.KNOWN_FIELDS), sorted(consts.CLASSES))
        for cls in consts.CLASSES:
            self.assertEqual(sorted(knownfields.KNOWN_FIELDS[cls]), sorted(defs[cls]["properties"]), cls)
        self.assertEqual(knownfields.unknown_fields("Note", {"_class": "Note", "zz": 1, "aa": 2}), ["aa", "zz"])
        self.assertEqual(knownfields.unknown_fields("Widget", {"x": 1}), [])
        self.assertEqual(knownfields.unknown_fields("Note", None), [])

    def test_d39_every_projected_object_of_the_fixture_has_only_known_fields(self):
        for h, o in S.project_all(S.load_fixture()).items():
            self.assertEqual(knownfields.unknown_fields(o["_class"], o), [], h)


class UnknownFieldOnPush(PushCase):
    full = True

    def test_d39_nothing_is_sent_for_an_object_whose_website_copy_has_a_field_the_addon_does_not_know(self):
        self.seed()
        note = next(h for h, hd in sorted(self.cloud.heads.items()) if hd["class"] == "Note" and not hd["deleted"])
        person = self.a_person()
        self.cloud.heads[note]["obj"]["sparkle"] = 1
        self.cloud.heads[note]["version"] += 1
        self.tree.edit(note, lambda o: o["text"].__setitem__("string", "Edited on the desktop."))
        self.tree.edit(person, lambda o: o["primary_name"].__setitem__("first_name", "Edited"))
        before = copy.deepcopy(self.cloud.heads[note])
        doc = self.push()
        self.assertEqual(self.cloud.heads[note], before, "the website's copy, with its new field, was not touched")
        self.assertEqual(self.cloud.heads[person]["obj"]["primary_name"]["first_name"], "Edited", "the rest of the push went")
        self.assertEqual(doc["exit_code"], 20)
        plan_blocked = [x for x in self.rows("SELECT handle, rule FROM holds") if x[0] == note]
        self.assertEqual(plan_blocked, [(note, "cloud_unknown_field")])


class ObjectSize(PushCase):
    full = True

    def test_d40_an_object_over_the_size_limit_is_held_and_the_rest_of_the_push_goes(self):
        self.seed()
        note = next(h for h, hd in sorted(self.cloud.heads.items()) if hd["class"] == "Note" and not hd["deleted"])
        person = self.a_person()
        before = copy.deepcopy(self.cloud.heads[note])
        self.tree.edit(note, lambda o: o["text"].__setitem__("string", "x" * (consts.PUSH_MAX_OBJ_BYTES + 1000)))
        self.tree.edit(person, lambda o: o["primary_name"].__setitem__("first_name", "Edited"))
        doc = self.push()
        self.assertEqual(self.exit_of(doc), ("partial", 20, "none"))
        self.assertEqual(self.rows("SELECT rule FROM holds WHERE handle = ?", note), [("object_too_large",)])
        self.assertEqual(self.cloud.heads[note], before, "the oversize record was not sent")
        self.assertNotIn("xxxxxxxx", self.cloud.log_text(), "and none of its text reached the website")
        self.assertEqual(self.cloud.heads[person]["obj"]["primary_name"]["first_name"], "Edited")
        self.tree.edit(note, lambda o: o["text"].__setitem__("string", "Trimmed."))     # the person trims it
        self.push()
        self.assertEqual(self.cloud.heads[note]["obj"]["text"]["string"], "Trimmed.")
        self.assertEqual(self.rows("SELECT rule FROM holds WHERE handle = ?", note), [])


if __name__ == "__main__":
    unittest.main()
