# How to build and preview the React islands

This page shows how to install the island dependencies, run the islands build after a change, check that the committed output matches the source, view the result in a local browser, and force a feature flag on or off there.

One run of [`islands/build.mjs`](../../islands/build.mjs) writes more than the island bundles in `11ty/js/islands/`. It also writes the theme layer `11ty/css/hfy-theme.css`, the sign-in stylesheet `11ty/css/auth-edge.css`, the self-hosted fonts in `11ty/fonts/`, the theme blocks in the page heads, the family-voice copy on the Eleventy pages, the colours in `manifest.webmanifest`, and a `?v=<hash>` on every same-origin script, stylesheet and manifest reference in the pages. Outside `11ty/`, it stamps the sign-in stylesheet's version into [`auth/edge.manifest.json`](../../auth/edge.manifest.json). All of it is committed build output (HFY-R58). No workflow builds it, so the next deploy ships what is committed, apart from the Google client ID marker that [`scripts/ci/patch-client-id.sh`](../../scripts/ci/patch-client-id.sh) fills in on the runner. Every change that affects the output is committed together with the rebuilt output, and `npm run check:islands` confirms that the two match.

Run the build:

- after any change under `islands/`;
- after you edit a script or stylesheet in `11ty/` that a page links, such as `11ty/js/person-page.js`, because every page names each such file by its content hash;
- after an Eleventy refresh, which brings back the old family-voice copy and unversioned script and stylesheet URLs, and head blocks whose theme `?v=` and font file name are fixed in the template and may be stale ([How to refresh `11ty/` from the Eleventy source without losing E5 files](refresh-the-eleventy-output.md));
- whenever `check:islands` reports the output out of date.

