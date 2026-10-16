// The cloud record store (HFY-TSK-243, BRD2 section 4): key builders, item builders and the few reads applyBatch needs.
//
//   REC#<Class>#<handle>          HEAD   the current redacted Gramps-6 JSON object      GSI1 RECS#<Class> / <gramps_id>#<handle>
//   SYNC#LOG                      <seq>  append-only change log = version history       GSI1 RECHIST#<Class>#<handle> / <version>
//   SYNC#HEAD                     META   seq counter, writes_enabled, seeded, tree_id, merges_enabled
//   SYNC#BATCH#<batch_id>         META   receipt + idempotency record, kept forever     GSI1 SYNCBATCH / <at>#<batch_id>
//   GID#<Class>#<gramps_id>       META   gramps_id uniqueness guard (see "GID lifecycle" below)
//   IDALIAS#<Class>#<old_id>      META   merge / renumber alias, never deleted
//   AUDIT#records:<batch_id>      one audit item per batch (built with auditItem())
//   SYNC#BUDGET#<yyyymmddhh>      META  count of delete and withdraw ops committed in that UTC hour (validator-js's destructive budget)
//   SYNC#SESSION#<session_id>     META  a multi-batch push session (sync-push-routes, HFY-TSK-173); SYNC#HEAD.open_session names the open one
//   SYNC#UPLOAD#<handle>          <sha256 hex>  a presigned blob upload waiting for its Media op (sync-push-routes), ttl +1 h
//
// `expunged`: BRD2 section 4 lists an `expunged` flag on heads and log entries. applyBatch never writes it (the attribute is absent,
// not false); privacy-expunge sets it when it nulls obj_json, and readers must treat an absent flag as not expunged.
//
// GID lifecycle. A Person id is permanent: a delete, withdraw, merge or renumber rewrites GID#Person#<id> as
// {handle, retired:true, reason} and nothing ever deletes it, so a retired id can never be handed to someone else (409
// gramps_id_retired). A non-Person id is released on delete or renumber, because no identity is keyed by a non-Person id:
// THREAD# subjects are `person:<id>` or `post:<ulid>`, RSUB# and PLINKS# are keyed by a Person id, and ALLOW# by an email.
// Reuse of a freed non-Person id is therefore harmless. gidDelete() refuses a Person on purpose.
import { createHash } from "node:crypto";
import { canonicalJson } from "../shared/canonical.mjs";
import { HttpError } from "../http-error.js";

export const CLASSES = Object.freeze(["Person", "Family", "Event", "Place", "Source", "Citation", "Repository", "Media", "Note", "Tag"]);
export const ORIGINS = Object.freeze(["desktop", "seed", "self", "admin", "proposal", "graduation", "moderation", "tag"]);
export const OP_KINDS = Object.freeze(["create", "update", "delete", "withdraw", "marker"]);
export const SCHEMA_VERSION = 21;
export const REDACTION_VERSION = 1;
/** Per-batch limits from the sync design (7.2): the client splits by both. */
export const MAX_OPS = 24;
export const MAX_OBJ_BYTES = 204800;
export const MAX_BATCH_OBJ_BYTES = 3_500_000; // 2 x sum(obj_json bytes) + sum(blob bytes): the head and the log entry each hold a copy
/** A Media op's `blob` descriptor rides on the head item, next to a 200 KB obj_json, under DynamoDB's 400 KB item limit. */
export const MAX_BLOB_BYTES = 4096;
/** Transaction items a batch needs besides its ops: the SYNC#HEAD update, the SYNC#BATCH receipt and the audit item. A batch with a delete or
 *  withdraw needs one more, the SYNC#BUDGET# counter (apply.js adds it). */
export const FIXED_TXN_ITEMS = 3;

/** The identity class whose ids are permanent. */
export const PERMANENT_ID_CLASS = "Person";
export const isPermanentIdClass = (cls) => cls === PERMANENT_ID_CLASS;

const pad = (n, w) => String(n).padStart(w, "0");
export const seqKey = (seq) => pad(seq, 12);
export const versionKey = (v) => pad(v, 8);

