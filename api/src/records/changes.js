// POST /api/changes (HFY-TSK-183, edit-api-changes; editing design 3.3, 6.3, 7.3, 7.4; BRD2 D2-02, D2-30, DL-15, DL-18, review 11.2).
//
// One submission, many EditOps. The pipeline, in this order, each step refusing before anything is written:
//   1. the request: shape (an op carries only the fields its kind reads, typed), size caps (413 too_large), the R-18 guard over each op's
//      id, temp obj and path (422, before any store read), the Idempotency-Key (a stored receipt replays; the same key with another body is 422)
//   2. the stored objects the ops address, as the viewer may see them (404), and the engine applied to ALL ops (409 version_conflict on a conflict)
//   3. the R-18/R-19 guard over the full resulting state and over the ops as they will be stored (screenOps), BEFORE the partition
//      (422 contact_info | dob_not_allowed | never_in_cloud)
//   4. the field-policy classes and the partition into direct and review groups; a group no web path may apply is 403 not_allowed
//      (a desktop-only reason, url_not_link and url_email included, rides in details.reasons; 422 is for validation only)
//   5. per part, applied on its own: the stale-base check of the direct groups (409), the Gramps semantics and the Gramps schema (400 validation),
//      the guard again on what will be stored, the admin step-up for a destructive direct group (401 step_up_required, auth_time within 900 s),
//      the 50-proposals-per-24-hours limit (429) and the approval size budget (422 proposal_too_large)
//   6. ONE transaction: the direct groups through applyBatch() (record heads and log, GID and audit items, the registered contributors' items)
//      with the proposal (PROP# META and IDX# copies, AUDIT#proposal) and the IDEM# receipt as `extra`; a submission with no direct part is one
//      transact() of the proposal items alone, which touches no record
//   7. after the commit, and never failing it: onProposalSubmitted tells every admin but the proposer. Record-change notifications for the direct
//      part come from the render outbox (hfy-record-change-fanout), not from here, and this task adds no contribution op: the self_edit and tag
//      credits come from the record contributor inside applyBatch, and the direct part's size check budgets for them (recordContributorActions).
//
// `dry_run` runs steps 1 to 5 and returns the plan; nothing is written and no Idempotency-Key is needed.
import { HttpError } from "../http.js";
import { TxnCancelled, TxnTokenMismatch, transact } from "../txn.js";
import { applyBatch } from "../sync/apply.js";
import { schemaViolations } from "../sync/schema.js";
import { batchIdFor, requestTokenFor } from "../sync/store.js";
import { applyOps, canonicalJson, contentHash, HANDLE_SHAPE, INVALID_REASONS, parsePath, parseSegment, validateOps } from "./ops.js";
import { leaves } from "../shared/edit-guard.mjs";
import { classifyOps, isRefusal } from "./field-policy.js";
import { partitionOps, summarizeGroup } from "./edit-plan.js";
import { checkSemantics, collectRefs } from "./semantics.js";
import { createRecordGuard } from "./guard.js";
import { backrefs, customTypes, get, invalidateGraph } from "./index.js";
import { relationView } from "./edit-bundle.js";
import { viewRecord } from "./read.js";
import {
  MAX_APPROVAL_OBJECTS, MAX_NEW_OBJECTS, MAX_PROPOSAL_BYTES, MAX_PROPOSAL_OPS, MAX_TXN_ACTIONS, PROPOSAL_RATE_LIMIT, idemKeys, idemPut, newProposal, proposalAuditItem, proposalPuts,
  ownersOf, proposalTooLarge, proposalView, recentProposalCount,
} from "./proposals.js";
import { FIXED_TXN_ITEMS } from "../sync/store.js";
import { recordContributorActions } from "../record-contributor.js";

