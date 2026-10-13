// Route registry. One entry per action: the handler dispatches from it and scripts/gen-caps.mjs derives caps.json from it,
// so the two cannot drift. Pure data + functions: no AWS imports here.
import { HttpError, json } from "./http.js";
import { NOTIFY_TYPES } from "./notify.js";
import { buildMe } from "./me.js";
import { describeGate, gateExempt } from "./features.js";

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

// MCP tools are derived from this registry: a route with an `mcp` member becomes the tool `mcp.tool`, keyed in the policy table by the route name.
// `args` maps the tool arguments onto the same {params, query, body} the HTTP handler receives, so the tool runs the route's own handler (and Q-4,
// validation, audit and notifications). Tool names use underscores only (MCP-C11) and equal the parity caps action name (L-01).
export const MCP_RESOURCE = "https://harrisonfamily.us/mcp";
const str = (description) => ({ type: "string", description });
const schema = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const pageArgs = { cursor: str("Opaque cursor from a previous page"), limit: { type: "integer", minimum: 1, maximum: 100 } };
const pick = (a, keys) => Object.fromEntries(keys.filter((k) => a[k] !== undefined && a[k] !== "").map((k) => [k, a[k]]));
const MCP = {
  "comments.list": { tool: "hfy_comments_list", description: "List comments on a subject (person:<gramps_id> or post:<ulid>), oldest first, with reactions.",
    input: schema({ subject: str("person:<gramps_id> or post:<ulid>"), ...pageArgs }, ["subject"]), args: (a) => ({ query: pick(a, ["subject", "cursor", "limit"]) }) },
  "comments.create": { tool: "hfy_comments_create", description: "Create a comment (or a reply with parentId) on a subject.",
    input: schema({ subject: str("person:<gramps_id> or post:<ulid>"), body: { type: "string", maxLength: 1000 }, parentId: str("Comment id to reply to") }, ["subject", "body"]),
    args: (a) => ({ body: pick(a, ["subject", "body", "parentId"]) }) },
  "comments.delete": { tool: "hfy_comments_delete", description: "Delete any comment. Requires hfy-admin and a fresh step-up (a user-verified sign-in, amr mfa, within 5 minutes).",
    input: schema({ subject: str("person:<gramps_id> or post:<ulid>"), id: str("Comment id"), reason: str("Optional audit reason") }, ["subject", "id"]),
    args: (a) => ({ params: { id: a.id }, query: pick(a, ["subject", "reason"]) }) },
  "posts.list": { tool: "hfy_posts_list", description: "List posts, newest first (filters: subject, type, author, visibility).",
    input: schema({ subject: str("Record id"), type: { enum: ["post", "article", "document"] }, author: str("gramps_id"), visibility: { enum: ["draft", "published", "withdrawn"] }, ...pageArgs }),
    args: (a) => ({ query: pick(a, ["subject", "type", "author", "visibility", "cursor", "limit"]) }) },
  "posts.get": { tool: "hfy_posts_get", description: "Get one post by id.", input: schema({ id: str("Post id") }, ["id"]), args: (a) => ({ params: { id: a.id } }) },
  "posts.create": { tool: "hfy_posts_create", description: "Create a post as a DRAFT. Publishing is a human action in the site UI; there is no visibility argument.",
    input: schema({ type: { enum: ["post", "article", "document"] }, subject: str("Record id the post is about"), title: { type: "string", maxLength: 200 }, body: str("Post body") }, ["body"]),
    args: (a) => ({ body: { ...pick(a, ["type", "subject", "title", "body"]), visibility: "draft" } }) },
  "posts.delete": { tool: "hfy_posts_delete", description: "Delete any post and its discussion. Requires hfy-admin and a fresh step-up (a user-verified sign-in, amr mfa, within 5 minutes).",
    input: schema({ id: str("Post id") }, ["id"]), args: (a) => ({ params: { id: a.id } }) },
};
const need = (v, field) => {
  if (v === undefined || v === null || v === "") throw new HttpError(400, "validation", `${field} is required`);
  return v;
};

/**
 * HFY-TSK-238 (api-feature-gate AC3): every PLN-002 route carries `gate`: requireFeature(flag) or serverSwitch(name, check) from
 * src/features.js. The only exemption is me.get (gateExempt, BRD2 10.1). The PLN-001 routes below predate the gate and carry none;
 * test/features.test.js pins that list, so a new route without a gate fails the caps test.
 */
