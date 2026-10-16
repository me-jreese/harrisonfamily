"""The Website sync window on a real Gramps database (HFY-TSK-208): the editor-window refusal, the window drawn from a review, and screenshots.

Run by run.sh inside the bundled Python on a copy of the fixture tree (Gramps 6.0.6, a Mac with a display), with the installed addon's
`GrampsTree`. The website is the in-memory fake of tests/unit (the real dev server is the e2e lane's). What this file proves that the
unit tests cannot:

  * the D45 refusal reads uistate's managed windows the way Gramps keeps them: a real `EditPrimary` or `EditSecondary` instance in
    `gwm.id2item` makes the window refuse the Apply ("close open edit windows to sync") before anything is requested or changed
  * the Gtk window builds from a review of the real tree and draws every section, conflict choice and button, and a person's name is a
    link with no underline (design rule P2-R46)
  * a screenshot of it, from an offscreen Gtk window on the fixture copy (synthetic data only). Set HFY_GUI_SHOTS to a folder to keep them.

The screenshots here are rendered by a worker, not by io: they are evidence of the layout, and io's G-uat on a fixture copy (or a
computer-use step) is the manual UAT the task asks for (review DL-14).
"""
import copy
import json
import os
import sys
import tempfile
import unittest
from types import SimpleNamespace

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "unit"))
import addon_support as S  # noqa: E402
from test_addon_skeleton import AddonCase  # noqa: E402

try:
    import addon_pull_support as UP  # noqa: E402
    import push_support as PS  # noqa: E402
except ImportError:  # pragma: no cover
    UP = PS = None


def load_modules():
    sys.path.insert(0, S.PLUGIN_DIR)
    try:
        import hfy_sync_tool
        import hfy_sync_ui
        from hfygramps.addon import consts, review, runner
    finally:
        if S.PLUGIN_DIR in sys.path:
            sys.path.remove(S.PLUGIN_DIR)
    return hfy_sync_tool, hfy_sync_ui, consts, review, runner


def widgets(root):
    """Every widget under `root`, depth first."""
    out = [root]
    if hasattr(root, "get_children"):
        for child in root.get_children():
            out += widgets(child)
    return out


