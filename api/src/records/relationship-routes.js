// POST /api/relationships/preview and POST /api/relationships (HFY-TSK-210, relationship-api; editing design 8.2, 6.3, 7.3; BRD2 D2-30, R-24, R-06).
//
// The client sends an INTENT (parents | children | spouse | unlink); the server compiles it into EditOps (relationships.js) and then takes the same
// pipeline as POST /api/changes: planChanges() (the stored objects, the engine, the R-18/R-19 guard over the whole resulting state, the field
// classes, the Gramps semantics and schema, the size budget, the rate limit) and commit() (one transaction: the proposal and the IDEM# receipt, or
// for an admin the records through applyBatch()).
//
//   preview   200 { ops, base_versions, read_versions, summary[], warnings[], duplicates[], followUps[], destructive, already_recorded, route }.
//             Nothing is written, no Idempotency-Key. A duplicate is reported, never refused (unless confirmDistinct is sent).
//   submit    201 { proposal } for a member; for an admin with route "auto" (the default) 201 { applied } and no proposal. The Idempotency-Key header
//             is required. Every stub the preview flagged (`new:n`) must be listed in confirmDistinct, or 422 unconfirmed_duplicate; the compile runs in
//             mode "commit", so the gate cannot be skipped by leaving the field out. 409 already_recorded when the tree already says it.
//
// A member ALWAYS gets a proposal of kind "relationship" (R-24: these are relationship proposals, whatever the field policy would let a member save
// directly). The proposal stores the intent and the compiled ops, and `base_versions` (the objects the ops change) beside `read_versions` (the
// objects the compile read and left alone: the proposal store reports it stale when any of the two moved).
//
// Privacy. The guard reads the stub names, the place names and the note BEFORE the compile (422 contact_info | dob_not_allowed | never_in_cloud),
// and planChanges() reads every resulting object (stub names, place names, years) before any PROP# write. The duplicate candidates come from the
// viewer's own view of the records (viewRecord, so dates are year-only), and a living person's lifespan is withheld from a viewer who cannot see it.
// No text a member typed reaches a log line or an error body.
import { createRecordGuard } from "./guard.js";
import { problem, commit, headerOf, planChanges, readIdem, replayOf, requestHashOf, keyParts, sortedUnique } from "./changes.js";
import { compileRelationship, ERROR } from "./relationships.js";
import { findDuplicates, summarizePerson } from "./duplicates.js";
import { get, storeView } from "./index.js";
import { ownPerson, viewRecord } from "./read.js";
import { MAX_PROPOSAL_OPS } from "./proposals.js";
import { MAX_OPS as MAX_BATCH_OPS } from "../sync/store.js";

