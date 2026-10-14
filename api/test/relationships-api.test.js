// HFY-TSK-210 (relationship-api): POST /api/relationships/preview and POST /api/relationships. In-memory DynamoDB fake; synthetic ids, names and years only.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryNotificationStore } from "@io-kit/notify/server";
import { cmds, makeApi, signToken, TABLE } from "./world.js";
import { applyBatch } from "../src/sync/apply.js";
import { createHookRegistry } from "../src/sync/hooks.js";
import { headKey } from "../src/sync/store.js";
import { buildCaps, ROUTES } from "../src/routes.js";
import { approvalActions } from "../src/records/proposals.js";
import { TXN_COST, approvalActionCount } from "../src/records/relationships.js";
import { idemKeys } from "../src/records/proposals.js";

const h = (n) => n.toString(16).padStart(28, "0");
const typ = (cls, value, string = "") => ({ _class: cls, value, string });
const date = (dateval = [0, 0, 0, false], text = "", modifier = 0) => ({ _class: "Date", calendar: 0, dateval, format: null, modifier, newyear: 0, quality: 0, sortval: 0, text });
const person = (n, extra = {}) => ({
  _class: "Person", handle: h(n), gramps_id: `I${String(n).padStart(4, "0")}`, private: false, gender: 1,
  primary_name: { _class: "Name", first_name: extra.first ?? "Alder", nick: "", surname_list: [{ _class: "Surname", primary: true, surname: extra.last ?? "Testwood" }], type: typ("NameType", 2), date: date() },
  event_ref_list: [], birth_ref_index: -1, death_ref_index: -1, family_list: [], parent_family_list: [], note_list: [], media_list: [], urls: [], ...extra.rest,
});
const family = (n, extra = {}) => ({ _class: "Family", handle: h(1000 + n), gramps_id: `F${String(n).padStart(4, "0")}`, private: false, father_handle: null, mother_handle: null, child_ref_list: [], event_ref_list: [], type: typ("FamilyRelType", 3), note_list: [], media_list: [], attribute_list: [], citation_list: [], tag_list: [], lds_ord_list: [], ...extra });
const event = (n, type, dateval, extra = {}) => ({ _class: "Event", handle: h(3000 + n), gramps_id: `E${String(n).padStart(4, "0")}`, private: false, type: typ("EventType", type), date: date(dateval), description: "", place: "", citation_list: [], note_list: [], media_list: [], attribute_list: [], tag_list: [], ...extra });
const eref = (ev, role = 1) => ({ _class: "EventRef", ref: ev.handle, role: typ("EventRoleType", role), private: false, attribute_list: [] });
const create = (obj) => ({ op: "create", class: obj._class, handle: obj.handle, base_version: null, obj });

const ME = "I0001";
const SPOUSE = "I0003";
const ADMIN = "I0099";
const ADMIN2 = "I0098";
const q = { warn() {}, error() {} };
const P = (n) => `Person:${h(n)}`;

let envBefore;
beforeEach(() => { envBefore = process.env.HFY_EDITING; process.env.HFY_EDITING = "on"; });
afterEach(() => { if (envBefore === undefined) delete process.env.HFY_EDITING; else process.env.HFY_EDITING = envBefore; });

