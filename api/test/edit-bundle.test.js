// HFY-TSK-182 (edit-api-core): GET /api/edit/:cls/:ref, GET /api/edit/schema/:cls and the ownRecord and editing fields of GET /api/me.
// In-memory DynamoDB fake, synthetic ids and dates only.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeApi, signToken, TABLE, cmds } from "./world.js";
import { applyBatch } from "../src/sync/apply.js";
import { headKey } from "../src/sync/store.js";
import { buildCaps, ROUTES } from "../src/routes.js";
import { SCHEMA_CLASSES, schemaHash } from "../src/records/edit-bundle.js";

const h = (n) => n.toString(16).padStart(28, "0");
const typ = (cls, value, string = "") => ({ _class: cls, value, string });
const date = (d, m, y, extra = {}) => ({ _class: "Date", calendar: 0, dateval: [d, m, y, false], format: null, modifier: 0, newyear: 0, quality: 0, sortval: d || m ? 2400000 + d : 0, text: "", ...extra });
const person = (n, extra = {}) => ({ _class: "Person", handle: h(n), gramps_id: `I${String(n).padStart(4, "0")}`, change: 1, private: false, gender: 1, primary_name: { _class: "Name", first_name: `Given${n}`, surname_list: [{ _class: "Surname", surname: "Synth", primary: true }] }, event_ref_list: [], family_list: [], parent_family_list: [], media_list: [], note_list: [], birth_ref_index: -1, death_ref_index: -1, ...extra });
const event = (n, d, extra = {}) => ({ _class: "Event", handle: h(2000 + n), gramps_id: `E${String(n).padStart(4, "0")}`, change: 1, private: false, type: typ("EventType", 21), date: d, media_list: [], note_list: [], ...extra });
const note = (n) => ({ _class: "Note", handle: h(3000 + n), gramps_id: `N${String(n).padStart(4, "0")}`, change: 1, private: false, text: { _class: "StyledText", string: "synthetic" } });
const family = (n, extra = {}) => ({ _class: "Family", handle: h(5000 + n), gramps_id: `F${String(n).padStart(4, "0")}`, change: 1, private: false, child_ref_list: [], event_ref_list: [], media_list: [], note_list: [], ...extra });
const primary = (ev) => ({ _class: "EventRef", ref: ev.handle, role: typ("EventRoleType", 1) });
const create = (obj) => ({ op: "create", class: obj._class, handle: obj.handle, base_version: null, obj });

const ME = "I0001";
const OTHER = "I0002";
const ADMIN = "I0099";
const THIRD = "I0004"; // a member with no Person in the tree
const q = { warn() {}, error() {} };

let envBefore;
beforeEach(() => { envBefore = process.env.HFY_EDITING; process.env.HFY_EDITING = "on"; });
afterEach(() => { if (envBefore === undefined) delete process.env.HFY_EDITING; else process.env.HFY_EDITING = envBefore; });

async function world() {
  const w = makeApi({ log: q });
  w.ddb.rows.set("SYNC#HEAD\u0000META", { ...headKey(), seq: 0, seeded: true, writes_enabled: true });
  let t = Date.parse("2026-10-14T00:00:00Z");
  let u = 0;
  const ctx = { ddb: w.ddb, cmds, table: TABLE, now: () => (t += 1000), uid: () => `u${++u}`, unsafeNoValidate: true, log: q, txnOpts: { sleep: async () => {} } };
  let k = 0;
  const apply = (ops) => applyBatch(ctx, { principal: "svc-test", origin: "desktop", idempotencyKey: `k${++k}`, ops });
  const ownDeath = event(1, date(14, 3, 1990));
  const otherDeath = event(2, date(9, 11, 1980, { text: "9 Nov 1980" }));
  const n1 = note(1);
  const fam = family(1, { father_handle: h(1) });
  const me = person(1, { event_ref_list: [primary(ownDeath)], death_ref_index: 0, note_list: [n1.handle], family_list: [fam.handle] });
  const other = person(2, { event_ref_list: [primary(otherDeath)], death_ref_index: 0, note_list: [n1.handle], family_list: [fam.handle] });
  await apply([me, other, ownDeath, otherDeath, n1, fam].map(create));
  const get = async (path, who) => w.call("GET", path, { token: who ? await signToken(who) : undefined });
  const mod = (target, author_id) => w.ddb.rows.set(`MOD#${target}\u0000META`, { PK: `MOD#${target}`, SK: "META", entity: "mod", author_id, state: "hidden", hidden: true, open: true });
  let n = 0;
  const proposal = (key, proposer, targets, state = "pending") => {
    const id = `01PROP${String(++n).padStart(4, "0")}`;
    const p = { id, state, proposer: { id: proposer, label: "x" }, targets, ops: [{ id: "o1", op: "set", obj: key, path: "/primary_name/first_name", value: "SECRETVALUE" }], note: "SECRETNOTE" };
    w.ddb.rows.set(`PROP#${id}\u0000IDX#REC#${key}`, { PK: `PROP#${id}`, SK: `IDX#REC#${key}`, GSI1PK: `PROPREC#${key}`, GSI1SK: id, proposal: p });
    return id;
  };
  // A second live head with a used gramps_id (applyBatch refuses one, but a Gramps tree can hold it): only the GSI1 row byGrampsId reads.
  const twin = (gid, handle) => w.ddb.rows.set(`REC#Person#${handle}\u0000HEAD`, { PK: `REC#Person#${handle}`, SK: "HEAD", GSI1PK: "RECS#Person", GSI1SK: `${gid}#${handle}`, handle, version: 1, gramps_id: gid });
  return { ...w, twin, apply, get, me, other, ownDeath, otherDeath, n1, fam, mod, proposal };
}

