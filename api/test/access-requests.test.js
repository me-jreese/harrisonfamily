// HFY-TSK-141 (surf-access-admin-api): the access-request admin routes (surfaces.md 7.4, BRD2 D2-23, reviews PS-13 and IF-06). In-memory DynamoDB
// fake, a fake mailer, synthetic addresses, names and ids only.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { InMemoryNotificationStore } from "@io-kit/notify/server";
import { cmds, makeApi, signToken, TABLE } from "./world.js";
import { applyBatch } from "../src/sync/apply.js";
import { createHookRegistry } from "../src/sync/hooks.js";
import { completeAssignments, createIdPolicy } from "../src/sync/id-policy.js";
import { headKey } from "../src/sync/store.js";
import { buildCaps, ROUTES } from "../src/routes.js";
import { loadProposal, systemProposalOf, withdrawSystem } from "../src/records/proposal-store.js";
import {
  AWAITING_TTL_SECONDS, DECIDED_TTL_SECONDS, HOLD_MS, LIST_STATES, SECOND_EMAIL_RULE, STORE_CURRENT_CITY, createAccessRequests, maskEmail, opsFromPreview, parseDecision,
  secondEmailGate, secondEmailPath,
} from "../src/access-requests.js";
import { createSesMailer, sendEmailInput } from "../src/mailer.js";
import { allowKeys, createCompositeMemberReader, grantItems, isAllowedNow, readAllowEntry } from "../src/allowlist-store.js";
import { TEMPLATE_IDS } from "../src/shared/emails.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ADMIN = "I0099";
const ADMIN2 = "I0098";
const OWNER = "I0097";
const MEMBER = "I0003";
const OTHER = "I0004";
const LIVING = "I0001"; // a living person with no second email
const HAS_EMAIL = "I0002"; // a living person who already signs in with another address
const DEAD_IN_STORE = "I0005"; // the page index says living, the record store holds a death event
const NOT_LIVING = "I0006"; // the page index says not living
const GHOST = "I0777"; // not on the site
const EMAIL = "sam.synthetic@example.test";
const OLD_EMAIL = "sam.older@example.test";
const ID1 = "01J00000000000000000000001";
const ID2 = "01J00000000000000000000002";
const ID3 = "01J00000000000000000000003";
const T0 = Date.parse("2026-10-14T12:00:00Z");
const q = { warn() {}, error() {}, info() {} };
const FORM = {
  givenNames: "Sam", maidenSurname: "Exampleton", gender: "female", nickname: "Sammy", birthPlace: "Springfield, IL", birthYear: 1980,
  currentPlace: "Portland, OR", movedYear: 2005, university: "Example State", graduationYear: 2002, forSelf: true,
};

let envBefore;
beforeEach(() => { envBefore = process.env.HFY_EDITING; process.env.HFY_EDITING = "on"; });
afterEach(() => { if (envBefore === undefined) delete process.env.HFY_EDITING; else process.env.HFY_EDITING = envBefore; });

const typ = (cls, value) => ({ _class: cls, string: "", value });
const date0 = { _class: "Date", calendar: 0, dateval: [0, 0, 0, false], format: null, modifier: 0, newyear: 0, quality: 0, sortval: 0, text: "" };
const h = (n) => n.toString(16).padStart(28, "0");
const person = (n, gid, extra = {}) => ({
  _class: "Person", handle: h(n), gramps_id: gid, private: false, gender: 0,
  primary_name: { _class: "Name", first_name: "Alder", nick: "", surname_list: [{ _class: "Surname", primary: true, surname: "Testwood" }], type: typ("NameType", 2), date: date0 },
  event_ref_list: [], birth_ref_index: -1, death_ref_index: -1, family_list: [], parent_family_list: [], note_list: [], media_list: [], urls: [], ...extra,
});
const event = (n, type) => ({ _class: "Event", handle: h(500 + n), gramps_id: `E${String(n).padStart(4, "0")}`, private: false, type: typ("EventType", type), date: date0, description: "", place: "", citation_list: [], note_list: [], media_list: [], attribute_list: [], tag_list: [] });
const create = (obj) => ({ op: "create", class: obj._class, handle: obj.handle, base_version: null, obj });

/**
 * A world: the API with the accessRequests flag on, a fake mailer, the id policy in mint mode, a clock the test moves, and three seeded people
 * (a living one, one with a death event in the record store, and one whose page says not living).
 */
async function world({ mailFails = false, members = [], inbox: inboxStore } = {}) {
  const clock = { t: T0 };
  const sent = [];
  const mail = { fail: mailFails };
  const mailer = { async send(m) { if (mail.fail) throw Object.assign(new Error("mail not sent"), { name: "MessageRejected" }); sent.push(m); } };
  const hooks = createHookRegistry();
  const inbox = inboxStore ?? new InMemoryNotificationStore();
  const txns = [];
  const race = { before: null };
  const facts = { [LIVING]: { isLiving: true }, [HAS_EMAIL]: { isLiving: true }, [DEAD_IN_STORE]: { isLiving: true }, [NOT_LIVING]: { isLiving: false } };
  const fileEntries = new Map([[OLD_EMAIL, { sub: HAS_EMAIL }]]); // io's S3 file: HAS_EMAIL already signs in with OLD_EMAIL
  const flags = { accessRequests: true, inboxV1: true };
  const w = makeApi({
    admins: [ADMIN, ADMIN2, OWNER], log: q, clock: () => clock.t, inbox, flags,
    intercept: async (cmd) => {
      if (cmd.constructor.name !== "TransactWriteCommand") return;
      txns.push(structuredClone(cmd.input));
      if (race.before) { const fn = race.before; race.before = null; await fn(); } // another request commits just before this transaction does
    },
    extraDeps: {
      syncHooks: hooks, idPolicy: createIdPolicy({ mode: "mint" }), txnOpts: { sleep: async () => {} }, mailer,
      getAdmins: async () => new Set([ADMIN, ADMIN2, OWNER]), isOwner: async (sub) => sub === OWNER,
      personFacts: async (gid) => facts[gid] ?? null, readEntries: async () => fileEntries,
    },
  });
  w.ddb.rows.set("SYNC#HEAD\u0000META", { ...headKey(), seq: 0, seeded: true, writes_enabled: true });
  let u = 0;
  const sctx = { ddb: w.ddb, cmds, table: TABLE, now: () => clock.t, uid: () => `s${++u}`, unsafeNoValidate: true, log: q, txnOpts: { sleep: async () => {} } };
  const dead = event(1, 13); // Gramps EventType 13 = Death
  await applyBatch(sctx, {
    principal: "svc-seed", origin: "desktop", idempotencyKey: "seed-1",
    ops: [
      person(1, LIVING), person(2, HAS_EMAIL), person(3, DEAD_IN_STORE, { event_ref_list: [{ _class: "EventRef", ref: dead.handle, role: typ("EventRoleType", 1) }], death_ref_index: 0 }),
      person(4, NOT_LIVING), dead,
    ].map(create),
  });
  const token = (who, { fresh = true, ageSeconds } = {}) => signToken(who, { authTime: Math.floor(clock.t / 1000) - (ageSeconds ?? (fresh ? 10 : 5000)), exp: "10h" });
  const call = async (method, path, who, { body, query, ...rest } = {}) => w.call(method, path, { token: who ? await token(who, rest) : undefined, ...(body !== undefined ? { body } : {}), ...(query ? { query } : {}) });
  /** Seed a request (and its duplicate guard) as the edge's submit writes them. */
  const seed = (over = {}) => {
    const id = over.id ?? ID1;
    const state = over.state ?? "pending";
    const emailHash = over.emailHash ?? `hash-${id}`;
    const ttl = over.ttl ?? Math.floor(clock.t / 1000) + 90 * 86400;
    const email = over.email ?? EMAIL;
    w.ddb.rows.set(`ACCESSREQ#${id}\u0000META`, {
      PK: `ACCESSREQ#${id}`, SK: "META", entity: "accessreq", id, state, version: 1, createdAt: new Date(clock.t - 3600_000).toISOString(), updatedAt: new Date(clock.t - 3600_000).toISOString(),
      email, emailHash, form: { ...FORM }, GSI1PK: `ACCESSREQS#${state}`, GSI1SK: id, ttl, ...over,
    });
    w.ddb.rows.set(`ACCESSREQEMAIL#${emailHash}\u0000META`, { PK: `ACCESSREQEMAIL#${emailHash}`, SK: "META", entity: "accessreqemail", requestId: id, state: "pending", ttl });
    return id;
  };
  const row = (pk, sk = "META") => w.ddb.rows.get(`${pk}\u0000${sk}`);
  const req = (id = ID1) => row(`ACCESSREQ#${id}`);
  const allow = (email = EMAIL) => row(`ALLOW#${email}`);
  const audits = (prefix) => w.ddb.all().filter((r) => r.PK.startsWith(`AUDIT#${prefix}`));
  const decide = (who, id, body, opts) => call("POST", `/api/access-requests/${id}/decision`, who, { body, ...opts });
  const link = (who, id, over = {}, opts) => decide(who, id, { decision: "link", grampsId: LIVING, version: 1, confirmedOutside: true, ...over }, opts);
  const revoke = (who, id, over = {}, opts) => call("POST", `/api/access-requests/${id}/revoke`, who, { body: { version: 2, confirmedOutside: true, ...over }, ...opts });
  const storeCtx = { ddb: w.ddb, cmds, table: TABLE, now: () => clock.t, uid: () => `s${++u}`, log: q, txnOpts: { sleep: async () => {} } };
  return { ...w, flags, clock, sent, mail, inbox, txns, race, call, token, seed, row, req, allow, audits, decide, link, revoke, fileEntries, facts, storeCtx, hooks };
}
const accessAudits = (w) => [...w.audits("accessreq:"), ...w.audits("allow:")];
const err = (r) => ({ status: r.status, error: r.body?.error });
const lastTxn = (w) => w.txns.at(-1).TransactItems;

describe("the routes exist and are for admins (AC1)", () => {
  it("registers the seven routes, the admin ones behind the accessRequests flag and the member's two outside it, with no MCP tool", () => {
    const names = ["accessRequests.list", "accessRequests.get", "accessRequests.decide", "accessRequests.revoke", "accessRequests.resendNotice", "accessRequests.secondEmails", "accessRequests.secondEmail"];
    const held = { switch: "ACCESS_REQUESTS", rule: SECOND_EMAIL_RULE }; // open past the flag on purpose, and gated by the held-member rule, which caps.json says
    const caps = buildCaps().actions.filter((a) => names.includes(a.name));
    expect(caps.map((a) => [a.name, a.method, a.path, a.gate])).toEqual([
      ["accessRequests.list", "GET", "/api/access-requests", { feature: "accessRequests" }],
      ["accessRequests.get", "GET", "/api/access-requests/:id", { feature: "accessRequests" }],
      ["accessRequests.decide", "POST", "/api/access-requests/:id/decision", { feature: "accessRequests" }],
      ["accessRequests.revoke", "POST", "/api/access-requests/:id/revoke", { feature: "accessRequests" }],
      ["accessRequests.resendNotice", "POST", "/api/access-requests/:id/resend-notice", { feature: "accessRequests" }],
      ["accessRequests.secondEmails", "GET", "/api/second-email", held],
      ["accessRequests.secondEmail", "POST", "/api/second-email/:id", held],
    ]);
    for (const n of names) expect(ROUTES.find((r) => r.name === n).mcp).toBeUndefined();
  });

  it("is dark while the flag is off: the admin routes are 404 to everyone, an admin included (403 not_admin for a member only once the flag is on)", async () => {
    const w = makeApi({ admins: [ADMIN], log: q });
    const admin = await signToken(ADMIN);
    const member = await signToken(MEMBER);
    for (const [m, p] of [
      ["GET", "/api/access-requests"], ["GET", `/api/access-requests/${ID1}`], ["POST", `/api/access-requests/${ID1}/decision`], ["POST", `/api/access-requests/${ID1}/revoke`],
      ["POST", `/api/access-requests/${ID1}/resend-notice`],
    ]) {
      expect((await w.call(m, p, { token: admin, ...(m === "POST" ? { body: {} } : {}) })).status, `${m} ${p}`).toBe(404);
      expect((await w.call(m, p, { token: member, ...(m === "POST" ? { body: {} } : {}) })).status, `${m} ${p} member`).toBe(404);
      expect((await w.call(m, p, { ...(m === "POST" ? { body: {} } : {}) })).status, `${m} ${p} signed out`).toBe(404);
    }
    // the member's routes are not dark: they need a session, and are the same 404 as no request for anyone who has no hold
    const second = `/api/second-email/${ID1}`;
    expect((await w.call("POST", second, { body: { response: "object" } })).status).toBe(401);
    expect((await w.call("POST", second, { token: admin, body: { response: "object" } })).status).toBe(404);
    expect((await w.call("GET", "/api/second-email", {})).status).toBe(401);
    expect((await w.call("GET", "/api/second-email", { token: member })).status).toBe(404);
  });

  it("answers 401 signed out and 403 not_admin to a member on every admin route, before it reads a thing", async () => {
    const w = await world();
    w.seed();
    for (const [m, p, body] of [
      ["GET", "/api/access-requests"], ["GET", `/api/access-requests/${ID1}`],
      ["POST", `/api/access-requests/${ID1}/decision`, { decision: "decline", version: 1 }], ["POST", `/api/access-requests/${ID1}/revoke`, { version: 1, confirmedOutside: true }],
      ["POST", `/api/access-requests/${ID1}/resend-notice`, {}],
    ]) {
      expect((await w.call(m, p, null, { ...(body ? { body } : {}) })).status, `${m} ${p} signed out`).toBe(401);
      const r = await w.call(m, p, MEMBER, { ...(body ? { body } : {}) });
      expect(err(r), `${m} ${p}`).toEqual({ status: 403, error: "not_admin" });
    }
    expect(w.txns).toEqual([]);
    expect(w.sent).toEqual([]);
  });
});

