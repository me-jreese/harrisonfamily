"""The Website sync gramplet's model (HFY-TSK-278): what it shows, when it asks, that it writes nothing. Synthetic data only; no Gtk."""
import hashlib
import json
import os
import sys
import tempfile
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", ".."))
from hfygramps.addon import consts, gramplet_model, oauth, paths, pushstate, sidecar, status, transport  # noqa: E402

REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
DBID = "1700000000abcdef"


class FakeClient:
    def __init__(self, head_seq=5, error=None):
        self.head_seq, self.error, self.calls = head_seq, error, 0

    def meta(self):
        self.calls += 1
        if self.error:
            raise self.error
        return {"api_version": 1, "head_seq": self.head_seq}


class Clock:
    def __init__(self, now=1_800_000_000):
        self.now = now

    def __call__(self):
        return self.now


def snapshot_of(root):
    out = {}
    for base, _dirs, files in os.walk(root):
        for f in files:
            p = os.path.join(base, f)
            with open(p, "rb") as fh:
                out[os.path.relpath(p, root)] = (hashlib.sha256(fh.read()).hexdigest(), os.stat(p).st_mtime_ns)
    return out


class GrampletCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.env = {"HOME": self.tmp.name}
        self.tp = paths.TreePaths(DBID, self.env)
        self.clock = Clock()

    def bind(self, last_pull_seq=2):
        self.tp.ensure()
        sidecar.create(self.tp.sidecar, {"tree_id": "t", "dbid": DBID, "last_pull_seq": last_pull_seq})
        paths.atomic_write_json(self.tp.config, {"dbid": DBID, "server": "https://example.invalid"})

    def record(self, action="pull", result="ok", age=2 * 86400, dry_run=False, run_id=None, write_status=True):
        """Logs a run the way the runner does: the sidecar's runs table (not for a dry run) and status.json (always, as every run does)."""
        doc = status.build(run_id or "R%d" % age + action, action, "cli", DBID, True, result, 0, status.utc_now(self.clock() - age - 1),
                           status.utc_now(self.clock() - age), dry_run=dry_run)
        con = sidecar.open_checked(self.tp.sidecar)
        try:
            sidecar.record_run(con, doc)
        finally:
            con.close()
        if write_status:
            status.write(self.tp, doc)
        return doc

    def write_status(self, result="ok", age=2 * 86400):
        self.record("pull", result, age)

    def own_push(self, *seqs, same_handle=None):
        """The desktop's own acknowledged push, through the real ack path: the base row (one per object, newest seq) and the own seq."""
        con = sidecar.open_checked(self.tp.sidecar)
        try:
            for i, seq in enumerate(seqs):
                handle = same_handle or "h%d_%d" % (seq, i)
                pushstate.set_base(con, "Person", handle, 2, seq, {}, commit=False)
                pushstate.record_own_seq(con, seq)
            con.commit()
        finally:
            con.close()

    def model(self, client):
        return gramplet_model.Model(DBID, lambda: client, self.env, clock=self.clock)


class Display(GrampletCase):
    def test_shows_waiting_changes_and_the_last_sync(self):
        self.bind(2)
        self.write_status("ok", 2 * 86400)
        m = self.model(FakeClient(head_seq=5))
        m.refresh(visible=True)
        self.assertEqual(m.waiting(), 3)
        self.assertEqual(m.lines(), ["Website: 3 changes waiting", "Last sync: ok, 2 days ago"])

    def test_one_change_and_none(self):
        self.bind(4)
        m = self.model(FakeClient(head_seq=5))
        m.refresh(True)
        self.assertEqual(m.lines()[0], "Website: 1 change waiting")
        m = self.model(FakeClient(head_seq=3))  # a store behind the desktop never shows a negative
        m.refresh(True)
        self.assertEqual(m.waiting(), 0)

    def test_no_status_file(self):
        self.bind()
        m = self.model(FakeClient())
        m.refresh(True)
        self.assertEqual(m.lines()[1], "Last sync: none yet")

    def test_damaged_status_file_is_not_an_error(self):
        self.bind()
        with open(self.tp.status, "w") as fh:
            fh.write("{not json")
        m = self.model(FakeClient())
        m.refresh(True)
        self.assertEqual(m.lines()[1], "Last sync: none yet")
        self.record("push", "ok", 3600, write_status=False)
        self.assertEqual(m.lines()[1], "Last sync: ok, 1 hour ago")  # the runs table, not status.json


