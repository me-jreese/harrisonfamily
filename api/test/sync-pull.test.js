// HFY-TSK-174 (sync-pull-routes): /api/sync/snapshot, /media/:handle/download, /status, /conflicts and /conflicts/:id/decision on the sync-bearer
// middleware. In-memory DynamoDB fake, a local JWKS, a fake S3, synthetic objects and subjects only.
// Cloud catalog rows that apply to pull: S01 (token), S02 (group), S03 (switch and pause), S04 (handshake), S05 (invalid input), S08 (store errors);
// S19 (an expunged entry), S22 (a delete or withdraw reaches the desktop as a tombstone). S06 and S07 are write-path conditions, S20 is an internal
// retry of the write transaction and S21 is the render schedule: none has pull-side behaviour, and the decision's own condition (409
// already_resolved) is covered under the decision tests.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SignJWT, importPKCS8 } from "jose";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { makeApi, pem, ISSUER, signToken } from "./world.js";
import { buildCaps } from "../src/routes.js";
import { createGroupResolver } from "../src/policy.js";
import { SYNC_AUDIENCE, SYNC_CLIENT_ID, createSyncAuthenticator, requireConflictDecision } from "../src/sync/auth.js";
import { createHookRegistry } from "../src/sync/hooks.js";
import { headKey } from "../src/sync/store.js";
import { RECONCILE_ITEMS, buildSnapshot, cloudValueAt, cloudValueHash, conflictKey, decisionStaleReason, snapshotKey } from "../src/sync/pull.js";
import { resetStoreView } from "../src/records/index.js";

const OWNER = "I9001";
const OTHER = "I9002";
const NOW = Date.parse("2026-10-14T12:00:00Z");
const nowS = Math.floor(NOW / 1000);
const GROUPS = { version: 1, groups: { "gramps-owner": { subjects: [OWNER] }, "hfy-admin": { subjects: ["I0099"] } } };
const key = await importPKCS8(pem, "RS256");
const HS = { "x-hfy-sync-client": "hfy_sync/0.1.0", "x-hfy-gramps-version": "6.0.6", "x-hfy-gramps-schema": "21", "x-hfy-redaction-version": "1" };
const TREE = "00000000-0000-4000-8000-000000000001";
const BOUND = { dbid: "db-synthetic-1", fingerprint: "fp-0123456789abcdef", tree_name_sha256: "a".repeat(64), bound_at: "2026-10-13T00:00:00.000Z", by: OWNER };
const SYNC_BUCKET = "sync-bucket.test";
const MEDIA_BUCKET = "media-bucket.test";

const token = (o = {}) =>
  new SignJWT({ client_id: SYNC_CLIENT_ID, token_use: "access", amr: o.amr ?? ["passkey", "mfa"], auth_time: o.authTime ?? nowS - 10, groups: [] })
    .setProtectedHeader({ alg: "RS256", kid: "hfy-session-1" })
    .setSubject(o.sub ?? OWNER).setIssuer(ISSUER).setAudience(SYNC_AUDIENCE).setIssuedAt(nowS - 5).setExpirationTime(nowS + 600).sign(key);

let envBefore;
beforeEach(() => { envBefore = process.env.SYNC_API_ENABLED; process.env.SYNC_API_ENABLED = "1"; });
afterEach(() => { if (envBefore === undefined) delete process.env.SYNC_API_ENABLED; else process.env.SYNC_API_ENABLED = envBefore; });

const h = (n) => n.toString(16).padStart(28, "0");
const person = (n, extra = {}) => ({
  _class: "Person", handle: h(n), gramps_id: `I${String(n).padStart(4, "0")}`, private: false, gender: 1,
  primary_name: { _class: "Name", first_name: "Alder", surname_list: [{ _class: "Surname", primary: true, surname: "Testwood" }], type: { _class: "NameType", string: "", value: 2 }, date: { _class: "Date", calendar: 0, dateval: [0, 0, 0, false], format: null, modifier: 0, newyear: 0, quality: 0, sortval: 0, text: "" } },
  event_ref_list: [], birth_ref_index: -1, death_ref_index: -1, family_list: [], parent_family_list: [], note_list: [], media_list: [], urls: [], ...extra,
});
const note = (n, extra = {}) => ({ _class: "Note", handle: h(2000 + n), gramps_id: `N${String(n).padStart(4, "0")}`, private: false, text: { _class: "StyledText", string: `Synthetic note ${n}`, tags: [] }, ...extra });
const create = (obj, extra = {}) => ({ op: "create", class: obj._class, handle: obj.handle, base_version: null, obj, ...extra });
const del = (cls, handle, base) => ({ op: "delete", class: cls, handle, base_version: base });

/** A fake bucket: Head, Put and Delete with user metadata, as the snapshot cache uses them. */
function bucket() {
  const objects = new Map();
  const log = [];
  const failing = new Set();
  const status = (name, code) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: code } });
  return {
    objects, log, failNext: (cmd) => failing.add(cmd),
    async send(cmd) {
      const name = cmd.constructor.name;
      const i = cmd.input;
      log.push({ name, Bucket: i.Bucket, Key: i.Key });
      if (failing.delete(name)) throw status("InternalError", 500);
      if (name === "PutObjectCommand") { objects.set(`${i.Bucket}/${i.Key}`, { bytes: Buffer.from(i.Body), metadata: i.Metadata ?? {}, contentType: i.ContentType }); return {}; }
      if (name === "HeadObjectCommand") {
        const o = objects.get(`${i.Bucket}/${i.Key}`);
        if (!o) throw status("NotFound", 404);
        return { ContentLength: o.bytes.length, ContentType: o.contentType, Metadata: o.metadata };
      }
      throw new Error(`fake s3: unsupported ${name}`);
    },
    puts: () => log.filter((l) => l.name === "PutObjectCommand"),
  };
}

