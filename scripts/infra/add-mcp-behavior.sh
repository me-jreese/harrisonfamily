#!/usr/bin/env bash
# Idempotently adds the MCP cache behaviors (HFY-R59: the MCP server lives at https://harrisonfamily.us/mcp) to the CloudFront distribution:
#   /mcp*                                    the MCP endpoint
#   /.well-known/oauth-protected-resource*   the PRM (bare and /mcp-suffixed), never cached, never shadowed by the SPA fallback
# Both go to the SAME hfy-api Function URL origin (the MCP core is mounted in the hfy-api Lambda) and carry a Lambda@Edge origin-response
# association that restores WWW-Authenticate on 401 (a Function URL remaps it; a CloudFront Function cannot run on 4xx). The Lambda@Edge
# function is infrastructure/mcp-edge401.us-east-1.yaml (stack hfy-mcp-edge401, us-east-1); its versioned ARN is --edge401-arn, $EDGE401_ARN or
# that stack's output Edge401FunctionVersionArn. The ASM for the https://harrisonfamily.us/auth issuer stays with the auth edge (HFY-R44).
#
# Same contract as add-api-behavior.sh (lib/cf.jq + lib/cf-common.sh): a rerun against a matching distribution is a true no-op; the secret
# X-Origin-Verify value is read from $ORIGIN_VERIFY / Secrets Manager and never printed; --dry-run prints the redacted diff and changes nothing;
# --config-file works only with --dry-run. The script refuses (exit 3) if an EARLIER behavior already matches one of the MCP paths (it would shadow it).
# Usage: add-mcp-behavior.sh [--dry-run] [--distribution E2JCDK3QLQNNYB] [--stack hfy-app] [--function-url URL] [--secret-name NAME]
#                            [--edge401-arn ARN] [--edge-stack hfy-mcp-edge401] [--config-file FILE] [--write-after FILE (dry-run only)]
# shellcheck disable=SC2016 # the jq programs are single-quoted on purpose
# shellcheck source-path=SCRIPTDIR
set -euo pipefail
umask 077
# shellcheck source=lib/cf-common.sh
. "$(cd "$(dirname "$0")" && pwd)/lib/cf-common.sh"
DIST=E2JCDK3QLQNNYB; STACK=hfy-app; DRY=0; FURL=""; CFG_FILE=""; SECRET=harrisonfamily/cloudfront/origin-verify; ARN="${EDGE401_ARN:-}"; EDGE_STACK=hfy-mcp-edge401; AFTER_OUT=""
ORIGIN_ID=hfy-api-origin; OUTPUT_KEY=FunctionUrl
PATTERNS=('/mcp*' '/.well-known/oauth-protected-resource*')
while [ $# -gt 0 ]; do case "$1" in
  --dry-run) DRY=1;; --distribution) DIST=$2; shift;; --stack) STACK=$2; shift;; --function-url) FURL=$2; shift;;
  --secret-name) SECRET=$2; shift;; --config-file) CFG_FILE=$2; shift;; --edge401-arn) ARN=$2; shift;; --edge-stack) EDGE_STACK=$2; shift;;
  --write-after) AFTER_OUT=$2; shift;;
  *) echo "unknown arg $1" >&2; exit 2;; esac; shift; done
cf_check_args "$CFG_FILE" "$DRY"
[ -z "$AFTER_OUT" ] || [ "$DRY" = 1 ] || { echo "--write-after is only for --dry-run" >&2; exit 2; }

[ -n "$FURL" ] || FURL=$(cf_stack_output "$STACK" "$OUTPUT_KEY")
HOST=$(echo "$FURL" | sed -E 's#^https://([^/]+)/?.*#\1#')
[ -n "$HOST" ] || { echo "no function URL host" >&2; exit 1; }
if [ -z "$ARN" ] && [ -z "$CFG_FILE" ]; then
  ARN=$(aws cloudformation describe-stacks --region us-east-1 --stack-name "$EDGE_STACK" --query "Stacks[0].Outputs[?OutputKey=='Edge401FunctionVersionArn'].OutputValue" --output text 2>/dev/null || true)
  [ "$ARN" != None ] || ARN=""
