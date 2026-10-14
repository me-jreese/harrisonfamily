// Graduating a comment photo into a record photo (HFY-TSK-214, hfy-graduate-api; BRD2 R-02, social.md section 10, SOC-D17).
//
//   POST /api/comments/:id/attachments/:aid/graduate   {subject, person, title?, description?}, admins only, behind graduateV1
//
// One admin action adds a photo that a member attached to a comment to a person's gallery: a Media object and a MediaRef on the Person,
// written through applyBatch() with origin "graduation" (validators, versions, audit and rendering as for every other writer). The
// action runs four phases under one idempotency key, `graduate:<comment id>:<attachment id>`. Each phase can be run again, so a retry
// after a failure anywhere completes the graduation exactly once:
//
//   1. reserve   The attachment's `graduated` marker becomes {state: "pending", media_handle: H, person, by, at, title?, description?}.
//                H is minted once and stored here; a retry resumes with it. The comment is written with a Put guarded by commentGuard()
//                (`edited_at` and `grad_v`), so an author's edit or a second admin's reserve cannot slide between the read and the write.
//                A marker already `done` for the same person is a 200; for another person it is 409 already_graduated; a pending one for
//                another person is 409 graduation_pending. A `failed` marker is reserved again, with the same H.
//   2. copy      CopyObject uploads/comments/<ulid>/<name> -> media/<H>.jpg with ChecksumAlgorithm SHA256. S3 computes the checksum and
//                returns it, so the Lambda never reads the bytes. Before it, the source is read once: it must be image/jpeg (422
//                unsupported_photo) and checkLocation() (the privacy guard on the stored bytes) must pass (400 photo_has_location). The
//                target key is a function of H, so a retry overwrites the same bytes. Skipped when the Media object already exists.
//   3. apply     applyBatch(origin "graduation", principal = the admin who reserved, key `graduate:...`): create Media H with a `blob`
//                descriptor {s3_key, sha256, size, content_type, state} and append MediaRef(H) to the Person. A version conflict re-reads
//                the person and retries once. Skipped when the Media head already exists (an earlier attempt committed).
//   4. finalize  ONE transaction: the marker becomes `done`, the AUDIT#<comment id> item (op "graduate") and the photo_to_record
//                contribution of the photo's AUTHOR (never the admin). Guarded by commentGuard(), so it commits once.
//   After the commit: `onGraduated` notifies the author (unless the admin is the author), then the marker's `notified` flag is set. A
//   retry of a `done` marker without the flag sends it, so a failure between the commit and the notice loses nothing. A crash between
//   the notice and the flag can send it twice; that is the price of never losing one.
//
// Failures (apply): a validation-class SyncError (400, 413, 422 and any other 4xx but a version conflict) marks the reservation `failed`
// {code, pointer} and answers 400 with the pointer, so the admin can correct the title and try again. A version conflict that survives the
// retry is 503 graduate_conflict. Everything else (503 store_not_seeded, sync_paused, retryable, unavailable, S3 failures) leaves the
// reservation pending and answers 503, so the same request resumes. Before any write the store gate runs: SYNC#HEAD absent or not
// seeded is 503 store_not_seeded (DL-09); the comment and the bucket are not touched.
//
// Not here (other tasks): the moderation state itself (hfy-moderation-api-core sets `moderation.hidden` on the comment or the attachment; this
// route only refuses when it is set), the UI (hfy-graduate-ui) and the desktop materializer of cloud-held media (hfy_sync addon).
import { CopyObjectCommand } from "@aws-sdk/client-s3";
import { HttpError, logSafeError } from "./http.js";
import { TxnCancelled, auditItem, transact } from "./txn.js";
import { contribOps, mergeOps } from "./contrib.js";
import { commentGuard } from "./comments.js";
import { pointer } from "./guard.js";
import { checkLocation, headUpload } from "./upload-guard.js";
import { mintHandle } from "./records/ops.js";
import { byGrampsId } from "./records/index.js";
import { applyBatch, checkStoreGate } from "./sync/apply.js";
import { R_MEDIA_PREFIX, finalKey, hexOfB64 } from "./sync/media.js";
import { getRecord, getRecordItem, getSyncHead } from "./sync/store.js";

