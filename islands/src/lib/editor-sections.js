// The person editor's sections, pure half (HFY-TSK-156, editor-person-sections; HFY-PLN-002 editing.md sections 3.2, 5.3 and 9.1, BRD2 R-06, R-08, R-09).
// No DOM and no React, so a node test pins it (tests/editor-sections.test.mjs): for each section, the rows the record shows, the blank for a new
// row, the form schema of one row, and the EditOps an add, an edit or a remove produces. Every list element is addressed by a key segment (the
// ops engine's `keySegment`, imported from the API so the editor and the server compute the same keys), never by position, and every op carries
// the base it was made against. The server decides on every write; nothing here is a policy, only the shape of what to ask for.
//
// A list section's draft is plain JSON (the editor compares drafts with JSON.stringify):
//   { edits: { [rowId]: values }, removed: [rowId], added: [{ tid, values }], order: [rowId] | null }
// `rowId` is stable for the record being edited: the element's `ref` or handle (with `_<n>` for a repeated ref), or the 12-hex content hash of
// an element that has no identity of its own. `tid` is a counter of the draft. Op ids are `<section>.<unit>.<n>`; a unit is one change as the
// member thinks of it (edit one field, remove one row, add one row, reorder the photos), so the bar counts units, not ops.
import { canonicalJson, hash12, keySegment } from "../../../api/src/records/ops.js";
import { PENDING_COPY } from "./editor-pending.js";
import { NAME_FIELDS, givenParts, givenTokens, nameValues, primarySurnameIndex } from "./editor-names.js";

export { NAME_FIELDS, givenParts, givenTokens, nameValues, primarySurnameIndex };

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (typeof v === "string" ? v : "");
export const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const trimmed = (v) => (typeof v === "string" ? v.trim() : "");
/** True when two JSON values are the same by canonical text (key order does not matter). */
export const sameValue = (a, b) => {
  if (a === undefined || b === undefined) return a === b;
  try { return canonicalJson(a) === canonicalJson(b); } catch { return false; }
};

/** The editor URL of a related record: its gramps id when it has one, else `h:<handle>` (the route takes either). */
export function drillHref(cls, handle, obj = null) {
  const gid = isObj(obj) && typeof obj.gramps_id === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(obj.gramps_id) ? obj.gramps_id : "";
  return `/edit/?cls=${String(cls).toLowerCase()}&id=${encodeURIComponent(gid || `h:${handle}`)}`;
}

// ---- the words ------------------------------------------------------------------------------------------------------------------

export const SECTION_COPY = Object.freeze({
  add: "add",
  edit: "change",
  done: "done",
  remove: "remove",
  keep: "keep",
  discard: "discard",
  none: "nothing here yet.",
  newTag: "new",
  editedTag: "changed",
  removedTag: "will be removed",
  primaryTag: "main photo",
  up: "move up",
  down: "move down",
  makeMain: "make main photo",
  birthYearOnly: "we only keep the birth year on the site.",
  noContact: "we don't keep phone numbers, street addresses, e-mail addresses or id numbers on the site.",
  givenHint: "one box for every given name. first and middle are filled in from it.",
  callHint: "pick the one you go by from your given names.",
  callNone: "(none)",
  first: "first",
  middle: "middle",
  placeNone: "(no place)",
  placeNotListed: "not listed",
  placeNewLabel: "name of the place",
  placeNewHint: "this goes to review. we don't keep street addresses on the site.",
  sourceNone: "(pick a source)",
  sourceNotListed: "not listed",
  sourceNewLabel: "name of the source",
  sourceNewHint: "this goes to review.",
  personPick: "pick a person from the list. typing a name alone isn't enough.",
  personPicked: "picked:",
  personRemove: "pick someone else",
  personSearching: "searching",
  personNoMatch: "nobody matches.",
  personResolveFailed: "we couldn't add that person. try another.",
  personSelf: "that's this page's own person. pick someone else.",
  personAlready: "they're already connected. pick someone else.",
  dateEstimated: "estimated",
  dateYear: "year",
  dateMonth: "month",
  dateDay: "day",
  dateEndYear: "to year",
  dateKind: "kind",
  dateWords: "this date is written out in words, so it can't be changed here.",
  monthNone: "(month)",
  modExact: "exactly",
  modAbout: "about",
  modBefore: "before",
  modAfter: "after",
  modBetween: "between",
  openRecord: "open",
  addLabel: Object.freeze({ alt: "add another name", events: "add an event", facts: "add a fact", notes: "add a note", connected: "add a person", sources: "add a source" }),
  listLabel: Object.freeze({ alt: "also known as", events: "life events", facts: "facts", notes: "notes", photos: "photos", connected: "people connected to you", sources: "sources" }),
  never: Object.freeze({ events: "we only keep the birth year on the site.", facts: "we don't keep phone numbers, street addresses, e-mail addresses or id numbers on the site.", notes: "we don't keep phone numbers, street addresses, e-mail addresses or id numbers on the site.", sources: "" }),
  photoHint: "the first photo is the main one on the page.",
  fallbackTitle: Object.freeze({ events: "event", facts: "fact", notes: "note", photos: "photo", connected: "person", sources: "source", alt: "name" }),
  pendingOne: PENDING_COPY.pendingOne,
  pendingMany: PENDING_COPY.pendingMany
});

// ---- types and options -------------------------------------------------------------------------------------------------------------

/** A Gramps type as a form code: "12" for a standard value, "c:<text>" for a custom one. */
export const typeCode = (t) => (isObj(t) ? (t.value === 0 ? `c:${str(t.string)}` : String(Number.isInteger(t.value) ? t.value : -1)) : "-1");
/** The typed object a code stands for: `{ _class, value, string }`. */
export const typeObject = (cls, code) => (String(code).startsWith("c:") ? { _class: cls, value: 0, string: String(code).slice(2) } : { _class: cls, value: Number(code), string: "" });

const lower = (s) => str(s).toLowerCase();

/**
 * The choices of a typed field from the schema definition `def` (the oneOf of consts with titles): standard values only, in the schema's order,
 * then the custom strings the tree already has (`customs`; a member never invents one, DEC-E10), then the current value if it is neither
 * (so an old value still shows). -> [{ value: code, label }]
 */
export function typeOptions(schema, def, { customs = [], current = null, skip = [] } = {}) {
  const d = schema && schema.$defs && schema.$defs[def];
  const out = [];
  for (const branch of list(d && d.oneOf)) {
    const v = branch && branch.properties && branch.properties.value && branch.properties.value.const;
    if (!Number.isInteger(v) || v === 0 || v === -1 || skip.includes(v)) continue;
    out.push({ value: String(v), label: lower(branch.title) });
  }
  for (const s of list(customs)) if (typeof s === "string" && s && !out.some((o) => o.value === `c:${s}`)) out.push({ value: `c:${s}`, label: lower(s) });
  if (current && !out.some((o) => o.value === current)) out.push({ value: current, label: current.startsWith("c:") ? lower(current.slice(2)) : current === "-1" ? "other" : current });
  return out;
}

