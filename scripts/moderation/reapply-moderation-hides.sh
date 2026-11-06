#!/usr/bin/env bash
# Re-apply record moderation after a legacy republish (HFY-TSK-216, HFY-TSK-378; rollback step 3 in
# docs/how-to/sync-gramps-with-the-website.md; BRD2 D2-19, R2-25).
#
# The legacy ETL export does not know the MOD# overlay, so after the break-glass republish every note and media that a moderator hid is public again. This
# script reads the open, hidden record items (MOD#note:<handle>, MOD#media:<handle>, MOD#mediaref:<person handle>:<media handle>) from the app table's
# moderation queue (GSI1 MODQ#open) and removes the files it can name: note/<handle>.json and media/<handle>.json. A hidden MediaRef lives inside a page
# (person/<id>.json); only the renderer rewrites a page, so the script counts those and says so. The first live render pass after the rollback applies the
# whole overlay to every key (docs/reference/sync-render.md, "Moderation overlay"): this script is the exposure reducer until that pass has run.
# Hidden posts, comments and member photos need no step: they live in the store and under uploads/, which the legacy publish cannot write, and the API
# applies their hides on every read.
#
#   scripts/moderation/reapply-moderation-hides.sh --table <app table> --site-bucket <bucket> [--region <region>] [--render-function <name>]
#       [--breakglass-profile <aws profile>] [--dry-run | --verify | --confirm-reapply --break-glass]
#
#   --dry-run          prints counts and the render mode; changes nothing (the default when no mode is given)
#   --confirm-reapply  deletes the keys. It refuses unless the renderer's RENDER_MODE is off (read from the function configuration) and --break-glass is
#                      given, which states that the break-glass republish happened under io's approval. io's go-ahead for the run is on record.
#   --breakglass-profile  the AWS profile (hfy-data-breakglass session) used ONLY for s3api delete-object. The write guard denies deletes under note/ and
#                      media/ to everyone but the renderers and the break-glass role, and that role does not reach the table: the queue and the render
#                      mode are read with your usual credentials, the deletes run under this profile (env credentials are used when it is omitted).
#   --verify           head-object on each key: exit 0 when every one is gone, 1 when any is still served or cannot be checked (anything but 404)
# Output is counts only: it never prints a handle, id, name, key or any value of an item, and AWS error text is discarded. The last line is "result: ...".
# Exit 2 is a usage error or a refusal, 1 a failed delete or check, 3 hidden items remain in page files (every delete succeeded; any hidden item: the
# next live render pass is the real fix). The bucket is versioned: a delete leaves a delete marker, noncurrent versions stay until expunge.mjs clears them.
set -euo pipefail

TABLE="" BUCKET="" REGION="${AWS_REGION:-us-west-2}" MODE="dry-run" FUNC="hfy-sync-render" BREAKGLASS=0 BGPROFILE=""
usage() { sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --table) TABLE=${2:?}; shift 2 ;;
    --site-bucket) BUCKET=${2:?}; shift 2 ;;
    --region) REGION=${2:?}; shift 2 ;;
    --render-function) FUNC=${2:?}; shift 2 ;;
    --break-glass) BREAKGLASS=1; shift ;;
    --breakglass-profile) BGPROFILE=${2:?}; shift 2 ;;
    --dry-run) MODE="dry-run"; shift ;;
    --verify) MODE="verify"; shift ;;
    --confirm-reapply) MODE="apply"; shift ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done
[ -n "$TABLE" ] && [ -n "$BUCKET" ] || { echo "--table and --site-bucket are required" >&2; usage; }

read_rmode() {
  local m
  m=$(aws lambda get-function-configuration --region "$REGION" --function-name "$FUNC" --query 'Environment.Variables.RENDER_MODE' --output text 2>/dev/null) || m=unreadable
  case "$m" in None|"") m=off ;; esac # the handler's default when the variable is unset
  printf '%s' "$m"
}
rmode=$(read_rmode)
if [ "$MODE" = "apply" ]; then # refuse before the queue is paged
  [ "$rmode" = "off" ] || { echo "refused: RENDER_MODE is '$rmode', not off; set RenderMode=off first (Roll back, Stop the renderer)" >&2; exit 2; }
  [ "$BREAKGLASS" = 1 ] || { echo "refused: state the break-glass republish with --break-glass (io's approval, Roll back step 2)" >&2; exit 2; }
fi

