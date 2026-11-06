// HFY-TSK-276 (log-hygiene-suite; review PS-20, BRD2 R-18 and R-19): "logs carry codes and counts only" as a tested property.
//
// One captured-log test. It plants a fixture date of birth, a phone number and a note text (api/test/vectors/log-hygiene-fixtures.json,
// shared with the renderer and Worker suites) through
//   - every route in the ROUTES registry, grouped by family below, in four situations: the planted values in the path, query and JSON body
//     with a healthy store; the same with a store whose every failure quotes them (the shape of a cancelled transaction, a JSON.parse
//     message, an SDK error); a body that is not JSON at all; and, for the routes that take a body, a body that is valid but hostile;
//   - the chat Worker entry (chat-worker/dist/index.js, the committed bundle) on its two routes, its upgrade checks and the admin route;
//   - the renderer (lambda/hfy-sync-render), by running gramps/tests/unit/test_render_log_hygiene.py, which reads the same fixtures.
// and asserts that no needle appears in any log line (every console method and the injected `log`), in any error body or header, or in
// SYNC#RENDER.last_error.
//
// The renderer half spawns python3 (stdlib unittest only), so the runner that runs `cd api && npm test` needs python3 on PATH; the test fails
// with a named message when it is missing, rather than skipping, so a runner without it cannot report the renderer as proven.
//
// It lives in the api suite, not in ci.manifest.yaml `tests`, because it imports api code that needs CodeArtifact (HFY-R62, BRD2 10.2).
// It fails when a route in ROUTES has no case: add the route to FAMILIES below, with a body shape if the default does not reach its parser.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inspect } from "node:util";
import { SignJWT, exportJWK, exportSPKI, generateKeyPair, importPKCS8 } from "jose";
import { ROUTES } from "../src/routes.js";
import { createServiceAuthenticator, CHAT_AUDIENCE, CHAT_ISSUER, CHAT_SUBJECT } from "../src/chat.js";
import { SYNC_AUDIENCE, SYNC_CLIENT_ID, createSyncAuthenticator } from "../src/sync/auth.js";
import { createGroupResolver } from "../src/policy.js";
import { ISSUER, makeApi, pem, signToken } from "./world.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const FX = JSON.parse(readFileSync(resolve(here, "vectors", "log-hygiene-fixtures.json"), "utf8"));
const { dob: DOB, phone: PHONE, note: NOTE, needles: NEEDLES } = FX;

/** The needles found in `text`, case-insensitively and again with whitespace and punctuation squeezed out (a digits-only phone number). */
export function leaksIn(text, needles = NEEDLES) {
  const s = String(text);
  const lower = s.toLowerCase();
  const squeezed = lower.replace(/[^a-z0-9]/g, "");
  return needles.filter((n) => lower.includes(n.toLowerCase()) || (n.replace(/[^A-Za-z0-9]/g, "").length >= 8 && squeezed.includes(n.toLowerCase().replace(/[^a-z0-9]/g, ""))));
}