/** The choices of an integer enum property written as oneOf consts (a citation's confidence): [{ value: "2", label }]. */
export function constOptions(propertySchema, fallback = []) {
  const out = list(propertySchema && propertySchema.oneOf).filter((b) => Number.isInteger(b && b.const)).map((b) => ({ value: String(b.const), label: lower(b.title) }));
  return out.length ? out : fallback;
}

const CONFIDENCE_FALLBACK = Object.freeze([["0", "very low"], ["1", "low"], ["2", "normal"], ["3", "high"], ["4", "very high"]].map(([value, label]) => ({ value, label })));
const NAME_TYPE_STANDARD = Object.freeze([["1", "also known as"], ["2", "birth name"], ["3", "married name"]].map(([value, label]) => ({ value, label })));
const MERGED_ID = /^merged gramps id$/i;

/**
 * What the pickers and titles need, from the bundle and the schemas the editor fetched: the typed choices, the places and sources the bundle
 * holds, and the names of the people it references. `schemas` is { Person, Event, Note, Citation } (any may be missing: the choices then hold
 * only the value a row already has).
 */
export function makeLookups(bundle, schemas = {}) {
  const related = isObj(bundle && bundle.related) ? bundle.related : {};
  const custom = isObj(bundle && bundle.customTypes) ? bundle.customTypes : {};
  const places = [];
  const sources = [];
  const people = new Map();
  const placeNames = new Map();
  const sourceTitles = new Map();
  for (const [key, rel] of Object.entries(related)) {
    const colon = key.indexOf(":");
    const cls = key.slice(0, colon);
    const handle = key.slice(colon + 1);
    const obj = isObj(rel) && isObj(rel.obj) ? rel.obj : null;
    if (cls === "Place" && obj) {
      const name = str(obj.name && obj.name.value) || str(obj.title);
      if (name) { places.push({ ref: handle, name }); placeNames.set(handle, name); }
    } else if (cls === "Source" && obj) {
      const title = str(obj.title);
      if (title) { sources.push({ ref: handle, name: title }); sourceTitles.set(handle, title); }
    } else if (cls === "Person" && isObj(rel) && isObj(rel.stub)) {
      people.set(handle, str(rel.stub.displayName));
    }
  }
  // Who the person picker must not offer: this page's own person, and the people already connected to it.
  const selfHandle = typeof (bundle && bundle.key) === "string" && bundle.key.startsWith("Person:") ? bundle.key.slice(7) : "";
  const selfId = bundle && isObj(bundle.obj) ? str(bundle.obj.gramps_id) : "";
  const connected = new Set(list(bundle && isObj(bundle.obj) ? bundle.obj.person_ref_list : []).filter(isObj).map((r) => str(r.ref)).filter(Boolean));
  const byName = (a, b) => a.name.localeCompare(b.name);
  places.sort(byName);
  sources.sort(byName);
  return {
    eventTypes: (current) => typeOptions(schemas.Event, "EventType", { customs: custom.EventType, current }),
    attributeTypes: (current) => typeOptions(schemas.Person, "AttributeType", { customs: custom.AttributeType, current }),
    nameTypes: (current) => {
      const o = typeOptions(schemas.Person, "NameType", { customs: custom.NameType, current });
      return o.length ? o : NAME_TYPE_STANDARD.concat(current && !NAME_TYPE_STANDARD.some((x) => x.value === current) ? [{ value: current, label: current }] : []);
    },
    confidence: () => constOptions(schemas.Citation && schemas.Citation.properties && schemas.Citation.properties.confidence, CONFIDENCE_FALLBACK),
    places, sources, people, placeNames, sourceTitles, selfHandle, selfId, connected, customs: custom, tags: list(bundle && bundle.tags).filter((t) => isObj(t) && str(t.handle) && str(t.name)).map((t) => ({ handle: str(t.handle), name: str(t.name) }))
  };
}

// ---- dates ----------------------------------------------------------------------------------------------------------------------

export const MODIFIER = Object.freeze({ NONE: 0, BEFORE: 1, AFTER: 2, ABOUT: 3, RANGE: 4 });
/** The Gramps event type code of a Birth. */
export const BIRTH = 12;
/** The birth-like event types (gramps/redaction/redaction-v1.json birthLike, D2-32): a test pins this list to the policy file. */
export const BIRTH_LIKE_CODES = Object.freeze([12, 14, 15, 18, 22, 45]);
export const BIRTH_LIKE_CUSTOM = /birth|bapt|christen|naissance|geburt|nacimiento/i;
/** True for a birth-like type code ("15") or a custom type ("c:<text>") whose words say so. Year only, for everyone. */
export const isBirthCode = (code) => {
  const c = String(code);
  if (c.startsWith("c:")) return BIRTH_LIKE_CUSTOM.test(c.slice(2));
  return BIRTH_LIKE_CODES.includes(Number(c)) && /^\d+$/.test(c);
};

/** An empty Gregorian Date: no year, no month, no day. */
export const emptyDate = () => ({ _class: "Date", calendar: 0, modifier: 0, quality: 0, dateval: [0, 0, 0, false], text: "", newyear: 0 });

const int = (v) => (Number.isInteger(v) && v > 0 ? v : 0);
const dv = (date) => (isObj(date) && Array.isArray(date.dateval) ? date.dateval : []);

/** The parts a date form shows: { modifier, quality, year, month, day, year2, month2, day2 } (0 for none). A text-only date shows as no parts. */
export function dateParts(date) {
  const v = dv(date);
  const range = isObj(date) && (date.modifier === 4 || date.modifier === 5);
  return {
    modifier: isObj(date) && Number.isInteger(date.modifier) ? date.modifier : 0,
    quality: isObj(date) && Number.isInteger(date.quality) ? date.quality : 0,
    day: int(v[0]), month: int(v[1]), year: int(v[2]),
    day2: range ? int(v[4]) : 0, month2: range ? int(v[5]) : 0, year2: range ? int(v[6]) : 0
  };
}

/** A date the form cannot rebuild from its parts: text only (6) or a from-to span (5). It is shown as it is and left alone. */
export const isWordsDate = (date) => isObj(date) && (date.modifier === 5 || date.modifier === 6) && !isEmptyDate(date);

/** True when a date holds no year, month or day (and no text): the event has no date. */
export const isEmptyDate = (date) => {
  if (!isObj(date)) return true;
  const p = dateParts(date);
  return !p.year && !p.month && !p.day && !p.year2 && !str(date.text).trim();
};

/**
 * The Date the parts describe, laid over `base` (a Date, so its calendar, newyear and sortval ride along unless a part changes them). A birth
 * keeps year and modifier only: the day and month are zeroed whatever the parts say (DEC-E4). A "between" date holds both ends.
 */
