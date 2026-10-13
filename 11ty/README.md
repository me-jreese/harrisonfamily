# 11ty/

The deployable site, synced to the site bucket on every deploy. This file is repo-only: `ci.manifest.yaml` excludes `README.md` from the static sync, so it is not served at `https://<site>/README.md`. Keep private paths and values out of it anyway, because it sits in a repository other people can read. The directory holds the output of the out-of-repo Eleventy source, `<eleventy-source>`, plus the repo-owned files and islands-build outputs listed below. Never `rsync --delete` into it, and never hand-edit a build output: rebuild with `cd islands && npm run build` and commit every file it touched (HFY-R58).

## Where it is documented

- What each file is and where it comes from: [Front end](../docs/reference/front-end.md) and [Codebase map: What in `11ty/` is generated](../docs/reference/codebase-map.md#what-in-11ty-is-generated). The `?hfy_flags=` preview override: [Front end: Runtime override](../docs/reference/front-end.md#runtime-override-preview-flags).
- What the islands build writes besides the bundles (the theme layer, the fonts, the head blocks, the family-voice copy, the `?v=` asset versions): [Theme and asset build](../docs/reference/theme-and-asset-build.md). Why: [Why React islands on a generated Eleventy site](../docs/explanation/islands-on-eleventy.md) and [Why the site's look is one built theme layer](../docs/explanation/design-system-theme-layer.md).
- Procedures: [Refresh `11ty/` from the Eleventy source](../docs/how-to/refresh-the-eleventy-output.md), [Build and preview the React islands](../docs/how-to/build-and-preview-the-islands.md), [Change the theme or brand fonts](../docs/how-to/change-the-theme-or-brand-fonts.md), [Turn a feature flag on or off](../docs/how-to/toggle-a-feature-flag.md) and [Deploy a change to the static site](../docs/how-to/deploy-a-site-change.md).
- The port to the Eleventy source, which comments in `islands/copy.mjs`, `islands/heads.mjs` and `islands/tests/copy.test.mjs` cite this file for: [Mirror the repository's files into the source](../docs/how-to/refresh-the-eleventy-output.md#mirror-the-repositorys-files-into-the-source). Until the source emits all of it, the islands build is authoritative.
- The two blocks below are machine-checked. [`scripts/infra/test/run.sh`](../scripts/infra/test/run.sh) fails unless the table lists `js/person-page.js`, `js/auth.js`, `css/auth-edge.css`, `css/hfy-theme.css` and `fonts/`, the `rsync` command excludes each of them, and that command excludes the same paths as the Eleventy check in [`scripts/check-deployment-sync.sh`](../scripts/check-deployment-sync.sh), `.DS_Store` aside. Change the two exclude lists together, and keep both headings and the command line as they are.

## Repo-owned files

The refresh excludes these, so it never deletes or overwrites them, whatever the source holds.

| Path | What it is |
| --- | --- |
| `_data/flags.json` | The build-time feature flags `authV2`, `navMe`, `notifyV2`, `personV2`, `postsV2`, `searchV2` and `shellV2`. |
| `js/islands/**` | Committed build output of `islands/` (HFY-R58). Rebuild with `scripts/ci/build-islands.sh` or `cd islands && npm run build`, and commit; `npm run check:islands` fails when it is stale. |
| `css/hfy-theme.css` | Build output: the design-system theme layer, built from `islands/src/theme/` and `@io-kit/tokens`. Every page links it render-blocking, right after `css/main.css` where the page has one; `main.css` itself is never edited. |
| `css/auth-edge.css` | Build output: the sign-in stylesheet, built from `islands/src/auth-edge/auth-edge.css` (HFY-TSK-069). `auth/edge.manifest.json` `theme.cssUrl` names it with `?v=<sha8 of this file>`, which the build stamps; the sign-in page links the new URL once `hfy-auth-edge` is redeployed. It must be served from `https://<site>`, the stylesheet origin the sign-in page's CSP allows. |
| `fonts/` | Build output: the self-hosted brand faces (Source Sans 3, Libre Caslon Text, Source Code Pro) as content-hashed `woff2` files, with their OFL licence texts, copied from pinned `@fontsource` packages. |
| `js/auth-v2.js` | The flag-gated `authV2` sign-in script (HFY-TSK-062). |
| `js/feature-flags.js` | Edited in the repository: the flag resolver, preview override and island loader, and the `authV2` data path. Its `hfy-asset-versions` block, the content hashes the island loader and the worker registration use, is a build stamp that every islands build rewrites. |
| `js/search-navbar.js`, `js/search-results.js` | Edited in the repository: the `searchV2` stand-down and the `authV2` data path. |
| `js/person-page.js` | Edited in the repository: its data requests go through the `authV2` data path, `HFYFeatureFlags.dataFetch` (HFY-R66), and it renders the design system's person layout and the extension points below. The source's copy lacks both and still waits for the legacy `X-HFY-Session` token, which breaks person pages while the private data gate is attached. |
| `js/auth.js` | Edited in the repository: with `authV2` on, the legacy Google button still renders but One Tap no longer prompts, because its bottom sheet covered the shell's tab bar at 375 px (HFY-TSK-069). The source's copy still prompts. |
| `sw.js`, `manifest.webmanifest`, `offline.html`, `images/pwa-*.png` | The PWA shell (HFY-TSK-064). Every islands build rewrites the `hfy-asset-versions` block in `sw.js` and the colours in `manifest.webmanifest`. The worker is registered at `/sw.js?v=<sha8 of sw.js>` and names its cache after that hash. |
| `posts/`, `me/` | The pages for the `postsV2` and `notifyV2` islands (HFY-TSK-067, HFY-TSK-068), and `me/index.html`, the settings hub of the `navMe` island `settings` (HFY-TSK-091). |
| `private/index.html` | The route of the shell's own-page tab: "me" since the `navMe` flip (HFY-TSK-223), "family" with `navMe` off (HFY-TSK-091). Its title is "your page" (`islands/copy.mjs`). It is a redirect page with no person data. Signed in, it sends the visitor to their own page, `/person/?id=<gramps id>`; signed out, to the edge sign-in, which returns to `/private/`. It replaced the 2025 "Person Directory" dev scaffold. It is not `/family/`, which is a gated data prefix. The refresh excludes `private/`; the source's matching page is `src/private/index.njk`. |
| `README.md` | This file. |

The other excludes keep the family data, `private/` and member `uploads/` out of the refresh. The other rendered pages are overwritten, which strips what the repository writes into them: [step 6 of the how-to](../docs/how-to/refresh-the-eleventy-output.md#6-rebuild-the-islands-over-the-refreshed-pages) rebuilds the head blocks, the family-voice copy and the `?v=` versions, but nothing puts back the `auth-v2.js` script tag unless the source is [mirrored](../docs/how-to/refresh-the-eleventy-output.md#mirror-the-repositorys-files-into-the-source).

## Person page extension points

`js/person-page.js` exposes these hosts and events, and nothing else, as the extension points for the person page (HFY-TSK-137, BRD2 section 10.2 item 13). Only that task and the W6 Graphviz removal edit the file, and each edit must be copied to the source's `public/js/person-page.js` (HFY-R46; the refresh already excludes it). That copy and its refresh dry run are not yet done for HFY-TSK-137 (a merge-stage step): the mirror loop reports `js/person-page.js` as different until it is. Every later person-page task changes `islands/` only.

| Point | What it is |
| --- | --- |
| `hfy:person-rendered` | Event on `document` after every render: `detail` is `{personId, person, sections}`, with `sections` the ids of the sections shown. The hero is rebuilt by each render, so an island refills its slots on every event. |
| `hfy:lightbox-media` | Event on `document` whenever the lightbox shows an image: `detail` is `{index, media, img, box}`, `box` being the image's container. |
| `[data-slot="hero-actions"]` | In the hero, with the ordered children `[data-slot="edit"]`, `"follow"` and `"presence"`. |
| `[data-slot="heading-chips"]` | Under the lifespan line, with the children `[data-slot="contributions"]` and `"links"`. |
| `[data-slot="tree-link"]` | In the family section, directly after the tree. |
| `#hfy-person-social` | The last child of `#person-content`, `hidden` until an island fills it. Island hosts such as `#hfy-person-comments` sit before it. |
| `mergedInto` | When the person JSON is `{mergedInto: "<id>"}`, the page redirects to `?id=<id>`. The id must match `[A-Za-z0-9_-]{1,32}` (Gramps ids such as `I0001` fit); a self-pointing or malformed id is ignored. The redirect adds `merged=<hops>` and stops after 2 hops (a cycle or long chain), showing the error line. `hfy:person-rendered` fires after the loading state is hidden and the content is shown. |

Empty hosts take no space (`islands/src/theme/45-person.css`), so a page with no island loaded renders as it did before. `islands/tests/person-page.spec.mjs` pins each point.

## Refreshing from the Eleventy source

The refresh's exclude list, kept here for the check above. It is not a procedure: follow [the refresh how-to](../docs/how-to/refresh-the-eleventy-output.md), whose dry run uses the same excludes plus `.DS_Store`. `<eleventy-source>` and `<repo>` are defined in [Private data and secrets](../docs/reference/private-data-and-secrets.md#placeholders).

```bash
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
  <eleventy-source>/_site/ <repo>/11ty/
```
