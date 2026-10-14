// HFY-TSK-157: the editors of the other record classes (src/lib/editor-records.js). The form of each of the eight classes, the EditOps a change makes
// (every case runs them through the ops engine, api/src/records/ops.js), the styled-note rule (DEC-E11), the place-type and address rules (DEC-E12,
// R-18), the place code and coordinate rules, the replay after a save, the drill-down links, and that every desk or never row of the live field-policy
// table is absent from the forms or explained (AC2). Synthetic records only.
import test from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { applyOps } from "../../api/src/records/ops.js";
import { DEFAULT_FIELD_POLICY, NEVER_TYPE_VALUES, classifyOps } from "../../api/src/records/field-policy.js";
import { createEditGuard } from "../../shared/edit-guard.mjs";
import { EDIT_SCHEMAS } from "../src/lib/edit-schemas.js";
import { COPY, PERSON_SECTIONS, badgeFor, createModeResolver, parseRoute, sectionSchema, sectionValues, sectionsFor } from "../src/lib/editor-model.js";
import {
  COORDINATE_POLICY, PLACE_TYPES_ADMINISTRATIVE, RECORD_COPY, RECORD_FIELDS, PLACE_TYPES_SKIPPED, drillLinks, placeCodeOpen, recordNotes, recordOps,
  recordPolicy, recordSchema, recordSeed, recordTitle, roundedCoordinate
} from "../src/lib/editor-records.js";
import { BIRTH_LIKE_CODES, BIRTH_LIKE_CUSTOM, isBirthCode, makeLookups, restyleText } from "../src/lib/editor-sections.js";
import { countOps, modeOfOp, opsFromDrafts, replayDrafts, settledUnitsOf } from "../src/lib/editor-save.js";

const REDACTION = JSON.parse(readFileSync(new URL("../../gramps/redaction/redaction-v1.json", import.meta.url), "utf8"));

const typed = (cls, value, string = "") => ({ _class: cls, value, string });
const date = (d, m, y, extra = {}) => ({ _class: "Date", calendar: 0, modifier: 0, quality: 0, dateval: [d, m, y, false], text: "", sortval: 2400000, newyear: 0, ...extra });
const CLASSES = ["Event", "Place", "Source", "Citation", "Repository", "Media", "Note", "Family"];

const OBJECTS = {
  Event: { _class: "Event", handle: "he1", gramps_id: "E9001", type: typed("EventType", 21), date: date(14, 3, 1990), place: "hl1", description: "At home", citation_list: ["hc1"], note_list: ["hn1"], tag_list: ["ht1"] },
  Place: { _class: "Place", handle: "hl1", gramps_id: "P9001", name: { _class: "PlaceName", value: "Synthville", lang: "" }, place_type: typed("PlaceType", 4), code: "", lat: "", long: "", placeref_list: [{ _class: "PlaceRef", ref: "hl2", date: date(0, 0, 0) }], citation_list: ["hc1"], note_list: ["hn1"], tag_list: [] },
  Source: { _class: "Source", handle: "hs1", gramps_id: "S9001", title: "A synthetic ledger", author: "", pubinfo: "", abbrev: "", reporef_list: [{ _class: "RepoRef", ref: "hr1", call_number: "Box 4", media_type: typed("SourceMediaType", 1) }], note_list: ["hn1"], tag_list: [] },
  Citation: { _class: "Citation", handle: "hc1", gramps_id: "C9001", source_handle: "hs1", page: "p. 3", confidence: 2, date: date(0, 0, 1951), note_list: ["hn1"], tag_list: [] },
  Repository: { _class: "Repository", handle: "hr1", gramps_id: "R9001", name: "Synthetic Archive", type: typed("RepositoryType", 1), note_list: ["hn1"], tag_list: [] },
  Media: { _class: "Media", handle: "hm1", gramps_id: "O9001", desc: "Front porch", path: "synthetic/porch.jpg", mime: "image/jpeg", date: date(0, 0, 0), citation_list: ["hc1"], note_list: ["hn1"], tag_list: [] },
  Note: { _class: "Note", handle: "hn1", gramps_id: "N9001", type: typed("NoteType", 1), format: 0, tag_list: [], text: { _class: "StyledText", string: "Hello bold world and more", tags: [{ _class: "StyledTextTag", name: typed("StyledTextTagType", 0), value: null, ranges: [[6, 10]] }, { _class: "StyledTextTag", name: typed("StyledTextTagType", 1), value: null, ranges: [[21, 25]] }] } },
  Family: { _class: "Family", handle: "hf1", gramps_id: "F9001", type: typed("FamilyRelType", 1), father_handle: "hp1", mother_handle: "hp2", child_ref_list: [{ _class: "ChildRef", ref: "hp3" }], event_ref_list: [{ _class: "EventRef", ref: "he1", role: typed("EventRoleType", 8) }], note_list: ["hn1"], tag_list: ["ht1"] }
};
const RELATED = {
  "Place:hl1": { version: 1, obj: OBJECTS.Place }, "Place:hl2": { version: 1, obj: { _class: "Place", handle: "hl2", gramps_id: "P9002", name: { _class: "PlaceName", value: "Exampleton", lang: "" }, place_type: typed("PlaceType", 2) } },
  "Citation:hc1": { version: 4, obj: OBJECTS.Citation }, "Source:hs1": { version: 2, obj: OBJECTS.Source }, "Repository:hr1": { version: 3, obj: OBJECTS.Repository },
  "Note:hn1": { version: 2, obj: OBJECTS.Note }, "Event:he1": { version: 3, obj: OBJECTS.Event },
  "Person:hp1": { version: 1, stub: { displayName: "Sam Example" } }, "Person:hp2": { version: 1, stub: { displayName: "Pat Example" } }, "Person:hp3": { version: 1, stub: { displayName: "Robin Sample" } }
};
const TAGS = [{ handle: "ht1", name: "family" }, { handle: "ht2", name: "needs a check" }];
const bundleFor = (cls, { admin = false, relation = "other", obj = OBJECTS[cls] } = {}) => ({
  key: `${cls}:${obj.handle}`, version: 7, obj: JSON.parse(JSON.stringify(obj)), related: RELATED, relation, viewer: { admin }, tags: TAGS, customTypes: { EventType: ["Synthetic custom"] }
});
const schemas = EDIT_SCHEMAS;
const secOf = (cls) => sectionsFor(cls, {}).find((s) => s.id === "details");
const viewer = (admin = false) => ({ admin, relation: "other" });

