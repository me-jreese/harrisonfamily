// HFY-TSK-184 (proposal-store-api): the proposal routes, visibility, stale-on-read, system proposals and proposal-thread comments.
// In-memory DynamoDB fake, synthetic ids, names and dates only.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryNotificationStore } from "@io-kit/notify/server";
import { cmds, makeApi, signToken, TABLE } from "./world.js";
import { applyBatch } from "../src/sync/apply.js";
import { createHookRegistry } from "../src/sync/hooks.js";
import { headKey } from "../src/sync/store.js";
import { buildCaps, ROUTES } from "../src/routes.js";
import { SYSTEM_PROPOSER, approvalHookFragment, newProposal, proposalPuts, proposalEtag, withState } from "../src/records/proposals.js";
import { createSystem } from "../src/records/proposal-store.js";
import { SUBJECT_RE } from "../src/comments.js";

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
const THIRD = "I0003";
const ADMIN = "I0099";
const ADMIN2 = "I0098";
const q = { warn() {}, error() {} };
const key = (obj) => `${obj._class}:${obj.handle}`;
const set = (o, path, base, value, id) => ({ ...(id ? { id } : {}), op: "set", obj: key(o), path, base, value });

let envBefore;
beforeEach(() => { envBefore = process.env.HFY_EDITING; process.env.HFY_EDITING = "on"; });
afterEach(() => { if (envBefore === undefined) delete process.env.HFY_EDITING; else process.env.HFY_EDITING = envBefore; });

async function world({ clock = () => Date.now(), admins = [ADMIN, ADMIN2], seedExtra = [], guardDob } = {}) {
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
  const me = person(1, { family_list: [fam.handle], note_list: [n1.handle] });
  const other = person(2, { note_list: [n2.handle] });
  const third = person(3);
  await seed([me, other, third, n1, n2, fam, ...seedExtra]);
  const bump = (obj, base) => applyBatch(sctx, { principal: "svc-seed", origin: "desktop", idempotencyKey: `bump${++k}`, ops: [{ op: "update", class: obj._class, handle: obj.handle, base_version: base, obj }] });
  txns.length = 0;
  afters.length = 0;
  contributed.length = 0;
  const post = async (who, body, { idem, headers = {}, token } = {}) =>
    w.call("POST", "/api/changes", { token: token ?? (await signToken(who)), body, headers: { ...(idem ? { "idempotency-key": idem } : {}), ...headers } });
  const rows = (prefix) => w.ddb.all().filter((r) => r.PK.startsWith(prefix));
  const call = async (method, path, who, { body, query, ifMatch } = {}) =>
    w.call(method, path, { token: await signToken(who), ...(body !== undefined ? { body } : {}), ...(query ? { query } : {}), headers: ifMatch !== undefined ? { "if-match": ifMatch } : {} });
  const getP = (who, id) => call("GET", `/api/proposals/${id}`, who);
  const patch = (who, id, body, ifMatch) => call("PATCH", `/api/proposals/${id}`, who, { body, ifMatch });
  const withdraw = (who, id, ifMatch) => call("POST", `/api/proposals/${id}/withdraw`, who, { body: {}, ifMatch });
  const list = (who, query) => call("GET", "/api/proposals", who, { query });
  /** A proposal by `who` on a person's given name through POST /api/changes. */
  const propose = async (who, target, to, idem) => {
    const r = await post(who, { target: key(target), base_versions: versions(null, [target]), ops: [set(target, "/primary_name/first_name", "Alder", to)] }, { idem });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.proposal;
  };
  return { ...w, post, rows, txns, race, afters, contributed, inbox, me, other, third, n1, n2, fam, seed, bump, hooks, sctx, call, getP, patch, withdraw, list, propose };
}
const versions = (_w, objs) => Object.fromEntries(objs.map((o) => [key(o), 1]));
const writes = (w) => w.ddb.calls.filter((c) => /^(Put|Update|Delete|TransactWrite)Command$/.test(c)).length;
const err = (r) => ({ status: r.status, error: r.body?.error });

const propRows = (w, id) => w.ddb.all().filter((r) => r.PK === `PROP#${id}`);
const bump = async (w, obj, base, extra) => w.bump({ ...obj, ...extra }, base);

