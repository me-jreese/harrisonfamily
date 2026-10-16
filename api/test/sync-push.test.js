// HFY-TSK-173 (sync-push-routes): /api/sync/sessions, /complete, /abort, /batches and /media/presign on the sync-bearer middleware.
// In-memory DynamoDB fake, a local JWKS, a fake S3, synthetic objects and subjects only. Cloud catalog rows S01-S08 and S20 are covered by
// name below; S19 (privacy-expunge) and S21 (the render schedule) have no push-side behaviour. S22 (mass deletes) touches push only through the
// destructive budget and the step-up that a desktop delete needs: "S22: a delete-heavy desktop batch" below covers that; the daily reconcile
// and the withdraw-driven deletes are not push routes.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SignJWT, importPKCS8 } from "jose";
import { createHash } from "node:crypto";
import { makeApi, pem, ISSUER } from "./world.js";
import { buildCaps } from "../src/routes.js";
import { createGroupResolver } from "../src/policy.js";
import { SYNC_AUDIENCE, SYNC_CLIENT_ID, createSyncAuthenticator } from "../src/sync/auth.js";
import { createHookRegistry } from "../src/sync/hooks.js";
import { headKey, seqKey, uploadKey } from "../src/sync/store.js";
import { sessionState } from "../src/sync/push.js";
import { blobDescriptor, finalKey, stagingKey } from "../src/sync/media.js";

const OWNER = "I9001";
const OTHER = "I9002";
const NOW = Date.parse("2026-10-14T12:00:00Z");
const nowS = Math.floor(NOW / 1000);
const GROUPS = { version: 1, groups: { "gramps-owner": { subjects: [OWNER] }, "hfy-admin": { subjects: ["I0099"] } } };
const key = await importPKCS8(pem, "RS256");
const HS = { "x-hfy-sync-client": "hfy_sync/0.1.0", "x-hfy-gramps-version": "6.0.6", "x-hfy-gramps-schema": "21", "x-hfy-redaction-version": "1" };
const TREE = "00000000-0000-4000-8000-000000000001";
const BOUND = { dbid: "db-synthetic-1", fingerprint: "fp-0123456789abcdef", tree_name_sha256: "a".repeat(64), bound_at: "2026-10-13T00:00:00.000Z", by: OWNER };
const DAY = 86_400_000;

const token = (o = {}) =>
  new SignJWT({ client_id: SYNC_CLIENT_ID, token_use: "access", amr: ["passkey", "mfa"], auth_time: o.authTime ?? nowS - 10, groups: [] })
    .setProtectedHeader({ alg: "RS256", kid: "hfy-session-1" })
    .setSubject(o.sub ?? OWNER).setIssuer(ISSUER).setAudience(SYNC_AUDIENCE).setIssuedAt(nowS - 5).setExpirationTime(nowS + 600).sign(key);

let envBefore;
beforeEach(() => { envBefore = process.env.SYNC_API_ENABLED; process.env.SYNC_API_ENABLED = "1"; });
afterEach(() => { if (envBefore === undefined) delete process.env.SYNC_API_ENABLED; else process.env.SYNC_API_ENABLED = envBefore; });

// ---- synthetic Gramps objects (schema-valid) ---------------------------------------------------------------------------
const h = (n) => n.toString(16).padStart(28, "0");
const person = (n, extra = {}) => ({
  _class: "Person", handle: h(n), gramps_id: `I${String(n).padStart(4, "0")}`, private: false, gender: 1,
  primary_name: { _class: "Name", first_name: "Alder", surname_list: [{ _class: "Surname", primary: true, surname: "Testwood" }], type: { _class: "NameType", string: "", value: 2 }, date: { _class: "Date", calendar: 0, dateval: [0, 0, 0, false], format: null, modifier: 0, newyear: 0, quality: 0, sortval: 0, text: "" } },
  event_ref_list: [], birth_ref_index: -1, death_ref_index: -1, family_list: [], parent_family_list: [], note_list: [], media_list: [], urls: [], ...extra,
});
const family = (n, extra = {}) => ({ _class: "Family", handle: h(1000 + n), gramps_id: `F${String(n).padStart(4, "0")}`, private: false, father_handle: null, mother_handle: null, child_ref_list: [], event_ref_list: [], note_list: [], ...extra });
const note = (n, extra = {}) => ({ _class: "Note", handle: h(2000 + n), gramps_id: `N${String(n).padStart(4, "0")}`, private: false, text: { _class: "StyledText", string: `Synthetic note ${n}`, tags: [] }, ...extra });
const media = (n, extra = {}) => ({ _class: "Media", handle: h(4000 + n), gramps_id: `O${String(n).padStart(4, "0")}`, private: false, path: "a.jpg", mime: "image/jpeg", ...extra });
const create = (obj, extra = {}) => ({ op: "create", class: obj._class, handle: obj.handle, base_version: null, obj, ...extra });
const update = (obj, base, extra = {}) => ({ op: "update", class: obj._class, handle: obj.handle, base_version: base, obj, ...extra });
const del = (cls, handle, base) => ({ op: "delete", class: cls, handle, base_version: base });

// ---- a fake S3 for the blob path -----------------------------------------------------------------------------------
const sha = (bytes, alg) => createHash(alg).update(bytes).digest();
function blobS3() {
  const objects = new Map();
  const log = [];
  const failing = new Set();
  const status = (name, code) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: code } });
  return {
    objects, log,
    failNext: (cmd) => failing.add(cmd),
    async send(cmd) {
      const name = cmd.constructor.name;
      const i = cmd.input;
      log.push({ name, ...i });
      if (failing.delete(name)) throw status("InternalError", 500);
      if (name === "HeadObjectCommand") {
        const o = objects.get(i.Key);
        if (!o) throw status("NotFound", 404);
        return { ContentLength: o.bytes.length, ContentType: o.contentType, ...(i.ChecksumMode === "ENABLED" ? { ChecksumSHA256: sha(o.bytes, "sha256").toString("base64") } : {}) };
      }
      if (name === "CopyObjectCommand") {
        const from = i.CopySource.slice(i.Bucket.length + 1);
        const o = objects.get(from);
        if (!o) throw status("NoSuchKey", 404);
        objects.set(i.Key, { ...o });
        return { CopyObjectResult: { ChecksumSHA256: sha(o.bytes, "sha256").toString("base64") } };
      }
      if (name === "DeleteObjectCommand") {
        objects.delete(i.Key);
        return {};
      }
      throw new Error(`fake s3: unsupported ${name}`);
    },
    names: () => log.map((l) => l.name),
  };
}