/** Run a draft through the builders and the ops engine. */
function run(cls, draft, opts = {}) {
  const b = bundleFor(cls, opts);
  const section = secOf(cls);
  const built = opsFromDrafts({ key: b.key, sections: [section], obj: b.obj, bundle: b, drafts: { details: draft }, viewer: viewer(opts.admin) });
  let n = 0;
  const applied = applyOps({ [b.key]: b.obj }, built.ops, { versions: { [b.key]: b.version }, mint: () => `m${++n}` });
  return { ...built, applied, b };
}
const valuesOf = (cls) => ({ ...sectionValues(OBJECTS[cls], secOf(cls).form) });

test("each of the 8 classes has a details form and a related-pages section; Person keeps its own sections", () => {
  for (const cls of CLASSES) {
    const secs = sectionsFor(cls, {});
    assert.deepEqual(secs.map((s) => s.id), ["details", "related"], cls);
    assert.ok(secs[0].form.record && secs[0].form.cls === cls);
    assert.ok(secs[1].drill);
    assert.ok(RECORD_FIELDS[cls].some((f) => f.key === "tags"), `${cls} takes tags`);
  }
  assert.ok(PERSON_SECTIONS.length > 5);
});

test("the route opens every class by gramps id or h:handle", () => {
  for (const cls of CLASSES) {
    assert.deepEqual(parseRoute(`?cls=${cls.toLowerCase()}&id=X1`), { cls, ref: "X1" });
    assert.deepEqual(parseRoute(`?cls=${cls.toLowerCase()}&id=h:abc123`), { cls, ref: "h:abc123" });
  }
});

test("every form builds a schema from the generated class schema, and every field has a value or a blank", () => {
  for (const cls of CLASSES) {
    const b = bundleFor(cls);
    const lookups = makeLookups(b, schemas);
    const sec = secOf(cls);
    const schema = sectionSchema(schemas[cls], sec.form, lookups, sectionValues(b.obj, sec.form));
    assert.deepEqual(Object.keys(schema.properties), RECORD_FIELDS[cls].map((f) => f.key), cls);
    assert.equal(schema.additionalProperties, false);
  }
});

test("the place type select leaves out Street, Building and Number (DEC-E12)", () => {
  const b = bundleFor("Place");
  const sec = secOf("Place");
  const schema = sectionSchema(schemas.Place, sec.form, makeLookups(b, schemas), sectionValues(b.obj, sec.form));
  const values = schema.properties.place_type.oneOf.map((o) => o.const);
  for (const v of PLACE_TYPES_SKIPPED) assert.ok(!values.includes(String(v)), `type ${v} is offered`);
  assert.deepEqual([...PLACE_TYPES_SKIPPED], [7, 19, 20]);
  const labels = schema.properties.place_type.oneOf.map((o) => o.title).join("|");
  assert.ok(!/street|building|number/.test(labels), labels);
  assert.ok(values.includes("4") && values.includes("1"), "city and country stay");
  // a place the record already holds as a street is shown as what it is, not as a choice: the schema lists it only so the old value shows
  const old = sectionSchema(schemas.Place, sec.form, makeLookups(b, schemas), { place_type: "7" });
  assert.ok(old.properties.place_type.oneOf.some((o) => o.const === "7"));
});