class OwnPushes(GrampletCase):
    """HFY-TSK-343: the desktop's own pushes are not website changes."""

    def waiting(self, head):
        m = self.model(FakeClient(head_seq=head))
        m.refresh(True)
        return m.waiting(), m.lines()[0]

    def test_a_push_of_two_updates_with_no_website_edit_shows_none(self):
        self.bind(5)
        self.own_push(6, 7)  # two updates pushed: the website gave them seqs 6 and 7
        self.assertEqual(self.waiting(7), (0, "Website: 0 changes waiting"))

    def test_one_website_edit_after_the_push_shows_one(self):
        self.bind(5)
        self.own_push(6, 7)
        self.assertEqual(self.waiting(8), (1, "Website: 1 change waiting"))

    def test_a_website_edit_between_two_pushes_still_counts(self):
        self.bind(5)
        self.own_push(6, 8)  # seq 7 was the website's
        self.assertEqual(self.waiting(8)[0], 1)

    def test_pushes_a_pull_has_taken_in_are_not_taken_off_twice(self):
        self.bind(7)  # a pull since: last_pull_seq already covers seqs 6 and 7
        self.own_push(6, 7)
        self.assertEqual(self.waiting(9)[0], 2)

    def test_never_negative_and_a_store_behind_the_desktop(self):
        self.bind(5)
        self.own_push(6, 7, 9)
        self.assertEqual(self.waiting(7)[0], 0)  # seq 9 is past head: not counted

    def test_the_same_object_pushed_twice_with_no_website_edit_shows_none(self):
        self.bind(5)
        self.own_push(6)
        self.own_push(7, same_handle="hX")  # object X pushed at seq 6, then again at seq 7: base keeps only seq 7
        self.own_push(8, same_handle="hX")
        self.assertEqual(self.waiting(8), (0, "Website: 0 changes waiting"))

    def test_base_rows_a_pull_wrote_are_not_own_pushes(self):
        self.bind(5)
        con = sidecar.open_checked(self.tp.sidecar)
        try:
            con.execute("INSERT INTO base (class, handle, version, seq, hash, obj_json, deleted) VALUES ('Person', 'pulled', 2, 7, 'h', '{}', 0)")
            con.commit()
        finally:
            con.close()
        self.assertEqual(self.waiting(7)[0], 2)

    def test_unbound_tree_does_not_ask(self):
        c = FakeClient()
        m = self.model(c)
        self.assertFalse(m.refresh(True))
        self.assertEqual(c.calls, 0)
        self.assertIn("not bound", m.lines()[0])


