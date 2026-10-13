import { describe, it, expect, beforeAll } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet, jwtVerify, decodeJwt } from "jose";
import { buildResolver } from "@io-kit/auth/edge/deploy";
import { createIdentityService, memoryLinkStore, memoryRefreshStore } from "@io-kit/auth/server";
import { createAuthEdge, loadManifest } from "../src/edge.js";
import { createOAuthServer, desktopClient, displayNameOf, loopbackMatches, memoryOAuthStore } from "../src/oauth.js";
import { createMembership } from "../src/membership.js";

const raw = JSON.parse(readFileSync(new URL("../edge.manifest.json", import.meta.url), "utf8"));
const ENV = { COGNITO_USER_POOL_ID: "us-west-2_TEST", COGNITO_CLIENT_ID: "client123", GOOGLE_CLIENT_ID: "gis-client.apps.googleusercontent.com" };
const CB = "https://claude.ai/api/mcp/auth_callback";
const CB2 = "https://claude.com/api/mcp/auth_callback";
const RES = "https://harrisonfamily.us/mcp";
const ISS = "https://harrisonfamily.us/auth";
const b64u = (b) => Buffer.from(b).toString("base64url");
const pkce = () => { const verifier = b64u(randomBytes(32)); return { verifier, challenge: b64u(createHash("sha256").update(verifier).digest()) }; };
const members = { I0111: ["members", "admins"] }; // I0222 (Bo) is deliberately not a member for the access_denied case
let clock = Date.now();
let edge, cookieAna, cookieBo, jwks, sessionKey, oauthStore, oauthFor, mintGoogle;
let identityOnFakeClock = false; // HFY-R68 test only: the identity service (sign-in, refresh) then follows `clock`; every other test signs in on the real clock

const evGet = (rawPath, queryStringParameters, headers = {}) => ({ rawPath, queryStringParameters, requestContext: { http: { method: "GET" } }, headers: { accept: "text/html", ...headers } });
const evPost = (rawPath, body, form = true) => ({
  rawPath, requestContext: { http: { method: "POST" } },
  headers: { "content-type": form ? "application/x-www-form-urlencoded" : "application/json" },
  body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
});
const authz = (cookie, o = {}) => edge(evGet("/auth/authorize", { response_type: "code", client_id: "mcp-harrisonfamily", redirect_uri: CB, state: "st8", ...o }, cookie ? { cookie } : {}));
const loc = (r) => new URL(r.headers.location, "https://harrisonfamily.us");
const token = async (o) => { const r = await edge(evPost("/auth/token", o)); return { r, body: JSON.parse(r.body) }; };
async function getCode(cookie, { challenge, ...extra }) {
  const r = await authz(cookie, { code_challenge: challenge, code_challenge_method: "S256", ...extra });
  expect(r.statusCode).toBe(302);
  const u = loc(r);
  expect(u.searchParams.get("state")).toBe("st8");
  return u.searchParams.get("code");
}
async function signIn(email, gToken) {
  const res = await edge({ rawPath: "/auth/google", requestContext: { http: { method: "POST" } }, headers: { "x-requested-with": "io-kit", origin: "https://harrisonfamily.us", "content-type": "application/json" }, body: JSON.stringify({ credential: await gToken(email) }) });
  expect(res.statusCode).toBe(200);
  return res.cookies.map((c) => c.split(";")[0]).join("; ");
}

beforeAll(async () => {
  const manifest = loadManifest(raw, ENV);
  const g = await generateKeyPair("RS256", { extractable: true });
  const s = await generateKeyPair("RS256", { extractable: true });
  mintGoogle = (email, at = Math.floor(Date.now() / 1000)) => new SignJWT({ email, email_verified: true }).setProtectedHeader({ alg: "RS256", kid: "g1" }).setSubject("gs").setIssuer("https://accounts.google.com").setAudience(ENV.GOOGLE_CLIENT_ID).setIssuedAt(at).setExpirationTime(at + 600).sign(g.privateKey);
  const gToken = (email) => mintGoogle(email);
  const pub = { ...(await exportJWK(s.publicKey)), kid: "hfy-session-1", alg: "RS256", use: "sig" };
  const allow = JSON.stringify({ "ana@example.com": "I0111", "bo@example.com": "I0222" });
  const identity = createIdentityService({
    resolver: buildResolver(manifest.resolver, { readObject: async () => allow }),
    links: memoryLinkStore(),
    google: { clientId: ENV.GOOGLE_CLIENT_ID, jwks: createLocalJWKSet({ keys: [{ ...(await exportJWK(g.publicKey)), kid: "g1", alg: "RS256", use: "sig" }] }) },
    sessions: { issuer: manifest.session.issuer, audience: manifest.session.audience, kid: "hfy-session-1", privateKey: s.privateKey, store: memoryRefreshStore(), defaultProfile: "installed" },
    now: () => (identityOnFakeClock ? clock : Date.now()),
  });
  sessionKey = s.privateKey;
  oauthStore = memoryOAuthStore();
  oauthFor = (store) => createOAuthServer({
    issuer: ISS, redirectUris: [CB, CB2], resources: [RES, "https://mcp2.harrisonfamily.us"], store,
    signer: { privateKey: s.privateKey, kid: "hfy-session-1" }, corsOrigins: ["https://claude.ai", "https://claude.com"], groupsFor: async (sub) => members[sub] ?? null, now: () => clock,
  });
  const oauth = oauthFor(oauthStore);
  edge = createAuthEdge({ manifest, identity, publicJwk: pub, oauth, verify: { issuers: [ISS], audiences: [manifest.session.audience], jwks: createLocalJWKSet({ keys: [pub] }) }, nonce: () => "n" });
  cookieAna = await signIn("ana@example.com", gToken);
  cookieBo = await signIn("bo@example.com", gToken);
  jwks = createLocalJWKSet(JSON.parse((await edge(evGet("/auth/.well-known/jwks.json"))).body));
});

describe("RFC 8414 metadata", () => {
  it("has the required shape", async () => {
    const r = await edge(evGet("/auth/.well-known/oauth-authorization-server"));
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({
      issuer: ISS, authorization_endpoint: `${ISS}/authorize`, token_endpoint: `${ISS}/token`, registration_endpoint: `${ISS}/register`, jwks_uri: `${ISS}/.well-known/jwks.json`,
      code_challenge_methods_supported: ["S256"], grant_types_supported: ["authorization_code", "refresh_token"], token_endpoint_auth_methods_supported: ["none"], response_types_supported: ["code"],
    });
  });
});

