"""Sparse objects from the website against a real Gramps database (HFY-TSK-409): no KeyError, no cleared field.

Run by run.sh inside the bundled Python on a copy of the synthetic fixture tree, with the installed addon's `GrampsTree`. What this proves
that tests/unit/test_addon_sparse.py cannot: Gramps' own loader (`data_to_object`, `Event.set_object_state`) takes the completed object,
the committed blank table equals what Gramps builds for each class, and the completion never lets a missing key replace a value the
database holds. Everything is invented; the fixture is the synthetic tree.
"""
import copy
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "unit"))
import addon_support as S  # noqa: E402
import fixture_trees as ft  # noqa: E402
from test_addon_skeleton import AddonCase  # noqa: E402

try:
    import addon_pull_support as UP  # noqa: E402
except ImportError:  # pragma: no cover
    UP = None

def load_tool():
    sys.path.insert(0, S.PLUGIN_DIR)
    try:
        import hfy_sync_tool
        from hfygramps.addon import consts, errors, faults, runner
        from hfygramps import merge as M
    finally:
        if S.PLUGIN_DIR in sys.path:
            sys.path.remove(S.PLUGIN_DIR)
    return hfy_sync_tool, consts, errors, faults, runner, M


SIX = ("_class", "date", "gramps_id", "handle", "place", "type")
EDITOR_DATE = {"_class": "Date", "calendar": 0, "dateval": [0, 0, 1850, False], "modifier": 0, "newyear": 0, "quality": 0, "text": ""}


def six_key_event(handle, gid, place="", with_date=False, description=None):
    ev = {"_class": "Event", "handle": handle, "gramps_id": gid, "place": place,
          "date": copy.deepcopy(EDITOR_DATE) if with_date else {"_class": "Date", "calendar": 0, "dateval": [0, 0, 0, False], "modifier": 0,
                                                                 "newyear": 0, "quality": 0, "text": ""},
          "type": {"_class": "EventType", "string": "", "value": 7}}
    if description is not None:
        ev["description"] = description
    return ev


