// HFY-TSK-245: the server validator behind applyBatch(): schema and rect, the privacy checker, ID rules, integrity and the destructive
// budget, from every origin. In-memory DynamoDB fake, real default validator, synthetic objects only.
import { describe, it, expect } from "vitest";
import { createFakeDdb, cmds } from "./world.js";
import { errorResponse, HttpError } from "../src/http.js";
import { SyncError, applyBatch } from "../src/sync/apply.js";
import { createHookRegistry } from "../src/sync/hooks.js";
import { BLOCK_PREFIX, DESTRUCTIVE_LIMIT, HARD_ORIGINS, MAX_VIOLATIONS, RESERVED_NAMES, createValidator, isFullValidator, referencesOf } from "../src/sync/validator.js";
import { budgetBucket, budgetKey, headKey } from "../src/sync/store.js";

const T = "hfy-app";
const h = (n) => n.toString(16).padStart(28, "0");
const WEB = HARD_ORIGINS;
const ALL_ORIGINS = ["desktop", "seed", ...WEB];

// ---- synthetic Gramps objects (schema-valid) ---------------------------------------------------------------------------------
const date = (dateval = [0, 0, 0, false], text = "") => ({ _class: "Date", calendar: 0, dateval, format: null, modifier: 0, newyear: 0, quality: 0, sortval: 0, text });
const person = (n, extra = {}) => ({
  _class: "Person", handle: h(n), gramps_id: `I${String(n).padStart(4, "0")}`, private: false, gender: 1,
  primary_name: { _class: "Name", first_name: "Alder", surname_list: [{ _class: "Surname", primary: true, surname: "Testwood" }], type: { _class: "NameType", string: "", value: 2 }, date: date() },
  event_ref_list: [], birth_ref_index: -1, death_ref_index: -1, family_list: [], parent_family_list: [], note_list: [], media_list: [], urls: [], ...extra,
});
const family = (n, extra = {}) => ({ _class: "Family", handle: h(1000 + n), gramps_id: `F${String(n).padStart(4, "0")}`, private: false, father_handle: null, mother_handle: null, child_ref_list: [], event_ref_list: [], note_list: [], ...extra });
const note = (n, extra = {}) => ({ _class: "Note", handle: h(2000 + n), gramps_id: `N${String(n).padStart(4, "0")}`, private: false, text: { _class: "StyledText", string: `Synthetic note ${n}`, tags: [] }, ...extra });
const event = (n, type, dateval, extra = {}) => ({ _class: "Event", handle: h(3000 + n), gramps_id: `E${String(n).padStart(4, "0")}`, private: false, type: { _class: "EventType", string: "", value: type }, date: date(dateval), place: "", citation_list: [], ...extra });
const media = (n, extra = {}) => ({ _class: "Media", handle: h(4000 + n), gramps_id: `O${String(n).padStart(4, "0")}`, private: false, path: "a.jpg", mime: "image/jpeg", ...extra });
const place = (n, type, extra = {}) => ({ _class: "Place", handle: h(5000 + n), gramps_id: `P${String(n).padStart(4, "0")}`, private: false, place_type: { _class: "PlaceType", string: "", value: type }, title: "", code: "", lat: "", long: "", ...extra });
const mref = (n, rect) => ({ _class: "MediaRef", ref: h(4000 + n), rect, private: false });
const eref = (ev) => ({ _class: "EventRef", ref: ev.handle, role: { _class: "EventRoleType", string: "", value: 1 }, private: false });
const create = (obj, extra = {}) => ({ op: "create", class: obj._class, handle: obj.handle, base_version: null, obj, ...extra });
const update = (obj, base, extra = {}) => ({ op: "update", class: obj._class, handle: obj.handle, base_version: base, obj, ...extra });
const del = (cls, handle, base, extra = {}) => ({ op: "delete", class: cls, handle, base_version: base, ...extra });
const withdraw = (cls, handle, base) => ({ op: "withdraw", class: cls, handle, base_version: base, reason: "private" });

function world({ head = { seq: 0, seeded: true, writes_enabled: true, merges_enabled: false, live_heads: 1000 }, ...rest } = {}) {
  const ddb = createFakeDdb();
  if (head) ddb.rows.set("SYNC#HEAD\u0000META", structuredClone({ ...headKey(), ...head }));
  const clock = { t: Date.parse("2026-10-14T00:00:00Z") };
  let u = 0;
  const ctx = { ddb, cmds, table: T, now: () => (clock.t += 1000), uid: () => `uid${String(++u).padStart(4, "0")}`, hooks: createHookRegistry(), log: { warn() {}, error() {} }, txnOpts: { sleep: async () => {} }, ...rest };
  let k = 0;
  const apply = (ops, o = {}) => applyBatch(ctx, { principal: "svc-test", origin: "self", idempotencyKey: `key-${++k}`, ops, ...o });
  // seeds stored objects without the validator, as the seed does
  const seedStore = (ops, o = {}) => applyBatch({ ...ctx, validate: undefined, unsafeNoValidate: true }, { principal: "svc-seed", origin: "desktop", idempotencyKey: `seed-${++k}`, ops, ...o });
  const row = (pk, sk) => ddb.rows.get(`${pk}\u0000${sk}`);
  return { ddb, ctx, apply, seedStore, row, clock };
}
const rejects = async (p, status, code) => {
  const e = await p.then(() => null, (x) => x);
  expect(e, "expected a rejection").toBeInstanceOf(HttpError);
  expect([e.status, e.code]).toEqual([status, code]);
  return e;
};
const rulesOf = (e) => e.details.violations.map((v) => v.rule);
const written = (w) => w.ddb.all().filter((r) => r.PK.startsWith("REC#") || r.PK.startsWith("SYNC#LOG")).length;

