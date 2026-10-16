#!/usr/bin/env bash
# Offline tests for scripts/infra (HFY-R58). Never touches AWS: test/stub/aws is first on PATH for every script run, and
# test/stub-curl/curl for check-site-bucket-cors.sh, so its preflights never leave the machine either.
# Usage: scripts/infra/test/run.sh        (needs bash, jq, python3 with PyYAML; uses cfn-lint and shellcheck when installed, and
# node + zip + openssl for the scripts/ci/package-edge-gate.sh checks, rsync + git for the scripts/check-deployment-sync.sh run)
# shellcheck disable=SC2016,SC2002 # the jq programs are single-quoted on purpose
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
INFRA=$(cd "$HERE/.." && pwd)
ROOT=$(cd "$INFRA/../.." && pwd)
STUB_BIN="$HERE/stub"
FIXTURE="$HERE/fixtures/live-like.json"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
SECRET_VALUE="hfy-test-origin-verify-$$-must-never-be-printed"
API_FURL="https://api123example.lambda-url.us-west-2.on.aws/"
AUTH_FURL="https://auth123example.lambda-url.us-west-2.on.aws/"
RHP_ID="11111111-2222-3333-4444-555555555555"
GATE_ARN="arn:aws:lambda:us-east-1:123456789012:function:hfy-edge-gate:7"
NOSTORE_RHP="aaaaaaaa-0000-4000-8000-000000000001" # the id the aws stub gives the first response headers policy it creates
UPRIVATE_RHP="aaaaaaaa-0000-4000-8000-000000000002" # ...and the second one (hfy-uploads-private, created right after hfy-private-no-store)
UP_FIXTURE="$HERE/fixtures/live-with-uploads.json" # live-like plus the ungated /uploads/* behavior add-uploads-behavior.sh creates
CSP_RO_RHP="bbbbbbbb-0000-4000-8000-000000000001"; CSP_RHP="bbbbbbbb-0000-4000-8000-000000000002"
JOIN_FN_ARN="arn:aws:cloudfront::123456789012:function/hfy-app-join-csp"
PASS=0; FAILED=0; CURRENT=""
unset ORIGIN_VERIFY

fail() { echo "  FAIL [$CURRENT]: $*" >&2; FAILED=$((FAILED + 1)); }
ok() { PASS=$((PASS + 1)); }
check() { # DESCRIPTION CMD...  (passes when CMD exits 0)
  local d=$1; shift
  if "$@" >/dev/null 2>&1; then ok; else fail "$d"; fi
}
eq() { if [ "$2" = "$3" ]; then ok; else fail "$1: expected [$3] got [$2]"; fi; }
contains() { case "$2" in *"$3"*) ok;; *) fail "$1: output lacks [$3]"; printf '%s\n' "$2" | sed 's/^/    | /' | head -40 >&2;; esac; }
lacks() { case "$2" in *"$3"*) fail "$1: output contains [$3]";; *) ok;; esac; }

new_stub() { # [GET_FIXTURE]
  STUB_DIR=$(mktemp -d "$T/stub.XXXXXX"); export STUB_DIR
  printf '%s' "$SECRET_VALUE" > "$STUB_DIR/secret"
  echo "$API_FURL" > "$STUB_DIR/stack-FunctionUrl"
  echo "$AUTH_FURL" > "$STUB_DIR/stack-AuthFunctionUrl"
  echo "$RHP_ID" > "$STUB_DIR/stack-UploadsResponseHeadersPolicyId"
  echo "$GATE_ARN" > "$STUB_DIR/stack-EdgeGateVersionArn"
  echo "$CSP_RO_RHP" > "$STUB_DIR/stack-SiteCspReportOnlyPolicyId"
  echo "$CSP_RHP" > "$STUB_DIR/stack-SiteCspPolicyId"
  echo "$JOIN_FN_ARN" > "$STUB_DIR/stack-JoinCspFunctionArn"
  cp "${1:-$FIXTURE}" "$STUB_DIR/get.json"
}
run() { # SCRIPT ARGS... -> OUT, RC; the secret must never reach stdout/stderr
  set +e
  OUT=$(PATH="$STUB_BIN:$PATH" HFY_CF_BACKUP_DIR="$STUB_DIR/backups" "$INFRA/$1" "${@:2}" 2>&1); RC=$?
  set -e
  lacks "$1 never prints the origin-verify secret" "$OUT" "$SECRET_VALUE"
}
updates() { find "$STUB_DIR" -maxdepth 1 -name 'update-*.json' | wc -l | tr -d ' '; }
last_update() { echo "$STUB_DIR/update-$(updates).json"; }
echo_last() { jq --arg etag "E-ECHO-$(updates)" -f "$HERE/cf-echo.jq" "$(last_update)" > "$STUB_DIR/get.json"; }
cfg() { jq -L "$INFRA/lib" "$@"; }
patterns() { jq -c '.DistributionConfig // . | [.CacheBehaviors.Items[].PathPattern]' "$1"; }
# The origin CloudFront would route PATH to: first matching cache behavior in order, else the default behavior.
route() { cfg -r --arg p "$2" 'include "cf"; .DistributionConfig // . | ([.CacheBehaviors.Items[]? | select(.PathPattern | pattern_matches($p)) | .TargetOriginId] | first) // .DefaultCacheBehavior.TargetOriginId' "$1"; }
ncalls() { grep -c "$1" "$STUB_DIR/calls.log" 2>/dev/null || true; } # PATTERN -> number of aws calls matching it
rhp_of() { cfg -r --arg p "$2" 'include "cf"; .DistributionConfig // . | [.CacheBehaviors.Items[] | select(.PathPattern | pattern_matches($p))] | first | .ResponseHeadersPolicyId // ""' "$1"; }
seed_rhp() { # CONFIG_JSON -> one existing custom policy in the stub, id $NOSTORE_RHP, ETag E-RHP-1
  jq -n --arg id "$NOSTORE_RHP" --argjson c "$1" '[{Id: $id, ETag: "E-RHP-1", Config: $c}]' > "$STUB_DIR/rhp.json"
}
seed_rhp2() { # NOSTORE_CONFIG_JSON UPLOADS_CONFIG_JSON -> both policies exist ($NOSTORE_RHP, $UPRIVATE_RHP)
  jq -n --arg a "$NOSTORE_RHP" --arg b "$UPRIVATE_RHP" --argjson x "$1" --argjson y "$2" '[{Id: $a, ETag: "E-RHP-1", Config: $x}, {Id: $b, ETag: "E-RHP-1", Config: $y}]' > "$STUB_DIR/rhp.json"
}
quantities_ok() { jq -e '.DistributionConfig // . | (.Origins.Quantity == (.Origins.Items | length)) and (.CacheBehaviors.Quantity == (.CacheBehaviors.Items | length))' "$1"; }

# ---------------------------------------------------------------------------------------------------------------------
CURRENT="lib: norm, glob"
eq "norm ignores string-set order, empty Items and empty optional ids" \
  "$(cfg -c 'include "cf"; [ ({AllowedMethods:{Quantity:2,Items:["HEAD","GET"]},OriginRequestPolicyId:"",L:{Quantity:0,Items:[]}} | norm) == ({AllowedMethods:{Quantity:2,Items:["GET","HEAD"]},L:{Quantity:0}} | norm) ]' -n)" '[true]'
eq "norm keeps real differences" "$(cfg -c -n 'include "cf"; [({CachePolicyId:"a"}|norm) == ({CachePolicyId:"b"}|norm), ({Items:[{a:2},{a:1}]}|norm) == ({Items:[{a:1},{a:2}]}|norm)]')" '[false,false]'
eq "rhp_forces_cache_control" "$(cfg -c -n 'include "cf"; [
  ({CustomHeadersConfig:{Quantity:1,Items:[{Header:"Cache-Control",Value:"private, no-store",Override:true}]}} | rhp_forces_cache_control("private, no-store")),
  ({CustomHeadersConfig:{Quantity:1,Items:[{Header:"cache-control",Value:"private, no-store",Override:true}]}} | rhp_forces_cache_control("private, no-store")),
  ({CustomHeadersConfig:{Quantity:1,Items:[{Header:"Cache-Control",Value:"private, no-store",Override:false}]}} | rhp_forces_cache_control("private, no-store")),
  ({CustomHeadersConfig:{Quantity:1,Items:[{Header:"Cache-Control",Value:"max-age=14400",Override:true}]}} | rhp_forces_cache_control("private, no-store")),
  ({CustomHeadersConfig:{Quantity:2,Items:[{Header:"Cache-Control",Value:"private, no-store",Override:true},{Header:"Cache-Control",Value:"public",Override:true}]}} | rhp_forces_cache_control("private, no-store")),
  ({CustomHeadersConfig:{Quantity:1,Items:[{Header:"Cache-Control",Value:"private, no-store",Override:true}]},RemoveHeadersConfig:{Quantity:1,Items:[{Header:"Cache-Control"}]}} | rhp_forces_cache_control("private, no-store")),
  ({Name:"x"} | rhp_forces_cache_control("private, no-store"))]')" '[true,true,false,false,false,false,false]'
eq "rhp_uploads_private needs Cache-Control AND nosniff AND the sandbox CSP" "$(cfg -c -n 'include "cf"; def cc: {CustomHeadersConfig:{Quantity:1,Items:[{Header:"Cache-Control",Value:"private, no-store",Override:true}]}};
  def sec($n; $c): {SecurityHeadersConfig:{ContentTypeOptions:{Override:$n},ContentSecurityPolicy:{ContentSecurityPolicy:$c,Override:true}}};
  [ ((cc + sec(true; "sandbox")) | rhp_uploads_private("private, no-store"; "sandbox")),
    ((cc + sec(false; "sandbox")) | rhp_uploads_private("private, no-store"; "sandbox")),
    ((cc + sec(true; "default-src *")) | rhp_uploads_private("private, no-store"; "sandbox")),
    (sec(true; "sandbox") | rhp_uploads_private("private, no-store"; "sandbox")),
    (cc | rhp_uploads_private("private, no-store"; "sandbox")) ]')" '[true,false,false,false,false]'
eq "behavior_gated / ungate_behavior only touch a behavior with the gate association" "$(cfg -c -n 'include "cf";
  def g($arn): {CacheBehaviors:{Quantity:2,Items:[{PathPattern:"/a/*",CachePolicyId:"x",ResponseHeadersPolicyId:"r",LambdaFunctionAssociations:{Quantity:1,Items:[{LambdaFunctionARN:$arn}]}},{PathPattern:"/b/*",CachePolicyId:"x",LambdaFunctionAssociations:{Quantity:0}}]}};
  (g("arn:aws:lambda:us-east-1:1:function:hfy-edge-gate:7")) as $c
  | [($c | behavior_gated("/a/*"; "hfy-edge-gate")), ($c | behavior_gated("/b/*"; "hfy-edge-gate")), (g("arn:aws:lambda:us-east-1:1:function:other:7") | behavior_gated("/a/*"; "hfy-edge-gate")),
     ($c | ungate_behavior("/a/*"; "hfy-edge-gate"; "cp"; "rp") | .CacheBehaviors.Items[0] | [.CachePolicyId, .ResponseHeadersPolicyId, .LambdaFunctionAssociations.Quantity]),
     ($c | ungate_behavior("/b/*"; "hfy-edge-gate"; "cp"; "rp") == $c)]')" '[true,false,false,["cp","rp",0],true]'
