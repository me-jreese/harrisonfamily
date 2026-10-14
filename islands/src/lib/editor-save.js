// The editor's save flow, pure half (HFY-TSK-213, editor-save-flow; HFY-PLN-002 editing.md sections 7.3, 8.3 and 9.1, BRD2 R-06, R-08, R-09).
// No DOM and no React, so a node test pins it (tests/editor-save.test.mjs): the member's form values become EditOps (set ops with the base the
// bundle served), the sticky bar's count ("3 changes — 2 save now, 1 goes to review"), the POST /api/changes bodies (dry run, save, undo), the
// groups the confirmation sheet shows, the toast after a save, the 10-minute undo window, and the plain words for every error the endpoint can
// answer (editing.md 8.3). The server decides on every write: the counts here come from the bundle's policy table and are a hint, the sheet's
// groups come from the dry run.
import { sectionValues } from "./editor-model.js";

/** The client offers the returned inverse ops for 10 minutes (editing.md 7.3 "Atomicity"). */
export const UNDO_WINDOW_MS = 10 * 60 * 1000;

/** The API's cap on a note (changes.js MAX_NOTE_CHARS). */
export const NOTE_MAX = 1000;

export const SAVE_COPY = Object.freeze({
  review: "review",
  barReview: "review and save",
  sheetTitle: "check your changes",
  groupDirect: "saves now",
  groupReview: "sent for review",
  planning: "checking your changes",
  saving: "saving",
  save: "save",
  sendForReview: "send for review",
  back: "back",
  close: "close",
  undo: "undo",
  undone: "undone.",
  saved: "saved.",
  sentOnly: "sent. you can change or withdraw it until an admin looks.",
  seeSuggestions: "see your suggestions",
  nothingToSave: "there is nothing to save.",
  noMoreChanges: "this page just changed, and your edits are already there. nothing is left to save.",
  conflict: "this page just changed — please check your edits.",
  undoConflict: "this page changed after you saved, so the undo can't be done automatically. please look at the page and change it by hand.",
  undoFailed: "we couldn't undo that. please look at the page and change it by hand.",
  reviewerMember: "an admin of the family site looks these over before they show. you'll get a notification when they do, and you can change or withdraw them until then.",
  reviewerAdmin: "another admin looks these over before they show. you can change or withdraw them until then.",
  noteLabel: "a note for whoever looks at it (optional)",
  warnings: "worth a look",
  checkFields: "check:"
});

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const plural = (n, one, many) => (n === 1 ? one : many);

// ---- the draft -> ops ---------------------------------------------------------------------------------------------------

const readPath = (obj, pointer) => String(pointer).split("/").filter(Boolean).reduce((o, k) => (isObj(o) ? o[k] : undefined), obj);
const trimmed = (v) => (typeof v === "string" ? v.trim() : "");

/**
 * The EditOps for the member's form values. `sections` are the registry sections with a `form` (editor-model.js), `drafts` maps a section id to
 * the form's current args (a cleared field is missing from them). One `set` op per field whose trimmed text differs from the record's:
 * `base` is what the bundle served (null when the record lacks the property, which `set` then creates), `value` the new text ("" clears it).
 * -> { ops, labels }: `labels` maps an op id to the field's words, for an error that names an op.
 */
export function opsFromDrafts({ key, sections, obj, drafts }) {
  const ops = [];
  const labels = {};
  for (const section of sections) {
    const form = section.form;
    const draft = drafts && drafts[section.id];
    if (!form || !isObj(draft)) continue;
    for (const [field, title] of form.fields) {
      const path = `${form.prefix}/${field}`;
      const stored = readPath(obj, path);
      const before = typeof stored === "string" ? stored : "";
      const after = trimmed(draft[field]);
      if (after === before.trim()) continue;
      const id = `${section.id}.${field}`;
      ops.push({ id, op: "set", obj: key, path, base: typeof stored === "string" ? stored : null, value: after });
      labels[id] = title;
    }
  }
  return { ops, labels };
}

/**
 * The form values to start from when the member's edits are replayed over a refetched record (a 409): the fresh record's values with only the
 * fields the member changed (against the record they edited) laid over them, so a field somebody else changed meanwhile is neither lost nor
 * silently reverted. -> { [sectionId]: args }.
 */
