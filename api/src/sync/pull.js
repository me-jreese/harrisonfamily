// HFY-TSK-174 (sync-pull-routes; sync.md 7.2, 4.2, BRD2 11.1 7.1/7.2, review SI-30, PS-22): the pull side of /api/sync/*.
//
//   GET  /api/sync/snapshot                     ARCH-C pull: a gzip JSONL of every head at the current seq, in the sync bucket, behind a 300 s presigned GET
//   POST /api/sync/media/:handle/download       a presigned GET of a Media blob, with the checksums the desktop verifies after the download
//   POST /api/sync/status                       the desktop's heartbeat after each run (SYNC#CLIENT#<instance>), 204
//   GET  /api/sync/conflicts?state=open         the conflict queue (SYNC#CONFLICT#<ulid>, read through GSI1 SYNCCONFLICT#<state>)
//   POST /api/sync/conflicts/:id/decision       gramps-owner plus step-up (auth_time <= 300 s): an hfy-admin cookie alone never reaches a sync route
//   POST /api/sync/conflicts/reconcile          HFY-TSK-338 (SI-30): on a pull, the resolved decisions that still apply, and the ones reopened because the cloud moved
//   POST /api/sync/conflicts/:id/applied        HFY-TSK-338: the add-on says it applied (or found moot) a decision, so it is not offered again
//
// The snapshot file: line 1 is the header {"type":"header","tree_id","seq","schema","redaction","count","body_sha256"}; every further line is one
// head {"class","handle","gramps_id","version","seq","deleted","obj"} (a tombstone has deleted:true and obj:null; an expunged one also has expunged:true), in class then handle order, each line
// canonical JSON ending in "\n". body_sha256 is the SHA-256 (hex) of the uncompressed BODY: every byte after the header line's "\n". The gzip header
// carries no mtime, so the same heads always give the same bytes. The object is cached per seq at snapshots/<seq>.jsonl.gz; its S3 metadata holds
// body_sha256, count and generated_at, so a cache hit costs one HeadObject. The heads come from the store view (records/index.js): the stored objects
// are already redacted, and nothing is read from a GSI.
//
// Cache validity: a hit needs the metadata to match the CURRENT tree_id, REDACTION_VERSION, SCHEMA_VERSION and SYNC#HEAD.expunge_epoch (absent = 0).
// DEPENDENCY on privacy-expunge (BRD2 11.1, SI-18, S19): an expunge rewrites log entries and heads and may not advance seq, so it MUST increment
// SYNC#HEAD.expunge_epoch in the same transaction; the next snapshot call then misses the cache and rebuilds without the old value. Old cached
// objects at the same seq are overwritten by the rebuild. Memory: the view, the joined body and the gzip are all held in memory (fine for the
// current tree size; stream the build if the Lambda memory limit ever becomes the constraint).
//
// Conflict queue reads: sync.md 7.2 also lists an hfy-admin cookie as able to read the queue. Here the queue is served on the sync bearer only;
// the cookie-readable list belongs to the phase B admin page task (sync-admin-status-page, RG-7). The decision needs owner plus step-up (PS-22).
import { gzipSync } from "node:zlib";
import { PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { HttpError, logSafeError } from "../http.js";
import { canonicalJson } from "../shared/canonical.mjs";
import { HANDLE_SHAPE } from "../records/ops.js";
import { storeView } from "../records/index.js";
import { TxnCancelled, auditItem, transact } from "../txn.js";
import { requireConflictDecision } from "./auth.js";
import { CLASSES, REDACTION_VERSION, SCHEMA_VERSION, getRecordItem, recKey, sha256 } from "./store.js";

const ok = (body, status = 200) => ({ status, body });
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const bad = (field, message) => new HttpError(400, "validation", message ?? `${field} is invalid`, { fields: [{ field, code: "invalid" }] });
const retryable = () => new HttpError(503, "retryable", "the store is busy; retry");

export const SNAPSHOT_PREFIX = "snapshots/";
export const SNAPSHOT_URL_SECONDS = 300;
export const DOWNLOAD_URL_SECONDS = 300;
export const snapshotKey = (seq) => `${SNAPSHOT_PREFIX}${seq}.jsonl.gz`;
export const LATEST_KEY = `${SNAPSHOT_PREFIX}latest.json`;

const classRank = new Map(CLASSES.map((c, i) => [c, i]));
const byHead = (a, b) => (classRank.get(a.class) ?? 99) - (classRank.get(b.class) ?? 99) || (a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0);

/**
 * The snapshot file for the heads of a store view: { gz (Buffer), body_sha256, count }. Pure and deterministic: the same heads and tree id give the
 * same bytes. Exported for the tests, which verify a downloaded file the way the add-on does.
 */
export function buildSnapshot({ treeId, seq, heads }) {
  const sorted = [...heads].sort(byHead);
  // An expunged head (privacy-expunge) is a tombstone that says so: `expunged: true` is present only then, so the bytes of every other snapshot are unchanged.
  const body = sorted.map((h) => `${canonicalJson({ class: h.class, handle: h.handle, gramps_id: h.gramps_id ?? "", version: h.version, seq: h.seq, deleted: h.deleted === true, ...(h.expunged === true ? { expunged: true } : {}), obj: h.deleted === true ? null : h.obj })}\n`).join("");
  const bodySha = sha256(body);
  const header = `${canonicalJson({ type: "header", tree_id: treeId ?? null, seq, schema: SCHEMA_VERSION, redaction: REDACTION_VERSION, count: sorted.length, body_sha256: bodySha })}\n`;
  return { gz: gzipSync(Buffer.from(header + body, "utf8"), { level: 9 }), body_sha256: bodySha, count: sorted.length };
}

const s3Status = (e) => e?.$metadata?.httpStatusCode;
const isMissing = (e) => e?.name === "NotFound" || e?.name === "NoSuchKey" || s3Status(e) === 404 || s3Status(e) === 403; // no s3:ListBucket: a missing key answers 403

/**
 * Builds the snapshot of `heads` at `seq` and writes it to snapshots/<seq>.jsonl.gz, with the metadata the cache check reads, then the
 * latest.json checkpoint (best effort). Returns { body_sha256, count, generated_at }. Used by the route and by api/scripts/expunge.mjs, which
 * rebuilds the snapshot after it deleted every copy. `store` = { s3, syncBucket, now, log? }; `head` is the SYNC#HEAD item (tree_id, expunge_epoch).
 */
export async function writeSnapshot(store, { seq, head, heads }) {
  const key = snapshotKey(seq);
  const epoch = String(Number.isInteger(head?.expunge_epoch) ? head.expunge_epoch : 0);
  const built = buildSnapshot({ treeId: head?.tree_id, seq, heads });
  const generatedAt = new Date(store.now()).toISOString();
  await store.s3.send(new PutObjectCommand({
    Bucket: store.syncBucket, Key: key, Body: built.gz, ContentType: "application/gzip", CacheControl: "private, no-store",
    Metadata: { body_sha256: built.body_sha256, count: String(built.count), generated_at: generatedAt, tree_id: head?.tree_id ?? "", expunge_epoch: epoch, redaction: String(REDACTION_VERSION), schema: String(SCHEMA_VERSION) },
  }));
  // The checkpoint the store views start from; a failure here costs nothing but a longer cold start. Concurrent builds at different seqs can
  // regress latest.json to an older seq; that is accepted, since a view replays the log from the checkpoint seq and so stays correct.
  await store.s3.send(new PutObjectCommand({
    Bucket: store.syncBucket, Key: LATEST_KEY, Body: JSON.stringify({ seq, key, body_sha256: built.body_sha256, count: built.count, generated_at: generatedAt }), ContentType: "application/json", CacheControl: "private, no-store",
  })).catch((e) => store.log?.warn?.("snapshot checkpoint not written", logSafeError(e, { route: "sync.snapshot" })));
  return { body_sha256: built.body_sha256, count: built.count, generated_at: generatedAt };
}

/** GET /api/sync/snapshot. */
export async function syncSnapshot(c) {
  c.sync.checkTree();
  const { store, head } = c.sync;
  if (!store.s3 || typeof store.presignGet !== "function" || !store.syncBucket) throw new HttpError(503, "unavailable", "snapshots are not configured");
  const headSeq = Number.isInteger(head?.seq) ? head.seq : 0;
  let view;
  try {
    view = await storeView(store);
  } catch (e) {
    store.log?.error?.("snapshot view failed", logSafeError(e, { route: "sync.snapshot" }));
    throw retryable();
  }
  if (view.seq < headSeq) throw retryable(); // the log is not visible up to the head yet
  const seq = view.seq; // no await between here and the heads below: the view cannot move under the file
  const key = snapshotKey(seq);
  const heads = [...view.heads.values()];

  const epoch = String(Number.isInteger(head?.expunge_epoch) ? head.expunge_epoch : 0);
  let meta;
  try {
    const r = await store.s3.send(new HeadObjectCommand({ Bucket: store.syncBucket, Key: key }));
    const m = r?.Metadata ?? {};
    if (/^[0-9a-f]{64}$/.test(m.body_sha256 ?? "") && Number.isInteger(Number(m.count)) && typeof m.generated_at === "string" && m.tree_id === (head?.tree_id ?? "")
      && m.expunge_epoch === epoch && m.redaction === String(REDACTION_VERSION) && m.schema === String(SCHEMA_VERSION)) {
      meta = { body_sha256: m.body_sha256, count: Number(m.count), generated_at: m.generated_at };
    }
  } catch (e) {
    if (!isMissing(e)) {
      store.log?.error?.("snapshot head failed", logSafeError(e, { route: "sync.snapshot" }));
      throw retryable();
    }
  }
  if (!meta) {
    try {
      meta = await writeSnapshot(store, { seq, head, heads });
    } catch (e) {
      store.log?.error?.("snapshot write failed", logSafeError(e, { route: "sync.snapshot" }));
      throw retryable();
    }
  }
  let url;
  try {
    url = await store.presignGet({ bucket: store.syncBucket, key, expiresIn: SNAPSHOT_URL_SECONDS });
  } catch (e) {
    store.log?.error?.("snapshot presign failed", logSafeError(e, { route: "sync.snapshot" }));
    throw retryable();
  }
  return ok({ seq, url, body_sha256: meta.body_sha256, count: meta.count, generated_at: meta.generated_at });
}

/** POST /api/sync/media/:handle/download: 404 no_blob unless the Media head is live with a present blob. */
export async function syncMediaDownload(c) {
  c.sync.checkTree();
  const { store } = c.sync;
  const handle = c.params.handle;
  if (typeof handle !== "string" || !HANDLE_SHAPE.test(handle)) throw new HttpError(404, "no_blob", "no blob for this media");
  if (typeof store.presignGet !== "function") throw new HttpError(503, "unavailable", "blob downloads are not configured");
  const item = await getRecordItem(store, "Media", handle);
  const blob = item && item.deleted !== true ? item.blob : undefined;
  if (!isObj(blob) || blob.state !== "present" || typeof blob.s3_key !== "string" || !/^media\/[0-9a-f]{19,28}\.[a-z0-9]{2,4}$/.test(blob.s3_key)) {
    throw new HttpError(404, "no_blob", "no blob for this media");
  }
  let url;
  try {
    url = await store.presignGet({ bucket: store.mediaBucket, key: blob.s3_key, expiresIn: DOWNLOAD_URL_SECONDS, contentType: blob.content_type });
  } catch (e) {
    store.log?.error?.("media presign failed", logSafeError(e, { route: "sync.media.download" }));
    throw retryable();
  }
  return ok({ url, sha256: blob.sha256, md5: blob.md5, size: blob.size, content_type: blob.content_type, expires_in: DOWNLOAD_URL_SECONDS });
}

// ---- status heartbeat -------------------------------------------------------------------------------------------------
const INSTANCE = /^[A-Za-z0-9._-]{8,64}$/;
const TOKEN = /^[A-Za-z0-9._:/+-]{1,64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const COUNT_KEYS = 24;

export const clientKey = (instance) => ({ PK: `SYNC#CLIENT#${instance}`, SK: "META" });

function statusBody(body) {
  if (!isObj(body)) throw bad("body");
  const str = (field, re) => {
    const v = body[field];
    if (typeof v !== "string" || !re.test(v)) throw bad(field);
    return v;
  };
  const run = body.last_run;
  if (!isObj(run)) throw bad("last_run");
  const counts = {};
  if (run.counts !== undefined) {
    if (!isObj(run.counts) || Object.keys(run.counts).length > COUNT_KEYS) throw bad("last_run.counts");
    for (const [k, v] of Object.entries(run.counts)) {
      if (!/^[a-z_]{1,32}$/.test(k) || !Number.isInteger(v) || v < 0 || v > 1e9) throw bad("last_run.counts");
      counts[k] = v;
    }
  }
  if (run.exit_code !== undefined && !(Number.isInteger(run.exit_code) && run.exit_code >= 0 && run.exit_code <= 255)) throw bad("last_run.exit_code");
  for (const f of ["run_id", "action", "result"]) if (typeof run[f] !== "string" || !TOKEN.test(run[f])) throw bad(`last_run.${f}`);
  if (typeof run.finished_at !== "string" || !ISO.test(run.finished_at)) throw bad("last_run.finished_at");
  if (body.schema !== undefined && !Number.isInteger(body.schema)) throw bad("schema");
  return {
    client_instance_id: str("client_instance_id", INSTANCE),
    dbid: str("dbid", /^[A-Za-z0-9._-]{1,128}$/),
    fingerprint: str("fingerprint", /^[A-Za-z0-9._:-]{8,256}$/),
    addon_version: str("addon_version", TOKEN),
    gramps_version: str("gramps_version", TOKEN),
    schema: body.schema ?? null,
    last_run: { run_id: run.run_id, action: run.action, result: run.result, exit_code: run.exit_code ?? null, counts, finished_at: run.finished_at },
  };
}

/**
 * POST /api/sync/status: one SYNC#CLIENT#<instance> item, replaced on each run. 204. The route is not a write route (no pause refusal: a paused
 * store still wants the heartbeat). An existing item written by a different principal is never overwritten (409). Items are one per desktop
 * instance and callers are gramps-owner only, so no TTL is set; the admin status page (RG-7) lists and can prune them.
 */
export async function syncStatus(c) {
  c.sync.checkTree();
  const { store } = c.sync;
  const b = statusBody(c.body);
  const { client_instance_id: instance, ...rest } = b;
  const at = new Date(store.now()).toISOString();
  await store.ddb.send(new store.cmds.PutCommand({
    TableName: store.table,
    Item: { ...clientKey(instance), GSI1PK: "SYNCCLIENT", GSI1SK: `${at}#${instance}`, entity: "syncclient", client_instance_id: instance, ...rest, principal: c.actor.id, updated_at: at },
    ConditionExpression: "attribute_not_exists(PK) OR principal = :p", ExpressionAttributeValues: { ":p": c.actor.id },
  })).catch((e) => {
    if (e?.name === "ConditionalCheckFailedException") throw new HttpError(409, "conflict", "this client instance belongs to another principal");
    throw e;
  });
  return { status: 204, body: undefined };
}

// ---- conflicts --------------------------------------------------------------------------------------------------------
export const CONFLICT_STATES = Object.freeze(["open", "resolved", "dismissed"]);
export const CONFLICT_DECISIONS = Object.freeze(["keep_cloud", "keep_desktop", "manual"]);
export const conflictKey = (id) => ({ PK: `SYNC#CONFLICT#${id}`, SK: "META" });
const CONFLICT_ID = /^[A-Za-z0-9]{26}$/;
const CONFLICT_PK = /^SYNC#CONFLICT#[A-Za-z0-9]{26}$/;
const MAX_PAGE = 100;

/** The wire shape of a conflict item. */
export const conflictView = (it) => ({
  id: it.PK.slice("SYNC#CONFLICT#".length), class: it.class, handle: it.handle, gramps_id: it.gramps_id ?? "", kind: it.kind, source: it.source,
  paths: Array.isArray(it.paths) ? it.paths : [], state: it.state, decision: it.decision ?? null, opened_at: it.opened_at, resolved_at: it.resolved_at ?? null, by: it.by ?? null,
  cloud_version: it.cloud_version ?? null, cloud_value_hash: it.cloud_value_hash ?? null,
  // HFY-TSK-338: a decision the cloud value outgrew reopens the conflict and keeps the old decision here; `applied_at` is the add-on's receipt.
  reopened_at: it.reopened_at ?? null, history: Array.isArray(it.history) ? it.history : [], applied_at: it.applied_at ?? null,
});

// The cursor is built from the last item (not from LastEvaluatedKey), and the index key is rebuilt from the state, so a forged cursor can name
// no partition but the queried one.
const encodeCursor = (it) => Buffer.from(JSON.stringify({ PK: it.PK, SK: it.SK, GSI1SK: it.GSI1SK }), "utf8").toString("base64url");
function decodeCursor(raw, state) {
  const bad400 = () => new HttpError(400, "bad_cursor", "the cursor is not valid");
  let k;
  try { k = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")); } catch { throw bad400(); }
  if (!isObj(k) || typeof k.PK !== "string" || !CONFLICT_PK.test(k.PK) || k.SK !== "META" || typeof k.GSI1SK !== "string" || k.GSI1SK.length > 128) throw bad400();
  return { PK: k.PK, SK: "META", GSI1PK: `SYNCCONFLICT#${state}`, GSI1SK: k.GSI1SK };
}

/** GET /api/sync/conflicts?state=open&limit=<1..100>&cursor=: oldest first. */
export async function syncConflictsList(c) {
  c.sync.checkTree();
  const { store } = c.sync;
  const q = c.query ?? {};
  const state = q.state === undefined || q.state === "" ? "open" : q.state;
  if (!CONFLICT_STATES.includes(state)) throw bad("state");
  const limit = q.limit === undefined || q.limit === "" ? 50 : Number(q.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) throw bad("limit");
  const start = q.cursor ? decodeCursor(String(q.cursor), state) : undefined;
  const r = await store.ddb.send(new store.cmds.QueryCommand({
    TableName: store.table, IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :pk", ExpressionAttributeValues: { ":pk": `SYNCCONFLICT#${state}` },
    Limit: limit, ...(start ? { ExclusiveStartKey: start } : {}),
  }));
  const items = (r.Items ?? []).filter((it) => typeof it.PK === "string" && it.PK.startsWith("SYNC#CONFLICT#"));
  return ok({ state, conflicts: items.map(conflictView), next_cursor: r.LastEvaluatedKey && items.length ? encodeCursor(items.at(-1)) : null });
}

/** The hash a decision is tied to: the cloud values at the conflict's paths, as the queue showed them (SI-30). */
export const cloudValueHash = (paths) => sha256(canonicalJson((Array.isArray(paths) ? paths : []).map((p) => ({ path: String(p?.path ?? ""), cloud: p?.cloud === undefined ? null : p.cloud }))));

/**
 * Why a stored decision no longer applies (SI-30), or null while it does. A decision applies only while the cloud head is the version it was made
 * against AND the cloud values at the conflict's paths hash the same as the hash stored with it. `paths` are the conflict's paths with the CURRENT
 * cloud values. The reasons: `not_resolved` (nothing to apply), `no_hash` (a decision stored without a usable hash: nothing proves what it was made
 * against), `version_changed` (the record has moved) and `value_changed` (the same version, other cloud values: an in-place scrub, or a decision made
 * against values the head no longer holds).
 */
export function decisionStaleReason(conflict, { version, paths }) {
  if (conflict?.state !== "resolved") return "not_resolved";
  if (typeof conflict.cloud_value_hash !== "string" || !/^[0-9a-f]{64}$/.test(conflict.cloud_value_hash)) return "no_hash";
  if ((conflict.cloud_version ?? null) !== (Number.isInteger(version) ? version : null)) return "version_changed";
  if (conflict.cloud_value_hash !== cloudValueHash(paths)) return "value_changed";
  return null;
}
export const decisionStillApplies = (conflict, current) => decisionStaleReason(conflict, current) === null;

/**
 * The value at an RFC 6901 pointer of a stored (redacted) cloud object: `{value}` (absent members read null, as the queue shows them) or null when
 * the pointer cannot be followed here (a keyed-list token such as `ref#0`, or a derived view key), in which case the caller keeps the value it has.
 */
export function cloudValueAt(obj, path) {
  if (typeof path !== "string" || (path !== "" && !path.startsWith("/"))) return null;
  let node = obj;
  for (const raw of path === "" ? [] : path.slice(1).split("/")) {
    const tok = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(node)) {
      if (!/^(0|[1-9]\d*)$/.test(tok)) return null;
      node = node[Number(tok)];
    } else if (isObj(node)) {
      if (tok === "_birth_ref" || tok === "_death_ref") return null;
      node = Object.hasOwn(node, tok) ? node[tok] : undefined;
    } else node = undefined;
    if (node === undefined) return { value: null };
  }
  return { value: node === undefined ? null : node };
}

/**
 * The conflict's paths with the CURRENT cloud values: the head's own value at the pointer wherever the pointer resolves (the add-on's word never
 * overrides what the store holds), else the add-on's `observed` value for a path the server cannot follow (a keyed-list token, a derived view key),
 * else the stored one.
 */
function currentPaths(item, head, observed) {
  return (Array.isArray(item.paths) ? item.paths : []).map((p) => {
    if (head === undefined || head === null || head.deleted === true || head.obj_json == null) {
      const seen = observed.get(observedKey(item.class, item.handle, p?.path));
      return { path: p?.path, cloud: seen !== undefined ? seen : null };
    }
    const at = cloudValueAt(JSON.parse(head.obj_json), p?.path);
    if (at) return { path: p.path, cloud: at.value };
    const seen = observed.get(observedKey(item.class, item.handle, p?.path));
    return seen !== undefined ? { path: p.path, cloud: seen } : p;
  });
}
/** True when the head holds, at every path of a keep_desktop conflict, the desktop value the admin chose: the push already carried it. A path the server cannot follow proves nothing. */
function headHoldsDesktop(item, head) {
  const paths = Array.isArray(item.paths) ? item.paths : [];
  if (!paths.length || head === undefined || head === null || head.deleted === true || head.obj_json == null) return false;
  const obj = JSON.parse(head.obj_json);
  return paths.every((p) => {
    const at = cloudValueAt(obj, p?.path);
    return at !== null && canonicalJson(at.value) === canonicalJson(p.desktop === undefined ? null : p.desktop);
  });
}
const observedKey = (cls, handle, path) => `${cls}\u0000${handle}\u0000${path}`;

/**
 * POST /api/sync/conflicts/:id/decision {decision}. gramps-owner plus step-up within 300 s (PS-22), checked before the item is read, so a stale
 * sign-in learns nothing about the queue. Stores {decision, cloud_version, cloud_value_hash}: the version of the cloud head when the decision was
 * made and the hash of the cloud values the admin decided against; the add-on applies the decision only while both still match, else it reopens
 * the conflict. 404 for an unknown id, 409 already_resolved for a conflict that is not open (a racing second decision loses on the condition).
 */
export async function syncConflictDecision(c) {
  requireConflictDecision(c.actor, c.sync.store.now());
  c.sync.checkTree();
  const { store } = c.sync;
  const id = c.params.id;
  if (typeof id !== "string" || !CONFLICT_ID.test(id)) throw new HttpError(404, "not_found", "no such conflict");
  if (!isObj(c.body) || typeof c.body.decision !== "string" || !CONFLICT_DECISIONS.includes(c.body.decision)) throw bad("decision", `decision must be one of ${CONFLICT_DECISIONS.join(", ")}`);
  const decision = c.body.decision;
  const key = conflictKey(id);
  const item = (await store.ddb.send(new store.cmds.GetCommand({ TableName: store.table, Key: key, ConsistentRead: true }))).Item;
  if (!item) throw new HttpError(404, "not_found", "no such conflict");
  if (item.state !== "open") throw new HttpError(409, "already_resolved", "this conflict is already resolved");
  const rec = CLASSES.includes(item.class) && typeof item.handle === "string" ? await getRecordItem(store, item.class, item.handle) : undefined;
  const cloudVersion = Number.isInteger(rec?.version) ? rec.version : null;
  const hash = cloudValueHash(item.paths);
  const at = new Date(store.now()).toISOString();
  try {
    await transact(store.ddb, store.cmds, store.table, {
      // The check fails the decision (retryable) when the cloud head moved after it was read, so cloud_version always names the head decided against.
      checks: [{
        key: recKey(item.class, item.handle), tag: "conflict:head",
        ...(cloudVersion === null ? { condition: "attribute_not_exists(PK)" } : { condition: "#v = :v", names: { "#v": "version" }, values: { ":v": cloudVersion } }),
      }],
      updates: [{
        key, tag: "conflict:decide", condition: "#s = :open",
        update: "SET #s = :resolved, #d = :d, #cv = :cv, #ch = :ch, #ra = :at, #by = :by, #g = :gpk",
        names: { "#s": "state", "#d": "decision", "#cv": "cloud_version", "#ch": "cloud_value_hash", "#ra": "resolved_at", "#by": "by", "#g": "GSI1PK" },
        values: { ":open": "open", ":resolved": "resolved", ":d": decision, ":cv": cloudVersion, ":ch": hash, ":at": at, ":by": c.actor.id, ":gpk": "SYNCCONFLICT#resolved" },
      }],
      puts: [{ item: { ...auditItem({ op: "sync.conflict.decide", id: `conflict:${id}`, principalId: c.actor.id, at, before: { state: "open" }, after: { state: "resolved", decision, cloud_version: cloudVersion } }, store.uid(), store.table), origin: "desktop" } }],
    }, store.txnOpts);
  } catch (e) {
    if (e instanceof TxnCancelled && e.conditionFailed) {
      const again = (await store.ddb.send(new store.cmds.GetCommand({ TableName: store.table, Key: key, ConsistentRead: true }))).Item;
      if (again?.state === "open") throw retryable(); // the cloud head moved, not a racing decision
      throw new HttpError(409, "already_resolved", "this conflict is already resolved");
    }
    if (e instanceof TxnCancelled) throw retryable();
    throw e;
  }
  return ok(conflictView({ ...item, state: "resolved", decision, cloud_version: cloudVersion, cloud_value_hash: hash, resolved_at: at, by: c.actor.id }));
}

// ---- reconcile on a pull (HFY-TSK-338, SI-30) -----------------------------------------------------------------------------
export const RECONCILE_PAGE = 100;
export const RECONCILE_PAGES = 5;
export const RECONCILE_ITEMS = 50;
export const OBSERVED_MAX = 500;
export const APPLIED_OUTCOMES = Object.freeze(["applied", "moot"]);
const APPLICABLE = Object.freeze(["keep_cloud", "keep_desktop"]);

/**
 * The resolved decisions nobody has applied yet, newest first (the applied ones pile up at the old end). One call looks at no more than
 * RECONCILE_ITEMS pending decisions and RECONCILE_PAGES pages; `next` is then a cursor (the last item looked at) the caller sends back as `after`
 * to go on from there, and null when the queue is done. So a long backlog of applied items never hides an older pending decision: it takes more calls.
 */
async function pendingDecisions(store, after) {
  const out = [];
  let start = after ? decodeCursor(after, "resolved") : undefined;
  let next = null;
  for (let page = 0; page < RECONCILE_PAGES; page += 1) {
    const r = await store.ddb.send(new store.cmds.QueryCommand({
      TableName: store.table, IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :pk", ExpressionAttributeValues: { ":pk": "SYNCCONFLICT#resolved" },
      ScanIndexForward: false, Limit: RECONCILE_PAGE, ...(start ? { ExclusiveStartKey: start } : {}),
    }));
    const items = r.Items ?? [];
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i];
      if (typeof it.PK === "string" && CONFLICT_PK.test(it.PK) && it.state === "resolved" && !it.applied_at && APPLICABLE.includes(it.decision)) out.push(it);
      if (out.length >= RECONCILE_ITEMS && (i < items.length - 1 || r.LastEvaluatedKey)) return { items: out, next: encodeCursor(it) };
    }
    if (!r.LastEvaluatedKey || !items.length) return { items: out, next: null };
    start = r.LastEvaluatedKey;
    next = encodeCursor(items.at(-1));
  }
  return { items: out, next };
}

