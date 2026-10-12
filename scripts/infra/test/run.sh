#!/usr/bin/env bash
# Offline tests for scripts/infra (HFY-R58). Never touches AWS: test/stub/aws is first on PATH for every script run.
# Usage: scripts/infra/test/run.sh        (needs bash, jq, python3 with PyYAML; uses cfn-lint and shellcheck when installed)
# shellcheck disable=SC2016 # the jq programs are single-quoted on purpose
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
quantities_ok() { jq -e '.DistributionConfig // . | (.Origins.Quantity == (.Origins.Items | length)) and (.CacheBehaviors.Quantity == (.CacheBehaviors.Items | length))' "$1"; }

# ---------------------------------------------------------------------------------------------------------------------
CURRENT="lib: norm, glob"
eq "norm ignores string-set order, empty Items and empty optional ids" \
  "$(cfg -c 'include "cf"; [ ({AllowedMethods:{Quantity:2,Items:["HEAD","GET"]},OriginRequestPolicyId:"",L:{Quantity:0,Items:[]}} | norm) == ({AllowedMethods:{Quantity:2,Items:["GET","HEAD"]},L:{Quantity:0}} | norm) ]' -n)" '[true]'
eq "norm keeps real differences" "$(cfg -c -n 'include "cf"; [({CachePolicyId:"a"}|norm) == ({CachePolicyId:"b"}|norm), ({Items:[{a:2},{a:1}]}|norm) == ({Items:[{a:1},{a:2}]}|norm)]')" '[false,false]'
eq "CloudFront glob semantics" "$(cfg -c -n 'include "cf"; [("/api/*"|pattern_matches("/api/check-allowed")), ("api/*"|pattern_matches("/api/check-allowed")), ("/api/check-allowed*"|pattern_matches("/api/check-allowed")), ("/api/check-allowed*"|pattern_matches("/api/posts")), ("/API/*"|pattern_matches("/api/x")), ("/a.i/*"|pattern_matches("/api/x")), ("/ap?/*"|pattern_matches("/api/x"))]')" '[true,true,true,false,false,false,true]'

# ---------------------------------------------------------------------------------------------------------------------
CURRENT="api: pins legacy /api/check-allowed to its current origin, before /api/*"
new_stub
run add-api-behavior.sh
eq "exit code" "$RC" 0
eq "one update-distribution call" "$(updates)" 1
U=$(last_update)
eq "update uses the fetched ETag" "$(cat "$STUB_DIR/update-1.etag")" E1LIVEETAG
eq "behavior order: pin immediately before /api/*" "$(patterns "$U")" '["/person/*","/api/check-allowed*","/api/*"]'
eq "pin is the old /api/* behavior verbatim except PathPattern" \
  "$(jq -c --slurpfile f "$FIXTURE" '([.CacheBehaviors.Items[] | select(.PathPattern == "/api/check-allowed*")][0] | del(.PathPattern)) == ([$f[0].DistributionConfig.CacheBehaviors.Items[] | select(.PathPattern == "/api/*")][0] | del(.PathPattern))' "$U")" true
eq "POST /api/check-allowed still reaches the legacy API Gateway" "$(route "$U" /api/check-allowed)" api-gateway-hfy-check-allowed
eq "new routes reach hfy-api" "$(route "$U" /api/posts)" hfy-api-origin
eq "/person/* untouched" "$(route "$U" /person/I0001.json)" s3-frontend
eq "/api/* moved in place with the managed policies" \
  "$(jq -c '.CacheBehaviors.Items[] | select(.PathPattern == "/api/*") | [.CachePolicyId, .OriginRequestPolicyId, .ViewerProtocolPolicy, .GrpcConfig.Enabled]' "$U")" \
  '["4135ea2d-6df8-44a3-9df3-4b5a84be39ad","b689b0a8-53d0-40ab-baf2-68738e2966ac","redirect-to-https",false]'
eq "hfy-api origin host" "$(jq -r '.Origins.Items[] | select(.Id == "hfy-api-origin") | .DomainName' "$U")" api123example.lambda-url.us-west-2.on.aws
eq "secret header value is the stub secret" "$(SV=$SECRET_VALUE jq -r '.Origins.Items[] | select(.Id == "hfy-api-origin") | .CustomHeaders.Items[0].HeaderValue == env.SV' "$U")" true
eq "legacy origin kept in place" "$(jq -c '[.Origins.Items[].Id]' "$U")" '["s3-frontend","api-gateway-hfy-check-allowed","hfy-api-origin"]'
check "Quantity fields match" quantities_ok "$U"
eq "nothing else changed" "$(jq -c --slurpfile f "$FIXTURE" 'del(.Origins, .CacheBehaviors) == ($f[0].DistributionConfig | del(.Origins, .CacheBehaviors))' "$U")" true
contains "reports the pin" "$OUT" "legacy /api/check-allowed stays on origin api-gateway-hfy-check-allowed via /api/check-allowed*"
contains "diff is redacted" "$OUT" '"HeaderValue": "<redacted>"'
B=$(find "$STUB_DIR/backups" -name 'E2JCDK3QLQNNYB-*-before.json' | head -1)
check "pre-change backup saved" test -s "$B"
eq "backup is mode 600" "$(stat -f %Lp "$B" 2>/dev/null || stat -c %a "$B")" 600
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
contains "sample pin comes from its /api/* behavior" "$OUT" "stays on origin api-gateway-hfy-check-allowed"
check "offline dry run makes no AWS call" test ! -s "$STUB_DIR/calls.log"

# ---------------------------------------------------------------------------------------------------------------------
CURRENT="api: refuses when the legacy origin cannot be determined"
CLOBBERED="$T/clobbered.json"
jq '.DistributionConfig.Origins.Items += [{Id:"hfy-api-origin",DomainName:"x.lambda-url.us-west-2.on.aws",CustomOriginConfig:{HTTPPort:80,HTTPSPort:443,OriginProtocolPolicy:"https-only"}}]
    | .DistributionConfig.Origins.Quantity = 3
    | (.DistributionConfig.CacheBehaviors.Items[] | select(.PathPattern == "/api/*") | .TargetOriginId) = "hfy-api-origin"' "$FIXTURE" > "$CLOBBERED"
new_stub "$CLOBBERED"
run add-api-behavior.sh
eq "exit 3 when /api/* already points at hfy-api and no pin exists" "$RC" 3
eq "no update" "$(updates)" 0
contains "explains" "$OUT" "refusing: /api/check-allowed is already routed to hfy-api-origin"
run add-api-behavior.sh --legacy-origin nope
eq "exit 3 for an unknown --legacy-origin" "$RC" 3
run add-api-behavior.sh --legacy-origin api-gateway-hfy-check-allowed
eq "--legacy-origin repairs it" "$RC" 0
eq "one update" "$(updates)" 1
eq "pin restored before /api/*" "$(patterns "$(last_update)")" '["/person/*","/api/check-allowed*","/api/*"]'
eq "legacy route restored" "$(route "$(last_update)" /api/check-allowed)" api-gateway-hfy-check-allowed
eq "pin uses the uncached API template" "$(jq -r '.CacheBehaviors.Items[] | select(.PathPattern == "/api/check-allowed*") | .CachePolicyId' "$(last_update)")" 4135ea2d-6df8-44a3-9df3-4b5a84be39ad
echo_last
run add-api-behavior.sh
eq "afterwards a plain rerun is a no-op" "$(updates)" 1
DEFAULT_ONLY="$T/default-only.json"
jq '.DistributionConfig.CacheBehaviors = {Quantity:0}' "$FIXTURE" > "$DEFAULT_ONLY"
new_stub "$DEFAULT_ONLY"
run add-api-behavior.sh
eq "exit 3 when only the default behavior serves /api/check-allowed" "$RC" 3
contains "explains" "$OUT" "only the default behavior"
eq "no update" "$(updates)" 0

# ---------------------------------------------------------------------------------------------------------------------
CURRENT="api: a pin found after /api/* is moved before it, and an existing pin is never retargeted"
MISORDERED="$T/misordered.json"
new_stub; run add-api-behavior.sh; echo_last
jq '.DistributionConfig.CacheBehaviors.Items |= ([.[] | select(.PathPattern != "/api/check-allowed*")] + [.[] | select(.PathPattern == "/api/check-allowed*") | .ResponseHeadersPolicyId = "keep-me"])' "$STUB_DIR/get.json" > "$MISORDERED"
new_stub "$MISORDERED"
run add-api-behavior.sh
eq "exit code" "$RC" 0
eq "one update" "$(updates)" 1
eq "pin moved in front" "$(patterns "$(last_update)")" '["/person/*","/api/check-allowed*","/api/*"]'
eq "pin otherwise untouched" "$(jq -r '.CacheBehaviors.Items[] | select(.PathPattern == "/api/check-allowed*") | [.TargetOriginId, .ResponseHeadersPolicyId] | @tsv' "$(last_update)")" "$(printf 'api-gateway-hfy-check-allowed\tkeep-me')"
echo_last; run add-api-behavior.sh
eq "then a no-op" "$(updates)" 1
BADPIN="$T/badpin.json"
jq '(.DistributionConfig.CacheBehaviors.Items[] | select(.PathPattern == "/api/check-allowed*") | .TargetOriginId) = "hfy-api-origin"' "$STUB_DIR/get.json" > "$BADPIN"
new_stub "$BADPIN"
run add-api-behavior.sh
eq "a pin pointing at hfy-api is refused, not silently kept" "$RC" 3
eq "no update" "$(updates)" 0

# ---------------------------------------------------------------------------------------------------------------------
CURRENT="auth + api + uploads: all three applied, then every rerun is a no-op"
new_stub
run add-auth-behavior.sh; eq "auth exit" "$RC" 0; eq "auth update" "$(updates)" 1; echo_last
run add-api-behavior.sh; eq "api exit" "$RC" 0; eq "api update" "$(updates)" 2; echo_last
run add-uploads-behavior.sh; eq "uploads exit" "$RC" 0; eq "uploads update" "$(updates)" 3; echo_last
eq "final behavior order" "$(patterns "$STUB_DIR/get.json")" \
  '["/person/*","/api/check-allowed*","/api/*","/auth/*","/.well-known/oauth-authorization-server*","/uploads/*"]'
eq "final origins" "$(jq -c '[.DistributionConfig.Origins.Items[].Id]' "$STUB_DIR/get.json")" '["s3-frontend","api-gateway-hfy-check-allowed","hfy-auth-origin","hfy-api-origin"]'
for s in add-auth-behavior.sh add-api-behavior.sh add-uploads-behavior.sh add-auth-behavior.sh; do
  run "$s"; eq "$s rerun exit" "$RC" 0; contains "$s rerun says no change" "$OUT" "no change"
done
eq "no update-distribution on any rerun" "$(updates)" 3
U="$STUB_DIR/get.json"
eq "/auth routes to the auth edge" "$(route "$U" /auth/login)" hfy-auth-origin
eq "RFC 8414 discovery routes to the auth edge" "$(route "$U" /.well-known/oauth-authorization-server/auth)" hfy-auth-origin
eq "legacy check-allowed still on API Gateway" "$(route "$U" /api/check-allowed)" api-gateway-hfy-check-allowed
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
CURRENT="app-stack.yaml"
if python3 -c 'import yaml' 2>/dev/null; then
  if PYTHONDONTWRITEBYTECODE=1 python3 -m unittest -q "$HERE/test_app_stack.py" 2> "$T/py.out"; then ok; else fail "test_app_stack.py"; cat "$T/py.out" >&2; fi
else fail "python3 with PyYAML is required for test_app_stack.py"; fi
if command -v cfn-lint >/dev/null; then
  if cfn-lint "$ROOT/infrastructure/cloudformation/app-stack.yaml" > "$T/lint.out" 2>&1; then ok; else fail "cfn-lint app-stack.yaml"; cat "$T/lint.out" >&2; fi
else echo "  (cfn-lint not installed: skipped)"; fi

CURRENT="shellcheck"
if command -v shellcheck >/dev/null; then
  if shellcheck -x "$INFRA"/*.sh "$INFRA"/lib/*.sh "$HERE"/run.sh "$STUB_BIN"/aws > "$T/sc.out" 2>&1; then ok; else fail "shellcheck"; cat "$T/sc.out" >&2; fi
else echo "  (shellcheck not installed: skipped)"; fi

echo "scripts/infra tests: $PASS passed, $FAILED failed"
[ "$FAILED" = 0 ]
