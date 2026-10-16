// HFY-TSK-172 (sync-routes): /api/sync auth and handshake: sync-bearer, gramps-owner, step-up, the handshake, meta, bind and the server switches.
// In-memory DynamoDB fake, a local JWKS, synthetic subjects and fingerprints only.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SignJWT, importPKCS8 } from "jose";
import { generateKeyPairSync } from "node:crypto";
import { makeApi, pem, signToken, ISSUER, TABLE, cmds } from "./world.js";
import { buildCaps } from "../src/routes.js";
import { createGroupResolver } from "../src/policy.js";
import { SYNC_AUDIENCE, SYNC_CLIENT_ID, createSyncAuthenticator, requireConflictDecision, requireOwner, requireStepUp, stepUpFresh } from "../src/sync/auth.js";
import { checkHandshake, compareSemver, handshakeTerms, parseSemver, syncContext } from "../src/sync/guard.js";
import { headKey } from "../src/sync/store.js";

const OWNER = "I9001";
const OTHER = "I9002";
const NOW = Date.parse("2026-10-14T12:00:00Z");
const nowS = Math.floor(NOW / 1000);
const GROUPS = { version: 1, groups: { "gramps-owner": { subjects: [OWNER], emails: ["someone@example.test"] }, "hfy-admin": { subjects: ["I0099"] } } };
const key = await importPKCS8(pem, "RS256");
const HS = { "x-hfy-sync-client": "hfy_sync/0.1.0", "x-hfy-gramps-version": "6.0.6", "x-hfy-gramps-schema": "21", "x-hfy-redaction-version": "1" };
const FP = "fp-0123456789abcdef";
const NAME_HASH = "a".repeat(64);
const BIND = { dbid: "db-synthetic-1", fingerprint: FP, tree_name_sha256: NAME_HASH };

/** A sync access token. Defaults: owner, audience and client right, mfa sign-in 10 s ago. */
const token = (sub = OWNER, o = {}) =>
  new SignJWT({ client_id: SYNC_CLIENT_ID, token_use: "access", amr: ["passkey", "mfa"], auth_time: nowS - 10, groups: [], ...(o.claims ?? {}) })
    .setProtectedHeader({ alg: "RS256", kid: "hfy-session-1" })
    .setSubject(sub).setIssuer(o.iss ?? ISSUER).setAudience(o.aud ?? SYNC_AUDIENCE)
    .setIssuedAt(o.iat ?? nowS - 5).setExpirationTime(o.exp ?? nowS + 600).sign(key);

/** A signed token with no exp claim (jose validates exp only when present). */
const tokenNoExp = () =>
  new SignJWT({ client_id: SYNC_CLIENT_ID, token_use: "access", amr: ["mfa"], auth_time: nowS - 10 })
    .setProtectedHeader({ alg: "RS256", kid: "hfy-session-1" }).setSubject(OWNER).setIssuer(ISSUER).setAudience(SYNC_AUDIENCE).setIssuedAt(nowS - 5).sign(key);

let envBefore;
beforeEach(() => { envBefore = process.env.SYNC_API_ENABLED; process.env.SYNC_API_ENABLED = "1"; });
afterEach(() => { if (envBefore === undefined) delete process.env.SYNC_API_ENABLED; else process.env.SYNC_API_ENABLED = envBefore; });

function world({ groups = GROUPS, head, uuid } = {}) {
  let auth;
  const w = makeApi({ clock: () => NOW, extraDeps: { authenticateSync: (e) => auth(e), ...(uuid ? { uuid } : {}) } });
  const getGroups = createGroupResolver({ load: async () => { if (groups instanceof Error) throw groups; return groups; }, log: { error() {} } });
  auth = createSyncAuthenticator({ getJwks: async () => w.jwks, getGroups, now: () => NOW, log: { warn() {}, error() {} } });
  if (head) w.ddb.rows.set("SYNC#HEAD\u0000META", { ...headKey(), ...head });
  const call = (method, path, { tok, headers = {}, body, hs = HS, ...rest } = {}) =>
    w.call(method, `/api${path}`, { headers: { ...hs, ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...headers }, ...(body !== undefined ? { body } : {}), ...rest });
  return { ...w, call, head: () => w.ddb.rows.get("SYNC#HEAD\u0000META") };
}
const err = (r) => ({ status: r.status, error: r.body?.error });

