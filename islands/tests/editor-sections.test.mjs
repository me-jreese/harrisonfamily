// HFY-TSK-156: the person editor's section adapters (src/lib/editor-sections.js). Add, edit and remove in each section produce the EditOps the
// ops engine (api/src/records/ops.js) addresses by key segment, and the ops really apply: every case runs them through applyOps and checks
// the resulting objects. Synthetic records only.
import test from "node:test";
import assert from "node:assert/strict";
import { applyOps, keySegment, hash12 } from "../../api/src/records/ops.js";
import {
  BIRTH, LIST_ADAPTERS, SECTION_COPY, birthDate, dateFromParts, dateParts, dateText, emptyDate, emptyListDraft, givenParts, isEmptyDate, listDraftIsEmpty,
  makeLookups, nameValues, namesOps, pendingChip, photoOrder, replayListDraft, restyleText, sectionOps, typeCode, typeObject, typeOptions
} from "../src/lib/editor-sections.js";
import { PERSON_SECTIONS } from "../src/lib/editor-model.js";
import { EDIT_SCHEMAS } from "../src/lib/edit-schemas.js";

const KEY = "Person:hp1";
const typed = (cls, value, string = "") => ({ _class: cls, value, string });
const date = (d, m, y, extra = {}) => ({ _class: "Date", calendar: 0, modifier: 0, quality: 0, dateval: [d, m, y, false], text: "", sortval: 2400000, newyear: 0, ...extra });
const ev = (type, dt, extra = {}) => ({ _class: "Event", handle: "x", type: typed("EventType", type), date: dt, ...extra });
const ref = (r) => ({ _class: "EventRef", ref: r, role: typed("EventRoleType", 1) });

/** A synthetic record with something in every section, and the objects the bundle carries beside it. */
function fixture({ extra = {} } = {}) {
  const person = {
    _class: "Person", handle: "hp1", gramps_id: "I9001",
    primary_name: { _class: "Name", first_name: "Test Quinn", call: "Test", nick: "Tess", surname_list: [{ _class: "Surname", surname: "Person", primary: true }] },
    alternate_names: [{ _class: "Name", first_name: "Tessa", surname_list: [{ _class: "Surname", surname: "Other", primary: true }], type: typed("NameType", 3) }],
    event_ref_list: [ref("he1"), ref("he2")],
    attribute_list: [{ _class: "Attribute", type: typed("AttributeType", 15), value: "Synthetic Worker" }, { _class: "Attribute", type: typed("AttributeType", 0, "Merged Gramps ID"), value: "I0000" }],
    note_list: ["hn1"], media_list: [{ _class: "MediaRef", ref: "hm1" }, { _class: "MediaRef", ref: "hm2", rect: [1, 2, 3, 4] }, { _class: "MediaRef", ref: "hm1" }],
    person_ref_list: [{ _class: "PersonRef", ref: "hp2", rel: "Godparent" }], citation_list: ["hc1"], ...extra
  };
  const related = {
    "Event:he1": { version: 3, obj: ev(BIRTH, date(0, 0, 1950, { modifier: 3 }), { handle: "he1", place: "hl1", description: "At home" }) },
    "Event:he2": { version: 5, obj: ev(19, date(0, 0, 2001), { handle: "he2" }) },
    "Place:hl1": { version: 1, obj: { _class: "Place", handle: "hl1", name: { _class: "PlaceName", value: "Synthville" } } },
    "Place:hl2": { version: 1, obj: { _class: "Place", handle: "hl2", name: { _class: "PlaceName", value: "Exampleton" } } },
    "Note:hn1": { version: 2, obj: { _class: "Note", handle: "hn1", text: { _class: "StyledText", string: "Hello bold world and more", tags: [{ _class: "StyledTextTag", name: typed("StyledTextTagType", 0), value: null, ranges: [[6, 10]] }, { _class: "StyledTextTag", name: typed("StyledTextTagType", 1), value: null, ranges: [[21, 25]] }] }, type: typed("NoteType", 1) } },
    "Media:hm1": { version: 1, obj: { _class: "Media", handle: "hm1", desc: "Front porch" } },
    "Media:hm2": { version: 1, obj: { _class: "Media", handle: "hm2", desc: "Back garden" } },
    "Person:hp2": { version: 1, stub: { displayName: "Sam Example", gender: 1, isLiving: false, lifespan: "1940–2010" } },
    "Citation:hc1": { version: 4, obj: { _class: "Citation", handle: "hc1", source_handle: "hs1", page: "p. 3", confidence: 2 } },
    "Source:hs1": { version: 1, obj: { _class: "Source", handle: "hs1", title: "A synthetic ledger" } }
  };
  const bundle = { key: KEY, version: 7, obj: person, related, customTypes: { AttributeType: ["Synthetic Worker kind"] } };
  const objects = { [KEY]: person };
  const versions = { [KEY]: 7 };
  for (const [k, v] of Object.entries(related)) if (v.obj) { objects[k] = v.obj; versions[k] = v.version; }
  return { bundle, objects, versions, lookups: makeLookups(bundle, EDIT_SCHEMAS) };
}

