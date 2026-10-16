"""The change feed end to end (HFY-TSK-277, ARCH-B): the installed addon, the real Gramps CLI and the sync dev server with SYNC#HEAD.changes_feed on.

    delta       after one snapshot pull, the next pulls fetch only /api/sync/changes (no /api/sync/snapshot call) and apply the website's edits
    identical   a delta pull and a snapshot pull of the same cloud state give the same preview, plan hash and snapshot digest (AC3), and the state a
                delta leaves in the cache hashes to the digest the website's snapshot route reports for that seq
    expunge     a scrub in place moves SYNC#HEAD.expunge_epoch but not seq: the cached state is discarded and the pull falls back to a snapshot
    verify      six delta syncs, then the 7th downloads a full snapshot and checks the replay against it
    off         with the switch off the route answers 404 and the addon never calls it

The run log and status.json carry codes and counts only. Fictional data only.
"""
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import e2e_case as C  # noqa: E402
import e2e_support as E  # noqa: E402,F401
from hfygramps.addon import transport  # noqa: E402
from scenario_pull import PullE2E, set_text  # noqa: E402,F401


class FeedE2E(PullE2E):
    def feed_on(self, on=True):
        self.server.set_head(changes_feed=on)

    def calls(self, path):
        return len(self.server.requests(method="GET", path=path))

    def run_log(self, doc):
        with open(os.path.join(C.S.tree_paths(self.dbid)["logs"], "%s.log" % doc["run_id"]), encoding="utf-8") as fh:
            return fh.read()

    def cache_state(self):
        with open(os.path.join(C.S.tree_paths(self.dbid)["dir"], "cache", "cloud-state.json"), encoding="utf-8") as fh:
            return json.load(fh)

    def pull_ok(self, *args):
        proc, doc = self.hfy(*(args or ("pull", "--yes")))
        self.assertEqual((proc.returncode, doc["result"]), (0, "ok"), proc.stdout + proc.stderr + json.dumps(doc["error"]))
        return doc

    def start(self):
        self.bring_up()
        self.feed_on()
        first = self.pull_ok()  # nothing cached yet: a snapshot, which leaves the cache
        self.assertEqual(first["cloud"]["via"], "snapshot")
        self.assertIn("delta fallback: no_cache", self.run_log(first))
        return first


class Delta(FeedE2E):
    def test_the_next_pulls_fetch_only_the_changes(self):
        self.start()
        self.website_edit_note("N0004", "Edited on the website.")  # (the driver reads a snapshot to make its edit: count after it)
        snapshots, changes = self.calls("/api/sync/snapshot"), self.calls("/api/sync/changes")
        doc = self.pull_ok()
        self.assertEqual(doc["cloud"]["via"], "delta")
        self.assertEqual(self.calls("/api/sync/snapshot"), snapshots, "the addon asked for no snapshot")
        self.assertEqual(self.calls("/api/sync/changes"), changes + 1)
        self.assertEqual(doc["counts"]["pulled"], {"create": 0, "update": 1, "delete": 0})
        self.assertEqual(self.local_note_text(), "Edited on the website.")
        self.assertNotIn("Edited on the website.", json.dumps(doc) + self.run_log(doc), "no object content in the status or the log")
        again = self.pull_ok()
        self.assertEqual((again["cloud"]["via"], again["counts"]["pulled"]), ("delta", {"create": 0, "update": 0, "delete": 0}))

    def test_a_delta_pull_and_a_snapshot_pull_of_the_same_cloud_give_the_same_plan(self):
        self.start()
        self.website_edit_note("N0004", "Edited on the website.")
        self.cloud.edit("N0001", lambda o: o.update(format=1))
        self.local_edit_note("N0004", "Edited on the desktop, too.")
        self.opened_once()
        proc, by_delta = self.hfy("check")
        self.assertEqual((proc.returncode, by_delta["cloud"]["via"]), (10, "delta"), proc.stdout + proc.stderr)
        info, _header, _lines = self.cloud.snapshot()  # the website's own digest for this seq
        self.assertEqual(self.cache_state()["body_sha256"], info["body_sha256"], "the state a delta leaves hashes to the website's snapshot")
        self.assertEqual(self.cache_state()["seq"], info["seq"])
        self.feed_on(False)
        proc, by_snapshot = self.hfy("check")
        self.assertEqual(proc.returncode, 10, proc.stdout + proc.stderr)
        self.assertNotIn("via", by_snapshot["cloud"])
        a, b = self.preview(by_delta), self.preview(by_snapshot)
        for p in (a, b):
            p.pop("run_id"), p.pop("created_at")
        self.assertEqual(a, b)
        self.assertEqual(by_delta["counts"], by_snapshot["counts"])
        self.assertEqual(a["snapshot"]["body_sha256"], info["body_sha256"])

    def test_a_delete_and_a_create_on_the_website_arrive_as_deltas(self):
        self.start()
        new = json.loads(json.dumps(self.cloud.get("N0004")))
        new.update(handle="d4" * 14, gramps_id="N0900")
        set_text(new, "A note made on the website.")
        self.cloud.create(new)
        doc = self.pull_ok()
        self.assertEqual((doc["cloud"]["via"], doc["counts"]["pulled"]["create"]), ("delta", 1))
        self.assertEqual(self.local_note_text("N0900"), "A note made on the website.")
        self.cloud.delete_with([], "Note", new["handle"])
        proc, doc = self.hfy("pull", "--yes", "--allow-deletes")
        self.assertEqual((proc.returncode, doc["result"], doc["cloud"]["via"]), (0, "ok", "delta"), proc.stdout + proc.stderr + json.dumps(doc["error"]))
        self.assertEqual(doc["counts"]["pulled"]["delete"], 1)
        self.assertNotIn("N0900", [o.get("gramps_id") for o in self.local_objects().values()])


