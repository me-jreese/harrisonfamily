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
"""The skeleton's Gtk 3 dialogs for Tools > Family Tree Processing > Website sync...

Only two screens exist so far: the tree's sync status, and a question that binds an unbound tree. The preview, conflict and
apply dialogs of sync.md 13.1 arrive with the pull, push and GUI preview tasks. It shows codes and counts, never object content.
"""
from gramps.gen.const import GRAMPS_LOCALE as glocale
from gramps.gui.dialog import OkDialog, QuestionDialog2

_ = glocale.translation.gettext

_TITLE = _("Website sync")


def describe(doc):
    """The status document as dialog text: tree binding, result, the refusal's message, versions. No object content."""
    lines = []
    tree = doc.get("tree") or {}
    lines.append(_("This tree is bound to the website.") if tree.get("bound") else _("This tree is not bound to the website."))
    error = doc.get("error") or {}
    if error:
        lines.append("%s: %s" % (error.get("code", ""), error.get("message", "")))
    elif doc.get("result") == "ok":
        lines.append(_("Nothing needs attention."))
    versions = doc.get("versions") or {}
    if versions:
        lines.append(_("Addon %(addon)s, Gramps %(gramps)s, database schema %(db_schema)s.") % {
            "addon": versions.get("addon", ""), "gramps": versions.get("gramps", ""), "db_schema": versions.get("db_schema", "")})
    return "\n".join(lines)


def present(parent, doc, run_bind):
    """Shows the status; for an unbound tree asks first whether to bind it. `run_bind()` runs the bind and returns its status."""
    if doc.get("result") == "ok" and not (doc.get("tree") or {}).get("bound"):
        ask = QuestionDialog2(
            _("Bind this tree to the website?"),
            _("The website keeps one family tree bound to it. Binding writes a small marker into this tree and creates the "
              "sync state on this computer. Nothing is sent to the website."),
            _("_Bind this tree"), _("_Not now"), parent=parent)
        if ask.run():
            doc = run_bind()
    OkDialog(_TITLE, describe(doc), parent=parent)
