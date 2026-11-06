// Member web uploads: a portrait and a new media item (HFY-TSK-388-0A; BRD D-05, D-06, D-09, D-11, D-12, D-34; rulings P4-R26, P4-R25).
//
//   POST /api/uploads            purpose portrait | item (uploads.js): the presign into the pending prefix (uploads/posts/<ulid>/photo.jpg, 24 h binding).
//   POST /api/media/uploads      commit {items: [{uploadId, purpose, subject, title?, year?, about?, description?}]}: each upload graduates to Gramps Media
//                                 (R-18 guard over the bytes, then copy, then one applyBatch) carrying the Tag `hfy-web-upload` and the two Media Attributes
//                                 hfy:source=upload and hfy:added-by=<uploader> (media-origin.js). Purpose item then appends a MediaRef to the subject (D-05).
//   POST /api/media/portrait     {personId, mediaId, crop}: ONE submission that adds the MediaRef with the crop region (a full-frame crop stores null) and
//                                 moves it to index 0 (the named portrait op of D-05). The previous portrait keeps its place behind it (D-11).
//
// Own record direct, another person's by proposal (D-09): both MediaRef writes take the POST /api/changes pipeline (planChanges, commit), whose field policy
// already routes `Person /media_list/**` direct on the member's own record and to review on anyone else's, with the R-18/R-19 guard, the Gramps schema and the
// idempotency receipt. The Media itself is created at commit in either case; it has no MediaRef until the write or the approval, so the Media Browser does not
// list it (P4-R21). Nothing here deletes anything.
//
// Behind the feature gate (features.js): commit decides by purpose (an item needs mediaAddV1, a portrait portraitV1; the route gate is either flag), the portrait route needs portraitV1, and the portrait and item presign purposes follow the same two
// (404 while off, uat principals honoured), read from the deployed flags.json; no environment switch. A member session is required. Idempotent: one marker item per upload,
// PK `WEBUP#<upload id>`, SK `MEDIA`, whose handle is minted once; applyBatch runs under the key `webupload:<upload id>`; the MediaRef writes carry a key built
// from the record version they read, so a retry after success finds the ref and writes nothing, and a retry of a proposal replays its receipt.
import { createHash } from "node:crypto";
import { CopyObjectCommand } from "@aws-sdk/client-s3";
import { SOURCE_TYPE, classifySyncError, mediaObject } from "./graduate.js";
import { HttpError, logSafeError } from "./http.js";
import { SOURCE_UPLOAD } from "./media-origin.js";
import { byGrampsId, storeView } from "./records/index.js";
import { commit, planChanges, readIdem, replayOf, requestHashOf } from "./records/changes.js";
import { yearDate } from "./records/life-dates.js";
import { createRecordGuard } from "./records/guard.js";
import { validateNewRect } from "./rect.js";
import { keySegment, mintHandle, validateOps } from "./records/ops.js";
import { applyBatch, checkStoreGate } from "./sync/apply.js";
import { policyOf } from "./sync/id-policy.js";
import { finalKey, hexOfB64 } from "./sync/media.js";
import { getRecord, getRecordItem, getSyncHead } from "./sync/store.js";
import { TxnCancelled, transact } from "./txn.js";
import { checkLocation, headUpload } from "./upload-guard.js";
import { MAX_UPLOAD_BYTES, UPLOAD_PREFIX, UPLOAD_PURPOSE_ITEM, UPLOAD_PURPOSE_PORTRAIT, uploadKeys } from "./uploads.js";

export const WEB_UPLOAD_TAG = "hfy-web-upload";
/** The handle a created hfy-web-upload Tag gets: a function of the name, so two writers that both create it collide instead of making two Tags. */
export const WEB_UPLOAD_TAG_HANDLE = createHash("sha256").update(`hfy-tag:${WEB_UPLOAD_TAG}`).digest("hex").slice(0, 24);
export const MAX_ITEMS = 10;
export const MIN_YEAR = 1600;
export const MAX_TITLE = 200;
export const MAX_DESCRIPTION = 500;
export const PURPOSES = Object.freeze([UPLOAD_PURPOSE_PORTRAIT, UPLOAD_PURPOSE_ITEM]);

