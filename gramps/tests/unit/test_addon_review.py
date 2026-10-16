"""The Gramps window's content and its one-run apply (task addon-gui-preview, HFY-TSK-208): sync.md 13.1, BRD2 11.1.

    python3 -m unittest gramps/tests/unit/test_addon_review.py

No Gtk and no Gramps: `hfygramps.addon.review` is the window's model and its flow, and the window only draws it. A `Flow` runs the
real runner (pull and push) over the push tests' fake website and fixture tree, so the review, the decisions on conflicts, the
confirmations, the editor-window refusal, the step-up before the deletes and the result banner are all exercised end to end. The window
itself is exercised on a fixture copy in gramps/tests/gramps/test_addon_gui.py (local macOS). Every value is the fixture's.
Python 3.9 compatible.
"""
import copy
import hashlib
import json
import os
import shutil
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import push_support as PS  # noqa: E402
import test_addon_media_up as MU  # noqa: E402  (the module only: its test classes must not be collected here a second time)
from test_addon_push import PushCase, birth_needles  # noqa: E402
from hfygramps import merge as M  # noqa: E402
from hfygramps import projection as PR  # noqa: E402
from hfygramps.addon import consts, decide, paths, plan as plan_mod, pushplan, review, sidecar  # noqa: E402

NAME = "/primary_name/first_name"


def GPS_PHOTO():
    """The fixture's synthetic JPEG with an EXIF GPS position."""
    with open(os.path.join(MU.FIXTURE_MEDIA, "synthetic-photo-gps.jpg"), "rb") as fh:
        return fh.read()


class Base(PushCase):
    def flow(self):
        return review.Flow(self.tree, environ=self.env, services={"cloud": PS.PullView(self.cloud), "client": self.cloud})

    def section(self, rv, sid):
        return rv.model["by_id"][sid]

    def sec_rows(self, rv, sid):
        return self.section(rv, sid)["rows"]

    def conflict_row(self, rv, handle=None):
        rows = self.sec_rows(rv, "conflicts")
        return next(r for r in rows if handle is None or r["handle"] == handle)

    def preview_files_text(self):
        """Everything this addon writes about a run, apart from the backups (which are copies of the tree): previews, status, logs."""
        tp = paths.TreePaths(self.tree.dbid, self.env)
        out = []
        for root in (tp.previews, tp.logs):
            if os.path.isdir(root):
                for n in sorted(os.listdir(root)):
                    with open(os.path.join(root, n), encoding="utf-8") as fh:
                        out.append(fh.read())
        if os.path.exists(tp.status):
            with open(tp.status, encoding="utf-8") as fh:
                out.append(fh.read())
        return "\n".join(out)


class TheModel(Base):
    def setup_changes(self):
        self.seed()
        self.h1 = self.a_person()
        self.h2 = self.a_person(not_in=[self.h1])
        self.h3 = self.a_person(not_in=[self.h1, self.h2])
        self.tree.edit(self.h1, lambda o: o["primary_name"].__setitem__("first_name", "Mine"))
        self.cloud.edit(self.h1, lambda o: o["primary_name"].__setitem__("first_name", "Theirs"))     # a conflict
        self.cloud.edit(self.h2, lambda o: o["primary_name"].__setitem__("nick", "Nicky"))             # from the website
        self.tree.edit(self.h3, lambda o: o["primary_name"].__setitem__("call", "Cally"))              # to the website

    def test_the_header_the_five_sections_and_their_counts(self):  # AC1
        self.setup_changes()
        rv = self.flow().review()
        self.assertIsNone(rv.refusal)
        self.assertEqual([s["id"] for s in rv.model["sections"]], ["from_website", "to_website", "conflicts", "held", "blocked"])
        self.assertEqual([s["title"] for s in rv.model["sections"]], ["From the website", "To the website", "Conflicts", "Held back", "Blocked"])
        counts = {s["id"]: s["count"] for s in rv.model["sections"]}
        self.assertEqual((counts["from_website"], counts["to_website"], counts["conflicts"], counts["blocked"]), (1, 1, 1, 0))
        self.assertEqual(self.section(rv, "from_website")["summary"], "create 0 · update 1 · delete 0")
        self.assertEqual(self.section(rv, "to_website")["summary"], "create 0 · update 1 · delete 0")
        h = rv.model["header"]
        self.assertEqual(h["tree"], self.tree.name)
        self.assertEqual(h["website"], "harrisonfamily.us")
        self.assertEqual(h["signed_in"], "I9001", "the token's subject, in memory only")
        self.assertIn("seq", h["website_version"])
        self.assertTrue(h["last_sync"])
        self.assertEqual(rv.model["apply_label"], "Apply 1 · Push 1")
        self.assertIn("Undo is available until you close the tree", rv.model["warning"])

    def test_rows_expand_to_field_level_diffs(self):  # AC1
        self.setup_changes()
        rv = self.flow().review()
        (row,) = self.sec_rows(rv, "from_website")
        self.assertEqual(row["handle"], self.h2)
        self.assertEqual([(d["path"], d["website"]) for d in row["diffs"]], [("/primary_name/nick", "Nicky")])
        self.assertEqual(row["diffs"][0]["label"], "primary name › nick")
        (out,) = self.sec_rows(rv, "to_website")
        self.assertEqual(out["handle"], self.h3)
        self.assertEqual([(d["path"], d["desktop"]) for d in out["diffs"]], [("/primary_name/call", "Cally")])
        c = self.conflict_row(rv)
        self.assertEqual([(d["base"], d["website"], d["yours"]) for d in c["diffs"]], [("Birch", "Theirs", "Mine")])

    def test_a_persons_name_links_to_their_page_and_a_record_with_no_id_is_plain_text(self):  # P2-R46
        self.setup_changes()
        rv = self.flow().review()
        row = self.sec_rows(rv, "from_website")[0]
        gid = self.tree.data[self.h2]["gramps_id"]
        self.assertEqual(row["person_url"], "https://harrisonfamily.us/person/?id=%s" % gid)
        self.assertEqual(row["name"], review.person_name(self.tree.data[self.h2]))
        self.assertTrue(row["name"])
        self.assertIsNone(review.person_url("https://harrisonfamily.us", "Person", ""))
        self.assertIsNone(review.person_url("https://harrisonfamily.us", "Event", "E0001"))
        ev = [r for r in self.sec_rows(rv, "held")]
        self.assertTrue(all(r["person_url"] is None for r in ev if r["class"] != "Person"))

    def test_every_conflict_offers_keep_mine_take_website_and_skip(self):  # AC1
        self.setup_changes()
        rv = self.flow().review()
        c = self.conflict_row(rv)
        self.assertEqual([x["id"] for x in c["choices"]], ["keep_mine", "take_website", "skip"])
        self.assertEqual([x["label"] for x in c["choices"]], ["Keep mine", "Take website", "Skip for now"])
        self.assertEqual(c["default"], "keep_mine")

    def test_the_check_changes_nothing_and_stores_no_value(self):
        self.setup_changes()
        before = copy.deepcopy(self.tree.data)
        heads = copy.deepcopy(self.cloud.heads)
        self.flow().review()
        self.assertEqual(self.tree.data, before)
        self.assertEqual(self.cloud.heads, heads)
        self.assertEqual(self.rows("SELECT COUNT(*) FROM conflicts")[0][0], 0, "a dry run stores nothing")


    def test_the_header_says_when_the_website_has_rendered_up_to_its_version(self):
        self.setup_changes()
        self.assertNotIn("rendered", self.flow().review().model["header"]["website_version"])
        self.cloud.meta_overrides = {"rendered_seq": self.cloud.seq}
        self.assertIn("(rendered \u2713)", self.flow().review().model["header"]["website_version"])

    def test_a_refused_check_is_a_refusal_not_a_model(self):
        self.setup_changes()
        self.cloud.tree_id = "another-cloud-tree"
        rv = self.flow().review()
        self.assertIsNone(rv.model)
        self.assertEqual(rv.refusal["error"]["code"], "D50")


