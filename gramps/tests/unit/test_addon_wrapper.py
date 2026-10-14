"""The `hfy-sync` wrapper, the addon build and the installer (task addon-skeleton). Standard library only; no Gramps.

A fake Gramps command (a small Python script) stands in for `Gramps -O <tree> -a tool -p ...`, so CI proves the wrapper's exit
codes, its refusals before Gramps starts and the stale-status rule (exit 70). The real Gramps does the same in
gramps/tests/gramps/test_addon_skeleton.py. Every tree name here is invented, and the build and install tests use a temporary
plugins folder, never a real Gramps one.
"""
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
GRAMPS = os.path.join(REPO, "gramps")
WRAPPER = os.path.join(GRAMPS, "bin", "hfy-sync")
sys.path.insert(0, GRAMPS)

from hfygramps.addon import consts, paths, status  # noqa: E402

FAKE_GRAMPS = r'''
import json, os, sys
sys.path.insert(0, %(gramps)r)
from hfygramps.addon import paths, status
argv = sys.argv[1:]
log = os.environ["FAKE_LOG"]
with open(log, "a") as fh:
    fh.write(json.dumps(argv) + "\n")
tree = argv[argv.index("-O") + 1]
opts = dict(kv.split("=", 1) for kv in argv[argv.index("-p") + 1].split(","))
dbid, tree_dir = paths.find_tree(tree)
mode = os.environ.get("FAKE_MODE", "ok")
if mode == "locked":
    open(os.path.join(tree_dir, "lock"), "w").close()
    print("Database is locked, cannot open it!", file=sys.stderr)
    sys.exit(1)
if mode == "none":
    sys.exit(0)
run_id = opts["run_id"] if mode == "ok" else "someone-elses-run"
code = int(os.environ.get("FAKE_EXIT", "0"))
doc = status.build(run_id, opts["action"], "cli", dbid, True, "ok" if code == 0 else "partial", code, "t0", "t1",
                   dry_run=opts["dry_run"] == "1", next_action="none")
tp = paths.TreePaths(dbid)
tp.ensure()
status.write(tp, doc)
'''


class WrapperCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="hfy-wrapper-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.home = os.path.join(self.tmp, "home")
        self.gh = os.path.join(self.tmp, "gh%20x#y")  # characters that are special in a URI: the schema read must not trip on them
        self.log = os.path.join(self.tmp, "fake.log")
        self.fake = os.path.join(self.tmp, "fake_gramps.py")
        with open(self.fake, "w", encoding="utf-8") as fh:
            fh.write(FAKE_GRAMPS % {"gramps": GRAMPS})
        self.dbid = "ab12cd34"
        self.tree_dir = self.make_tree(self.dbid, "Fixture Tree")

    def make_tree(self, dbid, name, schema=21):
        d = os.path.join(self.gh, "gramps", "grampsdb", dbid)
        os.makedirs(d)
        with open(os.path.join(d, "name.txt"), "w", encoding="utf-8") as fh:
            fh.write(name + "\n")
        con = sqlite3.connect(os.path.join(d, "sqlite.db"))
        con.execute("CREATE TABLE metadata (setting VARCHAR(50) PRIMARY KEY NOT NULL, json_data TEXT, value BLOB)")
        con.execute("INSERT INTO metadata (setting, json_data) VALUES ('version', ?)", (json.dumps({"type": "str", "value": str(schema)}),))
        con.commit()
        con.close()
        return d

    def env(self, **extra):
        env = {k: v for k, v in os.environ.items() if not k.startswith(("HFY_", "FAKE_"))}
        env.update({"HOME": self.home, "GRAMPSHOME": self.gh, "FAKE_LOG": self.log,
                    "HFY_GRAMPS_CMD": "%s %s" % (sys.executable, self.fake)})
        env.update(extra)
        return env

    def wrap(self, *args, **extra):
        return subprocess.run([sys.executable, WRAPPER] + list(args), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              universal_newlines=True, env=self.env(**extra), check=False)

    def calls(self):
        if not os.path.exists(self.log):
            return []
        with open(self.log, encoding="utf-8") as fh:
            return [json.loads(line) for line in fh]

    def status_doc(self):
        return paths.read_json(paths.TreePaths(self.dbid, {"HOME": self.home}).status)


