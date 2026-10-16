"""What keeps a pull from hurting the tree (HFY-TSK-205): fault injection, the stale check and the symmetry abort, conflicts that stay open,
composite and delete conflicts, the inbound privacy scan, reverts, restore, expunge notices, the reviewed-plan hash and the guards.

Fake tree, fake cloud, the synthetic fixture. The same boundaries run against real processes in gramps/tests/e2e/scenario_pull.py.
"""
import copy
import json
import os
import unittest
from unittest import mock

import addon_pull_support as S
from hfygramps.addon import backup, consts, faults, plan as plan_mod, sidecar, transport

from test_addon_pull import by_gid, load_cloud_objs, set_text


def fault(step, crash=False):
    return {"faults": faults.Faults({"HFY_SYNC_TEST": "1", "HFY_SYNC_FAULT": ("crash:" if crash else "") + step})}


def website_edits(env):
    """Three website changes: an edit, a create and an edit of another note."""
    objs = load_cloud_objs(env)
    a = copy.deepcopy(by_gid(objs, "N0004"))
    set_text(a, "Edited on the website.")
    env.cloud.put(a)
    new = copy.deepcopy(a)
    new.update(handle="a" * 28, gramps_id="N8001")
    set_text(new, "Created on the website.")
    env.cloud.put(new)
    b = copy.deepcopy(by_gid(objs, "N0001"))
    b["private"] = False
    b["format"] = 1
    env.cloud.put(b)
    return {"N0004": a["handle"], "N8001": new["handle"], "N0001": b["handle"]}


class FaultInjection(S.PullCase):
    """Each boundary of a pull: the next clean run converges, with nothing lost and nothing applied twice."""

    def expected(self):
        twin = S.Env(self)
        twin.settle()
        website_edits(twin)
        self.assertEqual(twin.run("pull", yes=True)["result"], "ok")
        return twin.tree.objects(), twin

    def test_each_boundary_converges_on_the_next_run(self):
        want, twin = self.expected()
        for step in ("after_snapshot", "after_backup", "mid_apply", "after_commit", "after_sidecar"):
            with self.subTest(step=step):
                e = S.Env(self)
                e.settle()
                website_edits(e)
                before = e.tree.objects()
                doc = e.run("pull", yes=True, services=fault(step))
                self.assertEqual((doc["result"], doc["exit_code"]), ("failed", 70), step)
                if step in ("after_snapshot", "after_backup", "mid_apply"):
                    self.assertEqual(e.tree.objects(), before, "%s: nothing may be applied" % step)
                    self.assertEqual(e.tree.applies, 0)
                else:
                    self.assertEqual(e.tree.objects(), want, "%s: the transaction had committed" % step)
                if step == "after_commit":
                    con = e.side()
                    try:  # the sidecar still says "not yet": the next run finds the objects already equal
                        self.assertEqual(sidecar.meta(con).get("pull_n"), "0")  # the crashed run did not count itself
                        pending = {r[0] for r in con.execute("SELECT run_n FROM pulled")}
                        self.assertEqual(pending, {1}, "but its pre-pull values were written before the commit")
                    finally:
                        con.close()
                again = e.run("pull", yes=True)
                self.assertEqual((again["result"], again["exit_code"]), ("ok", 0), step)
                self.assertEqual(e.tree.objects(), want, step)
                if step in ("after_commit", "after_sidecar"):
                    self.assertEqual(e.tree.applies, 1, "%s: a change must not be applied twice" % step)
                self.assertEqual(e.base_dump(), twin.base_dump(), "%s: the base follows the website" % step)
                self.assertEqual(e.run("check")["exit_code"], 0, step)
                self.assertEqual(e.run("pull", yes=True)["counts"]["pulled"], {"create": 0, "update": 0, "delete": 0})

    def test_a_crash_has_the_same_effect_as_a_fault_but_leaves_no_status(self):
        e = S.Env(self)
        e.settle()
        website_edits(e)
        exits = []
        svc = fault("mid_apply", crash=True)
        svc["faults"]._exit = lambda code: (_ for _ in ()).throw(SystemExit(code))
        with self.assertRaises(SystemExit):
            e.run("pull", yes=True, services=svc)
        self.assertEqual(e.tree.applies, 0)
        self.assertEqual(e.run("pull", yes=True)["result"], "ok")

    def test_the_seam_is_dead_without_the_test_flag(self):
        f = faults.Faults({"HFY_SYNC_FAULT": "mid_apply"})
        f.hit("mid_apply")  # no exception
        self.assertEqual(f.step, "")

    def test_the_prune_after_a_fault_does_not_run_and_the_backup_stays(self):
        e = S.Env(self)
        e.settle()
        website_edits(e)
        e.run("pull", yes=True, services=fault("after_commit"))
        self.assertEqual(len([f for f in os.listdir(e.tp.backups) if f.endswith(".sqlite") and ".sidecar" not in f]), 1)


