// HFY-TSK-244: record accessors and the store-view fold. In-memory DynamoDB fake; synthetic objects only.
import { describe, it, expect } from "vitest";
import { createFakeDdb, cmds } from "./world.js";
import { applyBatch } from "../src/sync/apply.js";
import { headItem, headKey, objectJson } from "../src/sync/store.js";
import { GRAPH_TTL_MS, backrefs, byGrampsId, customTypes, get, graph, rebuildStoreView, resetStoreView, storeView } from "../src/records/index.js";

const h = (n) => n.toString(16).padStart(28, "0");
const typ = (cls, value, string = "") => ({ _class: cls, value, string });
const person = (n, extra = {}) => ({ _class: "Person", handle: h(n), gramps_id: `I${String(n).padStart(4, "0")}`, change: 1, private: false, gender: 1, event_ref_list: [], family_list: [], parent_family_list: [], ...extra });
const family = (n, extra = {}) => ({ _class: "Family", handle: h(1000 + n), gramps_id: `F${String(n).padStart(4, "0")}`, change: 1, private: false, father_handle: null, mother_handle: null, child_ref_list: [], type: typ("FamilyRelType", 0, ""), ...extra });
const event = (n, extra = {}) => ({ _class: "Event", handle: h(2000 + n), gramps_id: `E${String(n).padStart(4, "0")}`, change: 1, private: false, type: typ("EventType", 12), ...extra });
const create = (obj, extra = {}) => ({ op: "create", class: obj._class, handle: obj.handle, base_version: null, obj, ...extra });
const update = (obj, base) => ({ op: "update", class: obj._class, handle: obj.handle, base_version: base, obj });
const del = (cls, handle, base) => ({ op: "delete", class: cls, handle, base_version: base });

/** Writes a head straight into the table: applyBatch enforces GID uniqueness, and the accessor must still cope with equal ids (dbapi.py:232). */
const seedHead = (w, obj, { deleted = false } = {}) => {
  const item = headItem({ class: obj._class, handle: obj.handle, gramps_id: obj.gramps_id, version: 1, seq: 1, deleted, objJson: deleted ? null : objectJson(obj), at: "2026-10-14T00:00:00Z", by: "svc-test", origin: "seed" });
  w.ddb.rows.set(`${item.PK}\u0000${item.SK}`, item);
};

function world() {
  const ddb = createFakeDdb();
  ddb.rows.set("SYNC#HEAD\u0000META", { ...headKey(), seq: 0, seeded: true, writes_enabled: true });
  let t = Date.parse("2026-10-14T00:00:00Z");
  let u = 0;
  const ctx = { ddb, cmds, table: "hfy-app", now: () => (t += 1000), uid: () => `u${++u}`, unsafeNoValidate: true, log: { warn() {}, error() {} }, txnOpts: { sleep: async () => {} } };
  let k = 0;
  const apply = (ops) => applyBatch(ctx, { principal: "svc-test", origin: "desktop", idempotencyKey: `k${++k}`, ops });
  const tick = (ms) => (t += ms);
  return { ddb, ctx, apply, tick };
}

describe("get / byGrampsId", () => {
  it("get returns { obj, version }, null for unknown and for a tombstone", async () => {
    const w = world();
    await w.apply([create(person(1))]);
    expect(await get(w.ctx, "Person", h(1))).toMatchObject({ version: 1, obj: { handle: h(1), gramps_id: "I0001" } });
    expect(await get(w.ctx, "Person", h(9))).toBeNull();
    await w.apply([del("Person", h(1), 1)]);
    expect(await get(w.ctx, "Person", h(1))).toBeNull();
  });

  it("byGrampsId finds every live holder, ignores prefixes and other classes, and excludes tombstones", async () => {
    const w = world();
    for (const p of [person(1, { gramps_id: "I1" }), person(2, { gramps_id: "I1" }), person(3, { gramps_id: "I10" })]) seedHead(w, p);
    seedHead(w, person(4, { gramps_id: "I1" }), { deleted: true });
    expect(await byGrampsId(w.ctx, "Person", "I1")).toEqual([{ handle: h(1), version: 1 }, { handle: h(2), version: 1 }]);
    expect(await byGrampsId(w.ctx, "Person", "I10")).toEqual([{ handle: h(3), version: 1 }]);
    expect(await byGrampsId(w.ctx, "Person", "I")).toEqual([]);
    expect(await byGrampsId(w.ctx, "Family", "I1")).toEqual([]);
    expect(await byGrampsId(w.ctx, "Person", "")).toEqual([]);
    await expect(byGrampsId(w.ctx, "Nope", "I1")).rejects.toMatchObject({ code: "unknown_class" });
  });

  it("byGrampsId pages through many equal ids", async () => {
    const w = world();
    for (let i = 1; i <= 36; i++) seedHead(w, person(i, { gramps_id: "I7" }));
    expect(await byGrampsId(w.ctx, "Person", "I7")).toHaveLength(36);
  });
});

