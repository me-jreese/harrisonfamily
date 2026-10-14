// The server validator (HFY-TSK-245; sync design 5.7 and 7.2, BRD2 D2-32, review SI-12): the one gate every write passes before applyBatch()
// builds its transaction. It is the `ctx.validate` seam of apply.js, and applyBatch() runs it on every call (the seed and tests opt out
// with ctx.unsafeNoValidate). It reads the batch as it would stand after commit and refuses with a status, a code and pointers, never
// with a value.
//
// Order (the first family that finds anything answers; each family reports every finding in it):
//   1. step-up        403 step_up_required     a desktop delete without a fresh step-up; a destructive batch over the budget without one
//   2. schema         400 validation           the Gramps 6.0.6 JSON Schema per class; MediaRef.rect null or ordered integers 0-100, never [0,0,100,100]
//   3. privacy        422 privacy_violation    redaction policy v1 (checker.js): every rule marked `server: detect`, for every origin
//   4. ids            422 integrity_violation  gramps_id shape and the reserved file names (index, search-index, search-store, graph)
//                     409 reserved_id_block    a desktop or seed create in the cloud block (<prefix>8000-<prefix>8999)
//                     409 renumber_blocked     a Person's gramps_id changes (unless ctx.allowRenumber and op.renumber, operator tooling)
//                     409 gramps_id_retired    a create or update claims a retired Person id, or recreates a retired person
//   5. integrity      422 withdrawn_reference  a web, proposal or graduation op references a withdrawn handle
//                     422 integrity_violation  a reference resolves in neither the store view, the batch nor the open session's expected set;
//                                              for web, proposal and graduation ops also the hard symmetry (person.family_list <-> family
//                                              father/mother, person.parent_family_list <-> family.child_ref_list) and birth/death_ref_index range
//
// Destructive budget. Delete and withdraw ops count together, per batch and over a rolling 24 hours (SYNC#BUDGET# hour counters, kept by
// applyBatch). More than 10 objects, or more than 5 % of the live heads (SYNC#HEAD.live_heads, when known), needs a step-up: 403.
// A desktop `delete` always needs one (D07); a withdraw reduces exposure and needs none below the budget.
//
// `view` is what applyBatch passes: {ops, origin, principal, on_behalf_of, sync_head, record, store, stepUp, expected}. `stepUp` is the
// route's verdict that the caller presented a fresh step-up (amr mfa within its window). `expected(cls, handle)` is true for a handle the
// open push session has announced and will write in a later batch. Both default to nothing: no step-up, an empty expected set.
import { loadPolicy } from "../records/guard.js";
import { batchViolations, scanKinds } from "./checker.js";
import { SyncError } from "./errors.js";
import { loadSchema, rectViolations, schemaViolations } from "./schema.js";
import { createOverlay } from "./view.js";

/** Origins whose writes get the hard integrity checks. A desktop push is checked for symmetry when its session completes. */
export const HARD_ORIGINS = Object.freeze(["self", "admin", "proposal", "graduation", "tag", "moderation"]);
/** More than this many objects destructively removed in one batch or one rolling 24 hours needs a step-up. */
export const DESTRUCTIVE_LIMIT = 10;
/** ...and so does more than this share of the live heads. */
export const DESTRUCTIVE_SHARE = 0.05;
/** gramps_ids that are file names under person/ (and the graph file): the renderer would write over them. */
export const RESERVED_NAMES = Object.freeze(["index", "search-index", "search-store", "graph"]);
/** The Gramps default id prefix of each class: the cloud mints <prefix>8000 to <prefix>8999 (Q2-03). */
export const BLOCK_PREFIX = Object.freeze({ Person: "I", Family: "F", Event: "E", Place: "P", Media: "O", Note: "N", Source: "S", Citation: "C", Repository: "R" });
const BLOCK = Object.fromEntries(Object.entries(BLOCK_PREFIX).map(([cls, p]) => [cls, new RegExp(`^${p}0*8[0-9]{3}$`, "i")]));
const ID_SHAPE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}$/;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const live = (op) => op.op === "create" || op.op === "update";
const refKey = (cls, handle) => `${cls}#${handle}`;