describe("visibility (AC1)", () => {
  it("the proposer, any admin and a member whose own Person is targeted can GET; every other member gets 404", async () => {
    const w = await world();
    const p = await w.propose(OTHER, w.me, "Aldric", "v-1"); // OTHER suggests a change to ME's page
    expect((await w.getP(OTHER, p.id)).status).toBe(200); // the proposer
    expect((await w.getP(ADMIN, p.id)).status).toBe(200); // any admin
    expect((await w.getP(ADMIN2, p.id)).status).toBe(200);
    const mine = await w.getP(ME, p.id); // the page's own member
    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({ id: p.id, state: "pending", rev: 1, can: { amend: false, withdraw: false, decide: false } });
    const hidden = await w.getP(THIRD, p.id); // everyone else
    expect(err(hidden)).toEqual({ status: 404, error: "not_found" });
    expect(err(await w.getP(THIRD, "01J00000000000000000000000"))).toEqual({ status: 404, error: "not_found" }); // the same answer as an unknown id
    expect(err(await w.getP(THIRD, "not-an-id"))).toEqual({ status: 404, error: "not_found" });
  });
  it("a member in a targeted Family sees it, and owners[] lists the gramps ids of the owners of every targeted page", async () => {
    const w = await world();
    const doc = newProposal({
      id: "01J00000000000000000000001", actor: { id: OTHER, label: "Other" }, origin: "web", kind: "edit", subject: null, targets: [key(w.fam)], base_versions: { [key(w.fam)]: 1 },
      ops: [{ id: "o1", op: "set", obj: key(w.fam), path: "/private", base: false, value: true }], summary: [], warnings: [], at: "2026-10-14T00:00:00.000Z", owners: [ME],
    });
    for (const x of proposalPuts(doc)) await w.ddb.send(new cmds.PutCommand({ TableName: TABLE, Item: x.item }));
    expect((await w.getP(ME, doc.id)).status).toBe(200); // the Family's father
    expect(err(await w.getP(THIRD, doc.id))).toEqual({ status: 404, error: "not_found" });
  });
  it("a submission writes owners[] (the person it is about) on the document", async () => {
    const w = await world();
    const p = await w.propose(OTHER, w.me, "Aldric", "v-2");
    expect(p.owners).toEqual([ME]);
    const stored = propRows(w, p.id).find((r) => r.SK === "META");
    expect(stored.proposal.owners).toEqual([ME]);
  });
  it("view=queue is 403 for a non-admin; mine lists only the caller's; about-me lists suggestions about the caller's page", async () => {
    const w = await world();
    const a = await w.propose(OTHER, w.me, "Aldric", "q-1");
    const b = await w.propose(THIRD, w.other, "Aldwin", "q-2");
    const c = await w.propose(ME, w.me, "Alden", "q-3");
    expect(err(await w.list(ME, { view: "queue" }))).toEqual({ status: 403, error: "not_admin" });
    const q = await w.list(ADMIN, { view: "queue" });
    expect(q.body.items.map((x) => x.id)).toEqual([a.id, b.id, c.id]); // oldest first
    expect((await w.list(OTHER, { view: "mine" })).body.items.map((x) => x.id)).toEqual([a.id]);
    expect((await w.list(ME, { view: "mine" })).body.items.map((x) => x.id)).toEqual([c.id]);
    expect((await w.list(ME, { view: "about-me" })).body.items.map((x) => x.id)).toEqual([c.id, a.id]); // newest first; b is about someone else
    expect((await w.list(THIRD, { view: "about-me" })).body.items).toEqual([]);
    expect((await w.list(THIRD, { view: "mine" })).body.items.map((x) => x.id)).toEqual([b.id]);
    expect((await w.list(ADMIN, { view: "mine" })).body.items).toEqual([]);
    expect(err(await w.list(ME, { view: "everyone" })).status).toBe(400);
    expect(err(await w.list(ME, { view: "mine", state: "bogus" })).status).toBe(400);
  });
  it("pages with a cursor, and the queue takes state=", async () => {
    const w = await world();
    const ids = [];
    for (let i = 0; i < 3; i += 1) ids.push((await w.propose(OTHER, w.me, `Name${i}`, `pg-${i}`)).id);
    const first = await w.list(ADMIN, { view: "queue", limit: "2" });
    expect(first.body.items.map((x) => x.id)).toEqual(ids.slice(0, 2));
    expect(first.body.cursor).toBeTruthy();
    const second = await w.list(ADMIN, { view: "queue", limit: "2", cursor: first.body.cursor });
    expect(second.body.items.map((x) => x.id)).toEqual(ids.slice(2));
    expect(second.body.cursor).toBeUndefined();
    expect(err(await w.list(ADMIN, { view: "mine", cursor: first.body.cursor })).status).toBe(400); // a cursor belongs to its view
    expect((await w.list(ADMIN, { view: "queue", state: "approved" })).body.items).toEqual([]);
    expect(err(await w.list(ADMIN, { view: "queue", limit: "0" })).status).toBe(400);
  });
});

