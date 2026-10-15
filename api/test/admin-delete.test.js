// HFY-TSK-295 (edit-admin-delete; Q2-15, review IF-03): POST /api/admin/deletes and GET /api/admin/duplicates. In-memory DynamoDB fake; synthetic ids,
// names and handles only.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SignJWT, importPKCS8 } from "jose";
import { AUDIENCE, ISSUER, cmds, makeApi, pem, signToken, TABLE } from "./world.js";
import { applyBatch } from "../src/sync/apply.js";
import { createHookRegistry } from "../src/sync/hooks.js";
import { headKey } from "../src/sync/store.js";
import { ROUTES } from "../src/routes.js";
import { budgetVerdict } from "../src/sync/validator.js";
import { cleanOps, DELETABLE_CLASSES } from "../src/records/admin-delete.js";
import { findDuplicatePairs, summarizePerson } from "../src/records/duplicates.js";

const h = (n) => n.toString(16).padStart(28, "0");
const typ = (cls, value, string = "") => ({ _class: cls, value, string });
const date = (dateval = [0, 0, 0, false]) => ({ _class: "Date", calendar: 0, dateval, format: null, modifier: 0, newyear: 0, quality: 0, sortval: 0, text: "" });
const person = (n, extra = {}) => ({
  _class: "Person", handle: h(n), gramps_id: `I${String(n).padStart(4, "0")}`, private: false, gender: 1,
  primary_name: { _class: "Name", first_name: extra.first ?? "Alder", nick: "", surname_list: [{ _class: "Surname", primary: true, surname: extra.last ?? "Testwood" }], type: typ("NameType", 2), date: date() },
  event_ref_list: [], birth_ref_index: -1, death_ref_index: -1, family_list: [], parent_family_list: [], note_list: [], media_list: [], citation_list: [], urls: [], ...extra.rest,
});
const family = (n, extra = {}) => ({ _class: "Family", handle: h(1000 + n), gramps_id: `F${String(n).padStart(4, "0")}`, private: false, father_handle: null, mother_handle: null, child_ref_list: [], event_ref_list: [], type: typ("FamilyRelType", 3), note_list: [], media_list: [], attribute_list: [], citation_list: [], tag_list: [], lds_ord_list: [], ...extra });
const note = (n) => ({ _class: "Note", handle: h(2000 + n), gramps_id: `N${String(n).padStart(4, "0")}`, private: false, text: { _class: "StyledText", string: `Synthetic note ${n}`, tags: [] }, format: 0, type: typ("NoteType", 1) });
const event = (n, type, dateval, extra = {}) => ({ _class: "Event", handle: h(3000 + n), gramps_id: `E${String(n).padStart(4, "0")}`, private: false, type: typ("EventType", type), date: date(dateval), description: "", place: "", citation_list: [], note_list: [], media_list: [], attribute_list: [], tag_list: [], ...extra });
const eref = (ev, role = 1) => ({ _class: "EventRef", ref: ev.handle, role: typ("EventRoleType", role), private: false, attribute_list: [], note_list: [] });
const cref = (p) => ({ _class: "ChildRef", ref: p.handle, frel: typ("ChildRefType", 1), mrel: typ("ChildRefType", 1), private: false, citation_list: [], note_list: [] });
const place = (n, extra = {}) => ({ _class: "Place", handle: h(6000 + n), gramps_id: `P${String(n).padStart(4, "0")}`, private: false, place_type: typ("PlaceType", 3), title: "", code: "", lat: "", long: "", name: { _class: "PlaceName", value: `Synthville ${n}`, lang: "", date: date() }, placeref_list: [], alt_names: [], urls: [], note_list: [], media_list: [], citation_list: [], tag_list: [], ...extra });
const source = (n) => ({ _class: "Source", handle: h(7000 + n), gramps_id: `S${String(n).padStart(4, "0")}`, private: false, title: `A synthetic ledger ${n}`, author: "", pubinfo: "", abbrev: "", note_list: [], media_list: [], reporef_list: [], attribute_list: [], tag_list: [] });
const citation = (n, src, extra = {}) => ({ _class: "Citation", handle: h(8000 + n), gramps_id: `C${String(n).padStart(4, "0")}`, private: false, source_handle: src.handle, page: `p. ${n}`, confidence: 2, date: date(), note_list: [], media_list: [], attribute_list: [], tag_list: [], ...extra });
const media = (n, extra = {}) => ({ _class: "Media", handle: h(9000 + n), gramps_id: `O${String(n).padStart(4, "0")}`, private: false, path: `photo-${n}.jpg`, mime: "image/jpeg", desc: "A synthetic photo", checksum: "", date: date(), attribute_list: [], citation_list: [], note_list: [], tag_list: [], ...extra });
const mref = (m) => ({ _class: "MediaRef", private: false, citation_list: [], note_list: [], attribute_list: [], ref: m.handle, rect: [10, 10, 30, 30] });
const create = (obj) => ({ op: "create", class: obj._class, handle: obj.handle, base_version: null, obj });
const key = (obj) => `${obj._class}:${obj.handle}`;

