// Route registry. One entry per action: the handler dispatches from it and scripts/gen-caps.mjs derives caps.json from it,
// so the two cannot drift. Pure data + functions: no AWS imports here.
import { HttpError, json } from "./http.js";
import { NOTIFY_TYPES } from "./notify.js";
import { buildMe } from "./me.js";
import { describeGate, gateExempt, requireFeature } from "./features.js";
import { SYNC_ROUTES } from "./sync/routes.js";
import { recordByGrampsId, recordGet, recordsGate } from "./records/read.js";
import { bundleGet, editingGate, meEditingExtras, schemaGet } from "./records/edit-bundle.js";
import { changesPost } from "./records/changes.js";
import { relationshipsPost, relationshipsPreview } from "./records/relationship-routes.js";
import { proposalsAmend, proposalsGet, proposalsList, proposalsWithdraw } from "./records/proposal-store.js";
import { proposalsDecide } from "./records/proposal-decision.js";
import { SYNC_AUDIENCE, SYNC_CLIENT_ID, SYNC_ISSUER } from "./sync/auth.js";
import { ACCEPTED_GRAMPS, DEFAULT_ACCEPTED_SCHEMA, DEFAULT_MIN_CLIENT, HEADERS, LIMITS } from "./sync/guard.js";

export const API_NAME = "hfy-api";
export const API_VERSION = "0.1.0";
export const BASE_PATH = "/api";
export const SUBJECT_FORMATS = ["person:<gramps_id>", "post:<ulid>", "proposal:<ulid>"];

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
/** commentPhotosV1 (hfy-comments-photos-desc-api): comment photos are dark until the flag is on (or the caller is uat): 404 like a dark route. */
const commentPhotos = async (c) => {
  if (!(await c.featureOn("commentPhotosV1"))) throw new HttpError(404, "not_found", "no such route");
};

