// The read-only records API (HFY-TSK-175, records-read-api; BRD2 D2-34, review PS-07, PS-08, SI-17).
//
//   GET /api/records/:class/:handle            -> { class, handle, gramps_id, version, obj }   ETag: "v<version>"
//   GET /api/records/Person/by-id/:gramps_id   -> the same, found by gramps_id
//
// The stored object is already redacted (sync.md section 5). Before it reaches a member it passes two more views:
//   publishView(obj, viewer)             Q2-04b: day and month (and text) of every date are reduced to the year, as the site publishes them
//                                        (HFY-R76), unless the viewer is an admin, the object is the viewer's own Person, or it is one of
//                                        the viewer's own-only events. Birth dates are reduced too (redaction already stores them as a year).
//   applyModOverlay(obj, viewer, mods)   D2-19: the note, MediaRef and Media items hidden by an open `MOD#` record are removed, unless the
//                                        viewer is an admin or the owner (the member whose own Person holds the item, or who raised it: author_id).
// The edit bundle and MCP hfy_records_get use the same two functions, so a member sees the same thing on every read path.
//
// No write, no MCP tool. The routes sit behind the HFY_EDITING stack switch (recordsGate): off, only admins and a member reading their own
// record reach them; everyone else gets 404 not_found.
import { HttpError, json } from "../http.js";
import { serverSwitch } from "../features.js";
import { CLASSES } from "../sync/store.js";
import { backrefs, byGrampsId, get } from "./index.js";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const notFound = () => new HttpError(404, "not_found", "no such record");
const HANDLE_RE = /^[A-Za-z0-9_-]{1,64}$/;
const GID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const PRIMARY_ROLE = 1; // Gramps EventRoleType.PRIMARY
const MAX_MOD_TARGETS = 1000;
const MOD_CHUNK = 25;

// ---- publishView (Q2-04b) -----------------------------------------------------------------------------------------------
const yearOf = (d) => {
  const y = Array.isArray(d.dateval) ? d.dateval[2] : 0;
  if (Number.isInteger(y) && y > 0) return y;
  const m = typeof d.text === "string" ? /(?<!\d)(\d{4})(?!\d)/.exec(d.text) : null;
  return m ? Number(m[1]) : 0;
};
const isDate = (v) => isObj(v) && (v._class === "Date" || (Array.isArray(v.dateval) && "modifier" in v));

/** True when a Date carries anything finer than a year: a day or month in dateval, a sortval, or text other than the bare year. */
function finerThanYear(d) {
  const dv = arr(d.dateval);
  if ([0, 1, 4, 5].some((i) => Number.isInteger(dv[i]) && dv[i] !== 0)) return true;
  if (typeof d.text === "string" && d.text !== "" && d.text !== String(yearOf(d))) return true;
  return Number.isInteger(d.sortval) && d.sortval !== 0;
}

function reduceDate(d) {
  if (!finerThanYear(d)) return d;
  const year = yearOf(d);
  const dv = Array.isArray(d.dateval) ? d.dateval.map((x, i) => (i === 0 || i === 1 || i === 4 || i === 5 ? 0 : x)) : d.dateval;
  return { ...d, dateval: dv, text: year > 0 ? String(year) : "", sortval: 0 };
}

function mapDates(v) {
  if (Array.isArray(v)) return v.map(mapDates);
  if (!isObj(v)) return v;
  if (isDate(v)) return reduceDate(v);
  const out = {};
  for (const k of Object.keys(v)) out[k] = mapDates(v[k]);
  return out;
}

/** Whether `obj` holds any date finer than a year (the route reads the reference index for an Event only when this is true). */
export function hasFineDate(obj) {
  if (Array.isArray(obj)) return obj.some(hasFineDate);
  if (!isObj(obj)) return false;
  if (isDate(obj)) return finerThanYear(obj);
  return Object.values(obj).some(hasFineDate);
}

/**
 * Q2-04b: a copy of `obj` for `viewer` ({id, admin, ownHandle?, ownOnlyEvents?: Set<handle>}). Non-admins see every date at year precision,
 * except on their own Person and on their own-only events (the route fills ownOnlyEvents). A stored object is never mutated.
 */
export function publishView(obj, viewer) {
  if (!isObj(obj) || viewer?.admin === true) return obj;
  if (obj._class === "Person" && viewer?.ownHandle && obj.handle === viewer.ownHandle) return obj;
  if (obj._class === "Event" && viewer?.ownOnlyEvents?.has(obj.handle)) return obj;
  return mapDates(obj);
}

// ---- applyModOverlay (D2-19, D2-34) -------------------------------------------------------------------------------------
/** The MOD# targets this object can reference: note:<h>, media:<h> and mediaref:<holder handle>:<media handle> (BRD2 section 4). */
export function collectModTargets(obj) {
  const out = new Set();
  const holder = isObj(obj) ? obj.handle : undefined;
  const walk = (v) => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!isObj(v)) return;
    for (const [k, x] of Object.entries(v)) {
      if (k === "note_list" && Array.isArray(x)) {
        for (const h of x) if (typeof h === "string" && h) out.add(`note:${h}`);
      } else if (k === "media_list" && Array.isArray(x)) {
        for (const r of x) if (isObj(r) && typeof r.ref === "string" && r.ref) { out.add(`media:${r.ref}`); if (holder) out.add(`mediaref:${holder}:${r.ref}`); }
      }
      walk(x);
    }
  };
  walk(obj);
  return [...out];
}

