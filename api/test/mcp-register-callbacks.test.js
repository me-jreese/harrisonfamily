// @io-kit/mcp 0.1.4: where the kit edge's registrationFacade is enabled, /register refuses any redirect_uri off the callback list.
// Production (src/index.js -> createMcpMount) does NOT enable the facade: /auth/register is served by the auth edge, so this guards the factory only.
import { describe, expect, it } from "vitest";
import { lambdaAdapter } from "@io-kit/mcp/edge";
import { createMcpEdge } from "../src/mcp.js";

const cfg = { resourceUrl: "https://example.test/mcp", issuer: "https://auth.example.test", jwksUri: "https://auth.example.test/jwks", clientIds: ["c1"], scopes: ["openid"] };
const echo = async () => Response.json({ ok: true });
const post = (run, uris) => run({ version: "2.0", rawPath: "/register", rawQueryString: "", requestContext: { http: { method: "POST", path: "/register" } }, headers: { "content-type": "application/json", host: "example.test" }, body: JSON.stringify({ redirect_uris: uris }), isBase64Encoded: false });

describe("kit /register callback list (facade enabled)", () => {
  it("refuses https://example.invalid/cb with 400 invalid_redirect_uri", async () => {
    const run = lambdaAdapter(createMcpEdge({ ...cfg, registrationFacade: { clientId: "c1" } }), echo);
    const r = await post(run, ["https://example.invalid/cb"]);
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error).toBe("invalid_redirect_uri");
  });
});