function world({ head, groups = GROUPS, s3 = bucket() } = {}) {
  let auth;
  const gets = [];
  const w = makeApi({
    clock: () => NOW,
    extraDeps: {
      authenticateSync: (e) => auth(e), s3, syncHooks: createHookRegistry(), txnOpts: { sleep: async () => {} },
      syncBucket: SYNC_BUCKET, mediaBucket: MEDIA_BUCKET,
      presignGet: async (a) => { gets.push(a); return `https://presign.test/${a.bucket}/${a.key}?sig=get`; },
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
  const push = (ops, o = {}) => call("POST", "/sync/batches", { idem: `k-${++k}`, body: { ops }, ...(o.call ?? {}) });
  const row = (pk, sk = "META") => w.ddb.rows.get(`${pk}\u0000${sk}`);
  const rows = (prefix) => w.ddb.all().filter((r) => r.PK.startsWith(prefix));
  const reset = () => resetStoreView({ ddb: w.ddb, table: "hfy-app" });
  return { ...w, call, push, row, rows, reset, s3, gets };
}
const err = (r) => ({ status: r.status, error: r.body?.error });

/** Reads a snapshot object back the way the add-on does: gunzip, split, verify the header against the body. */
function readSnapshot(s3, seq) {
  const o = s3.objects.get(`${SYNC_BUCKET}/${snapshotKey(seq)}`);
  const text = gunzipSync(o.bytes).toString("utf8");
  const nl = text.indexOf("\n");
  const header = JSON.parse(text.slice(0, nl));
  const body = text.slice(nl + 1);
  const lines = body === "" ? [] : body.slice(0, -1).split("\n").map((l) => JSON.parse(l));
  return { header, body, lines, sha: createHash("sha256").update(body).digest("hex"), metadata: o.metadata };
}

// ---- conflict items ---------------------------------------------------------------------------------------------------
const CID = (n) => `01J${String(n).padStart(23, "0")}`;
const conflictRow = (n, extra = {}) => ({
  ...conflictKey(CID(n)), GSI1PK: "SYNCCONFLICT#open", GSI1SK: `2026-10-13T00:00:0${n}.000Z#${CID(n)}`, entity: "syncconflict",
  class: "Person", handle: h(1), gramps_id: "I0001", kind: "field", source: "desktop_parked", state: "open",
  paths: [{ path: "/primary_name/first_name", base: "Alder", cloud: "Birch", desktop: "Cedar" }], opened_at: `2026-10-13T00:00:0${n}.000Z`, ...extra,
});

describe("the pull routes exist on the sync-bearer middleware with caps.json (AC2)", () => {
  it("caps.json lists snapshot, media download, status, conflicts and the decision as sync-bearer routes behind SYNC_API_ENABLED, with no MCP tool", () => {
    const sync = buildCaps().actions.filter((a) => a.path.startsWith("/api/sync/") && a.name !== "sync.admin.status");
    const by = Object.fromEntries(sync.map((a) => [a.name, `${a.method} ${a.path}`]));
    expect(by).toMatchObject({
      "sync.snapshot": "GET /api/sync/snapshot", "sync.media.download": "POST /api/sync/media/:handle/download", "sync.status": "POST /api/sync/status",
      "sync.conflicts.list": "GET /api/sync/conflicts", "sync.conflicts.decision": "POST /api/sync/conflicts/:id/decision",
    });
    for (const a of sync) expect(a).toMatchObject({ auth: "sync-bearer", gate: { switch: "SYNC_API_ENABLED" } });
    expect(buildCaps().mcp.tools.map((t) => t.action).filter((n) => n.startsWith("sync."))).toEqual([]);
  });

  const ROUTES = [
    ["GET", "/sync/snapshot"], ["POST", "/sync/media/" + h(4001) + "/download"], ["POST", "/sync/status"], ["GET", "/sync/conflicts"], ["POST", `/sync/conflicts/${CID(1)}/decision`],
  ];
  it("S01: no token, a garbage token or a web token is 401 with a challenge, on every pull route", async () => {
    const w = world();
    for (const [m, p] of ROUTES) {
      for (const tok of ["", "garbage", await signToken("I0099")]) {
        const r = await w.call(m, p, { tok, body: m === "POST" ? {} : undefined });
        expect(err(r), `${p}`).toEqual({ status: 401, error: "unauthenticated" });
        expect(r.headers["www-authenticate"]).toMatch(/^Bearer realm=/);
      }
    }
  });
  it("S02: a subject outside gramps-owner is 403 not_owner (hfy-admin is not gramps-owner), and an unreadable groups.json fails closed", async () => {
    const w = world();
    for (const [m, p] of ROUTES) {
      for (const sub of [OTHER, "I0099"]) expect(err(await w.call(m, p, { tok: await token({ sub }), body: m === "POST" ? {} : undefined })), p).toEqual({ status: 403, error: "not_owner" });
    }
    expect(err(await world({ groups: {} }).call("GET", "/sync/snapshot"))).toEqual({ status: 403, error: "not_owner" });
  });
  it("S03: SYNC_API_ENABLED off is 404 not_enabled; a paused store (writes_enabled false) still serves every pull route", async () => {
    const paused = world({ head: { writes_enabled: false } });
    expect((await paused.call("GET", "/sync/snapshot")).status).toBe(200);
    expect(err(await paused.call("POST", `/sync/media/${h(4001)}/download`, { body: {} }))).toEqual({ status: 404, error: "no_blob" });
    expect((await paused.call("GET", "/sync/conflicts")).status).toBe(200);
    process.env.SYNC_API_ENABLED = "0";
    for (const [m, p] of ROUTES) expect(err(await world().call(m, p, { body: m === "POST" ? {} : undefined })), p).toEqual({ status: 404, error: "not_enabled" });
  });
  it("S04: an old client or an unsupported schema is 426 and a redaction mismatch is 409, before anything is read", async () => {
    const w = world();
    expect(err(await w.call("GET", "/sync/snapshot", { hs: { ...HS, "x-hfy-sync-client": "hfy_sync/0.0.1" } }))).toEqual({ status: 426, error: "upgrade_required" });
    expect(err(await w.call("GET", "/sync/conflicts", { hs: { ...HS, "x-hfy-gramps-schema": "22" } }))).toEqual({ status: 426, error: "upgrade_required" });
    expect(err(await w.call("GET", "/sync/snapshot", { hs: { ...HS, "x-hfy-redaction-version": "2" } }))).toEqual({ status: 409, error: "redaction_version_mismatch" });
    expect(w.s3.log).toHaveLength(0);
  });
  it("a request for another tree than the bound one is 403 tree_mismatch", async () => {
    const w = world();
    expect(err(await w.call("GET", "/sync/snapshot", { tree: "00000000-0000-4000-8000-0000000000ff" }))).toEqual({ status: 403, error: "tree_mismatch" });
    expect(w.s3.log).toHaveLength(0);
  });
});

describe("GET /api/sync/snapshot (AC1)", () => {
  it("returns a presigned URL to a gzip JSONL at the current head whose header and body_sha256 verify", async () => {
    const w = world();
    const a = person(1);
    const b = person(2);
    expect((await w.push([create(a), create(b), create(note(1))])).status).toBe(200);
    const r = await w.call("GET", "/sync/snapshot");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ seq: 3, count: 3, url: `https://presign.test/${SYNC_BUCKET}/snapshots/3.jsonl.gz?sig=get` });
    expect(r.body.generated_at).toBe(new Date(NOW).toISOString());
    expect(w.gets).toEqual([{ bucket: SYNC_BUCKET, key: "snapshots/3.jsonl.gz", expiresIn: 300 }]);
    const s = readSnapshot(w.s3, 3);
    expect(s.header).toEqual({ type: "header", tree_id: TREE, seq: 3, schema: 21, redaction: 1, count: 3, body_sha256: r.body.body_sha256 });
    expect(s.sha).toBe(r.body.body_sha256); // the body hashes to the header's and the response's digest
    expect(s.lines.map((l) => [l.class, l.handle, l.version, l.deleted])).toEqual([["Person", a.handle, 1, false], ["Person", b.handle, 1, false], ["Note", h(2001), 1, false]]);
    expect(s.lines[0]).toMatchObject({ gramps_id: "I0001", seq: 1 });
    expect(s.lines[0].obj).toMatchObject({ _class: "Person", handle: a.handle });
    expect(Object.keys(s.lines[0]).sort()).toEqual(["class", "deleted", "gramps_id", "handle", "obj", "seq", "version"]);
    expect(s.metadata).toMatchObject({ body_sha256: r.body.body_sha256, count: "3" });
  });

  it("is built per seq and cached: a repeat call at the same head writes nothing, and a push builds the next file", async () => {
    const w = world();
    await w.push([create(person(1))]);
    const first = await w.call("GET", "/sync/snapshot");
    expect(w.s3.puts().map((p) => p.Key)).toEqual(["snapshots/1.jsonl.gz", "snapshots/latest.json"]);
    const again = await w.call("GET", "/sync/snapshot");
    expect(again.body).toEqual(first.body);
    expect(w.s3.puts()).toHaveLength(2); // no second write
    await w.push([create(person(2))]);
    const next = await w.call("GET", "/sync/snapshot");
    expect(next.body).toMatchObject({ seq: 2, count: 2 });
    expect(next.body.body_sha256).not.toBe(first.body.body_sha256);
    expect(JSON.parse(w.s3.objects.get(`${SYNC_BUCKET}/snapshots/latest.json`).bytes.toString())).toMatchObject({ seq: 2, key: "snapshots/2.jsonl.gz", count: 2 });
  });

  it("an empty store gives a header-only file with count 0", async () => {
    const w = world();
    const r = await w.call("GET", "/sync/snapshot");
    expect(r.body).toMatchObject({ seq: 0, count: 0 });
    expect(readSnapshot(w.s3, 0)).toMatchObject({ lines: [], body: "", header: { count: 0, seq: 0 } });
    expect(r.body.body_sha256).toBe(createHash("sha256").update("").digest("hex"));
  });

  it("is deterministic: the same heads give the same bytes in any input order", () => {
    const heads = [
      { class: "Note", handle: h(2001), gramps_id: "N0001", version: 1, seq: 3, deleted: false, obj: note(1) },
      { class: "Person", handle: h(2), gramps_id: "I0002", version: 1, seq: 2, deleted: false, obj: person(2) },
      { class: "Person", handle: h(1), gramps_id: "I0001", version: 1, seq: 1, deleted: false, obj: person(1) },
    ];
    const a = buildSnapshot({ treeId: TREE, seq: 3, heads });
    const b = buildSnapshot({ treeId: TREE, seq: 3, heads: [...heads].reverse() });
    expect(a.gz.equals(b.gz)).toBe(true);
    expect(a.count).toBe(3);
  });

  it("S22: a delete reaches the desktop as a tombstone line (deleted true, obj null) that keeps its version and gramps_id", async () => {
    const w = world();
    const a = person(1);
    await w.push([create(a), create(note(1))]);
    expect((await w.push([del("Note", h(2001), 1)])).status).toBe(200);
    const r = await w.call("GET", "/sync/snapshot");
    expect(r.body).toMatchObject({ seq: 3, count: 2 });
    const tomb = readSnapshot(w.s3, 3).lines.find((l) => l.class === "Note");
    expect(tomb).toEqual({ class: "Note", handle: h(2001), gramps_id: "N0001", version: 2, seq: 3, deleted: true, obj: null });
  });

  it("S19: an entry whose value was expunged (obj_json removed, history kept) is a tombstone in the snapshot, never its old value", async () => {
    const w = world();
    const a = person(1);
    await w.push([create(a)]);
    const logRow = w.rows("SYNC#LOG")[0];
    w.ddb.rows.set(`${logRow.PK}\u0000${logRow.SK}`, { ...logRow, obj_json: null, hash: logRow.hash, expunged: true });
    w.reset();
    const r = await w.call("GET", "/sync/snapshot");
    expect(r.body.count).toBe(1);
    const s = readSnapshot(w.s3, 1);
    expect(s.lines[0]).toMatchObject({ handle: a.handle, deleted: true, obj: null });
    expect(s.body).not.toContain("Testwood");
  });

  it("S19b: an expunge that bumps SYNC#HEAD.expunge_epoch without advancing seq invalidates the cached snapshot", async () => {
    const w = world();
    const a = person(1);
    await w.push([create(a)]);
    await w.call("GET", "/sync/snapshot");
    expect(readSnapshot(w.s3, 1).lines[0]).toMatchObject({ handle: a.handle, deleted: false });
    const logRow = w.rows("SYNC#LOG")[0];
    w.ddb.rows.set(`${logRow.PK}\u0000${logRow.SK}`, { ...logRow, obj_json: null, expunged: true });
    const hd = w.row("SYNC#HEAD");
    w.ddb.rows.set("SYNC#HEAD\u0000META", { ...hd, expunge_epoch: 1 });
    w.reset();
    const before = w.s3.puts().length;
    const r = await w.call("GET", "/sync/snapshot");
    expect(r.body.seq).toBe(1);
    expect(w.s3.puts().length).toBeGreaterThan(before); // rebuilt, not served from cache
    expect(readSnapshot(w.s3, 1).lines[0]).toMatchObject({ handle: a.handle, deleted: true, obj: null });
    expect(readSnapshot(w.s3, 1).body).not.toContain("Testwood");
  });

  it("S08: a store or S3 failure is 503 retryable, and the next call recovers", async () => {
    const w = world();
    await w.push([create(person(1))]);
    w.s3.failNext("PutObjectCommand");
    expect(err(await w.call("GET", "/sync/snapshot"))).toEqual({ status: 503, error: "retryable" });
    expect((await w.call("GET", "/sync/snapshot")).status).toBe(200);
    const down = world();
    await down.push([create(person(1))]);
    down.s3.failNext("HeadObjectCommand");
    expect(err(await down.call("GET", "/sync/snapshot"))).toEqual({ status: 503, error: "retryable" });
  });

  it("is 503 unavailable when the sync bucket or signer is not wired", async () => {
    const w = makeApi({ clock: () => NOW, extraDeps: { authenticateSync: (e) => e && Promise.resolve({ id: OWNER, admin: false, sync: { owner: true, stepUp: () => true } }) } });
    w.ddb.rows.set("SYNC#HEAD\u0000META", { ...headKey(), seq: 0, tree_id: TREE, bound: BOUND, writes_enabled: true });
    const r = await w.call("GET", "/api/sync/snapshot", { headers: { ...HS, "x-hfy-tree-id": TREE, authorization: "Bearer x" } });
    expect(err(r)).toEqual({ status: 503, error: "unavailable" });
  });
});

describe("POST /api/sync/media/:handle/download", () => {
  const blob = { s3_key: `media/${h(4001)}.jpg`, sha256: "b".repeat(64), md5: "c".repeat(32), size: 1234, content_type: "image/jpeg", state: "present" };
  const seedMedia = (w, handle, extra = {}) => w.ddb.rows.set(`REC#Media#${handle}\u0000HEAD`, { PK: `REC#Media#${handle}`, SK: "HEAD", class: "Media", handle, gramps_id: "O0001", version: 3, deleted: false, obj_json: "{}", blob, ...extra });

  it("presigns the blob key and returns the checksums the desktop verifies", async () => {
    const w = world();
    seedMedia(w, h(4001));
    const r = await w.call("POST", `/sync/media/${h(4001)}/download`, { body: {} });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ url: `https://presign.test/${MEDIA_BUCKET}/media/${h(4001)}.jpg?sig=get`, sha256: blob.sha256, md5: blob.md5, size: 1234, content_type: "image/jpeg", expires_in: 300 });
    expect(w.gets).toEqual([{ bucket: MEDIA_BUCKET, key: `media/${h(4001)}.jpg`, expiresIn: 300, contentType: "image/jpeg" }]);
  });
  it("404 no_blob for an unknown handle, a malformed handle, a held blob, a missing descriptor, a tombstone or a foreign key", async () => {
    const w = world();
    seedMedia(w, h(4002), { blob: { state: "missing" } });
    seedMedia(w, h(4003), { blob: undefined });
    seedMedia(w, h(4004), { deleted: true });
    seedMedia(w, h(4005), { blob: { ...blob, s3_key: "uploads/posts/x/photo.jpg" } });
    for (const handle of [h(4009), "not-a-handle", h(4002), h(4003), h(4004), h(4005)]) {
      expect(err(await w.call("POST", `/sync/media/${handle}/download`, { body: {} })), handle).toEqual({ status: 404, error: "no_blob" });
    }
    expect(w.gets).toHaveLength(0);
  });
  it("S08: a signer failure is 503 retryable", async () => {
    const w = world();
    seedMedia(w, h(4001));
    const bad = makeApi({ clock: () => NOW, extraDeps: { authenticateSync: (e) => w.handler && Promise.resolve({ id: OWNER, admin: false, sync: { owner: true, stepUp: () => true } }), presignGet: async () => { throw new Error("boom"); }, syncBucket: SYNC_BUCKET } });
    bad.ddb.rows.set("SYNC#HEAD\u0000META", { ...headKey(), seq: 0, tree_id: TREE, bound: BOUND, writes_enabled: true });
    bad.ddb.rows.set(`REC#Media#${h(4001)}\u0000HEAD`, { PK: `REC#Media#${h(4001)}`, SK: "HEAD", class: "Media", handle: h(4001), deleted: false, blob });
    expect(err(await bad.call("POST", `/api/sync/media/${h(4001)}/download`, { headers: { ...HS, "x-hfy-tree-id": TREE, authorization: "Bearer x" }, body: {} }))).toEqual({ status: 503, error: "retryable" });
  });
});

