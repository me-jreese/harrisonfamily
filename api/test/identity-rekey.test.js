// HFY-TSK-294 (identity-merge-rekey): the post-merge re-key of person-id-keyed social data, against the in-memory DynamoDB fake. Synthetic ids only.
import { describe, expect, it } from "vitest";
import { cmds, createFakeDdb } from "./world.js";
import { applyBatch } from "../src/sync/apply.js";
import { createHookRegistry } from "../src/sync/hooks.js";
import { headKey } from "../src/sync/store.js";
import { MemberCheckUnavailable, UNIT_BUDGET, createRekeyHook, markerKeys, pack, pendingAliases, registerRekeyHook, rekeyPending, rekeyPerson } from "../src/identity-rekey.js";
import { seedPosts } from "../src/content.js";
import { MAX_TXN_ITEMS } from "../src/txn.js";
import { mergesOn, parseArgs, rekey, run } from "../scripts/sync-admin.mjs";

const T = "hfy-app";
const noSleep = { sleep: async () => {} };
const h = (n) => n.toString(16).padStart(28, "0");
const person = (n, gid) => ({ _class: "Person", handle: h(n), gramps_id: gid ?? `I${String(n).padStart(4, "0")}`, change: 1, private: false, gender: 1 });
const create = (o) => ({ op: "create", class: o._class, handle: o.handle, base_version: null, obj: o });
const merge = (o, into) => ({ op: "delete", class: "Person", handle: o.handle, base_version: 1, reason: "merge", merged_into: into });
const ulid = (n) => `01HZZZZZZZZZZZZZZZZZZZ${String(n).padStart(4, "0")}`;

function world({ members = [], head = {} } = {}) {
  const ddb = createFakeDdb();
  ddb.rows.set("SYNC#HEAD\u0000META", { ...headKey(), seq: 0, seeded: true, writes_enabled: true, merges_enabled: true, ...head });
  let t = Date.parse("2026-10-14T00:00:00Z");
  let u = 0;
  const base = { ddb, cmds, table: T, now: () => (t += 1000), uid: () => `uid${String(++u).padStart(4, "0")}`, log: { warn() {}, error() {} }, txnOpts: noSleep, isMember: async (id) => members.includes(id) };
  const hooks = createHookRegistry();
  const apply = (ops, k = String(Math.random())) => applyBatch({ ...base, hooks, unsafeNoValidate: true }, { principal: "svc-test", origin: "desktop", idempotencyKey: k, ops });
  const row = (pk, sk) => ddb.rows.get(`${pk}\u0000${sk}`);
  const rows = (prefix) => ddb.all().filter((r) => r.PK.startsWith(prefix));
  const put = (item) => ddb.rows.set(`${item.PK}\u0000${item.SK}`, structuredClone(item));
  return { ddb, ctx: base, hooks, apply, row, rows, put };
}

const comment = (thread, n, extra = {}) => ({ PK: `THREAD#${thread}`, SK: `C#${ulid(n)}`, GSI1PK: "COMMENTS", GSI1SK: ulid(n), entity: "comment", comment: { id: ulid(n), threadId: thread, author: { id: "I0900", label: "Synthetic" }, body: `synthetic ${n}`, created_at: "2026-10-01T00:00:00.000Z", ...extra } });
const reaction = (thread, n, by) => ({ PK: `THREAD#${thread}`, SK: `R#${ulid(n)}#${by}`, entity: "reaction", target: ulid(n), reaction: { emoji: "x", by, created_at: "2026-10-01T00:00:00.000Z" } });
const follow = (principal, id, at = "2026-10-02T00:00:00.000Z") => ({ PK: `RSUB#${principal}`, SK: `REC#person:${id}`, entity: "rsub", subject: `person:${id}`, created_at: at, GSI1PK: `RECSUB#person:${id}`, GSI1SK: principal });
const alias = (oldId, newId, extra = {}) => ({ PK: `IDALIAS#Person#${oldId}`, SK: "META", entity: "idalias", class: "Person", old_gramps_id: oldId, handle: h(1), current_gramps_id: newId, reason: "merge", batch_id: "b1", at: "2026-10-14T00:00:00Z", GSI1PK: "IDALIAS#Person", GSI1SK: oldId, ...extra });
const thread = (w, id) => w.ddb.all().filter((r) => r.PK === `THREAD#person:${id}`);

