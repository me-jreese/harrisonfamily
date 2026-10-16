#!/usr/bin/env bash
# automerge.sh <owner/repo> <pr> : poll checks; update-branch when BEHIND; merge on all-green CLEAN; print merged_at + sha
REPO=$1; PR=$2; P=~/enceladus/cutover-safety-net/kit-tools/prdesk.sh
# F-37: me-jreese/* lives in a different App installation than NX-2021-L/*
case "$REPO" in me-jreese/*) export GITHUB_INSTALLATION_ID=170505197;; esac
sleep 15
for i in $(seq 1 80); do
  out=$(PRDESK_REPO=$REPO $P status $PR 2>&1)
  st=$(echo "$out" | head -1 | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('mergeStateStatus'), d.get('state'))" 2>/dev/null)
  runs=$(echo "$out" | tail -n +3)
  case "$st" in *MERGED*) echo "already merged"; break;; esac
  runs=$(echo "$runs" | grep -v '^---' | grep -v '^\s*$')
  if [ -z "$runs" ]; then sleep 30; continue; fi  # no runs registered yet
  if echo "$runs" | grep -qE 'in_progress|queued|pending|waiting|action_required'; then sleep 30; continue; fi
  # newest result per workflow name wins
  fails=$(echo "$runs" | awk '{s=$1; $1=""; n=substr($0,2); if(!(n in seen)){seen[n]=1; if(s!="success"&&s!="skipped"&&s!="neutral") print s" "n}}')
  if [ -n "$fails" ]; then echo "FAILED: $fails"; echo "$out" | head -1; exit 1; fi
  case "$st" in
    CLEAN*|UNSTABLE*|HAS_HOOKS*) PRDESK_REPO=$REPO $P merge $PR 2>&1 | tail -1; break;;
    BEHIND*) PRDESK_REPO=$REPO $P update-branch $PR 2>&1 | tail -1; sleep 45;;
    *) sleep 20;;
  esac
done
PRDESK_REPO=$REPO $P get pulls/$PR 2>/dev/null | python3 -c "import json,sys; d=json.JSONDecoder().raw_decode(sys.stdin.read())[0]; print('MERGED', d.get('merged_at'), d.get('merge_commit_sha'))"
