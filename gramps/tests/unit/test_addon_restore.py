"""Backups, retention and `hfy-sync restore` (HFY-TSK-205, error catalog D46, BRD2 SI-03). Standard library only; no Gramps.

The restore function runs on a small stand-in for a Gramps tree folder (a real sqlite.db with the files Gramps leaves beside it); the
wrapper runs with the fake Gramps command of test_addon_wrapper.py. The point of every test is the same: the restore never leaves a
half-moved tree, and after it a dry-run check pushes no reverts and no deletes.
"""
import copy
import datetime
import json
import os
import sqlite3
import sys
import unittest
from unittest import mock

import addon_pull_support as S
from hfygramps.addon import backup, consts, paths, sidecar, status
from test_addon_pull import by_gid, load_cloud_objs, set_text
from test_addon_pull_safety import website_edits
from test_addon_wrapper import GRAMPS, WRAPPER, WrapperCase


class BackupFiles(S.PullCase):
    def make(self, action="pull", seq=3, now=None):
        return backup.make(self.env.tree.dbdir, self.env.tp, action, seq, self.env.tp.sidecar, now=now)

    def test_a_backup_is_the_database_the_sidecar_and_their_hashes(self):
        b = self.make(now=1760000000)
        self.assertEqual(b.name, "20251009T085320Z-pull-seq3")
        self.assertEqual(sorted(os.listdir(self.env.tp.backups)), sorted([b.name + ".sqlite", b.name + ".sidecar.sqlite", b.name + ".sha256"]))
        sums = backup.read_sha_file(b.sha_path)
        self.assertEqual(sums, {b.name + ".sqlite": backup.sha256_file(b.path), b.name + ".sidecar.sqlite": backup.sha256_file(b.sidecar_path)})
        for p in (b.path, b.sidecar_path):
            self.assertEqual(oct(os.stat(p).st_mode & 0o777), "0o600")
        con = sqlite3.connect(b.sidecar_path)
        try:
            self.assertEqual(con.execute("SELECT COUNT(*) FROM base").fetchone()[0], 82)
        finally:
            con.close()

    def test_two_backups_in_one_second_do_not_overwrite_each_other(self):
        a, b = self.make(now=1760000000), self.make(now=1760000000)
        self.assertNotEqual(a.name, b.name)
        self.assertEqual(len(backup.list_backups(self.env.tp.backups)), 2)

    def test_a_backup_that_cannot_be_made_leaves_nothing_behind(self):
        with mock.patch.object(backup, "_integrity", return_value="*** in database main ***"):
            with self.assertRaises(backup.BackupError) as ctx:
                self.make()
        self.assertEqual(ctx.exception.code, "backup_failed")
        self.assertEqual(os.listdir(self.env.tp.backups), [])

    def test_retention_keeps_the_last_twenty_and_one_per_day_for_thirty_days(self):
        d = self.env.tp.backups
        now = datetime.datetime(2026, 10, 14, 12, 0, 0, tzinfo=datetime.timezone.utc).timestamp()
        names = []
        for i in range(45):  # one a day, going back, and a second one on the first few days
            t = now - i * 86400
            names.append(self.make(now=t).name)
        for i in range(3):
            names.append(self.make(now=now - i * 86400 + 600).name)  # a later one the same day
        removed = backup.prune(d, now=now)
        kept = {n for n, _ in backup.list_backups(d)}
        self.assertEqual(len(kept) + len(removed), 48)
        newest = sorted(n for n in names)[-20:]
        self.assertTrue(set(newest) <= kept)
        # beyond the last twenty only the newest of a day within thirty days survives
        within = [n for n in kept if n not in newest]
        days = [n[:8] for n in within]
        self.assertEqual(len(days), len(set(days)))
        old = [n for n in names if datetime.datetime.strptime(n[:8], "%Y%m%d") < datetime.datetime(2026, 9, 14)]
        self.assertTrue(all(n in removed for n in old if n not in newest))
        for n in removed:
            self.assertFalse(os.path.exists(os.path.join(d, n + ".sqlite")))
            self.assertFalse(os.path.exists(os.path.join(d, n + ".sidecar.sqlite")))
            self.assertFalse(os.path.exists(os.path.join(d, n + ".sha256")))


