// @io-kit/comments CommentSource over the harrisonfamily /api (HFY-TSK-063). threadId is the subject, `person:<gramps_id>`.
// can.* arrives server-computed on every comment; nothing here derives it. Who may moderate comes from GET /api/me (lib/me.js), never
// from the comments (HFY-TSK-298).
import { CommentError } from "@io-kit/comments";
import { ApiError } from "./api.js";

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

const wrap = async (p, op) => {
  try { return await p; } catch (e) {
    const code = e instanceof ApiError ? (CODES.has(e.code) ? e.code : e.status === 401 ? "unauthenticated" : "server") : "server";
    const err = new CommentError(code, say(code, op), e instanceof ApiError ? e.field : undefined);
    err.cause = e;
    throw err;
  }
};

/** `onAdded(comment)` fires after the server stored a new comment (the island's 3 s "posted" ping). */
export function createHfyCommentSource(api, { onAdded } = {}) {
  const enc = encodeURIComponent;
  return {
    list: (threadId, opts = {}) => wrap(api.get("/comments", { query: { subject: threadId, cursor: opts.cursor, limit: opts.limit } }), "list"),
    async create(threadId, input) {
      const c = await wrap(api.post("/comments", { subject: threadId, body: input.body, ...(input.parentId ? { parentId: input.parentId } : {}) }), "create");
      if (onAdded) onAdded(c);
      return c;
    },
    edit: (threadId, id, input) => wrap(api.patch(`/comments/${enc(id)}`, { body: input.body }, { query: { subject: threadId } }), "edit"),
    async delete(threadId, id, opts = {}) {
      await wrap(api.del(`/comments/${enc(id)}`, { query: { subject: threadId, reason: opts.reason } }), "delete");
    },
    react(threadId, target, emoji) {
      if (!target.startsWith("comment:")) return Promise.reject(new CommentError("validation", "only comments take reactions", "target"));
      return wrap(api.post(`/comments/${enc(target.slice(8))}/react`, { subject: threadId, emoji }, { query: { subject: threadId } }), "react");
    },
  };
}
