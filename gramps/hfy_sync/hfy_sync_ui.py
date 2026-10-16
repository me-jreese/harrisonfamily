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
"""The Gtk 3 dialogs for Tools > Family Tree Processing > Website sync...

Status and the bind question come from the skeleton (HFY-TSK-179). HFY-TSK-205 adds the menu that runs `check` and the apply, and
"Restore backup...". The full preview, conflict and push dialogs of sync.md 13.1 arrive with `addon-gui-preview`; until then the
apply asks one question, with the counts of the preview it just made, and the hfy-sync command line is where conflicts are listed.
Everything shown here is a code or a count, never object content. These dialogs are exercised by io's G-uat on a fixture copy; the
logic they call (runner.run, backup.restore) is tested without a window.
"""
from gramps.gen.const import GRAMPS_LOCALE as glocale
from gi.repository import Gtk

from gramps.gui.dialog import ErrorDialog, OkDialog, QuestionDialog2

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


def describe_run(doc):
    """One run's result as dialog text: the counts, the refusal or attention message. No object content."""
    c = doc.get("counts") or {}
    pulled = c.get("pulled") or {}
    lines = [_("Result: %(result)s.") % {"result": doc.get("result", "")}]
    lines.append(_("From the website: %(c)d new, %(u)d changed, %(d)d deleted.") % {
        "c": pulled.get("create", 0), "u": pulled.get("update", 0), "d": pulled.get("delete", 0)})
    lines.append(_("Waiting to go to the website: %(n)d (this build cannot push yet).") % {"n": c.get("push_pending", 0)})
    lines.append(_("Open conflicts: %(n)d. Held back: %(b)d. Privacy incidents: %(i)d.") % {
        "n": c.get("conflicts_open", 0), "b": c.get("blocked", 0), "i": c.get("privacy_incidents", 0)})
    error = doc.get("error") or {}
    if error:
        lines.append("%s: %s" % (error.get("code", ""), error.get("message", "")))
    if doc.get("backup"):
        lines.append(_("A backup was taken before anything changed."))
    return "\n".join(lines)


def describe_rebase(doc):
    """A rebase's result as dialog text: counts and the refusal's message only. No object content."""
    c = (doc.get("counts") or {}).get("rebase") or {}
    lines = [_("Result: %(result)s.") % {"result": doc.get("result", "")}]
    if c.get("needed") is False and not doc.get("error") and doc.get("dry_run"):
        lines.append(_("The website's store is the one this tree last synced with. There is nothing to rebase."))
    else:
        lines.append(_("Same on both sides: %(n)d. Different on both sides (conflicts): %(c)d.") % {"n": c.get("rebased", 0), "c": c.get("conflicts", 0)})
        lines.append(_("Only on the website: %(w)d. Only in this tree: %(d)d. A later sync brings these across.") % {
            "w": c.get("cloud_only", 0), "d": c.get("desktop_only", 0)})
    error = doc.get("error") or {}
    if error:
        lines.append("%s: %s" % (error.get("code", ""), error.get("message", "")))
    if doc.get("backup"):
        lines.append(_("A backup was taken before anything changed."))
    return "\n".join(lines)


_CHECK, _APPLY, _RESTORE, _REBASE = 1, 2, 3, 4


def _menu(parent):
    dialog = Gtk.Dialog(title=_TITLE, transient_for=parent, modal=True)
    dialog.add_button(_("_Check for changes"), _CHECK)
    dialog.add_button(_("_Apply website changes"), _APPLY)
    dialog.add_button(_("_Restore backup..."), _RESTORE)
    dialog.add_button(_("Re_base after a recovery..."), _REBASE)
    dialog.add_button(_("_Close"), Gtk.ResponseType.CLOSE)
    label = Gtk.Label(label=_("A backup is taken before anything changes. Undo is available until you close the tree; "
                              "undoing will revert these changes on the website at the next sync."))
    label.set_line_wrap(True)
    label.set_margin_start(12)
    label.set_margin_end(12)
    label.set_margin_top(12)
    label.set_margin_bottom(12)
    dialog.get_content_area().add(label)
    dialog.show_all()
    try:
        return dialog.run()
    finally:
        dialog.destroy()


def present(parent, doc, actions):
    """Shows the status, then a small menu. `actions` is a dict of callables: bind(), check(), apply(preview_run_id), rebase_check(), rebase(), backups(), restore_hint(name)."""
    if doc.get("result") == "ok" and not (doc.get("tree") or {}).get("bound"):
        ask = QuestionDialog2(
            _("Bind this tree to the website?"),
            _("The website keeps one family tree bound to it. Binding writes a small marker into this tree and creates the "
              "sync state on this computer. Nothing is sent to the website."),
            _("_Bind this tree"), _("_Not now"), parent=parent)
        if ask.run():
            doc = actions["bind"]()
    OkDialog(_TITLE, describe(doc), parent=parent)
    if not (doc.get("tree") or {}).get("bound"):
        return
    while True:
        choice = _menu(parent)
        if choice == _CHECK:
            OkDialog(_TITLE, describe_run(actions["check"]()), parent=parent)
        elif choice == _APPLY:
            preview = actions["check"]()
            c = preview.get("counts") or {}
            pulled = c.get("pulled") or {}
            n = sum(pulled.values())
            if preview.get("result") not in ("changes_pending", "partial", "ok"):
                OkDialog(_TITLE, describe_run(preview), parent=parent)
                continue
            ask = QuestionDialog2(
                _("Apply the website's changes?"),
                describe_run(preview) + "\n\n" + _("Apply %(n)d change(s) now? A backup is taken first.") % {"n": n},
                _("_Apply"), _("_Cancel"), parent=parent)
            if n and ask.run():
                OkDialog(_TITLE, describe_run(actions["apply"](preview.get("run_id"))), parent=parent)
        elif choice == _REBASE:
            preview = actions["rebase_check"]()
            needed = (preview.get("counts") or {}).get("rebase", {}).get("needed")
            if preview.get("result") != "changes_pending" or not needed:
                OkDialog(_TITLE, describe_rebase(preview), parent=parent)
                continue
            ask = QuestionDialog2(
                _("Rebase this tree onto the website's recovered store?"),
                describe_rebase(preview) + "\n\n" + _("Nothing in this tree changes and nothing is sent to the website. "
                                                       "Conflicts wait for you. A backup is taken first."),
                _("_Rebase"), _("_Cancel"), parent=parent)
            if ask.run():
                OkDialog(_TITLE, describe_rebase(actions["rebase"]()), parent=parent)
        elif choice == _RESTORE:
            names = actions["backups"]()
            if not names:
                OkDialog(_TITLE, _("There are no backups yet."), parent=parent)
                continue
            ErrorDialog(_("Restore backup..."), _("A restore needs this tree closed. Close Gramps, then run this in a terminal:") +
                        "\n\n" + actions["restore_hint"](names[-1]) + "\n\n" + _("Backups, newest last: %s") % ", ".join(names[-5:]),
                        parent=parent)
        else:
            return
