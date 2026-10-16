"""The push action (task addon-push, HFY-TSK-206): the diff to ops, sessions, the outbox and its idempotent replay, holds, step-up
parking, the mass-delete and identity guards. Standard library only; no Gramps and no network.

    python3 -m unittest gramps/tests/unit/test_addon_push.py

An in-process FakeCloud (push_support.py) answers like the website's /api/sync/* where it matters to the addon, and a PushTree holds the
synthetic fixture tree in memory. The same flows run against the real dev server and real Gramps trees in gramps/tests/e2e/scenario_push.py.
Every value is the fixture's. Python 3.9 compatible.
"""
import copy
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import push_support as PS  # noqa: E402
import test_addon_runtime as R  # noqa: E402
from hfygramps import canonical, merge as M  # noqa: E402
from hfygramps.addon import consts, paths, push, pushplan, pushstate, runner, sidecar, transport  # noqa: E402

PLANTED = ["555-0100", "555-0101", "555-0142", "555-0143", "laurel@example.org", "fixture.contact@example.org", "123 Example Street",
           "999 Private Lane", "100 Example Street"]


def birth_needles(data):
    """`"dateval": [d, m, y,` for every full birth date of the fixture: the form a date has in the dev server's request log."""
    out = []
    for o in data.values():
        if o["_class"] == "Person" and o.get("birth_ref_index", -1) >= 0:
            ev = data[o["event_ref_list"][o["birth_ref_index"]]["ref"]]
            d, m, y = ev["date"]["dateval"][:3]
            if d and m:
                out.append('"dateval": [%d, %d, %d,' % (d, m, y))
    return out


class PushCase(R.HomeCase):
    """A bound PushTree over a slice of the fixture (`full = True`: all of it), a FakeCloud bound to it, and `push()` to run the action."""

    full = False
    pad = 0      # plain unreferenced notes added to the tree: a bigger base keeps deletes over the 90 percent similarity line (D03)

    def setUp(self):
        R.HomeCase.setUp(self)
        self.tree = PS.PushTree(dbid="aa11bb22", full=self.full)
        if self.pad:
            self.tree.pad(self.pad)
        doc = runner.run(self.tree, "cli", runner.Options("bind", yes=True), environ=self.env, argv=["gramps"])
        self.assertEqual((doc["result"], doc["exit_code"]), ("ok", 0), doc)
        self.cloud = PS.FakeCloud(self.tree.dbid)
        self.n = 0

    def push(self, mode="cli", cloud=None, **opts):
        self.n += 1
        opts.setdefault("yes", True)
        return runner.run(self.tree, mode, runner.Options("push", **opts), run_id="r%02d" % self.n, argv=["gramps"], environ=self.env,
                          services={"client": cloud or self.cloud})

    def sidecar(self):
        return sidecar.open_checked(paths.TreePaths(self.tree.dbid, self.env).sidecar)

    def rows(self, sql, *args):
        con = self.sidecar()
        try:
            return con.execute(sql, args).fetchall()
        finally:
            con.close()

    def seed(self):
        doc = self.push()
        self.assertTrue(self.cloud.seeded, doc)
        return doc

    def a_person(self, not_in=()):
        """A pushed (non-excluded) person of the fixture whose handle is not in `not_in`."""
        return next(h for h, hd in sorted(self.cloud.heads.items()) if hd["class"] == "Person" and not hd["deleted"] and h not in not_in)

    def stepped_up(self):
        self.cloud.token = PS.make_token(step_up=True)

    def exit_of(self, doc):
        return (doc["result"], doc["exit_code"], doc["next_action"])


class Seed(PushCase):
    full = True

    def test_the_first_push_opens_a_session_pushes_in_batches_and_completes_it(self):  # AC1 (sessions)
        doc = self.push()
        self.assertEqual(len(self.cloud.sessions), 1)
        self.assertEqual({s["state"] for s in self.cloud.sessions.values()}, {"complete"})
        self.assertTrue(self.cloud.seeded)
        self.assertGreater(len(self.cloud.batches), 1, "the fixture does not fit in one batch of 24")
        sid = next(iter(self.cloud.sessions))
        self.assertTrue(all(b["session_id"] == sid and len(b["ops"]) <= 24 for b in self.cloud.batches))
        self.assertEqual(self.cloud.requests[-2][1], "/api/sync/sessions/%s/complete" % sid)
        self.assertEqual(doc["counts"]["pushed"]["create"], len(self.cloud.heads))
        self.assertEqual(len(self.rows("SELECT * FROM base WHERE deleted = 0")), len(self.cloud.heads))
        self.assertEqual(self.rows("SELECT value FROM meta WHERE key = 'open_session'"), [], "the session is closed")
        self.assertEqual(self.rows("SELECT COUNT(*) FROM outbox WHERE state = 'acked'")[0][0], len(self.cloud.batches))
        self.assertEqual(self.rows("SELECT COUNT(*) FROM outbox WHERE state != 'acked'")[0][0], 0)

    def test_ops_go_in_dependency_order_and_every_object_is_a_create_at_version_one(self):
        self.seed()
        ranks = [pushplan.class_rank(o["class"]) for o in self.cloud.pushed_ops()]
        self.assertEqual(ranks, sorted(ranks), "Tag, Place, Note, Source, Repository, Citation, Media, Event, Person, Family")
        self.assertTrue(all(o["op"] == "create" and o["base_version"] is None for o in self.cloud.pushed_ops()))
        self.assertEqual({h["version"] for h in self.cloud.heads.values()}, {1})

    def test_the_pushed_tree_is_symmetric_so_the_session_can_complete(self):
        # The fixture's private ChildRef is removed from its family by the projection; the child's parent_family_list must not keep
        # pointing at that family, or the website refuses the session at completion (integrity.symmetry.child).
        self.seed()
        objs = {h: hd["obj"] for h, hd in self.cloud.heads.items() if not hd["deleted"]}
        self.assertEqual(M.check_integrity(objs), [])
        private_child = next(o["ref"] for o in self.tree.data.values() if o["_class"] == "Family" for o in o["child_ref_list"] if o.get("private") is True)
        self.assertEqual(objs[private_child]["parent_family_list"], [])
        self.assertTrue(self.tree.data[private_child]["parent_family_list"], "the desktop keeps the link")
        sent = len(self.cloud.batches)
        self.push()
        self.assertEqual(len(self.cloud.batches), sent, "and the next run finds nothing to send")

    def test_held_content_never_reaches_the_server(self):  # AC3
        self.seed()
        text = self.cloud.log_text()
        for planted in PLANTED:
            self.assertNotIn(planted, text)
        needles = birth_needles(self.tree.data)
        self.assertGreater(len(needles), 5, "the fixture must have full birth dates to look for")
        for needle in needles:
            self.assertNotIn(needle, text)
        # and the holds say so, in the sidecar and in the status counts
        self.assertGreater(len(self.rows("SELECT * FROM holds")), 0)

    def test_the_run_ends_partial_when_something_is_held_and_the_status_counts_say_how_much(self):
        doc = self.seed_doc = self.push()
        self.assertEqual(self.exit_of(doc)[:2], ("partial", 20))
        self.assertEqual(doc["counts"]["holds"], len(self.rows("SELECT * FROM holds")))
        self.assertNotIn("555", json.dumps(doc), "status.json carries counts and codes only")

    def test_a_second_run_finds_nothing_to_push(self):
        self.seed()
        sent = len(self.cloud.batches)
        doc = self.push()
        self.assertEqual(len(self.cloud.batches), sent)
        self.assertEqual(doc["counts"]["pushed"], {"create": 0, "update": 0, "delete": 0})

    def test_dry_run_writes_a_preview_and_changes_nothing(self):  # sync.md 8.3 step 5
        doc = self.push(dry_run=True)
        self.assertEqual(self.exit_of(doc), ("changes_pending", 10, "none"))
        self.assertEqual(self.cloud.batches, [])
        self.assertFalse(self.cloud.sessions)
        self.assertEqual(self.rows("SELECT COUNT(*) FROM base")[0][0], 0)
        self.assertEqual(self.rows("SELECT COUNT(*) FROM outbox")[0][0], 0)
        preview = paths.read_json(os.path.join(paths.TreePaths(self.tree.dbid, self.env).previews, "r01.json"))
        self.assertEqual(preview["counts"]["create"], len(self.cloud.heads) or preview["counts"]["create"])
        self.assertGreater(preview["counts"]["create"], 50)
        text = json.dumps(preview)
        for planted in PLANTED:
            self.assertNotIn(planted, text)

    def test_cli_without_yes_is_a_dry_run_for_the_wrapper_but_the_runner_obeys_dry_run_only(self):
        doc = self.push(dry_run=True, yes=False)
        self.assertEqual(doc["dry_run"], True)


