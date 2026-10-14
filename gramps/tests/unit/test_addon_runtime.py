"""The desktop addon's runtime (task addon-skeleton): gramps/hfygramps/addon/. Standard library only; no Gramps.

    python3 -m unittest discover gramps/tests/unit

A fake tree stands in for the open Gramps database, so every refusal, the binding rules and the bind flow run in CI. The same
cases run against real fixture-tree copies in gramps/tests/gramps/test_addon_skeleton.py (local macOS). Every name and value
here is invented.
"""
import os
import re
import shutil
import sqlite3
import stat
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
sys.path.insert(0, os.path.join(REPO, "gramps"))

from hfygramps.addon import binding, consts, paths, preflight, runner, sidecar, status  # noqa: E402


def handles(n_person=40, n_event=40, n_family=10, n_place=10):
    out = set()
    for cls, n in (("Person", n_person), ("Event", n_event), ("Family", n_family), ("Place", n_place)):
        out |= {(cls, "%s%04d" % (cls[0].lower(), i)) for i in range(n)}
    return out


class FakeTree(runner.TreeAccess):
    """What the Gramps tool builds from the open database, held in memory. `bind` is transactional like the DbTxn."""

    def __init__(self, dbid="aa11bb22", name="Fixture Tree", schema=21, series=(6, 0), objs=None, marker=None):
        self.dbid, self.name, self.schema_version, self.gramps_series = dbid, name, schema, series
        self.gramps_version = "6.0.6"
        self.objs = set(objs if objs is not None else handles())
        self.marker = marker
        self.fail_handles = False

    def read_marker(self):
        return self.marker

    def handles(self):
        if self.fail_handles:
            raise RuntimeError("boom")
        return set(self.objs)

    def bind(self, tree_id, also):
        old = self.marker
        self.marker = tree_id
        try:
            also()
        except BaseException:
            self.marker = old
            raise


