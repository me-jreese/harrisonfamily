// The review island's pure model (HFY-TSK-259, review-island; HFY-PLN-002 editing.md section 9.2, BRD2 R-06 and R-07). No DOM and no React, so
// a node test pins the words and the rules (tests/review-model.test.mjs): which tabs a viewer gets, the filter chips and what each one lists,
// the plain-words state chips, the kind badge, the per-op before -> after rows with a word-level diff, the conflict rows of a stale
// suggestion, the amend an admin's "edit then approve" (or a proposer's edit) sends, and the words for every error the routes can answer.
// Copy is lowercase, plain, and says "page" where the code says "record".
import { formatTime } from "./time.js";
import { isDestructive } from "./proposal-gate-source.js";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (typeof v === "string" ? v : "");

/** The API's cap on a note or a reason (changes.js MAX_NOTE_CHARS). */
export const REASON_MAX = 1000;

export const COPY = Object.freeze({
  title: "suggestions",
  loading: "loading suggestions",
  off: "suggestions aren't turned on yet.",
  unavailable: "suggestions aren't available yet.",
  signedOut: "sign in to see suggestions.",
  signIn: "sign in",
  loadFailed: "the suggestions didn't load. try again in a moment.",
  retry: "try again",
  detailFailed: "this suggestion didn't load, so it can't be acted on yet.",
  moreThanShown: "there are more suggestions than this list can show.",
  tabs: "suggestions",
  filters: "show",
  list: "suggestions",
  back: "back to the list",
  pickOne: "pick a suggestion to look at it.",
  checking: "checking the page",
  emptyReview: "nothing is waiting for review.",
  emptyReviewDone: "nothing here yet.",
  emptyMine: "you haven't suggested anything that's still open.",
  emptyMineDone: "nothing here yet.",
  emptyAbout: "nobody has suggested anything about your page that's still open.",
  emptyAboutDone: "nothing here yet.",
  suggestedBy: "suggested by",
  about: "about",
  note: "their note",
  warnings: "worth a look",
  edits: "what would change",
  from: "was",
  to: "now",
  conflictsH: "the page changed since",
  conflictsLead: "these parts of the page changed after the suggestion was made. pick what to keep before you approve.",
  conflictBase: "when they suggested it",
  conflictNow: "the page says now",
  conflictProposed: "they suggested",
  keepSuggested: "keep their suggestion",
  usePage: "use what the page says now",
  leaveOut: "leave this one out",
  stillApplies: "the page changed since; this suggestion still applies.",
  outOfDate: "out of date",
  approve: "approve",
  askChanges: "ask for changes",
  decline: "decline",
  editApprove: "edit then approve",
  approveAmended: "approve with these changes",
  cancel: "cancel",
  send: "send",
  saveChanges: "save my changes",
  editSuggestion: "edit my suggestion",
  withdraw: "withdraw",
  withdrawAsk: "withdraw this suggestion?",
  keep: "keep it",
  signInAgain: "you'll be asked to sign in again to confirm.",
  signInStepUp: "sign in again to confirm",
  conflictBlocks: "approve is off until you edit it: the page changed under this suggestion.",
  nothingLeft: "every change is left out, so there is nothing to approve. decline it instead.",
  askTitle: "ask for changes",
  askLabel: "what would you like changed?",
  askHelp: "they'll see this, and can edit their suggestion or reply.",
  declineTitle: "decline this suggestion",
  declineLabel: "why isn't it being added?",
  declineHelp: "they'll see this.",
  noteLabel: "a note for whoever looks at it (optional)",
  textRequired: "say a few words first, so the person can follow it.",
  noEdit: "a family connection can't be edited. withdraw it and make a new one.",
  decided: "decided",
  approvedLine: "added to the family tree.",
  working: "working on it",
  done: "done.",
  cantEditHere: "this one needs the full editor. withdraw it and make a new one.",
  gone: "we couldn't find that suggestion.",
});

