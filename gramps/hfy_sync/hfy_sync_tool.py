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

import logging  # noqa: E402

from gramps.gen.const import GRAMPS_LOCALE as glocale  # noqa: E402
from gramps.gen.const import VERSION, VERSION_TUPLE  # noqa: E402
from gramps.gen.db import DbTxn  # noqa: E402
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


class GrampsTree(runner.TreeAccess):
    """The open Gramps database as the runner sees it. Reads only handles and the marker; no object content."""

    def __init__(self, db):
        self.db = db
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

    def bind(self, tree_id, also):
        # The marker goes in the tree inside one DbTxn, together with the sidecar that remembers it (BRD2 section 11, 8.3 step 1).
        with DbTxn(_("Website sync: bind this tree"), self.db) as _trans:
            self.db._set_metadata(consts.TREE_MARKER_KEY, tree_id)
            also()


class HfySyncOptions(tool.ToolOptions):
    """The options string of `-a tool -p`. Integers, because the Gramps parser reads booleans only as True or False."""

    def __init__(self, name, person_id=None):
        tool.ToolOptions.__init__(self, name, person_id)
        self.options_dict = {"action": "status", "dry_run": 0, "allow_deletes": 0, "yes": 0, "run_id": ""}
        self.options_help = {
            "action": ("=ACTION", "What to do", ["status", "login", "check", "pull", "push", "sync", "bind"], False),
            "dry_run": ("=0/1", "Report what would change; write nothing to the tree or the website", ["No", "Yes"], True),
            "allow_deletes": ("=0/1", "Allow deletes (never mass deletes)", ["No", "Yes"], True),
            "yes": ("=0/1", "Do not stop at the preview", ["No", "Yes"], True),
            "run_id": ("=ID", "Run id the hfy-sync wrapper checks status.json against", "text"),
        }


class HfySyncTool(tool.Tool):
    def __init__(self, dbstate, user, options_class, name, callback=None):
        tool.Tool.__init__(self, dbstate, options_class, name)
        gui = getattr(user, "uistate", None) is not None
        values = self.options.handler.options_dict
        opts = runner.Options(
            action="status" if gui else str(values.get("action") or "status").strip(),
            dry_run=bool(values.get("dry_run")), allow_deletes=bool(values.get("allow_deletes")), yes=bool(values.get("yes")),
        )
        run_id = str(values.get("run_id") or "") or None
        try:
            tree = GrampsTree(dbstate.db)
            doc = runner.run(tree, "gui" if gui else "cli", opts, run_id=run_id, argv=sys.argv)
        except Exception:  # noqa: BLE001 - cli_tool would swallow it; status.json is the channel, and there is none without a tree
            LOG.error("hfy_sync failed before it could write status.json", exc_info=True)
            return
        if gui:
            hfy_sync_ui.present(user.uistate.window, doc, lambda: runner.run(tree, "gui", runner.Options("bind", yes=True), argv=sys.argv))
