#!/usr/bin/env bash
# Family-data guard (HFY-PLN-002 D-03).
#
# Fails when a tracked file is real-data shaped and not on the allowlist:
#   - anything under a data directory (etl-output/, harrisonfamily-frontend/, workspace/,
#     workspace-local/, gramps_exports/, graph/out/, any *.gazetteer/, any hfy_sync/*/backups/), or
#   - any *.gramps, *.gpkg, *.sqlite, *.db or graph/**/*.jsonl file.
# Under gramps/tests/fixtures/ (the synthetic Gramps fixture tree) only the data-shaped files are
# guarded: *.gramps, *.gpkg, *.sqlite, *.db and *.jsonl must be on the allowlist with their hash like
# any other sample, and .gitignore re-includes only the two allowlisted goldens. The generator there,
# the census, the manifest and the media files are not guarded.
# The allowlist, scripts/ci/data-sample-allowlist.txt, holds "<sha256>  <path>" lines. A listed
# file must exist, be tracked, and match its hash; an unlisted one fails.
#
# Paths match case-insensitively. The hash is of the staged blob, so a restored working copy cannot hide a change.
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
  sha_stdin() { sha256sum | cut -d' ' -f1; }
else
  sha_stdin() { shasum -a 256 | cut -d' ' -f1; }
fi

# Work on a CR-stripped copy so CRLF allowlist lines still match.
CLEAN="$(mktemp)"
trap 'rm -f "$CLEAN"' EXIT
tr -d '\r' < "$ALLOWLIST" > "$CLEAN"

# Matching is case-insensitive (macOS filesystems are), so lower-case the path first.
is_guarded() {
  local p
  p="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  case "$p" in
    gramps/tests/fixtures/*.gramps|gramps/tests/fixtures/*.gpkg|gramps/tests/fixtures/*.sqlite) return 0 ;;
    gramps/tests/fixtures/*.db|gramps/tests/fixtures/*.jsonl) return 0 ;;
    gramps/tests/fixtures/*) return 1 ;;
    etl-output/*|harrisonfamily-frontend/*|workspace/*|workspace-local/*|gramps_exports/*|graph/out/*) return 0 ;;
    *.gazetteer/*) return 0 ;;
    *.gramps|*.gpkg|*.sqlite|*.db) return 0 ;;
    */hfy_sync/*/backups/*|hfy_sync/*/backups/*) return 0 ;;
    graph/*.jsonl) return 0 ;;
  esac
  return 1
}

status=0
checked=0

# Judge the staged blob (what would be committed), not the working-tree file.
# Each record is "<mode> <blob> <stage>\t<path>" NUL-terminated.
while IFS= read -r -d '' rec; do
  meta="${rec%%$'\t'*}"
  path="${rec#*$'\t'}"
  is_guarded "$path" || continue
  checked=$((checked + 1))
  blob="$(echo "$meta" | cut -d' ' -f2)"
  # Allowlist line format: "<sha256>  <path>". Match the path field exactly (path via ENVIRON, no escape handling).
  want="$(HFY_P="$path" awk '$0 !~ /^[[:space:]]*(#|$)/ { h=$1; $1=""; sub(/^[[:space:]]+/, ""); if ($0 == ENVIRON["HFY_P"]) { print h; exit } }' "$CLEAN")"
  if [ -z "$want" ]; then
    echo "[FAIL] Tracked file is not on the data-sample allowlist: $path" >&2
    status=1
    continue
  fi
  have="$(git cat-file blob "$blob" | sha_stdin)"
  if [ "$have" != "$want" ]; then
    echo "[FAIL] Allowlisted sample changed (sha256 mismatch on the staged content): $path" >&2
    status=1
  fi
done < <(git ls-files -s -z)

# Allowlist entries must still be tracked files (exact path, not a pathspec or directory).
while IFS= read -r line; do
  case "$line" in ''|'#'*) continue ;; esac
  entry="${line#* }"
  entry="${entry#"${entry%%[![:space:]]*}"}"
  found=""
  while IFS= read -r -d '' rec; do
    [ "${rec#*$'\t'}" = "$entry" ] && found=1
  done < <(git ls-files -s -z -- ":(literal)$entry")
  if [ -z "$found" ]; then
    echo "[FAIL] Allowlist entry is not a tracked file: $entry" >&2
    status=1
  fi
done < "$CLEAN"

if [ "$status" -ne 0 ]; then
  echo "[ERROR] Family-data guard failed. Real family data must never be committed. If the file is a new synthetic sample, add its negation to .gitignore and its sha256 and path to scripts/ci/data-sample-allowlist.txt." >&2
  exit 1
fi

echo "[OK] Family-data guard passed ($checked guarded tracked files, all on the allowlist)."
