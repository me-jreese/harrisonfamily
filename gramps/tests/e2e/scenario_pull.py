"""Pull scenarios of the end-to-end lane (HFY-TSK-205): the installed addon, the real Gramps CLI and the sync dev server.

Every test starts its own dev server, binds a private copy of the fixture tree, seeds the cloud with what the desktop projects (the real
push routes: validator, privacy checker and integrity rules all ran), signs the addon in through the dev /auth endpoints (the refresh token
lives in a file under HFY_SYNC_TEST, never in the Keychain), makes the "website" change something, and then drives `hfy-sync` the way io does.

    check         a preview is written; the database file, the sidecar's base and the cloud are byte for byte what they were (AC1)
    pull          the change is applied, a verified backup exists, a second pull finds nothing
    faults        after the backup, in the middle of the apply, after the commit and before the sidecar, after a media download, and after
                  the sidecar, as a raised fault (exit 70) and as a process kill: the next clean run converges, nothing lost, nothing twice (AC3)
    conflicts     a parked (CLI) and a skipped (GUI) conflict stay open over three more runs, both sides byte-unchanged (AC7); a cloud
                  birth-year change over a local day and month, and a tombstone on such an event, are conflicts, never applied (AC5, AC10)
    privacy       a pulled Date that shows a local date of birth is not applied; counts only in status.json (AC6)
    expunge       a changed hash at an unchanged version refreshes the base and holds the local value (AC12)
    restore       `hfy-sync restore <backup>` puts the database and the sidecar of that moment back and pushes nothing (AC8)
    reviewed plan `sync --yes --plan <run_id>` applies the reviewed plan only (AC11)

Fictional data only; the date of birth used in the privacy test is read from the committed fixture at run time and never printed.
"""
import copy
import hashlib
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import e2e_case as C  # noqa: E402
import e2e_cloud as K  # noqa: E402
import e2e_support as E  # noqa: E402
from hfygramps import projection as PR  # noqa: E402
from hfygramps.addon import consts, keychain, mediafile, sidecar  # noqa: E402

MEDIA_FIXTURE = os.path.join(HERE, "..", "fixtures", "media", "synthetic-photo-plain.jpg")
NEW_MEDIA_HANDLE = "a1" * 14  # 28 hex characters
NEW_NOTE_HANDLE = "b2" * 14
NEW_EVENT_HANDLE = "c3" * 14


def by_gid(objects, gid):
    for o in objects.values():
        if o.get("gramps_id") == gid:
            return o
    raise KeyError(gid)


def set_text(obj, text):
    obj["text"]["string"] = text


def sha256_file(path):
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


