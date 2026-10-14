// The anonymous access-request routes (HFY-TSK-195, surfaces.md 7.2 and 7.5): kill switch and CSRF checks, Turnstile, the honeypot, every
// rate limit one by one, the pending-queue cap, enumeration parity, the code and the ticket, the bounce and complaint alarm, and
// log hygiene. Every address, code and token in this file is synthetic.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { generateKeyPair, exportJWK, createLocalJWKSet } from "jose";
import { createIdentityService, memoryLinkStore, memoryRefreshStore } from "@io-kit/auth/server";
import { buildResolver } from "@io-kit/auth/edge/deploy";
import {
  CODE_TTL_SECONDS, MAX_CODE_ATTEMPTS, QUEUE_CAP, SUBMIT_LIMITS, START_LIMITS, TICKET_TTL_SECONDS, TURNSTILE_URL, VERIFY_LIMITS,
  codeMac, createAccessRequest, createMailAlarmGate, emailHash, normalizeJoinEmail, ticketKey, verifyTurnstile,
} from "../src/access-request.js";
import { createSesMailer, sendEmailInput } from "../src/mailer.js";
import { memoryRateLimiter } from "../src/ratelimit.js";
import { createAuthEdge, loadManifest } from "../src/edge.js";
import { createAccessRequestRoutes } from "../src/index.js";

const SITE = "https://harrisonfamily.us";
const TABLE = "app-table";
const PEPPER = "synthetic-pepper-not-a-secret";
const TURNSTILE_SECRET = "synthetic-turnstile-secret";
const T0 = Date.parse("2030-01-01T00:00:00Z");

class Cmd { constructor(input) { this.input = input; } }
class GetCommand extends Cmd {}
class PutCommand extends Cmd {}
class UpdateCommand extends Cmd {}
class DeleteCommand extends Cmd {}
class QueryCommand extends Cmd {}
class TransactWriteCommand extends Cmd {}
const cmds = { GetCommand, PutCommand, UpdateCommand, DeleteCommand, QueryCommand, TransactWriteCommand };

const dbError = (name) => Object.assign(new Error(`${name} for table/${TABLE}`), { name });
const keyOf = (k) => `${k.PK}|${k.SK}`;
const condOk = (expr, existing) => {
  if (!expr) return true;
  const m = /^attribute_(exists|not_exists)\(PK\)$/.exec(expr.trim());
  if (!m) throw new Error(`fake doc: unsupported condition ${expr}`);
  return m[1] === "exists" ? existing !== undefined : existing === undefined;
};