/** The violation as it goes to the caller: where, never what. */
const shown = (v) => ({ rule: v.rule, class: v.class, handle: v.handle, pointer: v.pointer, ...(v.op_id !== undefined ? { op_id: v.op_id } : {}) });
/** An answer lists at most this many violations; `total` says how many there were when it was cut. */
export const MAX_VIOLATIONS = 100;
const refuse = (status, code, message, violations) =>
  new SyncError(status, code, message, { violations: violations.slice(0, MAX_VIOLATIONS).map(shown), ...(violations.length > MAX_VIOLATIONS ? { total: violations.length } : {}) });

// ---- references ------------------------------------------------------------------------------------------------------

const HANDLE_LISTS = Object.freeze({ note_list: "Note", citation_list: "Citation", tag_list: "Tag", family_list: "Family", parent_family_list: "Family" });
const ELEMENT_LISTS = Object.freeze({ event_ref_list: "Event", media_list: "Media", child_ref_list: "Person", person_ref_list: "Person", reporef_list: "Repository", placeref_list: "Place" });

/** [{cls, handle, pointer}] for every handle an object holds: the handle lists, the element refs and the single-handle fields. */
export function referencesOf(object) {
  const out = [];
  const push = (cls, handle, pointer) => {
    if (typeof handle === "string" && handle !== "") out.push({ cls, handle, pointer });
  };
  // `key` is the property that holds `node`; the elements of a list inherit the list's name.
  const walk = (node, pointer, key) => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => {
        if (HANDLE_LISTS[key] && typeof v === "string") push(HANDLE_LISTS[key], v, `${pointer}/${i}`);
        else walk(v, `${pointer}/${i}`, key);
      });
    } else if (isObj(node)) {
      if (ELEMENT_LISTS[key]) push(ELEMENT_LISTS[key], node.ref, `${pointer}/ref`);
      if (key === "lds_ord_list") {
        push("Family", node.famc, `${pointer}/famc`);
        push("Place", node.place, `${pointer}/place`);
      }
      for (const [k, v] of Object.entries(node)) walk(v, `${pointer}/${k.replace(/~/g, "~0").replace(/\//g, "~1")}`, k);
    }
  };
  walk(object, "", null);
  const cls = object._class;
  if (cls === "Family") {
    push("Person", object.father_handle, "/father_handle");
    push("Person", object.mother_handle, "/mother_handle");
  }
  if (cls === "Event") push("Place", object.place, "/place");
  if (cls === "Citation") push("Source", object.source_handle, "/source_handle");
  return out;
}

// ---- the validator ---------------------------------------------------------------------------------------------------

/**
 * Builds `validate(view)` for ctx.validate. Options: `policy` (default: gramps/redaction/redaction-v1.json), `schema` (default: the committed
 * Gramps 6.0.6 schema), `allowRenumber` (default false: operator tooling only), `hardOrigins`.
 */
export function createValidator({ policy, schema, allowRenumber = false, hardOrigins = HARD_ORIGINS } = {}) {
  const pol = policy ?? loadPolicy();
  const scan = scanKinds(pol);
  const hard = new Set(hardOrigins);

  return async function validate(view) {
    const { ops, origin, store } = view;
    const liveOps = ops.filter(live);
    const tag = (ops2, fn) => ops2.flatMap((op) => fn(op).map((v) => ({ ...v, class: op.class, op_id: op.op_id })));

    await checkBudget(view, ops);

    const sch = schema ?? loadSchema();
    const shape = tag(liveOps, (op) => [...schemaViolations(op.obj, sch), ...rectViolations(op.obj, pol)]);
    if (shape.length) throw refuse(400, "validation", "an object does not match the Gramps schema", shape);

    const privacy = await batchViolations({ ops, store, policy: pol, scan });
    if (privacy.length) throw refuse(422, "privacy_violation", "an object holds something that never goes to the cloud", privacy);

    await checkIds(view, liveOps, { allowRenumber });
    await checkIntegrity(view, ops, liveOps, hard.has(origin));
  };
}