test("the repository editor has no Addresses tab: no address field, and the schema has none to render", () => {
  const sec = secOf("Repository");
  assert.deepEqual(sec.form.fields.map((f) => f.key), ["name", "type", "tags"]);
  assert.ok(!sec.form.fields.some((f) => /address/i.test(f.key + f.ptr + f.title)));
  assert.equal(schemas.Repository.properties.address_list, undefined);
  const b = bundleFor("Repository");
  const schema = sectionSchema(schemas.Repository, sec.form, makeLookups(b, schemas), {});
  assert.ok(!JSON.stringify(schema).toLowerCase().includes("address") || schema.properties.type.description === RECORD_COPY.repoNoAddress);
  assert.equal(schema.properties.type.description, RECORD_COPY.repoNoAddress);
  // the Place form has no locations tab either
  assert.ok(!secOf("Place").form.fields.some((f) => /alt_loc|location/i.test(f.ptr)));
});

test("text, type and confidence changes are set ops with the base the bundle served, and apply", () => {
  const r = run("Event", { ...valuesOf("Event"), description: "At the house", type: "22" });
  assert.deepEqual(r.ops.map((o) => [o.id, o.path, o.base, o.value]).sort(), [
    ["details.description.1", "/description", "At home", "At the house"],
    ["details.type.1", "/type", typed("EventType", 21), typed("EventType", 22)]
  ].sort());
  assert.ok(r.applied.ok, JSON.stringify(r.applied.conflicts));
  assert.equal(r.applied.objects["Event:he1"].description, "At the house");
  const c = run("Citation", { ...valuesOf("Citation"), confidence: "4", page: "p. 9" });
  assert.deepEqual(c.ops.map((o) => [o.path, o.base, o.value]).sort(), [["/confidence", 2, 4], ["/page", "p. 3", "p. 9"]]);
  assert.ok(c.applied.ok);
  const none = run("Citation", valuesOf("Citation"));
  assert.deepEqual(none.ops, []);
});

test("a Place: name goes through /name/value, a latitude is text, the type is a typed set; a place inside another is a remove and an add", () => {
  const r = run("Place", { ...valuesOf("Place"), name: "Synthburg", lat: "47.6", place_type: "3", enclosed: { ref: "", name: "Newland" } });
  const byPath = Object.fromEntries(r.ops.map((o) => [o.path || o.obj, o]));
  assert.equal(byPath["/name/value"].value, "Synthburg");
  assert.equal(byPath["/name/value"].base, "Synthville");
  assert.deepEqual(byPath["/lat"], { id: byPath["/lat"].id, op: "set", obj: "Place:hl1", path: "/lat", base: "", value: "47.6" });
  assert.deepEqual(byPath["/place_type"].value, typed("PlaceType", 3));
  assert.ok(r.ops.some((o) => o.op === "create" && o.cls === "Place" && o.value.name.value === "Newland"), "a place that is not listed is created");
  assert.ok(r.ops.some((o) => o.op === "remove" && /^\/placeref_list\/@ref=hl2/.test(o.path)));
  assert.ok(r.ops.some((o) => o.op === "add" && o.path === "/placeref_list" && o.value.ref === "new:1"));
  assert.ok(r.applied.ok, JSON.stringify(r.applied.conflicts));
  const moved = r.applied.objects["Place:hl1"];
  assert.equal(moved.placeref_list.length, 1);
  assert.notEqual(moved.placeref_list[0].ref, "hl2");
  const same = run("Place", { ...valuesOf("Place"), enclosed: { ref: "hl2", name: "" } });
  assert.deepEqual(same.ops, []);
});

test("a citation's source change, an event's place pick, and a new source or place go to review as new objects", () => {
  const c = run("Citation", { ...valuesOf("Citation"), source: { ref: "", name: "A newly found ledger" } });
  assert.deepEqual(c.ops.map((o) => o.op), ["create", "set"]);
  assert.equal(c.ops[1].path, "/source_handle");
  assert.equal(c.ops[1].value, "new:1");
  assert.ok(c.applied.ok);
  const e = run("Event", { ...valuesOf("Event"), place: { ref: "hl2", name: "" } });
  assert.deepEqual(e.ops.map((o) => [o.path, o.base, o.value]), [["/place", "hl1", "hl2"]]);
});

test("dates: a member's edit carries the record's version and the parts changed; an admin's carries the stored date; a birth keeps its year only", () => {
  const edited = { ...valuesOf("Event"), date: date(15, 3, 1990) };
  const m = run("Event", edited);
  assert.equal(m.ops.length, 1);
  assert.equal(m.ops[0].base_version, 7);
  assert.deepEqual(m.ops[0].sets, ["day"]);
  const a = run("Event", edited, { admin: true });
  assert.deepEqual(a.ops[0].base, OBJECTS.Event.date);
  const birthDraft = { ...valuesOf("Event"), type: "12", date: date(15, 3, 1990) };
  const b = run("Event", birthDraft);
  const dateOp = b.ops.find((o) => o.path === "/date");
  assert.deepEqual(dateOp.value.dateval.slice(0, 3), [0, 0, 1990], "day and month are zero on a birth");
  const same = run("Event", valuesOf("Event"));
  assert.deepEqual(same.ops, []);
});