const MEMBER = "I0001";
const ADMIN = "I0099";
const q = { warn() {}, error() {} };

let envBefore;
beforeEach(() => { envBefore = process.env.HFY_EDITING; process.env.HFY_EDITING = "on"; });
afterEach(() => { if (envBefore === undefined) delete process.env.HFY_EDITING; else process.env.HFY_EDITING = envBefore; });

// The tree. A father (1), a mother (2) and their child (3) are family F1; the family has a marriage event. The child's birth event (E1) is the
// child's alone, has a place and a citation; a shared event (E3) belongs to the father and to an unrelated person (4). The citation is of a source.
// The child holds a photo tag. Orphans (one of every deletable class) have nothing pointing at them. 200 notes keep the 5 % share of live heads clear.
function tree(extra = []) {
  const src = source(1);
  const cit = citation(1, src);
  const pl = place(1);
  const photo = media(1);
  const birth = event(1, 12, [0, 0, 1990, false], { place: pl.handle, citation_list: [cit.handle] });
  const wedding = event(2, 3, [0, 0, 2015, false]);
  const shared = event(3, 6, [0, 0, 2001, false]);
  const fam = family(1, { father_handle: h(1), mother_handle: h(2), child_ref_list: [cref({ handle: h(3) })], event_ref_list: [eref(wedding)] });
  const dad = person(1, { first: "Alder", rest: { family_list: [fam.handle], event_ref_list: [eref(shared)] } });
  const mum = person(2, { first: "Birch", rest: { gender: 0, family_list: [fam.handle] } });
  const kid = person(3, { first: "Cedar", rest: { parent_family_list: [fam.handle], event_ref_list: [eref(birth)], birth_ref_index: 0, citation_list: [cit.handle], media_list: [mref(photo)] } });
  const other = person(4, { first: "Dale", last: "Elmwood", rest: { event_ref_list: [eref(shared)] } });
  const orphans = [person(50, { first: "Orla" }), family(50), event(50, 12, [0, 0, 1900, false]), place(50), source(50), media(50)];
  orphans.push(citation(50, source(1), {}));
  const filler = Array.from({ length: 200 }, (_, i) => note(500 + i));
  return { src, cit, pl, photo, birth, wedding, shared, fam, dad, mum, kid, other, orphans, objects: [dad, mum, kid, other, fam, birth, wedding, shared, pl, src, cit, photo, ...orphans, ...filler, ...extra] };
}

const state = { flags: { adminDelete: true } };
async function world({ clock = () => Date.now(), extra = [], admins = [ADMIN], seed } = {}) {
  const txns = [];
  const hooks = createHookRegistry();
  const w = makeApi({
    admins, log: q, clock, flags: async () => ({ ...state.flags }),
    intercept: async (cmd) => { if (cmd.constructor.name === "TransactWriteCommand") txns.push(structuredClone(cmd.input)); },
    extraDeps: { syncHooks: hooks, idPolicy: { mode: "mint" }, getAdmins: async () => new Set(admins), txnOpts: { sleep: async () => {} } },
  });
  w.ddb.rows.set("SYNC#HEAD\u0000META", { ...headKey(), seq: 0, seeded: true, writes_enabled: true });
  let t = Date.parse("2026-10-14T00:00:00Z");
  let u = 0;
  const sctx = { ddb: w.ddb, cmds, table: TABLE, now: () => (t += 1000), uid: () => `s${++u}`, unsafeNoValidate: true, log: q, txnOpts: { sleep: async () => {} } };
  let k = 0;
  const seedAll = async (objs) => {
    for (let i = 0; i < objs.length; i += 20) await applyBatch(sctx, { principal: "svc-seed", origin: "desktop", idempotencyKey: `seed${++k}`, ops: objs.slice(i, i + 20).map(create) });
  };
  const tr = tree(extra);
  await seedAll(seed ? seed(tr) : tr.objects);
  txns.length = 0;
  w.ddb.calls.length = 0;
  const authToken = async (sub, authTime) => {
    const priv = await importPKCS8(pem, "RS256");
    return new SignJWT({ client_id: AUDIENCE, token_use: "access", name: sub, ...(authTime === undefined ? {} : { auth_time: authTime }) })
      .setProtectedHeader({ alg: "RS256", kid: "hfy-session-1" }).setSubject(sub).setIssuer(ISSUER).setAudience(AUDIENCE).setIssuedAt().setExpirationTime("1h").sign(priv);
  };
  const fresh = (sub = ADMIN) => authToken(sub, Math.floor(Date.now() / 1000) - 120);
  const del = async (who, body, { idem, token } = {}) =>
    w.call("POST", "/api/admin/deletes", { token: token ?? (who === ADMIN ? await fresh() : await signToken(who)), body, headers: idem ? { "idempotency-key": idem } : {} });
  const dups = async (who, query) => w.call("GET", "/api/admin/duplicates", { token: who === ADMIN ? await fresh() : await signToken(who), ...(query ? { query } : {}) });
  const head = (obj) => w.ddb.rows.get(`REC#${obj._class}#${obj.handle}\u0000HEAD`);
  const objOf = (obj) => { const r = head(obj); return r && !r.deleted ? JSON.parse(r.obj_json) : null; };
  const gone = (obj) => head(obj)?.deleted === true;
  const versionOf = (obj) => head(obj).version;
  const bv = (...objs) => Object.fromEntries(objs.map((o) => [key(o), versionOf(o)]));
  const rows = (prefix) => w.ddb.all().filter((r) => r.PK.startsWith(prefix));
  return { ...w, txns, del, dups, head, objOf, gone, versionOf, bv, rows, authToken, fresh, tr, seedAll, sctx };
}
const writes = (w) => w.ddb.calls.filter((c) => /^(Put|Update|Delete|TransactWrite)Command$/.test(c)).length;
const err = (r) => ({ status: r.status, error: r.body?.error });
const mk = (w, objs, extra = {}) => ({ targets: objs.map(key), base_versions: w.bv(...objs), ...extra });

