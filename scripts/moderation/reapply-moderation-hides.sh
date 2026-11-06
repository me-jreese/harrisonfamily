#!/usr/bin/env bash
# Re-apply record moderation after a legacy republish (HFY-TSK-216, hfy-moderation-record-targets; rollback step 3 in
# docs/how-to/sync-gramps-with-the-website.md; BRD2 D2-19, R2-25).
#
# The legacy ETL export does not know the MOD# overlay, so after the break-glass republish every note and media that a moderator hid is public again. This
# script reads the open, hidden record items (MOD#note:<handle>, MOD#media:<handle>, MOD#mediaref:<person handle>:<media handle>) from the app table's
# moderation queue (GSI1 MODQ#open) and removes the files it can name: note/<handle>.json and media/<handle>.json. A hidden MediaRef lives inside a page
# (person/<id>.json); only the renderer rewrites a page, so the script counts those and says so. The first live render pass after the rollback applies the
# whole overlay to every key (docs/reference/sync-render.md, "Moderation overlay"): this script is the exposure reducer until that pass has run.
#
#   scripts/moderation/reapply-moderation-hides.sh --table <app table> --site-bucket <bucket> [--region <region>] [--dry-run | --verify | --confirm-reapply]
#
#   --dry-run          prints the targets and the keys it would delete; changes nothing (the default when no mode is given)
#   --confirm-reapply  deletes the keys: io's go-ahead for this run is on record (AGENTS.md: real runs of a delete need it)
#   --verify           head-object on each key: exit 0 when every one is gone, 1 when any is still served
# Never prints a note's text or any value of an item: handles and counts only. Exit 2 is a usage error, 1 a failed check, 3 a MediaRef-only hide remains.
set -euo pipefail

TABLE="" BUCKET="" REGION="${AWS_REGION:-us-west-2}" MODE="dry-run"
usage() { sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --table) TABLE=${2:?}; shift 2 ;;
    --site-bucket) BUCKET=${2:?}; shift 2 ;;
    --region) REGION=${2:?}; shift 2 ;;
    --dry-run) MODE="dry-run"; shift ;;
    --verify) MODE="verify"; shift ;;
    --confirm-reapply) MODE="apply"; shift ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done
[ -n "$TABLE" ] && [ -n "$BUCKET" ] || { echo "--table and --site-bucket are required" >&2; usage; }

items=$(aws dynamodb query --region "$REGION" --table-name "$TABLE" --index-name GSI1 \
  --key-condition-expression 'GSI1PK = :pk' --expression-attribute-values '{":pk":{"S":"MODQ#open"}}' --output json)
# PK of every item that still hides (hidden true, open not false) and names a record target.
targets=$(printf '%s' "$items" | jq -r '.Items[]
  | select((.hidden.BOOL // false) == true and ((.open // {}) | if has("BOOL") then .BOOL else true end) != false)
  | .PK.S | select(test("^MOD#(note|media|mediaref):[A-Za-z0-9_:-]+$")) | sub("^MOD#"; "")' | sort -u)

keys=$(printf '%s\n' "$targets" | awk -F: '$1 == "note" { printf "note/%s.json\n", $2 } $1 == "media" { printf "media/%s.json\n", $2 }' | sort -u | sed '/^$/d')
refs=$(printf '%s\n' "$targets" | grep -c '^mediaref:' || true)
nkeys=$(printf '%s\n' "$keys" | sed '/^$/d' | wc -l | tr -d ' ')
echo "hidden record items: notes+media files=$nkeys, mediaref-only=$refs (mode: $MODE)"

case "$MODE" in
  dry-run)
    printf '%s\n' "$keys" | sed '/^$/d; s/^/would delete: /'
    ;;
  apply)
    while IFS= read -r key; do
      [ -n "$key" ] || continue
      aws s3api delete-object --region "$REGION" --bucket "$BUCKET" --key "$key" >/dev/null
      echo "deleted: $key"
    done <<< "$keys"
    ;;
  verify)
    bad=0
    while IFS= read -r key; do
      [ -n "$key" ] || continue
      if aws s3api head-object --region "$REGION" --bucket "$BUCKET" --key "$key" >/dev/null 2>&1; then echo "STILL SERVED: $key"; bad=1; fi
    done <<< "$keys"
    [ "$bad" = 0 ] || exit 1
    echo "every hidden note and media file is gone"
    ;;
esac
if [ "$refs" -gt 0 ]; then
  echo "$refs hidden MediaRef(s) live inside page files: only the renderer's next live pass removes them (docs/reference/sync-render.md, Moderation overlay)" >&2
  exit 3
fi