/** Reopens one resolved conflict: state open again, the old decision moved into `history` (never dropped), one audit row. Returns the new view, or null when it moved meanwhile. */
async function reopenConflict(store, item, reason, actor, at) {
  const id = item.PK.slice("SYNC#CONFLICT#".length);
  const entry = {
    decision: item.decision ?? null, cloud_version: item.cloud_version ?? null, cloud_value_hash: item.cloud_value_hash ?? null,
    resolved_at: item.resolved_at ?? null, by: item.by ?? null, reopened_at: at, reason,
  };
  const history = [...(Array.isArray(item.history) ? item.history : []), entry].slice(-20);
  try {
    await transact(store.ddb, store.cmds, store.table, {
      updates: [{
        key: conflictKey(id), tag: "conflict:reopen", condition: "#s = :resolved AND attribute_not_exists(#ap)",
        update: "SET #s = :open, #g = :gpk, #h = :h, #re = :at REMOVE #d, #cv, #ch, #ra, #by",
        names: { "#s": "state", "#ap": "applied_at", "#g": "GSI1PK", "#h": "history", "#re": "reopened_at", "#d": "decision", "#cv": "cloud_version", "#ch": "cloud_value_hash", "#ra": "resolved_at", "#by": "by" },
        values: { ":resolved": "resolved", ":open": "open", ":gpk": "SYNCCONFLICT#open", ":h": history, ":at": at },
      }],
      puts: [{ item: { ...auditItem({ op: "sync.conflict.reopen", id: `conflict:${id}`, principalId: actor, at, before: { state: "resolved", decision: entry.decision, cloud_version: entry.cloud_version }, after: { state: "open", reason } }, store.uid(), store.table), origin: "desktop" } }],
    }, store.txnOpts);
  } catch (e) {
    if (e instanceof TxnCancelled && e.conditionFailed) return null;
    if (e instanceof TxnCancelled) throw retryable();
    throw e;
  }
  const { decision: _d, cloud_version: _v, cloud_value_hash: _h, resolved_at: _r, by: _b, ...rest } = item;
  return conflictView({ ...rest, state: "open", reopened_at: at, history });
}

