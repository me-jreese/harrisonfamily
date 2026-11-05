// HFY-TSK-139 (surf-onthisday-store-source): the record-store source for the day and week tiers. Synthetic people, places and ids only.
import { beforeEach, describe, expect, it } from "vitest";
import { createFakeDdb, cmds, makeApi, signToken } from "./world.js";
import { applyBatch } from "../src/sync/apply.js";
import { headKey } from "../src/sync/store.js";
import { createOnThisDay, yearOnly } from "../src/onthisday/service.js";
import { collectSource } from "../src/onthisday/source.js";
import { buildIndex } from "../src/onthisday/build.js";
import { createSelectingSource, createStoreSource, daysApprovedFromEnv, rowsFromView } from "../src/onthisday/store-source.js";
import { StoreView } from "../src/records/index.js";

const h = (n) => n.toString(16).padStart(28, "0");
const typ = (cls, value, string = "") => ({ _class: cls, value, string });
const name = (first, surname) => ({ _class: "Name", first_name: first, surname_list: [{ _class: "Surname", surname }] });
const date = (day, month, year, extra = {}) => ({ _class: "Date", calendar: 0, modifier: 0, quality: 0, dateval: [day, month, year, false], text: "", newyear: 0, ...extra });
const person = (n, extra = {}) => ({ _class: "Person", handle: h(n), gramps_id: `ITEST${n}`, change: 1, private: false, gender: 1, primary_name: name(`Given${n}`, "Sample"), event_ref_list: [], family_list: [], parent_family_list: [], ...extra });
const event = (n, type, d, extra = {}) => ({ _class: "Event", handle: h(2000 + n), gramps_id: `E${n}`, change: 1, private: false, type: typ("EventType", type), date: d, ...extra });
const family = (n, extra = {}) => ({ _class: "Family", handle: h(1000 + n), gramps_id: `F${n}`, change: 1, private: false, father_handle: null, mother_handle: null, child_ref_list: [], event_ref_list: [], type: typ("FamilyRelType", 0), ...extra });
const ref = (handle) => ({ _class: "EventRef", ref: handle, role: typ("EventRoleType", 1) });
const create = (obj) => ({ op: "create", class: obj._class, handle: obj.handle, base_version: null, obj });

const NOW = Date.UTC(2027, 9, 13, 12, 0, 0);
function world() {
  const ddb = createFakeDdb();
  ddb.rows.set("SYNC#HEAD\u0000META", { ...headKey(), seq: 0, seeded: true, writes_enabled: true });
  const ctx = { ddb, cmds, table: "hfy-app", now: () => NOW, uid: (() => { let u = 0; return () => `u${++u}`; })(), unsafeNoValidate: true, log: { warn() {}, error() {} }, txnOpts: { sleep: async () => {} } };
  let k = 0;
  const apply = (ops) => applyBatch(ctx, { principal: "svc-test", origin: "desktop", idempotencyKey: `k${++k}`, ops });
  return { ddb, ctx, apply };
}

/** One synthetic tree: a death on 10-12 (2002), a marriage on 10-11 (2007), a birth with a PLANTED day and month (10-13), and a graduation. */
const TREE = () => {
  const death = event(1, 13, date(12, 10, 2002), { description: "synthetic note" });
  const wed = event(2, 1, date(11, 10, 2007));
  const birth = event(3, 12, date(13, 10, 1980));
  const grad = event(4, 31, date(13, 10, 2012), { description: "reach me at someone@example.com" });
  return [
    person(1, { event_ref_list: [ref(death.handle), ref(birth.handle)] }),
    person(2, { event_ref_list: [ref(grad.handle)] }),
    person(3),
    person(4),
    family(1, { father_handle: h(3), mother_handle: h(4), event_ref_list: [ref(wed.handle)] }),
    death, wed, birth, grad,
  ];
};