class Wrapper(WrapperCase):
    def test_it_is_executable_python_with_a_shebang(self):
        with open(WRAPPER, encoding="utf-8") as fh:
            self.assertEqual(fh.readline().strip(), "#!/usr/bin/env python3")
        self.assertTrue(os.access(WRAPPER, os.X_OK))

    def test_the_exit_code_is_the_status_json_exit_code(self):
        for code in (0, 10, 20, 65, 69, 77):
            proc = self.wrap("status", "--tree", "Fixture Tree", FAKE_EXIT=str(code))
            self.assertEqual(proc.returncode, code, proc.stdout + proc.stderr)
        doc = self.status_doc()
        self.assertEqual(doc["exit_code"], 77)

    def test_it_runs_gramps_the_documented_way(self):
        self.wrap("sync", "--tree", "Fixture Tree", "--allow-deletes")
        (argv,) = self.calls()
        self.assertEqual(argv[:4], ["-O", "Fixture Tree", "-a", "tool"])
        opts = dict(kv.split("=", 1) for kv in argv[5].split(","))
        self.assertEqual((opts["name"], opts["action"], opts["dry_run"], opts["allow_deletes"], opts["yes"]), ("hfy_sync", "sync", "1", "1", "0"))
        self.assertRegex(opts["run_id"], r"^[0-9A-Z]{26}$")
        self.wrap("sync", "--tree", "Fixture Tree", "--yes")
        opts = dict(kv.split("=", 1) for kv in self.calls()[-1][5].split(","))
        self.assertEqual((opts["dry_run"], opts["yes"]), ("0", "1"), "CLI sync is a dry run unless --yes")
        self.wrap("status", "--tree", "Fixture Tree")
        self.assertEqual(dict(kv.split("=", 1) for kv in self.calls()[-1][5].split(","))["dry_run"], "0", "status writes nothing, so it is not a dry run")

    def test_missing_or_stale_status_json_is_70(self):  # D41
        self.assertEqual(self.wrap("status", "--tree", "Fixture Tree", FAKE_MODE="none").returncode, 70)
        proc = self.wrap("status", "--tree", "Fixture Tree", FAKE_MODE="stale")
        self.assertEqual(proc.returncode, 70)
        self.assertIn("D41", proc.stderr)
        # an old success on disk does not turn a run that wrote nothing into a success
        self.assertEqual(self.wrap("status", "--tree", "Fixture Tree").returncode, 0)
        self.assertEqual(self.wrap("status", "--tree", "Fixture Tree", FAKE_MODE="none").returncode, 70)

    def test_force_unlock_is_64_before_gramps_starts(self):
        for flag in ("--force-unlock", "-u", "--force-unl"):
            proc = self.wrap("status", flag, "--tree", "Fixture Tree")
            self.assertEqual(proc.returncode, 64, flag)
        self.assertEqual(self.calls(), [])
        self.assertEqual(self.status_doc()["error"]["code"], "D02")

    def test_unsupported_schema_is_78_before_gramps_starts(self):
        self.make_tree("ee55ff66", "Newer Tree", schema=22)
        proc = self.wrap("status", "--tree", "Newer Tree")
        self.assertEqual(proc.returncode, 78, proc.stdout + proc.stderr)
        self.assertEqual(self.calls(), [], "Gramps would upgrade an older tree on open and refuse a newer one: never start it")
        doc = paths.read_json(paths.TreePaths("ee55ff66", {"HOME": self.home}).status)
        self.assertEqual((doc["error"]["code"], doc["next_action"]), ("D04", "update_addon"))

    def test_a_tree_with_a_lock_file_is_75_and_the_lock_stays(self):
        lock = os.path.join(self.tree_dir, "lock")
        open(lock, "w").close()
        proc = self.wrap("status", "--tree", "Fixture Tree")
        self.assertEqual(proc.returncode, 75, proc.stdout + proc.stderr)
        self.assertEqual(self.calls(), [])
        self.assertTrue(os.path.exists(lock))
        doc = self.status_doc()
        self.assertEqual((doc["error"]["code"], doc["next_action"]), ("D01", "close_gramps"))

    def test_a_lock_taken_while_gramps_starts_is_75_not_70(self):
        proc = self.wrap("status", "--tree", "Fixture Tree", FAKE_MODE="locked")
        self.assertEqual(proc.returncode, 75, proc.stdout + proc.stderr)
        self.assertEqual(self.status_doc()["error"]["code"], "D01")

    def test_the_tree_comes_from_the_option_the_environment_or_config(self):
        self.assertEqual(self.wrap("status").returncode, 64, "no tree anywhere is a usage error")
        self.assertEqual(self.wrap("status", HFY_SYNC_TREE="Fixture Tree").returncode, 0)
        paths.atomic_write_json(paths.config_path({"HOME": self.home}), {"tree_name": "Fixture Tree", "dbid": self.dbid})
        self.assertEqual(self.wrap("status").returncode, 0)
        self.assertEqual(self.wrap("status", "--tree", "No Such Tree").returncode, 78)

    def test_usage_errors_are_64(self):
        for args in ([], ["explode", "--tree", "Fixture Tree"], ["status", "--bogus"], ["status", "extra", "--tree", "Fixture Tree"],
                     ["status", "--tree"]):
            self.assertEqual(self.wrap(*args).returncode, 64, args)

    def test_json_output_is_the_status_document_with_no_content(self):
        proc = self.wrap("status", "--tree", "Fixture Tree", "--json")
        doc = json.loads(proc.stdout)
        self.assertEqual((doc["action"], doc["result"], doc["tree"]["dbid"]), ("status", "ok", self.dbid))

    def test_a_missing_gramps_is_70(self):
        proc = self.wrap("status", "--tree", "Fixture Tree", HFY_GRAMPS_CMD=os.path.join(self.tmp, "no-such-gramps"))
        self.assertEqual(proc.returncode, 70)