export const webUploadKey = (uploadId) => `webupload:${uploadId}`;
export const markerKey = (uploadId) => ({ PK: `WEBUP#${uploadId}`, SK: "MEDIA" });

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const GRAMPS_ID_RE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}$/;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const invalid = (field, message) => new HttpError(400, "validation", message, { fields: [{ field, code: "invalid" }] });
const notFound = (what) => new HttpError(404, "not_found", `no such ${what}`);
const unavailable = (code, message) => new HttpError(503, code, message);
const clean = (v) => (typeof v === "string" ? v.replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim() : "");

/** One commit row, shape-checked. A year is four digits 1600..current year (D-25); `about` needs a year. */
export function parseItem(raw, currentYear = new Date().getUTCFullYear()) {
  if (!isObj(raw)) throw invalid("items", "each item is an object");
  const { uploadId, purpose, subject, year, about } = raw;
  if (typeof uploadId !== "string" || !ULID_RE.test(uploadId)) throw invalid("uploadId", "uploadId is the id the presign returned");
  if (!PURPOSES.includes(purpose)) throw invalid("purpose", "purpose is portrait or item");
  if (typeof subject !== "string" || !GRAMPS_ID_RE.test(subject)) throw invalid("subject", "subject is a person's gramps_id");
  const title = clean(raw.title);
  if (purpose === UPLOAD_PURPOSE_ITEM && title === "") throw invalid("title", "a photo needs a title");
  if (title.length > MAX_TITLE) throw invalid("title", `title is at most ${MAX_TITLE} characters`);
  const description = clean(raw.description);
  if (description.length > MAX_DESCRIPTION) throw invalid("description", `description is at most ${MAX_DESCRIPTION} characters`);
  if (year !== undefined && year !== null && !(Number.isInteger(year) && year >= MIN_YEAR && year <= currentYear)) throw invalid("year", `year is a whole year from ${MIN_YEAR} to ${currentYear}`);
  if (about !== undefined && typeof about !== "boolean") throw invalid("about", "about is true or false");
  const hasYear = Number.isInteger(year);
  return { uploadId, purpose, subject, title, description, ...(hasYear ? { year, about: about === true } : {}) };
}

/** A crop as the HFY rect unit stores it: null for the full frame; else whole percents on the 0..100 grid, ordered, at least 2 x 2 units (validateNewRect, D-07). Anything else is 400 validation carrying the rect code. */
export function cropToRect(crop) {
  if (crop === null) return null;
  const v = validateNewRect(crop);
  if (!v.ok) throw new HttpError(400, "validation", `the crop is not a usable rectangle (${v.code})`, { fields: [{ field: "crop", code: v.code }] });
  return v.rect;
}
const sameRect = (a, b) => (a ?? null) === (b ?? null) || (Array.isArray(a) && Array.isArray(b) && a.length === 4 && a.every((v, i) => v === b[i]));
const mediaRef = (handle, rect) => ({ _class: "MediaRef", ref: handle, rect, private: false, attribute_list: [], citation_list: [], note_list: [] });
const tagObject = (handle, change) => ({ _class: "Tag", handle, name: WEB_UPLOAD_TAG, color: "#000000000000", priority: 0, change });

/**
 * Deps: `ddb`, `cmds`, `table`; `store` (handler.build's `store`); `s3` + `bucket`; `apply` replaces applyBatch (tests); `mint`; `now`;
 * `afterPhase(name)` (fault injection in tests; production passes none).
 */
