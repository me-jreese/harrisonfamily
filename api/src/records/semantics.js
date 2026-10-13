// Gramps semantics (HFY-TSK-249, edit-gramps-semantics): the rules Gramps itself applies when a record is edited,
// run on the objects that an EditOp batch produced. Editing design section 6.2.
//
//   dates        a Date is valid, and its `sortval` is the number Gramps' own `Date.set()` computes (never a number
//                a client sent); members get Gregorian and Julian only, no future date, no day beyond its month.
//   references   every handle names an object that exists, with the right class.
//   family links two-sided, as EditFamily keeps them: `Family.father/mother = p` holds exactly when `p.family_list`
//                holds the Family, and a ChildRef for `c` exists exactly when `c.parent_family_list` holds it.
//   family sense a parent is not also a child of the family, father is not mother, no ChildRef twice.
//   ancestry     no person is their own ancestor.
//   call name    a new or changed Name's `call` is one of the words of its `first_name`.
//   derived      `birth_ref_index` and `death_ref_index` are recomputed with Gramps' `set_birth_death_index` for every
//                Person whose `event_ref_list` changed and every Person that uses an Event whose type changed.
//
// NOT BUILT HERE (deferred to `edit-api-changes` and the relationship compiler): the non-blocking warnings of
// editing design section 6.2 (a person who already has birth parents, a parent under 13 years older than the child,
// a possible duplicate person). `warnings` is always [] and is kept in the result so a caller can rely on its shape.
//
// PURE. Its only import is the EditOp engine's canonical JSON, so it runs under `node --test` and in a browser. No
// route calls it yet (its first caller is `edit-api-changes`), so it ships in the `hfy-api` zip unreachable.
//
// It tests the rules against the data as it will be AFTER the ops apply. It reports only what the change itself
// introduces: a tree that already breaks a rule (a dangling handle from an old import, say) does not block an
// unrelated edit to the same object, but the edit cannot add a new violation. Dates already stored are never
// re-judged: only a Date that is new or different from the stored one is validated.
//
//   checkSemantics({ before, after, get, eventReferrers?, referrers?, admin?, today? })
//     before  the touched objects as they were  { "Person:<h>": obj }  (absent: created by this batch)
//     after   the touched objects as they will be (`applyOps(...).objects`); a key in `before` and not in `after`
//             is deleted
//     get     (key) => object | undefined, the stored object for anything not in before/after
//     eventReferrers  (eventHandle) => ["Person:<h>", ...], every stored Person that references the Event. Required
//             when an Event's type changed (records.graph() provides it).
//     referrers  (key) => [keys], every stored object that references `key`. Required when the change deletes an
//             object (without it the check cannot tell whether something still points at it: `referrers_required`).
//     admin   an admin may submit non-Gregorian calendars and dates outside the member range
//     today   { y, m, d } | Date | "YYYY-MM-DD" (default: now, UTC). Anything else throws a TypeError. A caller that
//             knows the member's time zone should pass the member's local day, since the future-date rule is exact.
//   -> { ok, errors, warnings, objects, derivedKeys }
//     errors  [{ code, obj, path?, message, ... }]; `objects` is `after` with the derived fields filled in (sortval on
//     each new Date, the two indexes), plus any Person this change forced to recompute (listed in `derivedKeys`).

import { canonicalJson } from "./ops.js";
import { sdn } from "./gcalendar.js";

export const CALENDAR = Object.freeze({ GREGORIAN: 0, JULIAN: 1, HEBREW: 2, FRENCH: 3, PERSIAN: 4, ISLAMIC: 5, SWEDISH: 6 });
export const MODIFIER = Object.freeze({ NONE: 0, BEFORE: 1, AFTER: 2, ABOUT: 3, RANGE: 4, SPAN: 5, TEXTONLY: 6, FROM: 7, TO: 8 });
export const EVENT_TYPE = Object.freeze({ BIRTH: 12, DEATH: 13 });
export const ROLE_PRIMARY = 1;

