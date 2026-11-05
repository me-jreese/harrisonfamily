// HFY-TSK-194 (surf-onthisday-api): GET /api/onthisday, the OTD#INDEX store with its lazy rebuild under a lease, the interim person-data source,
// the past-year posts tier and the hide routes. Synthetic people, places and posts only (no real names, dates or ids).
import { beforeEach, describe, expect, it } from "vitest";
import { gunzipSync } from "node:zlib";
import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { createFakeDdb, cmds, makeApi, signToken } from "./world.js";
import { TYPE } from "../src/onthisday/build.js";
import { createOnThisDay, parseQuery, hiddenKeys } from "../src/onthisday/service.js";
import { OTD_INDEX_KEYS, POLICY_VERSION, encodeBody } from "../src/onthisday/store.js";
import { archiveView, moderationVisible } from "../src/moderation.js";
import { PAGE_LIMIT, archiveEntry, dayRange, mentionsBirthday, pastYearPosts, safePhotoUrl, ulidCeil, ulidFloor } from "../src/onthisday/posts.js";
import { collectSource, createInterimSource, mapLimit, rowsFromPerson, s3InterimSource } from "../src/onthisday/source.js";
import { buildCaps } from "../src/routes.js";
import { BIRTHDAY_KEYWORDS } from "../src/shared/privacy-guard.mjs";

const T0 = Date.UTC(2027, 9, 13, 12, 0, 0);
const MEMBER = "ITEST1"; // one of the two people of the invented marriage
const STRANGER = "ITEST7";
const ADMIN = "I0099";
const ROW_KEY = `${OTD_INDEX_KEYS.PK}\u0000${OTD_INDEX_KEYS.SK}`;

const person = (n) => ({ grampsId: `ITEST${n}`, displayName: `Test Person ${String.fromCharCode(64 + n)}`, lifeState: "deceased", private: false });
const PEOPLE = [1, 2, 3, 4, 5, 6, 7].map(person);
const ev = (handle, typeCode, year, who, extra = {}) => ({
  handle, typeCode, date: { year, modifier: 0, quality: 0 }, participants: who, place: "", description: "", private: false, ...extra,
});
const MARRIAGE_2007 = ev("m1", TYPE.MARRIAGE, 2007, [{ grampsId: "ITEST1", role: "Groom" }, { grampsId: "ITEST2", role: "Bride" }]);
const DEATH_2002 = ev("d1", TYPE.DEATH, 2002, [{ grampsId: "ITEST3", role: "Primary" }]);
const GRAD_2012 = ev("g1", TYPE.GRADUATION, 2012, [{ grampsId: "ITEST4", role: "Primary" }]);

/** A programmable OnThisDaySource: counts versions and builds, can fail either, and takes a tick to build (so concurrent callers overlap). */
function fakeSource({ events = [MARRIAGE_2007, DEATH_2002, GRAD_2012], persons = PEOPLE, v = "etag-1" } = {}) {
  const s = {
    v, versions: 0, builds: 0, failBuild: false, failVersion: false, events, persons,
    async version() {
      s.versions += 1;
      if (s.failVersion) throw new Error("version down");
      return s.v;
    },
    async snapshot() {
      s.builds += 1;
      await new Promise((r) => setTimeout(r, 15));
      if (s.failBuild) throw new Error("source down");
      return { version: s.v, events: s.events, persons: s.persons };
    },
  };
  return s;
}

const tick = (ms = 3) => new Promise((r) => setTimeout(r, ms));
const noLog = { warn() {}, error() {}, info() {} };

