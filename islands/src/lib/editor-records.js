// The editors of the other record classes, pure half (HFY-TSK-157, editor-other-records; HFY-PLN-002 editing.md sections 3.2 and 9.1, DEC-E10,
// DEC-E11, DEC-E12, BRD2 R-06 and R-08): Event, Place, Source, Citation, Repository, Media (metadata), Note and Family. No DOM and no React, so a
// node test pins it (tests/editor-records.test.mjs): the form of each class, the values it starts from, the EditOps a change makes, and the
// drill-down links (event to place, citation to source to repository).
//
// A record form is a section whose `form.record` is true: `form.cls` names the class and `form.fields` the field specs below. A spec is
//   { key, title, kind, ptr, ... }   kind: text | styled | type | int | date | place | source | parent | tags
// `ptr` is the record pointer the field's policy is judged at (the badge asks the bundle's table, so the words "saves now", "goes to review" and
// "only an admin can change this" come from there, never from this file). One exception: a Place's code is locked here unless the place is, and
// stays, an administrative kind, because the table's row for it depends on the record (R-18, place.code.local_only) and the lenient resolver the
// form badges with leaves such rows out. A latitude or longitude is rounded to the policy's decimals before it is sent (place.coordinates.round),
// as a birth's date is cut to its year (DEC-E4). The form's values are plain JSON: a string for text and styled, the
// type code ("12" or "c:<text>") for type, a number's text for int, a Gramps Date for date, { ref, name } for place, source and parent, and an
// array of tag handles for tags. A field the record does not hold starts blank. The server decides on every write; nothing here is a policy.
import { keySegment } from "../../../api/src/records/ops.js";
import { roundCoordinate } from "../../../shared/redaction-rules.mjs";
import {
  baseOf, birthDate, clone, constOptions, dateText, drillHref, emptyDate, isBirthCode, isWordsDate, makeEmitter,
  restyleText, sameDate, sameValue, typeCode, typeObject, typeOptions
} from "./editor-sections.js";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (typeof v === "string" ? v : "");
const trimmed = (v) => (typeof v === "string" ? v.trim() : "");
const get = (obj, ptr) => String(ptr).split("/").filter(Boolean).reduce((o, k) => (isObj(o) ? o[k] : undefined), obj);

export const RECORD_COPY = Object.freeze({
  tagsHint: "pick from the tags that already exist. new tags are made by an admin.",
  tagsNone: "there are no tags to pick from yet.",
  parentNone: "(none)",
  placeNone: "(none)",
  noteAddress: "we don't keep phone numbers, street addresses, e-mail addresses or id numbers on the site.",
  placeStreet: "we don't keep street-level places on the site, so street, building and number aren't offered.",
  placeCoords: "we keep places to two decimals (about town level), so a longer number is rounded to two decimals when you save.",
  dateBirthLike: "a birth, baptism or christening date, or a date equal to one, is kept as a year only.",
  placeCodeHint: "a postal or other code is kept only for a country, state, county, province, region or department. for any other kind of place it can't be changed on the site.",
  repoNoAddress: "we don't keep addresses on the site, so a repository has no addresses.",
  mediaFile: "the photo file itself can't be changed here.",
  noteStyled: "bold, italic and links in the text outside your change are kept. a style that touches your change is dropped.",
  noteStyledDropped: "a style that touched your change was dropped.",
  linksTitle: "related pages",
  linksNone: "nothing connected here yet.",
  open: "open",
  groups: Object.freeze({ place: "place", enclosed: "inside", source: "source", repositories: "kept at", citations: "citations", notes: "notes", events: "events", people: "people", children: "children" })
});

/** The place types a member never sees (DEC-E12): Street (7), Building (19), Number (20). */
export const PLACE_TYPES_SKIPPED = Object.freeze([7, 19, 20]);

/** The place types that keep a code (gramps/redaction/redaction-v1.json places.administrativeTypes, R-18): Country, State, County, Province,
 *  Region, Department. Any other kind, a custom one included, is local and its code is never in the cloud. A test pins this list to the policy file. */
