// Blob upload for the desktop sync (HFY-TSK-173; sync.md 9, BRD2 11.1 7.2, review SI-31).
//
//   POST /api/sync/media/presign   the desktop asks for a presigned PUT. Every blob goes to media/.staging/<handle>/<sha256>, never to its
//                                  served key, so a blob whose Media op is refused (a privacy violation, a stale version) is never served and a
//                                  blob update is atomic with its Media op. A pending SYNC#UPLOAD#<handle>/<sha256> item (ttl +1 h) records it.
//   Media op `blob`                {sha256, md5, size, content_type}: what the desktop says it uploaded. The route never stores that: it builds the
//                                  stored descriptor itself ({s3_key, sha256, md5, size, content_type, state}), with the key derived from the
//                                  handle and the content type, and (before the first commit only) checks the staged object with HeadObject in
//                                  checksum mode. {state: "missing"} is a held blob: metadata syncs, the cloud blob, if any, is kept.
//   finalize (after the commit)    CopyObject staging -> media/<handle><ext> with ChecksumAlgorithm SHA256, the returned checksum compared with the
//                                  signed one; then the staging object, the key an extension change orphaned and the pending item are deleted.
//                                  Every step is idempotent, so a replay of the batch (same Idempotency-Key) finishes a finalize that failed.
import { CopyObjectCommand, DeleteObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { HttpError, logSafeError } from "../http.js";
import { HANDLE_SHAPE } from "../records/ops.js";
import { transact } from "../txn.js";
import { getRecordItem, getUpload, uploadKey } from "./store.js";

/** Content types the sync presign accepts, and the extension each gets in media/<handle><ext>. HEIC and WebP are not accepted (sync.md 9). */
export const MEDIA_TYPES = Object.freeze({ "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/tiff": ".tif", "application/pdf": ".pdf" });
export const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
export const PRESIGN_EXPIRES_SECONDS = 300;
/** How long a pending upload item lives (seconds): the time between the presign and the Media op that uses the blob. */
export const UPLOAD_PENDING_SECONDS = 3600;
export const STAGING_PREFIX = "media/.staging/";

const SHA256_HEX = /^[0-9a-f]{64}$/;
const MD5_HEX = /^[0-9a-f]{32}$/;
const SHA256_B64 = /^[A-Za-z0-9+/]{43}=$/;
/** The only keys finalize may delete as an orphan: a binary under media/ named by a handle, never staging, never a .json. */
const BINARY_KEY = /^media\/[0-9a-f]{19,28}\.[a-z0-9]{2,4}$/;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const bad = (field, message) => new HttpError(400, "validation", message ?? `${field} is invalid`, { fields: [{ field, code: "invalid" }] });
const retryable = () => new HttpError(503, "retryable", "the blob store is busy; retry with the same Idempotency-Key");

export const stagingKey = (handle, sha256Hex) => `${STAGING_PREFIX}${handle}/${sha256Hex}`;
export const finalKey = (handle, contentType) => `media/${handle}${MEDIA_TYPES[contentType]}`;
export const b64OfHex = (hex) => Buffer.from(hex, "hex").toString("base64");
export const hexOfB64 = (b64) => Buffer.from(b64, "base64").toString("hex");

/** The presign body, validated: {handle, content_type, size, sha256_b64, md5_hex}; returns also `sha256` (hex). */
export function presignBody(body) {
  if (!isObj(body)) throw bad("body");
  if (typeof body.handle !== "string" || !HANDLE_SHAPE.test(body.handle)) throw bad("handle");
  if (typeof body.content_type !== "string" || !Object.hasOwn(MEDIA_TYPES, body.content_type)) {
    throw new HttpError(400, "validation", "content_type must be one of " + Object.keys(MEDIA_TYPES).join(", "), { fields: [{ field: "content_type", code: "unsupported" }] });
  }
  if (!Number.isInteger(body.size) || body.size < 1 || body.size > MAX_MEDIA_BYTES) {
    throw new HttpError(400, "validation", `size must be 1 to ${MAX_MEDIA_BYTES} bytes`, { fields: [{ field: "size", code: "range" }] });
  }
  if (typeof body.sha256_b64 !== "string" || !SHA256_B64.test(body.sha256_b64)) throw bad("sha256_b64");
  const sha256 = hexOfB64(body.sha256_b64);
  if (b64OfHex(sha256) !== body.sha256_b64) throw bad("sha256_b64"); // not canonical base64 of 32 bytes
  if (typeof body.md5_hex !== "string" || !MD5_HEX.test(body.md5_hex)) throw bad("md5_hex");
  return { handle: body.handle, content_type: body.content_type, size: body.size, sha256_b64: body.sha256_b64, sha256, md5: body.md5_hex };
}

/** POST /api/sync/media/presign. `c.sync.store` carries {ddb, cmds, table, now, presignPut, mediaBucket}. */
export async function syncMediaPresign(c) {
  c.sync.checkTree();
  const { store } = c.sync;
  if (typeof store.presignPut !== "function") throw new HttpError(503, "unavailable", "blob uploads are not configured");
  const p = presignBody(c.body);
  const key = stagingKey(p.handle, p.sha256);
  const nowS = Math.floor(store.now() / 1000);
  await store.ddb.send(new store.cmds.PutCommand({
    TableName: store.table,
    Item: {
      ...uploadKey(p.handle, p.sha256), entity: "syncupload", handle: p.handle, s3_key: key, content_type: p.content_type, size: p.size, md5: p.md5,
      sha256: p.sha256, principal: c.actor.id, created_at: new Date(store.now()).toISOString(), ttl: nowS + UPLOAD_PENDING_SECONDS,
    },
  }));
  const url = await store.presignPut({ bucket: store.mediaBucket, key, contentType: p.content_type, size: p.size, expiresIn: PRESIGN_EXPIRES_SECONDS, checksumSha256: p.sha256_b64 });
  return { status: 200, body: { upload_url: url, headers: { "Content-Type": p.content_type, "x-amz-checksum-sha256": p.sha256_b64 }, key, expires_in: PRESIGN_EXPIRES_SECONDS } };
}

// ---- the Media op's blob ----------------------------------------------------------------------------------------------

/**
 * The stored `blob` descriptor for a Media op's claim, or `{state: "missing"}`. Pure: the same claim gives the same descriptor, which keeps the
 * request hash of a replayed batch stable. The key is derived here; whatever key the client might send is never read.
 */
export function blobDescriptor(handle, claim, at = "blob") {
  if (!isObj(claim)) throw bad(at, `${at} must be an object`);
  const allowed = new Set(["sha256", "md5", "size", "content_type", "state"]);
  for (const k of Object.keys(claim)) if (!allowed.has(k)) throw bad(`${at}.${k}`, `${at}.${k} is not a blob field`);
  if (claim.state === "missing") {
    if (Object.keys(claim).length !== 1) throw bad(at, `${at} with state missing carries no other field`);
    return { state: "missing" };
  }
  if (claim.state !== undefined && claim.state !== "present") throw bad(`${at}.state`);
  if (typeof claim.sha256 !== "string" || !SHA256_HEX.test(claim.sha256)) throw bad(`${at}.sha256`);
  if (typeof claim.md5 !== "string" || !MD5_HEX.test(claim.md5)) throw bad(`${at}.md5`);
  if (!Number.isInteger(claim.size) || claim.size < 1 || claim.size > MAX_MEDIA_BYTES) throw bad(`${at}.size`);
  if (typeof claim.content_type !== "string" || !Object.hasOwn(MEDIA_TYPES, claim.content_type)) throw bad(`${at}.content_type`);
  return { s3_key: finalKey(handle, claim.content_type), sha256: claim.sha256, md5: claim.md5, size: claim.size, content_type: claim.content_type, state: "present" };
}

const s3Status = (e) => e?.$metadata?.httpStatusCode;
const isNotFound = (e) => e?.name === "NotFound" || e?.name === "NoSuchKey" || s3Status(e) === 404;
/**
 * A missing key. The hfy-api role has s3:GetObject but not s3:ListBucket on the media bucket, so S3 answers 403 for a key that does not exist; a
 * 403 is therefore read as "missing" here, and logged at warn so an IAM or bucket-policy fault (the post-cutover deny) shows up in the logs
 * instead of looking like a client that never uploaded.
 */
function notFound(store, e, what) {
  if (isNotFound(e)) return true;
  if (s3Status(e) === 403) {
    store.log?.warn?.("s3 answered 403, read as a missing key (no s3:ListBucket); check the role and the bucket policy if this repeats", logSafeError(e, { route: "sync.batches", what }));
    return true;
  }
  return false;
}

/**
 * Turns the Media ops' `blob` claims into stored descriptors (in place) and returns the plan finalizeBlobs() runs after the commit.
 *   ops        the request's ops array (objects are edited: a `blob` is replaced by the descriptor, or dropped to keep the cloud blob)
 *   head       async (class, handle) => the raw head item | undefined
 *   replay     true when the batch's receipt exists: nothing is verified (the first attempt did), finalize reads what it still needs
 * Refusals: 400 validation (a malformed claim), 422 blob_not_uploaded (no pending upload, expired, or no object at the staging key),
 * 422 blob_mismatch (the staged object's size, checksum or type is not what was claimed), 503 retryable (S3 failed).
 */
export async function prepareBlobs(store, ops, { head, replay }) {
  const plan = [];
  if (!Array.isArray(ops)) return plan;
  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i];
    if (!isObj(op) || op.blob === undefined) continue;
    const live = op.op === "create" || op.op === "update";
    if (op.class !== "Media" || !live) {
      if (!live) delete op.blob; // a delete, withdraw or marker has no blob; applyBatch would ignore it anyway
      continue; // a non-Media create or update: applyBatch refuses it with 400 validation
    }
    if (typeof op.handle !== "string" || !HANDLE_SHAPE.test(op.handle)) continue; // applyBatch's 400
    const at = `ops[${i}].blob`;
    const descriptor = blobDescriptor(op.handle, op.blob, at);
    if (descriptor.state === "missing") {
      // A held blob. The op keeps {state: "missing"} whatever the head holds, so a replay builds the same request (and the same hash) as the
      // first attempt; applyBatch keeps the head's descriptor when it is a present blob, so a good cloud blob is never replaced by a missing one.
      op.blob = descriptor;
      continue;
    }
    op.blob = descriptor;
    const prior = replay ? undefined : await head("Media", op.handle);
    const priorBlob = prior && prior.deleted !== true ? prior.blob : undefined;
    const sha = descriptor.sha256;
    const item = { op_id: typeof op.op_id === "string" ? op.op_id : String(i + 1), handle: op.handle, sha256: sha, descriptor, staging: stagingKey(op.handle, sha), orphan: undefined };
    if (!replay) {
      const pending = await getUpload(store, op.handle, sha);
      const fresh = pending && Number.isInteger(pending.ttl) && pending.ttl * 1000 > store.now();
      if (!fresh) {
        if (priorBlob?.state === "present" && priorBlob.sha256 === sha && priorBlob.s3_key === descriptor.s3_key) continue; // unchanged: nothing was uploaded
        throw new HttpError(422, "blob_not_uploaded", "no pending upload for this blob; request a presigned URL and upload it first", { op_id: item.op_id, handle: op.handle });
      }
      if (pending.size !== descriptor.size || pending.md5 !== descriptor.md5 || pending.content_type !== descriptor.content_type) {
        throw new HttpError(422, "blob_mismatch", "the blob differs from the one that was presigned", { op_id: item.op_id, handle: op.handle });
      }
      await verifyStaged(store, item);
      const old = priorBlob?.state === "present" && typeof priorBlob.s3_key === "string" ? priorBlob.s3_key : undefined;
      if (old && old !== descriptor.s3_key && BINARY_KEY.test(old) && old.startsWith(`media/${op.handle}.`)) item.orphan = old;
      await holdPending(store, item);
    }
    plan.push(item);
  }
  return plan;
}

