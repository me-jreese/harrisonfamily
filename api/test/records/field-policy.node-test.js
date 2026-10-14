// Field policy, own-record resolver, partition and summaries (HFY-TSK-233, edit-field-policy). Plain node:test:
// `node --test test/records/field-policy.node-test.js`; needs no network, no AWS and no Gramps. Every fixture is synthetic:
// placeholder names, made-up handles and ids (I9001, I9002), no real people, dates or contact details.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NEVER } from "../../../scripts/records/gen-edit-schemas.mjs";
import { contentHash, hash12 } from "../../src/records/ops.js";
import {
  DEFAULT_FIELD_POLICY, FIELD_POLICY_ROWS, NEVER_TYPE_VALUES, Q2_15_ROWS, classifyOps, createFieldPolicy, ownRecord, relationOf,
} from "../../src/records/field-policy.js";
import { JARGON, groupOps, partitionOps, planOps, summarizeOp } from "../../src/records/edit-plan.js";

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = resolve(here, "../../src/records/schemas");
const CLASSES = ["Person", "Family", "Event", "Place", "Source", "Citation", "Repository", "Media", "Note"];

// ---- synthetic world
const typed = (cls, value, string = "") => ({ _class: cls, value, string });
const date = (y, m = 0, d = 0) => ({ _class: "Date", modifier: 0, calendar: 0, quality: 0, dateval: [d, m, y, false], text: "" });
const surname = (s) => ({ _class: "Surname", surname: s, primary: true, origintype: typed("NameOriginType", 2) });
const name = (first, last, extra = {}) => ({ _class: "Name", first_name: first, surname_list: [surname(last)], type: typed("NameType", 2), nick: "", ...extra });
const eref = (ref, role = 1) => ({ _class: "EventRef", ref, role: typed("EventRoleType", role) });
const OWN = "hp1";
const world = () => ({
  [`Person:${OWN}`]: { _class: "Person", handle: OWN, gramps_id: "I9001", gender: 2, primary_name: name("Testa", "Sample", { nick: "Tess" }), alternate_names: [name("Testy", "Sample", { type: typed("NameType", 3) })],
    event_ref_list: [eref("he2"), eref("he1")], family_list: ["hf1"], parent_family_list: ["hf2"], note_list: ["hn1"], media_list: [{ _class: "MediaRef", ref: "hm1", rect: [1, 1, 10, 10] }], birth_ref_index: 1, death_ref_index: -1 },
  "Person:hp2": { _class: "Person", handle: "hp2", gramps_id: "I9002", gender: 1, primary_name: name("Other", "Sample"), event_ref_list: [eref("he3")], family_list: [], parent_family_list: [], media_list: [{ _class: "MediaRef", ref: "hm1", rect: [2, 2, 8, 8] }], birth_ref_index: -1, death_ref_index: -1 },
  "Event:he1": { _class: "Event", handle: "he1", gramps_id: "E9001", type: typed("EventType", 12), date: date(1900), description: "" },
  "Event:he2": { _class: "Event", handle: "he2", gramps_id: "E9002", type: typed("EventType", 5), date: date(1980, 3, 4), description: "" },
  "Event:he3": { _class: "Event", handle: "he3", gramps_id: "E9003", type: typed("EventType", 5), date: date(1981), description: "" },
  "Event:hd1": { _class: "Event", handle: "hd1", gramps_id: "E9004", type: typed("EventType", 13), date: date(1999), description: "" },
  "Family:hf1": { _class: "Family", handle: "hf1", gramps_id: "F9001", father_handle: OWN, mother_handle: "hp2", child_ref_list: [], type: typed("FamilyRelType", 1) },
  "Family:hf2": { _class: "Family", handle: "hf2", gramps_id: "F9002", father_handle: "hp3", child_ref_list: [{ _class: "ChildRef", ref: OWN, frel: typed("ChildRefType", 1), mrel: typed("ChildRefType", 1) }] },
  "Note:hn1": { _class: "Note", handle: "hn1", gramps_id: "N9001", text: { _class: "StyledText", string: "hello", tags: [] }, type: typed("NoteType", 1), format: 0 },
  "Place:hl1": { _class: "Place", handle: "hl1", gramps_id: "P9001", place_type: typed("PlaceType", 4), code: "" },
});
// Who refers to what, computed from the world (the store's reference index).
function viewOf(objects, { dupes = false } = {}) {
  const refs = (cls, handle) => {
    const out = [];
    for (const o of Object.values(objects)) {
      const hit = JSON.stringify(o, (k, v) => (k === "handle" ? undefined : v)).includes(`"${handle}"`);
      if (hit && o.handle !== handle && !(o._class === "Family" && cls === "Person")) out.push({ cls: o._class, handle: o.handle });
    }
    return out;
  };
  return {
    get: async (cls, h) => objects[`${cls}:${h}`] ?? null,
    byGrampsId: async (cls, gid) => {
      const hits = Object.values(objects).filter((o) => o._class === cls && o.gramps_id === gid);
      return dupes && hits[0] ? [...hits, { ...hits[0], handle: "dup" }] : hits;
    },
    referrers: async (cls, h) => refs(cls, h),
  };
}
const actorOf = (id, admin = false) => ({ id, admin });
const run = async (ops, { actor = actorOf("I9001"), objects = world(), policy, customTypes } = {}) =>
  classifyOps(ops, { actor, view: viewOf(objects), objects, policy, customTypes });
