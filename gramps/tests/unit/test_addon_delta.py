"""The delta pull (HFY-TSK-277, ARCH-B): the cloud state from a cached state plus the change feed, on the synthetic fixture.

A FeedCloud is the website's side with a dense change log beside its heads, serving `changes()` the way api/src/sync/changes.js does. The
tests prove the acceptance criteria that live in the addon: deltas are applied to the cached state; any gap, hash mismatch, version skip,
expunged op, changed expunge epoch, refused cursor (400, 404, 410) or damaged cache falls back to a full snapshot; every 7th sync is verified
against a full snapshot; and a delta pull and a snapshot pull of the same cloud state give the same plan (the preview files are equal).
Every value is fictional.
"""
import copy
import json
import os
import unittest
from unittest import mock

import addon_pull_support as S
from hfygramps import canonical
from hfygramps.addon import consts, delta, snapshot, transport


def by_gid(objects, gid):
    return next(o for o in objects.values() if o.get("gramps_id") == gid)


def set_text(note, text):
    note["text"]["string"] = text


def server_snapshot_bytes(tree_id, seq, heads):
    """S.snapshot_bytes with the order the website writes (api/src/sync/store.js CLASSES), which the real snapshot route uses."""
    rank = {c: i for i, c in enumerate(delta.SERVER_CLASS_ORDER)}
    saved = S.CLASS_RANK
    S.CLASS_RANK = rank
    try:
        return S.snapshot_bytes(tree_id, seq, heads)
    finally:
        S.CLASS_RANK = saved


class FeedCloud(S.FakeCloud):
    """A FakeCloud that also keeps the change log: every put and tombstone appends the op the website's feed would return."""

    def __init__(self, dbid="fixturetree", **kw):
        S.FakeCloud.__init__(self, dbid, **kw)
        self.log = []
        self.epoch = 0
        self.feed_on = True
        self.change_calls = []
        self.changes_error = None
        self.page_limit = None

    def seed(self, projected):
        """Every head gets its own seq (the website's seed runs in batches), then a session-close marker, as a seeded store does."""
        rows = sorted(projected.values(), key=lambda o: (S.CLASS_RANK[o["_class"]], o["handle"]))
        self.heads, self.log, self.seq = {}, [], 0
        for o in rows:
            self.put(o)
        self.marker()

    def marker(self):
        self.seq += 1
        self.log.append({"seq": self.seq, "op": "marker", "class": None, "handle": None, "gramps_id": "", "version": None, "hash": None,
                         "obj": None, "at": "2026-10-14T12:00:00.000Z", "origin": "desktop"})

    def put(self, obj, version=None, seq=None):
        cur = self.heads.get(obj["handle"])
        S.FakeCloud.put(self, obj, version, seq)
        h = self.heads[obj["handle"]]
        self.log.append({"seq": h["seq"], "op": "update" if cur is not None and not cur["deleted"] else "create", "class": h["class"], "handle": h["handle"],
                         "gramps_id": h["gramps_id"], "version": h["version"], "hash": canonical.object_hash(obj), "obj": copy.deepcopy(obj),
                         "at": "2026-10-14T12:00:00.000Z", "origin": "desktop"})

    def tombstone(self, handle):
        S.FakeCloud.tombstone(self, handle)
        h = self.heads[handle]
        self.log.append({"seq": h["seq"], "op": "delete", "class": h["class"], "handle": handle, "gramps_id": h["gramps_id"], "version": h["version"],
                         "hash": None, "obj": None, "at": "2026-10-14T12:00:00.000Z", "origin": "desktop"})

    def snapshot_info(self):
        self.calls.append("snapshot")
        raw, sha, count = server_snapshot_bytes(self.tree_id, self.seq, list(self.heads.values()))
        key = "snap-%d-%s" % (self.seq, sha[:8])
        self._files[key] = raw
        return {"seq": self.seq, "url": "https://files.example.org/%s" % key, "body_sha256": sha, "count": count}

    def meta(self):
        body = S.FakeCloud.meta(self)
        body.update({"changes_feed": self.feed_on, "expunge_epoch": self.epoch})
        return body

    def changes(self, since, limit):
        self.calls.append("changes")
        self.change_calls.append(since)
        if self.changes_error is not None:
            raise self.changes_error
        if since > self.seq:
            raise transport.TransportError("bad_cursor", consts.EXIT_SERVER_REFUSED, status=400)
        last = min(since + min(limit, self.page_limit or limit), self.seq)
        ops = [copy.deepcopy(o) for o in self.log if since < o["seq"] <= last]
        return {"ops": ops, "head_seq": self.seq, "next_since": ops[-1]["seq"] if ops else since, "dense": True, "expunge_epoch": self.epoch}


