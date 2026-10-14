# How to refresh `11ty/` from the Eleventy source without losing E5 files

Never refresh `11ty/` with a plain `rsync -a --delete` from the source. That command deletes every repo-owned file that the source output lacks, or replaces it with the source's older copy: the 12 E5-only files, the committed island bundles, and the islands build's theme layer, sign-in stylesheet and fonts. It reverts 2 edited scripts. It also strips the family-voice copy and the `?v=` asset versions from every page it overwrites, and the `auth-v2.js` tag too while the source's layout lacks it. A refresh from a source whose layout has not been ported also brings the retired Google sign-in and the Lunr search back (HFY-TSK-317). Three things do the most harm:

- `js/person-page.js` loses the `authV2` data path and waits for the legacy `X-HFY-Session` token, which an edge sign-in never mints. That breaks person pages while the [private data gate](cut-over-to-the-private-data-gate.md) is attached, and production attached it on 2026-10-12.
- `feature-flags.js` goes back to the pre-E5 script, which has no edge session, no `dataFetch` and no island loader.
- The source's layout writes the Google Identity Services client, `js/auth.js`, the navbar search, `js/search-navbar.js` and the `/api/check-allowed` gateway entry into every page again, and its `family-login/` page is the Google sign-in. No page may load them: [the mirror check](#check-whether-the-mirror-is-done) tells you whether the source has been ported.