/** Reads the open, hidden MOD# items for `targets`: Map target -> { author_id }. A read failure propagates (fail closed). */
export async function loadMods(ctx, targets) {
  const want = [...new Set(targets)];
  if (want.length > MAX_MOD_TARGETS) throw new HttpError(503, "unavailable", "too many moderated references to resolve");
  const mods = new Map();
  for (let i = 0; i < want.length; i += MOD_CHUNK) {
    const items = await Promise.all(want.slice(i, i + MOD_CHUNK).map((t) =>
      ctx.ddb.send(new ctx.cmds.GetCommand({ TableName: ctx.table, Key: { PK: `MOD#${t}`, SK: "META" }, ConsistentRead: true })).then((r) => [t, r.Item])));
    for (const [t, it] of items) if (it && it.hidden === true && it.open !== false) mods.set(t, { author_id: typeof it.author_id === "string" ? it.author_id : undefined });
  }
  return mods;
}

/**
 * A hidden item is visible to admins and to its owner (BRD2 D2-19, R2-25: "the page owner when they are a member"). The owner is the member
 * whose own Person holds the item (viewer.ownTargets, filled by viewRecord), and also the member who raised the MOD# item (author_id).
 */
const mayView = (mod, viewer, target) =>
  viewer?.admin === true || (typeof viewer?.id === "string" && mod.author_id === viewer.id) || viewer?.ownTargets?.has(target) === true;
const hiddenFor = (mods, target, viewer) => { const m = mods.get(target); return m !== undefined && !mayView(m, viewer, target); };

/** True when the record itself (a Note or Media) is hidden from `viewer`: the route answers 404. */
export function recordHidden(cls, handle, viewer, mods) {
  if (cls === "Note") return hiddenFor(mods, `note:${handle}`, viewer);
  if (cls === "Media") return hiddenFor(mods, `media:${handle}`, viewer);
  return false;
}

/**
 * D2-19: `obj` without the notes, MediaRefs and Media that `mods` (loadMods) hides from `viewer`. Admins and the owner of a hidden item keep it.
 * The MediaRef target is `mediaref:<handle of the object holding the list>:<media handle>`. Returns a copy; the input is not mutated.
 */
export function applyModOverlay(obj, viewer, mods) {
  if (!isObj(obj) || !(mods instanceof Map) || mods.size === 0 || viewer?.admin === true) return obj;
  const holder = obj.handle;
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (!isObj(v)) return v;
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === "note_list" && Array.isArray(x)) out[k] = x.filter((h) => !(typeof h === "string" && hiddenFor(mods, `note:${h}`, viewer)));
      else if (k === "media_list" && Array.isArray(x)) {
        out[k] = x.filter((r) => !(isObj(r) && typeof r.ref === "string" && (hiddenFor(mods, `media:${r.ref}`, viewer) || hiddenFor(mods, `mediaref:${holder}:${r.ref}`, viewer)))).map(walk);
      } else out[k] = walk(x);
    }
    return out;
  };
  return walk(obj);
}

// ---- the viewer and the whole view ---------------------------------------------------------------------------------------
/** The viewer's own Person as { handle, obj } when exactly one live Person has the viewer's gramps_id (the session sub), else null. */
const ownCache = new WeakMap(); // actor object -> Promise: the gate and the handler of one request share one lookup
export function ownPerson(ctx, actor) {
  if (!actor?.id) return Promise.resolve(null);
  let p = ownCache.get(actor);
  if (!p) { p = lookupOwnPerson(ctx, actor); ownCache.set(actor, p); p.catch(() => ownCache.delete(actor)); }
  return p;
}
async function lookupOwnPerson(ctx, actor) {
  const hits = await byGrampsId(ctx, "Person", actor.id);
  if (hits.length !== 1) return null;
  const rec = await get(ctx, "Person", hits[0].handle);
  return rec ? { handle: hits[0].handle, obj: rec.obj } : null;
}

/** Whether Event `handle` is referenced only by the viewer's own Person, as Primary (editing.md section 4: an own-only event). */
export async function isOwnOnlyEvent(ctx, own, handle) {
  // An explicit Primary role is required: a missing role is not Primary (a privacy exception stays strict).
  const hasPrimary = arr(own.obj.event_ref_list).some((r) => isObj(r) && r.ref === handle && r.role?.value === PRIMARY_ROLE);
  if (!hasPrimary) return false;
  const refs = await backrefs(ctx, `Event:${handle}`);
  return refs.length === 1 && refs[0] === `Person:${own.handle}`;
}

const ownTargetsOf = (own) => new Set([
  ...arr(own.obj.note_list).filter((h) => typeof h === "string").map((h) => `note:${h}`),
  ...arr(own.obj.media_list).filter((r) => isObj(r) && typeof r.ref === "string").map((r) => `media:${r.ref}`),
]);