export const PLACE_TYPES_ADMINISTRATIVE = Object.freeze([1, 2, 3, 8, 9, 10]);

/** The coordinate rule of the policy file (places.coordinateDecimals and places.coordinatePattern), in the shape roundCoordinate takes. A test
 *  pins it to the policy file. */
export const COORDINATE_POLICY = Object.freeze({ places: Object.freeze({ coordinateDecimals: 2, coordinatePattern: "^[+-]?[0-9]+(\\.[0-9]+)?$" }) });

/** What the coordinate fields accept while the member types: up to three whole digits and any number of decimals, which are rounded on the way out. */
const COORDINATE_INPUT = "^(?:[+-]?[0-9]{1,3}(?:\\.[0-9]+)?)?$";

/** A latitude or longitude as it is sent: rounded half away from zero to the policy's decimals. A value that is not a plain decimal is left as
 *  typed, so the form's pattern flags it and the server refuses it; it is never blanked silently. */
export const roundedCoordinate = (text) => {
  const r = roundCoordinate(text, COORDINATE_POLICY);
  return r === null ? text : r;
};

const isAdministrativeCode = (code) => /^\d+$/.test(String(code)) && PLACE_TYPES_ADMINISTRATIVE.includes(Number(code));
const placeTypeOf = (obj) => typeCode(get(obj, "/place_type"));

/**
 * True when a Place's code can be written: the stored place is an administrative kind and so is the kind the form now holds (`live.place_type`;
 * a blank keeps the record's). The server's field policy refuses a code when the place is local before or after the change (field-policy.js
 * localPlace), so both are judged here.
 */
export function placeCodeOpen(obj, live = {}) {
  const stored = placeTypeOf(obj);
  const now = isObj(live) && typeof live.place_type === "string" && live.place_type !== "" ? live.place_type : stored;
  return isAdministrativeCode(stored) && isAdministrativeCode(now);
}

const f = (key, title, kind, ptr, extra = {}) => ({ key, title, kind, ptr, ...extra });
const TAGS = f("tags", "tags", "tags", "/tag_list");

/** The field specs of each class, in the order the form shows them. */
export const RECORD_FIELDS = Object.freeze({
  Event: Object.freeze([
    f("type", "kind of event", "type", "/type", { def: "EventType" }),
    f("date", "date", "date", "/date", { widget: "grampsDate", hint: RECORD_COPY.dateBirthLike }),
    f("place", "place", "place", "/place", { widget: "placeRef" }),
    f("description", "description", "text", "/description", { max: 500 }),
    TAGS
  ]),
  Place: Object.freeze([
    f("name", "name", "text", "/name/value", { max: 200 }),
    f("place_type", "kind of place", "type", "/place_type", { def: "PlaceType", skip: PLACE_TYPES_SKIPPED, hint: RECORD_COPY.placeStreet }),
    f("code", "code", "text", "/code", { max: 20, hint: RECORD_COPY.placeCodeHint, administrativeOnly: true }),
    f("lat", "latitude", "text", "/lat", { max: 12, coordinate: true, hint: RECORD_COPY.placeCoords }),
    f("long", "longitude", "text", "/long", { max: 12, coordinate: true, hint: RECORD_COPY.placeCoords }),
    f("enclosed", "inside", "parent", "/placeref_list", { widget: "placeRef" }),
    TAGS
  ]),
  Source: Object.freeze([
    f("title", "title", "text", "/title", { max: 500 }),
    f("author", "author", "text", "/author", { max: 500 }),
    f("pubinfo", "publication", "text", "/pubinfo", { max: 500 }),
    f("abbrev", "short name", "text", "/abbrev", { max: 500 }),
    TAGS
  ]),
  Citation: Object.freeze([
    f("source", "source", "source", "/source_handle", { widget: "sourceRef" }),
    f("page", "page or place in the source", "text", "/page", { max: 500 }),
    f("date", "date", "date", "/date", { widget: "grampsDate", hint: RECORD_COPY.dateBirthLike }),
    f("confidence", "how sure", "int", "/confidence", { prop: "confidence", fallback: "2" }),
    TAGS
  ]),
  Repository: Object.freeze([
    f("name", "name", "text", "/name", { max: 500 }),
    f("type", "kind of repository", "type", "/type", { def: "RepositoryType", hint: RECORD_COPY.repoNoAddress }),
    TAGS
  ]),
  Media: Object.freeze([
    f("desc", "description", "text", "/desc", { max: 500, hint: RECORD_COPY.mediaFile }),
    f("date", "date", "date", "/date", { widget: "grampsDate", hint: RECORD_COPY.dateBirthLike }),
    TAGS
  ]),
  Note: Object.freeze([
    f("text", "note", "styled", "/text", { max: 10000, hint: RECORD_COPY.noteAddress }),
    f("type", "kind of note", "type", "/type", { def: "NoteType" }),
    f("format", "layout", "int", "/format", { prop: "format", fallback: "0" }),
    TAGS
  ]),
  Family: Object.freeze([
    f("type", "kind of relationship", "type", "/type", { def: "FamilyRelType" }),
    TAGS
  ])
});

