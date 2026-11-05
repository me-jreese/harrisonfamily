// Photo upload for the composers' onUpload (PostComposer, comments Composer): normalize in the browser (lib/photo.js: upright JPEG, no EXIF,
// long edge at most 2560 px), presign via /api/uploads, PUT the bytes straight to S3, return the attachment record.
//
//   uploadPhoto(api, file, { purpose, normalize, fetchImpl, normalizeImpl })
//     purpose    "post" (the default) or "comment": the API chooses uploads/posts/<ulid>/ or uploads/comments/<ulid>/ (HFY-TSK-187, BRD2 9.2)
//     normalize  default true for a comment photo (always), false for a post photo until commentPhotosV1 is on (my-posts passes the flag)
//
// The file's own name is never sent: the API names every upload photo.<ext> (privacy-guard-existing-paths AC6). The fixed
// `filename: "photo"` is for the API deployed before the RG-2 change set, which refuses a presign without one (400 "filename is
// required"); the site ships on merge, ahead of that API, and the new API ignores the field. Drop it once RG-2 is live.
//
// A presigned PUT lives 300 s. When S3 answers 403 (the signature expired, typically a slow phone upload that waited on the picker), the
// upload is presigned again and PUT once more; a second refusal is the error. A 403 for another reason (a bad Content-Type, a size
// mismatch) is retried once the same way, which costs one extra presign and PUT and is still bounded to one retry. Normalization failures (PhotoDecodeError, copy E10) surface
// before anything is sent.
import { normalizePhotoDetailed } from "./photo.js";

export const UPLOAD_FILENAME = "photo";
export const PURPOSES = Object.freeze(["post", "comment"]);

/** An absolute public url as its same-origin path (the thumbnail and the attachment then ride the member's cookie, whatever origin the API signed). */
const sitePath = (u) => {
  try {
    return new URL(u).pathname;
  } catch {
    return u;
  }
};

export async function uploadPhoto(api, file, opts = {}) {
  const { purpose = "post", fetchImpl, normalizeImpl = normalizePhotoDetailed } = opts;
  if (!PURPOSES.includes(purpose)) throw new TypeError(`unknown upload purpose: ${purpose}`);
  const normalize = opts.normalize ?? purpose === "comment";
  const norm = normalize ? await normalizeImpl(file) : { file };
  const body = norm.file;
  const presign = () => api.post("/uploads", { filename: UPLOAD_FILENAME, contentType: body.type, size: body.size, ...(purpose === "comment" ? { purpose } : {}) });
  const put = (p) => (fetchImpl || globalThis.fetch)(p.uploadUrl, { method: "PUT", headers: { "Content-Type": body.type }, body });
  let presigned = await presign();
  let res = await put(presigned);
  if (res.status === 403) {
    presigned = await presign();
    res = await put(presigned);
  }
  if (!res.ok) {
    const err = new Error(`Upload failed (HTTP ${res.status}).`);
    err.status = res.status;
    throw err;
  }
  return {
    kind: "image",
    url: purpose === "comment" ? sitePath(presigned.publicUrl) : presigned.publicUrl,
    mime: body.type,
    ...(norm.width ? { width: norm.width, height: norm.height } : {}),
  };
}
