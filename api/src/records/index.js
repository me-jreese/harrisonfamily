// Record accessors and the store view (HFY-TSK-244, BRD2 section 7.4 and editing.md 5.1). Read-only; every write goes through applyBatch().
//
//   get(ctx, cls, handle)        -> { obj, version } | null     a consistent GetItem of the head; a tombstone is null
//   byGrampsId(ctx, cls, gid)    -> [{ handle, version }]        GSI1 RECS#<cls>, tombstoned heads excluded (a gramps_id is not unique)
//   backrefs(ctx, key)           -> ["Class:handle", ...]        every live object that references `key`, from the store view
//   graph(ctx)                   -> { families, parents }        cached up to GRAPH_TTL_MS, used for cycle checks
//   customTypes(ctx)             -> { EventType: [str], ... }    the tree's custom type strings
//
// The store view holds every head in memory. Cold start = the latest snapshot (ctx.snapshot, optional) plus a fold of SYNC#LOG since
// its seq; warm = a consistent GetItem of SYNC#HEAD, then a fold of the log since the cached seq. GSI reads are never used for the
// view. `ctx` is the applyBatch store context: { ddb, cmds, table, now? }.
import { HttpError } from "../http.js";
import { collectRefs } from "./semantics.js";
import { CLASSES, getRecord, getSyncHead, logKey, seqKey } from "../sync/store.js";

export const GRAPH_TTL_MS = 60_000;
const LOG_PAGE = 100;

const keyOf = (cls, handle) => `${cls}:${handle}`;
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const clock = (ctx) => (typeof ctx.now === "function" ? ctx.now() : Date.now());

// ---- accessors that read the table directly ---------------------------------------------------------------------------
/** The live head of one object as { obj, version }, or null when it does not exist or is a tombstone. */
export async function get(ctx, cls, handle) {
  const rec = await getRecord(ctx, cls, handle);
  return rec && !rec.deleted && rec.obj ? { obj: rec.obj, version: rec.version } : null;
}

/** Every live object of `cls` whose gramps_id is `gid`: [{ handle, version }], by handle. Tombstones are excluded. */
export async function byGrampsId(ctx, cls, gid) {
  if (!CLASSES.includes(cls)) throw new HttpError(422, "unknown_class", `unknown class ${String(cls).slice(0, 32)}`);
  if (typeof gid !== "string" || !gid) return [];
  const prefix = `${gid}#`; // GSI1SK = <gramps_id>#<handle>
  const out = [];
  let start;
  for (;;) {
    const res = await ctx.ddb.send(new ctx.cmds.QueryCommand({
      TableName: ctx.table,
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk AND GSI1SK >= :after",
      ExpressionAttributeValues: { ":pk": `RECS#${cls}`, ":after": prefix },
      Limit: 25,
      ...(start ? { ExclusiveStartKey: start } : {}),
    }));
    for (const item of res.Items ?? []) {
      if (!item.GSI1SK.startsWith(prefix)) return finish(out); // sorted: past the prefix, so done
      // GSI1 must project ALL (deleted, handle, version, gramps_id). Match the exact id: "I1" must not take "I1#x".
      const stored = item.gramps_id ?? item.GSI1SK.slice(0, item.GSI1SK.lastIndexOf("#"));
      if (stored !== gid) continue;
      if (item.deleted !== true) out.push({ handle: item.handle, version: item.version });
    }
    if (!res.LastEvaluatedKey) return finish(out);
    start = res.LastEvaluatedKey;
  }
}
const finish = (out) => out.sort((a, b) => (a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0));

// ---- the store view ---------------------------------------------------------------------------------------------------
/** A view over every head. Entries: key -> { class, handle, gramps_id, version, seq, deleted, obj }. */
export class StoreView {
  constructor() {
    this.seq = 0;
    this.heads = new Map();
    this.refs = new Map(); // target key -> Set of live source keys
    this.graphCache = null; // { at, value }
    this.typesCache = null; // { seq, value }
    this.snapTried = false; // the snapshot is offered once per view
    this.epoch = undefined; // SYNC#HEAD.expunge_epoch this view was built under (undefined until first read)
  }