function seedData(w) {
  w.put(alias("I0001", "I0002"));
  w.put(comment("person:I0001", 1));
  w.put(comment("person:I0001", 2));
  w.put(comment("person:I0002", 3));
  w.put(reaction("person:I0001", 1, "I0800"));
  w.put(follow("I0801", "I0001"));
  w.put(follow("I0802", "I0001"));
  w.put(follow("I0802", "I0002", "2026-09-01T00:00:00.000Z")); // already follows the survivor: deduplicated
  w.put(follow("I0002", "I0001")); // the survivor's own principal: dropped
  w.put({ PK: "OTD#HIDDEN", SK: "META", ids: ["birth:I0001", "birth:I0002", "evt:abc"], version: 3 });
  w.put({ PK: "AUDIT#something", SK: "x", entity: "audit" });
}
const seedPost = (w) => seedPosts({ ddb: w.ddb, cmds, table: T }, [{ id: ulid(77), author: { id: "I0803", label: "Synthetic" }, body: "synthetic", subject: "person:I0001", created_at: "2026-10-01T00:00:00.000Z" }]);
const snapshot = (w) => JSON.stringify(w.ddb.all().sort((a, b) => (`${a.PK}|${a.SK}` < `${b.PK}|${b.SK}` ? -1 : 1)));

describe("rekeyPerson(): what moves", () => {
  it("moves comments and reactions to the survivor's thread and rewrites threadId", async () => {
    const w = world();
    seedData(w);
    const r = await rekeyPerson(w.ctx, "I0001", "I0002");
    expect(r).toMatchObject({ state: "done", counts: { comments: 2, reactions: 1 } });
    expect(thread(w, "I0001")).toEqual([]);
    expect(thread(w, "I0002").map((x) => x.SK).sort()).toEqual([`C#${ulid(1)}`, `C#${ulid(2)}`, `C#${ulid(3)}`, `R#${ulid(1)}#I0800`]);
    expect(w.row("THREAD#person:I0002", `C#${ulid(1)}`).comment.threadId).toBe("person:I0002");
    expect(w.row("THREAD#person:I0002", `C#${ulid(1)}`).comment.body).toBe("synthetic 1");
  });

  it("moves follows, deduplicated: a principal already following the survivor, and the survivor itself, only lose the old follow", async () => {
    const w = world();
    seedData(w);
    const r = await rekeyPerson(w.ctx, "I0001", "I0002");
    expect(r.counts).toMatchObject({ follows: 1, followsDropped: 2 });
    expect(w.rows("RSUB#").map((x) => `${x.PK}/${x.SK}`).sort()).toEqual(["RSUB#I0801/REC#person:I0002", "RSUB#I0802/REC#person:I0002"]);
    expect(w.row("RSUB#I0801", "REC#person:I0002")).toMatchObject({ subject: "person:I0002", GSI1PK: "RECSUB#person:I0002", GSI1SK: "I0801", created_at: "2026-10-02T00:00:00.000Z" });
    expect(w.row("RSUB#I0802", "REC#person:I0002").created_at).toBe("2026-09-01T00:00:00.000Z"); // the existing follow is kept
    expect(w.ddb.all().filter((x) => x.GSI1PK === "RECSUB#person:I0001")).toEqual([]);
  });

  it("rewrites the hidden on-this-day birth id, deduplicated, and bumps the version; event ids are untouched", async () => {
    const w = world();
    seedData(w);
    await rekeyPerson(w.ctx, "I0001", "I0002");
    expect(w.row("OTD#HIDDEN", "META")).toMatchObject({ ids: ["birth:I0002", "evt:abc"], version: 4 });
  });

  it("re-points the post subject on all three post items and the IDX#SUBJECT GSI1 key", async () => {
    const w = world();
    seedData(w);
    await seedPost(w);
    const r = await rekeyPerson(w.ctx, "I0001", "I0002");
    expect(r.counts.posts).toBe(1);
    expect(w.row(`POST#${ulid(77)}`, "META").post.subject).toBe("person:I0002");
    expect(w.row(`POST#${ulid(77)}`, "IDX#AUTHOR").post.subject).toBe("person:I0002");
    expect(w.row(`POST#${ulid(77)}`, "IDX#SUBJECT")).toMatchObject({ GSI1PK: "SUBJECT#person:I0002", GSI1SK: ulid(77) });
    expect(w.row(`POST#${ulid(77)}`, "IDX#SUBJECT").post.subject).toBe("person:I0002");
    expect(w.ddb.all().filter((x) => x.GSI1PK === "SUBJECT#person:I0001")).toEqual([]);
  });

  it("touches nothing outside the keyed data and records a done marker and an audit item (no counts of ids)", async () => {
    const w = world();
    seedData(w);
    await rekeyPerson(w.ctx, "I0001", "I0002", { batchId: "b1" });
    expect(w.row("AUDIT#something", "x")).toBeDefined();
    expect(w.row(...Object.values(markerKeys("I0001")))).toMatchObject({ state: "done", new_gramps_id: "I0002", batch_id: "b1" });
    expect(w.row("IDALIAS#Person#I0001", "META").current_gramps_id).toBe("I0002"); // the alias item is never modified
    expect(w.rows("AUDIT#rekey:Person:I0001")).toHaveLength(1);
  });
});

