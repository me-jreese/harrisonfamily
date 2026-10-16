// HFY-TSK-204 (privacy-expunge): scripts/expunge.mjs against the fake table and a fake versioned S3. Synthetic objects only.
import { describe, expect, it } from "vitest";
import { createPublicKey } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { SignJWT, createLocalJWKSet, importPKCS8 } from "jose";
import { cmds, createFakeDdb, pem } from "./world.js";
import { applyBatch } from "../src/sync/apply.js";
import { createGroupResolver } from "../src/policy.js";
import { SYNC_AUDIENCE, SYNC_CLIENT_ID, createSyncAuthenticator } from "../src/sync/auth.js";
import { EXPUNGE_GRACE_MS, entryView, headKey, logKey, parseHead, recKey, sha256 } from "../src/sync/store.js";
import { storeView } from "../src/records/index.js";
import { buildSnapshot } from "../src/sync/pull.js";
import { loadProposal } from "../src/records/proposal-store.js";
import { newProposal, proposalPuts } from "../src/records/proposals.js";
import { ExpungeError, HELP, createHubClient, parseArgs, parseChatRef, parsePointer, renderedKeys, run, scrubAt, stepUpFrom } from "../scripts/expunge.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/expunge.mjs", import.meta.url));
const T = "hfy-app";
const SYNC = "sync-bucket-test";
const SITE = "site-bucket-test";
const h = (n) => n.toString(16).padStart(28, "0");
const SECRET = "synthetic-secret-phrase";
const person = (n, extra = {}) => ({ _class: "Person", handle: h(n), gramps_id: `I${String(n).padStart(4, "0")}`, change: 1, private: false, gender: 1, ...extra });
const note = (n, text = `Synthetic ${n}`) => ({ _class: "Note", handle: h(2000 + n), gramps_id: `N${String(n).padStart(4, "0")}`, change: 1, private: false, format: 0, text: { _class: "StyledText", string: text, tags: [] } });
const create = (o) => ({ op: "create", class: o._class, handle: o.handle, base_version: null, obj: o });
const update = (o, base) => ({ op: "update", class: o._class, handle: o.handle, base_version: base, obj: o });
const withdraw = (o, base) => ({ op: "withdraw", class: o._class, handle: o.handle, base_version: base, reason: "private" });
const del = (o, base) => ({ op: "delete", class: o._class, handle: o.handle, base_version: base, reason: "cleanup" });

const START = Date.parse("2026-10-14T00:00:00Z");