class FullFixture(PushCase):
    full = True

    def test_a_birth_retyped_in_the_cloud_is_a_composite_conflict_and_no_day_or_month_goes_out(self):  # AC3 fixture flow
        self.seed()
        person = self.tree.person_by_id("I0003")
        birth = self.tree.data[person["event_ref_list"][person["birth_ref_index"]]["ref"]]
        full = birth["date"]["dateval"]
        self.assertTrue(full[0] and full[1], "the fixture's birth has a day and a month")
        self.cloud.edit(birth["handle"], lambda o: o["type"].update({"value": 42, "string": ""}))   # Birth retyped to Residence on the web
        self.assertEqual(self.cloud.heads[birth["handle"]]["obj"]["date"]["dateval"][:2], [0, 0], "the cloud copy never had the day and month")
        mark = len(self.cloud.requests)
        doc = self.push()
        self.assertEqual(self.exit_of(doc), ("partial", 20, "resolve_conflicts"))
        after = "\n".join(b for _m, _p, b in self.cloud.requests[mark:] if b)
        self.assertNotIn('"dateval": [%d, %d, %d' % tuple(full[:3]), after)
        for needle in birth_needles(self.tree.data):
            self.assertNotIn(needle, after)
        self.assertEqual(self.cloud.heads[birth["handle"]]["obj"]["type"]["value"], 42, "the website's value stands")
        conflicts = self.rows("SELECT handle, kind, state FROM conflicts")
        self.assertEqual([(h, k, s) for h, k, s in conflicts if h == birth["handle"]], [(birth["handle"], "composite", "parked")],
                         "the command line parks it, as the pull does; the Gramps window leaves it open")
        # three more runs with no edits: the conflict stays open and the cloud is not touched
        before = (len(self.cloud.batches), copy.deepcopy(self.cloud.heads))
        for _ in range(3):
            again = self.push()
            self.assertEqual(self.exit_of(again), ("partial", 20, "resolve_conflicts"))
        self.assertEqual((len(self.cloud.batches), self.cloud.heads), before)
        self.assertEqual(self.tree.data[birth["handle"]]["date"]["dateval"][:3], full[:3], "the desktop value is unchanged")