describe("amend (AC2)", () => {
  it("a matching If-Match increments rev, changes the etag and sets state pending", async () => {
    const w = await world();
    const p = await w.propose(ME, w.me, "Aldric", "a-1");
    const r = await w.patch(ME, p.id, { base_versions: versions(w, [w.me]), note: "better spelling", ops: [set(w.me, "/primary_name/first_name", "Alder", "Aldrich", "first")] }, p.etag);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ id: p.id, rev: 2, state: "pending", note: "better spelling", stale: false, can: { amend: true, withdraw: true } });
    expect(r.body.etag).not.toBe(p.etag);
    expect(r.body.ops[0].value).toBe("Aldrich");
    expect(r.headers.etag).toBe(`"${r.body.etag}"`);
    expect((await w.getP(ME, p.id)).body.etag).toBe(r.body.etag);
    expect((await w.getP(ME, p.id)).headers.etag).toBe(`"${r.body.etag}"`);
  });
  it("accepts a quoted If-Match and an amend from needs_changes", async () => {
    const w = await world();
    const p = await w.propose(ME, w.me, "Aldric", "a-2");
    const moved = withState(p, "needs_changes", "2026-10-14T01:00:00.000Z");
    await rewriteAll(w, p, moved);
    const r = await w.patch(ME, p.id, { base_versions: versions(w, [w.me]), ops: [set(w.me, "/primary_name/first_name", "Alder", "Aldwyn")] }, `"${moved.etag}"`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ rev: 2, state: "pending" });
    expect(propRows(w, p.id).find((x) => x.SK === "META").GSI1PK).toBe("PROPQ#pending");
  });
  it("a stale If-Match is 412 precondition_failed with the fresh view; a missing one is 428", async () => {
    const w = await world();
    const p = await w.propose(ME, w.me, "Aldric", "a-3");
    const ok = await w.patch(ME, p.id, { base_versions: versions(w, [w.me]), ops: [set(w.me, "/primary_name/first_name", "Alder", "Aldrich")] }, p.etag);
    expect(ok.status).toBe(200);
    const stale = await w.patch(ME, p.id, { base_versions: versions(w, [w.me]), ops: [set(w.me, "/primary_name/first_name", "Alder", "Aldo")] }, p.etag);
    expect(err(stale)).toEqual({ status: 412, error: "precondition_failed" });
    expect(stale.body.details.proposal).toMatchObject({ id: p.id, rev: 2, etag: ok.body.etag, state: "pending" });
    expect(propRows(w, p.id).find((x) => x.SK === "META").proposal.ops[0].value).toBe("Aldrich"); // nothing was written
    expect(err(await w.patch(ME, p.id, { base_versions: versions(w, [w.me]), ops: [set(w.me, "/primary_name/first_name", "Alder", "Aldo")] }))).toEqual({ status: 428, error: "precondition_required" });
  });
  it("a decided or withdrawn proposal is 409 not_amendable, and only the proposer amends (403); a hidden one is 404", async () => {
    const w = await world();
    const p = await w.propose(OTHER, w.me, "Aldric", "a-4");
    const body = { base_versions: versions(w, [w.me]), ops: [set(w.me, "/primary_name/first_name", "Alder", "Aldrich")] };
    expect(err(await w.patch(ME, p.id, body, p.etag))).toEqual({ status: 403, error: "not_allowed" }); // the page's owner sees it but did not make it
    expect(err(await w.patch(ADMIN, p.id, body, p.etag))).toEqual({ status: 403, error: "not_allowed" });
    expect(err(await w.patch(THIRD, p.id, body, p.etag))).toEqual({ status: 404, error: "not_found" });
    for (const state of ["approved", "declined", "withdrawn", "superseded"]) {
      const q = await w.propose(OTHER, w.me, `N${state}`, `a-4-${state}`);
      const done = withState(q, state, "2026-10-14T02:00:00.000Z");
      await rewriteAll(w, q, done);
      const r = await w.patch(OTHER, q.id, body, done.etag);
      expect(err(r), state).toEqual({ status: 409, error: "not_amendable" });
    }
  });
  it("an amend that drops a target deletes its IDX#REC copy", async () => {
    const w = await world();
    const r1 = await w.post(OTHER, {
      target: key(w.me), base_versions: { ...versions(w, [w.me]), [key(w.other)]: 1 },
      ops: [set(w.me, "/primary_name/first_name", "Alder", "Aldric", "a"), set(w.other, "/primary_name/first_name", "Alder", "Aldwin", "b")],
    }, { idem: "dt-1" });
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    const p = r1.body.proposal;
    expect(propRows(w, p.id).map((r) => r.SK).sort()).toEqual([`IDX#BY`, `IDX#REC#${key(w.me)}`, `IDX#REC#${key(w.other)}`, "META"].sort());
    const r = await w.patch(OTHER, p.id, { base_versions: versions(w, [w.me]), ops: [set(w.me, "/primary_name/first_name", "Alder", "Aldric", "a")] }, p.etag);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(propRows(w, p.id).map((x) => x.SK).sort()).toEqual([`IDX#BY`, `IDX#REC#${key(w.me)}`, "META"].sort());
    expect(r.body.targets).toEqual([key(w.me)]);
  });
});

