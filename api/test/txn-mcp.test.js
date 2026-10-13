// HFY-TSK-235 review fixes: a busy store surfaces through the MCP tools as a tool error with fixed text, and the MCP logger carries
// codes only (PS-20). Synthetic data only.
import { describe, expect, it } from "vitest";
import { SignJWT, importJWK } from "jose";
import priv from "@io-kit/mcp/fixtures/keys/hfy-auth-edge.private.jwk.json" with { type: "json" };
import jwks from "@io-kit/mcp/fixtures/jwks/hfy-auth-edge.jwks.json" with { type: "json" };
import { createMcpMount } from "../src/mcp.js";
import { createGroupResolver } from "../src/policy.js";
import { makeApi } from "./world.js";

const RESOURCE = "https://harrisonfamily.us/mcp";
const ISS = "https://harrisonfamily.us/auth";
const NOTE = "NOTE-TEXT-5c1e: synthetic note body that must never be logged";
const GROUPS = { version: 1, groups: { "mcp-authors": { emails: [], subjects: ["I0044"] }, "hfy-admin": { subjects: [] } } };
const key = await importJWK(priv, "RS256");
const token = (sub) =>
  new SignJWT({ client_id: "mcp-harrisonfamily", token_use: "access", scope: "openid" })
    .setProtectedHeader({ alg: "RS256", kid: priv.kid ?? "hfy-auth-edge-key-1" }).setSubject(sub).setIssuer(ISS).setAudience(RESOURCE).setIssuedAt().setExpirationTime("10m").sign(key);

function setup(apiOpts = {}) {
  const lines = [];
  const log = { info() {}, warn: (...a) => lines.push(a), error: (...a) => lines.push(a) };
  const api = makeApi(apiOpts);
  const config = { resourceUrl: RESOURCE, audience: RESOURCE, issuer: ISS, jwksUri: `${ISS}/.well-known/jwks.json`, clientIds: ["mcp-harrisonfamily"], scopes: ["openid"] };
  const mount = createMcpMount({ config, invoke: api.handler.invoke, resolveGroups: createGroupResolver({ load: async () => GROUPS, log }), fetch: async () => ({ ok: true, status: 200, json: async () => jwks }), log });
  let id = 0;
  const call = async (name, args) => {
    const tok = await token("I0044");
    const r = await mount.handle({ rawPath: "/mcp", headers: { "content-type": "application/json", authorization: `Bearer ${tok}` }, requestContext: { http: { method: "POST" } }, body: JSON.stringify({ jsonrpc: "2.0", id: (id += 1), method: "tools/call", params: { name, arguments: args } }) });
    return JSON.parse(r.body).result;
  };
  return { api, call, lines };
}

describe("MCP tools over a busy or failing store", () => {
  it("exhausted TransactionConflict retries reach the tool caller as the fixed busy text, with one token and nothing written", async () => {
    const { api, call, lines } = setup();
    api.ddb.failNext("TransactionConflict", 10);
    const r = await call("hfy_posts_create", { title: "Hello", body: "From Claude" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("busy, try again");
    expect(api.ddb.tokens).toHaveLength(4);
    expect(new Set(api.ddb.tokens).size).toBe(1);
    expect(api.ddb.all()).toEqual([]);
    expect(lines.some((l) => l.some((x) => x?.code === "busy"))).toBe(true);
  });

  it("the MCP logger carries name and code only: a store error quoting note text never reaches the log", async () => {
    const { api, call, lines } = setup({
      intercept: async (cmd) => { if (cmd.constructor.name === "TransactWriteCommand") JSON.parse(`{"note": ${NOTE}}`); },
    });
    const r = await call("hfy_posts_create", { title: "Hello", body: "From Claude" });
    expect(r.isError).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
    expect(JSON.stringify(lines)).not.toContain("NOTE-TEXT");
    expect(lines.some((l) => l.some((x) => x?.name === "ContentError" || x?.name === "SyntaxError" || x?.name === "HttpError"))).toBe(true);
    expect(api.ddb.all()).toEqual([]);
  });
});
