"""Gramps-integration tests of the hfy_sync addon skeleton (HFY-TSK-179), on copies of the fixture tree only.

Run by run.sh inside the bundled Python, against a throwaway GRAMPSHOME and HOME. The addon is installed with
gramps/scripts/install-addon.sh into that home's plugins folder, then driven the way io drives it:
`Gramps -O <tree> -a tool -p name=hfy_sync,...` and the `hfy-sync` wrapper. Every test gets its own copy of the fixture tree
(fixture_trees.fresh_copy), so a refusal test can lock, retag or damage its copy freely. The real Gramps folders are forbidden
to the audit hook for the whole run (run.sh), and the sync state lands under the temporary HOME.
"""
import fcntl
import hashlib
import json
import os
import shutil
import sqlite3
import stat
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "fixtures"))
import addon_support as S  # noqa: E402
import fixture_trees as ft  # noqa: E402

GRAMPSHOME = os.environ.get("GRAMPSHOME", "")
TREE = os.environ.get("HFY_TREE_NAME", "")

# sync.md 4.3, transcribed by hand: table -> [(column, type, not null, primary key position)]
SIDECAR_DESIGN = {
    "meta": [("key", "TEXT", 0, 1), ("value", "TEXT", 1, 0)],
    "base": [("class", "TEXT", 1, 1), ("handle", "TEXT", 1, 2), ("version", "INTEGER", 1, 0), ("seq", "INTEGER", 1, 0),
             ("hash", "TEXT", 1, 0), ("obj_json", "TEXT", 0, 0), ("deleted", "INTEGER", 1, 0)],
    "outbox": [("batch_key", "TEXT", 0, 1), ("session_id", "TEXT", 0, 0), ("created_at", "TEXT", 1, 0), ("state", "TEXT", 1, 0),
               ("request_json", "TEXT", 1, 0), ("response_json", "TEXT", 0, 0), ("attempts", "INTEGER", 1, 0)],
    "conflicts": [("id", "TEXT", 0, 1), ("class", "TEXT", 0, 0), ("handle", "TEXT", 0, 0), ("path", "TEXT", 0, 0),
                  ("kind", "TEXT", 0, 0), ("base_json", "TEXT", 0, 0), ("cloud_json", "TEXT", 0, 0), ("local_json", "TEXT", 0, 0),
                  ("state", "TEXT", 0, 0), ("decision", "TEXT", 0, 0), ("cloud_conflict_id", "TEXT", 0, 0),
                  ("detected_at", "TEXT", 0, 0), ("resolved_at", "TEXT", 0, 0)],
    "holds": [("class", "TEXT", 0, 1), ("handle", "TEXT", 0, 2), ("path", "TEXT", 0, 3), ("rule", "TEXT", 0, 4),
              ("detail", "TEXT", 0, 0), ("first_seen", "TEXT", 0, 0)],
    "media_local": [("handle", "TEXT", 0, 1), ("path", "TEXT", 0, 0), ("md5", "TEXT", 0, 0), ("sha256", "TEXT", 0, 0),
                    ("size", "INTEGER", 0, 0), ("origin", "TEXT", 0, 0)],
    "id_map": [("class", "TEXT", 0, 0), ("handle", "TEXT", 0, 0), ("old_id", "TEXT", 0, 0), ("new_id", "TEXT", 0, 0),
               ("kind", "TEXT", 0, 0), ("at", "TEXT", 0, 0)],
    "runs": [("run_id", "TEXT", 0, 1), ("action", "TEXT", 0, 0), ("mode", "TEXT", 0, 0), ("started_at", "TEXT", 0, 0),
             ("finished_at", "TEXT", 0, 0), ("result", "TEXT", 0, 0), ("exit_code", "INTEGER", 0, 0), ("counts_json", "TEXT", 0, 0),
             ("error_json", "TEXT", 0, 0), ("backup_path", "TEXT", 0, 0)],
}


def _gramps():
    try:
        from gramps.gen.db import DbTxn
        from gramps.gen.db.utils import make_database
        return DbTxn, make_database
    except ImportError:
        return None


