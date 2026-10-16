"""Review fixes for the pull (HFY-TSK-205): hostile media handles, a transitive deferral, pre-pull rows of a pull that never committed,
dependants of an object withheld for privacy, the private snapshot cache, the plan hash after a deferral, and the pieces `addon-push`
consumes (`plan.sendable`, `plan.incident_offer`, `sidecar.open_incidents`).

Fake tree, fake cloud, the synthetic fixture; every name and date is fictional.
"""
import copy
import gzip
import hashlib
import os
import stat
import tempfile
import unittest

import addon_pull_support as S
from hfygramps.addon import consts, media, plan as plan_mod, pull, sidecar, snapshot, transport

from test_addon_media import JPEG, new_media
from test_addon_pull import by_gid, load_cloud_objs, set_text
from test_addon_pull_safety import fault

HOSTILE = ("../escaped", "..", "a/b", "a\\b", "a.b", "", "x" * 65, "a b", "%2e%2e", "a\x00b", "é")


class HostileHandles(S.PullCase):
    def raw(self, heads):
        return S.snapshot_bytes(S.CLOUD_TREE, 1, heads)[0]

    def test_the_snapshot_parser_refuses_a_handle_that_could_name_a_path_or_a_url(self):
        for bad in HOSTILE:
            m = copy.deepcopy(new_media(self.env))
            m["handle"] = bad
            head = {"class": "Media", "handle": bad, "gramps_id": "O8001", "version": 1, "seq": 1, "deleted": False, "obj": m}
            with self.assertRaises(snapshot.SnapshotError, msg=repr(bad)) as ctx:
                snapshot.parse(self.raw([head]), tree_id=S.CLOUD_TREE, schema=21)
            self.assertEqual(ctx.exception.code, "snapshot_invalid")

    def test_a_real_handle_shape_is_accepted(self):
        for good in ("f" * 28, "a1B2_c3-d4", "x" * 64):
            self.assertTrue(snapshot._HANDLE.match(good))

    def test_download_refuses_a_hostile_handle_before_any_request_and_writes_nothing_outside_the_media_folder(self):
        root = tempfile.mkdtemp(prefix="hfy-media-root-")
        self.addCleanup(__import__("shutil").rmtree, root, True)
        media_root = os.path.join(root, "media")
        cloud = self.env.cloud
        cloud.blobs["../escaped"] = {"bytes": JPEG, "content_type": "image/jpeg"}
        for bad in HOSTILE:
            before = list(cloud.calls)
            with self.assertRaises(ValueError, msg=repr(bad)):
                media.download(cloud, bad, media_root)
            self.assertEqual(cloud.calls, before, "no request is made for it")
        self.assertEqual(sorted(os.listdir(root)), [], "nothing was created, least of all outside the media folder")

    def test_safe_path_refuses_a_symlink_planted_at_the_target(self):
        root = tempfile.mkdtemp(prefix="hfy-media-root-")
        self.addCleanup(__import__("shutil").rmtree, root, True)
        media_root = os.path.join(root, "media")
        os.makedirs(media_root)
        outside = os.path.join(root, "outside.jpg")
        os.symlink(outside, os.path.join(media_root, "h1.jpg"))
        with self.assertRaises(ValueError):
            media.safe_path(media_root, "h1", ".jpg")
        self.assertEqual(media.safe_path(media_root, "h2", ".jpg"), os.path.join(media_root, "h2.jpg"))

    def test_the_cloud_quotes_the_handle_in_the_download_url(self):
        seen = []

        class Client:
            def post(self, path, body):
                seen.append(path)
                return type("R", (), {"body": {"url": "https://files.example.org/x"}})()

        pull.Cloud(Client(), None).media_download("a/b?c#d")
        self.assertEqual(seen, ["/api/sync/media/a%2Fb%3Fc%23d/download"])