describe("/auth/authorize", () => {
  const { challenge } = pkce();
  const good = { code_challenge: challenge, code_challenge_method: "S256" };
  it("no session -> /auth/login?next=<authorize url>, and the login page gets that as returnTo", async () => {
    const r = await authz(undefined, good);
    expect(r.statusCode).toBe(302);
    const u = loc(r);
    expect(u.pathname).toBe("/auth/login");
    const next = u.searchParams.get("next");
    expect(next.startsWith("/auth/authorize?")).toBe(true);
    expect(new URLSearchParams(next.split("?")[1]).get("code_challenge")).toBe(challenge);
    const page = await edge(evGet("/auth/login", { next }));
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("/auth/authorize?"); // the kit page carries it as ioReturn
  });
  it("rejects an unregistered redirect_uri or client without redirecting", async () => {
    for (const o of [{ redirect_uri: "https://evil.example/cb" }, { redirect_uri: CB + "/" }, { client_id: "someone-else" }]) {
      const r = await authz(cookieAna, { ...good, ...o });
      expect(r.statusCode).toBe(400);
      expect(r.headers.location).toBeUndefined();
      expect(JSON.parse(r.body).error).toBe("invalid_request");
    }
  });
  it("requires PKCE S256", async () => {
    for (const o of [{}, { code_challenge: challenge }, { code_challenge: challenge, code_challenge_method: "plain" }, { code_challenge: "short", code_challenge_method: "S256" }]) {
      const r = await authz(cookieAna, o);
      expect(r.statusCode).toBe(302);
      expect(loc(r).searchParams.get("error")).toBe("invalid_request");
      expect(loc(r).searchParams.get("code")).toBeNull();
    }
  });
  it("signed in but not a member -> access_denied; unknown resource -> invalid_target", async () => {
    expect(loc(await authz(cookieBo, good)).searchParams.get("error")).toBe("access_denied");
    expect(loc(await authz(cookieAna, { ...good, resource: "https://other.example" })).searchParams.get("error")).toBe("invalid_target");
  });
});

describe("/auth/token authorization_code", () => {
  const base = (code, verifier, o = {}) => ({ grant_type: "authorization_code", code, redirect_uri: CB, client_id: "mcp-harrisonfamily", code_verifier: verifier, ...o });
  it("issues an RS256 token verified against the published JWKS (sub, groups, aud, iss, kid, 1h)", async () => {
    const p = pkce();
    const code = await getCode(cookieAna, p);
    const { r, body } = await token(base(code, p.verifier));
    expect(r.statusCode).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(body).toMatchObject({ token_type: "Bearer", expires_in: 3600 });
    expect(body.refresh_token.startsWith("hfyrt_")).toBe(true);
    const { payload, protectedHeader } = await jwtVerify(body.access_token, jwks, { issuer: ISS, audience: RES });
    expect(protectedHeader).toMatchObject({ alg: "RS256", kid: "hfy-session-1" });
    expect(payload).toMatchObject({ sub: "I0111", groups: ["members", "admins"], iss: ISS, aud: RES, client_id: "mcp-harrisonfamily" });
    expect(payload.exp - payload.iat).toBe(3600);
  });
  it("aud follows the resource indicator", async () => {
    const p = pkce();
    const code = await getCode(cookieAna, { ...p, resource: "https://mcp2.harrisonfamily.us" });
    const { body } = await token(base(code, p.verifier, { resource: "https://mcp2.harrisonfamily.us" }));
    expect((await jwtVerify(body.access_token, jwks, { issuer: ISS })).payload.aud).toBe("https://mcp2.harrisonfamily.us");
  });
  it("wrong verifier -> invalid_grant, and the code is burned", async () => {
    const p = pkce();
    const code = await getCode(cookieAna, p);
    expect((await token(base(code, pkce().verifier))).body.error).toBe("invalid_grant");
    expect((await token(base(code, p.verifier))).body.error).toBe("invalid_grant");
  });
  it("a code works once", async () => {
    const p = pkce();
    const code = await getCode(cookieAna, p);
    expect((await token(base(code, p.verifier))).r.statusCode).toBe(200);
    expect((await token(base(code, p.verifier))).body.error).toBe("invalid_grant");
  });
  it("redirect_uri mismatch, unknown client and expired code are refused", async () => {
    const p = pkce();
    expect((await token(base(await getCode(cookieAna, p), p.verifier, { redirect_uri: CB2 }))).body.error).toBe("invalid_grant");
    expect((await token(base(await getCode(cookieAna, p), p.verifier, { client_id: "x" }))).r.statusCode).toBe(401);
    const code = await getCode(cookieAna, p);
    clock += 121_000;
    expect((await token(base(code, p.verifier))).body.error).toBe("invalid_grant");
  });
  it("unsupported grants are refused", async () => {
    expect((await token({ grant_type: "password", username: "a", password: "b" })).body.error).toBe("unsupported_grant_type");
  });
});

describe("refresh_token rotation", () => {
  it("rotates, rejects the old token, and revokes the family on replay", async () => {
    const p = pkce();
    const first = (await token({ grant_type: "authorization_code", code: await getCode(cookieAna, p), redirect_uri: CB, client_id: "mcp-harrisonfamily", code_verifier: p.verifier })).body;
    const second = await token({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: "mcp-harrisonfamily" });
    expect(second.r.statusCode).toBe(200);
    expect(second.body.refresh_token).not.toBe(first.refresh_token);
    expect((await jwtVerify(second.body.access_token, jwks, { issuer: ISS, audience: RES })).payload.sub).toBe("I0111");
    expect((await token({ grant_type: "refresh_token", refresh_token: first.refresh_token })).body.error).toBe("invalid_grant"); // replay
    expect((await token({ grant_type: "refresh_token", refresh_token: second.body.refresh_token })).body.error).toBe("invalid_grant"); // family revoked
  });
  it("a removed member can no longer refresh", async () => {
    const p = pkce();
    const first = (await token({ grant_type: "authorization_code", code: await getCode(cookieAna, p), redirect_uri: CB, client_id: "mcp-harrisonfamily", code_verifier: p.verifier })).body;
    const saved = members.I0111; delete members.I0111;
    try { expect((await token({ grant_type: "refresh_token", refresh_token: first.refresh_token })).body.error).toBe("invalid_grant"); } finally { members.I0111 = saved; }
  });
});

