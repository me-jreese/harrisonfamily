// /me/requests/: the pure model of the access-requests island (HFY-TSK-264, surf-access-admin-ui; surfaces.md 7.4 and 7.10, BRD2 D2-23,
// reviews PS-13 and IF-06). No DOM, no network: the tabs, the voice, the candidate matcher, the place matcher, the editable Gramps preview,
// the decision bodies and the error words, so node tests run all of it on invented rows.
//
// The matcher scores the family index (/person/index.json rows) against what the requester typed: maiden surname, given-name tokens,
// birth year within 2, birthplace. It never decides anything: an admin presses "it's them". Places are matched against the gated
// /place/index.json (rows {handle, grampsId, displayName}), client side, as surfaces.md 7.3 says (no new API IAM).
import { parsePlace } from "../../../shared/legacy-form.mjs";

// ---------------------------------------------------------------------------------------------------------------- the words (DS voice)
export const COPY = Object.freeze({
  notAdmin: "this page is for the people who look after the site.",
  signedOut: "sign in to see family requests.",
  loadFailed: "that didn't work. try again in a minute.",
  empty: Object.freeze({ waiting: "nobody is waiting.", tree: "nobody is waiting to be added to the tree.", done: "nothing here yet." }),
  whoIsThis: "who is this?",
  noCandidates: "nobody in the tree looks like a match.",
  theyAreNew: "they're new",
  decline: "not now / decline",
  includeNote: "include this note in the email",
  confirmedOutside: "confirmed with this person outside the site",
  confirmedOutsideNeeded: "confirm with this person outside the site first.",
  emailHidden: "email (hidden, we email them for you)",
  done: "done. we emailed them.",
  doneNoEmail: "done, but the email didn't send. let them know yourself.",
  doneNoMail: "done. we didn't email them for this one.",
  doneRemoved: "done. their access is removed.",
  letThemIn: "let them in",
  notYet: "not yet",
  remove: "remove",
  keep: "keep",
});

export const giveAccessPrompt = (name, person) => `give ${name} access as ${person}?`;
export const removePrompt = (name) => `remove ${name}'s access?`;

/** The tabs: the list `state` the API takes, and the plain words. */
export const TABS = Object.freeze([
  Object.freeze({ id: "waiting", label: "waiting", state: "pending" }),
  Object.freeze({ id: "tree", label: "adding to the tree", state: "awaiting_record" }),
  Object.freeze({ id: "done", label: "done", state: "done" }),
]);
export const DEFAULT_TAB = "waiting";
export const tabById = (id) => TABS.find((t) => t.id === id) || TABS[0];

/** The plain words for a request's state. */
export const STATE_WORDS = Object.freeze({
  pending: "waiting",
  awaiting_record: "adding to the tree",
  active: "let in",
  declined: "declined",
  revoked: "access removed",
  expired: "expired",
});
export const stateWords = (s) => STATE_WORDS[s] || "done";