export function dateFromParts(parts, base = null, { birth = false } = {}) {
  const b = isObj(base) ? clone(base) : emptyDate();
  const p = { ...parts };
  let modifier = Number.isInteger(p.modifier) ? p.modifier : 0;
  if (![0, 1, 2, 3, 4].includes(modifier)) modifier = 0;
  const year = int(p.year);
  const month = birth || !year ? 0 : int(p.month);
  const day = birth || !month ? 0 : int(p.day);
  const range = modifier === 4;
  const year2 = range ? int(p.year2) : 0;
  const month2 = range && !birth && year2 ? int(p.month2) : 0;
  const day2 = range && !birth && month2 ? int(p.day2) : 0;
  const slash = Boolean(dv(base)[3]);
  const slash2 = Boolean(dv(base)[7]);
  const next = {
    ...b, _class: "Date", modifier,
    quality: birth ? 0 : p.quality === 1 ? 1 : 0,
    dateval: range ? [day, month, year, slash, day2, month2, year2, slash2] : [day, month, year, slash],
    text: ""
  };
  if (!year && !range) next.modifier = 0;
  return next;
}

/** The date a birth keeps: year and modifier, day and month zero on both ends. */
export const birthDate = (date) => dateFromParts(dateParts(date), date, { birth: true });

const dateKey = (d) => ({
  calendar: Number.isInteger(d.calendar) ? d.calendar : 0, modifier: Number.isInteger(d.modifier) ? d.modifier : 0, quality: Number.isInteger(d.quality) ? d.quality : 0,
  newyear: Number.isInteger(d.newyear) ? d.newyear : 0, text: str(d.text), dateval: dv(d).map((x) => (typeof x === "boolean" ? x : Number.isInteger(x) ? x : 0))
});
/** Whether two dates describe the same thing: the calendar, kind, quality, new-year, text and every part (the sort value is derived and left out). */
export const sameDate = (a, b) => (isEmptyDate(a) && isEmptyDate(b)) || (isObj(a) && isObj(b) && sameValue(dateKey(a), dateKey(b)));

/** The year of a date, 0 for none: what a row shows beside its kind. */
export const yearOfDate = (date) => dateParts(date).year;