// ---- the tabs --------------------------------------------------------------------------------------------------------
/** The three tabs by the id the URL uses (`?tab=`); `review` is admins' only. */
export const TAB_LABEL = Object.freeze({ review: "to review", mine: "my suggestions", about: "about my page", duplicates: "possible duplicates" });
export const TAB_IDS = Object.freeze(["review", "mine", "about", "duplicates"]);

/**
 * The tabs a viewer gets. "to review" needs an admin AND `proposalReview`: a member never has the tab, and no queue request is made for one
 * (the server enforces actor.admin whatever the flag says). "my suggestions" and "about my page" need `recordEdit`. "possible duplicates" needs an admin
 * AND `adminDelete` (the page bundle itself loads only with proposalReview or recordEdit, feature-flags.js).
 */
export function tabsFor({ admin = false, flags = {} } = {}) {
  const out = [];
  if (admin === true && flags.proposalReview === true) out.push("review");
  if (flags.recordEdit === true) out.push("mine", "about");
  // HFY-TSK-295 (Q2-15): the possible-duplicate queue for io's desktop merge, an admin's tab behind adminDelete.
  if (admin === true && flags.adminDelete === true) out.push("duplicates");
  return out;
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** `?tab=mine&p=<id>` -> { tab, id }; an unknown tab is null and an id that is not a ULID is null. */
export function parseLocation(search) {
  let q;
  try { q = new URLSearchParams(search || ""); } catch { return { tab: null, id: null }; }
  const tab = q.get("tab");
  const id = q.get("p");
  return { tab: TAB_IDS.includes(tab) ? tab : null, id: id && ULID.test(id) ? id : null };
}

/** The query string for a tab and a selected suggestion. */
export function locationFor({ tab, id }) {
  const q = new URLSearchParams();
  if (tab) q.set("tab", tab);
  if (id) q.set("p", id);
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** The tab to open: the requested one if the viewer has it, else the first they have (the queue for an admin with it on). */
export const pickTab = (tabs, wanted) => (tabs.includes(wanted) ? wanted : tabs[0] || null);

// ---- the filter chips -------------------------------------------------------------------------------------------------
const DONE = ["approved", "declined", "withdrawn", "superseded"];
/** `out of date` = a stored stale proposal, or a pending one whose page has moved on (the view's computed `stale`). */
export const isOutOfDate = (view) => Boolean(view) && (view.state === "stale" || view.stale === true);

/** The chips by tab: the proposal states each lists (`states`) and an optional `keep` over the views (the pending list splits into waiting / out of date). */
export const CHIPS = Object.freeze({
  review: Object.freeze([
    Object.freeze({ id: "waiting", label: "waiting", states: ["pending", "stale"], keep: (v) => v.state === "pending" && !isOutOfDate(v), empty: COPY.emptyReview }),
    Object.freeze({ id: "needs-changes", label: "needs changes", states: ["needs_changes"], empty: COPY.emptyReviewDone }),
    Object.freeze({ id: "out-of-date", label: "out of date", states: ["pending", "stale"], keep: isOutOfDate, empty: COPY.emptyReviewDone }),
    Object.freeze({ id: "done", label: "done", states: DONE, empty: COPY.emptyReviewDone }),
  ]),
  mine: Object.freeze([
    Object.freeze({ id: "open", label: "open", states: ["pending", "needs_changes", "stale"], empty: COPY.emptyMine }),
    Object.freeze({ id: "done", label: "done", states: DONE, empty: COPY.emptyMineDone }),
  ]),
  about: Object.freeze([
    Object.freeze({ id: "open", label: "open", states: ["pending", "needs_changes", "stale"], empty: COPY.emptyAbout }),
    Object.freeze({ id: "done", label: "done", states: DONE, empty: COPY.emptyAboutDone }),
  ]),
});

/** The API list view a tab reads. */
export const VIEW_OF = Object.freeze({ review: "queue", mine: "mine", about: "about-me" });

// ---- words for one suggestion -----------------------------------------------------------------------------------------
/** The proposer's chip (editing.md 9.2): plain words for the state, with the reason when it was declined. */
export function stateChip(view) {
  const s = view && view.state;
  const reason = view && isObj(view.decision) ? str(view.decision.reason).trim() : "";
  if (s === "pending") return view.stale === true ? "needs a quick update — the page changed" : "waiting for review";
  if (s === "needs_changes") return "an admin asked a question";
  if (s === "stale") return "needs a quick update — the page changed";
  if (s === "approved") return "added to the family tree";
  if (s === "declined" || s === "rejected") return reason ? `not added: ${reason}` : "not added";
  if (s === "withdrawn") return "withdrawn";
  if (s === "superseded") return "the page was merged or removed";
  return "";
}

/** The kind badge: edit / family connection / new person. */
export function kindBadge(view) {
  if (!view) return "edit";
  if (view.kind === "relationship") return "family connection";
  if (view.kind === "create") {
    const made = arr(view.ops).find((o) => isObj(o) && o.op === "create");
    const cls = made ? str(made.cls) || (isObj(made.value) ? str(made.value._class) : "") : "";
    return !cls || cls === "Person" ? "new person" : "new page";
  }
  return "edit";
}

const PAGE_WORD = { Person: "a person", Family: "a family", Event: "an event", Place: "a place", Source: "a source", Citation: "a citation", Repository: "a repository", Media: "a photo", Note: "a note" };
/** What the suggestion is about when the page has no name to show: "a family", "an event". */
export const pageWord = (view) => PAGE_WORD[view && view.subject && view.subject.cls] || "a page";

/** The sentence for one summary entry (a string, or the {text, opIds} the plan makes). */
const textOf = (s) => (isObj(s) ? str(s.text) : str(s));

/** The first summary sentence, for the list row. */
export function firstSentence(view) {
  const s = arr(view && view.summary).map(textOf).find(Boolean);
  return s || "a suggested change";
}

/** Every summary sentence. */
export const sentences = (view) => arr(view && view.summary).map(textOf).filter(Boolean);

/** How long ago it was made, in the one site format. */
export const ageText = (view, now = Date.now()) => formatTime(view && view.created_at, now);

/** The non-blocking warnings, as words. */
export function warningsOf(view) {
  return arr(view && view.warnings).map((w) => (isObj(w) ? str(w.text) || str(w.message) || str(w.code) : str(w))).filter(Boolean);
}

/** A suggestion that the viewer's admin step-up applies to: "you'll be asked to sign in again to confirm." */
export const needsFreshSignIn = (view) => isDestructive(view);

// ---- values and the word diff ---------------------------------------------------------------------------------------------
const MAX_VALUE_CHARS = 120;
const clip = (s) => (s.length > MAX_VALUE_CHARS ? `${s.slice(0, MAX_VALUE_CHARS - 1)}…` : s);

/** A stored value as words for the before -> after rows; null when it has no short plain form. */
export function valueText(v) {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "string") return clip(v);
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (isObj(v)) {
    if (v._class === "Name" || typeof v.first_name === "string") {
      const last = arr(v.surname_list).map((s) => (isObj(s) ? str(s.surname) : "")).filter(Boolean)[0] || "";
      const full = [str(v.first_name), last].filter(Boolean).join(" ");
      return full ? clip(full) : null;
    }
    if (v._class === "Date" || Array.isArray(v.dateval)) {
      const [day, month, year] = arr(v.dateval);
      const parts = [day, month, year].filter((x) => Number.isInteger(x) && x > 0);
      return parts.length ? parts.join("-") : str(v.text) || null;
    }
  }
  return null;
}

/**
 * A word-level diff of two strings for a name edit: [{ t: "same" | "del" | "add", text }]. Longest common run of words; whitespace is
 * normalised to single spaces. Equal inputs are one "same" part.
 */
export function wordDiff(before, after) {
  const a = str(before).split(/\s+/).filter(Boolean);
  const b = str(after).split(/\s+/).filter(Boolean);
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) for (let j = m - 1; j >= 0; j -= 1) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const parts = [];
  const push = (t, text) => {
    const last = parts[parts.length - 1];
    if (last && last.t === t) last.text += ` ${text}`;
    else parts.push({ t, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { push("same", a[i]); i += 1; j += 1; } else if (dp[i + 1][j] >= dp[i][j + 1]) { push("del", a[i]); i += 1; } else { push("add", b[j]); j += 1; }
  }
  while (i < n) { push("del", a[i]); i += 1; }
  while (j < m) { push("add", b[j]); j += 1; }
  return parts;
}

/**
 * The per-op rows of the detail card: { id, text, before, after, diff, set }. `text` is the plan's sentence for the op; a `set` op with short
 * plain values also has `before` and `after` (null for an empty value) and the word `diff` of the two.
 */
export function opRows(view) {
  const said = new Map();
  for (const s of arr(view && view.summary)) if (isObj(s)) for (const id of arr(s.opIds)) if (!said.has(id)) said.set(id, str(s.text));
  const ops = arr(view && view.ops).filter(isObj);
  return ops.map((op, i) => {
    const before = op.op === "set" ? valueText(op.base) : null;
    const after = op.op === "set" ? valueText(op.value) : null;
    const plain = op.op === "set" && (before !== null || after !== null);
    return {
      id: str(op.id) || `op-${i}`,
      text: said.get(op.id) || (said.size ? "" : textOf(arr(view && view.summary)[i])) || "a change",
      set: plain,
      before: plain ? before : null,
      after: plain ? after : null,
      diff: plain && before !== null && after !== null ? wordDiff(before, after) : null,
    };
  });
}

// ---- which copy of a suggestion is newer ------------------------------------------------------------------------------------
/**
 * Is `a` a newer read of the same suggestion than `b`? A higher `rev` (an edit) wins, then a later `updated_at` (a decision or a withdrawal keep the
 * rev). Equal reads are not newer. The list comes from an index that can lag the suggestion itself, so a card the island holds from a conflict, an edit
 * or a decision is kept until the list has caught up with it.
 */
export function isNewer(a, b) {
  if (!isObj(a)) return false;
  if (!isObj(b)) return true;
  const ra = Number.isInteger(a.rev) ? a.rev : 0;
  const rb = Number.isInteger(b.rev) ? b.rev : 0;
  if (ra !== rb) return ra > rb;
  const ta = Date.parse(a.updated_at);
  const tb = Date.parse(b.updated_at);
  return Number.isFinite(ta) && Number.isFinite(tb) ? ta > tb : false;
}

/** The card to show: the held `override` unless the listed card is newer than it. */
export function pickCard(listed, override) {
  if (!override) return listed;
  if (!listed) return override;
  return isNewer(listed.hfy, override.hfy) ? listed : override;
}

// ---- the stale card: conflict rows ------------------------------------------------------------------------------------------
/** The rebase info of GET /api/proposals/:id: { status: "current" | "clean" | "conflict", conflicts[] }, defaulting to "current" with no rows. */
export function rebaseOf(detail) {
  const r = detail && isObj(detail.rebase) ? detail.rebase : {};
  const status = r.status === "conflict" || r.status === "clean" ? r.status : "current";
  return { status, conflicts: arr(r.conflicts).filter(isObj) };
}

/** The per-op conflict rows: the op's sentence, and what it said when suggested, what the page says now, and what they suggested. */
export function conflictRows(view, rebase) {
  const rows = opRows(view);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ops = new Map(arr(view && view.ops).filter(isObj).map((o) => [o.id, o]));
  return arr(rebase && rebase.conflicts).map((c, i) => {
    const row = byId.get(c.opId);
    const op = ops.get(c.opId);
    return {
      id: str(c.opId) || `conflict-${i}`,
      opId: str(c.opId),
      text: row ? row.text : "a change",
      gone: c.reason === "deleted",
      base: valueText(c.base),
      current: valueText(c.current),
      proposed: valueText(c.proposed !== undefined ? c.proposed : op && op.value),
      // "keep their suggestion" is offered where the op can be re-based onto the page: a `set` of a short plain value, on a page that still exists.
      canKeep: Boolean(op) && op.op === "set" && c.reason !== "deleted",
    };
  });
}

/**
 * The value at a plain property pointer (`/primary_name/first_name`) in a stored object, for a proposer who is shown no stored values in a conflict:
 * { found, value }. A pointer with a keyed list segment (`@ref=…`, `@k=…`) is not resolved here (found: false).
 */
export function resolvePath(obj, path) {
  const segs = str(path).split("/").slice(1).map((x) => x.replace(/~1/g, "/").replace(/~0/g, "~"));
  let cur = obj;
  for (const seg of segs) {
    if (seg.startsWith("@") || cur === null || typeof cur !== "object" || !Object.hasOwn(cur, seg)) return { found: false, value: undefined };
    cur = cur[seg];
  }
  return { found: segs.length > 0, value: cur };
}

/** Is approve off? A conflicting rebase blocks it until an amend has been made (editing.md 7.5: "edit then approve"). */
export const approveBlocked = (rebase) => Boolean(rebase) && rebase.status === "conflict";

// ---- the amend ------------------------------------------------------------------------------------------------------------
/** The keys (`Class:handle`) of the stored objects the ops address; an object an op creates (`new:n`) has none. */
export function touchedKeys(ops) {
  const out = new Set();
  for (const op of arr(ops)) {
    const k = isObj(op) ? str(op.obj) : "";
    if (k && !/^new:\d+$/.test(k)) out.add(k);
  }
  return [...out].sort();
}

/**
 * `{ ops, base_versions }` for approve-with-amend (admin) or PATCH (proposer).
 *   view     the ProposalView
 *   rebase   its rebase info (rebaseOf)
 *   choices  opId -> "keep" | "page" for each conflicting op (`keep`: their suggestion stays, re-based onto what the page says now; `page`: left out)
 *   values   opId -> the edited text of a `set` op whose value is a short plain string
 *   leaveOut Set of opIds the editor left out
 *   versions the fresh version of each touched object ({ "Class:handle": n })
 * A kept conflicting `set` op takes the page's current value as its `base`, and a `base_version` it carries becomes the fresh version.
 */
export function buildAmend({ view, rebase, choices = {}, values = {}, leaveOut = new Set(), versions = {} }) {
  const conflicts = new Map(arr(rebase && rebase.conflicts).map((c) => [c.opId, c]));
  const ops = [];
  for (const op of arr(view && view.ops).filter(isObj)) {
    const c = conflicts.get(op.id);
    if (leaveOut.has(op.id)) continue;
    if (c && choices[op.id] !== "keep") continue;
    let next = { ...op };
    if (c && op.op === "set" && "current" in c) next.base = c.current === undefined ? null : c.current;
    if (op.op === "set" && typeof values[op.id] === "string" && typeof op.value === "string") next.value = values[op.id];
    if ("base_version" in next && Number.isInteger(versions[str(op.obj)])) next.base_version = versions[str(op.obj)];
    ops.push(next);
  }
  const base_versions = {};
  for (const k of touchedKeys(ops)) if (Number.isInteger(versions[k])) base_versions[k] = versions[k];
  return { ops, base_versions };
}

/** Is the amend form ready to send? Every conflicting op has a choice, and something is left to approve. */
export function amendReady({ view, rebase, choices = {}, leaveOut = new Set() }) {
  const conflicts = arr(rebase && rebase.conflicts);
  if (conflicts.some((c) => c.reason !== "deleted" && choices[c.opId] !== "keep" && choices[c.opId] !== "page")) return { ok: false, why: "pick" };
  const left = arr(view && view.ops).filter((op) => isObj(op) && !leaveOut.has(op.id) && !(conflicts.some((c) => c.opId === op.id) && choices[op.id] !== "keep"));
  if (!left.length) return { ok: false, why: "empty" };
  return { ok: true, why: "" };
}

/** Can the proposer or admin edit this suggestion's values? A relationship suggestion keeps its intent and is not amendable (409 not_amendable). */
export const amendable = (view) => Boolean(view) && view.kind !== "relationship";

// ---- reasons ---------------------------------------------------------------------------------------------------------------
/** "" when the reason is fine, else the line to show: a decline or a request for changes needs a few words. */
export function reasonProblem(text) {
  const t = str(text).trim();
  if (!t) return COPY.textRequired;
  if (t.length > REASON_MAX) return `that's too long. please keep it to ${REASON_MAX} characters.`;
  return "";
}
export const reasonCountText = (n) => `${n} of ${REASON_MAX} characters`;

// ---- the errors -----------------------------------------------------------------------------------------------------------------
const TEXT = Object.freeze({
  not_admin: "only an admin can do that.",
  not_allowed: "only the person who made the suggestion can do that.",
  validation: "that didn't look right. please check what you wrote.",
  contact_info: "this looks like a phone number, a street address or an email. please remove it.",
  dob_not_allowed: "we only keep the birth year on the site.",
  never_in_cloud: "we don't keep this on the site.",
  rebase_conflict: "the page changed again while you looked. the card is up to date now: please look it over and try again.",
  invalid_state: "someone has already handled this one.",
  not_amendable: "this one can't be edited any more.",
  precondition_failed: "this suggestion changed while you looked. here is the latest.",
  precondition_required: "something went wrong. please reload the page and try again.",
  idempotency_mismatch: "something went wrong. please try again.",
  too_large: "that's too big to send in one go.",
  not_found: "we couldn't find that suggestion.",
  unauthenticated: "you've been signed out. sign in again, then come back.",
  step_up_required: "sign in again to confirm this, then come back and approve it.",
  rate_limited: "that's a lot at once. please try again in a little while.",
  unavailable: "the site is busy. try again in a moment.",
  network: "we couldn't reach the site. check your connection and try again.",
  server: "something went wrong. try again in a moment.",
});

/** An error from the routes as { text, signIn, stepUp, conflict }: `signIn` and `stepUp` mark the cases that end in a sign-in link. */
export function problemOf(err) {
  const status = err && typeof err === "object" ? err.status : 0;
  const code = err && typeof err === "object" ? str(err.code) : "";
  const stepUp = code === "step_up_required";
  const key = status === 0 && !code ? "network"
    : TEXT[code] ? code
      : status === 401 ? "unauthenticated" : status === 403 ? "not_admin" : status === 404 ? "not_found" : status === 409 ? "invalid_state"
        : status === 412 ? "precondition_failed" : status === 400 || status === 422 ? "validation" : status === 429 ? "rate_limited" : status === 503 ? "unavailable" : "server";
  return { text: TEXT[key], signIn: status === 401 || stepUp, stepUp, conflict: code === "rebase_conflict" || status === 412 };
}

/** The sign-in link for a step-up (a fresh sign-in, no older than 15 minutes) or a plain one, coming back to the same list or card. */
export function signInHref(fresh, here) {
  return `/auth/login?${fresh ? "prompt=login&" : ""}returnTo=${encodeURIComponent(here)}`;
}

/** Every plain-words string above, for the copy test (lowercase, no jargon). */
export const allReviewText = () => [...Object.values(COPY), ...Object.values(TEXT), ...Object.values(TAB_LABEL)];