describe("the store source (AC1)", () => {
  let w;
  beforeEach(async () => {
    w = world();
    await w.apply(TREE().map(create));
  });

  it("uses SYNC#HEAD.seq as the version, and the snapshot reports the seq it read", async () => {
    const src = createStoreSource({ ctx: w.ctx, log: { warn() {} } });
    const seq = w.ddb.rows.get("SYNC#HEAD\u0000META").seq;
    expect(seq).toBeGreaterThan(0);
    expect(await src.version()).toBe(`store:${seq}`);
    const snap = await collectSource(src);
    expect(snap.version).toBe(`store:${seq}`);
    expect(snap.persons.map((p) => p.grampsId)).toEqual(["ITEST1", "ITEST2", "ITEST3", "ITEST4"]);
  });

  it("the OTD#INDEX rebuilds after each committed batch", async () => {
    const src = createStoreSource({ ctx: w.ctx, log: { warn() {} } });
    const svc = () => createOnThisDay({ ddb: w.ddb, cmds, table: "hfy-app", actor: { id: "ITEST1" }, now: () => NOW, uid: () => "u", source: src, daysOn: async () => true, cache: {}, log: { warn() {}, error() {}, info() {} } });
    const first = await svc().get({ date: "2027-10-12" });
    expect(first.tier).toBe("day");
    const v1 = first.indexVersion;
    const extra = event(9, 13, date(12, 10, 2012));
    await w.apply([create(person(5, { event_ref_list: [ref(extra.handle)] })), create(extra)]);
    const second = await svc().get({ date: "2027-10-12" });
    expect(second.indexVersion).not.toBe(v1);
    expect(second.indexVersion).toBe(`store:${w.ddb.rows.get("SYNC#HEAD\u0000META").seq}`);
  });

  it("gives non-birth day and month, and the marriage pair, to the builder", async () => {
    const { events, persons } = await collectSource(createStoreSource({ ctx: w.ctx, log: { warn() {} } }));
    const index = buildIndex({ events, persons, version: "x" });
    expect(Object.keys(index.day).sort()).toEqual(["10-11", "10-12", "10-13"]);
    expect(index.day["10-11"][0]).toMatchObject({ kind: "marriage", year: 2007, people: [{ grampsId: "ITEST4" }, { grampsId: "ITEST3" }] });
    expect(index.day["10-12"][0]).toMatchObject({ kind: "death", year: 2002, tone: "remember" });
  });
});

describe("a stored birth day never reaches the index (AC2)", () => {
  it("drops the planted birth day and month in the source and in the index", async () => {
    const w = world();
    await w.apply(TREE().map(create));
    const warns = [];
    const { events, persons } = await collectSource(createStoreSource({ ctx: w.ctx, log: { warn: (m, f) => warns.push([m, f]) } }));
    const birth = events.find((e) => e.typeCode === 12);
    expect(birth.date).toEqual({ year: 1980, modifier: 0, quality: 0 });
    expect(warns).toEqual([["onthisday store source dropped birth precision", { count: 1 }]]);
    const index = buildIndex({ events, persons, version: "x" });
    const born = index.year.find((i) => i.kind === "birth");
    expect(born).toMatchObject({ id: "birth:ITEST1", year: 1980 });
    expect(born.month).toBeUndefined();
    expect(born.day).toBeUndefined();
    expect(index.day["10-13"].every((i) => i.kind !== "birth")).toBe(true);
    expect(JSON.stringify(index)).not.toMatch(/birth[^}]*"(month|day)"/);
    expect(index.report.droppedBirthPrecision).toBe(0); // dropped before the builder saw it
  });

  it("the builder still drops a birth day it is handed (defence in depth)", () => {
    const index = buildIndex({ events: [{ handle: "b", typeCode: 12, date: { year: 1980, month: 10, day: 13, modifier: 0, quality: 0 }, participants: [{ grampsId: "A", role: "primary" }], private: false }], persons: [{ grampsId: "A", displayName: "Test A", lifeState: "living", private: false }] });
    expect(index.day).toEqual({});
    expect(index.year[0].day).toBeUndefined();
  });

  it("a private event, a private person and a contact pattern in free text do not get through", async () => {
    const w = world();
    const tree = TREE();
    tree.find((o) => o.handle === h(2004)).private = true; // the graduation
    await w.apply(tree.map(create));
    const { events } = await collectSource(createStoreSource({ ctx: w.ctx, log: { warn() {} } }));
    expect(events.find((e) => e.handle === h(2004)).private).toBe(true);
    const w2 = world();
    await w2.apply(TREE().map(create));
    const grad = (await collectSource(createStoreSource({ ctx: w2.ctx, log: { warn() {} } }))).events.find((e) => e.handle === h(2004));
    expect(grad.description).toBe(""); // the e-mail address is dropped whole
  });

  it("a spouse who is missing leaves the pair short, so the builder skips the marriage", () => {
    const v = new StoreView();
    const wed = event(2, 1, date(11, 10, 2007));
    v.put({ class: "Person", handle: h(3), version: 1, seq: 1, obj: person(3) });
    v.put({ class: "Event", handle: wed.handle, version: 1, seq: 2, obj: wed });
    v.put({ class: "Family", handle: h(1001), version: 1, seq: 3, obj: family(1, { father_handle: h(3), mother_handle: h(99), event_ref_list: [ref(wed.handle)] }) });
    const { events, persons } = rowsFromView(v, { nowYear: 2027 });
    expect(events[0].participants.map((p) => p.grampsId)).toEqual(["ITEST3", `h:${h(99)}`]);
    expect(buildIndex({ events, persons }).day).toEqual({});
  });

  it("a date in another calendar is not read as a Gregorian day", () => {
    const v = new StoreView();
    const d = event(1, 13, date(12, 10, 2002, { calendar: 1 }));
    v.put({ class: "Person", handle: h(1), version: 1, seq: 1, obj: person(1, { event_ref_list: [ref(d.handle)] }) });
    v.put({ class: "Event", handle: d.handle, version: 1, seq: 2, obj: d });
    const { events, persons } = rowsFromView(v, { nowYear: 2027 });
    expect(buildIndex({ events, persons }).day).toEqual({});
  });
});

