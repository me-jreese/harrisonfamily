// HFY-TSK-175 (records-read-api): GET /api/records/:class/:handle and /api/records/Person/by-id/:gramps_id. In-memory DynamoDB fake, synthetic ids and dates only.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeApi, signToken, TABLE, cmds } from "./world.js";
import { applyBatch } from "../src/sync/apply.js";
import { headKey } from "../src/sync/store.js";
import { buildCaps, ROUTES } from "../src/routes.js";
import { applyModOverlay, collectModTargets, hasFineDate, publishView } from "../src/records/read.js";

const h = (n) => n.toString(16).padStart(28, "0");
const typ = (cls, value, string = "") => ({ _class: cls, value, string });
const date = (d, m, y, extra = {}) => ({ _class: "Date", calendar: 0, dateval: [d, m, y, false], format: null, modifier: 0, newyear: 0, quality: 0, sortval: d || m ? 2400000 + d : 0, text: "", ...extra });
const person = (n, extra = {}) => ({ _class: "Person", handle: h(n), gramps_id: `I${String(n).padStart(4, "0")}`, change: 1, private: false, gender: 1, event_ref_list: [], family_list: [], parent_family_list: [], media_list: [], note_list: [], address_list: [], ...extra });
const event = (n, d, extra = {}) => ({ _class: "Event", handle: h(2000 + n), gramps_id: `E${String(n).padStart(4, "0")}`, change: 1, private: false, type: typ("EventType", 21), date: d, media_list: [], note_list: [], ...extra });
const note = (n, extra = {}) => ({ _class: "Note", handle: h(3000 + n), gramps_id: `N${String(n).padStart(4, "0")}`, change: 1, private: false, text: { _class: "StyledText", string: "synthetic" }, ...extra });
const media = (n, extra = {}) => ({ _class: "Media", handle: h(4000 + n), gramps_id: `O${String(n).padStart(4, "0")}`, change: 1, private: false, path: "synthetic.jpg", mime: "image/jpeg", ...extra });
const primary = (ev) => ({ _class: "EventRef", ref: ev.handle, role: typ("EventRoleType", 1) });
const create = (obj) => ({ op: "create", class: obj._class, handle: obj.handle, base_version: null, obj });
const del = (cls, handle, base) => ({ op: "delete", class: cls, handle, base_version: base });

const ME = "I0001"; // the signed-in member's own Person
const OTHER = "I0002";
const ADMIN = "I0099";
const q = { warn() {}, error() {} };

let envBefore;
beforeEach(() => { envBefore = process.env.HFY_EDITING; process.env.HFY_EDITING = "on"; });
afterEach(() => { if (envBefore === undefined) delete process.env.HFY_EDITING; else process.env.HFY_EDITING = envBefore; });

/** An API over a seeded store. Tree: ME (own death event, a shared residence, a note, a photo), OTHER (a death event with a full date). */
async function world() {
  const w = makeApi({ log: q });
  w.ddb.rows.set("SYNC#HEAD\u0000META", { ...headKey(), seq: 0, seeded: true, writes_enabled: true });
  let t = Date.parse("2026-10-14T00:00:00Z");
  let u = 0;
  const ctx = { ddb: w.ddb, cmds, table: TABLE, now: () => (t += 1000), uid: () => `u${++u}`, unsafeNoValidate: true, log: q, txnOpts: { sleep: async () => {} } };
  let k = 0;
  const apply = (ops) => applyBatch(ctx, { principal: "svc-test", origin: "desktop", idempotencyKey: `k${++k}`, ops });
  const ownDeath = event(1, date(14, 3, 1990)); // referenced only by ME, as Primary
  const otherDeath = event(2, date(9, 11, 1980, { text: "9 Nov 1980" }));
  const shared = event(3, date(5, 6, 1970)); // referenced by both people
  const n1 = note(1);
  const n2 = note(2);
  const m1 = media(1);
  const m2 = media(2);
  const me = person(1, {
    event_ref_list: [primary(ownDeath), primary(shared)], note_list: [n1.handle, n2.handle],
    media_list: [{ _class: "MediaRef", ref: m1.handle, rect: null }, { _class: "MediaRef", ref: m2.handle, rect: null }],
    address_list: [{ _class: "Address", date: date(1, 2, 1999), city: "Synthville" }],
  });
  const other = person(2, { event_ref_list: [primary(otherDeath), primary(shared)], note_list: [n1.handle], media_list: [{ _class: "MediaRef", ref: m1.handle, rect: null }], address_list: [{ _class: "Address", date: date(3, 4, 1988), city: "Synthville" }] });
  await apply([me, other, ownDeath, otherDeath, shared, n1, n2, m1, m2].map(create));
  const mod = (target, author_id, extra = {}) => w.ddb.rows.set(`MOD#${target}\u0000META`, { PK: `MOD#${target}`, SK: "META", entity: "mod", author_id, state: "hidden", hidden: true, open: true, ...extra });
  const get = async (path, who) => w.call("GET", path, { token: who ? await signToken(who) : undefined });
  return { ...w, apply, get, me, other, ownDeath, otherDeath, shared, n1, n2, m1, m2, mod };
}

