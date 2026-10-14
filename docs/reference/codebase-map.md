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
| [Family graph builder](#family-graph-builder) | `graph/` | [Graph builder README](../../graph/README.md) |
| [CloudFront Function](#cloudfront-function) | `scripts/cloudfront/`, `scripts/infra/publish-append-index.sh` | [Architecture](architecture.md#hfyappendindex) |
| [Retired legacy sign-in](#retired-legacy-sign-in) | None: its last code was deleted (HFY-TSK-325, HFY-TSK-326) | [Identity services](identity-services.md#retired-legacy-sign-in) |
| [Infrastructure](#infrastructure) | `infrastructure/`, `scripts/infra/`, `cloudfront/` | [Architecture](architecture.md) |
| [CI and repo operations](#ci-and-repo-operations) | `ci.manifest.yaml`, `.github/`, `scripts/ci/`, `scripts/git-hooks/`, the workspace helpers in `scripts/` | [Repository operations](repository-operations.md) |
| [Tests](#tests) | `api/test/`, `auth/test/`, `auth/e2e/`, `edge-gate/test/`, `graph/test/`, `gramps/tests/unit/`, `shared/*.test.mjs`, `islands/tests/`, `scripts/cloudfront/test/`, `scripts/infra/test/`, `tests/client/`, `tests/login-flow/`, `scripts/mcp/` | [Repository operations](repository-operations.md) |
| [Sanitized samples](#sanitized-samples) | `allowlist/`, `harrisonfamily-frontend/`, `etl-output/`, `gramps_exports/`, `cloudfront/` | [Private data and secrets](private-data-and-secrets.md) |
| [Outside the repository](#outside-the-repository) | `<eleventy-source>`, `<project>/scripts/`, `<project>/workspace-local/` | [Private data and secrets](private-data-and-secrets.md) |

## Static site output

Paths:

- [`11ty/`](../../11ty/): the deployable site. Each file is classified in [What in `11ty/` is generated](#what-in-11ty-is-generated).
- [`11ty/README.md`](../../11ty/README.md): a pointer into these docs, plus two machine-checked blocks: the repo-owned files table and the refresh `rsync`. See the constraint in [Notes](#notes).

Facts:

- `11ty/` is Eleventy output plus repo-owned files. Its source is `<eleventy-source>`, outside the repository.
- [`islands/build.mjs`](../../islands/build.mjs) also writes into `11ty/`: the island bundles, the theme layer, the sign-in stylesheet, the fonts, and parts of the pages, `sw.js`, `js/feature-flags.js` and `manifest.webmanifest`. Every output is committed. See [React islands](#react-islands) and [Theme layer, fonts and asset versions](#theme-layer-fonts-and-asset-versions).
- CI deploys `11ty/` as committed and builds nothing into it and changes nothing in it: the manifest's build command only echoes (HFY-TSK-317 removed the client-ID patch and the Lambda zip).
- The `?v=<sha8>` on each script and stylesheet reference is the hash of the committed file, which is also the deployed file.
- `11ty/README.md` is repo-only: `ci.manifest.yaml` excludes `README.md` from the static sync, so it is not served. It still names no private path, because the repository can be read by others.
- When any staged path is under `11ty/`, the pre-commit check [`scripts/check-deployment-sync.sh`](../../scripts/check-deployment-sync.sh) compares `<project>/workspace/11ty-dev/_site` with `11ty/` using `rsync -ain --delete --omit-dir-times`. Any difference fails the commit.
- That comparison excludes the data directories (`person/`, `family/`, `event/`, `note/`, `media/`, `place/`), `private/`, `uploads/`, `README.md`, `.DS_Store` and the repo-owned files, among them `js/person-page.js`, `family-login/`, `css/auth-edge.css`, `css/hfy-theme.css` and `fonts/`.
- Excluding `person/` and `private/` also excludes the one page in each, `person/index.html` and `private/index.html`. The other Eleventy pages are compared whole. Fresh source output lacks their `auth-v2.js` tag, their Voice copy and their `?v` versions, so it differs from the committed pages (see [What in `11ty/` is generated](#what-in-11ty-is-generated)).
- `SKIP_DEPLOYMENT_SYNC_CHECK=1` skips the check.

## Front-end runtime

Paths:

- [`11ty/js/feature-flags.js`](../../11ty/js/feature-flags.js): the visibility gating (`window.HFYFeatureFlags`). It also holds, added in the repository:
  - the `hfy-asset-versions` stamp block (`ASSET_V`) at the top, which every islands build rewrites, and the fallback link to the theme layer;
  - the island loader: flag resolution, the `?hfy_flags=` override and its banner, `loadIsland`, `whenIsland` and `assetVersions`;
  - the `authV2` data path: `dataFetchInit`, `dataFetch`, `edgeSession`, `forgetEdgeSession`, `signInUrl`, and the deprecated `dataResponse`;
  - the edge overlay, near the top of the file.

- [`11ty/js/auth-v2.js`](../../11ty/js/auth-v2.js): the sign-in script for the edge sign-in at `/auth` (the only sign-in since HFY-TSK-317). It reads the session through `HFYFeatureFlags.edgeSession()` and calls `forgetEdgeSession()` on sign-out.
- [`11ty/js/person-page.js`](../../11ty/js/person-page.js): renders the person page in the design system's PersonRecord layout. It is repo-owned: its data requests go through `HFYFeatureFlags.dataFetch` with the `io_id` cookie.
- [`11ty/family-login/index.html`](../../11ty/family-login/index.html): the static redirect page that replaced the Google sign-in page (HFY-TSK-317). Old `/family-login/?next=<path>` links land on `/auth/login?returnTo=<path>`. `/search/` has no script of its own: the `search` island is the only search.
- [`11ty/_data/flags.json`](../../11ty/_data/flags.json): the build-time flags.
- [`11ty/sw.js`](../../11ty/sw.js): the service worker. Its `hfy-asset-versions` stamp block is rewritten by every islands build.
- [`11ty/manifest.webmanifest`](../../11ty/manifest.webmanifest), [`11ty/offline.html`](../../11ty/offline.html): the PWA manifest, whose colours the islands build writes, and the offline page, which loads no scripts.

Facts:

- The island loader resolves flags from `/_data/flags.json`, fetched with `cache: "no-store"`, plus the `?hfy_flags=` preview override. It then loads islands with `loadIsland`.
- `searchV2` turns on `shellV2` too, unless the override forces `shellV2` off.
- The override lasts for the current tab only. It is kept in `sessionStorage` under `hfy:flags`. `-name` forces a flag off, and an empty `?hfy_flags=` clears the override.
- Earlier builds kept the override in `localStorage`. The script deletes that key on every load.
- While an override is active, the page shows a fixed `preview flags on — turn off` banner (`.hfy-flag-banner`, styled by the theme partial `80-pages.css`). Its button clears the override.
- The override is cleared when a flagged dependency is unavailable: an island bundle fails to load, or `/auth/session` does not answer for `authV2`. The page then falls back to the page as it is without the flag.
- `loadIsland(name)` requests `/js/islands/<name>.css?v=` and `/js/islands/<name>.js?v=` with the hashes from the stamp block, or the bare paths when the block is unstamped. It appends the module only after the stylesheet's `load` or `error` event, so an island never mounts unstyled.
- Once the shell island has loaded, the loader links `/manifest.webmanifest?v=` and sets `localStorage` `hfy:shell-hint` to `1`. It sets `0` when `shellV2` is off or the island fails. The early-hint script in head block A reads it, so the shell frame paints before the flags are fetched ([Theme layer, fonts and asset versions](#theme-layer-fonts-and-asset-versions)).
- `auth-v2.js` does nothing while `authV2` is off.
- Signed out under `authV2`, `auth-v2.js` points the sign-in links at `/auth/login?returnTo=<this page>` when that is a same-origin path with one leading `/`, no backslash or control character, at most 2048 characters, and not under `/auth` or `/family-login`; otherwise at `returnTo=%2F`. `feature-flags.js`, not `auth-v2.js`, deletes the keys the retired Google sign-in left in the browser, on every page.
- A visitor without a session who is refused person data is sent to `/auth/login?returnTo=<path+search+hash>` by `dataFetch`, so a deep link survives sign-in.
- With `authV2` off, `dataFetch` is exactly `fetch`: a plain same-origin request that nothing refreshes. The legacy `X-HFY-Session` code paths are gone from the front end.
- With `authV2` on, data requests send the `io_id` cookie (`credentials: "same-origin"`). That cookie is what the [private data gate](#private-data-gate) checks.
- `edgeSession()` calls `GET /auth/session` once per page. When the session is near expiry, or signed out in a browser that has held an edge session before, it calls `POST /auth/refresh` once and asks again.
- `dataFetch` refreshes a lapsed session once before the page's first data request. On a 401 from the gate, it refreshes once and retries the request once.
- When recovery fails, an interactive load goes to `/auth/login?returnTo=<path+search+hash>`, unless this tab was sent there in the last 10 minutes. A background load (`{interactive: false}`) never redirects.
- The edge overlay lays an authenticated edge session over the page's default state for `[data-feature]` visibility only, so the signed-in navigation holds after an edge-only sign-in.

- Only the shell island registers the service worker, at `/sw.js?v=<sha8 of sw.js>` with scope `/` and `updateViaCache: "none"`. The worker names its cache `hfy-shell-<that ?v>`, or `hfy-shell-dev` without a valid `?v`, and deletes every other cache on activate. It loads `/js/islands/notify-sw.js?v=` with `importScripts`.
- Cloudflare keeps static files for up to 4 h under the URL first fetched. To check a deployed script or stylesheet, fetch the versioned URL the page references: read `?v` from the HTML or from `HFYFeatureFlags.assetVersions`. `/_data/flags.json` is JSON, which Cloudflare does not cache.

## React islands

Paths:

- [`islands/src/islands/`](../../islands/src/islands/): one entry per island. The entries are `shell.jsx`, `search.jsx`, `person.jsx`, `my-posts.jsx`, `timeline.jsx`, `posts.jsx` and `notifications.jsx`, `settings.jsx`, `about-cta.jsx`, `photo-tags.js`, `photo-tag-edit.jsx`, `person-links.jsx`, `links-editor.jsx`, `tree.jsx`, `edit-entry.jsx`, `editor.jsx` and `review.jsx`, plus their stylesheets. `tree.jsx` is the `/tree/` page (`familyViz`, HFY-TSK-201); its pure logic is `lib/family-graph.js` (the graph v1 parser and queries), `lib/tree-data.js` (the graph fetch states and the focus rule) and `lib/tree-link.js` (the person page's "see in the family tree" link).
- [`islands/src/lib/`](../../islands/src/lib/): shared adapters and UI. The files are `api.js`, `cloudscape-theme.js`, `comment-source.js`, `comments-ui.jsx`, `contact-guard.js`, `contact-precheck.js`, `content-source.js`, `me.js` (the one `GET /api/me` reader, shared per page), `mount.jsx`, `people-corpus.js`, `person-name.js` and `person-name.jsx` (the one rule for linking a person's name to their page, ruling P2-R46, and `<PersonName>`), `photo-tags.js` (the pure geometry, rect words and tag cleaning), `photo-tags-ui.js` (the DOM part of the photo tags island), `photo-tag-edit.js` (the photo tag editor's pure half: the integer-percent rect rule, drawing geometry, the match of a tag to its MediaRef and the EditOps) and `photo-tag-edit-ui.jsx` (its lightbox UI), `posts-ui.jsx`, `time.js` and `upload.js`. `islands/src/shell.css`, `islands/src/posts.css`, `islands/src/comments.css`, `islands/src/guard.css`, `islands/src/photo-tags.css` and `islands/src/photo-tag-edit.css` sit beside the directory.
- [`islands/build.mjs`](../../islands/build.mjs): the build. It bundles the islands with esbuild and writes the outputs in [Theme layer, fonts and asset versions](#theme-layer-fonts-and-asset-versions).
- [`islands/kit-content.mjs`](../../islands/kit-content.mjs): how the build and the `node:test` suites load `@io-kit/content/react`. Its esbuild plugin keeps the kit's `DocumentEditor` from bundling Cloudscape's stylesheets into the posts islands, and the build fails if an island bundles `DocumentEditor`.
- [`islands/package.json`](../../islands/package.json): the scripts `build`, `build:islands`, `check:islands`, `test`, `test:contract`, `lint:css` and `measure:search`. Every dependency is pinned to an exact version.
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
- `islands/tests/bundle.test.mjs` runs the same check, and also fails when a build output is gitignored, or when the person, my-posts, posts or timeline island loads Cloudscape code or styles.
- No workflow runs either check, although a comment in `islands/copy.mjs` says CI does.
- The person island (`person.jsx`) and the search corpus (`lib/people-corpus.js`) read family data through `HFYFeatureFlags.dataFetch` when it exists, so they follow the same `authV2` data path as `person-page.js`.
- `createApi` in `lib/api.js` skips an `/api` call when `HFYFeatureFlags.edgeSession()` has answered signed out: it throws `ApiError(401, "unauthenticated")` without sending the request. With `authV2` off, or `/auth/session` unreachable, requests go out as before. The timeline island renders nothing for a signed-out visitor.
- Photos in posts are same-origin `<img src>` elements, so the browser sends `io_id` to a members-only `/uploads/*`. A script that fetches a photo must use `credentials: "same-origin"`.
- Flags:
  - `shell` loads on `shellV2`.
  - `search` loads on `searchV2`, on `/search/`. It mounts `#hfy-search-v2` in the page's own `<main>`.
  - `person` loads on `personV2`, on `/person/?id=…`.
  - Under `postsV2`, `my-posts` loads on `/person/?id=…`, `timeline` on `/`, and `posts` on `/posts/`.
  - `notifications` loads on `notifyV2`, on `/me/notifications/`.
  - `settings` loads on `navMe`, on `/me/`: the settings hub (HFY-TSK-091). With `profileLinks` its `ROWS` list adds "your links" (`/me/links/`), and with `inboxV1` "inbox" (`/me/inbox/`).
  - `follow` loads on `recordSubsV1`, on `/person/?id=…` (HFY-TSK-186): the follow toggle in the person page's `[data-slot="follow"]` host. The "pages you follow" section of `/me/notifications/` is `src/lib/followed-pages.jsx`, rendered by the `notifications` island when the flag is on; the follow client and copy are in `src/lib/follow.js`.
  - `person-links` and `links-editor` load on `profileLinks`: `person-links` on `/person/?id=…` (it fills the person page's `[data-slot="links"]` host with a labelled "links" section), `links-editor` on `/me/links/` (HFY-TSK-217). Their shared copy and chip rules are in `src/lib/profile-links.js`, over `shared/profile-links.mjs`.
  - `inbox` and `inbox-page` load on `inboxV1` (HFY-TSK-185). `inbox` is the bell: `feature-flags.js` loads it on every page with the shell for a signed-in member only, and it fills the shell's bell slot (`src/lib/bar-slots.js`, the shell is not edited). It opens the kit's bottom `Sheet` under 43rem and an anchored, non-modal panel from 43rem. `inbox-page` loads on `/me/inbox/` and fills it with the same `NotificationInbox`. Both read `src/lib/inbox-ui.jsx` (copy, the shared `useInbox` wiring) over `src/lib/notify-api.js`, the one `@io-kit/notify` client the settings page shares. `src/lib/notify-catalog.js` is the settings catalog, one entry per type of the API's `TEMPLATE_REGISTRY`; `tests/notify-catalog.test.mjs` fails when they drift.
  - `review` loads on `/me/review/` with `proposalReview` or `recordEdit` (HFY-TSK-259) and mounts the suggestions page: three tabs (`to review` for admins with `proposalReview`, `my suggestions` and `about my page`), a list and a detail card, a 40/60 split from 64rem. Its parts: `src/lib/proposal-gate-source.js` (the `@io-kit/gates` `GateSourceLike` over `GET /api/proposals` and the decision route; every card passes the kit's `parseGateCard`), `src/lib/review-model.js` (tabs, chips, words, before and after rows, the conflict rows and the amend, the error table; pure), `src/lib/review-ui.jsx` (`ProposalCard`, the kit's `renderCard`, and the amend form and reason sheet) and `src/islands/review.jsx`.
  - `edit-entry` and `editor` load on `recordEdit` (HFY-TSK-212). `edit-entry` loads on `/person/?id=…` and fills the person page's `[data-slot="edit"]` host in the hero action slot (`edit my info` on the member's own page, `suggest a change` on other pages, `edit` for an admin; from `GET /api/me`); `editor` loads on `/edit/` and mounts the section framework (`?cls=person&id=<gramps id>`, `GET /api/edit/:cls/:ref`), with a mode badge on every field through the kit's `fieldAdornment`. Their pure rules are in `src/lib/editor-model.js`. The save flow (HFY-TSK-213) is `src/lib/editor-save.js` (form values to `set` ops with their bases, the bar's count, the `POST /api/changes` bodies, the replay seed of a `409`, the toast, the undo window and the plain-words error table) and `src/lib/editor-save-ui.jsx` (the sticky bar and toast, the confirmation sheet and the hook that runs dry run, save, undo and replay). Person pages never load the form kit: only `editor` imports `@io-kit/schema_form`.
  - `family` and `family-entry` load on `relationshipWizard` (HFY-TSK-158, BRD2 R-24). `family` loads on `/edit/family/` (`?id=<gramps id>`, the member's own id, or none) and mounts the relationship wizard: four flows (`my parents`, `my children`, `my spouse or partner`, `something's wrong`), one question per screen with a step count, Back and Undo, and a summary in sentences before `send for review`. The client sends intents (`POST /api/relationships/preview`, then `POST /api/relationships` under an `Idempotency-Key`); the server compiles the ops and a member always gets a proposal. Its parts: `src/lib/wizard-model.js` (pure: the screens, the draft as a stack of snapshots for Back and Undo, the intent builders, the sentences, the duplicate answers, the draft kept in `sessionStorage`, the plain-words errors), `src/lib/wizard-api.js` (the calls and the lookups: a Gramps id to a handle, the member's families, the places on their page) and `src/lib/wizard-ui.jsx` (the 56 px choice, the person search, the new-person form, the year and place questions). `family-entry` loads on `/person/?id=…` and puts the `add or fix family connections` button in a `[data-slot="family-edit"]` host it creates in the family section, on the member's own page only (from `GET /api/me`); `person-page.js` is not touched.
  - `join` and `join-entry` load on `accessRequests` (HFY-TSK-140). `join` loads on `/join/` and runs the three steps of the access-request sign-up (email and Turnstile, the 6-digit code, the Legacy Form) against the edge's anonymous `/auth/access-request/*` routes; its words, field list, client check (`shared/legacy-form.mjs`, the edge's validator), `sessionStorage` draft and edge-answer table are `src/lib/join.js`, and Turnstile is loaded by `src/lib/turnstile.js` on this page only. `join-entry` loads on `/`, `/about/` and `/contact/` and shows the signed-out line `new here? ask to join.` (a plain link to `/join/`) after the page's own call to action, placed by `src/lib/join-entry.js`. The edge's sign-in and denied pages add the same link while `ACCESS_REQUESTS` is on (`auth/src/edge.js`).
  - `tree` loads on `familyViz`, on `/tree/` (HFY-TSK-201). With the flag off, or when the island fails to load, the loader adds a `[data-tree-unavailable]` status line under the page's heading.
- The shell's navigation registry is `navItems()` in `src/lib/nav.js`, a pure function of the flags `navMe`, `familyViz` and `notifyV2` and the edge session's sub. With `navMe` off it has five items: home, family (`/private/`), search, posts, and me (`/auth/link`, or `/me/notifications/` under `notifyV2`). With `navMe` on (HFY-TSK-091), "me" takes the family tab's own-page route, "family" leaves the bar until `familyViz` gives it `/tree/`, and a gear before the account control opens the `/me/` settings hub. The family tab is "your family": once the edge session names the member, its route becomes their own page, `/person/?id=<sub>` (`src/lib/family-route.js`), and it is marked current on that page only. Signed out, or before the session answers, it stays `/private/`, a redirect page (`HFYFeatureFlags.goToFamily`) that sends a signed-in visitor to their own page and a signed-out one to `/auth/login?returnTo=/private/`. `/person/` without an id does the same. `/family/` cannot be the route: it is a gated data prefix.
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
- `heads.mjs` writes two marker blocks into 22 pages: the 10 Eleventy pages plus `posts/index.html`, `me/index.html`, `me/notifications/index.html`, `me/links/index.html`, `me/inbox/index.html`, `me/review/index.html`, `me/requests/index.html`, `tree/index.html`, `edit/index.html`, `edit/family/index.html`, `join/index.html` and `offline.html`. Block A (`<!-- hfy-theme:start A -->`) sits immediately before the `main.css` link. It holds the `color-scheme` meta, a static `theme-color` meta set to the surface token, the shell early-hint script (left out on `offline.html`) and the preload of the UI font. Block B, right after `main.css`, links `/css/hfy-theme.css?v=<sha8>`. A page without `main.css` gets A, then B, after `</title>`.
- The blocks are head markup because `feature-flags.js` runs at the end of `<body>`, where nothing can block rendering. A page that lacks the theme link still gets one from `feature-flags.js`, marked `data-hfy-theme-fallback`.
- A new HTML page must be added to `PAGES`. `islands/tests/theme-delivery.test.mjs` fails when a page is not registered or lacks the blocks.
- `fonts.mjs` copies the faces from exact-pinned devDependencies: `@fontsource-variable/source-sans-3` (the UI face), `@fontsource/libre-caslon-text` (the display serif) and `@fontsource-variable/source-code-pro`. `11ty/fonts/` holds 12 latin and latin-ext `woff2` files named `<base>.<sha256-8>.woff2`, plus three `LICENSE-*.txt` files.
- The site loads no font from a third party. `theme-delivery.test.mjs` fails on a Google Fonts, Typekit, Bunny or Adobe font origin.
- `copy.mjs` rewrites the Voice copy on the 10 Eleventy pages: the home hero and its calls to action, the about heading, the lowercase page titles (`<title>`, `og:title` and `twitter:title`) and the footer. It matches only the old copy, so it is idempotent and never touches family-written prose. `islands/tests/copy.test.mjs` and `check:islands` fail while a page still carries old copy.
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
- The theme lint, `islands/tests/theme-lint.test.mjs`, runs with `npm run lint:css` and as part of `test:contract` and `npm test`. It covers `islands/src/**/*.css` and the inline styles of the six repo-owned pages, and fails on literal colours, lengths and font names and on `var()` reads of properties other than `--io-*` and `--bs-*`. Only `10-kit-aliases.css` may read the kit's short variables. Every linted file must also parse without esbuild warnings. `HFY_LINT_ONLY=<glob>` narrows the run.
- The Eleventy source emits blocks A and B itself, with a hard-coded theme `?v` and font file name. The islands build overwrites them in the output and stays authoritative.
- Full reference: [Theme and asset build](theme-and-asset-build.md). Why: [The design-system theme layer](../explanation/design-system-theme-layer.md). Changing it: [How to change the theme or the brand fonts](../how-to/change-the-theme-or-brand-fonts.md).

## Family API

Paths:

- [`api/src/`](../../api/src/):
  - `index.js`: Lambda entry and AWS clients. It checks `X-Origin-Verify`, then sends the MCP paths to the MCP mount and every other path to the API handler.
  - `handler.js`: Function URL handler. Its `invoke` runs a route's own handler for a non-HTTP caller, the MCP tools.
  - `routes.js`: route registry, including `MCP_RESOURCE`, the `mcp` member of each route exposed as a tool, and each route's `gate`.
  - `features.js`: the server-side feature gate (HFY-TSK-238): `requireFeature`, `serverSwitch` and `gateExempt` for routes, the flags-file reader, the `uat` and `x-hfy-preview` rules, and `featureOn` for producers ([API: Feature gate](api.md#feature-gate)).
  - `http.js`: HTTP helpers, including `HttpError` and the error mapper, which sends an error's `details` and the guard's `errors`.
  - `auth.js`: session principal and admin list. It resolves the actor's label through `labels.js`.
  - `labels.js`: author labels, shared by the cookie path and the MCP path.
  - `policy.js`: the MCP and UI permission table, the step-up settings and the groups config resolver (the MCP groups and the `uat` group).
  - `mcp.js`: the MCP mount.
  - `mcp-caps.js`: build-time views of the MCP surface.
  - `origin.js`: the `X-Origin-Verify` check.
  - `content.js`: posts, and the upload binding of their new attachments.
  - `comments.js`: comments and reactions.
  - `comment-photos.js`: comment photo attachments behind `commentPhotosV1`: the shape check, the `UPLOAD#` binding of `purpose` `comment` uploads, and the `HeadObject` and location checks before the write ([API: Comment photos](api.md#comment-photos)).
  - `contrib.js`: the contributions ledger (HFY-TSK-255): builders for the `CONTRIB#` event and its five `CSTAT#` counter updates (`contribOps`, `revokeOps`, `hideOps`, `mergeOps`), which `content.js` and `comments.js` commit in the same transaction as the write that earned or lost the credit, and the event read `getEvent` ([API: Contributions ledger](api.md#contributions-ledger)).
  - `contrib-read.js`: the contributions read side (HFY-TSK-256): `createContribReader` (`list`, `stats` and `site`, the three `contributions.*` routes behind `contribV1`), the pure feed-line rule `pickLine` with the cached `CSTAT#site/LINE` row, `hrefOf` and the default `proposalVisible` ([API: Contributions read API](api.md#contributions-read-api)).
  - `links.js`: profile links (HFY-TSK-193), the store behind `GET` and `PUT /api/people/:id/links`: one `PLINKS#<gramps-id>` item per person, written with an `AUDIT#plinks:<gramps-id>` item and a version check. The owner sets or clears, an admin only clears, and both routes are behind `profileLinks`. It validates with `shared/profile-links.mjs` ([API: Profile links](api.md#profile-links)).
  - `subscriptions.js`: record follows (HFY-TSK-254), the store behind `/subscriptions`: one `RSUB#<principal>` item per follow with a `RECSUB#` GSI1 key, read by `queryFollowers` for the `onRecordChanged` fan-out in `notify.js` ([API: Record follows](api.md#record-follows)).
  - `record-contributor.js`: the one registrant of the `self_edit` and `tag` contribution ops (HFY-TSK-178): a contributor on `applyBatch`'s commit-hook registry that adds the event, the `CAP#` daily marker and the counters inside the batch's own transaction ([API: Contributions ledger](api.md#contributions-ledger)).
  - `record-change-fanout.js`: the render-outbox consumer (HFY-TSK-178), the only caller of `onRecordChanged`: dedupe claims `RECFAN#`, silent seeds, baselines and withdraws, the follower sweep of a withdrawn person, and the stream and replay handlers `index.js` routes to ([API: Record-change fan-out](api.md#record-change-fan-out)).
  - `guard.js`: the R-18 contact-information guard on post and comment text, and the `HFY_GUARD_DOB` switch.
  - `upload-guard.js`: `checkLocation`, the location-metadata refusal on uploaded photos, and `headUpload`, the `HeadObject` of a comment photo with a 2 s timeout.
  - `txn.js`: `transact()` (puts, deletes, updates, checks, token, conflict retry), the counter, merge and size helpers, and audit items.
  - `keys.js`: table key layout.
  - `allowlist-store.js`: the `ALLOW#` grant and revoke transaction items (conditional, audited) and the composite member reader that the auth edge and any later allowlist consumer, such as the chat directory route, share (HFY-TSK-134).
  - `access-requests.js`, `mailer.js`: the access-request admin routes (HFY-TSK-141): the queue, the decisions (`link`, `new`, `decline`, `revoke`, a held second email), the member's second-email routes and their held-member gate (`secondEmailGate`), the `completeAccessRequest` hooks the proposal approval and the id policy call, and the SES sender for their mail.
  - `notify.js`: push notifications and their templates.
  - `uploads.js`: the upload route (`purpose` `post` or `comment`) and the `UPLOAD#` binding.
  - `presign.js`: the S3 presigners: the presigned PUT (photo uploads and the sync blob upload) and the presigned GET (the sync snapshot and blob downloads).
  - `sync/store.js`, `sync/apply.js`, `sync/hooks.js`: the cloud record store: key and item builders, `applyBatch()` (one `TransactWriteItems` per batch with the dense seq, receipt, GID guard and audit), and the commit-hook registry. The desktop push routes call `applyBatch()` ([API: The cloud record store](api.md#the-cloud-record-store)).
  - `sync/id-policy.js`: the Q2-03 cloud ID policy of `applyBatch()` (HFY-TSK-246), two branches chosen by `ctx.idPolicy` or `HFY_ID_POLICY` (`mint` or `assign`; unset keeps the strict pre-policy behaviour). `mint` fills a web-origin create's empty `gramps_id` from `SYNC#HEAD.id_next.<Class>` (`I8000` to `I8999`) in the same transaction under the `GID#` guard, and the desktop may not create into the block. `assign` leaves it empty, allows the desktop's first empty-to-ID assignment once, and runs `completeAccessRequest` after the commit. The mode is the answer to gate `q2-03-id-block`. The push routes reach it through `applyBatch()` ([API: The cloud ID policy](api.md#the-cloud-id-policy)).
  - `sync/validator.js`, `sync/checker.js`, `sync/schema.js`, `sync/view.js`, `sync/errors.js`: the server validator that `applyBatch()` runs on every call (HFY-TSK-245): step-up and the destructive budget, the Gramps schema and `MediaRef.rect`, the privacy checker over `gramps/redaction/redaction-v1.json` (with RFC 6901 pointers, across the store view and the batch), id rules and integrity. It reads `gramps/schema/gramps-6.0.6.schema.json` and the policy, which `scripts/ci/package-api.sh` stages beside `src/`. `applyBatch()` runs it for the push routes, and the push session completion reuses its integrity rules ([API: The server validator](api.md#the-server-validator)).
  - `sync/auth.js`, `sync/guard.js`, `sync/routes.js`: the front door of `/api/sync/*` (HFY-TSK-172): the `sync-bearer` authenticator and the gramps-owner and step-up checks, the `SYNC_API_ENABLED` switch and the handshake middleware, and the `sync.meta` and `sync.bind` routes. `SYNC_ROUTES` lists every sync route, the push and pull routes included ([API: The sync API](api.md#the-sync-api)).
  - `sync/push.js`, `sync/media.js`: the desktop push routes (HFY-TSK-173): the push sessions (open, complete, abort), `POST /api/sync/batches` through `applyBatch()` with origin `desktop` (`seed` inside the seed session), and the blob path: presign to `media/.staging/<handle>/<sha256>`, finalize with `CopyObject` after the Media op commits ([API: The push routes](api.md#the-push-routes)).
  - `sync/pull.js`: the desktop pull routes (HFY-TSK-174): the snapshot `GET /api/sync/snapshot` (a gzip JSONL of every head from the `records/index.js` store view, cached per seq at `snapshots/<seq>.jsonl.gz` in the sync bucket and handed out as a 300 s presigned GET), the blob download, the status heartbeat (`SYNC#CLIENT#<instance>`) and the conflict queue with its owner-plus-step-up decision. The three POST routes set `pausedOk`, so a paused store still serves them. The change feed is phase B ([API: The pull routes](api.md#the-pull-routes)).
  - `records/ops.js`: the EditOp engine: keyed list addressing, apply, inverse, three-way rebase and Gramps handle minting. It is pure (no import at all). `records/changes.js` runs it.
  - `records/semantics.js`, `records/gcalendar.js`: the Gramps rules for edited records (dates and `sortval`, references, two-sided family links, ancestry cycles, derived birth and death indexes) and the port of Gramps' calendar arithmetic. Pure. `records/changes.js` runs `semantics.js` on every part of a submission.
  - `records/relationships.js`, `records/duplicates.js`: the relationship intent compiler (parents, children, spouse and unlink intents to Gramps Family and ChildRef EditOps, checked with `semantics.js`) and the accent-stripped duplicate-name matcher. Pure. `records/relationship-routes.js` calls both.
  - `records/relationship-routes.js`: `POST /api/relationships/preview` and `POST /api/relationships` (HFY-TSK-210), behind the `HFY_EDITING` switch: it compiles a member's intent with `records/relationships.js`, looks for duplicates with `records/duplicates.js` over the viewer's own view of the records, and takes the `POST /api/changes` pipeline of `records/changes.js`. A member's relationship is always a proposal; an admin's applies through `applyBatch()` unless it asks for review ([API: Relationship routes](api.md#relationship-routes)).
  - `records/guard.js`: the R-18 and R-19 guard for every edit path: an adapter over `shared/edit-guard.mjs`, which wraps the one text detector (`shared/privacy-guard.mjs`) and the one `isBirthLike` predicate (`shared/redaction-rules.mjs`) with `gramps/redaction/redaction-v1.json`. It scans every string leaf of the resulting objects, proposal notes, decision reasons and relationship stub fields, applies the structural never-rules, and throws a 422 (`contact_info`, `dob_not_allowed` or `never_in_cloud`) with pointers and spans only; its log line carries counts per code. `scripts/ci/package-api.sh` stages the policy file beside `src/`. The browser mirror is `islands/src/lib/edit-guard.js`; `shared/edit-guard.cases.json` is the corpus all three run. `records/changes.js` calls it before the partition.
  - `records/field-policy.js`, `records/edit-plan.js`: the field-policy table (class, pointer pattern, own, other), io's Q2-15 switches, the own-record resolver, the op classifier, the partition into direct and review groups and the plain-language summaries. A Person `urls` element is writable on the web only as a link kind (Web Home, or a Custom type named for one of the seven link kinds); any other Url type is desktop-only, and an E-mail Url stays `never` (editing.md 3.2; HFY-TSK-329). Attribute and Url elements are judged as the op leaves them, so a retype through one field of the type counts. The classifier names the reason in `kinds` (`url_not_link`, `url_email`). `GET /api/me` reaches `ownRecord` and the edit bundle reaches `relationOf` and the policy table through `records/edit-bundle.js`; `records/changes.js` calls `classifyOps` and `edit-plan.js`. The page [Field policy](field-policy.md) is generated from this table by `scripts/records/gen-field-policy-doc.mjs` (`--check` fails on drift); `scripts/docs/check-relative-links.mjs` checks the relative links of the docs pages, and `scripts/ci/test/editing-docs.test.mjs` runs both in CI.
  - `records/index.js`: the read accessors over the record store (HFY-TSK-244): `get`, `byGrampsId` (GSI1 `RECS#<Class>`, tombstones excluded), `backrefs`, `graph` (cached up to 60 s) and `customTypes`, on the store view (the latest snapshot plus a fold of `SYNC#LOG`). Read-only. Its `storeView(ctx)` is async and takes the store context, so it is not the `ctx.storeView(store, {now, prefetched})` that `applyBatch()` accepts. The records read routes (`records/read.js`), the edit routes (`records/edit-bundle.js`) and the sync snapshot route (`sync/pull.js`, through `storeView`) reach it ([API: Source files](api.md#source-files)).
  - `records/read.js`: the read-only records API (HFY-TSK-175): `publishView` (year-only non-birth dates for non-admins, HFY-R76), `applyModOverlay` (open `MOD#` items hidden), `viewRecord` and the routes `GET /api/records/:class/:handle` and `GET /api/records/Person/by-id/:gramps_id`, both behind the `HFY_EDITING` switch (`recordsGate`). No write route, no MCP tool ([API: Records read API](api.md#records-read-api)).
  - `records/edit-bundle.js`: the editing API core (HFY-TSK-182): the edit bundle `GET /api/edit/:cls/:ref`, the schema route `GET /api/edit/schema/:cls`, the `HFY_EDITING` gate (404 for everyone while off) and the `ownRecord` and `editing` fields of `GET /api/me`. Read-only; it goes through `viewRecord` (`records/read.js`).
  - `records/changes.js`, `records/proposals.js`: `POST /api/changes` (HFY-TSK-183): the pipeline (request, stored state, guard, field-policy partition, semantics and schema, step-up, rate limit, size budget) and one transaction that carries the direct groups through `applyBatch()` and the proposal (`PROP#`, `IDX#`, `AUDIT#proposal:`) and `IDEM#` receipt as its `extra`; `proposals.js` holds the proposal document, its items, etag and limits ([API: Editing API changes](api.md#editing-api-changes)).
  - `records/proposal-decision.js`: `POST /api/proposals/:id/decision` (HFY-TSK-209): deny and needs_changes in one transaction; approve with the rebase of editing 7.5 and one `applyBatch()` transaction whose proposal state, copies, audit, receipt, `completeAccessRequest` fragment and `proposal_accepted` credit ride in a contributor local to the call (so `extra` stays out of the idempotency hash); `stale` and `superseded` on a conflict, a system `needs_changes` when the guard now refuses; step-up for a destructive approval ([API: The proposal decision](api.md#the-proposal-decision)).
  - `onthisday/build.js`, `onthisday/select.js`: the on-this-day index builder and day selector. Pure functions with no route yet (HFY-TSK-168); the copy deck is `shared/onthisday-copy.mjs`.
- [`api/scripts/scan-contact-info.mjs`](../../api/scripts/scan-contact-info.mjs): the one-off, read-only scan of existing posts and comments for contact information; counts only ([API: Contact-information guard](api.md#contact-information-guard)).
- [`api/scripts/contrib-backfill.mjs`](../../api/scripts/contrib-backfill.mjs): the one-off backfill of the contributions ledger: credits the posts and comments written before it, then rebuilds every `CSTAT#` counter from the events. `--dry-run` writes nothing, and `--apply` is idempotent and runs only with io's go-ahead ([Backfill the contributions ledger](../how-to/backfill-the-contributions-ledger.md)).
- [`api/scripts/sync-admin.mjs`](../../api/scripts/sync-admin.mjs): the operator tool for the record store and its renderer (HFY-TSK-177): `pause` and `resume` (`SYNC#HEAD.writes_enabled`), `render` (`--full`, `--allow-mass-delete`, `--prune-foreign`; invokes the render function) and `resurrect --batch <id>` (re-creates a batch's deleted or withdrawn heads from the log within the 72-hour grace). Every command takes `--dry-run` or `--apply`; a production `--apply` runs only with io's go-ahead, recorded in the worklog ([Operate the sync store](../how-to/operate-the-sync-store.md)). Never deployed; tested in `api/test/sync-admin.test.js`.
- [`api/scripts/sync-dev-server.mjs`](../../api/scripts/sync-dev-server.mjs): the local sync dev server (HFY-TSK-181). It runs the real `/api/sync/*` handler on `127.0.0.1` over the in-memory table (`api/test/fake-ddb.js`), a temporary directory in place of S3 (Head, Get, Put, Copy and Delete, and presigned URLs under `/_s3/`), and a development sign-in server (`/auth/authorize`, `/auth/token`, JWKS) that signs tokens with a key made at start-up. It logs every request body to `requests.jsonl` before answering, and has `/_dev/` switches for the store head and the token lifetime. It is a script only: `package-api.sh` leaves `api/scripts/` out of the Lambda zip, and no route reaches it. The end-to-end scenarios use it ([Run the test suites, step 15](../how-to/run-the-tests.md#15-run-the-sync-end-to-end-scenarios-local-gramps-606)); its tests are `api/test/sync-dev-server.test.js`.
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
- `POST /api/uploads` returns a presigned S3 PUT for a key under `uploads/posts/<ulid>/` in the site bucket, or under `uploads/comments/<ulid>/` for `purpose` `comment`, which needs `commentPhotosV1`. The content type is signed, so S3 rejects a PUT with a different `Content-Type`.
- The browser PUTs to the bucket's S3 endpoint, not through CloudFront, so a members-only `/uploads/*` never sees an upload (`api/test/presign.test.js`). Reading a photo back goes through CloudFront's `/uploads/*` behavior: see [Infrastructure](#infrastructure).
- Push notifications are sent only when the stack parameter `VapidSecretName` names a VAPID secret. The live secret is `harrisonfamily/api/vapid`, a JSON `{subject, publicKey, privateKey}` whose `subject` is an `https://` URL, so no email address goes to the push services. Without the secret, subscriptions and preferences are stored but nothing is sent. See [How to turn on push notifications](../how-to/turn-on-push-notifications.md).
- The lock-screen preview on `/me/notifications/` (`CATALOG` in `islands/src/lib/notify-catalog.js`) repeats the push text in `notify.js` (`TEMPLATE_REGISTRY`) word for word. It holds every registry type except `chat_message` and `access_request_new` (the auth edge's admin inbox item, no toggle), which the chat task adds. The catalog lives in the lib file, not in `notifications.jsx` (HFY-TSK-185 moved it so the contract test can import it in Node); `notifications.jsx` re-exports `CATALOG`. Its "for moderators" group (`proposal_submitted`, `moderation_resolved`) is an implementer choice that the design pack does not spell out: the settings page shows it only when `/api/me` reports `admin`, the same `actor.admin` signal the server uses to pick those types' recipients (`getAdmins`, `config/admins.json`). `islands/tests/notify-catalog.test.mjs` (in `npm run test:contract`) compares the two and fails on a type id or a title, level 0 or level 1 string that differs. See [Notifications](api.md#notifications).
- `api/dist/` is gitignored.
- `package-api.sh` needs `CODEARTIFACT_AUTH_TOKEN`. It runs `gen-caps.mjs` inside its staging copy, so the zip holds all four generated documents. Only `caps.json` is copied back to `api/dist/`.
- `api/` and `auth/` pin the same `@io-kit/auth` version, 2.2.2.
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
- There are eleven tools, one for each route with an `mcp` member: `hfy_comments_list`, `hfy_comments_create`, `hfy_comments_delete`, `hfy_posts_list`, `hfy_posts_get`, `hfy_posts_create` and `hfy_posts_delete`, and the editing tools `hfy_records_get`, `hfy_changes_submit`, `hfy_proposals_list` and `hfy_proposals_get` (HFY-TSK-211). The editing tools answer `404` while `HFY_EDITING` is off. There is no tool to decide, amend or withdraw a suggestion (DEC-E5).
- `withPlanPreview` in `mcp.js` wraps the kit server: an allowed `dry_run` of `hfy_changes_submit` carries the route's own plan. On this server a call without `mode` submits, because the kit edge makes every caller a person.
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
  - `allowlist.js`: the composite allowlist resolver passed to the identity service and the Cognito provisioner: a DynamoDB `ALLOW#` item wins over io's S3 file (HFY-TSK-134).
  - `membership.js`: the composite allowlist (S3 file plus `ALLOW#` items) and admin groups for MCP tokens.
  - `cognito.js`: Cognito user provisioning for `POST /auth/link`, and `cognitoFirstPassword`, the first password for an allowlisted member through the forgot-password code (SURF-D18, behind `FIRST_PASSWORD`).
  - `linkstore.js`: the account-link store.
  - `passkeystore.js`: the passkey credential store.
  - `ratelimit.js`: request counters.
  - `access-request.js`: the anonymous access-request routes (`config`, `start`, `verify` and the submit, `POST /auth/access-request`) behind `ACCESS_REQUESTS`: Turnstile, the honeypot, the rate limits, the queue cap, the code and the ticket, and the mail alarm gate (HFY-TSK-195).
  - `mailer.js`: the SES sender for access-request mail, over the templates in `shared/emails.mjs`.
  - `admins.js`, `admin-notify.js`, `flags.js`: the admin principals and addresses, the admin inbox item (`access_request_new`, through the kit's delivery and `shared/notify-registry.mjs`) and the site flags reader that gates it, all for the submit's notices (HFY-TSK-196).
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
- The user pool allows only admin-created users. `cognito.js` creates a user only on `POST /auth/link` and, while `FIRST_PASSWORD` is on, on `POST /auth/password/forgot` (SURF-D18, io's Q2-12), in both cases after the allowlist check.
- `linkstore.js` writes `GSI1SK` on every `LINK#` item, and `passkeystore.js` on every `PASSKEY#` credential item, so both are found through `GSI1`. Both repair older items when they read them.
- `ratelimit.js` limits `POST /auth/password/forgot` and the access-request routes with fixed-window counters in `hfy-app`.
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
- [`graph/test/`](../../graph/test/): `node:test` suites `build`, `schema`, `verify`, `source`, `cli`, `generations`, `photo-edges`, `layout` and `layout-budget`. `fixtures/gramps.mjs` builds the synthetic Gramps objects, `fixtures/layout-messy.mjs` and `fixtures/synth.mjs` are the layout fixture and the seeded generator, and `fixtures/messy.graph.golden.json` is the golden output.
- [`infrastructure/cloudformation/edge-gate-stack.yaml`](../../infrastructure/cloudformation/edge-gate-stack.yaml): the us-east-1 stack `hfy-edge-gate`, with the function, its role and a retained version. Its output `EdgeGateVersionArn` is the version to attach.
- [`scripts/ci/package-edge-gate.sh`](../../scripts/ci/package-edge-gate.sh): builds `dist/hfy-edge-gate.zip`.
- [`scripts/infra/add-data-gate-behaviors.sh`](../../scripts/infra/add-data-gate-behaviors.sh): attaches the gate to the data paths and `/uploads/*`, or detaches it with `--remove`.
- [`scripts/cloudfront/append-index.js`](../../scripts/cloudfront/append-index.js): the default-deny for spellings of the data paths that no gated behavior matches. See [CloudFront Function](#cloudfront-function).
- The client data path:
  - [`11ty/js/feature-flags.js`](../../11ty/js/feature-flags.js): `dataFetchInit`, `dataFetch` and `edgeSession` (see [Front-end runtime](#front-end-runtime)).
  - [`11ty/js/person-page.js`](../../11ty/js/person-page.js): the page script that reads person data.
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
- While the gate is attached, an automatic rollback or a revert that restores a `flags.json` with `authV2` false, or any change that sets `authV2` false, locks visitors out of the family data: the client then never refreshes the `io_id` cookie that the gate checks, and nothing else opens the data. Remove the gate first: `add-data-gate-behaviors.sh --remove --app-stack <app-stack>`, with `us-west-2` as the CLI's region, or with `--restore-uploads-policy-id`. For what `--remove` changes, see [Infrastructure](#infrastructure); for what the data paths answer afterwards, see [CloudFront Function](#cloudfront-function).
- No workflow builds, deploys or attaches the gate. Building, validating and deploying it: [How to deploy and update the Lambda@Edge functions in us-east-1](../how-to/deploy-the-edge-functions.md). Why it exists: [Gating the JSON](../explanation/family-data-privacy.md#gating-the-json).

## Family graph builder

Paths:

- [`graph/bin/build-graph.mjs`](../../graph/bin/build-graph.mjs): the command line. [`graph/src/cli.mjs`](../../graph/src/cli.mjs) holds the argument handling, the exit codes and `--verify` / `--verify-against`.
- [`graph/src/source.mjs`](../../graph/src/source.mjs): the record sources: a file of JSON lines, stdin, or `sqlite3 -readonly` on a copy of the Gramps tree.
- [`graph/src/project.mjs`](../../graph/src/project.mjs): the allowlist projection. [`graph/src/generations.mjs`](../../graph/src/generations.mjs) is the generation index (components, generations, levels). [`graph/src/build.mjs`](../../graph/src/build.mjs) assembles the graph, [`graph/src/verify.mjs`](../../graph/src/verify.mjs) is `verify()`, and [`graph/src/write.mjs`](../../graph/src/write.mjs) is the atomic writer.
- [`graph/src/layout.mjs`](../../graph/src/layout.mjs): the `layout` block, the poster layout that d3-dag 1.2.2 (a build-time dependency of `graph/` only) computes. [`graph/src/geocode.mjs`](../../graph/src/geocode.mjs): offline geocoding of place names. [`graph/src/gazetteer.mjs`](../../graph/src/gazetteer.mjs) reads the pinned GeoNames and Natural Earth cache, and [`graph/bin/fetch-gazetteer.mjs`](../../graph/bin/fetch-gazetteer.mjs), the only network path, fills it and pins [`graph/gazetteer.lock.json`](../../graph/gazetteer.lock.json).
- [`graph/src/faces.mjs`](../../graph/src/faces.mjs): face crops from Gramps region rects (sharp, a build-time dependency of `graph/` only), written to `<staging>/media/faces/`.
- [`graph/schema/family-graph.v1.schema.json`](../../graph/schema/family-graph.v1.schema.json): the schema of `person/graph.json`.
- [`graph/test/`](../../graph/test/): the `node:test` suites and their synthetic fixtures. See [Tests](#tests).

Facts:

- It is a private Node 22 package. Its build-time dependencies are `sharp` and `d3-dag`, installed with `npm ci` in `graph/`. It runs by hand on io's machine, on a copy of the Gramps tree or on JSON lines. No workflow builds the graph or runs its tests. The refresh runbook publishes `person/graph.json` by hand, through steps 2b and 4 of [`sync-gramps-with-the-website.md`](../how-to/sync-gramps-with-the-website.md), and nothing reads it yet.
- Nothing reads the live Gramps database. `--from-gramps-copy` refuses when the copy's `lock` file exists, opens the copy read-only and streams the rows over a pipe, so no unredacted JSON lines reach a file.
- The projection copies only the allowlisted fields, as years and ids. `verify()` runs before every write, and a failure writes nothing.
- The output is deterministic and written by temp file and rename, so a failed run leaves the previous `graph.json` as it was.
- The generation index, face crops and geocoding are later tasks. Their fields are in the schema and are `null`, `0` or empty until then.

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

## Retired legacy sign-in

HFY-TSK-317 took the legacy Google sign-in out of the code and the pipeline, and deleted nothing in the cloud (ruling P2-R42). The cloud pieces went on 2026-10-14:

- With io's approval, the Google Cloud pieces were deleted: the `getAllowlist` Cloud Function, its secret and its deploy key. HFY-TSK-325 then removed their repository leftovers: `deploy-gcf-legacy.yml`, the function source in `functions/get-allowlist/` and its sample copy in `gcloud/allowlist-fn/`, and the sync check's comparison of the two.
- Under ruling P2-R48, HFY-TSK-326 deleted the `hfy-check-allowed` Lambda, its API Gateway, its IAM role and its log group. It removed the repository leftovers: the source in `lambda/hfy-check-allowed/`, the `/api/check-allowed*` pin and the `--legacy-origin` option of `add-api-behavior.sh` (with `resolve_pin` and `place_pin` in `cf.jq`), the sync check's `lambda/*` comparison, and the function's grant in `github-roles.yaml`.

Paths: none. The last sources are in the Git history.

Facts:

- No page loads Google Identity Services or calls `/api/check-allowed`. `js/auth.js`, `js/search-navbar.js` and `js/search-results.js` are deleted, and `/family-login/` redirects to `/auth/login`.
- `hfy-check-allowed` verified a Google ID token and checked an HMAC of the email against the hashed allowlist. Production CloudFront has no `/api/check-allowed*` behavior, so `/api/check-allowed` reaches `hfy-api` through `/api/*` and gets `404`.
- `ci.manifest.yaml` has no `lambda` target (HFY-TSK-317).
- The pre-commit sync check compares only `11ty/`. It has no Lambda or Cloud Function comparison.
- The hashed allowlist went too, under ruling P2-R51 on 2026-10-14: the allowlist publisher's digest step was removed, `config/allowed_hashes.json` was deleted, and the `HFY_ALLOWLIST_HMAC_SECRET` secret that keyed it was scheduled for deletion on 2026-11-13.
- Still in AWS: the deployed deploy-role stack keeps its grant on the deleted function until the GitHub-roles stack is next updated.

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
- [`infrastructure/cloudformation/site-bucket-cors.json`](../../infrastructure/cloudformation/site-bucket-cors.json): the site bucket's whole CORS configuration, for browser photo uploads. It is not a CloudFormation template: [How to stand up the static site](../how-to/stand-up-the-static-site.md#1-create-the-site-bucket) applies it with `put-bucket-cors`.
- [`infrastructure/cloudformation/site-bucket-lifecycle.json`](../../infrastructure/cloudformation/site-bucket-lifecycle.json): the lifecycle rule that expires leftover `media/.staging/` blobs of the desktop sync (HFY-TSK-173) after 2 days. Not a CloudFormation template either: [How to stand up the static site](../how-to/stand-up-the-static-site.md#1-create-the-site-bucket) applies it with `put-bucket-lifecycle-configuration`.
- [`scripts/infra/`](../../scripts/infra/):
  - `create-session-key.sh`: the session signing key.
  - `create-origin-verify.sh`: the origin-verify secret.
  - `add-api-behavior.sh`, `add-auth-behavior.sh`, `add-uploads-behavior.sh`, `add-mcp-behavior.sh`, `add-data-gate-behaviors.sh`: CloudFront origins and behaviors.
  - `check-site-bucket-cors.sh`: the live check of the bucket's CORS rule, by preflight requests without credentials. `post-deploy-checks.yml` runs it.
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
- The deploy role's Lambda permissions cover `hfy-api` and `hfy-auth-edge` in us-west-2. The template dropped `hfy-check-allowed` with HFY-TSK-326; the deployed stack keeps that grant until it is next updated. Its only CloudFront permissions are invalidations on the site's distribution.
- The deploy role has no permission on `hfy-edge-gate`, `hfy-mcp-edge401`, any CloudFormation stack or any CloudFront Function, so CI can deploy neither edge stack nor `HFYAppendIndex`.
- `add-auth-behavior.sh` adds the `hfy-auth-edge` origin and two behaviors, `/auth/*` and `/.well-known/oauth-authorization-server*`.
- `add-api-behavior.sh` adds the `hfy-api` origin and creates the `/api/*` behavior, or retargets an existing one in place. Since HFY-TSK-326 it adds no `/api/check-allowed*` pin and has no `--legacy-origin` option.
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
- `distribution.json` shows the pre-app layout: an S3 origin and the default behavior, with no cache behaviors. Its legacy API Gateway origin and `/api/*` behavior were removed with HFY-TSK-326. It shows none of the behaviors that the behavior scripts add, so a gate dry run against it creates all seven gated behaviors, `/uploads/*` included.
- The comments in `app-stack.yaml` (`UploadsResponseHeadersPolicy`) describe both `/uploads/*` states and the direct PUT to S3. `site-bucket-cors.json` is plain JSON with no comment, because `put-bucket-cors` rejects any key it does not know; [Architecture](architecture.md#site-bucket) documents the rule.

## CI and repo operations

Paths:

- [`ci.manifest.yaml`](../../ci.manifest.yaml): the pipeline definition.
- [`.github/workflows/io-kit-ci.yml`](../../.github/workflows/io-kit-ci.yml), [`.github/workflows/io-kit-deploy.yml`](../../.github/workflows/io-kit-deploy.yml): rendered from `ci.manifest.yaml` by `@io-kit/ci` 0.1.3. Each carries a "do not edit" header.
- [`.github/actions/io-kit-ci/`](../../.github/actions/io-kit-ci/): the composite actions those workflows call. They are `build`, `package`, `deploy-static`, `invalidate`, `smoke`, `rollback`, `parity-report` and `secret-scan`. The manifest has no Lambda target, so the kit renders no `deploy-lambda` action.
- [`.github/workflows/post-deploy-checks.yml`](../../.github/workflows/post-deploy-checks.yml): checks the kit's smoke job cannot express, run after each successful deploy run. Hand-maintained.
- [`scripts/ci/`](../../scripts/ci/):
  - None is the manifest build command any more: it only echoes, because `11ty/` is committed output.
  - `build-islands.sh`, `package-api.sh`, `package-auth.sh`, `package-edge-gate.sh` and `package-render.sh` are local build scripts.
  - `mcp-conformance.sh` is the MCP conformance gate. See [MCP server](#mcp-server).
- [`scripts/git-hooks/pre-commit`](../../scripts/git-hooks/pre-commit): the pre-commit hook.
- Workspace helpers: [`scripts/check-deployment-sync.sh`](../../scripts/check-deployment-sync.sh), [`scripts/promote_workspace_assets.sh`](../../scripts/promote_workspace_assets.sh), [`scripts/sync_sanitized_assets.py`](../../scripts/sync_sanitized_assets.py), [`scripts/validate_build.sh`](../../scripts/validate_build.sh).

Facts:

- `io-kit-ci.yml` runs on pull requests and on manual dispatch. It runs the build, a blocking parity report (`pipeline_drift` fails the job), and a TruffleHog scan.
- `io-kit-deploy.yml` runs on push to `main` and on manual dispatch. Its jobs run in this order: build, package, deploy, invalidate, smoke, then rollback if the smoke check fails.
- The build job runs the manifest's echo command on Node 22. The package job uploads `11ty/` as the artifact `io-kit-release-<sha>`.
- The deploy job runs one `aws s3 sync 11ty/ s3://<site-bucket>/ --delete`. The sync has no HTML-last ordering, so a page can go live a moment before a file it references by a new `?v`.
- The sync excludes `person/*.json`, `media/*`, `family/*`, `event/*`, `note/*`, `place/*` and `uploads/*`, and never deletes the excluded paths.
- The invalidation covers `/*`, and the job waits for it to complete. Until it does, CloudFront can serve the old object for a new `?v`, because the default behavior's cache policy (CachingOptimized in the sample) leaves the query string out of the cache key.
- The smoke job requests the home page and `/family-login/`. Any status outside 2xx and 3xx fails it.
- `post-deploy-checks.yml` runs on `workflow_run` when an `io-kit deploy` run on `main` completes successfully, and by hand. It runs `scripts/infra/check-site-bucket-cors.sh`, the bucket CORS preflights, which the smoke job cannot express: its entries are URLs it requests with `GET`. A failure there rolls nothing back.
- The rollback strategy is `previous_artifact`. It redeploys the artifact of the last successful `io-kit-deploy.yml` run on the branch. That artifact's `flags.json` comes with it; see [Private data gate](#private-data-gate) for why that matters while the gate is attached.
- The pipeline builds no islands, and deploys none of `hfy-api`, `hfy-auth-edge`, `hfy-edge-gate`, `hfy-mcp-edge401` and `HFYAppendIndex`. `ci.manifest.yaml` has no target for any of them.
- `build-islands.sh`, `package-api.sh`, `package-auth.sh`, `package-edge-gate.sh`, `package-render.sh`, `mcp-conformance.sh` and `publish-append-index.sh` are not run by any workflow.
- The pre-commit hook runs `check-deployment-sync.sh`, then a `trufflehog` filesystem scan. It fails when `trufflehog` is not installed.
- The hook runs only when `core.hooksPath` is `scripts/git-hooks`.
- The workspace helpers treat the checkout's parent directory as `<project>`.

## Tests

Paths:

- [`api/test/`](../../api/test/): Vitest. The suites are `api`, `contracts`, `hardening`, `jwks`, `labels`, `mcp`, `mcp-conformance`, `mcp-infra`, `origin`, `package-api`, `presign`, `producers`, `sync-apply`, `sync-push` and `txn`. `fake-ddb.js` and `world.js` are helpers.
- [`api/test/records/`](../../api/test/records/): `node:test` suites `ops.node-test.js` (the EditOp engine), `semantics.node-test.js` (the Gramps rules, run against `fixtures/gramps-semantics.golden.json`, the values Gramps 6.0.6 computed), `relationships.node-test.js` (the relationship compiler and the duplicate matcher, run against `fixtures/gramps-relationships.golden.json`, the objects Gramps 6.0.6 left after each scenario) and `guard.node-test.js` (the edit guard, run against `shared/edit-guard.cases.json`). Run by `npm test` after Vitest.
- [`auth/test/`](../../auth/test/): Vitest. The suites are `cognito`, `edge`, `linkstore`, `oauth`, `origin`, `passkey`, `passkeystore` and `userinfo`. `fake-table.js` is a helper.
- [`auth/e2e/passkey.e2e.mjs`](../../auth/e2e/passkey.e2e.mjs): a Playwright end-to-end passkey test.
- [`auth/e2e/signin-theme.e2e.mjs`](../../auth/e2e/signin-theme.e2e.mjs): a Playwright end-to-end test of the styled sign-in pages.
- [`edge-gate/test/gate.test.mjs`](../../edge-gate/test/gate.test.mjs): `node:test`.
- [`tests/client/`](../../tests/client/): `node:test` suites `auth-continuity.test.mjs` and `data-fetch.test.mjs`.
- [`islands/tests/`](../../islands/tests/):
  - `node:test` suites: `asset-versions`, `bundle`, `content-contract`, `contract`, `copy`, `feed-conformance`, `kit-aliases`, `theme-delivery`, `theme-lint`, `time` and `uploads-gate`.
  - Playwright specs: `asset-versions`, `auth-continuity`, `d11-fixes`, `flags-fallback`, `islands-look`, `legacy-pages`, `notifications`, `notifications-roundtrip`, `person`, `person-page`, `posts`, `qa-fixes`, `qa2-fixes`, `search`, `shell`, `sw` and `theme-foundation`.
  - Fixtures, all synthetic: `fixtures/islands-look.json`, `fixtures/person-legacy.json`, `fixtures/person-synthetic.json` and `fixtures/tree-synthetic.svg`.
- [`scripts/cloudfront/test/`](../../scripts/cloudfront/test/): `node:test` suite `append-index.test.mjs` and its case table `append-index.cases.json`.
- [`scripts/infra/test/`](../../scripts/infra/test/):
  - `run.sh`: offline tests for `scripts/infra`, `scripts/ci/package-edge-gate.sh`, `scripts/ci/package-render.sh`, `scripts/check-deployment-sync.sh`, the repo-owned `11ty/` paths and the CloudFront Function.
  - `test_app_stack.py`: static checks on `app-stack.yaml` and `github-roles.yaml`.
  - `test_edge_gate_stack.py` and `test_mcp_edge401_stack.py`: static checks on the two us-east-1 templates.
  - `test_privacy_terms_pages.py`: `11ty/privacy/index.html` and `11ty/terms/index.html` carry each required section of the approved privacy and terms amendment, `docs/drafts/privacy-terms-2026-10-update.md` (HFY-TSK-239).
  - `stub/aws`, `cf-echo.jq`, `fixtures/live-like.json` and `fixtures/live-with-uploads.json`: test doubles.
- [`tests/login-flow/`](../../tests/login-flow/): the Playwright spec `auth-v2.spec.ts`. The legacy `login-flow.spec.ts` is deleted with the Google sign-in it drove.
- [`gramps/tests/unit/test_gramps_goldens.py`](../../gramps/tests/unit/test_gramps_goldens.py) and [`test_gramps_relationship_goldens.py`](../../gramps/tests/unit/test_gramps_relationship_goldens.py): `unittest`, standard library only. They run [`scripts/records/check_gramps_goldens.py`](../../scripts/records/check_gramps_goldens.py) and [`check_relationship_goldens.py`](../../scripts/records/check_relationship_goldens.py) over the committed Gramps goldens and check that tampering is caught.
- [`gramps/tests/e2e/`](../../gramps/tests/e2e/) (HFY-TSK-181): the end-to-end lane. `run.sh` reuses the Gramps lane's runner (`gramps/tests/gramps/run.sh`, lane set by `HFY_LANE_DIR`) for `scenario_*.py` files: `scenario_smoke.py` (bind, status, the empty check, the request-log greps) and `scenario_signin.py` (the addon's PKCE login and token manager against the dev sign-in server). `e2e_support.py` starts the dev server as a subprocess, signs in with no browser and an in-memory Keychain, and reads the request log; `e2e_case.py` is the scenario base class. Local, Gramps 6.0.6, Node 22 and `api/node_modules`; CI runs only the plumbing, [`gramps/tests/unit/test_e2e_support.py`](../../gramps/tests/unit/test_e2e_support.py), with a stub server.
- [`gramps/tests/unit/test_render_lambda.py`](../../gramps/tests/unit/test_render_lambda.py), [`test_render_lambda_privacy.py`](../../gramps/tests/unit/test_render_lambda_privacy.py), [`test_render_lambda_view.py`](../../gramps/tests/unit/test_render_lambda_view.py) and [`test_render_lambda_aws.py`](../../gramps/tests/unit/test_render_lambda_aws.py): the render Lambda (HFY-TSK-176) over the in-memory fakes of `render_lambda_support.py`. Standard library only; the boto3 adapter tests skip when boto3 is missing, and the reference walk is also compared with `collectRefs` in `api/src/records/semantics.js` when `node` is installed. See [The render Lambda](sync-render.md).
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
- `tests/client` loads the real `11ty/js/feature-flags.js` into a `vm` sandbox with a stubbed `fetch`. It needs no install: `node --test tests/client/*.test.mjs` from the repository root. `auth-continuity.test.mjs` also covers the `/family-login/` redirect page's `?next=` hand-over to `returnTo`.
- The islands content-contract test drives the real `api/` handler.
- `bundle.test.mjs` checks that every build output is tracked, present and identical to a fresh build.
- `npm run test:contract` in `islands/` runs every `node:test` suite there, the theme lint included. `npm test` runs those and then the Playwright specs.
- The island Playwright specs run at 375 px width in Chrome (`PW_CHANNEL` names another channel) against `npx http-server <site> -p <port> -a 127.0.0.1 -s -c-1`. The site defaults to `../11ty` and the port to `8089`, so by default they use the committed bundles. `HFY_SITE=<dir>` and `PW_PORT=<port>` point them at a scratch build. `bundle`, `theme-delivery` and `asset-versions` honour `HFY_SITE` too.
- `/api`, `/auth` and the data files are stubbed per test. The `auth-continuity` spec models the gate as a 401 until `/auth/refresh` has succeeded.
- `node --test scripts/cloudfront/test/*.test.mjs` runs the shared case table (`rewrite`, `deny` and `awsSamples` cases), checks that nothing shipped in `11ty/` outside `person/` is denied, pins the deny lists to the gate script and `11ty/person/`, and runs an ES5 guard. `run.sh` and `publish-append-index.sh` run it too.
- `scripts/infra/test/run.sh` puts `stub/aws` first on `PATH` and never reaches AWS. It needs `bash`, `jq`, and `python3` with PyYAML.
- `run.sh` also needs `zip` and `python3` for the `package-render.sh` checks, `node`, `zip` and `openssl` for the `package-edge-gate.sh` checks, `node` for the CloudFront Function and `publish-append-index.sh` checks, and `rsync` and `git` for the `check-deployment-sync.sh` run. It skips each of those blocks when its tools are missing, and uses `cfn-lint` and `shellcheck` when they are installed.
- Besides the behavior scripts, `run.sh` covers: `/uploads/*` gated in place, its drift repair, the `--remove` restore (the `--restore-uploads-policy-id` override, the refusal when no policy can be found, a second `--remove` as a no-op, both policies kept) and the uploads policy and its repair; `publish-append-index.sh` against the stub (diff, `test-function` gate, publish, backup, idempotency and refusals); the repo-owned `11ty/` paths in `11ty/README.md` and the sync check; and the `?v` on `auth/edge.manifest.json` `theme.cssUrl`.
- `test_app_stack.py` checks that the `UploadsResponseHeadersPolicy` CSP equals `UPLOADS_CSP` and the gate script's uploads policy.
- `tests/login-flow` targets the live site by default (`HFY_SITE_BASE`).
- The `auth-v2` spec is skipped unless `HFY_AUTH_V2=1`. Its password path also needs `HFY_TEST_EMAIL` and `HFY_TEST_PASSWORD`.
- `token-smoke.sh` validates an MCP access token from `MCP_TOKEN` against the live auth edge, without printing it.
- No workflow runs any of these suites. How to run them: [How to run the test suites](../how-to/run-the-tests.md).

## Sanitized samples

Paths: [`allowlist/`](../../allowlist/), [`harrisonfamily-frontend/`](../../harrisonfamily-frontend/), [`etl-output/`](../../etl-output/), [`gramps_exports/`](../../gramps_exports/), [`cloudfront/`](../../cloudfront/), [`coming-soon-index.html`](../../coming-soon-index.html).

Facts:

- These are placeholders that show the shape of the private data. The real files live under `<project>/workspace-local/`.
- `allowlist/` holds example addresses, and example hashes in the format of the retired digest list.
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
- The source's `partials/head.njk` already emits head blocks A and B, with a hard-coded theme `?v` and font file name that the islands build overwrites in the output. The base layout does not emit the `auth-v2.js` tag, and neither the Voice copy nor the asset versions are ported, so `copy.mjs` and `assets.mjs` are still needed. The source's layout still emits the retired Google client, `auth.js`, the navbar search and the `gateway` entry, and its `public/js/` still holds `auth.js`, `search-navbar.js` and `search-results.js`, until it is ported ([Refresh the Eleventy output](../how-to/refresh-the-eleventy-output.md)).
- The ETL scripts turn the Gramps export into person JSON and family-tree media.
- `build_search_index.js` builds the person manifest and search index. The source's `build:search` step runs it.
- `publish_allowlists.sh` publishes the email-to-gramps_id map to the config bucket as `config/userGrampsID.json`, the file the auth edge reads, and does nothing else. Its hashed-allowlist and Google Secret Manager steps were removed on 2026-10-14 (ruling P2-R51).
- `mint_test_id_token.py` mints Google ID tokens for the retired legacy sign-in. Nothing in the repository runs it any more.
- `workspace-local/` holds the private family data and the real credentials.
- The workspace sources of the legacy sign-in code are also outside the repository. See [Retired legacy sign-in](#retired-legacy-sign-in).

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
| `index.html`, and `index.html` under `about/`, `contact/`, `logged-out/`, `privacy/`, `search/` and `terms/` | Repo-edited. Added by hand: `<script src="/js/auth-v2.js" defer></script>`. Removed by hand (HFY-TSK-317): the Google client, `auth.js`, `search-navbar.js`, the `HFY_AUTH_CONFIG` and `HFY_SEARCH_CONFIG` blocks, the navbar search and the `gateway` entry of the inlined config. Written by the islands build: head blocks A and B around the `main.css` link, the Voice copy, and `?v=<sha8>` on every same-origin script, stylesheet and manifest reference, the `auth-v2.js` tag included. | Overwritten. All of these changes are lost. | Overwritten too. Re-add the tag and remove the retired ones, then run the islands build, which restores the rest. | Compared, whole. |
| `person/index.html`, `private/index.html` | Repo-edited, with the same changes. | Excluded.[^dirs] | Excluded.[^dirs] | Excluded.[^dirs] |
| `family-login/index.html` | Repo-owned: a static redirect page to `/auth/login` (HFY-TSK-317), in place of the source's Google sign-in page. | Overwritten with the source's Google sign-in page. | Excluded. | Excluded. |
| `js/feature-flags.js` | Repo-edited. At the top: the `hfy-asset-versions` stamp block (`ASSET_V`), which every islands build rewrites, and the theme fallback link. Near the top: the edge overlay, `edgeOverlay` and `visibilityState()`, which `shouldShow` and `featureAPI.shouldShow` read. From `window.HFYFeatureFlags = featureAPI;` to the last `onReady(applyFeatureVisibility);`: flag resolution, the `?hfy_flags=` override and banner, the `authV2` data path (`dataFetchInit` to `dataResponse`), `loadIsland`, `assetVersions`, `whenIsland` and the per-flag loaders. The rest is the visibility gating. | Overwritten with the source copy, which lacks these edits. | Excluded. | Excluded. |
| `js/person-page.js` | Repo-edited, and largely rewritten for the design system's PersonRecord layout: a hero, then life, family, photos and stories, and a tree toolbar with zoom and a legend. The data path: `dataFetch()` sends the data requests through `HFYFeatureFlags.dataFetch` with the cookie, and `fetchPerson()` turns a final 401 into a sign-in link, which `showSignIn()` shows. `renderFamilyVisualization()` loads the family-tree SVG as a background request. | Overwritten with the source copy, which lacks the layout and the `authV2` data path. | Excluded. | Excluded. |
| `_data/flags.json`, `js/auth-v2.js`, `images/pwa-192.png`, `images/pwa-512.png`, `images/pwa-maskable-512.png` | Repo-only. | Deleted, or replaced by the source copy where the source output has one. | Excluded. | Excluded. |
| `sw.js`, `manifest.webmanifest` | Repo-only. The islands build rewrites the `hfy-asset-versions` block in `sw.js` and the colours in `manifest.webmanifest`. | Deleted, or replaced by the source copy where the source output has one. | Excluded. | Excluded. |
| `offline.html`, `posts/index.html`, `me/index.html`, `me/notifications/index.html`, `me/links/index.html`, `me/inbox/index.html`, `me/review/index.html`, `me/requests/index.html`, `tree/index.html`, `edit/index.html`, `edit/family/index.html`, `join/index.html` | Repo-only. The islands build writes their head blocks and `?v` versions. | Deleted, or replaced by the source copy where the source output has one. | Excluded. | Excluded. |
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
| `lambda/` | Infrastructure: `lambda/hfy-sync-render/` is the render Lambda (HFY-TSK-176; [The render Lambda](sync-render.md)), built into a zip by `scripts/ci/package-render.sh` and shipped through the `RenderCodeKey` parameter; `lambda/placeholders/` holds the no-op packages for the app stack's `hfy-graph-render` and `hfy-sync-render` (HFY-TSK-247). The legacy `lambda/hfy-check-allowed/` was deleted (HFY-TSK-326). |
| `graph/` | Family graph builder |
| `gramps/` | The Gramps desktop core, standard library only: `gramps/hfygramps/scanner.py` is the Python port of the R-18 detector, tested against `shared/privacy-guard.vectors.json` by `python3 -m unittest discover gramps/tests/unit` (the `tests` key of `ci.manifest.yaml` runs it on pull requests). `gramps/hfygramps/render/` is the site renderer, `render_site(objects) -> {s3_key: bytes}`: the D-02-fixed ETL transforms and `build_search_index.js` as pure functions (HFY-TSK-229); its caller is the render Lambda, `lambda/hfy-sync-render/` (HFY-TSK-176), which ships `hfygramps/__init__.py`, `scanner.py` and `render/` in its zip. `gramps/tests/fixtures/` holds the synthetic tree and, under `render/`, the renderer's parity inputs, the live ETL's golden output and the expected-delta list. `gramps/redaction/redaction-v1.json` is the redaction policy (schema, golden vectors in `gramps/redaction/vectors/`, generators `make_vectors.py` and `render_reference.py`); `gramps/hfygramps/rules.py` loads it and holds `is_birth_like`, the one birth-like predicate. See [Redaction policy v1](redaction-policy.md). `gramps/hfygramps/projection.py` is the projection `P` (`project_tree`, `project`, the `birthlike_sticky` helpers and the coordinate and rectangle lift rules; HFY-TSK-241) and `gramps/hfygramps/canonical.py` writes the canonical JSON and hash of a stored object; neither is called by anything deployed yet. `gramps/hfygramps/merge.py` is the three-way field-level merge engine, `lift`, the relationship symmetry and reference checks and the conflict model (`merge_object`, `merge_tree`, `lift`, `check_integrity`, `update_baseline`, `resolve_date`; HFY-TSK-242), tested by `gramps/tests/unit/test_merge.py`; the addon will be its caller ([Gramps README](../../gramps/README.md#the-merge-engine)). `gramps/hfy_sync/` is the Gramps addon (HFY-TSK-179): `hfy_sync.gpr.py` registers the tool under Tools > Family Tree Processing, `hfy_sync_tool.py` is its shell and `hfy_sync_ui.py` its two dialogs. `gramps/hfygramps/addon/` is its runtime (paths, `status.json`, the `state.sqlite` sidecar, the tree binding, the preflight refusals and the runner), standard library only. `gramps/bin/hfy-sync` is the command-line wrapper, and `gramps/scripts/build-addon.sh` and `install-addon.sh` build and install it (`gramps/dist/` is not tracked). It has `status` and `bind` only and sends nothing: see [Install and run the Gramps sync addon](../how-to/install-the-gramps-sync-addon.md). |
| `infrastructure/` | Infrastructure, including the us-east-1 stacks of the MCP server and the private data gate |
| `islands/` | React islands; theme layer, fonts and asset versions |
| `shared/` | Pure, zero-dependency ESM validators (relative imports only; `shared/shared.test.mjs` enforces it, run `node --test shared/`; `shared/package.json` must keep `main` pointing at the test file for that to work, or run `node --test shared/shared.test.mjs`; not CI-gated yet). `api/src/shared` and `auth/src/shared` are committed symlinks to `../../shared`; `scripts/ci/package-api.sh` and `package-auth.sh` stage `shared/*.mjs` as real files in `src/shared/`; the islands import them by relative path and esbuild bundles them. `shared/privacy-guard.mjs` is the one R-18 detector (`scanText`, `rejectContactInfo`, `BIRTHDAY_KEYWORDS`; HFY-PLN-002 D2-09); `shared/privacy-guard.vectors.json` holds the cases it and its Python port both pass, and `shared/shared.test.mjs` imports `privacy-guard.test.mjs` so `node --test shared/` runs them. `shared/allowlist-store.mjs` is the read side of the DynamoDB allowlist (`ALLOW#` keys, `readAllowEntry`, `listAllowBySub`, `createCompositeMemberReader`); it takes the DynamoDB client and command classes as arguments, so it still imports nothing (HFY-TSK-134). `shared/redaction-rules.mjs` is the JavaScript port of the redaction predicates (`isBirthLike` and the date, place, coordinate, attribute and rect helpers); it takes the parsed `gramps/redaction/redaction-v1.json` as an argument and is tested against the golden vectors by `api/test/redaction-rules.test.js` ([Redaction policy v1](redaction-policy.md)). `shared/profile-links.mjs` validates the profile links (`validateLink`, `validateLinks`; surfaces.md 6.2): per-platform hosts, path shapes and handles, canonical URLs, and a website field that refuses every platform host (R-17); its table is `shared/profile-links.cases.json`. `shared/legacy-form.mjs` is the join form's schema (`FIELDS`, `validateForm`, `mapToGramps`; surfaces.md 7.3): birth year only, male or female, place fields city and state only, every free-text field through the R-18 detector; `mapToGramps` takes `storeCurrentCity` (Q2-11(a)). `shared/emails.mjs` holds the plain-text system emails of the join flow (`renderEmail`; `code`, `already_member`, `already_requested`, `received`, `approved`, `awaiting_record`, `declined`, `admin_new`). `shared/canonical.mjs` is the JavaScript original of canonical JSON and the object hash (`canonicalJson`, `objectJson`, `objectHash`; keys sorted by code point, integers only); it and `gramps/hfygramps/canonical.py` pass `shared/canonical.vectors.json`, and `shared/shared.test.mjs` imports `canonical.test.mjs`. `api/src/sync/store.js` and `api/src/sync/apply.js` write `obj_json` and `blob` with its `canonicalJson`. It is not reachable from any deployed route yet. |
| `scripts/` | CI and repo operations, infrastructure, the CloudFront Function (`scripts/cloudfront/`), tests, and the Gramps golden tooling (`scripts/records/`: the bundle shim, the generator and the standard-library check) |
| `tests/` (`client/`, `login-flow/`) | Tests |

## Notes

- This page is a routing index, not an inventory of record. Where it and the code disagree, the code is authoritative.
- The production cutover ran on 2026-10-12 (HFY-TSK-069, HFY-R67): PR #8 set all six flags in `11ty/_data/flags.json` to `true` and the site deployed, and then, per the HFY records, the private data gate was attached. The flags and the gate can change without an edit to this page, so check them rather than assume:
  - the flags: `curl -s https://<site>/_data/flags.json | jq .authV2`, or without `.authV2` for all seven (`navMe` included);
  - the gate: a signed-out `curl -s -o /dev/null -w '%{http_code}' https://<site>/person/index.json` prints `401` while the gate is attached. Without it, the request reaches the default behavior and its answer depends on the `HFYAppendIndex` code ([CloudFront Function](#cloudfront-function)).

  [How to turn a feature flag on for one tab or for everyone](../how-to/toggle-a-feature-flag.md) covers the flags, and the [release model](../explanation/release-model.md) explains them. The private data gate is not a flag: it applies from the moment `add-data-gate-behaviors.sh` attaches it.
- The repository does not record whether the follow-up live operations ran: the `/uploads/*` gating, the `HFYAppendIndex` publish, and the `hfy-auth-edge` and `hfy-api` redeploys that the theme and sign-in changes need. The pages that describe them give the checks.
- `11ty/README.md` is machine-checked. `scripts/infra/test/run.sh` reads two blocks from it and compares them with the Eleventy excludes in `scripts/check-deployment-sync.sh`:
  - the section from `## Repo-owned files` to `## Refreshing` must name `js/person-page.js`, `family-login/`, `css/auth-edge.css`, `css/hfy-theme.css` and `fonts/`;
  - the excludes of the command that starts `rsync -a --delete -n -i`, read up to its `_site/` line, must include those same paths and equal the sync check's excludes, `.DS_Store` aside.

  Change the exclude list in both files together, and keep those two headings and that command line as they are, or `run.sh` fails. The same test also checks that `auth/edge.manifest.json` `theme.cssUrl` carries the current hash of `11ty/css/auth-edge.css`.
- Some code comments cite READMEs that are now pointers:
  - `scripts/ci/package-edge-gate.sh`, `infrastructure/cloudformation/edge-gate-stack.yaml` and `11ty/js/feature-flags.js` cite `cloudfront/README.md` ("Private data gate") for the deploy order and rollback. That material is now in [How to deploy and update the Lambda@Edge functions in us-east-1](../how-to/deploy-the-edge-functions.md) and [How to cut over to authV2 and the private data gate, and roll back](../how-to/cut-over-to-the-private-data-gate.md).
  - `api/src/uploads.js` cites `cloudfront/README.md` for the members-only `/uploads/*`. That is now in [System architecture](architecture.md) and [Repository operations](repository-operations.md).
  - `api/src/keys.js` cites `api/README.md` for the key layout, which is now in [API: Table layout](api.md#table-layout).
  - `islands/copy.mjs`, `islands/heads.mjs` and `islands/tests/copy.test.mjs` cite the port notes in `11ty/README.md`. What the build writes is now in [Theme and asset build](theme-and-asset-build.md), and the state of the Eleventy source is in [How to refresh `11ty/` from the Eleventy source without losing E5 files](../how-to/refresh-the-eleventy-output.md).
- The `@io-kit/*` packages used by `api/`, `auth/` and `islands/` come from a private CodeArtifact registry. Each of those directories has an `.npmrc` that reads `CODEARTIFACT_AUTH_TOKEN` from the environment, so no token is stored in the repository. `edge-gate/`, `tests/client/` and `scripts/cloudfront/` need no packages. See [Private data and secrets](private-data-and-secrets.md).