describe("the queue and one request (IF-06: the requester's email is masked)", () => {
  it("masks an address to its first character plus the domain, and never to anything else", () => {
    expect(maskEmail("sam.synthetic@example.test")).toBe("s***@example.test");
    expect(maskEmail("a@b.test")).toBe("a***@b.test");
    expect(maskEmail("no-at-sign")).toBe("***");
    expect(maskEmail(undefined)).toBe("***");
  });

  it("lists pending oldest first, awaiting_record and done apart, with no email, and pages by an opaque cursor", async () => {
    const w = await world();
    w.seed({ id: ID1 });
    w.seed({ id: ID2, email: "two@example.test", emailHash: "h2" });
    w.seed({ id: ID3, email: "three@example.test", emailHash: "h3", state: "awaiting_record" });
    w.seed({ id: "01J00000000000000000000004", email: "four@example.test", emailHash: "h4", state: "declined" });
    w.seed({ id: "01J00000000000000000000005", email: "five@example.test", emailHash: "h5", state: "active" });
    const pending = await w.call("GET", "/api/access-requests", ADMIN);
    expect(pending.status).toBe(200);
    expect(pending.body.items.map((i) => i.id)).toEqual([ID1, ID2]);
    expect(pending.body.items[0]).toEqual({ id: ID1, state: "pending", createdAt: expect.any(String), givenNames: "Sam", maidenSurname: "Exampleton", birthYear: 1980, birthPlace: "Springfield, IL" });
    expect(pending.body.cursor).toBeNull();
    expect((await w.call("GET", "/api/access-requests", ADMIN, { query: { state: "awaiting_record" } })).body.items.map((i) => i.id)).toEqual([ID3]);
    const done = await w.call("GET", "/api/access-requests", ADMIN, { query: { state: "done", limit: "1" } });
    expect(done.body.items).toHaveLength(1);
    expect(done.body.cursor).toEqual(expect.any(String));
    const more = await w.call("GET", "/api/access-requests", ADMIN, { query: { state: "done", limit: "5", cursor: done.body.cursor } });
    expect(more.body.items).toHaveLength(1);
    expect(new Set([done.body.items[0].id, more.body.items[0].id])).toEqual(new Set(["01J00000000000000000000004", "01J00000000000000000000005"]));
    expect(JSON.stringify([pending.body, done.body, more.body])).not.toMatch(/@/);
    expect(LIST_STATES.done).toEqual(["active", "declined", "revoked", "expired"]);
  });

  it("rejects a bad state, limit or cursor (400) and hides an expired request", async () => {
    const w = await world();
    w.seed({ ttl: Math.floor(T0 / 1000) - 1 });
    expect(err(await w.call("GET", "/api/access-requests", ADMIN, { query: { state: "nope" } }))).toEqual({ status: 400, error: "validation" });
    expect(err(await w.call("GET", "/api/access-requests", ADMIN, { query: { limit: "500" } }))).toEqual({ status: 400, error: "validation" });
    expect(err(await w.call("GET", "/api/access-requests", ADMIN, { query: { cursor: "not-a-cursor" } }))).toEqual({ status: 400, error: "validation" });
    expect((await w.call("GET", "/api/access-requests", ADMIN)).body.items).toEqual([]);
    expect(err(await w.call("GET", `/api/access-requests/${ID1}`, ADMIN))).toEqual({ status: 404, error: "not_found" });
  });

  it("detail: the version, the answers, the Gramps preview (with the residence, Q2-11a) and the masked email; 404 for an unknown id", async () => {
    const w = await world();
    w.seed();
    const r = await w.call("GET", `/api/access-requests/${ID1}`, ADMIN);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: ID1, state: "pending", version: 1, email: "s***@example.test", form: FORM });
    expect(r.body.preview.person.primary_name).toMatchObject({ first_name: "Sam", nick: "Sammy" });
    expect(r.body.preview.events.map((e) => e.type.value)).toEqual([12, 42, 31]); // birth, residence (city and state only), graduation
    expect(r.body.preview.placeQueries.map((p) => p.role)).toEqual(["birth", "residence"]);
    expect(JSON.stringify(r.body)).not.toContain(EMAIL);
    expect(err(await w.call("GET", `/api/access-requests/${ID2}`, ADMIN))).toEqual({ status: 404, error: "not_found" });
    expect(err(await w.call("GET", "/api/access-requests/bad%20id", ADMIN))).toEqual({ status: 404, error: "not_found" });
  });

  it("no admin response ever holds a full address, whatever the route or the state (AC8)", async () => {
    const w = await world();
    w.seed();
    const seen = [];
    seen.push(await w.call("GET", "/api/access-requests", ADMIN), await w.call("GET", `/api/access-requests/${ID1}`, ADMIN));
    seen.push(await w.link(ADMIN, ID1));
    seen.push(await w.call("GET", `/api/access-requests/${ID1}`, ADMIN), await w.call("GET", "/api/access-requests", ADMIN, { query: { state: "done" } }));
    seen.push(await w.revoke(ADMIN, ID1));
    seen.push(await w.link(ADMIN, ID1, { version: 9 })); // a 409
    seen.push(await w.decide(ADMIN, ID1, { decision: "decline", version: 1 })); // a 409
    for (const r of seen) expect(JSON.stringify(r.body)).not.toMatch(/[A-Za-z0-9._+-]@/); // a masked address has *** before its @
    expect(seen.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200, 409, 409]);
  });

  it("every message to the requester is a system template; the mailer cannot be handed free text (AC8)", async () => {
    const w = await world();
    w.seed();
    await w.link(ADMIN, ID1);
    expect(w.sent.every((m) => TEMPLATE_IDS.includes(m.template))).toBe(true);
    const { text } = (await import("../src/shared/emails.mjs")).renderEmail("approved");
    expect(text).not.toMatch(/https?:/);
    expect(() => sendEmailInput({ from: "a@b.test", configurationSet: "set", template: "free-text", to: "c@d.test", vars: {} })).toThrow(/unknown email template/);
  });
});

describe("the link decision is ONE transaction (AC2)", () => {
  it("writes the ALLOW# item, updates the request on its state and version, and adds two AUDIT# items, all in one TransactWrite", async () => {
    const w = await world();
    w.seed();
    w.txns.length = 0;
    const r = await w.link(ADMIN, ID1);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ state: "active", emailSent: true });
    const linkTxns = w.txns.filter((x) => x.TransactItems.some((i) => i.Put?.Item?.PK === `ALLOW#${EMAIL}`));
    expect(linkTxns).toHaveLength(1); // (the facts proposal, below, is a separate system proposal)
    const items = linkTxns[0].TransactItems;
    expect(items).toHaveLength(4);
    const allowPut = items.find((i) => i.Put?.Item?.PK === `ALLOW#${EMAIL}`).Put;
    expect(allowPut.ConditionExpression).toBe("attribute_not_exists(PK) OR #state = :revoked");
    expect(allowPut.Item).toMatchObject({ SK: "META", entity: "allow", sub: LIVING, state: "active", source: "access-request", requestId: ID1, by: ADMIN, GSI1PK: `ALLOWSUB#${LIVING}`, GSI1SK: `ALLOW#${EMAIL}` });
    const upd = items.find((i) => i.Update).Update;
    expect(upd.Key).toEqual({ PK: `ACCESSREQ#${ID1}`, SK: "META" });
    expect(upd.ConditionExpression).toBe("#state = :expected AND #version = :v");
    expect(upd.ExpressionAttributeValues).toMatchObject({ ":expected": "pending", ":v": 1, ":next": "active", ":nv": 2 });
    const auditOps = items.filter((i) => i.Put?.Item?.PK.startsWith("AUDIT#")).map((i) => i.Put.Item.op).sort();
    expect(auditOps).toEqual(["accessreq.decide", "allow.grant"]);
    expect(w.req()).toMatchObject({ state: "active", version: 2, GSI1PK: "ACCESSREQS#active", decision: { kind: "link", by: ADMIN, grampsId: LIVING, confirmedOutside: true } });
    expect(w.req().ttl).toBe(Math.floor(T0 / 1000) + DECIDED_TTL_SECONDS);
    expect(DECIDED_TTL_SECONDS).toBe(30 * 86400);
    expect(w.allow()).toMatchObject({ state: "active", sub: LIVING });
  });

  it("records the 'confirmed outside the site' flag and the grant in the audit, with the sub and a hash, never the address", async () => {
    const w = await world();
    w.seed();
    await w.link(ADMIN, ID1);
    const [decide] = w.audits(`accessreq:${ID1}`);
    expect(decide).toMatchObject({ op: "accessreq.decide", principal: ADMIN, before: { state: "pending" }, after: { state: "active", decision: "link", sub: LIVING, confirmedOutside: true, secondEmail: false } });
    const [grant] = w.audits("allow:");
    expect(grant).toMatchObject({ op: "allow.grant", after: { sub: LIVING, state: "active", source: "access-request" } });
    expect(JSON.stringify(w.audits(""))).not.toContain(EMAIL);
  });

  it("an existing ACTIVE ALLOW# fails the whole transaction: the request stays pending, and nothing else is written", async () => {
    const w = await world();
    w.seed();
    // the route reads the item first (409 already_member); this is the race the condition exists for: the item turns active just before the write
    w.race.before = async () => {
      w.ddb.rows.set(`ALLOW#${EMAIL}\u0000META`, { ...grantItems({ email: EMAIL, sub: OTHER, source: "admin", at: "2026-01-01T00:00:00.000Z", by: ADMIN2, table: TABLE }).puts[0].item });
    };
    const r = await w.link(ADMIN, ID1);
    expect(err(r)).toEqual({ status: 409, error: "already_member" });
    expect(w.req()).toMatchObject({ state: "pending", version: 1, GSI1PK: "ACCESSREQS#pending" });
    expect(w.req()).not.toHaveProperty("decision");
    expect(w.allow()).toMatchObject({ sub: OTHER, by: ADMIN2 }); // the other grant, untouched
    expect(accessAudits(w)).toEqual([]); // not one audit item of the cancelled transaction
    expect(w.sent).toEqual([]);
  });

  it("the ALLOW# put is conditional: the transaction cancels as a whole when the item became active in between", async () => {
    const w = await world();
    w.seed();
    const items = grantItems({ email: EMAIL, sub: LIVING, source: "access-request", requestId: ID1, at: new Date(T0).toISOString(), by: ADMIN, uid: "u1", table: TABLE });
    w.ddb.rows.set(`ALLOW#${EMAIL}\u0000META`, { ...items.puts[0].item, sub: OTHER });
    const { transact } = await import("../src/txn.js");
    const upd = {
      key: { PK: `ACCESSREQ#${ID1}`, SK: "META" }, update: "SET #state = :next", condition: "#state = :expected AND #version = :v",
      names: { "#state": "state", "#version": "version" }, values: { ":next": "active", ":expected": "pending", ":v": 1 },
    };
    const err2 = await transact(w.ddb, cmds, TABLE, { ...items, updates: [upd] }).catch((e) => e);
    expect(err2).toMatchObject({ name: "TxnCancelled", conditionFailed: true });
    expect(err2.failures.map((f) => f.tag)).toContain("allow.grant");
    expect(w.req().state).toBe("pending"); // the request update rolled back with it
    expect(w.audits("allow:")).toEqual([]);
  });

  it("a second admin acting on the same version loses with 409 conflict and writes nothing", async () => {
    const w = await world();
    w.seed();
    expect((await w.link(ADMIN, ID1)).status).toBe(200);
    const again = await w.link(ADMIN2, ID1);
    expect(err(again)).toEqual({ status: 409, error: "conflict" });
    expect(again.body.details.current).toEqual({ state: "active", version: 2 });
    expect(err(await w.link(ADMIN2, ID1, { version: 2 }))).toEqual({ status: 409, error: "conflict" }); // active is not a state a link can leave
  });

  it("a stale version is 409, and so is a lost write race (the version moved after the read): the request, the allowlist and the audit are untouched", async () => {
    const w = await world();
    w.seed();
    expect(err(await w.link(ADMIN, ID1, { version: 7 }))).toEqual({ status: 409, error: "conflict" });
    expect(w.txns).toEqual([]);
    w.race.before = async () => { w.ddb.rows.set(`ACCESSREQ#${ID1}\u0000META`, { ...w.req(), version: 2 }); };
    expect(err(await w.link(ADMIN, ID1))).toEqual({ status: 409, error: "conflict" });
    expect(w.req()).toMatchObject({ state: "pending", version: 2 });
    expect(w.allow()).toBeUndefined();
    expect(accessAudits(w)).toEqual([]);
    expect(w.sent).toEqual([]);
  });

  it("an existing active ALLOW# for the address, or the address in io's file, is 409 already_member before anything is written", async () => {
    const w = await world();
    w.seed();
    w.ddb.rows.set(`ALLOW#${EMAIL}\u0000META`, { ...grantItems({ email: EMAIL, sub: OTHER, source: "admin", at: "2026-01-01T00:00:00.000Z", by: ADMIN2, table: TABLE }).puts[0].item });
    expect(err(await w.link(ADMIN, ID1))).toEqual({ status: 409, error: "already_member" });
    w.fileEntries.set(OLD_EMAIL, { sub: HAS_EMAIL });
    const w2 = await world();
    w2.seed({ email: OLD_EMAIL, emailHash: "hold" });
    expect(err(await w2.link(ADMIN, ID1))).toEqual({ status: 409, error: "already_member" });
    expect(w2.txns).toEqual([]);
  });

  it("a revoked ALLOW# can be granted again (the condition allows it)", async () => {
    const w = await world();
    w.seed();
    w.ddb.rows.set(`ALLOW#${EMAIL}\u0000META`, { ...grantItems({ email: EMAIL, sub: OTHER, source: "admin", at: "2026-01-01T00:00:00.000Z", by: ADMIN2, table: TABLE }).puts[0].item, state: "revoked" });
    expect((await w.link(ADMIN, ID1)).status).toBe(200);
    expect(w.allow()).toMatchObject({ state: "active", sub: LIVING });
  });
});