describe("merged-person alias (merge-alias-redirect)", () => {
  const alias = (w, old, current, extra = {}) => w.ddb.rows.set(`IDALIAS#Person#${old}\u0000META`, { PK: `IDALIAS#Person#${old}`, SK: "META", entity: "idalias", class: "Person", old_gramps_id: old, handle: h(900), current_gramps_id: current, reason: "merge", ...extra });

  it("answers {mergedInto} for an old id whose alias names a live person", async () => {
    const w = await world();
    alias(w, "I0777", OTHER);
    const r = await w.get("/api/records/Person/by-id/I0777", ME);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ mergedInto: OTHER });
  });

  it("answers an admin the same, and a member only when the gate lets them in", async () => {
    const w = await world();
    alias(w, "I0777", OTHER);
    expect((await w.get("/api/records/Person/by-id/I0777", ADMIN)).body).toEqual({ mergedInto: OTHER });
    process.env.HFY_EDITING = "off";
    expect((await w.get("/api/records/Person/by-id/I0777", ME)).status).toBe(404); // not the member's own id
    expect((await w.get("/api/records/Person/by-id/I0777")).status).toBe(404); // signed out
  });

  it("is 404 when there is no alias, the survivor is not live, the alias points at itself or has no survivor", async () => {
    const w = await world();
    alias(w, "I0778", "I5555"); // no such person
    alias(w, "I0779", "I0779");
    alias(w, "I0780", null);
    for (const id of ["I0778", "I0779", "I0780", "I0781"]) {
      const r = await w.get(`/api/records/Person/by-id/${id}`, ME);
      expect(r.status).toBe(404);
    }
  });

  it("a live person with the id wins over an alias", async () => {
    const w = await world();
    alias(w, OTHER, ME);
    const r = await w.get(`/api/records/Person/by-id/${OTHER}`, ME);
    expect(r.body.handle).toBe(w.other.handle);
  });
});

describe("shape and lookup (AC1, AC2)", () => {
  it("returns {class, handle, gramps_id, version, obj} with ETag v<version> to a signed-in member, by handle and by gramps_id", async () => {
    const w = await world();
    const r = await w.get(`/api/records/Person/${w.other.handle}`, ME);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body)).toEqual(["class", "handle", "gramps_id", "version", "obj"]);
    expect(r.body).toMatchObject({ class: "Person", handle: w.other.handle, gramps_id: OTHER, version: 1 });
    expect(r.headers.etag).toBe('"v1"');
    const byId = await w.get(`/api/records/Person/by-id/${OTHER}`, ME);
    expect(byId.status).toBe(200);
    expect(byId.body).toEqual(r.body);
    expect(byId.headers.etag).toBe('"v1"');
  });

  it("the ETag follows the stored version", async () => {
    const w = await world();
    await w.apply([{ op: "update", class: "Note", handle: w.n2.handle, base_version: 1, obj: { ...w.n2, change: 2 } }]);
    const r = await w.get(`/api/records/Note/${w.n2.handle}`, ADMIN);
    expect(r.body.version).toBe(2);
    expect(r.headers.etag).toBe('"v2"');
  });

  it("answers 404 for a tombstone, an unknown handle, an unknown id, an unknown class and a malformed handle", async () => {
    const w = await world();
    await w.apply([del("Note", w.n2.handle, 1)]);
    for (const path of [`/api/records/Note/${w.n2.handle}`, `/api/records/Person/${h(77)}`, "/api/records/Person/by-id/I7777", "/api/records/Widget/abc", `/api/records/Person/${"x".repeat(80)}`, "/api/records/Person/by-id"]) {
      const r = await w.get(path, ME);
      expect([path, r.status, r.body.error]).toEqual([path, 404, "not_found"]);
    }
  });

  it("needs a session (401) and is read-only (405 for any other method)", async () => {
    const w = await world();
    expect((await w.get(`/api/records/Person/${w.me.handle}`)).status).toBe(401);
    const token = await signToken(ME);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) expect((await w.call(method, `/api/records/Person/${w.me.handle}`, { token, body: {} })).status).toBe(405);
  });

  it("is listed in caps.json behind the HFY_EDITING switch, read-only, with no MCP tool", () => {
    const caps = buildCaps();
    const names = ["records.get", "records.byGrampsId"];
    for (const name of names) {
      expect(caps.actions.find((a) => a.name === name)).toMatchObject({ method: "GET", write: false, auth: "session", gate: { switch: "HFY_EDITING" } });
      expect(ROUTES.find((r) => r.name === name).mcp).toBeUndefined();
    }
    expect(caps.actions.find((a) => a.name === "records.get").path).toBe("/api/records/:class/:handle");
    expect(caps.actions.find((a) => a.name === "records.byGrampsId").path).toBe("/api/records/Person/by-id/:gramps_id");
    expect(caps.mcp.tools.map((t) => t.action).filter((a) => a.startsWith("records."))).toEqual([]);
  });
});

