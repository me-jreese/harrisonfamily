// HFY-TSK-172 (sync-routes; sync.md 7.2): the /api/sync/* route definitions that sit on the sync-bearer middleware (auth.js, guard.js).
// HFY-TSK-172 shipped the handshake surface, GET /api/sync/meta and POST /api/sync/bind. HFY-TSK-173 (sync-push-routes) adds the push routes
// (push.js, media.js): sessions, complete, abort, batches and media/presign. HFY-TSK-174 (sync-pull-routes) adds the pull routes (pull.js): snapshot,
// media download, status, conflicts and conflict decisions. The change feed (GET /sync/changes, ARCH-B) is phase B (changes-feed).
//
// Every entry is `auth: "sync-bearer"` and gated by the SYNC_API_ENABLED switch (404 not_enabled when off). The handler (handler.js)
// authenticates the bearer, runs syncContext() and hands the route `c.sync`: { head, terms, store, checkTree, requireStepUp, stepUp }.
import { randomUUID } from "node:crypto";
import { HttpError } from "../http.js";
import { TxnCancelled, auditItem, transact } from "../txn.js";
import { LIMITS, API_VERSION, syncGate } from "./guard.js";
import { BLOCK_PREFIX } from "./validator.js";
import { headKey } from "./store.js";
import { batchesPush, sessionsAbort, sessionsComplete, sessionsOpen } from "./push.js";
import { syncMediaPresign } from "./media.js";
import { syncAdminStatus } from "./admin.js";
import { syncConflictDecision, syncConflictsList, syncMediaDownload, syncSnapshot, syncStatus } from "./pull.js";

const ok = (body, status = 200) => ({ status, body });
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** The id block the cloud mints from, per class: Person "I8000-I8999" (sync.md 7.2; the validator refuses desktop ids in it). */
export const ID_BLOCK = Object.freeze(Object.fromEntries(Object.entries(BLOCK_PREFIX).map(([cls, p]) => [cls, `${p}8000-${p}8999`])));

const DBID = /^[A-Za-z0-9._-]{1,128}$/;
const FINGERPRINT = /^[A-Za-z0-9._:-]{8,256}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const MAX_RETIRED_PAGES = 200;

/**
 * The retired Person ids (BRD2 4.2, SI-02): every Person head that is a tombstone (deleted, withdrawn or merged away), read from the
 * RECS#Person index. A retired id is never reused (409 gramps_id_retired at the server), so this list only lets the add-on hold a reuse
 * before it sends (D44). The index is eventually consistent and the server stays the authority, so a lag costs one 409, not a reuse.
 * Renumbers are blocked in this release (renumber_blocked); when they ship, the list must also read the retired GID# items.
 */
const retiredCaches = new WeakMap();
/** Cached per table and head seq: the list only changes when a batch commits, which moves seq. Bounded to a few tables. */
export async function retiredPersonIds(store, seq) {
  let retiredCache = retiredCaches.get(store.ddb);
  if (!retiredCache) retiredCaches.set(store.ddb, (retiredCache = new Map()));
  const ck = Number.isInteger(seq) ? `${store.table}#${seq}` : null;
  const hit = ck ? retiredCache.get(ck) : undefined;
  if (hit) return [...hit];
  const out = await readRetiredPersonIds(store);
  if (ck) {
    if (retiredCache.size >= 8) retiredCache.delete(retiredCache.keys().next().value);
    retiredCache.set(ck, out);
  }
  return [...out];
}
async function readRetiredPersonIds({ ddb, cmds, table }) {
  const ids = new Set();
  let key;
  for (let page = 0; page < MAX_RETIRED_PAGES; page += 1) {
    const r = await ddb.send(new cmds.QueryCommand({
      TableName: table, IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :pk",
      FilterExpression: "#d = :t", ExpressionAttributeNames: { "#d": "deleted" }, ExpressionAttributeValues: { ":pk": "RECS#Person", ":t": true },
      ...(key ? { ExclusiveStartKey: key } : {}),
    }));
    for (const it of r.Items ?? []) if (it.deleted === true && typeof it.gramps_id === "string" && it.gramps_id !== "") ids.add(it.gramps_id);
    key = r.LastEvaluatedKey;
    if (!key) return [...ids].sort();
  }
  throw new HttpError(503, "retryable", "the retired id list is too large to read in one call");
}

async function renderedSeq({ ddb, cmds, table }) {
  const r = await ddb.send(new cmds.GetCommand({ TableName: table, Key: { PK: "SYNC#RENDER", SK: "STATE" }, ConsistentRead: true }));
  return Number.isInteger(r.Item?.rendered_seq) ? r.Item.rendered_seq : 0;
}

