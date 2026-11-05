// Browser JPEG normalization for member photos (HFY-TSK-187, BRD2 section 9.3, R-01 and R-18). Every photo a member adds to a comment
// (and, with commentPhotosV1 on, to a post) is re-encoded here before it is uploaded:
//   1. decoded with createImageBitmap(file, { imageOrientation: "from-image" }), which bakes the EXIF orientation into the pixels
//      (Gramps 6.0.6 on macOS ignores EXIF orientation, so an upright JPEG is the only safe shape);
//   2. scaled so the long edge is at most MAX_LONG_EDGE (2560 px), never enlarged;
//   3. drawn onto a canvas and encoded as image/jpeg at JPEG_QUALITY (0.85).
// A canvas encode carries no EXIF at all, so GPS (a location, which is contact-adjacent data under R-18) never leaves the browser.
// The API still refuses a stored photo that carries location metadata (photo_has_location); this is the step that keeps an honest
// member's photo from ever hitting it. Nothing here reads, logs or sends the file's name.

export const MAX_LONG_EDGE = 2560;
export const JPEG_QUALITY = 0.85;
export const JPEG_MIME = "image/jpeg";
/** The picker's `accept`: leaving out image/heic makes iOS Safari hand over a JPEG from the photo library (social.md 9.3). */
export const PHOTO_ACCEPT = "image/jpeg,image/png,image/webp";

/**
 * DS Voice copy for the photo path. E10 (social.md): a photo the browser cannot decode. The others are the 9.4 error lines.
 * `location` and `missing` are the API's photo_has_location and upload_missing / upload_not_owned answers shown at post time.
 */
export const PHOTO_COPY = Object.freeze({
  decode: "that photo type didn't work here. try a jpeg or a screenshot.",
  upload: "that didn't upload. try again.",
  missing: "that photo didn't finish uploading. add it again.",
  location: "that photo still says where it was taken. we don't keep that on the site, so please remove it and share a copy without its location, like a screenshot.",
});

/** The photo could not be decoded or re-encoded in this browser (copy E10). Never carries the file name. */
export class PhotoDecodeError extends Error {
  constructor(cause) {
    super(PHOTO_COPY.decode);
    this.name = "PhotoDecodeError";
    this.code = "photo_decode";
    if (cause !== undefined) this.cause = cause;
  }
}

/** `{ width, height }` scaled down so the long edge is at most `max`; a photo already inside is returned as is (whole pixels, at least 1). */
export function fitLongEdge(width, height, max = MAX_LONG_EDGE) {
  const long = Math.max(width, height);
  if (!(long > max)) return { width, height };
  const k = max / long;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

const toBlob = (canvas, type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));

/**
 * normalizePhoto with its size: `{ file, width, height }` (the upright, scaled pixel size the API's attachment record carries).
 * `deps` is for tests only: `{ createBitmap, makeCanvas }`.
 */
export async function normalizePhotoDetailed(file, deps = {}) {
  const createBitmap = deps.createBitmap ?? ((f, o) => globalThis.createImageBitmap(f, o));
  const makeCanvas = deps.makeCanvas ?? (() => document.createElement("canvas"));
  let bitmap;
  try {
    bitmap = await createBitmap(file, { imageOrientation: "from-image" });
  } catch (e) {
    throw new PhotoDecodeError(e);
  }
  try {
    if (!(bitmap?.width > 0 && bitmap?.height > 0)) throw new PhotoDecodeError();
    const { width, height } = fitLongEdge(bitmap.width, bitmap.height);
    const canvas = makeCanvas();
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new PhotoDecodeError();
    ctx.fillStyle = "#fff"; // a PNG or WebP with transparency would otherwise encode its clear pixels black
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await toBlob(canvas, JPEG_MIME, JPEG_QUALITY);
    canvas.width = 0; // lets the browser free the pixel buffer now
    canvas.height = 0;
    if (!blob || blob.type !== JPEG_MIME || blob.size === 0) throw new PhotoDecodeError();
    return { file: new File([blob], "photo.jpg", { type: JPEG_MIME, lastModified: Date.now() }), width, height };
  } catch (e) {
    throw e instanceof PhotoDecodeError ? e : new PhotoDecodeError(e);
  } finally {
    bitmap?.close?.();
  }
}

/** The upright JPEG, long edge at most 2560 px, carrying no EXIF (hence no GPS): `normalizePhoto(file) -> Promise<File>`. */
export async function normalizePhoto(file, deps) {
  return (await normalizePhotoDetailed(file, deps)).file;
}