/** The validator with its defaults: what applyBatch runs when the caller passes no ctx.validate. */
let shared = null;
export const defaultValidate = (view) => (shared ??= createValidator())(view);

// ---- step-up and the destructive budget --------------------------------------------------------------------------------

async function checkBudget(view, ops) {
  const destructive = ops.filter((op) => op.op === "delete" || op.op === "withdraw");
  if (!destructive.length || view.stepUp === true) return;
  const need = (reason) => new SyncError(403, "step_up_required", "this change needs a fresh step-up", { reason });
  if (view.origin === "desktop" && destructive.some((op) => op.op === "delete")) throw need("delete");
  const rolling = await view.store.destructiveRolling();
  const total = rolling + destructive.length;
  const heads = view.sync_head?.live_heads;
  if (total > DESTRUCTIVE_LIMIT || (Number.isFinite(heads) && heads > 0 && total > heads * DESTRUCTIVE_SHARE)) throw need("budget");
}

// ---- ids -------------------------------------------------------------------------------------------------------------

async function checkIds(view, liveOps, { allowRenumber }) {
  const { store, origin } = view;
  const bad = [];
  for (const op of liveOps) {
    if (op.class === "Tag") continue;
    const id = op.obj.gramps_id;
    if (typeof id !== "string" || !ID_SHAPE.test(id) || id.includes("..")) bad.push({ rule: "id.shape", class: op.class, handle: op.handle, pointer: "/gramps_id", op_id: op.op_id });
    else if (RESERVED_NAMES.includes(id.toLowerCase())) bad.push({ rule: "id.reserved_name", class: op.class, handle: op.handle, pointer: "/gramps_id", op_id: op.op_id });
  }
  if (bad.length) throw refuse(422, "integrity_violation", "a gramps_id is not allowed", bad);

  const conflict = (op) => ({ op_id: op.op_id, class: op.class, handle: op.handle });
  const block = liveOps.filter((op) => op.op === "create" && (origin === "desktop" || origin === "seed") && BLOCK[op.class]?.test(op.obj.gramps_id));
  if (block.length) throw new SyncError(409, "reserved_id_block", "ids from the reserved block are minted by the website, not the desktop", { conflicts: block.map(conflict) });

  const renumber = [];
  const retired = [];
  for (const op of liveOps) {
    if (op.class !== "Person") continue;
    const prev = await store.get("Person", op.handle);
    const old = prev && !prev.deleted ? prev.gramps_id : undefined;
    if (old !== undefined && old !== op.obj.gramps_id && !(allowRenumber && op.renumber === true)) renumber.push(op);
    if (op.renumber === true && !allowRenumber) renumber.push(op);
    if (old === op.obj.gramps_id) continue;
    // A retired id is never claimed again, by anyone, its own person included; a recreated tombstone is a retired person.
    const guard = await store.gid("Person", op.obj.gramps_id);
    if ((guard && guard.retired === true) || (op.op === "create" && prev && prev.deleted)) retired.push(op);
  }
  // A retired id is the more specific answer when an update both renumbers and claims one.
  if (retired.length) throw new SyncError(409, "gramps_id_retired", "that gramps_id belongs to a retired person and is never reused", { conflicts: retired.map(conflict) });
  if (renumber.length) throw new SyncError(409, "renumber_blocked", "a person's gramps_id cannot change", { conflicts: [...new Map(renumber.map((o) => [o.op_id, conflict(o)])).values()] });
}

// ---- integrity -------------------------------------------------------------------------------------------------------

