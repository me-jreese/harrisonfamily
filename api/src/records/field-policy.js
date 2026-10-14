// Field-policy table, own-record resolver and op classifier (HFY-TSK-233, edit-field-policy; editing design sections 3.2, 3.3, 4;
// BRD2 D2-13, section 11.2, Q2-15). It decides, for each EditOp, whether the viewer saves it now ("direct"), sends it for review
// ("proposal"), or may not do it on the web at all ("admin", "desk", "derived", "never").
//
//   const fp = createFieldPolicy({ answers: { "own-death-event": "owner-direct" } });   // io's Q2-15 answers; none = the defaults
//   const own = await ownRecord(actor, view);                                           // { cls, handle, gramps_id } | null
//   const classes = await classifyOps(ops, { actor, view, objects, policy: fp });       // [{ id, obj, code, kinds, relation }]
//
// `view` is the read side of the record store (the `records-accessors` task): { get(cls, handle), byGrampsId(cls, id),
// referrers(cls, handle) }. All three are async-tolerant. `objects` is the base map { "Person:<handle>": <Gramps JSON>, ... } the ops
// apply to (the own Person, the Events it references, and every other object the ops name).
//
// The ops are partitioned and summarised in edit-plan.js. Nothing calls this module yet: its first caller is `edit-api-core`, so it
// ships, unreachable, in the hfy-api zip.
import { applyOps, canonicalJson, hash12, OpsError, parsePath } from "./ops.js";
import { birthDeathIndex, EVENT_TYPE, ROLE_PRIMARY } from "./semantics.js";
import { buildTree, isBirthLike, placeCodeIsLocal } from "../shared/redaction-rules.mjs";
import { loadPolicy } from "./guard.js";

// ---------------------------------------------------------------------------------------------------------------
// Codes
// ---------------------------------------------------------------------------------------------------------------

/** direct: saves now. proposal: goes to review. admin: members cannot even propose it. desk: Gramps desktop only. never: refused on
 *  every path, admins included (R-18). derived: computed by the server, never accepted from a client. */
export const CODES = Object.freeze({ direct: "direct", proposal: "proposal", admin: "admin", desk: "desk", never: "never", derived: "derived" });
const RANK = Object.freeze({ direct: 0, proposal: 1, admin: 2, desk: 3, derived: 3, never: 4 });
/** The more restrictive of two codes. */
export const stricter = (a, b) => (RANK[b] > RANK[a] ? b : a);
const FIXED = new Set(["never", "desk", "derived"]); // the same answer for every viewer unless a Q2-15 switch says otherwise
/** Codes that no one saves through the proposal queue: a group holding one is refused, not reviewed. */
export const isRefusal = (code) => RANK[code] >= RANK.admin;

const D = "direct";
const P = "proposal";

// ---------------------------------------------------------------------------------------------------------------
// The table. Row: [class, pointerPattern, own, other, options?]
//   own: a member editing their own record. other: a member editing someone else's. Admin is "direct" unless options.admin says
//   otherwise (or the row is never, desk or derived for everyone). Pointer patterns are RFC 6901 with * = one segment, ** = any
//   subtree including the node itself (also zero segments in the middle), {a,b} = alternatives. A list element is matched as *.
//   Most specific wins: a never, desk or derived row beats a plain one, then the pattern with more literal segments, then the row
//   listed later. options.when names a predicate over the object(s) and the value (WHEN below); options.group tags the row for
//   the Q2-15 switch that owns it.
// A pointer in the committed schemas must match a row (a test asserts it). A pointer that matches nothing resolves to "proposal".
// ---------------------------------------------------------------------------------------------------------------

const NAME_FREE = "{title,suffix,call,nick,famnick}"; // R-09 lists only given names, surnames and the birth year
const COMMON_PLAIN = "{attribute_list,note_list,media_list,citation_list,urls}";