describe("GET /api/onthisday: the route (AC1)", () => {
  let w, member, admin, source, clockNow;
  beforeEach(async () => {
    source = fakeSource();
    clockNow = T0;
    w = makeApi({ admins: [ADMIN], flags: { onThisDay: true }, clock: () => clockNow, extraDeps: { onThisDaySource: source } });
    [member, admin] = await Promise.all([signToken(MEMBER), signToken(ADMIN)]);
  });
  const get = (token, query) => w.call("GET", "/api/onthisday", { token, query, ct: undefined });

  it("returns the section 4.4 shape for a member", async () => {
    const r = await get(member, { date: "2027-10-13", tzOffset: "420" });
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(["date", "indexVersion", "items", "posts", "prompt", "stale", "tier"]);
    expect(r.body).toMatchObject({ date: "2027-10-13", tier: "year", posts: [], stale: false, indexVersion: "etag-1" });
    expect(r.body.items.length).toBeGreaterThan(0);
    for (const it of r.body.items) {
      expect(it).toMatchObject({ id: expect.stringMatching(/^(evt|birth):/), when: "year", n: expect.any(Number), year: expect.any(Number) });
      expect(it.people[0]).toMatchObject({ grampsId: expect.stringMatching(/^ITEST/), name: expect.stringMatching(/^Test Person/) });
      expect(it).not.toHaveProperty("month");
    }
    expect(r.headers["cache-control"]).toBe("no-store");
  });

  it("answers 400 validation for a bad or missing date", async () => {
    for (const date of [undefined, "", "2026-13-01", "2026-02-30", "26-10-13", "2026/10/13", "2026-10-13T00:00", "0999-01-01"]) {
      const r = await get(member, date === undefined ? { tzOffset: "0" } : { date });
      expect(r.status, String(date)).toBe(400);
      expect(r.body.error).toBe("validation");
    }
    expect((await get(member, { date: "2024-02-29" })).status).toBe(200); // a real leap day
  });

  it("answers 400 for a tzOffset outside +-840 minutes or not whole minutes, and takes the limits", async () => {
    for (const tzOffset of ["841", "-841", "9999", "1.5", "abc", "1e2", "+60"]) {
      expect((await get(member, { date: "2026-10-13", tzOffset })).status, tzOffset).toBe(400);
    }
    for (const tzOffset of ["840", "-840", "0", "-0"]) expect((await get(member, { date: "2026-10-13", tzOffset })).status, tzOffset).toBe(200);
    expect((await get(member, { date: "2026-10-13" })).status).toBe(200); // the offset defaults to 0
  });

  it("is 401 signed out and 404 while the onThisDay flag is off (dark to everyone, signed out included)", async () => {
    expect((await get(undefined, { date: "2026-10-13" })).status).toBe(401);
    const dark = makeApi({ flags: { onThisDay: false }, extraDeps: { onThisDaySource: source } });
    expect((await dark.call("GET", "/api/onthisday", { token: member, query: { date: "2026-10-13" }, ct: undefined })).status).toBe(404);
    expect((await dark.call("GET", "/api/onthisday", { query: { date: "2026-10-13" }, ct: undefined })).status).toBe(404);
  });

  it("is registered in caps.json behind onThisDay, with the three route names and no MCP tool", () => {
    const acts = buildCaps().actions.filter((a) => a.name.startsWith("onthisday."));
    expect(acts.map((a) => `${a.name} ${a.method} ${a.path}`).sort()).toEqual([
      "onthisday.get GET /api/onthisday", "onthisday.hide POST /api/onthisday/hide", "onthisday.unhide DELETE /api/onthisday/hide/:itemId",
    ]);
    for (const a of acts) expect(a.gate).toEqual({ feature: "onThisDay" });
    expect(buildCaps().mcp.tools.some((t) => t.action.startsWith("onthisday."))).toBe(false);
    expect(buildCaps().audit.ops).toEqual(expect.arrayContaining(["onthisday.hide", "onthisday.unhide"]));
  });

  it("parseQuery normalises the date and offset", () => {
    expect(parseQuery({ date: "2026-10-13", tzOffset: "-540" })).toEqual({ date: "2026-10-13", today: { y: 2026, mo: 10, d: 13 }, tzOffset: -540 });
    expect(parseQuery({ date: "2026-10-13", tzOffset: "-0" }).tzOffset).toBe(0);
    expect(Object.is(parseQuery({ date: "2026-10-13", tzOffset: "-0" }).tzOffset, 0)).toBe(true);
  });
});

