// HFY-TSK-277 (changes-feed): GET /api/sync/changes, the ARCH-B dense change feed, on the sync-bearer middleware. In-memory DynamoDB fake, a local
// JWKS, a fake S3, synthetic objects and subjects only. Shares its world with sync-pull.test.js (copied, not imported, like the other sync suites).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SignJWT, importPKCS8 } from "jose";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { makeApi, pem, ISSUER, signToken } from "./world.js";
import { buildCaps } from "../src/routes.js";
import { createGroupResolver } from "../src/policy.js";
import { SYNC_AUDIENCE, SYNC_CLIENT_ID, createSyncAuthenticator, requireConflictDecision } from "../src/sync/auth.js";
import { createHookRegistry } from "../src/sync/hooks.js";
import { entryView, headKey } from "../src/sync/store.js";
import { buildSnapshot, snapshotKey } from "../src/sync/pull.js";
import { MAX_LIMIT, RESPONSE_OBJ_BYTES, changeOp } from "../src/sync/changes.js";
import { canonicalJson } from "../src/shared/canonical.mjs";
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
  const headRow = head === null ? undefined : { ...headKey(), seq: 0, seeded: true, writes_enabled: true, merges_enabled: false, changes_feed: true, tree_id: TREE, bound: BOUND, live_heads: 1000, ...(head ?? {}) };
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


/** `q` is a query string such as "?since=2&limit=5"; the test world takes it as the parsed queryStringParameters. */
const feed = (w, q = "") => w.call("GET", "/sync/changes", { query: Object.fromEntries(new URLSearchParams(q.replace(/^\?/, ""))) });
const SAFE_KEYS = ["at", "class", "gramps_id", "handle", "hash", "obj", "op", "origin", "seq", "version"];

/**
 * The fold a client applies: what the add-on's delta module does, over {class#handle: head}. An entry the feed marks `expunged` is a tombstone that keeps
 * the flag (the add-on's snapshot.Head.expunged, which a cache built from a snapshot after an expunge holds), because buildSnapshot writes it into the line.
 */
function fold(state, ops) {
  for (const o of ops) {
    if (o.op === "marker") continue;
    const k = `${o.class}#${o.handle}`;
    const old = state.get(k);
    const live = (o.op === "create" || o.op === "update") && o.obj !== null && o.expunged !== true;
    state.set(k, { class: o.class, handle: o.handle, gramps_id: o.gramps_id || old?.gramps_id || "", version: o.version, seq: o.seq, deleted: !live, ...(o.expunged === true ? { expunged: true } : {}), obj: live ? o.obj : null });
  }
  return state;
}

describe("the route exists, dark, on the sync-bearer middleware", () => {
  it("caps.json lists sync.changes as a sync-bearer GET behind SYNC_API_ENABLED, with no MCP tool", () => {
    const a = buildCaps().actions.find((x) => x.name === "sync.changes");
    expect(a).toMatchObject({ method: "GET", path: "/api/sync/changes", auth: "sync-bearer", gate: { switch: "SYNC_API_ENABLED" } });
    expect(buildCaps().mcp.tools.map((t) => t.action)).not.toContain("sync.changes");
  });
  it("is 404 not_enabled until SYNC#HEAD.changes_feed is the boolean true, and by SYNC_API_ENABLED off before that", async () => {
    for (const v of [undefined, false, "true", 1, "1"]) {
      const w = world({ head: { seq: 1, changes_feed: v } });
      expect(err(await feed(w)), String(v)).toEqual({ status: 404, error: "not_enabled" });
    }
    expect((await feed(world())).status).toBe(200);
    process.env.SYNC_API_ENABLED = "0";
    expect(err(await feed(world()))).toEqual({ status: 404, error: "not_enabled" });
  });
  it("S01 to S04: 401 without a sync bearer, 403 not_owner for a non-owner, 426 for an old client, 403 tree_mismatch for another tree", async () => {
    const w = world();
    for (const tok of ["", "garbage", await signToken("I0099")]) expect(err(await w.call("GET", "/sync/changes", { tok }))).toEqual({ status: 401, error: "unauthenticated" });
    for (const sub of [OTHER, "I0099"]) expect(err(await w.call("GET", "/sync/changes", { tok: await token({ sub }) }))).toEqual({ status: 403, error: "not_owner" });
    expect(err(await w.call("GET", "/sync/changes", { hs: { ...HS, "x-hfy-sync-client": "hfy_sync/0.0.1" } }))).toEqual({ status: 426, error: "upgrade_required" });
    expect(err(await w.call("GET", "/sync/changes", { tree: "00000000-0000-4000-8000-0000000000ff" }))).toEqual({ status: 403, error: "tree_mismatch" });
  });
  it("a paused store (writes_enabled false) still serves the feed", async () => {
    expect((await feed(world({ head: { writes_enabled: false } }))).status).toBe(200);
  });
  it("/api/sync/meta reports changes_feed and expunge_epoch (both off and 0 by default)", async () => {
    const off = (await world({ head: { changes_feed: false } }).call("GET", "/sync/meta")).body;
    expect(off).toMatchObject({ changes_feed: false, expunge_epoch: 0 });
    const on = (await world({ head: { changes_feed: true, expunge_epoch: 3 } }).call("GET", "/sync/meta")).body;
    expect(on).toMatchObject({ changes_feed: true, expunge_epoch: 3 });
  });
});

