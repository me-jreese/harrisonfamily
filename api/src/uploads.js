// POST /api/uploads: presigned S3 PUT for post photos (HFY-TSK-067). The Lambda never touches the bytes.
// Key: uploads/posts/<ulid>/<safe-name> in the frontend bucket; the browser PUTs straight to S3 (CORS: infrastructure/cloudformation/media-bucket-cors.json).
// Not media/: the ETL data sync mirrors media/ with --delete and would wipe member photos (HFY-R58 (2)). CloudFront serves
// /uploads/* with a response-headers policy (nosniff + CSP sandbox) and, once the data gate is attached, only to members: the
// hfy-edge-gate viewer-request needs the io_id cookie, so photos are loaded as same-origin <img> and answered "private, no-store"
// (cloudfront/README.md). The PUT itself goes to S3, not CloudFront. The presigned URL signs content-type (presign.js).
import { HttpError } from "./http.js";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const IMAGE_TYPES = { "image/jpeg": ["jpg", "jpeg"], "image/png": ["png"], "image/webp": ["webp"], "image/heic": ["heic"] };
export const UPLOAD_EXPIRES_SECONDS = 300;
export const UPLOAD_PREFIX = "uploads/posts";

/** Lowercase ascii, [a-z0-9._-] only, no leading dots, extension forced to match the content type. */
export function safeName(filename, contentType) {
  const exts = IMAGE_TYPES[contentType];
  const base = String(filename ?? "").split(/[\\/]/).pop().replace(/\.[^.]*$/, "");
  const stem = base.normalize("NFKD").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[.\-_]+|[.\-_]+$/g, "").slice(0, 60) || "photo";
  return `${stem}.${exts[0]}`;
}

/** `presignPut({ bucket, key, contentType, size, expiresIn })` => url is injected (index.js wires the AWS SDK presigner). */
export function createUploads({ presignPut, uid, bucket = "harrisonfamily-frontend", publicBase = "https://harrisonfamily.us" }) {
  return {
    async presign(actor, input) {
      if (!actor) throw new HttpError(401, "unauthenticated", "sign in required");
      const { filename, contentType, size } = input ?? {};
      if (typeof filename !== "string" || filename.trim() === "") throw new HttpError(400, "validation", "filename is required");
      if (typeof contentType !== "string" || !Object.hasOwn(IMAGE_TYPES, contentType)) throw new HttpError(400, "validation", "only jpeg, png, webp and heic images are accepted");
      if (!Number.isInteger(size) || size <= 0) throw new HttpError(400, "validation", "size must be a positive integer");
      if (size > MAX_UPLOAD_BYTES) throw new HttpError(400, "validation", "image exceeds 10 MB");
      const key = `${UPLOAD_PREFIX}/${uid()}/${safeName(filename, contentType)}`;
      const uploadUrl = await presignPut({ bucket, key, contentType, size, expiresIn: UPLOAD_EXPIRES_SECONDS });
      return { uploadUrl, publicUrl: `${publicBase}/${key}`, key, headers: { "Content-Type": contentType }, expiresIn: UPLOAD_EXPIRES_SECONDS };
    },
  };
}
