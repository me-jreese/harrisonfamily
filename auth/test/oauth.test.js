import { describe, it, expect, beforeAll } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet, jwtVerify } from "jose";
import { buildResolver } from "@io-kit/auth/edge/deploy";
import { createIdentityService, memoryLinkStore, memoryRefreshStore } from "@io-kit/auth/server";
import { createAuthEdge, loadManifest } from "../src/edge.js";
import { createOAuthServer, memoryOAuthStore } from "../src/oauth.js";
import { createMembership } from "../src/membership.js";

const raw = JSON.parse(readFileSync(new URL("../edge.manifest.json", import.meta.url), "utf8"));
const ENV = { COGNITO_USER_POOL_ID: "us-west-2_TEST", COGNITO_CLIENT_ID: "client123", GOOGLE_CLIENT_ID: "gis-client.apps.googleusercontent.com" };
const CB = "https://claude.ai/api/mcp/auth_callback";
const CB2 = "https://claude.com/api/mcp/auth_callback";
const RES = "https://mcp.harrisonfamily.us";
const ISS = "https://harrisonfamily.us/auth";
const b64u = (b) => Buffer.from(b).toString("base64url");
const pkce = () => { const verifier = b64u(randomBytes(32)); return { verifier, challenge: b64u(createHash("sha256").update(verifier).digest()) }; };
const members = { I0111: ["members", "admins"] }; // I0222 (Bo) is deliberately not a member for the access_denied case
let clock = Date.now();
let edge, cookieAna, cookieBo, jwks;

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
  const gToken = (email) => new SignJWT({ email, email_verified: true }).setProtectedHeader({ alg: "RS256", kid: "g1" }).setSubject("gs").setIssuer("https://accounts.google.com").setAudience(ENV.GOOGLE_CLIENT_ID).setIssuedAt().setExpirationTime("10m").sign(g.privateKey);
  const pub = { ...(await exportJWK(s.publicKey)), kid: "hfy-session-1", alg: "RS256", use: "sig" };
  const allow = JSON.stringify({ "ana@example.com": "I0111", "bo@example.com": "I0222" });
  const identity = createIdentityService({
    resolver: buildResolver(manifest.resolver, { readObject: async () => allow }),
    links: memoryLinkStore(),
    google: { clientId: ENV.GOOGLE_CLIENT_ID, jwks: createLocalJWKSet({ keys: [{ ...(await exportJWK(g.publicKey)), kid: "g1", alg: "RS256", use: "sig" }] }) },
    sessions: { issuer: manifest.session.issuer, audience: manifest.session.audience, kid: "hfy-session-1", privateKey: s.privateKey, store: memoryRefreshStore(), defaultProfile: "installed" },
  });
  const oauth = createOAuthServer({
    issuer: ISS, redirectUris: [CB, CB2], resources: [RES, "https://mcp2.harrisonfamily.us"], store: memoryOAuthStore(),
    signer: { privateKey: s.privateKey, kid: "hfy-session-1" }, groupsFor: async (sub) => members[sub] ?? null, now: () => clock,
  });
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
