// @io-kit/comments CommentSource over the harrisonfamily /api (HFY-TSK-063). threadId is the subject, `person:<gramps_id>`.
// can.* arrives server-computed on every comment; nothing here derives it.
import { CommentError } from "@io-kit/comments";
import { ApiError } from "./api.js";

const CODES = new Set(["unauthenticated", "forbidden", "not_found", "validation", "step_up_required", "self_react", "cursor_invalid", "server"]);
const wrap = async (p) => {
  try { return await p; } catch (e) {
    if (e instanceof ApiError) throw new CommentError(CODES.has(e.code) ? e.code : e.status === 401 ? "unauthenticated" : "server", e.message, e.field);
    throw new CommentError("server", e?.message || "request failed");
  }
};

/** `onList(comments)` lets the host observe loaded comments (the island infers moderator rights from can.delete). */
export function createHfyCommentSource(api, { onList } = {}) {
  const enc = encodeURIComponent;
  return {
    async list(threadId, opts = {}) {
      const r = await wrap(api.get("/comments", { query: { subject: threadId, cursor: opts.cursor, limit: opts.limit } }));
      if (onList) onList(r.thread.comments);
      return r;
    },
    create: (threadId, input) => wrap(api.post("/comments", { subject: threadId, body: input.body, ...(input.parentId ? { parentId: input.parentId } : {}) })),
    edit: (threadId, id, input) => wrap(api.patch(`/comments/${enc(id)}`, { body: input.body }, { query: { subject: threadId } })),
    async delete(threadId, id, opts = {}) {
      await wrap(api.del(`/comments/${enc(id)}`, { query: { subject: threadId, reason: opts.reason } }));
    },
    react(threadId, target, emoji) {
      if (!target.startsWith("comment:")) return Promise.reject(new CommentError("validation", "only comments take reactions", "target"));
      return wrap(api.post(`/comments/${enc(target.slice(8))}/react`, { subject: threadId, emoji }, { query: { subject: threadId } }));
    },
  };
}