[Why React islands on a generated Eleventy site](../explanation/islands-on-eleventy.md#the-consequence-two-sources-of-truth) explains how `11ty/` ended up with two sources of truth.

This page rebuilds the site from `<eleventy-source>` and promotes the result into `11ty/` with the repo-owned files intact. It then runs the islands build over the refreshed pages, which writes the head blocks, the family-voice copy and the `?v=` versions back into them. The [codebase map](../reference/codebase-map.md#what-in-11ty-is-generated) sorts the files in `11ty/` into generated, repo-edited, repo-only and build output. [Theme and asset build](../reference/theme-and-asset-build.md) lists everything the islands build writes.

Placeholders used on this page:

- `<repo>` is the root of your checkout or worktree. Every command runs from there.
- `<project>` and `<eleventy-source>` are defined in the [codebase map](../reference/codebase-map.md). The commands refer to the source as `$SRC`.
- `<site>` is the production host name ([Private data and secrets](../reference/private-data-and-secrets.md#placeholders)).
- `<n>` is an HFY task number.

## Before you start

- **Node 22 or later.** The Eleventy build needs Node 18 or later (Eleventy 3). The islands build in [step 6](#6-rebuild-the-islands-over-the-refreshed-pages) and the tests in [Verify](#verify) need Node 22 or later ([`islands/package.json`](../../islands/package.json)). Node 22 covers both.
- **`npm ci` has been run in `<eleventy-source>`.**
- **You can get a CodeArtifact token.** Step 6 installs the island dependencies, which come from a private registry. [Build and preview the islands](build-and-preview-the-islands.md#1-get-a-codeartifact-token) shows how to export `CODEARTIFACT_AUTH_TOKEN`.
- **The search inputs are present.** `npm run build` starts with `build:search`, which runs `<project>/scripts/search/build_search_index.js` without `HFY_PERSON_DIR`, so it reads the sanitized person records in `<project>/workspace/harrisonfamily-frontend/person/`. It rewrites `index.json` and `search-index.json` in that directory. Neither file reaches `11ty/`. The real person and media data, which the source's data files and config read, is a separate private tree under `<project>/workspace-local/`. The excludes in [steps 3 and 4](#3-dry-run) keep it out of `11ty/`.
- **`<project>/content/homepage.txt` is present.** The homepage text comes from this file. If it is missing, the build logs `[HFY] Missing homepage content file`, keeps going and renders the homepage with that text empty.
- **`git status --short 11ty/ islands/ auth/edge.manifest.json` prints nothing**, so the diff afterwards shows only the refresh and the islands build's outputs come out as committed.
- **The source is mirrored.** [Check whether the mirror is done](#check-whether-the-mirror-is-done) tells you which parts, if any, are missing.

Set the source path for the commands that follow:

```sh
SRC=<eleventy-source>
```

## Mirror the repository's files into the source

The build can only reproduce a repository file that exists in the source. Each one is copied into `public/`, which Eleventy passes through to the site root unchanged, the base layout gets the `auth-v2.js` tag, and the retired sign-in and search pieces are removed from the source (mirror steps 3 and 5).

The refresh in [step 3](#3-dry-run) excludes all 14 mirrored files, so it keeps the repository's copies even where the source's copies are older. It does not exclude the rendered pages, so the layout edits are required. Without them, the refresh strips the tag from every page it overwrites and writes the retired sign-in back, and the islands build does neither fix. Mirroring the files as well keeps the two copies in step, and the check below shows when they drift apart.

The rest of what the repository adds to the pages needs no mirroring:

- `src/_includes/partials/head.njk` already emits head blocks A and B. Their `hfy-theme.css?v=` value and UI font file name are hard-coded, so they go stale with the next theme or font change. Leave them as they are. The islands build rewrites both blocks in `11ty/` on every run, so its values are the ones that ship.
- The family-voice copy and the `?v=` versions of the other scripts and stylesheets are not in the source. The islands build writes them in [step 6](#6-rebuild-the-islands-over-the-refreshed-pages). [The design system theme layer](../explanation/design-system-theme-layer.md) explains why the build rewrites the copy until the source is ported.

Never mirror `js/islands/`, `css/hfy-theme.css`, `css/auth-edge.css` or `fonts/`. They are the output of [`islands/build.mjs`](../../islands/build.mjs), whose source is `islands/` in this repository. A copy in the Eleventy source would be stale after the next islands build ([Build and preview the islands](build-and-preview-the-islands.md)).

### Check whether the mirror is done

```sh
for f in _data/flags.json js/auth-v2.js js/feature-flags.js js/person-page.js \
         sw.js manifest.webmanifest offline.html \
         images/pwa-192.png images/pwa-512.png images/pwa-maskable-512.png \
         posts/index.html me/index.html me/notifications/index.html tree/index.html family-login/index.html; do
  cmp -s "11ty/$f" "$SRC/public/$f" && echo "mirrored: $f" || echo "missing or different: $f"
done
grep -c 'src="/js/auth-v2.js"' "$SRC/src/_includes/layouts/base.njk"
grep -rlE 'gsi/client|/api/check-allowed|/js/auth\.js|/js/search-navbar\.js|/js/search-results\.js' "$SRC/src" || true
for f in js/auth.js js/search-navbar.js js/search-results.js js/islands; do test ! -e "$SRC/public/$f" || echo "remove $SRC/public/$f"; done
```

The mirror is done when the loop prints `mirrored` for all 14 files, the first `grep` prints `1`, and nothing else is printed: the second `grep` lists no source template that still names a retired script or endpoint, and no `remove` line appears. Otherwise, do only the parts that are missing:

- A file reported as `missing or different`: mirror steps 1 and 2 below.
- A `grep` count of `0`, or a file listed by the second `grep`: mirror step 3.
- A `remove` line for `js/islands`: mirror step 4.
- A `remove` line for `js/auth.js`, `js/search-navbar.js` or `js/search-results.js`: mirror step 5.

The islands build rewrites seven of the mirrored files whenever a file they reference changes, so they drift from the source's copies:

- `js/feature-flags.js` and `sw.js`, through their `hfy-asset-versions` blocks;
- `manifest.webmanifest`, through its colours;
- `offline.html`, `family-login/index.html`, `posts/index.html`, `me/index.html`, `me/notifications/index.html` and `tree/index.html`, through their head blocks and `?v=` versions.

For these, `missing or different` usually means only that a build has changed them since the last copy. Copy them again with mirror steps 1 and 2.

### Mirror the missing parts

| Repository file | Source path | Notes |
|---|---|---|
| `11ty/_data/flags.json` | `public/_data/flags.json` | Published at `/_data/flags.json`. This is not Eleventy's data directory, which is `src/_data/`. |
| `11ty/js/auth-v2.js` | `public/js/auth-v2.js` | Replaces the source copy, or is new in the source. |
| `11ty/js/feature-flags.js` | `public/js/feature-flags.js` | Replaces the source copy. The islands build rewrites its stamp block. |
| `11ty/js/person-page.js` | `public/js/person-page.js` | Replaces the source copy, which lacks the `authV2` data path and the design-system layout. |
| `11ty/family-login/index.html` | `public/family-login/index.html` | The redirect page to `/auth/login`. It replaces the Google sign-in page, so the source's own `/family-login/` template must go too (mirror step 5). The islands build writes its head blocks. |
| `11ty/sw.js` | `public/sw.js` | The islands build rewrites its stamp block. |
| `11ty/manifest.webmanifest` | `public/manifest.webmanifest` | The islands build writes its colours. |
| `11ty/offline.html` | `public/offline.html` | A standalone page. The islands build writes its head blocks and versions. |
| `11ty/images/pwa-192.png`, `pwa-512.png`, `pwa-maskable-512.png` | `public/images/`, same names | |
| `11ty/me/notifications/index.html` | `public/me/notifications/index.html` | A standalone page that does not use the base layout, so it can pass through as a file. |
| `11ty/posts/index.html` | `public/posts/index.html` | Standalone, like the notifications page. |
| `11ty/me/index.html` | `public/me/index.html` | The settings hub (`navMe`, HFY-TSK-091). Standalone, like the notifications page. |
| `11ty/tree/index.html` | `public/tree/index.html` | The family tree page (`familyViz`, HFY-TSK-201). Standalone, like the settings hub; `public/` passes it through, so the refresh no longer deletes it. |

These are mirror steps 1 to 5, numbered separately from the refresh's [steps](#steps). Do only those the check pointed you to.

1. Check that each of the two scripts in the source is already mirrored, still the version the repository started from, or a copy of a version the repository committed later. The loop compares each script with its baseline, a commit that holds the version from before the repository changed it:

   - `1044451^` for `feature-flags.js`. `1044451` is HFY-TSK-064, the first E5 commit to change it.
   - `30c883d^` for `person-page.js`. `30c883d` is HFY-TSK-080, the private data gate, and the first E5 commit to change it.

   ```sh
   for f in feature-flags.js person-page.js; do
     case "$f" in person-page.js) base='30c883d^' ;; *) base='1044451^' ;; esac
     if cmp -s "11ty/js/$f" "$SRC/public/js/$f"; then echo "$f: already mirrored"; continue; fi
     state="source has changed"
     for c in "$base" $(git log --format=%h "$base..HEAD" -- "11ty/js/$f"); do
       if git show "$c:11ty/js/$f" | cmp -s - "$SRC/public/js/$f"; then state="safe to replace ($c)"; break; fi
     done
     echo "$f: $state"
   done
   ```

   Each line should end in `already mirrored` or `safe to replace`. The commit in parentheses is the version the source holds: the baseline, or a later commit when an earlier mirror was not kept up to date. A script that reports `source has changed` matches no committed version, so it has work in the source that the repository lacks. Merge that script by hand instead of copying it.

2. Copy the files. Copying a file that is already mirrored changes nothing. If mirror step 1 reported a script as `source has changed`, remove that script's path from the list in the loop before you run it, and merge the script by hand:

   ```sh
   for f in _data/flags.json js/auth-v2.js js/feature-flags.js js/person-page.js \
            sw.js manifest.webmanifest offline.html \
            images/pwa-192.png images/pwa-512.png images/pwa-maskable-512.png \
            posts/index.html me/index.html me/notifications/index.html tree/index.html family-login/index.html; do
     mkdir -p "$SRC/public/$(dirname "$f")"
     cp "11ty/$f" "$SRC/public/$f"
   done
   ```

3. In `$SRC/src/_includes/layouts/base.njk`, add the `auth-v2.js` tag on its own line directly before the `feature-flags.js` tag, at the same indentation:

   ```html
       <script src="/js/auth-v2.js" defer></script>
       <script src="/js/feature-flags.js"></script>
   ```

   All ten rendered pages use this layout, so each one gets the tag where the committed pages have it. The tag stays unversioned in the source. The islands build adds its `?v=` in `11ty/`.

   In the same layout and its partials, remove what HFY-TSK-317 took out of the committed pages: the `window.HFY_AUTH_CONFIG` block, the `<script src="https://accounts.google.com/gsi/client">` tag, the `/js/auth.js` tag, the `window.HFY_SEARCH_CONFIG` block, the `/js/search-navbar.js` tag, and the navbar search markup (the `navbar-search-wrapper` block). In the navbar partial, the "FAMILY LOGIN" link and the home hero's "sign in" button point at `/auth/login` instead of `/family-login/`. In `src/_data/featureFlags.js`, drop the `gateway` entry, `sessionToken` from `defaultState`, and the `navbarSearch` component. Remove the `<script src="/js/search-results.js">` tag and the legacy search section from the template that renders `/search/`. The committed pages show the target; `git diff` of the HFY-TSK-317 commit lists every change.

4. Remove the island bundles from the source:

   ```sh
   rm -r "$SRC/public/js/islands"
   ```

5. Remove the retired scripts from the source's `public/`, and the source's Google sign-in page. The page is replaced by the mirrored `family-login/index.html`, so delete the template that renders `/family-login/` and its copy of the Google sign-in markup:

   ```sh
   rm -f "$SRC/public/js/auth.js" "$SRC/public/js/search-navbar.js" "$SRC/public/js/search-results.js"
   ```

Run [the check](#check-whether-the-mirror-is-done) again. It now prints 14 `mirrored` lines, `1`, and nothing else.

After the mirror, make every hand change to these files in `11ty/` and copy it to the source. The refresh excludes them, so a change made only in the source never reaches `11ty/`. A change made only in `11ty/`, by hand or by an islands build, leaves the source's copy behind, and the check then reports it as `missing or different`.

## Steps

### 1. Build

```sh
(cd "$SRC" && env -u HFY_FEATURE_FLAGS__DEBUG \
  -u HFY_PERSON_DIR \
  HFY_ENV=prod \
  HFY_DATA_BASE="https://<site>/person/" \
  HFY_MEDIA_BASE="https://<site>/media/" \
  npm run build)
```

The build writes `$SRC/_site/`. The `env -u` part makes sure these variables are unset:

- `HFY_FEATURE_FLAGS__DEBUG` would change the flags config inlined into every rendered page. The gateway variables and `HFY_GOOGLE_CLIENT_ID` that earlier builds had to unset are not read by a ported source (HFY-TSK-317).
- `HFY_PERSON_DIR` would point `build:search` at another person directory and rewrite the index files there.

`HFY_ENV`, `HFY_DATA_BASE` and `HFY_MEDIA_BASE` are the production values. The person page still renders `env: "dev"`, `dataBase: "/person/"` and `mediaBase: "/media/"`, the same values as the committed copy, because `src/person.njk` cannot read those variables. That is expected ([Data fetched at runtime](../reference/front-end.md#data-fetched-at-runtime)).

If the build logs `[HFY] Missing homepage content file`, stop. Add `<project>/content/homepage.txt` and build again.

Eleventy does not empty `_site/` before a build. Files left over from an older build are copied along with the rest, so watch for unexpected new files in the dry run.

### 2. Validate the build

```sh
grep -c 'src="/js/auth-v2.js"' "$SRC/_site/index.html"
grep -lE 'gsi/client|/api/check-allowed|/js/auth\.js|/js/search-navbar\.js|/js/search-results\.js' "$SRC/_site/index.html" "$SRC/_site"/*/index.html | grep -v '/family-login/' | wc -l
grep -c '/auth/login' "$SRC/_site/family-login/index.html"
```

The first command prints `1`, which confirms the layout edit. The source does not version the tag, so this match includes the closing quote. The second prints `0`: no rendered page loads the Google client, `auth.js`, the navbar search or the gateway endpoint. The third prints a count above `0`: the source's `/family-login/` is the redirect page, not the Google sign-in. A different result means the source layout has not been ported (mirror step 3 and 5). Do not go on.

[`scripts/validate_build.sh`](../../scripts/validate_build.sh) runs these checks and also fails when the build still emits `js/auth.js`, `js/search-navbar.js` or `js/search-results.js`. It looks for the build at `<repo>/../workspace/11ty-dev/_site`, so it works only when the checkout's parent directory is `<project>`, as at `<project>/repo`. Anywhere else it stops with `Build directory not found`.

### 3. Dry run

```sh
rsync -ainc --delete --omit-dir-times \
  --exclude 'person/' --exclude 'family/' --exclude 'event/' --exclude 'note/' \
  --exclude 'media/' --exclude 'private/' --exclude 'place/' \
  --exclude 'README.md' --exclude '.DS_Store' --exclude 'uploads/' \
  --exclude '_data/flags.json' --exclude 'js/islands/' --exclude 'js/auth-v2.js' \
  --exclude 'js/feature-flags.js' --exclude 'js/person-page.js' --exclude 'family-login/' \
  --exclude 'css/auth-edge.css' --exclude 'css/hfy-theme.css' --exclude 'fonts/' \
  --exclude 'sw.js' --exclude 'manifest.webmanifest' --exclude 'offline.html' \
  --exclude 'images/pwa-*.png' --exclude 'posts/' --exclude 'me/' \
  "$SRC/_site/" 11ty/
```

These are the excludes that [`scripts/check-deployment-sync.sh`](../../scripts/check-deployment-sync.sh) uses for its `11ty/` comparison. The refresh command in [`11ty/README.md`](../../11ty/README.md) uses the same ones, apart from `.DS_Store`. Leave none of them out:

- The data directories and `private/` hold private records in the source output. Without `place/`, for example, the private place records would be copied into `11ty/`.
- `uploads/` is the prefix for member photo uploads. The site deploy excludes it too.
- `README.md` exists only in the repository.
- The rest are the files the repository owns. These are the repo-only files, the two repo-edited scripts and the redirect page `family-login/` (HFY-TSK-317), and the islands build's outputs: `js/islands/`, `css/hfy-theme.css`, `css/auth-edge.css` and `fonts/`. The refresh neither deletes nor overwrites them, whatever the source holds. The `js/islands/` exclude also protects any island bundles you have built locally.

[`scripts/infra/test/run.sh`](../../scripts/infra/test/run.sh) fails when the sync check and the `11ty/README.md` command exclude different paths, `.DS_Store` aside. It also fails when either of them, or the README's repo-owned table, leaves out `js/person-page.js`, `family-login/`, `css/auth-edge.css`, `css/hfy-theme.css` or `fonts/`. It checks only the README copy of the command, not this page. When the list changes, change all three together.

The `-c` flag compares file contents, so a file that differs only in timestamp is not reported as a content change.

Read the output against this table. The number of trailing characters in each code depends on the rsync version.

| Line starts with | Meaning | Expect |
|---|---|---|
| `*deleting` | The file would be removed from `11ty/`. | None. The excludes cover every file the repository owns, so a deletion means the source output no longer has a generated file. Apply only if you removed it from the source on purpose. |
| `>fc`, as in `>fcst....` | The content would change. | Always the seven rendered pages the refresh compares: `index.html`, and `index.html` under `about/`, `contact/`, `logged-out/`, `privacy/`, `search/` and `terms/`. The committed copies carry the islands build's edits, and the source output does not: the family-voice copy instead of the old footer, titles and hero, the `?v=` versions, and the current theme-block values. Step 6 puts those back, so judge these pages by their `git diff` after step 6. Any other file should appear only if it changed in the source since the last refresh. |
| `.f..t` | Same content, different timestamp. | Any number. Git sees no change. |
| `>f+++` or `cd+++` | A new file or directory. | Only what you added to the source. A new page needs registering with the islands build ([If something fails](#if-something-fails)). |

If rsync warns that it cannot delete `_data` because the directory is not empty, the source output has no `_data/flags.json`. Either the mirror of that file is missing or the build is older than the mirror. Finish the mirror and build again.

### 4. Apply

1. Run the same command without `-n`:

   ```sh
   rsync -aic --delete --omit-dir-times \
     --exclude 'person/' --exclude 'family/' --exclude 'event/' --exclude 'note/' \
     --exclude 'media/' --exclude 'private/' --exclude 'place/' \
     --exclude 'README.md' --exclude '.DS_Store' --exclude 'uploads/' \
     --exclude '_data/flags.json' --exclude 'js/islands/' --exclude 'js/auth-v2.js' \
     --exclude 'js/feature-flags.js' --exclude 'js/person-page.js' --exclude 'family-login/' \
     --exclude 'css/auth-edge.css' --exclude 'css/hfy-theme.css' --exclude 'fonts/' \
     --exclude 'sw.js' --exclude 'manifest.webmanifest' --exclude 'offline.html' \
     --exclude 'images/pwa-*.png' --exclude 'posts/' --exclude 'me/' \
     "$SRC/_site/" 11ty/
   ```

2. Copy the person page, which the `person/` exclude skips:

   ```sh
   cp "$SRC/_site/person/index.html" 11ty/person/index.html
   ```

   Copy only `index.html`. Everything else in `_site/person/` is private person JSON, which the source's config copies into `_site/` on every build.

3. Leave `11ty/private/index.html` as it is. It is the family tab's redirect page, "your family": it holds no person data, and `src/private/index.njk` in the source renders the same page. (Until 2026-10 the source's page rendered the whole person directory from the private data, including names, living status, birth years and record IDs, which is why the directory was kept out of the repository.) If the base layout or `src/private/index.njk` has changed, make the same change in `11ty/private/index.html` by hand, and let step 6 rewrite its head blocks, copy and versions. [Family data privacy](../explanation/family-data-privacy.md) explains why the data stays out of `11ty/`.

#### Alternative to steps 3 to 5 (dry run, apply, check)

Instead of the rsync commands, [`scripts/promote_workspace_assets.sh`](../../scripts/promote_workspace_assets.sh) promotes the files listed in a session log. Run it with `--dry-run` first, and list files, not directories, because it syncs a directory entry with `--delete`. A listed `11ty/js/` would delete `js/islands/`, which mirror step 4 removes from the source, or replace it with any stale bundles left in `_site/js/`. It would also overwrite the two edited scripts with the source's copies. A listed `11ty/css/` would delete `css/hfy-theme.css` and `css/auth-edge.css`. It has no exclude list, so never list a file the repository owns, such as `11ty/js/person-page.js` or `11ty/family-login/index.html`: the script overwrites it with the source's copy. It needs the checkout's parent directory to be `<project>`. [Repository operations](../reference/repository-operations.md#workspace-helper-scripts) describes its log format and behavior. Step 6 is still required after it.

### 5. Check the copy against the build

Run the [step 3](#3-dry-run) dry-run command again, before step 6. It prints nothing, or only `.f..t` lines, so `11ty/` now holds exactly the source output outside the excludes.

After step 6, the same command always reports the seven rendered pages as `>fc` again, because the islands build has rewritten them.

### 6. Rebuild the islands over the refreshed pages

The refreshed pages now have the source's old copy, the source's stale head-block values (among them the hard-coded `hfy-theme.css?v=` in block B), and unversioned URLs for every other script and stylesheet. The islands build puts all three right, on `person/index.html` and `private/index.html` too.

1. Export `CODEARTIFACT_AUTH_TOKEN` in this shell ([Build and preview the islands](build-and-preview-the-islands.md#1-get-a-codeartifact-token)).
2. Install the island dependencies and build:

   ```sh
   (cd islands && npm ci && npm run build)
   ```

   It prints `built <n> files into <repo>/11ty (<m> written)`. Keep the dev dependencies in the install: do not pass `--omit=dev` or set `NODE_ENV=production`, because the build copies the brand fonts from them. [`scripts/ci/build-islands.sh`](../../scripts/ci/build-islands.sh) is the scripted equivalent.

3. Check the result:

   ```sh
   (cd islands && npm run check:islands)
   git status --short 11ty/js/islands 11ty/js/feature-flags.js 11ty/sw.js 11ty/manifest.webmanifest \
     11ty/css/hfy-theme.css 11ty/css/auth-edge.css 11ty/fonts auth/edge.manifest.json
   ```

   `check:islands` prints `<repo>/11ty is up to date (<n> generated files)` and exits `0`. The `git status` prints nothing. A refresh changes none of the build's inputs, so the build's own files come out exactly as committed.

Never skip this step. A page committed without it keeps the old copy and names its scripts and stylesheets by unversioned URLs. Cloudflare caches those for 4 hours, and CloudFront invalidations do not purge it, so visitors can get a mix of old and new files after the deploy ([Why one CloudFront distribution fronts everything](../explanation/edge-and-origin-design.md#static-files-and-versioned-urls-hfy-tsk-086)).

Never edit the head blocks, the family-voice copy, a `?v=` or an `hfy-asset-versions` block by hand. The next build overwrites them, and `check:islands` reports the difference until it does. To change the theme or the fonts themselves, follow [Change the theme or brand fonts](change-the-theme-or-brand-fonts.md).

## Verify

1. **Only the changes you meant.** `git status --short 11ty/` and `git diff --stat -- 11ty/` list only intended changes. Step 6 restored the islands build's edits, so the diff of each rendered page shows only what changed in the source. A changed `css/main.css` or `js/bootstrap.bundle.min.js` also changes the `?v=` with which every Eleventy page links it. Nothing is deleted. Nothing under `11ty/private/` changes, except a `?v=` that follows a changed `main.css` or bootstrap script, unless you edited it in step 4. The data directories (`person/`, `media/`, `family/`, `event/`, `note/`, `place/`) show nothing except `person/index.html`.
2. **Every repo-only file still exists.** This prints nothing:

   ```sh
   for f in _data/flags.json js/auth-v2.js sw.js manifest.webmanifest offline.html family-login/index.html \
            images/pwa-192.png images/pwa-512.png images/pwa-maskable-512.png \
            posts/index.html me/index.html me/notifications/index.html tree/index.html; do
     test -f "11ty/$f" || echo "missing: $f"
   done
   ```

3. **The repository's edits survived.**

   ```sh
   grep -c 'src="/js/auth-v2.js?v=' 11ty/index.html                            # 1
   grep -l 'src="/js/auth-v2.js?v=' 11ty/index.html 11ty/*/index.html | wc -l   # 9
   grep -c hfy_flags 11ty/js/feature-flags.js                                   # not 0
   grep -c 'featureFlags.dataFetch' 11ty/js/person-page.js                      # not 0
   grep -c 'auth/login' 11ty/family-login/index.html                            # not 0
   grep -rlE 'gsi/client|/api/check-allowed|js/auth\.js|search-navbar|search-results' 11ty --include='*.html' --include='*.js' | grep -v '^11ty/js/islands/'   # nothing
   ```

   The islands build versions the `auth-v2.js` tag, so in `11ty/` it reads `src="/js/auth-v2.js?v=<sha8>"`. A pattern that ends in the closing quote, `src="/js/auth-v2.js"`, matches nothing there. It matches only in the source, as in [step 2](#2-validate-the-build) and the mirror check. `hfy_flags` is the preview override in the island loader. `featureFlags.dataFetch` is the `authV2` data path in the person page, and the `family-login/` line proves the redirect page survived. The source's unmirrored copy of `person-page.js` prints `0`. The last command prints nothing.

   The client tests check the `authV2` data path and the sign-in hand-over more thoroughly. They need no install:

   ```sh
   node --test tests/client/*.test.mjs
   ```

4. **The flags did not change.** `git diff --quiet -- 11ty/_data/flags.json && echo unchanged` prints `unchanged`.
5. **The site passes the island tests.** They check the head blocks, the family-voice copy and the `?v=` versions on every page, and then run the browser specs against `11ty/` on `127.0.0.1:8089`:

   ```sh
   (cd api && npm ci)      # content-contract.test.mjs imports the API; needs CODEARTIFACT_AUTH_TOKEN
   (cd islands && npm test)
   ```

   [Run the tests](run-the-tests.md) covers the `api/` dependency and the Chrome requirement of the browser specs.

## If something fails

- **The islands build in step 6 stops with `Error: <page>: <ref> references <file>, which is not part of the site (cannot version it)`.** A refreshed page names a script or stylesheet that `11ty/` lacks. Copy the file from the source output, or remove the reference in the source and refresh again.
- **`theme-delivery` fails with `pages without a head-block registration (add them to heads.mjs PAGES)`.** The refresh brought a new page. Add it to `PAGES` in [`islands/heads.mjs`](../../islands/heads.mjs). If it uses the base layout, also add it to `COPY_PAGES` and `TITLES` in [`islands/copy.mjs`](../../islands/copy.mjs). Then repeat step 6. [Theme and asset build](../reference/theme-and-asset-build.md) describes both lists.
- **`copy` fails because a page still carries old copy or has the wrong title.** `copy.mjs` matches the old copy by exact string, so a rewording in the source slips past it. Update the matching entry in `copy.mjs`, or port the family-voice copy into the source, then repeat step 6.

## Commit

The pre-commit hook, [`scripts/git-hooks/pre-commit`](../../scripts/git-hooks/pre-commit), runs only after `git config core.hooksPath scripts/git-hooks`. When `11ty/` files are staged, it runs `check-deployment-sync.sh`, which compares `<repo>/../workspace/11ty-dev/_site` with `11ty/` by size and modification time. It uses the same excludes as the [dry run](#3-dry-run), so it skips the data directories and every file the repository owns ([Repository operations](../reference/repository-operations.md#workspace-helper-scripts)). It compares the eight rendered pages whole, so it fails for every refresh:

- Where the checkout's parent directory is `<project>`, as at `<project>/repo`, it prints `[ERROR] Eleventy build (workspace/11ty-dev/_site -> repo/11ty) is out of sync with its workspace source.` and lists those pages. Step 6 wrote the family-voice copy, the `?v=` versions and the current theme blocks into them, and the source output has none of those. The check can pass again only once the source emits all of them.
- In a worktree outside `<project>`, the build path does not exist, so the check fails with `[ERROR] Eleventy build (workspace/11ty-dev/_site -> repo/11ty) source directory missing: ...`.

When the step 5 re-run printed nothing or only `.f..t` lines and step 6's `check:islands` passed, skip the check for this commit:

```sh
SKIP_DEPLOYMENT_SYNC_CHECK=1 git commit -m "HFY-TSK-<n>: refresh 11ty/ from the Eleventy source"
```

The variable skips only the sync check. The `trufflehog` secret scan still runs. Record in the HFY task's worklog that you skipped the check, why, and what the step 5 re-run and `check:islands` showed. Then ship the change with [Deploy a site change](deploy-a-site-change.md).

## Related

- [Why React islands on a generated Eleventy site](../explanation/islands-on-eleventy.md): why `11ty/` has two sources of truth and the two ways back to one.
- [The design system theme layer](../explanation/design-system-theme-layer.md): why the islands build writes the head blocks and the family-voice copy into the pages.
- [Why one CloudFront distribution fronts everything](../explanation/edge-and-origin-design.md#static-files-and-versioned-urls-hfy-tsk-086): why every page needs its `?v=` versions.
- [Front end](../reference/front-end.md): what each file in `11ty/` is and where it came from.
- [Theme and asset build](../reference/theme-and-asset-build.md): everything the islands build writes into `11ty/`.
- [Codebase map](../reference/codebase-map.md#what-in-11ty-is-generated): generated, repo-edited, repo-only and build-output files.
- [Repository operations](../reference/repository-operations.md): the hook, the sync check and the workspace helper scripts.
- [Build and preview the islands](build-and-preview-the-islands.md) and [Change the theme or brand fonts](change-the-theme-or-brand-fonts.md): the islands build, and changes to the theme and fonts it writes.
- [Toggle a feature flag](toggle-a-feature-flag.md): keep `flags.json` identical in both places after a flag change.
- [Cut over to authV2 and the private data gate](cut-over-to-the-private-data-gate.md): the cut-over that depends on the `authV2` data path in `js/person-page.js`.
