// The server privacy checker (HFY-TSK-245, sync design 5.7, BRD2 D2-32): redaction policy v1, detection only.
//
// It answers one question for every object an op would write: does this object still carry something the desktop projection
// removes or reduces? It reads the one policy file (gramps/redaction/redaction-v1.json), the one birth-like predicate and the one text
// detector (shared/redaction-rules.mjs, shared/privacy-guard.mjs), and keeps no rule list of its own. Every rule the policy marks
// `server: "detect"` is checked here. The golden vectors in gramps/redaction/vectors/ carry the expected verdict of each (`expected.server`);
// test/sync-checker.test.js runs every one of them through privacyVerdict().
//
//   privacyVerdict(objects)            the verdict on a list of objects as submitted: {ok, violations: [{rule, handle, pointer}]}
//                                      (sorted by handle, rule, pointer; pointers are RFC 6901, relative to the object)
//   batchViolations({ops, store})      the verdict on a batch against the store view: the cross-object rules below
//
// Cross-object rules (batchViolations). Birth-likeness depends on other objects: a person's birth_ref_index makes an event
// birth-like, and a citation is birth-like when a birth-like event or an EventRef to one cites it. The batch is checked as it
// would stand after it commits (the store view overlaid with the batch's creates, updates, deletes and withdraws):
//   - a written event is birth-like by its type or because a person in the batch or the store points at it;
//   - a written citation is checked when a birth-like event, or an EventRef to one, cites it;
//   - an event that is NOT in the batch but is newly targeted by a written person's birth_ref_index is checked too (its date
//     now sits on a birth-like event), and so are the citations of every birth-like event the batch touches.
// A violation on such an object not in the batch is reported against that object's handle, with the `op_id` of the op that
// caused the check. Only the birth rules (birth.date.*, birth.citation.date) are reported for them: the object passed every other
// rule when it was stored.
//
// A finding names a rule, a handle and a pointer. It never carries the offending value.
import { scanText } from "../shared/privacy-guard.mjs";
import { createOverlay } from "./view.js";
import {
  attributeRule, birthCitationHandles, buildTree, coordinateIsFine, dateViolations, escapePointerToken, isBirthLike, matchPointers,
  placeCodeIsLocal, placeExclusionRule, pointerGet, urlRules,
} from "../shared/redaction-rules.mjs";

/** The classes a `private: true` flag excludes (rules.py PRIMARY; Researcher never reaches the cloud, so it is not a batch class). */
const PRIMARY = new Set(["Person", "Family", "Event", "Place", "Source", "Citation", "Repository", "Media", "Note", "Tag", "Researcher"]);

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const obj = (v) => (isObj(v) ? v : {});
const arr = (v) => (Array.isArray(v) ? v : []);

/** The class of a nested secondary object comes from the field that owns it, not from its own (forgeable or absent) `_class`. */
const FIELD_CLASS = Object.freeze({
  urls: "Url", surname_list: "Surname", primary_name: "Name", alternate_names: "Name", person_ref_list: "PersonRef", alt_names: "PlaceName",
});

/** The text detector as the checker uses it: the kinds found in `text`, each once, limited to the policy's kinds. */
export const scanKinds = (policy) => {
  const allowed = new Set(policy.scan.kinds);
  return (text) => {
    const out = [];
    for (const h of scanText(text, { kinds: policy.scan.kinds })) if (allowed.has(h.kind) && !out.includes(h.kind)) out.push(h.kind);
    return out;
  };
};

/** [pointer, text] of every outgoing free-text field of one object (sync design 5.4; policy.scan.fields). */
function scanFields(object, policy) {
  const table = new Map();
  for (const f of policy.scan.fields) {
    if (!table.has(f.class)) table.set(f.class, []);
    table.get(f.class).push(f.path);
  }
  const out = [];
  const topClass = object._class;
  const visit = (node, pointer, field, depth) => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => visit(v, `${pointer}/${i}`, field, depth));
      return;
    }
    if (!isObj(node)) return;
    let cls = node._class;
    if (depth === 0) cls = topClass;
    else if (field === "attribute_list") cls = depth === 1 && (topClass === "Source" || topClass === "Citation") ? "SrcAttribute" : "Attribute";
    else if (field === "name" && topClass === "Place") cls = "PlaceName";
    else if (FIELD_CLASS[field]) cls = FIELD_CLASS[field];
    for (const path of table.get(cls) ?? []) {
      const v = pointerGet(node, path);
      if (typeof v === "string" && v !== "") out.push([pointer + path, v]);
    }
    for (const [k, v] of Object.entries(node)) visit(v, `${pointer}/${escapePointerToken(k)}`, k, depth + 1);
  };
  visit(object, "", null, 0);
  return out;
}