  /** Sets (or tombstones) one head, keeping the reverse reference index in step. */
  put(entry) {
    const key = keyOf(entry.class, entry.handle);
    const old = this.heads.get(key);
    // A stale entry (a slower, overlapping fold of an earlier log page) never overwrites a newer head.
    if (old && Number.isFinite(entry.seq) && Number.isFinite(old.seq) && entry.seq <= old.seq) return;
    if (old && !old.deleted && old.obj) for (const r of collectRefs(old.obj)) this.refs.get(keyOf(r.cls, r.handle))?.delete(key);
    const live = entry.deleted !== true && entry.obj != null && entry.expunged !== true;
    this.heads.set(key, {
      class: entry.class, handle: entry.handle, gramps_id: entry.gramps_id ?? old?.gramps_id ?? "", version: entry.version, seq: entry.seq, deleted: !live, obj: live ? entry.obj : null,
      ...(entry.expunged === true ? { expunged: true } : {}),
    });
    if (live) {
      for (const r of collectRefs(entry.obj)) {
        const t = keyOf(r.cls, r.handle);
        if (!this.refs.has(t)) this.refs.set(t, new Set());
        this.refs.get(t).add(key);
      }
    }
  }

  /** Folds one SYNC#LOG item. A marker only advances the seq. */
  foldLog(item) {
    if (item.op === "create" || item.op === "update" || item.op === "delete" || item.op === "withdraw") {
      const live = (item.op === "create" || item.op === "update") && item.obj_json != null && item.expunged !== true;
      this.put({ class: item.class, handle: item.handle, gramps_id: item.gramps_id || undefined, version: item.version, seq: item.seq, deleted: !live, obj: live ? JSON.parse(item.obj_json) : null, ...(item.expunged === true ? { expunged: true } : {}) });
    }
    this.seq = Math.max(this.seq, item.seq);
  }

  /** Loads a snapshot { seq, heads: [{class, handle, version, seq, deleted, obj, expunged?, gramps_id?}] }. */
  load(snapshot) {
    for (const h of snapshot.heads) this.put(h);
    this.seq = snapshot.seq;
  }

  live() {
    return [...this.heads.values()].filter((h) => !h.deleted);
  }
}

async function foldSince(ctx, view, headSeq) {
  let start;
  while (view.seq < headSeq) {
    const res = await ctx.ddb.send(new ctx.cmds.QueryCommand({
      TableName: ctx.table,
      KeyConditionExpression: "PK = :pk AND SK > :sk",
      ExpressionAttributeValues: { ":pk": logKey(1).PK, ":sk": seqKey(view.seq) },
      ConsistentRead: true,
      Limit: LOG_PAGE,
      ...(start ? { ExclusiveStartKey: start } : {}),
    }));
    const items = res.Items ?? [];
    for (const item of items) view.foldLog(item);
    if (!res.LastEvaluatedKey) {
      if (items.length === 0) break; // nothing newer is visible: stop rather than spin
      start = undefined;
      continue;
    }
    start = res.LastEvaluatedKey;
  }
}

const views = new WeakMap(); // ddb client -> Map(table -> StoreView)
/**
 * The cached view of this table. `epoch` is SYNC#HEAD.expunge_epoch as the caller just read it (absent = 0): an expunge rewrites log entries and
 * heads in place without moving seq, so a view built under another epoch could still hold the removed value in memory, and is dropped (privacy-expunge).
 */
function viewFor(ctx, epoch) {
  let byTable = views.get(ctx.ddb);
  if (!byTable) views.set(ctx.ddb, (byTable = new Map()));
  let v = byTable.get(ctx.table);
  if (v && epoch !== undefined && v.epoch !== undefined && v.epoch !== epoch) v = undefined;
  if (!v) byTable.set(ctx.table, (v = new StoreView()));
  if (epoch !== undefined) v.epoch = epoch;
  return v;
}
const epochOf = (head) => (Number.isInteger(head?.expunge_epoch) ? head.expunge_epoch : 0);

