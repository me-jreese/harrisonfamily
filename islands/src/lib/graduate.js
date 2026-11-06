// "add to a family page" on a comment photo (HFY-TSK-215, hfy-graduate-ui; BRD2 R-02, social.md section 10), behind the default-off flag graduateV1.
// Pure model, no React: the POST /api/comments/:id/attachments/:aid/graduate request, the copy, the marker states and the error lines.
// lib/graduate-ui.jsx draws it. Who may graduate is `can.graduate` from GET /api/me (lib/me.js); the server re-checks admin on every call.
import { ApiError } from "./api.js";
import { isPersonId } from "./person-name.js";

export const FLAG = "graduateV1";
/** The route's caps (graduate.js: MAX_TITLE, MAX_DESCRIPTION). The form has a title only; the description stays off the form. */
export const TITLE_MAX = 200;
/** A reservation pending longer than this shows "retry" (social.md section 10; api/src/graduate.js STALE_PENDING_MS). */
export const STALE_PENDING_MS = 15 * 60_000;

/** DS Voice: lowercase, plain. */
export const COPY = {
  trigger: "add to a family page…",
  which: "which page?",
  whichHint: "type a name, then pick from the list.",
  searching: "looking…",
  none: "no one by that name.",
  title: "title",
  add: "add to page",
  adding: "adding…",
  cancel: "cancel",
  retry: "retry",
  pending: "adding to a page…",
  needPerson: "pick a page from the list.",
  titleLong: `keep the title under ${TITLE_MAX + 1} characters.`,
  syncLater: "added — it shows on the page after the next sync.",
  ping: "added to the page.",
  // errors (social.md section 15: E15 and E17 share a line, E16 sits under the title, E18 names the page)
  unavailable: "couldn't add it to the page right now. try again in a minute.",
  invalid: "that title didn't work. check it and try again.",
  failed: "that didn't work. try again, or text J.",
  forbidden: "only admins can do that.",
  signedOut: "you got signed out. sign in again?",
  moderated: "that photo is hidden. unhide it first.",
  gone: "that photo is gone.",
};

/** "on {name}'s page", the badge's words. */
export const onPage = (name) => `on ${name}’s page`;
/** "this photo is already on {name}'s page." (E18) */
export const alreadyOn = (name) => `this photo is already on ${name}’s page.`;

/** The person the thread belongs to: `person:<id>` is its id, a post thread has none. */
export function threadPerson(subject) {
  const m = /^person:(.+)$/.exec(String(subject ?? ""));
  return m && isPersonId(m[1]) ? m[1] : null;
}

/** The title's starting text: the photo's alt text, trimmed to the cap. */
export const initialTitle = (attachment) => String(attachment?.alt ?? "").trim().slice(0, TITLE_MAX);

/** `/person/?id=<x>#photos`: where the badge goes. */
export const photosHref = (id) => `/person/?id=${encodeURIComponent(id)}#photos`;

/**
 * What the photo's `graduated` marker means for the UI:
 *   none     no marker, or a failed one (the form is offered again)
 *   pending  a reservation: `stale` once it is older than 15 minutes (then "retry"), else a quiet "adding…"
 *   done     the badge, with the person's id
 */
export function markerState(marker, now = Date.now()) {
  if (!marker || typeof marker !== "object") return { kind: "none" };
  if (marker.state === "done" && isPersonId(marker.person)) return { kind: "done", person: marker.person };
  if (marker.state === "pending" && isPersonId(marker.person)) {
    const at = Date.parse(marker.at);
    return { kind: "pending", person: marker.person, title: typeof marker.title === "string" ? marker.title : undefined, stale: Number.isFinite(at) ? now - at > STALE_PENDING_MS : true };
  }
  return { kind: "none" };
}

/** The POST body. Title is sent only when there is one (the server then falls back to the alt text). */
export function graduateBody({ subject, person, title }) {
  const t = String(title ?? "").trim();
  return { subject, person, ...(t ? { title: t } : {}) };
}

export const graduatePath = (commentId, attachmentId) => `/comments/${encodeURIComponent(commentId)}/attachments/${encodeURIComponent(attachmentId)}/graduate`;

/** Send it: resolves `{ media, person, state }` (201, or 200 when this photo was already added to that person). */
export const graduate = (api, { commentId, attachmentId, subject, person, title }) => api.post(graduatePath(commentId, attachmentId), graduateBody({ subject, person, title }));

/** Validation field: the form line the server's refusal belongs to. */
export const fieldOf = (e) => (e?.field === "title" || e?.field === "description" ? "title" : undefined);

/**
 * The line for a failed call, `{ text, field? }`. `names` maps a person id to the name the page knows, for E18.
 * 503 (E15, E17 and the rest of the pending family) shares one line; a 400 validation sits under the title (E16).
 */
export function errorLine(e, names = () => undefined) {
  const status = e instanceof ApiError ? e.status : undefined;
  const code = e instanceof ApiError ? e.code : undefined;
  if (status === undefined) return { text: COPY.failed };
  if (status === 401 || code === "unauthenticated") return { text: COPY.signedOut };
  if (code === "already_graduated") {
    const id = e.details?.person;
    return { text: alreadyOn(names(id) || "another person") };
  }
  if (status === 400 || code === "validation" || code === "contact_info" || code === "dob_not_allowed" || status === 422) return { text: COPY.invalid, field: "title" };
  if (status === 403 || code === "forbidden") return { text: COPY.forbidden };
  if (status === 404 || code === "not_found") return { text: COPY.gone };
  if (code === "moderated") return { text: COPY.moderated };
  if (status === 409 || status >= 500) return { text: COPY.unavailable };
  return { text: COPY.failed };
}
