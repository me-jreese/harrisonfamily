"""The website's conflict decisions on a pull (HFY-TSK-338, SI-30): a decision is applied only while the cloud value still matches, else the
conflict is reopened and nothing is applied. Fake tree, fake cloud (whose reconcile route uses the same rule the shared vectors pin to the website's),
the synthetic fixture; every name and value is fictional.
"""
import copy
import json
import os
import unittest

import addon_pull_support as S
from hfygramps.addon import consts, decisions as D, sidecar, transport

from test_addon_pull import by_gid, load_cloud_objs, set_text

HERE = os.path.dirname(os.path.abspath(__file__))
VECTORS = os.path.join(HERE, "..", "fixtures", "conflict-decision.vectors.json")


def vectors():
    with open(VECTORS, encoding="utf-8") as fh:
        return json.load(fh)


class RuleParity(unittest.TestCase):
    """decisions.py against the rows the website's own functions wrote (api/test/sync-pull.test.js reads the same file)."""

    def test_the_hash_is_the_websites_for_every_vector(self):
        rows = vectors()["hashes"]
        self.assertGreaterEqual(len(rows), 8)
        for v in rows:
            self.assertEqual(D.cloud_value_hash(v["paths"]), v["hash"], v["title"])

    def test_pointers_resolve_and_give_up_where_the_website_does(self):
        doc = vectors()["pointers"]
        for c in doc["cases"]:
            got = D.cloud_value_at(doc["object"], c["path"])
            self.assertEqual(got is D._UNRESOLVED, c["unresolved"], c["path"])
            if not c["unresolved"]:
                self.assertEqual(got, c["value"], c["path"])

    def test_the_stale_reason_is_the_websites_for_every_vector(self):
        rows = vectors()["stale"]
        self.assertGreaterEqual(len(rows), 10)
        for v in rows:
            self.assertEqual(D.stale_reason(v["decision"], v["current"]["version"], v["current"]["paths"]), v["reason"], v["title"])

    def test_a_value_with_no_canonical_form_never_matches(self):
        self.assertIsNone(D.cloud_value_hash([{"path": "/x", "cloud": 1.5}]))
        stored = D.cloud_value_hash([{"path": "/x", "cloud": 1}])
        self.assertEqual(D.stale_reason({"state": "resolved", "cloud_version": 1, "cloud_value_hash": stored}, 1, [{"path": "/x", "cloud": 1.5}]), "value_changed")


class DecisionCase(S.PullCase):
    """Both sides rewrite one note; the first pull parks the conflict."""

    def setUp(self):
        super().setUp()
        e = self.env
        site = copy.deepcopy(by_gid(load_cloud_objs(e), "N0004"))
        set_text(site, "The website's wording.")
        e.cloud.put(site)
        self.handle = site["handle"]
        e.tree.edit(self.handle, lambda o: set_text(o, "The desktop's wording."))
        first = e.run("pull", yes=True)
        self.assertEqual((first["result"], first["exit_code"]), ("partial", 20))
        self.cloud_paths = [{"path": "/text", "cloud": copy.deepcopy(e.cloud.heads[self.handle]["obj"]["text"])}]

    def decide(self, decision="keep_cloud", **kw):
        return self.env.cloud.decide("Note", self.handle, self.cloud_paths, decision, **kw)

    def text(self):
        return self.env.tree.objects()[self.handle]["text"]["string"]

    def rows(self):
        con = self.env.side()
        try:
            return con.execute("SELECT state, decision, cloud_conflict_id, path FROM conflicts").fetchall()
        finally:
            con.close()

    def meta(self, key):
        con = self.env.side()
        try:
            return sidecar.meta_json(con, key, None)
        finally:
            con.close()

    def pull(self, mode="cli", **kw):
        return self.env.run("pull", yes=True, mode=mode, **kw)

    def decisions_of(self, doc):
        return self.env.preview(doc)["decisions"]


