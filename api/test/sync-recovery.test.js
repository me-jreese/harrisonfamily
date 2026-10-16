// HFY-TSK-275 (sync-store-recovery, review SI-04): sync-admin pause --all, rebuild-heads, copy-back and bump-tree-id, and the store-scoped
// guarantee behind them: no recovery touches an item outside REC#, SYNC#, GID# and IDALIAS#. In-memory DynamoDB fake, synthetic objects only.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SignJWT, importPKCS8 } from "jose";
import { cmds, createFakeDdb, makeApi, pem, ISSUER } from "./world.js";
import { applyBatch } from "../src/sync/apply.js";
import { createHookRegistry } from "../src/sync/hooks.js";
import { SYNC_AUDIENCE, SYNC_CLIENT_ID, createSyncAuthenticator } from "../src/sync/auth.js";
import { createGroupResolver } from "../src/policy.js";
import { ORIGINS, headKey, seqKey } from "../src/sync/store.js";
import { canonicalJson } from "../src/shared/canonical.mjs";
import { SYNC_PREFIXES, checkLog, foldLog, isSyncPartition } from "../src/sync/refold.js";
import { AdminError, HELP, parseArgs, run } from "../scripts/sync-admin.mjs";
import { RecoveryError, chunkOps, parseToSeq } from "../scripts/sync-recovery.mjs";

const T = "hfy-app";
const SIDE = "hfy-app-pitr-test";
const START = Date.parse("2026-10-14T00:00:00Z");
const h = (n) => n.toString(16).padStart(28, "0");
const person = (n, extra = {}) => ({ _class: "Person", handle: h(n), gramps_id: `I${String(n).padStart(4, "0")}`, change: 1, private: false, gender: 1, ...extra });
const note = (n, extra = {}) => ({ _class: "Note", handle: h(2000 + n), gramps_id: `N${String(n).padStart(4, "0")}`, change: 1, private: false, text: { _class: "StyledText", string: `Synthetic ${n}`, tags: [] }, ...extra });
const media = (n, extra = {}) => ({ _class: "Media", handle: h(4000 + n), gramps_id: `O${String(n).padStart(4, "0")}`, change: 1, private: false, path: "a.jpg", mime: "image/jpeg", ...extra });
const create = (o, extra = {}) => ({ op: "create", class: o._class, handle: o.handle, base_version: null, obj: o, ...extra });
const update = (o, base, extra = {}) => ({ op: "update", class: o._class, handle: o.handle, base_version: base, obj: o, ...extra });
const withdraw = (o, base) => ({ op: "withdraw", class: o._class, handle: o.handle, base_version: base, reason: "private" });
const del = (o, base, extra = {}) => ({ op: "delete", class: o._class, handle: o.handle, base_version: base, ...extra });
const BLOB = { s3_key: "media/aa", sha256: "a".repeat(64), md5: "b".repeat(32), size: 10, content_type: "image/jpeg", state: "present" };

/** A router over named fake tables: the fake ignores TableName, so a side table needs its own fake behind one client. */
function multiDdb(tables) {
  const tableOf = (cmd) => cmd.input.TableName ?? cmd.input.TransactItems?.map((t) => (t.Put ?? t.Delete ?? t.Update ?? t.ConditionCheck).TableName)[0];
  return { tables, send: (cmd) => tables[tableOf(cmd)].send(cmd) };
}

function world({ head = { seq: 0, seeded: true, writes_enabled: true, live_heads: 0, tree_id: "00000000-0000-4000-8000-000000000001" } } = {}) {
  const ddb = createFakeDdb();
  if (head) ddb.rows.set("SYNC#HEAD\u0000META", { ...headKey(), ...head });
  let t = START;
  let k = 0;
  const clock = { now: () => t, advance: (ms) => (t += ms) };
  const lines = [];
  const ctx = { ddb, cmds, table: T, log: (l) => lines.push(l), now: () => clock.now(), scanLimit: 7 };
  const batch = async (ops, origin = "desktop") =>
    applyBatch({ ddb, cmds, table: T, now: () => (t += 1000), uid: () => `u${++k}`, log: { warn() {}, error() {} }, txnOpts: { sleep: async () => {} }, unsafeNoValidate: true }, { principal: "svc-test", origin, idempotencyKey: `key-${++k}`, ops });
  const row = (pk, sk = "META") => ddb.rows.get(`${pk}\u0000${sk}`);
  const rows = (prefix) => ddb.all().filter((r) => r.PK.startsWith(prefix));
  const text = () => lines.join("\n");
  return { ddb, ctx, clock, lines, batch, row, rows, text };
}
const args = (argv) => parseArgs(argv);
const admin = (w, argv, ctx = w.ctx) => run(args(argv), ctx);
const key = (item) => `${item.PK}|${item.SK}`;
const dump = (items) => JSON.stringify([...items].sort((a, b) => (key(a) < key(b) ? -1 : 1)));
const isOutside = (i) => !SYNC_PREFIXES.some((p) => i.PK.startsWith(p));
const outside = (ddb) => dump(ddb.all().filter(isOutside));
const syncPart = (ddb) => dump(ddb.all().filter((i) => !isOutside(i) && i.PK !== "SYNC#ADMIN"));