describe("GET /api/sync/changes (AC1)", () => {
  it("returns dense ops from SYNC#LOG with head_seq and next_since, tombstones as obj null, and only the safe fields", async () => {
    const w = world();
    const a = person(1);
    await w.push([create(a), create(note(1))]);
    await w.push([{ op: "update", class: "Person", handle: a.handle, base_version: 1, obj: person(1, { gender: 0 }) }]);
    await w.push([del("Note", h(2001), 1)]);
    const r = await feed(w, "?since=0");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ head_seq: 4, next_since: 4, dense: true, expunge_epoch: 0 });
    expect(r.body.ops.map((o) => [o.seq, o.op, o.class, o.version])).toEqual([[1, "create", "Person", 1], [2, "create", "Note", 1], [3, "update", "Person", 2], [4, "delete", "Note", 2]]);
    for (const o of r.body.ops) expect(Object.keys(o).sort(), String(o.seq)).toEqual(SAFE_KEYS);
    expect(r.body.ops[2].obj.gender).toBe(0);
    expect(r.body.ops[2].hash).toBe(createHash("sha256").update(canonicalJson(r.body.ops[2].obj)).digest("hex"));
    expect(r.body.ops[3]).toMatchObject({ op: "delete", handle: h(2001), gramps_id: "N0001", version: 2, obj: null, hash: null }); // a tombstone keeps its id and version
    expect(JSON.stringify(r.body)).not.toMatch(/principal|batch_id|on_behalf_of/);
  });

  it("a marker (a push session close) is an op with a null class, handle and object, so the seqs stay dense", async () => {
    const w = world();
    const a = person(1);
    const open = await w.call("POST", "/sync/sessions", { body: { expected: [`Person#${a.handle}`] } });
    expect(open.status).toBe(201);
    expect((await w.call("POST", "/sync/batches", { idem: "k-s", body: { session_id: open.body.session_id, ops: [create(a)] } })).status).toBe(200);
    expect((await w.call("POST", `/sync/sessions/${open.body.session_id}/complete`, { body: {} })).status).toBe(200);
    const r = await feed(w);
    expect(r.body.ops.map((o) => [o.seq, o.op])).toEqual([[1, "create"], [2, "marker"]]);
    expect(r.body.ops[1]).toMatchObject({ class: null, handle: null, version: null, obj: null, hash: null });
    expect(r.body.ops.map((o) => o.seq)).toEqual([1, 2]);
  });

  it("starts after `since` and pages by limit with next_since; since at the head is an empty page", async () => {
    const w = world();
    for (let i = 1; i <= 5; i += 1) await w.push([create(person(i))]);
    const p1 = (await feed(w, "?since=0&limit=2")).body;
    expect(p1).toMatchObject({ head_seq: 5, next_since: 2 });
    expect(p1.ops.map((o) => o.seq)).toEqual([1, 2]);
    const p2 = (await feed(w, `?since=${p1.next_since}&limit=2`)).body;
    expect(p2.ops.map((o) => o.seq)).toEqual([3, 4]);
    const p3 = (await feed(w, `?since=${p2.next_since}&limit=2`)).body;
    expect(p3).toMatchObject({ next_since: 5, head_seq: 5 });
    expect(p3.ops.map((o) => o.seq)).toEqual([5]);
    const end = (await feed(w, "?since=5")).body;
    expect(end).toMatchObject({ ops: [], head_seq: 5, next_since: 5, dense: true });
    expect((await feed(w)).body.ops).toHaveLength(5); // since defaults to 0
  });

  it("a since greater than the head is 400 bad_cursor (and names the head), never an empty success", async () => {
    const w = world();
    await w.push([create(person(1))]);
    const r = await feed(w, "?since=2");
    expect(err(r)).toEqual({ status: 400, error: "bad_cursor" });
    expect(r.body.details).toMatchObject({ head_seq: 1 });
    expect(err(await feed(world(), "?since=1"))).toEqual({ status: 400, error: "bad_cursor" });
  });

  it("S05: a since or limit that is not a whole number in range is 400 validation", async () => {
    const w = world();
    await w.push([create(person(1))]);
    for (const q of ["?since=abc", "?since=-1", "?since=1.5", "?since=", "?limit=0", `?limit=${MAX_LIMIT + 1}`, "?limit=x"]) {
      const r = await feed(w, q);
      expect(r.status, q).toBe(q === "?since=" ? 200 : 400);
      if (r.status === 400) expect(r.body.error, q).toBe("validation");
    }
  });

  it("S19: an expunged entry returns obj null and expunged true, keeps its seq, version and hash, and carries no value (HFY-TSK-204 AC5)", async () => {
    const w = world();
    const a = person(1);
    await w.push([create(a), create(person(2))]);
    const logRow = w.rows("SYNC#LOG")[0];
    expect(typeof logRow.hash).toBe("string");
    w.ddb.rows.set(`${logRow.PK}\u0000${logRow.SK}`, { ...logRow, obj_json: null, expunged: true });
    const r = await feed(w);
    expect(r.body.ops[0]).toMatchObject({ seq: 1, op: "create", handle: a.handle, version: 1, obj: null, hash: logRow.hash, expunged: true });
    expect(JSON.stringify(r.body.ops[0])).not.toContain("Alder"); // the scrubbed value is gone from the feed
    expect(r.body.ops[1].obj).not.toBeNull();
    expect(r.body.ops[1].expunged).toBeUndefined();
    expect(changeOp({ seq: 9, op: "delete", class: "Note", handle: h(1), gramps_id: "N1", version: 3, obj_json: null, expunged: true, at: "t", origin: "desktop" })).toMatchObject({ expunged: true, obj: null, hash: null });
  });

  it("the feed serialises a log entry through entryView(): the same seq, class, handle, id, version, hash and object, plus the op, time and origin", async () => {
    const w = world();
    const a = person(1);
    await w.push([create(a), create(note(1))]);
    // an expunged and a live entry, so both shapes of entryView are compared with what the route returns
    const expungedRow = w.rows("SYNC#LOG")[0];
    w.ddb.rows.set(`${expungedRow.PK}\u0000${expungedRow.SK}`, { ...expungedRow, obj_json: null, expunged: true });
    const ops = (await feed(w)).body.ops;
    for (const op of ops) {
      const row = w.rows("SYNC#LOG").find((x) => x.seq === op.seq);
      const v = entryView(row);
      expect(op).toMatchObject({ seq: v.seq, class: v.class, handle: v.handle, gramps_id: v.gramps_id, version: v.version, hash: v.hash, obj: v.obj, at: row.at, origin: row.origin });
      expect(op.expunged).toBe(v.expunged);
    }
    expect(ops.map((o) => o.expunged)).toEqual([true, undefined]);
  });

  it("a --path scrub (the object inside the entry rewritten with its hash, no expunged flag) is an ordinary op whose hash is that of the scrubbed object", async () => {
    const w = world();
    const n = note(1);
    await w.push([create(n)]);
    const row = w.rows("SYNC#LOG")[0];
    const scrubbed = canonicalJson({ ...n, text: { ...n.text, string: "" } });
    const hash = createHash("sha256").update(scrubbed).digest("hex");
    w.ddb.rows.set(`${row.PK}\u0000${row.SK}`, { ...row, obj_json: scrubbed, hash });
    const op = (await feed(w)).body.ops[0];
    expect(op).toMatchObject({ seq: 1, version: 1, hash, obj: { text: { string: "" } } });
    expect(op).not.toHaveProperty("expunged");
    expect(createHash("sha256").update(canonicalJson(op.obj)).digest("hex")).toBe(op.hash);
  });

  it("the epoch of an expunge that did not move seq is in the response, so a cached client can tell", async () => {
    const w = world({ head: { seq: 0, expunge_epoch: 0 } });
    await w.push([create(person(1))]);
    expect((await feed(w, "?since=1")).body.expunge_epoch).toBe(0);
    w.ddb.rows.set("SYNC#HEAD\u0000META", { ...w.row("SYNC#HEAD"), expunge_epoch: 2 });
    expect((await feed(w, "?since=1")).body).toMatchObject({ expunge_epoch: 2, ops: [], next_since: 1 });
  });

  it("a hole in the log is 410 gap_too_large (take a snapshot), at the start, in the middle and at the end of a page", async () => {
    for (const hole of [1, 2, 3]) {
      const w = world();
      await w.push([create(person(1)), create(person(2)), create(person(3))]);
      const row = w.rows("SYNC#LOG").find((r) => r.seq === hole);
      w.ddb.rows.delete(`${row.PK}\u0000${row.SK}`);
      expect(err(await feed(w)), `hole at ${hole}`).toEqual({ status: 410, error: "gap_too_large" });
    }
  });

  it("a page stops before it passes the byte budget but always holds one op, and next_since resumes at the next", async () => {
    const w = world({ head: { seq: 4 } });
    const big = "x".repeat(Math.floor(RESPONSE_OBJ_BYTES / 2) + 10);
    for (let s = 1; s <= 4; s += 1) {
      const obj = note(s, { text: { _class: "StyledText", string: big, tags: [] } });
      w.ddb.rows.set(`SYNC#LOG\u0000${String(s).padStart(12, "0")}`, {
        PK: "SYNC#LOG", SK: String(s).padStart(12, "0"), entity: "change", seq: s, op: "create", class: "Note", handle: obj.handle, gramps_id: obj.gramps_id, version: 1, obj_json: canonicalJson(obj), hash: "0".repeat(64), principal: "p", origin: "desktop", at: "2026-10-14T12:00:00.000Z",
      });
    }
    const got = [];
    let since = 0;
    for (let page = 0; page < 6 && since < 4; page += 1) {
      const r = (await feed(w, `?since=${since}&limit=500`)).body;
      expect(r.ops.length).toBeGreaterThan(0);
      expect(r.ops.length).toBeLessThan(3);
      got.push(...r.ops.map((o) => o.seq));
      since = r.next_since;
    }
    expect(got).toEqual([1, 2, 3, 4]);
  });
});

