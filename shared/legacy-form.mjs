// The Legacy Form, sections 1 and 2: fields, validation and the Gramps mapping (HFY-PLN-002 surfaces.md 7.3; task
// surf-legacy-form-schema). The join form is the anonymous requester's side of the access-request flow: the edge validates the
// submit body with validateForm() and the admin UI previews mapToGramps(). Pure ESM; the only import is the one R-18 detector
// (shared/ rule: relative imports only), so it runs in the browser, the auth edge, hfy-api and a Worker.
//
// Privacy (R-18, R-19): the form asks for a birth YEAR only. Nothing here can produce a birth month or day: every date the
// mapping emits is {dateval: [0, 0, YEAR, false]}. Free-text fields run through the shared detector, and the place fields also
// refuse runs of 3+ digits and street-suffix patterns (the residence is city and state only, SURF-D16).
// The gender question is male or female, required, as on the Legacy Form (BRD2 11.4, Q2-17 line 9): no 'other', no free text.

import { rejectContactInfo } from "./privacy-guard.mjs";

/** Gramps 6 codes used by the mapping (gen/lib: Person.FEMALE 0 / MALE 1, EventType, NameType, Date modifiers). */
export const GRAMPS = Object.freeze({
  GENDER: Object.freeze({ female: 0, male: 1 }),
  EVENT: Object.freeze({ BIRTH: 12, DEGREE: 25, GRADUATION: 31, RESIDENCE: 42 }),
  ROLE_PRIMARY: 1,
  NAME_BIRTH: 2,
  MOD_NONE: 0,
  MOD_FROM: 7,
});

export const YEAR_RE = /^(19|20)\d{2}$/;
export const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M} .'’-]*$/u;
export const EVER_MARRIED = Object.freeze([
  "married_once_still", "married_once_widowed", "married_once_divorced", "married_more_than_once", "never_married",
]);
export const GENDERS = Object.freeze(["male", "female"]);
/** The youngest and oldest a requester can be (surfaces.md 7.3): birthYear is within [year - 110, year]. */
export const MAX_AGE = 110;
export const MIN_GRADUATION_AGE = 10;
export const MAX_DEGREE_YEARS = 5;

export const ERROR_CODES = Object.freeze([
  "required", "invalid", "too_long", "year_format", "year_range", "digits_not_allowed", "street_not_allowed", "not_empty",
  "must_be_true", "too_many", "contact_info", "dob_not_allowed",
]);

/**
 * Keys, labels, required flags and the Legacy Form section (1 or 2) of every field. `kind` drives the renderer; `max` is the
 * length bound; `pii` marks free text that must pass the R-18 detector. `company` is the hidden honeypot and is not listed.
 */
export const FIELDS = Object.freeze([
  { key: "email", section: 1, label: "your email", required: true, kind: "email", max: 254 },
  { key: "givenNames", section: 1, label: "your given names (first and middle, like on your birth certificate)", required: true, kind: "name", max: 100, pii: true },
  { key: "maidenSurname", section: 1, label: "your last name at birth", required: true, kind: "name", max: 60, pii: true },
  { key: "gender", section: 1, label: "gender", required: true, kind: "choice", options: GENDERS },
  { key: "nickname", section: 1, label: "what does the family call you?", required: false, kind: "text", max: 40, pii: true },
  { key: "birthPlace", section: 1, label: "where were you born? city and state", required: true, kind: "place", max: 100, pii: true },
  { key: "birthYear", section: 1, label: "what year were you born? (just the year. we never ask for your full birthday.)", required: true, kind: "year" },
  { key: "currentPlace", section: 1, label: "where do you live now? city and state is plenty", required: true, kind: "place", max: 100, pii: true },
  { key: "movedYear", section: 1, label: "what year did you move to your region? (moving a few counties over doesn't count)", required: false, kind: "year" },
  { key: "everMarried", section: 1, label: "were you ever married?", required: false, kind: "choice", options: EVER_MARRIED },
  { key: "university", section: 2, label: "if you graduated from a university, which one?", required: false, kind: "text", max: 120, pii: true },
  { key: "graduationYear", section: 2, label: "what year did you graduate?", required: false, kind: "year" },
  { key: "otherDegrees", section: 2, label: "any other degrees?", required: false, kind: "text", max: 200, pii: true },
  { key: "otherInstitutions", section: 2, label: "from which school(s)?", required: false, kind: "text", max: 200, pii: true },
  { key: "otherDegreeYears", section: 2, label: "in what year(s)?", required: false, kind: "years", max: MAX_DEGREE_YEARS },
  { key: "forSelf", section: 2, label: "this is about me, not someone else", required: true, kind: "confirm" },
].map((f) => Object.freeze(f)));

