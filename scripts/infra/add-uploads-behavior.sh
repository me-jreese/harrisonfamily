#!/usr/bin/env bash
# Idempotently adds the /uploads/* cache behavior (HFY-R58 (2)): member post photos live under uploads/posts/<ulid>/ in the site
# bucket and are served from the bucket's S3 origin (the default behavior's origin unless --origin-id) with the stack's
# UploadsResponseHeadersPolicy attached: X-Content-Type-Options: nosniff and
# Content-Security-Policy: sandbox; default-src 'none'; img-src 'self'. So even a mislabelled upload can never run script on
# harrisonfamily.us. GET/HEAD only, CachingOptimized (keys are immutable: one ULID per upload).
# The behavior is merged in place, so re-running against an already-matching distribution is a true no-op (no update-distribution).
# Usage: add-uploads-behavior.sh [--dry-run] [--distribution E2JCDK3QLQNNYB] [--stack hfy-app] [--response-headers-policy-id ID]
#                                [--origin-id ORIGIN_ID] [--config-file FILE]
# --dry-run prints the config diff and changes nothing. --config-file/--response-headers-policy-id allow a fully offline dry run
# (--config-file is refused without --dry-run). Before a real update the pre-change config is saved under
# ${HFY_CF_BACKUP_DIR:-~/.local/state/hfy-infra/cloudfront} for rollback.
# shellcheck disable=SC2016 # the jq programs are single-quoted on purpose
# shellcheck source-path=SCRIPTDIR
set -euo pipefail
umask 077
# shellcheck source=lib/cf-common.sh
. "$(cd "$(dirname "$0")" && pwd)/lib/cf-common.sh"
DIST=E2JCDK3QLQNNYB; STACK=hfy-app; DRY=0; CFG_FILE=""; RHP=""; ORIGIN_ID=""
OUTPUT_KEY=UploadsResponseHeadersPolicyId; PATTERN='/uploads/*'
while [ $# -gt 0 ]; do case "$1" in
  --dry-run) DRY=1;; --distribution) DIST=$2; shift;; --stack) STACK=$2; shift;; --response-headers-policy-id) RHP=$2; shift;;
  --origin-id) ORIGIN_ID=$2; shift;; --config-file) CFG_FILE=$2; shift;; *) echo "unknown arg $1" >&2; exit 2;; esac; shift; done
cf_check_args "$CFG_FILE" "$DRY"

[ -n "$RHP" ] || RHP=$(cf_stack_output "$STACK" "$OUTPUT_KEY")
cf_load "$DIST" "$CFG_FILE"
[ -n "$ORIGIN_ID" ] || ORIGIN_ID=$(jq -r '.DefaultCacheBehavior.TargetOriginId // empty' "$CF_WORK/before.json")
if ! jq -e --arg id "$ORIGIN_ID" 'any((.Origins.Items // [])[]; .Id == $id)' "$CF_WORK/before.json" >/dev/null; then
  echo "origin '$ORIGIN_ID' is not in distribution $DIST (pass --origin-id)" >&2; exit 1
fi
echo "serving $PATTERN from origin $ORIGIN_ID with response headers policy $RHP"

cf_jq -S --arg id "$ORIGIN_ID" --arg p "$PATTERN" --arg rhp "$RHP" 'include "cf";
  upsert_behavior({PathPattern:$p, TargetOriginId:$id, ViewerProtocolPolicy:"redirect-to-https", Compress:true,
    AllowedMethods:{Quantity:2,Items:["GET","HEAD"],CachedMethods:{Quantity:2,Items:["GET","HEAD"]}},
    CachePolicyId:env.CACHING_OPTIMIZED, ResponseHeadersPolicyId:$rhp, OriginRequestPolicyId:null, SmoothStreaming:false,
    TrustedSigners:{Enabled:false,Quantity:0}, TrustedKeyGroups:{Enabled:false,Quantity:0},
    LambdaFunctionAssociations:{Quantity:0}, FunctionAssociations:{Quantity:0}, FieldLevelEncryptionId:"",
    ForwardedValues:null, MinTTL:null, DefaultTTL:null, MaxTTL:null})
' "$CF_WORK/before.json" > "$CF_WORK/after.json"

cf_apply "$DIST" "$DRY" "the $PATTERN behavior with response headers policy $RHP"