/**
 * The violations of one object. `facts` supplies what other objects decide:
 *   birthLike(event)      is this Event birth-like (isBirthLike on the tree the caller has)
 *   birthCitation(handle) is this Citation cited by a birth-like event or an EventRef to one
 *   placeExcluded(handle) is this Place excluded by its type (Street, Farm, Building, Number, custom home-like)
 * Returns [{rule, handle, pointer}] unsorted and with possible repeats; finish() sorts and drops them.
 */
export function objectViolations(o, policy, facts, scan = scanKinds(policy)) {
  const out = [];
  const handle = o.handle;
  const add = (rule, pointer) => out.push({ rule, handle, pointer });
  const cls = o._class;
  const pol = policy;

  if (o.private === true && PRIMARY.has(cls)) add("private.object.exclude", "/private");
  if (cls === "Person" && obj(o.primary_name).private === true) add("private.name.hold_person", "/primary_name/private");
  for (const r of pol.rules) {
    if (r.server !== "detect" || r.phase !== "elements" || !r.objectClass.includes(cls)) continue;
    const want = r.params?.elementClass;
    for (const ptr of matchPointers(o, r.path)) {
      const node = pointerGet(o, ptr);
      // A missing _class reads as the wanted class (fail closed); an explicit other class is not an element of this rule.
      if (isObj(node) && node.private === true && (want === undefined || node._class === undefined || node._class === want)) add(r.id, ptr);
    }
  }

  const dateChecks = (date, prefix, ruleDayMonth, ruleText) => {
    for (const rel of dateViolations(date, pol)) add(rel === "/text" ? ruleText : ruleDayMonth, prefix + rel);
  };
  if (cls === "Event" && o.date !== undefined && o.date !== null && facts.birthLike(o)) {
    dateChecks(o.date, "/date", "birth.date.daymonth", "birth.date.text");
    if (obj(o.date).modifier === pol.dates.textOnlyModifier) add("birth.date.textonly", "/date/modifier");
  }
  if (cls === "Citation" && o.date !== undefined && o.date !== null && facts.birthCitation(handle)) dateChecks(o.date, "/date", "birth.citation.date", "birth.citation.date");
  if (cls === "Person") {
    const names = [["/primary_name", o.primary_name], ...arr(o.alternate_names).map((n, i) => [`/alternate_names/${i}`, n])];
    for (const [ptr, n] of names) {
      if (isObj(n) && obj(n.type).value === pol.dates.nameTypeBirth && n.date !== undefined && n.date !== null) dateChecks(n.date, `${ptr}/date`, "birth.name.date", "birth.name.date");
    }
    arr(o.lds_ord_list).forEach((_, i) => add("birth.lds_ord", `/lds_ord_list/${i}`));
  }
  for (const ptr of matchPointers(o, "/**/attribute_list/*")) {
    const el = pointerGet(o, ptr);
    if (!isObj(el)) continue;
    const srcList = ptr.startsWith("/attribute_list/") && (cls === "Source" || cls === "Citation");
    const rid = srcList && el._class === undefined ? null : attributeRule(el._class === undefined ? { ...el, _class: "Attribute" } : el, pol);
    if (rid) add(rid, ptr);
  }
  if (cls === "Person" || cls === "Repository") arr(o.address_list).forEach((_, i) => add("contact.address_list", `/address_list/${i}`));
  if (cls === "Person" || cls === "Place" || cls === "Repository") {
    arr(o.urls).forEach((u, i) => {
      for (const rid of urlRules(u, scan, pol)) add(rid, `/urls/${i}`);
    });
  }
  if (cls === "Place") {
    const rid = placeExclusionRule(o, pol);
    if (rid) add(rid, "/place_type");
    arr(o.alt_loc).forEach((loc, i) => {
      for (const f of pol.places.locationFields) if (obj(loc)[f]) add("contact.alt_loc.fields", `/alt_loc/${i}/${f}`);
    });
    if (o.code && placeCodeIsLocal(o, pol)) add("place.code.local_only", "/code");
    for (const k of ["lat", "long"]) if (coordinateIsFine(o[k] || "", pol)) add("place.coordinates.round", `/${k}`);
    arr(o.placeref_list).forEach((ref, i) => {
      if (isObj(ref) && facts.placeExcluded(ref.ref)) add("place.repoint", `/placeref_list/${i}/ref`);
    });
  }
  if (cls === "Event" && o.place && facts.placeExcluded(o.place)) add("place.repoint", "/place");
  for (const [ptr, text] of scanFields(o, pol)) for (const kind of scan(text)) add(`scan.${kind}`, ptr);
  return out;
}