describe("POST /api/sync/status", () => {
  const good = () => ({
    client_instance_id: "instance-0001", dbid: "db-synthetic-1", fingerprint: "fp-0123456789abcdef", addon_version: "0.1.0", gramps_version: "6.0.6", schema: 21,
    last_run: { run_id: "run-0001", action: "sync", result: "ok", exit_code: 0, counts: { pulled: 3, pushed: 1 }, finished_at: "2026-10-14T11:59:00Z" },
  });
  it("stores the heartbeat under SYNC#CLIENT#<instance>, replacing the last one, and answers 204", async () => {
    const w = world();
    const r = await w.call("POST", "/sync/status", { body: good() });
    expect(r.status).toBe(204);
    expect(r.body).toBeUndefined();
    expect(w.row("SYNC#CLIENT#instance-0001")).toMatchObject({ dbid: "db-synthetic-1", addon_version: "0.1.0", principal: OWNER, last_run: { run_id: "run-0001", counts: { pulled: 3, pushed: 1 }, exit_code: 0 } });
    await w.call("POST", "/sync/status", { body: { ...good(), last_run: { ...good().last_run, run_id: "run-0002" } } });
    expect(w.rows("SYNC#CLIENT#")).toHaveLength(1);
    expect(w.row("SYNC#CLIENT#instance-0001").last_run.run_id).toBe("run-0002");
  });
  it("S05: a malformed heartbeat is 400 validation and writes nothing; unknown fields are never stored", async () => {
    const w = world();
    for (const mut of [(b) => { b.client_instance_id = "x"; }, (b) => { delete b.last_run; }, (b) => { b.last_run.counts = { bad: -1 }; }, (b) => { b.last_run.finished_at = "yesterday"; }, (b) => { b.fingerprint = "no spaces allowed here"; }]) {
      const b = good();
      mut(b);
      expect(err(await w.call("POST", "/sync/status", { body: b }))).toEqual({ status: 400, error: "validation" });
    }
    expect(w.rows("SYNC#CLIENT#")).toHaveLength(0);
    await w.call("POST", "/sync/status", { body: { ...good(), tree_name: "Synthetic Family", note: "free text" } });
    expect(JSON.stringify(w.row("SYNC#CLIENT#instance-0001"))).not.toMatch(/Synthetic Family|free text/);
  });
});

