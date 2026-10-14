// The anonymous access-request routes of the auth edge (HFY-PLN-002 surfaces.md 7.2 and 7.5; task surf-access-request-edge):
//   GET  /auth/access-request/config   -> { open, turnstileSiteKey }
//   POST /auth/access-request/start    -> 202 { ok:true } always: emails ONE of a code, "already on the list" or "we have your request"
//   POST /auth/access-request/verify   -> 200 { ticket, expiresAt } once the mailbox is proven
// The submit route (POST /auth/access-request) belongs to surf-access-submit; it plugs into the same gate(), botCheck() and
// submitAdmission() exported on the object createAccessRequest returns, so it inherits the kill switch, the CSRF checks, Turnstile, the
// submit limits and the 100-pending queue cap.
//
// Privacy (R-18, R-19; surfaces.md 7.9): the email, the code and the ticket are never logged. Every log line is a fixed label plus an
// error NAME (an SES or DynamoDB message can quote the address). Rate-limit keys are hashed (ratelimit.js). Codes and tickets are stored
// as a MAC and a hash; a code or ticket in a response is returned once and never persisted in clear.
//
// Enumeration parity (7.1): a member, an open request and a new email all take the same path: one membership lookup, one request lookup,
// one ACCESSCODE# write, ONE mailer call, and the same 202. For the first two the ACCESSCODE# item is a decoy whose MAC can never match,
// so the verify route cannot tell them apart from a new email either (a wrong code is 400, five wrong codes are 429, and the item
// expires like a real one). Global states (the queue cap, the mail alarm, a limit) are answered before the lookup, to everyone alike.
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { clientIp, rateKey } from "./ratelimit.js";
import { normalizeAllowEmail } from "./shared/allowlist-store.mjs";
import { isHoneypotTripped } from "./shared/legacy-form.mjs";

export const ROUTE_PREFIX = "/access-request";
export const CODE_TTL_SECONDS = 15 * 60;
export const TICKET_TTL_SECONDS = 60 * 60;
export const MAX_CODE_ATTEMPTS = 5;
export const QUEUE_CAP = 100;
export const TURNSTILE_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const TURNSTILE_ACTION = "join";
export const TURNSTILE_TIMEOUT_MS = 3000;
export const MAX_BODY_BYTES = 16 * 1024;

/**
 * Surfaces.md 7.5, in the order they are applied. They run one after the other and stop at the first denial, so a request that a narrow
 * limit already refused never spends the global budget (one client hammering one address cannot exhaust the 50 a day for everyone).
 * The 60 second resend gap is `joincode` per email, 1 per minute.
 */
export const START_LIMITS = Object.freeze([
  Object.freeze({ name: "joincode", scope: "email", limit: 1, windowSeconds: 60 }),
  Object.freeze({ name: "joincode", scope: "email+ip", limit: 3, windowSeconds: 3600 }),
  Object.freeze({ name: "joincode", scope: "email", limit: 5, windowSeconds: 86400 }),
  Object.freeze({ name: "joincode", scope: "ip", limit: 10, windowSeconds: 86400 }),
  Object.freeze({ name: "joincode", scope: "global", limit: 50, windowSeconds: 86400 }),
]);
// Per IP first (30 an hour), so one client cannot spend an address's 10 an hour and lock its owner out of verifying; then per email.
export const VERIFY_LIMITS = Object.freeze([
  Object.freeze({ name: "joinverify", scope: "ip", limit: 30, windowSeconds: 3600 }),
  Object.freeze({ name: "joinverify", scope: "email", limit: 10, windowSeconds: 3600 }),
]);
export const SUBMIT_LIMITS = Object.freeze([
  Object.freeze({ name: "joinsubmit", scope: "ip", limit: 5, windowSeconds: 86400 }),
  Object.freeze({ name: "joinsubmit", scope: "global", limit: 20, windowSeconds: 86400 }),
]);

const json = (statusCode, body, extra = {}) => ({
  statusCode,
  headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
  body: JSON.stringify(body),
});
const headersOf = (event) => {
  const h = {};
  for (const [k, v] of Object.entries(event?.headers ?? {})) if (v !== undefined) h[k.toLowerCase()] = String(v);
  return h;
};
const methodOf = (event) => (event.requestContext?.http?.method ?? event.httpMethod ?? "GET").toUpperCase();

