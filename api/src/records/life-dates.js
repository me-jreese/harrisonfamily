// POST /api/life-dates (HFY-TSK-387-0F, HFY-PLN-004 L1; BRD D-17..D-28, rulings P4-R18, P4-R20, P4-R24).
//
// The simplified Life dates input {birth: {year, about}, death: {year, about} | {unknown: true}} on one Person, compiled server-side into the
// EditOps of an ordinary suggestion. The member never sees a Gramps word; an approved suggestion leaves standard Birth and Death events:
//   - the date is a year only (day and month are never sent or stored); 'about' is quality "estimated" (D-22), modifier regular;
//   - the EventRef role is Primary, so birth_ref_index and death_ref_index derive as for any desk-entered event (HFY-TSK-249);
//   - every written year carries one Citation on the single Source SOURCE_TITLE (reused when it exists, created in the same suggestion if not);
//   - 'died, year unknown' is a Death event with an empty date and the Citation (D-22).
// Guards: an existing primary Birth or Death event is updated in place, never doubled (D-23); a date on file that is more than a plain year
// (a day or month, a range, a text date, another calendar) is never overwritten and answers `precise_on_file`; years run 1600..current year,
// died >= born, and a lifespan over 120 years answers `confirm_needed` until the request is resent with confirm=true (D-25).
// Both rows are always suggestions, an admin's own included (D-24, P4-R24): the compiled submission takes route "review". A suggestion that adds a
// Death event carries `intent.marks_deceased: true`, the marker the review screen reads for "this will mark them as deceased" (D-19).
//
// The pipeline is the one of POST /api/changes (planChanges, commit), as admin-delete.js uses it, so the field policy, the R-18/R-19 guard, the
// Gramps semantics and schema, the rate limit and the idempotency receipt all apply unchanged.
import { problem, planChanges, commit, headerOf, readIdem, replayOf, requestHashOf } from "./changes.js";
import { editingOn } from "./edit-bundle.js";
import { get, backrefs, storeView } from "./index.js";
import { createRecordGuard } from "./guard.js";
import { viewRecord } from "./read.js";
import { EVENT_TYPE, MODIFIER, ROLE_PRIMARY, birthDeathIndex, computeSortval } from "./semantics.js";
import { HttpError, json } from "../http.js";

/** The one Source every member-entered life date cites (D-24). Reused by title when it exists. */
export const SOURCE_TITLE = "harrisonfamily.us member contributions";
export const MIN_YEAR = 1600;
export const LONG_LIFE_YEARS = 120;
const HANDLE_RE = /^[A-Za-z0-9_-]{1,64}$/;
const IDEM_KEY_RE = /^[\x21-\x7e]{1,128}$/;
const TOP_FIELDS = new Set(["target", "base_versions", "birth", "death", "confirm", "dry_run", "idempotency_key"]);
const ESTIMATED = 1;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const isInt = (v) => Number.isInteger(v);
const typed = (cls, value) => ({ _class: cls, string: "", value });

// ---- dates ---------------------------------------------------------------------------------------------------------------
const blankDate = () => ({ _class: "Date", calendar: 0, dateval: [0, 0, 0, false], format: null, modifier: MODIFIER.NONE, newyear: 0, quality: 0, sortval: 0, text: "" });
export function yearDate(year, about = false) {
  const d = { ...blankDate(), dateval: [0, 0, year, false], quality: about ? ESTIMATED : 0 };
  d.sortval = computeSortval(d);
  return d;
}

/**
 * What a stored Event date is, for D-23: { kind: "empty" } | { kind: "year", year, about } (a plain Gregorian year, nothing else: safe to update) |
 * { kind: "precise", year } (anything more: a day or month, a range or span, before/after, a text date, another calendar). Only the year is ever returned.
 */
export function classifyDate(d) {
  if (!isObj(d)) return { kind: "empty" };
  const dv = arr(d.dateval);
  const year = isInt(dv[2]) && dv[2] > 0 ? dv[2] : 0;
  const compound = d.modifier === MODIFIER.RANGE || d.modifier === MODIFIER.SPAN || dv.slice(4, 7).some((x) => isInt(x) && x !== 0);
  const text = typeof d.text === "string" && d.text.trim() !== "";
  if (!year && !dv[0] && !dv[1] && !compound && !text) return { kind: "empty" };
  const plain = year > 0 && !dv[0] && !dv[1] && !compound && (d.modifier === MODIFIER.NONE || d.modifier === MODIFIER.ABOUT) && !d.calendar;
  if (plain) return { kind: "year", year, about: d.quality === ESTIMATED || d.modifier === MODIFIER.ABOUT };
  return { kind: "precise", year };
}

