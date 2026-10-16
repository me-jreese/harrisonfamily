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
"""The Gtk 3 window for Tools > Family Tree Processing > Website sync... (sync.md 13.1; HFY-TSK-208).

This file only draws and asks. What the window shows and what a click does is `hfygramps.addon.review` (the model, the conflict choices, the
confirmations, the one-run apply, the result banner), which has no Gtk in it and is tested without a window; the logic it calls
(runner.run, backup.restore) is tested the same way.

    header     tree, website, signed in as, last sync, website version; Sign in, Check for changes, Open backups, View log
    sections   From the website, To the website, Conflicts, Held back, Blocked, each with its count; a row opens to its field-level diff
    conflicts  Keep mine / Take website / Skip for now (a date: Keep mine / Take the website year and keep my day and month / Take the
               website value and clear my day and month); the choice is carried out in the same run as the Apply
    footer     the backup and undo sentence, Cancel, and Apply N, Push M
    apply      refused while any Gramps edit window is open (D45); modals list every object an incoming or outgoing delete, a mass
               operation or a revert covers; the result banner shows the counts, the backup path and the undo warning

Everything shown is read live for this window and never stored: the "yours" column of a conflict reads the database now, local-only part
included, and nothing in this file writes it anywhere. A person's name links to the website's page for that person (design rule P2-R46):
plain text, no underline in any state, the theme's text colour and weight, a focus ring; text only when the record has no Gramps ID.
"""
from gramps.gen.const import GRAMPS_LOCALE as glocale
from gi.repository import Gdk, GLib, Gtk, Pango

from gramps.gui.dialog import ErrorDialog, OkDialog, QuestionDialog2

_ = glocale.translation.gettext

_TITLE = _("Website sync")
_CSS = b"""
button.hfy-person { padding: 0; margin: 0; min-height: 0; min-width: 0; border: none; background: none; box-shadow: none; text-decoration: none; }
button.hfy-person label { text-decoration: none; font-weight: inherit; }
.hfy-badge { font-size: smaller; opacity: 0.75; }
.hfy-yours-local { font-style: italic; }
.hfy-dim { opacity: 0.7; }
"""
_css_loaded = False


