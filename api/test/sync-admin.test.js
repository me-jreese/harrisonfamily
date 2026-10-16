// HFY-TSK-177: scripts/sync-admin.mjs (pause, resume, render, resurrect) against the fake store. Synthetic objects only.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cmds, createFakeDdb } from "./world.js";
import { applyBatch } from "../src/sync/apply.js";
import { headKey, seqKey } from "../src/sync/store.js";
import { AdminError, GRACE_MS, HELP, parseArgs, renderPayload, run, cliInvoke } from "../scripts/sync-admin.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/sync-admin.mjs", import.meta.url));
const T = "hfy-app";
const h = (n) => n.toString(16).padStart(28, "0");
const person = (n) => ({ _class: "Person", handle: h(n), gramps_id: `I${String(n).padStart(4, "0")}`, change: 1, private: false, gender: 1 });
const note = (n) => ({ _class: "Note", handle: h(2000 + n), gramps_id: `N${String(n).padStart(4, "0")}`, change: 1, private: false, text: { _class: "StyledText", string: `Synthetic ${n}`, tags: [] } });
const create = (o) => ({ op: "create", class: o._class, handle: o.handle, base_version: null, obj: o });
const update = (o, base) => ({ op: "update", class: o._class, handle: o.handle, base_version: base, obj: o });
const withdraw = (o, base) => ({ op: "withdraw", class: o._class, handle: o.handle, base_version: base, reason: "private" });
const del = (o, base, extra = {}) => ({ op: "delete", class: o._class, handle: o.handle, base_version: base, ...extra });

const START = Date.parse("2026-10-14T00:00:00Z");
function world(head = { seq: 0, seeded: true, writes_enabled: true, live_heads: 0 }) {
  const ddb = createFakeDdb();
  if (head) ddb.rows.set("SYNC#HEAD\u0000META", { ...headKey(), ...head });
  let t = START;
  const clock = { now: () => t, advance: (ms) => (t += ms) };
  const lines = [];
  const ctx = { ddb, cmds, table: T, log: (l) => lines.push(l), now: () => clock.now() };
  let k = 0;
  const batch = async (ops) =>
    applyBatch({ ddb, cmds, table: T, now: () => (t += 1000), uid: () => `u${++k}`, log: { warn() {}, error() {} }, txnOpts: { sleep: async () => {} }, unsafeNoValidate: true }, { principal: "svc-test", origin: "desktop", idempotencyKey: `key-${++k}`, ops });
  const row = (pk, sk) => ddb.rows.get(`${pk}\u0000${sk}`);
  const snapshot = () => JSON.stringify(ddb.all().sort((a, b) => (`${a.PK}|${a.SK}` < `${b.PK}|${b.SK}` ? -1 : 1)));
  return { ddb, ctx, clock, lines, batch, row, snapshot };
}
const args = (argv) => parseArgs(argv);