class StaleAndSymmetry(S.PullCase):
    def test_an_edit_between_the_preview_and_the_apply_triggers_a_replan(self):
        e = self.env
        website_edits(e)
        victim = by_gid(e.tree.objects(), "N0004")["handle"]
        calls = []

        def edit():
            calls.append(1)
            e.tree.edit(victim, lambda o: set_text(o, "Edited on the desktop while the preview was open."))

        doc = e.run("pull", yes=True, services={"between_preview_and_apply": edit})
        self.assertEqual(len(calls), 1)
        # the new plan sees both sides edit the same note: a conflict, parked, and the rest still applies
        self.assertEqual((doc["result"], doc["exit_code"]), ("partial", 20))
        self.assertEqual(by_gid(e.tree.objects(), "N0004")["text"]["string"], "Edited on the desktop while the preview was open.")
        self.assertIn("a" * 28, e.tree.objects())
        with open(os.path.join(e.tp.logs, "%s.log" % doc["run_id"]), encoding="utf-8") as fh:
            self.assertIn("stale: replan 1", fh.read())

    def test_with_a_reviewed_plan_or_in_the_gui_a_replan_stops_for_a_new_preview(self):
        for kw in ({"mode": "gui"}, {"mode": "cli", "plan": "T%025d" % 99}):
            with self.subTest(kw=kw):
                e = S.Env(self)
                e.settle()
                website_edits(e)
                if "plan" in kw:
                    review = e.run("check")
                    kw = dict(kw, plan=review["run_id"])
                victim = by_gid(e.tree.objects(), "N0004")["handle"]
                before = None

                def edit():
                    e.tree.edit(victim, lambda o: set_text(o, "Edited while the preview was open."))

                doc = e.run("pull", yes=True, services={"between_preview_and_apply": edit}, **kw)
                self.assertEqual((doc["result"], doc["exit_code"], doc["error"]["code"]), ("changes_pending", 10, "plan_changed"))
                self.assertEqual(e.tree.applies, 0)

    def test_a_symmetry_violation_inside_the_transaction_aborts_it_and_leaves_the_database_unchanged(self):
        e = self.env
        website_edits(e)

        class Corrupting(type(e.tree)):
            def apply(self, label, commits, removals, **kw):
                person = by_gid(self.objects(), "I0001")
                person["family_list"] = []  # the family still names this person as a parent
                commits = dict(commits)
                commits[person["handle"]] = person
                return super().apply(label, commits, removals, **kw)

        e.tree.__class__ = Corrupting
        before = e.tree.objects()
        base_before = e.base_dump()
        doc = e.run("pull", yes=True)
        self.assertEqual((doc["result"], doc["exit_code"], doc["error"]["code"]), ("refused", 65, "integrity"))
        self.assertEqual(e.tree.objects(), before)
        self.assertEqual(e.tree.undo, [])
        self.assertEqual(e.base_dump(), base_before)
        self.assertEqual(e.cloud.heads["a" * 28]["version"], 1)

    def test_a_cloud_change_that_would_break_symmetry_is_frozen_before_it_gets_that_far(self):
        e = self.env
        objs = load_cloud_objs(e)
        fam = copy.deepcopy(by_gid(objs, "F0001"))
        fam["father_handle"] = by_gid(objs, "I0002")["handle"]  # I0002 does not list this family
        e.cloud.put(fam)
        doc = e.run("pull", yes=True)
        self.assertEqual((doc["result"], doc["exit_code"]), ("partial", 20))
        pv = e.preview(doc)
        self.assertEqual(len(pv["conflicts"]), 1)
        self.assertEqual(pv["conflicts"][0]["kind"], "integrity")
        self.assertEqual(e.tree.applies, 0)