// MCP tools are derived from this registry: a route with an `mcp` member becomes the tool `mcp.tool`, keyed in the policy table by the route name.
// `args` maps the tool arguments onto the same {params, query, body} the HTTP handler receives, so the tool runs the route's own handler (and Q-4,
// validation, audit and notifications). Tool names use underscores only (MCP-C11) and equal the parity caps action name (L-01).
export const MCP_RESOURCE = "https://harrisonfamily.us/mcp";
const str = (description) => ({ type: "string", description });
const schema = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const pageArgs = { cursor: str("Opaque cursor from a previous page"), limit: { type: "integer", minimum: 1, maximum: 100 } };
const pick = (a, keys) => Object.fromEntries(keys.filter((k) => a[k] !== undefined && a[k] !== "").map((k) => [k, a[k]]));
const MCP = {
  "comments.list": { tool: "hfy_comments_list", description: "List comments on a subject (person:<gramps_id> or post:<ulid>), oldest first by default; order=desc for newest first (a cursor works only with the order that issued it), with reactions.",
    input: schema({ subject: str("person:<gramps_id> or post:<ulid>"), order: { enum: ["asc", "desc"], description: "asc (oldest first, the default) or desc (newest first)" }, ...pageArgs }, ["subject"]), args: (a) => ({ query: pick(a, ["subject", "order", "cursor", "limit"]) }) },
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
    handler: async (c) => ok(await buildMe(c.actor, { accessRequestCount: c.accessRequestCount, log: c.log, extras: meEditingExtras(c.store, { log: c.log }) })),
  },
  {
    name: "links.get", method: "GET", path: "/people/:id/links", summary: "A person's profile links, their version and whether you can edit them (no MCP tool)",
    gate: requireFeature("profileLinks"),
    handler: async (c) => ok(await c.links.get(c.params.id)),
  },
  {
    name: "links.put", method: "PUT", path: "/people/:id/links", summary: "Set or clear profile links ({links: {platform: string|null}, version}): the owner sets or clears, an admin only clears (no MCP tool)",
    gate: requireFeature("profileLinks"),
    handler: async (c) => ok(await c.links.put(c.params.id, c.body)),
  },
  // The contributions read side (hfy-contrib-read-api; social.md 7.5), dark until contribV1 is on (or the caller is uat). No `mcp` member and
  // no policy row. contributions.stats and contributions.site share a path: `?author=` picks the first, its absence the second.
  {
    name: "contributions.list", method: "GET", path: "/contributions", summary: "A member's contributions, newest first (author required; cursor, limit 1-50, default 10): hidden events only to the author and admins, events on a post or proposal thread only to viewers who can see it (no MCP tool)",
    gate: requireFeature("contribV1"),
    handler: async (c) => ok(await c.contrib.list(c.query.author, { cursor: c.query.cursor || undefined, limit: c.query.limit })),
  },
  {
    name: "contributions.stats", method: "GET", path: "/contributions/stats", summary: "A member's contribution counters (?author=; zeros for an unknown member; no MCP tool)",
    gate: requireFeature("contribV1"), when: (q) => Boolean(q.author),
    handler: async (c) => ok(await c.contrib.stats(c.query.author)),
  },
  {
    name: "contributions.site", method: "GET", path: "/contributions/stats", summary: "The site's contribution total and the feed line (without ?author=): line is null when no window reaches 3 (no MCP tool)",
    gate: requireFeature("contribV1"), when: (q) => !q.author,
    handler: async (c) => ok(await c.contrib.site()),
  },
  // Record follows (hfy-record-subs-api; social.md section 6, R-12), dark until recordSubsV1 is on (or the caller is uat). No `mcp` member and no
  // policy row. The remove route is subscriptions.remove, never *.delete, which the policy glob would read as an admin step-up action.
  // subscriptions.get and subscriptions.list share a path: `?subject=` picks the first, its absence the second.
  {
    name: "subscriptions.get", method: "GET", path: "/subscriptions", summary: "Am I following ?subject=person:<id>? {subject, subscribed} (no MCP tool)",
    gate: requireFeature("recordSubsV1"), when: (q) => q.subject !== undefined,
    handler: async (c) => ok(await c.subscriptions.get(c.query.subject)),
  },
  {
    name: "subscriptions.list", method: "GET", path: "/subscriptions", summary: "The pages I follow, newest first (cursor, limit 1-100, default 25): {items: [{subject, created_at}], cursor} (no MCP tool)",
    gate: requireFeature("recordSubsV1"), when: (q) => q.subject === undefined,
    handler: async (c) => ok(await c.subscriptions.list({ cursor: c.query.cursor || undefined, limit: c.query.limit })),
  },
  {
    name: "subscriptions.put", method: "PUT", path: "/subscriptions/person/:id", summary: "Follow a person's page, idempotent (400 self_subscribe for your own page, 404 for an unknown person; no MCP tool)",
    gate: requireFeature("recordSubsV1"),
    handler: async (c) => ok(await c.subscriptions.put(c.params.id)),
  },
  {
    name: "subscriptions.remove", method: "DELETE", path: "/subscriptions/person/:id", summary: "Unfollow a person's page, idempotent: 204 (no MCP tool)",
    gate: requireFeature("recordSubsV1"),
    handler: async (c) => { await c.subscriptions.remove(c.params.id); return ok(undefined, 204); },
  },
  {
    name: "comments.list", method: "GET", path: "/comments", summary: "List comments on a subject, oldest first by default or order=desc for newest first (cursor, bound to its order), with reactions",
    handler: async (c) => {
      const subject = need(c.query.subject, "subject");
      return ok(await c.comments.list(subject, { cursor: c.query.cursor || undefined, limit: c.query.limit ? Number(c.query.limit) : undefined, ...(c.query.order ? { order: c.query.order } : {}) })); // empty thread => empty list
    },
  },
  {
    name: "comments.create", method: "POST", path: "/comments", summary: "Create a comment or reply (parentId) on a subject; with commentPhotosV1 on, up to 4 attachments from POST /uploads purpose comment (a photo-only comment may have an empty body)",
    handler: async (c) => {
      if (c.body.attachments !== undefined) await commentPhotos(c);
      return ok(await c.comments.create(need(c.body.subject, "subject"), { body: c.body.body, ...(c.body.parentId ? { parentId: c.body.parentId } : {}), ...(c.body.attachments !== undefined ? { attachments: c.body.attachments } : {}) }), 201);
    },
  },
  {
    name: "comments.update", method: "PATCH", path: "/comments/:id", summary: "Edit your own comment (subject in body or query)",
    handler: async (c) => {
      if (c.body.attachments !== undefined) await commentPhotos(c);
      return ok(await c.comments.edit(need(c.body.subject ?? c.query.subject, "subject"), c.params.id, { body: c.body.body, ...(c.body.attachments !== undefined ? { attachments: c.body.attachments } : {}) })); // photos can be removed, never added
    },
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
    name: "uploads.presign", method: "POST", path: "/uploads", summary: "Presigned S3 PUT for a photo (purpose post, the default: jpeg/png/webp/heic at uploads/posts/<ulid>/photo.<ext>; purpose comment: jpeg/png/webp at uploads/comments/<ulid>/photo.<ext>, needs commentPhotosV1), <= 10 MB, name chosen by the server, bound to you for 24 h; returns {uploadUrl, publicUrl, headers} (send headers exactly: Content-Type is signed)",
    handler: async (c) => {
      if (c.body.purpose === "comment") await commentPhotos(c); // purpose comment: uploads/comments/<ulid>/photo.<ext>, jpeg/png/webp only
      return ok(await c.uploads.presign(c.actor, { contentType: c.body.contentType, size: c.body.size, purpose: c.body.purpose }), 201);
    },
  },
  // Notifications: the @io-kit/notify/server handler is mounted under /api/notifications/*.
  { name: "notifications.vapid-public-key", method: "GET", path: "/notifications/vapid-public-key", summary: "VAPID application server key", handler: (c) => c.notifyHandler() },
  { name: "notifications.subscribe", method: "POST", path: "/notifications/subscribe", summary: "Register a push subscription", handler: (c) => c.notifyHandler() },
  { name: "notifications.unsubscribe", method: "DELETE", path: "/notifications/subscribe", summary: "Remove a push subscription", handler: (c) => c.notifyHandler() },
  { name: "notifications.preferences.get", method: "GET", path: "/notifications/preferences", summary: "Read notification preferences", handler: (c) => c.notifyHandler() },
  // The inbox (hfy-inbox-delivery-api; BRD2 D2-15, D2-28): served by the kit handler, dark until inboxV1 is on (or the caller is uat). No `mcp` member and no policy row.
  { name: "notifications.inbox.list", method: "GET", path: "/notifications/inbox", summary: "List your notification inbox, newest first (filter=unread|all, cursor, limit)", gate: requireFeature("inboxV1"), handler: (c) => c.notifyHandler() },
  { name: "notifications.inbox.count", method: "GET", path: "/notifications/inbox/unread-count", summary: "Count your unread notifications", gate: requireFeature("inboxV1"), handler: (c) => c.notifyHandler() },
  { name: "notifications.inbox.read", method: "POST", path: "/notifications/inbox/read", summary: "Mark notifications read: {ids} or {all:true}", gate: requireFeature("inboxV1"), handler: (c) => c.notifyHandler() },
  { name: "notifications.preferences.put", method: "PUT", path: "/notifications/preferences", summary: "Save notification preferences", handler: (c) => c.notifyHandler() },
  // The desktop sync API (HFY-TSK-172; sync.md 7): bearer auth, gramps-owner, behind SYNC_API_ENABLED. Defined in src/sync/routes.js; the push and pull routes join it.
  ...SYNC_ROUTES,
  // The read-only records API (HFY-TSK-175; sync.md 7.2, BRD2 D2-34): the stored, redacted object through publishView and applyModOverlay, behind
  // the HFY_EDITING switch (admins and a member's own record excepted). No `mcp` member: hfy_records_get is edit-mcp-tools'. by-id is listed first.
  {
    name: "records.byGrampsId", method: "GET", path: "/records/Person/by-id/:gramps_id", summary: "A person by gramps_id: {class, handle, gramps_id, version, obj} with ETag \"v<version>\"; read-only, year-only non-birth dates and no hidden items for non-admins (no MCP tool)",
    gate: recordsGate(), handler: recordByGrampsId,
  },
  {
    name: "records.get", method: "GET", path: "/records/:class/:handle", summary: "One record by class and handle: {class, handle, gramps_id, version, obj} with ETag \"v<version>\"; 404 for a tombstone or unknown handle (no MCP tool)",
    gate: recordsGate(), handler: recordGet,
  },
  // The editing API core (HFY-TSK-182; editing.md 7.2): the edit bundle and the schema route, behind HFY_EDITING (404 for everyone while it is off).
  // The schema route is listed first so /edit/schema/:cls is not read as /edit/:cls/:ref. Not MCP tools (hfy_records_get is edit-mcp-tools').
  {
    name: "edit.schema", method: "GET", path: "/edit/schema/:cls", summary: "The generated JSON Schema of one editable class: {class, schema, sha256, schemaHash}; 404 for a class with no schema (no MCP tool)",
    gate: editingGate(), handler: schemaGet,
  },
  {
    name: "edit.get", method: "GET", path: "/edit/:cls/:ref", summary: "The edit bundle for a record (ref = gramps_id or h:<handle>): {key, version, etag, obj, related, relation, viewer, policy, pending, customTypes, schemaHash}, through publishView and applyModOverlay; pending[] only what the viewer may see (no MCP tool)",
    gate: editingGate(), handler: bundleGet,
  },
  // POST /api/changes (HFY-TSK-183; editing.md 7.3): direct groups and a proposal in one transaction, or a dry-run plan. Behind HFY_EDITING like the
  // routes above. No `mcp` member: hfy_changes_submit (agentMode dry_run) is edit-mcp-tools'.
  {
    name: "changes.post", method: "POST", path: "/changes", summary: "Submit EditOps {target, base_versions, ops, note?, route?: auto|review (admins), dry_run?} with an Idempotency-Key header (not for dry_run): the direct groups save now and the rest becomes one proposal, all in one transaction; 201 {applied: {versions, undo}|null, proposal|null, summary}, or 200 {plan: {direct, review}, warnings, errors} for dry_run (no MCP tool)",
    gate: editingGate(), handler: changesPost,
  },
  // The relationship wizard's routes (HFY-TSK-210; editing.md 8.2): an intent is compiled to EditOps. Preview writes nothing; a submit is a proposal of
  // kind "relationship" for a member and, for an admin on route auto, applied through applyBatch(). Behind HFY_EDITING. No MCP tool.
  {
    name: "relationships.preview", method: "POST", path: "/relationships/preview", summary: "Preview a relationship intent {intent: parents|children|spouse|unlink, confirmDistinct?}: 200 {ops, base_versions, read_versions, summary[], warnings[], duplicates[], followUps[], destructive, already_recorded, route}; nothing is written (no MCP tool)",
    gate: editingGate(), handler: relationshipsPreview,
  },
  {
    name: "relationships.post", method: "POST", path: "/relationships", summary: "Submit a relationship intent {intent, confirmDistinct, note?, route?: auto|review (admins)} with an Idempotency-Key header: a member always gets 201 {proposal} (kind relationship, storing the intent and the compiled ops); an admin on route auto gets 201 {applied}; 422 unconfirmed_duplicate until every flagged new:<n> is in confirmDistinct, 422 cycle | too_many_children | contact_info, 409 already_recorded (no MCP tool)",
    gate: editingGate(), handler: relationshipsPost,
  },
  // The proposal store (HFY-TSK-184; editing.md 7.4): lists, one proposal, amend, withdraw. Behind HFY_EDITING like the routes above. Decide is
  // proposal-decision-api's; no `mcp` member (hfy_proposals_list and hfy_proposals_get are edit-mcp-tools'). A proposal outside the viewer's
  // visibility set is 404 (the proposer, admins and the owners of the targeted pages see it), and view=queue is 403 for a non-admin.
  {
    name: "proposals.list", method: "GET", path: "/proposals", summary: "List suggestions: ?view=queue (admins, oldest first; pending and stale unless ?state=), mine (newest first) or about-me (suggestions about your own page or family); state, cursor, limit 1-50 (default 25): {items: ProposalView[], cursor} (no MCP tool)",
    gate: editingGate(), handler: proposalsList,
  },
  {
    name: "proposals.get", method: "GET", path: "/proposals/:id", summary: "One suggestion as a ProposalView (can, stale) plus rebase {status: current|clean|conflict, conflicts}; 404 outside the proposer, admins and the owners of the targeted pages (no MCP tool)",
    gate: editingGate(), handler: proposalsGet,
  },
  {
    name: "proposals.amend", method: "PATCH", path: "/proposals/:id", summary: "The proposer amends an open suggestion {ops, base_versions, note?} with If-Match: the etag: rev + 1 and back to pending; 412 precondition_failed carries the fresh view in details.proposal, 409 not_amendable once it is decided or withdrawn, 422 from the privacy guard (no MCP tool)",
    gate: editingGate(), handler: proposalsAmend,
  },
  {
    name: "proposals.withdraw", method: "POST", path: "/proposals/:id/withdraw", summary: "The proposer withdraws an open suggestion, with If-Match: the etag (no MCP tool)",
    gate: editingGate(), handler: proposalsWithdraw,
  },
  // The decision (HFY-TSK-209; editing.md 7.4): an admin approves (rebase and one applyBatch transaction), denies or asks for changes. Behind HFY_EDITING like the
  // routes above. No `mcp` member: approving is a human action in the site UI (DEC-E5), so there is no decide tool.
  {
    name: "proposals.decide", method: "POST", path: "/proposals/:id/decision", summary: "An admin decides a pending or stale suggestion {verdict: approve|deny|needs_changes, reason? (required for deny and needs_changes), amend?: {ops, base_versions}} with If-Match: the etag and an Idempotency-Key: approve rebases onto the page as it is now and commits the records, the proposal, the audit and the proposer's credit in one transaction; 200 {proposal, applied?: {versions}}; 403 not_admin, 401 step_up_required (a destructive approval needs a sign-in within 900 s), 409 rebase_conflict (the suggestion is now stale), 409 invalid_state, 412 precondition_failed (details.proposal is the fresh view), 422 from the privacy guard (no MCP tool)",
    gate: editingGate(), handler: proposalsDecide,
  },
]);

