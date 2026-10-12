#!/usr/bin/env bash
# Builds dist/hfy-auth-edge.zip (Lambda hfy-auth-edge, handler src/index.handler). Needs CODEARTIFACT_AUTH_TOKEN for @io-kit/* packages.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
: "${CODEARTIFACT_AUTH_TOKEN:?set CODEARTIFACT_AUTH_TOKEN (aws codeartifact get-authorization-token --domain io)}"
STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
cp -R "$ROOT/auth/src" "$ROOT/auth/edge.manifest.json" "$ROOT/auth/package.json" "$ROOT/auth/package-lock.json" "$ROOT/auth/.npmrc" "$STAGE/"
( cd "$STAGE" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null && rm -f .npmrc package-lock.json )
mkdir -p "$ROOT/dist" && rm -f "$ROOT/dist/hfy-auth-edge.zip"
( cd "$STAGE" && zip -qr -X "$ROOT/dist/hfy-auth-edge.zip" . )
echo "built $ROOT/dist/hfy-auth-edge.zip ($(du -h "$ROOT/dist/hfy-auth-edge.zip" | cut -f1))"
