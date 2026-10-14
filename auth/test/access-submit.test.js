// The access-request submit route (HFY-TSK-196, surfaces.md 7.2 "Submit step"): the shared checks and the kill switch, the ticket, the
// shared schema with the R-18 guard, Turnstile and the submit limits, the one transaction, the notices after the commit, and log hygiene.
// Every address, name, ticket and token in this file is synthetic.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { InMemoryNotificationStore } from "@io-kit/notify/server";
import { QUEUE_CAP, REQUEST_TTL_SECONDS, SUBMIT_LIMITS, createAccessRequest, emailHash, requestEmailKey, requestKey, ticketKey, ulid } from "../src/access-request.js";
import { createAdminDirectory } from "../src/admins.js";
import { createAdminInbox } from "../src/admin-notify.js";
import { createFlagReader } from "../src/flags.js";
import { createAccessRequestRoutes } from "../src/index.js";
import { memoryRateLimiter } from "../src/ratelimit.js";
import { TEMPLATE_REGISTRY } from "../src/shared/notify-registry.mjs";

const SITE = "https://harrisonfamily.us";
const TABLE = "app-table";
const PEPPER = "synthetic-pepper-not-a-secret";
const T0 = Date.parse("2030-01-01T00:00:00Z");
const EMAIL = "new.cousin.synthetic@example.com";
const TICKET = "synthetic-ticket-0123456789abcdefghijklmnopq";
const hash = (email) => emailHash(PEPPER, email);

class Cmd { constructor(input) { this.input = input; } }
class GetCommand extends Cmd {}
class PutCommand extends Cmd {}
class DeleteCommand extends Cmd {}
class QueryCommand extends Cmd {}
class UpdateCommand extends Cmd {}
class TransactWriteCommand extends Cmd {}
const cmds = { GetCommand, PutCommand, DeleteCommand, QueryCommand, UpdateCommand, TransactWriteCommand };

const dbError = (name, extra = {}) => Object.assign(new Error(`${name} for table/${TABLE}`), { name, ...extra });
const keyOf = (k) => `${k.PK}|${k.SK}`;

