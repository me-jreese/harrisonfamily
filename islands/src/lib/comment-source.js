// @io-kit/comments CommentSource over the harrisonfamily /api (HFY-TSK-063). threadId is the subject, `person:<gramps_id>`.
// can.* arrives server-computed on every comment; nothing here derives it. Who may moderate comes from GET /api/me (lib/me.js), never
// from the comments (HFY-TSK-298).
import { CommentError } from "@io-kit/comments";
import { ApiError } from "./api.js";
import { GUARD_CODES, GUARD_COPY, learnFromRefusal, precheck } from "./contact-precheck.js";
import { PHOTO_COPY } from "./photo.js";
import { COPY as MOD_COPY, commentTarget, createModerationClient, errorLine, versionOf } from "./moderation.js";

const CODES = new Set(["unauthenticated", "forbidden", "not_found", "validation", "step_up_required", "self_react", "cursor_invalid", "server"]);

// DS Voice: the kit Thread shows err.message as-is (describeError), so the message is the family-facing line; the code, field and
// the server's own message (on `cause`) are unchanged for the contract and the console.
const COPY = {
  failed: "that didn't work. try again, or text J.",
  notPosted: "that didn't post. it's still here — try again.",
  signedOut: "you got signed out. sign in again?",
  stepUp: "just to be safe, sign in again to change this.",
};
const say = (code, op) => (code === "unauthenticated" ? COPY.signedOut : code === "step_up_required" ? COPY.stepUp : op === "create" ? COPY.notPosted : COPY.failed);

// R-18 (privacy-guard-existing-paths): the API's 422 contact_info / dob_not_allowed is shown with its DS copy, and the text stays
// in the composer (the kit keeps it on a failed add or save). Not "try again": the same text would be refused again.
// HFY-TSK-187 (BRD2 9.4): a photo the API refused at post time. photo_has_location is a stored photo whose bytes still say where it was
// taken (the browser re-encode normally prevents it); upload_missing and upload_not_owned are a HEAD mismatch or an upload that is not
// this member's, so the photo has to be added again. The comment text stays in the composer (the kit keeps it on a failed add).
const PHOTO_REFUSALS = { photo_has_location: PHOTO_COPY.location, upload_missing: PHOTO_COPY.missing, upload_not_owned: PHOTO_COPY.missing };
const wrap = async (p, op) => {
  try { return await p; } catch (e) {
    if (e instanceof ApiError && GUARD_CODES.includes(e.code)) {
      learnFromRefusal(e.code);
      const err = new CommentError("validation", GUARD_COPY[e.code], "body");
      err.cause = e;
      throw err;
    }
    if (e instanceof ApiError && Object.hasOwn(PHOTO_REFUSALS, e.code)) {
      const err = new CommentError("validation", PHOTO_REFUSALS[e.code], "attachments");
      err.cause = e;
      throw err;
    }
    const code = e instanceof ApiError ? (CODES.has(e.code) ? e.code : e.status === 401 ? "unauthenticated" : "server") : "server";
    const err = new CommentError(code, say(code, op), e instanceof ApiError ? e.field : undefined);
    err.cause = e;
    throw err;
  }
};

/**
 * The composer's own pre-check (lib/contact-guard.js, drawing lib/contact-precheck.js) normally keeps a refused text from being sent at all; this is the last
 * client step before the request, so a text that slipped past the DOM (a keyboard path the decoration missed) is still held here.
 * Throws (or, for edit, returns a rejected promise) with the DS copy; returns undefined for a clean text.
 */
function refuseContactInfo(body, asPromise = false) {
  const v = precheck(body);
  if (!v) return undefined;
  const err = new CommentError("validation", v.message, "body");
  if (asPromise) return Promise.reject(err);
  throw err;
}

// The kit's error code for a refused moderation call (its row error shows the message, which is the DS line).
function moderationCode(e) {
  if (!(e instanceof ApiError)) return "server";
  if (e.code === "self_moderation") return "self_moderation";
  if (e.code === "contact_info" || e.code === "dob_not_allowed") return "validation";
  return e.status === 403 ? "forbidden" : e.status === 404 ? "not_found" : "server";
}

/**
 * `onAdded(comment)` fires after the server stored a new comment (the island's 3 s "posted" ping).
 * `moderation: true` (flag moderationV1, HFY-TSK-191) adds the kit's optional `moderate(threadId, id, {action, note?, hide?})`: POST /api/moderation
 * for the comment, resolving the comment as this admin now sees it; `onModerated(input)` fires after the server accepted it (the island's ping).
 * A refusal rejects with a CommentError whose message is the DS line, which the kit shows under the comment while its form stays open.
 */
export function createHfyCommentSource(api, { onAdded, moderation = false, onModerated } = {}) {
  const enc = encodeURIComponent;
  const client = createModerationClient(api);
  // The version an admin saw (edited_at, else created_at) goes with the action: the server answers 409 when the comment moved since.
  const seen = new Map();
  const remember = (r) => {
    for (const c of r?.thread?.comments ?? []) seen.set(c.id, c);
    return r;
  };
  return {
    // `order` (asc, the default, or desc) goes through as GET /api/comments?order=; a cursor is bound to the order that issued it.
    list: (threadId, opts = {}) => wrap(api.get("/comments", { query: { subject: threadId, cursor: opts.cursor, limit: opts.limit, order: opts.order } }), "list").then(remember),
    ...(moderation ? {
      async moderate(threadId, id, input) {
        let r;
        try {
          r = await client.act(commentTarget(threadId, id), input, versionOf(seen.get(id)));
        } catch (e) {
          const err = new CommentError(moderationCode(e), await errorLine(e), input.action === "ask" || input.action === "request_changes" ? "note" : undefined);
          err.cause = e;
          throw err;
        }
        const next = r?.item;
        if (!next || typeof next !== "object") throw new CommentError("server", MOD_COPY.failed);
        seen.set(id, next);
        onModerated?.(input, r);
        return next;
      },
    } : {}),
    async create(threadId, input) {
      refuseContactInfo(input.body);
      const photos = Array.isArray(input.attachments) && input.attachments.length ? input.attachments : null;
      // The last client step for the photo captions too (the composer's own pre-check normally holds a hit before it gets here).
      for (const a of photos ?? []) refuseContactInfo(a.alt);
      const c = await wrap(api.post("/comments", { subject: threadId, body: input.body, ...(photos ? { attachments: photos } : {}), ...(input.parentId ? { parentId: input.parentId } : {}) }), "create");
      if (onAdded) onAdded(c);
      return c;
    },
    edit: (threadId, id, input) => refuseContactInfo(input.body, true) || wrap(api.patch(`/comments/${enc(id)}`, { body: input.body }, { query: { subject: threadId } }), "edit"),
    async delete(threadId, id, opts = {}) {
      await wrap(api.del(`/comments/${enc(id)}`, { query: { subject: threadId, reason: opts.reason } }), "delete");
    },
    react(threadId, target, emoji) {
      if (!target.startsWith("comment:")) return Promise.reject(new CommentError("validation", "only comments take reactions", "target"));
      return wrap(api.post(`/comments/${enc(target.slice(8))}/react`, { subject: threadId, emoji }, { query: { subject: threadId } }), "react");
    },
  };
}
