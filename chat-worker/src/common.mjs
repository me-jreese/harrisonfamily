// Shared by the production entry (index.mjs) and the staging entry (staging.mjs): the R-18 guard, the route table and the
// front door that decides which requests belong to the chat Worker and which go on to CloudFront.
import { HUB_LOCATION_HINT, HUB_NAME } from "@io-kit/chat/cloudflare";
import { scanText } from "../../shared/privacy-guard.mjs";
import { ADMIN_PATH, HUB_ADMIN_PATH, MAX_BODY_CHARS, adminConfigured, bearerOk, json } from "./admin.mjs";

export const WS_PATH = "/chat/ws";
export const HEALTH_PATH = "/chat/v1/health";

/**
 * The hub's R-18 detector (D2-09): `shared/privacy-guard.mjs`, the same module and vectors as hfy-api, the auth edge and
 * the islands bundle. A hit becomes `CONTACT_INFO` with the spans `[start, end, kind]`; the matched text is never copied
 * into the result, a frame or a log. Every kind is scanned, birth dates included: chat is kept in the cloud for good (R-35).
 */
export function contactGuard(text) {
  return scanText(text).map((hit) => [hit.start, hit.end, hit.kind]);
}

/** The two requests the chat Worker answers itself: the WebSocket upgrade on /chat/ws, and GET /chat/v1/health. */
function ownRequest(request) {
  const path = new URL(request.url).pathname;
  if (request.method !== "GET") return false;
  if (path === HEALTH_PATH) return true;
  return path === WS_PATH && request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

/**
 * POST /chat/v1/admin/expunge (HFY-TSK-337) is the Worker's own only when CHAT_ADMIN_TOKEN is configured; without it the route does
 * not exist and the request goes on to the origin like any other. The Worker checks the bearer token before it wakes the hub,
 * then hands the hub a NEW request that carries the token and the body and nothing else (never a cookie, never an Origin).
 */
function adminRequest(request, env) {
  return request.method === "POST" && new URL(request.url).pathname === ADMIN_PATH && adminConfigured(env);
}

async function handleAdmin(request, env) {
  if (!(await bearerOk(request, env))) return json(401, { error: "unauthorized" });
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_CHARS * 4) return json(413, { error: "too_large" });
  const body = await request.text();
  if (body.length > MAX_BODY_CHARS) return json(413, { error: "too_large" });
  const id = env.CHAT_HUB.idFromName(HUB_NAME);
  const hub = env.CHAT_HUB.get(id, { locationHint: env.CHAT_LOCATION_HINT ?? HUB_LOCATION_HINT });
  return hub.fetch(
    new Request(`https://chat-hub.internal${HUB_ADMIN_PATH}`, {
      method: "POST",
      headers: { authorization: request.headers.get("authorization"), "content-type": "application/json" },
      body,
    }),
  );
}

/**
 * Anything else that reaches the routes (a non-upgrade request, another method, `/chat/wsfoo`, `/chat/v1/other`) goes on to
 * the origin unchanged with `fetch(request)`, exactly as if the route did not exist. Staging sits on workers.dev with no
 * origin behind it, so it answers 404 instead of fetching itself.
 */
export function passThrough(request, env) {
  if (env && env.CHAT_PASSTHROUGH === "off") return json(404, { error: "not_found" });
  return fetch(request);
}

/**
 * The Worker's fetch handler. `workerFor(env)` returns the kit's `createChatWorker(...)` result for that environment.
 * It is called only for the two requests above, so the kit never sees a request it should have left alone.
 */
export function makeHandler(workerFor) {
  return async function fetchHandler(request, env, ctx) {
    if (adminRequest(request, env)) return handleAdmin(request, env);
    if (!ownRequest(request)) return passThrough(request, env);
    return workerFor(env).fetch(request, env, ctx);
  };
}
