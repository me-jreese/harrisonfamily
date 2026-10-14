// HFY-TSK-243: the cloud record store and applyBatch(): heads, change log, dense seq, receipts and idempotency, the GID guard,
// the store gate, audit and the commit-hook registry. In-memory DynamoDB fake; synthetic objects only.
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakeDdb, cmds } from "./world.js";
import { errorResponse, HttpError } from "../src/http.js";
import { TxnCancelled, counterUpdate } from "../src/txn.js";
import { hashObject } from "../src/records/ops.js";
import { SyncError, applyBatch, checkStoreGate } from "../src/sync/apply.js";
import { createHookRegistry, defaultHooks, registerAfterCommit, registerContributor } from "../src/sync/hooks.js";
import { batchIdFor, getRecord, gidDelete, gidKey, headKey, objectJson, requestTokenFor, seqKey, sha256 } from "../src/sync/store.js";

const T = "hfy-app";
const noSleep = { sleep: async () => {} };
const h = (n) => n.toString(16).padStart(28, "0");
const person = (n, gid = `I${String(n).padStart(4, "0")}`, extra = {}) => ({ _class: "Person", handle: h(n), gramps_id: gid, change: 1700000000, private: false, gender: 1, ...extra });
const family = (n, gid = `F${String(n).padStart(4, "0")}`) => ({ _class: "Family", handle: h(1000 + n), gramps_id: gid, change: 1700000000, private: false });
const note = (n, gid = `N${String(n).padStart(4, "0")}`) => ({ _class: "Note", handle: h(2000 + n), gramps_id: gid, change: 1700000000, private: false, text: { _class: "StyledText", string: `Synthetic note ${n}`, tags: [] } });
const tag = (n) => ({ _class: "Tag", handle: h(3000 + n), name: `Fixture ${n}`, color: "#3465a4", priority: 1, change: 1700000000 });
const create = (obj, extra = {}) => ({ op: "create", class: obj._class, handle: obj.handle, base_version: null, obj, ...extra });
const update = (obj, base, extra = {}) => ({ op: "update", class: obj._class, handle: obj.handle, base_version: base, obj, ...extra });
const del = (cls, handle, base, extra = {}) => ({ op: "delete", class: cls, handle, base_version: base, ...extra });

function world({ head = { seq: 0, seeded: true, writes_enabled: true, merges_enabled: false }, hooks = createHookRegistry(), ...rest } = {}) {
  const ddb = createFakeDdb();
  if (head) ddb.rows.set(`SYNC#HEAD\u0000META`, structuredClone({ ...headKey(), ...head }));
  let t = Date.parse("2026-10-14T00:00:00Z");
  let u = 0;
  const ctx = { ddb, cmds, table: T, now: () => (t += 1000), uid: () => `uid${String(++u).padStart(4, "0")}`, hooks, log: { warn() {}, error() {} }, txnOpts: noSleep, ...rest };
  let k = 0;
  const apply = (ops, o = {}) => applyBatch(ctx, { principal: "svc-test", origin: "desktop", idempotencyKey: `key-${++k}`, ops, ...o });
  const row = (pk, sk) => ddb.rows.get(`${pk}\u0000${sk}`);
  const rows = (prefix) => ddb.all().filter((r) => r.PK.startsWith(prefix));
  return { ddb, ctx, apply, row, rows, hooks };
}
const seqs = (w) => w.rows("SYNC#LOG").map((r) => r.seq).sort((a, b) => a - b);
const rejects = async (p, status, code) => {
  const e = await p.then(() => null, (x) => x);
  expect(e, "expected a rejection").toBeInstanceOf(HttpError);
  expect([e.status, e.code]).toEqual([status, code]);
  return e;
};
/** Wraps a fake so `spy` sees every command and `before(cmd)` can run first (to race a competing writer in). */
function wrap(ddb, { before, spy } = {}) {
  return { ...ddb, send: async (cmd) => { spy?.(cmd); await before?.(cmd); return ddb.send(cmd); } };
}
const txnActions = (cmd) => (cmd.constructor.name === "TransactWriteCommand" ? cmd.input.TransactItems : []);