const SECTIONS = PERSON_SECTIONS;
const run = (fx, drafts, viewer = { admin: false, relation: "own" }) => {
  const r = sectionOps({ key: KEY, bundle: fx.bundle, sections: SECTIONS, drafts, viewer });
  let n = 0;
  const applied = applyOps(fx.objects, r.ops, { versions: fx.versions, mint: () => `m${++n}` });
  return { ...r, applied };
};
const ids = (ops) => ops.map((o) => o.id);

test("the registry lists the lists each section holds", () => {
  const byId = Object.fromEntries(SECTIONS.map((s) => [s.id, s]));
  assert.deepEqual(byId.names.lists, ["alt"]);
  for (const id of ["events", "facts", "notes", "photos", "connected", "sources"]) assert.deepEqual(byId[id].lists, [id]);
  for (const id of ["links", "family", "more"]) assert.equal(byId[id].lists, undefined);
});

test("names: given names, last name, nickname are set ops with the base the bundle served; the last name goes through the surname's key", () => {
  const fx = fixture();
  const r = run(fx, { names: { first_name: "Test Quinn Rae", surname: "Persona", call: "Test", nick: "", title: "Dr", suffix: "" } });
  assert.deepEqual(r.ops.map((o) => [o.id, o.path, o.base, o.value]), [
    ["names.first_name", "/primary_name/first_name", "Test Quinn", "Test Quinn Rae"],
    ["names.nick", "/primary_name/nick", "Tess", ""],
    ["names.title", "/primary_name/title", null, "Dr"],
    ["names.surname", `/primary_name/surname_list/${keySegment("surname_list", fx.bundle.obj.primary_name.surname_list, 0)}/surname`, "Person", "Persona"]
  ]);
  assert.match(r.ops[3].path, /^\/primary_name\/surname_list\/@k=[0-9a-f]{12}\/surname$/);
  assert.ok(r.applied.ok, JSON.stringify(r.applied.conflicts));
  const n = r.applied.objects[KEY].primary_name;
  assert.equal(n.first_name, "Test Quinn Rae");
  assert.equal(n.surname_list[0].surname, "Persona");
  assert.equal(n.title, "Dr");
  assert.equal(n.nick, "");
});

test("names: a name with no surname gets one by an add (or a set when the list is missing); nothing changed makes no op", () => {
  const fx = fixture();
  const none = { ...fx.bundle.obj, primary_name: { _class: "Name", first_name: "Test", surname_list: [] } };
  const a = namesOps({ key: KEY, obj: none, draft: { first_name: "Test", surname: "Person" }, section: "names" });
  assert.deepEqual(a.ops.map((o) => [o.op, o.path, o.value]), [["add", "/primary_name/surname_list", { _class: "Surname", surname: "Person", primary: true }]]);
  const b = namesOps({ key: KEY, obj: { ...none, primary_name: { _class: "Name", first_name: "Test" } }, draft: { first_name: "Test", surname: "Person" }, section: "names" });
  assert.deepEqual(b.ops.map((o) => [o.op, o.path, o.base]), [["set", "/primary_name/surname_list", null]]);
  const same = namesOps({ key: KEY, obj: fx.bundle.obj, draft: nameValues(fx.bundle.obj), section: "names" });
  assert.deepEqual(same.ops, []);
});

test("names: a call name that is no longer one of the given names is cleared with them", () => {
  const fx = fixture();
  const r = namesOps({ key: KEY, obj: fx.bundle.obj, draft: { first_name: "Quinn", surname: "Person", call: "Test", nick: "Tess" }, section: "names" });
  assert.deepEqual(r.ops.map((o) => [o.path, o.value]), [["/primary_name/first_name", "Quinn"], ["/primary_name/call", ""]]);
});

test("given names are one string: first and middle are only read from it", () => {
  assert.deepEqual(givenParts("Test Quinn Rae"), { first: "Test", middle: "Quinn Rae" });
  assert.deepEqual(givenParts("Test"), { first: "Test", middle: "" });
  assert.deepEqual(givenParts(""), { first: "", middle: "" });
});

