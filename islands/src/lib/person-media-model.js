// The shared model of the person-page portrait and add-photo islands (HFY-TSK-388-0A pass 3; BRD 5.3, 5.4, D-09, D-11, D-12; boards B7, B8). Pure helpers and the one
// save run (upload, commit, set portrait) over a kit `MediaSource`, so the islands stay thin and the unit tests need no browser.
import { MediaError } from "@io-kit/media";
import { clampSquare, heightFor } from "@io-kit/media/portrait";
import { hasFailed, newEntry, runUploads, uploadPhoto } from "@io-kit/media/upload";

/** Who looks first on someone else's page, and who to text when an upload fails: the family contact, by initial (as in the other islands). */
export const REVIEWER = "J";
export const CONTACT = "J";
export const COPY = Object.freeze({
  suggest: "suggest a photo",
  close: "close",
  cropTitle: "crop your photo",
  // The choice step and the tagged-photo picker (HFY-TSK-408). The person is "I" on the member's own page, "this person" on anyone else's (no gender in the words).
  chooseTitle: "choose a photo",
  upload: "upload a new photo",
  taggedOwn: "use a photo I'm tagged in",
  taggedOther: "use a photo this person is tagged in",
  pickTitleOwn: "photos I'm tagged in",
  pickTitleOther: "photos this person is tagged in",
  empty: "no photos with this person tagged yet.",
  loading: "loading photos",
  showMore: "show more",
  back: "back",
  cancel: "cancel",
  save: "save",
  saving: "saving",
  listFailed: "those photos didn't load. try again.",
  openFailed: "that photo didn't open. try again.",
  tooSmall: "make the square a little bigger.",
  saveFailed: `that didn't save. try again, or text ${CONTACT}.`,
  retry: "try again",
});

/** D-09: `own` on the signed-in member's own record (direct), `other` on anyone else's (a proposal), null when signed out or the member has no record. */
export const viewerMode = (meId, personId) => (!meId || !personId ? null : meId === personId ? "own" : "other");

/** Up to two capital letters from a display name for the dashed tile ("no photo yet"); "?" when there is none. */
export function initialsOf(name) {
  const words = String(name ?? "").split(/[^\p{L}]+/u).filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0][0];
  const last = words.length > 1 ? words[words.length - 1][0] : "";
  return (first + last).toUpperCase();
}

/** Where "tag people" goes: the person's photos on the page that exists today (the photo tag editor opens from a photo in its lightbox; there is no /tags page yet). */
export const tagHref = (personId) => `/person/?id=${encodeURIComponent(personId)}#person-media-section`;

/**
 * Pick -> (normalized `photo`, chosen `rect`) -> presign into the pending prefix -> PUT -> commit (purpose portrait) -> ONE setPortrait submission (D-11). Re-calling it with
 * the entries of a failed run retries only what failed. `onChange(entries)` is the progress (0..1 per entry). Resolves `{entries, failed, pending}`; `pending` is true when the
 * member is not the person (the tags came back as a proposal), so the preview is the sender's alone.
 */
export async function savePortrait({ source, personId, photo, rect, entries, put, onChange }) {
  const upload = source.upload;
  const portrait = source.portrait;
  if (!upload || !portrait) throw new MediaError("NOT_SUPPORTED");
  let tags = [];
  const done = await runUploads(
    entries ?? [newEntry("portrait", "portrait")],
    async (_entry, onProgress) => {
      const up = await uploadPhoto(upload, photo.file, { purpose: "portrait", subject: personId }, { normalize: async () => photo, put, onProgress });
      const [committed] = await upload.commit([{ uploadId: up.uploadId, purpose: "portrait", subject: personId }]);
      if (!committed) throw new MediaError("UPLOAD_REJECTED");
      tags = await portrait.setPortrait({ personId, mediaId: committed.mediaId, crop: rect });
      return up;
    },
    onChange,
  );
  return { entries: done, failed: hasFailed(done), pending: tags.some((t) => t.state === "pending-proposal") };
}

/** The label of a photo in the tagged-photo grid: its title and year when it has them. */
export const photoLabel = (card) => [card?.title ?? "untitled photo", card?.year].filter(Boolean).join(", ");

/**
 * The square to start the tagged-photo crop from: centred on the person's tag box (percent corners `rect`) and twice its size (head and shoulders), snapped to the grid and
 * clamped inside the image by the kit's helpers. null when there is no usable box (the kit's own start, the largest centred square, is used then).
 */
export function tagSquare(rect, dims) {
  if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(Number.isFinite)) return null;
  const x1 = Math.min(rect[0], rect[2]);
  const x2 = Math.max(rect[0], rect[2]);
  const y1 = Math.min(rect[1], rect[3]);
  const y2 = Math.max(rect[1], rect[3]);
  const w = Math.round(Math.max(x2 - x1, ((y2 - y1) * dims.imageHeight) / dims.imageWidth) * 2);
  const h = heightFor(w, dims);
  return clampSquare({ w, x: (x1 + x2) / 2 - w / 2, y: (y1 + y2) / 2 - h / 2 }, dims);
}

/** The same rule as the upload portrait (P4-R16, validateNewRect): null for the full frame, else four whole percents in order, at least 2 x 2 units. */
export const usableRect = (rect) =>
  rect === null || (Array.isArray(rect) && rect.length === 4 && rect.every(Number.isInteger) && rect.every((n) => n >= 0 && n <= 100) && rect[2] - rect[0] >= 2 && rect[3] - rect[1] >= 2);

/** The natural size of an image, for a card the API gave no size for. */
export const measureImage = (url) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => (img.naturalWidth > 0 && img.naturalHeight > 0 ? resolve({ w: img.naturalWidth, h: img.naturalHeight }) : reject(new Error("no size")));
  img.onerror = () => reject(new Error("image"));
  img.src = url;
});

/**
 * Sets the portrait from a photo the person is already tagged in (POST /api/media/portrait, the tagged-photo variant of api/src/web-upload.js): no upload, no new Media.
 * Body `{mediaId, rect, person}`, `rect` the four whole percents or null. Resolves `{pending}`: true when the member is not the person (a proposal). Rejects with a
 * MediaError (REQUEST_FAILED, `status` the HTTP status or 0).
 */
export async function savePortraitFromPhoto({ personId, mediaId, rect, fetch: fetchImpl = (...a) => globalThis.fetch(...a), base = "/api" }) {
  if (!usableRect(rect)) throw new MediaError("INVALID_RECT", "the square is too small");
  let res;
  try {
    res = await fetchImpl(`${base}/media/portrait`, {
      method: "POST", credentials: "same-origin", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ mediaId, rect, person: personId }),
    });
  } catch {
    throw Object.assign(new MediaError("REQUEST_FAILED", "network"), { status: 0 });
  }
  let data = null;
  try { data = await res.json(); } catch { /* an empty or non-JSON body */ }
  if (!res.ok) throw Object.assign(new MediaError("REQUEST_FAILED", `HTTP ${res.status}`), { status: res.status });
  return { pending: data?.state === "pending-proposal" || (Array.isArray(data?.tags) && data.tags.some((t) => t?.state === "pending-proposal")) };
}
