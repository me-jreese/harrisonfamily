// Lambda@Edge entry (viewer-request). Lambda@Edge has no environment variables, so the issuer, audience and JWKS URL are
// baked in at build time from edge-gate/gate.config.json (scripts/ci/package-edge-gate.sh copies it next to this file).
import config from "./config.json" with { type: "json" };
import { createGate } from "./gate.mjs";

export const handler = createGate(config).handler;
