// Admin web deletes and the possible-duplicate queue (HFY-TSK-295, edit-admin-delete; BRD2 Q2-15, review IF-03, D2-30, SI-02, SI-12; editing design 3.2).
//
//   POST /api/admin/deletes    { targets: ["Person:<handle>", ...], base_versions: { "<key>": <version> }, remove_references?: boolean, dry_run?: boolean }
//   GET  /api/admin/duplicates ?limit=1-100 (default 50) &cursor=
//
// io answered Q2-15 yes: an ADMIN may delete a Person, Family, Event, Place, Source, Citation or Media from the website. It is the desktop's
// delete, not a new kind of write. This module compiles the request into EditOps and then takes the same pipeline as POST /api/changes
// (planChanges(): the stored objects, the engine, the R-18/R-19 guard, the field classes, the Gramps semantics and schema, the size budget;
// commit(): one applyBatch transaction with the Idempotency-Key receipt), so a delete is judged by the rules every other edit is:
//   - a member is 403 not_allowed, whatever the flag says (the flag only decides whether the route exists at all: a dark route is 404);
//   - step-up is the admin's sign-in age (auth_time within 900 s, 401 step_up_required): planChanges() requires it for any destructive direct
//     change, and nothing here can turn it off;
//   - the delete/withdraw budget is the validator's (more than 10 objects, or 5 % of the live heads, in one rolling 24 hours). The web has no
//     stronger step-up to lift it with, so over the budget the delete is 403 delete_budget (the desktop sync carries the larger purges);
//   - a Person's gramps_id is retired for ever by applyBatch (store-apply-core, SI-02): a delete never frees it, and a later create over it is
//     409 gramps_id_retired;
//   - the Gramps symmetry checks (the two sides of every family link, a parent who is not also a child, no dangling handle) run on the result.
//
// What a delete takes with it, as Gramps' own delete queries do, and no more:
//   - a Source takes its Citations (a Citation cannot exist without its Source);
//   - a Person or Family takes an Event that nothing else uses (an exclusive Event would otherwise outlive the person it describes);
//   - a Person takes a Family that the delete leaves with no parent and no child.
// Everything else that points at a deleted object keeps pointing at nothing, so it is cleaned in the SAME batch (the reference is removed from
// the referrer) when `remove_references` is true; without it the delete is refused, 409 still_referenced, with the list of referrers, so the
// admin sees what a delete would touch before agreeing to it. The objects the cascade adds are named in the plan (dry run) either way.
//
// The queue (GET /api/admin/duplicates) lists pairs of people the duplicate matcher (duplicates.js) thinks may be one person. It is READ-ONLY and
// writes no record: there is no "flagged" state, and a merge stays a desktop operation. It exists so io, merging in Gramps, starts from a list.
// It lists the whole tree, so it keeps the duplicate matcher's privacy contract (a candidate's lifespan never carries a year the record API
// would withhold): a living person, or one whose status is unknown, has no lifespan in a row (the years still count toward the score, on the
// server, and the names are shown as everywhere else). A person is "living" by the edit bundle's display hint: no death event, and no birth
// year or a birth within the last 110 years. Only a person with a recorded death, or born longer ago than that, shows a lifespan.
//
// A dry run's plan counts the cascade against the two limits it spends: `plan.objects` is every record the batch touches (deletes and link
// updates) against `plan.max_objects` (one applyBatch, 24), and `budget.adding` is every record deleted, the cascade's included, against the
// rolling delete budget. A record the cascade adds carries `why`, so the sheet names it.
import { HttpError } from "../http.js";
import { SyncError } from "../sync/errors.js";
import { DESTRUCTIVE_LIMIT, DESTRUCTIVE_SHARE, budgetVerdict } from "../sync/validator.js";
import { MAX_OPS as MAX_BATCH_OBJECTS, getSyncHead } from "../sync/store.js";
import { createStoreView } from "../sync/view.js";
import { createRecordGuard } from "./guard.js";
import { editingOn } from "./edit-bundle.js";
import { backrefs, get, storeView } from "./index.js";
import { collectRefs } from "./semantics.js";
import { deepClone, hashObject, keySegment } from "./ops.js";
import { findDuplicatePairs, summarizePerson } from "./duplicates.js";
import { commit, displayName, headerOf, keyParts, planChanges, problem, readIdem, replayOf, requestHashOf, sortedUnique } from "./changes.js";
import { MAX_PROPOSAL_OPS } from "./proposals.js";

