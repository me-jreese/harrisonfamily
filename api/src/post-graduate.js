// Graduating post photos into Gramps Media on publish (HFY-TSK-387-0G; BRD D-10, D-34, E2E-G; sibling of graduate.js, which graduates comment photos).
//
//   Behind HFY_POST_GRADUATE=on (a server switch, default OFF). The client flag postGraduateV1 is a separate, later switch for the UI; this one
//   decides whether the API writes anything at all.
//
// When a post is published (posts.create with visibility "published", posts.visibility to "published", and an edit of a published post), each
// image attachment of the post is graduated: one Media object per photo and one MediaRef on the post's author, written through applyBatch()
// with origin "graduation" (validators, versions, audit and rendering as for every other writer; the cloud store and the renderer stay the only
// writers of family data). Every Media carries the Gramps Tag `hfy-post` (D-08 as amended by D-34). A person tagged in the photo gets an appended
// MediaRef with the region (D-05, D-10). Nothing here deletes anything: deleting the post leaves its Media (D-10).
//
// Idempotency: one marker item per photo, PK `POSTGRAD#<post id>`, SK `PHOTO#<upload id>`, {state: pending|done|failed, media_handle, ...}. The
// handle is minted once, when the marker is first written, and a retry resumes with it. The marker lives beside the post, not on its attachment,
// because an edit rewrites the attachments (normalizeAttachments keeps no marker). Phases per photo: reserve, copy, apply, finalize; each can be
// run again, and applyBatch runs under the key `postgrad:<post id>:<upload id>`, so a retry or a republish never makes a second Media.
//
// The hook is best effort: it runs after the post's own write has committed (handler.js graduatePostPhotos wraps it in afterCommit), so a
// failure is logged and the next publish, edit or the backfill finishes the photo. Moderation follows the MOD# overlay: a hidden post and a hidden
// photo are not graduated.
//
// Post tags: an image attachment may carry `tags: [{person: <gramps_id>, rect: [x1, y1, x2, y2]}]` (integer percent 0-100, D-02). The post
// schema (content.js normalizeAttachments) keeps no such field today, so no published post carries one until the post-tagging task adds it;
// the graduation reads the field where it is present.
import { CopyObjectCommand } from "@aws-sdk/client-s3";
import { HttpError, logSafeError } from "./http.js";
import { TxnCancelled, transact } from "./txn.js";
import { postAttachmentId } from "./moderation.js";
import { UPLOAD_PREFIX } from "./uploads.js";
import { checkLocation, headUpload } from "./upload-guard.js";
import { createHash } from "node:crypto";
import { mintHandle } from "./records/ops.js";
import { byGrampsId, storeView } from "./records/index.js";
import { applyBatch, checkStoreGate } from "./sync/apply.js";
import { policyOf } from "./sync/id-policy.js";
import { finalKey, hexOfB64 } from "./sync/media.js";
import { getRecord, getRecordItem, getSyncHead } from "./sync/store.js";
import { postSource } from "./media-origin.js";
import { SOURCE_TYPE, classifySyncError, mediaObject } from "./graduate.js";

const unavailable = (code, message) => new HttpError(503, code, message);

export const POST_TAG = "hfy-post";
export const MAX_TAGS_PER_PHOTO = 20;
/** The switch that turns the whole feature on. Anything but "on" is off. */
export const postGraduateFromEnv = (env = process.env) => env?.HFY_POST_GRADUATE === "on";
/** The idempotency key of one post photo: the same for every attempt. */
export const postGraduateKey = (postId, uploadId) => `postgrad:${postId}:${uploadId}`;
export const markerKey = (postId, uploadId) => ({ PK: `POSTGRAD#${postId}`, SK: `PHOTO#${uploadId}` });
/** The handle a created hfy-post Tag gets: a function of the name, so two writers that both create it collide instead of making two Tags. */
export const POST_TAG_HANDLE = createHash("sha256").update(`hfy-tag:${POST_TAG}`).digest("hex").slice(0, 24);

const ULID = "[0-9A-HJKMNP-TV-Z]{26}";
const KEY_RE = new RegExp(`^${UPLOAD_PREFIX}/${ULID}/[a-z0-9][a-z0-9._-]{0,80}$`);
const GRAMPS_ID_RE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}$/;

