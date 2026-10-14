// HFY-TSK-246: the cloud ID policy of Q2-03. Mint mode (ids from the 8000-8999 block, permanent), assign mode (empty ids, one desktop
// assignment, completeAccessRequest), and the branch that is off in each. In-memory DynamoDB fake, real default validator, synthetic data.
import { describe, it, expect } from "vitest";
import { createFakeDdb, cmds } from "./world.js";
import { HttpError } from "../src/http.js";
import { applyBatch } from "../src/sync/apply.js";
import { createHookRegistry } from "../src/sync/hooks.js";
import { createIdPolicy, idPolicyFromEnv, inBlock, formatId, ID_BLOCK_LAST } from "../src/sync/id-policy.js";
import { headKey } from "../src/sync/store.js";

const T = "hfy-app";
const h = (n) => n.toString(16).padStart(28, "0");
const date = (dateval = [0, 0, 0, false], text = "") => ({ _class: "Date", calendar: 0, dateval, format: null, modifier: 0, newyear: 0, quality: 0, sortval: 0, text });
const person = (n, extra = {}) => ({
  _class: "Person", handle: h(n), gramps_id: `I${String(n).padStart(4, "0")}`, private: false, gender: 1,
  primary_name: { _class: "Name", first_name: "Alder", surname_list: [{ _class: "Surname", primary: true, surname: "Testwood" }], type: { _class: "NameType", string: "", value: 2 }, date: date() },
  event_ref_list: [], birth_ref_index: -1, death_ref_index: -1, family_list: [], parent_family_list: [], note_list: [], media_list: [], urls: [], ...extra,
});
const family = (n, extra = {}) => ({ _class: "Family", handle: h(1000 + n), gramps_id: `F${String(n).padStart(4, "0")}`, private: false, father_handle: null, mother_handle: null, child_ref_list: [], event_ref_list: [], note_list: [], ...extra });
const note = (n, extra = {}) => ({ _class: "Note", handle: h(2000 + n), gramps_id: `N${String(n).padStart(4, "0")}`, private: false, text: { _class: "StyledText", string: `Synthetic note ${n}`, tags: [] }, ...extra });

const create = (obj, extra = {}) => ({ op: "create", class: obj._class, handle: obj.handle, base_version: null, obj, ...extra });
const update = (obj, base, extra = {}) => ({ op: "update", class: obj._class, handle: obj.handle, base_version: base, obj, ...extra });
const del = (cls, handle, base, extra = {}) => ({ op: "delete", class: cls, handle, base_version: base, ...extra });
/** A web-origin create with no id (the proposal and access-request creates). */
const bare = (obj) => ({ ...obj, gramps_id: "" });

function world({ mode, head = {}, idPolicy, ...rest } = {}) {
  const ddb = createFakeDdb();
  ddb.rows.set("SYNC#HEAD\u0000META", structuredClone({ ...headKey(), seq: 0, seeded: true, writes_enabled: true, merges_enabled: false, live_heads: 1000, ...head }));
  const clock = { t: Date.parse("2026-10-14T00:00:00Z") };
  let u = 0;
  const ctx = { ddb, cmds, table: T, now: () => (clock.t += 1000), uid: () => `uid${String(++u).padStart(4, "0")}`, hooks: createHookRegistry(), log: { warn() {}, error() {} }, txnOpts: { sleep: async () => {} }, idPolicy: idPolicy ?? createIdPolicy({ mode }), ...rest };
  let k = 0;
  const apply = (ops, o = {}) => applyBatch(ctx, { principal: "svc-test", origin: "proposal", idempotencyKey: `key-${++k}`, ops, ...o });
  const row = (pk, sk) => ddb.rows.get(`${pk}\u0000${sk}`);
  const stored = (cls, handle) => JSON.parse(row(`REC#${cls}#${handle}`, "HEAD").obj_json);
  return { ddb, ctx, apply, row, stored };
}
const rejects = async (p, status, code) => {
  const e = await p.then(() => null, (x) => x);
  expect(e, "expected a rejection").toBeInstanceOf(HttpError);
  expect([e.status, e.code]).toEqual([status, code]);
  return e;
};