// ---- the route families (one entry per ROUTES name; a new route fails the coverage test until it is listed) -----------------------------------
const H = { // the default hostile body: the planted values under every field name a parser might read
  body: NOTE, text: NOTE, note: NOTE, notes: [NOTE], message: NOTE, title: NOTE, summary: NOTE, reason: NOTE, label: NOTE, description: NOTE, comment: NOTE, alt: NOTE,
  dob: DOB, birth: DOB, birthDate: DOB, born: DOB, date: DOB, since: DOB, phone: PHONE, tel: PHONE, contact: `${PHONE} ${DOB}`, email: "zq7xmarker@example.test",
  itemId: NOTE, id: NOTE, subject: `person:${NOTE}`, target: `comment:${NOTE}`, action: DOB, visibility: PHONE, contentType: NOTE, size: DOB, purpose: NOTE,
  endpoint: `https://push.example.test/${NOTE}`, keys: { p256dh: NOTE, auth: PHONE }, types: { [NOTE]: { enabled: DOB, level: PHONE } },
  attachments: [{ kind: "image", url: `/uploads/posts/${NOTE}`, alt: NOTE }], fields: { [DOB]: NOTE },
};
const OPS = [{ op: "set", class: "Person", handle: "h1", path: "/primary_name/first_name", base: NOTE, value: DOB, note: PHONE, base_version: 1, obj: { _class: "Person", handle: "h1", note: NOTE, birth: DOB, phone: PHONE } }];
const ULID = "01J00000000000000000000000";
const CONV = "dm:I9001:I9002";
const SHAPES = {
  "comments.create": { subject: "person:I0009", body: `${NOTE} ${PHONE} ${DOB}`, attachments: [{ url: `https://media.example.test/${NOTE}.jpg` }] },
  "comments.update": { body: `${NOTE} ${PHONE} ${DOB}` },
  "posts.create": { body: `${NOTE} ${PHONE} ${DOB}`, visibility: "published" },
  "posts.update": { body: `${NOTE} ${PHONE} ${DOB}`, visibility: "published" },
  "moderation.post": { target: `comment:${ULID}`, action: "hide", reason: `${NOTE} ${PHONE} ${DOB}` },
  "relationships.preview": { intent: { type: "spouse", person: { ref: "I9001" }, other: { new: { first_name: NOTE, surname: PHONE, birth: DOB, note: NOTE } } } },
  "relationships.post": { intent: { type: "spouse", person: { ref: "I9001" }, other: { new: { first_name: NOTE, surname: PHONE, birth: DOB, note: NOTE } } }, confirmDistinct: [NOTE] },
  "changes.post": { base_versions: { [NOTE]: 1 }, ops: OPS, dry_run: false },
  "adminDeletes.post": { target: { class: "Person", handle: NOTE }, remove_references: true, reason: `${NOTE} ${DOB}` },
  "lifeDates.post": { target: "Person:abc", birth: { year: 1890 }, reason: `${NOTE} ${DOB}` },
  "proposals.amend": { ops: OPS, note: `${NOTE} ${PHONE}` },
  "proposals.decide": { decision: "approve", note: `${NOTE} ${PHONE} ${DOB}`, edits: OPS },
  "accessRequests.decide": { decision: "link", grampsId: "I0001", version: 1, confirmedOutside: true, note: `${NOTE} ${PHONE} ${DOB}` },
  "sync.sessions.open": { expected: { head: NOTE }, note: NOTE },
  "sync.batches": { ops: OPS },
  "sync.status": { status: NOTE, detail: DOB, phone: PHONE },
  "sync.conflicts.decision": { decision: "keep_cloud", note: `${NOTE} ${DOB}` },
  "chat.push": { items: [{ recipient: "I9002", conv: CONV, seq: 1, actor: "I9001", text: `${NOTE} ${PHONE} ${DOB}` }] },
  "chat.archive": { conv: CONV, members: ["I9001", "I9002"], messages: [{ seq: 1, from: "I9001", ts: 1, text: `${NOTE} ${PHONE} ${DOB}` }] },
};