class LocalEdit(PushCase):
    def test_a_local_edit_is_pushed_the_version_increments_and_the_base_advances(self):  # AC1
        self.seed()
        h = self.a_person()
        self.tree.edit(h, lambda o: o["primary_name"].__setitem__("first_name", "Edited"))
        before = self.rows("SELECT version FROM base WHERE handle = ?", h)[0][0]
        doc = self.push()
        self.assertEqual(doc["counts"]["pushed"], {"create": 0, "update": 1, "delete": 0})
        self.assertEqual(self.cloud.heads[h]["version"], before + 1)
        self.assertEqual(self.cloud.heads[h]["obj"]["primary_name"]["first_name"], "Edited")
        row = self.rows("SELECT version, obj_json, hash FROM base WHERE handle = ?", h)[0]
        self.assertEqual(row[0], before + 1, "the base row is at the new version")
        self.assertEqual(json.loads(row[1]), self.cloud.heads[h]["obj"], "and holds the pushed object")
        self.assertEqual(row[2], canonical.object_hash(self.cloud.heads[h]["obj"]))
        self.assertFalse(any("session_id" in b for b in self.cloud.batches[-1:]), "one batch needs no session")
        op = self.cloud.pushed_ops()[-1]
        self.assertEqual((op["op"], op["base_version"]), ("update", before))

    def test_the_pushed_object_is_the_projection_of_the_lifted_merge_at_the_cloud_version(self):  # AC7
        self.seed()
        h = self.a_person()
        orig = copy.deepcopy(self.cloud.heads[h]["obj"])
        other = 2 if orig["gender"] != 2 else 1
        head = self.cloud.edit(h, lambda o: o.__setitem__("gender", other))                         # the website edits field a
        self.tree.edit(h, lambda o: o["primary_name"].__setitem__("first_name", "Zed"))              # the desktop edits field b
        doc = self.push()
        op = self.cloud.pushed_ops()[-1]
        self.assertEqual((op["op"], op["base_version"]), ("update", head["version"]), "base_version = C.version")
        merged = self.cloud.heads[h]["obj"]
        self.assertEqual((merged["gender"], merged["primary_name"]["first_name"]), (other, "Zed"), "one run, no 409, both edits")
        self.assertEqual(doc["counts"]["pushed"]["update"], 1)
        # the desktop has not applied the website's edit (that is the pull), so the base row stays what it was: the next run takes the
        # website's edit and finds the desktop's own edit already in the cloud, instead of reading the missing edit as a revert
        row = self.rows("SELECT version, obj_json FROM base WHERE handle = ?", h)[0]
        self.assertEqual((row[0], json.loads(row[1])["gender"]), (1, orig["gender"]))
        before = len(self.cloud.batches)
        self.push()
        self.assertEqual(len(self.cloud.batches), before, "nothing reverts the website's edit on the next run")
        # once the pull has applied it (here: by hand), there is nothing left to do and the base follows the cloud
        self.tree.edit(h, lambda o: o.__setitem__("gender", other))
        self.push()
        self.assertEqual(len(self.cloud.batches), before)
        self.assertEqual(self.rows("SELECT version FROM base WHERE handle = ?", h)[0][0], self.cloud.heads[h]["version"])

    def test_a_converged_object_advances_the_base_without_a_push(self):
        self.seed()
        h = self.a_person()
        self.cloud.edit(h, lambda o: o["primary_name"].__setitem__("first_name", "Same"))
        self.tree.edit(h, lambda o: o["primary_name"].__setitem__("first_name", "Same"))
        self.push()
        self.assertEqual(self.rows("SELECT version FROM base WHERE handle = ?", h)[0][0], self.cloud.heads[h]["version"])
        self.assertEqual(len(self.cloud.pushed_ops()), len([o for o in self.cloud.pushed_ops() if o["op"] == "create"]))

    def test_a_cloud_only_change_is_left_for_the_pull(self):
        self.seed()
        h = self.a_person()
        self.cloud.edit(h, lambda o: o["primary_name"].__setitem__("first_name", "Web"))
        before = len(self.cloud.batches)
        doc = self.push()
        self.assertEqual(len(self.cloud.batches), before)
        self.assertEqual(self.rows("SELECT version FROM base WHERE handle = ?", h)[0][0], 1, "the base is not advanced past what the desktop has")
        self.assertEqual(doc["counts"]["pushed"], {"create": 0, "update": 0, "delete": 0})