describe("the page budget counts UTF-8 bytes, not characters", () => {
  it("a page of multi-byte text stops at the byte budget", async () => {
    const w = world({ head: { seq: 4 } });
    const wide = "\u3042".repeat(Math.floor(RESPONSE_OBJ_BYTES / 3 / 2) + 10); // 3 bytes each
    for (let s = 1; s <= 4; s += 1) {
      const obj = note(s, { text: { _class: "StyledText", string: wide, tags: [] } });
      w.ddb.rows.set(`SYNC#LOG\u0000${String(s).padStart(12, "0")}`, {
        PK: "SYNC#LOG", SK: String(s).padStart(12, "0"), entity: "change", seq: s, op: "create", class: "Note", handle: obj.handle, gramps_id: obj.gramps_id, version: 1, obj_json: canonicalJson(obj), hash: "0".repeat(64), principal: "p", origin: "desktop", at: "2026-10-14T12:00:00.000Z",
      });
    }
    const r = (await feed(w, "?since=0&limit=500")).body;
    expect(Buffer.byteLength(wide) * 2).toBeGreaterThan(RESPONSE_OBJ_BYTES); // two objects are over the budget in bytes ...
    expect(wide.length * 4).toBeLessThan(RESPONSE_OBJ_BYTES); // ... while all four are under it counted in characters
    expect(r.ops.length).toBe(1);
    expect(r.next_since).toBe(1);
  });
});

