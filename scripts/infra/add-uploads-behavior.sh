#!/usr/bin/env bash
# Idempotently adds the /uploads/* cache behavior (HFY-R58 (2)): member post photos live under uploads/posts/<ulid>/ in the site
# bucket and are served from the bucket's S3 origin (the default behavior's origin unless --origin-id) with the stack's
# UploadsResponseHeadersPolicy attached: X-Content-Type-Options: nosniff and
# Content-Security-Policy: sandbox; default-src 'none'; img-src 'self'. So even a mislabelled upload can never run script on
# harrisonfamily.us. GET/HEAD only, CachingOptimized (keys are immutable: one ULID per upload).
# The behavior is merged in place, so re-running against an already-matching distribution is a true no-op (no update-distribution).
# This is the PUBLIC (ungated) state. add-data-gate-behaviors.sh later makes /uploads/* members-only (hfy-edge-gate association,
# CachingDisabled, the hfy-uploads-private policy: same security headers plus Cache-Control: private, no-store). A rerun of this
# script must never undo that: when the existing /uploads/* behavior carries the gate association (--gate-function-name) it is left
# exactly as it is and the script prints "no change". Ungate it deliberately with add-data-gate-behaviors.sh --remove.
# Usage: add-uploads-behavior.sh [--dry-run] [--distribution E2JCDK3QLQNNYB] [--stack hfy-app] [--response-headers-policy-id ID]
#                                [--origin-id ORIGIN_ID] [--config-file FILE] [--gate-function-name hfy-edge-gate]
# --dry-run prints the config diff and changes nothing. --config-file/--response-headers-policy-id allow a fully offline dry run
# (--config-file is refused without --dry-run). Before a real update the pre-change config is saved under
# ${HFY_CF_BACKUP_DIR:-~/.local/state/hfy-infra/cloudfront} for rollback.
# shellcheck disable=SC2016 # the jq programs are single-quoted on purpose
# shellcheck source-path=SCRIPTDIR
set -euo pipefail
umask 077
# shellcheck source=lib/cf-common.sh
. "$(cd "$(dirname "$0")" && pwd)/lib/cf-common.sh"
DIST=E2JCDK3QLQNNYB; STACK=hfy-app; DRY=0; CFG_FILE=""; RHP=""; ORIGIN_ID=""; GATE_FN=hfy-edge-gate
OUTPUT_KEY=UploadsResponseHeadersPolicyId; PATTERN='/uploads/*'
while [ $# -gt 0 ]; do case "$1" in
  --dry-run) DRY=1;; --distribution) DIST=$2; shift;; --stack) STACK=$2; shift;; --response-headers-policy-id) RHP=$2; shift;;
  --origin-id) ORIGIN_ID=$2; shift;; --config-file) CFG_FILE=$2; shift;; --gate-function-name) GATE_FN=$2; shift;; *) echo "unknown arg $1" >&2; exit 2;; esac; shift; done
cf_check_args "$CFG_FILE" "$DRY"

cf_load "$DIST" "$CFG_FILE"
if cf_jq -e --arg p "$PATTERN" --arg fn "$GATE_FN" 'include "cf"; behavior_gated($p; $fn)' "$CF_WORK/before.json" >/dev/null; then
  echo "$PATTERN is members-only ($GATE_FN association, add-data-gate-behaviors.sh): left as it is. add-data-gate-behaviors.sh --remove ungates it."
  cp "$CF_WORK/before.json" "$CF_WORK/after.json"
  cf_apply "$DIST" "$DRY" "the members-only $PATTERN behavior"
  exit 0
fi
[ -n "$RHP" ] || RHP=$(cf_stack_output "$STACK" "$OUTPUT_KEY")
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