/** Items from other domains, which a recovery must leave exactly as they are. */
function addOutsiders(ddb) {
  const items = [
    { PK: "POST#01J00000000000000000000001", SK: "META", entity: "post", title: "Synthetic post", body: "text" },
    { PK: "THREAD#person:I0001", SK: "C#01J00000000000000000000002", entity: "comment", text: "Synthetic comment" },
    { PK: "AUDIT#records:abc", SK: "2026-10-14T00:00:00.000Z#u0", entity: "audit", op: "records.batch", before: [], after: [] },
    { PK: "ALLOW#synthetic@example.test", SK: "META", entity: "allow", sub: "I9001" },
    { PK: "CHAT#room-1", SK: "M#1", entity: "chat", text: "Synthetic chat" },
    { PK: "MOD#Person#I0002", SK: "META", entity: "mod", hidden: true },
    { PK: "RSUB#I0001", SK: "u1", entity: "rsub" },
  ];
  for (const i of items) ddb.rows.set(`${i.PK}\u0000${i.SK}`, i);
  return items.length;
}

/** A store with every kind of history: creates, an update, a Person renumber (alias), a non-Person renumber (released id), a Media with a blob, deletes and a withdraw. */
async function history(w) {
  const [p1, p2, p3, p4, p5] = [1, 2, 3, 4, 5].map((n) => person(n));
  const [n1, n2] = [note(1), note(2)];
  await w.batch([create(p1), create(p2), create(p3), create(p4), create(p5), create(n1), create(n2), create(media(1), { blob: BLOB })]); // seq 1-8
  await w.batch([update({ ...p1, gender: 0 }, 1), update({ ...n1, text: { _class: "StyledText", string: "Edited", tags: [] } }, 1)]); // 9-10
  await w.batch([update({ ...p2, gramps_id: "I0102" }, 1, { renumber: true })]); // 11: Person renumber leaves an alias and retires the old id
  await w.batch([update({ ...n2, gramps_id: "N0102" }, 1)]); // 12: a non-Person id is released
  await w.batch([del(n1, 2, { reason: "cleanup" }), withdraw(p3, 1), del(p4, 1, { reason: "cleanup" })]); // 13-15
  return { p1, p2, p3, p4, p5, n1, n2 };
}
const pause = (w) => admin(w, ["pause", "--all", "--apply"]);

describe("argument handling (AC1, AC2, AC3)", () => {
  it("accepts the new commands with their own flags only", () => {
    expect(args(["pause", "--all", "--apply"])).toMatchObject({ command: "pause", apply: true, all: true });
    expect(args(["rebuild-heads", "--to-seq", "12", "--dry-run"])).toMatchObject({ command: "rebuild-heads", toSeq: "12", apply: false });
    expect(args(["rebuild-heads", "--to-seq", "head", "--apply", "--by", "op"])).toMatchObject({ toSeq: "head", by: "op" });
    expect(args(["copy-back", "--from-table", SIDE, "--dry-run"])).toMatchObject({ command: "copy-back", fromTable: SIDE });
    expect(args(["bump-tree-id", "--reseed", "--apply"])).toMatchObject({ command: "bump-tree-id", reseed: true });
    expect(() => args(["rebuild-heads", "--dry-run"])).toThrow(/needs --to-seq/);
    expect(() => args(["copy-back", "--dry-run"])).toThrow(/needs --from-table/);
    expect(() => args(["rebuild-heads", "--to-seq", "3"])).toThrow(/exactly one/);
    expect(() => args(["rebuild-heads", "--to-seq", "3", "--dry-run", "--reseed"])).toThrow(/does not apply/);
    expect(() => args(["copy-back", "--from-table", SIDE, "--dry-run", "--to-seq", "1"])).toThrow(/does not apply/);
    expect(() => args(["bump-tree-id", "--dry-run", "--from-table", SIDE])).toThrow(/does not apply/);
    expect(() => args(["pause", "--dry-run", "--reseed"])).toThrow(/does not apply/);
    expect(() => args(["render", "--dry-run", "--full", "--to-seq", "1"])).toThrow(/does not apply/);
    expect(() => args(["rebuild-heads", "--to-seq"])).toThrow(/needs a value/);
  });
  it("--help names the recovery commands and says no command swaps TABLE_NAME", () => {
    for (const word of ["rebuild-heads", "copy-back", "bump-tree-id", "--to-seq", "--from-table", "--reseed", "pause     --all", "never swap TABLE_NAME"]) expect(HELP).toContain(word);
  });
  it("parseToSeq takes a number or head, never past the log's last seq", () => {
    expect(parseToSeq("head", 15)).toBe(15);
    expect(parseToSeq("0", 15)).toBe(0);
    expect(parseToSeq("15", 15)).toBe(15);
    expect(() => parseToSeq("16", 15)).toThrow(/past the last seq/);
    for (const bad of ["-1", "1.5", "x", "", undefined]) expect(() => parseToSeq(bad, 15)).toThrow(RecoveryError);
  });
});