eq "CloudFront glob semantics" "$(cfg -c -n 'include "cf"; [("/api/*"|pattern_matches("/api/posts")), ("api/*"|pattern_matches("/api/posts")), ("/api/post*"|pattern_matches("/api/posts")), ("/api/post*"|pattern_matches("/api/me")), ("/API/*"|pattern_matches("/api/x")), ("/a.i/*"|pattern_matches("/api/x")), ("/ap?/*"|pattern_matches("/api/x"))]')" '[true,true,true,false,false,false,true]'

# ---------------------------------------------------------------------------------------------------------------------
# The legacy /api/check-allowed* pin is gone (HFY-TSK-326, ruling P2-R48): the hfy-check-allowed Lambda, its API Gateway and that
# CloudFront behavior and origin were deleted on 2026-10-14, so add-api-behavior.sh only adds the origin and retargets /api/*.
CURRENT="api: retargets the existing /api/* to hfy-api in place, and adds no pin"
new_stub
run add-api-behavior.sh
eq "exit code" "$RC" 0
eq "one update-distribution call" "$(updates)" 1
U=$(last_update)
eq "update uses the fetched ETag" "$(cat "$STUB_DIR/update-1.etag")" E1LIVEETAG
eq "behavior order: /api/* stays where it was, and no /api/check-allowed* pin is added" "$(patterns "$U")" '["/person/*","/api/*"]'
eq "/api/check-allowed reaches hfy-api like every other /api path" "$(route "$U" /api/check-allowed)" hfy-api-origin
eq "new routes reach hfy-api" "$(route "$U" /api/posts)" hfy-api-origin
eq "/person/* untouched" "$(route "$U" /person/I0001.json)" s3-frontend
eq "/api/* moved in place with the managed policies" \
  "$(jq -c '.CacheBehaviors.Items[] | select(.PathPattern == "/api/*") | [.CachePolicyId, .OriginRequestPolicyId, .ViewerProtocolPolicy, .GrpcConfig.Enabled]' "$U")" \
  '["4135ea2d-6df8-44a3-9df3-4b5a84be39ad","b689b0a8-53d0-40ab-baf2-68738e2966ac","redirect-to-https",false]'
eq "hfy-api origin host" "$(jq -r '.Origins.Items[] | select(.Id == "hfy-api-origin") | .DomainName' "$U")" api123example.lambda-url.us-west-2.on.aws
eq "secret header value is the stub secret" "$(SV=$SECRET_VALUE jq -r '.Origins.Items[] | select(.Id == "hfy-api-origin") | .CustomHeaders.Items[0].HeaderValue == env.SV' "$U")" true
eq "an origin the old /api/* used is left in place (the script never deletes)" "$(jq -c '[.Origins.Items[].Id]' "$U")" '["s3-frontend","legacy-api-origin","hfy-api-origin"]'
check "Quantity fields match" quantities_ok "$U"
eq "nothing else changed" "$(jq -c --slurpfile f "$FIXTURE" 'del(.Origins, .CacheBehaviors) == ($f[0].DistributionConfig | del(.Origins, .CacheBehaviors))' "$U")" true
lacks "no longer reports a legacy pin" "$OUT" "check-allowed"
contains "diff is redacted" "$OUT" '"HeaderValue": "<redacted>"'
B=$(find "$STUB_DIR/backups" -name 'E2JCDK3QLQNNYB-*-before.json' | head -1)
check "pre-change backup saved" test -s "$B"
eq "backup is mode 600" "$(stat -c %a "$B" 2>/dev/null || stat -f %Lp "$B")" 600
eq "backup is the pre-change config" "$(jq -c --slurpfile f "$FIXTURE" '. == $f[0].DistributionConfig' "$B")" true

CURRENT="api: rerun against CloudFront's echo is a true no-op"
echo_last
run add-api-behavior.sh
eq "exit code" "$RC" 0
eq "no second update-distribution" "$(updates)" 1
eq "update-distribution called once in total" "$(grep -c '^cloudfront update-distribution' "$STUB_DIR/calls.log")" 1
contains "says no change" "$OUT" "no change"
lacks "prints no diff" "$OUT" "+++"

# ---------------------------------------------------------------------------------------------------------------------
CURRENT="api: dry run and --config-file never update"
new_stub
run add-api-behavior.sh --dry-run
eq "exit code" "$RC" 0
eq "no update" "$(updates)" 0
contains "dry-run notice" "$OUT" "(dry-run) no changes made"
run add-api-behavior.sh --config-file "$FIXTURE" --function-url "$API_FURL"
eq "--config-file without --dry-run is refused" "$RC" 2
eq "no update" "$(updates)" 0
contains "explains the refusal" "$OUT" "refusing to update from --config-file"
new_stub
run add-api-behavior.sh --dry-run --config-file "$ROOT/cloudfront/distribution.json" --function-url "$API_FURL"
eq "offline dry run against the repo sample works" "$RC" 0
contains "the sample (no cache behaviors) gets /api/* added" "$OUT" '"PathPattern": "/api/*"'
contains "...on the hfy-api origin" "$OUT" '"TargetOriginId": "hfy-api-origin"'
lacks "...and no legacy pin" "$OUT" '"PathPattern": "/api/check-allowed*"'
check "offline dry run makes no AWS call" test ! -s "$STUB_DIR/calls.log"

# ---------------------------------------------------------------------------------------------------------------------
CURRENT="api: --legacy-origin is gone, a default-only distribution gets /api/*, and an /api/* already on hfy-api is a no-op"
new_stub
run add-api-behavior.sh --legacy-origin legacy-api-origin
eq "--legacy-origin is an unknown argument now (exit 2)" "$RC" 2
eq "no update" "$(updates)" 0
DEFAULT_ONLY="$T/default-only.json"
jq '.DistributionConfig.CacheBehaviors = {Quantity:0}' "$FIXTURE" > "$DEFAULT_ONLY"
new_stub "$DEFAULT_ONLY"
run add-api-behavior.sh
eq "exit code" "$RC" 0
eq "one update" "$(updates)" 1
eq "/api/* is the only behavior" "$(patterns "$(last_update)")" '["/api/*"]'
eq "/api/check-allowed reaches hfy-api" "$(route "$(last_update)" /api/check-allowed)" hfy-api-origin
check "Quantity fields match" quantities_ok "$(last_update)"
echo_last; run add-api-behavior.sh
eq "then a rerun is a no-op" "$(updates)" 1
ON_API="$T/on-api.json"
new_stub; run add-api-behavior.sh; echo_last
cp "$STUB_DIR/get.json" "$ON_API"
new_stub "$ON_API"
run add-api-behavior.sh
eq "exit 0 when /api/* already points at hfy-api (the old pin refusal is gone)" "$RC" 0
eq "no update" "$(updates)" 0
contains "says no change" "$OUT" "no change"

# ---------------------------------------------------------------------------------------------------------------------
CURRENT="auth + api + uploads: all three applied, then every rerun is a no-op"
new_stub
run add-auth-behavior.sh; eq "auth exit" "$RC" 0; eq "auth update" "$(updates)" 1; echo_last
run add-api-behavior.sh; eq "api exit" "$RC" 0; eq "api update" "$(updates)" 2; echo_last
run add-uploads-behavior.sh; eq "uploads exit" "$RC" 0; eq "uploads update" "$(updates)" 3; echo_last
eq "final behavior order" "$(patterns "$STUB_DIR/get.json")" \
  '["/person/*","/api/*","/auth/*","/.well-known/oauth-authorization-server*","/uploads/*"]'
eq "final origins" "$(jq -c '[.DistributionConfig.Origins.Items[].Id]' "$STUB_DIR/get.json")" '["s3-frontend","legacy-api-origin","hfy-auth-origin","hfy-api-origin"]'
for s in add-auth-behavior.sh add-api-behavior.sh add-uploads-behavior.sh add-auth-behavior.sh; do
  run "$s"; eq "$s rerun exit" "$RC" 0; contains "$s rerun says no change" "$OUT" "no change"
done
eq "no update-distribution on any rerun" "$(updates)" 3
U="$STUB_DIR/get.json"
eq "/auth routes to the auth edge" "$(route "$U" /auth/login)" hfy-auth-origin
eq "RFC 8414 discovery routes to the auth edge" "$(route "$U" /.well-known/oauth-authorization-server/auth)" hfy-auth-origin
eq "/api/check-allowed reaches hfy-api (no legacy pin)" "$(route "$U" /api/check-allowed)" hfy-api-origin
eq "uploads served from the S3 origin" "$(route "$U" /uploads/posts/01J0000000000000000000000/photo.jpg)" s3-frontend
check "Quantity fields match" quantities_ok "$U"

# ---------------------------------------------------------------------------------------------------------------------
CURRENT="uploads: /uploads/* carries the sandbox response headers policy"
new_stub
run add-uploads-behavior.sh
eq "exit code" "$RC" 0
eq "one update" "$(updates)" 1
eq "uploads behavior" "$(jq -c '.CacheBehaviors.Items[] | select(.PathPattern == "/uploads/*") | [.TargetOriginId, .ResponseHeadersPolicyId, .CachePolicyId, .AllowedMethods.Items, has("OriginRequestPolicyId"), .ViewerProtocolPolicy]' "$(last_update)")" \
  "[\"s3-frontend\",\"$RHP_ID\",\"658327ea-f89d-4fab-a63d-7e88639e58f6\",[\"GET\",\"HEAD\"],false,\"redirect-to-https\"]"
eq "other behaviors untouched and in order" "$(patterns "$(last_update)")" '["/person/*","/api/*","/uploads/*"]'
echo_last; run add-uploads-behavior.sh
eq "rerun is a no-op" "$(updates)" 1
new_stub
run add-uploads-behavior.sh --response-headers-policy-id flag-rhp --dry-run
eq "flag wins over the stack output" "$RC" 0
contains "uses the flag" "$OUT" "response headers policy flag-rhp"
check "no describe-stacks when the policy id is given" bash -c "! grep -q describe-stacks '$STUB_DIR/calls.log'"
run add-uploads-behavior.sh --origin-id missing-origin
eq "unknown --origin-id is refused" "$RC" 1
eq "no update" "$(updates)" 0
CHANGED="$T/rhp-drift.json"
new_stub; run add-uploads-behavior.sh; echo_last
jq '(.DistributionConfig.CacheBehaviors.Items[] | select(.PathPattern == "/uploads/*") | .ResponseHeadersPolicyId) = "drifted"' "$STUB_DIR/get.json" > "$CHANGED"
new_stub "$CHANGED"; run add-uploads-behavior.sh
eq "a drifted policy id is put back" "$(jq -r '.CacheBehaviors.Items[] | select(.PathPattern == "/uploads/*") | .ResponseHeadersPolicyId' "$(last_update)")" "$RHP_ID"
eq "in place" "$(patterns "$(last_update)")" '["/person/*","/api/*","/uploads/*"]'

# ---------------------------------------------------------------------------------------------------------------------
CURRENT="site CSP: add-csp-headers.sh attaches report-only, then enforcing, then detaches (HFY-TSK-149)"
dflt() { jq -c "$2" "$1"; } # FILE JQ -> over the DEFAULT behavior of a config
new_stub
run add-csp-headers.sh
eq "no --mode is refused" "$RC" 2
eq "...and changes nothing" "$(updates)" 0
run add-csp-headers.sh --mode sideways
eq "an unknown --mode is refused" "$RC" 2
run add-csp-headers.sh --mode report-only
eq "report-only: exit code" "$RC" 0
eq "report-only: one update, with the fetched ETag" "$(updates):$(cat "$STUB_DIR/update-1.etag")" "1:E1LIVEETAG"
U=$(last_update)
eq "report-only policy on the default behavior" "$(dflt "$U" '.DefaultCacheBehavior.ResponseHeadersPolicyId')" "\"$CSP_RO_RHP\""
eq "HFYAppendIndex stays the viewer-request function and the /join/ function is the viewer-response one" \
  "$(dflt "$U" '.DefaultCacheBehavior.FunctionAssociations | [.Quantity, [.Items[] | [.EventType, (.FunctionARN | sub(".*function/"; ""))]]]')" '[2,[["viewer-request","HFYAppendIndex"],["viewer-response","hfy-app-join-csp"]]]'
eq "no behavior or origin was added or changed" "$(jq -c --slurpfile f "$FIXTURE" '[.CacheBehaviors, .Origins] == [$f[0].DistributionConfig.CacheBehaviors, $f[0].DistributionConfig.Origins]' "$U")" true
eq "nothing else on the default behavior changed" "$(jq -c --slurpfile f "$FIXTURE" '.DefaultCacheBehavior | del(.ResponseHeadersPolicyId, .FunctionAssociations) == ($f[0].DistributionConfig.DefaultCacheBehavior | del(.ResponseHeadersPolicyId, .FunctionAssociations))' "$U")" true
check "the pre-change config was saved for rollback" test -s "$(find "$STUB_DIR/backups" -name 'E2JCDK3QLQNNYB-*-before.json' | head -1)"
contains "the rollback is named" "$OUT" "roll back with: aws cloudfront update-distribution"
echo_last; run add-csp-headers.sh --mode report-only
eq "report-only rerun is a true no-op" "$(updates)" 1
contains "...and says so" "$OUT" "no change"
run add-csp-headers.sh --mode enforce
eq "enforce: switches the policy in place" "$(updates):$(dflt "$(last_update)" '.DefaultCacheBehavior.ResponseHeadersPolicyId')" "2:\"$CSP_RHP\""
eq "enforce: the /join/ function is associated once" "$(dflt "$(last_update)" '[.DefaultCacheBehavior.FunctionAssociations.Items[] | select(.EventType == "viewer-response")] | length')" 1
echo_last; run add-csp-headers.sh --mode enforce
eq "enforce rerun is a true no-op" "$(updates)" 2
run add-csp-headers.sh --mode detach
eq "detach (the rollback): no policy on the default behavior" "$(updates):$(dflt "$(last_update)" '.DefaultCacheBehavior | has("ResponseHeadersPolicyId")')" "3:false"
eq "detach: only the /join/ function leaves; HFYAppendIndex stays" "$(dflt "$(last_update)" '.DefaultCacheBehavior.FunctionAssociations | [.Quantity, [.Items[].EventType]]')" '[1,["viewer-request"]]'
eq "detach restores the original distribution exactly" "$(cfg -S -c 'include "cf"; norm' "$(last_update)")" "$(cfg -S -c 'include "cf"; .DistributionConfig | norm' "$FIXTURE")"
echo_last; run add-csp-headers.sh --mode detach
eq "detach rerun is a true no-op" "$(updates)" 3

new_stub
run add-csp-headers.sh --mode report-only --dry-run
eq "dry run: exit 0, no update" "$RC:$(updates)" "0:0"
contains "dry run shows the policy it would attach" "$OUT" "$CSP_RO_RHP"
contains "dry run says nothing changed" "$OUT" "(dry-run) no changes made"
new_stub
run add-csp-headers.sh --mode enforce --report-only-policy-id ro-x --enforce-policy-id en-x --function-arn arn:aws:cloudfront::1:function/f --dry-run
contains "explicit ids win over the stack outputs" "$OUT" "policy en-x"
check "...and describe-stacks is never called" bash -c "! grep -q describe-stacks '$STUB_DIR/calls.log'"
new_stub
run add-csp-headers.sh --mode report-only --function-arn not-an-arn
eq "a malformed function ARN is refused before anything is read" "$RC:$(updates)" "2:0"
run add-csp-headers.sh --mode report-only --config-file "$FIXTURE"
eq "--config-file without --dry-run is refused" "$RC:$(updates)" "2:0"
new_stub
run add-csp-headers.sh --mode report-only --dry-run --config-file "$FIXTURE"
eq "--config-file --dry-run exits 0" "$RC" 0
check "...and makes no AWS call at all" test ! -e "$STUB_DIR/calls.log"
contains "...and uses placeholders" "$OUT" "<hfy-app SiteCspReportOnlyPolicyId>"
OTHER="$T/other-rhp.json"
jq '.DistributionConfig.DefaultCacheBehavior.ResponseHeadersPolicyId = "someone-elses-policy"' "$FIXTURE" > "$OTHER"
new_stub "$OTHER"
run add-csp-headers.sh --mode report-only
eq "a response headers policy that is not ours is never replaced" "$RC:$(updates)" "1:0"
contains "...and the script says why" "$OUT" "not one of the site CSP policies"
run add-csp-headers.sh --mode detach
eq "...nor removed by detach" "$RC:$(updates)" "1:0"

# ---------------------------------------------------------------------------------------------------------------------
CURRENT="data gate: HFY-TSK-080 behaviors with the Lambda@Edge association"
new_stub
run add-data-gate-behaviors.sh
eq "exit code" "$RC" 0
eq "one update-distribution call" "$(updates)" 1
U=$(last_update)
eq "gated patterns sit ahead of the shadowing legacy /person/*; the rest follow the existing behaviors (a missing /uploads/* is created, gated)" "$(patterns "$U")" \
  '["/person/*.json","/person/*","/api/*","/family/*","/event/*","/note/*","/place/*","/media/*","/uploads/*"]'
for P in /person/I0001.json /person/index.json /person/search-index.json /family/F0001.json /event/E1.json /note/N1.json /place/P1.json /media/a/b.jpg; do
  eq "$P is gated by the version ARN, viewer-request" "$(cfg -r --arg p "$P" 'include "cf"; ([.CacheBehaviors.Items[] | select(.PathPattern | pattern_matches($p))] | first | .LambdaFunctionAssociations.Items[0] | "\(.LambdaFunctionARN) \(.EventType) \(.IncludeBody)")' "$U")" "$GATE_ARN viewer-request false"
  eq "$P is never cached across users" "$(cfg -r --arg p "$P" 'include "cf"; [.CacheBehaviors.Items[] | select(.PathPattern | pattern_matches($p))] | first | .CachePolicyId' "$U")" 4135ea2d-6df8-44a3-9df3-4b5a84be39ad
  eq "$P stays on the S3 origin" "$(route "$U" "$P")" s3-frontend
  eq "$P responses are forced to Cache-Control: private, no-store (HFY-R65, Cloudflare)" "$(rhp_of "$U" "$P")" "$NOSTORE_RHP"
done
eq "each policy was created once (hfy-private-no-store, then hfy-uploads-private)" "$(ncalls '^cloudfront create-response-headers-policy')" 2
eq "created policy config" "$(jq -c '.[0].Config' "$STUB_DIR/rhp.json")" \
  '{"Name":"hfy-private-no-store","Comment":"HFY-R65: gated family data is never stored by Cloudflare or a shared browser cache","CustomHeadersConfig":{"Quantity":1,"Items":[{"Header":"Cache-Control","Value":"private, no-store","Override":true}]}}'
contains "reports the policy" "$OUT" "created response headers policy hfy-private-no-store ($NOSTORE_RHP)"
contains "reports the uploads policy" "$OUT" "created response headers policy hfy-uploads-private ($UPRIVATE_RHP)"
eq "hfy-uploads-private keeps nosniff and the sandbox CSP and forces Cache-Control" "$(jq -c '.[1].Config' "$STUB_DIR/rhp.json")" \
  '{"Name":"hfy-uploads-private","Comment":"HFY: members-only /uploads/*: nosniff, sandbox CSP, Cache-Control private no-store","SecurityHeadersConfig":{"ContentTypeOptions":{"Override":true},"ContentSecurityPolicy":{"ContentSecurityPolicy":"sandbox; default-src '"'"'none'"'"'; img-src '"'"'self'"'"'","Override":true}},"CustomHeadersConfig":{"Quantity":1,"Items":[{"Header":"Cache-Control","Value":"private, no-store","Override":true}]}}'
check "...a policy config the CloudFront API accepts (Comment <= 128 characters)" jq -e '.[1].Config.Comment | length <= 128' "$STUB_DIR/rhp.json"
eq "/uploads/* is gated too, with the uploads policy (not the plain no-store one)" "$(cfg -r 'include "cf"; [.CacheBehaviors.Items[] | select(.PathPattern == "/uploads/*")] | first | [.TargetOriginId, .CachePolicyId, .ResponseHeadersPolicyId, .LambdaFunctionAssociations.Items[0].LambdaFunctionARN, (.AllowedMethods.Items | join("+"))] | join(" ")' "$U")" \
  "s3-frontend 4135ea2d-6df8-44a3-9df3-4b5a84be39ad $UPRIVATE_RHP $GATE_ARN GET+HEAD"
eq "non-gated behaviors get no response headers policy" "$(rhp_of "$U" /api/posts)$(rhp_of "$U" /person/index.html)" ""
eq "the person page shell and other site paths are not gated" "$(cfg -r 'include "cf"; [.CacheBehaviors.Items[] | select(.PathPattern | pattern_matches("/person/index.html")) | .LambdaFunctionAssociations.Quantity] | first' "$U")" 0
eq "api untouched" "$(jq -cS '.CacheBehaviors.Items[] | select(.PathPattern == "/api/*")' "$U")" "$(jq -cS '.DistributionConfig.CacheBehaviors.Items[] | select(.PathPattern == "/api/*")' "$FIXTURE")"
eq "legacy /person/* untouched" "$(jq -cS '.CacheBehaviors.Items[] | select(.PathPattern == "/person/*")' "$U")" "$(jq -cS '.DistributionConfig.CacheBehaviors.Items[] | select(.PathPattern == "/person/*")' "$FIXTURE")"
eq "default behavior untouched" "$(jq -cS '.DefaultCacheBehavior' "$U")" "$(jq -cS '.DistributionConfig.DefaultCacheBehavior' "$FIXTURE")"
eq "methods are GET/HEAD" "$(jq -c '.CacheBehaviors.Items[] | select(.PathPattern == "/media/*") | .AllowedMethods.Items' "$U")" '["GET","HEAD"]'
check "Quantity fields match" quantities_ok "$U"
eq "nothing but cache behaviors changed" "$(jq -c --slurpfile f "$FIXTURE" 'del(.CacheBehaviors) == ($f[0].DistributionConfig | del(.CacheBehaviors))' "$U")" true
eq "the CSP in hfy-uploads-private is the one app-stack.yaml gives the uploads sandbox policy" "$(jq -r '.[1].Config.SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy' "$STUB_DIR/rhp.json")" \
  "$(sed -n 's/^ *ContentSecurityPolicy: "\(sandbox[^"]*\)".*$/\1/p' "$ROOT/infrastructure/cloudformation/app-stack.yaml")"
echo_last
CURRENT="data gate: rerun is a true no-op, dry run and --config-file never update"
N=$(updates); run add-data-gate-behaviors.sh --version-arn "$GATE_ARN"
eq "rerun against CloudFront's echo makes no update" "$(updates)" "$N"
contains "reports no change" "$OUT" "no change"
eq "rerun finds the policies by name and creates no more" "$(ncalls '^cloudfront create-response-headers-policy')" 2
eq "rerun never rewrites a policy that already forces the header" "$(ncalls '^cloudfront update-response-headers-policy')" 0
contains "rerun reports the existing policy" "$OUT" "response headers policy hfy-private-no-store ($NOSTORE_RHP) already forces Cache-Control: private, no-store"
contains "rerun reports the existing uploads policy" "$OUT" "response headers policy hfy-uploads-private ($UPRIVATE_RHP) already forces Cache-Control: private, no-store and the nosniff + sandbox CSP security headers"
run add-data-gate-behaviors.sh
eq "a third run reading the stack output is also a no-op" "$(updates)" "$N"
eq "...with still two policies" "$(jq length "$STUB_DIR/rhp.json")" 2
new_stub; run add-data-gate-behaviors.sh --dry-run
eq "dry run exit" "$RC" 0
eq "dry run never updates" "$(updates)" 0
contains "dry run shows the diff" "$OUT" "LambdaFunctionARN"
eq "dry run never creates the policy" "$(ncalls '^cloudfront create-response-headers-policy')" 0
contains "dry run says it would create the policy" "$OUT" "(dry-run) would create response headers policy hfy-private-no-store (Cache-Control: private, no-store, override)"
contains "...and the uploads policy" "$OUT" "(dry-run) would create response headers policy hfy-uploads-private (Cache-Control: private, no-store, override and the nosniff + sandbox CSP security headers)"
contains "dry run diff attaches the policy" "$OUT" '"ResponseHeadersPolicyId": "<new hfy-private-no-store policy id>"'
new_stub; run add-data-gate-behaviors.sh --config-file "$ROOT/cloudfront/distribution.json" --version-arn "$GATE_ARN" --dry-run
eq "offline dry run against cloudfront/distribution.json" "$RC" 0
contains "plans the gated behaviors" "$OUT" "/media/* -> s3-origin"
eq "offline dry run never calls AWS" "$(cat "$STUB_DIR/calls.log" 2>/dev/null | wc -l | tr -d ' ')" 0
contains "plans every gated pattern" "$OUT" "/person/*.json -> s3-origin"
contains "...including a (here missing) /uploads/*" "$OUT" "/uploads/* -> s3-origin"
contains "offline: the policy is a placeholder, never looked up" "$OUT" "(dry-run) response headers policy hfy-private-no-store not looked up (offline); using a placeholder id"
contains "offline: the plan attaches the no-store policy" "$OUT" '"ResponseHeadersPolicyId": "<hfy-private-no-store policy id>"'
contains "offline: the plan names the header" "$OUT" "Cache-Control: private, no-store"
eq "offline: all six data behaviors carry the policy" "$(printf '%s\n' "$OUT" | grep -c '^+ *"ResponseHeadersPolicyId": "<hfy-private-no-store policy id>"')" 6
eq "offline: /uploads/* carries the uploads policy placeholder" "$(printf '%s\n' "$OUT" | grep -c '^+ *"ResponseHeadersPolicyId": "<hfy-uploads-private policy id>"')" 1
new_stub; run add-data-gate-behaviors.sh --config-file "$ROOT/cloudfront/distribution.json" --version-arn "$GATE_ARN" --response-headers-policy-id "$RHP_ID" --dry-run
eq "offline dry run with --response-headers-policy-id" "$RC" 0
eq "...attaches that id to all six data behaviors" "$(printf '%s\n' "$OUT" | grep -c "^+ *\"ResponseHeadersPolicyId\": \"$RHP_ID\"")" 6
eq "...and still makes no AWS call" "$(cat "$STUB_DIR/calls.log" 2>/dev/null | wc -l | tr -d ' ')" 0
run add-data-gate-behaviors.sh --config-file "$ROOT/cloudfront/distribution.json" --version-arn "$GATE_ARN"
eq "--config-file without --dry-run is refused" "$RC" 2
for BAD in "arn:aws:lambda:us-east-1:123456789012:function:hfy-edge-gate" "arn:aws:lambda:us-east-1:123456789012:function:hfy-edge-gate:\$LATEST" "arn:aws:lambda:us-west-2:123456789012:function:hfy-edge-gate:3" "arn:aws:lambda:us-east-1:123456789012:function:other:3"; do
  new_stub; run add-data-gate-behaviors.sh --version-arn "$BAD"
  eq "refuses version ARN $BAD" "$RC" 2
  eq "no update for $BAD" "$(updates)" 0
done
new_stub; run add-data-gate-behaviors.sh --origin-id missing-origin --version-arn "$GATE_ARN"
eq "unknown --origin-id is refused" "$RC" 1
eq "a refused origin creates no policy" "$(ncalls 'response-headers-polic')" 0
new_stub; rm "$STUB_DIR/stack-EdgeGateVersionArn"; run add-data-gate-behaviors.sh
eq "missing stack output is refused" "$RC" 1
eq "no update when the stack has no output" "$(updates)" 0
eq "a refused run creates no policy" "$(ncalls 'response-headers-polic')" 0
new_stub; run add-data-gate-behaviors.sh --version-arn "arn:aws:lambda:us-east-1:123456789012:function:hfy-edge-gate:\$LATEST"
eq "a refused ARN touches no policy" "$(ncalls 'response-headers-polic')" 0
new_stub; run add-data-gate-behaviors.sh --version-arn "$GATE_ARN"; echo_last
OLD=$(cat "$STUB_DIR/get.json")
printf '%s' "$OLD" > "$T/gated.json"
new_stub "$T/gated.json"; run add-data-gate-behaviors.sh --version-arn "arn:aws:lambda:us-east-1:123456789012:function:hfy-edge-gate:8"
eq "a new published version re-points every behavior in place" "$(patterns "$(last_update)")" '["/person/*.json","/person/*","/api/*","/family/*","/event/*","/note/*","/place/*","/media/*","/uploads/*"]'
eq "all seven carry version 8" "$(jq -r '[.CacheBehaviors.Items[] | .LambdaFunctionAssociations.Items[]? | .LambdaFunctionARN | endswith(":8")] | all and length == 7' "$(last_update)")" true
jq '.DistributionConfig.CacheBehaviors.Items |= ([.[] | select(.PathPattern == "/person/*.json")] + [.[] | select(.PathPattern != "/person/*.json")] | .[1:2] + .[0:1] + .[2:])' "$T/gated.json" > "$T/shadowed.json"
eq "setup: the gated /person/*.json sits behind /person/*" "$(patterns "$T/shadowed.json" | jq -c '.[0:2]')" '["/person/*","/person/*.json"]'
new_stub "$T/shadowed.json"; run add-data-gate-behaviors.sh --version-arn "$GATE_ARN"
eq "a shadowed gated behavior is moved ahead of its shadow" "$(patterns "$(last_update)" | jq -c '.[0:2]')" '["/person/*.json","/person/*"]'
eq "...keeping its merged fields" "$(jq -c '.CacheBehaviors.Items[0] | [.PathPattern, .GrpcConfig.Enabled, .LambdaFunctionAssociations.Items[0].LambdaFunctionARN]' "$(last_update)")" "[\"/person/*.json\",false,\"$GATE_ARN\"]"

CURRENT="data gate: --remove is the rollback"
new_stub "$T/gated.json"; run add-data-gate-behaviors.sh --remove
eq "exit code" "$RC" 0
eq "one update" "$(updates)" 1
eq "the six data behaviors are removed; /uploads/* stays (here: ungated again, it was created by the gate run)" "$(patterns "$(last_update)")" '["/person/*","/api/*","/uploads/*"]'
eq "...with its previous ungated state: no association, CachingOptimized, the app stack's uploads policy" "$(jq -c '.CacheBehaviors.Items[] | select(.PathPattern == "/uploads/*") | [.LambdaFunctionAssociations.Quantity, .CachePolicyId, .ResponseHeadersPolicyId]' "$(last_update)")" \
  "[0,\"658327ea-f89d-4fab-a63d-7e88639e58f6\",\"$RHP_ID\"]"
eq "the other behaviors are exactly the originals" "$(cfg -cS 'include "cf"; .CacheBehaviors.Items | map(select(.PathPattern != "/uploads/*")) | norm' "$(last_update)")" "$(cfg -cS 'include "cf"; .DistributionConfig.CacheBehaviors.Items | norm' "$FIXTURE")"
check "Quantity fields match" quantities_ok "$(last_update)"
echo_last; N=$(updates); run add-data-gate-behaviors.sh --remove
eq "a second --remove is a no-op" "$(updates)" "$N"
new_stub; run add-data-gate-behaviors.sh --remove --dry-run
eq "--remove on a distribution without the gate is a no-op" "$(updates)" 0
contains "reports no change" "$OUT" "no change"
jq '(.DistributionConfig.CacheBehaviors.Items[] | select(.PathPattern == "/media/*") | .LambdaFunctionAssociations) = {Quantity:0}' "$T/gated.json" > "$T/foreign.json"
new_stub "$T/foreign.json"; run add-data-gate-behaviors.sh --remove
eq "a /media/* behavior without our association is not ours and is kept" "$(patterns "$(last_update)")" '["/person/*","/api/*","/media/*","/uploads/*"]'
new_stub "$T/gated.json"; run add-data-gate-behaviors.sh --remove --dry-run
eq "--remove --dry-run never updates" "$(updates)" 0
new_stub "$T/gated.json"; seed_rhp '{"Name":"hfy-private-no-store","CustomHeadersConfig":{"Quantity":1,"Items":[{"Header":"Cache-Control","Value":"private, no-store","Override":true}]}}'
run add-data-gate-behaviors.sh --remove
eq "--remove never touches the response headers policies" "$(ncalls 'response-headers-polic')" 0
eq "...which are kept for the next attach" "$(jq length "$STUB_DIR/rhp.json")" 1

# ---------------------------------------------------------------------------------------------------------------------
CURRENT="data gate: HFY-R65 response headers policy is found, created or repaired, idempotently"
NOSTORE_CFG='{"Name":"hfy-private-no-store","Comment":"made by hand","CustomHeadersConfig":{"Quantity":1,"Items":[{"Header":"Cache-Control","Value":"private, no-store","Override":true}]}}'
UPRIVATE_CFG='{"Name":"hfy-uploads-private","SecurityHeadersConfig":{"ContentTypeOptions":{"Override":true},"ContentSecurityPolicy":{"ContentSecurityPolicy":"sandbox; default-src '"'"'none'"'"'; img-src '"'"'self'"'"'","Override":true}},"CustomHeadersConfig":{"Quantity":1,"Items":[{"Header":"Cache-Control","Value":"private, no-store","Override":true}]}}'
new_stub; seed_rhp2 "$NOSTORE_CFG" "$UPRIVATE_CFG"
run add-data-gate-behaviors.sh
eq "exit code" "$RC" 0
eq "existing matching policies are reused, not created" "$(ncalls '^cloudfront create-response-headers-policy')" 0
eq "...and not rewritten" "$(ncalls '^cloudfront update-response-headers-policy')" 0
eq "...and the no-store id is attached to all six data behaviors" "$(jq --arg r "$NOSTORE_RHP" '[.CacheBehaviors.Items[] | select(.LambdaFunctionAssociations.Quantity == 1 and .PathPattern != "/uploads/*") | .ResponseHeadersPolicyId == $r] | (all and length == 6)' "$(last_update)")" true
eq "...and the uploads id to /uploads/*" "$(rhp_of "$(last_update)" /uploads/posts/x/y.jpg)" "$UPRIVATE_RHP"
new_stub; seed_rhp "$NOSTORE_CFG"
run add-data-gate-behaviors.sh
eq "only the missing uploads policy is created when hfy-private-no-store exists" "$(ncalls '^cloudfront create-response-headers-policy')" 1
eq "...as the second policy" "$(jq -r '.[1].Config.Name' "$STUB_DIR/rhp.json")" hfy-uploads-private
new_stub; seed_rhp "$(jq -c '.CustomHeadersConfig.Items[0].Value = "max-age=14400"' <<<"$NOSTORE_CFG")"
run add-data-gate-behaviors.sh --dry-run
eq "dry run: a drifted policy is reported, not changed" "$(ncalls '^cloudfront update-response-headers-policy')" 0
contains "dry run explains" "$OUT" "(dry-run) would put response headers policy hfy-private-no-store ($NOSTORE_RHP) back to Cache-Control: private, no-store, override"
run add-data-gate-behaviors.sh
eq "a drifted policy is put back" "$(ncalls '^cloudfront update-response-headers-policy')" 1
eq "...with its ETag" "$(grep '^cloudfront update-response-headers-policy' "$STUB_DIR/calls.log" | grep -c -- '--if-match E-RHP-1')" 1
check "...to the forced header" cfg -e 'include "cf"; .[0].Config | rhp_forces_cache_control("private, no-store")' "$STUB_DIR/rhp.json"
eq "...keeping its id" "$(rhp_of "$(last_update)" /media/x.jpg)" "$NOSTORE_RHP"
echo_last; N=$(updates); run add-data-gate-behaviors.sh
eq "after the repair a rerun changes nothing" "$(updates)" "$N"
eq "...and rewrites nothing" "$(ncalls '^cloudfront update-response-headers-policy')" 1
new_stub; seed_rhp "$(jq -c '.RemoveHeadersConfig = {Quantity:1,Items:[{Header:"cache-control"}]}' <<<"$NOSTORE_CFG")"
run add-data-gate-behaviors.sh
eq "a policy that strips Cache-Control is also repaired" "$(ncalls '^cloudfront update-response-headers-policy')" 1
new_stub; seed_rhp '{"Name":"someone-elses-policy","CustomHeadersConfig":{"Quantity":0}}'
run add-data-gate-behaviors.sh
eq "a policy with another name is ignored and ours are created" "$(ncalls '^cloudfront create-response-headers-policy')" 2
eq "...leaving the other one alone" "$(ncalls '^cloudfront update-response-headers-policy')" 0
new_stub; run add-data-gate-behaviors.sh --response-headers-policy-id "$RHP_ID"
eq "--response-headers-policy-id skips only that policy's lookup and create (the uploads policy is still found or created)" "$(ncalls '^cloudfront create-response-headers-policy')" 1
eq "...and is attached" "$(rhp_of "$(last_update)" /family/F1.json)" "$RHP_ID"
new_stub; run add-data-gate-behaviors.sh --response-headers-policy-id "$RHP_ID" --uploads-response-headers-policy-id "$RHP_ID-up"
eq "both ids given: no policy lookup, create or update at all" "$(ncalls 'response-headers-polic')" 0
eq "...the uploads id is attached to /uploads/*" "$(rhp_of "$(last_update)" /uploads/posts/x/y.jpg)" "$RHP_ID-up"
new_stub "$T/gated.json"; seed_rhp "$NOSTORE_CFG"
jq '(.DistributionConfig.CacheBehaviors.Items[] | select(.PathPattern == "/media/*") | .ResponseHeadersPolicyId) = "drifted"' "$T/gated.json" > "$T/rhp-behavior-drift.json"
cp "$T/rhp-behavior-drift.json" "$STUB_DIR/get.json"
run add-data-gate-behaviors.sh
eq "a gated behavior whose policy was swapped gets it back" "$(rhp_of "$(last_update)" /media/a.jpg)" "$NOSTORE_RHP"
eq "...in place" "$(patterns "$(last_update)")" '["/person/*.json","/person/*","/api/*","/family/*","/event/*","/note/*","/place/*","/media/*","/uploads/*"]'

# ---------------------------------------------------------------------------------------------------------------------
CURRENT="data gate: /uploads/* is gated in place (members only, private, no-store), then every rerun is a no-op"
up_beh() { jq -cS '.DistributionConfig // . | .CacheBehaviors.Items[] | select(.PathPattern == "/uploads/*")' "$1"; }
new_stub "$UP_FIXTURE"
run add-data-gate-behaviors.sh
eq "exit code" "$RC" 0
eq "one update-distribution call" "$(updates)" 1
U=$(last_update)
eq "/uploads/* keeps its position; the other gated patterns go where they always do" "$(patterns "$U")" \
  '["/person/*.json","/person/*","/api/*","/uploads/*","/family/*","/event/*","/note/*","/place/*","/media/*"]'
eq "uploads: gated by the version ARN (viewer-request), CachingDisabled, hfy-uploads-private, same origin, GET/HEAD" \
  "$(cfg -r 'include "cf"; [.CacheBehaviors.Items[] | select(.PathPattern == "/uploads/*")] | first | [.TargetOriginId, .CachePolicyId, .ResponseHeadersPolicyId, (.LambdaFunctionAssociations.Items[0] | "\(.LambdaFunctionARN) \(.EventType) \(.IncludeBody)"), (.AllowedMethods.Items | join("+")), .ViewerProtocolPolicy, has("OriginRequestPolicyId")] | map(tostring) | join(" | ")' "$U")" \
  "s3-frontend | 4135ea2d-6df8-44a3-9df3-4b5a84be39ad | $UPRIVATE_RHP | $GATE_ARN viewer-request false | GET+HEAD | redirect-to-https | false"
eq "uploads: every other field of the behavior is kept" "$(cfg -c --slurpfile f "$UP_FIXTURE" 'include "cf"; def rest: del(.CachePolicyId, .ResponseHeadersPolicyId, .LambdaFunctionAssociations) | norm;
  ([.CacheBehaviors.Items[] | select(.PathPattern == "/uploads/*")][0] | rest) == ($f[0].DistributionConfig.CacheBehaviors.Items[] | select(.PathPattern == "/uploads/*") | rest)' "$U")" true
eq "uploads: the no-store policy is not the one on /uploads/* (it would drop nosniff and the sandbox CSP)" "$([ "$(rhp_of "$U" /uploads/posts/x/y.jpg)" != "$NOSTORE_RHP" ] && echo yes)" yes
eq "the data behaviors still carry hfy-private-no-store" "$(rhp_of "$U" /family/F1.json)" "$NOSTORE_RHP"
eq "uploads photos still route to the S3 origin" "$(route "$U" /uploads/posts/01J0000000000000000000000/photo.jpg)" s3-frontend
eq "nothing but cache behaviors changed" "$(jq -c --slurpfile f "$UP_FIXTURE" 'del(.CacheBehaviors) == ($f[0].DistributionConfig | del(.CacheBehaviors))' "$U")" true
check "Quantity fields match" quantities_ok "$U"
echo_last; N=$(updates)
run add-data-gate-behaviors.sh --version-arn "$GATE_ARN"
eq "rerun against CloudFront's echo is a true no-op" "$(updates)" "$N"
contains "says no change" "$OUT" "no change"
eq "...and creates no further policy" "$(ncalls '^cloudfront create-response-headers-policy')" 2
DS=$(ncalls describe-stacks)
run add-uploads-behavior.sh
eq "add-uploads-behavior.sh never undoes the gate" "$(updates)" "$N"
eq "...exit code" "$RC" 0
contains "...and says why" "$OUT" "/uploads/* is members-only (hfy-edge-gate association, add-data-gate-behaviors.sh): left as it is"
contains "...as a no-op" "$OUT" "no change"
run add-uploads-behavior.sh --dry-run
contains "...also on a dry run" "$OUT" "left as it is"
eq "...without ever asking CloudFormation for the policy" "$(ncalls describe-stacks)" "$DS"
cp "$STUB_DIR/get.json" "$T/uploads-gated.json"

CURRENT="data gate: /uploads/* drift is repaired in place; an explicit --origin-id never moves it"
jq '(.DistributionConfig.CacheBehaviors.Items[] | select(.PathPattern == "/uploads/*") | .CachePolicyId) = "658327ea-f89d-4fab-a63d-7e88639e58f6"' "$T/uploads-gated.json" > "$T/uploads-drift.json"
new_stub "$T/uploads-drift.json"; seed_rhp2 "$NOSTORE_CFG" "$UPRIVATE_CFG"
run add-data-gate-behaviors.sh
eq "the cache policy of /uploads/* is put back to CachingDisabled" "$(jq -r '.CacheBehaviors.Items[] | select(.PathPattern == "/uploads/*") | .CachePolicyId' "$(last_update)")" 4135ea2d-6df8-44a3-9df3-4b5a84be39ad
eq "...in place" "$(patterns "$(last_update)")" "$(patterns "$T/uploads-drift.json")"
new_stub "$UP_FIXTURE"
run add-data-gate-behaviors.sh --origin-id legacy-api-origin
eq "--origin-id moves the data behaviors" "$(route "$(last_update)" /family/F1.json)" legacy-api-origin
eq "...but /uploads/* keeps the origin it already had" "$(route "$(last_update)" /uploads/posts/x/y.jpg)" s3-frontend
# hfy-uploads-private repaired when it lost nosniff or the CSP, or when Cache-Control drifted
for BREAK in '.SecurityHeadersConfig.ContentTypeOptions.Override = false' '.SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy = "default-src *"' 'del(.SecurityHeadersConfig)' '.CustomHeadersConfig.Items[0].Value = "max-age=60"'; do
  new_stub; seed_rhp2 "$NOSTORE_CFG" "$(jq -c "$BREAK" <<<"$UPRIVATE_CFG")"
  run add-data-gate-behaviors.sh --dry-run
  contains "dry run reports the broken uploads policy ($BREAK)" "$OUT" "(dry-run) would put response headers policy hfy-uploads-private ($UPRIVATE_RHP) back to Cache-Control: private, no-store, override and the nosniff + sandbox CSP security headers"
  eq "...and changes nothing" "$(ncalls '^cloudfront update-response-headers-policy')" 0
  run add-data-gate-behaviors.sh
  eq "the broken uploads policy is put back ($BREAK)" "$(ncalls '^cloudfront update-response-headers-policy')" 1
  check "...to the full config" cfg -e 'include "cf"; .[1].Config | rhp_uploads_private("private, no-store"; "sandbox; default-src '"'"'none'"'"'; img-src '"'"'self'"'"'")' "$STUB_DIR/rhp.json"
  eq "...keeping its id on /uploads/*" "$(rhp_of "$(last_update)" /uploads/posts/x/y.jpg)" "$UPRIVATE_RHP"
done

CURRENT="data gate: --remove restores /uploads/* to its previous ungated state (policy and cache policy), never deleting it"
new_stub "$T/uploads-gated.json"
run add-data-gate-behaviors.sh --remove
eq "exit code" "$RC" 0
eq "one update" "$(updates)" 1
eq "only the six data behaviors are deleted" "$(patterns "$(last_update)")" '["/person/*","/api/*","/uploads/*"]'
eq "the removal restores the original distribution exactly (uploads: no association, CachingOptimized, the app stack's policy)" \
  "$(cfg -cS 'include "cf"; norm' "$(last_update)")" "$(cfg -cS 'include "cf"; .DistributionConfig | norm' "$UP_FIXTURE")"
check "Quantity fields match" quantities_ok "$(last_update)"
eq "the uploads policy came from the app stack output" "$(ncalls "describe-stacks --stack-name hfy-app")" 1
eq "no response headers policy is touched" "$(ncalls 'response-headers-polic')" 0
echo_last; N=$(updates); run add-data-gate-behaviors.sh --remove
eq "a second --remove is a no-op" "$(updates)" "$N"
contains "...reporting no change" "$OUT" "no change"
eq "...and needs no stack lookup" "$(ncalls "describe-stacks --stack-name hfy-app")" 1
run add-uploads-behavior.sh
eq "afterwards add-uploads-behavior.sh sees the ungated behavior as already right" "$(updates)" "$N"
new_stub "$T/uploads-gated.json"
run add-data-gate-behaviors.sh --remove --restore-uploads-policy-id explicit-policy
eq "--restore-uploads-policy-id wins over the stack output" "$(jq -r '.CacheBehaviors.Items[] | select(.PathPattern == "/uploads/*") | .ResponseHeadersPolicyId' "$(last_update)")" explicit-policy
eq "...with no stack lookup" "$(ncalls describe-stacks)" 0
new_stub "$T/uploads-gated.json"; rm "$STUB_DIR/stack-UploadsResponseHeadersPolicyId"
run add-data-gate-behaviors.sh --remove
eq "--remove refuses when it cannot tell which policy /uploads/* gets back" "$RC" 1
contains "...and says how to name it" "$OUT" "pass --restore-uploads-policy-id"
eq "...without updating anything" "$(updates)" 0
new_stub "$T/uploads-gated.json"
run add-data-gate-behaviors.sh --remove --dry-run
eq "--remove --dry-run never updates" "$(updates)" 0
contains "...and shows the uploads behavior going back" "$OUT" "$RHP_ID"
new_stub; run add-data-gate-behaviors.sh --remove --dry-run --config-file "$T/uploads-gated.json"
eq "offline --remove dry run exits 0" "$RC" 0
contains "...with a placeholder for the policy to restore" "$OUT" "<hfy-app UploadsResponseHeadersPolicyId>"
eq "...and no AWS call" "$(cat "$STUB_DIR/calls.log" 2>/dev/null | wc -l | tr -d ' ')" 0
jq '(.DistributionConfig.CacheBehaviors.Items[] | select(.PathPattern == "/uploads/*") | .LambdaFunctionAssociations) = {Quantity:0}' "$T/uploads-gated.json" > "$T/uploads-foreign.json"
new_stub "$T/uploads-foreign.json"; run add-data-gate-behaviors.sh --remove
eq "an /uploads/* behavior without our association is not ours: it is left exactly as it is" "$(up_beh "$(last_update)")" "$(up_beh "$T/uploads-foreign.json")"
eq "...and needs no policy lookup" "$(ncalls describe-stacks)" 0
new_stub "$T/uploads-gated.json"; seed_rhp2 "$NOSTORE_CFG" "$UPRIVATE_CFG"
run add-data-gate-behaviors.sh --remove
eq "--remove keeps both response headers policies for the next attach" "$(jq length "$STUB_DIR/rhp.json")" 2

CURRENT="data gate: the same behavior set applies to the repo's sample distribution (offline)"
new_stub; run add-data-gate-behaviors.sh --config-file "$ROOT/cloudfront/distribution.json" --version-arn "$GATE_ARN" --dry-run
eq "exit code" "$RC" 0
contains "gates seven patterns" "$OUT" "gating /person/*.json /family/* /event/* /note/* /place/* /media/* /uploads/*"
contains "/uploads/* gets the uploads policy placeholder" "$OUT" '"ResponseHeadersPolicyId": "<hfy-uploads-private policy id>"'
contains "...and the gate association" "$OUT" '"PathPattern": "/uploads/*"'
eq "...with no AWS call" "$(cat "$STUB_DIR/calls.log" 2>/dev/null | wc -l | tr -d ' ')" 0

# ---------------------------------------------------------------------------------------------------------------------
CURRENT="app-stack.yaml"
if python3 -c 'import yaml' 2>/dev/null; then
  if PYTHONDONTWRITEBYTECODE=1 python3 -m unittest -q "$HERE/test_app_stack.py" 2> "$T/py.out"; then ok; else fail "test_app_stack.py"; cat "$T/py.out" >&2; fi
else fail "python3 with PyYAML is required for test_app_stack.py"; fi
CURRENT="edge-gate-stack.yaml"
if python3 -c 'import yaml' 2>/dev/null; then
  if (cd "$HERE" && PYTHONDONTWRITEBYTECODE=1 python3 -m unittest -q test_edge_gate_stack 2> "$T/py2.out"); then ok; else fail "test_edge_gate_stack.py"; cat "$T/py2.out" >&2; fi
fi
CURRENT="mcp-edge401.us-east-1.yaml"
if python3 -c 'import yaml' 2>/dev/null; then
  if (cd "$HERE" && PYTHONDONTWRITEBYTECODE=1 python3 -m unittest -q test_mcp_edge401_stack 2> "$T/py3.out"); then ok; else fail "test_mcp_edge401_stack.py"; cat "$T/py3.out" >&2; fi
fi
if command -v cfn-lint >/dev/null; then
  if cfn-lint "$ROOT/infrastructure/cloudformation/app-stack.yaml" "$ROOT/infrastructure/cloudformation/edge-gate-stack.yaml" "$ROOT/infrastructure/mcp-edge401.us-east-1.yaml" > "$T/lint.out" 2>&1; then ok; else fail "cfn-lint"; cat "$T/lint.out" >&2; fi
else echo "  (cfn-lint not installed: skipped)"; fi

# ---------------------------------------------------------------------------------------------------------------------
CURRENT="privacy and terms pages: the io-approved amendment (HFY-TSK-239)"
# stdlib only (no PyYAML): 11ty/privacy/ and 11ty/terms/ carry every required section of docs/drafts/privacy-terms-2026-10-update.md
if (cd "$HERE" && PYTHONDONTWRITEBYTECODE=1 python3 -m unittest -q test_privacy_terms_pages 2> "$T/py4.out"); then ok; else fail "test_privacy_terms_pages.py"; cat "$T/py4.out" >&2; fi

# ---------------------------------------------------------------------------------------------------------------------
CURRENT="package-edge-gate.sh: content-addressed CodeKey (cfn-code-never-updates, edge-gate-update-same-key-fails)"
if command -v node >/dev/null && command -v zip >/dev/null && command -v openssl >/dev/null; then
  PKG="$T/pkg"; mkdir -p "$PKG/scripts/ci" "$PKG/edge-gate/src"   # a scratch copy: the build writes $PKG/dist, never the repo's dist/
  cp "$ROOT/scripts/ci/package-edge-gate.sh" "$PKG/scripts/ci/"
  cp "$ROOT/edge-gate/src/index.mjs" "$ROOT/edge-gate/src/gate.mjs" "$PKG/edge-gate/src/"
  cp "$ROOT/edge-gate/gate.config.json" "$PKG/edge-gate/"
  pkg_param() { printf '%s\n' "$1" | sed -n "s/^$2=//p"; }
  P1=$(bash "$PKG/scripts/ci/package-edge-gate.sh"); KEY1=$(pkg_param "$P1" CodeKey); SHA1=$(pkg_param "$P1" CodeSha256)
  HEX=$(openssl dgst -sha256 -binary "$PKG/dist/hfy-edge-gate.zip" | od -An -v -tx1 | tr -d ' \n')
  eq "CodeKey is lambda/hfy-edge-gate-<first 16 hex of the zip SHA-256>.zip" "$KEY1" "lambda/hfy-edge-gate-${HEX:0:16}.zip"
  eq "CodeSha256 is the zip's base64 SHA-256" "$SHA1" "$(openssl dgst -sha256 -binary "$PKG/dist/hfy-edge-gate.zip" | openssl base64 -A)"
  eq "dist/hfy-edge-gate.params holds the same two values" "$(cat "$PKG/dist/hfy-edge-gate.params")" "$(printf 'CodeKey=%s\nCodeSha256=%s' "$KEY1" "$SHA1")"
  contains "prints the deploy command with both parameters" "$P1" "CodeKey=$KEY1 CodeSha256=$SHA1"
  eq "the stack template accepts both values" "$(cd "$HERE" && KEY="$KEY1" SHA="$SHA1" python3 -c '
import os, pathlib, re, yaml
from test_app_stack import CfnLoader
p = yaml.load((pathlib.Path("'"$ROOT"'") / "infrastructure/cloudformation/edge-gate-stack.yaml").read_text(), Loader=CfnLoader)["Parameters"]
print(bool(re.match(p["CodeKey"]["AllowedPattern"], os.environ["KEY"])) and bool(re.match(p["CodeSha256"]["AllowedPattern"], os.environ["SHA"])))')" True
  P2=$(bash "$PKG/scripts/ci/package-edge-gate.sh")
  eq "the build is reproducible: same sources, same key" "$(pkg_param "$P2" CodeKey)" "$KEY1"
  echo "// a gate fix" >> "$PKG/edge-gate/src/gate.mjs"
  P3=$(bash "$PKG/scripts/ci/package-edge-gate.sh")
  check "a code change gives a new CodeKey (so CloudFormation updates Function.Code)" test "$(pkg_param "$P3" CodeKey)" != "$KEY1"
  check "...and a new CodeSha256 (so a new Version is published)" test "$(pkg_param "$P3" CodeSha256)" != "$SHA1"
  jq '.fetchTimeoutMs = 2500' "$ROOT/edge-gate/gate.config.json" > "$PKG/edge-gate/gate.config.json"
  P4=$(bash "$PKG/scripts/ci/package-edge-gate.sh")
  check "a config-only change also gives a new CodeKey" test "$(pkg_param "$P4" CodeKey)" != "$(pkg_param "$P3" CodeKey)"
else echo "  (node, zip or openssl missing: package-edge-gate.sh checks skipped)"; fi

# ---------------------------------------------------------------------------------------------------------------------
CURRENT="package-render.sh: the hfy-sync-render zip (HFY-TSK-176)"
if command -v zip >/dev/null && command -v python3 >/dev/null; then
  RPKG="$T/rpkg"; mkdir -p "$RPKG/scripts/ci" "$RPKG/lambda" "$RPKG/gramps"   # a scratch copy: the build writes $RPKG/dist, never the repo's dist/
  cp "$ROOT/scripts/ci/package-render.sh" "$RPKG/scripts/ci/"
  cp -R "$ROOT/lambda/hfy-sync-render" "$RPKG/lambda/"
  cp -R "$ROOT/gramps/hfygramps" "$RPKG/gramps/"
  find "$RPKG" -name '__pycache__' -prune -exec rm -rf {} + 2>/dev/null || true
  render_key() { printf '%s\n' "$1" | sed -n 's/^RenderCodeKey=//p'; }
  R1=$(bash "$RPKG/scripts/ci/package-render.sh"); RKEY1=$(render_key "$R1")
  RHEX=$(python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$RPKG/dist/hfy-sync-render.zip")
  eq "RenderCodeKey is lambda/hfy-sync-render-<first 12 hex of the zip SHA-256>.zip" "$RKEY1" "lambda/hfy-sync-render-${RHEX:0:12}.zip"
  eq "dist/hfy-sync-render.params holds the same key" "$(cat "$RPKG/dist/hfy-sync-render.params")" "RenderCodeKey=$RKEY1"
  RLIST=$(python3 -c 'import sys,zipfile; print("\n".join(i.filename for i in zipfile.ZipFile(sys.argv[1]).infolist()))' "$RPKG/dist/hfy-sync-render.zip")
  for f in handler.py hfy_render/engine.py hfy_render/privacy.py hfy_render/aws.py hfygramps/__init__.py hfygramps/scanner.py hfygramps/render/site.py hfygramps/render/transform.py; do
    contains "the zip holds $f" "$RLIST" "$f"
  done
  for f in hfygramps/merge.py hfygramps/projection.py hfygramps/canonical.py hfygramps/addon hfygramps/schema_check.py tests __pycache__ .pyc .list .files; do
    lacks "the zip does not hold $f" "$RLIST" "$f"
  done
  eq "the zip imports with nothing else on the path, and RENDER_MODE=off is a no-op" "$(cd "$T" && RENDER_MODE=off python3 -I -c '
import sys
sys.path.insert(0, sys.argv[1])
import handler, hfy_render.engine, hfy_render.privacy, hfygramps.render
print(handler.handler({"source": "schedule"}, None)["status"], hfygramps.render.__file__.startswith(sys.argv[1]))' "$RPKG/dist/hfy-sync-render.zip")" "noop True"
  R2=$(bash "$RPKG/scripts/ci/package-render.sh")
  eq "the build is reproducible: same sources, same key" "$(render_key "$R2")" "$RKEY1"
  echo "# a renderer fix" >> "$RPKG/lambda/hfy-sync-render/hfy_render/engine.py"
  R3=$(bash "$RPKG/scripts/ci/package-render.sh")
  check "a code change gives a new RenderCodeKey" test "$(render_key "$R3")" != "$RKEY1"
  rm -f "$RPKG/lambda/hfy-sync-render/hfy_render/keys.py"
  if bash "$RPKG/scripts/ci/package-render.sh" >/dev/null 2>&1; then fail "a package that cannot import must not build"; else ok; fi
else echo "  (zip or python3 missing: package-render.sh checks skipped)"; fi

# ---------------------------------------------------------------------------------------------------------------------
CURRENT="check-deployment-sync.sh: repo-owned 11ty files (person-page-not-repo-owned)"
excludes_of() { grep -oE -- "--exclude '?[^ ']+'?" "$1" | sed -E "s/^--exclude '?//; s/'?\$//" | sort -u; }
SYNC_EX=$(sed -n '/needs_eleventy_check" -eq 1/,/^fi$/p' "$ROOT/scripts/check-deployment-sync.sh" > "$T/sync-11ty.txt"; excludes_of "$T/sync-11ty.txt")
README_EX=$(sed -n '/^rsync -a --delete -n -i/,/_site\//p' "$ROOT/11ty/README.md" > "$T/readme-rsync.txt"; excludes_of "$T/readme-rsync.txt")
contains "the sync check treats js/person-page.js as repo-owned" "$SYNC_EX" "js/person-page.js"
contains "the README refresh rsync excludes js/person-page.js" "$README_EX" "js/person-page.js"
contains "the README repo-owned table lists js/person-page.js" "$(sed -n '/^## Repo-owned files/,/^## Refreshing/p' "$ROOT/11ty/README.md")" "js/person-page.js"
for owned in family-login/ css/auth-edge.css css/hfy-theme.css fonts/ private/; do
  contains "the sync check treats $owned as repo-owned" "$SYNC_EX" "$owned"
  contains "the README refresh rsync excludes $owned" "$README_EX" "$owned"
  contains "the README repo-owned table lists $owned" "$(sed -n '/^## Repo-owned files/,/^## Refreshing/p' "$ROOT/11ty/README.md")" "$owned"
done
CSS_URL=$(jq -r .theme.cssUrl "$ROOT/auth/edge.manifest.json")
check "auth/edge.manifest.json theme.cssUrl is the repo-owned stylesheet, served from the site origin (login CSP style-src)" test "${CSS_URL%%\?*}" = "https://harrisonfamily.us/css/auth-edge.css"
check "...versioned ?v=<sha8 of 11ty/css/auth-edge.css> (Cloudflare caches static files for 4 h; islands/build.mjs stamps it)" test "${CSS_URL#*\?v=}" = "$(shasum -a 256 "$ROOT/11ty/css/auth-edge.css" | cut -c1-8)"
check "...and that file exists in 11ty/css" test -s "$ROOT/11ty/css/auth-edge.css"
# 11ty/README.md is repo-only: the static sync excludes it (ci.manifest.yaml, rendered into the io-kit-ci deploy-static and invalidate actions)
MANIFEST_EX=$(sed -n '/^      exclude:/,/^      invalidate:/p' "$ROOT/ci.manifest.yaml")
contains "ci.manifest.yaml keeps README.md out of the static sync" "$MANIFEST_EX" "README.md"
contains "...and the rendered deploy-static action carries the same exclude" "$(cat "$ROOT/.github/actions/io-kit-ci/deploy-static/action.yml")" '"uploads/*","README.md"'
eq "the README rsync and the sync check exclude the same paths (besides .DS_Store)" "$(printf '%s\n' "$SYNC_EX" | grep -vx '.DS_Store')" "$README_EX"
if command -v rsync >/dev/null && command -v git >/dev/null; then
  DS="$T/ds"; mkdir -p "$DS/workspace/11ty-dev/_site/js" "$DS/repo/11ty/js"
  git -C "$DS/repo" init -q
  echo 'site' > "$DS/workspace/11ty-dev/_site/js/app.js"; cp "$DS/workspace/11ty-dev/_site/js/app.js" "$DS/repo/11ty/js/app.js"
  echo '// legacy X-HFY-Session wait' > "$DS/workspace/11ty-dev/_site/js/person-page.js"
  echo '// authV2 dataFetchInit/dataResponse' > "$DS/repo/11ty/js/person-page.js"
  git -C "$DS/repo" add -A
  set +e; DS_OUT=$(cd "$DS/repo" && bash "$ROOT/scripts/check-deployment-sync.sh" 2>&1); DS_RC=$?; set -e
  eq "a repo-only person-page.js does not fail the pre-commit sync check" "$DS_RC" 0
  mkdir -p "$DS/workspace/11ty-dev/_site/css" "$DS/repo/11ty/css"; echo '/* site */' > "$DS/workspace/11ty-dev/_site/css/main.css"; cp "$DS/workspace/11ty-dev/_site/css/main.css" "$DS/repo/11ty/css/main.css"
  echo '/* auth edge */' > "$DS/repo/11ty/css/auth-edge.css"; mkdir -p "$DS/repo/11ty/family-login" "$DS/workspace/11ty-dev/_site/family-login"
  echo '<!-- redirect to /auth/login -->' > "$DS/repo/11ty/family-login/index.html"
  echo '<!-- legacy Google sign-in page -->' > "$DS/workspace/11ty-dev/_site/family-login/index.html"; git -C "$DS/repo" add -A
  set +e; DS_OUT=$(cd "$DS/repo" && bash "$ROOT/scripts/check-deployment-sync.sh" 2>&1); DS_RC=$?; set -e
  eq "a repo-only css/auth-edge.css and a repo-owned family-login/ page do not fail it either" "$DS_RC" 0
  # design-system pass: the theme layer and the self-hosted faces are islands/build.mjs outputs the workspace never produces
  mkdir -p "$DS/repo/11ty/fonts"; echo 'woff2' > "$DS/repo/11ty/fonts/source-sans-3-latin-wght-normal.0123abcd.woff2"
  echo 'OFL' > "$DS/repo/11ty/fonts/LICENSE-source-sans-3.txt"; echo '/* generated theme */' > "$DS/repo/11ty/css/hfy-theme.css"
  git -C "$DS/repo" add -A
  set +e; DS_OUT=$(cd "$DS/repo" && bash "$ROOT/scripts/check-deployment-sync.sh" 2>&1); DS_RC=$?; set -e
  eq "a repo-only css/hfy-theme.css and fonts/ do not fail it either" "$DS_RC" 0
  echo 'drifted' > "$DS/repo/11ty/js/app.js"; git -C "$DS/repo" add -A
  set +e; DS_OUT=$(cd "$DS/repo" && bash "$ROOT/scripts/check-deployment-sync.sh" 2>&1); DS_RC=$?; set -e
  eq "a drifted workspace-owned file still fails it" "$DS_RC" 1
  contains "...naming the file" "$DS_OUT" "js/app.js"
  lacks "...and not person-page.js" "$DS_OUT" "person-page.js"
  # HFY-TSK-325: getAllowlist and its source are deleted, so a staged functions/ path no longer starts a Cloud Function
  # comparison (the old check failed here: there is no workspace/gcloud/allowlist-fn source). cp -p keeps the workspace mtime: a plain
  # cp stamps the restored file with the current time, and rsync -ain reports it (>f..t) once a second has passed since the workspace write.
  cp -p "$DS/workspace/11ty-dev/_site/js/app.js" "$DS/repo/11ty/js/app.js"
  mkdir -p "$DS/repo/functions/get-allowlist"; echo '# stray' > "$DS/repo/functions/get-allowlist/main.py"; git -C "$DS/repo" add -A
  set +e; DS_OUT=$(cd "$DS/repo" && bash "$ROOT/scripts/check-deployment-sync.sh" 2>&1); DS_RC=$?; set -e
  eq "a staged functions/ path runs no Cloud Function comparison" "$DS_RC" 0
  lacks "...and the output names no GCF check" "$DS_OUT" "GCF"
  # HFY-TSK-326: hfy-check-allowed and lambda/hfy-check-allowed/ are deleted, so a staged lambda/ path no longer starts a Lambda
  # comparison (the old check would fail here: there is no scripts/auth/check-allowed-lambda source).
  mkdir -p "$DS/repo/lambda/hfy-check-allowed"; echo '// stray' > "$DS/repo/lambda/hfy-check-allowed/index.mjs"; git -C "$DS/repo" add -A
  set +e; DS_OUT=$(cd "$DS/repo" && bash "$ROOT/scripts/check-deployment-sync.sh" 2>&1); DS_RC=$?; set -e
  eq "a staged lambda/ path runs no Lambda comparison" "$DS_RC" 0
  lacks "...and the output names no hfy-check-allowed check" "$DS_OUT" "hfy-check-allowed"