describe("a delta and a snapshot give the same state (AC3, server side)", () => {
  it("folding the feed reproduces the snapshot byte for byte: creates, updates, a delete, a withdraw, a resurrect, a marker and an expunged head", async () => {
    const w = world();
    const [a, b, c, d] = [person(1), person(2), person(3), person(4)];
    const open = await w.call("POST", "/sync/sessions", { body: { expected: [`Person#${a.handle}`, `Person#${b.handle}`, `Person#${c.handle}`, `Person#${d.handle}`, `Note#${h(2001)}`] } });
    await w.call("POST", "/sync/batches", { idem: "k-a", body: { session_id: open.body.session_id, ops: [create(a), create(b), create(c), create(d), create(note(1))] } });
    await w.call("POST", `/sync/sessions/${open.body.session_id}/complete`, { body: {} });
    // privacy-expunge empties one whole record (HFY-TSK-204): its log entry loses the value and says `expunged: true`, the epoch moves, and the head is a tombstone that says so
    const gone = w.rows("SYNC#LOG").find((r) => r.handle === d.handle);
    w.ddb.rows.set(`${gone.PK}\u0000${gone.SK}`, { ...gone, obj_json: null, expunged: true });
    w.ddb.rows.set("SYNC#HEAD\u0000META", { ...w.row("SYNC#HEAD"), expunge_epoch: 1 });
    w.reset();
    const mid = (await feed(w)).body;
    expect(mid.ops.find((o) => o.handle === d.handle)).toMatchObject({ obj: null, expunged: true });
    expect(mid.next_since).toBe(mid.head_seq);
    const cached = fold(new Map(), mid.ops); // the client's cache at seq 6
    await w.push([{ op: "update", class: "Person", handle: a.handle, base_version: 1, obj: person(1, { gender: 0 }) }, del("Note", h(2001), 1)]);
    await w.push([{ op: "withdraw", class: "Person", handle: b.handle, base_version: 1, reason: "private" }]);
    await w.push([create(note(1, { text: { _class: "StyledText", string: "Synthetic note again", tags: [] } }), { base_version: 2 })]);
    const tail = (await feed(w, `?since=${mid.next_since}`)).body;
    expect(tail.ops.map((o) => o.seq)).toEqual(tail.ops.map((_, i) => mid.next_since + 1 + i)); // dense
    fold(cached, tail.ops);
    const snap = await w.call("GET", "/sync/snapshot");
    const built = buildSnapshot({ treeId: TREE, seq: tail.next_since, heads: [...cached.values()] });
    expect(built.body_sha256).toBe(snap.body.body_sha256);
    expect(built.count).toBe(snap.body.count);
    const expungedLine = readSnapshot(w.s3, tail.next_since).lines.find((l) => l.handle === d.handle);
    expect(expungedLine).toMatchObject({ deleted: true, expunged: true, obj: null }); // the flag is in the snapshot line, and so in the hash
    expect(readSnapshot(w.s3, tail.next_since).lines.filter((l) => "expunged" in l)).toHaveLength(1); // and only there
    const dropped = [...cached.values()].map(({ expunged, ...rest }) => rest);
    expect(buildSnapshot({ treeId: TREE, seq: tail.next_since, heads: dropped }).body_sha256).not.toBe(snap.body.body_sha256); // a replica that forgot it would not match
    const full = fold(new Map(), (await feed(w, "?since=0&limit=500")).body.ops);
    expect(buildSnapshot({ treeId: TREE, seq: tail.next_since, heads: [...full.values()] }).body_sha256).toBe(snap.body.body_sha256);
  });
});
