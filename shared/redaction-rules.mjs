// Redaction policy v1: the JavaScript port of the pure predicates (HFY-PLN-002 D2-32; task redaction-policy-v1).
//
// gramps/redaction/redaction-v1.json is the one source of the rules; gramps/hfygramps/rules.py is the Python original. Both pass
// the golden vectors in gramps/redaction/vectors/. This module takes the parsed policy as an argument instead of importing it, so
// it stays pure ESM with no import (shared/ contract, D2-10: it also runs in the browser and in a Cloudflare Worker) and every
// caller decides how the JSON reaches it: validator-js, the edit guard and the renderer each import the one policy file.
//
//   const tree = buildTree(objects);                 // Gramps json_data objects, one plain object each
//   isBirthLike(event, tree, policy);                // the only birth-like list anywhere
//
// Scope: this port holds the date, place, coordinate, attribute, rect and birth-like predicates. The URL channel rules (url_rules),
// the path-pattern matcher (match_pointers) and the pointer helpers exist only in gramps/hfygramps/rules.py; the validator task
// ports them before it relies on them. Nothing in the API imports this file yet.
//
// No function here logs or returns a matched value. A nested value of the wrong shape (an event_ref_list entry that is not an
// object, a type or a date that is not an object, a citation_list that is not an array) reads as absent, never throws. A date that
// is not an object is treated as a leak: dateViolations reports it (pointer "") and reduceDate replaces it by an empty date. A
// top-level argument that is not an object (isBirthLike(null, ...)) is a caller error: a caller that gets an exception holds the
// record (fail closed). The same rules hold in the Python original.

const isInt = (v) => typeof v === "number" && Number.isInteger(v);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const obj = (v) => (isObj(v) ? v : {});
const arr = (v) => (Array.isArray(v) ? v : []);
const values = (named) => new Set(named.map((x) => x.value));
// ASCII-only semantics, like Python's re.ASCII: no u flag, so a non-ASCII look-alike never matches an ASCII pattern.
export const compilePattern = (spec) => new RegExp(spec.pattern, (spec.flags || "").includes("i") ? "i" : "");

/** Index over a list of Gramps json_data objects. */
export function buildTree(objects) {
  const list = (objects || []).filter((o) => o && typeof o === "object" && !Array.isArray(o));
  const byHandle = new Map();
  for (const o of list) if (typeof o.handle === "string") byHandle.set(o.handle, o);
  const birthRefHandles = new Set();
  for (const p of list) {
    if (p._class !== "Person") continue;
    const refs = arr(p.event_ref_list);
    if (isInt(p.birth_ref_index) && p.birth_ref_index >= 0 && p.birth_ref_index < refs.length && isObj(refs[p.birth_ref_index])) birthRefHandles.add(refs[p.birth_ref_index].ref);
  }
  return { objects: list, byHandle, birthRefHandles, _birthCitations: null };
}

const asTree = (t) => (t && t.byHandle instanceof Map ? t : buildTree(t));

/** Birth 12, Adult Christening 14, Baptism 15, Bless 18, Christen 22, Stillbirth 45, a custom type matching the birth pattern,
 *  and any event a person references at its birth_ref_index. For everyone, living or deceased. */
export function isBirthLike(event, tree, policy) {
  const pol = policy.birthLike;
  const etype = obj(event.type);
  if (isInt(etype.value)) {
    if (values(pol.eventTypes).has(etype.value)) return true;
    if (etype.value === pol.customType.value && compilePattern(pol.customType).test(typeof etype.string === "string" ? etype.string : "")) return true;
  }
  return asTree(tree).birthRefHandles.has(event.handle);
}

/** Handles of the citations referenced by a birth-like event or by an EventRef that points at one. */
export function birthCitationHandles(tree, policy) {
  const t = asTree(tree);
  if (t._birthCitations) return t._birthCitations;
  const out = new Set();
  for (const e of t.objects) if (e._class === "Event" && isBirthLike(e, t, policy)) for (const c of arr(e.citation_list)) out.add(c);
  for (const h of t.objects) {
    if (h._class !== "Person" && h._class !== "Family") continue;
    for (const ref of arr(h.event_ref_list)) {
      if (!isObj(ref)) continue;
      const ev = t.byHandle.get(ref.ref);
      if (ev && isBirthLike(ev, t, policy)) for (const c of arr(ref.citation_list)) out.add(c);
    }
  }
  t._birthCitations = out;
  return out;
}

// ---- dates

/** Gramps' day number for the Gregorian (0) and Julian (1) calendars, else null (gramps/gen/lib/gcalendar.py). */
export function sdn(calendar, year, month, day) {
  let y = year < 0 ? year + 4801 : year + 4800;
  let m = month;
  if (m > 2) m -= 3;
  else {
    m += 9;
    y -= 1;
  }
  if (calendar === 0) return Math.floor((Math.floor(y / 100) * 146097) / 4) + Math.floor(((y % 100) * 1461) / 4) + Math.floor((m * 153 + 2) / 5) + day - 32045;
  if (calendar === 1) return Math.floor((y * 1461) / 4) + Math.floor((m * 153 + 2) / 5) + day - 32083;
  return null;
}

