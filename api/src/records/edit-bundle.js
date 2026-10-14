// The editing API core (HFY-TSK-182, edit-api-core; editing design sections 4 and 7.1-7.2, BRD2 D2-12, D2-34, Q2-04b, review PS-07..09).
//
//   GET /api/edit/schema/:cls   the generated JSON Schema of one editable class, with its schemaHash
//   GET /api/edit/:cls/:ref     the edit bundle: the record, the objects it references, the viewer's relation, the policy table and pending[]
//   GET /api/me                 gains ownRecord and editing (buildMe extras; see ownRecordFor and editingOn)
//
// Every route here sits behind the HFY_EDITING stack switch (editingGate): while it is not "on" each answers 404 not_found, an admin included, so no
// editing route can be reached by curl before the flip (DEC-E15). POST /api/changes is edit-api-changes'.
//
// What a member sees. Every object in the bundle goes through viewRecord (records/read.js): publishView (Q2-04b: no day or month on another person's
// non-birth date) and applyModOverlay (no hidden note, MediaRef or Media for a non-owner). A hidden Note or Media is left out of `related`.
// The related objects also hold, one level further, the places of the related events and the sources of the related citations (HFY-TSK-156).
// pending[] lists only the proposals the viewer may see: their own, every one for an admin, or one that targets the viewer's own Person or Families
// (R2-28, PS-09). A third member gets []. Nothing in a bundle echoes a proposal's ops values, note or decision.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { HttpError, json } from "../http.js";
import { serverSwitch } from "../features.js";
import { CLASSES } from "../sync/store.js";
import { backrefs, byGrampsId, customTypes, get } from "./index.js";
import { collectRefs } from "./semantics.js";
import { DEFAULT_FIELD_POLICY, ownRecord, relationOf } from "./field-policy.js";
import { ownPerson, viewRecord } from "./read.js";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const notFound = () => new HttpError(404, "not_found", "no such record");
const HANDLE_RE = /^[A-Za-z0-9_-]{1,64}$/;
const GID_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** The classes that have a generated schema (Tag has none). */
export const SCHEMA_CLASSES = Object.freeze(["Person", "Family", "Event", "Place", "Source", "Citation", "Repository", "Media", "Note"]);
const MAX_RELATED = 200;
const CHUNK = 25;
const MAX_PENDING = 100;
const MAX_PENDING_PAGES = 10;

/**
 * Contract for the proposal writers (proposal-store-api, edit-api-changes), which own PROP# and IDEM# writes. pendingFor reads items on GSI1 with
 * GSI1PK = PROPREC#<class>:<handle> and an `proposal` attribute { id, state, proposer: { id }, targets: ["Class:handle"], ops: [{ obj, path }] }.
 */
export const PROPREC_CONTRACT = Object.freeze({
  index: "GSI1", keyAttr: "GSI1PK", keyPrefix: "PROPREC#", attr: "proposal",
  fields: Object.freeze(["id", "state", "proposer.id", "targets[]", "ops[].obj", "ops[].path"]),
});
const OPEN_STATES = new Set(["pending", "needs_changes", "stale"]);
const LIVING_YEARS = 110;

// ---- the switch ---------------------------------------------------------------------------------------------------------
/** True while the HFY_EDITING stack switch is on (the HfyEditing parameter). `env` is read on each call. */
export const editingOn = (env = () => process.env) => env().HFY_EDITING === "on";

/** The gate of every editing route: 404 not_found for everyone, signed out or admin, unless HFY_EDITING is "on". */
export const editingGate = (env = () => process.env) => serverSwitch("HFY_EDITING", async () => editingOn(env));

// ---- GET /api/me: ownRecord and editing ---------------------------------------------------------------------------------
/** `ownRecord` for the session (editing design section 4): { cls: "Person", handle, gramps_id }, or null when the gramps_id maps to 0 or 2+ people. */
export function ownRecordFor(ctx, actor, { log } = {}) {
  return ownRecord(actor, { byGrampsId: (cls, gid) => byGrampsId(ctx, cls, gid) }, { log });
}