class FeedEnv(S.Env):
    def seed_cloud(self):
        self.cloud = FeedCloud(self.tree.dbid)
        self.cloud.seed(S.project_all(self.tree.objects()))

    def log_text(self, doc):
        with open(os.path.join(self.tp.logs, "%s.log" % doc["run_id"]), encoding="utf-8") as fh:
            return fh.read()

    def state(self):
        with open(delta.state_path(self.tp), encoding="utf-8") as fh:
            return json.load(fh)


def edit_site(cloud, gid, text):
    note = copy.deepcopy(by_gid({h: v["obj"] for h, v in cloud.heads.items() if not v["deleted"]}, gid))
    set_text(note, text)
    cloud.put(note)


class DeltaCase(unittest.TestCase):
    def setUp(self):
        self.env = FeedEnv(self)
        self.cloud = self.env.cloud

    def first_sync(self):
        doc = self.env.run("pull", yes=True)
        self.assertEqual((doc["result"], doc["exit_code"]), ("ok", 0), doc)
        return doc

    def synced(self):
        """A bound tree that has pulled once (by snapshot: nothing cached yet) with the feed on."""
        doc = self.first_sync()
        self.assertEqual(doc["cloud"]["via"], "snapshot")
        return doc


class Deltas(DeltaCase):
    def test_the_first_pull_has_no_cache_so_it_takes_a_snapshot_and_leaves_one(self):
        doc = self.first_sync()
        self.assertEqual(doc["cloud"], {"head_seq": self.cloud.seq, "snapshot_seq": self.cloud.seq, "via": "snapshot"})
        self.assertIn("delta fallback: no_cache", self.env.log_text(doc))
        self.assertEqual(self.cloud.change_calls, [])
        st = self.env.state()
        self.assertEqual((st["seq"], st["streak"], st["expunge_epoch"]), (self.cloud.seq, 0, 0))
        self.assertTrue(os.path.exists(delta.cache_file(self.env.tp, self.cloud.seq)))

    def test_the_next_pull_applies_only_the_new_ops_to_the_cached_state(self):
        self.synced()
        edit_site(self.cloud, "N0004", "A plain note, edited on the website.")
        fresh = copy.deepcopy(by_gid({h: v["obj"] for h, v in self.cloud.heads.items()}, "N0004"))
        fresh.update(handle="d4" * 14, gramps_id="N8001")
        set_text(fresh, "A note made on the website.")
        self.cloud.put(fresh)
        self.cloud.marker()
        self.cloud.calls.clear()
        before = self.cloud.seq
        doc = self.env.run("pull", yes=True, allow_deletes=True)
        self.assertEqual((doc["result"], doc["exit_code"]), ("ok", 0), doc)
        self.assertEqual(doc["cloud"], {"head_seq": self.cloud.seq, "snapshot_seq": self.cloud.seq, "via": "delta"})
        self.assertNotIn("snapshot", self.cloud.calls)
        self.assertNotIn("fetch", self.cloud.calls)
        self.assertEqual(self.cloud.change_calls, [before - 3])  # one page, from the cached seq: the edit, the create and the marker
        self.assertEqual(doc["counts"]["pulled"], {"create": 1, "update": 1, "delete": 0})
        self.assertEqual(by_gid(self.env.tree.objects(), "N0004")["text"]["string"], "A plain note, edited on the website.")
        self.assertEqual(by_gid(self.env.tree.objects(), "N8001")["text"]["string"], "A note made on the website.")
        self.assertEqual(self.env.state()["streak"], 1)

    def test_the_state_a_delta_leaves_hashes_to_the_snapshot_of_the_same_cloud(self):
        self.synced()
        edit_site(self.cloud, "N0004", "Edited once.")
        self.env.run("pull", yes=True)
        edit_site(self.cloud, "N0004", "Edited twice.")
        self.cloud.tombstone(by_gid({h: v["obj"] for h, v in self.cloud.heads.items() if not v["deleted"]}, "N0001")["handle"])
        doc = self.env.run("pull", yes=True, allow_deletes=True)
        self.assertEqual(doc["cloud"]["via"], "delta")
        _raw, sha, count = server_snapshot_bytes(S.CLOUD_TREE, self.cloud.seq, list(self.cloud.heads.values()))
        st = self.env.state()
        self.assertEqual((st["body_sha256"], st["seq"]), (sha, self.cloud.seq))
        with open(delta.cache_file(self.env.tp, st["seq"]), "rb") as fh:
            snap = snapshot.parse(fh.read(), tree_id=S.CLOUD_TREE, schema=21)
        self.assertEqual((snap.body_sha256, snap.header["count"]), (sha, count))

    def test_a_check_uses_the_feed_too_and_changes_nothing_but_the_cache(self):
        self.synced()
        edit_site(self.cloud, "N0004", "Edited on the website.")
        base = self.env.base_dump()
        objects = self.env.tree.objects()
        doc = self.env.run("check")
        self.assertEqual((doc["result"], doc["cloud"]["via"]), ("changes_pending", "delta"))
        self.assertEqual((self.env.base_dump(), self.env.tree.objects()), (base, objects))

    def test_pages_are_followed_until_the_head(self):
        self.synced()
        for i in range(5):
            edit_site(self.cloud, "N0004", "Edited %d times." % (i + 1))
        self.cloud.page_limit = 2
        start = self.cloud.seq - 5
        doc = self.env.run("pull", yes=True)
        self.assertEqual(doc["cloud"]["via"], "delta")
        self.assertEqual(self.cloud.change_calls, [start, start + 2, start + 4])
        self.assertEqual(by_gid(self.env.tree.objects(), "N0004")["text"]["string"], "Edited 5 times.")

    def test_nothing_new_asks_the_feed_nothing(self):
        self.synced()
        doc = self.env.run("pull", yes=True)
        self.assertEqual((doc["result"], doc["cloud"]["via"]), ("ok", "delta"))
        self.assertEqual(self.cloud.change_calls, [])

    def test_a_delta_pull_and_a_snapshot_pull_of_the_same_cloud_give_the_same_preview(self):
        other = FeedEnv(self)
        self.synced()
        doc = other.run("pull", yes=True)
        self.assertEqual(doc["cloud"]["via"], "snapshot")
        other.cloud.feed_on = False  # this one always takes the full snapshot
        for env in (self.env, other):
            c = env.cloud
            edit_site(c, "N0004", "A plain note, edited on the website.")
            c.marker()
            objs = {h: v["obj"] for h, v in c.heads.items() if not v["deleted"]}
            person = copy.deepcopy(by_gid(objs, "I0002"))
            person["primary_name"]["nick"] = "Birdie"
            c.put(person)
            c.tombstone(by_gid(objs, "N0001")["handle"])
            env.tree.edit(by_gid(env.tree.objects(), "I0003")["handle"], lambda o: o["primary_name"].update(nick="Skip"))
        a = self.env.run("check")
        b = other.run("check")
        self.assertEqual((a["cloud"]["via"], b["cloud"].get("via")), ("delta", None))  # the other never offered the feed
        pa, pb = self.env.preview(a), other.preview(b)
        for p in (pa, pb):
            p.pop("run_id"), p.pop("created_at")
        self.assertEqual(pa, pb)
        self.assertEqual(a["counts"], b["counts"])
        self.assertTrue(pa["plan_hash"])
        self.assertGreater(pa["counts"]["pulled"]["update"] + pa["counts"]["pulled"]["delete"], 1)
        # and applying both gives the same trees and the same base
        da = self.env.run("pull", yes=True, allow_deletes=True)
        db = other.run("pull", yes=True, allow_deletes=True)
        self.assertEqual((da["cloud"]["via"], db["cloud"].get("via")), ("delta", None))
        self.assertEqual(self.env.tree.objects(), other.tree.objects())
        self.assertEqual(self.env.base_dump(), other.base_dump())


