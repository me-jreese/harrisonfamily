// HFY-TSK-209 (proposal-decision-api): POST /api/proposals/:id/decision. In-memory DynamoDB fake, synthetic ids, names and dates only.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryNotificationStore } from "@io-kit/notify/server";
import { cmds, makeApi, signToken, TABLE } from "./world.js";
import { applyBatch } from "../src/sync/apply.js";
import { createHookRegistry } from "../src/sync/hooks.js";
import { headKey } from "../src/sync/store.js";
import { buildCaps, ROUTES } from "../src/routes.js";
import { registerRecordContributor } from "../src/record-contributor.js";
import { QUEUE_STATES, createSystem } from "../src/records/proposal-store.js";
import { DECIDABLE_STATES, GUARD_SYSTEM_REASON, grampsIdFor } from "../src/records/proposal-decision.js";
import { sha256Hex } from "../src/records/proposals.js";

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
const create = (obj) => ({ op: "create", class: obj._class, handle: obj.handle, base_version: null, obj });
const noteValue = (text) => ({ _class: "Note", gramps_id: "", private: false, text: { _class: "StyledText", string: text, tags: [] }, format: 0, type: typ("NoteType", 1) });

const personValue = () => { const { handle, ...rest } = person(7, { gramps_id: "" }); return rest; }; // eslint-disable-line no-unused-vars
const ME = "I0001";
const OTHER = "I0002";
const THIRD = "I0003";
const ADMIN = "I0099";
const ADMIN2 = "I0098";
const q = { warn() {}, error() {}, info() {} };
const key = (obj) => `${obj._class}:${obj.handle}`;
const set = (o, path, base, value, id) => ({ ...(id ? { id } : {}), op: "set", obj: key(o), path, base, value });
const err = (r) => ({ status: r.status, error: r.body?.error });

let envBefore;
beforeEach(() => { envBefore = process.env.HFY_EDITING; process.env.HFY_EDITING = "on"; });
afterEach(() => { if (envBefore === undefined) delete process.env.HFY_EDITING; else process.env.HFY_EDITING = envBefore; });

async function world({ admins = [ADMIN, ADMIN2], completeAccessRequest, inbox: inboxStore } = {}) {
  const NOW = Date.now();
  const clock = () => NOW;
  const txns = [];
  const race = { before: null };
  const afters = [];
  const hooks = createHookRegistry();
  hooks.registerAfterCommit((info) => { afters.push(info); });
  const inbox = inboxStore ?? new InMemoryNotificationStore();
  const w = makeApi({
    admins, log: q, clock, inbox, flags: { inboxV1: true },
    intercept: async (cmd) => {
      if (cmd.constructor.name !== "TransactWriteCommand") return;
      txns.push(structuredClone(cmd.input));
      if (race.before) { const fn = race.before; race.before = null; await fn(); } // another request commits just before this one does
    },
    extraDeps: { syncHooks: hooks, idPolicy: { mode: "mint" }, getAdmins: async () => new Set(admins), txnOpts: { sleep: async () => {} }, ...(completeAccessRequest ? { completeAccessRequest } : {}) },
  });
  registerRecordContributor({ ddb: w.ddb, cmds, table: TABLE, log: q }, hooks); // the real self_edit and tag contributor: an approval must add neither
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
  await seed([me, other, third, n1, n2, fam]);
  const bump = (obj, base) => applyBatch(sctx, { principal: "svc-seed", origin: "desktop", idempotencyKey: `bump${++k}`, ops: [{ op: "update", class: obj._class, handle: obj.handle, base_version: base, obj }] });
  txns.length = 0;
  afters.length = 0;
  /** A session token whose sign-in was 10 s ago; `authToken(who, null)` carries no auth_time claim at all. */
  const authToken = (who, ...rest) => signToken(who, { authTime: rest.length ? rest[0] ?? undefined : Math.floor(NOW / 1000) - 10 });
  const call = async (method, path, who, { body, query, headers = {}, token } = {}) =>
    w.call(method, path, { token: token ?? (await authToken(who)), ...(body !== undefined ? { body } : {}), ...(query ? { query } : {}), headers });
  const post = (who, body, idem, opts = {}) => call("POST", "/api/changes", who, { body, headers: idem ? { "idempotency-key": idem } : {}, ...opts });
  const getP = (who, id) => call("GET", `/api/proposals/${id}`, who);
  /** Decide `p` as `who`: If-Match is the etag unless `etag` says otherwise. */
  const decide = (who, p, body, { idem = `d-${p.id}-${body.verdict}`, etag = p.etag, token, headers = {} } = {}) =>
    call("POST", `/api/proposals/${p.id}/decision`, who, { body, token, headers: { ...(etag !== null ? { "if-match": `"${etag}"` } : {}), ...(idem !== null ? { "idempotency-key": idem } : {}), ...headers } });
  const rows = (prefix) => w.ddb.all().filter((r) => r.PK.startsWith(prefix));
  const propose = async (who, target, to, idem) => {
    const r = await post(who, { target: key(target), base_versions: { [key(target)]: 1 }, ops: [set(target, "/primary_name/first_name", "Alder", to)] }, idem);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.proposal;
  };
  const heads = (cls, handle) => JSON.parse(w.ddb.rows.get(`REC#${cls}#${handle}\u0000HEAD`).obj_json);
  const headRow = (cls, handle) => w.ddb.rows.get(`REC#${cls}#${handle}\u0000HEAD`);
  const stored = (id) => w.ddb.rows.get(`PROP#${id}\u0000META`);
  const events = (who) => w.ddb.all().filter((r) => r.PK === `CONTRIB#${who}` && r.SK.startsWith("E#"));
  const counter = (who) => w.ddb.rows.get(`CSTAT#person:${who}\u0000TOTAL`);
  const decisionTxn = () => txns.filter((x) => x.TransactItems.some((i) => i.Put?.Item?.PK?.startsWith("PROP#")));
  return { ...w, post, rows, txns, race, afters, inbox, me, other, third, n1, n2, fam, seed, bump, hooks, sctx, call, getP, decide, propose, heads, headRow, stored, events, counter, decisionTxn, authToken, NOW };
}