export { R_MEDIA_PREFIX };
export const PHASES = Object.freeze(["reserve", "copy", "apply", "finalize"]);
export const SOURCE_TYPE = "image/jpeg";
export const MAX_TITLE = 200;
/** Media.desc is the title; a description is a Media attribute, whose value Gramps caps at 500 characters (design: 1000, narrowed to fit). */
export const MAX_DESCRIPTION = 500;
export const SOURCE_ATTRIBUTE = "hfy:source";
/** A pending reservation older than this shows "retry" in the UI (social.md section 10). The route itself resumes at any age. */
export const STALE_PENDING_MS = 15 * 60_000;

const SUBJECT_RE = /^(person:[A-Za-z0-9_.-]{1,64}|post:[0-9A-HJKMNP-TV-Z]{26})$/;
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const GRAMPS_ID_RE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}$/;
const CONTROL_RE = /\p{Cc}/u;
const CONFLICT_CODES = new Set(["conflict", "version_conflict", "exists"]);

/** The idempotency key of one comment photo: the same for every attempt and every admin. */
export const graduationKey = (commentId, aid) => `graduate:${commentId}:${aid}`;

const invalid = (field, message) => new HttpError(400, "validation", message, { fields: [{ field, code: "invalid" }] });
const notFound = (what) => new HttpError(404, "not_found", `no such ${what}`);
const unavailable = (code, message) => new HttpError(503, code, message);
const iso = (ms) => new Date(ms).toISOString();

/** How a failed applyBatch is answered: retry once (conflict), release the reservation (validation) or leave it pending (unavailable). */
export function classifySyncError(e) {
  const status = e?.status;
  const code = e?.code;
  if (CONFLICT_CODES.has(code)) return "conflict";
  if (code === "unavailable" || code === "retryable" || (typeof status === "number" && (status >= 500 || status === 428))) return "unavailable";
  if (code === "validation" || (typeof status === "number" && status >= 400 && status < 500)) return "validation";
  return "unavailable";
}

/** The pointer a validation refusal names, if any: SyncError.pointer, details.pointer, or the first violation's pointer (the Media object's). */
function pointerOf(e) {
  const p = e?.pointer ?? e?.details?.pointer ?? e?.details?.violations?.[0]?.pointer ?? e?.details?.fields?.[0]?.field;
  return typeof p === "string" && p.length <= 200 ? p : undefined;
}
/** The request field a Media pointer belongs to: /desc is the title, an attribute value is the description. */
const fieldOf = (ptr) => (ptr === undefined ? undefined : ptr === "/desc" || ptr === "desc" ? "title" : ptr.startsWith("/attribute_list") ? "description" : undefined);

const cleanText = (v) => (typeof v === "string" ? v.replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim() : "");

/** The request, shape-checked. Returns {subject, commentId, aid, person, title?, description?}. */
export function parseRequest(input) {
  const { subject, commentId, aid, person, title, description } = input ?? {};
  if (typeof subject !== "string" || !SUBJECT_RE.test(subject)) throw invalid("subject", "subject must be person:<gramps_id> or post:<ulid>");
  if (typeof commentId !== "string" || !ULID_RE.test(commentId)) throw notFound("comment");
  if (typeof aid !== "string" || !ULID_RE.test(aid)) throw notFound("photo");
  if (typeof person !== "string" || !GRAMPS_ID_RE.test(person)) throw invalid("person", "person must be a gramps_id");
  const text = (field, v, max) => {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "string") throw invalid(field, `${field} must be text`);
    if (CONTROL_RE.test(v)) throw invalid(field, `${field} has a control character`);
    const t = v.trim();
    if (t.length > max) throw invalid(field, `${field} exceeds ${max} characters`);
    return t === "" ? undefined : t;
  };
  return { subject, commentId, aid, person, title: text("title", title, MAX_TITLE), description: text("description", description, MAX_DESCRIPTION) };
}