class PullE2E(C.E2ECase):
    """A bound tree, a seeded cloud and a signed-in addon; `self.cloud` is the website."""

    def setUp(self):
        super().setUp()
        self.keys_dir = tempfile.mkdtemp(prefix="hfy-e2e-keys-")
        self.addCleanup(shutil.rmtree, self.keys_dir, True)
        self.media_root = os.path.join(self.keys_dir, "media")

    # ------------------------------------------------------------------------------------------------------------- bring-up

    def make_symmetric(self):
        """The fixture's private ChildRef leaves a person that names a family which does not name it back once projected; the server's
        completion check refuses such a seed (a finding for addon-push, which sends the projection). Clearing the flag in this copy keeps
        the seed valid; nothing else about the fixture changes."""
        def fix(db, DbTxn):
            with DbTxn("e2e fixture: child refs", db) as trans:
                for fam in list(db.iter_families()):
                    refs = fam.get_child_ref_list()
                    if any(r.get_privacy() for r in refs):
                        for r in refs:
                            r.set_privacy(False)
                        db.commit_family(fam, trans)
        self.edit(fix)

    def bring_up(self, extra_server_args=()):
        self.make_symmetric()
        local = self.bind_local()
        self.server = self.start_server(*extra_server_args)
        self.point_config_at(self.server)
        cfg_path = C.S.tree_paths(self.dbid)["config"]
        with open(cfg_path, encoding="utf-8") as fh:
            cfg = json.load(fh)
        cfg["media_root"] = self.media_root
        with open(cfg_path, "w", encoding="utf-8") as fh:
            json.dump(cfg, fh, indent=2, sort_keys=True)
        web = E.sign_in(self.server, step_up=True)  # the website's owner (deletes need the step-up)
        self.cloud = K.CloudDriver(self.server, web)
        self.cloud.bind(local["dbid"], local["fingerprint"], self.tree_name_sha256())
        objects = copy.deepcopy(list(self.local_objects().values()))
        # what the addon's push sends: the projection knows the files (a photo with a GPS location is held, the disk MD5 is the checksum)
        import importlib  # by name: the unit lane checks that e2e_case has no static `gramps` import, and this file follows its pattern
        base = self.edit(lambda db, DbTxn: importlib.import_module("gramps.gen.utils.file").media_path(db))
        files = mediafile.collect([o for o in objects if o["_class"] == "Media"], base)
        projected = {h: p for h, p in PR.project_tree(objects, files=files)[0].items() if p is not None}
        self.projected = projected
        self.cloud.seed(projected)
        self.server.set_head(seeded=True)
        desk = E.sign_in(self.server)  # the addon's own sign-in: its own token family, kept in a file (HFY_SYNC_TEST only)
        self.keyfile = os.path.join(self.keys_dir, "refresh-token")
        keychain.FileKeychain(self.keyfile).store(desk.keychain.token)
        self.env = {"HFY_SYNC_KEYCHAIN_FILE": self.keyfile}

    # --------------------------------------------------------------------------------------------------------------- driving

    def hfy(self, *args, **env):
        """Runs `hfy-sync <args>` and returns (CompletedProcess, status.json document)."""
        e = dict(self.env)
        e.update({k: v for k, v in env.items()})
        proc = self.wrapper(*args, env=e)
        try:
            doc = C.S.read_status(self.dbid)
        except (OSError, ValueError):
            doc = None
        return proc, doc

    def settle(self):
        """The first sync: both sides hold the same objects, so every one is `converged` and the base fills in."""
        proc, doc = self.hfy("pull", "--yes")
        self.assertEqual((proc.returncode, doc["result"]), (0, "ok"), proc.stdout + proc.stderr + json.dumps(doc["error"]))
        self.assertGreater(self.base_count(), 50)
        return doc

    def side(self):
        return sidecar.open_checked(C.S.tree_paths(self.dbid)["sidecar"])

    def base_count(self):
        con = self.side()
        try:
            return con.execute("SELECT COUNT(*) FROM base").fetchone()[0]
        finally:
            con.close()

    def base_dump(self):
        con = self.side()
        try:
            return sorted(con.execute("SELECT class, handle, version, seq, hash, obj_json, deleted FROM base").fetchall())
        finally:
            con.close()

    def table(self, sql, *args):
        con = self.side()
        try:
            return con.execute(sql, args).fetchall()
        finally:
            con.close()

    def preview(self, doc):
        path = os.path.join(C.S.tree_paths(self.dbid)["dir"], "previews", "%s.json" % doc["run_id"])
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)

    def db_sha(self):
        return sha256_file(os.path.join(self.dir, "sqlite.db"))

    def opened_once(self):
        """The first open of a tree rewrites sqlite.db once (Gramps' own metadata); take it before the digests that must not change."""
        self.hfy("status")

    def local_edit_note(self, gid, text):
        def edit(db, DbTxn):
            note = next(n for n in (db.get_note_from_handle(h) for h in db.get_note_handles()) if n.get_gramps_id() == gid)
            with DbTxn("e2e local edit", db) as trans:
                note.set(text)
                db.commit_note(note, trans)
        self.edit(edit)

    def website_edit_note(self, gid="N0004", text="Edited on the website."):
        return self.cloud.edit(gid, lambda o: set_text(o, text))

    def local_note_text(self, gid="N0004"):
        return by_gid(self.local_objects(), gid)["text"]["string"]

    def cloud_digest(self):
        """What the cloud holds, as the versions and hashes of every head: a push or a withdraw by the addon would change it."""
        return sorted((h, r["version"], r["seq"], r["deleted"]) for h, r in self.cloud.heads().items())

    def writes_to_cloud(self):
        return [e for e in self.server.requests(method="POST") if e["path"] in ("/api/sync/batches", "/api/sync/sessions")
                and e["status"] == 200 or e["path"] == "/api/sync/conflicts"]