export const FIELD_POLICY_ROWS = Object.freeze([
  // ---- every class: identity, housekeeping, metadata
  ...["Person", "Family", "Event", "Place", "Source", "Citation", "Repository", "Media", "Note"].flatMap((c) => [
    [c, "/{_class,handle}", "derived", "derived"],
    [c, "/change", "derived", "derived"],
    [c, "/tag_list/**", P, P], // tag assignment from existing tags is a proposal for members (IF-04)
    [c, "/media_list/*/rect/**", c === "Person" ? D : P, P], // the tagging rule (R-31): a member's own Person rect is direct, another person's a proposal
  ]),
  ["Person", "/**/_class", "derived", "derived"],
  ["Person", "/**/handle", "derived", "derived"],

  // ---- Person: names (R-09)
  ["Person", "/primary_name", P, P],
  ["Person", "/primary_name/first_name", P, P],
  ["Person", "/primary_name/surname_list/**", P, P],
  ["Person", `/primary_name/${NAME_FREE}`, D, P],
  ["Person", "/primary_name/type/**", D, P], // IF-01: the name type is direct for the owner
  ["Person", "/primary_name/date/**", D, P],
  ["Person", "/primary_name/{citation_list,note_list}/**", D, P], // own-only name citations and notes
  ["Person", "/alternate_names", P, P],
  ["Person", "/alternate_names/*", P, P], // adding or removing an alternate name
  ["Person", "/alternate_names/*/first_name", P, P],
  ["Person", "/alternate_names/*/surname_list/**", P, P],
  ["Person", `/alternate_names/*/${NAME_FREE}`, D, P],
  ["Person", "/alternate_names/*/type/**", D, P], // alternate-name types are direct (IF-01)
  ["Person", "/alternate_names/*/date/**", D, P],
  ["Person", "/alternate_names/*/{citation_list,note_list}/**", D, P],
  ["Person", "/gender", D, P],
  ["Person", "/parent_family_list/**", P, P], // R-09 parents
  ["Person", "/event_ref_list/**", D, P], // own-only events; Birth and Death structure is a separate rule (STRUCTURE_ROWS)
  ["Person", "/event_ref_list/*/citation_list/**", P, P],
  ["Person", "/attribute_list/**", D, P],
  ["Person", "/note_list/**", D, P],
  ["Person", "/media_list/**", D, P],
  ["Person", "/media_list/*/citation_list/**", P, P],
  ["Person", "/citation_list/**", P, P],
  ["Person", "/urls/**", D, P], // the seven link kinds (links domain); a Url of any other type is desktop-only (nonLinkUrl row below)
  ["Person", "/person_ref_list/**", D, P], // associations
  ["Person", "/person_ref_list/*/citation_list/**", P, P],

  // ---- Event (own = referenced only by the own Person, role Primary)
  ["Event", "/type/**", D, P],
  ["Event", "/date/**", D, P],
  ["Event", "/date/**", P, P, { when: "birthLike" }], // the birth year is a proposal (R-09); day and month are never
  ["Event", "/date/dateval/{0,1,4,5}", "never", "never", { when: ["birthLike", "dayMonthInValue"] }],
  ["Event", "/date", "never", "never", { when: ["birthLike", "dayMonthInValue"] }],
  ["Event", "/date/dateval", "never", "never", { when: ["birthLike", "dayMonthInValue"] }],
  ["Event", "/{place,description}", D, P],
  ["Event", "/{note_list,attribute_list,media_list}/**", D, P],
  ["Event", "/citation_list/**", P, P],

  // ---- Family (shared: a member's changes to a family are proposals; spouse and children are the Q2-15 row on the Person)
  // The spouse and child links carry the Q2-15 `spouse-children` tag like Person.family_list, so one switch decides both sides of a
  // link (a link always pairs a Person op with a Family op in one group). A Family is "own" when the member is a spouse or a child.
  ["Family", "/{father_handle,mother_handle,child_ref_list}/**", P, P, { group: "spouse-children" }],
  ["Family", "/{type,complete,event_ref_list}/**", P, P],
  ["Family", "/{attribute_list,note_list,media_list,citation_list}/**", P, P],
  ["Family", "/lds_ord_list/**", "desk", "desk", { group: "desk-list" }],

  // ---- Place (always shared)
  ["Place", "/{name,alt_names,place_type,lat,long,placeref_list}/**", P, P],
  ["Place", `/${COMMON_PLAIN}/**`, P, P],
  ["Place", "/code", P, P, { when: "administrativePlace" }], // IF-04: a proposal on administrative types
  ["Place", "/code", "never", "never", { when: "localPlace" }], // R-18: never below the administrative level
  ["Place", "/title", "desk", "desk", { group: "desk-list" }],
  ["Place", "/alt_loc/**", "never", "never"],
  ["Place", "/place_type/**", "never", "never", { when: "neverPlaceType" }],

  // ---- Source, Citation, Repository, Media, Note
  ["Source", "/{title,author,pubinfo,abbrev,reporef_list}/**", P, P],
  ["Source", "/{attribute_list,note_list,media_list}/**", P, P],
  ["Citation", "/{source_handle,page,date,confidence,attribute_list,note_list,media_list}/**", P, P],
  ["Repository", "/{name,type,note_list,urls}/**", P, P],
  ["Repository", "/address_list/**", "never", "never"],
  ["Media", "/{desc,date,attribute_list,note_list,citation_list}/**", P, P],
  // The former 'A' rows (IF-04): a proposal for a member. They describe the stored file, so the photos-domain graduation path (server
  // side) is their only writer: no web client op writes them for an admin either ("derived"), and a local absolute path never reaches the cloud.
  // `thumb` is the stored thumbnail name in the Gramps Media schema; it follows its file.
  ["Media", "/{path,mime,checksum,thumb}", P, P, { admin: "derived" }],
  ["Note", "/{text,format,type}/**", D, P], // own-only notes are direct

  // ---- never, desk and derived (the same for everyone)
  ["Person", "/address_list/**", "never", "never"],
  ["Person", "/attribute_list/**", "never", "never", { when: "neverAttribute" }],
  ["Person", "/urls/**", "never", "never", { when: "emailUrl" }],
  ["Person", "/urls/**", "desk", "desk", { when: "nonLinkUrl" }], // editing.md 3.2: the Internet tab takes the link kinds only; e-mail (never) outranks this row
  ["Person", "/attribute_list/**", "desk", "desk", { when: "mergedGid", group: "desk-list" }], // the sync identity key (design 3.2)
  ["Person", "/lds_ord_list/**", "desk", "desk", { group: "desk-list" }],
  ["Person", "/{gramps_id,private}", "desk", "desk", { group: "desk-list" }],
  ["Person", "/primary_name/{group_as,sort_as,display_as}", "desk", "desk", { group: "desk-list" }],
  ["Person", "/alternate_names/*/{group_as,sort_as,display_as}", "desk", "desk", { group: "desk-list" }],
  ["Person", "/**/private", "desk", "desk", { group: "desk-list" }],
  ["Person", "/{birth_ref_index,death_ref_index}", "derived", "derived"],
  ["Person", "/family_list/**", P, P, { group: "spouse-children" }], // R-24 relationship proposals (Q2-15 interpretation)
  ...["Family", "Event", "Place", "Source", "Citation", "Repository", "Media", "Note"].flatMap((c) => [
    [c, "/{gramps_id,private}", "desk", "desk", { group: "desk-list" }],
    [c, "/**/private", "desk", "desk", { group: "desk-list" }],
    [c, "/**/attribute_list/*", "never", "never", { when: "neverAttribute" }],
    [c, "/**/urls/*", "never", "never", { when: "emailUrl" }],
    [c, "/**/attribute_list/*", "desk", "desk", { when: "mergedGid", group: "desk-list" }],
  ]),
  ["Person", "/**/attribute_list/*", "never", "never", { when: "neverAttribute" }],
  ["Person", "/**/urls/*", "never", "never", { when: "emailUrl" }],
  ["Person", "/**/attribute_list/*", "desk", "desk", { when: "mergedGid", group: "desk-list" }],
]);