describe("backrefs", () => {
  it("lists live referrers, follows updates and drops deleted referrers", async () => {
    const w = world();
    const e = event(1);
    await w.apply([create(e), create(person(1, { event_ref_list: [{ ref: e.handle, role: typ("EventRoleType", 1) }] })), create(person(2))]);
    expect(await backrefs(w.ctx, `Event:${e.handle}`)).toEqual([`Person:${h(1)}`]);
    await w.apply([update(person(2, { event_ref_list: [{ ref: e.handle, role: typ("EventRoleType", 1) }] }), 1)]);
    expect(await backrefs(w.ctx, `Event:${e.handle}`)).toEqual([`Person:${h(1)}`, `Person:${h(2)}`]);
    await w.apply([update(person(1), 1)]);
    expect(await backrefs(w.ctx, `Event:${e.handle}`)).toEqual([`Person:${h(2)}`]);
    await w.apply([del("Person", h(2), 2)]);
    expect(await backrefs(w.ctx, `Event:${e.handle}`)).toEqual([]);
    expect(await backrefs(w.ctx, "Event:nothing")).toEqual([]);
  });
});

describe("graph", () => {
  it("builds families and parents, and is cached for 60 s", async () => {
    const w = world();
    await w.apply([create(person(1)), create(person(2)), create(person(3)), create(family(1, { father_handle: h(1), mother_handle: h(2), child_ref_list: [{ ref: h(3) }] }))]);
    const g = await graph(w.ctx);
    expect(g).toEqual({ families: { [h(1001)]: { father: h(1), mother: h(2), children: [h(3)] } }, parents: { [h(3)]: [h(1001)] } });
    await w.apply([create(family(2, { father_handle: h(3) }))]);
    expect(await graph(w.ctx)).toBe(g); // cached
    w.tick(GRAPH_TTL_MS + 1);
    const g2 = await graph(w.ctx);
    expect(g2).not.toBe(g);
    expect(Object.keys(g2.families)).toHaveLength(2);
  });

  it("the cache does not read the table", async () => {
    const w = world();
    await w.apply([create(family(1))]);
    await graph(w.ctx);
    let reads = 0;
    const send = w.ddb.send.bind(w.ddb);
    w.ddb.send = async (c) => { reads++; return send(c); };
    await graph(w.ctx);
    expect(reads).toBe(0);
  });
});

describe("customTypes", () => {
  it("collects value-0 type strings per type class, sorted and distinct", async () => {
    const w = world();
    await w.apply([
      create(event(1, { type: typ("EventType", 0, "Zeta Rite") })),
      create(event(2, { type: typ("EventType", 0, "Alpha Rite") })),
      create(event(3, { type: typ("EventType", 0, "Alpha Rite") })),
      create(event(4, { type: typ("EventType", 12, "ignored") })),
      create(person(1, { attribute_list: [{ type: typ("AttributeType", 0, "Fixture Trait") }] })),
    ]);
    expect(await customTypes(w.ctx)).toEqual({ AttributeType: ["Fixture Trait"], EventType: ["Alpha Rite", "Zeta Rite"] });
    await w.apply([del("Event", h(2001), 1)]);
    expect((await customTypes(w.ctx)).EventType).toEqual(["Alpha Rite"]);
  });
});