export function reducedSortval(dateval, calendar, policy) {
  const year = dateval.length > 2 ? dateval[2] : 0;
  if (!year || !isInt(year) || !policy.dates.sortvalCalendars.includes(calendar)) return 0;
  return sdn(calendar, year, 1, 1);
}

/** Pointers (relative to the date) where a birth-like date still shows a day, a month or non-year text. */
export function dateViolations(date, policy) {
  const cfg = policy.dates;
  if (date === null || date === undefined) return [];
  if (!isObj(date)) return [""];
  const out = [];
  const dv = arr(date.dateval);
  for (const i of cfg.dayMonthIndexes) if (i < dv.length && dv[i]) out.push(`/dateval/${i}`);
  const text = date.text;
  if (text !== null && text !== undefined && typeof text !== "string") out.push("/text");
  else if (text && !new RegExp(cfg.bareYearTextPattern).test(text)) out.push("/text");
  return out;
}

/** The birth-like projection of one Gramps Date: no day or month, empty text, TEXTONLY turned into its first four-digit year
 *  (or an empty date), sortval recomputed. Returns a new object. A value that is not an object becomes an empty Date. */
export function reduceDate(date, policy) {
  const cfg = policy.dates;
  const out = isObj(date) ? JSON.parse(JSON.stringify(date)) : { _class: "Date", calendar: 0, format: null, modifier: 0, newyear: 0, quality: 0 };
  let dv = Array.isArray(out.dateval) && out.dateval.length ? out.dateval : [0, 0, 0, false];
  for (const i of cfg.dayMonthIndexes) if (i < dv.length) dv[i] = 0;
  if (out.modifier === cfg.textOnlyModifier) {
    const m = new RegExp(cfg.textOnlyYearPattern).exec(typeof out.text === "string" ? out.text : "");
    dv = [0, 0, m ? parseInt(m[1], 10) : 0, false];
    out.modifier = 0;
  }
  out.dateval = dv;
  out.text = "";
  out.sortval = reducedSortval(dv, out.calendar === undefined ? 0 : out.calendar, policy);
  return out;
}

// ---- places and coordinates

/** The rule id that excludes this place by its type, or null. */
export function placeExclusionRule(place, policy) {
  const pol = policy.places;
  const ptype = obj(obj(place).place_type);
  if (values(pol.excludedTypes).has(ptype.value)) return "place.exclude.type";
  if (ptype.value === pol.customHomeLike.value && compilePattern(pol.customHomeLike).test(typeof ptype.string === "string" ? ptype.string : "")) return "place.exclude.custom_home_like";
  return null;
}

/** True when the place code stays local: every type below the administrative level. */
export const placeCodeIsLocal = (place, policy) => !values(policy.places.administrativeTypes).has(obj(obj(place).place_type).value);

/** A latitude or longitude string rounded half away from zero to the policy's decimals. "" stays "", a value that is not a
 *  plain decimal returns null (blank it): a finer value must never pass. */
export function roundCoordinate(text, policy) {
  const pol = policy.places;
  if (text === "") return "";
  if (typeof text !== "string" || !new RegExp(pol.coordinatePattern).test(text)) return null;
  const digits = pol.coordinateDecimals;
  const sign = text.startsWith("-") ? "-" : "";
  const body = text.replace(/^[+-]+/, "");
  const dot = body.indexOf(".");
  const whole = dot < 0 ? body : body.slice(0, dot);
  const frac = dot < 0 ? "" : body.slice(dot + 1);
  if (frac.length <= digits) return text;
  const scaled = BigInt(whole + frac.slice(0, digits)) + (frac[digits] >= "5" ? 1n : 0n);
  const s = scaled.toString().padStart(digits + 1, "0");
  const out = digits ? `${s.slice(0, -digits)}.${s.slice(-digits)}` : s;
  return (scaled === 0n ? "" : sign) + out;
}

export const coordinateIsFine = (text, policy) => text !== "" && roundCoordinate(text, policy) !== text;

// ---- attributes and rects

/** "birth.attribute.age_time", "contact.attribute.government_id" or null for one Gramps Attribute element. */
export function attributeRule(attr, policy) {
  if (!isObj(attr) || attr._class !== "Attribute") return null;
  const value = obj(attr.type).value;
  if (values(policy.attributes.ageAndTime).has(value)) return "birth.attribute.age_time";
  if (values(policy.attributes.governmentId).has(value)) return "contact.attribute.government_id";
  return null;
}

/** null for a usable rectangle, "full_frame" for [0,0,100,100], "degenerate_or_float" for a rectangle to hold. */
export function rectProblem(rect, policy) {
  const pol = policy.media;
  if (rect === null || rect === undefined) return null;
  const [lo, hi] = pol.rectRange;
  if (!Array.isArray(rect) || rect.length !== 4 || rect.some((v) => typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v))
    || rect.some((v) => v < lo || v > hi) || rect[0] >= rect[2] || rect[1] >= rect[3]) return "degenerate_or_float";
  return rect.every((v, i) => v === pol.fullFrameRect[i]) ? "full_frame" : null;
}
