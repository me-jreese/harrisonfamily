// HFY-TSK-077: the MCP server (HFY-R59: https://harrisonfamily.us/mcp, a path on the main host). Mounted in the SAME Lambda as the API so the tools
// reuse the route registry: @io-kit/mcp/edge gates the bearer (RS256 via the auth edge JWKS, pinned iss, client binding) and serves the PRM;
// @io-kit/mcp/core serves tools/list and tools/call over a registry derived from ROUTES, evaluated against src/policy.js.
import { createEdge, lambdaAdapter, buildWwwAuthenticate } from "@io-kit/mcp/edge";
import { createMcpServer } from "@io-kit/mcp/core";
import { ROUTES, MCP_RESOURCE } from "./routes.js";
import { ADMIN_GROUP, POLICY, STEP_UP_MAX_AGE_SECONDS, STRONG_AMR } from "./policy.js";
import { HttpError, logSafeError } from "./http.js";
import { cleanLabel, fallbackLabel, ownLabelOnly } from "./labels.js";

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

/** A handler answers {status, body} or, for the routes that build their own reply with json(), {statusCode, body: "<json text>"}; a tool returns the body object either way. */
const bodyOf = (out, name) => {
  const body = typeof out.body === "string" && out.statusCode !== undefined ? (out.body === "" ? undefined : JSON.parse(out.body)) : out.body;
  return body === undefined ? { ok: true, action: name } : body;
};

/** Handlers derived from the route registry: one per route with an `mcp` member. `invoke(principal, routeName, parts)` runs the route's own handler. */
export function buildMcpRegistry(invoke) {
  return ROUTES.filter((r) => r.mcp).map((r) => ({
    name: tokenName(r), description: r.mcp.description, inputSchema: r.mcp.input, annotations: annotations(r), action: r.name,
    run: async (args, ctx) => {
      const out = await invoke(ctx.principal, r.name, r.mcp.args(args)).catch((e) => { throw r.mcp.problem ? problemError(e) : e; });
      return bodyOf(out, r.name);
    },
    ...(r.mcp.preview ? { preview: async (args, principal) => bodyOf(await invoke(principal, r.name, r.mcp.preview(args)), r.name) } : {}),
  }));
}

/**
 * A tool whose route sets `mcp.problem` hands its HttpError back as the tool error text: JSON {status, error, message, errors?, details?}, the same
 * redacted body the HTTP route sends (positions and codes, never the matched text), so a 422 from the privacy guard reads as a 422 over MCP too.
 */
const problemError = (e) => (e instanceof HttpError
  ? new HttpError(e.status, e.code, JSON.stringify({ status: e.status, error: e.code, message: e.message, ...(Array.isArray(e.errors) ? { errors: e.errors } : {}), ...(e.details && typeof e.details === "object" ? { details: e.details } : {}) }))
  : e);

/**
 * The agent dry run with a real plan. The kit core answers a mutating tool call in dry_run mode with a ResolvedCall and never runs the handler. For a tool
 * with a `preview` (hfy_changes_submit), when that ResolvedCall is an allowed dry run the route's own dry_run plan is attached as `plan`, or the
 * problem as `planError`. The plan path writes nothing (changes.js: dry_run stops after planning, before any receipt, PROP# or IDX# row).
 */
export function withPlanPreview(server, registry) {
  const previews = new Map(registry.filter((h) => h.preview).map((h) => [h.name, h]));
  const attach = async (request, principal, res) => {
    let msg;
    try { msg = JSON.parse(await request.text()); } catch { return res; }
    const h = msg?.method === "tools/call" ? previews.get(msg.params?.name) : undefined;
    const sc = res?.result?.structuredContent;
    if (!h || sc?.kind !== "resolved_call" || sc.mode !== "dry_run" || sc.decision?.effect !== "allow") return res;
    const { mode: _m, ...args } = msg.params.arguments ?? {};
    let extra;
    try {
      const out = await h.preview(args, principal);
      extra = { plan: out.plan, warnings: out.warnings, errors: out.errors };
    } catch (e) {
      extra = { planError: e instanceof HttpError ? { status: e.status, error: e.code, message: e.message, ...(Array.isArray(e.errors) ? { errors: e.errors } : {}) } : { status: 500, error: "internal" } };
    }
    const structuredContent = { ...sc, ...extra };
    return { ...res, result: { ...res.result, content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent } };
  };
  return {
    ...server,
    fetch: async (request, principal) => {
      const res = await server.fetch(request.clone(), principal);
      if (res.status !== 200 || previews.size === 0) return res;
      const out = await attach(request, principal, await res.clone().json());
      return new Response(JSON.stringify(out), { status: 200, headers: res.headers });
    },
  };
}

/** The one place the host's policy/step-up settings meet the core. Conformance (MCP-C10..C12) builds servers through this too. */
export function createMcpCore({ registry, policy = POLICY, now, logger }) {
  return createMcpServer({ registry, policy, assurance: { stepUpMaxAgeSeconds: STEP_UP_MAX_AGE_SECONDS, strongAmr: STRONG_AMR }, logger, ...(now ? { now } : {}), serverInfo: { name: "hfy-mcp", version: "0.1.0" } });
}

/**
 * The member's display label from the VERIFIED access token: the auth edge mints the io_id session label as `name` (preserved on refresh).
 * Only `name` counts, and only when it is a usable non-email label (src/labels.js): never the `email` claim (it would publish an address as
 * a comment/post author). No usable claim = undefined, and actorFor then looks the person up (HFY-R68).
 */
export const tokenLabel = (claims) => cleanLabel(claims?.name);
/**
 * The API actor an MCP call runs as: the same {id, label, admin} shape the HTTP path builds from the io_id session (src/auth.js).
 * label = the token's name when usable (principal.label, set from tokenLabel), else `resolveLabel` (the person's displayName from
 * the site's own record), else the sub. Never an email, never throws.
 */
export const actorFor = async (principal, resolveLabel = ownLabelOnly) => {
  let label;
  try {
    label = await resolveLabel({ sub: principal.sub, name: principal.label });
  } catch {
    label = undefined;
  }
  return { id: principal.sub, label: cleanLabel(label) ?? fallbackLabel(principal.sub), admin: principal.groups.includes(ADMIN_GROUP) };
};
const audOk = (aud, want) => (Array.isArray(aud) ? aud.includes(want) : aud === want);

export function createMcpMount({ config = loadMcpConfig(), invoke, resolveGroups, resolveLabel = ownLabelOnly, log = console, now, fetch }) {
  const edge = createMcpEdge(config, { logger: { info: (m, f) => log.info?.(m, f) }, ...(now ? { now } : {}), ...(fetch ? { fetch } : {}) });
  // The label is resolved when a tool actually runs (not on initialize / tools/list), so a person-record fetch happens at most once per member per hour.
  const registry = buildMcpRegistry(async (principal, name, parts) => invoke(await actorFor(principal, resolveLabel), name, parts));
  const server = withPlanPreview(createMcpCore({
    registry, now,
    logger: { audit: (r) => log.info?.("mcp.audit", { ...r, principal: { type: r.principal.type, sub: r.principal.sub, groups: r.principal.groups } }), error: (m, d) => log.error?.(m, logSafeError(d)) },
  }), registry);
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