function world({ head, groups = GROUPS, s3 = blobS3() } = {}) {
  let auth;
  const hooks = createHookRegistry();
  const presigned = [];
  const w = makeApi({
    clock: () => NOW,
    extraDeps: {
      authenticateSync: (e) => auth(e), s3, syncHooks: hooks, txnOpts: { sleep: async () => {} },
      presignPut: async (a) => { presigned.push(a); return `https://presign.test/${a.bucket}/${a.key}?sig=x`; },
    },
  });
  const getGroups = createGroupResolver({ load: async () => groups, log: { error() {} } });
  auth = createSyncAuthenticator({ getJwks: async () => w.jwks, getGroups, now: () => NOW, log: { warn() {}, error() {} } });
  const headRow = head === null ? undefined : { ...headKey(), seq: 0, seeded: true, writes_enabled: true, merges_enabled: false, tree_id: TREE, bound: BOUND, live_heads: 1000, ...(head ?? {}) };
  if (headRow) w.ddb.rows.set("SYNC#HEAD\u0000META", headRow);
  let k = 0;
  const call = async (method, path, { tok, headers = {}, body, hs = HS, tree = TREE, idem, ...rest } = {}) => {
    const t = tok === undefined ? await token() : tok;
    return w.call(method, `/api${path}`, {
      headers: { ...hs, ...(tree ? { "x-hfy-tree-id": tree } : {}), ...(t ? { authorization: `Bearer ${t}` } : {}), ...(idem ? { "idempotency-key": idem } : {}), ...headers },
      ...(body !== undefined ? { body } : {}), ...rest,
    });
  };
  const push = (ops, o = {}) => call("POST", "/sync/batches", { idem: o.idem ?? `k-${++k}`, body: { ops, ...(o.session ? { session_id: o.session } : {}), ...(o.body ?? {}) }, ...(o.call ?? {}) });
  const open = (expected, o = {}) => call("POST", "/sync/sessions", { body: expected ? { expected } : {}, ...o });
  const row = (pk, sk = "META") => w.ddb.rows.get(`${pk}\u0000${sk}`);
  const rows = (prefix) => w.ddb.all().filter((r) => r.PK.startsWith(prefix));
  const logRows = () => rows("SYNC#LOG").sort((a, b) => a.seq - b.seq);
  const headNow = () => row("SYNC#HEAD");
  return { ...w, call, push, open, row, rows, logRows, headNow, hooks, presigned, s3 };
}
const err = (r) => ({ status: r.status, error: r.body?.error });
const noStaleWrites = (w) => expect(w.rows("REC#")).toHaveLength(0);

describe("the routes exist on the sync-bearer middleware with caps.json (AC1)", () => {
  it("caps.json lists sessions, complete, abort, batches and media presign as sync-bearer routes behind SYNC_API_ENABLED", () => {
    const sync = buildCaps().actions.filter((a) => a.path.startsWith("/api/sync/") && a.name !== "sync.admin.status");
    const by = Object.fromEntries(sync.map((a) => [a.name, `${a.method} ${a.path}`]));
    expect(by).toMatchObject({
      "sync.sessions.open": "POST /api/sync/sessions", "sync.sessions.complete": "POST /api/sync/sessions/:id/complete", "sync.sessions.abort": "POST /api/sync/sessions/:id/abort",
      "sync.batches": "POST /api/sync/batches", "sync.media.presign": "POST /api/sync/media/presign",
    });
    for (const a of sync) expect(a).toMatchObject({ auth: "sync-bearer", gate: { switch: "SYNC_API_ENABLED" } });
    expect(sync.filter((a) => a.write).map((a) => a.name)).toEqual(expect.arrayContaining(["sync.sessions.open", "sync.sessions.complete", "sync.sessions.abort", "sync.batches", "sync.media.presign"]));
    expect(buildCaps().mcp.tools.map((t) => t.action).filter((n) => n.startsWith("sync."))).toEqual([]); // no MCP tool
  });

  const ROUTES = [
    ["POST", "/sync/sessions", {}], ["POST", "/sync/sessions/01J00000000000000000000000/complete", {}], ["POST", "/sync/sessions/01J00000000000000000000000/abort", {}],
    ["POST", "/sync/batches", { ops: [] }], ["POST", "/sync/media/presign", {}],
  ];
  it("S01: no token, a garbage token or a web token is 401 with a challenge, on every push route", async () => {
    const w = world();
    for (const [m, p, body] of ROUTES) {
      for (const tok of ["", "garbage"]) {
        const r = await w.call(m, p, { tok, body });
        expect(err(r), `${p} ${tok}`).toEqual({ status: 401, error: "unauthenticated" });
        expect(r.headers["www-authenticate"]).toMatch(/^Bearer realm=/);
      }
    }
  });
  it("S02: a subject outside gramps-owner is 403 not_owner, and an unreadable groups.json fails closed", async () => {
    const w = world();
    for (const [m, p, body] of ROUTES) expect(err(await w.call(m, p, { tok: await token({ sub: OTHER }), body })), p).toEqual({ status: 403, error: "not_owner" });
    expect(err(await w.call("POST", "/sync/sessions", { tok: await token({ sub: "I0099" }), body: {} }))).toEqual({ status: 403, error: "not_owner" }); // hfy-admin is not gramps-owner
    const closed = world({ groups: {} });
    expect(err(await closed.open())).toEqual({ status: 403, error: "not_owner" });
    expect(closed.rows("SYNC#SESSION#")).toHaveLength(0);
  });
  it("S03: SYNC_API_ENABLED off is 404 not_enabled; writes_enabled false is 503 sync_paused on every push route, and nothing is written", async () => {
    const w = world({ head: { writes_enabled: false } });
    for (const [m, p, body] of ROUTES) expect(err(await w.call(m, p, { body, idem: "k" })), p).toEqual({ status: 503, error: "sync_paused" });
    expect(w.rows("SYNC#SESSION#")).toHaveLength(0);
    expect(w.rows("SYNC#LOG")).toHaveLength(0);
    process.env.SYNC_API_ENABLED = "0";
    for (const [m, p, body] of ROUTES) expect(err(await w.call(m, p, { body })), p).toEqual({ status: 404, error: "not_enabled" });
  });
  it("S04: an old client or an unsupported schema is 426 and a redaction mismatch is 409, before anything is written", async () => {
    const w = world();
    expect(err(await w.push([create(person(1))], { call: { hs: { ...HS, "x-hfy-sync-client": "hfy_sync/0.0.1" } } }))).toEqual({ status: 426, error: "upgrade_required" });
    expect(err(await w.push([create(person(1))], { call: { hs: { ...HS, "x-hfy-gramps-schema": "22" } } }))).toEqual({ status: 426, error: "upgrade_required" });
    expect(err(await w.open(undefined, { hs: { ...HS, "x-hfy-redaction-version": "2" } }))).toEqual({ status: 409, error: "redaction_version_mismatch" });
    noStaleWrites(w);
    expect(w.rows("SYNC#SESSION#")).toHaveLength(0);
  });
  it("a body over 2 MiB is 413 batch_too_large before the batch is read", async () => {
    const w = world();
    const r = await w.call("POST", "/sync/batches", { idem: "k", body: { ops: [], pad: "x".repeat(2_100_000) } });
    expect(err(r)).toEqual({ status: 413, error: "batch_too_large" });
  });
});

