"""Base class of the end-to-end scenarios (HFY-TSK-181). Imported by scenario_*.py; not a scenario itself.

Run through gramps/tests/e2e/run.sh, inside the bundled Python, against a throwaway GRAMPSHOME and HOME and a private copy of the fixture
tree. The addon is installed into that home (gramps/scripts/install-addon.sh), each test starts its own sync dev server, and the sync state
lands under the temporary HOME. Nothing here touches the real Gramps folders or the login Keychain.
"""
import hashlib
import json
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
GRAMPS_TESTS = os.path.join(HERE, "..", "gramps")
for p in (HERE, GRAMPS_TESTS, os.path.join(HERE, "..", "fixtures")):
    if p not in sys.path:
        sys.path.insert(0, p)

import addon_support as S  # noqa: E402
import e2e_support as E  # noqa: E402
import fixture_trees as ft  # noqa: E402
from hfygramps.addon import consts, sidecar  # noqa: E402

GRAMPSHOME = os.environ.get("GRAMPSHOME", "")
TREE = os.environ.get("HFY_TREE_NAME", "")


@unittest.skipUnless(GRAMPSHOME and TREE, "run through gramps/tests/e2e/run.sh")
class E2ECase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.install_log = S.install_addon()
        cls.ps_dir = tempfile.mkdtemp(prefix="hfy-ps-")
        ps_file = os.path.join(cls.ps_dir, "ps.txt")
        with open(ps_file, "w", encoding="utf-8") as fh:
            fh.write("/usr/sbin/cron\n/sbin/launchd\n")  # a process list with no Gramps window in it
        cls.old_env = {k: os.environ.get(k) for k in ("HFY_SYNC_PS_CMD", "HFY_SYNC_TEST")}
        os.environ["HFY_SYNC_TEST"] = "1"
        os.environ["HFY_SYNC_PS_CMD"] = "cat %s" % ps_file

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.ps_dir, ignore_errors=True)
        for k, v in cls.old_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def setUp(self):
        S.reset_config()
        path = ft.fresh_copy(self, GRAMPSHOME)
        self.dir = path
        self.dbid = os.path.basename(path)
        self.addCleanup(shutil.rmtree, S.tree_paths(self.dbid)["dir"], True)
        with open(os.path.join(path, "name.txt"), encoding="utf-8") as fh:
            self.name = fh.read().strip()

    # ------------------------------------------------------------------------------------------------------ the server

    def start_server(self, *extra_args):
        server = E.DevServer(extra_args=extra_args)
        try:
            server.start()
        except E.DevServerError as exc:
            self.fail(str(exc))
        self.addCleanup(server.stop)
        return server

    # ---------------------------------------------------------------------------------------------------------- the addon

    def wrapper(self, *args):
        return S.run_wrapper(list(args) + ["--tree", self.name])

    def bind_local(self):
        """`hfy-sync bind --yes` on the tree copy; returns the sidecar meta (tree_id, dbid, fingerprint, ...)."""
        proc = self.wrapper("bind", "--yes")
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        con = sidecar.open_checked(S.tree_paths(self.dbid)["sidecar"])
        try:
            return sidecar.meta(con)
        finally:
            con.close()

    def point_config_at(self, server):
        """Sets `server` in config.json to the dev server, as io would edit it; the rest of the file is kept."""
        path = S.tree_paths(self.dbid)["config"]
        with open(path, encoding="utf-8") as fh:
            cfg = json.load(fh)
        cfg["server"] = server.origin
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(cfg, fh, indent=2, sort_keys=True)

    def tree_name_sha256(self):
        return hashlib.sha256(self.name.encode("utf-8")).hexdigest()