/** family -> the ROUTES names it covers. */
export const FAMILIES = {
  me: ["me.get"],
  links: ["links.get", "links.put"],
  onthisday: ["onthisday.get", "onthisday.hide", "onthisday.unhide"],
  contributions: ["contributions.list", "contributions.stats", "contributions.site"],
  subscriptions: ["subscriptions.get", "subscriptions.list", "subscriptions.put", "subscriptions.remove"],
  comments: ["comments.list", "comments.create", "comments.update", "comments.delete", "comments.react", "comments.graduate"],
  moderation: ["moderation.post", "moderation.list"],
  media: ["media.list", "media.get"],
  posts: ["posts.list", "posts.get", "posts.create", "posts.update", "posts.visibility", "posts.delete"],
  uploads: ["uploads.presign"],
  notifications: [
    "notifications.vapid-public-key", "notifications.subscribe", "notifications.unsubscribe", "notifications.preferences.get", "notifications.preferences.put",
    "notifications.inbox.list", "notifications.inbox.count", "notifications.inbox.read",
  ],
  sync: [
    "sync.meta", "sync.bind", "sync.sessions.open", "sync.sessions.complete", "sync.sessions.abort", "sync.batches", "sync.media.presign", "sync.snapshot", "sync.changes",
    "sync.media.download", "sync.status", "sync.conflicts.list", "sync.conflicts.decision", "sync.conflicts.reconcile", "sync.conflicts.applied", "sync.admin.status",
  ],
  chat: ["chat.directory", "chat.push", "chat.archive"],
  records: ["records.byGrampsId", "records.get", "edit.schema", "edit.get"],
  changes: ["changes.post", "adminDeletes.post", "adminDuplicates.list", "lifeDates.get", "lifeDates.post"],
  relationships: ["relationships.preview", "relationships.post"],
  proposals: ["proposals.list", "proposals.get", "proposals.amend", "proposals.withdraw", "proposals.decide"],
  accessRequests: [
    "accessRequests.list", "accessRequests.get", "accessRequests.decide", "accessRequests.revokeGrant", "accessRequests.revoke", "accessRequests.resendNotice",
    "accessRequests.secondEmails", "accessRequests.secondEmail",
  ],
};
const CASE_NAMES = Object.values(FAMILIES).flat();

// ---- the rig ---------------------------------------------------------------------------------------------------------------------------------
const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug", "trace", "dir"];
/** Every console call and every call on the injected logger, as one inspected string (depth 8: error properties, causes and cancellation reasons included). */
function captureLogs() {
  const lines = [];
  const saved = {};
  const push = (level) => (...args) => { lines.push(`${level} ${args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: 8, maxStringLength: null, breakLength: Infinity }))).join(" ")}`); };
  for (const m of CONSOLE_METHODS) { saved[m] = console[m]; console[m] = push(`console.${m}`); }
  const log = Object.fromEntries(["error", "warn", "info", "log", "debug"].map((m) => [m, push(m)]));
  return { lines, log, restore() { for (const m of CONSOLE_METHODS) console[m] = saved[m]; } };
}

/** An error whose message, properties and cause all quote the planted values, the way a cancelled transaction or a JSON.parse failure does. */
const poison = () => Object.assign(new Error(`The conditional request failed: Item {note: ${NOTE}, dob: ${DOB}, phone: ${PHONE}} Unexpected token ${DOB} in JSON`, { cause: new Error(`${NOTE} ${PHONE}`) }), {
  name: "TransactionCanceledException",
  CancellationReasons: [{ Code: "ConditionalCheckFailed", Message: NOTE, Item: { note: { S: NOTE }, dob: { S: DOB }, phone: { S: PHONE } } }],
  $response: { body: `${NOTE} ${DOB} ${PHONE}` },
});

const OWNER = "I9001";
const MEMBER = "I9001";
const ADMIN = "I0099";
const NOW = Date.parse("2026-10-14T12:00:00Z");
const nowS = Math.floor(NOW / 1000);
const GROUPS = { version: 1, groups: { "gramps-owner": { subjects: [OWNER] }, "hfy-admin": { subjects: [ADMIN] } } };
const HS = { "x-hfy-sync-client": "hfy_sync/0.1.0", "x-hfy-gramps-version": "6.0.6", "x-hfy-gramps-schema": "21", "x-hfy-redaction-version": "1" };
const HOSTILE_HS = { ...HS, "x-hfy-sync-client": `hfy_sync/${DOB}`, "x-hfy-gramps-version": PHONE, "x-hfy-gramps-schema": NOTE.replace(/[^\x20-\x7e]/g, "?") };

let syncKey;
let serviceKeys;
let restoreEnv;
beforeAll(async () => {
  syncKey = await importPKCS8(pem, "RS256");
  const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
  serviceKeys = { privateKey, spki: JSON.stringify([{ kid: "hfy-chat-1", spki: (await exportSPKI(publicKey)).replace(/-----[A-Z ]+-----|\s/g, "") }]) };
  const saved = { SYNC_API_ENABLED: process.env.SYNC_API_ENABLED, HFY_EDITING: process.env.HFY_EDITING };
  process.env.SYNC_API_ENABLED = "1";
  process.env.HFY_EDITING = "on";
  restoreEnv = () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
});
afterAll(() => restoreEnv?.());