/** Rewrites META and the copies of `prev` to `next` the way a decision would (a test seam: the decision route is proposal-decision-api's). */
async function rewriteAll(w, prev, next) {
  for (const row of propRows(w, prev.id)) {
    const item = { ...row, proposal: next, ...(row.SK === "META" ? { GSI1PK: `PROPQ#${next.state}` } : {}) };
    await w.ddb.send(new cmds.PutCommand({ TableName: TABLE, Item: item }));
  }
}

describe("every state change rewrites META and every IDX# copy in one transaction (AC3)", () => {
  const sameState = (w, id, state) => {
    const rows = propRows(w, id).filter((r) => r.SK === "META" || r.SK.startsWith("IDX#"));
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const r of rows) expect(r.proposal.state, r.SK).toBe(state);
    return rows;
  };
  it("withdraw moves GSI1PK from PROPQ#pending to PROPQ#withdrawn and updates IDX#BY and IDX#REC together, with one audit item", async () => {
    const w = await world();
    const p = await w.propose(ME, w.me, "Aldric", "w-1");
    expect(propRows(w, p.id).find((r) => r.SK === "META").GSI1PK).toBe("PROPQ#pending");
    w.txns.length = 0;
    const r = await w.withdraw(ME, p.id, p.etag);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ state: "withdrawn", can: { amend: false, withdraw: false } });
    expect(r.body.etag).not.toBe(p.etag);
    const rows = sameState(w, p.id, "withdrawn");
    expect(rows.find((x) => x.SK === "META").GSI1PK).toBe("PROPQ#withdrawn");
    expect(w.txns).toHaveLength(1); // one transaction
    const pks = w.txns[0].TransactItems.map((i) => (i.Put ?? i.Delete).Item?.PK ?? (i.Put ?? i.Delete).Key?.PK);
    expect(pks.filter((x) => x === `PROP#${p.id}`)).toHaveLength(3); // META, IDX#BY, IDX#REC#Person
    expect(pks.filter((x) => x.startsWith("AUDIT#proposal:"))).toHaveLength(1);
    const audit = w.ddb.all().filter((x) => x.PK === `AUDIT#proposal:${p.id}`);
    expect(audit.map((x) => x.op).sort()).toEqual(["proposal.create", "proposal.withdraw"]);
    expect((await w.list(ADMIN, { view: "queue" })).body.items).toEqual([]);
    expect((await w.list(ADMIN, { view: "queue", state: "withdrawn" })).body.items.map((x) => x.id)).toEqual([p.id]);
  });
  it("withdraw: only the proposer (403), only an open one (409), If-Match required (428) and checked (412)", async () => {
    const w = await world();
    const p = await w.propose(OTHER, w.me, "Aldric", "w-2");
    expect(err(await w.withdraw(ME, p.id, p.etag))).toEqual({ status: 403, error: "not_allowed" });
    expect(err(await w.withdraw(THIRD, p.id, p.etag))).toEqual({ status: 404, error: "not_found" });
    expect(err(await w.withdraw(OTHER, p.id))).toEqual({ status: 428, error: "precondition_required" });
    expect(err(await w.withdraw(OTHER, p.id, "deadbeef"))).toEqual({ status: 412, error: "precondition_failed" });
    expect((await w.withdraw(OTHER, p.id, p.etag)).status).toBe(200);
    expect(err(await w.withdraw(OTHER, p.id, p.etag))).toEqual({ status: 409, error: "invalid_state" });
  });
  it("a race on the etag cancels the write: the loser gets 412 with the winner's view and nothing is half written", async () => {
    const w = await world();
    const p = await w.propose(ME, w.me, "Aldric", "w-3");
    w.race.before = async () => {
      const winner = await w.withdraw(ME, p.id, p.etag);
      expect(winner.status).toBe(200);
    };
    const r = await w.patch(ME, p.id, { base_versions: versions(w, [w.me]), ops: [set(w.me, "/primary_name/first_name", "Alder", "Aldrich")] }, p.etag);
    expect(err(r)).toEqual({ status: 412, error: "precondition_failed" });
    expect(r.body.details.proposal.state).toBe("withdrawn");
    sameState(w, p.id, "withdrawn");
  });
});