class TransitiveDeferral(S.PullCase):
    def chain(self):
        """A new Media with a bad checksum, a new Event that shows it, and a new Person that has the event."""
        e = self.env
        objs = load_cloud_objs(e)
        m = new_media(e)
        e.cloud.blobs[m["handle"]] = {"bytes": JPEG, "content_type": "image/jpeg", "sha256": "0" * 64}
        e.cloud.put(m)
        ev = copy.deepcopy(by_gid(objs, "E0002"))
        ev.update(handle="e" * 28, gramps_id="E8101")
        ev["media_list"] = [dict(by_gid(objs, "I0014")["media_list"][0], ref=m["handle"])]
        e.cloud.put(ev)
        person = copy.deepcopy(by_gid(objs, "I0014"))
        person.update(handle="d" * 28, gramps_id="I8101", family_list=[], media_list=[])
        person["event_ref_list"] = [dict(person["event_ref_list"][0], ref=ev["handle"])]
        e.cloud.put(person)
        return m, ev, person

    def test_a_failed_media_file_takes_its_new_dependants_with_it_and_the_pull_is_not_refused(self):
        e = self.env
        m, ev, person = self.chain()
        note = copy.deepcopy(by_gid(load_cloud_objs(e), "N0001"))
        note["format"] = 1
        e.cloud.put(note)
        before = e.tree.objects()
        doc = e.run("pull", yes=True)
        self.assertEqual((doc["result"], doc["exit_code"]), ("partial", 20), doc["error"])
        self.assertEqual(doc["error"]["code"], "blocked", "held back, not refused for a dangling reference")
        after = e.tree.objects()
        for h in (m["handle"], ev["handle"], person["handle"]):
            self.assertNotIn(h, after)
        self.assertEqual(after[note["handle"]]["format"], 1, "the rest of the plan still applies")
        self.assertEqual(len(e.tree.undo), 1)  # the settle run applied nothing
        self.assertEqual(doc["counts"]["blocked"], 3)
        self.assertEqual(sorted(d["handle"] for d in e.preview(doc)["deferred"]), sorted([m["handle"], ev["handle"], person["handle"]]))
        self.assertEqual({h: o for h, o in after.items() if h != note["handle"]}, {h: o for h, o in before.items() if h != note["handle"]})
        # the file arrives: the next run applies all three in one transaction
        e.cloud.blobs[m["handle"]]["sha256"] = None
        done = e.run("pull", yes=True)
        self.assertEqual((done["result"], done["counts"]["pulled"]["create"]), ("ok", 3))
        self.assertEqual(len(e.tree.undo), 2)

    def test_a_new_object_that_refers_to_an_existing_one_is_not_dropped_with_it(self):
        # the chain only passes through objects the tree does not have: an existing object that waits does not take its dependants along
        plan = {"a": {"x": ["m1"]}, "b": {"y": "a"}, "c": {"z": "existing"}, "d": {"w": "b"}}
        self.assertEqual(plan_mod.drop_dependants(plan, {"m1"}, {"existing"}), {"a", "b", "d"})
        self.assertEqual(plan_mod.drop_dependants(plan, {"existing"}, {"existing"}), {"c"})
        self.assertEqual(plan_mod.drop_dependants({"a": {"x": "existing"}, "b": {"y": "a"}}, {"m1"}, {"existing"}), set())

    def test_the_plan_hash_and_the_preview_describe_the_plan_that_is_applied(self):
        e = self.env
        self.chain()
        pre = e.preview(e.run("check"))
        doc = e.run("pull", yes=True)
        post = e.preview(doc)
        self.assertEqual(pre["deferred"], [])
        self.assertEqual(len(post["deferred"]), 3)
        self.assertNotEqual(pre["plan_hash"], post["plan_hash"], "the hash is that of the plan after the deferral")
        self.assertEqual(post["media_to_download"], [], "the failed file is not listed as still to download")


class PendingRows(S.PullCase):
    def pulled_rows(self):
        con = self.env.side()
        try:
            return con.execute("SELECT run_n, handle FROM pulled ORDER BY run_n, handle").fetchall()
        finally:
            con.close()

    def website_edit(self):
        note = copy.deepcopy(by_gid(load_cloud_objs(self.env), "N0004"))
        set_text(note, "Edited on the website.")
        self.env.cloud.put(note)
        return note["handle"]

    def test_a_pull_that_ends_without_committing_leaves_no_history_behind(self):
        e = self.env
        self.website_edit()
        for step in ("mid_apply", "after_backup"):
            doc = e.run("pull", yes=True, services=fault(step))
            self.assertEqual(doc["result"], "failed", step)
            self.assertEqual(self.pulled_rows(), [], step)

    def test_an_aborted_transaction_leaves_no_history_behind(self):
        e = self.env
        self.website_edit()

        class Corrupting(type(e.tree)):
            def apply(self, label, commits, removals, **kw):
                person = by_gid(self.objects(), "I0001")
                person["family_list"] = []
                commits = dict(commits)
                commits[person["handle"]] = person
                return super().apply(label, commits, removals, **kw)

        e.tree.__class__ = Corrupting
        doc = e.run("pull", yes=True)
        self.assertEqual(doc["error"]["code"], "integrity")
        self.assertEqual(self.pulled_rows(), [])

    def test_a_crash_between_the_commit_and_the_sidecar_keeps_the_rows(self):
        e = self.env
        h = self.website_edit()
        doc = e.run("pull", yes=True, services=fault("after_commit"))
        self.assertEqual(doc["result"], "failed")
        self.assertEqual(self.pulled_rows(), [(1, h)])

    def test_a_row_of_an_earlier_attempt_is_replaced_not_kept_for_the_same_object(self):
        e = self.env
        h = self.website_edit()
        con = e.side()
        try:
            with con:
                con.execute("INSERT INTO pulled (run_n, class, handle, kind, prepull_json, at) VALUES (1, 'Note', ?, 'update', '{\"stale\": true}', 'x')", (h,))
        finally:
            con.close()
        self.assertEqual(e.run("pull", yes=True)["result"], "ok")
        con = e.side()
        try:
            (js,) = con.execute("SELECT prepull_json FROM pulled WHERE handle = ?", (h,)).fetchone()
        finally:
            con.close()
        self.assertNotIn("stale", js)


