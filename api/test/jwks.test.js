import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { createAuthenticator, createJwks } from "../src/auth.js";

const ISS = "https://harrisonfamily.us/auth";
const AUD = "harrisonfamily-web";
let server, url, good, other;
const sign = (key, sub, kid = "hfy-session-1", aud = AUD) =>
  new SignJWT({ client_id: aud, token_use: "id", name: "Ana" }).setProtectedHeader({ alg: "RS256", kid })
    .setSubject(sub).setIssuer(ISS).setAudience(aud).setIssuedAt().setExpirationTime("1h").sign(key);
const ev = (tok) => ({ headers: { cookie: `io_id=${tok}` }, cookies: [`io_id=${tok}`] });

beforeAll(async () => {
  good = await generateKeyPair("RS256", { extractable: true });
  other = await generateKeyPair("RS256", { extractable: true });
  const jwk = { ...(await exportJWK(good.publicKey)), kid: "hfy-session-1", alg: "RS256", use: "sig" };
  server = http.createServer((req, res) => {
    if (req.url === "/auth/.well-known/jwks.json") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ keys: [jwk] })); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${server.address().port}/auth/.well-known/jwks.json`;
});
afterAll(() => new Promise((r) => server.close(r)));

describe("api verifies sessions via the auth edge JWKS", () => {
  const quiet = { warn() {}, error() {} };
  const mk = () => createAuthenticator({ issuer: ISS, audience: AUD, getJwks: async () => createJwks(url), getAdmins: async () => new Set(["I0099"]), log: quiet });

  it("accepts a token signed by the published key (sub = gramps_id) and flags admins", async () => {
    const auth = mk();
    expect(await auth(ev(await sign(good.privateKey, "I0111")))).toMatchObject({ id: "I0111", admin: false });
    expect(await auth(ev(await sign(good.privateKey, "I0099")))).toMatchObject({ id: "I0099", admin: true });
  });
  it("rejects a token signed by another key, the wrong audience, or an unknown kid", async () => {
    const auth = mk();
    expect(await auth(ev(await sign(other.privateKey, "I0111")))).toBeNull();
    expect(await auth(ev(await sign(good.privateKey, "I0111", "hfy-session-1", "harrisonfamily")))).toBeNull();
    expect(await auth(ev(await sign(good.privateKey, "I0111", "rotated-kid")))).toBeNull();
  });
  it("rejects requests without the cookie", async () => {
    expect(await mk()({ headers: {} })).toBeNull();
  });
});