describe("stale-on-read", () => {
  it("GET and the lists return stale=true once a base_version is behind the store, and stale=false before", async () => {
    const w = await world();
    const p = await w.propose(ME, w.me, "Aldric", "s-1");
    expect((await w.getP(ME, p.id)).body.stale).toBe(false);
    expect((await w.list(ADMIN, { view: "queue" })).body.items[0].stale).toBe(false);
    const r = await bump(w, w.me, 1, { private: true });
    expect(r.ok ?? true).toBeTruthy();
    expect((await w.getP(ME, p.id)).body.stale).toBe(true);
    expect((await w.getP(ADMIN, p.id)).body.rebase.status).toMatch(/clean|conflict/);
    expect((await w.list(ADMIN, { view: "queue" })).body.items[0].stale).toBe(true);
    expect((await w.list(ME, { view: "mine" })).body.items[0].stale).toBe(true);
  });
  it("a decided proposal is not stale; the rebase block says current while the page has not moved", async () => {
    const w = await world();
    const p = await w.propose(ME, w.me, "Aldric", "s-2");
    expect((await w.getP(ME, p.id)).body.rebase).toEqual({ status: "current", conflicts: [] });
    await bump(w, w.me, 1, { private: true });
    const done = withState(p, "approved", "2026-10-14T03:00:00.000Z");
    await rewriteAll(w, p, done);
    const g = await w.getP(ME, p.id);
    expect(g.body.stale).toBe(false);
    expect(g.body.rebase).toEqual({ status: "current", conflicts: [] });
  });
  it("a conflicting rebase shows the stored values to an admin and only where it is to anyone else", async () => {
    const w = await world();
    const p = await w.propose(ME, w.me, "Aldric", "s-3");
    const moved = { ...w.me, primary_name: { ...w.me.primary_name, first_name: "Aldous" } };
    await w.bump(moved, 1);
    const admin = (await w.getP(ADMIN, p.id)).body.rebase;
    expect(admin.status).toBe("conflict");
    expect(admin.conflicts[0]).toMatchObject({ obj: key(w.me), reason: expect.any(String), current: "Aldous", proposed: "Aldric" });
    const member = (await w.getP(ME, p.id)).body.rebase;
    expect(member.status).toBe("conflict");
    expect(member.conflicts[0]).not.toHaveProperty("current");
    expect(member.conflicts[0]).not.toHaveProperty("base");
  });
});