test("every birth-like type is cut to a year and badged by the birth-year row (D2-32); the list is the policy file's", () => {
  const pol = JSON.parse(readFileSync(new URL("../../gramps/redaction/redaction-v1.json", import.meta.url), "utf8")).birthLike;
  assert.deepEqual([...BIRTH_LIKE_CODES], pol.eventTypes.map((t) => t.value));
  assert.equal(BIRTH_LIKE_CUSTOM.source, pol.customType.pattern);
  for (const code of ["12", "14", "15", "18", "22", "45", "c:Baptism of a child"]) {
    const r = run("Event", { ...valuesOf("Event"), type: code, date: date(15, 3, 1990) });
    const op = r.ops.find((o) => o.path === "/date");
    assert.deepEqual(op.value.dateval.slice(0, 3), [0, 0, 1990], `${code} keeps the year only`);
    assert.equal(recordPolicy(secOf("Event").form, "date", { type: code })[1], "/date/dateval/2", code);
  }
  for (const code of ["21", "c:Synthetic custom", "-1", ""]) {
    assert.equal(isBirthCode(code), false, code);
    assert.equal(recordPolicy(secOf("Event").form, "date", { type: code })[1], "/description", code);
  }
});

test("fields explain the year-only date, the rounded coordinates and the administrative-only code; own and unknown tag handles", () => {
  for (const cls of ["Event", "Citation", "Media"]) assert.equal(RECORD_FIELDS[cls].find((f) => f.key === "date").hint, RECORD_COPY.dateBirthLike);
  for (const k of ["lat", "long"]) assert.equal(RECORD_FIELDS.Place.find((f) => f.key === k).hint, RECORD_COPY.placeCoords);
  assert.match(RECORD_COPY.placeCoords, /rounded to two decimals when you save/);
  assert.equal(RECORD_FIELDS.Place.find((f) => f.key === "code").hint, RECORD_COPY.placeCodeHint);
  assert.match(RECORD_COPY.placeCodeHint, /only for a country, state, county, province, region or department/);
  assert.doesNotMatch(RECORD_COPY.placeCodeHint, /town/);
  const resolver = createModeResolver(JSON.parse(JSON.stringify(POLICY)));
  const form = secOf("Place").form;
  const county = { ...OBJECTS.Place, place_type: typed("PlaceType", 3) };
  const [c, ptr, fixed] = recordPolicy(form, "code", { place_type: "3" }, county);
  assert.equal(fixed, undefined);
  const member = resolver.resolve(c, ptr, { admin: false, relation: "other" }, { lenient: true });
  assert.equal(member, "proposal", "the fixture table sends a member's code on an administrative place to review");
  const own = resolver.resolve("Event", "/description", { admin: false, relation: "own" }, { lenient: true });
  assert.equal(own, "direct", "own relation resolves through the same table");
  const stale = makeLookups({ ...bundleFor("Event"), tags: [] }, schemas);
  assert.deepEqual(stale.tags, []);
});

test("tags: assignment is from the tags that exist; add and remove are string-list ops; no tag list yet is created", () => {
  const r = run("Event", { ...valuesOf("Event"), tags: ["ht2"] });
  assert.deepEqual(r.ops.map((o) => [o.op, o.path, o.base ?? o.value]).sort(), [["add", "/tag_list", "ht2"], ["remove", "/tag_list/@=ht1", "ht1"]].sort());
  assert.ok(r.applied.ok, JSON.stringify(r.applied.conflicts));
  assert.deepEqual(r.applied.objects["Event:he1"].tag_list, ["ht2"]);
  const fresh = bundleFor("Source");
  delete fresh.obj.tag_list;
  const built = opsFromDrafts({ key: fresh.key, sections: [secOf("Source")], obj: fresh.obj, bundle: fresh, drafts: { details: { title: "A synthetic ledger", tags: ["ht1"] } }, viewer: viewer() });
  assert.deepEqual(built.ops.map((o) => [o.op, o.path, o.base, o.value]), [["set", "/tag_list", null, ["ht1"]]]);
  const lookups = makeLookups(bundleFor("Event"), schemas);
  assert.deepEqual(lookups.tags, TAGS);
});

test("the modes: a member's every field goes to review, an admin's saves now; tags too", () => {
  const resolver = createModeResolver(JSON.parse(JSON.stringify(POLICY)));
  for (const cls of CLASSES) {
    const form = secOf(cls).form;
    const obj = cls === "Place" ? { ...OBJECTS.Place, place_type: typed("PlaceType", 3) } : OBJECTS[cls]; // a county keeps its code
    for (const sp of form.fields) {
      const [c, ptr] = recordPolicy(form, sp.key, { type: "21", place_type: cls === "Place" ? "3" : undefined }, obj);
      const member = resolver.resolve(c, ptr, { admin: false, relation: "other" }, { lenient: true });
      const admin = resolver.resolve(c, ptr, { admin: true, relation: "other" }, { lenient: true });
      assert.equal(member, "proposal", `${cls}.${sp.key} for a member`);
      assert.equal(admin, "direct", `${cls}.${sp.key} for an admin`);
    }
  }
});