/** A date as the short words a row shows ("about 1950", "1950", "between 1950 and 1955"). Year-only for a birth; the month and day when they are there. */
export function dateText(date, { birth = false } = {}) {
  if (isEmptyDate(date)) return "";
  if (isObj(date) && date.modifier === 6) return str(date.text);
  const p = dateParts(date);
  const one = (y, m, d) => [d && !birth ? d : "", m && !birth ? MONTHS[m - 1] : "", y || ""].filter(Boolean).join(" ");
  const first = one(p.year, p.month, p.day);
  const words = { 1: "before ", 2: "after ", 3: "about " };
  if (p.modifier === 4) return `between ${first} and ${one(p.year2, p.month2, p.day2)}`.trim();
  if (p.modifier === 5) return `from ${first} to ${one(p.year2, p.month2, p.day2)}`.trim();
  return `${words[p.modifier] || ""}${first}${p.quality === 1 && !birth ? " (estimated)" : ""}`.trim();
}
export const MONTHS = Object.freeze(["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]);

// ---- styled notes (DEC-E11) -------------------------------------------------------------------------------------------------------

/**
 * The StyledText after the member edits the text. The tags outside the edited span stay (those after it shift by the length change); a tag that
 * touches the edited span goes, and so does a tag left with no range. The edited span is what is left after trimming the common start and end.
 */
export function restyleText(styled, next) {
  const base = isObj(styled) ? styled : { _class: "StyledText", string: "", tags: [] };
  const old = str(base.string);
  if (old === next) return clone(base);
  let p = 0;
  while (p < old.length && p < next.length && old[p] === next[p]) p += 1;
  let s = 0;
  while (s < old.length - p && s < next.length - p && old[old.length - 1 - s] === next[next.length - 1 - s]) s += 1;
  const endOld = old.length - s;
  const delta = next.length - old.length;
  const tags = [];
  for (const tag of list(base.tags)) {
    if (!isObj(tag)) continue;
    const ranges = [];
    for (const r of list(tag.ranges)) {
      if (!Array.isArray(r) || r.length !== 2) continue;
      const [a, b] = r;
      if (b <= p) ranges.push([a, b]);
      else if (a >= endOld) ranges.push([a + delta, b + delta]);
    }
    if (ranges.length) tags.push({ ...clone(tag), ranges });
  }
  return { ...clone(base), _class: "StyledText", string: next, tags };
}

// ---- row ids and the emitter ---------------------------------------------------------------------------------------------------------

/** Row ids for a ref list: the ref, with `_<n>` for the n-th repeat of it. */
/** Row ids for lists without a ref: a content hash, and `_n` on a repeat so two identical rows stay two rows (as keyFor() does for the path). */
function hashRowIds(arr) {
  const seen = new Map();
  return arr.map((el) => {
    const h = hash12(el);
    const n = seen.get(h) || 0;
    seen.set(h, n + 1);
    return n ? `${h}_${n}` : h;
  });
}

function refRowIds(arr) {
  const seen = new Map();
  return arr.map((el) => {
    const ref = isObj(el) ? str(el.ref) : "";
    const n = seen.get(ref) || 0;
    seen.set(ref, n + 1);
    return n ? `${ref}_${n}` : ref;
  });
}

export function makeEmitter(secKey, temp, { plain = false } = {}) {
  const ops = [];
  const units = {};
  const labels = {};
  const counts = {};
  const add = (unit, label, op) => {
    const n = (counts[unit] = (counts[unit] || 0) + 1);
    const id = plain ? `${secKey}.${unit}` : `${secKey}.${unit}.${n}`;
    ops.push({ id, ...op });
    units[id] = `${secKey}/${unit}`;
    labels[id] = label;
    return id;
  };
  return { ops, units, labels, add, temp };
}

const emptyList = () => ({ edits: {}, removed: [], added: [], order: null });
/** A list section's draft with nothing in it. */
export const emptyListDraft = emptyList;
export const normalizeListDraft = (d) => ({ ...emptyList(), ...(isObj(d) ? d : {}) });
/** True when the draft holds no change. */
export const listDraftIsEmpty = (d) => {
  const n = normalizeListDraft(d);
  return !Object.keys(n.edits).length && !n.removed.length && !n.added.length && !n.order;
};

const obj2 = (o, k) => (isObj(o) ? o[k] : undefined);
export const baseOf = (stored) => (stored === undefined ? null : stored);

// ---- the names section: the primary name's own fields ------------------------------------------------------------------------------------

/**
 * The EditOps for the names form: one `set` per changed field of the primary name (a missing property is created with `base: null`), the last
 * name through the primary surname element by its key (or an add when the name has none). A call name that is no longer one of the given
 * names is cleared with them. -> { ops, units, labels }
 */
export function namesOps({ key, obj, draft, section = "names" }) {
  const e = makeEmitter(section, undefined, { plain: true });
  if (!isObj(draft)) return e;
  const name = isObj(obj && obj.primary_name) ? obj.primary_name : {};
  const titles = Object.fromEntries(NAME_FIELDS);
  const after = {};
  for (const [f] of NAME_FIELDS) after[f] = trimmed(draft[f]);
  if (after.call && after.first_name !== trimmed(name.first_name) && !givenTokens(after.first_name).includes(after.call)) after.call = "";
  for (const f of ["first_name", "call", "nick", "title", "suffix"]) {
    const stored = name[f];
    const before = typeof stored === "string" ? stored : "";
    if (after[f] === before.trim()) continue;
    const path = `/primary_name/${f}`;
    e.add(f, titles[f], { op: "set", obj: key, path, base: typeof stored === "string" ? stored : null, value: after[f] });
  }
  const i = primarySurnameIndex(name);
  const l = list(name.surname_list);
  const storedSurname = i >= 0 && isObj(l[i]) ? l[i].surname : undefined;
  const beforeSurname = typeof storedSurname === "string" ? storedSurname : "";
  if (after.surname !== beforeSurname.trim()) {
    if (i >= 0) {
      e.add("surname", titles.surname, { op: "set", obj: key, path: `/primary_name/surname_list/${keySegment("surname_list", l, i)}/surname`, base: typeof storedSurname === "string" ? storedSurname : null, value: after.surname });
    } else if (after.surname) {
      const el = { _class: "Surname", surname: after.surname, primary: true };
      if (Array.isArray(name.surname_list)) e.add("surname", titles.surname, { op: "add", obj: key, path: "/primary_name/surname_list", value: el });
      else e.add("surname", titles.surname, { op: "set", obj: key, path: "/primary_name/surname_list", base: null, value: [el] });
    }
  }
  return e;
}

/** The values of a plain form section (a section whose `form` is not the names form): the string fields at the form's prefix. */
export function plainFormValues(obj, form) {
  const base = form.prefix.split("/").filter(Boolean).reduce((o, k) => (isObj(o) ? o[k] : undefined), obj);
  const out = {};
  for (const [key] of form.fields) {
    const v = isObj(base) ? base[key] : undefined;
    if (typeof v === "string" && v !== "") out[key] = v;
  }
  return out;
}

/** The EditOps for a plain form section: one `set` per field whose trimmed text differs from the record's (`base` null when the property is missing). */
export function formOps({ key, obj, section, draft }) {
  const e = makeEmitter(section.id, undefined, { plain: true });
  if (!isObj(draft)) return e;
  const form = section.form;
  const base = form.prefix.split("/").filter(Boolean).reduce((o, k) => (isObj(o) ? o[k] : undefined), obj);
  for (const [field, title] of form.fields) {
    const stored = isObj(base) ? base[field] : undefined;
    const before = typeof stored === "string" ? stored : "";
    const after = trimmed(draft[field]);
    if (after === before.trim()) continue;
    e.add(field, title, { op: "set", obj: key, path: `${form.prefix}/${field}`, base: typeof stored === "string" ? stored : null, value: after });
  }
  return e;
}

// ---- the list sections -----------------------------------------------------------------------------------------------------------------
// Each adapter: { id, rows(bundle, lookups), blank(bundle), schema(ctx), ops(ctx) }.
//   rows    -> [{ id, title, detail, values, locked? }]   the current rows, in the record's order
//   blank   -> the values of a new row
//   schema  -> the JSON Schema of one row's form (the kit walks it; `x-io-widget` names the host widgets)
//   ops     -> { ops, units, labels }  from the draft against the bundle
// `ctx` for ops: { key, bundle, draft, viewer, temp, section }.

const text = (title, extra = {}) => ({ type: "string", title, maxLength: 500, ...extra });
const choice = (title, options) => ({ type: "string", title, oneOf: options.map((o) => ({ const: o.value, title: o.label })) });
// No `required`: the kit would add " *" to the label, and a row left half empty is not an error, it is just not sent (the ops builders skip it).
const objectSchema = (properties) => ({ type: "object", additionalProperties: false, properties });

/** The title a row shows when it has nothing else to say: "event 2". */
const fallback = (id, n) => `${SECTION_COPY.fallbackTitle[id] || "item"} ${n + 1}`;

// ---- alternate names ("also known as") ----
const altName = {
  id: "alt",
  rows(bundle, lookups) {
    const l = list(bundle.obj && bundle.obj.alternate_names);
    const ids = hashRowIds(l);
    return l.map((n, idx) => ({ n, idx })).filter((x) => isObj(x.n)).map(({ n, idx }) => {
      const sn = list(n.surname_list).map((s) => (isObj(s) ? str(s.surname) : "")).filter(Boolean).join(" ");
      const full = [str(n.first_name), sn].filter(Boolean).join(" ");
      const code = typeCode(n.type);
      const type = lookups.nameTypes(code).find((o) => o.value === code);
      const i = primarySurnameIndex(n);
      return {
        id: ids[idx], idx, title: full || fallback("alt", idx), detail: type ? type.label : "",
        values: { first_name: str(n.first_name), surname: i >= 0 ? str(list(n.surname_list)[i].surname) : "", type: code }
      };
    });
  },
  blank: () => ({ first_name: "", surname: "", type: "1" }),
  schema({ lookups, schemas, values }) {
    const def = schemas && schemas.Person && schemas.Person.$defs;
    const nm = def && def.Name && def.Name.properties;
    const sn = def && def.Surname && def.Surname.properties;
    return objectSchema({
      first_name: { ...(nm && nm.first_name ? nm.first_name : text("given names")), title: "given names" },
      surname: { ...(sn && sn.surname ? sn.surname : text("last name")), title: "last name" },
      type: choice("kind of name", lookups.nameTypes(values && values.type))
    });
  },
  policy: (field) => ["Person", { first_name: "/alternate_names/0/first_name", surname: "/alternate_names/0/surname_list/0/surname", type: "/alternate_names/0/type" }[field] || "/alternate_names/0"],
  ops({ key, bundle, draft, section }) {
    const e = makeEmitter(section);
    const d = normalizeListDraft(draft);
    const l = list(bundle.obj && bundle.obj.alternate_names);
    const rows = this.rows(bundle, { nameTypes: () => [] });
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of d.removed) {
      const r = byId.get(id);
      if (!r) continue;
      e.add(`r:${id}`, `remove ${r.title}`, { op: "remove", obj: key, path: `/alternate_names/${keySegment("alternate_names", l, r.idx)}`, base: clone(l[r.idx]) });
    }
    for (const [id, v] of Object.entries(d.edits)) {
      const r = byId.get(id);
      if (!r || d.removed.includes(id)) continue;
      const el = l[r.idx];
      const base = `/alternate_names/${keySegment("alternate_names", l, r.idx)}`;
      const first = trimmed(v.first_name);
      if (first !== str(el.first_name).trim()) e.add(`e:${id}:first_name`, "given names", { op: "set", obj: key, path: `${base}/first_name`, base: typeof el.first_name === "string" ? el.first_name : null, value: first });
      const si = primarySurnameIndex(el);
      const sBefore = si >= 0 ? str(list(el.surname_list)[si].surname) : "";
      const sAfter = trimmed(v.surname);
      if (sAfter !== sBefore.trim()) {
        if (si >= 0) e.add(`e:${id}:surname`, "last name", { op: "set", obj: key, path: `${base}/surname_list/${keySegment("surname_list", list(el.surname_list), si)}/surname`, base: typeof list(el.surname_list)[si].surname === "string" ? list(el.surname_list)[si].surname : null, value: sAfter });
        else if (sAfter) {
          const sel = { _class: "Surname", surname: sAfter, primary: true };
          if (Array.isArray(el.surname_list)) e.add(`e:${id}:surname`, "last name", { op: "add", obj: key, path: `${base}/surname_list`, value: sel });
          else e.add(`e:${id}:surname`, "last name", { op: "set", obj: key, path: `${base}/surname_list`, base: null, value: [sel] });
        }
      }
      if (str(v.type) && str(v.type) !== typeCode(el.type)) e.add(`e:${id}:type`, "kind of name", { op: "set", obj: key, path: `${base}/type`, base: baseOf(el.type), value: typeObject("NameType", v.type) });
    }
    for (const a of d.added) {
      const v = a.values || {};
      const first = trimmed(v.first_name);
      const sur = trimmed(v.surname);
      if (!first && !sur) continue;
      const el = { _class: "Name", first_name: first, surname_list: sur ? [{ _class: "Surname", surname: sur, primary: true }] : [], type: typeObject("NameType", str(v.type) || "1") };
      e.add(`a:${a.tid}`, `add the name ${[first, sur].filter(Boolean).join(" ")}`, Array.isArray(obj2(bundle.obj, "alternate_names"))
        ? { op: "add", obj: key, path: "/alternate_names", value: el }
        : { op: "set", obj: key, path: "/alternate_names", base: null, value: [el] });
    }
    return e;
  }
};

// ---- life events ----
function eventRows(bundle, lookups) {
  const refs = list(bundle.obj && bundle.obj.event_ref_list);
  const ids = refRowIds(refs);
  const out = [];
  refs.forEach((ref, idx) => {
    if (!isObj(ref)) return;
    const rel = bundle.related && bundle.related[`Event:${ref.ref}`];
    if (!rel || !isObj(rel.obj)) return;
    const ev = rel.obj;
    const code = typeCode(ev.type);
    const type = lookups.eventTypes(code).find((o) => o.value === code);
    const birth = isBirthCode(code);
    const placeRef = str(ev.place);
    const date = isObj(ev.date) ? ev.date : null;
    const detail = [dateText(date, { birth }), lookups.placeNames.get(placeRef) || ""].filter(Boolean).join(", ");
    out.push({
      id: ids[idx], idx, ref: ref.ref, evKey: `Event:${ref.ref}`, href: drillHref("Event", ref.ref, ev), version: rel.version, ev, birth,
      title: type ? type.label : fallback("events", out.length), detail: detail || str(ev.description),
      values: { type: code, date: date ? clone(date) : emptyDate(), place: { ref: placeRef, name: "" }, description: str(ev.description) }
    });
  });
  return out;
}

const eventsAdapter = {
  id: "events",
  rows: eventRows,
  blank: () => ({ type: "", date: emptyDate(), place: { ref: "", name: "" }, description: "" }),
  schema({ lookups, values }) {
    return objectSchema({
      type: choice("kind of event", lookups.eventTypes(values && values.type)),
      date: { type: "object", title: "date", "x-io-widget": "grampsDate" },
      place: { type: "object", title: "place", "x-io-widget": "placeRef" },
      description: text("description")
    });
  },
  // The policy table cannot judge a date by its pointer (a birth's rows are conditional), so a birth date is the birth-year row and any other date
  // follows the event's own fields.
  policy: (field, v) => ["Event", field === "date" ? (isBirthCode(v && v.type) ? "/date/dateval/2" : "/description") : `/${field}`],
  ops({ key, bundle, draft, viewer, temp, section }) {
    const e = makeEmitter(section, temp);
    const d = normalizeListDraft(draft);
    const refs = list(bundle.obj && bundle.obj.event_ref_list);
    const rows = eventRows(bundle, { eventTypes: () => [], placeNames: new Map() });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const placeOps = (unit, label, place) => {
      if (isObj(place) && trimmed(place.name)) {
        const handle = temp();
        e.add(unit, label, { op: "create", obj: handle, cls: "Place", value: { _class: "Place", name: { _class: "PlaceName", value: trimmed(place.name), lang: "" }, place_type: { _class: "PlaceType", value: -1, string: "" } } });
        return handle;
      }
      return isObj(place) ? str(place.ref) : "";
    };
    for (const id of d.removed) {
      const r = byId.get(id);
      if (!r) continue;
      e.add(`r:${id}`, `remove the ${r.title}`, { op: "remove", obj: key, path: `/event_ref_list/${keySegment("event_ref_list", refs, r.idx)}`, base: clone(refs[r.idx]) });
    }
    for (const [id, v] of Object.entries(d.edits)) {
      const r = byId.get(id);
      if (!r || d.removed.includes(id)) continue;
      const ev = r.ev;
      const type = str(v.type) || r.values.type;
      const birth = isBirthCode(type);
      if (type !== r.values.type) e.add(`e:${id}:type`, "kind of event", { op: "set", obj: r.evKey, path: "/type", base: baseOf(ev.type), value: typeObject("EventType", type) });
      let date = isObj(v.date) ? v.date : emptyDate();
      // A birth keeps its year only (DEC-E4), but only a date the member changed is cut down: a birth's date left as it was (its words, a span,
      // or a day and month stored before) is never rewritten by an edit of the event's other fields. A row that becomes a birth has its date cut
      // to the year, unless it is kept as words: those are shown read-only, so changing nothing can never drop them.
      const untouched = sameDate(date, r.values.date);
      if (birth && !(untouched && (r.birth || isWordsDate(date)))) date = birthDate(date);
      const had = Object.hasOwn(ev, "date") && isObj(ev.date);
      if (!sameDate(date, had ? ev.date : emptyDate())) {
        if (!had) e.add(`e:${id}:date`, "date", { op: "set", obj: r.evKey, path: "/date", base: null, value: date });
        else if (viewer && viewer.admin) e.add(`e:${id}:date`, "date", { op: "set", obj: r.evKey, path: "/date", base: clone(ev.date), value: date });
        else {
          // A member's view of a date may lack its day and month (Q2-04b), so the base is the event's version, and only the parts the member
          // changed are replaced (`sets`): the rest is kept from the stored date.
          const a = dv(ev.date);
          const b = dv(date);
          const sets = [];
          if (b[0] !== a[0]) sets.push("day");
          if (b[1] !== a[1]) sets.push("month");
          if (date.modifier === 4 || ev.date.modifier === 4) {
            if (b[4] !== a[4]) sets.push("day2");
            if (b[5] !== a[5]) sets.push("month2");
          }
          if (str(date.text) !== str(ev.date.text)) sets.push("text");
          e.add(`e:${id}:date`, "date", { op: "set", obj: r.evKey, path: "/date", base_version: r.version, ...(sets.length ? { sets } : {}), value: date });
        }
      }
      const place = v.place;
      const placeChanged = isObj(place) && (trimmed(place.name) || str(place.ref) !== r.values.place.ref);
      if (placeChanged) {
        const handle = placeOps(`e:${id}:place`, "place", place);
        e.add(`e:${id}:place`, "place", { op: "set", obj: r.evKey, path: "/place", base: baseOf(ev.place), value: handle });
      }
      const desc = trimmed(v.description);
      if (desc !== str(ev.description).trim()) e.add(`e:${id}:description`, "description", { op: "set", obj: r.evKey, path: "/description", base: typeof ev.description === "string" ? ev.description : null, value: desc });
    }
    for (const a of d.added) {
      const v = a.values || {};
      const type = str(v.type);
      if (!type) continue;
      const unit = `a:${a.tid}`;
      const birth = isBirthCode(type);
      let date = isObj(v.date) ? v.date : emptyDate();
      if (birth) date = birthDate(date);
      const handle = placeOps(unit, "place", v.place);
      const te = temp();
      const value = { _class: "Event", type: typeObject("EventType", type) };
      if (!isEmptyDate(date)) value.date = date;
      if (handle) value.place = handle;
      if (trimmed(v.description)) value.description = trimmed(v.description);
      e.add(unit, "new event", { op: "create", obj: te, cls: "Event", value });
      const ref = { _class: "EventRef", ref: te, role: { _class: "EventRoleType", value: 1, string: "" } };
      e.add(unit, "new event", Array.isArray(bundle.obj && bundle.obj.event_ref_list) ? { op: "add", obj: key, path: "/event_ref_list", value: ref } : { op: "set", obj: key, path: "/event_ref_list", base: null, value: [ref] });
    }
    return e;
  }
};

// ---- facts (attributes) ----
function factRows(bundle, lookups) {
  const l = list(bundle.obj && bundle.obj.attribute_list);
  const out = [];
  const ids = hashRowIds(l);
  l.forEach((a, idx) => {
    if (!isObj(a)) return;
    const code = typeCode(a.type);
    if (code.startsWith("c:") && MERGED_ID.test(code.slice(2))) return; // the sync identity key: a desk-only item, never shown (editing.md 3.2)
    const type = lookups.attributeTypes(code).find((o) => o.value === code);
    out.push({ id: ids[idx], idx, title: type ? type.label : fallback("facts", out.length), detail: str(a.value), values: { type: code, value: str(a.value) } });
  });
  return out;
}

const factsAdapter = {
  id: "facts",
  rows: factRows,
  blank: () => ({ type: "", value: "" }),
  schema({ lookups, values, schemas }) {
    const at = schemas && schemas.Person && schemas.Person.$defs && schemas.Person.$defs.Attribute && schemas.Person.$defs.Attribute.properties;
    return objectSchema({
      type: choice("kind of fact", lookups.attributeTypes(values && values.type)),
      value: { ...(at && at.value ? at.value : text("what it is")), title: "what it is" }
    });
  },
  policy: (field) => ["Person", `/attribute_list/0/${field}`],
  ops({ key, bundle, draft, section }) {
    const e = makeEmitter(section);
    const d = normalizeListDraft(draft);
    const l = list(bundle.obj && bundle.obj.attribute_list);
    const rows = factRows(bundle, { attributeTypes: () => [] });
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of d.removed) {
      const r = byId.get(id);
      if (r) e.add(`r:${id}`, `remove the fact`, { op: "remove", obj: key, path: `/attribute_list/${keySegment("attribute_list", l, r.idx)}`, base: clone(l[r.idx]) });
    }
    for (const [id, v] of Object.entries(d.edits)) {
      const r = byId.get(id);
      if (!r || d.removed.includes(id)) continue;
      const el = l[r.idx];
      const base = `/attribute_list/${keySegment("attribute_list", l, r.idx)}`;
      const val = trimmed(v.value);
      if (val !== str(el.value).trim()) e.add(`e:${id}:value`, "what it is", { op: "set", obj: key, path: `${base}/value`, base: typeof el.value === "string" ? el.value : null, value: val });
      if (str(v.type) && str(v.type) !== r.values.type) e.add(`e:${id}:type`, "kind of fact", { op: "set", obj: key, path: `${base}/type`, base: baseOf(el.type), value: typeObject("AttributeType", v.type) });
    }
    for (const a of d.added) {
      const v = a.values || {};
      if (!str(v.type)) continue;
      const el = { _class: "Attribute", type: typeObject("AttributeType", v.type), value: trimmed(v.value) };
      e.add(`a:${a.tid}`, "new fact", Array.isArray(bundle.obj && bundle.obj.attribute_list) ? { op: "add", obj: key, path: "/attribute_list", value: el } : { op: "set", obj: key, path: "/attribute_list", base: null, value: [el] });
    }
    return e;
  }
};

