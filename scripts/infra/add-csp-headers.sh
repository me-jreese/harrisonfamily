#!/usr/bin/env bash
# Idempotently attaches the site Content-Security-Policy (HFY-TSK-149, review PS-11) to the DEFAULT cache behavior, the one that
# serves the HTML pages from the site bucket: default-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors
# 'none' (scripts/cloudfront/site-csp.json, with the script-src/style-src it needs for the inline head script). No cache behavior
# and no path prefix is added. The /uploads/* sandbox CSP and the gated data behaviors are not touched.
#
# Two stack policies, one per stage (app-stack.yaml; the stack must be updated first, with io's go-ahead):
#   --mode report-only  attach SiteCspReportOnlyPolicy: Content-Security-Policy-Report-Only. Browsers report violations and block
#                       nothing. Run the Playwright crawl (islands/tests/csp-crawl.spec.mjs) and live-probe before enforcing.
#   --mode enforce      attach SiteCspPolicy: Content-Security-Policy. Run only after the crawl records zero violations.
#   --mode detach       ROLLBACK: take the policy and the /join/ function off the default behavior. The CSP is gone everywhere.
# /join/ needs Turnstile (challenges.cloudflare.com) and a response headers policy cannot differ by path without a new behavior, so
# the stack's JoinCspFunction (scripts/cloudfront/join-csp.js, viewer-response) is associated with the default behavior too: for
# /join and /join/* it swaps the policy's header for the Turnstile variant, in whichever mode is attached.
# HARD GATE before --mode enforce: the /join/ swap assumes CloudFront runs the viewer-response function AFTER the response headers
# policy has added its header, which this repository cannot prove. If the order is the other way round, /join/ keeps the base
# policy, and enforcing it blocks Turnstile (sign-up breaks). So enforce refuses to run unless --site-url is given and a live
# HEAD of <site-url>/join/ shows the Turnstile variant (challenges.cloudflare.com) in Content-Security-Policy-Report-Only. If the
# probe fails the fallback is a real /join/* cache behavior with its own policy, which needs io's decision. An offline dry run
# (--config-file) skips the probe; a dry run without --site-url only prints that the gate will apply.
# Report-only has no report endpoint, so the live report-only stage is a browser-console check only (see the how-to).
# The default behavior's other fields, HFYAppendIndex (viewer-request) included, are kept. A response headers policy that is not
# one of ours is never replaced: the script stops and says so. Reruns against a matching distribution change nothing (no update).
#
# Usage: add-csp-headers.sh --mode report-only|enforce|detach [--dry-run] [--distribution E2JCDK3QLQNNYB] [--stack hfy-app]
#                           [--site-url https://HOST] [--report-only-policy-id ID] [--enforce-policy-id ID] [--function-arn ARN] [--config-file FILE]
# --dry-run prints the config diff and changes nothing. The ids/ARN default to the stack outputs SiteCspReportOnlyPolicyId,
# SiteCspPolicyId and JoinCspFunctionArn. --config-file (dry run only) makes no AWS call at all and uses placeholder ids. Before a
# real update the pre-change config is saved under ${HFY_CF_BACKUP_DIR:-~/.local/state/hfy-infra/cloudfront}; the rollback is
# --mode detach, or the printed update-distribution command with that backup.
# shellcheck disable=SC2016 # the jq programs are single-quoted on purpose
# shellcheck source-path=SCRIPTDIR
set -euo pipefail
umask 077
# shellcheck source=lib/cf-common.sh
. "$(cd "$(dirname "$0")" && pwd)/lib/cf-common.sh"
DIST=E2JCDK3QLQNNYB; STACK=hfy-app; DRY=0; CFG_FILE=""; MODE=""; RO_ID=""; EN_ID=""; FN_ARN=""; SITE_URL=""
while [ $# -gt 0 ]; do case "$1" in
  --dry-run) DRY=1;; --mode) MODE=$2; shift;; --distribution) DIST=$2; shift;; --stack) STACK=$2; shift;; --config-file) CFG_FILE=$2; shift;;
  --report-only-policy-id) RO_ID=$2; shift;; --enforce-policy-id) EN_ID=$2; shift;; --function-arn) FN_ARN=$2; shift;; --site-url) SITE_URL=${2%/}; shift;;
  *) echo "unknown arg $1" >&2; exit 2;; esac; shift; done
case "$MODE" in report-only|enforce|detach) ;; *) echo "pass --mode report-only, enforce or detach" >&2; exit 2;; esac
cf_check_args "$CFG_FILE" "$DRY"
case "$SITE_URL" in ""|https://*) ;; *) echo "--site-url must start with https://, got: $SITE_URL" >&2; exit 2;; esac