/** GET /api/sync/meta: the handshake document (sync.md 7.2). */
export async function syncMeta(c) {
  const { head, terms, store } = c.sync;
  const [rendered, retired] = await Promise.all([renderedSeq(store), retiredPersonIds(store, head?.seq)]);
  return ok({
    api_version: API_VERSION,
    min_client: terms.min_client,
    accepted: terms.accepted,
    redaction_version: terms.redaction_version,
    tree_id: head?.tree_id ?? null,
    bound: head?.bound ? { dbid: head.bound.dbid, fingerprint: head.bound.fingerprint } : null,
    head_seq: Number.isInteger(head?.seq) ? head.seq : 0,
    rendered_seq: rendered,
    writes_enabled: c.sync.writesEnabled,
    seeded: head?.seeded === true,
    merges_enabled: head?.merges_enabled === true,
    limits: { ...LIMITS },
    id_block: { ...ID_BLOCK },
    retired_person_ids: retired,
  });
}

function bindBody(body) {
  const bad = (field) => new HttpError(400, "validation", `${field} is invalid`, { fields: [{ field, code: "invalid" }] });
  if (!isObj(body)) throw bad("body");
  if (typeof body.dbid !== "string" || !DBID.test(body.dbid)) throw bad("dbid");
  if (typeof body.fingerprint !== "string" || !FINGERPRINT.test(body.fingerprint)) throw bad("fingerprint");
  if (typeof body.tree_name_sha256 !== "string" || !SHA256_HEX.test(body.tree_name_sha256)) throw bad("tree_name_sha256");
  if (body.rebind !== undefined && typeof body.rebind !== "boolean") throw bad("rebind");
  return { dbid: body.dbid, fingerprint: body.fingerprint, tree_name_sha256: body.tree_name_sha256, rebind: body.rebind === true };
}

/**
 * POST /api/sync/bind: bind the desktop tree to the cloud store. The first bind needs the owner bearer only. Any later bind is a rebind
 * (`rebind: true`) and needs a fresh step-up (403 step_up_required); a bind with no `rebind`, or one naming the tree already bound, is
 * 409 already_bound. The tree_id is minted once and kept across rebinds. The write is conditional on the head's `bound_at`, so two
 * racing binds cannot both win (the loser is 409 already_bound), and it is audited in the same transaction.
 */
export async function syncBind(c) {
  const b = bindBody(c.body);
  const { head, store } = c.sync;
  const prior = head?.bound;
  if (prior && (!b.rebind || (prior.dbid === b.dbid && prior.fingerprint === b.fingerprint))) {
    throw new HttpError(409, "already_bound", "this cloud store is already bound to a tree");
  }
  if (prior) c.sync.requireStepUp("rebind");
  const at = new Date(store.now()).toISOString();
  const treeId = head?.tree_id ?? (store.uuid ?? randomUUID)();
  const bound = { dbid: b.dbid, fingerprint: b.fingerprint, tree_name_sha256: b.tree_name_sha256, bound_at: at, by: c.actor.id };
  const guard = prior
    ? { condition: "#ba = :prev", names: { "#ba": "bound_at" }, values: { ":prev": prior.bound_at } }
    : { condition: "attribute_not_exists(PK) OR attribute_not_exists(#ba)", names: { "#ba": "bound_at" }, values: {} };
  try {
    await transact(store.ddb, store.cmds, store.table, {
      updates: [{
        key: headKey(), update: "SET #t = :t, #b = :b, #ba = :at, #u = :at", tag: "sync:bind",
        condition: guard.condition,
        names: { ...guard.names, "#t": "tree_id", "#b": "bound", "#u": "updated_at" },
        values: { ...guard.values, ":t": treeId, ":b": bound, ":at": at },
      }],
      puts: [{ item: { ...auditItem({ op: "sync.bind", id: "sync:bind", principalId: c.actor.id, at, before: prior ? { bound_at: prior.bound_at } : null, after: { tree_id: treeId, bound_at: at, rebind: Boolean(prior) } }, store.uid(), store.table), origin: "desktop" } }],
    });
  } catch (e) {
    if (e instanceof TxnCancelled && e.conditionFailed) throw new HttpError(409, "already_bound", "this cloud store is already bound to a tree");
    if (e instanceof TxnCancelled) throw new HttpError(503, "retryable", "try again");
    throw e;
  }
  return ok({ tree_id: treeId });
}