class Decisions(Base):
    def conflict(self):
        self.seed()
        self.h = self.a_person()
        self.tree.edit(self.h, lambda o: o["primary_name"].__setitem__("first_name", "Mine"))
        self.cloud.edit(self.h, lambda o: o["primary_name"].__setitem__("first_name", "Theirs"))
        fl = self.flow()
        return fl, fl.review()

    def name_here(self):
        return self.tree.data[self.h]["primary_name"]["first_name"]

    def name_there(self):
        return self.cloud.heads[self.h]["obj"]["primary_name"]["first_name"]

    def test_keep_mine_applies_in_the_same_run_and_the_website_takes_it(self):  # AC1
        fl, rv = self.conflict()
        cid = self.conflict_row(rv)["id"]
        banner = fl.apply(rv, {cid: {"choice": "keep_mine"}})
        self.assertEqual((self.name_here(), self.name_there()), ("Mine", "Mine"))
        self.assertTrue(banner["ok"], banner)
        self.assertEqual(self.rows("SELECT state, decision FROM conflicts WHERE id = ?", cid), [("resolved", "keep_mine")])
        again = fl.review()
        self.assertEqual(again.model["by_id"]["conflicts"]["count"], 0)


    def test_a_decision_given_as_a_plain_string_is_understood(self):  # decide._normal accepts it, so apply must too
        fl, rv = self.conflict()
        cid = self.conflict_row(rv)["id"]
        banner = fl.apply(rv, {cid: "keep_mine"})
        self.assertEqual((self.name_here(), self.name_there()), ("Mine", "Mine"))
        self.assertTrue(banner["ok"], banner)

    def test_take_website_applies_in_the_same_run_and_nothing_is_pushed(self):  # AC1
        fl, rv = self.conflict()
        cid = self.conflict_row(rv)["id"]
        sent = len(self.cloud.batches)
        banner = fl.apply(rv, {cid: {"choice": "take_website"}})
        self.assertEqual((self.name_here(), self.name_there()), ("Theirs", "Theirs"))
        self.assertEqual(len(self.cloud.batches), sent, "the two sides agree: nothing goes out")
        self.assertEqual(self.rows("SELECT state, decision FROM conflicts WHERE id = ?", cid), [("resolved", "take_website")])
        self.assertIn("Applied from the website: 0 new, 1 changed, 0 deleted.", banner["lines"])
        self.assertEqual(len(self.tree.undo), 1, "one Edit > Undo entry")

    def test_skip_leaves_the_conflict_open_and_both_sides_alone(self):  # AC1
        fl, rv = self.conflict()
        cid = self.conflict_row(rv)["id"]
        fl.apply(rv, {cid: {"choice": "skip"}})
        self.assertEqual((self.name_here(), self.name_there()), ("Mine", "Theirs"))
        self.assertEqual(self.rows("SELECT state, decision FROM conflicts WHERE id = ?", cid), [("open", None)])
        self.assertEqual(fl.review().model["by_id"]["conflicts"]["count"], 1)

    def role_conflict(self):
        self.seed()
        person = self.tree.person_by_id("I0002")
        self.h = person["handle"]
        self.tree.edit(self.h, lambda o: o["event_ref_list"][0]["role"].update({"value": 7}))
        self.cloud.edit(self.h, lambda o: o["event_ref_list"][0]["role"].update({"value": 9}))
        fl = self.flow()
        rv = fl.review()
        return fl, rv, next(r for r in self.sec_rows(rv, "conflicts") if r["handle"] == self.h)

    def roles(self):
        return (self.tree.data[self.h]["event_ref_list"][0]["role"]["value"], self.cloud.heads[self.h]["obj"]["event_ref_list"][0]["role"]["value"])

    def test_a_conflict_inside_a_keyed_list_is_decided_at_its_own_element(self):  # AC1
        fl, rv, row = self.role_conflict()
        self.assertEqual((row["diffs"][0]["base"], row["diffs"][0]["website"], row["diffs"][0]["yours"]), ("type 1", "type 9", "type 7"))
        fl.apply(rv, {row["id"]: {"choice": "take_website"}})
        self.assertEqual(self.roles(), (9, 9))
        self.assertEqual(self.tree.data[self.h]["event_ref_list"][1], self.cloud.heads[self.h]["obj"]["event_ref_list"][1], "the other element is untouched")

    def test_keep_mine_inside_a_keyed_list_pushes_the_local_element_value(self):  # AC1
        fl, rv, row = self.role_conflict()
        fl.apply(rv, {row["id"]: {"choice": "keep_mine"}})
        self.assertEqual(self.roles(), (7, 7))

    def test_the_command_line_never_resolves_a_conflict_even_when_it_is_handed_decisions(self):
        fl, rv = self.conflict()
        cid = self.conflict_row(rv)["id"]
        doc = self.pull("pull", mode="cli", decisions={cid: {"choice": "take_website"}})
        self.assertEqual((doc["result"], doc["exit_code"], doc["next_action"]), ("partial", 20, "resolve_conflicts"))
        self.assertEqual((self.name_here(), self.name_there()), ("Mine", "Theirs"))
        self.assertEqual(self.rows("SELECT state, decision FROM conflicts WHERE id = ?", cid), [("parked", None)])

    def test_no_decision_is_the_same_as_skip(self):
        fl, rv = self.conflict()
        fl.apply(rv, {})
        self.assertEqual((self.name_here(), self.name_there()), ("Mine", "Theirs"))

    def test_the_reviewed_plan_is_what_is_applied_even_with_decisions(self):
        fl, rv = self.conflict()
        cid = self.conflict_row(rv)["id"]
        self.cloud.edit(self.h, lambda o: o["primary_name"].__setitem__("first_name", "Theirs again"))   # the website moves after the review
        banner = fl.apply(rv, {cid: {"choice": "take_website"}})
        self.assertFalse(banner["ok"])
        self.assertTrue(any("plan_changed" in line for line in banner["lines"]), banner)
        self.assertEqual(self.name_here(), "Mine", "nothing was applied")

    def test_a_fixed_conflict_can_only_be_skipped(self):
        c = {"kind": "identity", "path": "", "cloud": None, "local": {}}
        self.assertEqual([x["id"] for x in decide.choices(c)], ["skip"])
        c = {"kind": "integrity", "path": "", "cloud": {}, "local": {}}
        self.assertEqual(decide.conflict_type(c), decide.KIND_FIXED)

    def test_set_local_value_puts_the_decided_value_at_the_conflicts_path(self):
        data = PS.load_fixture()
        ev = next(o for o in data.values() if o["_class"] == "Event" and o["gramps_id"] == "E0001")
        from hfygramps import projection as PR
        lp = PR.project_tree(list(data.values()))[0][ev["handle"]]
        new = M.set_local_value({"path": "/date"}, ev, lp, lp, {"_class": "Date", "calendar": 0, "dateval": [0, 0, 1900, False], "format": None,
                                                              "modifier": 0, "newyear": 0, "quality": 0, "sortval": 0, "text": ""})
        self.assertEqual(new["date"]["dateval"], [0, 0, 1900, False])
        self.assertEqual({k: v for k, v in new.items() if k != "date"}, {k: v for k, v in ev.items() if k != "date"})
        self.assertEqual(ev["date"]["dateval"][:3], [14, 2, 1840], "the input is not touched")
        with self.assertRaises(ValueError):
            M.set_local_value({"path": ""}, ev, lp, lp, {})
        with self.assertRaises(ValueError):
            M.set_local_value({"path": "/nothing/here"}, ev, lp, lp, 1)