test("alternate names: add, edit and remove by @k key", () => {
  const fx = fixture();
  const row = LIST_ADAPTERS.alt.rows(fx.bundle, fx.lookups)[0];
  assert.equal(row.id, hash12(fx.bundle.obj.alternate_names[0]));
  assert.equal(row.title, "Tessa Other");
  assert.equal(row.detail, "married name");
  const key = `@k=${row.id}`;
  const edit = run(fx, { "names:alt": { edits: { [row.id]: { first_name: "Tessie", surname: "Other", type: "2" } }, removed: [], added: [], order: null } });
  assert.deepEqual(edit.ops.map((o) => [o.op, o.path, o.base, o.value]), [
    ["set", `/alternate_names/${key}/first_name`, "Tessa", "Tessie"],
    ["set", `/alternate_names/${key}/type`, typed("NameType", 3), typed("NameType", 2)]
  ]);
  assert.ok(edit.applied.ok, JSON.stringify(edit.applied.conflicts));
  assert.equal(edit.applied.objects[KEY].alternate_names[0].first_name, "Tessie");
  const add = run(fx, { "names:alt": { edits: {}, removed: [], added: [{ tid: "n1", values: { first_name: "Tee", surname: "Person", type: "1" } }], order: null } });
  assert.deepEqual(add.ops.map((o) => [o.op, o.path]), [["add", "/alternate_names"]]);
  assert.deepEqual(add.ops[0].value, { _class: "Name", first_name: "Tee", surname_list: [{ _class: "Surname", surname: "Person", primary: true }], type: typed("NameType", 1) });
  assert.equal(add.applied.objects[KEY].alternate_names.length, 2);
  const rm = run(fx, { "names:alt": { edits: {}, removed: [row.id], added: [], order: null } });
  assert.deepEqual(rm.ops.map((o) => [o.op, o.path, o.base]), [["remove", `/alternate_names/${key}`, fx.bundle.obj.alternate_names[0]]]);
  assert.equal(rm.applied.objects[KEY].alternate_names.length, 0);
});

test("events: the rows show the kind, a year-only birth and the place", () => {
  const fx = fixture();
  const rows = LIST_ADAPTERS.events.rows(fx.bundle, fx.lookups);
  assert.deepEqual(rows.map((r) => [r.id, r.title, r.detail]), [["he1", "birth", "about 1950, Synthville"], ["he2", "burial", "2001"]]);
  assert.equal(rows[0].birth, true);
});

test("events: a member's date edit is based on the event's version and lists only the parts changed; an admin's is based on the value", () => {
  const fx = fixture();
  const member = run(fx, { events: { edits: { he2: { type: "19", date: dateFromParts({ modifier: 0, year: 2001, month: 6, day: 0 }, fx.bundle.related["Event:he2"].obj.date), place: { ref: "", name: "" }, description: "" } }, removed: [], added: [], order: null } });
  assert.deepEqual(member.ops.map((o) => ({ op: o.op, obj: o.obj, path: o.path, base_version: o.base_version, sets: o.sets })), [{ op: "set", obj: "Event:he2", path: "/date", base_version: 5, sets: ["month"] }]);
  assert.ok(member.applied.ok, JSON.stringify(member.applied.conflicts));
  assert.deepEqual(member.applied.objects["Event:he2"].date.dateval, [0, 6, 2001, false]);
  const admin = run(fx, { events: { edits: { he2: { type: "19", date: dateFromParts({ modifier: 0, year: 2002 }, fx.bundle.related["Event:he2"].obj.date), place: { ref: "", name: "" }, description: "" } }, removed: [], added: [], order: null } }, { admin: true, relation: "other" });
  assert.deepEqual(admin.ops.map((o) => [o.path, o.base, o.base_version]), [["/date", fx.bundle.related["Event:he2"].obj.date, undefined]]);
  assert.ok(admin.applied.ok, JSON.stringify(admin.applied.conflicts));
});

test("events: a birth keeps the year and the modifier; day and month are zeroed whatever the form held", () => {
  const fx = fixture();
  const base = fx.bundle.related["Event:he1"].obj.date;
  const wild = dateFromParts({ modifier: 3, year: 1951, month: 4, day: 9 }, base);
  assert.deepEqual(wild.dateval, [9, 4, 1951, false]);
  const r = run(fx, { events: { edits: { he1: { type: "12", date: wild, place: { ref: "hl1", name: "" }, description: "At home" } }, removed: [], added: [], order: null } });
  assert.deepEqual(r.ops.map((o) => o.path), ["/date"]);
  assert.deepEqual(r.ops[0].value.dateval, [0, 0, 1951, false]);
  assert.equal(r.ops[0].value.modifier, 3);
  assert.deepEqual(birthDate(wild).dateval, [0, 0, 1951, false]);
  // a new birth event too
  const add = run(fx, { events: { edits: {}, removed: [], added: [{ tid: "n1", values: { type: "12", date: dateFromParts({ modifier: 0, year: 1980, month: 5, day: 5 }), place: { ref: "", name: "" }, description: "" } }], order: null } });
  const created = add.ops.find((o) => o.op === "create");
  assert.deepEqual(created.value.date.dateval, [0, 0, 1980, false]);
});