class LastSync(GrampletCase):
    """HFY-TSK-343: only real pull, push and sync runs set "Last sync"."""

    def line(self):
        m = self.model(FakeClient())
        m.refresh(True)
        return m.lines()[1]

    def test_a_dry_run_check_does_not_change_it(self):
        self.bind()
        self.record("pull", "ok", 2 * 86400)
        self.record("check", "changes_pending", 30, dry_run=True)
        self.record("push", "changes_pending", 20, dry_run=True)
        self.record("pull", "changes_pending", 10, dry_run=True)
        self.assertEqual(self.line(), "Last sync: ok, 2 days ago")

    def test_a_bind_and_a_status_call_do_not_change_it(self):
        self.bind()
        self.record("push", "ok", 3 * 86400)
        self.record("bind", "ok", 60)
        self.record("status", "ok", 30)
        self.assertEqual(self.line(), "Last sync: ok, 3 days ago")

    def test_only_dry_runs_and_binds_means_none_yet(self):
        self.bind()
        self.record("bind", "ok", 60)
        self.record("check", "changes_pending", 30, dry_run=True)
        self.assertEqual(self.line(), "Last sync: none yet")

    def test_each_real_action_counts(self):
        for action in ("pull", "push", "sync"):
            with self.subTest(action=action):
                self.bind() if not os.path.exists(self.tp.sidecar) else None
                self.record(action, "partial", 600, run_id="X" + action)
                self.assertEqual(self.line(), "Last sync: partial, 10 minutes ago")
                con = sidecar.open_checked(self.tp.sidecar)
                con.execute("DELETE FROM runs")
                con.commit()
                con.close()

    def test_the_newest_real_run_wins(self):
        self.bind()
        self.record("pull", "ok", 5 * 86400)
        self.record("push", "partial", 3600)
        self.assertEqual(self.line(), "Last sync: partial, 1 hour ago")

    def test_a_dry_run_is_marked_in_its_row_and_is_still_logged(self):
        self.bind()
        self.record("push", "changes_pending", 5, dry_run=True)
        self.record("push", "ok", 50)
        con = sidecar.open_checked(self.tp.sidecar)
        try:
            rows = con.execute("SELECT counts_json FROM runs ORDER BY finished_at DESC").fetchall()
        finally:
            con.close()
        self.assertEqual(len(rows), 2, "every run is a row")
        self.assertTrue(json.loads(rows[0][0]).get("dry_run"))
        self.assertNotIn("dry_run", json.loads(rows[1][0]))


class SignIn(GrampletCase):
    def test_no_token_shows_a_sign_in_prompt(self):
        self.bind()
        self.write_status()
        m = self.model(FakeClient(error=oauth.AuthRequired()))
        m.refresh(True)
        self.assertEqual(m.state, gramplet_model.SIGN_IN)
        self.assertTrue(m.lines()[0].startswith("Sign in"))
        self.assertNotIn("rror", " ".join(m.lines()))

    def test_a_401_is_a_sign_in_prompt_and_other_failures_are_quiet(self):
        self.bind()
        m = self.model(FakeClient(error=transport.TransportError("unauthorized", 77, "login", status=401)))
        m.refresh(True)
        self.assertEqual(m.state, gramplet_model.SIGN_IN)
        m = self.model(FakeClient(error=transport.TransportError("network", 69, "retry")))
        m.refresh(True)
        self.assertEqual(m.state, gramplet_model.UNAVAILABLE)
        self.assertIn("unavailable", m.lines()[0])

    def test_a_real_empty_keychain_means_sign_in(self):
        self.bind()

        class Empty:
            def read(self):
                return None
        factory = gramplet_model.client_factory(DBID, "6.0.6", 21, self.env, keychain_override=Empty())
        m = gramplet_model.Model(DBID, factory, self.env, clock=self.clock)
        m.refresh(True)
        self.assertEqual(m.state, gramplet_model.SIGN_IN)


class TokenReuse(GrampletCase):
    def test_one_token_manager_for_many_polls(self):
        self.bind()
        built = []

        class Kc:
            def read(self):
                return "rt"

            def delete(self):
                raise AssertionError("the gramplet must not delete the Keychain item")

        orig = oauth.TokenManager

        class Counting(orig):
            def __init__(self, *a, **k):
                super().__init__(*a, **k)
                built.append(self)

        oauth.TokenManager = Counting
        self.addCleanup(setattr, oauth, "TokenManager", orig)
        factory = gramplet_model.client_factory(DBID, "6.0.6", 21, self.env, keychain_override=Kc())
        self.assertIs(factory(), factory())
        self.assertEqual(len(built), 1, "one TokenManager across polls")

    def test_a_refused_refresh_leaves_the_keychain_item(self):
        self.bind()
        state = {"token": "rt"}

        class Kc:
            def read(self):
                return state["token"]

            def delete(self):
                state["token"] = None

        class Http:
            def request(self, *a, **k):
                raise oauth.AuthRequired()

            def __getattr__(self, name):
                raise oauth.AuthRequired()

        orig = oauth._token_post
        oauth._token_post = lambda *a, **k: (_ for _ in ()).throw(oauth.AuthRequired())
        self.addCleanup(setattr, oauth, "_token_post", orig)
        factory = gramplet_model.client_factory(DBID, "6.0.6", 21, self.env, http=Http(), keychain_override=Kc())
        m = gramplet_model.Model(DBID, factory, self.env, clock=self.clock)
        m.refresh(True)
        self.assertEqual(m.state, gramplet_model.SIGN_IN)
        self.assertEqual(state["token"], "rt", "the item is not deleted from the gramplet")