export const ROUTES = defineRoutes([
  {
    name: "me.get", method: "GET", path: "/me", summary: "Who you are: id, label, admin, server-computed can.*, and admin badges (no MCP tool)",
    gate: gateExempt("identity route: every surface reads it before it knows which flags are on (BRD2 10.1, io-approved)"),
    handler: async (c) => ok(await buildMe(c.actor, { accessRequestCount: c.accessRequestCount, log: c.log })),
  },
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
    name: "uploads.presign", method: "POST", path: "/uploads", summary: "Presigned S3 PUT for a post photo (jpeg/png/webp/heic, <= 10 MB) at uploads/posts/<ulid>/photo.<ext>, bound to you for 24 h; returns {uploadUrl, publicUrl, headers} (send headers exactly: Content-Type is signed)",
    handler: async (c) => ok(await c.uploads.presign(c.actor, { contentType: c.body.contentType, size: c.body.size }), 201),
  },
  // Notifications: the @io-kit/notify/server handler is mounted under /api/notifications/*.
  { name: "notifications.vapid-public-key", method: "GET", path: "/notifications/vapid-public-key", summary: "VAPID application server key", handler: (c) => c.notifyHandler() },
  { name: "notifications.subscribe", method: "POST", path: "/notifications/subscribe", summary: "Register a push subscription", handler: (c) => c.notifyHandler() },
  { name: "notifications.unsubscribe", method: "DELETE", path: "/notifications/subscribe", summary: "Remove a push subscription", handler: (c) => c.notifyHandler() },
  { name: "notifications.preferences.get", method: "GET", path: "/notifications/preferences", summary: "Read notification preferences", handler: (c) => c.notifyHandler() },
  { name: "notifications.preferences.put", method: "PUT", path: "/notifications/preferences", summary: "Save notification preferences", handler: (c) => c.notifyHandler() },
]);

/** Normalizes registry entries (MCP member, auth, write, path matcher). Exported so tests can mount extra routes through the same shape. */
export function defineRoutes(list) {
  return list.map((r) => ({ ...r, ...(MCP[r.name] ? { mcp: MCP[r.name] } : {}), auth: "session", write: r.method !== "GET", re: new RegExp(`^${r.path.replace(/:[a-z_]+/g, "([^/]+)")}$`), keys: [...r.path.matchAll(/:([a-z_]+)/g)].map((m) => m[1]) }));
}

/** `candidates`: every route whose path matched (any method), so the handler can tell 405 from a dark path that must stay 404. */
export function matchRoute(method, path, routes = ROUTES) {
  const candidates = [];
  for (const r of routes) {
    const m = r.re.exec(path);
    if (!m) continue;
    candidates.push(r);
    if (r.method === method) return { route: r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])), pathMatched: true, candidates };
  }
  return { route: null, pathMatched: candidates.length > 0, candidates };
}

/** Machine-readable capability document (AC2). Generated by scripts/gen-caps.mjs. */
export function buildCaps() {
  return {
    name: API_NAME,
    version: API_VERSION,
    base_path: BASE_PATH,
    auth: { scheme: "session-cookie", issuer_env: "SESSION_ISSUER", reads_require_session: true },
    subjects: SUBJECT_FORMATS,
    actions: ROUTES.map((r) => ({ name: r.name, method: r.method, path: `${BASE_PATH}${r.path}`, auth: r.auth, write: r.write, summary: r.summary, ...(r.gate ? { gate: describeGate(r.gate) } : {}) })),
    content: { source: "posts", capabilities: CONTENT_CAPABILITIES, post_types: ["post", "article", "document"], visibilities: ["draft", "published", "withdrawn"] },
    comments: { reactions: "one-emoji-per-principal-per-comment", threading: "parentId (reply)", max_body: 1000, subject_param: "required on PATCH/DELETE/react (query or body)" },
    mcp: { resource: MCP_RESOURCE, tools: ROUTES.filter((r) => r.mcp).map((r) => ({ name: r.mcp.tool, action: r.name, write: r.write })) },
    notifications: { types: NOTIFY_TYPES, default_level: 0 },
    audit: { item: "AUDIT#", fields: ["op", "id", "principal", "at", "before", "after"], ops: ["create", "update", "delete", "visibility"] },
  };
}