@unittest.skipUnless(GRAMPSHOME and TREE, "run through gramps/tests/gramps/run.sh")
class AddonCase(unittest.TestCase):
    """Base class: the addon installed once, a private tree copy and a clean sync state per test."""

    @classmethod
    def setUpClass(cls):
        cls.install_log = S.install_addon()
        cls.ps_file = os.path.join(tempfile.mkdtemp(prefix="hfy-ps-"), "ps.txt")
        with open(cls.ps_file, "w", encoding="utf-8") as fh:
            fh.write("/usr/sbin/cron\n/sbin/launchd\n")  # a process list with no Gramps GUI in it
        cls.old_ps = os.environ.get("HFY_SYNC_PS_CMD")
        cls.old_test = os.environ.get("HFY_SYNC_TEST")
        os.environ["HFY_SYNC_TEST"] = "1"  # the process-list override is honoured only under this flag
        os.environ["HFY_SYNC_PS_CMD"] = "cat %s" % cls.ps_file  # never depend on a Gramps window io has open

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(os.path.dirname(cls.ps_file), ignore_errors=True)
        if cls.old_ps is None:
            os.environ.pop("HFY_SYNC_PS_CMD", None)
        else:
            os.environ["HFY_SYNC_PS_CMD"] = cls.old_ps
        if cls.old_test is None:
            os.environ.pop("HFY_SYNC_TEST", None)
        else:
            os.environ["HFY_SYNC_TEST"] = cls.old_test

    def setUp(self):
        S.reset_config()
        self.dir, self.name, self.dbid = self.new_tree()

    def new_tree(self, suffix=""):
        """A private copy of the fixture tree: (directory, tree name, dbid). Its sync state is removed when the test ends."""
        if suffix:
            name = "%s-%s-%s" % (TREE, self.id(), suffix)
            path = ft.copy_tree(GRAMPSHOME, ft.TEMPLATE, name)
            self.addCleanup(shutil.rmtree, path, True)
        else:
            path = ft.fresh_copy(self, GRAMPSHOME)
        dbid = os.path.basename(path)
        self.addCleanup(shutil.rmtree, S.tree_paths(dbid)["dir"], True)
        with open(os.path.join(path, "name.txt"), encoding="utf-8") as fh:
            return path, fh.read().strip(), dbid

    def cli(self, options, name=None, **kw):
        run_id = "t" + hashlib.sha1(("%s%s" % (self.id(), options)).encode()).hexdigest()[:24]
        return S.run_gramps(name or self.name, "name=hfy_sync,%s,run_id=%s" % (options, run_id), **kw), run_id

    def status(self, dbid=None):
        return S.read_status(dbid or self.dbid)

    def bind(self, name=None):
        proc = S.run_wrapper(["bind", "--yes", "--tree", name or self.name])
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)

    def sync_base(self, dbid=None, tree_dir=None):
        """Fills the sidecar's `base` with every handle in the tree: what a completed first sync would have left."""
        rows = [(t.capitalize(), h, 1, 1, "x", None, 0) for t, h, _gid in ft.identities(tree_dir or self.dir)]
        con = sqlite3.connect(S.tree_paths(dbid or self.dbid)["sidecar"])
        try:
            con.executemany("INSERT INTO base (class, handle, version, seq, hash, obj_json, deleted) VALUES (?, ?, ?, ?, ?, ?, ?)", rows)
            con.commit()
        finally:
            con.close()
        return len(rows)

    def edit(self, fn, tree_dir=None):
        """Opens the tree with the Gramps API, calls fn(db, DbTxn) and closes it. Only while no CLI run holds the tree."""
        DbTxn, make_database = _gramps()
        db = make_database("sqlite")
        db.load(tree_dir or self.dir)
        try:
            return fn(db, DbTxn)
        finally:
            db.close()