describe("link refusals (AC6): step-up, the confirmation flag, living", () => {
  it("needs a sign-in within 900 s: 401 step_up_required for a stale or missing auth_time, and nothing is written", async () => {
    const w = await world();
    w.seed();
    expect(err(await w.link(ADMIN, ID1, {}, { fresh: false }))).toEqual({ status: 401, error: "step_up_required" });
    expect(err(await w.link(ADMIN, ID1, {}, { ageSeconds: 901 }))).toEqual({ status: 401, error: "step_up_required" });
    const noClaim = await signToken(ADMIN); // no auth_time claim at all
    expect(err(await w.call("POST", `/api/access-requests/${ID1}/decision`, null, { body: { decision: "link", grampsId: LIVING, version: 1, confirmedOutside: true } }))).toEqual({ status: 401, error: "unauthenticated" });
    expect((await w.handler({ requestContext: { http: { method: "POST" } }, rawPath: `/api/access-requests/${ID1}/decision`, headers: { "content-type": "application/json" }, cookies: [`io_id=${noClaim}`], body: JSON.stringify({ decision: "link", grampsId: LIVING, version: 1, confirmedOutside: true }) })).statusCode).toBe(401);
    expect((await w.link(ADMIN, ID1, {}, { ageSeconds: 899 })).status).toBe(200);
    expect(w.sent.length).toBe(1);
  });

  it("requires the 'confirmed with this person outside the site' flag, true, for link, new and revoke", async () => {
    const w = await world();
    w.seed();
    for (const confirmedOutside of [undefined, false, "yes", 1]) {
      const r = await w.link(ADMIN, ID1, { confirmedOutside });
      expect(err(r), String(confirmedOutside)).toEqual({ status: 400, error: "validation" });
      expect(r.body.errors.map((e) => e.pointer)).toEqual(["/confirmedOutside"]);
    }
    expect(err(await w.decide(ADMIN, ID1, { decision: "new", preview: {}, version: 1 }))).toEqual({ status: 400, error: "validation" });
    expect(err(await w.revoke(ADMIN, ID1, { confirmedOutside: false }))).toEqual({ status: 400, error: "validation" });
    expect(w.txns).toEqual([]);
  });

  it("422 unknown_person for a person the site does not have, 422 not_living when the page says so or the record store holds a death event", async () => {
    const w = await world();
    w.seed();
    expect(err(await w.link(ADMIN, ID1, { grampsId: GHOST }))).toEqual({ status: 422, error: "unknown_person" });
    expect(err(await w.link(ADMIN, ID1, { grampsId: NOT_LIVING }))).toEqual({ status: 422, error: "not_living" });
    expect(err(await w.link(ADMIN, ID1, { grampsId: DEAD_IN_STORE }))).toEqual({ status: 422, error: "not_living" });
    expect(w.req()).toMatchObject({ state: "pending", version: 1 });
    expect(w.allow()).toBeUndefined();
  });

  it("a person lookup that fails is 503, never a wrong 422; an answer without isLiving true is not living", async () => {
    const w = await world();
    w.seed();
    w.facts[LIVING] = {};
    expect(err(await w.link(ADMIN, ID1))).toEqual({ status: 422, error: "not_living" });
    const w2 = makeApi({ admins: [ADMIN], log: q, clock: () => Date.now(), flags: { accessRequests: true }, extraDeps: { personFacts: async () => { throw new Error("S3 down"); }, txnOpts: { sleep: async () => {} } } });
    const t = await signToken(ADMIN, { authTime: Math.floor(Date.now() / 1000) - 10 });
    w2.ddb.rows.set(`ACCESSREQ#${ID1}\u0000META`, { PK: `ACCESSREQ#${ID1}`, SK: "META", entity: "accessreq", id: ID1, state: "pending", version: 1, email: EMAIL, emailHash: "x", form: FORM, GSI1PK: "ACCESSREQS#pending", GSI1SK: ID1 });
    const r = await w2.call("POST", `/api/access-requests/${ID1}/decision`, { token: t, body: { decision: "link", grampsId: LIVING, version: 1, confirmedOutside: true } });
    expect(err(r)).toEqual({ status: 503, error: "unavailable" });
  });

  it("validates the body field by field (400 with pointers, no echo)", async () => {
    const w = await world();
    w.seed();
    const bad = [
      [{ decision: "nope", version: 1 }, "/decision"],
      [{ decision: "link", version: 0, grampsId: LIVING, confirmedOutside: true }, "/version"],
      [{ decision: "link", version: 1, grampsId: "bad id!", confirmedOutside: true }, "/grampsId"],
      [{ decision: "link", version: 1, grampsId: LIVING, confirmedOutside: true, extra: 1 }, "/extra"],
      [{ decision: "link", version: 1, grampsId: LIVING, confirmedOutside: true, allowSecondEmail: "yes" }, "/allowSecondEmail"],
      [{ decision: "decline", version: 1, note: 5 }, "/note"],
      [{ decision: "decline", version: 1, note: "x".repeat(501) }, "/note"],
      [{ decision: "decline", version: 1, sendNote: "yes" }, "/sendNote"],
      [{ decision: "decline", version: 1, grampsId: LIVING }, "/grampsId"],
    ];
    for (const [body, pointer] of bad) {
      const r = await w.decide(ADMIN, ID1, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.errors.map((e) => e.pointer)).toContain(pointer);
    }
    expect(() => parseDecision(null)).toThrow();
    expect(w.txns).toEqual([]);
  });
});