class OpenConflicts(S.PullCase):
    def conflict(self, env):
        """The website and the desktop both rewrite one note."""
        objs = load_cloud_objs(env)
        site = copy.deepcopy(by_gid(objs, "N0004"))
        set_text(site, "The website's version.")
        env.cloud.put(site)
        handle = site["handle"]
        env.tree.edit(handle, lambda o: set_text(o, "The desktop's version."))
        return handle

    def other_change(self, env):
        objs = load_cloud_objs(env)
        other = copy.deepcopy(by_gid(objs, "N0001"))
        other["format"] = 1 - other.get("format", 0)
        env.cloud.put(other)
        return other["handle"]

    def run_three_more(self, env, handle, mode):
        local = json.dumps(env.tree.objects()[handle], sort_keys=True)
        cloud = json.dumps(env.cloud.heads[handle], sort_keys=True)
        for i in range(3):
            doc = env.run("pull", yes=True, mode=mode)
            self.assertEqual((doc["result"], doc["exit_code"]), ("partial", 20), "run %d" % i)
            self.assertEqual(doc["counts"]["conflicts_open"], 1)
            self.assertEqual(json.dumps(env.tree.objects()[handle], sort_keys=True), local, "the desktop side changed")
            self.assertEqual(json.dumps(env.cloud.heads[handle], sort_keys=True), cloud, "the website side changed")
            self.assertEqual(doc["counts"]["push_pending"], 0, "the pinned path must not be pushed")
        con = env.side()
        try:
            return con.execute("SELECT state, path, kind FROM conflicts").fetchall()
        finally:
            con.close()

    def test_a_parked_cli_conflict_stays_open_across_three_more_runs_with_both_sides_unchanged(self):
        e = self.env
        h = self.conflict(e)
        other = self.other_change(e)
        first = e.run("pull", yes=True)
        self.assertEqual((first["result"], first["exit_code"], first["next_action"]), ("partial", 20, "resolve_conflicts"))
        self.assertEqual(e.tree.objects()[other]["format"], e.cloud.heads[other]["obj"]["format"], "everything else proceeds")
        self.assertEqual(e.tree.objects()[h]["text"]["string"], "The desktop's version.")
        rows = self.run_three_more(e, h, "cli")
        self.assertEqual(rows, [("parked", "/text", "field")])

    def test_a_skipped_gui_conflict_stays_open_across_three_more_runs_with_both_sides_unchanged(self):
        e = self.env
        h = self.conflict(e)
        first = e.run("pull", yes=True, mode="gui")
        self.assertEqual((first["result"], first["exit_code"]), ("partial", 20))
        rows = self.run_three_more(e, h, "gui")
        self.assertEqual(rows, [("open", "/text", "field")])

    def test_a_conflict_resolves_itself_only_when_the_two_sides_agree(self):
        e = self.env
        h = self.conflict(e)
        e.run("pull", yes=True)
        e.tree.edit(h, lambda o: set_text(o, "The website's version."))  # io makes the desktop match
        doc = e.run("pull", yes=True)
        self.assertEqual((doc["result"], doc["exit_code"]), ("ok", 0))
        con = e.side()
        try:
            self.assertEqual(con.execute("SELECT state FROM conflicts").fetchall(), [("resolved",)])
        finally:
            con.close()