/** The sections of a class other than Person: one form, and the related pages. */
export function recordSections(cls) {
  const fields = RECORD_FIELDS[cls];
  if (!fields) return [];
  return [
    { id: "details", title: "details", form: { record: true, cls, fields } },
    { id: "related", title: RECORD_COPY.linksTitle, drill: true }
  ];
}

// ---- the form ---------------------------------------------------------------------------------------------------------------------------

/** The values a record form starts from. */
export function recordValues(obj, form) {
  const out = {};
  for (const sp of form.fields) {
    const v = valueOf(obj, sp);
    if (v !== undefined) out[sp.key] = v;
  }
  return out;
}

function valueOf(obj, sp) {
  switch (sp.kind) {
    case "text": { const v = get(obj, sp.ptr); return typeof v === "string" && v !== "" ? v : undefined; }
    case "styled": { const v = get(obj, sp.ptr); return isObj(v) && typeof v.string === "string" && v.string !== "" ? v.string : undefined; }
    case "type": { const v = get(obj, sp.ptr); return isObj(v) ? typeCode(v) : "-1"; }
    case "int": { const v = get(obj, sp.ptr); return Number.isInteger(v) ? String(v) : sp.fallback; }
    case "date": { const v = get(obj, sp.ptr); return isObj(v) ? clone(v) : emptyDate(); }
    case "place": { const v = get(obj, sp.ptr); return { ref: str(v), name: "" }; }
    case "source": { const v = get(obj, sp.ptr); return { ref: str(v), name: "" }; }
    case "parent": { const l = list(get(obj, sp.ptr)); const r = l.find((x) => isObj(x) && str(x.ref)); return { ref: r ? str(r.ref) : "", name: "" }; }
    case "tags": return list(get(obj, sp.ptr)).filter((t) => typeof t === "string");
    default: return undefined;
  }
}

/**
 * The pointer a form field's badge is judged at: [class, pointer], or [class, pointer, "never"] when the form already knows the server refuses the
 * field whatever the table's unconditional rows say (a Place's code while the place is, or becomes, a local kind: placeCodeOpen). A birth's date
 * is the birth-year row; any other date follows the event's own fields. `obj` is the record the form was made from.
 */
export function recordPolicy(form, key, live = {}, obj = null) {
  const sp = form.fields.find((x) => x.key === key);
  if (!sp) return [form.cls, ""];
  if (sp.administrativeOnly && !placeCodeOpen(obj, live)) return [form.cls, sp.ptr, "never"];
  if (form.cls === "Event" && key === "date") return [form.cls, isBirthCode(live.type) ? "/date/dateval/2" : "/description"];
  if (sp.kind === "tags") return [form.cls, "/tag_list/0"];
  if (sp.kind === "parent") return [form.cls, "/placeref_list/0"];
  return [form.cls, sp.ptr];
}

/** The pointer of a form field in the record (the form pointer is "/<key>"). */
export function recordPointer(form, pointer) {
  const key = String(pointer).split("/")[1];
  const sp = form.fields.find((x) => x.key === key);
  return sp ? sp.ptr : pointer;
}

