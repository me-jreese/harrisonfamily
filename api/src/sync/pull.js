// HFY-TSK-174 (sync-pull-routes; sync.md 7.2, 4.2, BRD2 11.1 7.1/7.2, review SI-30, PS-22): the pull side of /api/sync/*.
//
//   GET  /api/sync/snapshot                     ARCH-C pull: a gzip JSONL of every head at the current seq, in the sync bucket, behind a 300 s presigned GET
//   POST /api/sync/media/:handle/download       a presigned GET of a Media blob, with the checksums the desktop verifies after the download
//   POST /api/sync/status                       the desktop's heartbeat after each run (SYNC#CLIENT#<instance>), 204
//   GET  /api/sync/conflicts?state=open         the conflict queue (SYNC#CONFLICT#<ulid>, read through GSI1 SYNCCONFLICT#<state>)
//   POST /api/sync/conflicts/:id/decision       gramps-owner plus step-up (auth_time <= 300 s): an hfy-admin cookie alone never reaches a sync route
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
 * Does a stored decision still apply (SI-30)? True only while the cloud head is the version the decision was made against and the cloud values at the
 * conflict's paths hash the same. The add-on applies a decision only then; otherwise it reopens the conflict. `paths` are the conflict's paths with the
 * CURRENT cloud values.
 */
export const decisionStillApplies = (conflict, { version, paths }) =>
  conflict?.state === "resolved" && (conflict.cloud_version ?? null) === (Number.isInteger(version) ? version : null) && conflict.cloud_value_hash === cloudValueHash(paths);

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