/** The additive /api/me fields: buildMe({ extras }) merges these under the core keys. */
export const meEditingExtras = (ctx, { log, env } = {}) => async (actor) => ({ ownRecord: await ownRecordFor(ctx, actor, { log }), editing: editingOn(env) });

// ---- schemas ------------------------------------------------------------------------------------------------------------
const schemaCache = new Map();
function loadSchemaFile(cls) {
  let hit = schemaCache.get(cls);
  if (!hit) {
    const text = readFileSync(new URL(`./schemas/${cls}.schema.json`, import.meta.url), "utf8");
    hit = { schema: JSON.parse(text), sha256: createHash("sha256").update(text).digest("hex") };
    schemaCache.set(cls, hit);
  }
  return hit;
}

/** sha256 over every committed schema file, in class order: the edit bundle's `schemaHash`. The client refetches schemas when it changes. */
let allHash;
export function schemaHash() {
  if (!allHash) {
    const h = createHash("sha256");
    for (const cls of SCHEMA_CLASSES) h.update(`${cls}:${loadSchemaFile(cls).sha256}\n`);
    allHash = h.digest("hex");
  }
  return allHash;
}

/** GET /api/edit/schema/:cls */
export async function schemaGet(c) {
  const cls = c.params.cls;
  if (!SCHEMA_CLASSES.includes(cls)) throw new HttpError(404, "not_found", "no such schema");
  const { schema, sha256 } = loadSchemaFile(cls);
  return json(200, { class: cls, schema, sha256, schemaHash: schemaHash() }, { etag: `"${sha256}"`, "cache-control": "private, no-cache" });
}

// ---- the bundle ---------------------------------------------------------------------------------------------------------
const yearOf = (d) => {
  const y = isObj(d) && Array.isArray(d.dateval) ? d.dateval[2] : 0;
  return Number.isInteger(y) && y > 0 ? y : 0;
};

const displayName = (p) => {
  const n = isObj(p.primary_name) ? p.primary_name : {};
  const surname = arr(n.surname_list).map((s) => (isObj(s) ? s.surname : "")).filter(Boolean).join(" ");
  return [n.first_name, surname].filter((x) => typeof x === "string" && x).join(" ");
};

/** Deliberately bypasses viewRecord (editing.md 7.2): name, gender and a year-only lifespan only, never a day or month. isLiving is a display-only hint. A Person hidden by the mod overlay is still stubbed. */
/** A Person reduced to what a picker needs: name, gender, a year-only lifespan and a living hint (a display hint; the server never decides on it). */
async function personStub(ctx, obj, nowYear) {
  const yearAt = async (idx) => {
    const ref = arr(obj.event_ref_list)[idx];
    if (!Number.isInteger(idx) || idx < 0 || !isObj(ref) || typeof ref.ref !== "string") return 0;
    const ev = await get(ctx, "Event", ref.ref);
    return ev ? yearOf(ev.obj.date) : 0;
  };
  const birth = await yearAt(obj.birth_ref_index);
  const death = await yearAt(obj.death_ref_index);
  const hasDeath = Number.isInteger(obj.death_ref_index) && obj.death_ref_index >= 0;
  const isLiving = !hasDeath && (birth === 0 || birth > nowYear - LIVING_YEARS);
  const lifespan = birth || death ? `${birth || ""}–${hasDeath ? death || "" : ""}` : "";
  return { displayName: displayName(obj), gender: Number.isInteger(obj.gender) ? obj.gender : 2, isLiving, lifespan };
}