describe("a 'new' decision files a person.create system proposal (AC3)", () => {
  it("files a create proposal through proposals.createSystem and sets awaiting_record (the proposal first, then one guarded transaction)", async () => {
    const w = await world();
    w.seed();
    const detail = await w.call("GET", `/api/access-requests/${ID1}`, ADMIN);
    w.txns.length = 0;
    const r = await w.decide(ADMIN, ID1, { decision: "new", preview: detail.body.preview, version: 1, confirmedOutside: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ state: "awaiting_record", emailSent: true, proposalId: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/) });
    const p = await loadProposal(w.storeCtx, r.body.proposalId);
    expect(p).toMatchObject({ state: "pending", kind: "create", origin: "access_request", request_id: ID1, proposer: { id: "system:access_request" } });
    expect(p.ops.map((o) => [o.op, o.cls])).toEqual([["create", "Person"], ["create", "Event"], ["create", "Event"], ["create", "Event"]]);
    expect(p.ops[0].value.primary_name).toMatchObject({ first_name: "Sam", nick: "Sammy" });
    expect(p.ops[0].value.gramps_id).toBe(""); // the approval mints it
    expect(w.req()).toMatchObject({ state: "awaiting_record", version: 2, proposalId: r.body.proposalId, GSI1PK: "ACCESSREQS#awaiting_record", decision: { kind: "new", by: ADMIN, confirmedOutside: true } });
    expect(w.req().ttl).toBe(Math.floor(T0 / 1000) + AWAITING_TTL_SECONDS);
    expect(w.sent.map((m) => [m.template, m.to])).toEqual([["awaiting_record", EMAIL]]);
    const [decide] = w.audits(`accessreq:${ID1}`);
    expect(decide).toMatchObject({ op: "accessreq.decide", after: { state: "awaiting_record", decision: "new", proposalId: r.body.proposalId, confirmedOutside: true } });
    expect(w.allow()).toBeUndefined(); // nobody can sign in yet
  });

  it("builds the ops from the preview field by field: nothing beyond the Gramps-mapped facts reaches the store, and the server owns the derived members", () => {
    const { ops } = opsFromPreview({
      person: { _class: "Person", gender: 0, handle: "forged", gramps_id: "I1", private: true, attribute_list: [{ forged: true }], birth_ref_index: 9, change: 1,
        primary_name: { _class: "Name", first_name: " Sam ", nick: "Sammy", surname_list: [{ surname: " Exampleton " }], display_as: 3 }, event_ref_list: [{ ref: "b" }] },
      events: [{ _class: "Event", hfyKey: "b", type: { value: 12 }, date: { dateval: [3, 4, 1980, false], modifier: 0 }, description: "x", needsReview: true }],
    }, { nowYear: 2026 });
    expect(ops).toHaveLength(2);
    const person = ops[0].value;
    expect(person).not.toHaveProperty("handle");
    expect(person).not.toHaveProperty("birth_ref_index");
    expect(person).not.toHaveProperty("change");
    expect(person.gramps_id).toBe("");
    expect(person.private).toBe(false);
    expect(person.attribute_list).toEqual([]);
    expect(person.primary_name).toMatchObject({ first_name: "Sam", nick: "Sammy" });
    expect(person.primary_name).not.toHaveProperty("display_as");
    expect(person.primary_name.surname_list[0].surname).toBe("Exampleton");
    expect(person.event_ref_list.map((r) => r.ref)).toEqual(["new:2"]);
    expect(ops[1].value.date.dateval).toEqual([0, 0, 1980, false]); // the day and the month are dropped
    expect(ops[1].value).not.toHaveProperty("needsReview");
  });

  it("refuses a bad preview (400 with pointers): no person, two births, an odd event type, a bad year, a place that is not a handle", () => {
    const base = () => ({ person: { _class: "Person", gender: 1, primary_name: { first_name: "Sam", surname_list: [{ surname: "Ex" }] } }, events: [{ hfyKey: "b", type: { value: 12 }, date: { dateval: [0, 0, 1980, false] } }] });
    const opts = { nowYear: 2026 };
    expect(() => opsFromPreview(base(), opts)).not.toThrow();
    const pointers = (p) => { try { opsFromPreview(p, opts); return []; } catch (e) { return e.errors.map((x) => x.pointer); } };
    expect(pointers({ ...base(), person: undefined })).toContain("/preview/person");
    expect(pointers({ ...base(), events: [] })).toContain("/preview/events");
    expect(pointers({ ...base(), events: [...base().events, { hfyKey: "c", type: { value: 12 } }] })).toContain("/preview/events");
    expect(pointers({ ...base(), events: [{ hfyKey: "b", type: { value: 99 } }] })).toContain("/preview/events/0/type");
    expect(pointers({ ...base(), events: [{ hfyKey: "b", type: { value: 12 }, date: { dateval: [0, 0, 1650, false] } }] })).toContain("/preview/events/0/date");
    expect(pointers({ ...base(), events: [{ hfyKey: "b", type: { value: 12 }, place: "../etc" }] })).toContain("/preview/events/0/place");
    expect(pointers({ ...base(), person: { ...base().person, gender: 9 } })).toContain("/preview/person/gender");
    expect(pointers({ ...base(), events: [{ hfyKey: "b", type: { value: 12 } }, { hfyKey: "b", type: { value: 42 } }] })).toContain("/preview/events/1");
  });

  it("a place on an event must exist (400 otherwise); contact text in the preview is refused by the guard (422) and files nothing", async () => {
    const w = await world();
    w.seed();
    const detail = (await w.call("GET", `/api/access-requests/${ID1}`, ADMIN)).body;
    const withPlace = structuredClone(detail.preview);
    withPlace.events[0].place = h(9999);
    expect(err(await w.decide(ADMIN, ID1, { decision: "new", preview: withPlace, version: 1, confirmedOutside: true }))).toEqual({ status: 400, error: "validation" });
    const phone = structuredClone(detail.preview);
    phone.person.primary_name.nick = "call 503 555 0100";
    expect(err(await w.decide(ADMIN, ID1, { decision: "new", preview: phone, version: 1, confirmedOutside: true }))).toEqual({ status: 422, error: "contact_info" });
    expect(w.req()).toMatchObject({ state: "pending", version: 1 });
    expect(w.sent).toEqual([]);
  });

  it("end to end: approving the proposal mints the gramps_id (Q2-03) and the approval transaction links the request; the mail goes after the commit", async () => {
    const w = await world();
    w.seed();
    const detail = (await w.call("GET", `/api/access-requests/${ID1}`, ADMIN)).body;
    const made = await w.decide(ADMIN, ID1, { decision: "new", preview: detail.preview, version: 1, confirmedOutside: true });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    const proposal = await loadProposal(w.storeCtx, made.body.proposalId);
    w.sent.length = 0;
    w.txns.length = 0;
    const token = await w.token(ADMIN2);
    const r = await w.handler({
      requestContext: { http: { method: "POST" } }, rawPath: `/api/proposals/${proposal.id}/decision`, cookies: [`io_id=${token}`],
      headers: { "content-type": "application/json", "if-match": `"${proposal.etag}"`, "idempotency-key": "approve-1" }, body: JSON.stringify({ verdict: "approve" }),
    });
    expect(r.statusCode, r.body).toBe(200);
    const body = JSON.parse(r.body);
    const createdKey = Object.keys(body.applied.versions).find((k) => k.startsWith("Person:"));
    const minted = JSON.parse(w.ddb.rows.get(`REC#Person#${createdKey.slice(7)}\u0000HEAD`).obj_json).gramps_id;
    expect(minted).toMatch(/^I8\d{3}$/);
    // one transaction: the records, the proposal, the audit AND the link
    const approvalTxn = w.txns.filter((x) => x.TransactItems.some((i) => i.Put?.Item?.PK?.startsWith("PROP#")));
    expect(approvalTxn).toHaveLength(1);
    expect(approvalTxn[0].TransactItems.some((i) => i.Put?.Item?.PK === `ALLOW#${EMAIL}`)).toBe(true);
    expect(approvalTxn[0].TransactItems.some((i) => i.Update?.Key?.PK === `ACCESSREQ#${ID1}`)).toBe(true);
    expect(w.allow()).toMatchObject({ state: "active", sub: minted, source: "access-request", requestId: ID1, by: ADMIN });
    expect(w.req()).toMatchObject({ state: "active", decision: { kind: "link", via: "record", grampsId: minted, by: ADMIN, completedBy: ADMIN2 } });
    expect(w.audits(`accessreq:${ID1}`).map((a) => a.op).sort()).toEqual(["accessreq.decide", "accessreq.decide"]);
    expect(w.sent.map((m) => [m.template, m.to])).toEqual([["approved", EMAIL]]);
  });

  const approveVia = async (w, proposal, who = ADMIN2, key = "approve-x", opts) => w.handler({
    requestContext: { http: { method: "POST" } }, rawPath: `/api/proposals/${proposal.id}/decision`, cookies: [`io_id=${await w.token(who, opts)}`],
    headers: { "content-type": "application/json", "if-match": `"${proposal.etag}"`, "idempotency-key": key }, body: JSON.stringify({ verdict: "approve" }),
  });
  const awaiting = async (w) => {
    const detail = (await w.call("GET", `/api/access-requests/${ID1}`, ADMIN)).body;
    const made = await w.decide(ADMIN, ID1, { decision: "new", preview: detail.preview, version: 1, confirmedOutside: true });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    return made.body.proposalId;
  };

  it("when the request is declined meanwhile, its system proposal is withdrawn: nobody can approve it into a Person with no request", async () => {
    const w = await world();
    w.seed();
    const id = await awaiting(w);
    expect((await w.decide(ADMIN, ID1, { decision: "decline", version: 2 })).status).toBe(200);
    expect(await loadProposal(w.storeCtx, id)).toMatchObject({ state: "withdrawn" });
    const r = await approveVia(w, await loadProposal(w.storeCtx, id));
    expect(r.statusCode, r.body).toBe(409);
    expect(JSON.parse(r.body).error).toBe("invalid_state");
    expect(w.allow()).toBeUndefined();
    expect(w.req().state).toBe("declined");
    expect(w.audits(`proposal:${id}`).map((a) => a.op)).toContain("proposal.withdraw");
  });

  it("a request that is no longer awaiting_record links nothing (completeAccessRequest is null), so an approval that got through still commits alone", async () => {
    const w = await world();
    w.seed({ state: "declined" });
    const domain = createAccessRequests({ ddb: w.ddb, cmds, table: TABLE, now: () => w.clock.t, uid: () => "u1", log: q });
    expect(await domain.completeAccessRequest({ requestId: ID1, grampsId: "I8001" })).toBeNull();
    expect(await domain.completeAccessRequest({ requestId: "01J00000000000000000000999", grampsId: "I8001" })).toBeNull();
  });

  it("a manual link from awaiting_record withdraws the pending system proposal, so a later approval cannot mint a second Person", async () => {
    const w = await world();
    w.seed();
    const id = await awaiting(w);
    const people = () => [...w.ddb.rows.keys()].filter((k) => k.startsWith("REC#Person#") && k.endsWith("HEAD")).length;
    const before = people();
    const r = await w.link(ADMIN, ID1, { version: 2 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await loadProposal(w.storeCtx, id)).toMatchObject({ state: "withdrawn" });
    const approve = await approveVia(w, await loadProposal(w.storeCtx, id));
    expect(approve.statusCode).toBe(409);
    expect(people()).toBe(before); // nothing was minted
    expect(w.allow()).toMatchObject({ sub: LIVING, state: "active" });
  });

  it("withdrawSystem moves only an open system proposal: a decided, missing or member's proposal is left alone", async () => {
    const w = await world();
    w.seed();
    const id = await awaiting(w);
    expect(await withdrawSystem(w.storeCtx, id)).toBe(true);
    expect(await withdrawSystem(w.storeCtx, id)).toBe(false); // already withdrawn
    expect(await withdrawSystem(w.storeCtx, "01J00000000000000000000999")).toBe(false);
    expect(await withdrawSystem(w.storeCtx, "not-an-id")).toBe(false);
  });

  it("a 'new' that loses the race to another admin's link withdraws the proposal it filed; a retry after a busy store keeps it", async () => {
    const w = await world();
    w.seed();
    const detail = (await w.call("GET", `/api/access-requests/${ID1}`, ADMIN)).body;
    const body = { decision: "new", preview: detail.preview, version: 1, confirmedOutside: true };
    // the first transaction is the proposal's own; the second is the guarded commit: the version moves just before it (another admin decided)
    w.race.before = async () => { w.race.before = async () => { w.ddb.rows.set(`ACCESSREQ#${ID1}\u0000META`, { ...w.req(), state: "active", version: 2, GSI1PK: "ACCESSREQS#active" }); }; };
    expect(err(await w.decide(ADMIN, ID1, body))).toEqual({ status: 409, error: "conflict" });
    const orphan = [...w.ddb.rows.values()].find((r) => r.entity === "proposal" && r.SK === "META").proposal;
    expect(orphan.state).toBe("withdrawn");
    // a busy store (503) is different: the request is unchanged, the proposal stays, and a retry with the same preview finds it
    const w2 = await world();
    w2.seed();
    const d2 = (await w2.call("GET", `/api/access-requests/${ID1}`, ADMIN)).body;
    const b2 = { decision: "new", preview: d2.preview, version: 1, confirmedOutside: true };
    const realSend = w2.ddb.send.bind(w2.ddb);
    let n = 0;
    w2.ddb.send = async (cmd) => {
      if (cmd.constructor.name === "TransactWriteCommand" && ++n >= 2) throw Object.assign(new Error("busy"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "TransactionConflict" }] });
      return realSend(cmd);
    };
    const busy = await w2.decide(ADMIN, ID1, b2);
    expect(busy.status).toBe(503);
    const kept = [...w2.ddb.rows.values()].find((r) => r.entity === "proposal" && r.SK === "META").proposal;
    expect(kept.state).toBe("pending");
    w2.ddb.send = realSend;
    const again = await w2.decide(ADMIN, ID1, b2);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.proposalId).toBe(kept.id);
    // ... while a retry with a CORRECTED preview is refused outright (422), never answered with the first proposal in disguise
    const w3 = await world();
    w3.seed();
    const d3 = (await w3.call("GET", `/api/access-requests/${ID1}`, ADMIN)).body;
    expect((await w3.decide(ADMIN, ID1, { decision: "new", preview: d3.preview, version: 1, confirmedOutside: true })).status).toBe(200);
    w3.ddb.rows.set(`ACCESSREQ#${ID1}\u0000META`, { ...w3.req(), state: "pending", version: 1, GSI1PK: "ACCESSREQS#pending" }); // as if the commit never happened
    const fixed = structuredClone(d3.preview);
    fixed.person.primary_name.first_name = "Samantha";
    expect(err(await w3.decide(ADMIN, ID1, { decision: "new", preview: fixed, version: 1, confirmedOutside: true }))).toEqual({ status: 422, error: "idempotency_mismatch" });
  });

  it("a 'new' whose request commit failed (busy 503, or an error 500) leaves a proposal the request never recorded: a link or a decline instead of a retry withdraws it, so no Person is minted for no request", async () => {
    const busy = () => Object.assign(new Error("busy"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "TransactionConflict" }] });
    const broken = () => Object.assign(new Error("socket hang up"), { name: "TimeoutError" });
    for (const [then, failure, status] of [["link", busy, 503], ["decline", broken, 500], ["link", broken, 500], ["decline", busy, 503]]) {
      const at = `${then} after ${status}`;
      const w = await world();
      w.seed();
      const detail = (await w.call("GET", `/api/access-requests/${ID1}`, ADMIN)).body;
      const realSend = w.ddb.send.bind(w.ddb);
      let n = 0;
      // the first transaction files the proposal; every later one (the request's guarded commit and its retries) fails
      w.ddb.send = async (cmd) => {
        if (cmd.constructor.name === "TransactWriteCommand" && ++n >= 2) throw failure();
        return realSend(cmd);
      };
      expect((await w.decide(ADMIN, ID1, { decision: "new", preview: detail.preview, version: 1, confirmedOutside: true })).status, at).toBe(status);
      w.ddb.send = realSend;
      expect(w.req(), at).toMatchObject({ state: "pending", version: 1 });
      expect(w.req(), at).not.toHaveProperty("proposalId"); // the request never learnt of it
      const filed = await systemProposalOf(w.storeCtx, ID1);
      expect((await loadProposal(w.storeCtx, filed)).state, at).toBe("pending"); // kept for a retry
      const people = () => [...w.ddb.rows.keys()].filter((k) => k.startsWith("REC#Person#") && k.endsWith("HEAD")).length;
      const before = people();
      const r = then === "link" ? await w.link(ADMIN, ID1) : await w.decide(ADMIN, ID1, { decision: "decline", version: 1 });
      expect(r.status, `${at}: ${JSON.stringify(r.body)}`).toBe(200);
      expect((await loadProposal(w.storeCtx, filed)).state, at).toBe("withdrawn");
      expect(w.audits(`proposal:${filed}`).map((a) => a.op), at).toContain("proposal.withdraw");
      const approve = await approveVia(w, await loadProposal(w.storeCtx, filed), ADMIN2, `approve-${then}-${status}`);
      expect(approve.statusCode, at).toBe(409);
      expect(JSON.parse(approve.body).error, at).toBe("invalid_state");
      expect(people(), at).toBe(before); // nothing was minted
    }
    // a link or decline of a request that never filed anything looks the request id up and withdraws nothing
    expect(await systemProposalOf((await world()).storeCtx, ID2)).toBeNull();
    expect(await systemProposalOf((await world()).storeCtx, "not an id")).toBeNull();
  });

  it("approving the Person an access request asked for needs a sign-in within 900 s: a stale session cannot activate access (401 step_up_required)", async () => {
    const w = await world();
    w.seed();
    const id = await awaiting(w);
    const proposal = await loadProposal(w.storeCtx, id);
    w.txns.length = 0;
    const stale = await approveVia(w, proposal, ADMIN2, "approve-stale", { fresh: false });
    expect(stale.statusCode, stale.body).toBe(401);
    expect(JSON.parse(stale.body).error).toBe("step_up_required");
    expect(w.txns).toEqual([]);
    expect(w.allow()).toBeUndefined();
    expect(w.req().state).toBe("awaiting_record");
    expect((await approveVia(w, proposal, ADMIN2, "approve-fresh")).statusCode).toBe(200); // the same proposal with a fresh sign-in
    expect(w.allow()).toMatchObject({ state: "active" });
  });

  it("assign mode finds the awaiting request however long the queue is: more than one page of awaiting requests is paged through", async () => {
    const w = await world();
    for (let i = 1; i <= 105; i += 1) {
      const id = `01J00000000000000000${String(i).padStart(6, "0")}`;
      w.seed({ id, state: "awaiting_record", proposalId: `01J00000000000000000P${String(i).padStart(5, "0")}`, emailHash: `h${i}`, email: `req${i}@example.test` });
    }
    const real = "01J0000000000000000999999Z".slice(0, 26);
    w.seed({ id: real, state: "awaiting_record", proposalId: ID3, emailHash: "h-real", email: "real@example.test" }); // sorts after the first 100
    const proposal = { id: ID3, state: "approved", decision: { verdict: "approve", applied: { "Person:forced-handle-0002": 1 } }, targets: [], proposer: { id: "system:access_request" } };
    w.ddb.rows.set(`PROP#${ID3}\u0000META`, { PK: `PROP#${ID3}`, SK: "META", entity: "proposal", proposal });
    const domain = createAccessRequests({ ddb: w.ddb, cmds, table: TABLE, now: () => w.clock.t, uid: () => "u1", log: q });
    expect(await domain.accessRequestOf({ class: "Person", handle: "forced-handle-0002", store: w.storeCtx })).toBe(real);
  });
  it("otherwise a later link from awaiting_record works (no gramps_id minted yet)", async () => {
    const w = await world();
    w.seed({ state: "awaiting_record", version: 2, proposalId: "01J0000000000000000000PROP" });
    const r = await w.link(ADMIN, ID1, { version: 2 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(w.req()).toMatchObject({ state: "active", version: 3 });
    expect(w.allow()).toMatchObject({ sub: LIVING, state: "active" });
    expect(w.sent.map((m) => m.template)).toEqual(["approved"]);
  });

  it("assign mode (the desktop assigns the id later): the policy hooks find the awaiting request by the Person the approval created and link it", async () => {
    const w = await world();
    w.seed();
    const detail = (await w.call("GET", `/api/access-requests/${ID1}`, ADMIN)).body;
    const made = await w.decide(ADMIN, ID1, { decision: "new", preview: detail.preview, version: 1, confirmedOutside: true });
    // approve under assign mode: no id is minted, so the approval links nothing
    const w2 = w; // same table; a handler whose policy is assign
    const proposal = await loadProposal(w.storeCtx, made.body.proposalId);
    const personKey = "Person:forced-handle-0001";
    w.ddb.rows.set(`PROP#${proposal.id}\u0000META`, { ...w.ddb.rows.get(`PROP#${proposal.id}\u0000META`), proposal: { ...proposal, state: "approved", decision: { verdict: "approve", applied: { [personKey]: 1 } } } });
    const domain = createAccessRequests({ ddb: w.ddb, cmds, table: TABLE, now: () => w.clock.t, uid: (() => { let n = 0; return () => `u${++n}`; })(), mailer: { send: async (m) => { w.sent.push(m); } }, log: q });
    expect(w2).toBe(w);
    expect(await domain.accessRequestOf({ class: "Person", handle: "forced-handle-0001", store: w.storeCtx })).toBe(ID1);
    expect(await domain.accessRequestOf({ class: "Person", handle: "other-handle", store: w.storeCtx })).toBeUndefined();
    expect(await domain.accessRequestOf({ class: "Family", handle: "forced-handle-0001", store: w.storeCtx })).toBeUndefined();
    w.sent.length = 0;
    // the policy's own post-commit step, as applyBatch runs it for a desktop assignment
    const policy = createIdPolicy({ mode: "assign", accessRequestOf: domain.accessRequestOf, completeAccessRequest: domain.completeById });
    const warned = [];
    await completeAssignments({ policy, assigned: [{ class: "Person", handle: "forced-handle-0001", gramps_id: "I0123" }, { class: "Family", handle: "x", gramps_id: "F1" }], store: w.storeCtx, log: { warn: (...a) => warned.push(a) }, safe: (e) => e });
    expect(warned).toEqual([]);
    expect(w.req()).toMatchObject({ state: "active", decision: { grampsId: "I0123", via: "record" } });
    expect(w.sent.map((m) => m.template)).toEqual(["approved"]);
    w.sent.length = 0;
    w.ddb.rows.set(`ACCESSREQ#${ID1}\u0000META`, { ...w.req(), state: "awaiting_record", GSI1PK: "ACCESSREQS#awaiting_record" });
    w.ddb.rows.delete("ALLOW#" + EMAIL + "\u0000META");
    expect(await domain.completeById(ID1, "I0123")).toBe(true);
    expect(w.allow()).toMatchObject({ state: "active", sub: "I0123", by: ADMIN });
    expect(w.req()).toMatchObject({ state: "active", decision: { grampsId: "I0123" } });
    expect(w.sent.map((m) => m.template)).toEqual(["approved"]);
    expect(await domain.completeById(ID1, "I0123")).toBe(false); // a repeat links nothing
  });
});