fi
if [ -z "$ARN" ]; then
  if [ "$DRY" = 1 ]; then ARN="arn:aws:lambda:us-east-1:000000000000:function:hfy-mcp-edge401:1"; echo "(dry-run) Lambda@Edge version ARN not resolved; using a placeholder"
  else echo "no Lambda@Edge version ARN: deploy infrastructure/mcp-edge401.us-east-1.yaml (us-east-1) and pass --edge401-arn" >&2; exit 1; fi
fi
case "$ARN" in arn:aws:lambda:us-east-1:*:function:*:[0-9]*) ;; *) echo "--edge401-arn must be a us-east-1 versioned (not \$LATEST) function ARN" >&2; exit 2;; esac
cf_origin_verify "$SECRET" "$DRY" "$([ -n "$CFG_FILE" ] && echo 1 || echo 0)"
cf_load "$DIST" "$CFG_FILE"

PJ=$(printf '%s\n' "${PATTERNS[@]}" | jq -R . | jq -sc .)
if ! cf_jq -S --arg id "$ORIGIN_ID" --arg host "$HOST" --arg arn "$ARN" --argjson pats "$PJ" 'include "cf";
  ( {Id:$id, DomainName:$host, OriginPath:"", OriginAccessControlId:"",
     CustomHeaders:{Quantity:1,Items:[{HeaderName:"X-Origin-Verify",HeaderValue:env.OV}]},
     CustomOriginConfig:{HTTPPort:80,HTTPSPort:443,OriginProtocolPolicy:"https-only",OriginSslProtocols:{Quantity:1,Items:["TLSv1.2"]},OriginReadTimeout:30,OriginKeepaliveTimeout:5}} ) as $origin
  | upsert_origin($origin)
  | reduce ($pats[] | {PathPattern:., TargetOriginId:$id, ViewerProtocolPolicy:"redirect-to-https", Compress:true,
       AllowedMethods:{Quantity:7,Items:["GET","HEAD","OPTIONS","PUT","POST","PATCH","DELETE"],CachedMethods:{Quantity:2,Items:["GET","HEAD"]}},
       CachePolicyId:env.CACHING_DISABLED, OriginRequestPolicyId:env.ALL_VIEWER_EXCEPT_HOST, SmoothStreaming:false,
       TrustedSigners:{Enabled:false,Quantity:0}, TrustedKeyGroups:{Enabled:false,Quantity:0},
       LambdaFunctionAssociations:{Quantity:1,Items:[{LambdaFunctionARN:$arn,EventType:"origin-response",IncludeBody:false}]},
       FunctionAssociations:{Quantity:0}, FieldLevelEncryptionId:"", ForwardedValues:null, MinTTL:null, DefaultTTL:null, MaxTTL:null}) as $b (.; upsert_behavior($b))
  # No earlier behavior may match the literal MCP paths, or CloudFront would never reach ours.
  | . as $c
  | ($pats | map(. as $pat | rtrimstr("*") as $path | ($c.CacheBehaviors.Items | _index_where(.PathPattern | pattern_matches($path))) as $first
      | if $c.CacheBehaviors.Items[$first].PathPattern != $pat then
          error("refusing: \($c.CacheBehaviors.Items[$first].PathPattern) is ordered before the MCP behavior for \($path) and would shadow it")
        else null end)) as $_
  | $c
  ' "$CF_WORK/before.json" > "$CF_WORK/after.json" 2> "$CF_WORK/jq.err"; then
  sed -E 's/^jq: error \(at [^)]*\): //' "$CF_WORK/jq.err" >&2
  exit 3
fi
[ -z "$AFTER_OUT" ] || { cp "$CF_WORK/after.json" "$AFTER_OUT"; }
cf_apply "$DIST" "$DRY" "the MCP behaviors (${PATTERNS[*]}) with the Lambda@Edge 401 restore"