describe("GET /api/sync/conflicts", () => {
  const seed = (w, n = 3) => { for (let i = 1; i <= n; i += 1) w.ddb.rows.set(`SYNC#CONFLICT#${CID(i)}\u0000META`, conflictRow(i)); };
  it("lists the open queue oldest first in the wire shape, and filters by state", async () => {
    const w = world();
    seed(w);
    w.ddb.rows.set(`SYNC#CONFLICT#${CID(4)}\u0000META`, conflictRow(4, { state: "resolved", GSI1PK: "SYNCCONFLICT#resolved", decision: "keep_cloud", resolved_at: "2026-10-13T01:00:00.000Z", by: OWNER }));
    const r = await w.call("GET", "/sync/conflicts", { query: { state: "open" } });
    expect(r.status).toBe(200);
    expect(r.body.conflicts.map((c) => c.id)).toEqual([CID(1), CID(2), CID(3)]);
    expect(r.body.conflicts[0]).toEqual({ id: CID(1), class: "Person", handle: h(1), gramps_id: "I0001", kind: "field", source: "desktop_parked", paths: conflictRow(1).paths, state: "open", decision: null, opened_at: "2026-10-13T00:00:01.000Z", resolved_at: null, by: null, cloud_version: null, cloud_value_hash: null, reopened_at: null, history: [], applied_at: null });
    expect(r.body.next_cursor).toBeNull();
    expect((await w.call("GET", "/sync/conflicts")).body.conflicts).toHaveLength(3); // open is the default
    const done = await w.call("GET", "/sync/conflicts", { query: { state: "resolved" } });
    expect(done.body.conflicts.map((c) => [c.id, c.decision])).toEqual([[CID(4), "keep_cloud"]]);
  });
  it("pages with limit and an opaque cursor; a forged or foreign cursor is 400 bad_cursor; a bad state or limit is 400 validation", async () => {
    const w = world();
    seed(w);
    const p1 = await w.call("GET", "/sync/conflicts", { query: { limit: "2" } });
    expect(p1.body.conflicts.map((c) => c.id)).toEqual([CID(1), CID(2)]);
    expect(p1.body.next_cursor).toEqual(expect.any(String));
    const p2 = await w.call("GET", "/sync/conflicts", { query: { limit: "2", cursor: p1.body.next_cursor } });
    expect(p2.body.conflicts.map((c) => c.id)).toEqual([CID(3)]);
    const forged = Buffer.from(JSON.stringify({ PK: "AUDIT#x", SK: "META", GSI1PK: "SYNCCONFLICT#open", GSI1SK: "x" })).toString("base64url");
    for (const cursor of [forged, "!!", Buffer.from("[]").toString("base64url")]) expect(err(await w.call("GET", "/sync/conflicts", { query: { cursor } })), cursor).toEqual({ status: 400, error: "bad_cursor" });
    const otherState = await w.call("GET", "/sync/conflicts", { query: { state: "resolved", cursor: p1.body.next_cursor } });
    expect(otherState.body.conflicts).toEqual([]); // a cursor can only walk the partition it is used with
    for (const query of [{ state: "weird" }, { limit: "0" }, { limit: "101" }, { limit: "x" }]) expect(err(await w.call("GET", "/sync/conflicts", { query })), JSON.stringify(query)).toEqual({ status: 400, error: "validation" });
  });
});

