# Eleventy Deployable Artifacts

This directory holds the **deployable** site. CI syncs it to S3 as-is with `aws s3 sync 11ty/ … --delete`: anything missing
here is deleted from production, and nothing here is built in CI.

Two kinds of files live here:

1. **Eleventy output** generated in `/Users/jreese/Dropbox/claude-code-dev/projects/harrisonfamily/workspace/11ty-dev`
   (`_site/`), promoted into this directory.
2. **Repo-owned files** that the Eleventy workspace does not produce (HFY-TSK-062…068, HFY-R58). A promotion must never
   delete or overwrite them.

## Repo-owned files (do not promote over these)

| Path | Owner / how to rebuild |
| --- | --- |
| `_data/flags.json` | build-time feature flags (`authV2`, `shellV2`, `searchV2`, `personV2`, `postsV2`, `notifyV2`) |
| `js/islands/**` | **committed build output** of `islands/` — rebuild with `scripts/ci/build-islands.sh` (or `cd islands && npm run build`, which also writes `css/hfy-theme.css`, `css/auth-edge.css`, `fonts/`, the head blocks and the `manifest.webmanifest` colours) and commit; `npm run check:islands` fails if any of them is stale |
| `js/auth-v2.js` | flag-gated two-path sign-in (HFY-TSK-062) |
| `js/feature-flags.js`, `js/search-navbar.js`, `js/search-results.js` | carry repo-only changes (flag override, island loader, searchV2 hand-off) not yet ported to the workspace |
| `js/person-page.js` | carries the authV2 data-gate path (`dataFetchInit`/`dataResponse`, HFY-TSK-080) not yet ported to the workspace; the workspace copy still waits for the legacy `X-HFY-Session` token, which breaks person pages once the data gate is attached |
| `js/auth.js` | carries the authV2 One Tap suppression (HFY-TSK-069, D-11): with `authV2` on the legacy GIS flow still renders its button but no longer auto-prompts (the bottom sheet covered the shell tab bar at 375 px); the workspace copy still prompts |
| `css/auth-edge.css` | the auth edge's own stylesheet (HFY-TSK-069, D-11): `auth/edge.manifest.json` `theme.cssUrl` points here instead of `/css/main.css`, whose dark-hero heading colours made the `/auth/login` headings white on white. **Built from `islands/src/auth-edge/auth-edge.css`** by `islands/build.mjs` (fonts, harrisonfamily theme and kit bridge bundled into one same-origin file, no runtime `@import`). Must stay served from `https://harrisonfamily.us` (the login page CSP `style-src` allows only that origin). Not an Eleventy output, so a refresh would delete it |
| `css/hfy-theme.css` | **built by `islands/build.mjs` from `islands/src/theme/` and `@io-kit/tokens`** (harrisonfamily theme, Bootstrap and kit bridges, the `@font-face` rules, the HFY partials, a print block): the design-system theme layer every page links render-blocking right after `main.css`. Generated, do not edit; `npm run check:islands` fails if it is stale |
| `fonts/` | **self-hosted OFL faces copied by `islands/build.mjs` from pinned `@fontsource` packages** (Source Sans 3, Libre Caslon Text, Source Code Pro; latin + latin-ext woff2, content-hashed names, plus their `LICENSE-*.txt`). No Google Fonts: the faces are same-origin (privacy, the auth edge CSP `font-src 'self'`, offline PWA) |
| `*/index.html` and `offline.html` hfy-theme head block | the `<!-- hfy-theme:start A -->` (color-scheme, static theme-color, shell early hint, UI-face preload) and `<!-- hfy-theme:start B -->` (`/css/hfy-theme.css?v=<hash>`) blocks around the `main.css` link, written by `islands/heads.mjs`; after an Eleventy refresh run `cd islands && npm run build` (the workspace templates do not emit them yet). `islands/tests/theme-delivery.test.mjs` fails when a page lacks them |
| the 10 Eleventy pages' DS Voice copy | the home hero (`hi family. this is where we keep our history.`, CTAs `our story` / `sign in`), the about and family-login headings, the lowercase page titles (`<title>`, `og:title`, `twitter:title`: `<page> · Harrison Family`) and the Voice footer (`harrisonfamily.us · kept by the family, for the family`) are **rewritten by `islands/copy.mjs`** during `cd islands && npm run build` (old copy only, idempotent; family-authored prose is never touched). An Eleventy refresh brings the old copy back until the workspace is ported, so rebuild after it; `npm run check:islands` and `islands/tests/copy.test.mjs` fail while a page still carries it |
| `sw.js`, `manifest.webmanifest`, `offline.html`, `images/pwa-*.png` | PWA shell (HFY-TSK-064) |
| `posts/`, `me/` | pages for `postsV2` / `notifyV2` islands (HFY-TSK-067/068) |
| `*/index.html` `<script src="/js/auth-v2.js" defer>` tags | added in the repo (HFY-TSK-062); the workspace templates do not emit them yet |

