"""Push scenarios of the end-to-end lane (HFY-TSK-206, addon-push): the addon's push against the local sync dev server, on copies of the
fixture tree, with the dev server's request log greped for what must never be in it.

    seed          the first push of the whole fixture opens a session, sends batches of at most 24, completes the session and seeds the store
    edit          a local edit is pushed: the store version increments and the sidecar base advances to the pushed object
    privacy       the request log holds none of the planted fixture values (phones, mail, street addresses, exact birth dates); the fixture
                  flow "a Birth retyped to Residence in the cloud, then push" leaves the event as a composite conflict and sends no day or month
    replay        a lost response is replayed from the outbox with the same Idempotency-Key and the server answers Idempotent-Replayed
    409           a website edit that lands between the snapshot and the batch gives a 409: a partial run, and the next run converges
    deletes       without step-up deletes are parked (exit 20); the CLI never pushes a mass delete; a person renumber is blocked
    merge         held while merges_enabled is false, blocked for a member principal, an IDALIAS item when it is on (GUI run, step-up)
    ids           a desktop create in the 8000-8999 block is held; a create that reuses a retired Person ID is held before sending (D44);
                  with Q2-03 declined the first local assignment of an ID to a cloud-created person is accepted once
    converge      disjoint website and desktop edits to one person converge in one run with no 409

The push needs only to READ the Gramps tree, so these scenarios call the addon's runner in this process with the real
hfy_sync_tool.GrampsTree over the real database (the same code the Gramps tool runs), a sign-in made by the real PKCE login against the
dev server, and a Keychain held in memory. Local edits are made through the Gramps API. STAND-IN: the pull has its own scenarios (scenario_pull.py), so
where a scenario here needs the pull's local apply of a website change it makes that edit in the tree itself and says so. Fictional data only.
"""
import copy
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import e2e_case as C  # noqa: E402
import e2e_support as E  # noqa: E402
from hfygramps.addon import consts, pushstate, runner, sidecar, status, transport  # noqa: E402

FIXTURE_JSONL = os.path.join(HERE, "..", "fixtures", "synthetic-tree.jsonl")
PLANTED = ["555-0100", "555-0101", "555-0142", "555-0143", "laurel@example.org", "fixture.contact@example.org", "123 Example Street",
           "999 Private Lane", "100 Example Street"]


def fixture():
    with open(FIXTURE_JSONL, encoding="utf-8") as fh:
        return {o["handle"]: o for o in (json.loads(line) for line in fh if line.strip())}


def birth_needles(data):
    """`"dateval":[d,m,y,` (the dev log writes compact JSON) for every full birth date of the fixture."""
    out = []
    for o in data.values():
        if o["_class"] == "Person" and o.get("birth_ref_index", -1) >= 0:
            d, m, y = data[o["event_ref_list"][o["birth_ref_index"]]["ref"]]["date"]["dateval"][:3]
            if d and m:
                out.append('"dateval":[%d,%d,%d,' % (d, m, y))
    return out


def gramps():
    from gramps.gen.db import DbTxn
    from gramps.gen.db.utils import make_database
    return DbTxn, make_database


def tool_module():
    sys.path.insert(0, C.S.PLUGIN_DIR)
    try:
        import hfy_sync_tool
        return hfy_sync_tool
    finally:
        if C.S.PLUGIN_DIR in sys.path:
            sys.path.remove(C.S.PLUGIN_DIR)


class FaultyHttp(transport.Http):
    """The addon's own transport with two faults: a hook that runs right before the first batch goes out (a website edit that races the
    push), and the loss of the answer to a batch the server did commit. It records every batch answer's status and replay header."""

    def __init__(self):
        transport.Http.__init__(self, delays=())
        self.before_batch = None
        self.lose = 0
        self.answers = []

    def send(self, method, url, headers=None, data=None, idempotent=False):
        batch = method == "POST" and url.endswith("/api/sync/batches")
        if batch and self.before_batch:
            hook, self.before_batch = self.before_batch, None
            hook()
        try:
            resp = transport.Http.send(self, method, url, headers, data, idempotent)
        except transport.TransportError as exc:
            if batch:
                self.answers.append((exc.status, None))
            raise
        if batch:
            self.answers.append((resp.status, resp.headers.get("idempotent-replayed")))
            if self.lose:
                self.lose -= 1
                raise transport.TransportError("network", consts.EXIT_TEMPORARY, "retry", message="The network call failed.")
        return resp


