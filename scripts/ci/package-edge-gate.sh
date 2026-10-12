#!/usr/bin/env bash
# Builds dist/hfy-edge-gate.zip (Lambda@Edge hfy-edge-gate, handler index.handler, Node 22). The function has no dependencies, so no npm install.
# edge-gate/gate.config.json (issuer, audience, JWKS URL) is baked into the zip as config.json: Lambda@Edge has no environment variables.
# The zip is reproducible (fixed mtimes, no extra attributes), so the same sources always give the same bytes.
# Prints the parameters of infrastructure/cloudformation/edge-gate-stack.yaml (also written to dist/hfy-edge-gate.params, KEY=VALUE lines):
#   CodeSha256  base64 SHA-256 of the zip, the form Lambda reports; AWS::Lambda::Version publishes only when $LATEST matches it.
#   CodeKey     content-addressed S3 key lambda/hfy-edge-gate-<first 16 hex of the SHA-256>.zip. A code change is a new key, so
#               CloudFormation updates the function code AND publishes a new version; re-uploading to a fixed key would leave
#               $LATEST on the old code and make PublishVersion(CodeSha256=<new>) fail (edge-gate-update-same-key-fails).
# Upload the zip to that key in the us-east-1 code bucket before deploying the stack (cloudfront/README.md, "Private data gate").
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
cp "$ROOT/edge-gate/src/index.mjs" "$ROOT/edge-gate/src/gate.mjs" "$STAGE/"
cp "$ROOT/edge-gate/gate.config.json" "$STAGE/config.json"
node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));for(const k of ["issuer","audience","jwksUrl"])if(!c[k])throw new Error("gate.config.json lacks "+k)' "$STAGE/config.json"
DIST="$ROOT/dist"
ZIP="$DIST/hfy-edge-gate.zip"
mkdir -p "$DIST" && rm -f "$ZIP"
( cd "$STAGE" && TZ=UTC touch -t 202001010000 index.mjs gate.mjs config.json && TZ=UTC zip -qr -X "$ZIP" index.mjs gate.mjs config.json )
SIZE=$(wc -c < "$ZIP" | tr -d ' ')
[ "$SIZE" -lt 1048576 ] || { echo "zip is $SIZE bytes; Lambda@Edge viewer triggers allow 1 MB" >&2; exit 1; }
SHA_B64=$(openssl dgst -sha256 -binary "$ZIP" | openssl base64 -A)
SHA_HEX=$(openssl dgst -sha256 -binary "$ZIP" | od -An -v -tx1 | tr -d ' \n')
KEY="lambda/hfy-edge-gate-${SHA_HEX:0:16}.zip"
printf 'CodeKey=%s\nCodeSha256=%s\n' "$KEY" "$SHA_B64" > "$DIST/hfy-edge-gate.params"
echo "built $ZIP ($SIZE bytes)"
echo "CodeKey=$KEY"
echo "CodeSha256=$SHA_B64"
echo "upload: aws s3 cp $ZIP s3://<us-east-1 code bucket>/$KEY --region us-east-1"
echo "deploy: aws cloudformation deploy --region us-east-1 --stack-name hfy-edge-gate --template-file infrastructure/cloudformation/edge-gate-stack.yaml --capabilities CAPABILITY_NAMED_IAM --parameter-overrides CodeBucket=<us-east-1 code bucket> CodeKey=$KEY CodeSha256=$SHA_B64"