// ---- notes ----
const preview = (s) => { const t = str(s).replace(/\s+/g, " ").trim(); return t.length > 80 ? `${t.slice(0, 77)}...` : t; };

function noteRows(bundle) {
  const l = list(bundle.obj && bundle.obj.note_list);
  const out = [];
  l.forEach((h, idx) => {
    if (typeof h !== "string") return;
    const rel = bundle.related && bundle.related[`Note:${h}`];
    if (!rel || !isObj(rel.obj)) return;
    const text = str(isObj(rel.obj.text) ? rel.obj.text.string : "");
    out.push({ id: h, idx, noteKey: `Note:${h}`, href: drillHref("Note", h, rel.obj), note: rel.obj, title: preview(text) || fallback("notes", out.length), detail: "", values: { text } });
  });
  return out;
}

const NOTE_GENERAL = 1;
const notesAdapter = {
  id: "notes",
  rows: noteRows,
  blank: () => ({ text: "" }),
  schema: () => objectSchema({ text: { type: "string", title: "note", maxLength: 10000, "x-io-widget": "textarea" } }),
  policy: () => ["Note", "/text"],
  ops({ key, bundle, draft, section, temp }) {
    const e = makeEmitter(section, temp);
    const d = normalizeListDraft(draft);
    const l = list(bundle.obj && bundle.obj.note_list);
    const rows = noteRows(bundle);
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of d.removed) {
      const r = byId.get(id);
      if (r) e.add(`r:${id}`, "remove the note", { op: "remove", obj: key, path: `/note_list/${keySegment("note_list", l, r.idx)}`, base: id });
    }
    for (const [id, v] of Object.entries(d.edits)) {
      const r = byId.get(id);
      if (!r || d.removed.includes(id)) continue;
      const next = typeof v.text === "string" ? v.text.replace(/^\s+|\s+$/g, "") : "";
      const before = str(isObj(r.note.text) ? r.note.text.string : "");
      if (next === before.replace(/^\s+|\s+$/g, "")) continue;
      e.add(`e:${id}:text`, "note", { op: "set", obj: r.noteKey, path: "/text", base: baseOf(r.note.text), value: restyleText(r.note.text, next) });
    }
    for (const a of d.added) {
      const next = typeof (a.values && a.values.text) === "string" ? a.values.text.replace(/^\s+|\s+$/g, "") : "";
      if (!next) continue;
      const unit = `a:${a.tid}`;
      const tn = temp();
      e.add(unit, "new note", { op: "create", obj: tn, cls: "Note", value: { _class: "Note", type: { _class: "NoteType", value: NOTE_GENERAL, string: "" }, format: 0, text: { _class: "StyledText", string: next, tags: [] } } });
      e.add(unit, "new note", Array.isArray(bundle.obj && bundle.obj.note_list) ? { op: "add", obj: key, path: "/note_list", value: tn } : { op: "set", obj: key, path: "/note_list", base: null, value: [tn] });
    }
    return e;
  }
};