To change the colours, the theme partials or the brand fonts, follow [How to change the theme or the brand fonts](change-the-theme-or-brand-fonts.md), which uses the steps on this page. For why the output is committed, see [the release model](../explanation/release-model.md#why-island-bundles-are-committed-output). Every output of the build is listed in the [theme and asset build reference](../reference/theme-and-asset-build.md). The esbuild settings and the pinned package versions are in the [front-end reference](../reference/front-end.md#island-build).

Placeholders used on this page: `<aws-account-id>` is the AWS account that owns the `io` CodeArtifact domain. It is the number in the registry host name in [`islands/.npmrc`](../../islands/.npmrc). `<gramps-id>` is a Gramps person ID. Any value works on the local preview, which holds no person records. `<repo>` is the absolute path of your checkout, and `<site>` is the site's host name. Placeholder forms are listed in [Private data and secrets inventory](../reference/private-data-and-secrets.md#placeholders).

## Before you start

You need:

- **Node 22 or later.** [`islands/package.json`](../../islands/package.json) declares `"node": ">=22"`.
- **The AWS CLI, with credentials for `us-west-2`** that allow `codeartifact:GetAuthorizationToken` on the `io` domain and `sts:GetServiceBearerToken`. Installing the packages also needs `codeartifact:ReadFromRepository` on the `io-kit` repository, because the token carries the permissions of the principal that requested it.
- **Google Chrome, for the test checks only.** [`islands/playwright.config.mjs`](../../islands/playwright.config.mjs) launches the `chrome` channel unless `PW_CHANNEL` names another. See [How to run the test suites](run-the-tests.md).

A clean checkout already holds the committed output, so you can [preview](#4-preview-the-site-locally) it without building. The preview server is a dev dependency, though, so run `npm ci` in `islands/` once first: step 1, then `(cd islands && npm ci)` from the repository root in the same shell (the install half of [step 2](#2-build)).

## Steps

### 1. Get a CodeArtifact token

```bash
export CODEARTIFACT_AUTH_TOKEN="$(aws codeartifact get-authorization-token \
  --domain io --domain-owner <aws-account-id> --region us-west-2 \
  --query authorizationToken --output text)"
```

`islands/.npmrc` reads the token from `${CODEARTIFACT_AUTH_TOKEN}`, so it is never written to a file. Do not echo it, paste it into `.npmrc`, or copy it into a log or ticket. To confirm it is set without printing it:

```bash
test -n "$CODEARTIFACT_AUTH_TOKEN" && echo "token set"
```

The token exists only in this shell, so run step 2 from the same shell. It is short-lived (12 hours by default). When it expires, `npm ci` fails with an authorization error and you repeat this step.

### 2. Build

From the repository root:

```bash
bash scripts/ci/build-islands.sh
```

[`scripts/ci/build-islands.sh`](../../scripts/ci/build-islands.sh) stops with an error naming `CODEARTIFACT_AUTH_TOKEN` if the variable is unset, and never prints the token. It silences the output of `npm ci`, but errors still appear. Then it runs the build, which prints `built <n> files into <repo>/11ty (<m> written)`. The script checks only that `shell.js` and `shell.css` exist, and ends with `built islands -> 11ty/js/islands`, although the build has written every output listed above.

The manual equivalent, when you want npm's full output:

```bash
cd islands
npm ci
npm run build
```

Unlike the script, this runs package install scripts and skips the final check. Install the dev dependencies too: the brand fonts are copied from the `@fontsource` dev dependencies, so do not pass `--omit=dev` or set `NODE_ENV=production`. After changing source, rerun `npm run build` from `islands/`. You only need `npm ci` again when `islands/package-lock.json` changes.

What a build changes:

- It writes only the files whose bytes changed, and the `written` count says how many.
- It keeps `11ty/js/islands/` and `11ty/fonts/` at exactly its outputs, so it deletes anything you place there by hand.
- Chunk and font file names carry a content hash, so a change to shared code renames chunks: expect deleted and added files under `chunks/` in `git status`.
- A change to any island bundle changes the version block in `11ty/js/feature-flags.js`, and so the `?v=` with which the pages link that script. Expect most pages under `11ty/` to change.
- It rewrites parts of existing files in place: the head blocks, the family-voice copy, every `?v=`, the `hfy-asset-versions` blocks in `11ty/js/feature-flags.js` and `11ty/sw.js`, and `theme.cssUrl` in `auth/edge.manifest.json`. Never edit those by hand. The next build overwrites them, and `check:islands` reports the difference until it does.

The build prints esbuild's CSS warnings only for the theme layer (`islands/src/theme/`) and the sign-in stylesheet (`islands/src/auth-edge/`). The island stylesheets, such as `islands/src/shell.css`, `posts.css`, `comments.css` and `islands/src/islands/*.css`, build silently. After any stylesheet change, also run `(cd islands && npm run lint:css)`, which parses every stylesheet under `islands/src/` and fails on any esbuild warning. Fix every warning before you commit: a syntax slip, such as a comment closed early, silently drops every rule after it.

#### Build into a scratch copy instead

To build without touching `11ty/`, for example while other work is in progress there, build into a copy of the site. `<scratch-site>` is an absolute path to a directory you choose:

```bash
cp -R 11ty <scratch-site>
(cd islands && node build.mjs --site <scratch-site>)
```

The build exits `2` with `--site <scratch-site>: not a site directory (no index.html)` when the directory has no `index.html`. It never stamps `auth/edge.manifest.json` for a scratch copy. To check, serve or test the copy, name the same directory: `node build.mjs --site <scratch-site> --check`, `npx http-server <scratch-site> -p <port> -a 127.0.0.1 -c-1`, and `HFY_SITE=<scratch-site> PW_PORT=<port> npx playwright test` from `islands/`. A scratch copy is never shipped, so build into `11ty/` before you commit.

### 3. Check the output against the source

```bash
(cd islands && npm run check:islands)
```

When everything matches, it prints `<repo>/11ty is up to date (<n> generated files)` and exits `0`. Otherwise it prints `` <repo>/11ty is out of date with islands/ (run `npm run build` and commit): ``, then one `missing <path>`, `stale <path>` or `extra <path>` line for each file that differs, and exits `1`. `stale auth/edge.manifest.json` means that the sign-in stylesheet's version in the auth edge manifest is out of date. In every case, build again from the current source (step 2). The check rebuilds in memory and writes nothing.

### 4. Preview the site locally

The server does not need the token, so any terminal will do, once `npm ci` has run in `islands/` (step 2, or the install described under [Before you start](#before-you-start)). From the repository root, start a static server over `11ty/`:

```bash
cd islands
npx http-server ../11ty -p 8089 -a 127.0.0.1 -c-1
```

This is the root, address and port that the Playwright config uses. `http-server` is a pinned dev dependency, so after `npm ci`, `npx` runs the installed copy. Without that install, `npx` offers to download the latest `http-server` from the public npm registry, which is not the pinned version: decline, and install first. `-c-1` turns off HTTP caching, so a rebuild shows on reload. The server runs in the foreground. Leave it running in this terminal.

Open <http://127.0.0.1:8089/>.

The preview starts from the committed [`11ty/_data/flags.json`](../../11ty/_data/flags.json), which the server answers at `/_data/flags.json`. Read your copy with `cat 11ty/_data/flags.json`. The authV2 flip on 2026-10-12 (HFY-TSK-069) set the six flags it had then to `true` in that file, so with it those islands are on without an override. `navMe` (HFY-TSK-091) shipped `false`: preview it with `?hfy_flags=navMe`. The local server has no `/auth`, `/api` or person data and answers every such request with `404`. The pages and islands treat a `404` from `/auth/session` as an unreachable auth edge, not as a signed-out visitor. With every flag on, you see this:

| Page | What you see locally |
|---|---|
| Any page except `offline.html`, which never loads `feature-flags.js` | The kit shell, with five lowercase items: home, family, search, posts and me. Under 688 px (for example Chrome DevTools device mode at 375 × 812, the size the specs use) they form a bottom bar. From 688 px they sit in a top bar with the brand and an inline search field. The account control shows a **sign in** link to `/family-login/?next=<path, query and hash>`, because `/auth/session` does not answer. **me** goes to `/me/notifications/` while `notifyV2` is on, and to `/family-login/` otherwise. With `?hfy_flags=navMe` the bar has four items, home, search, posts and me, and **me** goes to `/private/`, because no session names you. |
| `/` | The hero, then the `timeline` island's "latest from the family" heading with a one-line error (`COPY.failed` in [`posts-ui.jsx`](../../islands/src/lib/posts-ui.jsx)), because `/api/posts` answers `404`. On the deployed site, a signed-out visitor sees no timeline at all. |
| `/search/` | The `search` island in the page's own `<main>`, with no matches and a one-line error (`SEARCH_COPY.failed` in [`people-corpus.js`](../../islands/src/lib/people-corpus.js)), because `/person/index.json` answers `404`. |
| `/person/?id=<gramps-id>` | A one-line error (`VOICE.error` in [`person-page.js`](../../11ty/js/person-page.js)) at once. The record never loads, so the `person` and `my-posts` islands never mount. |
| `/posts/` | The page heading, then the `posts` island's one-line error (the same `COPY.failed`), because `/api/posts` answers `404`. |
| `/me/notifications/` | The `notifications` island's settings, under a one-line error (`LOAD_FAILED` in [`notifications.jsx`](../../islands/src/islands/notifications.jsx)), because `/api` answers `404`. |
| `/family-login/` | The legacy sign-in page. `auth-v2.js` sends a signed-out visitor to `/auth/login` only when `/auth/session` answers, so it stays here. |

To see real data in these pages, use the Playwright specs (verify check 5), which stub the routes with synthetic fixtures.

#### Turn a flag on or off for this tab

Add `?hfy_flags=` to any URL. A name turns a flag on and `-name` forces it off, for example <http://127.0.0.1:8089/?hfy_flags=-authV2,-shellV2>. A **preview flags on — turn off** banner appears at the bottom left. The override applies to every page you open in this tab until you press **turn off**, open <http://127.0.0.1:8089/?hfy_flags=>, or close the tab. A new value replaces the previous one, so repeat every flag you still want. `searchV2` also turns on `shellV2` unless you add `-shellV2`. [How to turn a feature flag on or off, for one tab or for everyone](toggle-a-feature-flag.md) covers overrides in full, and the [front-end reference](../reference/front-end.md#runtime-override-preview-flags) has the resolver's rules.

On the local preview, include `-authV2` in any override you want to keep beyond the first page. The committed `authV2` is `true`, so every page that loads `auth-v2.js` (all except `/posts/`, `/me/notifications/` and `offline.html`) asks `/auth/session`, gets `404`, and clears the whole override: the banner disappears, the console warns `preview flags turned off: /auth/session unavailable`, and the next page runs with the committed values. With `-authV2,-shellV2`, every page with a navbar (all except `/posts/`, `/me/notifications/` and `offline.html`) shows the legacy navbar instead of the shell. An override is also cleared when an island bundle fails to load.

What `authV2` changes locally:

| `authV2` | Gated pages: `/search/`, a query in the shell's search box with `searchV2` on, and `/person/?id=<gramps-id>` |
|---|---|
| On | The pages request their data at once, without the legacy `X-HFY-Session` token, and get `404`: `/search/` and `/person/?id=<gramps-id>` show the one-line errors in the table above. The local server answers `404`, never `401`, so nothing is refreshed and nothing is sent to `/auth/login`. |
| Off (`-authV2`) | The pages wait about 8 seconds for a legacy session token. The local preview has none, so they redirect to `/family-login/?next=<path, query and hash>`, which shows the legacy sign-in page. |

With `shellV2` on, the shell registers a service worker for `127.0.0.1:8089`. A reload after a rebuild normally runs the new build. If you still see an old build, in Chrome DevTools open **Application > Service workers** and tick **Bypass for network** while you iterate. How the worker caches and when it is replaced is in the [front-end reference](../reference/front-end.md#service-worker).

### 5. Commit the output with the source

From the repository root, list what the build changed:

```bash
git status --short islands 11ty auth/edge.manifest.json
```

Every changed path under `11ty/` should be build output (`js/islands/`, `css/hfy-theme.css`, `css/auth-edge.css`, `fonts/`, the pages, `js/feature-flags.js`, `sw.js` and `manifest.webmanifest`), plus any file in `11ty/` you edited yourself. Then stage it with the source:

```bash
git add islands 11ty auth/edge.manifest.json
git diff --cached --stat
```

Commit the source change and the rebuilt output together, in one commit. A commit that changes `islands/src/` without its output ships the old output, and `check:islands` fails on it.

If `auth/edge.manifest.json` changed, the sign-in pages link the new stylesheet only after `hfy-auth-edge` is redeployed, because the site deploy does not ship the manifest. Redeploy it only after the site deploy for that commit has finished its `invalidate` job, and do not fetch the new stylesheet URL before then: a request that arrives before the new file is in the bucket gets the old file, and Cloudflare keeps it under the new `?v=` URL for up to 4 hours. See [How to deploy the app stack and its CloudFront behaviors](deploy-the-app-stack.md#before-you-start), which states the order.

## Verify

In a second terminal, from the repository root:

1. The output exists and matches the source:

   ```bash
   ls 11ty/js/islands 11ty/fonts
   (cd islands && npm run check:islands)
   ```

   Expect the eight island `.js` files, the eight `.css` files, `chunks/` and `notify-sw.js`; then, in `fonts/`, `.woff2` files with a hash in each name and three `LICENSE-*.txt` files; then `<repo>/11ty is up to date (<n> generated files)`.

2. The build-output tests pass:

   ```bash
   (cd islands && npm run test:contract)
   ```

   This runs every `node:test` file in `islands/tests/`, the comparison from step 3 and the CSS lint among them. The content contract test also needs the `api/` dependencies installed. What each file checks is in [How to run the test suites](run-the-tests.md#3-run-the-island-nodetest-suites-offline). Expect `fail 0` in the summary.

3. The server serves the versioned theme and the shell bundle:

   ```bash
   curl -s http://127.0.0.1:8089/ | grep -o '/css/hfy-theme.css?v=[0-9a-f]*'
   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8089/js/islands/shell.js
   ```

   Expect one `/css/hfy-theme.css?v=` URL with eight hex digits, then `200`.

4. The shell mounted. Open <http://127.0.0.1:8089/?hfy_flags=shellV2>. Once the page has loaded, run this in the browser console:

   ```js
   !!document.querySelector('#hfy-shell-root .io-shell')
   ```

   Expect `true`, whatever the committed flags say: this page keeps the flags it resolved even if the override is cleared. This is the element the Playwright shell spec waits for. If it is `false`, check `document.documentElement.classList.contains("hfy-shell-v2")`. The head's early hint or the loader adds that class, and the loader removes it when `shellV2` resolves off or `shell.js` fails to load. A `false` class means the bundle was not found, so rerun checks 1 and 3. A `true` class means the bundle loaded but did not mount, so look for an error in the console.

5. The browser specs pass:

   ```bash
   cd islands
   npx playwright test
   ```

   This runs the Playwright specs at 375 × 812 against `http://127.0.0.1:8089`, or against `HFY_SITE` on `PW_PORT` when you set them for a scratch copy. Playwright reuses your preview server if it is still running and starts its own otherwise. The specs stub the `/auth`, `/api`, Google and data routes they use with synthetic data, so they do not depend on a deployed site. Some pin `/_data/flags.json`; others start from the committed file and force flags off with `?hfy_flags=`. They load the output in the served site, so rebuild after any source change first. `npm test` runs the `node:test` files from check 2 first. See [How to run the test suites](run-the-tests.md) for running one spec and for using another browser channel.

6. The `authV2` path passes. The local preview cannot sign you in (see step 4), so its tests stand in. Check 5 already runs the browser spec. To run it alone, from `islands/`:

   ```bash
   npx playwright test auth-continuity
   ```

   [`auth-continuity.spec.mjs`](../../islands/tests/auth-continuity.spec.mjs) stubs `/auth/session`, `/auth/refresh`, `/auth/login` and the gated data paths with synthetic data. It pins the build flags off and turns `authV2` on with `?hfy_flags=`. It checks that a lapsed session is refreshed once and a refused request retried once, that a page whose session cannot be recovered goes to `/auth/login?returnTo=<path, query and hash>` only once, and that the `search` and `person` islands fetch through the same path. Then, from the repository root:

   ```bash
   node --test tests/client/*.test.mjs
   ```

   [`tests/client/`](../../tests/client/) loads the real `feature-flags.js` and `auth-v2.js` into a `node:vm` sandbox with a stubbed `fetch`. It needs no install and does not read the bundles. It also reads the `person` island and `islands/src/lib/people-corpus.js` to check that they fetch through `dataFetch`, so run it after a change to either. Expect `fail 0` in the summary.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| The build script stops with an error naming `CODEARTIFACT_AUTH_TOKEN`. | The variable is not set in this shell. | Repeat step 1 in the shell you build from. |
| `get-authorization-token` fails with access denied. | The credentials lack `codeartifact:GetAuthorizationToken` or `sts:GetServiceBearerToken`. | Use credentials that have both, in `us-west-2`. |
| `npm ci` fails with a 401 or 403 on an `@io-kit` package. | The token expired, was issued for another account, or its principal cannot read the `io-kit` repository. | Repeat step 1. Check that `<aws-account-id>` matches the host name in `islands/.npmrc`. |
| The build fails because it cannot find an `@fontsource` package. | The dev dependencies were not installed. | Run `npm ci` without `--omit=dev` and without `NODE_ENV=production`. |
| The build fails with `<page>: <url> references <file>, which is not part of the site (cannot version it)`. | A page links a same-origin script or stylesheet that does not exist in the site. | Restore the file, or remove the reference from the page, and build again. |
| `check:islands` reports `stale` pages after you edited a file in `11ty/js/` or `11ty/css/`. | The pages still carry the old `?v=` of the file you edited. | Build again (step 2) and commit the pages with the file. |
| `check:islands` reports `stale auth/edge.manifest.json`. | `11ty/css/auth-edge.css` changed and the manifest's `theme.cssUrl` still names the old version. | Build again and commit the manifest. Once the site deploy for that commit has finished its `invalidate` job, redeploy `hfy-auth-edge`, and do not fetch the new stylesheet URL before then ([How to deploy the app stack and its CloudFront behaviors](deploy-the-app-stack.md#before-you-start)). |
| `check:islands` reports `stale`, `missing` or `extra` island or font files. | The committed output does not match the source. | Build again (step 2) and commit the result with the source. |
| The page shows the old navbar instead of the shell. | `shell.js` was not found, so the loader removed `hfy-shell-v2`, or `shellV2` is off for this tab. Either the build did not run, the server is not serving `11ty/`, or an override with `-shellV2` is active. | Run verify checks 1 and 3. Start the server from `islands/` with `../11ty` as its root. If the banner shows, press **turn off**. |
| The shell shows no bottom bar. | The window is 688 px wide or more, where the shell uses a top bar. | Narrow the window, or use DevTools device mode at 375 × 812. |
| The page jumps to `/family-login/` after about 8 seconds. | `authV2` is off for this tab, and a gated page has no legacy session token on the local preview. | Expected. Use the Playwright specs, which seed a synthetic token. |
| `/person/?id=`, `/search/`, `/posts/`, `/me/notifications/` or the home page shows a one-line error at once. | The page asks for its data at once and the local server answers `404`. The API-backed islands always ask at once; `/person/?id=` and `/search/` do while `authV2` is on. | Expected. Test the data paths with verify checks 5 and 6. |
| The banner disappears by itself, and the next page you open runs with the committed values. | The override was cleared because something it needs is unavailable: an island bundle failed to load, or `authV2` resolved on and `/auth/session` did not answer, which is always the case locally. | For a bundle, run verify checks 1 and 3, and look for the failed request in the Network panel. For `/auth/session`, add `-authV2` to the override to keep it across pages. |
| A flag stays on or off for every page in the tab. | The override lasts for the tab. | Press **turn off** in the banner, open `/?hfy_flags=`, or close the tab. |
| Island changes do not show after a rebuild. | The page still links the old `?v=`, or the browser or the service worker served a cached copy. | View the page source: if its `?v=` values did not change, the build did not write that page, so build again. Otherwise bypass or unregister the worker in DevTools, and check that the server runs with `-c-1`. |
| `node build.mjs --site <dir>` exits `2`. | The directory has no `index.html`, or `--site` has no value. | Pass the absolute path of a copy of `11ty/`. |
| Playwright cannot launch a browser. | Google Chrome is not installed. | Install Chrome, or set `PW_CHANNEL` (see [How to run the test suites](run-the-tests.md)). |

## Limits

- **The local preview has no API, auth or person data.** `http-server` serves only the files in `11ty/`, so `/api` and `/auth` return `404`, and the repository holds no person records. The pages treat that as an unreachable auth edge. The API-backed islands (`person`, `my-posts`, `timeline`, `posts`, `notifications`) and the `search` island render against data only inside the Playwright specs, which stub those routes with synthetic fixtures.
- **Gated pages need a session, and `authV2` decides how they get one.** With `authV2` off, the gated pages wait about 8 seconds for a legacy session token, then redirect to `/family-login/?next=<path, query and hash>`. With `authV2` on, they fetch at once with the `io_id` cookie. On the deployed site, a `401` from the data gate is refreshed once and retried once, and only an interactive load that is still refused goes to `/auth/login?returnTo=<path, query and hash>`. The details are in the [front-end reference](../reference/front-end.md#authv2-data-fetch-and-session-continuity). The local preview cannot sign you in either way, so these pages cannot show data there.
- **An override that needs `/auth/session` lasts one page on the local preview.** The `authV2` path is exercised only by [`auth-continuity.spec.mjs`](../../islands/tests/auth-continuity.spec.mjs) and [`tests/client/`](../../tests/client/) (verify check 6), or on the deployed site.
- **A live API needs the deployed site.** To exercise an island against the real `/api` and `/auth`, use the deployed site. Every flag is on there; add `?hfy_flags=-name` to compare with one off. Read the deployed flags with `curl -s https://<site>/_data/flags.json | jq .`. The private data gate has been attached since the 2026-10-12 cutover (HFY-R67). It admits a data request only with a valid `io_id` cookie, whatever the legacy token says, so a signed-out request is denied, and forcing `-authV2` does not reproduce the legacy path as it ran before the gate. To confirm, a signed-out `curl -s -o /dev/null -w '%{http_code}\n' https://<site>/person/index.json` prints `401`. [How to cut over to authV2 and the private data gate, and roll back](cut-over-to-the-private-data-gate.md) covers the gate.
- **Building publishes nothing; merging does.** A local build changes only files in your checkout, `auth/edge.manifest.json` among them. Once the rebuilt output is committed and merged to `main`, the next deploy ships it ([How to deploy a change to the static site](deploy-a-site-change.md)). No workflow builds it or runs `check:islands`, so run it yourself before you open the pull request. The deployed pages name each script and stylesheet by its `?v=` hash, which is how a deploy gets past Cloudflare's 4-hour cache of static files. A page left unbuilt keeps its old URLs and can be served old files for up to 4 hours ([Why one CloudFront distribution fronts everything](../explanation/edge-and-origin-design.md#static-files-and-versioned-urls-hfy-tsk-086)).
- **The preview serves the committed `11ty/` as it is.** It does not rebuild the Eleventy pages. For that, see [How to refresh `11ty/` from the Eleventy source without losing E5 files](refresh-the-eleventy-output.md), then build again.

## Related pages

- [Why React islands on a generated Eleventy site](../explanation/islands-on-eleventy.md): why the islands exist and where their output comes from.
- [Why the site's look is one built theme layer](../explanation/design-system-theme-layer.md): why the theme, the fonts and the family-voice copy are written by this build.
- [Why releases ship through a pipeline and feature flags](../explanation/release-model.md): how flags stage a release and roll it back.
- [Theme and asset build](../reference/theme-and-asset-build.md): every output of the build, the head blocks, the lint and the asset versions.
- [Front end](../reference/front-end.md): the flag resolver, the `authV2` data fetch, the island catalog, build settings and service worker.
- [How to change the theme or the brand fonts](change-the-theme-or-brand-fonts.md): edit the theme partials or the font packages, then build and ship them.
- [How to turn a feature flag on or off, for one tab or for everyone](toggle-a-feature-flag.md): build-time values and per-tab overrides.
- [How to run the test suites](run-the-tests.md): the contract tests and the Playwright specs.
