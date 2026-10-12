#!/usr/bin/env bash
# HFY-TSK-064: builds 11ty/js/islands/* (React 19 islands, @io-kit/shell). Hook for the ci.manifest build step.
# Needs CODEARTIFACT_AUTH_TOKEN for @io-kit/* (aws codeartifact get-authorization-token --domain io). Never echoes it.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
: "${CODEARTIFACT_AUTH_TOKEN:?set CODEARTIFACT_AUTH_TOKEN}"
cd "$ROOT/islands"
npm ci --ignore-scripts --no-audit --no-fund >/dev/null
npm run build:islands
test -s "$ROOT/11ty/js/islands/shell.js" && test -s "$ROOT/11ty/js/islands/shell.css"
echo "built islands -> 11ty/js/islands"