describe("who may use it, and when (AC1)", () => {
  it("a member gets 403 not_allowed on both routes, and nothing is written", async () => {
    const w = await world();
    const r = await w.del(MEMBER, mk(w, [w.tr.orphans[0]]), { idem: "m-1" });
    expect(err(r)).toEqual({ status: 403, error: "not_allowed" });
    expect(err(await w.dups(MEMBER))).toEqual({ status: 403, error: "not_allowed" });
    expect(w.gone(w.tr.orphans[0])).toBe(false);
    expect(w.txns).toEqual([]);
  });

  it("is a 404 for everyone, an admin included, while the adminDelete flag is off; a uat admin reaches it", async () => {
    state.flags = { adminDelete: false };
    try {
      const w = await world();
      expect(err(await w.del(ADMIN, mk(w, [w.tr.orphans[0]]), { idem: "f-1" }))).toEqual({ status: 404, error: "not_found" });
      expect(err(await w.del(MEMBER, mk(w, [w.tr.orphans[0]]), { idem: "f-2" }))).toEqual({ status: 404, error: "not_found" });
      expect(err(await w.dups(ADMIN))).toEqual({ status: 404, error: "not_found" });
      expect(w.gone(w.tr.orphans[0])).toBe(false);
    } finally { state.flags = { adminDelete: true }; }
  });

  it("is a 404 while HFY_EDITING is off, even with the flag on", async () => {
    const w = await world();
    process.env.HFY_EDITING = "off";
    expect(err(await w.del(ADMIN, mk(w, [w.tr.orphans[0]]), { idem: "e-1" }))).toEqual({ status: 404, error: "not_found" });
    expect(err(await w.dups(ADMIN))).toEqual({ status: 404, error: "not_found" });
  });

  it("signed out is 401, and the routes are registered with the feature gate and no MCP tool", async () => {
    const w = await world();
    expect((await w.call("POST", "/api/admin/deletes", { body: {} })).status).toBe(401);
    for (const name of ["adminDeletes.post", "adminDuplicates.list"]) {
      const route = ROUTES.find((r) => r.name === name);
      expect(route.gate).toEqual({ type: "feature", name: "adminDelete" });
      expect(route.mcp).toBeUndefined();
    }
  });

  it("only the seven Q2-15 classes can be targets", async () => {
    expect(DELETABLE_CLASSES).toEqual(["Person", "Family", "Event", "Place", "Source", "Citation", "Media"]);
    const w = await world();
    const n = note(500);
    const r = await w.del(ADMIN, { targets: [key(n)], base_versions: { [key(n)]: 1 } }, { idem: "c-1" });
    expect(err(r)).toEqual({ status: 400, error: "validation" });
    expect(r.body.errors[0].pointer).toBe("/targets/0");
    expect(w.txns).toEqual([]);
  });
});

