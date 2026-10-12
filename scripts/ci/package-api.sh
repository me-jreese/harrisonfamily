#!/usr/bin/env bash
# Builds dist/hfy-api.zip (Lambda hfy-api, handler src/index.handler). Needs CODEARTIFACT_AUTH_TOKEN for @io-kit/* packages.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
: "${CODEARTIFACT_AUTH_TOKEN:?set CODEARTIFACT_AUTH_TOKEN (aws codeartifact get-authorization-token --domain io)}"
STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
( cd "$ROOT/api" && node scripts/gen-caps.mjs >/dev/null )
cp -R "$ROOT/api/src" "$ROOT/api/package.json" "$ROOT/api/package-lock.json" "$ROOT/api/.npmrc" "$STAGE/"
( cd "$STAGE" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null && rm -f .npmrc package-lock.json )
mkdir -p "$STAGE/dist" && cp "$ROOT/api/dist/caps.json" "$STAGE/dist/caps.json"
mkdir -p "$ROOT/dist" && rm -f "$ROOT/dist/hfy-api.zip"
( cd "$STAGE" && zip -qr -X "$ROOT/dist/hfy-api.zip" . )
echo "built $ROOT/dist/hfy-api.zip ($(du -h "$ROOT/dist/hfy-api.zip" | cut -f1))"