class CompositeDate(Base):
    full = True

    def setUp(self):
        Base.setUp(self)
        self.seed()
        person = self.tree.person_by_id("I0003")
        self.birth = self.tree.data[person["event_ref_list"][person["birth_ref_index"]]["ref"]]
        self.dv = list(self.birth["date"]["dateval"])
        self.assertTrue(self.dv[0] and self.dv[1], "the fixture's birth has a day and a month")
        h = self.birth["handle"]
        self.cloud.edit(h, lambda o: o["date"]["dateval"].__setitem__(2, self.dv[2] + 1))        # the website corrects the year
        self.fl = self.flow()
        self.rv = self.fl.review()
        self.row = self.conflict_row(self.rv, h)

    def local_date(self):
        return self.tree.data[self.birth["handle"]]["date"]["dateval"][:3]

    def cloud_date(self):
        return self.cloud.heads[self.birth["handle"]]["obj"]["date"]["dateval"][:3]

    def test_a_composite_date_conflict_offers_three_choices_and_the_default_keeps_my_day_and_month(self):  # AC6
        self.assertEqual(self.row["type"], decide.KIND_DATE)
        self.assertEqual([x["id"] for x in self.row["choices"]], ["keep_mine", "take_year_keep_daymonth", "clear_daymonth", "skip"])
        self.assertEqual([x["label"] for x in self.row["choices"]][:3],
                         ["Keep mine", "Take the website year and keep my day and month", "Take the website value and clear my day and month"])
        self.assertEqual(self.row["default"], "take_year_keep_daymonth")
        by = {x["id"]: x for x in self.row["choices"]}
        self.assertTrue(by["clear_daymonth"]["needs_confirmation"])
        self.assertFalse(by["take_year_keep_daymonth"]["needs_confirmation"])

    def test_the_yours_column_is_read_live_with_the_local_day_and_month_and_the_website_column_has_the_year_only(self):  # AC4
        d = self.row["diffs"][0]
        self.assertEqual(d["yours"], review.date_text(self.birth["date"]))
        self.assertTrue(d["yours_local_only"])
        self.assertIn("%d" % self.dv[0], d["yours"])
        self.assertEqual(d["website"], str(self.dv[2] + 1))
        self.assertEqual(d["base"], str(self.dv[2]))

    def test_the_default_takes_the_website_year_and_keeps_the_local_day_and_month(self):  # AC6, review SI-09
        banner = self.fl.apply(self.rv, {self.row["id"]: {"choice": "take_year_keep_daymonth"}})
        self.assertTrue(banner["ok"], banner)
        self.assertEqual(self.local_date(), [self.dv[0], self.dv[1], self.dv[2] + 1])
        self.assertEqual(self.cloud_date(), [0, 0, self.dv[2] + 1])
        for needle in birth_needles(self.tree.data):
            self.assertNotIn(needle, self.cloud.log_text())

    def test_keep_mine_keeps_the_local_date_and_the_website_gets_the_year_only(self):  # AC6
        self.fl.apply(self.rv, {self.row["id"]: {"choice": "keep_mine"}})
        self.assertEqual(self.local_date(), self.dv[:3])
        self.assertEqual(self.cloud_date(), [0, 0, self.dv[2]])
        for needle in birth_needles(self.tree.data):
            self.assertNotIn(needle, self.cloud.log_text())

    def test_clearing_the_day_and_month_needs_the_extra_confirmation(self):  # AC6
        self.fl.apply(self.rv, {self.row["id"]: {"choice": "clear_daymonth"}})
        self.assertEqual(self.local_date(), self.dv[:3], "without the confirmation nothing was cleared")
        self.assertEqual(self.fl.review().model["by_id"]["conflicts"]["count"], 1)
        rv = self.fl.review()
        self.fl.apply(rv, {self.row["id"]: {"choice": "clear_daymonth", "confirmed": True}})
        self.assertEqual(self.local_date(), [0, 0, self.dv[2] + 1])
        self.assertEqual(self.cloud_date(), [0, 0, self.dv[2] + 1])

    def test_a_local_only_value_never_leaves_the_computer_in_any_request_file_or_log(self):  # AC4 (request-log check)
        needles = birth_needles(self.tree.data) + ["%d %s" % (self.dv[0], "Feb")]
        live = "".join(d["yours"] for d in self.row["diffs"])
        self.assertIn(str(self.dv[0]), live, "the yours column does show the day")
        self.fl.apply(self.rv, {self.row["id"]: {"choice": "take_year_keep_daymonth"}})
        text = self.cloud.log_text()
        for needle in birth_needles(self.tree.data):
            self.assertNotIn(needle, text)
        files = self.preview_files_text()
        for needle in birth_needles(self.tree.data):
            self.assertNotIn(needle, files, "the preview files, status and logs hold projected values only")
        self.assertNotIn('"dateval": [%d, %d, %d' % tuple(self.dv[:3]), files)
        self.assertTrue(needles)