/** The classes an admin may delete on the web (Q2-15). A Repository, a Note or a Tag is not on the list. */
export const DELETABLE_CLASSES = Object.freeze(["Person", "Family", "Event", "Place", "Source", "Citation", "Media"]);
/** Targets in one request. The cascade and the referrers add to this; the whole batch is capped at one applyBatch (24 objects). */
export const MAX_TARGETS = 10;
const MAX_REFERRERS = 200;
const MAX_CASCADE_ROUNDS = 50;
const KEY_RE = /^(Person|Family|Event|Place|Source|Citation|Repository|Media|Note):[A-Za-z0-9_-]{1,64}$/;
const TOP_FIELDS = new Set(["targets", "base_versions", "remove_references", "dry_run"]);
const IDEM_KEY_RE = /^[\x21-\x7e]{1,128}$/;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const esc = (s) => String(s).replace(/~/g, "~0").replace(/\//g, "~1");
const invalid = (errors, message = "the request is not valid") => problem(400, "validation", message, { errors });
const gidOf = (obj) => (typeof obj?.gramps_id === "string" ? obj.gramps_id : "");
const classOf = (key) => keyParts(key)[0];
const refsOf = (list) => arr(list).map((r) => (isObj(r) ? r.ref : r)).filter((h) => typeof h === "string" && h);

// ---- the gate ---------------------------------------------------------------------------------------------------------------------
/** The route's own rules, after the feature gate: the editing stack switch (writes need it), then admin. A member is 403 not_allowed. */
function requireAdmin(c) {
  if (!editingOn()) throw new HttpError(404, "not_found", "no such route");
  if (c.actor?.admin !== true) {
    throw problem(403, "not_allowed", "only an admin can do this on the website", { errors: [{ pointer: "", code: "admin", detail: "deleting records and the possible-duplicate queue are for admins" }] });
  }
}

// ---- the request ---------------------------------------------------------------------------------------------------------------------
export function parseDeleteRequest(c) {
  const b = c.body;
  const errors = [];
  const bad = (pointer, detail) => errors.push({ pointer, detail });
  if (!isObj(b)) throw invalid([{ pointer: "", detail: "the body is an object" }]);
  for (const k of Object.keys(b)) if (!TOP_FIELDS.has(k)) bad(`/${esc(k)}`, "not a field of this request");
  if (!(Array.isArray(b.targets) && b.targets.length > 0 && b.targets.length <= MAX_TARGETS)) bad("/targets", `targets lists 1 to ${MAX_TARGETS} records as Class:handle`);
  else {
    b.targets.forEach((t, i) => {
      if (!(typeof t === "string" && KEY_RE.test(t))) bad(`/targets/${i}`, "a target looks like Person:<handle>");
      else if (!DELETABLE_CLASSES.includes(classOf(t))) bad(`/targets/${i}`, `only ${DELETABLE_CLASSES.join(", ")} can be deleted on the website`);
    });
    if (new Set(b.targets).size !== b.targets.length) bad("/targets", "a record is listed once");
  }
  if (!(isObj(b.base_versions) && Object.entries(b.base_versions).every(([k, v]) => KEY_RE.test(k) && Number.isInteger(v) && v >= 1))) bad("/base_versions", "base_versions maps each target to the version you loaded");
  else if (Array.isArray(b.targets)) b.targets.forEach((t, i) => { if (typeof t === "string" && b.base_versions[t] === undefined) bad(`/base_versions/${esc(t)}`, `base_versions has no version of ${t}`); });
  if (b.remove_references !== undefined && typeof b.remove_references !== "boolean") bad("/remove_references", "remove_references is true or false");
  if (b.dry_run !== undefined && typeof b.dry_run !== "boolean") bad("/dry_run", "dry_run is true or false");
  const key = headerOf(c.event?.headers, "idempotency-key");
  const dry = b.dry_run === true;
  if (key !== undefined && !(typeof key === "string" && IDEM_KEY_RE.test(key))) bad("/headers/idempotency-key", "the Idempotency-Key is 1 to 128 visible characters");
  if (!dry && key === undefined) bad("/headers/idempotency-key", "an Idempotency-Key header is required");
  if (errors.length) throw invalid(errors);
  const targets = [...b.targets].sort();
  return {
    targets, base_versions: Object.fromEntries(targets.map((t) => [t, b.base_versions[t]])), remove_references: b.remove_references === true, dry_run: dry, key: dry ? undefined : key,
  };
}

// ---- the cascade ---------------------------------------------------------------------------------------------------------------------
/**
 * The set of objects the delete removes: the targets, then what Gramps removes with them (see the header), to a fixed point. Returns
 * Map key -> { cls, obj, version, why } with why "target", "source_citation", "emptied_family" or "exclusive_event".
 */
async function cascade(ctx, targets) {
  const del = new Map();
  const missing = [];
  for (const k of targets) {
    const [cls, handle] = keyParts(k);
    const head = await get(ctx, cls, handle);
    if (!head) missing.push(k);
    else del.set(k, { cls, obj: head.obj, version: head.version, why: "target" });
  }
  if (missing.length) {
    throw problem(404, "not_found", "no such record", { errors: missing.map((k) => ({ obj: k, pointer: "/targets", code: "not_found", detail: "no such record" })) });
  }
  const load = async (k) => {
    const [cls, handle] = keyParts(k);
    const head = await get(ctx, cls, handle);
    return head ? { cls, obj: head.obj, version: head.version } : null;
  };
  const gone = (h, cls) => del.has(`${cls}:${h}`);
  for (let round = 0; ; round += 1) {
    if (round > MAX_CASCADE_ROUNDS || del.size > MAX_REFERRERS) throw problem(413, "too_large", "this delete reaches too many records");
    const before = del.size;
    const live = [...del.entries()];
    // a Source takes its Citations
    for (const [k, d] of live) {
      if (d.cls !== "Source") continue;
      for (const rk of await backrefs(ctx, k)) {
        if (classOf(rk) !== "Citation" || del.has(rk)) continue;
        const one = await load(rk);
        if (one) del.set(rk, { ...one, why: "source_citation" });
      }
    }
    // a Person takes a Family it leaves empty
    for (const [, d] of live) {
      if (d.cls !== "Person") continue;
      for (const fh of [...arr(d.obj.family_list), ...arr(d.obj.parent_family_list)]) {
        const fk = `Family:${fh}`;
        if (del.has(fk)) continue;
        const one = await load(fk);
        if (!one) continue;
        const parents = [one.obj.father_handle, one.obj.mother_handle].filter((h) => typeof h === "string" && h && !gone(h, "Person"));
        const children = refsOf(one.obj.child_ref_list).filter((h) => !gone(h, "Person"));
        if (!parents.length && !children.length) del.set(fk, { ...one, why: "emptied_family" });
      }
    }
    // a Person or Family takes an Event nothing else uses
    for (const [, d] of [...del.entries()]) {
      if (d.cls !== "Person" && d.cls !== "Family") continue;
      for (const eh of refsOf(d.obj.event_ref_list)) {
        const ek = `Event:${eh}`;
        if (del.has(ek)) continue;
        if ((await backrefs(ctx, ek)).every((rk) => del.has(rk))) {
          const one = await load(ek);
          if (one) del.set(ek, { ...one, why: "exclusive_event" });
        }
      }
    }
    if (del.size === before) return del;
  }
}

// ---- cleaning a referrer ---------------------------------------------------------------------------------------------------------------
// The scalar fields that hold a handle and may be empty. Citation.source_handle is not one: its Citation is deleted with the Source.
const NULLABLE_SCALARS = new Set(["father_handle", "mother_handle", "place"]);

/**
 * The ops that take every reference to a deleted object out of `obj` (a referrer, not itself deleted): a list element is removed by its key, a
 * nullable handle is set to null. A reference whose element is itself removed (an EventRef) takes the references inside it along, so those
 * need no op of their own. Returns { ops, blocked }: `blocked` lists the references no op can clean (none for the Gramps 6.0.6 shapes today;
 * the list keeps an unknown shape from being half-cleaned).
 */
export function cleanOps(key, obj, doomed, nextId) {
  const found = [];
  const blocked = [];
  for (const ref of collectRefs(obj)) {
    if (!doomed.has(`${ref.cls}:${ref.handle}`)) continue;
    const path = ref.path;
    const last = path[path.length - 1];
    // Walk the path, building the pointer with list keys against the object as stored (the engine reads keys at the start of the call).
    const build = (upTo) => {
      let node = obj;
      let listName = null;
      const segs = [];
      for (let i = 0; i < upTo; i += 1) {
        const step = path[i];
        if (typeof step === "number") { segs.push(keySegment(listName, node, step)); node = node[step]; } else { segs.push(esc(step)); node = node[step]; listName = step; }
      }
      return { pointer: `/${segs.join("/")}`, node };
    };
    if (typeof last === "number") {
      const { pointer, node } = build(path.length);
      found.push({ kind: "remove", pointer, base: deepClone(node) });
    } else if (last === "ref" && typeof path[path.length - 2] === "number") {
      const { pointer, node } = build(path.length - 1);
      found.push({ kind: "remove", pointer, base: deepClone(node) });
    } else if (NULLABLE_SCALARS.has(last)) {
      const { pointer, node } = build(path.length);
      found.push({ kind: "set", pointer, base: node });
    } else {
      blocked.push({ key, field: String(last) });
    }
  }
  // An element removed whole covers anything addressed inside it.
  found.sort((a, b) => a.pointer.length - b.pointer.length || (a.pointer < b.pointer ? -1 : 1));
  const kept = [];
  for (const f of found) {
    if (kept.some((k) => k.pointer === f.pointer || (k.kind === "remove" && f.pointer.startsWith(`${k.pointer}/`)))) continue;
    kept.push(f);
  }
  const ops = kept.map((f) => (f.kind === "remove"
    ? { id: nextId("r"), op: "remove", obj: key, path: f.pointer, base: f.base }
    : { id: nextId("r"), op: "set", obj: key, path: f.pointer, base: f.base, value: null }));
  return { ops, blocked };
}

const labelOf = (cls, obj) => (cls === "Person" ? displayName(obj) : "");
const describe = (key, obj, extra = {}) => ({ key, class: classOf(key), gramps_id: gidOf(obj), label: labelOf(classOf(key), obj), ...extra });

/**
 * The compile: targets -> { ops, base_versions, deletes, updates, target }. Throws 404 (no such record), 409 still_referenced (referrers, and the
 * references no op can clean), 413 too_large.
 */
export async function compileDelete(ctx, parsed) {
  const del = await cascade(ctx, parsed.targets);
  const doomed = new Set(del.keys());
  const referrers = new Map(); // key -> { cls, obj, version }
  for (const k of doomed) {
    for (const rk of await backrefs(ctx, k)) {
      if (doomed.has(rk) || referrers.has(rk)) continue;
      const [cls, handle] = keyParts(rk);
      const head = await get(ctx, cls, handle);
      if (head) referrers.set(rk, { cls, obj: head.obj, version: head.version });
      if (referrers.size > MAX_REFERRERS) throw problem(413, "too_large", "too many records point at what you are deleting; delete in smaller steps or use Gramps");
    }
  }
  const willDelete = [...del].map(([k, d]) => describe(k, d.obj, { why: d.why }));
  const list = [...referrers].map(([k, r]) => describe(k, r.obj));
  if (list.length && !parsed.remove_references) {
    throw problem(409, "still_referenced", "other records point at what you are deleting", { details: { referrers: list.sort((a, b) => (a.key < b.key ? -1 : 1)), delete: willDelete } });
  }
  let n = 0;
  const nextId = (p) => `${p}${(n += 1)}`;
  const ops = [];
  const blocked = [];
  for (const [k, r] of [...referrers].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const one = cleanOps(k, r.obj, doomed, nextId);
    ops.push(...one.ops);
    blocked.push(...one.blocked);
  }
  if (blocked.length) {
    throw problem(409, "still_referenced", "some references cannot be removed automatically", { details: { referrers: list, blocked, delete: willDelete } });
  }
  for (const [k, d] of [...del].sort(([a], [b]) => (a < b ? -1 : 1))) ops.push({ id: nextId("d"), op: "delete", obj: k, base_hash: hashObject(d.obj) });
  const touched = sortedUnique([...del.keys(), ...ops.filter((o) => o.op !== "delete").map((o) => o.obj)]);
  if (touched.length > MAX_BATCH_OBJECTS || ops.length > MAX_PROPOSAL_OPS) {
    throw problem(413, "too_large", `this delete reaches ${touched.length} records and can be applied at most ${MAX_BATCH_OBJECTS} at a time; delete fewer at once`, { details: { objects: touched.length, max: MAX_BATCH_OBJECTS } });
  }
  const base_versions = {};
  for (const k of touched) base_versions[k] = parsed.base_versions[k] ?? del.get(k)?.version ?? referrers.get(k)?.version;
  const updates = [...new Set(ops.filter((o) => o.op !== "delete").map((o) => o.obj))].sort().map((k) => describe(k, referrers.get(k).obj));
  return { ops, base_versions, deletes: willDelete, updates, referrers: list, target: parsed.targets[0] };
}

// ---- the budget, for the dry run -------------------------------------------------------------------------------------------------------
/** What the commit will find: { used, adding, limit, share, over, reason? }. The same rule as the validator's (budgetVerdict). */
async function budgetFor(ctx, adding) {
  const view = createStoreView(ctx, { now: ctx.now });
  const head = await getSyncHead(ctx);
  const used = await view.destructiveRolling();
  const reason = budgetVerdict({ rolling: used, adding, heads: head?.live_heads, seq: head?.seq });
  return { used, adding, limit: DESTRUCTIVE_LIMIT, share: DESTRUCTIVE_SHARE, over: reason !== null, ...(reason ? { reason } : {}) };
}

const budgetProblem = (reason) => problem(403, "delete_budget", "too many records were deleted in the last 24 hours to delete more on the website; use Gramps on the desktop, or wait", { details: { reason, limit: DESTRUCTIVE_LIMIT } });

// ---- the routes ----------------------------------------------------------------------------------------------------------------------
/** POST /api/admin/deletes */
export async function adminDeletesPost(c) {
  requireAdmin(c);
  const guard = createRecordGuard({ dob: c.store.guardDob === true, log: c.store.log });
  const parsed = parseDeleteRequest(c);
  const ctx = c.store;
  const nowMs = ctx.now();
  const intent = { type: "admin_delete", targets: parsed.targets, base_versions: parsed.base_versions, remove_references: parsed.remove_references };
  const hash = requestHashOf({ intent, route: "auto" });
  if (!parsed.dry_run) {
    const item = await readIdem(ctx, c.actor.id, parsed.key);
    if (item) return replayOf(item, hash);
  }
  const compiled = await compileDelete(ctx, parsed);
  const req = { target: compiled.target, base_versions: compiled.base_versions, ops: compiled.ops, note: undefined, route: "auto", dry_run: parsed.dry_run, key: parsed.key, intent };
  const planned = await planChanges(c, req, nowMs, guard, { skipRateLimit: true });
  if (parsed.dry_run) {
    const retired = compiled.deletes.filter((d) => d.class === "Person" && d.gramps_id).map((d) => d.gramps_id);
    return {
      status: 200,
      body: {
        plan: {
          delete: compiled.deletes, update: compiled.updates, retired_ids: retired, objects: compiled.deletes.length + compiled.updates.length, max_objects: MAX_BATCH_OBJECTS,
          cascade: compiled.deletes.filter((d) => d.why !== "target").length,
        },
        budget: await budgetFor(ctx, compiled.deletes.length),
        summary: planned.summary, warnings: planned.warnings, errors: [],
      },
    };
  }
  try {
    return await commit(c, req, planned, nowMs);
  } catch (e) {
    if (e instanceof SyncError && e.status === 403 && e.code === "step_up_required" && ["budget", "heads_unknown"].includes(e.details?.reason)) throw budgetProblem(e.details.reason);
    throw e;
  }
}

const DEFAULT_PAGE = 50;
const MAX_PAGE = 100;
const LIVING_YEARS = 110; // the edit bundle's isLiving hint
/** True when the matcher summary may print this person's years: a recorded death, or a birth long enough ago. Unknown status hides them. */
export const yearsShown = (obj, summary, nowYear) => {
  const hasDeath = Number.isInteger(obj?.death_ref_index) && obj.death_ref_index >= 0;
  if (hasDeath) return true;
  return Number.isInteger(summary?.birthYear) && summary.birthYear > 0 && summary.birthYear <= nowYear - LIVING_YEARS;
};
const personRow = (p, gid) => ({ key: `Person:${p.handle}`, gramps_id: gid.get(p.handle) ?? "", displayName: p.displayName, lifespan: p.lifespan });

/** GET /api/admin/duplicates: pairs of people who may be one person, best first. Read-only. */
export async function adminDuplicatesList(c) {
  requireAdmin(c);
  const q = c.query ?? {};
  const limit = q.limit === undefined ? DEFAULT_PAGE : Number(q.limit);
  if (!(Number.isInteger(limit) && limit >= 1 && limit <= MAX_PAGE)) throw invalid([{ pointer: "/limit", detail: `limit is 1 to ${MAX_PAGE}` }]);
  const offset = q.cursor === undefined || q.cursor === "" ? 0 : /^\d{1,7}$/.test(String(q.cursor)) ? Number(q.cursor) : -1;
  if (offset < 0) throw invalid([{ pointer: "/cursor", detail: "cursor is the one a previous page returned" }]);
  const view = await storeView(c.store);
  const events = (h) => { const e = view.heads.get(`Event:${h}`); return e && !e.deleted ? e.obj : undefined; };
  const people = view.live().filter((h) => h.class === "Person");
  const gid = new Map(people.map((h) => [h.handle, gidOf(h.obj)]));
  const nowYear = new Date(c.store.now()).getUTCFullYear();
  const shown = new Set();
  const summaries = people.map((h) => {
    const sum = summarizePerson(h.obj, events);
    if (yearsShown(h.obj, sum, nowYear)) shown.add(h.handle);
    return sum;
  });
  const pairs = findDuplicatePairs(summaries, { showYears: (p) => shown.has(p.handle) });
  const items = pairs.slice(offset, offset + limit).map((p) => ({ a: personRow(p.a, gid), b: personRow(p.b, gid), score: p.score }));
  const next = offset + limit < pairs.length ? String(offset + limit) : null;
  return { status: 200, body: { items, cursor: next, total: pairs.length } };
}