class CompositeAndTombstones(S.PullCase):
    def test_a_cloud_birth_year_change_with_a_local_day_and_month_is_never_applied_automatically(self):
        e = self.env
        objs = load_cloud_objs(e)
        birth = copy.deepcopy(by_gid(objs, "E0001"))
        self.assertEqual(birth["date"]["dateval"][2], 1840)
        birth["date"]["dateval"][2] = 1841
        e.cloud.put(birth)
        local_before = json.dumps(e.tree.objects()[birth["handle"]], sort_keys=True)
        doc = e.run("pull", yes=True, allow_deletes=True)
        self.assertEqual((doc["result"], doc["exit_code"]), ("partial", 20))
        pv = e.preview(doc)
        self.assertEqual([(c["kind"], c["path"]) for c in pv["conflicts"]], [("composite", "/date")])
        self.assertEqual(json.dumps(e.tree.objects()[birth["handle"]], sort_keys=True), local_before)
        self.assertEqual(e.tree.applies, 0)
        # the GUI lists the same conflict and applies nothing either
        gui = e.run("pull", yes=True, mode="gui")
        self.assertEqual(e.preview(gui)["conflicts"][0]["disposition"], "open")
        self.assertEqual(e.tree.applies, 0)

    def test_an_incoming_tombstone_on_a_birth_event_with_a_local_day_and_month_is_a_delete_edit_conflict(self):
        e = self.env
        birth = by_gid(e.tree.objects(), "E0001")
        e.cloud.tombstone(birth["handle"])
        for allow in (False, True):
            doc = e.run("pull", yes=True, allow_deletes=allow)
            self.assertEqual((doc["result"], doc["exit_code"]), ("partial", 20), allow)
            pv = e.preview(doc)
            self.assertEqual([(c["kind"], c["reason"]) for c in pv["conflicts"]], [("delete_edit", "has desktop-only data")])
            self.assertIn(birth["handle"], e.tree.objects())
            self.assertEqual(e.tree.objects()[birth["handle"]]["date"]["dateval"][:3], [14, 2, 1840])
        self.assertEqual(e.tree.applies, 0)


class InboundPrivacy(S.PullCase):
    def local_birth_note(self):
        base = copy.deepcopy(by_gid(load_cloud_objs(self.env), "N0004"))
        base.update(handle="b" * 28, gramps_id="N8002")
        set_text(base, "She was born on 14 February 1840 in the old house.")
        return base

    def test_a_pulled_note_with_a_local_date_of_birth_is_skipped_counted_and_offered_an_expunge(self):
        e = self.env
        note = self.local_birth_note()
        e.cloud.put(note)
        doc = e.run("pull", yes=True)
        self.assertEqual((doc["result"], doc["exit_code"], doc["next_action"]), ("partial", 20, "review_incidents"))
        self.assertEqual(doc["counts"]["privacy_incidents"], 1)
        self.assertNotIn(note["handle"], e.tree.objects())
        self.assertEqual(e.tree.applies, 0)
        pv = e.preview(doc)
        self.assertEqual(pv["incidents"][0]["offer"], {"op": "withdraw", "reason": "private", "expunge": True, "class": "Note", "handle": note["handle"]})
        with open(e.tp.status, encoding="utf-8") as fh:
            text = fh.read()
        for needle in ("February", "1840", note["handle"], "N8002"):
            self.assertNotIn(needle, text)
        con = e.side()
        try:
            self.assertEqual(con.execute("SELECT class, handle, rule, state FROM incidents").fetchall(), [("Note", note["handle"], "scan.dob_exact", "open")])
            self.assertEqual(con.execute("SELECT COUNT(*) FROM base WHERE handle = ?", (note["handle"],)).fetchone()[0], 0)
        finally:
            con.close()
        # the same hit on every run, never a second row
        again = e.run("pull", yes=True)
        self.assertEqual(again["counts"]["privacy_incidents"], 1)
        con = e.side()
        try:
            self.assertEqual(con.execute("SELECT COUNT(*) FROM incidents").fetchone()[0], 1)
        finally:
            con.close()
        # once the website expunges the note the incident closes by itself
        e.cloud.tombstone(note["handle"])
        done = e.run("pull", yes=True)
        self.assertEqual((done["result"], done["counts"]["privacy_incidents"]), ("ok", 0))
        con = e.side()
        try:
            self.assertEqual(con.execute("SELECT state FROM incidents").fetchall(), [("resolved",)])
        finally:
            con.close()

    def test_a_pulled_date_of_any_class_that_shows_a_local_birth_day_is_skipped_too(self):
        e = self.env
        objs = load_cloud_objs(e)
        ev = copy.deepcopy(by_gid(objs, "E0002"))  # a non-birth event
        ev["date"] = copy.deepcopy(by_gid(objs, "E0001")["date"])
        ev["date"]["dateval"] = [14, 2, 1840, False]
        ev.update(handle="c" * 28, gramps_id="E8001")
        e.cloud.put(ev)
        doc = e.run("pull", yes=True)
        self.assertEqual(doc["counts"]["privacy_incidents"], 1)
        self.assertNotIn(ev["handle"], e.tree.objects())

    def test_an_unrelated_change_in_the_same_pull_still_applies(self):
        e = self.env
        e.cloud.put(self.local_birth_note())
        site = copy.deepcopy(by_gid(load_cloud_objs(e), "N0001"))
        site["format"] = 1
        e.cloud.put(site)
        doc = e.run("pull", yes=True)
        self.assertEqual(doc["counts"]["pulled"]["update"], 1)
        self.assertEqual(e.tree.objects()[site["handle"]]["format"], 1)


