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
// Scope: this port holds the date, place, coordinate, attribute, rect and birth-like predicates, the URL channel rules (urlRules), the
// path-pattern matcher (matchPointers) and the read-only pointer helpers (pointerGet, escapePointerToken). The projection-only
// helpers of rules.py (pointer_set, pointer_remove) have no use on the server and are not ported. validator-js (api/src/sync/checker.js),
// the edit guard and the field policy (api/src/records/field-policy.js) import this file.
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

// ---- URLs

const SPECIAL_SCHEMES = ["http", "https", "ftp", "ws", "wss"];
// Python's str.strip() whitespace (not JavaScript's: it has \x1c-\x1f and \x85, and lacks \ufeff).
const PY_SPACE = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_STRIP = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, "g");

/** [scheme, host, path] of a Gramps Url path: lower-case scheme and host, path with its leading slash (rules.py _url_parts). */
export function urlParts(raw) {
  const s = (typeof raw === "string" ? raw : "").replace(PY_STRIP, "").replace(/\\/g, "/"); // a browser reads a backslash as a slash
  const m = /^([A-Za-z][A-Za-z0-9+.\-]*):([\s\S]*)$/.exec(s);
  let scheme = "";
  let rest = s;
  if (m && !/^[0-9]+(?:\/|(?=\n?$))/.test(m[2])) { // "host:8080/x" is a port, not a scheme
    scheme = m[1].toLowerCase();
    rest = m[2];
  }
  if (SPECIAL_SCHEMES.includes(scheme)) rest = rest.replace(/^\/+/, ""); // a browser takes https:/host and https:///host as https://host
  else if (rest.startsWith("//")) rest = rest.slice(2);
  else if (scheme) return [scheme, "", rest];
  const cut = rest.search(/[/?#]/);
  const authority = cut < 0 ? rest : rest.slice(0, cut);
  const path = cut < 0 ? "" : rest.slice(cut);
  let host = authority.slice(authority.lastIndexOf("@") + 1);
  const colon = host.indexOf(":");
  if (colon >= 0) host = host.slice(0, colon);
  return [scheme, host.toLowerCase().replace(/\.+$/, ""), path];
}

const hostMatches = (host, domain) => host === domain || host.endsWith(`.${domain}`);

/**
 * The contact rule ids that make one Gramps Url element local-only: contact.url.email_type, contact.url.channel and
 * contact.url.scan_hit. `scan(text)` is the shared detector reduced to a boolean-ish (a non-empty result is a hit).
 */
export function urlRules(url, scan, policy) {
  const pol = policy.urls;
  const u = obj(url);
  const out = [];
  if (obj(u.type).value === pol.emailType) out.push("contact.url.email_type");
  const [scheme, host, path] = urlParts(u.path);
  let channel = pol.schemes.includes(scheme) || pol.hosts.some((h) => hostMatches(host, h));
  if (!channel) channel = pol.paths.some((p) => hostMatches(host, p.host) && path.toLowerCase().startsWith(p.prefix));
  if (channel) out.push("contact.url.channel");
  const hit = (t) => { const r = scan(typeof t === "string" ? t : ""); return Array.isArray(r) ? r.length > 0 : Boolean(r); };
  if (hit(u.path) || hit(u.desc)) out.push("contact.url.scan_hit");
  return out;
}

// ---- RFC 6901 pointers and the path patterns of the rules

/** One object key as an RFC 6901 reference token. */
export const escapePointerToken = (key) => String(key).replace(/~/g, "~0").replace(/\//g, "~1");

/** `/a/{b,c/d}/e` -> `/a/b/e`, `/a/c/d/e`. */
export function expandBraces(pattern) {
  const m = /\{([^{}]*)\}/.exec(pattern);
  if (!m) return [pattern];
  const out = [];
  for (const alt of m[1].split(",")) out.push(...expandBraces(pattern.slice(0, m.index) + alt + pattern.slice(m.index + m[0].length)));
  return out;
}

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const children = (node) => (Array.isArray(node) ? node.map((v, i) => [String(i), v]) : isObj(node) ? Object.entries(node) : []);
const isIndex = (t) => /^[0-9]+$/.test(t);

function walk(node, segs, prefix, out) {
  if (!segs.length) {
    out.push(prefix);
    return;
  }
  const [head, ...rest] = segs;
  if (head === "**") {
    walk(node, rest, prefix, out);
    for (const [k, v] of children(node)) walk(v, segs, `${prefix}/${escapePointerToken(k)}`, out);
  } else if (head === "*") {
    for (const [k, v] of children(node)) walk(v, rest, `${prefix}/${escapePointerToken(k)}`, out);
  } else if (isObj(node) && hasOwn(node, head)) walk(node[head], rest, `${prefix}/${escapePointerToken(head)}`, out);
  else if (Array.isArray(node) && isIndex(head) && Number(head) < node.length) walk(node[Number(head)], rest, `${prefix}/${head}`, out);
}

// Sort key of a pointer: numeric tokens first and in numeric order, then text tokens (rules.py _pointer_key).
const pointerKey = (p) => p.split("/").slice(1).map((t) => (isIndex(t) ? [0, Number(t), ""] : [1, 0, t]));
function compareKeys(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    for (let j = 0; j < 3; j += 1) if (a[i][j] !== b[i][j]) return a[i][j] < b[i][j] ? -1 : 1;
  }
  return a.length - b.length;
}

/**
 * Sorted RFC 6901 pointers of the existing nodes of `object` that match a rule path pattern. Segments: a literal key or list
 * index, `*` for one key or index, `**` for any depth (including none), `{a,b}` for alternatives. `/` is the object itself (the
 * empty pointer). A key is matched only when the object owns it, so `constructor` never matches through the prototype.
 */
export function matchPointers(object, pattern) {
  const out = [];
  for (const pat of expandBraces(pattern)) walk(object, pat.split("/").slice(1).filter((s) => s !== ""), "", out);
  return [...new Set(out)].sort((a, b) => compareKeys(pointerKey(a), pointerKey(b)));
}

/** The value at an RFC 6901 pointer, or `dflt` when any step is missing. */
export function pointerGet(object, pointer, dflt = undefined) {
  let node = object;
  for (const raw of pointer.split("/").slice(1)) {
    const t = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (isObj(node) && hasOwn(node, t)) node = node[t];
    else if (Array.isArray(node) && isIndex(t) && Number(t) < node.length) node = node[Number(t)];
    else return dflt;
  }
  return node;
}