class PushCase(C.E2ECase):
    server_args = ()

    def setUp(self):
        C.E2ECase.setUp(self)
        self.data = fixture()
        self.local = self.bind_local()
        self.server = self.start_server(*self.server_args)
        self.point_config_at(self.server)
        self.session = E.sign_in(self.server)
        client = self.session.client()
        got = client.post("/api/sync/bind", {"dbid": self.local["dbid"], "fingerprint": self.local["fingerprint"], "tree_name_sha256": self.tree_name_sha256()})
        self.assertEqual(got.status, 200)
        self.cloud_tree = got.body["tree_id"]
        self.reader = self.session.client(tree_id=self.cloud_tree)
        self.runs = 0
        self.hfy_tool = tool_module()

    # -------------------------------------------------------------------------------------------------------- running

    def client_for(self, session=None, http=None):
        session = session or self.session
        versions = E.make_versions()
        versions.tree_id = self.cloud_tree
        return transport.Client(self.server.origin, versions, session.tokens, http=http or session.http)

    def push(self, mode="cli", session=None, http=None, **opts):
        """One in-process run of the push action over the real tree; returns the status document."""
        DbTxn, make_database = gramps()
        self.runs += 1
        db = make_database("sqlite")
        db.load(self.dir)
        try:
            tree = self.hfy_tool.GrampsTree(db)
            opts.setdefault("yes", True)
            return runner.run(tree, mode, runner.Options("push", **opts), run_id=status.new_run_id(), argv=["gramps"], environ=os.environ,
                              services={"client": self.client_for(session, http)})
        finally:
            db.close()

    def seed(self):
        doc = self.push()
        self.assertIn(doc["result"], ("ok", "partial"), doc)
        self.assertEqual(doc["exit_code"] in (0, 20), True, doc)
        return doc

    def heads(self):
        return E.snapshot_heads(self.reader)

    def head_of(self, gramps_id, cls="Person"):
        return next((h for h in self.heads().values() if h["class"] == cls and h["gramps_id"] == gramps_id), None)

    def side(self):
        return sidecar.open_checked(C.S.tree_paths(self.dbid)["sidecar"])

    def rows(self, sql, *args):
        con = self.side()
        try:
            return con.execute(sql, args).fetchall()
        finally:
            con.close()

    def write_config(self, **fields):
        path = C.S.tree_paths(self.dbid)["config"]
        with open(path, encoding="utf-8") as fh:
            cfg = json.load(fh)
        cfg.update(fields)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(cfg, fh, indent=2, sort_keys=True)

    def fresh_step_up(self):
        return E.sign_in(self.server, step_up=True)

    def person_handle(self, gid):
        return next(h for h, o in self.data.items() if o["_class"] == "Person" and o["gramps_id"] == gid)

    # ---- local edits through the Gramps API
    def set_first_name(self, gid, name):
        def go(db, DbTxn):
            p = db.get_person_from_gramps_id(gid)
            p.get_primary_name().set_first_name(name)
            with DbTxn("edit", db) as trans:
                db.commit_person(p, trans)
        self.edit(go)

    def set_gender(self, gid, gender):
        def go(db, DbTxn):
            p = db.get_person_from_gramps_id(gid)
            p.set_gender(gender)
            with DbTxn("edit", db) as trans:
                db.commit_person(p, trans)
        self.edit(go)

    def remove_person(self, gid):
        """Unlinks the person from its families (as Gramps' own delete does) and removes it."""
        def go(db, DbTxn):
            p = db.get_person_from_gramps_id(gid)
            with DbTxn("remove person", db) as trans:
                for fh in list(p.get_family_handle_list()) + list(p.get_parent_family_handle_list()):
                    fam = db.get_family_from_handle(fh)
                    if fam.get_father_handle() == p.handle:
                        fam.set_father_handle(None)
                    if fam.get_mother_handle() == p.handle:
                        fam.set_mother_handle(None)
                    fam.set_child_ref_list([r for r in fam.get_child_ref_list() if r.ref != p.handle])
                    db.commit_family(fam, trans)
                db.remove_person(p.handle, trans)
        self.edit(go)

    def add_notes(self, n, prefix="Padding note"):
        def go(db, DbTxn):
            from gramps.gen.lib import Note
            handles = []
            with DbTxn("pad", db) as trans:
                for i in range(n):
                    note = Note()
                    note.set("%s %d." % (prefix, i))
                    handles.append(db.add_note(note, trans))
            return handles
        return self.edit(go)

    def remove_notes(self, handles):
        def go(db, DbTxn):
            with DbTxn("remove notes", db) as trans:
                for h in handles:
                    db.remove_note(h, trans)
        self.edit(go)

    def web_edit(self, handle, fn, key):
        """A website-side edit of an object through the dev server's applyBatch (origin admin)."""
        head = self.heads()[handle]
        obj = copy.deepcopy(head["obj"])
        fn(obj)
        got, body = self.server.apply([{"op": "update", "class": head["class"], "handle": handle, "base_version": head["version"], "obj": obj}], key)
        self.assertEqual(got, 200, body)
        return head

    def log_has_none_of(self, needles, since=0):
        text = "\n".join(json.dumps(e) for e in self.server.entries()[since:])
        for needle in needles:
            self.assertNotIn(needle, text)