/** The JSON object in the request body, or {} for anything else (not JSON, not an object, over 16 KiB). */
function bodyOf(event) {
  try {
    const raw = event.isBase64Encoded && event.body ? Buffer.from(event.body, "base64").toString("utf8") : (event.body ?? "{}");
    if (raw.length > MAX_BODY_BYTES) return {};
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** RFC-lite: one @, a dot in the domain, no whitespace or brackets, at most 254 characters (64 before the @). Returns the normalized address or "". */
export function normalizeJoinEmail(value) {
  if (typeof value !== "string") return "";
  const email = normalizeAllowEmail(value);
  if (!email || email.length > 254) return "";
  const m = /^([^\s@<>()[\]\\,;:"]+)@([^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,})$/.exec(email);
  if (!m || m[1].length > 64 || /\.\./.test(email) || m[1].startsWith(".") || m[1].endsWith(".") || m[2].startsWith(".") || m[2].startsWith("-")) return "";
  return email;
}

export const hmac = (pepper, text) => createHmac("sha256", pepper).update(text).digest("base64url");
/** HMAC-SHA256(pepper, email), the id of every per-email item (surfaces.md 7.9). */
export const emailHash = (pepper, email) => hmac(pepper, email);
/** HMAC-SHA256(pepper, email ":" code): all that is stored of a code. */
export const codeMac = (pepper, email, code) => hmac(pepper, `${email}:${code}`);
/** The ticket's table key: ACCESSTICKET#<sha256(ticket)> (the ticket itself is never stored). */
export const ticketKey = (ticket) => ({ PK: `ACCESSTICKET#${createHash("sha256").update(String(ticket)).digest("hex")}`, SK: "META" });
export const codeKey = (hash) => ({ PK: `ACCESSCODE#${hash}`, SK: "META" });
export const requestEmailKey = (hash) => ({ PK: `ACCESSREQEMAIL#${hash}`, SK: "META" });

const sameMac = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Turnstile siteverify: "ok" only for success:true with the site's hostname and action "join"; "failed" for a token Cloudflare refuses
 * (the visitor can retry); "unavailable" for a timeout, a network or HTTP error, a malformed answer or a server-side misconfiguration
 * (fails closed, nothing is sent). The 3 s timeout covers the whole exchange.
 */
export async function verifyTurnstile({ token, ip, secret, hostname, fetch: fetchImpl = globalThis.fetch, timeoutMs = TURNSTILE_TIMEOUT_MS }) {
  if (typeof token !== "string" || !token || token.length > 2048) return "failed";
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(TURNSTILE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret, response: token, ...(ip && ip !== "unknown" ? { remoteip: ip } : {}) }),
      signal: ctl.signal,
    });
    if (!res || !res.ok) return "unavailable";
    const out = await res.json();
    if (!out || typeof out !== "object") return "unavailable";
    const codes = Array.isArray(out["error-codes"]) ? out["error-codes"] : [];
    if (codes.some((c) => c === "internal-error" || c === "missing-input-secret" || c === "invalid-input-secret" || c === "bad-request")) return "unavailable";
    return out.success === true && out.hostname === hostname && out.action === TURNSTILE_ACTION ? "ok" : "failed";
  } catch {
    return "unavailable";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The bounce and complaint alarm gate (review PS-25). `describeAlarms(names)` returns [{ AlarmName, StateValue }] (CloudWatch
 * DescribeAlarms). isFiring() is true while any named alarm is in ALARM. It rejects, and the route fails closed, when no alarm is
 * configured, when CloudWatch fails, or when a named alarm does not exist (the alarms are created by the SES operations gate; without them
 * nothing watches the sender reputation). OK and INSUFFICIENT_DATA both let mail go (SES rate metrics sit in INSUFFICIENT_DATA at low volume).
 * A successful answer is cached for `ttlMs`; a failure is never cached.
 */
export function createMailAlarmGate({ describeAlarms, names, ttlMs = 30_000, now = () => Date.now() }) {
  let cached = { at: -Infinity, firing: false };
  return {
    async isFiring() {
      if (now() - cached.at < ttlMs) return cached.firing;
      const wanted = (names ?? []).filter(Boolean);
      if (!wanted.length) throw new Error("no mail alarm is configured");
      const found = await describeAlarms(wanted);
      const byName = new Map((found ?? []).map((a) => [a.AlarmName, a.StateValue]));
      if (!wanted.every((n) => byName.has(n))) throw new Error("a mail alarm does not exist");
      cached = { at: now(), firing: wanted.some((n) => byName.get(n) === "ALARM") };
      return cached.firing;
    },
  };
}

/**
 * - `flag()` is true while ACCESS_REQUESTS is "on" (read per request, so a stack flip needs no restart).
 * - `siteOrigin` / `siteHost` are the site (https://harrisonfamily.us, harrisonfamily.us): the required Origin and the Turnstile hostname.
 * - `ddb` and `cmds` are the lib-dynamodb DocumentClient and command classes; `table` the app table.
 * - `limiter` is {hit(key, {limit, windowSeconds})} (ratelimit.js). `secrets.turnstile()` and `secrets.pepper()` return the secret strings.
 * - `mailer.send({ template, to, vars })` (mailer.js). `isMember(email)` is the composite allowlist resolver, true for a granted email.
 * - `mailAlarm.isFiring()` (createMailAlarmGate). `fetch` is for Turnstile. `random()` returns a code in [0, 1e6).
 * - `mailConfigured()` is false while the join From address or its SES configuration set is unset: the code route then answers 503
 *   unavailable before it spends anything (mail without the configuration set would send no bounce or complaint feedback, so the alarm
 *   gate would watch nothing; it fails closed).
 *
 * Budget note (fails closed, by design): the start limiters run before the mail is sent, so a transient SES or DynamoDB failure (503)
 * still spends the per-email, per-IP and global counters and the 60 s resend gap. A burst of 503s can briefly lock a visitor out of retrying.
 *
 * The client address is required: with none derivable (clientIp answers "unknown") the start, verify and submit-admission checks answer
 * 503 unavailable and log the label "no-client-ip", instead of putting every such caller into one shared ip bucket.
 */
export function createAccessRequest({
  flag, siteOrigin, siteHost, turnstileSiteKey = "", ddb, cmds, table, limiter, secrets, mailer, isMember, mailAlarm, mailConfigured = () => true,
  fetch: fetchImpl, random = () => randomInt(0, 1_000_000), now = () => Date.now(), log = console,
}) {
  const origin = String(siteOrigin).replace(/\/+$/, "");
  const nowSec = () => Math.floor(now() / 1000);
  const unavailable = (step, e) => {
    log.error?.(JSON.stringify({ msg: "access-request unavailable", step, error: e instanceof Error && e.name ? e.name : "error" }));
    return json(503, { detail: "unavailable" });
  };

  /**
   * The checks every route shares, in this order: ACCESS_REQUESTS=on (else 503 closed, whatever the method), then POST, a JSON content
   * type, `x-requested-with: io-kit` and an Origin equal to the site (403 otherwise; the same CSRF posture as forgot-password). The config
   * route is a GET, which needs the header but takes an Origin only when the browser sent one (it sends none on a same-origin GET).
   */
  function gate(event, { method = "POST" } = {}) {
    if (!flag()) return json(503, { detail: "closed" });
    const h = headersOf(event);
    const forbidden = json(403, { detail: "forbidden" });
    if (methodOf(event) !== method) return forbidden;
    if (h["x-requested-with"] !== "io-kit") return forbidden;
    const o = h.origin?.replace(/\/+$/, "");
    if (method === "POST") {
      if (!/^application\/json(\s*;|$)/i.test(h["content-type"] ?? "")) return forbidden;
      if (o !== origin) return forbidden;
    } else if (o !== undefined && o !== origin) return forbidden;
    return undefined;
  }

  /** Runs `limits` in order and stops at the first denial: undefined when all allow, else the 429. Rejects when the limiter does. */
  async function limited(limits, who) {
    for (const r of limits) {
      const res = await limiter.hit(rateKey(r.name, r.scope, who), r);
      if (!res.allowed) return { retryAfter: res.retryAfter };
    }
    return undefined;
  }
  const tooMany = (denied, detail = "rate_limited") => json(429, { detail }, { "retry-after": String(denied.retryAfter) });

  /** "ok" | "failed" | "unavailable" for the Turnstile token of a request. */
  async function botCheck(token, ip) {
    let secret;
    try {
      secret = await secrets.turnstile();
    } catch (e) {
      unavailable("turnstile-secret", e);
      return "unavailable";
    }
    return verifyTurnstile({ token, ip, secret, hostname: siteHost, fetch: fetchImpl });
  }

  /** True when the pending queue has no room: at most QUEUE_CAP pending requests (GSI1PK ACCESSREQS#pending). */
  async function queueFull() {
    const r = await ddb.send(new cmds.QueryCommand({
      TableName: table, IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :pk", ExpressionAttributeValues: { ":pk": "ACCESSREQS#pending" },
      Select: "COUNT", Limit: QUEUE_CAP,
    }));
    return Number(r?.Count ?? 0) >= QUEUE_CAP;
  }

  /**
   * The submit route's admission checks after the shared gate and Turnstile: the queue cap (503 queue_full), then the joinsubmit
   * limits per IP and global (429). undefined admits. Limiter or table failures answer 503 unavailable.
   */
  async function submitAdmission(event) {
    if (clientIp(event) === "unknown") return unavailable("no-client-ip", new Error("no client address"));
    try {
      if (await queueFull()) return json(503, { detail: "queue_full" });
    } catch (e) {
      return unavailable("queue", e);
    }
    try {
      const denied = await limited(SUBMIT_LIMITS, { ip: clientIp(event) });
      if (denied) return tooMany(denied);
    } catch (e) {
      return unavailable("limiter", e);
    }
    return undefined;
  }

  /** True when the email has a request that is not declined or expired (the submit route's ACCESSREQEMAIL# condition, mirrored). */
  async function hasOpenRequest(hash) {
    const r = await ddb.send(new cmds.GetCommand({ TableName: table, Key: requestEmailKey(hash), ConsistentRead: true }));
    const it = r?.Item;
    if (!it) return false;
    if (Number.isFinite(it.ttl) && it.ttl <= nowSec()) return false;
    return it.state !== "declined" && it.state !== "expired";
  }

  async function start(event) {
    const denied = gate(event);
    if (denied) return denied;
    const b = bodyOf(event);
    if (isHoneypotTripped(b)) return json(202, { ok: true }); // a bot filled the trap: success, and nothing done
    const email = normalizeJoinEmail(b.email);
    if (!email) return json(400, { detail: "invalid_email" });
    const ip = clientIp(event);
    if (ip === "unknown") return unavailable("no-client-ip", new Error("no client address"));
    if (!mailConfigured()) return unavailable("mail-config", new Error("join mail is not configured"));

    const bot = await botCheck(b.turnstileToken, ip);
    if (bot === "unavailable") return json(503, { detail: "unavailable" });
    if (bot === "failed") return json(403, { detail: "bot_check_failed" });

    try {
      if (await mailAlarm.isFiring()) return json(503, { detail: "unavailable" });
    } catch (e) {
      return unavailable("mail-alarm", e);
    }
    try {
      if (await queueFull()) return json(503, { detail: "queue_full" }); // everyone alike, so it says nothing about this address
    } catch (e) {
      return unavailable("queue", e);
    }
    try {
      const over = await limited(START_LIMITS, { email, ip });
      if (over) return tooMany(over);
    } catch (e) {
      return unavailable("limiter", e);
    }

    let pepper;
    try {
      pepper = await secrets.pepper();
    } catch (e) {
      return unavailable("pepper", e);
    }
    const hash = emailHash(pepper, email);
    let member;
    let open;
    let prev;
    try {
      [member, open, prev] = await Promise.all([isMember(email), hasOpenRequest(hash), ddb.send(new cmds.GetCommand({ TableName: table, Key: codeKey(hash), ConsistentRead: true }))]);
      prev = prev?.Item;
    } catch (e) {
      return unavailable("lookup", e);
    }
    const real = !member && !open;
    const code = String(random()).padStart(6, "0");
    const createdAt = nowSec();
    // A resend never refills the guess budget: while the previous code is still alive its attempts carry over, and a code that already
    // used them all stays locked until it would have expired (a resend neither extends the lock nor lifts it). The same for every kind
    // of address, so parity holds. The Get above and this Put are not one transaction: a guess landing between them can be lost, which
    // costs an attacker nothing they did not already have (the 10 an hour verify limits bound it).
    const prevLive = prev && Number(prev.expiresAt) > createdAt ? prev : undefined;
    const attempts = prevLive ? Math.max(0, Number(prevLive.attempts) || 0) : 0;
    const expiresAt = prevLive && attempts >= MAX_CODE_ATTEMPTS ? Number(prevLive.expiresAt) : createdAt + CODE_TTL_SECONDS;
    try {
      await ddb.send(new cmds.PutCommand({
        TableName: table,
        Item: {
          ...codeKey(hash), entity: "accesscode", attempts, createdAt, expiresAt, ttl: expiresAt,
          codeMac: real ? codeMac(pepper, email, code) : hmac(pepper, `decoy:${randomBytes(16).toString("hex")}`), // a decoy never matches
        },
      }));
      await mailer.send({ template: member ? "already_member" : open ? "already_requested" : "code", to: email, vars: real ? { code } : {} });
    } catch (e) {
      // no half state: put the previous live code back (a failed resend must not cost a legitimate visitor the code they hold), else remove ours
      await (prevLive ? ddb.send(new cmds.PutCommand({ TableName: table, Item: prevLive })) : ddb.send(new cmds.DeleteCommand({ TableName: table, Key: codeKey(hash) }))).catch(() => undefined);
      return unavailable("send", e);
    }
    return json(202, { ok: true });
  }

  async function verify(event) {
    const denied = gate(event);
    if (denied) return denied;
    const b = bodyOf(event);
    const email = normalizeJoinEmail(b.email);
    const code = typeof b.code === "string" ? b.code.trim() : "";
    if (!email || !/^\d{6}$/.test(code)) return json(400, { detail: "invalid_code" });
    if (clientIp(event) === "unknown") return unavailable("no-client-ip", new Error("no client address"));
    try {
      const over = await limited(VERIFY_LIMITS, { email, ip: clientIp(event) });
      if (over) return tooMany(over, "too_many_attempts");
    } catch (e) {
      return unavailable("limiter", e);
    }
    try {
      const pepper = await secrets.pepper();
      const hash = emailHash(pepper, email);
      const key = codeKey(hash);
      const got = await ddb.send(new cmds.GetCommand({ TableName: table, Key: key, ConsistentRead: true }));
      const item = got?.Item;
      if (!item) return json(400, { detail: "invalid_code" }); // never asked, already used, or deleted by the TTL: the same answer
      if (!(item.expiresAt > nowSec())) {
        // Expired is answered exactly like missing (not a distinct 410): DynamoDB's TTL purge runs late, so a distinct answer would tell an
        // anonymous caller that someone asked for this address in the last two days.
        await ddb.send(new cmds.DeleteCommand({ TableName: table, Key: key })).catch(() => undefined);
        return json(400, { detail: "invalid_code" });
      }
      // The attempt is counted atomically before the code is compared, so parallel guesses cannot exceed MAX_CODE_ATTEMPTS comparisons.
      let attempts;
      try {
        const u = await ddb.send(new cmds.UpdateCommand({
          TableName: table, Key: key, UpdateExpression: "ADD attempts :one", ConditionExpression: "attribute_exists(PK)",
          ExpressionAttributeValues: { ":one": 1 }, ReturnValues: "UPDATED_NEW",
        }));
        attempts = Number(u?.Attributes?.attempts);
      } catch (e) {
        if (e?.name === "ConditionalCheckFailedException") return json(400, { detail: "invalid_code" }); // consumed meanwhile
        throw e;
      }
      if (attempts > MAX_CODE_ATTEMPTS) return json(429, { detail: "too_many_attempts" });
      if (!sameMac(item.codeMac, codeMac(pepper, email, code))) {
        // The spent item stays (locked) until it expires: deleting it would let a resend start a fresh budget of guesses.
        if (attempts >= MAX_CODE_ATTEMPTS) return json(429, { detail: "too_many_attempts" });
        return json(400, { detail: "invalid_code" });
      }
      const ticket = randomBytes(32).toString("base64url");
      const at = nowSec();
      const expiresAt = at + TICKET_TTL_SECONDS;
      try {
        await ddb.send(new cmds.TransactWriteCommand({
          TransactItems: [
            { Delete: { TableName: table, Key: key, ConditionExpression: "attribute_exists(PK)" } }, // a code is good once
            { Put: { TableName: table, Item: { ...ticketKey(ticket), entity: "accessticket", email, emailHash: hash, createdAt: at, expiresAt, ttl: expiresAt }, ConditionExpression: "attribute_not_exists(PK)" } },
          ],
        }));
      } catch (e) {
        if (e?.name === "TransactionCanceledException" || e?.name === "ConditionalCheckFailedException") return json(400, { detail: "invalid_code" });
        throw e;
      }
      return json(200, { ticket, expiresAt: new Date(expiresAt * 1000).toISOString() });
    } catch (e) {
      return unavailable("verify", e);
    }
  }

  function config(event) {
    const denied = gate(event, { method: "GET" });
    if (denied) return denied;
    return json(200, { open: true, turnstileSiteKey });
  }

  const ROUTES = { "/access-request/config": config, "/access-request/start": start, "/access-request/verify": verify };
  return {
    /** The response for an access-request route, or undefined when `rel` (the path below /auth) is not one of this task's routes. */
    async handle(rel, event) {
      const route = Object.hasOwn(ROUTES, rel) ? ROUTES[rel] : undefined;
      return route ? route(event) : undefined;
    },
    gate, botCheck, submitAdmission, queueFull, emailHash, ticketKey,
  };
}
