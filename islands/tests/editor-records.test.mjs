// HFY-TSK-157: the editors of the other record classes (src/lib/editor-records.js). The form of each of the eight classes, the EditOps a change makes
// (every case runs them through the ops engine, api/src/records/ops.js), the styled-note rule (DEC-E11), the place-type and address rules (DEC-E12,
// R-18) and the drill-down links. Synthetic records only.
import test from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { applyOps } from "../../api/src/records/ops.js";
import { EDIT_SCHEMAS } from "../src/lib/edit-schemas.js";
import { PERSON_SECTIONS, createModeResolver, parseRoute, sectionSchema, sectionValues, sectionsFor } from "../src/lib/editor-model.js";
import { RECORD_COPY, RECORD_FIELDS, PLACE_TYPES_SKIPPED, drillLinks, recordNotes, recordOps, recordPolicy, recordSeed, recordTitle } from "../src/lib/editor-records.js";
import { makeLookups, restyleText } from "../src/lib/editor-sections.js";
import { countOps, modeOfOp, opsFromDrafts } from "../src/lib/editor-save.js";

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
    for (const sp of form.fields) {
      const [c, ptr] = recordPolicy(form, sp.key, { type: "21" });
      const member = resolver.resolve(c, ptr, { admin: false, relation: "other" }, { lenient: true });
      const admin = resolver.resolve(c, ptr, { admin: true, relation: "other" }, { lenient: true });
      assert.equal(member, "proposal", `${cls}.${sp.key} for a member`);
      assert.equal(admin, "direct", `${cls}.${sp.key} for an admin`);
    }
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
