// harrisonfamily auth edge, mounted at https://harrisonfamily.us/auth/* (HFY-R31), on @io-kit/auth 2.2.0's createEdgeApp.
// The kit deployable is written for auth.<site> (routes at the root). This wrapper adapts it to a path mount and adds the three
// things the kit does not ship: GET /auth/.well-known/jwks.json (HFY-R38), GET /auth/session, and host-only cookies (HFY-R31).
import { createEdgeApp, validateManifest } from "@io-kit/auth/edge/deploy";
import { COGNITO_GROUP_CLAIM, claimsToPrincipal, resolveAuth } from "@io-kit/auth/server";
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
/** The same routes as an encoded returnTo value on a kit redirect (`/login?returnTo=%2Flink`): they need the mount too. */
const RETURN_TO_ROOT = /([?&]returnTo=)%2F(login|verify|link|password%2Fforgot|password%2Freset)(?=$|[&#])/i;

/**
 * HFY override (design system, SignIn): the edge pages load the self-hosted brand fonts that 11ty/css/auth-edge.css declares
 * (/fonts/*.woff2, same origin as the page). Kit root cause (fixed in @io-kit/auth 2.2.0): cspFor() emitted no font-src, so
 * `default-src 'none'` refused every web font; 2.2.0 reads the manifest's theme.fontOrigins (["self"] in edge.manifest.json), so this is
 * now a no-op on every page and stays only as a guard for a manifest without it. Appends `font-src 'self'` to a CSP that has no
 * font-src; never touches one that does. Deletable once a deploy has proved the manifest value (HFY-TSK-084).
 */
export const FONT_SRC = "font-src 'self'";
export function cspWithFontSrc(csp) {
  if (typeof csp !== "string" || !csp.trim()) return csp;
  if (/(^|;)\s*font-src(\s|;|$)/i.test(csp)) return csp;
  return `${csp.replace(/[\s;]+$/, "")}; ${FONT_SRC}`;
}

/**
 * HFY override (design system, SignIn): the Google button on the dark archive ground. Kit root cause: @io-kit/auth 2.2.0 loginPage()
 * hard-codes the GIS button as data-theme="outline" (a white slab on the dark card) and data-width="280" (narrower than the 343px
 * sign-in buttons at 375); upstream: a manifest GIS button theme/width. Only the g_id_signin element's attributes are rewritten.
 * Google draws the button itself, and these are accepted as design-system exceptions (QA2): it is capped at 40px tall
 * (data-size="large"), its label is Google's own sentence-case "Continue with Google" at about 14px (the DS anatomy asks for 18px
 * lowercase on a 56px surface.raised button), and its width is fixed at 343 (390 wide siblings from 688). The kit's broker-mode button
 * is kit markup and could be themed to the anatomy; until then the Google row is Google's.
 */
export function gisButtonDark(html) {
  return html.replace(/<div class="g_id_signin"[^>]*>/, (tag) => tag.replace('data-theme="outline"', 'data-theme="filled_black"').replace('data-width="280"', 'data-width="343"'));
}

/**
 * HFY override (design system, SignIn: one focus rule, a 2px gold ring at a 2px offset). Google GIS draws its own focus inside its
 * cross-origin iframe (a 2px #00639b ring, 2.90:1 on surface / 2.57:1 on surface.raised, under the 3:1 non-text floor) and the page
 * cannot style it: while focus is in the iframe, document.activeElement is the IFRAME but it matches neither :focus nor :focus-visible,
 * and .gsi matches neither :focus-within nor :has(iframe:focus). Kit / Google root cause: @io-kit/auth 2.2.0 loginPage() offers no
 * focus hook for the GIS button; upstream: a kit hook (or the broker-mode button, which is the kit's own markup).
 * This appends a small script, under the page's own script nonce (the CSP is script-src 'nonce-…'), that marks .gsi with
 * data-gis-focus when keyboard focus (the last key was Tab) moves into the GIS iframe, and clears it when focus or a pointer comes
 * back to the page; 11ty/css/auth-edge.css draws the ring on it. Pages without a .gsi row, or without a nonce, are left alone.
 */
export const GIS_FOCUS_SCRIPT = '(function(){var g=document.querySelector(".gsi");if(!g)return;var k=false;' +
  'function off(){g.removeAttribute("data-gis-focus")}' +
  'document.addEventListener("keydown",function(e){k=e.key==="Tab"},true);' +
  'document.addEventListener("pointerdown",function(){k=false;off()},true);' +
  'document.addEventListener("focusin",function(e){var t=e.target;if(!(t&&t.tagName==="IFRAME"&&g.contains(t)))off()},true);' +
  'window.addEventListener("focus",off);' +
  'window.addEventListener("blur",function(){setTimeout(function(){var a=document.activeElement;' +
  'if(k&&a&&a.tagName==="IFRAME"&&g.contains(a))g.setAttribute("data-gis-focus","")},0)})})();';
export function gisFocusRing(html) {
  if (typeof html !== "string" || !/class="gsi"/.test(html) || html.includes("data-hfy-gis-focus")) return html;
  const nonce = /<script\b[^>]*\bnonce="([^"]+)"/i.exec(html)?.[1];
  if (!nonce || !/<\/body>/i.test(html)) return html;
  return html.replace(/<\/body>/i, `<script nonce="${nonce}" data-hfy-gis-focus>${GIS_FOCUS_SCRIPT}</script></body>`);
}

