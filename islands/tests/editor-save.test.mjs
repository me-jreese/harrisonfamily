// HFY-TSK-213 (editor-save-flow): the pure half of the save flow (src/lib/editor-save.js). Synthetic data only.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PERSON_SECTIONS, createModeResolver } from "../src/lib/editor-model.js";
import { ApiError, createApi } from "../src/lib/api.js";
import { applyOps, validateOps } from "../../api/src/records/ops.js";
import {
  SAVE_COPY, NOTE_MAX, UNDO_WINDOW_MS, allSaveText, barText, baseVersionsFor, changesBody, confirmLabel, countOps, modeOfOp, newIdempotencyKey, noteCountText, opsFromDrafts, planGroups, replayDrafts, replaySeed, problemFor, reviewerLine, savedToast, settledUnitsOf, undoBody, undoLeftMs
} from "../src/lib/editor-save.js";

const POLICY = JSON.parse(readFileSync(new URL("./fixtures/edit-policy-person.json", import.meta.url), "utf8"));
const KEY = "Person:hsyn0001";
const OBJ = { _class: "Person", handle: "hsyn0001", gramps_id: "I9001", primary_name: { _class: "Name", first_name: "Test", nick: "Tess", surname_list: [{ surname: "Person" }] } };
const SECTIONS = PERSON_SECTIONS.filter((s) => s.form);

describe("opsFromDrafts", () => {
  it("makes no op for values equal to the record's, trimmed, or for a missing optional field", () => {
    const { ops } = opsFromDrafts({ key: KEY, sections: SECTIONS, obj: OBJ, drafts: { names: { surname: "Person", first_name: "Test", nick: "  Tess ", title: "" } } });
    assert.deepEqual(ops, []);
  });

  it("makes one set op per changed field, with the served value as the base (null when the record lacks the property)", () => {
    const { ops, labels } = opsFromDrafts({ key: KEY, sections: SECTIONS, obj: OBJ, drafts: { names: { surname: "Person", first_name: "Tester", nick: "Tess", title: " Dr " } } });
    assert.deepEqual(ops, [
      { id: "names.first_name", op: "set", obj: KEY, path: "/primary_name/first_name", base: "Test", value: "Tester" },
      { id: "names.title", op: "set", obj: KEY, path: "/primary_name/title", base: null, value: "Dr" }
    ]);
    assert.deepEqual(labels, { "names.first_name": "given names", "names.title": "title" });
  });

  it("a cleared field is a set to the empty string over the old value", () => {
    const { ops } = opsFromDrafts({ key: KEY, sections: SECTIONS, obj: OBJ, drafts: { names: { surname: "Person", first_name: "Test" } } });
    assert.deepEqual(ops, [{ id: "names.nick", op: "set", obj: KEY, path: "/primary_name/nick", base: "Tess", value: "" }]);
  });

  it("a cleared field is accepted by the API's op engine, and its inverse puts the old text back (contract)", () => {
    // The server has no "unset" op: a set to "" over the stored text is how a field is cleared (api/test/changes.test.js "clearing a stored phone number").
    const { ops } = opsFromDrafts({ key: KEY, sections: SECTIONS, obj: OBJ, drafts: { names: { surname: "Person", first_name: "Test", title: "Dr" } } });
    assert.deepEqual(ops.map((o) => [o.id, o.base, o.value]), [["names.nick", "Tess", ""], ["names.title", null, "Dr"]]);
    assert.deepEqual(validateOps(ops), []);
    const r = applyOps({ [KEY]: OBJ }, ops);
    assert.equal(r.ok, true, JSON.stringify(r.conflicts));
    assert.equal(r.objects[KEY].primary_name.nick, "");
    assert.equal(r.objects[KEY].primary_name.title, "Dr");
    const back = applyOps(r.objects, r.inverse);
    assert.equal(back.ok, true);
    assert.equal(back.objects[KEY].primary_name.nick, "Tess");
  });

  it("op ids fit the API's id rule and a section without a draft makes none", () => {
    const { ops } = opsFromDrafts({ key: KEY, sections: SECTIONS, obj: OBJ, drafts: { names: { surname: "Person", first_name: "A B", call: "B", nick: "C", title: "D", suffix: "E" } } });
    assert.equal(ops.length, 5);
    for (const op of ops) assert.match(op.id, /^[A-Za-z0-9_.:-]{1,64}$/);
    assert.deepEqual(opsFromDrafts({ key: KEY, sections: SECTIONS, obj: OBJ, drafts: {} }).ops, []);
  });

  it("replaying the same drafts over a fresher record rebuilds the bases (the 409 path)", () => {
    const fresh = { ...OBJ, primary_name: { ...OBJ.primary_name, first_name: "Other" } };
    const { ops } = opsFromDrafts({ key: KEY, sections: SECTIONS, obj: fresh, drafts: { names: { surname: "Person", first_name: "Tester", nick: "Tess" } } });
    assert.deepEqual(ops.map((o) => [o.id, o.base, o.value]), [["names.first_name", "Other", "Tester"]]);
  });
});