describe("pause --all and resume (AC1)", () => {
  it("pause --all sets writes_enabled false; applyBatch then refuses EVERY origin, the seed included; resume --all reverses it", async () => {
    const w = world();
    await admin(w, ["pause", "--all", "--dry-run"]);
    expect(w.row("SYNC#HEAD").writes_enabled).toBe(true);
    await pause(w);
    expect(w.row("SYNC#HEAD").writes_enabled).toBe(false);
    const before = dump(w.ddb.all());
    let n = 0;
    for (const origin of ORIGINS) {
      n += 1;
      await expect(w.batch([create(person(n))], origin), origin).rejects.toMatchObject({ status: 503, code: "sync_paused" });
    }
    expect(dump(w.ddb.all())).toBe(before); // nothing written by any of them
    await admin(w, ["resume", "--all", "--apply"]);
    expect(w.row("SYNC#HEAD").writes_enabled).toBe(true);
    for (const origin of ORIGINS.filter((o) => o !== "seed")) expect((await w.batch([create(person(100 + ORIGINS.indexOf(origin)))], origin)).seq_to).toBeGreaterThan(0);
  });
});

// ---- the desktop's routes -----------------------------------------------------------------------------------------------------
const NOW = Date.parse("2026-10-14T12:00:00Z");
const nowS = Math.floor(NOW / 1000);
const OWNER = "I9001";
const GROUPS = { version: 1, groups: { "gramps-owner": { subjects: [OWNER] } } };
const jwtKey = await importPKCS8(pem, "RS256");
const HS = { "x-hfy-sync-client": "hfy_sync/0.1.0", "x-hfy-gramps-version": "6.0.6", "x-hfy-gramps-schema": "21", "x-hfy-redaction-version": "1" };
const TREE = "00000000-0000-4000-8000-000000000001";
const BOUND = { dbid: "db-synthetic-1", fingerprint: "fp-0123456789abcdef", tree_name_sha256: "a".repeat(64), bound_at: "2026-10-13T00:00:00.000Z", by: OWNER };
const token = () =>
  new SignJWT({ client_id: SYNC_CLIENT_ID, token_use: "access", amr: ["passkey", "mfa"], auth_time: nowS - 10, groups: [] })
    .setProtectedHeader({ alg: "RS256", kid: "hfy-session-1" }).setSubject(OWNER).setIssuer(ISSUER).setAudience(SYNC_AUDIENCE).setIssuedAt(nowS - 5).setExpirationTime(nowS + 600).sign(jwtKey);

function apiWorld(headExtra = {}) {
  let auth;
  const hooks = createHookRegistry();
  const w = makeApi({ clock: () => NOW, extraDeps: { authenticateSync: (e) => auth(e), syncHooks: hooks, txnOpts: { sleep: async () => {} } } });
  auth = createSyncAuthenticator({ getJwks: async () => w.jwks, getGroups: createGroupResolver({ load: async () => GROUPS, log: { error() {} } }), now: () => NOW, log: { warn() {}, error() {} } });
  w.ddb.rows.set("SYNC#HEAD\u0000META", { ...headKey(), seq: 0, seeded: true, writes_enabled: true, merges_enabled: false, tree_id: TREE, bound: BOUND, live_heads: 0, ...headExtra });
  let k = 0;
  const call = async (method, path, { body, tree = TREE, idem } = {}) =>
    w.call(method, `/api${path}`, { headers: { ...HS, ...(tree ? { "x-hfy-tree-id": tree } : {}), authorization: `Bearer ${await token()}`, ...(idem ? { "idempotency-key": idem } : {}) }, ...(body !== undefined ? { body } : {}) });
  const push = (ops, o = {}) => call("POST", "/sync/batches", { idem: `k-${++k}`, body: { ops, ...(o.session ? { session_id: o.session } : {}), ...(o.tree_id ? { tree_id: o.tree_id } : {}) }, ...(o.call ?? {}) });
  const ctx = { ddb: w.ddb, cmds, table: "hfy-app", log() {}, now: () => NOW };
  return { ...w, call, push, hooks, ctx, head: () => w.ddb.rows.get("SYNC#HEAD\u0000META") };
}
const status = (r) => [r.status, r.body?.error];
let envBefore;
beforeEach(() => { envBefore = process.env.SYNC_API_ENABLED; process.env.SYNC_API_ENABLED = "1"; });
afterEach(() => { if (envBefore === undefined) delete process.env.SYNC_API_ENABLED; else process.env.SYNC_API_ENABLED = envBefore; });

describe("the desktop's pushes stop with the pause (AC1)", () => {
  it("pause --all makes POST /sync/sessions and /sync/batches answer 503 sync_paused; resume --all lets the push through", async () => {
    const w = apiWorld();
    await run(args(["pause", "--all", "--apply"]), w.ctx);
    expect(status(await w.call("POST", "/sync/sessions", { body: {} }))).toEqual([503, "sync_paused"]);
    expect(status(await w.push([create(person(1))]))).toEqual([503, "sync_paused"]);
    expect(w.ddb.all().filter((r) => r.PK === "SYNC#LOG")).toHaveLength(0);
    await run(args(["resume", "--all", "--apply"]), w.ctx);
    expect((await w.push([create(person(1))])).status).toBe(200);
  });
});