class Registration(AddonCase):
    def test_tool_is_registered_under_family_tree_processing(self):
        try:
            from gramps.gen.const import PLUGINS_DIR, USER_PLUGINS
            from gramps.gen.plug import BasePluginManager
            from gramps.gen.plug._pluginreg import TOOL_DBPROC, TOOL_MODE_CLI, TOOL_MODE_GUI
            from gramps.gui.plug.tool import tool_categories
        except ImportError:
            self.skipTest("needs the bundled Gramps")
        self.assertTrue(os.path.realpath(USER_PLUGINS).startswith(os.path.realpath(GRAMPSHOME)), USER_PLUGINS)
        self.assertTrue(os.path.isfile(os.path.join(USER_PLUGINS, "hfy_sync", "hfy_sync.gpr.py")))
        pmgr = BasePluginManager.get_instance()
        pmgr.reg_plugins(PLUGINS_DIR, None, None)
        pmgr.reg_plugins(USER_PLUGINS, None, None, load_on_reg=True)
        gui = {p.id: p for p in pmgr.get_reg_tools(gui=True)}
        cli = {p.id: p for p in pmgr.get_reg_tools(gui=False)}
        self.assertIn("hfy_sync", gui)
        self.assertIn("hfy_sync", cli)
        pdata = gui["hfy_sync"]
        self.assertEqual(pdata.category, TOOL_DBPROC)
        self.assertEqual(tool_categories[pdata.category][1], "Family Tree Processing")
        self.assertEqual(sorted(pdata.tool_modes), sorted([TOOL_MODE_GUI, TOOL_MODE_CLI]))
        self.assertEqual(pdata.toolclass, "HfySyncTool")
        self.assertEqual(pdata.optionclass, "HfySyncOptions")
        self.assertEqual(pdata.gramps_target_version, "6.0")
        self.assertEqual(pdata.name, "Website sync...")

    def test_the_installed_folder_is_self_contained(self):
        for rel in ("hfy_sync.gpr.py", "hfy_sync_tool.py", "hfy_sync_ui.py", "hfygramps/addon/runner.py",
                    "hfygramps/rules.py", "redaction/redaction-v1.json"):
            self.assertTrue(os.path.isfile(os.path.join(S.PLUGIN_DIR, rel)), rel)
        self.assertFalse(os.path.exists(os.path.join(S.PLUGIN_DIR, "hfygramps", "render")))
        self.assertIn("installed in", self.install_log)

    def test_the_tool_resolves_through_the_command_line(self):
        proc, run_id = self.cli("action=status")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertNotIn("Unknown tool name", proc.stderr)
        self.assertEqual(self.status()["run_id"], run_id)


class StatusAndWrapper(AddonCase):
    def test_status_writes_status_json_in_the_per_dbid_folder(self):
        proc, run_id = self.cli("action=status")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        path = S.tree_paths(self.dbid)["status"]
        self.assertTrue(path.startswith(os.path.realpath(os.environ["HOME"])) or path.startswith(os.environ["HOME"]))
        self.assertEqual(os.path.dirname(path), os.path.join(S.APP_SUPPORT, self.dbid))
        doc = self.status()
        self.assertEqual((doc["schema"], doc["run_id"], doc["action"], doc["mode"], doc["result"], doc["exit_code"]),
                         (1, run_id, "status", "cli", "ok", 0))
        self.assertEqual(doc["tree"], {"dbid": self.dbid, "bound": False})
        self.assertEqual(doc["next_action"], "none")
        self.assertIsNone(doc["error"])
        self.assertEqual(doc["versions"]["gramps"], "6.0.6")
        self.assertEqual(doc["versions"]["db_schema"], 21)
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(os.stat(os.path.dirname(path)).st_mode), 0o700)
        self.assertTrue(os.path.isfile(os.path.join(S.tree_paths(self.dbid)["logs"], "%s.log" % run_id)))

    def test_the_wrapper_exits_with_the_status_exit_code(self):
        proc = S.run_wrapper(["status", "--tree", self.name])
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("hfy-sync status: ok", proc.stdout)
        doc = self.status()
        self.assertEqual(doc["exit_code"], 0)
        # a refusal's exit code comes through too: bind without --yes is a dry run that found changes (10)
        dry = S.run_wrapper(["bind", "--tree", self.name])
        self.assertEqual(dry.returncode, 10, dry.stdout + dry.stderr)
        self.assertEqual(self.status()["result"], "changes_pending")

    def test_missing_or_stale_status_json_is_exit_70(self):
        marker_dir = tempfile.mkdtemp(prefix="hfy-fake-")
        self.addCleanup(shutil.rmtree, marker_dir, True)
        fake = os.path.join(marker_dir, "fake-gramps.sh")
        with open(fake, "w", encoding="utf-8") as fh:
            fh.write("#!/bin/sh\nexit 0\n")  # a Gramps that runs no tool and exits 0, as cli_tool does when a tool dies
        env = {"HFY_GRAMPS_CMD": "sh %s" % fake}
        # a status.json from an earlier run is on disk: its run_id is not this run's
        proc, _ = self.cli("action=status")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(self.status()["exit_code"], 0)
        stale = S.run_wrapper(["status", "--tree", self.name], env)
        self.assertEqual(stale.returncode, 70, stale.stdout + stale.stderr)
        self.assertIn("D41", stale.stderr)
        # and with no status.json at all
        os.unlink(S.tree_paths(self.dbid)["status"])
        missing = S.run_wrapper(["status", "--tree", self.name], env)
        self.assertEqual(missing.returncode, 70, missing.stdout + missing.stderr)

    def test_a_refusal_the_tool_writes_is_the_wrappers_exit_code_even_though_gramps_exits_0(self):
        """cli_tool swallows everything and Gramps exits 0; the wrapper's exit code still comes from status.json."""
        proc = S.run_wrapper(["status", "--tree", self.name], {"HFY_GRAMPS_CMD": "bash %s --cli -u" % S.SHIM})
        # `-u` is Gramps' --force-unlock, passed here behind the wrapper's back: the tool refuses with D02 (64)
        self.assertEqual(proc.returncode, 64, proc.stdout + proc.stderr)
        bare, _ = self.cli("action=status", extra=["-u"])
        self.assertEqual(bare.returncode, 0, "Gramps itself exits 0 whatever the tool decided")