describe("the guard runs on an amend before any PROP# write (AC6)", () => {
  it("a birth-like day or month is 422 dob_not_allowed with zero writes", async () => {
    const ev = event(5, 12, [0, 0, 1950, false]);
    const dead = person(5, { event_ref_list: [eref(ev)], birth_ref_index: 0, death_ref_index: -1 });
    const w = await world({ seedExtra: [dead, ev] });
    const first = await w.post(OTHER, { target: key(dead), base_versions: versions(w, [dead]), ops: [set(dead, "/primary_name/first_name", "Alder", "Aldwin", "n")] }, { idem: "g-1" });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const p = first.body.proposal;
    const before = JSON.stringify(propRows(w, p.id));
    const rowsBefore = w.ddb.all().length;
    w.txns.length = 0;
    const r = await w.patch(OTHER, p.id, {
      base_versions: { [key(dead)]: 1, [key(ev)]: 1 },
      ops: [set(dead, "/primary_name/first_name", "Alder", "Aldwin", "n"), { id: "d", op: "set", obj: key(ev), path: "/date", base: ev.date, value: date([14, 3, 1950, false]) }],
    }, p.etag);
    expect(r.status).toBe(422);
    expect(r.body.error).toBe("dob_not_allowed");
    expect(r.body.errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(r.body)).not.toContain("1950-03");
    expect(w.txns).toEqual([]); // zero writes
    expect(w.ddb.all().length).toBe(rowsBefore);
    expect(JSON.stringify(propRows(w, p.id))).toBe(before);
  });
  it("a phone number in the amended note or a value is 422 contact_info with zero writes", async () => {
    const w = await world();
    const p = await w.propose(ME, w.me, "Aldric", "g-2");
    w.txns.length = 0;
    const a = await w.patch(ME, p.id, { base_versions: versions(w, [w.me]), note: "call 212-555-0143", ops: [set(w.me, "/primary_name/first_name", "Alder", "Aldrich")] }, p.etag);
    expect(err(a)).toEqual({ status: 422, error: "contact_info" });
    const b = await w.patch(ME, p.id, { base_versions: versions(w, [w.me]), ops: [set(w.me, "/primary_name/first_name", "Alder", "212-555-0143")] }, p.etag);
    expect(err(b)).toEqual({ status: 422, error: "contact_info" });
    expect(w.txns).toEqual([]);
  });
  it("an amend refuses unknown body fields, stale ops (409) and an empty change (400), and is dark without HFY_EDITING (404)", async () => {
    const w = await world();
    const p = await w.propose(ME, w.me, "Aldric", "g-3");
    const ops = [set(w.me, "/primary_name/first_name", "Alder", "Aldrich")];
    expect(err(await w.patch(ME, p.id, { base_versions: versions(w, [w.me]), ops, state: "approved" }, p.etag)).status).toBe(400);
    expect(err(await w.patch(ME, p.id, { base_versions: versions(w, [w.me]), ops: [set(w.me, "/primary_name/first_name", "Nobody", "X")] }, p.etag)).status).toBe(409);
    expect(err(await w.patch(ME, p.id, { base_versions: versions(w, [w.me]), ops: [set(w.me, "/primary_name/first_name", "Alder", "Alder")] }, p.etag)).status).toBe(400);
    process.env.HFY_EDITING = "off";
    expect(err(await w.getP(ME, p.id)).status).toBe(404);
    expect(err(await w.list(ADMIN, { view: "queue" })).status).toBe(404);
  });
});

/** The record-store context with a ULID-shaped uid (the production uid is a ULID; the seed context's "s1" is not). */
const sysCtx = (w) => {
  w.sysN ??= { n: 0 };
  return { ...w.sctx, uid: () => `01J${String(++w.sysN.n).padStart(23, "0")}` };
};