/** A fake S3 with bucket versioning: Put, ListObjectVersions (paged by 2 so pagination is exercised), DeleteObject (a VersionId removes that version), GetBucketVersioning. */
function fakeS3(versioned = { [SYNC]: true, [SITE]: true }) {
  const buckets = new Map(); // bucket -> Map(key -> [{ versionId, marker, body, metadata }])
  let n = 0;
  const list = (b) => (buckets.has(b) ? buckets.get(b) : buckets.set(b, new Map()).get(b));
  const api = {
    deleted: [],
    puts: [],
    seed(bucket, key, { marker = false, body = "x" } = {}) {
      const versions = list(bucket).get(key) ?? [];
      versions.push({ versionId: versioned[bucket] ? `v${++n}` : "null", marker, body: Buffer.from(body), metadata: {} });
      list(bucket).set(key, versions);
    },
    versions(bucket, key) {
      const v = list(bucket).get(key) ?? [];
      return v.map((x, i) => ({ id: x.versionId, marker: x.marker, latest: i === v.length - 1 }));
    },
    keys(bucket, prefix = "") {
      return [...list(bucket).entries()].filter(([k, v]) => k.startsWith(prefix) && v.length > 0).map(([k]) => k).sort();
    },
    body: (bucket, key) => list(bucket).get(key)?.at(-1)?.body,
    meta: (bucket, key) => list(bucket).get(key)?.at(-1)?.metadata,
    all(bucket) {
      return [...list(bucket).entries()].map(([k, v]) => [k, v.map((x) => x.versionId)]);
    },
    async send(cmd) {
      const name = cmd.constructor.name;
      const i = cmd.input;
      switch (name) {
        case "GetBucketVersioningCommand":
          return versioned[i.Bucket] ? { Status: "Enabled" } : {};
        case "PutObjectCommand": {
          api.puts.push([i.Bucket, i.Key]);
          const key = i.Key;
          const body = Buffer.isBuffer(i.Body) ? i.Body : Buffer.from(String(i.Body));
          const versions = versioned[i.Bucket] ? (list(i.Bucket).get(key) ?? []) : [];
          versions.push({ versionId: versioned[i.Bucket] ? `v${++n}` : "null", marker: false, body, metadata: i.Metadata ?? {} });
          list(i.Bucket).set(key, versions);
          return {};
        }
        case "ListObjectVersionsCommand": {
          const flat = [];
          for (const [k, v] of [...list(i.Bucket).entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
            if (!k.startsWith(i.Prefix ?? "")) continue;
            v.forEach((x, idx) => flat.push({ Key: k, VersionId: x.versionId, IsLatest: idx === v.length - 1, marker: x.marker }));
          }
          const start = i.KeyMarker === undefined ? 0 : flat.findIndex((e) => e.Key === i.KeyMarker && e.VersionId === i.VersionIdMarker) + 1;
          const page = flat.slice(start, start + 2);
          const more = start + 2 < flat.length;
          return {
            Versions: page.filter((e) => !e.marker).map(({ marker, ...e }) => e), // eslint-disable-line no-unused-vars
            DeleteMarkers: page.filter((e) => e.marker).map(({ marker, ...e }) => e), // eslint-disable-line no-unused-vars
            IsTruncated: more, ...(more ? { NextKeyMarker: page.at(-1).Key, NextVersionIdMarker: page.at(-1).VersionId } : {}),
          };
        }
        case "DeleteObjectCommand": {
          api.deleted.push([i.Bucket, i.Key, i.VersionId]);
          const versions = list(i.Bucket).get(i.Key) ?? [];
          if (i.VersionId === undefined) {
            if (versioned[i.Bucket]) versions.push({ versionId: `v${++n}`, marker: true, body: Buffer.alloc(0), metadata: {} });
            else versions.length = 0;
          } else {
            const at = versions.findIndex((x) => x.versionId === i.VersionId);
            if (at >= 0) versions.splice(at, 1);
          }
          list(i.Bucket).set(i.Key, versions);
          return {};
        }
        default:
          throw new Error(`fake s3: unsupported ${name}`);
      }
    },
  };
  return api;
}

function world({ head = { seq: 0, seeded: true, writes_enabled: true, live_heads: 0 }, versioned } = {}) {
  const ddb = createFakeDdb();
  ddb.rows.set("SYNC#HEAD\u0000META", { ...headKey(), ...head });
  const s3 = fakeS3(versioned);
  let t = START;
  const clock = { now: () => t, advance: (ms) => (t += ms) };
  const lines = [];
  let u = 0;
  const calls = [];
  const ctx = {
    ddb, cmds, table: T, s3, syncBucket: SYNC, siteBucket: SITE, log: (l) => lines.push(l), now: () => clock.now(), uid: () => `uid${String(++u).padStart(4, "0")}`,
    stepUp: async () => ({ sub: "owner-sub" }),
    hub: { nullMessage: async (m) => (calls.push(["hub", m, ddb.rows.has(`CHAT#${m.conv}\u0000M#${String(m.seq).padStart(10, "0")}`)]), { nulled: 1 }) },
  };
  let k = 0;
  const batch = async (ops) =>
    applyBatch({ ddb, cmds, table: T, now: () => (t += 1000), uid: () => `bu${++k}`, log: { warn() {}, error() {} }, txnOpts: { sleep: async () => {} }, unsafeNoValidate: true }, { principal: "svc-test", origin: "desktop", idempotencyKey: `key-${++k}`, ops });
  const row = (pk, sk) => ddb.rows.get(`${pk}\u0000${sk}`);
  const snapshot = () => JSON.stringify(ddb.all().sort((a, b) => (`${a.PK}|${a.SK}` < `${b.PK}|${b.SK}` ? -1 : 1)));
  const s3snap = () => JSON.stringify([SYNC, SITE].map((b) => s3.all(b)));
  const args = (argv) => parseArgs(argv, {});
  const go = async (argv) => run(args(argv), ctx);
  return { ddb, ctx, clock, lines, batch, row, snapshot, s3, s3snap, calls, args, go, text: () => lines.join("\n") };
}

/** A tree with a person, a note they reference, and some history; the person is then withdrawn. */
async function withdrawnTree(w) {
  const n = note(1, `has ${SECRET}`);
  const p = person(1, { note_list: [n.handle] });
  await w.batch([create(n), create(p)]); // v1, v1
  await w.batch([update({ ...n, text: { ...n.text, string: `edited ${SECRET}` } }, 1), update({ ...p, gender: 0 }, 1)]); // v2, v2
  const wd = await w.batch([withdraw(p, 2)]); // v3, tombstone
  return { n, p, wd };
}

describe("argument handling and --help", () => {
  it("prints the usage and the step-up rule, and touches nothing", () => {
    const out = execFileSync(process.execPath, [SCRIPT, "--help"], { encoding: "utf8" });
    expect(out).toBe(`${HELP}\n`);
    for (const word of ["--record", "--path", "--proposal", "--chat", "--upload", "--due", "--now", "--apply", "Dry run by default", "EXPUNGE_ACCESS_TOKEN", "AUDIT#expunge"]) expect(out).toContain(word);
  });
  it("is a dry run unless --apply is passed, and takes exactly one mode", () => {
    const rec = `Note:${h(2001)}`;
    expect(parseArgs(["--record", rec], {})).toMatchObject({ mode: "record", apply: false, cls: "Note", handle: h(2001) });
    expect(parseArgs(["--record", rec, "--dry-run"], {}).apply).toBe(false);
    expect(parseArgs(["--record", rec, "--apply"], {}).apply).toBe(true);
    expect(() => parseArgs(["--record", rec, "--apply", "--dry-run"], {})).toThrow(/not both/);
    expect(() => parseArgs([], {})).toThrow(/exactly one of/);
    expect(() => parseArgs(["--record", rec, "--due"], {})).toThrow(/exactly one of/);
    expect(() => parseArgs(["--record", "Bogus:abc"], {})).toThrow(ExpungeError);
    expect(() => parseArgs(["--record", `Note:${h(2001)}`, "--bogus"], {})).toThrow(/unknown argument/);
    expect(() => parseArgs(["--record"], {})).toThrow(/needs a value/);
    expect(() => parseArgs(["--proposal", "not-a-ulid"], {})).toThrow(/ULID/);
    expect(() => parseArgs(["--proposal", "01J00000000000000000000000"], {})).not.toThrow();
    expect(() => parseArgs(["--upload", "media/abc.jpg"], {})).toThrow(/--upload needs a key/);
    expect(() => parseArgs(["--upload", "uploads/posts/01J00000000000000000000000/photo.jpg"], {})).not.toThrow();
    expect(() => parseArgs(["--proposal", "01J00000000000000000000000", "--path", "/x"], {})).toThrow(/only applies to --record/);
    expect(() => parseArgs(["--record", rec, "--replacement", "x"], {})).toThrow(/needs|only applies with --path/);
    expect(() => parseArgs(["--record", rec, "--now"], {})).toThrow(/only applies to --due/);
    expect(parseArgs(["--due", "--now"], {})).toMatchObject({ mode: "due", now: true });
    expect(parseArgs(["--chat", "g:abc123:42"], {})).toMatchObject({ mode: "chat" });
    expect(parseArgs(["--table", "t", "--region", "r", "--sync-bucket", "s", "--site-bucket", "f", "--due"], {})).toMatchObject({ table: "t", region: "r", syncBucket: "s", siteBucket: "f" });
  });
  it("exits 1 with a one-line message from the CLI on a bad call, and on --apply without a token", () => {
    let err;
    try {
      execFileSync(process.execPath, [SCRIPT], { encoding: "utf8", stdio: "pipe" });
    } catch (e) {
      err = e;
    }
    expect(err.status).toBe(1);
    expect(err.stderr).toMatch(/expunge: pass exactly one of --record/);
  });
  it("refuses --apply when no step-up is configured, before reading or writing anything", async () => {
    const w = world();
    const before = w.snapshot();
    await expect(run(w.args(["--due", "--apply"]), { ...w.ctx, stepUp: undefined })).rejects.toThrow(/needs io's step-up/);
    expect(w.snapshot()).toBe(before);
  });
});

describe("JSON pointers", () => {
  it("parses RFC 6901 pointers and refuses the root, empty segments and identity members", () => {
    expect(parsePointer("/text/string")).toEqual(["text", "string"]);
    expect(parsePointer("/a~1b/c~0d")).toEqual(["a/b", "c~d"]);
    for (const bad of ["", "/", "text", "/a//b", "/handle", "/_class", "/gramps_id"]) expect(() => parsePointer(bad)).toThrow(ExpungeError);
    expect(parsePointer("/handle_x")).toEqual(["handle_x"]);
  });
  it("blanks a string, removes another member, refuses a non-string array element, and reports an absent path", () => {
    const o = { a: { s: "secret", n: 3, l: ["x", 2] }, "__proto__x": 1 };
    expect(scrubAt(o, ["a", "s"])).toBe(true);
    expect(o.a.s).toBe("");
    expect(scrubAt(o, ["a", "s"])).toBe(false); // already blank
    expect(scrubAt(o, ["a", "n"])).toBe(true);
    expect(Object.hasOwn(o.a, "n")).toBe(false);
    expect(scrubAt(o, ["a", "l", "0"], "[removed]")).toBe(true);
    expect(o.a.l).toEqual(["[removed]", 2]);
    expect(() => scrubAt(o, ["a", "l", "1"])).toThrow(/not a string/);
    expect(scrubAt(o, ["a", "missing"])).toBe(false);
    expect(scrubAt(o, ["x", "y"])).toBe(false);
    expect(scrubAt(o, ["a", "l", "9"])).toBe(false);
    const p = JSON.parse('{"__proto__": "boom"}');
    expect(scrubAt(p, ["__proto__"], "")).toBe(true);
    expect(Object.getPrototypeOf(p)).toBe(Object.prototype);
  });
});

describe("a withdraw schedules its expunge", () => {
  it("writes an EXPUNGE# item due 72 hours later in the withdraw's own transaction, and a delete writes none", async () => {
    const w = world();
    const { p, n } = await withdrawnTree(w);
    const item = w.row(`EXPUNGE#Person#${p.handle}`, "META");
    const head = w.row(`REC#Person#${p.handle}`, "HEAD");
    expect(item).toMatchObject({ entity: "expunge_due", class: "Person", handle: p.handle, version: 3, GSI1PK: "EXPUNGEQ#pending", scheduled_at: head.updated_at });
    expect(Date.parse(item.due_at) - Date.parse(item.scheduled_at)).toBe(EXPUNGE_GRACE_MS);
    expect(item.GSI1SK).toBe(`${item.due_at}#Person#${p.handle}`);
    expect(JSON.stringify(item)).not.toContain(SECRET);
    await w.batch([del(n, 2)]);
    expect(w.row(`EXPUNGE#Note#${n.handle}`, "META")).toBeUndefined();
  });
  it("still commits a batch of 24 withdraws in one transaction (4 items each), and refuses a 25th op", async () => {
    const w = world();
    const people = Array.from({ length: 24 }, (_, i) => person(100 + i));
    await w.batch(people.slice(0, 12).map(create));
    await w.batch(people.slice(12).map(create));
    const sent = [];
    const real = w.ddb.send.bind(w.ddb);
    const wrapped = { send: async (c) => (c.constructor.name === "TransactWriteCommand" && sent.push(c.input.TransactItems.length), real(c)) };
    await applyBatch({ ddb: wrapped, cmds, table: T, now: () => START + 99_000_000, uid: () => "u", log: { warn() {}, error() {} }, txnOpts: { sleep: async () => {} }, unsafeNoValidate: true },
      { principal: "svc-test", origin: "desktop", idempotencyKey: "mass", ops: people.map((o) => withdraw(o, 1)) });
    expect(sent).toEqual([100]);
    expect(w.ddb.all().filter((r) => r.entity === "expunge_due")).toHaveLength(24);
  });
});

describe("record mode (whole record)", () => {
  it("dry run prints counts and writes nothing anywhere", async () => {
    const w = world();
    const { p } = await withdrawnTree(w);
    w.s3.seed(SYNC, "snapshots/5.jsonl.gz");
    w.s3.seed(SYNC, "snapshots/5.jsonl.gz");
    w.s3.seed(SYNC, `render-shadow/person/${p.gramps_id}.json`);
    w.s3.seed(SITE, `person/${p.gramps_id}.json`);
    w.s3.seed(SITE, `person/${p.gramps_id}.json`, { marker: true });
    const ddbBefore = w.snapshot();
    const s3Before = w.s3snap();
    await w.go(["--record", `Person:${p.handle}`]);
    expect(w.snapshot()).toBe(ddbBefore);
    expect(w.s3snap()).toBe(s3Before);
    expect(w.s3.deleted).toEqual([]);
    expect(w.text()).toMatch(/dry run: nothing is written/);
    expect(w.text()).toMatch(/3 log entries, 1 head, 0 conflicts, 2 snapshot versions, 1 shadow version, 1 noncurrent site version over/);
    expect(w.text()).not.toContain(p.gramps_id);
    expect(w.text()).not.toContain(p.handle);
  });

  it("refuses a live head, and an unknown record", async () => {
    const w = world();
    const n = note(1);
    await w.batch([create(n)]);
    await expect(w.go(["--record", `Note:${n.handle}`, "--apply"])).rejects.toThrow(/live: withdraw or delete it first/);
    await expect(w.go(["--record", `Note:${h(9)}`])).rejects.toThrow(/no such record/);
    await expect(w.go(["--record", `Bogus:${h(9)}`])).rejects.toThrow(ExpungeError);
  });

  it("--apply: nulls every log entry and the head, keeps hash and seq, bumps the epoch, cancels the schedule, audits counts only", async () => {
    const w = world();
    const { p, n } = await withdrawnTree(w);
    const histBefore = [1, 2, 3, 4, 5].map((s) => w.row("SYNC#LOG", String(s).padStart(12, "0")));
    const headBefore = w.row("SYNC#HEAD", "META");
    const personEntries = histBefore.filter((e) => e.handle === p.handle);
    expect(personEntries).toHaveLength(3);
    w.s3.seed(SYNC, `render-shadow/person/${p.gramps_id}.json`);
    w.s3.seed(SYNC, `render-shadow/person/${p.gramps_id}.json`);
    w.s3.seed(SYNC, "render-shadow/person/index.json");
    w.s3.seed(SYNC, "render-shadow/unrelated/file.json");
    w.s3.seed(SITE, `person/${p.gramps_id}.json`);
    w.s3.seed(SITE, `person/${p.gramps_id}.json`);
    w.s3.seed(SITE, `person/${p.gramps_id}.json`, { marker: true });
    w.s3.seed(SITE, "person/index.json");
    w.s3.seed(SITE, "person/index.json");
    w.s3.seed(SYNC, "snapshots/6.jsonl.gz");
    w.s3.seed(SYNC, "snapshots/6.jsonl.gz");
    w.s3.seed(SYNC, "snapshots/4.jsonl.gz");
    w.s3.seed(SYNC, "snapshots/latest.json");

    await w.go(["--record", `Person:${p.handle}`, "--apply"]);

    for (const e of personEntries) {
      const now = w.row("SYNC#LOG", String(e.seq).padStart(12, "0"));
      expect(now).toMatchObject({ obj_json: null, expunged: true, seq: e.seq, hash: e.hash, version: e.version, handle: p.handle });
    }
    // the other object's history is untouched
    const noteEntry = histBefore.find((e) => e.handle === n.handle && e.version === 2);
    expect(w.row("SYNC#LOG", String(noteEntry.seq).padStart(12, "0")).obj_json).toBe(noteEntry.obj_json);
    expect(w.row(`REC#Person#${p.handle}`, "HEAD")).toMatchObject({ obj_json: null, expunged: true, deleted: true, version: 3 });
    const head = w.row("SYNC#HEAD", "META");
    expect(head.expunge_epoch).toBe(1);
    expect(head.seq).toBe(headBefore.seq); // an expunge moves no seq
    expect(w.row(`EXPUNGE#Person#${p.handle}`, "META")).toBeUndefined();
    expect(JSON.stringify(w.ddb.all())).not.toContain("gender"); // no copy of the person's object is left in the table
    // readers
    expect(entryView(w.row("SYNC#LOG", String(personEntries[0].seq).padStart(12, "0")))).toMatchObject({ obj: null, expunged: true, hash: personEntries[0].hash, seq: personEntries[0].seq });
    expect(parseHead(w.row(`REC#Person#${p.handle}`, "HEAD"))).toMatchObject({ obj: null, deleted: true, expunged: true });

    // audit: the mode and counts, nothing else
    const audits = w.ddb.all().filter((r) => r.PK.startsWith("AUDIT#expunge:"));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ op: "expunge", principal: "owner-sub", before: null, after: { mode: "record", counts: { log_entries: 3, head: 1, conflicts: 0, schedule_items: 1 } } });
    expect(JSON.stringify(audits[0])).not.toContain(p.handle);
    expect(JSON.stringify(audits[0])).not.toContain(p.gramps_id);

    // the shadow copies of the record's file and the index are gone, with every version; an unrelated file is not touched
    expect(w.s3.keys(SYNC, "render-shadow/")).toEqual(["render-shadow/unrelated/file.json"]);
    // the site bucket: noncurrent versions gone, the current delete marker (the withdraw's) stays
    expect(w.s3.versions(SITE, `person/${p.gramps_id}.json`)).toHaveLength(1);
    expect(w.s3.versions(SITE, `person/${p.gramps_id}.json`)[0]).toMatchObject({ marker: true, latest: true });
    expect(w.s3.versions(SITE, "person/index.json")).toHaveLength(1);
    // snapshots: every old version is gone, a rebuilt snapshot and its checkpoint remain, one version each
    const snaps = w.s3.keys(SYNC, "snapshots/");
    expect(snaps).toEqual([`snapshots/${head.seq}.jsonl.gz`, "snapshots/latest.json"]);
    for (const k of snaps) expect(w.s3.versions(SYNC, k)).toHaveLength(1);
    expect(w.s3.meta(SYNC, `snapshots/${head.seq}.jsonl.gz`)).toMatchObject({ expunge_epoch: "1" });
    const lines = gunzipSync(w.s3.body(SYNC, `snapshots/${head.seq}.jsonl.gz`)).toString().trim().split("\n").map((l) => JSON.parse(l));
    const line = lines.find((l) => l.handle === p.handle);
    expect(line).toMatchObject({ class: "Person", deleted: true, expunged: true, obj: null, version: 3 });
    expect(lines.find((l) => l.handle === n.handle).expunged).toBeUndefined();
    expect(Buffer.from(JSON.stringify(lines)).includes(Buffer.from("gender"))).toBe(false);
    // output: counts and classes, never identifiers or text
    expect(w.text()).not.toContain(p.handle);
    expect(w.text()).not.toContain(p.gramps_id);
    expect(w.text()).not.toContain(SECRET);
    expect(w.text()).toMatch(/applied.*sync-admin render --full/);
  });

  it("is idempotent: a second --apply finds nothing left to rewrite", async () => {
    const w = world();
    const { p } = await withdrawnTree(w);
    await w.go(["--record", `Person:${p.handle}`, "--apply"]);
    w.lines.length = 0;
    await w.go(["--record", `Person:${p.handle}`, "--apply"]);
    expect(w.text()).toMatch(/0 log entries, 0 heads/);
    expect(w.text()).toMatch(/nothing left to rewrite/);
    expect(w.row("SYNC#HEAD", "META").expunge_epoch).toBe(1); // nothing was rewritten, so the epoch does not rise again
    expect(w.ddb.all().filter((r) => r.PK.startsWith("AUDIT#expunge:"))).toHaveLength(1);
    expect(w.row("EXPUNGE#SWEEP", "META")).toBeUndefined();
  });

  it("refuses without a fresh step-up, and writes nothing", async () => {
    const w = world();
    const { p } = await withdrawnTree(w);
    const before = w.snapshot();
    const ctx = { ...w.ctx, stepUp: async () => { throw new ExpungeError("step-up refused: step_up_required"); } };
    await expect(run(w.args(["--record", `Person:${p.handle}`, "--apply"]), ctx)).rejects.toThrow(/step-up refused/);
    expect(w.snapshot()).toBe(before);
    expect(w.s3.deleted).toEqual([]);
  });

  it("redacts the sync conflicts of the handle (values only) and leaves other handles' alone", async () => {
    const w = world();
    const { p, n } = await withdrawnTree(w);
    const c = (id, handle, state) => ({ PK: `SYNC#CONFLICT#${id}`, SK: "META", GSI1PK: `SYNCCONFLICT#${state}`, GSI1SK: `2026#${id}`, entity: "syncconflict", class: handle === p.handle ? "Person" : "Note", handle, state, paths: [{ path: "/gender", cloud: SECRET, local: "other" }] });
    w.ddb.rows.set("SYNC#CONFLICT#A\u0000META", c("A", p.handle, "open"));
    w.ddb.rows.set("SYNC#CONFLICT#B\u0000META", c("B", p.handle, "resolved"));
    w.ddb.rows.set("SYNC#CONFLICT#C\u0000META", c("C", n.handle, "open"));
    await w.go(["--record", `Person:${p.handle}`, "--apply"]);
    expect(w.row("SYNC#CONFLICT#A", "META").paths).toEqual([{ path: "/gender" }]);
    expect(w.row("SYNC#CONFLICT#B", "META").paths).toEqual([{ path: "/gender" }]);
    expect(w.row("SYNC#CONFLICT#C", "META").paths[0].cloud).toBe(SECRET);
  });
});