const codeOf = async (op, opts) => (await run([{ id: "o1", ...op }], opts))[0].code;
const set = (obj, path, base, value) => ({ op: "set", obj, path, base, value });
const ME = `Person:${OWN}`;
const k = (v) => `@k=${hash12(v)}`;

describe("ownRecord", () => {
  it("resolves the one Person for the session's gramps_id", async () => {
    const w = world();
    assert.deepEqual(await ownRecord(actorOf("I9001"), viewOf(w)), { cls: "Person", handle: OWN, gramps_id: "I9001" });
  });
  it("is null for zero or two-plus persons, and never reads request input", async () => {
    const w = world();
    assert.equal(await ownRecord(actorOf("I9999"), viewOf(w)), null);
    assert.equal(await ownRecord(actorOf("I9001"), viewOf(w, { dupes: true })), null);
    assert.equal(await ownRecord({ label: "x" }, viewOf(w)), null);
    assert.equal(await ownRecord(null, viewOf(w)), null);
    assert.equal(ownRecord.length, 2, "actor and view only: no request parameter");
    const seen = [];
    await ownRecord(actorOf("I9001"), { byGrampsId: async (c, id) => { seen.push(id); return []; } });
    assert.deepEqual(seen, ["I9001"]);
  });
  it("logs counts only and fails closed on a store error", async () => {
    const lines = [];
    const log = { info: (...a) => lines.push(a), warn: (...a) => lines.push(a) };
    await ownRecord(actorOf("I9001"), viewOf(world(), { dupes: true }), { log });
    await ownRecord(actorOf("I9001"), { byGrampsId: async () => { throw new Error("down"); } }, { log });
    assert.equal(JSON.stringify(lines).includes("I9001"), false);
    assert.deepEqual(lines.map((l) => l[0]), ["own_record_ambiguous", "own_record_unavailable"]);
  });
  it("with no own record every change is a proposal", async () => {
    const w = world();
    const code = await codeOf(set(ME, "/primary_name/nick", "Tess", "Tee"), { actor: actorOf("I9999"), objects: w });
    assert.equal(code, "proposal");
  });
});

describe("relationOf", () => {
  it("own Person, own-only Primary events and notes are own; shared things are not", async () => {
    const w = world();
    const view = viewOf(w);
    const own = await ownRecord(actorOf("I9001"), view);
    assert.equal(await relationOf(own, ME, view), "own");
    assert.equal(await relationOf(own, "Person:hp2", view), "other");
    assert.equal(await relationOf(own, "Event:he1", view), "own");
    assert.equal(await relationOf(own, "Event:he3", view), "other");
    assert.equal(await relationOf(own, "Note:hn1", view), "own");
    assert.equal(await relationOf(own, "Family:hf1", view), "own"); // the own Person is its spouse
    assert.equal(await relationOf(own, "Family:hf2", view), "own"); // the own Person is its child
    assert.equal(await relationOf(own, "Family:hf3", viewOf({ ...w, "Family:hf3": { _class: "Family", handle: "hf3", father_handle: "hp2", child_ref_list: [] } })), "other");
    assert.equal(await relationOf(own, "Place:hl1", view), "other");
    assert.equal(await relationOf(null, ME, view), "other");
  });
  it("an event with a non-Primary role, or one shared with another person, is not own-only", async () => {
    const w = world();
    w[ME].event_ref_list[0] = eref("he2", 3);
    let view = viewOf(w);
    const own = await ownRecord(actorOf("I9001"), view);
    assert.equal(await relationOf(own, "Event:he2", view), "other");
    const w2 = world();
    w2["Person:hp2"].event_ref_list.push(eref("he2"));
    view = viewOf(w2);
    assert.equal(await relationOf(own, "Event:he2", view), "other");
  });
});

