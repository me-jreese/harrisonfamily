// HFY-TSK-413 (AC1): @io-kit/mcp 0.3.0 in manifest form. The edge resolves the connector `harrisonfamily` through this deployment's own registry
// (src/fleet.js), and answers protected-resource metadata and 401 with `x-io-kit-mcp` = the pinned kit version (probe check C16).
// Depends only on the kit edge and mcp-edge.js, so it also runs without the rest of the API.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lambdaAdapter, loadFleet, setFleet } from "@io-kit/mcp/edge";
import { createMcpEdge, loadMcpConfig } from "../src/mcp-edge.js";
import { CONNECTOR, FLEET, installFleet } from "../src/fleet.js";

const pin = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).dependencies["@io-kit/mcp"];
const SITE = "https://harrisonfamily.us";
const never = async () => new Response("downstream must not run", { status: 500 });
const ev = (method, rawPath, body) => ({ rawPath, headers: { host: "abc.lambda-url.us-west-2.on.aws", "content-type": "application/json" }, requestContext: { http: { method } }, ...(body ? { body: JSON.stringify(body) } : {}) });
const lower = (h) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));

describe("fleet registry and settings", () => {
  it("pins @io-kit/mcp exactly (no range), so the header below is the version that deploys", () => {
    expect(pin).toMatch(/^\d+\.\d+\.\d+$/);
  });
  it("names only this site: the harrisonfamily profile, on its own auth edge, and the harrisonfamily connector", () => {
    expect(Object.keys(FLEET.profiles)).toEqual(["harrisonfamily"]);
    expect(FLEET.connectors.map((c) => c.name)).toEqual([CONNECTOR]);
    expect(FLEET.profiles.harrisonfamily).toMatchObject({ provider: "auth-edge", sign_in_service: `${SITE}/auth`, issuer: `${SITE}/auth` });
    expect(FLEET.connectors[0]).toMatchObject({ url: SITE, mount: "/mcp", client_ids: ["mcp-harrisonfamily"] });
  });
  it("installFleet hands the registry to the kit", () => {
    setFleet(null);
    installFleet();
    expect(loadFleet().connectors[0].name).toBe("harrisonfamily");
  });
  it("loadMcpConfig with no overrides is manifest form and carries the production defaults", () => {
    expect(loadMcpConfig({})).toEqual({
      connector: "harrisonfamily", resourceUrl: `${SITE}/mcp`, audience: `${SITE}/mcp`, issuer: `${SITE}/auth`,
      jwksUri: `${SITE}/auth/.well-known/jwks.json`, clientIds: ["mcp-harrisonfamily"], scopes: ["openid", "email", "profile"],
    });
  });
  it("the stack's own settings (SESSION_ISSUER, SESSION_JWKS_URL at their defaults) stay in manifest form", () => {
    expect(loadMcpConfig({ SESSION_ISSUER: `${SITE}/auth`, SESSION_JWKS_URL: `${SITE}/auth/.well-known/jwks.json` }).connector).toBe("harrisonfamily");
  });
  it("an identity override leaves manifest form and is honoured as before", () => {
    for (const env of [{ MCP_CLIENT_IDS: "other" }, { MCP_RESOURCE_URL: "https://x.example/mcp" }, { MCP_TOKEN_ISSUER: "https://x.example/auth" }, { SESSION_ISSUER: "https://x.example/auth" }, { SESSION_JWKS_URL: "https://x.example/jwks" }]) {
      expect(loadMcpConfig(env).connector, JSON.stringify(env)).toBeUndefined();
    }
    expect(loadMcpConfig({ MCP_TOKEN_ISSUER: "https://x.example/auth" })).toMatchObject({ issuer: "https://x.example/auth", jwksUri: "https://x.example/auth/.well-known/jwks.json" });
    expect(loadMcpConfig({ MCP_CLIENT_IDS: "a, b" }).clientIds).toEqual(["a", "b"]);
  });
});

describe("the edge sends x-io-kit-mcp = the pinned version (C16) and names the auth edge (C01, C02)", () => {
  const manifest = () => lambdaAdapter(createMcpEdge(loadMcpConfig({})), never);
  const explicit = () => lambdaAdapter(createMcpEdge({ resourceUrl: `${SITE}/mcp`, issuer: `${SITE}/auth`, jwksUri: `${SITE}/auth/.well-known/jwks.json`, clientIds: ["mcp-harrisonfamily"], scopes: ["openid"] }), never);
  for (const [label, make] of [["manifest form", manifest], ["explicit form", explicit]]) {
    it(`${label}: PRM on both paths`, async () => {
      const run = make();
      for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
        const r = await run(ev("GET", path));
        expect(r.statusCode, path).toBe(200);
        expect(lower(r.headers)["x-io-kit-mcp"], path).toBe(pin);
        expect(JSON.parse(r.body)).toMatchObject({ resource: `${SITE}/mcp`, authorization_servers: [`${SITE}/auth`] });
      }
    });
    it(`${label}: a call without a token is a JSON 401 that carries the version and the challenge`, async () => {
      const r = await make()(ev("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }));
      expect(r.statusCode).toBe(401);
      expect(lower(r.headers)["x-io-kit-mcp"]).toBe(pin);
      expect(lower(r.headers)["www-authenticate"]).toContain(`resource_metadata="${SITE}/.well-known/oauth-protected-resource"`);
    });
  }
  it("the connector edge serves no registration or authorization-server routes (those are the auth edge's)", async () => {
    const run = manifest();
    for (const [m, p] of [["POST", "/register"], ["GET", "/authorize"], ["GET", "/.well-known/oauth-authorization-server"]]) expect((await run(ev(m, p))).statusCode, p).toBe(401);
  });
});