class Reverts(S.PullCase):
    def pull_an_edit(self):
        e = self.env
        before = e.tree.objects()
        site = copy.deepcopy(by_gid(load_cloud_objs(e), "N0004"))
        set_text(site, "A website change.")
        e.cloud.put(site)
        doc = e.run("pull", yes=True)
        self.assertEqual(doc["counts"]["pulled"]["update"], 1)
        return before, site["handle"]

    def test_a_push_that_returns_a_field_to_its_pre_pull_value_is_labelled_and_the_cli_parks_it(self):
        e = self.env
        before, h = self.pull_an_edit()
        e.tree.undo_last(before)  # Undo in Gramps, or a stale editor
        doc = e.run("check")
        self.assertEqual(doc["exit_code"], 10)
        pv = e.preview(doc)
        self.assertEqual([(o["op"], o["label"], o["disposition"]) for o in pv["to_website"]], [("update", "reverts a website change (origin)", "parked")])
        self.assertEqual(doc["counts"]["blocked"], 1)
        self.assertEqual(pv["planned_push"], {"create": 0, "update": 0, "delete": 0})
        gui = e.run("check", mode="gui")
        self.assertEqual([(o["label"], o["disposition"]) for o in e.preview(gui)["to_website"]], [("reverts a website change (origin)", "confirm")])

    def test_an_ordinary_edit_to_a_pulled_object_is_not_a_revert(self):
        e = self.env
        before, h = self.pull_an_edit()
        e.tree.edit(h, lambda o: set_text(o, "Something new that was never there."))
        pv = e.preview(e.run("check"))
        self.assertEqual([(o["label"], o["disposition"]) for o in pv["to_website"]], [("", "send")])

    def test_the_window_is_the_last_five_pull_runs(self):
        e = self.env
        before, h = self.pull_an_edit()
        objs = load_cloud_objs(e)
        for i in range(5):  # five more pulls that apply something
            site = copy.deepcopy(e.cloud.heads[by_gid(objs, "N0001")["handle"]]["obj"])
            site["format"] = i % 2 + 1
            e.cloud.put(site)
            self.assertEqual(e.run("pull", yes=True)["counts"]["pulled"]["update"], 1)
        e.tree.edit(h, lambda o: set_text(o, "The original text."))  # back to the pre-pull value, six pulls later
        pv = e.preview(e.run("check"))
        self.assertEqual([(o["label"], o["disposition"]) for o in pv["to_website"]], [("", "send")])

    def test_putting_a_deleted_object_back_or_deleting_a_pulled_one_is_a_revert(self):
        e = self.env
        new = copy.deepcopy(by_gid(load_cloud_objs(e), "N0004"))
        new.update(handle="d" * 28, gramps_id="N8003")
        e.cloud.put(new)
        e.run("pull", yes=True)
        e.tree.remove(new["handle"])  # io deletes the object the website created
        pv = e.preview(e.run("check"))
        self.assertEqual([(o["op"], o["label"]) for o in pv["to_website"]], [("delete", "reverts a website change (origin)")])
        # and the other way: a website delete that io then puts back
        e2 = S.Env(self)
        e2.settle()
        n = copy.deepcopy(by_gid(load_cloud_objs(e2), "N0004"))
        n.update(handle="e" * 28, gramps_id="N8004")
        e2.cloud.put(n)
        e2.run("pull", yes=True)
        e2.cloud.tombstone(n["handle"])
        keep = e2.tree.objects()
        e2.run("pull", yes=True, allow_deletes=True)
        self.assertNotIn(n["handle"], e2.tree.objects())
        e2.tree.undo_last(keep)
        pv2 = e2.preview(e2.run("check"))
        self.assertEqual([(o["op"], o["label"]) for o in pv2["to_website"]], [("create", "reverts a website change (origin)")])