export function replaySeed({ sections, key, oldObj, freshObj, drafts }) {
  const { ops } = opsFromDrafts({ key, sections, obj: oldObj, drafts });
  const out = {};
  for (const section of sections) {
    if (!section.form) continue;
    const values = sectionValues(freshObj, section.form);
    for (const op of ops) {
      if (!op.id.startsWith(`${section.id}.`)) continue;
      const field = op.path.slice(section.form.prefix.length + 1);
      if (op.value === "") delete values[field];
      else values[field] = op.value;
    }
    out[section.id] = values;
  }
  return out;
}

/** How many of the ops save now and how many go to review, by the bundle's policy table (a hint: the dry run decides). */
export function countOps(ops, resolver, cls, viewer) {
  let direct = 0;
  let review = 0;
  for (const op of ops) {
    const code = resolver.resolve(cls, op.path, viewer);
    if (code === "direct") direct += 1;
    else if (code === "proposal") review += 1;
  }
  return { total: ops.length, direct, review };
}

/** The sticky bar's line: "3 changes — 2 save now, 1 goes to review". "" when nothing changed. */
export function barText({ total, direct, review }) {
  if (!total) return "";
  const parts = [];
  if (direct) parts.push(`${direct} ${plural(direct, "saves now", "save now")}`);
  if (review) parts.push(`${review} ${plural(review, "goes to review", "go to review")}`);
  return `${total} ${plural(total, "change", "changes")}${parts.length ? ` — ${parts.join(", ")}` : ""}`;
}

// ---- the requests -------------------------------------------------------------------------------------------------------

/** The Idempotency-Key of one save attempt: the same key on a retry of the same body, a fresh one for a new body. */
export function newIdempotencyKey() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The POST /api/changes body: the target, the versions the member's edits were made against, the ops and an optional note for the reviewer. */
export function changesBody({ target, version, ops, dryRun = false, note = "" }) {
  const body = { target, base_versions: { [target]: version }, ops };
  if (note) body.note = note;
  if (dryRun) body.dry_run = true;
  return body;
}

/** The POST /api/changes body for an undo: the inverse ops the 201 returned, against the versions it returned. */
export function undoBody({ target, undo }) {
  return { target, base_versions: undo.base_versions, ops: undo.ops };
}

// ---- the answers --------------------------------------------------------------------------------------------------------

const sentences = (groups) => (Array.isArray(groups) ? groups : [])
  .flatMap((g) => (isObj(g) && Array.isArray(g.summary) ? g.summary : []))
  .map((s) => (typeof s === "string" ? s : isObj(s) && typeof s.text === "string" ? s.text : ""))
  .filter(Boolean);

/** The dry run's plan as the two groups the sheet shows: { direct: string[], review: string[], warnings: string[] }. */
export function planGroups(body) {
  const plan = isObj(body) && isObj(body.plan) ? body.plan : {};
  const warnings = (isObj(body) && Array.isArray(body.warnings) ? body.warnings : [])
    .map((w) => (typeof w === "string" ? w : isObj(w) ? w.message || w.text || "" : ""))
    .filter((w) => typeof w === "string" && w);
  return { direct: sentences(plan.direct), review: sentences(plan.review), warnings };
}

/** Who looks at the "sent for review" group, in the family's words. */
export const reviewerLine = (viewer = {}) => (viewer.admin ? SAVE_COPY.reviewerAdmin : SAVE_COPY.reviewerMember);

/** The primary button of the sheet: "save" unless nothing saves now. */
export const confirmLabel = (groups) => (groups.direct.length || !groups.review.length ? SAVE_COPY.save : SAVE_COPY.sendForReview);

/**
 * The toast after a 201: { text, saved, sent, undo } where `undo` is the returned { base_versions, ops } or null (a delete offers none).
 * "saved." with "1 suggestion sent" when both happened; the "sent." line alone when only a suggestion went.
 */
