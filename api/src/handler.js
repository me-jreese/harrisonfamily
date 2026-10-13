// Lambda Function URL (payload v2) handler. All logic is injected through `deps` so tests run offline.
import { createNotifyHandler } from "@io-kit/notify/server";
import { createContentSource } from "./content.js";
import { createCommentSource, purgeThread, toCommentPrincipal } from "./comments.js";
import { createNotifier, scanSubscribedPrincipals } from "./notify.js";
import { BASE_PATH, ROUTES, matchRoute } from "./routes.js";
import { createUploads } from "./uploads.js";
import { createGuard } from "./guard.js";
import { checkLocation } from "./upload-guard.js";
import { HttpError, errorResponse, json, logSafeError } from "./http.js";
import { countPendingAccessRequests } from "./me.js";

export function createHandler(deps) {
  const { ddb, cmds, table, authenticate, ulid, now = () => Date.now(), log = console } = deps;
  const uid = () => ulid(now());
  const pushEnabled = Boolean(deps.webpush && deps.vapid);
  const mediaBucket = deps.mediaBucket ?? "harrisonfamily-frontend";
  // R-18 on posts, comments and the MCP tools (privacy-guard-existing-paths). guardDob is the HFY_GUARD_DOB switch (index.js):
  // off until io answers Q2-17 line 5, so only contact kinds are refused; refusals log counts per code only.
  const guard = createGuard({ dob: deps.guardDob === true, log });
  // The location-metadata check on a post's new attachments, with the API's own S3 client. No client => no new attachments.
  const checkUpload = deps.s3 ? (key) => checkLocation(mediaBucket, key, { s3: deps.s3 }) : undefined;
  /** Post-commit side effects (push fan-out, thread cleanup): the write already succeeded, so failures are logged, never returned. */
  const afterCommit = async (label, fn) => {
    try {
      await fn();
    } catch (e) {
      log.error?.(`${label} failed (write already committed)`, logSafeError(e));
    }
  };

  function build(actor, event) {
    const notifier = createNotifier({
      subscriptions: deps.subscriptions, preferences: deps.preferences, webpush: deps.webpush, vapid: deps.vapid, log,
      listPrincipals: scanSubscribedPrincipals(ddb, cmds, table),
    });
    const base = { ddb, cmds, table, actor, now, ulid, uid };
    const commenterIds = async (threadId) => {
      const ids = new Set();
      let key;
      for (let i = 0; i < 20; i += 1) {
        const r = await ddb.send(new cmds.QueryCommand({
          TableName: table, KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
          ExpressionAttributeValues: { ":pk": `THREAD#${threadId}`, ":sk": "C#" }, ...(key ? { ExclusiveStartKey: key } : {}),
        }));
        for (const it of r.Items ?? []) if (it.comment?.author?.id) ids.add(it.comment.author.id);
        key = r.LastEvaluatedKey;
        if (!key) break;
      }
      return [...ids];
    };
    const content = createContentSource({ ...base, audit: deps.audit, mediaPublicBase: deps.mediaPublicBase, guard, checkUpload });
    const comments = createCommentSource({
      ...base, viewer: toCommentPrincipal(actor), audit: deps.commentAudit, maxLength: deps.maxCommentLength ?? 1000, guard,
      getPost: (id) => content.get(id),
      // Without push configured there is nobody to notify: skip the post read and the commenters Query entirely.
      onCreated: (c, { parent }) => pushEnabled && afterCommit("comment notification", async () => {
        const postAuthorId = c.threadId.startsWith("post:") ? (await content.get(c.threadId.slice(5))).author.id : undefined;
        const earlierCommenters = await commenterIds(c.threadId);
        await notifier.onComment(c, { parent }, { postAuthorId, earlierCommenters });
      }),
    });
    const afterPublished = (post) => afterCommit("publish notification", () => notifier.onPublished(post));
    // A deleted post takes its discussion with it (each removed comment is audited); best effort after the post delete.
    const afterPostDeleted = (id) => afterCommit("post thread purge", () => purgeThread(base, `post:${id}`, actor.id));
    const notifyHandler = () =>
      createNotifyHandler({ vapidPublicKey: deps.vapidPublicKey ?? "", subscriptions: deps.subscriptions, preferences: deps.preferences, getPrincipal: () => actor.id })(event);
    const uploads = deps.presignPut ? createUploads({ presignPut: deps.presignPut, uid, ddb, cmds, table, now, bucket: mediaBucket, publicBase: deps.mediaPublicBase }) : { presign: async () => { throw new HttpError(503, "unavailable", "uploads are not configured"); } };
    const accessRequestCount = () => countPendingAccessRequests({ ddb, cmds, table });
    return { content, comments, notifier, notifyHandler, uploads, afterPublished, afterPostDeleted, accessRequestCount, log };
  }

  /** Run a route's own handler for a non-HTTP caller (the MCP tools): same registry, same validation, Q-4 and audit. Returns {status, body}. */
  async function invoke(actor, routeName, { params = {}, query = {}, body = {} } = {}) {
    const route = ROUTES.find((r) => r.name === routeName);
    if (!route) throw new HttpError(404, "not_found", "no such route");
    return route.handler({ ...build(actor, {}), actor, params, query, body, event: {} });
  }

  async function handler(event) {
    const ctx = { requestId: event.requestContext?.requestId };
    try {
      const method = (event.requestContext?.http?.method ?? event.httpMethod ?? "GET").toUpperCase();
      let path = (event.rawPath ?? event.path ?? "/").replace(/\/+$/, "") || "/";
      if (path === BASE_PATH || !path.startsWith(`${BASE_PATH}/`)) throw new HttpError(404, "not_found", "no such route");
      path = path.slice(BASE_PATH.length);

      const { route, params, pathMatched } = matchRoute(method, path);
      if (!route) throw pathMatched ? new HttpError(405, "method_not_allowed", "method not allowed") : new HttpError(404, "not_found", "no such route");

      ctx.route = route.name;
      const actor = await authenticate(event);
      if (!actor) throw new HttpError(401, "unauthenticated", "sign in required");

      let body = {};
      const hasBody = method === "POST" || method === "PUT" || method === "PATCH";
      if (hasBody) {
        const ct = (event.headers?.["content-type"] ?? "").toLowerCase();
        if (!ct.startsWith("application/json")) throw new HttpError(415, "unsupported_media_type", "content-type must be application/json");
        const raw = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body) : "{}";
        try {
          body = JSON.parse(raw || "{}");
        } catch {
          throw new HttpError(400, "validation", "invalid JSON body");
        }
        if (body === null || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "validation", "body must be a JSON object");
      }

      const r = await route.handler({ ...build(actor, event), actor, params, query: event.queryStringParameters ?? {}, body, event });
      if (r.statusCode !== undefined) return { ...r, headers: { "cache-control": "no-store", ...r.headers } }; // notify handler result
      return json(r.status, r.body);
    } catch (e) {
      return errorResponse(e, log, ctx);
    }
  }
  handler.invoke = invoke;
  return handler;
}
