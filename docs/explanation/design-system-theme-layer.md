# Why the site's look is one built theme layer

The family site's look comes from one stylesheet, `/css/hfy-theme.css`, which the islands build compiles from the design system's tokens and which every page links from its own head. The sign-in pages get a sibling stylesheet built from the same tokens, the brand fonts are served from the site itself, and the build rewrites the page copy into the family voice. This page explains why the approved design system (HFY-TSK-084) was delivered that way rather than as a theme applied at run time: why the theme is static CSS whose partials may only alias tokens, why it is linked from render-blocking head markup around an Eleventy stylesheet that nobody edits, why the fonts are self-hosted, why the sign-in pages have their own stylesheet, why the build rewrites copy that belongs to the Eleventy source, and why all of it is committed.

The exact outputs, the cascade order and the lint rules are in the [theme and asset build reference](../reference/theme-and-asset-build.md), and the [front-end reference](../reference/front-end.md#theme-layer-and-head-blocks) describes the head blocks page by page. To change a colour, a partial or a font, follow [change the theme or brand fonts](../how-to/change-the-theme-or-brand-fonts.md). Why the theme's URLs carry a `?v=<sha8>` content hash is a caching question, answered in [edge and origin design](edge-and-origin-design.md#static-files-and-versioned-urls-hfy-tsk-086).

## The starting point: a look spread over many places

Before the design pass, no single place decided how the site looked:

- The Eleventy pages took their look from `css/main.css`, which `<eleventy-source>` compiles from Bootstrap with literal colours, sizes and fonts, and which the repository must not edit ([below](#why-maincss-stays-untouched)).
- The islands took theirs from the `@io-kit` packages. Three of them, `@io-kit/shell`, `content` and `notify`, read the short variable names of the Enceladus theme, so on this site they ignored the harrisonfamily theme.
- `js/feature-flags.js` injected some styling with literal values of its own: the preview-flags banner's style element, and a `theme-color` meta tag that appeared only once the shell had mounted.
- The sign-in pages first linked `main.css` itself, whose dark-hero heading colours made the `/auth/login` headings white on white. HFY-TSK-069 replaced it with a hand-written `auth-edge.css`, and the auth edge's manifest also carried three literal colours in `theme.vars`.

The design pass started from an audit against the approved design system, which listed 134 gaps, and closed them by making the tokens the one place where a value is decided.

## One stylesheet built from tokens, not a runtime theme

`@io-kit/tokens` publishes a harrisonfamily theme as CSS custom properties (`theme.css`), plus two bridges that map those tokens onto other vocabularies: `bs-bridge.css` onto Bootstrap's `--bs-*` variables, and `kit-bridge.css` onto the `--io-<package>-*` skinning contracts of the kit packages. [`islands/build.mjs`](../../islands/build.mjs) concatenates the font faces, the theme, both bridges and the site's own numbered partials in [`islands/src/theme/`](../../islands/src/theme/) into one minified file, `11ty/css/hfy-theme.css`. The legacy pages and the islands therefore read the same `--io-*` tokens.

The alternative was to theme the site at run time: have a script set the variables, inject styles per package, or use the kits' own theming runtimes. That was rejected, for reasons that come down to the first paint and to where values live:

- **The look must not depend on JavaScript.** The legacy pages are complete HTML that works without a framework ([why islands](islands-on-eleventy.md#why-islands-instead-of-an-spa-rewrite)). The offline page loads no scripts at all. A page whose island failed, or whose flag a tester turned off, falls back to the legacy markup, and that fallback has to look like the same site. A static stylesheet gives all of them the theme from the first paint.
- **A runtime theme paints late.** A script can apply a theme only once it runs, and the site's scripts run at the end of `<body>` ([below](#why-the-head-blocks-are-render-blocking-markup)). Every page load would flash the old look first.
- **Runtime theming hides values.** A `theme.vars` block in a manifest, a style string in a script or a theming runtime's preset each holds values where no stylesheet lint can see them. The search island shows the cost in bytes as well: Cloudscape's theming runtime and token preset would add about 100 KB gzipped, so the build generates the Cloudscape half of the search theme as static CSS instead ([`islands/src/lib/cloudscape-theme.js`](../../islands/src/lib/cloudscape-theme.js)).

So the theme sits outside the feature flags. Every visitor gets it whatever the flags say, and only a revert and a deploy take it out again.

The site has one screen theme, the dark one that the tokens put on `:root`. Every page says so with `<meta name="color-scheme" content="dark">`, so the browser's own controls and scrollbars match before the stylesheet arrives. The tokens' daylight values are used only on paper: the build copies them into a generated `@media print` block, so a printed page comes out light without any script.

The price of a static theme is that a colour change is a code change: edit a partial or bump `@io-kit/tokens`, rebuild, commit the rebuilt file and deploy. For a site whose look changes rarely, and then to follow an approved design, that is the right side of the trade.

## Why the partials may only alias tokens

The partials are where the site meets the theme. Each one points something at a token: the base elements, the Bootstrap components the bridge cannot reach, the Eleventy site's own rules, the person page, the shell's static frame and the repo-owned pages. Their two-digit prefixes are their cascade order. Their rule is that they only alias: a declaration's value is a `var(--io-*)` or `var(--bs-*)`, never a literal colour, length or font family.

[`islands/tests/theme-lint.test.mjs`](../../islands/tests/theme-lint.test.mjs) enforces that rule, `no-literal-token-values`, on every stylesheet under `islands/src/`, the island stylesheets and the sign-in source included, and on the inline styles of the six repo-owned pages. Its reasoning:

- **The tokens are the one place a value is decided.** A literal in a partial is a value that the next token change will not reach, and nothing but a lint notices one creeping back in.
- **App CSS reads only published contracts.** Reading a variable that is not `--io-*` or `--bs-*` fails, so the site's styles never depend on a kit package's internal names. One file is exempt, [`10-kit-aliases.css`](../../islands/src/theme/10-kit-aliases.css), and it exists only to undo such a dependency inside the kit: it maps the Enceladus short names that `@io-kit/shell`, `content` and `notify` still read onto harrisonfamily tokens (DVP-TSK-A73). [`islands/tests/kit-aliases.test.mjs`](../../islands/tests/kit-aliases.test.mjs) re-reads the installed kit packages and fails on any short name the file does not map. The file is to be deleted once the kit reads only its contracts.
- **A syntax slip fails loudly.** Every linted file must also parse without warnings, because a comment closed early silently drops every rule after it.

The exemptions are, almost all, places where a token cannot be used rather than places where a literal is convenient: `@font-face` blocks (their descriptors define the family names the tokens refer to), `url()` contents, `@media` and other at-rule preludes (a media query cannot read a custom property), zero, percentages, viewport units and unitless numbers, and the one-pixel hairline. The [reference](../reference/theme-and-asset-build.md) lists the two narrower exceptions as well.

Bootstrap is why there are so many partials. `bs-bridge.css` re-points Bootstrap's variables, but `main.css` compiles many component values as literals, and some as `-rgb` triplets that a hex token cannot alias. [`30-bootstrap.css`](../../islands/src/theme/30-bootstrap.css) therefore re-points those components class by class, and each rule's comment names the `main.css` literal it replaces.

Nothing runs the lint automatically. It is part of `npm test` in `islands/` and runs on its own as `npm run lint:css` ([run the tests](../how-to/run-the-tests.md)). CI runs only three CodeArtifact-free suites (the family-data guard, the infra script tests and the Gramps unit tests), and none of them is the lint.

## Why main.css stays untouched

`css/main.css` is Eleventy output. `<eleventy-source>` compiles it, and a refresh of `11ty/` replaces it ([refresh the Eleventy output](../how-to/refresh-the-eleventy-output.md)), so an edit to it in the repository would last only until the next refresh. The theme overrides it from outside instead. `hfy-theme.css` loads immediately after it, and every overriding rule has equal or higher specificity than the `main.css` rule it replaces, with an `html` prefix where the `main.css` selector would otherwise win. Being later in the cascade and at least as specific, the theme wins without the file being touched.

This costs a second stylesheet on every page, and each page still downloads all of `main.css` only to override much of it. In return, a refresh cannot undo the theme, and the boundary between the Eleventy look and the design system is one `<link>` wide.

## Why the head blocks are render-blocking markup

The obvious place to link a new stylesheet was `js/feature-flags.js`, the script that every page except `offline.html` loads and that already loads the islands. It runs too late. It sits at the end of `<body>`, so by the time it runs the browser may already have painted the page with `main.css` alone, and nothing added from there can hold back the first paint. `blocking="render"` works only on elements in the head, before the body exists.

So the link is markup in each page's own `<head>`. [`islands/heads.mjs`](../../islands/heads.mjs) writes two marker-delimited blocks into all 16 pages, on either side of the `main.css` link:

- **Block B, right after `main.css`,** is the theme link. Its position is the cascade order that the previous section depends on.
- **Block A, right before `main.css`,** holds what must be in place before anything paints. That is the `color-scheme` meta; a static `theme-color` meta set to the theme's surface colour, which used to be added by script after the shell mounted and which the build also writes into the web app manifest; a preload of the font face that carries most of the text; and the shell's early hint. The hint is a one-line inline script that adds `hfy-shell-v2` to `<html>` when this browser's last page loaded the shell, so the shell's static frame paints at once instead of after the flags arrive. It goes before `main.css` because an inline script that follows a stylesheet link waits for that stylesheet to load. A wrong guess lasts one page: `feature-flags.js` sets the hint again from what actually happened. `offline.html` gets no hint, because it never loads the script that would mount the shell or clear the class.

Pages without `main.css` (`posts/`, `me/`, `me/notifications/`, `me/links/`, `tree/`, `family-login/` and `offline.html`) get both blocks after `</title>`.

The same reasoning put the shell's static frame in the theme rather than in the shell island's own stylesheet. [`60-shell-static.css`](../../islands/src/theme/60-shell-static.css) hides the Bootstrap navbar under `hfy-shell-v2`, paints placeholder bars where the shell's chrome will appear, and declares the breakpoints, all from the first paint. The island's stylesheet arrives only when the loader fetches it, which is too late for any of that, and the kit's breakpoint hook reads the breakpoints on its first snapshot, before the island stylesheet could declare them. For the same reason the loader appends an island's stylesheet first and adds its script only once the stylesheet has loaded or failed, so an island never mounts unstyled.

`feature-flags.js` keeps one theme duty as a safety net. If a page has no theme link, typically because an Eleventy refresh was committed without the islands build, it appends one. That link arrives after the first paint, so it prevents an unthemed page, not a flash.

The Eleventy source's head partial, `src/_includes/partials/head.njk` in `<eleventy-source>`, also emits both blocks, but with the theme version and the font file name written in, so they go stale with the next theme or font change. The islands build stays authoritative: it rewrites both blocks on every run, and `npm run check:islands` fails on a page whose blocks differ from what it would write.

## Why the brand fonts are self-hosted

The design system names three faces: Source Sans 3 for the interface, Libre Caslon Text for display, and Source Code Pro. The build copies them from exact-pinned `@fontsource` packages into `11ty/fonts/`, with their OFL licence texts, and the theme's `@font-face` rules point at `/fonts/`. A hosted font service would have been less work. Three reasons ruled it out:

- **Privacy.** A font host would see the IP address and user agent of every member on every page, the sign-in and private pages included. [The privacy model](family-data-privacy.md#fonts-come-from-the-site-itself) covers this reason and the test that keeps third-party font origins out of the pages and stylesheets.
- **The auth edge's Content-Security-Policy.** The sign-in pages, the pages that handle credentials, send a strict policy that starts from `default-src 'none'`. A font service would need its origins added to `font-src` and `style-src` there. Self-hosted, the policy stays at `font-src 'self'`: the manifest's `theme.fontOrigins` is `["self"]`, which `@io-kit/auth` 2.2.0 turns into that directive, and because the edge is path-mounted on the site's own host, `'self'` is the site ([the identity model](identity-model.md#why-the-edge-is-path-mounted-at-auth)).
- **The installed app offline.** The service worker handles only same-origin requests, so a font from another origin would never be in its cache, and the offline page could not count on the brand fonts. The self-hosted files carry a content hash in their names, so the worker serves them cache-first.

Serving the files from the site led to three smaller choices. The build writes its own `@font-face` rules rather than using the packages' CSS, because the variable-font packages call their families "… Variable" while the token font stacks name "Source Sans 3". Only the latin and latin-ext subsets ship, 12 files of about 0.35 MB together. And only the upright latin file of the interface face is preloaded, since that is the one nearly every line of text needs.

What self-hosting costs is ownership. A font update is a package bump and a rebuild, not something a font service rolls out. The packages are public, but they install with the rest of `islands/`, so building the fonts needs the private registry token like everything else. The bandwidth is negligible, because Cloudflare and the service worker both cache the files.

## Why the sign-in pages have their own stylesheet

The sign-in pages are not Eleventy pages. `@io-kit/auth` renders them inside the `hfy-auth-edge` Lambda, with its own markup and a small inline base stylesheet, and the manifest names one stylesheet for them, `theme.cssUrl`. That stylesheet is `11ty/css/auth-edge.css`, a second output of the same build: the font faces, the tokens' `theme.css` and `kit-bridge.css`, and then the sign-in rules from [`islands/src/auth-edge/auth-edge.css`](../../islands/src/auth-edge/auth-edge.css).

Linking `hfy-theme.css` instead would not fit:

- **It styles markup the sign-in pages do not have.** Most of `hfy-theme.css` re-points Bootstrap, the Eleventy site's rules, the person page and the shell. The kit's pages need the tokens and the `--io-auth-*` contract that `kit-bridge.css` declares, which the kit's base stylesheet reads since 2.2.0.
- **Its cascade runs the other way.** The kit links the stylesheet before its inline base style, so a rule of equal specificity in the stylesheet loses. The sign-in rules are written for that order, with an `html` prefix on every rule that must beat the inline style.

The file is bundled, with every `@import` resolved at build time, and served by the static site rather than by the Lambda:

- The pages' policy allows stylesheets only from the site's origin, inline styles and Google's sign-in stylesheet, so the file and the fonts it names must be on `https://<site>`. One same-origin file with no runtime `@import` is one request that the policy already allows.
- As a static file it is cached and versioned like every other static file ([edge and origin design](edge-and-origin-design.md#static-files-and-versioned-urls-hfy-tsk-086)).
- It holds no literal values. The lint covers its source, and the manifest no longer carries `theme.vars`.

The cost is a split release. The stylesheet ships with the site, but the URL that names its version lives in [`auth/edge.manifest.json`](../../auth/edge.manifest.json), which ships inside the Lambda package. A restyle of the sign-in pages reaches members only once the site deploy has put the new file in place and `hfy-auth-edge` has been redeployed with the new URL ([deploy the app stack](../how-to/deploy-the-app-stack.md)).

Two workarounds predate `@io-kit/auth` 2.2.0, which fixed the kit gaps behind them: a guard in `auth/src/edge.js` that appends `font-src 'self'` to a policy that has none, and a block in the stylesheet's source that maps the kit's older variable names. Both are now no-ops, kept until a production deploy has proved 2.2.0 without them ([identity services](../reference/identity-services.md#page-theme-and-hfy-overrides)).

## Why the build rewrites the page copy

The design system has a voice as well as a look: lowercase headings and page titles, no exclamation marks, "sign in" rather than "log in", and a footer line in place of the copyright notice. The copy that lives in the repository was rewritten where it lives: the islands, `js/person-page.js`, the sign-in pages' `copy` block in the auth edge's manifest, and the push notification templates.

The ten Eleventy pages are different. Their copy (the home hero, the about and sign-in headings, the page titles and the footer) lives in templates in `<eleventy-source>`, outside the repository, and it has not been ported there yet. An edit to the committed pages would last only until the next refresh. So [`islands/copy.mjs`](../../islands/copy.mjs) rewrites the pages on every build, after `heads.mjs` has written the head blocks:

- **It matches only the old copy, by exact string.** Applying it twice changes nothing, and it cannot touch text it does not recognise. Prose the family wrote, such as the about story and everything that comes from the family data, is content rather than interface copy, and is never rewritten. Names stay capitalised.
- **A refresh that brings the old copy back is put right by the next build,** and `npm run check:islands` fails until that build has run.
- **A rewording in the source slips past it.** If the old copy is reworded in `<eleventy-source>`, the build no longer recognises it and the reworded text ships as it is. The copy tests fail only on the specific strings they retire.

The same mechanism carries a few markup fixes that the QA rounds found in the Eleventy output: the home page's heading closed properly, a lede that skipped a heading level turned into a paragraph, and a width and height on the two hero photographs, whose loading had shifted the layout. They belong in the source for the same reason the copy does.

The rewrite is a bridge, not a design. Once the copy and the fixes are ported to `<eleventy-source>`, the old strings stop appearing, every rewrite matches nothing, and `copy.mjs` can go. Until then, every refresh ends with the islands build ([refresh the Eleventy output](../how-to/refresh-the-eleventy-output.md), and [two sources of truth](islands-on-eleventy.md#the-consequence-two-sources-of-truth) for why the source and `11ty/` differ).

## Why all of it is committed

Every output described here is committed to the repository: both stylesheets, the fonts, the head blocks, the rewritten copy, the manifest colours and the stamped versions. The deploy ships what is committed. The reason is the registry. `@io-kit/tokens` and the other kit packages come from a private registry that CI cannot reach, and the font packages arrive through the same install. The pipeline cannot build the theme, so it has to find it already built in `11ty/`, and its sync with `--delete` would remove anything uploaded some other way. [The release model](release-model.md#why-island-bundles-are-committed-output) explains the ruling (HFY-R58) and its trade-off.

For the theme, the trade-off looks like this. A change shows up in review as an edit to a partial next to a regenerated, minified `hfy-theme.css` that nobody reads. What makes the minified file trustworthy is `npm run check:islands`, which rebuilds in memory and fails on any output that is missing, stale or extra. No workflow runs it, so running it before the pull request is the author's job ([build and preview the islands](../how-to/build-and-preview-the-islands.md)).

## How a theme change gets past the caches

Cloudflare, in front of CloudFront, keeps stylesheets and fonts for 4 hours under the URL it first fetched them by, and CloudFront's invalidation does not reach it. So the theme never changes under an old URL. Block B names `hfy-theme.css` with `?v=<sha8>` of its content, the manifest names the sign-in stylesheet the same way, and the font files carry their hash in their names. The service worker precaches the theme at the same versioned URL the pages request. Why the versions are needed, and the gaps they leave during a deploy, are explained in [edge and origin design](edge-and-origin-design.md#static-files-and-versioned-urls-hfy-tsk-086).

## The temporary parts

Several parts of the layer bridge a gap somewhere else and are meant to go once it closes. Each says so in its own header comment:

- `10-kit-aliases.css`, until the kit packages read only their `--io-*` contracts (DVP-TSK-A73).
- The generated Cloudscape search theme, until `@io-kit/search-ui` ships a harrisonfamily theme.
- The two `@io-kit/auth` workarounds, until a production deploy has proved 2.2.0 without them.
- `copy.mjs`, and the hard-coded values in the source's head partial, until the Eleventy source is ported.

## Further reading

- [Theme and asset build](../reference/theme-and-asset-build.md): every output of the islands build besides the bundles, the cascade, the lint rules and the asset versions.
- [Front-end reference: theme layer and head blocks](../reference/front-end.md#theme-layer-and-head-blocks): the blocks on each page, the partials and the theme fallback.
- [Change the theme or brand fonts](../how-to/change-the-theme-or-brand-fonts.md): edit a partial, the tokens or a font package, pass the lint and ship the result.
- [Build and preview the islands](../how-to/build-and-preview-the-islands.md) and [run the tests](../how-to/run-the-tests.md): rebuild the outputs, run `check:islands` and the theme lint.
- [Why React islands on a generated Eleventy site](islands-on-eleventy.md#what-the-islands-build-writes): what else the islands build writes into the pages, and why `11ty/` has two sources of truth.
- [Edge and origin design](edge-and-origin-design.md#static-files-and-versioned-urls-hfy-tsk-086): Cloudflare's static cache and the versioned URLs that get past it.
- [The privacy model for family data](family-data-privacy.md#fonts-come-from-the-site-itself): the privacy reason for self-hosted fonts, and the test behind it.
- [The identity model](identity-model.md) and [identity services](../reference/identity-services.md#page-theme-and-hfy-overrides): the sign-in pages, their policy and the HFY overrides.
- [Why releases ship through a pipeline and feature flags](release-model.md#why-island-bundles-are-committed-output): why build output is committed.
- [Refresh the Eleventy output](../how-to/refresh-the-eleventy-output.md): the refresh that every islands build has to follow.
- [Deploy the app stack](../how-to/deploy-the-app-stack.md): the `hfy-auth-edge` redeploy that a sign-in restyle needs.