describe("an admin deletes any of the seven classes (AC1)", () => {
  it.each(["Person", "Family", "Event", "Place", "Source", "Media"])("deletes an unreferenced %s as an applyBatch delete op", async (cls) => {
    const w = await world();
    const target = w.tr.orphans.find((o) => o._class === cls);
    const r = await w.del(ADMIN, mk(w, [target]), { idem: `d-${cls}` });
    expect(r.status).toBe(201);
    expect(r.body.applied.deleted).toEqual([key(target)]);
    expect(r.body.applied.undo).toBeNull();
    expect(w.gone(target)).toBe(true);
    expect(w.txns).toHaveLength(1);
  });

  it("deletes an unreferenced Citation", async () => {
    const w = await world();
    const target = w.tr.orphans.find((o) => o._class === "Citation");
    const r = await w.del(ADMIN, mk(w, [target]), { idem: "d-cit" });
    expect(r.status).toBe(201);
    expect(w.gone(target)).toBe(true);
  });

  it("the commit is an admin-origin applyBatch: the delete is logged and counts against the budget", async () => {
    const w = await world();
    const target = w.tr.orphans[0];
    await w.del(ADMIN, mk(w, [target]), { idem: "d-log" });
    const log = w.rows("SYNC#LOG").filter((x) => x.op === "delete");
    expect(log.map((x) => x.handle)).toEqual([target.handle]);
    expect(w.rows("SYNC#BUDGET#").reduce((n, x) => n + (x.count ?? 0), 0)).toBe(1);
  });
});

describe("step-up: a delete needs a sign-in within 900 s (AC1)", () => {
  it("401 step_up_required when auth_time is older, missing or absent; applied with a fresh sign-in", async () => {
    const w = await world();
    const target = w.tr.orphans[0];
    const body = mk(w, [target]);
    const now = Math.floor(Date.now() / 1000);
    const stale = await w.del(ADMIN, body, { idem: "su-1", token: await w.authToken(ADMIN, now - 2000) });
    expect(err(stale)).toEqual({ status: 401, error: "step_up_required" });
    expect(stale.body.details).toEqual({ maxAgeSeconds: 900 });
    expect(err(await w.del(ADMIN, body, { idem: "su-2", token: await w.authToken(ADMIN, 0) }))).toEqual({ status: 401, error: "step_up_required" });
    expect(err(await w.del(ADMIN, body, { idem: "su-3", token: await w.authToken(ADMIN, undefined) }))).toEqual({ status: 401, error: "step_up_required" });
    expect(w.txns).toEqual([]);
    expect(w.gone(target)).toBe(false);
    const ok = await w.del(ADMIN, body, { idem: "su-4", token: await w.authToken(ADMIN, now - 899) });
    expect(ok.status).toBe(201);
    expect(w.gone(target)).toBe(true);
  });

  it("a dry run asks for it too, so the sheet can send the admin to sign in before they read the plan", async () => {
    const w = await world();
    const stale = await w.del(ADMIN, { ...mk(w, [w.tr.orphans[0]]), dry_run: true }, { token: await w.authToken(ADMIN, Math.floor(Date.now() / 1000) - 5000) });
    expect(err(stale)).toEqual({ status: 401, error: "step_up_required" });
  });
});

describe("the delete/withdraw budget (AC1)", () => {
  it("the rule is the validator's: more than 10 objects, or 5 % of the live heads, in 24 hours", () => {
    expect(budgetVerdict({ rolling: 0, adding: 10, heads: 1000, seq: 5 })).toBeNull();
    expect(budgetVerdict({ rolling: 5, adding: 6, heads: 1000, seq: 5 })).toBe("budget");
    expect(budgetVerdict({ rolling: 0, adding: 6, heads: 100, seq: 5 })).toBe("budget");
    expect(budgetVerdict({ rolling: 0, adding: 1, heads: undefined, seq: 5 })).toBe("heads_unknown");
    expect(budgetVerdict({ rolling: 0, adding: 1, heads: undefined, seq: 0 })).toBeNull();
  });

  it("the eleventh delete in 24 hours is 403 delete_budget, nothing is written, and a dry run says so beforehand", async () => {
    const extra = Array.from({ length: 12 }, (_, i) => place(100 + i));
    const w = await world({ extra });
    const places = extra;
    expect((await w.del(ADMIN, mk(w, places.slice(0, 6)), { idem: "b-1" })).status).toBe(201);
    const dry = await w.del(ADMIN, { ...mk(w, places.slice(6, 12)), dry_run: true });
    expect(dry.status).toBe(200);
    expect(dry.body.budget).toMatchObject({ used: 6, adding: 6, limit: 10, over: true, reason: "budget" });
    const before = writes(w);
    const r = await w.del(ADMIN, mk(w, places.slice(6, 12)), { idem: "b-2" });
    expect(err(r)).toEqual({ status: 403, error: "delete_budget" });
    expect(r.body.details.reason).toBe("budget");
    expect(writes(w)).toBe(before);
    places.slice(6, 12).forEach((p) => expect(w.gone(p)).toBe(false));
    expect((await w.del(ADMIN, mk(w, places.slice(6, 10)), { idem: "b-3" })).status).toBe(201); // 4 more: 10 in all, within the budget
  });
});