test("events: type, place and description edits set the property on the event, with a null base for a property it lacks", () => {
  const fx = fixture();
  const r = run(fx, { events: { edits: { he2: { type: "21", date: fx.bundle.related["Event:he2"].obj.date, place: { ref: "hl2", name: "" }, description: "Synthetic census" } }, removed: [], added: [], order: null } });
  assert.deepEqual(r.ops.map((o) => [o.obj, o.path, o.base, o.value]), [
    ["Event:he2", "/type", typed("EventType", 19), typed("EventType", 21)],
    ["Event:he2", "/place", null, "hl2"],
    ["Event:he2", "/description", null, "Synthetic census"]
  ]);
  assert.ok(r.applied.ok, JSON.stringify(r.applied.conflicts));
  assert.equal(r.applied.objects["Event:he2"].place, "hl2");
  const clear = run(fx, { events: { edits: { he1: { type: "12", date: fx.bundle.related["Event:he1"].obj.date, place: { ref: "", name: "" }, description: "" } }, removed: [], added: [], order: null } });
  assert.deepEqual(clear.ops.map((o) => [o.path, o.base, o.value]), [["/place", "hl1", ""], ["/description", "At home", ""]]);
});

test("events: a new event with a place that is not listed creates the place, the event and the reference, in one change", () => {
  const fx = fixture();
  const r = run(fx, { events: { edits: {}, removed: [], added: [{ tid: "n1", values: { type: "21", date: dateFromParts({ modifier: 0, year: 1990, month: 3, day: 4 }), place: { ref: "", name: "Newtown" }, description: "Moved" } }], order: null } });
  assert.deepEqual(r.ops.map((o) => [o.op, o.obj, o.cls, o.path]), [
    ["create", "new:1", "Place", undefined], ["create", "new:2", "Event", undefined], ["add", KEY, undefined, "/event_ref_list"]
  ]);
  assert.equal(r.ops[0].value.name.value, "Newtown");
  assert.equal(r.ops[1].value.place, "new:1");
  assert.deepEqual(r.ops[2].value, { _class: "EventRef", ref: "new:2", role: typed("EventRoleType", 1) });
  assert.deepEqual(new Set(Object.values(r.units)), new Set(["events/a:n1"]));
  assert.ok(r.applied.ok, JSON.stringify(r.applied.conflicts));
  assert.equal(r.applied.objects[KEY].event_ref_list.length, 3);
  assert.equal(r.applied.objects[KEY].event_ref_list[2].ref, "m2");
  assert.equal(r.applied.objects["Event:m2"].place, "m1");
  // no kind chosen yet: nothing is sent
  assert.deepEqual(run(fx, { events: { edits: {}, removed: [], added: [{ tid: "n1", values: { type: "", date: emptyDate(), place: { ref: "", name: "" }, description: "" } }], order: null } }).ops, []);
});

test("events: remove the reference by its key with the element as base", () => {
  const fx = fixture();
  const r = run(fx, { events: { edits: {}, removed: ["he2"], added: [], order: null } });
  assert.deepEqual(r.ops.map((o) => [o.op, o.path, o.base]), [["remove", `/event_ref_list/@ref=he2`, ref("he2")]]);
  assert.ok(r.applied.ok, JSON.stringify(r.applied.conflicts));
  assert.deepEqual(r.applied.objects[KEY].event_ref_list.map((x) => x.ref), ["he1"]);
});

test("facts: add, edit and remove by @k key; the merged-id attribute is never shown", () => {
  const fx = fixture();
  const rows = LIST_ADAPTERS.facts.rows(fx.bundle, fx.lookups);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].title, rows[0].detail], ["occupation", "Synthetic Worker"]);
  const id = rows[0].id;
  const key = `@k=${id}`;
  const edit = run(fx, { facts: { edits: { [id]: { type: "7", value: "Synthetic Teacher" } }, removed: [], added: [], order: null } });
  assert.deepEqual(edit.ops.map((o) => [o.path, o.base, o.value]), [
    [`/attribute_list/${key}/value`, "Synthetic Worker", "Synthetic Teacher"],
    [`/attribute_list/${key}/type`, typed("AttributeType", 15), typed("AttributeType", 7)]
  ]);
  assert.ok(edit.applied.ok, JSON.stringify(edit.applied.conflicts));
  const add = run(fx, { facts: { edits: {}, removed: [], added: [{ tid: "n1", values: { type: "c:Synthetic Worker kind", value: "x" } }], order: null } });
  assert.deepEqual(add.ops[0].value, { _class: "Attribute", type: typed("AttributeType", 0, "Synthetic Worker kind"), value: "x" });
  assert.equal(add.applied.objects[KEY].attribute_list.length, 3);
  const rm = run(fx, { facts: { edits: {}, removed: [id], added: [], order: null } });
  assert.deepEqual(rm.ops.map((o) => [o.op, o.path]), [["remove", `/attribute_list/${key}`]]);
  assert.equal(rm.applied.objects[KEY].attribute_list.length, 1);
});