/**
 * Once the staged object is verified: push the pending item's ttl out by another UPLOAD_PENDING_SECONDS, so it outlives the commit and a retry
 * of a failed finalize, and record the key an extension change orphaned. Conditional on the item still existing: a parallel batch that
 * finalized the same blob deleted it, and an unconditional update would upsert a stub with no ttl that a later finalize takes for a pending upload.
 */
async function holdPending(store, item) {
  const names = { "#t": "ttl" };
  const values = { ":t": Math.floor(store.now() / 1000) + UPLOAD_PENDING_SECONDS };
  let expr = "SET #t = :t";
  if (item.orphan) {
    expr += ", #r = :o";
    names["#r"] = "replaces";
    values[":o"] = item.orphan;
  }
  try {
    await store.ddb.send(new store.cmds.UpdateCommand({
      TableName: store.table, Key: uploadKey(item.handle, item.sha256), UpdateExpression: expr, ConditionExpression: "attribute_exists(PK)",
      ExpressionAttributeNames: names, ExpressionAttributeValues: values,
    }));
  } catch (e) {
    if (e?.name === "ConditionalCheckFailedException") {
      throw new HttpError(422, "blob_not_uploaded", "the pending upload for this blob is gone; request a presigned URL and upload it again", { op_id: item.op_id, handle: item.handle });
    }
    throw e;
  }
}