class Deletes(Base):
    pad = 120   # a bigger tree: deleting a dozen stays under the 10 percent line of the tree-similarity guard (D03)

    def setUp(self):
        Base.setUp(self)
        self.seed()
        self.stepped_up_calls = 0

    def step_up(self):
        self.stepped_up_calls += 1
        self.stepped_up()
        return True

    def victims(self, n):
        out = []
        for h, hd in sorted(self.cloud.heads.items()):
            if hd["class"] == "Note" and h.startswith("padnote") and len(out) < n:
                out.append(h)
        return out

    def website_deletes(self, handles):
        for h in handles:
            self.cloud.heads[h].update(deleted=True, obj=None, version=self.cloud.heads[h]["version"] + 1)
        self.cloud.seq += 1

    def test_an_incoming_delete_needs_a_modal_that_lists_the_object_and_declining_keeps_it(self):  # AC2
        (h,) = self.victims(1)
        self.website_deletes([h])
        fl = self.flow()
        rv = fl.review()
        (modal,) = [m for m in rv.model["confirmations"] if m["id"] == "incoming_deletes"]
        self.assertEqual([o["handle"] for o in modal["objects"]], [h])
        self.assertEqual(modal["objects"][0]["title"], "Note %s" % self.tree.data[h]["gramps_id"])
        banner = fl.apply(rv, {}, {"incoming_deletes": False})
        self.assertIn(h, self.tree.data, "declined: the record stays")
        self.assertIn("Applied from the website: 0 new, 0 changed, 0 deleted.", banner["lines"])
        rv = fl.review()
        self.assertEqual([r["note"] for r in self.sec_rows(rv, "blocked")], [])  # the website's delete is offered again: it was only declined

    def test_confirming_the_incoming_delete_removes_it_in_one_undo_entry(self):  # AC2
        (h,) = self.victims(1)
        self.website_deletes([h])
        fl = self.flow()
        rv = fl.review()
        banner = fl.apply(rv, {}, {"incoming_deletes": True})
        self.assertNotIn(h, self.tree.data)
        self.assertIn("Applied from the website: 0 new, 0 changed, 1 deleted.", banner["lines"])
        self.assertEqual(len(self.tree.undo), 1)

    def test_a_mass_of_incoming_deletes_lists_every_object_in_one_modal(self):  # AC2
        gone = self.victims(12)
        self.website_deletes(gone)
        fl = self.flow()
        rv = fl.review()
        (modal,) = [m for m in rv.model["confirmations"] if m["id"] == "incoming_deletes"]
        self.assertTrue(modal["mass"])
        self.assertEqual(sorted(o["handle"] for o in modal["objects"]), sorted(gone))
        self.assertIn("mass delete", modal["text"])
        fl.apply(rv, {}, {"incoming_deletes": False})
        self.assertTrue(all(h in self.tree.data for h in gone))
        rv = fl.review()
        fl.apply(rv, {}, {"incoming_deletes": True})
        self.assertFalse(any(h in self.tree.data for h in gone), "confirmed: the mass delete is applied")

    def test_a_mass_delete_the_plan_holds_back_carries_a_rule_code_the_window_matches_on(self):
        gone = self.victims(12)
        self.website_deletes(gone)
        fl = self.flow()
        rv = fl.review()
        doc = fl.run("pull", dry_run=True, confirm_deletes=True, confirm_mass_delete=False)
        pv = fl._preview(doc)
        held = review.mass_blocked(pv)
        self.assertEqual(sorted(b["handle"] for b in held), sorted(gone), pv.get("blocked"))
        self.assertTrue(all(b["rule"] == "mass_delete" and b["reason"].startswith("mass delete") for b in held))
        self.assertEqual(review.mass_blocked({"blocked": [{"reason": "mass delete: look-alike text", "handle": "x"}]}), [])

    def edited_then_deleted(self):
        (h,) = self.victims(1)
        self.tree.edit(h, lambda o: o["text"].__setitem__("string", "Edited here after the website deleted it."))
        self.website_deletes([h])
        fl = self.flow()
        rv = fl.review()
        row = self.conflict_row(rv, h)
        return h, fl, rv, row

    def test_a_website_delete_of_an_edited_record_offers_keep_mine_or_delete_here_and_the_second_needs_a_confirmation(self):  # AC1
        h, fl, rv, row = self.edited_then_deleted()
        self.assertEqual((row["kind"], row["type"]), ("delete_edit", decide.KIND_DELETE))
        self.assertEqual([x["id"] for x in row["choices"]], ["keep_mine", "take_website", "skip"])
        self.assertTrue(next(x for x in row["choices"] if x["id"] == "take_website")["needs_confirmation"])
        fl.apply(rv, {row["id"]: {"choice": "take_website"}})
        self.assertIn(h, self.tree.data, "not confirmed: nothing is deleted")

    def test_delete_vs_edit_keep_mine_creates_the_record_again_on_the_website(self):  # AC1
        h, fl, rv, row = self.edited_then_deleted()
        banner = fl.apply(rv, {row["id"]: {"choice": "keep_mine"}})
        self.assertIn(h, self.tree.data)
        self.assertFalse(self.cloud.heads[h]["deleted"], banner)
        self.assertEqual(self.cloud.heads[h]["obj"]["text"]["string"], "Edited here after the website deleted it.")
        self.assertEqual(self.rows("SELECT decision FROM conflicts WHERE id = ?", row["id"]), [("keep_mine",)])

    def test_delete_vs_edit_take_website_removes_the_record_here_once_confirmed(self):  # AC1, AC2
        h, fl, rv, row = self.edited_then_deleted()
        banner = fl.apply(rv, {row["id"]: {"choice": "take_website", "confirmed": True}})
        self.assertNotIn(h, self.tree.data)
        self.assertTrue(self.cloud.heads[h]["deleted"])
        self.assertIn("Applied from the website: 0 new, 0 changed, 1 deleted.", banner["lines"])
        self.assertEqual(len(self.tree.undo), 1)
        self.assertEqual(self.rows("SELECT decision FROM conflicts WHERE id = ?", row["id"]), [("take_website",)])
        self.assertEqual(fl.review().model["by_id"]["conflicts"]["count"], 0)

    def local_delete(self, n=1):
        gone = self.victims(n)
        for h in gone:
            del self.tree.data[h]
        return gone

    def test_an_outgoing_delete_waits_for_the_confirmation_and_lists_the_object(self):  # AC2
        (h,) = self.local_delete()
        fl = self.flow()
        rv = fl.review()
        (modal,) = [m for m in rv.model["confirmations"] if m["id"] == "outgoing"]
        self.assertEqual([o["handle"] for o in modal["objects"]], [h])
        (row,) = [r for r in self.sec_rows(rv, "to_website") if r["handle"] == h]
        self.assertEqual((row["kind"], row["badge"], row["confirm"]), ("delete", "needs confirmation", "delete_parked"))
        sent = len(self.cloud.batches)
        fl.apply(rv, {}, {"outgoing": False}, step_up=self.step_up)
        self.assertEqual(len(self.cloud.batches), sent, "not confirmed: nothing is sent")
        self.assertFalse(self.cloud.heads[h]["deleted"])
        self.assertEqual(self.stepped_up_calls, 0)

    def test_step_up_is_asked_just_before_the_deletes_and_those_batches_go_first(self):  # AC8, D07, SI-35
        (h,) = self.local_delete()
        other = self.a_person()
        self.tree.edit(other, lambda o: o["primary_name"].__setitem__("call", "Cally"))
        fl = self.flow()
        rv = fl.review()
        sent = len(self.cloud.batches)
        calls = []
        orig = self.cloud.post

        def spy(path, body=None, idempotency_key=None):
            if path == "/api/sync/batches":
                calls.append(("batch", [o["op"] for o in body["ops"]]))
            return orig(path, body, idempotency_key)

        self.cloud.post = spy

        def step_up():
            calls.append(("step_up",))
            return self.step_up()

        banner = fl.apply(rv, {}, {"outgoing": True}, step_up=step_up)
        self.assertTrue(self.cloud.heads[h]["deleted"], banner)
        self.assertEqual(calls[0], ("step_up",), "the sign-in comes before any batch")
        self.assertEqual([c for c in calls if c[0] == "batch"], [("batch", ["delete"]), ("batch", ["update"])], "deletes first, then the rest")
        self.assertEqual(len(self.cloud.batches) - sent, 2)
        self.assertEqual(self.stepped_up_calls, 1, "once, in the same run: no loop")
        self.assertEqual(self.cloud.heads[other]["obj"]["primary_name"]["call"], "Cally")
        self.assertIn("Pushed to the website: 0 new, 1 changed, 1 deleted.", banner["lines"])

    def test_a_delete_and_the_update_that_clears_its_reference_are_accepted_with_the_deletes_first(self):  # AC8, D07, SI-35 ordering risk
        """The delete batch reaches the website before the update that drops the last reference to the deleted record. The website checks
        references when the push session is completed (D25), not batch by batch, so the order is safe; this pins that, with the
        website's fixture checking the same way."""
        (note,) = self.victims(1)
        person = self.a_person()
        self.tree.edit(person, lambda o: o.__setitem__("note_list", [note]))
        fl = self.flow()
        first = fl.apply(fl.review(), {}, {})
        self.assertIn(note, self.cloud.heads[person]["obj"]["note_list"], first["lines"])
        del self.tree.data[note]
        self.tree.edit(person, lambda o: o.__setitem__("note_list", []))
        rv = fl.review()
        sent = len(self.cloud.batches)
        order = []
        orig = self.cloud.post

        def spy(path, body=None, idempotency_key=None):
            if path == "/api/sync/batches":
                order.append([o["op"] for o in body["ops"]])
            return orig(path, body, idempotency_key)

        self.cloud.post = spy
        banner = fl.apply(rv, {}, {"outgoing": True}, step_up=self.step_up)
        self.assertEqual(order, [["delete"], ["update"]], "the delete goes before the update that clears the reference")
        self.assertEqual(len(self.cloud.batches) - sent, 2)
        self.assertTrue(self.cloud.heads[note]["deleted"], banner)
        self.assertEqual(self.cloud.heads[person]["obj"]["note_list"], [])
        self.assertIsNone(self.cloud.open_session, "the session completed: the website found no dangling reference")

    def test_without_a_fresh_sign_in_the_deletes_stay_blocked_and_the_banner_says_what_to_do(self):  # D07
        (h,) = self.local_delete()
        fl = self.flow()
        rv = fl.review()
        banner = fl.apply(rv, {}, {"outgoing": True}, step_up=lambda: False)
        self.assertFalse(self.cloud.heads[h]["deleted"])
        self.assertEqual(banner["next_action"], "step_up")
        self.assertIn("Next: sign in again to send the deletes.", banner["lines"])

    def test_a_confirmed_mass_delete_goes_out_with_one_step_up(self):  # AC2
        gone = self.local_delete(12)
        fl = self.flow()
        rv = fl.review()
        (modal,) = [m for m in rv.model["confirmations"] if m["id"] == "outgoing"]
        self.assertEqual(sorted(o["handle"] for o in modal["objects"]), sorted(gone))
        fl.apply(rv, {}, {"outgoing": True}, step_up=self.step_up)
        self.assertTrue(all(self.cloud.heads[h]["deleted"] for h in gone))
        self.assertEqual(self.stepped_up_calls, 1)