/** DEC-E9: an admin's destructive direct change needs a sign-in this fresh. */
export const STEP_UP_MAX_AGE_SECONDS = 900;
export const MAX_NOTE_CHARS = 1000;
const KEY_RE = /^(Person|Family|Event|Place|Source|Citation|Repository|Media|Note):[A-Za-z0-9_-]{1,64}$/;
const TEMP_RE = /^new:\d+$/;
const OP_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const IDEM_KEY_RE = /^[\x21-\x7e]{1,128}$/;
const OP_FIELDS = new Set(["id", "op", "obj", "cls", "path", "base", "base_hash", "base_version", "sets", "value", "before", "seq"]);
// The fields each op kind reads (ops.js). A field the engine would ignore is refused, never stored: a proposal and a receipt keep the ops as
// sent, so an ignored field would be a place to keep text that no guard reads. `cls` names a new object's class; on an op that addresses a
// new:<n> object it must repeat the class of that object's create (field-policy and the summaries read it there).
const COMMON_OP_FIELDS = ["id", "op", "obj", "seq"];
const KIND_FIELDS = Object.freeze({
  set: new Set([...COMMON_OP_FIELDS, "cls", "path", "base", "base_version", "sets", "value"]),
  add: new Set([...COMMON_OP_FIELDS, "cls", "path", "value", "before"]),
  remove: new Set([...COMMON_OP_FIELDS, "cls", "path", "base", "base_hash"]),
  move: new Set([...COMMON_OP_FIELDS, "cls", "path", "before"]),
  create: new Set([...COMMON_OP_FIELDS, "cls", "value"]),
  delete: new Set([...COMMON_OP_FIELDS, "cls", "base", "base_hash"]),
});
const CLASSES = new Set(["Person", "Family", "Event", "Place", "Source", "Citation", "Repository", "Media", "Note"]);
const REDUCED_SETS = new Set(["day", "month", "day2", "month2", "text"]); // ops.js mergeReducedDate
const HASH64 = /^[0-9a-f]{64}$/;
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/; // a Gramps JSON property; the detector can never read one as contact text
const TOP_FIELDS = new Set(["target", "base_versions", "ops", "note", "route", "dry_run", "idempotency_key"]);
const MAX_CONTEXT_EVENTS = 100;
const MAX_LOADED = 3000;
const SEMANTIC_ROUNDS = 12;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const arr = (v) => (Array.isArray(v) ? v : []);
const esc = (s) => String(s).replace(/~/g, "~0").replace(/\//g, "~1");
const unescSeg = (s) => s.replace(/~1/g, "/").replace(/~0/g, "~");
export const sortedUnique = (xs) => [...new Set(xs)].sort();

/** An HttpError that also carries errors[] (positions and codes, never values), which errorResponse sends beside `details`. */
export const problem = (status, code, message, { errors, details } = {}) => Object.assign(new HttpError(status, code, message, details), errors ? { errors } : {});
const invalid = (errors, message = "the request is not valid") => problem(400, "validation", message, { errors });
export const keyParts = (key) => [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];

/** A header by name, whatever its case (API Gateway HTTP API lower-cases names; a REST API or a direct invocation may not). */
export function headerOf(headers, name) {
  if (!isObj(headers)) return undefined;
  if (typeof headers[name] === "string") return headers[name];
  const hit = Object.keys(headers).find((k) => k.toLowerCase() === name && typeof headers[k] === "string");
  return hit === undefined ? undefined : headers[hit];
}

// ---- R-18 over the ops themselves -------------------------------------------------------------------------------------------
// The guard of step 3 reads what the ops leave. A proposal keeps the ops as sent, the receipt keeps the undo ops built from them and a
// batch keeps their ids, so what an op carries is screened too: a value that a later op overwrites, or the base of an op that is already
// applied, reaches no resulting object but would be stored all the same.

const MASK = "|"; // not a word character, a digit, a space or a separator: it neither starts, joins nor hides a number
/** The property and index segments of a pointer as text, its list keys masked (they hold handles and hashes). Same length as the pointer. */
const pathText = (pointer) => pointer.split("/").map((raw) => (raw.startsWith("@") ? MASK.repeat(raw.length) : raw)).join("/");

/** The last property a path names: the field its value lands in (a list's name for an element of it). */
function fieldOf(path) {
  if (typeof path !== "string") return null;
  try {
    const props = parsePath(path).filter((s) => s.t === "prop");
    return props.length ? props[props.length - 1].name : null;
  } catch { return null; }
}

// Fields whose strings are identifiers. One with an identifier's shape is not text (a hex handle can begin with seven digits); anything
// else there is text, because in an op nothing binds it to a record yet.
const HANDLE_LIST_KEYS = new Set(["family_list", "parent_family_list", "note_list", "citation_list", "tag_list"]);
const isRefKey = (k) => k === "ref" || k === "handle" || k === "place" || HANDLE_LIST_KEYS.has(k) || (typeof k === "string" && k.endsWith("_handle"));
const COORDINATE = /^[+-]?\d{1,3}(?:\.\d+)?$/;
const ID_SHAPES = { checksum: /^[0-9a-f]{32,64}$/i, lat: COORDINATE, long: COORDINATE };
const idShaped = (k, s) => (ID_SHAPES[k] ? ID_SHAPES[k].test(s) : isRefKey(k) && HANDLE_SHAPE.test(s));

/** [pointer, text] for every string of an op's value or base: the object guard's text leaves, and the identifier fields unless shaped as one. */
function valueTexts(value, base = "", key = null, out = []) {
  if (typeof value === "string" && idShaped(key, value)) return out;
  if (Array.isArray(value)) value.forEach((v, i) => valueTexts(v, `${base}/${i}`, key, out));
  else if (isObj(value)) for (const [k, v] of Object.entries(value)) valueTexts(v, `${base}/${esc(k)}`, k, out);
  else leaves(value, base, out, undefined, key); // a string, or a number under a text key (a phone number sent as a JSON number)
  return out;
}

/** The strings a key segment names that no state may bind: an `@=` item or an `@ref=` ref unless handle-shaped, an occurrence, an index. */
function keyStrings(raw) {
  const s = unescSeg(raw);
  if (s.startsWith("@=")) return HANDLE_SHAPE.test(s.slice(2)) ? [] : [s.slice(2)];
  if (s.startsWith("@ref=")) {
    const m = /^@ref=(.+?)(?:#(\d+))?(?::[0-9a-f]{12})?$/.exec(s);
    return m ? [...(HANDLE_SHAPE.test(m[1]) ? [] : [m[1]]), ...(m[2] ? [m[2]] : [])] : [];
  }
  return /^\d+$/.test(s) ? [s] : [];
}

/**
 * Step 1, before any store read: each op's id, a new:<n> obj, and the property and index segments of its path and before (a set with
 * `base: null` creates the property its path names). A finding names the op by its position only, never by the id it refuses.
 */
function screenOpText(guard, ops) {
  const errors = [];
  ops.forEach((o, i) => {
    const scan = (sub, text) => {
      for (const e of guard.checkTexts([{ obj: "ops", path: "", text }])) errors.push({ ...e, opId: null, obj: null, path: sub, pointer: `/ops/${i}${sub}` });
    };
    scan("/id", o.id);
    if (TEMP_RE.test(o.obj)) scan("/obj", o.obj);
    if (typeof o.path === "string") scan("/path", pathText(o.path));
    if (typeof o.before === "string") scan("/before", pathText(o.before));
  });
  guard.assertClean(errors, { surface: "changes", op: "ops" });
}

/**
 * Step 3, over the all-ops run (`results`, a status per op id):
 *   - a clean op: its value. Its base, its keys and its before matched the state it applied to, which holds only the stored objects and
 *     the values of the clean ops ahead of it (read here), so they are not read again: a member may still clear an old phone number.
 *   - a no-op matched nothing it carries: its base, its before and the strings its path keys name are read instead.
 * The undo ops are built from the stored objects and the clean ops' values, so they need no read of their own, and neither do a part's
 * own runs: an op that is clean in a part but a no-op here equals what an earlier op here left.
 */
function screenOps(guard, ops, results) {
  const noop = new Set(results.filter((r) => r.status === "noop").map((r) => r.id));
  const errors = [];
  ops.forEach((o, i) => {
    const scan = (sub, text, exact = true) => {
      for (const e of guard.checkTexts([{ obj: o.obj, path: "", text }], { opId: o.id })) errors.push({ ...e, path: sub, pointer: `/ops/${i}${sub}`, ...(exact ? {} : { span: null }) });
    };
    const field = fieldOf(o.path);
    if (!noop.has(o.id)) {
      if (hasOwn(o, "value")) for (const [p, t] of valueTexts(o.value, "", field)) scan(`/value${p}`, t);
      return;
    }
    if (hasOwn(o, "base")) for (const [p, t] of valueTexts(o.base, "", field)) scan(`/base${p}`, t);
    if (typeof o.path === "string") for (const t of o.path.split("/").flatMap(keyStrings)) scan("/path", t, false);
    if (typeof o.before === "string") for (const t of keyStrings(o.before.replace(/^\//, ""))) scan("/before", t, false);
  });
  guard.assertClean(errors, { surface: "changes", op: "ops" });
}

/** Every object key in `v` is a Gramps property name (a value's keys are stored with it, and no guard reads a key). */
const fieldNamesOnly = (v) => (Array.isArray(v) ? v.every(fieldNamesOnly) : isObj(v) ? Object.entries(v).every(([k, x]) => FIELD_NAME.test(k) && fieldNamesOnly(x)) : true);

/** The typed fields of one op (its kind's field list is checked by the caller). `createdCls` maps each new:<n> to the cls of its create. */
function shapeOp(raw, at, bad, createdCls) {
  const has = (k) => hasOwn(raw, k);
  if (has("seq") && typeof raw.seq !== "boolean") bad(`${at}/seq`, "seq is true or false");
  if (has("cls")) {
    if (!CLASSES.has(raw.cls)) bad(`${at}/cls`, "cls is a record class");
    else if (!(typeof raw.obj === "string" && TEMP_RE.test(raw.obj))) bad(`${at}/cls`, "cls names the class of a new:<n> object");
    else if (raw.op !== "create" && createdCls.get(raw.obj) !== raw.cls) bad(`${at}/cls`, "cls is the class the object is created with");
  }
  if (has("base_version")) {
    if (!(Number.isInteger(raw.base_version) && raw.base_version >= 1)) bad(`${at}/base_version`, "base_version is a version number");
    if (has("base")) bad(`${at}/base`, "a set carries base, or base_version for a reduced date, not both");
  }
  if (has("sets") && !(has("base_version") && Array.isArray(raw.sets) && raw.sets.every((s) => REDUCED_SETS.has(s)) && new Set(raw.sets).size === raw.sets.length)) {
    bad(`${at}/sets`, "sets lists day, month, day2, month2 or text, beside base_version");
  }
  if (has("base_hash")) {
    if (!(typeof raw.base_hash === "string" && HASH64.test(raw.base_hash))) bad(`${at}/base_hash`, "base_hash is 64 lowercase hex digits");
    if (has("base")) bad(`${at}/base`, `a ${raw.op} carries base or base_hash, not both`);
  }
  if (raw.op === "delete" && has("base") && !(typeof raw.base === "string" && HASH64.test(raw.base))) bad(`${at}/base`, "a delete's base is the object's content hash");
  if (typeof raw.path === "string") {
    let segs = null;
    try { segs = parsePath(raw.path); } catch { /* validateOps names a malformed path */ }
    if (segs?.some((s) => s.t === "prop" && !FIELD_NAME.test(s.name))) bad(`${at}/path`, "a path names Gramps fields and list keys");
  }
  if (has("before") && raw.before !== null) {
    let seg = null;
    try { if (typeof raw.before === "string") seg = parseSegment(unescSeg(raw.before[0] === "/" ? raw.before.slice(1) : raw.before)); } catch { /* refused below */ }
    if (!seg || seg.t === "prop") bad(`${at}/before`, "before is the key of a list element");
  }
  for (const k of ["value", "base"]) if (has(k) && !fieldNamesOnly(raw[k])) bad(`${at}/${k}`, "a value holds Gramps fields only");
}

// ---- step 1: the request ----------------------------------------------------------------------------------------------------
export function parseRequest(c, guard) {
  const b = c.body;
  const errors = [];
  const bad = (pointer, detail) => errors.push({ pointer, detail });
  for (const k of Object.keys(b)) if (!TOP_FIELDS.has(k)) bad(`/${esc(k)}`, "not a field of this request");
  if (!Array.isArray(b.ops) || b.ops.length === 0) bad("/ops", "ops must be a non-empty array");
  if (b.target !== undefined && !(typeof b.target === "string" && KEY_RE.test(b.target))) bad("/target", "target must look like Person:<handle>");
  if (b.base_versions !== undefined && !(isObj(b.base_versions) && Object.entries(b.base_versions).every(([k, v]) => KEY_RE.test(k) && Number.isInteger(v) && v >= 1))) bad("/base_versions", "base_versions maps Class:handle to a version");
  if (b.note !== undefined && !(typeof b.note === "string" && b.note.length <= MAX_NOTE_CHARS)) bad("/note", `note is a string of at most ${MAX_NOTE_CHARS} characters`);
  if (b.route !== undefined && b.route !== "auto" && b.route !== "review") bad("/route", "route is auto or review");
  if (b.dry_run !== undefined && typeof b.dry_run !== "boolean") bad("/dry_run", "dry_run is true or false");
  if (b.idempotency_key !== undefined && typeof b.idempotency_key !== "string") bad("/idempotency_key", "idempotency_key is a string");
  if (errors.length) throw invalid(errors);
  if (b.ops.length > MAX_PROPOSAL_OPS) throw problem(413, "too_large", `a submission holds at most ${MAX_PROPOSAL_OPS} ops`);
  if (Buffer.byteLength(JSON.stringify([b.ops, b.note ?? ""])) > MAX_PROPOSAL_BYTES) throw problem(413, "too_large", "the submission is too large");

  const seen = new Set();
  const createdCls = new Map();
  for (const raw of b.ops) if (isObj(raw) && raw.op === "create" && typeof raw.obj === "string" && !createdCls.has(raw.obj)) createdCls.set(raw.obj, raw.cls);
  const ops = b.ops.map((raw, i) => {
    const at = `/ops/${i}`;
    if (!isObj(raw)) { bad(at, "an op is an object"); return raw; }
    const fields = KIND_FIELDS[raw.op];
    for (const k of Object.keys(raw)) if (!(fields ?? OP_FIELDS).has(k)) bad(`${at}/${esc(k)}`, fields ? `not a field of a ${raw.op} op` : "not a field of an op");
    const id = raw.id === undefined ? `o${i + 1}` : raw.id;
    if (typeof id !== "string" || !OP_ID_RE.test(id)) bad(`${at}/id`, "an op id is 1 to 64 letters, digits or . _ : -");
    else if (seen.has(id)) bad(`${at}/id`, "an op id repeats an earlier op");
    seen.add(id);
    if (typeof raw.obj === "string" && !TEMP_RE.test(raw.obj) && !KEY_RE.test(raw.obj)) bad(`${at}/obj`, "obj is Class:handle or new:<n>");
    if (raw.op === "create" && !(typeof raw.obj === "string" && TEMP_RE.test(raw.obj))) bad(`${at}/obj`, "an object is created as new:<n>");
    if (typeof raw.obj === "string" && TEMP_RE.test(raw.obj) && raw.op !== "create" && !ops_creates(b.ops, raw.obj)) bad(`${at}/obj`, `${raw.obj} is never created`);
    shapeOp(raw, at, bad, createdCls);
    return { ...raw, id };
  });
  if (errors.length) throw invalid(errors);
  screenOpText(guard, ops);
  const problems = validateOps(ops);
  if (problems.length) throw invalid(problems.map((p) => ({ opId: p.id, pointer: `/ops/${ops.findIndex((o, i) => (o.id ?? `#${i}`) === p.id)}`, code: p.reason, detail: p.message })));
  const news = ops.filter((o) => o.op === "create");
  if (news.length > MAX_NEW_OBJECTS) throw problem(413, "too_large", `a submission creates at most ${MAX_NEW_OBJECTS} new objects`);
  if (new Set(news.map((o) => o.obj)).size !== news.length) throw invalid([{ pointer: "/ops", detail: "a new object is created twice" }]);

  let key = headerOf(c.event?.headers, "idempotency-key") ?? b.idempotency_key;
  const dry = b.dry_run === true;
  if (key !== undefined && !(typeof key === "string" && IDEM_KEY_RE.test(key))) throw invalid([{ pointer: "/headers/idempotency-key", detail: "the Idempotency-Key is 1 to 128 visible characters" }]);
  if (!dry && key === undefined) throw invalid([{ pointer: "/headers/idempotency-key", detail: "an Idempotency-Key header is required" }], "an Idempotency-Key is required");
  if (dry) key = undefined;
  const actor = c.actor;
  if (b.route === "review" && actor.admin !== true) throw problem(403, "not_allowed", "only an admin chooses the review route", { errors: [{ pointer: "/route", code: "admin", detail: "members always save what they may and suggest the rest" }] });
  return { target: b.target, base_versions: b.base_versions ?? {}, ops, note: b.note ? b.note.trim() : undefined, route: b.route ?? "auto", dry_run: dry, key };
}
const ops_creates = (ops, temp) => ops.some((o) => isObj(o) && o.op === "create" && o.obj === temp);

// A relationship submission (HFY-TSK-210) is keyed by what the member sent (the intent, the confirmed stubs, the note, the route), not by the ops
// the compile made of it: a retry must replay its receipt without compiling, and the tree may have moved since. /api/changes receipts keep their hash.
export const requestHashOf = (req) => (req.intent !== undefined
  ? contentHash({ intent: req.intent, confirm: req.confirm ?? null, note: req.note ?? null, route: req.route })
  : contentHash({ target: req.target ?? null, base_versions: req.base_versions, ops: req.ops, note: req.note ?? null, route: req.route }));

// ---- idempotency --------------------------------------------------------------------------------------------------------------
export async function readIdem(ctx, principal, key) {
  const res = await ctx.ddb.send(new ctx.cmds.GetCommand({ TableName: ctx.table, Key: idemKeys(principal, key), ConsistentRead: true }));
  return res.Item ?? null;
}
export function replayOf(item, requestHash) {
  if (item.requestHash !== requestHash) throw problem(422, "idempotency_mismatch", "that Idempotency-Key was used with a different request");
  return { status: item.result.status, body: item.result.body, headers: { "idempotent-replayed": "true" } };
}

// ---- helpers over objects ----------------------------------------------------------------------------------------------------
function diffObjects(before, after) {
  const created = [];
  const updated = [];
  const deleted = [];
  for (const [k, v] of Object.entries(after)) {
    if (!(k in before)) created.push(k);
    else if (canonicalJson(v) !== canonicalJson(before[k])) updated.push(k);
  }
  for (const k of Object.keys(before)) if (!(k in after)) deleted.push(k);
  return { created: created.sort(), updated: updated.sort(), deleted: deleted.sort() };
}
export const pick = (m, keys) => Object.fromEntries(keys.filter((k) => k in m).map((k) => [k, m[k]]));
const opsAt = (ops, indexes) => [...indexes].sort((a, b) => a - b).map((i) => ops[i]);
export const existingKey = (op) => (typeof op.obj === "string" && !TEMP_RE.test(op.obj) ? op.obj : null);

export function displayName(obj) {
  const n = isObj(obj?.primary_name) ? obj.primary_name : {};
  const surname = arr(n.surname_list).map((s) => (isObj(s) ? s.surname : "")).filter(Boolean).join(" ");
  return [n.first_name, surname].filter((x) => typeof x === "string" && x).join(" ");
}

/** The DEC-E9 definition: deleting an object, or removing a parent, child or spouse link. Judged on what the change leaves behind. */
export function isDestructive(before, after, changes) {
  if (changes.deleted.length > 0) return true;
  const lost = (a, b) => arr(a).some((x) => !arr(b).includes(x));
  const refs = (list) => arr(list).map((r) => (isObj(r) ? r.ref : r));
  for (const k of changes.updated) {
    const b = before[k];
    const a = after[k];
    if (b?._class === "Person" && (lost(b.family_list, a.family_list) || lost(b.parent_family_list, a.parent_family_list))) return true;
    if (b?._class === "Family") {
      if ((b.father_handle && a.father_handle !== b.father_handle) || (b.mother_handle && a.mother_handle !== b.mother_handle)) return true;
      if (lost(refs(b.child_ref_list), refs(a.child_ref_list))) return true;
    }
  }
  return false;
}

/** 401 step_up_required unless the sign-in itself (auth_time, never renewed by a refresh) is at most 900 s old. */
export function requireRecentSignIn(actor, nowMs) {
  const t = actor.authTime;
  const age = typeof t === "number" && Number.isFinite(t) && t > 0 ? nowMs / 1000 - t : Infinity;
  if (!(age >= -60 && age <= STEP_UP_MAX_AGE_SECONDS)) {
    throw problem(401, "step_up_required", "this change needs a fresh sign-in", { details: { maxAgeSeconds: STEP_UP_MAX_AGE_SECONDS } });
  }
}

// ---- step 2: the stored objects -----------------------------------------------------------------------------------------------
async function loadTouched(ctx, actor, req) {
  const keys = sortedUnique([...req.ops.map(existingKey).filter(Boolean), ...(req.target ? [req.target] : [])]);
  const stored = new Map();
  const missing = [];
  await Promise.all(keys.map(async (k) => {
    const [cls, handle] = keyParts(k);
    const head = await get(ctx, cls, handle);
    if (!head) return void missing.push(k);
    if (actor.admin !== true) {
      const gid = typeof head.obj.gramps_id === "string" ? head.obj.gramps_id : "";
      if (!(await viewRecord(ctx, actor, { class: cls, handle, gramps_id: gid, version: head.version, obj: head.obj }))) return void missing.push(k); // hidden from the viewer: not found
    }
    stored.set(k, head);
  }));
  if (missing.length) {
    const gone = new Set(missing);
    const errors = req.ops.map((o, i) => [o, i]).filter(([o]) => gone.has(o.obj)).map(([o, i]) => ({ opId: o.id, obj: o.obj, pointer: `/ops/${i}/obj`, code: "not_found", detail: "no such record" }));
    if (req.target && gone.has(req.target) && !errors.length) errors.push({ pointer: "/target", code: "not_found", detail: "no such record" });
    throw problem(404, "not_found", "no such record", { errors });
  }
  const missingBase = req.ops.map((o, i) => [o, i]).filter(([o]) => existingKey(o) && req.base_versions[o.obj] === undefined);
  if (missingBase.length) throw invalid(missingBase.map(([o, i]) => ({ opId: o.id, obj: o.obj, pointer: `/base_versions/${esc(o.obj)}`, detail: `base_versions has no version of ${o.obj}` })), "base_versions must name every record the ops touch");
  return stored;
}

/** The Events a touched Person or Family lists: context for the classification and the birth-like rule, never written. */
async function loadContext(ctx, stored, have) {
  const handles = [];
  for (const { obj } of stored.values()) if (obj._class === "Person" || obj._class === "Family") for (const r of arr(obj.event_ref_list)) if (isObj(r) && typeof r.ref === "string") handles.push(r.ref);
  const out = new Map();
  await Promise.all(sortedUnique(handles).slice(0, MAX_CONTEXT_EVENTS).map(async (h) => {
    const k = `Event:${h}`;
    if (have.has(k)) return;
    const head = await get(ctx, "Event", h);
    if (head) out.set(k, head);
  }));
  return out;
}

const conflictBody = (conflicts, current) => problem(409, "version_conflict", "the page changed since you opened it", {
  details: { current, conflicts: conflicts.map((x) => ({ opId: x.opId, obj: x.obj, path: x.path, reason: x.reason })) },
});

// ---- step 5: semantics, schema, guard ----------------------------------------------------------------------------------------
/** checkSemantics is synchronous, so the objects it asks for are loaded between rounds until a round asks for nothing new. */
async function semantics(ctx, cache, refCache, input, hidden = new Set()) {
  const need = new Set();
  const needRefs = new Set();
  for (let round = 0; round < SEMANTIC_ROUNDS; round += 1) {
    need.clear();
    needRefs.clear();
    const refsOf = (k) => { if (refCache.has(k)) return refCache.get(k); needRefs.add(k); return []; };
    const res = checkSemantics({
      ...input,
      get: (k) => { if (hidden.has(k)) return undefined; if (cache.has(k)) return cache.get(k)?.obj ?? undefined; need.add(k); return undefined; },
      referrers: refsOf,
      eventReferrers: (h) => refsOf(`Event:${h}`),
    });
    if (need.size === 0 && needRefs.size === 0) return res;
    await Promise.all([
      ...[...need].map(async (k) => { const [cls, handle] = keyParts(k); cache.set(k, (await get(ctx, cls, handle)) ?? null); }),
      ...[...needRefs].map(async (k) => { refCache.set(k, await backrefs(ctx, k)); }),
    ]);
    if (cache.size > MAX_LOADED) throw problem(413, "too_large", "the change reaches too many records");
  }
  throw problem(413, "too_large", "the change reaches too many records");
}

function semanticErrors(errors, opIdFor) {
  return errors.map((e) => ({ opId: e.obj ? opIdFor(e.obj) : null, obj: e.obj ?? null, path: e.path ?? "", pointer: e.obj ? `/${esc(e.obj)}${e.path ?? ""}` : "", code: e.code, detail: e.message }));
}

function schemaErrors(objects, keys, opIdFor) {
  const out = [];
  for (const k of keys) for (const v of schemaViolations(objects[k])) out.push({ opId: opIdFor(k), obj: k, path: v.pointer, pointer: `/${esc(k)}${v.pointer}`, code: v.rule, detail: "the value is not allowed here" });
  return out;
}

/**
 * Applies `ops` alone to the stored objects and checks the outcome: the engine (409), the Gramps semantics and schema (400). Returns the
 * stored objects before, the objects to write (normalised, with the derived people), and what changed.
 */
async function resultOf(ctx, actor, plan, ops, label, nowMs) {
  const run = applyOps(plan.objects, ops, plan.applyCtx());
  if (!run.ok) {
    const invalidOps = run.conflicts.filter((x) => INVALID_REASONS.has(x.reason));
    if (invalidOps.length) throw invalid(invalidOps.map((x) => ({ opId: x.opId, obj: x.obj, pointer: "", code: x.reason, detail: x.message ?? x.reason })));
    throw conflictBody(run.conflicts, plan.currentVersions());
  }
  const changes = diffObjects(plan.objects, run.objects);
  const opIdOf = new Map();
  for (const o of ops) {
    const key = TEMP_RE.test(o.obj) ? (run.minted[o.obj] ? `${o.cls}:${run.minted[o.obj]}` : null) : o.obj;
    if (key && !opIdOf.has(key)) opIdOf.set(key, o.id);
  }
  const opIdFor = (k) => opIdOf.get(k) ?? null;
  const before = pick(plan.objects, [...changes.updated, ...changes.deleted]);
  const after = pick(run.objects, [...changes.created, ...changes.updated]);
  // A member may not learn that a record they cannot see exists: a reference this change introduces to one is judged as a reference to nothing.
  const hidden = new Set();
  if (actor.admin !== true) {
    for (const [k, o] of Object.entries(after)) {
      const had = new Set(isObj(before[k]) ? collectRefs(before[k]).map((r) => `${r.cls}:${r.handle}`) : []);
      for (const r of collectRefs(o)) {
        const rk = `${r.cls}:${r.handle}`;
        if (!had.has(rk) && !TEMP_RE.test(r.handle) && !(rk in after) && !(await plan.canSee(rk))) hidden.add(rk);
      }
    }
  }
  const sem = await semantics(ctx, plan.cache, plan.refCache, { before, after, admin: actor.admin === true, today: new Date(nowMs) }, hidden);
  if (!sem.ok) {
    // ...and no error may name a record the viewer cannot see (a deleted record's referrer, a member of a loop): the name is dropped.
    const shown = [];
    for (const e of sem.errors) shown.push(e.obj && !(await plan.canSee(e.obj)) ? { ...e, obj: undefined, path: undefined } : e);
    throw invalid(semanticErrors(shown, opIdFor));
  }
  const final = {};
  for (const [k, o] of Object.entries(sem.objects)) final[k] = { ...o, change: Math.floor(nowMs / 1000) };
  const differs = (k) => plan.storedObj(k) !== undefined && canonicalJson({ ...final[k], change: 0 }) !== canonicalJson({ ...plan.storedObj(k), change: 0 });
  const written = { created: changes.created, updated: sortedUnique([...changes.updated, ...sem.derivedKeys]).filter((k) => k in final && differs(k)), deleted: changes.deleted };
  const bad = schemaErrors(final, [...written.created, ...written.updated], opIdFor);
  if (bad.length) throw invalid(bad, "a value is not allowed");
  plan.guard.assertObjects(pick(final, [...written.created, ...written.updated]), { surface: "changes", op: label, context: plan.contextList(), opIdFor });
  return { run, changes: written, final, opIdFor, versionOf: plan.versionOf, warnings: sem.warnings ?? [] };
}

// ---- the plan (steps 2 to 5) -----------------------------------------------------------------------------------------------------
export async function planChanges(c, req, nowMs, guard, { skipRateLimit = false, mint } = {}) {
  const { actor } = c;
  const ctx = c.store;
  const stored = await loadTouched(ctx, actor, req);
  const context = await loadContext(ctx, stored, stored);
  const objects = {};
  const versions = {};
  for (const [k, h] of stored) { objects[k] = h.obj; versions[k] = h.version; }
  for (const [k, h] of context) objects[k] = h.obj;
  const cache = new Map([...stored, ...context]);
  const seen = new Map();
  const plan = {
    objects, versions, cache, refCache: new Map(),
    guard,
    /** The applyOps context. `mint` (the approval, HFY-TSK-209) is a factory of a handle generator: each run mints the same handles in the same order. */
    applyCtx: () => ({ versions, ...(mint ? { mint: mint() } : {}) }),
    contextList: () => [...context.values()].map((h) => h.obj).concat(Object.values(pick(objects, [...stored.keys()]))),
    currentVersions: () => ({ ...versions }),
    /** The stored version of a key: a touched object, or a derived person loaded for the semantics. */
    versionOf: (k) => versions[k] ?? cache.get(k)?.version,
    storedObj: (k) => objects[k] ?? cache.get(k)?.obj,
    /** Can the viewer see this record? The touched ones were checked on load; an absent one has nothing to hide. */
    canSee: (k) => {
      if (actor.admin === true || stored.has(k)) return Promise.resolve(true);
      if (!seen.has(k)) {
        seen.set(k, (async () => {
          const [cls, handle] = keyParts(k);
          const head = cache.get(k) ?? (await get(ctx, cls, handle));
          if (!head) return true;
          const gid = typeof head.obj.gramps_id === "string" ? head.obj.gramps_id : "";
          return (await viewRecord(ctx, actor, { class: cls, handle, gramps_id: gid, version: head.version, obj: head.obj })) !== null;
        })());
      }
      return seen.get(k);
    },
  };

  // 2-3. All ops on the stored state, then the guard over the full result, before any partition.
  const all = applyOps(objects, req.ops, plan.applyCtx());
  if (!all.ok) {
    const bad = all.conflicts.filter((x) => INVALID_REASONS.has(x.reason));
    if (bad.length) throw invalid(bad.map((x) => ({ opId: x.opId, obj: x.obj, pointer: "", code: x.reason, detail: x.message ?? x.reason })));
    throw conflictBody(all.conflicts, plan.currentVersions());
  }
  const allChanges = diffObjects(objects, all.objects);
  const allOpId = new Map();
  for (const o of req.ops) {
    const key = TEMP_RE.test(o.obj) ? (all.minted[o.obj] ? `${o.cls}:${all.minted[o.obj]}` : null) : o.obj;
    if (key && !allOpId.has(key)) allOpId.set(key, o.id);
  }
  if (req.note) plan.guard.assertValue(req.note, "proposal.note", { surface: "changes", op: "note" });
  plan.guard.assertObjects(pick(all.objects, [...allChanges.created, ...allChanges.updated]), { surface: "changes", op: "submit", context: plan.contextList(), opIdFor: (k) => allOpId.get(k) ?? null });
  screenOps(plan.guard, req.ops, all.results);

  // 4. Classes and the partition.
  const classes = await classifyOps(req.ops, { actor, view: relationView(ctx), objects, customTypes: await customTypes(ctx), log: ctx.log });
  const parts = partitionOps(req.ops, classes);
  if (parts.refused.length) {
    const errors = [];
    const reasons = new Set();
    for (const g of parts.refused) {
      for (const i of g.indexes) {
        const cl = classes[i];
        if (!cl || !isRefusal(cl.code)) continue;
        const reason = arr(cl.kinds).find((k) => typeof k === "string" && k.startsWith("url_"));
        if (reason) reasons.add(reason);
        errors.push({ opId: cl.id, obj: req.ops[i].obj, path: req.ops[i].path ?? "", pointer: `/ops/${i}/path`, code: cl.code, ...(reason ? { reason } : {}), detail: "this can't be changed on the website" });
      }
    }
    throw problem(403, "not_allowed", "some of these changes can't be made on the website", { errors, details: { reasons: [...reasons].sort(), codes: sortedUnique(errors.map((e) => e.code)) } });
  }
  let directGroups = parts.direct;
  let reviewGroups = parts.review;
  if (req.route === "review") {
    reviewGroups = [...directGroups, ...reviewGroups].sort((a, b) => a.indexes[0] - b.indexes[0]);
    directGroups = [];
  }
  const indexesOf = (groups) => groups.flatMap((g) => g.indexes);
  const sumOf = (groups, route) => groups.flatMap((g) => summarizeGroup(req.ops, g, { objects }).map((s) => ({ ...s, route })));
  const shapeOf = (groups) => groups.map((g) => ({ opIds: g.opIds, summary: summarizeGroup(req.ops, g, { objects }) }));
  const out = {
    plan: { direct: shapeOf(directGroups), review: shapeOf(reviewGroups) },
    summary: [...sumOf(directGroups, "direct"), ...sumOf(reviewGroups, "review")],
    warnings: [], direct: null, review: null, stored,
  };

  // 5a. The direct part: a fresh base, the semantics, the schema, the step-up.
  if (directGroups.length) {
    const ops = opsAt(req.ops, indexesOf(directGroups));
    const touched = sortedUnique(ops.map(existingKey).filter(Boolean));
    const stale = touched.filter((k) => req.base_versions[k] !== versions[k]);
    if (stale.length) throw conflictBody(ops.filter((o) => stale.includes(o.obj)).map((o) => ({ opId: o.id, obj: o.obj, path: o.path, reason: "stale_base" })), pick(versions, touched));
    const r = await resultOf(ctx, actor, plan, ops, "direct", nowMs);
    const n = r.changes.created.length + r.changes.updated.length + r.changes.deleted.length;
    if (n > MAX_APPROVAL_OBJECTS) throw problem(413, "too_large", "split this into smaller changes");
    if (actor.admin === true && isDestructive(objects, r.final, r.changes)) requireRecentSignIn(actor, nowMs);
    if (n > 0) { // ops that are all already applied change nothing: no write, no receipt
      out.direct = { ops, ...r };
      out.warnings.push(...r.warnings);
    }
  }

  // 5b. The review part: applied to the stored state too (a proposal is judged on what it would leave), the limits, the size budget.
  // It is planned against the STORED state, not the state after the direct part: the two parts of one submission are independent edits, and the
  // proposal rebases against whatever is stored when it is approved. A review op whose `base` no longer matches the stored value is 409, but a
  // stale base_version alone is not: the proposal is filed with the versions the editor loaded and shows `stale` once the record has moved on.
  if (reviewGroups.length) {
    const ops = opsAt(req.ops, indexesOf(reviewGroups));
    const r = await resultOf(ctx, actor, plan, ops, "review", nowMs);
    const touched = sortedUnique([...ops.map(existingKey).filter(Boolean), ...(req.target ? [req.target] : [])]);
    const counts = { created: r.changes.created.length, updated: r.changes.updated.length, deleted: r.changes.deleted.length, targets: touched.length };
    if (counts.created > MAX_NEW_OBJECTS) throw problem(413, "too_large", `a proposal creates at most ${MAX_NEW_OBJECTS} new objects`);
    if (proposalTooLarge(counts)) throw problem(422, "proposal_too_large", "this suggestion is too big to approve in one step; please split it into smaller ones", { details: { objects: counts.created + counts.updated + counts.deleted } });
    // A soft limit: the count and the write are not one atomic step, so concurrent submissions from one principal can overshoot 50 by a few.
    if (!skipRateLimit && (await recentProposalCount(ctx, actor.id)) >= PROPOSAL_RATE_LIMIT) throw problem(429, "rate_limited", "you have made a lot of suggestions today; please try again tomorrow");
    if (counts.created + counts.updated + counts.deleted > 0) {
      out.review = { ops, ...r, targets: touched };
      out.warnings.push(...r.warnings);
    }
  }
  return out;
}

// ---- step 6: the commit ------------------------------------------------------------------------------------------------------
export function wireOps(direct) {
  const used = new Set();
  const idFor = (k) => {
    let id = direct.opIdFor(k) ?? `d:${k}`;
    while (used.has(id)) id = `${id}.`;
    used.add(id);
    return id.slice(0, 64);
  };
  const out = [];
  const { created, updated, deleted } = direct.changes;
  for (const k of created) { const [cls, handle] = keyParts(k); out.push({ op_id: idFor(k), op: "create", class: cls, handle, base_version: null, obj: direct.final[k] }); }
  for (const k of updated) { const [cls, handle] = keyParts(k); out.push({ op_id: idFor(k), op: "update", class: cls, handle, base_version: direct.versionOf(k), obj: direct.final[k] }); }
  for (const k of deleted) { const [cls, handle] = keyParts(k); out.push({ op_id: idFor(k), op: "delete", class: cls, handle, base_version: direct.versionOf(k) }); }
  return out;
}

function appliedOf(direct) {
  const versions = {};
  for (const k of direct.changes.created) versions[k] = 1;
  for (const k of direct.changes.updated) versions[k] = direct.versionOf(k) + 1;
  // A delete cannot be undone from the web (a deleted person's id is retired for ever), so a group that deletes offers no undo.
  // undo.base_versions names only the records the inverse ops touch (the derived people the semantics rewrote are not undone by it).
  const inverse = direct.run.inverse;
  const minted = direct.run.minted ?? {};
  const touchesOf = (o) => {
    if (typeof o.obj !== "string") return [];
    if (!TEMP_RE.test(o.obj)) return [o.obj];
    return Object.keys(versions).filter((k) => minted[o.obj] && keyParts(k)[1] === minted[o.obj]);
  };
  const undoKeys = new Set(inverse.flatMap(touchesOf));
  const undo = direct.changes.deleted.length ? null : { base_versions: pick(versions, [...undoKeys]), ops: inverse };
  // The records the group deleted, so a client that sent a delete (the admin delete route, a destructive edit) can say what went. Absent when none.
  return { versions, undo, ...(direct.changes.deleted.length ? { deleted: direct.changes.deleted } : {}) };
}

export const subjectOf = (req, stored, ops) => {
  const key = req.target ?? ops.map(existingKey).find((k) => k?.startsWith("Person:")) ?? ops.map(existingKey).find(Boolean);
  const head = key ? stored.get(key) : null;
  if (!head) return null;
  const [cls, handle] = keyParts(key);
  return { cls, handle, gramps_id: typeof head.obj.gramps_id === "string" ? head.obj.gramps_id : "" };
};

/**
 * `extra` (relationship-api): { kind, intent, read_versions, summary } for the proposal document: the kind "relationship", the intent the member
 * sent, the objects the compile read but did not change (checked for staleness with base_versions) and the compiler's sentences.
 */
export async function commit(c, req, planned, nowMs, extra = {}) {
  const { actor } = c;
  const ctx = c.store;
  const at = new Date(nowMs).toISOString();
  const requestHash = requestHashOf(req);
  const { stored } = planned;
  const direct = planned.direct;
  const review = planned.review;

  let proposal = null;
  if (review) {
    const reviewSummary = planned.plan.review.flatMap((g) => g.summary);
    const doc = newProposal({
      id: ctx.uid(), actor, origin: ctx.via === "mcp" ? "mcp" : "web", kind: extra.kind ?? (review.ops.some((o) => o.op === "create") ? "create" : "edit"),
      subject: subjectOf(req, stored, review.ops), targets: review.targets,
      base_versions: pick(req.base_versions, sortedUnique(review.ops.map(existingKey).filter(Boolean))), ops: review.ops, summary: extra.summary ?? reviewSummary, note: req.note, warnings: review.warnings, at,
      ...(extra.intent !== undefined ? { intent: extra.intent } : {}), ...(extra.read_versions !== undefined ? { read_versions: extra.read_versions } : {}),
      owners: await ownersOf(ctx, review.targets, stored), // HFY-TSK-256: contrib-read's proposalVisible reads owners[]
    });
    if (Buffer.byteLength(JSON.stringify(doc)) > MAX_PROPOSAL_BYTES) throw problem(413, "too_large", "the suggestion is too large");
    proposal = doc;
  }
  const applied = direct ? appliedOf(direct) : null;
  if (!direct && !proposal) return { status: 200, body: { applied: null, proposal: null, summary: [], unchanged: true } };
  const body = { applied, proposal: proposal ? proposalView(proposal, actor) : null, summary: planned.summary };
  const result = { status: 201, body };

  const puts = [idemPut({ principal: actor.id, key: req.key, requestHash, result, at, nowMs })];
  if (proposal) {
    puts.push(...proposalPuts(proposal));
    puts.push(proposalAuditItem({ op: "proposal.create", id: proposal.id, principalId: actor.id, at, uid: ctx.uid(), table: ctx.table, after: { state: proposal.state, rev: proposal.rev, targets: proposal.targets.length } }));
  }

  const origin = actor.admin === true ? "admin" : "self";
  if (direct) {
    // applyBatch adds the record contributor's credit to the same transaction (8 actions for a member's own save that also tags, 6 for an
    // admin's tag), so the budget holds what it can add for this origin: past 100 actions, assertTxnSize would throw inside applyBatch.
    const { created, updated, deleted } = direct.changes;
    const items = FIXED_TXN_ITEMS + (deleted.length ? 1 : 0) + created.length * 3 + updated.length * 2 + deleted.length * 3 + puts.length + recordContributorActions(origin);
    if (items > MAX_TXN_ACTIONS) throw problem(413, "too_large", "split this into smaller changes");
  }
  try {
    if (direct) {
      await applyBatch(ctx, { principal: actor.id, origin, idempotencyKey: req.key, ops: wireOps(direct), extra: { puts } });
      invalidateGraph(ctx);
    } else {
      await transact(ctx.ddb, ctx.cmds, ctx.table, { puts, clientRequestToken: requestTokenFor(batchIdFor(actor.id, req.key), 0) }, ctx.txnOpts);
    }
  } catch (e) {
    // Another request with the same key committed first: its receipt decides (the same body replays, another body is 422).
    const raced = (e instanceof TxnCancelled && e.conditionFailed && e.failures.some((f) => f.tag === "changes:idem")) || e instanceof TxnTokenMismatch || (e?.code === "idempotency_key_reused" && e?.status === 422);
    if (raced) {
      const item = await readIdem(ctx, actor.id, req.key);
      if (item) return replayOf(item, requestHash);
    }
    if (e?.code === "version_conflict" && e?.status === 409 && Array.isArray(e.details?.conflicts)) {
      throw problem(409, "version_conflict", "the page changed since you opened it", { details: { current: Object.fromEntries(e.details.conflicts.filter((x) => x.class && x.handle).map((x) => [`${x.class}:${x.handle}`, x.current_version])) } });
    }
    if (e instanceof TxnCancelled) throw problem(503, "unavailable", "the store is busy; retry with the same Idempotency-Key");
    throw e;
  }

  try { ctx.log?.info?.("changes_submitted", { direct: direct ? direct.changes.created.length + direct.changes.updated.length + direct.changes.deleted.length : 0, proposal: proposal ? 1 : 0, ops: req.ops.length }); } catch { /* logging never changes the answer */ }
  if (proposal) await notifySubmitted(c, proposal, stored);
  return result;
}

/** R-10, after the commit: every admin except the proposer. The notifier never throws; a missing admin source notifies nobody. */
async function notifySubmitted(c, proposal, stored) {
  try {
    const head = proposal.subject ? stored.get(`${proposal.subject.cls}:${proposal.subject.handle}`) : null;
    const person = proposal.subject?.cls === "Person" && proposal.subject.gramps_id;
    await c.notifier?.onProposalSubmitted?.({
      proposal: { id: proposal.id, subject: person ? `person:${proposal.subject.gramps_id}` : undefined, subjectLabel: person && head ? displayName(head.obj) || undefined : undefined, proposer: proposal.proposer },
    });
  } catch { /* a notification is a nicety and must not fail a committed write */ }
}

// ---- the route -------------------------------------------------------------------------------------------------------------------
/** POST /api/changes */
export async function changesPost(c) {
  const guard = createRecordGuard({ dob: c.store.guardDob === true, log: c.store.log });
  const req = parseRequest(c, guard);
  const ctx = c.store;
  const nowMs = ctx.now();
  const requestHash = requestHashOf(req);
  if (!req.dry_run) {
    const item = await readIdem(ctx, c.actor.id, req.key);
    if (item) return replayOf(item, requestHash);
  }
  const planned = await planChanges(c, req, nowMs, guard);
  if (req.dry_run) return { status: 200, body: { plan: planned.plan, warnings: planned.warnings, errors: [] } };
  return commit(c, req, planned, nowMs);
}