describe("configuration", () => {
  it("accepts mint and assign, refuses any other mode, and reads HFY_ID_POLICY", () => {
    expect(createIdPolicy({ mode: "mint" }).mode).toBe("mint");
    expect(createIdPolicy({ mode: "assign" }).mode).toBe("assign");
    expect(createIdPolicy().mode).toBeUndefined();
    expect(() => createIdPolicy({ mode: "both" })).toThrow(TypeError);
    expect(idPolicyFromEnv({}).mode).toBeUndefined();
    expect(idPolicyFromEnv({ HFY_ID_POLICY: "assign" }).mode).toBe("assign");
    expect(() => idPolicyFromEnv({ HFY_ID_POLICY: "yes" })).toThrow(TypeError);
  });
  it("knows the block", () => {
    expect(inBlock("Person", "I8000")).toBe(true);
    expect(inBlock("Family", "F8999")).toBe(true);
    expect(inBlock("Person", "I7999")).toBe(false);
    expect(inBlock("Person", "F8000")).toBe(false);
    expect(formatId("Event", 8001)).toBe("E8001");
  });
});

describe("mint mode (Q2-03 approved)", () => {
  it("mints I8000, F8000 and I8001 for web-origin creates, writes id_next in the same transaction and claims the GID", async () => {
    const w = world({ mode: "mint" });
    const r = await w.apply([create(bare(person(1))), create(bare(family(1))), create(bare(person(2)))]);
    expect(r.results.map((x) => x.gramps_id)).toEqual(["I8000", "F8000", "I8001"]);
    expect(w.stored("Person", h(1)).gramps_id).toBe("I8000");
    expect(w.row(`REC#Person#${h(1)}`, "HEAD").gramps_id).toBe("I8000");
    expect(w.row("GID#Person#I8000", "META")).toMatchObject({ handle: h(1) });
    expect(w.row("GID#Person#I8001", "META")).toMatchObject({ handle: h(2) });
    expect(w.row("GID#Family#F8000", "META")).toMatchObject({ handle: h(1001) });
    expect(w.row("SYNC#HEAD", "META").id_next).toEqual({ Person: 8002, Family: 8001 });
    const r2 = await w.apply([create(bare(person(3)))]);
    expect(r2.results[0].gramps_id).toBe("I8002");
  });

  it("does not mint when an id is given outside the block, and refuses a web-origin id inside it", async () => {
    const w = world({ mode: "mint" });
    const r = await w.apply([create(person(5))]);
    expect(r.results[0].gramps_id).toBe("I0005");
    expect(w.row("SYNC#HEAD", "META").id_next).toBeUndefined();
    await rejects(w.apply([create(person(6, { gramps_id: "I8123" }))]), 409, "reserved_id_block");
  });

  it("refuses a desktop create into the block (reserved_id_block) and a desktop update that moves an object into it", async () => {
    const w = world({ mode: "mint" });
    await rejects(w.apply([create(person(1, { gramps_id: "I8000" }))], { origin: "desktop" }), 409, "reserved_id_block");
    await w.apply([create(person(2))], { origin: "desktop" });
    await rejects(w.apply([update(person(2, { gramps_id: "I8001" }), 1)], { origin: "desktop" }), 409, "reserved_id_block");
  });

  it("refuses a desktop empty id: it is not the assign branch", async () => {
    const w = world({ mode: "mint" });
    await rejects(w.apply([create(bare(person(1)))], { origin: "desktop" }), 400, "validation");
  });

  it("skips a number whose GID item already exists, and a stale counter cannot claim it twice", async () => {
    const w = world({ mode: "mint", head: { id_next: { Person: 8000 } } });
    w.ddb.rows.set("GID#Person#I8000\u0000META", { PK: "GID#Person#I8000", SK: "META", entity: "gid", handle: h(99) });
    const r = await w.apply([create(bare(person(1)))]);
    expect(r.results[0].gramps_id).toBe("I8001");
    expect(w.row("SYNC#HEAD", "META").id_next.Person).toBe(8002);
  });

  it("answers 409 id_block_exhausted past 8999 and writes nothing", async () => {
    const w = world({ mode: "mint", head: { id_next: { Person: ID_BLOCK_LAST + 1 } } });
    await rejects(w.apply([create(bare(person(1)))]), 409, "id_block_exhausted");
    expect(w.row(`REC#Person#${h(1)}`, "HEAD")).toBeUndefined();
    const w2 = world({ mode: "mint", head: { id_next: { Person: ID_BLOCK_LAST } } });
    expect((await w2.apply([create(bare(person(1)))])).results[0].gramps_id).toBe("I8999");
    await rejects(w2.apply([create(bare(person(2)))]), 409, "id_block_exhausted");
  });

  it("a replay of the same key returns the same minted id and burns no number", async () => {
    const w = world({ mode: "mint" });
    const ops = [create(bare(person(1)))];
    const a = await applyBatch(w.ctx, { principal: "svc-test", origin: "proposal", idempotencyKey: "same", ops });
    const b = await applyBatch(w.ctx, { principal: "svc-test", origin: "proposal", idempotencyKey: "same", ops });
    expect(b).toMatchObject({ replayed: true });
    expect(b.results).toEqual(a.results);
    expect(w.row("SYNC#HEAD", "META").id_next.Person).toBe(8001);
  });

  it("a lost seq race re-reads the counter: two writers never get the same id", async () => {
    const w = world({ mode: "mint" });
    let raced = false;
    const real = w.ctx.ddb;
    w.ctx.ddb = { ...real, send: async (cmd) => {
      if (!raced && cmd.constructor.name === "TransactWriteCommand") {
        raced = true;
        await applyBatch({ ...w.ctx, ddb: real }, { principal: "svc-other", origin: "proposal", idempotencyKey: "other", ops: [create(bare(person(7)))] });
      }
      return real.send(cmd);
    } };
    const r = await w.apply([create(bare(person(1)))]);
    expect(r.results[0].gramps_id).toBe("I8001");
    expect(w.stored("Person", h(7)).gramps_id).toBe("I8000");
  });

  it("a minted Person id is permanent: delete retires it, never releases it, and nobody claims it again", async () => {
    const w = world({ mode: "mint" });
    await w.apply([create(bare(person(1)))]);
    await w.apply([del("Person", h(1), 1)], { origin: "admin", stepUp: true });
    expect(w.row("GID#Person#I8000", "META")).toMatchObject({ retired: true, handle: h(1) });
    await rejects(w.apply([create(person(2, { gramps_id: "I8000" }))], { origin: "admin" }), 409, "reserved_id_block"); // supplied block ids are refused outright
    const next = await w.apply([create(bare(person(3)))]);
    expect(next.results[0].gramps_id).toBe("I8001");
  });

  it("a non-Person minted id is released on delete, as any non-Person id", async () => {
    const w = world({ mode: "mint" });
    await w.apply([create(bare(family(1)))]);
    await w.apply([del("Family", h(1001), 1)], { origin: "admin" });
    expect(w.row("GID#Family#F8000", "META")).toBeUndefined();
  });

  it("a desktop push stays strict and never reaches the assign branch", async () => {
    const w = world({ mode: "mint" });
    await w.apply([create(bare(person(1)))]);
    await rejects(w.apply([update(person(1, { gramps_id: "I0001" }), 1)], { origin: "desktop" }), 409, "renumber_blocked");
  });
});