export const MAX_NOTE_CHARS = 1000;
const MAX_INTENT_BYTES = 16 * 1024;
const MAX_ROUNDS = 12;
const MAX_CANDIDATES = 50; // per stub, before the viewer's view narrows them
const LIVING_YEARS = 110; // the same display hint as the edit bundle's isLiving
const IDEM_KEY_RE = /^[\x21-\x7e]{1,128}$/;
const TEMP_RE = /^new:\d+$/;
const TYPES = new Set(["parents", "children", "spouse", "unlink"]);

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const esc = (s) => String(s).replace(/~/g, "~0").replace(/\//g, "~1");
const invalid = (errors, message = "the request is not valid") => problem(400, "validation", message, { errors });

// ---- the request ---------------------------------------------------------------------------------------------------------------
function parseBody(c, { submit }) {
  const b = c.body;
  const allowed = new Set(submit ? ["intent", "confirmDistinct", "note", "route"] : ["intent", "confirmDistinct"]);
  const errors = [];
  const bad = (pointer, detail) => errors.push({ pointer, detail });
  if (!isObj(b)) throw invalid([{ pointer: "", detail: "the body is an object" }]);
  for (const k of Object.keys(b)) if (!allowed.has(k)) bad(`/${esc(k)}`, "not a field of this request");
  if (!isObj(b.intent)) bad("/intent", "intent is an object");
  else if (!TYPES.has(b.intent.type)) bad("/intent/type", "type is parents, children, spouse or unlink");
  if (b.confirmDistinct !== undefined && !(Array.isArray(b.confirmDistinct) && b.confirmDistinct.length <= 40 && b.confirmDistinct.every((x) => typeof x === "string" && TEMP_RE.test(x)))) {
    bad("/confirmDistinct", "confirmDistinct lists the new:<n> stubs you confirmed are different people");
  }
  if (b.note !== undefined && !(typeof b.note === "string" && b.note.length <= MAX_NOTE_CHARS)) bad("/note", `note is a string of at most ${MAX_NOTE_CHARS} characters`);
  if (b.route !== undefined && b.route !== "auto" && b.route !== "review") bad("/route", "route is auto or review");
  if (errors.length) throw invalid(errors);
  if (Array.isArray(b.confirmDistinct)) {
    const stubCount = stubsOf(b.intent).length;
    b.confirmDistinct.forEach((x, i) => { const n = Number(x.slice(4)); if (n < 1 || n > stubCount) bad(`/confirmDistinct/${i}`, "that is not one of the new people in this request"); });
    if (errors.length) throw invalid(errors);
  }
  if (Buffer.byteLength(JSON.stringify(b.intent)) > MAX_INTENT_BYTES) throw problem(413, "too_large", "the request is too large");

  let key;
  if (submit) {
    key = headerOf(c.event?.headers, "idempotency-key") ?? undefined;
    if (key === undefined) throw invalid([{ pointer: "/headers/idempotency-key", detail: "an Idempotency-Key header is required" }], "an Idempotency-Key is required");
    if (!IDEM_KEY_RE.test(key)) throw invalid([{ pointer: "/headers/idempotency-key", detail: "the Idempotency-Key is 1 to 128 visible characters" }]);
  }
  return {
    intent: b.intent,
    confirm: b.confirmDistinct === undefined ? undefined : sortedUnique(b.confirmDistinct),
    note: typeof b.note === "string" && b.note.trim() ? b.note.trim() : undefined,
    route: b.route ?? "auto",
    key,
  };
}

const REF_RE = /^(Person|Family|Event|Place):[0-9a-f]{1,64}$/;
/** Every string leaf of the intent (keys and values; a record reference carries no free text), for the R-18/R-19 guard: an unknown key cannot smuggle text past it. */
export function intentStrings(intent) {
  const out = [];
  const walk = (v, depth) => {
    if (depth > 12) { out.push("<too deep>"); return; }
    if (typeof v === "string") { if (!REF_RE.test(v)) out.push(v); return; }
    if (typeof v === "number") { out.push(String(v)); return; }
    if (Array.isArray(v)) { v.forEach((x) => walk(x, depth + 1)); return; }
    if (isObj(v)) for (const [k, x] of Object.entries(v)) { out.push(k); walk(x, depth + 1); }
  };
  walk(intent, 0);
  return out;
}

/** The stubs and new places an intent carries: the free text a member typed. Defensive: the compiler names whatever is malformed. */
export function newThings(intent) {
  const out = [];
  const take = (w) => { if (isObj(w) && isObj(w.new)) out.push(w.new); };
  for (const p of arr(intent.parents)) take(isObj(p) ? p.who : null);
  for (const ch of arr(intent.children)) take(isObj(ch) ? ch.who : null);
  take(intent.otherParent);
  take(intent.spouse);
  if (isObj(intent.married) && isObj(intent.married.place)) take(intent.married.place);
  return out;
}
/** The stubs (people) among them, in the order of the intent: the order the compiler numbers `new:n` in is the compiler's, this is only for the prefilter. */
const stubsOf = (intent) => {
  const out = [];
  const take = (w) => { if (isObj(w) && isObj(w.new)) out.push(w.new); };
  for (const p of arr(intent.parents)) take(isObj(p) ? p.who : null);
  take(intent.otherParent);
  for (const ch of arr(intent.children)) take(isObj(ch) ? ch.who : null);
  take(intent.spouse);
  return out;
};

// ---- the viewer's candidates --------------------------------------------------------------------------------------------------
const yearOf = (d) => (isObj(d) && Array.isArray(d.dateval) && Number.isInteger(d.dateval[2]) && d.dateval[2] > 0 ? d.dateval[2] : 0);

/**
 * The people the matcher may offer the viewer: only those whose name is close to a stub's (a prefilter on names, which carry no secret), and
 * each as the viewer's own view of the record (viewRecord: year-only dates). A living person's years are withheld unless the viewer is an admin
 * or it is the viewer's own page, so a candidate's lifespan never says more than the viewer could read.
 */
export async function visiblePeople(ctx, actor, stubs, nowMs) {
  const usable = stubs.filter((s) => typeof s.given === "string" && typeof s.surname === "string")
    .map((s) => ({ given: s.given, surname: s.surname, gender: s.gender, birthYear: Number.isInteger(s.birthYear) ? s.birthYear : null }));
  if (!usable.length) return [];
  const view = await storeView(ctx);
  const heads = view.live().filter((h) => h.class === "Person");
  const cheap = heads.map((h) => summarizePerson(h.obj, null));
  const shortlist = new Set(findDuplicates(usable, cheap, { limit: MAX_CANDIDATES }).flatMap((d) => d.candidates.map((x) => x.handle)));
  const own = actor.admin === true ? null : await ownPerson(ctx, actor);
  const nowYear = new Date(nowMs).getUTCFullYear();
  const people = [];
  for (const h of heads) {
    if (!shortlist.has(h.handle)) continue;
    const seen = await viewRecord(ctx, actor, { class: "Person", handle: h.handle, gramps_id: h.gramps_id, version: h.version, obj: h.obj });
    if (!seen) continue;
    const events = new Map();
    for (const ref of arr(seen.obj.event_ref_list)) {
      if (!isObj(ref) || typeof ref.ref !== "string" || events.has(ref.ref)) continue;
      const head = view.heads.get(`Event:${ref.ref}`);
      if (!head || head.deleted) continue;
      const ev = await viewRecord(ctx, actor, { class: "Event", handle: ref.ref, gramps_id: head.gramps_id, version: head.version, obj: head.obj });
      if (ev) events.set(ref.ref, ev.obj);
    }
    const summary = summarizePerson(seen.obj, (hh) => events.get(hh) ?? null);
    const hasDeath = Number.isInteger(seen.obj.death_ref_index) && seen.obj.death_ref_index >= 0;
    const living = !hasDeath && (!summary.birthYear || summary.birthYear > nowYear - LIVING_YEARS);
    const mine = own !== null && own.handle === h.handle;
    people.push(living && actor.admin !== true && !mine ? { ...summary, birthYear: null, deathYear: null } : summary);
  }
  return people;
}

// ---- the compile, with the objects it reads loaded between rounds -------------------------------------------------------------
async function compileLoaded(ctx, actor, opts) {
  const cache = new Map(); // "Class:handle" -> { obj, version } | null
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const need = new Set();
    const res = compileRelationship({
      ...opts,
      get: (k) => {
        if (cache.has(k)) return cache.get(k)?.obj ?? undefined;
        need.add(k);
        return undefined;
      },
      version: (k) => cache.get(k)?.version,
    });
    if (need.size === 0) return res;
    await Promise.all([...need].map(async (k) => {
      const [cls, handle] = keyParts(k);
      const head = await get(ctx, cls, handle);
      // What the viewer may not see is an unknown object (404), so neither a name nor the existence of a handle is learned from the answer.
      const seen = head ? await viewRecord(ctx, actor, { class: cls, handle, gramps_id: typeof head.obj?.gramps_id === "string" ? head.obj.gramps_id : "", version: head.version, obj: head.obj }) : null;
      cache.set(k, seen ? head : null);
    }));
  }
  throw problem(413, "too_large", "the change reaches too many records");
}