// Error codes. A caller maps them to copy; `message` is a plain-language default.
export const CODES = Object.freeze({
  badObject: "bad_object",
  unmintedHandle: "unminted_handle",
  missingReference: "missing_reference",
  stillReferenced: "still_referenced",
  referrersRequired: "referrers_required",
  callNameNotInFirstName: "call_name_not_in_first_name",
  linkMissingFamilyList: "link_missing_family_list",
  linkOrphanFamilyList: "link_orphan_family_list",
  linkMissingParentFamily: "link_missing_parent_family",
  linkOrphanParentFamily: "link_orphan_parent_family",
  danglingFamilyLink: "dangling_family_link",
  duplicateFamilyLink: "duplicate_family_link",
  sameParent: "same_parent",
  parentIsChild: "parent_is_child",
  duplicateChildRef: "duplicate_child_ref",
  ancestryCycle: "ancestry_cycle",
  ancestryLimit: "ancestry_limit",
  dateShape: "date_shape",
  calendarNotAllowed: "calendar_not_allowed",
  newyearNotAllowed: "newyear_not_allowed",
  yearRequired: "year_required",
  monthRequired: "month_required",
  monthOutOfRange: "month_out_of_range",
  dayOutOfRange: "day_out_of_range",
  yearOutOfRange: "year_out_of_range",
  dateInFuture: "date_in_future",
  rangeIncomplete: "range_incomplete",
  rangeOrder: "range_order",
  dateEmptyModifier: "date_empty_modifier",
  textRequired: "text_required",
  textNotAllowed: "text_not_allowed",
  textDateHasValue: "text_date_has_value",
});

