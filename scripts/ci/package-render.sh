#!/usr/bin/env bash
# Builds dist/hfy-sync-render.zip: the hfy-sync-render Lambda (handler handler.handler, Python 3.13, arm64) of HFY-TSK-176.
# Contents: lambda/hfy-sync-render/handler.py and hfy_render/ (the engine), plus the pure-stdlib renderer core it imports from gramps/:
# hfygramps/__init__.py, hfygramps/scanner.py (the R-18 detector) and hfygramps/render/ (render_site and its helpers). Nothing else of
# gramps/ ships (no addon, no merge engine, no fixtures, no tests). boto3 comes from the Lambda runtime.
# The zip is reproducible (sorted entries, fixed mtimes, no extra attributes): the same sources give the same bytes, so the same key.
# Prints the RenderCodeKey for the app-stack change set, lambda/hfy-sync-render-<first 12 hex of the zip's SHA-256>.zip. A code change is
# a new key, so CloudFormation updates the function code; never re-upload to a key a deployed change set already used.
# Usage: bash scripts/ci/package-render.sh   (needs zip and python3; run from anywhere in the checkout)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/lambda/hfy-sync-render"
CORE="$ROOT/gramps/hfygramps"
STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
[ -f "$SRC/handler.py" ] && [ -d "$SRC/hfy_render" ] || { echo "package-render: $SRC lacks handler.py or hfy_render/" >&2; exit 1; }
cp "$SRC/handler.py" "$STAGE/"
mkdir -p "$STAGE/hfy_render" "$STAGE/hfygramps/render"
for f in "$SRC"/hfy_render/*.py; do cp "$f" "$STAGE/hfy_render/"; done
cp "$CORE/__init__.py" "$CORE/scanner.py" "$STAGE/hfygramps/"
for f in "$CORE"/render/*.py; do cp "$f" "$STAGE/hfygramps/render/"; done
find "$STAGE" -name '__pycache__' -prune -exec rm -rf {} + 2>/dev/null || true
# The zip must import on its own: handler, the engine, and the renderer core, with no repository on the path.
( cd "$STAGE" && python3 -I -c 'import sys; sys.path.insert(0, "."); import handler, hfy_render.engine, hfy_render.privacy, hfygramps.render, hfygramps.scanner' ) \
  || { echo "package-render: the staged package does not import" >&2; exit 1; }
find "$STAGE" -name '__pycache__' -prune -exec rm -rf {} + 2>/dev/null || true
DIST="$ROOT/dist"
ZIP="$DIST/hfy-sync-render.zip"
mkdir -p "$DIST" && rm -f "$ZIP"
( cd "$STAGE" && find . -type f | LC_ALL=C sort | sed 's#^\./##' > "$STAGE/.files" \
  && grep -v '^\.files$' "$STAGE/.files" > "$STAGE/.list" \
  && xargs -I{} env TZ=UTC touch -t 202001010000 "{}" < "$STAGE/.list" \
  && TZ=UTC zip -q -X "$ZIP" -@ < "$STAGE/.list" )
SIZE=$(wc -c < "$ZIP" | tr -d ' ')
[ "$SIZE" -lt 5242880 ] || { echo "package-render: zip is $SIZE bytes" >&2; exit 1; }
SHA_HEX=$(python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$ZIP")
KEY="lambda/hfy-sync-render-${SHA_HEX:0:12}.zip"
printf 'RenderCodeKey=%s\n' "$KEY" > "$DIST/hfy-sync-render.params"
echo "built $ZIP ($SIZE bytes)"
echo "RenderCodeKey=$KEY"
echo "upload: aws s3 cp $ZIP s3://<code-bucket>/$KEY --region us-west-2"
echo "deploy: a reviewed change set on the app stack with RenderCodeKey=$KEY and RenderMode left at off (docs/how-to/deploy-the-app-stack.md)"
