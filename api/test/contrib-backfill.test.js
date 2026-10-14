// HFY-TSK-255: scripts/contrib-backfill.mjs. --dry-run prints the plan and writes nothing; --apply credits pre-ledger content and
// rebuilds the counters, and a second run changes nothing. Synthetic data only.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ulidTime } from "@io-kit/feed";
import { derivedUlid, eventIdFor, expectedCounters, planBackfill, run } from "../scripts/contrib-backfill.mjs";
import { seedPosts } from "../src/content.js";
import { TABLE, cmds, createFakeDdb, makeApi, signToken } from "./world.js";

const SCRIPT = fileURLToPath(new URL("../scripts/contrib-backfill.mjs", import.meta.url));
const T1 = "2026-01-20T09:00:00.000Z";
const T2 = "2026-02-03T09:00:00.000Z";
const T3 = "2026-02-04T09:00:00.000Z";
const P1 = "01J0000000000000000000P001";
const P2 = "01J0000000000000000000P002";
const P3 = "01J0000000000000000000P003";
const C1 = "01J0000000000000000000C001";
const C2 = "01J0000000000000000000C002";
const img = (n) => ({ kind: "image", url: `/uploads/posts/01J0000000000000000000000${n}/a.jpg`, mime: "image/jpeg" });
const post = (id, author, visibility, created_at, extra = {}) => ({ id, type: "post", author: { id: author, label: "A" }, body: "b", attachments: [], visibility, created_at, updated_at: created_at, ...extra });
const comment = (id, author, threadId, created_at, extra = {}) => ({ id, threadId, author: { id: author, label: "A" }, body: "b", created_at, ...extra });
const putComment = (ddb, c) =>
  ddb.send(new cmds.PutCommand({ TableName: TABLE, Item: { PK: `THREAD#${c.threadId}`, SK: `C#${c.id}`, GSI1PK: "COMMENTS", GSI1SK: c.id, entity: "comment", comment: c } }));
const putAudit = (ddb, id, at, op, before, after) =>
  ddb.send(new cmds.PutCommand({ TableName: TABLE, Item: { PK: `AUDIT#${id}`, SK: `${at}#x`, GSI1PK: "AUDIT", GSI1SK: `${at}#x`, entity: "audit", op, id, at, before, after } }));

/** pre-ledger content: a published post with 3 photos, a withdrawn post, a draft, and two comments. */
async function legacy(ddb = createFakeDdb()) {
  await seedPosts({ ddb, cmds, table: TABLE }, [
    post(P1, "I0001", "published", T1, { subject: "I0009", attachments: [img(1), img(2), img(3)] }),
    post(P2, "I0002", "withdrawn", T2),
    post(P3, "I0001", "draft", T3),
  ]);
  await putAudit(ddb, P1, T1, "create", null, { visibility: "published" });
  await putAudit(ddb, P2, T2, "create", null, { visibility: "draft" });
  await putAudit(ddb, P2, "2026-02-05T09:00:00.000Z", "visibility", { visibility: "draft" }, { visibility: "published" });
  await putAudit(ddb, P2, "2026-02-06T09:00:00.000Z", "visibility", { visibility: "published" }, { visibility: "withdrawn" });
  await putAudit(ddb, P3, T3, "create", null, { visibility: "draft" });
  await putComment(ddb, comment(C1, "I0002", "person:I0009", T2));
  await putComment(ddb, comment(C2, "I0001", `post:${P1}`, T3));
  return ddb;
}
const snapshot = (ddb) => JSON.stringify(ddb.all().sort((a, b) => (`${a.PK}|${a.SK}` < `${b.PK}|${b.SK}` ? -1 : 1)));
const ctx = (ddb, extra = {}) => ({ ddb, cmds, table: TABLE, log: () => {}, now: () => Date.parse("2026-03-01T00:00:00Z"), ...extra });

describe("derived event ids", () => {
  it("are ULIDs at the time of the item, stable per ref and different across refs", () => {
    const id = derivedUlid(T1, "seed");
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(ulidTime(id)).toBe(Date.parse(T1));
    expect(derivedUlid(T1, "seed")).toBe(id);
    expect(derivedUlid(T1, "other")).not.toBe(id);
    const ref = { type: "comment", id: C1, thread: "person:I0009" };
    expect(eventIdFor(T2, "comment", ref)).toBe(eventIdFor(T2, "comment", { ...ref }));
    expect(eventIdFor(T2, "comment", ref)).not.toBe(eventIdFor(T2, "comment", { ...ref, id: C2 }));
  });
});

