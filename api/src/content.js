// ContentSource over the hfy-app table. Implements the @io-kit/content contract (CS suite) with D-15 audit
// items written in the same TransactWriteItems call as the data change.
import { ContentError, POST_TYPES, VISIBILITIES, auditEntry, canView, computeCan, withCan, DEFAULT_LIMIT, MAX_LIMIT } from "@io-kit/content";
import { HttpError } from "./http.js";
import { postKeys, gsiPosts, gsiAuthor, gsiSubject } from "./keys.js";
import { TxnCancelled, auditItem, transact, queryPartition, versionGuard } from "./txn.js";
import { IMAGE_TYPES, UPLOAD_PREFIX, UPLOAD_PURPOSE_POST, uploadKeys } from "./uploads.js";
import { createGuard, pointer } from "./guard.js";

const hash = (s) => {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16);
};
const filterId = (f) => hash(JSON.stringify([f?.subject ?? null, f?.type ?? null, f?.author ?? null, f?.visibility ?? null]));

const MAX_BODY = 20_000; // keeps post item x3 + audit before/after well under the 400KB item limit
export const MAX_TITLE = 200;
export const MAX_ATTACHMENTS = 10;
export const MAX_ALT = 500;
/** Serialized post cap: the audit item carries before + after, so 2x this stays well under DynamoDB's 400 KB item limit. */
export const MAX_POST_BYTES = 100_000;
/** A record id the post is about: a bare gramps id (I0044), `person:<id>`, `post:<ulid>`, or another plain identifier. */
export const POST_SUBJECT_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const ULID_RE = "[0-9A-HJKMNP-TV-Z]{26}";
const UPLOAD_PATH_RE = new RegExp(`^/${UPLOAD_PREFIX}/${ULID_RE}/[a-z0-9][a-z0-9._-]{0,80}$`);
const MIME_RE = /^[a-z]+\/[a-z0-9][a-z0-9.+-]{0,99}$/i;
const invalid = (field, message) => new ContentError("validation", message, { field });
const isDim = (v) => Number.isInteger(v) && v > 0 && v <= 100_000;
/** "/uploads/posts/<ulid>/<name>" for an attachment url normalizeAttachments accepted (absolute on mediaPublicBase, or relative). */
const uploadPath = (url, base) => (base && url.startsWith(`${base}/`) ? url.slice(base.length) : url);
const notOwned = () => new HttpError(403, "upload_not_owned", "that photo can't be attached here. add it again.");
const notUploaded = () => new HttpError(400, "upload_missing", "that photo didn't finish uploading. add it again.");

/** R-18 free-text fields of a post: body, title and every attachment alt, as [pointer, text] (src/guard.js). */
export const postTextFields = (p, { body = true, title = true, attachments = true } = {}) => [
  ...(body ? [[pointer("body"), p.body]] : []),
  ...(title ? [[pointer("title"), p.title]] : []),
  ...(attachments ? (p.attachments ?? []).map((a, i) => [pointer("attachments", i, "alt"), a.alt]) : []),
];

/**
 * Attachments may only reference this site's member uploads (`<mediaPublicBase>/uploads/posts/<ulid>/<name>` or the same
 * path relative), so a post can neither break the timeline renderer nor pull images from third-party hosts.
 * Returns a normalized copy holding only the known Attachment fields.
 */
export function normalizeAttachments(raw, mediaPublicBase) {
  if (!Array.isArray(raw)) throw invalid("attachments", "attachments must be an array");
  if (raw.length > MAX_ATTACHMENTS) throw invalid("attachments", `at most ${MAX_ATTACHMENTS} attachments`);
  const base = String(mediaPublicBase ?? "").replace(/\/+$/, "");
  return raw.map((a) => {
    if (a === null || typeof a !== "object" || Array.isArray(a)) throw invalid("attachments", "each attachment must be an object");
    if (a.kind !== "image" && a.kind !== "file") throw invalid("attachments", "attachment kind must be image or file");
    if (typeof a.url !== "string" || a.url.length > 2048) throw invalid("attachments", "attachment url is required");
    const path = base && a.url.startsWith(`${base}/`) ? a.url.slice(base.length) : a.url;
    if (!UPLOAD_PATH_RE.test(path)) throw invalid("attachments", "attachment url must be a member upload");
    if (typeof a.mime !== "string" || !MIME_RE.test(a.mime)) throw invalid("attachments", "attachment mime is required");
    if (a.kind === "image" && !Object.hasOwn(IMAGE_TYPES, a.mime)) throw invalid("attachments", "image attachments must be jpeg, png, webp or heic");
    if (a.alt !== undefined && a.alt !== null && (typeof a.alt !== "string" || a.alt.length > MAX_ALT)) throw invalid("attachments", `alt text must be a string of at most ${MAX_ALT} characters`);
    for (const k of ["width", "height"]) if (a[k] !== undefined && a[k] !== null && !isDim(a[k])) throw invalid("attachments", `attachment ${k} must be a positive integer`);
    return {
      kind: a.kind, url: a.url, mime: a.mime,
      ...(isDim(a.width) ? { width: a.width } : {}),
      ...(isDim(a.height) ? { height: a.height } : {}),
      ...(typeof a.alt === "string" ? { alt: a.alt } : {}),
    };
  });
}
function checkTitle(v) {
  if (typeof v !== "string" || v.length > MAX_TITLE) throw invalid("title", `title must be a string of at most ${MAX_TITLE} characters`);
  return v;
}
function checkSubject(v) {
  if (typeof v !== "string" || !POST_SUBJECT_RE.test(v)) throw invalid("subject", "subject must be a record id");
  return v;
}
function checkSize(post) {
  if (Buffer.byteLength(JSON.stringify(post), "utf8") > MAX_POST_BYTES) throw invalid("body", "post is too large");
}

