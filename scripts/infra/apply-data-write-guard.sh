#!/usr/bin/env bash
# The data-prefix write guard (HFY-TSK-151; BRD2 D2-05, 4.4 and 11.4; review SI-05, DL-01): a bucket-policy deny that makes the
# render Lambda the only writer of the rendered family data once RENDER_MODE=live. Applied by the cutover (cutover-live-render)
# BEFORE the live render, under io's G-cutover approval, never by CI and never by a workflow.
#
#   HfyDataWriteGuardRecords    Deny s3:PutObject, s3:DeleteObject, s3:DeleteObjectVersion on person/*.json, family/*, event/*,
#                               note/*, place/* and media/*.json, for every principal except the renderers and break-glass.
#   HfyDataWriteGuardMediaDelete  Deny s3:DeleteObject, s3:DeleteObjectVersion on media/* (binaries included), same exceptions
#                               plus hfy-api: the exception covers media binaries only (Put is not denied there, and hfy-api
#                               deletes the staging copy after a graduation). hfy-api is NOT an exception to the *.json statement.
# Exceptions (matched on aws:PrincipalArn with ArnNotLike): hfy-sync-render, hfy-graph-render, hfy-data-breakglass.
# person/index.html (every PUBLIC_PERSON_FILES key) is outside both statements, so the CI deploy role keeps deploying the person
# shell. A test pins the Put patterns to ci.manifest.yaml deploy.exclude, so the two cannot drift. The statements are merged into the
# bucket's current policy: every other statement is kept as it is, and a rerun replaces only the two Sids above (no change when the
# merge is identical, so a rerun makes no put-bucket-policy call). The pre-change policy is saved under
# ${HFY_S3_BACKUP_DIR:-~/.local/state/hfy-infra/s3-policy} before a real put.
#
# Usage: apply-data-write-guard.sh --dry-run | --simulate | --confirm-g-cutover [--remove] [options]
#   --dry-run              print the merged policy (and a summary); change nothing. Offline with --policy-file.
#   --simulate             run the allow/deny matrix with `aws iam simulate-custom-policy` against the merged policy; changes nothing.
#   --confirm-g-cutover    required for a real put-bucket-policy: io's G-cutover approval is on record for this run.
#   --remove               the policy-level rollback: drop the two guard statements, keep every other one (the primary rollback is
#                          RENDER_MODE=off, which needs no policy change; see docs/how-to/sync-gramps-with-the-website.md).
#   --bucket NAME          default: the s3_static bucket of ci.manifest.yaml (harrisonfamily-frontend).
#   --account-id ID        default: aws sts get-caller-identity (a placeholder with --dry-run/--simulate and --policy-file).
#   --policy-file FILE     read the current policy from FILE (use {} or an empty file for none) instead of the bucket; refused for a real put.
#   --render-role/--graph-role/--api-role/--breakglass-role/--deploy-role NAME   role names (defaults: hfy-sync-render-role,
#                          hfy-graph-render-role, hfy-api-role, hfy-data-breakglass, harrisonfamily-github-deploy-role).
# Needs aws, jq. Prints no secret; the policy holds role ARNs only.
# shellcheck disable=SC2016 # the jq programs are single-quoted on purpose
set -euo pipefail
umask 077
BUCKET=harrisonfamily-frontend; ACCOUNT=""; POLICY_FILE=""; DRY=0; SIM=0; REMOVE=0; CONFIRM=0
RENDER_ROLE=hfy-sync-render-role; GRAPH_ROLE=hfy-graph-render-role; API_ROLE=hfy-api-role
BREAKGLASS_ROLE=hfy-data-breakglass; DEPLOY_ROLE=harrisonfamily-github-deploy-role
SID_RECORDS=HfyDataWriteGuardRecords; SID_MEDIA=HfyDataWriteGuardMediaDelete
PLACEHOLDER_ACCOUNT=123456789012
while [ $# -gt 0 ]; do case "$1" in
  --dry-run) DRY=1;; --simulate) SIM=1;; --remove) REMOVE=1;; --confirm-g-cutover) CONFIRM=1;;
  --bucket) BUCKET=$2; shift;; --account-id) ACCOUNT=$2; shift;; --policy-file) POLICY_FILE=$2; shift;;
  --render-role) RENDER_ROLE=$2; shift;; --graph-role) GRAPH_ROLE=$2; shift;; --api-role) API_ROLE=$2; shift;;
  --breakglass-role) BREAKGLASS_ROLE=$2; shift;; --deploy-role) DEPLOY_ROLE=$2; shift;;
  *) echo "unknown arg $1" >&2; exit 2;; esac; shift; done
