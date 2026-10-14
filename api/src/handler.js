// Lambda Function URL (payload v2) handler. All logic is injected through `deps` so tests run offline.
import { createNotifyHandler } from "@io-kit/notify/server";
import { createContentSource } from "./content.js";
import { createCommentSource, purgeThread, toCommentPrincipal } from "./comments.js";
import { createNotifier, scanSubscribedPrincipals } from "./notify.js";
import { BASE_PATH, ROUTES, matchRoute } from "./routes.js";
import { currentFeatureGate, previewOf } from "./features.js";
import { createUploads } from "./uploads.js";
import { HttpError, errorResponse, json, logSafeError } from "./http.js";
import { countPendingAccessRequests } from "./me.js";
import { createLinks } from "./links.js";

export function createHandler(deps) {
  const { ddb, cmds, table, authenticate, ulid, now = () => Date.now(), log = console } = deps;
  const uid = () => ulid(now());
  const pushEnabled = Boolean(deps.webpush && deps.vapid);
  // HFY-TSK-238: the feature gate (src/features.js). index.js passes the deployed one; without it every feature is off and nobody is uat.
  const features = deps.features ?? currentFeatureGate();
  const routes = deps.routes ?? ROUTES; // tests mount extra (gated) routes through routes.js defineRoutes
  // Persist first (BRD2 D2-15): with an inbox store wired (hfy-inbox-delivery-api) the producers run even without push.
  const notifyActive = pushEnabled || Boolean(deps.inbox);
  /** Post-commit side effects (push fan-out, thread cleanup): the write already succeeded, so failures are logged, never returned. */
  const afterCommit = async (label, fn) => {
    try {
      await fn();
    } catch (e) {
      log.error?.(`${label} failed (write already committed)`, logSafeError(e));
    }
  };

  function build(actor, event, preview) {
    const notifier = createNotifier({
      subscriptions: deps.subscriptions, preferences: deps.preferences, webpush: deps.webpush, vapid: deps.vapid, log,
      listPrincipals: scanSubscribedPrincipals(ddb, cmds, table),
      // A recipient's inbox write follows featureOn for the RECIPIENT, never the actor's preview header.
      inbox: deps.inbox, featureOn: (name, principal) => features.featureOn(name, principal),
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
    const content = createContentSource({ ...base, audit: deps.audit, mediaPublicBase: deps.mediaPublicBase });
    const comments = createCommentSource({
      ...base, viewer: toCommentPrincipal(actor), audit: deps.commentAudit, maxLength: deps.maxCommentLength ?? 1000,
      getPost: (id) => content.get(id),
      // Without push or an inbox store there is nobody to notify: skip the post read and the commenters Query entirely.
      onCreated: (c, { parent }) => notifyActive && afterCommit("comment notification", async () => {
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
    const uploads = deps.presignPut ? createUploads({ presignPut: deps.presignPut, uid, bucket: deps.mediaBucket, publicBase: deps.mediaPublicBase }) : { presign: async () => { throw new HttpError(503, "unavailable", "uploads are not configured"); } };
    const accessRequestCount = () => countPendingAccessRequests({ ddb, cmds, table });
    /** For route handlers: is `name` on for this caller (their own preview header counts only if they are uat)? */
    const featureOn = (name) => features.featureOn(name, actor, { preview });
    const links = createLinks(base);
    return { content, comments, links, notifier, notifyHandler, uploads, afterPublished, afterPostDeleted, accessRequestCount, featureOn, log };
  }

  /**
   * Run a route's own handler for a non-HTTP caller (the MCP tools): same registry, same gate, validation, Q-4 and audit. Returns {status, body}.
   * A tool call carries no preview header, so a dark route is open to it only for a uat actor.
   */
  async function invoke(actor, routeName, { params = {}, query = {}, body = {} } = {}) {
    const route = routes.find((r) => r.name === routeName);
    if (!route) throw new HttpError(404, "not_found", "no such route");
    await features.check(route.gate, actor);
    return route.handler({ ...build(actor, {}), actor, params, query, body, event: {} });
  }

  async function handler(event) {
    const ctx = { requestId: event.requestContext?.requestId };
    try {
      const method = (event.requestContext?.http?.method ?? event.httpMethod ?? "GET").toUpperCase();
      let path = (event.rawPath ?? event.path ?? "/").replace(/\/+$/, "") || "/";
      if (path === BASE_PATH || !path.startsWith(`${BASE_PATH}/`)) throw new HttpError(404, "not_found", "no such route");
      path = path.slice(BASE_PATH.length);

      const preview = previewOf(event);
      const { route, params, candidates } = matchRoute(method, path, routes);
      if (!route) {
        if (candidates.length === 0) throw new HttpError(404, "not_found", "no such route");
        // Another method on a known path is 405, unless every route on that path is dark for this caller: then the path does not exist (404).
        let visible = candidates.some((r) => !r.gate || r.gate.type === "exempt");
        if (!visible) {
          const caller = await authenticate(event);
          for (const r of candidates) if (!visible) visible = await features.allows(r.gate, caller, { preview });
        }
        throw visible ? new HttpError(405, "method_not_allowed", "method not allowed") : new HttpError(404, "not_found", "no such route");
      }

      ctx.route = route.name;
      const actor = await authenticate(event);
      // HFY-TSK-238: the gate runs before the 401, so a dark route is a 404 to a signed-out caller too and never reveals that it exists.
      await features.check(route.gate, actor, { preview });
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

      const r = await route.handler({ ...build(actor, event, preview), actor, params, query: event.queryStringParameters ?? {}, body, event });
      if (r.statusCode !== undefined) return { ...r, headers: { "cache-control": "no-store", ...r.headers } }; // notify handler result
      return json(r.status, r.body);
    } catch (e) {
      return errorResponse(e, log, ctx);
    }
  }
  handler.invoke = invoke;
  return handler;
}