describe("system proposals (AC4)", () => {
  const noteValue = { _class: "Note", gramps_id: "", private: false, text: { _class: "StyledText", string: "A synthetic welcome note", tags: [] }, format: 0, type: typ("NoteType", 1) };
  const input = (extra = {}) => ({ kind: "create", origin: "access_request", requestId: "req-0001", ops: [{ id: "mk", op: "create", obj: "new:1", cls: "Note", value: noteValue }], ...extra });
  it("createSystem files a pending create proposal by the site, in the admin queue, and a repeat of the request id returns the first", async () => {
    const w = await world();
    const doc = await createSystem(sysCtx(w), input());
    expect(doc).toMatchObject({ state: "pending", rev: 1, kind: "create", origin: "access_request", request_id: "req-0001", proposer: { id: SYSTEM_PROPOSER.id }, targets: [], owners: [] });
    expect(JSON.stringify(doc)).not.toMatch(/@/);
    expect(propRows(w, doc.id).map((r) => r.SK).sort()).toEqual(["IDX#BY", "META"]);
    expect(propRows(w, doc.id).find((r) => r.SK === "META").GSI1PK).toBe("PROPQ#pending");
    const again = await createSystem(sysCtx(w), input());
    expect(again.id).toBe(doc.id);
    expect(w.ddb.all().filter((r) => r.SK === "META" && r.PK.startsWith("PROP#"))).toHaveLength(1);
    const q = await w.list(ADMIN, { view: "queue" });
    expect(q.body.items.map((x) => x.id)).toEqual([doc.id]);
    expect(q.body.items[0]).toMatchObject({ origin: "access_request", proposer: { label: "the site" }, can: { decide: true, amend: false } });
    expect(err(await w.getP(THIRD, doc.id)).status).toBe(404);
    expect((await w.getP(ADMIN, doc.id)).status).toBe(200);
    expect(w.ddb.all().filter((r) => r.PK === `AUDIT#proposal:${doc.id}`).map((r) => r.op)).toEqual(["proposal.create"]);
  });
  it("refuses a bad kind, origin, request id, a kind that disagrees with the ops, a different body for one request id, and contact text", async () => {
    const w = await world();
    await expect(createSystem(sysCtx(w), input({ kind: "person.create" }))).rejects.toMatchObject({ status: 400 });
    await expect(createSystem(sysCtx(w), input({ origin: "web" }))).rejects.toMatchObject({ status: 400 });
    await expect(createSystem(sysCtx(w), input({ requestId: "has space" }))).rejects.toMatchObject({ status: 400 });
    await expect(createSystem(sysCtx(w), input({ kind: "edit" }))).rejects.toMatchObject({ status: 400 });
    await createSystem(sysCtx(w), input());
    const other = { ...noteValue, text: { ...noteValue.text, string: "A different synthetic note" } };
    await expect(createSystem(sysCtx(w), input({ ops: [{ id: "mk", op: "create", obj: "new:1", cls: "Note", value: other }] }))).rejects.toMatchObject({ status: 422, code: "idempotency_mismatch" });
    const phone = { ...noteValue, text: { ...noteValue.text, string: "call 212-555-0143" } };
    await expect(createSystem(sysCtx(w), input({ requestId: "req-0002", ops: [{ id: "mk", op: "create", obj: "new:1", cls: "Note", value: phone }] }))).rejects.toMatchObject({ status: 422, code: "contact_info" });
    expect(w.ddb.all().filter((r) => r.SK === "META" && r.PK.startsWith("PROP#"))).toHaveLength(1);
  });
  it("an edit proposal targets the page, and its owners see it", async () => {
    const w = await world();
    const doc = await createSystem(sysCtx(w), { kind: "edit", origin: "access_request", requestId: "req-0003", base_versions: versions(w, [w.me]), ops: [set(w.me, "/primary_name/first_name", "Alder", "Aldric", "e")] });
    expect(doc).toMatchObject({ kind: "edit", targets: [key(w.me)], owners: [ME], subject: { gramps_id: ME } });
    expect((await w.getP(ME, doc.id)).status).toBe(200);
    expect((await w.list(ME, { view: "about-me" })).body.items.map((x) => x.id)).toEqual([doc.id]);
  });
  it("approving one calls the completeAccessRequest hook: its fragment joins the approval, and a flow with no hook adds nothing", async () => {
    const w = await world();
    const doc = await createSystem(sysCtx(w), input());
    const calls = [];
    const ctx = { ...w.sctx, completeAccessRequest: async (a) => { calls.push(a); return { puts: [{ item: { PK: `ACCESSREQ#${a.requestId}`, SK: "META", state: "active", sub: a.grampsId } }] }; } };
    const frag = await approvalHookFragment(ctx, doc, { grampsId: "I8000" });
    expect(frag.puts).toHaveLength(1);
    expect(calls).toEqual([{ requestId: "req-0001", proposal: doc, grampsId: "I8000" }]);
    expect(await approvalHookFragment(w.sctx, doc, { grampsId: "I8000" })).toBeNull();
    const web = await w.propose(ME, w.me, "Aldric", "h-1");
    expect(await approvalHookFragment(ctx, web, {})).toBeNull();
    expect(calls).toHaveLength(1);
  });
});