class ExpungeNotices(S.PullCase):
    def test_a_changed_hash_at_an_unchanged_version_refreshes_the_base_and_holds_the_local_value(self):
        e = self.env
        h = by_gid(e.tree.objects(), "N0004")["handle"]
        scrubbed = copy.deepcopy(e.cloud.heads[h]["obj"])
        set_text(scrubbed, "[removed]")
        e.cloud.heads[h]["obj"] = scrubbed  # the same version: a scrub in place, as privacy-expunge --path leaves a head
        doc = e.run("check")
        self.assertEqual(doc["exit_code"], 10)
        self.assertEqual(e.preview(doc)["expunge_notices"][0]["paths"], ["/text/string"])
        done = e.run("pull", yes=True)
        self.assertEqual((done["result"], done["exit_code"]), ("ok", 0))
        con = e.side()
        try:
            row = con.execute("SELECT obj_json, hash FROM base WHERE handle = ?", (h,)).fetchone()
            self.assertIn("[removed]", row[0])
            self.assertEqual(con.execute("SELECT path, rule FROM holds WHERE handle = ?", (h,)).fetchall(), [("/text/string", "expunge.notice")])
        finally:
            con.close()
        # the local value is untouched, and the scrubbed value is never re-pushed
        self.assertNotEqual(e.tree.objects()[h]["text"]["string"], "[removed]")
        pv = e.preview(e.run("check"))
        self.assertEqual(pv["to_website"], [])
        e.tree.edit(h, lambda o: set_text(o, "The desktop rewrote the held note."))
        self.assertEqual(e.preview(e.run("check"))["to_website"], [])
        e.tree.edit(h, lambda o: o.update(format=1))  # another path of the same object still goes
        self.assertEqual([c["path"] for c in e.preview(e.run("check"))["to_website"][0]["changes"]], ["/format"])


