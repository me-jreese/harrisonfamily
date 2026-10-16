#
# Gramps - a GTK+/GNOME based genealogy program
#
# harrisonfamily.us website sync addon (HFY-PLN-002, sync.md section 13, phase B). Private use.
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
"""The Website sync gramplet (HFY-TSK-278): the last sync, the website changes waiting, and a Sync button that opens the tool.

It performs no writes. What it shows and when it asks the website is hfygramps.addon.gramplet_model (tested without a window); this
file only draws it. It asks at most every five minutes, only while it is on screen, from a worker thread so the window never waits.
"""
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
if not os.path.isdir(os.path.join(_HERE, "hfygramps")):
    sys.path.insert(0, os.path.dirname(_HERE))

import logging  # noqa: E402
import threading  # noqa: E402

from gi.repository import GLib, Gtk  # noqa: E402

from gramps.gen.const import GRAMPS_LOCALE as glocale  # noqa: E402
from gramps.gen.const import VERSION  # noqa: E402
from gramps.gen.plug import Gramplet  # noqa: E402
from hfygramps.addon import gramplet_model  # noqa: E402

_ = glocale.translation.gettext
LOG = logging.getLogger("hfy_sync")
TICK_S = 30  # how often visibility is looked at; the website is asked only when the model says it is due


class HfySyncGramplet(Gramplet):
    def init(self):
        self.model = None
        self._busy = False
        self._source = None
        self.label = Gtk.Label(xalign=0, wrap=True, selectable=False)
        self.button = Gtk.Button(label=_("_Sync..."), use_underline=True)
        self.button.connect("clicked", self._open_tool)
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        box.pack_start(self.label, False, False, 0)
        box.pack_start(self.button, False, False, 0)
        self.gui.get_container_widget().remove(self.gui.textview)
        self.gui.get_container_widget().add(box)
        box.show_all()
        self.box = box
        self._tick_source = GLib.timeout_add_seconds(TICK_S, self._tick)

    def db_changed(self):
        self.model = None
        self.connect(self.dbstate.db, "database-changed", self._reset)

    def _reset(self, *_args):
        self.model = None

    def on_load(self):
        self._reset()

    def main(self):
        self._tick()
        yield False

    def _visible(self):
        try:
            return bool(self.box.get_mapped())
        except Exception:  # noqa: BLE001 - when in doubt, do not ask
            return False

    def _model(self):
        db = self.dbstate.db
        if self.model is None and db is not None and db.is_open():
            dbid = db.get_dbid()
            if not dbid:
                return None
            factory = gramplet_model.client_factory(dbid, VERSION, db.get_schema_version())
            self.model = gramplet_model.Model(dbid, factory)
        return self.model

    def _tick(self):
        try:
            model = self._model()
            if model is None:
                self.label.set_text(_("Open a tree to see its website status."))
            elif not self._busy:
                self._busy = True
                visible = self._visible()
                threading.Thread(target=self._work, args=(model, visible), daemon=True).start()
        except Exception:  # noqa: BLE001 - a gramplet must never take Gramps down
            LOG.error("hfy_sync gramplet tick failed", exc_info=True)
            self._busy = False
        return True

    def _work(self, model, visible):
        try:
            model.refresh(visible)
            lines = model.lines()
        except Exception:  # noqa: BLE001
            lines = [_("Website status is unavailable right now.")]
        finally:
            self._busy = False
        GLib.idle_add(self.label.set_text, "\n".join(lines))

    def _open_tool(self, _button):
        """Opens Tools > Family Tree Processing > Website sync..., the same dialog the menu opens."""
        from gramps.gen.plug import BasePluginManager
        from gramps.gui.plug import tool
        from gramps.gui.pluginmanager import GuiPluginManager
        from gramps.gen.user import User

        pmgr = GuiPluginManager.get_instance()
        data = next((p for p in pmgr.get_reg_tools(gui=True) if p.id == "hfy_sync"), None)
        if data is None:
            return
        mod = pmgr.load_plugin(data)
        user = User(parent=self.uistate.window, uistate=self.uistate)
        tool.gui_tool(
            dbstate=self.dbstate, user=user, tool_class=getattr(mod, data.toolclass), options_class=getattr(mod, data.optionclass),
            translated_name=data.name, name=data.id, category=data.category, callback=self.dbstate.db.request_rebuild)