// ---- the request ---------------------------------------------------------------------------------------------------------
function parseRequest(c, nowYear) {
  const b = c.body;
  const errors = [];
  const bad = (pointer, code, detail) => errors.push({ pointer, code, detail });
  if (!isObj(b)) throw problem(400, "validation", "the request is not valid", { errors: [{ pointer: "", code: "shape", detail: "send a JSON object" }] });
  for (const k of Object.keys(b)) if (!TOP_FIELDS.has(k)) bad(`/${k}`, "unknown_field", "not a field of this request");
  const m = typeof b.target === "string" ? /^Person:([A-Za-z0-9_-]{1,64})$/.exec(b.target) : null;
  if (!m) bad("/target", "target", "target must look like Person:<handle>");
  if (b.base_versions !== undefined && !(isObj(b.base_versions) && Object.values(b.base_versions).every((v) => isInt(v) && v >= 1))) bad("/base_versions", "base_versions", "base_versions maps Class:handle to a version");
  for (const k of ["confirm", "dry_run"]) if (b[k] !== undefined && typeof b[k] !== "boolean") bad(`/${k}`, "boolean", `${k} is true or false`);
  const year = (row, at) => {
    if (!isInt(row.year)) bad(`${at}/year`, "year", "the year is a whole number");
    else if (row.year < MIN_YEAR || row.year > nowYear) bad(`${at}/year`, "year_range", `the year is ${MIN_YEAR} to ${nowYear}`);
  };
  const row = (name, allowed) => {
    const r = b[name];
    if (r === undefined) return null;
    const at = `/${name}`;
    if (!isObj(r)) { bad(at, "shape", `${name} is an object`); return null; }
    for (const k of Object.keys(r)) if (!allowed.includes(k)) bad(`${at}/${k}`, "unknown_field", "only a year is taken; no day, month or other field");
    if (r.about !== undefined && typeof r.about !== "boolean") bad(`${at}/about`, "boolean", "about is true or false");
    if (r.unknown !== undefined && r.unknown !== true) bad(`${at}/unknown`, "unknown", "unknown is true, or left out");
    if (r.unknown === true) {
      if (r.year !== undefined || r.about !== undefined) bad(at, "unknown", "year unknown takes no year and no about");
      return { unknown: true };
    }
    year(r, at);
    return { year: r.year, about: r.about === true };
  };
  const birth = row("birth", ["year", "about"]);
  const death = row("death", ["year", "about", "unknown"]);
  if (b.birth === undefined && b.death === undefined) bad("", "empty", "send a birth or a death");
  if (!errors.length && birth && death && !death.unknown && death.year < birth.year) bad("/death/year", "death_before_birth", "the death year is before the birth year");
  if (errors.length) throw problem(400, "validation", "the request is not valid", { errors });
  const dry = b.dry_run === true;
  let key = headerOf(c.event?.headers, "idempotency-key") ?? b.idempotency_key;
  if (key !== undefined && !(typeof key === "string" && IDEM_KEY_RE.test(key))) throw problem(400, "validation", "the request is not valid", { errors: [{ pointer: "/headers/idempotency-key", code: "idempotency_key", detail: "the Idempotency-Key is 1 to 128 visible characters" }] });
  if (!dry && key === undefined) throw problem(400, "validation", "an Idempotency-Key is required", { errors: [{ pointer: "/headers/idempotency-key", code: "idempotency_key", detail: "an Idempotency-Key header is required" }] });
  if (dry) key = undefined;
  return { handle: m[1], birth, death, confirm: b.confirm === true, base_versions: b.base_versions ?? {}, dry_run: dry, key };
}

// ---- the compile ---------------------------------------------------------------------------------------------------------
async function loadPerson(c, handle) {
  const ctx = c.store;
  const head = await get(ctx, "Person", handle);
  if (!head) throw new HttpError(404, "not_found", "no such record");
  const gid = typeof head.obj.gramps_id === "string" ? head.obj.gramps_id : "";
  if (!(await viewRecord(ctx, c.actor, { class: "Person", handle, gramps_id: gid, version: head.version, obj: head.obj }))) throw new HttpError(404, "not_found", "no such record");
  return head;
}