describe("POST /api/sync/batches: desktop batches through applyBatch (AC2)", () => {
  it("writes the head, the log and the receipt with origin desktop and answers {batch_id, seq_from, seq_to, results}", async () => {
    const w = world();
    const p = person(1);
    const r = await w.push([create(p), create(note(1))]);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ seq_from: 1, seq_to: 2, results: [{ op_id: "1", class: "Person", handle: p.handle, version: 1, seq: 1, gramps_id: "I0001" }, { op_id: "2", class: "Note", version: 1, seq: 2 }] });
    expect(r.body.batch_id).toMatch(/^[a-z2-7]{26}$/);
    expect(r.headers["idempotent-replayed"]).toBeUndefined();
    expect(w.row(`REC#Person#${p.handle}`, "HEAD")).toMatchObject({ version: 1, origin: "desktop", updated_by: OWNER });
    expect(w.logRows().map((l) => [l.seq, l.op, l.origin])).toEqual([[1, "create", "desktop"], [2, "create", "desktop"]]);
    expect(w.row(`SYNC#BATCH#${r.body.batch_id}`)).toMatchObject({ seq_from: 1, seq_to: 2, client: { agent: "hfy_sync/0.1.0" } });
    expect(w.rows("AUDIT#records:")).toHaveLength(1);
    expect(w.rows("AUDIT#records:")[0]).toMatchObject({ PK: `AUDIT#records:${r.body.batch_id}`, op: "records.batch", principal: OWNER });
    expect(w.headNow()).toMatchObject({ seq: 2, live_heads: 1002 });
  });

  it("produces no notification in the request: no push is sent and no inbox or follower row is touched", async () => {
    const w = world();
    await w.push([create(person(1))]);
    const r = await w.push([update(person(1, { gender: 2 }), 1)]);
    expect(r.status).toBe(200);
    expect(w.sent).toEqual([]);
    // only the store's own items were written: no inbox, follower, subscription or render-outbox row
    const prefixes = new Set(w.ddb.all().map((x) => x.PK.split("#")[0] + (x.PK.startsWith("SYNC#") ? `#${x.PK.split("#")[1]}` : "")));
    expect([...prefixes].sort()).toEqual(["AUDIT", "GID", "REC", "SYNC#BATCH", "SYNC#HEAD", "SYNC#LOG"]);
  });

  it("fires the afterCommit hook exactly once per committed batch, with origin desktop, and never for a replay or a refused batch", async () => {
    const w = world();
    const calls = [];
    w.hooks.registerAfterCommit((info) => calls.push(info));
    const first = await w.push([create(person(1))], { idem: "once" });
    expect(calls).toEqual([{ batch_id: first.body.batch_id, origin: "desktop", seq_from: 1, seq_to: 1 }]);
    const replay = await w.push([create(person(1))], { idem: "once" });
    expect([replay.status, replay.headers["idempotent-replayed"]]).toEqual([200, "true"]);
    expect(replay.body).toEqual(first.body);
    expect(calls).toHaveLength(1);
    expect(err(await w.push([update(person(1), 7)]))).toEqual({ status: 409, error: "version_conflict" });
    expect(err(await w.push([create(person(2, { urls: [{ _class: "Url", path: "mailto:someone@example.org", desc: "", private: false, type: { _class: "UrlType", string: "", value: 1 } }] }))]))).toEqual({ status: 422, error: "privacy_violation" });
    expect(calls).toHaveLength(1);
    await w.push([create(person(3))], { idem: "second" });
    expect(calls.map((c) => c.seq_from)).toEqual([1, 2]);
  });

  it("a failing afterCommit hook does not fail the committed batch", async () => {
    const w = world();
    w.hooks.registerAfterCommit(() => { throw new Error("boom"); });
    expect((await w.push([create(person(1))])).status).toBe(200);
    expect(w.logRows()).toHaveLength(1);
  });

  it("S06: a stale base_version is 409 version_conflict with the current version and object per op; a create over a live object is 409 exists", async () => {
    const w = world();
    await w.push([create(person(1))]);
    const stale = await w.push([update(person(1, { gender: 2 }), 5)]);
    expect(err(stale)).toEqual({ status: 409, error: "version_conflict" });
    expect(stale.body.details.conflicts[0]).toMatchObject({ op_id: "1", class: "Person", reason: "version_mismatch", current_version: 1 });
    expect(stale.body.details.conflicts[0].current.gramps_id).toBe("I0001");
    expect(err(await w.push([create(person(1))]))).toEqual({ status: 409, error: "exists" });
    expect(err(await w.push([create(person(9, { gramps_id: "I0001" }))]))).toMatchObject({ status: 409 }); // gramps_id_taken or gid_conflict
  });

  it("S06: the same Idempotency-Key with another body is 422 idempotency_key_reused; no key is 428 idempotency_key_required", async () => {
    const w = world();
    await w.push([create(person(1))], { idem: "same" });
    expect(err(await w.push([create(person(2))], { idem: "same" }))).toEqual({ status: 422, error: "idempotency_key_reused" });
    expect(err(await w.call("POST", "/sync/batches", { body: { ops: [create(person(2))] } }))).toEqual({ status: 428, error: "idempotency_key_required" });
    expect(err(await w.call("POST", "/sync/batches", { idem: "   ", body: { ops: [create(person(2))] } }))).toEqual({ status: 428, error: "idempotency_key_required" });
    expect(w.logRows()).toHaveLength(1);
  });

  it("S05: an invalid op is 400 or 422 with pointers and nothing is written; the batch is atomic", async () => {
    const w = world();
    expect(err(await w.push([create(person(1)), { op: "create", class: "Person", handle: h(2), base_version: null, obj: { _class: "Person", handle: h(2) } }]))).toMatchObject({ status: 400 });
    expect(err(await w.push([{ op: "create", class: "Nonsense", handle: h(2), base_version: null, obj: {} }]))).toEqual({ status: 422, error: "unknown_class" });
    expect(err(await w.push("not-an-array"))).toEqual({ status: 400, error: "validation" });
    expect(err(await w.push(Array.from({ length: 25 }, (_, i) => create(person(i + 1)))))).toEqual({ status: 413, error: "batch_too_large" });
    expect(err(await w.push([create(person(1, { family_list: [h(1001)] }))]))).toEqual({ status: 422, error: "integrity_violation" });
    noStaleWrites(w);
    expect(w.logRows()).toHaveLength(0);
  });

  it("tree_id: a body naming another tree or a missing X-HFY-Tree-Id header is 403 tree_mismatch", async () => {
    const w = world();
    expect(err(await w.push([create(person(1))], { body: { tree_id: "00000000-0000-4000-8000-0000000000ff" } }))).toEqual({ status: 403, error: "tree_mismatch" });
    expect(err(await w.push([create(person(1))], { call: { tree: null } }))).toEqual({ status: 403, error: "tree_mismatch" });
    expect((await w.push([create(person(1))], { body: { tree_id: TREE } })).status).toBe(200);
  });

  it("deletes need a fresh step-up from the desktop, and a delete with one tombstones the object", async () => {
    const w = world();
    await w.push([create(person(1))]);
    const stale = await token({ authTime: nowS - 4000 });
    const refused = await w.push([del("Person", h(1), 1)], { call: { tok: stale } });
    expect(err(refused)).toEqual({ status: 403, error: "step_up_required" });
    expect(refused.body.details).toMatchObject({ reason: "delete" });
    expect(w.row(`REC#Person#${h(1)}`, "HEAD").deleted).toBe(false);
    const done = await w.push([del("Person", h(1), 1)]);
    expect(done.status).toBe(200);
    expect(w.row(`REC#Person#${h(1)}`, "HEAD")).toMatchObject({ deleted: true, version: 2 });
  });

  it("S22: a delete-heavy desktop batch needs the step-up (stale auth is 403 step_up_required, nothing written); with it the deletes commit and count against the budget", async () => {
    const w = world();
    const people = Array.from({ length: 12 }, (_, i) => person(i + 1));
    await w.push(people.map((p) => create(p)));
    const dels = people.map((p) => del("Person", p.handle, 1));
    const stale = await token({ authTime: nowS - 4000 });
    const refused = await w.push(dels, { call: { tok: stale } });
    expect(err(refused)).toEqual({ status: 403, error: "step_up_required" });
    expect(refused.body.details).toMatchObject({ reason: "delete" });
    expect(w.rows("REC#Person#").every((r) => r.SK !== "HEAD" || r.deleted === false)).toBe(true);
    expect(w.rows("SYNC#BUDGET")).toHaveLength(0);
    expect((await w.push(dels)).status).toBe(200); // fresh step-up: the route does not bypass it, and does not need a second one
    expect(w.rows("SYNC#BUDGET").reduce((n, r) => n + r.count, 0)).toBe(12);
  });

  it("S08: a throttled store read is 503 retryable, nothing is written, and the retry with the same key commits once", async () => {
    const t = await throttled();
    expect(t.first.status).toBe(503);
    expect(t.first.body.error).toBe("retryable");
    expect(t.logAfterFirst).toBe(0);
    expect(t.second.status).toBe(200);
    expect(t.logAfterSecond).toBe(1);
  });

  it("S07 and S20: a lost seq race is retried inside the request; the retry uses a new ClientRequestToken and the same Idempotency-Key", async () => {
    const holder = {};
    let raced = false;
    const w = makeWorld({ intercept: async (cmd) => {
      if (!raced && cmd.constructor.name === "TransactWriteCommand") {
        raced = true;
        const row = holder.w.ddb.rows.get("SYNC#HEAD\u0000META");
        row.seq += 1; // another writer took seq 1 between the read and the commit
      }
    } });
    holder.w = w;
    const r = await w.push([create(person(1))], { idem: "race" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ seq_from: 2, seq_to: 2 });
    const tokens = w.ddb.tokens.filter(Boolean);
    expect(tokens).toHaveLength(2);
    expect(new Set(tokens).size).toBe(2);
    expect(w.logRows()).toHaveLength(1);
  });
});