describe("OTD#INDEX: the lazy rebuild under a lease (AC2)", () => {
  let w, member, source, t;
  beforeEach(async () => {
    source = fakeSource();
    t = T0;
    w = makeApi({ flags: { onThisDay: true }, clock: () => t, extraDeps: { onThisDaySource: source } });
    member = await signToken(MEMBER);
  });
  const get = (query = { date: "2026-10-13" }) => w.call("GET", "/api/onthisday", { token: member, query, ct: undefined });
  const row = () => w.ddb.rows.get(ROW_KEY);

  it("stores the index as a gzip body with the schema fields and no report", async () => {
    expect((await get()).status).toBe(200);
    const r = row();
    expect(r).toMatchObject({ PK: "OTD#INDEX", SK: "V1", schema: "hfy.onthisday.v1", sourceVersion: "etag-1", policyVersion: POLICY_VERSION });
    expect(typeof r.generatedAt).toBe("string");
    expect(r).not.toHaveProperty("buildingUntil"); // the put ends the lease
    const body = JSON.parse(gunzipSync(Buffer.from(r.body)).toString("utf8"));
    expect(body).toMatchObject({ schema: "hfy.onthisday.v1", sourceVersion: "etag-1", policyVersion: POLICY_VERSION });
    expect(body).not.toHaveProperty("report");
    expect(r.size).toBe(Buffer.from(r.body).length);
  });

  it("builds exactly once for concurrent requests of one container", async () => {
    const rs = await Promise.all(Array.from({ length: 8 }, () => get()));
    expect(rs.map((r) => r.status)).toEqual(Array(8).fill(200));
    expect(source.builds).toBe(1);
    expect(rs.every((r) => r.body.stale === false)).toBe(true);
  });

  it("builds exactly once across containers (separate services, one table): the lease has one winner", async () => {
    const ddb = createFakeDdb();
    const src = fakeSource();
    const actor = { id: MEMBER, admin: false };
    const services = Array.from({ length: 6 }, () => createOnThisDay({
      ddb, cmds, table: "hfy-app", actor, now: () => T0, uid: () => "u", source: src, cache: {}, log: noLog, sleep: () => tick(10), leaseWaits: 20,
    }));
    const rs = await Promise.all(services.map((s) => s.get({ date: "2026-10-13" })));
    expect(src.builds).toBe(1);
    expect(rs.every((r) => r.indexVersion === "etag-1")).toBe(true);
    expect(rs.filter((r) => r.stale).length).toBe(0);
    expect(ddb.calls.filter((c) => c === "UpdateCommand").length).toBe(6); // every caller tried the lease; one won
    expect(ddb.rows.get(ROW_KEY).buildingUntil).toBeUndefined();
  });

  it("does not rebuild while the source version is unchanged, and rebuilds when it changes", async () => {
    await get();
    t += 6 * 60_000; // past the 5 minute in-memory copy
    await get();
    expect(source.builds).toBe(1);
    expect(source.versions).toBe(2); // the version is checked on a miss
    source.v = "etag-2";
    t += 6 * 60_000;
    const r = await get();
    expect(source.builds).toBe(2);
    expect(r.body).toMatchObject({ stale: false, indexVersion: "etag-2" });
    expect(row().sourceVersion).toBe("etag-2");
  });

  it("serves the parsed copy for 5 minutes without reading the table or the source", async () => {
    await get();
    const reads = w.ddb.calls.filter((c) => c === "GetCommand").length;
    const versions = source.versions;
    t += 4 * 60_000;
    await get();
    expect(source.versions).toBe(versions);
    expect(w.ddb.calls.filter((c) => c === "GetCommand").length).toBe(reads + 1); // only the hidden list
  });

  it("a failed rebuild serves the stale body with stale:true", async () => {
    await get();
    source.v = "etag-2";
    source.failBuild = true;
    t += 6 * 60_000;
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ stale: true, indexVersion: "etag-1" });
    expect(row().sourceVersion).toBe("etag-1"); // the stale body stays
    expect(row().buildingUntil).toBeGreaterThan(t); // the lease runs out on its own (the back-off)
    const again = await get(); // still within the lease: the loser serves stale without building
    expect(again.body.stale).toBe(true);
    expect(source.builds).toBe(2);
  });

  it("an unreadable source version serves the stale body (stale:true) and does not build", async () => {
    await get();
    source.failVersion = true;
    t += 6 * 60_000;
    const r = await get();
    expect(r.body).toMatchObject({ stale: true, indexVersion: "etag-1" });
    expect(source.builds).toBe(1);
  });

  it("with no body and a failed build the answer is 503 unavailable", async () => {
    source.failBuild = true;
    const r = await get();
    expect(r.status).toBe(503);
    expect(r.body.error).toBe("unavailable");
    expect(JSON.stringify(r.body)).not.toMatch(/source down/);
    source.failBuild = false;
    t += 61_000; // the lease of the failed build has run out
    expect((await get()).status).toBe(200);
  });

  it("with no body and no source at all the answer is 503", async () => {
    const bare = makeApi({ flags: { onThisDay: true }, clock: () => T0 });
    expect((await bare.call("GET", "/api/onthisday", { token: member, query: { date: "2026-10-13" }, ct: undefined })).status).toBe(503);
  });

  it("a lease loser with no body waits and reads again; with none after the waits it is 503", async () => {
    const ddb = createFakeDdb();
    const src = fakeSource();
    ddb.rows.set(ROW_KEY, { ...OTD_INDEX_KEYS, buildingUntil: T0 + 30_000 });
    const waits = [];
    const actor = { id: MEMBER };
    const svc = createOnThisDay({ ddb, cmds, table: "hfy-app", actor, now: () => T0, uid: () => "u", source: src, cache: {}, log: noLog, leaseWaits: 3, sleep: async (ms) => { waits.push(ms); } });
    await expect(svc.get({ date: "2026-10-13" })).rejects.toMatchObject({ status: 503 });
    expect(waits).toEqual([1000, 1000, 1000]);
    expect(src.builds).toBe(0);
    // the holder stores its body while we wait: the loser serves it
    let n = 0;
    const svc2 = createOnThisDay({
      ddb, cmds, table: "hfy-app", actor, now: () => T0, uid: () => "u", source: src, cache: {}, log: noLog, leaseWaits: 3,
      sleep: async () => {
        n += 1;
        if (n === 2) ddb.rows.set(ROW_KEY, { ...OTD_INDEX_KEYS, entity: "otd-index", schema: "hfy.onthisday.v1", sourceVersion: "etag-1", policyVersion: POLICY_VERSION, generatedAt: "x", body: encodeBody({ schema: "hfy.onthisday.v1", sourceVersion: "etag-1", policyVersion: POLICY_VERSION, day: {}, month: {}, year: [] }) });
      },
    });
    const r = await svc2.get({ date: "2026-10-13" });
    expect(r.indexVersion).toBe("etag-1");
    expect(n).toBe(2);
  });

  it("never serves a stored index built under another policy version", async () => {
    await get();
    ddb_setPolicy(w, "r19-0");
    source.failBuild = true;
    t += 6 * 60_000;
    expect((await get()).status).toBe(503); // not even stale
  });

  it("a damaged body is treated as no body", async () => {
    await get();
    w.ddb.rows.set(ROW_KEY, { ...row(), body: Buffer.from("not gzip") });
    t += 6 * 60_000;
    const r = await get();
    expect(r.status).toBe(200);
    expect(source.builds).toBe(2);
  });
});
function ddb_setPolicy(w, policy) {
  w.ddb.rows.set(ROW_KEY, { ...w.ddb.rows.get(ROW_KEY), policyVersion: policy });
}