// A synthetic tree: me (1, a man), a stranger (2), a woman (3), a living namesake of a stub (4) with a birth year, a deceased woman (5), my child (6),
// and a family (F1) of me alone with the child.
async function world({ admins = [ADMIN, ADMIN2] } = {}) {
  const txns = [];
  const hooks = createHookRegistry();
  const inbox = new InMemoryNotificationStore();
  const w = makeApi({
    admins, log: q, inbox, flags: { inboxV1: true },
    intercept: async (cmd) => { if (cmd.constructor.name === "TransactWriteCommand") txns.push(structuredClone(cmd.input)); },
    extraDeps: { syncHooks: hooks, idPolicy: { mode: "mint" }, getAdmins: async () => new Set(admins), txnOpts: { sleep: async () => {} } },
  });
  w.ddb.rows.set("SYNC#HEAD\u0000META", { ...headKey(), seq: 0, seeded: true, writes_enabled: true });
  let t = Date.parse("2026-10-14T00:00:00Z");
  let u = 0;
  const sctx = { ddb: w.ddb, cmds, table: TABLE, now: () => (t += 1000), uid: () => `s${++u}`, unsafeNoValidate: true, log: q, txnOpts: { sleep: async () => {} } };
  let k = 0;
  const seed = async (objs) => {
    for (let i = 0; i < objs.length; i += 20) await applyBatch(sctx, { principal: "svc-seed", origin: "desktop", idempotencyKey: `seed${++k}`, ops: objs.slice(i, i + 20).map(create) });
  };
  const born = event(1, 12, [0, 0, 1990, false]);
  const fam = family(1, { father_handle: h(1), child_ref_list: [{ _class: "ChildRef", ref: h(6), frel: typ("ChildRefType", 1), mrel: typ("ChildRefType", 1), private: false, citation_list: [], note_list: [] }] });
  const me = person(1, { rest: { family_list: [fam.handle] } });
  const kid = person(6, { first: "Briar", rest: { parent_family_list: [fam.handle] } });
  const namesake = person(4, { first: "Wren", last: "Fernley", rest: { event_ref_list: [eref(born)], birth_ref_index: 0, gender: 0 } });
  await seed([me, person(2, { first: "Cedar", last: "Oakley" }), person(3, { first: "Hazel", last: "Birchwell", rest: { gender: 0 } }), namesake, person(5, { first: "Ivy", last: "Mossley", rest: { gender: 0 } }), kid, born, fam]);
  const bump = (obj, base) => applyBatch(sctx, { principal: "svc-seed", origin: "desktop", idempotencyKey: `bump${++k}`, ops: [{ op: "update", class: obj._class, handle: obj.handle, base_version: base, obj }] });
  txns.length = 0;
  const call = async (method, path, who, body, headers = {}) => w.call(method, path, { token: await signToken(who), ...(body === undefined ? {} : { body }), headers });
  const preview = (who, body) => call("POST", "/api/relationships/preview", who, body);
  const submit = (who, body, idem = "k1") => call("POST", "/api/relationships", who, body, idem ? { "idempotency-key": idem } : {});
  const rows = (prefix) => w.ddb.all().filter((r) => r.PK.startsWith(prefix));
  return { ...w, txns, preview, submit, rows, call, bump, me, kid, namesake, fam, seed, hooks };
}
const writes = (w) => w.ddb.calls.filter((c) => /^(Put|Update|Delete|TransactWrite)Command$/.test(c)).length;
const err = (r) => ({ status: r.status, error: r.body?.error });
const spouseOf = (n, extra = {}) => ({ type: "spouse", person: P(1), spouse: { ref: P(n) }, relType: "married", married: null, ended: null, ...extra });
const stub = (given, surname, extra = {}) => ({ given, surname, gender: "female", birthYear: null, living: "unknown", deathYear: null, ...extra });

describe("preview (AC1)", () => {
  it("returns the ops, base versions, summary sentences, warnings and duplicates, and writes nothing", async () => {
    const w = await world();
    const before = writes(w);
    const rowsBefore = w.ddb.all().length;
    const r = await w.preview(ME, { intent: spouseOf(3) });
    expect(r.status).toBe(200);
    expect(r.body.ops.length).toBeGreaterThan(0);
    expect(r.body.base_versions[P(1)]).toBe(1);
    expect(r.body.base_versions[P(3)]).toBe(1);
    expect(r.body.summary.length).toBeGreaterThan(0);
    expect(r.body.summary[0].text).toEqual(expect.any(String));
    expect(r.body.warnings.map((x) => x.code)).toEqual(["single_parent_family_has_children"]); // I am the only parent of the child in F1: a new family is made
    expect(r.body.duplicates).toEqual([]);
    expect(r.body.already_recorded).toBe(false);
    expect(r.body.route).toBe("proposal");
    expect(writes(w) - before).toBe(0);
    expect(w.ddb.all().length).toBe(rowsBefore);
    expect(w.txns).toEqual([]);
  });
  it("reports a duplicate without refusing, and shows a living person's lifespan only to a viewer who can see it", async () => {
    const w = await world();
    const intent = { type: "children", person: P(1), otherParent: { unknown: true }, children: [{ who: { new: stub("Wren", "Fernley", { birthYear: 1990 }) }, relToMe: "birth", relToOther: "birth" }] };
    const member = await w.preview(ME, { intent });
    expect(member.status).toBe(200);
    expect(member.body.duplicates).toHaveLength(1);
    expect(member.body.duplicates[0]).toMatchObject({ for: "new:1", candidates: [{ handle: h(4), displayName: "Wren Fernley", lifespan: "" }] });
    const admin = await w.preview(ADMIN, { intent });
    expect(admin.body.duplicates[0].candidates[0].lifespan).toBe("1990-");
    expect(admin.body.route).toBe("auto");
  });
  it("answers already_recorded with the tree's own words, 200, and no ops", async () => {
    const w = await world();
    const r = await w.preview(ME, { intent: { type: "children", person: P(1), otherParent: { unknown: true }, children: [{ who: { ref: P(6) }, relToMe: "birth", relToOther: "birth" }] } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ already_recorded: true, ops: [] });
  });
  it("refuses what a submit would refuse (a bad intent, an unknown record, a contact number)", async () => {
    const w = await world();
    expect(err(await w.preview(ME, { intent: { type: "nope" } }))).toEqual({ status: 400, error: "validation" });
    expect(err(await w.preview(ME, { intent: spouseOf(77) }))).toEqual({ status: 404, error: "not_found" });
    expect(err(await w.preview(ME, { intent: { type: "spouse", person: P(1), spouse: { new: stub("call 555-0123", "Testwood") }, relType: "married", married: null, ended: null } }))).toEqual({ status: 422, error: "contact_info" });
  });
});

