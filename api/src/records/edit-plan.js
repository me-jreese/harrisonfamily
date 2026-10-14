// Partition of a submission into direct and review groups, and the plain-language summaries (HFY-TSK-233, edit-field-policy;
// editing design 3.3 "Partition rule (DEC-E6)", 7.3 dry run, 8.3 plain words). Pure: it takes the classes from field-policy.js.
//
//   const classes = await classifyOps(ops, ctx);
//   const plan = planOps(ops, classes, { objects });   // { direct: [{opIds, summary[]}], review: [...], refused: [{opIds, code, summary[]}] }
//
// A group is dependency-closed: ops that share a new:n object, or both sides of one family link, are one group. A group commits now
// only if every op in it is direct; a group with any proposal op is one review group; a group with an op that no web path may
// apply (admin-only, desktop-only, derived or never) is refused as a whole. POST /api/changes (records/changes.js,
// HFY-TSK-183) is its caller.
import { readFileSync as readFile } from "node:fs";
import { parsePath } from "./ops.js";
import { isRefusal, stricter } from "./field-policy.js";

const BIRTH = 12; // EventType Birth
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const TEMP = /^new:\d+$/;

// ---------------------------------------------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------------------------------------------

function makeUnion(n) {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  return { find, join: (a, b) => { parent[find(a)] = find(b); } };
}

// Temp handles in reference positions only: a `ref` or `place` field, a `*_handle` field, or an element of a handle list. Free text
// (a note, a nickname) that happens to read "new:1" ties nothing together. `key` is the field the value sits in.
const HANDLE_LISTS = new Set(["family_list", "parent_family_list", "note_list", "citation_list", "tag_list"]);
const refKey = (key) => typeof key === "string" && (key === "ref" || key === "place" || key.endsWith("_handle") || HANDLE_LISTS.has(key));
function temps(v, out = new Set(), key = null) {
  if (typeof v === "string") { if (TEMP.test(v) && refKey(key)) out.add(v); }
  else if (Array.isArray(v)) v.forEach((x) => temps(x, out, key));
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) temps(x, out, k);
  return out;
}
// The field an op path ends in (its last property name), for a bare value.
function lastProp(path) {
  try {
    const props = parsePath(path).filter((s) => s.t === "prop");
    return props.length ? props[props.length - 1].name : null;
  } catch { return null; }
}

function pathTemps(path, out) {
  if (typeof path !== "string") return;
  for (const m of path.matchAll(/new:\d+/g)) out.add(m[0]);
}

// The (person, family) pairs an op links, as "person|family" strings. Both sides of a link give the same string.
function linkPairs(op) {
  const out = new Set();
  if (!isObj(op) || typeof op.obj !== "string" || typeof op.path !== "string") return out;
  let segs;
  try { segs = parsePath(op.path); } catch { return out; }
  const [cls, handle] = [op.obj.slice(0, op.obj.indexOf(":")), op.obj.slice(op.obj.indexOf(":") + 1)];
  const first = segs[0]?.t === "prop" ? segs[0].name : null;
  const elem = (v) => (typeof v === "string" ? v : isObj(v) && typeof v.ref === "string" ? v.ref : null);
  const keyOf = () => { const s = segs[1]; return s?.t === "item" ? s.value : s?.t === "ref" ? s.ref : null; };
  if (cls === "Person" && (first === "family_list" || first === "parent_family_list")) {
    const f = op.op === "add" ? elem(op.value) : keyOf();
    if (f) out.add(`${handle}|${f}`);
  } else if (cls === "Family" && (first === "father_handle" || first === "mother_handle")) {
    for (const p of [op.value, op.base]) if (typeof p === "string" && p) out.add(`${p}|${handle}`);
  } else if (cls === "Family" && first === "child_ref_list") {
    const p = op.op === "add" ? elem(op.value) : keyOf();
    if (p) out.add(`${p}|${handle}`);
  }
  return out;
}

/** Partition op indexes into dependency-closed groups: [[0, 2], [1], ...], in order of first op. */
export function groupOps(ops) {
  const u = makeUnion(ops.length);
  const owner = new Map(); // token -> first op index that carries it
  const tie = (token, i) => (owner.has(token) ? u.join(i, owner.get(token)) : owner.set(token, i));
  ops.forEach((op, i) => {
    if (!isObj(op)) return;
    const t = new Set();
    if (typeof op.obj === "string" && TEMP.test(op.obj)) t.add(op.obj);
    pathTemps(op.path, t);
    pathTemps(typeof op.before === "string" ? op.before : "", t);
    const field = lastProp(op.path);
    temps(op.value, t, field);
    temps(op.base, t, field);
    for (const x of t) tie(`temp:${x}`, i);
    for (const p of linkPairs(op)) tie(`link:${p}`, i);
  });
  const groups = new Map();
  ops.forEach((_, i) => {
    const r = u.find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  });
  return [...groups.values()].sort((a, b) => a[0] - b[0]);
}