const syncToken = () =>
  new SignJWT({ client_id: SYNC_CLIENT_ID, token_use: "access", amr: ["passkey", "mfa"], auth_time: nowS - 10, groups: [] })
    .setProtectedHeader({ alg: "RS256", kid: "hfy-session-1" }).setSubject(OWNER).setIssuer(ISSUER).setAudience(SYNC_AUDIENCE).setIssuedAt(nowS - 5).setExpirationTime(nowS + 600).sign(syncKey);
let jti = 0;
const serviceToken = () =>
  new SignJWT({}).setProtectedHeader({ alg: "ES256", kid: "hfy-chat-1", typ: "JWT" }).setIssuer(CHAT_ISSUER).setAudience(CHAT_AUDIENCE).setSubject(CHAT_SUBJECT)
    .setIssuedAt().setExpirationTime("60s").setJti(`01JCTESTJTI${++jti}`).sign(serviceKeys.privateKey);

/** The feature flags every gated route names, all on. */
const allFlags = () => Object.fromEntries(ROUTES.filter((r) => r.gate?.type === "feature").map((r) => [r.gate.name, true]));

const BENIGN = { class: "Person", cls: "Person", ref: "I9001", handle: "h1", gramps_id: "I9001", id: ULID };
const HOSTILE_SEGMENT = `${DOB}-415-555-0199-zq7xmarker`;
const pathFor = (route, hostile) => `/api${route.path.replace(/:([A-Za-z_]+)/g, (_, n) => (hostile ? HOSTILE_SEGMENT : BENIGN[n] ?? ULID))}`;
const HOSTILE_QUERY = { q: NOTE, query: NOTE, from: DOB, to: DOB, since: DOB, cursor: PHONE, limit: DOB, subject: `person:${NOTE}`, thread: NOTE, date: DOB, phone: PHONE, class: NOTE, kind: PHONE };

let reqN = 0;
async function world(route, { poisoned }) {
  const logs = captureLogs();
  const throwing = async () => { throw poison(); };
  const readEntries = poisoned ? throwing : async () => new Map([["a@example.test", { sub: MEMBER }], ["b@example.test", { sub: "I9002" }]]);
  let syncAuth;
  const w = makeApi({
    clock: () => NOW, log: logs.log, flags: async () => allFlags(),
    ...(poisoned ? { intercept: async () => { throw poison(); } } : {}),
    extraDeps: {
      authenticateSync: (e) => syncAuth(e), authenticateService: createServiceAuthenticator({ getKeys: () => serviceKeys.spki, log: logs.log }), readEntries,
      resolveLabel: async ({ sub }) => sub, isOwner: async (sub) => sub === OWNER,
      ...(poisoned ? { s3: { send: throwing }, presignPut: throwing, presignGet: throwing } : {}),
    },
  });
  syncAuth = createSyncAuthenticator({ getJwks: async () => w.jwks, getGroups: createGroupResolver({ load: async () => GROUPS, log: logs.log }), now: () => NOW, log: logs.log });
  return { w, logs };
}

