// HFY-TSK-413: the fleet registry (src/fleet.js) and the code defaults it must agree with. A rename on one side fails here.
import { describe, expect, it } from "vitest";
import { MCP_RESOURCE } from "../src/routes.js";
import { FLEET } from "../src/fleet.js";
import { loadMcpConfig } from "../src/mcp.js";

describe("fleet registry matches the code defaults", () => {
  const c = FLEET.connectors[0];
  it("resource: url + mount is the MCP resource the routes and the auth edge use", () => {
    expect(`${c.url}${c.mount}`).toBe(MCP_RESOURCE);
    expect(loadMcpConfig({}).audience).toBe(MCP_RESOURCE);
  });
  it("client id: the auth edge's default MCP client", async () => {
    const { DEFAULT_CLIENT_ID, DEFAULT_MCP_RESOURCE } = await import("../../auth/src/oauth.js");
    expect(c.client_ids).toEqual([DEFAULT_CLIENT_ID]);
    expect(DEFAULT_MCP_RESOURCE).toBe(MCP_RESOURCE);
  });
});