describe("rebuild-heads (AC2)", () => {
  it("a healthy store folds to itself: the dry run reports nothing to change and writes nothing", async () => {
    const w = world();
    await history(w);
    addOutsiders(w.ddb);
    const before = dump(w.ddb.all());
    const r = await admin(w, ["rebuild-heads", "--to-seq", "head", "--dry-run"]);
    expect(w.text()).toMatch(/the log holds 15 entries; SYNC#HEAD.seq is 15/);
    expect(w.text()).toMatch(/plan: nothing to change: the heads already equal the log/);
    expect(w.text()).toMatch(/live_heads: \d+, correct/);
    expect(r.plan.writes).toBe(0);
    expect(dump(w.ddb.all())).toBe(before);
  });

  it("the fold reproduces every REC#, GID# and IDALIAS# item applyBatch wrote, byte for byte", async () => {
    const w = world();
    await history(w);
    const entries = w.ddb.all().filter((i) => i.PK === "SYNC#LOG").sort((a, b) => a.seq - b.seq);
    expect(checkLog(entries, 15).ok).toBe(true);
    const blobs = new Map([[`Media#${h(4001)}`, BLOB]]);
    const f = foldLog(entries, { blobs });
    const keyOf = (i) => `${i.PK}\u0000${i.SK}`;
    for (const [prefix, expected] of [["REC#", f.heads], ["GID#", f.gids], ["IDALIAS#", f.aliases]]) {
      const stored = w.ddb.all().filter((i) => i.PK.startsWith(prefix));
      expect(new Set(expected.keys()), prefix).toEqual(new Set(stored.map(keyOf)));
      for (const item of stored) expect(canonicalJson(expected.get(keyOf(item))), `${prefix} ${item.PK}`).toBe(canonicalJson(item));
    }
    expect(f.live).toBe(w.row("SYNC#HEAD").live_heads);
    // the id rules came out of the log: a Person's old ids are retired, a non-Person's is released, the alias names the new id
    expect(w.row("GID#Person#I0002")).toMatchObject({ retired: true, reason: "renumbered" });
    expect(w.row("GID#Note#N0002")).toBeUndefined();
    expect(w.row("IDALIAS#Person#I0002")).toMatchObject({ current_gramps_id: "I0102", reason: "renumber" });
    expect(w.row("GID#Person#I0003")).toMatchObject({ retired: true, reason: "withdrawn" });
  });

  it("repairs damaged heads, GID and alias items in place, and every item outside the sync partitions stays byte for byte (dry run on a non-prod copy, then apply)", async () => {
    const prod = world();
    await history(prod);
    addOutsiders(prod.ddb);
    // the "non-prod copy": a fresh fake holding a copy of every item
    const copy = world({ head: null });
    for (const i of prod.ddb.all()) copy.ddb.rows.set(`${i.PK}\u0000${i.SK}`, i);
    const good = dump(copy.ddb.all());
    const logBefore = dump(copy.ddb.all().filter((i) => i.PK === "SYNC#LOG"));
    // damage: a lost head, an edited head, an orphan head, a lost and a bogus GID, a wrong alias
    const rows = copy.ddb.rows;
    rows.delete(`REC#Person#${h(5)}\u0000HEAD`);
    Object.assign(rows.get(`REC#Person#${h(1)}\u0000HEAD`), { version: 9, obj_json: "{\"_class\":\"Person\"}" });
    rows.set(`REC#Note#${h(2999)}\u0000HEAD`, { PK: `REC#Note#${h(2999)}`, SK: "HEAD", entity: "rec", class: "Note", handle: h(2999), version: 1 });
    rows.delete("GID#Person#I0001\u0000META");
    rows.set("GID#Note#N0999\u0000META", { PK: "GID#Note#N0999", SK: "META", entity: "gid", handle: h(1) });
    rows.get("IDALIAS#Person#I0002\u0000META").current_gramps_id = "I0777";
    const damaged = dump(copy.ddb.all());
    expect(damaged).not.toBe(good);

    const dry = await admin(copy, ["rebuild-heads", "--to-seq", "head", "--dry-run"]);
    expect(dry.plan.heads.puts.length).toBe(2);
    expect(dry.plan.heads.deletes.length).toBe(1);
    expect(dry.plan.gids.puts.length).toBe(1);
    expect(dry.plan.gids.deletes.length).toBe(1);
    expect(dry.plan.aliases.puts.length).toBe(1);
    expect(copy.text()).toMatch(/dry run: nothing written/);
    expect(copy.text()).not.toMatch(/I0001|I0102|Synthetic/); // no gramps_id and no object text in the output
    expect(dump(copy.ddb.all())).toBe(damaged);

    // an apply needs the pause
    await expect(admin(copy, ["rebuild-heads", "--to-seq", "head", "--apply"])).rejects.toThrow(/writes are not paused/);
    expect(dump(copy.ddb.all())).toBe(damaged); // refused before a single write
    await pause(copy); // the pause writes its own AUDIT# item, so it comes first; the recovery that follows must leave everything outside alone
    const outsideBefore = outside(copy.ddb);
    await admin(copy, ["rebuild-heads", "--to-seq", "head", "--apply", "--by", "operator-a"]);

    expect(outside(copy.ddb)).toBe(outsideBefore); // the AC: every non-sync partition is byte-unchanged
    expect(dump(copy.ddb.all().filter((i) => i.PK === "SYNC#LOG"))).toBe(logBefore); // the log is read, never rewritten
    // the sync partitions are what they were before the damage; only the pause and the audit item differ
    const expectedSync = JSON.parse(good).filter((i) => !isOutside(i) && i.PK !== "SYNC#HEAD" && i.PK !== "SYNC#ADMIN");
    const gotSync = copy.ddb.all().filter((i) => !isOutside(i) && i.PK !== "SYNC#HEAD" && i.PK !== "SYNC#ADMIN");
    expect(dump(gotSync)).toBe(dump(expectedSync));
    expect(copy.row("SYNC#HEAD")).toMatchObject({ writes_enabled: false, seq: 15 });
    const audit = copy.rows("SYNC#ADMIN");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ op: "sync-admin.rebuild-heads", by: "operator-a", heads_written: 2, heads_deleted: 1 });
    // converged: a second plan has nothing to do
    const again = await admin(copy, ["rebuild-heads", "--to-seq", "head", "--dry-run"]);
    expect(again.plan.writes).toBe(0);
  });

  it("corrects a wrong SYNC#HEAD.live_heads and leaves an uncounted one alone", async () => {
    const w = world();
    await history(w);
    const right = w.row("SYNC#HEAD").live_heads;
    w.row("SYNC#HEAD").live_heads = right + 40;
    const dry = await admin(w, ["rebuild-heads", "--to-seq", "head", "--dry-run"]);
    expect(dry.plan.liveFix).toEqual({ from: right + 40, to: right });
    await pause(w);
    await admin(w, ["rebuild-heads", "--to-seq", "head", "--apply"]);
    expect(w.row("SYNC#HEAD").live_heads).toBe(right);
    const w2 = world();
    await history(w2);
    delete w2.row("SYNC#HEAD").live_heads;
    expect((await admin(w2, ["rebuild-heads", "--to-seq", "head", "--dry-run"])).plan.liveFix).toBeNull();
  });

  it("keeps the blob descriptor a Media head holds (it is on the head, not in the log) and a head whose last entry was expunged", async () => {
    const w = world();
    await history(w);
    const mediaKey = `REC#Media#${h(4001)}\u0000HEAD`;
    expect(w.ddb.rows.get(mediaKey).blob).toMatchObject({ state: "present" });
    w.ddb.rows.get(mediaKey).version = 4; // damage the head so it is rewritten
    // an expunged entry: its head is kept as it is, neither rewritten nor deleted
    const entry = w.ddb.rows.get(`SYNC#LOG\u0000${seqKey(5)}`);
    entry.expunged = true;
    entry.obj_json = null;
    const p5Key = `REC#Person#${h(5)}\u0000HEAD`;
    w.ddb.rows.get(p5Key).obj_json = "{\"_class\":\"Person\",\"scrubbed\":true}";
    const keep = JSON.stringify(w.ddb.rows.get(p5Key));
    await pause(w);
    await admin(w, ["rebuild-heads", "--to-seq", "head", "--apply"]);
    expect(w.ddb.rows.get(mediaKey)).toMatchObject({ version: 1, blob: BLOB });
    expect(JSON.stringify(w.ddb.rows.get(p5Key))).toBe(keep);
    expect(w.text()).toMatch(/1 expunged \(kept\)/);
  });

  it("a damaged log is refused with the copy-back advice, whatever the flags, and nothing is written", async () => {
    const w = world();
    await history(w);
    await pause(w);
    const clean = dump(w.ddb.all());
    for (const damage of [
      () => w.ddb.rows.delete(`SYNC#LOG\u0000${seqKey(7)}`), // a hole
      () => { w.ddb.rows.get(`SYNC#LOG\u0000${seqKey(7)}`).obj_json = "{}"; }, // text that no longer matches its hash
      () => { w.ddb.rows.get(`SYNC#LOG\u0000${seqKey(9)}`).version = 7; }, // a version out of step
      () => { w.ddb.rows.get("SYNC#HEAD\u0000META").seq = 20; }, // the head names entries the log lacks
    ]) {
      damage();
      await expect(admin(w, ["rebuild-heads", "--to-seq", "head", "--apply"])).rejects.toThrow(/the log is damaged.*copy-back/);
      expect(w.text()).toMatch(/damaged\s+\w+ at seq/);
      for (const r of [...w.ddb.rows.keys()]) void r;
      w.ddb.rows.clear();
      for (const i of JSON.parse(clean)) w.ddb.rows.set(`${i.PK}\u0000${i.SK}`, i);
      w.lines.length = 0;
    }
  });

  it("--to-seq N behind the tail puts the store back to its state at N by appended admin entries: the log stays append-only and converges", async () => {
    const w = world();
    const { p1, p4, n1 } = await history(w);
    addOutsiders(w.ddb);
    await w.batch([create(person(6)), create(note(6))]); // seq 16-17: created after N
    // state at seq 12 (before the deletes of 13-15): p4 and n1 live, p3 not yet withdrawn, p6 and note 6 do not exist
    const logBefore = w.ddb.all().filter((i) => i.PK === "SYNC#LOG");
    const dry = await admin(w, ["rebuild-heads", "--to-seq", "12", "--dry-run"]);
    expect(dry.plan.rollback.map((e) => [e.op, e.class])).toEqual([["create", "Person"], ["create", "Person"], ["delete", "Person"], ["create", "Note"], ["delete", "Note"]]);
    expect(dry.plan.finalSeq).toBe(22);
    expect(w.row("SYNC#HEAD").seq).toBe(17); // a dry run moves nothing
    await expect(admin(w, ["rebuild-heads", "--to-seq", "12", "--apply"])).rejects.toThrow(/writes are not paused/);
    await pause(w);
    const outsideBefore = outside(w.ddb);
    await admin(w, ["rebuild-heads", "--to-seq", "12", "--apply"]);

    expect(outside(w.ddb)).toBe(outsideBefore);
    const log = w.ddb.all().filter((i) => i.PK === "SYNC#LOG").sort((a, b) => a.seq - b.seq);
    expect(log.slice(0, 17).map((e) => JSON.stringify(e))).toEqual(logBefore.sort((a, b) => a.seq - b.seq).map((e) => JSON.stringify(e))); // append-only
    expect(log).toHaveLength(22);
    expect(log.slice(17).every((e) => e.origin === "admin" && e.principal === "operator:sync-admin" && e.batch_id === "rebuild:12:17")).toBe(true);
    expect(w.row("SYNC#HEAD")).toMatchObject({ seq: 22, writes_enabled: false });
    expect(checkLog(log, 22).ok).toBe(true);
    // the heads are the state at seq 12
    expect(w.row(`REC#Person#${p4.handle}`, "HEAD")).toMatchObject({ deleted: false, version: 3, origin: "admin" });
    expect(w.row(`REC#Note#${n1.handle}`, "HEAD")).toMatchObject({ deleted: false, version: 4 });
    expect(JSON.parse(w.row(`REC#Note#${n1.handle}`, "HEAD").obj_json).text.string).toBe("Edited");
    expect(w.row(`REC#Person#${h(6)}`, "HEAD")).toMatchObject({ deleted: true });
    expect(w.row(`REC#Note#${h(2006)}`, "HEAD")).toMatchObject({ deleted: true });
    expect(w.row(`REC#Person#${p1.handle}`, "HEAD")).toMatchObject({ deleted: false, version: 2 }); // unchanged since N: not touched
    expect(w.row("GID#Person#I0004")).toMatchObject({ handle: p4.handle }); // claimed again
    expect(w.row("GID#Person#I0004").retired).toBeUndefined();
    expect(w.row("GID#Person#I0006")).toMatchObject({ retired: true, reason: "deleted" }); // a Person id is never freed
    expect(w.row("GID#Note#N0006")).toBeUndefined();
    expect(w.row("SYNC#HEAD").live_heads).toBe(foldLog(log).live);
    expect((await admin(w, ["rebuild-heads", "--to-seq", "head", "--dry-run"])).plan.writes).toBe(0);
    expect(w.text()).toMatch(/plan: nothing to change/);
  });

  it("--to-seq 0 puts every object in a tombstone; a seq past the tail is refused", async () => {
    const w = world();
    await history(w);
    await expect(admin(w, ["rebuild-heads", "--to-seq", "99", "--dry-run"])).rejects.toThrow(/past the last seq/);
    const dry = await admin(w, ["rebuild-heads", "--to-seq", "0", "--dry-run"]);
    expect(dry.plan.rollback.every((e) => e.op === "delete")).toBe(true);
    expect(dry.plan.rollback.length).toBe(5); // p1, p2, p5, note 2 and the Media: the three tombstones already are what they were
  });
});

