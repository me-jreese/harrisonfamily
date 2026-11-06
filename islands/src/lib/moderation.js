// Admin moderation for the islands (HFY-TSK-191, R-32; social.md 11, BRD2 D2-19), behind the default-off flag moderationV1.
// Pure model, no React: the POST /api/moderation targets and bodies, the menu items, the copy, the visibility rule and the error lines.
// lib/moderation-ui.jsx draws it; lib/comment-source.js sends comment actions through the same client. Who may moderate comes from the
// server's `can.moderate` on each item (and, for what to draw around an item, GET /api/me via lib/me.js); the server re-checks every call.
import { ApiError } from "./api.js";

export const FLAG = "moderationV1";
/** The note's cap (social.md 11.5: 1..1000 after trimming). */
export const NOTE_MAX = 1000;

/** DS Voice: lowercase, plain. Menu rows, the ask form, the status pings and the error lines. */
export const COPY = {
  trigger: "moderate",
  triggerPhoto: "moderate photo",
  menu: "moderate",
  hide: "hide",
  unhide: "unhide",
  close: "close",
  askChanges: "ask for changes…",
  askQuestion: "ask a question…",
  hidePhoto: "hide photo",
  unhidePhoto: "unhide photo",
  note: "note to the author",
  noteHint: "they'll see this in their inbox and on the item.",
  keepHidden: "keep it hidden until they update it",
  send: "send",
  sending: "sending…",
  cancel: "cancel",
  edit: "edit",
  save: "save",
  saving: "saving…",
  editBody: "your words",
  badgeHidden: "hidden",
  badgeAsked: "question open",
  hiddenByModerator: "a moderator hid this.",
  askedTemplate: "asked:",
  editToShow: "edit it to show it again.",
  photoHidden: "hidden photo",
  // pings (a 3 s status line after an action)
  pingHidden: "hidden. they'll get a note.",
  pingSent: "sent.",
  pingUnhidden: "unhidden.",
  pingPhotoHidden: "photo hidden.",
  pingPhotoUnhidden: "photo unhidden.",
  pingSaved: "saved. it's visible again.",
  // errors
  failed: "that didn't work. try again, or text J.",
  forbidden: "only admins can do that.",
  selfModeration: "that one is yours. withdraw or delete it instead.",
  conflict: "that changed while you were looking. reload and try again.",
  gone: "that item is gone.",
  busy: "busy. try again in a moment.",
  unsupported: "that kind of item can't be moderated yet.",
  signedOut: "you got signed out. sign in again?",
};

/** The three things a menu can act on, for the copy and the item list. */
export const KINDS = Object.freeze(["post", "story", "comment", "photo"]);

// ---- targets ------------------------------------------------------------------------------------------------------------------------------

const POST_PHOTO_RE = /\/uploads\/posts\/([0-9A-HJKMNP-TV-Z]{26})\//;
/** A post photo has no id of its own: the ulid of its upload path names it (the server's postAttachmentId). `undefined` for any other url. */
export const postPhotoId = (attachment) => POST_PHOTO_RE.exec(String(attachment?.url ?? ""))?.[1];

export const postTarget = (post) => ({ kind: "post", id: post.id });
export const commentTarget = (threadId, id) => ({ kind: "comment", id, thread: threadId });
/** A photo of a post (its upload ulid) or of a comment (its attachment id). `parent` is a postTarget or a commentTarget. */
export const photoTarget = (parent, attachment) => ({ kind: "photo", parent, attachment });

/** The version the admin saw (the server answers 409 when it moved): a post's updated_at, a comment's edited_at or created_at. */
export const versionOf = (item) => item?.updated_at ?? item?.edited_at ?? item?.created_at;

// ---- the request ------------------------------------------------------------------------------------------------------------------------

/**
 * The POST /api/moderation body. `hide` is sent for `ask` only (the server reads it there: request_changes always hides, a plain hide hides);
 * a note goes with request_changes and ask only (the server refuses it elsewhere).
 */
export function moderationBody(target, input, version) {
  const note = typeof input.note === "string" ? input.note.trim() : undefined;
  return {
    target,
    action: input.action,
    ...(input.action === "request_changes" || input.action === "ask" ? { note } : {}),
    ...(input.action === "ask" ? { hide: input.hide === true } : {}),
    ...(version ? { version } : {}),
  };
}