describe("--dry-run", () => {
  it("prints the planned events and counters and writes nothing", async () => {
    const ddb = await legacy();
    const before = snapshot(ddb);
    const lines = [];
    const { plan, written } = await run(ctx(ddb, { apply: false, log: (l) => lines.push(l) }));
    expect(snapshot(ddb)).toBe(before);
    expect(written).toEqual({ events: 0, counters: 0 });
    expect(plan.events.map((p) => `${p.event.kind}:${p.event.ref.id}`).sort()).toEqual([`comment:${C1}`, `comment:${C2}`, `post:${P1}`, `post:${P2}`].sort());
    const text = lines.join("\n");
    expect(text).toContain("plan: 4 event(s) to create (post 2, comment 2)");
    expect(text).toContain("1 draft post(s) not credited");
    expect(text).toContain("CSTAT#site TOTAL");
    expect(text).toContain("dry run: nothing written");
    expect(text).not.toContain("body"); // ids, kinds and counts only
  });

  it("credits a post at its first publish, hides a withdrawn one, and counts photos", async () => {
    const plan = await planBackfill(ctx(await legacy()));
    const byRef = Object.fromEntries(plan.events.map((p) => [p.event.ref.id, p.event]));
    expect(byRef[P1]).toMatchObject({ kind: "post", at: T1, weight: 4, photos: 3, subject: "I0009", actor: { id: "I0001" }, via: "ui" });
    expect(byRef[P1].hidden).toBeUndefined();
    expect(byRef[P2]).toMatchObject({ kind: "post", at: "2026-02-05T09:00:00.000Z", weight: 1, hidden: true });
    expect(byRef[C1]).toMatchObject({ kind: "comment", at: T2, actor: { id: "I0002" }, subject: "person:I0009", ref: { thread: "person:I0009" } });
    expect(byRef[C2]).toMatchObject({ kind: "comment", ref: { thread: `post:${P1}` } });
    const links = Object.fromEntries(plan.events.map((p) => [p.event.ref.id, p.links.map((l) => l.SK)]));
    expect(links[P1]).toEqual(["META", "IDX#AUTHOR", "IDX#SUBJECT"]);
    expect(links[C1]).toEqual([`C#${C1}`]);
  });
});