describe("record mode (--path)", () => {
  async function liveNote(w) {
    const n = note(1, `first ${SECRET}`);
    await w.batch([create(n)]);
    await w.batch([update({ ...n, text: { ...n.text, string: `second ${SECRET}` } }, 1)]);
    await w.batch([update({ ...n, text: { ...n.text, string: `third ${SECRET}` }, private: false }, 2)]);
    return n;
  }

  it("rewrites the value in every log entry and the head, recomputes the hashes, keeps version and seq, and bumps the epoch", async () => {
    const w = world();
    const n = await liveNote(w);
    const before = [1, 2, 3].map((s) => w.row("SYNC#LOG", String(s).padStart(12, "0")));
    const headBefore = w.row(`REC#Note#${n.handle}`, "HEAD");
    const seqBefore = w.row("SYNC#HEAD", "META").seq;
    // the store view is warm and holds the secret
    const view = await storeView({ ddb: w.ddb, cmds, table: T, now: w.ctx.now });
    expect(JSON.stringify(view.heads.get(`Note:${n.handle}`).obj)).toContain(SECRET);

    await w.go(["--record", `Note:${n.handle}`, "--path", "/text/string", "--replacement", "[removed]", "--apply"]);

    const after = [1, 2, 3].map((s) => w.row("SYNC#LOG", String(s).padStart(12, "0")));
    after.forEach((e, i) => {
      expect(JSON.parse(e.obj_json).text.string).toBe("[removed]");
      expect(e.hash).toBe(sha256(e.obj_json));
      expect(e.hash).not.toBe(before[i].hash);
      expect(e).toMatchObject({ seq: before[i].seq, version: before[i].version, op: before[i].op });
      expect(e.expunged).toBeUndefined();
      expect(JSON.parse(e.obj_json)).toMatchObject({ handle: n.handle, gramps_id: n.gramps_id, format: 0 }); // the rest of the object is intact
    });
    const headAfter = w.row(`REC#Note#${n.handle}`, "HEAD");
    expect(headAfter).toMatchObject({ version: headBefore.version, seq: headBefore.seq, deleted: false });
    expect(headAfter.hash).toBe(after[2].hash);
    expect(headAfter.obj_json).toBe(after[2].obj_json);
    expect(w.row("SYNC#HEAD", "META")).toMatchObject({ expunge_epoch: 1, seq: seqBefore });
    expect(JSON.stringify(w.ddb.all())).not.toContain(SECRET);
    // the warm store view is dropped on the epoch change and no longer holds the value
    const fresh = await storeView({ ddb: w.ddb, cmds, table: T, now: w.ctx.now });
    expect(fresh.heads.get(`Note:${n.handle}`).obj.text.string).toBe("[removed]");
    expect(JSON.stringify([...fresh.heads.values()])).not.toContain(SECRET);
    // the snapshot was rebuilt at an unchanged version with a changed object (the expunge notice the add-on reads)
    const snap = w.s3.keys(SYNC, "snapshots/").find((k) => k.endsWith(".jsonl.gz"));
    const body = gunzipSync(w.s3.body(SYNC, snap)).toString();
    expect(body).not.toContain(SECRET);
    const line = body.trim().split("\n").map((l) => JSON.parse(l)).find((l) => l.handle === n.handle);
    expect(line).toMatchObject({ version: headBefore.version, seq: headBefore.seq, deleted: false });
    expect(line.obj.text.string).toBe("[removed]");
    expect(w.ddb.all().find((r) => r.PK.startsWith("AUDIT#expunge:")).after.mode).toBe("record-path");
  });

  it("blanks to the empty string by default, refuses a missing path and identity members, and a dry run writes nothing", async () => {
    const w = world();
    const n = await liveNote(w);
    const before = w.snapshot();
    await w.go(["--record", `Note:${n.handle}`, "--path", "/text/string"]);
    expect(w.snapshot()).toBe(before);
    expect(w.text()).toMatch(/3 log entries, 1 head/);
    await expect(w.go(["--record", `Note:${n.handle}`, "--path", "/no/such/member", "--apply"])).rejects.toThrow(/path was not found/);
    expect(() => w.args(["--record", `Note:${n.handle}`, "--path", "/handle"])).toThrow(/identity/);
    await w.go(["--record", `Note:${n.handle}`, "--path", "/text/string", "--apply"]);
    expect(JSON.parse(w.row(`REC#Note#${n.handle}`, "HEAD").obj_json).text.string).toBe("");
    // a second run finds the path already blank
    await expect(w.go(["--record", `Note:${n.handle}`, "--path", "/text/string", "--apply"])).rejects.toThrow(/path was not found/);
  });

  it("splits a long history into transactions that stay under the store's size limit", async () => {
    const w = world();
    const big = (v) => note(1, `${v} ${"x".repeat(150_000)} ${SECRET}`);
    await w.batch([create(big(0))]);
    for (let v = 1; v < 40; v += 1) await w.batch([update(big(v), v)]);
    const sent = [];
    const real = w.ddb.send.bind(w.ddb);
    const ctx = { ...w.ctx, ddb: { send: async (c) => (c.constructor.name === "TransactWriteCommand" && sent.push(Buffer.byteLength(JSON.stringify(c.input.TransactItems))), real(c)) } };
    await run(w.args(["--record", `Note:${h(2001)}`, "--path", "/format", "--apply"]), ctx);
    expect(sent.length).toBeGreaterThanOrEqual(4);
    expect(Math.max(...sent)).toBeLessThan(3_000_000);
    expect(JSON.parse(w.row(`REC#Note#${h(2001)}`, "HEAD").obj_json)).not.toHaveProperty("format");
  });

  it("reads the record again once when the head moved under it, then stops with a content-free message", async () => {
    const w = world();
    const n = await liveNote(w);
    // a writer changes the head's object before every write: the pinned update fails, the retry reads again and fails the same way
    const real = w.ddb.send.bind(w.ddb);
    let tamper = true;
    const ctx = {
      ...w.ctx,
      ddb: { send: async (c) => {
        if (tamper && c.constructor.name === "TransactWriteCommand") { const k = recKey("Note", n.handle); const r = w.ddb.rows.get(`${k.PK}\u0000${k.SK}`); r.hash = `${Math.random().toString(16).slice(2).padEnd(64, "f")}`; }
        return real(c);
      } },
    };
    await expect(run(w.args(["--record", `Note:${n.handle}`, "--path", "/text/string", "--apply"]), ctx)).rejects.toThrow(/changed while it was being expunged/);
    expect(w.row("SYNC#HEAD", "META").expunge_epoch).toBeUndefined();
    tamper = false;
    // the retry itself works: one cancelled transaction is read again and the run completes
    w.ddb.failNext("ConditionalCheckFailed", 1);
    await run(w.args(["--record", `Note:${n.handle}`, "--path", "/text/string", "--apply"]), ctx);
    expect(JSON.parse(w.row(`REC#Note#${n.handle}`, "HEAD").obj_json).text.string).toBe("");
    expect(w.text()).toMatch(/changed while being expunged; reading it again/);
  });

  it("a rerun of the same --path after a crash in the snapshot sweep finishes the sweep instead of refusing", async () => {
    const w = world();
    const n = await liveNote(w);
    w.s3.seed(SYNC, "snapshots/old.jsonl.gz", { body: SECRET });
    w.s3.seed(SYNC, "snapshots/old.jsonl.gz", { body: SECRET });
    const real = w.s3;
    let failDelete = true;
    const ctx = { ...w.ctx, s3: { send: async (c) => { if (failDelete && c.constructor.name === "DeleteObjectCommand" && c.input.Key.startsWith("snapshots/")) throw Object.assign(new Error("boom"), { name: "InternalError" }); return real.send(c); } } };
    await expect(run(w.args(["--record", `Note:${n.handle}`, "--path", "/text/string", "--apply"]), ctx)).rejects.toThrow(/boom/);
    expect(JSON.parse(w.row(`REC#Note#${n.handle}`, "HEAD").obj_json).text.string).toBe(""); // the table is done
    expect(w.row("EXPUNGE#SWEEP", "META")).toBeDefined(); // and the sweep is still owed
    expect(w.s3.versions(SYNC, "snapshots/old.jsonl.gz")).toHaveLength(2);
    failDelete = false;
    await run(w.args(["--record", `Note:${n.handle}`, "--path", "/text/string", "--apply"]), ctx);
    expect(w.s3.versions(SYNC, "snapshots/old.jsonl.gz")).toHaveLength(0);
    expect(w.row("EXPUNGE#SWEEP", "META")).toBeUndefined();
    expect(w.text()).toMatch(/nothing left to rewrite/);
    expect(w.ddb.all().filter((r) => r.PK.startsWith("AUDIT#expunge:"))).toHaveLength(1);
    // with no sweep owed a typo is refused again
    await expect(w.go(["--record", `Note:${n.handle}`, "--path", "/no/such", "--apply"])).rejects.toThrow(/path was not found/);
  });
});

