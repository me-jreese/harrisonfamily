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

# HFY-TSK-317: the retired Google sign-in must not come back through a refresh from an unported Eleventy source. These are the
# strings the old layout wrote into every page; none may appear in the build that is about to be promoted into 11ty/.
check_retired_signin() {
  local page
  for page in "${SITE_DIR}"/index.html "${SITE_DIR}"/*/index.html; do
    [[ -f "${page}" ]] || continue
    case "${page}" in "${SITE_DIR}"/family-login/index.html) continue ;; esac
    if grep -qE 'accounts\.google\.com/gsi/client|/api/check-allowed|/js/auth\.js|/js/search-navbar\.js|/js/search-results\.js' "${page}"; then
      failures+=("${page#"${SITE_DIR}"/} still loads the retired Google sign-in or the Lunr search. Port the layout first (docs/how-to/refresh-the-eleventy-output.md).")
    fi
  done
  if [[ -f "${SITE_DIR}/js/auth.js" || -f "${SITE_DIR}/js/search-navbar.js" || -f "${SITE_DIR}/js/search-results.js" ]]; then
    failures+=("the build still emits js/auth.js, js/search-navbar.js or js/search-results.js, which 11ty/ no longer has.")
  fi
  if [[ -f "${SITE_DIR}/family-login/index.html" ]] && ! grep -q '/auth/login' "${SITE_DIR}/family-login/index.html"; then
    failures+=("family-login/index.html is the Google sign-in page, not the redirect to /auth/login.")
  fi
}

check_retired_signin

if [[ ${#failures[@]} -gt 0 ]]; then
  echo "[FAIL] Build validation failed:" >&2
  printf '  - %s\n' "${failures[@]}" >&2
  exit 1
fi

if [[ ${#warnings[@]} -gt 0 ]]; then
  echo "[WARN] Build validation warnings:"
  printf '  - %s\n' "${warnings[@]}"
fi

echo "[OK] Build validation passed: no retired sign-in or Lunr search in the build."