// ---- keys -----------------------------------------------------------------------------------------------------------
export const recKey = (cls, handle) => ({ PK: `REC#${cls}#${handle}`, SK: "HEAD" });
export const logKey = (seq) => ({ PK: "SYNC#LOG", SK: seqKey(seq) });
export const headKey = () => ({ PK: "SYNC#HEAD", SK: "META" });
export const batchKey = (batchId) => ({ PK: `SYNC#BATCH#${batchId}`, SK: "META" });
export const gidKey = (cls, grampsId) => ({ PK: `GID#${cls}#${grampsId}`, SK: "META" });
export const aliasKey = (cls, oldId) => ({ PK: `IDALIAS#${cls}#${oldId}`, SK: "META" });
export const auditId = (batchId) => `records:${batchId}`;
export const sessionKey = (sessionId) => ({ PK: `SYNC#SESSION#${sessionId}`, SK: "META" });
export const uploadKey = (handle, sha256Hex) => ({ PK: `SYNC#UPLOAD#${handle}`, SK: sha256Hex });
/** A push session lives 7 days: it is treated as expired at opened_at + 7 d without waiting for TTL deletion (BRD2 11.1 7.2). */
export const SESSION_TTL_SECONDS = 7 * 86400;
/** The UTC hour bucket of a time, `yyyymmddhh`, that SYNC#BUDGET# counters are keyed by. */
export const budgetBucket = (ms) => new Date(ms).toISOString().slice(0, 13).replace(/[-T]/g, "");
export const budgetKey = (bucket) => ({ PK: `SYNC#BUDGET#${bucket}`, SK: "META" });
/** How long a budget counter lives (seconds): well past the 25 hour buckets the rolling window reads. */
export const BUDGET_TTL_SECONDS = 3 * 86400;
/** Hour buckets the rolling 24 hour window reads: the current hour and the 24 before it, so no destructive op in the last 24 hours is missed. */
export const BUDGET_BUCKETS = 25;
/** A stable string for a key, for duplicate detection. */
export const keyId = (k) => `${k.PK}\u0000${k.SK}`;

// ---- hashing ---------------------------------------------------------------------------------------------------------
export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
/** Lower-case RFC 4648 base32 of a byte buffer, no padding. */
function base32(buf) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** batch_id = base32(sha256(principal + ":" + Idempotency-Key))[0:26] (sync design 4.1). */
export const batchIdFor = (principal, idempotencyKey) => base32(createHash("sha256").update(`${principal}:${idempotencyKey}`).digest()).slice(0, 26);

/**
 * ClientRequestToken for one attempt: hash(batch_id + ':' + seq_from), 32 hex characters (the limit is 36). seq_from moves
 * whenever a seq race forces a rebuild, so the token changes with the item set and DynamoDB never sees one token with two
 * different payloads (SI-28).
 */
export const requestTokenFor = (batchId, seqFrom) => sha256(`${batchId}:${seqFrom}`).slice(0, 32);

/**
 * The canonical, redacted object text the store keeps: the Gramps object without its `change` key. It uses the shared
 * canonical JSON (shared/canonical.mjs, the same vectors as gramps/hfygramps/canonical.py), so the store refuses what the
 * desktop add-on and the renderer could not rebuild: a fraction, an integer beyond +/-(2**53 - 1), a lone surrogate, nesting
 * deeper than 200. The spread (not storedForm's key-by-key copy) keeps an own `__proto__` key as data.
 */
export function objectJson(obj) {
  const { change, ...rest } = obj; // eslint-disable-line no-unused-vars
  return canonicalJson(rest);
}

// ---- items -----------------------------------------------------------------------------------------------------------
/** GSI1 keys of a record head. A Tag has no gramps_id, so its sort key is `#<handle>`. */
export const headGsi = (cls, grampsId, handle) => ({ GSI1PK: `RECS#${cls}`, GSI1SK: `${grampsId ?? ""}#${handle}` });

/**
 * A record head item. `obj_json` is the canonical redacted object (null for a tombstone); `hash` is the sha256 of it.
 * `fields` = { class, handle, gramps_id, version, seq, deleted, objJson, blob?, reason?, at, by, origin }.
 */
export function headItem(f) {
  return {
    ...recKey(f.class, f.handle),
    ...headGsi(f.class, f.gramps_id, f.handle),
    entity: "rec",
    class: f.class,
    handle: f.handle,
    gramps_id: f.gramps_id ?? "",
    version: f.version,
    seq: f.seq,
    deleted: f.deleted === true,
    schema: SCHEMA_VERSION,
    redaction: REDACTION_VERSION,
    obj_json: f.objJson ?? null,
    hash: f.objJson == null ? null : sha256(f.objJson),
    ...(f.blob !== undefined ? { blob: f.blob } : {}),
    ...(f.reason !== undefined ? { reason: f.reason } : {}),
    updated_at: f.at,
    updated_by: f.by,
    origin: f.origin,
  };
}

