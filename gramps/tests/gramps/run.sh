#!/usr/bin/env bash
# Gramps integration lane, local macOS with the Gramps 6.0.6 bundle (HFY-TSK-228).
#
#   gramps/tests/gramps/run.sh [test_file.py ...]
#
# 1. Makes a throwaway GRAMPSHOME (and HOME) in a temp directory.
# 2. Imports gramps/tests/fixtures/synthetic-tree.gramps once, with the Gramps CLI, into a
#    template tree, then finishes it with prepare_template.py: the media path points at the fixtures
#    directory (so media/... paths resolve to the committed files, never to the real ~/Pictures), and
#    the two MediaRef rects the XML format drops are restored from the JSONL. The template then
#    equals synthetic-tree.jsonl object for object.
# 3. For every test file (default: test_*.py here; a bare name means this directory) copies the
#    template to a fresh tree, runs the test against that copy inside the bundled Python
#    (HFY_TREE_NAME names it; fixture_trees.fresh_copy gives one test method its own copy), and
#    checks the template is unchanged.
# 4. Proves the real Gramps database folder was never opened: every step (the import, the template
#    preparation, the stdlib helpers and the tests) runs in the bundled Python under an audit hook that
#    refuses and records any open of the user's real Gramps data directory or Pictures folder; the
#    script fails if a violation was logged, if the hook saw nothing, or if a negative control (an
#    audit-only probe of the real grampsdb and Pictures folder, and a real open() and sqlite3 connect
#    of a file in a throwaway forbidden directory) was not blocked.
#
# The real folders are "$HOME/Library/Application Support/gramps" (grampsdb inside it), "$HOME/.gramps"
# and "$HOME/Pictures" (Gramps' default media folder, which GLib takes from the account on macOS, not
# from HOME), for HOME as given and for the account's home in the user database.
# Env: HFY_GRAMPS_APP (bundle path), HFY_KEEP=1 (keep the temp directory and print it).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURES="$(cd "$HERE/../fixtures" && pwd)"
SHIM="$HERE/gramps-shim.sh"
REAL_HOME="$HOME"
# The account's home from the user database too, in case HOME was already redirected by the caller.
PW_HOME="$(python3 -c 'import os, pwd; print(pwd.getpwuid(os.getuid()).pw_dir)' 2>/dev/null || echo "$REAL_HOME")"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/hfy-gramps-run.XXXXXX")"
cleanup() {
  if [ "${HFY_KEEP:-0}" = "1" ]; then echo "[run.sh] kept $WORK"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT

# From here on nothing may use the real home.
export GRAMPSHOME="$WORK/home"
export HOME="$GRAMPSHOME"
mkdir -p "$GRAMPSHOME"
forbid=""
for h in "$REAL_HOME" "$PW_HOME"; do
  forbid="$forbid${forbid:+:}$h/Library/Application Support/gramps:$h/.gramps:$h/Pictures"
done
export HFY_SHIM_FORBID="$forbid"
export HFY_TEMPLATE_TREE=hfy-template
export HFY_SHIM_AUDIT_LOG="$WORK/audit.log"
: > "$HFY_SHIM_AUDIT_LOG"

fail() { echo "[FAIL] $*" >&2; exit 1; }

echo "[run.sh] importing the fixture into the template tree"
"$SHIM" --cli -C "$HFY_TEMPLATE_TREE" -i "$FIXTURES/synthetic-tree.gramps" --yes >"$WORK/import.log" 2>&1 \
  || { cat "$WORK/import.log" >&2; fail "fixture import failed"; }

# The stdlib helpers read the template tree directly. They run in the bundled Python too, so the
# audit hook covers them, and paths go in as arguments, never into code.
ft() { "$SHIM" --script "$HERE/fixture_trees.py" "$@"; }
TEMPLATE_DIR="$(ft find "$GRAMPSHOME" "$HFY_TEMPLATE_TREE")"
[ -n "$TEMPLATE_DIR" ] || fail "template tree not found after import"
echo "[run.sh] setting the template's media path and restoring the rects the XML format drops"
"$SHIM" --script "$HERE/prepare_template.py" "$TEMPLATE_DIR" "$FIXTURES" >"$WORK/prepare.log" 2>&1 \
  || { cat "$WORK/prepare.log" >&2; fail "preparing the template tree failed"; }
want_digest="$(ft digest "$TEMPLATE_DIR")"

if [ "$#" -gt 0 ]; then tests=("$@"); else tests=("$HERE"/test_*.py); fi
ran=0
for t in "${tests[@]}"; do
  # A bare name (run.sh test_x.py) means a test file in this directory.
  if [ ! -f "$t" ] && [ -f "$HERE/$t" ]; then t="$HERE/$t"; fi
  [ -f "$t" ] || fail "no such test file: $t"
  base="$(basename "$t" .py)"
  copy="hfy-copy-$base"
  ft copy "$GRAMPSHOME" "$HFY_TEMPLATE_TREE" "$copy" >/dev/null || fail "could not copy the template for $base"
  echo "[run.sh] $base on a fresh copy"
  HFY_TREE_NAME="$copy" "$SHIM" --script "$t" -v || fail "$base failed"
  ran=$((ran + 1))
done

got_digest="$(ft digest "$TEMPLATE_DIR")"
[ "$got_digest" = "$want_digest" ] || fail "the template tree changed while the tests ran"

echo "[run.sh] negative controls: the audit hook must block the real Gramps and Pictures folders"
probe() { "$SHIM" --script "$HERE/probe_forbidden_path.py" "$@" >/dev/null; }
probe_log="$WORK/probe-audit.log"
# 1. The real grampsdb and the real Pictures folder, by the audit event alone: nothing is opened there
#    even if the hook is broken.
for h in "$REAL_HOME" "$PW_HOME"; do
  for real_probe in "$h/Library/Application Support/gramps/grampsdb/hfy-audit-probe" "$h/Pictures/hfy-audit-probe.jpg"; do
    HFY_SHIM_AUDIT_LOG="$probe_log" probe audit "$real_probe" \
      || fail "the audit hook did not refuse $real_probe"
    grep -qF "VIOLATION open $real_probe" "$probe_log" || fail "the refused probe of $real_probe was not logged"
  done
done
# 2. A real open() and a real sqlite3 URI connect, on a file in a throwaway directory forbidden for this run.
mkdir -p "$WORK/forbidden"
: > "$WORK/forbidden/sqlite.db"
HFY_SHIM_FORBID="$WORK/forbidden" HFY_SHIM_AUDIT_LOG="$probe_log" probe open "$WORK/forbidden/sqlite.db" \
  || fail "the audit hook did not block a real open() of a forbidden file"
HFY_SHIM_FORBID="$WORK/forbidden" HFY_SHIM_AUDIT_LOG="$probe_log" probe sqlite "$WORK/forbidden/sqlite.db" \
  || fail "the audit hook did not block a sqlite3 URI connect to a forbidden file"
grep -q '^VIOLATION open .*/forbidden/sqlite.db$' "$probe_log" || fail "the blocked open() was not logged"
grep -q '^VIOLATION sqlite3.connect .*/forbidden/sqlite.db$' "$probe_log" || fail "the blocked connect was not logged"

if grep -q '^VIOLATION' "$HFY_SHIM_AUDIT_LOG"; then
  grep '^VIOLATION' "$HFY_SHIM_AUDIT_LOG" >&2
  fail "a step touched the real Gramps or Pictures folder"
fi
checked="$(awk '/^checked /{s+=$2} END{print s+0}' "$HFY_SHIM_AUDIT_LOG")"
[ "$checked" -gt 0 ] || fail "the audit hook saw no file access, so it proves nothing"

echo "[PASS] $ran test file(s) on per-test copies; $checked file accesses audited, none under the real Gramps or Pictures folder"