describe("SYNC_API_ENABLED (AC3)", () => {
  it("anything but 1 answers 404 not_enabled to every caller, before the token is read", async () => {
    const w = world();
    for (const v of [undefined, "0", "", "true"]) {
      if (v === undefined) delete process.env.SYNC_API_ENABLED; else process.env.SYNC_API_ENABLED = v;
      for (const tok of [undefined, await token(), "garbage"]) {
        const r = await w.call("GET", "/sync/meta", { tok });
        expect(err(r), String(v)).toEqual({ status: 404, error: "not_enabled" });
        expect(r.body.message).toBeTruthy();
      }
    }
    process.env.SYNC_API_ENABLED = "1";
    expect((await w.call("GET", "/sync/meta", { tok: await token() })).status).toBe(200);
  });

  it("the switch is declared on every sync route, as a serverSwitch, and caps.json describes the auth mode", () => {
    const caps = buildCaps();
    const sync = caps.actions.filter((a) => a.path.startsWith("/api/sync/"));
    expect(sync.map((a) => a.name).sort()).toEqual(["sync.batches", "sync.bind", "sync.changes", "sync.conflicts.decision", "sync.conflicts.list", "sync.media.download", "sync.media.presign", "sync.meta", "sync.sessions.abort", "sync.sessions.complete", "sync.sessions.open", "sync.snapshot", "sync.status"]);
    for (const a of sync) expect(a).toMatchObject({ auth: "sync-bearer", gate: { switch: "SYNC_API_ENABLED" } });
    expect(caps.auth.sync_bearer).toMatchObject({ audience: SYNC_AUDIENCE, client_id: SYNC_CLIENT_ID, group: "gramps-owner" });
    expect(caps.sync.handshake_headers).toEqual(["x-hfy-sync-client", "x-hfy-gramps-version", "x-hfy-gramps-schema", "x-hfy-redaction-version", "x-hfy-tree-id"]);
  });
});

describe("sync-bearer authentication (AC2)", () => {
  it("no token, a malformed header or the session cookie alone is 401 with a WWW-Authenticate challenge", async () => {
    const w = world();
    const web = await signToken(OWNER); // a web session token for the same subject
    for (const o of [{}, { headers: { authorization: "Basic abc" } }, { headers: { authorization: "Bearer" } }, { token: web }]) {
      const r = await w.call("GET", "/sync/meta", { ...o, headers: { ...HS, ...(o.headers ?? {}) } });
      expect(err(r)).toEqual({ status: 401, error: "unauthenticated" });
      expect(r.headers["www-authenticate"]).toMatch(/^Bearer realm=/);
    }
  });

  it("a hfy-admin cookie alone never reaches a sync route", async () => {
    const w = world();
    const admin = await signToken("I0099");
    expect((await w.call("GET", "/sync/meta", { token: admin, headers: HS })).status).toBe(401);
    expect((await w.call("POST", "/sync/bind", { token: admin, headers: HS, body: BIND })).status).toBe(401);
  });

  it("checks the issuer, the audience, the client_id, the token use and the expiry", async () => {
    const w = world();
    const bad = {
      issuer: await token(OWNER, { iss: "https://evil.example.test/auth" }),
      audience: await token(OWNER, { aud: "https://harrisonfamily.us/mcp" }),
      web_audience: await token(OWNER, { aud: "harrisonfamily-web" }),
      client: await token(OWNER, { claims: { client_id: "mcp-harrisonfamily" } }),
      no_client: await token(OWNER, { claims: { client_id: undefined } }),
      id_token: await token(OWNER, { claims: { token_use: "id" } }),
      expired: await token(OWNER, { exp: nowS - 120, iat: nowS - 900 }),
      no_exp: await tokenNoExp(),
      no_token_use: await token(OWNER, { claims: { token_use: undefined } }),
    };
    for (const [why, tok] of Object.entries(bad)) expect(err(await w.call("GET", "/sync/meta", { tok })), why).toEqual({ status: 401, error: "unauthenticated" });
    expect((await w.call("GET", "/sync/meta", { tok: await token(OWNER, { aud: ["x", SYNC_AUDIENCE] }) })).status).toBe(200); // aud may be a list that includes ours
  });

  it("a token signed by another key is 401", async () => {
    const w = world();
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    const forged = await new SignJWT({ client_id: SYNC_CLIENT_ID }).setProtectedHeader({ alg: "RS256", kid: "hfy-session-1" }).setSubject(OWNER).setIssuer(ISSUER).setAudience(SYNC_AUDIENCE).setExpirationTime(nowS + 60).sign(other);
    expect((await w.call("GET", "/sync/meta", { tok: forged })).status).toBe(401);
  });

  it("an authenticator without a groups resolver or JWKS is a programming error", () => {
    expect(() => createSyncAuthenticator({ getGroups: async () => [] })).toThrow(TypeError);
    expect(() => createSyncAuthenticator({ getJwks: async () => ({}) })).toThrow(TypeError);
  });
});