describe("the HFY_EDITING switch (AC1)", () => {
  it("answers 404 not_found on every new route when HFY_EDITING is not on, for members, admins and signed-out callers", async () => {
    const w = await world();
    for (const v of [undefined, "off", "ON", ""]) {
      if (v === undefined) delete process.env.HFY_EDITING; else process.env.HFY_EDITING = v;
      for (const who of [ME, ADMIN, undefined]) {
        for (const path of [`/api/edit/Person/h:${w.me.handle}`, `/api/edit/Person/${ME}`, "/api/edit/schema/Person"]) {
          const r = await w.get(path, who);
          expect([v, who, path, r.status, r.body.error]).toEqual([v, who, path, 404, "not_found"]);
        }
      }
    }
  });
  it("needs a session once the switch is on", async () => {
    const w = await world();
    expect((await w.get(`/api/edit/Person/${ME}`)).status).toBe(401);
    expect((await w.get("/api/edit/schema/Person")).status).toBe(401);
  });
  it("is read-only: other methods are 405", async () => {
    const w = await world();
    const token = await signToken(ME);
    expect((await w.call("POST", `/api/edit/Person/${ME}`, { token, body: {} })).status).toBe(405);
  });
});

describe("GET /api/me ownRecord and editing (AC2)", () => {
  it("carries the own Person for a gramps_id that maps to exactly one person, and editing follows the switch", async () => {
    const w = await world();
    const r = await w.get("/api/me", ME);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: ME, admin: false, ownRecord: { cls: "Person", handle: w.me.handle, gramps_id: ME }, editing: true });
    process.env.HFY_EDITING = "off";
    expect((await w.get("/api/me", ME)).body).toMatchObject({ editing: false, ownRecord: { handle: w.me.handle } });
  });
  it("ownRecord is null for 0 people and for 2 or more people with the gramps_id", async () => {
    const w = await world();
    expect((await w.get("/api/me", THIRD)).body).toMatchObject({ ownRecord: null, editing: true });
    w.twin(ME, h(7));
    const r = await w.get("/api/me", ME);
    expect(r.status).toBe(200);
    expect(r.body.ownRecord).toBeNull();
  });
  it("keeps the core fields", async () => {
    const w = await world();
    const r = await w.get("/api/me", ADMIN);
    expect(r.body).toMatchObject({ id: ADMIN, admin: true, can: { moderate: true, graduate: true, approve: true } });
  });
});

