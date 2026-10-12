// HFY-TSK-077: the MCP server (HFY-R59: https://harrisonfamily.us/mcp, a path on the main host). Mounted in the SAME Lambda as the API so the tools
// reuse the route registry: @io-kit/mcp/edge gates the bearer (RS256 via the auth edge JWKS, pinned iss, client binding) and serves the PRM;
// @io-kit/mcp/core serves tools/list and tools/call over a registry derived from ROUTES, evaluated against src/policy.js.
import { createEdge, lambdaAdapter, buildWwwAuthenticate } from "@io-kit/mcp/edge";
import { createMcpServer } from "@io-kit/mcp/core";
import { ROUTES, MCP_RESOURCE } from "./routes.js";
import { ADMIN_GROUP, POLICY, STEP_UP_MAX_AGE_SECONDS, STRONG_AMR } from "./policy.js";

export const MCP_PATH = "/mcp";
const PRM_PREFIX = "/.well-known/oauth-protected-resource";
/** Paths CloudFront sends to this mount: /mcp*, /.well-known/oauth-protected-resource* (scripts/infra/add-mcp-behavior.sh). */
export const isMcpPath = (p) => p === MCP_PATH || p.startsWith(`${MCP_PATH}/`) || p === PRM_PREFIX || p.startsWith(`${PRM_PREFIX}/`);

export function loadMcpConfig(env = process.env) {
  const issuer = env.MCP_TOKEN_ISSUER ?? env.SESSION_ISSUER ?? "https://harrisonfamily.us/auth";
  return {
    resourceUrl: env.MCP_RESOURCE_URL ?? MCP_RESOURCE,
    audience: env.MCP_AUDIENCE ?? env.MCP_RESOURCE_URL ?? MCP_RESOURCE, // RFC 8707: the access token's aud must be this resource
    issuer,
    jwksUri: env.SESSION_JWKS_URL ?? `${issuer}/.well-known/jwks.json`,
    clientIds: (env.MCP_CLIENT_IDS ?? "mcp-harrisonfamily").split(",").map((s) => s.trim()).filter(Boolean),
    scopes: (env.MCP_SCOPES ?? "openid email profile").split(/[ ,]+/).filter(Boolean),
  };
}

/**
 * The edge exactly as deployed. The Function URL is already behind the X-Origin-Verify check in index.js (HFY-R43), so the edge does not repeat it.
 * Optional cfg members (endpoints, asIssuer, registrationFacade, cors, realm) exist so the packaged conformance corpus can drive THIS factory.
 */
export function createMcpEdge(cfg, extra = {}) {
  const ep = cfg.endpoints ?? {};
  return createEdge({
    resourceUrl: cfg.resourceUrl,
    as: {
      issuer: cfg.asIssuer ?? cfg.issuer,
      authorizationEndpoint: ep.authorization ?? `${cfg.issuer}/authorize`, tokenEndpoint: ep.token ?? `${cfg.issuer}/token`,
      revocationEndpoint: ep.revocation ?? `${cfg.issuer}/revoke`, ...(ep.userinfo ? { userinfoEndpoint: ep.userinfo } : {}), jwksUri: cfg.jwksUri,
    },
    tokenIssuer: cfg.issuer,
    clientIds: cfg.clientIds,
    scopes: cfg.scopes,
    ...(cfg.realm ? { realm: cfg.realm } : {}),
    ...(cfg.registrationFacade ? { registrationFacade: cfg.registrationFacade } : {}),
    ...(cfg.cors ? { cors: cfg.cors } : {}),
    ...extra,
  });
}

const tokenName = (r) => r.mcp.tool;
const annotations = (r) => ({ readOnly: !r.write, destructive: r.method === "DELETE", idempotent: r.method !== "POST" });

/** Handlers derived from the route registry: one per route with an `mcp` member. `invoke(principal, routeName, parts)` runs the route's own handler. */
export function buildMcpRegistry(invoke) {
  return ROUTES.filter((r) => r.mcp).map((r) => ({
    name: tokenName(r), description: r.mcp.description, inputSchema: r.mcp.input, annotations: annotations(r), action: r.name,
    run: async (args, ctx) => {
      const out = await invoke(ctx.principal, r.name, r.mcp.args(args));
      return out.body === undefined ? { ok: true, action: r.name } : out.body;
    },
  }));
}

/** The one place the host's policy/step-up settings meet the core. Conformance (MCP-C10..C12) builds servers through this too. */
export function createMcpCore({ registry, policy = POLICY, now, logger }) {
  return createMcpServer({ registry, policy, assurance: { stepUpMaxAgeSeconds: STEP_UP_MAX_AGE_SECONDS, strongAmr: STRONG_AMR }, logger, ...(now ? { now } : {}), serverInfo: { name: "hfy-mcp", version: "0.1.0" } });
}

/**
 * The member's display label from the VERIFIED access token: the auth edge mints the io_id session label as `name` (preserved on refresh).
 * Only `name` counts: never the `email` claim (it would publish an address as a comment/post author), and no claim means the sub (gramps_id).
 */
export const tokenLabel = (claims) => {
  const n = typeof claims?.name === "string" ? claims.name.trim() : "";
  return n === "" ? undefined : n;
};
/** The API actor an MCP call runs as: the same {id, label, admin} shape the HTTP path builds from the io_id session (src/auth.js). */
export const actorFor = (principal) => ({ id: principal.sub, label: principal.label ?? principal.sub, admin: principal.groups.includes(ADMIN_GROUP) });
const audOk = (aud, want) => (Array.isArray(aud) ? aud.includes(want) : aud === want);

export function createMcpMount({ config = loadMcpConfig(), invoke, resolveGroups, log = console, now, fetch }) {
  const edge = createMcpEdge(config, { logger: { info: (m, f) => log.info?.(m, f) }, ...(now ? { now } : {}), ...(fetch ? { fetch } : {}) });
  const registry = buildMcpRegistry((principal, name, parts) => invoke(actorFor(principal), name, parts));
  const server = createMcpCore({
    registry, now,
    logger: { audit: (r) => log.info?.("mcp.audit", { ...r, principal: { type: r.principal.type, sub: r.principal.sub, groups: r.principal.groups } }), error: (m, d) => log.error?.(m, d instanceof Error ? d.message : d) },
  });
  const wwwAuth = () => buildWwwAuthenticate({ realm: new URL(config.resourceUrl).host, resourceMetadata: `${edge.origin}${PRM_PREFIX}`, scope: config.scopes.join(" "), error: "invalid_token", description: "token not issued for this resource" });
  const downstream = async (req, pass) => {
    if (!audOk(pass.claims.aud, config.audience)) {
      return new Response(JSON.stringify({ error: "invalid_token", error_description: "token not issued for this resource" }), { status: 401, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "www-authenticate": wwwAuth() } });
    }
    const c = pass.claims;
    // Authorization comes from the S3 groups config, never from the token's own groups claim.
    const groups = await resolveGroups({ sub: pass.principal.sub, email: typeof c.email === "string" ? c.email : undefined, emailVerified: c.email_verified });
    const label = tokenLabel(c);
    return server.fetch(req, { ...pass.principal, groups, ...(label ? { label } : {}) });
  };
  return { handle: lambdaAdapter(edge, downstream), edge, server, registry, config };
}