describe("which rendered files carry a record", () => {
  it("lists the record's file, its class index, and the files of everything that references it up to a Person", async () => {
    const w = world();
    const n = note(1);
    const place = { _class: "Place", handle: h(3000), gramps_id: "P0001", change: 1, private: false, name: { value: "x" } };
    const ev = { _class: "Event", handle: h(4000), gramps_id: "E0001", change: 1, private: false, place: place.handle, note_list: [n.handle] };
    const p = person(1, { event_ref_list: [{ ref: ev.handle }] });
    const other = person(2);
    await w.batch([create(n), create(place), create(ev), create(p), create(other)]);
    const view = await storeView({ ddb: w.ddb, cmds, table: T, now: w.ctx.now });
    expect(renderedKeys(view, { class: "Note", handle: n.handle, gramps_id: n.gramps_id })).toEqual([`event/${ev.handle}.json`, `note/${n.handle}.json`, "person/I0001.json", "person/index.json", "person/search-index.json"]);
    expect(renderedKeys(view, { class: "Person", handle: other.handle, gramps_id: "I0002" })).toEqual(["person/I0002.json", "person/index.json", "person/search-index.json"]);
    expect(renderedKeys(view, { class: "Place", handle: place.handle, gramps_id: "P0001" })).toContain("place/index.json");
  });
});

