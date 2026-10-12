#!/usr/bin/env bash
# Idempotently adds the hfy-api Function URL to a CloudFront distribution as a plain HTTPS custom origin (no OAC) that injects the secret
# X-Origin-Verify header (HFY-R43), plus the /api/* cache behavior.
#
# HFY-R58 (1): the legacy login still POSTs /api/check-allowed to the origin that serves it today (the hfy-check-allowed API Gateway,
# reached through the existing /api/* behavior), so the new /api/* must not shadow it. Before /api/* is pointed at hfy-api, the script
# pins a more-specific /api/check-allowed* behavior, cloned from whichever behavior serves /api/check-allowed now (same origin,
# policies and associations), immediately BEFORE the first behavior that matches that path. The pin is kept as is on every rerun and
# is never removed or retargeted here: HFY-TSK-069 retires it. If nothing but hfy-api (or only the default behavior) serves
# /api/check-allowed and no pin exists, the script refuses (exit 3) unless --legacy-origin names the origin to pin it to.
#
# Re-running against an already-matching distribution is a true no-op: no update-distribution call (see lib/cf-common.sh).
# Usage: add-api-behavior.sh [--dry-run] [--distribution E2JCDK3QLQNNYB] [--stack hfy-app] [--function-url URL] [--secret-name NAME]
#                            [--legacy-origin ORIGIN_ID] [--config-file FILE]
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
DIST=E2JCDK3QLQNNYB; STACK=hfy-app; DRY=0; FURL=""; CFG_FILE=""; SECRET=harrisonfamily/cloudfront/origin-verify; LEGACY_ORIGIN=""
ORIGIN_ID=hfy-api-origin; OUTPUT_KEY=FunctionUrl; PATTERN='/api/*'
PIN_PATTERN='/api/check-allowed*'; PIN_PATH='/api/check-allowed'
while [ $# -gt 0 ]; do case "$1" in
  --dry-run) DRY=1;; --distribution) DIST=$2; shift;; --stack) STACK=$2; shift;; --function-url) FURL=$2; shift;;
  --secret-name) SECRET=$2; shift;; --config-file) CFG_FILE=$2; shift;; --legacy-origin) LEGACY_ORIGIN=$2; shift;;
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
PIN=$(jq -nc --arg pattern "$PIN_PATTERN" --arg path "$PIN_PATH" --arg avoid "$ORIGIN_ID" --arg fb "$LEGACY_ORIGIN" \
  --argjson tpl "$(api_behavior "$PIN_PATTERN" "")" '{pattern:$pattern, path:$path, avoidOrigin:$avoid,
  fallbackOrigin:(if $fb == "" then null else $fb end), template:($tpl | with_entries(select(.value != null)))}')

if ! cf_jq -S --argjson origin "$ORIGIN" --argjson beh "$BEH" --argjson pin "$PIN" 'include "cf";
    resolve_pin($pin) as $pinBeh
    | upsert_origin($origin + {CustomHeaders:{Quantity:1,Items:[{HeaderName:"X-Origin-Verify",HeaderValue:env.OV}]}})
    | upsert_behavior($beh) | place_pin($pinBeh; $pin.path)
  ' "$CF_WORK/before.json" > "$CF_WORK/after.json" 2> "$CF_WORK/jq.err"; then
  sed -E 's/^jq: error \(at [^)]*\): //' "$CF_WORK/jq.err" >&2
  exit 3
fi
LEGACY=$(jq -r --arg p "$PIN_PATTERN" '[.CacheBehaviors.Items[] | select(.PathPattern == $p) | .TargetOriginId] | first' "$CF_WORK/after.json")
echo "legacy $PIN_PATH stays on origin $LEGACY via $PIN_PATTERN (ordered before $PATTERN; retired by HFY-TSK-069)"
if [ -n "$LEGACY_ORIGIN" ] && [ "$LEGACY_ORIGIN" != "$LEGACY" ]; then
  echo "note: --legacy-origin $LEGACY_ORIGIN not used: $PIN_PATH is already served by $LEGACY (an existing pin or behavior wins)"
fi
cf_apply "$DIST" "$DRY" "origin $ORIGIN_ID, $PATTERN and the $PIN_PATTERN legacy pin"
