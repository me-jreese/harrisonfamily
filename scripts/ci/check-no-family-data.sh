#!/usr/bin/env bash
# Family-data guard (HFY-PLN-002 D-03).
#
# Fails when a tracked file is real-data shaped and not on the allowlist:
#   - anything under a data directory (etl-output/, harrisonfamily-frontend/, workspace/,
#     workspace-local/, gramps_exports/, graph/out/, any *.gazetteer/), or
#   - any *.gramps, *.gpkg, *.sqlite, *.db or graph/**/*.jsonl file.
# Synthetic test fixtures under gramps/tests/fixtures/ are exempt, matching .gitignore.
# The allowlist, scripts/ci/data-sample-allowlist.txt, holds "<sha256>  <path>" lines. A listed
# file must exist, be tracked, and match its hash; an unlisted one fails.
#
# Needs only bash, git and sha256sum or shasum. Nothing from CodeArtifact.
# Test hooks: HFY_GUARD_ROOT (repo to check, default the repo of this script) and
# HFY_GUARD_ALLOWLIST (allowlist path, default <root>/scripts/ci/data-sample-allowlist.txt).
set -euo pipefail

ROOT="${HFY_GUARD_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$ROOT"
ALLOWLIST="${HFY_GUARD_ALLOWLIST:-$ROOT/scripts/ci/data-sample-allowlist.txt}"

if [ ! -f "$ALLOWLIST" ]; then
  echo "[ERROR] Missing allowlist: $ALLOWLIST" >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  hash_of() { sha256sum "$1" | cut -d' ' -f1; }
else
  hash_of() { shasum -a 256 "$1" | cut -d' ' -f1; }
fi

is_guarded() {
  case "$1" in
    gramps/tests/fixtures/*) return 1 ;;
    etl-output/*|harrisonfamily-frontend/*|workspace/*|workspace-local/*|gramps_exports/*|graph/out/*) return 0 ;;
    *.gazetteer/*) return 0 ;;
    *.gramps|*.gpkg|*.sqlite|*.db) return 0 ;;
    graph/*.jsonl) return 0 ;;
  esac
  return 1
}

status=0
checked=0

while IFS= read -r -d '' path; do
  is_guarded "$path" || continue
  checked=$((checked + 1))
  # Allowlist line format: "<sha256>  <path>". Match the path field exactly.
  want="$(awk -v p="$path" '$0 !~ /^[[:space:]]*(#|$)/ { h=$1; $1=""; sub(/^[[:space:]]+/, ""); if ($0 == p) { print h; exit } }' "$ALLOWLIST")"
  if [ -z "$want" ]; then
    echo "[FAIL] Tracked file is not on the data-sample allowlist: $path" >&2
    status=1
    continue
  fi
  if [ ! -f "$path" ]; then
    continue
  fi
  have="$(hash_of "$path")"
  if [ "$have" != "$want" ]; then
    echo "[FAIL] Allowlisted sample changed (sha256 mismatch): $path" >&2
    status=1
  fi
done < <(git ls-files -z)

# Allowlist entries must still be tracked, so a stale entry cannot mask a removed sample.
while IFS= read -r line; do
  case "$line" in ''|'#'*) continue ;; esac
  entry="${line#* }"
  entry="${entry#"${entry%%[![:space:]]*}"}"
  if [ -z "$(git ls-files -- "$entry")" ]; then
    echo "[FAIL] Allowlist entry is not a tracked file: $entry" >&2
    status=1
  fi
done < "$ALLOWLIST"

if [ "$status" -ne 0 ]; then
  echo "[ERROR] Family-data guard failed. Real family data must never be committed. If the file is a new synthetic sample, add its negation to .gitignore and its sha256 and path to scripts/ci/data-sample-allowlist.txt." >&2
  exit 1
fi

echo "[OK] Family-data guard passed ($checked guarded tracked files, all on the allowlist)."