class RunInProgress(GrampletCase):
    def test_no_ask_while_a_run_holds_state_lock(self):
        from hfygramps.addon import preflight
        self.bind()
        c = FakeClient()
        m = self.model(c)
        with preflight.StateLock(self.tp.lock) as lock:
            self.assertTrue(lock.acquired)
            self.assertFalse(m.refresh(True))
        self.assertEqual(c.calls, 0)
        self.assertTrue(m.refresh(True), "asks once the run is over")

    def test_no_lock_file_is_not_created(self):
        self.bind()
        self.assertFalse(os.path.exists(self.tp.lock))
        self.assertFalse(gramplet_model.run_in_progress(self.tp))
        self.assertFalse(os.path.exists(self.tp.lock))


class SidecarValue(GrampletCase):
    def test_percent_in_path_and_odd_values(self):
        env = {"HOME": os.path.join(self.tmp.name, "a%20b#c")}
        tp = paths.TreePaths(DBID, env)
        tp.ensure()
        sidecar.create(tp.sidecar, {"tree_id": "t", "dbid": DBID, "last_pull_seq": 7})
        self.assertEqual(gramplet_model.read_last_pull_seq(tp), 7)


class Polling(GrampletCase):
    def test_at_most_every_five_minutes(self):
        self.bind()
        c = FakeClient()
        m = self.model(c)
        self.assertTrue(m.refresh(True))
        for _ in range(10):
            self.clock.now += 29
            self.assertFalse(m.refresh(True))
        self.assertEqual(c.calls, 1)
        self.clock.now = m.last_poll + gramplet_model.POLL_INTERVAL_S - 1
        self.assertFalse(m.refresh(True))
        self.clock.now += 1
        self.assertTrue(m.refresh(True))
        self.assertEqual(c.calls, 2)
        self.assertEqual(gramplet_model.POLL_INTERVAL_S, 300)

    def test_only_while_visible(self):
        self.bind()
        c = FakeClient()
        m = self.model(c)
        for _ in range(5):
            self.clock.now += 1000
            self.assertFalse(m.refresh(False))
        self.assertEqual(c.calls, 0)
        self.assertTrue(m.refresh(True))  # shown at last: it asks at once
        self.assertEqual(c.calls, 1)

    def test_a_failed_ask_is_not_retried_early(self):
        self.bind()
        c = FakeClient(error=transport.TransportError("network", 69, "retry"))
        m = self.model(c)
        m.refresh(True)
        self.clock.now += 60
        m.refresh(True)
        self.assertEqual(c.calls, 1)

    def test_a_hidden_gramplet_keeps_its_last_answer(self):
        self.bind(2)
        m = self.model(FakeClient(head_seq=9))
        m.refresh(True)
        self.clock.now += 3600
        m.refresh(False)
        self.assertEqual(m.waiting(), 7)


class NoWrites(GrampletCase):
    def test_nothing_under_the_app_support_folder_changes(self):
        self.bind(2)
        self.write_status()
        before = snapshot_of(self.tmp.name)
        m = self.model(FakeClient(head_seq=8))
        for _ in range(3):
            m.refresh(True)
            self.clock.now += 400
            m.lines()
        self.assertEqual(snapshot_of(self.tmp.name), before)

    def test_the_sidecar_is_opened_read_only(self):
        self.bind(2)
        self.assertEqual(gramplet_model.read_last_pull_seq(self.tp), 2)
        os.chmod(self.tp.sidecar, 0o400)
        os.chmod(self.tp.dir, 0o500)
        self.addCleanup(os.chmod, self.tp.dir, 0o700)
        self.assertEqual(gramplet_model.read_last_pull_seq(self.tp), 2)

    def test_no_write_calls_in_the_gramplet_sources(self):
        for rel in ("gramps/hfygramps/addon/gramplet_model.py", "gramps/hfy_sync/hfy_sync_gramplet.py"):
            with open(os.path.join(REPO, rel), encoding="utf-8") as fh:
                text = fh.read()
            for bad in ("atomic_write_json", "status.write", "set_meta", "DbTxn", "commit_", "open(" + "p, \"w", "sidecar.open_checked", ".store(", ".delete("):
                self.assertNotIn(bad, text, (rel, bad))