// ---- photos: order and the main photo ----
function photoRows(bundle) {
  const l = list(bundle.obj && bundle.obj.media_list);
  const ids = refRowIds(l);
  return l.map((m, idx) => {
    const rel = isObj(m) && bundle.related ? bundle.related[`Media:${m.ref}`] : null;
    const desc = rel && isObj(rel.obj) ? str(rel.obj.desc) : "";
    return { id: ids[idx], idx, title: desc || fallback("photos", idx), detail: "", values: {} };
  });
}

/** The order a photo list ends in: the draft's `order` kept to the rows that exist, then any row it does not name, in place. */
export function photoOrder(rows, draft) {
  const d = normalizeListDraft(draft);
  const have = rows.map((r) => r.id);
  if (!d.order) return have;
  const named = d.order.filter((id) => have.includes(id));
  return [...named, ...have.filter((id) => !named.includes(id))];
}

const photosAdapter = {
  id: "photos",
  rows: photoRows,
  blank: () => ({}),
  schema: () => objectSchema({}),
  policy: () => ["Person", "/media_list/0"],
  ops({ key, bundle, draft, section }) {
    const e = makeEmitter(section);
    const d = normalizeListDraft(draft);
    const l = list(bundle.obj && bundle.obj.media_list);
    const rows = photoRows(bundle);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const segOf = (id) => keySegment("media_list", l, byId.get(id).idx);
    const gone = new Set(d.removed.filter((id) => byId.has(id)));
    // The wanted order of the rows that stay, then the moves that get the record there: each row out of place goes before the row now in its place.
    const want = photoOrder(rows, draft).filter((id) => !gone.has(id));
    const cur = rows.map((r) => r.id).filter((id) => !gone.has(id));
    for (let i = 0; i < want.length; i += 1) {
      if (cur[i] === want[i]) continue;
      const from = cur.indexOf(want[i]);
      cur.splice(from, 1);
      const anchor = cur[i];
      cur.splice(i, 0, want[i]);
      const label = i === 0 ? "make a photo the main photo" : "move a photo";
      e.add(`o:${want[i]}`, label, { op: "move", obj: key, path: `/media_list/${segOf(want[i])}`, ...(anchor !== undefined ? { before: segOf(anchor) } : {}) });
    }
    for (const id of gone) e.add(`r:${id}`, "remove the photo", { op: "remove", obj: key, path: `/media_list/${segOf(id)}`, base: clone(l[byId.get(id).idx]) });
    return e;
  }
};