/** Split classified ops into direct, review and refused groups. classes: the output of classifyOps, in op order. */
export function partitionOps(ops, classes) {
  const out = { direct: [], review: [], refused: [] };
  for (const idxs of groupOps(ops)) {
    let code = "direct";
    for (const i of idxs) code = stricter(code, classes[i]?.code ?? "proposal");
    const g = { indexes: idxs, opIds: idxs.map((i) => classes[i]?.id ?? ops[i]?.id ?? `#${i}`), code };
    if (isRefusal(code)) out.refused.push(g);
    else if (code === "proposal") out.review.push(g);
    else out.direct.push(g);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Summaries: plain language, no Gramps jargon
// ---------------------------------------------------------------------------------------------------------------

const CLASS_WORD = { Person: "person", Family: "family", Event: "event", Place: "place", Source: "source", Citation: "source citation", Repository: "repository", Media: "photo or file", Note: "note" };
const FIELD_WORD = {
  first_name: "given names", surname: "last name", surname_list: "last names", title: "title", suffix: "suffix", call: "the name used day to day", nick: "nickname",
  famnick: "family nickname", type: "type", date: "date", gender: "gender", description: "description", place: "place", text: "text", format: "text style",
  name: "name", value: "value", page: "page", confidence: "confidence", desc: "description", path: "file", lat: "latitude", long: "longitude", code: "place code",
  place_type: "place type", author: "author", pubinfo: "publication details", abbrev: "short title", role: "role", rel: "relationship", complete: "completeness",
  prefix: "name prefix", connector: "name connector", origintype: "where the name comes from", lang: "language", dateval: "date", dayval: "date", quality: "date certainty",
  modifier: "date wording", calendar: "calendar", frel: "relationship to the father", mrel: "relationship to the mother",
};
const LIST_WORD = {
  alternate_names: "another name", event_ref_list: "an event", note_list: "a note", citation_list: "a source citation", media_list: "a photo", urls: "a link",
  attribute_list: "a fact", person_ref_list: "an association", family_list: "a spouse or child connection", parent_family_list: "a parent connection",
  child_ref_list: "a child", tag_list: "a tag", surname_list: "a last name", alt_names: "another name for the place", reporef_list: "a repository", placeref_list: "a larger place",
};
const GENDER = { 0: "female", 1: "male", 2: "unknown", 3: "other" };
const MONTH = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const words = (s) => String(s).replace(/_/g, " ");
const clip = (s, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const q = (s) => `“${clip(s)}”`;

// The plain title of a typed enum from the generated record schemas (EventType 12 -> "Birth"); null when the table is not found.
let titles = null;
function enumTitle(cls, value) {
  titles ??= loadTitles();
  return titles.get(`${cls}:${value}`) ?? null;
}
function loadTitles() {
  const m = new Map();
  try {
    const dir = new URL("./schemas/", import.meta.url);
    for (const c of ["Person", "Family", "Event", "Place", "Source", "Citation", "Repository", "Media", "Note"]) {
      const s = JSON.parse(readFile(new URL(`${c}.schema.json`, dir)));
      for (const [name, def] of Object.entries(s.$defs ?? {})) {
        for (const one of def.oneOf ?? []) {
          const v = one.properties?.value?.const;
          if (v !== undefined && typeof one.title === "string") m.set(`${name}:${v}`, one.title);
        }
      }
    }
  } catch { /* titles are a nicety: without them the summary names the field only */ }
  return m;
}

function dateWords(d, yearOnly = false) {
  if (!isObj(d)) return null;
  const dv = Array.isArray(d.dateval) ? d.dateval : [];
  const [day, month, year] = dv;
  if (yearOnly) return year ? String(year) : null;
  if (year) {
    if (day && month) return `${day} ${MONTH[month] ?? month} ${year}`;
    if (month) return `${MONTH[month] ?? month} ${year}`;
    return String(year);
  }
  return typeof d.text === "string" && d.text ? d.text : null;
}

/** A value as words, or null when it has no short plain form. */
function valueWords(v, field, yearOnly = false) {
  if (v === undefined || v === null || v === "") return null;
  if (field === "gender" && typeof v === "number") return GENDER[v] ? q(GENDER[v]) : null;
  if (typeof v === "string") return q(v);
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (isObj(v) && typeof v._class === "string") {
    if (v._class === "Date") return dateWords(v, yearOnly);
    if (v._class.endsWith("Type")) {
      const t = (typeof v.string === "string" && v.string) || enumTitle(v._class, v.value);
      return t ? q(t) : null;
    }
    if (v._class === "Name") return nameWords(v);
  }
  return null;
}
function nameWords(n) {
  const first = typeof n.first_name === "string" ? n.first_name : "";
  const last = Array.isArray(n.surname_list) ? n.surname_list.map((s) => s?.surname).filter(Boolean)[0] ?? "" : "";
  const full = [first, last].filter(Boolean).join(" ");
  return full ? q(full) : null;
}

function describeField(segs, cls) {
  const props = segs.filter((s) => s.t === "prop").map((s) => s.name);
  const last = props[props.length - 1];
  const list = props.slice(0, -1).reverse().find((p) => LIST_WORD[p]);
  let word = FIELD_WORD[last] ?? words(last ?? CLASS_WORD[cls] ?? "details");
  if (last === "type") word = props.length > 1 && props[props.length - 2] === "primary_name" ? "name type" : cls === "Event" && props.length === 1 ? "event type" : props.length > 1 ? `${words(props[props.length - 2])} type` : "type";
  if (props[0] === "primary_name" || (last && props.includes("primary_name"))) return word;
  if (list && list !== last) return `${word} for ${LIST_WORD[list]}`;
  return word;
}

/** One sentence for one op. `ops` and `objects` give context for new objects. */
export function summarizeOp(op, { objects = {} } = {}) {
  if (!isObj(op) || typeof op.obj !== "string") return "make a change";
  const cls = TEMP.test(op.obj) ? op.cls : op.obj.slice(0, op.obj.indexOf(":"));
  const what = CLASS_WORD[cls] ?? "record";
  if (op.op === "create") {
    const nm = cls === "Person" && isObj(op.value?.primary_name) ? nameWords(op.value.primary_name) : null;
    return `add a new ${what}${nm ? ` ${nm}` : ""}`;
  }
  if (op.op === "delete") return `remove ${/^[aeiou]/.test(what) ? "an" : "a"} ${what}`;
  let segs;
  try { segs = parsePath(op.path ?? ""); } catch { return "make a change"; }
  const props = segs.filter((s) => s.t === "prop").map((s) => s.name);
  const last = props[props.length - 1];
  // A birth event's day and month never reach a summary: its date is shown as a year, and a day or month edit is named generally.
  const ev = cls === "Event" ? (TEMP.test(op.obj) ? null : objects[op.obj]) : null;
  const yearOnly = cls === "Event" && (ev?.type?.value === BIRTH || (op.op === "create" && op.value?.type?.value === BIRTH));
  if (yearOnly && props.includes("dateval") && segs.some((s) => s.t === "index" && s.i !== 2)) return "change the date";
  const elementEdit = op.op === "add" || segs[segs.length - 1]?.t !== "prop" ? LIST_WORD[op.op === "add" ? last : props[props.length - 1]] : null;
  if (op.op === "add") {
    const lw = LIST_WORD[last] ?? `an item to ${words(last)}`;
    const detail = isObj(op.value) ? valueWords(op.value, last) : null;
    return `add ${lw}${detail ? ` ${detail}` : ""}`;
  }
  if (op.op === "remove") return `remove ${elementEdit ?? LIST_WORD[last] ?? `an item from ${words(last)}`}`;
  if (op.op === "move") return `reorder ${LIST_WORD[last] ?? words(last)}`;
  if (last === "father_handle" || last === "mother_handle") return "change a parent";
  const field = describeField(segs, cls);
  const to = valueWords(op.value, last, yearOnly);
  const from = valueWords(op.base, last, yearOnly);
  if (op.value === "" || op.value === null) return from ? `clear the ${field} (was ${from})` : `clear the ${field}`;
  if (to && from) return `change the ${field} from ${from} to ${to}`;
  if (to) return `set the ${field} to ${to}`;
  return `change the ${field}`;
}

/** A group's summary: [{ text, opIds }], one sentence per op. */
export function summarizeGroup(ops, group, opts = {}) {
  return group.indexes.map((i) => ({ text: summarizeOp(ops[i], opts), opIds: [group.opIds[group.indexes.indexOf(i)]] }));
}

/** The dry-run plan of editing design 7.3: { direct: [{opIds, summary[]}], review: [{opIds, summary[]}], refused: [{opIds, code, summary[]}] }. */
export function planOps(ops, classes, opts = {}) {
  const p = partitionOps(ops, classes);
  const shape = (g, extra = {}) => ({ opIds: g.opIds, summary: summarizeGroup(ops, g, opts), ...extra });
  return { direct: p.direct.map((g) => shape(g)), review: p.review.map((g) => shape(g)), refused: p.refused.map((g) => shape(g, { code: g.code })) };
}

/** Words that must never reach a member's screen. */
export const JARGON = /\b(ChildRef|EventRef|MediaRef|PersonRef|frel|mrel|handle|gramps_id|new:\d+|_class|birth_ref_index|death_ref_index)\b|@(ref|k)?=/i;
