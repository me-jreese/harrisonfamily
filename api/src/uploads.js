// POST /api/uploads: presigned S3 PUT for post photos (HFY-TSK-067). The Lambda never touches the bytes.
// Key: uploads/posts/<ulid>/photo.<ext> in the frontend bucket; the browser PUTs straight to S3 (CORS: infrastructure/cloudformation/media-bucket-cors.json).
// Not media/: the ETL data sync mirrors media/ with --delete and would wipe member photos (HFY-R58 (2)). CloudFront serves
// /uploads/* with a response-headers policy (nosniff + CSP sandbox) and, once the data gate is attached, only to members: the
// hfy-edge-gate viewer-request needs the io_id cookie, so photos are loaded as same-origin <img> and answered "private, no-store"
// (cloudfront/README.md). The PUT itself goes to S3, not CloudFront. The presigned URL signs content-type (presign.js).
//
// privacy-guard-existing-paths (BRD2 D2-06): the server chooses the whole key, so the client's file name (which can name a
// person) never reaches the bucket or a URL; the request's `filename` is ignored. Each presign is bound to its uploader by an
// UPLOAD#<ulid> / META item {owner, purpose, key, contentType, ttl 24 h}; a post may attach only its author's own, unexpired,
// not yet attached uploads (content.js), and the attach removes the ttl.
import { HttpError } from "./http.js";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const IMAGE_TYPES = { "image/jpeg": ["jpg", "jpeg"], "image/png": ["png"], "image/webp": ["webp"], "image/heic": ["heic"] };
export const UPLOAD_EXPIRES_SECONDS = 300;
export const UPLOAD_PREFIX = "uploads/posts";
/** How long an upload stays attachable (UPLOAD# ttl, BRD2 table layout: +24 h until attached). */
export const UPLOAD_BINDING_SECONDS = 24 * 60 * 60;
export const UPLOAD_PURPOSE_POST = "post";

export const uploadKeys = (id) => ({ PK: `UPLOAD#${id}`, SK: "META" });
/** The one object name the server gives a post photo: photo.<ext>, the extension set by the declared type. */
export const photoName = (contentType) => `photo.${IMAGE_TYPES[contentType][0]}`;

/**
 * `presignPut({ bucket, key, contentType, size, expiresIn })` => url is injected (index.js wires the AWS SDK presigner).
 * `ddb`/`cmds`/`table` store the UPLOAD# binding; `now` is milliseconds.
 */
export function createUploads({ presignPut, uid, ddb, cmds, table, now = () => Date.now(), bucket = "harrisonfamily-frontend", publicBase = "https://harrisonfamily.us" }) {
  return {
    async presign(actor, input) {
      if (!actor) throw new HttpError(401, "unauthenticated", "sign in required");
      const { contentType, size } = input ?? {};
      if (typeof contentType !== "string" || !Object.hasOwn(IMAGE_TYPES, contentType)) throw new HttpError(400, "validation", "only jpeg, png, webp and heic images are accepted");
      if (!Number.isInteger(size) || size <= 0) throw new HttpError(400, "validation", "size must be a positive integer");
      if (size > MAX_UPLOAD_BYTES) throw new HttpError(400, "validation", "image exceeds 10 MB");
      const id = uid();
      const key = `${UPLOAD_PREFIX}/${id}/${photoName(contentType)}`;
      const at = now();
      try {
        await ddb.send(new cmds.PutCommand({
          TableName: table,
          Item: {
            ...uploadKeys(id), entity: "upload", owner: actor.id, purpose: UPLOAD_PURPOSE_POST, key, contentType, size,
            created_at: new Date(at).toISOString(), ttl: Math.floor(at / 1000) + UPLOAD_BINDING_SECONDS,
          },
          ConditionExpression: "attribute_not_exists(PK)",
        }));
      } catch {
        throw new HttpError(503, "unavailable", "uploads are unavailable, try again");
      }
      const uploadUrl = await presignPut({ bucket, key, contentType, size, expiresIn: UPLOAD_EXPIRES_SECONDS });
      return { uploadUrl, publicUrl: `${publicBase}/${key}`, key, headers: { "Content-Type": contentType }, expiresIn: UPLOAD_EXPIRES_SECONDS };
    },
  };
}