test("desk and never fields are absent or explained, for a member (own and other) and an admin: every desk or never row of the live table (AC2)", () => {
  const table = DEFAULT_FIELD_POLICY.document();
  assert.deepEqual(POLICY.rows, table.rows, "the fixture the editor tests serve is the live table");
  const refused = (code) => code === "desk" || code === "never";
  const viewers = [["member", { admin: false, relation: "other" }], ["own", { admin: false, relation: "own" }], ["admin", { admin: true, relation: "other" }]];
  // A desk or never row that reaches a rendered field: the field's record pointer, or the pointer its badge is judged at (a birth or another event).
  const hits = new Set();
  for (const cls of CLASSES) {
    const form = secOf(cls).form;
    for (const row of table.rows.filter((r) => r.cls === cls)) {
      const one = createModeResolver({ rows: [row] }); // answers the row's code only where the row's pattern matches
      for (const [who, v] of viewers) {
        for (const sp of form.fields) {
          const ptrs = new Set([sp.ptr, recordPolicy(form, sp.key, { type: "12" })[1], recordPolicy(form, sp.key, { type: "21" })[1]]);
          for (const p of ptrs) if (refused(one.resolve(cls, p, v))) hits.add(`${who} ${cls}.${sp.key} ${row.pointer}`);
        }
      }
    }
  }
  // Only three conditional never rows reach a field the form renders, for every viewer alike, and no desk row reaches one: every other desk or
  // never row (ids, private flags, LDS ordinances, the place title, alternate locations, addresses, withheld attributes and URL types) is absent.
  const explained = [["Event.date", "/date"], ["Place.code", "/code"], ["Place.place_type", "/place_type/**"]];
  assert.deepEqual([...hits].sort(), viewers.flatMap(([who]) => explained.map(([f, row]) => `${who} ${f} ${row}`)).sort());
  for (const [who, v] of viewers) {
    // The named desk and never fields: refused by the table for this viewer, and not a property of the form's schema, so nothing renders them.
    const absent = [
      ["Family", "/lds_ord_list/0", "desk"], ["Family", "/gramps_id", "desk"], ["Event", "/private", "desk"], ["Place", "/title", "desk"],
      ["Place", "/alt_loc/0", "never"], ["Repository", "/address_list/0", "never"],
      ["Source", "/attribute_list/0", "never", { _class: "Attribute", type: typed("AttributeType", 3) }], ["Repository", "/urls/0", "never", { _class: "Url", type: typed("UrlType", 1) }]
    ];
    for (const [cls, ptr, code, value] of absent) {
      const served = DEFAULT_FIELD_POLICY.resolve(cls, ptr, v, value ? { value } : null);
      assert.equal(served, code, `${who}: ${cls}${ptr} is ${code}`);
      const b = bundleFor(cls, { admin: v.admin, relation: v.relation });
      const sec = secOf(cls);
      const props = Object.keys(sectionSchema(schemas[cls], sec.form, makeLookups(b, schemas), sectionValues(b.obj, sec.form)).properties);
      const top = ptr.split("/")[1];
      assert.ok(!props.includes(top) && !sec.form.fields.some((sp) => sp.ptr.split("/")[1] === top), `${who}: ${cls}${ptr} has no field`);
    }
    // Explained 1: a birth's day and month (never) are cut from what is sent, and the field says so; the badge is the birth-year row's.
    const ev = secOf("Event").form;
    assert.equal(ev.fields.find((sp) => sp.key === "date").hint, RECORD_COPY.dateBirthLike);
    assert.equal(DEFAULT_FIELD_POLICY.resolve("Event", "/date/dateval/0", v, { value: 14, checks: [{ obj: { ...OBJECTS.Event, type: typed("EventType", 12) }, tree: [] }] }), "never", `${who}: a birth's day`);
    const birthOp = run("Event", { ...valuesOf("Event"), type: "12", date: date(15, 3, 1991) }, { admin: v.admin }).ops.find((o) => o.path === "/date");
    assert.deepEqual(birthOp.value.dateval.slice(0, 3), [0, 0, 1991], `${who}: a birth is sent as its year only`);
    // Explained 2: a place's code below the administrative level (never) is locked, badged "can't be changed on the site", and says why.
    const pl = secOf("Place").form;
    const city = OBJECTS.Place; // a city (PlaceType 4)
    const [, , fixed] = recordPolicy(pl, "code", sectionValues(city, pl), city);
    assert.equal(fixed, "never");
    assert.deepEqual(badgeFor(fixed), { key: "locked", text: COPY.modeLocked });
    assert.equal(COPY.modeLocked, "can't be changed on the site");
    assert.equal(pl.fields.find((sp) => sp.key === "code").hint, RECORD_COPY.placeCodeHint);
    assert.equal(run("Place", { ...sectionValues(city, pl), code: "AB1" }, { admin: v.admin }).ops.filter((o) => o.path === "/code").length, 0, `${who}: no code op`);
    // Explained 3: the never place types are not offered, and the field says so.
    const b = bundleFor("Place", { admin: v.admin, relation: v.relation });
    const offered = sectionSchema(schemas.Place, { record: true, cls: "Place", fields: pl.fields }, makeLookups(b, schemas), sectionValues(b.obj, pl)).properties.place_type;
    for (const t of NEVER_TYPE_VALUES.PlaceType) assert.ok(!offered.oneOf.some((o) => o.const === String(t)), `${who}: place type ${t} is offered`);
    assert.equal(offered.description, RECORD_COPY.placeStreet);
  }
});

