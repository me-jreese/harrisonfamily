// HFY-TSK-077/073: the mounted MCP server end to end (bearer -> groups config -> policy -> the API's own route handlers over the DDB fake).
import { describe, expect, it } from "vitest";
import { SignJWT, importJWK } from "jose";
import priv from "@io-kit/mcp/fixtures/keys/hfy-auth-edge.private.jwk.json" with { type: "json" };
import jwks from "@io-kit/mcp/fixtures/jwks/hfy-auth-edge.jwks.json" with { type: "json" };
import { createMcpMount } from "../src/mcp.js";
import { createGroupResolver, parseGroupsConfig, POLICY_ROWS } from "../src/policy.js";
import { buildCaps } from "../src/routes.js";
import { makeApi } from "./world.js";

const RESOURCE = "https://harrisonfamily.us/mcp";
const ISS = "https://harrisonfamily.us/auth";
const GROUPS = { version: 1, groups: { "mcp-authors": { emails: ["Cousin@Example.test"], subjects: ["I0044"] }, "hfy-admin": { subjects: ["I0113"] } } };
const key = await importJWK(priv, "RS256");
const nowS = () => Math.floor(Date.now() / 1000);
const token = (sub, { aud = RESOURCE, amr, authTime, extra = {} } = {}) =>
  new SignJWT({ client_id: "mcp-harrisonfamily", token_use: "access", scope: "openid", ...(amr ? { amr } : {}), ...(authTime ? { auth_time: authTime } : {}), ...extra })
    .setProtectedHeader({ alg: "RS256", kid: priv.kid ?? "hfy-auth-edge-key-1" }).setSubject(sub).setIssuer(ISS).setAudience(aud).setIssuedAt().setExpirationTime("10m").sign(key);