class WithheldDependants(S.PullCase):
    def withheld_note(self):
        note = copy.deepcopy(by_gid(load_cloud_objs(self.env), "N0004"))
        note.update(handle="b" * 28, gramps_id="N8102")
        set_text(note, "She was born on 14 February 1840 in the old house.")
        return note

    def test_a_pulled_object_that_points_at_a_withheld_one_waits_and_the_pull_still_applies_the_rest(self):
        e = self.env
        objs = load_cloud_objs(e)
        note = self.withheld_note()
        e.cloud.put(note)
        ev = copy.deepcopy(by_gid(objs, "E0002"))
        ev.update(handle="e" * 28, gramps_id="E8102", note_list=[note["handle"]])
        e.cloud.put(ev)
        person = copy.deepcopy(by_gid(objs, "I0014"))
        person.update(handle="d" * 28, gramps_id="I8102", family_list=[], media_list=[])
        person["event_ref_list"] = [dict(person["event_ref_list"][0], ref=ev["handle"])]
        e.cloud.put(person)
        other = copy.deepcopy(by_gid(objs, "N0001"))
        other["format"] = 1
        e.cloud.put(other)
        doc = e.run("pull", yes=True)
        self.assertEqual((doc["result"], doc["exit_code"], doc["next_action"]), ("partial", 20, "review_incidents"), doc["error"])
        self.assertEqual(doc["counts"]["privacy_incidents"], 1)
        self.assertEqual(doc["counts"]["blocked"], 2)
        after = e.tree.objects()
        for h in (note["handle"], ev["handle"], person["handle"]):
            self.assertNotIn(h, after)
        self.assertEqual(after[other["handle"]]["format"], 1)
        pv = e.preview(doc)
        self.assertEqual(sorted(d["handle"] for d in pv["deferred"]), sorted([ev["handle"], person["handle"]]))
        self.assertEqual([i["handle"] for i in pv["incidents"]], [note["handle"]], "only the object that shows the date is an incident")
        # nothing about the withheld chain reached the base: it is retried every run until the website scrubs the note
        con = e.side()
        try:
            n = con.execute("SELECT COUNT(*) FROM base WHERE handle IN (?, ?, ?)", (note["handle"], ev["handle"], person["handle"])).fetchone()[0]
        finally:
            con.close()
        self.assertEqual(n, 0)
        again = e.run("pull", yes=True)
        self.assertEqual((again["result"], again["counts"]["blocked"]), ("partial", 2))

    def test_the_incident_offer_is_one_the_push_can_build_from_the_sidecar(self):
        e = self.env
        note = self.withheld_note()
        e.cloud.put(note)
        doc = e.run("pull", yes=True)
        offer = e.preview(doc)["incidents"][0]["offer"]
        con = e.side()
        try:
            rows = sidecar.open_incidents(con)
        finally:
            con.close()
        self.assertEqual([plan_mod.incident_offer(r["class"], r["handle"]) for r in rows], [offer])
        self.assertEqual(rows[0]["rule"], "scan.dob_exact")


class SnapshotCache(S.PullCase):
    def test_the_cached_snapshot_is_private_whatever_the_umask_and_an_existing_folder_is_tightened(self):
        e = self.env
        os.makedirs(e.tp.cache, exist_ok=True)
        os.chmod(e.tp.cache, 0o755)
        for name in os.listdir(e.tp.cache):
            os.unlink(os.path.join(e.tp.cache, name))
        note = copy.deepcopy(by_gid(load_cloud_objs(e), "N0001"))
        note["format"] = 1
        e.cloud.put(note)
        old = os.umask(0)
        try:
            self.assertEqual(e.run("pull", yes=True)["result"], "ok")
        finally:
            os.umask(old)
        self.assertEqual(stat.S_IMODE(os.stat(e.tp.cache).st_mode), 0o700)
        files = os.listdir(e.tp.cache)
        self.assertTrue(files)
        for f in files:
            self.assertEqual(stat.S_IMODE(os.stat(os.path.join(e.tp.cache, f)).st_mode), 0o600, f)


class PushGate(unittest.TestCase):
    def test_a_confirm_op_is_not_sendable_without_the_confirmation_and_a_parked_one_never_is(self):
        send, confirm, parked = {"disposition": "send"}, {"disposition": "confirm"}, {"disposition": "parked"}
        self.assertTrue(plan_mod.sendable(send))
        self.assertFalse(plan_mod.sendable(confirm))
        self.assertFalse(plan_mod.sendable(confirm, confirmed=False))
        self.assertTrue(plan_mod.sendable(confirm, confirmed=True))
        self.assertFalse(plan_mod.sendable(parked))
        self.assertFalse(plan_mod.sendable(parked, confirmed=True))
        self.assertFalse(plan_mod.sendable({}))


if __name__ == "__main__":
    unittest.main()
