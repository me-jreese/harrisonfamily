// Fixed-window request counters in the hfy-app table (HFY-R58 ruling 5): one item per (key, window), removed by the table TTL.
// Used to rate-limit POST /auth/password/forgot, the only anonymous route that makes Cognito send an email.
import { createHash } from "node:crypto";

/** Default forgot-password limits: per email+IP (the ruled key) and per IP across emails (stops one client cycling addresses). */
export const FORGOT_LIMITS = Object.freeze([
  Object.freeze({ scope: "email+ip", limit: 3, windowSeconds: 3600 }),
  Object.freeze({ scope: "ip", limit: 10, windowSeconds: 86400 }),
]);

const windowOf = (nowMs, windowSeconds) => {
  const t = Math.floor(nowMs / 1000);
  const start = t - (t % windowSeconds);
  return { t, start, end: start + windowSeconds };
};

/** Hashed counter key, so neither the email nor the IP is stored in the table. */
export function rateKey(name, scope, { email = "", ip = "" }) {
  const parts = scope.split("+").map((p) => (p === "email" ? `e:${email}` : p === "ip" ? `i:${ip}` : `?:${p}`));
  return `${name}:${scope}#${createHash("sha256").update(parts.join("\n")).digest("base64url")}`;
}

/** DynamoDB: one atomic UpdateItem (ADD) per hit; the window item expires through the table's `ttl` attribute. */
export function ddbRateLimiter({ doc, cmds, table, now = () => Date.now() }) {
  return {
    async hit(key, { limit, windowSeconds }) {
      const { t, start, end } = windowOf(now(), windowSeconds);
      const r = await doc.send(new cmds.UpdateCommand({
        TableName: table,
        Key: { PK: `RATE#${key}`, SK: `W#${windowSeconds}#${start}` },
        UpdateExpression: "ADD #n :one SET #ttl = if_not_exists(#ttl, :ttl)",
        ExpressionAttributeNames: { "#n": "n", "#ttl": "ttl" },
        ExpressionAttributeValues: { ":one": 1, ":ttl": end + 300 },
        ReturnValues: "UPDATED_NEW",
      }));
      const count = Number(r.Attributes?.n ?? 0);
      return { allowed: count <= limit, count, retryAfter: Math.max(1, end - t) };
    },
  };
}

export function memoryRateLimiter({ now = () => Date.now() } = {}) {
  const m = new Map();
  return {
    async hit(key, { limit, windowSeconds }) {
      const { t, start, end } = windowOf(now(), windowSeconds);
      const k = `${key}|${windowSeconds}|${start}`;
      const count = (m.get(k) ?? 0) + 1;
      m.set(k, count);
      return { allowed: count <= limit, count, retryAfter: Math.max(1, end - t) };
    },
  };
}

const headersOf = (event) => {
  const h = {};
  for (const [k, v] of Object.entries(event?.headers ?? {})) if (v !== undefined) h[k.toLowerCase()] = String(v);
  return h;
};

/**
 * The viewer's IP behind CloudFront. Preference: CloudFront-Viewer-Address (set by CloudFront, never by the viewer), then the
 * right-most X-Forwarded-For entry CloudFront appended (entries to its left are viewer-supplied), then the immediate caller.
 */
export function clientIp(event) {
  const h = headersOf(event);
  const viewer = h["cloudfront-viewer-address"]?.trim();
  if (viewer) {
    const i = viewer.lastIndexOf(":");
    return (i > 0 ? viewer.slice(0, i) : viewer).replace(/^\[|\]$/g, "");
  }
  const src = String(event?.requestContext?.http?.sourceIp ?? event?.requestContext?.identity?.sourceIp ?? "");
  const xff = (h["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (xff.length > 1 && xff[xff.length - 1] === src) xff.pop();
  return xff.pop() ?? (src || "unknown");
}