class LinksAndText(unittest.TestCase):
    def test_a_gramps_id_is_escaped_in_the_person_link(self):
        self.assertEqual(review.person_url("https://x.test/", "Person", "I0001"), "https://x.test/person/?id=I0001")
        self.assertEqual(review.person_url("https://x.test", "Person", "I 1&x=2#f?"), "https://x.test/person/?id=I%201%26x%3D2%23f%3F")

    def test_only_a_web_address_makes_a_link(self):
        for bad in ("file:///etc/passwd", "javascript:alert(1)", "ftp://x.test", "x.test", "", None, "https://"):
            self.assertIsNone(review.person_url(bad, "Person", "I0001"), bad)
            self.assertIsNone(review.safe_web_url(bad), bad)
        self.assertEqual(review.safe_web_url("http://localhost:8089"), "http://localhost:8089")

    def test_the_backups_folder_uri_escapes_the_space_of_application_support(self):
        uri = review.folder_uri("/Users/someone/Library/Application Support/hfy_sync/abc/backups")
        self.assertEqual(uri, "file:///Users/someone/Library/Application%20Support/hfy_sync/abc/backups")
        self.assertNotIn(" ", uri)

    def test_the_decision_sentence_counts_the_conflicts_and_the_keep_mine_ones(self):
        self.assertIsNone(review.decision_summary({}))
        self.assertIsNone(review.decision_summary({"a": {"choice": "skip"}, "b": "skip"}))
        text = review.decision_summary({"a": {"choice": "keep_mine"}, "b": "take_website", "c": {"choice": "keep_mine", "confirmed": True}, "d": {"choice": "skip"}})
        self.assertIn("3 conflicts will be decided now", text)
        self.assertIn("2 keep the value in Gramps and replace the website's", text)
        self.assertIn("1 conflict will be decided now", review.decision_summary({"a": "take_website"}))


class ProjectionView(Base):
    full = True

    def test_yours_for_a_conflict_on_a_reference_to_a_media_the_bytes_call_a_pdf_reads_as_the_pull_found_it(self):  # HFY-TSK-207 and 208 together
        # The conflicts come from the pull's plan, which projects the tree as it is (the push re-reads a Media by its bytes' mime, the pull does
        # not), so the "yours" column must read from that projection: in the push's, the reference is gone and the value shows as "—".
        self.seed()
        template = self.tree.person_by_id("I0003")["media_list"][0]
        photo = copy.deepcopy(next(o for o in self.tree.objects().values() if o.get("_class") == "Media"))
        handle = "e%026d" % 1
        photo.update(handle=handle, gramps_id="O0100", path="new/photo.jpg", mime="image/jpeg", desc="A new synthetic photo", private=False)
        self.tree.data[handle] = photo
        owner = self.tree.person_by_id("I0002")
        owner["media_list"] = owner["media_list"] + [dict(copy.deepcopy(template), ref=handle, rect=[1, 2, 3, 4], private=False)]
        local = self.tree.objects()
        info = {handle: {"state": "ok", "content_type": "application/pdf", "readable": True, "exif_gps": False, "md5": "0" * 32}}
        projected, holds = (lambda p: (p.projected, p.holds))(PR.project(list(local.values()), files=info))     # what plan._build_once makes
        pull_like = plan_mod.symmetric(projected, holds)
        refs = lambda lp: [r["ref"] for r in lp[owner["handle"]]["media_list"]]
        self.assertIn(handle, refs(pull_like), "the pull's projection keeps the reference")
        ctx = review.Context(local, {}, None, files=info)
        self.assertEqual(ctx.projected()[owner["handle"]], pull_like[owner["handle"]], "the window reads the pull's projection")
        conflict = {"handle": owner["handle"], "path": "/media_list/%s#0/rect" % handle}
        self.assertEqual(review.yours_live(ctx, conflict), ([1, 2, 3, 4], False))
        self.assertEqual(review.yours_live(review.Context(local, {}, None, files={}), conflict), ([1, 2, 3, 4], False))


class ServesBytes(PS.PullView):
    """The website serves `data` as the file of every Media the pull asks about."""

    URL = "https://files.example.org/held-photo"

    def __init__(self, cloud, data, content_type="image/jpeg"):
        PS.PullView.__init__(self, cloud)
        self.data, self.content_type = data, content_type

    def media_download(self, handle):
        return {"url": self.URL, "sha256": hashlib.sha256(self.data).hexdigest(), "md5": hashlib.md5(self.data).hexdigest(), "size": len(self.data),
                "content_type": self.content_type}

    def fetch(self, url):
        return self.data if url == self.URL else PS.PullView.fetch(self, url)


