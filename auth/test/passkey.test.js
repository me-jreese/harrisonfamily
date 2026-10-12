import { describe, it, expect, beforeAll } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet, jwtVerify } from "jose";
import { buildResolver } from "@io-kit/auth/edge/deploy";
import { loadPasskeyBrowserBundle } from "@io-kit/auth/edge/deploy";
import { createIdentityService, createPasskeyService, memoryChallengeStore, memoryLinkStore, memoryPasskeyStore, memoryRefreshStore } from "@io-kit/auth/server";
import { createSoftwareAuthenticator } from "@io-kit/auth/testing";
import { createAuthEdge, loadManifest } from "../src/edge.js";
import { createOAuthServer, memoryOAuthStore } from "../src/oauth.js";

const raw = JSON.parse(readFileSync(new URL("../edge.manifest.json", import.meta.url), "utf8"));
const ENV = { COGNITO_USER_POOL_ID: "us-west-2_TEST", COGNITO_CLIENT_ID: "client123", GOOGLE_CLIENT_ID: "gis-client.apps.googleusercontent.com" };
const ORIGIN = "https://harrisonfamily.us";
let allow, edge, gToken, jwks, authenticator;

const call = (method, rawPath, body, cookie) => edge({
  rawPath, requestContext: { http: { method } },
  headers: { "x-requested-with": "io-kit", origin: ORIGIN, "content-type": "application/json", accept: "application/json", ...(cookie ? { cookie } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const jar = (res) => res.cookies.map((c) => c.split(";")[0]).join("; ");
const MCP_CB = "https://claude.ai/api/mcp/auth_callback";
const MCP_RES = "https://harrisonfamily.us/mcp";
/** The MCP access token an OAuth client gets from this browser session (authorize with max_age, then the code grant). */
async function mcpAccessToken(cookie) {
  const verifier = Buffer.from(randomBytes(32)).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const q = { response_type: "code", client_id: "mcp-harrisonfamily", redirect_uri: MCP_CB, state: "s", code_challenge: challenge, code_challenge_method: "S256", resource: MCP_RES, max_age: "300" };
  const r = await edge({ rawPath: "/auth/authorize", queryStringParameters: q, requestContext: { http: { method: "GET" } }, headers: { cookie } });
  expect(r.statusCode).toBe(302);
  const code = new URL(r.headers.location).searchParams.get("code");
  expect(code).toBeTruthy();
  const t = await edge({ rawPath: "/auth/token", requestContext: { http: { method: "POST" } }, headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: MCP_CB, client_id: "mcp-harrisonfamily", code_verifier: verifier }).toString() });
  expect(t.statusCode).toBe(200);
  return (await jwtVerify(JSON.parse(t.body).access_token, jwks, { issuer: "https://harrisonfamily.us/auth", audience: MCP_RES })).payload;
}
/** Enrols a fresh software authenticator for the signed-in member, then signs in with it alone; returns the new session cookies. */
async function enrolAndSignIn(cookie, a) {
  const { options } = json(await call("POST", "/auth/passkey/register/options", {}, cookie));
  expect((await call("POST", "/auth/passkey/register/verify", { response: a.register({ challenge: options.challenge, rp: options.rp, user: options.user }) }, cookie)).statusCode).toBe(200);
  const o = json(await call("POST", "/auth/passkey/login/options", {})).options;
  const res = await call("POST", "/auth/passkey/login/verify", { response: a.authenticate({ challenge: o.challenge }) });
  expect(res.statusCode).toBe(200);
  return jar(res);
}
const json = (res) => JSON.parse(res.body);

async function googleSignIn(email) {
  const res = await call("POST", "/auth/google", { credential: await gToken(email) });
  expect(res.statusCode).toBe(200);
  return jar(res);
}
async function enrol(cookie) {
  const { options } = json(await call("POST", "/auth/passkey/register/options", {}, cookie));
  const response = authenticator.register({ challenge: options.challenge, rp: options.rp, user: options.user });
  const res = await call("POST", "/auth/passkey/register/verify", { response, label: "Test key" }, cookie);
  expect(res.statusCode).toBe(200);
  return json(res).passkey;
}
async function passkeyLogin(returnTo) {
  const { options } = json(await call("POST", "/auth/passkey/login/options", {}));
  return call("POST", "/auth/passkey/login/verify", { response: authenticator.authenticate({ challenge: options.challenge }), ...(returnTo ? { returnTo } : {}) });
}

beforeAll(async () => {
  const manifest = loadManifest(raw, ENV);
  manifest.resolver.cacheSeconds = 0; // production caches the allowlist for 300 s; the test needs removals to bite at once
  const g = await generateKeyPair("RS256", { extractable: true });
  const s = await generateKeyPair("RS256", { extractable: true });
  gToken = (email) => new SignJWT({ email, email_verified: true }).setProtectedHeader({ alg: "RS256", kid: "g1" }).setSubject("gs").setIssuer("https://accounts.google.com").setAudience(ENV.GOOGLE_CLIENT_ID).setIssuedAt().setExpirationTime("10m").sign(g.privateKey);
  const pub = { ...(await exportJWK(s.publicKey)), kid: "hfy-session-1", alg: "RS256", use: "sig" };
  jwks = createLocalJWKSet({ keys: [pub] });
  allow = { "ana@example.com": "I0111", "bo@example.com": { gramps_id: "I0222", label: "Bo Harrison" } };
  const identity = createIdentityService({
    resolver: buildResolver(manifest.resolver, { readObject: async () => JSON.stringify(allow) }),
    links: memoryLinkStore(),
    google: { clientId: ENV.GOOGLE_CLIENT_ID, jwks: createLocalJWKSet({ keys: [{ ...(await exportJWK(g.publicKey)), kid: "g1", alg: "RS256", use: "sig" }] }) },
    sessions: { issuer: manifest.session.issuer, audience: manifest.session.audience, kid: "hfy-session-1", privateKey: s.privateKey, store: memoryRefreshStore(), defaultProfile: "installed" },
  });
  const pk = manifest.providers.find((p) => p.kind === "passkey");
  const passkeys = createPasskeyService({ rpID: pk.rpId, rpName: pk.rpName, origin: pk.origins, store: memoryPasskeyStore(), challenges: memoryChallengeStore() });
  authenticator = createSoftwareAuthenticator({ rpId: pk.rpId, origin: ORIGIN });
  const oauth = createOAuthServer({
    issuer: manifest.session.issuer, redirectUris: [MCP_CB], resources: [MCP_RES], store: memoryOAuthStore(),
    signer: { privateKey: s.privateKey, kid: "hfy-session-1" }, groupsFor: async (sub) => (["I0111", "I0222"].includes(sub) ? ["members", "admins"] : null),
  });
  edge = createAuthEdge({ manifest, identity, publicJwk: pub, passkeys, passkeyClientScript: loadPasskeyBrowserBundle(), oauth, verify: { issuers: [manifest.session.issuer], audiences: [manifest.session.audience], jwks }, nonce: () => "n0nce" });
});

describe("passkeys on the harrisonfamily edge (HFY-TSK-078)", () => {
  it("the manifest declares the passkey provider for harrisonfamily.us and the login page offers all three paths", async () => {
    expect(raw.providers.find((p) => p.kind === "passkey")).toEqual({ kind: "passkey", rpId: "harrisonfamily.us", rpName: "Harrison Family", origins: [ORIGIN] });
    const page = await edge({ rawPath: "/auth/login", requestContext: { http: { method: "GET" } }, headers: { accept: "text/html" } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toMatch(/passkey/i);
    expect(page.body).toMatch(/webauthn/); // conditional UI: autocomplete="username webauthn"
    const client = await edge({ rawPath: "/auth/passkey/client.js", requestContext: { http: { method: "GET" } }, headers: {} });
    expect(client.statusCode).toBe(200);
    expect(client.headers["content-type"]).toMatch(/javascript/);
  });

  it("/auth/passkeys sends the member to the account page that lists and removes their own passkeys", async () => {
    const res = await edge({ rawPath: "/auth/passkeys", requestContext: { http: { method: "GET" } }, headers: {} });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/auth/link");
  });

  it("enrols after a Google sign-in, signs in usernameless, and the session carries amr passkey + mfa and the allowlist sub", async () => {
    const cookie = await googleSignIn("ana@example.com");
    const created = await enrol(cookie);
    expect((json(await call("GET", "/auth/passkey/list", undefined, cookie))).passkeys.map((p) => p.id ?? p.credentialId)).toContain(created.id ?? created.credentialId);
    const res = await passkeyLogin("/\t/evil.example"); // the kit's returnTo check would let this through
    expect(res.statusCode).toBe(200);
    expect(json(res).returnTo).toBe("/");
    const id = jar(res).match(/io_id=([^;]+)/)[1];
    const { payload } = await jwtVerify(id, jwks, { issuer: "https://harrisonfamily.us/auth", audience: "harrisonfamily-web" });
    expect(payload.sub).toBe("I0111");
    expect(payload.amr).toEqual(expect.arrayContaining(["passkey", "mfa"]));
    expect(json(await edge({ rawPath: "/auth/session", requestContext: { http: { method: "GET" } }, headers: { cookie: jar(res) } }))).toMatchObject({ authenticated: true, sub: "I0111" });
  });

  it("step-up assurance (HFY-R67): a passkey sign-in WITH user verification carries amr mfa into io_id and into the MCP access token", async () => {
    const cookie = await enrolAndSignIn(await googleSignIn("ana@example.com"), createSoftwareAuthenticator({ rpId: "harrisonfamily.us", origin: ORIGIN }));
    const { payload } = await jwtVerify(cookie.match(/io_id=([^;]+)/)[1], jwks, { issuer: "https://harrisonfamily.us/auth", audience: "harrisonfamily-web" });
    expect(payload.amr).toEqual(["passkey", "hwk", "mfa"]);
    const at = await mcpAccessToken(cookie);
    expect(at).toMatchObject({ sub: "I0111", amr: ["passkey", "hwk", "mfa"], auth_time: payload.iat });
    expect("name" in at).toBe(false); // Ana's allowlist entry has no label: the kit's fallback label is her email, which is never minted as name
  });

  it("step-up assurance (HFY-R67): a presence-only passkey sign-in (no PIN or biometric) is still a sign-in, but its amr has no mfa", async () => {
    const cookie = await enrolAndSignIn(await googleSignIn("bo@example.com"), createSoftwareAuthenticator({ rpId: "harrisonfamily.us", origin: ORIGIN, userVerified: false }));
    const { payload } = await jwtVerify(cookie.match(/io_id=([^;]+)/)[1], jwks, { issuer: "https://harrisonfamily.us/auth", audience: "harrisonfamily-web" });
    expect(payload.amr).toEqual(["passkey", "hwk"]);
    const at = await mcpAccessToken(cookie);
    expect(at).toMatchObject({ sub: "I0222", amr: ["passkey", "hwk"], name: "Bo Harrison" });
    expect(at.amr).not.toContain("mfa"); // the MCP step-up delete requires mfa (api/src/policy.js STRONG_AMR)
  });

  it("re-checks the allowlist on every passkey login: a removed member is denied (403) even with a valid credential", async () => {
    const saved = allow["ana@example.com"];
    delete allow["ana@example.com"];
    try {
      const res = await passkeyLogin();
      expect(res.statusCode).toBe(403);
      expect(res.cookies ?? []).toEqual([]);
    } finally {
      allow["ana@example.com"] = saved;
    }
    expect((await passkeyLogin()).statusCode).toBe(200); // back on the list: works again
  });

  it("a removed credential is rejected, and a member cannot remove someone else's", async () => {
    const ana = await googleSignIn("ana@example.com");
    const bo = await googleSignIn("bo@example.com");
    const [first] = json(await call("GET", "/auth/passkey/list", undefined, ana)).passkeys;
    const id = first.id ?? first.credentialId;
    expect((await call("DELETE", `/auth/passkey/${encodeURIComponent(id)}`, undefined, bo)).statusCode).toBe(404);
    expect((await call("DELETE", `/auth/passkey/${encodeURIComponent(id)}`, undefined, ana)).statusCode).toBe(200);
    expect((await passkeyLogin()).statusCode).toBe(401);
  });
});