export function createWebUpload({ ddb, cmds, table, store, s3, bucket = "harrisonfamily-frontend", apply = applyBatch, now = () => Date.now(), mint = mintHandle, log = console, afterPhase }) {
  const phase = async (name) => { if (afterPhase) await afterPhase(name); };
  const getMarker = async (uploadId) => (await ddb.send(new cmds.GetCommand({ TableName: table, Key: markerKey(uploadId), ConsistentRead: true }))).Item;
  async function putMarker(uploadId, m, { create = false } = {}) {
    const item = { ...markerKey(uploadId), entity: "webupload", ...m };
    try {
      await transact(ddb, cmds, table, { puts: [{ item, ...(create ? { condition: "attribute_not_exists(PK)" } : {}) }], deletes: [], updates: [], checks: [] }, store.txnOpts);
      return true;
    } catch (e) {
      if (create && e instanceof TxnCancelled && e.conditionFailed) return false;
      throw e;
    }
  }
  const isApplied = async (handle) => (await getRecordItem(store, "Media", handle)) !== undefined;

  function idPolicyMustMint() {
    let mode;
    try { mode = policyOf(store).mode; } catch (e) { log.error?.("web upload: id policy unreadable", logSafeError(e)); }
    if (mode !== "mint") throw unavailable("id_policy_not_mint", "adding photos to family pages is not set up yet");
  }
  async function loadPerson(gid) {
    const hits = await byGrampsId(store, "Person", gid);
    if (hits.length !== 1) throw notFound("person");
    const head = await getRecord(store, "Person", hits[0].handle);
    if (!head || head.deleted || !head.obj) throw notFound("person");
    return { handle: head.handle, version: head.version, obj: head.obj };
  }
  async function tagFor() {
    const det = await getRecord(store, "Tag", WEB_UPLOAD_TAG_HANDLE);
    if (det && !det.deleted && det.obj) return { handle: WEB_UPLOAD_TAG_HANDLE, create: false };
    const view = await storeView(store);
    for (const h of view.live()) if (h.class === "Tag" && h.obj?.name === WEB_UPLOAD_TAG) return { handle: h.handle, create: false };
    return { handle: WEB_UPLOAD_TAG_HANDLE, create: true };
  }

  /** The member's own, unexpired upload of this purpose and subject. 404 for anyone else's or an unknown id (nothing leaks). */
  async function binding(actor, it) {
    const up = (await ddb.send(new cmds.GetCommand({ TableName: table, Key: uploadKeys(it.uploadId), ConsistentRead: true }))).Item;
    if (!up || up.owner !== actor.id || typeof up.key !== "string" || !up.key.startsWith(`${UPLOAD_PREFIX}/`)) throw notFound("upload");
    if (up.purpose !== it.purpose) throw invalid("purpose", "this upload was made for another purpose");
    if (up.subject !== it.subject) throw invalid("subject", "this upload was made for another person");
    return up;
  }

  async function copy(key, handle) {
    const head = await headUpload(bucket, key, { s3 });
    if (head.contentType !== SOURCE_TYPE) throw new HttpError(422, "unsupported_type", "only a jpeg photo can be added to a family page.");
    if (typeof head.size === "number" && head.size > MAX_UPLOAD_BYTES) throw new HttpError(422, "too_large", "the photo is larger than 10 MB.");
    await checkLocation(bucket, key, { s3 }); // 400 photo_has_location | upload_missing, 503 unavailable (the R-18 guard over the bytes)
    if (typeof head.etag !== "string") throw unavailable("graduate_copy_failed", "no etag");
    let out;
    try {
      out = await s3.send(new CopyObjectCommand({ Bucket: bucket, Key: finalKey(handle, SOURCE_TYPE), CopySource: `${bucket}/${key}`, CopySourceIfMatch: head.etag, ChecksumAlgorithm: "SHA256" }));
    } catch (e) {
      log.error?.("web upload: copy failed", logSafeError(e));
      throw unavailable(e?.$metadata?.httpStatusCode === 412 ? "graduate_source_changed" : "graduate_copy_failed", "copy failed");
    }
    const b64 = out?.CopyObjectResult?.ChecksumSHA256;
    if (typeof b64 !== "string" || b64 === "") throw unavailable("graduate_copy_failed", "no checksum");
    return { sha256: hexOfB64(b64), size: typeof head.size === "number" && head.size > 0 ? head.size : undefined };
  }

  async function applyPhase(actor, it, handle, copied) {
    for (let attempt = 0; ; attempt += 1) {
      if (await isApplied(handle)) return;
      const tag = await tagFor();
      const change = Math.floor(now() / 1000);
      let media = { ...mediaObject({ handle, desc: it.title, description: it.description, source: SOURCE_UPLOAD, addedBy: actor.id, change }), tag_list: [tag.handle] };
      if (it.year !== undefined) media = { ...media, date: yearDate(it.year, it.about === true) };
      const blob = { s3_key: finalKey(handle, SOURCE_TYPE), sha256: copied.sha256, ...(copied.size !== undefined ? { size: copied.size } : {}), content_type: SOURCE_TYPE, state: "present" };
      const ops = [];
      if (tag.create) ops.push({ op_id: "1", op: "create", class: "Tag", handle: tag.handle, base_version: null, obj: tagObject(tag.handle, change) });
      ops.push({ op_id: String(ops.length + 1), op: "create", class: "Media", handle, base_version: null, obj: media, blob });
      try {
        await apply(store, { principal: actor.id, origin: "graduation", idempotencyKey: webUploadKey(it.uploadId), ops });
        return;
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        const kind = classifySyncError(e);
        if (kind === "conflict" && attempt < 2) continue; // the Tag was created by another writer meanwhile: read it and try again
        if (kind === "validation") throw new HttpError(e.status >= 400 && e.status < 500 ? e.status : 400, typeof e.code === "string" ? e.code.slice(0, 64) : "validation", "the photo could not be added", e.details);
        log.error?.("web upload: apply unavailable", logSafeError(e));
        throw unavailable("sync_unavailable", "unavailable");
      }
    }
  }

  /** Graduates one upload to a Media (once). Returns {handle, mediaId}. */
  async function graduate(actor, it, up) {
    let marker = await getMarker(it.uploadId);
    if (!marker) {
      const fresh = { state: "pending", media_handle: mint({ now }), person: actor.id, purpose: it.purpose, at: new Date(now()).toISOString() };
      marker = (await putMarker(it.uploadId, fresh, { create: true })) ? fresh : await getMarker(it.uploadId); // a lost race continues with the winner's handle
    }
    const handle = marker.media_handle;
    if (!(await isApplied(handle))) {
      idPolicyMustMint();
      checkStoreGate(await getSyncHead(store), "web upload"); // 503 store_not_seeded | sync_paused
      await phase("reserve");
      const copied = await copy(up.key, handle);
      await phase("copy");
      await applyPhase(actor, it, handle, copied);
      await phase("apply");
    }
    if (marker.state !== "done") await putMarker(it.uploadId, { ...marker, state: "done", done_at: new Date(now()).toISOString() });
    await phase("finalize");
    const head = await getRecord(store, "Media", handle);
    return { handle, mediaId: head?.obj?.gramps_id };
  }

  /** The POST /api/changes pipeline for one Person write: direct on the member's own record, a proposal on anyone else's. Returns {proposal, applied}. */
  async function submit(c, { person, ops, key, note }) {
    const ctx = c.store;
    const target = `Person:${person.handle}`;
    const req = { target, base_versions: { [target]: person.version }, ops: ops.map((o) => ({ ...o, obj: target })), note, route: "auto", dry_run: false, key };
    const problems = validateOps(req.ops);
    if (problems.length) throw invalid("ops", "the photo could not be added to the page");
    const nowMs = ctx.now();
    const receipt = await readIdem(ctx, c.actor.id, key);
    const out = receipt
      ? replayOf(receipt, requestHashOf(req))
      : await commit(c, req, await planChanges(c, req, nowMs, createRecordGuard({ dob: ctx.guardDob === true, log: ctx.log })), nowMs);
    return { proposal: out?.body?.proposal ?? null, applied: out?.body?.applied ?? null };
  }

  return {
    /** The commit step for each item, in order. A refusal stops at that item; a retry resumes (everything before it is already done). */
    async commit(c, input) {
      const { actor } = c;
      const rows = input?.items;
      if (!Array.isArray(rows) || rows.length === 0 || rows.length > MAX_ITEMS) throw invalid("items", `items is a list of 1 to ${MAX_ITEMS} uploads`);
      const items = rows.map((r) => parseItem(r));
      if (new Set(items.map((i) => i.uploadId)).size !== items.length) throw invalid("items", "an upload appears once");
      const out = [];
      for (const it of items) {
        const up = await binding(actor, it);
        await loadPerson(it.subject); // 404 before anything is graduated
        const { handle, mediaId } = await graduate(actor, it, up);
        if (it.purpose === UPLOAD_PURPOSE_PORTRAIT) { out.push({ uploadId: it.uploadId, mediaId, purpose: it.purpose, state: "graduated" }); continue; }
        const mine = await loadPerson(it.subject); // re-read: the graduation can take a while
        if ((mine.obj.media_list ?? []).some((r) => r?.ref === handle)) { out.push({ uploadId: it.uploadId, mediaId, purpose: it.purpose, state: "applied" }); continue; }
        const res = await submit(c, {
          person: mine, ops: [{ id: "item.add", op: "add", path: "/media_list", value: mediaRef(handle, null) }],
          key: `webupload-item:${it.uploadId}:${mine.version}`, note: "A photo added from the website.",
        });
        out.push({ uploadId: it.uploadId, mediaId, purpose: it.purpose, state: res.proposal ? "pending-proposal" : "applied", ...(res.proposal ? { proposal: res.proposal.id } : {}) });
      }
      return { items: out };
    },

    /** Sets the portrait: one submission, add the MediaRef with the crop and move it to index 0 (D-05, D-11). Returns {state, tags}. */
    async portrait(c, input) {
      const { personId, mediaId, crop } = input ?? {};
      if (typeof personId !== "string" || !GRAMPS_ID_RE.test(personId)) throw invalid("personId", "personId is a person's gramps_id");
      if (typeof mediaId !== "string" || !GRAMPS_ID_RE.test(mediaId)) throw invalid("mediaId", "mediaId is a photo's gramps_id");
      if (crop === undefined) throw invalid("crop", "crop is required (null for the whole photo)");
      const rect = cropToRect(crop);
      const person = await loadPerson(personId);
      const hits = await byGrampsId(store, "Media", mediaId);
      const mhead = hits.length === 1 ? await getRecord(store, "Media", hits[0].handle) : null;
      if (!mhead || mhead.deleted || !mhead.obj || mhead.obj.private === true) throw notFound("photo");
      const handle = mhead.handle;
      const list = Array.isArray(person.obj.media_list) ? person.obj.media_list : [];
      const at = list.findIndex((r) => r?.ref === handle && sameRect(r.rect ?? null, rect));
      const tags = (state) => ({ state, tags: [{ personId, mediaId, rect, index: 0, state: state === "pending-proposal" ? "pending-proposal" : "applied" }] });
      if (at === 0) return tags("applied"); // already the portrait: nothing to write
      const ops = [];
      // A new MediaRef is inserted before the current first one (an anchored add: the engine addresses elements by the state at the start of the call, so a move of an
      // element added in the same call has no key yet); a MediaRef already on the page is moved to the front. Either way it ends at index 0 in this one submission.
      if (at < 0) ops.push({ id: "portrait.add", op: "add", path: "/media_list", value: mediaRef(handle, rect), ...(list.length > 0 ? { before: keySegment("media_list", list, 0) } : {}) });
      else ops.push({ id: "portrait.move", op: "move", path: `/media_list/${keySegment("media_list", list, at)}`, before: keySegment("media_list", list, 0) });
      const key = `webupload-portrait:${person.handle}:${handle}:${rect ? rect.join(",") : "full"}:${person.version}`;
      const res = await submit(c, { person, ops, key, note: "A portrait photo set from the website." });
      return { ...tags(res.proposal ? "pending-proposal" : "applied"), ...(res.proposal ? { proposal: res.proposal.id } : {}) };
    },
  };
}
