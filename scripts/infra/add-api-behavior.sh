#!/usr/bin/env bash
# Idempotently adds the hfy-api Function URL to a CloudFront distribution as a plain HTTPS custom origin (no OAC) that injects the secret
# X-Origin-Verify header (HFY-R43), plus the /api/* cache behavior.
#
# An existing /api/* behavior is retargeted in place; every other behavior and origin is left as it is (the script never deletes).
# The legacy /api/check-allowed* pin and its --legacy-origin flag are gone: the hfy-check-allowed Lambda, its API Gateway and that
# CloudFront behavior and origin were retired on 2026-10-14 (HFY-TSK-326, ruling P2-R48), so /api/check-allowed now reaches hfy-api.
#
# Re-running against an already-matching distribution is a true no-op: no update-distribution call (see lib/cf-common.sh).
# Usage: add-api-behavior.sh [--dry-run] [--distribution E2JCDK3QLQNNYB] [--stack hfy-app] [--function-url URL] [--secret-name NAME]
#                            [--config-file FILE]
# The header value comes from $ORIGIN_VERIFY or Secrets Manager (harrisonfamily/cloudfront/origin-verify) and is never printed (diffs are redacted).
# --dry-run prints the redacted config diff and changes nothing. --config-file/--function-url allow a fully offline dry run
# (--config-file is refused without --dry-run). Before a real update the pre-change config is saved under
# ${HFY_CF_BACKUP_DIR:-~/.local/state/hfy-infra/cloudfront} for rollback.
# shellcheck disable=SC2016 # the jq programs are single-quoted on purpose
# shellcheck source-path=SCRIPTDIR
set -euo pipefail
umask 077
# shellcheck source=lib/cf-common.sh
. "$(cd "$(dirname "$0")" && pwd)/lib/cf-common.sh"
DIST=E2JCDK3QLQNNYB; STACK=hfy-app; DRY=0; FURL=""; CFG_FILE=""; SECRET=harrisonfamily/cloudfront/origin-verify
ORIGIN_ID=hfy-api-origin; OUTPUT_KEY=FunctionUrl; PATTERN='/api/*'
while [ $# -gt 0 ]; do case "$1" in
  --dry-run) DRY=1;; --distribution) DIST=$2; shift;; --stack) STACK=$2; shift;; --function-url) FURL=$2; shift;;
  --secret-name) SECRET=$2; shift;; --config-file) CFG_FILE=$2; shift;;
  *) echo "unknown arg $1" >&2; exit 2;; esac; shift; done
cf_check_args "$CFG_FILE" "$DRY"

[ -n "$FURL" ] || FURL=$(cf_stack_output "$STACK" "$OUTPUT_KEY")
HOST=$(echo "$FURL" | sed -E 's#^https://([^/]+)/?.*#\1#')
[ -n "$HOST" ] || { echo "no function URL host" >&2; exit 1; }
cf_origin_verify "$SECRET" "$DRY" "$([ -n "$CFG_FILE" ] && echo 1 || echo 0)"
cf_load "$DIST" "$CFG_FILE"

# The X-Origin-Verify value is only ever read from the environment inside jq (env.OV), never put on a command line.
ORIGIN=$(jq -nc --arg id "$ORIGIN_ID" --arg host "$HOST" '{Id:$id, DomainName:$host, OriginPath:"", OriginAccessControlId:"",
  CustomOriginConfig:{HTTPPort:80,HTTPSPort:443,OriginProtocolPolicy:"https-only",OriginSslProtocols:{Quantity:1,Items:["TLSv1.2"]},OriginReadTimeout:30,OriginKeepaliveTimeout:5}}')
# Full behavior for a dynamic, uncached, header-forwarding API route (Host excluded so the Function URL sees its own host).
api_behavior() { # PATTERN TARGET
  jq -nc --arg p "$1" --arg t "$2" '{PathPattern:$p, TargetOriginId:$t, ViewerProtocolPolicy:"redirect-to-https", Compress:true,
    AllowedMethods:{Quantity:7,Items:["GET","HEAD","OPTIONS","PUT","POST","PATCH","DELETE"],CachedMethods:{Quantity:2,Items:["GET","HEAD"]}},
    CachePolicyId:env.CACHING_DISABLED, OriginRequestPolicyId:env.ALL_VIEWER_EXCEPT_HOST, SmoothStreaming:false,
    TrustedSigners:{Enabled:false,Quantity:0}, TrustedKeyGroups:{Enabled:false,Quantity:0},
    LambdaFunctionAssociations:{Quantity:0}, FunctionAssociations:{Quantity:0}, FieldLevelEncryptionId:"",
    ForwardedValues:null, MinTTL:null, DefaultTTL:null, MaxTTL:null}'
}
BEH=$(api_behavior "$PATTERN" "$ORIGIN_ID")
cf_jq -S --argjson origin "$ORIGIN" --argjson beh "$BEH" 'include "cf";
    upsert_origin($origin + {CustomHeaders:{Quantity:1,Items:[{HeaderName:"X-Origin-Verify",HeaderValue:env.OV}]}})
    | upsert_behavior($beh)
  ' "$CF_WORK/before.json" > "$CF_WORK/after.json"
cf_apply "$DIST" "$DRY" "origin $ORIGIN_ID and $PATTERN"