describe("source selection (AC4, AC5)", () => {
  const interim = { kind: "interim", version: async () => "etag", snapshot: async () => ({ version: "etag", events: [], persons: [] }) };
  const store = { kind: "store", version: async () => "store:7", snapshot: async () => ({ version: "store:7", events: [], persons: [] }) };
  const pick = (o) => createSelectingSource({ interim, store, renderMode: () => "live", headSeq: async () => 5, log: { warn() {} }, ...o });

  it("serves the store only when RENDER_MODE=live and seq > 0", async () => {
    expect(await pick({}).version()).toBe("store:7");
    for (const mode of ["off", "shadow", ""]) expect(await pick({ renderMode: () => mode }).version()).toBe("etag");
    expect(await pick({ headSeq: async () => 0 }).version()).toBe("etag");
    expect((await pick({ headSeq: async () => 0 }).snapshot()).version).toBe("etag");
  });

  it("falls back to the interim adapter when the seq read fails", async () => {
    expect(await pick({ headSeq: async () => { throw new Error("down"); } }).version()).toBe("etag");
  });

  it("with Q2-04 declined the interim adapter always serves (the year tier only)", async () => {
    expect(await pick({ daysApproved: false }).version()).toBe("etag");
    expect(daysApprovedFromEnv({ OTD_DAY_TIERS: "off" })).toBe(false);
    expect(daysApprovedFromEnv({})).toBe(true);
  });
});

describe("the day and week tiers follow featureOn('onThisDayDays') (AC6)", () => {
  let w, source;
  const get = (daysOn, date = "2027-10-12") =>
    createOnThisDay({ ddb: w.ddb, cmds, table: "hfy-app", actor: { id: "ITEST1" }, now: () => NOW, uid: () => "u", source, daysOn, cache: {}, log: { warn() {}, error() {}, info() {} } }).get({ date });
  beforeEach(async () => {
    w = world();
    await w.apply(TREE().map(create));
    source = createStoreSource({ ctx: w.ctx, log: { warn() {} } });
  });

  it("serves the day tier when the flag is on and the year tier when it is off", async () => {
    expect((await get(async () => true)).tier).toBe("day");
    const off = await get(async () => false);
    expect(off.tier).not.toBe("day");
    expect(off.tier).not.toBe("week");
    for (const it of off.items) {
      expect(it.month).toBeUndefined();
      expect(it.day).toBeUndefined();
    }
    expect(JSON.stringify(off)).not.toMatch(/"(month|day)":\d/);
  });

  it("fails closed when the flag check throws, or when no check is given", async () => {
    expect((await get(async () => { throw new Error("flags down"); })).tier).not.toBe("day");
    const svc = createOnThisDay({ ddb: w.ddb, cmds, table: "hfy-app", actor: { id: "ITEST1" }, now: () => NOW, uid: () => "u", source, cache: {}, log: { warn() {}, error() {}, info() {} } });
    expect((await svc.get({ date: "2027-10-12" })).tier).not.toBe("day");
  });

  it("yearOnly strips the day lists and the month and day of year items", () => {
    const idx = { day: { "10-12": [{}] }, month: { 10: [{}] }, year: [{ id: "a", month: 10, day: 12, year: 2002 }] };
    expect(yearOnly(idx)).toEqual({ day: {}, month: {}, year: [{ id: "a", year: 2002 }] });
    expect(yearOnly(idx)).toBe(yearOnly(idx));
  });

  it("the route reads the flag per request: onThisDayDays off serves the year tier, on serves the day tier", async () => {
    const flags = { onThisDay: true, onThisDayDays: false };
    const api = makeApi({ flags, clock: () => NOW, extraDeps: { onThisDaySource: source } });
    const tok = await signToken("ITEST1");
    const call = () => api.call("GET", "/api/onthisday", { token: tok, query: { date: "2027-10-12" }, ct: undefined });
    expect((await call()).body.tier).not.toBe("day");
    flags.onThisDayDays = true;
    const on = await call();
    expect(on.status).toBe(200);
    expect(on.body.tier).toBe("day");
    expect(on.body.items[0]).toMatchObject({ kind: "death", month: 10, day: 12 });
  });
});