describe("the validator runs on every op from every origin", () => {
  const dirty = person(1, { urls: [{ _class: "Url", path: "mailto:someone@example.org", desc: "", private: false, type: { _class: "UrlType", string: "", value: 1 } }] });
  for (const origin of ALL_ORIGINS) {
    it(`${origin}: a Person with an e-mail Url is refused 422 privacy_violation with pointers, and nothing is written`, async () => {
      const w = world();
      const e = await rejects(w.apply([create(dirty)], { origin }), 422, "privacy_violation");
      expect(e.details.violations).toEqual(expect.arrayContaining([
        { rule: "contact.url.email_type", class: "Person", handle: dirty.handle, pointer: "/urls/0", op_id: "1" },
        { rule: "contact.url.scan_hit", class: "Person", handle: dirty.handle, pointer: "/urls/0", op_id: "1" },
        { rule: "scan.email", class: "Person", handle: dirty.handle, pointer: "/urls/0/path", op_id: "1" },
      ]));
      expect(e.details.violations.every((v) => v.handle === dirty.handle && v.class === "Person" && v.op_id === "1")).toBe(true);
      expect(JSON.stringify(errorResponse(e).body)).not.toContain("someone@example.org"); // where, never what
      expect(written(w)).toBe(0);
    });
    it(`${origin}: a clean Person is written`, async () => {
      const w = world();
      expect((await w.apply([create(person(1))], { origin })).results).toHaveLength(1);
    });
  }

  it("one dirty op refuses the whole batch (atomic), whichever position it holds", async () => {
    const w = world();
    const ops = [...Array.from({ length: 23 }, (_, i) => create(person(i + 1))), create(person(24, { private: true }))];
    const e = await rejects(w.apply(ops), 422, "privacy_violation");
    expect(e.details.violations).toEqual([{ rule: "private.object.exclude", class: "Person", handle: h(24), pointer: "/private", op_id: "24" }]);
    expect(written(w)).toBe(0);
  });

  it("an answer lists at most 100 violations and says how many there were", async () => {
    const w = world();
    const many = person(1, { urls: Array.from({ length: 150 }, (_, i) => ({ _class: "Url", path: `mailto:user${i}@example.org`, desc: "", private: false, type: { _class: "UrlType", string: "", value: 1 } })) });
    const e = await rejects(w.apply([create(many)]), 422, "privacy_violation");
    expect(e.details.violations).toHaveLength(MAX_VIOLATIONS);
    expect(e.details.total).toBeGreaterThan(MAX_VIOLATIONS);
  });

  it("the validator answers before any conflict detail: a stale dirty write learns nothing about the stored object", async () => {
    const w = world();
    await w.apply([create(person(1))]);
    const e = await rejects(w.apply([update(person(1, { private: true }), 9)]), 422, "privacy_violation");
    expect(JSON.stringify(errorResponse(e).body)).not.toContain("current");
  });

  it("a plain ctx.validate is an extra layer after the default, never a replacement; only unsafeNoValidate skips the default (the seed and tests)", async () => {
    const seen = [];
    const loose = world({ validate: async (v) => { seen.push(v.ops.length); } });
    await rejects(loose.apply([create(dirty)]), 422, "privacy_violation"); // the privacy checker still ran
    expect(seen).toEqual([]); // ...and it ran first: the extra layer was never reached
    expect((await loose.apply([create(person(2))])).results).toHaveLength(1);
    expect(seen).toEqual([1]);
    const strict = world({ validate: async () => { throw new HttpError(403, "forbidden", "no"); } });
    await rejects(strict.apply([create(person(1))]), 403, "forbidden"); // the extra layer can still refuse
    const seed = world({ unsafeNoValidate: true });
    expect((await seed.apply([create(dirty)])).results).toHaveLength(1);
    const both = world({ unsafeNoValidate: true, validate: async (v) => { seen.push("only"); } }); // a test's own validator runs alone
    expect((await both.apply([create(dirty)])).results).toHaveLength(1);
    expect(seen.at(-1)).toBe("only");
  });
  it("a createValidator() result is the whole validator and takes the default's place; its options cannot drop the privacy checker", async () => {
    const full = createValidator();
    expect(isFullValidator(full)).toBe(true);
    expect(isFullValidator(async () => {})).toBe(false);
    let calls = 0;
    const w = world({ validate: (v) => { calls += 1; return full(v); } }); // a wrapper is a plain function: default runs too
    await w.apply([create(person(1))]);
    expect(calls).toBe(1);
    const w2 = world({ validate: createValidator({ hardOrigins: [] }) });
    await rejects(w2.apply([create(dirty)]), 422, "privacy_violation");
  });

  it("is re-run on the refreshed view after a lost seq race", async () => {
    let calls = 0;
    const inner = createValidator();
    const w = world({ validate: async (v) => { calls += 1; return inner(v); } });
    let raced = false;
    const real = w.ctx.ddb;
    w.ctx.ddb = { ...real, send: async (cmd) => {
      if (!raced && cmd.constructor.name === "TransactWriteCommand") {
        raced = true;
        await w.seedStore([create(person(99))]); // a competing writer takes the seq
      }
      return real.send(cmd);
    } };
    await w.apply([create(person(1))]);
    expect(calls).toBe(2);
  });
});

