#!/usr/bin/env bash
# Live check of the site bucket's CORS rule (HFY-TSK-314). Browsers PUT member photos straight to the bucket's S3 endpoint
# with presigned URLs from hfy-api, so the bucket must answer the browser's CORS preflight. Without the rule every photo upload
# fails (the bucket once had no CORS configuration at all); a wider rule lets other origins, methods or headers in.
# Read-only and unauthenticated: it sends CORS preflights (OPTIONS) and nothing else, so it needs no AWS credentials. S3 answers
# a preflight from the bucket's CORS configuration alone, so the object in --url need not exist.
#
#   1. Each origin in the rule file's AllowedOrigins: a preflight for PUT with Content-Type gets 200, an
#      Access-Control-Allow-Origin equal to that origin, and PUT in Access-Control-Allow-Methods.
#   2. A foreign origin (https://cors-check.invalid) asking for the same gets 403.
#   3. The first site origin asking for DELETE, and for PUT with an x-amz-acl header, gets 403 each.
#
# Usage: check-site-bucket-cors.sh [--url URL] [--rule FILE]
#   --url   the object URL to preflight, https only
#           (default https://harrisonfamily-frontend.s3.us-west-2.amazonaws.com/uploads/posts/smoke/x.jpg)
#   --rule  the CORS configuration whose origins must be allowed
#           (default infrastructure/cloudformation/site-bucket-cors.json in this checkout)
# Exit 0 when every probe passes; 1 when any fails, each failure printed as a GitHub Actions ::error:: line; 2 on bad usage or a
# missing tool. Runs after every successful io-kit deploy run (.github/workflows/post-deploy-checks.yml).
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
URL="https://harrisonfamily-frontend.s3.us-west-2.amazonaws.com/uploads/posts/smoke/x.jpg"
RULE="$ROOT/infrastructure/cloudformation/site-bucket-cors.json"
FOREIGN="https://cors-check.invalid"

die() { echo "check-site-bucket-cors.sh: $*" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --url) [ $# -ge 2 ] || die "--url needs a value"; URL=$2; shift 2 ;;
    --rule) [ $# -ge 2 ] || die "--rule needs a value"; RULE=$2; shift 2 ;;
    -h|--help) sed -n '2,/^set -uo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
case "$URL" in https://?*) ;; *) die "--url must be an https:// URL" ;; esac
for tool in curl jq; do command -v "$tool" >/dev/null || die "$tool is required"; done
[ -r "$RULE" ] || die "cannot read the rule file $RULE"
ORIGINS=$(jq -r '[.CORSRules[]?.AllowedOrigins[]?] | unique | .[]' "$RULE") || die "$RULE is not a CORS configuration"
[ -n "$ORIGINS" ] || die "$RULE allows no origin"
case "$ORIGINS" in *"*"*) die "$RULE has a wildcard origin: refusing to check it" ;; esac
FIRST=$(printf '%s\n' "$ORIGINS" | head -n 1)

CODE=""; ACAO=""; ACAM=""
preflight() { # ORIGIN METHOD [REQUEST_HEADERS] -> CODE, ACAO, ACAM (CODE 000: no HTTP response)
  local args=(-sS -o /dev/null -D - --max-time 20 --retry 3 --retry-delay 5 -X OPTIONS
    -H "Origin: $1" -H "Access-Control-Request-Method: $2")
  if [ -n "${3:-}" ]; then args+=(-H "Access-Control-Request-Headers: $3"); fi
  local head
  # Keep the last response only: a retried request prints each attempt's headers.
  head=$(curl "${args[@]}" "$URL" | tr -d '\r' | awk '/^HTTP\//{h=""} {h=h $0 "\n"} END{printf "%s", h}')
  CODE=$(printf '%s\n' "$head" | awk 'NR==1 && /^HTTP\// {print $2}')
  CODE=${CODE:-000}
  ACAO=$(header_value "$head" access-control-allow-origin)
  ACAM=$(header_value "$head" access-control-allow-methods)
}
header_value() { # HEADERS NAME -> the first value of header NAME (case-insensitive), trimmed
  printf '%s\n' "$1" | awk -v n="$2" '{ i = index($0, ":"); if (i > 1 && tolower(substr($0, 1, i - 1)) == n) {
    v = substr($0, i + 1); gsub(/^[ \t]+|[ \t]+$/, "", v); print v; exit } }'
}
allows_put() { printf '%s\n' "$ACAM" | tr ',' '\n' | tr -d ' ' | grep -qx PUT; }

PROBES=0; FAILED=0
pass() { PROBES=$((PROBES + 1)); echo "ok   $*"; }
bad() { PROBES=$((PROBES + 1)); FAILED=$((FAILED + 1)); echo "::error::site bucket CORS: $*"; }
expect_refused() { # DESCRIPTION (after a preflight)
  if [ "$CODE" = 403 ]; then pass "403 $1"
  elif [ "$CODE" = 000 ]; then bad "$1: no response from $URL"
  else bad "$1: expected 403, got $CODE (Access-Control-Allow-Origin: ${ACAO:-none}). The bucket allows more than the committed rule"
  fi
}

echo "preflights to $URL (rule: ${RULE#"$ROOT"/})"
while IFS= read -r origin; do
  preflight "$origin" PUT content-type
  if [ "$CODE" = 200 ] && [ "$ACAO" = "$origin" ] && allows_put; then
    pass "200 PUT with Content-Type from $origin"
  elif [ "$CODE" = 000 ]; then
    bad "PUT with Content-Type from $origin: no response from $URL"
  else
    bad "PUT with Content-Type from $origin: expected 200 with Access-Control-Allow-Origin: $origin and PUT allowed, got $CODE (Access-Control-Allow-Origin: ${ACAO:-none}; Access-Control-Allow-Methods: ${ACAM:-none}). Photo uploads from this origin fail: apply $(basename "$RULE") with aws s3api put-bucket-cors"
  fi
done <<< "$ORIGINS"
preflight "$FOREIGN" PUT content-type
expect_refused "PUT with Content-Type from the foreign origin $FOREIGN"
preflight "$FIRST" DELETE
expect_refused "DELETE from $FIRST"
preflight "$FIRST" PUT content-type,x-amz-acl
expect_refused "PUT with an x-amz-acl header from $FIRST"

echo "site bucket CORS: $PROBES probes, $FAILED failed"
[ "$FAILED" = 0 ]
