import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet, jwtVerify } from "jose";
import { buildResolver, validateManifest } from "@io-kit/auth/edge/deploy";
import { createIdentityService, memoryLinkStore, memoryRefreshStore } from "@io-kit/auth/server";
import { createAuthEdge, loadManifest, patchPostHash } from "../src/edge.js";
import { parseSigningSecret } from "../src/index.js";

const raw = JSON.parse(readFileSync(new URL("../edge.manifest.json", import.meta.url), "utf8"));
const ENV = { COGNITO_USER_POOL_ID: "us-west-2_TEST", COGNITO_CLIENT_ID: "client123", GOOGLE_CLIENT_ID: "gis-client.apps.googleusercontent.com" };
const ALLOW = { "ana@example.com": "I0111", "Bo@Example.com": { gramps_id: "I0222", label: "Bo" } };
const post = (rawPath, body) => ({
  rawPath, requestContext: { http: { method: "POST" } },
  headers: { "x-requested-with": "io-kit", origin: "https://harrisonfamily.us", "content-type": "application/json", accept: "application/json" },
  body: JSON.stringify(body),
});
const get = (rawPath, extra = {}) => ({ rawPath, requestContext: { http: { method: "GET" } }, headers: { accept: "text/html" }, ...extra });

let edge, manifest, sessionPub, googleKey, gToken;
beforeAll(async () => {
  manifest = loadManifest(raw, ENV);
  const g = await generateKeyPair("RS256", { extractable: true });
  const s = await generateKeyPair("RS256", { extractable: true });
  googleKey = g;
  gToken = (email, extra = {}) =>
    new SignJWT({ email, email_verified: true, ...extra }).setProtectedHeader({ alg: "RS256", kid: "g1" })
      .setSubject("google-sub-1").setIssuer("https://accounts.google.com").setAudience(ENV.GOOGLE_CLIENT_ID).setIssuedAt().setExpirationTime("10m").sign(g.privateKey);
  sessionPub = { ...(await exportJWK(s.publicKey)), kid: "hfy-session-1", alg: "RS256", use: "sig" };
  const gjwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(g.publicKey)), kid: "g1", alg: "RS256", use: "sig" }] });
  const identity = createIdentityService({
    resolver: buildResolver(manifest.resolver, { readObject: async (bucket, key) => { expect([bucket, key]).toEqual(["harrisonfamily", "config/userGrampsID.json"]); return JSON.stringify(ALLOW); } }),
    links: memoryLinkStore(),
    google: { clientId: ENV.GOOGLE_CLIENT_ID, jwks: gjwks },
    sessions: { issuer: manifest.session.issuer, audience: manifest.session.audience, kid: "hfy-session-1", privateKey: s.privateKey, store: memoryRefreshStore(), defaultProfile: "installed" },
  });
  edge = createAuthEdge({ manifest, identity, publicJwk: sessionPub, verify: { issuers: [manifest.session.issuer], audiences: [manifest.session.audience], jwks: createLocalJWKSet({ keys: [sessionPub] }) }, nonce: () => "n0nce" });
});

describe("manifest", () => {
  it("committed manifest validates and carries the HFY-R31/R38 values", () => {
    const m = validateManifest(raw);
    expect(m).toMatchObject({ site: "harrisonfamily.us", authOrigin: "https://harrisonfamily.us", session: { issuer: "https://harrisonfamily.us/auth", audience: "harrisonfamily-web", profile: "installed", signingKeySecretName: "harrisonfamily/auth-edge/session-signing-key" }, resolver: { kind: "s3_allowlist", bucket: "harrisonfamily", key: "config/userGrampsID.json" }, store: { kind: "dynamodb", tableEnv: "AUTH_TABLE" } });
    expect(m.providers.map((p) => p.kind)).toEqual(["google", "password"]);
    expect(JSON.stringify(raw)).not.toMatch(/PRIVATE KEY/);
  });
  it("loadManifest injects ids from the environment and fails closed when one is missing", () => {
    expect(manifest.idp).toMatchObject({ userPoolId: "us-west-2_TEST", clientId: "client123" });
    expect(manifest.providers[0].clientId).toBe(ENV.GOOGLE_CLIENT_ID);
    expect(() => loadManifest(raw, { ...ENV, GOOGLE_CLIENT_ID: "" })).toThrow(/GOOGLE_CLIENT_ID/);
  });
  it("parseSigningSecret reads the JSON secret and a bare PEM", () => {
    expect(parseSigningSecret(JSON.stringify({ privateKeyPem: "PEM", kid: "k9" }), "d")).toEqual({ pem: "PEM", kid: "k9" });
    expect(parseSigningSecret("-----BEGIN-----", "d")).toEqual({ pem: "-----BEGIN-----", kid: "d" });
  });
});