describe("gramps-owner comes from groups.json and fails closed (AC2)", () => {
  it("a subject outside the group is 403 not_owner, whatever the token's groups claim says", async () => {
    const w = world();
    const r = await w.call("GET", "/sync/meta", { tok: await token(OTHER, { claims: { groups: ["gramps-owner", "hfy-admin", "admins"] } }) });
    expect(err(r)).toEqual({ status: 403, error: "not_owner" });
    expect(err(await w.call("GET", "/sync/meta", { tok: await token("I0099") }))).toEqual({ status: 403, error: "not_owner" }); // hfy-admin is not gramps-owner
  });

  it("an unreadable, empty or malformed groups.json means nobody is the owner", async () => {
    for (const groups of [new Error("s3 down"), null, {}, { groups: { "gramps-owner": { emails: ["someone@example.test"] } } }, { groups: { "gramps-owner": "I9001" } }, { groups: { "gramps-owner": { subjects: [7, ""] } } }]) {
      const w = world({ groups });
      expect(err(await w.call("GET", "/sync/meta", { tok: await token() })), JSON.stringify(groups)).toEqual({ status: 403, error: "not_owner" });
    }
  });

  it("the owner passes", async () => {
    expect((await world().call("GET", "/sync/meta", { tok: await token() })).status).toBe(200);
  });
});