class Refusals(AddonCase):
    def hold_open(self):
        """Opens the copy with the Gramps API and keeps it open: Gramps writes the same `lock` file the GUI writes."""
        DbTxn, make_database = _gramps()
        db = make_database("sqlite")
        db.load(self.dir)
        self.addCleanup(db.close)
        self.assertTrue(os.path.isfile(os.path.join(self.dir, "lock")))
        return db

    def test_tree_open_elsewhere_is_75_and_the_lock_is_left_alone(self):
        self.hold_open()
        proc = S.run_wrapper(["status", "--tree", self.name])
        self.assertEqual(proc.returncode, 75, proc.stdout + proc.stderr)
        doc = self.status()
        self.assertEqual((doc["result"], doc["exit_code"], doc["next_action"], doc["error"]["code"]),
                         ("refused", 75, "close_gramps", "D01"))
        self.assertTrue(os.path.isfile(os.path.join(self.dir, "lock")), "the wrapper must never touch the lock")
        # Gramps alone would refuse too, without writing any status: that is why the wrapper looks first
        bare, _ = self.cli("action=status")
        self.assertNotEqual(bare.returncode, 0)

    def test_a_gramps_window_in_the_process_list_is_75(self):
        ps = os.path.join(os.path.dirname(self.ps_file), "gui-ps.txt")
        with open(ps, "w", encoding="utf-8") as fh:
            fh.write("/sbin/launchd\n/Applications/Gramps.app/Contents/MacOS/Gramps\n"
                     "/Applications/Gramps.app/Contents/MacOS/Gramps -O other -a report\n")
        env = os.environ.copy()
        env["HFY_SYNC_PS_CMD"] = "cat %s" % ps
        proc, run_id = self.cli("action=status", env=env)
        doc = self.status()
        self.assertEqual((doc["run_id"], doc["exit_code"], doc["error"]["code"]), (run_id, 75, "D01"))

    def test_force_unlock_is_64_and_never_reaches_gramps(self):
        self.hold_open()
        proc = S.run_wrapper(["status", "--force-unlock", "--tree", self.name])
        self.assertEqual(proc.returncode, 64, proc.stdout + proc.stderr)
        self.assertEqual(self.status()["error"]["code"], "D02")
        self.assertTrue(os.path.isfile(os.path.join(self.dir, "lock")), "--force-unlock must not have broken the lock")

    def test_force_unlock_given_straight_to_gramps_is_64(self):
        # Gramps breaks the lock of this private copy before the tool starts; the tool still refuses
        for flag in ("-u", "--force-unlock"):
            proc, run_id = self.cli("action=status", extra=[flag])
            doc = self.status()
            self.assertEqual((doc["run_id"], doc["exit_code"], doc["result"], doc["error"]["code"]), (run_id, 64, "refused", "D02"), flag)

    def test_unsupported_database_schema_is_78_and_gramps_never_opens_the_tree(self):
        con = sqlite3.connect(os.path.join(self.dir, "sqlite.db"))
        try:
            con.execute("UPDATE metadata SET json_data = ? WHERE setting = 'version'", (json.dumps({"type": "str", "value": "22"}),))
            con.commit()
        finally:
            con.close()
        touched = tempfile.mkdtemp(prefix="hfy-fake-")
        self.addCleanup(shutil.rmtree, touched, True)
        fake = os.path.join(touched, "fake-gramps.sh")
        with open(fake, "w", encoding="utf-8") as fh:
            fh.write("#!/bin/sh\ntouch %s/started\n" % touched)
        before = ft.db_digest(self.dir)
        proc = S.run_wrapper(["status", "--tree", self.name], {"HFY_GRAMPS_CMD": "sh %s" % fake})
        self.assertEqual(proc.returncode, 78, proc.stdout + proc.stderr)
        doc = self.status()
        self.assertEqual((doc["result"], doc["exit_code"], doc["next_action"], doc["error"]["code"]), ("refused", 78, "update_addon", "D04"))
        self.assertFalse(os.path.exists(os.path.join(touched, "started")), "Gramps must not be started on an unsupported schema")
        self.assertEqual(ft.db_digest(self.dir), before, "the tree must be byte for byte as it was")

    def test_the_tool_itself_refuses_a_schema_or_gramps_series_it_does_not_know(self):
        try:
            sys.path.insert(0, S.PLUGIN_DIR)
            import hfy_sync_tool
            from hfygramps.addon import consts, runner
        except ImportError:
            self.skipTest("needs the bundled Gramps")
        finally:
            if S.PLUGIN_DIR in sys.path:
                sys.path.remove(S.PLUGIN_DIR)
        self.addCleanup(setattr, consts, "SUPPORTED_DB_SCHEMAS", consts.SUPPORTED_DB_SCHEMAS)
        self.addCleanup(setattr, consts, "GRAMPS_SERIES", consts.GRAMPS_SERIES)

        def run(db, DbTxn):
            return runner.run(hfy_sync_tool.GrampsTree(db), "cli", runner.Options("status"), run_id="in-process-%s" % consts.SUPPORTED_DB_SCHEMAS[0],
                              argv=["gramps"], environ=os.environ)

        consts.SUPPORTED_DB_SCHEMAS = (22,)  # as if Gramps 6.1 had moved the schema on
        doc = self.edit(run)
        self.assertEqual((doc["result"], doc["exit_code"], doc["error"]["code"], doc["next_action"]), ("refused", 78, "D04", "update_addon"))
        consts.SUPPORTED_DB_SCHEMAS = (21,)
        consts.GRAMPS_SERIES = (7, 0)
        doc = self.edit(run)
        self.assertEqual((doc["exit_code"], doc["error"]["code"]), (78, "D04"))

    def test_a_second_run_while_state_lock_is_held_is_75(self):
        proc, _ = self.cli("action=status")  # creates the folder
        self.assertEqual(proc.returncode, 0, proc.stderr)
        running = self.status()
        with open(S.tree_paths(self.dbid)["lock"], "a+") as fh:
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            wrapped = S.run_wrapper(["status", "--tree", self.name])
            self.assertEqual(wrapped.returncode, 75, wrapped.stdout + wrapped.stderr)
            self.assertIn("D14", wrapped.stdout)
            self.assertEqual(self.status(), running, "the refused run must not replace the status.json of the run that holds the lock")
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
        again = S.run_wrapper(["status", "--tree", self.name])
        self.assertEqual(again.returncode, 0, again.stdout + again.stderr)

    def test_a_missing_or_damaged_sidecar_is_78_and_nothing_is_rebuilt(self):
        self.bind()
        side = S.tree_paths(self.dbid)["sidecar"]
        keep = side + ".kept"
        shutil.move(side, keep)
        proc = S.run_wrapper(["status", "--tree", self.name])
        self.assertEqual(proc.returncode, 78, proc.stdout + proc.stderr)
        self.assertEqual((self.status()["error"]["code"], self.status()["next_action"]), ("D12", "rebase"))
        self.assertFalse(os.path.exists(side), "a missing sidecar must not be recreated by a status run")
        with open(side, "wb") as fh:
            fh.write(b"this is not a database" * 50)
        proc = S.run_wrapper(["status", "--tree", self.name])
        self.assertEqual(proc.returncode, 78, proc.stdout + proc.stderr)
        self.assertEqual(self.status()["error"]["code"], "D13")

    def test_push_is_not_in_this_build_and_the_pull_actions_ask_for_a_sign_in_before_any_network_call(self):
        self.bind()
        proc = S.run_wrapper(["push", "--tree", self.name])
        self.assertEqual(proc.returncode, 69, proc.stdout + proc.stderr)
        self.assertEqual(self.status()["error"]["code"], "not_enabled")
        # check, pull and sync exist now (HFY-TSK-205). Without a token they stop at the sign-in; the file keychain keeps the real
        # login Keychain out of the test, and no request leaves the machine.
        empty = os.path.join(tempfile.mkdtemp(prefix="hfy-nokey-"), "no-token")
        self.addCleanup(shutil.rmtree, os.path.dirname(empty), True)
        for action in ("sync", "pull", "check"):
            proc = S.run_wrapper([action, "--tree", self.name], {"HFY_SYNC_KEYCHAIN_FILE": empty})
            self.assertEqual(proc.returncode, 77, "%s: %s" % (action, proc.stdout + proc.stderr))
            self.assertEqual((self.status()["error"]["code"], self.status()["next_action"]), ("not_signed_in", "login"))