describe("the bundle shape", () => {
  it("returns the record, related objects, relation, viewer, policy, pending, customTypes and schemaHash; by gramps_id and by h:<handle>", async () => {
    const w = await world();
    const r = await w.get(`/api/edit/Person/${OTHER}`, ME);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ key: `Person:${w.other.handle}`, version: 1, etag: `Person:${w.other.handle}@1`, relation: "other", viewer: { admin: false }, pending: [], schemaHash: schemaHash() });
    expect(r.headers.etag).toBeUndefined();
    expect(r.headers["cache-control"]).toBe("private, no-store");
    expect(r.body.obj.primary_name.first_name).toBe("Given2");
    expect(Object.keys(r.body.related).sort()).toEqual([`Event:${w.otherDeath.handle}`, `Family:${w.fam.handle}`, `Note:${w.n1.handle}`].sort());
    expect(r.body.policy.rows.length).toBeGreaterThan(10);
    expect(r.body.customTypes).toEqual({});
    const byHandle = await w.get(`/api/edit/Person/h:${w.other.handle}`, ME);
    expect(byHandle.body).toEqual(r.body);
    expect((await w.get(`/api/edit/Person/${ME}`, ME)).body.relation).toBe("own");
  });
  it("also carries the places of the related events and the sources of the related citations, for the editor's pickers (HFY-TSK-156)", async () => {
    const w = await world();
    const place = { _class: "Place", handle: h(6001), gramps_id: "P0001", change: 1, private: false, name: { _class: "PlaceName", value: "Synthville", lang: "" }, place_type: typ("PlaceType", 3) };
    const source = { _class: "Source", handle: h(7001), gramps_id: "S0001", change: 1, private: false, title: "A synthetic ledger" };
    const cit = { _class: "Citation", handle: h(8001), gramps_id: "C0001", change: 1, private: false, source_handle: source.handle, page: "p. 1", confidence: 2 };
    const ev = event(7, date(0, 0, 1950), { place: place.handle });
    const p = person(7, { event_ref_list: [primary(ev)], citation_list: [cit.handle] });
    await w.apply([place, source, cit, ev, p].map(create));
    const r = await w.get(`/api/edit/Person/${p.gramps_id}`, ME);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body.related).sort()).toEqual([`Citation:${cit.handle}`, `Event:${ev.handle}`, `Place:${place.handle}`, `Source:${source.handle}`].sort());
    expect(r.body.related[`Place:${place.handle}`].obj.name.value).toBe("Synthville");
    expect(r.body.related[`Source:${source.handle}`].obj.title).toBe("A synthetic ledger");
    expect(r.body.related[`Place:${place.handle}`].version).toBe(1);
    // an event with no place and a citation with no source add nothing
    const q1 = await w.get(`/api/edit/Person/${OTHER}`, ME);
    expect(Object.keys(q1.body.related).some((k) => k.startsWith("Place:") || k.startsWith("Source:"))).toBe(false);
  });
  it("puts the second-level places and sources through the same read-side view: a member sees a fine date on them at year precision, an admin as stored (HFY-TSK-156)", async () => {
    const w = await world();
    const fine = date(9, 11, 1971);
    const place = { _class: "Place", handle: h(6002), gramps_id: "P0002", change: 1, private: false, name: { _class: "PlaceName", value: "Otherton", lang: "", date: fine }, place_type: typ("PlaceType", 3) };
    const source = { _class: "Source", handle: h(7002), gramps_id: "S0002", change: 1, private: false, title: "Another ledger", abbrev: "" };
    const cit = { _class: "Citation", handle: h(8002), gramps_id: "C0002", change: 1, private: false, source_handle: source.handle, page: "p. 2", confidence: 2, date: fine };
    const ev = event(8, date(0, 0, 1950), { place: place.handle });
    const p = person(8, { event_ref_list: [primary(ev)], citation_list: [cit.handle] });
    await w.apply([place, source, cit, ev, p].map(create));
    const member = (await w.get(`/api/edit/Person/${p.gramps_id}`, ME)).body;
    const admin = (await w.get(`/api/edit/Person/${p.gramps_id}`, ADMIN)).body;
    expect(member.related[`Place:${place.handle}`].obj.name.date.dateval.slice(0, 3)).toEqual([0, 0, 1971]);
    expect(admin.related[`Place:${place.handle}`].obj.name.date.dateval.slice(0, 3)).toEqual([9, 11, 1971]);
    expect(member.related[`Citation:${cit.handle}`].obj.date.dateval.slice(0, 3)).toEqual([0, 0, 1971]);
  });
  it("holds at most 200 related objects across both levels: a first level of 200 leaves no room for a place (HFY-TSK-156)", async () => {
    const w = await world();
    const places = Array.from({ length: 200 }, (_, i) => ({ _class: "Place", handle: h(6100 + i), gramps_id: `P${String(100 + i).padStart(4, "0")}`, change: 1, private: false, name: { _class: "PlaceName", value: `Synthplace ${i}`, lang: "" }, place_type: typ("PlaceType", 3) }));
    const evs = places.map((pl, i) => event(100 + i, date(0, 0, 1950), { place: pl.handle }));
    const full = person(20, { event_ref_list: evs.map(primary) });
    const short = person(21, { event_ref_list: evs.slice(0, 199).map(primary) });
    const all = [...places, ...evs, full, short].map(create);
    for (let i = 0; i < all.length; i += 20) await w.apply(all.slice(i, i + 20));
    const keys = (b) => Object.keys(b.related);
    const atCap = (await w.get(`/api/edit/Person/${full.gramps_id}`, ADMIN)).body;
    expect(keys(atCap)).toHaveLength(200);
    expect(keys(atCap).some((k) => k.startsWith("Place:"))).toBe(false);
    // one short of the cap, the second level fills the last place
    const oneShort = (await w.get(`/api/edit/Person/${short.gramps_id}`, ADMIN)).body;
    expect(keys(oneShort)).toHaveLength(200);
    expect(keys(oneShort).filter((k) => k.startsWith("Place:"))).toEqual([`Place:${places[0].handle}`]);
  });
  it("shows a related Person as a stub with a year-only lifespan and no other fields", async () => {
    const w = await world();
    const r = await w.get(`/api/edit/Family/${w.fam.gramps_id}`, ME);
    expect(r.status).toBe(200);
    expect(r.body.relation).toBe("own");
    const stub = r.body.related[`Person:${w.me.handle}`];
    expect(stub).toMatchObject({ version: 1, stub: { displayName: "Given1 Synth", gender: 1, isLiving: false, lifespan: "–1990" } });
    expect(stub).not.toHaveProperty("obj");
    expect(Object.keys(stub.stub).sort()).toEqual(["displayName", "gender", "isLiving", "lifespan"]);
    expect(stub.stub.lifespan).toMatch(/^\d{0,4}–\d{0,4}$/);
  });

  it("404s for the Tag class, which has no schema", async () => {
    const w = await world();
    expect((await w.get("/api/edit/Tag/T0001", ME)).status).toBe(404);
  });
  it("404 for an unknown record, class, malformed ref or tombstone; 409 ambiguous_id for a shared gramps_id (candidates for admins only)", async () => {
    const w = await world();
    for (const path of [`/api/edit/Person/${h(77)}`, "/api/edit/Person/I7777", "/api/edit/Widget/abc", `/api/edit/Person/h:${"x".repeat(80)}`, "/api/edit/Person/a%20b"]) {
      const r = await w.get(path, ME);
      expect([path, r.status, r.body.error]).toEqual([path, 404, "not_found"]);
    }
    w.twin(OTHER, h(7));
    const m = await w.get(`/api/edit/Person/${OTHER}`, ME);
    expect(m.status).toBe(409);
    expect(m.body.error).toBe("ambiguous_id");
    expect(JSON.stringify(m.body)).not.toContain(w.other.handle);
    const a = await w.get(`/api/edit/Person/${OTHER}`, ADMIN);
    expect(a.status).toBe(409);
    expect(a.body.details.candidates).toHaveLength(2);
  });
});