describe("a Person: references, ID retirement and symmetry (AC2)", () => {
  it("is refused with the list of referrers unless remove_references is true, and nothing is written", async () => {
    const w = await world();
    const { kid, fam, birth, cit } = w.tr;
    const r = await w.del(ADMIN, mk(w, [kid]), { idem: "p-1" });
    expect(err(r)).toEqual({ status: 409, error: "still_referenced" });
    expect(r.body.details.referrers.map((x) => x.key)).toEqual([key(fam)]);
    expect(r.body.details.delete.map((x) => [x.key, x.why])).toEqual([[key(kid), "target"], [key(birth), "exclusive_event"]]);
    expect(r.body.details.referrers[0]).toMatchObject({ class: "Family", gramps_id: "F0001" });
    expect(w.txns).toEqual([]);
    expect(w.gone(kid)).toBe(false);
    expect(w.objOf(fam).child_ref_list).toHaveLength(1);
    expect(cit).toBeTruthy();
  });

  it("with remove_references the child is deleted with the event only it used, and the family drops the child in the same batch", async () => {
    const w = await world();
    const { kid, fam, birth, shared, dad } = w.tr;
    const r = await w.del(ADMIN, mk(w, [kid], { remove_references: true }), { idem: "p-2" });
    expect(r.status).toBe(201);
    expect(r.body.applied.deleted).toEqual([key(birth), key(kid)]);
    expect(r.body.applied.versions).toEqual({ [key(fam)]: 2 });
    expect(w.txns).toHaveLength(1); // one transaction
    expect(w.gone(kid)).toBe(true);
    expect(w.gone(birth)).toBe(true);
    expect(w.objOf(fam).child_ref_list).toEqual([]);
    expect(w.objOf(fam).father_handle).toBe(dad.handle);
    expect(w.gone(shared)).toBe(false);
  });

  it("retires the gramps_id for ever: the id is never freed, and a later create over it is 409 gramps_id_retired", async () => {
    const w = await world();
    const { kid } = w.tr;
    await w.del(ADMIN, mk(w, [kid], { remove_references: true }), { idem: "p-3" });
    const gid = w.rows("GID#Person#").find((x) => x.PK.endsWith(kid.gramps_id));
    expect(gid).toMatchObject({ handle: kid.handle, retired: true });
    const again = person(60, { rest: {} });
    again.gramps_id = kid.gramps_id;
    await expect(applyBatch({ ...w.sctx, unsafeNoValidate: false }, { principal: "svc-seed", origin: "desktop", idempotencyKey: "reuse", ops: [create(again)] })).rejects.toMatchObject({ status: 409, code: "gramps_id_retired" });
  });

  it("a non-person id is released, not retired", async () => {
    const w = await world();
    const target = w.tr.orphans.find((o) => o._class === "Place");
    await w.del(ADMIN, mk(w, [target]), { idem: "p-4" });
    expect(w.rows("GID#Place#").find((x) => x.PK.endsWith(target.gramps_id))).toBeUndefined();
  });

  it("deleting a parent clears the family's slot and keeps the family, the other parent and the child", async () => {
    const w = await world();
    const { mum, fam, dad, kid } = w.tr;
    const r = await w.del(ADMIN, mk(w, [mum], { remove_references: true }), { idem: "p-5" });
    expect(r.status).toBe(201);
    expect(w.objOf(fam).mother_handle).toBeNull();
    expect(w.objOf(fam).father_handle).toBe(dad.handle);
    expect(w.objOf(fam).child_ref_list.map((c) => c.ref)).toEqual([kid.handle]);
    expect(w.objOf(kid).parent_family_list).toEqual([fam.handle]);
  });

  it("deleting everyone in a family takes the emptied family and its event along", async () => {
    const w = await world();
    const { dad, mum, kid, fam, wedding, birth } = w.tr;
    const dry = await w.del(ADMIN, { ...mk(w, [dad, mum, kid], { remove_references: true }), dry_run: true });
    expect(dry.status).toBe(200);
    expect(dry.body.plan.delete.map((x) => [x.key, x.why]).sort()).toEqual([
      [key(birth), "exclusive_event"], [key(fam), "emptied_family"], [key(dad), "target"], [key(kid), "target"], [key(mum), "target"], [key(wedding), "exclusive_event"],
    ].sort());
    expect(dry.body.plan.retired_ids.sort()).toEqual(["I0001", "I0002", "I0003"]);
    expect(dry.body.plan.update).toEqual([]);
    const r = await w.del(ADMIN, mk(w, [dad, mum, kid], { remove_references: true }), { idem: "p-6" });
    expect(r.status).toBe(201);
    for (const o of [dad, mum, kid, fam, wedding, birth]) expect(w.gone(o)).toBe(true);
    expect(w.gone(w.tr.shared)).toBe(false); // the other person still has it
    expect(w.objOf(w.tr.other).event_ref_list).toHaveLength(1);
  });

  it("an event another person uses stays, and the deleted person's reference to it goes with the person", async () => {
    const w = await world();
    const { dad, shared } = w.tr;
    const r = await w.del(ADMIN, mk(w, [dad], { remove_references: true }), { idem: "p-7" });
    expect(r.status).toBe(201);
    expect(w.gone(shared)).toBe(false);
    expect(w.objOf(w.tr.fam).father_handle).toBeNull();
  });

  it("the dry run writes nothing and names every record it would delete, update and retire", async () => {
    const w = await world();
    const { kid, fam } = w.tr;
    const before = writes(w);
    const rows = w.ddb.all().length;
    const r = await w.del(ADMIN, { ...mk(w, [kid], { remove_references: true }), dry_run: true });
    expect(r.status).toBe(200);
    expect(r.body.plan.update.map((x) => x.key)).toEqual([key(fam)]);
    expect(r.body.plan.retired_ids).toEqual(["I0003"]);
    expect(r.body.plan.objects).toBe(3);
    expect(r.body.budget).toMatchObject({ adding: 2, limit: 10, over: false });
    expect(r.body.summary.length).toBeGreaterThan(0);
    expect(writes(w)).toBe(before);
    expect(w.ddb.all().length).toBe(rows);
  });
});