async function checkIntegrity(view, ops, liveOps, isHard) {
  const { store, expected } = view;
  const { written, removed, withdrawn, after } = createOverlay(ops, store);
  const expectedHas = (cls, handle) => typeof expected === "function" && expected(cls, handle) === true;

  // 1. References resolve: in the store view, in the batch, or in the open session's expected set.
  const gone = []; // withdrawn
  const dangling = [];
  const statusOf = new Map();
  const resolve = async (cls, handle) => {
    const key = refKey(cls, handle);
    if (written.has(key)) return "ok";
    if (removed.has(key)) return withdrawn.has(key) ? "withdrawn" : "missing";
    const head = await store.get(cls, handle);
    if (head && !head.deleted) return "ok";
    if (head && head.deleted && (await store.item(cls, handle))?.reason === "private") return "withdrawn";
    return expectedHas(cls, handle) ? "ok" : "missing";
  };
  for (const op of liveOps) {
    for (const r of referencesOf(op.obj)) {
      const key = refKey(r.cls, r.handle);
      if (!statusOf.has(key)) statusOf.set(key, await resolve(r.cls, r.handle));
      const status = statusOf.get(key);
      const v = { class: op.class, handle: op.handle, pointer: r.pointer, op_id: op.op_id };
      if (status === "withdrawn" && isHard) gone.push({ ...v, rule: "integrity.withdrawn_reference" });
      else if (status !== "ok") dangling.push({ ...v, rule: "integrity.unresolved_reference" });
    }
  }
  if (gone.length) throw refuse(422, "withdrawn_reference", "an object references something that was withdrawn", gone);
  if (dangling.length) throw refuse(422, "integrity_violation", "a reference does not resolve", dangling);
  if (!isHard) return;

  // 2. Hard symmetry, on the objects as they will stand: every person <-> family link either side of the batch touches.
  const links = new Map(); // "kind|P|F" -> op_id of the first op that touches it
  const note = (kind, p, f, opId) => {
    if (typeof p === "string" && p && typeof f === "string" && f && !links.has(`${kind}|${p}|${f}`)) links.set(`${kind}|${p}|${f}`, opId);
  };
  const collect = (cls, handle, o, opId) => {
    if (!isObj(o)) return;
    if (cls === "Person") {
      arr(o.family_list).forEach((f) => note("spouse", handle, f, opId));
      arr(o.parent_family_list).forEach((f) => note("child", handle, f, opId));
    } else {
      note("spouse", o.father_handle, handle, opId);
      note("spouse", o.mother_handle, handle, opId);
      arr(o.child_ref_list).forEach((c) => isObj(c) && note("child", c.ref, handle, opId));
    }
  };
  for (const op of ops) {
    if (op.op === "marker" || (op.class !== "Person" && op.class !== "Family")) continue;
    const before = await store.get(op.class, op.handle);
    if (before && !before.deleted) collect(op.class, op.handle, before.obj, op.op_id);
    if (live(op)) collect(op.class, op.handle, op.obj, op.op_id);
  }
  const broken = [];
  for (const [k, opId] of links) {
    const [kind, p, f] = k.split("|");
    const po = await after("Person", p);
    const fo = await after("Family", f);
    const pIdx = po ? arr(kind === "spouse" ? po.family_list : po.parent_family_list).indexOf(f) : -1;
    const fPointer = (() => {
      if (!fo) return null;
      if (kind === "spouse") return fo.father_handle === p ? "/father_handle" : fo.mother_handle === p ? "/mother_handle" : null;
      const i = arr(fo.child_ref_list).findIndex((c) => isObj(c) && c.ref === p);
      return i >= 0 ? `/child_ref_list/${i}/ref` : null;
    })();
    const rule = `integrity.symmetry.${kind}`;
    if (pIdx >= 0 && fPointer === null) broken.push({ rule, class: "Person", handle: p, pointer: `/${kind === "spouse" ? "family_list" : "parent_family_list"}/${pIdx}`, op_id: opId });
    else if (pIdx < 0 && fPointer !== null) broken.push({ rule, class: "Family", handle: f, pointer: fPointer, op_id: opId });
  }
  for (const op of liveOps) {
    if (op.class !== "Person") continue;
    for (const field of ["birth_ref_index", "death_ref_index"]) {
      const i = op.obj[field];
      if (i !== undefined && !(Number.isInteger(i) && i >= -1 && i < arr(op.obj.event_ref_list).length)) broken.push({ rule: "integrity.index_range", class: "Person", handle: op.handle, pointer: `/${field}`, op_id: op.op_id });
    }
  }
  if (broken.length) throw refuse(422, "integrity_violation", "the change would leave a relationship half-linked", broken);
}