def _load_css():
    global _css_loaded
    if _css_loaded:
        return
    provider = Gtk.CssProvider()
    try:
        provider.load_from_data(_CSS)
        screen = Gdk.Screen.get_default()
        if screen is not None:
            Gtk.StyleContext.add_provider_for_screen(screen, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
    except GLib.Error:
        pass
    _css_loaded = True


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
    lines.append(_("Waiting to go to the website: %(n)d.") % {"n": c.get("push_pending", 0)})
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
        if c.get("deleted_on_desktop", 0):
            lines.append(_("Deleted in this tree but still on the website: %(n)d. The rebase forgets those deletes, so a later sync would bring "
                           "them back. Delete them on the website first if they should stay gone.") % {"n": c["deleted_on_desktop"]})
    error = doc.get("error") or {}
    if error:
        lines.append("%s: %s" % (error.get("code", ""), error.get("message", "")))
    if doc.get("backup"):
        lines.append(_("A backup was taken before anything changed."))
    return "\n".join(lines)


# ------------------------------------------------------------------------------------------------------------------ small widgets


def _label(text, xalign=0.0, wrap=False, selectable=False, css=None, bold=False):
    label = Gtk.Label(label=text)
    label.set_xalign(xalign)
    label.set_line_wrap(wrap)
    if wrap:
        label.set_max_width_chars(90)
    label.set_selectable(selectable)
    if css:
        label.get_style_context().add_class(css)
    if bold:
        attrs = Pango.AttrList()
        attrs.insert(Pango.attr_weight_new(Pango.Weight.BOLD))
        label.set_attributes(attrs)
    return label


def _open_url(url):
    try:
        Gtk.show_uri_on_window(None, url, Gdk.CURRENT_TIME)
    except GLib.Error:
        pass


def _name_widget(row):
    """A person's name as a link to the website's page for that person (P2-R46): a flat button, so there is no underline in any state, the
    colour and weight are the text's and the focus ring is the theme's. Plain text when the record has no Gramps ID."""
    name = row.get("name") or ""
    url = row.get("person_url")
    if not name:
        return None
    if not url:
        return _label(name)
    button = Gtk.Button(label=name)
    button.set_relief(Gtk.ReliefStyle.NONE)
    button.set_can_focus(True)
    button.get_style_context().add_class("hfy-person")
    button.set_tooltip_text(url)
    button.get_accessible().set_name(_("Open the website page for %s") % name)
    button.connect("clicked", lambda _b, u=url: _open_url(u))
    return button


def _title_box(row):
    box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
    box.pack_start(_label(row.get("title", ""), bold=True), False, False, 0)
    name = _name_widget(row)
    if name is not None:
        box.pack_start(name, False, False, 0)
    if row.get("badge"):
        box.pack_start(_label(row["badge"], css="hfy-badge"), False, False, 0)
    return box


def _diff_grid(diffs, columns):
    """`diffs` is [{label, <column>...}]; `columns` is [(key, heading)]. One line per path."""
    grid = Gtk.Grid(column_spacing=18, row_spacing=3)
    grid.set_margin_start(24)
    grid.set_margin_bottom(6)
    grid.attach(_label(_("Field"), css="hfy-dim"), 0, 0, 1, 1)
    for i, (_key, heading) in enumerate(columns, 1):
        grid.attach(_label(heading, css="hfy-dim"), i, 0, 1, 1)
    for r, d in enumerate(diffs, 1):
        grid.attach(_label(d.get("label", "")), 0, r, 1, 1)
        for i, (key, _heading) in enumerate(columns, 1):
            cell = _label(d.get(key, ""), wrap=True, selectable=True,
                          css="hfy-yours-local" if key == "yours" and d.get("yours_local_only") else None)
            grid.attach(cell, i, r, 1, 1)
    return grid


# ------------------------------------------------------------------------------------------------------------------ the window


class SyncWindow:
    """The Website sync window. `actions` is `hfy_sync_tool._gui_actions`; `flow` in it is a `review.Flow`."""

    def __init__(self, parent, doc, actions, standalone=False):
        """`standalone` builds the content without a dialog around it (`root`), for the tests that draw it offscreen."""
        _load_css()
        self.parent, self.actions, self.flow = parent, actions, actions["flow"]
        self.review = None
        self.choices = {}      # conflict id -> {choice id: Gtk.RadioButton}
        self.dialog = None
        self.root = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        self.header = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        self.header.set_margin_start(12)
        self.header.set_margin_end(12)
        self.header.set_margin_top(12)
        self.root.pack_start(self.header, False, False, 0)
        self.body = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        self.body.set_margin_start(12)
        self.body.set_margin_end(12)
        scroller = Gtk.ScrolledWindow()
        scroller.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        scroller.set_min_content_height(360)
        scroller.add(self.body)
        self.root.pack_start(scroller, True, True, 0)
        self.footer = _label(_("A backup is taken before anything changes. Undo is available until you close the tree; "
                               "undoing will revert these changes on the website at the next sync."), wrap=True, css="hfy-dim")
        self.footer.set_margin_start(12)
        self.footer.set_margin_end(12)
        self.root.pack_start(self.footer, False, False, 0)
        bar = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        bar.set_halign(Gtk.Align.END)
        bar.set_margin_start(12)
        bar.set_margin_end(12)
        bar.set_margin_bottom(12)
        self.cancel = Gtk.Button(label=_("Cancel"))
        self.cancel.connect("clicked", self._on_cancel)
        self.apply_button = Gtk.Button(label=_("Apply"))
        self.apply_button.get_style_context().add_class("suggested-action")
        self.apply_button.connect("clicked", self._on_apply)
        self.apply_button.set_sensitive(False)
        bar.pack_start(self.cancel, False, False, 0)
        bar.pack_start(self.apply_button, False, False, 0)
        self.root.pack_start(bar, False, False, 0)
        self.status_doc = doc
        self._build_header(None)
        if not standalone:
            self.dialog = Gtk.Dialog(title=_TITLE, transient_for=parent, modal=True)
            self.dialog.set_default_size(920, 700)
            self.dialog.get_content_area().pack_start(self.root, True, True, 0)

    def _on_cancel(self, _button=None):
        if self.dialog is not None:
            self.dialog.response(Gtk.ResponseType.CANCEL)

    def _parent(self):
        return self.dialog if self.dialog is not None else self.parent

    # ---- header
    def _build_header(self, model):
        for child in self.header.get_children():
            self.header.remove(child)
        h = (model or {}).get("header") or {}
        line1 = _("Tree: %(tree)s   Website: %(site)s   Signed in as: %(who)s") % {
            "tree": h.get("tree", ""), "site": h.get("website", ""), "who": h.get("signed_in") or _("not signed in")}
        line2 = _("Last sync: %(last)s      Website version: %(ver)s") % {"last": h.get("last_sync", _("never")), "ver": h.get("website_version") or _("unknown")}
        self.header.pack_start(_label(line1), False, False, 0)
        self.header.pack_start(_label(line2), False, False, 0)
        buttons = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        for text, handler in ((_("Sign in..."), self._on_sign_in), (_("Check for changes"), self._on_check), (_("Open backups"), self._on_backups),
                              (_("View log"), self._on_log)):
            b = Gtk.Button(label=text)
            b.connect("clicked", handler)
            buttons.pack_start(b, False, False, 0)
        more = Gtk.MenuButton(label=_("More..."))
        menu = Gtk.Menu()
        for text, handler in ((_("Restore backup..."), self._on_restore), (_("Rebase after a recovery..."), self._on_rebase)):
            item = Gtk.MenuItem(label=text)
            item.connect("activate", handler)
            menu.append(item)
        menu.show_all()
        more.set_popup(menu)
        buttons.pack_start(more, False, False, 0)
        self.header.pack_start(buttons, False, False, 0)
        self.header.show_all()

    # ---- content
    def _clear_body(self):
        for child in self.body.get_children():
            self.body.remove(child)
        self.choices = {}

    def show_text(self, text):
        self._clear_body()
        self.body.pack_start(_label(text, wrap=True, selectable=True), False, False, 0)
        self.body.show_all()

    def load(self, review):
        """Draws a `review.Review`."""
        self.review = review
        self._clear_body()
        self.footer.show()
        if review.refusal is not None:
            self._build_header(None)
            self.apply_button.set_sensitive(False)
            self.apply_button.set_label(_("Apply"))
            self.show_text(describe_run(review.refusal))
            return
        model = review.model
        self._build_header(model)
        if review.push_note is not None:
            self.body.pack_start(_label(_("What to send could not be checked: %s") % (
                (review.push_note.get("error") or {}).get("message") or review.push_note.get("result", "")), wrap=True), False, False, 0)
        for section in model["sections"]:
            self.body.pack_start(self._section(section), False, False, 0)
        self.apply_button.set_label(model["apply_label"])
        self.apply_button.set_sensitive(bool(model["counts"]["apply"] or model["counts"]["push"] or model["counts"]["confirm"]
                                             or any(s["rows"] for s in model["sections"] if s["id"] == "conflicts")))
        self.body.show_all()

    def _section(self, section):
        title = "%s (%d)" % (section["title"], section["count"])
        if section["summary"]:
            title += "      " + section["summary"]
        exp = Gtk.Expander(label=title)
        exp.set_expanded(bool(section["count"]) and section["id"] in ("conflicts", "from_website", "to_website"))
        exp.get_style_context().add_class("hfy-section")
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        box.set_margin_start(18)
        if not section["rows"]:
            box.pack_start(_label(_("Nothing here."), css="hfy-dim"), False, False, 0)
        for row in section["rows"]:
            box.pack_start(self._row(section["id"], row), False, False, 0)
        exp.add(box)
        return exp

    def _row(self, sid, row):
        outer = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
        outer.pack_start(_title_box(row), False, False, 0)
        if row.get("note"):
            note = _label(row["note"], wrap=True, css="hfy-dim")
            note.set_margin_start(24)
            outer.pack_start(note, False, False, 0)
        if sid == "conflicts":
            outer.pack_start(_diff_grid(row["diffs"], [("base", _("Base")), ("website", _("Website")), ("yours", _("Yours (this computer)"))]),
                             False, False, 0)
            outer.pack_start(self._choices(row), False, False, 0)
        elif row.get("diffs"):
            if sid == "from_website":
                cols = [("base", _("Base")), ("website", _("Website"))]
            else:
                cols = [("website", _("Website now")), ("desktop", _("After the push"))]
            exp = Gtk.Expander(label=_("Changes"))
            exp.set_margin_start(18)
            exp.add(_diff_grid(row["diffs"], cols))
            outer.pack_start(exp, False, False, 0)
        if row.get("release"):
            button = Gtk.Button(label=row["release"]["label"])
            button.set_halign(Gtk.Align.START)
            button.set_margin_start(24)
            button.connect("clicked", self._on_release, row["release"])
            outer.pack_start(button, False, False, 0)
        return outer

    def _choices(self, row):
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
        box.set_margin_start(24)
        group, radios = None, {}
        for ch in row["choices"]:
            radio = Gtk.RadioButton.new_with_label_from_widget(group, ch["label"])
            group = group or radio
            radio.set_tooltip_text(ch.get("detail", ""))
            radio.set_active(ch["id"] == row["default"])
            radios[ch["id"]] = radio
            box.pack_start(radio, False, False, 0)
        self.choices[row["id"]] = radios
        return box

    # ---- asking
    def _ask(self, title, text):
        return bool(QuestionDialog2(title, text, _("_Yes"), _("_No"), parent=self._parent()).run())

    def _confirm_list(self, modal):
        """A modal that lists every object it covers; True when confirmed."""
        dlg = Gtk.Dialog(title=modal["title"], transient_for=self._parent(), modal=True)
        dlg.set_default_size(560, 420)
        area = dlg.get_content_area()
        area.set_spacing(6)
        text = _label(modal["text"], wrap=True)
        text.set_margin_start(12)
        text.set_margin_end(12)
        text.set_margin_top(12)
        area.pack_start(text, False, False, 0)
        store = Gtk.ListStore(str, str, str)
        for o in modal["objects"]:
            store.append([o.get("title", ""), o.get("name", ""), o.get("note", "")])
        view = Gtk.TreeView(model=store)
        for i, heading in enumerate((_("Record"), _("Name"), _("Why"))):
            col = Gtk.TreeViewColumn(heading, Gtk.CellRendererText(), text=i)
            col.set_resizable(True)
            view.append_column(col)
        scroller = Gtk.ScrolledWindow()
        scroller.add(view)
        scroller.set_margin_start(12)
        scroller.set_margin_end(12)
        area.pack_start(scroller, True, True, 0)
        dlg.add_button(_("_Don't do these"), Gtk.ResponseType.CANCEL)
        dlg.add_button(_("_Confirm"), Gtk.ResponseType.OK)
        dlg.show_all()
        try:
            return dlg.run() == Gtk.ResponseType.OK
        finally:
            dlg.destroy()

    # ---- buttons
    def _on_check(self, _button=None):
        self.apply_button.set_sensitive(False)
        self.show_text(_("Checking the website..."))
        while Gtk.events_pending():
            Gtk.main_iteration()
        self.load(self.flow.review())

    def _on_sign_in(self, _button=None):
        doc = self.actions["login"](False)
        OkDialog(_TITLE, describe_run(doc), parent=self._parent())
        self._on_check()

    def _on_backups(self, _button=None):
        folder = self.actions["backups_dir"]()
        _open_url("file://" + folder)

    def _on_log(self, _button=None):
        text = self.actions["latest_log"]() or _("There is no log yet.")
        dlg = Gtk.Dialog(title=_("Sync log (codes only)"), transient_for=self._parent(), modal=True)
        dlg.set_default_size(640, 420)
        view = Gtk.TextView()
        view.set_editable(False)
        view.set_monospace(True)
        view.get_buffer().set_text(text)
        scroller = Gtk.ScrolledWindow()
        scroller.add(view)
        dlg.get_content_area().pack_start(scroller, True, True, 0)
        dlg.add_button(_("_Close"), Gtk.ResponseType.CLOSE)
        dlg.show_all()
        dlg.run()
        dlg.destroy()

    def _on_release(self, _button, release):
        if self._ask(_("Release this event?"), release["confirm"]):
            self.flow.release(release["handle"])
            self._on_check()

    def _on_restore(self, _item=None):
        names = self.actions["backups"]()
        if not names:
            OkDialog(_TITLE, _("There are no backups yet."), parent=self._parent())
            return
        ErrorDialog(_("Restore backup..."), _("A restore needs this tree closed. Close Gramps, then run this in a terminal:") +
                    "\n\n" + self.actions["restore_hint"](names[-1]) + "\n\n" + _("Backups, newest last: %s") % ", ".join(names[-5:]), parent=self._parent())

    def _on_rebase(self, _item=None):
        preview = self.actions["rebase_check"]()
        needed = (preview.get("counts") or {}).get("rebase", {}).get("needed")
        if preview.get("result") != "changes_pending" or not needed:
            OkDialog(_TITLE, describe_rebase(preview), parent=self._parent())
            return
        ask = QuestionDialog2(
            _("Rebase this tree onto the website's recovered store?"),
            describe_rebase(preview) + "\n\n" + _("Nothing in this tree changes and nothing is sent to the website. Conflicts wait for you. A backup is taken first."),
            _("_Rebase"), _("_Cancel"), parent=self._parent())
        if ask.run():
            OkDialog(_TITLE, describe_rebase(self.actions["rebase"]()), parent=self._parent())
            self._on_check()

    def collect_decisions(self):
        """{conflict id: {"choice", "confirmed"}} for the choices on screen. A choice that needs a confirmation asks for it here."""
        out = {}
        rows = {r["id"]: r for s in self.review.model["sections"] if s["id"] == "conflicts" for r in s["rows"]}
        for cid, radios in self.choices.items():
            chosen = next((k for k, r in radios.items() if r.get_active()), "skip")
            if chosen == "skip":
                continue
            offer = next(x for x in rows[cid]["choices"] if x["id"] == chosen)
            confirmed = False
            if offer["needs_confirmation"]:
                row = rows[cid]
                confirmed = self._ask(offer["label"] + "?", "%s %s\n\n%s" % (row["title"], row["diffs"][0]["label"] if row["diffs"] else "", offer.get("detail", "")))
                if not confirmed:
                    continue
            out[cid] = {"choice": chosen, "confirmed": confirmed}
        return out

    def _on_apply(self, _button):
        refusal = self.flow.editors_refusal()
        if refusal:   # D45: before anything else, and the pull checks again inside its own run
            ErrorDialog(_TITLE, _("A Gramps edit window is open: close open edit windows to sync."), parent=self._parent())
            return
        decisions = self.collect_decisions()
        confirmed = {}
        for modal in self.review.model["confirmations"]:
            confirmed[modal["id"]] = self._confirm_list(modal)
        self.apply_button.set_sensitive(False)
        self.show_text(_("Working..."))
        while Gtk.events_pending():
            Gtk.main_iteration()
        result = self.flow.apply(self.review, decisions, confirmed, step_up=self._step_up)
        self.show_banner(result)

    def _step_up(self):
        if not self._ask(_("Sign in again to send the deletes?"),
                         _("Deleting on the website needs a fresh sign-in (within the last five minutes). A browser window opens for it.")):
            return False
        doc = self.actions["login"](True)
        return doc.get("result") == "ok"

    def show_banner(self, banner):
        self._clear_body()
        self.apply_button.set_sensitive(False)
        self.apply_button.set_label(_("Apply"))
        self.footer.hide()          # the banner carries the undo warning
        self._build_header({"header": self.flow.header(None, None)})
        frame = Gtk.Frame(label=banner["title"])
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        box.set_margin_start(12)
        box.set_margin_end(12)
        box.set_margin_top(8)
        box.set_margin_bottom(8)
        for line in banner["lines"]:
            box.pack_start(_label(line, wrap=True, selectable=True), False, False, 0)
        if banner.get("backup"):
            box.pack_start(_label(_("Backup: %s") % banner["backup"], wrap=True, selectable=True), False, False, 0)
        if banner.get("warning"):
            box.pack_start(_label(banner["warning"], wrap=True, css="hfy-dim"), False, False, 0)
        frame.add(box)
        self.body.pack_start(frame, False, False, 0)
        self.body.show_all()

    def run(self):
        self.dialog.show_all()
        self._on_check()
        try:
            return self.dialog.run()
        finally:
            self.dialog.destroy()


def present(parent, doc, actions):
    """Shows the status; offers the bind for an unbound tree; then the Website sync window. `actions` is a dict of callables: bind(),
    login(step_up), backups(), backups_dir(), latest_log(), restore_hint(name), rebase_check(), rebase(), and `flow` (a review.Flow)."""
    if doc.get("result") == "ok" and not (doc.get("tree") or {}).get("bound"):
        ask = QuestionDialog2(
            _("Bind this tree to the website?"),
            _("The website keeps one family tree bound to it. Binding writes a small marker into this tree and creates the "
              "sync state on this computer. Nothing is sent to the website."),
            _("_Bind this tree"), _("_Not now"), parent=parent)
        if ask.run():
            doc = actions["bind"]()
    if not (doc.get("tree") or {}).get("bound") or doc.get("result") != "ok":
        OkDialog(_TITLE, describe(doc), parent=parent)
        if not (doc.get("tree") or {}).get("bound"):
            return
    SyncWindow(parent, doc, actions).run()