/** The person's primary Birth and Death events by Gramps' own rule (the first primary-role event of each type). */
async function primaryEvents(ctx, person) {
  const events = new Map();
  for (const ref of arr(person.event_ref_list)) {
    if (isObj(ref) && typeof ref.ref === "string" && HANDLE_RE.test(ref.ref) && !events.has(ref.ref)) {
      const h = await get(ctx, "Event", ref.ref);
      if (h) events.set(ref.ref, h);
    }
  }
  const idx = birthDeathIndex(person, (h) => events.get(h)?.obj);
  const at = (i) => { const ref = arr(person.event_ref_list)[i]; return i >= 0 && isObj(ref) && events.get(ref.ref) ? { handle: ref.ref, ...events.get(ref.ref) } : null; };
  return { birth: at(idx.birth_ref_index), death: at(idx.death_ref_index), deathRefIndex: idx.death_ref_index };
}

const eventRef = (ref) => ({ _class: "EventRef", attribute_list: [], citation_list: [], note_list: [], private: false, ref, role: typed("EventRoleType", ROLE_PRIMARY) });
const eventValue = (type, date, citations) => ({
  _class: "Event", attribute_list: [], change: 0, citation_list: citations, date, description: "", gramps_id: "", media_list: [], note_list: [], place: "", private: false, tag_list: [], type: typed("EventType", type),
});

