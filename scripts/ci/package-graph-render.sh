#!/usr/bin/env bash
# Builds dist/hfy-graph-render.zip: the hfy-graph-render Lambda (handler src/index.handler, nodejs22.x, arm64) of HFY-TSK-274.
# Layout of the zip (the repository's own relative paths, so no import is rewritten):
#   src/index.mjs                      re-exports graph/cloud/index.mjs (the handler path is fixed by the stack)
#   graph/cloud/*.mjs                  the handler, the cloud source, the pass, the AWS adapters
#   graph/src/*.mjs, graph/schema/     the graph builder (build.mjs, faces.mjs, verify.mjs and what they import), graph/package.json
#   shared/privacy-guard.mjs           the shared detector verify() loads
#   api/src/records/{index,semantics,ops,gcalendar,mod-overlay}.js, api/src/sync/store.js, api/src/http-error.js,
#   api/src/shared/canonical.mjs       the store view and the MOD# overlay, taken from hfy-api's own source (nothing is copied twice)
#   node_modules/                      installed for --os=linux --cpu=arm64 --libc=glibc: sharp ships native binaries (libvips) per platform
# No gazetteer, no dump, no fixture and no test ships. The zip is reproducible (sorted entries, fixed mtimes) for the same sources and
# lock file, so the same bytes give the same key.
# Prints the GraphRenderCodeKey for the app-stack change set, lambda/hfy-graph-render-<first 12 hex of the zip's SHA-256>.zip. A code
# change is a new key; never re-upload to a key a deployed change set already used.
# Needs: node 22 with npm, zip, python3, network access to the public npm registry (no CodeArtifact token: nothing here is an @io-kit package).
# Usage: bash scripts/ci/package-graph-render.sh   (run from anywhere in the checkout)
#   After deploy, smoke the function: bash scripts/ci/smoke-graph-render.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CLOUD="$ROOT/graph/cloud"
STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
for f in "$CLOUD/index.mjs" "$CLOUD/package.json" "$CLOUD/package-lock.json" "$ROOT/graph/src/build.mjs" "$ROOT/graph/schema/family-graph.v1.schema.json" \
         "$ROOT/shared/privacy-guard.mjs" "$ROOT/shared/canonical.mjs" "$ROOT/api/src/records/index.js"; do
  [ -f "$f" ] || { echo "package-graph-render: missing $f" >&2; exit 1; }
done
mkdir -p "$STAGE/src" "$STAGE/graph/cloud" "$STAGE/graph/src" "$STAGE/graph/schema" "$STAGE/shared" "$STAGE/api/src/records" "$STAGE/api/src/sync" "$STAGE/api/src/shared"
printf 'export { handler } from "../graph/cloud/index.mjs";\n' > "$STAGE/src/index.mjs"
cp "$CLOUD"/*.mjs "$STAGE/graph/cloud/"
cp "$ROOT"/graph/src/*.mjs "$STAGE/graph/src/"
cp "$ROOT/graph/schema/family-graph.v1.schema.json" "$STAGE/graph/schema/"
cp "$ROOT/graph/package.json" "$STAGE/graph/package.json"
cp "$ROOT/shared/privacy-guard.mjs" "$STAGE/shared/"
for f in index semantics ops gcalendar mod-overlay; do cp "$ROOT/api/src/records/$f.js" "$STAGE/api/src/records/"; done
cp "$ROOT/api/src/sync/store.js" "$STAGE/api/src/sync/"
cp "$ROOT/api/src/http-error.js" "$STAGE/api/src/"
cp "$ROOT/shared/canonical.mjs" "$STAGE/api/src/shared/"
# The dependencies at the root of the stage: graph/src/ and graph/cloud/ resolve them by walking up. The lock file is the cloud package's own.
cp "$CLOUD/package.json" "$CLOUD/package-lock.json" "$STAGE/"
( cd "$STAGE" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --os=linux --cpu=arm64 --libc=glibc >/dev/null )
# npm installs the musl and WebAssembly variants of sharp too (--libc is not honoured for optional dependencies); the Lambda runtime is glibc.
rm -rf "$STAGE"/node_modules/@img/*musl* "$STAGE/node_modules/@img/sharp-wasm32" "$STAGE/node_modules/@emnapi"
[ -d "$STAGE/node_modules/@img/sharp-linux-arm64" ] && [ -d "$STAGE/node_modules/@img/sharp-libvips-linux-arm64" ] \
  || { echo "package-graph-render: the linux/arm64 sharp binary was not installed" >&2; exit 1; }
EXTRA="$(ls "$STAGE/node_modules/@img/" | grep -vxE 'colour|sharp-linux-arm64|sharp-libvips-linux-arm64' || true)"
[ -z "$EXTRA" ] || { echo "package-graph-render: a binary for another platform was installed: $EXTRA" >&2; exit 1; }
rm -f "$STAGE/package-lock.json"
# The zip must import on its own: the handler module and the whole pass (sharp loads only when faces are cropped), with no repository on the path.
( cd "$STAGE" && node --input-type=module -e 'const m = await import("./src/index.mjs"); if (typeof m.handler !== "function") process.exit(1); await import("./graph/cloud/render.mjs"); await import("./graph/cloud/aws.mjs");' ) \
  || { echo "package-graph-render: the staged package does not import" >&2; exit 1; }
DIST="$ROOT/dist"
ZIP="$DIST/hfy-graph-render.zip"
mkdir -p "$DIST" && rm -f "$ZIP"
( cd "$STAGE" && find . -type f | LC_ALL=C sort | sed 's#^\./##' > "$STAGE/.list.all" \
  && grep -v '^\.list' "$STAGE/.list.all" > "$STAGE/.list.zip" \
  && xargs -I{} env TZ=UTC touch -t 202001010000 "{}" < "$STAGE/.list.zip" \
  && TZ=UTC zip -q -X "$ZIP" -@ < "$STAGE/.list.zip" )
SIZE=$(wc -c < "$ZIP" | tr -d ' ')
[ "$SIZE" -lt 52428800 ] || { echo "package-graph-render: zip is $SIZE bytes (the direct upload limit is 50 MB)" >&2; exit 1; }
SHA_HEX=$(python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$ZIP")
KEY="lambda/hfy-graph-render-${SHA_HEX:0:12}.zip"
printf 'GraphRenderCodeKey=%s\n' "$KEY" > "$DIST/hfy-graph-render.params"
echo "built $ZIP ($SIZE bytes)"
echo "GraphRenderCodeKey=$KEY"
echo "upload: aws s3 cp $ZIP s3://<code-bucket>/$KEY --region us-west-2"
echo "deploy: the RG-6 app-stack change set on harrisonfamily-app with GraphRenderCodeKey=$KEY (docs/how-to/deploy-the-graph-renderer.md)"