class Outbox(PushCase):
    def edit_one(self):
        self.seed()
        h = self.a_person()
        self.tree.edit(h, lambda o: o["primary_name"].__setitem__("first_name", "Edited"))
        return h

    def test_a_lost_response_is_replayed_with_the_same_key_and_advances_the_base(self):  # AC2
        h = self.edit_one()
        self.cloud.lose_response = 1
        doc = self.push()
        self.assertEqual((doc["result"], doc["exit_code"]), ("failed", 75))
        self.assertEqual(self.cloud.heads[h]["version"], 2, "the server committed")
        sent = self.rows("SELECT batch_key, state FROM outbox WHERE state = 'sent'")
        self.assertEqual(len(sent), 1)
        self.assertEqual(self.rows("SELECT version FROM base WHERE handle = ?", h)[0][0], 1, "no acknowledgement, no new base")
        doc = self.push()
        self.assertEqual(self.cloud.replays, [sent[0][0]], "the same Idempotency-Key, answered with Idempotent-Replayed")
        self.assertEqual(self.cloud.heads[h]["version"], 2, "committed once")
        self.assertEqual(self.rows("SELECT version FROM base WHERE handle = ?", h)[0][0], 2)
        self.assertEqual(self.rows("SELECT state FROM outbox WHERE batch_key = ?", sent[0][0])[0][0], "acked")
        self.assertEqual(doc["counts"]["pushed"]["update"], 1)
        self.push()
        self.assertEqual(self.cloud.heads[h]["version"], 2)

    def test_a_409_is_partial_and_the_next_run_converges(self):  # AC2
        h = self.edit_one()
        self.cloud.on_batch = lambda: self.cloud.edit(h, lambda o: o.__setitem__("gender", 2 if o["gender"] != 2 else 1))   # the website moves first
        doc = self.push()
        self.assertEqual(self.exit_of(doc), ("partial", 75, "retry"))
        self.assertEqual(doc["error"]["code"], "version_conflict")
        self.assertEqual(self.rows("SELECT state FROM outbox ORDER BY rowid DESC LIMIT 1")[0][0], "rejected")
        self.assertEqual(self.rows("SELECT version FROM base WHERE handle = ?", h)[0][0], 1)
        self.push()
        self.assertEqual(self.cloud.heads[h]["obj"]["primary_name"]["first_name"], "Edited", "converged: the edit is in")
        self.assertEqual(self.cloud.heads[h]["version"], 3)
        sent = len(self.cloud.batches)
        self.push()
        self.assertEqual(len(self.cloud.batches), sent)

    def test_a_pending_entry_from_a_crash_before_the_send_is_discarded_and_replanned(self):  # AC8
        h = self.edit_one()
        con = self.sidecar()
        try:
            pushstate.outbox_add(con, "crashed-key", None, "2026-10-14T00:00:00Z", {"body": {"ops": [{"op": "update", "class": "Person", "handle": h, "op_id": "1", "obj": {"x": 1}}]}})
        finally:
            con.close()
        self.push()
        self.assertEqual(self.rows("SELECT * FROM outbox WHERE batch_key = 'crashed-key'"), [])
        self.assertEqual(self.cloud.heads[h]["obj"]["primary_name"]["first_name"], "Edited", "the plan was recomputed from the tree")
        self.assertNotIn("crashed-key", [k for _m, _p, b in self.cloud.requests for k in [b] if "crashed-key" in b])

    def test_a_replay_answered_409_422_or_410_is_rejected_and_the_next_plan_recomputes(self):  # AC8
        for status, code in ((409, "version_conflict"), (422, "idempotency_key_reused"), (410, "gone")):
            with self.subTest(status=status):
                self.fresh_world()
                h = self.edit_one()
                # the first send never reaches the store (the connection dies), so the row stays `sent`
                self.cloud.fail_with.append(("/api/sync/batches", PS.transport.TransportError("network", 75, "retry", message="x")))
                doc = self.push()
                self.assertEqual((doc["result"], doc["exit_code"]), ("failed", 75))
                key = self.rows("SELECT batch_key FROM outbox WHERE state = 'sent'")[0][0]
                # the replay is answered 409, 422 or 410: the row is `rejected` for good and the base does not move on that answer
                self.cloud.fail_with.append(("/api/sync/batches", PS.transport.TransportError(code, 75, "retry", status=status, message="x")))
                self.push()
                self.assertEqual(self.rows("SELECT state FROM outbox WHERE batch_key = ?", key)[0][0], "rejected")
                self.assertNotIn(key, self.cloud.replays)
                # the plan was recomputed from the tree: the same edit went out again under a NEW key, and only that acknowledgement
                # moved the base
                new = self.rows("SELECT batch_key FROM outbox WHERE state = 'acked' ORDER BY rowid DESC LIMIT 1")[0][0]
                self.assertNotEqual(new, key)
                self.assertEqual(self.cloud.heads[h]["version"], 2)
                self.assertEqual(self.rows("SELECT version FROM base WHERE handle = ?", h)[0][0], 2)
                self.push()
                self.assertEqual(self.cloud.heads[h]["version"], 2, "and nothing is sent twice")

    def fresh_world(self):
        """A second tree, home and cloud for a subTest that needs a clean start."""
        self.n += 100
        self.tree = PS.PushTree(dbid="aa11bb22", full=self.full)
        if self.pad:
            self.tree.pad(self.pad)
        self.env = {"HOME": self.tmp + "-x%d" % self.n, "GRAMPSHOME": self.tmp + "-x%d/gh" % self.n, "HFY_SYNC_TEST": "1", "HFY_SYNC_PS_CMD": "true"}
        os.makedirs(self.env["HOME"], exist_ok=True)
        self.addCleanup(__import__("shutil").rmtree, self.env["HOME"], True)
        doc = runner.run(self.tree, "cli", runner.Options("bind", yes=True), environ=self.env, argv=["gramps"])
        self.assertEqual(doc["exit_code"], 0, doc)
        self.cloud = PS.FakeCloud(self.tree.dbid)

    def test_only_a_2xx_or_a_replayed_answer_advances_the_base(self):  # AC8
        h = self.edit_one()
        self.cloud.fail_with.append(("/api/sync/batches", PS.transport.TransportError("busy", 75, "retry", status=503, message="x")))
        doc = self.push()
        self.assertEqual((doc["result"], doc["exit_code"]), ("failed", 75))
        self.assertEqual(self.rows("SELECT version FROM base WHERE handle = ?", h)[0][0], 1)
        self.assertEqual(self.cloud.heads[h]["version"], 1, "the server never saw it")
        self.assertEqual(self.rows("SELECT state FROM outbox WHERE state != 'acked'")[0][0], "sent")
        self.push()
        self.assertEqual(self.rows("SELECT version FROM base WHERE handle = ?", h)[0][0], 2)

    def test_the_outbox_is_written_before_the_send(self):
        h = self.edit_one()
        seen = []
        real = self.cloud.post

        def spy(path, body=None, idempotency_key=None):
            if path == "/api/sync/batches":
                con = self.sidecar()
                try:
                    seen.append(con.execute("SELECT state, request_json FROM outbox WHERE batch_key = ?", (idempotency_key,)).fetchone())
                finally:
                    con.close()
            return real(path, body, idempotency_key)

        self.cloud.post = spy
        self.push()
        self.assertEqual(seen[0][0], "sent")
        self.assertIn(h, seen[0][1])