class Switches(DeltaCase):
    def test_the_website_switch_off_means_snapshots_only_and_no_via(self):
        self.cloud.feed_on = False
        doc = self.first_sync()
        edit_site(self.cloud, "N0004", "Edited.")
        doc = self.env.run("pull", yes=True)
        self.assertEqual(doc["cloud"], {"head_seq": self.cloud.seq, "snapshot_seq": self.cloud.seq})
        self.assertEqual(self.cloud.change_calls, [])

    def test_config_false_opts_out_even_when_the_website_offers_the_feed(self):
        self.synced()
        cfg = dict(self.env.config, changes_feed=False)
        from hfygramps.addon import paths
        paths.atomic_write_json(self.env.tp.config, cfg)
        edit_site(self.cloud, "N0004", "Edited.")
        doc = self.env.run("pull", yes=True)
        self.assertEqual((doc["result"], self.cloud.change_calls), ("ok", []))
        self.assertNotIn("via", doc["cloud"])

    def test_a_cloud_without_a_changes_method_never_tries_the_feed(self):
        plain = S.FakeCloud(self.env.tree.dbid, heads=self.cloud.heads, seq=self.cloud.seq)
        plain.meta = lambda: dict(FeedCloud.meta(self.cloud))
        doc = self.env.run("pull", yes=True, services={"cloud": plain})
        self.assertEqual((doc["result"], doc["exit_code"]), ("ok", 0))


