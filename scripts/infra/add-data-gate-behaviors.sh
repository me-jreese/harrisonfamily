#!/usr/bin/env bash
# Idempotently adds the private-data cache behaviors (HFY-TSK-080, HFY-R63): /person/*.json, /family/*, /event/*, /note/*,
# /place/*, /media/*, /uploads/* on the site's S3 origin (the default behavior's origin unless --origin-id), each with the
# hfy-edge-gate Lambda@Edge function as its viewer-request association and CachingDisabled, so no response is ever shared between
# users and nothing is served without a verified io_id session. /person/*.json (not /person/*) because /person/ itself is the
# public person-page shell, and the shell relies on the default behavior's HFYAppendIndex function to resolve /person/ to index.html.
# HFY-R65: Cloudflare proxies harrisonfamily.us in front of CloudFront and caches by default (images, SVG, PDF under /media/), so
# CachingDisabled alone does not stop a later stranger from getting a member's response out of Cloudflare without ever reaching
# the gate. Every gated behavior therefore also gets a response headers policy that overrides Cache-Control to "private, no-store"
# on every response (Cloudflare and browsers do not store those): hfy-private-no-store for the six data patterns. The script looks
# the policy up by name and creates it when it is missing (or puts it back when it no longer forces that header), so reruns change
# nothing. The gate's own 401/302 carry the same header (edge-gate/src/gate.mjs).
# /uploads/* (member post photos under uploads/posts/<ulid>/) is the seventh pattern, but it is not created: add-uploads-behavior.sh
# owns it, with the app stack's sandbox policy (nosniff + CSP sandbox) and CachingOptimized, publicly readable by anyone holding
# the URL. Here it is updated IN PLACE (position, and the origin it already has, are kept): the gate association, CachingDisabled,
# and the response headers policy hfy-uploads-private, which keeps nosniff + the sandbox CSP and adds Cache-Control: private,
# no-store (created or repaired by name, like the first one). Presigned S3 PUT uploads go straight to the bucket, not through
# CloudFront, so they are unaffected. When no /uploads/* behavior exists it is created, already gated.
# Ordering: a new behavior is appended after the existing ones (api, auth, uploads, ...). When an existing broader behavior
# (for example the legacy /person/*) would shadow a gated pattern, the gated one is placed just ahead of it. Nothing else changes.
# The behaviors are merged in place, so re-running against an already-matching distribution is a true no-op (no update-distribution).
# --remove is the rollback: it deletes exactly the six data behaviors (only ones that carry the hfy-edge-gate association), after
# which the data paths fall back to the default behavior and are public again, and puts /uploads/* back to its previous ungated
# state in place (no association, CachingOptimized, and the app stack's UploadsResponseHeadersPolicyId, which is what
# add-uploads-behavior.sh sets; read from the --app-stack output unless --restore-uploads-policy-id). The (then unused) response
# headers policies are kept.
# Usage: add-data-gate-behaviors.sh [--dry-run] [--remove] [--distribution E2JCDK3QLQNNYB] [--stack hfy-edge-gate] [--version-arn ARN]
#                                   [--function-name hfy-edge-gate] [--origin-id ORIGIN_ID] [--config-file FILE]
#                                   [--response-headers-policy-id ID] [--response-headers-policy-name hfy-private-no-store]
#                                   [--uploads-response-headers-policy-id ID] [--uploads-response-headers-policy-name hfy-uploads-private]
#                                   [--app-stack hfy-app] [--restore-uploads-policy-id ID]
# The version ARN (qualified, ...:function:hfy-edge-gate:<n>) comes from --version-arn or the EdgeGateVersionArn output of the
# us-east-1 stack. --response-headers-policy-id / --uploads-response-headers-policy-id skip that policy's lookup/create and use the
# ID as given. --dry-run prints the config diff and changes nothing (it never creates or updates a policy). --config-file/
# --version-arn allow a fully offline dry run that makes no AWS call (the policy ids are then placeholders; --config-file is
# refused without --dry-run). Before a real update the pre-change config is saved under
# ${HFY_CF_BACKUP_DIR:-~/.local/state/hfy-infra/cloudfront} for rollback.
# shellcheck disable=SC2016 # the jq programs are single-quoted on purpose
# shellcheck source-path=SCRIPTDIR
set -euo pipefail
umask 077
# shellcheck source=lib/cf-common.sh
. "$(cd "$(dirname "$0")" && pwd)/lib/cf-common.sh"
DIST=E2JCDK3QLQNNYB; STACK=hfy-edge-gate; DRY=0; REMOVE=0; CFG_FILE=""; VARN=""; ORIGIN_ID=""; FN=hfy-edge-gate
OUTPUT_KEY=EdgeGateVersionArn
PATTERNS=('/person/*.json' '/family/*' '/event/*' '/note/*' '/place/*' '/media/*' '/uploads/*')
UPLOADS_PATTERN='/uploads/*'
RHP=""; RHP_NAME=hfy-private-no-store; CACHE_CONTROL="private, no-store"
URHP=""; URHP_NAME=hfy-uploads-private; APP_STACK=hfy-app; RESTORE_URHP=""
while [ $# -gt 0 ]; do case "$1" in
  --dry-run) DRY=1;; --remove) REMOVE=1;; --distribution) DIST=$2; shift;; --stack) STACK=$2; shift;; --version-arn) VARN=$2; shift;;
  --function-name) FN=$2; shift;; --origin-id) ORIGIN_ID=$2; shift;; --config-file) CFG_FILE=$2; shift;;
  --response-headers-policy-id) RHP=$2; shift;; --response-headers-policy-name) RHP_NAME=$2; shift;;
  --uploads-response-headers-policy-id) URHP=$2; shift;; --uploads-response-headers-policy-name) URHP_NAME=$2; shift;;
  --app-stack) APP_STACK=$2; shift;; --restore-uploads-policy-id) RESTORE_URHP=$2; shift;;
  *) echo "unknown arg $1" >&2; exit 2;; esac; shift; done