if [ "$MODE" = enforce ] && [ -z "$CFG_FILE" ]; then # the /join/ gate (see the header); needs no AWS call, so it runs first
  if [ -n "$SITE_URL" ]; then
    JOIN_HDRS=$(curl -sS -I --max-time 20 "$SITE_URL/join/?csp=gate$$") || { echo "could not probe $SITE_URL/join/; not enforcing" >&2; exit 1; }
    if ! printf '%s\n' "$JOIN_HDRS" | tr -d '\r' | grep -i '^content-security-policy-report-only:' | grep -q 'challenges\.cloudflare\.com'; then
      echo "GATE: $SITE_URL/join/ does not show the Turnstile CSP variant in Content-Security-Policy-Report-Only." >&2
      echo "Attach --mode report-only first and wait for the distribution. If it is attached and the header is still the base policy, the" >&2
      echo "response headers policy is applied after the /join/ function; enforcing would block Turnstile. Stop and ask io (fallback: a /join/* behavior)." >&2
      exit 1
    fi
    echo "gate passed: $SITE_URL/join/ serves the Turnstile variant in report-only"
  elif [ "$DRY" = 1 ]; then echo "(dry-run) NOTE: a real --mode enforce needs --site-url and a live /join/ probe showing the Turnstile variant in report-only"
  else echo "--mode enforce needs --site-url https://<site>: it probes /join/ for the Turnstile variant first (see the header of this script)" >&2; exit 2; fi
fi

if [ -n "$CFG_FILE" ]; then # fully offline: placeholders, no stack lookups
  [ -n "$RO_ID" ] || RO_ID="<$STACK SiteCspReportOnlyPolicyId>"; [ -n "$EN_ID" ] || EN_ID="<$STACK SiteCspPolicyId>"
  [ -n "$FN_ARN" ] || FN_ARN="<$STACK JoinCspFunctionArn>"
  echo "(dry-run) stack outputs not looked up (offline); using placeholders"
else
  [ -n "$RO_ID" ] || RO_ID=$(cf_stack_output "$STACK" SiteCspReportOnlyPolicyId)
  [ -n "$EN_ID" ] || EN_ID=$(cf_stack_output "$STACK" SiteCspPolicyId)
  [ -n "$FN_ARN" ] || FN_ARN=$(cf_stack_output "$STACK" JoinCspFunctionArn)
fi
case "$FN_ARN" in arn:aws:cloudfront::*:function/*|"<"*) ;; *) echo "the /join/ function ARN must be arn:aws:cloudfront::<acct>:function/<name>, got: $FN_ARN" >&2; exit 2;; esac

cf_load "$DIST" "$CFG_FILE"
CUR=$(jq -r '.DefaultCacheBehavior.ResponseHeadersPolicyId // ""' "$CF_WORK/before.json")
if [ -n "$CUR" ] && [ "$CUR" != "$RO_ID" ] && [ "$CUR" != "$EN_ID" ]; then
  echo "the default behavior already has response headers policy $CUR, which is not one of the site CSP policies; refusing to replace it" >&2; exit 1
fi
if [ "$MODE" != detach ]; then # one viewer-response association per behavior: fail here, not at the API
  FOREIGN=$(jq -r --arg arn "$FN_ARN" '[(.DefaultCacheBehavior.FunctionAssociations.Items // [])[]
    | select(.EventType == "viewer-response" and .FunctionARN != $arn and ($arn | startswith("<") | not))] | first | .FunctionARN // empty' "$CF_WORK/before.json")
  if [ -n "$FOREIGN" ]; then echo "the default behavior already has another viewer-response function ($FOREIGN); CloudFront allows one per event, so the /join/ function cannot be added. Not changing anything." >&2; exit 1; fi
fi
if [ "$MODE" = enforce ]; then WANT=$EN_ID; else WANT=$RO_ID; fi
echo "default behavior: mode $MODE (policy $([ "$MODE" = detach ] && echo none || echo "$WANT"), /join/ function $FN_ARN)"

cf_jq -S --arg mode "$MODE" --arg rhp "$WANT" --arg arn "$FN_ARN" 'include "cf";
  def is_ours: .EventType == "viewer-response" and (.FunctionARN == $arn or ($arn | startswith("<")));
  def assoc_items: (.DefaultCacheBehavior.FunctionAssociations.Items // []);
  def set_assoc($items): .DefaultCacheBehavior.FunctionAssociations = {Quantity: ($items | length), Items: $items};
  if $mode == "detach" then
    del(.DefaultCacheBehavior.ResponseHeadersPolicyId)
    | set_assoc([assoc_items[] | select(is_ours | not)])
  else
    .DefaultCacheBehavior.ResponseHeadersPolicyId = $rhp
    | set_assoc(if any(assoc_items[]; is_ours) then assoc_items else assoc_items + [{FunctionARN: $arn, EventType: "viewer-response"}] end)
  end
  | if (.DefaultCacheBehavior.FunctionAssociations.Quantity == 0) then .DefaultCacheBehavior.FunctionAssociations = {Quantity: 0} else . end
' "$CF_WORK/before.json" > "$CF_WORK/after.json"

cf_apply "$DIST" "$DRY" "the site CSP in mode $MODE on the default behavior"