/** `api.post("/moderation", ...)` -> `{ target, moderation, item }`. Errors are the ApiError the client threw. */
export function createModerationClient(api) {
  return { act: (target, input, version) => api.post("/moderation", moderationBody(target, input, version)) };
}

// ---- the ask form ------------------------------------------------------------------------------------------------------------------------

/** The ask form's hide checkbox per kind of ask (social.md 11.4): checked for "ask for changes", unchecked for "ask a question". */
export const hideDefault = (action) => action === "request_changes";
export const noteError = (note) => {
  const n = String(note ?? "").trim();
  return n === "" ? "required" : n.length > NOTE_MAX ? "too long" : null;
};

// ---- what to show --------------------------------------------------------------------------------------------------------------------------

/** The menu rows for an item, by its open moderation. `photo` has no ask rows (a note is for the whole post or comment). */
export function menuItems({ photo = false, moderation }) {
  const hidden = moderation?.hidden === true;
  if (photo) return [hidden ? { id: "unhide", label: COPY.unhidePhoto, input: { action: "unhide" } } : { id: "hide", label: COPY.hidePhoto, input: { action: "hide" } }];
  const rows = [];
  if (moderation?.state !== "hidden") rows.push({ id: "hide", label: COPY.hide, input: { action: "hide" } });
  rows.push({ id: "request_changes", label: COPY.askChanges, form: "request_changes" });
  rows.push({ id: "ask", label: COPY.askQuestion, form: "ask" });
  if (moderation) rows.push({ id: "unhide", label: hidden ? COPY.unhide : COPY.close, input: { action: "unhide" } });
  return rows;
}

/** The ping an action earns. */
export function pingFor(action, { photo = false } = {}) {
  if (photo) return action === "unhide" ? COPY.pingPhotoUnhidden : COPY.pingPhotoHidden;
  return action === "hide" ? COPY.pingHidden : action === "unhide" ? COPY.pingUnhidden : COPY.pingSent;
}

/** Everyone but the author and admins loses a hidden item; the server already withholds it, this keeps a stray one from drawing. */
export function moderationVisible(item, viewer) {
  if (item?.moderation?.hidden !== true) return true;
  return Boolean(viewer) && (viewer.admin === true || (viewer.id != null && viewer.id === item?.author?.id));
}

/** The moderation line an admin or the author reads: the note, who asked, and for the author what editing does. */
export function noticeParts(moderation, { own }) {
  if (!moderation) return null;
  const note = typeof moderation.note === "string" ? moderation.note : "";
  const asked = note !== "" && moderation.state !== "hidden";
  return {
    asked,
    note,
    by: moderation.by ?? null,
    hidden: moderation.hidden === true,
    state: moderation.state,
    editToShow: own && asked && moderation.hidden === true,
    // a plain hide tells the author a moderator must unhide it; an edit does not (social.md 11.2)
    plainHide: own && !asked,
  };
}

// ---- errors -----------------------------------------------------------------------------------------------------------------------------

/**
 * The family-facing line for a failed call. A refusal of the note by the R-18 guard (422 contact_info, dob_not_allowed) gets the guard's own DS
 * copy, loaded on demand (the detector is not in the posts bundles otherwise); everything else maps the API's code to one line.
 */
export async function errorLine(e) {
  // An ApiError (the moderation client) or a ContentError (source.update), which keeps the API's own code on `apiCode`.
  const code = e?.apiCode ?? (e instanceof ApiError ? e.code : undefined);
  const status = e instanceof ApiError ? e.status : undefined;
  if (code === undefined && status === undefined && !e?.signedOut) return COPY.failed;
  if (code === "contact_info" || code === "dob_not_allowed") {
    const { GUARD_COPY, learnFromRefusal } = await import("./contact-precheck.js");
    learnFromRefusal(code);
    return GUARD_COPY[code] ?? COPY.failed;
  }
  if (e?.signedOut || status === 401 || code === "unauthenticated") return COPY.signedOut;
  if (code === "self_moderation") return COPY.selfModeration;
  if (code === "unsupported_target") return COPY.unsupported;
  if (status === 403 || code === "forbidden") return COPY.forbidden;
  if (status === 404 || code === "not_found") return COPY.gone;
  if (status === 409 || code === "conflict") return COPY.conflict;
  if (status === 503 || code === "busy") return COPY.busy;
  return COPY.failed;
}
