#!/usr/bin/env bash
# Idempotently adds the hfy-auth-edge Function URL to a CloudFront distribution as a plain HTTPS custom origin (no OAC) that injects the secret
# X-Origin-Verify header (HFY-R43), plus the /auth/* and RFC 8414 root-discovery (/.well-known/oauth-authorization-server*) cache behaviors (HFY-R44).
# Usage: add-auth-behavior.sh [--dry-run] [--distribution E2JCDK3QLQNNYB] [--stack hfy-app] [--function-url URL] [--secret-name NAME] [--config-file FILE]
# The header value comes from $ORIGIN_VERIFY or Secrets Manager (harrisonfamily/cloudfront/origin-verify) and is never printed (diffs are redacted).
# --dry-run prints the redacted config diff and changes nothing. --config-file/--function-url allow a fully offline dry run.
set -euo pipefail
umask 077
DIST=E2JCDK3QLQNNYB; STACK=hfy-app; DRY=0; FURL=""; CFG_FILE=""; SECRET=harrisonfamily/cloudfront/origin-verify
ORIGIN_ID=hfy-auth-origin; OUTPUT_KEY=AuthFunctionUrl; PATTERNS='/auth/* /.well-known/oauth-authorization-server*'
CACHING_DISABLED=4135ea2d-6df8-44a3-9df3-4b5a84be39ad; ALL_VIEWER_EXCEPT_HOST=b689b0a8-53d0-40ab-baf2-68738e2966ac
while [ $# -gt 0 ]; do case "$1" in
  --dry-run) DRY=1;; --distribution) DIST=$2; shift;; --stack) STACK=$2; shift;; --function-url) FURL=$2; shift;;
  --secret-name) SECRET=$2; shift;; --config-file) CFG_FILE=$2; shift;; *) echo "unknown arg $1" >&2; exit 2;; esac; shift; done

[ -n "$FURL" ] || FURL=$(aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$OUTPUT_KEY'].OutputValue" --output text)
HOST=$(echo "$FURL" | sed -E 's#^https://([^/]+)/?.*#\1#')
[ -n "$HOST" ] || { echo "no function URL host" >&2; exit 1; }

OV="${ORIGIN_VERIFY:-}"
[ -n "$OV" ] || OV=$(aws secretsmanager get-secret-value --secret-id "$SECRET" --query SecretString --output text 2>/dev/null || true)
if [ -z "$OV" ]; then
  if [ "$DRY" = 1 ]; then OV="<origin-verify-secret>"; echo "(dry-run) origin-verify secret not readable; using a placeholder"
  else echo "cannot read secret $SECRET (run scripts/infra/create-origin-verify.sh)" >&2; exit 1; fi
fi
export OV
set -f; PJ=$(printf '%s\n' $PATTERNS | jq -R . | jq -sc .); set +f

WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
if [ -n "$CFG_FILE" ]; then cp "$CFG_FILE" "$WORK/raw.json"; ETAG=offline
else aws cloudfront get-distribution-config --id "$DIST" > "$WORK/raw.json"; ETAG=$(jq -r .ETag "$WORK/raw.json"); fi
jq -S '.DistributionConfig // .' "$WORK/raw.json" > "$WORK/before.json"

jq -S --arg id "$ORIGIN_ID" --arg host "$HOST" --arg cd "$CACHING_DISABLED" --arg orp "$ALL_VIEWER_EXCEPT_HOST" --argjson pats "$PJ" '
  ( {Id:$id, DomainName:$host, OriginPath:"",
     CustomHeaders:{Quantity:1,Items:[{HeaderName:"X-Origin-Verify",HeaderValue:env.OV}]},
     OriginAccessControlId:"",
     CustomOriginConfig:{HTTPPort:80,HTTPSPort:443,OriginProtocolPolicy:"https-only",OriginSslProtocols:{Quantity:1,Items:["TLSv1.2"]},OriginReadTimeout:30,OriginKeepaliveTimeout:5}} ) as $origin
  | ( $pats | map({PathPattern:., TargetOriginId:$id, ViewerProtocolPolicy:"redirect-to-https", Compress:true,
       AllowedMethods:{Quantity:7,Items:["GET","HEAD","OPTIONS","PUT","POST","PATCH","DELETE"],CachedMethods:{Quantity:2,Items:["GET","HEAD"]}},
       CachePolicyId:$cd, OriginRequestPolicyId:$orp, SmoothStreaming:false,
       LambdaFunctionAssociations:{Quantity:0}, FunctionAssociations:{Quantity:0}, FieldLevelEncryptionId:""}) ) as $behs
  | .Origins.Items = ([.Origins.Items[] | select(.Id != $id)] + [$origin]) | .Origins.Quantity = (.Origins.Items | length)
  | .CacheBehaviors.Items = ([(.CacheBehaviors.Items // [])[] | select(.PathPattern as $p | ($pats | any(. == $p)) | not)] + $behs)
  | .CacheBehaviors.Quantity = (.CacheBehaviors.Items | length)
' "$WORK/before.json" > "$WORK/after.json"

redact() { jq '(.. | objects | select(.HeaderName? == "X-Origin-Verify") | .HeaderValue) = "<redacted>"' "$1"; }
if cmp -s "$WORK/before.json" "$WORK/after.json"; then echo "distribution $DIST already has origin $ORIGIN_ID and the $PATTERNS behaviors: no change"; exit 0; fi
redact "$WORK/before.json" > "$WORK/before.red"; redact "$WORK/after.json" > "$WORK/after.red"
diff -u "$WORK/before.red" "$WORK/after.red" || true
cmp -s "$WORK/before.red" "$WORK/after.red" && echo "(only the X-Origin-Verify header value differs)"
[ "$DRY" = 1 ] && { echo "(dry-run) no changes made"; exit 0; }
aws cloudfront update-distribution --id "$DIST" --if-match "$ETAG" --distribution-config "file://$WORK/after.json" --query 'Distribution.Status' --output text