/**
 * HFY override (design system, SignIn states: "allowlist (banner accent.secondary border: that email isn't on the list yet. text J and
 * we'll add you. + copy my email)"). Being new to the list is not the member's mistake, so it is a neutral banner with a way to hand J
 * the address, not the red error banner a wrong password gets. Kit root cause: @io-kit/auth 2.2.0 loginPage() ioFail() and ioMsg() put
 * className 'msg show' on every failure whatever r.body.detail was, so CSS cannot tell not_allowlisted from invalid_credentials, and the
 * kit has no copy-email affordance; upstream: a data-detail hook in ioMsg and a manifest copy-email action.
 * This appends a small script, under the page's own script nonce (script-src 'nonce-…'), that wraps the kit's global ioFail and ioMsg:
 * after the kit has written its message, a not_allowlisted failure marks the message with data-detail="not_allowlisted" (the stylesheet,
 * 11ty/css/auth-edge.css, gives that the accent.secondary banner) and, when an address was typed, appends a "copy my email" button that
 * copies it; where the clipboard is refused the button selects the field instead. Every other message clears the mark (ioMsg replaces
 * the text, so the button goes with it). Pages without a kit ioFail (forgot, reset, link) or without a nonce are left alone.
 */
const ALLOWLIST_HEAD = '(function(){if(typeof ioFail!=="function"||typeof ioMsg!=="function")return;' +
  'var kitMsg=ioMsg,kitFail=ioFail,LABEL="copy my email",DONE="copied";' +
  'window.ioMsg=function(id,t){kitMsg(id,t);var e=document.getElementById(id);if(e){e.removeAttribute("data-detail");e.removeAttribute("aria-atomic")}};' +
  'window.ioFail=function(id,r){kitFail(id,r);var e=document.getElementById(id);var d=r&&r.body&&r.body.detail;' +
  'if(!e||d!=="not_allowlisted")return;e.setAttribute("data-detail",d);';
// HFY-TSK-140 (surfaces.md 7.10): with ACCESS_REQUESTS=on the same banner also carries a quiet "ask to join" link to /join/. A same-origin
// link with no query string: the typed address never travels in a URL. It is added before the copy button and replaced with the text by ioMsg.
const ALLOWLIST_JOIN = 'var j=document.createElement("a");j.href="/join/";j.setAttribute("data-hfy-join","");j.textContent="ask to join";' +
  'e.appendChild(j);';
const ALLOWLIST_TAIL = 'var f=document.getElementById("email");var a=f&&f.value?String(f.value).trim():"";if(!a)return;' +
  'e.setAttribute("aria-atomic","false");' + // the role=alert message is no longer re-read whole when the button says "copied"
  'var b=document.createElement("button");b.type="button";b.setAttribute("data-copy-email","");b.textContent=LABEL;' +
  'function pick(){f.focus();f.select()}' +
  'b.addEventListener("click",function(){try{navigator.clipboard.writeText(a).then(function(){b.textContent=DONE;' +
  'setTimeout(function(){b.textContent=LABEL},2000)},pick)}catch(x){pick()}});e.appendChild(b)}})();';