/** A world whose DynamoDB fake is wrapped by `intercept` (makeApi's hook), with the same helpers as world(). */
function makeWorld({ intercept } = {}) {
  let auth;
  const w = makeApi({ clock: () => NOW, intercept, extraDeps: { authenticateSync: (e) => auth(e), txnOpts: { sleep: async () => {} } } });
  auth = createSyncAuthenticator({ getJwks: async () => w.jwks, getGroups: createGroupResolver({ load: async () => GROUPS, log: { error() {} } }), now: () => NOW, log: { warn() {}, error() {} } });
  w.ddb.rows.set("SYNC#HEAD\u0000META", { ...headKey(), seq: 0, seeded: true, writes_enabled: true, tree_id: TREE, bound: BOUND, live_heads: 1000 });
  const call = async (method, path, { idem, body } = {}) => w.call(method, `/api${path}`, { headers: { ...HS, "x-hfy-tree-id": TREE, authorization: `Bearer ${await token()}`, ...(idem ? { "idempotency-key": idem } : {}) }, ...(body !== undefined ? { body } : {}) });
  return { ...w, push: (ops, o = {}) => call("POST", "/sync/batches", { idem: o.idem, body: { ops } }), logRows: () => w.ddb.all().filter((r) => r.PK === "SYNC#LOG") };
}
async function throttled() {
  let throttle = 1;
  const w = makeWorld({ intercept: async (cmd) => { if (throttle > 0 && cmd.constructor.name === "GetCommand" && cmd.input.Key.PK.startsWith("SYNC#BATCH#")) { throttle -= 1; throw Object.assign(new Error("slow down"), { name: "ThrottlingException" }); } } });
  const first = await w.push([create(person(1))], { idem: "retry" });
  const logAfterFirst = w.logRows().length;
  const second = await w.push([create(person(1))], { idem: "retry" });
  return { first, second, logAfterFirst, logAfterSecond: w.logRows().length };
}