describe("a shared versioned bucket that is not versioned", () => {
  it("skips the site bucket's noncurrent versions when it is not versioned and deletes the shadow without version ids", async () => {
    const w = world({ versioned: { [SYNC]: true, [SITE]: false } });
    const { p } = await withdrawnTree(w);
    w.s3.seed(SITE, `person/${p.gramps_id}.json`);
    await w.go(["--record", `Person:${p.handle}`, "--apply"]);
    expect(w.text()).toMatch(/the site bucket is not versioned/);
    expect(w.s3.keys(SITE)).toEqual([`person/${p.gramps_id}.json`]); // the current copy is the renderer's: render --full rewrites it
  });
});

describe("proposal mode", () => {
  const PID = "01J00000000000000000000ABC";
  const COMMENT = "01J00000000000000000000WXY";
  const UPID = "01J00000000000000000000EFG";
  const PHOTO = `uploads/comments/${UPID}/photo.jpg`;

  async function seed(w) {
    const target = note(1, `proposed ${SECRET}`);
    const prop = newProposal({
      id: PID, actor: { id: "I0001", label: "Pat" }, origin: "self", kind: "edit", subject: null, targets: [`Note:${target.handle}`], base_versions: {},
      ops: [{ op: "update", class: "Note", handle: target.handle, obj: target }], summary: `summary ${SECRET}`, note: `why ${SECRET}`, warnings: [], at: "2026-10-14T00:00:00.000Z", owners: [],
    });
    for (const { item } of proposalPuts(prop)) w.ddb.rows.set(`${item.PK}\u0000${item.SK}`, item);
    const put = (item) => w.ddb.rows.set(`${item.PK}\u0000${item.SK}`, item);
    put({ PK: `THREAD#proposal:${PID}`, SK: `C#${COMMENT}`, GSI1PK: "COMMENTS", GSI1SK: COMMENT, entity: "comment", comment: { id: COMMENT, threadId: `proposal:${PID}`, body: `comment ${SECRET}`, attachments: [{ id: UPID, kind: "image", url: `/${PHOTO}`, mime: "image/jpeg" }] } });
    put({ PK: `THREAD#proposal:${PID}`, SK: `R#${COMMENT}#I0002`, entity: "reaction", target: COMMENT, reaction: { emoji: "x" } });
    put({ PK: `AUDIT#${COMMENT}`, SK: "2026-10-14T00:00:01.000Z#a", GSI1PK: "AUDIT", GSI1SK: "2026-10-14T00:00:01.000Z#a", entity: "audit", op: "create", id: COMMENT, principal: "I0001", at: "2026-10-14T00:00:01.000Z", before: null, after: { body: `comment ${SECRET}` } });
    put({ PK: `AUDIT#proposal:${PID}`, SK: "2026-10-14T00:00:00.000Z#b", entity: "audit", op: "proposal.create", id: `proposal:${PID}`, principal: "I0001", at: "2026-10-14T00:00:00.000Z", before: null, after: { state: "pending", rev: 1, targets: 1, note: `echo ${SECRET}` } });
    put({ PK: `AUDIT#proposal:${PID}`, SK: "2026-10-14T00:00:09.000Z#c", entity: "audit", op: "proposal.decide", id: `proposal:${PID}`, principal: "I0099", at: "2026-10-14T00:00:09.000Z", before: { state: "pending", rev: 1 }, after: { state: "declined", rev: 2, summary: `echo ${SECRET}` }, reason: `because ${SECRET}` });
    put({ PK: `AUDIT#proposal:${UPID}`, SK: "2026-10-14T00:00:00.000Z#z", entity: "audit", op: "proposal.create", id: `proposal:${UPID}`, principal: "I0002", at: "2026-10-14T00:00:00.000Z", before: null, after: { state: "pending", rev: 1 } }); // another proposal's trail
    // The receipts: a create (body.id), a decide (body.proposal echoes the proposal), and another proposal's receipt that must stay.
    put({ PK: "IDEM#I0001#aa", SK: "META", entity: "idem", requestHash: "h1", result: { status: 201, body: { id: PID } }, at: "2026-10-14T00:00:00.000Z", ttl: 1 });
    put({ PK: "IDEM#I0099#bb", SK: "META", entity: "idem", requestHash: "h2", result: { status: 200, body: { proposal: { id: PID, summary: `receipt ${SECRET}` } } }, at: "2026-10-14T00:00:09.000Z", ttl: 1 });
    put({ PK: "IDEM#I0002#cc", SK: "META", entity: "idem", requestHash: "h3", result: { status: 201, body: { id: UPID } }, at: "2026-10-14T00:00:00.000Z", ttl: 1 });
    put({ PK: "PROPREQ#req-1", SK: "META", entity: "proposal_request", id: PID, requestHash: "hash-of-content" });
    put({ PK: "PROPREQ#req-2", SK: "META", entity: "proposal_request", id: UPID, requestHash: "other" });
    put({ PK: `UPLOAD#${UPID}`, SK: "META", entity: "upload", owner: "I0001", purpose: "comment", key: PHOTO, attached: COMMENT });
    w.s3.seed(SITE, PHOTO);
    w.s3.seed(SITE, PHOTO);
    w.s3.seed(SITE, "uploads/comments/01J00000000000000000000000/photo.jpg"); // another member's photo
    return prop;
  }

  it("dry run counts and writes nothing", async () => {
    const w = world();
    await seed(w);
    const before = w.snapshot();
    const s3Before = w.s3snap();
    await w.go(["--proposal", PID]);
    expect(w.snapshot()).toBe(before);
    expect(w.s3snap()).toBe(s3Before);
    expect(w.text()).toMatch(/3 items to redact, 2 thread items \(1 comment\) to delete, 1 comment audit row and 2 proposal audit rows to redact, 2 idempotency receipts to delete, 1 request item to redact, 1 photo \(2 versions\) to delete/);
  });

  it("--apply redacts META and every IDX copy, deletes the thread and the photo, redacts the comment audits, and audits counts only", async () => {
    const w = world();
    await seed(w);
    expect(await loadProposal({ ddb: w.ddb, cmds, table: T }, PID)).not.toBeNull();
    await w.go(["--proposal", PID, "--apply"]);
    const rows = w.ddb.all().filter((r) => r.PK === `PROP#${PID}`);
    expect(rows.map((r) => r.SK).sort()).toEqual(["IDX#BY", `IDX#REC#Note:${h(2001)}`, "META"].sort());
    for (const r of rows) {
      expect(r).toMatchObject({ entity: "proposal_expunged", expunged: true });
      expect(r.proposal).toBeUndefined();
      expect(r.GSI1PK).toBeUndefined();
      expect(r.GSI1SK).toBeUndefined();
    }
    expect(await loadProposal({ ddb: w.ddb, cmds, table: T }, PID)).toBeNull();
    expect(w.ddb.all().filter((r) => r.PK.startsWith("THREAD#proposal:"))).toEqual([]);
    expect(w.row(`AUDIT#${COMMENT}`, "2026-10-14T00:00:01.000Z#a")).toMatchObject({ before: null, after: null, redacted: true, op: "create", principal: "I0001" });
    // the proposal's own audit rows keep who, what and when and lose before, after and the decision reason
    expect(w.row(`AUDIT#proposal:${PID}`, "2026-10-14T00:00:00.000Z#b")).toMatchObject({ before: null, after: null, redacted: true, op: "proposal.create", principal: "I0001" });
    const decide = w.row(`AUDIT#proposal:${PID}`, "2026-10-14T00:00:09.000Z#c");
    expect(decide).toMatchObject({ before: null, after: null, redacted: true, op: "proposal.decide", principal: "I0099" });
    expect(decide).not.toHaveProperty("reason");
    expect(w.row(`AUDIT#proposal:${UPID}`, "2026-10-14T00:00:00.000Z#z")).toMatchObject({ after: { state: "pending", rev: 1 } }); // another proposal's trail is untouched
    expect(w.row("IDEM#I0001#aa", "META")).toBeUndefined();
    expect(w.row("IDEM#I0099#bb", "META")).toBeUndefined();
    expect(w.row("IDEM#I0002#cc", "META")).toBeDefined();
    expect(w.row("PROPREQ#req-1", "META")).toMatchObject({ entity: "proposal_request", id: PID, expunged: true });
    expect(w.row("PROPREQ#req-1", "META")).not.toHaveProperty("requestHash");
    expect(w.row("PROPREQ#req-2", "META")).toMatchObject({ requestHash: "other" });
    expect(w.row(`UPLOAD#${UPID}`, "META")).toBeUndefined();
    expect(w.s3.keys(SITE)).toEqual(["uploads/comments/01J00000000000000000000000/photo.jpg"]);
    expect(JSON.stringify(w.ddb.all())).not.toContain(SECRET);
    const audit = w.ddb.all().find((r) => r.PK.startsWith("AUDIT#expunge:"));
    expect(audit.after).toEqual({ mode: "proposal", counts: { proposal_items: 3, thread_items: 2, comment_audits: 1, proposal_audits: 2, receipts: 2, request_items: 1, photos: 1, photo_versions: 2 } });
    expect(JSON.stringify(audit)).not.toContain(PID);
    expect(w.text()).not.toContain(PID);
  });

  it("refuses an unknown proposal and a malformed id", async () => {
    const w = world();
    await expect(w.go(["--proposal", PID])).rejects.toThrow(/no such proposal/);
    expect(() => w.args(["--proposal", "nope"])).toThrow(/ULID/);
  });
});

