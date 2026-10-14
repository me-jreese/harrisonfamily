// The R-18 / R-19 edit guard core (HFY-PLN-002 editing design 6.3, task edit-guard-wiring): ONE module that the server adapter
// (api/src/records/guard.js) and the browser mirror (islands/src/lib/edit-guard.js) both import, so a shared corpus
// (shared/edit-guard.cases.json) gives identical findings on both sides.
//
// It is an adapter over the one text detector (privacy-guard.mjs scanText) and the one birth-like predicate (redaction-rules.mjs
// isBirthLike); the parsed gramps/redaction/redaction-v1.json is passed in, so this file imports no JSON and keeps no list of its own.
//
// It runs on the RESULTING objects, never on the request text: pass what an edit would leave behind (after applyOps, with type
// changes and birth_ref_index changes applied). Two families of rule:
//   text        every string leaf of every object (nested secondary objects included), plus the free text beside them: proposal
//               notes, decision reasons, proposal-thread comments and relationship stub fields (checkTexts / checkValue).
//               Contact kinds always; the DOB heuristic only when `dob` is on (the HFY_GUARD_DOB switch, Q2-17 line 5).
//   structural  birth-like events (and the citations of them) carry no day, month or non-year text, and birth-name dates carry
//               no day or month (dob_not_allowed); never-in-cloud place types, Url type E-mail, government-id and age/time
//               attributes, address_list / alt_loc content and finer coordinates are never_in_cloud.
//
// A finding is {opId, obj, path, pointer, code, kind, span}: where, never what. The matched text is not in a finding.
import { DOB_KINDS, KINDS, scanText } from "./privacy-guard.mjs";
import { attributeRule, birthCitationHandles, buildTree, coordinateIsFine, isBirthLike, placeCodeIsLocal, placeExclusionRule } from "./redaction-rules.mjs";

