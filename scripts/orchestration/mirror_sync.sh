#!/usr/bin/env bash
# Re-mirror the 23 repo-owned 11ty files (HFY-R46; set per HFY-TSK-317: auth.js/search-navbar.js/search-results.js retired, family-login/ added; me/links/ (HFY-TSK-217) and tree/ (HFY-TSK-201) and me/inbox/ (HFY-TSK-185) and edit/ (HFY-TSK-212) and join/ (HFY-TSK-140) and me/review/ (HFY-TSK-259), me/requests/ (HFY-TSK-264) and edit/family/ (HFY-TSK-158) added 2026-10-14; chat/ (HFY-TSK-142) added 2026-10-15) from origin/main into the Dropbox Eleventy source.
# Backups go under workspace/backups/ (never beside the file: public/ passes through to the site; F2-16).
# usage: HFY_ORCH_REPO=<read-only worktree> HFY_DROPBOX_SITE=<eleventy workspace> mirror_sync.sh [--check]
#   HFY_ORCH_REPO     a dedicated, detached harrisonfamily worktree (git worktree add --detach <dir> origin/main);
#                     the script moves it to origin/main, so never point it at a checkout on a branch.
#   HFY_DROPBOX_SITE  the Dropbox Eleventy workspace: the directory that holds 11ty-dev/public/ and backups/.
set -euo pipefail
: "${HFY_ORCH_REPO:?mirror_sync: set HFY_ORCH_REPO to a detached, read-only harrisonfamily worktree (git worktree add --detach <dir> origin/main)}"
: "${HFY_DROPBOX_SITE:?mirror_sync: set HFY_DROPBOX_SITE to the Dropbox Eleventy workspace, the directory that holds 11ty-dev/public/ and backups/}"
REPO=$HFY_ORCH_REPO
W=$HFY_DROPBOX_SITE
[ -d "$W/11ty-dev/public" ] || { echo "mirror_sync: $W/11ty-dev/public not found; check HFY_DROPBOX_SITE" >&2; exit 2; }
if git -C "$REPO" symbolic-ref -q HEAD >/dev/null; then
  echo "mirror_sync: $REPO is on a branch; HFY_ORCH_REPO must be a detached read-only worktree (git worktree add --detach <dir> origin/main)" >&2
  exit 2
fi
PAT='^11ty/(js/(feature-flags|person-page|auth-v2)\.js|sw\.js|manifest\.webmanifest|offline\.html|_data/flags\.json|posts/index\.html|me/index\.html|me/notifications/index\.html|me/links/index\.html|me/inbox/index\.html|me/review/index\.html|me/requests/index\.html|edit/index\.html|edit/family/index\.html|join/index\.html|chat/index\.html|tree/index\.html|family-login/index\.html|images/pwa-)'
git -C "$REPO" fetch -q origin
git -C "$REPO" checkout -q --detach origin/main
cd "$REPO"
TS=$(date -u +%Y%m%dT%H%M%SZ)
total=0; changed=0
while IFS= read -r f; do
  total=$((total + 1))
  rel=${f#11ty/}
  dst="$W/11ty-dev/public/$rel"
  if ! cmp -s "$f" "$dst"; then
    changed=$((changed + 1))
    if [ "${1:-}" = "--check" ]; then echo "DIFF $rel"; continue; fi
    mkdir -p "$(dirname "$W/backups/11ty-dev/public/$rel")" "$(dirname "$dst")"
    [ -f "$dst" ] && cp -p "$dst" "$W/backups/11ty-dev/public/$rel.bak-$TS"
    cp "$f" "$dst"
  fi
done < <(git ls-files 11ty | grep -E "$PAT")
# Files the repo no longer has but the mirror still does are reported, not deleted (deletions are a reviewed step).
echo "mirror: $total files, $changed $( [ "${1:-}" = "--check" ] && echo differ || echo re-mirrored ) at $(git rev-parse --short HEAD)"
leak=$(find "$W/11ty-dev/public" -name '*.bak-*' | wc -l | tr -d ' ')
[ "$leak" = "0" ] || echo "WARNING: $leak backup files inside public/"