// ------------------------------------------------------------------ place rules

// Street words that mark an address wherever they follow another word ("main street"). City names that are one of these words
// on their own ("Circle", "Court") pass because nothing precedes them.
const STREET_WORDS = "street|avenue|boulevard|road|drive|lane|court|circle|highway|parkway|terrace|trail|place|route|suite|apartment|apt|unit";
// Abbreviations count only before a comma or the end ("Main St, Town"), so "St. Louis" passes. "CT" in capitals is Connecticut.
const STREET_ABBR = "st|ave|blvd|rd|dr|ln|ct|pl|hwy|pkwy|cir|ter|trl|rt|ste";
const STREET_WORD_RE = new RegExp(`[\\p{L}\\p{M}][\\p{L}\\p{M}'’.-]*\\s+(?:${STREET_WORDS})\\b`, "iu");
const STREET_ABBR_RE = new RegExp(`[\\p{L}\\p{M}][\\p{L}\\p{M}'’.-]*\\s+(${STREET_ABBR})\\.?(?=\\s*(?:,|$))`, "giu");

/** True when `text` reads like a street address. */
export function looksLikeStreet(text) {
  if (STREET_WORD_RE.test(text)) return true;
  for (const m of text.matchAll(STREET_ABBR_RE)) {
    if (m[1] === "CT") continue; // Connecticut, not "court"
    return true;
  }
  return false;
}

/** True when `text` holds a run of 3 or more decimal digits (any script: the detector folds Unicode digits the same way). */
export const hasDigitRun = (text) => /\p{Nd}{3,}/u.test(text);

const STATES = Object.freeze({
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
  DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts",
  MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada",
  NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota",
  OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
  TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia",
  WI: "Wisconsin", WY: "Wyoming",
});

/**
 * "City, ST" or "City, State" to {raw, city, state}; state abbreviations are expanded. A string with no comma is all city.
 * Used for the place queries the admin UI matches against the gated place index.
 */
export function parsePlace(raw) {
  const parts = String(raw).split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return { raw, city: parts[0] || "", state: "" };
  const last = parts[parts.length - 1];
  const abbr = last.replace(/\./g, "").toUpperCase();
  const state = STATES[abbr] && last.replace(/\./g, "").length === 2 ? STATES[abbr] : last;
  return { raw, city: parts.slice(0, -1).join(", "), state };
}

// ------------------------------------------------------------------ validation

const str = (v) => (typeof v === "string" ? v.trim() : "");
const isBlank = (v) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

/** The current year for the bounds: `opts.year` (tests), else `opts.now` (a Date or ms), else the clock. */
function currentYear(opts) {
  if (opts && Number.isInteger(opts.year)) return opts.year;
  const d = opts && opts.now !== undefined ? new Date(opts.now) : new Date();
  return d.getUTCFullYear();
}

/**
 * Validates a submitted form. Returns `{ ok: true, value }` with the normalized form (trimmed strings, lower-cased email, years
 * as numbers, otherDegreeYears as an array; unknown keys dropped), or `{ ok: false, fields: [{ field, code }] }` with one entry
 * per bad field (the first failing rule), in FIELDS order and no matched text. `opts.year` / `opts.now` set the clock.
 * @param {object} form
 * @param {{ year?: number, now?: Date | number }} [opts]
 */