describe("POST /api/sync/conflicts/:id/decision (AC3)", () => {
  const seedOne = async (w) => {
    await w.push([create(person(1))]);
    w.ddb.rows.set(`SYNC#CONFLICT#${CID(1)}\u0000META`, conflictRow(1));
  };
  const decide = (w, id = CID(1), body = { decision: "keep_cloud" }, o = {}) => w.call("POST", `/sync/conflicts/${id}/decision`, { body, ...o });

  it("gramps-owner with a fresh step-up records the decision and stores {cloud_version, cloud_value_hash}", async () => {
    const w = world();
    await seedOne(w);
    const r = await decide(w);
    expect(r.status).toBe(200);
    const hash = cloudValueHash(conflictRow(1).paths);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.body).toMatchObject({ id: CID(1), state: "resolved", decision: "keep_cloud", cloud_version: 1, cloud_value_hash: hash, by: OWNER, resolved_at: new Date(NOW).toISOString() });
    expect(w.row(`SYNC#CONFLICT#${CID(1)}`)).toMatchObject({ state: "resolved", decision: "keep_cloud", cloud_version: 1, cloud_value_hash: hash, GSI1PK: "SYNCCONFLICT#resolved" });
    expect(w.rows("AUDIT#conflict:")).toHaveLength(1);
    expect((await w.call("GET", "/sync/conflicts")).body.conflicts).toHaveLength(0); // it left the open queue
    expect((await w.call("GET", "/sync/conflicts", { query: { state: "resolved" } })).body.conflicts.map((c) => c.id)).toEqual([CID(1)]);
  });
  it("a cloud head that moves between the read and the write fails the decision as 503 retryable and leaves the conflict open", async () => {
    const w = world();
    await seedOne(w);
    const send = w.ddb.send.bind(w.ddb);
    w.ddb.send = async (cmd) => {
      if (cmd.constructor.name === "TransactWriteCommand") {
        const k = "REC#Person#" + person(1).handle + "\u0000HEAD";
        const row = w.ddb.rows.get(k);
        if (row) w.ddb.rows.set(k, { ...row, version: row.version + 1 });
      }
      return send(cmd);
    };
    expect(err(await decide(w))).toEqual({ status: 503, error: "retryable" });
    expect(w.row(`SYNC#CONFLICT#${CID(1)}`)).toMatchObject({ state: "open" });
  });
  it("the hash is tied to the cloud values the admin saw: another cloud value gives another hash", () => {
    const a = cloudValueHash([{ path: "/x", cloud: "one", desktop: "d" }]);
    expect(cloudValueHash([{ path: "/x", cloud: "one", desktop: "other desktop value" }])).toBe(a);
    expect(cloudValueHash([{ path: "/x", cloud: "two" }])).not.toBe(a);
    expect(cloudValueHash([{ path: "/y", cloud: "one" }])).not.toBe(a);
  });
  it("a stale sign-in (auth_time over 300 s) or one without mfa is 403 step_up_required, and nothing changes", async () => {
    const w = world();
    await seedOne(w);
    for (const tok of [await token({ authTime: nowS - 301 }), await token({ amr: ["passkey"] }), await token({ authTime: 0 })]) {
      const r = await decide(w, CID(1), { decision: "keep_cloud" }, { tok });
      expect(err(r)).toEqual({ status: 403, error: "step_up_required" });
      expect(r.body.details).toMatchObject({ max_age_seconds: 300, reason: "conflict_decision" });
    }
    expect(w.row(`SYNC#CONFLICT#${CID(1)}`).state).toBe("open");
    expect((await decide(w, CID(1), { decision: "keep_cloud" }, { tok: await token({ authTime: nowS - 299 }) })).status).toBe(200); // just inside the window
  });
  it("an hfy-admin cookie alone is refused: an admin session is 403 not_owner (the owner's session is HFY-TSK-279), no credentials is 401, an admin bearer is 403 not_owner; requireConflictDecision refuses a cookie actor", async () => {
    const w = world();
    await seedOne(w);
    expect(err(await decide(w, CID(1), { decision: "keep_cloud" }, { tok: "", token: await signToken("I0099") }))).toEqual({ status: 403, error: "not_owner" });
    expect(err(await decide(w, CID(1), { decision: "keep_cloud" }, { tok: "" }))).toEqual({ status: 401, error: "unauthenticated" });
    expect(err(await decide(w, CID(1), { decision: "keep_cloud" }, { tok: await token({ sub: "I0099" }) }))).toEqual({ status: 403, error: "not_owner" });
    expect(w.row(`SYNC#CONFLICT#${CID(1)}`).state).toBe("open");
    const cookieAdmin = { id: "I0099", label: "I0099", admin: true };
    expect(() => requireConflictDecision(cookieAdmin, NOW)).toThrow(expect.objectContaining({ status: 403, code: "not_owner" }));
    const staleOwner = { id: OWNER, admin: false, sync: { owner: true, stepUp: () => false } };
    expect(() => requireConflictDecision(staleOwner, NOW)).toThrow(expect.objectContaining({ status: 403, code: "step_up_required" }));
  });
  it("409 already_resolved for a second decision; 404 for an unknown or malformed id; 400 for a bad decision", async () => {
    const w = world();
    await seedOne(w);
    expect((await decide(w, CID(1), { decision: "keep_desktop" })).status).toBe(200);
    expect(err(await decide(w, CID(1), { decision: "keep_cloud" }))).toEqual({ status: 409, error: "already_resolved" });
    expect(w.row(`SYNC#CONFLICT#${CID(1)}`).decision).toBe("keep_desktop");
    for (const id of [CID(9), "short", "01J!!!!!!!!!!!!!!!!!!!!!!!"]) expect(err(await decide(w, id)), id).toEqual({ status: 404, error: "not_found" });
    w.ddb.rows.set(`SYNC#CONFLICT#${CID(2)}\u0000META`, conflictRow(2));
    for (const body of [{}, { decision: "maybe" }, { decision: 1 }]) expect(err(await decide(w, CID(2), body)), JSON.stringify(body)).toEqual({ status: 400, error: "validation" });
    expect(w.row(`SYNC#CONFLICT#${CID(2)}`).state).toBe("open");
  });
  it("a dismissed conflict is already resolved too, and a decision on a vanished record stores a null cloud_version", async () => {
    const w = world();
    w.ddb.rows.set(`SYNC#CONFLICT#${CID(1)}\u0000META`, conflictRow(1, { state: "dismissed", GSI1PK: "SYNCCONFLICT#dismissed" }));
    expect(err(await decide(w))).toEqual({ status: 409, error: "already_resolved" });
    w.ddb.rows.set(`SYNC#CONFLICT#${CID(2)}\u0000META`, conflictRow(2, { handle: h(77) }));
    expect((await decide(w, CID(2), { decision: "manual" })).body).toMatchObject({ decision: "manual", cloud_version: null });
  });
});

