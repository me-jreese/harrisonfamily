// Admin moderation of record stories (notes) and photos on the person page (HFY-TSK-216, hfy-moderation-record-targets; BRD2 D2-19, R-32), behind the
// default-off flags moderationV1 and moderationRecordsV1. Pure model, no DOM and no React: the POST /api/moderation targets, the menu rows, which
// rendered story is which note, and the hidden set the records API reports to an admin. lib/record-moderation-ui.jsx and islands/record-moderation.jsx draw it.
import { COPY as BASE, createModerationClient } from "./moderation.js";

export const RECORDS_FLAG = "moderationRecordsV1";

/** DS Voice, lowercase and plain. */
export const COPY = {
  ...BASE,
  triggerStory: "moderate story",
  triggerPhoto: "moderate photo",
  hideStory: "hide story",
  unhideStory: "unhide story",
  hidePhotoHere: "hide on this page",
  unhidePhotoHere: "unhide on this page",
  hidePhotoAll: "hide everywhere",
  unhidePhotoAll: "unhide everywhere",
  badgeHiddenStory: "hidden story",
  badgeHiddenPhoto: "hidden photo",
};

export const noteTarget = (handle) => ({ kind: "note", handle });
export const mediaTarget = (handle) => ({ kind: "media", handle });
export const mediarefTarget = (person, media) => ({ kind: "mediaref", person, media });
/** The MOD# key of a target, as the records API lists it in `hidden`. */
export function targetKey(t) {
  if (t.kind === "mediaref") return `mediaref:${t.person}:${t.media}`;
  return `${t.kind}:${t.handle}`;
}

/** The hidden set of GET /api/records/Person/by-id/<id>: `hidden` lists the MOD# targets an admin or the owner still sees. */
export const hiddenSetOf = (view) => new Set(Array.isArray(view?.hidden) ? view.hidden.filter((k) => typeof k === "string") : []);

/**
 * Which notes the page drew, in order. The personV2 island shows a card for each note with raw text; the legacy markup shows a story for each note with html or raw.
 * `mode` is "island" or "legacy"; the caller reads it from the DOM it found.
 */
export function shownNotes(notes, mode) {
  const list = Array.isArray(notes) ? notes : [];
  return list.filter((n) => n && typeof n.handle === "string" && (mode === "island" ? typeof n.raw === "string" && n.raw.trim() !== "" : Boolean(n.html || n.raw)));
}

/** Rows for one story: hide or unhide, and the two asks (the server sends the owner or io the note). */
export function storyRows({ hidden }) {
  const rows = [];
  if (!hidden) rows.push({ id: "hide", label: COPY.hideStory, input: { action: "hide" } });
  rows.push({ id: "request_changes", label: COPY.askChanges, form: "request_changes" });
  rows.push({ id: "ask", label: COPY.askQuestion, form: "ask" });
  if (hidden) rows.push({ id: "unhide", label: COPY.unhideStory, input: { action: "unhide" } });
  return rows;
}

/** Rows for the photo in the lightbox: one for this page's reference (mediaref), one for the Media everywhere (media). `scope` says which target a row acts on. */
export function photoRows({ hiddenHere, hiddenAll }) {
  return [
    hiddenHere ? { id: "unhide-here", label: COPY.unhidePhotoHere, input: { action: "unhide", scope: "mediaref" } } : { id: "hide-here", label: COPY.hidePhotoHere, input: { action: "hide", scope: "mediaref" } },
    hiddenAll ? { id: "unhide-all", label: COPY.unhidePhotoAll, input: { action: "unhide", scope: "media" } } : { id: "hide-all", label: COPY.hidePhotoAll, input: { action: "hide", scope: "media" } },
  ];
}

/** The hidden set after `action` on `key`: hide, request_changes and ask (with hide) hide; unhide shows. Returns a new Set. */
export function applyAction(set, key, input) {
  const next = new Set(set);
  if (input.action === "unhide") next.delete(key);
  else if (input.action === "hide" || input.action === "request_changes" || (input.action === "ask" && input.hide === true)) next.add(key);
  return next;
}

/** `api.post("/moderation", ...)` for a record target. The version is the record's own (not known here), so none is sent. */
export function createRecordClient(api) {
  const client = createModerationClient(api);
  return { act: (target, input) => client.act(target, { action: input.action, ...(input.note !== undefined ? { note: input.note } : {}), ...(input.hide !== undefined ? { hide: input.hide } : {}) }) };
}
