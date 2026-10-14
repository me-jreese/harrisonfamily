#!/usr/bin/env bash
# Installs the hfy_sync Gramps addon (HFY-TSK-179, sync.md 8.1 and runbook 19.1).
#
#   gramps/scripts/install-addon.sh [--dest PLUGINS_DIR]
#
# Builds the addon (build-addon.sh) and replaces <plugins>/hfy_sync with it. <plugins> is, in this order, --dest, then
# $GRAMPSHOME/gramps/gramps60/plugins when GRAMPSHOME is set (the integration tests and any throwaway Gramps home), then
# "$HOME/Library/Application Support/gramps/gramps60/plugins", where Gramps.app looks. Restart Gramps afterwards; the tool
# appears under Tools > Family Tree Processing as "Website sync...". Only the hfy_sync folder is touched.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GRAMPS="$(cd "$HERE/.." && pwd)"

DEST=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dest) [ "$#" -ge 2 ] || { echo "[install-addon] --dest needs a folder" >&2; exit 64; }; DEST="$2"; shift 2 ;;
    -h|--help) sed -n '2,10p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "[install-addon] unknown argument: $1" >&2; exit 64 ;;
  esac
done
if [ -z "$DEST" ]; then
  if [ -n "${GRAMPSHOME:-}" ]; then
    DEST="$GRAMPSHOME/gramps/gramps60/plugins"
  else
    DEST="$HOME/Library/Application Support/gramps/gramps60/plugins"
  fi
fi

"$HERE/build-addon.sh" >/dev/null
VERSION="$(sed -n 's/^ *version="\([0-9][0-9.]*\)",$/\1/p' "$GRAMPS/hfy_sync/hfy_sync.gpr.py" | head -n 1)"
SRC="$GRAMPS/dist/hfy_sync-$VERSION"
[ -f "$SRC/hfy_sync.gpr.py" ] || { echo "[install-addon] build produced nothing at $SRC" >&2; exit 1; }

mkdir -p "$DEST"
NEW="$DEST/.hfy_sync.new.$$"
OLD="$DEST/.hfy_sync.old.$$"
trap 'rm -rf "$NEW" "$OLD"' EXIT
cp -R "$SRC" "$NEW"
if [ -d "$DEST/hfy_sync" ]; then mv "$DEST/hfy_sync" "$OLD"; fi
mv "$NEW" "$DEST/hfy_sync"
echo "[install-addon] hfy_sync $VERSION installed in $DEST/hfy_sync"
echo "[install-addon] restart Gramps; the tool is under Tools > Family Tree Processing > Website sync..."
echo "[install-addon] command line: $GRAMPS/bin/hfy-sync status"