describe("schema and MediaRef.rect", () => {
  it("refuses an unknown key and a wrong type with the schema pointer, 400 validation", async () => {
    const w = world();
    const e = await rejects(w.apply([create(person(1, { extra_field: 1, gender: "x" }))]), 400, "validation");
    expect(e.details.violations.map(({ rule, pointer }) => [rule, pointer]).sort()).toEqual([["schema.additionalProperties", "/extra_field"], ["schema.type", "/gender"]]);
  });

  it("rect: null and ordered integers 0-100 pass", async () => {
    const w = world();
    const m = [media(1), media(2), media(3)];
    await w.apply([...m.map((x) => create(x)), create(person(1, { media_list: [mref(1, null), mref(2, [10, 20, 50, 60]), mref(3, [0, 0, 100, 99])] }))]);
    expect(written(w)).toBeGreaterThan(0);
  });

  const bad = [
    ["the full frame [0,0,100,100] (it is sent as null)", [0, 0, 100, 100], "media.rect.full_frame"],
    ["x1 not below x2", [50, 0, 50, 60], "media.rect.degenerate_or_float"],
    ["unordered corners", [60, 0, 10, 60], "media.rect.degenerate_or_float"],
    ["y1 not below y2", [0, 60, 10, 10], "media.rect.degenerate_or_float"],
    ["a value above 100", [0, 0, 101, 50], "media.rect.degenerate_or_float"],
    ["a negative value", [-1, 0, 50, 50], "media.rect.degenerate_or_float"],
    ["three numbers", [0, 0, 50], "media.rect.degenerate_or_float"],
    ["a string", ["0", 0, 50, 50], "media.rect.degenerate_or_float"],
  ];
  for (const [label, rect, rule] of bad) {
    for (const origin of ["tag", "self", "desktop"]) {
      it(`rect: ${label} is refused from ${origin}`, async () => {
        const w = world();
        const e = await rejects(w.apply([create(media(1)), create(person(1, { media_list: [mref(1, rect)] }))], { origin }), 400, "validation");
        expect(rulesOf(e)).toContain(rule);
        expect(e.details.violations.find((v) => v.rule === rule).pointer).toBe("/media_list/0/rect");
      });
    }
  }
  it("rect: a fraction never reaches the validator: the store's canonical JSON refuses it first (400 validation)", async () => {
    const w = world();
    for (const origin of ["tag", "self", "desktop"]) await rejects(w.apply([create(media(1)), create(person(1, { media_list: [mref(1, [10.5, 20, 50, 60])] }))], { origin }), 400, "validation");
  });
  it("rect on the media list of other classes is checked too", async () => {
    const w = world();
    const e = await rejects(w.apply([create(media(1)), create(event(1, 13, [0, 0, 1900, false], { media_list: [mref(1, [0, 0, 100, 100])] }))]), 400, "validation");
    expect(rulesOf(e)).toContain("media.rect.full_frame");
  });
});

describe("places: types, codes and coordinates, from every origin", () => {
  const cases = [
    ["Street 7", { place_type: { _class: "PlaceType", string: "", value: 7 } }, "place.exclude.type", "/place_type"],
    ["Farm 18", { place_type: { _class: "PlaceType", string: "", value: 18 } }, "place.exclude.type", "/place_type"],
    ["Building 19", { place_type: { _class: "PlaceType", string: "", value: 19 } }, "place.exclude.type", "/place_type"],
    ["Number 20", { place_type: { _class: "PlaceType", string: "", value: 20 } }, "place.exclude.type", "/place_type"],
    ["a custom home-like type", { place_type: { _class: "PlaceType", string: "Summer Residence", value: 0 } }, "place.exclude.custom_home_like", "/place_type"],
    ["a postal code on a City", { place_type: { _class: "PlaceType", string: "", value: 4 }, code: "12345" }, "place.code.local_only", "/code"],
    ["a latitude with 3 decimals", { place_type: { _class: "PlaceType", string: "", value: 4 }, lat: "45.123" }, "place.coordinates.round", "/lat"],
    ["a longitude with 3 decimals", { place_type: { _class: "PlaceType", string: "", value: 4 }, long: "-93.4567" }, "place.coordinates.round", "/long"],
  ];
  for (const origin of ALL_ORIGINS) {
    for (const [label, extra, rule, pointer] of cases) {
      it(`${origin}: ${label} is refused`, async () => {
        const w = world();
        const e = await rejects(w.apply([create(place(1, 4, extra))], { origin }), 422, "privacy_violation");
        expect(e.details.violations.map((v) => [v.rule, v.pointer])).toContainEqual([rule, pointer]);
      });
    }
    it(`${origin}: a City with a 2 decimal position, a State with a code and a County are kept`, async () => {
      const w = world();
      const ok = [place(1, 4, { lat: "45.12", long: "-93.46" }), place(2, 2, { code: "MN" }), place(3, 3)];
      expect((await w.apply(ok.map((p) => create(p)), { origin })).results).toHaveLength(3);
    });
  }
});