describe("the other classes: references are cleaned in the same batch (AC2)", () => {
  it("a Family: both spouses and the child lose the link, the marriage event goes, the people stay", async () => {
    const w = await world();
    const { fam, dad, mum, kid, wedding } = w.tr;
    expect(err(await w.del(ADMIN, mk(w, [fam]), { idem: "f-0" }))).toEqual({ status: 409, error: "still_referenced" });
    const r = await w.del(ADMIN, mk(w, [fam], { remove_references: true }), { idem: "f-1" });
    expect(r.status).toBe(201);
    expect(r.body.applied.deleted.sort()).toEqual([key(fam), key(wedding)].sort());
    expect(w.objOf(dad).family_list).toEqual([]);
    expect(w.objOf(mum).family_list).toEqual([]);
    expect(w.objOf(kid).parent_family_list).toEqual([]);
    expect(w.gone(fam)).toBe(true);
  });

  it("an Event: the person's reference goes and the birth index is recomputed", async () => {
    const w = await world();
    const { birth, kid } = w.tr;
    const r = await w.del(ADMIN, mk(w, [birth], { remove_references: true }), { idem: "e-1" });
    expect(r.status).toBe(201);
    expect(w.objOf(kid).event_ref_list).toEqual([]);
    expect(w.objOf(kid).birth_ref_index).toBe(-1);
  });

  it("a Place: the event's place is cleared", async () => {
    const w = await world();
    const { pl, birth } = w.tr;
    const r = await w.del(ADMIN, mk(w, [pl], { remove_references: true }), { idem: "pl-1" });
    expect(r.status).toBe(201);
    expect(w.objOf(birth).place).toBeNull();
    expect(w.gone(pl)).toBe(true);
  });

  it("a Source takes its Citations, and every list that held one is cleaned", async () => {
    const w = await world();
    const { src, cit, kid, birth } = w.tr;
    const orphanCit = w.tr.orphans.find((o) => o._class === "Citation");
    const dry = await w.del(ADMIN, { ...mk(w, [src], { remove_references: true }), dry_run: true });
    expect(dry.body.plan.delete.map((x) => [x.key, x.why]).sort()).toEqual([[key(src), "target"], [key(cit), "source_citation"], [key(orphanCit), "source_citation"]].sort());
    const r = await w.del(ADMIN, mk(w, [src], { remove_references: true }), { idem: "s-1" });
    expect(r.status).toBe(201);
    expect(w.gone(cit)).toBe(true);
    expect(w.gone(orphanCit)).toBe(true);
    expect(w.objOf(kid).citation_list).toEqual([]);
    expect(w.objOf(birth).citation_list).toEqual([]);
  });

  it("a Citation: its holders are cleaned and the source stays", async () => {
    const w = await world();
    const { cit, src, kid, birth } = w.tr;
    expect(err(await w.del(ADMIN, mk(w, [cit]), { idem: "c-0" }))).toEqual({ status: 409, error: "still_referenced" });
    const r = await w.del(ADMIN, mk(w, [cit], { remove_references: true }), { idem: "c-1" });
    expect(r.status).toBe(201);
    expect(w.objOf(kid).citation_list).toEqual([]);
    expect(w.objOf(birth).citation_list).toEqual([]);
    expect(w.gone(src)).toBe(false);
  });

  it("a Media: the keyed photo tag is removed from the person", async () => {
    const w = await world();
    const { photo, kid } = w.tr;
    const r = await w.del(ADMIN, mk(w, [photo], { remove_references: true }), { idem: "m-1" });
    expect(r.status).toBe(201);
    expect(w.objOf(kid).media_list).toEqual([]);
    expect(w.gone(photo)).toBe(true);
  });
});