// ---- HFY-TSK-338 (sync-conflict-decision-apply, SI-30): reconcile on a pull ---------------------------------------------------
describe("POST /api/sync/conflicts/reconcile applies a decision only while the cloud still matches (SI-30, AC1)", () => {
  const named = (first) => person(1, { primary_name: { ...person(1).primary_name, first_name: first } });
  /** One pushed person whose first name is the conflict's cloud value, and one open conflict about it. */
  const seeded = async (w) => {
    await w.push([create(named("Birch"))]);
    w.ddb.rows.set(`SYNC#CONFLICT#${CID(1)}\u0000META`, conflictRow(1));
  };
  const decide = (w, id = CID(1), decision = "keep_cloud") => w.call("POST", `/sync/conflicts/${id}/decision`, { body: { decision } });
  const reconcile = (w, body, o = {}) => w.call("POST", "/sync/conflicts/reconcile", { ...(body !== undefined ? { body } : {}), ...o });
  const stored = (w, n = 1) => w.row(`SYNC#CONFLICT#${CID(n)}`);
  const touch = (w, fn) => { const k = `REC#Person#${person(1).handle}\u0000HEAD`; w.ddb.rows.set(k, fn(w.ddb.rows.get(k))); };

  it("a decision whose version and value hash both match is returned in apply and left resolved", async () => {
    const w = world();
    await seeded(w);
    expect((await decide(w)).status).toBe(200);
    const r = await reconcile(w);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ checked: 1, reopened: [], more: false });
    expect(r.body.apply.map((c) => [c.id, c.decision, c.state, c.cloud_version])).toEqual([[CID(1), "keep_cloud", "resolved", 1]]);
    expect(stored(w)).toMatchObject({ state: "resolved", decision: "keep_cloud", GSI1PK: "SYNCCONFLICT#resolved" });
    expect(w.rows("AUDIT#conflict:").map((a) => a.op)).toEqual(["sync.conflict.decide"]);
  });
  it("a version mismatch (the record moved after the decision) reopens the conflict, keeps the old decision as history and applies nothing", async () => {
    const w = world();
    await seeded(w);
    await decide(w, CID(1), "keep_desktop");
    const before = stored(w);
    await w.push([{ op: "update", class: "Person", handle: person(1).handle, base_version: 1, obj: named("Birch") }]); // the same value at a new version
    const r = await reconcile(w);
    expect(r.body).toMatchObject({ checked: 1, apply: [] });
    expect(r.body.reopened).toHaveLength(1);
    const row = stored(w);
    expect(row).toMatchObject({ state: "open", GSI1PK: "SYNCCONFLICT#open", reopened_at: new Date(NOW).toISOString() });
    for (const k of ["decision", "cloud_version", "cloud_value_hash", "resolved_at", "by"]) expect(row, k).not.toHaveProperty(k);
    expect(row.history).toEqual([{ decision: "keep_desktop", cloud_version: 1, cloud_value_hash: before.cloud_value_hash, resolved_at: before.resolved_at, by: OWNER, reopened_at: new Date(NOW).toISOString(), reason: "version_changed" }]);
    expect(r.body.reopened[0]).toMatchObject({ id: CID(1), state: "open", decision: null, reopened_at: new Date(NOW).toISOString() });
    expect(w.rows("AUDIT#conflict:").map((a) => a.op).sort()).toEqual(["sync.conflict.decide", "sync.conflict.reopen"]);
    // it is back in the open queue, with the note the admin page shows, and a second reconcile finds nothing to do
    const open = await w.call("GET", "/sync/conflicts");
    expect(open.body.conflicts.map((c) => [c.id, c.state, c.history[0].reason])).toEqual([[CID(1), "open", "version_changed"]]);
    expect((await reconcile(w)).body).toMatchObject({ checked: 0, apply: [], reopened: [] });
  });
  it("a hash mismatch at the same version reopens it: the head's own value at the path differs from the one decided on, and the add-on's word cannot say otherwise", async () => {
    // the head alone: an in-place scrub keeps the version and changes the value
    const w2 = world();
    await seeded(w2);
    await decide(w2);
    touch(w2, (row) => ({ ...row, obj_json: JSON.stringify(named("Elm")) }));
    const r2 = await reconcile(w2);
    expect(r2.body.reopened.map((c) => [c.id, c.history.at(-1).reason])).toEqual([[CID(1), "value_changed"]]);
    expect(stored(w2).state).toBe("open");
    // the add-on's `observed` value never overrides a pointer the head resolves: a crafted one cannot make a valid decision look stale (or a stale one valid)
    const w = world();
    await seeded(w);
    await decide(w);
    const crafted = [{ class: "Person", handle: person(1).handle, path: "/primary_name/first_name", cloud: "Elm" }];
    const r = await reconcile(w, { observed: crafted });
    expect(r.body.reopened).toEqual([]);
    expect(r.body.apply.map((c) => c.id)).toEqual([CID(1)]);
    const w3 = world();
    await seeded(w3);
    await decide(w3);
    touch(w3, (row) => ({ ...row, obj_json: JSON.stringify(named("Elm")) }));
    const r3 = await reconcile(w3, { observed: [{ ...crafted[0], cloud: "Birch" }] });
    expect(r3.body.reopened.map((c) => c.reason)).toEqual(["value_changed"]);
  });
  it("a pointer the head cannot resolve (a keyed-list token) takes the add-on's observed value, else keeps the stored one", async () => {
    const w = world();
    await seeded(w);
    w.ddb.rows.set(`SYNC#CONFLICT#${CID(2)}\u0000META`, conflictRow(2, { paths: [{ path: "/event_ref_list/ref#0", base: "a", cloud: "b", desktop: "c" }] }));
    await decide(w);
    await decide(w, CID(2));
    const at = { class: "Person", handle: person(1).handle, path: "/event_ref_list/ref#0" };
    const same = await reconcile(w, { dry: true, observed: [{ ...at, cloud: "b" }] });
    expect(same.body.apply.map((c) => c.id).sort()).toEqual([CID(1), CID(2)]);
    expect(same.body.reopened).toEqual([]);
    expect((await reconcile(w, { dry: true })).body.apply.map((c) => c.id).sort()).toEqual([CID(1), CID(2)]); // nothing observed: the stored value stands
    const other = await reconcile(w, { observed: [{ ...at, cloud: "z" }] });
    expect(other.body.apply.map((c) => c.id)).toEqual([CID(1)]);
    expect(other.body.reopened.map((c) => [c.id, c.reason])).toEqual([[CID(2), "value_changed"]]);
  });
  it("dry: true (a check run) reports what it would reopen and writes nothing", async () => {
    const w = world();
    await seeded(w);
    await decide(w);
    await w.push([{ op: "update", class: "Person", handle: person(1).handle, base_version: 1, obj: named("Birch") }]);
    const before = JSON.stringify(stored(w));
    const r = await reconcile(w, { dry: true });
    expect(r.body).toMatchObject({ dry: true, checked: 1, apply: [] });
    expect(r.body.reopened.map((c) => [c.id, c.state, c.reason])).toEqual([[CID(1), "resolved", "version_changed"]]);
    expect(JSON.stringify(stored(w))).toBe(before);
    expect(w.rows("AUDIT#conflict:").map((a) => a.op)).toEqual(["sync.conflict.decide"]);
    expect((await reconcile(w)).body.reopened.map((c) => c.state)).toEqual(["open"]); // the real call reopens it
  });
  it("a missing hash (a decision stored without one) reopens it: nothing proves what it was made against", async () => {
    const w = world();
    await seeded(w);
    for (const [n, extra] of [[1, {}], [2, { cloud_value_hash: "not-a-hash" }], [3, { cloud_value_hash: null }]]) {
      w.ddb.rows.set(`SYNC#CONFLICT#${CID(n)}\u0000META`, conflictRow(n, { state: "resolved", GSI1PK: "SYNCCONFLICT#resolved", decision: "keep_cloud", cloud_version: 1, resolved_at: "2026-10-14T00:00:00.000Z", by: OWNER, ...extra }));
    }
    const r = await reconcile(w);
    expect(r.body.apply).toEqual([]);
    expect(r.body.reopened.map((c) => [c.id, c.reason])).toEqual([[CID(3), "no_hash"], [CID(2), "no_hash"], [CID(1), "no_hash"]]);
  });
  it("decisionStaleReason names the first reason and cloudValueAt follows pointers, reads absent members as null and gives up on keyed-list tokens", () => {
    const paths = [{ path: "/x", cloud: "one" }];
    const ok = { state: "resolved", cloud_version: 4, cloud_value_hash: cloudValueHash(paths) };
    expect(decisionStaleReason(ok, { version: 4, paths })).toBeNull();
    expect(decisionStaleReason({ ...ok, state: "open" }, { version: 4, paths })).toBe("not_resolved");
    expect(decisionStaleReason({ ...ok, cloud_value_hash: undefined }, { version: 4, paths })).toBe("no_hash");
    expect(decisionStaleReason(ok, { version: 5, paths })).toBe("version_changed");
    expect(decisionStaleReason(ok, { version: null, paths })).toBe("version_changed");
    expect(decisionStaleReason(ok, { version: 4, paths: [{ path: "/x", cloud: "two" }] })).toBe("value_changed");
    const obj = { a: { b: ["z", { c: 1 }] }, "k/l": 2 };
    expect(cloudValueAt(obj, "/a/b/1/c")).toEqual({ value: 1 });
    expect(cloudValueAt(obj, "/k~1l")).toEqual({ value: 2 });
    expect(cloudValueAt(obj, "/a/nothing/deeper")).toEqual({ value: null });
    expect(cloudValueAt(obj, "/a/b/9")).toEqual({ value: null });
    expect(cloudValueAt(obj, "/a/b/ref#0")).toBeNull();
    expect(cloudValueAt(obj, "/_birth_ref")).toBeNull();
    expect(cloudValueAt(obj, "")).toEqual({ value: obj });
    expect(cloudValueAt(obj, "no-slash")).toBeNull();
  });
  it("a manual decision, an open conflict and an applied one are not offered; the receipt is idempotent, a keep_desktop push does not reopen an applied decision", async () => {
    const w = world();
    await seeded(w);
    w.ddb.rows.set(`SYNC#CONFLICT#${CID(2)}\u0000META`, conflictRow(2));
    w.ddb.rows.set(`SYNC#CONFLICT#${CID(3)}\u0000META`, conflictRow(3));
    await decide(w, CID(1), "keep_desktop");
    await decide(w, CID(3), "manual");
    expect((await reconcile(w)).body.apply.map((c) => c.id)).toEqual([CID(1)]);
    const ack = await w.call("POST", `/sync/conflicts/${CID(1)}/applied`, { body: { outcome: "applied" } });
    expect(ack.status).toBe(200);
    expect(ack.body).toMatchObject({ id: CID(1), state: "resolved", applied_at: new Date(NOW).toISOString() });
    expect(stored(w)).toMatchObject({ applied_outcome: "applied" });
    expect((await w.call("POST", `/sync/conflicts/${CID(1)}/applied`, {})).status).toBe(200); // again: the same receipt
    expect(w.rows("AUDIT#conflict:").filter((a) => a.op === "sync.conflict.applied")).toHaveLength(1);
    await w.push([{ op: "update", class: "Person", handle: person(1).handle, base_version: 1, obj: named("Cedar") }]); // the add-on's own push moved the head
    expect((await reconcile(w)).body).toMatchObject({ checked: 0, apply: [], reopened: [] });
    expect(stored(w).state).toBe("resolved");
  });
  it("a keep_desktop decision whose own push carried the chosen value is settled, not reopened: it is stamped applied (a dry run only reports it)", async () => {
    const w = world();
    await seeded(w);
    await decide(w, CID(1), "keep_desktop");
    await w.push([{ op: "update", class: "Person", handle: person(1).handle, base_version: 1, obj: named("Cedar") }]); // the desktop value, at version 2
    const dry = await reconcile(w, { dry: true });
    expect(dry.body).toMatchObject({ apply: [], reopened: [], dry: true });
    expect(dry.body.settled.map((c) => c.id)).toEqual([CID(1)]);
    expect(stored(w).applied_at).toBeUndefined();
    const r = await reconcile(w);
    expect(r.body).toMatchObject({ checked: 1, apply: [], reopened: [] });
    expect(r.body.settled.map((c) => [c.id, c.state, c.applied_at])).toEqual([[CID(1), "resolved", new Date(NOW).toISOString()]]);
    expect(stored(w)).toMatchObject({ state: "resolved", applied_outcome: "applied" });
    expect(w.rows("AUDIT#conflict:").filter((a) => a.op === "sync.conflict.applied")).toHaveLength(1);
    expect((await reconcile(w)).body).toMatchObject({ checked: 0, settled: [] });
    // the receipt that arrives later is the same stamp
    expect((await w.call("POST", `/sync/conflicts/${CID(1)}/applied`, {})).status).toBe(200);
    expect(w.rows("AUDIT#conflict:").filter((a) => a.op === "sync.conflict.applied")).toHaveLength(1);
  });
  it("settling needs the desktop value in the head at every path: another value, a keep_cloud decision or a path the server cannot follow still reopens", async () => {
    const w = world();
    await seeded(w);
    w.ddb.rows.set(`SYNC#CONFLICT#${CID(2)}\u0000META`, conflictRow(2));
    w.ddb.rows.set(`SYNC#CONFLICT#${CID(3)}\u0000META`, conflictRow(3, { paths: [{ path: "/event_ref_list/ref#0", base: "a", cloud: "b", desktop: "c" }] }));
    await decide(w, CID(1), "keep_desktop");
    await decide(w, CID(2), "keep_cloud");
    await decide(w, CID(3), "keep_desktop");
    await w.push([{ op: "update", class: "Person", handle: person(1).handle, base_version: 1, obj: named("Cedar") }]);
    const r = await reconcile(w);
    expect(r.body.settled.map((c) => c.id)).toEqual([CID(1)]);
    expect(r.body.reopened.map((c) => [c.id, c.reason]).sort()).toEqual([[CID(2), "version_changed"], [CID(3), "version_changed"]]);
    const w2 = world();
    await seeded(w2);
    await decide(w2, CID(1), "keep_desktop");
    await w2.push([{ op: "update", class: "Person", handle: person(1).handle, base_version: 1, obj: named("Elm") }]); // neither the cloud value decided against nor the desktop's
    expect((await reconcile(w2)).body).toMatchObject({ settled: [], reopened: [{ id: CID(1), reason: "version_changed" }] });
  });
  it("walks a long backlog in calls: a cursor for the rest, and an older pending decision behind more than 500 applied ones is still found", async () => {
    const w = world();
    await seeded(w);
    await decide(w); // CID(1): pending, the oldest
    const total = 520;
    for (let n = 0; n < total; n += 1) {
      const id = CID(1000 + n);
      w.ddb.rows.set(`SYNC#CONFLICT#${id}\u0000META`, conflictRow(2, {
        ...conflictKey(id), GSI1PK: "SYNCCONFLICT#resolved", GSI1SK: `2026-10-14T00:${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}.000Z#${id}`,
        state: "resolved", decision: "keep_cloud", applied_at: "2026-10-14T01:00:00.000Z", applied_outcome: "applied",
      }));
    }
    const first = await reconcile(w, { dry: true });
    expect(first.body).toMatchObject({ checked: 0, more: true });
    expect(typeof first.body.next).toBe("string");
    const second = await reconcile(w, { dry: true, after: first.body.next });
    expect(second.body.apply.map((c) => c.id)).toEqual([CID(1)]);
    expect(second.body).toMatchObject({ more: false, next: null });
    expect(err(await reconcile(w, { after: "not a cursor" }))).toEqual({ status: 400, error: "bad_cursor" });
    expect(err(await reconcile(w, { after: 5 }))).toEqual({ status: 400, error: "validation" });
  });
  it("a call weighs at most RECONCILE_ITEMS decisions and hands back a cursor; a reopened one leaves the queue, so the next call goes on past it", async () => {
    const w = world();
    await seeded(w);
    const total = RECONCILE_ITEMS + 10;
    for (let n = 0; n < total; n += 1) {
      const id = CID(2000 + n);
      w.ddb.rows.set(`SYNC#CONFLICT#${id}\u0000META`, conflictRow(2, {
        ...conflictKey(id), GSI1PK: "SYNCCONFLICT#resolved", GSI1SK: `2026-10-14T00:00:${String(n).padStart(2, "0")}.000Z#${id}`, state: "resolved", decision: "keep_cloud", cloud_version: 1, resolved_at: "2026-10-14T00:00:00.000Z",
      })); // no hash: each is reopened
    }
    const a = await reconcile(w);
    expect(a.body).toMatchObject({ checked: RECONCILE_ITEMS, more: true, failed: 0 });
    expect(a.body.reopened).toHaveLength(RECONCILE_ITEMS);
    const b = await reconcile(w, { after: a.body.next });
    expect(b.body).toMatchObject({ checked: 10, more: false, next: null });
    expect(b.body.reopened).toHaveLength(10);
    expect(w.rows("SYNC#CONFLICT#").filter((r) => r.state === "resolved")).toHaveLength(0);
  });
  it("one decision that cannot be written does not stop the others: it is counted in failed and offered again on the next call", async () => {
    const w = world();
    await seeded(w);
    for (const n of [1, 2, 3]) {
      w.ddb.rows.set(`SYNC#CONFLICT#${CID(n)}\u0000META`, conflictRow(n, { state: "resolved", GSI1PK: "SYNCCONFLICT#resolved", decision: "keep_cloud", cloud_version: 1, resolved_at: "2026-10-14T00:00:00.000Z" }));
    }
    w.ddb.failNext("ThrottlingError", 1); // the first reopen (the newest, CID(3)) is refused by the store
    const r = await reconcile(w);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ checked: 3, failed: 1 });
    expect(r.body.reopened.map((c) => c.id)).toEqual([CID(2), CID(1)]);
    expect(stored(w, 3).state).toBe("resolved");
    const again = await reconcile(w);
    expect(again.body).toMatchObject({ checked: 1, failed: 0 });
    expect(again.body.reopened.map((c) => c.id)).toEqual([CID(3)]);
  });
  it("the receipt: 409 not_resolved for an open or reopened conflict, 404 for an unknown id, 400 for a bad outcome; moot is accepted", async () => {
    const w = world();
    await seeded(w);
    expect(err(await w.call("POST", `/sync/conflicts/${CID(1)}/applied`, {}))).toEqual({ status: 409, error: "not_resolved" });
    expect(err(await w.call("POST", `/sync/conflicts/${CID(9)}/applied`, {}))).toEqual({ status: 404, error: "not_found" });
    expect(err(await w.call("POST", "/sync/conflicts/short/applied", {}))).toEqual({ status: 404, error: "not_found" });
    await decide(w);
    expect(err(await w.call("POST", `/sync/conflicts/${CID(1)}/applied`, { body: { outcome: "later" } }))).toEqual({ status: 400, error: "validation" });
    expect((await w.call("POST", `/sync/conflicts/${CID(1)}/applied`, { body: { outcome: "moot" } })).body.applied_at).toBe(new Date(NOW).toISOString());
    expect(stored(w).applied_outcome).toBe("moot");
  });
  it("a reopened conflict can be decided again, and its history keeps every earlier decision", async () => {
    const w = world();
    await seeded(w);
    await decide(w, CID(1), "keep_cloud");
    await w.push([{ op: "update", class: "Person", handle: person(1).handle, base_version: 1, obj: named("Cedar") }]);
    await reconcile(w);
    const again = await decide(w, CID(1), "keep_desktop");
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ state: "resolved", decision: "keep_desktop", cloud_version: 2 });
    expect(again.body.history).toHaveLength(1);
    expect(stored(w).history[0]).toMatchObject({ decision: "keep_cloud", reason: "version_changed" });
  });
  it("is a sync-bearer route that works while the store is paused; a bad body is 400, no sign-in is 401, a non-owner 403, the switch off 404", async () => {
    const w = world({ head: { writes_enabled: false } });
    expect((await reconcile(w)).status).toBe(200);
    for (const body of [{ observed: "x" }, { after: 7 }, { observed: [{ class: "Nope", handle: "a", path: "/x" }] }, { observed: [{ class: "Person", handle: "a", path: 3 }] }, { observed: new Array(501).fill({ class: "Person", handle: "a", path: "/x" }) }, { dry: "yes" }]) {
      expect(err(await reconcile(w, body)), JSON.stringify(body).slice(0, 40)).toEqual({ status: 400, error: "validation" });
    }
    expect(err(await reconcile(w, undefined, { tok: "" }))).toEqual({ status: 401, error: "unauthenticated" });
    expect(err(await reconcile(w, undefined, { tok: await token({ sub: "I0099" }) }))).toEqual({ status: 403, error: "not_owner" });
    process.env.SYNC_API_ENABLED = "0";
    expect((await reconcile(w)).status).toBe(404);
  });
});

describe("the decision rule agrees with the add-on's, row for row (HFY-TSK-338)", () => {
  const vectors = JSON.parse(readFileSync(new URL("../../gramps/tests/fixtures/conflict-decision.vectors.json", import.meta.url), "utf8"));
  it("hashes the vectors the add-on's decisions.py hashes", () => {
    expect(vectors.format).toBe("conflict-decision-v1");
    expect(vectors.hashes.length).toBeGreaterThanOrEqual(8);
    for (const v of vectors.hashes) expect(cloudValueHash(v.paths), v.title).toBe(v.hash);
  });
  it("follows the pointers the add-on follows and gives up where it gives up", () => {
    for (const c of vectors.pointers.cases) {
      const r = cloudValueAt(vectors.pointers.object, c.path);
      expect(r === null, c.path).toBe(c.unresolved);
      if (r !== null) expect(r.value, c.path).toEqual(c.value);
    }
  });
  it("names the same stale reason", () => {
    for (const v of vectors.stale) expect(decisionStaleReason(v.decision, v.current), v.title).toBe(v.reason);
  });
});