class SeedAndEdit(PushCase):
    def test_the_seed_push_opens_a_session_and_the_store_holds_the_projected_tree(self):  # AC1 (sessions)
        doc = self.seed()
        self.assertEqual(doc["action"], "push")
        sessions = self.server.requests(method="POST", path="/api/sync/sessions")
        batches = self.server.requests(method="POST", path="/api/sync/batches")
        completes = self.server.requests(method="POST", path="/api/sync/sessions/*")
        self.assertEqual((len(sessions), len(completes)), (1, 1))
        self.assertGreater(len(batches), 1)
        self.assertTrue(all(b["status"] == 200 and len(b["body"]["ops"]) <= 24 for b in batches))
        self.assertEqual(self.server.requests(method="POST", path="/api/sync/status")[-1]["status"], 204)
        heads = self.heads()
        self.assertGreater(len(heads), 50)
        self.assertEqual({h["version"] for h in heads.values()}, {1})
        self.assertEqual(len(self.rows("SELECT * FROM base WHERE deleted = 0")), len(heads))
        self.assertEqual(self.rows("SELECT COUNT(*) FROM outbox WHERE state != 'acked'")[0][0], 0)
        self.assertTrue(self.server.state()["head"]["seeded"])
        again = self.push()
        self.assertEqual(again["counts"]["pushed"], {"create": 0, "update": 0, "delete": 0})

    def test_a_local_edit_is_pushed_the_version_increments_and_the_base_advances(self):  # AC1
        self.seed()
        before = self.head_of("I0013")
        self.set_first_name("I0013", "Edited")
        doc = self.push()
        self.assertEqual(doc["counts"]["pushed"], {"create": 0, "update": 1, "delete": 0})
        after = self.head_of("I0013")
        self.assertEqual(after["version"], before["version"] + 1)
        self.assertEqual(after["obj"]["primary_name"]["first_name"], "Edited")
        row = self.rows("SELECT version, obj_json FROM base WHERE handle = ?", after["handle"])[0]
        self.assertEqual((row[0], json.loads(row[1])), (after["version"], after["obj"]))
        last = self.server.requests(method="POST", path="/api/sync/batches")[-1]
        self.assertEqual((last["body"]["ops"][0]["op"], last["body"]["ops"][0]["base_version"]), ("update", before["version"]))
        self.assertNotIn("session_id", last["body"], "one batch needs no session once the store is seeded")

    def test_a_dry_run_changes_nothing_anywhere(self):
        self.edit(lambda db, DbTxn: None)                                  # Gramps itself touches a tree it opens for the first time
        before = C.ft.db_digest(self.dir)
        doc = self.push(dry_run=True)
        self.assertEqual((doc["result"], doc["exit_code"]), ("changes_pending", 10))
        self.assertEqual(C.ft.db_digest(self.dir), before)
        self.assertEqual(self.rows("SELECT COUNT(*) FROM base")[0][0], 0)
        self.assertEqual(self.server.requests(method="POST", path="/api/sync/batches"), [])
        self.assertEqual(self.server.requests(method="POST", path="/api/sync/sessions"), [])
        self.assertTrue(os.path.isfile(os.path.join(os.path.dirname(C.S.tree_paths(self.dbid)["sidecar"]), "previews", "%s.json" % doc["run_id"])))
        self.assertEqual(self.heads(), {})


