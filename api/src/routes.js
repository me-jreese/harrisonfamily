// Route registry. One entry per action: the handler dispatches from it and scripts/gen-caps.mjs derives caps.json from it,
// so the two cannot drift. Pure data + functions: no AWS imports here.
import { HttpError, json } from "./http.js";
import { NOTIFY_TYPES } from "./notify.js";

export const API_NAME = "hfy-api";
export const API_VERSION = "0.1.0";
export const BASE_PATH = "/api";
export const SUBJECT_FORMATS = ["person:<gramps_id>", "post:<ulid>"];

/** Honest ContentSource capability declaration for the posts surface (no realtime, no since()). */
export const CONTENT_CAPABILITIES = {
  list: true,
  get: true,
  createDraft: true,
  update: true,
  setVisibility: true,
  delete: true,
  drafts: true,
  audit: true,
  subscribe: false,
  since: false,
  attachments: "metadata-only",
  filters: ["subject", "type", "author", "visibility"],
};

const ok = (body, status = 200) => ({ status, body });
const need = (v, field) => {
  if (v === undefined || v === null || v === "") throw new HttpError(400, "validation", `${field} is required`);
  return v;
};

export const ROUTES = [
  {
    name: "comments.list", method: "GET", path: "/comments", summary: "List comments on a subject, oldest first (cursor), with reactions",
    handler: async (c) => {
      const subject = need(c.query.subject, "subject");
      return ok(await c.comments.list(subject, { cursor: c.query.cursor || undefined, limit: c.query.limit ? Number(c.query.limit) : undefined })); // empty thread => empty list
    },
  },
  {
    name: "comments.create", method: "POST", path: "/comments", summary: "Create a comment or reply (parentId) on a subject",
    handler: async (c) => ok(await c.comments.create(need(c.body.subject, "subject"), { body: c.body.body, ...(c.body.parentId ? { parentId: c.body.parentId } : {}) }), 201),
  },
  {
    name: "comments.update", method: "PATCH", path: "/comments/:id", summary: "Edit your own comment (subject in body or query)",
    handler: async (c) => ok(await c.comments.edit(need(c.body.subject ?? c.query.subject, "subject"), c.params.id, { body: c.body.body })),
  },
  {
    name: "comments.delete", method: "DELETE", path: "/comments/:id", summary: "Delete your own comment; admins any (?subject=, optional ?reason=)",
    handler: async (c) => { await c.comments.delete(need(c.query.subject, "subject"), c.params.id, c.query.reason ? { reason: c.query.reason } : {}); return ok(undefined, 204); },
  },
  {
    name: "comments.react", method: "POST", path: "/comments/:id/react", summary: "Set or toggle your single emoji reaction on a comment",
    handler: async (c) => ok(await c.comments.react(need(c.body.subject ?? c.query.subject, "subject"), `comment:${c.params.id}`, c.body.emoji)),
  },
  {
    name: "posts.list", method: "GET", path: "/posts", summary: "List posts newest first (cursor; filters type, author, subject, visibility)",
    handler: async (c) => {
      const filter = {};
      for (const k of ["subject", "type", "author", "visibility"]) if (c.query[k]) filter[k] = c.query[k];
      return ok(await c.content.list({ cursor: c.query.cursor || null, limit: c.query.limit ? Number(c.query.limit) : undefined, ...(Object.keys(filter).length ? { filter } : {}) }));
    },
  },
  { name: "posts.get", method: "GET", path: "/posts/:id", summary: "Get one post", handler: async (c) => ok(await c.content.get(c.params.id)) },
  {
    name: "posts.create", method: "POST", path: "/posts", summary: "Create a post: a draft, or published at once with visibility:\"published\"",
    handler: async (c) => {
      const post = await c.content.createDraft({ type: c.body.type, visibility: c.body.visibility, subject: c.body.subject, title: c.body.title, body: c.body.body, attachments: c.body.attachments });
      if (post.visibility === "published") await c.afterPublished(post); // never fails the committed write
      return ok(post, 201);
    },
  },
  {
    name: "posts.update", method: "PATCH", path: "/posts/:id", summary: "Edit your own post",
    handler: async (c) => ok(await c.content.update(c.params.id, { title: c.body.title, subject: c.body.subject, body: c.body.body, attachments: c.body.attachments })),
  },
  {
    name: "posts.visibility", method: "POST", path: "/posts/:id/visibility", summary: "Publish, withdraw or return a post to draft",
    handler: async (c) => {
      const before = await c.content.get(c.params.id);
      const after = await c.content.setVisibility(c.params.id, c.body.visibility);
      if (before.visibility !== "published" && after.visibility === "published") await c.afterPublished(after);
      return ok(after);
    },
  },
  {
    name: "posts.delete", method: "DELETE", path: "/posts/:id", summary: "Delete your own post (admins: any)",
    handler: async (c) => { await c.content.delete(c.params.id); await c.afterPostDeleted(c.params.id); return ok(undefined, 204); },
  },
  {
    name: "uploads.presign", method: "POST", path: "/uploads", summary: "Presigned S3 PUT for a post photo (jpeg/png/webp/heic, <= 10 MB) under uploads/posts/; returns {uploadUrl, publicUrl, headers} (send headers exactly: Content-Type is signed)",
    handler: async (c) => ok(await c.uploads.presign(c.actor, { filename: c.body.filename, contentType: c.body.contentType, size: c.body.size }), 201),
  },
  // Notifications: the @io-kit/notify/server handler is mounted under /api/notifications/*.
  { name: "notifications.vapid-public-key", method: "GET", path: "/notifications/vapid-public-key", summary: "VAPID application server key", handler: (c) => c.notifyHandler() },
  { name: "notifications.subscribe", method: "POST", path: "/notifications/subscribe", summary: "Register a push subscription", handler: (c) => c.notifyHandler() },
  { name: "notifications.unsubscribe", method: "DELETE", path: "/notifications/subscribe", summary: "Remove a push subscription", handler: (c) => c.notifyHandler() },
  { name: "notifications.preferences.get", method: "GET", path: "/notifications/preferences", summary: "Read notification preferences", handler: (c) => c.notifyHandler() },
  { name: "notifications.preferences.put", method: "PUT", path: "/notifications/preferences", summary: "Save notification preferences", handler: (c) => c.notifyHandler() },
].map((r) => ({ ...r, auth: "session", write: r.method !== "GET", re: new RegExp(`^${r.path.replace(/:[a-z_]+/g, "([^/]+)")}$`), keys: [...r.path.matchAll(/:([a-z_]+)/g)].map((m) => m[1]) }));