describe("applyBatch(): items written (BRD2 section 4)", () => {
  it("writes head, log, receipt, audit and the SYNC#HEAD seq in ONE TransactWriteItems", async () => {
    const w = world();
    const sent = [];
    w.ctx.ddb = wrap(w.ddb, { spy: (c) => sent.push(c) });
    const p = person(1);
    const f = family(1);
    const r = await w.apply([create(p), create(f)]);
    expect(sent.filter((c) => c.constructor.name === "TransactWriteCommand")).toHaveLength(1);
    expect(sent.some((c) => ["PutCommand", "UpdateCommand", "DeleteCommand"].includes(c.constructor.name))).toBe(false);
    expect(r).toMatchObject({ seq_from: 1, seq_to: 2, replayed: false });
    expect(r.results).toEqual([
      { op_id: "1", class: "Person", handle: p.handle, version: 1, seq: 1, gramps_id: "I0001" },
      { op_id: "2", class: "Family", handle: f.handle, version: 1, seq: 2, gramps_id: "F0001" },
    ]);

    const head = w.row(`REC#Person#${p.handle}`, "HEAD");
    expect(head).toMatchObject({ entity: "rec", class: "Person", handle: p.handle, gramps_id: "I0001", version: 1, seq: 1, deleted: false, schema: 21, redaction: 1, origin: "desktop", updated_by: "svc-test", GSI1PK: "RECS#Person", GSI1SK: `I0001#${p.handle}` });
    const { change, ...rest } = p; // eslint-disable-line no-unused-vars
    expect(JSON.parse(head.obj_json)).toEqual(rest); // the `change` key is never stored
    expect(head.obj_json).toBe(objectJson(p));
    expect(head.hash).toBe(hashObject(p)); // node:crypto sha256 equals the isomorphic hashObject
    expect(head.hash).toBe(sha256(head.obj_json));

    const log1 = w.row("SYNC#LOG", seqKey(1));
    expect(log1).toMatchObject({ entity: "change", seq: 1, batch_id: r.batch_id, op: "create", class: "Person", handle: p.handle, gramps_id: "I0001", version: 1, base_version: null, obj_json: head.obj_json, hash: head.hash, principal: "svc-test", origin: "desktop", GSI1PK: `RECHIST#Person#${p.handle}`, GSI1SK: "00000001" });
    expect(seqKey(7)).toBe("000000000007");

    expect(w.row("SYNC#HEAD", "META")).toMatchObject({ seq: 2, seeded: true, writes_enabled: true });
    const receipt = w.row(`SYNC#BATCH#${r.batch_id}`, "META");
    expect(receipt).toMatchObject({ batch_id: r.batch_id, seq_from: 1, seq_to: 2, principal: "svc-test", GSI1PK: "SYNCBATCH" });
    expect(receipt.GSI1SK).toBe(`${receipt.at}#${r.batch_id}`);
    expect(receipt.results).toEqual(r.results);
    expect(r.batch_id).toBe(batchIdFor("svc-test", "key-1"));
    expect(r.batch_id).toMatch(/^[a-z2-7]{26}$/);

    const audits = w.rows("AUDIT#");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ PK: `AUDIT#records:${r.batch_id}`, GSI1PK: "AUDIT", op: "records.batch", principal: "svc-test", before: [{ class: "Person", handle: p.handle, version: null }, { class: "Family", handle: f.handle, version: null }], after: [{ class: "Person", handle: p.handle, version: 1 }, { class: "Family", handle: f.handle, version: 1 }] });
    expect(audits[0].GSI1SK).toBe(audits[0].SK);
    // the gid guard claims
    expect(w.row("GID#Person#I0001", "META")).toMatchObject({ handle: p.handle });
    expect(w.row("GID#Family#F0001", "META")).toMatchObject({ handle: f.handle });
  });

  it("a Tag has no gramps_id: its sort key is #<handle> and no GID item is written", async () => {
    const w = world();
    const t = tag(1);
    await w.apply([create(t)]);
    expect(w.row(`REC#Tag#${t.handle}`, "HEAD")).toMatchObject({ GSI1PK: "RECS#Tag", GSI1SK: `#${t.handle}`, gramps_id: "" });
    expect(w.rows("GID#")).toHaveLength(0);
  });

  it("update, delete and withdraw bump the version, keep a tombstone and log with null obj_json", async () => {
    const w = world();
    const p = person(1);
    const n = note(1);
    const e = person(2);
    await w.apply([create(p), create(n), create(e)]);
    const r = await w.apply([update({ ...p, gender: 0 }, 1), del("Note", n.handle, 1, { reason: "cleanup" }), { op: "withdraw", class: "Person", handle: e.handle, base_version: 1 }]);
    expect(r.results.map((x) => [x.version, x.seq])).toEqual([[2, 4], [2, 5], [2, 6]]);
    expect(JSON.parse(w.row(`REC#Person#${p.handle}`, "HEAD").obj_json).gender).toBe(0);
    const noteHead = w.row(`REC#Note#${n.handle}`, "HEAD");
    expect(noteHead).toMatchObject({ deleted: true, version: 2, obj_json: null, hash: null, reason: "cleanup", gramps_id: "N0001" });
    expect(w.row(`REC#Person#${e.handle}`, "HEAD")).toMatchObject({ deleted: true, version: 2, obj_json: null, reason: "private" });
    expect(w.row("SYNC#LOG", seqKey(5))).toMatchObject({ op: "delete", obj_json: null, version: 2, base_version: 1, reason: "cleanup" });
    expect(w.row("SYNC#LOG", seqKey(6))).toMatchObject({ op: "withdraw", reason: "private" });
    expect(await getRecord(w.ctx, "Person", p.handle)).toMatchObject({ version: 2, deleted: false, obj: { gender: 0 } });
    expect(await getRecord(w.ctx, "Note", n.handle)).toMatchObject({ version: 2, deleted: true, obj: null });
    expect(await getRecord(w.ctx, "Note", h(9))).toBeNull();
  });

  it("a marker op is a log entry with no head change", async () => {
    const w = world();
    const r = await w.apply([{ op: "marker", reason: "session_complete" }]);
    expect(r.results).toEqual([{ op_id: "1", op: "marker", seq: 1 }]);
    expect(w.row("SYNC#LOG", seqKey(1))).toMatchObject({ op: "marker", reason: "session_complete", obj_json: null });
    expect(w.rows("REC#")).toHaveLength(0);
    expect(w.rows("AUDIT#")[0].after).toEqual([]);
  });

  it("refuses malformed requests with 400 and writes nothing", async () => {
    const w = world();
    const p = person(1);
    await rejects(w.apply([]), 400, "validation");
    await rejects(w.apply([create(p), create(p)]), 400, "duplicate_object");
    await rejects(w.apply([{ ...create(p), obj: { ...p, _class: "Family" } }]), 400, "validation");
    await rejects(w.apply([{ ...create(p), handle: "nope" }]), 400, "validation");
    await rejects(w.apply([{ ...create(p), class: "Spaceship" }]), 422, "unknown_class");
    await rejects(w.apply([update(p, null)]), 400, "validation");
    await rejects(w.apply([{ ...del("Person", p.handle, 1), obj: p }]), 400, "validation");
    await rejects(w.apply([create({ ...p, gramps_id: undefined })]), 400, "validation");
    await rejects(w.apply([{ op: "withdraw", class: "Person", handle: p.handle, base_version: 1, reason: "boredom" }]), 400, "validation");
    await rejects(w.apply([create(p)], { origin: "nobody" }), 400, "validation");
    await rejects(w.apply([create(p)], { idempotencyKey: "" }), 428, "idempotency_key_required");
    await rejects(w.apply(Array.from({ length: 25 }, (_, i) => create(note(i + 1)))), 413, "batch_too_large");
    await rejects(w.apply([create(note(1, "N0001"), {})].map((o) => ({ ...o, obj: { ...o.obj, text: "x".repeat(210000) } }))), 413, "batch_too_large");
    expect(w.ddb.rows.size).toBe(1); // only SYNC#HEAD
  });
});