// ---- people connected to you (associations) ----
function connectedRows(bundle, lookups) {
  const l = list(bundle.obj && bundle.obj.person_ref_list);
  const ids = refRowIds(l);
  return l.map((p, idx) => {
    const name = isObj(p) ? lookups.people.get(p.ref) || "" : "";
    return { id: ids[idx], idx, title: name || fallback("connected", idx), detail: isObj(p) ? str(p.rel) : "", values: { rel: isObj(p) ? str(p.rel) : "" } };
  });
}

const connectedAdapter = {
  id: "connected",
  rows: connectedRows,
  blank: () => ({ person: null, rel: "" }),
  schema({ isNew, schemas }) {
    const pr = schemas && schemas.Person && schemas.Person.$defs && schemas.Person.$defs.PersonRef && schemas.Person.$defs.PersonRef.properties;
    const rel = { ...(pr && pr.rel ? pr.rel : text("how they're connected")), title: "how they're connected to you" };
    return objectSchema(isNew ? { person: { type: "object", title: "who", "x-io-widget": "personRef" }, rel } : { rel });
  },
  policy: (field) => ["Person", `/person_ref_list/0/${field === "person" ? "ref" : field}`],
  ops({ key, bundle, draft, section }) {
    const e = makeEmitter(section);
    const d = normalizeListDraft(draft);
    const l = list(bundle.obj && bundle.obj.person_ref_list);
    const rows = connectedRows(bundle, { people: new Map() });
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of d.removed) {
      const r = byId.get(id);
      if (r) e.add(`r:${id}`, "remove the connection", { op: "remove", obj: key, path: `/person_ref_list/${keySegment("person_ref_list", l, r.idx)}`, base: clone(l[r.idx]) });
    }
    for (const [id, v] of Object.entries(d.edits)) {
      const r = byId.get(id);
      if (!r || d.removed.includes(id)) continue;
      const el = l[r.idx];
      const rel = trimmed(v.rel);
      if (rel !== str(el.rel).trim()) e.add(`e:${id}:rel`, "how they're connected", { op: "set", obj: key, path: `/person_ref_list/${keySegment("person_ref_list", l, r.idx)}/rel`, base: typeof el.rel === "string" ? el.rel : null, value: rel });
    }
    for (const a of d.added) {
      const v = a.values || {};
      const handle = isObj(v.person) ? str(v.person.handle) : "";
      if (!handle) continue; // a person nobody picked from the list is never sent (free text is not allowed)
      const el = { _class: "PersonRef", ref: handle, rel: trimmed(v.rel) };
      e.add(`a:${a.tid}`, "new connection", Array.isArray(bundle.obj && bundle.obj.person_ref_list) ? { op: "add", obj: key, path: "/person_ref_list", value: el } : { op: "set", obj: key, path: "/person_ref_list", base: null, value: [el] });
    }
    return e;
  }
};

// ---- sources (citations) ----
function sourceRows(bundle, lookups) {
  const l = list(bundle.obj && bundle.obj.citation_list);
  const out = [];
  l.forEach((h, idx) => {
    if (typeof h !== "string") return;
    const rel = bundle.related && bundle.related[`Citation:${h}`];
    if (!rel || !isObj(rel.obj)) return;
    const c = rel.obj;
    const title = lookups.sourceTitles.get(str(c.source_handle)) || "";
    out.push({
      id: h, idx, citKey: `Citation:${h}`, href: drillHref("Citation", h, c), cit: c, title: title || fallback("sources", out.length), detail: str(c.page),
      values: { source: { ref: str(c.source_handle), name: "" }, page: str(c.page), confidence: Number.isInteger(c.confidence) ? String(c.confidence) : "2" }
    });
  });
  return out;
}