/** One clause of the conditions the submit writes: attribute_exists(PK), attribute_not_exists(PK), #state IN (...), #ttl <= :now. */
function clauseOk(clause, existing, t) {
  const c = clause.trim();
  let m;
  if ((m = /^attribute_(exists|not_exists)\(PK\)$/.exec(c))) return m[1] === "exists" ? existing !== undefined : existing === undefined;
  if ((m = /^#state IN \((:\w+), (:\w+)\)$/.exec(c))) return existing !== undefined && [t.ExpressionAttributeValues[m[1]], t.ExpressionAttributeValues[m[2]]].includes(existing.state);
  if ((m = /^#ttl <= (:\w+)$/.exec(c))) return existing !== undefined && Number.isFinite(existing.ttl) && existing.ttl <= t.ExpressionAttributeValues[m[1]];
  throw new Error(`fake doc: unsupported condition ${c}`);
}
const condOk = (t, existing) => !t.ConditionExpression || t.ConditionExpression.split(" OR ").some((c) => clauseOk(c, existing, t));

/** A lib-dynamodb DocumentClient fake: Get, Put, Delete, Query (GSI1 equality; COUNT or items), TransactWrite (Delete and Put, all or nothing). */
function fakeDoc({ failOn, onTransact } = {}) {
  const rows = new Map();
  const calls = [];
  const transactions = [];
  return {
    rows, calls, transactions,
    async send(cmd) {
      const kind = cmd.constructor.name;
      calls.push(kind);
      if (failOn?.includes(kind)) throw dbError("ProvisionedThroughputExceededException");
      const i = cmd.input;
      if (kind === "GetCommand") { const it = rows.get(keyOf(i.Key)); return it ? { Item: structuredClone(it) } : {}; }
      if (kind === "PutCommand") { rows.set(keyOf(i.Item), structuredClone(i.Item)); return {}; }
      if (kind === "DeleteCommand") { rows.delete(keyOf(i.Key)); return {}; }
      if (kind === "QueryCommand") {
        const hits = [...rows.values()].filter((r) => r.GSI1PK === i.ExpressionAttributeValues[":pk"]);
        return i.Select === "COUNT" ? { Count: Math.min(hits.length, i.Limit ?? Infinity) } : { Items: structuredClone(hits) };
      }
      if (kind === "TransactWriteCommand") {
        transactions.push(i.TransactItems);
        await onTransact?.(i, rows);
        const reasons = i.TransactItems.map((t) => {
          const op = t.Delete ?? t.Put;
          const existing = rows.get(keyOf(t.Delete ? t.Delete.Key : t.Put.Item));
          return condOk(op, existing) ? { Code: "None" } : { Code: "ConditionalCheckFailed" };
        });
        if (reasons.some((r) => r.Code !== "None")) throw dbError("TransactionCanceledException", { CancellationReasons: reasons });
        for (const t of i.TransactItems) {
          if (t.Delete) rows.delete(keyOf(t.Delete.Key));
          else rows.set(keyOf(t.Put.Item), structuredClone(t.Put.Item));
        }
        return {};
      }
      throw new Error(`fake doc: unsupported ${kind}`);
    },
  };
}

const FORM = {
  givenNames: "Sam Synthetic", maidenSurname: "Exampleton", gender: "female", birthPlace: "Springfield, IL", birthYear: 1980,
  currentPlace: "Portland, OR", forSelf: true,
};
const submitBody = (over = {}) => ({ ticket: TICKET, form: { ...FORM }, turnstileToken: "synthetic-token", company: "", ...over });
const post = (body, over = {}) => ({
  rawPath: "/auth/access-request", requestContext: { http: { method: "POST" } },
  headers: { "x-requested-with": "io-kit", origin: SITE, "content-type": "application/json", "cloudfront-viewer-address": "203.0.113.7:4444", ...over.headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
});
const bodyOf = (res) => JSON.parse(res.body);

/** Everything wired with fakes. The ticket for EMAIL is in the table unless `ticket: false`. */
function setup(o = {}) {
  const clock = { now: T0 };
  const now = () => clock.now;
  const doc = o.doc ?? fakeDoc();
  const limiter = o.limiter ?? memoryRateLimiter({ now });
  const hits = [];
  const spyLimiter = { hit: async (key, cfg) => { hits.push({ key, cfg }); return limiter.hit(key, cfg); } };
  const sent = [];
  const mailer = { send: vi.fn(async (m) => { if (o.mailFails?.(m)) throw Object.assign(new Error(`rejected ${m.to}`), { name: "MessageRejected" }); sent.push(m); }) };
  const fetch = o.fetch ?? vi.fn(async () => ({ ok: true, json: async () => ({ success: true, hostname: "harrisonfamily.us", action: "join" }) }));
  const logs = [];
  const log = { error: (...a) => logs.push(a.join(" ")), warn: (...a) => logs.push(a.join(" ")), info: (...a) => logs.push(a.join(" ")), log: (...a) => logs.push(a.join(" ")) };
  const state = { on: o.on ?? true, member: new Set(o.members ?? []) };
  const admins = o.admins ?? { inbox: vi.fn(async () => undefined), emails: vi.fn(async () => ["admin.one.synthetic@example.com", "admin.two.synthetic@example.com"]) };
  if (o.ticket !== false) {
    const at = Math.floor(T0 / 1000);
    doc.rows.set(keyOf(ticketKey(TICKET)), { ...ticketKey(TICKET), entity: "accessticket", email: EMAIL, emailHash: hash(EMAIL), createdAt: at, expiresAt: at + 3600, ttl: at + 3600, ...o.ticket });
  }
  const ar = createAccessRequest({
    flag: () => state.on, siteOrigin: SITE, siteHost: "harrisonfamily.us", ddb: doc, cmds, table: TABLE, limiter: spyLimiter, mailer, fetch,
    secrets: { turnstile: async () => "synthetic-turnstile-secret", pepper: async () => PEPPER },
    isMember: o.isMember ?? (async (email) => state.member.has(email)), mailAlarm: { isFiring: async () => false },
    now, log, ...(o.noAdmins ? {} : { admins }),
  });
  const submit = (body = submitBody(), over) => ar.handle("/access-request", post(body, over));
  const rowsWith = (prefix) => [...doc.rows.entries()].filter(([k]) => k.startsWith(prefix));
  return { ar, doc, clock, hits, sent, mailer, fetch, logs, state, admins, submit, rowsWith };
}

describe("the shared checks (7.2)", () => {
  it("answers 503 closed while ACCESS_REQUESTS is off, whatever the request, and touches nothing", async () => {
    const m = setup({ on: false });
    const res = await m.ar.handle("/access-request", { rawPath: "", requestContext: { http: { method: "PUT" } }, headers: {} });
    expect([res.statusCode, bodyOf(res)]).toEqual([503, { detail: "closed" }]);
    expect((await m.submit()).statusCode).toBe(503);
    expect(m.fetch).not.toHaveBeenCalled();
    expect(m.mailer.send).not.toHaveBeenCalled();
    expect(m.doc.calls).toEqual([]);
  });

  it("requires POST, a JSON content type, x-requested-with io-kit and the site Origin (403 otherwise), before any table access", async () => {
    const m = setup();
    for (const method of ["GET", "PUT", "DELETE", "OPTIONS", "HEAD"]) {
      expect((await m.ar.handle("/access-request", { ...post(submitBody()), requestContext: { http: { method } } })).statusCode, method).toBe(403);
    }
    for (const ct of [undefined, "text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) expect((await m.submit(submitBody(), { headers: { "content-type": ct } })).statusCode, String(ct)).toBe(403);
    for (const v of [undefined, "", "XMLHttpRequest", "IO-KIT"]) expect((await m.submit(submitBody(), { headers: { "x-requested-with": v } })).statusCode, String(v)).toBe(403);
    for (const origin of [undefined, "https://evil.example", "https://harrisonfamily.us.evil.example", "http://harrisonfamily.us", "null"]) {
      expect((await m.submit(submitBody(), { headers: { origin } })).statusCode, String(origin)).toBe(403);
    }
    expect(m.doc.calls).toEqual([]);
    expect(m.fetch).not.toHaveBeenCalled();
    expect((await m.submit(submitBody(), { headers: { origin: `${SITE}/` } })).statusCode).toBe(201); // a trailing slash is the same origin
  });

  it("answers no-store JSON", async () => {
    const m = setup();
    const res = await m.submit();
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["content-type"]).toBe("application/json");
  });
});

describe("the ticket (valid, unused)", () => {
  const nothingDone = (m) => {
    expect(m.doc.transactions).toEqual([]);
    expect(m.fetch).not.toHaveBeenCalled();
    expect(m.hits).toEqual([]);
    expect(m.mailer.send).not.toHaveBeenCalled();
    expect(m.admins.inbox).not.toHaveBeenCalled();
    expect(m.rowsWith("ACCESSREQ#")).toEqual([]);
  };

  it("a submit with no ticket, a malformed ticket or a ticket of the wrong type is 403 and costs nothing", async () => {
    const m = setup();
    for (const ticket of [undefined, "", "short", 12345, null, {}, ["x"], `${TICKET}!`, "a".repeat(200)]) {
      const res = await m.submit(submitBody({ ticket }));
      expect([res.statusCode, bodyOf(res)], String(ticket)).toEqual([403, { detail: "ticket_expired" }]);
    }
    expect((await m.submit("not json")).statusCode).toBe(403);
    nothingDone(m);
  });

  it("an unknown ticket is 403 and costs nothing", async () => {
    const m = setup({ ticket: false });
    expect([(await m.submit()).statusCode]).toEqual([403]);
    nothingDone(m);
  });

  it("an expired ticket is 403 (even before the table's TTL purge has removed it)", async () => {
    const m = setup();
    m.clock.now += 3601_000;
    const res = await m.submit();
    expect([res.statusCode, bodyOf(res)]).toEqual([403, { detail: "ticket_expired" }]);
    nothingDone(m);
  });

  it("a ticket is good once: the second submit with it is 403, and only one request exists", async () => {
    const m = setup();
    expect((await m.submit()).statusCode).toBe(201);
    expect((await m.submit()).statusCode).toBe(403);
    expect(m.rowsWith("ACCESSREQ#")).toHaveLength(1);
    expect(m.doc.transactions).toHaveLength(1);
  });

  it("a ticket used between the read and the commit is 403, not a 409 or a 500, and writes nothing", async () => {
    const doc = fakeDoc({ onTransact: async (_i, rows) => { rows.delete(keyOf(ticketKey(TICKET))); } }); // a parallel submit consumed it
    const m = setup({ doc });
    const res = await m.submit();
    expect([res.statusCode, bodyOf(res)]).toEqual([403, { detail: "ticket_expired" }]);
    expect(m.rowsWith("ACCESSREQ#")).toEqual([]);
    expect(m.mailer.send).not.toHaveBeenCalled();
  });

  it("answers 503 unavailable when the ticket cannot be read", async () => {
    const m = setup({ doc: fakeDoc({ failOn: ["GetCommand"] }) });
    expect([(await m.submit()).statusCode, m.mailer.send.mock.calls.length]).toEqual([503, 0]);
  });
});

describe("validation: the shared schema and the R-18 guard", () => {
  const fieldsOf = async (m, form, over = {}) => {
    const res = await m.submit(submitBody({ form: { ...FORM, ...form } }), over);
    return [res.statusCode, bodyOf(res)];
  };

  it("a bad form is 400 {validation, fields} with codes and no echo, and spends nothing: the ticket stays and Turnstile is not asked", async () => {
    const m = setup();
    const [status, body] = await fieldsOf(m, { givenNames: "", birthYear: 1900, gender: "other", forSelf: false });
    expect(status).toBe(400);
    expect(body.detail).toBe("validation");
    expect(body.fields).toEqual([
      { field: "givenNames", code: "required" }, { field: "gender", code: "invalid" }, { field: "birthYear", code: "year_range" }, { field: "forSelf", code: "required" },
    ]);
    expect(JSON.stringify(body)).not.toMatch(/Synthetic|1900/);
    expect(m.fetch).not.toHaveBeenCalled();
    expect(m.hits).toEqual([]);
    expect(m.rowsWith("ACCESSTICKET#")).toHaveLength(1);
    expect(m.doc.transactions).toEqual([]);
    expect((await m.submit()).statusCode).toBe(201); // the visitor fixes the form and sends again with the same ticket
  });

  it("runs the R-18 detector on every free-text field: a phone number, an email and a street address are field errors", async () => {
    const m = setup();
    const cases = {
      nickname: "call me at 503 555 0100", university: "write to someone.synthetic@example.com", otherDegrees: "lives at 12 Main Street",
      otherInstitutions: "https://www.facebook.com/messages/t/synthetic",
    };
    for (const [field, text] of Object.entries(cases)) {
      const [status, body] = await fieldsOf(m, { [field]: text });
      expect(status, field).toBe(400);
      expect(body.fields.map((f) => f.field), field).toEqual([field]);
      expect(["contact_info", "dob_not_allowed", "street_not_allowed", "digits_not_allowed"], field).toContain(body.fields[0].code);
    }
    const [status, body] = await fieldsOf(m, { birthPlace: "12 Main Street, Springfield" });
    expect([status, body.fields]).toEqual([400, [{ field: "birthPlace", code: "street_not_allowed" }]]);
    expect(m.rowsWith("ACCESSREQ#")).toEqual([]);
  });

  it("refuses a birth month or day shaped answer in a free-text field and never stores a form that failed", async () => {
    const m = setup();
    const [status, body] = await fieldsOf(m, { nickname: "born on March 3rd 1980" });
    expect([status, body.detail]).toEqual([400, "validation"]);
    expect(m.rowsWith("ACCESSREQ#")).toEqual([]);
  });

  it("the email in the form must be the ticket's; absent, it is the ticket's", async () => {
    const m = setup();
    const [status, body] = await fieldsOf(m, { email: "someone.else.synthetic@example.com" });
    expect([status, body.fields]).toEqual([400, [{ field: "email", code: "invalid" }]]);
    expect((await fieldsOf(m, { email: EMAIL.toUpperCase() }))[0]).toBe(201); // the same address, spelled differently
  });

  it("a form that is not an object is a validation error, never a crash", async () => {
    const m = setup();
    for (const form of [undefined, null, "text", 5, [FORM]]) {
      const res = await m.submit(submitBody({ form }));
      expect(res.statusCode, String(form)).toBe(400);
    }
  });

  it("a filled honeypot (top level or in the form) is a fake 201 with no work at all", async () => {
    for (const body of [submitBody({ company: "Acme" }), submitBody({ form: { ...FORM, company: "Acme" } })]) {
      const m = setup();
      const res = await m.submit(body);
      expect([res.statusCode, bodyOf(res)]).toEqual([201, { ok: true, state: "pending" }]);
      expect(m.doc.calls).toEqual([]);
      expect(m.fetch).not.toHaveBeenCalled();
      expect(m.mailer.send).not.toHaveBeenCalled();
      expect(m.admins.inbox).not.toHaveBeenCalled();
    }
  });
});

describe("Turnstile, the queue cap and the submit limits (7.5)", () => {
  it("a refused Turnstile token is 403 bot_check_failed; an unavailable Turnstile is 503; neither consumes the ticket", async () => {
    const refused = setup({ fetch: vi.fn(async () => ({ ok: true, json: async () => ({ success: false, "error-codes": ["invalid-input-response"] }) })) });
    expect([(await refused.submit()).statusCode, bodyOf(await refused.submit()).detail]).toEqual([403, "bot_check_failed"]);
    expect(refused.rowsWith("ACCESSTICKET#")).toHaveLength(1);
    const down = setup({ fetch: vi.fn(async () => { throw new Error("network"); }) });
    const res = await down.submit();
    expect([res.statusCode, bodyOf(res)]).toEqual([503, { detail: "unavailable" }]);
    for (const m of [refused, down]) {
      expect(m.doc.transactions).toEqual([]);
      expect(m.mailer.send).not.toHaveBeenCalled();
    }
  });

  it("checks Turnstile with the site hostname, action join and the client address", async () => {
    const m = setup();
    await m.submit();
    const [, init] = m.fetch.mock.calls[0];
    expect(JSON.parse(init.body)).toMatchObject({ response: "synthetic-token", remoteip: "203.0.113.7" });
  });

  it("a full queue (100 pending) is 503 queue_full and the ticket stays", async () => {
    const m = setup();
    for (let i = 0; i < QUEUE_CAP; i += 1) m.doc.rows.set(`ACCESSREQ#q${i}|META`, { PK: `ACCESSREQ#q${i}`, SK: "META", GSI1PK: "ACCESSREQS#pending" });
    const res = await m.submit();
    expect([res.statusCode, bodyOf(res)]).toEqual([503, { detail: "queue_full" }]);
    expect(m.rowsWith("ACCESSTICKET#")).toHaveLength(1);
    expect(m.doc.transactions).toEqual([]);
  });

  it("the per-IP limit is 5 a day and the global limit 20 a day (joinsubmit); the next is 429 with retry-after", async () => {
    expect(SUBMIT_LIMITS.map((l) => [l.name, l.scope, l.limit, l.windowSeconds])).toEqual([["joinsubmit", "ip", 5, 86400], ["joinsubmit", "global", 20, 86400]]);
    const m = setup();
    for (let i = 0; i < 5; i += 1) {
      const t = `synthetic-ticket-${String(i).padStart(2, "0")}-abcdefghijklmnopqrstuvwxyz`;
      const at = Math.floor(T0 / 1000);
      m.doc.rows.set(keyOf(ticketKey(t)), { ...ticketKey(t), email: `n${i}.synthetic@example.com`, emailHash: hash(`n${i}.synthetic@example.com`), expiresAt: at + 3600 });
      expect((await m.submit(submitBody({ ticket: t }))).statusCode, `submit ${i}`).toBe(201);
    }
    const res = await m.submit();
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    expect(m.rowsWith("ACCESSTICKET#")).toHaveLength(1); // the refused one keeps its ticket
  });

  it("junk requests (no ticket, bad form) never spend the limits", async () => {
    const m = setup();
    for (let i = 0; i < 30; i += 1) await m.submit(submitBody({ ticket: "x" }));
    for (let i = 0; i < 30; i += 1) await m.submit(submitBody({ form: {} }));
    expect(m.hits).toEqual([]);
    expect((await m.submit()).statusCode).toBe(201);
  });

  it("answers 503 unavailable, with nothing sent, when no client address can be derived", async () => {
    const m = setup();
    const res = await m.submit(submitBody(), { headers: { "cloudfront-viewer-address": undefined } });
    expect([res.statusCode, bodyOf(res)]).toEqual([503, { detail: "unavailable" }]);
    expect(m.logs).toEqual([JSON.stringify({ msg: "access-request unavailable", step: "no-client-ip", error: "Error" })]);
    expect(m.doc.transactions).toEqual([]);
  });
});

describe("members and open requests (409)", () => {
  it("a member is 409 already_member; the ticket stays", async () => {
    const m = setup({ members: [EMAIL] });
    const res = await m.submit();
    expect([res.statusCode, bodyOf(res)]).toEqual([409, { detail: "already_member" }]);
    expect(m.rowsWith("ACCESSTICKET#")).toHaveLength(1);
    expect(m.rowsWith("ACCESSREQ#")).toEqual([]);
    expect(m.mailer.send).not.toHaveBeenCalled();
  });

  it("an open request is 409 already_requested, whatever its state except declined and expired", async () => {
    for (const state of ["pending", "awaiting_record", "active"]) {
      const m = setup();
      m.doc.rows.set(keyOf(requestEmailKey(hash(EMAIL))), { ...requestEmailKey(hash(EMAIL)), requestId: "OLD", state });
      const res = await m.submit();
      expect([res.statusCode, bodyOf(res)], state).toEqual([409, { detail: "already_requested" }]);
      expect(m.doc.transactions).toEqual([]);
    }
  });

  it("a declined or expired request, or a guard past its TTL that DynamoDB has not purged yet, no longer blocks a new one", async () => {
    for (const old of [{ state: "declined" }, { state: "expired" }, { state: "pending", ttl: Math.floor(T0 / 1000) - 10 }]) {
      const m = setup();
      m.doc.rows.set(keyOf(requestEmailKey(hash(EMAIL))), { ...requestEmailKey(hash(EMAIL)), requestId: "OLD", ...old });
      expect((await m.submit()).statusCode, JSON.stringify(old)).toBe(201);
      expect(m.doc.rows.get(keyOf(requestEmailKey(hash(EMAIL)))).requestId).not.toBe("OLD");
    }
  });

  it("two submits racing for one address: the loser of the guard is 409, and its ticket is not consumed", async () => {
    const doc = fakeDoc({ onTransact: async (_i, rows) => { rows.set(keyOf(requestEmailKey(hash(EMAIL))), { ...requestEmailKey(hash(EMAIL)), requestId: "WON", state: "pending" }); } });
    const m = setup({ doc });
    const res = await m.submit();
    expect([res.statusCode, bodyOf(res)]).toEqual([409, { detail: "already_requested" }]);
    expect(m.rowsWith("ACCESSTICKET#")).toHaveLength(1);
    expect(m.rowsWith("ACCESSREQ#")).toEqual([]);
  });

  it("a failed membership lookup is 503 and nothing is written", async () => {
    const m = setup({ isMember: async () => { throw Object.assign(new Error("allowlist down"), { name: "AllowlistDown" }); } });
    const res = await m.submit();
    expect([res.statusCode, bodyOf(res)]).toEqual([503, { detail: "unavailable" }]);
    expect(m.doc.transactions).toEqual([]);
    expect(m.rowsWith("ACCESSTICKET#")).toHaveLength(1);
  });
});

describe("one transaction", () => {
  it("writes the request, the duplicate guard, the PII-free audit item and the ticket delete in ONE TransactWriteItems, and answers 201", async () => {
    const m = setup();
    const res = await m.submit();
    expect([res.statusCode, bodyOf(res)]).toEqual([201, { ok: true, state: "pending" }]);
    expect(m.doc.calls.filter((c) => c === "TransactWriteCommand")).toHaveLength(1);
    expect(m.doc.calls.filter((c) => c === "PutCommand" || c === "DeleteCommand")).toEqual([]); // no write outside the transaction
    const items = m.doc.transactions[0];
    expect(items).toHaveLength(4);
    expect(items[0].Delete.Key).toEqual(ticketKey(TICKET));
    expect(items[0].Delete.ConditionExpression).toBe("attribute_exists(PK)");
    expect(items[1].Put.Item.PK).toBe(`ACCESSREQEMAIL#${hash(EMAIL)}`);
    expect(items[1].Put.ConditionExpression).toBe("attribute_not_exists(PK) OR #state IN (:declined, :expired) OR #ttl <= :now");
    expect(items[2].Put.ConditionExpression).toBe("attribute_not_exists(PK)");
    expect(items[3].Put.Item.PK).toMatch(/^AUDIT#accessreq:[0-9A-Z]{26}$/);
    for (const t of items) expect((t.Delete ?? t.Put).TableName).toBe(TABLE);
  });

  it("the stored request holds the id, state, version, times, email, hash, the form without the email, the queue index key and a 90-day TTL", async () => {
    const m = setup();
    await m.submit();
    const [[, req]] = m.rowsWith("ACCESSREQ#");
    const at = Math.floor(T0 / 1000);
    expect(req).toMatchObject({
      SK: "META", entity: "accessreq", state: "pending", version: 1, email: EMAIL, emailHash: hash(EMAIL), GSI1PK: "ACCESSREQS#pending", ttl: at + REQUEST_TTL_SECONDS,
      createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:00:00.000Z",
    });
    expect(req.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(req.PK).toBe(requestKey(req.id).PK);
    expect(req.GSI1SK).toBe(req.id);
    // Q2-11(a) is unanswered, so the current city is not stored (STORE_CURRENT_CITY = false)
    const { currentPlace: _dropped, ...STORED } = FORM;
    expect(req.form).toEqual(STORED);
    expect(req.form.email).toBeUndefined();
    expect(REQUEST_TTL_SECONDS).toBe(90 * 86400);
    const guard = m.doc.rows.get(keyOf(requestEmailKey(hash(EMAIL))));
    expect(guard).toMatchObject({ requestId: req.id, state: "pending", ttl: at + REQUEST_TTL_SECONDS });
    expect(m.rowsWith("ACCESSTICKET#")).toEqual([]); // consumed
  });

  it("stores a year, never a month or day, and unknown keys are dropped", async () => {
    const m = setup();
    await m.submit(submitBody({ form: { ...FORM, birthDate: "1980-03-04", birthMonth: 3, extra: "x" } }));
    const [[, req]] = m.rowsWith("ACCESSREQ#");
    expect(Object.keys(req.form).sort()).toEqual(Object.keys(FORM).filter((k) => k !== "currentPlace").sort());
    expect(JSON.stringify(req)).not.toMatch(/1980-03|birthMonth|birthDate/);
  });

  it("the audit item is op accessreq.submit and holds {id, state} only: no address, name, place or year", async () => {
    const m = setup();
    await m.submit();
    const [[, req]] = m.rowsWith("ACCESSREQ#");
    const [[, audit]] = m.rowsWith("AUDIT#");
    expect(audit).toMatchObject({ PK: `AUDIT#accessreq:${req.id}`, entity: "audit", op: "accessreq.submit", id: req.id, GSI1PK: "AUDIT", after: { id: req.id, state: "pending" } });
    expect(audit.SK).toMatch(/^2030-01-01T00:00:00\.000Z#[0-9A-Z]{26}$/);
    expect(audit.GSI1SK).toBe(`${"2030-01-01T00:00:00.000Z"}#${req.id}`);
    const text = JSON.stringify(audit);
    for (const s of [EMAIL, hash(EMAIL), "Sam", "Exampleton", "Springfield", "Portland", "1980", TICKET]) expect(text).not.toContain(s);
    expect(Object.keys(audit.after).sort()).toEqual(["id", "state"]);
  });

  it("a failed transaction is 503: no half state, no notice", async () => {
    const m = setup({ doc: fakeDoc({ failOn: ["TransactWriteCommand"] }) });
    const res = await m.submit();
    expect([res.statusCode, bodyOf(res)]).toEqual([503, { detail: "unavailable" }]);
    expect(m.rowsWith("ACCESSREQ#")).toEqual([]);
    expect(m.rowsWith("ACCESSTICKET#")).toHaveLength(1);
    expect(m.mailer.send).not.toHaveBeenCalled();
    expect(m.admins.inbox).not.toHaveBeenCalled();
    expect(m.admins.emails).not.toHaveBeenCalled();
  });

  it("ULIDs sort by time and are unique", () => {
    const a = ulid(T0);
    const b = ulid(T0 + 1);
    expect(a).toHaveLength(26);
    expect(a < b).toBe(true);
    expect(ulid(T0)).not.toBe(ulid(T0));
  });
});

describe("after the commit", () => {
  it("emails the requester the received notice, writes the admin inbox items and emails every admin address, with no details and no link", async () => {
    const m = setup();
    await m.submit();
    const received = m.sent.filter((x) => x.template === "received");
    expect(received).toEqual([{ template: "received", to: EMAIL, vars: {} }]);
    const adminMail = m.sent.filter((x) => x.template === "admin_new");
    expect(adminMail.map((x) => x.to).sort()).toEqual(["admin.one.synthetic@example.com", "admin.two.synthetic@example.com"]);
    for (const x of adminMail) expect(x.vars).toEqual({});
    expect(m.admins.inbox).toHaveBeenCalledTimes(1);
    expect(m.admins.inbox.mock.calls[0]).toEqual([]); // the inbox item is the same for every request: no argument carries a value
    expect(m.sent).toHaveLength(3);
  });

  it("the commit comes first: every notice runs after the transaction", async () => {
    const order = [];
    const doc = fakeDoc({ onTransact: async () => { order.push("commit"); } });
    const m = setup({
      doc, admins: { inbox: async () => { order.push("inbox"); }, emails: async () => { order.push("emails"); return []; } },
    });
    m.mailer.send.mockImplementation(async () => { order.push("mail"); });
    await m.submit();
    expect(order[0]).toBe("commit");
    expect(order.slice(1).sort()).toEqual(["emails", "inbox", "mail"]);
  });

  it("every notice failing still answers 201, and the request stays stored", async () => {
    const m = setup({
      mailFails: () => true,
      admins: { inbox: async () => { throw Object.assign(new Error("inbox down"), { name: "InboxDown" }); }, emails: async () => { throw Object.assign(new Error("ddb down"), { name: "DirectoryDown" }); } },
    });
    const res = await m.submit();
    expect([res.statusCode, bodyOf(res)]).toEqual([201, { ok: true, state: "pending" }]);
    expect(m.rowsWith("ACCESSREQ#")).toHaveLength(1);
    expect(m.logs.map((l) => JSON.parse(l))).toEqual(expect.arrayContaining([
      { msg: "access-request notice failed", step: "received", error: "MessageRejected" },
      { msg: "access-request notice failed", step: "admin-inbox", error: "InboxDown" },
      { msg: "access-request notice failed", step: "admin-mail", error: "DirectoryDown" },
    ]));
  });

  it("one admin address failing does not stop the others, and the answer is still 201", async () => {
    const m = setup({ mailFails: (x) => x.to === "admin.one.synthetic@example.com" });
    expect((await m.submit()).statusCode).toBe(201);
    expect(m.sent.map((x) => x.to)).toEqual(expect.arrayContaining([EMAIL, "admin.two.synthetic@example.com"]));
    expect(m.sent.map((x) => x.to)).not.toContain("admin.one.synthetic@example.com");
  });

  it("mails at most 10 admin addresses", async () => {
    const many = Array.from({ length: 25 }, (_, i) => `admin${i}.synthetic@example.com`);
    const m = setup({ admins: { inbox: async () => undefined, emails: async () => many } });
    await m.submit();
    expect(m.sent.filter((x) => x.template === "admin_new")).toHaveLength(10);
  });

  it("with no admin wiring the requester still gets the received notice", async () => {
    const m = setup({ noAdmins: true });
    expect((await m.submit()).statusCode).toBe(201);
    expect(m.sent.map((x) => x.template)).toEqual(["received"]);
  });
});

describe("nothing private is logged", () => {
  let spies;
  const console_ = [];
  beforeEach(() => {
    console_.length = 0;
    spies = ["log", "info", "warn", "error", "debug"].map((k) => vi.spyOn(console, k).mockImplementation((...a) => console_.push(a.map(String).join(" "))));
  });
  afterEach(() => spies.forEach((s) => s.mockRestore()));

  it("no address, ticket, hash, form value or request id reaches a log across success and every failure path", async () => {
    const lines = [];
    const secrets = new Set([EMAIL, "new.cousin.synthetic", hash(EMAIL), TICKET, "Sam Synthetic", "Exampleton", "Springfield", "Portland", "synthetic-token", "admin.one.synthetic", "admin.two.synthetic"]);
    const boom = (name) => Object.assign(new Error(`${name} for ${EMAIL} ticket ${TICKET} Sam Synthetic admin.one.synthetic@example.com`), { name });
    const runs = [
      setup(),
      setup({ mailFails: () => true }),
      setup({ admins: { inbox: async () => { throw boom("InboxDown"); }, emails: async () => { throw boom("DirectoryDown"); } } }),
      setup({ doc: fakeDoc({ failOn: ["TransactWriteCommand"] }) }),
      setup({ doc: fakeDoc({ failOn: ["GetCommand"] }) }),
      setup({ doc: fakeDoc({ failOn: ["QueryCommand"] }) }),
      setup({ fetch: vi.fn(async () => { throw boom("SocketHangUp"); }) }),
      setup({ limiter: { hit: async () => { throw boom("LimiterDown"); } } }),
      setup({ members: [EMAIL] }),
      setup({ ticket: false }),
    ];
    for (const m of runs) {
      lines.push(m.logs);
      await m.submit();
      await m.submit(submitBody({ form: { ...FORM, nickname: "call 503 555 0100 Exampleton" } }));
      await m.submit(submitBody({ company: "Exampleton Springfield" }));
      await m.submit();
    }
    const all = [...lines.flat(), ...console_].join("\n");
    expect(lines.flat().length).toBeGreaterThan(5); // the failure paths did log something, so the check below has teeth
    for (const s of secrets) expect(all, `a log line contains a private value of length ${s.length}`).not.toContain(s);
    expect(all).not.toMatch(/example\.com|@|[0-9A-HJKMNP-TV-Z]{26}/);
  });

  it("failure lines are a fixed label, a step and an error name", async () => {
    const m = setup({ doc: fakeDoc({ failOn: ["TransactWriteCommand"] }) });
    await m.submit();
    expect(m.logs).toEqual([JSON.stringify({ msg: "access-request unavailable", step: "commit", error: "ProvisionedThroughputExceededException" })]);
  });
});

describe("the admin inbox item (the notification domain's registry and delivery)", () => {
  const principals = async () => ["I1001", "I1002"];

  it("registers access_request_new as a content-free inbox type that nobody can fill with a value", () => {
    const t = TEMPLATE_REGISTRY.features.access_request_new;
    expect(t).toMatchObject({ title: "Harrison Family", level0: "someone asked to join.", level1: "someone asked to join." });
    expect(t.inbox).not.toBe(false);
    expect(t.level0 + t.level1).not.toMatch(/\{/);
  });

  it("writes one unread item per admin that opens the admin queue, when inboxV1 is on", async () => {
    const store = new InMemoryNotificationStore();
    const inbox = createAdminInbox({ principals, featureOn: async (name) => name === "inboxV1", store });
    expect(await inbox.notifyNewRequest()).toEqual({ stored: 2, failed: 0 });
    for (const p of await principals()) {
      const { items } = await store.list(p, {});
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ type: "access_request_new", navigate: "/me/requests/", fields: {}, count: 1 });
      expect(items[0].read_at).toBeUndefined();
    }
  });

  it("writes nothing while inboxV1 is off, unreadable, or there are no admins", async () => {
    for (const featureOn of [undefined, async () => false, async () => { throw new Error("flags down"); }]) {
      const store = new InMemoryNotificationStore();
      const out = await createAdminInbox({ principals, featureOn, store, log: { error() {} } }).notifyNewRequest();
      expect(out).toEqual({ stored: 0, failed: 0 });
      expect(await store.unreadCount("I1001")).toBe(0);
    }
    const store = new InMemoryNotificationStore();
    expect(await createAdminInbox({ principals: async () => [], featureOn: async () => true, store }).notifyNewRequest()).toEqual({ stored: 0, failed: 0 });
  });

  it("never throws: a store failure is counted and logged as a label only", async () => {
    const logs = [];
    const boom = async () => { throw Object.assign(new Error("secret I1001 failure"), { name: "StoreDown" }); };
    const store = { add: boom, list: boom, unreadCount: boom, markRead: boom, markAllRead: boom };
    const out = await createAdminInbox({ principals, featureOn: async () => true, store, log: { error: (...a) => logs.push(a.join(" ")) } }).notifyNewRequest();
    expect(out).toEqual({ stored: 0, failed: 2 });
    expect(logs.join("\n")).not.toMatch(/I100|secret/);
    const rejecting = await createAdminInbox({ principals: boom, featureOn: async () => true, store, log: { error() {} } }).notifyNewRequest();
    expect(rejecting).toEqual({ stored: 0, failed: 0 });
  });
});

describe("the admin directory (principals and addresses)", () => {
  const entries = new Map([
    ["b.admin.synthetic@example.com", { sub: "I1001" }], ["a.admin.synthetic@example.com", { sub: "I1001" }], ["c.admin.synthetic@example.com", { sub: "I1002" }],
    ["member.synthetic@example.com", { sub: "I2000" }],
  ]);
  const admins = JSON.stringify({ admins: ["I1002", "I1001", "I1002", 7, ""] });
  const allowItem = (email, sub, state) => ({ PK: `ALLOW#${email}`, SK: "META", sub, state, GSI1PK: `ALLOWSUB#${sub}`, GSI1SK: `ALLOW#${email}` });

  it("returns the admin principals, sorted and unique, from the array or the object form", async () => {
    const d = createAdminDirectory({ readAdmins: async () => admins, readEntries: async () => entries });
    expect(await d.principals()).toEqual(["I1001", "I1002"]);
    expect(await createAdminDirectory({ readAdmins: async () => '["I3","I1"]', readEntries: async () => entries }).principals()).toEqual(["I1", "I3"]);
  });

  it("inverts the S3 allowlist: the first address per admin, sorted", async () => {
    const d = createAdminDirectory({ readAdmins: async () => admins, readEntries: async () => entries });
    expect(await d.emails()).toEqual(["a.admin.synthetic@example.com", "c.admin.synthetic@example.com"]);
  });

  it("adds the ALLOW# items through ALLOWSUB#, lets an item of either state override the file, and takes the first match", async () => {
    const doc = fakeDoc();
    const put = (it) => doc.rows.set(`${it.PK}|${it.SK}`, it);
    put(allowItem("0.dynamo.synthetic@example.com", "I1002", "active")); // sorts before the file's address for I1002
    put(allowItem("a.admin.synthetic@example.com", "I1001", "revoked")); // revokes the file's first address for I1001
    const d = createAdminDirectory({ readAdmins: async () => admins, readEntries: async () => entries, ddb: doc, cmds, table: TABLE });
    expect(await d.emails()).toEqual(["0.dynamo.synthetic@example.com", "b.admin.synthetic@example.com"]);
  });

  it("is best effort: a failure answers an empty list, is logged as a label, and is not cached", async () => {
    const logs = [];
    let fail = true;
    const d = createAdminDirectory({
      readAdmins: async () => { if (fail) throw Object.assign(new Error("a.admin.synthetic@example.com"), { name: "S3Down" }); return admins; },
      readEntries: async () => entries, log: { error: (...a) => logs.push(a.join(" ")) },
    });
    expect(await d.principals()).toEqual([]);
    expect(await d.emails()).toEqual([]);
    expect(logs.join("\n")).not.toMatch(/example\.com/);
    fail = false;
    expect(await d.principals()).toEqual(["I1001", "I1002"]);
  });

  it("caches for the TTL", async () => {
    let n = 0;
    let clock = 0;
    const d = createAdminDirectory({ readAdmins: async () => { n += 1; return admins; }, readEntries: async () => entries, ttlMs: 1000, now: () => clock });
    await d.principals(); await d.principals();
    expect(n).toBe(1);
    clock = 1001;
    await d.principals();
    expect(n).toBe(2);
  });
});

describe("the flag reader", () => {
  it("reads the site's flags, caches for 60 s, keeps the last good value for 10 minutes and then fails closed", async () => {
    let clock = 0;
    let mode = "ok";
    const fetch = vi.fn(async () => { if (mode === "down") throw new Error("down"); return { ok: true, json: async () => ({ inboxV1: true, other: "yes" }) }; });
    const f = createFlagReader({ url: "https://site.example.test/_data/flags.json", fetch, now: () => clock, log: { error() {} } });
    expect(await f.on("inboxV1")).toBe(true);
    expect(await f.on("other")).toBe(false); // only a real true counts
    expect(fetch).toHaveBeenCalledTimes(1);
    mode = "down";
    clock = 61_000;
    expect(await f.on("inboxV1")).toBe(true); // stale but within 10 minutes
    clock = 61_000 + 600_001;
    expect(await f.on("inboxV1")).toBe(false);
  });

  it("is off when the flags cannot be read at all", async () => {
    const f = createFlagReader({ fetch: async () => ({ ok: false }), log: { error() {} } });
    expect(await f.on("inboxV1")).toBe(false);
  });
});

describe("wired like the Lambda: createAccessRequestRoutes", () => {
  class SecretsManagerClient { async send(c) { return { SecretString: c.input.SecretId.includes("turnstile") ? JSON.stringify({ secret: "synthetic-turnstile-secret" }) : PEPPER }; } }
  class GetSecretValueCommand { constructor(input) { this.input = input; } }
  const ENV = {
    ACCESS_REQUESTS: "on", TURNSTILE_SECRET_NAME: "harrisonfamily/auth-edge/turnstile", ACCESS_REQUEST_PEPPER_SECRET: "harrisonfamily/access-request/pepper",
    JOIN_FROM_ADDRESS: "no-reply@join.example.test", JOIN_SES_CONFIGURATION_SET: "hfy-access-request", JOIN_MAIL_ALARMS: "alarm-bounce,alarm-complaint",
  };
  function wired({ inbox = false, withAdmins = true } = {}) {
    const ses = [];
    class SESv2Client { async send(c) { ses.push(c.input); return {}; } }
    class SendEmailCommand { constructor(input) { this.input = input; } }
    class CloudWatchClient { async send(c) { return { MetricAlarms: c.input.AlarmNames.map((n) => ({ AlarmName: n, StateValue: "OK" })) }; } }
    class DescribeAlarmsCommand { constructor(input) { this.input = input; } }
    const mods = { "@aws-sdk/client-sesv2": { SESv2Client, SendEmailCommand }, "@aws-sdk/client-cloudwatch": { CloudWatchClient, DescribeAlarmsCommand } };
    const doc = fakeDoc();
    const at = Math.floor(T0 / 1000);
    doc.rows.set(keyOf(ticketKey(TICKET)), { ...ticketKey(TICKET), email: EMAIL, emailHash: hash(EMAIL), expiresAt: at + 3600 });
    const fetch = vi.fn(async (url) => (String(url).includes("flags.json")
      ? { ok: true, json: async () => ({ inboxV1: inbox }) }
      : { ok: true, json: async () => ({ success: true, hostname: "harrisonfamily.us", action: "join" }) }));
    const ar = createAccessRequestRoutes({
      m: { site: "harrisonfamily.us", authOrigin: SITE }, doc, cmds, tableName: TABLE, limiter: memoryRateLimiter({ now: () => T0 }), sm: { SecretsManagerClient, GetSecretValueCommand },
      resolver: async () => null, env: { ...ENV, FLAGS_URL: "https://harrisonfamily.us/_data/flags.json" }, sdkImport: async (n) => mods[n], fetch,
      ...(withAdmins ? { readAdmins: async () => '["I1001"]', readEntries: async () => new Map([["admin.synthetic@example.com", { sub: "I1001" }]]) } : {}),
    });
    return { ar, ses, doc, fetch };
  }

  it("sends the received notice from the JOIN identity and one admin_new mail per admin address, reading the admins from the files", async () => {
    const w = wired();
    const res = await w.ar.handle("/access-request", post(submitBody()));
    expect([res.statusCode, bodyOf(res)]).toEqual([201, { ok: true, state: "pending" }]);
    const byTo = Object.fromEntries(w.ses.map((s) => [s.Destination.ToAddresses[0], s]));
    expect(Object.keys(byTo).sort()).toEqual(["admin.synthetic@example.com", EMAIL]);
    expect(byTo[EMAIL].Content.Simple.Subject.Data).toBe("we got your request");
    expect(byTo["admin.synthetic@example.com"].Content.Simple.Subject.Data).toBe("someone asked to join the family site");
    for (const s of w.ses) expect(s).toMatchObject({ FromEmailAddress: "no-reply@join.example.test", ConfigurationSetName: "hfy-access-request" });
    expect(JSON.stringify(byTo["admin.synthetic@example.com"])).not.toMatch(/Sam|Exampleton|Springfield|new\.cousin/);
    expect(w.fetch.mock.calls.some(([u]) => String(u).includes("flags.json"))).toBe(true); // the inbox write asked the flag first
  });

  it("without the admin readers the submit still works and sends the receipt only", async () => {
    const w = wired({ withAdmins: false });
    expect((await w.ar.handle("/access-request", post(submitBody()))).statusCode).toBe(201);
    expect(w.ses.map((s) => s.Destination.ToAddresses[0])).toEqual([EMAIL]);
  });

  it("answers 503 closed unless ACCESS_REQUESTS is on", async () => {
    const w = wired();
    const off = createAccessRequestRoutes({ m: { site: "harrisonfamily.us", authOrigin: SITE }, doc: w.doc, cmds, tableName: TABLE, limiter: memoryRateLimiter(), sm: {}, resolver: async () => null, env: { ...ENV, ACCESS_REQUESTS: "off" } });
    expect(bodyOf(await off.handle("/access-request", post(submitBody())))).toEqual({ detail: "closed" });
    expect(w.doc.calls).toEqual([]);
  });
});
