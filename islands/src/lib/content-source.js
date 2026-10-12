// @io-kit/content ContentSource over /api/posts (HFY-TSK-067). Honest capabilities: the API creates drafts, but this surface
// publishes in one gesture (create + visibility:published), so it declares drafts:false and PostComposer says "Post".
import { ContentError } from "@io-kit/content";
import { ApiError } from "./api.js";

export const CAPABILITIES = { drafts: false, edit: true, subject: true, getById: true, audit: true };
const MAP = { not_found: "not_found", forbidden: "forbidden", validation: "validation", conflict: "conflict", cursor_invalid: "cursor_invalid", unavailable: "unavailable", unauthenticated: "forbidden" };
const wrap = async (p) => {
  try { return await p; } catch (e) {
    if (e instanceof ApiError) {
      const err = new ContentError(MAP[e.code] || "unavailable", e.message, e.field ? { field: e.field } : undefined);
      // The contract has no "unauthenticated" code (it maps to forbidden); the islands still need to tell signed out from
      // not allowed, to say "this page is family-only. sign in to see it." instead of the generic line.
      if (e.status === 401 || e.code === "unauthenticated") err.signedOut = true;
      throw err;
    }
    throw e instanceof ContentError ? e : new ContentError("unavailable", e?.message || "request failed");
  }
};
const enc = encodeURIComponent;
// drafts:false => this surface has no publish/withdraw gesture, so can.publish is narrowed to false (the server value stays the authority for edit/delete).
const norm = (p) => ({ ...p, can: { ...p.can, publish: false } });

export function createHfyContentSource(api) {
  return {
    capabilities: CAPABILITIES,
    async list({ cursor, filter, limit, signal } = {}) {
      const r = await wrap(api.get("/posts", { query: { cursor: cursor || undefined, limit, ...(filter || {}) }, signal }));
      return { items: r.items.map(norm), cursor: r.cursor ?? null };
    },
    get: async (id) => norm(await wrap(api.get(`/posts/${enc(id)}`))),
    async createDraft(input) {
      if (input.visibility === "draft") throw new ContentError("validation", "this surface does not keep drafts", { field: "visibility" });
      return norm(await wrap(api.post("/posts", { type: input.type, visibility: "published", subject: input.subject, title: input.title, body: input.body, attachments: input.attachments })));
    },
    update: async (id, patch) => norm(await wrap(api.patch(`/posts/${enc(id)}`, patch))),
    setVisibility() { return Promise.reject(new ContentError("unavailable", "drafts are not supported on this surface")); },
    async delete(id) { await wrap(api.del(`/posts/${enc(id)}`)); },
  };
}
