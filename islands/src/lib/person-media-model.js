// The shared model of the person-page portrait and add-photo islands (HFY-TSK-388-0A pass 3; BRD 5.3, 5.4, D-09, D-11, D-12; boards B7, B8). Pure helpers and the one
// save run (upload, commit, set portrait) over a kit `MediaSource`, so the islands stay thin and the unit tests need no browser.
import { MediaError } from "@io-kit/media";
import { hasFailed, newEntry, runUploads, uploadPhoto } from "@io-kit/media/upload";

/** Who looks first on someone else's page, and who to text when an upload fails: the family contact, by initial (as in the other islands). */
export const REVIEWER = "J";
export const CONTACT = "J";
export const COPY = Object.freeze({
  suggest: "suggest a photo",
  close: "close",
  cropTitle: "crop your photo",
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
