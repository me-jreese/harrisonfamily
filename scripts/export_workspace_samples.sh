#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SANITIZED_DIRS=(
  "allowlist"
  "cloudfront"
  "etl-output"
  "gcloud"
  "gcloud-config"
  "harrisonfamily-frontend"
)

for dir in "${SANITIZED_DIRS[@]}"; do
  src="$PROJECT_ROOT/workspace/${dir}"
  dst="$PROJECT_ROOT/repo/${dir}"
  if [ -d "$src" ]; then
    rm -rf "$dst"
    mkdir -p "$dst"
    rsync -a "$src/" "$dst/"
    echo "[OK] Copied workspace/${dir} -> repo/${dir}"
  fi
 done

if [ -d "$PROJECT_ROOT/workspace/tests/login-flow" ]; then
  rm -rf "$PROJECT_ROOT/repo/tests/login-flow"
  mkdir -p "$PROJECT_ROOT/repo/tests"
  rsync -a "$PROJECT_ROOT/workspace/tests/login-flow/" "$PROJECT_ROOT/repo/tests/login-flow/"
  echo "[OK] Copied workspace/tests/login-flow -> repo/tests/login-flow"
fi

if [ -f "$PROJECT_ROOT/workspace/coming-soon-index.html" ]; then
  cp "$PROJECT_ROOT/workspace/coming-soon-index.html" "$PROJECT_ROOT/repo/coming-soon-index.html"
  echo "[OK] Copied workspace/coming-soon-index.html"
fi