const MEMBER_MIN_YEAR = 1000;
const ADMIN_MIN_YEAR = 1;
const ADMIN_MAX_YEAR = 9999;
const MAX_ANCESTRY_VISITS = 100000;

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const classOf = (key) => key.slice(0, key.indexOf(":"));
const handleOf = (key) => key.slice(key.indexOf(":") + 1);
const keyOf = (cls, handle) => `${cls}:${handle}`;
const esc = (s) => String(s).replace(/~/g, "~0").replace(/\//g, "~1");
const pointer = (path) => path.map((s) => "/" + esc(s)).join("");
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const asList = (v) => (Array.isArray(v) ? v : []);
const hasHandle = (list, h) => asList(list).includes(h);

// ---------------------------------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------------------------------

// A Date anywhere in an object: { path: [...], date }. A Date is never searched inside.
export function findDates(value, path = [], out = []) {
  if (Array.isArray(value)) {
    value.forEach((v, i) => findDates(v, path.concat(i), out));
  } else if (isPlain(value)) {
    if (Array.isArray(value.dateval)) {
      out.push({ path, date: value });
      return out;
    }
    for (const k of Object.keys(value)) findDates(value[k], path.concat(k), out);
  }
  return out;
}

const NEWYEAR_SPLIT = { 1: [3, 1], 2: [3, 25], 3: [9, 1] }; // Date.NEWYEAR_MAR1, MAR25, SEP1

function calcSortValue(calendar, dv) {
  if (dv[2] === 0 && dv[1] === 0 && dv[0] === 0) return 0;
  // Date._zero_adjust_ymd: a zero year is year 1, a zero month or day is 1
  return sdn(calendar, dv[2] !== 0 ? dv[2] : 1, Math.max(dv[1], 1), Math.max(dv[0], 1));
}

// The calendar a Date ends up in and its sortval, as Gramps' `Date.set()` computes them (gen/lib/date.py:1664-1790):
// the first part of the date decides (a range's end does not); a slash (dual-dated) date moves to the Julian
// calendar; a new-year offset moves a date at or past the split into the previous year; a text-only date is 0.
export function grampsDate(date) {
  const dv = date.dateval;
  if (date.modifier === MODIFIER.TEXTONLY) return { calendar: date.calendar, sortval: 0 };
  let calendar = date.calendar;
  let sortval = calcSortValue(calendar, dv);
  if (dv[3] && calendar !== CALENDAR.JULIAN) {
    calendar = CALENDAR.JULIAN;
    sortval = calcSortValue(calendar, dv);
  }
  const split = NEWYEAR_SPLIT[date.newyear];
  if (split && (dv[1] > split[0] || (dv[1] === split[0] && dv[0] >= split[1]))) {
    sortval = calcSortValue(calendar, [dv[0], dv[1], dv[2] - 1, false]);
  }
  return { calendar, sortval };
}

export const computeSortval = (date) => grampsDate(date).sortval;

// A copy of the Date as Gramps would leave it: calendar settled, sortval recomputed. Everything else is kept.
export function normalizeDate(date) {
  const g = grampsDate(date);
  return { ...date, calendar: g.calendar, sortval: g.sortval };
}

function todayParts(today) {
  if (today === undefined || today === null) {
    const t = new Date();
    return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
  }
  if (today instanceof Date) {
    if (Number.isNaN(today.getTime())) throw new TypeError("today is an invalid Date");
    return { y: today.getUTCFullYear(), m: today.getUTCMonth() + 1, d: today.getUTCDate() };
  }
  if (typeof today === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(today);
    if (m && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31) return { y: +m[1], m: +m[2], d: +m[3] };
    throw new TypeError(`today must be YYYY-MM-DD, got ${JSON.stringify(today)}`);
  }
  if (isPlain(today) && Number.isInteger(today.y) && Number.isInteger(today.m) && Number.isInteger(today.d)) return { y: today.y, m: today.m, d: today.d };
  throw new TypeError("today must be { y, m, d }, a Date or a YYYY-MM-DD string");
}

const isLeap = (calendar, y) => (calendar === CALENDAR.JULIAN ? y % 4 === 0 : y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0));
const daysInMonth = (calendar, y, m) => (m === 2 ? (isLeap(calendar, y) ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31);
// Month and day ceilings for the calendars Gregorian/Julian logic does not cover (admins only).
const OTHER_LIMITS = { 2: [13, 30], 3: [13, 30], 4: [12, 31], 5: [12, 30], 6: [12, 31] };

const isInt = Number.isInteger;
const isEmptyPart = (p) => p[0] === 0 && p[1] === 0 && p[2] === 0;
const fixedNewyear = (calendar) => !(calendar === CALENDAR.GREGORIAN || calendar === CALENDAR.JULIAN || calendar === CALENDAR.SWEDISH);

// Rules for one Date, as a list of problems. Run on a Date a client submitted. `opts`: { admin, today }.
export function validateDate(date, opts = {}) {
  const admin = !!opts.admin;
  const problems = [];
  const bad = (code, message, extra) => problems.push({ code, message, ...extra });
  if (!isPlain(date)) return [{ code: CODES.dateShape, message: "that date is not in a shape the site can read" }];
  const { calendar, modifier, quality, dateval, newyear } = date;
  if (!isInt(calendar) || calendar < 0 || calendar > 6) bad(CODES.dateShape, "the calendar is not one the site knows", { path: "/calendar" });
  if (!isInt(modifier) || modifier < 0 || modifier > 8) bad(CODES.dateShape, "the date type is not one the site knows", { path: "/modifier" });
  if (!isInt(quality) || quality < 0 || quality > 2) bad(CODES.dateShape, "the date quality is not one the site knows", { path: "/quality" });
  if (newyear !== undefined && (!isInt(newyear) || newyear < 0 || newyear > 3)) bad(CODES.dateShape, "the new-year setting is not one the site knows", { path: "/newyear" });
  if (date.text !== undefined && typeof date.text !== "string") bad(CODES.dateShape, "the date text must be text", { path: "/text" });
  const compound = modifier === MODIFIER.RANGE || modifier === MODIFIER.SPAN;
  const want = compound ? 8 : 4;
  let shapeOk = Array.isArray(dateval) && dateval.length === want;
  if (shapeOk) {
    for (const base of compound ? [0, 4] : [0]) {
      if (![0, 1, 2].every((i) => isInt(dateval[base + i])) || typeof dateval[base + 3] !== "boolean") shapeOk = false;
    }
  }
  if (!shapeOk) bad(CODES.dateShape, `the date needs ${want} values: day, month, year and the slash flag${compound ? " for each end" : ""}`, { path: "/dateval" });
  if (problems.length) return problems;

  if (!admin && calendar !== CALENDAR.GREGORIAN && calendar !== CALENDAR.JULIAN) {
    bad(CODES.calendarNotAllowed, "only Gregorian and Julian dates can be entered on the site", { path: "/calendar" });
  }
  if ((newyear || 0) !== 0 && fixedNewyear(calendar)) bad(CODES.newyearNotAllowed, "that calendar's new year cannot be changed", { path: "/newyear" });

  if (modifier === MODIFIER.TEXTONLY) {
    if (dateval.slice(0, 3).some((v) => v !== 0) || dateval[3]) bad(CODES.textDateHasValue, "a date written as text carries no day, month or year", { path: "/dateval" });
    if (typeof date.text !== "string" || date.text.trim() === "") bad(CODES.textRequired, "a date written as text needs the text", { path: "/text" });
    return problems;
  }
  if (typeof date.text === "string" && date.text !== "") bad(CODES.textNotAllowed, "text goes only on a date written as text", { path: "/text" });

  const parts = [dateval.slice(0, 3)];
  if (compound) parts.push(dateval.slice(4, 7));
  const gj = calendar === CALENDAR.GREGORIAN || calendar === CALENDAR.JULIAN;
  const t = todayParts(opts.today);
  const todaySdn = sdn(CALENDAR.GREGORIAN, t.y, t.m, t.d);

  parts.forEach((p, i) => {
    const [d, m, y] = p;
    const at = compound ? (i === 0 ? "start " : "end ") : "";
    const base = i === 0 ? 0 : 4;
    const ptr = (k) => `/dateval/${base + k}`;
    if (isEmptyPart(p)) {
      if (compound) bad(CODES.rangeIncomplete, "a range or span needs both a start and an end", { path: `/dateval` });
      else if (modifier !== MODIFIER.NONE) bad(CODES.dateEmptyModifier, "this kind of date needs a date", { path: "/dateval" });
      return;
    }
    const [maxMonth, maxDay] = gj ? [12, 31] : OTHER_LIMITS[calendar];
    if (y === 0) {
      bad(CODES.yearRequired, `the ${at}date needs a year`, { path: ptr(2) });
    } else if (admin ? y < ADMIN_MIN_YEAR || y > ADMIN_MAX_YEAR : y < MEMBER_MIN_YEAR) {
      bad(CODES.yearOutOfRange, admin ? `the ${at}year must be between ${ADMIN_MIN_YEAR} and ${ADMIN_MAX_YEAR}` : `the ${at}year must be ${MEMBER_MIN_YEAR} or later`, { path: ptr(2) });
    }
    if (m < 0 || m > maxMonth) bad(CODES.monthOutOfRange, `the ${at}month must be between 1 and ${maxMonth}`, { path: ptr(1) });
    if (d < 0 || d > maxDay) bad(CODES.dayOutOfRange, `the ${at}day must be between 1 and ${maxDay}`, { path: ptr(0) });
    if (d > 0 && m === 0) bad(CODES.monthRequired, `the ${at}date has a day but no month`, { path: ptr(1) });
    if (gj && y !== 0 && m >= 1 && m <= 12 && d >= 1 && d <= 31 && d > daysInMonth(calendar, y, m)) {
      bad(CODES.dayOutOfRange, `that month has only ${daysInMonth(calendar, y, m)} days in ${y}`, { path: ptr(0) });
    }
    if (!admin && gj && y !== 0 && m >= 0 && m <= 12 && d >= 0 && d <= 31) {
      // The earliest day the date could mean must not be after today (a year alone means January 1).
      const earliest = sdn(calendar, y, Math.max(m, 1), Math.max(d, 1));
      if (earliest > todaySdn) bad(CODES.dateInFuture, "that date has not happened yet", { path: ptr(2) });
    }
  });

  if (compound && parts.every((p) => !isEmptyPart(p))) {
    const a = parts[0];
    const b = parts[1];
    const order = (x, y) => x[2] - y[2] || x[1] - y[1] || x[0] - y[0];
    if (order(a, b) >= 0) bad(CODES.rangeOrder, "a range or span must start before it ends", { path: "/dateval" });
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------------------------------------------

// Where a handle sits, by the name of the field that holds it (Gramps 6.0.6 JSON).
const STRING_LIST_CLASS = { note_list: "Note", citation_list: "Citation", tag_list: "Tag", family_list: "Family", parent_family_list: "Family" };
const SCALAR_CLASS = { father_handle: "Person", mother_handle: "Person", source_handle: "Source", place: "Place" };
const ELEMENT_LIST_CLASS = { event_ref_list: "Event", child_ref_list: "Person", media_list: "Media", person_ref_list: "Person", placeref_list: "Place", reporef_list: "Repository" };
export const OBJECT_CLASSES = Object.freeze(["Person", "Family", "Event", "Place", "Source", "Citation", "Repository", "Media", "Note", "Tag"]);

// Every handle an object holds: [{ cls, handle, path }].
export function collectRefs(obj) {
  const out = [];
  const walk = (v, field, path) => {
    if (Array.isArray(v)) {
      const strCls = STRING_LIST_CLASS[field];
      const elCls = ELEMENT_LIST_CLASS[field];
      v.forEach((item, i) => {
        if (strCls) {
          if (typeof item === "string" && item) out.push({ cls: strCls, handle: item, path: path.concat(i) });
        } else {
          if (elCls && isPlain(item) && typeof item.ref === "string" && item.ref) out.push({ cls: elCls, handle: item.ref, path: path.concat(i, "ref") });
          walk(item, null, path.concat(i));
        }
      });
    } else if (isPlain(v)) {
      for (const k of Object.keys(v)) {
        if (SCALAR_CLASS[k] && typeof v[k] === "string") {
          if (v[k]) out.push({ cls: SCALAR_CLASS[k], handle: v[k], path: path.concat(k) });
        } else walk(v[k], k, path.concat(k));
      }
    }
  };
  walk(obj, null, []);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Birth and death index
// ---------------------------------------------------------------------------------------------------------------

// Gramps' DbWriteBase.set_birth_death_index (gen/db/base.py:2025-2047): the first primary-role Birth event and the
// first primary-role Death event. `eventOf(handle)` returns the Event object (or undefined, which is skipped).
export function birthDeathIndex(person, eventOf) {
  let birth = -1;
  let death = -1;
  asList(person.event_ref_list).forEach((ref, i) => {
    const ev = ref && eventOf(ref.ref);
    if (!ev) return;
    const type = ev.type && ev.type.value;
    const primary = ref.role && ref.role.value === ROLE_PRIMARY;
    if (type === EVENT_TYPE.BIRTH && primary && birth === -1) birth = i;
    else if (type === EVENT_TYPE.DEATH && primary && death === -1) death = i;
  });
  return { birth_ref_index: birth, death_ref_index: death };
}

// ---------------------------------------------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------------------------------------------

const canonDate = (d) => {
  const { sortval, ...rest } = d; // eslint-disable-line no-unused-vars
  return canonicalJson(rest);
};

// The Names of a Person: [{ path, name }] for primary_name and each alternate_names entry.
function personNames(p) {
  const out = [];
  if (isPlain(p.primary_name)) out.push({ path: ["primary_name"], name: p.primary_name });
  asList(p.alternate_names).forEach((n, i) => { if (isPlain(n)) out.push({ path: ["alternate_names", i], name: n }); });
  return out;
}

function familyMembers(f) {
  if (!isPlain(f)) return [];
  const out = [];
  if (f.father_handle) out.push(f.father_handle);
  if (f.mother_handle) out.push(f.mother_handle);
  for (const r of asList(f.child_ref_list)) if (r && r.ref) out.push(r.ref);
  return out;
}

// Issues about one (Person, Family) pair, keyed by a stable id so the same issue before and after can be compared.
function linkIssues(v, pairs) {
  const out = new Map();
  const add = (code, obj, path, family, message) => out.set(`${code}|${obj}|${family}`, { code, obj, path, family, message });
  for (const pair of pairs) {
    const [pk, fk] = pair.split("|");
    const p = v(pk);
    const f = v(fk);
    const ph = handleOf(pk);
    const fh = handleOf(fk);
    const inFam = !!p && hasHandle(p.family_list, fh);
    const inPar = !!p && hasHandle(p.parent_family_list, fh);
    if (!f) {
      if (inFam) add(CODES.danglingFamilyLink, pk, "/family_list", fk, "this person is linked to a family that does not exist");
      if (inPar) add(CODES.danglingFamilyLink, pk, "/parent_family_list", fk, "this person is linked to a family that does not exist");
      continue;
    }
    if (!p) continue;
    const isParent = f.father_handle === ph || f.mother_handle === ph;
    const isChild = asList(f.child_ref_list).some((r) => r && r.ref === ph);
    if (isParent && !inFam) add(CODES.linkMissingFamilyList, pk, "/family_list", fk, "the family names this person as a parent, but the person's families do not list it");
    if (inFam && !isParent) add(CODES.linkOrphanFamilyList, pk, "/family_list", fk, "the person lists a family that does not name them as a parent");
    if (isChild && !inPar) add(CODES.linkMissingParentFamily, pk, "/parent_family_list", fk, "the family lists this person as a child, but the person's parent families do not list it");
    if (inPar && !isChild) add(CODES.linkOrphanParentFamily, pk, "/parent_family_list", fk, "the person lists a parent family that does not list them as a child");
  }
  return out;
}

function familySanity(fk, f) {
  const out = new Map();
  if (!isPlain(f)) return out;
  const add = (code, extra, message) => out.set(`${code}|${fk}|${extra}`, { code, obj: fk, path: extra.startsWith("/") ? extra : undefined, message });
  const kids = asList(f.child_ref_list).map((r) => r && r.ref);
  if (f.father_handle && f.father_handle === f.mother_handle) add(CODES.sameParent, "/mother_handle", "a family's father and mother cannot be the same person");
  if (f.father_handle && kids.includes(f.father_handle)) add(CODES.parentIsChild, "/father_handle", "a father cannot be his own child");
  if (f.mother_handle && kids.includes(f.mother_handle)) add(CODES.parentIsChild, "/mother_handle", "a mother cannot be her own child");
  const seen = new Set();
  const dups = new Set();
  for (const h of kids) {
    if (seen.has(h)) dups.add(h);
    seen.add(h);
  }
  for (const h of dups) add(CODES.duplicateChildRef, `child:${h}`, "a child is listed twice in the family");
  return out;
}

function personSanity(pk, p) {
  const out = new Map();
  if (!isPlain(p)) return out;
  for (const field of ["family_list", "parent_family_list"]) {
    const list = asList(p[field]);
    if (new Set(list).size !== list.length) out.set(`${CODES.duplicateFamilyLink}|${pk}|${field}`, { code: CODES.duplicateFamilyLink, obj: pk, path: `/${field}`, message: "a family is listed twice" });
  }
  return out;
}

// Ancestry: person -> parents through parent_family_list and the Family's father/mother.
const parentsOf = (v, pk) => {
  const p = v(pk);
  const out = [];
  for (const fh of asList(p && p.parent_family_list)) {
    const f = v(keyOf("Family", fh));
    if (!f) continue;
    for (const h of [f.father_handle, f.mother_handle]) if (h && !out.includes(keyOf("Person", h))) out.push(keyOf("Person", h));
  }
  return out;
};

// A new cycle must contain a new child -> parent edge, so look at each edge the change adds (present now, absent
// before) and ask whether the parent can already reach the child going up. That finds a second cycle that shares
// people with one already in the tree, which a plain depth-first search from the touched people would miss.
// Returns { cycles: [[person keys]], limit }; each cycle starts at the child of the new edge.
function newCycles(now, was, starts) {
  const cycles = new Map();
  let visits = 0;
  for (const s of starts) {
    const before = new Set(parentsOf(was, s));
    for (const p of parentsOf(now, s)) {
      if (before.has(p)) continue;
      // breadth-first from p up the ancestry, looking for s
      const prev = new Map([[p, null]]);
      const queue = [p];
      let found = p === s;
      for (let i = 0; i < queue.length && !found; i++) {
        if (++visits > MAX_ANCESTRY_VISITS) return { cycles: [...cycles.values()], limit: true };
        for (const n of parentsOf(now, queue[i])) {
          if (prev.has(n)) continue;
          prev.set(n, queue[i]);
          if (n === s) { found = true; break; }
          queue.push(n);
        }
      }
      if (!found) continue;
      const members = [];
      for (let c = prev.has(s) ? s : p; c !== null && c !== undefined; c = prev.get(c)) members.push(c);
      const cycle = [s, ...members.filter((m) => m !== s).reverse()];
      cycles.set([...cycle].sort().join(","), cycle);
    }
  }
  return { cycles: [...cycles.values()], limit: false };
}

export function checkSemantics(input) {
  const { before = {}, after = {}, get = () => undefined, eventReferrers, referrers } = input;
  const admin = !!input.admin;
  const errors = [];
  const err = (e) => errors.push(e);

  const stored = (k) => get(k) ?? undefined; // a store that answers null for "absent" is read as undefined
  const view = (k) => (hasOwn(after, k) ? after[k] : hasOwn(before, k) ? undefined : stored(k));
  const beforeView = (k) => (hasOwn(before, k) ? before[k] : hasOwn(after, k) ? undefined : stored(k));
  const afterKeys = Object.keys(after);
  const beforeKeys = Object.keys(before);
  const deleted = beforeKeys.filter((k) => !hasOwn(after, k));

  // 1. Identity: the key names the object.
  for (const k of afterKeys) {
    const o = after[k];
    const cls = classOf(k);
    if (!OBJECT_CLASSES.includes(cls) || !isPlain(o) || o._class !== cls || o.handle !== handleOf(k)) {
      err({ code: CODES.badObject, obj: k, message: "the object does not match its key" });
    }
  }

  // 2. References: every handle exists with the right class. A handle that was already dangling before is not new.
  for (const k of afterKeys) {
    const o = after[k];
    if (!isPlain(o)) continue;
    const had = new Set(isPlain(before[k]) ? collectRefs(before[k]).map((r) => keyOf(r.cls, r.handle)) : []);
    for (const r of collectRefs(o)) {
      const rk = keyOf(r.cls, r.handle);
      if (/^new:\d+$/.test(r.handle)) {
        err({ code: CODES.unmintedHandle, obj: k, path: pointer(r.path), message: "a temporary handle was never created" });
      } else if (view(rk) === undefined && !(had.has(rk) && beforeView(rk) === undefined)) {
        err({ code: CODES.missingReference, obj: k, path: pointer(r.path), ref: rk, message: `the ${r.cls.toLowerCase()} that this points to does not exist` });
      }
    }
  }
  // A deleted object that something stored still points to.
  if (deleted.length && typeof referrers !== "function") {
    err({ code: CODES.referrersRequired, message: "an object is being deleted and the objects that point to it were not supplied" });
  } else if (typeof referrers === "function") {
    for (const dk of deleted) {
      for (const rk of referrers(dk)) {
        const o = view(rk);
        if (!isPlain(o)) continue;
        const hit = collectRefs(o).find((r) => keyOf(r.cls, r.handle) === dk);
        if (hit) err({ code: CODES.stillReferenced, obj: rk, path: pointer(hit.path), ref: dk, message: "this still points to something being deleted" });
      }
    }
  }

  // 3. Family links and family sense, 4. ancestry.
  const familyKeys = new Set([...afterKeys, ...beforeKeys].filter((k) => classOf(k) === "Family"));
  const personKeys = new Set([...afterKeys, ...beforeKeys].filter((k) => classOf(k) === "Person"));
  const pairs = new Set();
  for (const fk of familyKeys) {
    for (const h of new Set([...familyMembers(after[fk]), ...familyMembers(before[fk])])) pairs.add(`${keyOf("Person", h)}|${fk}`);
  }
  for (const pk of personKeys) {
    for (const o of [after[pk], before[pk]]) {
      if (!isPlain(o)) continue;
      for (const fh of [...asList(o.family_list), ...asList(o.parent_family_list)]) pairs.add(`${pk}|${keyOf("Family", fh)}`);
    }
  }
  const sanityOf = (v, fks, pks) => {
    const m = new Map();
    for (const fk of fks) for (const [id, e] of familySanity(fk, v(fk))) m.set(id, e);
    for (const pk of pks) for (const [id, e] of personSanity(pk, v(pk))) m.set(id, e);
    return m;
  };
  const baseline = new Map([...linkIssues(beforeView, pairs), ...sanityOf(beforeView, familyKeys, personKeys)]);
  for (const [id, e] of [...linkIssues(view, pairs), ...sanityOf(view, familyKeys, personKeys)]) {
    if (!baseline.has(id)) err(e.path === undefined ? { code: e.code, obj: e.obj, message: e.message } : e);
  }

  const starts = new Set(personKeys);
  for (const fk of familyKeys) for (const h of new Set([...familyMembers(after[fk]), ...familyMembers(before[fk])])) starts.add(keyOf("Person", h));
  const cyc = newCycles(view, beforeView, starts);
  if (cyc.limit) err({ code: CODES.ancestryLimit, message: "the family tree is too large to check for loops in one change" });
  for (const members of cyc.cycles) err({ code: CODES.ancestryCycle, obj: members[0], cycle: members, message: "that would make a person their own ancestor" });

  // 5. Dates: validate each Date that is new or different, and recompute its sortval in the copy we return.
  const objects = {};
  for (const k of afterKeys) objects[k] = clone(after[k]);
  let datesNormalized = 0;
  for (const k of afterKeys) {
    // The stored Dates, by content without sortval. An unchanged Date is not judged again, and its sortval goes back
    // to the stored value, so a client cannot change it by sending only a different sortval.
    const prior = new Map();
    for (const { date } of findDates(before[k])) {
      const c = canonDate(date);
      if (!prior.has(c)) prior.set(c, []);
      prior.get(c).push(date.sortval);
    }
    for (const { path, date } of findDates(objects[k])) {
      const c = canonDate(date);
      const stock = prior.get(c);
      if (stock && stock.length) {
        const was = stock.shift();
        if (was === undefined) delete date.sortval;
        else date.sortval = was;
        continue;
      }
      const problems = validateDate(date, { admin, today: input.today });
      if (problems.length) {
        for (const p of problems) err({ ...p, obj: k, path: pointer(path) + (p.path || "") });
      } else {
        const g = grampsDate(date);
        date.calendar = g.calendar;
        date.sortval = g.sortval;
        datesNormalized++;
      }
    }
  }

  // 5b. Call name: a new or changed Name's `call` is one of the words of its `first_name` (editing design 6.2).
  for (const k of afterKeys) {
    if (classOf(k) !== "Person" || !isPlain(after[k])) continue;
    const oldNames = new Set(isPlain(before[k]) ? personNames(before[k]).map((n) => canonicalJson(n.name)) : []);
    for (const { path, name } of personNames(after[k])) {
      if (oldNames.has(canonicalJson(name))) continue;
      const call = typeof name.call === "string" ? name.call.trim() : "";
      if (call === "") continue;
      const words = String(typeof name.first_name === "string" ? name.first_name : "").split(/\s+/).filter(Boolean);
      if (!words.includes(call)) {
        err({ code: CODES.callNameNotInFirstName, obj: k, path: pointer(path.concat("call")), message: "the call name must be one of the given names" });
      }
    }
  }

  // 6. Derived birth_ref_index and death_ref_index.
  const eventOf = (h) => view(keyOf("Event", h));
  const changedEvents = afterKeys.filter(
    (k) => classOf(k) === "Event" && isPlain(before[k]) && isPlain(after[k]) && canonicalJson(before[k].type ?? null) !== canonicalJson(after[k].type ?? null),
  );
  const affected = new Set();
  for (const k of afterKeys) {
    if (classOf(k) !== "Person" || !isPlain(after[k])) continue;
    if (!isPlain(before[k]) || canonicalJson(asList(before[k].event_ref_list)) !== canonicalJson(asList(after[k].event_ref_list))) affected.add(k);
  }
  if (changedEvents.length) {
    const changed = new Set(changedEvents.map(handleOf));
    for (const k of afterKeys) {
      if (classOf(k) === "Person" && isPlain(after[k]) && asList(after[k].event_ref_list).some((r) => r && changed.has(r.ref))) affected.add(k);
    }
    if (typeof eventReferrers !== "function") {
      err({ code: CODES.referrersRequired, message: "an event's type changed and the people who use it were not supplied" });
    } else {
      for (const h of changed) for (const pk of eventReferrers(h)) if (view(pk) !== undefined) affected.add(pk);
    }
  }
  const derivedKeys = [];
  const personsReindexed = [];
  for (const pk of affected) {
    const current = view(pk);
    if (!isPlain(current)) continue;
    const idx = birthDeathIndex(current, eventOf);
    const target = hasOwn(objects, pk) ? objects[pk] : clone(current);
    if (target.birth_ref_index !== idx.birth_ref_index || target.death_ref_index !== idx.death_ref_index) {
      target.birth_ref_index = idx.birth_ref_index;
      target.death_ref_index = idx.death_ref_index;
      personsReindexed.push(pk);
      if (!hasOwn(objects, pk)) {
        objects[pk] = target;
        derivedKeys.push(pk);
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings: [], objects, derivedKeys, derived: { dates: datesNormalized, indexes: personsReindexed.sort() } };
}
