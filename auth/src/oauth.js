// OAuth 2.1 authorization server for MCP clients (HFY-TSK-076), served from the same edge as the cookie sign-in.
// Public client only (token_endpoint_auth_method none), PKCE S256 required, one fixed client `mcp-harrisonfamily`.
// Access tokens are RS256 JWTs signed with the SAME key/kid as the session cookie (Q-MCP-1), published at /auth/.well-known/jwks.json.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { SignJWT } from "jose";

export const DEFAULT_CLIENT_ID = "mcp-harrisonfamily";
export const CODE_TTL_S = 120;
export const ACCESS_TTL_S = 3600;
export const REFRESH_TTL_S = 30 * 86400;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const SCOPE_RE = /^[A-Za-z0-9:._\/ -]{1,200}$/;

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const sha256 = (s) => createHash("sha256").update(s).digest();
const keyOf = (s) => b64u(sha256(s));
const noStore = { "cache-control": "no-store", pragma: "no-cache" };
const json = (status, body, extra = {}) => ({ statusCode: status, headers: { "content-type": "application/json", ...noStore, ...extra }, body: JSON.stringify(body) });
const err = (status, error, error_description) => json(status, { error, error_description });
const redirectTo = (location) => ({ statusCode: 302, headers: { location, ...noStore }, body: "" });
const safeEq = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** DynamoDB single-table store (hfy-app). take() is an atomic delete that returns the old item: one-time use. */
export function ddbOAuthStore({ doc, cmds, table }) {
  return {
    async put(item) { await doc.send(new cmds.PutCommand({ TableName: table, Item: { SK: "META", ...item } })); },
    async get(pk) { return (await doc.send(new cmds.GetCommand({ TableName: table, Key: { PK: pk, SK: "META" } }))).Item; },
    async take(pk) { return (await doc.send(new cmds.DeleteCommand({ TableName: table, Key: { PK: pk, SK: "META" }, ReturnValues: "ALL_OLD" }))).Attributes; },
  };
}
export function memoryOAuthStore() {
  const m = new Map();
  return { put: async (i) => { m.set(i.PK, { SK: "META", ...i }); }, get: async (pk) => m.get(pk), take: async (pk) => { const v = m.get(pk); m.delete(pk); return v; } };
}