describe("decline (AC4)", () => {
  it("sets declined with a 30 day TTL, mirrors the duplicate guard in the same transaction, and sends the declined template", async () => {
    const w = await world();
    w.seed();
    w.txns.length = 0;
    const r = await w.decide(ADMIN, ID1, { decision: "decline", version: 1 });
    expect(r.body).toEqual({ state: "declined", emailSent: true });
    expect(w.txns).toHaveLength(1);
    expect(w.req()).toMatchObject({ state: "declined", version: 2, GSI1PK: "ACCESSREQS#declined", decision: { kind: "decline", by: ADMIN, noteSent: false } });
    expect(w.req().ttl).toBe(Math.floor(T0 / 1000) + 30 * 86400);
    expect(w.row(`ACCESSREQEMAIL#hash-${ID1}`)).toMatchObject({ state: "declined", ttl: Math.floor(T0 / 1000) + 30 * 86400 }); // the address may ask again
    expect(w.sent).toEqual([{ template: "declined", to: EMAIL, vars: {} }]);
    expect(w.allow()).toBeUndefined();
  });

  it("emails the note only when sendNote is set; the note is kept for the admin either way", async () => {
    const w = await world();
    w.seed();
    await w.decide(ADMIN, ID1, { decision: "decline", version: 1, note: "please ask the person who told you about us", sendNote: true });
    expect(w.sent).toEqual([{ template: "declined", to: EMAIL, vars: { note: "please ask the person who told you about us" } }]);
    const w2 = await world();
    w2.seed();
    await w2.decide(ADMIN, ID1, { decision: "decline", version: 1, note: "private reminder", sendNote: false });
    expect(w2.sent).toEqual([{ template: "declined", to: EMAIL, vars: {} }]);
    expect(w2.req().decision).toMatchObject({ note: "private reminder", noteSent: false });
  });

  it("scans the note with the R-18 guard: contact text is 422 and nothing is written or sent", async () => {
    const w = await world();
    w.seed();
    for (const note of ["call me on 503 555 0100", "write to someone.synthetic@example.test", "visit 12 Main Street"]) {
      const r = await w.decide(ADMIN, ID1, { decision: "decline", version: 1, note, sendNote: true });
      expect(r.status, note).toBe(422);
      expect(r.body.error).toMatch(/contact_info|dob_not_allowed/);
      expect(JSON.stringify(r.body)).not.toContain("555");
    }
    expect(w.req()).toMatchObject({ state: "pending", version: 1 });
    expect(w.sent).toEqual([]);
  });

  it("when the mailer fails the state still commits and the answer is emailSent:false", async () => {
    const w = await world({ mailFails: true });
    w.seed();
    const r = await w.decide(ADMIN, ID1, { decision: "decline", version: 1, note: "a note", sendNote: true });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ state: "declined", emailSent: false });
    expect(w.req().state).toBe("declined");
    // the same for a link
    const w2 = await world({ mailFails: true });
    w2.seed();
    expect((await w2.link(ADMIN, ID1)).body).toEqual({ state: "active", emailSent: false });
    expect(w2.allow()).toMatchObject({ state: "active" });
  });

  it("without a mailer at all (SES not configured) the decision commits and says emailSent:false", async () => {
    const w = makeApi({ admins: [ADMIN], log: q, flags: { accessRequests: true }, extraDeps: { txnOpts: { sleep: async () => {} } } });
    w.ddb.rows.set(`ACCESSREQ#${ID1}\u0000META`, { PK: `ACCESSREQ#${ID1}`, SK: "META", entity: "accessreq", id: ID1, state: "pending", version: 1, email: EMAIL, emailHash: "x", form: FORM, GSI1PK: "ACCESSREQS#pending", GSI1SK: ID1 });
    const t = await signToken(ADMIN);
    const r = await w.call("POST", `/api/access-requests/${ID1}/decision`, { token: t, body: { decision: "decline", version: 1 } });
    expect(r.body).toEqual({ state: "declined", emailSent: false });
  });

  it("can decline an awaiting_record request, but not an active or declined one", async () => {
    const w = await world();
    w.seed({ state: "awaiting_record", version: 2 });
    expect((await w.decide(ADMIN, ID1, { decision: "decline", version: 2 })).status).toBe(200);
    expect(err(await w.decide(ADMIN, ID1, { decision: "decline", version: 3 }))).toEqual({ status: 409, error: "conflict" });
  });
});

