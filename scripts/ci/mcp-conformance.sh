#!/usr/bin/env bash
# MCP gate (HFY-TSK-077/073): MCP-C01..C12 against this implementation, the mounted-server tests, and `parity diff --mcp-tools` (tools/list == caps).
# Needs CODEARTIFACT_AUTH_TOKEN for @io-kit/*. Usage: scripts/ci/mcp-conformance.sh [report-only|blocking]   (default blocking)
set -euo pipefail
MODE=${1:-blocking}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT/api"
: "${CODEARTIFACT_AUTH_TOKEN:?set CODEARTIFACT_AUTH_TOKEN (aws codeartifact get-authorization-token --domain io)}"
[ -d node_modules ] || npm ci --ignore-scripts --no-audit --no-fund >/dev/null
node scripts/gen-caps.mjs >/dev/null
npx vitest run test/mcp-conformance.test.js test/mcp.test.js test/mcp-infra.test.js
npx io-kit parity diff --mode "$MODE" --stack hfy --caps dist/mcp/parity-caps.json --routes parity/routes.yaml --mapping parity/map.yaml --mcp-tools dist/mcp/tools.json
