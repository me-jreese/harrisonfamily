// Shared by the production entry (index.mjs) and the staging entry (staging.mjs): the R-18 guard, the route table and the
// front door that decides which requests belong to the chat Worker and which go on to CloudFront.
import { scanText } from "../../shared/privacy-guard.mjs";

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

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** The two requests the chat Worker answers itself: the WebSocket upgrade on /chat/ws, and GET /chat/v1/health. */
function ownRequest(request) {
  const path = new URL(request.url).pathname;
  if (request.method !== "GET") return false;
  if (path === HEALTH_PATH) return true;
  return path === WS_PATH && request.headers.get("upgrade")?.toLowerCase() === "websocket";
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
    if (!ownRequest(request)) return passThrough(request, env);
    return workerFor(env).fetch(request, env, ctx);
  };
}