class Check(PullE2E):
    def test_check_writes_a_preview_and_leaves_the_database_the_base_and_the_cloud_unchanged(self):
        self.bring_up()
        self.settle()
        self.website_edit_note()
        base_before, db_before, cloud_before = self.base_dump(), self.db_sha(), self.cloud_digest()
        posts_before = len([e for e in self.server.entries() if e["method"] == "POST" and e["path"].startswith("/api/sync/batches")])
        proc, doc = self.hfy("check")
        self.assertEqual((proc.returncode, doc["result"], doc["action"], doc["dry_run"]), (10, "changes_pending", "check", True), proc.stdout + proc.stderr)
        self.assertEqual(doc["counts"]["pulled"], {"create": 0, "update": 1, "delete": 0})
        self.assertEqual(self.db_sha(), db_before, "the database file is byte for byte as it was")
        self.assertEqual(self.base_dump(), base_before, "and so is the sidecar's base")
        self.assertEqual(self.cloud_digest(), cloud_before, "and the cloud")
        self.assertEqual(len([e for e in self.server.entries() if e["method"] == "POST" and e["path"].startswith("/api/sync/batches")]), posts_before)
        pv = self.preview(doc)
        self.assertEqual(pv["run_id"], doc["run_id"])
        self.assertEqual([c["path"] for c in pv["from_website"][0]["changes"]], ["/text/string"])
        self.assertEqual(pv["to_website"], [])
        self.assertIsNone(doc["backup"], "a check takes no backup")
        self.assertNotIn("Edited on the website.", proc.stdout + proc.stderr + json.dumps(doc), "the CLI never prints field values")
        self.assertNotEqual(self.local_note_text(), "Edited on the website.")

    def test_check_on_an_empty_cloud_reports_the_desktop_objects_as_waiting_to_go(self):
        local = self.bind_local()
        self.server = self.start_server()
        self.point_config_at(self.server)
        web = E.sign_in(self.server, step_up=True)
        cloud = K.CloudDriver(self.server, web)
        cloud.bind(local["dbid"], local["fingerprint"], self.tree_name_sha256())
        desk = E.sign_in(self.server)
        self.keyfile = os.path.join(tempfile.mkdtemp(prefix="hfy-e2e-keys-"), "refresh-token")
        self.addCleanup(shutil.rmtree, os.path.dirname(self.keyfile), True)
        keychain.FileKeychain(self.keyfile).store(desk.keychain.token)
        proc = self.wrapper("check", env={"HFY_SYNC_KEYCHAIN_FILE": self.keyfile})
        doc = C.S.read_status(self.dbid)
        self.assertEqual((proc.returncode, doc["result"]), (10, "changes_pending"), proc.stdout + proc.stderr)
        self.assertEqual(doc["counts"]["pulled"], {"create": 0, "update": 0, "delete": 0})
        self.assertGreater(doc["counts"]["push_pending"], 50)
        self.assertEqual(doc["cloud"], {"head_seq": 0, "snapshot_seq": 0})


class Pull(PullE2E):
    def test_pull_applies_the_change_with_a_verified_backup_and_a_second_pull_finds_nothing(self):
        self.bring_up()
        self.settle()
        self.website_edit_note()
        other = self.cloud.edit("N0001", lambda o: o.update(format=1))
        self.opened_once()
        proc, doc = self.hfy("pull", "--yes")
        self.assertEqual((proc.returncode, doc["result"]), (0, "ok"), proc.stdout + proc.stderr + json.dumps(doc["error"]))
        self.assertEqual(doc["counts"]["pulled"], {"create": 0, "update": 2, "delete": 0})
        local = self.local_objects()
        self.assertEqual(by_gid(local, "N0004")["text"]["string"], "Edited on the website.")
        self.assertEqual(by_gid(local, "N0001")["format"], other["format"])
        self.assertTrue(doc["backup"] and os.path.isfile(doc["backup"]))
        con = C.S.sqlite_ro(doc["backup"])
        try:
            self.assertEqual(con.execute("PRAGMA integrity_check").fetchone()[0], "ok")
        finally:
            con.close()
        self.assertTrue(os.path.isfile(doc["backup"][:-len(".sqlite")] + ".sidecar.sqlite"))
        self.assertTrue(os.path.isfile(doc["backup"][:-len(".sqlite")] + ".sha256"))
        self.assertEqual(self.table("SELECT run_id, action, result FROM runs WHERE run_id = ?", doc["run_id"]), [(doc["run_id"], "pull", "ok")])
        again, doc2 = self.hfy("pull", "--yes")
        self.assertEqual((again.returncode, doc2["counts"]["pulled"]), (0, {"create": 0, "update": 0, "delete": 0}))
        self.assertIsNone(doc2["backup"], "nothing to apply, so no backup")
        # the sidecar's base followed the website for both objects
        heads = self.cloud.heads()
        rows = {r[1]: r for r in self.base_dump()}
        for gid in ("N0004", "N0001"):
            h = by_gid(local, gid)["handle"]
            self.assertEqual((rows[h][2], rows[h][3]), (heads[h]["version"], heads[h]["seq"]))

    def test_a_website_created_media_object_comes_down_with_its_file(self):
        self.bring_up()
        self.settle()
        media = copy.deepcopy(self.projected["95c1e2e76d98047b229a3390d414"])
        with open(MEDIA_FIXTURE, "rb") as fh:
            data = fh.read()
        media.update(handle=NEW_MEDIA_HANDLE, gramps_id="O0900", checksum=hashlib.md5(data).hexdigest(), path="", desc="Added on the website (fictional)")
        self.cloud.create(media, blob={"bytes": data, "content_type": "image/jpeg"})
        proc, doc = self.hfy("pull", "--yes")
        self.assertEqual((proc.returncode, doc["result"]), (0, "ok"), proc.stdout + proc.stderr + json.dumps(doc["error"]))
        self.assertEqual(doc["counts"]["pulled"]["create"], 1)
        self.assertEqual(doc["counts"]["media_down"], 1)
        got = by_gid(self.local_objects(), "O0900")
        self.assertTrue(got["path"].startswith(self.media_root), got["path"])
        self.assertEqual(sha256_file(got["path"]), hashlib.sha256(data).hexdigest())
        self.assertEqual(self.table("SELECT handle, origin FROM media_local"), [(NEW_MEDIA_HANDLE, "cloud")])


