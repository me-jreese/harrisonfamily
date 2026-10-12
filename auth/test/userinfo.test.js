import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet, createRemoteJWKSet } from "jose";
import { DEFAULT_MCP_RESOURCE, createOAuthServer, memoryOAuthStore } from "../src/oauth.js";

const ISS = "https://harrisonfamily.us/auth";
const RES = "https://harrisonfamily.us/mcp";
const members = { I0111: ["members", "admins"] };
const ev = (authorization) => ({ rawPath: "/auth/userinfo", requestContext: { http: { method: "GET" } }, headers: authorization ? { authorization } : {} });
const pubJwk = async (k, kid) => ({ ...(await exportJWK(k.publicKey)), kid, alg: "RS256", use: "sig" });
const access = (key, kid, o = {}) =>
  new SignJWT({ groups: ["members"], scope: "mcp", client_id: "mcp-harrisonfamily", token_use: o.use ?? "access" })
    .setProtectedHeader({ alg: "RS256", kid, typ: "at+jwt" }).setSubject(o.sub ?? "I0111").setIssuer(ISS).setAudience(o.aud ?? RES).setIssuedAt().setExpirationTime("1h").sign(key);
const server = (jwks, groupsFor = async (sub) => members[sub] ?? null) =>
  createOAuthServer({ issuer: ISS, redirectUris: ["https://claude.ai/api/mcp/auth_callback"], resources: [RES], store: memoryOAuthStore(), signer: { privateKey: null, kid: "k" }, groupsFor, jwks });

describe("MCP default resource (HFY-R59)", () => {
  it("is the apex /mcp URL", () => expect(DEFAULT_MCP_RESOURCE).toBe("https://harrisonfamily.us/mcp"));
});

describe("GET /auth/userinfo (HFY-R55)", () => {
  it("returns {sub, groups, email_verified} for a valid access token and advertises the endpoint", async () => {
    const k = await generateKeyPair("RS256", { extractable: true });
    const s = server(createLocalJWKSet({ keys: [await pubJwk(k, "k1")] }));
    const r = await s.handle("/userinfo", ev(`Bearer ${await access(k.privateKey, "k1")}`), async () => null);
    expect(r.statusCode).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(JSON.parse(r.body)).toEqual({ sub: "I0111", groups: ["members", "admins"], email_verified: true });
    expect(JSON.parse(s.metadata().body).userinfo_endpoint).toBe(`${ISS}/userinfo`);
  });
  it("401s without a bearer, with a bad signature, wrong audience, an id token, or a removed member", async () => {
    const k = await generateKeyPair("RS256", { extractable: true });
    const other = await generateKeyPair("RS256", { extractable: true });
    const s = server(createLocalJWKSet({ keys: [await pubJwk(k, "k1")] }));
    const call = async (a) => (await s.handle("/userinfo", ev(a), async () => null)).statusCode;
    expect(await call(undefined)).toBe(401);
    expect(await call("Basic abc")).toBe(401);
    expect(await call(`Bearer ${await access(other.privateKey, "k1")}`)).toBe(401);
    expect(await call(`Bearer ${await access(k.privateKey, "k1", { aud: "https://evil.example/mcp" })}`)).toBe(401);
    expect(await call(`Bearer ${await access(k.privateKey, "k1", { use: "id" })}`)).toBe(401);
    expect(await call(`Bearer ${await access(k.privateKey, "k1", { sub: "I0999" })}`)).toBe(401); // not on the allowlist any more
  });
  it("validates a rotated kid after a forced JWKS refetch", async () => {
    const k1 = await generateKeyPair("RS256", { extractable: true });
    const k2 = await generateKeyPair("RS256", { extractable: true });
    let served = [await pubJwk(k1, "hfy-session-1")];
    const srv = createServer((q, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ keys: served })); });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    try {
      const s = server(createRemoteJWKSet(new URL(`http://127.0.0.1:${srv.address().port}/jwks.json`), { cooldownDuration: 0 }));
      const call = async (key, kid) => (await s.handle("/userinfo", ev(`Bearer ${await access(key, kid)}`), async () => null)).statusCode;
      expect(await call(k1.privateKey, "hfy-session-1")).toBe(200);
      expect(await call(k2.privateKey, "hfy-session-2")).toBe(401); // unpublished kid
      served = [await pubJwk(k2, "hfy-session-2")];
      expect(await call(k2.privateKey, "hfy-session-2")).toBe(200); // rotated kid, refetched
      expect(await call(k1.privateKey, "hfy-session-1")).toBe(401);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});