test("facts: the types a member may pick leave out the id numbers and the custom wording that is not already in the tree", () => {
  const fx = fixture();
  const opts = fx.lookups.attributeTypes("7").map((o) => o.value);
  assert.ok(opts.includes("15") && opts.includes("c:Synthetic Worker kind"));
  assert.ok(!opts.includes("3") && !opts.includes("6") && !opts.includes("0") && !opts.includes("-1"));
  assert.deepEqual(typeOptions(null, "AttributeType", { current: "9" }).map((o) => o.value), ["9"]);
});

test("notes: edit keeps the styled tags outside the edited span; add creates a note and links it; remove unlinks it", () => {
  const fx = fixture();
  const rows = LIST_ADAPTERS.notes.rows(fx.bundle, fx.lookups);
  assert.deepEqual(rows.map((r) => [r.id, r.title]), [["hn1", "Hello bold world and more"]]);
  const edit = run(fx, { notes: { edits: { hn1: { text: "Hello bold earth and more" } }, removed: [], added: [], order: null } });
  assert.equal(edit.ops.length, 1);
  assert.deepEqual([edit.ops[0].obj, edit.ops[0].path], ["Note:hn1", "/text"]);
  assert.equal(edit.ops[0].value.string, "Hello bold earth and more");
  assert.deepEqual(edit.ops[0].value.tags.map((t) => t.ranges), [[[6, 10]], [[21, 25]]]);
  assert.ok(edit.applied.ok, JSON.stringify(edit.applied.conflicts));
  // an edit inside a tagged span drops that tag; text cut before the later one shifts it
  const inside = restyleText(fx.bundle.related["Note:hn1"].obj.text, "Hello bXld world and more");
  assert.deepEqual(inside.tags.map((t) => t.ranges), [[[21, 25]]]);
  const cut = restyleText(fx.bundle.related["Note:hn1"].obj.text, "Hello world and more");
  assert.deepEqual(cut.tags.map((t) => t.ranges), [[[16, 20]]]);
  const longer = restyleText(fx.bundle.related["Note:hn1"].obj.text, "Hello bold world, and then some more");
  assert.deepEqual(longer.tags.map((t) => t.ranges), [[[6, 10]], [[32, 36]]]);
  const add = run(fx, { notes: { edits: {}, removed: [], added: [{ tid: "n1", values: { text: "A new note." } }], order: null } });
  assert.deepEqual(add.ops.map((o) => [o.op, o.obj, o.path, o.value && o.value.text ? o.value.text.string : o.value]), [["create", "new:1", undefined, "A new note."], ["add", KEY, "/note_list", "new:1"]]);
  assert.ok(add.applied.ok, JSON.stringify(add.applied.conflicts));
  assert.deepEqual(add.applied.objects[KEY].note_list, ["hn1", "m1"]);
  const rm = run(fx, { notes: { edits: {}, removed: ["hn1"], added: [], order: null } });
  assert.deepEqual(rm.ops.map((o) => [o.op, o.path, o.base]), [["remove", "/note_list/@=hn1", "hn1"]]);
  assert.deepEqual(rm.applied.objects[KEY].note_list, []);
});

