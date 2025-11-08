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
  "tests"
)

DEST="$PROJECT_ROOT/repo/docs/workspace"
mkdir -p "$DEST"

for dir in "${SANITIZED_DIRS[@]}"; do
  src="$PROJECT_ROOT/workspace/${dir}"
  dst="$DEST/${dir}"
  if [ -d "$src" ]; then
    rm -rf "$dst"
    mkdir -p "$dst"
    rsync -a "$src/" "$dst/"
    echo "[OK] Copied workspace/${dir} -> repo/docs/workspace/${dir}"
  fi
 done

if [ -f "$PROJECT_ROOT/workspace/coming-soon-index.html" ]; then
  cp "$PROJECT_ROOT/workspace/coming-soon-index.html" "$DEST/coming-soon-index.html"
  echo "[OK] Copied workspace/coming-soon-index.html"
fi