describe("chat mode", () => {
  const conv = "g:abc123";
  const rowKey = (seq) => ({ PK: `CHAT#${conv}`, SK: `M#${String(seq).padStart(10, "0")}` });
  const seedChat = (w) => {
    for (const seq of [41, 42]) w.ddb.rows.set(`${rowKey(seq).PK}\u0000${rowKey(seq).SK}`, { ...rowKey(seq), entity: "chat_msg", seq, text: `hello ${SECRET} ${seq}` });
  };

  it("parses <conv>:<seq> with colons in the conversation id", () => {
    expect(parseChatRef("g:abc123:42")).toEqual({ conv: "g:abc123", seq: 42 });
    expect(parseChatRef("dm:u1:u2:7")).toEqual({ conv: "dm:u1:u2", seq: 7 });
    for (const bad of ["g:abc123", "x:1", "g:abc123:0", "g:abc123:-3", "g:abc123:1.5", ""]) expect(() => parseChatRef(bad)).toThrow(ExpungeError);
  });

  it("dry run reports the mirror row and calls nothing", async () => {
    const w = world();
    seedChat(w);
    const before = w.snapshot();
    await w.go(["--chat", `${conv}:42`]);
    expect(w.snapshot()).toBe(before);
    expect(w.calls).toEqual([]);
    expect(w.text()).toMatch(/1 mirror row to delete/);
  });

  it("--apply nulls the hub message first, then deletes only that mirror row, and audits counts", async () => {
    const w = world();
    seedChat(w);
    await w.go(["--chat", `${conv}:42`, "--apply"]);
    expect(w.calls).toEqual([["hub", { conv, seq: 42 }, true]]); // the mirror row still existed when the hub was called
    expect(w.row(rowKey(42).PK, rowKey(42).SK)).toBeUndefined();
    expect(w.row(rowKey(41).PK, rowKey(41).SK).text).toContain(SECRET);
    const audit = w.ddb.all().find((r) => r.PK.startsWith("AUDIT#expunge:"));
    expect(audit.after).toEqual({ mode: "chat", counts: { mirror_rows: 1, hub_messages: 1 } });
    expect(JSON.stringify(audit)).not.toContain(conv);
  });

  it("writes nothing when the hub is not configured or fails", async () => {
    const w = world();
    seedChat(w);
    const before = w.snapshot();
    await expect(run(w.args(["--chat", `${conv}:42`, "--apply"]), { ...w.ctx, hub: undefined })).rejects.toThrow(/hub is not configured/);
    await expect(run(w.args(["--chat", `${conv}:42`, "--apply"]), { ...w.ctx, hub: { nullMessage: async () => { throw new ExpungeError("the chat hub answered 502"); } } })).rejects.toThrow(/502/);
    expect(w.snapshot()).toBe(before);
  });

  it("the hub client posts to /admin/expunge with a bearer token, treats 404 as nothing to null, and refuses plain http", async () => {
    const seen = [];
    const mk = (status, body) => createHubClient({ url: "https://hub.example.test/", token: "tok", fetchImpl: async (u, o) => (seen.push([u, o]), { status, ok: status < 300, json: async () => body }) });
    expect(await mk(200, { nulled: 1 }).nullMessage({ conv, seq: 3 })).toEqual({ nulled: 1 });
    expect(seen[0][0]).toBe("https://hub.example.test/admin/expunge");
    expect(seen[0][1]).toMatchObject({ method: "POST", headers: { authorization: "Bearer tok" }, body: JSON.stringify({ conv, seq: 3 }) });
    expect(await mk(404, {}).nullMessage({ conv, seq: 3 })).toEqual({ nulled: 0 });
    await expect(mk(500, {}).nullMessage({ conv, seq: 3 })).rejects.toThrow(/500/);
    expect(() => createHubClient({ url: "http://hub.example.test", token: "t" })).toThrow(/https/);
    expect(() => createHubClient({ url: "", token: "t" })).toThrow(/CHAT_HUB_ADMIN_URL/);
    expect(() => createHubClient({ url: "http://localhost:8787", token: "t" })).not.toThrow();
  });
});