/** The compiler's failure as the same kind of answer /api/changes gives, plus the relationship codes. Never echoes what the member typed. */
function compileProblem(res) {
  const first = res.errors[0];
  const errors = res.errors.map((e) => ({ code: e.code, ...(e.obj ? { obj: e.obj } : {}), detail: e.message }));
  switch (first.code) {
    case ERROR.unconfirmedDuplicate:
      return problem(422, "unconfirmed_duplicate", "is this the same person?", { errors, details: { unconfirmed: first.unconfirmed ?? [], candidates: first.duplicates ?? [] } });
    case ERROR.cycle:
      return problem(422, "cycle", "that would make someone their own ancestor", { errors });
    case ERROR.tooManyChildren:
      return problem(422, "too_many_children", "please add up to ten children at a time", { errors });
    case ERROR.proposalTooLarge:
      return problem(422, "proposal_too_large", "this is too big to approve in one step; please split it into smaller ones", { errors });
    case ERROR.unknownObject:
      return problem(404, "not_found", "no such record", { errors });
    case ERROR.conflict:
      return problem(409, "version_conflict", "the page changed since you opened it", { errors, details: { current: {} } });
    default:
      return invalid(errors, "that cannot be recorded as asked");
  }
}

/** The shared first half: guard the text, build the viewer's candidates, compile. Returns the compile result (ok) or throws. */
async function compileFor(c, parsed, guard, { mode }) {
  const ctx = c.store;
  const nowMs = ctx.now();
  // R-18/R-19 on what the member typed, before anything is read or compiled: stub names, place names, the note.
  // Every string leaf of the intent, not only the stubs and places: the intent is stored verbatim in the proposal.
  const typed = intentStrings(parsed.intent);
  if (typed.length) guard.assertValue(typed, "intent.leaves", { surface: "relationships", op: "intent" });
  if (parsed.note) guard.assertValue(parsed.note, "proposal.note", { surface: "relationships", op: "note" });
  const people = await visiblePeople(ctx, c.actor, stubsOf(parsed.intent), nowMs);
  const res = await compileLoaded(ctx, c.actor, {
    intent: parsed.intent, people, mode, admin: c.actor.admin === true, today: new Date(nowMs),
    ...(parsed.confirm !== undefined || mode === "commit" ? { confirmDistinct: parsed.confirm ?? [] } : {}),
  });
  if (!res.ok) throw compileProblem(res);
  return res;
}