describe("limits, concurrency and replay", () => {
  it("413 too_large when the cascade reaches more than 24 records", async () => {
    const src = source(70);
    const cits = Array.from({ length: 25 }, (_, i) => citation(100 + i, src));
    const w = await world({ extra: [src, ...cits] });
    const r = await w.del(ADMIN, mk(w, [src]), { idem: "l-1" });
    expect(err(r)).toEqual({ status: 413, error: "too_large" });
    expect(w.txns).toEqual([]);
  });

  it("409 version_conflict when the record moved since the page loaded", async () => {
    const w = await world();
    const target = w.tr.orphans[0];
    const body = { targets: [key(target)], base_versions: { [key(target)]: 1 } };
    const edited = { ...target, primary_name: { ...target.primary_name, nick: "Ally" } };
    await applyBatch(w.sctx, { principal: "svc-seed", origin: "desktop", idempotencyKey: "bump", ops: [{ op: "update", class: "Person", handle: target.handle, base_version: 1, obj: edited }] });
    const r = await w.del(ADMIN, body, { idem: "v-1" });
    expect(err(r)).toEqual({ status: 409, error: "version_conflict" });
    expect(w.gone(target)).toBe(false);
  });

  it("404 for a record that does not exist", async () => {
    const w = await world();
    const r = await w.del(ADMIN, { targets: [`Person:${h(99999)}`], base_versions: { [`Person:${h(99999)}`]: 1 } }, { idem: "n-1" });
    expect(err(r)).toEqual({ status: 404, error: "not_found" });
  });

  it("an Idempotency-Key is required; the same key replays the receipt; the same key with another body is 422", async () => {
    const w = await world();
    const [a, b] = [w.tr.orphans[0], w.tr.orphans[2]];
    expect(err(await w.del(ADMIN, mk(w, [a])))).toEqual({ status: 400, error: "validation" });
    const body = mk(w, [a]);
    const first = await w.del(ADMIN, body, { idem: "i-1" });
    expect(first.status).toBe(201);
    const replay = await w.del(ADMIN, body, { idem: "i-1" });
    expect(replay.status).toBe(201);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.body).toEqual(first.body);
    expect(w.txns).toHaveLength(1);
    expect(err(await w.del(ADMIN, mk(w, [b]), { idem: "i-1" }))).toEqual({ status: 422, error: "idempotency_mismatch" });
  });

  it("rejects unknown fields, too many targets and a target without a version", async () => {
    const w = await world();
    const t = w.tr.orphans[0];
    expect(err(await w.del(ADMIN, { ...mk(w, [t]), surprise: 1 }, { idem: "x-1" })).status).toBe(400);
    expect(err(await w.del(ADMIN, { targets: [key(t)], base_versions: {} }, { idem: "x-2" })).status).toBe(400);
    const many = Array.from({ length: 11 }, (_, i) => place(300 + i));
    expect(err(await w.del(ADMIN, { targets: many.map(key), base_versions: Object.fromEntries(many.map((p) => [key(p), 1])) }, { idem: "x-3" })).status).toBe(400);
    expect(w.txns).toEqual([]);
  });
});

describe("cleanOps builds the keyed ops the engine takes", () => {
  it("removes a list element by key, nulls a nullable handle, and drops what sits inside a removed element", () => {
    let n = 0;
    const nextId = (p) => `${p}${(n += 1)}`;
    const ev = event(1, 12, [0, 0, 1990, false], { place: "pl1" });
    const one = cleanOps("Event:e1", ev, new Set(["Place:pl1"]), nextId);
    expect(one.ops).toEqual([{ id: "r1", op: "set", obj: "Event:e1", path: "/place", base: "pl1", value: null }]);
    const p = person(3, { rest: { event_ref_list: [{ ...eref(event(2, 12, [0, 0, 1, false])), note_list: ["n1"] }], parent_family_list: ["f1"] } });
    const two = cleanOps("Person:p", p, new Set([`Event:${h(3002)}`, "Note:n1", "Family:f1"]), nextId);
    expect(two.ops.map((o) => [o.op, o.path])).toEqual([["remove", "/parent_family_list/@=f1"], ["remove", `/event_ref_list/@ref=${h(3002)}`]]);
    expect(two.blocked).toEqual([]);
  });
});

