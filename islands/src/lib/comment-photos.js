// The pure side of comment photos (HFY-TSK-187, commentPhotosV1): labels, limits, the img alt and the upload error line. No React and no CSS,
// so node:test reaches it; lib/comments-ui.jsx draws with it.
import { ApiError } from "./api.js";
import { PHOTO_COPY, PhotoDecodeError } from "./photo.js";

// BRD2 9.1: at most 4 photos a comment; the API caps it the same.
export const MAX_PHOTOS = 4;

// The kit labels for the photo picker. Ruling P2-R47: the field under a photo is "add a caption" (stored as the attachment's `alt`, shown
// as the visible caption; the img alt is the who-photo line below). The kit's remove button names its photo ("remove: <file>").
export const PHOTO_LABELS = Object.freeze({
  addPhoto: "add a photo",
  removePhoto: "remove",
  photoDescription: "add a caption",
  photoDescriptionHint: "add a caption",
  addingPhoto: "adding photo…",
  photoFailed: PHOTO_COPY.upload,
  photos: "photos",
});

// The API rejects reactions on a photo (`attachment:<id>` targets), so the kit shows none. The caption is drawn by comments-ui renderPhoto
// (the kit's own caption would repeat the alt), so the kit's is off as well.
export const FEATURES = Object.freeze({ attachmentReactions: false, photoCaptions: false });

/**
 * A comment photo's img alt: "a photo from <name>", or "photo 2 of 3 from <name>" in a comment with several (the who-photo line, as
 * posts-ui photoAlt does for posts). The text the author typed in the "add a caption" field is the visible <figcaption> (ruling P2-R47),
 * so it is never repeated as the alt and is not read twice.
 */
export function commentPhotoAlt(comment, index) {
  const total = Array.isArray(comment?.attachments) ? comment.attachments.length : 0;
  const what = total > 1 ? `photo ${index + 1} of ${total}` : "a photo";
  const who = String(comment?.author?.label || "").trim();
  return who ? `${what} from ${who}` : what;
}

/** The line a failed photo upload shows under its row: copy E10 for a photo the browser cannot decode, the 9.4 lines otherwise. */
export function photoUploadMessage(e) {
  if (e instanceof PhotoDecodeError) return PHOTO_COPY.decode;
  if (e instanceof ApiError && (e.status === 401 || e.code === "unauthenticated")) return "you got signed out. sign in again?";
  return PHOTO_COPY.upload;
}