// The compiler writes a complete Gramps object for each create. The field policy refuses a client that writes the fields the server owns
// (`change`, the Person's birth_ref_index and death_ref_index: "derived"), and the semantics pass recomputes them, so they are left out of what is stored.
const DERIVED_ON_CREATE = ["change", "birth_ref_index", "death_ref_index"];
const withoutDerived = (op) => {
  if (op.op !== "create" || !isObj(op.value)) return op;
  const value = { ...op.value };
  for (const k of DERIVED_ON_CREATE) delete value[k];
  // A Name's display_as and sort_as are desktop-only settings ("desk"); the compiler writes their default, 0, which the policy reads as a write.
  if (isObj(value.primary_name)) {
    value.primary_name = { ...value.primary_name };
    for (const k of ["display_as", "sort_as"]) if (value.primary_name[k] === 0) delete value.primary_name[k];
  }
  return { ...op, value };
};

/** The EditOps submission the compile stands for, in the shape planChanges() takes. A member's is always the review route (R-24). */
const routeFor = (c, parsed) => (c.actor.admin === true && parsed.route === "auto" ? "auto" : "review");
function requestFrom(c, parsed, res, { dry }) {
  return {
    target: res.subject, base_versions: res.base_versions, ops: res.ops.map(withoutDerived), note: parsed.note,
    route: routeFor(c, parsed), dry_run: dry, key: parsed.key,
    intent: parsed.intent, confirm: parsed.confirm,
  };
}