/** `?tab=&id=` of the page address; an unknown tab falls back to the first. */
export function parseLocation(search) {
  const q = new URLSearchParams(search || "");
  const id = q.get("id");
  return { tab: tabById(q.get("tab")).id, id: id && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null };
}
export function locationFor({ tab, id }) {
  const q = new URLSearchParams();
  if (tab && tab !== DEFAULT_TAB) q.set("tab", tab);
  if (id) q.set("id", id);
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** "asked 3 days ago": the relative time, in whole units (just now / minutes / hours / days / weeks / months). */
export function askedAgo(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  const unit = (n, w) => `asked ${n} ${w}${n === 1 ? "" : "s"} ago`;
  if (s < 60) return "asked just now";
  if (s < 3600) return unit(Math.floor(s / 60), "minute");
  if (s < 86400) return unit(Math.floor(s / 3600), "hour");
  if (s < 7 * 86400) return unit(Math.floor(s / 86400), "day");
  if (s < 30 * 86400) return unit(Math.floor(s / (7 * 86400)), "week");
  return unit(Math.floor(s / (30 * 86400)), "month");
}

export const properCase = (s) => String(s || "").trim().replace(/\s+/g, " ").toLowerCase().replace(/(^|[\s'’-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
/** The name as entered, in proper case: "{givenNames} {maidenSurname}". */
export const requesterName = (r) => [r?.givenNames, r?.maidenSurname].filter((x) => typeof x === "string" && x.trim()).map(properCase).join(" ");
/** `born {year} · {birthPlace}`; a missing half is left out. */
export function bornLine(r) {
  const year = Number.isInteger(r?.birthYear) ? String(r.birthYear) : typeof r?.birthYear === "string" && r.birthYear ? r.birthYear : "";
  const place = typeof r?.birthPlace === "string" ? r.birthPlace.trim() : "";
  return [year && `born ${year}`, place].filter(Boolean).join(" · ");
}

/** The answers as a label/value list, from the detail's `form` (the email is shown separately, masked). */
export const ANSWER_ROWS = Object.freeze([
  ["givenNames", "given names"], ["maidenSurname", "last name at birth"], ["nickname", "what the family calls them"], ["gender", "gender"],
  ["birthYear", "born"], ["birthPlace", "born in"], ["currentPlace", "lives in"], ["movedYear", "moved to the region"], ["everMarried", "ever married"],
  ["university", "university"], ["graduationYear", "graduated"], ["otherDegrees", "other degrees"], ["otherInstitutions", "from"], ["otherDegreeYears", "degree years"],
]);
const EVER_MARRIED_WORDS = Object.freeze({
  married_once_still: "married once, still married", married_once_widowed: "married once, widowed", married_once_divorced: "married once, divorced",
  married_more_than_once: "married more than once", never_married: "never married",
});
export function answersOf(form) {
  const f = form && typeof form === "object" ? form : {};
  const rows = [];
  for (const [key, label] of ANSWER_ROWS) {
    let v = f[key];
    if (Array.isArray(v)) v = v.join(", ");
    if (v === undefined || v === null || v === "") continue;
    if (key === "everMarried") v = EVER_MARRIED_WORDS[v] || String(v);
    rows.push({ key, label, value: String(v) });
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------------------------- name and place matching
/** Lowercase letters only, accents folded: "Zoë O'Neil" -> "zoe oneil". */
export const fold = (s) => String(s ?? "").normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[^\p{L}\s]/gu, "").replace(/\s+/g, " ").trim();
const tokens = (s) => fold(s).split(" ").filter(Boolean);

/** Given-name overlap in [0, 1]: the share of the requester's given-name tokens found among the person's (a one-letter token matches an initial). */
export function givenOverlap(requested, personGiven) {
  const want = tokens(requested);
  const have = tokens(personGiven);
  if (!want.length || !have.length) return 0;
  let hits = 0;
  for (const w of want) if (have.some((h) => h === w || (w.length === 1 && h.startsWith(w)) || (h.length === 1 && w.startsWith(h)))) hits += 1;
  return hits / want.length;
}

export const SCORE = Object.freeze({ surname: 4, given: 4, yearExact: 3, yearNear: 2, yearFar: 1, place: 2 });
export const MAX_CANDIDATES = 5;

const yearOf = (v) => {
  const n = typeof v === "string" && /^\d{4}$/.test(v) ? Number(v) : v;
  return Number.isInteger(n) ? n : null;
};

function surnameOf(row) {
  if (typeof row?.surname === "string" && row.surname.trim()) return row.surname;
  const parts = tokens(row?.displayName);
  return parts.length ? parts[parts.length - 1] : "";
}
function givenOf(row) {
  if (typeof row?.givenName === "string" && row.givenName.trim()) return row.givenName;
  const parts = tokens(row?.displayName);
  return parts.slice(0, -1).join(" ");
}

/**
 * Places for what the requester typed ("City, ST"): the /place/index.json rows whose first segment is the city and, when a state was
 * given, whose other segments name it. `rows` is [{handle, grampsId, displayName}]. A bare city matches every place of that name (the
 * caller flags it as ambiguous when there are several).
 */
export function matchPlaces(raw, rows) {
  const { city, state } = parsePlace(String(raw ?? ""));
  const c = fold(city);
  if (!c || !Array.isArray(rows)) return [];
  const s = fold(state);
  const out = [];
  for (const row of rows) {
    if (!row || typeof row.handle !== "string") continue;
    const segs = String(row.displayName ?? "").split(",").map(fold);
    if (segs[0] !== c) continue;
    if (s && !segs.slice(1).includes(s)) continue;
    out.push({ handle: row.handle, grampsId: row.grampsId ?? "", displayName: String(row.displayName ?? "") });
  }
  return out;
}

/** A row's free-text birth place against the requested one: the first comma segment must equal the city, and the state must appear when given. */
function textPlaceMatches(wanted, have) {
  if (typeof have !== "string" || !have) return false;
  const { city, state } = parsePlace(String(wanted ?? ""));
  const c = fold(city);
  if (!c) return false;
  const segs = have.split(",").map(fold);
  if (segs[0] !== c) return false;
  const st = fold(state);
  return !st || segs.slice(1).includes(st);
}

/**
 * Score one family-index row against a request (`{givenNames, maidenSurname, birthYear, birthPlace}`). `placeHandles` is the set of
 * handles matchPlaces found for the request's birthplace. Returns `{score, reasons[]}`; a row with neither a surname nor a given-name match
 * scores 0, so a shared birth year alone never makes a candidate.
 */
export function scoreCandidate(req, row, { placeHandles = new Set() } = {}) {
  const reasons = [];
  let score = 0;
  const sur = fold(req?.maidenSurname);
  if (sur && sur === fold(surnameOf(row))) { score += SCORE.surname; reasons.push("last name"); }
  const g = givenOverlap(req?.givenNames, givenOf(row));
  if (g > 0) { score += SCORE.given * g; reasons.push("first name"); }
  if (!reasons.length) return { score: 0, reasons: [] };
  const want = yearOf(req?.birthYear);
  const have = yearOf(row?.birthYear);
  if (want !== null && have !== null) {
    const d = Math.abs(want - have);
    if (d === 0) { score += SCORE.yearExact; reasons.push("birth year"); }
    else if (d === 1) { score += SCORE.yearNear; reasons.push("birth year within 1"); }
    else if (d === 2) { score += SCORE.yearFar; reasons.push("birth year within 2"); }
  }
  const hasPlace = (typeof row?.birthPlaceHandle === "string" && placeHandles.has(row.birthPlaceHandle)) || textPlaceMatches(req?.birthPlace, row?.birthPlace);
  if (hasPlace) { score += SCORE.place; reasons.push("birthplace"); }
  return { score, reasons };
}

/** "Name, 1962 to 2001" / "Name, born 1962": the display name with the lifespan the index holds. */
export function lifespanLine(row) {
  const s = typeof row?.lifespanSummary === "string" ? row.lifespanSummary.trim() : "";
  if (s) return s;
  const b = yearOf(row?.birthYear);
  return b === null ? "" : `born ${b}`;
}

/**
 * The top candidates for a request, best first: living people only (an access approval links a living person; a deceased row is never
 * offered), ties by name then id. `people` is the family index's rows, `places` the place index's rows (both may be empty).
 * Each result is `{id, name, line, score, reasons}`.
 */
export function rankCandidates(req, people, places = [], { limit = MAX_CANDIDATES } = {}) {
  if (!Array.isArray(people)) return [];
  const placeHandles = new Set(matchPlaces(req?.birthPlace, places).map((p) => p.handle));
  const out = [];
  for (const row of people) {
    if (!row || typeof row.grampsId !== "string" || row.isLiving === false) continue;
    const { score, reasons } = scoreCandidate(req, row, { placeHandles });
    if (score > 0) out.push({ id: row.grampsId, name: String(row.displayName || row.grampsId), line: lifespanLine(row), score: Math.round(score * 100) / 100, reasons });
  }
  out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return out.slice(0, limit);
}

// ---------------------------------------------------------------------------------------------------------------- the editable Gramps preview
const clone = (v) => JSON.parse(JSON.stringify(v));
export const GENDER_WORDS = Object.freeze({ 0: "female", 1: "male" });

/** The preview's editable fields: `{given, surname, nick, gender, birthYear}`. */
export function previewFields(preview) {
  const p = preview?.person;
  const n = p?.primary_name;
  const birth = (preview?.events || []).find((e) => e?.type?.value === 12);
  const y = Array.isArray(birth?.date?.dateval) ? birth.date.dateval[2] : 0;
  return {
    given: n?.first_name ?? "",
    surname: n?.surname_list?.[0]?.surname ?? "",
    nick: n?.nick ?? "",
    gender: p?.gender ?? 1,
    birthYear: y ? String(y) : "",
  };
}

/** A copy of the preview with one editable field changed (given, surname, nick, gender, birthYear). */
export function editPreview(preview, field, value) {
  const next = clone(preview);
  const name = next.person.primary_name;
  if (field === "given") name.first_name = String(value);
  else if (field === "surname") name.surname_list = [{ ...(name.surname_list?.[0] || { _class: "Surname", primary: true }), surname: String(value) }];
  else if (field === "nick") { if (String(value).trim()) name.nick = String(value); else delete name.nick; }
  else if (field === "gender") next.person.gender = Number(value) === 0 ? 0 : 1;
  else if (field === "birthYear") {
    const birth = next.events.find((e) => e?.type?.value === 12);
    if (birth) birth.date = { ...(birth.date || {}), dateval: [0, 0, /^\d{4}$/.test(String(value)) ? Number(value) : 0, false] };
  }
  return next;
}

/** A copy with the names in proper case ("tessa" -> "Tessa"): the editor opens with what the family would write; the admin can change it. */
export function tidyPreviewNames(preview) {
  const f = previewFields(preview);
  return editPreview(editPreview(preview, "given", properCase(f.given)), "surname", properCase(f.surname));
}

/** A copy with the event `eventKey`'s place set to a Place handle ("" clears it: the place is then added later, by hand). */
export function setEventPlace(preview, eventKey, handle) {
  const next = clone(preview);
  const ev = next.events.find((e) => e?.hfyKey === eventKey);
  if (ev) ev.place = typeof handle === "string" ? handle : "";
  return next;
}

/**
 * Each place query of the preview with its matches: `[{eventKey, role, raw, matches[], chosen}]`. When there is exactly one match it is
 * chosen already; with several or none the admin picks (or leaves it empty).
 */
export function placeChoices(preview, places) {
  const queries = Array.isArray(preview?.placeQueries) ? preview.placeQueries : [];
  return queries.map((q) => {
    const matches = matchPlaces(q.raw, places);
    const ev = (preview?.events || []).find((e) => e?.hfyKey === q.eventKey);
    return { eventKey: q.eventKey, role: q.role, raw: q.raw ?? "", matches, chosen: typeof ev?.place === "string" ? ev.place : "", ambiguous: matches.length > 1 };
  });
}

/** The preview with every query that has exactly one match set to it (and nothing else touched). */
export function applyUniquePlaces(preview, places) {
  let next = preview;
  for (const c of placeChoices(preview, places)) if (c.matches.length === 1 && !c.chosen) next = setEventPlace(next, c.eventKey, c.matches[0].handle);
  return next;
}

// ---------------------------------------------------------------------------------------------------------------- decisions
/** The body of "it's them". `confirmedOutside` is the required checkbox (the server refuses anything but true). */
export const linkBody = ({ grampsId, version, confirmedOutside, allowSecondEmail }) => ({
  decision: "link", grampsId, version, confirmedOutside: confirmedOutside === true, ...(allowSecondEmail === true ? { allowSecondEmail: true } : {}),
});
export const newBody = ({ preview, version, confirmedOutside }) => ({ decision: "new", preview, version, confirmedOutside: confirmedOutside === true });
export function declineBody({ note, sendNote, version }) {
  const text = typeof note === "string" ? note.trim() : "";
  return { decision: "decline", version, ...(text ? { note: text, sendNote: sendNote === true } : {}) };
}
export const revokeBody = ({ version, confirmedOutside, reason }) => ({ version, confirmedOutside: confirmedOutside === true, ...(typeof reason === "string" && reason.trim() ? { reason: reason.trim() } : {}) });

/** The result line for a decision answer `{state, emailSent}`. `mail: false` is a decision that sends none (revoke). */
export function resultLine(answer, { revoke = false } = {}) {
  if (revoke) return COPY.doneRemoved;
  if (answer && answer.emailSent === false) return COPY.doneNoEmail;
  if (answer && answer.emailSent === true) return COPY.done;
  return COPY.doneNoMail;
}

/**
 * What an API error means for the admin: `{kind, text}`. kinds: signin (a fresh sign-in is needed), reload (the request changed),
 * second (the person already has access with another email), field (a validation problem), plain.
 */
export function describeError(err) {
  const status = err?.status;
  const code = err?.code;
  if (status === 401 && code === "step_up_required") return { kind: "signin", text: "to do this, sign in again first." };
  if (status === 401) return { kind: "signin", text: "your sign-in ran out. sign in again." };
  if (status === 403 && code === "owner_only") return { kind: "plain", text: "only the owner of the site can allow a second email." };
  if (status === 403) return { kind: "plain", text: COPY.notAdmin };
  if (status === 404) return { kind: "reload", text: "that request isn't there anymore." };
  if (status === 409 && code === "already_member") return { kind: "plain", text: "that email can already sign in." };
  if (status === 409 && code === "second_email") return { kind: "second", text: "this person can already sign in with another email. adding this one gives them a second way in, and we tell them first." };
  if (status === 409) return { kind: "reload", text: "this request changed while you were looking. reload it, then try again." };
  if (status === 422 && code === "unknown_person") return { kind: "plain", text: "that person isn't in the tree." };
  if (status === 422 && code === "not_living") return { kind: "plain", text: "that person isn't living, so they can't be linked to a sign-in." };
  if (status === 422 && code === "contact_info") return { kind: "plain", text: "that looks like contact details. take them out, then send." };
  if (status === 400 || status === 422) return { kind: "field", text: "something in that isn't right. check the highlighted answers.", errors: Array.isArray(err?.errors) ? err.errors : [] };
  return { kind: "plain", text: COPY.loadFailed };
}
