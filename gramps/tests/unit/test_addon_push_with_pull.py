"""The push next to the pull: the sidecar rows the pull (HFY-TSK-205) writes and the push (HFY-TSK-206) must leave alone and obey.

    python3 -m unittest discover gramps/tests/unit -p test_addon_push_with_pull.py

The pull records a website scrub as an `expunge.notice` hold and follows the website's scrubbed copy in the base; a push that put the
desktop's value back would undo the scrub. The pull also parks a conflict (command line) or leaves it open (Gramps window), and both pin
their path. These tests write those rows the way the pull does and then run the push. Every value is the fixture's. Python 3.9 compatible.
"""
import copy
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from test_addon_push import PushCase  # noqa: E402
from hfygramps.addon import consts, decisions, pushstate, sidecar, transport  # noqa: E402
import push_support as PS  # noqa: E402

NAME = "/primary_name/first_name"
SCRUBBED = "[removed]"


class ScrubbedByTheWebsite(PushCase):
    def scrub(self, handle, with_hold=True):
        """What a pull leaves after the website scrubbed the first name in place: the cloud head at the SAME version with another hash,
        the base row following it, and (unless `with_hold` is false) an expunge.notice hold for the pointer."""
        head = self.cloud.heads[handle]
        head["obj"] = copy.deepcopy(head["obj"])
        head["obj"]["primary_name"]["first_name"] = SCRUBBED
        con = self.sidecar()
        try:
            pushstate.apply_cloud_heads(con, {handle: head}, [handle])
            if with_hold:
                con.execute("INSERT INTO holds (class, handle, path, rule, detail, first_seen) VALUES (?, ?, ?, ?, '', ?)",
                            (head["class"], handle, NAME, sidecar.EXPUNGE_RULE, "2026-10-14T00:00:00Z"))
                con.commit()
        finally:
            con.close()

    def first_name(self, handle):
        return self.cloud.heads[handle]["obj"]["primary_name"]["first_name"]

    def test_without_the_hold_the_push_puts_the_desktop_value_back(self):
        # the control: this is what the hold is for
        self.seed()
        h = self.a_person()
        local = self.tree.data[h]["primary_name"]["first_name"]
        self.scrub(h, with_hold=False)
        self.push()
        self.assertEqual(self.first_name(h), local)

    def test_a_scrubbed_value_is_not_put_back_and_nothing_is_sent_when_it_was_all_that_differed(self):
        self.seed()
        h = self.a_person()
        local = self.tree.data[h]["primary_name"]["first_name"]
        self.assertNotEqual(local, SCRUBBED)
        self.scrub(h)
        sent = len(self.cloud.batches)
        for _ in range(2):
            doc = self.push()
            self.assertEqual(doc["counts"]["pushed"], {"create": 0, "update": 0, "delete": 0})
        self.assertEqual(len(self.cloud.batches), sent)
        self.assertEqual(self.first_name(h), SCRUBBED)
        self.assertEqual(self.tree.data[h]["primary_name"]["first_name"], local, "the desktop keeps its own value")
        self.assertNotIn(local, "\n".join(b for _m, _p, b in self.cloud.requests[-6:] if b))

    def test_another_edit_of_the_same_object_goes_out_without_the_scrubbed_value(self):
        self.seed()
        h = self.a_person()
        self.scrub(h)
        self.tree.edit(h, lambda o: o["primary_name"]["surname_list"][0].__setitem__("surname", "Reedited"))
        before = self.cloud.heads[h]["version"]
        doc = self.push()
        self.assertEqual(doc["counts"]["pushed"], {"create": 0, "update": 1, "delete": 0})
        self.assertEqual(self.cloud.heads[h]["version"], before + 1)
        self.assertEqual(self.cloud.heads[h]["obj"]["primary_name"]["surname_list"][0]["surname"], "Reedited")
        self.assertEqual(self.first_name(h), SCRUBBED)
        row = self.rows("SELECT obj_json FROM base WHERE handle = ?", h)[0][0]
        self.assertIn(SCRUBBED, row, "the base is the pushed object, scrubbed value included")

    def test_the_expunge_notice_survives_a_push_that_replaces_the_holds(self):
        self.seed()
        h = self.a_person()
        self.scrub(h)
        self.push()
        mine = self.rows("SELECT class, handle, path, rule FROM holds WHERE rule = ?", sidecar.EXPUNGE_RULE)
        self.assertEqual(mine, [("Person", h, NAME, sidecar.EXPUNGE_RULE)])


