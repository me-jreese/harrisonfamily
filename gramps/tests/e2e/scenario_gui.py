"""The Gramps window's one-run flow against the local sync dev server (HFY-TSK-208, addon-gui-preview), on copies of the fixture tree.

    conflicts   a composite date conflict (the website corrects a birth year over a local day and month) is decided in the window's
                default way and applies in the same run: the tree gets the website's year with its own day and month, the store keeps the
                year only, and the dev server's request log holds none of the planted fixture values or exact birth dates
    deletes     after the person confirms, the window asks for the fresh sign-in just before the deletes, and the delete batches reach the
                server before the others (D07, SI-35)
    previews    the preview files, status.json and the run logs of those runs hold no local-only value and no object name

The window's logic (`hfygramps.addon.review.Flow`) runs in this process over the real hfy_sync_tool.GrampsTree and the real transport,
exactly as the Gramps window runs it; the Gtk drawing is exercised in gramps/tests/gramps/test_addon_gui.py. Fictional data only.
"""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import e2e_case as C  # noqa: E402
import scenario_push as P  # noqa: E402
from hfygramps.addon import pull, review  # noqa: E402


class GuiFlow(P.PushCase):
    def flow(self, tree):
        client = self.client_for()
        services = {"client": client, "cloud": pull.Cloud(client, self.session.http)}
        return review.Flow(tree, environ=os.environ, services=services)

    def with_flow(self, fn):
        DbTxn, make_database = P.gramps()
        db = make_database("sqlite")
        db.load(self.dir)
        try:
            tree = self.hfy_tool.GrampsTree(db)
            return fn(self.flow(tree), tree)
        finally:
            db.close()

    def run_files_text(self):
        tp = C.S.tree_paths(self.dbid)
        out = []
        for folder in (os.path.join(tp["dir"], "previews"), tp["logs"]):
            if os.path.isdir(folder):
                for n in sorted(os.listdir(folder)):
                    with open(os.path.join(folder, n), encoding="utf-8") as fh:
                        out.append(fh.read())
        with open(tp["status"], encoding="utf-8") as fh:
            out.append(fh.read())
        return "\n".join(out)

    def test_a_composite_date_decided_in_the_window_applies_in_the_same_run_and_no_local_only_value_is_sent(self):  # AC1, AC4, AC6
        self.seed()
        person = self.data[self.person_handle("I0003")]
        birth = self.data[person["event_ref_list"][person["birth_ref_index"]]["ref"]]
        dv = list(birth["date"]["dateval"])
        self.assertTrue(dv[0] and dv[1])
        self.web_edit(birth["handle"], lambda o: o["date"]["dateval"].__setitem__(2, dv[2] + 1), "gui-year")
        mark = len(self.server.entries())

        def go(flow, tree):
            rv = flow.review()
            self.assertIsNone(rv.refusal, rv.refusal)
            (row,) = [r for r in rv.model["by_id"]["conflicts"]["rows"] if r["handle"] == birth["handle"]]
            self.assertEqual(row["default"], "take_year_keep_daymonth")
            self.assertTrue(row["diffs"][0]["yours_local_only"])
            self.assertIn(str(dv[0]), row["diffs"][0]["yours"], "the yours column shows the local day")
            banner = flow.apply(rv, {row["id"]: {"choice": row["default"]}})
            self.assertTrue(banner["ok"], banner)
            return banner

        self.with_flow(go)
        after = self.local_objects()[birth["handle"]]["date"]["dateval"][:3]
        self.assertEqual(after, [dv[0], dv[1], dv[2] + 1], "the tree has the website's year and its own day and month")
        self.assertEqual(self.heads()[birth["handle"]]["obj"]["date"]["dateval"][:3], [0, 0, dv[2] + 1])
        self.log_has_none_of(P.PLANTED + P.birth_needles(self.data), since=mark)
        files = self.run_files_text()
        for needle in P.birth_needles(self.data) + ['"dateval": [%d, %d, %d' % tuple(dv[:3])]:
            self.assertNotIn(needle, files)
        self.assertEqual(self.rows("SELECT state, decision FROM conflicts WHERE path = '/date'"), [("resolved", "take_year_keep_daymonth")])

    def test_the_deletes_go_first_right_after_the_step_up(self):  # AC2, AC8
        pads = self.add_notes(100)
        self.seed()
        gone = pads[:11]
        self.remove_notes(gone)
        self.set_first_name("I0002", "Edited in the window test")
        seeded = len(self.server.requests(method="POST", path="/api/sync/batches"))
        order = []
        calls = {"n": 0}

        def go(flow, tree):
            rv = flow.review()
            self.assertIsNone(rv.refusal, rv.refusal)
            (modal,) = [m for m in rv.model["confirmations"] if m["id"] == "outgoing"]
            self.assertEqual(sorted(o["handle"] for o in modal["objects"]), sorted(gone))

            def step_up():
                calls["n"] += 1
                order.append("step_up")
                flow.services["client"] = self.client_for(self.fresh_step_up())
                return True

            return flow.apply(rv, {}, {"outgoing": True}, step_up=step_up)

        banner = self.with_flow(go)
        self.assertTrue(banner["ok"], banner)
        self.assertEqual(calls["n"], 1)
        batches = self.server.requests(method="POST", path="/api/sync/batches")[seeded:]
        kinds = [{o["op"] for o in b["body"]["ops"]} for b in batches if b["status"] == 200]
        self.assertEqual(kinds, [{"delete"}, {"update"}], "the delete batch first, then the edit")
        live = {h for h, v in self.heads().items() if not v.get("deleted")}
        self.assertFalse(live & set(gone), "the deletes reached the store")


if __name__ == "__main__":
    unittest.main()
