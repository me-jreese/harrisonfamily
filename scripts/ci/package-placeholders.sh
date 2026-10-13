#!/usr/bin/env bash
# Package the no-op hfy-sync-render and hfy-graph-render placeholders (HFY-TSK-247) into dist/placeholders/ for the app-stack change set.
# Upload them as lambda/hfy-sync-render-placeholder.zip and lambda/hfy-graph-render-placeholder.zip (the RenderCodeKey and
# GraphRenderCodeKey defaults). Usage: bash scripts/ci/package-placeholders.sh   (needs zip; run from the repo root)
set -euo pipefail
root=$(pwd)
out="$root/dist/placeholders"
mkdir -p "$out"
rm -f "$out/hfy-sync-render-placeholder.zip" "$out/hfy-graph-render-placeholder.zip"
(cd lambda/placeholders/hfy-sync-render && zip -X -q "$out/hfy-sync-render-placeholder.zip" handler.py)
(cd lambda/placeholders/hfy-graph-render && zip -X -q -r "$out/hfy-graph-render-placeholder.zip" src)
ls -l "$out"