test("a changed field counts once, as review for a member and as saves-now for an admin", () => {
  const resolver = createModeResolver(JSON.parse(JSON.stringify(POLICY)));
  const draft = { ...valuesOf("Source"), title: "A renamed ledger", tags: ["ht2"] };
  for (const [admin, want] of [[false, { total: 2, direct: 0, review: 2 }], [true, { total: 2, direct: 2, review: 0 }]]) {
    const r = run("Source", draft, { admin });
    assert.deepEqual(countOps(r.ops, resolver, "Source", viewer(admin), r.units), want);
    assert.equal(modeOfOp(r.ops[0], resolver, "Source", viewer(admin)), admin ? "direct" : "proposal");
  }
});

test("styled notes keep tags outside the edited span and drop overlapping ones (DEC-E11)", () => {
  // "Hello bold world and more": bold [6,10) ("bold"), italic [21,25) ("more")
  const outside = run("Note", { ...valuesOf("Note"), text: "Hello bold WORLD and more" });
  const kept = outside.applied.objects["Note:hn1"].text;
  assert.equal(kept.string, "Hello bold WORLD and more");
  assert.deepEqual(kept.tags.map((t) => t.ranges), [[[6, 10]], [[21, 25]]], "both styles are outside the edit");
  // an edit before the first style shifts both
  const shifted = run("Note", { ...valuesOf("Note"), text: "Well hello bold world and more" });
  assert.deepEqual(shifted.applied.objects["Note:hn1"].text.tags.map((t) => t.ranges), [[[11, 15]], [[26, 30]]]);
  // an edit inside the bold span drops that style and keeps the other
  const overlap = run("Note", { ...valuesOf("Note"), text: "Hello bXld world and more" });
  assert.deepEqual(overlap.applied.objects["Note:hn1"].text.tags.map((t) => t.ranges), [[[21, 25]]]);
  assert.deepEqual(restyleText(OBJECTS.Note.text, "Hello bXld world and more").tags.length, 1);
  // the member is warned before saving, and only when a style would go
  const form = secOf("Note").form;
  assert.deepEqual(recordNotes(form, OBJECTS.Note, { text: "Hello bold WORLD and more" }).map((n) => n.kind), ["info"]);
  assert.deepEqual(recordNotes(form, OBJECTS.Note, { text: "Hello bXld world and more" }).map((n) => n.kind), ["info", "warning"]);
  assert.equal(recordNotes(form, OBJECTS.Note, { text: "x" }).find((n) => n.kind === "warning").text, RECORD_COPY.noteStyledDropped);
  assert.deepEqual(recordNotes(secOf("Event").form, OBJECTS.Event, {}), []);
  assert.deepEqual(recordNotes(form, { ...OBJECTS.Note, text: { _class: "StyledText", string: "plain", tags: [] } }, { text: "other" }), []);
  // an unchanged text writes nothing, so a note's style is never rewritten by changing its kind
  const kind = run("Note", { ...valuesOf("Note"), type: "2" });
  assert.deepEqual(kind.ops.map((o) => o.path), ["/type"]);
});

test("the administrative place types and the coordinate rule are the policy file's", () => {
  assert.deepEqual([...PLACE_TYPES_ADMINISTRATIVE], REDACTION.places.administrativeTypes.map((t) => t.value));
  assert.equal(COORDINATE_POLICY.places.coordinateDecimals, REDACTION.places.coordinateDecimals);
  assert.equal(COORDINATE_POLICY.places.coordinatePattern, REDACTION.places.coordinatePattern);
});

test("coordinates: a longer number is rounded to two decimals before it is sent, and the result passes the guard (R-18)", async () => {
  const guard = createEditGuard({ policy: REDACTION });
  const r = run("Place", { ...valuesOf("Place"), lat: "51.5074", long: "-0.1278" });
  const byPath = Object.fromEntries(r.ops.map((o) => [o.path, o]));
  assert.equal(byPath["/lat"].value, "51.51");
  assert.equal(byPath["/long"].value, "-0.13");
  assert.ok(r.applied.ok, JSON.stringify(r.applied.conflicts));
  assert.deepEqual(guard.checkObjects(r.applied.objects), [], "the guard finds nothing on the rounded place");
  // what the hint promised is what the guard would have refused unrounded
  const raw = applyOps({ [r.b.key]: r.b.obj }, [{ id: "x", op: "set", obj: r.b.key, path: "/lat", base: "", value: "51.5074" }], { versions: { [r.b.key]: 7 } });
  assert.deepEqual(guard.checkObjects(raw.objects).map((e) => [e.code, e.kind, e.path]), [["never_in_cloud", "coordinate", "/lat"]]);
  // half away from zero, a short value as typed, nothing to send when the rounded value is the stored one, a non-decimal left for the server
  assert.deepEqual(["47.6", "+47.6", "-122.4194", "0.004", "-0.004", "179.995", "", "north"].map(roundedCoordinate), ["47.6", "+47.6", "-122.42", "0.00", "0.00", "180.00", "", "north"]);
  const stored = { ...OBJECTS.Place, lat: "51.51" };
  assert.deepEqual(run("Place", { ...valuesOf("Place"), lat: "51.5074" }, { obj: stored }).ops, []);
  // the form takes the longer number (no pattern error under the field), and the hint is shown
  const schema = recordSchema(EDIT_SCHEMAS.Place, secOf("Place").form, makeLookups(bundleFor("Place"), schemas), valuesOf("Place"));
  for (const k of ["lat", "long"]) {
    const prop = schema.properties[k];
    assert.equal(prop.description, RECORD_COPY.placeCoords);
    assert.ok(new RegExp(prop.pattern).test("-122.4194") && new RegExp(prop.pattern).test("") && !new RegExp(prop.pattern).test("north"), k);
    assert.ok(prop.maxLength >= "-122.4194".length, k);
  }
});