describe("--apply", () => {
  it("writes the events, links the stored items and rebuilds every counter from the events", async () => {
    const ddb = await legacy();
    const { written } = await run(ctx(ddb, { apply: true }));
    expect(written.events).toBe(4);
    const rows = ddb.all();
    expect(rows.filter((r) => r.PK.startsWith("CONTRIB#") && r.SK.startsWith("E#"))).toHaveLength(4);
    const get = (pk, sk) => rows.find((r) => r.PK === pk && r.SK === sk);
    expect(get("CSTAT#site", "TOTAL")).toMatchObject({ n: 4 + 1 + 1 + 1, n_post: 2, n_comment: 2, n_photo: 3, first_at: T1 });
    expect(get("CSTAT#person:I0001", "TOTAL")).toMatchObject({ n: 4 + 1, n_post: 1, n_comment: 1, n_photo: 3 });
    expect(get("CSTAT#person:I0002", "TOTAL")).toMatchObject({ n: 2, n_post: 1, n_comment: 1 });
    expect(get("CSTAT#site", "M#2026-02").n).toBe(3);
    expect(get("CSTAT#site", "M#2026-01").n).toBe(4);
    expect(get("CSTAT#site", "D#2026-01-20")).toMatchObject({ n: 4 });
    expect(get("CSTAT#site", "D#2026-01-20").ttl).toBe(Math.floor((Date.parse("2026-01-20T00:00:00Z") + 800 * 86_400_000) / 1000));
    // the links
    const ev = Object.fromEntries(rows.filter((r) => r.entity === "contrib").map((r) => [r.ref.id, r.id]));
    for (const sk of ["META", "IDX#AUTHOR", "IDX#SUBJECT"]) expect(get(`POST#${P1}`, sk).post.contrib).toEqual({ id: ev[P1] });
    expect(get(`POST#${P3}`, "META").post.contrib).toBeUndefined();
    expect(get("THREAD#person:I0009", `C#${C1}`).comment.contrib).toEqual({ id: ev[C1] });
  });

  it("is idempotent: a second run plans nothing and changes nothing", async () => {
    const ddb = await legacy();
    await run(ctx(ddb, { apply: true }));
    const after = snapshot(ddb);
    const lines = [];
    const again = await run(ctx(ddb, { apply: true, log: (l) => lines.push(l) }));
    expect(again.plan.events).toEqual([]);
    expect(again.plan.counters).toEqual([]);
    expect(again.written).toEqual({ events: 0, counters: 0 });
    expect(snapshot(ddb)).toBe(after);
    expect(lines.join("\n")).toContain("plan: 0 event(s) to create (none), 0 counter row(s) to set");
  });

  it("a crashed run resumes: events already written are found again, nothing is credited twice", async () => {
    const ddb = await legacy();
    const first = await planBackfill(ctx(ddb));
    // apply only the first two events by hand (as a run that died part way would have), without their counters
    const half = { events: first.events.slice(0, 2), counters: [] };
    const { applyPlan } = await import("../scripts/contrib-backfill.mjs");
    await applyPlan(ctx(ddb), half);
    await run(ctx(ddb, { apply: true }));
    expect(ddb.all().filter((r) => r.entity === "contrib")).toHaveLength(4);
    expect(ddb.all().find((r) => r.PK === "CSTAT#site" && r.SK === "TOTAL").n).toBe(7);
    const after = snapshot(ddb);
    await run(ctx(ddb, { apply: true }));
    expect(snapshot(ddb)).toBe(after);
  });

  it("agrees with the live ledger: events written by the API before the backfill are kept and counted once", async () => {
    const w = makeApi();
    await legacy(w.ddb);
    const t = await signToken("I0003");
    const up = (await w.call("POST", "/api/uploads", { token: t, body: { contentType: "image/jpeg", size: 9 } })).body; // a live post attaches a presigned upload
    const live = (await w.call("POST", "/api/posts", { token: t, body: { body: "new", visibility: "published", attachments: [{ kind: "image", url: up.publicUrl, mime: "image/jpeg" }] } })).body;
    await w.call("POST", "/api/comments", { token: t, body: { subject: "person:I0009", body: "new" } });
    expect(w.ddb.all().find((r) => r.PK === "CSTAT#site" && r.SK === "TOTAL").n).toBe(3); // only the live writes so far
    await run(ctx(w.ddb, { apply: true, now: () => Date.now() }));
    const site = w.ddb.all().find((r) => r.PK === "CSTAT#site" && r.SK === "TOTAL");
    expect(site).toMatchObject({ n: 7 + 3, n_post: 3, n_comment: 3, n_photo: 4 });
    expect(w.ddb.all().filter((r) => r.entity === "contrib")).toHaveLength(6);
    // and revoking a backfilled credit through the API now works, because the stored item is linked
    const p1 = (await w.call("GET", `/api/posts/${P1}`, { token: await signToken("I0001") })).body;
    expect(p1.contrib.id).toMatch(/^[0-9A-Z]{26}$/);
    expect((await w.call("DELETE", `/api/posts/${P1}`, { token: await signToken("I0001") })).status).toBe(204);
    expect(w.ddb.all().find((r) => r.PK === "CSTAT#site" && r.SK === "TOTAL")).toMatchObject({ n: 7 + 3 - 4 - 1, n_post: 2, n_comment: 2, n_photo: 1 }); // and the purge of its thread took the backfilled comment C2
    expect(live.id).toBeTruthy();
    // a rerun after the live delete is still a no-op
    const lines = [];
    await run(ctx(w.ddb, { apply: true, now: () => Date.now(), log: (l) => lines.push(l) }));
    expect(lines.join("\n")).toContain("0 event(s) to create (none), 0 counter row(s) to set");
  });

  it("repairs a counter that drifted and zeroes a row nothing supports", async () => {
    const ddb = await legacy();
    await run(ctx(ddb, { apply: true }));
    await ddb.send(new cmds.PutCommand({ TableName: TABLE, Item: { PK: "CSTAT#site", SK: "TOTAL", n: 99, first_at: T1 } }));
    await ddb.send(new cmds.PutCommand({ TableName: TABLE, Item: { PK: "CSTAT#person:I0777", SK: "TOTAL", n: 5, n_post: 5 } }));
    const plan = await planBackfill(ctx(ddb));
    expect(plan.counters.map((c) => `${c.row.PK}|${c.row.SK}`)).toEqual(["CSTAT#person:I0777|TOTAL", "CSTAT#site|TOTAL"]);
    await run(ctx(ddb, { apply: true }));
    expect(ddb.all().find((r) => r.PK === "CSTAT#person:I0777").n).toBe(0);
    expect(ddb.all().find((r) => r.PK === "CSTAT#site" && r.SK === "TOTAL").n).toBe(7);
    expect((await planBackfill(ctx(ddb))).counters).toEqual([]);
  });

  it("leaves the LINE cache row alone and skips day rows past their ttl", async () => {
    const ddb = await legacy();
    await ddb.send(new cmds.PutCommand({ TableName: TABLE, Item: { PK: "CSTAT#site", SK: "LINE", x: 3, text: "cached" } }));
    await run(ctx(ddb, { apply: true, now: () => Date.parse("2029-06-01T00:00:00Z") })); // more than 800 days after the content
    expect(ddb.all().find((r) => r.SK === "LINE")).toMatchObject({ text: "cached" });
    expect(ddb.all().filter((r) => r.PK === "CSTAT#site" && r.SK.startsWith("D#"))).toEqual([]);
    expect(ddb.all().find((r) => r.PK === "CSTAT#site" && r.SK === "TOTAL").n).toBe(7);
  });

  it("an item with a malformed time is skipped and named, and does not stop the plan or the apply", async () => {
    const ddb = await legacy();
    await putComment(ddb, comment("01J0000000000000000000C009", "I0003", "person:I0009", "not-a-time"));
    await putComment(ddb, comment("01J0000000000000000000C010", "I0003", "person:I0009", undefined));
    await seedPosts({ ddb, cmds, table: TABLE }, [post("01J0000000000000000000P009", "I0003", "published", "garbage")]);
    const lines = [];
    const { plan, written } = await run(ctx(ddb, { apply: true, log: (l) => lines.push(l) }));
    expect(plan.skipped.invalid).toBe(3);
    expect([...plan.skipped.invalidIds].sort()).toEqual(["comment:01J0000000000000000000C009", "comment:01J0000000000000000000C010", "post:01J0000000000000000000P009"]);
    expect(written.events).toBe(4); // the four good items are still credited
    expect(lines.join("\n")).toContain("3 item(s) skipped as invalid (");
    expect(ddb.all().find((r) => r.PK === "CSTAT#site" && r.SK === "TOTAL").n).toBe(7);
  });

  it("an empty table plans nothing", async () => {
    const plan = await planBackfill(ctx(createFakeDdb()));
    expect(plan).toMatchObject({ events: [], counters: [] });
  });
});

