// harrisonfamily auth edge, mounted at https://harrisonfamily.us/auth/* (HFY-R31), on @io-kit/auth 2.1.0's createEdgeApp.
// The kit deployable is written for auth.<site> (routes at the root). This wrapper adapts it to a path mount and adds the three
// things the kit does not ship: GET /auth/.well-known/jwks.json (HFY-R38), GET /auth/session, and host-only cookies (HFY-R31).
import { createEdgeApp, validateManifest } from "@io-kit/auth/edge/deploy";
import { resolveAuth } from "@io-kit/auth/server";
import { FORGOT_LIMITS, clientIp, rateKey } from "./ratelimit.js";

export const MOUNT = "/auth";

/**
 * Post-sign-in redirect target: a same-origin path (or an absolute URL on an allow-listed return origin), "/" for anything else.
 * The kit's own check accepts "/\t/evil.example" (it only rejects CR, LF and backslash), and browsers strip tabs while parsing,
 * so location.assign() of that value lands on https://evil.example. Control characters are refused outright; everything else is
 * resolved with the WHATWG parser the browser uses and only the canonical path is passed on, never one starting with "//".
 */
export function safeReturnTo(value, origin, extraOrigins = []) {
  if (typeof value !== "string" || !value || value.length > 2048) return "/";
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return "/";
  let u;
  try {
    u = new URL(value, `${origin}/`);
  } catch {
    return "/";
  }
  if (u.origin === origin) {
    const p = `${u.pathname}${u.search}${u.hash}`;
    return p.startsWith("/") && !p.startsWith("//") ? p : "/";
  }
  return extraOrigins.includes(u.origin) && /^https?:$/.test(u.protocol) ? u.href : "/";
}
/** Kit routes that live at the root of auth.<site>; at /auth/* they are reached as /auth/<route>. */
const ROOT_ROUTES = new Set(["/login", "/verify", "/link", "/password/forgot", "/password/reset"]);
const ABS_LINK = /(["'])\/(login|verify|link|password\/forgot|password\/reset)(?=["'?#&])/g;

/** Applies runtime ids (public config from the Lambda environment) to the committed manifest, then validates it. */
export function loadManifest(raw, env = process.env) {
  const m = structuredClone(raw);
  const need = (k) => {
    if (!env[k]) throw new Error(`environment variable ${k} is not set`);
    return env[k];
  };
  m.idp.userPoolId = need("COGNITO_USER_POOL_ID");
  m.idp.clientId = need("COGNITO_CLIENT_ID");
  for (const p of m.providers) if (p.kind === "google" && p.mode === "gis_id_token") p.clientId = need("GOOGLE_CLIENT_ID");
  return validateManifest(m);
}

const json = (statusCode, body, extra = {}) => ({
  statusCode,
  headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
  body: JSON.stringify(body),
});
const stripDomain = (c) => c.replace(/;\s*Domain=[^;]*/i, "");

function cookiesOf(event) {
  const out = {};
  const hdr = Object.entries(event.headers ?? {}).find(([k]) => k.toLowerCase() === "cookie")?.[1];
  for (const chunk of [...(event.cookies ?? []), ...(hdr ? [hdr] : [])])
    for (const part of String(chunk).split(";")) {
      const i = part.indexOf("=");
      if (i > 0) out[part.slice(0, i).trim()] ??= part.slice(i + 1).trim();
    }
  return out;
}

function headersOf(event) {
  const h = {};
  for (const [k, v] of Object.entries(event.headers ?? {})) if (v !== undefined) h[k.toLowerCase()] = String(v);
  return h;
}
function jsonBodyOf(event) {
  try {
    const v = JSON.parse(event.isBase64Encoded && event.body ? Buffer.from(event.body, "base64").toString("utf8") : (event.body ?? "{}"));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/**
 * `limiter` ({hit(key, {limit, windowSeconds})}, see ratelimit.js) rate-limits POST /auth/password/forgot per `forgotLimits`;
 * without one the route is not limited (unit tests). A limiter failure fails closed (503): no email is sent.
 */
export function createAuthEdge({ manifest, identity, verify, publicJwk, lifecycle, fetch: fetchImpl, nonce, oauth, passkeys, passkeyClientScript, limiter, forgotLimits = FORGOT_LIMITS, log = console }) {
  const app = createEdgeApp(manifest, { identity, verify, ...(lifecycle ? { lifecycle } : {}), ...(fetchImpl ? { fetch: fetchImpl } : {}), ...(nonce ? { nonce } : {}), ...(passkeys ? { passkeys, ...(passkeyClientScript ? { passkeyClientScript } : {}) } : {}) });
  const jwksBody = JSON.stringify({ keys: [publicJwk] });
  const siteOrigin = String(manifest.authOrigin ?? `https://${manifest.site}`).replace(/\/+$/, "");
  const returnOrigins = (manifest.returnOrigins ?? []).map((o) => String(o).replace(/\/+$/, ""));
  const safe = (v) => safeReturnTo(v, siteOrigin, returnOrigins);

  /** 429 when any forgot-password window is exhausted; undefined to let the request through. Only counts requests the kit would act on. */
  async function forgotLimited(event) {
    const h = headersOf(event);
    if (h["x-requested-with"] !== "io-kit") return undefined; // the kit refuses it (403) without calling Cognito
    if (h.origin && h.origin.replace(/\/+$/, "") !== siteOrigin) return undefined;
    const b = jsonBodyOf(event);
    const who = { email: typeof b.email === "string" ? b.email.trim().toLowerCase() : "", ip: clientIp(event) };
    let results;
    try {
      results = await Promise.all(forgotLimits.map((r) => limiter.hit(rateKey("forgot", r.scope, who), r)));
    } catch (e) {
      log.error?.(JSON.stringify({ msg: "forgot-password rate limiter unavailable", error: e instanceof Error ? e.message : String(e) }));
      return json(503, { code: "AUTH_NETWORK" });
    }
    const denied = results.filter((r) => !r.allowed);
    if (!denied.length) return undefined;
    return json(429, { code: "AUTH_FORBIDDEN", detail: "rate_limited" }, { "retry-after": String(Math.max(...denied.map((r) => r.retryAfter))) });
  }

  /** /auth/password answers {ok, returnTo}; the page then does location.assign(returnTo). */
  function sanitizeReturnBody(res) {
    if (res.statusCode !== 200 || typeof res.body !== "string" || !res.body) return res;
    try {
      const b = JSON.parse(res.body);
      if (b && typeof b === "object" && "returnTo" in b) return { ...res, body: JSON.stringify({ ...b, returnTo: safe(b.returnTo) }) };
    } catch {
      // not JSON: leave it alone
    }
    return res;
  }
  function sanitizeLocation(res) {
    const k = Object.keys(res.headers ?? {}).find((x) => x.toLowerCase() === "location");
    return k && typeof res.headers[k] === "string" ? { ...res, headers: { ...res.headers, [k]: safe(res.headers[k]) } } : res;
  }

  async function sessionOf(event) {
    const tok = cookiesOf(event).io_id;
    if (!tok) return null;
    try {
      const { principal } = await resolveAuth(tok, { ...verify, identity: undefined, tokenUse: "id" });
      return { sub: principal.sub, label: principal.displayName ?? principal.sub };
    } catch {
      return null;
    }
  }
  async function sessionInfo(event) {
    const s = await sessionOf(event);
    return s ? json(200, { authenticated: true, sub: s.sub, grampsId: s.sub, label: s.label }) : json(200, { authenticated: false });
  }

  function adapt(res) {
    const out = { ...res, headers: { ...(res.headers ?? {}) } };
    if (out.cookies) out.cookies = out.cookies.map(stripDomain); // host-only cookie: drop the kit's Domain attribute
    for (const k of Object.keys(out.headers)) {
      const v = out.headers[k];
      if (k.toLowerCase() === "set-cookie") out.headers[k] = Array.isArray(v) ? v.map(stripDomain) : stripDomain(String(v));
      if (k.toLowerCase() === "location" && typeof v === "string") out.headers[k] = v.replace(/^\/(login|verify|link|password\/forgot|password\/reset)(?=$|[?#])/, `${MOUNT}/$1`);
    }
    const ct = Object.entries(out.headers).find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
    if (/text\/html/.test(ct) && typeof out.body === "string") out.body = out.body.replace(ABS_LINK, `$1${MOUNT}/$2`);
    return out;
  }

  return async function handler(event) {
    const method = (event.requestContext?.http?.method ?? event.httpMethod ?? "GET").toUpperCase();
    const raw = ((event.rawPath ?? event.requestContext?.http?.path ?? "/").replace(/\/+$/, "")) || "/";
    if (raw === `/.well-known/oauth-authorization-server${MOUNT}`) {
      // RFC 8414 root discovery for the issuer https://<site>/auth (HFY-R44); the same document is served at /auth/.well-known/oauth-authorization-server
      return (oauth && (await oauth.handle("/.well-known/oauth-authorization-server", event, async () => null))) ?? json(404, { code: "NOT_FOUND" });
    }
    if (raw !== MOUNT && !raw.startsWith(`${MOUNT}/`)) return json(404, { code: "NOT_FOUND" });
    const rel = raw.slice(MOUNT.length) || "/";
    if (rel === "/.well-known/jwks.json") {
      if (method !== "GET" && method !== "HEAD") return json(405, { code: "METHOD_NOT_ALLOWED" });
      return { statusCode: 200, headers: { "content-type": "application/json", "cache-control": "public, max-age=300" }, body: jwksBody };
    }
    // HFY-TSK-078: "Manage passkeys" lives on the kit's account page (lists and removes the caller's own credentials; DELETE /auth/passkey/:id).
    if (rel === "/passkeys") return method === "GET" || method === "HEAD" ? { statusCode: 302, headers: { location: `${MOUNT}/link`, "cache-control": "no-store" }, body: "" } : json(405, { code: "METHOD_NOT_ALLOWED" });
    if (rel === "/session") return method === "GET" ? sessionInfo(event) : json(405, { code: "METHOD_NOT_ALLOWED" });
    if (oauth) {
      const r = await oauth.handle(rel, event, () => sessionOf(event));
      if (r) return r;
    }
    // Users are created only by AdminCreateUser (POST /auth/link). ConfirmSignUp only ever confirms a self-service sign-up, which
    // this app never makes; refusing it keeps an account someone else signed up for an email from being confirmed here.
    if (rel === "/verify" && method === "POST") return json(410, { code: "AUTH_FORBIDDEN", detail: "signup_disabled" });
    if (rel === "/password/forgot" && method === "POST" && limiter) {
      const limited = await forgotLimited(event);
      if (limited) return limited;
    }
    let ev = event;
    const qs = event.queryStringParameters ?? {};
    if (rel === "/login") {
      // returnTo is normalized here, before the kit page embeds it as ioReturn (see safeReturnTo).
      // /auth/authorize sends signed-out visitors to /auth/login?next=<authorize url>; the kit page calls that parameter returnTo.
      let returnTo = typeof qs.returnTo === "string" && qs.returnTo ? safe(qs.returnTo) : undefined;
      if (!returnTo && typeof qs.next === "string") {
        const next = safe(qs.next);
        if (next.startsWith(`${MOUNT}/authorize?`)) returnTo = next;
      }
      const { returnTo: _dropped, ...rest } = qs;
      ev = { ...event, queryStringParameters: { ...rest, ...(returnTo ? { returnTo } : {}) } };
    }
    const kitPath = ROOT_ROUTES.has(rel) ? rel : raw;
    const res = adapt(await app({ ...ev, rawPath: kitPath }));
    if (rel === "/password" || rel === "/passkey/login/verify") return sanitizeReturnBody(res); // the kit's own returnTo check lets "/\t/evil.example" through
    if (rel === "/callback" && res.statusCode >= 300 && res.statusCode < 400) return sanitizeLocation(res);
    return res;
  };
}
