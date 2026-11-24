// HFY-TSK-413: the MCP edge's settings and factory, split from mcp.js so they depend only on the kit edge and this deployment's fleet registry.
import { createEdge, resolveConnector } from "@io-kit/mcp/edge";
import { CONNECTOR, installFleet } from "./fleet.js";

/** The identity variables that, when set to something other than the fleet registry's values, take the edge out of manifest form (see loadMcpConfig). */
const IDENTITY_ENV = ["MCP_RESOURCE_URL", "MCP_TOKEN_ISSUER", "MCP_CLIENT_IDS"];

/**
 * HFY-TSK-413: in manifest form (`connector` set) the kit edge takes its resource, issuer, JWKS, client ids and sign-in service from this
 * deployment's registry (src/fleet.js) and sends `x-io-kit-mcp`. A deployment that overrides an identity setting away from the registry
 * (the MCP_* variables, or a SESSION_ISSUER / SESSION_JWKS_URL that differs) keeps the explicit form, with every field spelled out.
 */
export function loadMcpConfig(env = process.env) {
  installFleet();
  const reg = resolveConnector(CONNECTOR);
  const issuer = env.MCP_TOKEN_ISSUER ?? env.SESSION_ISSUER ?? reg.issuer;
  const jwksUri = env.SESSION_JWKS_URL ?? (env.MCP_TOKEN_ISSUER || env.SESSION_ISSUER ? `${issuer}/.well-known/jwks.json` : reg.jwksUri);
  const clientIds = (env.MCP_CLIENT_IDS ?? reg.clientIds.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
  const resourceUrl = env.MCP_RESOURCE_URL ?? reg.resourceUrl;
  const same = !IDENTITY_ENV.some((k) => env[k] !== undefined) && issuer === reg.issuer && jwksUri === reg.jwksUri;
  return {
    ...(same ? { connector: CONNECTOR } : {}),
    resourceUrl,
    audience: env.MCP_AUDIENCE ?? env.MCP_RESOURCE_URL ?? reg.resourceUrl, // RFC 8707: the access token's aud must be this resource
    issuer,
    jwksUri,
    clientIds,
    scopes: (env.MCP_SCOPES ?? "openid email profile").split(/[ ,]+/).filter(Boolean),
  };
}

/**
 * The edge exactly as deployed. The Function URL is already behind the X-Origin-Verify check in index.js (HFY-R43), so the edge does not repeat it.
 * Manifest form: `cfg.connector` names this deployment's registry entry (src/fleet.js). Explicit form (tests, overridden deployments): the kit 0.3
 * options `{ resourceUrl, signInService, tokenIssuer, jwksUri, clientIds }`; the sign-in service is the issuer, because the auth edge is both.
 * The kit edge no longer serves authorization-server metadata, registration or an authorize redirect (those are the auth edge's, auth/src/oauth.js).
 */
export function createMcpEdge(cfg, extra = {}) {
  const common = { scopes: cfg.scopes, ...(cfg.realm ? { realm: cfg.realm } : {}), ...(cfg.cors ? { cors: cfg.cors } : {}), ...extra };
  if (cfg.connector) {
    installFleet();
    return createEdge({ connector: cfg.connector, ...common });
  }
  return createEdge({
    resourceUrl: cfg.resourceUrl, signInService: cfg.signInService ?? cfg.issuer, tokenIssuer: cfg.issuer, jwksUri: cfg.jwksUri, clientIds: cfg.clientIds, ...common,
  });
}