describe("step-up (AC2)", () => {
  const actorOf = (o) => ({ sync: { owner: true, ...o, stepUp: (n) => stepUpFresh({ amr: o.amr, authTime: o.authTime }, n) } });
  it("amr mfa and auth_time within 300 s; only mfa counts; stale, missing, zero and future auth_time are stale", () => {
    const f = (amr, authTime, at = NOW) => stepUpFresh({ amr, authTime }, at);
    expect(f(["passkey", "mfa"], nowS - 300)).toBe(true);
    expect(f(["mfa"], nowS - 301)).toBe(false);
    expect(f(["passkey", "hwk"], nowS - 5)).toBe(false);
    expect(f(["pwd"], nowS)).toBe(false);
    expect(f(undefined, nowS)).toBe(false);
    expect(f(["mfa"], 0)).toBe(false);
    expect(f(["mfa"], undefined)).toBe(false);
    expect(f(["mfa"], "now")).toBe(false);
    expect(f(["mfa"], nowS + 3600)).toBe(false);
    expect(f(["mfa"], nowS + 10)).toBe(true); // a little clock skew is tolerated
    expect(stepUpFresh({ amr: ["mfa"], auth_time: nowS - 1 }, NOW)).toBe(true); // raw claim names work too
  });

  it("requireStepUp answers 403 step_up_required with the window", () => {
    expect(() => requireStepUp(actorOf({ amr: ["mfa"], authTime: nowS - 20 }), NOW)).not.toThrow();
    const e = (() => { try { requireStepUp(actorOf({ amr: ["mfa"], authTime: nowS - 400 }), NOW, "delete"); } catch (x) { return x; } })();
    expect([e.status, e.code, e.details]).toEqual([403, "step_up_required", { max_age_seconds: 300, reason: "delete" }]);
    expect(() => requireStepUp({}, NOW)).toThrow(/sign-in/);
  });

  it("conflict decisions need gramps-owner plus step-up; an hfy-admin cookie alone is refused", () => {
    const fresh = { amr: ["mfa"], authTime: nowS - 30 };
    expect(() => requireConflictDecision(actorOf(fresh), NOW)).not.toThrow();
    const code = (a) => { try { requireConflictDecision(a, NOW); } catch (x) { return `${x.status} ${x.code}`; } return "ok"; };
    expect(code(actorOf({ amr: ["mfa"], authTime: nowS - 301 }))).toBe("403 step_up_required");
    expect(code(actorOf({ amr: ["passkey"], authTime: nowS }))).toBe("403 step_up_required");
    expect(code({ sync: { owner: false, stepUp: () => true } })).toBe("403 not_owner"); // fresh but not the owner
    expect(code({ id: "I0099", admin: true, label: "I0099" })).toBe("403 not_owner"); // the cookie actor of an hfy-admin
    expect(code(undefined)).toBe("403 not_owner");
    expect(() => requireOwner(actorOf(fresh))).not.toThrow();
  });

  it("the actor a real bearer produces carries a live step-up check", async () => {
    let seen;
    const w = world();
    const auth = createSyncAuthenticator({ getJwks: async () => w.jwks, getGroups: createGroupResolver({ load: async () => GROUPS }), now: () => NOW, log: { warn() {}, error() {} } });
    const ev = async (o) => ({ headers: { authorization: `Bearer ${await token(OWNER, o)}` } });
    seen = await auth(await ev({}));
    expect([seen.admin, seen.sync.owner, seen.sync.stepUp(NOW)]).toEqual([false, true, true]);
    expect(seen.sync.stepUp(NOW + 400_000)).toBe(false);
    seen = await auth(await ev({ claims: { amr: ["passkey"] } }));
    expect(seen.sync.stepUp(NOW)).toBe(false);
    expect(() => requireConflictDecision(seen, NOW)).toThrow(/sign-in/);
  });
});

