"""Helpers for the addon's Gramps-integration tests (HFY-TSK-179). Standard library plus, where noted, the bundled Gramps.

Everything runs against a throwaway GRAMPSHOME and HOME that run.sh made, on copies of the fixture tree: the addon is installed
into that home's plugins folder, the sync state lands in `<HOME>/Library/Application Support/hfy_sync/<dbid>/`, and the real
Gramps folders are forbidden to the audit hook for the whole run.
"""
import json
import os
import sqlite3
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
GRAMPS_DIR = os.path.abspath(os.path.join(HERE, "..", ".."))
SHIM = os.path.join(HERE, "gramps-shim.sh")
INSTALL = os.path.join(GRAMPS_DIR, "scripts", "install-addon.sh")
WRAPPER = os.path.join(GRAMPS_DIR, "bin", "hfy-sync")
sys.path.insert(0, GRAMPS_DIR)

GRAMPSHOME = os.environ.get("GRAMPSHOME", "")
APP_SUPPORT = os.path.join(os.environ.get("HOME", ""), "Library", "Application Support", "hfy_sync")
PLUGIN_DIR = os.path.join(GRAMPSHOME, "gramps", "gramps60", "plugins", "hfy_sync")


def install_addon():
    """Runs install-addon.sh into this throwaway home (GRAMPSHOME picks the folder) and returns its output."""
    assert GRAMPSHOME and not APP_SUPPORT.startswith(os.path.expanduser("~/Library")), "must run inside run.sh's throwaway home"
    out = subprocess.run(["bash", INSTALL], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, universal_newlines=True, check=True)
    return out.stdout


def tree_paths(dbid):
    d = os.path.join(APP_SUPPORT, dbid)
    return {"dir": d, "sidecar": os.path.join(d, "state.sqlite"), "lock": os.path.join(d, "state.lock"),
            "status": os.path.join(d, "status.json"), "logs": os.path.join(d, "logs"), "config": os.path.join(APP_SUPPORT, "config.json")}


def read_status(dbid):
    with open(tree_paths(dbid)["status"], encoding="utf-8") as fh:
        return json.load(fh)


def reset_config():
    try:
        os.unlink(os.path.join(APP_SUPPORT, "config.json"))
    except FileNotFoundError:
        pass


def run_gramps(tree_name, options, extra=(), env=None):
    """`Gramps -O <tree> -a tool -p <options>` through the shim; returns the CompletedProcess (stdout and stderr as text)."""
    cmd = ["bash", SHIM, "--cli", "-O", tree_name] + list(extra) + ["-a", "tool", "-p", options]
    return subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, env=env or os.environ.copy(), check=False)


def run_wrapper(args, env_extra=None):
    """The hfy-sync wrapper with HFY_GRAMPS_CMD pointing at the shim; returns the CompletedProcess."""
    env = os.environ.copy()
    env["HFY_GRAMPS_CMD"] = "bash %s --cli" % SHIM
    env.pop("HFY_SYNC_TREE", None)
    env.update(env_extra or {})
    return subprocess.run(["python3", WRAPPER] + list(args), stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True,
                          env=env, check=False)


def sqlite_ro(path):
    return sqlite3.connect("file:%s?mode=ro" % path, uri=True)


def tree_metadata(tree_dir, key):
    """A Gramps metadata value read straight from the tree's sqlite file, read-only."""
    con = sqlite_ro(os.path.join(tree_dir, "sqlite.db"))
    try:
        row = con.execute("SELECT json_data FROM metadata WHERE setting = ?", (key,)).fetchone()
    finally:
        con.close()
    return json.loads(row[0])["value"] if row else None