describe("approve with a clean rebase (AC1)", () => {
  it("commits the record ops, the proposal, its copies, the audit, the receipt and the proposer's credit in ONE TransactWrite, and decision.applied holds the new versions", async () => {
    const w = await world();
    const p = await w.propose(OTHER, w.me, "Aldric", "p-1");
    // the page moved on in a different field: the suggestion still applies (clean rebase)
    await w.bump({ ...w.me, primary_name: { ...w.me.primary_name, nick: "Ally" } }, 1);
    w.txns.length = 0;
    w.afters.length = 0;
    const r = await w.decide(ADMIN, p, { verdict: "approve" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.applied.versions).toEqual({ [key(w.me)]: 3 });
    expect(r.body.proposal).toMatchObject({ id: p.id, state: "approved", decision: { verdict: "approve", by: { id: ADMIN }, amended: false, applied: { [key(w.me)]: 3 } } });

    // the page: the proposer's change on top of the bumped nick
    expect(w.heads("Person", w.me.handle).primary_name).toMatchObject({ first_name: "Aldric", nick: "Ally" });
    expect(w.headRow("Person", w.me.handle).version).toBe(3);

    // exactly one TransactWrite, holding every part
    expect(w.txns).toHaveLength(1);
    const items = w.txns[0].TransactItems;
    const puts = items.filter((i) => i.Put).map((i) => i.Put.Item);
    expect(puts.some((x) => x.PK === `REC#Person#${w.me.handle}` && x.SK === "HEAD")).toBe(true); // the record op
    expect(puts.some((x) => x.PK === `PROP#${p.id}` && x.SK === "META" && x.GSI1PK === "PROPQ#approved")).toBe(true); // the proposal state change
    expect(puts.some((x) => x.PK === `PROP#${p.id}` && x.SK === "IDX#BY")).toBe(true); // the IDX copies
    expect(puts.some((x) => x.PK === `PROP#${p.id}` && x.SK === `IDX#REC#${key(w.me)}`)).toBe(true);
    expect(puts.some((x) => x.PK === `AUDIT#proposal:${p.id}` && x.op === "proposal.decide")).toBe(true); // the proposal audit
    expect(puts.some((x) => x.PK.startsWith("AUDIT#records:"))).toBe(true); // applyBatch's own audit
    expect(puts.some((x) => x.PK === `CONTRIB#${OTHER}` && x.kind === "proposal_accepted")).toBe(true); // contribOps, actor = the proposer
    const meta = items.find((i) => i.Put?.Item?.PK === `PROP#${p.id}` && i.Put.Item.SK === "META").Put;
    expect(meta.ConditionExpression).toContain("#p.#e = :etag"); // still the proposal that was read ...
    expect(meta.ConditionExpression).toContain("#p.#st = :st"); // ... and still in the state it was read in
    expect(JSON.stringify(meta.ExpressionAttributeValues)).toContain("pending");

    // every copy follows META
    for (const row of w.rows(`PROP#${p.id}`)) expect(row.proposal.state, row.SK).toBe("approved");
    expect(w.rows(`PROP#${p.id}`).find((x) => x.SK === "IDX#BY").GSI1PK).toBe(`PROPBY#${OTHER}`);
    const audit = w.rows(`AUDIT#proposal:${p.id}`).filter((x) => x.op === "proposal.decide");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ principal: ADMIN, before: { state: "pending" }, after: { state: "approved", amended: false } });

    // the credit goes to the PROPOSER, once, as a proposal_accepted; no self_edit and no tag op rides along (DL-18)
    expect(w.events(OTHER).map((e) => e.kind)).toEqual(["proposal_accepted"]);
    expect(w.events(ADMIN)).toEqual([]);
    expect(w.events(ME)).toEqual([]);
    expect(w.counter(OTHER)).toMatchObject({ n: 1, n_proposal_accepted: 1 });
    expect(w.counter(ADMIN)).toBeUndefined();
    expect(w.ddb.rows.get("CSTAT#site\u0000TOTAL")).toMatchObject({ n: 1, n_proposal_accepted: 1 });
  });

  it("the afterCommit hook fires exactly once per approval with origin proposal (spy)", async () => {
    const w = await world();
    const p = await w.propose(OTHER, w.me, "Aldric", "p-2");
    w.afters.length = 0;
    expect((await w.decide(ADMIN, p, { verdict: "approve" })).status).toBe(200);
    expect(w.afters).toHaveLength(1);
    expect(w.afters[0]).toMatchObject({ origin: "proposal" });
    // the same request replayed runs no second batch and no hook
    expect((await w.decide(ADMIN, p, { verdict: "approve" })).headers["idempotent-replayed"]).toBe("true");
    expect(w.afters).toHaveLength(1);
  });

  it("a retry of the same request (same key) replays the stored answer and credits nothing twice", async () => {
    const w = await world();
    const p = await w.propose(OTHER, w.me, "Aldric", "p-3");
    const first = await w.decide(ADMIN, p, { verdict: "approve" }, { idem: "same-key" });
    expect(first.status).toBe(200);
    w.txns.length = 0;
    const again = await w.decide(ADMIN, p, { verdict: "approve" }, { idem: "same-key" });
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(w.txns).toEqual([]);
    expect(w.counter(OTHER).n_proposal_accepted).toBe(1);
    // the same key with another body is 422
    expect(err(await w.decide(ADMIN, p, { verdict: "deny", reason: "no thanks" }, { idem: "same-key" }))).toEqual({ status: 422, error: "idempotency_mismatch" });
  });

  it("the proposer is told it was accepted; the commit does not depend on it (a failing producer never fails the decision)", async () => {
    const w = await world();
    const p = await w.propose(OTHER, w.me, "Aldric", "p-4");
    expect((await w.decide(ADMIN, p, { verdict: "approve" })).status).toBe(200);
    expect((await w.inbox.list(OTHER)).items.map((i) => i.type)).toEqual(["proposal_accepted"]);
    expect((await w.inbox.list(ADMIN)).items.map((i) => i.type)).not.toContain("proposal_accepted");

    const attempts = [];
    const broken = new Proxy(new InMemoryNotificationStore(), { get: (t, k) => (typeof t[k] === "function" ? async () => { attempts.push(String(k)); throw new Error("inbox is down"); } : t[k]) });
    const w2 = await world({ inbox: broken });
    const p2 = await w2.propose(OTHER, w2.me, "Aldwin", "p-5");
    const r = await w2.decide(ADMIN, p2, { verdict: "approve" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(w2.heads("Person", w2.me.handle).primary_name.first_name).toBe("Aldwin");
    expect(w2.stored(p2.id).proposal.state).toBe("approved");
    expect(attempts.length).toBeGreaterThan(0); // the producer did run, and failed
  });

  it("an approval whose ops are all applied already still decides the proposal and credits the proposer, in one transaction", async () => {
    const w = await world();
    const p = await w.propose(OTHER, w.me, "Aldric", "p-6");
    await w.bump({ ...w.me, primary_name: { ...w.me.primary_name, first_name: "Aldric" } }, 1); // somebody already made the same change
    w.txns.length = 0;
    const r = await w.decide(ADMIN, p, { verdict: "approve" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.applied.versions).toEqual({});
    expect(w.txns).toHaveLength(1);
    expect(w.headRow("Person", w.me.handle).version).toBe(2);
    expect(w.counter(OTHER).n_proposal_accepted).toBe(1);
  });
});

describe("two approvals of one proposal (AC1, AC3)", () => {
  it("another admin commits just before this one: this one is cancelled with 412 and the fresh view, and credits nothing", async () => {
    const w = await world();
    const p = await w.propose(OTHER, w.me, "Aldric", "c-1");
    w.race.before = async () => { expect((await w.decide(ADMIN2, p, { verdict: "approve" })).status).toBe(200); };
    const lost = await w.decide(ADMIN, p, { verdict: "approve" });
    expect(err(lost)).toEqual({ status: 412, error: "precondition_failed" });
    expect(lost.body.details.proposal).toMatchObject({ id: p.id, state: "approved", decision: { by: { id: ADMIN2 } } });
    expect(w.events(OTHER)).toHaveLength(1);
    expect(w.counter(OTHER).n_proposal_accepted).toBe(1);
    expect(w.headRow("Person", w.me.handle).version).toBe(2);
    expect(w.afters).toHaveLength(1);
    expect(w.rows(`AUDIT#proposal:${p.id}`).filter((x) => x.op === "proposal.decide")).toHaveLength(1);
  });

  it("two concurrent approves: exactly one 200 and the other 412", async () => {
    const w = await world();
    const p = await w.propose(OTHER, w.me, "Aldric", "c-2");
    const [a, b] = await Promise.all([w.decide(ADMIN, p, { verdict: "approve" }), w.decide(ADMIN2, p, { verdict: "approve" })]);
    expect([a.status, b.status].sort()).toEqual([200, 412]);
    expect(w.counter(OTHER).n_proposal_accepted).toBe(1);
    expect(w.events(OTHER)).toHaveLength(1);
    expect(w.headRow("Person", w.me.handle).version).toBe(2);
  });

  it("the same admin approving twice with different keys: one 200, then 412 or 409, never a second credit", async () => {
    const w = await world();
    const p = await w.propose(OTHER, w.me, "Aldric", "c-3");
    expect((await w.decide(ADMIN, p, { verdict: "approve" }, { idem: "k1" })).status).toBe(200);
    const second = await w.decide(ADMIN, p, { verdict: "approve" }, { idem: "k2" });
    expect(err(second)).toEqual({ status: 412, error: "precondition_failed" }); // the etag moved with the state
    expect(w.counter(OTHER).n_proposal_accepted).toBe(1);
  });

  it("a decided proposal read fresh is 409 invalid_state; a stale etag is 412", async () => {
    const w = await world();
    const p = await w.propose(OTHER, w.me, "Aldric", "c-4");
    const done = await w.decide(ADMIN, p, { verdict: "approve" });
    expect(err(await w.decide(ADMIN2, done.body.proposal, { verdict: "approve" }, { idem: "again" }))).toEqual({ status: 409, error: "invalid_state" });
    expect(err(await w.decide(ADMIN2, p, { verdict: "approve" }, { idem: "again2" })).status).toBe(412);
  });
});

describe("an overlapping change (AC2)", () => {
  it("409 rebase_conflict, state stale, a proposal.stale audit and the proposer told (proposal_stale)", async () => {
    const w = await world();
    const p = await w.propose(OTHER, w.me, "Aldric", "o-1");
    await w.bump({ ...w.me, primary_name: { ...w.me.primary_name, first_name: "Alden" } }, 1); // the same field, to another value
    w.txns.length = 0;
    const r = await w.decide(ADMIN, p, { verdict: "approve" });
    expect(err(r)).toEqual({ status: 409, error: "rebase_conflict" });
    expect(r.body.details.proposal).toMatchObject({ id: p.id, state: "stale" });
    expect(r.body.details.conflicts).toEqual([expect.objectContaining({ obj: key(w.me), path: "/primary_name/first_name", base: "Alder", current: "Alden", proposed: "Aldric" })]);
    expect(w.stored(p.id).proposal.state).toBe("stale");
    expect(w.stored(p.id).GSI1PK).toBe("PROPQ#stale");
    for (const row of w.rows(`PROP#${p.id}`)) expect(row.proposal.state, row.SK).toBe("stale");
    expect(w.rows(`AUDIT#proposal:${p.id}`).map((x) => x.op)).toContain("proposal.stale");
    expect(w.heads("Person", w.me.handle).primary_name.first_name).toBe("Alden"); // nothing was written to the page
    expect(w.events(OTHER)).toEqual([]);
    expect(w.afters).toEqual([]);
    expect((await w.inbox.list(OTHER)).items.map((i) => i.type)).toEqual(["proposal_stale"]);
    // the proposer can amend it back to pending; the admin can approve a stale proposal once it applies
    const again = await w.decide(ADMIN, r.body.details.proposal, { verdict: "approve" }, { idem: "o-1b" });
    expect(err(again)).toEqual({ status: 409, error: "rebase_conflict" });
    expect(w.rows(`AUDIT#proposal:${p.id}`).filter((x) => x.op === "proposal.stale")).toHaveLength(1); // a repeat adds no second stale audit
  });

  it("a relationship proposal whose read_versions moved is stale, though its ops apply cleanly", async () => {
    const w = await world();
    const p = await w.propose(OTHER, w.me, "Aldric", "o-3");
    const doc = { ...w.stored(p.id).proposal, read_versions: { [key(w.fam)]: 1 } }; // the family the decision was based on
    for (const row of w.rows(`PROP#${p.id}`)) w.ddb.rows.set(`${row.PK}\u0000${row.SK}`, { ...row, proposal: doc });
    await w.bump({ ...w.fam, private: true }, 1);
    const r = await w.decide(ADMIN, doc, { verdict: "approve" });
    expect(err(r)).toEqual({ status: 409, error: "rebase_conflict" });
    expect(r.body.details.conflicts).toEqual([{ opId: null, obj: key(w.fam), path: "", reason: "read_version_changed" }]);
    expect(w.stored(p.id).proposal.state).toBe("stale");
    expect(w.heads("Person", w.me.handle).primary_name.first_name).toBe("Alder");
  });

  it("a target removed from the store supersedes the proposal: the proposer is told, and the page is not touched", async () => {
    const w = await world();
    const ops = [{ id: "n", op: "set", obj: key(w.n2), path: "/text/string", base: "Synthetic note 2", value: "Edited synthetic note 2" }];
    const made = await w.post(ADMIN, { route: "review", base_versions: { [key(w.n2)]: 1 }, ops }, "o-2");
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const p = made.body.proposal;
    await applyBatch(w.sctx, { principal: "svc-seed", origin: "desktop", idempotencyKey: "gone", ops: [{ op: "delete", class: "Note", handle: w.n2.handle, base_version: 1 }] });
    const r = await w.decide(ADMIN2, p, { verdict: "approve" });
    expect(err(r)).toEqual({ status: 409, error: "rebase_conflict" });
    expect(r.body.details.proposal.state).toBe("superseded");
    expect(w.stored(p.id).proposal.state).toBe("superseded");
    expect(w.rows(`AUDIT#proposal:${p.id}`).map((x) => x.op)).toContain("proposal.supersede");
    expect(w.afters).toEqual([]);
  });
});

describe("a stale proposal stays in the admin queue (HFY-TSK-209 review)", () => {
  const queue = async (w, query = {}) => {
    const r = await w.call("GET", "/api/proposals", ADMIN, { query: { view: "queue", ...query } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.items;
  };
  const rename = (w) => w.bump({ ...w.me, primary_name: { ...w.me.primary_name, first_name: "Alden" } }, 1); // the same field, to another value
  const amendNow = { base_versions: { [`Person:${h(1)}`]: 2 }, ops: [{ id: "e1", op: "set", obj: `Person:${h(1)}`, path: "/primary_name/first_name", base: "Alden", value: "Aldric" }] };

  it("every state an admin can decide is a state the default queue shows", () => {
    for (const s of DECIDABLE_STATES) expect(QUEUE_STATES).toContain(s);
    expect(DECIDABLE_STATES).toContain("stale");
  });

  it("a member's proposal: after a 409 rebase_conflict it is still in the queue (and under state=stale), and an admin decides it from there", async () => {
    const w = await world();
    const p = await w.propose(OTHER, w.me, "Aldric", "sq-1");
    expect((await queue(w)).map((x) => [x.id, x.state])).toEqual([[p.id, "pending"]]);
    await rename(w);
    expect(err(await w.decide(ADMIN, p, { verdict: "approve" }))).toEqual({ status: 409, error: "rebase_conflict" });
    expect(w.stored(p.id).GSI1PK).toBe("PROPQ#stale");
    const listed = await queue(w);
    expect(listed.map((x) => [x.id, x.state, x.stale, x.can.decide])).toEqual([[p.id, "stale", true, true]]);
    expect((await queue(w, { state: "stale" })).map((x) => x.id)).toEqual([p.id]);
    // edit then approve, from the queue entry (its etag) with the version the admin reads now
    const ok = await w.decide(ADMIN2, listed[0], { verdict: "approve", amend: amendNow }, { idem: "sq-1b" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(w.heads("Person", w.me.handle).primary_name.first_name).toBe("Aldric");
    expect(await queue(w)).toEqual([]);
  });

  it("an access-request proposal: after a 409 rebase_conflict it is still in the queue, and approving it from there completes the request", async () => {
    const calls = [];
    const w = await world({ completeAccessRequest: async (a) => { calls.push({ requestId: a.requestId, grampsId: a.grampsId }); return { puts: [{ item: { PK: `ACCESSREQ#${a.requestId}`, SK: "META", state: "active", sub: a.grampsId } }] }; } });
    const sys = { ...w.sctx, uid: (() => { let n = 0; return () => `01J${String(++n).padStart(23, "0")}`; })() };
    const doc = await createSystem(sys, { kind: "edit", origin: "access_request", requestId: "req-0002", base_versions: { [key(w.me)]: 1 }, ops: [set(w.me, "/primary_name/first_name", "Alder", "Aldric", "e")] });
    expect((await queue(w)).map((x) => [x.id, x.state])).toEqual([[doc.id, "pending"]]);
    await rename(w);
    expect(err(await w.decide(ADMIN, doc, { verdict: "approve" }))).toEqual({ status: 409, error: "rebase_conflict" });
    expect(calls).toEqual([]);
    const listed = await queue(w);
    expect(listed.map((x) => [x.id, x.state, x.origin, x.request_id, x.can.decide])).toEqual([[doc.id, "stale", "access_request", "req-0002", true]]);
    expect((await queue(w, { state: "stale" })).map((x) => x.id)).toEqual([doc.id]);
    const ok = await w.decide(ADMIN2, listed[0], { verdict: "approve", amend: amendNow }, { idem: "sq-2b" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(calls).toEqual([{ requestId: "req-0002", grampsId: ME }]);
    expect(w.ddb.rows.get("ACCESSREQ#req-0002\u0000META")).toMatchObject({ state: "active", sub: ME });
    expect(await queue(w)).toEqual([]);
  });

  it("a relationship proposal moved to stale by its read_versions is still in the queue", async () => {
    const w = await world();
    const p = await w.propose(OTHER, w.me, "Aldric", "sq-3");
    const doc = { ...w.stored(p.id).proposal, read_versions: { [key(w.fam)]: 1 } };
    for (const row of w.rows(`PROP#${p.id}`)) w.ddb.rows.set(`${row.PK}\u0000${row.SK}`, { ...row, proposal: doc });
    await w.bump({ ...w.fam, private: true }, 1);
    expect(err(await w.decide(ADMIN, doc, { verdict: "approve" }))).toEqual({ status: 409, error: "rebase_conflict" });
    expect((await queue(w)).map((x) => [x.id, x.state])).toEqual([[p.id, "stale"]]);
    expect((await queue(w, { state: "stale" })).map((x) => x.id)).toEqual([p.id]);
  });
});

describe("the refusals (AC4)", () => {
  it("a non-admin is 403 not_admin and nothing is written", async () => {
    const w = await world();
    const p = await w.propose(OTHER, w.me, "Aldric", "r-1");
    w.txns.length = 0;
    for (const who of [OTHER, ME, THIRD]) expect(err(await w.decide(who, p, { verdict: "approve" })), who).toEqual({ status: 403, error: "not_admin" });
    expect(w.txns).toEqual([]);
    expect(w.stored(p.id).proposal.state).toBe("pending");
  });

  it("deny and needs_changes without a reason are 400; a reason is required, trimmed and bounded", async () => {
    const w = await world();
    const p = await w.propose(OTHER, w.me, "Aldric", "r-2");
    for (const verdict of ["deny", "needs_changes"]) {
      for (const body of [{ verdict }, { verdict, reason: "" }, { verdict, reason: "   " }, { verdict, reason: 5 }]) {
        const r = await w.decide(ADMIN, p, body, { idem: `r-2-${verdict}-${JSON.stringify(body.reason)}` });
        expect(err(r), JSON.stringify(body)).toEqual({ status: 400, error: "validation" });
        expect(r.body.errors[0].pointer).toBe("/reason");
      }
    }
    expect(err(await w.decide(ADMIN, p, { verdict: "deny", reason: "x".repeat(1001) }, { idem: "r-2-long" })).status).toBe(400);
    expect(err(await w.decide(ADMIN, p, { verdict: "nonsense" }, { idem: "r-2-v" })).status).toBe(400);
    expect(err(await w.decide(ADMIN, p, { verdict: "deny", reason: "no", extra: 1 }, { idem: "r-2-x" })).status).toBe(400);
    expect(err(await w.decide(ADMIN, p, { verdict: "deny", reason: "no", amend: { ops: [] } }, { idem: "r-2-a" })).status).toBe(400);
    expect(w.stored(p.id).proposal.state).toBe("pending");
  });

  it("no Idempotency-Key is 400 and no If-Match is 428", async () => {
    const w = await world();
    const p = await w.propose(OTHER, w.me, "Aldric", "r-3");
    expect(err(await w.decide(ADMIN, p, { verdict: "approve" }, { idem: null }))).toEqual({ status: 400, error: "validation" });
    expect(err(await w.decide(ADMIN, p, { verdict: "approve" }, { etag: null }))).toEqual({ status: 428, error: "precondition_required" });
  });

  it("an unknown proposal is 404, and the route is dark while HFY_EDITING is off", async () => {
    const w = await world();
    const p = await w.propose(OTHER, w.me, "Aldric", "r-4");
    expect(err(await w.decide(ADMIN, { ...p, id: "01J00000000000000000000000" }, { verdict: "approve" }, { idem: "r-4" }))).toEqual({ status: 404, error: "not_found" });
    process.env.HFY_EDITING = "off";
    expect(err(await w.decide(ADMIN, p, { verdict: "approve" }, { idem: "r-4b" })).status).toBe(404);
  });

  it("a reason with contact text is refused by the guard (422) and nothing is written", async () => {
    const w = await world();
    const p = await w.propose(OTHER, w.me, "Aldric", "r-5");
    w.txns.length = 0;
    const r = await w.decide(ADMIN, p, { verdict: "deny", reason: "call me on 212-555-0143" });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe("contact_info");
    expect(JSON.stringify(r.body)).not.toContain("555");
    expect(w.txns).toEqual([]);
  });

  describe("a destructive approval needs a fresh sign-in", () => {
    const unlink = (w) => [
      { id: "p", op: "remove", obj: key(w.me), path: `/family_list/@=${w.fam.handle}`, base: w.fam.handle },
      { id: "f", op: "set", obj: key(w.fam), path: "/father_handle", base: w.me.handle, value: null },
    ];
    const propose = async (w) => {
      const r = await w.post(OTHER, { target: key(w.me), base_versions: { [key(w.me)]: 1, [key(w.fam)]: 1 }, ops: unlink(w) }, "u-1");
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body.proposal, "a member's unlink is a proposal").toBeTruthy();
      return r.body.proposal;
    };
    it("401 step_up_required when auth_time is older than 900 s, or absent, and nothing is written", async () => {
      const w = await world();
      const p = await propose(w);
      w.txns.length = 0;
      const old = await w.decide(ADMIN, p, { verdict: "approve" }, { token: await w.authToken(ADMIN, Math.floor(w.NOW / 1000) - 2000), idem: "u-2" });
      expect(err(old)).toEqual({ status: 401, error: "step_up_required" });
      expect(old.body.details).toEqual({ maxAgeSeconds: 900 });
      expect(err(await w.decide(ADMIN, p, { verdict: "approve" }, { token: await w.authToken(ADMIN, null), idem: "u-3" })).status).toBe(401);
      expect(w.txns).toEqual([]);
      expect(w.stored(p.id).proposal.state).toBe("pending");
    });
    it("goes through with a sign-in within 900 s, and a deny never asks for one", async () => {
      const w = await world();
      const p = await propose(w);
      const fresh = await w.decide(ADMIN, p, { verdict: "approve" }, { token: await w.authToken(ADMIN, Math.floor(w.NOW / 1000) - 600), idem: "u-4" });
      expect(fresh.status, JSON.stringify(fresh.body)).toBe(200);
      expect(w.heads("Family", w.fam.handle).father_handle).toBeFalsy();
      const w2 = await world();
      const p2 = await propose(w2);
      const denied = await w2.decide(ADMIN, p2, { verdict: "deny", reason: "not right now" }, { token: await w2.authToken(ADMIN, 0), idem: "u-5" });
      expect(denied.status).toBe(200);
    });
  });
});

describe("deny and needs_changes (AC4, AC5)", () => {
  it("deny: one transaction moves META, the copies and the audit to declined, with the reason stored; the proposer gets proposal_declined with the note as the detail", async () => {
    const w = await world();
    const p = await w.propose(OTHER, w.me, "Aldric", "d-1");
    w.txns.length = 0;
    const r = await w.decide(ADMIN, p, { verdict: "deny", reason: "we already have this spelling" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.proposal).toMatchObject({ state: "declined", decision: { verdict: "deny", reason: "we already have this spelling", by: { id: ADMIN } } });
    expect(r.body.applied).toBeUndefined();
    expect(w.txns).toHaveLength(1);
    expect(w.stored(p.id).GSI1PK).toBe("PROPQ#declined");
    for (const row of w.rows(`PROP#${p.id}`)) expect(row.proposal.state, row.SK).toBe("declined");
    expect(w.rows(`AUDIT#proposal:${p.id}`).find((x) => x.op === "proposal.decide")).toMatchObject({ principal: ADMIN, reason: "we already have this spelling", after: { state: "declined" } });
    expect(w.heads("Person", w.me.handle).primary_name.first_name).toBe("Alder"); // no record write
    expect(w.afters).toEqual([]);
    expect(w.events(OTHER)).toEqual([]); // no credit for a decline
    const inbox = (await w.inbox.list(OTHER)).items;
    expect(inbox.map((i) => i.type)).toEqual(["proposal_declined"]);
    expect(inbox[0].detail).toBe("we already have this spelling");
    expect(err(await w.decide(ADMIN2, p, { verdict: "approve" }, { idem: "d-1b", etag: r.body.proposal.etag })).error).toBe("invalid_state");
  });

  it("the reason is visible to the proposer and admins, never to another member of the page's circle", async () => {
    const w = await world();
    const p = await w.propose(OTHER, w.me, "Aldric", "d-2");
    await w.decide(ADMIN, p, { verdict: "deny", reason: "a private note to the proposer" });
    expect((await w.getP(OTHER, p.id)).body.decision.reason).toBe("a private note to the proposer");
    expect((await w.getP(ADMIN2, p.id)).body.decision.reason).toBe("a private note to the proposer");
    const circle = await w.getP(ME, p.id); // the page's own member sees the verdict
    expect(circle.status).toBe(200);
    expect(circle.body.state).toBe("declined");
    expect(circle.body.decision).toMatchObject({ verdict: "deny" });
    expect(JSON.stringify(circle.body)).not.toContain("private note");
    expect(circle.body.decision).not.toHaveProperty("auth_time");
  });

  it("needs_changes: back to the proposer (they can amend it to pending); the note is the detail of proposal_needs_changes", async () => {
    const w = await world();
    const p = await w.propose(OTHER, w.me, "Aldric", "n-1");
    const r = await w.decide(ADMIN, p, { verdict: "needs_changes", reason: "which spelling do you mean?" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.proposal.state).toBe("needs_changes");
    expect(w.stored(p.id).GSI1PK).toBe("PROPQ#needs_changes");
    const inbox = (await w.inbox.list(OTHER)).items;
    expect(inbox.map((i) => i.type)).toEqual(["proposal_needs_changes"]);
    expect(inbox[0].detail).toBe("which spelling do you mean?");
    // the admin cannot decide it again until the proposer amends
    expect(err(await w.decide(ADMIN, r.body.proposal, { verdict: "approve" }, { idem: "n-1b" })).error).toBe("invalid_state");
    const amended = await w.call("PATCH", `/api/proposals/${p.id}`, OTHER, { body: { ops: [set(w.me, "/primary_name/first_name", "Alder", "Aldrick")], base_versions: { [key(w.me)]: 1 } }, headers: { "if-match": `"${r.body.proposal.etag}"` } });
    expect(amended.status, JSON.stringify(amended.body)).toBe(200);
    expect(amended.body).toMatchObject({ state: "pending", rev: 2 });
    const done = await w.decide(ADMIN, amended.body, { verdict: "approve" }, { idem: "n-1c" });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(w.heads("Person", w.me.handle).primary_name.first_name).toBe("Aldrick");
  });

  it("the admin may decline their own suggestion without being notified of it", async () => {
    const w = await world();
    const r0 = await w.post(ADMIN, { route: "review", target: key(w.me), base_versions: { [key(w.me)]: 1 }, ops: [set(w.me, "/primary_name/first_name", "Alder", "Aldric")] }, "d-3");
    expect(r0.status, JSON.stringify(r0.body)).toBe(201);
    const r = await w.decide(ADMIN, r0.body.proposal, { verdict: "deny", reason: "changed my mind" });
    expect(r.status).toBe(200);
    expect((await w.inbox.list(ADMIN)).items.map((i) => i.type)).not.toContain("proposal_declined");
  });
});

describe("amend: edit then approve (AC)", () => {
  it("the admin's edited ops are applied and recorded; decision.amended is true", async () => {
    const w = await world();
    const p = await w.propose(OTHER, w.me, "Aldric", "a-1");
    const r = await w.decide(ADMIN, p, { verdict: "approve", amend: { base_versions: { [key(w.me)]: 1 }, ops: [set(w.me, "/primary_name/first_name", "Alder", "Aldrich", "e1")] } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.proposal).toMatchObject({ state: "approved", decision: { amended: true } });
    expect(r.body.proposal.ops).toEqual([expect.objectContaining({ id: "e1", value: "Aldrich" })]);
    expect(w.heads("Person", w.me.handle).primary_name.first_name).toBe("Aldrich");
    expect(w.stored(p.id).proposal.ops[0].value).toBe("Aldrich");
  });

  it("an amend of a relationship (spouse) proposal drops the stale intent and recomputes read_versions to the objects the edited ops leave alone", async () => {
    const w = await world();
    const p = await w.propose(OTHER, w.me, "Aldric", "a-rel");
    const doc = { ...w.stored(p.id).proposal, kind: "relationship", intent: { type: "spouse", spouse: { who: "stub" } }, read_versions: { [key(w.fam)]: 1, [key(w.me)]: 1 } };
    for (const row of w.rows(`PROP#${p.id}`)) w.ddb.rows.set(`${row.PK}\u0000${row.SK}`, { ...row, proposal: doc });
    const r = await w.decide(ADMIN, doc, { verdict: "approve", amend: { base_versions: { [key(w.me)]: 1 }, ops: [set(w.me, "/primary_name/first_name", "Alder", "Aldrich", "e1")] } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const stored = w.stored(p.id).proposal;
    expect(stored.intent).toBeUndefined();
    expect(stored.kind).toBe("edit");
    expect(stored.read_versions).toEqual({ [key(w.fam)]: 1 });
  });

  it("an amend runs the privacy guard (admins are not exempt): 422, and nothing is written", async () => {
    const w = await world();
    const p = await w.propose(OTHER, w.me, "Aldric", "a-2");
    w.txns.length = 0;
    const r = await w.decide(ADMIN, p, { verdict: "approve", amend: { base_versions: { [key(w.me)]: 1 }, ops: [set(w.me, "/primary_name/nick", "", "call 212-555-0143", "e1")] } });
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body)).not.toContain("555-0143");
    expect(w.txns).toEqual([]);
    expect(w.stored(p.id).proposal.state).toBe("pending"); // an admin's own text is theirs to fix: the proposal is not moved
  });
});

describe("the approval-time guard re-check", () => {
  it("text the rules now refuse moves the proposal to needs_changes with a system reason, echoing nothing", async () => {
    const w = await world();
    const p = await w.propose(OTHER, w.me, "Aldric", "g-1");
    // the rules tightened since submission: a stored proposal now carries text the guard refuses (planted directly, as an older release would have accepted it)
    const doc = structuredClone(w.stored(p.id).proposal);
    doc.ops[0].value = "Aldric 212-555-0143";
    for (const row of w.rows(`PROP#${p.id}`)) w.ddb.rows.set(`${row.PK}\u0000${row.SK}`, { ...row, proposal: doc });
    w.txns.length = 0;
    const r = await w.decide(ADMIN, doc, { verdict: "approve" });
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body)).not.toContain("555");
    const row = w.stored(p.id);
    expect(row.proposal.state).toBe("needs_changes");
    expect(row.proposal.decision).toMatchObject({ verdict: "needs_changes", system: true, reason: GUARD_SYSTEM_REASON });
    expect(JSON.stringify(w.rows(`AUDIT#proposal:${p.id}`))).not.toContain("555");
    expect(w.heads("Person", w.me.handle).primary_name.first_name).toBe("Alder");
    expect((await w.inbox.list(OTHER)).items.map((i) => i.type)).toEqual(["proposal_needs_changes"]);
  });
});

describe("create proposals: ids per Q2-03 and the access-request hook (AC5)", () => {
  it("approving a create fills the gramps_id (the reserved block) and the handle is derived, so a retry builds the same ops", async () => {
    const w = await world();
    // an admin's create on the review route is filed as a proposal
    const rp = await w.post(ADMIN, { route: "review", base_versions: {}, ops: [{ id: "mk", op: "create", obj: "new:1", cls: "Note", value: noteValue("Another synthetic remembrance") }] }, "m-2");
    expect(rp.status, JSON.stringify(rp.body)).toBe(201);
    const p = rp.body.proposal;
    expect(p.kind).toBe("create");
    const r = await w.decide(ADMIN2, p, { verdict: "approve" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const [noteKey] = Object.keys(r.body.applied.versions);
    expect(noteKey).toBe(`Note:${sha256Hex(`${p.id}:${p.rev}:0`).slice(0, 24)}`); // derived from the proposal, so a retry builds the same ops (P2-R38)
    expect(r.body.applied.versions[noteKey]).toBe(1);
    const row = w.headRow("Note", noteKey.split(":")[1]);
    expect(row.gramps_id).toMatch(/^N8\d{3}$/);
    expect(JSON.parse(row.obj_json).gramps_id).toBe(row.gramps_id);
  });

  it("an access-request proposal calls completeAccessRequest with the page's gramps_id, and its fragment joins the approval transaction", async () => {
    const calls = [];
    const w = await world({ completeAccessRequest: async (a) => { calls.push({ requestId: a.requestId, grampsId: a.grampsId, proposalId: a.proposal.id }); return { puts: [{ item: { PK: `ACCESSREQ#${a.requestId}`, SK: "META", state: "active", sub: a.grampsId } }] }; } });
    const sys = { ...w.sctx, uid: (() => { let n = 0; return () => `01J${String(++n).padStart(23, "0")}`; })() };
    const doc = await createSystem(sys, { kind: "edit", origin: "access_request", requestId: "req-0001", base_versions: { [key(w.me)]: 1 }, ops: [set(w.me, "/primary_name/first_name", "Alder", "Aldric", "e")] });
    w.txns.length = 0;
    const r = await w.decide(ADMIN, doc, { verdict: "approve" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(calls).toEqual([{ requestId: "req-0001", grampsId: ME, proposalId: doc.id }]);
    expect(w.txns).toHaveLength(1);
    expect(w.ddb.rows.get("ACCESSREQ#req-0001\u0000META")).toMatchObject({ state: "active", sub: ME });
    expect(w.txns[0].TransactItems.some((i) => i.Put?.Item?.PK === "ACCESSREQ#req-0001")).toBe(true); // the same TransactWrite
    // the site is not a member: nobody is credited and nobody is told
    expect(w.rows("CONTRIB#")).toEqual([]);
    expect(w.afters).toHaveLength(1);
  });

  it("a proposal from the web calls no hook", async () => {
    const calls = [];
    const w = await world({ completeAccessRequest: async (a) => { calls.push(a); return { puts: [] }; } });
    const p = await w.propose(OTHER, w.me, "Aldric", "h-1");
    expect((await w.decide(ADMIN, p, { verdict: "approve" })).status).toBe(200);
    expect(calls).toEqual([]);
  });
});

describe("review fixes (HFY-TSK-209 R58 follow-up)", () => {
  it("an amend whose base_versions are behind the records is 409 rebase_conflict: nothing is applied and the proposal stays pending", async () => {
    const w = await world();
    const p = await w.propose(OTHER, w.me, "Aldric", "f-1");
    await w.bump({ ...w.me, primary_name: { ...w.me.primary_name, nick: "Ally" } }, 1); // the record moved after the admin read it (version 1)
    w.txns.length = 0;
    const r = await w.decide(ADMIN, p, { verdict: "approve", amend: { base_versions: { [key(w.me)]: 1 }, ops: [set(w.me, "/primary_name/first_name", "Alder", "Aldrich", "e1")] } });
    expect(err(r)).toEqual({ status: 409, error: "rebase_conflict" });
    expect(r.body.details.conflicts).toEqual([expect.objectContaining({ obj: key(w.me), reason: "stale_base", base_version: 1, current_version: 2 })]);
    expect(w.txns).toEqual([]);
    expect(w.stored(p.id).proposal.state).toBe("pending");
    expect(w.heads("Person", w.me.handle).primary_name.first_name).toBe("Alder");
    // the same amend with the version the admin re-read is applied, and the stored base_versions are the verified ones
    const ok = await w.decide(ADMIN, p, { verdict: "approve", amend: { base_versions: { [key(w.me)]: 2 }, ops: [set(w.me, "/primary_name/first_name", "Alder", "Aldrich", "e1")] } }, { idem: "f-1b" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(w.stored(p.id).proposal.base_versions).toEqual({ [key(w.me)]: 2 });
  });

  it("an amend that names no version of a record its ops touch is 400", async () => {
    const w = await world();
    const p = await w.propose(OTHER, w.me, "Aldric", "f-2");
    const r = await w.decide(ADMIN, p, { verdict: "approve", amend: { ops: [set(w.me, "/primary_name/first_name", "Alder", "Aldrich", "e1")] } });
    expect(err(r)).toEqual({ status: 400, error: "validation" });
    expect(w.stored(p.id).proposal.state).toBe("pending");
  });

  it("a validation failure that is not a rebase conflict is 400, not stale: nothing is persisted and the proposer is not told", async () => {
    const w = await world();
    const p = await w.propose(OTHER, w.me, "Aldric", "f-3");
    const doc = structuredClone(w.stored(p.id).proposal);
    doc.ops[0].value = 12345; // a value the schema refuses (planted, as an older release would have accepted it)
    for (const row of w.rows(`PROP#${p.id}`)) w.ddb.rows.set(`${row.PK}\u0000${row.SK}`, { ...row, proposal: doc });
    w.txns.length = 0;
    const r = await w.decide(ADMIN, doc, { verdict: "approve" });
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(w.txns).toEqual([]);
    expect(w.stored(p.id).proposal.state).toBe("pending");
    expect(w.rows(`AUDIT#proposal:${p.id}`).map((x) => x.op)).not.toContain("proposal.stale");
    expect((await w.inbox.list(OTHER)).items.map((i) => i.type)).not.toContain("proposal_stale");
  });

  it("a retry of the key that moved a proposal aside replays the 409 (not 412), and the move-back 422 likewise", async () => {
    const w = await world();
    const p = await w.propose(OTHER, w.me, "Aldric", "f-4");
    await w.bump({ ...w.me, primary_name: { ...w.me.primary_name, first_name: "Alden" } }, 1);
    const first = await w.decide(ADMIN, p, { verdict: "approve" }, { idem: "same-key" });
    expect(err(first)).toEqual({ status: 409, error: "rebase_conflict" });
    const again = await w.decide(ADMIN, p, { verdict: "approve" }, { idem: "same-key" }); // the same request, after a lost answer
    expect(err(again)).toEqual({ status: 409, error: "rebase_conflict" });
    expect(again.body.details.proposal.state).toBe("stale");
    expect(w.rows(`AUDIT#proposal:${p.id}`).filter((x) => x.op === "proposal.stale")).toHaveLength(1);

    const q2 = await w.propose(OTHER, w.third, "Aldric", "f-5");
    const doc = structuredClone(w.stored(q2.id).proposal);
    doc.ops[0].value = "Aldric 212-555-0143";
    for (const row of w.rows(`PROP#${q2.id}`)) w.ddb.rows.set(`${row.PK}\u0000${row.SK}`, { ...row, proposal: doc });
    const g1 = await w.decide(ADMIN, doc, { verdict: "approve" }, { idem: "guard-key" });
    expect(g1.status).toBe(422);
    const g2 = await w.decide(ADMIN, doc, { verdict: "approve" }, { idem: "guard-key" });
    expect(g2.status).toBe(422);
    expect(JSON.stringify(g2.body)).not.toContain("555");
    expect(w.stored(q2.id).proposal.state).toBe("needs_changes");
    expect((await w.inbox.list(OTHER)).items.filter((i) => i.type === "proposal_needs_changes")).toHaveLength(1); // told once
  });

  it("the admin's sign-in time is stored for admins and the audit, and shown to nobody else, the proposer included", async () => {
    const w = await world();
    const p = await w.propose(OTHER, w.me, "Aldric", "f-6");
    const r = await w.decide(ADMIN, p, { verdict: "deny", reason: "a note for the proposer" });
    expect(r.body.proposal.decision).toHaveProperty("auth_time");
    expect(w.stored(p.id).proposal.decision).toHaveProperty("auth_time");
    expect((await w.getP(ADMIN2, p.id)).body.decision).toHaveProperty("auth_time");
    const mine = await w.getP(OTHER, p.id);
    expect(mine.body.decision.reason).toBe("a note for the proposer");
    expect(mine.body.decision).not.toHaveProperty("auth_time");
    const list = await w.call("GET", "/api/proposals", OTHER);
    expect(JSON.stringify(list.body)).not.toContain("auth_time");
  });

  it("an approval with nothing left to write never needs a recent sign-in (it is not destructive: no record is touched)", async () => {
    const w = await world();
    const p = await w.propose(OTHER, w.me, "Aldric", "f-7");
    await w.bump({ ...w.me, primary_name: { ...w.me.primary_name, first_name: "Aldric" } }, 1);
    const old = await w.authToken(ADMIN, Math.floor(w.NOW / 1000) - 5000); // signed in far longer than 900 s ago
    const r = await w.decide(ADMIN, p, { verdict: "approve" }, { token: old });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.applied.versions).toEqual({});
  });
});

describe("grampsIdFor (Q2-03, AC5)", () => {
  const eff = (subject) => ({ subject });
  it("a created Person's gramps_id is the one linked, else the page the proposal is about, else none", () => {
    expect(grampsIdFor({ changes: [{ class: "Person", op: "create", gramps_id: "I8001" }] }, eff({ cls: "Person", gramps_id: "I0001" }))).toBe("I8001");
    expect(grampsIdFor({ changes: [{ class: "Person", op: "create" }] }, eff(undefined))).toBe(""); // assign mode: the desktop assigns it
    expect(grampsIdFor({ changes: [{ class: "Note", op: "create", gramps_id: "N8001" }] }, eff({ cls: "Person", gramps_id: "I0001" }))).toBe("I0001");
    expect(grampsIdFor({ changes: [] }, eff({ cls: "Family", gramps_id: "F0001" }))).toBe("");
    expect(grampsIdFor({}, eff(undefined))).toBe("");
  });

  it("a Person create from an access request is not reachable yet: field policy refuses it at filing (403 derived) and again at approval, with a clear error and nothing written (owned by surf-access-admin-api and relationship-api)", async () => {
    const calls = [];
    const w = await world({ completeAccessRequest: async (a) => { calls.push(a.grampsId); return { puts: [] }; } });
    const sys = { ...w.sctx, uid: (() => { let n = 0; return () => `01J${String(++n).padStart(23, "0")}`; })() };
    const mk = (cls, value) => ({ id: "mk", op: "create", obj: "new:1", cls, value });
    // filing: the system proposer cannot file a Person create today
    const refused = await createSystem(sys, { kind: "create", origin: "access_request", requestId: "req-0002", base_versions: {}, ops: [mk("Person", personValue())] }).catch((e) => e);
    expect(refused).toMatchObject({ status: 403, code: "not_allowed" });
    expect(refused.errors).toEqual([expect.objectContaining({ code: "derived" })]);
    // approval: a stored Person-create proposal (planted, as a later release that allows it would have filed it) is refused with the same error
    const doc = await createSystem(sys, { kind: "create", origin: "access_request", requestId: "req-0003", base_versions: {}, ops: [mk("Note", noteValue("Synthetic request note"))] });
    const planted = { ...structuredClone(doc), ops: [mk("Person", personValue())] };
    for (const row of w.rows(`PROP#${doc.id}`)) w.ddb.rows.set(`${row.PK}\u0000${row.SK}`, { ...row, proposal: planted });
    w.txns.length = 0;
    const r = await w.decide(ADMIN, planted, { verdict: "approve" });
    expect(err(r)).toEqual({ status: 403, error: "not_allowed" });
    expect(w.txns).toEqual([]);
    expect(calls).toEqual([]);
    expect(w.stored(doc.id).proposal.state).toBe("pending"); // not moved aside: this is not a rebase conflict
  });
});

describe("the route is registered (caps)", () => {
  it("proposals.decide is a POST behind the editing gate with no MCP tool", () => {
    const a = buildCaps().actions.find((x) => x.name === "proposals.decide");
    expect(a).toMatchObject({ method: "POST", path: "/api/proposals/:id/decision", write: true });
    expect(a.gate).toBeTruthy();
    expect(ROUTES.find((r) => r.name === "proposals.decide").mcp).toBeUndefined();
  });
});