/** Normalizes registry entries (MCP member, auth, write, path matcher). Exported so tests can mount extra routes through the same shape. */
export function defineRoutes(list) {
  return list.map((r) => ({ ...r, ...(MCP[r.name] ? { mcp: MCP[r.name] } : {}), auth: r.auth ?? "session", write: r.method !== "GET", re: new RegExp(`^${r.path.replace(/:[a-z_]+/g, "([^/]+)")}$`), keys: [...r.path.matchAll(/:([a-z_]+)/g)].map((m) => m[1]) }));
}

/**
 * `candidates`: every route whose path matched (any method), so the handler can tell 405 from a dark path that must stay 404.
 * A route may carry `when(query)`: two routes can share a method and path when the query tells them apart (contributions.stats takes
 * `?author`, contributions.site does not). The route list must make the predicates exclusive.
 */
export function matchRoute(method, path, routes = ROUTES, query = {}) {
  const candidates = [];
  for (const r of routes) {
    const m = r.re.exec(path);
    if (!m) continue;
    candidates.push(r);
    if (r.method === method && (!r.when || r.when(query ?? {}))) return { route: r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])), pathMatched: true, candidates };
  }
  return { route: null, pathMatched: candidates.length > 0, candidates };
}

/** Machine-readable capability document (AC2). Generated by scripts/gen-caps.mjs. */
export function buildCaps() {
  return {
    name: API_NAME,
    version: API_VERSION,
    base_path: BASE_PATH,
    auth: {
      scheme: "session-cookie", issuer_env: "SESSION_ISSUER", reads_require_session: true,
      // Routes with auth "sync-bearer" (/api/sync/*) take the desktop client's access token instead of the cookie (src/sync/auth.js).
      sync_bearer: { scheme: "bearer", issuer: SYNC_ISSUER, audience: SYNC_AUDIENCE, client_id: SYNC_CLIENT_ID, group: "gramps-owner", step_up: { amr: "mfa", max_age_seconds: 300 } },
    },
    sync: {
      api_version: 1, enabled_by: "SYNC_API_ENABLED", min_client: DEFAULT_MIN_CLIENT, accepted: { gramps: [...ACCEPTED_GRAMPS], schema: [...DEFAULT_ACCEPTED_SCHEMA] },
      handshake_headers: Object.values(HEADERS), limits: { ...LIMITS },
    },
    subjects: SUBJECT_FORMATS,
    actions: ROUTES.map((r) => ({ name: r.name, method: r.method, path: `${BASE_PATH}${r.path}`, auth: r.auth, write: r.write, summary: r.summary, ...(r.gate ? { gate: describeGate(r.gate) } : {}) })),
    content: { source: "posts", capabilities: CONTENT_CAPABILITIES, post_types: ["post", "article", "document"], visibilities: ["draft", "published", "withdrawn"] },
    comments: { reactions: "one-emoji-per-principal-per-comment", threading: "parentId (reply)", max_body: 1000, subject_param: "required on PATCH/DELETE/react (query or body)" },
    mcp: { resource: MCP_RESOURCE, tools: ROUTES.filter((r) => r.mcp).map((r) => ({ name: r.mcp.tool, action: r.name, write: r.write })) },
    notifications: { types: NOTIFY_TYPES, default_level: 0 },
    audit: { item: "AUDIT#", fields: ["op", "id", "principal", "at", "before", "after"], ops: ["create", "update", "delete", "visibility", "links.update", "links.clear"] },
  };
}