// ---- copy-back ------------------------------------------------------------------------------------------------------------------
/** A live table whose change log is damaged, and a side table that is its point-in-time copy from before the damage. */
async function twoTables() {
  const w = world();
  await history(w);
  addOutsiders(w.ddb);
  const side = createFakeDdb();
  for (const i of w.ddb.all()) side.rows.set(`${i.PK}\u0000${i.SK}`, i); // the PITR restore: every item of the table at that moment
  side.rows.set("POST#01J000000000000000000000OLD\u0000META", { PK: "POST#01J000000000000000000000OLD", SK: "META", entity: "post", title: "Old post, in the side table only" });
  // after the PITR moment: ordinary writes in other domains, more sync writes, and then the damage
  w.ddb.rows.set("POST#01J00000000000000000000NEW\u0000META", { PK: "POST#01J00000000000000000000NEW", SK: "META", entity: "post", title: "Post written after the restore point" });
  w.ddb.rows.set("THREAD#post:NEW\u0000C#1", { PK: "THREAD#post:NEW", SK: "C#1", entity: "comment", text: "Comment after the restore point" });
  await w.batch([create(person(7))]);
  w.ddb.rows.delete(`SYNC#LOG\u0000${seqKey(4)}`); // the log has a hole: rebuild-heads cannot be trusted
  const ddb = multiDdb({ [T]: w.ddb, [SIDE]: side });
  const ctx = { ...w.ctx, ddb };
  return { w, side, ctx, run: (argv) => run(args(argv), ctx) };
}

