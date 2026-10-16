"""The pull side of the addon (HFY-TSK-205): check, pull, the one-transaction apply, backups and fault injection, on the synthetic fixture.

Everything runs against a fake tree and a fake cloud (addon_pull_support.py), so CI runs it with the stock python3. The Gramps lane
(gramps/tests/gramps/test_addon_pull.py) repeats the apply against a real Gramps database, and the end-to-end lane
(gramps/tests/e2e/scenario_pull.py) against the real dev server. Every value is fictional.
"""
import copy
import gzip
import hashlib
import json
import os
import sqlite3
import unittest

import addon_pull_support as S
from hfygramps import canonical
from hfygramps.addon import backup, consts, faults, plan as plan_mod, sidecar, snapshot, transport


def by_gid(objects, gid):
    return next(o for o in objects.values() if o.get("gramps_id") == gid)


def set_text(note, text):
    note["text"]["string"] = text


def sha256_file(path):
    return backup.sha256_file(path)


class Basics(S.PullCase):
    def test_the_synthetic_fixture_seeds_a_cloud_the_first_check_finds_in_step(self):
        e = S.Env(self)
        doc = e.run("check")
        self.assertEqual((doc["result"], doc["exit_code"]), ("ok", 0))
        self.assertEqual(doc["cloud"], {"head_seq": 1, "snapshot_seq": 1})
        self.assertTrue(doc["dry_run"])
        self.assertEqual(e.base_dump(), [])  # a check fills nothing in
        e.settle()
        self.assertEqual(len(e.base_dump()), 82)  # the first pull records the website's copy of everything both sides share
        con = e.side()
        try:
            self.assertEqual(sidecar.meta(con)["last_pull_seq"], "1")
        finally:
            con.close()

    def test_check_writes_a_preview_and_leaves_the_database_the_base_and_the_cloud_unchanged(self):
        e = self.env
        cloud_note = by_gid(e.cloud.heads and {h: v["obj"] for h, v in e.cloud.heads.items()}, "N0004")
        site = copy.deepcopy(cloud_note)
        set_text(site, "A plain note, edited on the website.")
        e.cloud.put(site)
        local = by_gid(e.tree.objects(), "I0002")
        e.tree.edit(local["handle"], lambda o: o["primary_name"].update(nick="Birdie"))
        db_before = sha256_file(os.path.join(e.tree.dbdir, "sqlite.db"))
        base_before = e.base_dump()
        heads_before = copy.deepcopy(e.cloud.heads)
        objects_before = e.tree.objects()
        doc = e.run("check")
        self.assertEqual((doc["result"], doc["exit_code"], doc["next_action"]), ("changes_pending", 10, "review_preview"))
        self.assertEqual(sha256_file(os.path.join(e.tree.dbdir, "sqlite.db")), db_before)
        self.assertEqual(e.base_dump(), base_before)
        self.assertEqual(e.cloud.heads, heads_before)
        self.assertEqual(e.tree.objects(), objects_before)
        self.assertEqual(e.tree.applies, 0)
        self.assertEqual(os.listdir(e.tp.backups), [])
        pv = e.preview(doc)
        self.assertEqual(len(pv["from_website"]), 1)
        self.assertEqual(pv["from_website"][0]["changes"][0]["path"], "/text/string")
        self.assertEqual(len(pv["to_website"]), 1)
        # a check records its run and nothing else in the sidecar
        con = e.side()
        try:
            self.assertEqual(con.execute("SELECT COUNT(*) FROM runs WHERE action = 'check'").fetchone()[0], 1)
            self.assertEqual(sidecar.meta(con).get("last_pull_seq"), "1")
        finally:
            con.close()
        self.assertFalse(os.path.exists(os.path.join(e.tp.dir, "state.sqlite-journal")))

    def test_the_cli_never_prints_field_values_and_status_json_holds_counts_only(self):
        e = self.env
        site = copy.deepcopy(by_gid({h: v["obj"] for h, v in e.cloud.heads.items()}, "N0004"))
        set_text(site, "Marker words that must stay out of status.json.")
        e.cloud.put(site)
        doc = e.run("pull", yes=True)
        with open(e.tp.status, encoding="utf-8") as fh:
            text = fh.read()
        self.assertNotIn("Marker words", text)
        self.assertNotIn(site["handle"], text)
        self.assertEqual(doc["counts"]["pulled"]["update"], 1)

    def test_pull_applies_a_website_change_in_one_transaction_named_for_the_seq(self):
        e = self.env
        site = copy.deepcopy(by_gid({h: v["obj"] for h, v in e.cloud.heads.items()}, "N0004"))
        set_text(site, "Edited on the website.")
        e.cloud.put(site)
        other = by_gid({h: v["obj"] for h, v in e.cloud.heads.items()}, "N0001")
        other = copy.deepcopy(other)
        other["text"]["tags"] = []
        e.cloud.put(other)
        doc = e.run("pull", yes=True)
        self.assertEqual((doc["result"], doc["exit_code"]), ("ok", 0))
        self.assertEqual(e.tree.undo, ["Website sync: pull seq 3"])  # both changes, one entry
        self.assertEqual(e.tree.applies, 1)
        self.assertEqual(by_gid(e.tree.objects(), "N0004")["text"]["string"], "Edited on the website.")
        self.assertEqual(doc["counts"]["pulled"]["update"], 2)
        self.assertEqual(doc["cloud"], {"head_seq": 3, "snapshot_seq": 3})
        # the base follows the website, and the next run has nothing to do
        again = e.run("check")
        self.assertEqual((again["result"], again["exit_code"]), ("ok", 0))
        self.assertEqual(e.run("pull", yes=True)["counts"]["pulled"], {"create": 0, "update": 0, "delete": 0})
        self.assertEqual(e.tree.applies, 1)

    def test_a_pull_creates_and_deletes_objects_and_the_cli_deletes_only_when_allowed(self):
        e = self.env
        new_note = copy.deepcopy(by_gid(load_cloud_objs(e), "N0004"))
        new_note.update(handle="a" * 28, gramps_id="N8001")
        set_text(new_note, "Created on the website.")
        e.cloud.put(new_note)
        doc = e.run("pull", yes=True)
        self.assertEqual((doc["result"], doc["exit_code"]), ("ok", 0), doc["error"])
        self.assertEqual(doc["counts"]["pulled"], {"create": 1, "update": 0, "delete": 0})
        self.assertIn(new_note["handle"], e.tree.objects())
        e.cloud.tombstone(new_note["handle"])
        d2 = e.run("pull", yes=True)  # the CLI never applies an incoming delete without allow_deletes
        self.assertEqual((d2["result"], d2["exit_code"]), ("partial", 20))
        self.assertIn(new_note["handle"], e.tree.objects())
        self.assertEqual((d2["counts"]["blocked"], d2["counts"]["pulled"]["delete"]), (1, 0))
        d3 = e.run("pull", yes=True, allow_deletes=True)
        self.assertEqual((d3["result"], d3["exit_code"]), ("ok", 0), d3["error"])
        self.assertNotIn(new_note["handle"], e.tree.objects())
        self.assertEqual(d3["counts"]["pulled"], {"create": 0, "update": 0, "delete": 1})
        self.assertEqual(e.run("check")["exit_code"], 0)  # the tombstone is the base now; nothing is left to do

    def test_a_backup_that_passes_integrity_check_is_taken_before_the_apply(self):
        e = self.env
        site = copy.deepcopy(by_gid(load_cloud_objs(e), "N0004"))
        set_text(site, "Edited on the website.")
        e.cloud.put(site)
        before = e.tree.objects()
        doc = e.run("pull", yes=True)
        self.assertTrue(doc["backup"].startswith(e.tp.backups))
        names = sorted(os.listdir(e.tp.backups))
        self.assertEqual(len(names), 3)
        stem = os.path.basename(doc["backup"])[:-len(".sqlite")]
        self.assertEqual(names, sorted([stem + ".sqlite", stem + ".sidecar.sqlite", stem + ".sha256"]))
        con = sqlite3.connect(doc["backup"])
        try:
            self.assertEqual(con.execute("PRAGMA integrity_check").fetchone()[0], "ok")
            stored = {h: json.loads(j) for h, j in con.execute("SELECT handle, json FROM objects")}
        finally:
            con.close()
        self.assertEqual(stored, before)  # the backup is the tree as it was before the apply
        sums = backup.read_sha_file(os.path.join(e.tp.backups, stem + ".sha256"))
        self.assertEqual(sums[stem + ".sqlite"], sha256_file(doc["backup"]))
        self.assertEqual(sums[stem + ".sidecar.sqlite"], sha256_file(os.path.join(e.tp.backups, stem + ".sidecar.sqlite")))
        self.assertRegex(stem, r"^\d{8}T\d{6}Z-pull-seq2$")

    def test_no_backup_no_apply(self):
        e = self.env
        site = copy.deepcopy(by_gid(load_cloud_objs(e), "N0004"))
        set_text(site, "Edited on the website.")
        e.cloud.put(site)
        os.unlink(os.path.join(e.tree.dbdir, "sqlite.db"))  # the backup cannot be made
        before = e.tree.objects()
        doc = e.run("pull", yes=True)
        self.assertEqual(doc["result"], "failed")
        self.assertEqual(doc["error"]["code"], "backup_failed")
        self.assertEqual(e.tree.objects(), before)
        self.assertEqual(e.tree.applies, 0)
        self.assertEqual(os.listdir(e.tp.backups), [])

    def test_a_run_with_nothing_to_apply_takes_no_backup(self):
        doc = self.env.run("pull", yes=True)
        self.assertEqual((doc["result"], doc["backup"]), ("ok", None))

    def test_a_dry_run_pull_is_a_check(self):
        e = self.env
        site = copy.deepcopy(by_gid(load_cloud_objs(e), "N0004"))
        set_text(site, "Edited on the website.")
        e.cloud.put(site)
        doc = e.run("pull", dry_run=True)
        self.assertEqual((doc["result"], doc["exit_code"]), ("changes_pending", 10))
        self.assertEqual(e.tree.applies, 0)