class Binding(AddonCase):
    def test_bind_dry_run_changes_nothing(self):
        proc, run_id = self.cli("action=bind,dry_run=1")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        doc = self.status()
        self.assertEqual((doc["result"], doc["exit_code"], doc["dry_run"]), ("changes_pending", 10, True))
        self.assertIsNone(S.tree_metadata(self.dir, "hfy_sync_tree_id"))
        self.assertFalse(os.path.exists(S.tree_paths(self.dbid)["sidecar"]))
        self.assertFalse(os.path.exists(S.tree_paths(self.dbid)["config"]))

    def test_bind_writes_the_tree_marker_the_sidecar_and_the_config(self):
        self.bind()
        marker = S.tree_metadata(self.dir, "hfy_sync_tree_id")
        self.assertRegex(marker or "", r"^[0-9a-f]{32}$")
        paths = S.tree_paths(self.dbid)
        with open(paths["config"], encoding="utf-8") as fh:
            cfg = json.load(fh)
        self.assertEqual((cfg["dbid"], cfg["tree_name"], cfg["server"]), (self.dbid, self.name, "https://harrisonfamily.us"))
        self.assertRegex(cfg["client_instance_id"], r"^[0-9a-f]{32}$")
        self.assertEqual(cfg["media_root"], "~/Pictures/hfy-sync-media")
        con = S.sqlite_ro(paths["sidecar"])
        try:
            meta = dict(con.execute("SELECT key, value FROM meta"))
        finally:
            con.close()
        self.assertEqual(meta["tree_id"], marker)
        self.assertEqual(meta["dbid"], self.dbid)
        self.assertEqual(meta["sidecar_schema"], "1")
        self.assertEqual(meta["last_pull_seq"], "0")
        self.assertEqual(meta["client_instance_id"], cfg["client_instance_id"])
        self.assertEqual(meta["redaction_version"], "1")
        doc = self.status()
        self.assertEqual((doc["tree"], doc["result"]), ({"dbid": self.dbid, "bound": True}, "ok"))
        # binding again is a no-op
        self.bind()
        self.assertEqual(S.tree_metadata(self.dir, "hfy_sync_tree_id"), marker)

    def test_the_sidecar_has_the_design_ddl_and_passes_integrity_check(self):
        self.bind()
        side = S.tree_paths(self.dbid)["sidecar"]
        self.assertTrue(side.startswith(os.path.join(S.APP_SUPPORT, self.dbid) + os.sep))
        self.assertEqual(stat.S_IMODE(os.stat(side).st_mode), 0o600)
        con = S.sqlite_ro(side)
        try:
            self.assertEqual(con.execute("PRAGMA integrity_check").fetchone()[0], "ok")
            tables = sorted(r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type = 'table'"))
            self.assertEqual(tables, sorted(SIDECAR_DESIGN))
            for table, want in SIDECAR_DESIGN.items():
                got = [(r[1], r[2], r[3], r[5]) for r in con.execute("PRAGMA table_info(%s)" % table)]
                self.assertEqual(got, want, table)
            self.assertEqual(con.execute("PRAGMA journal_mode").fetchone()[0], "delete")
            ddl = {r[0]: r[1] for r in con.execute("SELECT name, sql FROM sqlite_master WHERE name = 'outbox'")}
            self.assertIn("CHECK (state IN ('pending','sent','acked','rejected'))", ddl["outbox"])
            self.assertIn("deleted INTEGER NOT NULL DEFAULT 0", [s for s in
                          [r[0] for r in con.execute("SELECT sql FROM sqlite_master WHERE name = 'base'")]][0])
        finally:
            con.close()
        # the run was recorded in the sidecar it just made
        con = S.sqlite_ro(side)
        try:
            self.assertEqual(con.execute("SELECT COUNT(*) FROM runs WHERE action = 'bind' AND result = 'ok'").fetchone()[0], 1)
        finally:
            con.close()

    def test_a_failed_bind_leaves_the_tree_without_a_marker(self):
        try:
            sys.path.insert(0, S.PLUGIN_DIR)
            import hfy_sync_tool
        except ImportError:
            self.skipTest("needs the bundled Gramps")
        finally:
            if S.PLUGIN_DIR in sys.path:
                sys.path.remove(S.PLUGIN_DIR)

        def boom():
            raise RuntimeError("sidecar could not be made")

        def attempt(db, DbTxn):
            with self.assertRaises(RuntimeError):
                hfy_sync_tool.GrampsTree(db).bind("a" * 32, boom)

        self.edit(attempt)
        self.assertIsNone(S.tree_metadata(self.dir, "hfy_sync_tree_id"), "the marker must roll back with the failed bind")

    def test_wrong_tree_binding_is_78(self):
        self.bind()
        other_dir, other_name, other_dbid = self.new_tree("other")
        proc = S.run_wrapper(["status", "--tree", other_name])
        self.assertEqual(proc.returncode, 78, proc.stdout + proc.stderr)
        doc = S.read_status(other_dbid)
        self.assertEqual((doc["result"], doc["error"]["code"], doc["next_action"], doc["tree"]["bound"]), ("refused", "D03", "open_bound_tree", False))
        # the bound tree itself still syncs
        self.assertEqual(S.run_wrapper(["status", "--tree", self.name]).returncode, 0)
        # and bind will not move the binding to another tree
        proc = S.run_wrapper(["bind", "--yes", "--tree", other_name])
        self.assertEqual(proc.returncode, 78, proc.stdout + proc.stderr)
        self.assertIsNone(S.tree_metadata(other_dir, "hfy_sync_tree_id"))

    def test_local_creates_and_deletes_between_syncs_never_trigger_d03(self):
        self.bind()
        total = self.sync_base()
        before = {(t, h) for t, h, _g in ft.identities(self.dir)}

        def edit(db, DbTxn):
            from gramps.gen.lib import Name, Person, Surname
            events = sorted(db.get_event_handles())[:5]
            people = sorted(db.get_person_handles())[:3]
            with DbTxn("local edits", db) as trans:
                for h in events:
                    db.remove_event(h, trans)
                for h in people:
                    db.remove_person(h, trans)
                for i in range(6):
                    p = Person()
                    nm = Name()
                    sn = Surname()
                    sn.set_surname("Fixture%d" % i)
                    nm.add_surname(sn)
                    p.set_primary_name(nm)
                    db.add_person(p, trans)
            return len(events) + len(people)

        removed = self.edit(edit)
        after = {(t, h) for t, h, _g in ft.identities(self.dir)}
        self.assertNotEqual(before, after, "the handle set changed, so a hash-of-handles binding would have tripped")
        self.assertLess(removed * 100, total * 10, "the test must stay under the 10 percent line")
        proc = S.run_wrapper(["status", "--tree", self.name])
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        doc = self.status()
        self.assertEqual((doc["result"], doc["tree"]["bound"]), ("ok", True))

    def test_swapping_in_a_different_tree_triggers_d03(self):
        self.bind()
        self.sync_base()
        kept = os.path.join(self.dir, "sqlite.db.bound")
        shutil.copyfile(os.path.join(self.dir, "sqlite.db"), kept)
        # a different fixture tree in the same folder: same dbid, but never bound, so it has no marker
        other_dir, _other_name, _other_dbid = self.new_tree("swap")
        shutil.copyfile(os.path.join(other_dir, "sqlite.db"), os.path.join(self.dir, "sqlite.db"))
        proc = S.run_wrapper(["status", "--tree", self.name])
        self.assertEqual(proc.returncode, 78, proc.stdout + proc.stderr)
        doc = self.status()
        self.assertEqual((doc["error"]["code"], doc["tree"]["bound"]), ("D03", False))
        # put the bound tree back: it is the bound tree again
        shutil.copyfile(kept, os.path.join(self.dir, "sqlite.db"))
        proc = S.run_wrapper(["status", "--tree", self.name])
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)

    def test_a_tree_with_the_marker_but_most_handles_gone_triggers_d03(self):
        """The similarity guard: a copy that kept the marker but is a different tree (a re-import, an old export) is refused."""
        self.bind()
        self.sync_base()

        def wipe(db, DbTxn):
            with DbTxn("wipe the events", db) as trans:
                for h in list(db.get_event_handles()):
                    db.remove_event(h, trans)

        self.edit(wipe)
        self.assertEqual(S.tree_metadata(self.dir, "hfy_sync_tree_id") is not None, True)
        proc = S.run_wrapper(["status", "--tree", self.name])
        self.assertEqual(proc.returncode, 78, proc.stdout + proc.stderr)
        self.assertEqual(self.status()["error"]["code"], "D03")

    def test_the_run_log_and_status_hold_no_object_content(self):
        self.bind()
        proc, run_id = self.cli("action=status")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        def read(path):
            with open(path, encoding="utf-8") as fh:
                return fh.read()

        texts = [read(S.tree_paths(self.dbid)["status"])]
        logs = S.tree_paths(self.dbid)["logs"]
        texts += [read(os.path.join(logs, n)) for n in os.listdir(logs)]
        names = set()
        for o in ft.json_objects(self.dir).values():
            for n in o.get("primary_name", {}).get("surname_list", []):
                if n.get("surname"):
                    names.add(n["surname"])
        self.assertTrue(names)
        for text in texts:
            for n in names:
                self.assertNotIn(n, text)