class Expunge(FeedE2E):
    def test_a_scrub_in_place_does_not_move_seq_but_discards_the_cached_state(self):
        self.start()
        note = self.cloud.get("N0004")
        set_text(note, "[removed]")
        head_before = self.cloud.snapshot()[0]["seq"]
        self.cloud.scrub(note)
        self.assertEqual(self.cloud.snapshot()[0]["seq"], head_before, "the scrub did not advance seq")
        proc, doc = self.hfy("check")
        self.assertEqual((proc.returncode, doc["cloud"]["via"]), (10, "snapshot"), proc.stdout + proc.stderr)
        self.assertIn("delta fallback: expunge_epoch", self.run_log(doc))
        self.assertEqual(self.preview(doc)["expunge_notices"][0]["paths"], ["/text/string"], "the scrub still reaches the addon as an expunge notice")
        self.assertEqual(self.cache_state()["expunge_epoch"], 1)
        nxt = self.pull_ok()
        self.assertEqual(nxt["cloud"]["via"], "delta", "the cache the fallback left carries epoch 1, so deltas work again")


class Verify(FeedE2E):
    def test_the_seventh_sync_downloads_a_full_snapshot_and_verifies_the_replay(self):
        self.start()
        vias = []
        for i in range(8):
            self.website_edit_note("N0004", "Edit number %d." % (i + 1))
            doc = self.pull_ok()
            vias.append(doc["cloud"]["via"])
            if doc["cloud"]["via"] == "snapshot":
                self.assertIn("delta verify ok", self.run_log(doc))
        self.assertEqual(vias, ["delta"] * 6 + ["snapshot", "delta"])
        self.assertEqual(self.local_note_text(), "Edit number 8.")


class Off(FeedE2E):
    def test_with_the_switch_off_the_route_is_dark_and_the_addon_never_calls_it(self):
        self.bring_up()
        doc = self.pull_ok()
        self.website_edit_note("N0004", "Edited on the website.")
        doc = self.pull_ok()
        self.assertNotIn("via", doc["cloud"])
        self.assertEqual(self.calls("/api/sync/changes"), 0)
        with self.assertRaises(transport.TransportError) as refused:
            self.cloud.client.get("/api/sync/changes", query={"since": 0})
        self.assertEqual((refused.exception.status, refused.exception.code), (404, "not_enabled"))
        meta = self.cloud.client.get("/api/sync/meta").body
        self.assertEqual((meta["changes_feed"], meta["expunge_epoch"]), (False, 0))
        self.feed_on()
        feed = self.cloud.client.get("/api/sync/changes", query={"since": 0, "limit": 5}).body
        self.assertEqual((feed["dense"], [o["seq"] for o in feed["ops"]]), (True, [1, 2, 3, 4, 5]))
        with self.assertRaises(transport.TransportError) as ahead:
            self.cloud.client.get("/api/sync/changes", query={"since": feed["head_seq"] + 1})
        self.assertEqual((ahead.exception.status, ahead.exception.code), (400, "bad_cursor"))


if __name__ == "__main__":
    unittest.main()