describe("publishView: year-only non-birth dates (AC5, Q2-04b)", () => {
  it("a member's GET returns no day or month on another person's non-birth date, nor its text", async () => {
    const w = await world();
    const r = await w.get(`/api/records/Event/${w.otherDeath.handle}`, ME);
    expect(r.status).toBe(200);
    expect(r.body.obj.date.dateval).toEqual([0, 0, 1980, false]);
    expect(r.body.obj.date.text).toBe("1980");
    expect(r.body.obj.date.sortval).toBe(0);
    expect(JSON.stringify(r.body)).not.toMatch(/9 Nov/);
  });

  it("reduces the dates nested in another person's record, and an event shared with someone else, even for its participant", async () => {
    const w = await world();
    const person = await w.get(`/api/records/Person/${w.other.handle}`, ME);
    expect(person.body.obj.address_list[0].date.dateval).toEqual([0, 0, 1988, false]);
    const shared = await w.get(`/api/records/Event/${w.shared.handle}`, ME);
    expect(shared.body.obj.date.dateval).toEqual([0, 0, 1970, false]);
  });

  it("keeps full precision for admins, for the member's own-only events and for the member's own Person", async () => {
    const w = await world();
    expect((await w.get(`/api/records/Event/${w.otherDeath.handle}`, ADMIN)).body.obj.date.dateval).toEqual([9, 11, 1980, false]);
    const own = await w.get(`/api/records/Event/${w.ownDeath.handle}`, ME);
    expect(own.body.obj.date.dateval).toEqual([14, 3, 1990, false]);
    expect(own.body.obj.date.sortval).not.toBe(0);
    expect((await w.get(`/api/records/Person/${w.me.handle}`, ME)).body.obj.address_list[0].date.dateval).toEqual([1, 2, 1999, false]);
    // another member does not get the first member's own-only event in full
    expect((await w.get(`/api/records/Event/${w.ownDeath.handle}`, OTHER)).body.obj.date.dateval).toEqual([0, 0, 1990, false]);
  });

  it("does not change the stored object", async () => {
    const w = await world();
    await w.get(`/api/records/Event/${w.otherDeath.handle}`, ME);
    const row = w.ddb.rows.get(`REC#Event#${w.otherDeath.handle}\u0000HEAD`);
    expect(JSON.parse(row.obj_json).date.dateval).toEqual([9, 11, 1980, false]);
  });

  it("publishView unit: text-only dates, range tuples, years kept, input untouched", () => {
    const viewer = { id: ME, admin: false };
    const input = { _class: "Event", handle: "x", date: date(1, 2, 1950, { modifier: 5, dateval: [1, 2, 1950, false, 3, 4, 1960, false], text: "" }), alt: date(0, 0, 0, { text: "March 3 1944" }), plain: date(0, 0, 1950, { text: "1950" }) };
    const frozen = JSON.stringify(input);
    const out = publishView(input, viewer);
    expect(JSON.stringify(input)).toBe(frozen);
    expect(out.date.dateval).toEqual([0, 0, 1950, false, 0, 0, 1960, false]);
    expect(out.alt.text).toBe("1944");
    expect(out.plain).toEqual(input.plain);
    expect(hasFineDate(out)).toBe(false);
    expect(hasFineDate(input)).toBe(true);
    expect(publishView(input, { id: ADMIN, admin: true })).toBe(input);
  });
});