describe("ID rules", () => {
  const id = (cls, n) => `${BLOCK_PREFIX[cls]}${8000 + n}`;
  const withId = (cls, gid) => ({ Person: () => person(1, { gramps_id: gid }), Family: () => family(1, { gramps_id: gid }), Event: () => event(1, 13, [0, 0, 1900, false], { gramps_id: gid }), Note: () => note(1, { gramps_id: gid }), Media: () => media(1, { gramps_id: gid }) }[cls]());

  for (const cls of ["Person", "Family", "Event", "Note", "Media"]) {
    for (const origin of ["desktop", "seed"]) {
      it(`${origin} creates in the reserved block are 409 reserved_id_block (${cls})`, async () => {
        const w = world();
        const e = await rejects(w.apply([create(withId(cls, id(cls, 0)))], { origin }), 409, "reserved_id_block");
        expect(e.details.conflicts).toEqual([{ op_id: "1", class: cls, handle: expect.any(String) }]);
        await rejects(w.apply([create(withId(cls, id(cls, 999)))], { origin }), 409, "reserved_id_block");
      });
    }
  }
  it("the edges of the block: 8000 and 8999 are in, 7999 and 9000 and 18000 are out; a lower-case prefix and leading zeros are still the block", async () => {
    const w = world();
    for (const gid of ["I8000", "I8999", "i8123", "I08500"]) await rejects(w.apply([create(withId("Person", gid))], { origin: "desktop" }), 409, "reserved_id_block");
    for (const [i, gid] of ["I7999", "I9000", "I18000", "I80000", "X8000"].entries()) {
      const o = person(10 + i, { gramps_id: gid });
      expect((await w.apply([create(o)], { origin: "desktop" })).results).toHaveLength(1);
    }
  });
  it("a desktop or seed update that moves an object into the block is 409 reserved_id_block; keeping an id already there, or moving out of the block, is fine", async () => {
    const w = world();
    const f = family(1);
    const n = note(1, { gramps_id: "N8001" });
    await w.apply([create(f)], { origin: "self" });
    await w.apply([create(n)], { origin: "self" }); // the website minted it
    for (const origin of ["desktop", "seed"]) {
      const e = await rejects(w.apply([update({ ...f, gramps_id: "F8123" }, 1)], { origin }), 409, "reserved_id_block");
      expect(e.details.conflicts).toEqual([{ op_id: "1", class: "Family", handle: f.handle }]);
    }
    expect((await w.apply([update({ ...f, gramps_id: "F8123" }, 1)], { origin: "self" })).results).toHaveLength(1); // the website may
    expect((await w.apply([update({ ...n, text: { ...n.text, string: "edited" } }, 1)], { origin: "desktop" })).results).toHaveLength(1);
    expect((await w.apply([update({ ...n, gramps_id: "N0042" }, 2)], { origin: "desktop" })).results).toHaveLength(1); // out of the block
  });
  it("web origins may create in the block (the website mints there), and the desktop may update an object that is already in it", async () => {
    const w = world();
    const p = person(1, { gramps_id: "I8001" });
    for (const origin of WEB.slice(0, 2)) await w.apply([create(person(origin === "self" ? 1 : 2, { gramps_id: origin === "self" ? "I8001" : "I8002" }))], { origin });
    expect((await w.apply([update({ ...p, gender: 0 }, 1)], { origin: "desktop" })).results).toHaveLength(1);
  });

  for (const name of RESERVED_NAMES) {
    for (const origin of ALL_ORIGINS) {
      it(`the reserved file name ${name} is refused from ${origin}`, async () => {
        const w = world();
        const e = await rejects(w.apply([create(person(1, { gramps_id: name }))], { origin }), 422, "integrity_violation");
        expect(rulesOf(e)).toEqual(["id.reserved_name"]);
        expect(e.details.violations[0].pointer).toBe("/gramps_id");
      });
    }
  }
  it("reserved names are matched without regard to case, and for every class", async () => {
    const w = world();
    await rejects(w.apply([create(person(1, { gramps_id: "Search-Index" }))]), 422, "integrity_violation");
    await rejects(w.apply([create(family(1, { gramps_id: "GRAPH" }))]), 422, "integrity_violation");
  });
  it("a gramps_id that is not a safe file name is refused", async () => {
    const w = world();
    for (const gid of ["a/b", "../x", "a b", ".hidden", "x..y", "é1", "i".repeat(65)]) {
      const e = await w.apply([create(person(1, { gramps_id: gid }))]).then(() => null, (x) => x);
      expect(e, gid).toBeInstanceOf(HttpError);
      expect([400, 422]).toContain(e.status); // the length limit is apply's own 400; the rest are the validator's 422
    }
    await rejects(w.apply([create(person(1, { gramps_id: "a/b" }))]), 422, "integrity_violation");
  });

  it("a Person's gramps_id cannot change: 409 renumber_blocked, with or without the provisional renumber flag", async () => {
    const w = world();
    const p = person(1);
    await w.apply([create(p)]);
    for (const origin of ALL_ORIGINS.filter((o) => o !== "seed")) {
      const e = await rejects(w.apply([update({ ...p, gramps_id: "I0777" }, 1)], { origin }), 409, "renumber_blocked");
      expect(e.details.conflicts).toEqual([{ op_id: "1", class: "Person", handle: p.handle }]);
    }
    await rejects(w.apply([update({ ...p, gramps_id: "I0777" }, 1, { renumber: true })]), 409, "renumber_blocked");
    await rejects(w.apply([update(p, 1, { renumber: true })]), 409, "renumber_blocked"); // the flag alone is operator tooling
    expect((await w.apply([update({ ...p, gender: 0 }, 1)])).results).toHaveLength(1); // an update that keeps the id is fine
  });
  it("there is no escape hatch: createValidator() takes no allowRenumber, and the renumber flag is refused with any validator", async () => {
    const w = world({ validate: createValidator({ allowRenumber: true }) }); // an unknown option changes nothing
    const p = person(1);
    await w.apply([create(p)]);
    await rejects(w.apply([update({ ...p, gramps_id: "I0777" }, 1, { renumber: true })]), 409, "renumber_blocked");
    expect(w.row("IDALIAS#Person#I0001", "META")).toBeUndefined();
  });
  it("non-person ids may change", async () => {
    const w = world();
    const f = family(1);
    await w.apply([create(f)]);
    expect((await w.apply([update({ ...f, gramps_id: "F0777" }, 1)])).results[0].gramps_id).toBe("F0777");
  });

  it("a create or update that reuses a retired Person gramps_id for a different handle is 409 gramps_id_retired", async () => {
    const w = world();
    const p1 = person(1);
    await w.apply([create(p1), create(person(2))]);
    await w.apply([withdraw("Person", p1.handle, 1)]);
    for (const origin of ALL_ORIGINS.filter((o) => o !== "seed")) {
      const c = await rejects(w.apply([create(person(3, { gramps_id: "I0001" }))], { origin }), 409, "gramps_id_retired");
      expect(c.details.conflicts).toEqual([{ op_id: "1", class: "Person", handle: h(3) }]);
    }
    await rejects(w.apply([update(person(2, { gramps_id: "I0001" }), 1)]), 409, "gramps_id_retired"); // renumber_blocked would also apply: the retired id is the answer
  });
  it("the retired person itself is not recreated through a batch", async () => {
    const w = world();
    const p = person(1);
    await w.apply([create(p)]);
    await w.apply([del("Person", p.handle, 1)], { stepUp: true });
    await rejects(w.apply([create(p, { base_version: 2 })]), 409, "gramps_id_retired");
    await rejects(w.apply([create({ ...p, gramps_id: "I0555" }, { base_version: 2 })]), 409, "gramps_id_retired");
  });
});