class Faults(PullE2E):
    """AC3: a fault at each step boundary, as a raised failure (exit 70) and as a killed process; the next clean run converges."""

    def edits(self, with_media=False):
        self.website_edit_note()
        note = copy.deepcopy(self.projected[by_gid(self.projected, "N0004")["handle"]])
        note.update(handle=NEW_NOTE_HANDLE, gramps_id="N0900")
        set_text(note, "Created on the website.")
        self.cloud.create(note)
        if with_media:
            media = copy.deepcopy(self.projected["95c1e2e76d98047b229a3390d414"])
            with open(MEDIA_FIXTURE, "rb") as fh:
                self.media_bytes = fh.read()
            media.update(handle=NEW_MEDIA_HANDLE, gramps_id="O0900", checksum=hashlib.md5(self.media_bytes).hexdigest(), path="")
            self.cloud.create(media, blob={"bytes": self.media_bytes, "content_type": "image/jpeg"})

    def check_converged(self, tag, with_media):
        local = self.local_objects()
        self.assertEqual(by_gid(local, "N0004")["text"]["string"], "Edited on the website.", tag)
        self.assertEqual(len([o for o in local.values() if o.get("gramps_id") == "N0900"]), 1, "%s: the created note exists exactly once" % tag)
        if with_media:
            media = [o for o in local.values() if o.get("gramps_id") == "O0900"]
            self.assertEqual(len(media), 1, "%s: the created media object exists exactly once" % tag)
            self.assertEqual(sha256_file(media[0]["path"]), hashlib.sha256(self.media_bytes).hexdigest(), tag)
        proc, doc = self.hfy("check")
        self.assertEqual((proc.returncode, doc["result"]), (0, "ok"), "%s: a check after convergence finds nothing: %s" % (tag, proc.stdout + proc.stderr))
        self.assertEqual(doc["counts"]["pulled"], {"create": 0, "update": 0, "delete": 0}, tag)
        self.assertEqual(doc["counts"]["conflicts_open"], 0, tag)

    def fault_case(self, step, crash=False):
        with_media = step == "after_media"
        self.bring_up()
        self.settle()
        original = self.local_note_text()
        self.edits(with_media)
        self.opened_once()
        db_before, base_before = self.db_sha(), self.base_dump()
        tag = "%s%s" % ("crash:" if crash else "", step)
        proc, doc = self.hfy("pull", "--yes", HFY_SYNC_FAULT=("crash:" if crash else "") + step)
        if crash:
            self.assertEqual(proc.returncode, 70, "%s: a killed Gramps leaves no status.json of this run: %s" % (tag, proc.stdout + proc.stderr))
        else:
            self.assertEqual((proc.returncode, doc["result"]), (70, "failed"), "%s: %s" % (tag, proc.stdout + proc.stderr))
        if step != "after_commit" and step != "after_sidecar":
            self.assertEqual(self.local_note_text(), original, "%s: nothing is applied before the commit" % tag)
            self.assertEqual(self.db_sha(), db_before, "%s: the database file is untouched" % tag)
        else:
            self.assertEqual(self.local_note_text(), "Edited on the website.", "%s: the Gramps transaction did commit" % tag)
        if step != "after_sidecar":
            self.assertEqual(self.base_dump(), base_before, "%s: the base has not moved yet" % tag)
        else:
            self.assertNotEqual(self.base_dump(), base_before, "after_sidecar: the base moved")
        backups = os.path.join(C.S.tree_paths(self.dbid)["dir"], "backups")
        if step in ("mid_apply", "after_commit", "after_sidecar"):
            self.assertTrue([f for f in os.listdir(backups) if f.endswith(".sqlite") and not f.endswith(".sidecar.sqlite")], "%s: the backup stays" % tag)
        if step == "after_media":
            self.assertEqual([f for f in os.listdir(self.media_root)], [NEW_MEDIA_HANDLE + ".jpg"], "after_media: the file is down, the tree is not touched")
            self.assertEqual(os.listdir(backups), [], "after_media: the media come down before the backup")
        if crash:
            # a killed Gramps leaves its lock behind; the addon refuses to run on it (D01, and --force-unlock is D02) until Gramps
            # itself breaks it (its own "break the lock" prompt on the next open), which the test does by removing the file
            lock = os.path.join(self.dir, "lock")
            self.assertTrue(os.path.exists(lock), "%s: the killed run left Gramps' lock" % tag)
            stale, _ = self.hfy("pull", "--yes")
            self.assertEqual(stale.returncode, 75, "%s: a stale lock is refused until it is cleared" % tag)
            os.unlink(lock)
        done, doc2 = self.hfy("pull", "--yes")
        self.assertEqual((done.returncode, doc2["result"]), (0, "ok"), "%s: the next run converges: %s" % (tag, done.stdout + done.stderr + json.dumps(doc2["error"])))
        if step == "after_sidecar":
            self.assertEqual(doc2["counts"]["pulled"], {"create": 0, "update": 0, "delete": 0}, "after_sidecar: nothing is applied twice")
        self.check_converged(tag, with_media)
        if with_media:
            downloads = [e for e in self.server.entries() if e["method"] == "GET" and e["path"].startswith("/_s3/hfy-dev-media/media/")]
            self.assertEqual(len(downloads), 1, "after_media: the file is fetched once, the rerun finds it by its checksum")

    def test_after_the_snapshot(self):
        self.fault_case("after_snapshot")

    def test_after_the_backup(self):
        self.fault_case("after_backup")

    def test_in_the_middle_of_the_apply(self):
        self.fault_case("mid_apply")

    def test_after_the_commit_and_before_the_sidecar_update(self):
        self.fault_case("after_commit")

    def test_after_the_media_download(self):
        self.fault_case("after_media")

    def test_after_the_sidecar_update(self):
        self.fault_case("after_sidecar")

    def test_a_killed_process_in_the_middle_of_the_apply(self):
        self.fault_case("mid_apply", crash=True)

    def test_a_killed_process_after_the_commit(self):
        self.fault_case("after_commit", crash=True)