class BlankAgainstGramps(AddonCase):
    def setUp(self):
        super().setUp()
        try:
            self.tool, self.consts, self.errors, self.faults, self.runner, self.M = load_tool()
        except ImportError:
            self.skipTest("needs the bundled Gramps")
        from hfygramps import blank
        self.blank = blank

    def objects(self):
        return self.edit(lambda db, DbTxn: self.tool.GrampsTree(db).objects())

    def test_the_committed_table_is_what_gramps_builds_for_every_class(self):
        for name, table in sorted(self.blank.BLANKS.items()):
            self.assertEqual(self.tool._gramps_blank(name), table, name)

    def test_six_key_events_a_tag_and_a_media_apply_in_one_transaction_with_the_defaults(self):
        before = self.objects()
        place = next(h for h, o in before.items() if o["_class"] == "Place")
        tag = {"_class": "Tag", "handle": "b1" * 14, "name": "Fixture New Tag", "color": "#aa0000", "priority": 2}
        media = copy.deepcopy(next(o for o in before.values() if o["_class"] == "Media"))
        media.update(handle="b2" * 14, gramps_id="O9101", desc="Fictional new picture")
        media.pop("change", None)
        events = [six_key_event("a1" * 14, "E9101"), six_key_event("a2" * 14, "E9102", place=place),
                  six_key_event("a3" * 14, "E9103", description="Fictional gathering"),
                  six_key_event("a4" * 14, "E9104", place=place, with_date=True, description="Another fictional gathering")]
        commits = {o["handle"]: o for o in events + [tag, media]}

        def run(db, DbTxn):
            tree = self.tool.GrampsTree(db)
            tree.apply("Website sync: pull seq 11", commits, [])
            self.assertEqual(len(db.get_undodb().undoq), 1)
            return tree.objects()

        after = self.edit(run)
        self.assertEqual(sorted(h for h in after if after[h] != before.get(h)), sorted(commits))
        for ev in events:
            got = after[ev["handle"]]
            self.assertEqual(sorted(k for k in got), sorted(self.blank.BLANKS["Event"]), "the thirteen keys Gramps stores")
            for key in ("gramps_id", "place", "type"):
                self.assertEqual(got[key], ev[key])
            self.assertEqual((got["private"], got["attribute_list"], got["citation_list"], got["media_list"], got["note_list"], got["tag_list"]),
                             (False, [], [], [], [], []))
            self.assertEqual(got["description"], ev.get("description", ""))
        self.assertEqual(after[events[3]["handle"]]["date"]["dateval"], [0, 0, 1850, False])
        self.assertEqual({k: v for k, v in after[tag["handle"]].items() if k != "change"}, tag)
        self.assertEqual(after[media["handle"]]["desc"], "Fictional new picture")
        self.assertTrue(self.integrity_ok())

    def integrity_ok(self):
        con = S.sqlite_ro(os.path.join(self.dir, "sqlite.db"))
        try:
            return con.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        finally:
            con.close()

    def test_a_sparse_state_for_an_object_the_tree_holds_keeps_every_value_the_tree_holds(self):
        """The apply-level guard: whatever reaches `apply`, a missing key never turns into a blank over a stored value."""
        before = self.objects()
        ev = next(o for o in before.values() if o["_class"] == "Event" and o.get("description"))
        note = next(h for h, o in before.items() if o["_class"] == "Note")
        tag = next(h for h, o in before.items() if o["_class"] == "Tag")

        def hold(db, DbTxn):
            tree = self.tool.GrampsTree(db)
            held = copy.deepcopy(ev)
            held.update(note_list=[note], tag_list=[tag], private=False)
            tree.apply("Website sync: test setup", {held["handle"]: held}, [])
            return tree.objects()

        held_objs = self.edit(hold)
        held = held_objs[ev["handle"]]
        self.assertEqual((held["note_list"], held["tag_list"], held["description"]), ([note], [tag], ev["description"]))
        sparse = {k: copy.deepcopy(v) for k, v in held.items() if k in SIX}
        sparse["place"] = ""                      # a key the state HAS is the state's, even when it is blank

        def run(db, DbTxn):
            tree = self.tool.GrampsTree(db)
            tree.apply("Website sync: pull seq 12", {sparse["handle"]: sparse}, [])
            return tree.objects()

        after = self.edit(run)[ev["handle"]]
        self.assertEqual(after["place"], "")
        for key in ("description", "note_list", "tag_list", "private", "attribute_list", "citation_list", "media_list"):
            self.assertEqual(after[key], held[key], key)
        self.assertEqual({k: v for k, v in after.items() if k not in ("place", "change")}, {k: v for k, v in held.items() if k not in ("place", "change")})

    def test_a_cut_down_date_equal_to_the_trees_keeps_every_key_and_a_changed_one_is_replaced_whole(self):
        """A Date is a value, but a cut-down copy of the tree's own Date says nothing new: its missing keys are the tree's, never the blank."""
        before = self.objects()
        ev = next(o for o in before.values() if o["_class"] == "Event" and o["date"]["sortval"] and o["date"]["dateval"][0])
        full_date = ev["date"]
        sparse = {k: copy.deepcopy(v) for k, v in ev.items() if k in SIX}
        sparse["date"] = {"_class": "Date", "dateval": copy.deepcopy(full_date["dateval"])}

        def run(db, DbTxn):
            tree = self.tool.GrampsTree(db)
            tree.apply("Website sync: pull seq 14", {sparse["handle"]: sparse}, [])
            return tree.objects()

        after = self.edit(run)[ev["handle"]]
        self.assertEqual(after["date"], full_date, "sortval, format, text and the rest kept")
        self.assertEqual({k: v for k, v in after.items() if k != "change"}, {k: v for k, v in ev.items() if k != "change"})
        changed = copy.deepcopy(sparse)
        changed["date"] = {"_class": "Date", "dateval": [0, 0, 1851, False]}      # RULING: a changed Date is the website's whole new value

        def run2(db, DbTxn):
            tree = self.tool.GrampsTree(db)
            tree.apply("Website sync: pull seq 15", {changed["handle"]: changed}, [])
            return tree.objects()

        got = self.edit(run2)[ev["handle"]]
        self.assertEqual((got["date"]["dateval"], got["date"]["text"]), ([0, 0, 1851, False], ""))
        self.assertEqual({k: v for k, v in got.items() if k not in ("date", "change")}, {k: v for k, v in ev.items() if k not in ("date", "change")})

    def test_an_event_without_a_type_is_refused_not_made_a_birth(self):
        before = self.objects()
        ev = six_key_event("a1" * 14, "E9101")
        del ev["type"]
        digest = ft.db_digest(self.dir)

        def run(db, DbTxn):
            tree = self.tool.GrampsTree(db)
            with self.assertRaises(self.blank.SparseObjectRefused) as caught:
                tree.apply("Website sync: pull seq 13", {ev["handle"]: ev}, [])
            self.assertEqual(str(caught.exception), "'Event without type'", "names the class and the key, no values or ids")
            return tree.objects()

        self.assertEqual(self.edit(run), before)
        self.assertEqual(ft.db_digest(self.dir), digest)

    def test_the_runner_pulls_sparse_objects_a_second_pull_changes_nothing_and_the_push_plan_is_empty(self):
        from hfygramps.addon import mediafile

        self.bind()
        before_objects = self.objects()
        fixtures = os.path.join(HERE, "..", "fixtures")
        projected = UP.project_all(before_objects, files=mediafile.collect([o for o in before_objects.values() if o["_class"] == "Media"], fixtures))
        cloud = UP.FakeCloud(self.dbid, UP.heads_of(projected))
        env = dict(os.environ, HFY_SYNC_PS_CMD="true")

        def go(action, **opt):
            def run(db, DbTxn):
                return self.runner.run(self.tool.GrampsTree(db), "cli", self.runner.Options(action, **opt), argv=["gramps"], environ=env,
                                       services={"cloud": cloud})
            return self.edit(run)

        first = go("pull", yes=True)
        self.assertEqual((first["result"], first["exit_code"]), ("ok", 0), first["error"])
        settled = self.objects()
        pending_before = go("check")["counts"]["push_pending"]    # what the fixture tree alone would push (a held photo, say)
        place = next(v["obj"]["place"] for v in cloud.heads.values() if v["class"] == "Event" and v["obj"]["place"])   # a place the website holds
        # a full object the tree holds with a value in a key the sparse copy of ANOTHER event will lack
        held = copy.deepcopy(cloud.heads[next(h for h, o in settled.items() if o["_class"] == "Event" and o["type"]["value"] not in (12, 13, 14, 15)
                                              and h in cloud.heads)]["obj"])
        held["description"] = "Held on the website"
        cloud.put(held)
        self.assertEqual(go("pull", yes=True)["exit_code"], 0)
        settled = self.objects()
        new = [six_key_event("a1" * 14, "E9101"), six_key_event("a2" * 14, "E9102", place=place),
               six_key_event("a3" * 14, "E9103", description="Fictional gathering"),
               six_key_event("a4" * 14, "E9104", place=place, with_date=True, description="Another fictional gathering")]
        tag = {"_class": "Tag", "handle": "b1" * 14, "name": "Fixture New Tag", "color": "#aa0000", "priority": 2}
        for o in new + [tag]:
            cloud.put(o)
        cloud.put({k: v for k, v in held.items() if k in SIX})       # and the sparse copy of the event that holds a description
        second = go("pull", yes=True)
        self.assertEqual((second["result"], second["exit_code"]), ("ok", 0), second["error"])
        self.assertEqual(second["counts"]["pulled"], {"create": 5, "update": 0, "delete": 0})
        after = self.objects()
        self.assertEqual(sorted(h for h in after if after[h] != settled.get(h)), sorted(o["handle"] for o in new + [tag]),
                         "the creates and nothing else changed")
        self.assertEqual(after[held["handle"]]["description"], "Held on the website")
        again = go("pull", yes=True)
        self.assertEqual(again["counts"]["pulled"], {"create": 0, "update": 0, "delete": 0})
        self.assertEqual(self.objects(), after)
        checked = go("check")
        self.assertEqual(checked["counts"]["pulled"], {"create": 0, "update": 0, "delete": 0}, "nothing to pull")
        self.assertEqual(checked["counts"]["push_pending"], pending_before, "and the pull added nothing to push")
        self.assertTrue(self.integrity_ok())

    def test_a_mixed_sparse_and_full_snapshot_changes_only_the_intended_objects_byte_for_byte_and_the_push_plan_stays_empty(self):
        """AC4 (d) and (e) with Gramps' own loader: every Event the website holds comes back as a six-key copy, some with a real change, a
        Note comes back full and changed, new sparse objects arrive; the tree before and after differ in those and nothing else."""
        from hfygramps.addon import mediafile
        import json as _json

        self.bind()
        before_objects = self.objects()
        fixtures = os.path.join(HERE, "..", "fixtures")
        projected = UP.project_all(before_objects, files=mediafile.collect([o for o in before_objects.values() if o["_class"] == "Media"], fixtures))
        cloud = UP.FakeCloud(self.dbid, UP.heads_of(projected))
        env = dict(os.environ, HFY_SYNC_PS_CMD="true")

        def go(action, **opt):
            def run(db, DbTxn):
                return self.runner.run(self.tool.GrampsTree(db), "cli", self.runner.Options(action, **opt), argv=["gramps"], environ=env,
                                       services={"cloud": cloud})
            return self.edit(run)

        first = go("pull", yes=True)
        self.assertEqual((first["result"], first["exit_code"]), ("ok", 0), first["error"])
        pending = go("check")["counts"]["push_pending"]
        settled = self.objects()

        def dump(objs):
            return {h: _json.dumps(o, sort_keys=True) for h, o in objs.items()}

        events = sorted(h for h, v in cloud.heads.items() if v["class"] == "Event")
        plain = [h for h in events if cloud.heads[h]["obj"]["type"]["value"] not in (12, 13, 14, 15) and not cloud.heads[h]["obj"].get("private")]
        self.assertGreaterEqual(len(plain), 4)
        changed_desc = plain[:2]
        for h in events:                                   # every Event the website holds, cut down to the six keys the editor made
            sparse = {k: copy.deepcopy(v) for k, v in cloud.heads[h]["obj"].items() if k in SIX}
            if h in changed_desc:
                sparse["description"] = "Changed on the website"
            cloud.put(sparse)
        note = next(copy.deepcopy(v["obj"]) for v in cloud.heads.values() if v["class"] == "Note" and v["obj"]["gramps_id"] == "N0004")
        note["text"]["string"] = "A fictional note edited on the website."
        cloud.put(note)
        place = next(v["obj"]["place"] for v in cloud.heads.values() if v["class"] == "Event" and v["obj"]["place"])
        new = [six_key_event("a1" * 14, "E9101"), six_key_event("a2" * 14, "E9102", place=place),
               six_key_event("a3" * 14, "E9103", description="Fictional gathering"),
               six_key_event("a4" * 14, "E9104", place=place, with_date=True, description="Another fictional gathering")]
        tag = {"_class": "Tag", "handle": "b1" * 14, "name": "Fixture New Tag", "color": "#aa0000", "priority": 2}
        for o in new + [tag]:
            cloud.put(o)
        second = go("pull", yes=True)
        self.assertEqual((second["result"], second["exit_code"]), ("ok", 0), second["error"])
        self.assertEqual(second["counts"]["pulled"], {"create": 5, "update": 3, "delete": 0})
        after = self.objects()
        intended = sorted(changed_desc + [note["handle"]] + [o["handle"] for o in new + [tag]])
        d_before, d_after = dump(settled), dump(after)
        self.assertEqual(sorted(h for h in set(d_before) | set(d_after) if d_before.get(h) != d_after.get(h)), intended)
        for h in changed_desc:                             # a real change changes that field (and Gramps' own stamp) only
            want = {k: v for k, v in settled[h].items() if k not in ("description", "change")}
            self.assertEqual({k: v for k, v in after[h].items() if k not in ("description", "change")}, want)
            self.assertEqual(after[h]["description"], "Changed on the website")
        again = go("pull", yes=True)
        self.assertEqual(again["counts"]["pulled"], {"create": 0, "update": 0, "delete": 0})
        self.assertEqual(dump(self.objects()), d_after)
        checked = go("check")
        self.assertEqual(checked["counts"]["pulled"], {"create": 0, "update": 0, "delete": 0})
        self.assertEqual(checked["counts"]["push_pending"], pending, "(e) the pull added nothing to push")
        self.assertTrue(self.integrity_ok())


if __name__ == "__main__":
    unittest.main()