describe("applyBatch(): dense seq, races and the ClientRequestToken", () => {
  it("sequential batches take dense seqs", async () => {
    const w = world();
    for (let i = 1; i <= 5; i += 1) await w.apply([create(person(i)), create(note(i))]);
    expect(seqs(w)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(w.row("SYNC#HEAD", "META").seq).toBe(10);
  });

  it("concurrent batches stay dense and gap-free (4 racers = 1 try + 3 retries)", async () => {
    const w = world();
    const rs = await Promise.all([1, 2, 3, 4].map((i) => w.apply([create(person(i)), create(note(i))])));
    expect(seqs(w)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(rs.map((r) => r.seq_to).sort((a, b) => a - b)).toEqual([2, 4, 6, 8]);
    expect(new Set(rs.map((r) => r.seq_from)).size).toBe(4);
    expect(w.rows("SYNC#BATCH#")).toHaveLength(4);
    expect(w.rows("AUDIT#")).toHaveLength(4);
  });

  it("many racers with a larger retry budget all commit with dense seqs; with the default budget the losers answer 503 retryable and leave no gap", async () => {
    const big = world({ maxSeqRetries: 20 });
    await Promise.all(Array.from({ length: 12 }, (_, i) => big.apply([create(person(i + 1))])));
    expect(seqs(big)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));

    const w = world();
    const out = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => w.apply([create(person(i + 1))])));
    const ok = out.filter((o) => o.status === "fulfilled").length;
    for (const o of out) if (o.status === "rejected") expect([o.reason.status, o.reason.code]).toEqual([503, "retryable"]);
    expect(ok).toBeGreaterThanOrEqual(4);
    expect(seqs(w)).toEqual(Array.from({ length: ok }, (_, i) => i + 1)); // every committed seq, none missing
  });

  it("a lost race re-reads SYNC#HEAD, re-runs validation on the refreshed view and takes a new token (no IdempotentParameterMismatch)", async () => {
    const seen = [];
    const w = world({ validate: async (v) => { seen.push({ seq: v.sync_head.seq }); } });
    const raw = w.ctx.ddb;
    let raced = false;
    w.ctx.ddb = wrap(raw, {
      before: async (cmd) => {
        if (cmd.constructor.name !== "TransactWriteCommand" || raced) return;
        raced = true;
        await applyBatch({ ...w.ctx, ddb: raw, validate: undefined }, { principal: "svc-other", origin: "desktop", idempotencyKey: "rival", ops: [create(person(2))] });
      },
    });
    const r = await w.apply([create(person(1))]);
    expect(r).toMatchObject({ seq_from: 2, seq_to: 2 });
    expect(seen.map((s) => s.seq)).toEqual([0, 1]); // validation ran twice, on a refreshed view each time
    const mine = batchIdFor("svc-test", "key-1");
    expect(w.ddb.tokens).toHaveLength(3); // the rival's commit, our cancelled attempt, our retry
    const attempts = w.ddb.tokens;
    expect(attempts).toContain(requestTokenFor(mine, 1));
    expect(attempts).toContain(requestTokenFor(mine, 2));
    expect(requestTokenFor(mine, 1)).not.toBe(requestTokenFor(mine, 2));
    expect(requestTokenFor(mine, 1)).toMatch(/^[0-9a-f]{32}$/);
    expect(seqs(w)).toEqual([1, 2]);
  });

  it("a race that makes the batch invalid reports the real conflict on the refreshed view", async () => {
    const versions = [];
    const w = world({ validate: async (v) => { const r = v.record("Person", h(1)); if (r) versions.push(r.version); } });
    const p = person(1);
    await w.apply([create(p)]);
    const raw = w.ctx.ddb;
    let raced = false;
    w.ctx.ddb = wrap(raw, {
      before: async (cmd) => {
        if (cmd.constructor.name !== "TransactWriteCommand" || raced) return;
        raced = true;
        await applyBatch({ ...w.ctx, ddb: raw, validate: undefined }, { principal: "svc-other", origin: "desktop", idempotencyKey: "rival", ops: [update({ ...p, gender: 0 }, 1)] });
      },
    });
    versions.length = 0;
    const e = await rejects(w.apply([update({ ...p, gender: 2 }, 1)]), 409, "version_conflict");
    expect(versions).toEqual([1, 2]); // validation re-ran on the refreshed view
    expect(e.details.conflicts).toEqual([{ op_id: "1", class: "Person", handle: p.handle, reason: "version_mismatch", current_version: 2, current: expect.objectContaining({ gender: 0 }) }]);
  });

  it("a TransactionConflict is retried with the SAME token by transact(); the batch still commits once", async () => {
    const w = world();
    w.ddb.failNext("TransactionConflict", 2);
    const r = await w.apply([create(person(1))]);
    expect(r.seq_to).toBe(1);
    expect(new Set(w.ddb.tokens).size).toBe(1);
    expect(w.ddb.tokens).toHaveLength(3);
    expect(seqs(w)).toEqual([1]);
  });

  it("answers 503 retryable when the store throttles, and when a seq race outlasts the retry budget", async () => {
    const w = world();
    w.ddb.failNext("ThrottlingError");
    await rejects(w.apply([create(person(1))]), 503, "retryable");
    const w2 = world({ maxSeqRetries: 0 });
    const raw = w2.ctx.ddb;
    let raced = false;
    w2.ctx.ddb = wrap(raw, { before: async (cmd) => {
      if (cmd.constructor.name !== "TransactWriteCommand" || raced) return;
      raced = true;
      await applyBatch({ ...w2.ctx, ddb: raw }, { principal: "svc-other", origin: "desktop", idempotencyKey: "rival", ops: [create(person(9))] });
    } });
    await rejects(w2.apply([create(person(1))]), 503, "retryable");
    expect(seqs(w2)).toEqual([1]); // only the rival
  });
});

describe("applyBatch(): idempotency", () => {
  it("replaying a key returns the stored body, writes nothing and runs no hook; a different body under that key is 422", async () => {
    const w = world();
    let after = 0;
    w.hooks.registerAfterCommit(() => { after += 1; });
    const ops = [create(person(1)), create(note(1))];
    const first = await w.apply(ops, { idempotencyKey: "same" });
    const before = JSON.stringify(w.ddb.all());
    const again = await w.apply(ops, { idempotencyKey: "same" });
    expect(again).toEqual({ ...first, replayed: true });
    expect(JSON.stringify(w.ddb.all())).toBe(before);
    expect(after).toBe(1);
    // the same body in another key order is the same request
    const reordered = await w.apply(ops.map((o) => ({ ...o, obj: Object.fromEntries(Object.entries(o.obj).reverse()) })), { idempotencyKey: "same" });
    expect(reordered.replayed).toBe(true);
    const e = await rejects(w.apply([create(person(2))], { idempotencyKey: "same" }), 422, "idempotency_key_reused");
    expect(e).toBeInstanceOf(SyncError);
    await rejects(w.apply(ops, { idempotencyKey: "same", origin: "admin" }), 422, "idempotency_key_reused");
    // a different principal with the same key is a different batch id
    const other = await w.apply([create(person(3))], { idempotencyKey: "same", principal: "svc-else" });
    expect(other.replayed).toBe(false);
    expect(after).toBe(2);
  });

  it("two simultaneous requests with one key commit once; the loser replays the winner's body", async () => {
    const w = world();
    let after = 0;
    w.hooks.registerAfterCommit(() => { after += 1; });
    const ops = [create(person(1))];
    const [a, b] = await Promise.all([w.apply(ops, { idempotencyKey: "dup" }), w.apply(ops, { idempotencyKey: "dup" })]);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(a.results).toEqual(b.results);
    expect(seqs(w)).toEqual([1]);
    expect(after).toBe(1);
  });
});