class Fallbacks(DeltaCase):
    """Every doubt costs a snapshot, never a wrong state; each reason is a word in the run log."""

    def synced_then_edited(self):
        self.synced()
        edit_site(self.cloud, "N0004", "Edited on the website.")

    def assert_falls_back(self, code):
        doc = self.env.run("pull", yes=True)
        self.assertEqual((doc["result"], doc["exit_code"]), ("ok", 0), doc)
        self.assertEqual(doc["cloud"]["via"], "snapshot")
        self.assertIn("delta fallback: %s" % code, self.env.log_text(doc))
        self.assertEqual(by_gid(self.env.tree.objects(), "N0004")["text"]["string"], "Edited on the website.")  # the snapshot carried the edit
        self.assertEqual(self.env.state()["streak"], 0)
        self.assertEqual(self.env.state()["seq"], self.cloud.seq)
        return doc

    def test_a_gap_in_the_seqs(self):
        self.synced_then_edited()
        edit_site(self.cloud, "N0004", "Edited on the website.")
        del self.cloud.log[-2]  # a hole: the feed would never do this, the replay must notice
        self.assert_falls_back("gap")

    def test_a_marker_where_the_seq_should_be_is_not_a_hole_but_a_missing_op_is(self):
        self.synced_then_edited()
        self.cloud.marker()
        self.cloud.log.pop(-2)
        self.assert_falls_back("gap")

    def test_an_object_that_does_not_hash_to_its_op(self):
        self.synced_then_edited()
        self.cloud.log[-1]["hash"] = "0" * 64
        self.assert_falls_back("hash_mismatch")

    def test_a_version_that_does_not_follow_the_cached_head(self):
        self.synced_then_edited()
        self.cloud.log[-1]["version"] += 1
        self.assert_falls_back("gap")

    def test_an_update_to_a_handle_the_cache_does_not_hold(self):
        self.synced_then_edited()
        self.cloud.log[-1]["handle"] = "ab" * 14
        self.cloud.log[-1]["obj"]["handle"] = "ab" * 14
        self.assert_falls_back("gap")

    def test_an_expunged_op_leaves_no_object_so_the_cache_cannot_be_trusted(self):
        self.synced_then_edited()
        self.cloud.log[-1].update(obj=None, hash=None, expunged=True)
        self.assert_falls_back("expunged")

    def test_a_changed_expunge_epoch_discards_the_cache_before_the_feed_is_asked(self):
        self.synced_then_edited()
        self.cloud.epoch = 1
        self.assert_falls_back("expunge_epoch")
        self.assertEqual(self.cloud.change_calls, [])
        self.assertEqual(self.env.state()["expunge_epoch"], 1)

    def test_an_epoch_that_moves_between_pages_stops_the_replay(self):
        self.synced_then_edited()
        orig = self.cloud.changes
        def moving(since, limit):
            body = orig(since, limit)
            body["expunge_epoch"] = 5
            return body
        self.cloud.changes = moving
        self.assert_falls_back("expunge_epoch")

    def test_a_feed_that_refuses_the_cursor_410_400_or_404(self):
        for status, code, reason in ((410, "gap_too_large", "feed_gap_too_large"), (400, "bad_cursor", "feed_bad_cursor"), (404, "not_enabled", "feed_not_enabled")):
            with self.subTest(status=status):
                self.setUp()
                self.synced_then_edited()
                self.cloud.changes_error = transport.TransportError(code, consts.EXIT_SERVER_REFUSED, status=status)
                self.assert_falls_back(reason)

    def test_a_busy_or_failing_feed_falls_back_to_the_snapshot_route(self):
        for status, code in ((503, "retryable"), (500, "server"), (429, "rate_limited")):
            with self.subTest(status=status):
                self.setUp()
                self.synced_then_edited()
                self.cloud.changes_error = transport.TransportError(code, consts.EXIT_TEMPORARY, "retry", status=status)
                self.assert_falls_back("feed_unavailable")

    def test_a_sign_in_problem_on_the_feed_stops_the_run_it_is_not_a_fallback(self):
        self.synced_then_edited()
        self.cloud.changes_error = transport.TransportError("unauthorized", consts.EXIT_SIGN_IN, "login", status=401)
        doc = self.env.run("pull", yes=True)
        self.assertEqual((doc["result"], doc["exit_code"]), ("refused", consts.EXIT_SIGN_IN))

    def test_an_unwritable_state_file_does_not_fail_a_delta_run(self):
        self.synced_then_edited()
        with mock.patch.object(delta, "save_state", side_effect=OSError("disk full")):
            doc = self.env.run("pull", yes=True)
        self.assertEqual((doc["result"], doc["exit_code"]), ("ok", 0), doc)
        self.assertEqual(doc["cloud"]["via"], "delta")
        self.assertEqual(by_gid(self.env.tree.objects(), "N0004")["text"]["string"], "Edited on the website.")

    def test_an_answer_that_is_not_the_documented_shape(self):
        for bad in ({"ops": []}, {"ops": "x", "head_seq": 1, "next_since": 1, "dense": True}, {"ops": [], "head_seq": 1, "next_since": 1, "dense": False}, None, []):
            with self.subTest(bad=repr(bad)[:40]):
                self.setUp()
                self.synced_then_edited()
                self.cloud.changes = lambda since, limit, b=bad: b
                self.assert_falls_back("bad_feed")

    def test_a_feed_that_stops_short_of_its_head(self):
        self.synced_then_edited()
        edit_site(self.cloud, "N0004", "Edited on the website.")
        orig = self.cloud.changes
        def short(since, limit):
            body = orig(since, limit)
            body["ops"], body["next_since"] = [], since
            return body
        self.cloud.changes = short
        self.assert_falls_back("no_progress")

    def test_a_damaged_or_missing_cache(self):
        for damage in ("file", "state", "gone", "other_tree", "sha"):
            with self.subTest(damage=damage):
                self.setUp()
                self.synced_then_edited()
                st = self.env.state()
                if damage == "file":
                    with open(delta.cache_file(self.env.tp, st["seq"]), "wb") as fh:
                        fh.write(b"not a gzip file")
                elif damage == "state":
                    with open(delta.state_path(self.env.tp), "w", encoding="utf-8") as fh:
                        fh.write("{not json")
                elif damage == "gone":
                    os.unlink(delta.cache_file(self.env.tp, st["seq"]))
                elif damage == "other_tree":
                    st["tree_id"] = "someone-else"
                    with open(delta.state_path(self.env.tp), "w", encoding="utf-8") as fh:
                        json.dump(st, fh)
                else:
                    st["body_sha256"] = "1" * 64
                    with open(delta.state_path(self.env.tp), "w", encoding="utf-8") as fh:
                        json.dump(st, fh)
                self.assert_falls_back({"state": "cache_invalid", "other_tree": "other_tree"}.get(damage, "cache_invalid"))

    def test_a_cloud_behind_the_cache_is_the_rollback_refusal_of_the_snapshot_path(self):
        self.synced_then_edited()
        self.env.run("pull", yes=True)
        self.cloud.seq -= 3  # a restored store
        doc = self.env.run("pull", yes=True)
        self.assertEqual((doc["result"], doc["error"]["code"]), ("refused", "snapshot_older"))
        self.assertIn("delta fallback: cloud_behind", self.env.log_text(doc))