describe("copy-back (AC3)", () => {
  it("restores only REC#, SYNC#, GID# and IDALIAS# items from a side table; every other partition of the live table stays byte for byte; TABLE_NAME is never swapped", async () => {
    const t = await twoTables();
    await expect(t.run(["rebuild-heads", "--to-seq", "head", "--dry-run"])).rejects.toThrow(/log is damaged/);
    const before = dump(t.w.ddb.all());
    const dry = await t.run(["copy-back", "--from-table", SIDE, "--dry-run"]);
    expect(dry.plan.puts).toBeGreaterThan(0);
    expect(t.w.text()).toMatch(/dry run: nothing written/);
    expect(t.w.text()).toMatch(/no other partition is read for writing or touched/);
    expect(dump(t.w.ddb.all())).toBe(before);
    await expect(t.run(["copy-back", "--from-table", SIDE, "--apply"])).rejects.toThrow(/writes are not paused/);
    expect(dump(t.w.ddb.all())).toBe(before);

    await t.run(["pause", "--all", "--apply"]);
    const outsideBefore = outside(t.w.ddb);
    expect(t.w.ddb.rows.get("POST#01J00000000000000000000NEW\u0000META")).toBeDefined();
    await t.run(["copy-back", "--from-table", SIDE, "--apply", "--by", "operator-a"]);

    expect(outside(t.w.ddb)).toBe(outsideBefore); // the posts, comments, audit and the rest are what they were: the table was not swapped
    expect(t.w.ddb.rows.get("POST#01J00000000000000000000NEW\u0000META")).toBeDefined();
    expect(t.w.ddb.rows.get("POST#01J000000000000000000000OLD\u0000META")).toBeUndefined(); // a side table's other partitions are never copied
    // the sync partitions equal the side table's, except SYNC#HEAD (kept paused) and the recovery's own audit trail
    const sideSync = t.side.all().filter((i) => !isOutside(i) && i.PK !== "SYNC#HEAD");
    const liveSync = t.w.ddb.all().filter((i) => !isOutside(i) && i.PK !== "SYNC#HEAD" && i.PK !== "SYNC#ADMIN");
    expect(dump(liveSync)).toBe(dump(sideSync));
    expect(t.w.row("SYNC#LOG", seqKey(4))).toBeDefined(); // the hole is filled
    expect(t.w.row(`REC#Person#${h(7)}`, "HEAD")).toBeUndefined(); // the write made after the restore point is gone from the store (the desktop rebases)
    expect(t.w.row("SYNC#HEAD")).toMatchObject({ writes_enabled: false, seq: 15 });
    expect(t.side.rows.get("SYNC#HEAD\u0000META").writes_enabled).toBe(true); // the side table itself is only read
    expect(t.w.rows("SYNC#ADMIN")).toHaveLength(1);
    expect(t.w.rows("SYNC#ADMIN")[0]).toMatchObject({ op: "sync-admin.copy-back", by: "operator-a", from_table: SIDE });
    // the restored store is consistent: its log is whole and its heads equal the fold
    const again = await t.run(["rebuild-heads", "--to-seq", "head", "--dry-run"]);
    expect(again.plan.writes).toBe(0);
    // converged: a second copy-back has nothing to do
    const second = await t.run(["copy-back", "--from-table", SIDE, "--dry-run"]);
    expect(second.plan.puts + second.plan.deletes).toBe(0);
  });

  it("deletes sync items the side table lacks, but never the audit trail of earlier recoveries", async () => {
    const t = await twoTables();
    await t.run(["pause", "--all", "--apply"]);
    await t.run(["bump-tree-id", "--apply"]); // leaves a SYNC#ADMIN item
    t.w.ddb.rows.set("GID#Note#N0777\u0000META", { PK: "GID#Note#N0777", SK: "META", entity: "gid", handle: h(77) });
    t.w.ddb.rows.set(`SYNC#BATCH#zzz\u0000META`, { PK: "SYNC#BATCH#zzz", SK: "META", entity: "syncbatch" });
    const dry = await t.run(["copy-back", "--from-table", SIDE, "--dry-run"]);
    expect(dry.plan.deletes).toBeGreaterThanOrEqual(2);
    await t.run(["copy-back", "--from-table", SIDE, "--apply"]);
    expect(t.w.row("GID#Note#N0777")).toBeUndefined();
    expect(t.w.row("SYNC#BATCH#zzz")).toBeUndefined();
    expect(t.w.rows("SYNC#ADMIN").map((i) => i.op).sort()).toEqual(["sync-admin.bump-tree-id", "sync-admin.copy-back"]);
  });

  it("refuses the live table as its own source, a side table that is not a restore of the app table, and a side table whose log is damaged", async () => {
    const t = await twoTables();
    await t.run(["pause", "--all", "--apply"]);
    const before = dump(t.w.ddb.all());
    await expect(t.run(["copy-back", "--from-table", T, "--apply"])).rejects.toThrow(/live table itself/);
    await expect(t.run(["copy-back", "--from-table", "x", "--apply"])).rejects.toThrow(/name of the side table/);
    t.side.rows.delete("SYNC#HEAD\u0000META");
    await expect(t.run(["copy-back", "--from-table", SIDE, "--apply"])).rejects.toThrow(/no SYNC#HEAD/);
    t.side.rows.set("SYNC#HEAD\u0000META", { ...headKey(), seq: 15, writes_enabled: true });
    t.side.rows.delete(`SYNC#LOG\u0000${seqKey(9)}`);
    await expect(t.run(["copy-back", "--from-table", SIDE, "--apply"])).rejects.toThrow(/side table's log is damaged too/);
    expect(dump(t.w.ddb.all())).toBe(before);
  });

  it("splits writes into transactions of at most 25 items and about 3 MB", () => {
    const small = Array.from({ length: 60 }, (_, i) => ({ put: { PK: `REC#Note#${i}`, SK: "HEAD" } }));
    expect(chunkOps(small).map((c) => c.length)).toEqual([25, 25, 10]);
    const big = Array.from({ length: 10 }, (_, i) => ({ put: { PK: `REC#Note#${i}`, SK: "HEAD", obj_json: "x".repeat(900_000) } }));
    expect(chunkOps(big).map((c) => c.length)).toEqual([3, 3, 3, 1]);
    expect(chunkOps([])).toEqual([]);
  });
});

// ---- bump-tree-id and the re-seed (AC4, AC5) --------------------------------------------------------------------------------------------
describe("bump-tree-id (AC4: the server half)", () => {
  it("--dry-run writes nothing and --apply needs the pause; the new tree_id makes the desktop's old one a 403 tree_mismatch", async () => {
    const w = apiWorld();
    const before = JSON.stringify(w.ddb.all());
    await run(args(["bump-tree-id", "--dry-run"]), w.ctx);
    expect(JSON.stringify(w.ddb.all())).toBe(before);
    await expect(run(args(["bump-tree-id", "--apply"]), w.ctx)).rejects.toThrow(/writes are not paused/);
    await run(args(["pause", "--all", "--apply"]), w.ctx);
    const outsideBefore = outside(w.ddb);
    await run(args(["bump-tree-id", "--apply", "--by", "operator-a"]), { ...w.ctx, uuid: () => "11111111-1111-4111-8111-111111111111" });
    expect(w.head()).toMatchObject({ tree_id: "11111111-1111-4111-8111-111111111111", writes_enabled: false, seeded: true });
    expect(w.head().bound).toEqual(BOUND); // the binding to the desktop's tree survives
    expect(outside(w.ddb)).toBe(outsideBefore);
    expect(w.ddb.all().filter((r) => r.PK === "SYNC#ADMIN")[0]).toMatchObject({ op: "sync-admin.bump-tree-id", by: "operator-a", reseed: false });
    await run(args(["resume", "--all", "--apply"]), w.ctx);

    // the handshake tells the desktop the new id; a push or session naming the old one is refused before anything is written
    const meta = await w.call("GET", "/sync/meta");
    expect(meta.body.tree_id).toBe("11111111-1111-4111-8111-111111111111");
    expect(status(await w.push([create(person(1))]))).toEqual([403, "tree_mismatch"]); // header: the old tree
    expect(status(await w.push([create(person(1))], { call: { tree: "11111111-1111-4111-8111-111111111111" }, tree_id: TREE }))).toEqual([403, "tree_mismatch"]); // body: the old tree
    expect(status(await w.call("POST", "/sync/sessions", { body: {} }))).toEqual([403, "tree_mismatch"]);
    expect(w.ddb.all().filter((r) => r.PK === "SYNC#LOG")).toHaveLength(0);
    // a desktop that has rebased names the new tree and pushes normally
    expect((await w.push([create(person(1))], { call: { tree: "11111111-1111-4111-8111-111111111111" } })).status).toBe(200);
  });

  it("refuses a store with no SYNC#HEAD or no tree_id", async () => {
    const w = world({ head: null });
    await expect(admin(w, ["bump-tree-id", "--dry-run"])).rejects.toThrow(/no SYNC#HEAD/);
    const u = world({ head: { seq: 0, seeded: true, writes_enabled: false } });
    await expect(admin(u, ["bump-tree-id", "--dry-run"])).rejects.toThrow(/nothing is bound/);
  });
});

describe("re-seed sessions are silent (AC5)", () => {
  it("--reseed marks the store not seeded and clears the open session; the next session carries seed:true, its batches are origin seed and notify nobody", async () => {
    const w = apiWorld();
    const first = await w.call("POST", "/sync/sessions", { body: {} });
    expect(first.body.seed).toBe(false);
    expect(w.head().open_session).toBe(first.body.session_id);
    await run(args(["pause", "--all", "--apply"]), w.ctx);
    await run(args(["bump-tree-id", "--reseed", "--apply"]), { ...w.ctx, uuid: () => "22222222-2222-4222-8222-222222222222" });
    expect(w.head()).toMatchObject({ seeded: false, tree_id: "22222222-2222-4222-8222-222222222222" });
    expect(w.head().open_session).toBeUndefined();
    await run(args(["resume", "--all", "--apply"]), w.ctx);

    const T2 = { call: { tree: "22222222-2222-4222-8222-222222222222" } };
    expect(status(await w.push([create(person(1))], T2))).toEqual([503, "store_not_seeded"]); // an ordinary desktop batch, and the web too, wait for the seed
    const calls = [];
    w.hooks.registerAfterCommit((i) => calls.push(i.origin));
    const s = await w.call("POST", "/sync/sessions", { body: {}, tree: "22222222-2222-4222-8222-222222222222" });
    expect([s.status, s.body.seed]).toEqual([201, true]);
    const pushed = await w.push([create(person(1)), create(note(1))], { session: s.body.session_id, call: T2.call });
    expect(pushed.status).toBe(200);
    const log = w.ddb.all().filter((r) => r.PK === "SYNC#LOG");
    expect(log.map((e) => e.origin)).toEqual(["seed", "seed"]);
    expect(calls).toEqual(["seed"]); // never "desktop": nothing that notifies on desktop batches runs
    expect(w.sent).toEqual([]);
    expect(w.ddb.all().filter((r) => /^(INBOX|NOTIF|FEED)#/.test(r.PK))).toEqual([]);
    const done = await w.call("POST", `/sync/sessions/${s.body.session_id}/complete`, { body: {}, tree: "22222222-2222-4222-8222-222222222222" });
    expect(done.status).toBe(200);
    expect(w.ddb.all().filter((r) => r.PK === "SYNC#LOG").at(-1)).toMatchObject({ op: "marker", origin: "seed" });
    expect(w.head().seeded).toBe(true);
  });
});