/** Stamps `applied_at` on a resolved decision (it stays resolved; reconcile skips it from then on). Returns the item as stored, or null when it is no longer resolved. Idempotent. */
async function stampApplied(store, item, outcome, actor, at, reason) {
  const id = item.PK.slice("SYNC#CONFLICT#".length);
  const key = conflictKey(id);
  try {
    await transact(store.ddb, store.cmds, store.table, {
      updates: [{
        key, tag: "conflict:applied", condition: "#s = :resolved AND attribute_not_exists(#ap)", update: "SET #ap = :at, #ao = :o",
        names: { "#s": "state", "#ap": "applied_at", "#ao": "applied_outcome" }, values: { ":resolved": "resolved", ":at": at, ":o": outcome },
      }],
      puts: [{ item: { ...auditItem({ op: "sync.conflict.applied", id: `conflict:${id}`, principalId: actor, at, before: { state: "resolved" }, after: { state: "resolved", outcome, ...(reason ? { reason } : {}) } }, store.uid(), store.table), origin: "desktop" } }],
    }, store.txnOpts);
  } catch (e) {
    if (e instanceof TxnCancelled && e.conditionFailed) {
      const again = (await store.ddb.send(new store.cmds.GetCommand({ TableName: store.table, Key: key, ConsistentRead: true }))).Item;
      return again?.state === "resolved" && again.applied_at ? again : null;
    }
    if (e instanceof TxnCancelled) throw retryable();
    throw e;
  }
  return { ...item, applied_at: at, applied_outcome: outcome };
}