cf_check_args "$CFG_FILE" "$DRY"
DATA_PATTERNS=()
for p in "${PATTERNS[@]}"; do [ "$p" = "$UPLOADS_PATTERN" ] || DATA_PATTERNS+=("$p"); done
PJ=$(printf '%s\n' "${DATA_PATTERNS[@]}" | jq -R . | jq -sc .) # created, and deleted by --remove; /uploads/* is only ever updated in place
cf_load "$DIST" "$CFG_FILE"

if [ "$REMOVE" = 1 ]; then
  # The uploads policy to restore is only needed (and only looked up) when /uploads/* is currently gated by us.
  RESTORE_RHP=""
  if cf_jq -e --arg p "$UPLOADS_PATTERN" --arg fn "$FN" 'include "cf"; behavior_gated($p; $fn)' "$CF_WORK/before.json" >/dev/null; then
    RESTORE_RHP=$RESTORE_URHP
    if [ -z "$RESTORE_RHP" ] && [ -n "$CFG_FILE" ]; then RESTORE_RHP="<$APP_STACK UploadsResponseHeadersPolicyId>"; echo "(dry-run) uploads policy to restore not looked up (offline); using a placeholder id"
    elif [ -z "$RESTORE_RHP" ]; then RESTORE_RHP=$(cf_stack_output "$APP_STACK" UploadsResponseHeadersPolicyId) || { echo "pass --restore-uploads-policy-id ID to name the response headers policy $UPLOADS_PATTERN gets back" >&2; exit 1; }
    fi
  fi
  cf_jq -S --argjson pats "$PJ" --arg fn "$FN" --arg up "$UPLOADS_PATTERN" --arg cp "$CACHING_OPTIMIZED" --arg rhp "$RESTORE_RHP" \
    'include "cf"; remove_gate_behaviors($pats; $fn) | ungate_behavior($up; $fn; $cp; $rhp)' "$CF_WORK/before.json" > "$CF_WORK/after.json"
  cf_apply "$DIST" "$DRY" "no $FN-gated data behaviors (${DATA_PATTERNS[*]}) and $UPLOADS_PATTERN back to its ungated state"
  exit 0
fi

# Lambda@Edge needs a published version: $LATEST and unqualified ARNs are rejected by CloudFront, so refuse them up front.
[ -n "$VARN" ] || VARN=$( (export AWS_DEFAULT_REGION=us-east-1 AWS_REGION=us-east-1; cf_stack_output "$STACK" "$OUTPUT_KEY") )
case "$VARN" in
  arn:aws:lambda:us-east-1:*:function:"$FN":[0-9]*) ;;
  *) echo "version ARN must be a qualified us-east-1 ARN of $FN (arn:aws:lambda:us-east-1:<acct>:function:$FN:<version>), got: $VARN" >&2; exit 2;;
