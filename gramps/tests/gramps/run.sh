#!/usr/bin/env bash
# Gramps integration lane, local macOS with the Gramps 6.0.6 bundle (HFY-TSK-228).
#
#   gramps/tests/gramps/run.sh [test_file.py ...]
#
# 1. Makes a throwaway GRAMPSHOME (and HOME) in a temp directory.
# 2. Imports gramps/tests/fixtures/synthetic-tree.gramps once, with the Gramps CLI, into a
#    template tree.
# 3. For every test file (default: test_*.py here) copies the template to a fresh tree, runs the
#    test against that copy inside the bundled Python, and checks the template is unchanged.
# 4. Proves the real Gramps database folder was never opened: every step runs under an audit hook
#    that refuses and records any open of the user's real Gramps data directory; the script fails
#    if a violation was logged, if the hook saw nothing, or if the negative control was not blocked.
#
# The real folder is "$HOME/Library/Application Support/gramps" (grampsdb inside it) and "$HOME/.gramps".
# Env: HFY_GRAMPS_APP (bundle path), HFY_KEEP=1 (keep the temp directory and print it).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURES="$HERE/../fixtures"
SHIM="$HERE/gramps-shim.sh"
REAL_HOME="$HOME"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/hfy-gramps-run.XXXXXX")"
cleanup() {
  if [ "${HFY_KEEP:-0}" = "1" ]; then echo "[run.sh] kept $WORK"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT

# From here on nothing may use the real home.
export GRAMPSHOME="$WORK/home"
export HOME="$GRAMPSHOME"
mkdir -p "$GRAMPSHOME"
export HFY_SHIM_FORBID="$REAL_HOME/Library/Application Support/gramps:$REAL_HOME/.gramps"
export HFY_SHIM_AUDIT_LOG="$WORK/audit.log"
: > "$HFY_SHIM_AUDIT_LOG"

fail() { echo "[FAIL] $*" >&2; exit 1; }

echo "[run.sh] importing the fixture into the template tree"
"$SHIM" --cli -C hfy-template -i "$FIXTURES/synthetic-tree.gramps" --yes >"$WORK/import.log" 2>&1 \
  || { cat "$WORK/import.log" >&2; fail "fixture import failed"; }

# Pure-stdlib helpers read the template tree directly.
TEMPLATE_DIR="$(python3 -c "
import sys
sys.path.insert(0, '$HERE')
import fixture_trees as ft
print(ft.find_tree('$GRAMPSHOME', 'hfy-template') or '')
")"
[ -n "$TEMPLATE_DIR" ] || fail "template tree not found after import"
want_digest="$(python3 -c "
import sys
sys.path.insert(0, '$HERE')
import fixture_trees as ft
print(ft.db_digest('$TEMPLATE_DIR'))
")"

if [ "$#" -gt 0 ]; then tests=("$@"); else tests=("$HERE"/test_*.py); fi
ran=0
for t in "${tests[@]}"; do
  base="$(basename "$t" .py)"
  copy="hfy-copy-$base"
  python3 -c "
import sys
sys.path.insert(0, '$HERE')
import fixture_trees as ft
ft.copy_tree('$GRAMPSHOME', 'hfy-template', '$copy')
"
  echo "[run.sh] $base on a fresh copy"
  HFY_TREE_NAME="$copy" "$SHIM" --script "$t" -v || fail "$base failed"
  ran=$((ran + 1))
done

got_digest="$(python3 -c "
import sys
sys.path.insert(0, '$HERE')
import fixture_trees as ft
print(ft.db_digest('$TEMPLATE_DIR'))
")"
[ "$got_digest" = "$want_digest" ] || fail "the template tree changed while the tests ran"

echo "[run.sh] negative control: the audit hook must block the real Gramps folder"
probe_log="$WORK/probe-audit.log"
HFY_SHIM_AUDIT_LOG="$probe_log" "$SHIM" --script "$HERE/probe_forbidden_path.py" \
  "$REAL_HOME/Library/Application Support/gramps/grampsdb/probe" >/dev/null \
  || fail "the audit hook did not block an open of the real Gramps folder"
grep -q '^VIOLATION open ' "$probe_log" || fail "the blocked probe was not logged"

if grep -q '^VIOLATION' "$HFY_SHIM_AUDIT_LOG"; then
  grep '^VIOLATION' "$HFY_SHIM_AUDIT_LOG" >&2
  fail "a step touched the real Gramps database folder"
fi
checked="$(awk '/^checked /{s+=$2} END{print s+0}' "$HFY_SHIM_AUDIT_LOG")"
[ "$checked" -gt 0 ] || fail "the audit hook saw no file access, so it proves nothing"

echo "[PASS] $ran test file(s) on per-test copies; $checked file accesses audited, none under the real Gramps folder"
