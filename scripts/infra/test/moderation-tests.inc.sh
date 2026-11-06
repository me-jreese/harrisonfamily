# shellcheck shell=bash
# shellcheck disable=SC2034 # CURRENT is read by run.sh's fail()
# Sourced by run.sh: tests for scripts/moderation/reapply-moderation-hides.sh (HFY-TSK-216). Uses run.sh's helpers (eq, contains, lacks, check) and T.
# The script runs against its own aws double, which answers the MODQ#open query from a fixture and logs every call: nothing reaches AWS.
MOD=$ROOT/scripts/moderation/reapply-moderation-hides.sh
MODSTUB=$T/modstub; mkdir -p "$MODSTUB"
cat > "$MODSTUB/aws" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$MOD_CALLS"
case "$1 $2" in
  "dynamodb query")
    if printf '%s\n' "$*" | grep -q -- '--exclusive-start-key'; then cat "$MOD_ITEMS2"; else cat "$MOD_ITEMS"; fi ;;
  "s3api delete-object") ;;
  "s3api head-object")
    key=""; while [ $# -gt 0 ]; do [ "$1" = "--key" ] && key=$2; shift; done
    grep -qxF "$key" "$MOD_SERVED" 2>/dev/null || { echo "404" >&2; exit 254; } ;;
  *) echo "unexpected aws call: $*" >&2; exit 99 ;;
esac
STUB
chmod +x "$MODSTUB/aws"
export MOD_ITEMS2="$T/mod-items2.json" MOD_CALLS="$T/mod-calls.log" MOD_ITEMS="$T/mod-items.json" MOD_SERVED="$T/mod-served.txt"
jq -n '{Items: [
  {PK: {S: "MOD#note:aaaa"}, SK: {S: "META"}, hidden: {BOOL: true}, open: {BOOL: true}},
  {PK: {S: "MOD#media:bbbb"}, SK: {S: "META"}, hidden: {BOOL: true}, open: {BOOL: true}},
  {PK: {S: "MOD#note:question"}, SK: {S: "META"}, hidden: {BOOL: false}, open: {BOOL: true}},
  {PK: {S: "MOD#post:01J00000000000000000000000"}, SK: {S: "META"}, hidden: {BOOL: true}, open: {BOOL: true}},
  {PK: {S: "MOD#note:closed"}, SK: {S: "META"}, hidden: {BOOL: true}, open: {BOOL: false}}]}' > "$MOD_ITEMS"
mod_run() { : > "$MOD_CALLS"; set +e; OUT=$(PATH="$MODSTUB:$PATH" "$MOD" "$@" 2>&1); RC=$?; set -e; }

CURRENT="moderation re-apply script"
check "the script exists and is executable (the rollback runbook's fail-closed check passes)" test -x "$MOD"
mod_run
eq "no arguments is a usage error" "$RC" 2
mod_run --table t --site-bucket b --bogus
eq "an unknown option is a usage error" "$RC" 2
mod_run --table t --site-bucket b
eq "the default mode is a dry run; hidden notes still sit in page files, so it exits 3" "$RC" 3
contains "...and it warns that page files keep the text" "$OUT" "still appear in page files"
contains "it names the notes and media files to delete" "$OUT" "would delete: note/aaaa.json"
contains "...and the media file" "$OUT" "would delete: media/bbbb.json"
lacks "a question that does not hide, a closed item and a post are left alone" "$OUT" "question"
lacks "...closed" "$OUT" "closed"
lacks "...post" "$OUT" "01J000"
lacks "a dry run deletes nothing" "$(cat "$MOD_CALLS")" "delete-object"
contains "it reads the open moderation queue" "$(cat "$MOD_CALLS")" "GSI1"
mod_run --table t --site-bucket b --confirm-reapply
eq "an apply with no MediaRef still exits 3: notes and media stay in page files until the render pass" "$RC" 3
contains "it deletes the note file" "$(cat "$MOD_CALLS")" "s3api delete-object --region us-west-2 --bucket b --key note/aaaa.json"
contains "...and the media file" "$(cat "$MOD_CALLS")" "--key media/bbbb.json"
printf 'note/aaaa.json\n' > "$MOD_SERVED"
mod_run --table t --site-bucket b --verify
eq "verify fails while a hidden file is still served" "$RC" 1
contains "...and names it" "$OUT" "STILL SERVED: note/aaaa.json"
: > "$MOD_SERVED"
mod_run --table t --site-bucket b --verify
eq "verify with the named files gone still exits 3 (page files)" "$RC" 3
contains "...and says the page files need the renderer pass" "$OUT" "page files still need the renderer pass"
jq '.Items += [{PK: {S: "MOD#mediaref:pppp:mmmm"}, SK: {S: "META"}, hidden: {BOOL: true}, open: {BOOL: true}}]' "$MOD_ITEMS" > "$MOD_ITEMS.2"; mv "$MOD_ITEMS.2" "$MOD_ITEMS"
mod_run --table t --site-bucket b --confirm-reapply
eq "a hidden MediaRef lives in a page: exit 3 says the renderer's pass must finish the job" "$RC" 3
contains "...and it says so" "$OUT" "only the renderer's next live pass removes them"
contains "...after deleting the files it can name" "$(cat "$MOD_CALLS")" "--key note/aaaa.json"

# GSI1 paging: a second page (LastEvaluatedKey) is followed, so a hide beyond the first page is not missed
jq '. + {LastEvaluatedKey: {PK: {S: "MOD#note:aaaa"}}}' "$MOD_ITEMS" > "$MOD_ITEMS.2"; mv "$MOD_ITEMS.2" "$MOD_ITEMS"
jq -n '{Items: [{PK: {S: "MOD#note:onpagetwo"}, SK: {S: "META"}, hidden: {BOOL: true}, open: {BOOL: true}}]}' > "$MOD_ITEMS2"
mod_run --table t --site-bucket b --dry-run
contains "a hide on the second GSI1 page is found" "$OUT" "would delete: note/onpagetwo.json"