class HeldMediaRows(unittest.TestCase):
    """`run_holds`: which rows of the sidecar's holds table the Held back section lists (the table is as the last run left it)."""

    def ctx(self, local, holds):
        return review.Context(local, {}, None, holds=holds)

    def row(self, handle, rule, path="/blob", detail="", cls="Media"):
        return {"class": cls, "handle": handle, "path": path, "rule": rule, "detail": detail, "first_seen": "2026-01-01T00:00:00Z"}

    def test_a_download_hold_is_listed_for_a_media_without_a_file_in_the_words_the_run_recorded(self):
        local = {"m1": {"_class": "Media", "handle": "m1", "gramps_id": "O1", "path": ""}}
        rows = review.run_holds(self.ctx(local, [self.row("m1", "media.exif_gps.hold", detail="Words the pull recorded.")]), set())
        self.assertEqual([(r["gramps_id"], r["class"], r["rule"], r["note"], r["badge"]) for r in rows],
                         [("O1", "Media", "media.exif_gps.hold", "Words the pull recorded.", "held")])

    def test_a_download_hold_is_not_listed_once_the_media_has_a_file_of_its_own(self):
        local = {"m1": {"_class": "Media", "handle": "m1", "gramps_id": "O1", "path": "photos/o1.jpg"}}
        self.assertEqual(review.run_holds(self.ctx(local, [self.row("m1", "media.exif_gps.hold"), self.row("m1", "media_blob_empty")]), set()), [])

    def test_no_row_is_listed_for_an_object_that_is_gone_a_rule_the_dry_runs_find_themselves_or_one_the_previews_list(self):
        local = {"m1": {"_class": "Media", "handle": "m1", "gramps_id": "O1", "path": ""}}
        holds = [self.row("gone", "media.exif_gps.hold"), self.row("m1", "media_blob_missing"), self.row("m1", "delete_parked", path=""),
                 self.row("m1", "expunge.notice", path="/desc"), self.row("m1", "media_blob_empty")]
        self.assertEqual(review.run_holds(self.ctx(local, holds), {("m1", "/blob", "media_blob_empty")}), [])

    def test_a_failed_upload_is_listed_even_when_the_media_has_a_file_and_falls_back_to_the_rules_plain_words(self):
        local = {"m1": {"_class": "Media", "handle": "m1", "gramps_id": "O1", "path": "photos/o1.jpg"},
                 "p1": {"_class": "Person", "handle": "p1", "gramps_id": "I1"}}
        holds = [self.row("m1", "media_upload_failed"), self.row("p1", "media_dependency_deferred", path="", cls="Person")]
        rows = review.run_holds(self.ctx(local, holds), set())
        self.assertEqual([(r["gramps_id"], r["rule"], r["note"]) for r in rows],
                         [("O1", "media_upload_failed", consts.HOLD_MESSAGES["media_upload_failed"]),
                          ("I1", "media_dependency_deferred", consts.HOLD_MESSAGES["media_dependency_deferred"])])


class HeldMediaHelpers(object):
    full = True

    def website_photo(self, data):
        template = copy.deepcopy(next(o for o in self.tree.objects().values() if o["_class"] == "Media"))
        handle = "c" * 28
        template.update(handle=handle, gramps_id="O8001", path="", desc="A photo from the website", checksum=hashlib.md5(data).hexdigest(),
                        mime="image/jpeg", private=False)
        self.cloud.seq += 1
        self.cloud.heads[handle] = {"class": "Media", "version": 1, "seq": self.cloud.seq, "deleted": False, "gramps_id": "O8001", "obj": template}
        return handle

    def flow_serving(self, data):
        return review.Flow(self.tree, environ=self.env, services={"cloud": ServesBytes(self.cloud, data), "client": self.cloud})

    def held(self, rv, handle):
        return [r for r in self.sec_rows(rv, "held") if r["handle"] == handle]

    def hold_table(self, handle):
        return self.rows("SELECT rule, path FROM holds WHERE handle = ?", handle)


class HeldMedia(HeldMediaHelpers, Base):
    """A media file held on download shows under Held back in the window, and stays there: the dry runs cannot find it."""

    def downloaded_and_held(self, extra_push=False):
        self.seed()
        person = self.a_person()
        if extra_push:
            self.tree.edit(person, lambda o: o["primary_name"].__setitem__("call", "Cally"))
        handle = self.website_photo(GPS_PHOTO())
        flow = self.flow_serving(GPS_PHOTO())
        rv = flow.review()
        self.assertEqual(self.held(rv, handle), [], "the dry check does not download, so it cannot know")
        self.assertIn(handle, [r["handle"] for r in self.sec_rows(rv, "from_website")])
        return flow, rv, handle, person

    def test_a_photo_the_download_held_is_listed_under_held_back_in_the_words_of_its_rule(self):  # HFY-TSK-207 and 208 together
        flow, rv, handle, _person = self.downloaded_and_held()
        banner = flow.apply(rv)
        self.assertEqual(banner["next_action"], "review_preview")
        self.assertTrue(any("held back" in x for x in banner["lines"]), banner["lines"])
        rows = self.held(flow.review(), handle)
        self.assertEqual([(r["class"], r["gramps_id"], r["rule"], r["badge"]) for r in rows], [("Media", "O8001", "media.exif_gps.hold", "held")])
        self.assertEqual(rows[0]["note"], PR.hold_reason("media.exif_gps.hold"))
        self.assertNotIn("media.exif_gps.hold", rows[0]["note"], "a rule id never reaches the window as its text")
        self.assertEqual([f for _d, _s, files in os.walk(self.tmp) for f in files if handle in f], [], "the held file is never written to disk")

    def test_an_empty_file_the_download_held_is_listed_in_the_plain_words_of_its_rule(self):
        self.seed()
        handle = self.website_photo(b"")
        flow = self.flow_serving(b"")
        flow.apply(flow.review())
        (row,) = self.held(flow.review(), handle)
        self.assertEqual((row["rule"], row["note"]), ("media_blob_empty", consts.HOLD_MESSAGES["media_blob_empty"]))

    def test_it_stays_listed_when_a_push_follows_the_download_in_the_same_apply_and_through_the_next_apply(self):
        flow, rv, handle, person = self.downloaded_and_held(extra_push=True)
        banner = flow.apply(rv)
        self.assertTrue(any(x.startswith("Pushed to the website") and "0 changed" not in x for x in banner["lines"]), banner["lines"])
        self.assertEqual(self.hold_table(handle), [("media.exif_gps.hold", "/blob")], "the push's replacement of the table kept it")
        self.assertEqual([r["rule"] for r in self.held(flow.review(), handle)], ["media.exif_gps.hold"])
        self.tree.edit(person, lambda o: o["primary_name"].__setitem__("call", "Cally Two"))
        flow.apply(flow.review())
        self.assertEqual(self.hold_table(handle), [("media.exif_gps.hold", "/blob")], "and so did the next pull's")
        self.assertEqual([r["rule"] for r in self.held(flow.review(), handle)], ["media.exif_gps.hold"])

    def test_it_goes_from_the_window_and_the_table_when_the_media_gets_a_file(self):
        flow, rv, handle, _person = self.downloaded_and_held()
        flow.apply(rv)
        self.assertEqual(len(self.held(flow.review(), handle)), 1)
        self.tree.data[handle]["path"] = "photos/clean.jpg"      # the person attached a file of their own
        self.assertEqual(self.held(flow.review(), handle), [], "not listed any more, before any run")
        flow.apply(flow.review())
        self.assertEqual(self.hold_table(handle), [], "and the next run drops the row")