export const ALLOWLIST_NOTICE_SCRIPT = ALLOWLIST_HEAD + ALLOWLIST_TAIL;
export const ALLOWLIST_NOTICE_JOIN_SCRIPT = ALLOWLIST_HEAD + ALLOWLIST_JOIN + ALLOWLIST_TAIL;
export function allowlistNotice(html, { join = false } = {}) {
  if (typeof html !== "string" || !/function ioFail\(/.test(html) || html.includes("data-hfy-allowlist")) return html;
  const nonce = /<script\b[^>]*\bnonce="([^"]+)"/i.exec(html)?.[1];
  if (!nonce || !/<\/body>/i.test(html)) return html;
  const script = join ? ALLOWLIST_NOTICE_JOIN_SCRIPT : ALLOWLIST_NOTICE_SCRIPT;
  return html.replace(/<\/body>/i, `<script nonce="${nonce}" data-hfy-allowlist>${script}</script></body>`);
}
/**
 * The same state on the denied page (the kit's 403 HTML page for a callback or a form post the allowlist refused): its one sentence is
 * the allowlist message, so it gets the same banner (auth-edge.css styles p[data-state="not_allowlisted"]). There is no address to copy
 * on that page. Only the kit's denied markup (h1, then the sentence) of a 403 is touched.
 */
export function deniedNotice(html, statusCode, { join = false } = {}) {
  if (statusCode !== 403 || typeof html !== "string") return html;
  const marked = html.replace(/(<main>(?:<img[^>]*>)?<h1>[^<]*<\/h1>)<p>/, '$1<p data-state="not_allowlisted">');
  // HFY-TSK-140: with ACCESS_REQUESTS=on the denied page also offers "ask to join" (a plain /join/ link; no address in the URL).
  return join ? marked.replace(/(<p data-state="not_allowlisted">[\s\S]*?<\/p>)/, '$1<p data-hfy-join>new here? <a href="/join/">ask to join.</a></p>') : marked;
}

/**
 * HFY override (Voice): two error strings the kit hard-codes in its form-page script, sentence case and without a way out. Kit root
 * cause: @io-kit/auth 2.2.0 formPage() writes 'The code is not valid or has expired.' (invalid_code) and 'Choose a stronger password.'
 * (weak_password) as literals, so manifest copy cannot reach them; upstream: invalid_code and weak_password copy keys. Only those exact
 * literals are replaced, so a kit release that moves them to copy makes this a no-op.
 */
export const KIT_STRINGS = [
  ["'The code is not valid or has expired.'", JSON.stringify("that code didn't work. check your email for the newest one, or text J.")],
  ["'Choose a stronger password.'", JSON.stringify("pick a stronger password. try again, or text J.")],
];
export function kitVoice(html) {
  if (typeof html !== "string") return html;
  return KIT_STRINGS.reduce((out, [from, to]) => out.split(from).join(to), html);
}

/**
 * HFY override: /auth/link (signed in) is a dead end, with no way back to the site but the browser's back button. Kit root cause:
 * @io-kit/auth 2.2.0 linkPage() renders no return link; upstream: a returnTo link on linkPage. Appends one quiet escape link in the
 * kit's own "sign in" escape-link style (a.btn.alt, see auth-edge.css) as the last thing in main. Only the signed-in page (its linked
 * methods list) is touched.
 */
export const BACK_LINK = '<a class="btn alt" href="/" data-hfy-back>back to the family site</a>';
export function backToSite(html) {
  if (typeof html !== "string" || !html.includes('class="linked"') || html.includes("data-hfy-back")) return html;
  return html.replace(/<\/main>/i, `${BACK_LINK}</main>`);
}

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
 * `firstPassword` ({isOpen(), provision(email)}, see cognito.js cognitoFirstPassword; SURF-D18) provisions an allowlisted member's Cognito user
 * on POST /auth/password/forgot, after the limiter and before the kit sends the code; it does nothing unless `isOpen()` (env FIRST_PASSWORD=on).
 * `accessRequests` ({handle(rel, event)}, see access-request.js) serves the anonymous /auth/access-request/* routes behind ACCESS_REQUESTS;
 * without it those paths fall through to the kit's 404.
 */