class RestoreFunction(S.PullCase):
    def pulled(self):
        """A pull that applies, so a backup of the tree before it exists. Returns (name, objects before, base before)."""
        e = self.env
        before = e.tree.objects()
        base_before = e.base_dump()
        website_edits(e)
        doc = e.run("pull", yes=True)
        self.assertEqual(doc["result"], "ok")
        return os.path.basename(doc["backup"])[:-len(".sqlite")], before, base_before

    def test_restore_puts_back_the_database_and_the_sidecar_saved_with_the_backup(self):
        e = self.env
        name, before, base_before = self.pulled()
        # the files Gramps leaves beside the database must not survive next to a restored one
        for extra in ("sqlite.db-journal", "sqlite.db-wal", "sqlite.db-shm"):
            with open(os.path.join(e.tree.dbdir, extra), "wb") as fh:
                fh.write(b"stale")
        out = backup.restore(e.tree.dbdir, e.tp, name, ps_lines=["/usr/sbin/cron"])
        e.tree.reload()
        self.assertEqual(e.tree.objects(), before)
        self.assertEqual(e.base_dump(), base_before)
        for extra in ("sqlite.db-journal", "sqlite.db-wal", "sqlite.db-shm"):
            self.assertFalse(os.path.exists(os.path.join(e.tree.dbdir, extra)), extra)
            self.assertTrue(os.path.exists(os.path.join(out["aside"], extra)), extra)
        self.assertTrue(os.path.exists(os.path.join(out["aside"], "sqlite.db")))
        self.assertTrue(os.path.exists(os.path.join(out["aside"], "state.sqlite")))
        self.assertEqual(backup.sha256_file(os.path.join(e.tree.dbdir, "sqlite.db")), backup.sha256_file(os.path.join(e.tp.backups, name + ".sqlite")))
        # the dry-run check after a restore: the website's changes come back as pulls; nothing is pushed back
        doc = e.run("check")
        self.assertEqual((doc["result"], doc["exit_code"]), ("changes_pending", 10))
        pv = e.preview(doc)
        self.assertEqual(pv["planned_push"], {"create": 0, "update": 0, "delete": 0})
        self.assertEqual(pv["to_website"], [])
        self.assertEqual(doc["counts"]["blocked"], 0)
        self.assertEqual(len(pv["from_website"]), 3)
        # and a pull then brings the tree to where it was
        self.assertEqual(e.run("pull", yes=True)["result"], "ok")
        self.assertEqual(by_gid(e.tree.objects(), "N0004")["text"]["string"], "Edited on the website.")

    def test_a_database_restored_without_its_sidecar_would_push_reverts_which_is_why_the_pair_travels_together(self):
        e = self.env
        name, before, _base = self.pulled()
        # what restoring only the database file would do (the manual runbook step this replaces)
        import shutil

        shutil.copyfile(os.path.join(e.tp.backups, name + ".sqlite"), os.path.join(e.tree.dbdir, "sqlite.db"))
        e.tree.reload()
        pv = e.preview(e.run("check"))
        self.assertTrue(pv["to_website"], "the old values would go back to the website")
        self.assertTrue(all(o["label"] == "reverts a website change (origin)" for o in pv["to_website"]))
        self.assertTrue(all(o["disposition"] == "parked" for o in pv["to_website"]))

    def test_it_refuses_while_the_tree_is_locked_or_gramps_runs_and_moves_nothing(self):
        e = self.env
        name, before, _b = self.pulled()
        sha = backup.sha256_file(os.path.join(e.tree.dbdir, "sqlite.db"))
        with open(os.path.join(e.tree.dbdir, "lock"), "w") as fh:
            fh.write("1")
        with self.assertRaises(backup.BackupError) as ctx:
            backup.restore(e.tree.dbdir, e.tp, name)
        self.assertEqual((ctx.exception.code, ctx.exception.exit_code, ctx.exception.next_action), ("D01", 75, "close_gramps"))
        os.unlink(os.path.join(e.tree.dbdir, "lock"))
        with self.assertRaises(backup.BackupError) as ctx:
            backup.restore(e.tree.dbdir, e.tp, name, ps_lines=["/Applications/Gramps.app/Contents/MacOS/Gramps"])
        self.assertEqual(ctx.exception.code, "D01")
        self.assertEqual(backup.sha256_file(os.path.join(e.tree.dbdir, "sqlite.db")), sha)
        self.assertFalse([f for f in os.listdir(e.tree.dbdir) if f.startswith("pre-restore")])

    def test_it_verifies_the_sha256_of_both_copies_before_it_moves_anything(self):
        e = self.env
        name, before, _b = self.pulled()
        sha = backup.sha256_file(os.path.join(e.tree.dbdir, "sqlite.db"))
        for suffix in (".sqlite", ".sidecar.sqlite"):
            path = os.path.join(e.tp.backups, name + suffix)
            with open(path, "rb") as fh:
                data = bytearray(fh.read())
            data[-1] ^= 0xFF
            with open(path, "wb") as fh:
                fh.write(data)
            with self.assertRaises(backup.BackupError) as ctx:
                backup.restore(e.tree.dbdir, e.tp, name)
            self.assertEqual(ctx.exception.code, "backup_invalid", suffix)
            data[-1] ^= 0xFF
            with open(path, "wb") as fh:
                fh.write(data)
        self.assertEqual(backup.sha256_file(os.path.join(e.tree.dbdir, "sqlite.db")), sha)

    def test_a_backup_without_its_sidecar_copy_is_not_restored(self):
        e = self.env
        name, before, _b = self.pulled()
        os.unlink(os.path.join(e.tp.backups, name + ".sidecar.sqlite"))
        with self.assertRaises(backup.BackupError) as ctx:
            backup.restore(e.tree.dbdir, e.tp, name)
        self.assertEqual(ctx.exception.code, "backup_incomplete")

    def test_a_restored_database_that_fails_integrity_check_puts_the_old_files_back(self):
        e = self.env
        name, before, _b = self.pulled()
        sha = backup.sha256_file(os.path.join(e.tree.dbdir, "sqlite.db"))
        side_sha = backup.sha256_file(e.tp.sidecar)
        real = backup._integrity
        calls = []

        def flaky(path):
            calls.append(path)
            return "bad" if os.path.basename(path) == "sqlite.db" else real(path)

        with mock.patch.object(backup, "_integrity", flaky):
            with self.assertRaises(backup.BackupError) as ctx:
                backup.restore(e.tree.dbdir, e.tp, name)
        self.assertEqual(ctx.exception.code, "restore_failed")
        self.assertEqual(backup.sha256_file(os.path.join(e.tree.dbdir, "sqlite.db")), sha)
        self.assertEqual(backup.sha256_file(e.tp.sidecar), side_sha)

    def test_only_this_trees_backups_by_their_own_names(self):
        e = self.env
        name, before, _b = self.pulled()
        for bad in ("../../etc/passwd", "notabackup", "/tmp/%s.sqlite" % name):
            with self.assertRaises(backup.BackupError, msg=bad) as ctx:
                backup.restore(e.tree.dbdir, e.tp, bad)
            self.assertEqual(ctx.exception.exit_code, consts.EXIT_USAGE, bad)

    def test_the_state_lock_is_held_for_the_restore(self):
        e = self.env
        name, before, _b = self.pulled()
        from hfygramps.addon import preflight

        with preflight.StateLock(e.tp.lock) as lock:
            self.assertTrue(lock.acquired)
            with self.assertRaises(backup.BackupError) as ctx:
                backup.restore(e.tree.dbdir, e.tp, name)
        self.assertEqual(ctx.exception.code, "D14")