describe("golden R-09 (BRD2 D2-13): the owner's policy as io stated it", () => {
  const w = world();
  const SN = w[ME].primary_name.surname_list[0];
  const owner = [
    ["given names", set(ME, "/primary_name/first_name", "Testa", "Testb"), "proposal"],
    ["surname", set(ME, `/primary_name/surname_list/${k(SN)}/surname`, "Sample", "Other"), "proposal"],
    ["add surname", { op: "add", obj: ME, path: "/primary_name/surname_list", value: surname("Extra") }, "proposal"],
    ["birth year", set("Event:he1", "/date/dateval/2", 1900, 1901), "proposal"],
    ["parents (person side)", { op: "add", obj: ME, path: "/parent_family_list", value: "hf9" }, "proposal"],
    ["parents (family side, child ref)", { op: "add", obj: "Family:hf2", path: "/child_ref_list", value: { _class: "ChildRef", ref: OWN } }, "proposal"],
    ["spouse and children (R-24)", { op: "add", obj: ME, path: "/family_list", value: "hf9" }, "proposal"],
    ["title", set(ME, "/primary_name/title", "", "Dr"), "direct"],
    ["suffix", set(ME, "/primary_name/suffix", "", "Jr"), "direct"],
    ["call", set(ME, "/primary_name/call", "", "Testa"), "direct"],
    ["nick", set(ME, "/primary_name/nick", "Tess", "Tee"), "direct"],
    ["famnick", set(ME, "/primary_name/famnick", "", "Tessie"), "direct"],
    ["name type", set(ME, "/primary_name/type", typed("NameType", 2), typed("NameType", 3)), "direct"],
    ["name date", set(ME, "/primary_name/date", undefined, date(1950)), "direct"],
    ["own name citation", { op: "add", obj: ME, path: "/primary_name/citation_list", value: "hc1" }, "direct"],
    ["gender", set(ME, "/gender", 2, 0), "direct"],
    ["alternate-name type", set(ME, `/alternate_names/${k(w[ME].alternate_names[0])}/type`, typed("NameType", 3), typed("NameType", 4)), "direct"],
    ["alternate-name first name", set(ME, `/alternate_names/${k(w[ME].alternate_names[0])}/first_name`, "Testy", "Tessy"), "proposal"],
    ["alternate-name surname", set(ME, `/alternate_names/${k(w[ME].alternate_names[0])}/surname_list/${k(SN)}/surname`, "Sample", "Other"), "proposal"],
    ["add an alternate name", { op: "add", obj: ME, path: "/alternate_names", value: name("Tee", "Sample") }, "proposal"],
    ["own Burial description", set("Event:he2", "/description", "", "Quiet"), "direct"],
    ["own Burial date", set("Event:he2", "/date/dateval/2", 1980, 1981), "direct"],
    ["own note text", set("Note:hn1", "/text", { _class: "StyledText", string: "hello", tags: [] }, { _class: "StyledText", string: "hi", tags: [] }), "direct"],
    ["own fact", { op: "add", obj: ME, path: "/attribute_list", value: { _class: "Attribute", type: typed("AttributeType", 2), value: "x" } }, "direct"],
    ["own association", { op: "add", obj: ME, path: "/person_ref_list", value: { _class: "PersonRef", ref: "hp2", rel: "Friend" } }, "direct"],
    ["own photo rect (tagging rule)", set(ME, `/media_list/@ref=hm1#0:${hash12(w[ME].media_list[0])}/rect`, [1, 1, 10, 10], [2, 2, 9, 9]), "direct"],
    ["tag assignment", { op: "add", obj: ME, path: "/tag_list", value: "ht1" }, "proposal"],
  ];
  for (const [label, op, want] of owner) {
    it(`owner: ${label} is ${want}`, async () => {
      assert.equal(await codeOf(op), want);
    });
  }
  it("another member gets proposal for all of them", async () => {
    for (const [label, op] of owner) {
      const code = await codeOf(op, { actor: actorOf("I9002") });
      assert.equal(code, "proposal", label);
    }
  });
  it("another person's photo rect is a proposal, an admin's is direct", async () => {
    const op = set("Person:hp2", `/media_list/@ref=hm1#0:${hash12(w["Person:hp2"].media_list[0])}/rect`, [2, 2, 8, 8], [3, 3, 7, 7]);
    assert.equal(await codeOf(op), "proposal");
    assert.equal(await codeOf(op, { actor: actorOf("I9003", true) }), "direct");
  });
  it("admins save every one of them directly", async () => {
    for (const [label, op] of owner) assert.equal(await codeOf(op, { actor: actorOf("I9003", true) }), "direct", label);
  });
});

describe("Birth and Death structure on the own record (IF-02)", () => {
  const w = world();
  const ref = w[ME].event_ref_list[1]; // the Birth EventRef
  it("removing the own Birth EventRef goes to review", async () => {
    assert.equal(await codeOf({ op: "remove", obj: ME, path: `/event_ref_list/@ref=he1`, base: ref }), "proposal");
  });
  it("adding a second Birth event (create + EventRef) goes to review, as one group", async () => {
    const ops = [
      { id: "c", op: "create", obj: "new:1", cls: "Event", value: { _class: "Event", type: typed("EventType", 12), date: date(1901) } },
      { id: "a", op: "add", obj: ME, path: "/event_ref_list", value: { _class: "EventRef", ref: "new:1", role: typed("EventRoleType", 1) } },
    ];
    const classes = await run(ops);
    assert.deepEqual(classes.map((c) => c.code), ["proposal", "proposal"]);
    const p = partitionOps(ops, classes);
    assert.equal(p.review.length, 1);
    assert.equal(p.direct.length, 0);
  });
  it("deleting the Birth Event, and changing an event to or from Birth, are proposals", async () => {
    assert.equal(await codeOf({ op: "delete", obj: "Event:he1", base: contentHash(w["Event:he1"]) }), "proposal");
    assert.equal(await codeOf(set("Event:he2", "/type", typed("EventType", 5), typed("EventType", 12))), "proposal");
    assert.equal(await codeOf(set("Event:he1", "/type", typed("EventType", 12), typed("EventType", 5))), "proposal");
  });
  it("an op that changes which event birth_ref_index resolves to is a proposal", async () => {
    // Demoting the Birth EventRef's role to non-Primary drops it from the index; the role field alone would be direct.
    const roleKey = `/event_ref_list/@ref=he1/role`;
    assert.equal(await codeOf(set(ME, roleKey, typed("EventRoleType", 1), typed("EventRoleType", 3))), "proposal");
    // The same op on a non-birth ref stays direct.
    assert.equal(await codeOf(set(ME, `/event_ref_list/@ref=he2/role`, typed("EventRoleType", 1), typed("EventRoleType", 3))), "direct");
  });
  it("adding or removing the own Death event follows the Q2-15 row: proposal by default", async () => {
    const add = { op: "add", obj: ME, path: "/event_ref_list", value: eref("hd1") };
    assert.equal(await codeOf(add), "proposal");
    const owner = createFieldPolicy({ answers: { "own-death-event": "owner-direct" } });
    assert.equal(await codeOf(add, { policy: owner }), "direct");
  });
  it("adding a Burial EventRef is direct for an event nobody else uses, a proposal for someone else's", async () => {
    const w = world();
    w["Event:hb1"] = { _class: "Event", handle: "hb1", gramps_id: "E9005", type: typed("EventType", 4), date: date(1990), description: "" };
    assert.equal(await codeOf({ op: "add", obj: ME, path: "/event_ref_list", value: eref("hb1") }, { objects: w }), "direct");
    assert.equal(await codeOf({ op: "add", obj: ME, path: "/event_ref_list", value: eref("he3") }, { objects: w }), "proposal", "another person's event");
    assert.equal(await codeOf({ op: "add", obj: ME, path: "/event_ref_list", value: eref("hb1", 3) }, { objects: w }), "proposal", "not the Primary role");
    assert.equal(await codeOf(set(ME, "/event_ref_list/@ref=he2/ref", "he2", "he3")), "proposal", "repointing a ref at another person's event");
  });
});