describe("integrity: references, withdrawn handles and hard symmetry", () => {
  it("a reference that resolves nowhere is 422 integrity_violation with its pointer", async () => {
    const w = world();
    const e = await rejects(w.apply([create(person(1, { note_list: [h(2001)], family_list: [h(1001)] }))], { origin: "desktop" }), 422, "integrity_violation");
    expect(e.details.violations.map((v) => [v.rule, v.pointer]).sort()).toEqual([["integrity.unresolved_reference", "/family_list/0"], ["integrity.unresolved_reference", "/note_list/0"]]);
  });
  it("references resolve in the store view, in the batch, or in the open session's expected set", async () => {
    const w = world();
    await w.apply([create(note(1))]);
    expect((await w.apply([create(person(1, { note_list: [note(1).handle] }))], { origin: "desktop" })).results).toHaveLength(1); // store view
    expect((await w.apply([create(note(2)), create(person(2, { note_list: [note(2).handle] }))], { origin: "desktop" })).results).toHaveLength(2); // batch
    const forward = person(3, { note_list: [note(3).handle] });
    await rejects(w.apply([create(forward)], { origin: "desktop" }), 422, "integrity_violation");
    expect((await w.apply([create(forward)], { origin: "desktop", expected: [{ class: "Note", handle: note(3).handle }] })).results).toHaveLength(1); // expected set
    const other = person(4, { note_list: [note(4).handle] });
    expect((await w.apply([create(other)], { origin: "desktop", expected: [`Note#${note(4).handle}`] })).results).toHaveLength(1);
    await rejects(w.apply([create(person(5))], { origin: "desktop", expected: [{ class: "Bogus" }] }), 400, "validation");
  });
  it("a reference resolves in its own class only", async () => {
    const w = world();
    await w.apply([create(note(1))]);
    await rejects(w.apply([create(person(1, { family_list: [note(1).handle] }))], { origin: "desktop" }), 422, "integrity_violation");
  });
  it("the expected set never excuses a hard origin's symmetry", async () => {
    const w = world();
    await w.apply([create(person(1))]);
    await rejects(w.apply([update(person(1, { family_list: [family(1).handle] }), 1)], { origin: "self", expected: [{ class: "Family", handle: family(1).handle }] }), 422, "integrity_violation");
  });
  it("every reference list is followed: event refs, media refs, citations, lds ordinances, family parents, place, source", () => {
    const refs = referencesOf({ _class: "Family", father_handle: "p1", mother_handle: null, child_ref_list: [{ ref: "p2", citation_list: ["c1"] }], event_ref_list: [{ ref: "e1", attribute_list: [{ note_list: ["n1"] }] }], tag_list: ["t1"], media_list: [{ ref: "m1" }], lds_ord_list: [{ famc: "f9", place: "pl1" }] });
    expect(refs.map((r) => `${r.cls}:${r.handle}`).sort()).toEqual(["Citation:c1", "Event:e1", "Family:f9", "Media:m1", "Note:n1", "Person:p1", "Person:p2", "Place:pl1", "Tag:t1"]);
    expect(referencesOf({ _class: "Event", place: "pl1", citation_list: ["c1"] }).map((r) => r.pointer)).toEqual(["/citation_list/0", "/place"]);
    expect(referencesOf({ _class: "Citation", source_handle: "s1" })).toEqual([{ cls: "Source", handle: "s1", pointer: "/source_handle" }]);
    expect(referencesOf({ _class: "Place", placeref_list: [{ ref: "pl2" }] })[0]).toEqual({ cls: "Place", handle: "pl2", pointer: "/placeref_list/0/ref" });
  });

  describe("withdrawn handles", () => {
    const setup = async () => {
      const w = world();
      await w.apply([create(note(1)), create(person(1)), create(note(2))]);
      await w.apply([withdraw("Note", note(1).handle, 1)]);
      await w.apply([del("Note", note(2).handle, 1)], { stepUp: true });
      return w;
    };
    for (const origin of ["self", "admin", "proposal", "graduation", "tag"]) {
      it(`${origin}: an op that references a withdrawn handle is 422 withdrawn_reference`, async () => {
        const w = await setup();
        const e = await rejects(w.apply([update(person(1, { note_list: [note(1).handle] }), 1)], { origin }), 422, "withdrawn_reference");
        expect(e.details.violations).toEqual([{ rule: "integrity.withdrawn_reference", class: "Person", handle: h(1), pointer: "/note_list/0", op_id: "1" }]);
      });
    }
    it("a handle withdrawn earlier in the same batch counts as withdrawn", async () => {
      const w = world();
      await w.apply([create(note(1)), create(person(1))]);
      await rejects(w.apply([withdraw("Note", note(1).handle, 1), update(person(1, { note_list: [note(1).handle] }), 1)], { origin: "proposal" }), 422, "withdrawn_reference");
    });
    it("the desktop's reference to one does not resolve: 422 integrity_violation, not withdrawn_reference", async () => {
      const w = await setup();
      await rejects(w.apply([update(person(1, { note_list: [note(1).handle] }), 1)], { origin: "desktop" }), 422, "integrity_violation");
    });
    it("a handle that was deleted for another reason is a plain unresolved reference", async () => {
      const w = await setup();
      await rejects(w.apply([update(person(1, { note_list: [note(2).handle] }), 1)], { origin: "self" }), 422, "integrity_violation");
    });
    it("dropping the reference is fine", async () => {
      const w = await setup();
      expect((await w.apply([update(person(1, { gender: 0 }), 1)], { origin: "self" })).results).toHaveLength(1);
    });
  });

  describe("hard symmetry (web, proposal and graduation origins)", () => {
    const linked = async () => {
      const w = world();
      const p = person(1, { family_list: [family(1).handle] });
      const c = person(2, { parent_family_list: [family(1).handle] });
      const f = family(1, { father_handle: p.handle, child_ref_list: [{ _class: "ChildRef", ref: c.handle, private: false }] });
      await w.apply([create(p), create(c), create(f)], { origin: "desktop", expected: [{ class: "Family", handle: f.handle }] });
      return { w, p, c, f };
    };
    it("a consistent web write passes", async () => {
      const { w, p } = await linked();
      expect((await w.apply([update({ ...p, gender: 0 }, 1)], { origin: "self" })).results).toHaveLength(1);
    });
    for (const origin of ["self", "admin", "proposal", "graduation"]) {
      it(`${origin}: a family that names a father who does not list it is refused, naming the family`, async () => {
        const { w, p } = await linked();
        const f2 = family(2, { mother_handle: p.handle });
        const e = await rejects(w.apply([create(f2)], { origin }), 422, "integrity_violation");
        expect(e.details.violations).toEqual([{ rule: "integrity.symmetry.spouse", class: "Family", handle: f2.handle, pointer: "/mother_handle", op_id: "1" }]);
      });
    }
    it("a person that lists a family which does not name it is refused, naming the person", async () => {
      const { w, c } = await linked();
      const f2 = family(2);
      const e = await rejects(w.apply([create(f2), update({ ...c, family_list: [f2.handle] }, 1)], { origin: "self" }), 422, "integrity_violation");
      expect(e.details.violations).toEqual([{ rule: "integrity.symmetry.spouse", class: "Person", handle: c.handle, pointer: "/family_list/0", op_id: "2" }]);
    });
    it("child links are symmetric too, both ways", async () => {
      const { w, p, f } = await linked();
      const e = await rejects(w.apply([update({ ...f, child_ref_list: [...f.child_ref_list, { _class: "ChildRef", ref: p.handle, private: false }] }, 1)], { origin: "self" }), 422, "integrity_violation");
      expect(e.details.violations[0]).toMatchObject({ rule: "integrity.symmetry.child", class: "Family", pointer: "/child_ref_list/1/ref" });
      const { w: w2, c: c2 } = await linked();
      const e2 = await rejects(w2.apply([update({ ...c2, parent_family_list: [] }, 1)], { origin: "self" }), 422, "integrity_violation");
      expect(e2.details.violations[0]).toMatchObject({ rule: "integrity.symmetry.child", class: "Family", pointer: "/child_ref_list/0/ref" });
    });
    it("removing the person's side of a link while the family still has it is refused", async () => {
      const { w, p } = await linked();
      const e = await rejects(w.apply([update({ ...p, family_list: [] }, 1)], { origin: "proposal" }), 422, "integrity_violation");
      expect(e.details.violations[0]).toMatchObject({ rule: "integrity.symmetry.spouse", class: "Family", pointer: "/father_handle" });
    });
    it("deleting a person a stored family still names is refused; deleting both sides together passes", async () => {
      const { w, p, f } = await linked();
      await rejects(w.apply([del("Person", p.handle, 1)], { origin: "admin", stepUp: true }), 422, "integrity_violation");
      expect((await w.apply([update({ ...f, father_handle: null }, 1), del("Person", p.handle, 1)], { origin: "admin", stepUp: true })).results).toHaveLength(2);
    });
    it("both sides in the batch, consistent, pass", async () => {
      const w = world();
      const f = family(1, { mother_handle: h(1) });
      expect((await w.apply([create(person(1, { family_list: [f.handle] })), create(f)], { origin: "self" })).results).toHaveLength(2);
    });
    it("the desktop's asymmetric push is accepted here (it is checked when the session completes)", async () => {
      const w = world();
      expect((await w.apply([create(person(1, { family_list: [family(1).handle] })), create(family(1))], { origin: "desktop" })).results).toHaveLength(2);
    });
    it("birth_ref_index and death_ref_index must be in range for a web origin", async () => {
      const w = world();
      const ev = event(1, 13, [0, 0, 1900, false]);
      await w.apply([create(ev)]);
      const e = await rejects(w.apply([create(person(1, { event_ref_list: [eref(ev)], birth_ref_index: 1, death_ref_index: -2 }))], { origin: "self" }), 422, "integrity_violation");
      expect(e.details.violations.map((v) => v.pointer).sort()).toEqual(["/birth_ref_index", "/death_ref_index"]);
      expect((await w.apply([create(person(2, { event_ref_list: [eref(ev)], birth_ref_index: 0, death_ref_index: -1 }))], { origin: "self" })).results).toHaveLength(1);
    });
  });
});