describe("the handshake (AC3)", () => {
  const get = async (hs, w = world()) => w.call("GET", "/sync/meta", { tok: await token(), hs });
  const without = (name) => Object.fromEntries(Object.entries(HS).filter(([k]) => k !== name));

  it("an old client is 426 upgrade_required with the terms; so is a missing or malformed client header", async () => {
    for (const client of ["hfy_sync/0.0.9", "hfy_sync/abc", "other/1.0.0", "hfy_sync/", ""]) {
      const r = await get({ ...HS, "x-hfy-sync-client": client }, world({ head: { min_client: "0.1.0" } }));
      expect(err(r), client).toEqual({ status: 426, error: "upgrade_required" });
      expect(r.body.details).toMatchObject({ min_client: "0.1.0", accepted: { gramps: ["6.0"], schema: [21] }, redaction_version: 1 });
    }
    expect(err(await get(without("x-hfy-sync-client")))).toEqual({ status: 426, error: "upgrade_required" });
  });

  it("SYNC#HEAD.min_client raises the floor without a deploy; a newer client and prerelease tags pass", async () => {
    const w = world({ head: { min_client: "1.4.0" } });
    expect((await get({ ...HS, "x-hfy-sync-client": "hfy_sync/1.3.9" }, w)).status).toBe(426);
    expect((await get({ ...HS, "x-hfy-sync-client": "hfy_sync/1.4.0" }, w)).status).toBe(200);
    expect((await get({ ...HS, "x-hfy-sync-client": "hfy_sync/2.0.0-rc1" }, w)).status).toBe(200);
  });

  it("an unsupported schema or Gramps version is 426", async () => {
    for (const h of [{ "x-hfy-gramps-schema": "22" }, { "x-hfy-gramps-schema": "twenty" }, { "x-hfy-gramps-version": "5.2.4" }, { "x-hfy-gramps-version": "6.1.0" }, { "x-hfy-gramps-version": "x" }]) {
      expect(err(await get({ ...HS, ...h })), JSON.stringify(h)).toEqual({ status: 426, error: "upgrade_required" });
    }
    expect(err(await get(without("x-hfy-gramps-schema")))).toEqual({ status: 426, error: "upgrade_required" });
    expect(err(await get(without("x-hfy-gramps-version")))).toEqual({ status: 426, error: "upgrade_required" });
    expect((await get({ ...HS, "x-hfy-gramps-version": "6.0" })).status).toBe(200);
    expect((await get({ ...HS, "x-hfy-gramps-schema": "22" }, world({ head: { accepted_schema: [21, 22] } }))).status).toBe(200); // the head widens it
  });

  it("a different redaction version is 409 redaction_version_mismatch; a missing one is 426", async () => {
    const r = await get({ ...HS, "x-hfy-redaction-version": "2" });
    expect(err(r)).toEqual({ status: 409, error: "redaction_version_mismatch" });
    expect(r.body.details).toEqual({ redaction_version: 1 });
    expect(err(await get(without("x-hfy-redaction-version")))).toEqual({ status: 426, error: "upgrade_required" });
    expect((await get({ ...HS, "x-hfy-redaction-version": "2" }, world({ head: { redaction_version: 2 } }))).status).toBe(200);
  });

  it("the headers are read in any case, and the error body is the house {error, message, details} shape", async () => {
    const w = world();
    const r = await w.call("GET", "/sync/meta", { tok: await token(), hs: { "X-HFY-Sync-Client": "hfy_sync/0.0.1", "X-HFY-Gramps-Version": "6.0.6", "X-HFY-Gramps-Schema": "21", "X-HFY-Redaction-Version": "1" } });
    expect(Object.keys(r.body).sort()).toEqual(["details", "error", "message"]);
    expect(JSON.stringify(r.body)).not.toContain("0.0.1"); // the client's value is never echoed
  });

  it("the unit pieces", () => {
    expect(parseSemver("1.2.3-rc1")).toEqual([1, 2, 3]);
    expect(parseSemver("1.2")).toBeNull();
    expect(compareSemver([1, 2, 3], [1, 10, 0])).toBeLessThan(0);
    expect(handshakeTerms(undefined)).toEqual({ min_client: "0.1.0", accepted: { gramps: ["6.0"], schema: [21] }, redaction_version: 1 });
    expect(handshakeTerms({ min_client: "bad", accepted_schema: ["x"] }).accepted.schema).toEqual([21]); // a malformed head falls back to the defaults
    expect(() => checkHandshake({ headers: HS }, handshakeTerms())).not.toThrow();
  });

  it("the handshake runs after authentication: a signed-out caller sees 401, not the terms", async () => {
    const w = world();
    expect(err(await w.call("GET", "/sync/meta", { hs: {} }))).toEqual({ status: 401, error: "unauthenticated" });
  });
});