describe("pointer policy", () => {
  const v = (cls, ptr, viewer, ctx) => DEFAULT_FIELD_POLICY.resolve(cls, ptr, viewer, ctx);
  it("an unmatched pointer resolves to proposal for a member, direct for an admin", () => {
    assert.equal(v("Person", "/zz/unknown", { relation: "own" }), "proposal");
    assert.equal(v("Person", "/zz/unknown", { admin: true }), "direct");
  });
  it("never rows apply to admins too", () => {
    assert.equal(v("Person", "/address_list/*", { admin: true }), "never");
    assert.equal(v("Person", "/address_list/*", { relation: "own" }), "never");
    assert.equal(v("Person", "/urls/*", { admin: true }, { value: { type: typed("UrlType", 1), path: "x" } }), "never");
    assert.equal(v("Person", "/attribute_list/*", { admin: true }, { value: { type: typed("AttributeType", 6) } }), "never");
    assert.equal(v("Place", "/place_type", { admin: true }, { value: typed("PlaceType", 7) }), "never");
  });
  it("Place.code is never on non-administrative types and a proposal on administrative ones", () => {
    const place = (t) => ({ obj: { _class: "Place", place_type: typed("PlaceType", t) }, tree: null });
    assert.equal(v("Place", "/code", { admin: true }, { checks: [place(4)] }), "never");
    assert.equal(v("Place", "/code", { relation: "other" }, { checks: [place(4)] }), "never");
    assert.equal(v("Place", "/code", { relation: "other" }, { checks: [place(1)] }), "proposal");
    assert.equal(v("Place", "/code", { admin: true }, { checks: [place(1)] }), "direct");
  });
  it("a Birth date's day and month are never, evaluated on the resulting objects", async () => {
    assert.equal(await codeOf(set("Event:he1", "/date/dateval/0", 0, 5)), "never");
    assert.equal(await codeOf(set("Event:he1", "/date/dateval/0", 0, 5), { actor: actorOf("I9003", true) }), "never");
    assert.equal(await codeOf(set("Event:he1", "/date", date(1900), date(1900, 3, 4))), "never");
    assert.equal(await codeOf(set("Event:he1", "/date", date(1900), date(1901))), "proposal");
  });
  it("desk and derived rows are refused for members and admins alike by default", () => {
    assert.equal(v("Person", "/gramps_id", { admin: true }), "desk");
    assert.equal(v("Person", "/private", { relation: "own" }), "desk");
    assert.equal(v("Person", "/birth_ref_index", { admin: true }), "derived");
  });
  it("a new custom type string is admin-only by default (Q2-15), an existing one is not", async () => {
    const custom = (s) => set("Event:he2", "/type", typed("EventType", 5), typed("EventType", 0, s));
    assert.equal(await codeOf(custom("Wake")), "admin");
    assert.equal(await codeOf(custom("Wake"), { actor: actorOf("I9003", true) }), "direct");
    assert.equal(await codeOf(custom("Wake"), { customTypes: { EventType: new Set(["Wake"]) } }), "direct");
  });
  it("a malformed op is refused, never direct", async () => {
    const [c] = await run([{ id: "x", op: "set", obj: ME, path: "no-slash", base: 1, value: 2 }]);
    assert.equal(c.code, "never");
  });
});