class Destructive(PushCase):
    pad = 30

    def delete_pads(self, n):
        """Seeds the tree with enough padding that n deletes stay over the 90 percent similarity line, then deletes n padding notes locally."""
        self.tree.pad(100)
        self.seed()
        gone = self.tree.pads[:n]
        for h in gone:
            del self.tree.data[h]
        return gone

    def delete_events(self, n):
        events = [h for h, hd in sorted(self.cloud.heads.items()) if hd["class"] == "Event"][:n]
        for h in events:
            del self.tree.data[h]
        return events

    def test_deletes_without_step_up_are_parked_with_exit_20(self):  # AC4
        self.seed()
        gone = self.delete_events(2)
        before = len(self.cloud.batches)
        doc = self.push(allow_deletes=True)
        self.assertEqual(self.exit_of(doc), ("partial", 20, "step_up"))
        self.assertEqual(len(self.cloud.batches), before, "nothing was sent for them")
        self.assertTrue(all(not self.cloud.heads[h]["deleted"] for h in gone))
        self.assertEqual({r[0] for r in self.rows("SELECT rule FROM holds WHERE handle IN (?, ?)", *gone)}, {"step_up_required"})
        self.assertEqual(doc["counts"]["blocked"], 2)

    def test_deletes_with_a_fresh_step_up_and_allow_deletes_are_pushed_last_in_their_own_batch(self):
        self.seed()
        gone = self.delete_events(2)
        self.stepped_up()
        doc = self.push(allow_deletes=True)
        self.assertEqual(doc["counts"]["pushed"]["delete"], 2)
        self.assertTrue(all(self.cloud.heads[h]["deleted"] for h in gone))
        last = self.cloud.batches[-1]
        self.assertEqual({o["op"] for o in last["ops"]}, {"delete"})
        self.assertEqual({r[0] for r in self.rows("SELECT deleted FROM base WHERE handle = ?", gone[0])}, {1})

    def test_the_cli_does_not_delete_without_allow_deletes(self):
        self.seed()
        self.delete_events(1)
        self.stepped_up()
        before = len(self.cloud.batches)
        self.push()
        self.assertEqual(len(self.cloud.batches), before)
        self.assertEqual(self.rows("SELECT rule FROM holds WHERE rule = 'delete_parked'")[0][0], "delete_parked")

    def test_the_cli_never_pushes_a_mass_delete_even_with_step_up_and_allow_deletes(self):  # AC4
        gone = self.delete_pads(11)
        self.stepped_up()
        before = len(self.cloud.batches)
        doc = self.push(allow_deletes=True)
        self.assertEqual(len(self.cloud.batches), before)
        self.assertEqual(doc["counts"]["pushed"]["delete"], 0)
        self.assertEqual({r[0] for r in self.rows("SELECT rule FROM holds WHERE handle IN (%s)" % ",".join("?" * len(gone)), *gone)}, {"mass_delete"})
        self.assertTrue(all(not self.cloud.heads[h]["deleted"] for h in gone))

    def test_more_than_five_percent_of_the_synced_objects_is_a_mass_delete_below_ten(self):
        self.seed()
        n = len(self.cloud.heads) * 5 // 100 + 1
        self.assertLessEqual(n, 10)
        for h in self.tree.pads[:n]:
            del self.tree.data[h]
        self.stepped_up()
        self.push(allow_deletes=True)
        self.assertEqual({r[0] for r in self.rows("SELECT rule FROM holds WHERE rule IN ('mass_delete')")}, {"mass_delete"})

    def test_the_gui_pushes_a_mass_delete_only_with_the_users_confirmation(self):
        self.delete_pads(11)
        self.stepped_up()
        before = len(self.cloud.batches)
        self.push(mode="gui", yes=False)
        self.assertEqual(len(self.cloud.batches), before)
        doc = self.push(mode="gui", yes=True)
        self.assertEqual(doc["counts"]["pushed"]["delete"], 11)

    def test_a_server_step_up_refusal_parks_the_deletes_and_the_rest_still_goes(self):  # D07
        self.seed()
        gone = self.delete_events(2)
        h = self.a_person()
        self.tree.edit(h, lambda o: o["primary_name"].__setitem__("first_name", "Edited"))
        self.stepped_up()
        self.cloud.no_step_up = True          # the token looks fresh to the addon; the server disagrees
        doc = self.push(allow_deletes=True)
        self.assertEqual(self.exit_of(doc), ("partial", 20, "step_up"))
        self.assertEqual(self.cloud.heads[h]["obj"]["primary_name"]["first_name"], "Edited")
        self.assertTrue(all(not self.cloud.heads[x]["deleted"] for x in gone))

    def test_a_person_renumber_is_blocked(self):  # AC4
        self.seed()
        h = self.a_person()
        self.tree.edit(h, lambda o: o.__setitem__("gramps_id", "I0777"))
        self.tree.edit(h, lambda o: o["primary_name"].__setitem__("first_name", "Edited"))
        before = len(self.cloud.batches)
        doc = self.push()
        self.assertEqual(len(self.cloud.batches), before, "nothing of the person is sent")
        self.assertEqual(self.rows("SELECT rule FROM holds WHERE handle = ? AND rule = 'renumber_blocked'", h)[0][0], "renumber_blocked")
        self.assertEqual(doc["counts"]["blocked"], 1)
        self.assertEqual(self.cloud.heads[h]["gramps_id"], PS.load_fixture()[h]["gramps_id"])

    def test_clearing_a_persons_id_is_a_renumber_and_is_blocked_on_the_client(self):
        self.seed()
        h = self.a_person()
        self.tree.edit(h, lambda o: o.__setitem__("gramps_id", ""))
        before = len(self.cloud.batches)
        doc = self.push()
        self.assertEqual(len(self.cloud.batches), before, "nothing of the person is sent")
        self.assertEqual(self.rows("SELECT rule FROM holds WHERE handle = ?", h)[0][0], "renumber_blocked")
        self.assertEqual(doc["counts"]["blocked"], 1)

    def test_a_non_person_renumber_pushes_normally(self):
        self.seed()
        ev = next(h for h, hd in sorted(self.cloud.heads.items()) if hd["class"] == "Event")
        self.tree.edit(ev, lambda o: o.__setitem__("gramps_id", "E0555"))
        self.push()
        self.assertEqual(self.cloud.heads[ev]["gramps_id"], "E0555")