describe("revoke (AC4)", () => {
  it("sets ALLOW# and the request to revoked in one transaction (no mail), and the address cannot sign in afterwards even if io's file lists it", async () => {
    const w = await world();
    w.seed();
    expect((await w.link(ADMIN, ID1)).status).toBe(200);
    expect(isAllowedNow(w.allow(), T0)).toBe(true);
    w.sent.length = 0;
    w.txns.length = 0;
    w.clock.t += 60_000;
    const r = await w.revoke(ADMIN2, ID1, { reason: "wrong person" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ state: "revoked" });
    expect(w.txns).toHaveLength(1);
    expect(w.sent).toEqual([]); // no email on a revoke
    expect(w.allow()).toMatchObject({ state: "revoked", sub: LIVING, revokedBy: ADMIN2 });
    expect(w.allow().GSI1PK).toBe(`ALLOWSUB#${LIVING}`); // the item stays, so it keeps overriding the file
    expect(w.req()).toMatchObject({ state: "revoked", version: 3, GSI1PK: "ACCESSREQS#revoked", decision: { revoked: { by: ADMIN2, reason: "wrong person" } } });
    expect(w.req().ttl).toBe(Math.floor(w.clock.t / 1000) + DECIDED_TTL_SECONDS);
    expect(w.audits("allow:").map((a) => a.op).sort()).toEqual(["allow.grant", "allow.revoke"]);
    expect(w.audits(`accessreq:${ID1}`).map((a) => a.op).sort()).toEqual(["accessreq.decide", "accessreq.revoke"]);
    // the sign-in resolver, as auth/src/allowlist.js runs it: a DynamoDB item wins over io's file, revoked included
    const resolve = async (email, file) => {
      const item = await readAllowEntry(w.ddb, cmds, TABLE, email);
      if (item) return isAllowedNow(item, w.clock.t) ? { sub: item.sub } : null;
      return file.get(email) ? { sub: file.get(email).sub } : null;
    };
    const file = new Map([[EMAIL, { sub: LIVING }]]);
    expect(await resolve(EMAIL, file)).toBeNull();
    expect(await resolve("stranger@example.test", file)).toBeNull();
    // and the composite member reader of the MCP groups: the principal has no other address, so it is not a member any more
    const reader = createCompositeMemberReader({ readEntries: async () => file, ddb: w.ddb, cmds, table: TABLE, log: q });
    expect(await reader(LIVING)).toBeNull();
    // the guard stub lets the address ask again
    expect(w.row(`ACCESSREQEMAIL#hash-${ID1}`)).toMatchObject({ state: "declined" });
  });

  it("needs a fresh sign-in, the flag, the right version and an active request; the reason is R-18 scanned", async () => {
    const w = await world();
    w.seed();
    expect((await w.link(ADMIN, ID1)).status).toBe(200);
    expect(err(await w.revoke(ADMIN, ID1, {}, { fresh: false }))).toEqual({ status: 401, error: "step_up_required" });
    expect(err(await w.revoke(ADMIN, ID1, { confirmedOutside: undefined }))).toEqual({ status: 400, error: "validation" });
    expect(err(await w.revoke(ADMIN, ID1, { version: 1 }))).toEqual({ status: 409, error: "conflict" });
    expect((await w.revoke(ADMIN, ID1, { reason: "call 503 555 0100" })).status).toBe(422);
    expect(err(await w.revoke(ADMIN, ID1, { reason: 5 }))).toEqual({ status: 400, error: "validation" });
    expect(w.allow().state).toBe("active");
    const w2 = await world();
    w2.seed();
    expect(err(await w2.revoke(ADMIN, ID1, { version: 1 }))).toEqual({ status: 409, error: "conflict" }); // pending is not active
    expect(err(await w2.revoke(ADMIN, "01J00000000000000000000999", { version: 1 }))).toEqual({ status: 404, error: "not_found" });
  });

  it("a request revoked can be asked for again: the guard stub no longer blocks the edge's submit condition", async () => {
    const w = await world();
    w.seed();
    await w.link(ADMIN, ID1);
    await w.revoke(ADMIN, ID1);
    const guardRow = w.row(`ACCESSREQEMAIL#hash-${ID1}`);
    // surfaces.md 7.2: the submit's condition is attribute_not_exists(PK) OR #state IN (declined, expired) OR #ttl <= :now
    expect(["declined", "expired"]).toContain(guardRow.state);
  });
});

describe("revoke records the confirmation, and its limits (PS-13, AC6)", () => {
  it("an admin's revoke records 'confirmed outside the site' in the revoke audit and on the request; a member's own objection has nothing to confirm", async () => {
    const w = await world();
    w.seed();
    await w.link(ADMIN, ID1);
    expect((await w.revoke(ADMIN2, ID1, { reason: "left the family" })).status).toBe(200);
    const audit = w.audits(`accessreq:${ID1}`).find((a) => a.op === "accessreq.revoke");
    expect(audit.after).toEqual({ state: "revoked", sub: LIVING, confirmedOutside: true });
    expect(w.req().decision.revoked).toMatchObject({ by: ADMIN2, confirmedOutside: true });
    const m = await world();
    m.seed();
    await m.link(OWNER, ID1, { grampsId: HAS_EMAIL, allowSecondEmail: true });
    expect((await m.call("POST", `/api/second-email/${ID1}`, HAS_EMAIL, { body: { response: "object" } })).status).toBe(200);
    const objected = m.audits(`accessreq:${ID1}`).find((a) => a.op === "accessreq.object");
    expect(objected.after).toEqual({ state: "revoked", sub: HAS_EMAIL });
    expect(m.req().decision.revoked).toMatchObject({ byMember: true });
    expect(m.req().decision.revoked).not.toHaveProperty("confirmedOutside");
  });

  it("KNOWN LIMIT (surfaces.md 7.9, an open issue for io): revoke goes through the request, which is gone 30 days after the decision, so older access cannot be revoked here", async () => {
    const w = await world();
    w.seed();
    await w.link(ADMIN, ID1);
    w.clock.t += DECIDED_TTL_SECONDS * 1000 + 1000;
    expect(err(await w.revoke(ADMIN2, ID1))).toEqual({ status: 404, error: "not_found" });
    expect(w.allow().state).toBe("active");
  });
});