@unittest.skipUnless(shutil.which("zip") and shutil.which("bash"), "needs bash and zip")
class BuildAndInstall(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        out = subprocess.run(["bash", os.path.join(GRAMPS, "scripts", "build-addon.sh")], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                             universal_newlines=True, check=True)
        cls.build_out = out.stdout
        cls.dist = os.path.join(GRAMPS, "dist", "hfy_sync-%s" % consts.ADDON_VERSION)

    def test_the_folder_and_the_zip_hold_the_addon_and_its_vendored_core(self):
        want = {"hfy_sync.gpr.py", "hfy_sync_tool.py", "hfy_sync_ui.py", "hfygramps/__init__.py", "hfygramps/rules.py",
                "hfygramps/projection.py", "hfygramps/canonical.py", "hfygramps/scanner.py", "hfygramps/addon/runner.py",
                "hfygramps/addon/consts.py", "redaction/redaction-v1.json"}
        have = set()
        for root, _dirs, files in os.walk(self.dist):
            have |= {os.path.relpath(os.path.join(root, f), self.dist) for f in files}
        self.assertTrue(want <= have, want - have)
        self.assertFalse([h for h in have if h.startswith("hfygramps/render") or h.endswith("schema_check.py") or "__pycache__" in h or h.endswith(".pyc")])
        with zipfile.ZipFile(self.dist + ".zip") as z:
            names = set(z.namelist())
        self.assertEqual(names, {"hfy_sync/" + h for h in have})

    def test_the_vendored_core_imports_from_the_built_folder_alone(self):
        code = ("import sys; sys.path.insert(0, %r); "
                "import hfygramps.addon.runner, hfygramps.projection, hfygramps.rules as r; "
                "assert r.POLICY_PATH.startswith(%r), r.POLICY_PATH; "
                "print(sorted(m for m in sys.modules if m.startswith('hfygramps'))[:2])" % (self.dist, self.dist))
        out = subprocess.run([sys.executable, "-c", code], cwd=tempfile.gettempdir(), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                             universal_newlines=True, check=False)
        self.assertEqual(out.returncode, 0, out.stdout)
        self.assertTrue(os.path.isfile(os.path.join(self.dist, "redaction", "redaction-v1.json")))

    def test_install_replaces_only_the_hfy_sync_folder(self):
        dest = tempfile.mkdtemp(prefix="hfy-plugins-")
        self.addCleanup(shutil.rmtree, dest, True)
        other = os.path.join(dest, "SomeOtherAddon")
        os.makedirs(other)
        with open(os.path.join(other, "keep.txt"), "w") as fh:
            fh.write("keep")
        os.makedirs(os.path.join(dest, "hfy_sync"))
        with open(os.path.join(dest, "hfy_sync", "stale.txt"), "w") as fh:
            fh.write("from an older install")
        script = os.path.join(GRAMPS, "scripts", "install-addon.sh")
        for _ in range(2):  # twice: an update over an install
            out = subprocess.run(["bash", script, "--dest", dest], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, universal_newlines=True, check=False)
            self.assertEqual(out.returncode, 0, out.stdout)
        self.assertIn("installed in %s/hfy_sync" % dest, out.stdout)
        self.assertTrue(os.path.isfile(os.path.join(dest, "hfy_sync", "hfy_sync.gpr.py")))
        self.assertFalse(os.path.exists(os.path.join(dest, "hfy_sync", "stale.txt")))
        self.assertTrue(os.path.isfile(os.path.join(other, "keep.txt")))
        self.assertEqual(sorted(os.listdir(dest)), ["SomeOtherAddon", "hfy_sync"], "no temporary folder left behind")

    def test_install_default_follows_grampshome_and_never_the_real_home(self):
        home = tempfile.mkdtemp(prefix="hfy-gh-")
        self.addCleanup(shutil.rmtree, home, True)
        env = dict(os.environ, GRAMPSHOME=home, HOME=home)
        out = subprocess.run(["bash", os.path.join(GRAMPS, "scripts", "install-addon.sh")], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                             universal_newlines=True, env=env, check=False)
        self.assertEqual(out.returncode, 0, out.stdout)
        self.assertTrue(os.path.isfile(os.path.join(home, "gramps", "gramps60", "plugins", "hfy_sync", "hfy_sync.gpr.py")))

    def test_install_rejects_bad_arguments(self):
        script = os.path.join(GRAMPS, "scripts", "install-addon.sh")
        for args in (["--dest"], ["--nope"]):
            out = subprocess.run(["bash", script] + args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, universal_newlines=True, check=False)
            self.assertEqual(out.returncode, 64, args)


if __name__ == "__main__":
    unittest.main()