class AppliedOnMatch(DecisionCase):
    def test_keep_cloud_takes_the_websites_value_closes_the_conflict_and_sends_a_receipt(self):
        e = self.env
        d = self.decide("keep_cloud")
        doc = self.pull()
        self.assertEqual((doc["result"], doc["exit_code"]), ("ok", 0))
        self.assertEqual(self.text(), "The website's wording.")
        self.assertEqual(e.tree.applies, 1)  # the first pull only parked the conflict; this one applied the decision
        self.assertEqual(self.rows(), [("resolved", "keep_cloud", d["id"], "/text")])
        self.assertEqual(e.cloud.receipts, [(d["id"], "applied")])
        self.assertEqual(doc["counts"]["conflicts_open"], 0)
        self.assertEqual(doc["counts"]["push_pending"], 0)
        shown = self.decisions_of(doc)
        self.assertEqual([(x["id"], x["decision"], x["status"], x["paths"]) for x in shown], [(d["id"], "keep_cloud", "applied", ["/text"])])
        self.assertEqual(self.meta("web_decisions")["counts"], {"applied": 1, "reopened": 0, "held": 0, "moot": 0})

    def test_keep_desktop_keeps_the_desktop_value_and_puts_it_in_the_push(self):
        e = self.env
        d = self.decide("keep_desktop")
        before = json.dumps(e.tree.objects()[self.handle], sort_keys=True)
        doc = self.pull()
        self.assertEqual((doc["result"], doc["exit_code"]), ("ok", 0))
        self.assertEqual(json.dumps(e.tree.objects()[self.handle], sort_keys=True), before, "the desktop value stays")
        self.assertEqual(doc["counts"]["push_pending"], 1, "and goes to the website on the next push")
        self.assertEqual(self.rows(), [("resolved", "keep_desktop", d["id"], "/text")])
        self.assertEqual(e.cloud.receipts, [(d["id"], "applied")])
        ops = e.preview(doc)["to_website"]
        self.assertEqual([(o["handle"], o["op"]) for o in ops], [(self.handle, "update")])

    def test_the_website_is_asked_with_the_value_the_merge_found_at_each_open_conflict_path(self):
        e = self.env
        self.decide("keep_cloud")
        self.pull()
        call = e.cloud.reconcile_calls[-1]
        self.assertFalse(call["dry"])
        self.assertEqual([(o["class"], o["handle"], o["path"], o["cloud"]) for o in call["observed"]],
                         [("Note", self.handle, "/text", e.cloud.heads[self.handle]["obj"]["text"])])

    def test_a_second_pull_finds_nothing_to_do(self):
        e = self.env
        self.decide("keep_cloud")
        self.pull()
        doc = self.pull()
        self.assertEqual((doc["result"], doc["exit_code"]), ("ok", 0))
        self.assertEqual(e.cloud.receipts, [(e.cloud.conflicts[0]["id"], "applied")], "one receipt, not two")
        self.assertEqual(self.decisions_of(doc), [])

    def test_the_gui_applies_it_the_same_way(self):
        e = self.env
        e.run("pull", yes=True, mode="gui")  # the parked conflict becomes the window's open one
        d = self.decide("keep_cloud")
        doc = self.pull("gui")
        self.assertEqual((doc["result"], doc["exit_code"]), ("ok", 0))
        self.assertEqual(self.text(), "The website's wording.")
        self.assertEqual(self.rows()[0][:3], ("resolved", "keep_cloud", d["id"]))