/** The read side relationOf wants: get(cls, handle) -> object, byGrampsId, referrers(cls, handle) -> [{cls, handle}]. */
export const relationView = (ctx) => ({
  get: async (cls, handle) => (await get(ctx, cls, handle))?.obj ?? null,
  byGrampsId: (cls, gid) => byGrampsId(ctx, cls, gid),
  referrers: async (cls, handle) => (await backrefs(ctx, `${cls}:${handle}`)).map((k) => ({ cls: k.slice(0, k.indexOf(":")), handle: k.slice(k.indexOf(":") + 1) })),
});

/**
 * True when one of `targets` ("Class:handle") is about the viewer: their own Person, or a Family they are a spouse or child of. `own` is
 * { handle } (the viewer's Person) or null; `related` memoises the Family checks of one request. Fails closed without an own Person.
 */
export async function targetsAboutMe(own, targets, view, related = new Map()) {
  if (!own) return false;
  for (const t of arr(targets)) {
    if (typeof t !== "string") continue;
    if (t === `Person:${own.handle}`) return true;
    if (t.startsWith("Family:")) {
      if (!related.has(t)) related.set(t, (await relationOf(own, t, view)) === "own");
      if (related.get(t)) return true;
    }
  }
  return false;
}

/**
 * The proposals the viewer may see on record `key`, from the per-record index (GSI1 PROPREC#<key>): { proposalId, state, paths }. Own proposals,
 * every proposal for an admin, and proposals whose targets include the viewer's own Person or a Family they are in. Only open states are listed.
 * A read failure propagates (the bundle fails closed with 503 rather than showing a partial list).
 */
export async function pendingFor(ctx, actor, key, own, view) {
  const out = [];
  const related = new Map();
  const aboutMe = (targets) => targetsAboutMe(own, targets, view, related);
  let start;
  for (let page = 0; page < MAX_PENDING_PAGES; page++) {
    const res = await ctx.ddb.send(new ctx.cmds.QueryCommand({
      TableName: ctx.table, IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :pk", ExpressionAttributeValues: { ":pk": `PROPREC#${key}` },
      Limit: 50, ...(start ? { ExclusiveStartKey: start } : {}),
    }));
    for (const it of res.Items ?? []) {
      const p = it.proposal;
      if (!isObj(p) || typeof p.id !== "string" || !OPEN_STATES.has(p.state)) continue;
      const mine = isObj(p.proposer) && p.proposer.id === actor.id;
      if (!(actor.admin === true || mine || (await aboutMe(p.targets)))) continue;
      const paths = [...new Set(arr(p.ops).filter((o) => isObj(o) && o.obj === key && typeof o.path === "string").map((o) => o.path))];
      out.push({ proposalId: p.id, state: p.state, paths });
      if (out.length >= MAX_PENDING) return out;
    }
    if (!res.LastEvaluatedKey) return out;
    start = res.LastEvaluatedKey;
  }
  return out; // page budget spent: a bounded list beats an unbounded read
}

/** `ref` is a gramps_id or h:<handle>. Returns the handle; 404 for none, 409 ambiguous_id for two or more (candidates for admins only; members get no candidates, by design). */
async function resolveRef(ctx, actor, cls, ref) {
  if (ref.startsWith("h:")) {
    const h = ref.slice(2);
    if (!HANDLE_RE.test(h)) throw notFound();
    return h;
  }
  if (!GID_RE.test(ref)) throw notFound();
  const hits = await byGrampsId(ctx, cls, ref);
  if (hits.length === 0) throw notFound();
  if (hits.length > 1) {
    throw new HttpError(409, "ambiguous_id", "more than one record has this id", actor.admin === true ? { candidates: hits.map((x) => x.handle) } : undefined);
  }
  return hits[0].handle;
}