// applyBatch takes at most 24 objects (MAX_OPS, D2-30; one op per object): on the auto route a larger compile is refused, not split.
const withinCaps = (res, route) => {
  if (res.ops.length > MAX_PROPOSAL_OPS) throw problem(413, "too_large", `a submission holds at most ${MAX_PROPOSAL_OPS} ops`);
  if (route === "auto") {
    const objects = new Set(res.ops.map((o) => o.obj).filter((x) => typeof x === "string"));
    if (objects.size > MAX_BATCH_OPS) throw problem(413, "too_large", `this change reaches ${objects.size} records and can be applied at most ${MAX_BATCH_OPS} at a time; send it for review or split it into smaller ones`);
  }
};

// A cheap per-actor throttle for the preview (it reads the store and runs the compile rounds on every call): PREVIEW_LIMIT per PREVIEW_WINDOW_MS, per instance.
export const PREVIEW_LIMIT = 60;
const PREVIEW_WINDOW_MS = 60_000;
const previewHits = new Map(); // "table|actor id" -> [ms] (the store context is built per request, so the state lives in the module)
function throttlePreview(ctx, actor, nowMs) {
  const key = `${ctx.table}|${actor.id}`;
  const recent = (previewHits.get(key) ?? []).filter((t) => nowMs - t < PREVIEW_WINDOW_MS);
  if (recent.length >= PREVIEW_LIMIT) { previewHits.set(key, recent); throw problem(429, "rate_limited", "please slow down; try again in a minute"); }
  recent.push(nowMs);
  previewHits.set(key, recent);
  if (previewHits.size > 2000) for (const [k, v] of previewHits) if (!v.some((t) => nowMs - t < PREVIEW_WINDOW_MS)) previewHits.delete(k);
}

// ---- the routes -------------------------------------------------------------------------------------------------------------------
/** POST /api/relationships/preview { intent, confirmDistinct? } */
export async function relationshipsPreview(c) {
  const guard = createRecordGuard({ dob: c.store.guardDob === true, log: c.store.log });
  const parsed = parseBody(c, { submit: false });
  throttlePreview(c.store, c.actor, c.store.now());
  const res = await compileFor(c, parsed, guard, { mode: "preview" });
  const body = {
    ops: res.ops.map(withoutDerived), base_versions: res.base_versions, read_versions: res.read_versions, summary: res.summary, warnings: res.warnings,
    duplicates: res.duplicates, followUps: res.followUps, destructive: res.destructive, already_recorded: res.alreadyRecorded, subject: res.subject,
    route: c.actor.admin === true ? "auto" : "proposal",
  };
  if (res.alreadyRecorded) return { status: 200, body };
  withinCaps(res, routeFor(c, parsed));
  // The same refusals a submit would give (field classes, semantics, schema, the guard over the whole result, size), with nothing written.
  const planned = await planChanges(c, requestFrom(c, parsed, res, { dry: true }), c.store.now(), guard, { skipRateLimit: true });
  return { status: 200, body: { ...body, warnings: [...res.warnings, ...planned.warnings] } };
}

/** POST /api/relationships { intent, confirmDistinct, note?, route? } with an Idempotency-Key header */
export async function relationshipsPost(c) {
  const guard = createRecordGuard({ dob: c.store.guardDob === true, log: c.store.log });
  const parsed = parseBody(c, { submit: true });
  const ctx = c.store;
  const nowMs = ctx.now();
  const item = await readIdem(ctx, c.actor.id, parsed.key);
  if (item) return replayOf(item, requestHashOf({ intent: parsed.intent, confirm: parsed.confirm, note: parsed.note, route: routeFor(c, parsed) }));
  const res = await compileFor(c, parsed, guard, { mode: "commit" });
  if (res.alreadyRecorded) throw problem(409, "already_recorded", "that is already recorded", { details: { summary: res.summary } });
  withinCaps(res, routeFor(c, parsed));
  const req = requestFrom(c, parsed, res, { dry: false });
  const planned = await planChanges(c, req, nowMs, guard);
  const out = await commit(c, req, planned, nowMs, {
    kind: "relationship", intent: parsed.intent, read_versions: res.read_versions, summary: res.summary,
  });
  return out;
}