const sourcesAdapter = {
  id: "sources",
  rows: sourceRows,
  blank: () => ({ source: { ref: "", name: "" }, page: "", confidence: "2" }),
  schema({ lookups, isNew, schemas }) {
    const cp = schemas && schemas.Citation && schemas.Citation.properties;
    const page = { ...(cp && cp.page ? cp.page : text("page or place in the source")), title: "page or place in the source" };
    const props = { ...(isNew ? { source: { type: "object", title: "source", "x-io-widget": "sourceRef" } } : {}), page, confidence: choice("how sure", lookups.confidence()) };
    return objectSchema(props);
  },
  policy: (field) => (field === "source" ? ["Person", "/citation_list/0"] : ["Citation", `/${field}`]),
  ops({ key, bundle, draft, section, temp }) {
    const e = makeEmitter(section, temp);
    const d = normalizeListDraft(draft);
    const l = list(bundle.obj && bundle.obj.citation_list);
    const rows = sourceRows(bundle, { sourceTitles: new Map() });
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of d.removed) {
      const r = byId.get(id);
      if (r) e.add(`r:${id}`, "remove the source", { op: "remove", obj: key, path: `/citation_list/${keySegment("citation_list", l, r.idx)}`, base: id });
    }
    for (const [id, v] of Object.entries(d.edits)) {
      const r = byId.get(id);
      if (!r || d.removed.includes(id)) continue;
      const page = trimmed(v.page);
      if (page !== str(r.cit.page).trim()) e.add(`e:${id}:page`, "page or place in the source", { op: "set", obj: r.citKey, path: "/page", base: typeof r.cit.page === "string" ? r.cit.page : null, value: page });
      const conf = str(v.confidence);
      // A citation with no stored confidence shows the default; leaving it at the default is not a change.
      const unchanged = Number.isInteger(r.cit.confidence) ? Number(conf) === r.cit.confidence : conf === "2";
      if (conf !== "" && !unchanged) e.add(`e:${id}:confidence`, "how sure", { op: "set", obj: r.citKey, path: "/confidence", base: Number.isInteger(r.cit.confidence) ? r.cit.confidence : null, value: Number(conf) });
    }
    for (const a of d.added) {
      const v = a.values || {};
      const unit = `a:${a.tid}`;
      let source = isObj(v.source) ? str(v.source.ref) : "";
      if (isObj(v.source) && trimmed(v.source.name)) {
        source = temp();
        e.add(unit, "new source", { op: "create", obj: source, cls: "Source", value: { _class: "Source", title: trimmed(v.source.name) } });
      }
      if (!source) continue;
      const tc = temp();
      const value = { _class: "Citation", source_handle: source, page: trimmed(v.page) };
      if (str(v.confidence) !== "") value.confidence = Number(v.confidence);
      e.add(unit, "new source", { op: "create", obj: tc, cls: "Citation", value });
      e.add(unit, "new source", Array.isArray(bundle.obj && bundle.obj.citation_list) ? { op: "add", obj: key, path: "/citation_list", value: tc } : { op: "set", obj: key, path: "/citation_list", base: null, value: [tc] });
    }
    return e;
  }
};

export const LIST_ADAPTERS = Object.freeze({
  alt: altName,
  events: eventsAdapter,
  facts: factsAdapter,
  notes: notesAdapter,
  photos: photosAdapter,
  connected: connectedAdapter,
  sources: sourcesAdapter
});

/**
 * Every section's ops for the member's drafts. `sections` is the registry (editor-model.js); a section with `form` is the names form, with
 * `lists` the list adapters it holds. -> { ops, labels, units } where `units` maps an op id to its change, `<section>/<unit>`.
 * `temp()` numbers the new objects of the whole submission (`new:1`, `new:2`, ...), in section order, so the ids are the same on every build.
 */
export function sectionOps({ key, bundle, sections, drafts, viewer }) {
  let n = 0;
  const temp = () => `new:${++n}`;
  const out = { ops: [], labels: {}, units: {} };
  const take = (r) => { out.ops.push(...r.ops); Object.assign(out.labels, r.labels); Object.assign(out.units, r.units); };
  for (const s of sections) {
    if (s.form && isObj(drafts && drafts[s.id])) take(s.form.names ? namesOps({ key, obj: bundle.obj, draft: drafts[s.id], section: s.id }) : formOps({ key, obj: bundle.obj, section: s, draft: drafts[s.id] }));
    for (const id of s.lists || []) {
      const draft = drafts ? drafts[draftKey(s.id, id)] : undefined;
      if (draft === undefined || listDraftIsEmpty(draft)) continue;
      take(LIST_ADAPTERS[id].ops({ key, bundle, draft, viewer: viewer || {}, temp, section: opSection(s.id, id) }));
    }
  }
  return out;
}

/** The key a section's list draft is stored under (the names section keeps its form under `names` and the also-known-as list under `names:alt`). */
export const draftKey = (sectionId, listId) => (listId === sectionId ? sectionId : `${sectionId}:${listId}`);
/** The prefix of the op ids (and units) of a section's list. */
export const opSection = draftKey;

/**
 * The drafts after the record changed under them (a 409 or a save): per list, the changes still meaningful against `fresh`, minus the units
 * already stored (`settled`, a set of `<section>/<unit>` strings). An edit stays only for a row that still exists and only for fields that still
 * differ; a removal only for a row that still exists; an addition always (unless it was saved).
 */
export function replayListDraft({ adapter, draft, fresh, lookups, settled = new Set(), section }) {
  const d = normalizeListDraft(draft);
  const rows = adapter.rows(fresh, lookups);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out = emptyList();
  for (const [id, v] of Object.entries(d.edits)) {
    const r = byId.get(id);
    if (!r) continue;
    const kept = {};
    for (const [f, val] of Object.entries(v)) {
      if (settled.has(`${section}/e:${id}:${f}`)) continue;
      if (!sameValue(val, r.values[f])) kept[f] = val;
    }
    if (Object.keys(kept).length) out.edits[id] = { ...r.values, ...kept };
  }
  out.removed = d.removed.filter((id) => byId.has(id) && !settled.has(`${section}/r:${id}`));
  out.added = d.added.filter((a) => !settled.has(`${section}/a:${a.tid}`));
  if (d.order) {
    const order = photoOrder(rows, d);
    // Kept unless it is already the fresh order, or every move it still needs went in with the save (a move to review leaves the order
    // as it was, so without this the same moves would be built again). The moves are the `o:<rowId>` units of the photo adapter.
    let done = sameValue(order, rows.map((r) => r.id));
    if (!done && settled.size) {
      const need = Object.values(adapter.ops({ key: "", bundle: fresh, draft: { order }, section }).units).filter((u) => u.startsWith(`${section}/o:`));
      done = need.length > 0 && need.every((u) => settled.has(u));
    }
    out.order = done ? null : order;
  }
  return out;
}

// ---- what the bar and the chip say ---------------------------------------------------------------------------------------------------------

export { pendingChip } from "./editor-pending.js";