describe("argument handling and --help", () => {
  it("--help prints the usage and the io go-ahead rule, and touches nothing", () => {
    const out = execFileSync(process.execPath, [SCRIPT, "--help"], { encoding: "utf8" });
    expect(out).toBe(`${HELP}\n`);
    for (const word of ["pause", "resume", "feed-on", "feed-off", "render", "resurrect", "--full", "--allow-mass-delete", "--prune-foreign", "--dry-run", "--apply"]) expect(out).toContain(word);
    expect(out).toMatch(/IO'S GO-AHEAD IS REQUIRED/);
    expect(out).toMatch(/recorded verbatim in the worklog/);
  });
  it("needs a command and exactly one of --dry-run / --apply, and refuses flags of another command", () => {
    expect(() => args([])).toThrow(AdminError);
    expect(() => args(["pause"])).toThrow(/exactly one/);
    expect(() => args(["pause", "--dry-run", "--apply"])).toThrow(/exactly one/);
    expect(() => args(["pause", "--apply", "--dry-run", "--apply"])).toThrow(/exactly one/);
    expect(() => args(["pause", "--apply", "--apply"])).toThrow(/exactly one/);
    expect(() => args(["pause", "--dry-run", "--dry-run"])).toThrow(/exactly one/);
    expect(args(["pause", "--all", "--apply"])).toMatchObject({ apply: true, all: true });
    expect(args(["resume", "--all", "--dry-run"])).toMatchObject({ apply: false });
    expect(() => args(["render", "--dry-run", "--full", "--all"])).toThrow(/does not apply/);
    expect(() => args(["pause", "--dry-run", "--include-withdrawn"])).toThrow(/does not apply/);
    expect(() => args(["pause", "--dry-run", "--full"])).toThrow(/does not apply/);
    expect(() => args(["render", "--dry-run", "--batch", "x"])).toThrow(/does not apply/);
    expect(() => args(["pause", "--dry-run", "--nope"])).toThrow(/unknown argument/);
    expect(() => args(["resurrect", "--dry-run", "--batch"])).toThrow(/needs a value/);
    expect(args(["render", "--apply", "--full", "--prune-foreign", "--allow-mass-delete"])).toMatchObject({ command: "render", apply: true, full: true, pruneForeign: true, allowMassDelete: true });
  });
  it("exits 1 with a one-line message from the CLI on a bad call", () => {
    let err;
    try {
      execFileSync(process.execPath, [SCRIPT, "pause"], { encoding: "utf8", stdio: "pipe" });
    } catch (e) {
      err = e;
    }
    expect(err.status).toBe(1);
    expect(err.stderr).toMatch(/sync-admin: pass exactly one of --dry-run or --apply/);
  });
});

describe("pause and resume", () => {
  it("--dry-run writes nothing; --apply flips SYNC#HEAD.writes_enabled and audits, and resume reverses it", async () => {
    const w = world();
    const before = w.snapshot();
    await run(args(["pause", "--dry-run"]), w.ctx);
    expect(w.snapshot()).toBe(before);
    expect(w.lines.join("\n")).toMatch(/dry run: nothing written/);

    await run(args(["pause", "--apply", "--by", "operator-a"]), w.ctx);
    expect(w.row("SYNC#HEAD", "META")).toMatchObject({ writes_enabled: false, seeded: true });
    const audits = w.ddb.all().filter((r) => r.PK.startsWith("AUDIT#sync-admin:pause"));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ op: "sync-admin.pause", principal: "operator-a", before: { writes_enabled: true }, after: { writes_enabled: false } });

    // applyBatch now refuses every origin
    await expect(w.batch([create(person(1))])).rejects.toMatchObject({ status: 503, code: "sync_paused" });

    // a second pause changes nothing
    const paused = w.snapshot();
    await run(args(["pause", "--apply"]), w.ctx);
    expect(w.snapshot()).toBe(paused);

    await run(args(["resume", "--dry-run"]), w.ctx);
    expect(w.snapshot()).toBe(paused);
    await run(args(["resume", "--apply"]), w.ctx);
    expect(w.row("SYNC#HEAD", "META").writes_enabled).toBe(true);
    await expect(w.batch([create(person(1))])).resolves.toMatchObject({ seq_to: 1 });
  });
  it("an absent writes_enabled counts as enabled, and a missing SYNC#HEAD is refused (it would break the seed's create)", async () => {
    const w = world({ seq: 0 });
    await run(args(["pause", "--apply"]), w.ctx);
    expect(w.row("SYNC#HEAD", "META").writes_enabled).toBe(false);
    const none = world(null);
    await expect(run(args(["pause", "--apply"]), none.ctx)).rejects.toThrow(/no SYNC#HEAD/);
    expect(none.ddb.all()).toHaveLength(0);
  });
});