describe("replaySeed", () => {
  it("lays only the member's changed fields over the fresh record, so another person's change is neither lost nor reverted", () => {
    const fresh = { ...OBJ, primary_name: { ...OBJ.primary_name, title: "Rev", nick: "Other" } };
    const drafts = { names: { surname: "Person", first_name: "Test", nick: "Tessa" } }; // the member changed the nickname only (the title was never on the record they edited)
    const seed = replaySeed({ sections: SECTIONS, key: KEY, oldObj: OBJ, freshObj: fresh, drafts });
    assert.deepEqual(seed, { names: { surname: "Person", first_name: "Test", nick: "Tessa", title: "Rev" } });
    // the ops rebuilt from the seed change the nickname only, over the fresh base
    const { ops } = opsFromDrafts({ key: KEY, sections: SECTIONS, obj: fresh, drafts: seed });
    assert.deepEqual(ops.map((o) => [o.id, o.base, o.value]), [["names.nick", "Other", "Tessa"]]);
  });
  it("a field the member cleared stays cleared", () => {
    const seed = replaySeed({ sections: SECTIONS, key: KEY, oldObj: OBJ, freshObj: OBJ, drafts: { names: { surname: "Person", first_name: "Test" } } });
    assert.deepEqual(seed, { names: { surname: "Person", first_name: "Test" } });
  });
});

describe("replaySeed with settled ops (the refetch after a save)", () => {
  const fresh = { ...OBJ, primary_name: { ...OBJ.primary_name, nick: "Tessa" } }; // the save stored the nickname
  it("an edit the server just took is not laid over the fresh record again, one typed since is", () => {
    const drafts = { names: { surname: "Person", first_name: "Test", nick: "Tessa", title: "Dr" } }; // title typed after the save
    const seed = replaySeed({ sections: SECTIONS, key: KEY, oldObj: OBJ, freshObj: fresh, drafts, settled: { "names.nick": "Tessa" } });
    assert.deepEqual(seed, { names: { surname: "Person", first_name: "Test", nick: "Tessa", title: "Dr" } });
    const { ops } = opsFromDrafts({ key: KEY, sections: SECTIONS, obj: fresh, drafts: seed });
    assert.deepEqual(ops.map((o) => [o.id, o.base, o.value]), [["names.title", null, "Dr"]]);
  });
  it("a suggestion that went to review is settled too: the form goes back to the record, not to the suggested text", () => {
    const seed = replaySeed({ sections: SECTIONS, key: KEY, oldObj: OBJ, freshObj: OBJ, drafts: { names: { surname: "Person", first_name: "Tester", nick: "Tess", title: "Dr" } }, settled: { "names.first_name": "Tester" } });
    assert.deepEqual(seed, { names: { surname: "Person", first_name: "Test", nick: "Tess", title: "Dr" } });
  });
  it("a settled field edited again to something else is kept", () => {
    const seed = replaySeed({ sections: SECTIONS, key: KEY, oldObj: OBJ, freshObj: fresh, drafts: { names: { surname: "Person", first_name: "Test", nick: "Tessie" } }, settled: { "names.nick": "Tessa" } });
    assert.equal(seed.names.nick, "Tessie");
  });
});