class Privacy(PushCase):
    def test_none_of_the_planted_values_reaches_the_server(self):  # AC3
        self.seed()
        needles = birth_needles(self.data)
        self.assertGreater(len(needles), 5)
        self.log_has_none_of(PLANTED + needles)
        for word in PLANTED:
            self.assertEqual(self.server.grep(word), [])

    def test_a_birth_retyped_to_residence_in_the_cloud_is_a_conflict_and_sends_no_day_or_month(self):  # AC3 fixture flow
        self.seed()
        person = self.data[self.person_handle("I0003")]
        birth = self.data[person["event_ref_list"][person["birth_ref_index"]]["ref"]]
        full = birth["date"]["dateval"]
        self.web_edit(birth["handle"], lambda o: o["type"].update({"value": 42, "string": ""}), "retype-1")          # Birth -> Residence
        mark = len(self.server.entries())
        digest = C.ft.db_digest(self.dir)
        heads_before = self.heads()
        doc = self.push()                                                    # "pull, then push": the push meets the changed type
        self.assertEqual((doc["result"], doc["exit_code"], doc["next_action"]), ("partial", 20, "resolve_conflicts"))
        self.assertEqual([(r[0], r[1]) for r in self.rows("SELECT handle, kind FROM conflicts WHERE state = 'parked'") if r[0] == birth["handle"]],
                         [(birth["handle"], "composite")])
        self.log_has_none_of(['"dateval":[%d,%d,%d' % tuple(full[:3])] + birth_needles(self.data), since=mark)
        self.assertEqual(self.server.grep('"dateval":[%d,%d,' % tuple(full[:2])), [])
        for _ in range(3):                                                   # the conflict stays parked, nothing moves
            again = self.push()
            self.assertEqual((again["result"], again["exit_code"], again["next_action"]), ("partial", 20, "resolve_conflicts"))
        self.assertEqual({k: v["version"] for k, v in self.heads().items() if k != birth["handle"]},
                         {k: v["version"] for k, v in heads_before.items() if k != birth["handle"]})
        self.assertEqual(self.head_of(birth["gramps_id"], "Event")["obj"]["type"]["value"], 42)
        self.assertEqual(C.ft.db_digest(self.dir), digest, "a push never writes the Gramps database")