const attribute = (string, value) => ({ _class: "Attribute", type: { _class: "AttributeType", value: 0, string }, value, private: false, citation_list: [], note_list: [] });
const descriptionAttribute = (value) => ({ _class: "Attribute", type: { _class: "AttributeType", value: 2, string: "" }, value, private: false, citation_list: [], note_list: [] });
const emptyDate = () => ({ _class: "Date", calendar: 0, dateval: [0, 0, 0, false], format: null, modifier: 0, newyear: 0, quality: 0, sortval: 0, text: "" });

/** The Media object of a graduation. gramps_id stays empty: applyBatch mints it under the cloud ID policy. */
export function mediaObject({ handle, desc, description, source, change }) {
  return {
    _class: "Media", handle, gramps_id: "", private: false, path: `${handle}.jpg`, mime: SOURCE_TYPE, desc, checksum: "",
    attribute_list: [attribute(SOURCE_ATTRIBUTE, source), ...(description ? [descriptionAttribute(description)] : [])],
    citation_list: [], note_list: [], tag_list: [], date: emptyDate(), change,
  };
}

/** The Person with MediaRef(handle) appended. A ref already there is kept once. */
export function personWithRef(obj, handle, change) {
  const list = Array.isArray(obj.media_list) ? obj.media_list : [];
  if (list.some((r) => r?.ref === handle)) return obj;
  const ref = { _class: "MediaRef", ref: handle, rect: null, private: false, attribute_list: [], citation_list: [], note_list: [] };
  return { ...obj, media_list: [...list, ref], change };
}

const personLabel = (obj) => {
  const first = obj?.primary_name?.first_name;
  const last = obj?.primary_name?.surname_list?.find((s) => s?.primary)?.surname ?? obj?.primary_name?.surname_list?.[0]?.surname;
  const label = [first, last].filter((x) => typeof x === "string" && x !== "").join(" ").trim();
  return label === "" ? undefined : label.slice(0, 120);
};

/**
 * Deps: `ddb`, `cmds`, `table`; `store` the applyBatch/record-store context (handler.build's `store`); `s3` + `bucket` (the media bucket: the
 * photo and media/ live in it); `apply` replaces applyBatch (tests); `notifier.onGraduated`; `guard` the R-18 check; `mint` replaces mintHandle;
 * `afterPhase(name)` is awaited after each of PHASES (the fault-injection seam of the tests: production passes none).
 */