describe("the possible-duplicate queue (AC3)", () => {
  const twins = () => [
    person(70, { first: "Wren", last: "Fernley", rest: { gender: 0, gramps_id: "I0070" } }),
    person(71, { first: "Wren", last: "Fernly", rest: { gender: 0 } }),
    person(72, { first: "Jonathan", last: "Oakbridge", rest: { gender: 1 } }),
    person(73, { first: "Jon", last: "Oakbridge", rest: { gender: 1 } }),
    person(74, { first: "Wren", last: "Fernley", rest: { gender: 1 } }), // a man of the same name: not offered against the women
  ];

  it("lists the matcher's pairs, best first, with ids and names, and writes no record", async () => {
    const w = await world({ extra: twins() });
    const before = writes(w);
    const rows = w.ddb.all().length;
    const r = await w.dups(ADMIN);
    expect(r.status).toBe(200);
    const pairs = r.body.items.map((i) => [i.a.displayName, i.b.displayName, i.score]);
    expect(pairs).toEqual(expect.arrayContaining([["Wren Fernley", "Wren Fernly", 3], ["Jonathan Oakbridge", "Jon Oakbridge", 3]]));
    expect(r.body.items.every((i) => i.a.key.startsWith("Person:") && i.b.key.startsWith("Person:") && i.a.key !== i.b.key)).toBe(true);
    expect(r.body.items.find((i) => i.a.displayName === "Jonathan Oakbridge" || i.b.displayName === "Jonathan Oakbridge")).toMatchObject({ a: { gramps_id: expect.stringMatching(/^I\d{4}$/) } });
    expect(r.body.total).toBe(r.body.items.length);
    expect(r.body.cursor).toBeNull();
    expect(r.body.items.some((i) => [i.a.key, i.b.key].includes(`Person:${h(74)}`) && [i.a.key, i.b.key].some((k) => k === `Person:${h(70)}`))).toBe(false);
    expect(writes(w)).toBe(before); // flagging writes no record
    expect(w.ddb.all().length).toBe(rows);
    expect(w.txns).toEqual([]);
  });

  it("pages with limit and cursor, and refuses a bad limit", async () => {
    const w = await world({ extra: twins() });
    const all = (await w.dups(ADMIN)).body;
    const first = (await w.dups(ADMIN, { limit: "1" })).body;
    expect(first.items).toHaveLength(1);
    expect(first.cursor).toBe("1");
    const second = (await w.dups(ADMIN, { limit: "1", cursor: first.cursor })).body;
    expect(second.items[0]).toEqual(all.items[1]);
    expect(err(await w.dups(ADMIN, { limit: "0" })).status).toBe(400);
    expect(err(await w.dups(ADMIN, { cursor: "abc" })).status).toBe(400);
  });

  it("a deleted person drops out of the queue", async () => {
    const extra = twins();
    const w = await world({ extra });
    expect((await w.dups(ADMIN)).body.items.length).toBeGreaterThan(0);
    const dup = extra[1];
    expect((await w.del(ADMIN, mk(w, [dup], { remove_references: true }), { idem: "q-1" })).status).toBe(201);
    const names = (await w.dups(ADMIN)).body.items.map((i) => [i.a.displayName, i.b.displayName].join("|"));
    expect(names.some((x) => x.includes("Fernly"))).toBe(false);
  });
});

describe("findDuplicatePairs (pure)", () => {
  const s = (handle, given, surname, extra = {}) => ({ handle, names: [{ given, surname }], gender: 1, birthYear: null, deathYear: null, ...extra });
  it("pairs a slip, a nickname and an exact name, once each, and never a different year", () => {
    const pairs = findDuplicatePairs([s("a", "Maud", "Hollowell"), s("b", "Maud", "Holowell"), s("c", "Jon", "Rivers"), s("d", "Jonathan", "Rivers"), s("e", "Maud", "Hollowell", { birthYear: 1900 }), s("f", "Maud", "Hollowell", { birthYear: 1950 })]);
    const names = pairs.map((p) => [p.a.handle, p.b.handle].join(""));
    expect(names).toEqual(expect.arrayContaining(["ab", "cd", "ae", "af"]));
    expect(names).not.toContain("ef");
    expect(new Set(names).size).toBe(names.length);
  });
  it("is empty for an empty or all-different tree, and compares through summarizePerson", () => {
    expect(findDuplicatePairs([])).toEqual([]);
    expect(findDuplicatePairs([s("a", "Ann", "Alder"), s("b", "Bea", "Birch")])).toEqual([]);
    const p = person(1, { first: "Ann", last: "Alder" });
    expect(findDuplicatePairs([summarizePerson(p, () => undefined), summarizePerson({ ...p, handle: h(2) }, () => undefined)])).toHaveLength(1);
  });
});