/**
 * POST /api/sync/conflicts/reconcile {observed?: [{class, handle, path, cloud}], dry?: true, after?: cursor} (sync bearer; the add-on calls it on every pull).
 * Every resolved keep_cloud or keep_desktop decision that has not been applied is checked against the cloud as it is now (SI-30): the head's
 * version must be the one stored with the decision, and the cloud values at the conflict's paths must hash to the stored `cloud_value_hash`. The
 * values are the head's own at the path's pointer; `observed` (the add-on computed them with the merge, which knows keyed-list paths) is used only
 * for a pointer the server cannot follow, and the stored value stands where neither is there. A decision that still applies is returned in `apply`;
 * one that does not is reopened (state open again, the old decision kept in `history`) and returned in `reopened` with its `reason`, and nothing is
 * applied for it. One exception: a keep_desktop decision whose version or value moved because the desktop's own push carried the chosen value (the head
 * now holds the desktop value at every path) is `settled`, not reopened: it is stamped applied (unless `dry`). With `dry: true` (a `check` run)
 * nothing is written: `reopened` and `settled` list what a real pull would do. One call weighs at most RECONCILE_ITEMS decisions; an item that fails
 * to read or write is counted in `failed` and left for the next call. Answers `{checked, apply, reopened, settled, failed, more, next, dry}`; `next` is
 * the cursor to send as `after` for the rest (null, and `more` false, when the queue is done).
 */
