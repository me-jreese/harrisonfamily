#!/usr/bin/env node
// Generates, from the route registry (AC2): dist/caps.json (the API capability document), dist/policy.json (the permission table the UI reads, M-09),
// dist/mcp/tools.json (a tools/list for a fully-privileged principal) and dist/mcp/parity-caps.json (the @io-kit/parity caps.json for the MCP surface).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCaps } from "../src/routes.js";
import { policyDocument } from "../src/policy.js";
import { mcpToolsList, mcpParityCaps } from "../src/mcp-caps.js";

const dist = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const put = (rel, doc) => {
  const out = resolve(dist, rel);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`wrote ${out}`);
};
put("caps.json", buildCaps());
put("policy.json", policyDocument());
put("mcp/tools.json", await mcpToolsList());
put("mcp/parity-caps.json", await mcpParityCaps());