describe("feed-on and feed-off (HFY-TSK-277)", () => {
  it("--dry-run writes nothing; --apply sets SYNC#HEAD.changes_feed to the boolean true and audits, and feed-off reverses it", async () => {
    const w = world();
    expect(w.row("SYNC#HEAD", "META").changes_feed).toBeUndefined(); // absent = off
    const before = w.snapshot();
    await run(args(["feed-on", "--dry-run"]), w.ctx);
    expect(w.snapshot()).toBe(before);
    await run(args(["feed-on", "--apply", "--by", "operator-a"]), w.ctx);
    expect(w.row("SYNC#HEAD", "META")).toMatchObject({ changes_feed: true, writes_enabled: true, seeded: true });
    const audits = w.ddb.all().filter((r) => r.PK.startsWith("AUDIT#sync-admin:feed-on"));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ op: "sync-admin.feed-on", principal: "operator-a", before: { changes_feed: null }, after: { changes_feed: true } });
    const on = w.snapshot();
    await run(args(["feed-on", "--apply"]), w.ctx); // already on: nothing to change
    expect(w.snapshot()).toBe(on);
    await run(args(["feed-off", "--apply"]), w.ctx);
    expect(w.row("SYNC#HEAD", "META").changes_feed).toBe(false);
    const off = w.snapshot();
    await run(args(["feed-off", "--apply"]), w.ctx);
    expect(w.snapshot()).toBe(off);
  });
  it("feed-off on a store where the switch was never set writes the explicit false; pause is untouched; a missing SYNC#HEAD is refused", async () => {
    const w = world();
    await run(args(["feed-off", "--apply"]), w.ctx);
    expect(w.row("SYNC#HEAD", "META")).toMatchObject({ changes_feed: false, writes_enabled: true });
    await expect(run(args(["feed-on", "--apply"]), world(null).ctx)).rejects.toThrow(/no SYNC#HEAD/);
  });
  it("takes --by and the common flags only", () => {
    expect(() => args(["feed-on", "--dry-run", "--all"])).toThrow(/does not apply/);
    expect(() => args(["feed-off", "--dry-run", "--full"])).toThrow(/does not apply/);
    expect(args(["feed-on", "--apply", "--by", "x", "--table", "t", "--region", "r"])).toMatchObject({ command: "feed-on", apply: true, by: "x" });
  });
});