export function createOAuthServer({ issuer, redirectUris, resources, clientId = DEFAULT_CLIENT_ID, store, signer, groupsFor, corsOrigins = [], now = () => Date.now(), random = (n) => randomBytes(n) }) {
  if (!redirectUris?.length) throw new Error("redirectUris must not be empty");
  if (!resources?.length) throw new Error("resources must not be empty");
  if (corsOrigins.some((o) => !/^https:\/\/[^/*\s]+$/.test(o))) throw new Error("corsOrigins must be exact https origins (no wildcard)");
  const base = issuer.replace(/\/+$/, "");
  const mount = new URL(base).pathname.replace(/\/+$/, "") || "";
  const secs = () => Math.floor(now() / 1000);
  const withParams = (uri, params) => {
    const u = new URL(uri);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
    return u.toString();
  };
  const scopeOf = (s) => (typeof s === "string" && SCOPE_RE.test(s) ? s : "mcp");

  const metadata = () => json(200, {
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    revocation_endpoint: `${base}/revoke`,
    revocation_endpoint_auth_methods_supported: ["none"],
    jwks_uri: `${base}/.well-known/jwks.json`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mcp"],
    authorization_response_iss_parameter_supported: true,
  }, { "cache-control": "public, max-age=300" });

  async function authorize(q, sessionOf) {
    q = q ?? {};
    // errors that must NOT redirect (the redirect target is not trusted yet)
    if (q.client_id !== clientId) return err(400, "invalid_request", "unknown client_id");
    if (!q.redirect_uri || !redirectUris.includes(q.redirect_uri)) return err(400, "invalid_request", "redirect_uri is not registered");
    const back = (p) => redirectTo(withParams(q.redirect_uri, { ...p, state: q.state, iss: base }));
    if (q.response_type !== "code") return back({ error: "unsupported_response_type" });
    if (!CHALLENGE_RE.test(q.code_challenge ?? "") || q.code_challenge_method !== "S256") {
      return back({ error: "invalid_request", error_description: "PKCE with code_challenge_method=S256 is required" });
    }
    const resource = q.resource ? resources.find((r) => r === q.resource) : resources[0];
    if (!resource) return back({ error: "invalid_target", error_description: "unknown resource" });
    const session = await sessionOf();
    if (!session) return redirectTo(`${mount}/login?next=${encodeURIComponent(`${mount}/authorize?${new URLSearchParams(q).toString()}`)}`);
    if (!(await groupsFor(session.sub))) return back({ error: "access_denied", error_description: "not on the family access list" });
    const code = b64u(random(32));
    await store.put({
      PK: `MCPCODE#${keyOf(code)}`, clientId, redirectUri: q.redirect_uri, codeChallenge: q.code_challenge, sub: session.sub, resource, scope: scopeOf(q.scope),
      expiresAt: now() + CODE_TTL_S * 1000, ttl: secs() + CODE_TTL_S + 60,
    });
    return back({ code });
  }

  async function issue({ sub, resource, scope, groups, family }) {
    const iat = secs();
    const accessToken = await new SignJWT({ groups, scope, client_id: clientId, token_use: "access" })
      .setProtectedHeader({ alg: "RS256", kid: signer.kid, typ: "at+jwt" })
      .setSubject(sub).setIssuer(base).setAudience(resource).setIssuedAt(iat).setExpirationTime(iat + ACCESS_TTL_S).setJti(b64u(random(12)))
      .sign(signer.privateKey);
    const refreshToken = `hfyrt_${b64u(random(32))}`;
    await store.put({ PK: `MCPRT#${keyOf(refreshToken)}`, clientId, sub, resource, scope, family, expiresAt: now() + REFRESH_TTL_S * 1000, ttl: secs() + REFRESH_TTL_S + 3600 });
    return json(200, { access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refreshToken, scope });
  }

  async function token(p) {
    if (p.grant_type === "authorization_code") {
      const { code, redirect_uri: redirectUri, code_verifier: verifier } = p;
      if (!code || !redirectUri || !verifier) return err(400, "invalid_request", "code, redirect_uri and code_verifier are required");
      if (p.client_id !== clientId) return err(401, "invalid_client", "unknown client_id");
      if (!VERIFIER_RE.test(verifier)) return err(400, "invalid_request", "malformed code_verifier");
      const rec = await store.take(`MCPCODE#${keyOf(code)}`); // consumed whether or not the rest checks out
      if (!rec || rec.expiresAt <= now() || rec.clientId !== clientId || rec.redirectUri !== redirectUri) return err(400, "invalid_grant", "invalid, expired or already used code");
      if (!safeEq(b64u(sha256(verifier)), rec.codeChallenge)) return err(400, "invalid_grant", "PKCE verification failed");
      if (p.resource && p.resource !== rec.resource) return err(400, "invalid_target", "resource does not match the authorization request");
      const groups = await groupsFor(rec.sub);
      if (!groups) return err(400, "invalid_grant", "subject is no longer on the family access list");
      return issue({ sub: rec.sub, resource: rec.resource, scope: rec.scope, groups, family: b64u(random(12)) });
    }
    if (p.grant_type === "refresh_token") {
      const rt = p.refresh_token;
      if (!rt) return err(400, "invalid_request", "refresh_token is required");
      if (p.client_id && p.client_id !== clientId) return err(401, "invalid_client", "unknown client_id");
      const rec = await store.take(`MCPRT#${keyOf(rt)}`);
      if (!rec) {
        const used = await store.get(`MCPRTUSED#${keyOf(rt)}`);
        if (used) await store.put({ PK: `MCPFAM#${used.family}`, revoked: true, ttl: secs() + REFRESH_TTL_S + 3600 }); // replay: kill the whole family
        return err(400, "invalid_grant", "invalid or already used refresh token");
      }
      await store.put({ PK: `MCPRTUSED#${keyOf(rt)}`, family: rec.family, ttl: secs() + REFRESH_TTL_S + 3600 });
      if (rec.expiresAt <= now() || rec.clientId !== clientId || (await store.get(`MCPFAM#${rec.family}`))) return err(400, "invalid_grant", "refresh token revoked or expired");
      if (p.resource && p.resource !== rec.resource) return err(400, "invalid_target", "resource does not match the grant");
      const groups = await groupsFor(rec.sub);
      if (!groups) return err(400, "invalid_grant", "subject is no longer on the family access list");
      return issue({ sub: rec.sub, resource: rec.resource, scope: rec.scope, groups, family: rec.family });
    }
    return err(400, "unsupported_grant_type", "authorization_code and refresh_token are supported");
  }

  /** E16-R1: secretless registration facade. Always the fixed public client; never a secret; unknown redirect URIs rejected. */
  function register(body) {
    const wanted = body?.redirect_uris;
    if (wanted !== undefined && (!Array.isArray(wanted) || wanted.some((u) => typeof u !== "string"))) return err(400, "invalid_client_metadata", "redirect_uris must be an array of strings");
    if (wanted?.some((u) => !redirectUris.includes(u))) return err(400, "invalid_redirect_uri", "redirect_uri is not on the allowed list");
    if (body?.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== "none") return err(400, "invalid_client_metadata", "only token_endpoint_auth_method none is supported");
    return json(201, {
      client_id: clientId,
      client_name: typeof body?.client_name === "string" && body.client_name ? body.client_name.slice(0, 100) : "Harrison Family MCP",
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      redirect_uris: wanted?.length ? wanted : [...redirectUris],
      scope: "mcp",
    });
  }

  /** RFC 7009: revokes a refresh token (and its rotation family). Always 200 for unknown tokens; access tokens simply expire (1h). */
  async function revoke(p) {
    if (p.client_id && p.client_id !== clientId) return err(401, "invalid_client", "unknown client_id");
    const t = p.token;
    if (typeof t === "string" && t.startsWith("hfyrt_")) {
      const rec = (await store.take(`MCPRT#${keyOf(t)}`)) ?? (await store.get(`MCPRTUSED#${keyOf(t)}`));
      if (rec?.family) await store.put({ PK: `MCPFAM#${rec.family}`, revoked: true, ttl: secs() + REFRESH_TTL_S + 3600 });
    }
    return { statusCode: 200, headers: { "content-type": "application/json", ...noStore }, body: "{}" };
  }

  const bodyText = (e) => (e.isBase64Encoded && e.body ? Buffer.from(e.body, "base64").toString("utf8") : (e.body ?? ""));
  const ctype = (e) => String(Object.entries(e.headers ?? {}).find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "");
  function params(e) {
    const t = bodyText(e);
    if (/json/.test(ctype(e))) { try { const v = JSON.parse(t || "{}"); return v && typeof v === "object" ? v : {}; } catch { return {}; } }
    return Object.fromEntries(new URLSearchParams(t));
  }
  const ROUTES = { "/.well-known/oauth-authorization-server": "GET", "/authorize": "GET", "/token": "POST", "/register": "POST", "/revoke": "POST" };

  const CORS_ROUTES = new Set(["/.well-known/oauth-authorization-server", "/token", "/register", "/revoke"]);
  const headerOf = (e, name) => { const k = Object.keys(e.headers ?? {}).find((x) => x.toLowerCase() === name); return k ? e.headers[k] : undefined; };

  /** rel = path below the mount. Returns an edge result, or undefined when the path is not an OAuth route. */
  async function handle(rel, event, sessionOf) {
    const want = ROUTES[rel];
    if (!want) return undefined;
    const method = (event.requestContext?.http?.method ?? event.httpMethod ?? "GET").toUpperCase();
    // CORS: exact-origin allow list, no credentials, no wildcard. Requests without an Origin (server-to-server) are unaffected.
    const origin = headerOf(event, "origin");
    const allowed = typeof origin === "string" && corsOrigins.includes(origin);
    const cors = (r) => (CORS_ROUTES.has(rel) ? { ...r, headers: { ...r.headers, vary: "Origin", ...(allowed ? { "access-control-allow-origin": origin } : {}) } } : r);
    if (method === "OPTIONS" && CORS_ROUTES.has(rel)) {
      if (!allowed) return json(403, { error: "invalid_request", error_description: "origin not allowed" }, { vary: "Origin" });
      return { statusCode: 204, headers: { "access-control-allow-origin": origin, "access-control-allow-methods": `${want}, OPTIONS`, "access-control-allow-headers": "Content-Type, Authorization", "access-control-max-age": "600", vary: "Origin" }, body: "" };
    }
    if (method !== want && !(want === "GET" && method === "HEAD")) return cors(json(405, { error: "invalid_request", error_description: `use ${want}` }, { allow: want }));
    let r;
    try {
      if (rel === "/.well-known/oauth-authorization-server") r = metadata();
      else if (rel === "/authorize") r = await authorize(event.queryStringParameters, sessionOf);
      else if (rel === "/token") r = await token(params(event));
      else if (rel === "/revoke") r = await revoke(params(event));
      else r = register(params(event));
    } catch (e) {
      console.error(JSON.stringify({ msg: "oauth failure", rel, error: e instanceof Error ? e.message : String(e) }));
      r = json(503, { error: "server_error" });
    }
    return cors(r);
  }
  return { handle, metadata, authorize, token, register, revoke };
}