export function createAuthEdge({ manifest, identity, verify, publicJwk, lifecycle, fetch: fetchImpl, nonce, oauth, passkeys, passkeyClientScript, limiter, forgotLimits = FORGOT_LIMITS, accessRequests, firstPassword, log = console }) {
  const app = createEdgeApp(manifest, { identity, verify, ...(lifecycle ? { lifecycle } : {}), ...(fetchImpl ? { fetch: fetchImpl } : {}), ...(nonce ? { nonce } : {}), ...(passkeys ? { passkeys, ...(passkeyClientScript ? { passkeyClientScript } : {}) } : {}) });
  const jwksBody = JSON.stringify({ keys: [publicJwk] });
  const siteOrigin = String(manifest.authOrigin ?? `https://${manifest.site}`).replace(/\/+$/, "");
  const returnOrigins = (manifest.returnOrigins ?? []).map((o) => String(o).replace(/\/+$/, ""));
  const safe = (v) => safeReturnTo(v, siteOrigin, returnOrigins);
  /** True while ACCESS_REQUESTS is on: the sign-in and denied pages then link to /join/ (HFY-TSK-140). An edge built without access requests never does. */
  const joinOpen = () => { try { return accessRequests?.isOpen?.() === true; } catch { return false; } };

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

  /**
   * SURF-D18 (io's Q2-12): an allowlisted member with no Cognito user gets one, with a random permanent password, so the kit's forgot flow can mail
   * the code that sets the first password. Runs after forgotLimited, only for requests the kit would act on (same checks), and only while
   * FIRST_PASSWORD is on. 502 AUTH_NETWORK (the kit's own Cognito-unreachable answer) when Cognito fails: no code is sent. Never logs the address.
   */
  async function provisionFirstPassword(event) {
    try {
      if (firstPassword?.isOpen?.() !== true) return undefined;
    } catch {
      return undefined;
    }
    const h = headersOf(event);
    if (h["x-requested-with"] !== "io-kit") return undefined;
    if (h.origin && h.origin.replace(/\/+$/, "") !== siteOrigin) return undefined;
    const b = jsonBodyOf(event);
    if (typeof b.email !== "string" || !b.email.trim()) return undefined;
    try {
      await firstPassword.provision(b.email);
    } catch (e) {
      log.error?.(JSON.stringify({ msg: "first-password provisioning failed", error: e instanceof Error ? e.name : "error" }));
      return json(502, { code: "AUTH_NETWORK" });
    }
    return undefined;
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

  /**
   * The signed-in member behind the io_id cookie: {sub, label, email, amr, authTime, exp}. Everything comes from the VERIFIED token
   * (signature, issuer, audience, expiry, token_use=id). resolveAuth maps claims to a principal that has no `email` or `exp`, so the adapter
   * hook below reads them from the same verified claims object (no second, unverified decode). authTime is epoch seconds: the token's
   * auth_time claim, else its iat (the kit's claimsToPrincipal rule); amr is [] when the token has none; exp is the token's expiry.
   */
  async function sessionOf(event) {
    const tok = cookiesOf(event).io_id;
    if (!tok) return null;
    let email;
    let exp;
    const adapter = {
      toPrincipal: (claims) => {
        if (typeof claims.email === "string" && claims.email) email = claims.email;
        if (Number.isFinite(claims.exp)) exp = Math.floor(claims.exp);
        return claimsToPrincipal(claims, COGNITO_GROUP_CLAIM);
      },
    };
    try {
      const { principal } = await resolveAuth(tok, { ...verify, identity: undefined, tokenUse: "id", adapter });
      return {
        sub: principal.sub,
        label: principal.displayName ?? principal.sub,
        email,
        amr: Array.isArray(principal.amr) ? principal.amr : [],
        authTime: Number.isFinite(principal.authTime) ? Math.floor(principal.authTime) : 0,
        exp,
      };
    } catch {
      return null;
    }
  }
  /**
   * GET /auth/session. `exp` (epoch seconds) is when the io_id session token expires (HFY-R66): the cookie is HttpOnly, so this is how a page
   * knows to POST /auth/refresh (X-Requested-With: io-kit; the io_rt cookie is Path=/auth) before its first data fetch when the session is
   * about to lapse. Signed out (no io_id, or an invalid/expired one) is {authenticated: false}; a page may still try one refresh then.
   */
  async function sessionInfo(event) {
    const s = await sessionOf(event);
    return s ? json(200, { authenticated: true, sub: s.sub, grampsId: s.sub, label: s.label, ...(s.exp !== undefined ? { exp: s.exp } : {}) }) : json(200, { authenticated: false });
  }

  function adapt(res, rel) {
    const out = { ...res, headers: { ...(res.headers ?? {}) } };
    if (out.cookies) out.cookies = out.cookies.map(stripDomain); // host-only cookie: drop the kit's Domain attribute
    const ct = Object.entries(out.headers).find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
    const isHtml = /text\/html/i.test(String(ct));
    for (const k of Object.keys(out.headers)) {
      const v = out.headers[k];
      if (k.toLowerCase() === "set-cookie") out.headers[k] = Array.isArray(v) ? v.map(stripDomain) : stripDomain(String(v));
      // The kit's signed-out /link redirect is "/login?returnTo=%2Flink": both the path and the returnTo value need the mount,
      // or the member signs in and lands on /link, which is not a page on the site.
      if (k.toLowerCase() === "location" && typeof v === "string") out.headers[k] = v.replace(/^\/(login|verify|link|password\/forgot|password\/reset)(?=$|[?#])/, `${MOUNT}/$1`).replace(RETURN_TO_ROOT, "$1%2Fauth%2F$2");
      // HFY override, see cspWithFontSrc (kit root cause: @io-kit/auth 2.1.2 cspFor() emits no font-src; upstream: theme.fontOrigins).
      if (isHtml && k.toLowerCase() === "content-security-policy" && typeof v === "string") out.headers[k] = cspWithFontSrc(v);
    }
    // HFY overrides, see gisButtonDark (kit root cause: @io-kit/auth 2.2.0 loginPage() hard-codes the light 280px GIS button),
    // gisFocusRing (Google draws its own sub-3:1 focus ring inside the GIS iframe; the kit offers no focus hook), allowlistNotice and
    // deniedNotice (the allowlist state is a neutral banner, not the kit's one red error), kitVoice (two hard-coded form strings) and
    // backToSite (the signed-in /auth/link has no way back to the site).
    if (isHtml && typeof out.body === "string") {
      const page = gisFocusRing(gisButtonDark(out.body.replace(ABS_LINK, `$1${MOUNT}/$2`)));
      const join = joinOpen();
      out.body = rel === "/link" ? backToSite(page) : allowlistNotice(deniedNotice(kitVoice(page), out.statusCode, { join }), { join });
    }
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
    // surfaces.md 7.2: the anonymous access-request routes, before the kit fall-through (they never reach the kit app)
    if (accessRequests && (rel === "/access-request" || rel.startsWith("/access-request/"))) {
      const r = await accessRequests.handle(rel, event);
      if (r) return r;
    }
    if (oauth) {
      const r = await oauth.handle(rel, event, () => sessionOf(event));
      if (r) return r;
    }
    // Users are created only by AdminCreateUser (POST /auth/link). ConfirmSignUp only ever confirms a self-service sign-up, which
    // this app never makes; refusing it keeps an account someone else signed up for an email from being confirmed here.
    if (rel === "/verify" && method === "POST") return json(410, { code: "AUTH_FORBIDDEN", detail: "signup_disabled" });
    if (rel === "/password/forgot" && method === "POST") {
      if (limiter) {
        const limited = await forgotLimited(event);
        if (limited) return limited;
      }
      if (firstPassword) {
        const failed = await provisionFirstPassword(event);
        if (failed) return failed;
      }
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
    const res = adapt(await app({ ...ev, rawPath: kitPath }), rel);
    if (rel === "/password" || rel === "/passkey/login/verify") return sanitizeReturnBody(res); // the kit's own returnTo check lets "/\t/evil.example" through
    if (rel === "/callback" && res.statusCode >= 300 && res.statusCode < 400) return sanitizeLocation(res);
    return res;
  };
}
