# Codebase map

Reference for where each capability lives in the repository, and for the few that live outside it.

Paths are relative to the repository root, and in-repo paths link to the code. These placeholders stand for locations and names outside the repository:

- `<project>` is the project directory that contains the repository checkout. The workspace helper scripts in `scripts/` treat the checkout's parent directory as `<project>`, and one of them writes to `<project>/repo` by name, so they expect the checkout at `<project>/repo`.
- `<eleventy-source>` is the Eleventy project at `<project>/workspace/11ty-dev`. It holds the templates, data files and public assets that produce `11ty/`. It is not under Git.
- `<app-stack>` is the deployed name of the app stack defined by `app-stack.yaml`. It is not `hfy-app`, the default of the behavior scripts' `--stack` and of the gate script's `--app-stack`.
- `<edge-code-bucket>` is the private us-east-1 S3 bucket that holds the private data gate's code.

The other placeholders, such as `<site>`, `<site-bucket>`, `<config-bucket>`, `<code-bucket>` and `<distribution-id>`, are defined in [Private data and secrets](private-data-and-secrets.md#placeholders).

For the components and how requests move between them, see the [architecture reference](architecture.md). For why the front end is a generated site with React islands on top, see [Why React islands on a generated Eleventy site](../explanation/islands-on-eleventy.md).

## Capability → code

Each capability has a section below with its paths, the facts that change how you work with them (generated or hand-maintained, gated by a flag, deployed by CI or not), and the page that describes it in full.

| Capability | Main paths | Reference page |
|---|---|---|
| [Static site output](#static-site-output) | `11ty/` | [Front end](front-end.md) |
| [Front-end runtime](#front-end-runtime) | `11ty/js/`, `11ty/_data/flags.json`, `11ty/sw.js` | [Front end](front-end.md) |
| [React islands](#react-islands) | `islands/`, `11ty/js/islands/` | [Front end](front-end.md) |
| [Theme layer, fonts and asset versions](#theme-layer-fonts-and-asset-versions) | `islands/build.mjs`, `islands/heads.mjs`, `islands/assets.mjs`, `islands/fonts.mjs`, `islands/copy.mjs`, `islands/src/theme/`, `islands/src/auth-edge/`, `11ty/css/hfy-theme.css`, `11ty/css/auth-edge.css`, `11ty/fonts/` | [Theme and asset build](theme-and-asset-build.md) |
| [Family API](#family-api) | `api/` | [API](api.md) |
| [MCP server](#mcp-server) | `api/src/mcp.js`, `api/src/policy.js`, `api/src/labels.js`, `api/src/mcp-caps.js`, `api/parity/`, `scripts/ci/mcp-conformance.sh`, `infrastructure/mcp-edge401.us-east-1.yaml`, `scripts/infra/add-mcp-behavior.sh` | [MCP server](mcp-server.md) |
| [Auth edge and MCP authorization server](#auth-edge-and-mcp-authorization-server) | `auth/` | [Identity services](identity-services.md) |
| [Private data gate](#private-data-gate) | `edge-gate/`, `infrastructure/cloudformation/edge-gate-stack.yaml`, `scripts/ci/package-edge-gate.sh`, `scripts/infra/add-data-gate-behaviors.sh` | [Identity services](identity-services.md#private-data-gate-hfy-edge-gate), [Architecture](architecture.md#hfy-edge-gate) |
| [CloudFront Function](#cloudfront-function) | `scripts/cloudfront/`, `scripts/infra/publish-append-index.sh` | [Architecture](architecture.md#hfyappendindex) |
| [Legacy sign-in](#legacy-sign-in) | `lambda/`, `functions/`, `gcloud/` | [Identity services](identity-services.md) |
| [Infrastructure](#infrastructure) | `infrastructure/`, `scripts/infra/`, `cloudfront/` | [Architecture](architecture.md) |
| [CI and repo operations](#ci-and-repo-operations) | `ci.manifest.yaml`, `.github/`, `scripts/ci/`, `scripts/git-hooks/`, the workspace helpers in `scripts/` | [Repository operations](repository-operations.md) |
| [Tests](#tests) | `api/test/`, `auth/test/`, `auth/e2e/`, `edge-gate/test/`, `islands/tests/`, `scripts/cloudfront/test/`, `scripts/infra/test/`, `tests/client/`, `tests/login-flow/`, `scripts/mcp/` | [Repository operations](repository-operations.md) |
| [Sanitized samples](#sanitized-samples) | `allowlist/`, `harrisonfamily-frontend/`, `etl-output/`, `gramps_exports/`, `cloudfront/` | [Private data and secrets](private-data-and-secrets.md) |
| [Outside the repository](#outside-the-repository) | `<eleventy-source>`, `<project>/scripts/`, `<project>/workspace-local/` | [Private data and secrets](private-data-and-secrets.md) |

## Static site output

Paths:

- [`11ty/`](../../11ty/): the deployable site. Each file is classified in [What in `11ty/` is generated](#what-in-11ty-is-generated).
- [`11ty/README.md`](../../11ty/README.md): a pointer into these docs, plus two machine-checked blocks: the repo-owned files table and the refresh `rsync`. See the constraint in [Notes](#notes).
- [`workspace/11ty-dev/src/_data/featureFlags.js`](../../workspace/11ty-dev/src/_data/featureFlags.js): a stray tracked copy of one source data file.

Facts:

- `11ty/` is Eleventy output plus repo-owned files. Its source is `<eleventy-source>`, outside the repository.
- [`islands/build.mjs`](../../islands/build.mjs) also writes into `11ty/`: the island bundles, the theme layer, the sign-in stylesheet, the fonts, and parts of the pages, `sw.js`, `js/feature-flags.js` and `manifest.webmanifest`. Every output is committed. See [React islands](#react-islands) and [Theme layer, fonts and asset versions](#theme-layer-fonts-and-asset-versions).
- CI deploys `11ty/` as committed and builds nothing into it. Its one change in CI is `scripts/ci/patch-client-id.sh`, which replaces the `REPLACE_WITH_GOOGLE_CLIENT_ID` placeholder in the HTML and JS files of the CI checkout. The committed files keep the placeholder.
- The `?v=<sha8>` on each script and stylesheet reference is the hash of the committed file. The client-ID patch changes `js/auth.js` after that, so the served `auth.js` does not hash to its own `?v`.
- `11ty/README.md` is repo-only: `ci.manifest.yaml` excludes `README.md` from the static sync, so it is not served. It still names no private path, because the repository can be read by others.
- When any staged path is under `11ty/`, the pre-commit check [`scripts/check-deployment-sync.sh`](../../scripts/check-deployment-sync.sh) compares `<project>/workspace/11ty-dev/_site` with `11ty/` using `rsync -ain --delete --omit-dir-times`. Any difference fails the commit.
- That comparison excludes the data directories (`person/`, `family/`, `event/`, `note/`, `media/`, `place/`), `private/`, `uploads/`, `README.md`, `.DS_Store` and the repo-owned files, among them `js/person-page.js`, `js/auth.js`, `css/auth-edge.css`, `css/hfy-theme.css` and `fonts/`.
- Excluding `person/` and `private/` also excludes the one page in each, `person/index.html` and `private/index.html`. The other Eleventy pages are compared whole. Fresh source output lacks their `auth-v2.js` tag, their Voice copy and their `?v` versions, so it differs from the committed pages (see [What in `11ty/` is generated](#what-in-11ty-is-generated)).
- `SKIP_DEPLOYMENT_SYNC_CHECK=1` skips the check.
- `workspace/11ty-dev/src/_data/featureFlags.js` is the legacy `window.HFY_FEATURE_FLAGS` config. Nothing in the repository builds from it, so it has no effect.

## Front-end runtime

Paths:

- [`11ty/js/feature-flags.js`](../../11ty/js/feature-flags.js): the legacy visibility gating and session cache (`window.HFYFeatureFlags`). It also holds, added in the repository:
  - the `hfy-asset-versions` stamp block (`ASSET_V`) at the top, which every islands build rewrites, and the fallback link to the theme layer;
  - the island loader: flag resolution, the `?hfy_flags=` override and its banner, `loadIsland`, `whenIsland`, `searchV2Live` and `assetVersions`;
  - the `authV2` data path: `dataFetchInit`, `dataFetch`, `edgeSession`, `forgetEdgeSession`, `signInUrl`, and the deprecated `dataResponse`;
  - the edge overlay, near the top of the file.
- [`11ty/js/auth.js`](../../11ty/js/auth.js): the legacy Google Identity Services sign-in. It posts the ID token to `/api/check-allowed`. It is repo-owned: when `authV2` resolves on, by build flag or override, it still renders the Google button but skips One Tap (`googleAccounts.prompt()`), whose bottom sheet covered the shell's tab bar at 375 px.
- [`11ty/js/auth-v2.js`](../../11ty/js/auth-v2.js): the `authV2` sign-in through `/auth`. It reads the session through `HFYFeatureFlags.edgeSession()` and calls `forgetEdgeSession()` on sign-out.
- [`11ty/js/person-page.js`](../../11ty/js/person-page.js): renders the person page in the design system's PersonRecord layout. It is repo-owned: its data requests go through `HFYFeatureFlags.dataFetch`.
- [`11ty/js/search-results.js`](../../11ty/js/search-results.js), [`11ty/js/search-navbar.js`](../../11ty/js/search-navbar.js): the Lunr search page and navbar search. Both are edited in the repository: they stand down for `searchV2`, and their data requests go through `HFYFeatureFlags.dataFetch`.
- [`11ty/_data/flags.json`](../../11ty/_data/flags.json): the build-time flags.
- [`11ty/sw.js`](../../11ty/sw.js): the service worker. Its `hfy-asset-versions` stamp block is rewritten by every islands build.
- [`11ty/manifest.webmanifest`](../../11ty/manifest.webmanifest), [`11ty/offline.html`](../../11ty/offline.html): the PWA manifest, whose colours the islands build writes, and the offline page, which loads no scripts.

Facts:

- The island loader resolves flags from `/_data/flags.json`, fetched with `cache: "no-store"`, plus the `?hfy_flags=` preview override. It then loads islands with `loadIsland`.
- `searchV2` turns on `shellV2` too, unless the override forces `shellV2` off.
- The override lasts for the current tab only. It is kept in `sessionStorage` under `hfy:flags`. `-name` forces a flag off, and an empty `?hfy_flags=` clears the override.
- Earlier builds kept the override in `localStorage`. The script deletes that key on every load.
- While an override is active, the page shows a fixed `preview flags on — turn off` banner (`.hfy-flag-banner`, styled by the theme partial `80-pages.css`). Its button clears the override.
- The override is cleared when a flagged dependency is unavailable: an island bundle fails to load, or `/auth/session` does not answer for `authV2`. The page then falls back to the legacy behaviour.
- `loadIsland(name)` requests `/js/islands/<name>.css?v=` and `/js/islands/<name>.js?v=` with the hashes from the stamp block, or the bare paths when the block is unstamped. It appends the module only after the stylesheet's `load` or `error` event, so an island never mounts unstyled.
- Once the shell island has loaded, the loader links `/manifest.webmanifest?v=` and sets `localStorage` `hfy:shell-hint` to `1`. It sets `0` when `shellV2` is off or the island fails. The early-hint script in head block A reads it, so the shell frame paints before the flags are fetched ([Theme layer, fonts and asset versions](#theme-layer-fonts-and-asset-versions)).
- `auth-v2.js` does nothing while `authV2` is off.
- On `/family-login/` with `authV2` on, `auth-v2.js` sends a signed-out visitor to `/auth/login?returnTo=<next>`. `next` is the page's `?next=` value when it is a same-origin path with one leading `/`, no backslash or control character, at most 2048 characters, and not under `/auth` or `/family-login`; otherwise it is `/`. A visitor already signed in at the edge keeps the legacy page.
- The legacy fallbacks in `person-page.js`, `search-results.js`, `search-navbar.js` and `islands/src/lib/people-corpus.js` send a signed-out visitor to `/family-login/?next=<path+search+hash>`, so with the hand-over above a deep link survives sign-in.
- With `authV2` off, `dataFetch` is exactly `fetch`, and the legacy `X-HFY-Session` requests are unchanged. Those legacy code paths in `feature-flags.js`, `person-page.js` and the search scripts are still deployed.
- With `authV2` on, data requests send the `io_id` cookie (`credentials: "same-origin"`) and no `X-HFY-Session` header. That cookie is what the [private data gate](#private-data-gate) checks.
- `edgeSession()` calls `GET /auth/session` once per page. When the session is near expiry, or signed out in a browser that has held an edge session before, it calls `POST /auth/refresh` once and asks again.
- `dataFetch` refreshes a lapsed session once before the page's first data request. On a 401 from the gate, it refreshes once and retries the request once.
- When recovery fails, an interactive load goes to `/auth/login?returnTo=<path+search+hash>`, unless this tab was sent there in the last 10 minutes. A background load (`{interactive: false}`) never redirects.
- The edge overlay lays an authenticated edge session over the legacy state for `[data-feature]` visibility only. The legacy `auth.js` therefore cannot hide the signed-in navigation after an edge-only sign-in.
- The Lunr scripts stand down only after the search island has mounted (`HFYFeatureFlags.searchV2Live()`). A missing or failed island leaves the legacy search working.
- Only the shell island registers the service worker, at `/sw.js?v=<sha8 of sw.js>` with scope `/` and `updateViaCache: "none"`. The worker names its cache `hfy-shell-<that ?v>`, or `hfy-shell-dev` without a valid `?v`, and deletes every other cache on activate. It loads `/js/islands/notify-sw.js?v=` with `importScripts`.
- Cloudflare keeps static files for up to 4 h under the URL first fetched. To check a deployed script or stylesheet, fetch the versioned URL the page references: read `?v` from the HTML or from `HFYFeatureFlags.assetVersions`. `/_data/flags.json` is JSON, which Cloudflare does not cache.

## React islands

Paths:

- [`islands/src/islands/`](../../islands/src/islands/): one entry per island. The entries are `shell.jsx`, `search.jsx`, `person.jsx`, `my-posts.jsx`, `timeline.jsx`, `posts.jsx` and `notifications.jsx`, plus `search.css` and `notifications.css`.
- [`islands/src/lib/`](../../islands/src/lib/): shared adapters and UI. The files are `api.js`, `cloudscape-theme.js`, `comment-source.js`, `comments-ui.jsx`, `content-source.js`, `mount.jsx`, `people-corpus.js`, `posts-ui.jsx`, `time.js` and `upload.js`. `islands/src/shell.css`, `islands/src/posts.css` and `islands/src/comments.css` sit beside the directory.
- [`islands/build.mjs`](../../islands/build.mjs): the build. It bundles the islands with esbuild and writes the outputs in [Theme layer, fonts and asset versions](#theme-layer-fonts-and-asset-versions).
- [`islands/package.json`](../../islands/package.json): the scripts `build`, `build:islands`, `check:islands`, `test`, `test:contract` and `lint:css`. Every dependency is pinned to an exact version.
- [`islands/playwright.config.mjs`](../../islands/playwright.config.mjs): the configuration of the island specs. See [Tests](#tests).
- [`scripts/ci/build-islands.sh`](../../scripts/ci/build-islands.sh): runs `npm ci` and `npm run build:islands`, then checks that `shell.js` and `shell.css` exist and prints `built islands -> 11ty/js/islands`. The build it runs writes every other output too, although the script checks only those two files.
- [`11ty/js/islands/`](../../11ty/js/islands/): the committed build output.

Facts:

- The usage is `node build.mjs [--site <dir>] [--check]`. The default site is `../11ty`. `--site` builds into a scratch copy of the site, for example for parallel work, and exits `2` when that directory has no `index.html`.
- The build writes only the files that changed, and prunes `js/islands/` and `fonts/` to exactly its outputs. It prints `built <n> files into <site> (<m> written)`.
- For each island it writes `<name>.js` and `<name>.css`. Shared code (React, `@io-kit/*`) is split into `11ty/js/islands/chunks/`, named `chunks/<name>-<hash>.js`. It copies `notify-sw.js` from `@io-kit/notify` into the output.
- The output is committed. The deploy syncs `11ty/` with `--delete` and builds no islands, so a bundle that is not committed is removed from the site at the next deploy.
- After a build, commit `islands/` with every output it touched: `11ty/js/islands`, `11ty/css/hfy-theme.css`, `11ty/css/auth-edge.css`, `11ty/fonts`, the touched pages, `11ty/js/feature-flags.js`, `11ty/sw.js`, `11ty/manifest.webmanifest` and `auth/edge.manifest.json`.
- `npm run check:islands` (`node build.mjs --check`) builds in memory and compares. On a mismatch it exits `1` and prints ``<site> is out of date with islands/ (run `npm run build` and commit):``, then one `missing <path>`, `stale <path>` or `extra <path>` line per problem, `stale auth/edge.manifest.json` included. On success it prints `<site> is up to date (<n> generated files)`, with `<site>` as an absolute path.
- `islands/tests/bundle.test.mjs` runs the same check, and also fails when a build output is gitignored.
- No workflow runs either check, although a comment in `islands/copy.mjs` says CI does.
- The person island (`person.jsx`) and the search corpus (`lib/people-corpus.js`) read family data through `HFYFeatureFlags.dataFetch` when it exists, so they follow the same `authV2` data path as the legacy scripts.
- `createApi` in `lib/api.js` skips an `/api` call when `HFYFeatureFlags.edgeSession()` has answered signed out: it throws `ApiError(401, "unauthenticated")` without sending the request. With `authV2` off, or `/auth/session` unreachable, requests go out as before. The timeline island renders nothing for a signed-out visitor.
- Photos in posts are same-origin `<img src>` elements, so the browser sends `io_id` to a members-only `/uploads/*`. A script that fetches a photo must use `credentials: "same-origin"`.
- Flags:
  - `shell` loads on `shellV2`.
  - `search` loads on `searchV2`, on `/search/`. It mounts `#hfy-search-v2` in the page's own `<main>`.
  - `person` loads on `personV2`, on `/person/?id=…`.
  - Under `postsV2`, `my-posts` loads on `/person/?id=…`, `timeline` on `/`, and `posts` on `/posts/`.
  - `notifications` loads on `notifyV2`, on `/me/notifications/`.
  - `settings` loads on `navMe`, on `/me/`: the settings hub (HFY-TSK-091).
- The shell's navigation registry is `navItems()` in `src/lib/nav.js`, a pure function of the flags `navMe`, `familyViz` and `notifyV2` and the edge session's sub. With `navMe` off it has five items: home, family (`/private/`), search, posts, and me (`/family-login/`, or `/me/notifications/` under `notifyV2`). With `navMe` on (HFY-TSK-091), "me" takes the family tab's own-page route, "family" leaves the bar until `familyViz` gives it `/tree/`, and a gear before the account control opens the `/me/` settings hub. The family tab is "your family": once the edge session names the member, its route becomes their own page, `/person/?id=<sub>` (`src/lib/family-route.js`), and it is marked current on that page only. Signed out, or before the session answers, it stays `/private/`, a redirect page (`HFYFeatureFlags.goToFamily`) that sends a signed-in visitor to their own page and a signed-out one to `/auth/login?returnTo=/private/`. `/person/` without an id does the same. `/family/` cannot be the route: it is a gated data prefix.
- Installing needs `CODEARTIFACT_AUTH_TOKEN` for the `@io-kit/*` packages ([`islands/.npmrc`](../../islands/.npmrc)). The build also needs the dev dependencies, which hold the fonts, so install with `npm ci`, not with `--omit=dev`. `package.json` requires Node 22 or later.
- How to rebuild: [How to build and preview the React islands](../how-to/build-and-preview-the-islands.md).

## Theme layer, fonts and asset versions

Paths:

- [`islands/src/theme/`](../../islands/src/theme/): the theme partials `10-kit-aliases.css`, `20-base.css`, `30-bootstrap.css`, `40-site.css`, `45-person.css`, `60-shell-static.css` and `80-pages.css`.
- [`islands/src/auth-edge/auth-edge.css`](../../islands/src/auth-edge/auth-edge.css): the source of the sign-in stylesheet.
- [`islands/src/lib/cloudscape-theme.js`](../../islands/src/lib/cloudscape-theme.js): the search island's Cloudscape tokens.
- [`islands/heads.mjs`](../../islands/heads.mjs): the render-blocking head blocks, and `PAGES`, the pages that get them.
- [`islands/fonts.mjs`](../../islands/fonts.mjs): the self-hosted faces and their `@font-face` rules.
- [`islands/copy.mjs`](../../islands/copy.mjs): the design system's Voice copy on the Eleventy pages.
- [`islands/assets.mjs`](../../islands/assets.mjs): the `?v=<sha8>` versions and the `hfy-asset-versions` stamp blocks.
- Outputs: [`11ty/css/hfy-theme.css`](../../11ty/css/hfy-theme.css), [`11ty/css/auth-edge.css`](../../11ty/css/auth-edge.css), [`11ty/fonts/`](../../11ty/fonts/), the head blocks, copy and versions in the pages, the stamp blocks in `11ty/js/feature-flags.js` and `11ty/sw.js`, the colours in `11ty/manifest.webmanifest`, and `theme.cssUrl` in [`auth/edge.manifest.json`](../../auth/edge.manifest.json).

Facts:

- Every output is written by `islands/build.mjs`. Never edit one by hand, and commit them with the source change ([React islands](#react-islands)).
- `hfy-theme.css` is built in this cascade order: the `@font-face` rules (the virtual import `hfy:fonts`), the `@io-kit/tokens` harrisonfamily `theme.css`, `bs-bridge.css`, `kit-bridge.css`, every `islands/src/theme/NN-*.css` partial in ascending order, and a generated `@media print` block that puts `:root` in the daylight (`[data-theme="light"]`) theme.
- The Eleventy `css/main.css`, Bootstrap compiled with literal values, is never edited. `hfy-theme.css` is linked right after it, so the theme wins on equal or higher specificity.
- `heads.mjs` writes two marker blocks into 14 pages: the 10 Eleventy pages plus `posts/index.html`, `me/index.html`, `me/notifications/index.html` and `offline.html`. Block A (`<!-- hfy-theme:start A -->`) sits immediately before the `main.css` link. It holds the `color-scheme` meta, a static `theme-color` meta set to the surface token, the shell early-hint script (left out on `offline.html`) and the preload of the UI font. Block B, right after `main.css`, links `/css/hfy-theme.css?v=<sha8>`. A page without `main.css` gets A, then B, after `</title>`.
- The blocks are head markup because `feature-flags.js` runs at the end of `<body>`, where nothing can block rendering. A page that lacks the theme link still gets one from `feature-flags.js`, marked `data-hfy-theme-fallback`.
- A new HTML page must be added to `PAGES`. `islands/tests/theme-delivery.test.mjs` fails when a page is not registered or lacks the blocks.
- `fonts.mjs` copies the faces from exact-pinned devDependencies: `@fontsource-variable/source-sans-3` (the UI face), `@fontsource/libre-caslon-text` (the display serif) and `@fontsource-variable/source-code-pro`. `11ty/fonts/` holds 12 latin and latin-ext `woff2` files named `<base>.<sha256-8>.woff2`, plus three `LICENSE-*.txt` files.
- The site loads no font from a third party. `theme-delivery.test.mjs` fails on a Google Fonts, Typekit, Bunny or Adobe font origin.
- `copy.mjs` rewrites the Voice copy on the 10 Eleventy pages: the home hero and its calls to action, the about and family-login headings, the lowercase page titles (`<title>`, `og:title` and `twitter:title`) and the footer. It matches only the old copy, so it is idempotent and never touches family-written prose. `islands/tests/copy.test.mjs` and `check:islands` fail while a page still carries old copy.
- Some UI copy names a family contact by initial: in `person-page.js`, several islands and `islands/src/lib/` modules, the `copy` block of `auth/edge.manifest.json` and the overrides in `auth/src/edge.js`. Cite the file or manifest key in docs, never the string.
- `assets.mjs` gives every same-origin reference in every `11ty/**/*.html` a `?v=<first 8 hex of the sha256 of the file>`: `<script src>`, `<link rel=stylesheet|manifest|modulepreload>`, and `preload` with `as=script` or `as=style`. An existing `?v` is replaced and other query parameters are kept. Absolute `https://<site>` URLs count as same-origin. The build fails on a reference to a file that does not exist.
- The page walk skips the top-level `js`, `css`, `fonts`, `images`, `media`, `uploads`, `_data`, `family`, `event`, `note` and `place` directories. Fonts and island chunks get no `?v`: their file names already carry a content hash.
- References made at runtime read stamped blocks, between `/* hfy-asset-versions:start ... */` and `/* hfy-asset-versions:end */`. The block in `js/feature-flags.js` holds the island entries' `js` and `css` hashes, the theme, the manifest and `sw.js`. The block in `sw.js` holds the theme, the manifest, the shell's `js` and `css`, and `notify-sw.js`.
- The order is acyclic: the islands, the theme, `notify-sw.js` and the manifest are hashed first, then `sw.js` is stamped, then `feature-flags.js`, then the HTML.
- The versions exist because Cloudflare, in front of CloudFront, keeps static files for 4 h under the URL first fetched, and CloudFront invalidations do not reach it. It does not cache the HTML, so new HTML asks for new URLs.
- `css/auth-edge.css` bundles the fonts, the harrisonfamily theme, the kit bridge and the sign-in rules into one same-origin file with no runtime `@import`. The sign-in pages' CSP `style-src` names `https://<site>`, so the stylesheet must be served from there. When `islands/src/auth-edge/auth-edge.css` is missing, the build skips this output with a warning.
- The build stamps `theme.cssUrl` in `auth/edge.manifest.json` as `https://<site>/css/auth-edge.css?v=<sha8 of the file>`, as a one-line textual edit. It does so only for the repository's own `11ty/`, never for a `--site` copy. The sign-in pages link the new URL only once `hfy-auth-edge` is redeployed. `check:islands` and `scripts/infra/test/run.sh` fail while the stamp is stale.
- The search island's Cloudscape theme is generated at build time from `cloudscape-theme.js` through the import `hfy:cloudscape-theme`, so the island ships a static stylesheet instead of Cloudscape's theming runtime. This stands in until the kit ships a harrisonfamily search theme.
- The build writes the surface token into `manifest.webmanifest` as `background_color` and `theme_color`.
- `10-kit-aliases.css` maps the short variables that `@io-kit/shell`, `@io-kit/content` and `@io-kit/notify` read to `--io-*` tokens. `islands/tests/kit-aliases.test.mjs` re-derives that set from the installed kit CSS, so a kit release that reads a new variable fails it.
- The theme lint, `islands/tests/theme-lint.test.mjs`, runs with `npm run lint:css` and as part of `test:contract` and `npm test`. It covers `islands/src/**/*.css` and the inline styles of the four repo-owned pages, and fails on literal colours, lengths and font names and on `var()` reads of properties other than `--io-*` and `--bs-*`. Only `10-kit-aliases.css` may read the kit's short variables. Every linted file must also parse without esbuild warnings. `HFY_LINT_ONLY=<glob>` narrows the run.
- The Eleventy source emits blocks A and B itself, with a hard-coded theme `?v` and font file name. The islands build overwrites them in the output and stays authoritative.
- Full reference: [Theme and asset build](theme-and-asset-build.md). Why: [The design-system theme layer](../explanation/design-system-theme-layer.md). Changing it: [How to change the theme or the brand fonts](../how-to/change-the-theme-or-brand-fonts.md).

## Family API

Paths:

- [`api/src/`](../../api/src/):
  - `index.js`: Lambda entry and AWS clients. It checks `X-Origin-Verify`, then sends the MCP paths to the MCP mount and every other path to the API handler.
  - `handler.js`: Function URL handler. Its `invoke` runs a route's own handler for a non-HTTP caller, the MCP tools.
  - `routes.js`: route registry, including `MCP_RESOURCE` and the `mcp` member of each route exposed as a tool.
  - `http.js`: HTTP helpers.
  - `auth.js`: session principal and admin list. It resolves the actor's label through `labels.js`.
  - `labels.js`: author labels, shared by the cookie path and the MCP path.
  - `policy.js`: the MCP and UI permission table, the step-up settings and the groups config resolver.
  - `mcp.js`: the MCP mount.
  - `mcp-caps.js`: build-time views of the MCP surface.
  - `origin.js`: the `X-Origin-Verify` check.
  - `content.js`: posts.
  - `comments.js`: comments and reactions.
  - `txn.js`: `transact()` (puts, deletes, updates, checks, token, conflict retry), the counter, merge and size helpers, and audit items.
  - `keys.js`: table key layout.
  - `notify.js`: push notifications and their templates.
  - `uploads.js`: the upload route.
  - `presign.js`: the presigned S3 PUT.
- [`api/scripts/gen-caps.mjs`](../../api/scripts/gen-caps.mjs): writes `api/dist/caps.json` from `routes.js`, `api/dist/policy.json` from `policy.js`, and `api/dist/mcp/tools.json` and `api/dist/mcp/parity-caps.json` from `mcp-caps.js`.
- [`api/parity/`](../../api/parity/): the parity files of the MCP surface. See [MCP server](#mcp-server).
- [`api/README.md`](../../api/README.md): a short pointer to the [API reference](api.md).
- [`scripts/ci/package-api.sh`](../../scripts/ci/package-api.sh): builds `dist/hfy-api.zip`.

Facts:

- Lambda `hfy-api` (`nodejs22.x`) uses the single DynamoDB table `hfy-app`. Behind CloudFront it serves:
  - `/api/*`, once [`add-api-behavior.sh`](../../scripts/infra/add-api-behavior.sh) has run;
  - `/mcp*` and the protected resource metadata (PRM) at `/.well-known/oauth-protected-resource*`, once [`add-mcp-behavior.sh`](../../scripts/infra/add-mcp-behavior.sh) has run.
- Requests without the `X-Origin-Verify` header that CloudFront injects are rejected before routing, on every path.
- Every `/api` route needs the auth-edge session cookie (`io_id`), which the API verifies against the edge's public JWKS. The MCP paths never read that cookie: they are bearer-gated. See [MCP server](#mcp-server).
- Admins are the gramps IDs listed in `config/admins.json` in `<config-bucket>`. The list fails closed: when the file is absent or unreadable, nobody is an admin, so posts and comments have no moderators.
- An author label is never an email address. It is the session's `name` when that is a usable label without `@`, else the person's `displayName` from `person/<gramps-id>.json` in `<site-bucket>`, else the gramps ID. The role may read `person/*` in that bucket for this lookup only. Labels are cached per container.
- `POST /api/uploads` returns a presigned S3 PUT for a key under `uploads/posts/<ulid>/` in the site bucket. The content type is signed, so S3 rejects a PUT with a different `Content-Type`.
- The browser PUTs to the bucket's S3 endpoint, not through CloudFront, so a members-only `/uploads/*` never sees an upload (`api/test/presign.test.js`). Reading a photo back goes through CloudFront's `/uploads/*` behavior: see [Infrastructure](#infrastructure).
- Push notifications are sent only when the stack parameter `VapidSecretName` names a VAPID secret. The live secret is `harrisonfamily/api/vapid`, a JSON `{subject, publicKey, privateKey}` whose `subject` is an `https://` URL, so no email address goes to the push services. Without the secret, subscriptions and preferences are stored but nothing is sent. See [How to turn on push notifications](../how-to/turn-on-push-notifications.md).
- The push templates in `notify.js` (`TEMPLATE_REGISTRY`) and the lock-screen preview on `/me/notifications/` (`CATALOG` in `islands/src/islands/notifications.jsx`) carry the same text. They are kept in step by hand; no test compares them.
- `api/dist/` is gitignored.
- `package-api.sh` needs `CODEARTIFACT_AUTH_TOKEN`. It runs `gen-caps.mjs` inside its staging copy, so the zip holds all four generated documents. Only `caps.json` is copied back to `api/dist/`.
- `api/` and `auth/` pin the same `@io-kit/auth` version, 2.2.0.
- No workflow deploys `hfy-api`. It ships by hand through the app stack: see [Infrastructure](#infrastructure).

## MCP server

Paths:

- [`api/src/mcp.js`](../../api/src/mcp.js): the mount. `@io-kit/mcp/edge` checks the bearer token and serves the PRM. `@io-kit/mcp/core` serves `tools/list` and `tools/call` over a registry derived from the route registry. The file also builds the actor that each tool call runs as.
- [`api/src/policy.js`](../../api/src/policy.js): the permission table (`POLICY_ROWS`), the step-up settings and the resolver for the groups config. Its header comment gives the shape of `config/groups.json`.
- [`api/src/labels.js`](../../api/src/labels.js): the author label, resolved the same way as on the cookie path.
- [`api/src/mcp-caps.js`](../../api/src/mcp-caps.js): build-time views of the surface: `tools/list` for a principal in every group, and the `@io-kit/parity` caps document.
- [`api/src/routes.js`](../../api/src/routes.js): `MCP_RESOURCE`, and each tool's name, input schema and argument mapping.
- [`api/parity/`](../../api/parity/): `map.yaml` maps each MCP tool to the route handler a person uses for the same action, and `routes.yaml` is the UI route manifest.
- [`scripts/ci/mcp-conformance.sh`](../../scripts/ci/mcp-conformance.sh): the conformance gate.
- [`infrastructure/mcp-edge401.us-east-1.yaml`](../../infrastructure/mcp-edge401.us-east-1.yaml): the us-east-1 stack `hfy-mcp-edge401`. Its Lambda@Edge origin-response function restores `WWW-Authenticate` on a 401, which a Function URL remaps.
- [`scripts/infra/add-mcp-behavior.sh`](../../scripts/infra/add-mcp-behavior.sh): the CloudFront behaviors.
- [`scripts/mcp/token-smoke.sh`](../../scripts/mcp/token-smoke.sh): a live token check. See [Tests](#tests).

Facts:

- The MCP server runs inside `hfy-api` at `https://<site>/mcp`, a path rather than a subdomain.
- `index.js` sends `/mcp`, `/mcp/*`, `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/*` to the mount, after the `X-Origin-Verify` check.
- The bearer is an access token from the auth edge's OAuth server. It is verified as RS256 against the edge's JWKS, with a pinned issuer and a client ID binding, and its `aud` must be the resource URL.
- There are seven tools, one for each route with an `mcp` member: `hfy_comments_list`, `hfy_comments_create`, `hfy_comments_delete`, `hfy_posts_list`, `hfy_posts_get`, `hfy_posts_create` and `hfy_posts_delete`.
- A tool call runs its route's own handler through `handler.invoke`, so the API's validation, permissions, audit and notifications apply to it.
- Authorization comes from the groups config, `config/groups.json` in `<config-bucket>`, never from the token's `groups` claim. The config defines two groups, `mcp-authors` and `hfy-admin`. A missing or unreadable config grants nothing.
- The delete tools need `hfy-admin` and a fresh step-up: an `amr` claim that includes `mfa`, and an `auth_time` within the last 300 seconds.
- `gen-caps.mjs` publishes the permission table as `api/dist/policy.json`, for the UI to read, and the tool list as `api/dist/mcp/tools.json` and `api/dist/mcp/parity-caps.json`.
- `mcp-conformance.sh` needs `CODEARTIFACT_AUTH_TOKEN`. It regenerates the documents and runs the `mcp-conformance`, `mcp` and `mcp-infra` suites. It then runs `io-kit parity diff` over the parity files and the generated tool documents, in `blocking` mode unless given `report-only`.
- No workflow runs `mcp-conformance.sh`.
- The 401-restore function's code is inline in its template. The version's `Description` carries a hash of that code, and `test_mcp_edge401_stack.py` fails when the two disagree. After the stack publishes a new version, rerun `add-mcp-behavior.sh`.
- `add-mcp-behavior.sh` reads the `hfy-api` Function URL from the app stack, so pass `--stack <app-stack>`.
- Full reference: [MCP server](mcp-server.md). Connecting a client: [How to connect an MCP client and run an admin delete](../how-to/connect-an-mcp-client.md).

## Auth edge and MCP authorization server

Paths:

- [`auth/src/`](../../auth/src/):
  - `index.js`: Lambda entry, which wires the manifest, signing key, Cognito, passkeys and stores.
  - `edge.js`: the `/auth/*` mount over `@io-kit/auth`, plus `/auth/.well-known/jwks.json`, `/auth/session` and `/auth/passkeys`, which redirects to the account page `/auth/link`. It also holds the HTML overrides that `adapt()` applies to the kit's pages.
  - `oauth.js`: the OAuth 2.1 server for MCP clients: metadata, `authorize`, `token`, `register`, `revoke` and `userinfo`.
  - `membership.js`: the allowlist and admin groups for MCP tokens.
  - `cognito.js`: Cognito user provisioning for `POST /auth/link`.
  - `linkstore.js`: the account-link store.
  - `passkeystore.js`: the passkey credential store.
  - `ratelimit.js`: request counters.
  - `origin.js`: the `X-Origin-Verify` check.
- [`auth/edge.manifest.json`](../../auth/edge.manifest.json): the edge manifest. Its providers are `google`, `password` and `passkey`. Its `theme` names the sign-in stylesheet and the font origins, and its `copy` block holds the family-voice text of the sign-in, password, passkey, denied, forgot, reset, verify and account pages.
- [`auth/e2e/passkey.e2e.mjs`](../../auth/e2e/passkey.e2e.mjs) and [`auth/e2e/signin-theme.e2e.mjs`](../../auth/e2e/signin-theme.e2e.mjs): end-to-end tests. See [Tests](#tests).
- [`scripts/ci/package-auth.sh`](../../scripts/ci/package-auth.sh): builds `dist/hfy-auth-edge.zip`, `edge.manifest.json` included.

Facts:

- Lambda `hfy-auth-edge` (`nodejs22.x`) runs behind CloudFront. It serves `/auth/*` and the root discovery path `/.well-known/oauth-authorization-server*`.
- Members sign in with Google, with a Cognito email and password, or with a passkey. The session is an RS256 cookie, and only the edge holds the signing key.
- The kit's account page, `/auth/link`, lists and removes a member's own passkeys. Passkey sign-in asks for user verification as `preferred`, and the `amr` claim includes `mfa` only when the authenticator verified the user.
- `GET /auth/session` reports `exp`, the expiry of the `io_id` cookie. A page uses it to call the kit's `POST /auth/refresh`, which re-sets `io_id` from the `io_rt` refresh cookie, before the session lapses.
- The manifest is committed with placeholders for the Cognito user pool ID, the Cognito client ID and the Google client ID. `edge.js` fills them from the Lambda environment and fails if one is missing.
- `theme.cssUrl` is `https://<site>/css/auth-edge.css?v=<sha8>`, which the islands build stamps ([Theme layer, fonts and asset versions](#theme-layer-fonts-and-asset-versions)), and `theme.fontOrigins` is `["self"]`. `@io-kit/auth` 2.2.0 turns `fontOrigins` into the CSP `font-src`, and puts the stylesheet's origin, never its path or query, in `style-src`, so the `?v` passes. The kit also sends `Referrer-Policy: strict-origin-when-cross-origin`, as a header and a meta tag, which Google sign-in needs on `/auth/login`.
- `adapt()` in `edge.js` applies HFY overrides to the kit's HTML, each with its kit root cause recorded inline: `cspWithFontSrc`, `gisButtonDark`, `gisFocusRing`, `allowlistNotice`, `deniedNotice`, `kitVoice` and `backToSite`. Its `Location` rewrite also mounts the `returnTo` of the kit's signed-out `/link` redirect under `/auth`.
- A change under `auth/src`, or to `auth/edge.manifest.json` (the `cssUrl` stamp included), reaches production only when `hfy-auth-edge` is redeployed. So does a change to `11ty/css/auth-edge.css`, because it changes the stamp.
- The user pool allows only admin-created users. `cognito.js` creates a user only on `POST /auth/link`, after the allowlist check.
- `linkstore.js` writes `GSI1SK` on every `LINK#` item, and `passkeystore.js` on every `PASSKEY#` credential item, so both are found through `GSI1`. Both repair older items when they read them.
- `ratelimit.js` limits `POST /auth/password/forgot` with fixed-window counters in `hfy-app`.
- The OAuth routes are on only when `MCP_REDIRECT_URIS` is set.
- Access tokens carry `email`, `amr`, `auth_time` and `name`. A refresh grant keeps the original `auth_time`.
- `/auth/authorize` honours `max_age` and `prompt=login` by asking for a fresh sign-in. The MCP step-up relies on this.
- `auth/src/origin.js` is byte-identical to `api/src/origin.js`.
- No workflow deploys `hfy-auth-edge`. It ships by hand through the app stack: see [Infrastructure](#infrastructure).

## Private data gate

Paths:

- [`edge-gate/src/gate.mjs`](../../edge-gate/src/gate.mjs): the viewer-request gate. It has no dependencies beyond `node:crypto`.
- [`edge-gate/src/index.mjs`](../../edge-gate/src/index.mjs): the Lambda@Edge entry. It reads `config.json`, which the package script bakes into the zip.
- [`edge-gate/gate.config.json`](../../edge-gate/gate.config.json): the issuer, audience, JWKS URL, cookie name, sign-in path and timing settings.
- [`edge-gate/test/gate.test.mjs`](../../edge-gate/test/gate.test.mjs): the gate's tests. See [Tests](#tests).
- [`infrastructure/cloudformation/edge-gate-stack.yaml`](../../infrastructure/cloudformation/edge-gate-stack.yaml): the us-east-1 stack `hfy-edge-gate`, with the function, its role and a retained version. Its output `EdgeGateVersionArn` is the version to attach.
- [`scripts/ci/package-edge-gate.sh`](../../scripts/ci/package-edge-gate.sh): builds `dist/hfy-edge-gate.zip`.
- [`scripts/infra/add-data-gate-behaviors.sh`](../../scripts/infra/add-data-gate-behaviors.sh): attaches the gate to the data paths and `/uploads/*`, or detaches it with `--remove`.
- [`scripts/cloudfront/append-index.js`](../../scripts/cloudfront/append-index.js): the default-deny for spellings of the data paths that no gated behavior matches. See [CloudFront Function](#cloudfront-function).
- The client data path:
  - [`11ty/js/feature-flags.js`](../../11ty/js/feature-flags.js): `dataFetchInit`, `dataFetch` and `edgeSession` (see [Front-end runtime](#front-end-runtime)).
  - [`11ty/js/person-page.js`](../../11ty/js/person-page.js), [`11ty/js/search-navbar.js`](../../11ty/js/search-navbar.js), [`11ty/js/search-results.js`](../../11ty/js/search-results.js): the legacy callers.
  - [`islands/src/islands/person.jsx`](../../islands/src/islands/person.jsx), [`islands/src/lib/people-corpus.js`](../../islands/src/lib/people-corpus.js): the island callers.

Facts:

- The gate's code checks no path. Which paths it guards is set by the behaviors that carry it: `/person/*.json`, `/family/*`, `/event/*`, `/note/*`, `/place/*`, `/media/*` and `/uploads/*`. `/person/` itself is the public person-page shell and is not gated.
- It verifies the `io_id` session cookie: the RS256 signature against the auth edge's JWKS, the issuer, the audience, and `exp` and `nbf` with a clock skew.
- A request with a valid cookie passes unchanged. Otherwise a fetch, XHR or subresource request gets a 401, and a top-level navigation gets a 302 to `/auth/login?returnTo=<path>`. Any error is a deny.
- Every response the gate generates carries `Cache-Control: private, no-store`. Allowed responses get the same header from a response headers policy: `hfy-private-no-store` on the six data behaviors, and `hfy-uploads-private` on `/uploads/*`. Cloudflare proxies the site in front of CloudFront, and these headers stop it, and browsers, from storing family data or member photos.
- Lambda@Edge has no environment variables, so `package-edge-gate.sh` copies `gate.config.json` into the zip as `config.json`.
- The zip is reproducible. The script prints the stack parameters `CodeKey` and `CodeSha256` and writes them to `dist/hfy-edge-gate.params`. `CodeKey` is content-addressed: `lambda/hfy-edge-gate-<first 16 hex digits of the zip's SHA-256>.zip`.
- The stack reads the code from `<edge-code-bucket>` and has no default key. A code change is therefore always a new key, so the stack updates the function and publishes a new numbered version.
- The gate is not behind a flag. It takes effect when `add-data-gate-behaviors.sh` attaches it.
- Once the gate is attached, visitors without `authV2` cannot read the family data. `authV2` is therefore turned on first and the gate attached after it. The production cutover ran in that order on 2026-10-12 (HFY-TSK-069, HFY-R67). See [How to cut over to authV2 and the private data gate, and roll back](../how-to/cut-over-to-the-private-data-gate.md), and for the reasoning, [The gate is a third switch, and the order matters](../explanation/release-model.md#the-gate-is-a-third-switch-and-the-order-matters).
- While the gate is attached, an automatic rollback or a revert that restores a `flags.json` with `authV2` false, or any change that sets `authV2` false, locks visitors out of the family data: the legacy client can neither get nor refresh the `io_id` cookie that the gate checks. Remove the gate first: `add-data-gate-behaviors.sh --remove --app-stack <app-stack>`, with `us-west-2` as the CLI's region, or with `--restore-uploads-policy-id`. For what `--remove` changes, see [Infrastructure](#infrastructure); for what the data paths answer afterwards, see [CloudFront Function](#cloudfront-function).
- No workflow builds, deploys or attaches the gate. Building, validating and deploying it: [How to deploy and update the Lambda@Edge functions in us-east-1](../how-to/deploy-the-edge-functions.md). Why it exists: [Gating the JSON](../explanation/family-data-privacy.md#gating-the-json).

## CloudFront Function

Paths:

- [`scripts/cloudfront/append-index.js`](../../scripts/cloudfront/append-index.js): `HFYAppendIndex`, the viewer-request function of the default cache behavior.
- [`scripts/cloudfront/test/append-index.test.mjs`](../../scripts/cloudfront/test/append-index.test.mjs) and [`append-index.cases.json`](../../scripts/cloudfront/test/append-index.cases.json): its tests and their shared case table. See [Tests](#tests).
- [`scripts/infra/publish-append-index.sh`](../../scripts/infra/publish-append-index.sh): publishes a change to the function.

Facts:

- The runtime is `cloudfront-js-1.0`, so the code is ES5.1 only and at most 10 KB.
- It keeps the clean-URL rewrite: a URI ending in `/` gets `index.html` appended, and a URI with no `.` gets `/index.html` appended.
- On the rewritten URI it then denies by default. When the first path segment is `family`, `event`, `note`, `place`, `media` or `uploads` (`DENY_FIRST_SEGMENTS`), it answers `404 Not Found` with `cache-control: private, no-store` and never reaches S3. Under `person/`, only the public shell `/person/index.html` passes (`PUBLIC_PERSON_FILES`, reached from `/person/` and `/person`), and any `.json` is denied.
- Before matching, the URI is percent-decoded up to four rounds and lowercased. Backslashes become `/`, `;params` are stripped, dot segments are resolved, and trailing dots and spaces are trimmed.
- CloudFront path patterns are case-sensitive, and `/person/*.json` is anchored on its suffix. Spellings such as `/Person/index.json` or `/person/<gramps-id>.JSON` match no gated behavior and fall through to the default behavior, where this function now denies them. A real request for gated data matches its exact gated pattern first and never reaches the function, while the gated behaviors exist.
- When the six data behaviors are gone, for example after `add-data-gate-behaviors.sh --remove`, the data paths themselves reach the default behavior, unless another behavior matches them. This version then answers `404` for them, so the family data is unreachable rather than public until the function's previous code is published again. `/uploads/*` keeps its own behavior and is not affected.
- The function may only be associated with the default behavior. On any other behavior it would answer `404` for the gated data itself.
- A test pins `DENY_FIRST_SEGMENTS` to the non-person patterns of `add-data-gate-behaviors.sh`, and `PUBLIC_PERSON_FILES` to the files in `11ty/person/`. A new public file under `11ty/person/` must be added to `PUBLIC_PERSON_FILES`.
- `publish-append-index.sh [--dry-run] [--name HFYAppendIndex] [--source FILE] [--distribution <distribution-id>|none] [--cases FILE] [--all-cases] [--comment TEXT]` runs the local unit tests, reads the `DEVELOPMENT` and `LIVE` stages and prints each one's diff against the repository file. It never creates the function.
- It exits `2` on a missing or empty source or case file, a source over 10 KB, no `handler()` or a comment over 128 characters. It exits `1` on a runtime other than `cloudfront-js-1.0`, a function that does not exist, an unreadable distribution or a failing test, and `3` when the function is associated with any non-default behavior. `--distribution none` skips the association check.
- When `LIVE` already runs the repository code it prints `function HFYAppendIndex already runs the repo code on LIVE: no change`. `--dry-run` prints the plan and `(dry-run) no changes made`.
- A real run saves the previous `LIVE` code, and a differing `DEVELOPMENT` draft, under `${HFY_CF_BACKUP_DIR:-~/.local/state/hfy-infra/cloudfront}` with mode 600. It runs `update-function`, unless `DEVELOPMENT` already holds the code, then `test-function` on `DEVELOPMENT` with the `awsSamples` cases (`--all-cases` runs every case), and refuses to publish on any failure, leaving `LIVE` untouched. It then runs `publish-function`, reads `LIVE` back and prints the rollback commands. No `update-distribution` is needed, because the association holds the function ARN.
- The script's `--distribution` default, and the header comment of `append-index.js`, hold the production distribution ID. Docs use `<distribution-id>`.
- It is not a pipeline target: `ci.manifest.yaml` declares no `cloudfront_function` target, and the deploy role cannot update functions. Publishing needs operator credentials for `cloudfront:DescribeFunction`, `GetFunction`, `UpdateFunction`, `TestFunction`, `PublishFunction` and `GetDistributionConfig`.
- The repository does not record which code `LIVE` runs. `publish-append-index.sh --dry-run` shows it as a diff against the repository file.
- How to publish: [How to publish the CloudFront Function](../how-to/publish-the-cloudfront-function.md). The first creation and association are part of [How to stand up the static site and its deploy access](../how-to/stand-up-the-static-site.md).

## Legacy sign-in

Paths:

- [`lambda/hfy-check-allowed/index.mjs`](../../lambda/hfy-check-allowed/index.mjs): the `hfy-check-allowed` Lambda.
- [`functions/get-allowlist/`](../../functions/get-allowlist/): the `getAllowlist` Google Cloud Function. This is the deployed copy.
- [`gcloud/allowlist-fn/`](../../gcloud/allowlist-fn/): a byte-identical sample copy.

Facts:

- `hfy-check-allowed` verifies a Google ID token and checks an HMAC of the email against the hashed allowlist. It looks the email up in the email-to-gramps_id map and returns a session token.
- `11ty/js/auth.js` calls it at `/api/check-allowed`. `add-api-behavior.sh` pins `/api/check-allowed*` to the origin that serves it, ahead of the new `/api/*` behavior.
- With `authV2` on, `auth-v2.js` sends a signed-out visitor on `/family-login/` to `/auth/login`, so a signed-out visitor gets the legacy Google sign-in on that page only with `authV2` off, for example in a tab with `?hfy_flags=-authV2`, or when `/auth/session` does not answer.
- The legacy pieces are still deployed, and every push to `main` ships them again: `io-kit-deploy.yml` deploys `hfy-check-allowed` (`scripts/ci/package-lambda.sh` builds its zip), the `/api/check-allowed*` pin stays in the distribution, and `deploy-gcf-legacy.yml` deploys `getAllowlist`. The `X-HFY-Session` code paths stay in the front end ([Front-end runtime](#front-end-runtime)).
- `getAllowlist` returns the allowlist from Google Secret Manager.
- [`deploy-gcf-legacy.yml`](../../.github/workflows/deploy-gcf-legacy.yml) deploys `getAllowlist` from `functions/get-allowlist/` on push to `main`. Its header comment marks it "retired by HFY-TSK-062", but its triggers are active.
- The pre-commit sync check compares two directories with their workspace sources when files under them are staged:
  - `lambda/hfy-check-allowed/` with `<project>/scripts/auth/check-allowed-lambda/`, excluding `node_modules/`.
  - `functions/get-allowlist/` with `<project>/workspace/gcloud/allowlist-fn/`.

## Infrastructure

Paths:

- [`infrastructure/cloudformation/app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml) defines:
  - the `hfy-app` table;
  - `hfy-api` and `hfy-auth-edge`, with their Function URLs, roles and log groups;
  - the Cognito user pool and client;
  - `UploadsResponseHeadersPolicy`.
- [`infrastructure/cloudformation/edge-gate-stack.yaml`](../../infrastructure/cloudformation/edge-gate-stack.yaml): the us-east-1 gate stack. See [Private data gate](#private-data-gate).
- [`infrastructure/mcp-edge401.us-east-1.yaml`](../../infrastructure/mcp-edge401.us-east-1.yaml): the us-east-1 stack for the MCP 401-restore function. It sits in `infrastructure/`, not `infrastructure/cloudformation/`. See [MCP server](#mcp-server).
- [`infrastructure/cloudformation/github-roles.yaml`](../../infrastructure/cloudformation/github-roles.yaml): the OIDC role that GitHub Actions assumes.
- [`infrastructure/cloudformation/media-bucket-cors.json`](../../infrastructure/cloudformation/media-bucket-cors.json): the site bucket's CORS for browser uploads.
- [`scripts/infra/`](../../scripts/infra/):
  - `create-session-key.sh`: the session signing key.
  - `create-origin-verify.sh`: the origin-verify secret.
  - `add-api-behavior.sh`, `add-auth-behavior.sh`, `add-uploads-behavior.sh`, `add-mcp-behavior.sh`, `add-data-gate-behaviors.sh`: CloudFront origins and behaviors.
  - `publish-append-index.sh`: the CloudFront Function. See [CloudFront Function](#cloudfront-function).
- [`scripts/infra/lib/`](../../scripts/infra/lib/): the behavior scripts share both files, and `publish-append-index.sh` uses `cf-common.sh`.
  - `cf-common.sh`: the fetch, compare and apply plumbing; `UPLOADS_CSP`, the uploads Content-Security-Policy string; and `cf_response_headers_policy`, which finds a custom response headers policy by name and creates it, or puts it back, when it does not force the wanted headers.
  - `cf.jq`: the config transforms, including the placement ahead of shadowing behaviors, the removal of the gate behaviors (`remove_gate_behaviors`), the `/uploads/*` checks and restore (`behavior_gated`, `ungate_behavior`) and the policy checks (`rhp_forces_cache_control`, `rhp_uploads_private`).
- [`cloudfront/distribution.json`](../../cloudfront/distribution.json): a sanitized sample distribution in the pre-app layout. [`cloudfront/README.md`](../../cloudfront/README.md) is a short pointer into these docs.

Facts:

- The app stack does not manage the site bucket. Its CORS is applied by hand.
- `UploadsResponseHeadersPolicy` sets `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox; default-src 'none'; img-src 'self'`. The stack exports its ID as `UploadsResponseHeadersPolicyId`. It is the policy of the public, ungated `/uploads/*`.
- The live app stack is `<app-stack>`, not `hfy-app`. `add-api-behavior.sh`, `add-auth-behavior.sh`, `add-uploads-behavior.sh` and `add-mcp-behavior.sh` read its outputs through `--stack`, whose default is `hfy-app`, so pass `--stack <app-stack>` on every run.
- In `add-data-gate-behaviors.sh`, `--stack` names the us-east-1 gate stack instead. Its default, `hfy-edge-gate`, is the deployed name, so never pass `--stack <app-stack>` to it. That script names the app stack with `--app-stack` (default `hfy-app`), which only `--remove` reads.
- The app stack reads the Lambda code from `<code-bucket>` at the keys in `CodeKey` and `AuthCodeKey`. Their defaults are `lambda/hfy-api.zip` and `lambda/hfy-auth-edge.zip`.
- Deploys upload commit-named zips, `lambda/hfy-api-<sha>.zip` and `lambda/hfy-auth-edge-<sha>.zip`, and apply them through a CloudFormation change set: see [How to deploy the app stack and its CloudFront behaviors](../how-to/deploy-the-app-stack.md).
- Lambda@Edge functions must live in us-east-1, so the gate and the MCP 401-restore function have their own stacks there, `hfy-edge-gate` and `hfy-mcp-edge401`. Both are deployed by hand: see [How to deploy and update the Lambda@Edge functions in us-east-1](../how-to/deploy-the-edge-functions.md).
- Each edge stack publishes a new numbered version only when its version resource changes: the gate's through `CodeSha256`, the 401-restore function's through the code hash in its `Description`. Old versions are retained, because CloudFront replicas pin them.
- `github-roles.yaml` is deployed once by hand.
- The deploy role denies `s3:PutObject` and `s3:DeleteObject` under `uploads/*` in the site bucket.
- The deploy role's Lambda permissions cover `hfy-check-allowed`, `hfy-api` and `hfy-auth-edge` in us-west-2. Its only CloudFront permissions are invalidations on the site's distribution.
- The deploy role has no permission on `hfy-edge-gate`, `hfy-mcp-edge401`, any CloudFormation stack or any CloudFront Function, so CI can deploy neither edge stack nor `HFYAppendIndex`.
- `add-auth-behavior.sh` adds the `hfy-auth-edge` origin and two behaviors, `/auth/*` and `/.well-known/oauth-authorization-server*`.
- `add-api-behavior.sh` adds the `hfy-api` origin and the `/api/*` behavior. Before `/api/*`, it pins a `/api/check-allowed*` behavior, cloned from the one that serves `/api/check-allowed` now. This keeps the legacy sign-in from being shadowed.
- It exits with status 3 when it cannot find that origin and no pin exists, unless `--legacy-origin` names the origin.
- `add-uploads-behavior.sh` adds a GET and HEAD `/uploads/*` behavior on the default behavior's S3 origin, with CachingOptimized and the stack's uploads policy: the public state.
- When `/uploads/*` already carries the gate's association, `add-uploads-behavior.sh` leaves it as it is, prints `/uploads/* is members-only (hfy-edge-gate association, add-data-gate-behaviors.sh): left as it is. add-data-gate-behaviors.sh --remove ungates it.` and then `no change`. `--gate-function-name` (default `hfy-edge-gate`) names the function it looks for.
- `add-mcp-behavior.sh` adds `/mcp*` and `/.well-known/oauth-protected-resource*` on the `hfy-api` origin. Each carries the `hfy-mcp-edge401` version as its origin-response function, taken from `--edge401-arn`, `$EDGE401_ARN` or the `hfy-mcp-edge401` stack's output.
- `add-mcp-behavior.sh` exits with status 3 when an earlier behavior already matches one of the MCP paths.
- `add-data-gate-behaviors.sh` gates seven patterns. It creates the six data behaviors on the site's S3 origin, the default behavior's origin unless `--origin-id` names another. Each gets the gate version as its viewer-request function, `CachingDisabled` and the `hfy-private-no-store` response headers policy.
- It never re-creates `/uploads/*`. It updates the existing behavior in place, keeping its position and origin, and gives it the gate association, `CachingDisabled` and the `hfy-uploads-private` policy. When no `/uploads/*` behavior exists, it creates one already gated.
- It finds, creates or repairs both policies by name. `hfy-private-no-store` forces `Cache-Control: private, no-store`. `hfy-uploads-private` forces the same header plus `X-Content-Type-Options: nosniff` and the `UPLOADS_CSP` Content-Security-Policy, the same string as the app stack's policy, which `test_app_stack.py` checks. `--response-headers-policy-id` and `--uploads-response-headers-policy-id` skip a lookup; `--response-headers-policy-name` and `--uploads-response-headers-policy-name` change a name.
- It places a gated pattern just ahead of any broader behavior that would shadow it, and refuses an unqualified or `$LATEST` function ARN.
- `--remove` deletes exactly the six data behaviors that carry the gate's association, and puts `/uploads/*` back in place, never deleting it: no association, CachingOptimized and the public uploads policy. Both custom policies stay in the account, unused.
- The policy `--remove` restores comes from `--restore-uploads-policy-id`, or else from the `UploadsResponseHeadersPolicyId` output of the `--app-stack` stack, read in the CLI's default region. So while `/uploads/*` is gated, every production `--remove`, `--remove --dry-run` included, passes `--app-stack <app-stack>` with `us-west-2` as the CLI's region, or `--restore-uploads-policy-id`. Without either it exits `1`, prints `pass --restore-uploads-policy-id ID to name the response headers policy /uploads/* gets back` and changes nothing. An offline `--config-file` dry run uses the placeholder `<hfy-app UploadsResponseHeadersPolicyId>`.
- The `scripts/infra/` scripts are idempotent, accept `--dry-run`, and never print secret values.
- The behavior scripts skip `update-distribution` when nothing would change. Before a real update, they save the pre-change config outside the repository.
- `distribution.json` shows the pre-app layout: an S3 origin, plus an API Gateway origin that serves `/api/*`. It shows none of the behaviors that the behavior scripts add, so a gate dry run against it creates all seven gated behaviors, `/uploads/*` included.
- The comments in `app-stack.yaml` (`UploadsResponseHeadersPolicy`) and `media-bucket-cors.json` describe both `/uploads/*` states and the direct PUT to S3.

## CI and repo operations

Paths:

- [`ci.manifest.yaml`](../../ci.manifest.yaml): the pipeline definition.
- [`.github/workflows/io-kit-ci.yml`](../../.github/workflows/io-kit-ci.yml), [`.github/workflows/io-kit-deploy.yml`](../../.github/workflows/io-kit-deploy.yml): rendered from `ci.manifest.yaml` by `@io-kit/ci` 0.1.3. Each carries a "do not edit" header.
- [`.github/actions/io-kit-ci/`](../../.github/actions/io-kit-ci/): the composite actions those workflows call. They are `build`, `package`, `deploy-static`, `deploy-lambda`, `invalidate`, `smoke`, `rollback`, `parity-report` and `secret-scan`.
- [`.github/workflows/deploy-gcf-legacy.yml`](../../.github/workflows/deploy-gcf-legacy.yml): the `getAllowlist` deploy.
- [`scripts/ci/`](../../scripts/ci/):
  - `patch-client-id.sh` and `package-lambda.sh` are the manifest build command.
  - `build-islands.sh`, `package-api.sh`, `package-auth.sh` and `package-edge-gate.sh` are local build scripts.
  - `mcp-conformance.sh` is the MCP conformance gate. See [MCP server](#mcp-server).
- [`scripts/git-hooks/pre-commit`](../../scripts/git-hooks/pre-commit): the pre-commit hook.
- Workspace helpers: [`scripts/check-deployment-sync.sh`](../../scripts/check-deployment-sync.sh), [`scripts/promote_workspace_assets.sh`](../../scripts/promote_workspace_assets.sh), [`scripts/sync_sanitized_assets.py`](../../scripts/sync_sanitized_assets.py), [`scripts/validate_build.sh`](../../scripts/validate_build.sh).

Facts:

- `io-kit-ci.yml` runs on pull requests and on manual dispatch. It runs the build, a parity report in report mode, and a TruffleHog scan.
- `io-kit-deploy.yml` runs on push to `main` and on manual dispatch. Its jobs run in this order: build, package, deploy, invalidate, smoke, then rollback if the smoke check fails.
- The build job runs `patch-client-id.sh`, then `package-lambda.sh`, on Node 20. The package job uploads `11ty/` and `dist/hfy-check-allowed.zip` as the artifact `io-kit-release-<sha>`.
- The deploy job runs one `aws s3 sync 11ty/ s3://<site-bucket>/ --delete` and then updates the `hfy-check-allowed` code. The sync has no HTML-last ordering, so a page can go live a moment before a file it references by a new `?v`.
- The sync excludes `person/*.json`, `media/*`, `family/*`, `event/*`, `note/*`, `place/*` and `uploads/*`, and never deletes the excluded paths.
- The invalidation covers `/*`, and the job waits for it to complete. Until it does, CloudFront can serve the old object for a new `?v`, because the default behavior's cache policy (CachingOptimized in the sample) leaves the query string out of the cache key.
- The smoke job requests the home page and `/family-login/`. Any status outside 2xx and 3xx fails it.
- The rollback strategy is `previous_artifact`. It redeploys the artifact of the last successful `io-kit-deploy.yml` run on the branch. That artifact's `flags.json` comes with it; see [Private data gate](#private-data-gate) for why that matters while the gate is attached.
- The pipeline builds no islands, and deploys none of `hfy-api`, `hfy-auth-edge`, `hfy-edge-gate`, `hfy-mcp-edge401` and `HFYAppendIndex`. `ci.manifest.yaml` has no target for any of them.
- `build-islands.sh`, `package-api.sh`, `package-auth.sh`, `package-edge-gate.sh`, `mcp-conformance.sh` and `publish-append-index.sh` are not run by any workflow.
- `deploy-gcf-legacy.yml` deploys `getAllowlist` on push to `main`. See [Legacy sign-in](#legacy-sign-in).
- The pre-commit hook runs `check-deployment-sync.sh`, then a `trufflehog` filesystem scan. It fails when `trufflehog` is not installed.
- The hook runs only when `core.hooksPath` is `scripts/git-hooks`.
- The workspace helpers treat the checkout's parent directory as `<project>`.

## Tests

Paths:

- [`api/test/`](../../api/test/): Vitest. The suites are `api`, `contracts`, `hardening`, `jwks`, `labels`, `mcp`, `mcp-conformance`, `mcp-infra`, `origin`, `package-api`, `presign`, `producers` and `txn`. `fake-ddb.js` and `world.js` are helpers.
- [`auth/test/`](../../auth/test/): Vitest. The suites are `cognito`, `edge`, `linkstore`, `oauth`, `origin`, `passkey`, `passkeystore` and `userinfo`. `fake-table.js` is a helper.
- [`auth/e2e/passkey.e2e.mjs`](../../auth/e2e/passkey.e2e.mjs): a Playwright end-to-end passkey test.
- [`auth/e2e/signin-theme.e2e.mjs`](../../auth/e2e/signin-theme.e2e.mjs): a Playwright end-to-end test of the styled sign-in pages.
- [`edge-gate/test/gate.test.mjs`](../../edge-gate/test/gate.test.mjs): `node:test`.
- [`tests/client/`](../../tests/client/): `node:test` suites `auth-continuity.test.mjs` and `data-fetch.test.mjs`.
- [`islands/tests/`](../../islands/tests/):
  - `node:test` suites: `asset-versions`, `bundle`, `content-contract`, `contract`, `copy`, `kit-aliases`, `theme-delivery`, `theme-lint`, `time` and `uploads-gate`.
  - Playwright specs: `asset-versions`, `auth-continuity`, `d11-fixes`, `flags-fallback`, `islands-look`, `legacy-pages`, `notifications`, `person`, `person-page`, `posts`, `qa-fixes`, `qa2-fixes`, `search`, `shell`, `sw` and `theme-foundation`.
  - Fixtures, all synthetic: `fixtures/islands-look.json`, `fixtures/person-legacy.json`, `fixtures/person-synthetic.json` and `fixtures/tree-synthetic.svg`.
- [`scripts/cloudfront/test/`](../../scripts/cloudfront/test/): `node:test` suite `append-index.test.mjs` and its case table `append-index.cases.json`.
- [`scripts/infra/test/`](../../scripts/infra/test/):
  - `run.sh`: offline tests for `scripts/infra`, `scripts/ci/package-edge-gate.sh`, `scripts/check-deployment-sync.sh`, the repo-owned `11ty/` paths and the CloudFront Function.
  - `test_app_stack.py`: static checks on `app-stack.yaml` and `github-roles.yaml`.
  - `test_edge_gate_stack.py` and `test_mcp_edge401_stack.py`: static checks on the two us-east-1 templates.
  - `stub/aws`, `cf-echo.jq`, `fixtures/live-like.json` and `fixtures/live-with-uploads.json`: test doubles.
- [`tests/login-flow/`](../../tests/login-flow/): Playwright specs `login-flow.spec.ts` and `auth-v2.spec.ts`.
- [`scripts/mcp/token-smoke.sh`](../../scripts/mcp/token-smoke.sh): a live MCP token check.

Facts:

- The API suites run against an in-memory DynamoDB fake. They include the `@io-kit` content and comments contract suites.
- `mcp-conformance.test.js` runs the packaged `@io-kit/mcp` conformance corpus, MCP-C01 to MCP-C12, against this repository's edge and core factories.
- `mcp-infra.test.js` dry-runs `add-mcp-behavior.sh` on an exported config, runs the 401-restore code, and checks that `tools/list` matches the caps.
- `package-api.test.js` runs `package-api.sh` against a temporary copy of the repository, with `npm` and `zip` shimmed.
- `presign.test.js` signs offline with fake credentials, and checks that the PUT goes to the bucket's S3 endpoint, never to the site host.
- `passkeystore.test.js` uses `fake-table.js`, an in-memory table that reads the `hfy-app` key schema from `app-stack.yaml` and applies DynamoDB's sparse-index rule.
- `edge.test.js` also covers the referrer policy, `font-src`, the stylesheet origin in the CSP, the `?v` on `cssUrl` and each HTML override.
- `passkey.e2e.mjs` drives Chromium's virtual authenticator against the real edge app on `http://localhost`, with in-memory stores. It runs with `npm run e2e` in `auth/`, after `npx playwright install chromium`, and is not part of `npm test`.
- `signin-theme.e2e.mjs` runs with `SITE=<scratch site> npm run e2e:theme` in `auth/`, where the scratch site is a copy of `11ty/` built with `node build.mjs --site`. It exits `2` without `SITE`. It serves the real edge pages, with their real CSP, on `http://localhost:$E2E_PORT` (default `4175`), serves `/css` and `/fonts` from `SITE`, and drives Chrome (`channel: chrome`) at 375 and 1024 px with test-only wiring and a synthetic allowlist. `E2E_SHOTS=<dir>` saves screenshots and `E2E_OFFLINE=1` blocks Google Identity Services. It is not part of `npm test`.
- `edge-gate/` has no dependencies. `npm test` there runs `node --test`.
- `tests/client` loads the real `11ty/js/feature-flags.js` into a `vm` sandbox with a stubbed `fetch`. It needs no install: `node --test tests/client/*.test.mjs` from the repository root. `auth-continuity.test.mjs` also covers the `/family-login/?next=` hand-over to `returnTo`.
- The islands content-contract test drives the real `api/` handler.
- `bundle.test.mjs` checks that every build output is tracked, present and identical to a fresh build.
- `npm run test:contract` in `islands/` runs every `node:test` suite there, the theme lint included. `npm test` runs those and then the Playwright specs.
- The island Playwright specs run at 375 px width in Chrome (`PW_CHANNEL` names another channel) against `npx http-server <site> -p <port> -a 127.0.0.1 -s -c-1`. The site defaults to `../11ty` and the port to `8089`, so by default they use the committed bundles. `HFY_SITE=<dir>` and `PW_PORT=<port>` point them at a scratch build. `bundle`, `theme-delivery` and `asset-versions` honour `HFY_SITE` too.
- `/api`, `/auth` and the data files are stubbed per test. The `auth-continuity` spec models the gate as a 401 until `/auth/refresh` has succeeded.
- `node --test scripts/cloudfront/test/*.test.mjs` runs the shared case table (`rewrite`, `deny` and `awsSamples` cases), checks that nothing shipped in `11ty/` outside `person/` is denied, pins the deny lists to the gate script and `11ty/person/`, and runs an ES5 guard. `run.sh` and `publish-append-index.sh` run it too.
- `scripts/infra/test/run.sh` puts `stub/aws` first on `PATH` and never reaches AWS. It needs `bash`, `jq`, and `python3` with PyYAML.
- `run.sh` also needs `node`, `zip` and `openssl` for the `package-edge-gate.sh` checks, `node` for the CloudFront Function and `publish-append-index.sh` checks, and `rsync` and `git` for the `check-deployment-sync.sh` run. It skips each of those blocks when its tools are missing, and uses `cfn-lint` and `shellcheck` when they are installed.
- Besides the behavior scripts, `run.sh` covers: `/uploads/*` gated in place, its drift repair, the `--remove` restore (the `--restore-uploads-policy-id` override, the refusal when no policy can be found, a second `--remove` as a no-op, both policies kept) and the uploads policy and its repair; `publish-append-index.sh` against the stub (diff, `test-function` gate, publish, backup, idempotency and refusals); the repo-owned `11ty/` paths in `11ty/README.md` and the sync check; and the `?v` on `auth/edge.manifest.json` `theme.cssUrl`.
- `test_app_stack.py` checks that the `UploadsResponseHeadersPolicy` CSP equals `UPLOADS_CSP` and the gate script's uploads policy.
- `tests/login-flow` targets the live site by default (`HFY_SITE_BASE`).
- The legacy spec signs in with a Google ID token on `/family-login/`. Under `authV2` that page sends a signed-out visitor to `/auth/login`, so the spec can pass only against a site with `authV2` off. The `auth-v2` spec is the check for an `authV2` site. It asserts structure, not copy.
- The legacy spec reads its Google ID token from `HFY_TEST_ID_TOKEN`. Without that variable, it runs the helper named by `HFY_MINT_HELPER` with `python3`.
- The `HFY_MINT_HELPER` default is `../../scripts/auth/mint_test_id_token.py`, relative to the working directory. The default finds the helper from neither copy of the suite:
  - From `<project>/workspace/tests/login-flow`, it resolves to `<project>/workspace/scripts/auth/`, which does not exist.
  - From the repository copy, it resolves to `<project>/repo/scripts/auth/`, which does not exist either.
- The helper is at `<project>/scripts/auth/mint_test_id_token.py`. The suite therefore needs either `HFY_MINT_HELPER` set to that path or `HFY_TEST_ID_TOKEN`.
- The `auth-v2` spec is skipped unless `HFY_AUTH_V2=1`. Its password path also needs `HFY_TEST_EMAIL` and `HFY_TEST_PASSWORD`.
- `token-smoke.sh` validates an MCP access token from `MCP_TOKEN` against the live auth edge, without printing it.
- No workflow runs any of these suites. How to run them: [How to run the test suites](../how-to/run-the-tests.md).

## Sanitized samples

Paths: [`allowlist/`](../../allowlist/), [`harrisonfamily-frontend/`](../../harrisonfamily-frontend/), [`etl-output/`](../../etl-output/), [`gramps_exports/`](../../gramps_exports/), [`cloudfront/`](../../cloudfront/), [`coming-soon-index.html`](../../coming-soon-index.html).

Facts:

- These are placeholders that show the shape of the private data. The real files live under `<project>/workspace-local/`.
- `allowlist/` holds example addresses and hashes.
- `harrisonfamily-frontend/` is a synthetic set of person, family, event, media, note and place records.
- `etl-output/` holds only READMEs, and `gramps_exports/` holds only `.gitkeep`.
- The top-level README in each sample directory that has one is a short pointer into these docs.
- `coming-soon-index.html` is a standalone placeholder page.
- The samples are edited in the repository. `.gitignore` and `scripts/ci/check-no-family-data.sh` keep real data out (D-03).
- `<project>/workspace/cloudfront/` also holds placeholder JSON files that `scripts/sync_sanitized_assets.py --sync` wrote for files in `<project>/workspace-local/cloudfront/`. They are not copied into the repository. See [How to refresh the sanitized samples](../how-to/refresh-the-sanitized-samples.md).

## Outside the repository

Paths: `<eleventy-source>`; `<project>/scripts/etl/`; `<project>/scripts/search/build_search_index.js`; `<project>/scripts/infra/publish_allowlists.sh`; `<project>/scripts/auth/mint_test_id_token.py`; `<project>/workspace-local/`.

Facts:

- They are named here so you know they exist. These docs do not reproduce their contents.
- `<eleventy-source>` builds `11ty/`.
- The source's `partials/head.njk` already emits head blocks A and B, with a hard-coded theme `?v` and font file name that the islands build overwrites in the output. The base layout does not emit the `auth-v2.js` tag, and neither the Voice copy nor the asset versions are ported, so `copy.mjs` and `assets.mjs` are still needed. The source's `public/js/auth.js` still prompts One Tap.
- The ETL scripts turn the Gramps export into person JSON and family-tree media.
- `build_search_index.js` builds the person manifest and search index. The source's `build:search` step runs it.
- `publish_allowlists.sh` publishes the allowlist to Secret Manager and the email-to-gramps_id map to the config bucket.
- `mint_test_id_token.py` mints test ID tokens for `tests/login-flow`.
- `workspace-local/` holds the private family data and the real credentials.
- The workspace sources of the legacy sign-in code are also outside the repository. See [Legacy sign-in](#legacy-sign-in).

## What in `11ty/` is generated

Every file under `11ty/` falls into one of the kinds below.

- "Generated" means Eleventy output, kept as the source produced it.
- "Repo-edited" means a generated file that was then changed in the repository, by hand or by the islands build.
- "Repo-only" means a file the repository adds, which the source output does not produce in this form.
- "Build output" means a file written whole by [`islands/build.mjs`](../../islands/build.mjs).

The last three kinds together are the repo-owned files, which every refresh must keep. Three more columns show how each kind is treated:

- "Plain refresh" is a `rsync -a --delete` from the source output that excludes only `README.md`, `private/`, `media/`, `person/`, `family/`, `event/` and `note/`: the refresh `11ty/README.md` documented before the islands.
- "README refresh" is the refresh `rsync` in `11ty/README.md` now. Its excludes are the sync check's, `.DS_Store` aside.
- "Sync check" is the pre-commit `check-deployment-sync.sh`.

After any refresh, and after `scripts/promote_workspace_assets.sh`, run `cd islands && npm run build`, which needs the installed dependencies and so `CODEARTIFACT_AUTH_TOKEN`. It puts the head blocks, the Voice copy and the `?v` versions back on the refreshed pages. Then `npm run check:islands` must pass. A page committed without that rebuild keeps unversioned URLs, which Cloudflare can serve stale for hours. To rebuild from the source without losing repo-owned files, follow [How to refresh `11ty/` from the Eleventy source without losing E5 files](../how-to/refresh-the-eleventy-output.md).

| Files | Kind | Plain refresh | README refresh | Sync check |
|---|---|---|---|---|
| `css/main.css`, `css/main.css.map`; `images/` except `pwa-*`; `js/bootstrap.bundle.min.js` | Generated. The script is copied from the source's `public/js/`. `main.css` is never edited: the theme layer loads after it. | Replaced from source output. Nothing is lost. | Replaced from source output. | Compared. |
| `index.html`, and `index.html` under `about/`, `contact/`, `family-login/`, `logged-out/`, `privacy/`, `search/` and `terms/` | Repo-edited. Added by hand: `<script src="/js/auth-v2.js" defer></script>`. Written by the islands build: head blocks A and B around the `main.css` link, the Voice copy, and `?v=<sha8>` on every same-origin script, stylesheet and manifest reference, the `auth-v2.js` tag included. | Overwritten. All of these changes are lost. | Overwritten too. Re-add the tag, then run the islands build, which restores the rest. | Compared, whole. |
| `person/index.html`, `private/index.html` | Repo-edited, with the same changes. | Excluded.[^dirs] | Excluded.[^dirs] | Excluded.[^dirs] |
| `js/search-navbar.js`, `js/search-results.js` | Repo-edited. A comment and a `hfySearchV2Live()` helper at the top (lines 2–5), and `edgeSessionInit()` and `dataFetch()` helpers (lines 74–85 in `search-navbar.js`, 144–155 in `search-results.js`). Stand-down checks `if (await hfySearchV2Live())` before the data load: line 116 (in `loadData()`) in `search-navbar.js`, and lines 187 (in `loadData()`) and 417 (in `bootstrap()`) in `search-results.js`. Under `authV2`, the manifest and index load through `dataFetch` with the cookie only, `requireAuthenticated()` returns at once, and `subscribeToAuthChanges()` preloads on the edge session. | Overwritten with the source copy, which lacks these edits. | Excluded. | Excluded. |
| `js/feature-flags.js` | Repo-edited. At the top: the `hfy-asset-versions` stamp block (`ASSET_V`), which every islands build rewrites, and the theme fallback link. Near the top: the edge overlay, `edgeOverlay` and `visibilityState()`, which `shouldShow` and `featureAPI.shouldShow` read. From `window.HFYFeatureFlags = featureAPI;` to the last `onReady(applyFeatureVisibility);`: flag resolution, the `?hfy_flags=` override and banner, the `authV2` data path (`dataFetchInit` to `dataResponse`), `loadIsland`, `assetVersions`, `whenIsland`, `searchV2Live` and the per-flag loaders. The rest is the legacy visibility gating and session cache. | Overwritten with the source copy, which lacks these edits. | Excluded. | Excluded. |
| `js/person-page.js` | Repo-edited, and largely rewritten for the design system's PersonRecord layout: a hero, then life, family, photos and stories, and a tree toolbar with zoom and a legend. The data path: `dataFetch()` and `edgeSessionInit()` send the data requests through `HFYFeatureFlags.dataFetch`. Under `authV2`, `requireAuthenticated()` and `buildAuthorizedFetchOptions()` use the cookie instead of the legacy token, and `fetchPerson()` turns a final 401 into a sign-in link, which `showSignIn()` shows. `renderFamilyVisualization()` loads the family-tree SVG as a background request. | Overwritten with the source copy, which lacks the layout and the `authV2` data path. | Excluded. | Excluded. |
| `js/auth.js` | Repo-edited. `authV2Active()` and the guard around `googleAccounts.prompt()` in `initAuthUI()`: with `authV2` on, One Tap does not prompt. | Overwritten with the source copy, which still prompts One Tap. | Excluded. | Excluded. |
| `_data/flags.json`, `js/auth-v2.js`, `images/pwa-192.png`, `images/pwa-512.png`, `images/pwa-maskable-512.png` | Repo-only. | Deleted, or replaced by the source copy where the source output has one. | Excluded. | Excluded. |
| `sw.js`, `manifest.webmanifest` | Repo-only. The islands build rewrites the `hfy-asset-versions` block in `sw.js` and the colours in `manifest.webmanifest`. | Deleted, or replaced by the source copy where the source output has one. | Excluded. | Excluded. |
| `offline.html`, `posts/index.html`, `me/index.html`, `me/notifications/index.html` | Repo-only. The islands build writes their head blocks and `?v` versions. | Deleted, or replaced by the source copy where the source output has one. | Excluded. | Excluded. |
| `js/islands/`, including `chunks/` and `notify-sw.js`; `css/hfy-theme.css`; `css/auth-edge.css`; `fonts/` | Build output. | Deleted, or replaced by the source copy where the source output has one. | Excluded. | Excluded. |
| `README.md` | Repository note for the directory. It is not deployed: the static sync excludes it. | Excluded. | Excluded. | Excluded. |

[^dirs]: The tracked `person/index.html` and `private/index.html` are the only files under `person/` and `private/`. Every refresh and the sync check exclude both whole directories, so none of them overwrites, deletes or compares these two pages. A change to either page in the source output reaches `11ty/` only when it is copied by hand.

A copy of source output that uses `--delete` without these excludes deletes every repo-only file and build output that the source output lacks, including the committed islands, the theme layer and the fonts. It also overwrites the repo-edited files.

## Top-level directories

The reverse lookup: from a directory to the capability sections above.

| Directory or file | Capability |
|---|---|
| `.github/workflows/`, `.github/actions/`, `ci.manifest.yaml` | CI and repo operations |
| `11ty/` | Static site output, front-end runtime, React islands (`11ty/js/islands/`), theme layer (`11ty/css/hfy-theme.css`, `11ty/css/auth-edge.css`, `11ty/fonts/`), private data gate (the client data path) |
| `allowlist/`, `etl-output/`, `gramps_exports/`, `harrisonfamily-frontend/`, `coming-soon-index.html` | Sanitized samples |
| `api/` | Family API, MCP server |
| `auth/` | Auth edge and MCP authorization server |
| `cloudfront/` | Infrastructure (sample distribution), sanitized samples |
| `docs/`, `AGENTS.md` | This documentation. `AGENTS.md` is the entry point for automated agents. |
| `edge-gate/` | Private data gate |
| `functions/`, `gcloud/`, `lambda/` | Legacy sign-in |
| `infrastructure/` | Infrastructure, including the us-east-1 stacks of the MCP server and the private data gate |
| `islands/` | React islands; theme layer, fonts and asset versions |
| `shared/` | Pure, zero-dependency ESM validators (relative imports only; `shared/shared.test.mjs` enforces it, run `node --test shared/`). `api/src/shared` and `auth/src/shared` are committed symlinks to `../../shared`; `scripts/ci/package-api.sh` and `package-auth.sh` stage `shared/*.mjs` as real files in `src/shared/`; the islands import them by relative path and esbuild bundles them. |
| `scripts/` | CI and repo operations, infrastructure, the CloudFront Function (`scripts/cloudfront/`), tests |
| `tests/` (`client/`, `login-flow/`) | Tests |
| `workspace/` | Static site output (the stray `featureFlags.js` only) |

## Notes

- This page is a routing index, not an inventory of record. Where it and the code disagree, the code is authoritative.
- The production cutover ran on 2026-10-12 (HFY-TSK-069, HFY-R67): PR #8 set all six flags in `11ty/_data/flags.json` to `true` and the site deployed, and then, per the HFY records, the private data gate was attached. The flags and the gate can change without an edit to this page, so check them rather than assume:
  - the flags: `curl -s https://<site>/_data/flags.json | jq .authV2`, or without `.authV2` for all seven (`navMe` included);
  - the gate: a signed-out `curl -s -o /dev/null -w '%{http_code}' https://<site>/person/index.json` prints `401` while the gate is attached. Without it, the request reaches the default behavior and its answer depends on the `HFYAppendIndex` code ([CloudFront Function](#cloudfront-function)).

  [How to turn a feature flag on for one tab or for everyone](../how-to/toggle-a-feature-flag.md) covers the flags, and the [release model](../explanation/release-model.md) explains them. The private data gate is not a flag: it applies from the moment `add-data-gate-behaviors.sh` attaches it.
- The repository does not record whether the follow-up live operations ran: the `/uploads/*` gating, the `HFYAppendIndex` publish, and the `hfy-auth-edge` and `hfy-api` redeploys that the theme and sign-in changes need. The pages that describe them give the checks.
- `11ty/README.md` is machine-checked. `scripts/infra/test/run.sh` reads two blocks from it and compares them with the Eleventy excludes in `scripts/check-deployment-sync.sh`:
  - the section from `## Repo-owned files` to `## Refreshing` must name `js/person-page.js`, `js/auth.js`, `css/auth-edge.css`, `css/hfy-theme.css` and `fonts/`;
  - the excludes of the command that starts `rsync -a --delete -n -i`, read up to its `_site/` line, must include those same paths and equal the sync check's excludes, `.DS_Store` aside.

  Change the exclude list in both files together, and keep those two headings and that command line as they are, or `run.sh` fails. The same test also checks that `auth/edge.manifest.json` `theme.cssUrl` carries the current hash of `11ty/css/auth-edge.css`.
- Some code comments cite READMEs that are now pointers:
  - `scripts/ci/package-edge-gate.sh`, `infrastructure/cloudformation/edge-gate-stack.yaml` and `11ty/js/feature-flags.js` cite `cloudfront/README.md` ("Private data gate") for the deploy order and rollback. That material is now in [How to deploy and update the Lambda@Edge functions in us-east-1](../how-to/deploy-the-edge-functions.md) and [How to cut over to authV2 and the private data gate, and roll back](../how-to/cut-over-to-the-private-data-gate.md).
  - `api/src/uploads.js` cites `cloudfront/README.md` for the members-only `/uploads/*`. That is now in [System architecture](architecture.md) and [Repository operations](repository-operations.md).
  - `api/src/keys.js` cites `api/README.md` for the key layout, which is now in [API: Table layout](api.md#table-layout).
  - `islands/copy.mjs`, `islands/heads.mjs` and `islands/tests/copy.test.mjs` cite the port notes in `11ty/README.md`. What the build writes is now in [Theme and asset build](theme-and-asset-build.md), and the state of the Eleventy source is in [How to refresh `11ty/` from the Eleventy source without losing E5 files](../how-to/refresh-the-eleventy-output.md).
- The `@io-kit/*` packages used by `api/`, `auth/` and `islands/` come from a private CodeArtifact registry. Each of those directories has an `.npmrc` that reads `CODEARTIFACT_AUTH_TOKEN` from the environment, so no token is stored in the repository. `edge-gate/`, `tests/client/` and `scripts/cloudfront/` need no packages. See [Private data and secrets](private-data-and-secrets.md).
