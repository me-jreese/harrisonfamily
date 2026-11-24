// HFY-TSK-413: this deployment's own @io-kit/mcp fleet registry. @io-kit/mcp 0.3.0 ships none (ENC-ISS-919), so the connector name
// `harrisonfamily` resolves through this: only this site's profile and connector. The values are the harrisonfamily entries of the
// fleet manifest (io-kit packages/mcp/fleet/fleet.yaml); the sign-in service is the site's own auth edge, not a shared one.
// A test pins them to the code defaults (MCP_RESOURCE, the session issuer and JWKS, MCP_CLIENT_IDS) so a rename cannot drift one side.
import { setFleet } from "@io-kit/mcp/edge";

export const CONNECTOR = "harrisonfamily";

export const FLEET = Object.freeze({
  profiles: {
    harrisonfamily: {
      provider: "auth-edge",
      claim: "cognito",
      sign_in_service: "https://harrisonfamily.us/auth",
      issuer: "https://harrisonfamily.us/auth",
      jwks_uri: "https://harrisonfamily.us/auth/.well-known/jwks.json",
    },
  },
  connectors: [
    { name: CONNECTOR, runtime: "ts", url: "https://harrisonfamily.us", mount: "/mcp", profile: "harrisonfamily", client_ids: ["mcp-harrisonfamily"] },
  ],
});

/** Hands the registry to the kit (idempotent). Call before createEdge({ connector }). */
export function installFleet() {
  setFleet(structuredClone(FLEET));
}