describe("schema coverage", () => {
  const ptrs = (s, root, prefix, out, seen) => {
    if (s.$ref) {
      const n = s.$ref.split("/").pop();
      if (!seen.includes(n)) ptrs(root.$defs[n], root, prefix, out, seen.concat(n));
      return;
    }
    if (s.type === "array" || s.items) {
      out.add(`${prefix}/*`);
      if (s.items) ptrs(s.items, root, `${prefix}/*`, out, seen);
      return;
    }
    for (const key of ["oneOf", "anyOf", "allOf"]) (s[key] ?? []).forEach((x) => ptrs(x, root, prefix, out, seen));
    for (const [name, sub] of Object.entries(s.properties ?? {})) {
      out.add(`${prefix}/${name}`);
      ptrs(sub, root, `${prefix}/${name}`, out, seen);
    }
  };
  const pointers = (cls) => {
    const s = JSON.parse(readFileSync(join(SCHEMA_DIR, `${cls}.schema.json`), "utf8"));
    const out = new Set();
    ptrs(s, s, "", out, []);
    return [...out];
  };
  it("every pointer in the committed record schemas matches a policy row", () => {
    const missing = [];
    for (const cls of CLASSES) for (const p of pointers(cls)) if (!DEFAULT_FIELD_POLICY.findRow(cls, p.slice(1).split("/"), null, true)) missing.push(`${cls}${p}`);
    assert.deepEqual(missing, []);
  });
  it("no record-metadata pointer resolves to admin-only, for anyone", () => {
    const bad = [];
    for (const cls of CLASSES) {
      for (const p of pointers(cls)) {
        for (const viewer of [{ relation: "own" }, { relation: "other" }, { admin: true }]) {
          const code = DEFAULT_FIELD_POLICY.resolve(cls, p, viewer);
          if (code === "admin") bad.push(`${cls}${p}`);
        }
      }
    }
    assert.deepEqual(bad, []);
  });
  it("only the Q2-15 rows are admin-only, and they are not pointer rows", () => {
    assert.deepEqual(FIELD_POLICY_ROWS.filter((r) => r[2] === "admin" || r[3] === "admin"), []);
    assert.deepEqual(Q2_15_ROWS.filter((r) => r.own === "admin").map((r) => r.id), ["custom-type-string"]);
  });
  it("the never type values equal the schema generator's", () => {
    assert.deepEqual(NEVER_TYPE_VALUES, NEVER.typeValues);
  });
});

describe("Q2-15 switches change data, not code", () => {
  const spouse = { op: "add", obj: ME, path: "/family_list", value: "hf9" };
  const desk = (admin) => DEFAULT_FIELD_POLICY && createFieldPolicy({ answers: { "desk-list": "admin-web" } }).resolve("Person", "/gramps_id", { admin, relation: "other" });
  it("each row lists its answers and the document names them", () => {
    const doc = DEFAULT_FIELD_POLICY.document();
    assert.deepEqual(doc.q2_15.map((r) => r.id), ["spouse-children", "own-death-event", "custom-type-string", "desk-list"]);
    assert.equal(doc.rows.length, FIELD_POLICY_ROWS.length);
  });
  it("spouse-children: default proposal, owner-direct makes the owner's family_list direct (others stay proposal)", async () => {
    assert.equal(await codeOf(spouse), "proposal");
    const p = createFieldPolicy({ answers: { "spouse-children": "owner-direct" } });
    assert.equal(await codeOf(spouse, { policy: p }), "direct");
    assert.equal(await codeOf(spouse, { policy: p, actor: actorOf("I9002") }), "proposal");
  });
  it("own-death-event: default proposal, owner-direct direct, for add, remove and delete", async () => {
    const w = world();
    w[ME].event_ref_list.push(eref("hd1"));
    const ops = [
      { op: "add", obj: ME, path: "/event_ref_list", value: eref("hd1") },
      { op: "remove", obj: ME, path: "/event_ref_list/@ref=hd1", base: eref("hd1") },
      { op: "delete", obj: "Event:hd1", base: contentHash(w["Event:hd1"]) },
    ];
    const p = createFieldPolicy({ answers: { "own-death-event": "owner-direct" } });
    for (const op of ops) {
      assert.equal(await codeOf(op, { objects: w }), "proposal", op.op);
      assert.equal(await codeOf(op, { objects: w, policy: p }), "direct", op.op);
    }
  });
  it("custom-type-string: default admin-only, the proposal answer lets a member propose it", async () => {
    const op = set("Event:he2", "/type", typed("EventType", 5), typed("EventType", 0, "Wake"));
    assert.equal(await codeOf(op), "admin");
    assert.equal(await codeOf(op, { policy: createFieldPolicy({ answers: { "custom-type-string": "proposal" } }) }), "proposal");
  });
  it("desk-list: default desk for all, admin-web lets admins save them", () => {
    assert.equal(createFieldPolicy().resolve("Person", "/gramps_id", { admin: true }), "desk");
    assert.equal(desk(true), "direct");
    assert.equal(desk(false), "desk");
    assert.equal(createFieldPolicy({ answers: { "desk-list": "admin-web" } }).resolve("Place", "/title", { admin: true }), "direct");
  });
  it("an unknown row or answer throws", () => {
    assert.throws(() => createFieldPolicy({ answers: { nope: "x" } }));
    assert.throws(() => createFieldPolicy({ answers: { "desk-list": "nope" } }));
  });
});