def load_cloud_objs(env):
    return {h: v["obj"] for h, v in env.cloud.heads.items() if v["obj"] is not None}


class SnapshotVerification(S.PullCase):
    def raw(self, **kw):
        return S.snapshot_bytes(S.CLOUD_TREE, kw.pop("seq", 1), list(self.env.cloud.heads.values()), **kw)[0]

    def parse(self, raw, **kw):
        args = dict(tree_id=S.CLOUD_TREE, schema=21, last_pull_seq=0)
        args.update(kw)
        return snapshot.parse(raw, **args)

    def test_a_good_snapshot_verifies(self):
        snap = self.parse(self.raw())
        self.assertEqual((snap.seq, len(snap.heads)), (1, 82))
        self.assertEqual(snap.by_handle[snap.heads[0].handle].version, 1)

    def test_every_check_of_step_3_refuses(self):
        raw = self.raw()
        text = gzip.decompress(raw)
        head, _, body = text.partition(b"\n")
        h = json.loads(head)

        def regz(header, b=body):
            return gzip.compress(json.dumps(header, sort_keys=True).encode() + b"\n" + b)

        cases = {
            "not gzip": b"plain text",
            "body hash": regz(h, body.replace(b'"version":1', b'"version":2', 1)),
            "count": regz(dict(h, count=h["count"] + 1)),
            "no header": gzip.compress(body),
            "header type": regz(dict(h, type="body")),
            "redaction": regz(dict(h, redaction=2)),
        }
        for name, data in cases.items():
            with self.assertRaises(snapshot.SnapshotError, msg=name) as ctx:
                self.parse(data)
            self.assertEqual(ctx.exception.code, "snapshot_invalid", name)
        with self.assertRaises(snapshot.SnapshotError):
            self.parse(raw, tree_id="another-tree")
        with self.assertRaises(snapshot.SnapshotError):
            self.parse(raw, schema=22)
        with self.assertRaises(snapshot.SnapshotError):
            self.parse(raw, expect={"seq": 1, "count": 82, "body_sha256": "0" * 64})

    def test_an_older_snapshot_than_the_last_pull_is_refused_as_rollback(self):
        with self.assertRaises(snapshot.SnapshotError) as ctx:
            self.parse(self.raw(), last_pull_seq=5)
        self.assertEqual(ctx.exception.code, "snapshot_older")
        self.parse(self.raw(), last_pull_seq=1)  # the same seq is a replay, not a rollback

    def test_a_bad_line_or_a_duplicate_handle_is_refused(self):
        heads = list(self.env.cloud.heads.values())
        dup = copy.deepcopy(heads[0])
        raw, _, _ = S.snapshot_bytes(S.CLOUD_TREE, 1, heads + [dup])
        with self.assertRaises(snapshot.SnapshotError):
            self.parse(raw)
        liar = copy.deepcopy(heads[0])
        liar["obj"] = dict(liar["obj"], handle="another")
        raw, _, _ = S.snapshot_bytes(S.CLOUD_TREE, 1, heads[1:] + [liar])
        with self.assertRaises(snapshot.SnapshotError):
            self.parse(raw)
        tomb = dict(copy.deepcopy(heads[0]), deleted=True)
        tomb["obj"] = heads[0]["obj"]
        text = gzip.decompress(S.snapshot_bytes(S.CLOUD_TREE, 1, [dict(heads[0], deleted=True)])[0])
        # a tombstone with an object attached
        header, _, body = text.partition(b"\n")
        line = json.loads(body)
        line["obj"] = heads[0]["obj"]
        body = canonical.canonical_json(line).encode() + b"\n"
        h = json.loads(header)
        h["body_sha256"] = hashlib.sha256(body).hexdigest()
        with self.assertRaises(snapshot.SnapshotError):
            self.parse(gzip.compress(json.dumps(h).encode() + b"\n" + body))

    def test_a_gzip_bomb_is_stopped_at_the_cap(self):
        bomb = gzip.compress(b"x" * (3 * 1024 * 1024))
        with self.assertRaises(snapshot.SnapshotError):
            snapshot.gunzip_capped(bomb, cap=1024 * 1024)

    def test_the_run_refuses_a_rolled_back_snapshot_and_a_snapshot_of_another_tree(self):
        e = self.env
        e.cloud.seq = 5
        e.cloud.put(copy.deepcopy(by_gid(load_cloud_objs(e), "N0004")), seq=5)
        self.assertEqual(e.run("pull", yes=True)["result"], "ok")
        e.cloud.seq = 3
        doc = e.run("pull", yes=True)
        self.assertEqual((doc["result"], doc["exit_code"], doc["error"]["code"]), ("refused", 65, "snapshot_older"))
        e.cloud.seq = 6
        e.cloud.tree_id = "99999999-2222-4333-8444-555555555555"
        doc = e.run("pull", yes=True)
        self.assertEqual((doc["result"], doc["error"]["code"]), ("refused", "D50"))


if __name__ == "__main__":
    unittest.main()
