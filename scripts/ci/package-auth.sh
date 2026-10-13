#!/usr/bin/env bash
# Builds dist/hfy-auth-edge.zip (Lambda hfy-auth-edge, handler src/index.handler). Needs CODEARTIFACT_AUTH_TOKEN for @io-kit/* packages.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
: "${CODEARTIFACT_AUTH_TOKEN:?set CODEARTIFACT_AUTH_TOKEN (aws codeartifact get-authorization-token --domain io)}"
STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
cp -R "$ROOT/auth/src" "$ROOT/auth/edge.manifest.json" "$ROOT/auth/package.json" "$ROOT/auth/package-lock.json" "$ROOT/auth/.npmrc" "$STAGE/"
# src/shared is a committed symlink to ../../shared in the checkout; stage the real files instead (shared/*.mjs, never the tests).
rm -rf "$STAGE/src/shared" && mkdir "$STAGE/src/shared"
for f in "$ROOT"/shared/*.mjs; do case "$f" in *.test.mjs) ;; *) cp "$f" "$STAGE/src/shared/" ;; esac; done
[ ! -L "$STAGE/src/shared" ] || { echo "package-auth: src/shared is still a symlink" >&2; exit 1; }
ls "$STAGE"/src/shared/*.mjs >/dev/null 2>&1 || { echo "package-auth: no shared/*.mjs staged" >&2; exit 1; }
( cd "$STAGE" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null && rm -f .npmrc package-lock.json )
mkdir -p "$ROOT/dist" && rm -f "$ROOT/dist/hfy-auth-edge.zip"
( cd "$STAGE" && zip -qr -X "$ROOT/dist/hfy-auth-edge.zip" . )
echo "built $ROOT/dist/hfy-auth-edge.zip ($(du -h "$ROOT/dist/hfy-auth-edge.zip" | cut -f1))"