class Conflicts(PullE2E):
    """AC4, AC5, AC7, AC10: a conflict pins its path, and what the website and the desktop disagree about is never decided by a run."""

    def conflict_setup(self):
        self.bring_up()
        self.settle()
        self.local_edit_note("N0004", "The desktop's version.")
        self.cloud.edit("N0004", lambda o: set_text(o, "The website's version."))
        self.other = self.cloud.edit("N0001", lambda o: o.update(format=1 - o.get("format", 0)))

    def three_more(self, **env):
        handle = by_gid(self.local_objects(), "N0004")["handle"]
        local = json.dumps(self.local_objects()[handle], sort_keys=True)
        cloud = json.dumps(self.cloud.heads()[handle], sort_keys=True)
        for i in range(3):
            proc, doc = self.hfy("pull", "--yes", **env)
            self.assertEqual((proc.returncode, doc["result"], doc["counts"]["conflicts_open"]), (20, "partial", 1), "run %d: %s" % (i, proc.stdout + proc.stderr))
            self.assertEqual(json.dumps(self.local_objects()[handle], sort_keys=True), local, "run %d: the desktop side changed" % i)
            self.assertEqual(json.dumps(self.cloud.heads()[handle], sort_keys=True), cloud, "run %d: the website side changed" % i)
            self.assertEqual(doc["counts"]["push_pending"], 0, "run %d: the pinned path is not pushed" % i)
        return self.table("SELECT state, path, kind FROM conflicts")

    def test_a_parked_cli_conflict_stays_open_across_three_more_runs_with_both_sides_unchanged(self):
        self.conflict_setup()
        proc, doc = self.hfy("pull", "--yes")
        self.assertEqual((proc.returncode, doc["result"], doc["next_action"]), (20, "partial", "resolve_conflicts"), proc.stdout + proc.stderr)
        local = self.local_objects()
        self.assertEqual(by_gid(local, "N0001")["format"], self.other["format"], "everything else proceeds")
        self.assertEqual(by_gid(local, "N0004")["text"]["string"], "The desktop's version.")
        self.assertEqual(self.three_more(), [("parked", "/text", "field")])
        self.assertNotIn("version.", proc.stdout + proc.stderr + json.dumps(doc), "the CLI prints no field values")

    def test_a_skipped_gui_conflict_stays_open_across_three_more_runs_with_both_sides_unchanged(self):
        self.conflict_setup()
        proc, doc = self.hfy("pull", "--yes", HFY_SYNC_UI="sim")
        self.assertEqual((proc.returncode, doc["mode"], doc["result"]), (20, "gui", "partial"), proc.stdout + proc.stderr)
        self.assertEqual(self.three_more(HFY_SYNC_UI="sim"), [("open", "/text", "field")])

    def test_a_cloud_birth_year_change_over_a_local_day_and_month_is_never_applied(self):
        self.bring_up()
        self.settle()
        birth_gid = "E0001"
        handle = by_gid(self.local_objects(), birth_gid)["handle"]
        local_before = json.dumps(self.local_objects()[handle], sort_keys=True)

        def move_year(o):
            o["date"]["dateval"][2] = 1841
        self.cloud.edit(birth_gid, move_year)
        proc, doc = self.hfy("pull", "--yes", "--allow-deletes")
        self.assertEqual((proc.returncode, doc["result"]), (20, "partial"), proc.stdout + proc.stderr)
        self.assertEqual([(c["kind"], c["path"]) for c in self.preview(doc)["conflicts"]], [("composite", "/date")])
        self.assertEqual(json.dumps(self.local_objects()[handle], sort_keys=True), local_before)
        self.assertEqual(doc["counts"]["pulled"], {"create": 0, "update": 0, "delete": 0})

    def test_an_incoming_tombstone_on_a_birth_event_with_a_local_day_and_month_is_a_delete_edit_conflict(self):
        self.bring_up()
        self.settle()
        objs = self.local_objects()
        birth = by_gid(objs, "E0001")
        owner = next(o for o in self.cloud.heads().values() if o["class"] == "Person" and any(r["ref"] == birth["handle"] for r in o["obj"]["event_ref_list"]))
        person = copy.deepcopy(owner["obj"])
        keep = [r for r in person["event_ref_list"] if r["ref"] != birth["handle"]]
        person["birth_ref_index"] = -1 if person["birth_ref_index"] == next(i for i, r in enumerate(person["event_ref_list"]) if r["ref"] == birth["handle"]) else person["birth_ref_index"]
        person["event_ref_list"] = keep
        if person["death_ref_index"] >= len(keep):
            person["death_ref_index"] = -1
        self.cloud.delete_with([person], "Event", birth["handle"])
        for allow in ("", "--allow-deletes"):
            proc, doc = self.hfy("pull", "--yes", *([allow] if allow else []))
            self.assertEqual((proc.returncode, doc["result"]), (20, "partial"), "%s: %s" % (allow, proc.stdout + proc.stderr))
            self.assertIn(("delete_edit", "has desktop-only data"), [(c["kind"], c["reason"]) for c in self.preview(doc)["conflicts"]])
            event = self.local_objects()[birth["handle"]]
            self.assertEqual(event["date"]["dateval"][:3], birth["date"]["dateval"][:3], "the event and its day and month are still in the tree")