class Registration(unittest.TestCase):
    def test_the_gpr_registers_the_gramplet(self):
        with open(os.path.join(REPO, "gramps", "hfy_sync", "hfy_sync.gpr.py"), encoding="utf-8") as fh:
            text = fh.read()
        self.assertIn("GRAMPLET,", text)
        self.assertIn('gramplet="HfySyncGramplet"', text)
        self.assertIn('fname="hfy_sync_gramplet.py"', text)
        self.assertEqual(text.count('version="%s"' % consts.ADDON_VERSION), 2)

    def test_the_gramplet_file_compiles_and_names_the_tool(self):
        with open(os.path.join(REPO, "gramps", "hfy_sync", "hfy_sync_gramplet.py"), encoding="utf-8") as fh:
            src = fh.read()
        compile(src, "hfy_sync_gramplet.py", "exec")
        self.assertIn('TOOL_ID = "hfy_sync"', src)
        self.assertIn("p.id == TOOL_ID", src)
        self.assertNotIn("BasePluginManager", src)


class FakeGtk:
    """Just enough of gi/Gramps to import hfy_sync_gramplet.py and drive its timer without a window."""

    class Window:
        pass

    class Widget:
        def __init__(self, *a, **k):
            self.top = None
            self.parent = object()
            self.mapped = True

        def connect(self, *a):
            pass

        def show_all(self):
            pass

        def pack_start(self, *a):
            pass

        def get_toplevel(self):
            return self.top if self.top is not None else self

        def get_parent(self):
            return self.parent

        def get_mapped(self):
            return self.mapped

        def set_text(self, text):
            self.text = text


class Timers:
    def __init__(self):
        self.live, self.next_id = {}, 1

    def add(self, seconds, fn, *args):
        self.live[self.next_id] = (seconds, fn)
        self.next_id += 1
        return self.next_id - 1

    def remove(self, source_id):
        del self.live[source_id]  # a KeyError here is a double remove, as in GLib