export async function syncConflictsReconcile(c) {
  c.sync.checkTree();
  const { store } = c.sync;
  if (c.body !== undefined && c.body !== null && !isObj(c.body)) throw bad("body");
  const dry = c.body?.dry === true;
  if (c.body?.dry !== undefined && typeof c.body.dry !== "boolean") throw bad("dry");
  const after = c.body?.after;
  if (after !== undefined && after !== null && (typeof after !== "string" || after.length > 512)) throw bad("after");
  const rawObserved = c.body?.observed;
  const observed = new Map();
  if (rawObserved !== undefined) {
    if (!Array.isArray(rawObserved) || rawObserved.length > OBSERVED_MAX) throw bad("observed");
    for (const o of rawObserved) {
      if (!isObj(o) || !CLASSES.includes(o.class) || typeof o.handle !== "string" || o.handle.length > 64 || typeof o.path !== "string" || o.path.length > 512) throw bad("observed");
      observed.set(observedKey(o.class, o.handle, o.path), o.cloud === undefined ? null : o.cloud);
    }
  }
  const { items: pending, next } = await pendingDecisions(store, after || undefined);
  const at = new Date(store.now()).toISOString();
  const apply = [];
  const reopened = [];
  const settled = [];
  let failed = 0;
  for (const item of pending) {
    try {
      const head = CLASSES.includes(item.class) && typeof item.handle === "string" ? await getRecordItem(store, item.class, item.handle) : undefined;
      const version = Number.isInteger(head?.version) ? head.version : null;
      const reason = decisionStaleReason(item, { version, paths: currentPaths(item, head, observed) });
      if (reason === null) { apply.push(conflictView(item)); continue; }
      if (item.decision === "keep_desktop" && (reason === "version_changed" || reason === "value_changed") && headHoldsDesktop(item, head)) {
        if (dry) { settled.push(conflictView(item)); continue; }
        const done = await stampApplied(store, item, "applied", c.actor.id, at, "desktop_value_in_cloud");
        if (done) settled.push(conflictView(done));
        continue;
      }
      if (dry) { reopened.push({ ...conflictView(item), reason }); continue; }
      const view = await reopenConflict(store, item, reason, c.actor.id, at);
      if (view) reopened.push({ ...view, reason });
    } catch (e) {
      failed += 1;
      store.log?.warn?.("a decision could not be weighed; left for the next call", logSafeError(e, { route: "sync.conflicts.reconcile" }));
    }
  }
  return ok({ checked: pending.length, apply, reopened, settled, failed, more: next !== null, next, dry });
}