else echo "  (rsync or git missing: check-deployment-sync.sh run skipped)"; fi
lacks "check-deployment-sync.sh has no getAllowlist comparison left" "$(cat "$ROOT/scripts/check-deployment-sync.sh")" "needs_gcf_check"
lacks "check-deployment-sync.sh has no hfy-check-allowed comparison left" "$(cat "$ROOT/scripts/check-deployment-sync.sh")" "needs_lambda_check"
check "lambda/hfy-check-allowed/ is gone from the repository (HFY-TSK-326)" test ! -e "$ROOT/lambda/hfy-check-allowed"

# ---------------------------------------------------------------------------------------------------------------------
CURRENT="cloudfront function: node --test scripts/cloudfront/test (HFYAppendIndex source, every private-prefix variant)"
if command -v node >/dev/null; then
  if node --test "$ROOT"/scripts/cloudfront/test/*.test.mjs > "$T/fn-test.out" 2>&1; then ok; else fail "node --test scripts/cloudfront/test"; sed 's/^/    | /' "$T/fn-test.out" | tail -40 >&2; fi
else echo "  (node not installed: scripts/cloudfront tests skipped)"; fi

CURRENT="publish-append-index.sh: diff, test-function gate, publish, backup, idempotency, refusals"
if command -v node >/dev/null; then
  NEW_FN="$ROOT/scripts/cloudfront/append-index.js"; CASES_JSON="$ROOT/scripts/cloudfront/test/append-index.cases.json"
  OLD_FN="$T/old-append-index.js"
  cat > "$OLD_FN" <<'OLDJS'
function handler(event) {
  var request = event.request;
  var uri = request.uri;

  if (uri.endsWith('/')) {
    request.uri += 'index.html';
  } else if (!uri.includes('.')) {
    request.uri += '/index.html';
  }

  return request;
}
OLDJS
  n_samples=$(jq '.awsSamples | length' "$CASES_JSON"); n_all=$(jq '(.rewrite | length) + (.deny | length)' "$CASES_JSON")
  fn_stub() { new_stub; cp "$OLD_FN" "$STUB_DIR/fn-LIVE.js"; cp "$OLD_FN" "$STUB_DIR/fn-DEVELOPMENT.js"; } # LIVE and DEVELOPMENT both run the pre-hardening code
  fn_calls() { ncalls "^cloudfront $1"; }
  fn_backups() { find "$STUB_DIR/backups" -name 'HFYAppendIndex-*-before.js' 2>/dev/null | wc -l | tr -d ' '; }

  fn_stub
  run publish-append-index.sh --dry-run
  eq "dry run exit code" "$RC" 0
  contains "dry run shows the LIVE diff" "$OUT" "--- LIVE HFYAppendIndex"
  contains "...and the DEVELOPMENT diff" "$OUT" "--- DEVELOPMENT HFYAppendIndex"
  contains "...adding the deny code" "$OUT" "+function notFound()"
  contains "...with the plan" "$OUT" "(dry-run) would save the previous code to"
  contains "...and no changes made" "$OUT" "(dry-run) no changes made"
  eq "dry run: no update-function" "$(fn_calls update-function)" 0
  eq "dry run: no test-function" "$(fn_calls test-function)" 0
  eq "dry run: no publish-function" "$(fn_calls publish-function)" 0
  eq "dry run: no backup written" "$(fn_backups)" 0
  eq "dry run: LIVE untouched" "$(cmp -s "$STUB_DIR/fn-LIVE.js" "$OLD_FN" && echo same)" same

  run publish-append-index.sh
  eq "publish exit code" "$RC" 0
  eq "one update-function, with the ETag it read" "$(grep -c '^cloudfront update-function --name HFYAppendIndex --if-match EFN-1 ' "$STUB_DIR/calls.log")" 1
  eq "the config keeps the runtime" "$(grep '^cloudfront update-function' "$STUB_DIR/calls.log" | grep -c '"Runtime":"cloudfront-js-1.0"')" 1
  eq "test-function ran the awsSamples on DEVELOPMENT with the ETag update-function returned" "$(grep -c '^cloudfront test-function --name HFYAppendIndex --if-match EFN-2 --stage DEVELOPMENT --event-object ' "$STUB_DIR/calls.log")" "$n_samples"
  eq "one publish-function with that ETag" "$(grep -c '^cloudfront publish-function --name HFYAppendIndex --if-match EFN-2' "$STUB_DIR/calls.log")" 1
  eq "order: update, then every test, then publish" "$(grep -n '^cloudfront \(update-function\|test-function\|publish-function\)' "$STUB_DIR/calls.log" | sed -E 's/^[0-9]+:cloudfront ([a-z-]+).*/\1/' | uniq | tr '\n' ' ')" "update-function test-function publish-function "
  eq "LIVE now runs the repo code" "$(cmp -s "$STUB_DIR/fn-LIVE.js" "$NEW_FN" && echo same)" same
  eq "DEVELOPMENT too" "$(cmp -s "$STUB_DIR/fn-DEVELOPMENT.js" "$NEW_FN" && echo same)" same
  contains "reports the test result" "$OUT" "all $n_samples test-function cases pass"
  contains "reports the publish" "$OUT" "published: HFYAppendIndex LIVE now runs the repo code"
  contains "prints the rollback command" "$OUT" "roll back with:"
  contains "...which restores the saved code" "$OUT" "update-function --name HFYAppendIndex"
  LB=$(find "$STUB_DIR/backups" -name 'HFYAppendIndex-LIVE-*-before.js' | head -1)
  check "the previous LIVE code is saved outside the repo" test -s "$LB"
  eq "...and is exactly the old code" "$(cmp -s "$LB" "$OLD_FN" && echo same)" same
  eq "...mode 600" "$(stat -c %a "$LB" 2>/dev/null || stat -f %Lp "$LB")" 600
  eq "a DEVELOPMENT copy identical to LIVE is not saved twice" "$(fn_backups)" 1
  contains "the rollback command names that file" "$OUT" "fileb://$LB"

  N=$(fn_calls update-function); P=$(fn_calls publish-function); NT=$(fn_calls test-function)
  run publish-append-index.sh
  eq "rerun exit code" "$RC" 0
  contains "rerun says no change" "$OUT" "already runs the repo code on LIVE: no change"
  eq "rerun: no update-function" "$(fn_calls update-function)" "$N"
  eq "rerun: no publish-function" "$(fn_calls publish-function)" "$P"
  eq "rerun: no test-function" "$(fn_calls test-function)" "$NT"
  eq "rerun: no new backup" "$(fn_backups)" 1

  fn_stub; run publish-append-index.sh --all-cases
  eq "--all-cases runs every case of the table through test-function" "$(fn_calls test-function)" "$n_all"
  eq "...and publishes" "$(fn_calls publish-function)" 1

  fn_stub; cp "$NEW_FN" "$STUB_DIR/fn-DEVELOPMENT.js"
  run publish-append-index.sh
  eq "an interrupted run (DEVELOPMENT already updated, LIVE old) resumes: exit code" "$RC" 0
  eq "...without a second update-function" "$(fn_calls update-function)" 0
  eq "...but with every test" "$(fn_calls test-function)" "$n_samples"
  eq "...and the publish" "$(fn_calls publish-function)" 1
  eq "...LIVE now runs the repo code" "$(cmp -s "$STUB_DIR/fn-LIVE.js" "$NEW_FN" && echo same)" same
  contains "...with the original ETag" "$(cat "$STUB_DIR/calls.log")" "cloudfront publish-function --name HFYAppendIndex --if-match EFN-1"

  fn_stub; cp "$NEW_FN" "$STUB_DIR/fn-LIVE.js"; echo '// a stray draft' > "$STUB_DIR/fn-DEVELOPMENT.js"
  run publish-append-index.sh
  eq "LIVE already right: exit code" "$RC" 0
  contains "...a stray DEVELOPMENT draft is reported" "$OUT" "a stray draft, not served); left alone"
  eq "...and left alone: nothing written" "$(( $(fn_calls update-function) + $(fn_calls publish-function) + $(fn_calls test-function) ))" 0

  # a source that fails the function tests is never published (custom --source skips the local unit tests, test-function must stop it)
  STALE="$T/stale-live.js"; echo 'function handler(event) { return event.request; }' > "$STALE"
  fn_stub; cp "$STALE" "$STUB_DIR/fn-LIVE.js"; cp "$STALE" "$STUB_DIR/fn-DEVELOPMENT.js"
  run publish-append-index.sh --source "$OLD_FN"
  eq "the pre-hardening code fails the deny cases: exit 1" "$RC" 1
  contains "...refusing to publish" "$OUT" "refusing to publish:"
  contains "...naming a failing case" "$OUT" 'FAIL "/Person/index.json"'
  eq "...never calling publish-function" "$(fn_calls publish-function)" 0
  eq "...LIVE untouched" "$(cmp -s "$STUB_DIR/fn-LIVE.js" "$STALE" && echo same)" same
  eq "...with the previous LIVE code saved" "$(fn_backups)" 1
  printf '%s\n' 'function handler(event) { throw new Error("boom"); }' > "$T/throws.js"
  fn_stub; run publish-append-index.sh --source "$T/throws.js"
  eq "a function that throws is refused" "$RC" 1
  contains "...as an error" "$OUT" "got [error "
  eq "...and not published" "$(fn_calls publish-function)" 0
  printf '%s\n' "function handler(event) { var r = event.request; if (r.uri.indexOf('/Media/') === 0) { return { statusCode: 404 }; } return r; }" > "$T/partial.js"
  fn_stub; run publish-append-index.sh --source "$T/partial.js"
  eq "a deny without Cache-Control: private, no-store is refused" "$RC" 1
  eq "...and not published" "$(fn_calls publish-function)" 0

  # refusals before anything is read from or written to AWS
  : > "$T/empty.js"; head -c 11000 /dev/zero | tr '\0' 'x' > "$T/big.js"; echo 'var x = 1;' > "$T/nohandler.js"
  for BADSRC in "$T/missing.js" "$T/empty.js" "$T/big.js" "$T/nohandler.js"; do
    fn_stub; run publish-append-index.sh --source "$BADSRC"
    eq "refuses source $(basename "$BADSRC")" "$RC" 2
    eq "...without any AWS call" "$(cat "$STUB_DIR/calls.log" 2>/dev/null | wc -l | tr -d ' ')" 0
  done
  fn_stub; run publish-append-index.sh --comment "$(head -c 129 /dev/zero | tr '\0' c)"
  eq "refuses a comment over 128 characters" "$RC" 2
  fn_stub; run publish-append-index.sh --bogus
  eq "unknown arg" "$RC" 2
  # refusals after reading the live state: nothing is written
  fn_stub; printf 'HFYOther' > "$STUB_DIR/fn-name"
  run publish-append-index.sh
  eq "a function that does not exist is refused (this script never creates one)" "$RC" 1
  contains "...saying so" "$OUT" "cannot describe function HFYAppendIndex"
  eq "...no write" "$(( $(fn_calls update-function) + $(fn_calls publish-function) ))" 0
  fn_stub; printf 'cloudfront-js-2.0' > "$STUB_DIR/fn-runtime"
  run publish-append-index.sh
  eq "a runtime other than cloudfront-js-1.0 is refused" "$RC" 1
  contains "...explaining" "$OUT" "runs cloudfront-js-2.0"
  eq "...no write" "$(( $(fn_calls update-function) + $(fn_calls publish-function) ))" 0
  fn_stub; jq '.DistributionConfig.CacheBehaviors.Items[1].FunctionAssociations = {Quantity:1,Items:[{FunctionARN:"arn:aws:cloudfront::123456789012:function/HFYAppendIndex",EventType:"viewer-request"}]}' "$FIXTURE" > "$STUB_DIR/get.json"
  run publish-append-index.sh
  eq "a function also attached to a non-default behavior is refused (it would 404 the gated data itself)" "$RC" 3
  contains "...naming the behavior" "$OUT" "associated with cache behavior(s) /api/*"
  eq "...no write" "$(( $(fn_calls update-function) + $(fn_calls publish-function) ))" 0
  run publish-append-index.sh --distribution none
  eq "--distribution none skips the association check" "$RC" 0
  eq "...and publishes" "$(fn_calls publish-function)" 1
  fn_stub; rm "$STUB_DIR/get.json"
  run publish-append-index.sh
  eq "an unreadable distribution is refused" "$RC" 1
  eq "...no write" "$(( $(fn_calls update-function) + $(fn_calls publish-function) ))" 0
  fn_stub; rm "$STUB_DIR/fn-LIVE.js"
  run publish-append-index.sh
  eq "a function that was never published (no LIVE stage) can be published" "$RC" 0
  eq "...LIVE now runs the repo code" "$(cmp -s "$STUB_DIR/fn-LIVE.js" "$NEW_FN" && echo same)" same
  contains "...the diff says there is no LIVE stage yet" "$OUT" "(no LIVE stage yet)"
  eq "...its DEVELOPMENT code was saved (there is no LIVE code to save)" "$(find "$STUB_DIR/backups" -name 'HFYAppendIndex-DEVELOPMENT-*-before.js' | wc -l | tr -d ' ')" 1
