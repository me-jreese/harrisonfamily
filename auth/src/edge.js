// harrisonfamily auth edge, mounted at https://harrisonfamily.us/auth/* (HFY-R31), on @io-kit/auth 2.0.0's createEdgeApp.
// The kit deployable is written for auth.<site> (routes at the root). This wrapper adapts it to a path mount and adds the three
// things the kit does not ship: GET /auth/.well-known/jwks.json (HFY-R38), GET /auth/session, and host-only cookies (HFY-R31).
import { createEdgeApp, validateManifest } from "@io-kit/auth/edge/deploy";
import { resolveAuth } from "@io-kit/auth/server";

export const MOUNT = "/auth";
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

/**
 * The kit's login page posts with fetch() and no payload hash. CloudFront OAC -> Lambda Function URL requires
 * x-amz-content-sha256 on POST/PUT, so the page is patched to send the SHA-256 of the body. Returns the page unchanged if the kit's
 * script no longer matches (the unit test pins the kit literal).
 */
export function patchPostHash(html) {
  const sig = "async function ioPost(url,body){";
  if (!html.includes(sig) || !html.includes("body:JSON.stringify(body)")) return html;
  const hash =
    "var __s=JSON.stringify(body);var __h=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(__s)))).map(function(b){return b.toString(16).padStart(2,'0')}).join('');";
  return html
    .replace(sig, sig + hash)
    .replace("headers:{'content-type':'application/json',", "headers:{'x-amz-content-sha256':__h,'content-type':'application/json',")
    .replace("body:JSON.stringify(body)", "body:__s");
}

export function createAuthEdge({ manifest, identity, verify, publicJwk, lifecycle, fetch: fetchImpl, nonce, oauth }) {
  const app = createEdgeApp(manifest, { identity, verify, ...(lifecycle ? { lifecycle } : {}), ...(fetchImpl ? { fetch: fetchImpl } : {}), ...(nonce ? { nonce } : {}) });
  const jwksBody = JSON.stringify({ keys: [publicJwk] });

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
    if (/text\/html/.test(ct) && typeof out.body === "string") out.body = patchPostHash(out.body.replace(ABS_LINK, `$1${MOUNT}/$2`));
    return out;
  }

  return async function handler(event) {
    const method = (event.requestContext?.http?.method ?? event.httpMethod ?? "GET").toUpperCase();
    const raw = ((event.rawPath ?? event.requestContext?.http?.path ?? "/").replace(/\/+$/, "")) || "/";
    if (raw !== MOUNT && !raw.startsWith(`${MOUNT}/`)) return json(404, { code: "NOT_FOUND" });
    const rel = raw.slice(MOUNT.length) || "/";
    if (rel === "/.well-known/jwks.json") {
      if (method !== "GET" && method !== "HEAD") return json(405, { code: "METHOD_NOT_ALLOWED" });
      return { statusCode: 200, headers: { "content-type": "application/json", "cache-control": "public, max-age=300" }, body: jwksBody };
    }
    if (rel === "/session") return method === "GET" ? sessionInfo(event) : json(405, { code: "METHOD_NOT_ALLOWED" });
    if (oauth) {
      const r = await oauth.handle(rel, event, () => sessionOf(event));
      if (r) return r;
    }
    let ev = event;
    const qs = event.queryStringParameters ?? {};
    // /auth/authorize sends signed-out visitors to /auth/login?next=<authorize url>; the kit page calls that parameter returnTo
    if (rel === "/login" && !qs.returnTo && typeof qs.next === "string" && qs.next.startsWith(`${MOUNT}/authorize?`)) ev = { ...event, queryStringParameters: { ...qs, returnTo: qs.next } };
    const kitPath = ROOT_ROUTES.has(rel) ? rel : raw;
    return adapt(await app({ ...ev, rawPath: kitPath }));
  };
}