describe("bar", () => {
  const resolver = createModeResolver(POLICY);
  const member = { admin: false, relation: "own" };
  it("counts the ops by the policy table", () => {
    const { ops } = opsFromDrafts({ key: KEY, sections: SECTIONS, obj: OBJ, drafts: { names: { surname: "Person", first_name: "Tester", nick: "Tessa", title: "Dr" } } });
    const c = countOps(ops, resolver, "Person", member);
    assert.deepEqual(c, { total: 3, direct: 2, review: 1 });
    assert.equal(barText(c), "3 changes — 2 save now, 1 goes to review");
  });
  it("words: singular and plural, one-sided, empty", () => {
    assert.equal(barText({ total: 1, direct: 1, review: 0 }), "1 change — 1 saves now");
    assert.equal(barText({ total: 2, direct: 0, review: 2 }), "2 changes — 2 go to review");
    assert.equal(barText({ total: 0, direct: 0, review: 0 }), "");
  });
  it("an admin's ops all save now", () => {
    const { ops } = opsFromDrafts({ key: KEY, sections: SECTIONS, obj: OBJ, drafts: { names: { surname: "Person", first_name: "Tester", nick: "Tess" } } });
    assert.deepEqual(countOps(ops, resolver, "Person", { admin: true, relation: "other" }), { total: 1, direct: 1, review: 0 });
  });
});

describe("requests", () => {
  const op = { id: "names.nick", op: "set", obj: KEY, path: "/primary_name/nick", base: "Tess", value: "Tessa" };
  it("the dry run and the save bodies", () => {
    assert.deepEqual(changesBody({ target: KEY, version: 4, ops: [op], dryRun: true }), { target: KEY, base_versions: { [KEY]: 4 }, ops: [op], dry_run: true });
    const save = changesBody({ target: KEY, version: 4, ops: [op] });
    assert.equal("dry_run" in save, false);
    assert.equal("note" in save, false);
    assert.equal(changesBody({ target: KEY, version: 4, ops: [op], note: "hi" }).note, "hi");
    assert.equal("route" in save, false);
  });
  it("the undo body sends exactly the returned inverse ops and versions", () => {
    const undo = { base_versions: { [KEY]: 5 }, ops: [{ id: "inv:names.nick", op: "set", obj: KEY, path: "/primary_name/nick", base: "Tessa", value: "Tess", seq: true }] };
    assert.deepEqual(undoBody({ target: KEY, undo }), { target: KEY, base_versions: { [KEY]: 5 }, ops: undo.ops });
  });
  it("idempotency keys are header-safe and differ", () => {
    const a = newIdempotencyKey();
    assert.match(a, /^[\x21-\x7e]{1,128}$/);
    assert.notEqual(a, newIdempotencyKey());
  });
});