class ReopenedWhenTheCloudMoved(DecisionCase):
    def assert_untouched(self, doc, before_text, why):
        e = self.env
        self.assertEqual((doc["result"], doc["exit_code"], doc["next_action"]), ("partial", 20, "resolve_conflicts"))
        self.assertEqual(self.text(), before_text, "nothing was applied")
        self.assertEqual(e.cloud.receipts, [])
        self.assertEqual(self.rows()[0][0], "parked", "the desktop conflict is still open")
        shown = self.decisions_of(doc)
        self.assertEqual([(x["status"], x["reason"]) for x in shown], [("reopened", why)])
        report = self.meta("web_decisions")
        self.assertEqual([(x["status"], x["reason"], x["paths"]) for x in report["reopened"]], [("reopened", why, ["/text"])])
        self.assertEqual(report["counts"]["reopened"], 1)

    def test_a_version_mismatch_reopens_the_conflict_and_applies_nothing(self):
        e = self.env
        d = self.decide("keep_cloud")
        site = copy.deepcopy(e.cloud.heads[self.handle]["obj"])
        set_text(site, "The website's wording, again.")
        e.cloud.put(site)  # a new version after the decision
        before = self.text()
        doc = self.pull()
        self.assert_untouched(doc, before, "version_changed")
        self.assertEqual(e.cloud.conflicts[0]["state"], "open")
        self.assertEqual(e.cloud.conflicts[0]["history"][0]["decision"], "keep_cloud")
        self.assertEqual(self.rows()[0][2], d["id"], "the desktop conflict is linked to the website's")

    def test_a_hash_mismatch_at_the_same_version_reopens_it_too(self):
        e = self.env
        self.decide("keep_desktop")
        site = copy.deepcopy(e.cloud.heads[self.handle]["obj"])
        set_text(site, "A scrubbed wording.")
        e.cloud.put(site, version=e.cloud.heads[self.handle]["version"])  # the same version, other content
        before = self.text()
        self.assert_untouched(self.pull(), before, "value_changed")

    def test_a_decision_stored_without_a_hash_is_reopened(self):
        self.decide("keep_cloud", cloud_value_hash=None)
        before = self.text()
        self.assert_untouched(self.pull(), before, "no_hash")

    def test_a_malformed_hash_is_reopened(self):
        self.decide("keep_cloud", cloud_value_hash="x" * 64)
        before = self.text()
        self.assert_untouched(self.pull(), before, "no_hash")

    def test_a_decision_made_against_another_cloud_value_is_reopened(self):
        e = self.env
        d = self.env.cloud.decide("Note", self.handle, [{"path": "/text", "cloud": {"_class": "StyledText", "string": "What the queue once showed.", "tags": []}}], "keep_cloud")
        before = self.text()
        doc = self.pull()
        self.assert_untouched(doc, before, "value_changed")
        self.assertEqual(e.cloud.conflicts[0]["id"], d["id"])

    def test_reopened_conflicts_are_reported_by_a_check_and_nothing_is_written(self):
        e = self.env
        self.decide("keep_cloud", cloud_value_hash=None)
        before = self.text()
        doc = e.run("check")
        self.assertEqual(self.text(), before)
        self.assertEqual([(x["status"], x["reason"]) for x in self.decisions_of(doc)], [("reopened", "no_hash")])
        self.assertTrue(e.cloud.reconcile_calls[-1]["dry"])
        self.assertEqual(e.cloud.conflicts[0]["state"], "resolved", "a check does not reopen anything on the website")
        self.assertIsNone(self.meta("web_decisions"), "and writes nothing to the sidecar")


class HeldAndMoot(DecisionCase):
    def test_a_decision_the_website_called_valid_but_this_snapshot_does_not_match_is_held(self):
        e = self.env
        e.cloud.force_apply = True  # the website's call and this run's snapshot disagree
        self.decide("keep_cloud", version=99)
        before = self.text()
        doc = self.pull()
        self.assertEqual(self.text(), before)
        self.assertEqual(e.cloud.receipts, [])
        self.assertEqual([(x["status"], x["reason"]) for x in self.decisions_of(doc)], [("held", "changed_since_check")])
        self.assertEqual(self.rows()[0][0], "parked")

    def test_a_check_reports_what_a_pull_would_apply_and_changes_nothing(self):
        e = self.env
        d = self.decide("keep_cloud")
        before = (self.text(), self.rows(), json.dumps(e.cloud.conflicts, sort_keys=True))
        doc = e.run("check")
        self.assertEqual((doc["result"], doc["exit_code"]), ("changes_pending", 10))
        self.assertEqual([(x["id"], x["status"]) for x in self.decisions_of(doc)], [(d["id"], "applied")])
        self.assertEqual((self.text(), self.rows(), json.dumps(e.cloud.conflicts, sort_keys=True)), before)
        self.assertEqual(e.cloud.receipts, [])

    def test_a_decision_with_no_conflict_left_on_the_desktop_is_receipted_as_moot(self):
        e = self.env
        d = self.decide("keep_cloud")
        e.tree.edit(self.handle, lambda o: set_text(o, "The website's wording."))  # io made the desktop match first
        doc = self.pull()
        self.assertEqual((doc["result"], doc["exit_code"]), ("ok", 0))
        self.assertEqual([(x["status"], x["conflicts"]) for x in self.decisions_of(doc)], [("moot", [])])
        self.assertEqual(e.cloud.receipts, [(d["id"], "moot")])

    def test_two_decisions_on_one_conflict_apply_the_newest_and_receipt_the_other_as_moot(self):
        e = self.env
        old = self.decide("keep_desktop", cid="a" * 26)
        new = self.decide("keep_cloud", cid="b" * 26)
        e.cloud.conflicts.reverse()  # the website lists the newest first
        self.pull()
        self.assertEqual(self.text(), "The website's wording.")
        self.assertEqual(sorted(e.cloud.receipts), sorted([(new["id"], "applied"), (old["id"], "moot")]))

    def test_a_conflict_that_still_conflicts_after_the_decision_stays_open(self):
        # a composite conflict: the website changed the birth year over a desktop day and month. "Keep website" cannot take it silently.
        e = self.env
        objs = load_cloud_objs(e)
        birth = copy.deepcopy(by_gid(objs, "E0001"))
        birth["date"]["dateval"][2] = 1841
        e.cloud.put(birth)
        first = self.pull()
        self.assertEqual(first["exit_code"], 20)
        con = e.side()
        try:
            row = con.execute("SELECT cloud_json FROM conflicts WHERE path = '/date'").fetchone()
        finally:
            con.close()
        paths = [{"path": "/date", "cloud": json.loads(row[0])}]
        d = e.cloud.decide("Event", birth["handle"], paths, "keep_cloud")
        local_before = json.dumps(e.tree.objects()[birth["handle"]], sort_keys=True)
        doc = self.pull()
        self.assertEqual(json.dumps(e.tree.objects()[birth["handle"]], sort_keys=True), local_before)
        mine = [x for x in self.decisions_of(doc) if x["id"] == d["id"]]
        self.assertEqual([(x["status"], x["reason"]) for x in mine], [("held", "conflict_remains")])
        self.assertEqual(e.cloud.receipts, [])
        con = e.side()
        try:
            self.assertEqual(con.execute("SELECT state FROM conflicts WHERE path = '/date'").fetchone()[0], "parked")
        finally:
            con.close()