esac
case "${VARN##*:}" in *[!0-9]*) echo "version ARN must end in a numeric version, got: $VARN" >&2; exit 2;; esac

[ -n "$ORIGIN_ID" ] || ORIGIN_ID=$(jq -r '.DefaultCacheBehavior.TargetOriginId // empty' "$CF_WORK/before.json")
if ! jq -e --arg id "$ORIGIN_ID" 'any((.Origins.Items // [])[]; .Id == $id)' "$CF_WORK/before.json" >/dev/null; then
  echo "origin '$ORIGIN_ID' is not in distribution $DIST (pass --origin-id)" >&2; exit 1
fi

# HFY-R65: the Cache-Control override policy. Resolved only after every input above is valid, so a refused run creates nothing.
if [ -z "$RHP" ]; then
  jq -n --arg name "$RHP_NAME" --arg v "$CACHE_CONTROL" '{Name:$name,
    Comment:"HFY-R65: gated family data is never stored by Cloudflare or a shared browser cache",
    CustomHeadersConfig:{Quantity:1,Items:[{Header:"Cache-Control",Value:$v,Override:true}]}}' > "$CF_WORK/rhp.json"
  cf_response_headers_policy "$RHP_NAME" "$CF_WORK/rhp.json" "$CACHE_CONTROL" "$DRY" "$([ -n "$CFG_FILE" ] && echo 1 || echo 0)"
  RHP=$CF_RHP_ID
fi
if [ -z "$URHP" ]; then
  jq -n --arg name "$URHP_NAME" --arg v "$CACHE_CONTROL" --arg csp "$UPLOADS_CSP" '{Name:$name,
    Comment:"HFY: members-only /uploads/*: nosniff, sandbox CSP, Cache-Control private no-store",
    SecurityHeadersConfig:{ContentTypeOptions:{Override:true}, ContentSecurityPolicy:{ContentSecurityPolicy:$csp, Override:true}},
    CustomHeadersConfig:{Quantity:1,Items:[{Header:"Cache-Control",Value:$v,Override:true}]}}' > "$CF_WORK/urhp.json"
  cf_response_headers_policy "$URHP_NAME" "$CF_WORK/urhp.json" "$CACHE_CONTROL" "$DRY" "$([ -n "$CFG_FILE" ] && echo 1 || echo 0)" "$UPLOADS_CSP"
  URHP=$CF_RHP_ID
fi
echo "gating ${PATTERNS[*]} on origin $ORIGIN_ID with $VARN (CachingDisabled, response headers policy $RHP: Cache-Control: $CACHE_CONTROL; $UPLOADS_PATTERN keeps its origin and gets policy $URHP)"

cf_jq -S --arg id "$ORIGIN_ID" --arg arn "$VARN" --arg rhp "$RHP" --arg urhp "$URHP" --arg up "$UPLOADS_PATTERN" --argjson pats "$PJ" 'include "cf";
  def gated($p; $origin; $policy):
    {PathPattern:$p, TargetOriginId:$origin, ViewerProtocolPolicy:"redirect-to-https", Compress:true,
      AllowedMethods:{Quantity:2,Items:["GET","HEAD"],CachedMethods:{Quantity:2,Items:["GET","HEAD"]}},
      CachePolicyId:env.CACHING_DISABLED, ResponseHeadersPolicyId:$policy, OriginRequestPolicyId:null, SmoothStreaming:false,
      TrustedSigners:{Enabled:false,Quantity:0}, TrustedKeyGroups:{Enabled:false,Quantity:0},
      LambdaFunctionAssociations:{Quantity:1,Items:[{LambdaFunctionARN:$arn,EventType:"viewer-request",IncludeBody:false}]},
      FunctionAssociations:{Quantity:0}, FieldLevelEncryptionId:"",
      ForwardedValues:null, MinTTL:null, DefaultTTL:null, MaxTTL:null};
  reduce $pats[] as $p (.; upsert_behavior(gated($p; $id; $rhp)) | place_before_shadow($p; $p | gsub("\\*"; "x")))
  | (([.CacheBehaviors.Items[]? | select(.PathPattern == $up) | .TargetOriginId] | first) // $id) as $uo
  | upsert_behavior(gated($up; $uo; $urhp)) | place_before_shadow($up; $up | gsub("\\*"; "x"))
' "$CF_WORK/before.json" > "$CF_WORK/after.json"

cf_apply "$DIST" "$DRY" "the data-gate behaviors (${PATTERNS[*]}) on $VARN with response headers policies $RHP and $URHP"
