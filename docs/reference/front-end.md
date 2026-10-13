# Front end

Reference for the browser side of the site: what `11ty/` contains, the theme layer and asset versions that every page loads, the feature flags, the `authV2` data path, the island loader and islands, and the PWA shell.

For why the front end is a generated site with React islands on top, see [Why React islands on a generated Eleventy site](../explanation/islands-on-eleventy.md). For why the theme is a static layer built from design tokens, see [The design system theme layer](../explanation/design-system-theme-layer.md). For how flags stage a release, see [the release model](../explanation/release-model.md). For why person data is gated and what the client does about it, see [the privacy model for family data](../explanation/family-data-privacy.md#the-client-side). The full list of what the islands build writes (the theme cascade, the lint, the fonts, the head blocks, the Voice copy and the asset versions) is in [Theme and asset build](theme-and-asset-build.md).

Placeholders used on this page:

- `<eleventy-source>` is the Eleventy project outside the repository that renders `11ty/`. The [codebase map](codebase-map.md) says where it sits.
- `<site>` is the site's host name, as defined in [private data and secrets](private-data-and-secrets.md).
- `<name>` is an island name, such as `shell`.
- `<gramps_id>` is a person's Gramps record ID, and `<ulid>` is a post ID.
- `<sub>` is the signed-in member's subject at the auth edge. `/auth/session` returns it as both `sub` and `grampsId`, so it is that member's Gramps ID.
- `<sha8>` is the first 8 hex characters of the SHA-256 of a file's bytes, the value the islands build writes as `?v=<sha8>`.

## What `11ty/` contains

The deploy pipeline ([`io-kit-deploy.yml`](../../.github/workflows/io-kit-deploy.yml), see [Repository operations](repository-operations.md#workflows)) syncs `11ty/` to the site bucket as it is, so every file in it ships, `README.md` included. CI builds nothing into it. The only change CI makes is the client-ID patch in the table below. Everything the islands build produces is committed output (HFY-R58), built locally with `cd islands && npm run build` ([Island build](#island-build)).

| Kind | Files | Origin | Notes |
|---|---|---|---|
| Eleventy-generated | `css/main.css`, `css/main.css.map`; `images/` except `pwa-*`; `js/bootstrap.bundle.min.js` | Copied unchanged from a build of `<eleventy-source>`, whose `public/` directory passes through to the site root. | A fresh build replaces them and loses nothing. `main.css` is Bootstrap compiled with literal values. It is never edited: the theme layer loads after it and overrides it ([Theme layer and head blocks](#theme-layer-and-head-blocks)). |
| Eleventy-generated, then edited by hand | The ten rendered pages: `index.html`, and `index.html` under `about/`, `contact/`, `family-login/`, `logged-out/`, `person/`, `privacy/`, `private/`, `search/` and `terms/`. Also `js/auth.js`, `js/feature-flags.js`, `js/person-page.js`, `js/search-navbar.js` and `js/search-results.js`. | Rendered by `<eleventy-source>`, then changed in the repository. | Each page has an added `<script src="/js/auth-v2.js?v=<sha8>" defer></script>`. The base layout in `<eleventy-source>` does not emit it. `auth.js` skips the One Tap prompt when `authV2` is on (see [What each flag does](#what-each-flag-does)). `feature-flags.js` has the flag resolver, the preview override, the `authV2` data API (see [authV2 data fetch and session continuity](#authv2-data-fetch-and-session-continuity)) and the island loader inserted after `window.HFYFeatureFlags = featureAPI;`. Its pre-E5 part holds the [edge overlay](#edge-overlay), and its first lines hold the theme fallback and a build-stamped `hfy-asset-versions` block ([Asset versions](#asset-versions)). `person-page.js` renders the design system's person record: a hero, then the life, family, photos and stories sections, and a family-tree toolbar with zoom, fit, download and a legend. It reads each tree node's role back from the SVG fill colours. It fetches its data through `HFYFeatureFlags.dataFetch`, skips the legacy token wait with `authV2` on, and shows "Your sign-in has expired. Sign in again to see this page." when the record is still refused. The two search scripts have a `hfySearchV2Live()` helper at the top, and their data loads stand down once the search island has mounted. They also choose the credential with an `edgeSessionInit()` helper and fetch the person index files through `dataFetch`. A fresh Eleventy build drops every one of these edits, which is why the refresh excludes the five scripts ([Refresh the Eleventy output](../how-to/refresh-the-eleventy-output.md)). |
| Eleventy-generated, then rewritten by the islands build | The same ten pages | [`islands/build.mjs`](../../islands/build.mjs) | Head blocks A and B, the Voice copy, `width` and `height` on the two hero photographs, and `?v=<sha8>` on every same-origin script, stylesheet and manifest reference. A page refreshed from `<eleventy-source>` has head blocks A and B, with the source's hard-coded theme `?v` and font file name, but lacks the Voice copy, the hero `width` and `height`, and `?v` on its scripts and stylesheets. `cd islands && npm run build` rewrites all of them. |
| Repo-authored, output-only (E5) | `_data/flags.json`, `js/auth-v2.js`, `sw.js`, `manifest.webmanifest`, `offline.html`, `images/pwa-192.png`, `images/pwa-512.png`, `images/pwa-maskable-512.png`, `posts/index.html`, `me/index.html`, `me/notifications/index.html` | Written in the repository. They have no counterpart in `<eleventy-source>`. | `11ty/` holds the only copy. A refresh that copies with `--delete` removes whatever it does not exclude. The islands build also writes into some of them: the head blocks and `?v` in the four pages, the `hfy-asset-versions` block in `sw.js`, and the `background_color` and `theme_color` of `manifest.webmanifest`. |
| Islands build products | `js/islands/`, `css/hfy-theme.css`, `css/auth-edge.css`, `fonts/` | Produced by [`islands/build.mjs`](../../islands/build.mjs) from `islands/src/` and exact-pinned packages. | Committed build output (HFY-R58), never edited by hand. They ship with the `11ty/` sync, and `npm run check:islands` fails when any of them is stale. See [Island build](#island-build) and [Theme and asset build](theme-and-asset-build.md). |
| CI-patched placeholder | The string `REPLACE_WITH_GOOGLE_CLIENT_ID` in `js/auth.js` and in the inlined `window.HFY_AUTH_CONFIG` of the ten rendered pages | `<eleventy-source>` emits it when `HFY_GOOGLE_CLIENT_ID` is unset at build time. | The kit build step runs [`scripts/ci/patch-client-id.sh`](../../scripts/ci/patch-client-id.sh), which replaces it in every `.html` and `.js` file under `11ty/` with the `HFY_GOOGLE_CLIENT_ID` repository secret on the CI runner, before the release artifact is packaged. The committed files keep the placeholder. The `?v` on `/js/auth.js` is the hash of the committed file, so the patch changes the deployed bytes but not the URL. The pages' inlined config, which the patch also fills and which is not cached at Cloudflare, takes precedence over the script's own default. |
| Repository note | `README.md` | Written in the repository. | Does not ship: `ci.manifest.yaml` excludes `README.md` from the static sync. It carries two blocks that [`scripts/infra/test/run.sh`](../../scripts/infra/test/run.sh) checks. The table between `## Repo-owned files` and `## Refreshing` must list `js/person-page.js`, `js/auth.js`, `css/auth-edge.css`, `css/hfy-theme.css` and `fonts/`. Each of those must also be an `--exclude` of the refresh `rsync -a --delete -n -i` command, and that command's `--exclude` list must equal the Eleventy check's in [`scripts/check-deployment-sync.sh`](../../scripts/check-deployment-sync.sh), apart from `.DS_Store`. The same test checks that `theme.cssUrl` in [`auth/edge.manifest.json`](../../auth/edge.manifest.json) is `https://<site>/css/auth-edge.css?v=<sha8 of 11ty/css/auth-edge.css>`. The refresh excludes the README itself. |

`/posts/`, `/me/` and `/me/notifications/` are minimal hand-written pages. They load `feature-flags.js`, but not the inlined `window.HFY_FEATURE_FLAGS` config, `auth.js`, `auth-v2.js` or the Bootstrap navbar. `offline.html` loads no scripts. All four carry the theme head blocks and use the theme layer's page classes, with no inline styles.

### Theme layer and head blocks

Every page gets the theme without JavaScript. [`islands/heads.mjs`](../../islands/heads.mjs) writes two marker-delimited blocks into the 14 pages in its `PAGES` list: the ten rendered pages, plus `posts/index.html`, `me/index.html`, `me/notifications/index.html` and `offline.html`. Every build rewrites them.

| Block | Position | Contents |
|---|---|---|
| A, between `<!-- hfy-theme:start A -->` and `<!-- hfy-theme:end A -->` | Immediately before the `main.css` link | `<meta name="color-scheme" content="dark">`. A static `<meta name="theme-color">` whose value is the resolved `--io-color-semantic-surface` token (`#141210`). The shell early-hint inline script, which adds `hfy-shell-v2` to `<html>` when `localStorage["hfy:shell-hint"]` is `"1"`; `offline.html` has no hint. A `<link rel="preload" as="font">` of the UI face (Source Sans 3, latin, upright) under `/fonts/`. |
| B, between `<!-- hfy-theme:start B -->` and `<!-- hfy-theme:end B -->` | Immediately after the `main.css` link | `<link rel="stylesheet" href="/css/hfy-theme.css?v=<sha8>">` |

Pages without `main.css` (`posts/`, `me/`, `me/notifications/` and `offline.html`) get block A and then block B right after `</title>`. The blocks are render-blocking head markup because `feature-flags.js` runs at the end of `<body>`, where nothing can block rendering. If a page has no link whose `href` starts with `/css/hfy-theme.css`, `feature-flags.js` appends one as soon as it runs, with the stamped `?v` and a `data-hfy-theme-fallback` attribute. [`islands/tests/theme-delivery.test.mjs`](../../islands/tests/theme-delivery.test.mjs) fails when a page lacks the blocks, and when an HTML page is missing from `PAGES`.

`/css/hfy-theme.css` is generated by the islands build. Its cascade, in order: the `@font-face` rules; the `@io-kit/tokens` 0.4.1 harrisonfamily `theme.css`; `bs-bridge.css`; `kit-bridge.css`; the partials in `islands/src/theme/`, in ascending order of their number; and a generated `@media print` block that puts `:root` in the daylight theme. It loads right after `main.css`, so it wins on equal or higher specificity.

| Partial | Covers |
|---|---|
| `10-kit-aliases.css` | Maps the short variables that `@io-kit/shell`, `@io-kit/content` and `@io-kit/notify` read to `--io-*` tokens |
| `20-base.css` | Global element rules (the page ground, text, links and headings) that override the literal values in `main.css` |
| `30-bootstrap.css` | The Bootstrap 5.3 components that `bs-bridge.css` cannot reach, re-pointed at `--io-*` tokens class by class |
| `40-site.css` | The Eleventy site's own rules from `main.css`, re-pointed at `--io-*` tokens |
| `45-person.css` | The person page: the record, the family tree and the lightbox |
| `60-shell-static.css` | The shell frame before the island loads: the breakpoints, the hidden Bootstrap navbar and placeholder bars |
| `80-pages.css` | The four repo-owned pages and the preview-flags banner |

The fonts are self-hosted. `/fonts/` holds Source Sans 3 (the UI face), Libre Caslon Text (the display serif) and Source Code Pro, in latin and latin-ext woff2 files named `<base>.<sha8>.woff2`, with their OFL licences as `LICENSE-<family>.txt`. No page or stylesheet names a third-party font origin, and `theme-delivery.test.mjs` fails on a Google Fonts, Typekit, Bunny Fonts or Adobe Fonts origin.

The auth edge's own pages (`/auth/login` and the rest) do not load the theme layer. They link `/css/auth-edge.css`, built from `islands/src/auth-edge/auth-edge.css`, through `theme.cssUrl` in [`auth/edge.manifest.json`](../../auth/edge.manifest.json). The build stamps that URL with `?v=<sha8>`. The `hfy-auth-edge` Lambda links a changed URL only once it is redeployed. The file must be served from the site's own origin. The sign-in pages' Content-Security-Policy names only that origin in `style-src`, besides inline styles and Google's sign-in stylesheet, and allows fonts only from `'self'` ([Identity services](identity-services.md)).

The page copy is in the design system's lowercase family voice. [`islands/copy.mjs`](../../islands/copy.mjs) rewrites the older copy on the ten rendered pages: the home hero heading and lede, the calls to action, the about and family-login headings, the document titles, the footer, and the fallback navbar's brand. The islands, `person-page.js`, the auth edge's `copy` and the push templates use the same voice. Some error lines name the family member to contact. This page cites those by their constant, such as `SEARCH_COPY` in `people-corpus.js`, rather than quoting them.

To change the theme or the fonts, follow [Change the theme or brand fonts](../how-to/change-the-theme-or-brand-fonts.md).

### Asset versions

Cloudflare, in front of CloudFront, caches static files (scripts, stylesheets, fonts, `sw.js`) for 4 hours under the URL first fetched, and CloudFront's `/*` invalidation does not reach it. It does not cache HTML or JSON. Every same-origin script and stylesheet a page loads therefore carries `?v=<sha8>` of the file, so a deploy changes the URLs that the uncached HTML asks for. Why this design was chosen is in [Edge and origin design](../explanation/edge-and-origin-design.md#caching-posture).

| Reference | How it is versioned |
|---|---|
| In every `11ty/**/*.html` page: each `<script src>`; each `<link>` whose `rel` is `stylesheet`, `manifest` or `modulepreload`; and each `<link rel="preload">` with `as="script"` or `as="style"` | [`islands/assets.mjs`](../../islands/assets.mjs) adds `?v=<sha8>` of the referenced file. Only same-origin references count: root-relative ones and absolute ones on `https://<site>`. An existing `?v` is replaced, and other query parameters are kept. The build fails on a reference to a file that does not exist. |
| The island entries that `loadIsland` adds, the theme fallback link, the manifest link the loader adds, and the service worker registration | Read at runtime from the `hfy-asset-versions` block in `js/feature-flags.js`, which holds each island entry's `js` and `css` hash plus `theme`, `manifest` and `sw`. `HFYFeatureFlags.assetVersions` exposes it. Without a stamp the bare path is used. |
| The worker's precache list and its import of `notify-sw.js` | Read from the `hfy-asset-versions` block in `sw.js`: `theme`, `manifest`, the shell's `js` and `css`, and `notify`. |
| `/fonts/*.woff2` and `/js/islands/chunks/chunk-<hash>.js` | Not versioned. Their file names already carry a content hash. |
| Images, `/_data/flags.json`, the data paths, `/offline.html` | Not versioned. `flags.json` is JSON, fetched with `cache: "no-store"`. |

Every build rewrites the `?v` values and both stamped blocks. Never edit them by hand: `npm run check:islands` fails while any of them is stale. A page committed after an Eleventy refresh without that rebuild keeps unversioned URLs and goes stale at Cloudflare again.

Consequences for anything that fetches a static file to check it:

- An unversioned URL, such as `https://<site>/js/islands/shell.js` or `https://<site>/js/auth.js`, can return Cloudflare's copy, up to 4 hours old, even after a green deploy. Only the URL with the `?v` the page references shows the current file. The page's HTML and `HFYFeatureFlags.assetVersions` both name it, and [A flag is on but nothing changes](../how-to/diagnose-sign-in-and-api-failures.md#a-flag-is-on-but-nothing-changes) checks the versioned files step by step.
- The distribution's default behavior uses a cache policy that leaves the query string out of the cache key. Until the deploy's `/*` invalidation reaches an edge location, that location can answer `?v=NEW` with the old object.
- The deploy uploads `11ty/` with one `aws s3 sync … --delete` and then invalidates `/*`. It does not upload the HTML last.

### Data fetched at runtime

Person data and media are not in `11ty/`. Pages fetch them at runtime. The deploy's sync excludes `person/*.json`, `media/*`, `family/*`, `event/*`, `note/*`, `place/*` and `uploads/*` (the `exclude` list in [`ci.manifest.yaml`](../../ci.manifest.yaml)), so a deploy neither uploads nor deletes them. What those paths hold and who may read them is in [private data and secrets](private-data-and-secrets.md).

| Build variable | Rendered into | Default | Value in the committed `person/index.html` |
|---|---|---|---|
| `HFY_DATA_BASE` | `window.HFY_PERSON_CONFIG.dataBase`: the base URL for `<gramps_id>.json` | `/person/` | `/person/` |
| `HFY_MEDIA_BASE` | `window.HFY_PERSON_CONFIG.mediaBase`: the base URL for photos and media, including the family-tree SVG | `/media/` | `/media/` |
| `HFY_ENV` | `window.HFY_PERSON_CONFIG.env` | `dev` | `dev`. [`person-page.js`](../../11ty/js/person-page.js) stores it and reads it nowhere else. |

The production build in [Refresh the Eleventy output](../how-to/refresh-the-eleventy-output.md) sets both bases to absolute URLs on the production host, but the person template does not read them. The committed person page carries the defaults, so it requests data from the origin that served the page.

The search scripts and the search island use two fixed paths: `/person/index.json` (the person manifest) and `/person/search-index.json`. They come from `window.HFY_SEARCH_CONFIG` on the rendered pages and from [`people-corpus.js`](../../islands/src/lib/people-corpus.js) in the islands.

How a request for person data is authenticated depends on the merged `authV2` flag:

| `authV2` | Person-data requests (the record JSON and the two index files) |
|---|---|
| Off | A plain `fetch`: callers still go through `HFYFeatureFlags.dataFetch`, which passes the request through unchanged. Once a legacy gateway session exists, the request sends its token in an `X-HFY-Session` header, with `credentials: "include"` (see [Legacy component gating](#legacy-component-gating)). |
| On | Sent through `HFYFeatureFlags.dataFetch` with `credentials: "same-origin"` and no `X-HFY-Session` header, so the HttpOnly `io_id` session cookie is the only credential. See [authV2 data fetch and session continuity](#authv2-data-fetch-and-session-continuity). |

Whatever the flag says, `person-page.js` fetches the family-tree SVG through `dataFetch` with `credentials: "same-origin"`, no header and `interactive: false`. Photos, including member post photos under `/uploads/`, load only as same-origin `<img src>`, so the browser sends the `io_id` cookie with them. No island fetches a photo from script ([`islands/tests/uploads-gate.test.mjs`](../../islands/tests/uploads-gate.test.mjs)).

The private data gate, a Lambda@Edge function, checks the `io_id` cookie on `/person/*.json`, `/family/*`, `/event/*`, `/note/*`, `/place/*` and `/media/*`, and ignores `X-HFY-Session`. [`add-data-gate-behaviors.sh`](../../scripts/infra/add-data-gate-behaviors.sh) also gates `/uploads/*`, in place. While the gate is attached, only the `authV2` path can read person data. The production cutover attached the gate on 2026-10-12 (HFY-TSK-069, HFY-R67). To see whether it is attached now, request a gated path signed out:

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://<site>/person/index.json
```

`401` means the gate is attached. Any other status means it is not: `200` when the request reaches the bucket, and `404` when the default-deny code of `HFYAppendIndex` answers it, in which case members are refused too. Which of these applies now is live state that the repository does not record. [Find your starting point](../how-to/cut-over-to-the-private-data-gate.md#find-your-starting-point) lists the checks and what each answer means. The gate is described in [the privacy model for family data](../explanation/family-data-privacy.md#gating-the-json), and the order of the switch and its rollback in [Cut over to authV2 and the private data gate](../how-to/cut-over-to-the-private-data-gate.md).

The default behavior's CloudFront Function, `HFYAppendIndex` ([`scripts/cloudfront/append-index.js`](../../scripts/cloudfront/append-index.js)), resolves directory paths to `index.html`. On the default behavior it then answers `404`, with `cache-control: private, no-store` and without reaching the bucket, for any request whose normalized first path segment is `family`, `event`, `note`, `place`, `media` or `uploads`, and for anything under `/person/` except `/person/index.html`, any `.json` included. How it normalizes the path is in [private data and secrets](private-data-and-secrets.md#reads). While the gate is attached, a real request for private data matches its gated behavior first and never reaches the function, so the refusal matters there for case, suffix and encoding variants, such as `/Person/index.json`, which match no gated pattern. How the function is published is in [Publish a change to the HFYAppendIndex CloudFront Function](../how-to/publish-the-cloudfront-function.md).

### Script order on the rendered pages

In `<head>`, block A's early-hint script runs before any stylesheet. In the body, page-specific scripts (`person-page.js`, `search-results.js`) sit inside the page content and run first. The shared footer then runs, in this order:

1. The inline `window.HFY_FEATURE_FLAGS` block.
2. `/js/auth-v2.js?v=<sha8>`, with `defer`.
3. `/js/feature-flags.js?v=<sha8>`, which defines `window.HFYFeatureFlags`.
4. The inline `window.HFY_AUTH_CONFIG` block.
5. The Google Identity Services client, with `async defer`.
6. `/js/auth.js?v=<sha8>`.
7. The inline `window.HFY_SEARCH_CONFIG` block.
8. `/js/bootstrap.bundle.min.js?v=<sha8>`.
9. `/js/search-navbar.js?v=<sha8>`.

## Feature flags

### Build-time values

[`11ty/_data/flags.json`](../../11ty/_data/flags.json) is served at `/_data/flags.json`. It defines eight flags: `aboutCta`, `authV2`, `navMe`, `notifyV2`, `personV2`, `postsV2`, `searchV2` and `shellV2`. In the committed file seven are `true` and `aboutCta` is `false` (it shipped default-off with HFY-TSK-136). Six were set by PR #8 (HFY-TSK-069). `navMe` shipped default-off with HFY-TSK-091 (HFY-R8) and was turned on on 2026-10-13 with io's approval (HFY-TSK-223); setting it back to `false` is that flip's rollback. The production cutover ran on 2026-10-12 (HFY-TSK-069, HFY-R67): the site with the flip deployed first, and the data gate attached after it. To see what the site serves now:

```sh
curl -s https://<site>/_data/flags.json | jq .
```

`resolveFlags()` fetches the file with `cache: "no-store"`, once per page load. A network error, a non-2xx status or a body that is not JSON all produce an empty object. Every build-time flag then reads as off, and only the override can turn a flag on. A flag is on only when its merged value is exactly `true`. While the data gate is attached, a page whose `flags.json` load fails therefore runs the legacy data path, and the gate refuses its person-data requests.

### Runtime override (preview flags)

The override lasts for one tab (HFY-R58). It is kept in `sessionStorage` under `hfy:flags`.

| Input | Effect on `sessionStorage["hfy:flags"]` | Result |
|---|---|---|
| `?hfy_flags=shellV2,postsV2` | Replaced with `shellV2,postsV2` | Both flags on in this tab. |
| `?hfy_flags=searchV2,-shellV2` | Replaced with `searchV2,-shellV2` | `searchV2` on, `shellV2` forced off. |
| `?hfy_flags=` (empty value) | Removed | Build-time values only. |
| No `hfy_flags` parameter | Unchanged | The stored value applies. |

Rules:

- The value is a comma-separated list. Tokens are trimmed, and empty tokens are skipped. A bare name sets that flag to `true`. A name with a leading `-` sets it to `false`. Names are not validated.
- Each new value replaces the stored list. Nothing is appended, so to add a flag you repeat the ones already set.
- The stored value applies to every page opened in this tab, and ends when the tab closes. Other tabs, other browsers and other visitors are not affected.
- While a flag is `true` in the build file, a bare name for it changes nothing. Only the `-name` form has an effect. A tab with `-authV2` runs the legacy data path, which the data gate refuses while it is attached.
- **Banner.** While an override is active, the page shows a fixed "preview flags on — turn off" banner at the bottom left, a `.hfy-flag-banner` region labelled "preview flags". The theme partial `80-pages.css` styles it, and raises it above the shell's bottom bar when the shell shows one, under 688 px. Its button, labelled "turn off preview flags", clears the override and reloads the page without the `hfy_flags` parameter. The banner carries `data-hfy-keep`, so the shell island leaves it in `<body>`.
- **Automatic clearing.** The override is cleared, and the banner removed, when a flagged dependency is unavailable: an island bundle fails to load, or `/auth/session` does not answer for `authV2`. The page then falls back to the legacy behavior, and a console warning names the dependency (`preview flags turned off: <what> unavailable`).
- **Old storage.** Builds before HFY-R58 kept the override in `localStorage` with no expiry. Every page load deletes `localStorage["hfy:flags"]`.
- If `sessionStorage` cannot be used, the `hfy_flags` parameter applies to the current page only.
- **The API ignores it.** The override changes only what the page shows. An API route behind a flag answers `404` until the flag is `true` in the deployed file, except to members of the `uat` group ([API: Feature gate](api.md#feature-gate)).

[`feature-flags.js`](../../11ty/js/feature-flags.js) merges the flags in this order:

1. The build-time values from `/_data/flags.json`.
2. The override. It wins in both directions.
3. HFY-R48: if the merged `searchV2` is `true`, `shellV2` becomes `true` unless the override contains `-shellV2`. A build-time `shellV2: false` does not prevent this.

The legacy search scripts do not read the override. `search-navbar.js` and `search-results.js` always wire their handlers. Before each data load they call `HFYFeatureFlags.searchV2Live()`, and they stand down only when it resolves `true`: `searchV2` is on and the replacement (the shell's launcher for the navbar, the search island for `/search/`) has actually loaded. A missing or failed island therefore leaves the legacy search working.

### What each flag does

| Flag | `<html>` class | Pages | Loads | Navigation change | If the island fails to load |
|---|---|---|---|---|---|
| `shellV2` | `hfy-shell-v2`. Block A's early hint sets it before the first paint when `localStorage["hfy:shell-hint"]` is `"1"`. The island also adds `io-no-focus-zoom`. | Every page that loads `feature-flags.js`: the ten rendered pages, `/posts/`, `/me/` and `/me/notifications/` | The `shell` island. Once it has loaded, the loader appends `<link rel="manifest" href="/manifest.webmanifest?v=<sha8>">` and sets `hfy:shell-hint` to `"1"`. The `theme-color` meta is static in block A, so the loader adds none. | The kit shell replaces the Bootstrap navbar, which the theme layer hides whenever `<html>` has `hfy-shell-v2` (`60-shell-static.css`). Links: home `/`, family `/private/`, search `/search/`, posts `/posts/`, me `/family-login/`. `notifyV2` and `navMe` change them (below). | The loader removes `hfy-shell-v2` and sets `hfy:shell-hint` to `"0"`, so the legacy navbar shows again. No manifest link is added. With the flag off, the loader does the same. |
| `searchV2` | `hfy-search-v2`, plus an injected style rule that hides `[data-search-page]` | Only `/search`, `/search/` and `/search/index.html`, where the island loads. | The `search` island. The flag also turns `shellV2` on. | The shell's search launcher offers local suggestions from the people corpus. The legacy navbar search stands down once the shell has loaded. | The loader removes the `hidden` attribute from the legacy section, the class and the style rule. The legacy scripts have not stood down, so the restored section loads results. |
| `personV2` | None | `/person/?id=<gramps_id>` | The `person` island | None | No handler is needed, because the legacy notes stay in place. |
| `postsV2` | None | `/person/?id=<gramps_id>`; `/` and `/index.html`; `/posts`, `/posts/` and `/posts/index.html` | `my-posts`, `timeline` and `posts` respectively | None | No handler. The page stays as it was, and `/posts/` keeps its "family posts are loading." placeholder. |
| `notifyV2` | None | `/me/notifications` and `/me/notifications/` | The `notifications` island | The shell's "me" item links to `/me/notifications/`, and its account sheet gains a "notifications" item. This applies only while `shellV2` is on, and not with `navMe`, which moves both into the settings hub. | The page keeps its "notifications aren't turned on yet." text. |
| `navMe` | None | Every page with the shell, for the navigation; `/me`, `/me/` and `/me/index.html` for the island | The `settings` island, on `/me/` | "me" opens the member's own page (`/private/` until the edge session names them), "family" leaves the bar until the viz domain's `familyViz` gives it `/tree/`, so the bottom bar has four cells. A gear before the account control links to the `/me/` settings hub, signed in only, and the account sheet reads "your page", "settings" and "sign out". This applies only while `shellV2` is on. See [the shell](#catalog). | `/me/` keeps its "settings aren't turned on yet." text. |
| `aboutCta` | None | `/about/`, `/about`, `/about/index.html` | The `about-cta` island | After `section.about-hero`, a signed-in close to the story: "the story isn't finished.", a lede, a nudge about a gap on your own page, four cards (look around, add what's missing, fix what's wrong, add photos) with counts from `/person/index.json`, and "the memories live on.". "add what's missing" and "fix what's wrong" need `recordEdit`, "add photos" needs `commentPhotosV1` or `postsV2` (the own-page composer at `/person/?id=<sub>#share`); a card whose flag is off shows its browse-only variant. The cards open `/search/?has_birth_year=false` and `/search/?has_photo=false`: the search island seeds one filter per `has_photo`, `has_birth_year` and `living` param (`true` or `false`). | Nothing is added; the story stands on its own. The island renders only with a session `sub` (stricter than "not signed out"): with `authV2` off or a failed `/auth/session` the cards stay hidden. A death-only lifespan ("d. 1980") does not count as a birth year. |
| `authV2` | None | The ten rendered pages, through [`auth-v2.js`](../../11ty/js/auth-v2.js). The data path applies on every page that fetches person data. | No island. `auth-v2.js` probes the session with `HFYFeatureFlags.edgeSession()`, one `GET /auth/session` that may refresh once. On `/family-login/`, a visitor still signed out after that probe is redirected to `/auth/login`, with the page's `?next=` path as `returnTo` when it is safe. Person-data requests send the `io_id` cookie through `HFYFeatureFlags.dataFetch` instead of `X-HFY-Session`. `auth.js` still renders the Google button but does not call `googleAccounts.prompt()`: One Tap's bottom sheet covered the shell's bottom bar at 375 px. | When the edge session has `authenticated: true` and a `sub`, the [edge overlay](#edge-overlay) shows the navbar search, "MY RECORD" (linked to `/person/?id=<sub>`) and the sign-out item, and hides the sign-in item. See [`auth-v2.js` behavior](#auth-v2js-behavior). | If `/auth/session` does not answer with a JSON body whose `authenticated` is a boolean, `auth-v2.js` clears the preview override and changes nothing, so the legacy sign-in runs. Flags already resolved on the page do not change, so its data requests still use the cookie. |

The loader also clears the preview override whenever an island fails to load (see [Runtime override](#runtime-override-preview-flags)).

Flags gate UI, with one exception: `authV2` also selects the credential that person-data requests carry, the `io_id` cookie instead of `X-HFY-Session`. No server code reads a flag: nothing in `api/src/`, `auth/src/`, `edge-gate/src/` or `lambda/` refers to `flags.json` or to a flag name. The API, the auth edge and the data gate answer whatever the flags say, so every flagged surface must still authenticate its own data calls. See [What a flag does not protect](../explanation/release-model.md#what-a-flag-does-not-protect).

While the data gate is attached, a client with `authV2` off sends only `X-HFY-Session`, which the gate ignores, so it cannot read person data. Anything that sets `authV2` back to `false` for everyone therefore locks members out of person pages, search and photos: a revert of the flip, a `false` in `flags.json`, or an automatic rollback of a site deploy to an artifact built before the flip. The rollback order, which removes the gate first, is in [Cut over to authV2 and the private data gate](../how-to/cut-over-to-the-private-data-gate.md#roll-back).

To change a flag, follow [toggle a feature flag](../how-to/toggle-a-feature-flag.md).

### `auth-v2.js` behavior

[`11ty/js/auth-v2.js`](../../11ty/js/auth-v2.js) does nothing unless the merged `authV2` is `true`. It reads the flag through `HFYFeatureFlags.resolveFlags()`, or from `/_data/flags.json` when that function is missing. With it on:

| Situation | What the script does |
|---|---|
| Every page | Probes the session with `HFYFeatureFlags.edgeSession()`. That is the page's one `GET /auth/session`, shared with the search scripts and the data fetches, and it may refresh once first (see [authV2 data fetch and session continuity](#authv2-data-fetch-and-session-continuity)). If `edgeSession` is missing, the script sends its own `GET /auth/session` (same-origin, `no-store`), with no refresh. |
| `/auth/session` unreachable, or not a JSON body with a boolean `authenticated` (edge not attached, network error, an HTML error page) | Calls `HFYFeatureFlags.flagUnavailable("/auth/session")`, which drops any preview override, and leaves the page to the legacy flow. |
| On `/family-login/`, signed out at the edge after the probe | `location.replace("/auth/login?returnTo=" + encodeURIComponent(<return path>))`. The return path is the page's `?next=` value when that is a safe same-origin path, and `/` otherwise. See the rules below the table. |
| On `/family-login/`, already signed in at the edge | No redirect, whatever `next` says. The page keeps the legacy Google sign-in rather than sending the visitor back to `/auth/login` in a loop. The signed-in navigation below still applies. |
| Signed in at the edge (`authenticated: true` and a `sub`), any page | Points `[data-my-record-link]` at `/person/?id=<sub>` and shows its list item, hides `familyLoginLink` and shows `logoutLink`. It applies this again at `load`, plus 600 ms after it, when `load` has not yet fired by the time the session probe answers, because the legacy scripts toggle the same items. When `load` fired first, neither re-apply runs. `edgeSession()` has already set the [edge overlay](#edge-overlay), which keeps `navbarSearch`, `myRecordLink` and `logoutLink` shown whenever `feature-flags.js` re-applies visibility. The script then wires the sign-out links. |
| Click on any `[data-auth-signout-link]`. The handler is wired only when the visitor is signed in at the edge. | Runs in the capture phase, prevents the default and stops other handlers. Clears the legacy credentials at once: `localStorage` keys `HFY_AUTH_ID_TOKEN`, `HFY_AUTH_USER_GRAMPS_ID` and `hfy:edge-session`, `sessionStorage` key `HFY_GATEWAY_SESSION_V1`, and Google auto-select (`google.accounts.id.disableAutoSelect()`). Calls `HFYFeatureFlags.forgetEdgeSession()`, which drops the edge overlay. Sends `POST /auth/logout` with `keepalive`, `X-Requested-With: io-kit` and body `{}`, and waits for it for at most 4 s. Then runs the legacy `HFY_AUTH.signOut()`, or goes to `/logged-out/` when that is not on the page. |

A `next` value is used as the return path only when all of these hold (HFY-TSK-069). Otherwise the return path is `/`.

- It is a non-empty string of at most 2048 characters.
- It starts with exactly one `/`, so it has no scheme, no host and no leading `//`.
- It contains no backslash and no control character (U+0000 to U+001F, or U+007F).
- It is not `/auth` or `/family-login`, case-insensitively, followed by the end of the path, `/`, `?` or `#`. Those pages would loop.

The legacy fallbacks in `person-page.js`, `search-results.js`, `search-navbar.js` and `people-corpus.js` send a visitor without a session to `/family-login/?next=<path, query and hash>`. Under `authV2` that page hands `next` to the edge sign-in as `returnTo`, so the deep link survives sign-in.

The script's header comment gives a different reason for the `/family-login/` case. See [Discrepancies](#discrepancies).

## `window.HFYFeatureFlags`

[`11ty/js/feature-flags.js`](../../11ty/js/feature-flags.js) defines this object. The script loads synchronously. On the rendered pages it runs after the inline `window.HFY_FEATURE_FLAGS` block. Before it defines the object, it adds the theme fallback link when the page has none ([Theme layer and head blocks](#theme-layer-and-head-blocks)).

| Member | What it does |
|---|---|
| `config` | The inlined `window.HFY_FEATURE_FLAGS` object. On pages without one (`/posts/`, `/me/`, `/me/notifications/`) it is `{}`. |
| `getState()` | Returns a copy of the legacy session state: `loggedIn`, `sessionToken`, `userGrampsID`, `hasRecord`, `sessionExpiresAt`, `verifying` and `verifiedAt`. The edge overlay is not included. |
| `getUserGrampsID()` | The Gramps ID in the legacy state, or `null`. The edge overlay is not consulted. |
| `updateState(partial)` | Merges `partial` into the legacy state, then re-applies visibility. An explicit `sessionToken: null` also clears the session cache. |
| `shouldShow(key, overrides)` | Evaluates component `key`'s `showWhen` rules against the legacy state, with the edge overlay laid over it when set, merged with `overrides`. |
| `refresh()` | Re-applies visibility to every `[data-feature]` element, using the legacy state with the edge overlay laid over it. |
| `acceptSession(payload)` | Accepts a gateway payload of `{sessionToken, grampsId?, expiresAt? or expiresIn?}`, stores it and re-applies visibility. Returns `false` when `sessionToken` is missing. |
| `verifySession({ googleIdToken })` | POSTs `{id_token, context}` to `config.gateway.endpoint` with credentials. It succeeds only when the response contains both `allowed` and `sessionToken`. Otherwise it clears the session. Returns the payload, or `false`. |
| `requireSessionToken()` | Returns the legacy session token. Returns `null` when there is no token or the token has expired, and clears an expired token. |
| `resolveFlags()` | Returns a promise of the merged flags. It is memoized: the first call fetches, and every later call returns the same promise. A change to `flags.json` or to the override therefore takes effect on the next page load. |
| `loadIsland(name, { onError, onLoad })` | Appends `<link rel="stylesheet" href="/js/islands/<name>.css?v=<sha8>">` to `<head>`, then appends `<script type="module" src="/js/islands/<name>.js?v=<sha8>">` once that stylesheet has fired `load` or `error`, so an island never mounts unstyled. Each `?v` comes from the stamped block, and without a stamp the bare path is used. Runs once per name, and returns the script element. |
| `assetVersions` | The stamped `hfy-asset-versions` map: each island's `js` and `css` hash, and `theme`, `manifest` and `sw`. The shell island reads `sw` to register the service worker. |
| `whenIsland(name)` | Resolves `true` once the named island has loaded and run, and `false` if it failed or was never requested on this page. |
| `searchV2Live(part)` | Resolves `true` only when `searchV2` is on and the replacement has loaded: `"page"` waits for the `search` island, `"launcher"` for the `shell` island. The legacy search scripts call it before each data load. |
| `overrideActive()` | Whether a preview override is in effect on this page. |
| `clearOverride(reason)` | Removes the override from `sessionStorage` (and any old `localStorage` copy), removes the banner, and logs `reason` when given. The current page keeps the flags it has already resolved. |
| `flagUnavailable(what)` | Calls `clearOverride` when an override is active. The loader calls it when an island fails, and `auth-v2.js` when `/auth/session` does not answer. |
| `dataFetchInit()` | Resolves `{credentials: "same-origin"}` when the merged `authV2` is `true`, and `null` otherwise. Callers use it to choose between the cookie and the legacy `X-HFY-Session` request. |
| `dataFetch(url, init, { interactive })` | Resolves the `Response` for a person-data request. With `authV2` off it is exactly `fetch(url, init)`. With it on, it fetches with `credentials: "same-origin"` after the page's preflight, refreshes and retries once on a 401, and, for an interactive load, sends the visitor to sign in when that fails. `interactive` defaults to `true`, and only `interactive: false` marks a background load. |
| `dataResponse(response)` | Deprecated, kept for callers from before HFY-R66. No page script or island calls it; only [`tests/client/data-fetch.test.mjs`](../../tests/client/data-fetch.test.mjs) exercises it. Once `dataFetchInit` or `dataFetch` has seen `authV2` on this page, a 401 takes the guarded sign-in redirect and an `ok` response clears the redirect guard. It cannot retry. Returns `response`. |
| `edgeSession()` | Resolves the page's `/auth/session` answer: `{authenticated: true, sub, grampsId, label}`, plus `exp` when the token has one, or `{authenticated: false}`. Resolves `null` when `authV2` is off, or when `/auth/session` does not answer with a JSON body whose `authenticated` is a boolean. Memoized per page, and may refresh once first. An authenticated answer with a `sub` sets the edge overlay and `localStorage["hfy:edge-session"]`. |
| `forgetEdgeSession()` | Removes `localStorage["hfy:edge-session"]`, drops the edge overlay and re-applies visibility. `auth-v2.js` and the shell's sign-out call it. |
| `signInUrl()` | Returns `/auth/login?returnTo=` followed by the current path, query and hash, URL-encoded. |
| `familyUrl()`, `goToFamily()`, `familyRoute` | "Your family", the rule behind the shell's own-page tab (family, or me with `navMe`), `/private/` and `/person/` without an id. `familyUrl()` resolves where the visitor goes: signed in, `/person/?id=<sub>`; signed out, `/auth/login?returnTo=%2Fprivate%2F`; with `authV2` off or `/auth/session` unreachable, the id the legacy sign-in kept (`/person/?id=<id>`) or `/family-login/?next=%2Fprivate%2F`. It resolves `null` for an authenticated session without a `sub`, so a broken session never loops. `goToFamily()` does `location.replace` to that URL. `familyRoute` is `/private/`. |

How `loadIsland` behaves:

- A second call with the same name adds nothing and returns the first script element. The callbacks passed to that second call are ignored.
- The stylesheet link is added even when the island has no CSS. Every current island imports CSS, so each build produces a `<name>.css`. For a future island without CSS, the stamp would hold no `css` hash, the page would request a bare `<name>.css` that does not exist, and the module would be appended after that request's `error` event.
- On the script's `load` event, the island's `whenIsland` promise resolves `true` and `onLoad` runs.
- On the script's `error` event, the promise resolves `false`, the stylesheet link is removed, `flagUnavailable` clears any preview override, and `onError` runs. That event fires when the module, or a chunk it imports, cannot be fetched or parsed. An exception thrown while the island runs does not trigger it.

The flag handlers are four separate `resolveFlags().then(...)` callbacks. The first handles `personV2`, `postsV2` and `shellV2`, the second handles `searchV2`, the third handles `notifyV2`, and the fourth handles `navMe`.

### authV2 data fetch and session continuity

HFY-R66. The data gate checks `io_id`, which lives 3600 s. The longer-lived, HttpOnly `io_rt` refresh cookie lets `POST /auth/refresh` set a new `io_id`, and once `io_rt` is gone the refresh answers 401 ([Identity services: Cookies](identity-services.md#cookies)). `feature-flags.js` uses the refresh so that a member whose `io_id` has lapsed keeps reading data without signing in again, and so that no page loops through sign-in. With `authV2` off none of this runs: `edgeSession()` resolves `null`, and `dataFetch()` is exactly `fetch(url, init)`.

| Mechanism | Behavior |
|---|---|
| Session probe | `edgeSession()` sends one `GET /auth/session` per page (`credentials: "same-origin"`, `cache: "no-store"`), shared by `auth-v2.js`, the search scripts, the shell's account control, `createApi` and the data fetches. A session counts as usable when it is authenticated and its `exp` is more than 120 s away, or it has no `exp`. An authenticated session near expiry is refreshed once and asked again. A signed-out answer is refreshed only when `localStorage["hfy:edge-session"]` is `"1"`, meaning this browser has had an edge session, so an anonymous visitor on a public page causes no refresh. After a successful refresh the page asks `/auth/session` once more. |
| Preflight | Before the first `dataFetch` on a page, a session that is signed out or within 120 s of `exp` is refreshed once, unless a refresh was already tried on the page. This applies without the `hfy:edge-session` marker. After a successful preflight refresh, the page asks `/auth/session` again in the background so that navigation follows the new `io_id`. The data request does not wait for that answer. When `/auth/session` is unreachable, the preflight does nothing and leaves the request to the gate. |
| Refresh request | `POST /auth/refresh` with `credentials: "same-origin"`, `cache: "no-store"` and `X-Requested-With: io-kit`. It is single-flight: concurrent callers share one request. Any 2xx counts as success. The response body is never read, because it carries tokens. |
| Gate 401 | A data request answered 401 triggers one refresh, or reuses a refresh that finished after the request was sent, and is then retried once. Each request is retried at most once. |
| Failed refresh | A refresh that fails (non-2xx or a network error), or a retry that still gets 401 after a successful refresh, stops refreshing for the rest of the page. A refresh answered 401 or 403 also removes `localStorage["hfy:edge-session"]`, so later pages stop trying. |
| Sign-in redirect | Only an interactive load that is still refused is sent to `signInUrl()` (`/auth/login?returnTo=<path, query and hash>`) with `location.replace`, and at most once per page. A background load (`interactive: false`) gets the 401 back and never redirects. |
| Bounce guard | Before it redirects, the page stores the time in `sessionStorage["hfy:auth-bounce"]`. A tab that was sent to sign-in less than 10 minutes ago is not sent again, and the caller shows its own error instead. When `sessionStorage` is blocked, the guard cannot work, so the automatic redirect is always skipped. Any `ok` data response removes the entry. |
| Edge marker | An authenticated `/auth/session` answer with a `sub` sets `localStorage["hfy:edge-session"]` to `"1"` and the [edge overlay](#edge-overlay). Sign-out removes both. |

Callers and their load mode:

| Caller | Request | Mode | When it is still refused |
|---|---|---|---|
| [`person-page.js`](../../11ty/js/person-page.js) | `/person/<gramps_id>.json` | Interactive | The visitor is sent to sign in. If the bounce guard skips that, the page shows "Your sign-in has expired. Sign in again to see this page.", where "Sign in again" links to `signInUrl()`. Any other failure, such as a 404, shows the page's single error line (`VOICE.error` in `person-page.js`). |
| `person-page.js` | The family-tree SVG | Background | The tree area shows the same error line in place of the tree. The record stays. |
| [`search-results.js`](../../11ty/js/search-results.js) | `/person/index.json`, `/person/search-index.json` | Interactive, including the load it starts when `edgeSession()` reports an authenticated session | The status line shows "Unable to load search data. Please try again later." |
| [`search-navbar.js`](../../11ty/js/search-navbar.js) | The same two files | Interactive when a typed query starts the load. Background for the preloads: on focus, and the eager preload that starts when `edgeSession()` reports an authenticated session. | No suggestions. A preload never redirects. |
| [`person` island](../../islands/src/islands/person.jsx) | `/person/<gramps_id>.json` | Background | The legacy notes stay. The island never redirects. |
| [`people-corpus.js`](../../islands/src/lib/people-corpus.js) (search island, shell launcher) | The two index files | Interactive. It passes no options. | The corpus load fails with the signed-out line from `SEARCH_COPY`, which the search island shows in its banner. |

Under `authV2`, the search scripts' preloads follow the edge session, not the legacy `HFY_AUTH` state. A legacy Google token left in `localStorage` by an earlier sign-in therefore starts no data request.

## Legacy component gating

The first part of `feature-flags.js` predates E5. It shows or hides navigation elements according to sign-in state, and it holds the legacy gateway session. One newer piece sits in this part: the [edge overlay](#edge-overlay) (HFY-R66).

The legacy pieces are still deployed, and every push to `main` ships them again: the `X-HFY-Session` paths in `feature-flags.js`, `person-page.js` and the two search scripts, the legacy Google sign-in in `auth.js`, and the server side that `verifySession` calls (see [identity services](identity-services.md)). On the client they run whenever `authV2` resolves off for a page: in a tab with a `-authV2` override, or on a page whose `/_data/flags.json` failed to load.

### The inlined config

Each rendered page includes this block before `feature-flags.js`. The block comes from the base layout in `<eleventy-source>`:

```js
window.HFY_FEATURE_FLAGS = Object.assign(
  { gateway: { endpoint: "/api/check-allowed", context: "site", enforceAssets: true } },
  /* the featureFlags data file, rendered as JSON */,
  window.HFY_FEATURE_FLAGS || {}
);
```

The merge is shallow, so the data file's `gateway` object replaces the default one entirely. The data comes from `src/_data/featureFlags.js` in `<eleventy-source>`. The repository holds a tracked copy at [`workspace/11ty-dev/src/_data/featureFlags.js`](../../workspace/11ty-dev/src/_data/featureFlags.js), which nothing builds from.

| Field | Rendered value | Meaning |
|---|---|---|
| `defaultState` | `loggedIn: false`, `sessionToken: null`, `userGrampsID: null`, `hasRecord: false` | The state before the session cache is read. |
| `gateway.endpoint` | `/api/check-allowed` | The legacy allowlist check that `verifySession` calls. It is still deployed. See [identity services](identity-services.md). |
| `gateway.context` | `site` | Sent as `context` in the verify request. |
| `gateway.enforceAssets` | `true` | With `authV2` off, search must have a session token before it requests the person index files. |
| `gateway.debug` | `false` | Rendered, but no script reads it. |
| `components` | Four entries, listed below | Visibility rules for `[data-feature]` elements. |

| Component | Shown when | Elements |
|---|---|---|
| `navbarSearch` | `loggedIn` is `true` | The navbar search wrapper. Its `assets` list (the person manifest and the search index) is descriptive only, and no script reads it. |
| `familyLoginLink` | `loggedIn` is `false`, unknown or `null` | The navbar "FAMILY LOGIN" item and the homepage "sign in" button. |
| `logoutLink` | `loggedIn` is `true` | The navbar "LOG OUT" item. |
| `myRecordLink` | `loggedIn` and `hasRecord` are both `true` | The navbar "MY RECORD" item. |

Visibility rules:

- An element is shown when its key has no component entry or the entry has no `showWhen`.
- Otherwise, every `showWhen` condition must match. The conditions are checked against the legacy state, with the edge overlay laid over it when set. Values are compared as strings, and a missing state value compares as `"unknown"`.
- A hidden element gets the `d-none` class, `aria-hidden="true"` and the `hidden` attribute. A shown element loses all three.
- Every gated element also gets `data-feature-visible`, set to `"true"` or `"false"`.
- Visibility is applied at `DOMContentLoaded` and again after every state change, and again when the edge overlay is set or dropped.

With `shellV2` on, the Bootstrap navbar that holds most of these elements is hidden, and the shell's account control shows the sign-in state instead ([Islands](#islands)). The navbar stays in the DOM, because `auth-v2.js` wires its sign-out link and the shell's "sign out" clicks that link.

### Edge overlay

When `edgeSession()` resolves an authenticated session with a `sub`, `feature-flags.js` keeps an overlay of `{loggedIn: true, userGrampsID: <sub>, hasRecord: true}` and re-applies visibility once the DOM is ready. The overlay is laid over the legacy state for `[data-feature]` visibility, `shouldShow` and `refresh`. `navbarSearch`, `myRecordLink` and `logoutLink` then show and `familyLoginLink` hides. The legacy `auth.js` knows nothing of the edge session, and updating the legacy state cannot hide those items again.

- The overlay does not change the legacy state. `getState()`, `getUserGrampsID()` and `requireSessionToken()` report the legacy values.
- `forgetEdgeSession()` drops it, and `auth-v2.js` calls that on sign-out.
- With `authV2` off, `edgeSession()` resolves `null`, so the overlay is never set and visibility follows the legacy state alone.

### Build variables

The data file reads these variables when `<eleventy-source>` builds.

| Variable | Sets | Default |
|---|---|---|
| `HFY_FEATURE_FLAGS__GATEWAY__ENDPOINT` | `gateway.endpoint` | `/api/check-allowed` |
| `HFY_FEATURE_FLAGS__GATEWAY__CONTEXT` | `gateway.context` | `site` |
| `HFY_FEATURE_FLAGS__GATEWAY__ENFORCE_ASSETS` | `gateway.enforceAssets`. When the variable is set, only the string `true` produces `true`. | `true` when the variable is unset |
| `HFY_FEATURE_FLAGS__DEBUG` | `gateway.debug` | `false` |

### `enforceAssets` on the production host

When the page's hostname is the production host (`<site>`, written into the script) and `gateway.enforceAssets` is not `true`, `feature-flags.js` logs a console error and sets it to `true`. `/posts/` and `/me/notifications/` have no inlined config, so on the production host the error is logged on every load of those pages. There, the forced value is set on a detached object, and `config.gateway` stays undefined.

The token waits and the `/family-login/` redirects below apply only with `authV2` off:

- `person-page.js`, `search-results.js` and `search-navbar.js` wait up to 8 seconds for a legacy session token before their first data load. If none arrives, they redirect to `/family-login/?next=<path, query and hash>`.
- With `enforceAssets` on, the two search scripts then wait up to 8 more seconds when they build the request headers, and fail the load if no token arrives.
- The search island's people corpus waits up to 8 seconds as well. If no token arrives and `enforceAssets` is on, it redirects to `/family-login/?next=<path, query and hash>`. Without `enforceAssets` it requests the files with no header.

With `authV2` on, `person-page.js`, the two search scripts and the people corpus skip the token wait and the `/family-login/` redirect. They send the cookie through `dataFetch`, which sends a visitor who cannot be recovered to `/auth/login` instead (see [authV2 data fetch and session continuity](#authv2-data-fetch-and-session-continuity)).

### Debug switches

`feature-flags.js` logs `[HFYFeatureFlags]` debug messages when any of these is true:

- `config.debug` is truthy. This is the top-level field, which the data file does not emit.
- `window.HFY_DEBUG_FEATURES === true`.
- `localStorage.HFY_DEBUG_FEATURES` is `"true"`.

`search-navbar.js` honors the same window and `localStorage` switches, plus `HFY_SEARCH_CONFIG.debug`, and logs with the `[HFY_SEARCH]` prefix. `search-results.js` has no debug switch.

### Session cache

- `sessionStorage["HFY_GATEWAY_SESSION_V1"]` holds `{token, grampsId, expiresAt, verifiedAt}`.
- The script reads the entry when it starts. An entry with no token, or one past its expiry, is removed. A valid entry sets `loggedIn: true`.
- `verifySession` and `acceptSession` write the entry.
- The entry is removed when the gateway denies access, when verification fails, on `updateState({ sessionToken: null })`, and when `requireSessionToken` finds the token expired. The `auth-v2.js` sign-out and the shell's fallback sign-out also remove it.
- `sessionStorage` is scoped to one tab, so a new tab starts without the cached token.

## Islands

### Catalog

| Island | Flag | Page | Host element | Data sources | Fallback |
|---|---|---|---|---|---|
| [`shell`](../../islands/src/islands/shell.jsx) | `shellV2`, or `searchV2` through HFY-R48 | Every page that loads `feature-flags.js` | Creates `#hfy-shell-root` as the first child of `<body>`. It then moves the rest of the body into its scroller, except `<script>` and `<noscript>` elements, elements marked `data-hfy-keep` (the preview banner) and Bootstrap `.modal` dialogs. The scroller is a focusable `div.hfy-scroller` with `data-io-scroller`, `role="region"` and `aria-label="page content"`, not a `<main>`: the page's own `<main>` stays the only main landmark. | `resolveFlags()` for `searchV2`, `notifyV2`, `navMe` and `familyViz` (the island mounts once the flags have resolved, so the bar's first paint already has its final number of cells), and `HFYFeatureFlags.edgeSession()` for the own-page route, the gear and the account control. With `searchV2` on, the people corpus (`/person/index.json` and `/person/search-index.json`) supplies suggestions. Its requests send `X-HFY-Session` with `authV2` off and the `io_id` cookie with it on. | The loader removes `hfy-shell-v2`. |
| [`search`](../../islands/src/islands/search.jsx) | `searchV2` | `/search`, `/search/`, `/search/index.html` | `#hfy-search-v2`, prepended to the page's own `<main>` (the first `main` without `data-io-scroller`, or `<body>` when there is none) | `/person/index.json` and `/person/search-index.json`, through `dataFetch`. With `authV2` off they carry `X-HFY-Session` and `credentials: "include"`, and with it on the `io_id` cookie only. The corpus is held in memory only. | The loader un-hides the legacy section, which then loads results. |
| [`person`](../../islands/src/islands/person.jsx) | `personV2` | `/person/?id=<gramps_id>` | Waits until `#person-content` is visible and contains `.notes-panel`. When the record has notes, it removes the panel's children other than its `<h2>` and mounts `#hfy-notes-v2` in the panel. It then appends `#hfy-person-comments` as the last child of `#person-content`, after the life, family, photos and stories sections. | `/person/<gramps_id>.json`, through `dataFetch` with `interactive: false`: `X-HFY-Session` with `authV2` off, the `io_id` cookie with it on. Also `/api/comments` for subject `person:<gramps_id>`, and `/auth/session`. | None. If the JSON fetch fails or the person has no notes, the legacy notes stay. The island never redirects to sign-in. |
| [`my-posts`](../../islands/src/islands/my-posts.jsx) | `postsV2` | `/person/?id=<gramps_id>` | `#hfy-my-posts`, inserted after `.notes-panel`. It renders only when the `sub` from `/auth/session` equals `<gramps_id>`. | `/auth/session`; `GET /api/posts` with `subject=<gramps_id>`; `POST /api/posts`; `POST /api/uploads`, then a `PUT` to the presigned URL | None |
| [`timeline`](../../islands/src/islands/timeline.jsx) | `postsV2` | `/`, `/index.html` | `#hfy-timeline`, appended to the page's own `<main>`. It renders nothing until `edgeSignedOut()` has answered `false`, and nothing at all for a visitor who is signed out. | `GET /api/posts` (published, 20 per page, by cursor) | None |
| [`posts`](../../islands/src/islands/posts.jsx) | `postsV2` | `/posts`, `/posts/`, `/posts/index.html`; `?id=<ulid>` shows one post | `[data-island="posts"]`. Rendering replaces the placeholder text. | `GET /api/posts`; `GET /api/posts/<ulid>`; `/api/comments` for subject `post:<ulid>`; `/auth/session` | None. The placeholder stays. |
| [`notifications`](../../islands/src/islands/notifications.jsx) | `notifyV2` | `/me/notifications/` | `[data-island="notifications"]`. It removes `[data-notify-off]`. | The `@io-kit/notify` client on `/api`, sent with credentials: `/api/notifications/preferences`, `/api/notifications/subscribe` and `/api/notifications/vapid-public-key` | The "notifications aren't turned on yet." text stays. |
| [`settings`](../../islands/src/islands/settings.jsx) | `navMe` | `/me`, `/me/`, `/me/index.html` | `[data-island="settings"]`. It removes `[data-settings-off]`. | `HFYFeatureFlags.edgeSession()`, through `useEdgeSession()` in `edge-session.js`. No `/api` call. | The "settings aren't turned on yet." text stays. |

Every `/api` call is same-origin and uses `credentials: "include"`, so it carries the auth-edge session cookie. Routes are described in the [API reference](api.md), and `/auth/session` in [identity services](identity-services.md). `createApi` does not send an `/api` request when `HFYFeatureFlags.edgeSession()` has answered `authenticated: false`: it throws `ApiError(401, "unauthenticated")` instead, so a signed-out visitor causes no 401 in the console. The notifications island's `@io-kit/notify` client applies the same check to each of its requests, and answers them locally with the API's own 401 body. With `authV2` off, or with `/auth/session` unreachable, requests are sent as before. The islands' own `/auth/session` calls go through `getSession()` in `api.js`, separately from `HFYFeatureFlags.edgeSession()`, and never refresh.

Per-island details:

- **shell.** The navigation registry is `navItems({ navMe, familyViz, notifyV2, sub })` from [`nav.js`](../../islands/src/lib/nav.js). With `navMe` off it has five lowercase entries: home, family, search, posts and me, where family is the own page and me the settings (`/me/notifications/` with `notifyV2`, else `/family-login/`). With `navMe` on and `familyViz` off it has four: home, search, posts and me, where me is the own page. With both on it has five again, family being `/tree/`. The own page is `/person/?id=<sub>` once the edge session names the member, and `/private/` until then, and its item is marked `aria-current` on that page only. No route is ever `/family/`, a gated data prefix. Under 688 px the shell shows the entries as a bottom bar, in equal cells. From 688 px it shows a translucent top bar with the "Harrison Family" brand, the links and an inline search field. It has no sidebar or rail at any width. Under 688 px the top strip hides the search launcher, which `Cmd`/`Ctrl`+`K` still opens. The account control at the end of the bar works as follows:
  - While the edge session is pending, it shows a placeholder.
  - When the edge answered signed out, it shows a "sign in" link to `/auth/login?returnTo=<path, query and hash>`.
  - When `edgeSession()` resolved `null` (`authV2` off, or `/auth/session` unreachable), the "sign in" link goes to `/family-login/?next=<path, query and hash>`.
  - When the visitor is signed in, it shows a button with the initial of the session's label. The button opens a sheet with "your page" (`/person/?id=<sub>`), "notifications" (with `notifyV2`) and "sign out". With `navMe` the sheet reads "your page", "settings" (`/me/`) and "sign out".
  - With `navMe`, a signed-in visitor also gets the gear, `a.hfy-gear`, before the account control: a 44 by 44 link to `/me/` labelled "settings", whose icon is a `currentColor` mask, gold with `aria-current="page"` on `/me/` and its sub-paths.
  - "sign out" (`signOut()` in [`sign-out.js`](../../islands/src/lib/sign-out.js), which the settings hub shares) clicks the navbar's sign-out link when `auth-v2.js` has wired it. On pages without it, the shell clears the same legacy keys, calls `forgetEdgeSession()`, sends `POST /auth/logout` with `keepalive` and `X-Requested-With: io-kit`, waits at most 4 s, and then runs `HFY_AUTH.signOut()` or goes to `/logged-out/`.

  The shell also shows an offline banner while the browser reports no connection. It shows one add-to-home-screen card, first in the scroller: with an "add" button where the browser offers installation, or with share-sheet instructions on iOS. The card does not appear once the app is installed or running standalone, after a dismissal, which it remembers in `localStorage["hfy:install-dismissed"]`, or on iOS on `/me/notifications/`, where the notifications page shows its own iOS hint. The shell registers the service worker (see [Service worker](#service-worker)).
- **search.** Reads the query from `?q=` or `?query=`, and focuses the input when `?focus=1` is present. It shows 30 results per page, with a load-more button. Each result links to `/person/?id=<gramps_id>`. Corpus errors appear in the banner, never as an empty state. Cloudscape's half of its theme is a static stylesheet generated at build time ([Island build](#island-build)).
- **person.** Renders notes through `@io-kit/md` with the comments package's `userContentPolicy`, inside the legacy note card markup.
- **my-posts.** The composer accepts JPEG, PNG, WebP and HEIC images, up to four attachments per post. The island hides the kit's file input behind its own "add a photo" button, gives the composer and alt-text inputs placeholders, and shows a thumbnail for each uploaded photo.
- **posts and timeline.** Each post has a "comments" link to `/posts/?id=<ulid>` and, when `can.delete` is true, a "delete" button that asks "delete this post?" inline before it deletes. A "show older posts" button loads the next page. On `/posts/`, a signed-out visitor sees a sign-in prompt with a "sign in" link to `/auth/login?returnTo=<path and query>`, not an error banner.
- **settings.** The `/me/` hub. It uses the shell's rule for "signed in" (`useEdgeSession()` and `memberSub()` in [`edge-session.js`](../../islands/src/lib/edge-session.js)), so it shows the rows exactly when the bar shows the gear. Signed in at the edge (an authenticated edge session with a `sub`), it shows one column of rows 56 px high, each a link with an icon, a label and one dim line: "notifications" (`/me/notifications/`, "texts on this device, and what they're about") and "sign-in and devices" (`/auth/link`, "google, password, face or fingerprint"), then a "sign out" row that runs the shell's `signOut()`. A row grows only where its dim line wraps, at narrow widths. Otherwise it shows "sign in to change your settings." and a "sign in" link, with no rows and no "sign out". The link goes where the account control's does: to `/auth/login?returnTo=%2Fme%2F` when the edge answered (signed out, or a session without a `sub`), and to `/family-login/?next=%2Fme%2F` when `edgeSession()` resolved `null` (`authV2` off, or `/auth/session` unreachable). While the session is pending it shows a one-row skeleton. From 688 px the column is 40rem wide.
- **notifications.** Covers four types: `comment_on_my_record`, `reply_to_me`, `new_family_post` and `mention`. Each type has two detail levels, `generic` (the default, content-free) and `detailed` (may name the actor). The preview strings in `CATALOG` match what the server sends ([`api/src/notify.js`](../../api/src/notify.js)). A visitor who is signed out at the edge sees one line and a "sign in" link to `/auth/login?returnTo=<path and query>`, and the island renders no push nudge and no settings, so it never calls the push API. A 401 from the preferences request, as with `authV2` off, switches to the same prompt. A push nudge remembers its dismissal in `localStorage["hfy:notify-nudge"]`. On iOS the nudge tells the member to add the site to the home screen first.

### Shared libraries

All files are in [`islands/src/lib/`](../../islands/src/lib/).

| File | Exports | Behavior |
|---|---|---|
| [`mount.jsx`](../../islands/src/lib/mount.jsx) | `mountIsland(name, Component)`, `mountAt(place, node, id)` | `mountIsland` renders into every `[data-island="<name>"]` element and replaces its content. Props come from the element's `data-props` JSON, and invalid JSON means no props. `mountAt` creates a `div` with the given `id`, lets `place` insert it, renders into it and returns it. |
| [`api.js`](../../islands/src/lib/api.js) | `createApi`, `api`, `ApiError`, `getSession`, `edgeSignedOut`, `signedOutResponse` | `createApi({ base = "/api", fetchImpl, skipWhenSignedOut })` returns `request`, `get`, `post`, `patch` and `del`. `skipWhenSignedOut` defaults to `true` when the base is `/api`: such a request is not sent when `edgeSignedOut()` is true, and throws `ApiError(401, "unauthenticated")`. Requests and responses are JSON, with `credentials: "include"`. Empty query values are dropped, and a 204 returns `undefined`. A failed response throws `ApiError(status, code, message, field)`. The `code` comes from the body's `error`, or else from the status: 401 `unauthenticated`, 403 `forbidden`, 404 `not_found`, 400 or 422 `validation`, anything else `server`. A network failure throws with status 0 and code `network`. `getSession()` calls `GET /auth/session` and returns `{authenticated, sub, label}`. It never throws: any failure returns signed-out. `edgeSignedOut()` is `true` only when `HFYFeatureFlags.edgeSession()` answered `authenticated: false`. `signedOutResponse()` builds the API's own 401 body for a request that was not sent. |
| [`content-source.js`](../../islands/src/lib/content-source.js) | `CAPABILITIES`, `createHfyContentSource(api)` | The `@io-kit/content` source over `/api/posts`. Capabilities: `drafts: false`, and `edit`, `subject`, `getById` and `audit` all `true`. `createDraft` publishes at once (`visibility: "published"`) and rejects `visibility: "draft"`. `setVisibility` always rejects, and every post's `can.publish` is forced to `false`. `ApiError` maps to `ContentError`, with `unauthenticated` becoming `forbidden`; a 401 also sets `signedOut` on the error, so the islands can tell signed out from not allowed. |
| [`comment-source.js`](../../islands/src/lib/comment-source.js) | `createHfyCommentSource(api, { onAdded })` | The `@io-kit/comments` source over `/api/comments`. The thread ID is the subject. It supports list, create, edit, delete and react, and reactions are allowed only on `comment:` targets. The server computes each comment's `can.*`. `onAdded` receives each comment the server stored. Errors become `CommentError`s whose message is the family-facing line for the code, with the original error on `cause`. |
| [`comments-ui.jsx`](../../islands/src/lib/comments-ui.jsx) | `Comments({ subject })`, `linkify`, `LABELS`, `guardCommentDeletes` | The comments thread for `person:<gramps_id>` or `post:<ulid>`, with lowercase labels. Signed out, it shows "sign in to leave a comment." and a "sign in" link to `/auth/login?returnTo=<path and query>`. Deleting your own comment asks "delete this comment?" inline first (`guardCommentDeletes`). Moderators: a signed-in viewer gets the kit's `admin` role, and with it the "moderate" control, only when `canModerate(await getMe())` from [`me.js`](../../islands/src/lib/me.js) is true; a 401 or any failure of `GET /api/me` means no moderator controls. Nothing infers it from `can.delete`, and `islands/tests/me.test.mjs` fails if this file or `comment-source.js` reads `can.delete`. The kit still shows each delete control (your own "delete", or a moderator's "moderate") only where that comment's server-computed `can.delete` is true, and the server decides each action. Mentions: record IDs (`I` followed by four or more digits) link to `/person/?id=`. |
| [`me.js`](../../islands/src/lib/me.js) | `getMe`, `canModerate`, `NOT_ME`, `forgetMe` | The islands' one reader of [`GET /api/me`](api.md). `getMe()` sends `GET /api/me` with `credentials: "same-origin"` on its first call and shares that answer with every later caller on the page, so a page sends it at most once. It resolves `{id, label, admin, can, ...}`, with `admin` true only for a literal `true`. It never rejects: a 401, a network failure, any other error status or a body that is not an object resolves `NOT_ME` (`admin: false`, no capabilities), with a console warning for everything but the 401. Like `createApi`, it sends nothing when `edgeSignedOut()` is true. `canModerate(me)` is `can.moderate` when the server sent it as a boolean, and otherwise `admin`. `forgetMe()` drops the shared answer (tests). The answer only decides which controls to show; every write is checked on the server. |
| [`posts-ui.jsx`](../../islands/src/lib/posts-ui.jsx) | `source`, `postHref`, `signInHref`, `COPY`, `isSignedOut`, `friendlyError`, `CARD_LABELS`, `ErrorText`, `SignInGate`, `Banner`, `Skeletons`, `usePing`, `Ping`, `useTimeTitles`, `usePosts`, `PostRow`, `EmptyPosts`, `PostList`, `formatTime` | `usePosts(filter)` loads published posts newest first, 20 per page by cursor, and drops duplicates. It returns `more`, `reload`, `remove` and `prepend`. `PostList` renders the rows, an empty state, and a "show older posts" button. `Banner` shows errors in a `role="alert"` banner, except the signed-out case, which renders `SignInGate`, a `role="status"` line with a "sign in" link. |
| [`nav.js`](../../islands/src/lib/nav.js) | `navItems`, `onSettings`, `OWN_PAGE_REDIRECT`, `TREE_ROUTE`, `SETTINGS_ROUTE` | `navItems({ navMe, familyViz, notifyV2, sub })` returns the shell's registry items, `{id, label, route, icon, order}`, for the flags and the edge session's `sub` (see the shell above). `onSettings(pathname)` is true on `/me/` and its sub-paths, where the gear is current. Pure, so `islands/tests/family-route.test.mjs` tests every flag combination in node. |
| [`family-route.js`](../../islands/src/lib/family-route.js) | `ownRoute`, `onOwnPage`, `navPathname` | The own page, `/person/?id=<sub>`; whether a location is that page, the id compared exactly; and the pathname the nav matches its routes against, which is the own route itself on the own page. |
| [`edge-session.js`](../../islands/src/lib/edge-session.js) | `useEdgeSession`, `memberSub` | `useEdgeSession()` is the React hook over `HFYFeatureFlags.edgeSession()`: `undefined` while it is pending, `null` when `authV2` is off, `/auth/session` is unreachable, `feature-flags.js` is missing or the probe rejects, and otherwise the session. `memberSub(session)` returns the session's `sub` when it is authenticated and has one, and `null` otherwise. That is the one rule for "signed in" that the shell's account control, its gear and own-page route, and the settings hub share. |
| [`sign-out.js`](../../islands/src/lib/sign-out.js) | `signOut` | The sign-out of the shell's account sheet and the settings hub, described under the shell above. |
| [`time.js`](../../islands/src/lib/time.js) | `formatTime`, `fullTime`, `watchTimeTitles` | The one site time format, used by posts, comments and notifications: relative under 7 days, then month and day, with the year when it differs. `watchTimeTitles` keeps the full date in a `title` on every `<time datetime>` under a root. |
| [`upload.js`](../../islands/src/lib/upload.js) | `uploadPhoto(api, file)` | Sends `POST /api/uploads` with `{filename, contentType, size}`, then `PUT`s the bytes to the returned `uploadUrl`, which is cross-origin and gets no cookies. Returns `{kind: "image", url: publicUrl, mime}`. |
| [`people-corpus.js`](../../islands/src/lib/people-corpus.js) | `SEARCH_COPY`, `peopleSource`, `peopleProperties`, `mapPerson`, `suggestPeople` | The local-only people corpus used by the search island and the shell launcher. It seeds from the person manifest and the search index through `HFYFeatureFlags.dataFetch`, as an interactive load. With `authV2` off it sends the gateway token, waiting for it as described under [`enforceAssets`](#enforceassets-on-the-production-host). With `authV2` on it sends the `io_id` cookie and does not wait. Its errors carry a `SEARCH_COPY` line as the message and the technical detail on `cause`. Facets: surname, given name, birth year, death year, living and has photo. `suggestPeople` returns up to six suggestions. |
| [`cloudscape-theme.js`](../../islands/src/lib/cloudscape-theme.js) | `CLOUDSCAPE_TOKENS` | Cloudscape theme tokens for the search island, each a `var(--io-search-*)` alias. Read only at build time, through the `hfy:cloudscape-theme` import ([Island build](#island-build)). |

### Island build

[`islands/build.mjs`](../../islands/build.mjs) builds every islands output into a site directory:

```sh
node build.mjs [--site <dir>] [--check]
```

The default site is `../11ty`. `--site <dir>` builds into a scratch copy of the site instead, for example for parallel work. The build exits with status 2 when `--site` has no value or the directory has no `index.html`. It writes only files whose bytes changed, and it prunes `js/islands/` and `fonts/` to exactly its outputs. It no longer deletes `js/islands/` before each build. It ends by printing `built <n> files into <site> (<m> written)`.

One build writes all of these:

| Output | Source |
|---|---|
| `js/islands/**`: the entries, the chunks and `notify-sw.js` | `islands/src/islands/*` and `@io-kit/notify`'s `sw/notify-sw.js` |
| `css/hfy-theme.css` | `islands/src/theme/` and `@io-kit/tokens` |
| `css/auth-edge.css` | `islands/src/auth-edge/auth-edge.css`. Skipped with a warning when that file is missing. |
| `fonts/*` | The three `@fontsource` packages, through [`islands/fonts.mjs`](../../islands/fonts.mjs) |
| The head blocks in the 14 pages | [`islands/heads.mjs`](../../islands/heads.mjs) |
| The Voice copy in the ten rendered pages | [`islands/copy.mjs`](../../islands/copy.mjs) |
| The `background_color` and `theme_color` of `manifest.webmanifest` | The resolved surface token |
| The `hfy-asset-versions` blocks in `sw.js` and `js/feature-flags.js`, then `?v` on every page | [`islands/assets.mjs`](../../islands/assets.mjs) |
| `theme.cssUrl` in `../auth/edge.manifest.json`, as a one-line text edit | `assets.mjs`. Only when the site is the repository's own `11ty/`, never for a `--site` copy. |

Everything but the island bundles is described in detail in [Theme and asset build](theme-and-asset-build.md). The island bundles are built by esbuild with these settings:

| Setting | Value |
|---|---|
| Entry points | Every `.js` and `.jsx` file in `islands/src/islands/` |
| Output directory | `<site>/js/islands/` |
| Bundling | `bundle: true`, `splitting: true`, `format: "esm"` |
| Targets | `es2020`, `safari15` |
| JSX | Automatic runtime |
| Minification | On, with no source maps |
| Chunk names | `chunks/[name]-[hash]` |
| Defines | `process.env.NODE_ENV` set to `"production"` |
| CSS | CSS imported by an entry is bundled into `<name>.css` |
| Plugin | `hfy-cloudscape-theme`, which resolves the `hfy:cloudscape-theme` import in `search.css` and generates Cloudscape's theme stylesheet at build time from `CLOUDSCAPE_TOKENS` with Cloudscape's own `generateThemeStylesheet`, so the search island ships static CSS and no theming runtime |
| Also copied | `node_modules/@io-kit/notify/sw/notify-sw.js` to `js/islands/notify-sw.js` |

`node build.mjs --check` (the `check:islands` script) builds everything in memory, without writing, and compares it byte for byte with the site. `<site>` in its output is the absolute path. It ignores `.DS_Store`.

| Result | Output | Exit |
|---|---|---|
| Every file matches | `<site> is up to date (<n> generated files)` | 0 |
| A file is absent, differs or is not produced by the build | ``<site> is out of date with islands/ (run `npm run build` and commit):``, then one indented line per problem: `missing <path>`, `stale <path>`, or `extra <path>` for a file in `js/islands/` or `fonts/` that the build does not produce. A stale edge manifest shows as `stale auth/edge.manifest.json`. | 1 |

The output layout:

```text
<site>/
  js/islands/<name>.js                one per island
  js/islands/<name>.css               one per island that imports CSS (currently all of them)
  js/islands/chunks/chunk-<hash>.js   shared code (React, @io-kit/*); content hash, changes when that code changes
  js/islands/notify-sw.js             imported by /sw.js
  css/hfy-theme.css                   the theme layer
  css/auth-edge.css                   the sign-in pages' stylesheet
  fonts/<base>.<sha8>.woff2           the self-hosted faces
  fonts/LICENSE-<family>.txt          their OFL licences
```

Every output listed above is committed: `11ty/js/islands`, `11ty/css/hfy-theme.css`, `11ty/css/auth-edge.css`, `11ty/fonts`, the pages the build writes into, `11ty/js/feature-flags.js`, `11ty/sw.js`, `11ty/manifest.webmanifest` and `auth/edge.manifest.json`. A changed `theme.cssUrl` takes effect only after an `hfy-auth-edge` redeploy. The procedures are in [Build and preview the islands](../how-to/build-and-preview-the-islands.md) and [Deploy the edge functions](../how-to/deploy-the-edge-functions.md).

[`islands/package.json`](../../islands/package.json) pins every dependency to an exact version. The lockfile `islands/package-lock.json` is committed, and the package requires Node 22 or later.

| Package | Version |
|---|---|
| `@io-kit/comments` | 0.1.0 |
| `@io-kit/content` | 0.1.1 |
| `@io-kit/md` | 1.2.0 |
| `@io-kit/notify` | 0.4.0 |
| `@io-kit/search` | 1.0.1 |
| `@io-kit/search-ui` | 1.0.10. It brings `@cloudscape-design/components` 3.0.1396. |
| `@io-kit/shell` | 0.6.6 |
| `@io-kit/tokens` | 0.4.1 |
| `react`, `react-dom` | 19.3.0 |
| `esbuild` | 0.28.2 |
| `@playwright/test` | 1.64.0 |
| `@fontsource-variable/source-sans-3` (dev) | 5.3.0 |
| `@fontsource/libre-caslon-text` (dev) | 5.3.0 |
| `@fontsource-variable/source-code-pro` (dev) | 5.3.0 |
| `http-server` (dev) | 14.1.1 |

The build reads the fonts from the dev dependencies, so it needs `node_modules` from an `npm ci` that includes them.

Its scripts:

- `build` and `build:islands` both run `node build.mjs`.
- `check:islands` runs `node build.mjs --check`.
- `lint:css` runs the theme lint, `tests/theme-lint.test.mjs`.
- `test:contract` runs the `node:test` tests, `tests/*.test.mjs`.
- `test` runs the `node:test` tests and then Playwright.

The `node:test` tests include the theme lint and `bundle.test.mjs`, which fails when a committed output is missing, gitignored or stale.

[`islands/.npmrc`](../../islands/.npmrc) maps the `@io-kit` scope to the `io-kit` npm repository in AWS CodeArtifact (domain `io`, `us-west-2`, account `<aws-account-id>`). It reads the auth token from `${CODEARTIFACT_AUTH_TOKEN}`, so the token is never committed. `aws codeartifact get-authorization-token --domain io` issues one. Without it, `npm ci` cannot fetch the `@io-kit` packages.

[`scripts/ci/build-islands.sh`](../../scripts/ci/build-islands.sh) runs these steps:

1. Fails immediately if `CODEARTIFACT_AUTH_TOKEN` is unset. It never prints the token.
2. Runs `npm ci --ignore-scripts --no-audit --no-fund` in `islands/`, with its standard output discarded. Its standard error still prints. That installs the dev dependencies too.
3. Runs `npm run build:islands`, the full build above.
4. Asserts that `11ty/js/islands/shell.js` and `11ty/js/islands/shell.css` exist and are non-empty. It checks no other output, and it prints `built islands -> 11ty/js/islands`.

No workflow runs the script, `check:islands` or the island tests. The committed outputs ship with the `11ty/` sync, which runs with `--delete` and excludes none of them, so an output that is not committed is removed from the bucket by the next deploy. See [repository operations](repository-operations.md#what-no-workflow-ships-or-runs), and for the rebuild, [build and preview the islands](../how-to/build-and-preview-the-islands.md).

## Service worker

[`11ty/sw.js`](../../11ty/sw.js):

| Aspect | Behavior |
|---|---|
| Registration | Only the shell island registers the worker, at `/sw.js?v=<sha8 of sw.js>` from `HFYFeatureFlags.assetVersions.sw`, or at `/sw.js` when that is unstamped. It uses `{ scope: "/", updateViaCache: "none" }` and ignores errors. Nothing unregisters it. With `shellV2` off, new visitors never get the worker, but a browser that already registered it keeps it. |
| Cache name | `hfy-shell-<v>`, where `<v>` is the `?v` the worker was registered at, when that is 8 lowercase hex characters. Otherwise `hfy-shell-dev`. A change to `sw.js`, including its stamp, which holds the hashes of the files it precaches, gives a new name. |
| Stamp | The `hfy-asset-versions` block: `theme`, `manifest`, the shell's `js` and `css`, and `notify`. Every islands build rewrites it. |
| Precache | `/offline.html`, `/css/hfy-theme.css?v=<sha8>`, `/js/islands/shell.js?v=<sha8>`, `/js/islands/shell.css?v=<sha8>`, `/manifest.webmanifest?v=<sha8>` and `/images/pwa-192.png`. Each is fetched with `cache: "reload"` and added on its own, and failures are ignored, so install succeeds even when a file is missing. Install then calls `skipWaiting()`, so a new worker replaces the old one at once. |
| Imports | `importScripts("/js/islands/notify-sw.js?v=<sha8>")` inside `try`/`catch`. This adds push handling and notification-click deep links from `@io-kit/notify`, and is skipped silently when the file is absent. |
| Activate | Deletes every other cache, then claims open clients. |
| Message | `"SKIP_WAITING"` or `{type: "SKIP_WAITING"}` calls `skipWaiting()`. No code in the repository sends this message. |
| Fetch: ignored | Non-GET requests, cross-origin requests, and `/auth`, `/api` and every path below them. |
| Fetch: navigations | Network first. On a network failure the worker answers with the cached `/offline.html`. HTTP error responses pass through unchanged. |
| Fetch: `/js/islands/chunks/*` and `/fonts/*` | Cache first. Their names carry a content hash, so a cached copy never goes stale. A miss is fetched and, when the response is a same-origin `200`, stored for offline use. |
| Fetch: the precached paths and every other `/js/islands/*` | Network first. Each same-origin `200` is stored and replaces any cached copy of the same path under another `?v`, so one copy per path is kept. After a deploy, an entry module therefore always matches the chunk hashes on the server. Offline, the worker answers with the cached copy of the exact URL, else the newest cached copy of the path under any `?v`, else a network error. |
| Fetch: other GETs | Not handled. The browser's default applies. |
| Caching headers | The file's header comment asks for `Cache-Control: no-cache`. The deploy's `aws s3 sync` uploads it without a `Cache-Control` value, and no other script sets one. `updateViaCache: "none"` makes the browser skip its HTTP cache on update checks. Cloudflare can still hold a bare `/sw.js` for 4 hours, which is why the registration URL carries `?v`: a new `?v` is a URL the edge has not stored. |

## Web app manifest and offline page

[`11ty/manifest.webmanifest`](../../11ty/manifest.webmanifest):

| Field | Value |
|---|---|
| `name` | `Harrison Family Heritage` |
| `short_name` | `Harrison Family` |
| `start_url`, `scope` | `/` |
| `display` | `standalone` |
| `background_color`, `theme_color` | `#141210`, the resolved `--io-color-semantic-surface` token. The islands build writes both. |

| Icon | Size | Purpose |
|---|---|---|
| `/images/pwa-192.png` | 192 × 192 | `any` |
| `/images/pwa-512.png` | 512 × 512 | `any` |
| `/images/pwa-maskable-512.png` | 512 × 512 | `maskable` |

No page links the manifest statically. The loader appends the manifest link, versioned, only after the shell island has loaded (HFY-R58), so a failed shell leaves the page without it. The `theme-color` meta does not depend on the shell: block A puts it on every page.

[`11ty/offline.html`](../../11ty/offline.html) uses the theme layer: head blocks A, without the early hint, and B. It has no inline styles and loads no scripts. It says the visitor is offline and that pages already opened still work, and its "try again" link reloads the page's own URL. The service worker serves it when a page navigation fails at the network level.

## Browser storage

The keys that the site's scripts and islands, and the auth edge's sign-in page on the same origin, read and write. None holds a token from the edge session, which lives in HttpOnly cookies.

| Key | Storage | Written by | What it holds |
|---|---|---|---|
| `hfy:flags` | `sessionStorage` | `feature-flags.js` | The preview override. A `localStorage` copy from before HFY-R58 is deleted on every load. |
| `hfy:auth-bounce` | `sessionStorage` | `feature-flags.js` | When this tab was last sent to sign-in by a failed data fetch. |
| `hfy:edge-session` | `localStorage` | `feature-flags.js` | `"1"` once this browser has had an edge session. |
| `hfy:shell-hint` | `localStorage` | `feature-flags.js` | `"1"` after the shell loaded, `"0"` when `shellV2` is off or the island failed. Block A's early hint reads it. |
| `hfy:install-dismissed` | `localStorage` | The shell island | `"1"` after "not now" on the add-to-home-screen card. |
| `hfy:notify-nudge` | `localStorage` | The notifications island, through the kit's push nudge | The nudge's dismissal. |
| `io-passkey-dismissed` | `localStorage` | The sign-in page that `@io-kit/auth` serves under `/auth/` | `"1"` after the member declines the offer to add a passkey ([Identity services: Passkeys](identity-services.md#passkeys)). |
| `HFY_GATEWAY_SESSION_V1` | `sessionStorage` | `feature-flags.js` | The legacy gateway session ([Session cache](#session-cache)). |
| `HFY_SEARCH_DATA_CACHE_V1` | `sessionStorage` | `search-navbar.js`, when the legacy navbar search runs | The person manifest and search index. Neither sign-out path removes it. |
| `HFY_AUTH_ID_TOKEN`, `HFY_AUTH_USER_GRAMPS_ID` | `localStorage` | `auth.js`, after a legacy Google sign-in | The Google ID token and the member's Gramps ID. Both sign-out paths remove them. |
| `HFY_DEBUG_FEATURES`, `HFY_DEBUG_AUTH` | `localStorage` | Set by hand | `"true"` turns on the debug logs: the first for `feature-flags.js` and `search-navbar.js` ([Debug switches](#debug-switches)), the second for `auth.js`. |

## Tests

These suites cover the mechanisms on this page. The theme, copy and lint suites are listed in [Theme and asset build](theme-and-asset-build.md), and every suite in [Run the tests](../how-to/run-the-tests.md).

| Suite | What it checks | How it runs |
|---|---|---|
| [`tests/client/data-fetch.test.mjs`](../../tests/client/data-fetch.test.mjs) | Loads the real `feature-flags.js` into a `node:vm` sandbox with a stubbed browser. Checks `dataFetchInit()` with `authV2` off, on and turned on by the `?hfy_flags=authV2` override, and the deprecated `dataResponse` redirect. Then reads the sources to check that `person-page.js`, the two search scripts, the `person` island and `people-corpus.js` take the `authV2` path before they build any `X-HFY-Session` request, and fetch data through `dataFetch`. | `node --test tests/client/*.test.mjs` from the repository root. It needs no install. |
| [`tests/client/auth-continuity.test.mjs`](../../tests/client/auth-continuity.test.mjs) | The same sandbox with a routed `fetch` stub that records every request. Covers flag-off parity, one `/auth/session` per page, the preflight refresh, the single-flight refresh with one retry on a 401, interactive and background loads after a failed refresh, the bounce guard, a refresh that does not cure the 401, the `hfy:edge-session` marker, the edge overlay, and `auth-v2.js` probing through `edgeSession`. Also `/family-login/?next=` to `returnTo`: safe paths kept with their query and hash, unsafe ones replaced by `/`, and no redirect for a visitor already signed in. | The same command. |
| [`islands/tests/auth-continuity.spec.mjs`](../../islands/tests/auth-continuity.spec.mjs) | Playwright against the `11ty/` pages served locally. Route interception stubs `/_data/flags.json` as all off, `/auth/session`, `/auth/refresh`, `/auth/login`, `/api` and the person data files, with synthetic data, and each test turns on its flags with `?hfy_flags=`. The stubbed gate is open, closed, or lapsed (401 until a refresh succeeds). Covers the hourly lapse on the person page, a 401 mid-session, a refresh token that is gone (one trip to sign-in, then the sign-in link), the search-island corpus and `person`-island notes over a lapsed session, public pages with stale or lapsed sessions, navigation after an edge-only sign-in, and flag-off parity. | `npm test` in `islands/`, which runs the `node:test` tests and then Playwright. Playwright serves `HFY_SITE` (default `../11ty`) on port `PW_PORT` (default 8089) with `npx http-server <site> -p <port> -a 127.0.0.1 -s -c-1`, so a `--site` scratch build can be tested. |
| [`islands/tests/flags-fallback.spec.mjs`](../../islands/tests/flags-fallback.spec.mjs) | Also stubs the build flags as all off. The banner and its "turn off" button, the per-tab override, the purge of the old `localStorage` override, the fallbacks when an island or `/auth/session` is unavailable, the static `theme-color` and the manifest link after the shell loads, the `authV2` sign-out, and the `/family-login/?next=` chain into `/auth/login`. | The same command. |
| [`islands/tests/d11-fixes.spec.mjs`](../../islands/tests/d11-fixes.spec.mjs) | The HFY-TSK-069 after-state audit fixes: no `/api` request and no 401 for a visitor signed out under `authV2`, no One Tap prompt under `authV2`, the focusable scroller region, and the legacy token fallback's `?next=`. | The same command. |
| [`islands/tests/sw.spec.mjs`](../../islands/tests/sw.spec.mjs), [`asset-versions.spec.mjs`](../../islands/tests/asset-versions.spec.mjs), [`asset-versions.test.mjs`](../../islands/tests/asset-versions.test.mjs) | The worker's registration URL and cache name, cache-first chunks and fonts, network-first entries and theme with one copy per path, and pages that request only versioned URLs while the bare URLs are stale. | The same command. |

No workflow runs these suites.

## Discrepancies

These are differences between the code and its comments, as of this page.

- **`auth-v2.js` and `/family-login/`.** The script's header comment says a visitor already signed in at the edge keeps the legacy sign-in on `/family-login/` because the edge session does not mint the legacy `X-HFY-Session` token that the person and search pages need. Under `authV2` those pages no longer use that token: they send the `io_id` cookie through `HFYFeatureFlags.dataFetch`. The branch still prevents a redirect loop back to `/auth/login`, which is the reason the inline comment at that branch gives.
- **`auth-v2.js` and the default.** The same header calls `authV2` off "the default". The committed `flags.json` has `authV2` set to `true`.
- **The legacy search scripts.** The header comments of `search-navbar.js` and `search-results.js` say each is "Deleted at the 069 flip". The flip landed with HFY-TSK-069, and both scripts are still in `11ty/js/` and still loaded by the rendered pages.
- **`copy.mjs` and CI.** Its header says that `build.mjs --check` "(CI)" fails while a page still carries the old copy. No workflow runs `check:islands`. The check fails only when someone runs it.
- **`build-islands.sh`.** Its header says it builds `11ty/js/islands/*`, and its last line prints `built islands -> 11ty/js/islands`. The build it runs also writes the theme layer, the sign-in stylesheet, the fonts, the pages, the manifest, the stamps and the edge manifest, and the script checks none of them.

## Related pages

- [Why React islands on a generated Eleventy site](../explanation/islands-on-eleventy.md)
- [The design system theme layer](../explanation/design-system-theme-layer.md)
- [The release model](../explanation/release-model.md)
- [The privacy model for family data](../explanation/family-data-privacy.md)
- [The identity model](../explanation/identity-model.md)
- [Edge and origin design](../explanation/edge-and-origin-design.md)
- [Theme and asset build](theme-and-asset-build.md)
- [Codebase map](codebase-map.md)
- [API](api.md)
- [Identity services](identity-services.md)
- [Private data and secrets](private-data-and-secrets.md)
- [Repository operations](repository-operations.md)
- [Toggle a feature flag](../how-to/toggle-a-feature-flag.md)
- [Cut over to authV2 and the private data gate](../how-to/cut-over-to-the-private-data-gate.md)
- [Diagnose sign-in and API failures](../how-to/diagnose-sign-in-and-api-failures.md)
- [Build and preview the islands](../how-to/build-and-preview-the-islands.md)
- [Change the theme or brand fonts](../how-to/change-the-theme-or-brand-fonts.md)
- [Refresh the Eleventy output](../how-to/refresh-the-eleventy-output.md)
- [Deploy a site change](../how-to/deploy-a-site-change.md)
- [Deploy the edge functions](../how-to/deploy-the-edge-functions.md)
- [Publish a change to the HFYAppendIndex CloudFront Function](../how-to/publish-the-cloudfront-function.md)
- [Run the tests](../how-to/run-the-tests.md)