Until these are ported into `workspace/11ty-dev/src` (templates, `_data`, passthrough copies), keep them out of every
promotion. In particular, regenerated HTML pages must keep the `auth-v2.js` script tag, so re-add it (or port it to the
workspace layout) before committing a refreshed page, and must get the hfy-theme head blocks back (`cd islands && npm run build`).

**Port the copy to the workspace (for io):** `src/index` content (hero h1 closed with `</h1>`, h3, CTAs), the about and family-login
headings, `partials/footer.njk` and each page's title, exactly as `islands/copy.mjs` (`HERO`, `TITLES`, `FOOTER`) writes them; then
`copy.mjs` becomes a no-op and can be deleted.

**Port to the workspace (for io):** `partials/head.njk` gets block A immediately *before* the `/css/main.css` link and block B
immediately *after* it, exactly as `islands/heads.mjs` writes them (copy them from any built page; the `?v=` hash and the font
file name come from the islands build, so the workspace should read them from the build output rather than hard-code them).

## Refreshing production assets

```bash
cd /Users/jreese/Dropbox/claude-code-dev/projects/harrisonfamily/workspace/11ty-dev
HFY_ENV=prod \
HFY_DATA_BASE="https://harrisonfamily.us/person/" \
HFY_MEDIA_BASE="https://harrisonfamily.us/media/" \
npm run build

# Dry run first (-n) and read the deletions; then drop -n.
rsync -a --delete -n -i \
  --exclude README.md \
  --exclude media/ --exclude person/ --exclude family/ \
  --exclude event/ --exclude note/ --exclude private/ --exclude place/ \
  --exclude _data/flags.json \
  --exclude js/islands/ \
  --exclude js/auth-v2.js \
  --exclude js/feature-flags.js --exclude js/search-navbar.js --exclude js/search-results.js \
  --exclude js/person-page.js \
  --exclude js/auth.js \
  --exclude css/auth-edge.css \
  --exclude css/hfy-theme.css --exclude fonts/ \
  --exclude sw.js --exclude manifest.webmanifest --exclude offline.html \
  --exclude 'images/pwa-*.png' \
  --exclude posts/ --exclude me/ --exclude uploads/ \
  ./_site/ ../repo/11ty/
```

Then run `cd islands && npm run build` (it puts the hfy-theme head blocks and the DS Voice copy back into the refreshed pages) and check
`git diff 11ty/` before committing: every `index.html` must still load `/js/auth-v2.js` and carry both hfy-theme blocks, and
`git status 11ty/js/islands 11ty/css/hfy-theme.css 11ty/fonts` must be clean. The `scripts/check-deployment-sync.sh` pre-commit check uses the same exclude list
(`scripts/infra/test/run.sh` fails when the two differ). `scripts/promote_workspace_assets.sh` (owned outside this directory) has no
exclude list: it copies whatever a session log marks `"promote": true`, and a directory entry is synced with `rsync --delete`. Until it
learns these excludes, never mark a repo-owned path above (for example `11ty/js/person-page.js`) or the whole `_site` → `11ty`
directory for promotion; refresh 11ty output with the rsync above instead.

The production copy only contains static HTML/CSS/JS; person data and media are fetched at runtime from the CDN
(`HFY_DATA_BASE`, `HFY_MEDIA_BASE`).

## Preview flags

`?hfy_flags=shellV2,searchV2` turns flags on for the current tab only (sessionStorage `hfy:flags`); `-name` forces one
off and `?hfy_flags=` clears the override. While an override is active a fixed "preview flags on — turn off" banner is
shown. The override is dropped automatically, and the page falls back to the legacy behaviour, when a flagged dependency is
unavailable (an island bundle 404s, or `/auth/session` does not answer for `authV2`).
