// Comment photo attachments (hfy-comments-photos-desc-api; BRD2 section 9.2, PS-10). The policy the comment source asks about every
// photo URL it is handed:
//   parse(url)                  the canonical path and upload id of a /uploads/comments/<ulid>/<name> URL, else 422 validation;
//   owned(items, who)           403 upload_not_owned unless each upload is the actor's own, unexpired and not yet attached;
//   bind(items, who, commentId) owned(), then HEAD each object (exists, Content-Type equal to the declared type, at most 10 MB),
//                               then checkLocation (400 photo_has_location), and returns the transact() updates that attach each
//                               upload (SET attached, REMOVE ttl) on the same conditions, so a binding that changes after this
//                               read cancels the whole write (403 upload_not_owned).
// The server chooses every object name (uploads.js), the client's file name never reaches a key, and the attachment id is the
// upload's ulid.
import { CommentError } from "@io-kit/comments";
import { HttpError } from "./http.js";
import { checkLocation, headUpload } from "./upload-guard.js";
import { COMMENT_IMAGE_TYPES, MAX_UPLOAD_BYTES, UPLOAD_PURPOSE_COMMENT, uploadKeys } from "./uploads.js";

export const MAX_ATTACHMENTS = 4;
export const MAX_ALT = 500;
export const MAX_DIMENSION = 100000;
export const PHOTO_MIMES = COMMENT_IMAGE_TYPES;
const PATH_RE = /^\/uploads\/comments\/([0-9A-HJKMNP-TV-Z]{26})\/[a-z0-9][a-z0-9._-]{0,80}$/;

const notOwned = () => new HttpError(403, "upload_not_owned", "that photo can't be attached here. add it again.");
const notUploaded = () => new HttpError(400, "upload_missing", "that photo didn't finish uploading. add it again.");
const invalid = (message) => new CommentError("validation", message, "attachments");

/** The attachments a client submitted, shape-checked (the kit's NewAttachment): at most 4, each url once, blank alt dropped. */
export function normalizeNew(list, { parse }) {
  if (!Array.isArray(list)) throw invalid("attachments must be a list");
  if (list.length > MAX_ATTACHMENTS) throw invalid(`at most ${MAX_ATTACHMENTS} photos`);
  const seen = new Set();
  return list.map((a) => {
    if (a === null || typeof a !== "object" || Array.isArray(a)) throw invalid("each attachment must be an object");
    const { id, path } = parse(a.url);
    if (seen.has(path)) throw invalid("each photo can be attached once");
    seen.add(path);
    if (!PHOTO_MIMES.includes(a.mime)) throw invalid("photos are jpeg, png or webp");
    for (const k of ["width", "height"]) {
      if (a[k] !== undefined && (!Number.isInteger(a[k]) || a[k] < 1 || a[k] > MAX_DIMENSION)) throw invalid(`${k} must be a whole number from 1 to ${MAX_DIMENSION}`);
    }
    if (a.alt !== undefined && typeof a.alt !== "string") throw invalid("alt must be text");
    if (typeof a.alt === "string" && a.alt.length > MAX_ALT) throw invalid(`alt exceeds ${MAX_ALT} characters`);
    const alt = typeof a.alt === "string" && a.alt.trim() !== "" ? a.alt.trim() : undefined;
    return { id, path, mime: a.mime, ...(a.width !== undefined ? { width: a.width } : {}), ...(a.height !== undefined ? { height: a.height } : {}), ...(alt ? { alt } : {}) };
  });
}

/** `base` is the public media origin (urls under it are accepted as absolute); `head` and `location` are upload-guard.js bound to the bucket. */
export function createUploadPhotos({ ddb, cmds, table, base = "https://harrisonfamily.us", now = () => Date.now(), head, location }) {
  const origin = String(base ?? "").replace(/\/+$/, "");
  function parse(url) {
    if (typeof url !== "string") throw invalid("url is required");
    const path = origin && url.startsWith(`${origin}/`) ? url.slice(origin.length) : url;
    const m = PATH_RE.exec(path);
    if (!m) throw invalid("not a comment photo");
    return { id: m[1], path };
  }
  async function loadOwned(items, who) {
    const nowS = Math.floor(now() / 1000);
    const rows = await Promise.all(items.map(async (a) => (await ddb.send(new cmds.GetCommand({ TableName: table, Key: uploadKeys(a.id) }))).Item));
    rows.forEach((up, i) => {
      const a = items[i];
      if (!up || up.owner !== who.id || up.purpose !== UPLOAD_PURPOSE_COMMENT || up.key !== a.path.slice(1) || up.attached !== undefined) throw notOwned();
      if (!(typeof up.ttl === "number" && up.ttl > nowS)) throw notOwned(); // the 24 h binding lapsed
    });
    return rows;
  }
  return {
    parse,
    async owned(items, who) {
      await loadOwned(items, who);
    },
    async bind(items, who, commentId) {
      if (items.length === 0) return [];
      const rows = await loadOwned(items, who);
      const stored = await Promise.all(items.map((a) => head(a.path.slice(1))));
      stored.forEach((s, i) => {
        if (s.contentType !== items[i].mime || s.contentType !== rows[i].contentType) throw notUploaded();
        if (typeof s.size === "number" && s.size > MAX_UPLOAD_BYTES) throw notUploaded();
      });
      await Promise.all(items.map((a) => location(a.path.slice(1)))); // 400 photo_has_location / upload_missing
      return items.map((a) => ({
        key: uploadKeys(a.id),
        update: "SET #att = :c REMOVE #ttl",
        condition: "#own = :own AND #pur = :pur AND attribute_not_exists(#att)",
        names: { "#att": "attached", "#ttl": "ttl", "#own": "owner", "#pur": "purpose" },
        values: { ":c": commentId, ":own": who.id, ":pur": UPLOAD_PURPOSE_COMMENT },
        tag: "upload",
      }));
    },
  };
}

/** The production wiring over the API's S3 client, or undefined when there is none (comment photos then fail closed with 503). */
export function uploadPhotosFor({ ddb, cmds, table, bucket, base, now, s3 }) {
  if (!s3) return undefined;
  return createUploadPhotos({
    ddb, cmds, table, base, now,
    head: (key) => headUpload(bucket, key, { s3 }),
    location: (key) => checkLocation(bucket, key, { s3 }),
  });
}