class Outbox(PushCase):
    def test_a_lost_response_is_replayed_with_the_same_key_and_answered_idempotent_replayed(self):  # AC2
        self.seed()
        before = self.head_of("I0013")
        self.set_first_name("I0013", "Edited")
        http = FaultyHttp()
        http.lose = 1
        doc = self.push(http=http)
        self.assertEqual((doc["result"], doc["exit_code"]), ("failed", 75))
        self.assertEqual(self.head_of("I0013")["version"], before["version"] + 1, "the server committed")
        self.assertEqual(self.rows("SELECT version FROM base WHERE handle = ?", before["handle"])[0][0], before["version"], "but the addon never saw the ack")
        self.assertEqual(len(self.rows("SELECT * FROM outbox WHERE state = 'sent'")), 1)
        again = FaultyHttp()
        self.push(http=again)
        self.assertEqual(again.answers[0], (200, "true"), "the same key, answered Idempotent-Replayed")
        keys = [e["headers"]["idempotency-key"] for e in self.server.requests(method="POST", path="/api/sync/batches")][-2:]
        self.assertEqual(keys[0], keys[1])
        self.assertEqual(self.head_of("I0013")["version"], before["version"] + 1, "committed once")
        self.assertEqual(self.rows("SELECT version FROM base WHERE handle = ?", before["handle"])[0][0], before["version"] + 1)
        self.assertEqual(self.rows("SELECT COUNT(*) FROM outbox WHERE state != 'acked'")[0][0], 0)

    def test_a_409_is_partial_and_the_next_run_converges(self):  # AC2, AC7 (disjoint edits, no 409 on the run that sees them)
        self.seed()
        base = self.head_of("I0013")
        other = 2 if base["obj"]["gender"] != 2 else 1
        self.set_first_name("I0013", "Desk")                                         # the desktop edits field b
        http = FaultyHttp()
        http.before_batch = lambda: self.web_edit(base["handle"], lambda o: o.__setitem__("gender", other), "race-1")   # the website edits field a, first
        doc = self.push(http=http)
        self.assertEqual((doc["result"], doc["exit_code"], doc["next_action"]), ("partial", 75, "retry"))
        self.assertEqual(http.answers[-1][0], 409)
        self.assertEqual(self.rows("SELECT state FROM outbox ORDER BY rowid DESC LIMIT 1")[0][0], "rejected")
        self.assertEqual(self.rows("SELECT version FROM base WHERE handle = ?", base["handle"])[0][0], base["version"])
        before = self.head_of("I0013")["version"]
        doc = self.push()
        merged = self.head_of("I0013")
        self.assertEqual((merged["obj"]["gender"], merged["obj"]["primary_name"]["first_name"]), (other, "Desk"), "both edits, one run, no 409")
        self.assertEqual(merged["version"], before + 1)
        last = self.server.requests(method="POST", path="/api/sync/batches")[-1]
        self.assertEqual((last["status"], last["body"]["ops"][0]["base_version"]), (200, before), "base_version is the pulled snapshot's version")
        # STAND-IN for addon-pull-apply: the website's edit is applied to the tree by hand; then the run has nothing left to do
        self.set_gender("I0013", other)
        sent = len(self.server.requests(method="POST", path="/api/sync/batches"))
        self.push()
        self.assertEqual(len(self.server.requests(method="POST", path="/api/sync/batches")), sent)
        self.assertEqual(self.rows("SELECT version FROM base WHERE handle = ?", base["handle"])[0][0], merged["version"])


class Destructive(PushCase):
    def test_deletes_without_step_up_are_parked_and_with_it_pushed(self):  # AC4
        self.seed()
        handles = self.add_notes(2)
        self.push()
        self.remove_notes(handles)
        before = len(self.server.requests(method="POST", path="/api/sync/batches"))
        doc = self.push(allow_deletes=True)
        self.assertEqual((doc["result"], doc["exit_code"], doc["next_action"]), ("partial", 20, "step_up"))
        self.assertEqual(len(self.server.requests(method="POST", path="/api/sync/batches")), before, "nothing was sent for them")
        self.assertTrue(all(not self.heads()[h]["deleted"] for h in handles))
        stepped = self.fresh_step_up()
        doc = self.push(session=stepped, allow_deletes=True)
        self.assertEqual(doc["counts"]["pushed"]["delete"], 2)
        self.assertTrue(all(self.heads()[h]["deleted"] for h in handles))

    def test_the_cli_never_pushes_a_mass_delete(self):  # AC4
        pads = self.add_notes(120)
        self.seed()
        self.remove_notes(pads[:11])
        stepped = self.fresh_step_up()
        mark = len(self.server.entries())
        doc = self.push(session=stepped, allow_deletes=True)
        self.assertEqual(doc["counts"]["pushed"]["delete"], 0)
        self.assertEqual(doc["counts"]["blocked"], 11)
        self.assertEqual({r[0] for r in self.rows("SELECT rule FROM holds WHERE handle = ?", pads[0])}, {"mass_delete"})
        self.assertEqual([e for e in self.server.entries()[mark:] if e["method"] == "POST" and e["path"] == "/api/sync/batches"], [])
        self.assertTrue(all(not self.heads()[h]["deleted"] for h in pads[:11]))

    def test_a_person_renumber_is_blocked(self):  # AC4
        self.seed()
        before = self.head_of("I0013")

        def go(db, DbTxn):
            p = db.get_person_from_gramps_id("I0013")
            p.set_gramps_id("I0777")
            with DbTxn("renumber", db) as trans:
                db.commit_person(p, trans)
        self.edit(go)
        sent = len(self.server.requests(method="POST", path="/api/sync/batches"))
        doc = self.push()
        self.assertEqual(len(self.server.requests(method="POST", path="/api/sync/batches")), sent)
        self.assertEqual(self.rows("SELECT rule FROM holds WHERE handle = ? AND rule = 'renumber_blocked'", before["handle"])[0][0], "renumber_blocked")
        self.assertEqual(self.head_of("I0013")["version"], before["version"])
        self.assertEqual(doc["counts"]["blocked"], 1)