/**
 * `guard` is src/guard.js createGuard() (the R-18 check on body, title and alt; contact kinds only unless the DOB switch is on).
 * `checkUpload(key)` is upload-guard.js checkLocation bound to the media bucket: it resolves `{contentType}` or throws 400
 * photo_has_location / upload_missing. Without it, a post cannot take a new attachment (fail closed).
 */
export function createContentSource({ ddb, cmds, table, actor, audit, now = () => Date.now(), ulid, uid, mediaPublicBase = "https://harrisonfamily.us", guard = createGuard(), checkUpload }) {
  const base = String(mediaPublicBase ?? "").replace(/\/+$/, "");
  const requireActor = () => {
    if (!actor) throw new ContentError("forbidden", "sign in to write");
    return actor;
  };
  const view = (p) => withCan(structuredClone(p), actor);

  async function fetchStored(id) {
    const r = await ddb.send(new cmds.GetCommand({ TableName: table, Key: postKeys(id) }));
    return r.Item?.post ?? null;
  }
  async function visible(id) {
    const p = await fetchStored(id);
    if (!p || !canView(p, actor)) throw new ContentError("not_found", `no post ${id}`, { id });
    return p;
  }
  function validateBody(body) {
    if (typeof body !== "string" || body.trim() === "") throw new ContentError("validation", "body is required", { field: "body" });
    if (body.length > MAX_BODY) throw new ContentError("validation", "body too long", { field: "body" });
  }

  /** Main item + author index + optional subject index; all carry the full post so list reads need no second fetch. */
  function itemsFor(post) {
    const base = { entity: "post", post };
    const items = [
      { ...postKeys(post.id), GSI1PK: gsiPosts, GSI1SK: post.id, ...base },
      { PK: `POST#${post.id}`, SK: "IDX#AUTHOR", GSI1PK: gsiAuthor(post.author.id), GSI1SK: post.id, ...base },
    ];
    if (post.subject) items.push({ PK: `POST#${post.id}`, SK: "IDX#SUBJECT", GSI1PK: gsiSubject(post.subject), GSI1SK: post.id, ...base });
    return items;
  }
  const allKeys = (id) => [postKeys(id), { PK: `POST#${id}`, SK: "IDX#AUTHOR" }, { PK: `POST#${id}`, SK: "IDX#SUBJECT" }];

  /**
   * The UPLOAD# binding for every attachment the post did not already hold (privacy-guard-existing-paths): the upload must be
   * the writer's own post photo, unexpired and not attached to another post, its type must match, and its stored bytes must carry
   * no location (checkLocation). Returns the transact() updates that attach each one (SET attached, REMOVE ttl) on the same
   * conditions, so a binding that changes after this read cancels the whole write (403 upload_not_owned).
   */
  async function bindUploads(postId, attachments, held = []) {
    const who = requireActor();
    const have = new Set(held.map((a) => uploadPath(a.url, base)));
    const seen = new Set();
    const updates = [];
    const nowS = Math.floor(now() / 1000);
    for (const a of attachments) {
      const path = uploadPath(a.url, base);
      if (have.has(path)) continue;
      if (seen.has(path)) throw invalid("attachments", "each photo can be attached once");
      seen.add(path);
      const id = path.split("/")[3];
      const key = path.slice(1);
      const up = (await ddb.send(new cmds.GetCommand({ TableName: table, Key: uploadKeys(id) }))).Item;
      const attachedHere = up?.attached === postId;
      if (!up || up.owner !== who.id || up.purpose !== UPLOAD_PURPOSE_POST || up.key !== key) throw notOwned();
      if (up.attached !== undefined && !attachedHere) throw notOwned();
      if (up.attached === undefined && !(typeof up.ttl === "number" && up.ttl > nowS)) throw notOwned(); // the 24 h binding lapsed
      if (a.mime !== up.contentType) throw notUploaded();
      if (!checkUpload) throw new HttpError(503, "unavailable", "uploads are not configured");
      const stored = await checkUpload(key); // 400 photo_has_location / upload_missing
      if (stored?.contentType !== undefined && stored.contentType !== up.contentType) throw notUploaded();
      updates.push({
        key: uploadKeys(id),
        update: "SET #att = :post REMOVE #ttl",
        condition: `#own = :own AND #pur = :pur AND ${attachedHere ? "#att = :post" : "attribute_not_exists(#att)"}`,
        names: { "#att": "attached", "#ttl": "ttl", "#own": "owner", "#pur": "purpose" },
        values: { ":post": postId, ":own": who.id, ":pur": UPLOAD_PURPOSE_POST },
        tag: "upload",
      });
    }
    return updates;
  }

  /**
   * One TransactWriteItems: the data change plus its D-15 audit item. Non-create writes are guarded on the stored
   * `updated_at` that `before` was read with, so a concurrent change cancels this write (409 conflict) instead of being
   * silently overwritten, and the audit `before` is exactly the state this write replaced.
   */
  async function commit(op, id, before, after, at, { create = false, updates = [] } = {}) {
    const who = requireActor();
    const entry = auditEntry(op, id, who.id, before, after, at);
    const mainCondition = create ? { condition: "attribute_not_exists(PK)" } : versionGuard("post", "updated_at", before.updated_at);
    const puts = [];
    const deletes = [];
    if (after) {
      const items = itemsFor(after);
      items.forEach((item, i) => puts.push({ item, ...(i === 0 ? mainCondition : {}) }));
      if (!after.subject) deletes.push({ PK: `POST#${id}`, SK: "IDX#SUBJECT" });
    } else {
      const [main, ...rest] = allKeys(id);
      deletes.push({ key: main, ...mainCondition }, ...rest);
    }
    puts.push({ item: auditItem(entry, uid(), table) });
    try {
      await transact(ddb, cmds, table, { puts, deletes, updates });
    } catch (e) {
      // A failed condition is a 409; retries that ran out on TransactionConflict are a 503 busy; any other cancellation is the store failing.
      // @io-kit/content has no busy code, so busy is the API's HttpError: errorResponse answers it 503 for HTTP, and the MCP core reports any thrown Error's message as the tool error ("busy, try again").
      if (e instanceof TxnCancelled && e.busy) throw new HttpError(503, "busy", "busy, try again");
      // An UPLOAD# binding changed between the read and the write (attached elsewhere, or not this member's): 403, nothing written.
      if (e instanceof TxnCancelled && e.conditionFailed && e.failures.every((f) => f.tag === "upload")) throw notOwned();
      if (e instanceof TxnCancelled && e.conditionFailed) throw new ContentError("conflict", "record changed concurrently", { id });
      throw new ContentError("unavailable", "store unavailable", { id });
    }
    if (self.audit) await self.audit(entry);
  }

  const self = {
    ...(audit ? { audit } : {}),
    async list(args = {}) {
      if (args.signal?.aborted) throw new ContentError("unavailable", "aborted");
      const f = args.filter;
      const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(args.limit ?? DEFAULT_LIMIT)));
      let after = null;
      if (args.cursor) {
        const m = /^c1\.([0-9A-Z]{26})\.([0-9a-f]+)$/.exec(args.cursor);
        if (!m || m[2] !== filterId(f)) throw new ContentError("cursor_invalid", "cursor does not belong to this listing");
        after = m[1];
      }
      const pk = f?.subject !== undefined ? gsiSubject(f.subject) : f?.author !== undefined ? gsiAuthor(f.author) : gsiPosts;
      const accept = (item) => {
        const p = item.post;
        return (
          canView(p, actor) &&
          (f?.subject === undefined || p.subject === f.subject) &&
          (f?.type === undefined || p.type === f.type) &&
          (f?.author === undefined || p.author.id === f.author) &&
          (f?.visibility === undefined || p.visibility === f.visibility)
        );
      };
      const rows = await queryPartition(ddb, cmds, table, { pk, after, accept, want: limit + 1 });
      const page = rows.slice(0, limit).map((r) => r.post);
      const last = page[page.length - 1];
      return { items: page.map(view), cursor: rows.length > limit && last ? `c1.${last.id}.${filterId(f)}` : null };
    },
    async get(id) {
      return view(await visible(id));
    },
    async createDraft(input) {
      const who = requireActor();
      validateBody(input.body);
      if (input.type !== undefined && !POST_TYPES.includes(input.type)) throw new ContentError("validation", "unknown type", { field: "type" });
      if (input.visibility !== undefined && input.visibility !== "draft" && input.visibility !== "published") throw new ContentError("validation", "visibility must be draft or published", { field: "visibility" });
      const present = (v) => v !== undefined && v !== null; // null on create means "not set"
      if (present(input.ref) && (typeof input.ref !== "string" || input.ref.length > 200)) throw invalid("ref", "ref must be a short string");
      const at = new Date(now()).toISOString();
      const post = {
        id: ulid(now()),
        type: input.type ?? "post",
        author: { id: who.id, label: who.label },
        ...(present(input.subject) ? { subject: checkSubject(input.subject) } : {}),
        ...(present(input.title) ? { title: checkTitle(input.title) } : {}),
        body: input.body,
        attachments: normalizeAttachments(input.attachments ?? [], mediaPublicBase),
        visibility: input.visibility === "published" ? "published" : "draft", // one write, one audit entry (drafts:false hosts)
        created_at: at,
        updated_at: at,
        ...(present(input.ref) ? { ref: input.ref } : {}),
      };
      guard("posts", "create", postTextFields(post)); // R-18: 422 contact_info / dob_not_allowed, nothing stored
      checkSize(post);
      const updates = await bindUploads(post.id, post.attachments);
      await commit("create", post.id, null, post, at, { create: true, updates });
      return view(post);
    },
    async update(id, patch) {
      const current = await visible(id);
      if (!computeCan(current, actor).edit) throw new ContentError("forbidden", "only the author can edit", { id });
      if (patch.body !== undefined) validateBody(patch.body);
      const before = structuredClone(current);
      const next = { ...current };
      if (patch.body !== undefined) next.body = patch.body;
      if (patch.attachments !== undefined) next.attachments = normalizeAttachments(patch.attachments, mediaPublicBase);
      for (const [k, check] of [["title", checkTitle], ["subject", checkSubject]]) {
        const v = patch[k];
        if (v === null) delete next[k];
        else if (v !== undefined) next[k] = check(v);
      }
      next.updated_at = new Date(now()).toISOString();
      // R-18 on what this edit submits: the body, the title and, when the attachments are replaced, every alt.
      guard("posts", "update", postTextFields(next, { body: patch.body !== undefined, title: typeof patch.title === "string", attachments: patch.attachments !== undefined }));
      checkSize(next);
      const updates = patch.attachments !== undefined ? await bindUploads(id, next.attachments, current.attachments ?? []) : [];
      await commit("update", id, before, next, next.updated_at, { updates });
      return view(next);
    },
    async setVisibility(id, visibility) {
      if (!VISIBILITIES.includes(visibility)) throw new ContentError("validation", "unknown visibility", { field: "visibility" });
      const current = await visible(id);
      if (!computeCan(current, actor).publish) throw new ContentError("forbidden", "only the author can change visibility", { id });
      if (current.visibility === visibility) return view(current);
      const before = structuredClone(current);
      const next = { ...current, visibility, updated_at: new Date(now()).toISOString() };
      await commit("visibility", id, before, next, next.updated_at);
      return view(next);
    },
    async delete(id) {
      const current = await visible(id);
      if (!computeCan(current, actor).delete) throw new ContentError("forbidden", "not allowed to delete", { id });
      await commit("delete", id, structuredClone(current), null, new Date(now()).toISOString());
    },
  };
  return self;
}

/** Test/seed helper: writes StoredPost rows (main + index items) without audit. */
export async function seedPosts({ ddb, cmds, table }, posts) {
  for (const post of posts) {
    const base = { entity: "post", post };
    await ddb.send(new cmds.PutCommand({ TableName: table, Item: { ...postKeys(post.id), GSI1PK: gsiPosts, GSI1SK: post.id, ...base } }));
    await ddb.send(new cmds.PutCommand({ TableName: table, Item: { PK: `POST#${post.id}`, SK: "IDX#AUTHOR", GSI1PK: gsiAuthor(post.author.id), GSI1SK: post.id, ...base } }));
    if (post.subject) await ddb.send(new cmds.PutCommand({ TableName: table, Item: { PK: `POST#${post.id}`, SK: "IDX#SUBJECT", GSI1PK: gsiSubject(post.subject), GSI1SK: post.id, ...base } }));
  }
}