describe("allowSecondEmail (AC7, PS-13)", () => {
  it("is for the gramps-owner alone: 403 owner_only for an admin who is not, before anything else is read or written", async () => {
    const w = await world();
    w.seed();
    const r = await w.link(ADMIN, ID1, { grampsId: HAS_EMAIL, allowSecondEmail: true });
    expect(err(r)).toEqual({ status: 403, error: "owner_only" });
    expect(w.txns).toEqual([]);
    expect(w.sent).toEqual([]);
  });

  it("another address for a person who already signs in is 409 second_email until the owner retries with allowSecondEmail", async () => {
    const w = await world();
    w.seed();
    const r = await w.link(OWNER, ID1, { grampsId: HAS_EMAIL });
    expect(err(r)).toEqual({ status: 409, error: "second_email" });
    expect(r.body.details.retryWith).toEqual({ allowSecondEmail: true });
    expect(w.allow()).toBeUndefined();
  });

  it("grants the address held for 72 hours, tells the member (an inbox item and a mail to every existing address), and tells the requester the date only", async () => {
    const w = await world();
    w.seed();
    const r = await w.link(OWNER, ID1, { grampsId: HAS_EMAIL, allowSecondEmail: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const effectiveAt = new Date(T0 + HOLD_MS).toISOString();
    expect(HOLD_MS).toBe(72 * 3600_000);
    expect(r.body).toEqual({ state: "active", emailSent: true, memberNotified: true, effectiveAt });
    expect(w.allow()).toMatchObject({ state: "active", sub: HAS_EMAIL, effectiveAt, noticedAt: new Date(T0).toISOString() });
    expect(w.req()).toMatchObject({ state: "active", hold: { until: effectiveAt, grampsId: HAS_EMAIL, noticedAt: new Date(T0).toISOString() }, decision: { secondEmail: true } });
    expect((await w.call("GET", `/api/access-requests/${ID1}`, ADMIN)).body.hold).toEqual({ until: effectiveAt, noticed: true });
    expect(w.audits(`accessreq:${ID1}`).find((a) => a.op === "accessreq.decide").after).toMatchObject({ secondEmail: true, confirmedOutside: true });
    expect(w.audits(`accessreq:${ID1}`).map((a) => a.op).sort()).toEqual(["accessreq.decide", "accessreq.notice"]);
    // the member's inbox item, content-free, opening the inbox with the request id the answer takes (it names nobody)
    const items = (await w.inbox.list(HAS_EMAIL)).items;
    expect(items.map((i) => [i.type, i.navigate])).toEqual([["second_email_notice", `/me/inbox/?second-email=${ID1}`]]);
    expect(secondEmailPath(ID1)).toBe(`/me/inbox/?second-email=${ID1}`);
    expect(JSON.stringify(items)).not.toMatch(/Sam|Exampleton|example\.test/);
    // a mail to the address the member already signs in with, and to the requester
    const toOld = w.sent.filter((m) => m.to === OLD_EMAIL);
    expect(toOld).toEqual([{ template: "second_email_notice", to: OLD_EMAIL, vars: {} }]);
    expect(w.sent.find((m) => m.to === EMAIL)).toEqual({ template: "approved_later", to: EMAIL, vars: { when: effectiveAt.slice(0, 10) } });
    expect(w.sent.map((m) => m.to).filter((x) => x === EMAIL)).toHaveLength(1);
  });

  it("takes effect after 72 hours unless the member objects (fake clock): a sign-in before is denied, after is allowed", async () => {
    const w = await world();
    w.seed();
    await w.link(OWNER, ID1, { grampsId: HAS_EMAIL, allowSecondEmail: true });
    const signIn = async () => {
      const item = await readAllowEntry(w.ddb, cmds, TABLE, EMAIL);
      return item && isAllowedNow(item, w.clock.t) ? { sub: item.sub } : null;
    };
    expect(await signIn()).toBeNull();
    w.clock.t += HOLD_MS - 1000;
    expect(await signIn()).toBeNull(); // one second short
    w.clock.t += 1000;
    expect(await signIn()).toEqual({ sub: HAS_EMAIL }); // 72 hours: it counts, with no timer and no sweep
    // the member reader of the MCP groups agrees (the principal is a member through the held address only once it is active)
    const only = new Map();
    const reader = createCompositeMemberReader({ readEntries: async () => only, ddb: w.ddb, cmds, table: TABLE, now: () => w.clock.t, ttlMs: 0, log: q });
    expect(await reader(HAS_EMAIL)).toEqual({ roles: [] });
    w.clock.t = T0;
    expect(await reader(HAS_EMAIL)).toBeNull(); // still held at the start
  });

  it("the member who confirms in the app makes it count at once", async () => {
    const w = await world();
    w.seed();
    await w.link(OWNER, ID1, { grampsId: HAS_EMAIL, allowSecondEmail: true });
    w.clock.t += 3600_000;
    const r = await w.call("POST", `/api/second-email/${ID1}`, HAS_EMAIL, { body: { response: "confirm" } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ state: "active", effective: true });
    expect(w.allow()).not.toHaveProperty("effectiveAt");
    expect(isAllowedNow(w.allow(), w.clock.t)).toBe(true);
    expect(w.audits(`accessreq:${ID1}`).map((a) => a.op).sort()).toEqual(["accessreq.confirm", "accessreq.decide", "accessreq.notice"]);
    // a late confirm after the window is a no-op that says so
    w.clock.t += HOLD_MS;
    expect((await w.call("POST", `/api/second-email/${ID1}`, HAS_EMAIL, { body: { response: "confirm" } })).body).toEqual({ state: "active", effective: true });
  });

  it("the member who objects revokes the grant: the address never signs in, and the request is revoked", async () => {
    const w = await world();
    w.seed();
    await w.link(OWNER, ID1, { grampsId: HAS_EMAIL, allowSecondEmail: true });
    w.clock.t += 3600_000;
    const r = await w.call("POST", `/api/second-email/${ID1}`, HAS_EMAIL, { body: { response: "object" } });
    expect(r.body).toEqual({ state: "revoked" });
    expect(w.allow()).toMatchObject({ state: "revoked", sub: HAS_EMAIL });
    expect(w.req()).toMatchObject({ state: "revoked", decision: { revoked: { byMember: true } } });
    w.clock.t += HOLD_MS * 2;
    expect(isAllowedNow(w.allow(), w.clock.t)).toBe(false);
    // after the window an objection is too late, and cannot reach a request that is already revoked
    expect(err(await w.call("POST", `/api/second-email/${ID1}`, HAS_EMAIL, { body: { response: "object" } }))).toEqual({ status: 409, error: "window_closed" });
  });

  it("only that member may answer: everyone else, admins included, gets the same 404 as no request, and a bad answer is 400", async () => {
    const w = await world();
    w.seed();
    await w.link(OWNER, ID1, { grampsId: HAS_EMAIL, allowSecondEmail: true });
    for (const who of [ADMIN, OTHER, LIVING]) expect(err(await w.call("POST", `/api/second-email/${ID1}`, who, { body: { response: "object" } })).status, who).toBe(404);
    expect(err(await w.call("POST", `/api/second-email/01J00000000000000000000777`, HAS_EMAIL, { body: { response: "object" } }))).toEqual({ status: 404, error: "not_found" });
    expect(err(await w.call("POST", `/api/second-email/${ID1}`, HAS_EMAIL, { body: { response: "maybe" } }))).toEqual({ status: 400, error: "validation" });
    expect(err(await w.call("POST", `/api/second-email/${ID1}`, undefined, { body: { response: "object" } })).status).toBe(401);
    expect(w.allow().state).toBe("active");
  });

  it("an objection after the 72 hours is too late (409 window_closed): the address already counts", async () => {
    const w = await world();
    w.seed();
    await w.link(OWNER, ID1, { grampsId: HAS_EMAIL, allowSecondEmail: true });
    w.clock.t += HOLD_MS + 1;
    expect(err(await w.call("POST", `/api/second-email/${ID1}`, HAS_EMAIL, { body: { response: "object" } }))).toEqual({ status: 409, error: "window_closed" });
    expect(isAllowedNow(w.allow(), w.clock.t)).toBe(true);
  });

  it("allowSecondEmail with nothing to add to (the person has no other address) is an ordinary link", async () => {
    const w = await world();
    w.seed();
    const r = await w.link(OWNER, ID1, { grampsId: LIVING, allowSecondEmail: true });
    expect(r.body).toEqual({ state: "active", emailSent: true });
    expect(w.allow()).not.toHaveProperty("effectiveAt");
    expect((await w.inbox.list(LIVING)).items).toEqual([]);
  });
});

describe("a second email fails closed when the member's notice is lost (PS-13)", () => {
  const brokenInbox = () => {
    const inbox = new InMemoryNotificationStore();
    inbox.add = async () => { throw new Error("down"); };
    return inbox;
  };
  const held = (w) => w.link(OWNER, ID1, { grampsId: HAS_EMAIL, allowSecondEmail: true });
  const resend = (w, who = OWNER, opts) => w.call("POST", `/api/access-requests/${ID1}/resend-notice`, who, { body: {}, ...opts });
  const canSignIn = async (w) => {
    const item = await readAllowEntry(w.ddb, cmds, TABLE, EMAIL);
    return Boolean(item && isAllowedNow(item, w.clock.t));
  };

  it("with the inbox and the mail both failing the link still commits but says memberNotified:false, and the address stays closed however long the clock runs", async () => {
    const w = await world({ mailFails: true, inbox: brokenInbox() });
    w.seed();
    const r = await held(w);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ state: "active", emailSent: false, memberNotified: false });
    expect(w.allow()).toMatchObject({ state: "active", sub: HAS_EMAIL });
    expect(w.allow()).not.toHaveProperty("noticedAt");
    expect((await w.call("GET", `/api/access-requests/${ID1}`, ADMIN)).body.hold.noticed).toBe(false);
    w.clock.t += HOLD_MS * 5; // 15 days: far past the planned date, inside the request's 30 day life
    expect(await canSignIn(w)).toBe(false);
    const reader = createCompositeMemberReader({ readEntries: async () => new Map(), ddb: w.ddb, cmds, table: TABLE, now: () => w.clock.t, ttlMs: 0, log: q });
    expect(await reader(HAS_EMAIL)).toBeNull();
    // the member can still object (the clock never started), and it ends the grant
    expect((await w.call("POST", `/api/second-email/${ID1}`, HAS_EMAIL, { body: { response: "object" } })).body).toEqual({ state: "revoked" });
  });

  it("the owner re-sends the notice: the 72 hours start when it is delivered, the requester is told the date then, and a second re-send is refused", async () => {
    const w = await world({ mailFails: true, inbox: brokenInbox() });
    w.seed();
    await held(w);
    w.clock.t += 5 * 86400_000; // the planned date came and went unseen
    expect(await canSignIn(w)).toBe(false);
    expect(err(await resend(w, ADMIN))).toEqual({ status: 403, error: "owner_only" });
    expect(err(await resend(w, OWNER, { fresh: false }))).toEqual({ status: 401, error: "step_up_required" });
    const still = await resend(w); // still nothing gets through
    expect(still.body).toEqual({ state: "active", memberNotified: false, emailSent: false });
    expect(await canSignIn(w)).toBe(false);
    w.mail.fail = false;
    const r = await resend(w);
    const effectiveAt = new Date(w.clock.t + HOLD_MS).toISOString();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ state: "active", memberNotified: true, emailSent: true, effectiveAt });
    expect(w.sent.find((m) => m.to === OLD_EMAIL)).toEqual({ template: "second_email_notice", to: OLD_EMAIL, vars: {} });
    expect(w.sent.find((m) => m.to === EMAIL)).toEqual({ template: "approved_later", to: EMAIL, vars: { when: effectiveAt.slice(0, 10) } });
    expect(w.allow()).toMatchObject({ effectiveAt, noticedAt: new Date(w.clock.t).toISOString() });
    expect(w.req().hold).toMatchObject({ until: effectiveAt, noticedAt: new Date(w.clock.t).toISOString() });
    expect(await canSignIn(w)).toBe(false);
    w.clock.t += HOLD_MS - 1000;
    expect(await canSignIn(w)).toBe(false);
    w.clock.t += 1000;
    expect(await canSignIn(w)).toBe(true);
    expect(err(await resend(w))).toEqual({ status: 409, error: "already_noticed" });
  });

  it("an inbox item alone is a delivered notice (mail failing), and a mail alone is too (inbox failing)", async () => {
    const a = await world({ mailFails: true });
    a.seed();
    expect((await held(a)).body).toMatchObject({ memberNotified: true, effectiveAt: new Date(T0 + HOLD_MS).toISOString() });
    expect((await a.inbox.list(HAS_EMAIL)).items).toHaveLength(1);
    const b = await world({ inbox: brokenInbox() });
    b.seed();
    expect((await held(b)).body).toMatchObject({ memberNotified: true });
  });

  it("a re-send needs a held, un-noticed second email: 409 for a plain link or a pending request, 404 for an unknown one", async () => {
    const w = await world();
    w.seed();
    expect(err(await resend(w))).toEqual({ status: 409, error: "conflict" }); // pending
    await w.link(OWNER, ID1, { grampsId: LIVING });
    expect(err(await resend(w))).toEqual({ status: 409, error: "conflict" }); // an ordinary link has no hold
    expect(err(await w.call("POST", "/api/access-requests/01J00000000000000000000999/resend-notice", OWNER, { body: {} }))).toEqual({ status: 404, error: "not_found" });
  });

  it("the member can still answer when the accessRequests flag is turned off mid-hold; the admin routes go dark", async () => {
    const w = await world();
    w.seed();
    await held(w);
    w.flags.accessRequests = false;
    expect((await w.call("GET", "/api/access-requests", OWNER)).status).toBe(404);
    expect((await resend(w)).status).toBe(404);
    const r = await w.call("POST", `/api/second-email/${ID1}`, HAS_EMAIL, { body: { response: "object" } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ state: "revoked" });
    expect(w.allow().state).toBe("revoked");
    // everyone else is still the same 404 as no request
    expect((await w.call("POST", `/api/second-email/${ID1}`, ADMIN, { body: { response: "object" } })).status).toBe(404);
  });
});