/** HeadObject in checksum mode on the staged object: it must exist and have the claimed size, SHA-256 and content type. */
async function verifyStaged(store, item) {
  let r;
  try {
    r = await store.s3.send(new HeadObjectCommand({ Bucket: store.mediaBucket, Key: item.staging, ChecksumMode: "ENABLED" }));
  } catch (e) {
    if (notFound(store, e, "staging")) throw new HttpError(422, "blob_not_uploaded", "the blob is not at its staging key yet", { op_id: item.op_id, handle: item.handle });
    store.log?.warn?.("blob head failed", logSafeError(e, { route: "sync.batches" }));
    throw retryable();
  }
  const d = item.descriptor;
  if (r.ContentLength !== d.size || r.ChecksumSHA256 !== b64OfHex(d.sha256) || (r.ContentType !== undefined && r.ContentType !== d.content_type)) {
    throw new HttpError(422, "blob_mismatch", "the uploaded blob is not the one claimed", { op_id: item.op_id, handle: item.handle });
  }
}

/**
 * After the Media ops committed (or replayed): copy each staged blob into place, delete the staging object, the key an extension change orphaned
 * and the pending item. Idempotent. A failure is a 503 retryable: the batch is committed, so the client replays it with the same Idempotency-Key,
 * which runs this again.
 */
