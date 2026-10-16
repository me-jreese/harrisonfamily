#
# Gramps - a GTK+/GNOME based genealogy program
#
# harrisonfamily.us website sync addon (HFY-PLN-002, sync.md section 8). Private use.
#
# This program is free software; you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation; either version 2 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
"""The `hfy_sync` Gramps tool (HFY-TSK-179 skeleton): a thin shell over `hfygramps.addon.runner`.

It is a plain Tool, not a BatchTool, so Gramps keeps undo (sync.md 8.1). In the GUI it shows the tree's sync status and offers to
bind an unbound tree; on the command line it runs the action named in the options string and writes status.json, because
Gramps' cli_tool swallows exceptions and the `hfy-sync` wrapper reads only that file.

    Gramps -O <tree> -a tool -p name=hfy_sync,action=<status|bind|...>,dry_run=<0|1>,yes=<0|1>,run_id=<id>
"""
import os
import sys

# Gramps puts this folder on sys.path only while it imports the module, so everything is imported here, at the top. An installed
# addon has hfygramps beside this file (scripts/build-addon.sh); a checkout has it one folder up.
_HERE = os.path.dirname(os.path.abspath(__file__))
if not os.path.isdir(os.path.join(_HERE, "hfygramps")):
    sys.path.insert(0, os.path.dirname(_HERE))

import copy  # noqa: E402
import logging  # noqa: E402
import time  # noqa: E402

from gramps.gen.const import GRAMPS_LOCALE as glocale  # noqa: E402
from gramps.gen.const import VERSION, VERSION_TUPLE  # noqa: E402
from gramps.gen.db import DbTxn  # noqa: E402
from gramps.gen.errors import HandleError  # noqa: E402
from gramps.gen.lib.json_utils import data_to_object, object_to_dict  # noqa: E402
from gramps.gui.plug import tool  # noqa: E402

import hfy_sync_ui  # noqa: E402
from hfygramps.addon import consts, runner  # noqa: E402

_ = glocale.translation.gettext
LOG = logging.getLogger("hfy_sync")

_HANDLE_GETTERS = {
    "Tag": "get_tag_handles", "Place": "get_place_handles", "Note": "get_note_handles", "Source": "get_source_handles",
    "Repository": "get_repository_handles", "Citation": "get_citation_handles", "Media": "get_media_handles",
    "Event": "get_event_handles", "Person": "get_person_handles", "Family": "get_family_handles",
}
_ITER_HANDLES = {cls: "iter_%s_handles" % cls.lower() for cls in consts.CLASSES}  # every class has one (DbReadBase)
_GETTER = {cls: "get_%s_from_handle" % cls.lower() for cls in consts.CLASSES}
_RAW_GETTER = {cls: "get_raw_%s_data" % cls.lower() for cls in consts.CLASSES}  # the stored json_data dict, no Gramps object built
_COMMIT = {cls: "commit_%s" % cls.lower() for cls in consts.CLASSES}
_REMOVE = {cls: "remove_%s" % cls.lower() for cls in consts.CLASSES}


class GrampsTree(runner.TreeAccess):
    """The open Gramps database as the runner sees it. status and bind read only handles and the marker; check, pull and push read the objects; only the pull writes them."""

    def __init__(self, db, uistate=None):
        self.db = db
        self.uistate = uistate
        self.dbdir = getattr(db, "path", None) or ""
        self.dbid = db.get_dbid()
        self.name = db.get_dbname() or ""
        self.schema_version = db.get_schema_version()
        self.gramps_series = tuple(VERSION_TUPLE[:2])
        self.gramps_version = VERSION

    def read_marker(self):
        value = self.db._get_metadata(consts.TREE_MARKER_KEY, default="")
        return value if isinstance(value, str) and value else None

    def handles(self):
        out = set()
        for cls in consts.CLASSES:
            for handle in getattr(self.db, _HANDLE_GETTERS[cls])():
                out.add((cls, handle))
        return out

    def objects(self):
        """Every primary object as the dict Gramps stores (`json_data`), the same shape synthetic-tree.jsonl has.

        It goes through the raw getters and builds no Gramps object. Measured on the fixture tree (scenario_push's dry run): a read through
        the object getters changed `sqlite.db` when the tree closed in a process with a random hash seed, such as the Gramps window,
        where the raw getters left it byte for byte."""
        out = {}
        for cls in consts.CLASSES:
            get = getattr(self.db, _RAW_GETTER[cls])
            for handle in getattr(self.db, _ITER_HANDLES[cls])():
                data = get(handle)
                if data is not None:
                    out[handle] = data
        return out

    def _read(self, cls, handle):
        # Gramps raises HandleError for a handle that is not there (a create the plan is about to make), where the fakes return None.
        try:
            obj = getattr(self.db, _GETTER[cls])(handle)
        except HandleError:
            return None
        return None if obj is None else object_to_dict(obj)

    def editors_open(self):
        """True while an edit window is open (BRD2 D45). Best effort: it looks at the windows the window manager tracks by id."""
        gwm = getattr(self.uistate, "gwm", None)
        if gwm is None:
            return False
        from gramps.gui.editors.editprimary import EditPrimary
        from gramps.gui.editors.editsecondary import EditSecondary

        return any(isinstance(item, (EditPrimary, EditSecondary)) for item in list(getattr(gwm, "id2item", {}).values()))

    def apply(self, label, commits, removals, precheck=None, verify=None, hook=None):
        # ONE non-batch DbTxn: a single Edit > Undo entry in the GUI (sync.md 8.3 step 9); any exception aborts all of it.
        items = sorted(commits.items(), key=lambda kv: (consts.CLASSES.index(kv[1]["_class"]), kv[0]))
        half = (len(items) + 1) // 2
        with DbTxn(label, self.db) as trans:
            if precheck is not None:
                precheck(self._read)
            for i, (handle, state) in enumerate(items, 1):
                state = copy.deepcopy(state)
                state.setdefault("change", int(time.time()))
                getattr(self.db, _COMMIT[state["_class"]])(data_to_object(state), trans)
                if hook is not None and i == half:
                    hook("mid_apply")
            if hook is not None and not items:
                hook("mid_apply")
            for cls, handle in removals:
                getattr(self.db, _REMOVE[cls])(handle, trans)
            if verify is not None:
                verify(self.objects())

    def bind(self, tree_id, also):
        # The marker goes in the tree inside one DbTxn, together with the sidecar that remembers it (BRD2 section 11, 8.3 step 1).
        with DbTxn(_("Website sync: bind this tree"), self.db) as _trans:
            self.db._set_metadata(consts.TREE_MARKER_KEY, tree_id)
            also()