describe("answers", () => {
  const dry = {
    plan: {
      direct: [{ opIds: ["names.nick"], summary: [{ text: "change the nickname from Tess to Tessa", opIds: ["names.nick"] }] }],
      review: [{ opIds: ["names.first_name"], summary: [{ text: "change the given names from Test to Tester", opIds: ["names.first_name"] }] }]
    },
    warnings: ["check the spelling"], errors: []
  };
  it("groups the plan's sentences", () => {
    const g = planGroups(dry);
    assert.deepEqual(g.direct, ["change the nickname from Tess to Tessa"]);
    assert.deepEqual(g.review, ["change the given names from Test to Tester"]);
    assert.deepEqual(g.warnings, ["check the spelling"]);
    assert.equal(confirmLabel(g), "save");
    assert.equal(confirmLabel({ direct: [], review: ["x"], warnings: [] }), "send for review");
    assert.deepEqual(planGroups({}), { direct: [], review: [], warnings: [] });
  });
  it("says who reviews the second group", () => {
    assert.match(reviewerLine({ admin: false }), /an admin of the family site looks these over/);
    assert.match(reviewerLine({ admin: true }), /another admin/);
  });
  it("the toast: saved with an undo and a suggestion sent", () => {
    const undo = { base_versions: { [KEY]: 5 }, ops: [{ id: "x", op: "set" }] };
    const t = savedToast({ applied: { versions: { [KEY]: 5 }, undo }, proposal: { id: "P1" }, summary: [{ text: "a", route: "direct" }, { text: "b", route: "review" }] }, 1000);
    assert.equal(t.text, "saved. 1 suggestion sent");
    assert.equal(t.undo, undo);
    assert.equal(t.undoUntil, 1000 + UNDO_WINDOW_MS);
    assert.equal(undoLeftMs(t, 1000), UNDO_WINDOW_MS);
    assert.equal(undoLeftMs(t, 1000 + UNDO_WINDOW_MS), 0);
    assert.equal(undoLeftMs(t, 1000 + UNDO_WINDOW_MS + 1), 0);
  });
  it("the toast: saved alone, a suggestion alone, plural, no undo for a delete", () => {
    assert.equal(savedToast({ applied: { versions: {}, undo: { base_versions: {}, ops: [{}] } }, proposal: null, summary: [] }).text, "saved.");
    const sent = savedToast({ applied: null, proposal: { id: "P" }, summary: [{ route: "review" }] });
    assert.equal(sent.text, "sent. you can change or withdraw it until an admin looks.");
    assert.equal(sent.sent, 1);
    assert.equal(sent.undo, null);
    assert.equal(savedToast({ applied: { versions: {}, undo: null }, proposal: { id: "P" }, summary: [{ route: "review" }, { route: "review" }] }).text, "saved. 2 suggestions sent");
    assert.equal(savedToast({ applied: { versions: {}, undo: null }, proposal: null, summary: [] }).undo, null);
  });
});