describe("partition", () => {
  it("ops sharing a new:n object stay in one group", () => {
    const ops = [
      { id: "a", op: "create", obj: "new:1", cls: "Event", value: {} },
      { id: "b", op: "add", obj: ME, path: "/event_ref_list", value: { ref: "new:1" } },
      { id: "c", op: "set", obj: ME, path: "/gender", base: 2, value: 1 },
      { id: "d", op: "set", obj: "new:1", path: "/description", base: "", value: "x" },
    ];
    assert.deepEqual(groupOps(ops), [[0, 1, 3], [2]]);
  });
  it("both sides of a family link stay together", () => {
    const ops = [
      { id: "a", op: "add", obj: ME, path: "/family_list", value: "hf9" },
      { id: "b", op: "set", obj: "Person:hp2", path: "/gender", base: 1, value: 0 },
      { id: "c", op: "set", obj: "Family:hf9", path: "/father_handle", base: "", value: OWN },
      { id: "d", op: "add", obj: "Family:hf2", path: "/child_ref_list", value: { ref: OWN } },
      { id: "e", op: "add", obj: ME, path: "/parent_family_list", value: "hf2" },
    ];
    assert.deepEqual(groupOps(ops), [[0, 2], [1], [3, 4]]);
    const rem = [
      { id: "a", op: "remove", obj: ME, path: "/family_list/@=hf1", base: "hf1" },
      { id: "b", op: "remove", obj: "Family:hf1", path: "/child_ref_list/@ref=hp9", base: {} },
      { id: "c", op: "remove", obj: "Family:hf1", path: `/child_ref_list/@ref=${OWN}`, base: {} },
    ];
    assert.deepEqual(groupOps(rem), [[0, 2], [1]]);
  });
  it("a group with any proposal op goes to review, direct groups commit, refused groups are named", async () => {
    const ops = [
      { id: "n", op: "set", obj: ME, path: "/primary_name/nick", base: "Tess", value: "Tee" },
      { id: "f", op: "set", obj: ME, path: "/primary_name/first_name", base: "Testa", value: "Testb" },
      { id: "g", op: "set", obj: ME, path: "/gramps_id", base: "I9001", value: "I9100" },
    ];
    const plan = planOps(ops, await run(ops));
    assert.deepEqual(plan.direct.map((g) => g.opIds), [["n"]]);
    assert.deepEqual(plan.review.map((g) => g.opIds), [["f"]]);
    assert.deepEqual(plan.refused.map((g) => [g.opIds, g.code]), [[["g"], "desk"]]);
  });
  it("a direct op tied to a proposal op by a new object is dragged into review with it", async () => {
    const ops = [
      { id: "c", op: "create", obj: "new:1", cls: "Event", value: { _class: "Event", type: typed("EventType", 5), description: "x" } },
      { id: "a", op: "add", obj: ME, path: "/event_ref_list", value: eref("new:1") },
      { id: "p", op: "add", obj: "Event:he3", path: "/citation_list", value: "new:2" },
      { id: "q", op: "create", obj: "new:2", cls: "Citation", value: { _class: "Citation", page: "p1" } },
    ];
    const classes = await run(ops);
    assert.deepEqual(classes.map((c) => c.code), ["direct", "direct", "proposal", "proposal"]);
    const plan = planOps(ops, classes);
    assert.deepEqual(plan.direct.map((g) => g.opIds), [["c", "a"]]);
    assert.deepEqual(plan.review.map((g) => g.opIds), [["p", "q"]]);
  });
});

describe("summaries are plain language", () => {
  const ops = [
    set(ME, "/primary_name/nick", "Tess", "Tee"),
    set(ME, "/primary_name/first_name", "Testa", "Testb"),
    set(ME, "/gender", 2, 1),
    set(ME, "/primary_name/type", typed("NameType", 2), typed("NameType", 3)),
    set("Event:he1", "/date/dateval/2", 1900, 1901),
    { op: "add", obj: ME, path: "/parent_family_list", value: "hf9" },
    { op: "add", obj: ME, path: "/family_list", value: "hf9" },
    { op: "remove", obj: ME, path: "/family_list/@=hf1", base: "hf1" },
    { op: "add", obj: "Family:hf2", path: "/child_ref_list", value: { _class: "ChildRef", ref: OWN, frel: typed("ChildRefType", 1), mrel: typed("ChildRefType", 1) } },
    { op: "remove", obj: "Family:hf2", path: `/child_ref_list/@ref=${OWN}`, base: { _class: "ChildRef", ref: OWN } },
    set("Family:hf2", "/father_handle", "hp3", "hp4"),
    set("Family:hf2", `/child_ref_list/@ref=${OWN}/frel`, typed("ChildRefType", 1), typed("ChildRefType", 2)),
    { op: "create", obj: "new:1", cls: "Person", value: { _class: "Person", primary_name: name("Newa", "Sample") } },
    { op: "add", obj: ME, path: "/alternate_names", value: name("Tee", "Sample") },
    { op: "add", obj: ME, path: "/event_ref_list", value: eref("he3") },
    { op: "delete", obj: "Event:he2", base: "x".repeat(64) },
    set("Place:hl1", "/place_type", typed("PlaceType", 4), typed("PlaceType", 3)),
  ];
  const texts = ops.map((op) => summarizeOp(op));
  it("contains no Gramps jargon", () => {
    for (const t of texts) {
      assert.equal(JARGON.test(t), false, t);
      assert.doesNotMatch(t, /ChildRef|frel|handle|gramps_id/i, t);
    }
  });
  it("reads as sentences (snapshot)", () => {
    assert.deepEqual(texts.slice(0, 8), [
      "change the nickname from “Tess” to “Tee”",
      "change the given names from “Testa” to “Testb”",
      "change the gender from “unknown” to “male”",
      "change the name type from “Birth Name” to “Married Name”",
      "change the date from 1900 to 1901",
      "add a parent connection",
      "add a spouse or child connection",
      "remove a spouse or child connection",
    ]);
  });
  it("names the change, not the plumbing", () => {
    assert.equal(texts[11], "change the relationship to the father for a child from “Birth” to “Adopted”");
    assert.match(texts[4], /date/);
    assert.equal(texts[12], "add a new person “Newa Sample”");
    assert.equal(texts[13], "add another name “Tee Sample”");
    assert.equal(texts[14], "add an event");
    assert.equal(texts[15], "remove an event");
    assert.equal(texts[10], "change a parent");
  });
  it("a plan's summary carries the op ids and nothing internal", async () => {
    const o = [{ id: "n", op: "set", obj: ME, path: "/primary_name/nick", base: "Tess", value: "Tee" }];
    const plan = planOps(o, await run(o));
    assert.deepEqual(plan.direct[0].summary, [{ text: "change the nickname from “Tess” to “Tee”", opIds: ["n"] }]);
  });
});

