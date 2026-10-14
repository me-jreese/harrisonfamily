#!/usr/bin/env bash
# Builds the hfy_sync Gramps addon (HFY-TSK-179, sync.md 8.1).
#
#   gramps/scripts/build-addon.sh
#
# Writes gramps/dist/hfy_sync-<version>/ (the folder install-addon.sh copies) and gramps/dist/hfy_sync-<version>.zip (the same
# folder under a top-level hfy_sync/, the shape of a Gramps addon archive). The version is the one in hfy_sync.gpr.py.
# The folder holds the Gramps files of gramps/hfy_sync/, a vendored copy of hfygramps/ (without render/, which only the cloud
# renderer uses, and schema_check.py, a repository tool) and redaction/redaction-v1.json, where hfygramps/rules.py looks for it.
# dist/ is not tracked. The build is deterministic apart from the zip's file times, which are fixed.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GRAMPS="$(cd "$HERE/.." && pwd)"
VERSION="$(sed -n 's/^ *version="\([0-9][0-9.]*\)",$/\1/p' "$GRAMPS/hfy_sync/hfy_sync.gpr.py" | head -n 1)"
[ -n "$VERSION" ] || { echo "[build-addon] no version in hfy_sync.gpr.py" >&2; exit 1; }

OUT="$GRAMPS/dist/hfy_sync-$VERSION"
rm -rf "$OUT" "$OUT.zip"
mkdir -p "$OUT/redaction"

for f in hfy_sync.gpr.py hfy_sync_tool.py hfy_sync_ui.py; do
  cp "$GRAMPS/hfy_sync/$f" "$OUT/$f"
done
mkdir "$OUT/hfygramps"
(cd "$GRAMPS/hfygramps" && find . -type f -name '*.py' ! -path './render/*' ! -name schema_check.py -print0 | sort -z) |
  while IFS= read -r -d '' rel; do
    mkdir -p "$OUT/hfygramps/$(dirname "$rel")"
    cp "$GRAMPS/hfygramps/$rel" "$OUT/hfygramps/$rel"
  done
cp "$GRAMPS/redaction/redaction-v1.json" "$OUT/redaction/redaction-v1.json"

# A syntax check with the interpreter that will run the files is the job of the Gramps lane; here compile with what is at hand.
python3 -m compileall -q "$OUT" >/dev/null
find "$OUT" -name __pycache__ -type d -prune -exec rm -rf {} +

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/hfy-addon-zip.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
mkdir "$STAGE/hfy_sync"
cp -R "$OUT/." "$STAGE/hfy_sync/"
find "$STAGE" -exec touch -t 202001010000 {} +
(cd "$STAGE" && find hfy_sync -type f | LC_ALL=C sort | zip -q -X "$OUT.zip" -@)
echo "[build-addon] $OUT"
echo "[build-addon] $OUT.zip"