describe("push sessions (AC2, AC3)", () => {
  it("opens a session: 201 {session_id, expires_at, seed}, the item, SYNC#HEAD.open_session and an audit item", async () => {
    const w = world();
    const r = await w.open([`Person#${h(1)}`, `Family#${h(1001)}`]);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ seed: false });
    expect(r.body.session_id).toMatch(/^[0-9A-Z]{26}$/);
    expect(r.body.expires_at).toBe(new Date(NOW + 7 * DAY).toISOString());
    expect(w.row(`SYNC#SESSION#${r.body.session_id}`)).toMatchObject({ state: "open", seed: false, expected: [`Person#${h(1)}`, `Family#${h(1001)}`], opened_at: new Date(NOW).toISOString(), start_seq: 0, principal: OWNER, ttl: nowS + 7 * 86400 });
    expect(w.headNow().open_session).toBe(r.body.session_id);
    expect(w.rows("AUDIT#sync:session:")[0]).toMatchObject({ op: "sync.session.open", principal: OWNER });
  });

  it("the first session after bind (the store is not seeded) is SYNC#SESSION.seed=true", async () => {
    const w = world({ head: { seeded: false } });
    const r = await w.open();
    expect(r.body.seed).toBe(true);
    expect(w.row(`SYNC#SESSION#${r.body.session_id}`).seed).toBe(true);
  });

  it("D48: a second open while one is open is 409 session_open naming it; abort closes it and a new open then succeeds", async () => {
    const w = world();
    const a = await w.open();
    const dup = await w.open();
    expect(err(dup)).toEqual({ status: 409, error: "session_open" });
    expect(dup.body.details).toMatchObject({ session_id: a.body.session_id, seed: false, expires_at: a.body.expires_at });
    const ab = await w.call("POST", `/sync/sessions/${a.body.session_id}/abort`, {});
    expect([ab.status, ab.body]).toEqual([200, { session_id: a.body.session_id, state: "aborted" }]);
    expect(w.row(`SYNC#SESSION#${a.body.session_id}`)).toMatchObject({ state: "aborted", aborted_at: new Date(NOW).toISOString(), aborted_by: OWNER });
    expect(w.headNow().open_session).toBeUndefined();
    expect(w.rows("AUDIT#sync:session:").map((x) => x.op).sort()).toEqual(["sync.session.abort", "sync.session.open"]);
    // the audit names the opener (before) and the aborting principal, so a cross-check is possible even though any owner may abort
    expect(w.rows("AUDIT#sync:session:").find((x) => x.op === "sync.session.abort")).toMatchObject({ principal: OWNER, before: { state: "open", opened_by: OWNER }, after: { state: "aborted" } });
    const b = await w.open();
    expect(b.status).toBe(201);
    expect(b.body.session_id).not.toBe(a.body.session_id);
    // abort is idempotent and a batch into the aborted session is refused
    expect((await w.call("POST", `/sync/sessions/${a.body.session_id}/abort`, {})).status).toBe(200);
    const into = await w.push([create(person(1))], { session: a.body.session_id });
    expect(err(into)).toEqual({ status: 409, error: "session_closed" });
    expect(w.logRows()).toHaveLength(0);
  });

  it("the server treats opened_at + 7 d < now as expired without waiting for the TTL delete: a new open replaces it, a batch into it is refused, abort still works", async () => {
    const w = world();
    const a = await w.open();
    const item = w.row(`SYNC#SESSION#${a.body.session_id}`);
    expect(sessionState(item, NOW + 7 * DAY - 1)).toBe("open");
    expect(sessionState(item, NOW + 7 * DAY)).toBe("expired");
    item.opened_at = new Date(NOW - 7 * DAY - 1000).toISOString(); // older than 7 days, the item and its TTL row are still there
    const into = await w.push([create(person(1))], { session: a.body.session_id });
    expect(err(into)).toEqual({ status: 409, error: "session_expired" });
    const b = await w.open();
    expect(b.status).toBe(201);
    expect(w.headNow().open_session).toBe(b.body.session_id);
    expect((await w.call("POST", `/sync/sessions/${a.body.session_id}/abort`, {})).body.state).toBe("aborted");
    expect(w.headNow().open_session).toBe(b.body.session_id); // aborting the old one leaves the newer pointer alone
  });

  it("a head that points at a closed session does not block a new one (a crash between the marker and the head update)", async () => {
    const w = world();
    const a = await w.open();
    w.row(`SYNC#SESSION#${a.body.session_id}`).state = "complete";
    expect((await w.open()).status).toBe(201);
  });

  it("validates expected, needs a bound tree and the tree header", async () => {
    const w = world();
    for (const expected of ["x", [1], ["Nope#" + h(1)], ["Person#xyz"], [`Person#${h(1)}`, "Person"]]) expect(err(await w.call("POST", "/sync/sessions", { body: { expected } })), JSON.stringify(expected)).toEqual({ status: 400, error: "validation" });
    expect(err(await w.call("POST", "/sync/sessions", { body: { expected: Array.from({ length: 8001 }, (_, i) => `Person#${h(i + 1)}`) } }))).toEqual({ status: 413, error: "batch_too_large" });
    expect(err(await w.call("POST", "/sync/sessions", { body: {}, tree: "00000000-0000-4000-8000-0000000000ff" }))).toEqual({ status: 403, error: "tree_mismatch" });
    const unbound = world({ head: { tree_id: undefined, bound: undefined } });
    expect(err(await unbound.call("POST", "/sync/sessions", { body: {}, tree: null }))).toEqual({ status: 409, error: "not_bound" });
    expect(w.rows("SYNC#SESSION#")).toHaveLength(0);
  });

  it("abort and complete answer 404 session_not_found for an unknown or malformed id", async () => {
    const w = world();
    for (const id of ["01J00000000000000000000000", "short", "x".repeat(60)]) {
      expect(err(await w.call("POST", `/sync/sessions/${id}/abort`, {})), id).toEqual({ status: 404, error: "session_not_found" });
      expect(err(await w.call("POST", `/sync/sessions/${id}/complete`, {})), id).toEqual({ status: 404, error: "session_not_found" });
    }
    expect(err(await w.push([create(person(1))], { session: "01J00000000000000000000000" }))).toEqual({ status: 404, error: "session_not_found" });
  });

  it("a batch in a session resolves references to the announced handles; without the announcement it is a dangling reference", async () => {
    const w = world();
    const fam = family(1, { father_handle: h(1) });
    const p = person(1, { family_list: [fam.handle] });
    const s = await w.open([`Family#${fam.handle}`]);
    const ok = await w.push([create(p)], { session: s.body.session_id });
    expect(ok.status).toBe(200); // the family is announced, not yet written
    const w2 = world();
    expect(err(await w2.push([create(p)]))).toEqual({ status: 422, error: "integrity_violation" }); // no session: refused
  });

  it("D25: completing checks the whole session: a dangling reference, then a half-linked relationship, are 422 integrity_violation; the fix completes it", async () => {
    const w = world();
    const fam = family(1, { father_handle: h(1) });
    const p = person(1, { family_list: [fam.handle] });
    const s = await w.open([`Family#${fam.handle}`]);
    const id = s.body.session_id;
    await w.push([create(p)], { session: id });
    const dangling = await w.call("POST", `/sync/sessions/${id}/complete`, {});
    expect(err(dangling)).toEqual({ status: 422, error: "integrity_violation" });
    expect(dangling.body.details.violations).toEqual([{ rule: "integrity.unresolved_reference", class: "Person", handle: p.handle, pointer: "/family_list/0", op_id: "1" }]);
    expect(w.row(`SYNC#SESSION#${id}`).state).toBe("open");
    // the family arrives without the father link: a half-linked relationship is a hard violation at completion
    await w.push([create(family(1))], { session: id });
    const half = await w.call("POST", `/sync/sessions/${id}/complete`, {});
    expect(err(half)).toEqual({ status: 422, error: "integrity_violation" });
    expect(half.body.details.violations.map((v) => v.rule)).toEqual(["integrity.symmetry.spouse"]);
    // fix: the family names the father
    await w.push([update(fam, 1)], { session: id });
    const done = await w.call("POST", `/sync/sessions/${id}/complete`, {});
    expect(done.status).toBe(200);
    expect(done.body.seq).toBe(w.logRows().at(-1).seq);
    expect(w.logRows().at(-1)).toMatchObject({ op: "marker", reason: "session_complete", origin: "desktop" });
    expect(w.row(`SYNC#SESSION#${id}`).state).toBe("complete");
    expect(w.headNow().open_session).toBeUndefined();
    expect(w.headNow().seeded).toBe(true);
    // idempotent: the same seq, no second marker
    const again = await w.call("POST", `/sync/sessions/${id}/complete`, {});
    expect([again.status, again.body.seq]).toEqual([200, done.body.seq]);
    expect(w.logRows().filter((l) => l.op === "marker")).toHaveLength(1);
    // a new batch into a complete session is refused; a replay of a committed one is still answered
    expect(err(await w.push([create(note(1))], { session: id }))).toEqual({ status: 409, error: "session_closed" });
    expect((await w.call("POST", `/sync/sessions/${id}/abort`, {})).status).toBe(409);
  });

  it("an empty session completes with a marker; an aborted one cannot complete", async () => {
    const w = world();
    const a = await w.open();
    expect((await w.call("POST", `/sync/sessions/${a.body.session_id}/complete`, {})).status).toBe(200);
    const b = await w.open();
    await w.call("POST", `/sync/sessions/${b.body.session_id}/abort`, {});
    expect(err(await w.call("POST", `/sync/sessions/${b.body.session_id}/complete`, {}))).toEqual({ status: 409, error: "session_closed" });
  });

  it("a replay of a batch committed in a session is answered after the session closed; a different new batch is not", async () => {
    const w = world();
    const s = await w.open();
    const first = await w.push([create(person(1))], { session: s.body.session_id, idem: "in-session" });
    await w.call("POST", `/sync/sessions/${s.body.session_id}/complete`, {});
    const replay = await w.push([create(person(1))], { session: s.body.session_id, idem: "in-session" });
    expect([replay.status, replay.headers["idempotent-replayed"], replay.body]).toEqual([200, "true", first.body]);
  });
});