function setup(groups = GROUPS) {
  const api = makeApi();
  const config = { resourceUrl: RESOURCE, audience: RESOURCE, issuer: ISS, jwksUri: `${ISS}/.well-known/jwks.json`, clientIds: ["mcp-harrisonfamily"], scopes: ["openid", "email", "profile"] };
  const mount = createMcpMount({ config, invoke: api.handler.invoke, resolveGroups: createGroupResolver({ load: async () => groups, log: { error() {} } }), fetch: async () => ({ ok: true, status: 200, json: async () => jwks }), log: { info() {}, error() {} } });
  const http = async (method, path, { tok, body } = {}) => {
    const r = await mount.handle({ rawPath: path, headers: { "content-type": "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, requestContext: { http: { method } }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.statusCode, headers: r.headers, body: r.body ? JSON.parse(r.body) : undefined };
  };
  let id = 0;
  const rpc = (tok, method, params) => http("POST", "/mcp", { tok, body: { jsonrpc: "2.0", id: (id += 1), method, params } }).then((r) => r.body);
  return { api, mount, http, rpc };
}
const names = (list) => list.result.tools.map((t) => t.name).sort();

describe("discovery and the bearer gate", () => {
  it("serves the PRM for the /mcp resource unauthenticated and points at the auth edge", async () => {
    const { http } = setup();
    for (const p of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
      const r = await http("GET", p);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ resource: RESOURCE, authorization_servers: [ISS], bearer_methods_supported: ["header"] });
    }
  });
  it("401s with WWW-Authenticate (realm, resource_metadata, scope) and never reads the session cookie", async () => {
    const { http } = setup();
    const r = await http("POST", "/mcp", { body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    expect(r.status).toBe(401);
    expect(r.headers["www-authenticate"]).toMatch(/^Bearer realm="harrisonfamily\.us", resource_metadata="https:\/\/harrisonfamily\.us\/\.well-known\/oauth-protected-resource", scope="openid email profile"/);
  });
  it("rejects a token whose aud is not https://harrisonfamily.us/mcp", async () => {
    const { http } = setup();
    for (const aud of ["https://mcp.harrisonfamily.us", "harrisonfamily-web"]) {
      const r = await http("POST", "/mcp", { tok: await token("I0113", { aud }), body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
      expect(r.status).toBe(401);
      expect(r.headers["www-authenticate"]).toContain('error="invalid_token"');
    }
  });
});

describe("tools/list per principal (073 AC4 smoke)", () => {
  it("non-member: authenticated, empty list, structured not_in_group reason", async () => {
    const { rpc } = setup();
    const r = await rpc(await token("I0999"), "tools/list");
    expect(r.result.tools).toEqual([]);
    expect(r.result._meta.reason).toMatchObject({ code: "not_in_group", group: "mcp-authors" });
  });
  it("the token's own groups claim grants nothing; only the S3 groups config does", async () => {
    const { rpc } = setup();
    expect(names(await rpc(await token("I0999", { extra: { groups: ["mcp-authors", "hfy-admin", "admins"] } }), "tools/list"))).toEqual([]);
  });
  it("member: read + draft-create tools, deletes absent", async () => {
    const { rpc } = setup();
    expect(names(await rpc(await token("I0044"), "tools/list"))).toEqual(["hfy_comments_create", "hfy_comments_list", "hfy_posts_create", "hfy_posts_get", "hfy_posts_list"]);
  });
  it("member by allowlisted email (verified) is an author", async () => {
    const groups = createGroupResolver({ load: async () => GROUPS });
    expect(await groups({ sub: "I0500", email: "cousin@example.test" })).toEqual(["mcp-authors"]);
    expect(await groups({ sub: "I0500", email: "cousin@example.test", emailVerified: false })).toEqual([]);
    expect(await createGroupResolver({ load: async () => GROUPS, emailsFor: async () => ["COUSIN@example.test"] })({ sub: "I0501" })).toEqual(["mcp-authors"]);
  });
  it("hfy-admin is exactly I0113: delete tools are listed but disabled without a fresh step-up, enabled with one", async () => {
    const { rpc } = setup();
    const stale = (await rpc(await token("I0113"), "tools/list")).result.tools;
    expect(stale).toHaveLength(7);
    expect(stale.filter((t) => t.disabled).map((t) => [t.name, t.reason.code]).sort()).toEqual([["hfy_comments_delete", "step_up_required"], ["hfy_posts_delete", "step_up_required"]]);
    const fresh = (await rpc(await token("I0113", { amr: ["passkey"], authTime: nowS() - 30 }), "tools/list")).result.tools;
    expect(fresh.filter((t) => t.disabled)).toEqual([]);
    const old = (await rpc(await token("I0113", { amr: ["passkey"], authTime: nowS() - 900 }), "tools/list")).result.tools;
    expect(old.filter((t) => t.disabled)).toHaveLength(2);
    const pwdOnly = (await rpc(await token("I0113", { amr: ["pwd"], authTime: nowS() }), "tools/list")).result.tools;
    expect(pwdOnly.filter((t) => t.disabled)).toHaveLength(2);
  });
  it("fails closed when the groups config is unreadable", async () => {
    const api = makeApi();
    const mount = createMcpMount({ config: { resourceUrl: RESOURCE, audience: RESOURCE, issuer: ISS, jwksUri: `${ISS}/jwks`, clientIds: ["mcp-harrisonfamily"], scopes: ["openid"] }, invoke: api.handler.invoke, resolveGroups: createGroupResolver({ load: async () => { throw new Error("s3 down"); }, log: { error() {} } }), fetch: async () => ({ ok: true, json: async () => jwks }), log: { info() {}, error() {} } });
    const r = await mount.handle({ rawPath: "/mcp", headers: { authorization: `Bearer ${await token("I0113")}`, "content-type": "application/json" }, requestContext: { http: { method: "POST" } }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(JSON.parse(r.body).result.tools).toEqual([]);
  });
});

describe("tools run the API's own route handlers", () => {
  it("create post is always a draft; the member lists and reads it; a member cannot see or call delete", async () => {
    const { rpc } = setup();
    const t = await token("I0044");
    const made = await rpc(t, "tools/call", { name: "hfy_posts_create", arguments: { title: "Hello", body: "From Claude", visibility: "published" } });
    expect(made.result.isError).toBeUndefined();
    expect(made.result.structuredContent).toMatchObject({ visibility: "draft", title: "Hello", author: { id: "I0044" } });
    const id = made.result.structuredContent.id;
    expect((await rpc(t, "tools/call", { name: "hfy_posts_get", arguments: { id } })).result.structuredContent.id).toBe(id);
    expect((await rpc(t, "tools/call", { name: "hfy_posts_list", arguments: { visibility: "draft" } })).result.structuredContent.items.map((p) => p.id)).toContain(id);
    const del = await rpc(t, "tools/call", { name: "hfy_posts_delete", arguments: { id } });
    expect(del.error.code).toBe(-32602);
  });
  it("comments create/list on a person subject", async () => {
    const { rpc } = setup();
    const t = await token("I0044");
    const c = await rpc(t, "tools/call", { name: "hfy_comments_create", arguments: { subject: "person:I0113", body: "hi" } });
    expect(c.result.structuredContent).toMatchObject({ body: "hi" });
    expect(JSON.stringify((await rpc(t, "tools/call", { name: "hfy_comments_list", arguments: { subject: "person:I0113" } })).result.structuredContent)).toContain('"body":"hi"');
  });
  it("dry_run returns a ResolvedCall v1 and writes nothing", async () => {
    const { rpc, api } = setup();
    const t = await token("I0044");
    const r = await rpc(t, "tools/call", { name: "hfy_posts_create", arguments: { body: "x", mode: "dry_run" } });
    expect(r.result.structuredContent).toMatchObject({ version: "1", kind: "resolved_call", mode: "dry_run", wouldExecute: true });
    expect((await rpc(t, "tools/call", { name: "hfy_posts_list", arguments: {} })).result.structuredContent.items).toEqual([]);
    expect(api.ddb).toBeTruthy();
  });
  it("delete needs hfy-admin AND a fresh step-up; with both it deletes any post", async () => {
    const { rpc } = setup();
    const author = await token("I0044");
    const id = (await rpc(author, "tools/call", { name: "hfy_posts_create", arguments: { body: "to delete" } })).result.structuredContent.id;
    const stale = await rpc(await token("I0113", { amr: ["pwd"], authTime: nowS() }), "tools/call", { name: "hfy_posts_delete", arguments: { id } });
    expect(stale.result).toMatchObject({ isError: true, structuredContent: { reason: { code: "step_up_required" } } });
    const fresh = await rpc(await token("I0113", { amr: ["mfa"], authTime: nowS() }), "tools/call", { name: "hfy_posts_delete", arguments: { id } });
    expect(fresh.result.isError).toBeUndefined();
    expect((await rpc(author, "tools/call", { name: "hfy_posts_get", arguments: { id } })).result.isError).toBe(true);
  });
});

describe("policy and registry", () => {
  it("has the *.delete row for hfy-admin with step_up, and every tool maps to a caps action", () => {
    expect(POLICY_ROWS).toContainEqual(expect.objectContaining({ action: "*.delete", execute: ["hfy-admin"], minAssurance: "step_up" }));
    const caps = buildCaps();
    for (const t of caps.mcp.tools) expect(caps.actions.map((a) => a.name)).toContain(t.action);
    expect(caps.mcp.resource).toBe(RESOURCE);
  });
  it("groups config shape: admin subjects only, empty authors allowed", () => {
    const c = parseGroupsConfig({ groups: { "mcp-authors": { emails: [] }, "hfy-admin": { subjects: ["I0113"], emails: ["a@b.test"] } } });
    expect([c.authors.emails.size, c.authors.subjects.size, [...c.admins]]).toEqual([0, 0, ["I0113"]]);
    expect(parseGroupsConfig("garbage").admins.size).toBe(0);
  });
});
