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
| `js/islands/**` | **committed build output** of `islands/` — rebuild with `scripts/ci/build-islands.sh` (or `cd islands && npm run build`) and commit; `npm run check:islands` fails if it is stale |
| `js/auth-v2.js` | flag-gated two-path sign-in (HFY-TSK-062) |
| `js/feature-flags.js`, `js/search-navbar.js`, `js/search-results.js` | carry repo-only changes (flag override, island loader, searchV2 hand-off) not yet ported to the workspace |
| `sw.js`, `manifest.webmanifest`, `offline.html`, `images/pwa-*.png` | PWA shell (HFY-TSK-064) |
| `posts/`, `me/` | pages for `postsV2` / `notifyV2` islands (HFY-TSK-067/068) |
| `*/index.html` `<script src="/js/auth-v2.js" defer>` tags | added in the repo (HFY-TSK-062); the workspace templates do not emit them yet |

Until these are ported into `workspace/11ty-dev/src` (templates, `_data`, passthrough copies), keep them out of every
promotion. In particular, regenerated HTML pages must keep the `auth-v2.js` script tag, so re-add it (or port it to the
workspace layout) before committing a refreshed page.

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
  --exclude sw.js --exclude manifest.webmanifest --exclude offline.html \
  --exclude 'images/pwa-*.png' \
  --exclude posts/ --exclude me/ \
  ./_site/ ../repo/11ty/
```

Then check `git diff 11ty/` before committing: every `index.html` must still load `/js/auth-v2.js`, and
`git status 11ty/js/islands` must be clean. The `scripts/check-deployment-sync.sh` pre-commit check and
`scripts/promote_workspace_assets.sh` need the same exclude list (owned outside this directory).

The production copy only contains static HTML/CSS/JS; person data and media are fetched at runtime from the CDN
(`HFY_DATA_BASE`, `HFY_MEDIA_BASE`).

## Preview flags

`?hfy_flags=shellV2,searchV2` turns flags on for the current tab only (sessionStorage `hfy:flags`); `-name` forces one
off and `?hfy_flags=` clears the override. While an override is active a fixed "Preview flags on — turn off" banner is
shown. The override is dropped automatically, and the page falls back to the legacy behaviour, when a flagged dependency is
unavailable (an island bundle 404s, or `/auth/session` does not answer for `authV2`).