describe("review fixes", () => {
  it("mint: a web-origin update cannot move a non-Person object into the block, but may keep the id the store minted for it", async () => {
    const w = world({ mode: "mint" });
    await w.apply([create(family(1, { gramps_id: "F0001" })), create(bare(family(2)))]);
    await rejects(w.apply([update(family(1, { gramps_id: "F8500" }), 1)]), 409, "reserved_id_block");
    expect(w.row("GID#Family#F8500", "META")).toBeUndefined();
    await w.apply([update(family(2, { gramps_id: "F8000" }), 1)]);
  });

  it("mint: a large stale gap of existing GIDs is skipped", async () => {
    const w = world({ mode: "mint", head: { id_next: { Person: 8000 } } });
    for (let n = 8000; n < 8120; n += 1) w.ddb.rows.set(`GID#Person#I${n}\u0000META`, { PK: `GID#Person#I${n}`, SK: "META", entity: "gid", handle: h(5000 + n) });
    expect((await w.apply([create(bare(person(1)))])).results[0].gramps_id).toBe("I8120");
  });

  it("assign: a web origin assigning an id to an ID-less non-Person object is assign_desktop_only; the desktop may, under the GID guard", async () => {
    const w = world({ mode: "assign" });
    await w.apply([create(bare(family(1))), create(bare(family(2)))]);
    for (const origin of ["admin", "self", "proposal"]) {
      await rejects(w.apply([update(family(1, { gramps_id: "F0042" }), 1)], { origin }), 409, "assign_desktop_only");
    }
    expect(w.row("GID#Family#F0042", "META")).toBeUndefined();
    await w.apply([update(family(1, { gramps_id: "F0042" }), 1)], { origin: "desktop" });
    expect(w.row("GID#Family#F0042", "META")).toMatchObject({ handle: h(1001) });
    await rejects(w.apply([update(family(2, { gramps_id: "F0042" }), 1)], { origin: "desktop" }), 409, "gramps_id_taken");
  });

  it("a misconfigured mode is one logged configuration error (500 id_policy_misconfigured)", async () => {
    const errs = [];
    const w = world({ idPolicy: { mode: "both" }, log: { warn() {}, error: (m) => errs.push(m) } });
    await rejects(w.apply([create(person(1))]), 500, "id_policy_misconfigured");
    expect(errs).toEqual(["id_policy_misconfigured"]);
  });
});

