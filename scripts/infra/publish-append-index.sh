#!/usr/bin/env bash
# Idempotently publishes scripts/cloudfront/append-index.js as the CloudFront Function HFYAppendIndex (the viewer-request function
# of the DEFAULT cache behavior: clean URLs + default-deny of case/suffix variants of the private data prefixes; see the header of
# that file). Same shape as the add-*-behavior.sh scripts: read the live state, show a diff, change nothing on --dry-run, save the
# previous code outside the repo before any write, and never publish anything that has not passed its tests.
#
#   1. read   describe/get-function for the DEVELOPMENT and LIVE stages (read-only); diff each against the repo file.
#   2. no-op  LIVE already runs exactly the repo code: print "no change" and stop (a stray different DEVELOPMENT draft is left alone).
#   3. save   the current LIVE (and a differing DEVELOPMENT) code to ${HFY_CF_BACKUP_DIR:-~/.local/state/hfy-infra/cloudfront}.
#   4. update update-function with the repo code (skipped when DEVELOPMENT already holds it), and read it back.
#   5. test   aws cloudfront test-function on the DEVELOPMENT stage with the sample events of
#             scripts/cloudfront/test/append-index.cases.json (the clean-URL rewrites, the public person shell, and every kind of
#             private-prefix variant: case, suffix, encoding, backslash, dot segments). Any mismatch or function error stops here:
#             LIVE is untouched.
#   6. publish publish-function, then read LIVE back and compare. Prints the rollback commands.
# Before any of that: the local unit tests run (node --test scripts/cloudfront/test/append-index.test.mjs, when node is installed
# and --source is the repo file) and the function must not be associated with any cache behavior of the distribution except the
# default one. A function that denies private prefixes would break /media/*, /family/* etc. if it sat in front of them.
# Refused (exit 1/2/3): a missing or empty source, over 10 KB, no handler(), a runtime other than cloudfront-js-1.0, a function
# that does not exist (create it once with create-function; this script never creates one), a failing unit test or test-function
# case, an association with a non-default behavior, an unreadable distribution.
#
# Usage: publish-append-index.sh [--dry-run] [--name HFYAppendIndex] [--source FILE] [--distribution E2JCDK3QLQNNYB|none]
#                                [--cases FILE] [--all-cases] [--comment TEXT]
# --dry-run only reads: it prints both diffs and the plan. --all-cases runs every case of the table through test-function
# (about 0.8 s per case) instead of the awsSamples subset. --distribution none skips the association check (for a scratch function).
# shellcheck source-path=SCRIPTDIR
set -euo pipefail
umask 077
HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib/cf-common.sh
. "$HERE/lib/cf-common.sh"
ROOT=$(cd "$HERE/../.." && pwd)
NAME=HFYAppendIndex; SOURCE="$ROOT/scripts/cloudfront/append-index.js"; DIST=E2JCDK3QLQNNYB; DRY=0; ALL=false
CASES="$ROOT/scripts/cloudfront/test/append-index.cases.json"
COMMENT="Append index.html to directory paths; 404 for private data prefix variants (HFY data gate)"
RUNTIME=cloudfront-js-1.0; MAX_BYTES=10240
while [ $# -gt 0 ]; do case "$1" in
  --dry-run) DRY=1;; --name) NAME=$2; shift;; --source) SOURCE=$2; shift;; --distribution) DIST=$2; shift;;
  --cases) CASES=$2; shift;; --all-cases) ALL=true;; --comment) COMMENT=$2; shift;;
  *) echo "unknown arg $1" >&2; exit 2;; esac; shift; done