const byKey = (a, b) => (a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : a.pointer < b.pointer ? -1 : a.pointer > b.pointer ? 1 : 0);

/** Drops repeats and sorts by handle, rule and pointer: the order of expected.server in the golden vectors. Other members ride along. */
export function finish(violations) {
  const seen = new Set();
  const out = [];
  for (const v of violations) {
    const k = `${v.handle}\u0000${v.rule}\u0000${v.pointer}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out.sort(byKey);
}

/** Facts for a list of objects taken as the whole tree (the golden vectors, the seed, a test): everything is in the list. */
export function treeFacts(objects, policy) {
  const tree = buildTree(objects);
  const cites = birthCitationHandles(tree, policy);
  const excluded = new Set(objects.filter((o) => isObj(o) && o._class === "Place" && placeExclusionRule(o, policy)).map((o) => o.handle));
  return { birthLike: (e) => isBirthLike(e, tree, policy), birthCitation: (h) => cites.has(h), placeExcluded: (h) => excluded.has(h) };
}

/** The server's verdict on a list of objects as submitted, with the list as the whole tree: `{ok, violations: [{rule, handle, pointer}]}`. */
export function privacyVerdict(objects, policy) {
  const list = arr(objects).filter(isObj);
  const facts = treeFacts(list, policy);
  const scan = scanKinds(policy);
  const violations = finish(list.flatMap((o) => objectViolations(o, policy, facts, scan)));
  return { ok: violations.length === 0, violations };
}

// ---- a batch against the store view -----------------------------------------------------------------------------------

const keyOf = (cls, handle) => `${cls}#${handle}`;
const BIRTH_RULES = /^birth\.(date\.|citation\.date)/;

/** The event handle a person's birth_ref_index points at, or undefined (the predicate's own reading, see buildTree). */
function birthRefOf(person) {
  const refs = arr(person.event_ref_list);
  const i = person.birth_ref_index;
  return Number.isInteger(i) && i >= 0 && i < refs.length && isObj(refs[i]) && typeof refs[i].ref === "string" ? refs[i].ref : undefined;
}

/**
 * The cross-object verdict on a batch.
 *   ops    the wire ops (create/update with `obj`, delete/withdraw, marker), each with `op_id`
 *   store  { get(cls, handle) -> {deleted, obj} | null, referrers(cls, handle) -> [{class, handle, obj}] } (src/sync/view.js)
 * Returns [{rule, handle, pointer, class, op_id}] sorted by handle, rule, pointer.
 */
export async function batchViolations({ ops, store, policy, scan = scanKinds(policy) }) {
  const { written, after, overridden } = createOverlay(ops, store);
  /** Stored live objects that reference (cls, handle), minus those the batch overrides. */
  const storedReferrers = async (cls, handle) => (await store.referrers(cls, handle)).filter((r) => !overridden(r.class, r.handle));

  // Birth-likeness of an Event after the batch.
  const noTree = buildTree([]);
  const blCache = new Map();
  const birthLikeEvent = async (ev) => {
    if (isBirthLike(ev, noTree, policy)) return true; // by type: no other object is needed
    if (blCache.has(ev.handle)) return blCache.get(ev.handle);
    const people = [];
    for (const { obj: p } of written.values()) if (p._class === "Person" && birthRefOf(p) === ev.handle) people.push(p);
    let like = people.length > 0;
    if (!like) {
      for (const r of await storedReferrers("Event", ev.handle)) {
        if (r.class === "Person" && birthRefOf(r.obj) === ev.handle) {
          like = true;
          break;
        }
      }
    }
    blCache.set(ev.handle, like);
    return like;
  };

  // Is this Citation cited by a birth-like event or by an EventRef that points at one, after the batch?
  const bcCache = new Map();
  const cites = (list, handle) => arr(list).includes(handle);
  const refCites = (holder, handle) => arr(holder.event_ref_list).filter((ref) => isObj(ref) && cites(ref.citation_list, handle));
  const birthCitation = async (handle) => {
    if (bcCache.has(handle)) return bcCache.get(handle);
    let hit = false;
    const holders = []; // objects that cite it: batch objects first, then the store's
    for (const { obj: o } of written.values()) holders.push(o);
    for (const r of await storedReferrers("Citation", handle)) holders.push(r.obj);
    for (const h of holders) {
      if (hit) break;
      if (h._class === "Event" && cites(h.citation_list, handle) && (await birthLikeEvent(h))) hit = true;
      else if (h._class === "Person" || h._class === "Family") {
        for (const ref of refCites(h, handle)) {
          const ev = await after("Event", ref.ref);
          if (ev && (await birthLikeEvent(ev))) {
            hit = true;
            break;
          }
        }
      }
    }
    bcCache.set(handle, hit);
    return hit;
  };

  // Facts for the written objects, resolved up front because the per-object rules are synchronous.
  const likeEvents = new Map();
  const birthCites = new Map();
  const excluded = new Map();
  const placeHandles = new Set();
  for (const { obj: o } of written.values()) {
    if (o._class === "Event") {
      likeEvents.set(o.handle, await birthLikeEvent(o));
      if (typeof o.place === "string" && o.place) placeHandles.add(o.place);
    } else if (o._class === "Citation") birthCites.set(o.handle, await birthCitation(o.handle));
    else if (o._class === "Place") for (const ref of arr(o.placeref_list)) if (isObj(ref) && typeof ref.ref === "string" && ref.ref) placeHandles.add(ref.ref);
  }
  for (const h of placeHandles) {
    const p = await after("Place", h);
    excluded.set(h, p !== null && placeExclusionRule(p, policy) !== null);
  }
  const facts = {
    birthLike: (e) => likeEvents.get(e.handle) === true,
    birthCitation: (h) => birthCites.get(h) === true,
    placeExcluded: (h) => excluded.get(h) === true,
  };

  const out = [];
  const tag = (violations, cls, opId) => violations.map((v) => ({ ...v, class: cls, ...(opId !== undefined ? { op_id: opId } : {}) }));
  for (const { obj: o, op } of written.values()) out.push(...tag(objectViolations(o, policy, facts, scan), o._class, op.op_id));

  // Objects outside the batch that the batch makes birth-like: events a written person now targets, and the citations of every
  // birth-like event the batch touches.
  const extraEvents = new Map(); // handle -> {obj, op_id}
  const extraCites = new Map();
  const noteEvent = async (handle, opId) => {
    if (overridden("Event", handle) || extraEvents.has(handle)) return;
    const ev = await after("Event", handle);
    if (ev) extraEvents.set(handle, { obj: ev, op_id: opId });
  };
  const noteCitations = async (handles, opId) => {
    for (const c of arr(handles)) {
      if (typeof c !== "string" || c === "" || overridden("Citation", c) || extraCites.has(c)) continue;
      const cit = await after("Citation", c);
      if (cit) extraCites.set(c, { obj: cit, op_id: opId });
    }
  };
  for (const { obj: p, op } of written.values()) if (p._class === "Person") {
    const target = birthRefOf(p);
    if (target !== undefined) await noteEvent(target, op.op_id);
  }
  const birthEvents = [...extraEvents.values()].map((e) => ({ ...e, ev: e.obj }));
  for (const { obj: o, op } of written.values()) if (o._class === "Event" && facts.birthLike(o)) birthEvents.push({ ev: o, op_id: op.op_id });
  for (const { ev, op_id } of birthEvents) {
    await noteCitations(ev.citation_list, op_id);
    for (const r of await storedReferrers("Event", ev.handle)) {
      if (r.class === "Person" || r.class === "Family") for (const ref of arr(r.obj.event_ref_list)) if (isObj(ref) && ref.ref === ev.handle) await noteCitations(ref.citation_list, op_id);
    }
  }
  for (const { obj: h, op } of written.values()) {
    if (h._class !== "Person" && h._class !== "Family") continue;
    for (const ref of arr(h.event_ref_list)) {
      if (!isObj(ref) || !arr(ref.citation_list).length) continue;
      const ev = await after("Event", ref.ref);
      if (ev && (written.has(keyOf("Event", ref.ref)) ? facts.birthLike(ev) : await birthLikeEvent(ev))) await noteCitations(ref.citation_list, op.op_id);
    }
  }
  const sub = { birthLike: () => true, birthCitation: () => true, placeExcluded: (h) => excluded.get(h) === true };
  for (const { obj: ev, op_id } of extraEvents.values()) {
    out.push(...tag(objectViolations(ev, policy, sub, scan).filter((v) => BIRTH_RULES.test(v.rule)), "Event", op_id));
  }
  for (const { obj: cit, op_id } of extraCites.values()) {
    out.push(...tag(objectViolations(cit, policy, sub, scan).filter((v) => BIRTH_RULES.test(v.rule)), "Citation", op_id));
  }
  return finish(out);
}