/** A change log entry; one per op, with its own dense seq. A marker carries no class and no history index. */
export function logItem(f) {
  const hist = f.class ? { GSI1PK: `RECHIST#${f.class}#${f.handle}`, GSI1SK: versionKey(f.version) } : {};
  return {
    ...logKey(f.seq),
    ...hist,
    entity: "change",
    seq: f.seq,
    batch_id: f.batch_id,
    op: f.op,
    ...(f.class ? { class: f.class, handle: f.handle, gramps_id: f.gramps_id ?? "", version: f.version, base_version: f.base_version ?? null } : {}),
    obj_json: f.objJson ?? null,
    hash: f.objJson == null ? null : sha256(f.objJson),
    ...(f.reason !== undefined ? { reason: f.reason } : {}),
    ...(f.marker !== undefined ? { marker: f.marker } : {}),
    principal: f.principal,
    origin: f.origin,
    ...(f.on_behalf_of !== undefined ? { on_behalf_of: f.on_behalf_of } : {}),
    at: f.at,
  };
}

/** The batch receipt: the stored response body of the push plus what is needed to detect a reused key. */
export function batchItem(f) {
  return {
    ...batchKey(f.batch_id),
    GSI1PK: "SYNCBATCH",
    GSI1SK: `${f.at}#${f.batch_id}`,
    entity: "syncbatch",
    batch_id: f.batch_id,
    request_hash: f.request_hash,
    principal: f.principal,
    origin: f.origin,
    ...(f.client !== undefined ? { client: f.client } : {}),
    seq_from: f.seq_from,
    seq_to: f.seq_to,
    results: f.results,
    at: f.at,
  };
}

/** A GID guard item claiming `grampsId` for `handle`. */
export const gidClaimItem = (cls, grampsId, handle, { at, batch_id }) => ({ ...gidKey(cls, grampsId), entity: "gid", class: cls, gramps_id: grampsId, handle, at, batch_id });

/** A retired GID guard item: the id stays, for ever, pointing at the object that held it. */
export const gidRetiredItem = (cls, grampsId, handle, reason, { at, batch_id }) => ({ ...gidClaimItem(cls, grampsId, handle, { at, batch_id }), retired: true, reason });

/**
 * The key of a GID item to delete. Refuses a Person: Person ids are permanent, so no code path may delete one (BRD2 4.2).
 * Every GID delete in this module goes through here.
 */
export function gidDelete(cls, grampsId) {
  if (isPermanentIdClass(cls)) throw new Error("a Person GID item is retired, never deleted");
  return gidKey(cls, grampsId);
}

export const aliasItem = (cls, oldId, f) => ({
  ...aliasKey(cls, oldId),
  entity: "idalias",
  class: cls,
  old_gramps_id: oldId,
  handle: f.handle,
  current_gramps_id: f.current_gramps_id ?? null,
  reason: f.reason,
  batch_id: f.batch_id,
  at: f.at,
});

// ---- reads -----------------------------------------------------------------------------------------------------------
const get = async ({ ddb, cmds, table }, Key) => (await ddb.send(new cmds.GetCommand({ TableName: table, Key, ConsistentRead: true }))).Item;

/** SYNC#HEAD, or undefined while it does not exist. */
export const getSyncHead = (ctx) => get(ctx, headKey());
export const getBatchReceipt = (ctx, batchId) => get(ctx, batchKey(batchId));
export const getGid = (ctx, cls, grampsId) => get(ctx, gidKey(cls, grampsId));
export const getAlias = (ctx, cls, oldId) => get(ctx, aliasKey(cls, oldId));
export const getSession = (ctx, sessionId) => get(ctx, sessionKey(sessionId));
export const getUpload = (ctx, handle, sha256Hex) => get(ctx, uploadKey(handle, sha256Hex));
/** True when a Person's id is retired because the person was withdrawn (made private): GID#Person#<id> holds { retired: true, reason: "withdrawn" }. */
export const isPersonWithdrawn = async (ctx, grampsId) => {
  const g = await getGid(ctx, "Person", grampsId);
  return g?.retired === true && g.reason === "withdrawn";
};
/** The raw head item of one object (tombstones included), or undefined. */
export const getRecordItem = (ctx, cls, handle) => get(ctx, recKey(cls, handle));

/** A head item as the caller sees it: `{class, handle, gramps_id, version, seq, deleted, obj}`; obj is the parsed redacted object or null. */
export function parseHead(item) {
  if (!item) return null;
  return {
    class: item.class,
    handle: item.handle,
    gramps_id: item.gramps_id,
    version: item.version,
    seq: item.seq,
    deleted: item.deleted === true,
    obj: item.obj_json == null ? null : JSON.parse(item.obj_json),
    hash: item.hash ?? null,
    origin: item.origin,
    updated_at: item.updated_at,
  };
}

/** The current head of one object as `parseHead` shapes it (a tombstone has `obj: null`), or null. */
export async function getRecord(ctx, cls, handle) {
  if (!CLASSES.includes(cls)) throw new HttpError(422, "unknown_class", `unknown class ${String(cls).slice(0, 32)}`);
  return parseHead(await getRecordItem(ctx, cls, handle));
}