/** Why a Person Url op is refused on the web, as the structured reason in `kinds` (editing.md 13): `url_email` (R-18, never) or
 *  `url_not_link` (desktop-only). Null when the op is not about a withheld Url. Takes the same ctx as the WHEN predicates. */
export function urlReason(ctx) {
  if (WHEN.emailUrl(ctx)) return "url_email";
  return WHEN.nonLinkUrl(ctx) ? "url_not_link" : null;
}

/** The Birth and Death structure rules (IF-02), evaluated on the ops of a submission, not on a pointer. */
export const STRUCTURE_ROWS = Object.freeze([
  // Removing or adding an EventRef whose Event is a Birth (12), deleting the Birth Event, retyping to or from Birth, or any op that
  // changes which event birth_ref_index resolves to.
  { kind: "birth-structure", own: P, other: P },
]);

/** The rows that io's Q2-15 answer decides, in one section with one switch per row: an answer changes this data, not code.
 *  `alternatives` are the other answers; the key is what `createFieldPolicy({ answers: { [id]: key } })` takes. Every row below
 *  that has `rows` replaces the same-group rows of the main table; a `kind` row is a structure rule. */
export const Q2_15_ROWS = Object.freeze([
  {
    id: "spouse-children",
    label: "Spouse and children on the own record (R-24 relationship proposals)",
    group: "spouse-children",
    own: P,
    other: P,
    alternatives: { "owner-direct": { own: D } },
  },
  {
    id: "own-death-event",
    label: "Adding, removing or retyping the own Death event (it changes the living classification, D2-08)",
    kind: "own-death-event",
    own: P,
    other: P,
    alternatives: { "owner-direct": { own: D } },
  },
  {
    id: "custom-type-string",
    label: "A new custom type string (members choose only existing ones, DEC-E10)",
    kind: "custom-type-string",
    own: "admin",
    other: "admin",
    alternatives: { proposal: { own: P, other: P } },
  },
  {
    id: "desk-list",
    label: "Desktop-only fields: Gramps IDs, private flags, LDS, group/sort/display-as, the place title (DEC-E8)",
    group: "desk-list",
    own: "desk",
    other: "desk",
    alternatives: { "admin-web": { admin: D } },
  },
]);

// ---------------------------------------------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------------------------------------------

function compileSegment(s) {
  if (s === "**") return { t: "any" };
  if (s === "*") return { t: "one" };
  if (s.startsWith("{") && s.endsWith("}")) return { t: "alt", set: new Set(s.slice(1, -1).split(",")) };
  return { t: "lit", v: s };
}
const SCORE = { any: 0, one: 1, lit: 3, alt: 3 };

function compileRow(row, eff) {
  const [cls, pattern, own, other, opt = {}] = row;
  const segs = pattern === "" ? [] : pattern.slice(1).split("/").map(compileSegment);
  const o = eff?.own ?? own;
  const t = eff?.other ?? other;
  const fixed = FIXED.has(o) && FIXED.has(t);
  const admin = eff?.admin ?? opt.admin ?? (fixed && o === t ? o : D);
  const prio = o === "never" ? 2 : FIXED.has(o) ? 1 : 0;
  return { cls, pattern, segs, own: o, other: t, admin, when: [].concat(opt.when ?? []), group: opt.group ?? null, prio, score: segs.reduce((n, s) => n + SCORE[s.t], 0) };
}