test("photos: the order is a list of moves by media key (ref#n and a hash), the first photo is the main one", () => {
  const fx = fixture();
  const rows = LIST_ADAPTERS.photos.rows(fx.bundle, fx.lookups);
  assert.deepEqual(rows.map((r) => [r.id, r.title]), [["hm1", "Front porch"], ["hm2", "Back garden"], ["hm1_1", "Front porch"]]);
  const l = fx.bundle.obj.media_list;
  const seg = (i) => keySegment("media_list", l, i);
  assert.match(seg(0), /^@ref=hm1#0:[0-9a-f]{12}$/);
  // make the second photo the main one
  const r = run(fx, { photos: { edits: {}, removed: [], added: [], order: ["hm2", "hm1", "hm1_1"] } });
  assert.deepEqual(r.ops.map((o) => [o.op, o.path, o.before]), [["move", `/media_list/${seg(1)}`, seg(0)]]);
  assert.ok(r.applied.ok, JSON.stringify(r.applied.conflicts));
  assert.deepEqual(r.applied.objects[KEY].media_list.map((m) => m.ref), ["hm2", "hm1", "hm1"]);
  // move the first to the end, and reverse the lot
  const end = run(fx, { photos: { edits: {}, removed: [], added: [], order: ["hm2", "hm1_1", "hm1"] } });
  assert.ok(end.applied.ok, JSON.stringify(end.applied.conflicts));
  assert.deepEqual(end.applied.objects[KEY].media_list.map((m) => m.ref), ["hm2", "hm1", "hm1"]);
  assert.deepEqual(end.applied.objects[KEY].media_list[1], l[2]);
  const rev = run(fx, { photos: { edits: {}, removed: [], added: [], order: ["hm1_1", "hm2", "hm1"] } });
  assert.ok(rev.applied.ok, JSON.stringify(rev.applied.conflicts));
  assert.deepEqual(rev.applied.objects[KEY].media_list, [l[2], l[1], l[0]]);
  // no change in order, no op
  assert.deepEqual(run(fx, { photos: { edits: {}, removed: [], added: [], order: ["hm1", "hm2", "hm1_1"] } }).ops, []);
  assert.deepEqual(photoOrder(rows, { order: ["hm2", "gone"] }), ["hm2", "hm1", "hm1_1"]);
});

test("photos: remove drops the reference by its key and its content", () => {
  const fx = fixture();
  const l = fx.bundle.obj.media_list;
  const r = run(fx, { photos: { edits: {}, removed: ["hm2"], added: [], order: null } });
  assert.deepEqual(r.ops.map((o) => [o.op, o.path, o.base]), [["remove", `/media_list/${keySegment("media_list", l, 1)}`, l[1]]]);
  assert.ok(r.applied.ok, JSON.stringify(r.applied.conflicts));
  assert.equal(r.applied.objects[KEY].media_list.length, 2);
  // removing the main photo and reordering the rest in one go
  const both = run(fx, { photos: { edits: {}, removed: ["hm1"], added: [], order: ["hm1_1", "hm2", "hm1"] } });
  assert.ok(both.applied.ok, JSON.stringify(both.applied.conflicts));
  assert.deepEqual(both.applied.objects[KEY].media_list.map((m) => m.ref), ["hm1", "hm2"]);
});

test("people connected: a person is added by handle, the relation edited by key, the connection removed", () => {
  const fx = fixture();
  const rows = LIST_ADAPTERS.connected.rows(fx.bundle, fx.lookups);
  assert.deepEqual(rows.map((r) => [r.id, r.title, r.detail]), [["hp2", "Sam Example", "Godparent"]]);
  const edit = run(fx, { connected: { edits: { hp2: { rel: "Godfather" } }, removed: [], added: [], order: null } });
  assert.deepEqual(edit.ops.map((o) => [o.path, o.base, o.value]), [["/person_ref_list/@ref=hp2/rel", "Godparent", "Godfather"]]);
  assert.ok(edit.applied.ok, JSON.stringify(edit.applied.conflicts));
  const add = run(fx, { connected: { edits: {}, removed: [], added: [{ tid: "n1", values: { person: { id: "I9002", name: "Pat Example", handle: "hp3" }, rel: "Neighbour" } }], order: null } });
  assert.deepEqual(add.ops.map((o) => [o.op, o.path, o.value]), [["add", "/person_ref_list", { _class: "PersonRef", ref: "hp3", rel: "Neighbour" }]]);
  // free text is not a person: a row whose person was never picked sends nothing
  const typedOnly = run(fx, { connected: { edits: {}, removed: [], added: [{ tid: "n1", values: { person: { id: "", name: "Pat Example" }, rel: "x" } }], order: null } });
  assert.deepEqual(typedOnly.ops, []);
  const rm = run(fx, { connected: { edits: {}, removed: ["hp2"], added: [], order: null } });
  assert.deepEqual(rm.ops.map((o) => [o.op, o.path, o.base]), [["remove", "/person_ref_list/@ref=hp2", fx.bundle.obj.person_ref_list[0]]]);
  assert.deepEqual(rm.applied.objects[KEY].person_ref_list, []);
});

test("sources: edit the page and confidence of a citation; add one on a listed or a new source; remove the link", () => {
  const fx = fixture();
  const rows = LIST_ADAPTERS.sources.rows(fx.bundle, fx.lookups);
  assert.deepEqual(rows.map((r) => [r.id, r.title, r.detail]), [["hc1", "A synthetic ledger", "p. 3"]]);
  const edit = run(fx, { sources: { edits: { hc1: { source: { ref: "hs1", name: "" }, page: "p. 4", confidence: "3" } }, removed: [], added: [], order: null } });
  assert.deepEqual(edit.ops.map((o) => [o.obj, o.path, o.base, o.value]), [["Citation:hc1", "/page", "p. 3", "p. 4"], ["Citation:hc1", "/confidence", 2, 3]]);
  assert.ok(edit.applied.ok, JSON.stringify(edit.applied.conflicts));
  const listed = run(fx, { sources: { edits: {}, removed: [], added: [{ tid: "n1", values: { source: { ref: "hs1", name: "" }, page: "p. 9", confidence: "2" } }], order: null } });
  assert.deepEqual(listed.ops.map((o) => [o.op, o.obj, o.path]), [["create", "new:1", undefined], ["add", KEY, "/citation_list"]]);
  assert.deepEqual(listed.ops[0].value, { _class: "Citation", source_handle: "hs1", page: "p. 9", confidence: 2 });
  assert.deepEqual(listed.ops[1].value, "new:1");
  assert.ok(listed.applied.ok, JSON.stringify(listed.applied.conflicts));
  assert.deepEqual(listed.applied.objects[KEY].citation_list, ["hc1", "m1"]);
  const fresh = run(fx, { sources: { edits: {}, removed: [], added: [{ tid: "n1", values: { source: { ref: "", name: "A new ledger" }, page: "", confidence: "1" } }], order: null } });
  assert.deepEqual(fresh.ops.map((o) => [o.op, o.obj, o.cls]), [["create", "new:1", "Source"], ["create", "new:2", "Citation"], ["add", KEY, undefined]]);
  assert.equal(fresh.ops[1].value.source_handle, "new:1");
  assert.ok(fresh.applied.ok, JSON.stringify(fresh.applied.conflicts));
  const none = run(fx, { sources: { edits: {}, removed: [], added: [{ tid: "n1", values: { source: { ref: "", name: "" }, page: "p", confidence: "2" } }], order: null } });
  assert.deepEqual(none.ops, []);
  const rm = run(fx, { sources: { edits: {}, removed: ["hc1"], added: [], order: null } });
  assert.deepEqual(rm.ops.map((o) => [o.op, o.path, o.base]), [["remove", "/citation_list/@=hc1", "hc1"]]);
  assert.deepEqual(rm.applied.objects[KEY].citation_list, []);
});

test("one submission numbers its new objects across sections, in section order, and every op id is allowed by the API", () => {
  const fx = fixture();
  const r = run(fx, {
    names: { first_name: "Test Quinn", surname: "Person", nick: "Tessie" },
    events: { edits: {}, removed: [], added: [{ tid: "n1", values: { type: "21", date: emptyDate(), place: { ref: "", name: "Newtown" }, description: "" } }], order: null },
    notes: { edits: {}, removed: [], added: [{ tid: "n1", values: { text: "Another." } }], order: null }
  });
  assert.deepEqual(r.ops.filter((o) => o.op === "create").map((o) => [o.obj, o.cls]), [["new:1", "Place"], ["new:2", "Event"], ["new:3", "Note"]]);
  for (const id of ids(r.ops)) assert.match(id, /^[A-Za-z0-9_.:-]{1,64}$/);
  assert.equal(new Set(ids(r.ops)).size, r.ops.length);
  assert.ok(r.applied.ok, JSON.stringify(r.applied.conflicts));
  // every op carries only the fields its kind may hold
  const allowed = { set: ["id", "op", "obj", "path", "base", "base_version", "sets", "value"], add: ["id", "op", "obj", "path", "value", "before"], remove: ["id", "op", "obj", "path", "base"], move: ["id", "op", "obj", "path", "before"], create: ["id", "op", "obj", "cls", "value"] };
  for (const o of r.ops) for (const k of Object.keys(o)) assert.ok(allowed[o.op].includes(k), `${o.op} carries ${k}`);
});

test("the draft helpers: empty drafts make no ops; replay keeps what still applies and drops what was saved", () => {
  const fx = fixture();
  assert.ok(listDraftIsEmpty(emptyListDraft()));
  assert.ok(listDraftIsEmpty(undefined));
  assert.deepEqual(run(fx, { events: emptyListDraft(), photos: { edits: {}, removed: [], added: [], order: null } }).ops, []);
  const adapter = LIST_ADAPTERS.facts;
  const rows = adapter.rows(fx.bundle, fx.lookups);
  const id = rows[0].id;
  const draft = { edits: { [id]: { type: "15", value: "Changed" }, gone: { type: "15", value: "x" } }, removed: ["gone"], added: [{ tid: "n1", values: { type: "7", value: "kept" } }, { tid: "n2", values: { type: "7", value: "saved" } }], order: null };
  const out = replayListDraft({ adapter, draft, fresh: fx.bundle, lookups: fx.lookups, section: "facts", settled: new Set(["facts/a:n2", `facts/e:${id}:value`]) });
  assert.deepEqual(out.edits, {});
  assert.deepEqual(out.removed, []);
  assert.deepEqual(out.added.map((a) => a.tid), ["n1"]);
  const kept = replayListDraft({ adapter, draft, fresh: fx.bundle, lookups: fx.lookups, section: "facts" });
  assert.deepEqual(Object.keys(kept.edits), [id]);
  assert.equal(kept.edits[id].value, "Changed");
  const photos = LIST_ADAPTERS.photos;
  assert.equal(replayListDraft({ adapter: photos, draft: { order: ["hm1", "hm2", "hm1_1"] }, fresh: fx.bundle, lookups: fx.lookups, section: "photos" }).order, null);
  assert.deepEqual(replayListDraft({ adapter: photos, draft: { order: ["hm2", "hm1", "hm1_1"] }, fresh: fx.bundle, lookups: fx.lookups, section: "photos" }).order, ["hm2", "hm1", "hm1_1"]);
});

test("dates: the parts round-trip, a birth is year and modifier only, and the words are plain", () => {
  const d = dateFromParts({ modifier: 4, year: 1900, month: 2, day: 3, year2: 1905, month2: 6, day2: 7, quality: 1 });
  assert.deepEqual(d.dateval, [3, 2, 1900, false, 7, 6, 1905, false]);
  assert.deepEqual(dateParts(d), { modifier: 4, quality: 1, day: 3, month: 2, year: 1900, day2: 7, month2: 6, year2: 1905 });
  assert.equal(dateText(d), "between 3 february 1900 and 7 june 1905");
  assert.equal(dateText(dateFromParts({ modifier: 3, year: 1950 }), { birth: true }), "about 1950");
  assert.equal(dateText(dateFromParts({ modifier: 0, year: 1950, month: 3, day: 4 }), { birth: true }), "1950");
  const b = dateFromParts({ modifier: 4, year: 1900, month: 2, day: 3, year2: 1905, month2: 6, day2: 7, quality: 1 }, null, { birth: true });
  assert.deepEqual(b.dateval, [0, 0, 1900, false, 0, 0, 1905, false]);
  assert.equal(b.quality, 0);
  assert.ok(isEmptyDate(emptyDate()) && isEmptyDate(undefined) && !isEmptyDate(d));
  assert.deepEqual(dateFromParts({ modifier: 3, year: 0 }).dateval, [0, 0, 0, false]);
  // a month without a year, or a day without a month, is dropped rather than sent
  assert.deepEqual(dateFromParts({ modifier: 0, year: 0, month: 4, day: 2 }).dateval, [0, 0, 0, false]);
  assert.deepEqual(dateFromParts({ modifier: 0, year: 1990, month: 0, day: 2 }).dateval, [0, 0, 1990, false]);
});

test("types: codes round-trip and the options read the schema", () => {
  assert.equal(typeCode(typed("EventType", 12)), "12");
  assert.equal(typeCode(typed("EventType", 0, "Reunion")), "c:Reunion");
  assert.deepEqual(typeObject("EventType", "c:Reunion"), typed("EventType", 0, "Reunion"));
  assert.deepEqual(typeObject("EventType", "19"), typed("EventType", 19));
  const opts = typeOptions(EDIT_SCHEMAS.Event, "EventType", { customs: ["Reunion"] });
  assert.ok(opts.some((o) => o.value === "12" && o.label === "birth"));
  assert.ok(opts.some((o) => o.value === "c:Reunion"));
  assert.ok(!opts.some((o) => o.value === "0" || o.value === "-1"));
});

test("places and sources in the bundle become the pickers' lists, sorted by name", () => {
  const fx = fixture();
  assert.deepEqual(fx.lookups.places, [{ ref: "hl2", name: "Exampleton" }, { ref: "hl1", name: "Synthville" }]);
  assert.deepEqual(fx.lookups.sources, [{ ref: "hs1", name: "A synthetic ledger" }]);
  assert.equal(fx.lookups.people.get("hp2"), "Sam Example");
  const none = makeLookups({ related: {} }, {});
  assert.deepEqual(none.places, []);
  assert.equal(none.confidence().length, 5);
});

test("the waiting-for-review chip counts only open proposals the bundle lists, and says nothing for none", () => {
  assert.equal(pendingChip([]), null);
  assert.equal(pendingChip(undefined), null);
  assert.equal(pendingChip([{ proposalId: "P1", state: "approved", paths: [] }, { state: "pending" }, "x", null]), null);
  assert.deepEqual(pendingChip([{ proposalId: "P1", state: "pending", paths: [] }]), { n: 1, text: "1 suggested change waiting for review" });
  assert.deepEqual(pendingChip([{ proposalId: "P1", state: "pending" }, { proposalId: "P2", state: "needs_changes" }, { proposalId: "P2", state: "stale" }, { proposalId: "P3", state: "rejected" }]), { n: 2, text: "2 suggested changes waiting for review" });
});

test("the copy is lowercase plain words", () => {
  const texts = Object.values(SECTION_COPY).flatMap((v) => (typeof v === "string" ? [v] : typeof v === "function" ? [v(2)] : Object.values(v)));
  for (const t of texts) {
    assert.ok(!/!/.test(t), t);
    assert.ok(!/\b(record|users?|members?|gramps)\b/i.test(t), t);
    assert.equal(t, t.toLowerCase(), t);
  }
});
