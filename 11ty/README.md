# 11ty/

Deployable output of the site, synced to the site bucket on every deploy. It is not only Eleventy output: it also holds repo-authored E5 files (the flags, the new sign-in script, the PWA shell, the posts and notification pages) that the out-of-repo Eleventy source, `<eleventy-source>`, does not produce, and four of its scripts are edited in the repository. `js/islands/` is the committed build output of `islands/` (HFY-R58): rebuild it with every `islands/` change and never edit it by hand. This README is synced with the rest of the directory, so keep private paths and values out of it.

Never run a plain `rsync --delete` into this directory; it deletes the E5 files. Refresh it only with [Refresh `11ty/` from the Eleventy source](../docs/how-to/refresh-the-eleventy-output.md), which uses the excludes below.

- What each file is and where it came from: [Front end](../docs/reference/front-end.md); the `?hfy_flags=` preview override: [Front end: Runtime override](../docs/reference/front-end.md#runtime-override-preview-flags)
- Why the directory has two sources of truth: [Why React islands on a generated Eleventy site](../docs/explanation/islands-on-eleventy.md)
- Rebuilding `js/islands/`: [Build and preview the React islands](../docs/how-to/build-and-preview-the-islands.md); flipping a flag: [Turn a feature flag on for one tab or for everyone](../docs/how-to/toggle-a-feature-flag.md)
- Shipping a change: [Deploy a change to the static site](../docs/how-to/deploy-a-site-change.md)

The two blocks below are machine-checked. [`scripts/infra/test/run.sh`](../scripts/infra/test/run.sh) fails unless the table lists `js/person-page.js` and the `rsync -a --delete -n -i` command excludes the same paths as the Eleventy check in [`scripts/check-deployment-sync.sh`](../scripts/check-deployment-sync.sh), `.DS_Store` aside. Change the two exclude lists together, and keep both headings and that command line as they are.

## Repo-owned files

The refresh excludes these, so it never deletes or overwrites them, whatever the source holds.

| Path | What it is |
| --- | --- |
| `_data/flags.json` | The build-time feature flags `authV2`, `notifyV2`, `personV2`, `postsV2`, `searchV2` and `shellV2`. |
| `js/islands/**` | Committed build output of `islands/` (HFY-R58). Rebuild with `scripts/ci/build-islands.sh` or `cd islands && npm run build`, and commit; `npm run check:islands` fails when it is stale. |
| `js/auth-v2.js` | The flag-gated `authV2` sign-in script (HFY-TSK-062). |
| `js/feature-flags.js`, `js/search-navbar.js`, `js/search-results.js` | Edited in the repository: the flag resolver, preview override and island loader, the `authV2` data path, and the `searchV2` stand-down in the two search scripts. |
| `js/person-page.js` | Edited in the repository: its data requests go through the `authV2` data path, `dataFetch` (HFY-R66). The source's copy lacks it and still waits for the legacy `X-HFY-Session` token, which breaks person pages once the private data gate is attached. |
| `sw.js`, `manifest.webmanifest`, `offline.html`, `images/pwa-*.png` | The PWA shell (HFY-TSK-064). |
| `posts/`, `me/` | The pages for the `postsV2` and `notifyV2` islands (HFY-TSK-067, HFY-TSK-068). |
| `README.md` | This file. |

The other excludes keep the family data (`person/`, `family/`, `event/`, `note/`, `place/`, `media/`), `private/` and member `uploads/` out of the refresh; [the how-to's dry run](../docs/how-to/refresh-the-eleventy-output.md#3-dry-run) explains each one. The `<script src="/js/auth-v2.js" defer>` tag in the ten rendered `index.html` pages was added in the repository (HFY-TSK-062) and is not excluded: a refresh keeps it only when the source's base layout emits it ([One-time mirror into the source](../docs/how-to/refresh-the-eleventy-output.md#one-time-mirror-into-the-source)).

## Refreshing from the Eleventy source

A summary of the how-to, not a substitute for it. The how-to also mirrors the E5 files into the source first, unsets the build variables that would change the output (`HFY_GOOGLE_CLIENT_ID` among them), copies the person page by hand and checks the result before you commit. `<eleventy-source>`, `<site>` and `<repo>` are defined in [Private data and secrets](../docs/reference/private-data-and-secrets.md#placeholders).

```bash
cd <eleventy-source>
HFY_ENV=prod \
HFY_DATA_BASE="https://<site>/person/" \
HFY_MEDIA_BASE="https://<site>/media/" \
npm run build

# Dry run first (-n) and read every line; then drop -n.
rsync -a --delete -n -i \
  --exclude README.md \
  --exclude media/ --exclude person/ --exclude family/ \
  --exclude event/ --exclude note/ --exclude private/ --exclude place/ \
  --exclude _data/flags.json \
  --exclude js/islands/ \
  --exclude js/auth-v2.js \
  --exclude js/feature-flags.js --exclude js/search-navbar.js --exclude js/search-results.js \
  --exclude js/person-page.js \
  --exclude sw.js --exclude manifest.webmanifest --exclude offline.html \
  --exclude 'images/pwa-*.png' \
  --exclude posts/ --exclude me/ --exclude uploads/ \
  ./_site/ <repo>/11ty/
```