describe("comments on proposal threads (AC5)", () => {
  const as = (w, who, method, path, { body, query } = {}) => w.call(method, path, who, { body, query });

  it("SUBJECT_RE accepts proposal:<ulid> and nothing looser", () => {
    expect(SUBJECT_RE.test("proposal:01J00000000000000000000001")).toBe(true);
    for (const bad of ["proposal:", "proposal:abc", "proposal:01J0000000000000000000000I", "proposals:01J00000000000000000000001", "proposal:01J00000000000000000000001x"]) expect(SUBJECT_RE.test(bad), bad).toBe(false);
  });
  it("list, create and react are limited to the visibility set; anyone else gets 404", async () => {
    const w = await world();
    const p = await w.propose(OTHER, w.me, "Aldric", "c-1");
    const subject = `proposal:${p.id}`;
    const made = await as(w, ADMIN, "POST", "/api/comments", { body: { subject, body: "a question about the spelling" } });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    for (const who of [OTHER, ME, ADMIN2]) {
      const l = await as(w, who, "GET", "/api/comments", { query: { subject } });
      expect(l.status, who).toBe(200);
      expect(l.body.thread.comments).toHaveLength(1);
    }
    expect(err(await as(w, THIRD, "GET", "/api/comments", { query: { subject } }))).toEqual({ status: 404, error: "not_found" });
    expect(err(await as(w, THIRD, "POST", "/api/comments", { body: { subject, body: "hello" } }))).toEqual({ status: 404, error: "not_found" });
    expect(err(await as(w, THIRD, "POST", `/api/comments/${made.body.id}/react`, { body: { subject, emoji: "👍" } }))).toEqual({ status: 404, error: "not_found" });
    const r = await as(w, ME, "POST", `/api/comments/${made.body.id}/react`, { body: { subject, emoji: "👍" } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(w.ddb.all().filter((x) => x.PK === `THREAD#${subject}` && x.SK.startsWith("C#"))).toHaveLength(1); // the outsider wrote nothing
    // an unknown proposal is the same 404
    expect(err(await as(w, ADMIN, "GET", "/api/comments", { query: { subject: "proposal:01J00000000000000000000009" } })).status).toBe(404);
    expect(err(await as(w, ADMIN, "POST", "/api/comments", { body: { subject: "proposal:01J00000000000000000000009", body: "hi" } })).status).toBe(404);
  });
  it("the thread is dark while HFY_EDITING is off", async () => {
    const w = await world();
    const p = await w.propose(OTHER, w.me, "Aldric", "c-2");
    process.env.HFY_EDITING = "off";
    expect(err(await as(w, ADMIN, "GET", "/api/comments", { query: { subject: `proposal:${p.id}` } })).status).toBe(404);
  });
  it("the guard runs on a proposal-thread comment (R-18)", async () => {
    const w = await world();
    const p = await w.propose(OTHER, w.me, "Aldric", "c-3");
    const r = await as(w, ADMIN, "POST", "/api/comments", { body: { subject: `proposal:${p.id}`, body: "ring 212-555-0143" } });
    expect(r.status).toBe(422);
  });
  it("a reply notifies the proposer and links to the review page; a comment by the proposer reaches the admins who took part", async () => {
    const w = await world();
    const p = await w.propose(OTHER, w.me, "Aldric", "c-4");
    const first = await as(w, ADMIN, "POST", "/api/comments", { body: { subject: `proposal:${p.id}`, body: "could you confirm the spelling?" } });
    expect(first.status).toBe(201);
    const items = (await w.inbox.list(OTHER)).items.filter((i) => i.type !== "proposal_submitted");
    expect(items.map((i) => i.type)).toEqual(["comment_on_my_record"]); // the proposer is the thread's owner
    expect(items[0].navigate ?? items[0].href ?? items[0].url).toBe(`/me/review/?id=${p.id}`);
    const reply = await as(w, OTHER, "POST", "/api/comments", { body: { subject: `proposal:${p.id}`, body: "yes, that is right", parentId: first.body.id } });
    expect(reply.status).toBe(201);
    expect((await w.inbox.list(ADMIN)).items.map((i) => i.type)).toContain("reply_to_me");
  });
  it("a mention or reply never reaches someone outside the visibility set (PS-09)", async () => {
    const w = await world();
    const p = await w.propose(OTHER, w.me, "Aldric", "c-5");
    // THIRD is outside the set; mentioning them, and replying to a thread they once commented on, tell them nothing.
    await w.ddb.send(new cmds.PutCommand({
      TableName: TABLE,
      Item: { PK: `THREAD#proposal:${p.id}`, SK: "C#01J00000000000000000000002", GSI1PK: "COMMENTS", GSI1SK: "01J00000000000000000000002", entity: "comment", comment: { id: "01J00000000000000000000002", threadId: `proposal:${p.id}`, author: { id: THIRD, label: "Third" }, body: "earlier", created_at: "2026-10-14T00:00:00.000Z" } },
    }));
    const r = await as(w, ADMIN, "POST", "/api/comments", { body: { subject: `proposal:${p.id}`, body: `thanks @${THIRD} and @${ME}` } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await w.inbox.list(THIRD)).items).toEqual([]);
    expect(w.sent.filter((s) => JSON.stringify(s).includes(THIRD))).toEqual([]);
    expect((await w.inbox.list(ME)).items.map((i) => i.type)).toContain("mention"); // inside the set
  });
});

describe("the routes are registered (caps)", () => {
  it("lists the four proposal routes behind the editing gate, with no MCP tool", () => {
    const caps = buildCaps();
    const names = ["proposals.list", "proposals.get", "proposals.amend", "proposals.withdraw"];
    for (const n of names) {
      const a = caps.actions.find((x) => x.name === n);
      expect(a, n).toBeTruthy();
      expect(a.gate, n).toBeTruthy();
    }
    expect(names.every((n) => !ROUTES.find((r) => r.name === n).mcp)).toBe(true);
    expect(caps.subjects).toContain("proposal:<ulid>");
  });
});