/**
 * The inputSchema of a record form: one property per field, retitled in the family's words. `schemas` is { <cls>: JSON Schema } (the editor
 * fetched them); `lookups` the typed choices and tags (makeLookups). A typed field offers the standard values and the custom strings the tree
 * already has, never a new one (DEC-E10); Place's type leaves out street, building and number (DEC-E12).
 */
export function recordSchema(schema, form, lookups, values = {}) {
  const defs = schema && schema.$defs;
  const properties = {};
  for (const sp of form.fields) {
    const title = sp.title;
    let prop;
    if (sp.kind === "text") {
      const base = sp.key === "name" && form.cls === "Place" ? defs && defs.PlaceName && defs.PlaceName.properties && defs.PlaceName.properties.value : schema && schema.properties && schema.properties[sp.ptr.split("/")[1]];
      prop = { ...(isObj(base) && base.type === "string" ? base : { type: "string", maxLength: sp.max }), title };
      // A coordinate takes more decimals than the record keeps: they are rounded before the change is sent (roundedCoordinate).
      if (sp.coordinate) Object.assign(prop, { maxLength: sp.max, pattern: COORDINATE_INPUT });
      delete prop["x-hfy-note"];
    } else if (sp.kind === "styled") {
      prop = { type: "string", title, maxLength: sp.max, "x-io-widget": "textarea" };
    } else if (sp.kind === "type") {
      const current = values[sp.key] || null;
      const options = typeOptions(schema, sp.def, { customs: lookups && lookups.customs ? lookups.customs[sp.def] : [], current, skip: sp.skip || [] });
      prop = { type: "string", title, oneOf: options.map((o) => ({ const: o.value, title: o.label })) };
    } else if (sp.kind === "int") {
      const fb = sp.key === "format" ? [["0", "flowed text"], ["1", "preformatted text"]].map(([value, label]) => ({ value, label })) : undefined;
      const options = constOptions(schema && schema.properties && schema.properties[sp.prop], fb);
      prop = { type: "string", title, oneOf: options.map((o) => ({ const: o.value, title: o.label })) };
    } else if (sp.kind === "tags") {
      prop = { type: "array", title, items: { type: "string" }, "x-io-widget": "tagPick" };
    } else {
      prop = { type: "object", title, "x-io-widget": sp.widget };
    }
    if (sp.hint) prop.description = sp.hint;
    properties[sp.key] = prop;
  }
  return { type: "object", additionalProperties: false, properties };
}

// ---- the ops ----------------------------------------------------------------------------------------------------------------------------

const dv = (date) => (isObj(date) && Array.isArray(date.dateval) ? date.dateval : []);

/** The tags of a bundle's `tags` as lookups: { handle -> name }. */
export const tagNames = (bundle) => new Map(list(bundle && bundle.tags).filter((t) => isObj(t) && t.handle && t.name).map((t) => [String(t.handle), String(t.name)]));

/**
 * The EditOps for a record form's draft: one change (unit) per field that differs from the record, plus a new place or source when "not listed"
 * was used. -> { ops, units, labels }. Ids are `<section>.<field>.<n>`.
 */