function matchSegs(pat, i, ptr, j) {
  if (i === pat.length) return j === ptr.length;
  const s = pat[i];
  if (s.t === "any") {
    for (let k = j; k <= ptr.length; k++) if (matchSegs(pat, i + 1, ptr, k)) return true;
    return false;
  }
  if (j === ptr.length) return false;
  if (s.t === "one") return matchSegs(pat, i + 1, ptr, j + 1);
  if (s.t === "lit") return s.v === ptr[j] && matchSegs(pat, i + 1, ptr, j + 1);
  return s.set.has(ptr[j]) && matchSegs(pat, i + 1, ptr, j + 1);
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isTyped = (v) => isObj(v) && typeof v._class === "string" && v._class.endsWith("Type") && "value" in v;

/** Does `value` hold a typed enum of class `cls` whose value is in `set`, at any depth? */
function hasTyped(value, cls, set) {
  if (Array.isArray(value)) return value.some((x) => hasTyped(x, cls, set));
  if (!isObj(value)) return false;
  if (value._class === cls && set.has(value.value)) return true;
  return Object.values(value).some((x) => hasTyped(x, cls, set));
}
// Mirrors NEVER.typeValues in scripts/records/gen-edit-schemas.mjs (a test pins them together; the zip cannot import the script).
export const NEVER_TYPE_VALUES = Object.freeze({
  AttributeType: Object.freeze([3, 6, 10, 11, 12, 14]),
  UrlType: Object.freeze([1]),
  PlaceType: Object.freeze([7, 18, 19, 20]),
});
const NEVER_SETS = Object.fromEntries(Object.entries(NEVER_TYPE_VALUES).map(([k, v]) => [k, new Set(v)]));

const anyTyped = (value, test) => {
  if (Array.isArray(value)) return value.some((x) => anyTyped(x, test));
  if (!isObj(value)) return false;
  if (isTyped(value) && test(value)) return true;
  return Object.values(value).some((x) => anyTyped(x, test));
};
// The values a never-type predicate judges: the new value, the old value and the stored element the op addresses (all three, so a
// retype away from a withheld type and an edit of a withheld element are caught, not only the creation of one). `unresolved`: the
// op's key matched no stored element, so nothing can be judged and the stricter row applies.
const seen = (c) => [c.value, c.old, c.element];
// The Url types the web may write on a Person: Web Home (the website link) and a Custom type named for one of the seven link kinds
// (surfaces.md 6.1). Unknown, Web Search, FTP, E-mail and any other custom string are not link kinds.
const WEB_HOME = 2;
export const LINK_URL_KINDS = Object.freeze(["facebook", "instagram", "snapchat", "tiktok", "linktree", "linkedin", "website"]);
const isLinkType = (t) =>
  isObj(t) && (t.value === WEB_HOME || (t.value === 0 && typeof t.string === "string" && LINK_URL_KINDS.includes(t.string.trim().toLowerCase())));
// Every Url type a value names: a Url element's own type (a missing one counts as Unknown), or a bare UrlType.
function urlTypes(value, out = []) {
  if (Array.isArray(value)) value.forEach((x) => urlTypes(x, out));
  else if (isObj(value)) {
    if (value._class === "Url") out.push(value.type);
    else if (value._class === "UrlType") out.push(value);
    for (const x of Object.values(value)) if (isObj(x) || Array.isArray(x)) urlTypes(x, out);
  }
  return out;
}
const hasNonLinkUrl = (c) => !!c.unresolved || seen(c).some((v) => urlTypes(v).some((t) => !isLinkType(t)));

const MERGED_GID = /^\s*merged gramps ids?\s*$/i;

/** Predicates. ctx: { checks: [{obj, tree}] (the target object before and after the ops), value (the new value at this pointer),
 *  old (the stored value there), element (the stored list element the op addresses), unresolved, policy (redaction-v1) }. A predicate
 *  that cannot tell answers for the stricter row. */
const WHEN = {
  birthLike: (c) => c.checks.length === 0 || c.checks.some(({ obj, tree }) => obj && isBirthLike(obj, tree, c.policy)),
  dayMonthInValue: (c) => {
    if (c.value === undefined) return true;
    const dv = Array.isArray(c.value) ? c.value : isObj(c.value) ? c.value.dateval : null;
    if (!Array.isArray(dv)) return typeof c.value === "number" && c.value !== 0 ? true : false;
    return [0, 1, 4, 5].some((i) => dv[i] !== undefined && dv[i] !== 0 && dv[i] !== false);
  },
  localPlace: (c) => c.checks.every(({ obj }) => !obj) || c.checks.some(({ obj }) => obj && placeCodeIsLocal(obj, c.policy)),
  administrativePlace: (c) => !WHEN.localPlace(c),
  neverPlaceType: (c) => seen(c).some((v) => hasTyped(v, "PlaceType", NEVER_SETS.PlaceType)) || c.checks.some(({ obj }) => obj && hasTyped(obj.place_type, "PlaceType", NEVER_SETS.PlaceType)),
  neverAttribute: (c) => !!c.unresolved || seen(c).some((v) => hasTyped(v, "AttributeType", NEVER_SETS.AttributeType)),
  emailUrl: (c) => !!c.unresolved || seen(c).some((v) => hasTyped(v, "UrlType", NEVER_SETS.UrlType)),
  nonLinkUrl: hasNonLinkUrl,
  mergedGid: (c) => !!c.unresolved || seen(c).some((v) => anyTyped(v, (t) => t._class === "AttributeType" && t.value === 0 && MERGED_GID.test(String(t.string ?? "")))),
};

// ---------------------------------------------------------------------------------------------------------------
// The policy object
// ---------------------------------------------------------------------------------------------------------------

/** Build the resolver. `answers` maps a Q2-15 row id to one of its alternatives (absent = the default). Throws on an unknown id or
 *  alternative, so a typo in a flag file never silently keeps a default. */
export function createFieldPolicy({ answers = {}, policy } = {}) {
  const picked = {};
  for (const [id, alt] of Object.entries(answers)) {
    const row = Q2_15_ROWS.find((r) => r.id === id);
    if (!row) throw new Error(`unknown Q2-15 row: ${id}`);
    if (alt !== "default" && !row.alternatives[alt]) throw new Error(`unknown answer ${alt} for Q2-15 row ${id}`);
    picked[id] = alt === "default" ? null : row.alternatives[alt];
  }
  const effective = (r) => ({ own: r.own, other: r.other, admin: r.admin, ...(picked[r.id] ?? {}) });
  const rows = FIELD_POLICY_ROWS.map((row) => {
    const g = row[4]?.group;
    // A group's switch sets the group's answer only where it differs from the default, so each row keeps its own default.
    const e = g && picked[g] ? { ...picked[g] } : undefined;
    return compileRow(row, e);
  });
  const kinds = new Map();
  for (const s of STRUCTURE_ROWS) kinds.set(s.kind, { own: s.own, other: s.other, admin: D });
  for (const r of Q2_15_ROWS) if (r.kind) {
    const e = effective(r);
    kinds.set(r.kind, { own: e.own, other: e.other, admin: e.admin ?? D });
  }
  let loaded = policy;
  const redaction = () => (loaded ??= loadPolicy());

  /** The row that governs (cls, segs), or null. segs: pointer segments as strings. With `ignoreWhen`, conditional rows count. */
  function findRow(cls, segs, ctx = null, ignoreWhen = false) {
    let best = null;
    rows.forEach((r, order) => {
      if (r.cls !== cls || !matchSegs(r.segs, 0, segs, 0)) return;
      // No ctx: a conditional row cannot be judged, so it counts (the stricter answer), never the fail-open one.
      if (!ignoreWhen && ctx && r.when.length && !r.when.every((w) => WHEN[w](ctx))) return;
      if (!best || r.prio > best.row.prio || (r.prio === best.row.prio && (r.score > best.row.score || (r.score === best.row.score && order > best.order)))) best = { row: r, order };
    });
    return best?.row ?? null;
  }

  /** The code for a pointer. viewer: { admin, relation: "own" | "other" }. An unmatched pointer is a proposal for a member. */
  function resolve(cls, pointer, viewer = {}, ctx = null) {
    const segs = Array.isArray(pointer) ? pointer : pointer === "" ? [] : pointer.slice(1).split("/");
    const row = findRow(cls, segs, ctx ? { policy: redaction(), checks: [], ...ctx } : null);
    if (!row) return viewer.admin ? D : P;
    return viewer.admin ? row.admin : viewer.relation === "own" ? row.own : row.other;
  }

  /** The code for a structure kind ("birth-structure", "own-death-event", "custom-type-string"). */
  function resolveKind(kind, viewer = {}) {
    const k = kinds.get(kind);
    if (!k) return viewer.admin ? D : P;
    return viewer.admin ? k.admin : viewer.relation === "own" ? k.own : k.other;
  }

  /** The table in the form the edit bundle serves to the client (a copy for labels; the server decides). */
  function document() {
    return {
      version: 1,
      rows: rows.map((r) => ({ cls: r.cls, pointer: r.pattern, own: r.own, other: r.other, admin: r.admin, ...(r.when.length ? { when: r.when } : {}), ...(r.group ? { group: r.group } : {}) })),
      structure: [...kinds].map(([kind, v]) => ({ kind, ...v })),
      q2_15: Q2_15_ROWS.map((r) => ({ id: r.id, label: r.label, answer: answers[r.id] ?? "default", alternatives: Object.keys(r.alternatives) })),
    };
  }

  return { rows, findRow, resolve, resolveKind, document, redaction, answers: { ...answers } };
}

export const DEFAULT_FIELD_POLICY = createFieldPolicy();

// ---------------------------------------------------------------------------------------------------------------
// The member's own record (editing design section 4)
// ---------------------------------------------------------------------------------------------------------------

const handleOf = (hit) => (typeof hit === "string" ? hit : hit && typeof hit.handle === "string" ? hit.handle : null);

/** The Person that is `actor`. The id comes from the verified session (`actor.id`, set by the authenticator) and from nowhere else:
 *  the function takes no request input. Null when the store reports no Person or more than one for that gramps_id (gramps_id is not
 *  unique in Gramps), and then every change fails closed to a proposal. The log line carries counts, never an id. */
export async function ownRecord(actor, view, { log } = {}) {
  const gid = actor && typeof actor.id === "string" ? actor.id : "";
  if (!gid || !view || typeof view.byGrampsId !== "function") return null;
  let hits;
  try {
    hits = await view.byGrampsId("Person", gid);
  } catch {
    log?.warn?.("own_record_unavailable", {});
    return null;
  }
  const list = Array.isArray(hits) ? hits : [];
  if (list.length === 0) {
    log?.info?.("own_record_missing", { count: 0 });
    return null;
  }
  if (list.length > 1) {
    log?.warn?.("own_record_ambiguous", { count: list.length });
    return null;
  }
  const handle = handleOf(list[0]);
  return handle ? { cls: "Person", handle, gramps_id: gid } : null;
}

/** "own" or "other" for the object `key` ("Person:<handle>"). Fail closed: any doubt or error is "other".
 *  Person: the own handle. Event: referenced only by the own Person, and only with the Primary role. Note: referenced only by the
 *  own Person or by own-only events. Family: the own Person is a spouse or a child of it (the Q2-15 spouse-children relation).
 *  Everything else (places, sources, citations, repositories, media) is shared. */
export async function relationOf(own, key, view, memo = new Map()) {
  if (!own || typeof key !== "string") return "other";
  if (memo.has(key)) return memo.get(key);
  memo.set(key, "other"); // a reference cycle ends as "other"
  const idx = key.indexOf(":");
  const cls = key.slice(0, idx);
  const handle = key.slice(idx + 1);
  let out = "other";
  try {
    if (cls === "Person") out = handle === own.handle ? "own" : "other";
    else if (cls === "Event") out = (await ownOnlyEvent(own, handle, view)) ? "own" : "other";
    else if (cls === "Family") {
      const f = await view.get("Family", handle);
      out = f && (f.father_handle === own.handle || f.mother_handle === own.handle || (f.child_ref_list ?? []).some((c) => c && c.ref === own.handle)) ? "own" : "other";
    } else if (cls === "Note") {
      const refs = (await view.referrers("Note", handle)) ?? [];
      let ok = refs.length > 0;
      for (const r of refs) {
        if (!ok) break;
        if (r.cls === "Person" && r.handle === own.handle) continue;
        if (r.cls === "Event" && (await relationOf(own, `Event:${r.handle}`, view, memo)) === "own") continue;
        ok = false;
      }
      out = ok ? "own" : "other";
    }
  } catch {
    out = "other";
  }
  memo.set(key, out);
  return out;
}

async function ownOnlyEvent(own, handle, view) {
  const refs = (await view.referrers("Event", handle)) ?? [];
  if (!refs.length || refs.some((r) => !(r.cls === "Person" && r.handle === own.handle))) return false;
  const person = await view.get("Person", own.handle);
  const mine = (person?.event_ref_list ?? []).filter((r) => r && r.ref === handle);
  return mine.length > 0 && mine.every((r) => r.role && r.role.value === ROLE_PRIMARY);
}

// ---------------------------------------------------------------------------------------------------------------
// Classifying ops
// ---------------------------------------------------------------------------------------------------------------

const TRIVIAL_SKIP = new Set(["_class", "handle"]);
const isTrivial = (v) => v === "" || v === null || v === false || (Array.isArray(v) && v.length === 0) || (isObj(v) && !isTyped(v) && Object.keys(v).length === 0);
const same = (a, b) => (a === undefined || b === undefined ? a === b : canonicalJson(a) === canonicalJson(b));

/** The pointer segments of an op path, as strings: a property is its name, a tuple index its digits, a list-element key is "*". */
export function pointerSegments(path) {
  return parsePath(path).map((s) => (s.t === "prop" ? s.name : s.t === "index" ? String(s.i) : "*"));
}

// Walk what a value changes: emit(segs, newValue, oldValue) at each changed leaf (a typed enum counts as a leaf).
function walkChanges(segs, nv, ov, emit) {
  if (isObj(nv) && !isTyped(nv)) {
    let any = false;
    for (const k of new Set([...Object.keys(nv), ...(isObj(ov) ? Object.keys(ov) : [])])) {
      if (TRIVIAL_SKIP.has(k)) continue;
      const a = nv[k];
      const b = isObj(ov) ? ov[k] : undefined;
      if (b === undefined ? isTrivial(a) : same(a, b)) continue;
      any = true;
      walkChanges(segs.concat(k), a, b, emit);
    }
    if (!any) emit(segs, nv, ov);
    return;
  }
  if (Array.isArray(nv) && segs[segs.length - 1] === "dateval") {
    let any = false;
    nv.forEach((x, i) => {
      const b = Array.isArray(ov) ? ov[i] : undefined;
      if (b === undefined ? x === 0 || x === false || x === "" : same(x, b)) return;
      any = true;
      emit(segs.concat(String(i)), x, b);
    });
    if (!any) emit(segs, nv, ov);
    return;
  }
  if (Array.isArray(nv)) {
    if (!same(nv, ov)) emit(segs.concat("*"), nv, ov);
    return;
  }
  emit(segs, nv, ov);
}

// Find the stored value an op path addresses in `root`: { value, keyMissing }. A list key that matches no element sets keyMissing.
function locate(root, segs) {
  let cur = root;
  for (const s of segs) {
    if (cur === undefined || cur === null) return { value: undefined, keyMissing: false };
    if (s.t === "prop") cur = isObj(cur) ? cur[s.name] : undefined;
    else if (s.t === "index") cur = Array.isArray(cur) ? cur[s.i] : undefined;
    else {
      if (!Array.isArray(cur)) return { value: undefined, keyMissing: true };
      let hit;
      if (s.t === "k") hit = cur.find((el) => isObj(el) && hash12(el) === s.hash);
      else if (s.t === "item") hit = cur.find((el) => el === s.value);
      else hit = cur.filter((el) => isObj(el) && el.ref === s.ref)[s.n ?? 0];
      if (hit === undefined) return { value: undefined, keyMissing: true };
      cur = hit;
    }
  }
  return { value: cur, keyMissing: false };
}
const LISTS_OF_CONCERN = new Set(["attribute_list", "urls"]);
// The stored attribute or URL element an op path addresses (or the whole list when the path ends at it).
function storedElement(root, segs) {
  let j = -1;
  segs.forEach((s, i) => { if (s.t === "prop" && LISTS_OF_CONCERN.has(s.name)) j = i; });
  if (j < 0) return undefined;
  const upTo = segs[j + 1] && segs[j + 1].t !== "prop" && segs[j + 1].t !== "index" ? segs.slice(0, j + 2) : segs.slice(0, j + 1);
  return locate(root, upTo).value;
}

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const clsOf = (op) => (/^new:\d+$/.test(op.obj) ? op.cls : op.obj.slice(0, op.obj.indexOf(":")));
const handleOfKey = (key) => key.slice(key.indexOf(":") + 1);

function withIndexes(objects) {
  const eventOf = (h) => objects[`Event:${h}`];
  const out = {};
  for (const [k, o] of Object.entries(objects)) {
    out[k] = o && o._class === "Person" ? { ...o, ...birthDeathIndex(o, eventOf) } : o;
  }
  return out;
}

const eventTypeValue = (ev) => (ev && ev.type && typeof ev.type.value === "number" ? ev.type.value : null);
const KIND_OF_TYPE = { [EVENT_TYPE.BIRTH]: "birth-structure", [EVENT_TYPE.DEATH]: "own-death-event" };

// Which event the person's birth/death index resolves to ("h" or null).
function indexedEvents(objects, ownKey) {
  const p = objects[ownKey];
  if (!p) return null;
  const idx = birthDeathIndex(p, (h) => objects[`Event:${h}`]);
  const at = (i) => (i >= 0 && p.event_ref_list?.[i] ? p.event_ref_list[i].ref : null);
  return { birth: at(idx.birth_ref_index), death: at(idx.death_ref_index) };
}

/** Classify each op for the viewer. Async only for the store reads (own record, reference index).
 *  ctx: { actor: {id, admin}, view, objects, policy?: createFieldPolicy(), customTypes?, mint?, log? }
 *  -> [{ id, obj, code, relation, kinds: [..] }]   id is the op id (or "#<index>"). */
export async function classifyOps(ops, ctx = {}) {
  const fp = ctx.policy ?? DEFAULT_FIELD_POLICY;
  const admin = !!ctx.actor?.admin;
  const base = ctx.objects ?? {};
  const own = admin ? null : await ownRecord(ctx.actor, ctx.view, { log: ctx.log });
  const ownKey = own ? `Person:${own.handle}` : null;
  const memo = new Map();
  const applied = applyOps(base, ops, ctx.mint ? { mint: ctx.mint } : {});
  const after = applied.ok ? applied.objects : base;
  const minted = applied.ok ? applied.minted : {};
  const redaction = fp.redaction();
  const baseIdx = withIndexes(base);
  const afterIdx = withIndexes(after);
  const baseTree = buildTree(Object.values(baseIdx));
  const afterTree = buildTree(Object.values(afterIdx));

  // Which new objects are own-only: created for, and referenced only by, the own Person (an Event with the Primary role) or an own-only Event.
  const referrers = new Map();
  const refSeen = (temp, from, role) => {
    const list = referrers.get(temp) ?? [];
    list.push({ from, role });
    referrers.set(temp, list);
  };
  const TEMP = /^new:\d+$/;
  const scan = (v, from, role) => {
    if (typeof v === "string" && TEMP.test(v)) refSeen(v, from, role);
    else if (Array.isArray(v)) v.forEach((x) => scan(x, from, role));
    else if (isObj(v)) {
      const r = isObj(v.role) ? v.role.value : undefined;
      for (const [k, x] of Object.entries(v)) scan(x, from, k === "ref" ? r : role);
    }
  };
  for (const op of ops) if (op && op.op !== "create" && typeof op.obj === "string") scan(op.value, op.obj, undefined);
  const tempRelation = async (temp, cls) => {
    if (!own || (cls !== "Event" && cls !== "Note" && cls !== "Family")) return "other";
    const refs = referrers.get(temp) ?? [];
    if (!refs.length) return "other";
    for (const r of refs) {
      if (r.from === ownKey) {
        if (cls === "Event" && r.role !== ROLE_PRIMARY) return "other";
        continue;
      }
      if (cls === "Note" && /^new:/.test(r.from) && (await tempRelation(r.from, "Event")) === "own") continue;
      if (cls === "Note" && (await relationOf(own, r.from, ctx.view, memo)) === "own") continue;
      return "other";
    }
    return "own";
  };

  const eventType = (h) => eventTypeValue(afterIdx[`Event:${h}`] ?? baseIdx[`Event:${h}`]);
  const resolveTemp = (v) => (typeof v === "string" && minted[v] ? minted[v] : v);
  const surfaceTouched = (op, cls) =>
    cls === "Event" || (cls === "Person" && typeof op.path === "string" && /^\/(event_ref_list|birth_ref_index|death_ref_index)(\/|$)/.test(op.path));

  const out = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const id = op && op.id !== undefined ? op.id : `#${i}`;
    if (!isObj(op) || typeof op.obj !== "string") {
      out.push({ id, obj: null, code: admin ? D : P, relation: "other", kinds: [] });
      continue;
    }
    try {
    const cls = clsOf(op);
    const isNew = TEMP.test(op.obj);
    const relation = admin ? "other" : isNew ? await tempRelation(op.obj, cls) : await relationOf(own, op.obj, ctx.view, memo);
    const viewer = { admin, relation };
    const key = isNew && minted[op.obj] ? `${cls}:${minted[op.obj]}` : op.obj;
    const checks = [{ obj: baseIdx[key], tree: baseTree }, { obj: afterIdx[key], tree: afterTree }].filter((c) => c.obj);
    const kinds = new Set();
    let code = D;
    const take = (c) => {
      code = stricter(code, c);
    };
    // The stored value the op addresses, from the base map and never from the submitter's `op.base` (which only has to match at commit).
    let parsed = [];
    let stored;
    let unresolved = false;
    let element;
    if (!isNew && typeof op.path === "string") {
      parsed = parsePath(op.path);
      const loc = locate(base[op.obj], parsed);
      stored = loc.value;
      unresolved = loc.keyMissing;
      element = op.op === "add" ? undefined : storedElement(base[op.obj], parsed); // an add names the list, not an element in it
    }
    const reasons = new Set();
    const emit = (segs, nv, ov) => {
      const wctx = { checks, value: nv, old: ov, element, unresolved, policy: redaction };
      const c = fp.resolve(cls, segs, viewer, wctx);
      take(c);
      if (cls === "Person" && segs[0] === "urls" && (c === "never" || c === "desk")) {
        const why = urlReason(wctx);
        if (why) reasons.add(why);
      }
    };

    if (op.op === "set") {
      if (op.path === "" || op.path === undefined) walkChanges([], op.value, isNew ? undefined : base[op.obj], emit);
      else {
        const segs = pointerSegments(op.path);
        if (isObj(op.value) && !isTyped(op.value)) walkChanges(segs, op.value, stored, emit);
        else emit(segs, op.value, stored);
      }
    } else if (op.op === "add") {
      const segs = pointerSegments(op.path).concat("*");
      emit(segs, op.value, undefined);
      if (isObj(op.value)) walkChanges(segs, op.value, undefined, (s, nv, ov) => (s.length > segs.length ? emit(s, nv, ov) : undefined));
    } else if (op.op === "remove" || op.op === "move") {
      // Judged on the stored element. A missing or different submitted base is a stale or forged op: it goes to review at the least.
      if (unresolved || stored === undefined || (has(op, "base") && !same(op.base, stored))) take(P);
      emit(pointerSegments(op.path), stored, undefined);
    } else if (op.op === "create") {
      if (!admin && relation === "own" && cls === "Family") take(fp.resolve("Family", ["father_handle"], viewer)); // the Q2-15 spouse-children row
      else if (!admin && !(relation === "own" && (cls === "Event" || cls === "Note"))) take(P);
      if (isObj(op.value)) walkChanges([], op.value, undefined, emit);
      const t = cls === "Event" ? eventTypeValue(op.value) : null;
      if (KIND_OF_TYPE[t]) kinds.add(KIND_OF_TYPE[t]);
    } else if (op.op === "delete") {
      if (!admin && !(relation === "own" && (cls === "Event" || cls === "Note"))) take(P);
      const t = cls === "Event" ? eventTypeValue(baseIdx[key]) : null;
      if (KIND_OF_TYPE[t]) kinds.add(KIND_OF_TYPE[t]);
    }

    if (!admin) {
      // (a) add or remove an EventRef whose Event is a Birth or a Death, on any Person
      if (cls === "Person" && typeof op.path === "string" && (op.op === "add" || op.op === "remove")) {
        const segs = parsePath(op.path);
        if (segs[0]?.t === "prop" && segs[0].name === "event_ref_list") {
          const ref = op.op === "add" ? resolveTemp(op.value?.ref) : segs[1]?.t === "ref" ? segs[1].ref : null;
          const t = ref ? eventType(ref) ?? (op.op === "add" ? eventTypeValue(newEventValue(ops, op.value?.ref)) : null) : null;
          if (KIND_OF_TYPE[t]) kinds.add(KIND_OF_TYPE[t]);
        }
      }
      // (b) link an EventRef to an Event that is not the member's own: only an own-only (or newly created own) Event is direct
      if (cls === "Person" && relation === "own" && typeof op.path === "string" && (op.op === "add" || op.op === "set")) {
        for (const t of eventRefTargets(op, parsed)) {
          const temp = TEMP.test(t.ref);
          const mine = temp ? (await tempRelation(t.ref, "Event")) === "own" : await linkableEvent(own, t.ref, ctx.view);
          if (!mine || (!temp && t.role !== undefined && t.role !== ROLE_PRIMARY)) take(P);
        }
      }
      // (c) change an Event's type to or from Birth or Death
      if (cls === "Event" && !isNew && (op.op === "set" || op.op === "delete")) {
        const before = eventTypeValue(baseIdx[key]);
        const afterT = op.op === "delete" ? null : eventTypeValue(afterIdx[key]);
        if (before !== afterT) for (const t of [before, afterT]) if (KIND_OF_TYPE[t]) kinds.add(KIND_OF_TYPE[t]);
      }
      // (d) any op that changes which event birth_ref_index or death_ref_index resolves to, found by applying the ops up to it
      if (ownKey && surfaceTouched(op, cls)) {
        const before = applyOps(base, ops.slice(0, i), ctx.mint ? { mint: ctx.mint } : {});
        const upto = applyOps(base, ops.slice(0, i + 1), ctx.mint ? { mint: ctx.mint } : {});
        if (before.ok && !upto.ok) {
          kinds.add("birth-structure"); // cannot tell: fail closed
          kinds.add("own-death-event");
        } else if (before.ok && upto.ok) {
          const a = indexedEvents(before.objects, ownKey);
          const b = indexedEvents(upto.objects, ownKey);
          if (a && b) {
            if (a.birth !== b.birth) kinds.add("birth-structure");
            if (a.death !== b.death) kinds.add("own-death-event");
          }
        }
      }
      // a new custom type string
      if (hasNewCustomType(op, ctx.customTypes)) kinds.add("custom-type-string");
    }
    for (const k of kinds) take(fp.resolveKind(k, viewer));
    out.push({ id, obj: op.obj, code, relation, kinds: [...kinds, ...reasons].sort() });
    } catch (e) {
      if (!(e instanceof OpsError)) throw e;
      out.push({ id, obj: op.obj, code: "never", relation: "other", kinds: ["invalid_op"] }); // a malformed op is refused, never silently direct
    }
  }
  return out;
}