describe("assign mode (Q2-03 declined)", () => {
  const accessWorld = () => {
    const done = [];
    const w = world({
      idPolicy: createIdPolicy({
        mode: "assign",
        accessRequestOf: async ({ handle }) => (handle === h(1) ? "req-1" : undefined),
        completeAccessRequest: async (id, gid) => { done.push([id, gid]); },
      }),
    });
    return { w, done };
  };

  it("a web-origin create carries an empty gramps_id: nothing is minted and no GID item is written", async () => {
    const { w } = accessWorld();
    const r = await w.apply([create(bare(person(1))), create(person(2, { gramps_id: undefined }))]);
    expect(r.results.map((x) => x.gramps_id)).toEqual(["", ""]);
    expect(w.stored("Person", h(1)).gramps_id).toBe("");
    expect(w.ddb.all().some((x) => x.PK.startsWith("GID#"))).toBe(false);
    expect(w.row("SYNC#HEAD", "META").id_next).toBeUndefined();
  });

  it("an admin edit may touch an ID-less person and keep the id empty", async () => {
    const { w } = accessWorld();
    await w.apply([create(bare(person(1)))]);
    const r = await w.apply([update(bare(person(1, { gender: 2 })), 1)], { origin: "admin" });
    expect(r.results[0]).toMatchObject({ version: 2, gramps_id: "" });
  });

  it("the desktop's first assignment is allowed once, claims the GID, and fires completeAccessRequest after the commit", async () => {
    const { w, done } = accessWorld();
    await w.apply([create(bare(person(1))), create(bare(person(2)))]);
    const r = await w.apply([update(person(1, { gramps_id: "I0042" }), 1), update(person(2, { gramps_id: "I0043" }), 1)], { origin: "desktop" });
    expect(r.results.map((x) => x.gramps_id)).toEqual(["I0042", "I0043"]);
    expect(w.row("GID#Person#I0042", "META")).toMatchObject({ handle: h(1) });
    expect(w.row(`REC#Person#${h(1)}`, "HEAD").gramps_id).toBe("I0042");
    expect(done).toEqual([["req-1", "I0042"]]); // only the person that came from an access request
  });

  it("the completion runs once: not for a replay, not for a later edit", async () => {
    const { w, done } = accessWorld();
    await w.apply([create(bare(person(1)))]);
    const ops = [update(person(1, { gramps_id: "I0042" }), 1)];
    await applyBatch(w.ctx, { principal: "svc-test", origin: "desktop", idempotencyKey: "asg", ops });
    await applyBatch(w.ctx, { principal: "svc-test", origin: "desktop", idempotencyKey: "asg", ops });
    await w.apply([update(person(1, { gramps_id: "I0042", gender: 2 }), 2)], { origin: "desktop" });
    expect(done).toHaveLength(1);
  });

  it("a failing completeAccessRequest does not fail the write", async () => {
    const warned = [];
    const w = world({
      log: { warn: (m) => warned.push(m), error() {} },
      idPolicy: createIdPolicy({ mode: "assign", accessRequestOf: async () => "req-1", completeAccessRequest: async () => { throw new Error("boom"); } }),
    });
    await w.apply([create(bare(person(1)))]);
    const r = await w.apply([update(person(1, { gramps_id: "I0042" }), 1)], { origin: "desktop" });
    expect(r.results[0].gramps_id).toBe("I0042");
    expect(warned).toEqual(["complete_access_request_failed"]);
  });

  it("any later change is renumber_blocked", async () => {
    const { w } = accessWorld();
    await w.apply([create(bare(person(1)))]);
    await w.apply([update(person(1, { gramps_id: "I0042" }), 1)], { origin: "desktop" });
    await rejects(w.apply([update(person(1, { gramps_id: "I0044" }), 2)], { origin: "desktop" }), 409, "renumber_blocked");
    await rejects(w.apply([update(person(1, { gramps_id: "I0044" }), 2, { renumber: true })], { origin: "desktop" }), 409, "renumber_blocked");
  });

  it("only from desktop origin: a web origin assigning an id to an ID-less person is refused", async () => {
    const { w } = accessWorld();
    await w.apply([create(bare(person(1)))]);
    for (const origin of ["admin", "self", "proposal", "seed"]) {
      const e = await w.apply([update(person(1, { gramps_id: "I0042" }), 1)], { origin }).then(() => null, (x) => x);
      expect(e, origin).toBeInstanceOf(HttpError);
      expect(e.status, origin).toBe(409);
    }
    expect(w.row("GID#Person#I0042", "META")).toBeUndefined();
  });

  it("the assignment runs under the GID guard: an id in use is gramps_id_taken, a retired one gramps_id_retired", async () => {
    const { w } = accessWorld();
    await w.apply([create(person(2))], { origin: "desktop" });
    await w.apply([create(bare(person(1)))]);
    await rejects(w.apply([update(person(1, { gramps_id: "I0002" }), 1)], { origin: "desktop" }), 409, "gramps_id_taken");
    w.ddb.rows.set("GID#Person#I0077\u0000META", { PK: "GID#Person#I0077", SK: "META", entity: "gid", handle: h(88), retired: true, reason: "deleted" });
    await rejects(w.apply([update(person(1, { gramps_id: "I0077" }), 1)], { origin: "desktop" }), 409, "gramps_id_retired");
  });

  it("the block is not reserved when nothing mints, so the desktop may assign I8000", async () => {
    const { w } = accessWorld();
    await w.apply([create(bare(person(1)))]);
    const r = await w.apply([update(person(1, { gramps_id: "I8000" }), 1)], { origin: "desktop" });
    expect(r.results[0].gramps_id).toBe("I8000");
  });

  it("a desktop create with an empty id is still refused: only a web-origin create is ID-less", async () => {
    const { w } = accessWorld();
    await rejects(w.apply([create(bare(person(1)))], { origin: "desktop" }), 400, "validation");
  });
});

describe("no mode configured", () => {
  it("behaves as before: a web-origin create without an id is a 400, the block is reserved to the desktop, nothing is minted", async () => {
    const w = world({});
    await rejects(w.apply([create(bare(person(1)))]), 400, "validation");
    await rejects(w.apply([create(person(1, { gramps_id: "I8000" }))], { origin: "desktop" }), 409, "reserved_id_block");
  });
});