describe("render", () => {
  it("builds the operator payload from the flags and refuses a bare render", () => {
    expect(renderPayload({ full: true })).toEqual({ force: true });
    expect(renderPayload({ allowMassDelete: true })).toEqual({ force: true, allow_mass_delete: true });
    expect(renderPayload({ full: true, pruneForeign: true, allowMassDelete: true })).toEqual({ force: true, allow_mass_delete: true, prune_foreign: true });
    expect(() => renderPayload({})).toThrow(/needs --full/);
  });
  it("--dry-run reads the render state and invokes nothing; --apply invokes once with the payload", async () => {
    const w = world();
    w.ddb.rows.set("SYNC#RENDER\u0000STATE", { PK: "SYNC#RENDER", SK: "STATE", rendered_seq: 4, mode: "live" });
    const calls = [];
    const invoke = async (c) => (calls.push(c), '{"status":"rendered"}');
    const before = w.snapshot();
    await run({ ...args(["render", "--dry-run", "--full"]), invoke }, w.ctx);
    expect(calls).toHaveLength(0);
    expect(w.snapshot()).toBe(before);
    expect(w.lines.join("\n")).toMatch(/rendered_seq 4, mode live/);
    for (const flag of ["--allow-mass-delete", "--prune-foreign"]) {
      w.lines.length = 0;
      await run({ ...args(["render", "--dry-run", flag]), invoke }, w.ctx);
      expect(calls).toHaveLength(0);
      expect(w.lines.join("\n")).toMatch(flag === "--prune-foreign" ? /"prune_foreign":true/ : /"allow_mass_delete":true/);
    }

    await run({ ...args(["render", "--apply", "--full", "--allow-mass-delete", "--prune-foreign"]), invoke }, w.ctx);
    expect(calls).toEqual([{ functionName: "hfy-sync-render", region: "us-west-2", payload: { force: true, allow_mass_delete: true, prune_foreign: true } }]);
    expect(w.snapshot()).toBe(before); // the script itself writes no table item for a render
  });
  it("cliInvoke runs the AWS CLI with the payload, reads the response file and hides the failure detail", async () => {
    const { writeFileSync } = await import("node:fs");
    let seen;
    const fake = (meta, body) => (cmd, a, o, cb) => {
      seen = [cmd, a];
      writeFileSync(a[a.length - 1], body);
      cb(null, meta);
    };
    const out = await cliInvoke({ functionName: "f", region: "r", payload: { force: true }, run: fake('{"StatusCode":200}', '{"status":"rendered"}') });
    expect(out).toBe('{"status":"rendered"}');
    expect(seen[0]).toBe("aws");
    expect(seen[1]).toEqual(expect.arrayContaining(["lambda", "invoke", "--function-name", "f", "--payload", '{"force":true}', "--cli-read-timeout", "0"]));
    expect(seen[1]).not.toContain("/dev/stdout");
    await expect(cliInvoke({ functionName: "f", region: "r", payload: {}, run: (c, a, o, cb) => cb(Object.assign(new Error("secret detail"), { code: 254 })) })).rejects.toThrow(/failed \(254\)/);
  });
  it("cliInvoke throws when the function failed although the CLI exited 0 (FunctionError or an error body)", async () => {
    const { writeFileSync } = await import("node:fs");
    const fake = (meta, body) => (cmd, a, o, cb) => (writeFileSync(a[a.length - 1], body), cb(null, meta));
    const body = '{"errorMessage":"RenderFailed: guard.mass_delete","errorType":"RenderFailed"}';
    await expect(cliInvoke({ functionName: "f", region: "r", payload: {}, run: fake('{"StatusCode":200,"FunctionError":"Unhandled"}', body) })).rejects.toThrow(/renderer failed \(RenderFailed: RenderFailed: guard.mass_delete\)|renderer failed/);
    await expect(cliInvoke({ functionName: "f", region: "r", payload: {}, run: fake("{}", body) })).rejects.toThrow(/guard\.mass_delete/);
    await expect(cliInvoke({ functionName: "f", region: "r", payload: {}, run: fake('{"StatusCode":500}', "{}") })).rejects.toThrow(/status 500/);
    // render --apply surfaces the failure instead of reporting success
    const w = world();
    await expect(run({ ...args(["render", "--apply", "--full"]), invoke: (c) => cliInvoke({ ...c, run: fake('{"FunctionError":"Unhandled"}', body) }) }, w.ctx)).rejects.toThrow(AdminError);
    expect(w.lines.join("\n")).not.toMatch(/invoked/);
  });
});