if [ "$DRY$SIM$CONFIRM" = 000 ]; then
  echo "refusing to change the bucket policy without --confirm-g-cutover (io's G-cutover approval); use --dry-run to look first" >&2; exit 2
fi
if [ -n "$POLICY_FILE" ] && [ "$DRY$SIM" = 00 ]; then
  echo "refusing to put a policy merged from --policy-file (it may be stale); use --dry-run or --simulate" >&2; exit 2
fi
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT

if [ -z "$ACCOUNT" ]; then
  if [ -n "$POLICY_FILE" ]; then ACCOUNT=$PLACEHOLDER_ACCOUNT
  else ACCOUNT=$(aws sts get-caller-identity --query Account --output text); fi
fi
case "$ACCOUNT" in [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) ;; *) echo "account id must be 12 digits" >&2; exit 2;; esac
role_arn() { printf 'arn:aws:iam::%s:role/%s' "$ACCOUNT" "$1"; }

# --- the current policy ------------------------------------------------------------------------------------------------------
if [ -n "$POLICY_FILE" ]; then
  if [ -s "$POLICY_FILE" ]; then cp "$POLICY_FILE" "$W/current.json"; else echo '{}' > "$W/current.json"; fi
else
  if aws s3api get-bucket-policy --bucket "$BUCKET" --query Policy --output text > "$W/current.raw" 2> "$W/current.err"; then
    cp "$W/current.raw" "$W/current.json"
  elif grep -q NoSuchBucketPolicy "$W/current.err"; then echo '{}' > "$W/current.json"
  else cat "$W/current.err" >&2; echo "cannot read the bucket policy of $BUCKET" >&2; exit 1; fi
fi
jq -e 'type == "object"' "$W/current.json" >/dev/null || { echo "the current policy is not a JSON object" >&2; exit 1; }

# --- the merge ---------------------------------------------------------------------------------------------------------------
jq -n --arg b "$BUCKET" --arg r "$(role_arn "$RENDER_ROLE")" --arg g "$(role_arn "$GRAPH_ROLE")" \
  --arg k "$(role_arn "$BREAKGLASS_ROLE")" --arg a "$(role_arn "$API_ROLE")" \
  --arg s1 "$SID_RECORDS" --arg s2 "$SID_MEDIA" '
  def res($p): "arn:aws:s3:::\($b)/\($p)";
  [ { Sid: $s1, Effect: "Deny", Principal: "*", Action: ["s3:PutObject", "s3:DeleteObject", "s3:DeleteObjectVersion"],
      Resource: (["person/*.json", "family/*", "event/*", "note/*", "place/*", "media/*.json"] | map(res(.))),
      Condition: { ArnNotLike: { "aws:PrincipalArn": [$r, $g, $k] } } },
    { Sid: $s2, Effect: "Deny", Principal: "*", Action: ["s3:DeleteObject", "s3:DeleteObjectVersion"],
      Resource: [res("media/*")],
      Condition: { ArnNotLike: { "aws:PrincipalArn": [$r, $g, $k, $a] } } } ]' > "$W/guard.json"