class GrampletGtk(unittest.TestCase):
    """HFY-TSK-343: the timer ends with the gramplet, through hooks Gramps 6.0.6 calls (or by itself), and nothing is connected to a signal."""

    def setUp(self):
        import importlib.util
        import types
        self.timers = Timers()
        glib = types.SimpleNamespace(timeout_add_seconds=self.timers.add, source_remove=self.timers.remove, idle_add=lambda fn, *a: None)
        gtk = types.SimpleNamespace(Label=FakeGtk.Widget, Button=FakeGtk.Widget, Box=FakeGtk.Widget, Window=FakeGtk.Window,
                                    Orientation=types.SimpleNamespace(VERTICAL=1))
        repo = types.ModuleType("gi.repository")
        repo.GLib, repo.Gtk = glib, gtk
        gi = types.ModuleType("gi")
        gi.repository = repo

        class Gramplet:
            def __init__(self):
                container = FakeGtk.Widget()
                container.remove = lambda w: None
                container.add = lambda w: None
                self.gui = types.SimpleNamespace(get_container_widget=lambda: container, textview=object())
                self.connected = []
                self.dbstate = types.SimpleNamespace(db=None)
                self.init()

            def connect(self, *a):
                self.connected.append(a)

        fakes = {"gi": gi, "gi.repository": repo, "gramps": types.ModuleType("gramps"), "gramps.gen": types.ModuleType("gramps.gen"),
                 "gramps.gen.const": types.SimpleNamespace(GRAMPS_LOCALE=types.SimpleNamespace(translation=types.SimpleNamespace(gettext=lambda t: t)),
                                                           VERSION="6.0.6"),
                 "gramps.gen.plug": types.SimpleNamespace(Gramplet=Gramplet)}
        saved = {k: sys.modules.get(k) for k in fakes}
        sys.modules.update(fakes)

        def restore():
            for k, v in saved.items():
                if v is None:
                    sys.modules.pop(k, None)
                else:
                    sys.modules[k] = v
        self.addCleanup(restore)
        spec = importlib.util.spec_from_file_location("hfy_sync_gramplet_under_test", os.path.join(REPO, "gramps", "hfy_sync", "hfy_sync_gramplet.py"))
        self.mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.mod)
        self.g = self.mod.HfySyncGramplet()

    def in_window(self):
        self.g.box.top = FakeGtk.Window()

    def test_a_timer_runs_while_the_gramplet_is_in_a_window_and_ends_itself_when_it_is_gone(self):
        self.in_window()
        self.assertEqual(len(self.timers.live), 1)
        (sid, (seconds, fn)), = self.timers.live.items()
        self.assertEqual(seconds, self.mod.TICK_S)
        self.assertTrue(fn())  # still shown: keeps ticking
        self.g.box.top = None  # Gramps closed the gramplet: its frame left the window
        self.assertFalse(fn(), "GLib removes a source whose callback returns False")
        self.assertIsNone(self.g._tick_source)
        self.assertEqual(self.g._busy, False)

    def test_a_gramplet_taken_out_of_its_container_ends_the_timer(self):
        self.in_window()
        (sid, (seconds, fn)), = self.timers.live.items()
        self.g.box.parent = None  # removed from the pane even though a toplevel is still reachable
        self.assertFalse(fn())

    def test_no_worker_is_started_once_the_gramplet_is_gone(self):
        started = []
        real = self.mod.threading.Thread
        # `self.mod.threading` is the real threading module: patch it for this block only, or every later Thread(...).start() in the
        # process does nothing (the transport test server then never serves and its shutdown blocks forever).
        with mock.patch.object(self.mod.threading, "Thread", lambda *a, **k: started.append(k) or type("T", (), {"start": lambda self: None})()):
            self.g.box.top = None
            self.g._on_timer()
        self.assertEqual(started, [])
        self.assertIs(self.mod.threading.Thread, real, "the patch is undone when the block ends")

    def test_db_changed_and_main_restart_the_timer_once(self):
        self.in_window()
        (sid, (_s, fn)), = self.timers.live.items()
        self.g.box.top = None
        fn()
        self.assertEqual(self.timers.live, {sid: self.timers.live[sid]})  # the fake keeps the dead source until it is removed here
        del self.timers.live[sid]
        self.g.box.top = FakeGtk.Window()
        self.g.db_changed()
        self.g.db_changed()
        self.assertEqual(len(self.timers.live), 1, "one timer, never two")
        list(self.g.main())
        self.assertEqual(len(self.timers.live), 1)

    def test_no_dead_hooks(self):
        self.assertFalse(hasattr(self.g, "on_close"))
        self.g.dbstate.db = object()
        self.g.db_changed()
        self.assertEqual(self.g.connected, [], "database-changed is a DbState signal: the gramplet connects nothing")
        with open(os.path.join(REPO, "gramps", "hfy_sync", "hfy_sync_gramplet.py"), encoding="utf-8") as fh:
            src = fh.read()
        self.assertNotIn("def on_close", src)
        self.assertNotIn(".connect(", src.split("def db_changed")[1].split("\n    def ")[0], "db_changed connects nothing")


class Ago(unittest.TestCase):
    def test_ages(self):
        self.assertEqual([gramplet_model.ago(s) for s in (5, 60, 7200, 86400, 3 * 86400)],
                         ["just now", "1 minute ago", "2 hours ago", "1 day ago", "3 days ago"])


if __name__ == "__main__":
    unittest.main()