/**
 * What a signed-in member (or admin) sees of one stored record, or null when it is hidden from them (the route answers 404).
 * `rec` is { class, handle, gramps_id, version, obj }. This is the single read-side view: the records API, the edit bundle and
 * hfy_records_get call it.
 */
export async function viewRecord(ctx, actor, rec) {
  const viewer = { id: actor.id, admin: actor.admin === true };
  if (!viewer.admin) {
    const own = await ownPerson(ctx, actor);
    if (own) {
      viewer.ownHandle = own.handle;
      // Ownership of a hidden item holds on the owner's own Person, and on a Note or Media the own Person holds; never on someone else's page.
      if (rec.class === "Person" && rec.handle === own.handle) viewer.ownTargets = new Set([
        ...arr(own.obj.note_list).filter((h) => typeof h === "string").map((h) => `note:${h}`),
        ...arr(own.obj.media_list).filter((r) => isObj(r) && typeof r.ref === "string").flatMap((r) => [`media:${r.ref}`, `mediaref:${own.handle}:${r.ref}`]),
      ]);
      else if (rec.class === "Note" || rec.class === "Media") viewer.ownTargets = new Set([`${rec.class === "Note" ? "note" : "media"}:${rec.handle}`].filter((t) => ownTargetsOf(own).has(t)));
    }
    if (own && rec.class === "Event" && hasFineDate(rec.obj) && (await isOwnOnlyEvent(ctx, own, rec.handle))) viewer.ownOnlyEvents = new Set([rec.handle]);
  }
  const mods = await loadMods(ctx, [...collectModTargets(rec.obj), ...(rec.class === "Note" ? [`note:${rec.handle}`] : []), ...(rec.class === "Media" ? [`media:${rec.handle}`] : [])]);
  if (recordHidden(rec.class, rec.handle, viewer, mods)) return null;
  const obj = publishView(applyModOverlay(rec.obj, viewer, mods), viewer);
  return { class: rec.class, handle: rec.handle, gramps_id: rec.gramps_id, version: rec.version, obj };
}

// ---- the routes ----------------------------------------------------------------------------------------------------------
const store = (c) => c.store;
const reply = (view) => json(200, view, { etag: `"v${view.version}"`, vary: "Cookie" });

async function readOne(ctx, actor, cls, handle) {
  if (!CLASSES.includes(cls) || !HANDLE_RE.test(handle)) throw notFound();
  const head = await get(ctx, cls, handle);
  if (!head) throw notFound(); // unknown or tombstone
  const gramps_id = typeof head.obj.gramps_id === "string" ? head.obj.gramps_id : "";
  const view = await viewRecord(ctx, actor, { class: cls, handle, gramps_id, version: head.version, obj: head.obj });
  if (!view) throw notFound();
  return reply(view);
}

/** GET /api/records/:class/:handle */
export const recordGet = async (c) => readOne(store(c), c.actor, c.params.class, c.params.handle);

/** GET /api/records/Person/by-id/:gramps_id: a gramps_id is not unique in Gramps, so two live holders answer 409 ambiguous_gramps_id. */
export async function recordByGrampsId(c) {
  const gid = c.params.gramps_id;
  if (!GID_RE.test(gid)) throw notFound();
  const ctx = store(c);
  const hits = await byGrampsId(ctx, "Person", gid);
  if (hits.length === 0) throw notFound();
  if (hits.length > 1 && c.actor?.admin !== true) throw notFound(); // no duplicate oracle for members
  if (hits.length > 1) throw new HttpError(409, "ambiguous_gramps_id", "more than one person has this id");
  return readOne(ctx, c.actor, "Person", hits[0].handle);
}

/**
 * The HFY_EDITING stack switch for the records routes (api-feature-gate; BRD2 D2-13). `env` is read on each call. While the switch is off an
 * admin passes, and so does a member reading their own record (the moderation view of a hidden item): their own Person, an own-only Event (Primary, referenced by no one else) or a Note or
 * Media that their own Person references. A shared Event is not their own record. Everyone else, a signed-out caller included, gets 404 not_found.
 */
export const recordsGate = (env = () => process.env) => serverSwitch("HFY_EDITING", async ({ actor, params, ctx }) => {
  if (env().HFY_EDITING === "on") return true;
  if (!actor) return false;
  if (actor.admin === true) return true;
  if (!params || !ctx) return false;
  if (typeof params.gramps_id === "string") return params.gramps_id === actor.id; // Person/by-id/<own id>
  try {
    const own = await ownPerson(ctx, actor);
    if (!own) return false;
    const { class: cls, handle } = params;
    if (cls === "Person") return handle === own.handle;
    if (cls === "Event") return await isOwnOnlyEvent(ctx, own, handle); // own-only events, not shared ones
    const key = { Note: "note_list", Media: "media_list" }[cls];
    return key !== undefined && arr(own.obj[key]).some((r) => (isObj(r) ? r.ref : r) === handle);
  } catch (e) {
    console.error("records gate: own-record lookup failed, answering 404 (fail closed):", e?.message ?? e);
    return false; // fail closed
  }
});