test("the place code: locked on a town or a city (never in the cloud), open on an administrative place, judged before and after a type change", async () => {
  const form = secOf("Place").form;
  const resolver = createModeResolver(JSON.parse(JSON.stringify(POLICY)));
  const guard = createEditGuard({ policy: REDACTION });
  const view = { get: async () => null, byGrampsId: async () => null, referrers: async () => [] };
  const place = (t) => ({ ...OBJECTS.Place, place_type: typed("PlaceType", t) });
  // [stored type, type in the form, the form's answer]
  const cases = [[15, "15", false], [4, "4", false], [3, "3", true], [1, "1", true], [10, "10", true], [15, "3", false], [3, "15", false], [3, "c:Shire", false], [3, "", true], [3, undefined, true]];
  for (const [stored, now, open] of cases) {
    const obj = place(stored);
    const live = { ...sectionValues(obj, form), place_type: now, code: "AB1" };
    assert.equal(placeCodeOpen(obj, live), open, `${stored} -> ${now}`);
    const [c, ptr, fixed] = recordPolicy(form, "code", live, obj);
    const badge = (admin) => fixed || resolver.resolve(c, ptr, { admin, relation: "other" }, { lenient: true });
    assert.equal(badge(false), open ? "proposal" : "never", `member badge ${stored} -> ${now}`);
    assert.equal(badge(true), open ? "direct" : "never", `admin badge ${stored} -> ${now}`);
    const r = run("Place", live, { obj });
    const codeOps = r.ops.filter((o) => o.path === "/code");
    assert.equal(codeOps.length, open ? 1 : 0, `a code op only when open: ${stored} -> ${now}`);
    // the server agrees: the field policy and the guard
    const served = await classifyOps([{ id: "c", op: "set", obj: r.b.key, path: "/code", base: "", value: "AB1" }, ...(now && String(now) !== String(stored) ? [{ id: "t", op: "set", obj: r.b.key, path: "/place_type", base: obj.place_type, value: now.startsWith("c:") ? typed("PlaceType", 0, now.slice(2)) : typed("PlaceType", Number(now)) }] : [])], { actor: { id: "I9001", admin: false }, view, objects: { [r.b.key]: obj } });
    assert.equal(served.find((x) => x.id === "c").code, open ? "proposal" : "never", `field policy ${stored} -> ${now}`);
    if (open) assert.deepEqual(guard.checkObjects(r.applied.objects), [], `guard ${stored} -> ${now}`);
  }
  // the reviewer's case: a code on a town or a city would be refused by the guard, so the form never sends it
  for (const t of [15, 4]) {
    const raw = applyOps({ "Place:hl1": place(t) }, [{ id: "x", op: "set", obj: "Place:hl1", path: "/code", base: "", value: "AB1" }], { versions: { "Place:hl1": 7 } });
    assert.deepEqual(guard.checkObjects(raw.objects).map((e) => [e.code, e.kind]), [["never_in_cloud", "place_code"]]);
  }
});