/**
 * POST /api/sync/conflicts/:id/applied {outcome?: "applied" | "moot"} (sync bearer): the add-on's receipt for a decision it applied, or found moot
 * (no matching conflict on the desktop in any state). A keep_desktop decision is receipted only after the push that carries the desktop value
 * succeeded. The conflict stays `resolved`; `applied_at` keeps it out of the next reconcile, which matters for a keep_desktop decision, whose own
 * push moves the cloud head. Idempotent. 404 for an unknown id; 409 not_resolved for a conflict that was reopened.
 */
export async function syncConflictApplied(c) {
  c.sync.checkTree();
  const { store } = c.sync;
  const id = c.params.id;
  if (typeof id !== "string" || !CONFLICT_ID.test(id)) throw new HttpError(404, "not_found", "no such conflict");
  if (c.body !== undefined && c.body !== null && !isObj(c.body)) throw bad("body");
  const outcome = c.body?.outcome === undefined ? "applied" : c.body.outcome;
  if (!APPLIED_OUTCOMES.includes(outcome)) throw bad("outcome", `outcome must be one of ${APPLIED_OUTCOMES.join(", ")}`);
  const item = (await store.ddb.send(new store.cmds.GetCommand({ TableName: store.table, Key: conflictKey(id), ConsistentRead: true }))).Item;
  if (!item) throw new HttpError(404, "not_found", "no such conflict");
  if (item.state !== "resolved") throw new HttpError(409, "not_resolved", "this conflict is not decided");
  if (item.applied_at) return ok(conflictView(item));
  const at = new Date(store.now()).toISOString();
  const done = await stampApplied(store, item, outcome, c.actor.id, at);
  if (!done) throw new HttpError(409, "not_resolved", "this conflict is not decided");
  return ok(conflictView(done));
}