items='{"Items":[]}'
start=""
while :; do # GSI1 pages: follow LastEvaluatedKey until it is gone
  if [ -n "$start" ]; then
    page=$(aws dynamodb query --region "$REGION" --table-name "$TABLE" --index-name GSI1 \
      --key-condition-expression 'GSI1PK = :pk' --expression-attribute-values '{":pk":{"S":"MODQ#open"}}' --exclusive-start-key "$start" --output json)
  else
    page=$(aws dynamodb query --region "$REGION" --table-name "$TABLE" --index-name GSI1 \
      --key-condition-expression 'GSI1PK = :pk' --expression-attribute-values '{":pk":{"S":"MODQ#open"}}' --output json)
  fi
  items=$(jq -n --argjson a "$items" --argjson b "$page" '{Items: ($a.Items + ($b.Items // []))}')
  start=$(printf '%s' "$page" | jq -c '.LastEvaluatedKey // empty')
  [ -n "$start" ] || break
done
# PK of every item that still hides (hidden true, open not false) and names a record target.
targets=$(printf '%s' "$items" | jq -r '.Items[]
  | select((.hidden.BOOL // false) == true and ((.open // {}) | if has("BOOL") then .BOOL else true end) != false)
  | .PK.S | select(test("^MOD#(note|media|mediaref):[A-Za-z0-9_:-]+$")) | sub("^MOD#"; "")' | sort -u)

keys=$(printf '%s\n' "$targets" | awk -F: '$1 == "note" { printf "note/%s.json\n", $2 } $1 == "media" { printf "media/%s.json\n", $2 }' | sort -u | sed '/^$/d')
refs=$(printf '%s\n' "$targets" | grep -c '^mediaref:' || true)
nkeys=$(printf '%s\n' "$keys" | sed '/^$/d' | wc -l | tr -d ' ')
echo "render mode: $rmode"
echo "hidden record items: notes+media files=$nkeys, mediaref-only=$refs (mode: $MODE)"

case "$MODE" in
  dry-run)
    echo "would delete: $nkeys file(s)"
    ;;
  apply)
    done_n=0 failed=0
    rmode=$(read_rmode) # read again right before the deletes: a renderer started since the first read must stop the run
    [ "$rmode" = "off" ] || { echo "refused: RENDER_MODE changed to '$rmode' before the deletes; nothing deleted" >&2; exit 2; }
    delargs=(); [ -z "$BGPROFILE" ] || delargs=(--profile "$BGPROFILE")
    while IFS= read -r key; do
      [ -n "$key" ] || continue
      if aws s3api delete-object ${delargs[@]+"${delargs[@]}"} --region "$REGION" --bucket "$BUCKET" --key "$key" >/dev/null 2>&1; then done_n=$((done_n + 1)); else failed=$((failed + 1)); fi
    done <<< "$keys"
    echo "deleted: $done_n file(s)"
    echo "failed: $failed"
    if [ "$failed" -gt 0 ]; then echo "result: INCOMPLETE, $failed delete(s) failed (check the break-glass session and the write guard)"; exit 1; fi
    ;;
  verify)
    bad=0 served=0 unknown=0
    while IFS= read -r key; do
      [ -n "$key" ] || continue
      if err=$(aws s3api head-object --region "$REGION" --bucket "$BUCKET" --key "$key" 2>&1 >/dev/null); then
        served=$((served + 1)); bad=1
      else
        case "$err" in *404*|*"Not Found"*|*NoSuchKey*) ;; *) unknown=$((unknown + 1)); bad=1 ;; esac # only a 404 proves the file is gone
      fi
    done <<< "$keys"
    [ "$bad" = 0 ] || { echo "STILL SERVED: $served file(s); UNVERIFIABLE: $unknown file(s)"; echo "result: FAILED"; exit 1; }
    echo "every named note and media file is gone (page files still need the renderer pass)"
    ;;
esac
# Every hidden item keeps text or names in page files until the renderer's next live pass: a note's text is embedded in person/<id>.json, a media is named in
# person, event and family files, media/index.json and person/search-index.json, and a MediaRef lives in the page. Deleting the single files above is only a
# partial reduction, so the script never reports a clean exit while any hidden item exists. The binary media/<handle>.<ext> is not deleted by this script either.
if [ "$refs" -gt 0 ] || [ "$nkeys" -gt 0 ]; then
  echo "WARNING: hidden notes and media ($nkeys file(s)) and MediaRef(s) ($refs) still appear in page files (person, event, family, media/index.json, person/search-index.json); only the renderer's next live pass removes them (docs/reference/sync-render.md, Moderation overlay)" >&2
  echo "result: named files handled, hidden items remain in page files (exit 3)"
  exit 3
fi
echo "result: clean"