class Reverts(PullE2E):
    """AC9 (covers D43): a push that returns a pulled field to its pre-pull value is labelled, and the CLI parks it instead of sending it."""

    def test_a_local_edit_back_to_the_pre_pull_value_is_labelled_a_revert_and_the_cli_parks_it(self):
        self.bring_up()
        self.settle()
        original = self.local_note_text()
        self.website_edit_note()
        self.opened_once()
        proc, doc = self.hfy("pull", "--yes")
        self.assertEqual((proc.returncode, doc["result"]), (0, "ok"), proc.stdout + proc.stderr)
        self.local_edit_note("N0004", original)  # Undo in Gramps, or a stale editor
        before = self.cloud_digest()
        proc, doc = self.hfy("check")
        self.assertEqual(proc.returncode, 10, proc.stdout + proc.stderr)
        pv = self.preview(doc)
        self.assertEqual([(o["op"], o["label"], o["disposition"]) for o in pv["to_website"]], [("update", "reverts a website change (origin)", "parked")])
        self.assertEqual(pv["planned_push"], {"create": 0, "update": 0, "delete": 0})
        done, doc2 = self.hfy("sync", "--yes")
        self.assertNotEqual(done.returncode, 0, "a parked revert is not a clean run")
        self.assertEqual(self.cloud_digest(), before, "nothing was pushed")