else echo "  (node not installed: publish-append-index.sh tests skipped)"; fi

# ---------------------------------------------------------------------------------------------------------------------
CURRENT="site bucket CORS: the committed rule allows only PUT with Content-Type from the two site origins (HFY-TSK-314)"
CORS_RULE="$ROOT/infrastructure/cloudformation/site-bucket-cors.json"
SITE_ORIGINS='["https://harrisonfamily.us","https://www.harrisonfamily.us"]'
# One line per way a CORS configuration differs from "PUT with Content-Type from the two site origins": any other method, origin
# (wildcards included) or request header in any rule, a site origin that cannot PUT with Content-Type, or a key that
# put-bucket-cors rejects. Empty output means the configuration is exactly as wide as photo uploads need.
cors_violations() { # CORS_JSON_FILE
  jq -r --argjson site "$SITE_ORIGINS" '
    if type != "object" or (.CORSRules | type) != "array" or (.CORSRules | length) == 0 then "no CORSRules"
    else
      .CORSRules as $rules
      | (keys - ["CORSRules"] | .[] | "top-level key \(.) (put-bucket-cors rejects it)"),
        ($rules[] | (.ID // "(no ID)") as $id
          | ((.AllowedMethods // [])[] | select(. != "PUT") | "\($id): method \(.)"),
            ((.AllowedOrigins // [])[] | . as $o | select(any($site[]; . == $o) | not) | "\($id): origin \(.)"),
            ((.AllowedHeaders // [])[] | select(ascii_downcase != "content-type") | "\($id): header \(.)")),
        ($site[] | . as $o
          | select(any($rules[]; any((.AllowedOrigins // [])[]; . == $o) and any((.AllowedMethods // [])[]; . == "PUT")
              and any((.AllowedHeaders // [])[]; ascii_downcase == "content-type")) | not)
          | "origin \($o) cannot PUT with Content-Type")
    end' "$1"
}
cors_mutant() { jq "$1" "$CORS_RULE" > "$T/cors-mutant.json"; cors_violations "$T/cors-mutant.json"; } # JQ_EDIT -> violations
eq "site-bucket-cors.json allows PUT with Content-Type from https://harrisonfamily.us and https://www.harrisonfamily.us, nothing else" "$(cors_violations "$CORS_RULE")" ""
eq "...and is the rule applied to the bucket (ID, ExposeHeaders ETag, MaxAgeSeconds 3000), with no key put-bucket-cors rejects" "$(jq -cS . "$CORS_RULE")" '{"CORSRules":[{"AllowedHeaders":["Content-Type"],"AllowedMethods":["PUT"],"AllowedOrigins":["https://harrisonfamily.us","https://www.harrisonfamily.us"],"ExposeHeaders":["ETag"],"ID":"hfy-member-photo-uploads","MaxAgeSeconds":3000}]}'
for m in GET HEAD POST DELETE; do
  contains "the check fails when the rule also allows $m" "$(cors_mutant ".CORSRules[0].AllowedMethods += [\"$m\"]")" "hfy-member-photo-uploads: method $m"
done
contains "...or allows POST instead of PUT" "$(cors_mutant '.CORSRules[0].AllowedMethods = ["POST"]')" "origin https://harrisonfamily.us cannot PUT with Content-Type"
for o in '*' 'https://*.harrisonfamily.us' 'http://harrisonfamily.us' 'https://cors-check.invalid' 'null'; do
  contains "the check fails when the rule also allows origin $o" "$(cors_mutant ".CORSRules[0].AllowedOrigins += [\"$o\"]")" "hfy-member-photo-uploads: origin $o"
done
contains "...or drops https://www.harrisonfamily.us" "$(cors_mutant '.CORSRules[0].AllowedOrigins = ["https://harrisonfamily.us"]')" "origin https://www.harrisonfamily.us cannot PUT with Content-Type"
for h in '*' 'Content-*' 'Content-Length' 'x-amz-acl' 'Authorization'; do
  contains "the check fails when the rule also allows header $h" "$(cors_mutant ".CORSRules[0].AllowedHeaders += [\"$h\"]")" "hfy-member-photo-uploads: header $h"
done
contains "...or allows no header (the browser's Content-Type preflight would fail)" "$(cors_mutant 'del(.CORSRules[0].AllowedHeaders)')" "origin https://harrisonfamily.us cannot PUT with Content-Type"
eq "...but not when Content-Type is spelled in lower case (S3 compares header names case-insensitively)" "$(cors_mutant '.CORSRules[0].AllowedHeaders = ["content-type"]')" ""
V=$(cors_mutant '.CORSRules += [{ID: "extra", AllowedOrigins: ["*"], AllowedMethods: ["GET"]}]')
contains "a second, wider rule fails it (its origin)" "$V" "extra: origin *"
contains "...(its method)" "$V" "extra: method GET"
contains "a _comment key fails it (put-bucket-cors rejects unknown keys, so the file is applied as committed)" "$(cors_mutant '._comment = "x"')" "top-level key _comment"
eq "an empty rule list fails it" "$(cors_mutant '.CORSRules = []')" "no CORSRules"
STAND_UP="$ROOT/docs/how-to/stand-up-the-static-site.md"
contains "stand-up-the-static-site.md applies the committed file with put-bucket-cors" "$(tr -d '\\\n' < "$STAND_UP" | tr -s ' ')" "aws s3api put-bucket-cors --bucket <site-bucket> --cors-configuration file://infrastructure/cloudformation/site-bucket-cors.json"
OLD_CORS_FILE="media-bucket""-cors.json"
eq "no doc, code or template still names the old CORS file" "$(grep -rIl --exclude-dir=node_modules "$OLD_CORS_FILE" "$ROOT/docs" "$ROOT/api/src" "$ROOT/infrastructure" "$ROOT/scripts" "$ROOT/AGENTS.md" "$ROOT/README.md" 2>/dev/null)" ""

# ---------------------------------------------------------------------------------------------------------------------
CURRENT="check-site-bucket-cors.sh: post-deploy CORS preflights (offline here: test/stub-curl answers as S3 would)"
CURL_STUB_BIN="$HERE/stub-curl"
CORS_URL="https://harrisonfamily-frontend.s3.us-west-2.amazonaws.com/uploads/posts/smoke/x.jpg"
cors_stub() { # [BUCKET_CORS_JSON] -> a fresh $STUB_DIR whose bucket has that CORS configuration (none without an argument)
  STUB_DIR=$(mktemp -d "$T/curl.XXXXXX"); export STUB_DIR
  if [ -n "${1:-}" ]; then printf '%s\n' "$1" > "$STUB_DIR/cors.json"; fi
}
cors_check() { # ARGS... -> OUT, RC
  set +e
  OUT=$(PATH="$CURL_STUB_BIN:$PATH" "$INFRA/check-site-bucket-cors.sh" "$@" 2>&1); RC=$?
  set -e
}
cors_stub "$(cat "$CORS_RULE")"; cors_check
eq "a bucket with the committed rule passes" "$RC" 0
contains "...200 for PUT with Content-Type from https://harrisonfamily.us" "$OUT" "ok   200 PUT with Content-Type from https://harrisonfamily.us"
contains "...and from https://www.harrisonfamily.us" "$OUT" "ok   200 PUT with Content-Type from https://www.harrisonfamily.us"
contains "...403 for a foreign origin" "$OUT" "ok   403 PUT with Content-Type from the foreign origin https://cors-check.invalid"
contains "...403 for DELETE" "$OUT" "ok   403 DELETE from https://harrisonfamily.us"
contains "...403 for an extra request header" "$OUT" "ok   403 PUT with an x-amz-acl header from https://harrisonfamily.us"
eq "...its first request is an OPTIONS preflight for PUT to uploads/posts/smoke/x.jpg from https://harrisonfamily.us" "$(head -n 1 "$STUB_DIR/curl.log")" "OPTIONS $CORS_URL|https://harrisonfamily.us|PUT|content-type"
eq "...and it sends only OPTIONS preflights, five of them" "$(grep -c "^OPTIONS $CORS_URL|" "$STUB_DIR/curl.log")|$(wc -l < "$STUB_DIR/curl.log" | tr -d ' ')" "5|5"
cors_stub; cors_check
eq "a bucket with no CORS configuration (the HFY-TSK-314 incident) fails" "$RC" 1
contains "...naming the origin whose uploads fail" "$OUT" "::error::site bucket CORS: PUT with Content-Type from https://harrisonfamily.us: expected 200"
cors_stub "$(jq '.CORSRules[0].AllowedOrigins = ["https://harrisonfamily.us"]' "$CORS_RULE")"; cors_check
eq "a bucket that drops https://www.harrisonfamily.us fails" "$RC" 1
contains "...naming it" "$OUT" "PUT with Content-Type from https://www.harrisonfamily.us: expected 200"
cors_stub "$(jq '.CORSRules[0].AllowedOrigins = ["*"]' "$CORS_RULE")"; cors_check
eq "a bucket that allows any origin fails" "$RC" 1
contains "...because the foreign origin gets 200" "$OUT" "foreign origin https://cors-check.invalid: expected 403, got 200"
contains "...and Access-Control-Allow-Origin is * rather than the site origin" "$OUT" "got 200 (Access-Control-Allow-Origin: *;"
cors_stub "$(jq '.CORSRules[0].AllowedMethods += ["DELETE"]' "$CORS_RULE")"; cors_check
eq "a bucket that also allows DELETE fails" "$RC" 1
contains "...naming it" "$OUT" "DELETE from https://harrisonfamily.us: expected 403, got 200"
cors_stub "$(jq '.CORSRules[0].AllowedHeaders = ["*"]' "$CORS_RULE")"; cors_check
eq "a bucket that allows any request header fails" "$RC" 1
contains "...naming the probe" "$OUT" "PUT with an x-amz-acl header from https://harrisonfamily.us: expected 403, got 200"
cors_stub "$(jq '.CORSRules[0].AllowedMethods = ["GET"]' "$CORS_RULE")"; cors_check
eq "a bucket whose rule does not allow PUT fails" "$RC" 1
cors_stub "$(cat "$CORS_RULE")"; echo no-acao > "$STUB_DIR/curl-mode"; cors_check
eq "a 200 without Access-Control-Allow-Origin fails" "$RC" 1
contains "...saying so" "$OUT" "(Access-Control-Allow-Origin: none;"
cors_stub "$(cat "$CORS_RULE")"; echo down > "$STUB_DIR/curl-mode"; cors_check
eq "no response at all fails (a 403 is required, not merely the absence of a 200)" "$RC" 1
contains "...saying so" "$OUT" "the foreign origin https://cors-check.invalid: no response from $CORS_URL"
cors_stub "$(cat "$CORS_RULE")"
cors_check --url http://harrisonfamily-frontend.s3.us-west-2.amazonaws.com/x.jpg
eq "an http:// --url is refused" "$RC" 2
jq '.CORSRules[0].AllowedOrigins += ["*"]' "$CORS_RULE" > "$T/cors-wild.json"; cors_check --rule "$T/cors-wild.json"
eq "a --rule with a wildcard origin is refused" "$RC" 2
cors_check --bogus
eq "an unknown argument is refused" "$RC" 2
eq "...and none of the refusals sent a request" "$(cat "$STUB_DIR/curl.log" 2>/dev/null | wc -l | tr -d ' ')" 0
# Where it runs: after every successful deploy run, as its own workflow. The kit's deploy.smoke takes URLs only, GETs them and
# passes 2xx/3xx, and its failure redeploys the previous release, which cannot repair a bucket CORS rule.
if python3 -c 'import yaml' 2>/dev/null; then
  WIRING=$(ROOT="$ROOT" python3 - <<'PY'
import os, pathlib, re, yaml
root = pathlib.Path(os.environ["ROOT"])
manifest = yaml.safe_load((root / "ci.manifest.yaml").read_text())
deploy = manifest["deploy"]
bucket = next(t["bucket"] for t in deploy["targets"] if t["kind"] == "s3_static")
deploy_name = (manifest.get("workflows") or {}).get("deploy", "io-kit deploy")
rendered = yaml.safe_load((root / ".github/workflows/io-kit-deploy.yml").read_text())
wf = yaml.safe_load((root / ".github/workflows/post-deploy-checks.yml").read_text())
on = wf.get("on", wf.get(True))  # PyYAML reads the bare key `on` as True
job = wf["jobs"]["site-bucket-cors"]
script = (root / "scripts/infra/check-site-bucket-cors.sh").read_text()
default_url = re.search(r'^URL="([^"]+)"$', script, re.M).group(1)
print("deploy-name", rendered["name"] == deploy_name)
print("trigger", on["workflow_run"]["workflows"] == [deploy_name] and on["workflow_run"]["types"] == ["completed"]
      and on["workflow_run"]["branches"] == [manifest.get("branch", "main")])
print("success-only", "workflow_run.conclusion == 'success'" in job["if"])
print("runs-script", any(s.get("run") == "bash scripts/infra/check-site-bucket-cors.sh" for s in job["steps"]))
print("read-only", wf["permissions"] == {"contents": "read"} and "permissions" not in job)
print("default-url", default_url == f"https://{bucket}.s3.{deploy['region']}.amazonaws.com/uploads/posts/smoke/x.jpg")
print("smoke-not-s3", not any(".amazonaws.com" in u for u in deploy.get("smoke", [])))
PY
  )
  contains "the rendered deploy workflow is named as ci.manifest.yaml says" "$WIRING" "deploy-name True"
  contains "post-deploy-checks.yml runs on workflow_run of that workflow, when it completes on the deploy branch" "$WIRING" "trigger True"
  contains "...only after a successful deploy run (or by hand)" "$WIRING" "success-only True"
  contains "...runs check-site-bucket-cors.sh" "$WIRING" "runs-script True"
  contains "...with contents: read and nothing else (no AWS credentials)" "$WIRING" "read-only True"
  contains "the script's default URL is the ci.manifest.yaml site bucket, in deploy.region, at uploads/posts/smoke/x.jpg" "$WIRING" "default-url True"
  contains "deploy.smoke never names an S3 endpoint (a GET there answers 403, which would roll back every deploy)" "$WIRING" "smoke-not-s3 True"
else fail "python3 with PyYAML is required for the post-deploy-checks.yml wiring checks"; fi

# shellcheck source=/dev/null
. "$HERE/guard-tests.inc.sh"

CURRENT="shellcheck"
if command -v shellcheck >/dev/null; then
  if shellcheck -x "$INFRA"/*.sh "$INFRA"/lib/*.sh "$HERE"/run.sh "$HERE"/guard-tests.inc.sh "$STUB_BIN"/aws "$HERE"/stub-curl/curl > "$T/sc.out" 2>&1; then ok; else fail "shellcheck"; cat "$T/sc.out" >&2; fi
else echo "  (shellcheck not installed: skipped)"; fi

echo "scripts/infra tests: $PASS passed, $FAILED failed"
[ "$FAILED" = 0 ]