describe("GET /api/sync/meta (AC4)", () => {
  const person = (handle, gid, deleted) => ({ PK: `REC#Person#${handle}`, SK: "HEAD", GSI1PK: "RECS#Person", GSI1SK: `${gid}#${handle}`, entity: "rec", class: "Person", handle, gramps_id: gid, version: 2, deleted });
  const family = (handle, gid) => ({ PK: `REC#Family#${handle}`, SK: "HEAD", GSI1PK: "RECS#Family", GSI1SK: `${gid}#${handle}`, entity: "rec", class: "Family", handle, gramps_id: gid, version: 1, deleted: true });

  it("an empty store: defaults, unbound, no retired ids, merges off", async () => {
    const w = world();
    const r = await w.call("GET", "/sync/meta", { tok: await token() });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      api_version: 1, min_client: "0.1.0", accepted: { gramps: ["6.0"], schema: [21] }, redaction_version: 1, tree_id: null, bound: null,
      head_seq: 0, rendered_seq: 0, writes_enabled: true, seeded: false, merges_enabled: false, changes_feed: false, expunge_epoch: 0,
      limits: { max_ops: 24, max_obj_bytes: 204800, max_body_bytes: 2097152 },
      id_block: { Person: "I8000-I8999", Family: "F8000-F8999", Event: "E8000-E8999", Place: "P8000-P8999", Media: "O8000-O8999", Note: "N8000-N8999", Source: "S8000-S8999", Citation: "C8000-C8999", Repository: "R8000-R8999" },
      retired_person_ids: [],
    });
    expect(r.headers["cache-control"]).toBe("no-store");
  });

  it("lists the retired Person ids (tombstones only, sorted), the bound tree, seqs and merges_enabled", async () => {
    const w = world({ head: { seq: 41, seeded: true, tree_id: "00000000-0000-4000-8000-000000000001", bound: { dbid: "db-synthetic-1", fingerprint: FP, tree_name_sha256: NAME_HASH, bound_at: "2026-10-01T00:00:00.000Z", by: OWNER }, merges_enabled: false } });
    for (const row of [person("h1", "I0007", true), person("h2", "I0003", true), person("h3", "I0005", false), family("h4", "F0002"), person("h5", "I8001", true)]) w.ddb.rows.set(`${row.PK}\u0000${row.SK}`, row);
    w.ddb.rows.set("SYNC#RENDER\u0000STATE", { PK: "SYNC#RENDER", SK: "STATE", rendered_seq: 40 });
    const r = await w.call("GET", "/sync/meta", { tok: await token() });
    expect(r.body).toMatchObject({ tree_id: "00000000-0000-4000-8000-000000000001", bound: { dbid: "db-synthetic-1", fingerprint: FP }, head_seq: 41, rendered_seq: 40, seeded: true, merges_enabled: false, retired_person_ids: ["I0003", "I0007", "I8001"] });
    expect(JSON.stringify(r.body)).not.toContain(NAME_HASH); // the tree-name hash is never returned
    w.ddb.rows.set("SYNC#HEAD\u0000META", { ...w.head(), merges_enabled: true });
    expect((await w.call("GET", "/sync/meta", { tok: await token() })).body.merges_enabled).toBe(true);
  });

  it("reads the retired list once per head seq (cached), and again after seq moves", async () => {
    const w = world({ head: { seq: 5 } });
    let queries = 0;
    const send = w.ddb.send.bind(w.ddb);
    w.ddb.send = async (c) => { if (c.input?.IndexName === "GSI1") queries += 1; return send(c); };
    await w.call("GET", "/sync/meta", { tok: await token() });
    await w.call("GET", "/sync/meta", { tok: await token() });
    expect(queries).toBe(1);
    w.ddb.rows.set("SYNC#HEAD\u0000META", { ...w.head(), seq: 6 });
    await w.call("GET", "/sync/meta", { tok: await token() });
    expect(queries).toBe(2);
  });

  it("a non-owner is 403 before the handshake: no 426 body, no head read", async () => {
    const w = world({ head: { seq: 1 } });
    const r = await w.call("GET", "/sync/meta", { tok: await token(OTHER), headers: {} });
    expect(err(r)).toEqual({ status: 403, error: "not_owner" });
  });

  it("only the literal true turns merges_enabled on", async () => {
    for (const v of ["true", 1, "yes", null]) {
      const w = world({ head: { seq: 1, merges_enabled: v } });
      expect((await w.call("GET", "/sync/meta", { tok: await token() })).body.merges_enabled, String(v)).toBe(false);
    }
  });

  it("is a read: it works while writes are paused and reports it", async () => {
    const w = world({ head: { seq: 3, writes_enabled: false } });
    const r = await w.call("GET", "/sync/meta", { tok: await token() });
    expect([r.status, r.body.writes_enabled]).toEqual([200, false]);
  });

  it("a method other than GET on the path is 405 for a visible route", async () => {
    expect((await world().call("DELETE", "/sync/meta", { tok: await token() })).status).toBe(405);
  });
});