describe("the member finds the request id of a held second email, and only the held member passes the gate (PS-13, AC7)", () => {
  const brokenInbox = () => {
    const inbox = new InMemoryNotificationStore();
    inbox.add = async () => { throw new Error("down"); };
    return inbox;
  };
  const held = (w) => w.link(OWNER, ID1, { grampsId: HAS_EMAIL, allowSecondEmail: true });
  const mine = (w, who = HAS_EMAIL) => w.call("GET", "/api/second-email", who);

  it("GET /api/second-email lists the member's open hold with the id the answer takes, content-free; the answer works from it, and then the hold is gone", async () => {
    const w = await world();
    w.seed();
    await held(w);
    const until = new Date(T0 + HOLD_MS).toISOString();
    const r = await mine(w);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ items: [{ id: ID1, noticed: true, until }] });
    expect(JSON.stringify(r.body)).not.toMatch(/example\.test|Sam|Exampleton|s\*\*\*/);
    // the inbox item opens the same id
    expect((await w.inbox.list(HAS_EMAIL)).items.map((i) => i.navigate)).toEqual([secondEmailPath(r.body.items[0].id)]);
    // nobody else has a hold: the same 404 as no route, admins and the owner included; signed out is 401
    for (const who of [ADMIN, OWNER, OTHER, LIVING]) expect((await mine(w, who)).status, who).toBe(404);
    expect((await w.call("GET", "/api/second-email", null)).status).toBe(401);
    // the member confirms with the listed id: the address counts, and nothing is held any more
    w.clock.t += 3600_000;
    expect((await w.call("POST", `/api/second-email/${r.body.items[0].id}`, HAS_EMAIL, { body: { response: "confirm" } })).body).toEqual({ state: "active", effective: true });
    expect((await mine(w)).status).toBe(404);
  });

  it("a member told by mail alone (no inbox item) finds the id through the list, and so does one whose notice never got through (the clock has not started: until is null)", async () => {
    const byMail = await world({ inbox: brokenInbox() });
    byMail.seed();
    expect((await held(byMail)).body).toMatchObject({ memberNotified: true });
    expect((await byMail.inbox.list(HAS_EMAIL)).items).toEqual([]);
    expect((await mine(byMail)).body).toEqual({ items: [{ id: ID1, noticed: true, until: new Date(T0 + HOLD_MS).toISOString() }] });
    const lost = await world({ mailFails: true, inbox: brokenInbox() });
    lost.seed();
    expect((await held(lost)).body).toMatchObject({ memberNotified: false });
    lost.clock.t += HOLD_MS * 2;
    expect((await mine(lost)).body).toEqual({ items: [{ id: ID1, noticed: false, until: null }] });
    expect((await lost.call("POST", `/api/second-email/${ID1}`, HAS_EMAIL, { body: { response: "object" } })).body).toEqual({ state: "revoked" });
    expect((await mine(lost)).status).toBe(404); // revoked: nothing held
  });

  it("a hold whose 72 hours ran out after a delivered notice already counts: it is no longer listed", async () => {
    const w = await world();
    w.seed();
    await held(w);
    w.clock.t += HOLD_MS + 1;
    expect((await mine(w)).body).toEqual({ items: [] });
  });

  it("the gate is the held-member lookup, not an always-open switch: 401 signed out, true for the held member only, 404 without a context or when the lookup fails (logged by name only)", async () => {
    const w = await world();
    w.seed();
    w.seed({ id: ID2, emailHash: "hash-2", email: "pat.synthetic@example.test" }); // a pending request with no hold
    await held(w);
    const ctx = { ddb: w.ddb, cmds, table: TABLE, now: () => w.clock.t };
    const gate = secondEmailGate({ log: q });
    expect(gate).toMatchObject({ type: "switch", name: "ACCESS_REQUESTS", rule: SECOND_EMAIL_RULE });
    for (const n of ["accessRequests.secondEmails", "accessRequests.secondEmail"]) expect(ROUTES.find((r) => r.name === n).gate).toMatchObject({ type: "switch", rule: SECOND_EMAIL_RULE });
    const check = (actor, params, c = ctx) => gate.check({ actor, params, ctx: c });
    expect(await check({ id: HAS_EMAIL }, { id: ID1 })).toBe(true);
    expect(await check({ id: HAS_EMAIL }, {})).toBe(true); // the list: the member has a second email on hold
    for (const actor of [{ id: OTHER }, { id: ADMIN, admin: true }, { id: OWNER, admin: true }, { id: LIVING }]) {
      expect(await check(actor, { id: ID1 }), actor.id).toBe(false);
      expect(await check(actor, {}), actor.id).toBe(false);
    }
    expect(await check({ id: HAS_EMAIL }, { id: ID2 })).toBe(false); // not a held request
    expect(await check({ id: HAS_EMAIL }, { id: "01J00000000000000000000777" })).toBe(false); // no request
    expect(await check({ id: HAS_EMAIL }, { id: "../x" })).toBe(false);
    expect(await gate.check({ actor: { id: HAS_EMAIL }, params: { id: ID1 } })).toBe(false); // no context (an MCP call): closed
    await expect(check(undefined, { id: ID1 })).rejects.toMatchObject({ status: 401, code: "unauthenticated" });
    // an expired request is gone for the gate as for the domain
    w.ddb.rows.set(`ACCESSREQ#${ID1}\u0000META`, { ...w.req(), ttl: Math.floor(w.clock.t / 1000) - 1 });
    expect(await check({ id: HAS_EMAIL }, { id: ID1 })).toBe(false);
    w.ddb.rows.set(`ACCESSREQ#${ID1}\u0000META`, { ...w.req(), ttl: Math.floor(w.clock.t / 1000) + 86400 });
    // a lookup that fails is 404 (fail closed), and the log carries the error name only
    const logged = [];
    const failing = secondEmailGate({ log: { error: (...a) => logged.push(a) } });
    const bad = { ...ctx, ddb: { send: async () => { throw Object.assign(new Error(`throttled for ${EMAIL}`), { name: "ProvisionedThroughputExceededException" }); } } };
    expect(await failing.check({ actor: { id: HAS_EMAIL }, params: { id: ID1 }, ctx: bad })).toBe(false);
    expect(await failing.check({ actor: { id: HAS_EMAIL }, params: {}, ctx: bad })).toBe(false);
    expect(logged).toHaveLength(2);
    expect(JSON.stringify(logged)).not.toMatch(/example\.test/);
    expect(JSON.stringify(logged)).toMatch(/ProvisionedThroughputExceededException/);
    // end to end: the held member's answer is refused 404 while the lookup fails, and nothing is written
    const realSend = w.ddb.send.bind(w.ddb);
    w.ddb.send = async (cmd) => {
      if (cmd.constructor.name === "GetCommand" && cmd.input.Key?.PK === `ACCESSREQ#${ID1}`) throw Object.assign(new Error("down"), { name: "InternalServerError" });
      return realSend(cmd);
    };
    w.txns.length = 0;
    expect(err(await w.call("POST", `/api/second-email/${ID1}`, HAS_EMAIL, { body: { response: "object" } }))).toEqual({ status: 404, error: "not_found" });
    expect(w.txns).toEqual([]);
    w.ddb.send = realSend;
    expect(w.allow().state).toBe("active");
  });
});

describe("Q2-11(a): the residence is city and state only (the preview), and the flag matches the edge and the join form", () => {
  it("STORE_CURRENT_CITY is true here, in the auth edge and in the join form, so a request is stored, previewed and asked for the same way", () => {
    expect(STORE_CURRENT_CITY).toBe(true);
    const edge = readFileSync(resolve(here, "../../auth/src/access-request.js"), "utf8");
    const form = readFileSync(resolve(here, "../../islands/src/lib/join.js"), "utf8");
    expect(edge).toMatch(/^export const STORE_CURRENT_CITY = true;$/m);
    expect(form).toMatch(/^export const STORE_CURRENT_CITY = true;$/m);
  });

  it("the Residence event carries the place query (city and state) and the year moved, and no street or postal code can get through the form", async () => {
    const w = await world();
    w.seed();
    const { preview } = (await w.call("GET", `/api/access-requests/${ID1}`, ADMIN)).body;
    const residence = preview.events.find((e) => e.type.value === 42);
    expect(residence.date).toMatchObject({ modifier: 7, dateval: [0, 0, 2005, false] });
    const query = preview.placeQueries.find((p) => p.role === "residence");
    expect(JSON.stringify(query)).toMatch(/Portland/);
    expect(JSON.stringify(preview)).not.toMatch(/Main Street|97201/);
  });
});

describe("the mailer", () => {
  it("is a thin SES sender over the system templates: plain text, the configuration set, the bare From, and only an error NAME on failure", async () => {
    const calls = [];
    const m = createSesMailer({ from: "no-reply@example.test", configurationSet: "cs", send: async (i) => { calls.push(i); } });
    await m.send({ template: "approved", to: "x@example.test", vars: {} });
    expect(calls[0]).toMatchObject({ FromEmailAddress: "no-reply@example.test", Destination: { ToAddresses: ["x@example.test"] }, ConfigurationSetName: "cs" });
    expect(Object.keys(calls[0].Content.Simple.Body)).toEqual(["Text"]);
    const bad = createSesMailer({ from: "no-reply@example.test", configurationSet: "cs", send: async () => { throw Object.assign(new Error("Email address x@example.test is not verified"), { name: "MessageRejected" }); } });
    const e = await bad.send({ template: "approved", to: "x@example.test", vars: {} }).catch((x) => x);
    expect(e.name).toBe("MessageRejected");
    expect(e.message).toBe("mail not sent");
    expect(() => createSesMailer({ from: "", configurationSet: "cs", send() {} })).toThrow();
    expect(() => createSesMailer({ from: "a@b.test", configurationSet: "", send() {} })).toThrow(/configuration set/);
  });
});

describe("no leak in the logs", () => {
  it("a failing mailer, guard or lookup logs names only, never an address or a note", async () => {
    const logged = [];
    const log = { warn: (...a) => logged.push(a), error: (...a) => logged.push(a), info: (...a) => logged.push(a) };
    const w = makeApi({
      admins: [ADMIN], log, flags: { accessRequests: true },
      extraDeps: { mailer: { send: async () => { throw Object.assign(new Error(`cannot send to ${EMAIL}`), { name: "MessageRejected" }); } }, txnOpts: { sleep: async () => {} } },
    });
    w.ddb.rows.set(`ACCESSREQ#${ID1}\u0000META`, { PK: `ACCESSREQ#${ID1}`, SK: "META", entity: "accessreq", id: ID1, state: "pending", version: 1, email: EMAIL, emailHash: "x", form: FORM, GSI1PK: "ACCESSREQS#pending", GSI1SK: ID1 });
    const t = await signToken(ADMIN);
    expect((await w.call("POST", `/api/access-requests/${ID1}/decision`, { token: t, body: { decision: "decline", version: 1, note: "a private note", sendNote: true } })).body.emailSent).toBe(false);
    expect(JSON.stringify(logged)).not.toMatch(/example\.test|private note/);
  });
});

describe("what a link tells the other admins, and the facts it proposes (surfaces.md 7.4 post-commit)", () => {
  it("every other admin gets an inbox item 'someone was let in'; the admin who linked does not", async () => {
    const w = await world();
    w.seed();
    await w.link(ADMIN, ID1);
    expect((await w.inbox.list(ADMIN2)).items.map((i) => [i.type, i.navigate])).toEqual([["access_request_decided", "/me/requests/"]]);
    expect((await w.inbox.list(OWNER)).items.map((i) => i.type)).toEqual(["access_request_decided"]);
    expect((await w.inbox.list(ADMIN)).items).toEqual([]);
    expect(JSON.stringify((await w.inbox.list(ADMIN2)).items)).not.toMatch(/example\.test/);
  });

  it("a person page that lacks the nickname and the education gets ONE system proposal for them, reviewed like any other; the email never moves", async () => {
    const w = await world();
    w.seed();
    await w.link(ADMIN, ID1);
    const rows = w.ddb.all().filter((r) => r.PK.startsWith("PROP#") && r.SK === "META");
    expect(rows).toHaveLength(1);
    const p = rows[0].proposal;
    expect(p).toMatchObject({ state: "pending", origin: "access_request", request_id: `${ID1}-facts`, proposer: { id: "system:access_request" } });
    expect(p.ops.map((o) => `${o.op}:${o.path ?? o.cls}`)).toEqual(["set:/primary_name/nick", "create:Event", "add:/event_ref_list"]);
    expect(p.ops[0]).toMatchObject({ value: "Sammy", base: "" });
    expect(p.ops[1].value).toMatchObject({ type: { value: 31 }, description: "Example State", date: { dateval: [0, 0, 2002, false] } });
    expect(JSON.stringify(p)).not.toMatch(/example\.test/);
  });

  it("nothing is proposed when the page already has the nickname, or when the person is not in the record store; a failure never reaches the answer", async () => {
    const w = await world();
    w.seed({ form: { ...FORM, nickname: undefined, university: undefined, graduationYear: undefined } });
    expect((await w.link(ADMIN, ID1)).status).toBe(200);
    expect(w.ddb.all().filter((r) => r.PK.startsWith("PROP#"))).toEqual([]);
    const w2 = await world();
    w2.facts[GHOST] = { isLiving: true };
    w2.seed();
    expect((await w2.link(ADMIN, ID1, { grampsId: GHOST })).status).toBe(200); // on the site's pages, not in the record store yet
    expect(w2.ddb.all().filter((r) => r.PK.startsWith("PROP#"))).toEqual([]);
  });

  it("new needs the same step-up as link", async () => {
    const w = await world();
    w.seed();
    expect(err(await w.decide(ADMIN, ID1, { decision: "new", preview: {}, version: 1, confirmedOutside: true }, { fresh: false }))).toEqual({ status: 401, error: "step_up_required" });
    // a decline needs none: it grants nothing
    expect((await w.decide(ADMIN, ID1, { decision: "decline", version: 1 }, { fresh: false })).status).toBe(200);
  });
});

describe("createPersonFacts: the site's own person record, read for the living check", () => {
  it("is null for an absent person (any of S3's absent answers), isLiving only when the record says true, and throws for any other failure", async () => {
    const { createPersonFacts } = await import("../src/labels.js");
    const facts = (load) => createPersonFacts({ load });
    expect(await facts(async () => ({ isLiving: true }))("I0001")).toEqual({ isLiving: true });
    expect(await facts(async () => ({ isLiving: "yes" }))("I0001")).toEqual({ isLiving: false });
    expect(await facts(async () => ({}))("I0001")).toEqual({ isLiving: false });
    expect(await facts(async () => null)("I0001")).toBeNull();
    for (const e of [{ name: "NoSuchKey" }, { name: "AccessDenied" }, { Code: "NoSuchKey" }, { $metadata: { httpStatusCode: 404 } }, { $metadata: { httpStatusCode: 403 } }]) {
      expect(await facts(async () => { throw Object.assign(new Error("x"), e); })("I0001"), JSON.stringify(e)).toBeNull();
    }
    await expect(facts(async () => { throw Object.assign(new Error("x"), { name: "InternalError" }); })("I0001")).rejects.toThrow();
    expect(await facts(async () => { throw new Error("must not be asked"); })("../etc/passwd")).toBeNull(); // only the gramps_id shape ever becomes a key
  });
});