class Privacy(PullE2E):
    """AC6: a pulled Date that shows a local date of birth is never applied; the CLI says how many, never which."""

    def test_a_pulled_date_that_shows_a_local_date_of_birth_is_skipped_counted_and_offered_an_expunge(self):
        self.bring_up()
        self.settle()
        template = copy.deepcopy(self.projected[by_gid(self.projected, "E0002")["handle"]])
        local_birth = by_gid(self.local_objects(), "E0001")["date"]["dateval"]
        template.update(handle=NEW_EVENT_HANDLE, gramps_id="E0900")
        template["date"]["dateval"] = list(local_birth)
        self.cloud.create(template)
        proc, doc = self.hfy("pull", "--yes")
        self.assertEqual((proc.returncode, doc["result"], doc["next_action"]), (20, "partial", "review_incidents"), proc.stdout + proc.stderr)
        self.assertEqual(doc["counts"]["privacy_incidents"], 1)
        self.assertNotIn(NEW_EVENT_HANDLE, self.local_objects(), "the object is not applied")
        text = proc.stdout + proc.stderr + json.dumps(doc) + open(C.S.tree_paths(self.dbid)["status"], encoding="utf-8").read()
        for needle in (NEW_EVENT_HANDLE, "E0900", str(local_birth[2]), "Feb"):
            self.assertNotIn(needle, text, "status.json and the CLI carry counts only")
        offer = self.preview(doc)["incidents"][0]["offer"]
        self.assertEqual((offer["op"], offer["reason"], offer["expunge"], offer["handle"]), ("withdraw", "private", True, NEW_EVENT_HANDLE))
        self.assertEqual(self.table("SELECT class, rule, state FROM incidents"), [("Event", "scan.dob_exact", "open")])
        again, doc2 = self.hfy("pull", "--yes")
        self.assertEqual((again.returncode, doc2["counts"]["privacy_incidents"]), (20, 1))


class Expunge(PullE2E):
    """AC12: a scrub in place (same version, another hash) refreshes the base and the local value is held, never re-pushed."""

    def test_a_scrubbed_head_refreshes_the_base_and_holds_the_local_value(self):
        self.bring_up()
        self.settle()
        note = self.cloud.get("N0004")
        handle = note["handle"]
        original = self.local_note_text()
        version_before = self.cloud.version_of(handle)
        set_text(note, "[removed]")
        done = self.cloud.scrub(note)
        self.assertEqual(done["version"], version_before)
        self.assertEqual(self.cloud.version_of(handle), version_before, "a scrub does not move the version")
        proc, doc = self.hfy("check")
        self.assertEqual((proc.returncode, doc["result"]), (10, "changes_pending"), proc.stdout + proc.stderr)
        self.assertEqual(self.preview(doc)["expunge_notices"][0]["paths"], ["/text/string"])
        proc, doc = self.hfy("pull", "--yes")
        self.assertEqual((proc.returncode, doc["result"]), (0, "ok"), proc.stdout + proc.stderr + json.dumps(doc["error"]))
        row = [r for r in self.base_dump() if r[1] == handle][0]
        self.assertIn("[removed]", row[5], "the base follows the scrubbed website copy")
        self.assertEqual(self.table("SELECT path, rule FROM holds WHERE handle = ?", handle), [("/text/string", "expunge.notice")])
        self.assertEqual(self.local_note_text(), original, "the local value is untouched")
        proc, doc = self.hfy("check")
        self.assertEqual((proc.returncode, self.preview(doc)["to_website"]), (0, []), "and it is not waiting to go back to the website")
        Conflicts.local_edit_note(self, "N0004", "The desktop rewrote the held note.")
        proc, doc = self.hfy("check")
        self.assertEqual(self.preview(doc)["to_website"], [], "even after the desktop edits the held path")
        self.assertEqual(self.cloud.get("N0004")["text"]["string"], "[removed]", "the cloud still holds the scrubbed value")


