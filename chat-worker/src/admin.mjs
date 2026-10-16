// The chat hub's admin route (HFY-TSK-337): POST /chat/v1/admin/expunge {conv, seq}, called by `api/scripts/expunge.mjs --chat`.
//
//   - It is authenticated by a bearer token, CHAT_ADMIN_TOKEN: a Worker secret of its own, never the member session (io_id) and
//     never CHAT_SERVICE_PRIVATE_KEY (the hub's key to hfy-api). With no token configured (or one under 32 characters) the route
//     does not exist: the request goes on to the origin like any other unowned request on /chat/v1/*.
//   - The Worker checks the token before it wakes the Durable Object, and the hub checks it again before it touches a row, so
//     the one party that holds the data never trusts the hop in front of it.
//   - The answer carries counts only: 200 {nulled: 0|1}, 404 {error} for a message that does not exist, 401 for a bad or missing token,
//     503 {error: "archive_busy"} when an archive drain would not settle (nothing was nulled; run it again).
export const ADMIN_PATH = "/chat/v1/admin/expunge";
/** The path the Worker forwards to the hub object (the hub is reachable only through the Worker). */
export const HUB_ADMIN_PATH = "/admin/expunge";
/** A shorter secret is a misconfiguration: the route stays closed. */
export const MIN_TOKEN_CHARS = 32;
/** `{conv, seq}` is under 150 bytes; anything past this is refused before it is parsed. */
export const MAX_BODY_CHARS = 1024;

export const CONV_RE = /^(?:dm:[A-Za-z0-9_-]{1,64}:[A-Za-z0-9_-]{1,64}|g:[A-Za-z0-9]{1,40})$/;
export const MAX_SEQ = 2_147_483_647;

export const json = (status, body, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });

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

/**
 * Reads a request body as text, at most `MAX_BODY_CHARS * 4` bytes (a body of MAX_BODY_CHARS characters is that many bytes at most in
 * UTF-8). The stream is cancelled as soon as the cap is passed, so a chunked body with no content-length is never held whole.
 * Returns the text, or null when the body is over the cap.
 */
export async function readCapped(request) {
  const cap = MAX_BODY_CHARS * 4;
  if (Number(request.headers.get("content-length") ?? 0) > cap) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
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