class HeldUploads(HeldMediaHelpers, Base):
    """A file the upload could not send shows under Held back too, with its reason: over real files, a Media op the website refuses."""

    tree_class = PS.MediaPushTree

    def setUp(self):
        Base.setUp(self)
        self.base = os.path.join(self.tmp, "media-base")
        shutil.copytree(MU.FIXTURE_MEDIA, os.path.join(self.base, "media"))
        self.tree.media_base = self.base

    def new_photo(self):
        data = MU.jpeg("fail")
        os.makedirs(os.path.join(self.base, "new"))
        with open(os.path.join(self.base, "new", "photo1.jpg"), "wb") as fh:
            fh.write(data)
        template = copy.deepcopy(self.tree.by_id("Media", "O0001"))
        handle = "e%026d" % 1
        template.update(handle=handle, gramps_id="O0100", path="new/photo1.jpg", mime="image/jpeg", desc="A new synthetic photo",
                        checksum=hashlib.md5(data).hexdigest(), private=False)
        self.tree.data[handle] = template
        return handle

    def test_a_media_file_the_upload_could_not_send_is_listed_with_its_reason_until_it_goes(self):  # HFY-TSK-207 and 208 together
        self.seed()
        handle = self.new_photo()
        flow = self.flow()
        self.cloud.refuse_put = 4          # S3 refuses the file, then the retry: the upload fails
        banner = flow.apply(flow.review())
        self.assertTrue(banner["ok"], banner)
        rv = flow.review()
        (row,) = [r for r in self.held(rv, handle) if r["rule"] == "media_upload_failed"]
        self.assertEqual((row["class"], row["gramps_id"], row["note"]), ("Media", "O0100", consts.HOLD_MESSAGES["media_upload_failed"]))
        self.assertIn(handle, [r["handle"] for r in self.sec_rows(rv, "to_website")], "it is still waiting to be sent")
        self.cloud.refuse_put = 0
        flow.apply(rv)
        self.assertEqual([r for r in self.held(flow.review(), handle) if r["rule"] == "media_upload_failed"], [])
        self.assertIn(handle, self.cloud.blobs, "the retry sent the file")


class Banner(Base):
    def test_the_banner_has_the_counts_the_backup_path_and_the_undo_warning(self):  # AC2
        self.seed()
        h = self.a_person()
        self.cloud.edit(h, lambda o: o["primary_name"].__setitem__("nick", "Nicky"))
        fl = self.flow()
        banner = fl.apply(fl.review())
        self.assertEqual(banner["title"], "Sync finished")
        self.assertIn("Applied from the website: 0 new, 1 changed, 0 deleted.", banner["lines"])
        self.assertTrue(banner["backup"] and os.path.exists(banner["backup"]))
        self.assertIn(os.path.join("hfy_sync", self.tree.dbid, "backups"), banner["backup"])
        self.assertIn("Undo is available until you close the tree", banner["warning"])
        self.assertIn("undoing will revert these changes on the website at the next sync", banner["warning"])

    def test_a_partial_state_names_the_next_action(self):
        self.seed()
        h = self.a_person()
        self.tree.edit(h, lambda o: o["primary_name"].__setitem__("first_name", "Mine"))
        self.cloud.edit(h, lambda o: o["primary_name"].__setitem__("first_name", "Theirs"))
        fl = self.flow()
        banner = fl.apply(fl.review())
        self.assertEqual(banner["next_action"], "resolve_conflicts")
        self.assertIn("Conflicts still open: 1. Both sides were left as they are.", banner["lines"])
        self.assertTrue(any(line.startswith("Next: decide the open conflicts") for line in banner["lines"]))


class EditWindows(Base):
    def test_the_apply_is_refused_while_an_edit_window_is_open(self):  # AC5
        self.seed()
        h = self.a_person()
        self.cloud.edit(h, lambda o: o["primary_name"].__setitem__("nick", "Nicky"))
        fl = self.flow()
        rv = fl.review()
        self.tree.editors = True
        self.tree.editors_open = lambda: True
        before = copy.deepcopy(self.tree.data)
        mark = len(self.cloud.requests)
        banner = fl.apply(rv)
        self.assertFalse(banner["ok"])
        self.assertEqual(banner["lines"][0], "D45: A Gramps edit window is open: close open edit windows to sync, then apply again.")
        self.assertIn("close open edit windows to sync", banner["lines"][0])
        self.assertEqual(self.tree.data, before)
        self.assertEqual(len(self.cloud.requests), mark, "no request was made")
        self.assertEqual(fl.editors_refusal()["error"]["code"], "D45")
        self.tree.editors_open = lambda: False
        self.assertTrue(fl.apply(fl.review())["ok"])

    def test_the_pull_checks_again_inside_its_own_run(self):  # AC5: a window opened after the dialog's check
        self.seed()
        h = self.a_person()
        self.cloud.edit(h, lambda o: o["primary_name"].__setitem__("nick", "Nicky"))
        self.tree.editors_open = lambda: True
        doc = self.pull("pull", mode="gui")
        self.assertEqual((doc["result"], doc["error"]["code"]), ("refused", "D45"))
        self.assertEqual(self.tree.applies, 0)