class Merges(PushCase):
    def merge_locally(self, gone_id="I0017", survivor_id="I0018"):
        def go(db, DbTxn):
            from gramps.gen.lib import Attribute, AttributeType
            s = db.get_person_from_gramps_id(survivor_id)
            attr = Attribute()
            attr.set_type(AttributeType(consts.MERGED_ID_ATTRIBUTE))
            attr.set_value(gone_id)
            s.add_attribute(attr)
            with DbTxn("merge", db) as trans:
                db.commit_person(s, trans)
        self.edit(go)
        self.remove_person(gone_id)

    def test_a_person_merge_is_held_blocked_or_aliased_as_the_cloud_allows(self):  # AC4
        self.seed()
        self.merge_locally()
        stepped = self.fresh_step_up()
        gone = self.head_of("I0017")
        # 1. merges_enabled is false: held with guidance, nothing about the merged-away person is sent
        doc = self.push(mode="gui", session=stepped, allow_deletes=True)
        self.assertEqual(self.rows("SELECT rule FROM holds WHERE handle = ? AND rule = 'merge_held'", gone["handle"])[0][0], "merge_held")
        self.assertFalse(self.head_of("I0017")["deleted"])
        self.assertEqual(self.server.items("IDALIAS#"), [])
        # 2. on, and the merged-away person is a member principal (as io's config says): blocked, merge the other way
        self.server.set_head(merges_enabled=True)
        self.write_config(member_person_ids=["I0017"])
        self.push(mode="gui", session=stepped, allow_deletes=True)
        row = self.rows("SELECT rule, detail FROM holds WHERE handle = ?", gone["handle"])[0]
        self.assertEqual(row[0], "merge_member_principal")
        self.assertIn("Merge the other way", row[1])
        self.assertFalse(self.head_of("I0017")["deleted"])
        # 3. on, and nobody says who the members are: held as unverifiable
        self.write_config(member_person_ids=None)
        self.push(mode="gui", session=stepped, allow_deletes=True)
        self.assertEqual(self.rows("SELECT rule FROM holds WHERE handle = ?", gone["handle"])[0][0], "merge_unverified")
        # 4. the CLI parks a merge whatever the flags
        self.write_config(member_person_ids=[])
        self.push(mode="cli", session=stepped, allow_deletes=True)
        self.assertEqual(self.rows("SELECT rule FROM holds WHERE handle = ?", gone["handle"])[0][0], "merge_gui_only")
        # 5. the GUI, merges on, member list known and clear, step-up: the delete goes with its alias
        doc = self.push(mode="gui", session=stepped, allow_deletes=True)
        self.assertTrue(self.head_of("I0017")["deleted"])
        self.assertEqual([i["PK"] for i in self.server.items("IDALIAS#")], ["IDALIAS#Person#I0017"])
        self.assertEqual(doc["counts"]["pushed"]["delete"], 1)
        op = [o for e in self.server.requests(method="POST", path="/api/sync/batches") for o in e["body"]["ops"] if o["op"] == "delete"][-1]
        self.assertEqual((op["reason"], op["merged_into"]), ("merge", "I0018"))