/** Plain words for the citation: letters, digits, spaces and . ' - only, no address or number run; else a neutral phrase. */
function memberWords(actor) {
  const s = typeof actor.label === "string" ? actor.label.replace(/[^\p{L}\p{M}\p{N} .'-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 80) : "";
  return s && !/\d{7,}/.test(s) ? s : "a family member";
}

/** One row against what is on file: { row result, plan: what to write or null }. */
function judge(name, want, file, other) {
  const state = file ? classifyDate(file.obj.date) : { kind: "empty" };
  const current = state.kind === "empty" ? null : { year: state.year || null, ...(state.kind === "year" ? { about: state.about } : {}) };
  const on = { exists: file !== null, state };
  if (file && other && other.shared) return { result: { status: "shared_event" }, on };
  if (want.unknown) {
    // A Death event already there (dated or not) already says they died; nothing to add.
    return file ? { result: { status: "unchanged", ...(current ? { current } : {}) }, on } : { result: { status: "proposed", action: "create" }, on, write: { date: blankDate() } };
  }
  if (state.kind === "precise") return { result: { status: "precise_on_file", current: { year: state.year || null } }, on };
  if (state.kind === "year" && state.year === want.year && state.about === want.about) return { result: { status: "unchanged", current }, on };
  return { result: { status: "proposed", action: file ? "update" : "create", ...(current ? { current } : {}) }, on, write: { date: yearDate(want.year, want.about) } };
}

const yearWords = (name, want) => (want.unknown ? "Died, year unknown" : `${name === "birth" ? "Born" : "Died"} ${want.about ? "about " : ""}${want.year}`);

/** The compile: { rows, ops, base_versions, summary, marks_deceased, confirm } for one request, or the confirm_needed verdict. */
async function compile(c, parsed, head) {
  const ctx = c.store;
  const person = head.obj;
  const { birth: fileBirth, death: fileDeath } = await primaryEvents(ctx, person);
  const personKey = `Person:${parsed.handle}`;
  const sharedWith = async (ev) => (await backrefs(ctx, `Event:${ev.handle}`)).some((k) => k !== personKey);
  const rows = {};
  const writes = {};
  for (const [name, want, file] of [["birth", parsed.birth, fileBirth], ["death", parsed.death, fileDeath]]) {
    if (!want) continue;
    const j = judge(name, want, file, file ? { shared: await sharedWith(file) } : null);
    rows[name] = j.result;
    if (j.write) writes[name] = { ...j.write, file };
  }
  // Years in force after the change (the request's, else the one on file) decide the order and the length-of-life checks.
  const yearIn = (name, file) => (parsed[name] && !parsed[name].unknown && rows[name].status === "proposed" ? parsed[name].year : file ? classifyDate(file.obj.date).year || 0 : 0);
  const born = yearIn("birth", fileBirth);
  const died = yearIn("death", fileDeath);
  if (born && died && died < born) throw problem(400, "validation", "the request is not valid", { errors: [{ pointer: "/death/year", code: "death_before_birth", detail: "the death year is before the birth year" }] });
  const span = born && died ? died - born : 0;
  if (Object.keys(writes).length && span > LONG_LIFE_YEARS && !parsed.confirm) return { confirm_needed: true, reason: "lifespan_over_120", lifespan: span, rows };
  if (!Object.keys(writes).length) return { rows, ops: [], summary: [], marks_deceased: false };

  const ops = [];
  const base_versions = {};
  const summary = [];
  let n = 0;
  let t = 0;
  const id = () => `o${++n}`;
  const temp = () => `new:${++t}`;
  base_versions[personKey] = head.version;
  // The shared Source and this submission's one Citation (D-24).
  const view = await storeView(ctx);
  const source = view.live().filter((h) => h.class === "Source" && h.obj?.title === SOURCE_TITLE && HANDLE_RE.test(h.handle)).sort((a, b) => (a.handle < b.handle ? -1 : 1))[0];
  let sourceRef;
  if (source) sourceRef = source.handle;
  else {
    sourceRef = temp();
    ops.push({ id: id(), op: "create", obj: sourceRef, cls: "Source", value: { _class: "Source", abbrev: "", attribute_list: [], author: "", change: 0, gramps_id: "", media_list: [], note_list: [], private: false, pubinfo: "", reporef_list: [], tag_list: [], title: SOURCE_TITLE } });
  }
  const cite = temp();
  const today = new Date(ctx.now()).toISOString().slice(0, 10);
  ops.push({ id: id(), op: "create", obj: cite, cls: "Citation", value: { _class: "Citation", attribute_list: [], change: 0, confidence: 2, date: blankDate(), gramps_id: "", media_list: [], note_list: [], page: `Family knowledge: ${memberWords(c.actor)}, via harrisonfamily.us, ${today}`, private: false, source_handle: sourceRef, tag_list: [] } });

  let marks = false;
  const newRefs = [];
  const createSummaries = [];
  for (const [name, type] of [["birth", EVENT_TYPE.BIRTH], ["death", EVENT_TYPE.DEATH]]) {
    const w = writes[name];
    if (!w) continue;
    const want = parsed[name];
    const lead = ops.length;
    if (rows[name].action === "create") {
      const ev = temp();
      ops.push({ id: id(), op: "create", obj: ev, cls: "Event", value: eventValue(type, w.date, [cite]) });
      newRefs.push(eventRef(ev));
      if (name === "death") marks = true;
      const entry = { text: want.unknown ? "add that they died, year unknown" : `add that they ${name === "birth" ? "were born" : "died"} ${want.about ? "about " : "in "}${want.year}`, opIds: ops.slice(lead).map((o) => o.id) };
      createSummaries.push(entry);
      summary.push(entry);
    } else {
      const evKey = `Event:${w.file.handle}`;
      base_versions[evKey] = w.file.version;
      ops.push({ id: id(), op: "set", obj: evKey, path: "/date", base: w.file.obj.date ?? null, value: w.date });
      ops.push({ id: id(), op: "add", obj: evKey, path: "/citation_list", value: cite });
      const was = rows[name].current?.year;
      summary.push({ text: `change the ${name === "birth" ? "birth" : "death"} year${was ? ` from ${was}` : ""} to ${want.about ? "about " : ""}${want.year}`, opIds: ops.slice(lead).map((o) => o.id) });
    }
  }
  if (newRefs.length) {
    // One `set` of the whole list against the list as it is now, not an `add`: an add commutes with another member's add, so two suggestions for
    // the same person would both apply and leave two Death (or Birth) events. With the base, approving one makes the other conflict (stale) (L-7, D-23).
    const current = arr(person.event_ref_list);
    const setId = id();
    ops.push({ id: setId, op: "set", obj: personKey, path: "/event_ref_list", base: current, value: [...current, ...newRefs] });
    for (const e of createSummaries) e.opIds.push(setId);
  }
  if (marks) summary.push({ text: "this will mark them as deceased", opIds: [] });
  for (const k of Object.keys(parsed.base_versions)) {
    if (base_versions[k] !== undefined && parsed.base_versions[k] !== base_versions[k]) {
      throw problem(409, "version_conflict", "the page changed since you opened it", { details: { current: { [k]: base_versions[k] } } });
    }
  }
  return { rows, ops, base_versions, summary, marks_deceased: marks };
}

// ---- the read route ------------------------------------------------------------------------------------------------------
const COARSE_CLASS = { empty: "none", year: "year", precise: "precise" };

/**
 * GET /api/life-dates?target=Person:<handle> (HFY-TSK-388-0D, ruling P4-R29): the coarse precision of the person's primary Birth and Death dates, so the
 * Life dates island can tell an editable year from a more exact date without the published person JSON, which carries no day or month (R-19).
 * Computed from the record store with the classifier and the primary-event rule the POST uses. Only a class (none | year | about | precise) and the
 * year (null when there is none) per row; never a month, day, range, text or calendar. `livingByRule` is the SYNC-15 rule (no death reference) and
 * `sharedEvent` says whether another person also references the row's event. Read-only; the reply is private and never cached.
 */
export async function lifeDatesGet(c) {
  if (!editingOn()) throw new HttpError(404, "not_found", "no such route");
  const target = c.query?.target;
  const m = typeof target === "string" ? /^Person:([A-Za-z0-9_-]{1,64})$/.exec(target) : null;
  if (!m) throw problem(400, "validation", "the request is not valid", { errors: [{ pointer: "/target", code: "target", detail: "target must look like Person:<handle>" }] });
  const ctx = c.store;
  const head = await loadPerson(c, m[1]);
  const { birth, death, deathRefIndex } = await primaryEvents(ctx, head.obj);
  const personKey = `Person:${m[1]}`;
  const row = async (file) => {
    if (!file) return { row: { class: "none", year: null }, shared: false };
    const state = classifyDate(file.obj.date);
    const cls = state.kind === "year" && state.about ? "about" : COARSE_CLASS[state.kind];
    const shared = (await backrefs(ctx, `Event:${file.handle}`)).some((k) => k !== personKey);
    return { row: { class: cls, year: state.kind === "empty" || !state.year ? null : state.year }, shared };
  };
  const b = await row(birth);
  const d = await row(death);
  return json(200, { birth: b.row, death: d.row, livingByRule: deathRefIndex < 0, sharedEvent: { birth: b.shared, death: d.shared } }, { "cache-control": "private, no-store" });
}

// ---- the route -----------------------------------------------------------------------------------------------------------
/** POST /api/life-dates */
export async function lifeDatesPost(c) {
  if (!editingOn()) throw new HttpError(404, "not_found", "no such route");
  const ctx = c.store;
  const nowMs = ctx.now();
  const parsed = parseRequest(c, new Date(nowMs).getUTCFullYear());
  const target = `Person:${parsed.handle}`;
  const intent = { type: "life_dates", target, ...(parsed.birth ? { birth: parsed.birth } : {}), ...(parsed.death ? { death: parsed.death } : {}) };
  const hash = requestHashOf({ intent, confirm: parsed.confirm, route: "review" });
  if (!parsed.dry_run) {
    const item = await readIdem(ctx, c.actor.id, parsed.key);
    if (item) return replayOf(item, hash);
  }
  const head = await loadPerson(c, parsed.handle);
  const compiled = await compile(c, parsed, head);
  if (compiled.confirm_needed) {
    return { status: 200, body: { confirm_needed: true, reason: compiled.reason, lifespan: compiled.lifespan, applied: null, proposal: null, rows: compiled.rows } };
  }
  if (!compiled.ops.length) return { status: 200, body: { applied: null, proposal: null, summary: [], unchanged: true, marks_deceased: false, rows: compiled.rows } };
  const guard = createRecordGuard({ dob: ctx.guardDob === true, log: ctx.log });
  const req = { target, base_versions: compiled.base_versions, ops: compiled.ops, note: undefined, route: "review", dry_run: parsed.dry_run, key: parsed.key, intent, confirm: parsed.confirm };
  const planned = await planChanges(c, req, nowMs, guard);
  const summary = compiled.summary.map((s) => ({ ...s, route: "review" }));
  const storedIntent = { ...intent, marks_deceased: compiled.marks_deceased };
  if (parsed.dry_run) return { status: 200, body: { plan: planned.plan, summary, marks_deceased: compiled.marks_deceased, rows: compiled.rows, warnings: planned.warnings, errors: [] } };
  planned.summary = summary;
  return commit(c, req, planned, nowMs, { intent: storedIntent, summary, body: { marks_deceased: compiled.marks_deceased, rows: compiled.rows } });
}

