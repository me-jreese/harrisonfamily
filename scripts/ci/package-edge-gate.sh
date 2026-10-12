#!/usr/bin/env bash
# Builds dist/hfy-edge-gate.zip (Lambda@Edge hfy-edge-gate, handler index.handler, Node 22). The function has no dependencies, so no npm install.
# edge-gate/gate.config.json (issuer, audience, JWKS URL) is baked into the zip as config.json: Lambda@Edge has no environment variables.
# Prints the SHA-256 (base64, the form Lambda reports as CodeSha256) for the CodeSha256 parameter of infrastructure/cloudformation/edge-gate-stack.yaml.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
cp "$ROOT/edge-gate/src/index.mjs" "$ROOT/edge-gate/src/gate.mjs" "$STAGE/"
cp "$ROOT/edge-gate/gate.config.json" "$STAGE/config.json"
node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));for(const k of ["issuer","audience","jwksUrl"])if(!c[k])throw new Error("gate.config.json lacks "+k)' "$STAGE/config.json"
mkdir -p "$ROOT/dist" && rm -f "$ROOT/dist/hfy-edge-gate.zip"
( cd "$STAGE" && TZ=UTC touch -t 202001010000 index.mjs gate.mjs config.json && zip -qr -X "$ROOT/dist/hfy-edge-gate.zip" index.mjs gate.mjs config.json )
SIZE=$(wc -c < "$ROOT/dist/hfy-edge-gate.zip" | tr -d ' ')
[ "$SIZE" -lt 1048576 ] || { echo "zip is $SIZE bytes; Lambda@Edge viewer triggers allow 1 MB" >&2; exit 1; }
echo "built $ROOT/dist/hfy-edge-gate.zip ($SIZE bytes)"
echo "CodeSha256=$(openssl dgst -sha256 -binary "$ROOT/dist/hfy-edge-gate.zip" | openssl base64 -A)"
