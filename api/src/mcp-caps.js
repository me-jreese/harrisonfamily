// Build-time views of the MCP surface, derived from the same registry the server mounts (no AWS, no network).
import { buildMcpRegistry, createMcpCore } from "./mcp.js";
import { ADMIN_GROUP, AUTHORS_GROUP } from "./policy.js";

const NOW = 1_900_000_000;
export const fullPrivilege = { type: "human", sub: "build", groups: [AUTHORS_GROUP, ADMIN_GROUP], authTime: NOW, amr: ["mfa"] };

/** tools/list exactly as the server returns it for a principal with every group and a fresh step-up. */
export function mcpToolsList(principal = fullPrivilege) {
  const server = createMcpCore({ registry: buildMcpRegistry(async () => ({ body: {} })), now: () => NOW, logger: { audit() {} } });
  return server.handle({ method: "POST", path: "/mcp", body: { jsonrpc: "2.0", id: 1, method: "tools/list" } }, principal).then((r) => r.body.result);
}

/** @io-kit/parity caps.json (schema 1.1.0): one action per tool, named exactly like the tool (L-01 extended). */
export async function mcpParityCaps() {
  const { tools } = await mcpToolsList();
  return {
    schemaVersion: "1.1.0", surface: "hfy-mcp", generatedAt: "2026-10-12T00:00:00Z",
    actions: tools.map((t) => ({ name: t.name, title: t.description.split(".")[0], inputSchema: t.inputSchema, outputSchema: null, annotations: t.annotations, requiresGovernanceHash: false, via: "top-level", dryRun: !t.annotations.readOnlyHint })),
  };
}