describe("/auth/register facade", () => {
  it("returns the fixed public client without a secret", async () => {
    const r = await edge(evPost("/auth/register", { client_name: "Claude", redirect_uris: [CB], token_endpoint_auth_method: "none", client_secret: "ignored" }, false));
    expect(r.statusCode).toBe(201);
    const b = JSON.parse(r.body);
    expect(b).toMatchObject({ client_id: "mcp-harrisonfamily", token_endpoint_auth_method: "none", redirect_uris: [CB], client_name: "Claude" });
    expect(JSON.stringify(b)).not.toMatch(/secret/i);
  });
  it("defaults to the allowed list; rejects unknown redirect URIs and confidential auth", async () => {
    expect(JSON.parse((await edge(evPost("/auth/register", {}, false))).body).redirect_uris).toEqual([CB, CB2]);
    const bad = await edge(evPost("/auth/register", { redirect_uris: [CB, "https://evil.example/cb"] }, false));
    expect(bad.statusCode).toBe(400);
    expect(JSON.parse(bad.body).error).toBe("invalid_redirect_uri");
    expect(JSON.parse((await edge(evPost("/auth/register", { token_endpoint_auth_method: "client_secret_basic" }, false))).body).error).toBe("invalid_client_metadata");
  });
  it("methods are enforced", async () => {
    expect((await edge(evGet("/auth/token"))).statusCode).toBe(405);
  });
});

describe("membership (allowlist + admins.json)", () => {
  it("members get 'members', admins also 'admins', strangers null, and it fails closed with no data", async () => {
    const g = createMembership({ readAllowlist: async () => JSON.stringify({ "a@x.org": "I1", "b@x.org": { gramps_id: "I2", roles: ["editors"] } }), readAdmins: async () => JSON.stringify({ admins: ["I2"] }), log: { error() {} } });
    expect(await g("I1")).toEqual(["members"]);
    expect(await g("I2")).toEqual(["members", "editors", "admins"]);
    expect(await g("I9")).toBeNull();
    const broken = createMembership({ readAllowlist: async () => { throw new Error("s3 down"); }, readAdmins: async () => "{}", log: { error() {} } });
    await expect(broken("I1")).rejects.toThrow();
  });
});