describe("resurrect", () => {
  async function tree() {
    const w = world();
    const [p1, p2, p3, n1] = [person(1), person(2), person(3), note(1)];
    await w.batch([create(p1), create(p2), create(p3), create(n1)]);
    await w.batch([update({ ...p1, gender: 0 }, 1)]); // p1 has v1 and v2 in the log
    return { w, p1, p2, p3, n1 };
  }

  it("re-creates the heads of a withdraw/delete batch from the log, claims the ids again, and bumps the seq and live_heads", async () => {
    const { w, p1, p2, n1 } = await tree();
    const r = await w.batch([withdraw(p1, 2), del(p2, 1, { reason: "cleanup" }), del(n1, 1, { reason: "cleanup" })]);
    expect(w.row(`REC#Person#${p1.handle}`, "HEAD")).toMatchObject({ deleted: true, version: 3 });
    expect(w.row("GID#Person#I0001", "META")).toMatchObject({ retired: true });
    expect(w.row("GID#Note#N0001", "META")).toBeUndefined();
    const headBefore = w.row("SYNC#HEAD", "META");
    const snap = w.snapshot();

    w.clock.advance(3600 * 1000);
    await run(args(["resurrect", "--batch", r.batch_id, "--dry-run"]), w.ctx);
    expect(w.snapshot()).toBe(snap);
    expect(w.lines.join("\n")).toMatch(/plan: 2 to re-create, 1 refused/);
    expect(w.lines.join("\n")).toMatch(/withdrawn_private_needs_flag/);
    w.lines.length = 0;
    await run(args(["resurrect", "--batch", r.batch_id, "--dry-run", "--include-withdrawn"]), w.ctx);
    expect(w.snapshot()).toBe(snap);
    expect(w.lines.join("\n")).toMatch(/WARNING: 1 of these are privacy withdraws/);
    expect(w.lines.join("\n")).toMatch(/plan: 3 to re-create, 0 refused/);

    await run(args(["resurrect", "--batch", r.batch_id, "--apply", "--include-withdrawn", "--by", "operator-a"]), w.ctx);
    const head = w.row(`REC#Person#${p1.handle}`, "HEAD");
    expect(head).toMatchObject({ deleted: false, version: 4, origin: "admin", updated_by: "operator:sync-admin", gramps_id: "I0001" });
    expect(JSON.parse(head.obj_json)).toMatchObject({ gender: 0 }); // the latest live version (v2), not v1
    expect(head.hash).toBe(w.row("SYNC#LOG", seqKey(head.seq)).hash);
    expect(w.row("SYNC#LOG", seqKey(head.seq))).toMatchObject({ op: "create", version: 4, base_version: 3, origin: "admin", principal: "operator:sync-admin", resurrected_from: { batch_id: r.batch_id, op: "withdraw" } });
    expect(w.row("GID#Person#I0001", "META")).toMatchObject({ handle: p1.handle });
    expect(w.row("GID#Person#I0001", "META").retired).toBeUndefined();
    expect(w.row("GID#Note#N0001", "META")).toMatchObject({ handle: n1.handle });
    expect(w.row(`REC#Note#${n1.handle}`, "HEAD")).toMatchObject({ deleted: false, version: 3 });
    const headAfter = w.row("SYNC#HEAD", "META");
    expect(headAfter.seq).toBe(headBefore.seq + 3);
    expect(headAfter.live_heads).toBe(headBefore.live_heads + 3);
    expect(w.ddb.all().filter((a) => a.PK.startsWith("AUDIT#sync-admin:resurrect"))).toHaveLength(1);
    // dense log
    for (let s = 1; s <= headAfter.seq; s += 1) expect(w.row("SYNC#LOG", seqKey(s))).toBeDefined();

    // idempotent: a second plan has nothing to do
    const done = w.snapshot();
    w.lines.length = 0;
    await run(args(["resurrect", "--batch", r.batch_id, "--apply", "--include-withdrawn"]), w.ctx);
    expect(w.snapshot()).toBe(done);
    expect(w.lines.join("\n")).toMatch(/plan: 0 to re-create, 3 refused/);
    expect(w.lines.join("\n")).toMatch(/already_live/);
  });

  it("refuses past the 72-hour grace, a moved head, a merge, a Media, a missing prior version and a taken id, naming the reason", async () => {
    const { w, p1, p2, p3 } = await tree();
    const r = await w.batch([withdraw(p1, 2), del(p2, 1, { reason: "cleanup" })]);
    // past grace
    w.clock.advance(GRACE_MS + 60_000);
    await run(args(["resurrect", "--batch", r.batch_id, "--apply", "--include-withdrawn"]), w.ctx);
    expect(w.lines.join("\n")).toMatch(/plan: 0 to re-create, 2 refused/);
    expect((w.lines.join("\n").match(/past_grace/g) ?? []).length).toBe(2);
    expect(w.row(`REC#Person#${p1.handle}`, "HEAD").deleted).toBe(true);

    // inside the grace: a head that moved
    const w2 = (await tree()).w;
    const q = person(7);
    await w2.batch([create(q)]);
    const r2 = await w2.batch([del(q, 1, { reason: "cleanup" })]);
    w2.ddb.rows.set(`REC#Person#${q.handle}\u0000HEAD`, { ...w2.row(`REC#Person#${q.handle}`, "HEAD"), version: 9 });
    await run(args(["resurrect", "--batch", r2.batch_id, "--dry-run"]), w2.ctx);
    expect(w2.lines.join("\n")).toMatch(/head_moved/);

    // expunged prior version, and a hash that does not match
    const w3 = (await tree()).w;
    const a = person(11);
    const b = person(12);
    await w3.batch([create(a), create(b)]);
    const r3 = await w3.batch([del(a, 1, { reason: "cleanup" }), del(b, 1, { reason: "cleanup" })]);
    const histA = [...w3.ddb.rows.values()].find((x) => x.GSI1PK === `RECHIST#Person#${a.handle}` && x.version === 1);
    w3.ddb.rows.set(`${histA.PK}\u0000${histA.SK}`, { ...histA, obj_json: null, expunged: true });
    const histB = [...w3.ddb.rows.values()].find((x) => x.GSI1PK === `RECHIST#Person#${b.handle}` && x.version === 1);
    w3.ddb.rows.set(`${histB.PK}\u0000${histB.SK}`, { ...histB, obj_json: `${histB.obj_json} ` });
    await run(args(["resurrect", "--batch", r3.batch_id, "--dry-run"]), w3.ctx);
    expect(w3.lines.join("\n")).toMatch(/no_prior_version/);
    expect(w3.lines.join("\n")).toMatch(/hash_mismatch/);

    // an id that another object now holds, a merge delete, and a Media
    const w4 = world({ seq: 0, seeded: true, writes_enabled: true, live_heads: 0, merges_enabled: true });
    const m1 = person(21);
    const m2 = person(22);
    const e = { _class: "Person", handle: h(23), gramps_id: "I0023", change: 1, private: false, gender: 1 };
    await w4.batch([create(m1), create(m2), create(e)]);
    const r4 = await w4.batch([del(m1, 1, { reason: "merge", merged_into: m2.handle }), del(e, 1, { reason: "cleanup" })]);
    w4.ddb.rows.set("GID#Person#I0023\u0000META", { ...w4.row("GID#Person#I0023", "META"), handle: h(99) });
    await run(args(["resurrect", "--batch", r4.batch_id, "--dry-run"]), w4.ctx);
    expect(w4.lines.join("\n")).toMatch(/refused\s+Person .* merge/);
    expect(w4.lines.join("\n")).toMatch(/gramps_id_taken/);
    expect(p3).toBeDefined();
  });

  it("splits a large batch into transactions of at most 20 and names no gramps_id or object text in its output", async () => {
    const w = world();
    const people = Array.from({ length: 45 }, (_, i) => person(100 + i));
    for (let i = 0; i < people.length; i += 15) await w.batch(people.slice(i, i + 15).map(create));
    const ids = [];
    for (let i = 0; i < people.length; i += 15) ids.push((await w.batch(people.slice(i, i + 15).map((p) => withdraw(p, 1)))).batch_id);
    const sent = [];
    const real = w.ddb.send.bind(w.ddb);
    w.ctx.ddb = { send: async (c) => (c.constructor.name === "TransactWriteCommand" && sent.push(c.input.TransactItems.length), real(c)) };
    for (const id of ids) await run(args(["resurrect", "--batch", id, "--apply", "--include-withdrawn"]), w.ctx);
    expect(sent.length).toBe(3);
    expect(Math.max(...sent)).toBeLessThanOrEqual(100);
    expect(w.ddb.all().filter((r) => r.entity === "rec" && r.deleted === false)).toHaveLength(45);
    const text = w.lines.join("\n");
    expect(text).not.toMatch(/I0\d{3}/);
    expect(text).not.toMatch(/Synthetic/);
  });

  it("splits a single 24-op batch into transactions of 20 and 4 objects", async () => {
    const w = world();
    const notes = Array.from({ length: 24 }, (_, i) => note(300 + i));
    await w.batch(notes.slice(0, 12).map(create));
    await w.batch(notes.slice(12).map(create));
    const r = await w.batch(notes.map((n) => del(n, 1, { reason: "cleanup" })));
    const sent = [];
    const real = w.ddb.send.bind(w.ddb);
    w.ctx.ddb = { send: async (c) => (c.constructor.name === "TransactWriteCommand" && sent.push(c.input.TransactItems.length), real(c)) };
    await run(args(["resurrect", "--batch", r.batch_id, "--apply"]), w.ctx);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toBe(1 + 3 * 20 + 1); // head update + 20 x (head, log, gid) + audit
    expect(sent[1]).toBe(1 + 3 * 4 + 1);
    expect(w.ddb.all().filter((x) => x.entity === "rec" && x.deleted === false)).toHaveLength(24);
  });

  it("refuses a Media (media_blob_not_in_log) and a gid retired by a merge when the log entry lacks the merge reason", async () => {
    const w = world({ seq: 0, seeded: true, writes_enabled: true, live_heads: 0 });
    const media = { _class: "Media", handle: h(5000), gramps_id: "O0001", change: 1, private: false, path: "synthetic.png", mime: "image/png", desc: "x" };
    const p = person(41);
    await w.batch([create(p)]);
    await w.batch([create(media)]);
    const r = await w.batch([del(media, 1, { reason: "cleanup" }), del(p, 1, { reason: "cleanup" })]);
    // only the GID item carries the merge reason
    w.ddb.rows.set("GID#Person#I0041\u0000META", { ...w.row("GID#Person#I0041", "META"), retired: true, reason: "merged" });
    await run(args(["resurrect", "--batch", r.batch_id, "--dry-run"]), w.ctx);
    const text = w.lines.join("\n");
    expect(text).toMatch(/refused\s+Person .*: merge/);
    expect(text).toMatch(/media_blob_not_in_log/);
  });

  it("resurrects a tombstone just inside the grace window and refuses one just past it", async () => {
    const w = world();
    const a = note(401);
    await w.batch([create(a)]);
    const r = await w.batch([del(a, 1, { reason: "cleanup" })]);
    const tombAt = Date.parse(w.row("SYNC#LOG", seqKey(2)).at);
    w.clock.advance(tombAt + GRACE_MS - 1000 - w.clock.now());
    await run(args(["resurrect", "--batch", r.batch_id, "--dry-run"]), w.ctx);
    expect(w.lines.join("\n")).toMatch(/plan: 1 to re-create/);
    w.lines.length = 0;
    w.clock.advance(2000);
    await run(args(["resurrect", "--batch", r.batch_id, "--dry-run"]), w.ctx);
    expect(w.lines.join("\n")).toMatch(/past_grace/);
  });

  it("stops with the loser's error when the SYNC#HEAD seq moved under it, and writes nothing", async () => {
    const { w, p1 } = await tree();
    const r = await w.batch([withdraw(p1, 2)]);
    const real = w.ddb.send.bind(w.ddb);
    w.ctx.ddb = {
      send: async (c) => {
        if (c.constructor.name === "TransactWriteCommand") w.ddb.rows.set("SYNC#HEAD\u0000META", { ...w.row("SYNC#HEAD", "META"), seq: 500 });
        return real(c);
      },
    };
    await expect(run(args(["resurrect", "--batch", r.batch_id, "--apply", "--include-withdrawn"]), w.ctx)).rejects.toThrow();
    expect(w.row(`REC#Person#${p1.handle}`, "HEAD").deleted).toBe(true);
  });

  it("refuses an unknown batch", async () => {
    const w = world();
    await expect(run(args(["resurrect", "--batch", "nosuchbatch", "--dry-run"]), w.ctx)).rejects.toThrow(/no SYNC#BATCH receipt/);
  });
});