describe("review fixes (HFY-TSK-233)", () => {
  const typedAttr = (v, string = "") => ({ _class: "Attribute", type: typed("AttributeType", v, string), value: "x" });
  const never = typedAttr(6);
  const benign = typedAttr(2);
  const mail = { _class: "Url", path: "a@example.test", desc: "", type: typed("UrlType", 1) };
  const site = { _class: "Url", path: "https://example.test", desc: "", type: typed("UrlType", 2) };
  const withLists = () => {
    const w = world();
    w[ME].attribute_list = [never, benign, typedAttr(0, "Merged Gramps ID")];
    w[ME].urls = [mail, site];
    return w;
  };

  describe("Q2-15 spouse-children covers both sides of a link", () => {
    const owner = createFieldPolicy({ answers: { "spouse-children": "owner-direct" } });
    const unlink = [
      { id: "a", op: "remove", obj: ME, path: "/family_list/@=hf1", base: "hf1" },
      { id: "b", op: "set", obj: "Family:hf1", path: "/father_handle", base: OWN, value: "" },
    ];
    it("by default the whole link group is a review group", async () => {
      const plan = planOps(unlink, await run(unlink));
      assert.deepEqual(plan.review.map((g) => g.opIds), [["a", "b"]]);
      assert.deepEqual(plan.direct, []);
    });
    it("owner-direct makes a full spouse link group direct, with no code change", async () => {
      const plan = planOps(unlink, await run(unlink, { policy: owner }));
      assert.deepEqual(plan.direct.map((g) => g.opIds), [["a", "b"]]);
      assert.deepEqual(plan.review, []);
    });
    it("a child link on a family the member belongs to follows the switch; a stranger's family never does", async () => {
      const add = { op: "add", obj: "Family:hf1", path: "/child_ref_list", value: { _class: "ChildRef", ref: "hc9" } };
      assert.equal(await codeOf(add), "proposal");
      assert.equal(await codeOf(add, { policy: owner }), "direct");
      const w = world();
      w["Family:hf1"].father_handle = "hp3";
      assert.equal(await codeOf(add, { policy: owner, objects: w }), "proposal");
      assert.equal(await codeOf(set("Family:hf1", "/type", typed("FamilyRelType", 1), typed("FamilyRelType", 2)), { policy: owner }), "proposal", "other Family fields stay proposals");
    });
  });

  it("every group tag in the table has a Q2-15 switch, and every grouped switch is used", () => {
    const tags = new Set(FIELD_POLICY_ROWS.map((r) => r[4]?.group).filter(Boolean));
    const switches = Q2_15_ROWS.filter((r) => r.group);
    assert.deepEqual([...tags].sort(), switches.map((r) => r.id).sort());
    for (const r of switches) assert.equal(r.id, r.group);
  });

  describe("withheld attribute and URL types are judged on the stored element too", () => {
    it("editing the value of, retyping, or removing a never-type element is never; a benign element stays direct", async () => {
      const w = withLists();
      const nk = k(never);
      assert.equal(await codeOf(set(ME, `/attribute_list/${nk}/value`, "x", "y"), { objects: w }), "never");
      assert.equal(await codeOf(set(ME, `/attribute_list/${nk}/type`, never.type, typed("AttributeType", 2)), { objects: w }), "never");
      assert.equal(await codeOf({ op: "remove", obj: ME, path: `/attribute_list/${nk}`, base: never }, { objects: w }), "never");
      assert.equal(await codeOf(set(ME, `/attribute_list/${k(benign)}/value`, "x", "y"), { objects: w }), "direct");
      const uk = k(mail);
      assert.equal(await codeOf(set(ME, `/urls/${uk}/path`, mail.path, "b@example.test"), { objects: w }), "never");
      assert.equal(await codeOf(set(ME, `/urls/${uk}/type`, mail.type, typed("UrlType", 2)), { objects: w }), "never");
      assert.equal(await codeOf(set(ME, `/urls/${k(site)}/path`, site.path, "https://other.example.test"), { objects: w }), "direct");
    });
    it("a key that matches no stored element is not directly writable", async () => {
      assert.equal(await codeOf(set(ME, "/attribute_list/@k=000000000000/value", "x", "y"), { objects: withLists() }), "never");
    });
    it("a Merged Gramps ID attribute is desktop-only (the sync identity key); a member cannot write it", async () => {
      const w = withLists();
      const merged = typedAttr(0, "Merged Gramps ID");
      assert.equal(await codeOf({ op: "add", obj: ME, path: "/attribute_list", value: typedAttr(0, "merged gramps id") }, { objects: w }), "desk");
      assert.equal(await codeOf(set(ME, `/attribute_list/${k(merged)}/value`, "x", "y"), { objects: w }), "desk");
      assert.equal(await codeOf({ op: "add", obj: ME, path: "/attribute_list", value: benign }, { objects: w }), "direct");
    });
  });

  it("remove and move are judged on the stored element, not on the submitted base", async () => {
    const w = withLists();
    const path = `/attribute_list/${k(never)}`;
    assert.equal(await codeOf({ op: "remove", obj: ME, path }, { objects: w }), "never", "base omitted");
    assert.equal(await codeOf({ op: "remove", obj: ME, path, base: benign }, { objects: w }), "never", "forged base");
    assert.equal(await codeOf({ op: "move", obj: ME, path, before: "x" }, { objects: w }), "never", "move");
    assert.equal(await codeOf({ op: "remove", obj: ME, path: "/note_list/@=hn1" }), "direct", "a plain element with no base is judged on what is stored");
    assert.equal(await codeOf({ op: "remove", obj: ME, path: "/note_list/@=hn1", base: "other" }), "proposal", "a base that differs from the stored element");
    assert.equal(await codeOf({ op: "remove", obj: ME, path: "/note_list/@=zz" }), "proposal", "no such element");
  });

  it("a set is judged against the stored value, not the submitted base", async () => {
    // Forged base equal to the new name apart from nick: only the nick would look changed.
    const forged = { ...world()[ME].primary_name, first_name: "Changed", nick: "Tess" };
    const real = world()[ME].primary_name;
    const out = await codeOf({ op: "set", obj: ME, path: "/primary_name", base: { ...forged, nick: "Old" }, value: forged });
    assert.equal(out, "proposal");
    assert.equal(real.first_name, "Testa");
  });

  it("resolve with no ctx answers for the stricter row", () => {
    const v = (cls, ptr, viewer, ctx) => DEFAULT_FIELD_POLICY.resolve(cls, ptr, viewer, ctx);
    assert.equal(v("Event", "/date/dateval/0", { relation: "own" }), "never");
    assert.equal(v("Person", "/attribute_list/*", { relation: "own" }), "never");
    assert.equal(v("Place", "/code", { relation: "own" }), "never");
    assert.equal(v("Event", "/date/dateval/0", { relation: "own" }, { value: 5 }), "never", "ctx without checks");
    assert.equal(v("Event", "/description", { relation: "own" }), "direct", "unconditional rows are unchanged");
  });

  it("Media file fields are a proposal for members and not writable by any web client for admins", () => {
    for (const f of ["path", "mime", "checksum", "thumb"]) {
      assert.equal(DEFAULT_FIELD_POLICY.resolve("Media", `/${f}`, { relation: "own" }), "proposal", f);
      assert.equal(DEFAULT_FIELD_POLICY.resolve("Media", `/${f}`, { admin: true }), "derived", f);
    }
  });

  describe("a note whose text looks like a temp handle does not tie ops together", () => {
    it("groups only by reference positions", () => {
      const ops = [
        { id: "a", op: "create", obj: "new:1", cls: "Note", value: { _class: "Note", text: { _class: "StyledText", string: "new:2", tags: [] } } },
        { id: "b", op: "create", obj: "new:2", cls: "Event", value: { _class: "Event", description: "x" } },
        { id: "c", op: "add", obj: ME, path: "/note_list", value: "new:1" },
        { id: "d", op: "add", obj: ME, path: "/event_ref_list", value: { ref: "new:2" } },
        { id: "e", op: "set", obj: ME, path: "/primary_name/nick", base: "Tess", value: "new:2" },
      ];
      assert.deepEqual(groupOps(ops), [[0, 2], [1, 3], [4]]);
    });
  });

  describe("summaries do not echo a birth date's day and month", () => {
    const objects = world();
    it("reduces a birth event's date to its year and names a day or month edit generally", () => {
      const full = summarizeOp(set("Event:he1", "/date", date(1900), date(1901, 3, 4)), { objects });
      assert.match(full, /1901/);
      assert.doesNotMatch(full, /March|\b4\b|\b3\b/);
      const day = summarizeOp(set("Event:he1", "/date/dateval/0", 0, 5), { objects });
      assert.doesNotMatch(day, /\b5\b/);
      const other = summarizeOp(set("Event:he2", "/date", date(1980, 3, 4), date(1981, 5, 6)), { objects });
      assert.match(other, /March/);
    });
  });
});
