#!/usr/bin/env bash
# Idempotently adds the private-data cache behaviors (HFY-TSK-080, HFY-R63): /person/*.json, /family/*, /event/*, /note/*,
# /place/*, /media/* on the site's S3 origin (the default behavior's origin unless --origin-id), each with the hfy-edge-gate
# Lambda@Edge function as its viewer-request association and CachingDisabled, so no response is ever shared between users and
# nothing is served without a verified io_id session. /person/*.json (not /person/*) because /person/ itself is the public
# person-page shell, and the shell relies on the default behavior's HFYAppendIndex function to resolve /person/ to index.html.
# Ordering: a new behavior is appended after the existing ones (api, auth, uploads, ...). When an existing broader behavior
# (for example the legacy /person/*) would shadow a gated pattern, the gated one is placed just ahead of it. Nothing else changes.
# The behaviors are merged in place, so re-running against an already-matching distribution is a true no-op (no update-distribution).
# --remove is the rollback: it deletes exactly these behaviors (only ones that carry the hfy-edge-gate association), after which
# the data paths fall back to the default behavior and are public again.
# Usage: add-data-gate-behaviors.sh [--dry-run] [--remove] [--distribution E2JCDK3QLQNNYB] [--stack hfy-edge-gate] [--version-arn ARN]
#                                   [--function-name hfy-edge-gate] [--origin-id ORIGIN_ID] [--config-file FILE]
# The version ARN (qualified, ...:function:hfy-edge-gate:<n>) comes from --version-arn or the EdgeGateVersionArn output of the
# us-east-1 stack. --dry-run prints the config diff and changes nothing. --config-file/--version-arn allow a fully offline dry run
# (--config-file is refused without --dry-run). Before a real update the pre-change config is saved under
# ${HFY_CF_BACKUP_DIR:-~/.local/state/hfy-infra/cloudfront} for rollback.
# shellcheck disable=SC2016 # the jq programs are single-quoted on purpose
# shellcheck source-path=SCRIPTDIR
set -euo pipefail
umask 077
# shellcheck source=lib/cf-common.sh
. "$(cd "$(dirname "$0")" && pwd)/lib/cf-common.sh"
DIST=E2JCDK3QLQNNYB; STACK=hfy-edge-gate; DRY=0; REMOVE=0; CFG_FILE=""; VARN=""; ORIGIN_ID=""; FN=hfy-edge-gate
OUTPUT_KEY=EdgeGateVersionArn; PATTERNS=('/person/*.json' '/family/*' '/event/*' '/note/*' '/place/*' '/media/*')
while [ $# -gt 0 ]; do case "$1" in
  --dry-run) DRY=1;; --remove) REMOVE=1;; --distribution) DIST=$2; shift;; --stack) STACK=$2; shift;; --version-arn) VARN=$2; shift;;
  --function-name) FN=$2; shift;; --origin-id) ORIGIN_ID=$2; shift;; --config-file) CFG_FILE=$2; shift;;
  *) echo "unknown arg $1" >&2; exit 2;; esac; shift; done
cf_check_args "$CFG_FILE" "$DRY"
PJ=$(printf '%s\n' "${PATTERNS[@]}" | jq -R . | jq -sc .)
cf_load "$DIST" "$CFG_FILE"

if [ "$REMOVE" = 1 ]; then
  cf_jq -S --argjson pats "$PJ" --arg fn "$FN" 'include "cf"; remove_gate_behaviors($pats; $fn)' "$CF_WORK/before.json" > "$CF_WORK/after.json"
  cf_apply "$DIST" "$DRY" "no $FN-gated data behaviors (${PATTERNS[*]})"
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
echo "gating ${PATTERNS[*]} on origin $ORIGIN_ID with $VARN (CachingDisabled)"

cf_jq -S --arg id "$ORIGIN_ID" --arg arn "$VARN" --argjson pats "$PJ" 'include "cf";
  reduce $pats[] as $p (.;
    ({PathPattern:$p, TargetOriginId:$id, ViewerProtocolPolicy:"redirect-to-https", Compress:true,
      AllowedMethods:{Quantity:2,Items:["GET","HEAD"],CachedMethods:{Quantity:2,Items:["GET","HEAD"]}},
      CachePolicyId:env.CACHING_DISABLED, OriginRequestPolicyId:null, SmoothStreaming:false,
      TrustedSigners:{Enabled:false,Quantity:0}, TrustedKeyGroups:{Enabled:false,Quantity:0},
      LambdaFunctionAssociations:{Quantity:1,Items:[{LambdaFunctionARN:$arn,EventType:"viewer-request",IncludeBody:false}]},
      FunctionAssociations:{Quantity:0}, FieldLevelEncryptionId:"",
      ForwardedValues:null, MinTTL:null, DefaultTTL:null, MaxTTL:null}) as $b
    | upsert_behavior($b) | place_before_shadow($p; $p | gsub("\\*"; "x")))
' "$CF_WORK/before.json" > "$CF_WORK/after.json"

cf_apply "$DIST" "$DRY" "the data-gate behaviors (${PATTERNS[*]}) on $VARN"