describe("idempotency and the transaction budget", () => {
  it("a re-run moves nothing and keeps the first run's counts", async () => {
    const w = world();
    seedData(w);
    await seedPost(w);
    await rekeyPerson(w.ctx, "I0001", "I0002");
    const data = (x) => !/^(REKEY#|AUDIT#rekey)/.test(x.PK);
    const before = JSON.stringify(w.ddb.all().filter(data));
    const sent = [];
    const raw = w.ddb.send.bind(w.ddb);
    w.ctx.ddb = { ...w.ddb, send: async (c) => { sent.push(c.constructor.name); return raw(c); } };
    const again = await rekeyPerson(w.ctx, "I0001", "I0002");
    expect(again.state).toBe("done");
    expect(again.counts).toEqual({ comments: 0, reactions: 0, follows: 0, followsDropped: 0, hidden: 0, posts: 0 });
    // only the marker and its audit are written again; every data row is as it was
    expect(JSON.stringify(w.ddb.all().filter(data))).toBe(before);
    expect(w.row("REKEY#Person#I0001", "META").counts).toMatchObject({ comments: 2, reactions: 1, follows: 1, hidden: 1, posts: 1 });
  });

  it("packs units into transactions of at most UNIT_BUDGET actions, and the real run never exceeds the 100-action limit", async () => {
    expect(UNIT_BUDGET).toBeLessThan(MAX_TXN_ITEMS);
    const units = Array.from({ length: 200 }, () => ({ puts: [{ item: {} }], deletes: [{ key: {} }], t: { comments: 1 } }));
    const txns = pack(units);
    expect(txns.every((t) => t.puts.length + t.deletes.length <= UNIT_BUDGET)).toBe(true);
    expect(txns.reduce((n, t) => n + t.t.comments, 0)).toBe(200);
    const w = world();
    w.put(alias("I0001", "I0002"));
    for (let i = 1; i <= 130; i += 1) w.put(comment("person:I0001", i));
    const sizes = [];
    const raw = w.ddb.send.bind(w.ddb);
    w.ctx.ddb = { ...w.ddb, send: async (c) => { if (c.constructor.name === "TransactWriteCommand") sizes.push(c.input.TransactItems.length); return raw(c); } };
    const r = await rekeyPerson(w.ctx, "I0001", "I0002");
    expect(r.counts.comments).toBe(130);
    expect(thread(w, "I0002")).toHaveLength(130);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(MAX_TXN_ITEMS);
  });

  it("a comment edited while the job runs is not clobbered: the cancelled move is re-planned from the store", async () => {
    const w = world();
    w.put(alias("I0001", "I0002"));
    w.put(comment("person:I0001", 1));
    let raced = false;
    const raw = w.ddb.send.bind(w.ddb);
    w.ctx.ddb = { ...w.ddb, send: async (c) => {
      if (!raced && c.constructor.name === "TransactWriteCommand") {
        raced = true;
        const cur = w.row("THREAD#person:I0001", `C#${ulid(1)}`);
        w.put({ ...cur, comment: { ...cur.comment, body: "edited", edited_at: "2026-10-03T00:00:00.000Z" } });
      }
      return raw(c);
    } };
    const r = await rekeyPerson(w.ctx, "I0001", "I0002");
    expect(r.state).toBe("done");
    expect(w.row("THREAD#person:I0002", `C#${ulid(1)}`).comment).toMatchObject({ body: "edited", threadId: "person:I0002" });
    expect(thread(w, "I0001")).toEqual([]);
  });
});

describe("member principals are never re-keyed", () => {
  it.each([
    ["the member list", { members: ["I0001"] }, () => {}, "member_list"],
    ["an ALLOW# entry", {}, (w) => w.put({ PK: "ALLOW#a@example.test", SK: "META", GSI1PK: "ALLOWSUB#I0001", GSI1SK: "ALLOW#a@example.test", entity: "allow", sub: "I0001", state: "active" }), "allow_entry"],
    ["a PLINKS# item", {}, (w) => w.put({ PK: "PLINKS#I0001", SK: "META", links: {} }), "plinks_partition"],
    ["a CONTRIB# event", {}, (w) => w.put({ PK: "CONTRIB#I0001", SK: "E#x" }), "contrib_partition"],
    ["an INBOX# item", {}, (w) => w.put({ PK: "INBOX#I0001", SK: "x" }), "inbox_partition"],
  ])("refuses an alias whose old id is a member principal (%s): nothing moves and the alias is marked refused", async (_n, opts, extra, evidence) => {
    const w = world(opts);
    seedData(w);
    extra(w);
    const before = snapshot(w);
    const r = await rekeyPerson(w.ctx, "I0001", "I0002");
    expect(r).toMatchObject({ state: "refused", reason: "member_principal" });
    const strip = (s) => JSON.parse(s).filter((x) => !/^(REKEY#|AUDIT#rekey)/.test(x.PK));
    expect(strip(snapshot(w))).toEqual(strip(before));
    expect(w.row("REKEY#Person#I0001", "META")).toMatchObject({ state: "refused", evidence });
    expect(thread(w, "I0001").length).toBeGreaterThan(0);
  });

  it("the member principal's own keyed items stay where they are even when the alias is processed", async () => {
    const w = world();
    seedData(w);
    w.put({ PK: "PLINKS#I0002", SK: "META", links: {} });
    w.put({ PK: "CONTRIB#I0002", SK: "E#x" });
    w.put({ PK: "INBOX#I0002", SK: "x" });
    const keep = [w.row("PLINKS#I0002", "META"), w.row("CONTRIB#I0002", "E#x"), w.row("INBOX#I0002", "x")];
    await rekeyPerson(w.ctx, "I0001", "I0002");
    expect([w.row("PLINKS#I0002", "META"), w.row("CONTRIB#I0002", "E#x"), w.row("INBOX#I0002", "x")]).toEqual(keep);
    expect(w.rows("PLINKS#I0001")).toEqual([]);
  });

  it("a member list that throws leaves the alias pending (no marker, nothing moved)", async () => {
    const w = world();
    seedData(w);
    w.ctx.isMember = async () => { throw new Error("s3 down"); };
    await expect(rekeyPerson(w.ctx, "I0001", "I0002")).rejects.toThrow();
    expect(w.row("REKEY#Person#I0001", "META")).toBeUndefined();
    expect(thread(w, "I0001").length).toBeGreaterThan(0);
  });
});

describe("the post-commit job on a real merge", () => {
  it("applyBatch(merge) -> afterCommit hook re-keys by the committed IDALIAS item; a later batch retries nothing that is done", async () => {
    const w = world();
    const a = person(1);
    const b = person(2);
    await w.apply([create(a), create(b)]);
    w.put(comment("person:I0001", 1));
    w.put(follow("I0801", "I0001"));
    registerRekeyHook(w.ctx, w.hooks);
    registerRekeyHook(w.ctx, w.hooks); // a second registration is a no-op
    expect(w.hooks.afterCommitHooks()).toHaveLength(1);
    const r = await w.apply([merge(a, "I0002")], "merge-1");
    expect(r.replayed).toBe(false);
    expect(w.row("IDALIAS#Person#I0001", "META")).toMatchObject({ current_gramps_id: "I0002", reason: "merge" });
    expect(thread(w, "I0001")).toEqual([]);
    expect(thread(w, "I0002")).toHaveLength(1);
    expect(w.row("RSUB#I0801", "REC#person:I0002")).toBeDefined();
    expect(w.row("REKEY#Person#I0001", "META")).toMatchObject({ state: "done" });
    expect(await pendingAliases(w.ctx)).toEqual([]);
    // the replay of the stored receipt does not run the hook again
    const sent = [];
    const raw = w.ddb.send.bind(w.ddb);
    w.ctx.ddb = { ...w.ddb, send: async (c) => { sent.push(c.constructor.name); return raw(c); } };
    expect((await w.apply([merge(a, "I0002")], "merge-1")).replayed).toBe(true);
  });

  it("a hook that fails does not fail the merge, and the next run finishes it", async () => {
    const w = world();
    const a = person(1);
    await w.apply([create(a), create(person(2))]);
    w.put(comment("person:I0001", 1));
    let fail = true;
    const ctx = { ...w.ctx, isMember: async () => { if (fail) throw new Error("boom"); return false; } };
    w.hooks.registerAfterCommit(createRekeyHook(ctx));
    await expect(w.apply([merge(a, "I0002")])).resolves.toMatchObject({ replayed: false });
    expect(thread(w, "I0001")).toHaveLength(1); // not moved yet
    expect(await pendingAliases(ctx)).toEqual([expect.objectContaining({ oldId: "I0001", newId: "I0002", state: "new" })]);
    fail = false;
    expect(await rekeyPending(ctx)).toEqual([expect.objectContaining({ state: "done" })]);
    expect(thread(w, "I0002")).toHaveLength(1);
  });

  it("an alias whose survivor was merged away in turn is re-keyed to the live person at the end of the chain", async () => {
    const w = world();
    w.put(alias("I0001", "I0002"));
    w.put(alias("I0002", "I0003", { batch_id: "b2" }));
    w.put(comment("person:I0001", 1));
    w.put(comment("person:I0002", 2));
    const out = await rekeyPending(w.ctx);
    expect(out.map((x) => x.state)).toEqual(["done", "done"]);
    expect(thread(w, "I0003")).toHaveLength(2);
    expect(thread(w, "I0001")).toEqual([]);
    expect(thread(w, "I0002")).toEqual([]);
  });

  it("a renumber alias is not a merge: nothing moves", async () => {
    const w = world();
    w.put(alias("I0001", "I0002", { reason: "renumber" }));
    w.put(comment("person:I0001", 1));
    expect(await rekeyPending(w.ctx)).toEqual([]);
    expect(thread(w, "I0001")).toHaveLength(1);
  });
});

describe("sync-admin: rekey and merges-on", () => {
  const actx = (w) => ({ ...w.ctx, log: () => {} });
  it("merges-on refuses --apply while a re-key is unfinished, then sets merges_enabled once it is done; the meta flag follows the literal true", async () => {
    const w = world({ head: { merges_enabled: undefined } });
    delete w.row("SYNC#HEAD", "META").merges_enabled;
    w.put(alias("I0001", "I0002"));
    w.put(comment("person:I0001", 1));
    await expect(run(parseArgs(["merges-on", "--apply"]), actx(w))).rejects.toThrow(/unfinished re-key/);
    expect(w.row("SYNC#HEAD", "META").merges_enabled).toBeUndefined();
    await run(parseArgs(["merges-on", "--dry-run"]), actx(w)); // a dry run reports and writes nothing
    expect(await rekey(actx(w), { apply: false })).toMatchObject({ planned: true, pending: 1 });
    await run(parseArgs(["rekey", "--apply"]), actx(w));
    expect(thread(w, "I0002")).toHaveLength(1);
    await run(parseArgs(["merges-on", "--apply", "--by", "operator-a"]), actx(w));
    expect(w.row("SYNC#HEAD", "META").merges_enabled).toBe(true);
    await run(parseArgs(["merges-off", "--apply"]), actx(w));
    expect(w.row("SYNC#HEAD", "META").merges_enabled).toBe(false);
  });

  it("a refused alias does not block merges-on (it is settled), and rekey takes no other flags", async () => {
    const w = world({ members: ["I0001"], head: { merges_enabled: false } });
    w.put(alias("I0001", "I0002"));
    await rekey(actx(w), { apply: true });
    await expect(mergesOn(actx(w), { apply: true })).resolves.toMatchObject({ changed: true });
    expect(() => parseArgs(["rekey", "--apply", "--by", "x"])).toThrow(/does not apply/);
  });
});

describe("review fixes: fail-closed member check, pending photos, diagnostics, hidden shape", () => {
  const actx2 = (w) => ({ ...w.ctx, log: () => {} });
  it("a ctx with no isMember fails closed: nothing moves, no marker; the CLI wants --members", async () => {
    const w = world();
    seedData(w);
    const { isMember, ...bare } = w.ctx;
    await expect(rekeyPerson(bare, "I0001", "I0002")).rejects.toBeInstanceOf(MemberCheckUnavailable);
    expect(w.row("REKEY#Person#I0001", "META")).toBeUndefined();
    expect((await rekeyPending(bare))[0]).toMatchObject({ state: "member_check_unavailable" });
    expect(thread(w, "I0001").length).toBeGreaterThan(0);
    await expect(rekey({ ...bare, log: () => {} }, { apply: true })).rejects.toThrow(/--members/);
    expect(parseArgs(["rekey", "--apply", "--members", "I1,I2"]).members).toEqual(["I1", "I2"]);
    await rekey({ ...bare, log: () => {} }, { apply: true, members: [] });
    expect(thread(w, "I0002").length).toBeGreaterThan(0);
  });

  it("the CLI member list refuses a member id", async () => {
    const w = world();
    seedData(w);
    const { isMember, ...bare } = w.ctx;
    await rekey({ ...bare, log: () => {} }, { apply: true, members: ["I0001"] });
    expect(w.row("REKEY#Person#I0001", "META").state).toBe("refused");
    expect(thread(w, "I0001").length).toBeGreaterThan(0);
  });

  it("--retry-refused re-evaluates a refused alias; a plain pass leaves it settled", async () => {
    const w = world({ members: ["I0001"] });
    seedData(w);
    await rekeyPending(w.ctx);
    expect(w.row("REKEY#Person#I0001", "META").state).toBe("refused");
    w.ctx.isMember = async () => false;
    expect(await rekeyPending(w.ctx)).toEqual([]);
    expect((await rekeyPending(w.ctx, { retryRefused: true }))[0]).toMatchObject({ state: "done" });
    expect(thread(w, "I0001")).toEqual([]);
  });

  it("a comment with a pending photo graduation stays (with its reactions); the alias stays partial and finishes later", async () => {
    const w = world();
    w.put(alias("I0001", "I0002"));
    w.put(comment("person:I0001", 1, { attachments: [{ graduated: { state: "pending" } }] }));
    w.put(reaction("person:I0001", 1, "I0800"));
    w.put(comment("person:I0001", 2));
    const r = await rekeyPerson(w.ctx, "I0001", "I0002");
    expect(r.state).toBe("partial");
    expect(thread(w, "I0001").map((x) => x.SK).sort()).toEqual([`C#${ulid(1)}`, `R#${ulid(1)}#I0800`]);
    expect(thread(w, "I0002")).toHaveLength(1);
    w.put(comment("person:I0001", 1, { attachments: [{ graduated: { state: "done" } }] }));
    expect((await rekeyPerson(w.ctx, "I0001", "I0002")).state).toBe("done");
    expect(thread(w, "I0001")).toEqual([]);
    expect(thread(w, "I0002")).toHaveLength(3);
  });

  it("an unresolved alias is persisted once as a diagnostic and is retried", async () => {
    const w = world();
    w.put(alias("I0001", "I0002"));
    w.put(alias("I0002", "I0001"));
    const r = await rekeyPending(w.ctx);
    expect(r.map((x) => x.state)).toEqual(["unresolved", "unresolved"]);
    expect(w.row("REKEY#Person#I0001", "META")).toMatchObject({ state: "unresolved", reason: "no_live_survivor" });
    const audits = w.rows("AUDIT#").length;
    await rekeyPending(w.ctx);
    expect(w.rows("AUDIT#").length).toBe(audits);
    expect((await pendingAliases(w.ctx)).length).toBe(2);
  });

  it("--resweep revisits a done alias and moves late orphans", async () => {
    const w = world();
    seedData(w);
    await rekeyPending(w.ctx);
    w.put(comment("person:I0001", 9));
    expect(await rekeyPending(w.ctx)).toEqual([]);
    await rekeyPending(w.ctx, { resweep: true });
    expect(thread(w, "I0001")).toEqual([]);
  });

  it("the hidden row keeps extra attributes and tolerates a missing version", async () => {
    const w = world();
    w.put(alias("I0001", "I0002"));
    w.put({ PK: "OTD#HIDDEN", SK: "META", ids: ["birth:I0001"], note: "synthetic", updatedBy: "x" });
    await rekeyPerson(w.ctx, "I0001", "I0002");
    expect(w.row("OTD#HIDDEN", "META")).toMatchObject({ ids: ["birth:I0002"], note: "synthetic", updatedBy: "x", version: 1 });
  });
});