jq --slurpfile guard "$W/guard.json" --argjson remove "$REMOVE" --arg s1 "$SID_RECORDS" --arg s2 "$SID_MEDIA" '
  (.Statement // []) as $st
  | ((if ($st | type) == "array" then $st else [$st] end) | map(select(.Sid != $s1 and .Sid != $s2))) as $others
  | (if .Version then . else . + {Version: "2012-10-17"} end)
  | .Statement = ($others + (if $remove == 1 then [] else $guard[0] end))' "$W/current.json" > "$W/merged.json"
# an empty Statement list is not a valid policy: removing the only statements deletes the policy
EMPTY=$(jq '.Statement | length == 0' "$W/merged.json")
norm() { jq -S 'del(.Id)' "$1"; }
CHANGED=1
if [ "$(jq -c '.Statement // []' "$W/current.json")" = "$(jq -c '.Statement' "$W/merged.json")" ]; then CHANGED=0; fi

summary() {
  jq -r --arg s1 "$SID_RECORDS" --arg s2 "$SID_MEDIA" '
    "bucket policy statements: \(.Statement | length) (guard: \([.Statement[] | select(.Sid == $s1 or .Sid == $s2)] | length), others kept: \([.Statement[] | select(.Sid != $s1 and .Sid != $s2)] | length))"' "$1"
}

if [ "$SIM" = 1 ]; then
  # The matrix. Identity side: a broad allow on the bucket, so only the bucket-policy deny can say no (explicitDeny). The caller is
  # the role named; the real service may accept only user ARNs as --caller-arn (see the runbook), which this step then reports.
  jq -n --arg b "$BUCKET" '{Version: "2012-10-17", Statement: [{Effect: "Allow", Action: ["s3:PutObject", "s3:DeleteObject"], Resource: ["arn:aws:s3:::\($b)", "arn:aws:s3:::\($b)/*"]}]}' > "$W/identity.json"
  STRANGER=$(role_arn hfy-not-allowed-role)
  FAIL=0
  probe() { # EXPECT CALLER ACTION KEY
    local got
    got=$(aws iam simulate-custom-policy --policy-input-list "file://$W/identity.json" --resource-policy "file://$W/merged.json" \
      --caller-arn "$2" --action-names "$3" --resource-arns "arn:aws:s3:::$BUCKET/$4" \
      --query 'EvaluationResults[0].EvalDecision' --output text)
    if [ "$got" = "$1" ]; then printf 'ok    %-9s %-60s %s %s\n' "$1" "$(basename "$2")" "$3" "$4"
    else printf 'FAIL  expected %s got %s: %s %s %s\n' "$1" "$got" "$(basename "$2")" "$3" "$4"; FAIL=1; fi
  }
  RENDER=$(role_arn "$RENDER_ROLE"); GRAPH=$(role_arn "$GRAPH_ROLE"); API=$(role_arn "$API_ROLE"); BG=$(role_arn "$BREAKGLASS_ROLE"); DEPLOY=$(role_arn "$DEPLOY_ROLE")
  if [ "$REMOVE" = 1 ]; then
    probe allowed "$STRANGER" s3:PutObject person/x.json
  else
    probe allowed "$RENDER" s3:PutObject person/x.json
    probe allowed "$RENDER" s3:DeleteObject media/x.json
    probe allowed "$GRAPH" s3:PutObject person/graph.json
    probe allowed "$GRAPH" s3:PutObject media/faces/x.webp
    probe allowed "$BG" s3:DeleteObject family/x.json
    probe explicitDeny "$STRANGER" s3:PutObject person/x.json
    probe explicitDeny "$STRANGER" s3:DeleteObject person/x.json
    probe explicitDeny "$STRANGER" s3:PutObject family/x.json
    probe explicitDeny "$STRANGER" s3:PutObject media/x.json
    probe explicitDeny "$STRANGER" s3:DeleteObject media/x.jpg
    probe allowed "$STRANGER" s3:PutObject media/x.jpg
    probe allowed "$DEPLOY" s3:PutObject person/index.html
    probe explicitDeny "$DEPLOY" s3:PutObject person/x.json
    probe explicitDeny "$DEPLOY" s3:DeleteObject person/x.json
    probe explicitDeny "$API" s3:PutObject media/x.json
    probe explicitDeny "$API" s3:DeleteObject media/x.json
    probe allowed "$API" s3:PutObject media/x.jpg
    probe allowed "$API" s3:DeleteObject media/x.jpg
    probe allowed "$STRANGER" s3:PutObject uploads/posts/x/photo.jpg
  fi
  [ "$FAIL" = 0 ] || { echo "simulation failed: the merged policy does not behave as the guard requires" >&2; exit 1; }
  echo "simulation passed"
  exit 0
fi

if [ "$DRY" = 1 ]; then
  summary "$W/merged.json"
  [ "$CHANGED" = 1 ] && echo "(dry-run) the policy would change" || echo "(dry-run) the policy already matches: no change"
  [ "$EMPTY" = true ] && echo "(dry-run) no statements would remain: the bucket policy would be deleted"
  norm "$W/merged.json"
  echo "(dry-run) no changes made"
  exit 0
fi

if [ "$CHANGED" = 0 ]; then echo "bucket $BUCKET already has the intended policy: no change"; exit 0; fi
BK="${HFY_S3_BACKUP_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/hfy-infra/s3-policy}"; mkdir -p "$BK"
BKF="$BK/$BUCKET-$(date -u +%Y%m%dT%H%M%SZ)-before.json"; cp "$W/current.json" "$BKF"
echo "saved the pre-change policy to $BKF"
summary "$W/merged.json"
if [ "$EMPTY" = true ]; then aws s3api delete-bucket-policy --bucket "$BUCKET"; echo "no statements remain: bucket policy deleted"
else aws s3api put-bucket-policy --bucket "$BUCKET" --policy "file://$W/merged.json"; echo "bucket policy applied"; fi
