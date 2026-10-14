// HFY-TSK-183 (edit-api-changes): POST /api/changes. In-memory DynamoDB fake, synthetic ids, names and dates only.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SignJWT, importPKCS8 } from "jose";
import { InMemoryNotificationStore } from "@io-kit/notify/server";
import { AUDIENCE, ISSUER, cmds, makeApi, pem, signToken, TABLE } from "./world.js";
import { applyBatch } from "../src/sync/apply.js";
import { createHookRegistry } from "../src/sync/hooks.js";
import { headKey } from "../src/sync/store.js";
import { buildCaps, ROUTES } from "../src/routes.js";
import { approvalActions, proposalTooLarge, ulidFloor, MAX_APPROVAL_OBJECTS } from "../src/records/proposals.js";
import { isDestructive } from "../src/records/changes.js";
import { contentHash, hashObject } from "../src/records/ops.js";
import { idemKeys, MAX_TXN_ACTIONS } from "../src/records/proposals.js";
import { recordContributorActions, registerRecordContributor } from "../src/record-contributor.js";

const h = (n) => n.toString(16).padStart(28, "0");
const typ = (cls, value, string = "") => ({ _class: cls, value, string });
const date = (dateval = [0, 0, 0, false], text = "", modifier = 0) => ({ _class: "Date", calendar: 0, dateval, format: null, modifier, newyear: 0, quality: 0, sortval: 0, text });
const person = (n, extra = {}) => ({
  _class: "Person", handle: h(n), gramps_id: `I${String(n).padStart(4, "0")}`, private: false, gender: 1,
  primary_name: { _class: "Name", first_name: "Alder", nick: "", surname_list: [{ _class: "Surname", primary: true, surname: "Testwood" }], type: typ("NameType", 2), date: date() },
  event_ref_list: [], birth_ref_index: -1, death_ref_index: -1, family_list: [], parent_family_list: [], note_list: [], media_list: [], urls: [], ...extra,
});
const family = (n, extra = {}) => ({ _class: "Family", handle: h(1000 + n), gramps_id: `F${String(n).padStart(4, "0")}`, private: false, father_handle: null, mother_handle: null, child_ref_list: [], event_ref_list: [], note_list: [], ...extra });
const note = (n, extra = {}) => ({ _class: "Note", handle: h(2000 + n), gramps_id: `N${String(n).padStart(4, "0")}`, private: false, text: { _class: "StyledText", string: `Synthetic note ${n}`, tags: [] }, ...extra });
const event = (n, type, dateval, extra = {}) => ({ _class: "Event", handle: h(3000 + n), gramps_id: `E${String(n).padStart(4, "0")}`, private: false, type: typ("EventType", type), date: date(dateval), place: "", citation_list: [], ...extra });
const eref = (ev, role = 1) => ({ _class: "EventRef", ref: ev.handle, role: typ("EventRoleType", role), private: false });
const create = (obj) => ({ op: "create", class: obj._class, handle: obj.handle, base_version: null, obj });

const ME = "I0001";
const OTHER = "I0002";
const ADMIN = "I0099";
const ADMIN2 = "I0098";
const q = { warn() {}, error() {} };
const key = (obj) => `${obj._class}:${obj.handle}`;
const set = (o, path, base, value, id) => ({ ...(id ? { id } : {}), op: "set", obj: key(o), path, base, value });

let envBefore;
beforeEach(() => { envBefore = process.env.HFY_EDITING; process.env.HFY_EDITING = "on"; });
afterEach(() => { if (envBefore === undefined) delete process.env.HFY_EDITING; else process.env.HFY_EDITING = envBefore; });

async function world({ clock = () => Date.now(), admins = [ADMIN, ADMIN2], seedExtra = [], guardDob, meExtra = {} } = {}) {
  const txns = [];
  const race = { before: null };
  const afters = [];
  const contributed = [];
  const hooks = createHookRegistry();
  hooks.registerAfterCommit((info) => { afters.push(info); });
  hooks.registerContributor((batch, origin) => { contributed.push({ batch_id: batch.batch_id, origin }); });
  const inbox = new InMemoryNotificationStore();
  const w = makeApi({
    admins, log: q, clock, inbox, flags: { inboxV1: true }, ...(guardDob === undefined ? {} : { guardDob }),
    intercept: async (cmd) => {
      if (cmd.constructor.name !== "TransactWriteCommand") return;
      txns.push(structuredClone(cmd.input));
      if (race.before) { const fn = race.before; race.before = null; await fn(); } // another request commits just before this one does
    },
    extraDeps: { syncHooks: hooks, idPolicy: { mode: "mint" }, getAdmins: async () => new Set(admins), txnOpts: { sleep: async () => {} } },
  });
  w.ddb.rows.set("SYNC#HEAD\u0000META", { ...headKey(), seq: 0, seeded: true, writes_enabled: true });
  let t = Date.parse("2026-10-14T00:00:00Z");
  let u = 0;
  const sctx = { ddb: w.ddb, cmds, table: TABLE, now: () => (t += 1000), uid: () => `s${++u}`, unsafeNoValidate: true, log: q, txnOpts: { sleep: async () => {} } };
  let k = 0;
  const seed = async (objs) => {
    for (let i = 0; i < objs.length; i += 20) await applyBatch(sctx, { principal: "svc-seed", origin: "desktop", idempotencyKey: `seed${++k}`, ops: objs.slice(i, i + 20).map(create) });
  };
  const n1 = note(1);
  const n2 = note(2);
  const fam = family(1, { father_handle: h(1) });
  const me = person(1, { family_list: [fam.handle], note_list: [n1.handle], ...meExtra });
  const other = person(2, { note_list: [n2.handle] });
  await seed([me, other, n1, n2, fam, ...seedExtra]);
  const bump = (obj, base) => applyBatch(sctx, { principal: "svc-seed", origin: "desktop", idempotencyKey: `bump${++k}`, ops: [{ op: "update", class: obj._class, handle: obj.handle, base_version: base, obj }] });
  txns.length = 0;
  afters.length = 0;
  contributed.length = 0;
  const post = async (who, body, { idem, headers = {}, token } = {}) =>
    w.call("POST", "/api/changes", { token: token ?? (await signToken(who)), body, headers: { ...(idem ? { "idempotency-key": idem } : {}), ...headers } });
  const rows = (prefix) => w.ddb.all().filter((r) => r.PK.startsWith(prefix));
  return { ...w, post, rows, txns, race, afters, contributed, inbox, me, other, n1, n2, fam, seed, bump, hooks };
}
const versions = (w, objs) => Object.fromEntries(objs.map((o) => [key(o), 1]));
const writes = (w) => w.ddb.calls.filter((c) => /^(Put|Update|Delete|TransactWrite)Command$/.test(c)).length;
const err = (r) => ({ status: r.status, error: r.body?.error });

describe("dry_run (AC1)", () => {
  it("returns the direct and review plan with summaries and writes nothing, with no Idempotency-Key", async () => {
    const w = await world();
    const before = writes(w);
    const rowsBefore = w.ddb.all().length;
    const r = await w.post(ME, {
      target: key(w.me), base_versions: versions(w, [w.me]), dry_run: true,
      ops: [set(w.me, "/primary_name/nick", undefined, "Ally", "nick"), set(w.me, "/primary_name/first_name", "Alder", "Aldric", "first")].map((o) => (o.base === undefined ? { ...o, base: "" } : o)),
    });
    expect(r.status).toBe(200);
    expect(r.body.errors).toEqual([]);
    expect(r.body.plan.direct.map((g) => g.opIds)).toEqual([["nick"]]);
    expect(r.body.plan.review.map((g) => g.opIds)).toEqual([["first"]]);
    expect(r.body.plan.direct[0].summary[0].text).toMatch(/nickname/);
    expect(r.body.plan.review[0].summary[0].text).toMatch(/given names/);
    expect(writes(w) - before).toBe(0);
    expect(w.ddb.all().length).toBe(rowsBefore);
    expect(w.txns).toEqual([]);
  });
  it("still refuses what a real call would refuse", async () => {
    const w = await world();
    const r = await w.post(ME, { base_versions: versions(w, [w.me]), dry_run: true, ops: [set(w.me, "/gramps_id", "I0001", "I0777")] });
    expect(err(r)).toEqual({ status: 403, error: "not_allowed" });
  });
});

