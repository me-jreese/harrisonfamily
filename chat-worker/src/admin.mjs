// The chat hub's admin route (HFY-TSK-337): POST /chat/v1/admin/expunge {conv, seq}, called by `api/scripts/expunge.mjs --chat`.
//
//   - It is authenticated by a bearer token, CHAT_ADMIN_TOKEN: a Worker secret of its own, never the member session (io_id) and
//     never CHAT_SERVICE_PRIVATE_KEY (the hub's key to hfy-api). With no token configured (or one under 32 characters) the route
//     does not exist: the request goes on to the origin like any other unowned request on /chat/v1/*.
//   - The Worker checks the token before it wakes the Durable Object, and the hub checks it again before it touches a row, so
//     the one party that holds the data never trusts the hop in front of it.
//   - The answer carries counts only: 200 {nulled: 0|1}, 404 {error} for a message that does not exist, 401 for a bad or missing token.
export const ADMIN_PATH = "/chat/v1/admin/expunge";
/** The path the Worker forwards to the hub object (the hub is reachable only through the Worker). */
export const HUB_ADMIN_PATH = "/admin/expunge";
/** A shorter secret is a misconfiguration: the route stays closed. */
export const MIN_TOKEN_CHARS = 32;
/** `{conv, seq}` is under 150 bytes; anything past this is refused before it is parsed. */
export const MAX_BODY_CHARS = 1024;

export const CONV_RE = /^(?:dm:[A-Za-z0-9_-]{1,64}:[A-Za-z0-9_-]{1,64}|g:[A-Za-z0-9]{1,40})$/;
export const MAX_SEQ = 2_147_483_647;

export const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** True when the environment holds a usable admin token. */
export function adminConfigured(env) {
  return typeof env?.CHAT_ADMIN_TOKEN === "string" && env.CHAT_ADMIN_TOKEN.length >= MIN_TOKEN_CHARS;
}

async function digest(text) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/** Compares SHA-256 digests of the presented and the configured token, so the comparison time does not depend on where they differ. */
export async function bearerOk(request, env) {
  if (!adminConfigured(env)) return false;
  const m = /^Bearer ([\x21-\x7e]{1,512})$/.exec(request.headers.get("authorization") ?? "");
  if (!m) return false;
  const [a, b] = await Promise.all([digest(m[1]), digest(env.CHAT_ADMIN_TOKEN)]);
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length && i < b.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** `{conv, seq}` or null: exactly those two members, a conversation id of the two known shapes, a positive integer seq. */
export function parseBody(text) {
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_BODY_CHARS) return null;
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const keys = Object.keys(v);
  if (keys.length !== 2 || !keys.includes("conv") || !keys.includes("seq")) return null;
  if (typeof v.conv !== "string" || !CONV_RE.test(v.conv)) return null;
  if (!Number.isSafeInteger(v.seq) || v.seq < 1 || v.seq > MAX_SEQ) return null;
  return { conv: v.conv, seq: v.seq };
}