// ---- the store view equals a full rebuild --------------------------------------------------------------------------------
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}
const flat = (view) => [...view.heads.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, e]) => [k, e.version, e.deleted, e.deleted ? null : e.obj, e.gramps_id]);
const tableHeads = (ddb) => ddb.all().filter((r) => r.PK.startsWith("REC#")).sort((a, b) => (a.PK < b.PK ? -1 : 1)).map((r) => [`${r.class}:${r.handle}`, r.version, r.deleted === true, r.obj_json ? JSON.parse(r.obj_json) : null, r.gramps_id]);

describe("store view = full rebuild", () => {
  for (const seed of [1, 2, 3]) {
    it(`after random batches (seed ${seed}), warm view, cold rebuild, snapshot+fold and the table heads agree`, async () => {
      const w = world();
      const rand = rng(seed);
      const state = new Map(); // key -> { version, live, obj }
      const pick = (arr) => arr[Math.floor(rand() * arr.length)];
      let snapshot = null;
      for (let round = 0; round < 25; round++) {
        const ops = [];
        const used = new Set();
        const n = 1 + Math.floor(rand() * 5);
        for (let i = 0; i < n; i++) {
          const kind = pick(["Person", "Person", "Event", "Family"]);
          const num = 1 + Math.floor(rand() * 12);
          const obj = kind === "Person" ? person(num) : kind === "Event" ? event(num) : family(num);
          const key = `${kind}:${obj.handle}`;
          if (used.has(key)) continue;
          used.add(key);
          const cur = state.get(key);
          const refTarget = h(1 + Math.floor(rand() * 12));
          if (kind === "Person") obj.event_ref_list = [{ ref: h(2000 + 1 + Math.floor(rand() * 12)), role: typ("EventRoleType", 1) }];
          if (kind === "Family") Object.assign(obj, { father_handle: refTarget, child_ref_list: [{ ref: h(1 + Math.floor(rand() * 12)) }] });
          if (kind === "Event" && rand() < 0.4) obj.type = typ("EventType", 0, `Custom ${Math.floor(rand() * 4)}`);
          if (!cur) ops.push(create(obj));
          else if (!cur.live) {
            if (kind === "Person") continue; // a Person id is retired for ever: no recreate through a batch
            ops.push(create(obj, { base_version: cur.version }));
          }
          else if (rand() < 0.3) ops.push(del(kind, obj.handle, cur.version));
          else ops.push(update(obj, cur.version));
        }
        if (!ops.length) continue;
        const r = await w.apply(ops);
        for (const res of r.results) {
          const op = ops.find((o) => o.handle === res.handle);
          state.set(`${res.class}:${res.handle}`, { version: res.version, live: op.op !== "delete" });
        }
        const warm = await storeView(w.ctx);
        expect(warm.seq).toBe(r.seq_to);
        if (round === 10) snapshot = { seq: warm.seq, heads: [...warm.heads.values()].map((e) => structuredClone(e)) };
      }
      const warm = await storeView(w.ctx);
      const cold = await rebuildStoreView(w.ctx);
      const viaSnapshot = await rebuildStoreView({ ...w.ctx, snapshot: async () => structuredClone(snapshot) });
      expect(snapshot).not.toBeNull();
      expect(warm.seq).toBe(cold.seq);
      expect(flat(warm)).toEqual(flat(cold));
      expect(flat(viaSnapshot)).toEqual(flat(cold));
      expect(flat(cold)).toEqual(tableHeads(w.ddb).map(([k, v, d, o, g]) => [k, v, d, o, g]));
      // the reverse index and the derived registries agree too
      for (const [target, srcs] of cold.refs) {
        const live = [...srcs].filter((s) => cold.heads.get(s)?.deleted === false).sort();
        expect(await backrefs(w.ctx, target)).toEqual(live);
      }
      resetStoreView(w.ctx);
      const fresh = await storeView(w.ctx); // a cold start through the cache path
      expect(flat(fresh)).toEqual(flat(cold));
    });
  }
});