describe("the seed session is silent (AC2)", () => {
  it("an unseeded store refuses a desktop batch outside a session (503 store_not_seeded); the seed session's batches carry origin seed", async () => {
    const w = world({ head: { seeded: false } });
    expect(err(await w.push([create(person(1))]))).toEqual({ status: 503, error: "store_not_seeded" });
    const calls = [];
    w.hooks.registerAfterCommit((i) => calls.push(i.origin));
    const s = await w.open();
    expect(s.body.seed).toBe(true);
    const r = await w.push([create(person(1))], { session: s.body.session_id });
    expect(r.status).toBe(200);
    expect(w.logRows()[0].origin).toBe("seed");
    expect(w.row(`REC#Person#${h(1)}`, "HEAD").origin).toBe("seed");
    expect(calls).toEqual(["seed"]); // never "desktop": a consumer that notifies on desktop batches is silent for the seed
    expect(w.sent).toEqual([]);
    expect(w.headNow().seeded).toBe(false);
    const done = await w.call("POST", `/sync/sessions/${s.body.session_id}/complete`, {});
    expect(done.status).toBe(200);
    expect(w.logRows().at(-1)).toMatchObject({ op: "marker", origin: "seed" });
    expect(w.headNow()).toMatchObject({ seeded: true });
    expect(w.headNow().open_session).toBeUndefined();
    // after the seed the next session is an ordinary one and its batches are desktop
    const next = await w.open();
    expect(next.body.seed).toBe(false);
    await w.push([create(person(2))], { session: next.body.session_id });
    expect(w.logRows().at(-1).origin).toBe("desktop");
    expect((await w.push([create(person(3))])).status).toBe(200);
  });

  it("a delete inside the seed session still needs the step-up that a desktop delete needs", async () => {
    const w = world({ head: { seeded: false } });
    const s = await w.open();
    await w.push([create(person(1))], { session: s.body.session_id });
    const stale = await token({ authTime: nowS - 4000 });
    const r = await w.push([del("Person", h(1), 1)], { session: s.body.session_id, call: { tok: stale } });
    expect(err(r)).toEqual({ status: 403, error: "step_up_required" });
    expect((await w.push([del("Person", h(1), 1)], { session: s.body.session_id })).status).toBe(200);
  });
});