export const CODES = Object.freeze({ contact: "contact_info", dob: "dob_not_allowed", never: "never_in_cloud" });
/** The kinds refused whatever the DOB switch says. */
export const CONTACT_KINDS = Object.freeze(KINDS.filter((k) => !DOB_KINDS.includes(k)));

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const esc = (s) => String(s).replace(/~/g, "~0").replace(/\//g, "~1");

// Keys whose strings are identifiers, not member text: a 20-digit handle must never read as a phone number.
const ID_KEYS = new Set(["_class", "handle", "ref", "gramps_id", "checksum", "mime", "lat", "long", "existing", "id", "key", "temp", "etag"]);
const HANDLE_LISTS = new Set(["family_list", "parent_family_list", "note_list", "citation_list", "tag_list"]);

/** Every string leaf of `value` as [pointer, text], skipping identifier keys and handle lists. */
export function leaves(value, base = "", out = []) {
  if (typeof value === "string") out.push([base, value]);
  else if (Array.isArray(value)) value.forEach((v, i) => leaves(v, `${base}/${i}`, out));
  else if (isObj(value)) for (const [k, v] of Object.entries(value)) if (!ID_KEYS.has(k) && !(HANDLE_LISTS.has(k) && Array.isArray(v) && v.every((x) => typeof x === "string"))) leaves(v, `${base}/${esc(k)}`, out);
  return out;
}

/** Walks `value` calling fn(node, pointer) for every plain object. */
function walkObjects(value, base, fn) {
  if (Array.isArray(value)) value.forEach((v, i) => walkObjects(v, `${base}/${i}`, fn));
  else if (isObj(value)) {
    fn(value, base);
    for (const [k, v] of Object.entries(value)) walkObjects(v, `${base}/${esc(k)}`, fn);
  }
}

/**
 * Builds the guard. `policy` is the parsed redaction-v1.json (default: loadPolicy()); `dob` turns the DOB heuristic on for free
 * text; `log` receives one `privacy_guard` line with counts per code on a refusal.
 */
export function createEditGuard({ policy, dob = false } = {}) {
  const kinds = dob ? undefined : CONTACT_KINDS;
  const pol = () => policy;

  const textFindings = (text) => {
    const out = [];
    if (typeof text !== "string" || text === "") return out;
    for (const h of scanText(text, kinds ? { kinds } : {})) out.push({ code: DOB_KINDS.includes(h.kind) ? CODES.dob : CODES.contact, kind: h.kind, span: [h.start, h.end] });
    return out;
  };

  /** Findings for free text beside the objects: `fields` is [{obj, path, text}]. */
  function checkTexts(fields, { opId = null } = {}) {
    const errors = [];
    for (const f of fields) for (const t of textFindings(f.text)) errors.push({ opId: f.opId ?? opId, obj: f.obj, path: f.path ?? "", pointer: `/${esc(f.obj)}${f.path ?? ""}`, ...t });
    return errors;
  }

  /** Findings for every string leaf of `value` (a note, a reason, a stub, a whole intent). */
  function checkValue(value, obj, opts = {}) {
    return checkTexts(leaves(value).map(([path, text]) => ({ obj, path, text })), opts);
  }

  /**
   * Findings for the resulting objects: a map {"Class:handle": object} or an array. `context` is more objects (the stored ones)
   * that classify events (a birth_ref_index may now point at one) without being scanned, except an event a changed person now
   * makes birth-like. `opIdFor(key)` names the op that produced each object.
   */
  function checkObjects(objects, { context = [], opIdFor = () => null } = {}) {
    const p = pol();
    const entries = Array.isArray(objects) ? objects.filter(isObj).map((o) => [`${o._class}:${o.handle}`, o]) : Object.entries(objects || {}).filter(([, o]) => isObj(o));
    const inSet = new Set(entries.map(([, o]) => o.handle).filter(Boolean));
    const extra = (Array.isArray(context) ? context : Object.values(context || {})).filter((o) => isObj(o) && !inSet.has(o.handle));
    const tree = buildTree([...entries.map(([, o]) => o), ...extra]);
    const birthCites = birthCitationHandles(tree, p);
    const dm = p.dates.dayMonthIndexes;
    const errors = [];
    const add = (key, path, code, kind, span = null) => errors.push({ opId: opIdFor(key), obj: key, path, pointer: `/${esc(key)}${path}`, code, kind, span });

    const dayMonth = (date, path, key, strictText) => {
      if (date === null || date === undefined) return;
      if (!isObj(date)) return add(key, path, CODES.dob, "date");
      const dv = Array.isArray(date.dateval) ? date.dateval : [];
      for (const i of dm) if (i < dv.length && dv[i]) add(key, `${path}/dateval/${i}`, CODES.dob, "birth_date");
      if (strictText && date.text !== undefined && date.text !== null && (typeof date.text !== "string" || (date.text !== "" && !/^\d{4}$/.test(date.text)))) add(key, `${path}/text`, CODES.dob, "birth_date_text");
    };

    const classify = (key, o) => {
      // text: every string leaf
      for (const [path, text] of leaves(o)) for (const t of textFindings(text)) add(key, path, t.code, t.kind, t.span);
      // structural, by class, anywhere in the object
      walkObjects(o, "", (n, path) => {
        switch (n._class) {
          case "Url": if (isObj(n.type) && n.type.value === p.urls.emailType) add(key, `${path}/type`, CODES.never, "url_email"); break;
          case "Attribute": case "SrcAttribute": if (attributeRule(n, p)) add(key, `${path}/type`, CODES.never, "attribute"); break;
          case "Location": case "Address": add(key, path, CODES.never, "address"); break;
          default:
        }
      });
      for (const f of ["address_list", "alt_loc"]) if (Array.isArray(o[f]) && o[f].length) add(key, `/${f}`, CODES.never, "address");
      if (o._class === "Place") {
        if (placeExclusionRule(o, p)) add(key, "/place_type", CODES.never, "place_type");
        for (const f of ["lat", "long"]) if (o[f] !== undefined && o[f] !== null && o[f] !== "" && (typeof o[f] !== "string" || coordinateIsFine(o[f], p))) add(key, `/${f}`, CODES.never, "coordinate");
        if (typeof o.code === "string" && o.code !== "" && placeCodeIsLocal(o, p)) add(key, "/code", CODES.never, "place_code");
      }
      if (o._class === "Event" && isBirthLike(o, tree, p)) dayMonth(o.date, "/date", key, true);
      if (o._class === "Citation" && birthCites.has(o.handle)) dayMonth(o.date, "/date", key, false);
      if (o._class === "Person") {
        const names = [["/primary_name", o.primary_name], ...(Array.isArray(o.alternate_names) ? o.alternate_names.map((n, i) => [`/alternate_names/${i}`, n]) : [])];
        for (const [path, n] of names) if (isObj(n) && isObj(n.type) && n.type.value === p.dates.nameTypeBirth) dayMonth(n.date, `${path}/date`, key, false);
      }
    };
    for (const [key, o] of entries) classify(key, o);

    // An event outside the set that a changed person now makes birth-like is checked too.
    const handles = new Set(entries.filter(([, o]) => o._class === "Person").flatMap(([, o]) => {
      const refs = Array.isArray(o.event_ref_list) ? o.event_ref_list : [];
      const r = Number.isInteger(o.birth_ref_index) && o.birth_ref_index >= 0 ? refs[o.birth_ref_index] : null;
      return isObj(r) && typeof r.ref === "string" ? [r.ref] : [];
    }));
    for (const e of extra) if (e._class === "Event" && handles.has(e.handle)) dayMonth(e.date, "/date", `Event:${e.handle}`, true);
    return errors;
  }

  return { checkTexts, checkValue, checkObjects };
}

export function countsPerCode(errors) {
  const counts = {};
  for (const e of errors) counts[e.code] = (counts[e.code] ?? 0) + 1;
  return counts;
}