describe("expectedCounters", () => {
  it("sums by kind, month, day and principal, and keeps the earliest first_at", () => {
    const e = (kind, who, at, photos = 0) => ({ kind, actor: { id: who }, at, weight: 1 + photos, photos });
    const rows = expectedCounters([e("post", "I0001", T2, 2), e("comment", "I0001", T1), e("comment", "I0002", T1)], Date.parse("2026-03-01T00:00:00Z"));
    const r = (pk, sk) => rows.get(`${pk}|${sk}`);
    expect(r("CSTAT#site", "TOTAL")).toMatchObject({ n: 5, n_post: 1, n_comment: 2, n_photo: 2, first_at: T1 });
    expect(r("CSTAT#person:I0001", "TOTAL")).toMatchObject({ n: 4, first_at: T1 });
    expect(r("CSTAT#site", "D#2026-01-20").n).toBe(2);
    expect(r("CSTAT#site", "M#2026-02").n).toBe(3);
  });
});

describe("the command line", () => {
  const node = (args) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
    } catch (e) {
      return { code: e.status, out: `${e.stdout}${e.stderr}` };
    }
  };
  it("needs exactly one of --dry-run and --apply, and says so without touching AWS", () => {
    for (const args of [[], ["--dry-run", "--apply"], ["--apply", "--dry-run"]]) {
      const r = node(args);
      expect(r.code, args.join(" ")).toBe(1);
      expect(r.out).toContain("pass exactly one of --dry-run or --apply");
    }
    expect(node(["--wat"]).out).toContain("unknown argument --wat");
  });
});