describe("resolver (S3 allowlist, email -> gramps_id)", () => {
  it("hit returns the gramps_id as sub (case-insensitive), miss returns null", async () => {
    const r = buildResolver(manifest.resolver, { readObject: async () => JSON.stringify(ALLOW) });
    expect(await r("ana@example.com", { kind: "google" })).toMatchObject({ sub: "I0111" });
    expect(await r("bo@example.com", { kind: "password" })).toMatchObject({ sub: "I0222", label: "Bo" });
    expect(await r("stranger@example.com", { kind: "google" })).toBeNull();
  });
});

describe("GIS sign-in at /auth/google", () => {
  it("allowlisted email -> 200, host-only io_id cookie, session sub = gramps_id", async () => {
    const res = await edge(post("/auth/google", { credential: await gToken("ana@example.com") }));
    expect(res.statusCode).toBe(200);
    const cookies = res.cookies ?? [];
    const id = cookies.find((c) => c.startsWith("io_id="));
    expect(id).toBeTruthy();
    expect(cookies.join("\n")).not.toMatch(/Domain=/i);
    expect(id).toMatch(/HttpOnly/i);
    const cookie = cookies.map((c) => c.split(";")[0]).join("; ");
    const s = await edge(get("/auth/session", { headers: { cookie } }));
    expect(JSON.parse(s.body)).toMatchObject({ authenticated: true, sub: "I0111" });
    // the API verifies this exact token through the published JWKS
    const jwks = createLocalJWKSet(JSON.parse((await edge(get("/auth/.well-known/jwks.json"))).body));
    const { payload } = await jwtVerify(id.split(";")[0].slice(6), jwks, { issuer: "https://harrisonfamily.us/auth", audience: "harrisonfamily-web" });
    expect(payload.sub).toBe("I0111");
  });
  it("email not on the allowlist -> 403 not_allowlisted and no cookie", async () => {
    const res = await edge(post("/auth/google", { credential: await gToken("stranger@example.com") }));
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatch(/not_allowlisted/);
    expect(res.cookies ?? []).toEqual([]);
  });
  it("wrong audience, missing header guard and bad origin are refused", async () => {
    const bad = await new SignJWT({ email: "ana@example.com", email_verified: true }).setProtectedHeader({ alg: "RS256", kid: "g1" }).setSubject("x").setIssuer("https://accounts.google.com").setAudience("other").setExpirationTime("10m").sign(googleKey.privateKey);
    expect((await edge(post("/auth/google", { credential: bad }))).statusCode).toBeGreaterThanOrEqual(401);
    const noHdr = post("/auth/google", { credential: "x" }); delete noHdr.headers["x-requested-with"];
    expect((await edge(noHdr)).statusCode).toBe(403);
    expect((await edge({ ...post("/auth/google", { credential: "x" }), headers: { ...post("/", {}).headers, origin: "https://evil.example" } })).statusCode).toBe(403);
  });
});

describe("session + JWKS endpoints", () => {
  it("GET /auth/.well-known/jwks.json is a public RSA key set", async () => {
    const res = await edge(get("/auth/.well-known/jwks.json"));
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toMatch(/public/);
    const { keys } = JSON.parse(res.body);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ kty: "RSA", kid: "hfy-session-1", alg: "RS256", use: "sig" });
    expect(keys[0].d).toBeUndefined();
    expect((await edge({ ...get("/auth/.well-known/jwks.json"), requestContext: { http: { method: "POST" } } })).statusCode).toBe(405);
  });
  it("/auth/session without a (valid) cookie is unauthenticated and uncacheable", async () => {
    for (const headers of [{}, { cookie: "io_id=garbage" }]) {
      const res = await edge(get("/auth/session", { headers }));
      expect(JSON.parse(res.body)).toEqual({ authenticated: false });
      expect(res.headers["cache-control"]).toBe("no-store");
    }
  });
  it("paths outside /auth are 404", async () => {
    expect((await edge(get("/login"))).statusCode).toBe(404);
  });
});

describe("login page under the /auth mount", () => {
  it("serves both paths, rewrites root-relative links to /auth/*, and sends the OAC payload hash", async () => {
    const res = await edge(get("/auth/login"));
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-security-policy"]).toMatch(/accounts\.google\.com/);
    expect(res.body).toContain('id="pw"');
    expect(res.body).toContain("/auth/password");
    expect(res.body).toMatch(/href="\/auth\/password\/forgot"/);
    expect(res.body).not.toMatch(/(href|action)="\/(password|verify|link|login)/);
    expect(res.body).toContain("x-amz-content-sha256");
    expect(res.body).toContain("body:__s");
  });
  it("patchPostHash is a no-op when the kit script changes shape", () => {
    expect(patchPostHash("<p>nothing</p>")).toBe("<p>nothing</p>");
  });
});