export function createGraduation({ ddb, cmds, table, store, s3, bucket = "harrisonfamily-frontend", apply = applyBatch, notifier, guard, now = () => Date.now(), uid, mint = mintHandle, log = console, via = "ui", afterPhase }) {
  const ckey = (subject, id) => ({ PK: `THREAD#${subject}`, SK: `C#${id}` });
  const phase = async (name) => { if (afterPhase) await afterPhase(name); };

  async function loadComment(req) {
    const r = await ddb.send(new cmds.GetCommand({ TableName: table, Key: ckey(req.subject, req.commentId), ConsistentRead: true }));
    const comment = r.Item?.comment;
    if (!comment) throw notFound("comment");
    const i = Array.isArray(comment.attachments) ? comment.attachments.findIndex((a) => a?.id === req.aid) : -1;
    if (i < 0) throw notFound("photo");
    return { comment, i };
  }

  /** Writes `next` over `c` (a Put guarded by commentGuard) with `extra` transaction items in the same transaction. */
  async function commit(req, c, next, extra) {
    const put = { item: { ...ckey(req.subject, req.commentId), GSI1PK: "COMMENTS", GSI1SK: req.commentId, entity: "comment", comment: next }, ...commentGuard(c) };
    try {
      await transact(ddb, cmds, table, mergeOps({ puts: [put], deletes: [], updates: [], checks: [] }, extra), store.txnOpts);
    } catch (e) {
      if (e instanceof TxnCancelled && e.busy) throw unavailable("busy", "busy, try again");
      if (e instanceof TxnCancelled && e.conditionFailed) throw new HttpError(409, "conflict", "the comment changed concurrently. try again.");
      if (e instanceof TxnCancelled) throw unavailable("unavailable", "the store is unavailable, try again");
      throw e;
    }
  }
  const withMarker = (c, i, graduated) => ({ ...c, grad_v: (c.grad_v ?? 0) + 1, attachments: c.attachments.map((a, j) => (j === i ? { ...a, graduated } : a)) });
  const markerOf = (c, i) => c.attachments[i].graduated;

  async function resolvePerson(gid) {
    const hits = await byGrampsId(store, "Person", gid);
    if (hits.length !== 1) return null; // none (or a tombstone): not found; two live holders of one id: ambiguous, also refused
    const head = await getRecord(store, "Person", hits[0].handle);
    return head && !head.deleted && head.obj ? { handle: head.handle, version: head.version, obj: head.obj } : null;
  }
  const personMissing = () => new HttpError(404, "person_not_found", "no such person");

  async function mediaGrampsId(handle) {
    try {
      const head = await getRecord(store, "Media", handle);
      return head && !head.deleted && head.gramps_id ? head.gramps_id : undefined;
    } catch (e) {
      log.error?.("graduate: media id lookup failed", logSafeError(e));
      return undefined;
    }
  }
  const bodyOf = async (g) => {
    const gid = await mediaGrampsId(g.media_handle);
    return { media: { handle: g.media_handle, ...(gid ? { gramps_id: gid } : {}) }, person: g.person, state: "done" };
  };

  // ---- 1. reserve ------------------------------------------------------------------------------------------------------
  async function reserve(req, actor, found) {
    const { comment, i } = found;
    const g = markerOf(comment, i);
    if (g?.state === "pending") return { comment, i, marker: g }; // a retry continues with the stored handle, title and admin
    const marker = {
      state: "pending", media_handle: g?.media_handle ?? mint({ now }), person: req.person, by: { id: actor.id, label: actor.label }, at: iso(now()),
      ...(req.title !== undefined ? { title: req.title } : {}), ...(req.description !== undefined ? { description: req.description } : {}),
    };
    const next = withMarker(comment, i, marker);
    await commit(req, comment, next);
    return { comment: next, i, marker };
  }

  // ---- 2. copy ---------------------------------------------------------------------------------------------------------
  /** Releases the reservation of a refusal that a retry cannot cure as it stands (the photo or the title is wrong). Best effort: the refusal is answered anyway. */
  async function release(req, handle, failure) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const { comment, i } = await loadComment(req);
        const g = markerOf(comment, i);
        if (g?.state !== "pending" || g.media_handle !== handle) return;
        const { title: _t, description: _d, ...keep } = g;
        await commit(req, comment, withMarker(comment, i, { ...keep, state: "failed", code: failure.code, ...(failure.pointer ? { pointer: failure.pointer } : {}) }));
        return;
      } catch (e) {
        if (!(e instanceof HttpError && e.status === 409)) {
          log.error?.("graduate: could not release the reservation", logSafeError(e));
          return;
        }
      }
    }
  }

  async function copy(req, res, source) {
    const { media_handle: handle } = res.marker;
    const key = source.url.replace(/^\//, "");
    if (!/^uploads\/comments\/[0-9A-HJKMNP-TV-Z]{26}\/[a-z0-9][a-z0-9._-]{0,80}$/.test(key)) {
      await release(req, handle, { code: "unsupported_photo" });
      throw new HttpError(422, "unsupported_photo", "that photo can't be added to a family page.");
    }
    let size;
    try {
      const head = await headUpload(bucket, key, { s3 });
      if (head.contentType !== SOURCE_TYPE) throw new HttpError(422, "unsupported_photo", "only a jpeg photo can be added to a family page.");
      size = head.size;
      await checkLocation(bucket, key, { s3 }); // 400 photo_has_location | upload_missing, 503 unavailable
    } catch (e) {
      if (e instanceof HttpError && e.status >= 400 && e.status < 500) await release(req, handle, { code: e.code });
      throw e;
    }
    let out;
    try {
      out = await s3.send(new CopyObjectCommand({ Bucket: bucket, Key: finalKey(handle, SOURCE_TYPE), CopySource: `${bucket}/${key}`, ChecksumAlgorithm: "SHA256" }));
    } catch (e) {
      log.error?.("graduate: copy failed", logSafeError(e));
      throw unavailable("graduate_copy_failed", "couldn't add it to the page right now. try again in a minute.");
    }
    const b64 = out?.CopyObjectResult?.ChecksumSHA256;
    if (typeof b64 !== "string" || b64 === "") throw unavailable("graduate_copy_failed", "couldn't add it to the page right now. try again in a minute.");
    return { sha256: hexOfB64(b64), size: typeof size === "number" && size > 0 ? size : undefined };
  }

  // ---- 3. apply --------------------------------------------------------------------------------------------------------
  const isApplied = async (handle) => (await getRecordItem(store, "Media", handle)) !== undefined;

  async function applyPhase(req, res, source, copied) {
    const { media_handle: handle, by } = res.marker;
    const key = graduationKey(req.commentId, req.aid);
    for (let attempt = 0; ; attempt += 1) {
      if (await isApplied(handle)) return; // an earlier attempt committed (its receipt or the head says so)
      const person = await resolvePerson(res.marker.person);
      if (!person) {
        await release(req, handle, { code: "person_not_found" });
        throw personMissing();
      }
      const change = Math.floor(now() / 1000);
      const desc = res.marker.title ?? (cleanText(source.alt) || "");
      const media = mediaObject({ handle, desc, description: res.marker.description, source: `comment-photo:${req.subject}/${req.commentId}/${req.aid}`, change });
      const blob = { s3_key: finalKey(handle, SOURCE_TYPE), sha256: copied.sha256, ...(copied.size !== undefined ? { size: copied.size } : {}), content_type: SOURCE_TYPE, state: "present" };
      const ops = [
        { op_id: "1", op: "create", class: "Media", handle, base_version: null, obj: media, blob },
        { op_id: "2", op: "update", class: "Person", handle: person.handle, base_version: person.version, obj: personWithRef(person.obj, handle, change) },
      ];
      try {
        await apply(store, { principal: by.id, origin: "graduation", idempotencyKey: key, ops });
        return;
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        const kind = classifySyncError(e);
        if (kind === "conflict" && attempt === 0) continue; // re-read the person and try once more: an append commutes
        if (kind === "conflict") throw unavailable("graduate_conflict", "couldn't add it to the page right now. try again in a minute.");
        if (kind === "validation") {
          const ptr = pointerOf(e);
          await release(req, handle, { code: typeof e.code === "string" ? e.code.slice(0, 64) : "validation", pointer: ptr });
          const field = fieldOf(ptr);
          throw new HttpError(400, "validation", "that photo can't be added to the page as it is. check the title and the description.", { ...(ptr ? { pointer: ptr } : {}), ...(field ? { field } : {}), ...(e.details?.violations ? { violations: e.details.violations } : {}) });
        }
        log.error?.("graduate: apply unavailable", logSafeError(e));
        throw unavailable("sync_unavailable", "couldn't add it to the page right now. try again in a minute.");
      }
    }
  }

  // ---- 4. finalize -----------------------------------------------------------------------------------------------------
  async function finalize(req, res) {
    const { comment, i } = await loadComment(req);
    const g = markerOf(comment, i);
    if (g?.state === "done" && g.media_handle === res.marker.media_handle) return g; // another request finished it
    if (g?.state !== "pending" || g.media_handle !== res.marker.media_handle) throw new HttpError(409, "conflict", "the comment changed concurrently. try again.");
    const at = iso(now());
    const { title: _t, description: _d, ...keep } = g;
    const done = { ...keep, state: "done", done_at: at };
    const credit = contribOps({
      actor: { id: comment.author.id, label: comment.author.label }, kind: "photo_to_record", ref: { type: "media", id: g.media_handle }, subject: `person:${g.person}`, at, via, uid,
    });
    const next = withMarker(comment, i, done);
    const audit = { item: auditItem({ op: "graduate", id: req.commentId, principalId: g.by.id, at, before: { attachment: req.aid, graduated: g }, after: { attachment: req.aid, graduated: done } }, uid(), table) };
    await commit(req, comment, next, { puts: [audit, ...credit.puts], deletes: credit.deletes, updates: credit.updates, checks: credit.checks });
    return done;
  }

  /** Sends the author's notice if it was not sent, then sets the flag. A failure is logged: the committed graduation is already a success. */
  async function noticeOnce(req) {
    try {
      const { comment, i } = await loadComment(req);
      const g = markerOf(comment, i);
      if (g?.state !== "done" || g.notified === true) return;
      if (notifier?.onGraduated && comment.author.id !== g.by.id) {
        const person = await resolvePerson(g.person).catch(() => null);
        await notifier.onGraduated({ photo: { authorId: comment.author.id }, subject: `person:${g.person}`, ...(person ? { subjectLabel: personLabel(person.obj) } : {}), by: g.by });
      }
      await commit(req, comment, withMarker(comment, i, { ...g, notified: true }));
    } catch (e) {
      log.error?.("graduate: notification step failed (the graduation is committed)", logSafeError(e));
    }
  }

  return {
    /**
     * Runs the graduation. Returns {status, body}: 201 {media: {handle, gramps_id?}, person, state: "done"} for a graduation this call completed, 200 with
     * the same body for one that was already done for the same person.
     */
    async graduate(actor, input) {
      if (actor?.admin !== true) throw new HttpError(403, "not_admin", "only an admin can add a photo to a family page");
      const req = parseRequest(input);
      guard?.("graduate", "create", [[pointer("title"), req.title], [pointer("description"), req.description]]); // R-18: 422 contact_info, nothing written
      if (!s3) throw unavailable("unavailable", "photos are not configured");
      checkStoreGate(await getSyncHead(store), "graduation"); // 503 store_not_seeded | sync_paused: no write, no copy

      const found = await loadComment(req);
      const source = found.comment.attachments[found.i];
      if (found.comment.moderation?.hidden === true || source.moderation?.hidden === true) throw new HttpError(409, "moderated", "that photo or its comment is hidden by a moderator.");
      const g = source.graduated;
      if (g?.state === "done") {
        if (g.person !== req.person) throw new HttpError(409, "already_graduated", "this photo is already on another page.", { person: g.person });
        await noticeOnce(req);
        return { status: 200, body: await bodyOf(g) };
      }
      if (g?.state === "pending" && g.person !== req.person) throw new HttpError(409, "graduation_pending", "this photo is being added to another page.", { person: g.person });
      if (!(await resolvePerson(req.person))) throw personMissing(); // before the reservation, so a mistyped id leaves nothing behind

      const res = await reserve(req, actor, found);
      await phase("reserve");
      const applied = await isApplied(res.marker.media_handle);
      const copied = applied ? undefined : await copy(req, res, source);
      await phase("copy");
      if (!applied) await applyPhase(req, res, source, copied);
      await phase("apply");
      const done = await finalize(req, res);
      await phase("finalize");
      await noticeOnce(req);
      return { status: 201, body: await bodyOf(done) };
    },
  };
}