export function savedToast(body, now = Date.now()) {
  const applied = isObj(body) && isObj(body.applied) ? body.applied : null;
  const proposal = isObj(body) && isObj(body.proposal) ? body.proposal : null;
  const summary = isObj(body) && Array.isArray(body.summary) ? body.summary : [];
  const reviewCount = summary.filter((s) => isObj(s) && s.route === "review").length;
  const sent = proposal ? Math.max(1, reviewCount) : 0;
  const undo = applied && isObj(applied.undo) && Array.isArray(applied.undo.ops) && applied.undo.ops.length ? applied.undo : null;
  const sentText = sent ? `${sent} ${plural(sent, "suggestion", "suggestions")} sent` : "";
  const text = applied ? (sentText ? `${SAVE_COPY.saved} ${sentText}` : SAVE_COPY.saved) : sent ? SAVE_COPY.sentOnly : SAVE_COPY.nothingToSave;
  return { text, saved: Boolean(applied), sent, undo, undoUntil: undo ? now + UNDO_WINDOW_MS : 0 };
}

/** Milliseconds left to undo, 0 when the window is over (or there is nothing to undo). */
export const undoLeftMs = (toast, now = Date.now()) => (toast && toast.undo ? Math.max(0, toast.undoUntil - now) : 0);

// ---- the errors ---------------------------------------------------------------------------------------------------------
// editing.md 8.3 (the error matrix). `retryKey` marks a body the client may resend once under a fresh Idempotency-Key; `conflict` the 409
// the flow answers by refetching the bundle and replaying the ops; `signIn` the 401s that end in a sign-in.
const TEXT = Object.freeze({
  validation: "some of these changes aren't valid. please look at the fields below.",
  not_allowed: "only an admin can change this.",
  contact_info: "this looks like a phone number, a street address or an email. please remove it.",
  dob_not_allowed: "we only keep the birth year on the site.",
  never_in_cloud: "we don't keep this on the site.",
  too_large: "please send these in smaller batches.",
  proposal_too_large: "please send these in smaller batches.",
  too_many_children: "please send these in smaller batches.",
  rate_limited: "you've sent a lot today — try again tomorrow.",
  unavailable: "the site is busy. try again in a moment.",
  not_found: "this page isn't available.",
  unauthenticated: "you've been signed out. sign in again, then come back to save.",
  step_up_required: "sign in again to confirm this change, then come back to save.",
  cycle: "that would make someone their own ancestor — please check who's who.",
  network: "we couldn't reach the site. check your connection and try again.",
  server: "something went wrong. try again in a moment."
});

/** The op ids a server `errors[]` names, from `/ops/<index>/…` pointers and `opId`s. */
function errorOpIds(errors, ops) {
  const out = [];
  for (const e of Array.isArray(errors) ? errors : []) {
    if (!isObj(e)) continue;
    let id = typeof e.opId === "string" ? e.opId : null;
    if (!id && typeof e.pointer === "string") {
      const m = /^\/ops\/(\d+)(?:\/|$)/.exec(e.pointer);
      if (m && ops[Number(m[1])]) id = ops[Number(m[1])].id;
    }
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** An ApiError (or any thrown value) as { text, fields, conflict, retryKey, signIn }. `labels` and `ops` name the fields an error points at. */
export function problemFor(err, { labels = {}, ops = [] } = {}) {
  const status = isObj(err) || err instanceof Error ? err.status : 0;
  const code = isObj(err) || err instanceof Error ? err.code : "";
  const base = { fields: [], conflict: false, retryKey: false, signIn: false };
  if (status === 409 && code === "version_conflict") return { ...base, text: SAVE_COPY.conflict, conflict: true };
  if (status === 422 && code === "idempotency_mismatch") return { ...base, text: TEXT.server, retryKey: true };
  const key = status === 0 ? "network" : TEXT[code] ? code : status === 401 ? "unauthenticated" : status === 403 ? "not_allowed" : status === 429 ? "rate_limited" : status === 413 ? "too_large" : status === 503 ? "unavailable" : status === 404 ? "not_found" : status === 400 ? "validation" : "server";
  const fields = errorOpIds(err && err.errors, ops).map((id) => labels[id]).filter(Boolean);
  return { ...base, text: TEXT[key], fields, signIn: status === 401 };
}

/** Every plain-words string above, for the copy test (no jargon, lowercase). */
export const allSaveText = () => [...Object.values(SAVE_COPY), ...Object.values(TEXT)];