class ReviewedPlanAndGuards(S.PullCase):
    def test_a_reviewed_plan_applies_only_when_the_new_plan_hash_equals_it(self):
        e = self.env
        website_edits(e)
        review = e.run("check")
        doc = e.run("sync", yes=True, plan=review["run_id"])
        self.assertEqual((doc["result"], doc["exit_code"]), ("ok", 0))
        self.assertEqual(e.tree.applies, 1)
        # a change approved after the review is not applied
        site = copy.deepcopy(by_gid(load_cloud_objs(e), "N0004"))
        set_text(site, "One more edit.")
        e.cloud.put(site)
        review = e.run("check")
        later = copy.deepcopy(site)
        set_text(later, "An edit made after the review.")
        e.cloud.put(later)
        before = e.tree.objects()
        refused = e.run("sync", yes=True, plan=review["run_id"])
        self.assertEqual((refused["result"], refused["exit_code"], refused["error"]["code"]), ("changes_pending", 10, "plan_changed"))
        self.assertEqual(e.tree.objects(), before)
        self.assertEqual(e.tree.applies, 1)
        unknown = e.run("sync", yes=True, plan="T%025d" % 77)
        self.assertEqual((unknown["exit_code"], unknown["error"]["code"]), (64, "plan_unknown"))

    def test_the_plan_hash_depends_on_what_would_happen_and_on_nothing_else(self):
        e = self.env
        website_edits(e)
        a, b = e.run("check"), e.run("check")
        self.assertEqual(e.preview(a)["plan_hash"], e.preview(b)["plan_hash"])
        self.assertNotEqual(a["run_id"], b["run_id"])

    def test_a_mass_delete_is_never_applied_by_the_cli(self):
        e = self.env
        objs = load_cloud_objs(e)
        handles = []
        for i in range(12):
            n = copy.deepcopy(by_gid(objs, "N0004"))
            n.update(handle="%028x" % (i + 1), gramps_id="N81%02d" % i)
            e.cloud.put(n)
            handles.append(n["handle"])
        self.assertEqual(e.run("pull", yes=True)["counts"]["pulled"]["create"], 12)
        for h in handles:
            e.cloud.tombstone(h)
        doc = e.run("pull", yes=True, allow_deletes=True)
        self.assertEqual((doc["result"], doc["exit_code"], doc["counts"]["blocked"]), ("partial", 20, 12))
        self.assertTrue(all(h in e.tree.objects() for h in handles))
        self.assertTrue(e.preview(doc)["mass_delete"])
        ok = e.run("pull", yes=True, allow_deletes=True, mode="gui", services={"confirm_mass_delete": True})
        self.assertEqual(ok["counts"]["pulled"]["delete"], 12)
        self.assertFalse(any(h in e.tree.objects() for h in handles))

    def test_the_refusals(self):
        e = self.env
        website_edits(e)
        e.cloud.bound = False
        self.assertEqual(e.run("pull", yes=True)["error"]["code"], "cloud_unbound")
        e.cloud.bound = True
        e.cloud.dbid = "someothertree"
        doc = e.run("pull", yes=True)
        self.assertEqual((doc["result"], doc["exit_code"], doc["error"]["code"]), ("refused", 78, "D03"))
        e.cloud.dbid = e.tree.dbid
        low = e.run("pull", yes=True, services={"free_bytes": lambda: 1})
        self.assertEqual((low["result"], low["exit_code"], low["error"]["code"]), ("refused", 75, "disk_space"))
        self.assertEqual(os.listdir(e.tp.backups), [])
        e.tree.editors = True
        gui = e.run("pull", yes=True, mode="gui")
        self.assertEqual((gui["result"], gui["error"]["code"], gui["next_action"]), ("refused", "D45", "retry"))
        self.assertEqual(e.tree.applies, 0)
        e.tree.editors = False
        self.assertEqual(e.run("pull", yes=True)["result"], "ok")

    def test_a_sign_in_or_network_problem_is_a_refusal_with_the_wrappers_exit_code(self):
        e = self.env

        class Down(S.FakeCloud):
            def meta(self):
                raise transport.TransportError("network", consts.EXIT_TEMPORARY, "retry", message="The network call failed.")

        doc = e.run("check", services={"cloud": Down()})
        self.assertEqual((doc["result"], doc["exit_code"], doc["next_action"]), ("failed", 75, "retry"))

        class Unauthorized(S.FakeCloud):
            def meta(self):
                raise transport.TransportError("http_401", consts.EXIT_SIGN_IN, "login", status=401)

        doc = e.run("pull", yes=True, services={"cloud": Unauthorized()})
        self.assertEqual((doc["result"], doc["exit_code"], doc["next_action"]), ("refused", 77, "login"))


if __name__ == "__main__":
    unittest.main()
