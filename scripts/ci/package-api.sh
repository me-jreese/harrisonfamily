#!/usr/bin/env bash
# Builds dist/hfy-api.zip (Lambda hfy-api, handler src/index.handler). Needs CODEARTIFACT_AUTH_TOKEN for @io-kit/* packages.
# Works on a clean checkout: caps.json is generated inside the stage AFTER the locked `npm ci`, so it never depends on
# (or silently uses stale) api/node_modules.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
: "${CODEARTIFACT_AUTH_TOKEN:?set CODEARTIFACT_AUTH_TOKEN (aws codeartifact get-authorization-token --domain io)}"
STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
cp -R "$ROOT/api/src" "$ROOT/api/scripts" "$ROOT/api/package.json" "$ROOT/api/package-lock.json" "$ROOT/api/.npmrc" "$STAGE/"
( cd "$STAGE" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null && rm -f .npmrc package-lock.json )
# gen-caps imports src/routes.js (-> @io-kit/content, @io-kit/comments, @io-kit/notify: all runtime deps, now installed).
( cd "$STAGE" && node scripts/gen-caps.mjs >/dev/null && rm -rf scripts )
test -s "$STAGE/dist/caps.json" || { echo "package-api: dist/caps.json was not generated" >&2; exit 1; }
mkdir -p "$ROOT/api/dist" && cp "$STAGE/dist/caps.json" "$ROOT/api/dist/caps.json" # keep the local copy in step with the zip
mkdir -p "$ROOT/dist" && rm -f "$ROOT/dist/hfy-api.zip"
( cd "$STAGE" && zip -qr -X "$ROOT/dist/hfy-api.zip" . )
echo "built $ROOT/dist/hfy-api.zip ($(du -h "$ROOT/dist/hfy-api.zip" | cut -f1))"