test("a replay after a save does not lay the saved field over the fresh record again; what was typed since survives (record forms)", () => {
  // The member saves a new title (it goes to review), and types an author while the save is out. The refetch replays the drafts.
  const sec = secOf("Source");
  const b = bundleFor("Source");
  const drafts = { details: { ...valuesOf("Source"), title: "New ledger", author: "A. Synth" } };
  const saved = opsFromDrafts({ key: b.key, sections: [sec], obj: b.obj, bundle: b, drafts: { details: { ...valuesOf("Source"), title: "New ledger" } }, viewer: viewer() });
  assert.deepEqual(saved.ops.map((o) => o.path), ["/title"]);
  const settled = Object.fromEntries(saved.ops.map((o) => [o.id, o.value]));
  const built = opsFromDrafts({ key: b.key, sections: [sec], obj: b.obj, bundle: b, drafts, viewer: viewer() });
  const settledUnits = settledUnitsOf(built, settled);
  assert.deepEqual([...settledUnits], ["details/title"]);
  const fresh = { ...b, version: 8 }; // a proposal: the record itself is unchanged
  const out = replayDrafts({ sections: [sec], oldBundle: b, freshBundle: fresh, drafts, settled, settledUnits });
  assert.equal(out.details.title, OBJECTS.Source.title, "the suggested title is not laid over the record again");
  assert.equal(out.details.author, "A. Synth");
  const next = opsFromDrafts({ key: b.key, sections: [sec], obj: fresh.obj, bundle: fresh, drafts: out, viewer: viewer() });
  assert.deepEqual(next.ops.map((o) => [o.path, o.value]), [["/author", "A. Synth"]], "the next save sends only the author");
  // a saved field typed over again since is kept; a direct save is not reverted to the old value
  const again = { details: { ...drafts.details, title: "Newer ledger" } };
  const units2 = settledUnitsOf(opsFromDrafts({ key: b.key, sections: [sec], obj: b.obj, bundle: b, drafts: again, viewer: viewer() }), settled);
  assert.equal(replayDrafts({ sections: [sec], oldBundle: b, freshBundle: fresh, drafts: again, settled, settledUnits: units2 }).details.title, "Newer ledger");
  const stored = { ...b, version: 8, obj: { ...b.obj, title: "New ledger" } };
  assert.equal(replayDrafts({ sections: [sec], oldBundle: b, freshBundle: stored, drafts, settled, settledUnits }).details.title, "New ledger");
  // tags and a date are several ops per field: the unit settles only when all of them were stored
  const ev = bundleFor("Event");
  const evSec = secOf("Event");
  const evDrafts = { details: { ...valuesOf("Event"), tags: ["ht2"], description: "Out back" } };
  const evSaved = opsFromDrafts({ key: ev.key, sections: [evSec], obj: ev.obj, bundle: ev, drafts: { details: { ...valuesOf("Event"), tags: ["ht2"] } }, viewer: viewer() });
  const evSettled = Object.fromEntries(evSaved.ops.map((o) => [o.id, o.value]));
  const evUnits = settledUnitsOf(opsFromDrafts({ key: ev.key, sections: [evSec], obj: ev.obj, bundle: ev, drafts: evDrafts, viewer: viewer() }), evSettled);
  const evOut = replayDrafts({ sections: [evSec], oldBundle: ev, freshBundle: { ...ev, version: 8 }, drafts: evDrafts, settled: evSettled, settledUnits: evUnits });
  assert.deepEqual(evOut.details.tags, ["ht1"]);
  assert.equal(evOut.details.description, "Out back");
});

test("a stale-record replay lays only the member's changed fields over the fresh record", () => {
  const sec = secOf("Citation");
  const old = bundleFor("Citation").obj;
  const fresh = { ...old, page: "p. 4" };
  const draft = { ...valuesOf("Citation"), confidence: "4" };
  const seed = recordSeed({ section: sec, oldObj: old, freshObj: fresh, draft });
  assert.equal(seed.page, "p. 4", "somebody else's change is not reverted");
  assert.equal(seed.confidence, "4");
  assert.deepEqual(recordSeed({ section: sec, oldObj: old, freshObj: fresh, draft: undefined }), sectionValues(fresh, sec.form));
});

test("drill-down: event to place, citation to source to repository, place inside place, family to its people", () => {
  const link = (cls, bundleCls = cls) => drillLinks(cls, bundleFor(bundleCls), makeLookups(bundleFor(bundleCls), schemas));
  const ev = link("Event");
  assert.deepEqual(ev.map((g) => g.id), ["place", "citations", "notes"]);
  assert.equal(ev[0].items[0].href, "/edit/?cls=place&id=P9001");
  assert.equal(ev[0].items[0].title, "Synthville");
  const cit = link("Citation");
  assert.equal(cit[0].items[0].href, "/edit/?cls=source&id=S9001");
  const src = link("Source");
  assert.deepEqual(src[0].id, "repositories");
  assert.equal(src[0].items[0].href, "/edit/?cls=repository&id=R9001");
  assert.equal(src[0].items[0].detail, "Box 4");
  assert.equal(link("Place")[0].items[0].href, "/edit/?cls=place&id=P9002");
  const fam = link("Family");
  assert.deepEqual(fam.map((g) => g.id), ["people", "children", "events", "notes"]);
  assert.equal(fam[0].items[0].href, "/edit/?cls=person&id=h%3Ahp1");
  assert.equal(fam[0].items[0].title, "Sam Example");
  assert.match(fam[2].items[0].title, /^.+/);
  // a related object the viewer cannot see has no link
  const hidden = bundleFor("Event");
  hidden.related = {};
  assert.deepEqual(drillLinks("Event", hidden), []);
  // an h:handle link when the related record has no gramps id
  const noId = bundleFor("Citation");
  noId.related = { "Source:hs1": { version: 1, obj: { _class: "Source", handle: "hs1", title: "x" } } };
  assert.equal(drillLinks("Citation", noId)[0].items[0].href, "/edit/?cls=source&id=h%3Ahs1");
  assert.equal(recordTitle("Repository", OBJECTS.Repository), "Synthetic Archive");
});

const POLICY = JSON.parse(readFileSync(new URL("./fixtures/edit-policy-all.json", import.meta.url), "utf8"));