/** Builds the bundle for one record, or null when it is hidden from the viewer. */
export async function buildBundle(ctx, actor, cls, handle, { fieldPolicy = DEFAULT_FIELD_POLICY, now = () => Date.now() } = {}) {
  const head = await get(ctx, cls, handle);
  if (!head) return null;
  const rec = { class: cls, handle, gramps_id: typeof head.obj.gramps_id === "string" ? head.obj.gramps_id : "", version: head.version, obj: head.obj };
  const view = await viewRecord(ctx, actor, rec);
  if (!view) return null;
  const key = `${cls}:${handle}`;
  const ownP = await ownPerson(ctx, actor); // cached per actor: the same lookup viewRecord used
  const own = ownP ? { cls: "Person", handle: ownP.handle, gramps_id: actor.id } : null;
  const rview = relationView(ctx);

  // The objects the record references (one level), each through the same read-side view. Persons become stubs.
  const seen = new Set([key]);
  const refs = [];
  for (const r of collectRefs(head.obj)) {
    const k = `${r.cls}:${r.handle}`;
    if (seen.has(k) || !CLASSES.includes(r.cls) || !HANDLE_RE.test(r.handle)) continue;
    seen.add(k);
    refs.push(r);
    if (refs.length >= MAX_RELATED) break;
  }
  const related = {};
  const nowYear = new Date(now()).getUTCFullYear();
  const load = async (list) => {
    for (let i = 0; i < list.length; i += CHUNK) {
      const part = await Promise.all(list.slice(i, i + CHUNK).map(async (r) => {
        const h = await get(ctx, r.cls, r.handle);
        if (!h) return null;
        if (r.cls === "Person") return [`Person:${r.handle}`, { version: h.version, stub: await personStub(ctx, h.obj, nowYear) }];
        const v = await viewRecord(ctx, actor, { class: r.cls, handle: r.handle, gramps_id: typeof h.obj.gramps_id === "string" ? h.obj.gramps_id : "", version: h.version, obj: h.obj });
        return v ? [`${r.cls}:${r.handle}`, { version: v.version, obj: v.obj }] : null;
      }));
      for (const p of part) if (p) related[p[0]] = p[1];
    }
  };
  await load(refs);

  // One level further, for the editor's pickers (HFY-TSK-156): the places the related events sit in and the sources the related
  // citations cite, through the same read-side view. They are the "places in the bundle" a place picker lists and the sources a citation
  // can name; a place or source the viewer may not see is simply absent. The bundle stays bounded by MAX_RELATED across both levels.
  const second = [];
  for (const [k, v] of Object.entries(related)) {
    if (refs.length + second.length >= MAX_RELATED) break;
    const o = isObj(v.obj) ? v.obj : null;
    if (!o) continue;
    const next = k.startsWith("Event:") && typeof o.place === "string" ? { cls: "Place", handle: o.place } : k.startsWith("Citation:") && typeof o.source_handle === "string" ? { cls: "Source", handle: o.source_handle } : null;
    if (!next || !HANDLE_RE.test(next.handle)) continue;
    const nk = `${next.cls}:${next.handle}`;
    if (seen.has(nk)) continue;
    seen.add(nk);
    second.push(next);
  }
  await load(second);

  return {
    key, version: view.version, etag: `${key}@${view.version}`, obj: view.obj, related,
    relation: (await relationOf(own, key, rview)) === "own" ? "own" : "other",
    viewer: { admin: actor.admin === true },
    policy: fieldPolicy.document(),
    pending: await pendingFor(ctx, actor, key, own, rview),
    customTypes: await customTypes(ctx),
    schemaHash: schemaHash(),
  };
}

/** GET /api/edit/:cls/:ref */
export async function bundleGet(c) {
  const { cls, ref } = c.params;
  if (!SCHEMA_CLASSES.includes(cls)) throw notFound();
  const ctx = c.store;
  const handle = await resolveRef(ctx, c.actor, cls, ref);
  const bundle = await buildBundle(ctx, c.actor, cls, handle, { now: ctx.now });
  if (!bundle) throw notFound();
  // No HTTP ETag: the body differs per viewer (redaction, pending[], relation) without a version bump, so a conditional 304 would be unsafe.
  return json(200, bundle, { "cache-control": "private, no-store", vary: "Cookie" });
}