export function recordOps({ key, bundle, section, draft }) {
  let n = 0;
  const e = makeEmitter(section.id, () => `new:${++n}`);
  if (!isObj(draft)) return e;
  const form = section.form;
  const obj = bundle.obj;
  const version = bundle.version;
  for (const sp of form.fields) {
    const after = draft[sp.key];
    if (after === undefined && !["text", "styled", "tags", "place", "parent", "source"].includes(sp.kind)) continue; // a typed field cleared away keeps the record's value
    if (sp.administrativeOnly && !placeCodeOpen(obj, draft)) continue; // locked on a local place (recordPolicy): the server would refuse it
    const stored = get(obj, sp.ptr);
    switch (sp.kind) {
      case "text": {
        const before = typeof stored === "string" ? stored : "";
        const next = sp.coordinate ? roundedCoordinate(trimmed(after)) : trimmed(after);
        if (next === before.trim()) break;
        e.add(sp.key, sp.title, { op: "set", obj: key, path: sp.ptr, base: typeof stored === "string" ? stored : null, value: next });
        break;
      }
      case "styled": {
        const before = isObj(stored) ? str(stored.string) : "";
        const next = str(after).replace(/^\s+|\s+$/g, "");
        if (next === before.replace(/^\s+|\s+$/g, "")) break;
        e.add(sp.key, sp.title, { op: "set", obj: key, path: sp.ptr, base: baseOf(stored), value: restyleText(stored, next) });
        break;
      }
      case "type": {
        const code = str(after);
        if (!code || code === (isObj(stored) ? typeCode(stored) : "-1")) break;
        e.add(sp.key, sp.title, { op: "set", obj: key, path: sp.ptr, base: baseOf(stored), value: typeObject(sp.def, code) });
        break;
      }
      case "int": {
        const next = str(after);
        const same = Number.isInteger(stored) ? Number(next) === stored : next === sp.fallback;
        if (next === "" || same) break;
        e.add(sp.key, sp.title, { op: "set", obj: key, path: sp.ptr, base: Number.isInteger(stored) ? stored : null, value: Number(next) });
        break;
      }
      case "date": dateOp(e, { sp, key, obj, version, draft: after, viewer: bundle.viewer, birth: form.cls === "Event" && isBirthCode(draft.type !== undefined ? draft.type : valueOf(obj, { kind: "type", ptr: "/type" })) }); break;
      case "place": case "source": refOp(e, { sp, key, obj, value: after, cls: sp.kind === "place" ? "Place" : "Source" }); break;
      case "parent": parentOp(e, { sp, key, obj, value: after }); break;
      case "tags": tagOps(e, { sp, key, obj, wanted: list(after) }); break;
      default: break;
    }
  }
  return e;
}

function dateOp(e, { sp, key, obj, version, draft, viewer, birth }) {
  let date = isObj(draft) ? draft : emptyDate();
  const stored = get(obj, sp.ptr);
  const had = isObj(stored);
  // Only a date the member changed is cut down to a birth's year (DEC-E4); one left as it was (its words, a span, a day and month stored before) is never rewritten.
  const untouched = sameDate(date, had ? stored : emptyDate());
  if (birth && !(untouched && (isWordsDate(date) || had))) date = birthDate(date);
  if (sameDate(date, had ? stored : emptyDate())) return;
  if (!had) { e.add(sp.key, sp.title, { op: "set", obj: key, path: sp.ptr, base: null, value: date }); return; }
  if (viewer && viewer.admin) { e.add(sp.key, sp.title, { op: "set", obj: key, path: sp.ptr, base: clone(stored), value: date }); return; }
  // A member's view of a date may lack its day and month (Q2-04b), so the base is the record's version and only the parts changed are replaced.
  const a = dv(stored);
  const b = dv(date);
  const sets = [];
  if (b[0] !== a[0]) sets.push("day");
  if (b[1] !== a[1]) sets.push("month");
  if (date.modifier === 4 || stored.modifier === 4) {
    if (b[4] !== a[4]) sets.push("day2");
    if (b[5] !== a[5]) sets.push("month2");
  }
  if (str(date.text) !== str(stored.text)) sets.push("text");
  e.add(sp.key, sp.title, { op: "set", obj: key, path: sp.ptr, base_version: version, ...(sets.length ? { sets } : {}), value: date });
}

/** A new place or source ("not listed") and the pointer to it, or a changed pick. */
function newObject(e, sp, cls, name) {
  const handle = e.temp();
  const value = cls === "Place"
    ? { _class: "Place", name: { _class: "PlaceName", value: name, lang: "" }, place_type: { _class: "PlaceType", value: -1, string: "" } }
    : { _class: "Source", title: name };
  e.add(sp.key, sp.title, { op: "create", obj: handle, cls, value });
  return handle;
}

function refOp(e, { sp, key, obj, value, cls }) {
  if (!isObj(value)) return;
  const stored = get(obj, sp.ptr);
  const name = trimmed(value.name);
  if (!name && str(value.ref) === str(stored)) return;
  if (!name && !str(value.ref) && sp.kind === "source") return; // a citation always names a source
  const next = name ? newObject(e, sp, cls, name) : str(value.ref);
  e.add(sp.key, sp.title, { op: "set", obj: key, path: sp.ptr, base: typeof stored === "string" ? stored : null, value: next });
}