class StickyEvents(Base):
    """A birth retyped to Residence on this computer: its day and month stay here (PS-02), the window flags it, and a release is explicit."""

    full = True

    def setUp(self):
        Base.setUp(self)
        person = self.tree.person_by_id("I0003")
        self.birth = self.tree.data[person["event_ref_list"][person["birth_ref_index"]]["ref"]]
        self.h = self.birth["handle"]
        self.dv = list(self.birth["date"]["dateval"])
        self.seed()
        person = self.tree.person_by_id("I0003")
        self.tree.edit(self.h, lambda o: o["type"].update({"value": 42, "string": ""}))   # Birth retyped to Residence in Gramps
        self.tree.edit(person["handle"], lambda o: o.update(birth_ref_index=-1))           # and the person no longer points at it as the birth

    def test_the_day_and_month_stay_local_and_the_event_is_listed_as_held_back_with_a_release(self):  # AC7
        mark = len(self.cloud.requests)
        fl = self.flow()
        rv = fl.review()
        held = [r for r in self.sec_rows(rv, "held") if r["handle"] == self.h]
        self.assertEqual(len(held), 1)
        self.assertEqual(held[0]["rule"], "birthlike_sticky")
        self.assertIn("release", held[0])
        self.assertIn("day and month stay on this computer", held[0]["note"])
        fl.apply(rv)
        text = "\n".join(b for _m, _p, b in self.cloud.requests[mark:] if b)
        self.assertNotIn('"dateval": [%d, %d, %d' % tuple(self.dv[:3]), text)
        self.assertEqual(self.cloud.heads[self.h]["obj"]["date"]["dateval"][:2], [0, 0])
        self.assertEqual(self.cloud.heads[self.h]["obj"]["type"]["value"], 42, "the retype itself goes out")

    def test_a_push_that_would_publish_a_day_and_month_is_flagged_and_not_sent_until_released(self):  # AC7
        from hfygramps import projection as PR

        original = PR.project

        def leaky(objects, *a, **kw):
            """A projection that forgot the sticky rule: the guard in front of the wire must still hold the event back."""
            run = original(objects, *a, **kw)
            raw = {o["handle"]: o for o in objects}
            if self.h in run.projected and self.h in raw:
                run.projected[self.h]["date"] = copy.deepcopy(raw[self.h]["date"])
            return run

        fl = self.flow()
        PR.project = leaky
        try:
            rv = fl.review()
            blocked = [b for b in rv.push_pv["blocked"] if b["handle"] == self.h]
            self.assertEqual([b["rule"] for b in blocked], ["sticky_daymonth"])
            flagged = [r for r in self.sec_rows(rv, "held") if r["handle"] == self.h and r["badge"] == "flagged"]
            self.assertEqual(len(flagged), 1)
            self.assertIn("Release", flagged[0]["release"]["label"])
            mark = len(self.cloud.requests)
            fl.apply(rv)
            text = "\n".join(b for _m, _p, b in self.cloud.requests[mark:] if b)
            self.assertNotIn('"dateval": [%d, %d, %d' % tuple(self.dv[:3]), text, "not sent")
        finally:
            PR.project = original

    def test_after_the_person_releases_the_event_the_day_and_month_are_published(self):  # AC7
        fl = self.flow()
        fl.release(self.h)
        con = self.sidecar()
        try:
            self.assertEqual(sidecar.meta_json(con, "released", []), [self.h])
            self.assertNotIn(self.h, sidecar.meta_json(con, "birthlike_sticky", []))
        finally:
            con.close()
        rv = fl.review()
        self.assertFalse([r for r in self.sec_rows(rv, "held") if r["handle"] == self.h and r.get("release")])
        fl.apply(rv)
        self.assertEqual(self.cloud.heads[self.h]["obj"]["date"]["dateval"][:3], self.dv[:3], "released: the push publishes the date")

    def test_a_release_waits_for_a_running_sync_instead_of_writing_beside_it(self):
        from hfygramps.addon import preflight
        fl = self.flow()
        with preflight.StateLock(fl.tp.lock) as lock:
            self.assertTrue(lock.acquired)
            self.assertFalse(fl.release(self.h), "a run holds the lock: nothing is written")
        con = self.sidecar()
        try:
            self.assertNotIn(self.h, sidecar.meta_json(con, "released", []))
        finally:
            con.close()
        self.assertTrue(fl.release(self.h))

    def test_the_guard_looks_only_at_unreleased_sticky_events(self):
        op = {"class": "Event", "handle": "e1", "op": "update", "obj": {"date": {"_class": "Date", "dateval": [14, 2, 1840, False], "text": ""}}}
        self.assertEqual(pushplan._sticky_guard(op, {"e1"}, set(), None), "/date/dateval/0")
        self.assertIsNone(pushplan._sticky_guard(op, {"e1"}, {"e1"}, None))
        self.assertIsNone(pushplan._sticky_guard(op, set(), set(), None))
        year_only = dict(op, obj={"date": {"_class": "Date", "dateval": [0, 0, 1840, False], "text": ""}})
        self.assertIsNone(pushplan._sticky_guard(year_only, {"e1"}, set(), None))
        self.assertIsNone(pushplan._sticky_guard(dict(op, **{"class": "Person"}), {"e1"}, set(), None))


class PreviewsAndTheCommandLine(Base):
    full = True

    def test_preview_files_hold_projected_values_and_pointers_only(self):  # AC9
        self.seed()
        person = self.tree.person_by_id("I0003")
        birth = self.tree.data[person["event_ref_list"][person["birth_ref_index"]]["ref"]]
        dv = list(birth["date"]["dateval"])
        self.cloud.edit(birth["handle"], lambda o: o["date"]["dateval"].__setitem__(2, dv[2] + 1))
        a = self.a_person()
        self.tree.edit(a, lambda o: o["primary_name"].__setitem__("first_name", "Mine"))
        fl = self.flow()
        rv = fl.review()
        self.assertEqual(self.conflict_row(rv, birth["handle"])["diffs"][0]["yours"], review.date_text(birth["date"]))
        files = self.preview_files_text()
        self.assertNotIn('"dateval": [%d, %d, %d' % tuple(dv[:3]), files)
        for needle in birth_needles(self.tree.data):
            self.assertNotIn(needle, files)
        pv = rv.pull_pv
        c = next(c for c in pv["conflicts"] if c["handle"] == birth["handle"])
        self.assertEqual(c["desktop"]["dateval"][:2], [0, 0], "the preview's desktop column is the projection: no day, no month")
        self.assertEqual(c["website"]["dateval"][2], dv[2] + 1)

    def test_the_command_line_summary_never_prints_a_value(self):  # AC9
        from hfygramps.addon import status

        self.seed()
        a = self.a_person()
        self.tree.edit(a, lambda o: o["primary_name"].__setitem__("first_name", "Zebediah"))
        self.cloud.edit(a, lambda o: o["primary_name"].__setitem__("first_name", "Yolanda"))
        doc = self.pull("check")
        for text in (status.summary_line(doc), json.dumps(doc, sort_keys=True), self.preview_files_text().replace('"desktop": "Zebediah"', "")):
            self.assertNotIn("Zebediah", text.replace('"website": "Yolanda"', ""))
        self.assertNotIn("Yolanda", status.summary_line(doc))
        self.assertNotIn("Zebediah", status.summary_line(doc))
        self.assertNotIn("Yolanda", json.dumps(doc))
        self.assertNotIn("Zebediah", json.dumps(doc))


class TheText(unittest.TestCase):
    def test_dates_paths_and_relative_times(self):
        self.assertEqual(review.date_text({"dateval": [14, 2, 1840, False]}), "14 Feb 1840")
        self.assertEqual(review.date_text({"dateval": [0, 0, 1840, False]}), "1840")
        self.assertEqual(review.date_text({"dateval": [0, 3, 1840, False]}), "Mar 1840")
        self.assertEqual(review.pretty_path("/event_ref_list/abc#0/role"), "event ref list › item › role")
        self.assertEqual(review.pretty_path(""), "the whole record")
        import calendar
        then = calendar.timegm((2026, 10, 15, 0, 0, 0))
        self.assertEqual(review.relative_time("2026-10-15T00:00:00Z", now=then + 300), "5 minutes ago")
        self.assertEqual(review.relative_time("2026-10-15T00:00:00Z", now=then + 20), "just now")
        self.assertEqual(review.relative_time("2026-10-15T00:00:00Z", now=then + 3 * 86400), "3 days ago")
        self.assertEqual(review.relative_time(""), "")
        self.assertEqual(review.short(None), "—")
        self.assertEqual(len(review.short("x" * 500)), 80)

    def test_the_ids_read_the_catalog(self):
        self.assertIn("close open edit windows to sync", consts.REFUSALS["D45"][2])


if __name__ == "__main__":
    unittest.main(verbosity=2)