describe("applyModOverlay: hidden items (AC4, PS-07)", () => {
  it("a non-owner member gets no hidden note ref, MediaRef or Media, on any record that carries them", async () => {
    const w = await world();
    w.mod(`note:${w.n1.handle}`, ME);
    w.mod(`mediaref:${w.other.handle}:${w.m1.handle}`, OTHER);
    w.mod(`media:${w.m2.handle}`, ME);
    const person = await w.get(`/api/records/Person/${w.other.handle}`, "I0003");
    expect(person.status).toBe(200);
    expect(person.body.obj.note_list).toEqual([]);
    expect(person.body.obj.media_list).toEqual([]);
    const mine = (await w.get(`/api/records/Person/${w.me.handle}`, "I0003")).body.obj;
    expect(mine.note_list).toEqual([w.n2.handle]); // n1 hidden, n2 not
    expect(mine.media_list.map((r) => r.ref)).toEqual([w.m1.handle]); // m2 hidden as Media; the mediaref of OTHER's m1 is not this holder's
    for (const [cls, handle] of [["Note", w.n1.handle], ["Media", w.m2.handle]]) expect((await w.get(`/api/records/${cls}/${handle}`, "I0003")).status).toBe(404);
    expect((await w.get(`/api/records/Note/${w.n2.handle}`, "I0003")).status).toBe(200);
  });

  it("admins and the item's owner see hidden items; a closed or non-hiding MOD# item hides nothing", async () => {
    const w = await world();
    w.mod(`note:${w.n1.handle}`, ME);
    w.mod(`note:${w.n2.handle}`, ME, { open: false }); // closed
    w.mod(`media:${w.m1.handle}`, ME, { hidden: false, state: "question" }); // a question that does not hide
    for (const who of [ADMIN, ME]) {
      expect((await w.get(`/api/records/Person/${w.me.handle}`, who)).body.obj.note_list).toEqual([w.n1.handle, w.n2.handle]);
      expect((await w.get(`/api/records/Note/${w.n1.handle}`, who)).status).toBe(200);
    }
    const stranger = (await w.get(`/api/records/Person/${w.me.handle}`, OTHER)).body.obj;
    expect(stranger.note_list).toEqual([w.n2.handle]);
    expect(stranger.media_list.map((r) => r.ref)).toEqual([w.m1.handle, w.m2.handle]);
  });

  it("unit: targets are collected from nested lists and the overlay returns a copy", () => {
    const obj = { handle: "p", note_list: ["a"], media_list: [{ ref: "m" }], address_list: [{ note_list: ["b"], media_list: [{ ref: "n" }] }] };
    expect(collectModTargets(obj).sort()).toEqual(["media:m", "media:n", "mediaref:p:m", "mediaref:p:n", "note:a", "note:b"]);
    const mods = new Map([["note:b", { author_id: "I1" }], ["mediaref:p:n", { author_id: "I1" }]]);
    const out = applyModOverlay(obj, { id: "I2", admin: false }, mods);
    expect(out.address_list[0]).toEqual({ note_list: [], media_list: [] });
    expect(obj.address_list[0].note_list).toEqual(["b"]);
    expect(applyModOverlay(obj, { id: "I1", admin: false }, mods).address_list[0].note_list).toEqual(["b"]);
  });

  it("fails closed when the MOD# read fails", async () => {
    const w = makeApi({ log: q, intercept: (cmd) => { if (cmd.constructor.name === "GetCommand" && String(cmd.input.Key?.PK).startsWith("MOD#")) throw new Error("boom"); } });
    w.ddb.rows.set("SYNC#HEAD\u0000META", { ...headKey(), seq: 0, seeded: true, writes_enabled: true });
    const p = person(5, { note_list: [h(3001)] });
    const { headItem, objectJson } = await import("../src/sync/store.js");
    const it = headItem({ class: "Person", handle: p.handle, gramps_id: p.gramps_id, version: 1, seq: 1, deleted: false, objJson: objectJson(p), at: "2026-10-14T00:00:00Z", by: "svc-test", origin: "desktop" });
    w.ddb.rows.set(`${it.PK}\u0000${it.SK}`, it);
    const r = await w.call("GET", `/api/records/Person/${p.handle}`, { token: await signToken(ME) });
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toMatch(/synthetic|Synthville/);
  });
});

