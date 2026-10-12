#!/usr/bin/env bash
# Idempotently adds the hfy-api Function URL origin (Lambda OAC) and the /api/* cache behavior to a CloudFront distribution.
# Usage: add-api-behavior.sh [--dry-run] [--distribution E2JCDK3QLQNNYB] [--stack hfy-app] [--function-url URL] [--oac-id ID] [--config-file FILE]
# --dry-run prints the config diff and changes nothing. --config-file/--function-url/--oac-id allow a fully offline dry run.
set -euo pipefail
DIST=E2JCDK3QLQNNYB; STACK=hfy-app; DRY=0; FURL=""; OAC_ID=""; CFG_FILE=""
ORIGIN_ID=hfy-api-origin; OAC_NAME=hfy-api-lambda-oac
CACHING_DISABLED=4135ea2d-6df8-44a3-9df3-4b5a84be39ad; ALL_VIEWER_EXCEPT_HOST=b689b0a8-53d0-40ab-baf2-68738e2966ac
while [ $# -gt 0 ]; do case "$1" in
  --dry-run) DRY=1;; --distribution) DIST=$2; shift;; --stack) STACK=$2; shift;; --function-url) FURL=$2; shift;;
  --oac-id) OAC_ID=$2; shift;; --config-file) CFG_FILE=$2; shift;; *) echo "unknown arg $1" >&2; exit 2;; esac; shift; done

[ -n "$FURL" ] || FURL=$(aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='FunctionUrl'].OutputValue" --output text)
HOST=$(echo "$FURL" | sed -E 's#^https://([^/]+)/?.*#\1#')
[ -n "$HOST" ] || { echo "no function URL host" >&2; exit 1; }

if [ -z "$OAC_ID" ]; then
  OAC_ID=$(aws cloudfront list-origin-access-controls --query "OriginAccessControlList.Items[?Name=='$OAC_NAME'].Id | [0]" --output text)
  if [ "$OAC_ID" = "None" ] || [ -z "$OAC_ID" ]; then
    if [ "$DRY" = 1 ]; then OAC_ID="<new-oac-id>"; echo "(dry-run) would create Lambda OAC $OAC_NAME"
    else OAC_ID=$(aws cloudfront create-origin-access-control --origin-access-control-config "Name=$OAC_NAME,Description=hfy-api function URL,SigningProtocol=sigv4,SigningBehavior=always,OriginAccessControlOriginType=lambda" --query OriginAccessControl.Id --output text); fi
  fi
fi

WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
if [ -n "$CFG_FILE" ]; then cp "$CFG_FILE" "$WORK/raw.json"; ETAG=offline
else aws cloudfront get-distribution-config --id "$DIST" > "$WORK/raw.json"; ETAG=$(jq -r .ETag "$WORK/raw.json"); fi
jq -S '.DistributionConfig // .' "$WORK/raw.json" > "$WORK/before.json"

jq -S --arg id "$ORIGIN_ID" --arg host "$HOST" --arg oac "$OAC_ID" --arg cd "$CACHING_DISABLED" --arg orp "$ALL_VIEWER_EXCEPT_HOST" '
  ( {Id:$id, DomainName:$host, OriginPath:"", CustomHeaders:{Quantity:0},
     OriginAccessControlId:$oac,
     CustomOriginConfig:{HTTPPort:80,HTTPSPort:443,OriginProtocolPolicy:"https-only",OriginSslProtocols:{Quantity:1,Items:["TLSv1.2"]},OriginReadTimeout:30,OriginKeepaliveTimeout:5}} ) as $origin
  | ( {PathPattern:"/api/*", TargetOriginId:$id, ViewerProtocolPolicy:"redirect-to-https", Compress:true,
       AllowedMethods:{Quantity:7,Items:["GET","HEAD","OPTIONS","PUT","POST","PATCH","DELETE"],CachedMethods:{Quantity:2,Items:["GET","HEAD"]}},
       CachePolicyId:$cd, OriginRequestPolicyId:$orp, SmoothStreaming:false,
       LambdaFunctionAssociations:{Quantity:0}, FunctionAssociations:{Quantity:0}, FieldLevelEncryptionId:""} ) as $beh
  | .Origins.Items = ([.Origins.Items[] | select(.Id != $id)] + [$origin]) | .Origins.Quantity = (.Origins.Items | length)
  | .CacheBehaviors.Items = ([(.CacheBehaviors.Items // [])[] | select(.PathPattern != "/api/*")] + [$beh])
  | .CacheBehaviors.Quantity = (.CacheBehaviors.Items | length)
' "$WORK/before.json" > "$WORK/after.json"

if diff -u "$WORK/before.json" "$WORK/after.json" > "$WORK/diff.txt"; then echo "distribution $DIST already has origin $ORIGIN_ID and /api/* behavior: no change"; exit 0; fi
cat "$WORK/diff.txt" || true
[ "$DRY" = 1 ] && { echo "(dry-run) no changes made"; exit 0; }
aws cloudfront update-distribution --id "$DIST" --if-match "$ETAG" --distribution-config "file://$WORK/after.json" --query 'Distribution.Status' --output text