describe("applyBatch(): version mismatch", () => {
  it("returns the current version and the redacted current object for each conflicting op, and writes nothing", async () => {
    const w = world();
    const a = person(1);
    const b = person(2);
    const c = note(1);
    await w.apply([create(a), create(b), create(c)]);
    await w.apply([update({ ...a, gender: 0 }, 1)]);
    const rowsBefore = JSON.stringify(w.ddb.all());
    const e = await rejects(w.apply([update({ ...a, gender: 2 }, 1), update({ ...b, gender: 2 }, 1), update({ ...c, text: { _class: "StyledText", string: "x", tags: [] } }, 5)]), 409, "version_conflict");
    expect(e.details.conflicts).toHaveLength(2);
    expect(e.details.conflicts[0]).toMatchObject({ op_id: "1", handle: a.handle, current_version: 2, reason: "version_mismatch" });
    expect(e.details.conflicts[0].current.gender).toBe(0);
    expect(e.details.conflicts[0].current.change).toBeUndefined(); // redacted: exactly the stored object
    expect(e.details.conflicts[1]).toMatchObject({ op_id: "3", current_version: 1 });
    expect(JSON.stringify(w.ddb.all())).toBe(rowsBefore);
    // the route body carries them
    const res = errorResponse(e);
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ error: "version_conflict", details: { conflicts: [{ op_id: "1" }, { op_id: "3" }] } });
  });

  it("create over a live object is 409 exists; over a missing object an update is a conflict with current_version null; a tombstone resurrects only with its version", async () => {
    const w = world();
    const p = person(1);
    await w.apply([create(p)]);
    const ex = await rejects(w.apply([create(p)]), 409, "exists");
    expect(ex.details.conflicts[0]).toMatchObject({ reason: "exists", current_version: 1 });
    const missing = await rejects(w.apply([update(person(9), 1)]), 409, "version_conflict");
    expect(missing.details.conflicts[0]).toMatchObject({ reason: "not_found", current_version: null, current: null });
    await w.apply([del("Person", p.handle, 1)]);
    const gone = await rejects(w.apply([update(p, 2)]), 409, "version_conflict");
    expect(gone.details.conflicts[0]).toMatchObject({ reason: "deleted", current_version: 2, current: null });
    await rejects(w.apply([create(p)]), 409, "version_conflict"); // a tombstone needs base_version = its version
    const r = await w.apply([{ ...create(p), base_version: 2 }]);
    expect(r.results[0].version).toBe(3);
    expect(w.row(`REC#Person#${p.handle}`, "HEAD")).toMatchObject({ deleted: false, version: 3 });
  });
});

describe("applyBatch(): the GID guard (one write per distinct GID item)", () => {
  const gidWrites = (spyList) => spyList.flatMap(txnActions).filter((a) => (a.Put?.Item?.PK ?? a.Delete?.Key?.PK ?? "").startsWith("GID#"));

  it("a claim of an id in use is 409 gramps_id_taken; two claims on one id in a batch are 409 gid_conflict", async () => {
    const w = world();
    await w.apply([create(note(1, "N0007"))]);
    const t = await rejects(w.apply([create(note(2, "N0007"))]), 409, "gramps_id_taken");
    expect(t.details).toEqual({ class: "Note", gramps_id: "N0007" });
    const c = await rejects(w.apply([create(note(3, "N0100")), create(note(4, "N0100"))]), 409, "gid_conflict");
    expect(c.details).toEqual({ class: "Note", gramps_id: "N0100" });
    expect(w.row("GID#Note#N0100", "META")).toBeUndefined();
  });

  it("two classes may share an id string", async () => {
    const w = world();
    await w.apply([create(note(1, "X1")), create({ ...family(1), gramps_id: "X1" })]);
    expect(w.rows("GID#").map((r) => r.PK).sort()).toEqual(["GID#Family#X1", "GID#Note#X1"]);
  });

  it("a SWAP of two non-person ids commits in one transaction with one write per GID item", async () => {
    const w = world();
    const a = note(1, "N0001");
    const b = note(2, "N0002");
    await w.apply([create(a), create(b)]);
    const sent = [];
    w.ctx.ddb = wrap(w.ddb, { spy: (c) => sent.push(c) });
    const r = await w.apply([update({ ...a, gramps_id: "N0002" }, 1), update({ ...b, gramps_id: "N0001" }, 1)]);
    expect(r.seq_to).toBe(4);
    expect(sent.filter((c) => c.constructor.name === "TransactWriteCommand")).toHaveLength(1);
    const writes = gidWrites(sent);
    expect(writes.map((x) => x.Put?.Item?.PK).sort()).toEqual(["GID#Note#N0001", "GID#Note#N0002"]); // exactly two items, one write each
    expect(w.row("GID#Note#N0001", "META").handle).toBe(b.handle);
    expect(w.row("GID#Note#N0002", "META").handle).toBe(a.handle);
    expect(w.rows("IDALIAS#")).toHaveLength(0); // non-person renumbers leave no alias
    expect(JSON.parse(w.row(`REC#Note#${a.handle}`, "HEAD").obj_json).gramps_id).toBe("N0002");
  });

  it("a 3-cycle rotation commits in one batch, and the freed id of a rotation with a fresh id is released", async () => {
    const w = world();
    const [a, b, c] = [note(1, "N0001"), note(2, "N0002"), note(3, "N0003")];
    await w.apply([create(a), create(b), create(c)]);
    const sent = [];
    w.ctx.ddb = wrap(w.ddb, { spy: (x) => sent.push(x) });
    await w.apply([update({ ...a, gramps_id: "N0002" }, 1), update({ ...b, gramps_id: "N0003" }, 1), update({ ...c, gramps_id: "N0001" }, 1)]);
    expect(gidWrites(sent)).toHaveLength(3);
    expect([w.row("GID#Note#N0001", "META").handle, w.row("GID#Note#N0002", "META").handle, w.row("GID#Note#N0003", "META").handle]).toEqual([c.handle, a.handle, b.handle]);
    // a chain a->N0009 frees N0002 for b? b takes N0002 while a leaves it: one claim, one release
    await w.apply([update({ ...a, gramps_id: "N0009" }, 2), update({ ...b, gramps_id: "N0002" }, 2)]);
    expect(w.row("GID#Note#N0009", "META").handle).toBe(a.handle);
    expect(w.row("GID#Note#N0002", "META").handle).toBe(b.handle);
    // a plain rename frees the old id: reuse is allowed for a non-person
    await w.apply([update({ ...c, gramps_id: "N0100" }, 2)]);
    expect(w.row("GID#Note#N0001", "META")).toBeUndefined();
    await w.apply([create(note(7, "N0001"))]);
    expect(w.row("GID#Note#N0001", "META").handle).toBe(note(7).handle);
  });

  it("a claim on an id whose holder is NOT leaving is gramps_id_taken even if the holder is in the batch", async () => {
    const w = world();
    const [a, b] = [note(1, "N0001"), note(2, "N0002")];
    await w.apply([create(a), create(b)]);
    await rejects(w.apply([update({ ...a, gramps_id: "N0002" }, 1), update({ ...b, text: { _class: "StyledText", string: "same id", tags: [] } }, 1)]), 409, "gramps_id_taken");
  });

  it("a non-person delete releases the GID item and an unchanged id writes no GID item", async () => {
    const w = world();
    const a = note(1, "N0001");
    await w.apply([create(a)]);
    const sent = [];
    w.ctx.ddb = wrap(w.ddb, { spy: (x) => sent.push(x) });
    await w.apply([update({ ...a, format: 1 }, 1)]);
    expect(gidWrites(sent)).toHaveLength(0);
    await w.apply([del("Note", a.handle, 2)]);
    expect(gidWrites(sent).map((x) => Object.keys(x)[0])).toEqual(["Delete"]);
    expect(w.row("GID#Note#N0001", "META")).toBeUndefined();
  });

  it("a GID changed by a concurrent writer between read and commit is reported from the refreshed view", async () => {
    const w = world();
    const raw = w.ctx.ddb;
    let raced = false;
    w.ctx.ddb = wrap(raw, { before: async (cmd) => {
      if (cmd.constructor.name !== "TransactWriteCommand" || raced) return;
      raced = true;
      await applyBatch({ ...w.ctx, ddb: raw }, { principal: "svc-other", origin: "desktop", idempotencyKey: "rival", ops: [create(note(5, "N0001"))] });
    } });
    await rejects(w.apply([create(note(1, "N0001"))]), 409, "gramps_id_taken");
  });
});