class PinsFromThePull(PushCase):
    def conflict(self, state, cid="c1"):
        con = self.sidecar()
        try:
            con.execute("INSERT INTO conflicts (id, class, handle, path, kind, base_json, cloud_json, local_json, state, detected_at) "
                        "VALUES (?, 'Person', ?, '/gender', 'field', '1', '2', '3', ?, '2026-10-14T00:00:00Z')", (cid, "h-" + state, state))
            con.commit()
        finally:
            con.close()

    def test_an_open_and_a_parked_conflict_both_pin_their_path(self):
        self.seed()
        self.conflict("open", "c-open")
        self.conflict("parked", "c-parked")
        self.conflict("resolved", "c-done")
        con = self.sidecar()
        try:
            self.assertEqual(sorted(c["id"] for c in pushstate.open_conflicts(con)), ["c-open", "c-parked"])
            self.assertEqual(sorted(pushstate.pins(con)), ["h-open", "h-parked"])
        finally:
            con.close()

    def test_a_conflict_the_merge_found_closed_is_resolved_whether_it_was_open_or_parked(self):
        self.seed()
        self.conflict("open", "c-open")
        self.conflict("parked", "c-parked")
        con = self.sidecar()
        try:
            pushstate.record_conflicts(con, [], ["c-open", "c-parked"], "2026-10-15T00:00:00Z")
            self.assertEqual(pushstate.open_conflicts(con), [])
            self.assertEqual(sorted(r[0] for r in con.execute("SELECT state FROM conflicts")), ["resolved", "resolved"])
        finally:
            con.close()

    def test_the_command_line_records_what_it_found_as_parked_and_the_gramps_window_as_open(self):
        self.seed()
        con = self.sidecar()
        try:
            found = [{"id": "c9", "class": "Person", "handle": "h9", "path": "/gender", "kind": "field",
                      "base_json": "1", "cloud_json": "2", "local_json": "3"}]
            pushstate.record_conflicts(con, found, [], "2026-10-15T00:00:00Z", state="parked")
            self.assertEqual([c["state"] for c in pushstate.open_conflicts(con)], ["parked"])
            pushstate.record_conflicts(con, found, [], "2026-10-15T00:00:01Z", state="open")
            self.assertEqual([c["state"] for c in pushstate.open_conflicts(con)], ["open"])
        finally:
            con.close()


class WebDecisionReceipts(PushCase):
    """HFY-TSK-338: a keep_desktop decision a pull applied is receipted by the push that carries the desktop value, not by the pull."""

    def wait_for_push(self, *handles):
        con = self.sidecar()
        try:
            sidecar.set_meta_json(con, decisions.RECEIPTS_KEY, [{"id": "%026d" % (i + 1), "class": "Person", "handle": h} for i, h in enumerate(handles)])
            con.commit()
        finally:
            con.close()

    def waiting(self):
        con = self.sidecar()
        try:
            return [r["handle"] for r in sidecar.meta_json(con, decisions.RECEIPTS_KEY, [])]
        finally:
            con.close()

    def edit(self, h):
        self.tree.edit(h, lambda o: o["primary_name"].__setitem__("first_name", "Edited"))

    def test_the_receipt_goes_after_the_batch_that_carries_the_value_and_only_for_that_object(self):
        self.seed()
        a = self.a_person()
        b = "unrelated000000000000000a1"   # an object this push neither carried nor finds in agreement
        self.wait_for_push(a, b)
        self.edit(a)
        self.push()
        self.assertEqual(self.cloud.heads[a]["obj"]["primary_name"]["first_name"], "Edited")
        self.assertEqual(self.cloud.decision_receipts, [("%026d" % 1, "applied")], "a was pushed; nothing says b's value reached the website")
        self.assertEqual(self.waiting(), [b])

    def test_a_dry_run_sends_no_receipt_and_the_real_push_does(self):
        self.seed()
        a = self.a_person()
        self.wait_for_push(a)
        self.edit(a)
        self.push(dry_run=True)
        self.assertEqual((self.cloud.decision_receipts, self.waiting()), ([], [a]))
        self.push()
        self.assertEqual(self.waiting(), [])

    def test_a_refused_object_is_not_receipted(self):
        self.seed()
        a = self.a_person()
        self.wait_for_push(a)
        self.edit(a)
        self.cloud.refuse_privacy = {a}
        self.push()
        self.assertEqual(self.cloud.heads[a]["version"], 1)
        self.assertEqual((self.cloud.decision_receipts, self.waiting()), ([], [a]))

    def test_a_receipt_that_fails_never_fails_the_push_and_is_sent_by_the_next_one(self):
        self.seed()
        a = self.a_person()
        self.wait_for_push(a)
        self.edit(a)
        self.cloud.fail_with.append(("/api/sync/conflicts/", PS.err(503, "unavailable")))
        doc = self.push()
        self.assertEqual(self.cloud.heads[a]["version"], 2)
        self.assertIn(doc["result"], ("ok", "partial"))
        self.assertEqual(self.waiting(), [a])
        self.push()  # nothing to push: the two sides agree, so the object is receipted now
        self.assertEqual((self.cloud.decision_receipts, self.waiting()), ([("%026d" % 1, "applied")], []))

    def test_a_decision_the_website_reopened_or_does_not_know_is_dropped(self):
        self.seed()
        a = self.a_person()
        self.wait_for_push(a)
        self.edit(a)
        self.cloud.fail_with.append(("/api/sync/conflicts/", PS.err(409, "not_resolved")))
        self.push()
        self.assertEqual(self.waiting(), [])


if __name__ == "__main__":
    unittest.main()