/** The request for `route`, as a Function URL event. `variant`: "hostile" (planted path, query and body), "benign" (valid ids, planted body) or "raw" (a body that is not JSON). */
async function requestFor(route, { variant, who }) {
  const hostile = variant === "hostile";
  const hasBody = ["POST", "PUT", "PATCH"].includes(route.method);
  const headers = {};
  const cookies = [];
  if (route.auth === "sync-bearer") Object.assign(headers, hostile ? HOSTILE_HS : HS, { authorization: `Bearer ${await syncToken()}` });
  else if (route.auth === "service") headers.authorization = `Bearer ${await serviceToken()}`;
  else cookies.push(`io_id=${await signToken(who === "admin" ? ADMIN : MEMBER)}`);
  let body;
  if (hasBody) {
    headers["content-type"] = "application/json";
    body = variant === "raw" ? `{"note": ${NOTE}, "dob": ${DOB}, "phone": ${PHONE} ` : JSON.stringify({ ...H, ...(SHAPES[route.name] ?? {}) });
  }
  return {
    requestContext: { http: { method: route.method }, requestId: `req-${++reqN}` }, rawPath: pathFor(route, hostile), queryStringParameters: HOSTILE_QUERY, headers, cookies, body,
  };
}

const whoFor = (route) => (route.auth === "session" ? ["member", "admin"] : ["owner"]);
const VARIANTS = ["hostile", "benign", "raw"];

const stats = { requests: 0, errors: 0, fiveHundreds: 0, logLines: 0 };
const failures = [];
async function drive(route, opts) {
  const { w, logs } = await world(route, opts);
  try {
    for (const who of whoFor(route)) {
      for (const variant of VARIANTS) {
        if (variant === "raw" && !["POST", "PUT", "PATCH"].includes(route.method)) continue;
        const before = logs.lines.length;
        let res;
        try {
          res = await w.handler(await requestFor(route, { variant, who }));
        } catch (e) {
          failures.push(`${route.name} ${who} ${variant}${opts.poisoned ? " poisoned" : ""}: the handler threw ${e?.name}`);
          continue;
        }
        stats.requests += 1;
        if (res.statusCode >= 400) stats.errors += 1;
        if (res.statusCode >= 500) stats.fiveHundreds += 1;
        stats.logLines += logs.lines.length - before;
        const surface = [...(res.statusCode >= 400 ? [`status ${res.statusCode} headers ${JSON.stringify(res.headers ?? {})} body ${res.body ?? ""}`] : []), ...logs.lines.slice(before)];
        for (const s of surface) {
          const found = leaksIn(s);
          if (found.length) failures.push(`${route.name} (${who}, ${variant}${opts.poisoned ? ", poisoned store" : ""}) leaks ${JSON.stringify(found)} in: ${s.slice(0, 240)}`);
        }
      }
    }
    // SYNC#RENDER.last_error, as the renderer writes it (a class and a rule id), must never hold a needle: scan any such row the world holds.
    for (const [k, row] of w.ddb.rows ?? []) {
      if (String(k).startsWith("SYNC#RENDER") && row?.last_error !== undefined) {
        const found = leaksIn(row.last_error);
        if (found.length) failures.push(`SYNC#RENDER.last_error holds ${JSON.stringify(found)}`);
      }
    }
  } finally {
    logs.restore();
  }
}

// ---- the tests -------------------------------------------------------------------------------------------------------------------------------
describe("the detector", () => {
  it("finds each needle, in the shapes a log line gives it", () => {
    expect(leaksIn("born 1911-03-27 in town")).toEqual(["1911-03-27"]);
    expect(leaksIn(`call ${PHONE}`)).toContain("(415) 555-0199");
    expect(leaksIn("phone 415 555 0199")).toContain("4155550199"); // digits-only after squeezing
    expect(leaksIn(`{"note":"${NOTE}"}`)).toContain("zq7xmarker");
    expect(leaksIn("ZQ7XMARKER")).toContain("zq7xmarker");
    expect(leaksIn("class=TransactionCanceledException rule=privacy.date_text count=3 route=posts.create requestId=abc")).toEqual([]);
  });
  it("a deliberately leaky logger is caught by the same capture the suite uses", () => {
    const logs = captureLogs();
    try { logs.log.error("unhandled", { message: poison().message }); console.warn("also", NOTE); } finally { logs.restore(); }
    expect(logs.lines.filter((l) => leaksIn(l).length)).toHaveLength(2);
  });
});

