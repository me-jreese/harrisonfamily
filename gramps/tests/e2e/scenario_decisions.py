"""Web conflict decisions on a pull (HFY-TSK-338, SI-30): the installed addon, the real Gramps CLI and the sync dev server.

An admin decides a parked conflict on the website. The decision stores {cloud_version, cloud_value_hash}; the addon applies it only while the
website's record is still that version with those values, and otherwise the website reopens the conflict and nothing is applied.

    keep website      the decision is applied by the next pull: the desktop takes the website's value, the conflict closes, the website gets a receipt
    keep desktop      the desktop value stays, goes up in the next push, and the website has the receipt
    version moved     the website changed the record after the decision: the conflict is open again (the old decision in its history), nothing applied
    same version      a scrub changed the values at the same version: reopened as well
    check             a check reports what it would reopen and writes nothing, on either side

Fictional data only. The conflict is opened in the website's queue by the dev server's /_dev/conflicts, standing in for the desktop's mirror.
"""
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import e2e_case as C  # noqa: E402
from scenario_pull import PullE2E, by_gid, set_text  # noqa: E402


class Decisions(PullE2E):
    def parked(self):
        """Both sides rewrite one note; the first pull parks the conflict and the website's queue gets it. Returns (handle, website conflict)."""
        self.bring_up()
        self.settle()
        self.local_edit_note("N0004", "The desktop's version.")
        self.cloud.edit("N0004", lambda o: set_text(o, "The website's version."))
        proc, doc = self.hfy("pull", "--yes")
        self.assertEqual((proc.returncode, doc["result"]), (20, "partial"), proc.stdout + proc.stderr)
        handle = by_gid(self.local_objects(), "N0004")["handle"]
        site = self.cloud.heads()[handle]["obj"]["text"]
        conflict = self.server.open_conflict("Note", handle, [{"path": "/text", "base": None, "cloud": site, "desktop": None}], gramps_id="N0004")
        return handle, conflict

    def decide(self, conflict, decision):
        return self.cloud.client.post("/api/sync/conflicts/%s/decision" % conflict["id"], {"decision": decision}).body

    def website_conflict(self, cid):
        for state in ("open", "resolved"):
            for c in self.server.conflicts(state):
                if c["id"] == cid:
                    return c
        self.fail("the website has no conflict %s" % cid)

    def calls(self, path_end):
        return [e for e in self.server.entries() if e["method"] == "POST" and e["path"].endswith(path_end)]

    def test_keep_website_is_applied_by_the_next_pull_and_receipted(self):
        handle, conflict = self.parked()
        decided = self.decide(conflict, "keep_cloud")
        self.assertEqual((decided["state"], decided["cloud_version"]), ("resolved", self.cloud.version_of(handle)))
        proc, doc = self.hfy("pull", "--yes")
        self.assertEqual((proc.returncode, doc["result"], doc["counts"]["conflicts_open"]), (0, "ok", 0), proc.stdout + proc.stderr + json.dumps(doc["error"]))
        self.assertEqual(self.local_note_text(), "The website's version.")
        self.assertEqual(self.table("SELECT state, decision, cloud_conflict_id FROM conflicts"), [("resolved", "keep_cloud", conflict["id"])])
        mine = self.website_conflict(conflict["id"])
        self.assertEqual((mine["state"], mine["decision"]), ("resolved", "keep_cloud"))
        self.assertIsNotNone(mine["applied_at"], "the website has the receipt")
        shown = self.preview(doc)["decisions"]
        self.assertEqual([(x["id"], x["status"]) for x in shown], [(conflict["id"], "applied")])
        self.assertNotIn("version.", proc.stdout + proc.stderr + json.dumps(shown), "no field values in the output or the report")
        sent = len(self.calls("/applied"))
        proc, again = self.hfy("pull", "--yes")
        self.assertEqual((proc.returncode, again["result"]), (0, "ok"))
        self.assertEqual(len(self.calls("/applied")), sent, "a second pull sends no second receipt")
        self.assertEqual(self.preview(again)["decisions"], [])

    def test_keep_desktop_keeps_the_desktop_value_and_the_next_push_sends_it(self):
        handle, conflict = self.parked()
        self.decide(conflict, "keep_desktop")
        proc, doc = self.hfy("pull", "--yes")
        self.assertEqual((proc.returncode, doc["result"], doc["counts"]["push_pending"]), (0, "ok", 1), proc.stdout + proc.stderr)
        self.assertEqual(self.local_note_text(), "The desktop's version.")
        self.assertEqual(self.table("SELECT state, decision FROM conflicts"), [("resolved", "keep_desktop")])
        self.assertIsNotNone(self.website_conflict(conflict["id"])["applied_at"])
        self.assertEqual(self.cloud.heads()[handle]["obj"]["text"]["string"], "The website's version.", "not pushed yet")
        proc, pushed = self.hfy("push", "--yes")
        # the fixture holds nine private fields back from every push, so the run is `partial` (held) and sends the rest
        self.assertEqual((proc.returncode, pushed["result"], pushed["counts"]["conflicts_open"]), (20, "partial", 0), proc.stdout + proc.stderr)
        self.assertEqual(self.cloud.heads()[handle]["obj"]["text"]["string"], "The desktop's version.")
        # the push moved the website's record, and the decision is not reopened for it: it was receipted
        proc, after = self.hfy("pull", "--yes")
        self.assertEqual((proc.returncode, after["result"]), (0, "ok"), proc.stdout + proc.stderr)
        self.assertEqual(self.website_conflict(conflict["id"])["state"], "resolved")

    def test_a_record_that_moved_after_the_decision_reopens_the_conflict_and_nothing_is_applied(self):
        handle, conflict = self.parked()
        self.decide(conflict, "keep_cloud")
        self.cloud.edit("N0004", lambda o: set_text(o, "The website changed its mind."))
        before = self.local_objects()[handle]
        proc, doc = self.hfy("pull", "--yes")
        self.assertEqual((proc.returncode, doc["result"], doc["next_action"]), (20, "partial", "resolve_conflicts"), proc.stdout + proc.stderr)
        self.assertEqual(self.local_objects()[handle], before, "nothing was applied")
        mine = self.website_conflict(conflict["id"])
        self.assertEqual((mine["state"], mine["decision"], mine["history"][0]["decision"], mine["history"][0]["reason"]), ("open", None, "keep_cloud", "version_changed"))
        self.assertEqual([(x["status"], x["reason"]) for x in self.preview(doc)["decisions"]], [("reopened", "version_changed")])
        self.assertEqual(self.table("SELECT state, cloud_conflict_id FROM conflicts"), [("parked", conflict["id"])])
        report = json.loads(self.table("SELECT value FROM meta WHERE key = 'web_decisions'")[0][0])
        self.assertEqual(report["counts"]["reopened"], 1)
        self.assertEqual(len(self.calls("/applied")), 0)

    def test_a_scrub_at_the_same_version_reopens_it_too(self):
        handle, conflict = self.parked()
        self.decide(conflict, "keep_desktop")
        obj = self.cloud.heads()[handle]["obj"]
        obj["text"]["string"] = "[removed]"
        self.cloud.scrub(obj)
        proc, doc = self.hfy("pull", "--yes")
        self.assertEqual(self.website_conflict(conflict["id"])["state"], "open", proc.stdout + proc.stderr)
        self.assertEqual([x["status"] for x in self.preview(doc)["decisions"]], ["reopened"])
        self.assertEqual(self.local_note_text(), "The desktop's version.")

    def test_a_check_reports_what_it_would_reopen_and_writes_nothing(self):
        handle, conflict = self.parked()
        self.decide(conflict, "keep_cloud")
        self.cloud.edit("N0004", lambda o: set_text(o, "The website changed its mind."))
        self.opened_once()
        db_before, base_before = self.db_sha(), self.base_dump()
        proc, doc = self.hfy("check")
        self.assertEqual(doc["action"], "check", proc.stdout + proc.stderr)
        self.assertEqual([(x["status"], x["reason"]) for x in self.preview(doc)["decisions"]], [("reopened", "version_changed")])
        self.assertEqual(self.website_conflict(conflict["id"])["state"], "resolved", "the website is untouched by a check")
        self.assertEqual((self.db_sha(), self.base_dump()), (db_before, base_before))
        self.assertEqual(self.table("SELECT value FROM meta WHERE key = 'web_decisions'"), [])

    def test_a_check_on_a_matching_decision_says_it_would_apply_and_applies_nothing(self):
        handle, conflict = self.parked()
        self.decide(conflict, "keep_cloud")
        self.opened_once()
        db_before = self.db_sha()
        proc, doc = self.hfy("check")
        self.assertEqual((proc.returncode, doc["result"]), (10, "changes_pending"), proc.stdout + proc.stderr)
        self.assertEqual([x["status"] for x in self.preview(doc)["decisions"]], ["applied"])
        self.assertEqual(self.db_sha(), db_before)
        self.assertEqual(self.local_note_text(), "The desktop's version.")
        self.assertEqual(len(self.calls("/applied")), 0)


if __name__ == "__main__":
    unittest.main()