# --- inputs that must be valid before anything is read from or written to AWS ---------------------------------------------
[ -s "$SOURCE" ] || { echo "refusing: $SOURCE is missing or empty" >&2; exit 2; }
[ -s "$CASES" ] || { echo "refusing: test cases $CASES are missing or empty" >&2; exit 2; }
[ "$(wc -c < "$SOURCE" | tr -d ' ')" -le "$MAX_BYTES" ] || { echo "refusing: $SOURCE is over the 10 KB CloudFront Functions limit" >&2; exit 2; }
grep -q 'function handler(' "$SOURCE" || { echo "refusing: $SOURCE does not define function handler(event)" >&2; exit 2; }
[ "${#COMMENT}" -le 128 ] || { echo "refusing: --comment is over the 128 character limit" >&2; exit 2; }
jq -e '(.rewrite | length) > 0 and (.deny | length) > 0 and (.awsSamples | length) > 0' "$CASES" >/dev/null || { echo "refusing: $CASES lacks rewrite, deny or awsSamples cases" >&2; exit 2; }
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT

if [ "$SOURCE" = "$ROOT/scripts/cloudfront/append-index.js" ] && command -v node >/dev/null; then
  if node --test "$ROOT/scripts/cloudfront/test/append-index.test.mjs" > "$W/unit.out" 2>&1; then echo "local unit tests pass (scripts/cloudfront/test/append-index.test.mjs)"
  else cat "$W/unit.out" >&2; echo "refusing: the local unit tests of $SOURCE fail" >&2; exit 1; fi
else echo "(local unit tests not run: needs node and the repo's own append-index.js; test-function still gates the publish)"; fi

# --- read the live state (read-only) --------------------------------------------------------------------------------------
if ! aws cloudfront describe-function --name "$NAME" --stage DEVELOPMENT --output json > "$W/dev.desc" 2> "$W/dev.err"; then
  cat "$W/dev.err" >&2; echo "refusing: cannot describe function $NAME (it must exist; create it once with aws cloudfront create-function)" >&2; exit 1
fi
DEV_ETAG=$(jq -r .ETag "$W/dev.desc"); FN_ARN=$(jq -r '.FunctionSummary.FunctionMetadata.FunctionARN' "$W/dev.desc")
FN_RUNTIME=$(jq -r '.FunctionSummary.FunctionConfig.Runtime' "$W/dev.desc")
[ "$FN_RUNTIME" = "$RUNTIME" ] || { echo "refusing: $NAME runs $FN_RUNTIME, this script publishes $RUNTIME (ES5.1) code only" >&2; exit 1; }
aws cloudfront get-function --name "$NAME" --stage DEVELOPMENT "$W/dev.js" > /dev/null
HAVE_LIVE=0; LIVE_COMMENT=""
if aws cloudfront describe-function --name "$NAME" --stage LIVE --output json > "$W/live.desc" 2> /dev/null; then
  HAVE_LIVE=1; LIVE_COMMENT=$(jq -r '.FunctionSummary.FunctionConfig.Comment // ""' "$W/live.desc")
  aws cloudfront get-function --name "$NAME" --stage LIVE "$W/live.js" > /dev/null
else : > "$W/live.js"; fi

if [ "$DIST" != none ]; then
  aws cloudfront get-distribution-config --id "$DIST" --output json > "$W/dist.json" || { echo "refusing: cannot read distribution $DIST (use --distribution none to skip the association check)" >&2; exit 1; }
  OTHER=$(jq -r --arg arn "$FN_ARN" '[(.DistributionConfig // .) | (.CacheBehaviors.Items // [])[] | select(any((.FunctionAssociations.Items // [])[]; .FunctionARN == $arn)) | .PathPattern] | join(" ")' "$W/dist.json")
  if [ -n "$OTHER" ]; then
    echo "refusing (exit 3): $NAME is associated with cache behavior(s) $OTHER of $DIST. It denies private data prefixes, so it may only sit on the DEFAULT behavior." >&2; exit 3
  fi
  if jq -e --arg arn "$FN_ARN" '(.DistributionConfig // .) | any((.DefaultCacheBehavior.FunctionAssociations.Items // [])[]; .FunctionARN == $arn and .EventType == "viewer-request")' "$W/dist.json" >/dev/null; then
    echo "$NAME is the viewer-request function of the default cache behavior of $DIST"
  else echo "note: $NAME is not associated with the default cache behavior of $DIST (publishing only updates the function)"; fi