const SYNC_ROUTE_BASE = { auth: "sync-bearer", gate: syncGate() };
export const SYNC_ROUTES = [
  { ...SYNC_ROUTE_BASE, name: "sync.meta", method: "GET", path: "/sync/meta", summary: "The sync handshake: versions, limits, the bound tree, head and rendered seq, the retired Person ids and merges_enabled (sync bearer, gramps-owner; no MCP tool)", handler: syncMeta },
  { ...SYNC_ROUTE_BASE, name: "sync.bind", method: "POST", path: "/sync/bind", summary: "Bind the desktop tree {dbid, fingerprint, tree_name_sha256}; a rebind ({rebind:true}) needs step-up (sync bearer, gramps-owner; no MCP tool)", handler: syncBind },
  // HFY-TSK-173: the push routes. All write routes: a paused store (writes_enabled false) answers 503 sync_paused before they run.
  { ...SYNC_ROUTE_BASE, name: "sync.sessions.open", method: "POST", path: "/sync/sessions", summary: "Open a multi-batch push session {expected?: [\"Class#handle\"]}: 201 {session_id, expires_at, seed}; 409 session_open while another is open; the first session while the store is unseeded is the silent seed (sync bearer, gramps-owner; no MCP tool)", handler: sessionsOpen },
  { ...SYNC_ROUTE_BASE, name: "sync.sessions.complete", method: "POST", path: "/sync/sessions/:id/complete", summary: "Close a push session: verifies references and person-family symmetry for the whole session (422 integrity_violation), appends a marker log entry, 200 {seq}; idempotent (sync bearer, gramps-owner; no MCP tool)", handler: sessionsComplete },
  { ...SYNC_ROUTE_BASE, name: "sync.sessions.abort", method: "POST", path: "/sync/sessions/:id/abort", summary: "Abort a push session, audited: 200 {session_id, state: aborted}; what it already pushed stays (sync bearer, gramps-owner; no MCP tool)", handler: sessionsAbort },
  { ...SYNC_ROUTE_BASE, name: "sync.batches", method: "POST", path: "/sync/batches", summary: "Push a batch of up to 24 ops {tree_id?, session_id?, client_run_id?, ops} with an Idempotency-Key header, through applyBatch with origin desktop (seed inside the seed session): 200 {batch_id, seq_from, seq_to, results}; a replay has Idempotent-Replayed: true (sync bearer, gramps-owner; no MCP tool)", handler: batchesPush },
  { ...SYNC_ROUTE_BASE, name: "sync.media.presign", method: "POST", path: "/sync/media/presign", summary: "Presigned PUT for a blob {handle, content_type, size, sha256_b64, md5_hex}, staged at media/.staging/<handle>/<sha256> and finalized after the Media op commits (sync bearer, gramps-owner; no MCP tool)", handler: syncMediaPresign },
  // HFY-TSK-174: the pull routes. routes.js derives write from the method (every non-GET), so the three POST routes set pausedOk to keep working while the store is paused (writes_enabled false): the blob download writes nothing, the heartbeat writes one SYNC#CLIENT item, and the conflict decision writes only the conflict item and an audit item, never the record log or heads. That is a deliberate choice: pausing guards the record store, not the conflict queue.
  { ...SYNC_ROUTE_BASE, name: "sync.snapshot", method: "GET", path: "/sync/snapshot", summary: "ARCH-C pull: {seq, url (presigned GET, 300 s), body_sha256, count, generated_at} for a gzip JSONL of every head, built at the current head and cached per seq (sync bearer, gramps-owner; no MCP tool)", handler: syncSnapshot },
  { ...SYNC_ROUTE_BASE, name: "sync.media.download", method: "POST", path: "/sync/media/:handle/download", pausedOk: true, summary: "Blob download: {url (presigned GET, 300 s), sha256, md5, size, content_type}; 404 no_blob when the Media head holds no present blob (sync bearer, gramps-owner; no MCP tool)", handler: syncMediaDownload },
  { ...SYNC_ROUTE_BASE, name: "sync.status", method: "POST", path: "/sync/status", pausedOk: true, summary: "The desktop's heartbeat after each run {client_instance_id, dbid, fingerprint, addon_version, gramps_version, schema, last_run}: 204 (sync bearer, gramps-owner; no MCP tool)", handler: syncStatus },
  { ...SYNC_ROUTE_BASE, name: "sync.conflicts.list", method: "GET", path: "/sync/conflicts", summary: "The conflict queue ?state=open|resolved|dismissed&limit&cursor: {state, conflicts, next_cursor} (sync bearer, gramps-owner; no MCP tool)", handler: syncConflictsList },
  { ...SYNC_ROUTE_BASE, name: "sync.conflicts.decision", method: "POST", path: "/sync/conflicts/:id/decision", pausedOk: true, cookieOwner: true, summary: "Record a decision {decision: keep_cloud|keep_desktop|manual}: gramps-owner plus step-up (auth_time within 300 s; an hfy-admin cookie alone is refused); stores {cloud_version, cloud_value_hash}; 409 already_resolved (sync bearer; no MCP tool)", handler: syncConflictDecision },
  // HFY-TSK-279 (sync-admin-status-page): the cookie side of /admin/sync/. Session auth (no bearer): hfy-admin or gramps-owner reads it; the decision route above also takes the gramps-owner's session plus step-up.
  { name: "sync.admin.status", method: "GET", path: "/sync/admin/status", gate: syncGate(), summary: "The admin sync page's read {desktop, website, conflicts, batches} (session cookie; hfy-admin or gramps-owner, else 403 not_allowed; no MCP tool)", handler: syncAdminStatus },
];