describe("the HFY_EDITING switch (AC6)", () => {
  it("while off, admins and a member reading their own record pass; everyone else gets 404", async () => {
    const w = await world();
    process.env.HFY_EDITING = "off";
    const ok = [
      [ADMIN, `/api/records/Person/${w.other.handle}`], [ADMIN, `/api/records/Person/by-id/${OTHER}`],
      [ME, `/api/records/Person/${w.me.handle}`], [ME, `/api/records/Person/by-id/${ME}`],
      [ME, `/api/records/Note/${w.n1.handle}`], [ME, `/api/records/Event/${w.ownDeath.handle}`], [ME, `/api/records/Media/${w.m1.handle}`],
    ];
    for (const [who, path] of ok) expect([who, path, (await w.get(path, who)).status]).toEqual([who, path, 200]);
    const dark = [
      [ME, `/api/records/Person/${w.other.handle}`], [ME, `/api/records/Person/by-id/${OTHER}`], [ME, `/api/records/Event/${w.otherDeath.handle}`],
      [ME, `/api/records/Note/${w.n2.handle}`.replace(w.n2.handle, h(3999))], [OTHER, `/api/records/Note/${w.n2.handle}`], [null, `/api/records/Person/${w.me.handle}`],
    ];
    for (const [who, path] of dark) {
      const r = await w.get(path, who);
      expect([who, path, r.status, r.body.error]).toEqual([who, path, 404, "not_found"]);
    }
  });

  it("an unset or unknown value counts as off, and the value on opens the routes to every member", async () => {
    const w = await world();
    delete process.env.HFY_EDITING;
    expect((await w.get(`/api/records/Person/${w.other.handle}`, ME)).status).toBe(404);
    process.env.HFY_EDITING = "ON";
    expect((await w.get(`/api/records/Person/${w.other.handle}`, ME)).status).toBe(404);
    process.env.HFY_EDITING = "on";
    expect((await w.get(`/api/records/Person/${w.other.handle}`, ME)).status).toBe(200);
  });

  it("a member with an ambiguous or missing own record gets nothing extra while off", async () => {
    const w = await world();
    process.env.HFY_EDITING = "off";
    expect((await w.get(`/api/records/Person/${w.me.handle}`, "I4444")).status).toBe(404);
  });
});

describe("review fixes (HFY-TSK-175 round 2)", () => {
  it("while off, a shared Event is not the member's own record (404), an own-only Event is", async () => {
    const w = await world();
    process.env.HFY_EDITING = "off";
    expect((await w.get(`/api/records/Event/${w.shared.handle}`, ME)).status).toBe(404);
    expect((await w.get(`/api/records/Event/${w.ownDeath.handle}`, ME)).status).toBe(200);
  });

  it("an event_ref with no role is not Primary: full dates need an explicit Primary role", async () => {
    const w = await world();
    const roleless = event(7, date(2, 3, 1960));
    const noRole = { _class: "EventRef", ref: roleless.handle };
    await w.apply([create(roleless), { op: "update", class: "Person", handle: w.me.handle, base_version: 1, obj: { ...w.me, event_ref_list: [...w.me.event_ref_list, noRole] } }]);
    const r = await w.get(`/api/records/Event/${roleless.handle}`, ME);
    expect(r.status).toBe(200);
    expect(r.body.obj.date.dateval).toEqual([0, 0, 1960, false]);
    process.env.HFY_EDITING = "off";
    expect((await w.get(`/api/records/Event/${roleless.handle}`, ME)).status).toBe(404);
  });

  it("the owner (the member whose own Person holds the item) sees a note another member's MOD# item hides", async () => {
    const w = await world();
    w.mod(`note:${w.n2.handle}`, OTHER); // raised by someone else; ME's Person holds n2
    expect((await w.get(`/api/records/Person/${w.me.handle}`, ME)).body.obj.note_list).toContain(w.n2.handle);
    expect((await w.get(`/api/records/Note/${w.n2.handle}`, ME)).status).toBe(200);
    expect((await w.get(`/api/records/Note/${w.n2.handle}`, "I0003")).status).toBe(404);
    // OTHER holds n1 only, so OTHER is not the owner of n2 (and did raise it, so sees it as author)
    w.mod(`note:${w.n1.handle}`, "I0003");
    expect((await w.get(`/api/records/Note/${w.n1.handle}`, OTHER)).status).toBe(200);
  });

  it("a duplicate gramps_id answers 409 to admins and 404 to members", async () => {
    const w = await world();
    const [key, row] = [...w.ddb.rows].find(([k, v]) => k.startsWith("REC#Person#") && v.gramps_id === ME && v.SK === "HEAD");
    const h2 = h(50);
    const copy = { ...row, PK: row.PK.replace(w.me.handle, h2), handle: h2 };
    for (const k of Object.keys(copy)) if (typeof copy[k] === "string" && copy[k].includes(w.me.handle) && k !== "obj_json") copy[k] = copy[k].replace(w.me.handle, h2);
    w.ddb.rows.set(`${copy.PK}\u0000${copy.SK}`, copy);
    expect((await w.get(`/api/records/Person/by-id/${ME}`, ADMIN)).status).toBe(409);
    expect((await w.get(`/api/records/Person/by-id/${ME}`, OTHER)).status).toBe(404);
  });
});