export async function finalizeBlobs(store, plan) {
  for (const item of plan) {
    try {
      await finalizeOne(store, item);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      store.log?.error?.("blob finalize failed (batch already committed)", logSafeError(e, { route: "sync.batches" }));
      throw retryable();
    }
  }
}

async function finalizeOne(store, item) {
  const { s3, mediaBucket: bucket } = store;
  const pending = await getUpload(store, item.handle, item.sha256);
  const d = item.descriptor;
  const expect = b64OfHex(d.sha256);
  const headOf = async (Key, what) => {
    try {
      return await s3.send(new HeadObjectCommand({ Bucket: bucket, Key, ChecksumMode: "ENABLED" }));
    } catch (e) {
      if (notFound(store, e, what)) return undefined;
      throw e;
    }
  };
  if (!pending) {
    // No pending item: either an earlier attempt finished (it deletes the item last), or the item's ttl ran out between a commit whose copy
    // failed and this replay. Telling them apart needs the objects, not the item: the blob is in place when the final key carries its checksum.
    const final = await headOf(d.s3_key, "final");
    if (final && final.ChecksumSHA256 === expect) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: item.staging })); // a leftover of a crash before this delete; a no-op otherwise
      return;
    }
    if (!(await headOf(item.staging, "staging"))) {
      store.log?.warn?.("blob is neither in place nor staged (a later batch replaced it, or it is lost)", { handle: item.handle, route: "sync.batches" });
      return;
    }
    // Staged, not in place. Copy only while the Media head still names this blob: a replay of an old batch must not overwrite a newer one.
    const cur = await getRecordItem(store, "Media", item.handle);
    if (!cur || cur.deleted === true || cur.blob?.sha256 !== d.sha256 || cur.blob?.s3_key !== d.s3_key) return;
  }
  try {
    const r = await s3.send(new CopyObjectCommand({ Bucket: bucket, Key: d.s3_key, CopySource: `${bucket}/${item.staging}`, ChecksumAlgorithm: "SHA256" }));
    const got = r?.CopyObjectResult?.ChecksumSHA256;
    if (got !== undefined && got !== expect) throw Object.assign(new Error("copy checksum mismatch"), { name: "BlobCopyMismatch" });
  } catch (e) {
    if (!notFound(store, e, "copy")) throw e;
    // The staging object is gone: a previous attempt copied and deleted it. The final key must carry the checksum, else this is a real loss.
    const h = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: d.s3_key, ChecksumMode: "ENABLED" }));
    if (h.ChecksumSHA256 !== expect) throw Object.assign(new Error("blob missing"), { name: "BlobMissing" });
  }
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: item.staging }));
  const orphan = item.orphan ?? pending?.replaces;
  if (typeof orphan === "string" && orphan !== d.s3_key && BINARY_KEY.test(orphan) && orphan.startsWith(`media/${item.handle}.`)) {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: orphan }));
  }
  if (pending) await transact(store.ddb, store.cmds, store.table, { deletes: [uploadKey(item.handle, item.sha256)] }, store.txnOpts);
}
