// HFY-TSK-080 (HFY-R63): viewer-request gate for the private data paths (person/family/event/note/place/media).
// Verifies the RS256 `io_id` session cookie minted by the auth edge (auth/): signature against its JWKS, iss, aud, exp/nbf
// with a clock skew. Allow = the request is returned unchanged. Deny = 401 JSON for fetch/XHR/subresource requests, 302 to
// /auth/login?returnTo=<path> for top-level navigations. Fail closed: any error is a deny. Dependency-free (node:crypto only).
// Every response the gate generates carries Cache-Control: private, no-store (HFY-R65): Cloudflare proxies the site in front of
// CloudFront, and a shared cache must never keep a gate answer. Allowed responses get the same header from the behaviors'
// response headers policy (scripts/infra/add-data-gate-behaviors.sh).
import { createPublicKey, verify } from "node:crypto";

const DEFAULTS = {
  cookie: "io_id",
  loginPath: "/auth/login",
  skewSeconds: 60,
  jwksTtlSeconds: 300,
  minRefetchSeconds: 30,
  failureBackoffSeconds: 2,
  fetchTimeoutMs: 3000,
};
export const NO_STORE = "private, no-store";
const MAX_TOKEN_CHARS = 8192;

export function createGate(config, deps = {}) {
  const cfg = { ...DEFAULTS, ...config };
  for (const k of ["issuer", "audience", "jwksUrl"]) if (typeof cfg[k] !== "string" || !cfg[k]) throw new Error(`gate config: ${k} is required`);
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((m) => console.log(m));

  // Module-scope JWKS cache: kid -> KeyObject. A refetch happens when the cache is older than the TTL or the kid is unknown.
  // Rate limit: after a SUCCESSFUL fetch, no refetch for minRefetchSeconds (a stream of forged kids cannot turn the gate into a
  // JWKS hammer). After a FAILED fetch (network error, timeout, non-2xx, no usable key), the next request may retry once
  // failureBackoffSeconds have passed, so one slow answer from a cold auth edge does not lock a fresh container into denying
  // every member for minRefetchSeconds. A failed fetch never drops the last good keys, and no key is always a deny (fail closed).
  let keys = new Map();
  let fetchedAt = 0;
  let lastAttemptAt = null; // when the last fetch attempt finished
  let lastAttemptFailed = false;
  let inflight = null;

  function refresh() {
    if (inflight) return inflight;
    inflight = (async () => {
      let ok = false;
      try {
        const res = await fetchImpl(cfg.jwksUrl, { signal: AbortSignal.timeout(cfg.fetchTimeoutMs), headers: { accept: "application/json" } });
        if (!res.ok) throw new Error(`jwks http ${res.status}`);
        const body = await res.json();
        const next = new Map();
        for (const jwk of Array.isArray(body?.keys) ? body.keys : []) {
          if (jwk?.kty !== "RSA" || typeof jwk.kid !== "string" || (jwk.use && jwk.use !== "sig") || (jwk.alg && jwk.alg !== "RS256")) continue;
          try { next.set(jwk.kid, createPublicKey({ key: jwk, format: "jwk" })); } catch { /* skip an unusable key */ }
        }
        if (next.size > 0) { keys = next; fetchedAt = now(); ok = true; }
        else log("edge-gate: jwks had no usable RS256 keys");
      } catch (e) {
        log(`edge-gate: jwks refresh failed: ${e?.message ?? e}`); // the previous keys (if any) stay usable
      } finally {
        lastAttemptAt = now();
        lastAttemptFailed = !ok;
        inflight = null;
      }
    })();
    return inflight;
  }

  async function keyFor(kid) {
    const t = now();
    const fresh = keys.size > 0 && t - fetchedAt < cfg.jwksTtlSeconds * 1000;
    if (fresh && keys.has(kid)) return keys.get(kid);
    const waitMs = (lastAttemptFailed ? cfg.failureBackoffSeconds : cfg.minRefetchSeconds) * 1000;
    const cooling = lastAttemptAt !== null && t - lastAttemptAt < waitMs;
    if (inflight) await inflight; // a fetch already under way: share its result rather than deny while it runs
    else if (!cooling) await refresh();
    return keys.get(kid) ?? null;
  }

  const parseJson = (b64u) => JSON.parse(Buffer.from(b64u, "base64url").toString("utf8"));

  // -> { ok: true, claims } | { ok: false, reason }
  async function verifyToken(token) {
    if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_CHARS) return { ok: false, reason: "malformed" };
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return { ok: false, reason: "malformed" };
    let header, claims;
    try { header = parseJson(parts[0]); claims = parseJson(parts[1]); } catch { return { ok: false, reason: "malformed" }; }
    if (!header || header.alg !== "RS256" || typeof header.kid !== "string") return { ok: false, reason: "alg-or-kid" };
    const key = await keyFor(header.kid);
    if (!key) return { ok: false, reason: "unknown-kid" };
    const good = verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], "base64url"));
    if (!good) return { ok: false, reason: "bad-signature" };
    if (!claims || typeof claims !== "object") return { ok: false, reason: "malformed" };
    if (claims.iss !== cfg.issuer) return { ok: false, reason: "iss" };
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(cfg.audience)) return { ok: false, reason: "aud" };
    const nowS = Math.floor(now() / 1000);
    if (typeof claims.exp !== "number" || nowS > claims.exp + cfg.skewSeconds) return { ok: false, reason: "expired" };
    if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || nowS + cfg.skewSeconds < claims.nbf)) return { ok: false, reason: "nbf" };
    if (typeof claims.sub !== "string" || !claims.sub) return { ok: false, reason: "sub" };
    return { ok: true, claims };
  }

  function cookieValue(request) {
    for (const h of request.headers?.cookie ?? []) {
      for (const part of String(h?.value ?? "").split(";")) {
        const i = part.indexOf("=");
        if (i > 0 && part.slice(0, i).trim() === cfg.cookie) return part.slice(i + 1).trim();
      }
    }
    return null;
  }

  const header = (request, name) => request.headers?.[name]?.[0]?.value ?? "";

  // A top-level browser navigation gets the login redirect; everything else (fetch, XHR, <img>, ...) gets a JSON 401.
  function isNavigation(request) {
    if (/application\/json/i.test(header(request, "accept"))) return false;
    const mode = header(request, "sec-fetch-mode");
    if (mode) return mode.toLowerCase() === "navigate";
    return /text\/html/i.test(header(request, "accept"));
  }

  function deny(request) {
    if (isNavigation(request)) {
      const path = `/${String(request.uri || "/").replace(/^\/+/, "")}${request.querystring ? `?${request.querystring}` : ""}`;
      return {
        status: "302",
        statusDescription: "Found",
        headers: {
          location: [{ key: "Location", value: `${cfg.loginPath}?returnTo=${encodeURIComponent(path)}` }],
          "cache-control": [{ key: "Cache-Control", value: NO_STORE }],
        },
      };
    }
    return {
      status: "401",
      statusDescription: "Unauthorized",
      headers: {
        "content-type": [{ key: "Content-Type", value: "application/json" }],
        "cache-control": [{ key: "Cache-Control", value: NO_STORE }],
      },
      body: JSON.stringify({ error: "unauthenticated" }),
    };
  }

  async function handler(event) {
    const request = event.Records[0].cf.request;
    try {
      const token = cookieValue(request);
      if (token) {
        const r = await verifyToken(token);
        if (r.ok) return request;
        log(`edge-gate: deny ${r.reason}`);
      }
    } catch (e) {
      log(`edge-gate: deny error ${e?.message ?? e}`); // fail closed
    }
    return deny(request);
  }

  return { handler, verifyToken };
}