describe("read-side views (AC4, Q2-04b, PS-07)", () => {
  it("gives a non-owner no day or month on another person's non-birth date", async () => {
    const w = await world();
    const r = await w.get(`/api/edit/Person/${OTHER}`, ME);
    const ev = r.body.related[`Event:${w.otherDeath.handle}`].obj;
    expect(ev.date.dateval).toEqual([0, 0, 1980, false]);
    expect(JSON.stringify(r.body)).not.toMatch(/9 Nov/);
    const direct = await w.get(`/api/edit/Event/${w.otherDeath.gramps_id}`, ME);
    expect(direct.body.obj.date.dateval).toEqual([0, 0, 1980, false]);
  });
  it("keeps the day for the owner's own-only event, and for admins", async () => {
    const w = await world();
    expect((await w.get(`/api/edit/Person/${ME}`, ME)).body.related[`Event:${w.ownDeath.handle}`].obj.date.dateval).toEqual([14, 3, 1990, false]);
    expect((await w.get(`/api/edit/Person/${OTHER}`, ADMIN)).body.related[`Event:${w.otherDeath.handle}`].obj.date.dateval).toEqual([9, 11, 1980, false]);
  });
  it("leaves a hidden note out of obj and related for a non-owner, and keeps it for an admin and for the owner of the page", async () => {
    const w = await world();
    w.mod(`note:${w.n1.handle}`, ADMIN);
    const other = await w.get(`/api/edit/Person/${OTHER}`, THIRD);
    expect(other.body.obj.note_list).toEqual([]);
    expect(other.body.related).not.toHaveProperty(`Note:${w.n1.handle}`);
    expect((await w.get(`/api/edit/Note/${w.n1.gramps_id}`, THIRD)).status).toBe(404);
    expect((await w.get(`/api/edit/Person/${OTHER}`, ADMIN)).body.obj.note_list).toEqual([w.n1.handle]);
    expect((await w.get(`/api/edit/Person/${ME}`, ME)).body.obj.note_list).toEqual([w.n1.handle]);
  });
});

