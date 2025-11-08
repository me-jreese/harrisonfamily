#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE_ROOT="$(cd "${REPO_ROOT}/.." && pwd)"
SITE_DIR="${WORKSPACE_ROOT}/workspace/11ty-dev/_site"

if [[ ! -d "${SITE_DIR}" ]]; then
  echo "[ERROR] Build directory not found: ${SITE_DIR}" >&2
  exit 1
fi

failures=()
warnings=()

check_enforce_assets() {
  if ! grep -q '"enforceAssets":true' "${SITE_DIR}/index.html"; then
    failures+=("Missing enforceAssets=true in index.html. Did you build with production flags?")
  fi
}

check_client_id() {
  if grep -q 'REPLACE_WITH_GOOGLE_CLIENT_ID' "${SITE_DIR}"/index.html; then
    warnings+=("Placeholder Google client ID detected. Remember to run the manual GIS patch after deployment.")
  fi
  if grep -q '"clientId":""' "${SITE_DIR}/index.html"; then
    failures+=("Empty clientId detected in auth config.")
  fi
}

check_enforce_assets
check_client_id

if [[ ${#failures[@]} -gt 0 ]]; then
  echo "[FAIL] Build validation failed:" >&2
  printf '  - %s\n' "${failures[@]}" >&2
  exit 1
fi

if [[ ${#warnings[@]} -gt 0 ]]; then
  echo "[WARN] Build validation warnings:"
  printf '  - %s\n' "${warnings[@]}"
fi

echo "[OK] Build validation passed: enforceAssets check succeeded."
