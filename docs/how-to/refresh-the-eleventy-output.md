# How to refresh `11ty/` from the Eleventy source without losing E5 files

Never refresh `11ty/` with a plain `rsync -a --delete` from the source. If the source has not been mirrored, that command deletes 10 E5 files, reverts 3 scripts and removes the `auth-v2.js` tag from every rendered page it overwrites. [Why React islands on a generated Eleventy site](../explanation/islands-on-eleventy.md) explains how `11ty/` ended up with two sources of truth.

This page rebuilds the site from `<eleventy-source>` and promotes the result into `11ty/` with the E5 files intact. The [codebase map](../reference/codebase-map.md#what-in-11ty-is-generated) lists which files in `11ty/` are generated, E5-edited or E5-only.

Placeholders used on this page:

- `<repo>` is the root of your checkout or worktree. Every command runs from there.
- `<project>` and `<eleventy-source>` are defined in the [codebase map](../reference/codebase-map.md). The commands refer to the source as `$SRC`.
- `<n>` is an HFY task number.

## Before you start

- **Node 22 or later.** The Eleventy build needs Node 18 or later (Eleventy 3), and the island build and tests in [Verify](#verify) need Node 22 or later ([`islands/package.json`](../../islands/package.json)). Node 22 covers both.
- **`npm ci` has been run in `<eleventy-source>`.**
- **The private inputs are present.** `npm run build` starts with `build:search`, which runs `<project>/scripts/search/build_search_index.js` on the person records in `<project>/workspace/harrisonfamily-frontend/person/`. It rewrites `index.json` and `search-index.json` in that directory. Neither file reaches `11ty/`.
- **`<project>/content/homepage.txt` is present.** The homepage text comes from this file. If it is missing, the build logs `[HFY] Missing homepage content file`, keeps going and renders the homepage with that text empty.
- **`git status --short 11ty/` prints nothing**, so the diff afterwards shows only the refresh.
- **The source is mirrored.** [Check whether the mirror is done](#check-whether-the-mirror-is-done) tells you which parts, if any, are missing.

Set the source path for the commands that follow:

```sh
SRC=<eleventy-source>
```

## One-time mirror into the source

The build can only reproduce an E5 file that exists in the source. Each one is copied into `public/`, which Eleventy passes through to the site root unchanged, and the base layout gets the `auth-v2.js` tag.

### Check whether the mirror is done

```sh
for f in _data/flags.json js/auth-v2.js js/feature-flags.js js/search-navbar.js js/search-results.js \
         sw.js manifest.webmanifest offline.html \
         images/pwa-192.png images/pwa-512.png images/pwa-maskable-512.png \
         posts/index.html me/notifications/index.html; do
  cmp -s "11ty/$f" "$SRC/public/$f" && echo "mirrored: $f" || echo "missing or different: $f"
done
grep -c 'src="/js/auth-v2.js"' "$SRC/src/_includes/layouts/base.njk"
test ! -e "$SRC/public/js/islands" || echo "remove $SRC/public/js/islands"
```

The mirror is done when the loop prints `mirrored` for all 13 files, the `grep` prints `1`, and the last line prints nothing. Otherwise, do only the parts that are missing:

- A file reported as `missing or different`: steps 1 and 2 below.
- A `grep` count of `0`: step 3.
- A `remove` line: step 4.

### Mirror the missing parts

| Repository file | Source path | Notes |
|---|---|---|
| `11ty/_data/flags.json` | `public/_data/flags.json` | Published at `/_data/flags.json`. This is not Eleventy's data directory, which is `src/_data/`. |
| `11ty/js/auth-v2.js` | `public/js/auth-v2.js` | New in the source. |
| `11ty/js/feature-flags.js` | `public/js/feature-flags.js` | Replaces the source copy. |
| `11ty/js/search-navbar.js` | `public/js/search-navbar.js` | Replaces the source copy. |
| `11ty/js/search-results.js` | `public/js/search-results.js` | Replaces the source copy. |
| `11ty/sw.js` | `public/sw.js` | New in the source. |
| `11ty/manifest.webmanifest` | `public/manifest.webmanifest` | New in the source. |
| `11ty/offline.html` | `public/offline.html` | New in the source. |
| `11ty/images/pwa-192.png`, `pwa-512.png`, `pwa-maskable-512.png` | `public/images/`, same names | New in the source. |
| `11ty/me/notifications/index.html` | `public/me/notifications/index.html` | A standalone page that does not use the base layout, so it can pass through as a file. |
| `11ty/posts/index.html` | `public/posts/index.html` | Standalone, like the notifications page. |

Never mirror `11ty/js/islands/`. Those bundles are the committed build output of [`islands/build.mjs`](../../islands/build.mjs), whose source is `islands/` in this repository, and a copy in the Eleventy source would be stale after the next island build ([Build and preview the islands](build-and-preview-the-islands.md)).

1. Check that the three scripts in the source are either already mirrored or still the versions E5 started from. `1044451` is HFY-TSK-064, the first E5 commit to change any of the three scripts, so its parent holds the pre-E5 versions:

   ```sh
   for f in feature-flags.js search-navbar.js search-results.js; do
     if cmp -s "11ty/js/$f" "$SRC/public/js/$f"; then echo "$f: already mirrored"
     elif git show "1044451^:11ty/js/$f" | cmp -s - "$SRC/public/js/$f"; then echo "$f: safe to replace"
     else echo "$f: source has changed"; fi
   done
   ```

   Each line should end in `already mirrored` or `safe to replace`. A script that reports `source has changed` has work in the source that the repository lacks. Merge that script by hand instead of copying it.

2. Copy the files. Copying a file that is already mirrored changes nothing. Leave out any script that step 1 reported as `source has changed`:

   ```sh
   for f in _data/flags.json js/auth-v2.js js/feature-flags.js js/search-navbar.js js/search-results.js \
            sw.js manifest.webmanifest offline.html \
            images/pwa-192.png images/pwa-512.png images/pwa-maskable-512.png \
            posts/index.html me/notifications/index.html; do
     mkdir -p "$SRC/public/$(dirname "$f")"
     cp "11ty/$f" "$SRC/public/$f"
   done
   ```

3. In `$SRC/src/_includes/layouts/base.njk`, add the `auth-v2.js` tag on its own line directly before the `feature-flags.js` tag, at the same indentation:

   ```html
       <script src="/js/auth-v2.js" defer></script>
       <script src="/js/feature-flags.js"></script>
   ```

   All ten rendered pages use this layout, so each one gets the tag where the committed pages have it.

4. Remove the island bundles from the source:

   ```sh
   rm -r "$SRC/public/js/islands"
   ```

Run [the check](#check-whether-the-mirror-is-done) again. It now prints 13 `mirrored` lines, `1`, and nothing else.

After the mirror, make every change to these files in both `11ty/` and the source. A change made in only one place is reverted by the next refresh, or never reaches `11ty/`.

## Steps

### 1. Build

```sh
(cd "$SRC" && env -u HFY_GOOGLE_CLIENT_ID \
  -u HFY_FEATURE_FLAGS__GATEWAY__ENFORCE_ASSETS \
  -u HFY_FEATURE_FLAGS__GATEWAY__ENDPOINT \
  -u HFY_FEATURE_FLAGS__GATEWAY__CONTEXT \
  -u HFY_FEATURE_FLAGS__DEBUG \
  -u HFY_PERSON_DIR \
  HFY_ENV=prod \
  HFY_DATA_BASE="https://harrisonfamily.us/person/" \
  HFY_MEDIA_BASE="https://harrisonfamily.us/media/" \
  npm run build)
```

The build writes `$SRC/_site/`. The `env -u` part makes sure these variables are unset:

- `HFY_GOOGLE_CLIENT_ID` would replace the client ID placeholder with a real ID ([Leave the client ID placeholder](#leave-the-client-id-placeholder)).
- `HFY_FEATURE_FLAGS__GATEWAY__ENFORCE_ASSETS`, when set to anything except `true`, turns asset gating off.
- `HFY_FEATURE_FLAGS__GATEWAY__ENDPOINT`, `HFY_FEATURE_FLAGS__GATEWAY__CONTEXT` and `HFY_FEATURE_FLAGS__DEBUG` would change the gateway config inlined into every rendered page. [Build variables](../reference/front-end.md#build-variables) lists their defaults.
- `HFY_PERSON_DIR` would point `build:search` at another person directory and rewrite the index files there.

`HFY_ENV`, `HFY_DATA_BASE` and `HFY_MEDIA_BASE` are the production values. The person page still renders `env: "dev"`, `dataBase: "/person/"` and `mediaBase: "/media/"`, the same values as the committed copy, because `src/person.njk` cannot read those variables. That is expected ([Data fetched at runtime](../reference/front-end.md#data-fetched-at-runtime)).

If the build logs `[HFY] Missing homepage content file`, stop. Add `<project>/content/homepage.txt` and build again.

Eleventy does not empty `_site/` before a build. Files left over from an older build are copied along with the rest, so watch for unexpected new files in the dry run.

### 2. Validate the build

```sh
grep -o '"enforceAssets":[a-z]*' "$SRC/_site/index.html"
grep -c 'src="/js/auth-v2.js"' "$SRC/_site/index.html"
grep -l REPLACE_WITH_GOOGLE_CLIENT_ID "$SRC/_site/index.html" "$SRC/_site"/*/index.html | wc -l
```

The first command prints `"enforceAssets":true`. The second prints `1`, which confirms the layout edit. The third prints `10`: every rendered page still carries the client ID placeholder. A lower count means `HFY_GOOGLE_CLIENT_ID` reached the build. Rebuild with it unset before you go on.

[`scripts/validate_build.sh`](../../scripts/validate_build.sh) runs the same `enforceAssets` check and adds client ID checks. It looks for the build at `<repo>/../workspace/11ty-dev/_site`, so it works only when the checkout's parent directory is `<project>`, as at `<project>/repo`. Anywhere else it stops with `Build directory not found`. When it finds the placeholder it warns `Remember to run the manual GIS patch after deployment`. That warning is expected. Ignore it, because the deploy replaces the placeholder.

### 3. Dry run

```sh
rsync -ainc --delete --omit-dir-times \
  --exclude 'person/' --exclude 'family/' --exclude 'event/' --exclude 'note/' \
  --exclude 'media/' --exclude 'private/' --exclude 'place/' \
  --exclude 'README.md' --exclude '.DS_Store' --exclude 'js/islands/' \
  "$SRC/_site/" 11ty/
```

The data-directory excludes are the ones [`scripts/check-deployment-sync.sh`](../../scripts/check-deployment-sync.sh) uses. Leave none of them out: without `place/`, for example, the private place records would be copied into `11ty/`. `README.md` exists only in the repository. The `js/islands/` exclude protects any island bundles you have built locally. The `-c` flag compares file contents, so a file that differs only in timestamp is not reported as a content change.

Read the output against this table. The number of trailing characters in each code depends on the rsync version.

| Line starts with | Meaning | Expect |
|---|---|---|
| `*deleting` | The file would be removed from `11ty/`. | None. If a mirrored file is listed, the mirror is incomplete. Fix it and rebuild before you apply. |
| `>fc`, as in `>fcst....` | The content would change. | Only files that changed in the source since the last refresh. The footer year comes from `site.currentYear`, so in a new year every page changes. |
| `.f..t` | Same content, different timestamp. | Any number. Git sees no change. |
| `>f+++` or `cd+++` | A new file or directory. | Only what you added to the source. |

### 4. Apply

1. Run the same command without `-n`:

   ```sh
   rsync -aic --delete --omit-dir-times \
     --exclude 'person/' --exclude 'family/' --exclude 'event/' --exclude 'note/' \
     --exclude 'media/' --exclude 'private/' --exclude 'place/' \
     --exclude 'README.md' --exclude '.DS_Store' --exclude 'js/islands/' \
     "$SRC/_site/" 11ty/
   ```

2. Copy the person page, which the `person/` exclude skips:

   ```sh
   cp "$SRC/_site/person/index.html" 11ty/person/index.html
   ```

   Copy only `index.html`. Everything else in `_site/person/` is private person JSON, which the source's config copies there for local preview.

3. Leave `11ty/private/index.html` as it is. The source's private page renders the whole person directory from the private data, including names, living status, birth years and record IDs, so `_site/private/index.html` must never reach the repository. The committed copy is a sanitized placeholder. If the base layout or `src/private/index.njk` has changed, make the same change in `11ty/private/index.html` by hand. [Family data privacy](../explanation/family-data-privacy.md) explains why the data stays out of `11ty/`.

**Alternative to sections 3 and 4.** [`scripts/promote_workspace_assets.sh`](../../scripts/promote_workspace_assets.sh) promotes the files listed in a session log. Run it with `--dry-run` first, and list files, not directories, because it syncs a directory entry with `--delete`. It needs the checkout's parent directory to be `<project>`. [Repository operations](../reference/repository-operations.md) describes its log format and behavior.

## Leave the client ID placeholder

The committed pages and `js/auth.js` keep the string `REPLACE_WITH_GOOGLE_CLIENT_ID`. The deploy pipeline's build step runs [`scripts/ci/patch-client-id.sh`](../../scripts/ci/patch-client-id.sh), which replaces the string on the CI runner with the `HFY_GOOGLE_CLIENT_ID` repository secret before the release is packaged. Do not patch it locally, and do not run that script in your checkout: it edits the files in place.

```sh
grep -rl REPLACE_WITH_GOOGLE_CLIENT_ID 11ty | wc -l
```

This prints `11`: the ten rendered pages and `js/auth.js`. A lower count means a page lost the placeholder, usually because `HFY_GOOGLE_CLIENT_ID` was set during the build. Do not commit. Rebuild with the variable unset, then apply again.

## Verify

1. **Only the changes you meant.** `git status --short 11ty/` and `git diff --stat -- 11ty/` list only intended changes. Nothing is deleted, nothing under `11ty/private/` changes, and the data directories (`person/`, `media/`, `family/`, `event/`, `note/`, `place/`) show nothing except `person/index.html`.
2. **`11ty/` matches the build.** Run the [step 3](#3-dry-run) dry-run command again. It prints nothing, or only `.f..t` lines.
3. **Every E5 file still exists.** This prints nothing:

   ```sh
   for f in _data/flags.json js/auth-v2.js sw.js manifest.webmanifest offline.html \
            images/pwa-192.png images/pwa-512.png images/pwa-maskable-512.png \
            posts/index.html me/notifications/index.html; do
     test -f "11ty/$f" || echo "missing: $f"
   done
   ```

4. **The E5 edits survived.**

   ```sh
   grep -c 'src="/js/auth-v2.js"' 11ty/index.html                         # 1
   grep -l 'src="/js/auth-v2.js"' 11ty/index.html 11ty/*/index.html | wc -l  # 10
   grep -c hfy_flags 11ty/js/feature-flags.js                              # not 0
   grep -c searchV2 11ty/js/search-navbar.js 11ty/js/search-results.js     # not 0 for either
   ```

   `hfy_flags` is the preview override in the island loader. The `searchV2` lines are the stand-down guards in the two search scripts.

5. **The flags did not change.** `git diff --quiet -- 11ty/_data/flags.json && echo unchanged` prints `unchanged`.
6. **The islands still mount on the refreshed pages.** The committed bundles are unchanged by a refresh, so check them, then run the island tests, which serve `11ty/` on `127.0.0.1:8089`:

   ```sh
   (cd islands && npm ci && npm run check:islands && npm test)    # npm ci needs CODEARTIFACT_AUTH_TOKEN
   git status --short 11ty/js/islands                               # prints nothing
   ```

   [Build and preview the islands](build-and-preview-the-islands.md) shows how to get the token. [Run the tests](run-the-tests.md) covers the contract tests' `api/` dependencies and the Chrome requirement.

## Commit from a worktree

The pre-commit hook, [`scripts/git-hooks/pre-commit`](../../scripts/git-hooks/pre-commit), runs only after `git config core.hooksPath scripts/git-hooks`. When `11ty/` files are staged, it runs `check-deployment-sync.sh`, which compares `<repo>/../workspace/11ty-dev/_site` with `11ty/`. It excludes the data directories and every file the repository owns, `js/islands/` included ([Repository operations](../reference/repository-operations.md#workspace-helper-scripts)), but it compares the rendered pages, `auth-v2.js` tag and all.

- Where the checkout's parent directory is `<project>`, as at `<project>/repo`, and the [mirror](#one-time-mirror-into-the-source) is done, the check passes after a refresh. If it reports the pages as out of sync, the source's base layout lacks the `auth-v2.js` tag: finish the mirror.
- In a worktree outside `<project>`, the build path does not exist, so the check fails with `[ERROR] Eleventy build (workspace/11ty-dev/_site -> repo/11ty) source directory missing: ...`.

If the check fails only because you are in a worktree, and the dry-run re-run in [Verify](#verify) item 2 printed nothing or only `.f..t` lines, skip the check for this commit:

```sh
SKIP_DEPLOYMENT_SYNC_CHECK=1 git commit -m "HFY-TSK-<n>: refresh 11ty/ from the Eleventy source"
```

The variable skips only the sync check. The `trufflehog` secret scan still runs. Record in the HFY task's worklog that you skipped the check, why, and what the dry-run re-run showed. Then ship the change with [Deploy a site change](deploy-a-site-change.md).

## Related

- [Why React islands on a generated Eleventy site](../explanation/islands-on-eleventy.md): why `11ty/` has two sources of truth and the two ways back to one.
- [Front end](../reference/front-end.md): what each file in `11ty/` is and where it came from.
- [Codebase map](../reference/codebase-map.md#what-in-11ty-is-generated): generated, E5-edited and E5-only files.
- [Repository operations](../reference/repository-operations.md): the hook, the sync check and the workspace helper scripts.
- [Toggle a feature flag](toggle-a-feature-flag.md): keep `flags.json` identical in both places after a flag change.