export function validateForm(form, opts = {}) {
  const f = form !== null && typeof form === "object" && !Array.isArray(form) ? form : {};
  const year = currentYear(opts);
  const errors = [];
  const value = {};
  const fail = (field, code) => { errors.push({ field, code }); };

  // honeypot
  if (!isBlank(f.company)) fail("company", "not_empty");

  const scan = (key, text) => {
    const r = rejectContactInfo(text);
    if (!r.ok) { fail(key, r.code); return false; }
    return true;
  };

  const yearField = (key, v, lo, hi, required) => {
    if (isBlank(v)) {
      if (required) fail(key, "required");
      return undefined;
    }
    const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
    if (!YEAR_RE.test(s)) { fail(key, "year_format"); return undefined; }
    const n = Number(s);
    if (n < lo || n > hi) { fail(key, "year_range"); return undefined; }
    return n;
  };

  const textField = (spec, v) => {
    const key = spec.key;
    if (isBlank(v)) {
      if (spec.required) fail(key, "required");
      return;
    }
    if (typeof v !== "string") return fail(key, "invalid");
    const s = v.trim();
    if (s.length > spec.max) return fail(key, "too_long");
    if (spec.kind === "name") {
      if (!NAME_RE.test(s) || / {2,}/.test(s)) return fail(key, "invalid");
    }
    if (spec.kind === "place") {
      if (hasDigitRun(s)) return fail(key, "digits_not_allowed");
      if (looksLikeStreet(s)) return fail(key, "street_not_allowed");
    }
    if (spec.pii && !scan(key, s)) return;
    value[key] = s;
  };

  // email (RFC-lite; the edge also checks it equals the ticket's email)
  {
    const s = str(f.email).toLowerCase();
    if (!s) fail("email", "required");
    else if (s.length > 254) fail("email", "too_long");
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) fail("email", "invalid");
    else value.email = s;
  }

  textField(FIELDS[1], f.givenNames);
  textField(FIELDS[2], f.maidenSurname);

  if (isBlank(f.gender)) fail("gender", "required");
  else if (!GENDERS.includes(f.gender)) fail("gender", "invalid");
  else value.gender = f.gender;

  textField(FIELDS[4], f.nickname);
  textField(FIELDS[5], f.birthPlace);

  const birthYear = yearField("birthYear", f.birthYear, year - MAX_AGE, year, true);
  if (birthYear !== undefined) value.birthYear = birthYear;

  textField(FIELDS[7], f.currentPlace);

  // The lower bounds depend on the birth year; when it is missing or bad they fall back to the widest legal range.
  const lowBound = birthYear !== undefined ? birthYear : year - MAX_AGE;
  const moved = yearField("movedYear", f.movedYear, lowBound, year, false);
  if (moved !== undefined) value.movedYear = moved;

  if (!isBlank(f.everMarried)) {
    if (!EVER_MARRIED.includes(f.everMarried)) fail("everMarried", "invalid");
    else value.everMarried = f.everMarried;
  }

  textField(FIELDS[10], f.university);
  const grad = yearField("graduationYear", f.graduationYear, birthYear !== undefined ? birthYear + MIN_GRADUATION_AGE : year - MAX_AGE, year, false);
  if (grad !== undefined) value.graduationYear = grad;
  textField(FIELDS[12], f.otherDegrees);
  textField(FIELDS[13], f.otherInstitutions);

  // otherDegreeYears: a comma or space list (or an array), at most 5, each a legal year not before the birth year
  {
    const raw = f.otherDegreeYears;
    if (!isBlank(raw) && !(Array.isArray(raw) && raw.length === 0)) {
      const items = Array.isArray(raw) ? raw.map((x) => String(x).trim()) : typeof raw === "string" ? raw.split(/[\s,]+/).filter(Boolean) : null;
      if (items === null) fail("otherDegreeYears", "invalid");
      else if (items.length > MAX_DEGREE_YEARS) fail("otherDegreeYears", "too_many");
      else if (items.some((y) => !YEAR_RE.test(y))) fail("otherDegreeYears", "year_format");
      else if (items.some((y) => Number(y) < lowBound || Number(y) > year)) fail("otherDegreeYears", "year_range");
      else value.otherDegreeYears = items.map(Number);
    }
  }

  if (!(f.forSelf === true || f.forSelf === "true")) fail("forSelf", isBlank(f.forSelf) || f.forSelf === false ? "required" : "must_be_true");
  else value.forSelf = true;

  if (errors.length) {
    const order = new Map(FIELDS.map((x, i) => [x.key, i]));
    errors.sort((a, b) => (order.get(a.field) ?? 99) - (order.get(b.field) ?? 99));
    return { ok: false, fields: errors };
  }
  return { ok: true, value };
}