export function matchRoute(method, path) {
  let pathMatched = false;
  for (const r of ROUTES) {
    const m = r.re.exec(path);
    if (!m) continue;
    pathMatched = true;
    if (r.method === method) return { route: r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
  }
  return { route: null, pathMatched };
}

/** Machine-readable capability document (AC2). Generated by scripts/gen-caps.mjs. */
export function buildCaps() {
  return {
    name: API_NAME,
    version: API_VERSION,
    base_path: BASE_PATH,
    auth: { scheme: "session-cookie", issuer_env: "SESSION_ISSUER", reads_require_session: true },
    subjects: SUBJECT_FORMATS,
    actions: ROUTES.map((r) => ({ name: r.name, method: r.method, path: `${BASE_PATH}${r.path}`, auth: r.auth, write: r.write, summary: r.summary })),
    content: { source: "posts", capabilities: CONTENT_CAPABILITIES, post_types: ["post", "article", "document"], visibilities: ["draft", "published", "withdrawn"] },
    comments: { reactions: "one-emoji-per-principal-per-comment", threading: "parentId (reply)", max_body: 1000, subject_param: "required on PATCH/DELETE/react (query or body)" },
    notifications: { types: NOTIFY_TYPES, default_level: 0 },
    audit: { item: "AUDIT#", fields: ["op", "id", "principal", "at", "before", "after"], ops: ["create", "update", "delete", "visibility"] },
  };
}
