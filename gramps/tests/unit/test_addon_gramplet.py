"""The Website sync gramplet's model (HFY-TSK-278): what it shows, when it asks, that it writes nothing. Synthetic data only; no Gtk."""
import hashlib
import json
import os
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", ".."))
from hfygramps.addon import consts, gramplet_model, oauth, paths, sidecar, status, transport  # noqa: E402

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

    def write_status(self, result="ok", age=2 * 86400):
        paths.atomic_write_json(self.tp.status, {"result": result, "finished_at": status.utc_now(self.clock() - age)})

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

    def test_unbound_tree_does_not_ask(self):
        c = FakeClient()
        m = self.model(c)
        self.assertFalse(m.refresh(True))
        self.assertEqual(c.calls, 0)
        self.assertIn("not bound", m.lines()[0])


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
            for bad in ("atomic_write_json", "status.write", "set_meta", "DbTxn", "commit_", "open(" + "p, \"w", "sidecar.open_checked", ".store("):
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
        self.assertIn('p.id == "hfy_sync"', src)


class Ago(unittest.TestCase):
    def test_ages(self):
        self.assertEqual([gramplet_model.ago(s) for s in (5, 60, 7200, 86400, 3 * 86400)],
                         ["just now", "1 minute ago", "2 hours ago", "1 day ago", "3 days ago"])


if __name__ == "__main__":
    unittest.main()