/** Drops the cached view of this context's table (tests; also the recovery path after a restore). */
export function resetStoreView(ctx) {
  views.get(ctx.ddb)?.delete(ctx.table);
}

/** Builds a fresh view from the snapshot (if the context offers one) and the whole log, without touching the cache. */
export async function rebuildStoreView(ctx) {
  const view = new StoreView();
  const snap = typeof ctx.snapshot === "function" ? await ctx.snapshot() : null;
  if (snap) view.load(snap);
  await foldSince(ctx, view, (await getSyncHead(ctx))?.seq ?? 0);
  return view;
}

/** The cached view brought up to SYNC#HEAD.seq (one consistent GetItem when nothing changed). */
export async function storeView(ctx) {
  const head = await getSyncHead(ctx);
  const view = viewFor(ctx, epochOf(head));
  const headSeq = head?.seq ?? 0;
  if (!view.snapTried && view.seq === 0 && view.heads.size === 0 && typeof ctx.snapshot === "function") {
    view.snapTried = true;
    const snap = await ctx.snapshot();
    if (snap && snap.seq <= headSeq) view.load(snap);
  }
  if (view.seq < headSeq) await foldSince(ctx, view, headSeq);
  return view;
}

/** Every live object that references `key` ("Class:handle"), sorted. */
export async function backrefs(ctx, key) {
  const view = await storeView(ctx);
  return [...(view.refs.get(key) ?? [])].filter((k) => view.heads.get(k)?.deleted === false).sort();
}

function buildGraph(view) {
  const families = {};
  const parents = {};
  for (const h of view.live()) {
    if (h.class !== "Family") continue;
    const children = (h.obj.child_ref_list ?? []).map((r) => r?.ref).filter((x) => typeof x === "string" && x);
    families[h.handle] = { father: h.obj.father_handle || null, mother: h.obj.mother_handle || null, children };
    for (const c of children) (parents[c] ??= []).push(h.handle);
  }
  for (const c of Object.keys(parents)) parents[c].sort();
  return { families, parents };
}

const deepFreeze = (v) => {
  if (v && typeof v === "object" && !Object.isFrozen(v)) { Object.freeze(v); Object.values(v).forEach(deepFreeze); }
  return v;
};

/** Drops the cached graph (a same-process writer calls this after its applyBatch commit). */
export function invalidateGraph(ctx) {
  const v = views.get(ctx.ddb)?.get(ctx.table);
  if (v) v.graphCache = null;
}

/** { families: {h: {father, mother, children[]}}, parents: {personH: [familyH]} }, cached up to 60 s. The result is deep-frozen (read-only). */
export async function graph(ctx) {
  const view = viewFor(ctx);
  const now = clock(ctx);
  // A clock that went backwards (now < at) counts as expired.
  if (view.graphCache && now >= view.graphCache.at && now - view.graphCache.at < GRAPH_TTL_MS) return view.graphCache.value;
  const fresh = await storeView(ctx);
  fresh.graphCache = { at: now, value: deepFreeze(buildGraph(fresh)) };
  return fresh.graphCache.value;
}

/** The custom type strings in use: a Gramps type object { _class: "<X>Type", value: 0, string } is Custom when value is 0 (every Gramps type class puts Custom at 0; non-custom values are skipped). */
export async function customTypes(ctx) {
  const view = await storeView(ctx);
  if (view.typesCache && view.typesCache.seq === view.seq) return view.typesCache.value;
  const found = {};
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (isPlain(v)) {
      if (typeof v._class === "string" && v._class.endsWith("Type") && v.value === 0 && typeof v.string === "string" && v.string) (found[v._class] ??= new Set()).add(v.string);
      for (const k of Object.keys(v)) walk(v[k]);
    }
  };
  for (const h of view.live()) walk(h.obj);
  const value = {};
  for (const k of Object.keys(found).sort()) value[k] = [...found[k]].sort();
  view.typesCache = { seq: view.seq, value };
  return value;
}