describe("coverage: every route in ROUTES belongs to a family with a case, and no case names a route that is gone", () => {
  it("lists every ROUTES name exactly once", () => {
    const names = ROUTES.map((r) => r.name);
    expect(names.filter((n) => !CASE_NAMES.includes(n)), "routes with no log-hygiene case: add them to FAMILIES").toEqual([]);
    expect(CASE_NAMES.filter((n) => !names.includes(n)), "cases for routes that no longer exist").toEqual([]);
    expect(new Set(CASE_NAMES).size).toBe(CASE_NAMES.length);
    expect(Object.keys(SHAPES).filter((n) => !names.includes(n))).toEqual([]);
  });
  it("covers every auth mode the registry uses", () => {
    expect([...new Set(ROUTES.map((r) => r.auth))].sort()).toEqual(["service", "session", "sync-bearer"]);
  });
});

describe("routes: no planted value reaches a log line, an error body or SYNC#RENDER.last_error", () => {
  for (const [family, names] of Object.entries(FAMILIES)) {
    for (const poisoned of [false, true]) {
      it(`${family}: ${poisoned ? "a store whose failures quote the values" : "a healthy store"}`, async () => {
        const before = failures.length;
        for (const name of names) await drive(ROUTES.find((r) => r.name === name), { poisoned });
        expect(failures.slice(before)).toEqual([]);
      }, 60_000);
    }
  }

  it("the run exercised the failure paths (the suite is not vacuous)", () => {
    expect(stats.requests).toBeGreaterThan(ROUTES.length * 4);
    expect(stats.errors).toBeGreaterThan(ROUTES.length);
    expect(stats.fiveHundreds, "no poisoned-store request reached a 500: the store failure never got to the logger").toBeGreaterThan(10);
    expect(stats.logLines, "no route logged anything: the capture is not wired").toBeGreaterThan(10);
  });
});