def _gui_actions(tree):
    """The callables the Website sync window runs (hfy_sync_ui.present). `flow` does the review and the one-run apply (review.Flow)."""
    from hfygramps.addon import backup, paths, review

    def run(action, **kw):
        return runner.run(tree, "gui", runner.Options(action, **kw), argv=sys.argv)

    tp = paths.TreePaths(tree.dbid)

    def latest_log():
        # codes and step names only (sync.md 4.3): the newest run log of this tree
        try:
            names = sorted(n for n in os.listdir(tp.logs) if n.endswith(".log"))
            if not names:
                return ""
            with open(os.path.join(tp.logs, names[-1]), encoding="utf-8") as fh:
                return fh.read()
        except OSError:
            return ""

    return {
        "flow": review.Flow(tree, argv=sys.argv),
        "bind": lambda: run("bind", yes=True),
        "login": lambda step_up=False: run("login", step_up=bool(step_up)),
        "rebase_check": lambda: run("rebase", dry_run=True),
        "rebase": lambda: run("rebase", yes=True),
        "backups": lambda: [n for n, _p in backup.list_backups(tp.backups)],
        "backups_dir": lambda: tp.backups,
        "latest_log": latest_log,
        "restore_hint": lambda name: "hfy-sync restore %s --tree \"%s\"" % (name, tree.name),
    }


class HfySyncOptions(tool.ToolOptions):
    """The options string of `-a tool -p`. Integers, because the Gramps parser reads booleans only as True or False."""

    def __init__(self, name, person_id=None):
        tool.ToolOptions.__init__(self, name, person_id)
        self.options_dict = {"action": "status", "dry_run": 0, "allow_deletes": 0, "yes": 0, "step_up": 0, "run_id": "", "plan": "", "ui": ""}
        self.options_help = {
            "action": ("=ACTION", "What to do", ["status", "login", "check", "pull", "push", "sync", "bind", "rebase"], False),
            "dry_run": ("=0/1", "Report what would change; write nothing to the tree or the website", ["No", "Yes"], True),
            "allow_deletes": ("=0/1", "Allow deletes (never mass deletes)", ["No", "Yes"], True),
            "yes": ("=0/1", "Do not stop at the preview", ["No", "Yes"], True),
            "step_up": ("=0/1", "For login: ask for a fresh sign-in (prompt=login, max_age=300)", ["No", "Yes"], True),
            "run_id": ("=ID", "Run id the hfy-sync wrapper checks status.json against", "text"),
            "plan": ("=ID", "Apply only if the changes equal the preview of this run id (sync --yes --plan)", "text"),
            "ui": ("=sim", "Test seam: run as the GUI does (conflicts stay open, not parked); honoured only while HFY_SYNC_TEST=1", "text"),
        }


class HfySyncTool(tool.Tool):
    def __init__(self, dbstate, user, options_class, name, callback=None):
        tool.Tool.__init__(self, dbstate, options_class, name)
        gui = getattr(user, "uistate", None) is not None
        values = self.options.handler.options_dict
        opts = runner.Options(
            action="status" if gui else str(values.get("action") or "status").strip(),
            dry_run=bool(values.get("dry_run")), allow_deletes=bool(values.get("allow_deletes")), yes=bool(values.get("yes")),
            step_up=bool(values.get("step_up")), plan=str(values.get("plan") or "").strip(),
        )
        run_id = str(values.get("run_id") or "") or None
        simulated_gui = os.environ.get("HFY_SYNC_TEST") == "1" and str(values.get("ui") or "") == "sim"
        try:
            tree = GrampsTree(dbstate.db, getattr(user, "uistate", None))
            doc = runner.run(tree, "gui" if gui or simulated_gui else "cli", opts, run_id=run_id, argv=sys.argv)
        except Exception:  # noqa: BLE001 - cli_tool would swallow it; status.json is the channel, and there is none without a tree
            LOG.error("hfy_sync failed before it could write status.json", exc_info=True)
            return
        if gui:
            hfy_sync_ui.present(user.uistate.window, doc, _gui_actions(tree))