class Merges(PushCase):
    pad = 30

    def setUp(self):
        PushCase.setUp(self)
        self.seed()
        self.gone = self.a_person()
        self.gone_id = self.cloud.heads[self.gone]["gramps_id"]
        self.survivor = self.a_person(not_in=(self.gone,))
        self.stepped_up()

    def merge_locally(self, attribute=True):
        def mark(o):
            o["attribute_list"].append({"_class": "Attribute", "citation_list": [], "note_list": [], "private": False,
                                        "type": {"_class": "AttributeType", "string": consts.MERGED_ID_ATTRIBUTE, "value": 0}, "value": self.gone_id})
        if attribute:
            self.tree.edit(self.survivor, mark)
        del self.tree.data[self.gone]

    def test_a_merge_is_held_while_merges_enabled_is_false(self):  # AC4
        self.merge_locally()
        doc = self.push(mode="gui", yes=True, allow_deletes=True)
        self.assertFalse(self.cloud.heads[self.gone]["deleted"])
        self.assertEqual(self.rows("SELECT rule FROM holds WHERE handle = ? AND rule = 'merge_held'", self.gone)[0][0], "merge_held")
        self.assertEqual(self.cloud.aliases, [])
        self.assertEqual(doc["counts"]["holds"] >= 1, True)
        survivor = self.cloud.heads[self.survivor]["obj"]
        self.assertTrue(pushplan.merged_ids(survivor), "the survivor's own edit is still pushed")

    def test_a_held_merge_is_still_a_merge_on_the_next_run_and_goes_once_merges_are_enabled(self):  # AC4
        self.merge_locally()
        self.push(mode="gui", yes=True, allow_deletes=True)
        self.push(mode="gui", yes=True, allow_deletes=True)      # the survivor went out on the first run; its base row stayed
        self.assertEqual(self.rows("SELECT rule FROM holds WHERE handle = ?", self.gone)[0][0], "merge_held")
        self.assertFalse(self.cloud.heads[self.gone]["deleted"], "not read as a plain delete")
        self.cloud.merges_enabled = True
        self.cloud.members = []
        self.push(mode="gui", yes=True, allow_deletes=True)
        self.assertTrue(self.cloud.heads[self.gone]["deleted"])
        self.assertEqual(len(self.cloud.aliases), 1)
        self.assertEqual(self.rows("SELECT version FROM base WHERE handle = ?", self.survivor)[0][0], self.cloud.heads[self.survivor]["version"])

    def test_a_merged_away_member_principal_is_blocked_with_guidance(self):  # AC4
        self.cloud.merges_enabled = True
        self.cloud.members = [self.gone_id]
        self.merge_locally()
        self.push(mode="gui", yes=True, allow_deletes=True)
        self.assertFalse(self.cloud.heads[self.gone]["deleted"])
        row = self.rows("SELECT rule, detail FROM holds WHERE handle = ?", self.gone)[0]
        self.assertEqual(row[0], "merge_member_principal")
        self.assertIn("Merge the other way", row[1])

    def test_with_merges_enabled_a_gui_merge_with_step_up_produces_an_alias(self):  # AC4
        self.cloud.merges_enabled = True
        self.cloud.members = []
        self.merge_locally()
        doc = self.push(mode="gui", yes=True, allow_deletes=True)
        self.assertTrue(self.cloud.heads[self.gone]["deleted"])
        op = next(o for o in self.cloud.pushed_ops() if o["handle"] == self.gone and o["op"] == "delete")
        self.assertEqual((op["reason"], op["merged_into"]), ("merge", self.cloud.heads[self.survivor]["gramps_id"]))
        self.assertEqual(self.cloud.aliases, [{"old": self.gone_id, "into": self.cloud.heads[self.survivor]["gramps_id"]}])
        self.assertEqual(doc["counts"]["pushed"]["delete"], 1)

    def test_the_cli_parks_a_merge(self):
        self.cloud.merges_enabled = True
        self.cloud.members = []
        self.merge_locally()
        self.push(mode="cli", yes=True, allow_deletes=True)
        self.assertEqual(self.rows("SELECT rule FROM holds WHERE handle = ? AND rule = 'merge_gui_only'", self.gone)[0][0], "merge_gui_only")
        self.assertFalse(self.cloud.heads[self.gone]["deleted"])

    def test_a_merge_cannot_be_verified_without_the_members_list(self):
        self.cloud.merges_enabled = True
        self.merge_locally()
        self.push(mode="gui", yes=True, allow_deletes=True)
        self.assertEqual(self.rows("SELECT rule FROM holds WHERE handle = ?", self.gone)[0][0], "merge_unverified")

    def test_the_merged_id_attribute_must_be_new_since_base(self):  # AC4
        self.cloud.merges_enabled = True
        self.cloud.members = []
        self.merge_locally()
        self.push(mode="gui", yes=True, allow_deletes=True)      # the merge goes through once, the attribute is now in the base
        # a different person is deleted that happens to hold an old id already in the survivor's attribute: not a merge
        self.cloud.aliases.clear()
        other = self.a_person(not_in=(self.gone, self.survivor))
        other_id = self.cloud.heads[other]["gramps_id"]
        self.tree.edit(self.survivor, lambda o: o["attribute_list"].append(
            {"_class": "Attribute", "citation_list": [], "note_list": [], "private": False, "type": {"_class": "AttributeType", "string": consts.MERGED_ID_ATTRIBUTE, "value": 0}, "value": other_id}))
        self.push(mode="gui", yes=True, allow_deletes=True)      # base now holds `other_id` too
        del self.tree.data[other]
        self.push(mode="gui", yes=True, allow_deletes=True)
        self.assertTrue(self.cloud.heads[other]["deleted"])
        self.assertEqual(self.cloud.aliases, [], "the attribute was not new in this push, so it is a plain delete, not a merge")