class Restore(PullE2E):
    """AC8: `hfy-sync restore <backup>` puts the database and the sidecar of that moment back, and the check after it pushes nothing."""

    def test_restore_returns_the_tree_and_the_sidecar_and_the_check_pushes_no_reverts_and_no_deletes(self):
        self.bring_up()
        self.settle()
        original = self.local_note_text()
        base_before = self.base_dump()
        self.website_edit_note()
        self.opened_once()
        proc, doc = self.hfy("pull", "--yes")
        self.assertEqual((proc.returncode, doc["result"]), (0, "ok"), proc.stdout + proc.stderr)
        self.assertEqual(self.local_note_text(), "Edited on the website.")
        self.assertNotEqual(self.base_dump(), base_before)
        backup = doc["backup"]
        name = os.path.basename(backup)[:-len(".sqlite")]

        lock = os.path.join(self.dir, "lock")
        with open(lock, "w", encoding="utf-8") as fh:
            fh.write("held\n")
        refused, rdoc = self.hfy("restore", name)
        self.assertEqual(refused.returncode, 75, refused.stdout + refused.stderr)
        self.assertEqual(self.local_note_text(), "Edited on the website.", "a locked tree is not touched")
        os.unlink(lock)
        bad, _ = self.hfy("restore", "no-such-backup")
        self.assertEqual(bad.returncode, 64)

        seq_before_restore = max([e["seq"] for e in self.server.entries()] or [0])
        proc, doc = self.hfy("restore", name)
        self.assertEqual(proc.returncode, 10, "the dry-run check after a restore finds the website change again: %s" % (proc.stdout + proc.stderr))
        self.assertEqual((doc["action"], doc["dry_run"], doc["result"]), ("check", True, "changes_pending"))
        self.assertEqual(self.local_note_text(), original, "the database of that moment is back")
        self.assertEqual(self.base_dump(), base_before, "and so is the sidecar saved with that backup")
        pv = self.preview(doc)
        self.assertEqual(pv["to_website"], [], "0 reverts and 0 deletes go to the website")
        self.assertEqual(doc["counts"]["push_pending"], 0)
        self.assertEqual([c["path"] for c in pv["from_website"][0]["changes"]], ["/text/string"])
        aside = [d for d in os.listdir(self.dir) if d.startswith("pre-restore-")]
        self.assertEqual(len(aside), 1, "the files that were moved aside are kept")
        self.assertTrue(os.path.isfile(os.path.join(self.dir, aside[0], "sqlite.db")))
        # nothing was written to the website by any of it: no push batch after the restore began
        self.assertEqual([e["seq"] for e in self.server.requests(method="POST", path="/api/sync/batches") if e["seq"] > seq_before_restore], [])


class ReviewedPlan(PullE2E):
    """AC9: `sync --yes --plan <run_id>` applies only the plan that was reviewed."""

    def test_a_plan_that_changed_since_the_review_exits_10_and_applies_nothing(self):
        self.bring_up()
        self.settle()
        self.website_edit_note()
        self.opened_once()
        proc, reviewed = self.hfy("check")
        self.assertEqual(proc.returncode, 10)
        self.cloud.edit("N0001", lambda o: o.update(format=1))  # approved after the review
        before = self.db_sha()
        proc, doc = self.hfy("sync", "--yes", "--plan", reviewed["run_id"])
        self.assertEqual((proc.returncode, doc["result"]), (10, "changes_pending"), proc.stdout + proc.stderr)
        self.assertEqual(doc["error"]["code"], "plan_changed")
        self.assertEqual(self.db_sha(), before, "nothing was applied")
        self.assertIsNone(doc["backup"])
        proc, fresh = self.hfy("check")
        proc, doc = self.hfy("sync", "--yes", "--plan", fresh["run_id"])
        self.assertEqual((proc.returncode, doc["result"]), (0, "ok"), proc.stdout + proc.stderr + json.dumps(doc["error"]))
        self.assertEqual(doc["counts"]["pulled"]["update"], 2)
        unknown, _ = self.hfy("sync", "--yes", "--plan", "01ARZ3NDEKTSV4RRFFQ69G5FAV")
        self.assertEqual(unknown.returncode, 64, "a run id with no preview is a usage error")


if __name__ == "__main__":
    unittest.main()