describe("Person ids are permanent", () => {
  async function seeded(extraHead = {}) {
    const w = world({ head: { seq: 0, seeded: true, writes_enabled: true, merges_enabled: true, ...extraHead } });
    const p = person(1, "I0001");
    await w.apply([create(p)]);
    return { w, p };
  }

  it.each([
    ["delete", (p) => del("Person", p.handle, 1), "deleted"],
    ["withdraw", (p) => ({ op: "withdraw", class: "Person", handle: p.handle, base_version: 1 }), "withdrawn"],
    ["merge", (p) => del("Person", p.handle, 1, { reason: "merge", merged_into: "I0002" }), "merged"],
  ])("a %s retires GID#Person#<id> as {handle, retired, reason} and reuse by another person is 409 gramps_id_retired", async (_n, mk, reason) => {
    const { w, p } = await seeded();
    await w.apply([create(person(2, "I0002"))]);
    await w.apply([mk(p)]);
    expect(w.row("GID#Person#I0001", "META")).toMatchObject({ handle: p.handle, retired: true, reason });
    const e = await rejects(w.apply([create(person(5, "I0001"))]), 409, "gramps_id_retired");
    expect(e.details).toEqual({ class: "Person", gramps_id: "I0001" });
    expect(w.row("GID#Person#I0001", "META")).toMatchObject({ handle: p.handle, retired: true });
    if (reason === "merged") expect(w.row("IDALIAS#Person#I0001", "META")).toMatchObject({ handle: p.handle, current_gramps_id: "I0002", reason: "merge", batch_id: expect.any(String) });
    else expect(w.row("IDALIAS#Person#I0001", "META")).toBeUndefined();
  });

  it("the same person (same handle) may take its retired id back when it is resurrected", async () => {
    const { w, p } = await seeded();
    await w.apply([del("Person", p.handle, 1)]);
    await w.apply([{ ...create(p), base_version: 2 }]);
    expect(w.row("GID#Person#I0001", "META")).toMatchObject({ handle: p.handle });
    expect(w.row("GID#Person#I0001", "META").retired).toBeUndefined();
  });

  it("a person's gramps_id cannot change (409 renumber_blocked) unless the op says renumber: then the old id is retired with an alias", async () => {
    const { w, p } = await seeded();
    const e = await rejects(w.apply([update({ ...p, gramps_id: "I0042" }, 1)]), 409, "renumber_blocked");
    expect(e.details.conflicts[0]).toMatchObject({ op_id: "1" });
    await w.apply([update({ ...p, gramps_id: "I0042" }, 1, { renumber: true })]);
    expect(w.row("GID#Person#I0001", "META")).toMatchObject({ retired: true, reason: "renumbered", handle: p.handle });
    expect(w.row("GID#Person#I0042", "META")).toMatchObject({ handle: p.handle });
    expect(w.row("IDALIAS#Person#I0001", "META")).toMatchObject({ current_gramps_id: "I0042", reason: "renumber" });
    await rejects(w.apply([create(person(3, "I0001"))]), 409, "gramps_id_retired");
  });

  it("a person swap with a retiring person cannot take the id in the same batch", async () => {
    const { w, p } = await seeded();
    await rejects(w.apply([del("Person", p.handle, 1), create(person(3, "I0001"))]), 409, "gramps_id_retired");
  });

  it("merges are held while SYNC#HEAD.merges_enabled is not true", async () => {
    const { w, p } = await seeded({ merges_enabled: false });
    await rejects(w.apply([del("Person", p.handle, 1, { reason: "merge", merged_into: "I0002" })]), 409, "merges_disabled");
    await rejects(w.apply([del("Person", p.handle, 1, { reason: "merge" })]), 400, "validation"); // merged_into is required
    expect(w.row("GID#Person#I0001", "META").retired).toBeUndefined();
  });

  it("NO code path deletes a Person GID item or any IDALIAS item: every op kind, spied; the builder refuses; a random walk keeps them all", async () => {
    expect(() => gidDelete("Person", "I0001")).toThrow(/never deleted/);
    expect(gidDelete("Note", "N0001")).toEqual(gidKey("Note", "N0001"));

    const { w } = await seeded();
    const sent = [];
    w.ctx.ddb = wrap(w.ddb, { spy: (c) => sent.push(c) });
    const st = new Map(); // handle number -> { version, deleted, gid }
    const pool = Array.from({ length: 80 }, (_, i) => `I${String(100 + i).padStart(4, "0")}`);
    const allowed = new Set(["gramps_id_taken", "gramps_id_retired", "gid_conflict", "renumber_blocked"]);
    let rnd = 12345;
    const next = () => (rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) >>> 8;
    const seen = new Set();
    let ok = 0;
    const errs = [];
    for (let i = 0; i < 120; i += 1) {
      const n = 10 + (next() % 6);
      const gid = pool[next() % pool.length];
      const s = st.get(n);
      const kind = next() % 4;
      let op;
      if (!s) op = create(person(n, gid));
      else if (s.deleted) op = { ...create(person(n, s.gid)), base_version: s.version };
      else if (kind === 0) op = del("Person", h(n), s.version);
      else if (kind === 1) op = { op: "withdraw", class: "Person", handle: h(n), base_version: s.version };
      else op = update(person(n, gid), s.version, { renumber: true });
      try {
        const r = await w.apply([op]);
        ok += 1;
        const dead = op.op === "delete" || op.op === "withdraw";
        st.set(n, { version: r.results[0].version, deleted: dead, gid: dead ? s.gid : op.obj.gramps_id });
      } catch (e) {
        if (!(e instanceof SyncError && allowed.has(e.code))) throw e;
        errs.push(e.code);
      }
      for (const k of w.ddb.rows.keys()) if (k.startsWith("GID#Person#") || k.startsWith("IDALIAS#")) seen.add(k);
      for (const k of seen) expect(w.ddb.rows.has(k), `${k.split("\u0000")[0]} still present`).toBe(true);
    }
    const deletes = sent.flatMap(txnActions).filter((a) => a.Delete);
    for (const d of deletes) expect(d.Delete.Key.PK.startsWith("GID#Person#") || d.Delete.Key.PK.startsWith("IDALIAS#")).toBe(false);
    expect(sent.filter((c) => c.constructor.name === "DeleteCommand")).toHaveLength(0);
    expect(ok).toBeGreaterThan(20);
    expect(seen.size).toBeGreaterThan(6);
  });

  it("the source never names a delete of a GID or IDALIAS key outside gidDelete", () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "sync");
    for (const f of readdirSync(dir)) {
      const src = readFileSync(join(dir, f), "utf8");
      if (f === "store.js") expect([...src.matchAll(/function gidDelete\(/g)]).toHaveLength(1);
      expect(src).not.toMatch(/aliasKey\([^)]*\)[^\n]*delete|delete[^\n]*aliasKey\(/i);
      expect(src).not.toMatch(/DeleteCommand/);
    }
  });

  it("no identity is keyed by a non-person id: THREAD# subjects are person: or post:, and no sync-adjacent key builder takes an Event, Family or Place id", () => {
    const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
    const files = [];
    const walk = (d) => readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() && e.name !== "shared" ? walk(join(d, e.name)) : e.name.endsWith(".js") && files.push(join(d, e.name))));
    walk(srcDir);
    const re = /["'`](THREAD|RSUB|PLINKS|ALLOW)#[^"'`]*["'`]/g;
    let seenAny = 0;
    for (const f of files) {
      for (const line of readFileSync(f, "utf8").split("\n")) {
        for (const m of line.matchAll(re)) {
          seenAny += 1;
          expect(m[0], `${f}: ${line.trim()}`).not.toMatch(/(Family|Event|Place|Note|Media|Source|Citation|Repository|Tag)/);
        }
      }
    }
    expect(seenAny).toBeGreaterThan(0);
    const comments = readFileSync(join(srcDir, "comments.js"), "utf8");
    expect(comments).toMatch(/SUBJECT_RE = \/\^\(person:\[A-Za-z0-9_\.-\]\{1,64\}\|post:/);
  });
});

describe("the store gate (503 store_not_seeded, 503 sync_paused) is evaluated inside every call", () => {
  const ORIGINS = ["desktop", "seed", "self", "admin", "proposal", "graduation", "moderation", "tag"];
  const states = [
    ["head absent", null, (o) => (o === "seed" ? "ok" : "store_not_seeded")],
    ["seeded false", { seq: 0, seeded: false, writes_enabled: true }, (o) => (o === "seed" ? "ok" : "store_not_seeded")],
    ["seeded unset", { seq: 0, writes_enabled: true }, (o) => (o === "seed" ? "ok" : "store_not_seeded")],
    ["seeded, writes on", { seq: 0, seeded: true, writes_enabled: true }, () => "ok"],
    ["seeded, writes_enabled false", { seq: 0, seeded: true, writes_enabled: false }, () => "sync_paused"],
    ["not seeded and paused", { seq: 0, seeded: false, writes_enabled: false }, (o) => (o === "seed" ? "sync_paused" : "store_not_seeded")],
  ];
  for (const [name, head, expected] of states) {
    it.each(ORIGINS)(`${name}: origin %s`, async (origin) => {
      const w = world({ head });
      const want = expected(origin);
      const go = () => w.apply([create(person(1))], { origin });
      if (want === "ok") {
        const r = await go();
        expect(r.seq_from).toBe(1);
        expect(w.row("SYNC#HEAD", "META").seq).toBe(1); // an absent head is created by the first (seed) batch
      } else {
        await rejects(go(), 503, want);
        expect(w.rows("REC#")).toHaveLength(0);
        expect(w.rows("SYNC#LOG")).toHaveLength(0);
      }
    });
  }

  it("reads SYNC#HEAD on every call: flipping writes_enabled between two calls takes effect on the second", async () => {
    const w = world();
    await w.apply([create(person(1))]);
    w.ddb.rows.get("SYNC#HEAD\u0000META").writes_enabled = false;
    await rejects(w.apply([create(person(2))]), 503, "sync_paused");
    await rejects(w.apply([create(person(3))], { origin: "graduation" }), 503, "sync_paused");
    w.ddb.rows.get("SYNC#HEAD\u0000META").writes_enabled = true;
    await w.apply([create(person(2))]);
    expect(checkStoreGate({ seeded: true }, "tag")).toBeUndefined();
  });

  it("a gated replay is refused too: the gate precedes the receipt", async () => {
    const w = world();
    await w.apply([create(person(1))], { idempotencyKey: "k" });
    w.ddb.rows.get("SYNC#HEAD\u0000META").writes_enabled = false;
    await rejects(w.apply([create(person(1))], { idempotencyKey: "k" }), 503, "sync_paused");
  });
});

describe("caller extra items and the validator seam", () => {
  it("extra items (proposal state, contribution counters, comment updates) commit in the same transaction", async () => {
    const w = world();
    await w.ddb.send(new cmds.PutCommand({ TableName: T, Item: { PK: "PROP#01", SK: "META", state: "pending" } }));
    const sent = [];
    w.ctx.ddb = wrap(w.ddb, { spy: (c) => sent.push(c) });
    const extra = {
      updates: [{ key: { PK: "PROP#01", SK: "META" }, update: "SET #st = :a", condition: "#st = :p", names: { "#st": "state" }, values: { ":a": "approved", ":p": "pending" }, tag: "prop" }, counterUpdate({ PK: "CSTAT#site", SK: "TOTAL" }, { edits: 1 })],
      puts: [{ item: { PK: "CONTRIB#svc", SK: "E#01", entity: "contrib" } }],
    };
    const r = await w.apply([create(person(1))], { origin: "proposal", extra });
    expect(sent.filter((c) => c.constructor.name === "TransactWriteCommand")).toHaveLength(1);
    expect(w.row("PROP#01", "META").state).toBe("approved");
    expect(w.row("CSTAT#site", "TOTAL").edits).toBe(1);
    expect(w.row("CONTRIB#svc", "E#01")).toBeDefined();
    expect(r.seq_to).toBe(1);

    // a failed extra condition cancels everything, and the TxnCancelled is the caller's to map
    const before = JSON.stringify(w.ddb.all());
    const e = await w.apply([create(person(2))], { extra: { updates: [{ key: { PK: "PROP#01", SK: "META" }, update: "SET #st = :a", condition: "#st = :p", names: { "#st": "state" }, values: { ":a": "x", ":p": "pending" }, tag: "prop" }] } }).catch((x) => x);
    expect(e).toBeInstanceOf(TxnCancelled);
    expect(e.failures[0].tag).toBe("prop");
    expect(JSON.stringify(w.ddb.all())).toBe(before);
  });

  it("an extra item that targets a key the batch writes is refused before sending", async () => {
    const w = world();
    const p = person(1);
    await expect(w.apply([create(p)], { extra: { puts: [{ item: { PK: `REC#Person#${p.handle}`, SK: "HEAD" } }] } })).rejects.toMatchObject({ code: "txn_duplicate_key" });
    expect(w.rows("REC#")).toHaveLength(0);
  });

  it("never exceeds 100 actions: over-budget extras throw txn_too_large before any send; 25 ops are refused 413", async () => {
    const w = world();
    const sent = [];
    w.ctx.ddb = wrap(w.ddb, { spy: (c) => sent.push(c) });
    const puts = Array.from({ length: 100 }, (_, i) => ({ item: { PK: `X#${i}`, SK: "1" } }));
    await expect(w.apply([create(person(1))], { extra: { puts } })).rejects.toMatchObject({ code: "txn_too_large" });
    expect(sent.some((c) => c.constructor.name === "TransactWriteCommand")).toBe(false);
    // the largest legal batch: 24 swapped non-person ids = 24 heads + 24 logs + 24 gids + head + receipt + audit = 75
    const notes = Array.from({ length: 24 }, (_, i) => note(i + 1, `N${String(i + 1).padStart(4, "0")}`));
    await w.apply(notes.map((n) => create(n)));
    sent.length = 0;
    await w.apply(notes.map((n, i) => update({ ...n, gramps_id: notes[(i + 1) % 24].gramps_id }, 1)));
    const actions = sent.filter((c) => c.constructor.name === "TransactWriteCommand").flatMap(txnActions);
    expect(actions.length).toBe(75);
    expect(actions.length).toBeLessThanOrEqual(100);
  });

  it("ctx.validate sees the view and can refuse a batch with nothing written; it is not given the server-only object text", async () => {
    let view;
    const w = world({ validate: async (v) => { view = v; if (v.ops.some((o) => o.obj?.private === true)) throw new HttpError(422, "privacy_violation", "refused"); } });
    await w.apply([create(person(1))]);
    expect(view).toMatchObject({ origin: "desktop", principal: "svc-test", sync_head: { seq: 0 } });
    expect(view.ops[0].objJson).toBeUndefined();
    await rejects(w.apply([create(person(2, "I0002", { private: true }))]), 422, "privacy_violation");
    expect(w.rows("REC#")).toHaveLength(1);
  });

  it("runs no notification producer and writes no notification, subscription or contribution item itself", async () => {
    const w = world();
    await w.apply([create(person(1)), create(note(1))]);
    await w.apply([update(person(1), 1)]);
    const pks = w.ddb.all().map((r) => r.PK.split("#")[0]);
    expect(new Set(pks)).toEqual(new Set(["SYNC", "REC", "GID", "AUDIT"]));
    const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "sync");
    for (const f of ["apply.js", "store.js"]) {
      const src = readFileSync(join(dir, f), "utf8").split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/**")).join("\n");
      expect(src, f).not.toMatch(/from "\.\.\/(notify|comments|content)\.js"/);
      expect(src, f).not.toMatch(/INBOX#|CONTRIB#|CSTAT#|RSUB#|self_edit/);
    }
  });
});

describe("the commit-hook registry", () => {
  beforeEach(() => defaultHooks.clear());

  it("defaults to no-ops", async () => {
    const reg = createHookRegistry();
    expect(reg.contributors()).toEqual([]);
    expect(reg.afterCommitHooks()).toEqual([]);
    expect(defaultHooks.contributors()).toEqual([]);
    const w = world({ hooks: undefined });
    await w.apply([create(person(1))]); // the process-wide registry is empty: nothing breaks
    expect(w.rows("REC#")).toHaveLength(1);
    expect(() => registerContributor("nope")).toThrow(TypeError);
    expect(() => registerAfterCommit(null)).toThrow(TypeError);
  });

  it("registerContributor adds items inside the batch's own transaction, given the batch and its origin", async () => {
    const w = world();
    const seen = [];
    const off = w.hooks.registerContributor((batch, origin) => {
      seen.push({ batch, origin });
      return { updates: [counterUpdate({ PK: "CONTRIB#svc-test", SK: "TOTAL" }, { self_edit: batch.changes.length })], puts: [{ item: { PK: `CONTRIB#svc-test`, SK: `E#${batch.seq_from}` } }] };
    });
    const sent = [];
    w.ctx.ddb = wrap(w.ddb, { spy: (c) => sent.push(c) });
    const p = person(1);
    await w.apply([create(p), create(note(1))], { origin: "self" });
    expect(seen).toHaveLength(1);
    expect(seen[0].origin).toBe("self");
    expect(seen[0].batch).toMatchObject({ origin: "self", principal: "svc-test", seq_from: 1, seq_to: 2 });
    expect(seen[0].batch.changes[0]).toMatchObject({ op: "create", class: "Person", handle: p.handle, version: 1, before: null, after: expect.objectContaining({ gramps_id: "I0001" }) });
    expect(sent.filter((c) => c.constructor.name === "TransactWriteCommand")).toHaveLength(1);
    expect(w.row("CONTRIB#svc-test", "TOTAL").self_edit).toBe(2);
    expect(w.row("CONTRIB#svc-test", "E#1")).toBeDefined();
    off();
    await w.apply([create(person(2))]);
    expect(w.row("CONTRIB#svc-test", "TOTAL").self_edit).toBe(2); // unregistered
  });

  it("a contributor's counter is transactional: if the record write loses, the counter does not move", async () => {
    const w = world();
    w.hooks.registerContributor(() => ({ updates: [counterUpdate({ PK: "CSTAT#site", SK: "TOTAL" }, { edits: 1 })] }));
    const p = person(1);
    await w.apply([create(p)]);
    await rejects(w.apply([update(p, 9)]), 409, "version_conflict");
    expect(w.row("CSTAT#site", "TOTAL").edits).toBe(1);
  });

  it("two contributors counting the same key are merged into one update; a clash with a non-counter is refused", async () => {
    const w = world();
    w.hooks.registerContributor(() => ({ updates: [counterUpdate({ PK: "CSTAT#site", SK: "TOTAL" }, { edits: 1 })] }));
    w.hooks.registerContributor(() => ({ updates: [counterUpdate({ PK: "CSTAT#site", SK: "TOTAL" }, { edits: 2 })] }));
    await w.apply([create(person(1))]);
    expect(w.row("CSTAT#site", "TOTAL").edits).toBe(3);
    w.hooks.registerContributor(() => ({ puts: [{ item: { PK: "CSTAT#site", SK: "TOTAL" } }] }));
    await expect(w.apply([create(person(2))])).rejects.toMatchObject({ code: "txn_duplicate_key" });
  });

  it("a contributor that throws fails the batch and nothing is written", async () => {
    const w = world();
    w.hooks.registerContributor(() => { throw new Error("boom"); });
    await expect(w.apply([create(person(1))])).rejects.toThrow("boom");
    expect(w.rows("REC#")).toHaveLength(0);
  });

  it("afterCommit runs exactly once per committed batch with {batch_id, origin, seq_from, seq_to}, even across a seq-race retry", async () => {
    const w = world();
    const calls = [];
    w.hooks.registerAfterCommit((info) => { calls.push(info); });
    const raw = w.ctx.ddb;
    let raced = false;
    w.ctx.ddb = wrap(raw, { before: async (cmd) => {
      if (cmd.constructor.name !== "TransactWriteCommand" || raced) return;
      raced = true;
      await applyBatch({ ...w.ctx, ddb: raw, hooks: createHookRegistry() }, { principal: "svc-other", origin: "desktop", idempotencyKey: "rival", ops: [create(person(2))] });
    } });
    const r = await w.apply([create(person(1))], { origin: "admin" });
    expect(r.seq_from).toBe(2); // the retry happened
    expect(calls).toEqual([{ batch_id: r.batch_id, origin: "admin", seq_from: 2, seq_to: 2 }]);
    // not on a refused batch, not on a replay
    await rejects(w.apply([update(person(1), 7)]), 409, "version_conflict");
    await w.apply([create(person(1))], { idempotencyKey: "key-1" }).catch(() => {});
    expect(calls).toHaveLength(1);
  });

  it("every origin runs the after-commit hook once", async () => {
    const w = world();
    const seen = [];
    w.hooks.registerAfterCommit((i) => seen.push(i.origin));
    let n = 0;
    for (const origin of ["desktop", "seed", "self", "admin", "proposal", "graduation", "moderation", "tag"]) await w.apply([create(note((n += 1)))], { origin });
    expect(seen).toEqual(["desktop", "seed", "self", "admin", "proposal", "graduation", "moderation", "tag"]);
  });

  it("a failing (or rejecting) after-commit hook never fails the committed write, and later hooks still run", async () => {
    const logged = [];
    const w = world({ log: { warn: (m, d) => logged.push([m, d]), error() {} } });
    let later = 0;
    w.hooks.registerAfterCommit(() => { throw new Error("secret-token-value"); });
    w.hooks.registerAfterCommit(async () => { throw Object.assign(new Error("also secret"), { code: "boom" }); });
    w.hooks.registerAfterCommit(() => { later += 1; });
    const r = await w.apply([create(person(1))]);
    expect(r.replayed).toBe(false);
    expect(w.rows("REC#")).toHaveLength(1);
    expect(later).toBe(1);
    expect(logged).toHaveLength(2);
    expect(JSON.stringify(logged)).not.toMatch(/secret/); // name and code only
  });
});

describe("module surface", () => {
  it("store keys follow BRD2 section 4", () => {
    expect(headKey()).toEqual({ PK: "SYNC#HEAD", SK: "META" });
    expect(gidKey("Person", "I0001")).toEqual({ PK: "GID#Person#I0001", SK: "META" });
  });
});