function parentOp(e, { sp, key, obj, value }) {
  if (!isObj(value)) return;
  const l = list(get(obj, sp.ptr));
  const idx = l.findIndex((x) => isObj(x) && str(x.ref));
  const current = idx >= 0 ? str(l[idx].ref) : "";
  const name = trimmed(value.name);
  if (!name && str(value.ref) === current) return;
  const next = name ? newObject(e, sp, "Place", name) : str(value.ref);
  if (idx >= 0) e.add(sp.key, sp.title, { op: "remove", obj: key, path: `${sp.ptr}/${keySegment("placeref_list", l, idx)}`, base: clone(l[idx]) });
  if (!next) return;
  const el = { _class: "PlaceRef", ref: next, date: emptyDate() };
  e.add(sp.key, sp.title, Array.isArray(get(obj, sp.ptr)) ? { op: "add", obj: key, path: sp.ptr, value: el } : { op: "set", obj: key, path: sp.ptr, base: null, value: [el] });
}

function tagOps(e, { sp, key, obj, wanted }) {
  const stored = list(get(obj, sp.ptr));
  const l = stored.filter((t) => typeof t === "string");
  const want = [...new Set(wanted.filter((t) => typeof t === "string" && t))];
  for (const t of l) if (!want.includes(t)) e.add("tags", sp.title, { op: "remove", obj: key, path: `${sp.ptr}/${keySegment("tag_list", stored, stored.indexOf(t))}`, base: t });
  for (const t of want) {
    if (l.includes(t)) continue;
    e.add("tags", sp.title, Array.isArray(get(obj, sp.ptr)) ? { op: "add", obj: key, path: sp.ptr, value: t } : { op: "set", obj: key, path: sp.ptr, base: null, value: [t] });
  }
}

/**
 * The form values after the record changed under them (a 409, or the refetch after a save): the fresh record's values with only the fields the
 * member changed (against the record they edited) laid over them. `settled` is the set of `<section>/<field>` units whose every op a save just
 * stored (editor-save.js settledUnitsOf): such a field is done, as a change that saved or one that went to review, so it is not laid over the
 * fresh record again and the next save does not send it twice. Only what the member typed after the save survives.
 */
export function recordSeed({ section, oldObj, freshObj, draft, settled = new Set() }) {
  const form = section.form;
  const values = recordValues(freshObj, form);
  if (!isObj(draft)) return values;
  const before = recordValues(oldObj, form);
  for (const sp of form.fields) {
    if (settled.has(`${section.id}/${sp.key}`)) continue;
    const after = draft[sp.key];
    const was = before[sp.key];
    const norm = (v) => (v === undefined ? (sp.kind === "tags" ? [] : sp.kind === "place" || sp.kind === "source" || sp.kind === "parent" ? { ref: "", name: "" } : "") : v);
    if (sameValue(norm(after), norm(was)) || (sp.kind === "date" && sameDate(after, was))) continue;
    if (after === undefined || after === "") delete values[sp.key];
    else values[sp.key] = after;
  }
  return values;
}

/**
 * The lines a record form shows under its fields: for a note with styles, what happens to them (DEC-E11), and a warning when the text now
 * typed would drop a style that touches the change. -> [{ kind: "info" | "warning", text }]
 */
export function recordNotes(form, obj, live = {}) {
  if (form.cls !== "Note") return [];
  const stored = isObj(obj) && isObj(obj.text) ? obj.text : null;
  const ranges = (t) => list(t && t.tags).reduce((n, tag) => n + (isObj(tag) ? list(tag.ranges).length : 0), 0);
  if (!stored || !ranges(stored)) return [];
  const out = [{ kind: "info", text: RECORD_COPY.noteStyled }];
  const next = str(live.text).replace(/^\s+|\s+$/g, "");
  if (live.text !== undefined && ranges(restyleText(stored, next)) < ranges(stored)) out.push({ kind: "warning", text: RECORD_COPY.noteStyledDropped });
  return out;
}