describe("POST /api/sync/bind (AC1)", () => {
  const ids = () => { let n = 0; return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`; };

  it("the first bind mints a tree_id, stores the binding on SYNC#HEAD and audits it", async () => {
    const w = world({ uuid: ids() });
    const r = await w.call("POST", "/sync/bind", { tok: await token(), body: BIND });
    expect([r.status, r.body]).toEqual([200, { tree_id: "00000000-0000-4000-8000-000000000001" }]);
    expect(w.head()).toMatchObject({ tree_id: "00000000-0000-4000-8000-000000000001", bound: { dbid: BIND.dbid, fingerprint: FP, tree_name_sha256: NAME_HASH, by: OWNER } });
    const audit = w.ddb.all().filter((x) => x.PK === "AUDIT#sync:bind");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ op: "sync.bind", principal: OWNER, before: null, after: { rebind: false } });
    const meta = await w.call("GET", "/sync/meta", { tok: await token() });
    expect(meta.body).toMatchObject({ tree_id: "00000000-0000-4000-8000-000000000001", bound: { dbid: BIND.dbid, fingerprint: FP } });
  });

  it("does not disturb a head that already holds the seq counter and the store gate", async () => {
    const w = world({ head: { seq: 12, seeded: true, writes_enabled: true, live_heads: 9 } });
    await w.call("POST", "/sync/bind", { tok: await token(), body: BIND });
    expect(w.head()).toMatchObject({ seq: 12, seeded: true, writes_enabled: true, live_heads: 9 });
  });

  it("a second bind is 409 already_bound, also for the same tree and for a rebind of the same tree", async () => {
    const w = world();
    expect((await w.call("POST", "/sync/bind", { tok: await token(), body: BIND })).status).toBe(200);
    expect(err(await w.call("POST", "/sync/bind", { tok: await token(), body: BIND }))).toEqual({ status: 409, error: "already_bound" });
    expect(err(await w.call("POST", "/sync/bind", { tok: await token(), body: { ...BIND, dbid: "db-synthetic-2" } }))).toEqual({ status: 409, error: "already_bound" });
    expect(err(await w.call("POST", "/sync/bind", { tok: await token(), body: { ...BIND, rebind: true } }))).toEqual({ status: 409, error: "already_bound" });
  });

  it("a rebind needs a fresh step-up (403 step_up_required) and keeps the tree_id", async () => {
    const w = world({ uuid: ids() });
    const first = (await w.call("POST", "/sync/bind", { tok: await token(), body: BIND })).body.tree_id;
    const other = { dbid: "db-synthetic-2", fingerprint: "fp-fedcba9876543210", tree_name_sha256: "b".repeat(64), rebind: true };
    for (const o of [{ claims: { auth_time: nowS - 301 } }, { claims: { amr: ["passkey"] } }, { claims: { auth_time: 0 } }, { claims: { amr: undefined, auth_time: undefined } }]) {
      const r = await w.call("POST", "/sync/bind", { tok: await token(OWNER, o), body: other });
      expect(err(r), JSON.stringify(o)).toEqual({ status: 403, error: "step_up_required" });
      expect(r.body.details).toMatchObject({ reason: "rebind", max_age_seconds: 300 });
    }
    expect(w.head().bound.dbid).toBe(BIND.dbid); // nothing changed
    const ok = await w.call("POST", "/sync/bind", { tok: await token(), body: other });
    expect([ok.status, ok.body.tree_id]).toEqual([200, first]);
    expect(w.head()).toMatchObject({ tree_id: first, bound: { dbid: "db-synthetic-2", fingerprint: "fp-fedcba9876543210" } });
    const audits = w.ddb.all().filter((x) => x.PK === "AUDIT#sync:bind");
    expect(audits.map((a) => a.after.rebind).sort()).toEqual([false, true]);
  });

  it("rebind:true on an unbound store is a plain first bind (no step-up needed)", async () => {
    const w = world();
    const r = await w.call("POST", "/sync/bind", { tok: await token(OWNER, { claims: { amr: ["passkey"] } }), body: { ...BIND, rebind: true } });
    expect(r.status).toBe(200);
  });

  it("two racing first binds: exactly one wins, the other is 409 already_bound", async () => {
    const w = world();
    const t = await token();
    const rs = await Promise.all([w.call("POST", "/sync/bind", { tok: t, body: BIND }), w.call("POST", "/sync/bind", { tok: t, body: { ...BIND, dbid: "db-synthetic-2" } })]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(w.ddb.all().filter((x) => x.PK === "AUDIT#sync:bind")).toHaveLength(1);
  });

  it("validates the body (400 validation with the field) and the content type (415)", async () => {
    const w = world();
    const t = await token();
    for (const [field, body] of [["dbid", { ...BIND, dbid: "has space" }], ["dbid", { ...BIND, dbid: undefined }], ["fingerprint", { ...BIND, fingerprint: "x" }], ["tree_name_sha256", { ...BIND, tree_name_sha256: "A".repeat(64) }], ["tree_name_sha256", { ...BIND, tree_name_sha256: 5 }], ["rebind", { ...BIND, rebind: "yes" }]]) {
      const r = await w.call("POST", "/sync/bind", { tok: t, body });
      expect(err(r), field).toEqual({ status: 400, error: "validation" });
      expect(r.body.details.fields[0].field).toBe(field);
    }
    expect((await w.call("POST", "/sync/bind", { tok: t, body: BIND, ct: "text/plain" })).status).toBe(415);
    expect(w.head()).toBeUndefined();
  });

  it("non-owners and the paused store are refused: 403 not_owner, 503 sync_paused", async () => {
    const w = world();
    expect(err(await w.call("POST", "/sync/bind", { tok: await token(OTHER), body: BIND }))).toEqual({ status: 403, error: "not_owner" });
    const p = world({ head: { seq: 1, writes_enabled: false } });
    expect(err(await p.call("POST", "/sync/bind", { tok: await token(), body: BIND }))).toEqual({ status: 503, error: "sync_paused" });
    expect(p.head().bound).toBeUndefined();
  });

  it("the handshake runs on bind too", async () => {
    const w = world();
    expect(err(await w.call("POST", "/sync/bind", { tok: await token(), body: BIND, hs: { ...HS, "x-hfy-sync-client": "hfy_sync/0.0.1" } }))).toEqual({ status: 426, error: "upgrade_required" });
  });

  it("a body over 2 MiB is 413 batch_too_large before it is parsed", async () => {
    const w = world();
    const r = await w.call("POST", "/sync/bind", { tok: await token(), body: { ...BIND, pad: "x".repeat(2_100_000) } });
    expect(err(r)).toEqual({ status: 413, error: "batch_too_large" });
  });
});

describe("tree check for the routes added on this middleware", () => {
  const actor = { id: OWNER, sync: { owner: true, stepUp: () => true } };
  const ctxOf = (head, tree) => {
    const ddb = { send: async () => ({ Item: head }) };
    return syncContext({ ctx: { ddb, cmds, table: TABLE }, event: { headers: { ...HS, ...(tree ? { "x-hfy-tree-id": tree } : {}) } }, actor, route: { write: false } });
  };

  it("checkTree() is 403 tree_mismatch for another or a missing tree id, and passes for the bound tree or an unbound store", async () => {
    expect((await ctxOf({ tree_id: "t1" }, "t1")).checkTree()).toBeUndefined();
    expect((await ctxOf(undefined, "anything")).checkTree()).toBeUndefined();
    expect((await ctxOf({}, undefined)).checkTree()).toBeUndefined();
    for (const tree of ["t2", undefined]) {
      const s = await ctxOf({ tree_id: "t1" }, tree);
      let e;
      try { s.checkTree(); } catch (x) { e = x; }
      expect([e?.status, e?.code]).toEqual([403, "tree_mismatch"]);
    }
  });
});
