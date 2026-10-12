// HFY-R43: the Function URL is AuthType NONE, so every request must carry the secret header CloudFront injects (X-Origin-Verify).
// Checked before any routing; constant-time (digests are fixed length); fails closed when the secret is not configured.
import { createHash, timingSafeEqual } from "node:crypto";

export const ORIGIN_VERIFY_HEADER = "x-origin-verify";
const digest = (s) => createHash("sha256").update(String(s)).digest();

export function originVerified(event, secret) {
  const headers = event?.headers ?? {};
  const key = Object.keys(headers).find((k) => k.toLowerCase() === ORIGIN_VERIFY_HEADER);
  const got = key ? headers[key] : undefined;
  const equal = timingSafeEqual(digest(typeof got === "string" ? got : ""), digest(secret ?? ""));
  return Boolean(secret) && typeof got === "string" && got.length > 0 && equal;
}

export const forbidden = () => ({ statusCode: 403, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: '{"error":"forbidden"}' });