class Verification(DeltaCase):
    def run_syncs(self, n):
        docs = []
        for i in range(n):
            edit_site(self.cloud, "N0004", "Edit number %d." % (i + 1))
            docs.append(self.env.run("pull", yes=True))
            self.assertEqual((docs[-1]["result"], docs[-1]["exit_code"]), ("ok", 0), docs[-1])
        return docs

    def test_six_deltas_then_the_seventh_sync_downloads_and_verifies_a_full_snapshot(self):
        self.synced()
        docs = self.run_syncs(8)
        self.assertEqual([d["cloud"]["via"] for d in docs], ["delta"] * 6 + ["snapshot", "delta"])
        self.assertIn("delta verify ok", self.env.log_text(docs[6]))
        self.assertNotIn("delta verify", self.env.log_text(docs[5]))
        self.assertEqual(self.env.state()["streak"], 1)  # the verified sync reset the count, the next delta made it one
        self.assertEqual(by_gid(self.env.tree.objects(), "N0004")["text"]["string"], "Edit number 8.")

    def test_a_replay_that_differs_from_the_snapshot_is_logged_and_the_snapshot_wins(self):
        self.synced()
        self.run_syncs(6)
        edit_site(self.cloud, "N0004", "The true text.")
        lie = self.cloud.log[-1]
        lie["obj"] = copy.deepcopy(lie["obj"])
        set_text(lie["obj"], "A text the head never had.")
        lie["hash"] = canonical.object_hash(lie["obj"])  # a log entry that is internally consistent but is not the head
        doc = self.env.run("pull", yes=True)
        self.assertEqual((doc["result"], doc["cloud"]["via"]), ("ok", "snapshot"))
        self.assertIn("delta verify MISMATCH", self.env.log_text(doc))
        self.assertEqual(by_gid(self.env.tree.objects(), "N0004")["text"]["string"], "The true text.")
        _raw, sha, _n = server_snapshot_bytes(S.CLOUD_TREE, self.cloud.seq, list(self.cloud.heads.values()))
        self.assertEqual(self.env.state()["body_sha256"], sha)  # the cache was healed from the snapshot

    def expunge_a_note(self):
        """A whole-record privacy-expunge (HFY-TSK-204): the head is a tombstone that also says `expunged: true`, and the epoch moved."""
        fresh = copy.deepcopy(by_gid({h: v["obj"] for h, v in self.cloud.heads.items() if not v["deleted"]}, "N0004"))
        fresh.update(handle="e5" * 14, gramps_id="N8002")
        set_text(fresh, "A note the owner had expunged.")
        self.cloud.put(fresh)
        self.cloud.tombstone(fresh["handle"])
        self.cloud.heads[fresh["handle"]]["expunged"] = True
        self.cloud.epoch = 1
        self.cloud.marker()

    def test_an_expunged_head_in_the_cloud_does_not_make_the_verification_mismatch(self):
        self.expunge_a_note()
        self.synced()
        self.assertEqual(self.env.state()["expunge_epoch"], 1)
        docs = self.run_syncs(7)
        self.assertEqual([d["cloud"]["via"] for d in docs], ["delta"] * 6 + ["snapshot"])
        log = self.env.log_text(docs[6])
        self.assertIn("delta verify ok", log)
        self.assertNotIn("MISMATCH", log)
        _raw, sha, _n = server_snapshot_bytes(S.CLOUD_TREE, self.cloud.seq, list(self.cloud.heads.values()))
        self.assertEqual(self.env.state()["body_sha256"], sha)
        with open(delta.cache_file(self.env.tp, self.cloud.seq), "rb") as fh:
            snap = snapshot.parse(fh.read(), tree_id=S.CLOUD_TREE, schema=21)
        self.assertEqual([h.expunged for h in snap.heads if h.handle == "e5" * 14], [True])  # the cache keeps the flag the website wrote

    def test_a_verification_the_feed_cannot_serve_is_inconclusive_not_a_failure(self):
        self.synced()
        self.run_syncs(6)
        edit_site(self.cloud, "N0004", "Edited.")
        self.cloud.changes_error = transport.TransportError("gap_too_large", consts.EXIT_SERVER_REFUSED, status=410)
        doc = self.env.run("pull", yes=True)
        self.assertEqual((doc["result"], doc["cloud"]["via"]), ("ok", "snapshot"))
        self.assertIn("delta verify inconclusive", self.env.log_text(doc))