fi

same() { cmp -s "$1" "$2"; }
echo "--- LIVE vs repo ($SOURCE) ---"
if [ "$HAVE_LIVE" = 0 ]; then echo "(no LIVE stage yet)"; elif same "$W/live.js" "$SOURCE"; then echo "LIVE runs exactly the repo code"; else diff -u --label "LIVE $NAME" --label "repo append-index.js" "$W/live.js" "$SOURCE" || true; fi
echo "--- DEVELOPMENT vs repo ---"
if same "$W/dev.js" "$SOURCE"; then echo "DEVELOPMENT holds exactly the repo code"; else diff -u --label "DEVELOPMENT $NAME" --label "repo append-index.js" "$W/dev.js" "$SOURCE" || true; fi

if [ "$HAVE_LIVE" = 1 ] && same "$W/live.js" "$SOURCE"; then
  if ! same "$W/dev.js" "$SOURCE"; then echo "note: DEVELOPMENT differs from LIVE and the repo (a stray draft, not served); left alone"; fi
  echo "function $NAME already runs the repo code on LIVE: no change"; exit 0
fi

BACKUP_DIR_HINT="${HFY_CF_BACKUP_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/hfy-infra/cloudfront}" # not created on a dry run
CASE_COUNT=$(jq -r --argjson all "$ALL" 'if $all then (.rewrite | length) + (.deny | length) else (.awsSamples | length) end' "$CASES")
if [ "$DRY" = 1 ]; then
  if same "$W/dev.js" "$SOURCE"; then STEP="DEVELOPMENT already holds the repo code: skipped"; else STEP="DEVELOPMENT := repo"; fi
  echo "(dry-run) would save the previous code to $BACKUP_DIR_HINT, update-function $NAME ($STEP), test-function $CASE_COUNT cases on DEVELOPMENT, then publish-function"
  echo "(dry-run) no changes made"; exit 0
fi

# --- save, update, test, publish ------------------------------------------------------------------------------------------
BACKUP_DIR=$(cf_backup_dir); TS=$(date -u +%Y%m%dT%H%M%SZ)
LIVE_BACKUP=""
if [ "$HAVE_LIVE" = 1 ]; then
  LIVE_BACKUP="$BACKUP_DIR/$NAME-LIVE-$TS-before.js"; cp "$W/live.js" "$LIVE_BACKUP"; chmod 600 "$LIVE_BACKUP"
  echo "saved the previous LIVE code to $LIVE_BACKUP (mode 600)"
fi
if ! same "$W/dev.js" "$SOURCE"; then
  if [ "$HAVE_LIVE" = 0 ] || ! same "$W/dev.js" "$W/live.js"; then # a DEVELOPMENT copy identical to LIVE is already saved above
    DEV_BACKUP="$BACKUP_DIR/$NAME-DEVELOPMENT-$TS-before.js"; cp "$W/dev.js" "$DEV_BACKUP"; chmod 600 "$DEV_BACKUP"
    echo "saved the previous DEVELOPMENT code to $DEV_BACKUP (mode 600)"
  fi
  CONFIG=$(jq -nc --arg c "$COMMENT" --arg r "$RUNTIME" '{Comment:$c,Runtime:$r}')
  DEV_ETAG=$(aws cloudfront update-function --name "$NAME" --if-match "$DEV_ETAG" --function-config "$CONFIG" --function-code "fileb://$SOURCE" --output json | jq -r .ETag)
  # shellcheck disable=SC2015 # C is the failure path for either A or B being false
  [ -n "$DEV_ETAG" ] && [ "$DEV_ETAG" != null ] || { echo "update-function returned no ETag" >&2; exit 1; }
  aws cloudfront get-function --name "$NAME" --stage DEVELOPMENT "$W/dev.after.js" > /dev/null
  same "$W/dev.after.js" "$SOURCE" || { echo "DEVELOPMENT does not hold the repo code after update-function; LIVE untouched" >&2; exit 1; }
  echo "updated $NAME DEVELOPMENT to the repo code"