/** A region as the HFY rect unit stores it (integer percent). Floats, reversed, zero-area, out-of-range and full-image regions are null (D-03, interim predicate until W0 pins Gramps' own). */
export function normalizeRect(r) {
  if (!Array.isArray(r) || r.length !== 4 || !r.every(Number.isInteger)) return null;
  const [x1, y1, x2, y2] = r;
  if (![x1, y1, x2, y2].every((v) => v >= 0 && v <= 100)) return null;
  if (!(x1 < x2 && y1 < y2)) return null;
  if (x1 === 0 && y1 === 0 && x2 === 100 && y2 === 100) return null;
  return [x1, y1, x2, y2];
}

/** The tags of one attachment, shape-checked: [{person, rect|null}], at most MAX_TAGS_PER_PHOTO, one per person (the first wins). */
export function tagsOf(a) {
  if (!Array.isArray(a?.tags)) return [];
  const out = [];
  for (const t of a.tags) {
    if (out.length >= MAX_TAGS_PER_PHOTO) break;
    if (typeof t?.person !== "string" || !GRAMPS_ID_RE.test(t.person) || out.some((x) => x.person === t.person)) continue;
    out.push({ person: t.person, rect: normalizeRect(t.rect) });
  }
  return out;
}

/** The bucket key of an attachment url: strips the public base, then checks the member-upload shape. undefined when it is not one. */
export function uploadKeyOf(url, base) {
  if (typeof url !== "string") return undefined;
  const path = base && url.startsWith(`${base}/`) ? url.slice(base.length) : url;
  const key = path.replace(/^\//, "");
  return KEY_RE.test(key) ? key : undefined;
}

/**
 * What graduation does with each image of a post, without touching anything: [{index, uploadId?, key?, tags, skip?}]. `skip` is the reason a photo is
 * not graduated: unsupported_type (only image/jpeg is copied), moderated (the post or the photo is hidden), bad_upload_path. A file attachment is not a photo.
 * The backfill dry run counts with this same function.
 */
export function plan(post, base) {
  const out = [];
  (post?.attachments ?? []).forEach((a, index) => {
    if (a?.kind !== "image") return;
    const uploadId = postAttachmentId(a);
    const key = uploadKeyOf(a.url, base);
    const e = { index, ...(uploadId ? { uploadId } : {}), ...(key ? { key } : {}), tags: tagsOf(a), alt: typeof a.alt === "string" ? a.alt : "" };
    if (post.moderation?.hidden === true || a.moderation?.hidden === true) e.skip = "moderated";
    else if (!uploadId || !key) e.skip = "bad_upload_path";
    else if (a.mime !== SOURCE_TYPE) e.skip = "unsupported_type";
    out.push(e);
  });
  return out;
}

const tagObject = (handle, change) => ({ _class: "Tag", handle, name: POST_TAG, color: "#000000000000", priority: 0, change });
const mediaRef = (handle, rect) => ({ _class: "MediaRef", ref: handle, rect, private: false, attribute_list: [], citation_list: [], note_list: [] });
/** The Person with MediaRef(handle, rect) appended (D-05). A ref to this Media already there is kept once. */
function withRef(obj, handle, rect, change) {
  const list = Array.isArray(obj.media_list) ? obj.media_list : [];
  if (list.some((r) => r?.ref === handle)) return obj;
  return { ...obj, media_list: [...list, mediaRef(handle, rect)], change };
}

/**
 * Deps: `ddb`, `cmds`, `table`; `store` (handler.build's `store`); `s3` + `bucket`; `mediaPublicBase`; `enabled()` the switch (default off);
 * `apply` replaces applyBatch (tests); `mint`; `afterPhase(name)` (fault injection in tests; production passes none).
 */
export function createPostGraduation({ ddb, cmds, table, store, s3, bucket = "harrisonfamily-frontend", mediaPublicBase, enabled = () => false, apply = applyBatch, now = () => Date.now(), mint = mintHandle, log = console, afterPhase }) {
  const phase = async (name) => { if (afterPhase) await afterPhase(name); };

  async function getMarker(postId, uploadId) {
    return (await ddb.send(new cmds.GetCommand({ TableName: table, Key: markerKey(postId, uploadId), ConsistentRead: true }))).Item;
  }
  /** Writes a marker. `create` makes it conditional on there being none yet; a lost race is reported as `false`. */
  async function putMarker(postId, uploadId, m, { create = false } = {}) {
    const item = { ...markerKey(postId, uploadId), entity: "postgrad", ...m };
    try {
      await transact(ddb, cmds, table, { puts: [{ item, ...(create ? { condition: "attribute_not_exists(PK)" } : {}) }], deletes: [], updates: [], checks: [] }, store.txnOpts);
      return true;
    } catch (e) {
      if (create && e instanceof TxnCancelled && e.conditionFailed) return false;
      throw e;
    }
  }

  function idPolicyMustMint() {
    let mode;
    try { mode = policyOf(store).mode; } catch (e) { log.error?.("post graduate: id policy unreadable", logSafeError(e)); }
    if (mode !== "mint") throw unavailable("id_policy_not_mint", "adding photos to family pages is not set up yet");
  }
  async function resolvePerson(gid) {
    const hits = await byGrampsId(store, "Person", gid);
    if (hits.length !== 1) return null;
    const head = await getRecord(store, "Person", hits[0].handle);
    return head && !head.deleted && head.obj ? { handle: head.handle, version: head.version, obj: head.obj } : null;
  }
  /** The hfy-post Tag: the one the store already has (by name, or by the deterministic handle), else one to create in the batch. */
  async function tagFor() {
    const det = await getRecord(store, "Tag", POST_TAG_HANDLE);
    if (det && !det.deleted && det.obj) return { handle: POST_TAG_HANDLE, create: false };
    const view = await storeView(store);
    for (const h of view.live()) if (h.class === "Tag" && h.obj?.name === POST_TAG) return { handle: h.handle, create: false };
    return { handle: POST_TAG_HANDLE, create: true };
  }
  const isApplied = async (handle) => (await getRecordItem(store, "Media", handle)) !== undefined;

  async function copy(item, handle) {
    const head = await headUpload(bucket, item.key, { s3 });
    if (head.contentType !== SOURCE_TYPE) throw new HttpError(422, "unsupported_type", "only a jpeg photo can be added to a family page.");
    await checkLocation(bucket, item.key, { s3 }); // 400 photo_has_location | upload_missing, 503 unavailable
    if (typeof head.etag !== "string") throw unavailable("graduate_copy_failed", "no etag");
    let out;
    try {
      out = await s3.send(new CopyObjectCommand({ Bucket: bucket, Key: finalKey(handle, SOURCE_TYPE), CopySource: `${bucket}/${item.key}`, CopySourceIfMatch: head.etag, ChecksumAlgorithm: "SHA256" }));
    } catch (e) {
      log.error?.("post graduate: copy failed", logSafeError(e));
      throw unavailable(e?.$metadata?.httpStatusCode === 412 ? "graduate_source_changed" : "graduate_copy_failed", "copy failed");
    }
    const b64 = out?.CopyObjectResult?.ChecksumSHA256;
    if (typeof b64 !== "string" || b64 === "") throw unavailable("graduate_copy_failed", "no checksum");
    return { sha256: hexOfB64(b64), size: typeof head.size === "number" && head.size > 0 ? head.size : undefined };
  }

  /** Applies the batch for one photo. Returns {} on success, {fail: code} for a refusal a retry cannot cure. Throws an HttpError 503 to leave the photo pending. */
  async function applyPhase(post, item, handle, copied) {
    const idemKey = postGraduateKey(post.id, item.uploadId);
    for (let attempt = 0; ; attempt += 1) {
      if (await isApplied(handle)) return {};
      const author = await resolvePerson(post.author.id);
      if (!author) return { fail: "author_person_missing" };
      const authorTag = item.tags.find((t) => t.person === post.author.id);
      const tagged = [];
      const seen = new Set([author.handle]);
      for (const t of item.tags) {
        if (t.person === post.author.id) continue;
        const p = await resolvePerson(t.person);
        if (!p || seen.has(p.handle)) continue; // an unknown person is left out; the photo graduates without that tag
        seen.add(p.handle);
        tagged.push({ p, rect: t.rect });
      }
      const tag = await tagFor();
      const change = Math.floor(now() / 1000);
      const media = { ...mediaObject({ handle, desc: item.alt, source: postSource(post.id, item.uploadId), addedBy: post.author.id, change }), tag_list: [tag.handle] };
      const blob = { s3_key: finalKey(handle, SOURCE_TYPE), sha256: copied.sha256, ...(copied.size !== undefined ? { size: copied.size } : {}), content_type: SOURCE_TYPE, state: "present" };
      const ops = [];
      const next = () => String(ops.length + 1);
      if (tag.create) ops.push({ op_id: next(), op: "create", class: "Tag", handle: tag.handle, base_version: null, obj: tagObject(tag.handle, change) });
      ops.push({ op_id: next(), op: "create", class: "Media", handle, base_version: null, obj: media, blob });
      ops.push({ op_id: next(), op: "update", class: "Person", handle: author.handle, base_version: author.version, obj: withRef(author.obj, handle, authorTag?.rect ?? null, change) });
      for (const { p, rect } of tagged) ops.push({ op_id: next(), op: "update", class: "Person", handle: p.handle, base_version: p.version, obj: withRef(p.obj, handle, rect, change) });
      try {
        await apply(store, { principal: post.author.id, origin: "graduation", idempotencyKey: idemKey, ops });
        return {};
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        const kind = classifySyncError(e);
        if (kind === "conflict" && attempt < 2) continue; // re-read the people and the Tag and try again: an append commutes
        if (kind === "validation") return { fail: typeof e.code === "string" ? e.code.slice(0, 64) : "validation" };
        log.error?.("post graduate: apply unavailable", logSafeError(e));
        throw unavailable("sync_unavailable", "unavailable");
      }
    }
  }

  async function graduateOne(post, item) {
    let marker = await getMarker(post.id, item.uploadId);
    if (marker?.state === "done") return { upload: item.uploadId, state: "done", already: true, media_handle: marker.media_handle };
    if (!marker) {
      const fresh = { state: "pending", media_handle: mint({ now }), person: post.author.id, at: new Date(now()).toISOString() };
      if (await putMarker(post.id, item.uploadId, fresh, { create: true })) marker = fresh;
      else marker = await getMarker(post.id, item.uploadId); // another writer reserved first: continue with its handle
      if (marker?.state === "done") return { upload: item.uploadId, state: "done", already: true, media_handle: marker.media_handle };
    }
    const handle = marker.media_handle;
    const fail = async (code) => {
      await putMarker(post.id, item.uploadId, { ...marker, state: "failed", code, at: new Date(now()).toISOString() });
      return { upload: item.uploadId, state: "skipped", reason: code };
    };
    try {
      await phase("reserve");
      const applied = await isApplied(handle);
      let copied;
      if (!applied) {
        try {
          copied = await copy(item, handle);
        } catch (e) {
          if (e instanceof HttpError && e.status >= 400 && e.status < 500) return await fail(e.code);
          throw e;
        }
      }
      await phase("copy");
      if (!applied) {
        const r = await applyPhase(post, item, handle, copied);
        if (r.fail) return await fail(r.fail);
      }
      await phase("apply");
      const done = { ...marker, state: "done", done_at: new Date(now()).toISOString() };
      delete done.code;
      await putMarker(post.id, item.uploadId, done);
      await phase("finalize");
      return { upload: item.uploadId, state: "done", media_handle: handle };
    } catch (e) {
      log.error?.("post graduate: photo left pending", logSafeError(e));
      return { upload: item.uploadId, state: "pending", code: e instanceof HttpError ? e.code : "error" };
    }
  }

  return {
    /**
     * Graduates the photos of a published post. Returns {state, photos: [{upload, state: done|skipped|pending, reason?, media_handle?, already?}]}; `state` is
     * "disabled" (switch off: nothing is read or written), "not_published", "unavailable" (store gate or ID policy: nothing written) or "ok".
     * A photo that failed on its own leaves the others alone.
     */
    async graduate(post) {
      if (enabled() !== true) return { state: "disabled", photos: [] };
      if (post?.visibility !== "published") return { state: "not_published", photos: [] };
      const items = plan(post, mediaPublicBase);
      const photos = items.filter((i) => i.skip).map((i) => ({ upload: i.uploadId, state: "skipped", reason: i.skip }));
      const todo = items.filter((i) => !i.skip);
      if (todo.length === 0) return { state: "ok", photos };
      if (!s3) return { state: "unavailable", code: "unavailable", photos };
      try {
        idPolicyMustMint();
        checkStoreGate(await getSyncHead(store), "post graduation"); // 503 store_not_seeded | sync_paused
      } catch (e) {
        log.error?.("post graduate: not attempted", logSafeError(e));
        return { state: "unavailable", code: e?.code ?? "unavailable", photos };
      }
      for (const item of todo) photos.push(await graduateOne(post, item));
      return { state: "ok", photos };
    },
  };
}