describe("the duplicate gate (AC2)", () => {
  const intent = { type: "children", person: P(1), otherParent: { unknown: true }, children: [{ who: { new: stub("Wren", "Fernley") }, relToMe: "birth", relToOther: "birth" }] };
  it("is 422 unconfirmed_duplicate until the flagged new:n is listed, and a missing confirmDistinct counts as []", async () => {
    const w = await world();
    const none = await w.submit(ME, { intent });
    expect(err(none)).toEqual({ status: 422, error: "unconfirmed_duplicate" });
    expect(none.body.details.unconfirmed).toEqual(["new:1"]);
    expect(none.body.details.candidates[0].candidates[0]).toMatchObject({ handle: h(4), displayName: "Wren Fernley" });
    expect(err(await w.submit(ME, { intent, confirmDistinct: [] }, "k2"))).toEqual({ status: 422, error: "unconfirmed_duplicate" });
    expect(w.rows("PROP#")).toHaveLength(0);
    const ok = await w.submit(ME, { intent, confirmDistinct: ["new:1"] }, "k3");
    expect(ok.status).toBe(201);
    expect(ok.body.proposal.kind).toBe("relationship");
  });
});

describe("member and admin routes (AC3)", () => {
  it("a member always files a proposal of kind relationship with the intent and the compiled ops, and no record changes", async () => {
    const w = await world();
    const r = await w.submit(ME, { intent: spouseOf(3), note: "hello" });
    expect(r.status).toBe(201);
    expect(r.body.applied).toBeNull();
    const p = r.body.proposal;
    expect(p).toMatchObject({ kind: "relationship", state: "pending", rev: 1, origin: "web", proposer: { id: ME }, note: "hello", intent: spouseOf(3) });
    expect(p.ops.length).toBeGreaterThan(0);
    expect(p.base_versions[P(3)]).toBe(1);
    expect(p.summary.length).toBeGreaterThan(0);
    expect(p.subject).toMatchObject({ cls: "Person", handle: h(1), gramps_id: ME });
    const stored = w.rows("PROP#").find((x) => x.SK === "META");
    expect(stored.proposal.intent).toEqual(spouseOf(3));
    expect(stored.proposal.ops).toEqual(p.ops);
    expect(w.rows("REC#Person#").map((x) => x.version ?? 1).every((v) => v === 1)).toBe(true);
    expect(w.txns).toHaveLength(1);
  });
  it("a member who asks for route auto still files a proposal", async () => {
    const w = await world();
    const r = await w.submit(ME, { intent: spouseOf(3), route: "auto" });
    expect(r.status).toBe(201);
    expect(r.body.proposal.kind).toBe("relationship");
  });
  it("an admin on route auto applies through applyBatch and files nothing", async () => {
    const w = await world();
    const r = await w.submit(ADMIN, { intent: spouseOf(3) });
    expect(r.status).toBe(201);
    expect(r.body.proposal).toBeNull();
    expect(r.body.applied.versions).toMatchObject({ [P(1)]: 2, [P(3)]: 2 });
    expect(w.rows("PROP#")).toHaveLength(0);
    expect(w.txns).toHaveLength(1);
    const items = w.txns[0].TransactItems.map((i) => (i.Put ?? i.Update ?? i.Delete ?? i.ConditionCheck).Item?.PK ?? (i.Put ?? i.Update ?? i.Delete ?? i.ConditionCheck).Key?.PK);
    expect(items.some((p) => /^SYNC#BATCH#/.test(p))).toBe(true);
    const again = await w.preview(ADMIN, { intent: spouseOf(3) });
    expect(again.body.already_recorded).toBe(true);
    expect((await w.submit(ADMIN, { intent: spouseOf(3) }, "k9")).status).toBe(409);
  });
  it("an admin on route review files a proposal", async () => {
    const w = await world();
    const r = await w.submit(ADMIN, { intent: spouseOf(3), route: "review" });
    expect(r.status).toBe(201);
    expect(r.body.proposal.kind).toBe("relationship");
    expect(r.body.applied).toBeNull();
  });
  it("creates a stub person and its events in the proposal, and each new:n is minted at approval", async () => {
    const w = await world();
    const r = await w.submit(ME, { intent: { type: "parents", person: P(1), parents: [{ who: { new: stub("Moss", "Testwood", { gender: "male", birthYear: 1960 }) }, rel: "birth" }] } });
    expect(r.status).toBe(201);
    expect(r.body.proposal.ops.filter((o) => o.op === "create").map((o) => o.cls).sort()).toEqual(["Event", "Family", "Person"]);
  });
});

describe("the guard (AC4)", () => {
  const phone = "call 555-0123";
  it("refuses a contact number in a stub name before any write: 422 contact_info", async () => {
    const w = await world();
    const before = w.ddb.all().length;
    const r = await w.submit(ME, { intent: spouseOf(0, { spouse: { new: stub(phone, "Testwood") } }) });
    expect(err(r)).toEqual({ status: 422, error: "contact_info" });
    expect(JSON.stringify(r.body)).not.toContain("555");
    expect(w.ddb.all().length).toBe(before);
    expect(w.txns).toEqual([]);
  });
  it("covers a place name and the note", async () => {
    const w = await world();
    const withPlace = spouseOf(3, { married: { year: 1990, about: false, place: { new: { name: phone, type: "City" } } } });
    expect(err(await w.submit(ME, { intent: withPlace }))).toEqual({ status: 422, error: "contact_info" });
    expect(err(await w.submit(ME, { intent: spouseOf(3), note: phone }, "k2"))).toEqual({ status: 422, error: "contact_info" });
    expect(w.rows("PROP#")).toHaveLength(0);
  });
  it("covers a surname too", async () => {
    const w = await world();
    expect(err(await w.submit(ME, { intent: spouseOf(0, { spouse: { new: stub("Hazel", phone) } }) }))).toEqual({ status: 422, error: "contact_info" });
  });
});

describe("errors and idempotency", () => {
  it("is 409 already_recorded when the tree already says it", async () => {
    const w = await world();
    const r = await w.submit(ME, { intent: { type: "children", person: P(1), otherParent: { unknown: true }, children: [{ who: { ref: P(6) }, relToMe: "birth", relToOther: "birth" }] } });
    expect(err(r)).toEqual({ status: 409, error: "already_recorded" });
  });
  it("is 422 cycle when a person would become their own ancestor", async () => {
    const w = await world();
    const r = await w.submit(ME, { intent: { type: "parents", person: P(1), parents: [{ who: { ref: P(6) }, rel: "birth" }] } });
    expect(err(r)).toEqual({ status: 422, error: "cycle" });
  });
  it("is 422 too_many_children above ten", async () => {
    const w = await world();
    const children = Array.from({ length: 11 }, (_, i) => ({ who: { new: stub(`Kid${String.fromCharCode(97 + i)}`, "Zzyzx") }, relToMe: "birth", relToOther: "birth" }));
    const r = await w.submit(ME, { intent: { type: "children", person: P(1), otherParent: { unknown: true }, children }, confirmDistinct: [] });
    expect(err(r)).toEqual({ status: 422, error: "too_many_children" });
  });
  it("requires an Idempotency-Key, replays the same request and refuses the same key with another one", async () => {
    const w = await world();
    expect(err(await w.submit(ME, { intent: spouseOf(3) }, null))).toEqual({ status: 400, error: "validation" });
    const a = await w.submit(ME, { intent: spouseOf(3) }, "same");
    expect(a.status).toBe(201);
    const txns = w.txns.length;
    const b = await w.submit(ME, { intent: spouseOf(3) }, "same");
    expect(b.status).toBe(201);
    expect(b.body.proposal.id).toBe(a.body.proposal.id);
    expect(w.txns.length).toBe(txns);
    expect(w.ddb.rows.has(`${idemKeys(ME, "same").PK}\u0000META`)).toBe(true);
    expect(err(await w.submit(ME, { intent: spouseOf(5) }, "same"))).toEqual({ status: 422, error: "idempotency_mismatch" });
  });
  it("refuses unknown fields and a bad route", async () => {
    const w = await world();
    expect(err(await w.submit(ME, { intent: spouseOf(3), extra: 1 }))).toEqual({ status: 400, error: "validation" });
    expect(err(await w.submit(ME, { intent: spouseOf(3), route: "now" }, "k2"))).toEqual({ status: 400, error: "validation" });
    expect(err(await w.submit(ME, { intent: spouseOf(3), confirmDistinct: ["x"] }, "k3"))).toEqual({ status: 400, error: "validation" });
  });
  it("answers 404 for a record that does not exist, writing nothing", async () => {
    const w = await world();
    expect(err(await w.submit(ME, { intent: spouseOf(77) }))).toEqual({ status: 404, error: "not_found" });
    expect(w.rows("PROP#")).toHaveLength(0);
  });
});

describe("read_versions (the proposal store checks both)", () => {
  const intent = { type: "children", person: P(1), otherParent: { ref: P(3) }, children: [{ who: { ref: P(5) }, relToMe: "birth", relToOther: "birth" }] };
  it("stores the versions of objects read but not changed, and the proposal is stale when one of them moves", async () => {
    const w = await world();
    const r = await w.submit(ME, { intent });
    expect(r.status).toBe(201);
    const p = r.body.proposal;
    // F1 (my one-parent family with a child) was read to decide on a new family, and no op changes it.
    expect(p.read_versions).toEqual({ [`Family:${w.fam.handle}`]: 1 });
    expect(Object.keys(p.base_versions)).not.toContain(`Family:${w.fam.handle}`);
    expect((await w.call("GET", `/api/proposals/${p.id}`, ME)).body.stale).toBe(false);
    await w.bump({ ...w.fam, type: typ("FamilyRelType", 0) }, 1);
    expect((await w.call("GET", `/api/proposals/${p.id}`, ME)).body.stale).toBe(true);
  });
  it("is stale when a base version moves too", async () => {
    const w = await world();
    const p = (await w.submit(ME, { intent })).body.proposal;
    await w.bump({ ...w.me, gender: 1, private: false, primary_name: { ...w.me.primary_name, nick: "Al" } }, 1);
    expect((await w.call("GET", `/api/proposals/${p.id}`, ME)).body.stale).toBe(true);
  });
});

describe("an admin applying a stub (AC3)", () => {
  it("creates the person, the family and the events through applyBatch, with ids left for the sync policy", async () => {
    const w = await world();
    const r = await w.submit(ADMIN, { intent: { type: "parents", person: P(1), parents: [{ who: { new: stub("Moss", "Testwood", { gender: "male", birthYear: 1960 }) }, rel: "birth" }] }, confirmDistinct: [] });
    expect(r.status).toBe(201);
    expect(r.body.proposal).toBeNull();
    const created = Object.entries(r.body.applied.versions).filter(([, v]) => v === 1).map(([k]) => k.split(":")[0]).sort();
    expect(created).toEqual(["Event", "Family", "Person"]);
  });
  it("a destructive unlink needs a fresh sign-in", async () => {
    const w = await world();
    const r = await w.submit(ADMIN, { intent: { type: "unlink", family: `Family:${w.fam.handle}`, person: P(6), as: "child" } });
    expect(err(r)).toEqual({ status: 401, error: "step_up_required" });
    expect(w.txns).toEqual([]);
  });
});

describe("registration", () => {
  it("is in caps and the registry, behind HFY_EDITING, with no MCP tool", () => {
    for (const [name, path] of [["relationships.preview", "/api/relationships/preview"], ["relationships.post", "/api/relationships"]]) {
      expect(buildCaps().actions.find((a) => a.name === name)).toMatchObject({ method: "POST", path, write: true, gate: { switch: "HFY_EDITING" } });
      expect(ROUTES.find((r) => r.name === name).mcp).toBeUndefined();
    }
  });
  it("pins the compiler's transaction cost model to the proposal store's (the compiler may only undercount by the contribution reserve)", () => {
    expect(TXN_COST).toEqual({ batchFixed: 3, perObject: 2, perCreate: 1, proposalFixed: 3, perTarget: 1 });
    for (const [touched, created] of [[0, 1], [2, 0], [3, 4], [5, 5], [1, 9]]) {
      const store = approvalActions({ created, updated: touched, targets: touched + created });
      expect(approvalActionCount({ touched, created })).toBeLessThanOrEqual(store);
      expect(store - approvalActionCount({ touched, created })).toBeLessThanOrEqual(7);
    }
  });
});
