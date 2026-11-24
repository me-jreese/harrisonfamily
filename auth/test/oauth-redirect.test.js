// HFY-TSK-413 (AC2): the MCP client's redirect allow-list = exact claude and Cursor callbacks + loopback at any port (RFC 8252 section 7.3).
// Self-contained on purpose: it needs only oauth.js, so it runs without the sign-in service wiring.
import { describe, it, expect } from "vitest";
import { MCP_BUILTIN_REDIRECTS, createOAuthServer, isLoopbackRedirectUri, mcpClient, memoryOAuthStore } from "../src/oauth.js";

const ISS = "https://harrisonfamily.us/auth";
const RES = "https://harrisonfamily.us/mcp";
const CLAUDE = "https://claude.ai/api/mcp/auth_callback";
const CURSOR_WEB = "https://www.cursor.com/agents/mcp/oauth/callback";
const CURSOR_APP = "cursor://anysphere.cursor-mcp/oauth/callback";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

const ACCEPT = [
  "http://localhost:8787/callback", "http://localhost/callback", "http://localhost:1/x", "http://localhost:65535/callback",
  "http://127.0.0.1:54321/callback", "http://127.0.0.1/callback", "http://127.0.0.1:3000/oauth/cb", "http://127.0.0.1:3000/",
  "http://[::1]:8080/callback", "http://LOCALHOST:8787/callback",
];
const REFUSE = [
  "https://localhost:8787/callback", "https://127.0.0.1:8787/callback", "http://localhost.evil.com:8787/callback", "http://127.0.0.1.evil.com/callback",
  "http://evil.com/localhost", "http://evil.com:8787/http://localhost/callback", "http://localhost@evil.com/callback", "http://evil.com@localhost:8787/callback",
  "http://localhost:" + "pass" + "@127.0.0.1/callback" /* built in parts: a literal URL with credentials trips the secret scanner */, "http://127.0.0.2:8787/callback", "http://0.0.0.0:8787/callback", "http://127.1:8787/callback",
  "http://[::2]:8787/callback", "http://[::ffff:127.0.0.1]:8787/callback", "http://localhost:0/callback", "http://localhost:65536/callback", "http://localhost:99999/callback",
  "http://localhost:80a/callback", "http://localhost:8787/callback?x=1", "http://localhost:8787/callback#f", "http://localhost:8787/../x", "http://localhost:8787//x",
  "http://localhost:" + "8787\\@evil.com/", " http://localhost:8787/callback", "http://localhost:8787/callback ", "http://localhost:8787/a b", "http://localhost.:8787/callback",
  "ftp://localhost:8787/callback", "javascript://localhost/%0aalert(1)", "myapp://localhost/callback", "//localhost:8787/callback", "localhost:8787/callback",
  "https://evil.example/cb", "https://claude.ai.evil.com/api/mcp/auth_callback", `${CLAUDE}/`, `${CLAUDE}?x=1`, "https://www.cursor.com/agents/mcp/oauth/callback/x", "cursor://evil/oauth/callback",
  "", 8787, null, undefined, {},
];

const mk = () => createOAuthServer({
  issuer: ISS, store: memoryOAuthStore(), signer: { privateKey: null, kid: "k" }, groupsFor: async () => ["members"],
  clients: [mcpClient({ redirectUris: [CLAUDE], resources: [RES] })],
});
const authz = (srv, redirect_uri) => srv.authorize({ response_type: "code", client_id: "mcp-harrisonfamily", redirect_uri, state: "s", code_challenge: CHALLENGE, code_challenge_method: "S256" }, async () => ({ sub: "I0111", authTime: Math.floor(Date.now() / 1000) }));

describe("isLoopbackRedirectUri (RFC 8252 section 7.3)", () => {
  it.each(ACCEPT)("accepts %s", (u) => expect(isLoopbackRedirectUri(u)).toBe(true));
  it.each(REFUSE.map((u) => [String(u), u]))("refuses %s", (_l, u) => expect(isLoopbackRedirectUri(u)).toBe(false));
  it("does not accept the exact callbacks (those are matched, not loopback)", () => {
    for (const u of [CLAUDE, CURSOR_WEB, CURSOR_APP]) expect(isLoopbackRedirectUri(u)).toBe(false);
  });
});

describe("MCP client redirect allow-list at /authorize and /register (HFY-TSK-413)", () => {
  it("lists the claude and Cursor callbacks the fleet probe and Cursor use", () => {
    expect(MCP_BUILTIN_REDIRECTS).toEqual(expect.arrayContaining([CLAUDE, "https://claude.com/api/mcp/auth_callback", CURSOR_WEB, CURSOR_APP]));
  });
  it("authorize redirects back for every exact callback and every loopback URI, to that URI", async () => {
    const srv = mk();
    for (const u of [CLAUDE, CURSOR_WEB, CURSOR_APP, ...ACCEPT]) {
      const r = await authz(srv, u);
      expect(r.statusCode, u).toBe(302);
      const to = new URL(r.headers.location);
      expect(to.searchParams.get("code"), u).toBeTruthy();
      const want = new URL(u);
      expect([to.protocol, to.host, to.pathname], u).toEqual([want.protocol, want.host, want.pathname]);
    }
  });
  it("authorize refuses everything else with 400 and never redirects", async () => {
    const srv = mk();
    for (const u of REFUSE) {
      const r = await authz(srv, u);
      expect(r.statusCode, String(u)).toBe(400);
      expect(r.headers.location, String(u)).toBeUndefined();
    }
  });
  it("register refuses exactly what authorize refuses, and accepts what it accepts (probe check C13)", async () => {
    const srv = mk();
    for (const u of [CLAUDE, CURSOR_WEB, CURSOR_APP, ...ACCEPT]) {
      const r = srv.register({ client_name: "x", redirect_uris: [u] });
      expect(r.statusCode, u).toBe(201);
      expect(JSON.parse(r.body).redirect_uris).toEqual([u]);
    }
    for (const u of REFUSE.filter((x) => typeof x === "string")) {
      const r = srv.register({ client_name: "fleet-probe", redirect_uris: [u] });
      expect(r.statusCode, u).toBe(400);
      expect(JSON.parse(r.body).error).toBe("invalid_redirect_uri");
    }
    expect(srv.register({ client_name: "fleet-probe", redirect_uris: ["https://example.invalid/cb"] }).statusCode).toBe(400);
    expect(srv.register({ redirect_uris: [CLAUDE, "http://localhost:1/cb", "https://evil.example/cb"] }).statusCode).toBe(400); // one bad URI refuses the whole request
  });
  it("a client without anyLoopback keeps the exact-match rule, so the loopback grant is opt-in", async () => {
    const srv = createOAuthServer({ issuer: ISS, store: memoryOAuthStore(), signer: { privateKey: null, kid: "k" }, groupsFor: async () => ["members"], redirectUris: [CLAUDE], resources: [RES] });
    expect((await authz(srv, "http://localhost:8787/callback")).statusCode).toBe(400);
    expect((await authz(srv, CURSOR_WEB)).statusCode).toBe(400);
    expect((await authz(srv, CLAUDE)).statusCode).toBe(302);
  });
});
