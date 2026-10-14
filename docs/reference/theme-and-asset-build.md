# Theme and asset build

Reference for the islands build's site-wide outputs: the theme layer, the sign-in stylesheet, the self-hosted fonts, the head blocks, the family-voice copy, the manifest colours and the asset versions. It also covers the build's command line, the theme lint, and the tests that pin each output.

[`islands/build.mjs`](../../islands/build.mjs) writes all of these besides the island bundles in `js/islands/`. The bundles, the esbuild settings and the pinned packages are in [Front end: Island build](front-end.md#island-build), and how the pages use the theme at run time is in [Front end: Theme layer and head blocks](front-end.md#theme-layer-and-head-blocks). For why the theme is a static layer built from design tokens, why its head blocks are markup, and why the fonts are self-hosted, see [The design system theme layer](../explanation/design-system-theme-layer.md). For why every static URL carries a content hash, see [Edge and origin design](../explanation/edge-and-origin-design.md#static-files-and-versioned-urls-hfy-tsk-086). The procedures are in [Build and preview the islands](../how-to/build-and-preview-the-islands.md) and [Change the theme or brand fonts](../how-to/change-the-theme-or-brand-fonts.md).

Placeholders used on this page:

- `<site>` is the site's host name, as defined in [private data and secrets](private-data-and-secrets.md#placeholders).
- `<site-dir>` is the directory a build writes into: the repository's `11ty/` by default, or the directory that `--site` names. Paths on this page are relative to it unless they start with `islands/`, `auth/` or `scripts/`.
- `<eleventy-source>` is the Eleventy project outside the repository that renders the ten Eleventy pages.
- `<sha8>` is the first 8 hex digits of the SHA-256 of a file's bytes. Docs never write a real hash.

## Outputs

Every output is committed build output (HFY-R58). The deploy syncs `11ty/` as it is and builds nothing, so a change reaches production only once the build has been rerun and its output committed. Never edit an output by hand: `npm run check:islands` fails while any of them differs from a fresh build ([Command line](#command-line)). No workflow runs the build or the check ([Repository operations](repository-operations.md#what-no-workflow-ships-or-runs)).

| Output | Where | Built from | Written by | Pinned by |
|---|---|---|---|---|
| The theme layer | `css/hfy-theme.css` | `islands/src/theme/` and `@io-kit/tokens` 0.4.1 | `build.mjs` | `theme-delivery`, `kit-aliases`, `theme-lint`, `bundle` |
| The sign-in stylesheet | `css/auth-edge.css` | `islands/src/auth-edge/auth-edge.css` and `@io-kit/tokens` | `build.mjs` | `theme-delivery`, `theme-lint`, `bundle`, `auth/test/edge.test.js` |
| The brand fonts | `fonts/` | Three `@fontsource` packages | [`fonts.mjs`](../../islands/fonts.mjs) | `theme-delivery`, `bundle` |
| Head blocks A and B | The 14 pages in `PAGES` | The built theme layer, the surface token, the preloaded font's file name | [`heads.mjs`](../../islands/heads.mjs) | `theme-delivery` |
| The family-voice copy | The ten Eleventy pages | The constants in `copy.mjs` | [`copy.mjs`](../../islands/copy.mjs) | `copy` |
| The manifest colours | `background_color` and `theme_color` in `manifest.webmanifest` | The surface token | `heads.mjs` | `theme-delivery` |
| The version stamps | The `hfy-asset-versions` block in `sw.js` and in `js/feature-flags.js` | Hashes of the files those scripts load | [`assets.mjs`](../../islands/assets.mjs) | `asset-versions` |
| `?v=<sha8>` | Every same-origin script, stylesheet and manifest reference in every page | Hashes of the referenced files | `assets.mjs` | `asset-versions` |
| The sign-in stylesheet URL | `theme.cssUrl` in [`auth/edge.manifest.json`](../../auth/edge.manifest.json), outside the site directory | The hash of `css/auth-edge.css` | `assets.mjs` | `asset-versions`, `auth/test/edge.test.js`, `scripts/infra/test/run.sh` |

A suite named without a path is `islands/tests/<name>.test.mjs`. [Tests](#tests) lists what each one checks.

## Build order

The build computes every output in memory, in this order, and only then writes or compares:

1. The island bundles, and `js/islands/notify-sw.js` copied from `@io-kit/notify`.
2. `css/hfy-theme.css`.
3. `css/auth-edge.css`, when its source exists.
4. The fonts.
5. The head blocks in the 14 pages, and the manifest colours. Block B's `?v` is the hash of the theme layer from step 2.
6. The family-voice copy on the ten Eleventy pages, applied to the text from step 5.
7. The stamp in `sw.js`, then the stamp in `js/feature-flags.js`, which carries the hash of the stamped `sw.js`.
8. `?v=<sha8>` in every HTML page of the site.
9. `theme.cssUrl` in `auth/edge.manifest.json`, only when `<site-dir>` is the repository's own `11ty/`.

A hash is taken from the build's own output when the build produces the file, and from the file on disk otherwise. The order follows the dependency chain in `assets.mjs`, which must stay acyclic: the island files, the theme layer, `notify-sw.js` and the manifest, then `sw.js`, then `feature-flags.js`, then the HTML.

## Theme layer

`css/hfy-theme.css` is the stylesheet that every page links render-blocking. The build bundles it with esbuild from an entry it generates, minified, for the targets `es2020` and `safari15`.

### Cascade

| Order | Layer | Source | Contents |
|---|---|---|---|
| 1 | `@import "hfy:fonts"` | `fonts.mjs` | The 12 `@font-face` rules ([Fonts](#fonts)) |
| 2 | `theme.css` | `@io-kit/tokens/harrisonfamily/theme.css` | The `--io-*` design tokens. `:root` holds the default theme, which is dark. A `[data-theme="light"]` block holds the daylight theme. |
| 3 | `bs-bridge.css` | `@io-kit/tokens/harrisonfamily/bs-bridge.css` | Bootstrap's `--bs-*` variables, such as `--bs-body-bg`, pointed at the tokens |
| 4 | `kit-bridge.css` | `@io-kit/tokens/harrisonfamily/kit-bridge.css` | The kit components' skinning variables, such as `--io-shell-surface` and the `--io-auth-*` set |
| 5 | The partials | `islands/src/theme/` | Every file whose name is two digits, a hyphen, anything, then `.css`, in ascending name order. A file without the two-digit prefix is not included. |
| 6 | The print block | Generated | See [Print block](#print-block) |

Every `@import` is resolved at build time, so the output contains none. URLs under `/fonts/` are left as they are, not inlined. The file opens with the banner `/* hfy-theme.css: islands/build.mjs from islands/src/theme/ and @io-kit/tokens harrisonfamily; generated, do not edit */`. esbuild's CSS warnings are printed during the build, because a syntax slip in a partial, such as a comment closed early, silently drops the rules after it.

Every page with the Eleventy `css/main.css` links the theme layer right after it, so the theme's rules win over `main.css` on equal or higher specificity. `main.css` is never edited.

### Partials

| Partial | Covers |
|---|---|
| `10-kit-aliases.css` | One `html:root` block that maps the short variables `@io-kit/shell` 0.6.6, `@io-kit/content` 0.3.1 and `@io-kit/notify` 0.4.0 read (`--bg`, `--fg`, `--space-2` and others) to `--io-*` tokens. Those kit versions read the short names instead of their `--io-*` contracts (DVP-TSK-A73). `html:root` has specificity (0,1,1), so it beats any `:root` declaration of the same names. Its header says to delete the file once the kit reads only `--io-*` variables. |
| `20-base.css` | Global element rules (the page ground, text, links and headings) that override the literal values in `main.css`, and three `--bs-*` variables that `main.css` declares as literals |
| `30-bootstrap.css` | The Bootstrap 5.3 components that `bs-bridge.css` cannot reach, re-pointed at `--io-*` tokens class by class. Each rule's comment names the `main.css` literal it replaces. |
| `40-site.css` | The Eleventy site's own rules from `main.css` (gutters, `main` padding, footer and the rest), re-pointed at `--io-*` tokens |
| `45-person.css` | The person page that `js/person-page.js` renders: the record, the family tree and the lightbox |
| `60-shell-static.css` | The shell frame before the island loads: `--io-bp-medium-min` and `--io-bp-palette-min` (`43rem`, under the lint's breakpoint tag), the hidden Bootstrap navbar under `html.hfy-shell-v2`, and the placeholder bars painted until the shell mounts |
| `80-pages.css` | The four repo-owned pages (`.hfy-page`) and the preview-flags banner |

### Print block

The build copies the declarations of `theme.css`'s `[data-theme="light"]` block, except `color-scheme`, onto `:root` inside `@media print`, after `color-scheme: light`. A printed page therefore uses the daylight theme, without JavaScript. The build fails with `theme.css: no [data-theme="light"] block` when the tokens package has no such block.

### Runtime fallback

The first lines of [`11ty/js/feature-flags.js`](../../11ty/js/feature-flags.js) look for a `<link>` whose `href` starts with `/css/hfy-theme.css`. When a page has none, for example because block B was lost, the script appends one to `<head>` with `href="/css/hfy-theme.css?v=<sha8>"`, using the `theme` hash from its stamp (the bare path when it has no stamp), and a `data-hfy-theme-fallback` attribute. It lands after `main.css`, so the cascade order holds, but it does not block rendering.

## Sign-in stylesheet

`css/auth-edge.css` styles the auth edge's own pages (`/auth/login`, `/auth/link`, the password pages, `/auth/verify`, the denied page and the edge 404), which do not load the theme layer. The build bundles it from [`islands/src/auth-edge/auth-edge.css`](../../islands/src/auth-edge/auth-edge.css) with the same esbuild options as the theme layer. Its cascade:

1. `@import "hfy:fonts"`: the same 12 `@font-face` rules.
2. `theme.css`.
3. `kit-bridge.css`, which declares the `--io-auth-*` variables.
4. The sign-in rules.

It has no `bs-bridge.css`, no partials and no print block. The file opens with the banner `/* auth-edge.css: islands/build.mjs from islands/src/auth-edge/auth-edge.css; generated, do not edit */`.

When the source file is missing, the build prints `warning: islands/src/auth-edge/auth-edge.css does not exist yet; css/auth-edge.css is left as it is`, leaves the output alone, and `--check` does not compare it.

The `@io-kit/auth` 2.2.0 pages link the file through `theme.cssUrl`, ahead of their inline `<style>`. An inline rule of equal specificity therefore wins, so every rule in the source that must beat one is prefixed with `html`. The source's first block maps the ten legacy names the kit's inline styles read before 2.2.0 (`--io-bg` to `--io-font`) onto the `--io-auth-*` variables. Its header calls that block redundant since 2.2.0 and keeps it until a deploy has proved 2.2.0 in production.

The sign-in pages' Content-Security-Policy names `https://<site>` in `style-src` and allows fonts only from `'self'`, so this file and the font files it names must be served from `https://<site>`. A changed file gets a new `?v` in `theme.cssUrl` ([Sign-in stylesheet URL](#sign-in-stylesheet-url)), which the pages link only once `hfy-auth-edge` is redeployed with the app stack ([Deploy the app stack](../how-to/deploy-the-app-stack.md)). The policy and the edge's page overrides are in [Identity services: Page theme and HFY overrides](identity-services.md#page-theme-and-hfy-overrides).

## Fonts

`fonts.mjs` copies the brand faces from three exact-pinned dev dependencies, so the build needs `node_modules` from an `npm ci` that includes them.

| Family | Role | Package | Faces | Weight |
|---|---|---|---|---|
| Source Sans 3 | The UI face | `@fontsource-variable/source-sans-3` 5.3.0 | Upright (`wght-normal`) and italic (`wght-italic`) | The variable range from the package's `metadata.json`, written as `200 900` |
| Libre Caslon Text | The display serif | `@fontsource/libre-caslon-text` 5.3.0 | `400-normal`, `400-italic`, `700-normal` | `400` or `700` |
| Source Code Pro | The monospace face | `@fontsource-variable/source-code-pro` 5.3.0 | Upright (`wght-normal`) | The variable range from `metadata.json`, written as `200 900` |

| Item | Value |
|---|---|
| Subsets | `latin-ext` and `latin`, for every face: 12 `woff2` files in all |
| File name | `<family-slug>-<subset>-<face>.<sha8>.woff2`, for example `source-sans-3-latin-wght-normal.<sha8>.woff2`, where `<sha8>` hashes the file |
| Licences | Each package's `LICENSE` (OFL-1.1), copied to `LICENSE-<family-slug>.txt`: `LICENSE-source-sans-3.txt`, `LICENSE-libre-caslon-text.txt`, `LICENSE-source-code-pro.txt` |
| `@font-face` rule | One per file: `font-family` as the token stacks name it (`"Source Sans 3"`, not fontsource's `"Source Sans 3 Variable"`), `font-style`, `font-weight`, `font-display: swap`, `src: url(/fonts/<file>) format("woff2")`, and the subset's `unicode-range` from the package's `unicode.json` |
| Rule order | Each family's `latin-ext` rules come before its `latin` rules, so `latin` wins where the ranges overlap |
| Preloaded face | Source Sans 3, `latin`, upright: the `href` of block A's preload |

The build fails with `<package>: metadata family is "<name>", expected "<family>"`, `<package>: unicode.json has no "<subset>" range`, `<package>: no weight for <file>`, or `preload face source-sans-3-latin-wght-normal not found`.

A build leaves exactly these 15 files in `fonts/`: it deletes every other file there, so an old hash disappears with the face it named. The font URLs carry no `?v`, because their names already carry a hash. No page or stylesheet names a third-party font origin. The service worker serves `/fonts/` cache-first ([Front end: Service worker](front-end.md#service-worker)).

## Head blocks

`heads.mjs` writes two marker-delimited blocks into the 14 pages of its `PAGES` list, on every build.

| Block | Contents, in order |
|---|---|
| A, from `<!-- hfy-theme:start A -->` to `<!-- hfy-theme:end A -->` | `<meta name="color-scheme" content="dark" />`; `<meta name="theme-color" content="<surface>" />`; the shell early-hint script, except on `offline.html`; `<link rel="preload" as="font" type="font/woff2" crossorigin href="/fonts/source-sans-3-latin-wght-normal.<sha8>.woff2" />` |
| B, from `<!-- hfy-theme:start B -->` to `<!-- hfy-theme:end B -->` | `<link rel="stylesheet" href="/css/hfy-theme.css?v=<sha8>" />` |

`<surface>` is `--io-color-semantic-surface` from the `:root` block of the tokens' `theme.css`, followed through its `var()` aliases to a literal, `#141210` with the pinned tokens. The build fails with `theme.css: no :root block` or `theme.css: cannot resolve --io-color-semantic-surface` when it cannot. Each page has exactly one `theme-color` meta.

The early-hint script is `try{localStorage.getItem("hfy:shell-hint")==="1"&&document.documentElement.classList.add("hfy-shell-v2")}catch(e){}`. Block A places it before the font preload and before `main.css`, so it runs before any of the page's stylesheets load. `feature-flags.js` sets the key to `"1"` once the shell island has loaded, and to `"0"` when `shellV2` is off or the shell fails to load. `offline.html` has no hint, because it never loads `feature-flags.js`: nothing would mount the shell or clear the class, and the class would leave the shell's placeholder bars painted on the offline page.

| Pages | Where the blocks go |
|---|---|
| The ten Eleventy pages: `index.html`, and `index.html` under `about/`, `contact/`, `family-login/`, `logged-out/`, `person/`, `privacy/`, `private/`, `search/` and `terms/` | Block A immediately before the first `<link>` to `/css/main.css` (with or without a query), block B immediately after it |
| The four repo-owned pages: `posts/index.html`, `me/index.html`, `me/notifications/index.html`, `offline.html` | Block A and then block B right after `</title>`. These pages do not load `main.css`. |

Each block takes the indentation of the line it is anchored to. A build first removes any existing blocks and then writes them again, so a second build changes nothing, and removing the blocks restores the page byte for byte. A page with neither a `main.css` link nor `</title>` fails the build with `<page>: no main.css link and no </title> to anchor the theme head block`, and a page in `PAGES` that does not exist fails it as well.

`PAGES` must list every HTML page of the site. The build writes blocks only into `PAGES`, and `theme-delivery` fails on any page found outside it. `<eleventy-source>`'s `partials/head.njk` carries a port of both blocks (HFY-TSK-084). Whatever values a refreshed page arrives with, the next build rewrites both blocks with the current theme hash and font file name ([Refresh the Eleventy output](../how-to/refresh-the-eleventy-output.md)).

## Family-voice copy

`copy.mjs` rewrites the older copy on the ten Eleventy pages (`COPY_PAGES`) into the design system's lowercase family voice: lowercase headings and titles, no exclamation marks, and "sign in", never "log in". Person names and "Harrison" stay capitalized. Every rewrite matches only the old text, so applying it twice changes nothing, and family-authored prose, such as the about page's story, is never touched. The source pages in `<eleventy-source>` still carry the old copy, so the build puts the voice back after every Eleventy refresh.

| Where | Old text | New text |
|---|---|---|
| All ten pages, footer | `&copy; <year> Harrison Family Heritage. All rights reserved.` | `FOOTER`: `<site> · kept by the family, for the family` |
| All ten pages, fallback navbar brand | `HARRISON FAMILY` | `Harrison Family`. Painted only until the shell mounts. |
| All ten pages, `<title>`, `og:title`, `twitter:title` | The old page title with the ` · Harrison Family Heritage` suffix, and on every page but the home page also without it | See the titles table |
| `index.html`, hero heading | `<h1>Welcome to the Harrison Family Website!`, closed by `</h1>` or by a stray second `<h1>` | `<h1>hi family. this is where we keep our history.</h1>` |
| `index.html`, hero lede | `<h3>Learn about our heritage and help us preserve our family history.</h3>`, in either capitalization | `<p class="home-hero__lede">learn about our heritage and help us preserve our family history.</p>` |
| `index.html`, calls to action | `About Us` (the `/about/` link) and `Family Login` (the `data-feature="familyLoginLink"` link) | `our story` and `sign in` |
| `about/index.html`, heading | `Honoring the Harrison Family Legacy` | `honoring the Harrison family legacy` |
| `family-login/index.html`, heading | `Family Login` | `sign in` |
| Every page with the footer line, and `posts/`, `me/` and `me/notifications/` (`COPY_EXTRA`) | No links after the footer line | `FOOTER_NAV`: a `<nav class="site-footer__links" aria-label="about this site">` with `about`, `contact`, `privacy` and `terms`, once. The shell hides the navbar that linked them. `40-site.css` styles them (44 px targets, `text.dim`, underlined). |
| All ten pages, meta description, `og:description`, `twitter:description` | The Eleventy default, `Modern genealogy archive built with gramps, 11ty and bootstrap. Family members, login to see your data.` | `DESCRIPTION`: `the Harrison family archive. family members sign in to see the private pages.` |
| `family-login/index.html`, the text shown before it hands over to `/auth/login` | `Sign in with your approved Google account to access private family records, search, and media.`, `If you need access, reach out to the site administrator.`, `Loading authentication status…` | `sign in with your Google account to see the family pages.`, `not on the list yet? text J.`, `loading…` |
| `logged-out/index.html`, heading, lede and buttons | `You are signed out`, `Your session has ended successfully. …`, `Return to Family Login` (`/family-login/`), `Back to Home` | `SIGNED_OUT`: `you're signed out.`, `come back whenever you like.`, `sign in again` (`/auth/login`), `home`. `src/logged-out.njk` in the source carries the same text. |
| `person/index.html`, static strings | `Loading person record…`, `Loading high-resolution media…`, `Download original` | `loading…`, `loading the full-size photo…`, `download original` |
| `contact/`, `privacy/` and `terms/`, the obfuscated address | `info [@] harrisonfamily [D0T] us` (a zero) | `info [@] harrisonfamily [DOT] us`. Nothing else on `privacy/` or `terms/` is rewritten. |
| `about/index.html`, the story | `two hundred twenty (222) years` | `two hundred twenty-two years` |
| `index.html` and `about/index.html`, hero photograph | The hero `<img>` without a `width` | `width` and `height` set to the committed JPEG's pixel size, from `HERO_IMAGES`. CSS still sets the displayed size. |

| Page | `<title>` | `og:title` and `twitter:title` |
|---|---|---|
| `index.html` | `Harrison Family` | `Harrison Family` |
| `about/index.html` | `our story · Harrison Family` | `our story` |
| `contact/index.html` | `contact and access · Harrison Family` | `contact and access` |
| `family-login/index.html` | `sign in · Harrison Family` | `sign in` |
| `logged-out/index.html` | `signed out · Harrison Family` | `signed out` |
| `person/index.html` | `family member · Harrison Family` | `family member` |
| `privacy/index.html` | `privacy · Harrison Family` | `privacy` |
| `private/index.html` | `your family · Harrison Family` | `your family` |
| `search/index.html` | `search · Harrison Family` | `search` |
| `terms/index.html` | `terms · Harrison Family` | `terms` |

`RETIRED` lists the patterns that must not survive on any of the ten pages: `All rights reserved`, `Welcome to the Harrison Family Website!`, `>About Us<`, `>Family Login<`, `Harrison Family Heritage</title>` and `>HARRISON FAMILY<`. The copy of the islands, the person page, the auth edge and the push notifications is not written by the build; [Front end: Theme layer and head blocks](front-end.md#theme-layer-and-head-blocks) says where it lives.

## Manifest colours

The build sets `background_color` and `theme_color` in `manifest.webmanifest` to the same resolved surface token as the `theme-color` meta. It replaces the two values in the text, so the file's own formatting survives. The build fails when the file is not valid JSON, or with `manifest.webmanifest: no <key>` when either member is missing. The manifest's hash is part of both stamps, so a colour change also changes `sw.js` and `js/feature-flags.js`.

## Asset versions

Cloudflare caches static files for 4 hours under the URL first fetched, and a CloudFront invalidation does not reach it. It does not cache HTML. The build therefore gives every static file a page loads a URL that changes with the file's content, driven from the uncached HTML.

### Version value

The version is `<sha8>` of the file's bytes as the build produced them, or as they are on disk for a file the build does not produce. The hashes are those of the committed files. [`scripts/ci/patch-client-id.sh`](../../scripts/ci/patch-client-id.sh) later replaces the client-ID placeholder in `js/auth.js` and the pages on the CI runner, before the release is packaged, so the deployed `js/auth.js` has bytes that its `?v` does not hash ([Private data and secrets](private-data-and-secrets.md#placeholders)).

### References in the pages

The build versions every HTML file under `<site-dir>`, except under the top-level directories `js`, `css`, `fonts`, `images`, `media`, `uploads`, `_data`, `family`, `event`, `note` and `place`. Today that is the 14 pages in `PAGES`.

| Reference | Versioned |
|---|---|
| `<script src>` | Yes |
| `<link>` whose `rel` includes `stylesheet`, `manifest` or `modulepreload` | Yes |
| `<link rel="preload">` with `as="script"` or `as="style"` | Yes |
| `<link rel="preload" as="font">`, icons, `canonical`, inline scripts, images | No |

Only same-origin references count: root-relative paths, page-relative paths resolved against the page, and absolute URLs on `https://<site>` (`SITE_ORIGIN` in `assets.mjs`). Other origins and protocol-relative URLs to another host are left alone.

The rewrite:

- Removes every existing `v` parameter and appends `v=<sha8>` as the last parameter.
- Keeps the other query parameters, the fragment and the attribute's quote style. Parameters separated by `&amp;` are joined again with `&`.
- Fails the build with `<page>: <reference> references <file>, which is not part of the site (cannot version it)` when the referenced file does not exist.

A second build changes nothing, and a file whose bytes did not change keeps its `?v`.

### Stamped blocks

The references made at run time read their versions from a block that the build stamps into two scripts:

```js
/* hfy-asset-versions:start (content hashes of the files this script loads: generated by islands/build.mjs, do not edit) */
const ASSET_V = { … };
/* hfy-asset-versions:end */
```

The block takes the indentation of its start marker. A script without the markers fails the build with `<file>: no "hfy-asset-versions:start ... hfy-asset-versions:end" marker block to stamp`. A script that does not exist is skipped.

| File | Keys of `ASSET_V` | Read by |
|---|---|---|
| `sw.js` | `theme`, `manifest`, `shell` (`{ js, css }` of the shell island), `notify` (`js/islands/notify-sw.js`) | The worker's precache list and its `importScripts` of `notify-sw.js`. The worker takes its cache name, `hfy-shell-<sha8>`, from the `?v` it is registered at, and uses `hfy-shell-dev` when that is not 8 hex digits. |
| `js/feature-flags.js` | `islands` (one entry per island, sorted by name: `{ js, css }`, or `{ js }` for an island without a stylesheet), `theme`, `manifest`, `sw` (the hash of the stamped `sw.js`) | `loadIsland()` for `/js/islands/<name>.js` and `.css`; the theme fallback link; the `/manifest.webmanifest` link added once the shell has loaded; and `HFYFeatureFlags.assetVersions`, from which the shell island registers `/sw.js?v=<sw>` |

Each runtime reference falls back to the bare path when its key has no value. `feature-flags.js` is itself referenced with `?v` from the pages, so a change to any stamped hash gives it a new URL.

### What is not versioned

| Files | Why |
|---|---|
| `fonts/*.woff2` | The file name carries the hash |
| `js/islands/chunks/chunk-<hash>.js` | The file name carries esbuild's content hash, and the island entries import chunks by relative name |
| Images, `/offline.html`, `/images/pwa-192.png` in the worker's precache list | Not scripts or stylesheets |
| `/_data/flags.json` and the data paths | JSON, which Cloudflare does not cache. `flags.json` is fetched with `cache: "no-store"`. |

### Sign-in stylesheet URL

When `<site-dir>` resolves to the repository's own `11ty/`, by default or through `--site`, the build stamps `theme.cssUrl` in `auth/edge.manifest.json` as `https://<site>/css/auth-edge.css?v=<sha8>`, with the hash of `css/auth-edge.css`. It replaces only that value in the text, so the diff is one line, and it checks that the result still parses as JSON. A build into a scratch copy never touches the manifest.

| Failure | Message |
|---|---|
| The manifest has no `cssUrl`, or more than one | `edge.manifest.json: expected exactly one theme.cssUrl, found <n>` |
| The URL is on another origin | `edge.manifest.json: theme.cssUrl <url> is not on https://<site>, so it cannot be versioned` |
| The file does not exist | `edge.manifest.json: theme.cssUrl <url> references <file>, which is not part of the site` |

`theme.fontOrigins` stays `["self"]`, which gives the sign-in pages `font-src 'self'`.

## Command line

```sh
node build.mjs [--site <dir>] [--check]
```

Run it from `islands/`, through these scripts in [`islands/package.json`](../../islands/package.json): `build` and `build:islands` run `node build.mjs`, and `check:islands` runs `node build.mjs --check`. [`scripts/ci/build-islands.sh`](../../scripts/ci/build-islands.sh) runs `npm run build:islands` after `npm ci`.

| Option | Behavior |
|---|---|
| None | Builds into the repository's `11ty/` |
| `--site <dir>` | Builds into `<dir>`, resolved against the current directory, such as a scratch copy of the site ([Build into a scratch copy instead](../how-to/build-and-preview-the-islands.md#build-into-a-scratch-copy-instead)). The edge manifest is stamped only when `<dir>` is the repository's `11ty/`. |
| `--check` | Builds everything in memory, writes nothing, and compares the result with `<site-dir>` byte for byte |

| Mode | Result | Output | Exit |
|---|---|---|---|
| Any | `--site` has no value | `usage: node build.mjs [--site <dir>] [--check]` | 2 |
| Any | `<site-dir>` has no `index.html` | `--site <dir>: not a site directory (no index.html)`, with the absolute path, even when `--site` was not given | 2 |
| Any | A step fails, such as a missing page, a reference to a missing file or a missing install | The error and its stack | 1 |
| Build | Done | `built <n> files into <dir> (<m> written)` | 0 |
| `--check` | Every output matches | `<dir> is up to date (<n> generated files)` | 0 |
| `--check` | Any output differs | ``<dir> is out of date with islands/ (run `npm run build` and commit):``, then one indented line per problem | 1 |

`<dir>` in the output is the absolute path. `<n>` counts every generated file in the site directory, plus the edge manifest when it is stamped. The `--check` problem lines are `missing <path>` for an output that is absent, `stale <path>` for one whose bytes differ (`stale auth/edge.manifest.json` for the manifest), and `extra <path>` for a file in `js/islands/` or `fonts/` that the build does not produce. `--check` ignores `.DS_Store` files.

A build writes only the files whose bytes changed, creating directories as needed. It owns `js/islands/` and `fonts/` outright and deletes every file in them that it did not produce, `.DS_Store` included. It deletes nothing elsewhere. Besides the CSS warnings, it may print the warning about a missing sign-in stylesheet source ([Sign-in stylesheet](#sign-in-stylesheet)).

## Theme lint

[`islands/tests/theme-lint.test.mjs`](../../islands/tests/theme-lint.test.mjs) is the `no-literal-token-values` lint: app CSS refers to design tokens and never writes a literal colour, length or font family.

| Scope | Files |
|---|---|
| Stylesheets | Every `.css` file under `islands/src/`: the seven theme partials, `auth-edge/auth-edge.css`, `comments.css`, `posts.css`, `shell.css`, `islands/notifications.css` and `islands/search.css` |
| Inline styles | The `<style>` elements and `style=""` attributes of `11ty/posts/index.html`, `11ty/me/index.html`, `11ty/me/notifications/index.html` and `11ty/offline.html` |

The ten Eleventy pages and `main.css` are not linted.

| Rule | A declaration value fails on | Allowed |
|---|---|---|
| Colour | A `#` hex colour of 3 to 8 digits, or `rgb()`, `rgba()`, `hsl()` or `hsla()` | Inside a `var()` fallback or a `url()` |
| Length | A `px`, `rem` or `em` length, negative ones included | `0`; the `1px` hairline; `%`, `vh`, `vw` and unitless numbers; `calc(100vw - 32px)`; any value inside `var()` or `url()`; an `--io-bp-*` declaration with `/* lint-allow: bp tokens pending */` on the same line |
| Font family | A `font-family` or `font` value that names a family: a quoted string, or any word that is not a number or length, a CSS-wide keyword or a font keyword | `var(--io-typography-font-*)`; `calc()`, `min()`, `max()` and `clamp()`; keywords such as `inherit`, `italic` or `bold` |
| Variable read | `var(--name)` where `--name` does not start with `--io-` or `--bs-` | Anything in `src/theme/10-kit-aliases.css` |
| Parse | Any esbuild warning when a stylesheet is parsed as CSS. Inline styles are not parse-checked. | |

The lint skips whole `@font-face` blocks, comments, at-rule preludes such as `@media (min-width: 43rem)`, and a trailing `!important`. Each finding is printed as `<file>:<line> <property>: <value>  <- <reason>`, where `<file>` is relative to `islands/`, or for an inline style `<page> <style>` or `<page> style=""`. The reasons are `literal hex colour`, `literal rgb/hsl colour`, `literal length <length>`, `names a font family (alias --io-typography-font-*)` and `reads <name> (only --io-* / --bs-* may be read)`.

`npm run lint:css` runs the lint alone. It also runs with every other `node:test` suite in `npm run test:contract` and `npm test`. `HFY_LINT_ONLY` limits it to the files that match one or more globs, separated by spaces, relative to `islands/` or to the repository root. The globs accept `*`, `**`, `?`, `{a,b}` and `[...]`. The test `HFY_LINT_ONLY matches at least one file` fails when no file matches.

## Tests

The `node:test` suites read `11ty/`, or the scratch site that `HFY_SITE` names. The Playwright specs serve the same directory. How to run each suite is in [Run the tests](../how-to/run-the-tests.md). No workflow runs any of them.

| Suite | What it pins |
|---|---|
| [`theme-delivery.test.mjs`](../../islands/tests/theme-delivery.test.mjs) | `heads.mjs` writes idempotently and removably. Every HTML page is in `PAGES`. Every page has exactly one block A and one block B inside `<head>`, in the right place, with the colour-scheme meta, the `theme-color` equal to the resolved surface token, the hint script (absent on `offline.html`), the preload of a font file that exists, and block B linking `/css/hfy-theme.css?v=<sha8>` of the file. No page loads a third-party font origin or the Enceladus `tokens.css`. `css/hfy-theme.css` has the banner, the three families' `@font-face` rules, the tokens, both bridges and the print block, with no `@import`, no third-party font origin, and no `url()` other than `/fonts/*` or `data:`. The manifest colours equal the surface token. `fonts/` holds 12 faces whose names match their content and which `hfy-theme.css` references, and the three licences. `css/auth-edge.css` has no third-party font origin and no `@import`. |
| [`asset-versions.test.mjs`](../../islands/tests/asset-versions.test.mjs) | The rewrite rules of `versionHtml`, `versionManifestCss` and the stamps, on fixtures. Then the site: every same-origin script, stylesheet and manifest reference in every page carries the hash of the file on disk, and none is left unversioned. Both stamps match the files on disk, and `sw.js` does not mention `feature-flags`. Island entries import only relative, content-hashed chunks that exist. `loadIsland` requests `<name>.js` and `<name>.css` with the stamped `?v`, and an island without a stamp the bare URL. The worker names its cache from its `?v`, precaches the versioned URLs and deletes every other cache on activate. `theme.cssUrl` carries the hash of `css/auth-edge.css`, a check skipped under `HFY_SITE`. |
| [`asset-versions.spec.mjs`](../../islands/tests/asset-versions.spec.mjs) | Playwright, at 375, 688 and 1024 px, with the bare URLs of the changed files answered with stale content: the pages request only versioned scripts, stylesheets and manifest, the worker is registered at `/sw.js?v=<sha8>`, and the shell is the current one |
| [`copy.test.mjs`](../../islands/tests/copy.test.mjs) | Every page in `COPY_PAGES` is in `PAGES`. Each of the ten pages has no `RETIRED` text, has the `FOOTER`, has its `TITLES` title with no `!` and no run of capitals, and is unchanged by another `applyCopy`. The home page has one closed lowercase `h1`, the lede paragraph, no `h3`, and the two calls to action. The about heading is lowercase except for the family name, and the family's story is untouched. The hero photographs' `width` and `height` match the JPEG files. No page shows the shouted navbar brand. `applyCopy` rewrites only the old copy. |
| [`kit-aliases.test.mjs`](../../islands/tests/kit-aliases.test.mjs) | Re-reads the short variables that the installed `@io-kit/shell`, `@io-kit/content` and `@io-kit/notify` CSS reads, and fails on any that `10-kit-aliases.css` does not map. The file is one `html:root` block, each alias is a single `var(--io-*)` of a token the theme declares, and the mapping matches the DVP-TSK-A73 table. The header names DVP-TSK-A73, the three kit versions and the deletion condition, and the installed kit versions are still 0.6.6, 0.3.1 and 0.4.0. It also fails when the kit no longer reads any short variable, the signal to delete the file and the test. |
| [`theme-lint.test.mjs`](../../islands/tests/theme-lint.test.mjs) | The [theme lint](#theme-lint), plus a self-test of its rules and exemptions |
| [`bundle.test.mjs`](../../islands/tests/bundle.test.mjs) | The outputs exist and are not empty, including `css/hfy-theme.css`, `css/auth-edge.css`, 12 faces and 3 licences. `.gitignore` does not ignore them. `node build.mjs --check` exits 0 (with `--site` under `HFY_SITE`). |
| [`theme-foundation.spec.mjs`](../../islands/tests/theme-foundation.spec.mjs) | Playwright, with the flags and islands held back: each page is themed at first paint with the brand faces and no Google font request; the shell hint; an island's stylesheet settles before its module is requested; a page without block B gets the fallback link after `main.css`; printing uses the daylight theme without JavaScript; the offline page |
| [`flags-fallback.spec.mjs`](../../islands/tests/flags-fallback.spec.mjs) | Among its checks, the static `theme-color` and the manifest link added after the shell loads |
| [`auth/test/edge.test.js`](../../auth/test/edge.test.js) | `theme.cssUrl` is `https://<site>/css/auth-edge.css?v=<sha8 of 11ty/css/auth-edge.css>`, `theme.fontOrigins` is `["self"]`, the kit accepts the URL, and the page links it before its inline `<style>` |
| [`auth/e2e/signin-theme.e2e.mjs`](../../auth/e2e/signin-theme.e2e.mjs) | The sign-in pages with their real CSP and a stylesheet built into a scratch site: fonts load, sizes and colours come from the design system, and no CSP violation occurs ([Identity services](identity-services.md#page-theme-and-hfy-overrides)) |
| [`scripts/infra/test/run.sh`](../../scripts/infra/test/run.sh) | `theme.cssUrl` is the site's `/css/auth-edge.css` with `?v=` the hash of `11ty/css/auth-edge.css`, and the file exists. The repo-owned table and the refresh `rsync` excludes in [`11ty/README.md`](../../11ty/README.md), and the Eleventy check's excludes in [`scripts/check-deployment-sync.sh`](../../scripts/check-deployment-sync.sh), all name `css/hfy-theme.css`, `css/auth-edge.css` and `fonts/`. |

## Discrepancies

These are differences between the code and its comments, as of this page.

- **`copy.mjs` and CI.** Its header says that `build.mjs --check` "(CI)" fails while a page still carries the old copy. No workflow runs the check.
- **What `build.mjs` says the copy covers.** Its header lists the home hero, the about and family-login headings, the page titles and the footer. `copy.mjs` also rewrites the fallback navbar brand and sets the hero photographs' `width` and `height`.
- **`60-shell-static.css` and the tokens version.** Its comment says `@io-kit/tokens` 0.4.0 emits no breakpoint tokens, which is why the partial declares `--io-bp-*` itself. The pinned version is 0.4.1.
- **Pointers to `11ty/README.md`.** The headers of `heads.mjs` and `copy.mjs`, and `copy.test.mjs`, cite `11ty/README.md` for the port to `<eleventy-source>`. That README now points here and to [Refresh the Eleventy output](../how-to/refresh-the-eleventy-output.md) for it.
- **`build-islands.sh`.** It prints `built islands -> 11ty/js/islands` and checks only `shell.js` and `shell.css`. The build it runs also writes every output on this page, and the script checks none of them.

## Related pages

- [The design system theme layer](../explanation/design-system-theme-layer.md)
- [Why React islands on a generated Eleventy site](../explanation/islands-on-eleventy.md)
- [Edge and origin design](../explanation/edge-and-origin-design.md)
- [The privacy model for family data](../explanation/family-data-privacy.md)
- [The release model](../explanation/release-model.md)
- [Front end](front-end.md)
- [Identity services](identity-services.md)
- [Codebase map](codebase-map.md)
- [Repository operations](repository-operations.md)
- [Private data and secrets](private-data-and-secrets.md)
- [Build and preview the islands](../how-to/build-and-preview-the-islands.md)
- [Change the theme or brand fonts](../how-to/change-the-theme-or-brand-fonts.md)
- [Refresh the Eleventy output](../how-to/refresh-the-eleventy-output.md)
- [Deploy a site change](../how-to/deploy-a-site-change.md)
- [Deploy the app stack](../how-to/deploy-the-app-stack.md)
- [Run the tests](../how-to/run-the-tests.md)