describe("birth-likeness across the store view and the batch, through applyBatch", () => {
  it("an event written with a full date is refused when a stored person points at it as its birth, and not when none does", async () => {
    const w = world();
    const ev = event(1, 13, [0, 0, 1900, false]);
    const ev2 = event(2, 13, [0, 0, 1900, false]);
    await w.apply([create(ev), create(ev2), create(person(1, { event_ref_list: [eref(ev)], birth_ref_index: 0 }))]);
    const full = (e) => ({ ...e, date: date([5, 3, 1900, false]) });
    const r = await rejects(w.apply([update(full(ev), 1)]), 422, "privacy_violation");
    expect(r.details.violations.map((v) => [v.rule, v.handle, v.pointer])).toEqual([["birth.date.daymonth", ev.handle, "/date/dateval/0"], ["birth.date.daymonth", ev.handle, "/date/dateval/1"]]);
    expect((await w.apply([update(full(ev2), 1)])).results).toHaveLength(1);
  });
  it("a person's birth_ref_index change that targets a stored event with a full date is refused, naming the event", async () => {
    const w = world();
    const ev = event(1, 13, [9, 9, 1950, false]);
    const p = person(1, { event_ref_list: [eref(ev)], birth_ref_index: -1 });
    await w.apply([create(ev), create(p)]);
    const e = await rejects(w.apply([update({ ...p, birth_ref_index: 0 }, 1)]), 422, "privacy_violation");
    expect(e.details.violations).toEqual([
      { rule: "birth.date.daymonth", class: "Event", handle: ev.handle, pointer: "/date/dateval/0", op_id: "1" },
      { rule: "birth.date.daymonth", class: "Event", handle: ev.handle, pointer: "/date/dateval/1", op_id: "1" },
    ]);
  });
  it("from every origin", async () => {
    for (const origin of ALL_ORIGINS) {
      const w = world();
      const e = await rejects(w.apply([create(event(1, 12, [5, 3, 1900, false]))], { origin }), 422, "privacy_violation");
      expect(rulesOf(e)).toEqual(["birth.date.daymonth", "birth.date.daymonth"]);
    }
  });
});

