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
    --exclude '.DS_Store'
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