// ------------------------------------------------------------------ Gramps mapping

/** A Gramps 6 Date fragment holding a year and nothing else (never a month or a day). */
const yearDate = (y, modifier = GRAMPS.MOD_NONE) => ({
  _class: "Date", calendar: 0, modifier, quality: 0, dateval: [0, 0, y, false], text: "", sortval: 0, newyear: 0, format: null,
});
const noDate = () => ({
  _class: "Date", calendar: 0, modifier: GRAMPS.MOD_NONE, quality: 0, dateval: [0, 0, 0, false], text: "", sortval: 0, newyear: 0, format: null,
});

const makeEvent = (key, type, date, description = "", extra = {}) => ({
  _class: "Event",
  hfyKey: key, // a local placeholder the admin UI swaps for a handle; EventRef.ref points at it
  type: { _class: "EventType", value: type },
  date,
  description,
  place: "", // filled from placeQueries[].eventKey by the admin UI after place matching
  ...extra,
});

/**
 * The Gramps-6 fragments for a validated form: `{ person, events[], placeQueries[] }`. Pure. The form is validated again here and
 * a bad form throws an Error whose `fields` carry the validateForm() entries, so an unvalidated form can never be mapped. The
 * email, everMarried and forSelf are not mapped. Dates are years only.
 *
 * `opts.storeCurrentCity` (default true, the Q2-11(a) default: city and state only, with the year moved) controls the Residence
 * event; pass false when io's recorded answer is no. `opts.year` / `opts.now` set the clock for validation.
 * @param {object} form
 * @param {{ storeCurrentCity?: boolean, year?: number, now?: Date | number }} [opts]
 */
export function mapToGramps(form, opts = {}) {
  const v = validateForm(form, opts);
  if (!v.ok) {
    const err = new Error("legacy form is invalid");
    err.fields = v.fields;
    throw err;
  }
  const x = v.value;
  const events = [];
  const placeQueries = [];
  const refs = [];
  const addEvent = (event) => {
    events.push(event);
    refs.push({ _class: "EventRef", ref: event.hfyKey, role: { _class: "EventRoleType", value: GRAMPS.ROLE_PRIMARY } });
    return event;
  };

  // Birth first: birth_ref_index is its position in event_ref_list (0).
  addEvent(makeEvent("birth", GRAMPS.EVENT.BIRTH, yearDate(x.birthYear)));
  placeQueries.push({ eventKey: "birth", role: "birth", ...parsePlace(x.birthPlace) });

  if (opts.storeCurrentCity !== false) {
    const date = x.movedYear !== undefined ? yearDate(x.movedYear, GRAMPS.MOD_FROM) : noDate();
    addEvent(makeEvent("residence", GRAMPS.EVENT.RESIDENCE, date));
    placeQueries.push({ eventKey: "residence", role: "residence", ...parsePlace(x.currentPlace) });
  }

  if (x.university !== undefined || x.graduationYear !== undefined) {
    addEvent(makeEvent("graduation", GRAMPS.EVENT.GRADUATION, x.graduationYear !== undefined ? yearDate(x.graduationYear) : noDate(), x.university || ""));
  }

  if (x.otherDegrees !== undefined || x.otherInstitutions !== undefined || x.otherDegreeYears !== undefined) {
    const description = [x.otherDegrees, x.otherInstitutions].filter(Boolean).join(" · ");
    const years = x.otherDegreeYears && x.otherDegreeYears.length ? x.otherDegreeYears : [undefined];
    years.forEach((y, i) => {
      addEvent(makeEvent(`degree-${i}`, GRAMPS.EVENT.DEGREE, y !== undefined ? yearDate(y) : noDate(), description, { needsReview: true }));
    });
  }

  const person = {
    _class: "Person",
    gender: GRAMPS.GENDER[x.gender],
    primary_name: {
      _class: "Name",
      type: { _class: "NameType", value: GRAMPS.NAME_BIRTH },
      first_name: x.givenNames,
      surname_list: [{ _class: "Surname", surname: x.maidenSurname, primary: true }],
      ...(x.nickname !== undefined ? { nick: x.nickname } : {}),
    },
    event_ref_list: refs,
    birth_ref_index: 0,
  };
  return { person, events, placeQueries };
}