describe("a mixed submission is one transaction (AC2)", () => {
  async function mixed() {
    const w = await world();
    const r = await w.post(ME, {
      target: key(w.me), base_versions: versions(w, [w.me]), note: "fixing my first name",
      ops: [set(w.me, "/primary_name/nick", "", "Ally", "nick"), set(w.me, "/primary_name/first_name", "Alder", "Aldric", "first")],
    }, { idem: "mixed-1" });
    return { w, r };
  }
  it("applies the nickname now and files the given name as a proposal, in exactly one TransactWrite through applyBatch", async () => {
    const { w, r } = await mixed();
    expect(r.status).toBe(201);
    expect(r.body.applied.versions).toEqual({ [key(w.me)]: 2 });
    expect(r.body.applied.undo.base_versions).toEqual({ [key(w.me)]: 2 });
    expect(r.body.applied.undo.ops).toHaveLength(1);
    expect(r.body.proposal).toMatchObject({ state: "pending", rev: 1, kind: "edit", origin: "web", proposer: { id: ME }, targets: [key(w.me)], subject: { cls: "Person", handle: w.me.handle, gramps_id: ME }, can: { amend: true, withdraw: true, decide: false, comment: true }, stale: false });
    expect(r.body.proposal.ops.map((o) => o.id)).toEqual(["first"]);
    expect(r.body.summary.map((s) => s.route)).toEqual(["direct", "review"]);

    expect(w.txns).toHaveLength(1);
    const items = w.txns[0].TransactItems;
    const pks = items.map((i) => (i.Put ?? i.Update ?? i.Delete ?? i.ConditionCheck).Item?.PK ?? (i.Put ?? i.Update ?? i.Delete ?? i.ConditionCheck).Key?.PK);
    const has = (re) => pks.some((p) => re.test(p));
    expect(has(/^REC#Person#/)).toBe(true); // the record head
    expect(has(/^SYNC#LOG$/)).toBe(true); // its log entry
    expect(has(/^SYNC#HEAD$/)).toBe(true);
    expect(has(/^SYNC#BATCH#/)).toBe(true);
    expect(has(/^AUDIT#records:/)).toBe(true);
    expect(pks.filter((p) => p.startsWith("PROP#"))).toHaveLength(3); // META, IDX#BY, IDX#REC#Person
    expect(has(/^IDEM#/)).toBe(true);
    expect(has(/^AUDIT#proposal:/)).toBe(true);
    expect(has(/^CONTRIB#|^CSTAT#/)).toBe(false); // this task adds no contribution op
    const proposalItems = items.map((i) => i.Put?.Item).filter((i) => i?.PK?.startsWith("PROP#"));
    expect(proposalItems.map((i) => i.SK).sort()).toEqual(["IDX#BY", `IDX#REC#${key(w.me)}`, "META"]);
    expect(proposalItems.find((i) => i.SK === "META").GSI1PK).toBe("PROPQ#pending");
    expect(proposalItems.find((i) => i.SK === "IDX#BY").GSI1PK).toBe(`PROPBY#${ME}`);
    expect(proposalItems.find((i) => i.SK !== "META" && i.SK !== "IDX#BY").GSI1PK).toBe(`PROPREC#${key(w.me)}`);
    // the rows are really there
    expect(w.rows("PROP#")).toHaveLength(3);
    expect(w.ddb.rows.get(`REC#Person#${w.me.handle}\u0000HEAD`).version).toBe(2);
  });
  it("the review part is planned against the stored state: the proposal keeps the version the editor loaded, and the undo names only the records it touches", async () => {
    const { w, r } = await mixed();
    expect(r.body.proposal.base_versions).toEqual({ [key(w.me)]: 1 });
    expect(r.body.applied.versions).toEqual({ [key(w.me)]: 2 });
    expect(r.body.applied.undo.base_versions).toEqual({ [key(w.me)]: 2 });
    expect(r.body.applied.undo.ops.map((o) => o.obj)).toEqual([key(w.me)]);
  });
  it("fires the afterCommit hook exactly once with origin=self, and runs the contributors once", async () => {
    const { w } = await mixed();
    expect(w.afters).toHaveLength(1);
    expect(w.afters[0]).toMatchObject({ origin: "self" });
    expect(w.contributed).toHaveLength(1);
    expect(w.contributed[0].origin).toBe("self");
  });
  it("tells every admin except the proposer; a member proposer notifies both admins", async () => {
    const { w } = await mixed();
    expect((await w.inbox.list(ADMIN)).items.map((i) => i.type)).toEqual(["proposal_submitted"]);
    expect((await w.inbox.list(ADMIN2)).items.map((i) => i.type)).toEqual(["proposal_submitted"]);
    expect((await w.inbox.list(ME)).items).toEqual([]);
  });
  it("an admin who queues their own change is not told about it, the other admin is", async () => {
    const w = await world();
    const r = await w.post(ADMIN, { target: key(w.other), base_versions: versions(w, [w.other]), route: "review", ops: [set(w.other, "/primary_name/first_name", "Alder", "Aldwin", "first")] }, { idem: "adm-1" });
    expect(r.status).toBe(201);
    expect(r.body.applied).toBeNull();
    expect(r.body.proposal.proposer.id).toBe(ADMIN);
    expect(w.afters).toEqual([]); // no record was written
    expect((await w.inbox.list(ADMIN)).items).toEqual([]);
    expect((await w.inbox.list(ADMIN2)).items.map((i) => i.type)).toEqual(["proposal_submitted"]);
  });
  it("a proposal-only submission is one transaction that touches no record", async () => {
    const w = await world();
    const r = await w.post(ME, { target: key(w.other), base_versions: versions(w, [w.other]), ops: [set(w.other, "/primary_name/first_name", "Alder", "Aldwin")] }, { idem: "p-1" });
    expect(r.status).toBe(201);
    expect(w.txns).toHaveLength(1);
    expect(w.txns[0].TransactItems.map((i) => (i.Put ?? i.Update).Item?.PK ?? (i.Put ?? i.Update).Key.PK).some((p) => p.startsWith("REC#") || p.startsWith("SYNC#"))).toBe(false);
    expect(w.ddb.rows.get(`REC#Person#${w.other.handle}\u0000HEAD`).version).toBe(1);
  });
  it("a direct-only submission writes the record and the receipt and no proposal", async () => {
    const w = await world();
    const r = await w.post(ME, { base_versions: versions(w, [w.me]), ops: [set(w.me, "/primary_name/nick", "", "Ally")] }, { idem: "d-1" });
    expect(r.status).toBe(201);
    expect(r.body.proposal).toBeNull();
    expect(w.rows("PROP#")).toEqual([]);
    expect(w.rows("IDEM#")).toHaveLength(1);
    expect(w.txns).toHaveLength(1);
    expect((await w.inbox.list(ADMIN)).items).toEqual([]);
  });
  it("creates a new note for the own page: a minted handle and id, one create, no proposal", async () => {
    const w = await world();
    const value = { _class: "Note", gramps_id: "", private: false, text: { _class: "StyledText", string: "A synthetic remembrance", tags: [] }, format: 0, type: typ("NoteType", 1) };
    const r = await w.post(ME, {
      base_versions: versions(w, [w.me]),
      ops: [{ id: "mk", op: "create", obj: "new:1", cls: "Note", value }, { id: "ln", op: "add", obj: key(w.me), path: "/note_list", value: "new:1" }],
    }, { idem: "n-1" });
    expect(r.status).toBe(201);
    expect(Object.keys(r.body.applied.versions)).toHaveLength(2);
    expect(Object.keys(r.body.applied.versions)).toContain(key(w.me));
    expect(Object.keys(r.body.applied.versions).find((k) => k !== key(w.me))).toMatch(/^Note:/);
    const noteRow = w.ddb.all().find((x) => x.PK.startsWith("REC#Note#") && x.PK !== `REC#Note#${w.n1.handle}` && x.PK !== `REC#Note#${w.n2.handle}`);
    expect(noteRow.version).toBe(1);
    expect(noteRow.gramps_id).toMatch(/^N8\d{3}$/);
    const head = JSON.parse(w.ddb.rows.get(`REC#Person#${w.me.handle}\u0000HEAD`).obj_json);
    expect(head.note_list).toContain(noteRow.PK.split("#")[2]);
  });
});

describe("the error matrix (AC3)", () => {
  it("a stale base on a direct group is 409 version_conflict with the current versions", async () => {
    const w = await world();
    const r = await w.post(ME, { base_versions: { [key(w.me)]: 7 }, ops: [set(w.me, "/primary_name/nick", "", "Ally")] }, { idem: "s-1" });
    expect(err(r)).toEqual({ status: 409, error: "version_conflict" });
    expect(r.body.details.current).toEqual({ [key(w.me)]: 1 });
    expect(w.rows("IDEM#")).toEqual([]);
    expect(w.txns).toEqual([]);
  });
  it("an op whose base no longer matches is a 409 too", async () => {
    const w = await world();
    const r = await w.post(ME, { base_versions: versions(w, [w.me]), ops: [set(w.me, "/primary_name/nick", "wrong", "Ally")] }, { idem: "s-2" });
    expect(err(r)).toEqual({ status: 409, error: "version_conflict" });
  });
  it("a desktop-only path is 403 not_allowed; the url reason rides in details", async () => {
    const w = await world();
    const r = await w.post(ME, { base_versions: versions(w, [w.me]), ops: [set(w.me, "/gramps_id", "I0001", "I0777", "gid")] }, { idem: "d-1" });
    expect(err(r)).toEqual({ status: 403, error: "not_allowed" });
    expect(r.body.errors).toEqual([expect.objectContaining({ opId: "gid", obj: key(w.me), path: "/gramps_id", code: "desk" })]);
    const search = { _class: "Url", path: "https://example.test/search", desc: "", private: false, type: typ("UrlType", 3) };
    const u = await w.post(ME, { base_versions: versions(w, [w.me]), ops: [{ id: "u", op: "add", obj: key(w.me), path: "/urls", value: search }] }, { idem: "d-2" });
    expect(err(u)).toEqual({ status: 403, error: "not_allowed" });
    expect(u.body.details.reasons).toEqual(["url_not_link"]);
    expect(u.body.errors[0]).toMatchObject({ code: "desk", reason: "url_not_link" });
    expect(w.txns).toEqual([]);
  });
  it("an admin-only path is 403 for a member (a new custom type string), and a member cannot ask for the review route", async () => {
    const w = await world();
    const ev = event(1, 1, [0, 0, 0, false]);
    await w.seed([ev]);
    const custom = set(ev, "/type", typ("EventType", 1), typ("EventType", 0, "Synthetic gathering"), "t");
    const r = await w.post(OTHER, { base_versions: { [key(ev)]: 1 }, ops: [custom] }, { idem: "a-1" });
    expect(err(r)).toEqual({ status: 403, error: "not_allowed" });
    expect(r.body.errors[0].code).toBe("admin");
    const rev = await w.post(ME, { base_versions: versions(w, [w.me]), route: "review", ops: [set(w.me, "/primary_name/nick", "", "Ally")] }, { idem: "a-2" });
    expect(err(rev)).toEqual({ status: 403, error: "not_allowed" });
  });
  it("a replayed Idempotency-Key gives the identical response and writes nothing more", async () => {
    const w = await world();
    const body = { target: key(w.me), base_versions: versions(w, [w.me]), ops: [set(w.me, "/primary_name/nick", "", "Ally", "nick"), set(w.me, "/primary_name/first_name", "Alder", "Aldric", "first")] };
    const a = await w.post(ME, body, { idem: "same-1" });
    const writesAfterFirst = writes(w);
    const b = await w.post(ME, body, { idem: "same-1" });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body).toEqual(a.body);
    expect(b.headers["idempotent-replayed"]).toBe("true");
    expect(writes(w)).toBe(writesAfterFirst);
    expect(w.txns).toHaveLength(1);
    expect(w.rows("PROP#")).toHaveLength(3);
    expect(w.afters).toHaveLength(1);
  });
  it("the same key with a different body is 422 idempotency_mismatch", async () => {
    const w = await world();
    const a = await w.post(ME, { base_versions: versions(w, [w.me]), ops: [set(w.me, "/primary_name/nick", "", "Ally")] }, { idem: "same-2" });
    expect(a.status).toBe(201);
    const b = await w.post(ME, { base_versions: versions(w, [w.me]), ops: [set(w.me, "/primary_name/nick", "", "Alley")] }, { idem: "same-2" });
    expect(err(b)).toEqual({ status: 422, error: "idempotency_mismatch" });
  });
  it("a key is per principal: another member's request with the same key is a new request", async () => {
    const w = await world();
    const a = await w.post(ME, { target: key(w.other), base_versions: versions(w, [w.other]), ops: [set(w.other, "/primary_name/first_name", "Alder", "Aldwin")] }, { idem: "shared" });
    const b = await w.post(OTHER, { target: key(w.me), base_versions: versions(w, [w.me]), ops: [set(w.me, "/primary_name/first_name", "Alder", "Aldric")] }, { idem: "shared" });
    expect([a.status, b.status]).toEqual([201, 201]);
  });
  it("needs an Idempotency-Key unless dry_run", async () => {
    const w = await world();
    const r = await w.post(ME, { base_versions: versions(w, [w.me]), ops: [set(w.me, "/primary_name/nick", "", "Ally")] });
    expect(err(r)).toEqual({ status: 400, error: "validation" });
    expect(r.body.errors[0].pointer).toBe("/headers/idempotency-key");
  });
  it("reads the Idempotency-Key header whatever its case", async () => {
    const w = await world();
    const body = { base_versions: versions(w, [w.me]), ops: [set(w.me, "/primary_name/nick", "", "Ally")] };
    const a = await w.post(ME, body, { headers: { "Idempotency-Key": "mixed-case-1" } });
    expect(a.status).toBe(201);
    const b = await w.post(ME, body, { headers: { "IDEMPOTENCY-KEY": "mixed-case-1" } });
    expect(b.status).toBe(201);
    expect(b.headers["idempotent-replayed"]).toBe("true");
    expect(w.rows("IDEM#")).toHaveLength(1);
  });
  it("a review-only submission on a stale base version is filed (not 409) while its op bases still match; the proposal keeps the versions the editor loaded", async () => {
    const w = await world();
    await w.bump(person(2, { note_list: [w.n2.handle], gender: 0 }), 1); // the page moved on (version 2), the given name did not
    const r = await w.post(ME, { target: key(w.other), base_versions: { [key(w.other)]: 1 }, ops: [set(w.other, "/primary_name/first_name", "Alder", "Aldwin", "first")] }, { idem: "stale-r1" });
    expect(r.status).toBe(201);
    expect(r.body.applied).toBeNull();
    expect(r.body.proposal.base_versions).toEqual({ [key(w.other)]: 1 });
    expect(w.rows("PROP#")).toHaveLength(3);
  });
  it("...but a review op whose base value changed since is 409 version_conflict, and nothing is filed", async () => {
    const w = await world();
    await w.bump(person(2, { note_list: [w.n2.handle], primary_name: { ...person(2).primary_name, first_name: "Aldous" } }), 1);
    const r = await w.post(ME, { target: key(w.other), base_versions: { [key(w.other)]: 1 }, ops: [set(w.other, "/primary_name/first_name", "Alder", "Aldwin", "first")] }, { idem: "stale-r2" });
    expect(err(r)).toEqual({ status: 409, error: "version_conflict" });
    expect(r.body.details.current).toEqual({ [key(w.other)]: 2 });
    expect(w.rows("PROP#")).toEqual([]);
    expect(w.rows("IDEM#")).toEqual([]);
  });
  it("a reference to a hidden note is answered exactly like a reference to a note that does not exist", async () => {
    const w = await world();
    w.ddb.rows.set(`MOD#note:${w.n2.handle}\u0000META`, { PK: `MOD#note:${w.n2.handle}`, SK: "META", entity: "mod", author_id: OTHER, state: "hidden", hidden: true, open: true });
    const link = (handle, id) => ({ id, op: "add", obj: key(w.me), path: "/note_list", value: handle });
    const hidden = await w.post(ME, { base_versions: versions(w, [w.me]), ops: [link(w.n2.handle, "ln")] }, { idem: "hid-1" });
    const absent = await w.post(ME, { base_versions: versions(w, [w.me]), ops: [link(h(777), "ln")] }, { idem: "hid-2" });
    expect(err(hidden)).toEqual({ status: 400, error: "validation" });
    expect(hidden.body.errors).toEqual(absent.body.errors);
    expect(w.txns).toEqual([]);
    // an admin sees the note, so the same link is fine for them
    expect((await w.post(ADMIN, { base_versions: versions(w, [w.me]), ops: [link(w.n2.handle, "ln")] }, { idem: "hid-3" })).status).toBe(201);
  });
  it("the 51st proposal in 24 hours is 429 rate_limited", async () => {
    const w = await world();
    const nowMs = Date.now();
    for (let i = 0; i < 50; i += 1) {
      const id = `${ulidFloor(nowMs - 3_600_000).slice(0, 10)}${String(i).padStart(16, "0")}`;
      w.ddb.rows.set(`PROP#${id}\u0000IDX#BY`, { PK: `PROP#${id}`, SK: "IDX#BY", GSI1PK: `PROPBY#${ME}`, GSI1SK: id });
    }
    const body = { target: key(w.other), base_versions: versions(w, [w.other]), ops: [set(w.other, "/primary_name/first_name", "Alder", "Aldwin")] };
    const r = await w.post(ME, body, { idem: "r-1" });
    expect(err(r)).toEqual({ status: 429, error: "rate_limited" });
    expect(w.txns).toEqual([]);
    // an older proposal does not count, and another member is not limited
    const old = `${ulidFloor(nowMs - 3 * 86_400_000).slice(0, 10)}${"1".repeat(16)}`;
    w.ddb.rows.set(`PROP#${old}\u0000IDX#BY`, { PK: `PROP#${old}`, SK: "IDX#BY", GSI1PK: `PROPBY#${OTHER}`, GSI1SK: old });
    expect((await w.post(OTHER, { target: key(w.me), base_versions: versions(w, [w.me]), ops: [set(w.me, "/primary_name/first_name", "Alder", "Aldric")] }, { idem: "r-2" })).status).toBe(201);
  });
  it("a proposal whose approval would exceed the transaction budget is 422 proposal_too_large, at submit", async () => {
    const extra = Array.from({ length: MAX_APPROVAL_OBJECTS + 1 }, (_, i) => note(10 + i));
    const w = await world({ seedExtra: extra });
    const ops = extra.map((n, i) => set(n, "/text/string", n.text.string, `Edited ${i}`, `e${i}`));
    const r = await w.post(ME, { base_versions: versions(w, extra), ops }, { idem: "big-1" });
    expect(err(r)).toEqual({ status: 422, error: "proposal_too_large" });
    expect(w.rows("PROP#")).toEqual([]);
    expect(w.txns).toEqual([]);
  });
  it("approvalActions counts the whole approval transaction", () => {
    expect(approvalActions({ updated: 1, targets: 1 })).toBe(3 + 2 + 1 + 1 + 1 + 1 + 6);
    expect(approvalActions({ created: 1, deleted: 1, targets: 1 })).toBe(3 + 1 + 3 + 3 + 1 + 1 + 1 + 1 + 6);
    expect(proposalTooLarge({ created: 0, updated: 24, deleted: 0, targets: 24 })).toBe(false);
    expect(proposalTooLarge({ created: 0, updated: 0, deleted: 25, targets: 1 })).toBe(true);
    expect(proposalTooLarge({ created: 0, updated: 25, deleted: 0, targets: 1 })).toBe(true);
    expect(proposalTooLarge({ created: 0, updated: 8, deleted: 16, targets: 24 })).toBe(true); // 24 objects, but 3+1+16+48+1+1+24+1+6 = 101 actions
    expect(proposalTooLarge({ created: 0, updated: 10, deleted: 14, targets: 24 })).toBe(false); // 99
  });
  it("validation: unknown fields, a missing base_versions entry and a bad op are 400 with pointers", async () => {
    const w = await world();
    const a = await w.post(ME, { base_versions: versions(w, [w.me]), ops: [set(w.me, "/primary_name/nick", "", "Ally")], surprise: 1 }, { idem: "v-1" });
    expect(err(a)).toEqual({ status: 400, error: "validation" });
    const b = await w.post(ME, { base_versions: {}, ops: [set(w.me, "/primary_name/nick", "", "Ally")] }, { idem: "v-2" });
    expect(err(b)).toEqual({ status: 400, error: "validation" });
    expect(b.body.errors[0].pointer).toBe(`/base_versions/${key(w.me)}`);
    const c = await w.post(ME, { base_versions: versions(w, [w.me]), ops: [{ id: "x", op: "set", obj: key(w.me), path: "/primary_name/nick", value: "Ally" }] }, { idem: "v-3" });
    expect(err(c)).toEqual({ status: 400, error: "validation" });
    const d = await w.post(ME, { base_versions: { "Person:nosuchhandle": 1 }, ops: [{ id: "x", op: "set", obj: "Person:nosuchhandle", path: "/gender", base: 1, value: 0 }] }, { idem: "v-4" });
    expect(err(d)).toEqual({ status: 404, error: "not_found" });
  });
  it("size caps: more than 50 ops and more than 10 new objects are 413 too_large", async () => {
    const w = await world();
    const ops = Array.from({ length: 51 }, (_, i) => set(w.me, "/primary_name/nick", "", `n${i}`, `o${i}`));
    expect(err(await w.post(ME, { base_versions: versions(w, [w.me]), ops }, { idem: "c-1" }))).toEqual({ status: 413, error: "too_large" });
    const mk = Array.from({ length: 11 }, (_, i) => ({ id: `mk${i}`, op: "create", obj: `new:${i + 1}`, cls: "Note", value: { _class: "Note", gramps_id: "", private: false, text: { _class: "StyledText", string: "x", tags: [] }, format: 0, type: typ("NoteType", 1) } }));
    expect(err(await w.post(ME, { base_versions: {}, ops: mk }, { idem: "c-2" }))).toEqual({ status: 413, error: "too_large" });
  });
});

describe("the direct part's budget holds the registered record contributor's credit", () => {
  // The production contributor (record-contributor.js) adds a member's self_edit credit inside applyBatch's transaction: 7 actions here, 8 when
  // the save also tags. One member save: 10 Note creates, the member's note_list, 10 own Note deletes (direct), and `edits` review edits.
  // Direct: 3 fixed + 1 budget counter + 10x3 + 1x2 + 10x3 = 66; puts: the receipt, META, IDX#BY, one IDX#REC per edit and the audit = edits + 4.
  // The filler keeps 10 deletes under 5 % of the live heads (no step-up).
  async function atLimit(edits) {
    const own = Array.from({ length: 10 }, (_, i) => note(100 + i));
    const others = Array.from({ length: 24 }, (_, i) => note(200 + i));
    const filler = Array.from({ length: 180 }, (_, i) => note(500 + i));
    const w = await world({ seedExtra: [...own, ...others, ...filler], meExtra: { note_list: [h(2001), ...own.map((n) => n.handle)] } });
    registerRecordContributor({ ddb: w.ddb, cmds, table: TABLE }, w.hooks);
    const value = (i) => ({ _class: "Note", gramps_id: "", private: false, text: { _class: "StyledText", string: `New synthetic ${i}`, tags: [] }, format: 0, type: typ("NoteType", 1) });
    const ops = [
      ...Array.from({ length: 10 }, (_, i) => ({ id: `mk${i}`, op: "create", obj: `new:${i + 1}`, cls: "Note", value: value(i) })),
      { id: "nl", op: "set", obj: key(w.me), path: "/note_list", base: [h(2001), ...own.map((n) => n.handle)], value: [h(2001), ...Array.from({ length: 10 }, (_, i) => `new:${i + 1}`)] },
      ...own.map((n, i) => ({ id: `del${i}`, op: "delete", obj: key(n), base: hashObject(n) })),
      ...others.slice(0, edits).map((n, i) => set(n, "/text/string", n.text.string, `Edited ${i}`, `rv${i}`)),
    ];
    const r = await w.post(ME, { base_versions: versions(w, [w.me, ...own, ...others.slice(0, edits)]), ops }, { idem: `limit-${edits}` });
    return { w, r, budget: 66 + edits + 4 + recordContributorActions("self") };
  }
  it("a member save budgeted at exactly 100 actions commits, with the self_edit credit in its one transaction", async () => {
    const { w, r, budget } = await atLimit(22);
    expect(budget).toBe(MAX_TXN_ACTIONS);
    expect(r.body.error).toBeUndefined();
    expect(r.status).toBe(201);
    expect(r.body.applied).not.toBeNull();
    expect(r.body.proposal.targets).toHaveLength(22);
    expect(w.txns).toHaveLength(1);
    const items = w.txns[0].TransactItems;
    expect(items.length).toBeLessThanOrEqual(MAX_TXN_ACTIONS);
    const pk = (i) => (i.Put ?? i.Update ?? i.Delete ?? i.ConditionCheck).Item?.PK ?? (i.Put ?? i.Update ?? i.Delete ?? i.ConditionCheck).Key?.PK;
    expect(items.filter((i) => /^(CONTRIB|CSTAT)#/.test(pk(i)))).toHaveLength(7); // the event, the CAP# marker and five counters
    expect(w.rows(`CONTRIB#${ME}`).filter((x) => x.entity === "contrib").map((x) => x.kind)).toEqual(["self_edit"]);
  });
  it("one action past the budget is 413 too_large before anything is written, never a 500 from inside applyBatch", async () => {
    for (const edits of [24, 23]) {
      const { w, r, budget } = await atLimit(edits);
      expect(budget).toBeGreaterThan(MAX_TXN_ACTIONS);
      expect(err(r)).toEqual({ status: 413, error: "too_large" });
      expect(w.txns).toEqual([]);
      expect(w.rows("PROP#")).toEqual([]);
      expect(w.rows("CONTRIB#")).toEqual([]);
      expect(w.ddb.rows.get(`REC#Person#${w.me.handle}\u0000HEAD`).version).toBe(1);
    }
  });
});

describe("callers and origins", () => {
  it("an admin creates a place directly: origin admin, a minted id, one transaction", async () => {
    const w = await world();
    const value = { _class: "Place", gramps_id: "", private: false, place_type: typ("PlaceType", 3), title: "", code: "", lat: "", long: "", name: { _class: "PlaceName", value: "Synthetville", lang: "", date: date() }, placeref_list: [], alt_names: [], urls: [], note_list: [], media_list: [], citation_list: [] };
    const r = await w.post(ADMIN, { base_versions: {}, ops: [{ id: "pl", op: "create", obj: "new:1", cls: "Place", value }] }, { idem: "ad-1" });
    expect(r.body.error).toBeUndefined();
    expect(r.status).toBe(201);
    expect(w.afters.map((a) => a.origin)).toEqual(["admin"]);
    expect(w.txns).toHaveLength(1);
    const row = w.ddb.all().find((x) => x.PK.startsWith("REC#Place#"));
    expect(row.gramps_id).toMatch(/^P8\d{3}$/);
  });
  it("handler.invoke (the MCP path) takes the key as idempotency_key and marks the proposal origin mcp", async () => {
    const w = await world();
    const actor = { id: ME, label: "Member", admin: false };
    const out = await w.handler.invoke(actor, "changes.post", { body: { target: key(w.other), base_versions: versions(w, [w.other]), idempotency_key: "mcp-1", ops: [set(w.other, "/primary_name/first_name", "Alder", "Aldwin")] } });
    expect(out.status).toBe(201);
    expect(out.body.proposal.origin).toBe("mcp");
    const again = await w.handler.invoke(actor, "changes.post", { body: { target: key(w.other), base_versions: versions(w, [w.other]), idempotency_key: "mcp-1", ops: [set(w.other, "/primary_name/first_name", "Alder", "Aldwin")] } });
    expect(again.body).toEqual(out.body);
  });
});

describe("races and no-ops", () => {
  it("a record that changes between the read and the commit is a 409 version_conflict with the new version, and nothing of ours is written", async () => {
    const w = await world();
    w.race.before = () => w.bump(person(1, { family_list: [w.fam.handle], note_list: [w.n1.handle], gender: 0 }), 1);
    const r = await w.post(ME, { base_versions: versions(w, [w.me]), ops: [set(w.me, "/primary_name/nick", "", "Ally")] }, { idem: "race-1" });
    expect(err(r)).toEqual({ status: 409, error: "version_conflict" });
    expect(r.body.details.current).toEqual({ [key(w.me)]: 2 });
    expect(w.rows("IDEM#")).toEqual([]);
    expect(w.afters).toEqual([]);
  });
  const ops = [{ id: "a", op: "set", obj: `Person:${h(2)}`, path: "/primary_name/first_name", base: "Alder", value: "Aldwin" }];
  const body = { target: `Person:${h(2)}`, base_versions: { [`Person:${h(2)}`]: 1 }, ops };
  const receipt = (requestHash) => ({ ...idemKeys(ME, "race-2"), entity: "idem", requestHash, result: { status: 201, body: { applied: null, proposal: null, summary: [], first: true } }, ttl: 9999999999 });
  it("two requests with one key: the one that loses the race replays the winner's receipt", async () => {
    const w = await world();
    const hash = contentHash({ target: body.target, base_versions: body.base_versions, ops, note: null, route: "auto" });
    w.race.before = () => w.ddb.rows.set(`${idemKeys(ME, "race-2").PK}\u0000META`, receipt(hash));
    const r = await w.post(ME, body, { idem: "race-2" });
    expect(r.status).toBe(201);
    expect(r.body.first).toBe(true);
    expect(r.headers["idempotent-replayed"]).toBe("true");
    expect(w.rows("PROP#")).toEqual([]);
  });
  it("...or answers 422 when the winner's body was different", async () => {
    const w = await world();
    w.race.before = () => w.ddb.rows.set(`${idemKeys(ME, "race-2").PK}\u0000META`, receipt("0".repeat(64)));
    const r = await w.post(ME, body, { idem: "race-2" });
    expect(err(r)).toEqual({ status: 422, error: "idempotency_mismatch" });
  });
  it("a condition failure on an item that is not the receipt is 503 unavailable, never a replay", async () => {
    const w = await world();
    w.ddb.failNext("ConditionalCheckFailed", 1, { index: 1 }); // item 0 is the IDEM# receipt, item 1 a PROP# item
    const r = await w.post(ME, body, { idem: "race-3" });
    expect(err(r)).toEqual({ status: 503, error: "unavailable" });
    expect(r.headers["idempotent-replayed"]).toBeUndefined();
    expect(w.rows("IDEM#")).toEqual([]);
    expect(w.rows("PROP#")).toEqual([]);
  });
  it("a condition failure on the receipt with a stored receipt is the replay (the tag names the receipt item)", async () => {
    const w = await world();
    const hash = contentHash({ target: body.target, base_versions: body.base_versions, ops, note: null, route: "auto" });
    w.ddb.rows.set(`${idemKeys(ME, "race-4").PK}\u0000META`, receipt(hash));
    // the receipt exists but the pre-read is skipped by making the first read miss: the commit's own condition then decides
    w.race.before = null;
    w.ddb.failNext("ConditionalCheckFailed", 1, { index: 0 });
    const r = await w.post(ME, body, { idem: "race-4" });
    expect(r.headers["idempotent-replayed"]).toBe("true");
  });
  it("ops that are already applied change nothing: 200 unchanged, no transaction, no receipt", async () => {
    const w = await world();
    const r = await w.post(ME, { base_versions: versions(w, [w.me]), ops: [set(w.me, "/primary_name/nick", "", "")] }, { idem: "noop-1" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ applied: null, proposal: null, unchanged: true });
    expect(w.txns).toEqual([]);
    expect(w.rows("IDEM#")).toEqual([]);
  });
  it("an op id outside letters, digits and . _ : - is refused", async () => {
    const w = await world();
    const r = await w.post(ME, { base_versions: versions(w, [w.me]), ops: [{ ...set(w.me, "/primary_name/nick", "", "Ally"), id: "call 212 555 0100" }] }, { idem: "id-1" });
    expect(err(r)).toEqual({ status: 400, error: "validation" });
  });
});

describe("the guard runs on the resulting state before any PROP# write (AC4)", () => {
  // Each case is refused by dob_not_allowed whether HFY_GUARD_DOB is on or off (the structural date rules run unconditionally); never_in_cloud is a different rule.
  const cases = {
    "a TEXTONLY birth date": { code: "dob_not_allowed", mk: (ev) => ({ path: "/date", base: ev.date, value: date([0, 0, 0, false], "born 3 May 1950", 6) }) },
    "a span's second date on a birth": { code: "dob_not_allowed", mk: (ev) => ({ path: "/date", base: ev.date, value: date([0, 0, 1950, false, 14, 3, 1952, false], "", 5) }) },
    "a baptism day for a deceased person": { code: "dob_not_allowed", mk: (ev) => ({ path: "/date", base: ev.date, value: date([14, 3, 1950, false]) }) },
  };
  for (const [name, { code, mk }] of Object.entries(cases)) {
    for (const guardDob of [undefined, true]) {
    it(`${name} is 422 ${code} (guardDob ${guardDob ? "on" : "off"}) with zero PROP#, IDX# and THREAD# writes`, async () => {
      const type = name.includes("baptism") ? 15 : 12;
      const ev = event(5, type, [0, 0, 1950, false]);
      const death = event(6, 13, [0, 0, 1990, false]);
      const dead = person(5, { event_ref_list: [eref(ev), eref(death)], birth_ref_index: -1, death_ref_index: 1 });
      const w = await world({ seedExtra: [dead, ev, death], guardDob });
      const r = await w.post(OTHER, { target: key(dead), base_versions: { [key(ev)]: 1 }, ops: [{ id: "d", op: "set", obj: key(ev), ...mk(ev) }] }, { idem: `g-${type}` });
      expect(r.status).toBe(422);
      expect(r.body.error).toBe(code);
      expect(r.body.errors.length).toBeGreaterThan(0);
      expect(r.body.errors.every((e) => e.pointer && e.code)).toBe(true);
      expect(JSON.stringify(r.body)).not.toContain("born 3 May");
      expect(w.rows("PROP#")).toEqual([]);
      expect(w.rows("THREAD#")).toEqual([]);
      expect(w.rows("IDEM#")).toEqual([]);
      expect(w.txns).toEqual([]);
    });
   }
  }
  it("a phone number in a proposal note or in a nickname is 422 contact_info", async () => {
    const w = await world();
    const phone = "212-555-0143";
    const a = await w.post(ME, { target: key(w.other), base_versions: versions(w, [w.other]), note: `call me on ${phone}`, ops: [set(w.other, "/primary_name/first_name", "Alder", "Aldwin")] }, { idem: "p-1" });
    expect(err(a)).toEqual({ status: 422, error: "contact_info" });
    const b = await w.post(ME, { base_versions: versions(w, [w.me]), ops: [set(w.me, "/primary_name/nick", "", phone)] }, { idem: "p-2" });
    expect(err(b)).toEqual({ status: 422, error: "contact_info" });
    expect(JSON.stringify([a.body, b.body])).not.toContain(phone);
    expect(w.rows("PROP#")).toEqual([]);
  });
  it("a hyphenated phone number as an op id is 422 contact_info on both paths, and the id is not echoed", async () => {
    const w = await world();
    const phone = "212-555-0143";
    const review = await w.post(ME, { target: key(w.other), base_versions: versions(w, [w.other]), ops: [set(w.other, "/primary_name/first_name", "Alder", "Aldwin", phone)] }, { idem: "pid-1" });
    const direct = await w.post(ME, { base_versions: versions(w, [w.me]), ops: [set(w.me, "/primary_name/nick", "", "Ally", phone)] }, { idem: "pid-2" });
    for (const r of [review, direct]) {
      expect(err(r)).toEqual({ status: 422, error: "contact_info" });
      expect(r.body.errors).toEqual([{ opId: null, obj: null, path: "/id", pointer: "/ops/0/id", code: "contact_info", kind: "phone", span: [0, 12] }]);
      expect(JSON.stringify(r.body)).not.toContain(phone);
    }
    expect(w.txns).toEqual([]);
    expect(w.rows("PROP#")).toEqual([]);
    expect(w.rows("IDEM#")).toEqual([]);
    expect(JSON.stringify(w.ddb.all())).not.toContain(phone); // no SYNC#BATCH# item either
  });
  it("an impossible date is 400 validation (the Gramps semantics), before any write", async () => {
    const ev = event(7, 21, [0, 0, 1950, false]);
    const w = await world({ seedExtra: [ev] });
    const r = await w.post(ADMIN, { base_versions: { [key(ev)]: 1 }, ops: [{ id: "d", op: "set", obj: key(ev), path: "/date", base: ev.date, value: date([31, 2, 1950, false]) }] }, { idem: "sem-1" });
    expect(err(r)).toEqual({ status: 400, error: "validation" });
    expect(r.body.errors[0].code).toBe("day_out_of_range");
    expect(w.txns).toEqual([]);
  });
});

describe("R-18 over the ops as they are stored: a proposal keeps the ops, a receipt the undo ops, a batch the op ids", () => {
  const PHONE = "212-555-0143";
  const nothingStored = (w, ...rs) => {
    for (const r of rs) {
      expect(JSON.stringify(r.body)).not.toContain(PHONE);
      expect(JSON.stringify(r.body)).not.toContain("2125550143");
    }
    expect(JSON.stringify(w.ddb.all())).not.toContain(PHONE);
    expect(JSON.stringify(w.ddb.all())).not.toContain("2125550143");
    expect(w.txns).toEqual([]);
  };
  const refused = (r, pointer, code = "contact_info") => {
    expect(err(r)).toEqual({ status: 422, error: code });
    expect(r.body.errors.map((e) => e.pointer)).toContain(pointer);
  };

  it("a value that a later op overwrites is 422: on the review path (it would sit in the proposal's ops) and the direct path (in the undo)", async () => {
    const w = await world();
    const review = await w.post(ME, { target: key(w.other), base_versions: versions(w, [w.other]), ops: [
      set(w.other, "/primary_name/first_name", "Alder", PHONE, "a"),
      { ...set(w.other, "/primary_name/first_name", PHONE, "Aldwin", "b"), seq: true },
    ] }, { idem: "iv-1" });
    refused(review, "/ops/0/value");
    expect(review.body.errors[0]).toMatchObject({ opId: "a", obj: key(w.other), path: "/value", kind: "phone", span: [0, 12] });
    const direct = await w.post(ME, { base_versions: versions(w, [w.me]), ops: [
      set(w.me, "/primary_name/nick", "", PHONE, "a"),
      { ...set(w.me, "/primary_name/nick", PHONE, "Ally", "b"), seq: true },
    ] }, { idem: "iv-2" });
    refused(direct, "/ops/0/value");
    // the same number as a JSON number under a text field, and as the ref of an EventRef that a later op removes again
    const number = await w.post(ME, { base_versions: versions(w, [w.me]), ops: [
      set(w.me, "/primary_name/nick", "", 2125550143, "a"),
      { ...set(w.me, "/primary_name/nick", 2125550143, "Ally", "b"), seq: true },
    ] }, { idem: "iv-3" });
    refused(number, "/ops/0/value");
    const ref = { _class: "EventRef", ref: PHONE, role: typ("EventRoleType", 1), private: false };
    const viaRef = await w.post(ME, { base_versions: versions(w, [w.me]), ops: [
      { id: "a", op: "add", obj: key(w.me), path: "/event_ref_list", value: ref },
      { id: "b", op: "remove", obj: key(w.me), path: `/event_ref_list/@ref=${PHONE}`, base: ref, seq: true },
    ] }, { idem: "iv-4" });
    refused(viaRef, "/ops/0/value/ref");
    nothingStored(w, review, direct, number, viaRef);
  });

  it("what a no-op carries is read: a set's base, a remove's key and base, an add's before", async () => {
    const w = await world();
    const setBase = await w.post(ME, { target: key(w.other), base_versions: versions(w, [w.other]), ops: [set(w.other, "/primary_name/first_name", `call ${PHONE}`, "Alder")] }, { idem: "nb-1" });
    refused(setBase, "/ops/0/base");
    const removeKey = await w.post(ME, { target: key(w.other), base_versions: versions(w, [w.other]), ops: [{ id: "r", op: "remove", obj: key(w.other), path: `/note_list/@=call ${PHONE}`, base: `call ${PHONE}` }] }, { idem: "nb-2" });
    refused(removeKey, "/ops/0/path");
    refused(removeKey, "/ops/0/base");
    expect(removeKey.body.errors.find((e) => e.pointer === "/ops/0/path").span).toBeNull();
    const addBefore = await w.post(ME, { base_versions: versions(w, [w.me]), ops: [{ id: "n", op: "add", obj: key(w.me), path: "/note_list", value: w.n1.handle, before: `@=${PHONE}` }] }, { idem: "nb-3" });
    refused(addBefore, "/ops/0/before");
    nothingStored(w, setBase, removeKey, addBefore);
  });

  it("a temp id, a property a set would create, or a before index that reads as a phone number is 422 before the store is read", async () => {
    const w = await world();
    const value = { _class: "Note", gramps_id: "", private: false, text: { _class: "StyledText", string: "x", tags: [] }, format: 0, type: typ("NoteType", 1) };
    const temp = await w.post(ME, { base_versions: versions(w, [w.me]), ops: [
      { id: "mk", op: "create", obj: "new:2125550143", cls: "Note", value },
      { id: "ln", op: "add", obj: key(w.me), path: "/note_list", value: "new:2125550143" },
    ] }, { idem: "st-1" });
    refused(temp, "/ops/0/obj");
    const prop = await w.post(ME, { base_versions: versions(w, [w.me]), ops: [
      { id: "a", op: "set", obj: key(w.me), path: "/primary_name/2125550143", base: null, value: "x" },
      { id: "b", op: "remove", obj: key(w.me), path: "/primary_name/2125550143", base: "x", seq: true },
    ] }, { idem: "st-2" });
    refused(prop, "/ops/0/path");
    const before = await w.post(ME, { base_versions: versions(w, [w.me]), ops: [{ id: "f", op: "add", obj: key(w.me), path: "/note_list", value: w.n2.handle, before: "2125550143" }] }, { idem: "st-3" });
    refused(before, "/ops/0/before");
    for (const r of [temp, prop, before]) expect(r.body.errors.every((e) => e.opId === null && e.obj === null)).toBe(true);
    nothingStored(w, temp, prop, before);
  });

  it("a field the op kind ignores, or a field of the wrong type, is 400 validation and never stored", async () => {
    const w = await world();
    const nick = set(w.me, "/primary_name/nick", "", "Ally", "a");
    const cases = {
      "sets without base_version": [{ ...nick, sets: [`call ${PHONE}`] }, "/ops/0/sets"],
      "sets with a word outside the five": [{ ...nick, base: undefined, base_version: 1, sets: [`call ${PHONE}`] }, "/ops/0/sets"],
      "cls on a stored record": [{ ...nick, cls: `call ${PHONE}` }, "/ops/0/cls"],
      "cls that is not the class of the create": [null, "/ops/1/cls"],
      "base_hash on a set": [{ ...nick, base_hash: `call ${PHONE}` }, "/ops/0/base_hash"],
      "before on a set": [{ ...nick, before: `@=${PHONE}` }, "/ops/0/before"],
      "value on a remove": [{ id: "r", op: "remove", obj: key(w.me), path: `/note_list/@=${w.n1.handle}`, base: w.n1.handle, value: PHONE }, "/ops/0/value"],
      "base and base_hash on a remove": [{ id: "r", op: "remove", obj: key(w.me), path: `/note_list/@=${w.n1.handle}`, base: PHONE, base_hash: "0".repeat(64) }, "/ops/0/base"],
      "base and base_version on a set": [{ ...nick, base_version: 1 }, "/ops/0/base"],
      "a base_version that is not a version": [{ ...nick, base: undefined, base_version: PHONE }, "/ops/0/base_version"],
      "a seq that is not a boolean": [{ ...nick, seq: PHONE }, "/ops/0/seq"],
      "a path property that is not a Gramps field": [set(w.me, `/primary_name/call ${PHONE}`, null, "x", "a"), "/ops/0/path"],
      "a value key that is not a Gramps field": [set(w.me, "/primary_name", w.me.primary_name, { ...w.me.primary_name, [`call ${PHONE}`]: "x" }, "a"), "/ops/0/value"],
      "a before that is not a key": [{ id: "f", op: "add", obj: key(w.me), path: "/note_list", value: w.n2.handle, before: `call ${PHONE}` }, "/ops/0/before"],
    };
    const note = { _class: "Note", gramps_id: "", private: false, text: { _class: "StyledText", string: "x", tags: [] }, format: 0, type: typ("NoteType", 1) };
    let n = 0;
    for (const [name, [op, pointer]] of Object.entries(cases)) {
      const ops = op ? [JSON.parse(JSON.stringify(op))] : [{ id: "mk", op: "create", obj: "new:1", cls: "Note", value: note }, { id: "ed", op: "set", obj: "new:1", cls: "Event", path: "/format", base: 0, value: 1 }];
      const r = await w.post(ME, { base_versions: versions(w, [w.me]), ops }, { idem: `if-${++n}` });
      expect(err(r), name).toEqual({ status: 400, error: "validation" });
      expect(r.body.errors.map((e) => e.pointer), name).toContain(pointer);
      nothingStored(w, r);
    }
  });

  it("clearing a stored phone number is allowed: a clean op's base is the stored value, not new text", async () => {
    const w = await world();
    await w.bump({ ...w.me, primary_name: { ...w.me.primary_name, nick: PHONE } }, 1);
    w.txns.length = 0;
    const r = await w.post(ME, { base_versions: { [key(w.me)]: 2 }, ops: [set(w.me, "/primary_name/nick", PHONE, "")] }, { idem: "cl-1" });
    expect(r.status).toBe(201);
    expect(r.body.applied.versions).toEqual({ [key(w.me)]: 3 });
  });

  it("a reduced Date set (base_version with sets) passes the shape checks", async () => {
    const ev = event(8, 13, [0, 0, 1950, false]);
    const w = await world({ seedExtra: [ev] });
    const r = await w.post(ADMIN, { base_versions: { [key(ev)]: 1 }, dry_run: true, ops: [{ id: "d", op: "set", obj: key(ev), path: "/date", base_version: 1, sets: ["day", "month"], value: date([14, 3, 1950, false]) }] });
    expect(r.status).toBe(200);
    expect(r.body.plan.direct).toHaveLength(1);
  });
});

describe("a destructive admin direct group needs a fresh sign-in (AC5)", () => {
  const authToken = async (sub, authTime) => {
    const key = await importPKCS8(pem, "RS256");
    return new SignJWT({ client_id: AUDIENCE, token_use: "access", name: sub, auth_time: authTime })
      .setProtectedHeader({ alg: "RS256", kid: "hfy-session-1" }).setSubject(sub).setIssuer(ISSUER).setAudience(AUDIENCE).setIssuedAt().setExpirationTime("1h").sign(key);
  };
  const unlink = (w) => [
    { id: "p", op: "remove", obj: key(w.me), path: `/family_list/@=${w.fam.handle}`, base: w.fam.handle },
    { id: "f", op: "set", obj: key(w.fam), path: "/father_handle", base: w.me.handle, value: null },
  ];
  it("401 step_up_required when auth_time is older than 900 s; the change is applied with a fresh sign-in", async () => {
    const w = await world();
    const now = Math.floor(Date.now() / 1000);
    const body = { target: key(w.me), base_versions: versions(w, [w.me, w.fam]), ops: unlink(w) };
    const stale = await w.post(ADMIN, body, { idem: "su-1", token: await authToken(ADMIN, now - 2000) });
    expect(err(stale)).toEqual({ status: 401, error: "step_up_required" });
    expect(stale.body.details).toEqual({ maxAgeSeconds: 900 });
    expect(w.txns).toEqual([]);
    const missing = await w.post(ADMIN, body, { idem: "su-2", token: await authToken(ADMIN, 0) });
    expect(err(missing)).toEqual({ status: 401, error: "step_up_required" });
    // a token with no auth_time claim has a fresh iat but no known sign-in: stale (the principal's iat fallback must not count)
    const iatOnly = await w.post(ADMIN, body, { idem: "su-2b", token: await authToken(ADMIN, undefined) });
    expect(err(iatOnly)).toEqual({ status: 401, error: "step_up_required" });
    expect(w.txns).toEqual([]);
    const fresh = await w.post(ADMIN, body, { idem: "su-3", token: await authToken(ADMIN, now - 120) });
    expect(fresh.status).toBe(201);
    expect(fresh.body.applied.versions).toEqual({ [key(w.me)]: 2, [key(w.fam)]: 2 });
    expect(w.afters).toHaveLength(1);
    expect(w.afters[0].origin).toBe("admin");
  });
  it("a non-destructive admin change needs no fresh sign-in", async () => {
    const w = await world();
    const old = await authToken(ADMIN, Math.floor(Date.now() / 1000) - 5000);
    const r = await w.post(ADMIN, { base_versions: versions(w, [w.me]), ops: [set(w.me, "/primary_name/nick", "", "Ally")] }, { idem: "su-4", token: old });
    expect(r.status).toBe(201);
  });
  it("a destructive change that goes to review (a member's suggestion) needs none here", async () => {
    const w = await world();
    const r = await w.post(OTHER, { target: key(w.me), base_versions: versions(w, [w.me, w.fam]), ops: unlink(w) }, { idem: "su-5" });
    expect(r.status).toBe(201);
    expect(r.body.applied).toBeNull();
  });
  it("isDestructive follows the DEC-E9 definition", () => {
    const fam = family(1, { father_handle: h(1), child_ref_list: [{ _class: "ChildRef", ref: h(3) }] });
    const p = person(1, { family_list: [fam.handle], parent_family_list: [h(1009)] });
    const none = { created: [], updated: [], deleted: [] };
    expect(isDestructive({}, {}, { ...none, deleted: ["Event:x"] })).toBe(true);
    expect(isDestructive({ a: p }, { a: { ...p, family_list: [] } }, { ...none, updated: ["a"] })).toBe(true);
    expect(isDestructive({ a: p }, { a: { ...p, parent_family_list: [] } }, { ...none, updated: ["a"] })).toBe(true);
    expect(isDestructive({ a: p }, { a: { ...p, family_list: [...p.family_list, "z"] } }, { ...none, updated: ["a"] })).toBe(false);
    expect(isDestructive({ f: fam }, { f: { ...fam, father_handle: null } }, { ...none, updated: ["f"] })).toBe(true);
    expect(isDestructive({ f: fam }, { f: { ...fam, mother_handle: h(8) } }, { ...none, updated: ["f"] })).toBe(false);
    expect(isDestructive({ f: fam }, { f: { ...fam, child_ref_list: [] } }, { ...none, updated: ["f"] })).toBe(true);
  });
});

describe("the route (AC6)", () => {
  it("is in caps and the registry, behind HFY_EDITING, with no MCP tool", async () => {
    expect(buildCaps().actions.find((a) => a.name === "changes.post")).toMatchObject({ method: "POST", path: "/api/changes", write: true, gate: { switch: "HFY_EDITING" } });
    expect(ROUTES.find((r) => r.name === "changes.post").mcp).toBeUndefined();
    const w = await world();
    process.env.HFY_EDITING = "off";
    const r = await w.post(ADMIN, { base_versions: {}, ops: [] }, { idem: "x" });
    expect(err(r)).toEqual({ status: 404, error: "not_found" });
  });
  it("needs a session and a JSON body", async () => {
    const w = await world();
    expect((await w.call("POST", "/api/changes", { body: {} })).status).toBe(401);
    const r = await w.call("POST", "/api/changes", { token: await signToken(ME), body: {}, ct: "text/plain" });
    expect(r.status).toBe(415);
  });
  it("hashObject stays the content hash the engine uses", () => {
    expect(hashObject({ a: 1, change: 5 })).toBe(hashObject({ a: 1, change: 9 }));
  });
});