describe("pending[] visibility (AC5, PS-09)", () => {
  it("lists own proposals, proposals about the viewer's own Person or Family, and everything for admins; a third member sees []", async () => {
    const w = await world();
    const key = `Person:${w.other.handle}`;
    const mine = w.proposal(key, ME, [key]);
    const theirs = w.proposal(key, OTHER, [key]);
    const aboutMe = w.proposal(key, OTHER, [key, `Person:${w.me.handle}`]);
    const aboutMyFamily = w.proposal(key, OTHER, [key, `Family:${w.fam.handle}`]);
    w.proposal(key, OTHER, [key], "approved");
    const ids = (r) => r.body.pending.map((p) => p.proposalId).sort();
    expect(ids(await w.get(`/api/edit/Person/${OTHER}`, ME))).toEqual([mine, aboutMe, aboutMyFamily].sort());
    expect(ids(await w.get(`/api/edit/Person/${OTHER}`, ADMIN))).toEqual([mine, theirs, aboutMe, aboutMyFamily].sort());
    expect(ids(await w.get(`/api/edit/Person/${OTHER}`, OTHER))).toEqual([mine, theirs, aboutMe, aboutMyFamily].sort()); // the page's own owner sees every proposal about it
    const third = await w.get(`/api/edit/Person/${OTHER}`, THIRD);
    expect(third.status).toBe(200);
    expect(third.body.pending).toEqual([]);
  });
  it("lists only state and the paths on this record, never an op value or the note", async () => {
    const w = await world();
    const key = `Person:${w.other.handle}`;
    w.proposal(key, ADMIN, [key]);
    const r = await w.get(`/api/edit/Person/${OTHER}`, ADMIN);
    expect(r.body.pending).toEqual([{ proposalId: expect.any(String), state: "pending", paths: ["/primary_name/first_name"] }]);
    expect(JSON.stringify(r.body)).not.toMatch(/SECRET/);
  });
});

describe("GET /api/edit/schema/:cls", () => {
  it("serves the committed schema with a hash, for every editable class", async () => {
    const w = await world();
    for (const cls of SCHEMA_CLASSES) {
      const r = await w.get(`/api/edit/schema/${cls}`, ME);
      expect([cls, r.status]).toEqual([cls, 200]);
      expect(r.body).toMatchObject({ class: cls, schemaHash: schemaHash() });
      expect(r.body.schema.title).toBe(cls);
      expect(r.body.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
  it("404s for a class with no schema", async () => {
    const w = await world();
    for (const cls of ["Tag", "Widget"]) expect((await w.get(`/api/edit/schema/${cls}`, ME)).status).toBe(404);
  });
});

describe("registry and caps (AC3)", () => {
  it("lists the routes behind HFY_EDITING, read-only, with no MCP tool", () => {
    const caps = buildCaps();
    for (const [name, path] of [["edit.schema", "/api/edit/schema/:cls"], ["edit.get", "/api/edit/:cls/:ref"]]) {
      expect(caps.actions.find((a) => a.name === name)).toMatchObject({ method: "GET", path, write: false, auth: "session", gate: { switch: "HFY_EDITING" } });
      expect(ROUTES.find((r) => r.name === name).mcp).toBeUndefined();
    }
    expect(ROUTES.findIndex((r) => r.name === "edit.schema")).toBeLessThan(ROUTES.findIndex((r) => r.name === "edit.get"));
  });
});