class GuiMode(AddonCase):
    """The GUI path of the tool without a display: a stand-in for uistate, and the dialog function replaced by a recorder."""

    def load_modules(self):
        try:
            sys.path.insert(0, S.PLUGIN_DIR)
            import hfy_sync_tool
            import hfy_sync_ui
        except ImportError:
            self.skipTest("needs the bundled Gramps")
        finally:
            if S.PLUGIN_DIR in sys.path:
                sys.path.remove(S.PLUGIN_DIR)
        return hfy_sync_tool, hfy_sync_ui

    def test_gui_run_reports_in_gui_mode_and_offers_the_bind(self):
        from types import SimpleNamespace
        tool, ui = self.load_modules()
        shown = []
        self.addCleanup(setattr, ui, "present", ui.present)
        ui.present = lambda parent, doc, actions: shown.append((parent, doc, actions))
        # a Gramps window in the process list does not stop the tool inside that window
        ps = os.path.join(os.path.dirname(self.ps_file), "gui-ps.txt")
        with open(ps, "w", encoding="utf-8") as fh:
            fh.write("/Applications/Gramps.app/Contents/MacOS/Gramps\n")
        self.addCleanup(os.environ.__setitem__, "HFY_SYNC_PS_CMD", os.environ["HFY_SYNC_PS_CMD"])
        os.environ["HFY_SYNC_PS_CMD"] = "cat %s" % ps
        user = SimpleNamespace(uistate=SimpleNamespace(window="the-window"))

        def go(db, DbTxn):
            tool.HfySyncTool(SimpleNamespace(db=db), user, tool.HfySyncOptions, "hfy_sync", None)
            self.assertEqual(len(shown), 1)
            parent, doc, actions = shown[0]
            self.assertEqual(parent, "the-window")
            self.assertEqual((doc["mode"], doc["action"], doc["result"], doc["tree"]["bound"]), ("gui", "status", "ok", False))
            bound = actions["bind"]()
            self.assertEqual((bound["mode"], bound["action"], bound["result"], bound["tree"]["bound"]), ("gui", "bind", "ok", True))

        self.edit(go)
        self.assertRegex(S.tree_metadata(self.dir, "hfy_sync_tree_id") or "", r"^[0-9a-f]{32}$")

    def test_the_dialog_text_is_codes_and_counts(self):
        _tool, ui = self.load_modules()
        text = ui.describe({"tree": {"bound": False}, "result": "refused",
                            "error": {"code": "D03", "message": "Open the bound tree."},
                            "versions": {"addon": "0.1.0", "gramps": "6.0.6", "db_schema": 21}})
        self.assertIn("not bound", text)
        self.assertIn("D03: Open the bound tree.", text)
        self.assertIn("Addon 0.1.0, Gramps 6.0.6, database schema 21.", text)
        self.assertIn("Nothing needs attention", ui.describe({"tree": {"bound": True}, "result": "ok"}))


if __name__ == "__main__":
    unittest.main(verbosity=2)