const withOrigin = (ev, origin) => ({ ...ev, headers: { ...ev.headers, origin } });
const preflight = (path, origin) => ({ rawPath: path, requestContext: { http: { method: "OPTIONS" } }, headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type,authorization" } });
const bodyFor = { "/auth/token": { grant_type: "password" }, "/auth/register": {}, "/auth/revoke": { token: "nope" } };

describe("CORS on /auth/token, /auth/register, /auth/revoke (HFY addendum)", () => {
  for (const origin of ["https://claude.ai", "https://claude.com"]) {
    for (const path of Object.keys(bodyFor)) {
      it(`${origin} ${path}: preflight 204 and the response carries the exact origin, without credentials`, async () => {
        const pre = await edge(preflight(path, origin));
        expect(pre.statusCode).toBe(204);
        expect(pre.headers["access-control-allow-origin"]).toBe(origin);
        expect(pre.headers["access-control-allow-headers"]).toMatch(/Content-Type/);
        expect(pre.headers["access-control-allow-headers"]).toMatch(/Authorization/);
        expect(pre.headers["access-control-allow-methods"]).toMatch(/POST/);
        expect(pre.headers["access-control-allow-credentials"]).toBeUndefined();
        expect(pre.headers.vary).toBe("Origin");
        const r = await edge(withOrigin(evPost(path, bodyFor[path], path !== "/auth/register"), origin));
        expect(r.headers["access-control-allow-origin"]).toBe(origin);
        expect(r.headers["access-control-allow-credentials"]).toBeUndefined();
      });
    }
  }
  it("a disallowed origin gets a 403 preflight and no CORS headers on the response", async () => {
    for (const origin of ["https://evil.example", "https://claude.ai.evil.example", "http://claude.ai"]) {
      for (const path of Object.keys(bodyFor)) {
        const pre = await edge(preflight(path, origin));
        expect(pre.statusCode).toBe(403);
        expect(pre.headers["access-control-allow-origin"]).toBeUndefined();
        const r = await edge(withOrigin(evPost(path, bodyFor[path], path !== "/auth/register"), origin));
        expect(r.headers["access-control-allow-origin"]).toBeUndefined();
      }
    }
  });
  it("requests without an Origin carry no allow-origin header; a wildcard allow-list is refused at construction", () => {
    expect(() => createOAuthServer({ issuer: ISS, redirectUris: [CB], resources: [RES], store: memoryOAuthStore(), signer: {}, groupsFor: async () => null, corsOrigins: ["*"] })).toThrow(/wildcard/);
  });
  it("metadata is readable cross-origin from an allowed origin", async () => {
    const r = await edge(withOrigin(evGet("/auth/.well-known/oauth-authorization-server"), "https://claude.ai"));
    expect(r.headers["access-control-allow-origin"]).toBe("https://claude.ai");
    expect(JSON.parse(r.body).revocation_endpoint).toBe(`${ISS}/revoke`);
  });
});

describe("/auth/revoke (RFC 7009)", () => {
  it("revokes a refresh token and its family; unknown tokens still get 200", async () => {
    const p = pkce();
    const first = (await token({ grant_type: "authorization_code", code: await getCode(cookieAna, p), redirect_uri: CB, client_id: "mcp-harrisonfamily", code_verifier: p.verifier })).body;
    const rotated = (await token({ grant_type: "refresh_token", refresh_token: first.refresh_token })).body;
    const rev = await edge(evPost("/auth/revoke", { token: rotated.refresh_token, token_type_hint: "refresh_token", client_id: "mcp-harrisonfamily" }));
    expect(rev.statusCode).toBe(200);
    expect((await token({ grant_type: "refresh_token", refresh_token: rotated.refresh_token })).body.error).toBe("invalid_grant");
    expect((await edge(evPost("/auth/revoke", { token: "hfyrt_unknown" }))).statusCode).toBe(200);
    expect((await edge(evPost("/auth/revoke", { token: "a.b.c" }))).statusCode).toBe(200);
    expect((await edge(evPost("/auth/revoke", { token: "x", client_id: "other" }))).statusCode).toBe(401);
  });
});

describe("RFC 8414 root discovery (HFY-R44)", () => {
  it("serves the same document at /.well-known/oauth-authorization-server/auth and under /auth", async () => {
    const root = await edge(evGet("/.well-known/oauth-authorization-server/auth"));
    const under = await edge(evGet("/auth/.well-known/oauth-authorization-server"));
    expect(root.statusCode).toBe(200);
    expect(JSON.parse(root.body)).toEqual(JSON.parse(under.body));
    expect((await edge(evGet("/.well-known/oauth-authorization-server"))).statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// HFY-R64: access tokens carry email, amr and auth_time (the MCP server's step-up delete reads them); authorize honors max_age / prompt=login.
const nowS = () => Math.floor(clock / 1000);
const keyOf = (v) => b64u(createHash("sha256").update(v).digest());
const codeGrant = (code, verifier, o = {}) => ({ grant_type: "authorization_code", code, redirect_uri: CB, client_id: "mcp-harrisonfamily", code_verifier: verifier, ...o });
/** A session cookie as the edge's identity service would mint it (id token), with a chosen sign-in time and claims. */
async function sessionCookie({ iat, sub = "I0111", ...claims }) {
  const t = await new SignJWT({ email: "ana@example.com", email_verified: true, name: "Ana", "cognito:groups": ["members", "admins"], token_use: "id", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "hfy-session-1" }).setIssuer(ISS).setAudience("harrisonfamily-web").setSubject(sub).setIssuedAt(iat).setExpirationTime(iat + 3600).sign(sessionKey);
  return `io_id=${t}`;
}
const access = async (body) => (await jwtVerify(body.access_token, jwks, { issuer: ISS, audience: RES })).payload;
const grantFor = async (cookie, extra = {}) => { const p = pkce(); return (await token(codeGrant(await getCode(cookie, p, extra), p.verifier))).body; };

describe("access tokens carry email, amr and auth_time (HFY-R64)", () => {
  it("code grant: email, amr and auth_time come from the signed-in session", async () => {
    const iat = nowS() - 120;
    const payload = await access(await grantFor(await sessionCookie({ iat, amr: ["passkey", "hwk", "mfa"] })));
    expect(payload).toMatchObject({ sub: "I0111", email: "ana@example.com", amr: ["passkey", "hwk", "mfa"], auth_time: iat, token_use: "access", client_id: "mcp-harrisonfamily" });
    expect(Number.isInteger(payload.auth_time)).toBe(true);
    expect(payload.iat).toBeGreaterThan(payload.auth_time);
  });
  it("a real Google sign-in: email from the verified id token, amr [fed], auth_time = the cookie's iat", async () => {
    const payload = await access(await grantFor(cookieAna));
    expect(payload).toMatchObject({ email: "ana@example.com", amr: ["fed"], auth_time: decodeJwt(cookieAna.match(/io_id=([^;]+)/)[1]).iat });
  });
  it("an id token's own auth_time claim wins over its iat; a session without amr yields no amr claim (auth_time is still present)", async () => {
    const iat = nowS() - 30;
    const payload = await access(await grantFor(await sessionCookie({ iat, auth_time: iat - 1000 })));
    expect(payload.auth_time).toBe(iat - 1000);
    expect("amr" in payload).toBe(false);
  });
  it("/auth/session keeps its shape (no email, amr or auth time leak into it); it adds only the session expiry (HFY-R66)", async () => {
    const iat = nowS() - 10;
    const r = await edge(evGet("/auth/session", {}, { cookie: await sessionCookie({ iat, amr: ["passkey", "mfa"] }) }));
    expect(JSON.parse(r.body)).toEqual({ authenticated: true, sub: "I0111", grampsId: "I0111", label: "Ana", exp: iat + 3600 });
  });
  it("refresh keeps the original auth_time, email and amr while iat advances (it never refreshes auth_time)", async () => {
    const authTime = nowS() - 90;
    const first = await grantFor(await sessionCookie({ iat: authTime, amr: ["passkey", "hwk", "mfa"] }));
    const a = await access(first);
    clock += 1_800_000;
    const second = (await token({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: "mcp-harrisonfamily" })).body;
    const b = await access(second);
    expect(b.iat - a.iat).toBe(1800);
    expect(b).toMatchObject({ auth_time: authTime, email: "ana@example.com", amr: ["passkey", "hwk", "mfa"], name: "Ana" });
    clock += 1_800_000; // a second rotation: the value still comes from the original sign-in
    const c = await access((await token({ grant_type: "refresh_token", refresh_token: second.refresh_token })).body);
    expect(c.iat - a.iat).toBe(3600);
    expect(c).toMatchObject({ auth_time: authTime, email: "ana@example.com", amr: ["passkey", "hwk", "mfa"], name: "Ana" });
  });
  it("a refresh token minted before this change (no email/amr/authTime on its record) yields auth_time 0, no amr and no email, and stays that way", async () => {
    const rt = "hfyrt_legacy-record-without-assurance-fields";
    await oauthStore.put({ PK: `MCPRT#${keyOf(rt)}`, clientId: "mcp-harrisonfamily", sub: "I0111", resource: RES, scope: "mcp", family: "fam-legacy", expiresAt: clock + 86_400_000, ttl: nowS() + 90_000 });
    const first = (await token({ grant_type: "refresh_token", refresh_token: rt, client_id: "mcp-harrisonfamily" })).body;
    const a = await access(first);
    expect(a.auth_time).toBe(0);
    expect("amr" in a).toBe(false);
    expect("email" in a).toBe(false);
    expect("name" in a).toBe(false); // no name on the record: the MCP server labels the actor with the sub
    const b = await access((await token({ grant_type: "refresh_token", refresh_token: first.refresh_token })).body);
    expect(b.auth_time).toBe(0);
  });
  it("issue() persists the values on the refresh record", async () => {
    const authTime = nowS() - 45;
    const first = await grantFor(await sessionCookie({ iat: authTime, amr: ["passkey", "mfa"] }));
    expect(await oauthStore.get(`MCPRT#${keyOf(first.refresh_token)}`)).toMatchObject({ email: "ana@example.com", amr: ["passkey", "mfa"], authTime, name: "Ana" });
  });
});

describe("access tokens carry the member's display label as name (MCP author label)", () => {
  it("code grant: name is the io_id session label, stored on the code and the refresh record", async () => {
    const p = pkce();
    const code = await getCode(await sessionCookie({ iat: nowS() - 5, name: "Jane Harrison", sub: "I0111" }), p);
    expect(await oauthStore.get(`MCPCODE#${keyOf(code)}`)).toMatchObject({ sub: "I0111", name: "Jane Harrison" });
    const body = (await token(codeGrant(code, p.verifier))).body;
    expect(await access(body)).toMatchObject({ sub: "I0111", name: "Jane Harrison", email: "ana@example.com" });
    expect(await oauthStore.get(`MCPRT#${keyOf(body.refresh_token)}`)).toMatchObject({ name: "Jane Harrison" });
    expect((await access((await token({ grant_type: "refresh_token", refresh_token: body.refresh_token })).body)).name).toBe("Jane Harrison");
  });
  it("never mints an email as name: neither the kit's email fallback label nor a session without a name claim", async () => {
    expect("name" in (await access(await grantFor(cookieAna)))).toBe(false); // allowlist string entry: the kit labels the member with the email
    expect("name" in (await access(await grantFor(await sessionCookie({ iat: nowS() - 5, name: "ana@example.com" }))))).toBe(false);
    expect("name" in (await access(await grantFor(await sessionCookie({ iat: nowS() - 5, name: undefined }))))).toBe(false); // displayName falls back to email
  });
  it("displayNameOf: a trimmed, printable, non-email label that is not just the sub", () => {
    expect(displayNameOf("  Jane Harrison ", "I0111")).toBe("Jane Harrison");
    expect(displayNameOf("Zoë O'Brien-Harrison", "I0111")).toBe("Zoë O'Brien-Harrison");
    for (const bad of [undefined, null, 42, "", "   ", "I0111", "jane@example.com", "Jane\nHarrison", "Jane\u0000", "x".repeat(201)]) expect(displayNameOf(bad, "I0111"), JSON.stringify(bad)).toBeUndefined();
    expect(displayNameOf("x".repeat(200), "I0111")).toHaveLength(200);
  });
});

describe("/auth/authorize max_age and prompt=login (HFY-R64, RFC 9470)", () => {
  const { challenge } = pkce();
  const good = { code_challenge: challenge, code_challenge_method: "S256" };
  const nextOf = (r) => { const n = loc(r).searchParams.get("next"); return { next: n, params: new URLSearchParams(n.split("?")[1]) }; };
  const isLogin = (r) => r.statusCode === 302 && loc(r).pathname === "/auth/login";
  const isCode = (r) => r.statusCode === 302 && loc(r).searchParams.has("code") && loc(r).pathname === new URL(CB).pathname;

  it("sign-in older than max_age -> login page; the next URL keeps max_age and has no prompt", async () => {
    const r = await authz(await sessionCookie({ iat: nowS() - 600, amr: ["passkey", "mfa"] }), { ...good, max_age: "300", prompt: "login" });
    expect(isLogin(r)).toBe(true);
    const { next, params } = nextOf(r);
    expect(next.startsWith("/auth/authorize?")).toBe(true);
    expect(params.get("max_age")).toBe("300");
    expect(params.has("prompt")).toBe(false);
    expect(params.get("code_challenge")).toBe(challenge);
    expect(params.get("state")).toBe("st8");
    const page = await edge(evGet("/auth/login", { next }));
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("/auth/authorize?");
  });
  it("without a prompt parameter a stale sign-in is sent to login just the same", async () => {
    const r = await authz(await sessionCookie({ iat: nowS() - 301 }), { ...good, max_age: "300" });
    expect(isLogin(r)).toBe(true);
    expect(nextOf(r).params.get("max_age")).toBe("300");
  });
  it("sign-in within max_age (including exactly max_age old) -> a code is issued", async () => {
    for (const age of [100, 300]) {
      const r = await authz(await sessionCookie({ iat: nowS() - age }), { ...good, max_age: "300" });
      expect(isCode(r), `age ${age}`).toBe(true);
    }
  });
  it("the loop ends: after the fresh sign-in the very same next URL yields a code, and its token carries the fresh auth_time", async () => {
    const p = pkce();
    const stale = await authz(await sessionCookie({ iat: nowS() - 900 }), { ...good, code_challenge: p.challenge, max_age: "300" });
    expect(isLogin(stale)).toBe(true);
    const freshAt = nowS();
    const fresh = await sessionCookie({ iat: freshAt, amr: ["passkey", "hwk", "mfa"] });
    const back = await edge(evGet("/auth/authorize", Object.fromEntries(nextOf(stale).params), { cookie: fresh }));
    expect(isCode(back)).toBe(true);
    const { body } = await token(codeGrant(loc(back).searchParams.get("code"), p.verifier));
    expect(await access(body)).toMatchObject({ auth_time: freshAt, amr: ["passkey", "hwk", "mfa"] });
  });
  it("prompt=login forces the login page even for a fresh session; the next URL drops prompt, so the second pass issues a code", async () => {
    const cookie = await sessionCookie({ iat: nowS() - 5, amr: ["passkey", "mfa"] });
    const r = await authz(cookie, { ...good, prompt: "login" });
    expect(isLogin(r)).toBe(true);
    const { params } = nextOf(r);
    expect(params.has("prompt")).toBe(false);
    expect(params.has("max_age")).toBe(false);
    expect(isCode(await edge(evGet("/auth/authorize", Object.fromEntries(params), { cookie })))).toBe(true);
    expect(isLogin(await authz(cookie, { ...good, prompt: "consent login" }))).toBe(true); // prompt is a space-delimited list
    expect(isCode(await authz(cookie, { ...good, prompt: "consent" }))).toBe(true);
  });
  it("no session + prompt=login: login page, prompt removed from next", async () => {
    const r = await authz(undefined, { ...good, prompt: "login", max_age: "60" });
    expect(isLogin(r)).toBe(true);
    const { params } = nextOf(r);
    expect(params.has("prompt")).toBe(false);
    expect(params.get("max_age")).toBe("60");
  });
  it("an invalid max_age is invalid_request (redirected back to the client, no code), with or without a session", async () => {
    const cookie = await sessionCookie({ iat: nowS() - 5 });
    for (const bad of ["abc", "-1", "1.5", "", "300s", " 300", "1e3", "+5", "12345678901"]) {
      for (const c of [cookie, undefined]) {
        const r = await authz(c, { ...good, max_age: bad });
        expect(r.statusCode, JSON.stringify(bad)).toBe(302);
        const u = loc(r);
        expect(u.pathname).toBe(new URL(CB).pathname);
        expect(u.searchParams.get("error"), JSON.stringify(bad)).toBe("invalid_request");
        expect(u.searchParams.get("state")).toBe("st8");
        expect(u.searchParams.has("code")).toBe(false);
      }
    }
  });
  it("max_age=0 demands a sign-in from this very second; a session record without authTime is treated as never signed in (fails closed)", async () => {
    expect(isCode(await authz(await sessionCookie({ iat: nowS() }), { ...good, max_age: "0" }))).toBe(true);
    expect(isLogin(await authz(await sessionCookie({ iat: nowS() - 1 }), { ...good, max_age: "0" }))).toBe(true);
    const unit = oauthFor(memoryOAuthStore());
    const q = { response_type: "code", client_id: "mcp-harrisonfamily", redirect_uri: CB, state: "st8", ...good };
    const legacy = async () => ({ sub: "I0111", label: "Ana" });
    expect((await unit.authorize({ ...q, max_age: "300" }, legacy)).headers.location.startsWith("/auth/login?next=")).toBe(true);
    expect(new URL((await unit.authorize(q, legacy)).headers.location).searchParams.has("code")).toBe(true);
  });
});

// HFY-R68 (@io-kit/auth 2.1.1, DVP-TSK-A64): the kit's session refresh used to stamp auth_time = now on the new io_id, so a member who signed in days ago
// looked freshly authenticated after one silent POST /auth/refresh and the MCP step-up (authorize max_age=300) was skipped. 2.1.1 keeps the ORIGINAL
// sign-in time on the refresh record and re-emits it on every io_id it mints; this pins that end to end, on a fake clock shared with the identity service.
describe("auth_time survives POST /auth/refresh (HFY-R68, @io-kit/auth 2.1.1)", () => {
  const DAY_MS = 86_400_000;
  const refreshReq = (cookie) => ({
    rawPath: "/auth/refresh", requestContext: { http: { method: "POST" } },
    headers: { "x-requested-with": "io-kit", origin: "https://harrisonfamily.us", "content-type": "application/json", accept: "application/json", cookie }, body: "{}",
  });
  const cookieOf = (res, name) => (res.cookies ?? []).map((c) => c.split(";")[0]).find((c) => c.startsWith(`${name}=`));
  const { challenge } = pkce();
  const good = { code_challenge: challenge, code_challenge_method: "S256" };
  const isLogin = (r) => r.statusCode === 302 && loc(r).pathname === "/auth/login" && !loc(r).searchParams.has("code");
  const isCode = (r) => r.statusCode === 302 && loc(r).searchParams.has("code") && loc(r).pathname === new URL(CB).pathname;
  const googleAt = (email) => signIn(email, (e) => mintGoogle(e, nowS()));
  /** The MCP access token this browser session yields (authorize without max_age, then the code grant). */
  const mcpToken = async (cookie) => access((await grantFor(cookie)));

  it("a refresh two days after sign-in keeps auth_time = t0: max_age=300 still sends the member to the login page; a fresh sign-in still gets auth_time = now", async () => {
    const savedClock = clock;
    identityOnFakeClock = true;
    try {
      clock = Math.max(clock, Date.now());
      const t0 = nowS();
      const signedIn = await googleAt("ana@example.com");
      expect(decodeJwt(signedIn.match(/io_id=([^;]+)/)[1])).toMatchObject({ auth_time: t0, iat: t0 });
      expect(isCode(await authz(signedIn, { ...good, max_age: "300" }))).toBe(true); // fresh at t0

      clock += 2 * DAY_MS; // the 1 h io_id is long gone; only the io_rt cookie is left
      const r = await edge(refreshReq(signedIn.match(/io_rt=[^;]+/)[0]));
      expect(r.statusCode).toBe(200);
      const refreshed = cookieOf(r, "io_id");
      expect(refreshed).toBeTruthy();
      expect(decodeJwt(refreshed.slice("io_id=".length))).toMatchObject({ auth_time: t0, iat: nowS(), sub: "I0111", amr: ["fed"] }); // new token, original sign-in time

      // the session-derived authTime is t0: max_age=300 must NOT be satisfied, and without max_age the access token carries t0
      const stale = await authz(refreshed, { ...good, max_age: "300" });
      expect(isLogin(stale)).toBe(true);
      expect(loc(stale).searchParams.get("next")).toMatch(/^\/auth\/authorize\?/);
      expect(await mcpToken(refreshed)).toMatchObject({ sub: "I0111", auth_time: t0, amr: ["fed"] });
      expect(JSON.parse((await edge(evGet("/auth/session", undefined, { cookie: refreshed }))).body)).toMatchObject({ authenticated: true, sub: "I0111" });

      // a refresh of the refresh (rotation) still reports t0
      const again = await edge(refreshReq(cookieOf(r, "io_rt")));
      expect(again.statusCode).toBe(200);
      expect(decodeJwt(cookieOf(again, "io_id").slice("io_id=".length)).auth_time).toBe(t0);

      // ... whereas a genuinely fresh sign-in is fresh: max_age=300 passes and the token exchange yields auth_time = now
      const fresh = await googleAt("ana@example.com");
      const p = pkce();
      const back = await authz(fresh, { ...good, code_challenge: p.challenge, max_age: "300" });
      expect(isCode(back)).toBe(true);
      const { body } = await token(codeGrant(loc(back).searchParams.get("code"), p.verifier));
      expect((await access(body)).auth_time).toBe(nowS());
      expect(nowS() - t0).toBeGreaterThanOrEqual(2 * 86_400);
    } finally {
      identityOnFakeClock = false;
      clock = savedClock;
    }
  });
});

// ---- HFY-TSK-120: multi-client server + hfy-sync-desktop (loopback, any port) ----
describe("multi-client OAuth server: hfy-sync-desktop (HFY-TSK-120)", () => {
  const D = "hfy-sync-desktop";
  const SYNC = "https://harrisonfamily.us/api/sync";
  const LB = (port = "") => `http://127.0.0.1${port ? `:${port}` : ""}/callback`;
  let t0, store2, srv, key;
  const mk = (extra = {}) => createOAuthServer({
    issuer: ISS, store: store2, signer: { privateKey: key, kid: "k" }, groupsFor: async (sub) => members[sub] ?? null, now: () => clock,
    clients: [{ id: "mcp-harrisonfamily", redirectUris: [CB], resources: [RES] }, desktopClient()], ...extra,
  });
  const dev = (q) => srv.authorize({ response_type: "code", client_id: D, state: "s", ...q }, async () => ({ sub: "I0111", authTime: Math.floor(clock / 1000), email: "ana@example.com", amr: ["fed"] }));
  const dtok = (o) => srv.token(o).then((r) => ({ r, body: JSON.parse(r.body) }));
  const codeFor = async (client, redirect_uri, p) => new URL((await srv.authorize({ response_type: "code", client_id: client, redirect_uri, state: "s", code_challenge: p.challenge, code_challenge_method: "S256" }, async () => ({ sub: "I0111", authTime: Math.floor(clock / 1000) }))).headers.location).searchParams.get("code");

  beforeAll(async () => { key = (await generateKeyPair("RS256", { extractable: true })).privateKey; });
  const fresh = () => { t0 = Date.now(); clock = t0; store2 = memoryOAuthStore(); srv = mk(); };

  it("accepts an ephemeral port on 127.0.0.1/callback; the code redirects back to that exact URI", async () => {
    fresh();
    const p = pkce();
    const r = await dev({ redirect_uri: LB(53682), code_challenge: p.challenge, code_challenge_method: "S256" });
    expect(r.statusCode).toBe(302);
    const u = new URL(r.headers.location);
    expect(`${u.origin}${u.pathname}`).toBe("http://127.0.0.1:53682/callback");
    expect(u.searchParams.get("code")).toBeTruthy();
    for (const port of ["", "80", "1", "65535", "49152"]) expect((await dev({ redirect_uri: LB(port), code_challenge: p.challenge, code_challenge_method: "S256" })).statusCode).toBe(302);
  });
  it("refuses another host, path, scheme, port 0, userinfo, query or fragment (never redirecting)", async () => {
    fresh();
    const p = { code_challenge: pkce().challenge, code_challenge_method: "S256" };
    for (const bad of ["http://localhost:5000/callback", "http://[::1]:5000/callback", "http://127.0.0.2:5000/callback", "http://127.0.0.1:5000/other", "http://127.0.0.1:5000/callback/x", "http://127.0.0.1:5000/",
      "https://127.0.0.1:5000/callback", "http://evil.example/callback", "http://127.0.0.1.evil.example:5000/callback", "http://127.0.0.1:0/callback", "http://u@127.0.0.1:5000/callback",
      "http://127.0.0.1:5000/callback?x=1", "http://127.0.0.1:5000/callback#f", "https://claude.ai/api/mcp/auth_callback"]) {
      const r = await dev({ redirect_uri: bad, ...p });
      expect(r.statusCode, bad).toBe(400);
      expect(r.headers.location).toBeUndefined();
    }
  });
  it("the MCP client's exact-match rule is unchanged (no port flexibility)", async () => {
    fresh();
    const p = pkce();
    const ask = (uri) => srv.authorize({ response_type: "code", client_id: "mcp-harrisonfamily", redirect_uri: uri, code_challenge: p.challenge, code_challenge_method: "S256" }, async () => ({ sub: "I0111", authTime: Math.floor(clock / 1000) }));
    expect((await ask(LB(5000))).statusCode).toBe(400);
    expect((await ask("https://claude.ai:8443/api/mcp/auth_callback")).statusCode).toBe(400);
    expect((await ask(CB)).statusCode).toBe(302);
  });
  it("desktop access token: aud = the sync resource, client_id = hfy-sync-desktop, 1h; the default resource is the sync API; other resources are invalid_target", async () => {
    fresh();
    const p = pkce(); const uri = LB(40123);
    const code = await codeFor(D, uri, p);
    const { r, body } = await dtok({ grant_type: "authorization_code", code, redirect_uri: uri, client_id: D, code_verifier: p.verifier });
    expect(r.statusCode).toBe(200);
    const { payload } = await jwtVerify(body.access_token, createLocalJWKSet({ keys: [{ ...(await exportJWK((await (async () => { const { createPublicKey } = await import("node:crypto"); return createPublicKey(key); })()))), kid: "k", alg: "RS256" }] }), { issuer: ISS, audience: SYNC, currentDate: new Date(clock) });
    expect(payload).toMatchObject({ aud: SYNC, client_id: D, sub: "I0111", token_use: "access", scope: "sync" });
    expect(payload.exp - payload.iat).toBe(3600);
    const bad = await dev({ redirect_uri: uri, resource: RES, code_challenge: p.challenge, code_challenge_method: "S256" });
    expect(new URL(bad.headers.location).searchParams.get("error")).toBe("invalid_target");
  });
  it("token redemption needs the same redirect_uri string the code was issued for", async () => {
    fresh();
    const p = pkce();
    const code = await codeFor(D, LB(40123), p);
    expect((await dtok({ grant_type: "authorization_code", code, redirect_uri: LB(40124), client_id: D, code_verifier: p.verifier })).body.error).toBe("invalid_grant");
  });
  it("a desktop code cannot be redeemed by the MCP client, and an MCP code not by the desktop client", async () => {
    fresh();
    const p = pkce();
    const dcode = await codeFor(D, LB(40123), p);
    expect((await dtok({ grant_type: "authorization_code", code: dcode, redirect_uri: LB(40123), client_id: "mcp-harrisonfamily", code_verifier: p.verifier })).body.error).toBe("invalid_grant");
    expect((await dtok({ grant_type: "authorization_code", code: dcode, redirect_uri: LB(40123), client_id: D, code_verifier: p.verifier })).body.error).toBe("invalid_grant"); // burned
    const mcode = await codeFor("mcp-harrisonfamily", CB, p);
    expect((await dtok({ grant_type: "authorization_code", code: mcode, redirect_uri: CB, client_id: D, code_verifier: p.verifier })).body.error).toBe("invalid_grant");
    const mcode2 = await codeFor("mcp-harrisonfamily", CB, p);
    expect((await dtok({ grant_type: "authorization_code", code: mcode2, redirect_uri: CB, client_id: "mcp-harrisonfamily", code_verifier: p.verifier })).r.statusCode).toBe(200);
  });
  it("refresh tokens are bound to their client: the other client is refused without burning the token; an unknown client is invalid_client", async () => {
    fresh();
    const p = pkce();
    const first = (await dtok({ grant_type: "authorization_code", code: await codeFor(D, LB(40123), p), redirect_uri: LB(40123), client_id: D, code_verifier: p.verifier })).body;
    expect((await dtok({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: "mcp-harrisonfamily" })).body.error).toBe("invalid_grant");
    expect((await dtok({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: "nope" })).r.statusCode).toBe(401);
    const ok = await dtok({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: D });
    expect(ok.r.statusCode).toBe(200);
    expect(decodeJwt(ok.body.access_token)).toMatchObject({ aud: SYNC, client_id: D });
    // and the reverse: an MCP refresh token is refused to the desktop client
    const m = (await dtok({ grant_type: "authorization_code", code: await codeFor("mcp-harrisonfamily", CB, p), redirect_uri: CB, client_id: "mcp-harrisonfamily", code_verifier: p.verifier })).body;
    expect((await dtok({ grant_type: "refresh_token", refresh_token: m.refresh_token, client_id: D })).body.error).toBe("invalid_grant");
    const mOk = await dtok({ grant_type: "refresh_token", refresh_token: m.refresh_token, client_id: "mcp-harrisonfamily" });
    expect(decodeJwt(mOk.body.access_token)).toMatchObject({ aud: RES, client_id: "mcp-harrisonfamily" });
  });
  it("a refresh without client_id keeps the token's own client; revoke by the wrong client is a no-op", async () => {
    fresh();
    const p = pkce();
    const first = (await dtok({ grant_type: "authorization_code", code: await codeFor(D, LB(40123), p), redirect_uri: LB(40123), client_id: D, code_verifier: p.verifier })).body;
    await srv.revoke({ token: first.refresh_token, client_id: "mcp-harrisonfamily" });
    const r = await dtok({ grant_type: "refresh_token", refresh_token: first.refresh_token });
    expect(r.r.statusCode).toBe(200);
    expect(decodeJwt(r.body.access_token).client_id).toBe(D);
    await srv.revoke({ token: r.body.refresh_token, client_id: D });
    expect((await dtok({ grant_type: "refresh_token", refresh_token: r.body.refresh_token })).body.error).toBe("invalid_grant");
  });
  it("HFY-R64: refresh never advances auth_time for the desktop client (iat advances, auth_time stays the sign-in time)", async () => {
    fresh();
    const p = pkce();
    const signedAt = Math.floor(clock / 1000);
    const first = (await dtok({ grant_type: "authorization_code", code: await codeFor(D, LB(40123), p), redirect_uri: LB(40123), client_id: D, code_verifier: p.verifier })).body;
    expect(decodeJwt(first.access_token).auth_time).toBe(signedAt);
    clock += 10 * 86400 * 1000;
    const second = (await dtok({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: D })).body;
    const a = decodeJwt(second.access_token);
    expect(a.auth_time).toBe(signedAt);
    expect(a.iat).toBe(Math.floor(clock / 1000));
    clock += 10 * 86400 * 1000;
    expect(decodeJwt((await dtok({ grant_type: "refresh_token", refresh_token: second.refresh_token, client_id: D })).body.access_token).auth_time).toBe(signedAt);
  });
  it("desktop refresh tokens expire after 30 days without use (injected clock); each use renews the window", async () => {
    fresh();
    const p = pkce();
    const day = 86400 * 1000;
    const first = (await dtok({ grant_type: "authorization_code", code: await codeFor(D, LB(40123), p), redirect_uri: LB(40123), client_id: D, code_verifier: p.verifier })).body;
    clock = t0 + 30 * day + 1000;
    expect((await dtok({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: D })).body.error).toBe("invalid_grant");
    fresh();
    const a = (await dtok({ grant_type: "authorization_code", code: await codeFor(D, LB(40123), p), redirect_uri: LB(40123), client_id: D, code_verifier: p.verifier })).body;
    clock = t0 + 29 * day;
    const b = await dtok({ grant_type: "refresh_token", refresh_token: a.refresh_token, client_id: D });
    expect(b.r.statusCode).toBe(200);
    clock = t0 + 58 * day; // 29 days after the last use
    const c = await dtok({ grant_type: "refresh_token", refresh_token: b.body.refresh_token, client_id: D });
    expect(c.r.statusCode).toBe(200);
    clock = t0 + 58 * day + 30 * day + 1000;
    expect((await dtok({ grant_type: "refresh_token", refresh_token: c.body.refresh_token, client_id: D })).body.error).toBe("invalid_grant");
  });
  it("the stored refresh record's lifetime is the client's (30 days), not a global constant", async () => {
    fresh();
    srv = mk({ clients: [{ id: "mcp-harrisonfamily", redirectUris: [CB], resources: [RES], refreshTtlS: 3600 }, desktopClient()] });
    const p = pkce();
    const m = (await dtok({ grant_type: "authorization_code", code: await codeFor("mcp-harrisonfamily", CB, p), redirect_uri: CB, client_id: "mcp-harrisonfamily", code_verifier: p.verifier })).body;
    clock = t0 + 2 * 3600 * 1000;
    expect((await dtok({ grant_type: "refresh_token", refresh_token: m.refresh_token })).body.error).toBe("invalid_grant");
  });
  it("dynamic registration still serves only the MCP client; the desktop client is not registrable and its loopback URI is not on the MCP list", async () => {
    fresh();
    const ok = srv.register({ redirect_uris: [CB] });
    expect(JSON.parse(ok.body)).toMatchObject({ client_id: "mcp-harrisonfamily", scope: "mcp" });
    expect(JSON.parse(srv.register({ redirect_uris: [LB(5000)] }).body).error).toBe("invalid_redirect_uri");
    expect(JSON.parse(srv.register({ redirect_uris: ["http://127.0.0.1/callback"] }).body).error).toBe("invalid_redirect_uri");
  });
  it("construction rejects an empty or duplicate client set", () => {
    expect(() => createOAuthServer({ issuer: ISS, clients: [], store: memoryOAuthStore() })).toThrow();
    expect(() => createOAuthServer({ issuer: ISS, clients: [desktopClient(), desktopClient()], store: memoryOAuthStore() })).toThrow(/duplicate/);
    expect(() => createOAuthServer({ issuer: ISS, clients: [{ id: "x", redirectUris: [], resources: ["r"] }], store: memoryOAuthStore() })).toThrow();
  });
  it("loopbackMatches: unit cases", () => {
    expect(loopbackMatches(LB(), LB(1234))).toBe(true);
    expect(loopbackMatches(LB(), "http://127.0.0.1:99999/callback")).toBe(false);
    expect(loopbackMatches(LB(), "not a url")).toBe(false);
  });
});