class Identity(PushCase):
    def new_person(self, gramps_id, first="Fresh"):
        def go(db, DbTxn):
            from gramps.gen.lib import Name, Person, Surname
            p = Person()
            nm = Name()
            sn = Surname()
            sn.set_surname("Newperson")
            nm.add_surname(sn)
            nm.set_first_name(first)
            p.set_primary_name(nm)
            p.set_gramps_id(gramps_id)
            with DbTxn("add person", db) as trans:
                return db.add_person(p, trans)
        return self.edit(go)

    def test_a_desktop_create_in_the_8000_block_is_held(self):  # AC5
        self.seed()
        handle = self.new_person("I8123")
        mark = len(self.server.entries())
        self.push()
        self.assertEqual(self.rows("SELECT rule FROM holds WHERE handle = ? AND rule = 'reserved_id_block'", handle)[0][0], "reserved_id_block")
        self.assertEqual(self.server.grep(handle), [], "nothing about the new person reached the server")
        self.assertNotIn(handle, self.heads())

    def test_a_create_that_reuses_a_retired_person_id_is_held_before_sending(self):  # AC6, D44
        self.seed()
        old = self.head_of("I0019")
        self.remove_person("I0019")
        stepped = self.fresh_step_up()
        self.push(session=stepped, allow_deletes=True)
        self.assertTrue(self.head_of("I0019")["deleted"])
        self.assertIn("I0019", self.reader.meta()["retired_person_ids"])
        handle = self.new_person("I0019")                                   # Gramps hands the freed number out again
        mark = len(self.server.entries())
        doc = self.push(session=stepped, allow_deletes=True)
        row = self.rows("SELECT rule, detail FROM holds WHERE handle = ?", handle)[0]
        self.assertEqual(row, ("gramps_id_retired", "Gramps reused a retired website ID; renumber this new record."))
        self.assertEqual(self.server.grep(handle), [], "the create was never sent, so nothing keyed to the old ID can attach to the new handle")
        self.assertNotIn(handle, self.heads())
        self.assertEqual(self.head_of("I0019")["handle"], old["handle"], "the retired ID still belongs to the old, deleted person")
        self.assertEqual(doc["exit_code"], 20)


class AssignedIds(PushCase):
    server_args = ("--id-policy", "assign")

    def test_the_first_local_assignment_of_an_id_to_a_cloud_created_person_is_pushed_and_accepted_once(self):  # AC9 (Q2-03 declined)
        self.seed()
        handle = "e2e0000000000000000000000001"
        template = copy.deepcopy(self.data[self.person_handle("I0013")])
        template.update({"handle": handle, "gramps_id": "", "event_ref_list": [], "family_list": [], "parent_family_list": [], "media_list": [],
                         "citation_list": [], "note_list": [], "birth_ref_index": -1, "death_ref_index": -1, "address_list": [], "attribute_list": [],
                         "person_ref_list": [], "tag_list": [], "lds_ord_list": [], "alternate_names": []})
        template["primary_name"]["first_name"] = "Newcomer"
        template.pop("change", None)
        got, body = self.server.apply([{"op": "create", "class": "Person", "handle": handle, "base_version": None, "obj": template}], "make-1")
        self.assertEqual(got, 200, body)
        head = self.heads()[handle]
        self.assertEqual(head["gramps_id"], "")
        # STAND-IN for addon-pull-apply: the pull would create the person here and record it in the base; this does both by hand
        template["change"] = 1700000000

        def go(db, DbTxn):
            from gramps.gen.lib.json_utils import data_to_object
            with DbTxn("pull stand-in", db) as trans:
                db.add_person(data_to_object(template), trans, set_gid=False)
        self.edit(go)
        con = self.side()
        try:
            pushstate.set_base(con, "Person", handle, head["version"], head["seq"], head["obj"])
        finally:
            con.close()

        def assign(gid):
            def go2(db, DbTxn):
                p = db.get_person_from_handle(handle)
                p.set_gramps_id(gid)
                with DbTxn("assign", db) as trans:
                    db.commit_person(p, trans)
            self.edit(go2)
        assign("I0888")
        self.push()
        self.assertEqual(self.heads()[handle]["gramps_id"], "I0888", "accepted")
        assign("I0889")
        sent = len(self.server.requests(method="POST", path="/api/sync/batches"))
        self.push()
        self.assertEqual(len(self.server.requests(method="POST", path="/api/sync/batches")), sent, "a second change is a renumber and never sent")
        self.assertEqual(self.heads()[handle]["gramps_id"], "I0888")


if __name__ == "__main__":
    unittest.main()