class Identity(PushCase):
    pad = 30

    def new_person(self, gramps_id, handle="newhandle0000000000000000a1"):
        template = copy.deepcopy(next(o for o in PS.load_fixture().values() if o["_class"] == "Person" and o["gramps_id"] == "I0002"))
        template.update({"handle": handle, "gramps_id": gramps_id, "event_ref_list": [], "family_list": [], "parent_family_list": [], "media_list": [],
                         "citation_list": [], "note_list": [], "birth_ref_index": -1, "death_ref_index": -1, "address_list": [], "attribute_list": [],
                         "person_ref_list": [], "tag_list": [], "lds_ord_list": [], "alternate_names": []})
        template["primary_name"] = dict(template["primary_name"], first_name="Fresh", surname_list=[dict(template["primary_name"]["surname_list"][0], surname="Newperson")], date={"_class": "Date", "calendar": 0, "dateval": [0, 0, 0, False], "format": None, "modifier": 0, "newyear": 0, "quality": 0, "sortval": 0, "text": ""})
        self.tree.data[handle] = template
        return handle

    def test_a_desktop_create_in_the_8000_block_is_held_with_reserved_id_block(self):  # AC5
        self.seed()
        h = self.new_person("I8123")
        before = len(self.cloud.batches)
        self.push()
        self.assertEqual(len(self.cloud.batches), before)
        self.assertEqual(self.rows("SELECT rule FROM holds WHERE handle = ? AND rule = 'reserved_id_block'", h)[0][0], "reserved_id_block")
        self.assertNotIn(h, self.cloud.log_text())

    def test_the_block_is_per_class_and_follows_the_handshake(self):
        self.assertTrue(pushplan.in_block(pushplan.block_ranges({}), "Person", "I8000"))
        self.assertTrue(pushplan.in_block(pushplan.block_ranges({}), "Person", "i08999"))
        self.assertFalse(pushplan.in_block(pushplan.block_ranges({}), "Person", "I9000"))
        self.assertFalse(pushplan.in_block(pushplan.block_ranges({}), "Person", "I7999"))
        self.assertFalse(pushplan.in_block(pushplan.block_ranges({}), "Person", "F8123"))
        self.assertTrue(pushplan.in_block(pushplan.block_ranges({}), "Family", "F8123"))
        self.assertTrue(pushplan.in_block(pushplan.block_ranges({"id_block": {"Person": "X500-X599"}}), "Person", "X0550"))

    def test_a_create_that_reuses_a_retired_person_id_is_held_before_sending(self):  # AC6 (D44)
        self.seed()
        gone = self.a_person()
        gone_id = self.cloud.heads[gone]["gramps_id"]
        del self.tree.data[gone]
        self.stepped_up()
        self.push(allow_deletes=True)
        self.assertTrue(self.cloud.heads[gone]["deleted"])
        self.assertIn(gone_id, self.cloud.meta()["retired_person_ids"])
        h = self.new_person(gone_id)                     # Gramps hands the freed number out again
        mark = len(self.cloud.requests)
        doc = self.push(allow_deletes=True)
        row = self.rows("SELECT rule, detail FROM holds WHERE handle = ?", h)[0]
        self.assertEqual(row, ("gramps_id_retired", "Gramps reused a retired website ID; renumber this new record."))
        self.assertNotIn(h, "\n".join(b for _m, _p, b in self.cloud.requests[mark:] if b), "the create was never sent")
        self.assertNotIn(h, self.cloud.heads, "so nothing keyed to the old ID can attach to the new handle")
        self.assertTrue(self.cloud.heads[gone]["deleted"] and self.cloud.heads[gone]["gramps_id"] == gone_id)
        self.assertEqual(doc["exit_code"], 20)

    def test_a_stale_handshake_is_caught_by_the_servers_409_and_the_object_is_held_after_the_fact(self):  # D26
        self.seed()
        gone = self.a_person()
        gone_id = self.cloud.heads[gone]["gramps_id"]
        del self.tree.data[gone]
        self.stepped_up()
        self.push(allow_deletes=True)
        self.cloud.meta_overrides = {"retired_person_ids": []}             # a handshake that does not list it
        h = self.new_person(gone_id)
        other = self.a_person(not_in=(gone,))
        self.tree.edit(other, lambda o: o["primary_name"].__setitem__("first_name", "Edited"))
        doc = self.push(allow_deletes=True)
        self.assertEqual(self.rows("SELECT rule FROM holds WHERE handle = ?", h)[0][0], "gramps_id_retired")
        self.assertNotIn(h, self.cloud.heads)
        self.assertEqual(self.cloud.heads[other]["obj"]["primary_name"]["first_name"], "Edited", "the rest of the batch was pushed")

    def test_assigning_an_id_to_a_cloud_created_person_is_a_plain_update(self):  # AC9 (Q2-03 declined)
        self.seed()
        h = self.a_person()
        # a cloud-created person that has no id yet (assign mode): the cloud head and the base both hold gramps_id ""
        self.cloud.edit(h, lambda o: o.__setitem__("gramps_id", ""))
        self.cloud.heads[h]["gramps_id"] = ""
        con = self.sidecar()
        try:
            obj = copy.deepcopy(self.cloud.heads[h]["obj"])
            pushstate.set_base(con, "Person", h, self.cloud.heads[h]["version"], self.cloud.heads[h]["seq"], obj)
        finally:
            con.close()
        self.tree.edit(h, lambda o: o.__setitem__("gramps_id", "I0888"))
        self.push()
        self.assertEqual(self.cloud.heads[h]["gramps_id"], "I0888", "the first assignment of an id is pushed as an update")
        self.assertEqual(self.cloud.pushed_ops()[-1]["op"], "update")
        self.tree.edit(h, lambda o: o.__setitem__("gramps_id", "I0889"))
        before = len(self.cloud.batches)
        self.push()
        self.assertEqual(len(self.cloud.batches), before, "a second change of the id is a renumber and is blocked")


class RetryBudget(PushCase):
    full = True

    def test_a_batch_that_runs_out_of_retries_holds_the_ops_left_and_ends_partial(self):
        self.seed()
        people = []
        for _ in range(1 + consts.MAX_DEAD_BATCH_RETRIES + 1):
            people.append(self.a_person(not_in=people))
        for h in people:
            self.tree.edit(h, lambda o: o["primary_name"].__setitem__("first_name", "Edited"))
        self.cloud.refuse_each = list(people[:1 + consts.MAX_DEAD_BATCH_RETRIES])    # a different op is refused on every attempt
        doc = self.push()
        left = people[-1]
        self.assertEqual(self.cloud.heads[left]["version"], 1, "the op that was never sent")
        self.assertEqual(self.rows("SELECT rule FROM holds WHERE handle = ?", left)[0][0], "server_refused")
        self.assertEqual(doc["result"], "partial", doc)


