#!/usr/bin/env bash
set -euo pipefail

if [ "${SKIP_DEPLOYMENT_SYNC_CHECK:-0}" = "1" ]; then
  exit 0
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
PROJECT_ROOT="$(cd "$REPO_ROOT/.." && pwd)"
DOC_PATH="$PROJECT_ROOT/docs/deployment.md"

if ! command -v rsync >/dev/null 2>&1; then
  echo "[ERROR] rsync is required for deployment sync checks." >&2
  exit 1
fi

STAGED_FILES="$(git diff --cached --name-only || true)"
if [ -z "$STAGED_FILES" ]; then
  exit 0
fi

needs_eleventy_check=0
needs_lambda_check=0
needs_gcf_check=0

IFS=$'\n'
for file in $STAGED_FILES; do
  case "$file" in
    11ty/*) needs_eleventy_check=1 ;;
    lambda/*) needs_lambda_check=1 ;;
    functions/*) needs_gcf_check=1 ;;
  esac
done
unset IFS

run_rsync_check() {
  local label="$1"
  local source="$2"
  local dest="$3"
  shift 3
  local -a extra_opts=("$@")

  if [ ! -d "$source" ]; then
    echo "[ERROR] $label source directory missing: $source" >&2
    echo "         Run the relevant build step described in $DOC_PATH." >&2
    exit 1
  fi
  if [ ! -d "$dest" ]; then
    echo "[ERROR] $label destination directory missing: $dest" >&2
    echo "         Ensure the repo layout matches the SOP in $DOC_PATH." >&2
    exit 1
  fi

  local raw_output cleaned_output
  local -a rsync_cmd=(rsync -ain --delete --omit-dir-times)
  if [ "${#extra_opts[@]}" -gt 0 ]; then
    rsync_cmd+=("${extra_opts[@]}")
  fi
  if ! raw_output=$("${rsync_cmd[@]}" "$source/" "$dest/"); then
    echo "[ERROR] rsync comparison failed for $label." >&2
    exit 1
  fi

  # Remove the boilerplate header and blank lines.
  cleaned_output=$(printf "%s\n" "$raw_output" | sed '/^sending incremental file list$/d' | sed '/^$/d')
  if [ -n "$cleaned_output" ]; then
    echo "[ERROR] $label is out of sync with its workspace source." >&2
    echo "        Review $DOC_PATH and run scripts/promote_workspace_assets.sh with the current session log before committing." >&2
    echo "$cleaned_output"
    exit 1
  fi
}

if [ "$needs_eleventy_check" -eq 1 ]; then
  run_rsync_check \
    "Eleventy build (workspace/11ty-dev/_site -> repo/11ty)" \
    "$PROJECT_ROOT/workspace/11ty-dev/_site" \
    "$REPO_ROOT/11ty" \
    --exclude 'person/' \
    --exclude 'family/' \
    --exclude 'event/' \
    --exclude 'note/' \
    --exclude 'media/' \
    --exclude 'private/' \
    --exclude 'place/' \
    --exclude 'README.md' \
    --exclude '.DS_Store' \
    --exclude 'uploads/' \
    --exclude '_data/flags.json' \
    --exclude 'js/islands/' \
    --exclude 'js/auth-v2.js' \
    --exclude 'js/feature-flags.js' \
    --exclude 'js/search-navbar.js' \
    --exclude 'js/search-results.js' \
    --exclude 'js/person-page.js' \
    --exclude 'js/auth.js' \
    --exclude 'css/auth-edge.css' \
    --exclude 'css/hfy-theme.css' \
    --exclude 'fonts/' \
    --exclude 'sw.js' \
    --exclude 'manifest.webmanifest' \
    --exclude 'offline.html' \
    --exclude 'images/pwa-*.png' \
    --exclude 'posts/' \
    --exclude 'me/'
  # The excludes after .DS_Store are repo-owned files the Eleventy workspace does not produce (11ty/README.md, HFY-R46/R58).
  # js/person-page.js carries the authV2 data-gate path (HFY-TSK-080) that the workspace copy lacks. js/auth.js carries the authV2
  # One Tap suppression (HFY-TSK-069); css/auth-edge.css is the auth edge's own stylesheet (auth/edge.manifest.json theme.cssUrl,
  # HFY-TSK-069), which the workspace does not produce. css/hfy-theme.css and fonts/ are islands/build.mjs outputs (the
  # design-system theme layer and the self-hosted faces). Keep this list equal to the
  # 11ty/README.md refresh rsync (scripts/infra/test/run.sh checks it).
fi

if [ "$needs_lambda_check" -eq 1 ]; then
  run_rsync_check \
    "Lambda hfy-check-allowed (scripts/auth/check-allowed-lambda -> lambda/hfy-check-allowed)" \
    "$PROJECT_ROOT/scripts/auth/check-allowed-lambda" \
    "$REPO_ROOT/lambda/hfy-check-allowed" \
    --exclude 'node_modules/'
fi

if [ "$needs_gcf_check" -eq 1 ]; then
  run_rsync_check \
    "GCF get-allowlist (workspace/gcloud/allowlist-fn -> functions/get-allowlist)" \
    "$PROJECT_ROOT/workspace/gcloud/allowlist-fn" \
    "$REPO_ROOT/functions/get-allowlist"
fi
