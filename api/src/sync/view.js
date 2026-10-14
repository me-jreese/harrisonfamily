// The store view the server validator reads (HFY-TSK-245): the heads, the id guard, the referrers of an object and the destructive budget,
// with a per-call cache so one batch reads each thing once.
//
//   get(cls, handle)            -> {class, handle, gramps_id, version, deleted, obj, ...} | null   (a tombstone has deleted: true, obj: null)
//   item(cls, handle)           -> the raw head item (carries `reason`: a withdrawn head has reason "private") | undefined
//   gid(cls, grampsId)          -> the GID#<Class>#<id> item | undefined
//   referrers(cls, handle)      -> [{class, handle, obj}] live stored objects that reference an Event (Person, Family: event_ref_list)
//                                  or a Citation (Event: citation_list; Person, Family: an EventRef's citation_list). Other classes: [].
//   destructiveRolling()        -> delete and withdraw ops committed in the last 24 hours
//
// Every read is a consistent GetItem except `referrers`, which pages the GSI1 partition RECS#<Class> (eventually consistent) once per
// class per call. It stands in for the backrefs of the store-view fold (records-accessors, BRD2 7.4): that task replaces it behind
// the same method, and applyBatch accepts the replacement as ctx.storeView(store) -> view. The validator asks for referrers only when
// a birth-like decision needs them (an Event or Citation with a non-year date), never for the other writes.
import { BUDGET_BUCKETS, budgetBucket, budgetKey, getGid, getRecordItem, parseHead } from "./store.js";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const REFERRING = Object.freeze({ Event: ["Person", "Family"], Citation: ["Event", "Person", "Family"] });
const MAX_PAGES = 400;

const refersToEvent = (obj, handle) => arr(obj.event_ref_list).some((r) => isObj(r) && r.ref === handle);
const refersToCitation = (cls, obj, handle) =>
  cls === "Event" ? arr(obj.citation_list).includes(handle) : arr(obj.event_ref_list).some((r) => isObj(r) && arr(r.citation_list).includes(handle));

/**
 * `store` is {ddb, cmds, table}. `prefetched` is a Map of "Class#handle" -> head item (undefined when absent) that the caller has
 * already read in this call: they seed the cache and are never read again. `now` is the clock (ms).
 */
export function createStoreView(store, { now = Date.now, prefetched } = {}) {
  const items = new Map();
  for (const [k, v] of prefetched ?? []) items.set(k, Promise.resolve(v));
  const parsed = new Map();
  const gids = new Map();
  const scans = new Map();

  const item = (cls, handle) => {
    const k = `${cls}#${handle}`;
    if (!items.has(k)) items.set(k, getRecordItem(store, cls, handle));
    return items.get(k);
  };
  const get = async (cls, handle) => {
    const it = await item(cls, handle);
    if (!it) return null;
    const k = `${cls}#${handle}`;
    if (!parsed.has(k)) parsed.set(k, parseHead(it));
    return parsed.get(k);
  };
  const gid = (cls, grampsId) => {
    const k = `${cls}#${grampsId}`;
    if (!gids.has(k)) gids.set(k, getGid(store, cls, grampsId));
    return gids.get(k);
  };

  const scan = (cls) => {
    if (!scans.has(cls)) {
      scans.set(cls, (async () => {
        const out = [];
        let startKey;
        for (let page = 0; page < MAX_PAGES; page += 1) {
          const r = await store.ddb.send(new store.cmds.QueryCommand({
            TableName: store.table,
            IndexName: "GSI1",
            KeyConditionExpression: "GSI1PK = :pk",
            ExpressionAttributeValues: { ":pk": `RECS#${cls}` },
            ...(startKey ? { ExclusiveStartKey: startKey } : {}),
          }));
          for (const it of r.Items ?? []) {
            if (it.deleted === true || typeof it.obj_json !== "string") continue;
            out.push({ class: cls, handle: it.handle, obj: JSON.parse(it.obj_json) });
          }
          startKey = r.LastEvaluatedKey;
          if (!startKey) return out;
        }
        throw new Error("the record index is larger than the validator reads");
      })());
    }
    return scans.get(cls);
  };
  const referrers = async (cls, handle) => {
    const out = [];
    for (const from of REFERRING[cls] ?? []) {
      for (const r of await scan(from)) {
        if (cls === "Event" ? refersToEvent(r.obj, handle) : refersToCitation(from, r.obj, handle)) out.push(r);
      }
    }
    return out;
  };

  let rolling;
  const destructiveRolling = () => {
    rolling ??= (async () => {
      const t = now();
      const buckets = Array.from({ length: BUDGET_BUCKETS }, (_, i) => budgetBucket(t - i * 3_600_000));
      const rows = await Promise.all(buckets.map(async (b) => (await store.ddb.send(new store.cmds.GetCommand({ TableName: store.table, Key: budgetKey(b), ConsistentRead: true }))).Item));
      return rows.reduce((n, row) => n + (Number.isInteger(row?.count) ? row.count : 0), 0);
    })();
    return rolling;
  };

  return { now, get, item, gid, referrers, destructiveRolling };
}

/**
 * The store as it will stand once the batch commits: the batch's own creates and updates, nothing for the objects it deletes or
 * withdraws, and the store's live head for everything else. `ops` are the wire ops; `store` is a view above.
 *   written    Map "Class#handle" -> {obj, op}        removed  Set of "Class#handle"        withdrawn  the withdraw ops' keys
 *   after(cls, handle)       -> the object after the batch, or null
 *   overridden(cls, handle)  -> true when the batch writes or removes it (its stored version no longer counts)
 */
export function createOverlay(ops, store) {
  const written = new Map();
  const removed = new Set();
  const withdrawn = new Set();
  for (const op of ops) {
    if (op.op === "create" || op.op === "update") written.set(`${op.class}#${op.handle}`, { obj: op.obj, op });
    else if (op.op === "delete" || op.op === "withdraw") {
      removed.add(`${op.class}#${op.handle}`);
      if (op.op === "withdraw") withdrawn.add(`${op.class}#${op.handle}`);
    }
  }
  const overridden = (cls, handle) => written.has(`${cls}#${handle}`) || removed.has(`${cls}#${handle}`);
  const after = async (cls, handle) => {
    if (typeof handle !== "string" || handle === "") return null;
    const k = `${cls}#${handle}`;
    if (written.has(k)) return written.get(k).obj;
    if (removed.has(k)) return null;
    const head = await store.get(cls, handle);
    return head && !head.deleted && isObj(head.obj) ? head.obj : null;
  };
  return { written, removed, withdrawn, after, overridden };
}
