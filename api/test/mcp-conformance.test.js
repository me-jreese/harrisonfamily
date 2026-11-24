// HFY-TSK-077 proof: the packaged @io-kit/mcp corpus (MCP-C01..C12) run against THIS repo's implementation.
// Edge layer (C01..C09, C13, C16, C18): the production factory createMcpEdge() behind the Lambda adapter, JWKS served from the corpus's TEST-ONLY keys.
// Core layer (C10..C12): the production createMcpCore() (host assurance/policy settings) over the corpus registry. No expectations are written here (W0.1).
import { describe, expect, it } from "vitest";
import { CLAUDE_ORIGINS, loadCorpus, resolveRefs, runConformance } from "@io-kit/mcp";
import { lambdaAdapter } from "@io-kit/mcp/edge";
import { createMcpCore, createMcpEdge } from "../src/mcp.js";

const echo = async (_req, pass) => Response.json({ ok: true, principal: { sub: pass.principal.sub } });

function impl() {
  let st = {};
  return {
    setup(ctx) {
      const { file, corpus, edge: cfg } = ctx;
      if (file.layer === "core") {
        const reg = corpus.registry;
        let invocations = 0;
        const s = { audit: undefined };
        const server = createMcpCore({
          registry: reg.handlers.map((h) => ({ ...h, run: () => { invocations += 1; return { ok: true }; } })),
          policy: { rows: reg.policy, defaultGroup: reg.mcpAuthorsGroup }, now: () => reg.clock, logger: { audit: (r) => { s.audit = r; } },
        });
        st = { core: true, server, s, count: () => invocations };
        return;
      }
      const fx = corpus.issuers.issuers.find((i) => i.id === cfg.issuer);
      const keys = { current: corpus.jwks[fx.id].initial };
      let offset = 0;
      const state = { fetches: 0, keys, fx, corpus };
      const now = () => Math.floor(Date.now() / 1000) + offset;
      const fetch = async () => { state.fetches += 1; return { ok: true, status: 200, json: async () => structuredClone(keys.current) }; };
      // Kit 0.3 mapping (same as @io-kit/mcp's own test/edge-impl.ts): the connector edge serves no authorization-server metadata,
      // registration or authorize redirect (those are the auth edge's), so the corpus config reduces to the explicit identity fields.
      const edge = createMcpEdge({
        resourceUrl: cfg.resource, issuer: fx.iss, signInService: cfg.baseUrl, jwksUri: fx.jwks_uri, clientIds: [fx.client_id], scopes: cfg.scopes, realm: cfg.realm,
        cors: { origins: CLAUDE_ORIGINS, tokenPaths: [cfg.tokenLegPath ?? "/oauth2/token"], revocationPaths: [cfg.revocationLegPath ?? "/oauth2/revoke"] },
      }, { fetch, now, tokenUseClaim: fx.token_use_claim, claimProfile: cfg.claimProfile ?? "cognito" });
      Object.assign(state, { run: lambdaAdapter(edge, echo), advance: (n) => { offset += n; } });
      st = state;
    },
    control(action) {
      if (action.action === "advance_clock") st.advance(action.seconds);
      if (action.action === "swap_jwks") st.keys.current = st.corpus.jwks[st.fx.id][action.to];
    },
    async handle(req, ctx) {
      if (st.core) {
        const ctxPrincipal = ctx.principal;
        const r = await st.server.handle({ method: req.method, path: req.path, headers: req.headers, body: req.body }, ctxPrincipal);
        return { status: r.status, headers: r.headers, body: r.body, counters: { handler_invocations: st.count() }, audit: st.s.audit };
      }
      // The corpus embeds refs inside header values ("Bearer $fixture:tokens.x.y"); resolveRefs only replaces whole strings, so expand them here.
      const sub = (v) => v.replace(/\$fixture:[A-Za-z0-9_.-]+/g, (m) => resolveRefs(m, ctx.corpus, ctx.edge));
      const headers = Object.fromEntries(Object.entries(req.headers ?? {}).map(([k, v]) => [k, sub(v)]));
      const res = await st.run({ rawPath: req.path, headers: { host: "abcd.lambda-url.us-west-2.on.aws", ...headers }, requestContext: { http: { method: req.method } }, body: req.body === undefined ? undefined : JSON.stringify(req.body) });
      let body = res.body;
      try { body = JSON.parse(res.body); } catch { /* not JSON */ }
      if (process.env.DEBUG_MCP && res.statusCode === 401) console.log('DBG', req.path, JSON.stringify(req.headers).slice(0, 120), JSON.stringify(body), res.headers['www-authenticate']);
      return { status: res.statusCode, headers: res.headers, body, counters: { jwks_fetches: st.fetches } };
    },
  };
}

describe("MCP-C01..C12 against the hfy implementation", () => {
  it("passes every step of every check", async () => {
    const results = await runConformance(impl(), loadCorpus());
    const byId = {};
    for (const r of results) (byId[r.file] ??= []).push(r);
    const summary = Object.entries(byId).map(([id, rs]) => `${id} ${rs.filter((r) => r.ok).length}/${rs.length}`).join("  ");
    console.log(`CONFORMANCE ${summary}`);
    // C01..C12 as before; kit 0.2+ adds C13 (no registration facade at the connector), C16 (x-io-kit-mcp) and C18 (401 challenge shape).
    const want = [...Array.from({ length: 12 }, (_, i) => i + 1), 13, 16, 18].map((n) => `MCP-C${String(n).padStart(2, "0")}`);
    expect(Object.keys(byId).sort()).toEqual(want);
    expect(results.filter((r) => !r.ok).map((r) => `${r.file} ${r.step}: ${r.failures.join("; ")}`)).toEqual([]);
  });
});