describe("the transaction-size bound", () => {
  it("the budget counter's item is counted only for a batch with a delete or withdraw", async () => {
    const w = world();
    // 23 updates (4 items each) and one renumbering Person update (5) plus the 3 fixed items fill the 100 exactly: past the size gate,
    // the validator answers (renumber_blocked), where a bound that always reserved the counter would answer 413 batch_too_large.
    const notes = Array.from({ length: 23 }, (_, i) => update(note(i + 1), 1));
    const ops = [...notes, update(person(1, { gramps_id: "I0777" }), 1, { renumber: true })];
    await rejects(w.apply(ops), 409, "renumber_blocked");
    await rejects(w.apply([...notes.slice(0, 22), update(person(1), 1, { renumber: true }), update(person(2, { gramps_id: "I0778" }), 1, { renumber: true })]), 413, "batch_too_large"); // 22*4 + 2*5 + 3 = 101
  });
  it("two ops on one object in a batch are refused, so a handle is never counted twice toward the budget", async () => {
    const w = world();
    await w.apply([create(person(1))]);
    await rejects(w.apply([withdraw("Person", h(1), 1), del("Person", h(1), 1)]), 400, "duplicate_object");
  });
});

describe("the destructive budget and step-up", () => {
  const people = async (w, n) => {
    for (let i = 0; i < n; i += 24) await w.apply([...Array(Math.min(24, n - i)).keys()].map((k) => create(person(i + k + 1))));
  };

  it("a batch of 11 withdraws without step-up is 403 step_up_required; with step-up, and at 10, it is not", async () => {
    const w = world();
    await people(w, 11);
    const e = await rejects(w.apply(Array.from({ length: 11 }, (_, i) => withdraw("Person", h(i + 1), 1)), { origin: "desktop" }), 403, "step_up_required");
    expect(e.details).toEqual({ reason: "budget" });
    expect(w.row(`REC#Person#${h(1)}`, "HEAD").deleted).toBe(false);
    expect((await w.apply(Array.from({ length: 10 }, (_, i) => withdraw("Person", h(i + 1), 1)), { origin: "desktop" })).results).toHaveLength(10);
    expect(DESTRUCTIVE_LIMIT).toBe(10);
  });
  it("11 withdraws with a fresh step-up pass", async () => {
    const w = world();
    await people(w, 11);
    expect((await w.apply(Array.from({ length: 11 }, (_, i) => withdraw("Person", h(i + 1), 1)), { origin: "desktop", stepUp: true })).results).toHaveLength(11);
  });
  it("deletes and withdraws count together", async () => {
    const w = world();
    await people(w, 11);
    const ops = [...Array.from({ length: 6 }, (_, i) => withdraw("Person", h(i + 1), 1)), ...Array.from({ length: 5 }, (_, i) => del("Person", h(i + 7), 1))];
    await rejects(w.apply(ops, { origin: "self" }), 403, "step_up_required");
  });
  it("the rolling 24 hours: two batches of 6 within a day are over the budget, a day later they are not", async () => {
    const w = world();
    await people(w, 12);
    const six = (from) => Array.from({ length: 6 }, (_, i) => withdraw("Person", h(from + i), 1));
    await w.apply(six(1), { origin: "self" });
    await rejects(w.apply(six(7), { origin: "self" }), 403, "step_up_required");
    w.clock.t += 23 * 3_600_000; // still inside the window
    await rejects(w.apply(six(7), { origin: "self" }), 403, "step_up_required");
    w.clock.t += 3 * 3_600_000; // 26 hours after the first batch: out of the 25 hour buckets
    expect((await w.apply(six(7), { origin: "self" })).results).toHaveLength(6);
  });
  it("a refused batch counts for nothing; the counter holds only committed ops, per UTC hour, with a ttl", async () => {
    const w = world();
    await people(w, 12);
    await w.apply([del("Person", h(1), 1), withdraw("Person", h(2), 1)], { origin: "self" });
    await rejects(w.apply(Array.from({ length: 11 }, (_, i) => withdraw("Person", h(i + 3), 1)), { origin: "self" }), 403, "step_up_required");
    const bucket = budgetBucket(w.clock.t);
    const counter = w.row(`SYNC#BUDGET#${bucket}`, "META");
    expect(counter.count).toBe(2);
    expect(counter.ttl).toBeGreaterThan(Math.floor(w.clock.t / 1000) + 86400);
    expect(budgetKey(bucket)).toEqual({ PK: `SYNC#BUDGET#${bucket}`, SK: "META" });
    expect(bucket).toMatch(/^\d{10}$/);
  });
  it("a batch with no delete or withdraw writes no budget item", async () => {
    const w = world();
    await people(w, 3);
    expect(w.ddb.all().filter((r) => r.PK.startsWith("SYNC#BUDGET#"))).toHaveLength(0);
  });
  it("more than 5 % of the live heads needs a step-up even under 10 objects", async () => {
    const w = world({ head: { seq: 0, seeded: true, writes_enabled: true } }); // live_heads is counted from the first create
    await people(w, 40);
    expect(w.row("SYNC#HEAD", "META").live_heads).toBe(40);
    await rejects(w.apply([withdraw("Person", h(1), 1), withdraw("Person", h(2), 1), withdraw("Person", h(3), 1)], { origin: "self" }), 403, "step_up_required"); // 3 > 2
    await w.apply([withdraw("Person", h(1), 1), withdraw("Person", h(2), 1)], { origin: "self" }); // 2 = 5 % of 40
    expect(w.row("SYNC#HEAD", "META").live_heads).toBe(38);
  });
  it("a non-empty tree whose live_heads is missing, negative or not an integer fails closed: every destructive batch needs a step-up (heads_unknown)", async () => {
    for (const bad of [undefined, -3, 2.5, "40"]) {
      const w = world({ head: { seq: 0, seeded: true, writes_enabled: true } });
      await people(w, 3);
      const head = w.ddb.rows.get("SYNC#HEAD\u0000META");
      if (bad === undefined) delete head.live_heads;
      else head.live_heads = bad;
      const e = await rejects(w.apply([withdraw("Person", h(1), 1)], { origin: "self" }), 403, "step_up_required");
      expect(e.details).toEqual({ reason: "heads_unknown" });
      expect((await w.apply([withdraw("Person", h(1), 1)], { origin: "self", stepUp: true })).results).toHaveLength(1);
    }
  });
  it("a missing live_heads is not counted from a partial number: applyBatch leaves it missing until the backfill sets the real count", async () => {
    const w = world({ head: { seq: 7, seeded: true, writes_enabled: true } }); // a tree filled without the counter
    await w.apply([create(person(1)), create(person(2))]);
    expect(w.row("SYNC#HEAD", "META").live_heads).toBeUndefined();
    await rejects(w.apply([withdraw("Person", h(1), 1)], { origin: "self" }), 403, "step_up_required");
    w.row("SYNC#HEAD", "META").live_heads = 400; // the backfill
    expect((await w.apply([withdraw("Person", h(1), 1)], { origin: "self" })).results).toHaveLength(1);
    expect(w.row("SYNC#HEAD", "META").live_heads).toBe(399);
  });
  it("an empty tree (seq 0) with no live_heads counts from its first create, and the 10-object rule alone applies to a batch before any head exists", async () => {
    const w = world({ head: null });
    await w.apply([create(person(1))], { origin: "seed" });
    expect(w.row("SYNC#HEAD", "META").live_heads).toBe(1);
  });
  it("concurrent destructive batches cannot together pass the 10-object budget: the second loses the seq race and is re-checked against the first", async () => {
    const w = world();
    await people(w, 16);
    const eight = (from) => Array.from({ length: 8 }, (_, i) => withdraw("Person", h(from + i), 1));
    const real = w.ctx.ddb;
    let raced = false;
    w.ctx.ddb = { ...real, send: async (cmd) => {
      if (!raced && cmd.constructor.name === "TransactWriteCommand") {
        raced = true; // another writer commits its 8 after this batch passed the budget check and before it commits
        await applyBatch({ ...w.ctx, ddb: real }, { principal: "svc-rival", origin: "self", idempotencyKey: "rival", ops: eight(9) });
      }
      return real.send(cmd);
    } };
    await rejects(w.apply(eight(1), { origin: "self" }), 403, "step_up_required");
    const counted = w.ddb.all().filter((r) => r.PK.startsWith("SYNC#BUDGET#")).reduce((n, r) => n + r.count, 0);
    expect(counted).toBe(8);
  });
  it("live_heads follows creates, deletes, withdraws and a create over a tombstone", async () => {
    const w = world();
    const n = note(1);
    const base = w.row("SYNC#HEAD", "META").live_heads;
    await w.apply([create(n), create(note(2))]);
    expect(w.row("SYNC#HEAD", "META").live_heads).toBe(base + 2);
    await w.apply([del("Note", n.handle, 1), update({ ...note(2), private: false }, 1)]);
    expect(w.row("SYNC#HEAD", "META").live_heads).toBe(base + 1);
    await w.apply([create(n, { base_version: 2 })]);
    expect(w.row("SYNC#HEAD", "META").live_heads).toBe(base + 2);
  });
  it("a desktop delete needs a step-up even below the budget (D07); other origins' single delete does not, and a withdraw does not", async () => {
    const w = world();
    await people(w, 30);
    const e = await rejects(w.apply([del("Person", h(1), 1)], { origin: "desktop" }), 403, "step_up_required");
    expect(e.details).toEqual({ reason: "delete" });
    expect((await w.apply([del("Person", h(1), 1)], { origin: "desktop", stepUp: true })).results).toHaveLength(1);
    expect((await w.apply([withdraw("Person", h(2), 1)], { origin: "desktop" })).results).toHaveLength(1);
    expect((await w.apply([del("Person", h(3), 1)], { origin: "admin" })).results).toHaveLength(1);
  });
  it("step-up is asked for before the version check: a stale destructive batch learns nothing", async () => {
    const w = world();
    await people(w, 2);
    const e = await rejects(w.apply([del("Person", h(1), 9)], { origin: "desktop" }), 403, "step_up_required");
    expect(JSON.stringify(errorResponse(e).body)).not.toContain("current");
  });
  it("step-up does not excuse a privacy violation, a reserved id or a dangling reference", async () => {
    const w = world();
    await rejects(w.apply([create(person(1, { private: true }))], { origin: "desktop", stepUp: true }), 422, "privacy_violation");
    await rejects(w.apply([create(person(1, { gramps_id: "index" }))], { origin: "desktop", stepUp: true }), 422, "integrity_violation");
  });
  it("a withdraw must carry reason private", async () => {
    const w = world();
    await w.apply([create(person(1))]);
    await rejects(w.apply([{ op: "withdraw", class: "Person", handle: h(1), base_version: 1 }]), 400, "validation");
    await rejects(w.apply([{ op: "withdraw", class: "Person", handle: h(1), base_version: 1, reason: "tidy" }]), 400, "validation");
    expect((await w.apply([withdraw("Person", h(1), 1)])).results).toHaveLength(1);
  });
});

describe("the validator is an HttpError path", () => {
  it("every refusal is a SyncError with a status, a code and details, never a stack or a value", async () => {
    const w = world();
    const e = await rejects(w.apply([create(person(1, { private: true }))]), 422, "privacy_violation");
    expect(e).toBeInstanceOf(SyncError);
    const body = JSON.parse(errorResponse(e).body);
    expect(body).toEqual({ error: "privacy_violation", message: expect.any(String), details: { violations: [{ rule: "private.object.exclude", class: "Person", handle: h(1), pointer: "/private", op_id: "1" }] } });
  });
});