class RestoreWrapper(WrapperCase):
    """`hfy-sync restore` end to end with a fake Gramps: the restore itself, then the dry-run check."""

    def setUp(self):
        super().setUp()
        self.env_ = {"HOME": self.home}
        self.tp = paths.TreePaths(self.dbid, self.env_)
        self.tp.ensure()
        side = os.path.join(self.tp.dir, "state.sqlite")
        sidecar.create(side, {"tree_id": "t" * 8, "dbid": self.dbid})
        self.b = backup.make(self.tree_dir, self.tp, "pull", 4, self.tp.sidecar)
        con = sqlite3.connect(os.path.join(self.tree_dir, "sqlite.db"))
        con.execute("CREATE TABLE changed_after_backup (x)")
        con.commit()
        con.close()
        self.after_sha = backup.sha256_file(os.path.join(self.tree_dir, "sqlite.db"))

    def tables(self):
        con = sqlite3.connect(os.path.join(self.tree_dir, "sqlite.db"))
        try:
            return {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        finally:
            con.close()

    def test_restore_then_a_dry_run_check(self):
        proc = self.wrap("restore", self.b.name, "--tree", "Fixture Tree", HFY_SYNC_TEST="1", HFY_SYNC_PS_CMD="true")
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertNotIn("changed_after_backup", self.tables())
        (argv,) = self.calls()
        opts = dict(kv.split("=", 1) for kv in argv[5].split(","))
        self.assertEqual((opts["action"], opts["dry_run"], opts["yes"], opts["allow_deletes"]), ("check", "1", "0", "0"))
        self.assertTrue([f for f in os.listdir(self.tree_dir) if f.startswith("pre-restore-")])

    def test_the_exit_code_is_the_checks_so_a_restore_that_finds_changes_says_10(self):
        proc = self.wrap("restore", self.b.name, "--tree", "Fixture Tree", HFY_SYNC_TEST="1", HFY_SYNC_PS_CMD="true", FAKE_EXIT="10")
        self.assertEqual(proc.returncode, 10)

    def test_a_locked_tree_gramps_running_or_a_bad_backup_never_reach_gramps(self):
        with open(os.path.join(self.tree_dir, "lock"), "w") as fh:
            fh.write("1")
        proc = self.wrap("restore", self.b.name, "--tree", "Fixture Tree")
        self.assertEqual(proc.returncode, 75)
        os.unlink(os.path.join(self.tree_dir, "lock"))
        proc = self.wrap("restore", self.b.name, "--tree", "Fixture Tree", HFY_SYNC_TEST="1",
                         HFY_SYNC_PS_CMD="echo /Applications/Gramps.app/Contents/MacOS/Gramps")
        self.assertEqual(proc.returncode, 75)
        self.assertEqual(self.status_doc()["error"]["code"], "D01")
        proc = self.wrap("restore", "20200101T000000Z-pull-seq1", "--tree", "Fixture Tree", HFY_SYNC_TEST="1", HFY_SYNC_PS_CMD="true")
        self.assertEqual(proc.returncode, 64)
        with open(self.b.path, "ab") as fh:
            fh.write(b"x")
        proc = self.wrap("restore", self.b.name, "--tree", "Fixture Tree", HFY_SYNC_TEST="1", HFY_SYNC_PS_CMD="true")
        self.assertEqual(proc.returncode, 78)
        self.assertEqual(self.calls(), [])
        self.assertEqual(backup.sha256_file(os.path.join(self.tree_dir, "sqlite.db")), self.after_sha)

    def test_restore_needs_a_backup_name_and_plan_goes_with_sync_or_pull(self):
        self.assertEqual(self.wrap("restore", "--tree", "Fixture Tree").returncode, 64)
        self.assertEqual(self.wrap("status", "--tree", "Fixture Tree", "--plan", "R1").returncode, 64)
        self.assertEqual(self.wrap("sync", "--tree", "Fixture Tree", "--plan", "../x").returncode, 64)

    def test_plan_is_passed_to_the_tool(self):
        self.wrap("sync", "--yes", "--plan", "R12345", "--tree", "Fixture Tree")
        (argv,) = self.calls()
        opts = dict(kv.split("=", 1) for kv in argv[5].split(","))
        self.assertEqual((opts["action"], opts["yes"], opts["plan"]), ("sync", "1", "R12345"))


if __name__ == "__main__":
    unittest.main()