describe("the chat Worker: the entry, its upgrade checks and the admin route", () => {
  const SITE = "https://harrisonfamily.test";
  const JWKS_URL = `${SITE}/auth/.well-known/jwks.json`;
  const ADMIN_TOKEN = "admin-token-for-the-log-hygiene-suite-0123456789";
  let bundle;
  let restoreFetch;
  let cookie;
  beforeAll(async () => {
    bundle = await import(pathToFileURL(resolve(repo, "chat-worker", "dist", "index.js")).href);
    const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
    const jwks = JSON.stringify({ keys: [{ ...(await exportJWK(publicKey)), kid: "worker-test-1", alg: "RS256", use: "sig" }] });
    const session = await new SignJWT({ client_id: "family-web", token_use: "access" }).setProtectedHeader({ alg: "RS256", kid: "worker-test-1" })
      .setSubject("I9001").setIssuer(`${SITE}/auth`).setAudience("family-web").setIssuedAt().setExpirationTime("1h").sign(privateKey);
    cookie = `io_id=${session}`;
    const real = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (req.url === JWKS_URL) return new Response(jwks, { status: 200, headers: { "content-type": "application/json" } });
      return new Response("not found", { status: 404 });
    };
    restoreFetch = () => { globalThis.fetch = real; };
  });
  afterAll(() => restoreFetch?.());

  const ns = () => ({ idFromName: (n) => ({ n }), get: () => ({ fetch: async () => new Response("hub") }) });
  const env = (extra = {}) => ({
    CHAT_HUB: ns(), SITE_ORIGIN: SITE, SESSION_ISSUER: `${SITE}/auth`, SESSION_AUDIENCE: "family-web", SESSION_JWKS_URL: JWKS_URL, SESSION_COOKIE: "io_id",
    CHAT_ENABLED: "1", CHAT_OPEN_TO: "all", CHAT_WORKER_VERSION: "abc1234", ...extra,
  });

  it("no needle reaches the console or an error body, whatever the request carries", async () => {
    const logs = captureLogs();
    const seen = [];
    const hostileHeaders = { "x-note": NOTE, "x-dob": DOB, "x-phone": PHONE, referer: `${SITE}/chat/?c=${encodeURIComponent(NOTE)}`, "user-agent": `${PHONE} ${DOB}` };
    const up = (extra = {}) => new Request(`${SITE}/chat/ws?note=${encodeURIComponent(NOTE)}&dob=${DOB}&phone=${encodeURIComponent(PHONE)}`, {
      headers: { upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13", origin: SITE, ...hostileHeaders, ...extra },
    });
    const adminReq = (headers, body) => new Request(`${SITE}/chat/v1/admin/expunge?note=${encodeURIComponent(NOTE)}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
    const requests = [
      [up({ cookie }), env()],
      [up({ cookie: `io_id=${NOTE}` }), env()],
      [up({ cookie, origin: `https://${DOB}.example.test` }), env()],
      [up({ cookie, authorization: `Bearer ${NOTE}` }), env({ CHAT_ENABLED: "0" })],
      [new Request(`${SITE}/chat/v1/${encodeURIComponent(NOTE)}/${DOB}`, { headers: { cookie, ...hostileHeaders } }), env()],
      [new Request(`${SITE}/chat/v1/health?x=${DOB}`, { method: "POST", headers: { cookie, ...hostileHeaders }, body: `${NOTE} ${PHONE}` }), env()],
      [adminReq({ authorization: `Bearer ${ADMIN_TOKEN}` }, JSON.stringify({ conv: NOTE, seq: DOB })), env({ CHAT_ADMIN_TOKEN: ADMIN_TOKEN })],
      [adminReq({ authorization: `Bearer ${ADMIN_TOKEN}` }, `{"conv": ${NOTE}, "seq": ${DOB}`), env({ CHAT_ADMIN_TOKEN: ADMIN_TOKEN })],
      [adminReq({ authorization: `Bearer ${NOTE.replace(/\s/g, "-")}` }, JSON.stringify({ conv: CONV, seq: 1 })), env({ CHAT_ADMIN_TOKEN: ADMIN_TOKEN })],
      [adminReq({ authorization: `Bearer ${ADMIN_TOKEN}` }, `${NOTE} `.repeat(400)), env({ CHAT_ADMIN_TOKEN: ADMIN_TOKEN })],
      [adminReq({ authorization: `Bearer ${ADMIN_TOKEN}` }, JSON.stringify({ conv: CONV, seq: 1 })), env({ CHAT_ADMIN_TOKEN: ADMIN_TOKEN, CHAT_HUB: { idFromName: () => ({}), get: () => ({ fetch: async () => { throw poison(); } }) } })],
    ];
    try {
      for (const [req, e] of requests) {
        try {
          const res = await bundle.default.fetch(req, e, {});
          if (res.status >= 400) seen.push(`status ${res.status} headers ${JSON.stringify([...res.headers])} body ${await res.clone().text()}`);
        } catch (err) {
          seen.push(`the Worker threw: ${err?.name}`); // a throw is a platform 500 with no body of ours; the message is never ours to log
          expect(leaksIn(`${err?.name}`)).toEqual([]);
        }
      }
    } finally {
      logs.restore();
    }
    const surfaces = [...seen, ...logs.lines];
    expect(surfaces.filter((s) => s.startsWith("status")).length).toBeGreaterThan(2);
    expect(surfaces.map((s) => [s, leaksIn(s)]).filter(([, f]) => f.length)).toEqual([]);
  });
});

describe("the renderer (lambda/hfy-sync-render)", () => {
  it("runs gramps/tests/unit/test_render_log_hygiene.py: log lines, last_error, metrics and the exception that leaves the handler hold no needle", () => {
    const probe = spawnSync("python3", ["--version"], { encoding: "utf8" });
    expect(probe.status, "python3 is needed for the renderer half of the log-hygiene suite").toBe(0);
    const r = spawnSync("python3", ["-m", "unittest", "discover", "-s", "gramps/tests/unit", "-p", "test_render_log_hygiene.py"], { cwd: repo, encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
    expect(r.status, `${r.stderr}`.slice(-2000)).toBe(0);
    expect(r.stderr).toMatch(/Ran \d+ tests?/);
  }, 120_000);
});