class ServerRefusals(PushCase):
    def test_a_privacy_refusal_drops_the_ops_it_names_and_pushes_the_rest(self):  # D24
        self.seed()
        a = self.a_person()
        b = self.a_person(not_in=(a,))
        for h in (a, b):
            self.tree.edit(h, lambda o: o["primary_name"].__setitem__("first_name", "Edited"))
        self.cloud.refuse_privacy = {a}
        doc = self.push()
        self.assertEqual(self.cloud.heads[a]["version"], 1)
        self.assertEqual(self.cloud.heads[b]["version"], 2)
        self.assertEqual(self.rows("SELECT rule FROM holds WHERE handle = ?", a)[0][0], "privacy.test_rule")
        self.assertEqual(self.exit_of(doc)[:2], ("partial", 65))
        self.assertEqual(self.rows("SELECT COUNT(*) FROM outbox WHERE state = 'rejected'")[0][0], 1)

    def test_a_snapshot_address_must_be_https_or_loopback(self):
        class C:
            server = "https://sync.test"
        for bad in ("file:///etc/passwd", "ftp://host/x", "http://snapshots.test/x", "http://127.0.0.1/x", "https:///x", "//host/x"):
            self.assertFalse(push._allowed_url(C, bad), bad)
        self.assertTrue(push._allowed_url(C, "https://snapshots.test/x"))
        C.server = "http://127.0.0.1:9000"
        self.assertTrue(push._allowed_url(C, "http://127.0.0.1:9000/_s3/x"))
        self.assertFalse(push._allowed_url(C, "http://evil.test/x"))
        with self.assertRaises(ValueError):
            push.download(self.cloud, "file:///etc/passwd")

    def test_writes_paused_is_exit_69_before_anything_is_read(self):  # D27
        self.cloud.writes_enabled = False
        doc = self.push()
        self.assertEqual((doc["result"], doc["exit_code"]), ("refused", 69))
        self.assertEqual(self.cloud.heads, {})

    def test_the_wrong_tree_is_d03_and_a_reseeded_store_is_d50(self):
        self.cloud.dbid = "someone-else"
        doc = self.push()
        self.assertEqual((doc["exit_code"], doc["error"]["code"], doc["next_action"]), (78, "D03", "open_bound_tree"))
        self.cloud.dbid = self.tree.dbid
        self.seed()
        self.cloud.tree_id = "cloud-tree-2"
        doc = self.push()
        self.assertEqual((doc["exit_code"], doc["error"]["code"], doc["next_action"]), (78, "D50", "rebase"))

    def test_an_unbound_cloud_and_an_unbound_tree_are_refused(self):
        self.cloud.dbid = None
        doc = self.push()
        self.assertEqual((doc["exit_code"], doc["error"]["code"], doc["next_action"]), (78, "cloud_unbound", "bind"))
        fresh = PS.PushTree(dbid="cc33dd44")
        self.cloud.dbid = "cc33dd44"
        other_env = dict(self.env, HOME=self.tmp + "-unbound", GRAMPSHOME=self.tmp + "-unbound/gh")
        self.addCleanup(__import__("shutil").rmtree, other_env["HOME"], True)
        doc = runner.run(fresh, "cli", runner.Options("push", yes=True), environ=other_env, argv=["gramps"], services={"client": self.cloud})
        self.assertEqual((doc["exit_code"], doc["error"]["code"], doc["next_action"]), (78, "unbound", "bind"))

    def test_a_corrupt_snapshot_is_fetched_again_once_and_twice_is_75(self):  # D10
        self.cloud.corrupt_downloads = 1
        doc = self.push()
        self.assertTrue(self.cloud.seeded, doc)
        self.fresh_world()
        self.cloud.corrupt_downloads = 2
        doc = self.push()
        self.assertEqual((doc["result"], doc["exit_code"], doc["error"]["code"]), ("failed", 75, "D10"))
        self.assertEqual(self.cloud.batches, [])

    fresh_world = Outbox.fresh_world

    def test_a_snapshot_older_than_the_last_pull_is_refused(self):  # D11
        con = self.sidecar()
        try:
            pushstate.set_text(con, "last_pull_seq", 99)
        finally:
            con.close()
        doc = self.push()
        self.assertEqual((doc["exit_code"], doc["error"]["code"]), (75, "D11"))

    def test_signed_out_is_77(self):
        class Out(PS.FakeCloud):
            def token_provider(self):
                raise transport.TransportError("not_signed_in", 77, "login", message="Sign in again with hfy-sync login.")
        doc = self.push(cloud=Out(self.tree.dbid))
        self.assertEqual((doc["result"], doc["exit_code"], doc["next_action"]), ("refused", 77, "login"))


class Sessions(PushCase):
    full = True

    def test_an_abandoned_session_is_resumed_by_the_next_run_and_completed(self):
        self.cloud.fail_with.append(("/api/sync/batches", PS.transport.TransportError("network", 75, "retry", message="x"), 1))   # the 2nd batch fails
        doc = self.push()
        self.assertEqual(doc["exit_code"], 75)
        sid = self.rows("SELECT value FROM meta WHERE key = 'open_session'")[0][0]
        self.assertEqual(self.cloud.sessions[sid]["state"], "open")
        self.push()
        self.assertEqual(len(self.cloud.sessions), 1, "the same session was reused")
        self.assertEqual(self.cloud.sessions[sid]["state"], "complete")
        self.assertTrue(self.cloud.seeded)
        self.assertEqual(self.rows("SELECT value FROM meta WHERE key = 'open_session'"), [])
        self.assertEqual(len([h for h in self.cloud.heads]), len(self.rows("SELECT * FROM base WHERE deleted = 0")))

    def test_a_session_that_cannot_complete_keeps_its_dependants_held_and_is_retried(self):  # D25
        def dangle():
            ev = next(h for h, hd in self.cloud.heads.items() if hd["class"] == "Event")
            self.cloud.heads[ev]["deleted"] = True
        self.cloud.on_batch = None
        self.cloud.fail_with = []
        real = self.cloud._complete
        calls = []

        def complete(sid):
            if not calls:
                calls.append(1)
                dangle()
            return real(sid)
        self.cloud._complete = complete
        doc = self.push()
        self.assertEqual(self.exit_of(doc), ("partial", 20, "retry"))
        self.assertEqual(doc["error"]["code"], "integrity_violation")
        self.assertTrue(self.rows("SELECT * FROM holds WHERE rule = 'integrity_violation'"))
        self.assertTrue(self.rows("SELECT value FROM meta WHERE key = 'open_session'"), "the session is kept for the next run")

    def test_another_open_session_is_d48(self):
        self.cloud._open({"expected": []})
        doc = self.push()
        self.assertEqual((doc["result"], doc["exit_code"], doc["error"]["code"]), ("failed", 75, "D48"))


class Planning(unittest.TestCase):
    def test_batches_respect_the_server_limits(self):
        ops = [{"op": "update", "class": "Person", "handle": "h%03d" % i, "base_version": 1, "obj": {"x": "y" * 10}} for i in range(60)]
        batches = pushplan.make_batches(ops)
        self.assertEqual([len(b) for b in batches], [24, 24, 12])
        for b in batches:
            self.assertLessEqual(3 + sum(pushplan.op_bound(o) for o in b), 100)

    def test_deletes_and_creates_never_share_a_batch(self):
        ops = [{"op": "create", "class": "Person", "handle": "a", "base_version": None, "obj": {}}, {"op": "delete", "class": "Event", "handle": "b", "base_version": 1}]
        self.assertEqual([[o["op"] for o in b] for b in pushplan.make_batches(ops)], [["create"], ["delete"]])

    def test_a_large_batch_is_split_by_bytes(self):
        big = "z" * 150000
        ops = [{"op": "create", "class": "Note", "handle": "n%d" % i, "base_version": None, "obj": {"text": big}} for i in range(12)]
        self.assertGreater(len(pushplan.make_batches(ops)), 1)

    def test_step_up_is_read_from_the_token_claims(self):
        self.assertTrue(push.step_up_fresh(PS.make_token(step_up=True)))
        self.assertFalse(push.step_up_fresh(PS.make_token(step_up=False)))
        self.assertFalse(push.step_up_fresh(PS.make_token(step_up=True, auth_age=301)))
        self.assertFalse(push.step_up_fresh("not a token"))
        self.assertFalse(push.step_up_fresh(None))

    def test_push_is_an_implemented_action(self):
        self.assertIn("push", consts.IMPLEMENTED_ACTIONS)


if __name__ == "__main__":
    unittest.main()