// The EventRefs an add or set puts on the own Person: [{ ref, role }].
function eventRefTargets(op, segs) {
  if (segs[0]?.t !== "prop" || segs[0].name !== "event_ref_list") return [];
  const roleOf = (r) => (isObj(r) && isObj(r.role) ? r.role.value : undefined);
  if (op.op === "add") return segs.length === 1 && isObj(op.value) && typeof op.value.ref === "string" ? [{ ref: op.value.ref, role: roleOf(op.value) }] : [];
  if (segs.length === 1) return Array.isArray(op.value) ? op.value.filter((r) => isObj(r) && typeof r.ref === "string").map((r) => ({ ref: r.ref, role: roleOf(r) })) : [];
  if (segs.length === 2) return isObj(op.value) && typeof op.value.ref === "string" ? [{ ref: op.value.ref, role: roleOf(op.value) }] : [];
  if (segs.length === 3 && segs[2].t === "prop" && segs[2].name === "ref" && typeof op.value === "string") return [{ ref: op.value, role: undefined }];
  return [];
}

// An existing Event the own Person may link to directly: nobody but the own Person refers to it (an orphan counts).
async function linkableEvent(own, handle, view) {
  try {
    const refs = (await view.referrers("Event", handle)) ?? [];
    return refs.every((r) => r.cls === "Person" && r.handle === own.handle);
  } catch {
    return false;
  }
}

function newEventValue(ops, temp) {
  const c = ops.find((o) => o && o.op === "create" && o.obj === temp);
  return c ? c.value : null;
}

// Custom type strings that members may reuse. `known` is a Set of strings, a { [TypeClass]: Set } map, or (typeClass, string) => bool.
function isKnownCustom(known, typeClass, string) {
  if (!known) return false;
  if (typeof known === "function") return !!known(typeClass, string);
  if (known instanceof Set) return known.has(string);
  const s = known[typeClass];
  return s instanceof Set ? s.has(string) : Array.isArray(s) ? s.includes(string) : false;
}

function hasNewCustomType(op, known) {
  const walk = (v) => {
    if (Array.isArray(v)) return v.some(walk);
    if (!isObj(v)) return false;
    if (isTyped(v) && v.value === 0 && typeof v.string === "string" && v.string !== "" && !isKnownCustom(known, v._class, v.string)) return true;
    return Object.values(v).some(walk);
  };
  return walk(op.value);
}