describe("upload mode", () => {
  const ID = "01J00000000000000000000ABC";
  const KEY = `uploads/posts/${ID}/photo.jpg`;

  it("dry run counts every version, delete markers included, and deletes nothing", async () => {
    const w = world();
    w.s3.seed(SITE, KEY);
    w.s3.seed(SITE, KEY);
    w.s3.seed(SITE, KEY, { marker: true });
    w.ddb.rows.set(`UPLOAD#${ID}\u0000META`, { PK: `UPLOAD#${ID}`, SK: "META", entity: "upload", key: KEY });
    await w.go(["--upload", KEY]);
    expect(w.text()).toMatch(/3 object versions \(delete markers included\) and 1 UPLOAD# binding/);
    expect(w.s3.deleted).toEqual([]);
    expect(w.s3.versions(SITE, KEY)).toHaveLength(3);
  });

  it("--apply deletes every version by id and the binding, and nothing else", async () => {
    const w = world();
    w.s3.seed(SITE, KEY);
    w.s3.seed(SITE, KEY);
    w.s3.seed(SITE, KEY, { marker: true });
    w.s3.seed(SITE, `uploads/posts/${ID}/photo.jpg.bak`);
    w.s3.seed(SITE, "uploads/posts/01J00000000000000000000ZZZ/photo.jpg");
    w.ddb.rows.set(`UPLOAD#${ID}\u0000META`, { PK: `UPLOAD#${ID}`, SK: "META", entity: "upload", key: KEY });
    await w.go(["--upload", KEY, "--apply"]);
    expect(w.s3.versions(SITE, KEY)).toEqual([]);
    expect(w.s3.deleted).toHaveLength(3);
    expect(w.s3.deleted.every(([b, k, v]) => b === SITE && k === KEY && typeof v === "string")).toBe(true);
    expect(w.s3.keys(SITE)).toEqual([`uploads/posts/${ID}/photo.jpg.bak`, "uploads/posts/01J00000000000000000000ZZZ/photo.jpg"]);
    expect(w.row(`UPLOAD#${ID}`, "META")).toBeUndefined();
    expect(w.ddb.all().find((r) => r.PK.startsWith("AUDIT#expunge:")).after).toEqual({ mode: "upload", counts: { versions: 3, bindings: 1 } });
  });

  it("deletes the plain object of a bucket that is not versioned (no VersionId named)", async () => {
    const w = world({ versioned: { [SYNC]: true } });
    w.s3.seed(SITE, KEY);
    await w.go(["--upload", KEY, "--apply"]);
    expect(w.s3.deleted).toEqual([[SITE, KEY, undefined]]);
    expect(w.s3.keys(SITE)).toEqual([]);
  });

  it("refuses a key outside uploads/posts and uploads/comments", async () => {
    const w = world();
    expect(() => w.args(["--upload", "media/abc.jpg"])).toThrow(/--upload needs a key/);
    expect(() => w.args(["--upload", `uploads/posts/${ID}/../x.jpg`])).toThrow(/--upload needs a key/);
    expect(() => w.args(["--upload", "uploads/posts/short/photo.jpg"])).toThrow(/--upload needs a key/);
  });
});

describe("--due and --now", () => {
  it("expunges a withdrawn record only after the 72-hour grace, and --now takes it at once", async () => {
    const w = world();
    const { p } = await withdrawnTree(w);
    const hist = () => [1, 2, 3, 4, 5].map((s) => w.row("SYNC#LOG", String(s).padStart(12, "0"))).filter((e) => e?.handle === p.handle);
    await w.go(["--due"]);
    expect(w.text()).toMatch(/0 scheduled expunges past the 72-hour grace/);
    w.clock.advance(EXPUNGE_GRACE_MS - 3 * 3600 * 1000);
    w.lines.length = 0;
    await w.go(["--due", "--apply"]);
    expect(w.text()).toMatch(/0 scheduled expunges/);
    expect(hist().every((e) => e.expunged === undefined)).toBe(true);

    w.lines.length = 0;
    await w.go(["--due", "--now"]); // dry run: reports it, changes nothing
    expect(w.text()).toMatch(/1 scheduled expunge \(--now: all of them\)/);
    expect(hist().every((e) => e.expunged === undefined)).toBe(true);
    await w.go(["--due", "--now", "--apply"]);
    expect(hist().every((e) => e.expunged === true && e.obj_json === null)).toBe(true);
    expect(w.row(`EXPUNGE#Person#${p.handle}`, "META")).toBeUndefined();
    expect(w.text()).toMatch(/due: 1 expunged, 0 skipped, 0 failed/);
  });

  it("rebuilds the snapshot once for a whole run, however many records it expunges", async () => {
    const w = world();
    const ps = [person(1), person(2), person(3)];
    await w.batch(ps.map(create));
    await w.batch(ps.map((p) => withdraw(p, 1)));
    w.s3.seed(SYNC, "snapshots/2.jsonl.gz");
    w.clock.advance(EXPUNGE_GRACE_MS + 1000);
    await w.go(["--due", "--apply"]);
    for (const p of ps) expect(w.row(`REC#Person#${p.handle}`, "HEAD")).toMatchObject({ expunged: true });
    expect(w.s3.puts.filter(([b, k]) => b === SYNC && k.endsWith(".jsonl.gz"))).toHaveLength(1);
    expect(w.s3.keys(SYNC, "snapshots/")).toHaveLength(2);
    expect(w.text()).toMatch(/due: 3 expunged, 0 skipped, 0 failed; 1 snapshot version replaced by a rebuilt snapshot/);
    expect(w.ddb.all().filter((r) => r.PK.startsWith("AUDIT#expunge:"))).toHaveLength(4); // one per record and one for the run
  });

  it("expunges after the grace has passed without --now", async () => {
    const w = world();
    const { p } = await withdrawnTree(w);
    w.clock.advance(EXPUNGE_GRACE_MS + 3600 * 1000);
    await w.go(["--due", "--apply"]);
    expect(w.row(`REC#Person#${p.handle}`, "HEAD")).toMatchObject({ expunged: true, obj_json: null });
  });

  it("drops a stale schedule item whose record is live again, and expunges nothing", async () => {
    const w = world();
    const n = note(1, SECRET);
    await w.batch([create(n)]);
    w.ddb.rows.set(`EXPUNGE#Note#${n.handle}\u0000META`, { PK: `EXPUNGE#Note#${n.handle}`, SK: "META", GSI1PK: "EXPUNGEQ#pending", GSI1SK: `2026-01-01T00:00:00.000Z#Note#${n.handle}`, entity: "expunge_due", class: "Note", handle: n.handle, version: 1 });
    await w.go(["--due", "--now"]);
    expect(w.text()).toMatch(/skipped one Note \(live\)/);
    expect(w.row(`EXPUNGE#Note#${n.handle}`, "META")).toBeDefined(); // a dry run keeps it
    await w.go(["--due", "--now", "--apply"]);
    expect(w.row(`EXPUNGE#Note#${n.handle}`, "META")).toBeUndefined();
    expect(JSON.parse(w.row(`REC#Note#${n.handle}`, "HEAD").obj_json).text.string).toBe(SECRET);
  });

  it("a resurrect inside the grace cancels the schedule, so the record is never expunged", async () => {
    const w = world();
    const { p, wd } = await withdrawnTree(w);
    const { run: adminRun, parseArgs: adminArgs } = await import("../scripts/sync-admin.mjs");
    w.clock.advance(3600 * 1000);
    await adminRun(adminArgs(["resurrect", "--batch", wd.batch_id, "--apply", "--include-withdrawn"]), { ...w.ctx, log: () => {} });
    expect(w.row(`REC#Person#${p.handle}`, "HEAD")).toMatchObject({ deleted: false });
    w.clock.advance(EXPUNGE_GRACE_MS * 2);
    w.lines.length = 0;
    await w.go(["--due", "--apply"]);
    expect(w.text()).toMatch(/0 scheduled expunges/);
    expect(w.row(`REC#Person#${p.handle}`, "HEAD").obj_json).not.toBeNull();
  });
});

describe("--due: crashes, races and failure lines", () => {
  const schedule = (cls, handle, version = 1) => ({ PK: `EXPUNGE#${cls}#${handle}`, SK: "META", GSI1PK: "EXPUNGEQ#pending", GSI1SK: `2026-01-01T00:00:00.000Z#${cls}#${handle}`, entity: "expunge_due", class: cls, handle, version });

  it("a crash in the snapshot sweep keeps the schedule item, and the next --due finishes the cleanup even though the record is already expunged", async () => {
    const w = world();
    const { p } = await withdrawnTree(w);
    w.s3.seed(SYNC, "snapshots/old.jsonl.gz", { body: SECRET });
    w.s3.seed(SYNC, "snapshots/old.jsonl.gz", { body: SECRET });
    const real = w.s3;
    let failDelete = true;
    const ctx = { ...w.ctx, s3: { send: async (c) => { if (failDelete && c.constructor.name === "DeleteObjectCommand" && c.input.Key.startsWith("snapshots/")) throw Object.assign(new Error("boom"), { name: "InternalError" }); return real.send(c); } } };
    await expect(run(w.args(["--due", "--now", "--apply"]), ctx)).rejects.toThrow(/boom/);
    expect(w.row(`REC#Person#${p.handle}`, "HEAD")).toMatchObject({ expunged: true, obj_json: null }); // the table is done
    expect(w.row(`EXPUNGE#Person#${p.handle}`, "META")).toBeDefined(); // the schedule item waits for the sweep
    expect(w.row("EXPUNGE#SWEEP", "META")).toBeDefined();
    expect(w.s3.versions(SYNC, "snapshots/old.jsonl.gz")).toHaveLength(2); // the old data is still there
    failDelete = false;
    w.lines.length = 0;
    await run(w.args(["--due", "--now", "--apply"]), ctx);
    expect(w.s3.versions(SYNC, "snapshots/old.jsonl.gz")).toHaveLength(0);
    expect(w.s3.keys(SYNC, "snapshots/")).toHaveLength(2); // the rebuilt snapshot and its pointer
    expect(w.row(`EXPUNGE#Person#${p.handle}`, "META")).toBeUndefined();
    expect(w.row("EXPUNGE#SWEEP", "META")).toBeUndefined();
    expect(w.text()).toMatch(/due: 1 expunged, 0 skipped, 0 failed/);
    expect(w.ddb.all().filter((r) => r.PK.startsWith("AUDIT#expunge:") && r.after.mode === "record")).toHaveLength(1); // not audited twice
    expect(w.row("SYNC#HEAD", "META").expunge_epoch).toBe(1);
  });

  it("an owed sweep runs even when nothing is due any more", async () => {
    const w = world();
    const { p } = await withdrawnTree(w);
    await w.go(["--record", `Person:${p.handle}`, "--apply"]);
    w.ddb.rows.set("EXPUNGE#SWEEP\u0000META", { PK: "EXPUNGE#SWEEP", SK: "META", entity: "expunge_sweep", at: "2026-10-14T00:00:00.000Z" });
    w.s3.seed(SYNC, "snapshots/stray.jsonl.gz", { body: SECRET });
    w.lines.length = 0;
    await w.go(["--due", "--apply"]);
    expect(w.text()).toMatch(/0 scheduled expunges/);
    expect(w.text()).toMatch(/a sweep was owed/);
    expect(w.s3.versions(SYNC, "snapshots/stray.jsonl.gz")).toHaveLength(0);
    expect(w.row("EXPUNGE#SWEEP", "META")).toBeUndefined();
  });

  it("a resurrect that races an expunge fails that record only, and the run goes on to the next", async () => {
    const w = world();
    const ps = [person(1), person(2)];
    await w.batch(ps.map(create));
    await w.batch(ps.map((p) => withdraw(p, 1)));
    w.ddb.failNext("ConditionalCheckFailed", 2); // the first record's guarded transaction is cancelled, and so is its one retry
    await w.go(["--due", "--now", "--apply"]);
    expect(w.text()).toMatch(/due: 1 expunged, 0 skipped, 1 failed/);
    expect(w.text()).toMatch(/one Person failed \(ExpungeError record_moved\); its schedule item stays for the next run/);
    const expunged = ps.filter((p) => w.row(`REC#Person#${p.handle}`, "HEAD").expunged === true);
    expect(expunged).toHaveLength(1);
    const left = ps.find((p) => !expunged.includes(p));
    expect(w.row(`EXPUNGE#Person#${left.handle}`, "META")).toBeDefined();
    await w.go(["--due", "--now", "--apply"]); // the next run takes it
    expect(w.row(`REC#Person#${left.handle}`, "HEAD").expunged).toBe(true);
    expect(w.row(`EXPUNGE#Person#${left.handle}`, "META")).toBeUndefined();
  });

  it("a record resurrected between the history read and the writes is skipped as live, not half expunged", async () => {
    const w = world();
    const { p, wd } = await withdrawnTree(w);
    const { run: adminRun, parseArgs: adminArgs } = await import("../scripts/sync-admin.mjs");
    const real = w.ddb.send.bind(w.ddb);
    let resurrected = false;
    const ctx = { ...w.ctx, ddb: { send: async (c) => {
      if (!resurrected && c.constructor.name === "TransactWriteCommand") {
        resurrected = true;
        await adminRun(adminArgs(["resurrect", "--batch", wd.batch_id, "--apply", "--include-withdrawn"]), { ...w.ctx, log: () => {} });
      }
      return real(c);
    } } };
    await run(w.args(["--due", "--now", "--apply"]), ctx);
    expect(resurrected).toBe(true);
    expect(w.text()).toMatch(/skipped one Person \(live\)/);
    expect(w.text()).toMatch(/due: 0 expunged, 1 skipped, 0 failed/);
    expect(w.row(`REC#Person#${p.handle}`, "HEAD")).toMatchObject({ deleted: false });
    expect(w.row(`REC#Person#${p.handle}`, "HEAD").obj_json).not.toBeNull();
    expect(w.row(`EXPUNGE#Person#${p.handle}`, "META")).toBeUndefined();
  });

  it("a failure line carries the class, the error name and a code, never the handle or a value", async () => {
    const w = world();
    const ghost = h(77);
    w.ddb.rows.set(`EXPUNGE#Note#${ghost}\u0000META`, schedule("Note", ghost));
    await w.go(["--due", "--now", "--apply"]);
    expect(w.text()).toMatch(/one Note failed \(ExpungeError no_such_record\)/);
    expect(w.text()).not.toContain(ghost);
    expect(w.text()).not.toMatch(/no such record/);
    w.lines.length = 0;
    w.ddb.rows.set(`EXPUNGE#Bogus${SECRET}#${ghost}\u0000META`, { ...schedule("Note", ghost), PK: `EXPUNGE#Bogus${SECRET}#${ghost}`, class: `Bogus${SECRET}` });
    await w.go(["--due", "--now", "--apply"]);
    expect(w.text()).toMatch(/one record failed \(ExpungeError unknown_class\)/);
    expect(w.text()).not.toContain(SECRET); // the class text from the store is not echoed back
  });
});

describe("step-up", () => {
  const OWNER = "I0001";
  const NOW = Date.parse("2026-10-14T12:00:00Z");
  const nowS = Math.floor(NOW / 1000);
  const jwks = createLocalJWKSet({ keys: [{ ...createPublicKey(pem).export({ format: "jwk" }), kid: "hfy-session-1", alg: "RS256", use: "sig" }] });
  const groups = (owners) => createGroupResolver({ load: async () => ({ version: 1, groups: { "gramps-owner": { subjects: owners } } }) });
  const authenticate = (owners = [OWNER]) => createSyncAuthenticator({ getJwks: async () => jwks, getGroups: groups(owners), now: () => NOW, log: { warn() {}, error() {} } });
  const token = async (o = {}) => new SignJWT({ client_id: SYNC_CLIENT_ID, token_use: "access", amr: o.amr ?? ["passkey", "mfa"], auth_time: o.authTime ?? nowS - 10 })
    .setProtectedHeader({ alg: "RS256", kid: "hfy-session-1" }).setSubject(o.sub ?? OWNER).setIssuer("https://harrisonfamily.us/auth").setAudience(SYNC_AUDIENCE)
    .setIssuedAt(nowS - 5).setExpirationTime(nowS + 600).sign(await importPKCS8(pem, "RS256"));

  it("accepts the owner's token from a fresh mfa sign-in and names the subject", async () => {
    expect(await stepUpFrom(authenticate(), await token(), NOW)).toEqual({ sub: OWNER });
  });
  it("refuses a missing token, a stale sign-in, a sign-in without mfa, and a member who is not the owner", async () => {
    await expect(stepUpFrom(authenticate(), undefined, NOW)).rejects.toThrow(/needs io's step-up/);
    await expect(stepUpFrom(authenticate(), await token({ authTime: nowS - 301 }), NOW)).rejects.toThrow(/step-up refused: step_up_required/);
    await expect(stepUpFrom(authenticate(), await token({ amr: ["pwd"] }), NOW)).rejects.toThrow(/step-up refused/);
    await expect(stepUpFrom(authenticate([]), await token(), NOW)).rejects.toThrow(/step-up refused: not_owner/);
    await expect(stepUpFrom(authenticate(), "not.a.jwt", NOW)).rejects.toThrow(/step-up refused/);
  });
});

describe("snapshots and readers", () => {
  it("an expunged head is a tombstone that says so, and no other snapshot line changes", () => {
    const heads = [
      { class: "Note", handle: h(1), gramps_id: "N1", version: 2, seq: 3, deleted: false, obj: { a: 1 } },
      { class: "Note", handle: h(2), gramps_id: "N2", version: 3, seq: 4, deleted: true, expunged: true, obj: null },
      { class: "Note", handle: h(3), gramps_id: "N3", version: 3, seq: 5, deleted: true, obj: null },
    ];
    const { gz } = buildSnapshot({ treeId: "t", seq: 5, heads });
    const lines = gunzipSync(gz).toString().trim().split("\n").slice(1).map((l) => JSON.parse(l));
    expect(lines[0]).not.toHaveProperty("expunged");
    expect(lines[1]).toMatchObject({ deleted: true, expunged: true, obj: null });
    expect(lines[2]).not.toHaveProperty("expunged");
  });
  it("entryView shows an expunged entry as obj:null, expunged:true with its hash and seq, and others as before", () => {
    expect(entryView({ seq: 7, class: "Note", handle: h(1), gramps_id: "N1", version: 2, hash: "ab", obj_json: null, expunged: true })).toEqual({ seq: 7, class: "Note", handle: h(1), gramps_id: "N1", version: 2, hash: "ab", obj: null, expunged: true });
    expect(entryView({ seq: 8, class: "Note", handle: h(1), gramps_id: "N1", version: 3, hash: "cd", obj_json: '{"a":1}' })).toEqual({ seq: 8, class: "Note", handle: h(1), gramps_id: "N1", version: 3, hash: "cd", obj: { a: 1 } });
    expect(entryView(undefined)).toBeNull();
  });
  it("a --path scrub reads through entryView as a changed hash at an unchanged version and seq (the notice the add-on acts on)", async () => {
    const w = world();
    const n = note(1, `first ${SECRET}`);
    await w.batch([create(n)]);
    await w.batch([update({ ...n, text: { ...n.text, string: `second ${SECRET}` } }, 1)]);
    const before = entryView(w.row("SYNC#LOG", "000000000002"));
    await w.go(["--record", `Note:${n.handle}`, "--path", "/text/string", "--apply"]);
    const after = entryView(w.row("SYNC#LOG", "000000000002"));
    expect(after).toMatchObject({ seq: before.seq, version: before.version, handle: n.handle });
    expect(after.hash).not.toBe(before.hash);
    expect(after.hash).toBe(sha256(w.row("SYNC#LOG", "000000000002").obj_json));
    expect(after.obj.text.string).toBe("");
    expect(after).not.toHaveProperty("expunged"); // a value scrub is not a whole-record expunge
  });
  it("the store view treats an expunged log entry as no object", async () => {
    const w = world();
    const { p } = await withdrawnTree(w);
    await w.go(["--record", `Person:${p.handle}`, "--apply"]);
    const view = await storeView({ ddb: w.ddb, cmds, table: T, now: w.ctx.now });
    expect(view.heads.get(`Person:${p.handle}`)).toMatchObject({ deleted: true, obj: null, expunged: true });
    expect(view.live().map((x) => x.class)).toEqual(["Note"]);
  });
  it("logKey shape is unchanged", () => {
    expect(logKey(7)).toEqual({ PK: "SYNC#LOG", SK: "000000000007" });
  });
});