// ---- the related pages (drill-down) -----------------------------------------------------------------------------------------------------

const preview = (s) => { const t = str(s).replace(/\s+/g, " ").trim(); return t.length > 60 ? `${t.slice(0, 57)}...` : t; };
const rel = (bundle, cls, handle) => (isObj(bundle.related) && isObj(bundle.related[`${cls}:${handle}`]) ? bundle.related[`${cls}:${handle}`] : null);

/** The title of a record for a link or a heading. */
export function recordTitle(cls, obj, lookups = null) {
  const o = isObj(obj) ? obj : {};
  switch (cls) {
    case "Place": return str(o.name && o.name.value) || str(o.title);
    case "Source": return str(o.title);
    case "Repository": return str(o.name);
    case "Citation": return str(o.page);
    case "Media": return str(o.desc);
    case "Note": return preview(isObj(o.text) ? o.text.string : "");
    case "Event": {
      const code = typeCode(o.type);
      const t = lookups && lookups.eventTypes ? lookups.eventTypes(code).find((x) => x.value === code) : null;
      return [t ? t.label : str(o.type && o.type.string), dateText(o.date, { birth: isBirthCode(code) })].filter(Boolean).join(", ");
    }
    default: return "";
  }
}

/**
 * The links to the pages related to a record, in groups: [{ id, label, items: [{ href, title, detail }] }]. A link goes to the editor of the
 * related record (`/edit/?cls=<class>&id=<gramps id or h:handle>`), or to a person's editor. Event to place and notes; Place to the places
 * it sits inside; Citation to its source; Source to its repositories; Family to its events, parents and children.
 */
export function drillLinks(cls, bundle, lookups = null) {
  const obj = isObj(bundle && bundle.obj) ? bundle.obj : {};
  const groups = [];
  const push = (id, entries) => { const items = entries.filter(Boolean); if (items.length) groups.push({ id, label: RECORD_COPY.groups[id], items }); };
  const item = (c, handle, extra = {}) => {
    if (typeof handle !== "string" || !handle) return null;
    const r = rel(bundle, c, handle);
    if (c !== "Person" && !r) return null; // a hidden or missing object has no link
    const o = r && isObj(r.obj) ? r.obj : null;
    const title = c === "Person" ? str(r && r.stub && r.stub.displayName) : recordTitle(c, o, lookups);
    return { href: drillHref(c, handle, o), title: title || extra.fallback || c.toLowerCase(), detail: extra.detail || "", cls: c };
  };
  const notes = () => push("notes", list(obj.note_list).map((h) => item("Note", h, { fallback: "note" })));
  const cites = () => push("citations", list(obj.citation_list).map((h) => item("Citation", h, { fallback: "citation" })));
  switch (cls) {
    case "Event":
      push("place", [item("Place", obj.place, { fallback: "place" })]);
      cites();
      notes();
      break;
    case "Place":
      push("enclosed", list(obj.placeref_list).map((x) => (isObj(x) ? item("Place", x.ref, { fallback: "place" }) : null)));
      cites();
      notes();
      break;
    case "Citation":
      push("source", [item("Source", obj.source_handle, { fallback: "source" })]);
      notes();
      break;
    case "Source":
      push("repositories", list(obj.reporef_list).map((x) => (isObj(x) ? item("Repository", x.ref, { fallback: "repository", detail: str(x.call_number) }) : null)));
      notes();
      break;
    case "Repository":
      notes();
      break;
    case "Media":
      cites();
      notes();
      break;
    case "Family":
      push("people", [item("Person", obj.father_handle, { fallback: "person" }), item("Person", obj.mother_handle, { fallback: "person" })]);
      push("children", list(obj.child_ref_list).map((x) => (isObj(x) ? item("Person", x.ref, { fallback: "person" }) : null)));
      push("events", list(obj.event_ref_list).map((x) => (isObj(x) ? item("Event", x.ref, { fallback: "event" }) : null)));
      cites();
      notes();
      break;
    default:
      break;
  }
  return groups;
}