fi

echo "test-function on DEVELOPMENT: $CASE_COUNT cases ($([ "$ALL" = true ] && echo "every case" || echo "awsSamples; --all-cases runs them all"))"
jq -c --argjson all "$ALL" '
  ([.rewrite[] | {key: .uri, value: ("rewrite " + .expect)}] | from_entries) as $rw
  | (.deny | map({key: ., value: "404 cache-control=private, no-store"}) | from_entries) as $dn
  | ($rw + $dn) as $want
  | (if $all then (.rewrite | map(.uri)) + .deny else .awsSamples end)[] | . as $u | {uri: $u, want: $want[$u]}' "$CASES" > "$W/cases.jsonl"
BAD=0; N=0
while IFS= read -r line; do
  uri=$(jq -r .uri <<<"$line"); want=$(jq -r .want <<<"$line")
  jq -n --arg u "$uri" '{version:"1.0",context:{eventType:"viewer-request"},viewer:{ip:"198.51.100.11"},
    request:{method:"GET",uri:$u,headers:{host:{value:"harrisonfamily.us"}},cookies:{},querystring:{}}}' > "$W/event.json"
  got=$(aws cloudfront test-function --name "$NAME" --if-match "$DEV_ETAG" --stage DEVELOPMENT --event-object "fileb://$W/event.json" --output json 2> "$W/test.err" \
    | jq -r '.TestResult | if (.FunctionErrorMessage // "") != "" then "error " + .FunctionErrorMessage
        else (.FunctionOutput | fromjson | if .response then "\(.response.statusCode) cache-control=\(.response.headers["cache-control"].value // "")" else "rewrite \(.request.uri)" end) end') || got="test-function call failed: $(head -c 300 "$W/test.err")"
  N=$((N + 1))
  if [ "$got" != "$want" ]; then BAD=$((BAD + 1)); echo "  FAIL $(jq -nr --arg u "$uri" '$u|@json'): got [$got], want [$want]" >&2; fi
done < "$W/cases.jsonl"
if [ "$BAD" != 0 ]; then
  echo "refusing to publish: $BAD of $N test-function cases failed. DEVELOPMENT holds the new code, LIVE is untouched${LIVE_BACKUP:+ (previous LIVE code: $LIVE_BACKUP)}." >&2; exit 1
fi
echo "all $N test-function cases pass"

aws cloudfront publish-function --name "$NAME" --if-match "$DEV_ETAG" --query 'FunctionSummary.FunctionMetadata.Stage' --output text > /dev/null
aws cloudfront get-function --name "$NAME" --stage LIVE "$W/live.after.js" > /dev/null
same "$W/live.after.js" "$SOURCE" || { echo "LIVE does not hold the repo code after publish-function" >&2; exit 1; }
echo "published: $NAME LIVE now runs the repo code (the distribution picks it up within a minute or two; no update-distribution needed)"
if [ -n "$LIVE_BACKUP" ]; then
  ROLLBACK_CONFIG=$(jq -nr --arg c "$LIVE_COMMENT" --arg r "$RUNTIME" '{Comment:$c,Runtime:$r} | tojson | @sh')
  echo "roll back with:"
  echo "  aws cloudfront update-function --name $NAME --if-match \"\$(aws cloudfront describe-function --name $NAME --stage DEVELOPMENT --query ETag --output text)\" --function-config $ROLLBACK_CONFIG --function-code fileb://$LIVE_BACKUP"
  echo "  aws cloudfront publish-function --name $NAME --if-match \"\$(aws cloudfront describe-function --name $NAME --stage DEVELOPMENT --query ETag --output text)\""
fi