/** A lib-dynamodb DocumentClient fake: Get, Put, Update (ADD n :v), Delete, Query (GSI1 equality, COUNT), TransactWrite (Delete and Put). */
function fakeDoc({ failOn } = {}) {
  const rows = new Map();
  const calls = [];
  return {
    rows,
    calls,
    async send(cmd) {
      const kind = cmd.constructor.name;
      calls.push(kind);
      if (failOn?.includes(kind)) throw dbError("ProvisionedThroughputExceededException");
      const i = cmd.input;
      expect(i.TableName ?? i.TransactItems?.[0]?.Delete?.TableName ?? i.TransactItems?.[0]?.Put?.TableName).toBe(TABLE);
      if (kind === "GetCommand") { const it = rows.get(keyOf(i.Key)); return it ? { Item: structuredClone(it) } : {}; }
      if (kind === "PutCommand") {
        if (!condOk(i.ConditionExpression, rows.get(keyOf(i.Item)))) throw dbError("ConditionalCheckFailedException");
        rows.set(keyOf(i.Item), structuredClone(i.Item));
        return {};
      }
      if (kind === "DeleteCommand") { rows.delete(keyOf(i.Key)); return {}; }
      if (kind === "UpdateCommand") {
        const k = keyOf(i.Key);
        if (!condOk(i.ConditionExpression, rows.get(k))) throw dbError("ConditionalCheckFailedException");
        const m = /^ADD (\w+) (:\w+)$/.exec(i.UpdateExpression);
        if (!m) throw new Error(`fake doc: unsupported update ${i.UpdateExpression}`);
        const it = rows.get(k);
        it[m[1]] = (it[m[1]] ?? 0) + i.ExpressionAttributeValues[m[2]];
        return { Attributes: { [m[1]]: it[m[1]] } };
      }
      if (kind === "QueryCommand") {
        expect(i.IndexName).toBe("GSI1");
        expect(i.KeyConditionExpression).toBe("GSI1PK = :pk");
        expect(i.Select).toBe("COUNT");
        const hits = [...rows.values()].filter((r) => r.GSI1PK === i.ExpressionAttributeValues[":pk"]);
        return { Count: Math.min(hits.length, i.Limit ?? Infinity) };
      }
      if (kind === "TransactWriteCommand") {
        for (const t of i.TransactItems) {
          const item = t.Delete ? rows.get(keyOf(t.Delete.Key)) : rows.get(keyOf(t.Put.Item));
          if (!condOk((t.Delete ?? t.Put).ConditionExpression, item)) throw dbError("TransactionCanceledException");
        }
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

const post = (rel, body, over = {}) => ({
  rawPath: `/auth${rel}`, requestContext: { http: { method: "POST" } },
  headers: { "x-requested-with": "io-kit", origin: SITE, "content-type": "application/json", "cloudfront-viewer-address": "203.0.113.7:4444", ...over.headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
  ...over.event,
});
const getConfig = (headers = {}) => ({ rawPath: "/auth/access-request/config", requestContext: { http: { method: "GET" } }, headers: { "x-requested-with": "io-kit", ...headers } });
const bodyOf = (res) => JSON.parse(res.body);

/** Everything wired with fakes. `clock.now` moves time forward for the limiters, the code and the ticket alike. */
function setup(o = {}) {
  const clock = { now: T0 };
  const now = () => clock.now;
  const doc = o.doc ?? fakeDoc();
  const limiter = o.limiter ?? memoryRateLimiter({ now });
  const hits = [];
  const spyLimiter = { hit: async (key, cfg) => { hits.push({ key, cfg }); return limiter.hit(key, cfg); } };
  const sent = [];
  const mailer = { send: vi.fn(async (m) => { if (o.mailFails) throw Object.assign(new Error(`rejected ${m.to}`), { name: "MessageRejected" }); sent.push(m); }) };
  const fetch = o.fetch ?? vi.fn(async () => ({ ok: true, json: async () => ({ success: true, hostname: "harrisonfamily.us", action: "join" }) }));
  const logs = [];
  const log = { error: (...a) => logs.push(a.join(" ")), warn: (...a) => logs.push(a.join(" ")), info: (...a) => logs.push(a.join(" ")), log: (...a) => logs.push(a.join(" ")) };
  const state = { on: o.on ?? true, member: new Set(o.members ?? []), alarm: o.alarm ?? "OK" };
  const codes = o.codes ? [...o.codes] : [];
  const ar = createAccessRequest({
    flag: () => state.on, siteOrigin: SITE, siteHost: "harrisonfamily.us", turnstileSiteKey: "1x-synthetic-site-key",
    ddb: doc, cmds, table: TABLE, limiter: spyLimiter, mailer, fetch,
    secrets: { turnstile: o.turnstileSecret ?? (async () => TURNSTILE_SECRET), pepper: o.pepper ?? (async () => PEPPER) },
    isMember: async (email) => state.member.has(email),
    ...(o.mailConfigured ? { mailConfigured: o.mailConfigured } : {}),
    mailAlarm: o.mailAlarm ?? { isFiring: async () => { if (state.alarm === "THROW") throw new Error("cloudwatch down"); return state.alarm === "ALARM"; } },
    random: () => (codes.length ? codes.shift() : 424242), now, log,
  });
  const call = (rel, body, over) => ar.handle(rel, post(rel, body, over));
  const start = (email, over = {}) => call("/access-request/start", { email, turnstileToken: "synthetic-token", company: "", ...over.body }, over);
  const verify = (email, code, over) => call("/access-request/verify", { email, code }, over);
  return { ar, doc, clock, hits, sent, mailer, fetch, logs, state, start, verify, call };
}
const ipHeader = (ip) => ({ headers: { "cloudfront-viewer-address": `${ip}:5555` } });
const mailOf = (m) => m.sent.at(-1);
const hash = (email) => emailHash(PEPPER, email);
const putCode = (m, email, code, extra = {}) =>
  m.doc.rows.set(`ACCESSCODE#${hash(email)}|META`, { PK: `ACCESSCODE#${hash(email)}`, SK: "META", attempts: 0, codeMac: codeMac(PEPPER, email, code), expiresAt: Math.floor(m.clock.now / 1000) + CODE_TTL_SECONDS, ...extra });

describe("the kill switch and the request checks (7.2)", () => {
  it("every route answers 503 closed while ACCESS_REQUESTS is off, before any other check", async () => {
    const m = setup({ on: false });
    for (const rel of ["start", "verify", "config"]) {
      const res = await m.ar.handle(`/access-request/${rel}`, { rawPath: "", requestContext: { http: { method: "PUT" } }, headers: {} }); // not even a valid request
      expect([res.statusCode, bodyOf(res)]).toEqual([503, { detail: "closed" }]);
    }
    expect((await m.start("a@example.com")).statusCode).toBe(503);
    expect(m.fetch).not.toHaveBeenCalled();
    expect(m.mailer.send).not.toHaveBeenCalled();
    expect(m.doc.calls).toEqual([]);
  });

  it("POST is required (403 for any other method)", async () => {
    const m = setup();
    for (const method of ["GET", "PUT", "DELETE", "OPTIONS", "HEAD"]) {
      const res = await m.ar.handle("/access-request/start", { ...post("/access-request/start", {}), requestContext: { http: { method } } });
      expect(res.statusCode, method).toBe(403);
    }
    expect((await m.ar.handle("/access-request/config", post("/access-request/config", {}))).statusCode).toBe(403); // config is a GET
  });

  it("a JSON content type is required (403)", async () => {
    const m = setup();
    for (const ct of [undefined, "text/plain", "application/x-www-form-urlencoded", "multipart/form-data", "application/jsonp"]) {
      const res = await m.start("a@example.com", { headers: { "content-type": ct } });
      expect(res.statusCode, String(ct)).toBe(403);
    }
    expect((await m.start("a@example.com", { headers: { "content-type": "application/json; charset=utf-8" } })).statusCode).toBe(202);
  });

  it("x-requested-with io-kit is required (403)", async () => {
    const m = setup();
    for (const v of [undefined, "", "XMLHttpRequest", "IO-KIT"]) expect((await m.start("a@example.com", { headers: { "x-requested-with": v } })).statusCode, String(v)).toBe(403);
  });

  it("the site Origin is required (403 for none, another site, a look-alike or the null origin)", async () => {
    const m = setup();
    for (const origin of [undefined, "https://evil.example", "https://harrisonfamily.us.evil.example", "http://harrisonfamily.us", "null", "https://www.harrisonfamily.us"]) {
      const res = await m.start("a@example.com", { headers: { origin } });
      expect(res.statusCode, String(origin)).toBe(403);
    }
    expect((await m.start("a@example.com", { headers: { origin: `${SITE}/` } })).statusCode).toBe(202); // a trailing slash is the same origin
    expect(m.fetch).toHaveBeenCalledTimes(1); // a refused request never reached Turnstile
  });

  it("config answers the site key to a GET with the header, and refuses a foreign Origin", async () => {
    const m = setup();
    const ok = await m.ar.handle("/access-request/config", getConfig());
    expect([ok.statusCode, bodyOf(ok)]).toEqual([200, { open: true, turnstileSiteKey: "1x-synthetic-site-key" }]);
    expect((await m.ar.handle("/access-request/config", getConfig({ origin: SITE }))).statusCode).toBe(200);
    expect((await m.ar.handle("/access-request/config", getConfig({ origin: "https://evil.example" }))).statusCode).toBe(403);
    expect((await m.ar.handle("/access-request/config", getConfig({ "x-requested-with": "" }))).statusCode).toBe(403);
  });

  it("responses are never cached and unknown paths are not handled", async () => {
    const m = setup();
    expect((await m.start("a@example.com")).headers["cache-control"]).toBe("no-store");
    expect(await m.ar.handle("/access-request/nope", post("/access-request/nope", {}))).toBeUndefined();
    expect((await m.ar.handle("/access-request", post("/access-request", {}))).statusCode).toBe(403); // the submit route (surf-access-submit): no ticket
    expect(await m.ar.handle("/access-request/constructor", post("/access-request/constructor", {}))).toBeUndefined();
  });
});

describe("start: honeypot and email validation", () => {
  it("a filled honeypot is a silent 202 with no Turnstile call, no limiter hit, no write and no mail", async () => {
    const m = setup();
    const res = await m.start("a@example.com", { body: { company: "Acme Inc" } });
    expect([res.statusCode, bodyOf(res)]).toEqual([202, { ok: true }]);
    expect(m.fetch).not.toHaveBeenCalled();
    expect(m.hits).toEqual([]);
    expect(m.doc.calls).toEqual([]);
    expect(m.mailer.send).not.toHaveBeenCalled();
    const bad = await m.start("not-an-email", { body: { company: "x" } }); // even with a bad address, the trap answers success
    expect(bad.statusCode).toBe(202);
  });

  it("a bad address is 400 invalid_email before Turnstile", async () => {
    const m = setup();
    for (const email of ["", "plain", "a@b", "a b@example.com", "@example.com", "a@@example.com", "a..b@example.com", ".a@example.com", `${"x".repeat(250)}@example.com`, `${"y".repeat(65)}@example.com`, 5, null, ["a@example.com"], "<a@example.com>"]) {
      const res = await m.start(email);
      expect([res.statusCode, bodyOf(res)], String(email)).toEqual([400, { detail: "invalid_email" }]);
    }
    expect(m.fetch).not.toHaveBeenCalled();
    expect((await m.call("/access-request/start", "{not json")).statusCode).toBe(400);
    expect((await m.call("/access-request/start", "[]")).statusCode).toBe(400);
  });

  it("normalizes: trim and lower-case, at most 254 characters", () => {
    expect(normalizeJoinEmail("  Ana.Synthetic@Example.COM ")).toBe("ana.synthetic@example.com");
    expect(normalizeJoinEmail(`${"a".repeat(64)}@${"b".repeat(60)}.example.com`)).not.toBe("");
    expect(normalizeJoinEmail(`${"a".repeat(64)}@${"b".repeat(190)}.com`)).toBe("");
  });
});

describe("Turnstile (7.5)", () => {
  const answer = (o) => vi.fn(async () => ({ ok: true, json: async () => o }));

  it("sends the secret, the token and the client IP to siteverify with a 3 second abort", async () => {
    const m = setup();
    await m.start("a@example.com", { headers: { "cloudfront-viewer-address": "198.51.100.9:1" } });
    const [url, init] = m.fetch.mock.calls[0];
    expect(url).toBe(TURNSTILE_URL);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ secret: TURNSTILE_SECRET, response: "synthetic-token", remoteip: "198.51.100.9" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("requires success, hostname harrisonfamily.us and action join (403 bot_check_failed otherwise), and sends nothing", async () => {
    for (const out of [{ success: false, "error-codes": ["invalid-input-response"] }, { success: true, hostname: "evil.example", action: "join" }, { success: true, hostname: "harrisonfamily.us", action: "login" },
      { success: true, hostname: "harrisonfamily.us" }, { success: true, action: "join" }, { success: "true", hostname: "harrisonfamily.us", action: "join" }, {}]) {
      const m = setup({ fetch: answer(out) });
      const res = await m.start("a@example.com");
      expect([res.statusCode, bodyOf(res)], JSON.stringify(out)).toEqual([403, { detail: "bot_check_failed" }]);
      expect(m.mailer.send).not.toHaveBeenCalled();
      expect(m.hits).toEqual([]); // a failed bot check spends no rate-limit budget
      expect(m.doc.calls).toEqual([]);
    }
  });

  it("a missing, empty, over-long or non-string token is refused without calling Cloudflare", async () => {
    const m = setup();
    for (const turnstileToken of [undefined, "", "x".repeat(2049), 7, {}]) {
      const res = await m.start("a@example.com", { body: { turnstileToken } });
      expect(res.statusCode, String(turnstileToken)).toBe(403);
    }
    expect(m.fetch).not.toHaveBeenCalled();
  });

  it("fails closed with 503: a timeout, a network error, an HTTP error, a malformed answer, a server-side misconfiguration, no secret", async () => {
    const cases = {
      "network error": vi.fn(async () => { throw new Error("ECONNRESET"); }),
      "http 500": vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })),
      "not json": vi.fn(async () => ({ ok: true, json: async () => { throw new SyntaxError("x"); } })),
      "null body": vi.fn(async () => ({ ok: true, json: async () => null })),
      "internal-error": answer({ success: false, "error-codes": ["internal-error"] }),
      "bad secret": answer({ success: false, "error-codes": ["invalid-input-secret"] }),
    };
    for (const [name, fetch] of Object.entries(cases)) {
      const m = setup({ fetch });
      const res = await m.start("a@example.com");
      expect([res.statusCode, bodyOf(res)], name).toEqual([503, { detail: "unavailable" }]);
      expect(m.mailer.send).not.toHaveBeenCalled();
    }
    const m = setup({ turnstileSecret: async () => { throw new Error("AccessDenied"); } });
    expect((await m.start("a@example.com")).statusCode).toBe(503);
  });

  it("aborts after 3 seconds and fails closed", async () => {
    vi.useFakeTimers();
    try {
      let signal;
      const fetch = vi.fn((_url, init) => new Promise((_res, rej) => { signal = init.signal; signal.addEventListener("abort", () => rej(new Error("aborted"))); }));
      const p = verifyTurnstile({ token: "t", ip: "203.0.113.7", secret: "s", hostname: "harrisonfamily.us", fetch });
      await vi.advanceTimersByTimeAsync(2999);
      expect(signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(signal.aborted).toBe(true);
      expect(await p).toBe("unavailable");
    } finally {
      vi.useRealTimers();
    }
  });

  it("an end-to-end 3 s timeout on the route answers 503 and sends nothing", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn((_u, init) => new Promise((_r, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted")))));
      const m = setup({ fetch });
      const p = m.start("a@example.com");
      await vi.advanceTimersByTimeAsync(3001);
      expect((await p).statusCode).toBe(503);
      expect(m.mailer.send).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts a good answer", async () => {
    expect(await verifyTurnstile({ token: "t", secret: "s", hostname: "harrisonfamily.us", fetch: answer({ success: true, hostname: "harrisonfamily.us", action: "join" }) })).toBe("ok");
  });
});

describe("rate limits (7.5), each enforced on its own", () => {
  const status = async (m, email, ip = "203.0.113.7") => (await m.start(email, ipHeader(ip))).statusCode;
  const minute = (m, s = 61) => { m.clock.now += s * 1000; };

  it("the table matches section 7.5", () => {
    expect(START_LIMITS.map((l) => `${l.name}/${l.scope}/${l.limit}/${l.windowSeconds}`)).toEqual([
      "joincode/email/1/60", "joincode/email+ip/3/3600", "joincode/email/5/86400", "joincode/ip/10/86400", "joincode/global/50/86400",
    ]);
    expect(VERIFY_LIMITS.map((l) => `${l.name}/${l.scope}/${l.limit}/${l.windowSeconds}`)).toEqual(["joinverify/ip/30/3600", "joinverify/email/10/3600"]);
    expect(SUBMIT_LIMITS.map((l) => `${l.name}/${l.scope}/${l.limit}/${l.windowSeconds}`)).toEqual(["joinsubmit/ip/5/86400", "joinsubmit/global/20/86400"]);
  });

  it("joincode email, resend gap: a second code for the same address within 60 s is 429 with retry-after, and fine after it", async () => {
    const m = setup();
    expect(await status(m, "a@example.com")).toBe(202);
    const res = await m.start("a@example.com", ipHeader("203.0.113.7"));
    expect([res.statusCode, bodyOf(res)]).toEqual([429, { detail: "rate_limited" }]);
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    expect(Number(res.headers["retry-after"])).toBeLessThanOrEqual(60);
    minute(m);
    expect(await status(m, "a@example.com")).toBe(202);
  });

  it("joincode email+ip: the 4th code for one address from one IP inside an hour is 429", async () => {
    const m = setup();
    for (let i = 0; i < 3; i += 1) { expect(await status(m, "a@example.com", "198.51.100.1")).toBe(202); minute(m); }
    const res = await m.start("a@example.com", ipHeader("198.51.100.1"));
    expect(res.statusCode).toBe(429);
    expect(m.hits.some((h) => h.cfg.scope === "email+ip" && h.cfg.limit === 3)).toBe(true);
    expect(m.hits.filter((h) => h.cfg.scope === "email" && h.cfg.windowSeconds === 86400)).toHaveLength(3); // the 24 h email limit never saw the 4th
    expect(m.sent).toHaveLength(3);
  });

  it("joincode email: the 6th code for one address in 24 h is 429 even from fresh IPs", async () => {
    const m = setup();
    for (let i = 0; i < 5; i += 1) { expect(await status(m, "a@example.com", `198.51.100.${10 + i}`)).toBe(202); minute(m); }
    expect(await status(m, "a@example.com", "198.51.100.99")).toBe(429);
    m.clock.now += 86400 * 1000;
    expect(await status(m, "a@example.com", "198.51.100.98")).toBe(202); // a new window
  });

  it("joincode ip: the 11th code from one IP in 24 h is 429 across different addresses", async () => {
    const m = setup();
    for (let i = 0; i < 10; i += 1) expect(await status(m, `p${i}@example.com`, "192.0.2.50")).toBe(202);
    expect(await status(m, "p10@example.com", "192.0.2.50")).toBe(429);
    expect(await status(m, "p11@example.com", "192.0.2.51")).toBe(202); // another IP is unaffected
  });

  it("joincode global: the 51st code in 24 h is 429 for everyone", async () => {
    const m = setup();
    for (let i = 0; i < 50; i += 1) expect(await status(m, `g${i}@example.com`, `10.${Math.floor(i / 200)}.${i % 200}.1`)).toBe(202);
    const res = await m.start("g50@example.com", ipHeader("10.9.9.9"));
    expect([res.statusCode, bodyOf(res).detail]).toEqual([429, "rate_limited"]);
    expect(m.sent).toHaveLength(50);
  });

  it("the limiters run in order and stop at the first denial, so a refused request never spends the global budget", async () => {
    const m = setup();
    await status(m, "a@example.com");
    const before = m.hits.filter((h) => h.cfg.scope === "global").length;
    for (let i = 0; i < 5; i += 1) await status(m, "a@example.com"); // all refused by the 60 s gap
    expect(m.hits.filter((h) => h.cfg.scope === "global")).toHaveLength(before);
  });

  it("limiter keys hold no address and no IP", async () => {
    const m = setup();
    await status(m, "someone.synthetic@example.com", "198.51.100.77");
    for (const h of m.hits) expect(h.key).not.toMatch(/someone|example|198\.51/);
  });

  it("a limiter failure fails closed with 503: no code, no mail", async () => {
    const m = setup({ limiter: { hit: async () => { throw dbError("ProvisionedThroughputExceededException"); } } });
    const res = await m.start("a@example.com");
    expect([res.statusCode, bodyOf(res)]).toEqual([503, { detail: "unavailable" }]);
    expect(m.mailer.send).not.toHaveBeenCalled();
    expect([...m.doc.rows.keys()]).toEqual([]);
  });

  it("joinverify email: the 11th verification for one address in an hour is 429 too_many_attempts", async () => {
    const m = setup();
    for (let i = 0; i < 10; i += 1) expect((await m.verify("a@example.com", "000000")).statusCode).toBe(400);
    const res = await m.verify("a@example.com", "000000");
    expect([res.statusCode, bodyOf(res)]).toEqual([429, { detail: "too_many_attempts" }]);
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    expect((await m.verify("b@example.com", "000000")).statusCode).toBe(400); // another address is unaffected
  });

  it("joinverify ip: the 31st verification from one IP in an hour is 429 across addresses, and it does not spend an address's own budget", async () => {
    const m = setup();
    for (let i = 0; i < 30; i += 1) expect((await m.verify(`a${i}@example.com`, "000000", ipHeader("192.0.2.50"))).statusCode).toBe(400);
    const res = await m.verify("victim@example.com", "000000", ipHeader("192.0.2.50"));
    expect([res.statusCode, bodyOf(res)]).toEqual([429, { detail: "too_many_attempts" }]);
    for (let i = 0; i < 10; i += 1) expect((await m.verify("victim@example.com", "000000", ipHeader("192.0.2.51"))).statusCode).toBe(400); // the refused calls spent none of it
  });

  it("joinsubmit ip: the 6th submit from one IP in 24 h is 429", async () => {
    const m = setup();
    const ev = post("/access-request", {}, ipHeader("192.0.2.77"));
    for (let i = 0; i < 5; i += 1) expect(await m.ar.submitAdmission(ev)).toBeUndefined();
    const res = await m.ar.submitAdmission(ev);
    expect([res.statusCode, bodyOf(res)]).toEqual([429, { detail: "rate_limited" }]);
    expect(await m.ar.submitAdmission(post("/access-request", {}, ipHeader("192.0.2.78")))).toBeUndefined();
  });

  it("joinsubmit global: the 21st submit in 24 h is 429 from fresh IPs", async () => {
    const m = setup();
    for (let i = 0; i < 20; i += 1) expect(await m.ar.submitAdmission(post("/access-request", {}, ipHeader(`10.1.${i}.1`)))).toBeUndefined();
    const res = await m.ar.submitAdmission(post("/access-request", {}, ipHeader("10.1.99.1")));
    expect(res.statusCode).toBe(429);
  });

  it("a submit limiter failure is 503", async () => {
    const m = setup({ limiter: { hit: async () => { throw new Error("down"); } } });
    expect((await m.ar.submitAdmission(post("/access-request", {}))).statusCode).toBe(503);
  });
});

describe("the 100-pending queue cap", () => {
  const pending = (m, n) => { for (let i = 0; i < n; i += 1) m.doc.rows.set(`ACCESSREQ#${i}|META`, { PK: `ACCESSREQ#${i}`, SK: "META", GSI1PK: "ACCESSREQS#pending", GSI1SK: String(i) }); };

  it("with 100 pending, start answers 503 queue_full to every address alike and sends nothing", async () => {
    const m = setup({ members: ["member@example.com"] });
    pending(m, QUEUE_CAP);
    for (const email of ["new@example.com", "member@example.com"]) {
      const res = await m.start(email);
      expect([res.statusCode, bodyOf(res)], email).toEqual([503, { detail: "queue_full" }]);
    }
    expect(m.mailer.send).not.toHaveBeenCalled();
    expect(m.hits).toEqual([]);
  });

  it("with 99 pending, start still answers 202", async () => {
    const m = setup();
    pending(m, QUEUE_CAP - 1);
    expect((await m.start("new@example.com")).statusCode).toBe(202);
  });

  it("decided requests do not count", async () => {
    const m = setup();
    for (let i = 0; i < 150; i += 1) m.doc.rows.set(`ACCESSREQ#d${i}|META`, { PK: `ACCESSREQ#d${i}`, SK: "META", GSI1PK: "ACCESSREQS#active", GSI1SK: String(i) });
    expect((await m.start("new@example.com")).statusCode).toBe(202);
  });

  it("submitAdmission refuses with 503 queue_full at the cap, before it spends a submit limit", async () => {
    const m = setup();
    pending(m, QUEUE_CAP);
    const res = await m.ar.submitAdmission(post("/access-request", {}));
    expect([res.statusCode, bodyOf(res)]).toEqual([503, { detail: "queue_full" }]);
    expect(m.hits).toEqual([]);
  });

  it("a table failure while counting fails closed", async () => {
    const m = setup({ doc: fakeDoc({ failOn: ["QueryCommand"] }) });
    expect((await m.start("a@example.com")).statusCode).toBe(503);
    expect((await m.ar.submitAdmission(post("/access-request", {}))).statusCode).toBe(503);
  });
});

describe("enumeration parity (7.1)", () => {
  const openRequest = (m, email, state, extra = {}) => m.doc.rows.set(`ACCESSREQEMAIL#${hash(email)}|META`, { PK: `ACCESSREQEMAIL#${hash(email)}`, SK: "META", requestId: "01HSYNTHETIC", state, ...extra });

  it("a member, an open request and a new address all get 202 {ok:true} and exactly one mailer call", async () => {
    const m = setup({ members: ["member@example.com"], codes: [111111, 222222, 333333] });
    openRequest(m, "pending@example.com", "pending");
    const out = [];
    for (const email of ["member@example.com", "pending@example.com", "new@example.com"]) {
      const before = m.mailer.send.mock.calls.length;
      const res = await m.start(email, ipHeader(`198.51.100.${out.length + 1}`));
      out.push({ status: res.statusCode, body: res.body, headers: Object.keys(res.headers).sort(), calls: m.mailer.send.mock.calls.length - before });
    }
    expect(out.map((o) => [o.status, o.body, o.headers.join(","), o.calls])).toEqual(Array(3).fill([202, '{"ok":true}', "cache-control,content-type", 1]));
    expect(m.sent.map((s) => [s.to, s.template])).toEqual([["member@example.com", "already_member"], ["pending@example.com", "already_requested"], ["new@example.com", "code"]]);
    expect(m.sent.map((s) => s.vars)).toEqual([{}, {}, { code: "333333" }]);
  });

  it("the database work is the same too: one code item written for each, with the same expiry", async () => {
    const m = setup({ members: ["member@example.com"] });
    openRequest(m, "pending@example.com", "pending");
    const shape = [];
    for (const [i, email] of ["member@example.com", "pending@example.com", "new@example.com"].entries()) {
      m.doc.calls.length = 0;
      await m.start(email, ipHeader(`198.51.100.${i + 1}`));
      const item = m.doc.rows.get(`ACCESSCODE#${hash(email)}|META`);
      expect(item).toBeTruthy();
      shape.push({ calls: [...m.doc.calls], keys: Object.keys(item).sort(), life: item.expiresAt - Math.floor(m.clock.now / 1000), attempts: item.attempts });
    }
    expect(shape[1]).toEqual(shape[0]);
    expect(shape[2]).toEqual(shape[0]);
    expect(shape[0].life).toBe(CODE_TTL_SECONDS);
  });

  it("only a real code is ever sent, and the member and pending mails carry none", async () => {
    const m = setup({ members: ["member@example.com"], codes: [5, 6] });
    await m.start("member@example.com", ipHeader("198.51.100.1"));
    await m.start("new@example.com", ipHeader("198.51.100.2"));
    expect(m.sent[0].vars).toEqual({});
    expect(m.sent[1].vars).toEqual({ code: "000006" });
  });

  it("verify cannot tell them apart: wrong codes are 400 for all three, and the 5th is 429 for all three", async () => {
    const m = setup({ members: ["member@example.com"] });
    openRequest(m, "pending@example.com", "pending");
    const seqs = [];
    for (const [i, email] of ["member@example.com", "pending@example.com", "new@example.com"].entries()) {
      await m.start(email, ipHeader(`198.51.100.${i + 1}`));
      const seq = [];
      for (let k = 0; k < MAX_CODE_ATTEMPTS; k += 1) seq.push((await m.verify(email, "999999")).statusCode);
      seqs.push(seq);
    }
    expect(seqs[0]).toEqual([400, 400, 400, 400, 429]);
    expect(seqs[1]).toEqual(seqs[0]);
    expect(seqs[2]).toEqual(seqs[0]);
  });

  it("verify cannot tell them apart in time either: all three expire to the same 400 as an address that never asked", async () => {
    const m = setup({ members: ["member@example.com"] });
    for (const [i, email] of ["member@example.com", "new@example.com"].entries()) await m.start(email, ipHeader(`198.51.100.${i + 1}`));
    m.clock.now += (CODE_TTL_SECONDS + 1) * 1000;
    const answers = [];
    for (const email of ["member@example.com", "new@example.com", "never@example.com"]) {
      const res = await m.verify(email, "123456");
      answers.push([res.statusCode, res.body]);
    }
    expect(answers).toEqual(Array(3).fill([400, '{"detail":"invalid_code"}'])); // an expired code, a member's decoy and an address that never asked
  });

  it("no code is ever accepted for a member or a pending request, even the new-address code", async () => {
    const m = setup({ members: ["member@example.com"], codes: [123456, 123456] });
    await m.start("member@example.com", ipHeader("198.51.100.1"));
    expect((await m.verify("member@example.com", "123456")).statusCode).toBe(400);
  });

  it("a declined, expired or TTL-expired request counts as new, and an active or awaiting one as open", async () => {
    const m = setup();
    openRequest(m, "d@example.com", "declined");
    openRequest(m, "e@example.com", "expired");
    openRequest(m, "t@example.com", "pending", { ttl: Math.floor(T0 / 1000) - 5 });
    openRequest(m, "a@example.com", "active");
    openRequest(m, "w@example.com", "awaiting_record");
    for (const [i, email] of ["d", "e", "t", "a", "w"].map((x) => `${x}@example.com`).entries()) await m.start(email, ipHeader(`198.51.100.${i + 1}`));
    expect(m.sent.map((s) => s.template)).toEqual(["code", "code", "code", "already_requested", "already_requested"]);
  });

  it("a mailer failure is 503 and leaves no code behind", async () => {
    const m = setup({ mailFails: true });
    const res = await m.start("a@example.com");
    expect([res.statusCode, bodyOf(res)]).toEqual([503, { detail: "unavailable" }]);
    expect(m.doc.rows.has(`ACCESSCODE#${hash("a@example.com")}|META`)).toBe(false);
  });

  it("a membership lookup failure is 503 and sends nothing", async () => {
    const m = setup();
    const ar = createAccessRequest({ flag: () => true, siteOrigin: SITE, siteHost: "harrisonfamily.us", ddb: m.doc, cmds, table: TABLE, limiter: memoryRateLimiter(), mailer: m.mailer,
      fetch: m.fetch, secrets: { turnstile: async () => "s", pepper: async () => PEPPER }, isMember: async () => { throw new Error("s3 down"); }, mailAlarm: { isFiring: async () => false } });
    const res = await ar.handle("/access-request/start", post("/access-request/start", { email: "a@example.com", turnstileToken: "t" }));
    expect(res.statusCode).toBe(503);
    expect(m.mailer.send).not.toHaveBeenCalled();
  });
});

describe("the code (15 minutes, 5 attempts, stored as a MAC) and the ticket (60 minutes, stored hashed)", () => {
  it("is 6 digits from the generator, padded", async () => {
    const m = setup({ codes: [7] });
    await m.start("a@example.com");
    expect(mailOf(m).vars.code).toBe("000007");
    expect(mailOf(m).vars.code).toMatch(/^\d{6}$/);
  });

  it("is stored as HMAC-SHA256(pepper, email:code), never in clear, with a 15 minute life", async () => {
    const m = setup({ codes: [135790] });
    await m.start("Ana@Example.com ");
    const item = m.doc.rows.get(`ACCESSCODE#${hash("ana@example.com")}|META`);
    expect(item.codeMac).toBe(createHmac("sha256", PEPPER).update("ana@example.com:135790").digest("base64url"));
    expect(JSON.stringify([...m.doc.rows.values()])).not.toMatch(/135790|ana@example/);
    expect(item).toMatchObject({ attempts: 0, expiresAt: Math.floor(T0 / 1000) + 900, ttl: Math.floor(T0 / 1000) + 900 });
  });

  it("the right code returns a ticket once; the ticket is stored hashed with a 60 minute life and the code is gone", async () => {
    const m = setup({ codes: [135790] });
    await m.start("ana@example.com");
    const res = await m.verify("ana@example.com", " 135790 ");
    expect(res.statusCode).toBe(200);
    const { ticket, expiresAt } = bodyOf(res);
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes, base64url
    expect(Date.parse(expiresAt)).toBe(T0 + TICKET_TTL_SECONDS * 1000);
    const stored = m.doc.rows.get(`${ticketKey(ticket).PK}|META`);
    expect(ticketKey(ticket).PK).toMatch(/^ACCESSTICKET#[0-9a-f]{64}$/);
    expect(stored).toMatchObject({ email: "ana@example.com", emailHash: hash("ana@example.com"), expiresAt: Math.floor(T0 / 1000) + 3600, ttl: Math.floor(T0 / 1000) + 3600 });
    expect(JSON.stringify([...m.doc.rows.entries()])).not.toContain(ticket); // the ticket itself is nowhere in the table
    expect(m.doc.rows.has(`ACCESSCODE#${hash("ana@example.com")}|META`)).toBe(false);
  });

  it("a code works once", async () => {
    const m = setup({ codes: [135790] });
    await m.start("ana@example.com");
    expect((await m.verify("ana@example.com", "135790")).statusCode).toBe(200);
    expect((await m.verify("ana@example.com", "135790")).statusCode).toBe(400);
  });

  it("each ticket is different", async () => {
    const m = setup({ codes: [111111, 222222] });
    await m.start("a@example.com", ipHeader("198.51.100.1"));
    await m.start("b@example.com", ipHeader("198.51.100.2"));
    const a = bodyOf(await m.verify("a@example.com", "111111")).ticket;
    const b = bodyOf(await m.verify("b@example.com", "222222")).ticket;
    expect(a).not.toBe(b);
    expect(ticketKey(a)).not.toEqual(ticketKey(b));
  });

  it("a code is bound to its email", async () => {
    const m = setup({ codes: [111111] });
    await m.start("a@example.com");
    expect((await m.verify("other@example.com", "111111")).statusCode).toBe(400);
  });

  it("is the same 400 invalid_code as a missing code after 15 minutes (no 410), and the item is removed", async () => {
    const m = setup({ codes: [111111] });
    await m.start("a@example.com");
    m.clock.now += (CODE_TTL_SECONDS - 1) * 1000;
    expect((await m.verify("a@example.com", "000000")).statusCode).toBe(400);
    m.clock.now += 2000;
    const res = await m.verify("a@example.com", "111111");
    expect([res.statusCode, bodyOf(res)]).toEqual([400, { detail: "invalid_code" }]);
    expect(m.doc.rows.has(`ACCESSCODE#${hash("a@example.com")}|META`)).toBe(false);
  });

  it("allows 5 attempts: 4 wrong are 400, the 5th wrong is 429 and locks the code, and the right code then fails", async () => {
    const m = setup({ codes: [111111] });
    await m.start("a@example.com");
    const seq = [];
    for (let i = 0; i < 5; i += 1) seq.push((await m.verify("a@example.com", "222222")).statusCode);
    expect(seq).toEqual([400, 400, 400, 400, 429]);
    expect(m.doc.rows.get(`ACCESSCODE#${hash("a@example.com")}|META`).attempts).toBe(5); // kept, spent: a resend cannot refill it
    expect((await m.verify("a@example.com", "111111")).statusCode).toBe(429);
  });

  it("the 5th attempt may still succeed", async () => {
    const m = setup({ codes: [111111] });
    await m.start("a@example.com");
    for (let i = 0; i < 4; i += 1) await m.verify("a@example.com", "222222");
    expect((await m.verify("a@example.com", "111111")).statusCode).toBe(200);
  });

  it("parallel guesses cannot beat the limit: the right code sent as the 7th parallel attempt is refused", async () => {
    const m = setup({ codes: [111111] });
    await m.start("a@example.com");
    const res = await Promise.all(Array.from({ length: 10 }, (_, i) => m.verify("a@example.com", i === 6 ? "111111" : "222222")));
    expect(res[6].statusCode).toBe(429);
    expect(res.filter((r) => r.statusCode === 200)).toHaveLength(0);
    expect(res.filter((r) => r.statusCode === 400)).toHaveLength(MAX_CODE_ATTEMPTS - 1);
  });

  it("two parallel right codes make one ticket", async () => {
    const m = setup({ codes: [111111] });
    await m.start("a@example.com");
    const res = await Promise.all([m.verify("a@example.com", "111111"), m.verify("a@example.com", "111111")]);
    expect(res.map((r) => r.statusCode).sort()).toEqual([200, 400]);
  });

  it("a resend replaces the code and the old one stops working", async () => {
    const m = setup({ codes: [111111, 222222] });
    await m.start("a@example.com");
    m.clock.now += 61_000;
    await m.start("a@example.com");
    expect((await m.verify("a@example.com", "111111")).statusCode).toBe(400);
    expect((await m.verify("a@example.com", "222222")).statusCode).toBe(200);
  });

  it("a resend does not refill the guess budget: attempts carry over to the new code", async () => {
    const m = setup({ codes: [111111, 222222] });
    await m.start("a@example.com");
    for (let i = 0; i < 3; i += 1) expect((await m.verify("a@example.com", "999999")).statusCode).toBe(400);
    m.clock.now += 61_000;
    await m.start("a@example.com");
    expect(m.doc.rows.get(`ACCESSCODE#${hash("a@example.com")}|META`).attempts).toBe(3);
    expect((await m.verify("a@example.com", "999999")).statusCode).toBe(400); // the 4th guess overall
    expect((await m.verify("a@example.com", "999999")).statusCode).toBe(429); // the 5th overall, not the 2nd of a fresh five
    expect((await m.verify("a@example.com", "222222")).statusCode).toBe(429);
  });

  it("a spent code stays locked through a resend, and the lock ends when the first code would have expired", async () => {
    const m = setup({ codes: [111111, 222222, 333333] });
    await m.start("a@example.com");
    const firstExpiry = m.doc.rows.get(`ACCESSCODE#${hash("a@example.com")}|META`).expiresAt;
    for (let i = 0; i < 5; i += 1) await m.verify("a@example.com", "999999");
    m.clock.now += 61_000;
    await m.start("a@example.com");
    expect(m.doc.rows.get(`ACCESSCODE#${hash("a@example.com")}|META`)).toMatchObject({ attempts: 5, expiresAt: firstExpiry, ttl: firstExpiry });
    expect((await m.verify("a@example.com", "222222")).statusCode).toBe(429);
    m.clock.now = (firstExpiry + 1) * 1000;
    await m.start("a@example.com");
    expect((await m.verify("a@example.com", "333333")).statusCode).toBe(200); // a fresh budget once the lock has run out
  });

  it("an expired code's attempts do not carry over", async () => {
    const m = setup({ codes: [111111, 222222] });
    await m.start("a@example.com");
    for (let i = 0; i < 4; i += 1) await m.verify("a@example.com", "999999");
    m.clock.now += (CODE_TTL_SECONDS + 1) * 1000;
    await m.start("a@example.com");
    expect(m.doc.rows.get(`ACCESSCODE#${hash("a@example.com")}|META`).attempts).toBe(0);
  });

  it("a failed resend puts the still-valid previous code back instead of deleting it", async () => {
    const m = setup({ codes: [111111, 222222] });
    await m.start("a@example.com");
    m.mailer.send.mockImplementationOnce(async () => { throw Object.assign(new Error("x"), { name: "Throttling" }); });
    m.clock.now += 61_000;
    expect((await m.start("a@example.com")).statusCode).toBe(503);
    expect((await m.verify("a@example.com", "111111")).statusCode).toBe(200);
  });

  it("malformed verify bodies are 400 invalid_code without touching the table", async () => {
    const m = setup();
    for (const body of [{}, { email: "a@example.com" }, { email: "a@example.com", code: "12345" }, { email: "a@example.com", code: "1234567" }, { email: "a@example.com", code: "12a456" }, { email: "a@example.com", code: 123456 }, { email: "bad", code: "123456" }]) {
      const res = await m.call("/access-request/verify", body);
      expect([res.statusCode, bodyOf(res)], JSON.stringify(body)).toEqual([400, { detail: "invalid_code" }]);
    }
    expect(m.doc.calls).toEqual([]);
  });

  it("a missing pepper fails closed (503)", async () => {
    const m = setup({ pepper: async () => { throw new Error("AccessDenied"); } });
    expect((await m.start("a@example.com")).statusCode).toBe(503);
    expect((await m.verify("a@example.com", "123456")).statusCode).toBe(503);
  });

  it("a table failure on verify is 503", async () => {
    const m = setup({ doc: fakeDoc({ failOn: ["GetCommand"] }) });
    expect((await m.verify("a@example.com", "123456")).statusCode).toBe(503);
  });
});

describe("no client address", () => {
  const noAddress = (rel, body) => post(rel, body, { headers: { "cloudfront-viewer-address": undefined } });

  it("start, verify and submit admission fail closed with 503 (not one shared ip bucket), log a distinct label, and spend nothing", async () => {
    const m = setup();
    const s = await m.ar.handle("/access-request/start", noAddress("/access-request/start", { email: "a@example.com", turnstileToken: "t" }));
    const v = await m.ar.handle("/access-request/verify", noAddress("/access-request/verify", { email: "a@example.com", code: "123456" }));
    const a = await m.ar.submitAdmission(noAddress("/access-request", {}));
    expect([s.statusCode, v.statusCode, a.statusCode]).toEqual([503, 503, 503]);
    expect(m.logs.map((l) => JSON.parse(l).step)).toEqual(["no-client-ip", "no-client-ip", "no-client-ip"]);
    expect(m.hits).toEqual([]);
    expect(m.fetch).not.toHaveBeenCalled();
    expect(m.sent).toEqual([]);
  });

  it("a request that has an address is unaffected by the earlier ones", async () => {
    const m = setup();
    await m.ar.handle("/access-request/start", noAddress("/access-request/start", { email: "a@example.com", turnstileToken: "t" }));
    expect((await m.start("a@example.com")).statusCode).toBe(202);
  });
});

describe("join mail not configured (fails closed)", () => {
  it("start answers 503 unavailable before Turnstile, the limiters, the table and the mailer", async () => {
    const m = setup({ mailConfigured: () => false });
    const res = await m.start("a@example.com");
    expect([res.statusCode, bodyOf(res)]).toEqual([503, { detail: "unavailable" }]);
    expect(m.logs.map((l) => JSON.parse(l).step)).toEqual(["mail-config"]);
    expect(m.fetch).not.toHaveBeenCalled();
    expect(m.hits).toEqual([]);
    expect(m.doc.calls).toEqual([]);
    expect(m.sent).toEqual([]);
  });
});

describe("the bounce and complaint alarm (PS-25)", () => {
  it("start answers 503 unavailable while an alarm is in ALARM: no Turnstile credit spent on the limiters, no code, no mail", async () => {
    const m = setup({ alarm: "ALARM", members: ["member@example.com"] });
    for (const email of ["new@example.com", "member@example.com"]) {
      const res = await m.start(email);
      expect([res.statusCode, bodyOf(res)], email).toEqual([503, { detail: "unavailable" }]);
    }
    expect(m.mailer.send).not.toHaveBeenCalled();
    expect(m.hits).toEqual([]);
    expect([...m.doc.rows.keys()]).toEqual([]);
  });

  it("goes back to 202 when the alarm clears", async () => {
    const m = setup({ alarm: "ALARM" });
    expect((await m.start("a@example.com")).statusCode).toBe(503);
    m.state.alarm = "OK";
    expect((await m.start("a@example.com")).statusCode).toBe(202);
  });

  it("fails closed when the alarm state cannot be read", async () => {
    const m = setup({ alarm: "THROW" });
    expect((await m.start("a@example.com")).statusCode).toBe(503);
    expect(m.mailer.send).not.toHaveBeenCalled();
  });

  describe("createMailAlarmGate (stubbed CloudWatch)", () => {
    const states = (o) => vi.fn(async (names) => names.filter((n) => n in o).map((n) => ({ AlarmName: n, StateValue: o[n] })));
    const NAMES = ["hfy-access-request-bounce", "hfy-access-request-complaint"];

    it("is firing when either alarm is in ALARM, and not for OK or INSUFFICIENT_DATA", async () => {
      expect(await createMailAlarmGate({ names: NAMES, describeAlarms: states({ [NAMES[0]]: "OK", [NAMES[1]]: "OK" }) }).isFiring()).toBe(false);
      expect(await createMailAlarmGate({ names: NAMES, describeAlarms: states({ [NAMES[0]]: "INSUFFICIENT_DATA", [NAMES[1]]: "OK" }) }).isFiring()).toBe(false);
      expect(await createMailAlarmGate({ names: NAMES, describeAlarms: states({ [NAMES[0]]: "ALARM", [NAMES[1]]: "OK" }) }).isFiring()).toBe(true);
      expect(await createMailAlarmGate({ names: NAMES, describeAlarms: states({ [NAMES[0]]: "OK", [NAMES[1]]: "ALARM" }) }).isFiring()).toBe(true);
    });

    it("rejects (so the route fails closed) with no alarm configured, a missing alarm or a CloudWatch error", async () => {
      await expect(createMailAlarmGate({ names: [], describeAlarms: states({}) }).isFiring()).rejects.toThrow();
      await expect(createMailAlarmGate({ names: NAMES, describeAlarms: states({ [NAMES[0]]: "OK" }) }).isFiring()).rejects.toThrow(/does not exist/);
      await expect(createMailAlarmGate({ names: NAMES, describeAlarms: vi.fn(async () => { throw new Error("denied"); }) }).isFiring()).rejects.toThrow();
    });

    it("caches an answer for the ttl and never caches a failure", async () => {
      let t = 0;
      const o = { [NAMES[0]]: "OK", [NAMES[1]]: "OK" };
      const describe = states(o);
      const gate = createMailAlarmGate({ names: NAMES, describeAlarms: describe, ttlMs: 30_000, now: () => t });
      expect(await gate.isFiring()).toBe(false);
      o[NAMES[0]] = "ALARM";
      t = 29_000;
      expect(await gate.isFiring()).toBe(false);
      expect(describe).toHaveBeenCalledTimes(1);
      t = 30_001;
      expect(await gate.isFiring()).toBe(true);
      let fail = true;
      const flaky = createMailAlarmGate({ names: NAMES, describeAlarms: async () => { if (fail) throw new Error("x"); return [{ AlarmName: NAMES[0], StateValue: "OK" }, { AlarmName: NAMES[1], StateValue: "OK" }]; } });
      await expect(flaky.isFiring()).rejects.toThrow();
      fail = false;
      expect(await flaky.isFiring()).toBe(false);
    });
  });
});

describe("nothing private is logged", () => {
  const EMAIL = "private.person.synthetic@example.com";
  let spies;
  const console_ = [];
  beforeEach(() => {
    console_.length = 0;
    spies = ["log", "info", "warn", "error", "debug"].map((k) => vi.spyOn(console, k).mockImplementation((...a) => console_.push(a.map(String).join(" "))));
  });
  afterEach(() => spies.forEach((s) => s.mockRestore()));

  it("no address, code, ticket or hash reaches a log across success and every failure path", async () => {
    const secrets = new Set();
    const lines = [];
    const run = async (m, extra = []) => {
      lines.push(m.logs); // the array is live, so lines logged later are seen too
      const email = EMAIL;
      secrets.add(email); secrets.add("private.person.synthetic"); secrets.add(hash(email));
      const r1 = await m.start(email);
      const code = mailOf(m)?.vars?.code;
      if (code) secrets.add(code);
      m.clock.now += 61_000;
      await m.start(email, { headers: { "x-requested-with": "x" } });
      await m.verify(email, "000000");
      const ok = code ? await m.verify(email, code) : r1;
      if (ok.statusCode === 200 && bodyOf(ok).ticket) secrets.add(bodyOf(ok).ticket);
      for (const f of extra) await f(m);
    };
    await run(setup({ codes: [654321] }));
    await run(setup({ mailFails: true }));
    await run(setup({ doc: fakeDoc({ failOn: ["PutCommand"] }) }));
    await run(setup({ doc: fakeDoc({ failOn: ["GetCommand"] }) }));
    await run(setup({ alarm: "THROW" }));
    await run(setup({ fetch: vi.fn(async () => { throw new Error(`socket hang up for ${EMAIL}`); }) }));
    await run(setup({ limiter: { hit: async () => { throw new Error(`limiter failed for ${EMAIL}`); } } }));
    await run(setup({ turnstileSecret: async () => { throw new Error(`no secret for ${EMAIL}`); } }));
    const m = setup({ codes: [654321] });
    await run(m, [(x) => x.ar.submitAdmission(post("/access-request", { email: EMAIL }))]);
    const all = [...lines.flat(), ...console_].join("\n");
    expect(lines.flat().length).toBeGreaterThan(5); // the failure paths did log something, so the check below has teeth
    for (const s of secrets) expect(all, `a log line contains a private value of length ${s.length}`).not.toContain(s);
    expect(all).not.toMatch(/example\.com|@/);
  });

  it("failure lines carry a fixed label and an error name, which is all they are meant to say", async () => {
    const m = setup({ mailFails: true });
    await m.start(EMAIL);
    expect(m.logs).toEqual([JSON.stringify({ msg: "access-request unavailable", step: "send", error: "MessageRejected" })]);
  });
});

describe("the mailer (own SES identity, configuration set and templates)", () => {
  it("builds a plain-text SESv2 input from the join identity and its configuration set", () => {
    const input = sendEmailInput({ from: "no-reply@join.example.test", configurationSet: "hfy-access-request", template: "code", to: "a@example.com", vars: { code: "123456" } });
    expect(input).toMatchObject({ FromEmailAddress: "no-reply@join.example.test", Destination: { ToAddresses: ["a@example.com"] }, ConfigurationSetName: "hfy-access-request" });
    expect(input.Content.Simple.Subject.Data).toBe("your Harrison Family code");
    expect(input.Content.Simple.Body.Text.Data).toContain("your code is 123456. it works for 15 minutes.");
    expect(Object.keys(input.Content.Simple.Body)).toEqual(["Text"]); // no HTML part, so nothing to track
  });

  it("never builds mail without the configuration set (no set means no bounce or complaint feedback)", () => {
    expect(() => sendEmailInput({ from: "x@y.test", template: "already_member", to: "a@example.com" })).toThrow(/configuration set/);
    expect(() => sendEmailInput({ from: "x@y.test", configurationSet: "", template: "already_member", to: "a@example.com" })).toThrow(/configuration set/);
  });

  it("a send failure carries the SES error name and never its message (which can quote the address)", async () => {
    const mailer = createSesMailer({ from: "x@y.test", configurationSet: "hfy-access-request", send: async () => { throw Object.assign(new Error("Email address is not verified: a@example.com"), { name: "MessageRejected" }); } });
    const e = await mailer.send({ template: "code", to: "a@example.com", vars: { code: "1" } }).catch((x) => x);
    expect([e.name, e.message]).toEqual(["MessageRejected", "mail not sent"]);
  });

  it("refuses to start without a From address", () => {
    expect(() => createSesMailer({ configurationSet: "cs", send: async () => {} })).toThrow(/From address/);
  });

  it("refuses to start without a configuration set", () => {
    expect(() => createSesMailer({ from: "x@y.test", send: async () => {} })).toThrow(/configuration set/);
    expect(() => createSesMailer({ from: "x@y.test", configurationSet: "", send: async () => {} })).toThrow(/configuration set/);
  });
});

describe("wired like the Lambda: createAccessRequestRoutes", () => {
  const manifest = { site: "harrisonfamily.us", authOrigin: SITE };
  function wired(env) {
    const sesCalls = [];
    const cwCalls = [];
    const secretCalls = [];
    class SecretsManagerClient { async send(c) { secretCalls.push(c.input.SecretId); return { SecretString: c.input.SecretId.includes("turnstile") ? JSON.stringify({ secret: TURNSTILE_SECRET }) : PEPPER }; } }
    class GetSecretValueCommand { constructor(input) { this.input = input; } }
    class SESv2Client { async send(c) { sesCalls.push(c.input); return {}; } }
    class SendEmailCommand { constructor(input) { this.input = input; } }
    class CloudWatchClient { async send(c) { cwCalls.push(c.input); return { MetricAlarms: c.input.AlarmNames.map((n) => ({ AlarmName: n, StateValue: "OK" })) }; } }
    class DescribeAlarmsCommand { constructor(input) { this.input = input; } }
    const mods = { "@aws-sdk/client-sesv2": { SESv2Client, SendEmailCommand }, "@aws-sdk/client-cloudwatch": { CloudWatchClient, DescribeAlarmsCommand } };
    const doc = fakeDoc();
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ success: true, hostname: "harrisonfamily.us", action: "join" }) }));
    vi.stubGlobal("fetch", fetch);
    const ar = createAccessRequestRoutes({
      m: manifest, doc, cmds, tableName: TABLE, limiter: memoryRateLimiter(), sm: { SecretsManagerClient, GetSecretValueCommand },
      resolver: async (email) => (email === "member@example.com" ? { sub: "I1" } : null), env, sdkImport: async (n) => mods[n],
    });
    return { ar, sesCalls, cwCalls, secretCalls, doc };
  }
  const ENV = {
    ACCESS_REQUESTS: "on", TURNSTILE_SITE_KEY: "1x-site", TURNSTILE_SECRET_NAME: "harrisonfamily/auth-edge/turnstile", ACCESS_REQUEST_PEPPER_SECRET: "harrisonfamily/access-request/pepper",
    JOIN_FROM_ADDRESS: "no-reply@join.example.test", JOIN_SES_CONFIGURATION_SET: "hfy-access-request", JOIN_MAIL_ALARMS: "hfy-access-request-bounce, hfy-access-request-complaint",
    SES_FROM_ADDRESS: "no-reply@cognito-and-api.example.test", SES_CONFIGURATION_SET: "cognito-and-api",
  };
  afterEach(() => vi.unstubAllGlobals());

  it("sends a join code from the JOIN identity and configuration set (not the Cognito and API ones) after reading both alarms", async () => {
    const w = wired(ENV);
    const res = await w.ar.handle("/access-request/start", post("/access-request/start", { email: "new@example.com", turnstileToken: "t" }));
    expect(res.statusCode).toBe(202);
    expect(w.sesCalls).toHaveLength(1);
    expect(w.sesCalls[0]).toMatchObject({ FromEmailAddress: "no-reply@join.example.test", ConfigurationSetName: "hfy-access-request", Destination: { ToAddresses: ["new@example.com"] } });
    expect(JSON.stringify(w.sesCalls[0])).not.toMatch(/cognito-and-api/);
    expect(w.cwCalls[0].AlarmNames).toEqual(["hfy-access-request-bounce", "hfy-access-request-complaint"]);
    expect(w.secretCalls.sort()).toEqual(["harrisonfamily/access-request/pepper", "harrisonfamily/auth-edge/turnstile"]);
  });

  it("the membership lookup goes through the composite resolver", async () => {
    const w = wired(ENV);
    await w.ar.handle("/access-request/start", post("/access-request/start", { email: "member@example.com", turnstileToken: "t" }));
    expect(w.sesCalls[0].Content.Simple.Subject.Data).toBe("you're already on the list");
  });

  it("answers 503 closed unless ACCESS_REQUESTS is on, and 503 unavailable without a mail alarm", async () => {
    const off = wired({ ...ENV, ACCESS_REQUESTS: "off" });
    expect(bodyOf(await off.ar.handle("/access-request/start", post("/access-request/start", {})))).toEqual({ detail: "closed" });
    const unset = wired({});
    expect((await unset.ar.handle("/access-request/config", getConfig())).statusCode).toBe(503);
    // isOpen() is what the edge's denied page reads for its "ask to join" link (HFY-TSK-140): exactly the flag the routes read
    expect([wired(ENV).ar.isOpen(), off.ar.isOpen(), unset.ar.isOpen()]).toEqual([true, false, false]);
    const noAlarm = wired({ ...ENV, JOIN_MAIL_ALARMS: "" });
    expect((await noAlarm.ar.handle("/access-request/start", post("/access-request/start", { email: "new@example.com", turnstileToken: "t" }))).statusCode).toBe(503);
    expect(noAlarm.sesCalls).toEqual([]);
  });

  it("answers 503 unavailable, with no SES call and no Turnstile call, while JOIN_SES_CONFIGURATION_SET is empty or unset", async () => {
    for (const set of ["", undefined]) {
      const w = wired({ ...ENV, JOIN_SES_CONFIGURATION_SET: set });
      const res = await w.ar.handle("/access-request/start", post("/access-request/start", { email: "new@example.com", turnstileToken: "t" }));
      expect([res.statusCode, bodyOf(res)]).toEqual([503, { detail: "unavailable" }]);
      expect(w.sesCalls).toEqual([]);
      expect(w.cwCalls).toEqual([]);
      expect(w.doc.rows.size).toBe(0);
    }
    const noFrom = wired({ ...ENV, JOIN_FROM_ADDRESS: "" });
    expect((await noFrom.ar.handle("/access-request/start", post("/access-request/start", { email: "new@example.com", turnstileToken: "t" }))).statusCode).toBe(503);
  });

  it("serves the public config", async () => {
    const w = wired(ENV);
    expect(bodyOf(await w.ar.handle("/access-request/config", getConfig()))).toEqual({ open: true, turnstileSiteKey: "1x-site" });
  });
});

describe("mounted on the auth edge", () => {
  const raw = JSON.parse(readFileSync(new URL("../edge.manifest.json", import.meta.url), "utf8"));
  const ENV = { COGNITO_USER_POOL_ID: "us-west-2_TEST", COGNITO_CLIENT_ID: "client123", GOOGLE_CLIENT_ID: "gis-client.apps.googleusercontent.com" };
  async function edgeWith(accessRequests) {
    const manifest = loadManifest(raw, ENV);
    const s = await generateKeyPair("RS256", { extractable: true });
    const pub = { ...(await exportJWK(s.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
    const identity = createIdentityService({
      resolver: buildResolver(manifest.resolver, { readObject: async () => "{}" }), links: memoryLinkStore(),
      sessions: { issuer: manifest.session.issuer, audience: manifest.session.audience, kid: "k1", privateKey: s.privateKey, store: memoryRefreshStore(), defaultProfile: "installed" },
    });
    return createAuthEdge({ manifest, identity, publicJwk: pub, verify: { issuers: [manifest.session.issuer], audiences: [manifest.session.audience], jwks: createLocalJWKSet({ keys: [pub] }) }, nonce: () => "n", ...(accessRequests ? { accessRequests } : {}) });
  }

  it("routes /auth/access-request/* to the handler before the kit, and keeps the kit's 404 when none is wired", async () => {
    const m = setup({ codes: [123123] });
    const edge = await edgeWith(m.ar);
    const res = await edge(post("/access-request/start", { email: "a@example.com", turnstileToken: "t" }));
    expect([res.statusCode, bodyOf(res)]).toEqual([202, { ok: true }]);
    expect(m.sent).toHaveLength(1);
    expect((await edge({ ...post("/access-request/start", {}), headers: {} })).statusCode).toBe(403);
    m.state.on = false;
    expect(bodyOf(await edge(post("/access-request/verify", {})))).toEqual({ detail: "closed" });
    expect((await edge(post("/access-request/start/", {}))).statusCode).toBe(503); // a trailing slash is the same route
    const bare = await edgeWith(undefined);
    expect((await bare(post("/access-request/start", {}))).statusCode).toBe(404);
  });
});