describe("media: staging, finalize and the orphaned key (AC4, fake S3)", () => {
  const BYTES = Buffer.from("synthetic-image-bytes-one");
  const BYTES2 = Buffer.from("synthetic-image-bytes-two-longer");
  const claimOf = (bytes, ct = "image/jpeg") => ({ sha256: sha(bytes, "sha256").toString("hex"), md5: sha(bytes, "md5").toString("hex"), size: bytes.length, content_type: ct });
  /** Presign (the route), then "upload" to the staging key as S3 would after checking the signed checksum. */
  async function upload(w, handle, bytes, ct = "image/jpeg") {
    const c = claimOf(bytes, ct);
    const r = await w.call("POST", "/sync/media/presign", { body: { handle, content_type: ct, size: c.size, sha256_b64: Buffer.from(c.sha256, "hex").toString("base64"), md5_hex: c.md5 } });
    expect(r.status).toBe(200);
    w.s3.objects.set(r.body.key, { bytes, contentType: ct });
    return { claim: c, presign: r.body };
  }

  it("presign: stages at media/.staging/<handle>/<sha256>, signs the checksum and records a pending upload (ttl +1 h)", async () => {
    const w = world();
    const m = media(1);
    const c = claimOf(BYTES);
    const b64 = Buffer.from(c.sha256, "hex").toString("base64");
    const r = await w.call("POST", "/sync/media/presign", { body: { handle: m.handle, content_type: "image/jpeg", size: c.size, sha256_b64: b64, md5_hex: c.md5 } });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ upload_url: `https://presign.test/harrisonfamily-frontend/media/.staging/${m.handle}/${c.sha256}?sig=x`, headers: { "Content-Type": "image/jpeg", "x-amz-checksum-sha256": b64 }, key: stagingKey(m.handle, c.sha256), expires_in: 300 });
    expect(w.presigned[0]).toEqual({ bucket: "harrisonfamily-frontend", key: stagingKey(m.handle, c.sha256), contentType: "image/jpeg", size: c.size, expiresIn: 300, checksumSha256: b64 });
    expect(w.row(uploadKey(m.handle, c.sha256).PK, c.sha256)).toMatchObject({ s3_key: stagingKey(m.handle, c.sha256), content_type: "image/jpeg", size: c.size, md5: c.md5, ttl: nowS + 3600 });
  });

  it("presign validates the handle, the type (jpeg, png, gif, tiff, pdf), the size (<= 25 MB) and both hashes", async () => {
    const w = world();
    const c = claimOf(BYTES);
    const ok = { handle: h(4001), content_type: "image/jpeg", size: c.size, sha256_b64: Buffer.from(c.sha256, "hex").toString("base64"), md5_hex: c.md5 };
    for (const [bad, field] of [[{ handle: "../person/index" }, "handle"], [{ handle: "ABC" }, "handle"], [{ content_type: "image/heic" }, "content_type"], [{ content_type: "image/webp" }, "content_type"], [{ content_type: "text/html" }, "content_type"], [{ size: 0 }, "size"], [{ size: 25 * 1024 * 1024 + 1 }, "size"], [{ size: 1.5 }, "size"], [{ sha256_b64: "abc" }, "sha256_b64"], [{ md5_hex: "XYZ" }, "md5_hex"]]) {
      const r = await w.call("POST", "/sync/media/presign", { body: { ...ok, ...bad } });
      expect(err(r), JSON.stringify(bad)).toEqual({ status: 400, error: "validation" });
      expect(r.body.details.fields[0].field).toBe(field);
    }
    for (const ct of ["image/png", "image/gif", "image/tiff", "application/pdf"]) expect((await w.call("POST", "/sync/media/presign", { body: { ...ok, content_type: ct } })).status).toBe(200);
    expect(w.presigned.every((p) => p.key.startsWith("media/.staging/"))).toBe(true);
    expect(err(await w.call("POST", "/sync/media/presign", { body: ok, tree: "00000000-0000-4000-8000-0000000000ff" }))).toEqual({ status: 403, error: "tree_mismatch" });
  });

  it("a Media op with a blob: the stored descriptor is server-built, the blob is copied into place with CopyObject and ChecksumAlgorithm, the staging object and the pending item go", async () => {
    const w = world();
    const m = media(1);
    const { claim } = await upload(w, m.handle, BYTES);
    const r = await w.push([create(m, { blob: { ...claim, s3_key: "person/index.json" } })]); // a client-sent key would be ignored; unknown fields are refused instead
    expect(err(r)).toEqual({ status: 400, error: "validation" });
    expect(w.s3.names()).not.toContain("CopyObjectCommand");
    const ok = await w.push([create(m, { blob: claim })]);
    expect(ok.status).toBe(200);
    const head = w.row(`REC#Media#${m.handle}`, "HEAD");
    expect(head.blob).toEqual({ s3_key: finalKey(m.handle, "image/jpeg"), sha256: claim.sha256, md5: claim.md5, size: claim.size, content_type: "image/jpeg", state: "present" });
    expect(head.blob.s3_key).toBe(`media/${m.handle}.jpg`);
    expect(w.s3.objects.get(`media/${m.handle}.jpg`).bytes).toEqual(BYTES);
    expect(w.s3.objects.has(stagingKey(m.handle, claim.sha256))).toBe(false);
    expect(w.rows("SYNC#UPLOAD#")).toHaveLength(0);
    const copy = w.s3.log.find((l) => l.name === "CopyObjectCommand");
    expect(copy).toMatchObject({ Bucket: "harrisonfamily-frontend", Key: `media/${m.handle}.jpg`, CopySource: `harrisonfamily-frontend/${stagingKey(m.handle, claim.sha256)}`, ChecksumAlgorithm: "SHA256" });
    expect(w.s3.log.find((l) => l.name === "HeadObjectCommand")).toMatchObject({ Key: stagingKey(m.handle, claim.sha256), ChecksumMode: "ENABLED" });
  });

  it("is refused before the commit when nothing was uploaded, the object differs, or the claim differs from the presign (nothing written, nothing copied)", async () => {
    const w = world();
    const m = media(1);
    const c = claimOf(BYTES);
    expect(err(await w.push([create(m, { blob: c })]))).toEqual({ status: 422, error: "blob_not_uploaded" }); // never presigned
    const { claim } = await upload(w, m.handle, BYTES);
    w.s3.objects.set(stagingKey(m.handle, claim.sha256), { bytes: Buffer.from("tampered-bytes-of-another-image"), contentType: "image/jpeg" });
    expect(err(await w.push([create(m, { blob: claim })]))).toEqual({ status: 422, error: "blob_mismatch" }); // the checksum is not the one claimed
    w.s3.objects.delete(stagingKey(m.handle, claim.sha256));
    expect(err(await w.push([create(m, { blob: claim })]))).toEqual({ status: 422, error: "blob_not_uploaded" }); // presigned but no object
    w.s3.objects.set(stagingKey(m.handle, claim.sha256), { bytes: BYTES, contentType: "image/jpeg" });
    expect(err(await w.push([create(m, { blob: { ...claim, size: claim.size + 1 } })]))).toEqual({ status: 422, error: "blob_mismatch" });
    expect(err(await w.push([create(m, { blob: { ...claim, content_type: "image/png" } })]))).toEqual({ status: 422, error: "blob_mismatch" });
    expect(w.rows("REC#")).toHaveLength(0);
    expect(w.s3.names()).not.toContain("CopyObjectCommand");
    expect(w.s3.objects.has(`media/${m.handle}.jpg`)).toBe(false);
  });

  it("a refused Media op (stale version, privacy) leaves the blob at its staging key only, never at the served key", async () => {
    const w = world();
    const m = media(1);
    await w.push([create(m)]);
    const { claim } = await upload(w, m.handle, BYTES);
    expect(err(await w.push([update(m, 9, { blob: claim })]))).toEqual({ status: 409, error: "version_conflict" });
    expect(w.s3.objects.has(stagingKey(m.handle, claim.sha256))).toBe(true);
    expect(w.s3.objects.has(`media/${m.handle}.jpg`)).toBe(false);
  });

  it("a pending upload past its ttl is refused (DynamoDB's TTL delete lags)", async () => {
    const w = world();
    const m = media(1);
    const { claim } = await upload(w, m.handle, BYTES);
    w.row(uploadKey(m.handle, claim.sha256).PK, claim.sha256).ttl = nowS - 1;
    expect(err(await w.push([create(m, { blob: claim })]))).toEqual({ status: 422, error: "blob_not_uploaded" });
  });

  it("finalize is idempotent: a failed copy is 503 retryable after the commit and the replay of the same key finishes it", async () => {
    const w = world();
    const m = media(1);
    const { claim } = await upload(w, m.handle, BYTES);
    w.s3.failNext("CopyObjectCommand");
    const first = await w.push([create(m, { blob: claim })], { idem: "blob-1" });
    expect(err(first)).toEqual({ status: 503, error: "retryable" });
    expect(w.logRows()).toHaveLength(1); // the Media op committed
    expect(w.s3.objects.has(`media/${m.handle}.jpg`)).toBe(false);
    expect(w.rows("SYNC#UPLOAD#")).toHaveLength(1); // the pending item is kept for the retry
    const second = await w.push([create(m, { blob: claim })], { idem: "blob-1" });
    expect([second.status, second.headers["idempotent-replayed"]]).toEqual([200, "true"]);
    expect(w.s3.objects.get(`media/${m.handle}.jpg`).bytes).toEqual(BYTES);
    expect(w.s3.objects.has(stagingKey(m.handle, claim.sha256))).toBe(false);
    expect(w.rows("SYNC#UPLOAD#")).toHaveLength(0);
    expect(w.logRows()).toHaveLength(1);
    // a third replay, with the staging object and the pending item gone, copies nothing and still answers
    const copies = w.s3.names().filter((n) => n === "CopyObjectCommand").length;
    expect((await w.push([create(m, { blob: claim })], { idem: "blob-1" })).status).toBe(200);
    expect(w.s3.names().filter((n) => n === "CopyObjectCommand").length).toBe(copies);
  });

  it("a replay of a held-blob update over a present blob is the same request: 200 replayed, not 422 idempotency_key_reused", async () => {
    const w = world();
    const m = media(1);
    const a = await upload(w, m.handle, BYTES);
    await w.push([create(m, { blob: a.claim })]);
    const before = structuredClone(w.row(`REC#Media#${m.handle}`, "HEAD").blob);
    const ops = [update(media(1, { path: "held.jpg" }), 1, { blob: { state: "missing" } })];
    const first = await w.push(ops, { idem: "held-1" });
    expect(first.status).toBe(200);
    expect(w.row(`REC#Media#${m.handle}`, "HEAD").blob).toEqual(before); // the good cloud blob is kept
    const again = await w.push(structuredClone(ops), { idem: "held-1" }); // the lost-response retry
    expect([again.status, again.headers["idempotent-replayed"], again.body]).toEqual([200, "true", first.body]);
    expect(w.row(`REC#Media#${m.handle}`, "HEAD").blob).toEqual(before);
  });

  it("a pending item that expired between a commit whose copy failed and the replay: the replay still copies the staged blob into place", async () => {
    const w = world();
    const m = media(1);
    const { claim } = await upload(w, m.handle, BYTES);
    w.s3.failNext("CopyObjectCommand");
    expect(err(await w.push([create(m, { blob: claim })], { idem: "blob-ttl" }))).toEqual({ status: 503, error: "retryable" });
    expect(w.s3.objects.has(`media/${m.handle}.jpg`)).toBe(false);
    // the pending ttl was pushed out at verify time, and the row can still vanish (TTL delete, a parallel finalize)
    expect(w.row(uploadKey(m.handle, claim.sha256).PK, claim.sha256).ttl).toBe(nowS + 3600);
    w.ddb.rows.delete(`${uploadKey(m.handle, claim.sha256).PK}\u0000${claim.sha256}`);
    const second = await w.push([create(m, { blob: claim })], { idem: "blob-ttl" });
    expect([second.status, second.headers["idempotent-replayed"]]).toEqual([200, "true"]);
    expect(w.s3.objects.get(`media/${m.handle}.jpg`).bytes).toEqual(BYTES);
    expect(w.s3.objects.has(stagingKey(m.handle, claim.sha256))).toBe(false);
  });

  it("a replay with no pending item never copies a staged blob over a newer one the head no longer names", async () => {
    const w = world();
    const m = media(1);
    const a = await upload(w, m.handle, BYTES);
    w.s3.failNext("CopyObjectCommand");
    expect(err(await w.push([create(m, { blob: a.claim })], { idem: "old" }))).toEqual({ status: 503, error: "retryable" });
    // a later batch puts another blob in place (the head names it now), then the old pending row is gone
    const b = await upload(w, m.handle, BYTES2);
    expect((await w.push([update(m, 1, { blob: b.claim })])).status).toBe(200);
    w.ddb.rows.delete(`${uploadKey(m.handle, a.claim.sha256).PK}\u0000${a.claim.sha256}`);
    expect((await w.push([create(m, { blob: a.claim })], { idem: "old" })).status).toBe(200);
    expect(w.s3.objects.get(`media/${m.handle}.jpg`).bytes).toEqual(BYTES2);
  });

  it("a pending item deleted while the batch verifies is 422 blob_not_uploaded and no stub item is left behind", async () => {
    const w = world();
    const m = media(1);
    const { claim } = await upload(w, m.handle, BYTES);
    const send = w.s3.send.bind(w.s3);
    w.s3.send = async (cmd) => {
      const r = await send(cmd);
      if (cmd.constructor.name === "HeadObjectCommand") w.ddb.rows.delete(`${uploadKey(m.handle, claim.sha256).PK}\u0000${claim.sha256}`);
      return r;
    };
    expect(err(await w.push([create(m, { blob: claim })]))).toEqual({ status: 422, error: "blob_not_uploaded" });
    expect(w.rows("SYNC#UPLOAD#")).toHaveLength(0);
    expect(w.rows("REC#")).toHaveLength(0);
  });

  it("a 403 from S3 on the staging key (no s3:ListBucket) reads as a missing blob and is logged at warn", async () => {
    const w = world();
    const m = media(1);
    const { claim } = await upload(w, m.handle, BYTES);
    const send = w.s3.send.bind(w.s3);
    w.s3.send = async (cmd) => {
      if (cmd.constructor.name === "HeadObjectCommand") throw Object.assign(new Error("AccessDenied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } });
      return send(cmd);
    };
    expect(err(await w.push([create(m, { blob: claim })]))).toEqual({ status: 422, error: "blob_not_uploaded" });
  });

  it("a crash after the copy but before the staging delete is finished by the replay without a second loss", async () => {
    const w = world();
    const m = media(1);
    const { claim } = await upload(w, m.handle, BYTES);
    w.s3.failNext("DeleteObjectCommand");
    expect(err(await w.push([create(m, { blob: claim })], { idem: "blob-2" }))).toEqual({ status: 503, error: "retryable" });
    expect(w.s3.objects.has(`media/${m.handle}.jpg`)).toBe(true);
    expect(w.s3.objects.has(stagingKey(m.handle, claim.sha256))).toBe(true);
    expect((await w.push([create(m, { blob: claim })], { idem: "blob-2" })).status).toBe(200);
    expect(w.s3.objects.has(stagingKey(m.handle, claim.sha256))).toBe(false);
  });

  it("an update with another blob replaces it atomically; an extension change deletes the orphaned key (by hfy-api)", async () => {
    const w = world();
    const m = media(1);
    const a = await upload(w, m.handle, BYTES, "image/jpeg");
    await w.push([create(m, { blob: a.claim })]);
    expect(w.s3.objects.has(`media/${m.handle}.jpg`)).toBe(true);
    // same extension, new bytes: the key is overwritten in place, the old sha256 is gone from the head
    const b = await upload(w, m.handle, BYTES2, "image/jpeg");
    expect((await w.push([update(m, 1, { blob: b.claim })])).status).toBe(200);
    expect(w.s3.objects.get(`media/${m.handle}.jpg`).bytes).toEqual(BYTES2);
    expect(w.row(`REC#Media#${m.handle}`, "HEAD").blob.sha256).toBe(b.claim.sha256);
    // a PNG now: the .jpg key is orphaned and deleted after the new one is in place
    const c = await upload(w, m.handle, Buffer.from("synthetic-png-bytes"), "image/png");
    expect((await w.push([update(m, 2, { blob: c.claim })])).status).toBe(200);
    expect(w.s3.objects.has(`media/${m.handle}.png`)).toBe(true);
    expect(w.s3.objects.has(`media/${m.handle}.jpg`)).toBe(false);
    expect(w.row(`REC#Media#${m.handle}`, "HEAD").blob.s3_key).toBe(`media/${m.handle}.png`);
    const names = w.s3.log.map((l) => `${l.name}:${l.Key}`);
    expect(names.indexOf(`CopyObjectCommand:media/${m.handle}.png`)).toBeLessThan(names.indexOf(`DeleteObjectCommand:media/${m.handle}.jpg`));
    expect(w.s3.objects.has(stagingKey(m.handle, c.claim.sha256))).toBe(false);
  });

  it("the orphan delete only ever touches a binary named by the same handle, never a data file", async () => {
    const w = world();
    const m = media(1);
    const a = await upload(w, m.handle, BYTES);
    await w.push([create(m, { blob: a.claim })]);
    w.row(`REC#Media#${m.handle}`, "HEAD").blob.s3_key = "person/index.json"; // a corrupted head
    w.s3.objects.set("person/index.json", { bytes: Buffer.from("{}"), contentType: "application/json" });
    const b = await upload(w, m.handle, BYTES2, "image/png");
    expect((await w.push([update(m, 1, { blob: b.claim })])).status).toBe(200);
    expect(w.s3.objects.has("person/index.json")).toBe(true);
  });

  it("an unchanged blob needs no upload; a held blob keeps the cloud blob; a metadata-only update keeps the descriptor", async () => {
    const w = world();
    const m = media(1);
    const a = await upload(w, m.handle, BYTES);
    await w.push([create(m, { blob: a.claim })]);
    const before = structuredClone(w.row(`REC#Media#${m.handle}`, "HEAD").blob);
    expect((await w.push([update(media(1, { path: "b.jpg" }), 1, { blob: a.claim })])).status).toBe(200); // same bytes, no presign
    expect(w.row(`REC#Media#${m.handle}`, "HEAD").blob).toEqual(before);
    expect((await w.push([update(media(1, { path: "c.jpg" }), 2, { blob: { state: "missing" } })])).status).toBe(200); // never overwrite a good blob with a missing one
    expect(w.row(`REC#Media#${m.handle}`, "HEAD").blob).toEqual(before);
    expect((await w.push([update(media(1, { path: "d.jpg" }), 3)])).status).toBe(200); // no blob member at all
    expect(w.row(`REC#Media#${m.handle}`, "HEAD").blob).toEqual(before);
    const m2 = media(2);
    expect((await w.push([create(m2, { blob: { state: "missing" } })])).status).toBe(200);
    expect(w.row(`REC#Media#${m2.handle}`, "HEAD").blob).toEqual({ state: "missing" });
  });

  it("blobDescriptor derives the key and refuses unknown members and bad values", () => {
    const c = claimOf(BYTES);
    expect(blobDescriptor(h(4001), c).s3_key).toBe(`media/${h(4001)}.jpg`);
    for (const bad of [{ ...c, s3_key: "x" }, { ...c, sha256: "z" }, { ...c, md5: "1" }, { ...c, size: 0 }, { ...c, content_type: "image/heic" }, { ...c, state: "gone" }, { state: "missing", size: 1 }, "x", null]) expect(() => blobDescriptor(h(4001), bad), JSON.stringify(bad)).toThrow(/blob|invalid/);
    expect(stagingKey(h(1), "ab")).toBe(`media/.staging/${h(1)}/ab`);
  });

  it("a blob on a non-Media create is refused by applyBatch; a blob on a delete is ignored", async () => {
    const w = world();
    expect(err(await w.push([create(person(1), { blob: { state: "missing" } })]))).toEqual({ status: 400, error: "validation" });
    await w.push([create(person(2))]);
    expect((await w.push([{ ...del("Person", h(2), 1), blob: { state: "missing" } }])).status).toBe(200);
  });
});

describe("seq numbers stay dense across sessions, batches and the marker", () => {
  it("every op takes the next seq whatever route it came through", async () => {
    const w = world();
    const s = await w.open();
    await w.push([create(person(1)), create(note(1))], { session: s.body.session_id });
    await w.push([create(note(2))]);
    await w.call("POST", `/sync/sessions/${s.body.session_id}/complete`, {});
    expect(w.logRows().map((l) => l.seq)).toEqual([1, 2, 3, 4]);
    expect(w.rows("SYNC#LOG").every((l) => l.SK === seqKey(l.seq))).toBe(true);
  });
});
