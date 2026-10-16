"""The Website sync gramplet's model end to end (HFY-TSK-278): the installed addon's own sync, the real status.json and sidecar, the dev server.

    count     after a sync, a website edit shows as "1 change waiting" (head_seq - last_pull_seq), and the last sync comes from status.json
    polling   repeated refreshes inside five minutes, and any while not visible, send no /api/sync/meta call
    sign-in   with an empty Keychain it shows the sign-in prompt, not an error
    no writes the gramplet's reads (one Keychain refresh-token rotation aside, asserted) leave status.json, the sidecar and the tree's sqlite.db byte for byte as they were

The Gtk drawing in hfy_sync_gramplet.py is exercised by io's G-uat on the Mac (runbook 19.1); this checks everything it shows. Fictional data only.
"""
import hashlib
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import e2e_case as C  # noqa: E402
import e2e_support as E  # noqa: E402
from hfygramps.addon import gramplet_model, transport  # noqa: E402
from scenario_pull import PullE2E  # noqa: E402


def digest(path):
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


class GrampletE2E(PullE2E):
    def metas(self):
        return len(self.server.requests(method="GET", path="/api/sync/meta"))

    def model(self, keychain, clock):
        factory = gramplet_model.client_factory(self.dbid, "6.0.6", 21, os.environ, http=transport.Http(delays=()), keychain_override=keychain)
        return gramplet_model.Model(self.dbid, factory, os.environ, clock=clock)

    def test_count_polling_signin_and_no_writes(self):
        self.bring_up()
        self.settle()
        self.opened_once()
        now = [1_900_000_000]
        clock = lambda: now[0]  # noqa: E731
        paths = C.S.tree_paths(self.dbid)
        watched = (paths["status"], paths["sidecar"], os.path.join(self.dir, "sqlite.db"))
        before = [digest(p) for p in watched]

        session = E.sign_in(self.server)
        m = self.model(session.keychain, clock)
        self.assertFalse(m.refresh(visible=False))
        hidden = self.metas()
        self.assertEqual(self.metas(), hidden, "hidden: no call")
        self.assertTrue(m.refresh(visible=True))
        self.assertEqual(m.waiting(), 0)
        stores_after_first = session.keychain.stores  # the one disclosed write: the rotated refresh token
        token_after_first = session.keychain.token
        self.assertIn("Last sync: ok", m.lines()[1])

        self.website_edit_note()
        writes = len(self.writes_to_cloud())  # the website's own edit is the last write
        base = self.metas()
        now[0] += 120
        m.refresh(visible=True)
        self.assertEqual(self.metas(), base, "inside five minutes: no call")
        now[0] += 200
        m.refresh(visible=False)
        self.assertEqual(self.metas(), base, "not visible: no call")
        m.refresh(visible=True)
        self.assertEqual(self.metas(), base + 1)
        self.assertEqual(m.lines()[0], "Website: 1 change waiting")
        self.assertEqual(session.keychain.stores, stores_after_first, "the access token is reused: no second refresh")
        self.assertEqual(session.keychain.token, token_after_first)

        empty = self.model(E.MemoryKeychain(), clock)
        empty.refresh(visible=True)
        self.assertEqual(empty.state, gramplet_model.SIGN_IN)
        self.assertTrue(empty.lines()[0].startswith("Sign in"))

        self.assertEqual([digest(p) for p in watched], before)
        self.assertEqual(len(self.writes_to_cloud()), writes, "the gramplet sent nothing to the website")


if __name__ == "__main__":
    unittest.main()