class Robustness(DecisionCase):
    def test_a_website_without_the_route_is_pulled_from_as_before(self):
        e = self.env
        e.cloud.reconcile_error = transport.TransportError("not_found", consts.EXIT_SERVER_REFUSED, status=404)
        doc = self.pull()
        self.assertEqual((doc["result"], doc["exit_code"]), ("partial", 20))
        self.assertEqual(self.decisions_of(doc), [])
        self.assertEqual(self.rows()[0][0], "parked")

    def test_a_cloud_object_with_no_decision_methods_is_fine(self):
        e = self.env
        for name in ("reconcile_decisions", "decision_applied"):
            setattr(type(e.cloud), name + "_off", getattr(type(e.cloud), name))
        saved = {n: getattr(S.FakeCloud, n) for n in ("reconcile_decisions", "decision_applied")}
        try:
            for n in saved:
                delattr(S.FakeCloud, n)
            doc = self.pull()
        finally:
            for n, fn in saved.items():
                setattr(S.FakeCloud, n, fn)
        self.assertEqual((doc["result"], doc["exit_code"]), ("partial", 20))

    def test_a_failed_receipt_does_not_fail_the_pull(self):
        e = self.env
        self.decide("keep_cloud")

        def boom(cid, outcome):
            raise transport.TransportError("unavailable", consts.EXIT_TEMPORARY, status=503)

        e.cloud.decision_applied = boom
        doc = self.pull()
        self.assertEqual((doc["result"], doc["exit_code"]), ("ok", 0))
        self.assertEqual(self.text(), "The website's wording.")

    def test_garbage_in_the_answer_is_ignored(self):
        e = self.env
        e.cloud.reconcile_decisions = lambda observed, dry=False: {"apply": ["x", {"id": 3}, {"id": "i" * 26, "decision": "manual"},
                                                                    {"id": "j" * 26, "decision": "keep_cloud", "class": "Note"}], "reopened": [None]}
        doc = self.pull()
        self.assertEqual((doc["result"], doc["exit_code"]), ("partial", 20))
        self.assertEqual(self.decisions_of(doc), [])
        e.cloud.reconcile_decisions = lambda observed, dry=False: ["not", "a", "dict"]
        self.assertEqual(self.pull()["exit_code"], 20)

    def test_a_whole_object_conflict_is_not_decided_from_the_web(self):
        e = self.env
        d = e.cloud.decide("Note", self.handle, [{"path": "", "cloud": copy.deepcopy(e.cloud.heads[self.handle]["obj"])}], "keep_cloud")
        before = self.text()
        doc = self.pull()
        self.assertEqual(self.text(), before)
        self.assertEqual([x["status"] for x in self.decisions_of(doc)], ["moot"], "no desktop conflict is at that path, so nothing here to apply")
        self.assertEqual(e.cloud.receipts, [(d["id"], "moot")])

    def test_the_sidecar_report_and_preview_hold_ids_and_words_only(self):
        e = self.env
        self.decide("keep_cloud", cloud_value_hash=None)
        doc = self.pull()
        blob = json.dumps(self.decisions_of(doc)) + json.dumps(self.meta("web_decisions"))
        self.assertNotIn("wording", blob)
        self.assertNotIn("StyledText", blob)


if __name__ == "__main__":
    unittest.main()