describe("the interim source over person/index.json and person/<id>.json (AC3)", () => {
  const personJson = (n, extra = {}) => ({
    grampsId: `ITEST${n}`, displayName: `Test Person ${String.fromCharCode(64 + n)}`, isLiving: false, events: [], familyTree: { parentFamilies: [], spouseFamilies: [] }, ...extra,
  });
  const evJson = (handle, code, year, extra = {}) => ({ handle, label: "x", type: { string: "x", code }, date: { text: String(year), year }, place: null, description: null, ...extra });
  const world = (people, { etag = '"idx-1"', delay = 0 } = {}) => {
    const stats = { reads: 0, live: 0, max: 0, heads: 0, indexReads: 0 };
    const rows = Object.keys(people).map((id) => ({ grampsId: id, displayName: people[id]?.displayName, isLiving: people[id]?.isLiving }));
    return {
      stats, etag: { v: etag },
      source: createInterimSource({
        log: noLog,
        head: async () => { stats.heads += 1; return stats.etag ?? "x"; },
        readIndex: async () => { stats.indexReads += 1; return { version: stats.etag ?? etag, json: { count: rows.length, people: rows } }; },
        readPerson: async (id) => {
          stats.reads += 1;
          stats.live += 1;
          stats.max = Math.max(stats.max, stats.live);
          await tick(delay);
          stats.live -= 1;
          return people[id] ?? null;
        },
      }),
    };
  };

  it("reads people 16 at a time, and its version is the ETag of person/index.json", async () => {
    const people = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`ITEST${i + 100}`, personJson(i + 1, { grampsId: `ITEST${i + 100}` })]));
    const w = world(people, { etag: '"abc"', delay: 4 });
    w.stats.etag = '"abc"';
    expect(await w.source.version()).toBe('"abc"');
    expect(w.stats.heads).toBe(1);
    const snap = await collectSource(w.source);
    expect(snap.version).toBe('"abc"');
    expect(snap.persons).toHaveLength(50);
    expect(w.stats.reads).toBe(50);
    expect(w.stats.max).toBe(16);
  });

  it("mapLimit keeps order and bounds concurrency", async () => {
    let live = 0;
    let max = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (x) => { live += 1; max = Math.max(max, live); await tick(2); live -= 1; return x * 2; });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(max).toBe(3);
  });

  it("gives the year tier from the D-02 event types, joining a marriage from both spouses' family blocks", async () => {
    const fam = (events) => ({ familyTree: { parentFamilies: [], spouseFamilies: [{ handle: "f1", father: { grampsId: "ITEST1" }, mother: { grampsId: "ITEST2" }, events }] } });
    const marriage = evJson("m1", 1, 2007, { role: { string: "Family", code: 4 } });
    const people = {
      ITEST1: personJson(1, { isLiving: true, ...fam([marriage]), events: [evJson("b1", 12, 1980)] }),
      ITEST2: personJson(2, { ...fam([marriage]) }),
      ITEST3: personJson(3, { events: [evJson("d1", 13, 2002, { place: { displayName: "Testville" }, description: "after a long illness" }), evJson("g1", 31, 2012)] }),
    };
    const { source } = world(people);
    const snap = await collectSource(source);
    const byHandle = Object.fromEntries(snap.events.map((e) => [e.handle, e]));
    expect(Object.keys(byHandle).sort()).toEqual(["b1", "d1", "g1", "m1"]);
    expect(byHandle.m1.participants.map((p) => `${p.grampsId}:${p.role}`).sort()).toEqual(["ITEST1:groom", "ITEST2:bride"]);
    expect(byHandle.d1).toMatchObject({ typeCode: 13, place: "Testville", description: "after a long illness", private: false, date: { year: 2002, modifier: 0, quality: 0 } });
    expect(snap.persons.find((p) => p.grampsId === "ITEST1").lifeState).toBe("living");
    expect(snap.persons.find((p) => p.grampsId === "ITEST2").lifeState).toBe("deceased");
    for (const e of snap.events) expect(e.date).not.toHaveProperty("month"), expect(e.date).not.toHaveProperty("day");
    // through the real builder: the year tier, no day anywhere
    const svc = createOnThisDay({ ddb: createFakeDdb(), cmds, table: "hfy-app", actor: { id: MEMBER }, now: () => T0, uid: () => "u", source, cache: {}, log: noLog });
    const r = await svc.get({ date: "2027-10-13" });
    expect(r.tier).toBe("year");
    const ids = r.items.map((i) => i.id);
    expect(ids.every((id) => ["evt:m1", "evt:d1", "evt:g1", "birth:ITEST1"].includes(id))).toBe(true);
  });

  it("skips inexact dates, an event two people list, a missing person file, and private-by-absence spouses", async () => {
    const people = {
      ITEST1: personJson(1, { events: [evJson("x1", 13, 2000, { date: { text: "about 2000", year: 2000 } }), evJson("s1", 42, 1990), evJson("ok", 13, 1999, { date: { text: "", year: 1999 } })] }),
      ITEST2: personJson(2, { events: [evJson("s1", 42, 1990)] }),
      ITEST3: personJson(3, { familyTree: { parentFamilies: [], spouseFamilies: [{ handle: "f", father: { grampsId: "ITEST3" }, mother: null, events: [evJson("m9", 1, 2001)] }] } }),
    };
    const world2 = world({ ...people, ITEST9: undefined });
    const snap = await collectSource(world2.source);
    expect(snap.persons.map((p) => p.grampsId).sort()).toEqual(["ITEST1", "ITEST2", "ITEST3"]); // ITEST9 has no file
    const by = Object.fromEntries(snap.events.map((e) => [e.handle, e]));
    expect(by.x1.date.modifier).toBe(1); // "about": the builder skips it
    expect(by.ok.date.modifier).toBe(0); // a blank text is a date whose day and month were dropped, still exact to the year
    expect(by).not.toHaveProperty("s1"); // listed by two people
    expect(by.m9.participants).toEqual([{ grampsId: "ITEST3", role: "groom" }]); // a short pair, which the builder skips
  });

  it("a failed person read (not an absent file) fails the whole read", async () => {
    const source = createInterimSource({
      log: noLog, head: async () => "e", readIndex: async () => ({ version: "e", json: { people: [{ grampsId: "ITEST1" }, { grampsId: "ITEST2" }] } }),
      readPerson: async (id) => { if (id === "ITEST2") throw Object.assign(new Error("slow down"), { name: "SlowDown", $metadata: { httpStatusCode: 503 } }); return personJson(1); },
    });
    await expect(collectSource(source)).rejects.toThrow(/slow down/);
  });

  it("an S3 403 or 404 for one person file is an absent file", async () => {
    const source = createInterimSource({
      log: noLog, head: async () => "e", readIndex: async () => ({ version: "e", json: { people: [{ grampsId: "ITEST1" }, { grampsId: "ITEST2" }, { grampsId: "../x" }] } }),
      readPerson: async (id) => { if (id === "ITEST2") throw Object.assign(new Error("denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } }); return personJson(1); },
    });
    expect((await collectSource(source)).persons.map((p) => p.grampsId)).toEqual(["ITEST1"]);
  });

  it("events() and persons() give the same rows as snapshot()", async () => {
    const { source } = world({ ITEST1: personJson(1, { events: [evJson("d1", 13, 2002)] }) });
    const ev1 = [];
    for await (const e of source.events()) ev1.push(e.handle);
    const ps = [];
    for await (const p of source.persons()) ps.push(p.grampsId);
    expect(ev1).toEqual(["d1"]);
    expect(ps).toEqual(["ITEST1"]);
  });

  it("s3InterimSource heads and reads person/index.json and person/<id>.json in the media bucket", async () => {
    const files = new Map([
      ["person/index.json", { etag: '"e1"', json: { people: [{ grampsId: "ITEST1", displayName: "Test Person A", isLiving: false }] } }],
      ["person/ITEST1.json", { etag: '"p1"', json: personJson(1, { events: [evJson("d1", 13, 2002)] }) }],
    ]);
    const seen = [];
    const s3 = {
      async send(cmd) {
        seen.push(`${cmd.constructor.name} ${cmd.input.Bucket}/${cmd.input.Key}`);
        const f = files.get(cmd.input.Key);
        if (!f) throw Object.assign(new Error("denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } });
        return cmd.constructor.name === "HeadObjectCommand" ? { ETag: f.etag } : { ETag: f.etag, Body: { transformToString: async () => JSON.stringify(f.json) } };
      },
    };
    const source = s3InterimSource({ s3, cmds: { GetObjectCommand, HeadObjectCommand }, bucket: "site-bucket", log: noLog });
    expect(await source.version()).toBe('"e1"');
    const snap = await collectSource(source);
    expect(snap.version).toBe('"e1"');
    expect(snap.events.map((e) => e.handle)).toEqual(["d1"]);
    expect(seen).toEqual([
      "HeadObjectCommand site-bucket/person/index.json", "GetObjectCommand site-bucket/person/index.json", "GetObjectCommand site-bucket/person/ITEST1.json",
    ]);
  });

  it("rowsFromPerson refuses ids that are not gramps ids", () => {
    expect(rowsFromPerson({ grampsId: "../etc", displayName: "x" })).toBeNull();
    expect(rowsFromPerson({ grampsId: "ITEST1", displayName: "  " })).toBeNull();
  });
});

// ---- past-year posts ------------------------------------------------------------------------------------------------------------------------------
const ulidAt = (ms, tail = "ABCDEFGH12345678") => ulidFloor(ms).slice(0, 10) + tail;
const postRow = (id, post) => ({ PK: `POST#${id}`, SK: "META", GSI1PK: "POSTS", GSI1SK: id, entity: "post", post: { id, type: "post", visibility: "published", title: "", body: "", attachments: [], author: { id: "ITEST5", label: "Test Person E" }, ...post } });
const photo = (n, extra = {}) => ({ kind: "image", url: `/uploads/posts/01J00000000000000000000000/p${n}.jpg`, mime: "image/jpeg", alt: `alt ${n}`, ...extra });
const at = (y, mo, d, h = 12) => Date.UTC(y, mo - 1, d, h);

describe("past-year posts (AC4)", () => {
  let ddb;
  const put = (row) => ddb.send(new cmds.PutCommand({ TableName: "hfy-app", Item: row }));
  const addPost = async (ms, post = {}, tail) => { const id = ulidAt(ms, tail); await put(postRow(id, post)); return id; };
  const find = (viewer, extra = {}) => pastYearPosts({ ddb, cmds, table: "hfy-app", viewer, today: { y: 2027, mo: 10, d: 13 }, tzOffset: 0, ...extra });
  beforeEach(() => { ddb = createFakeDdb(); });

  it("ulidFloor and ulidCeil bound a millisecond, and dayRange follows tzOffset", () => {
    const ms = at(2026, 10, 13);
    expect(ulidFloor(ms) < ulidAt(ms) && ulidAt(ms) < ulidCeil(ms)).toBe(true);
    expect(ulidCeil(ms) < ulidFloor(ms + 1)).toBe(true);
    expect(dayRange(2026, 10, 13, 0)).toEqual({ start: Date.UTC(2026, 9, 13), end: Date.UTC(2026, 9, 14) - 1 });
    expect(dayRange(2026, 10, 13, 420).start).toBe(Date.UTC(2026, 9, 13, 7)); // UTC-7: local midnight is 07:00Z
    expect(dayRange(2026, 10, 13, -540).start).toBe(Date.UTC(2026, 9, 12, 15)); // UTC+9
    expect(dayRange(2026, 2, 29, 0)).toBeNull();
    expect(dayRange(2024, 2, 29, 0)).not.toBeNull();
  });

  it("runs one GSI1 range Query per past year back to 2025 and keeps only that local day", async () => {
    const a = await addPost(at(2025, 10, 13), { body: "one year ago? no, two" });
    const b = await addPost(at(2026, 10, 13, 23), { body: "last year" });
    await addPost(at(2026, 10, 12, 23), { body: "the day before" });
    await addPost(at(2026, 10, 14, 0), { body: "the day after" });
    await addPost(at(2024, 10, 13), { body: "before the site had posts" });
    const out = await find({ id: "ITEST1" });
    expect(out.map((p) => [p.id, p.n])).toEqual([[b, 1], [a, 2]]);
    const queries = ddb.calls.filter((c) => c === "QueryCommand");
    expect(queries).toHaveLength(2); // 2026 and 2025
  });

  it("a viewer's local day decides the range", async () => {
    const id = await addPost(Date.UTC(2026, 9, 13, 3), { body: "evening before, local time" }); // 20:00 on Oct 12 at UTC-7
    expect((await find({ id: "ITEST1" }, { tzOffset: 0 })).map((p) => p.id)).toEqual([id]);
    expect(await find({ id: "ITEST1" }, { tzOffset: 420 })).toEqual([]);
  });

  it("skips February 29 in a year that has none", async () => {
    await addPost(at(2028, 2, 29), { body: "leap day" });
    await addPost(at(2028, 2, 28), { body: "the day before" });
    const out = await pastYearPosts({ ddb, cmds, table: "hfy-app", viewer: { id: "ITEST1" }, today: { y: 2032, mo: 2, d: 29 }, tzOffset: 0 });
    expect(out.map((p) => [p.n, p.excerpt])).toEqual([[4, "leap day"]]);
    expect(ddb.calls.filter((c) => c === "QueryCommand")).toHaveLength(1); // 2031 down to 2025 has one leap year, 2028
  });

  it("excludes drafts and withdrawn posts", async () => {
    await addPost(at(2026, 10, 13), { body: "draft", visibility: "draft" }, "DRAFT00000000001");
    await addPost(at(2026, 10, 13), { body: "withdrawn", visibility: "withdrawn" }, "WITHDRAWN0000001");
    const ok = await addPost(at(2026, 10, 13), { body: "published" }, "PUBLISHED0000001");
    expect((await find({ id: "ITEST1" })).map((p) => p.id)).toEqual([ok]);
    // not even the author or an admin sees a draft in the archive
    expect((await find({ id: "ITEST5", admin: true })).map((p) => p.id)).toEqual([ok]);
  });

  it("applies the shared archiveView (HFY-TSK-258): a moderated-hidden post reaches only its author and admins", async () => {
    const hid = await addPost(at(2026, 10, 13), { body: "hidden by a moderator", moderation: { hidden: true, by: "I0099" } }, "HIDDEN0000000001");
    const ok = await addPost(at(2026, 10, 13), { body: "fine" }, "FINE000000000001");
    expect((await find({ id: "ITEST1" })).map((p) => p.id)).toEqual([ok]);
    expect((await find({ id: "ITEST5" })).map((p) => p.id).sort()).toEqual([hid, ok].sort()); // its author
    expect((await find({ id: "I0099", admin: true })).map((p) => p.id).sort()).toEqual([hid, ok].sort());
    expect(moderationVisible({ author: { id: "a" }, moderation: { hidden: true } }, { id: "b" })).toBe(false);
    expect(moderationVisible({ author: { id: "a" } }, { id: "b" })).toBe(true);
    // the archive filter is 258's archiveView: a hidden post is null for a stranger, and its moderation fields are dropped for nobody but the author and admins
    const stored = { id: "P", visibility: "published", author: { id: "a" }, body: "x", moderation: { hidden: true } };
    expect(archiveView(stored, { id: "b" })).toBeNull();
    expect(archiveView(stored, { id: "a" })).not.toBeNull();
    expect(archiveView(stored, { id: "z", admin: true })).not.toBeNull();
  });

  it("strips attachments with moderation.hidden; a photo-only post whose photos are all hidden is skipped", async () => {
    const two = await addPost(at(2026, 10, 13), { body: "two photos", attachments: [photo(1, { moderation: { hidden: true } }), photo(2)] }, "TWOPHOTOS0000001");
    const allHidden = await addPost(at(2026, 10, 13), { body: "text stays", attachments: [photo(3, { moderation: { hidden: true } })] }, "ALLHIDDEN0000001");
    const onlyPhotos = await addPost(at(2026, 10, 13), { body: "", attachments: [photo(4, { moderation: { hidden: true } })] }, "ONLYPHOTOS000001");
    const out = await find({ id: "ITEST1" });
    const byId = Object.fromEntries(out.map((p) => [p.id, p]));
    expect(byId[two].photo).toEqual({ url: photo(2).url, alt: "alt 2" });
    expect(byId[allHidden]).toMatchObject({ excerpt: "text stays" });
    expect(byId[allHidden]).not.toHaveProperty("photo");
    expect(byId).not.toHaveProperty(onlyPhotos);
    expect(JSON.stringify(out)).not.toContain("moderation");
  });

  it("skips posts that name a birthday (the BIRTHDAY_KEYWORDS set), in the title, body or a photo's alt text", async () => {
    const texts = [
      { body: "Happy birthday to Test Person E!" }, { body: "party time, HBD" }, { body: "Bday cake" }, { body: "her b-day" }, { body: "on her date of birth" },
      { body: "born in the spring" }, { title: "Birthday", body: "x" }, { body: "see photo", attachments: [photo(1, { alt: "the birthday table" })] }, { body: "D.O.B. unknown" },
    ];
    let k = 0;
    for (const t of texts) await addPost(at(2026, 10, 13), t, `BIRTH${String(k++).padStart(11, "0")}`);
    const ok = await addPost(at(2026, 10, 13), { body: "Sunday dinner with the cousins, borne along by the crowd" }, "DINNER0000000001");
    expect((await find({ id: "ITEST1" })).map((p) => p.id)).toEqual([ok]);
  });

  it("mentionsBirthday covers every keyword as a whole word and ignores near misses", () => {
    for (const k of BIRTHDAY_KEYWORDS) expect(mentionsBirthday(`so ${k} again`), k).toBe(true);
    expect(mentionsBirthday("BIRTHDAY")).toBe(true);
    expect(mentionsBirthday("b’day")).toBe(true);
    expect(mentionsBirthday("date   of\tbirth")).toBe(true);
    for (const t of ["", "unborn", "borne", "birthright", "doberman", "a lovely day", undefined, 5]) expect(mentionsBirthday(t), String(t)).toBe(false);
  });

  it("serves a photo url only as https or a root-relative /uploads/ path", async () => {
    for (const ok of ["/uploads/posts/01J00000000000000000000000/p1.jpg", "https://media.example.test/uploads/posts/x/p1.jpg"]) expect(safePhotoUrl(ok), ok).toBe(ok);
    for (const bad of ["javascript:alert(1)", "data:image/png;base64,AAAA", "http://media.example.test/p.jpg", "//media.example.test/p.jpg", "/other/p.jpg", "/uploads/../x.jpg", "/uploads/a b.jpg", "https://", "https://a.test/a b", "", null, 5]) {
      expect(safePhotoUrl(bad), String(bad)).toBeNull();
    }
    const bad = await addPost(at(2026, 10, 13), { body: "odd photo", attachments: [photo(1, { url: "javascript:alert(1)" }), photo(2)] }, "BADURLFIRST00001");
    const only = await addPost(at(2026, 10, 13), { body: "", attachments: [photo(3, { url: "data:image/png;base64,AAAA" })] }, "BADURLONLY000001");
    const byId = Object.fromEntries((await find({ id: "ITEST1" })).map((p) => [p.id, p]));
    expect(byId[bad].photo).toEqual({ url: photo(2).url, alt: "alt 2" }); // the unsafe photo is passed over for the next one
    expect(byId).not.toHaveProperty(only); // no text and no safe photo: nothing to show
  });

  it("queries each year newest first, so a page that is cut keeps the newest posts of the day", async () => {
    const ids = [];
    for (let i = 0; i < PAGE_LIMIT + 5; i += 1) ids.push(await addPost(at(2026, 10, 13, 0) + i * 60_000, { body: `post ${i}` }, `P${String(i).padStart(15, "0")}`));
    const out = await find({ id: "ITEST1" });
    expect(out).toHaveLength(PAGE_LIMIT);
    expect(out[0].id).toBe(ids.at(-1)); // the newest
    expect(out.map((p) => p.id)).not.toContain(ids[0]); // the oldest are the ones dropped
    expect(ddb.calls.filter((c) => c === "QueryCommand")).toHaveLength(2);
  });

  it("skips ids on the hidden list, and a post with no text and no photo", async () => {
    const a = await addPost(at(2026, 10, 13), { body: "one" }, "ONE0000000000001");
    const b = await addPost(at(2026, 10, 13), { body: "two" }, "TWO0000000000001");
    await addPost(at(2026, 10, 13), { body: "   " }, "BLANK00000000001");
    expect((await find({ id: "ITEST1" }, { hidden: new Set([a]) })).map((p) => p.id)).toEqual([b]);
  });

  it("serves text only: control characters are folded, the excerpt is bounded and the author is a label", async () => {
    const id = await addPost(at(2026, 10, 13), { body: `<img src=x onerror=alert(1)>\u0007\n${"word ".repeat(80)}` }, "LONG000000000001");
    const [p] = await find({ id: "ITEST1" });
    expect(p.id).toBe(id);
    expect(p.excerpt.length).toBeLessThanOrEqual(141);
    expect(p.excerpt.endsWith("…")).toBe(true);
    expect(p.excerpt).not.toMatch(/[\u0000-\u001f]/);
    expect(p.author).toEqual({ id: "ITEST5", label: "Test Person E" });
    expect(Object.keys(p).sort()).toEqual(["author", "excerpt", "id", "n"]);
  });

  it("archiveEntry refuses a malformed item", () => {
    expect(archiveEntry(null, { id: "a" }, { n: 1, hidden: new Set() })).toBeNull();
    expect(archiveEntry({ post: { id: "x" } }, { id: "a" }, { n: 1, hidden: new Set() })).toBeNull();
  });

  describe("through GET /api/onthisday", () => {
    it("fills the archive tier when there are no index items, and the selector's post shape", async () => {
      const w = makeApi({ flags: { onThisDay: true }, clock: () => T0, extraDeps: { onThisDaySource: fakeSource({ events: [], persons: [] }) } });
      const id = await addPostTo(w, at(2026, 10, 13), { body: "last year's dinner", attachments: [photo(1)] });
      const member = await signToken(MEMBER);
      const r = await w.call("GET", "/api/onthisday", { token: member, query: { date: "2027-10-13" }, ct: undefined });
      expect(r.status).toBe(200);
      expect(r.body.tier).toBe("archive");
      expect(r.body.items).toEqual([]);
      expect(r.body.posts).toEqual([{ id, n: 1, author: { id: "ITEST5", label: "Test Person E" }, excerpt: "last year's dinner", photo: { url: photo(1).url, alt: "alt 1" } }]);
    });
  });
});
async function addPostTo(w, ms, post) {
  const id = ulidAt(ms);
  await w.ddb.send(new cmds.PutCommand({ TableName: "hfy-app", Item: postRow(id, post) }));
  return id;
}

// ---- hide and unhide -------------------------------------------------------------------------------------------------------------------------
describe("POST /api/onthisday/hide and DELETE /api/onthisday/hide/:itemId (AC5)", () => {
  let w, member, stranger, admin, source;
  const ITEM = "evt:m1"; // the invented marriage of ITEST1 and ITEST2
  const hide = (token, itemId) => w.call("POST", "/api/onthisday/hide", { token, body: itemId === undefined ? {} : { itemId } });
  const unhide = (token, itemId) => w.call("DELETE", `/api/onthisday/hide/${encodeURIComponent(itemId)}`, { token, ct: undefined });
  const get = (token) => w.call("GET", "/api/onthisday", { token, query: { date: "2027-10-13" }, ct: undefined });
  const audits = () => w.ddb.all().filter((x) => x.PK.startsWith("AUDIT#otd:"));
  const hiddenIds = () => w.ddb.rows.get(`${hiddenKeys.PK}\u0000${hiddenKeys.SK}`)?.ids;
  beforeEach(async () => {
    source = fakeSource({ events: [MARRIAGE_2007, ev("m2", TYPE.MARRIAGE, 2002, [{ grampsId: "ITEST3", role: "Groom" }, { grampsId: "ITEST4", role: "Bride" }])] });
    w = makeApi({ admins: [ADMIN], flags: { onThisDay: true }, clock: () => T0, extraDeps: { onThisDaySource: source } });
    [member, stranger, admin] = await Promise.all([signToken(MEMBER), signToken(STRANGER), signToken(ADMIN)]);
  });

  it("a member who is one of the item's people hides it: 204, the item list shrinks and one audit item is written", async () => {
    expect((await hide(member, ITEM)).status).toBe(204);
    expect(hiddenIds()).toEqual([ITEM]);
    const [a] = audits();
    expect(audits()).toHaveLength(1);
    expect(a).toMatchObject({ PK: `AUDIT#otd:${ITEM}`, op: "onthisday.hide", id: `otd:${ITEM}`, principal: MEMBER, before: { hidden: false }, after: { hidden: true } });
    expect(JSON.stringify(a)).not.toMatch(/Test Person/); // ids only, no names
    const r = await get(member);
    expect(r.body.items.map((i) => i.id)).not.toContain(ITEM);
  });

  it("an admin may hide any item; anyone else is 403, whether or not the item exists", async () => {
    expect((await hide(stranger, ITEM)).status).toBe(403);
    expect((await hide(stranger, "evt:nope")).status).toBe(403);
    expect(hiddenIds()).toBeUndefined();
    expect(audits()).toHaveLength(0);
    expect((await hide(admin, ITEM)).status).toBe(204);
    expect(audits()[0].principal).toBe(ADMIN);
  });

  it("an admin hiding an unknown item is 404; a malformed id is 400; an empty body is 400", async () => {
    expect((await hide(admin, "evt:nope")).status).toBe(404);
    for (const id of ["nope", "evt:", "evt:a b", "x:y", "evt:" + "a".repeat(65), 5, undefined]) expect((await hide(admin, id)).status, String(id)).toBe(400);
    expect(hiddenIds()).toBeUndefined();
  });

  it("is 401 signed out and dark (404) while the flag is off", async () => {
    expect((await w.call("POST", "/api/onthisday/hide", { body: { itemId: ITEM } })).status).toBe(401);
    const dark = makeApi({ flags: { onThisDay: false }, extraDeps: { onThisDaySource: source } });
    expect((await dark.call("POST", "/api/onthisday/hide", { token: member, body: { itemId: ITEM } })).status).toBe(404);
    expect((await dark.call("DELETE", `/api/onthisday/hide/${ITEM}`, { token: member, ct: undefined })).status).toBe(404);
  });

  it("hiding twice writes and audits once", async () => {
    await hide(member, ITEM);
    expect((await hide(admin, ITEM)).status).toBe(204);
    expect(audits()).toHaveLength(1);
    expect(hiddenIds()).toEqual([ITEM]);
  });

  it("DELETE shows it again under the same rule, audited as onthisday.unhide, and is idempotent", async () => {
    await hide(admin, ITEM);
    expect((await unhide(stranger, ITEM)).status).toBe(403);
    expect(hiddenIds()).toEqual([ITEM]);
    expect((await unhide(member, ITEM)).status).toBe(204);
    expect(hiddenIds()).toEqual([]);
    expect(audits().map((a) => a.op).sort()).toEqual(["onthisday.hide", "onthisday.unhide"]);
    expect(audits().find((a) => a.op === "onthisday.unhide")).toMatchObject({ principal: MEMBER, before: { hidden: true }, after: { hidden: false } });
    expect((await unhide(member, ITEM)).status).toBe(204); // already shown: nothing written
    expect(audits()).toHaveLength(2);
    expect((await unhide(admin, "evt:never-hidden")).status).toBe(204);
    expect((await unhide(member, "bad id")).status).toBe(400);
  });

  it("an id that has left the index: an admin can still clear it, a member cannot (hide is 404 for an admin, 403 for a member)", async () => {
    let t = T0;
    const own = makeApi({ admins: [ADMIN], flags: { onThisDay: true }, clock: () => t, extraDeps: { onThisDaySource: source } });
    const del = (token) => own.call("DELETE", `/api/onthisday/hide/${ITEM}`, { token, ct: undefined });
    expect((await own.call("POST", "/api/onthisday/hide", { token: admin, body: { itemId: ITEM } })).status).toBe(204);
    // the source loses the event (a changed source or a policy rebuild) and the parsed copy ages out: the id stays on the hidden list
    source.events = [];
    source.v = "etag-2";
    t += 6 * 60_000;
    const hiddenOf = () => own.ddb.rows.get(`${hiddenKeys.PK}\u0000${hiddenKeys.SK}`)?.ids;
    expect((await del(member)).status).toBe(403);
    expect((await del(stranger)).status).toBe(403);
    expect(hiddenOf()).toEqual([ITEM]);
    expect((await del(admin)).status).toBe(204);
    expect(hiddenOf()).toEqual([]);
    expect((await own.call("POST", "/api/onthisday/hide", { token: admin, body: { itemId: ITEM } })).status).toBe(404);
  });

  it("the list and the audit item are written in one transaction", async () => {
    await hide(member, ITEM);
    expect(w.ddb.calls.filter((c) => c === "TransactWriteCommand")).toHaveLength(1);
  });

  it("a concurrent change of the list is read again, not lost", async () => {
    await hide(admin, "evt:m2");
    const rs = await Promise.all([hide(member, ITEM), hide(admin, "evt:m2"), unhide(admin, "evt:m2")]);
    expect(rs.map((r) => r.status)).toEqual([204, 204, 204]);
    expect(hiddenIds()).toContain(ITEM);
  });
});