describe("problems", () => {
  const ops = [{ id: "names.nick" }, { id: "names.title" }];
  const labels = { "names.nick": "nickname", "names.title": "title" };
  const err = (status, code, errors) => Object.assign(new ApiError(status, code, "m"), errors ? { errors } : {});
  it("a version_conflict is the replay path", () => {
    const p = problemFor(err(409, "version_conflict"));
    assert.equal(p.conflict, true);
    assert.equal(p.text, "this page just changed — please check your edits.");
  });
  it("each code of the error matrix has its words", () => {
    const text = (s, c) => problemFor(err(s, c)).text;
    assert.equal(text(403, "not_allowed"), "only an admin can change this.");
    assert.equal(text(422, "dob_not_allowed"), "we only keep the birth year on the site.");
    assert.equal(text(422, "never_in_cloud"), "we don't keep this on the site.");
    assert.match(text(422, "contact_info"), /phone number/);
    assert.equal(text(413, "too_large"), "please send these in smaller batches.");
    assert.equal(text(429, "rate_limited"), "you've sent a lot today — try again tomorrow.");
    assert.equal(text(503, "unavailable"), "the site is busy. try again in a moment.");
    assert.match(text(0, "network"), /couldn't reach the site/);
    assert.match(text(500, "server"), /something went wrong/);
    assert.match(text(400, "validation"), /aren't valid/);
  });
  it("a 401 offers the sign-in, an idempotency mismatch asks for a fresh key", () => {
    assert.equal(problemFor(err(401, "unauthenticated")).signIn, true);
    assert.equal(problemFor(err(401, "step_up_required")).signIn, true);
    assert.equal(problemFor(err(422, "idempotency_mismatch")).retryKey, true);
  });
  it("step_up_required and unauthenticated lead to the sign-in whatever the status, and only the step-up asks for a fresh one", () => {
    const up = problemFor(err(403, "step_up_required"));
    assert.equal(up.signIn, true);
    assert.equal(up.stepUp, true);
    assert.equal(up.text, "sign in again to confirm this change, then come back to save.");
    assert.equal(problemFor(err(401, "step_up_required")).stepUp, true);
    assert.equal(problemFor(err(403, "unauthenticated")).signIn, true);
    assert.equal(problemFor(err(401, "unauthenticated")).stepUp, false);
    assert.equal(problemFor(err(403, "not_allowed")).signIn, false);
  });
  it("a hiccup is transient (the undo stays on offer), a refusal or a conflict is not", () => {
    for (const [s, c] of [[0, "network"], [429, "rate_limited"], [500, "server"], [503, "unavailable"]]) assert.equal(problemFor(err(s, c)).transient, true, `${s}`);
    for (const [s, c] of [[400, "validation"], [403, "not_allowed"], [409, "version_conflict"], [422, "contact_info"]]) assert.equal(problemFor(err(s, c)).transient, false, `${s}`);
  });
  it("the note counter shows the limit", () => {
    assert.equal(NOTE_MAX, 1000);
    assert.equal(noteCountText(12), "12 of 1000 characters");
  });
  it("names the fields an errors[] points at, never a value", () => {
    const p = problemFor(err(422, "contact_info", [{ pointer: "/ops/1/value", kind: "phone", span: [0, 4] }, { opId: "names.nick" }]), { labels, ops });
    assert.deepEqual(p.fields, ["title", "nickname"]);
  });
  it("copy is lowercase plain words with no jargon", () => {
    for (const t of [...allSaveText(), noteCountText(0)]) {
      assert.ok(t.length > 0);
      assert.ok(!/\b(record|records|users?|members?|proposal|handle|gramps|dry.?run|payload|409|422)\b/i.test(t), t);
    }
  });
  it("copy never starts with a capital", () => {
    for (const t of allSaveText()) assert.ok(!/^[A-Z]/.test(t), t);
  });
});

describe("ApiError keeps errors[]", () => {
  it("exposes the top-level errors of a 400, 403 or 422", async () => {
    const errors = [{ pointer: "/ops/0/value", kind: "phone", span: [0, 3] }];
    const api = createApi({ fetchImpl: async () => ({ status: 422, ok: false, json: async () => ({ error: "contact_info", message: "m", errors }) }), skipWhenSignedOut: false });
    await assert.rejects(api.post("/changes", {}), (e) => e instanceof ApiError && e.code === "contact_info" && JSON.stringify(e.errors) === JSON.stringify(errors));
    const none = createApi({ fetchImpl: async () => ({ status: 403, ok: false, json: async () => ({ error: "forbidden" }) }), skipWhenSignedOut: false });
    await assert.rejects(none.get("/x"), (e) => e.errors === undefined);
  });
});

describe("SAVE_COPY", () => {
  it("names the two sheet groups as the design does", () => {
    assert.equal(SAVE_COPY.groupDirect, "saves now");
    assert.equal(SAVE_COPY.groupReview, "sent for review");
  });
});

// ---- the person sections in the save flow (HFY-TSK-156) ----------------------------------------------------------------------------
describe("list sections in the save flow", () => {
  const resolver = createModeResolver(JSON.parse(readFileSync(new URL("./fixtures/edit-policy-all.json", import.meta.url), "utf8")));
  const ev = (type, dt) => ({ _class: "Event", type: { _class: "EventType", value: type, string: "" }, date: dt });
  const dt = (y) => ({ _class: "Date", calendar: 0, modifier: 0, quality: 0, dateval: [0, 0, y, false], text: "", sortval: 1 });
  const bundle = {
    key: KEY, version: 7,
    obj: { ...OBJ, event_ref_list: [{ _class: "EventRef", ref: "he1", role: { _class: "EventRoleType", value: 1, string: "" } }], note_list: ["hn1"] },
    related: { "Event:he1": { version: 3, obj: ev(19, dt(2001)) }, "Note:hn1": { version: 2, obj: { _class: "Note", text: { _class: "StyledText", string: "Hi", tags: [] } } } }
  };
  const all = PERSON_SECTIONS;
  const member = { admin: false, relation: "own" };
  const build = (drafts, viewer = member) => opsFromDrafts({ key: KEY, sections: all, obj: bundle.obj, bundle, viewer, drafts });
  const newEvent = { events: { edits: {}, removed: [], added: [{ tid: "n1", values: { type: "21", date: dt(1999), place: { ref: "", name: "Newtown" }, description: "" } }], order: null } };

  it("the base versions name the target and each related object the ops touch, and no new object", () => {
    const { ops } = build({ ...newEvent, notes: { edits: { hn1: { text: "Hello" } }, removed: [], added: [], order: null } });
    assert.deepEqual(baseVersionsFor(bundle, ops), { [KEY]: 7, "Note:hn1": 2 });
    assert.deepEqual(changesBody({ target: KEY, version: 7, ops, baseVersions: baseVersionsFor(bundle, ops) }).base_versions, { [KEY]: 7, "Note:hn1": 2 });
    assert.deepEqual(baseVersionsFor(bundle, []), { [KEY]: 7 });
  });

  it("a change of several ops counts once: a new event with a new place is one change", () => {
    const built = build(newEvent);
    assert.equal(built.ops.length, 3);
    const c = countOps(built.ops, resolver, "Person", member, built.units);
    assert.equal(c.total, 1);
    assert.equal(c.direct + c.review, 1);
    assert.equal(countOps(built.ops, resolver, "Person", member).total, 3);
  });

  it("the bar counts by the table: a new place goes to review for a member; an admin's saves now", () => {
    const built = build(newEvent);
    assert.deepEqual(countOps(built.ops, resolver, "Person", member, built.units), { total: 1, direct: 0, review: 1 });
    const admin = { admin: true, relation: "other" };
    assert.deepEqual(countOps(build(newEvent, admin).ops, resolver, "Person", admin, built.units), { total: 1, direct: 1, review: 0 });
    // a note edited on the member's own page saves now; a fact, whose table rows are conditional, is hinted without them
    const two = build({ notes: { edits: { hn1: { text: "Hello" } }, removed: [], added: [], order: null }, facts: { edits: {}, removed: [], added: [{ tid: "n1", values: { type: "15", value: "x" } }], order: null } });
    assert.deepEqual(countOps(two.ops, resolver, "Person", member, two.units), { total: 2, direct: 2, review: 0 });
  });

  it("modeOfOp judges a create by the class's main field and an op by the class its object is", () => {
    assert.equal(modeOfOp({ op: "create", obj: "new:1", cls: "Place", value: {} }, resolver, "Person", member), "proposal");
    assert.equal(modeOfOp({ op: "create", obj: "new:1", cls: "Note", value: {} }, resolver, "Person", member), "direct");
    assert.equal(modeOfOp({ op: "set", obj: "Note:hn1", path: "/text", base: null, value: {} }, resolver, "Person", { admin: false, relation: "other" }), "proposal");
  });

  it("replayDrafts keeps the form fields the member changed and the list changes that still apply, and drops what the save stored", () => {
    const fresh = { ...bundle, version: 8, related: { ...bundle.related, "Note:hn1": { version: 3, obj: { _class: "Note", text: { _class: "StyledText", string: "Hello", tags: [] } } } } };
    const drafts = {
      names: { surname: "Person", first_name: "Test", nick: "Tessa" },
      notes: { edits: { hn1: { text: "Hello" } }, removed: [], added: [{ tid: "n1", values: { text: "Another" } }, { tid: "n2", values: { text: "Saved" } }], order: null }
    };
    const out = replayDrafts({ sections: all, oldBundle: bundle, freshBundle: fresh, drafts, settledUnits: new Set(["notes/a:n2"]) });
    assert.equal(out.names.nick, "Tessa");
    assert.deepEqual(out.notes.edits, {});
    assert.deepEqual(out.notes.added.map((a) => a.tid), ["n1"]);
    // no list draft left, no key
    assert.equal(replayDrafts({ sections: all, oldBundle: bundle, freshBundle: bundle, drafts: { names: {} } }).notes, undefined);
  });

  it("settledUnitsOf: a change is settled only when every one of its ops was stored", () => {
    const built = build(newEvent);
    const stored = Object.fromEntries(built.ops.map((o) => [o.id, o.value]));
    assert.deepEqual([...settledUnitsOf(built, stored)], ["events/a:n1"]);
    const partial = { ...stored };
    delete partial[built.ops[2].id];
    assert.deepEqual([...settledUnitsOf(built, partial)], []);
    assert.deepEqual([...settledUnitsOf(built, {})], []);
  });
});