class ReplicaRules(unittest.TestCase):
    def head(self, cls="Note", handle="a1" * 14, version=1, seq=1, deleted=False, gid="N1", text="x", expunged=False):
        obj = None if deleted else {"_class": cls, "handle": handle, "gramps_id": gid, "text": {"string": text}}
        return snapshot.Head(cls, handle, gid, version, seq, deleted, obj, expunged)

    def op(self, kind, seq, version, handle="a1" * 14, cls="Note", gid="N1", text="y", **kw):
        obj = {"_class": cls, "handle": handle, "gramps_id": gid, "text": {"string": text}} if kind in ("create", "update") else None
        return dict({"seq": seq, "op": kind, "class": cls, "handle": handle, "gramps_id": gid, "version": version,
                     "hash": canonical.object_hash(obj) if obj else None, "obj": obj}, **kw)

    def test_each_kind_of_op_moves_a_head_by_exactly_one_version(self):
        r = delta.Replica("t", 1, [self.head()], 0)
        r.apply(self.op("update", 2, 2), 2)
        r.apply(self.op("delete", 3, 3), 3)
        self.assertTrue(r.heads["a1" * 14].deleted)
        r.apply(self.op("create", 4, 4), 4)  # a create over a tombstone is its next version
        r.apply(self.op("withdraw", 5, 5), 5)
        self.assertEqual((r.seq, r.heads["a1" * 14].version, r.heads["a1" * 14].deleted), (5, 5, True))

    def test_a_create_over_nothing_is_version_one_and_a_marker_only_moves_the_seq(self):
        r = delta.Replica("t", 0, [], 0)
        r.apply(self.op("create", 1, 1), 1)
        r.apply({"seq": 2, "op": "marker", "class": None, "handle": None, "version": None, "obj": None, "hash": None}, 2)
        self.assertEqual((r.seq, len(r.heads)), (2, 1))
        for kw in (dict(kind="create", seq=3, version=2, handle="b2" * 14), dict(kind="update", seq=3, version=2, handle="b2" * 14),
                   dict(kind="create", seq=3, version=2), dict(kind="update", seq=3, version=1), dict(kind="delete", seq=3, version=3)):
            with self.assertRaises(delta.Fallback, msg=str(kw)):
                r.apply(self.op(**kw), 3)

    def test_the_op_must_be_the_expected_seq_and_well_formed(self):
        r = delta.Replica("t", 1, [self.head()], 0)
        for bad in (self.op("update", 3, 2), dict(self.op("update", 2, 2), op="rename"), dict(self.op("update", 2, 2), cls="Nope", **{"class": "Nope"}),
                    dict(self.op("update", 2, 2), handle="../x"), dict(self.op("update", 2, 2), obj=None),
                    dict(self.op("update", 2, 2), obj={"_class": "Person", "handle": "a1" * 14}), dict(self.op("delete", 2, 2), obj={"_class": "Note", "handle": "a1" * 14}),
                    "not a dict", dict(self.op("update", 2, 2), expunged=True)):
            with self.assertRaises(delta.Fallback, msg=repr(bad)[:60]):
                r.apply(bad, 2)
        self.assertEqual(r.seq, 1)  # a refused op changes nothing

    def test_an_empty_gramps_id_keeps_the_old_one_as_the_website_does(self):
        r = delta.Replica("t", 1, [self.head()], 0)
        r.apply(dict(self.op("delete", 2, 2), gramps_id=""), 2)
        self.assertEqual(r.heads["a1" * 14].gramps_id, "N1")

    def test_the_serialised_state_is_the_websites_snapshot_for_the_same_heads(self):
        heads = [self.head(handle="c3" * 14, gid="N3", seq=3), self.head(cls="Person", handle="b2" * 14, gid="I1", seq=2), self.head(seq=1)]
        r = delta.Replica(S.CLOUD_TREE, 3, heads, 0)
        raw, sha, count = server_snapshot_bytes(S.CLOUD_TREE, 3, [{"class": h.cls, "handle": h.handle, "gramps_id": h.gramps_id, "version": h.version, "seq": h.seq,
                                                              "deleted": h.deleted, "obj": h.obj} for h in heads])
        snap = r.to_snapshot(21)
        self.assertEqual((snap.body_sha256, snap.header["count"]), (sha, count))
        self.assertEqual(snapshot.parse(snap.raw_gz, tree_id=S.CLOUD_TREE, schema=21).body_sha256, sha)  # and it parses like a download
        with self.assertRaises(snapshot.SnapshotError):
            r.to_snapshot(21, last_pull_seq=4)

    def test_an_expunged_tombstone_keeps_its_flag_so_the_state_hashes_to_the_websites_snapshot(self):
        live = self.head(handle="c3" * 14, gid="N3", seq=3)
        gone = self.head(handle="d4" * 14, gid="N4", version=2, seq=4, deleted=True, expunged=True)

        def rows(heads, flag=True):
            return [{"class": h.cls, "handle": h.handle, "gramps_id": h.gramps_id, "version": h.version, "seq": h.seq, "deleted": h.deleted, "obj": h.obj,
                     **({"expunged": True} if flag and h.expunged else {})} for h in heads]
        raw, sha, count = server_snapshot_bytes(S.CLOUD_TREE, 4, rows([live, gone]))
        self.assertNotEqual(sha, server_snapshot_bytes(S.CLOUD_TREE, 4, rows([live, gone], flag=False))[1])  # the flag is part of the body the website hashes
        parsed = snapshot.parse(raw, tree_id=S.CLOUD_TREE, schema=21)
        self.assertEqual([(h.handle, h.deleted, h.expunged) for h in parsed.heads], [(live.handle, False, False), (gone.handle, True, True)])
        for heads in ([live, gone], parsed.heads):  # built by hand, and read back from a download: both give the website's bytes
            snap = delta.Replica(S.CLOUD_TREE, 4, heads, 0).to_snapshot(21)
            self.assertEqual((snap.body_sha256, snap.header["count"]), (sha, count))
            self.assertEqual(snapshot.parse(snap.raw_gz, tree_id=S.CLOUD_TREE, schema=21).heads[1].expunged, True)
        plain = delta.Replica(S.CLOUD_TREE, 4, [live, self.head(handle="d4" * 14, gid="N4", version=2, seq=4, deleted=True)], 0).to_snapshot(21)
        self.assertNotEqual(plain.body_sha256, sha)  # a tombstone that was not expunged stays a different line

    def test_a_create_over_an_expunged_tombstone_is_a_live_head_again(self):
        r = delta.Replica("t", 1, [self.head(version=2, deleted=True, expunged=True)], 0)
        r.apply(self.op("create", 2, 3), 2)
        self.assertEqual((r.heads["a1" * 14].deleted, r.heads["a1" * 14].expunged), (False, False))

    def test_the_class_order_is_the_websites(self):
        here = os.path.dirname(os.path.abspath(__file__))
        with open(os.path.join(here, "..", "..", "..", "api", "src", "sync", "store.js"), encoding="utf-8") as fh:
            text = fh.read()
        import re
        m = re.search(r"export const CLASSES = Object\.freeze\(\[(.*?)\]\)", text)
        self.assertEqual(tuple(x.strip().strip('"') for x in m.group(1).split(",")), delta.SERVER_CLASS_ORDER)


if __name__ == "__main__":
    unittest.main()