class GuiOnARealTree(AddonCase):
    def setUp(self):
        super().setUp()
        try:
            self.tool, self.ui, self.consts, self.review, self.runner = load_modules()
        except ImportError:
            self.skipTest("needs the bundled Gramps")
        from gi.repository import Gdk

        self.Gdk = Gdk
        self.bind()
        self.env = dict(os.environ, HFY_SYNC_PS_CMD="true")

    # ---- the website: a seeded fake holding exactly what the fixture projects
    def website(self, objects, files=None):
        cloud = PS.FakeCloud(self.dbid)
        proj = UP.project_all(objects, files=files)      # a push sends the projection that knows the files (the disk MD5 is the checksum, HFY-TSK-207)
        cloud.heads = {h: {"class": o["_class"], "version": 1, "seq": 1, "deleted": False, "gramps_id": o.get("gramps_id", ""), "obj": o}
                       for h, o in proj.items()}
        cloud.seq, cloud.seeded = 1, True
        return cloud

    def session(self, fn, editors=None):
        """Opens the real tree, settles the first sync (everything shared converges), calls fn(tree, flow, cloud, db)."""
        def run(db, DbTxn):
            uistate = SimpleNamespace(gwm=SimpleNamespace(id2item={}), window=None)
            tree = self.tool.GrampsTree(db, uistate)
            cloud = self.website(tree.objects(), tree.media_files())
            services = {"cloud": PS.PullView(cloud), "client": cloud}
            doc = self.runner.run(tree, "gui", self.runner.Options("pull", yes=True), argv=["gramps"], environ=self.env, services=services)
            self.assertEqual((doc["result"], doc["exit_code"]), ("ok", 0), doc["error"])
            flow = self.review.Flow(tree, environ=self.env, services=services)
            uistate.gwm.id2item.update(editors or {})     # the windows open only now: the settling pull above needs none
            return fn(tree, flow, cloud, db)
        return self.edit(run)

    # ---- D45
    def test_a_real_edit_window_refuses_the_apply_before_anything_changes(self):  # AC5
        from gramps.gui.editors import EditAttribute, EditEvent
        from gramps.gui.editors.editprimary import EditPrimary
        from gramps.gui.editors.editsecondary import EditSecondary

        self.assertTrue(issubclass(EditEvent, EditPrimary) and issubclass(EditAttribute, EditSecondary))
        for cls in (EditEvent, EditAttribute):
            editor = cls.__new__(cls)    # an instance Gramps' window manager holds; its constructor needs a whole window

            def go(tree, flow, cloud, db):
                gid = "I0002"
                handle = next(h for h, o in tree.objects().items() if o.get("gramps_id") == gid)
                cloud.edit(handle, lambda o: o["primary_name"].__setitem__("nick", "Nicky"))
                rv = flow.review()
                self.assertTrue(tree.editors_open())
                before = tree.objects()
                mark = len(cloud.requests)
                banner = flow.apply(rv)
                self.assertFalse(banner["ok"])
                self.assertIn("close open edit windows to sync", banner["lines"][0])
                self.assertTrue(banner["lines"][0].startswith("D45:"))
                self.assertEqual(tree.objects(), before, "nothing changed")
                self.assertEqual(len(cloud.requests), mark, "and nothing was requested")
                self.assertEqual(len(db.get_undodb().undoq), 0)
                return True

            self.assertTrue(self.session(go, editors={"edit-1": editor}))

    def test_with_no_edit_window_open_the_apply_runs_in_one_undo_entry(self):  # AC5 (the control)
        def go(tree, flow, cloud, db):
            handle = next(h for h, o in tree.objects().items() if o.get("gramps_id") == "I0002")
            cloud.edit(handle, lambda o: o["primary_name"].__setitem__("nick", "Nicky"))
            rv = flow.review()
            self.assertFalse(tree.editors_open())
            banner = flow.apply(rv)
            self.assertTrue(banner["ok"], banner)
            self.assertEqual(tree.objects()[handle]["primary_name"]["nick"], "Nicky")
            self.assertEqual(len(db.get_undodb().undoq), 1)
            return True

        self.assertTrue(self.session(go))

    def test_the_window_itself_shows_the_message_and_does_not_apply(self):  # AC5
        from gramps.gui.editors import EditEvent

        shown = []

        def go(tree, flow, cloud, db):
            handle = next(h for h, o in tree.objects().items() if o.get("gramps_id") == "I0002")
            cloud.edit(handle, lambda o: o["primary_name"].__setitem__("nick", "Nicky"))
            window = self.ui.SyncWindow(None, {"result": "ok"}, {"flow": flow}, standalone=True)
            window.load(flow.review())
            self.addCleanup(setattr, self.ui, "ErrorDialog", self.ui.ErrorDialog)
            self.ui.ErrorDialog = lambda title, text, parent=None: shown.append(text)
            mark = len(cloud.requests)
            window._on_apply(window.apply_button)
            self.assertEqual(len(cloud.requests), mark)
            return True

        self.assertTrue(self.session(go, editors={"edit-1": EditEvent.__new__(EditEvent)}))
        self.assertEqual(len(shown), 1)
        self.assertIn("close open edit windows to sync", shown[0])

    # ---- the window
    def test_the_window_draws_the_header_the_sections_the_choices_and_the_buttons(self):  # AC1
        from gi.repository import Gtk

        if self.Gdk.Display.get_default() is None:
            self.skipTest("needs a display")

        def go(tree, flow, cloud, db):
            h1 = next(h for h, o in tree.objects().items() if o.get("gramps_id") == "I0002")
            h2 = next(h for h, o in tree.objects().items() if o.get("gramps_id") == "I0004")
            h3 = next(h for h, o in tree.objects().items() if o.get("gramps_id") == "I0006")
            raw = tree.objects()
            cloud.edit(h1, lambda o: o["primary_name"].__setitem__("first_name", "Theirs"))
            cloud.edit(h2, lambda o: o["primary_name"].__setitem__("nick", "Nicky"))
            from gramps.gen.db import DbTxn
            from gramps.gen.lib.json_utils import data_to_object

            mine = copy.deepcopy(raw[h1])
            mine["primary_name"]["first_name"] = "Mine"
            other = copy.deepcopy(raw[h3])
            other["primary_name"]["call"] = "Cally"
            with DbTxn("test edit", db) as trans:
                db.commit_person(data_to_object(mine), trans)
                db.commit_person(data_to_object(other), trans)
            window = self.ui.SyncWindow(None, {"result": "ok", "tree": {"bound": True}}, {"flow": flow}, standalone=True)
            rv = flow.review()
            window.load(rv)
            all_widgets = widgets(window.root)
            labels = [w.get_text() for w in all_widgets if isinstance(w, Gtk.Label)]
            expanders = [w.get_label() for w in all_widgets if isinstance(w, Gtk.Expander)]
            # To the website: the edited person and the fixture's photo, whose file the website does not hold yet (HFY-TSK-207: the push
            # sends the blob in an update of its own)
            to_rows = [(r["class"], r["gramps_id"]) for r in rv.model["by_id"]["to_website"]["rows"]]
            self.assertEqual(to_rows, [("Media", "O0001"), ("Person", "I0006")])
            for title in ("From the website (1)", "To the website (2)", "Conflicts (1)", "Held back", "Blocked (0)"):
                self.assertTrue(any(e.startswith(title) for e in expanders), (title, expanders))
            self.assertTrue(any(t.startswith("Tree: ") and "harrisonfamily.us" in t and "Signed in as: I9001" in t for t in labels), labels[:6])
            self.assertTrue(any(t.startswith("Last sync: ") for t in labels))
            radios = [w.get_label() for w in all_widgets if isinstance(w, Gtk.RadioButton)]
            self.assertEqual(radios, ["Keep mine", "Take website", "Skip for now"])
            self.assertEqual(sum(1 for w in all_widgets if isinstance(w, Gtk.RadioButton) and w.get_active()), 1)
            self.assertEqual(window.apply_button.get_label(), "Apply 1 · Push 2")
            self.assertTrue(window.apply_button.get_sensitive())
            self.assertIn("Mine", labels, "the yours column is read live from the database")
            self.assertIn("Theirs", labels)
            # a person's name: a link to their page, no underline, no border, the theme's own text (P2-R46)
            links = [w for w in all_widgets if isinstance(w, Gtk.Button) and w.get_style_context().has_class("hfy-person")]
            self.assertTrue(links)
            self.assertTrue(all(b.get_relief() == Gtk.ReliefStyle.NONE and b.get_can_focus() for b in links))
            self.assertTrue(all("/person/?id=I" in b.get_tooltip_text() for b in links))
            self.assertIn("text-decoration: none", self.ui._CSS.decode("utf-8"))
            self.assertNotIn("underline", self.ui._CSS.decode("utf-8"))
            return window

        self.session(go)

    def test_the_modals_the_step_up_and_the_banner_through_the_window(self):  # AC2, AC8
        from gi.repository import Gtk

        if self.Gdk.Display.get_default() is None:
            self.skipTest("needs a display")
        asked, lists = [], []

        class Yes:
            def __init__(self, title, text, yes, no, parent=None):
                asked.append(title)

            def run(self):
                return True

        def go(tree, flow, cloud, db):
            objs = tree.objects()
            text = {h: json.dumps(o, sort_keys=True) for h, o in objs.items()}
            h = next(h for h, o in sorted(objs.items()) if o["_class"] == "Place" and not any(h in t for k, t in text.items() if k != h)
                     and not (cloud.heads.get(h) is None))
            tree.apply("test delete", {}, [("Place", h)])
            window = self.ui.SyncWindow(None, {"result": "ok", "tree": {"bound": True}},
                                        {"flow": flow, "login": lambda step_up=False: (setattr(cloud, "token", PS.make_token(step_up=True)) or {"result": "ok"})},
                                        standalone=True)
            window.load(flow.review())
            titles = [m["title"] for m in window.review.model["confirmations"]]
            self.assertEqual(titles, ["Send 1 change that needs your confirmation?"])
            self.addCleanup(setattr, self.ui, "QuestionDialog2", self.ui.QuestionDialog2)
            self.ui.QuestionDialog2 = Yes
            real_run = Gtk.Dialog.run
            self.addCleanup(setattr, Gtk.Dialog, "run", real_run)
            Gtk.Dialog.run = lambda dlg: (lists.append(dlg.get_title()), Gtk.ResponseType.OK)[1]
            window._on_apply(window.apply_button)
            self.assertTrue(cloud.heads[h]["deleted"], "confirmed, signed in again, and sent")
            return True

        self.assertTrue(self.session(go))
        self.assertEqual(lists, ["Send 1 change that needs your confirmation?"])
        self.assertEqual(asked, ["Sign in again to send the deletes?"], "asked once, just before the deletes")

    def test_open_backups_escapes_the_space_in_application_support_and_says_when_it_cannot_open_the_folder(self):
        if self.Gdk.Display.get_default() is None:
            self.skipTest("needs a display")
        opened, errors = [], []

        def go(tree, flow, cloud, db):
            folder = "/Users/someone/Library/Application Support/hfy_sync/abc/backups"
            window = self.ui.SyncWindow(None, {"result": "ok", "tree": {"bound": True}}, {"flow": flow, "backups_dir": lambda: folder}, standalone=True)
            self.addCleanup(setattr, self.ui, "_open_url", self.ui._open_url)
            self.addCleanup(setattr, self.ui, "ErrorDialog", self.ui.ErrorDialog)
            self.ui.ErrorDialog = lambda title, text, parent=None: errors.append(text)
            self.ui._open_url = lambda url: opened.append(url) or True
            window._on_backups()
            self.assertEqual(opened, ["file:///Users/someone/Library/Application%20Support/hfy_sync/abc/backups"])
            self.assertEqual(errors, [])
            self.ui._open_url = lambda url: False
            window._on_backups()
            self.assertEqual(len(errors), 1)
            self.assertIn(folder, errors[0])
            return True

        self.session(go)

    def test_the_helper_refuses_anything_but_a_web_page_or_a_folder(self):
        for bad in ("javascript:alert(1)", "file://relative", "ftp://x.test/", "", None):
            self.assertFalse(self.ui._open_url(bad), bad)

    def test_screenshots_of_the_window_on_the_fixture_copy(self):  # AC3 (layout evidence; io's G-uat is the manual UAT)
        from gi.repository import Gtk
        from gramps.gen.db import DbTxn
        from gramps.gen.lib.json_utils import data_to_object

        if self.Gdk.Display.get_default() is None:
            self.skipTest("needs a display")
        out_dir = os.environ.get("HFY_GUI_SHOTS") or tempfile.mkdtemp(prefix="hfy-gui-shots-")
        os.makedirs(out_dir, exist_ok=True)
        if not os.environ.get("HFY_GUI_SHOTS"):
            self.addCleanup(__import__("shutil").rmtree, out_dir, True)

        def snap(widget, name, w=940, h=760):
            win = Gtk.OffscreenWindow()
            win.set_size_request(w, h)
            win.add(widget)
            win.show_all()
            for _ in range(50):
                while Gtk.events_pending():
                    Gtk.main_iteration()
            pix = win.get_pixbuf()
            self.assertIsNotNone(pix)
            path = os.path.join(out_dir, name)
            pix.savev(path, "png", [], [])
            win.remove(widget)
            win.destroy()
            self.assertGreater(os.path.getsize(path), 5000)
            return path

        def go(tree, flow, cloud, db):
            objs = tree.objects()
            by = {o.get("gramps_id"): h for h, o in objs.items() if o.get("gramps_id")}
            person = objs[by["I0003"]]
            birth_h = person["event_ref_list"][person["birth_ref_index"]]["ref"]
            cloud.edit(by["I0002"], lambda o: o["primary_name"].__setitem__("first_name", "Theirs"))      # a conflict
            cloud.edit(birth_h, lambda o: o["date"]["dateval"].__setitem__(2, o["date"]["dateval"][2] + 1))  # a composite date conflict
            cloud.edit(by["I0004"], lambda o: o["primary_name"].__setitem__("nick", "Nicky"))              # from the website
            mine = copy.deepcopy(objs[by["I0002"]])
            mine["primary_name"]["first_name"] = "Mine"
            other = copy.deepcopy(objs[by["I0006"]])
            other["primary_name"]["call"] = "Cally"
            with DbTxn("test edit", db) as trans:
                db.commit_person(data_to_object(mine), trans)
                db.commit_person(data_to_object(other), trans)
            window = self.ui.SyncWindow(None, {"result": "ok", "tree": {"bound": True}}, {"flow": flow}, standalone=True)
            window.load(flow.review())
            window.footer.hide()
            first = snap(window.root, "01-preview-sections-and-conflicts.png")
            # open every section and a diff, as a person would
            for w in widgets(window.root):
                if isinstance(w, Gtk.Expander):
                    w.set_expanded(True)
            second = snap(window.root, "02-all-sections-open.png", h=1100)
            decisions = window.collect_decisions()
            banner = flow.apply(window.review, {cid: {"choice": ("take_year_keep_daymonth" if "take_year_keep_daymonth" in window.choices[cid] else "take_website"),
                                                      "confirmed": True} for cid in window.choices})
            window.show_banner(banner)
            third = snap(window.root, "03-result-banner.png", h=420)
            self.assertTrue(decisions == {} or all(v["choice"] for v in decisions.values()))
            return [first, second, third]

        paths = self.session(go)
        self.assertEqual(len(paths), 3)
        self.assertTrue(all(os.path.exists(p) for p in paths))


if __name__ == "__main__":
    unittest.main()