class HomeCase(unittest.TestCase):
    """A temporary HOME and GRAMPSHOME; nothing else is ever touched."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="hfy-addon-unit-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.env = {"HOME": self.tmp, "GRAMPSHOME": os.path.join(self.tmp, "gh"), "HFY_SYNC_TEST": "1", "HFY_SYNC_PS_CMD": "true"}

    def run_tool(self, tree, action="status", mode="cli", argv=("gramps",), run_id=None, **opts):
        return runner.run(tree, mode, runner.Options(action, **opts), run_id=run_id, argv=list(argv), environ=self.env)

    def tp(self, tree):
        return paths.TreePaths(tree.dbid, self.env)

    def bound_tree(self, **kw):
        tree = FakeTree(**kw)
        doc = self.run_tool(tree, "bind", yes=True)
        self.assertEqual((doc["result"], doc["exit_code"]), ("ok", 0), doc)
        return tree

    def fill_base(self, tree):
        con = sqlite3.connect(self.tp(tree).sidecar)
        con.executemany("INSERT INTO base VALUES (?, ?, 1, 1, 'x', NULL, 0)", sorted(tree.objs))
        con.commit()
        con.close()


class Constants(unittest.TestCase):
    def test_exit_codes_are_the_design_table(self):  # sync.md 8.7
        self.assertEqual(
            (consts.EXIT_OK, consts.EXIT_DRY_RUN_CHANGES, consts.EXIT_PARTIAL, consts.EXIT_USAGE, consts.EXIT_SERVER_REFUSED,
             consts.EXIT_NOT_ENABLED, consts.EXIT_INTERNAL, consts.EXIT_TEMPORARY, consts.EXIT_SIGN_IN, consts.EXIT_CONFIG),
            (0, 10, 20, 64, 65, 69, 70, 75, 77, 78))

    def test_refusals_match_the_error_catalog(self):  # sync.md 17
        want = {"D01": (75, "close_gramps"), "D02": (64, "none"), "D03": (78, "open_bound_tree"), "D04": (78, "update_addon"),
                "D14": (75, "retry")}
        for code, (exit_code, nxt) in want.items():
            self.assertEqual(consts.REFUSALS[code][:2], (exit_code, nxt), code)
        for code, (exit_code, nxt, message) in consts.REFUSALS.items():
            self.assertIn(nxt, consts.NEXT_ACTIONS, code)
            self.assertTrue(message.endswith("."), code)

    def test_the_gpr_version_is_the_constant(self):
        with open(os.path.join(REPO, "gramps", "hfy_sync", "hfy_sync.gpr.py"), encoding="utf-8") as fh:
            text = fh.read()
        self.assertEqual(re.search(r'^\s*version="([^"]+)"', text, re.M).group(1), consts.ADDON_VERSION)
        self.assertIn('id="hfy_sync"', text)
        self.assertIn("category=TOOL_DBPROC", text)
        self.assertIn("tool_modes=[TOOL_MODE_GUI, TOOL_MODE_CLI]", text)
        self.assertIn('gramps_target_version="6.0"', text)

    def test_the_gramps_files_compile(self):
        for name in ("hfy_sync.gpr.py", "hfy_sync_tool.py", "hfy_sync_ui.py"):
            with open(os.path.join(REPO, "gramps", "hfy_sync", name), encoding="utf-8") as fh:
                compile(fh.read(), name, "exec")
        with open(os.path.join(REPO, "gramps", "bin", "hfy-sync"), encoding="utf-8") as fh:
            compile(fh.read(), "hfy-sync", "exec")

    def test_the_gramps_option_tables_still_name_force_unlock(self):
        self.assertIn("u", consts.GRAMPS_SHORTOPTS)
        self.assertIn("force-unlock", consts.GRAMPS_LONGOPTS)

    def test_classes_are_the_push_order(self):  # sync.md 8.3 step 12
        self.assertEqual(consts.CLASSES, ("Tag", "Place", "Note", "Source", "Repository", "Citation", "Media", "Event", "Person", "Family"))


class Paths(HomeCase):
    def test_layout_is_sync_md_4_3(self):
        tp = paths.TreePaths("ab12cd34", self.env)
        root = os.path.join(self.tmp, "Library", "Application Support", "hfy_sync")
        self.assertEqual(tp.config, os.path.join(root, "config.json"))
        self.assertEqual(tp.sidecar, os.path.join(root, "ab12cd34", "state.sqlite"))
        self.assertEqual(tp.lock, os.path.join(root, "ab12cd34", "state.lock"))
        self.assertEqual(tp.status, os.path.join(root, "ab12cd34", "status.json"))
        for name in ("previews", "backups", "logs", "cache"):
            self.assertEqual(getattr(tp, name), os.path.join(root, "ab12cd34", name))

    def test_ensure_makes_owner_only_folders(self):
        tp = paths.TreePaths("ab12cd34", self.env)
        tp.ensure()
        for d in (tp.root, tp.dir, tp.previews, tp.backups, tp.logs, tp.cache):
            self.assertEqual(stat.S_IMODE(os.stat(d).st_mode), 0o700, d)

    def test_a_dbid_cannot_climb_out_of_the_folder(self):
        for bad in ("", "..", "a/b", "a b", "x" * 65, None, "../x"):
            self.assertFalse(paths.valid_dbid(bad), bad)
            with self.assertRaises(ValueError):
                paths.TreePaths(bad, self.env)
        self.assertTrue(paths.valid_dbid("6acf0579"))

    def test_gramps_data_root_follows_grampshome_else_the_mac_folder(self):
        self.assertEqual(paths.gramps_data_root({"GRAMPSHOME": "/x/gh", "HOME": "/h"}), "/x/gh/gramps")
        self.assertEqual(paths.gramps_data_root({"HOME": "/h"}), "/h/Library/Application Support/gramps")

    def test_find_tree_reads_name_txt(self):
        root = os.path.join(self.env["GRAMPSHOME"], "gramps", "grampsdb")
        for dbid, name in (("11111111", "One"), ("22222222", "Two Trees")):
            os.makedirs(os.path.join(root, dbid))
            with open(os.path.join(root, dbid, "name.txt"), "w", encoding="utf-8") as fh:
                fh.write(name + "\n")
        self.assertEqual(paths.find_tree("Two Trees", self.env), ("22222222", os.path.join(root, "22222222")))
        self.assertIsNone(paths.find_tree("Three", self.env))
        self.assertIsNone(paths.find_tree("One", {"GRAMPSHOME": os.path.join(self.tmp, "none")}))

    def test_atomic_write_is_private_and_leaves_no_temp_file(self):
        target = os.path.join(self.tmp, "d", "x.json")
        paths.atomic_write_json(target, {"b": 1, "a": 2})
        self.assertEqual(paths.read_json(target), {"a": 2, "b": 1})
        self.assertEqual(stat.S_IMODE(os.stat(target).st_mode), 0o600)
        self.assertEqual(os.listdir(os.path.dirname(target)), ["x.json"])
        paths.atomic_write_json(target, {"c": 3})
        self.assertEqual(paths.read_json(target), {"c": 3})
        with self.assertRaises(TypeError):
            paths.atomic_write_json(target, {"bad": object()})
        self.assertEqual(paths.read_json(target), {"c": 3}, "a failed write keeps the old file")
        self.assertEqual(os.listdir(os.path.dirname(target)), ["x.json"])

    def test_read_json(self):
        self.assertIsNone(paths.read_json(os.path.join(self.tmp, "none.json")))
        bad = os.path.join(self.tmp, "bad.json")
        with open(bad, "w") as fh:
            fh.write("{not json")
        with self.assertRaises(ValueError):
            paths.read_json(bad)


class StatusFile(HomeCase):
    def test_run_ids_are_ulids_that_sort_by_time(self):
        a, b = status.new_run_id(1_700_000_000), status.new_run_id(1_700_000_001)
        for r in (a, b):
            self.assertRegex(r, r"^[0-9A-HJKMNP-TV-Z]{26}$")
        self.assertLess(a, b)
        self.assertNotEqual(status.new_run_id(1_700_000_000), status.new_run_id(1_700_000_000))

    def test_the_document_has_the_design_keys(self):
        doc = status.build("R1", "sync", "cli", "ab12cd34", True, "ok", 0, "2026-01-01T00:00:00Z", "2026-01-01T00:00:01Z")
        self.assertEqual(sorted(k for k in doc if k != "versions"),
                         sorted(["schema", "run_id", "action", "mode", "dry_run", "started_at", "finished_at", "result", "exit_code",
                                 "tree", "cloud", "counts", "backup", "error", "next_action"]))
        self.assertEqual(sorted(doc["counts"]), sorted(["pulled", "pushed", "conflicts_open", "holds", "blocked", "media_up", "media_down"]))
        self.assertEqual(doc["tree"], {"dbid": "ab12cd34", "bound": True})
        self.assertEqual(doc["cloud"], {"head_seq": 0, "snapshot_seq": 0})
        with self.assertRaises(ValueError):
            status.build("R1", "sync", "cli", "x", True, "great", 0, "", "")
        with self.assertRaises(ValueError):
            status.build("R1", "sync", "cli", "x", True, "ok", 0, "", "", next_action="shrug")

    def test_exit_code_comes_from_the_document_and_a_stale_one_is_70(self):  # D41
        doc = status.build("R1", "status", "cli", "d", False, "refused", 75, "", "")
        self.assertEqual(status.exit_code_for(doc, "R1"), 75)
        self.assertEqual(status.exit_code_for(doc, "R2"), 70)
        self.assertEqual(status.exit_code_for(None, "R1"), 70)
        self.assertEqual(status.exit_code_for({"run_id": "R1", "exit_code": "0"}, "R1"), 70)
        self.assertEqual(status.exit_code_for({"run_id": "R1", "exit_code": 999}, "R1"), 70)

    def test_summary_line_is_codes_only(self):
        doc = status.build("R1", "status", "cli", "d", False, "refused", 78, "", "", error={"code": "D03", "message": "Open the bound tree."},
                           next_action="open_bound_tree")
        line = status.summary_line(doc)
        self.assertIn("D03", line)
        self.assertIn("exit 78", line)
        self.assertIn("next: open_bound_tree", line)


class Sidecar(HomeCase):
    def make(self, **meta):
        path = os.path.join(self.tmp, "state.sqlite")
        sidecar.create(path, dict({"tree_id": "t" * 32, "dbid": "ab12cd34"}, **meta))
        return path

    def test_created_with_the_design_ddl(self):
        path = self.make()
        con = sidecar.open_checked(path)
        try:
            tables = sorted(r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type = 'table'"))
            self.assertEqual(tables, sorted(["meta", "base", "outbox", "conflicts", "holds", "media_local", "id_map", "runs"]))
            self.assertEqual([r[1] for r in con.execute("PRAGMA table_info(base)")],
                             ["class", "handle", "version", "seq", "hash", "obj_json", "deleted"])
            self.assertEqual(sidecar.meta(con)["sidecar_schema"], "1")
            self.assertEqual(con.execute("PRAGMA integrity_check").fetchone()[0], "ok")
            with self.assertRaises(sqlite3.IntegrityError):
                con.execute("INSERT INTO outbox (batch_key, created_at, state, request_json) VALUES ('k', 't', 'bogus', '{}')")
            self.assertEqual(con.execute("PRAGMA journal_mode").fetchone()[0], "delete")
        finally:
            con.close()
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
        self.assertFalse(os.path.exists(path + ".new"))

    def test_create_refuses_to_replace_one(self):
        path = self.make()
        with self.assertRaises(sidecar.SidecarError):
            sidecar.create(path, {})

    def test_open_checked_refuses_damage_and_newer_versions(self):
        path = os.path.join(self.tmp, "junk.sqlite")
        with open(path, "wb") as fh:
            fh.write(b"not a database " * 100)
        with self.assertRaises(sidecar.SidecarError):
            sidecar.open_checked(path)
        path = self.make()
        con = sqlite3.connect(path)
        con.execute("UPDATE meta SET value = '9' WHERE key = 'sidecar_schema'")
        con.commit()
        con.close()
        with self.assertRaises(sidecar.SidecarError):
            sidecar.open_checked(path)
        path = os.path.join(self.tmp, "partial.sqlite")
        con = sqlite3.connect(path)
        con.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        con.commit()
        con.close()
        with self.assertRaises(sidecar.SidecarError):
            sidecar.open_checked(path)

    def test_base_handles_skips_deleted_rows(self):
        path = self.make()
        con = sidecar.open_checked(path)
        con.executemany("INSERT INTO base VALUES (?, ?, 1, 1, 'h', NULL, ?)", [("Person", "p1", 0), ("Person", "p2", 1), ("Event", "e1", 0)])
        con.commit()
        self.assertEqual(sidecar.base_handles(con), {("Person", "p1"), ("Event", "e1")})
        con.close()


class Binding(unittest.TestCase):
    def test_similarity_line_is_90_percent_of_the_base(self):
        base = {("Person", "p%03d" % i) for i in range(100)}
        self.assertTrue(binding.similarity_ok(base, base))
        self.assertTrue(binding.similarity_ok(base, set(list(base)[:90])), "exactly 90 percent passes")
        self.assertFalse(binding.similarity_ok(base, set(list(base)[:89])))
        self.assertTrue(binding.similarity_ok(set(), {("Person", "x")}), "nothing synced yet: nothing to compare")
        extra = base | {("Person", "new%d" % i) for i in range(500)}
        self.assertTrue(binding.similarity_ok(base, extra), "local creates never lower it")

    def test_new_config_has_the_design_keys(self):
        cfg = binding.new_config("Fixture Tree", "ab12cd34")
        self.assertEqual(sorted(cfg), sorted(["schema", "server", "tree_name", "dbid", "media_root", "client_instance_id"]))
        self.assertEqual(cfg["server"], "https://harrisonfamily.us")


class Preflight(unittest.TestCase):
    def test_force_unlock_is_found_the_way_getopt_finds_it(self):
        yes = [["gramps", "-u"], ["gramps", "--force-unlock"], ["gramps", "-O", "T", "-u", "-a", "tool"], ["gramps", "-yu"],
               ["gramps", "--force-un"], ["gramps", "--force-unlock=1"], ["gramps", "-qu", "-O", "T"]]
        no = [["gramps"], ["gramps", "-O", "u"], ["gramps", "-O", "T", "-a", "tool", "-p", "name=hfy_sync,action=status"],
              ["gramps", "-Ou"], ["gramps", "--yes"], ["gramps", "-y", "-q"], []]
        for argv in yes:
            self.assertTrue(preflight.force_unlock_requested(argv), argv)
        for argv in no:
            self.assertFalse(preflight.force_unlock_requested(argv), argv)

    def test_force_unlock_falls_back_to_a_token_scan_when_getopt_cannot_parse(self):
        self.assertTrue(preflight.force_unlock_requested(["gramps", "--no-such-option", "-u"]))
        self.assertFalse(preflight.force_unlock_requested(["gramps", "--no-such-option"]))

    def test_schema_support(self):
        self.assertTrue(preflight.schema_supported(21, (6, 0)))
        self.assertTrue(preflight.schema_supported(21, (6, 0, 6)))
        self.assertFalse(preflight.schema_supported(22, (6, 0)))
        self.assertFalse(preflight.schema_supported(20, (6, 0)))
        self.assertFalse(preflight.schema_supported(21, (6, 1)))
        self.assertFalse(preflight.schema_supported(21, (5, 2)))

    def test_gui_process_is_a_bundle_process_without_a_cli_action(self):
        gui = "/Applications/Gramps.app/Contents/MacOS/Gramps"
        self.assertTrue(preflight.gui_process_running(["/sbin/launchd", gui]))
        self.assertTrue(preflight.gui_process_running([gui + " -O some_tree"]))
        self.assertTrue(preflight.gui_process_running([gui + " 'Some Tree'"]))
        self.assertFalse(preflight.gui_process_running([gui + " -O some_tree -a tool -p name=hfy_sync,action=status"]))
        self.assertFalse(preflight.gui_process_running([gui + " -i x.gramps -O t"]))
        self.assertFalse(preflight.gui_process_running(["/Applications/Other.app/Contents/MacOS/Gramps2", "/usr/bin/python3 gramps.py"]))
        self.assertFalse(preflight.gui_process_running([]))

    def test_ps_lines_seam(self):
        self.assertEqual(preflight.ps_lines({"HFY_SYNC_TEST": "1", "HFY_SYNC_PS_CMD": "printf 'a b\\nc\\n'"}), ["a b", "c"])
        # outside a test the override is ignored: a stray variable cannot turn the GUI scan off
        self.assertNotEqual(preflight.ps_lines({"HFY_SYNC_PS_CMD": "printf 'a b\\nc\\n'"}), ["a b", "c"])
        self.assertNotEqual(preflight.ps_lines({"HFY_SYNC_TEST": "0", "HFY_SYNC_PS_CMD": "printf 'a b\\nc\\n'"}), ["a b", "c"])
        self.assertIsInstance(preflight.ps_lines({}), list)  # the real ps

    def test_state_lock_is_exclusive(self):
        d = tempfile.mkdtemp(prefix="hfy-lock-")
        self.addCleanup(shutil.rmtree, d, True)
        path = os.path.join(d, "x", "state.lock")
        with preflight.StateLock(path) as first:
            self.assertTrue(first.acquired)
            with preflight.StateLock(path) as second:
                self.assertFalse(second.acquired)
        with preflight.StateLock(path) as third:
            self.assertTrue(third.acquired)


class RunnerRefusals(HomeCase):
    def assert_refused(self, doc, code, exit_code, next_action):
        self.assertEqual((doc["result"], doc["exit_code"], doc["error"]["code"], doc["next_action"]), ("refused", exit_code, code, next_action), doc)
        self.assertEqual(paths.read_json(paths.TreePaths(doc["tree"]["dbid"], self.env).status), doc, "status.json holds the document")

    def test_status_of_an_unbound_tree_is_ok(self):
        doc = self.run_tool(FakeTree(), run_id="R1")
        self.assertEqual((doc["result"], doc["exit_code"], doc["run_id"], doc["tree"]), ("ok", 0, "R1", {"dbid": "aa11bb22", "bound": False}))
        self.assertEqual(doc["versions"]["gramps"], "6.0.6")
        self.assertEqual(doc["versions"]["db_schema"], 21)

    def test_d02_force_unlock_64(self):
        self.assert_refused(self.run_tool(FakeTree(), argv=["gramps", "-O", "T", "-u"]), "D02", 64, "none")
        self.assertEqual(self.run_tool(FakeTree(), mode="gui", argv=["gramps", "-u"])["exit_code"], 0, "the GUI has no such flag to refuse")

    def test_d04_unsupported_schema_or_series_78(self):
        self.assert_refused(self.run_tool(FakeTree(schema=22)), "D04", 78, "update_addon")
        self.assert_refused(self.run_tool(FakeTree(schema=20)), "D04", 78, "update_addon")
        self.assert_refused(self.run_tool(FakeTree(series=(6, 1))), "D04", 78, "update_addon")

    def test_d01_gui_process_75_only_for_the_cli(self):
        self.env["HFY_SYNC_PS_CMD"] = "echo /Applications/Gramps.app/Contents/MacOS/Gramps"
        self.assert_refused(self.run_tool(FakeTree()), "D01", 75, "close_gramps")
        self.assertEqual(self.run_tool(FakeTree(), mode="gui")["exit_code"], 0, "inside the GUI the tool is that process")

    def test_a_failing_ps_does_not_decide_the_run(self):
        self.env["HFY_SYNC_PS_CMD"] = "/nonexistent/ps"
        self.assertEqual(self.run_tool(FakeTree())["exit_code"], 0)

    def test_d14_concurrent_run_75(self):
        tree = FakeTree()
        self.run_tool(tree)
        with preflight.StateLock(self.tp(tree).lock) as held:
            self.assertTrue(held.acquired)
            running = paths.read_json(self.tp(tree).status)
            doc = self.run_tool(tree, run_id="R2")
            self.assertEqual((doc["result"], doc["exit_code"], doc["error"]["code"], doc["next_action"]), ("refused", 75, "D14", "retry"))
            self.assertEqual(paths.read_json(self.tp(tree).status), running, "status.json belongs to the run that holds the lock")
            self.assertEqual(status.read_run(self.tp(tree), "R2"), doc, "the refusal is in the run's own file")
            self.assertFalse(os.path.exists(self.tp(tree).status_for("R2")), "read once, then removed")
            self.assertEqual(self.run_tool(tree, mode="gui", run_id="R3")["exit_code"], 75)
            self.assertFalse(os.path.exists(self.tp(tree).status_for("R3")), "a Gramps-window refusal leaves no file")
            self.assertEqual(paths.read_json(self.tp(tree).status), running)
        self.assertEqual(self.run_tool(tree)["exit_code"], 0)

    def test_unknown_action_is_usage_64(self):
        self.assert_refused(self.run_tool(FakeTree(), action="explode"), "usage", 64, "none")

    def test_unreadable_config_78(self):
        tree = FakeTree()
        self.tp(tree).ensure()
        with open(self.tp(tree).config, "w") as fh:
            fh.write("{broken")
        self.assert_refused(self.run_tool(tree), "config_unreadable", 78, "none")

    def test_a_config_that_is_not_an_object_is_78_not_a_traceback(self):
        for text in ("[]", '"x"', "7", "null"):
            tree = FakeTree()
            self.tp(tree).ensure()
            with open(self.tp(tree).config, "w") as fh:
                fh.write(text)
            doc = self.run_tool(tree)
            if text == "null":
                self.assertEqual(doc["exit_code"], 0, "null is the same as no config")
            else:
                self.assert_refused(doc, "config_unreadable", 78, "none")

    def test_a_bug_after_the_sidecar_is_opened_closes_it_and_records_the_run(self):
        tree = self.bound_tree()
        opened = []
        real = sidecar.open_checked

        def spy(path):
            con = real(path)
            opened.append(con)
            return con

        def boom(*a, **k):
            raise RuntimeError("boom")

        self.addCleanup(setattr, sidecar, "open_checked", real)
        self.addCleanup(setattr, runner.binding, "check", runner.binding.check)
        sidecar.open_checked = spy
        runner.binding.check = boom
        doc = self.run_tool(tree, run_id="R9")
        self.assertEqual((doc["result"], doc["exit_code"]), ("failed", 70))
        self.assertEqual(len(opened), 1)
        with self.assertRaises(sqlite3.ProgrammingError):
            opened[0].execute("SELECT 1")  # closed
        con = sqlite3.connect(self.tp(tree).sidecar)
        self.addCleanup(con.close)
        self.assertEqual(con.execute("SELECT COUNT(*) FROM runs WHERE run_id = 'R9'").fetchone()[0], 1)

    def test_a_bug_is_failed_70_not_an_exception(self):
        tree = self.bound_tree()
        tree.fail_handles = True
        doc = self.run_tool(tree)
        self.assertEqual((doc["result"], doc["exit_code"], doc["error"]["code"]), ("failed", 70, "internal"))
        self.assertNotIn("boom", str(doc), "no message text from the exception")
        self.assertEqual(paths.read_json(self.tp(tree).status)["exit_code"], 70)

    def test_actions_without_a_build_yet_are_69(self):
        for action in ("check", "pull", "push", "sync"):
            self.assert_refused(self.run_tool(FakeTree(), action=action), "not_enabled", 69, "none")


class RunnerBinding(HomeCase):
    def test_bind_dry_run_changes_nothing(self):
        tree = FakeTree()
        for kw in ({"dry_run": True, "yes": True}, {"yes": False}):
            doc = self.run_tool(tree, "bind", **kw)
            self.assertEqual((doc["result"], doc["exit_code"]), ("changes_pending", 10), kw)
        self.assertIsNone(tree.marker)
        self.assertFalse(os.path.exists(self.tp(tree).sidecar))
        self.assertFalse(os.path.exists(self.tp(tree).config))

    def test_bind_writes_marker_sidecar_and_config_together(self):
        tree = self.bound_tree()
        tp = self.tp(tree)
        self.assertRegex(tree.marker, r"^[0-9a-f]{32}$")
        cfg = paths.read_json(tp.config)
        self.assertEqual((cfg["dbid"], cfg["tree_name"]), (tree.dbid, tree.name))
        con = sidecar.open_checked(tp.sidecar)
        meta = sidecar.meta(con)
        self.assertEqual((meta["tree_id"], meta["dbid"], meta["sidecar_schema"], meta["last_pull_seq"], meta["client_instance_id"]),
                         (tree.marker, tree.dbid, "1", "0", cfg["client_instance_id"]))
        self.assertRegex(meta["fingerprint"], r"^[0-9a-f]{64}$")
        self.assertEqual(con.execute("SELECT COUNT(*) FROM runs WHERE action = 'bind' AND result = 'ok'").fetchone()[0], 1)
        con.close()
        doc = self.run_tool(tree)
        self.assertEqual((doc["tree"]["bound"], doc["result"]), (True, "ok"))
        con = sidecar.open_checked(tp.sidecar)
        self.assertEqual(con.execute("SELECT COUNT(*) FROM runs").fetchone()[0], 2, "every run is a row")
        con.close()

    def test_bind_twice_is_a_no_op(self):
        tree = self.bound_tree()
        marker, cfg = tree.marker, paths.read_json(self.tp(tree).config)
        doc = self.run_tool(tree, "bind", yes=True)
        self.assertEqual((doc["result"], doc["exit_code"]), ("ok", 0))
        self.assertEqual((tree.marker, paths.read_json(self.tp(tree).config)), (marker, cfg))

    def test_a_failed_sidecar_rolls_the_marker_back(self):
        tree = FakeTree()
        tp = self.tp(tree)
        tp.ensure()
        os.makedirs(tp.sidecar + ".new")  # a directory where the temporary sidecar goes: creation fails
        doc = self.run_tool(tree, "bind", yes=True)
        self.assertEqual((doc["result"], doc["exit_code"]), ("failed", 70))
        self.assertIsNone(tree.marker)
        self.assertFalse(os.path.exists(tp.config))

    def test_a_leftover_empty_sidecar_is_replaced_but_one_with_data_is_not(self):
        tree = self.bound_tree()
        tp = self.tp(tree)
        os.unlink(tp.config)  # a bind that stopped before config.json
        doc = self.run_tool(tree, "bind", yes=True)
        self.assertEqual(doc["exit_code"], 0, doc)
        self.fill_base(tree)
        os.unlink(tp.config)
        doc = self.run_tool(tree, "bind", yes=True)
        self.assertEqual((doc["result"], doc["error"]["code"]), ("refused", "D13"))

    def test_d03_wrong_tree_by_dbid(self):
        self.bound_tree(dbid="aa11bb22")
        other = FakeTree(dbid="cc33dd44")
        doc = self.run_tool(other)
        self.assertEqual((doc["exit_code"], doc["error"]["code"], doc["tree"]["bound"]), (78, "D03", False))
        doc = self.run_tool(other, "bind", yes=True)
        self.assertEqual((doc["exit_code"], doc["error"]["code"]), (78, "D03"))
        self.assertIsNone(other.marker, "bind never moves the binding")

    def test_d03_marker_missing_or_different(self):
        tree = self.bound_tree()
        real = tree.marker
        tree.marker = None
        self.assertEqual(self.run_tool(tree)["error"]["code"], "D03")
        tree.marker = "f" * 32
        self.assertEqual(self.run_tool(tree)["error"]["code"], "D03")
        tree.marker = real
        self.assertEqual(self.run_tool(tree)["exit_code"], 0)

    def test_local_edits_between_syncs_never_trigger_d03(self):
        tree = self.bound_tree()
        self.fill_base(tree)
        before = set(tree.objs)
        victims = sorted(tree.objs)[:8]  # 8 of 100: a delete between syncs
        tree.objs -= set(victims)
        tree.objs |= {("Person", "new%04d" % i) for i in range(30)}  # and 30 creates
        self.assertNotEqual(tree.objs, before)
        doc = self.run_tool(tree)
        self.assertEqual((doc["exit_code"], doc["tree"]["bound"]), (0, True), doc)

    def test_d03_swapped_tree_or_mass_deletion(self):
        tree = self.bound_tree()
        self.fill_base(tree)
        keep = set(tree.objs)
        tree.objs = set(sorted(keep)[:89])  # 89 of 100 left: below the line
        self.assertEqual(self.run_tool(tree)["error"]["code"], "D03")
        tree.objs = set(sorted(keep)[:90])  # exactly 90 percent
        self.assertEqual(self.run_tool(tree)["exit_code"], 0)
        tree.objs = {("Person", "other%04d" % i) for i in range(100)}  # a different tree with the same marker
        self.assertEqual(self.run_tool(tree)["error"]["code"], "D03")

    def test_d12_and_d13_sidecar_missing_or_damaged(self):
        tree = self.bound_tree()
        tp = self.tp(tree)
        with open(tp.sidecar, "rb") as fh:
            good = fh.read()
        os.unlink(tp.sidecar)
        doc = self.run_tool(tree)
        self.assertEqual((doc["exit_code"], doc["error"]["code"], doc["next_action"]), (78, "D12", "rebase"))
        self.assertFalse(os.path.exists(tp.sidecar), "never rebuilt on its own")
        with open(tp.sidecar, "wb") as fh:
            fh.write(b"\0" * 4096)
        doc = self.run_tool(tree)
        self.assertEqual((doc["exit_code"], doc["error"]["code"]), (78, "D13"))
        with open(tp.sidecar, "wb") as fh:
            fh.write(good)
        self.assertEqual(self.run_tool(tree)["exit_code"], 0)

    def test_the_run_log_has_step_names_and_no_handles(self):
        tree = self.bound_tree()
        self.run_tool(tree, run_id="LOGRUN")
        with open(os.path.join(self.tp(tree).logs, "LOGRUN.log"), encoding="utf-8") as fh:
            text = fh.read()
        self.assertIn("action=status", text)
        self.assertIn("binding bound", text)
        for _cls, h in tree.objs:
            self.assertNotIn(h, text)
        self.assertNotIn(tree.marker, text)


if __name__ == "__main__":
    unittest.main()
