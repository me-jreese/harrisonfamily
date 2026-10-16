# How to change the theme or the brand fonts

Use this page to change how the site looks. It covers five changes: editing a theme partial, editing the sign-in stylesheet, moving to a new `@io-kit/tokens` release, moving a brand font to a new `@fontsource` pin, and registering a new page so that it gets the theme. Each one goes through the theme lint, the islands build, the checks and the browser tests. Then you commit the generated files, ship them with a site deploy, redeploy `hfy-auth-edge` when the sign-in stylesheet's URL changed, and confirm that the new files are live past Cloudflare's 4-hour cache.

The theme is `11ty/css/hfy-theme.css`, built by [`islands/build.mjs`](../../islands/build.mjs) from the partials in [`islands/src/theme/`](../../islands/src/theme/) and the `@io-kit/tokens` harrisonfamily theme. The sign-in pages use their own stylesheet, `11ty/css/auth-edge.css`, built from [`islands/src/auth-edge/auth-edge.css`](../../islands/src/auth-edge/auth-edge.css). The brand fonts are self-hosted in `11ty/fonts/`, copied from exact-pinned `@fontsource` packages. Every one of these is committed build output: never edit it by hand. For why the theme works this way, see [The design system theme layer](../explanation/design-system-theme-layer.md). The cascade order, every build output and the lint rules are listed in [Theme and asset build](../reference/theme-and-asset-build.md).

Placeholders used on this page: `<site>` is the site's host name. `<repo>` is the absolute path of your checkout. `<scratch-site>` is an absolute path, outside the repository, to a directory that holds only a scratch copy of the site. `<version>` is a package version. The forms are listed in [Private data and secrets](../reference/private-data-and-secrets.md#placeholders).

## Before you start

- **The island dependencies are installed, dev dependencies included.** Follow steps 1 and 2 of [Build and preview the islands](build-and-preview-the-islands.md#1-get-a-codeartifact-token): Node 22 or later, a `CODEARTIFACT_AUTH_TOKEN` in this shell, and `npm ci` in `islands/` without `--omit=dev`. The fonts come from the dev dependencies. Run every command on this page from the repository root, in that shell.
- **For a sign-in stylesheet change, a token change or a font change, the `auth/` dependencies too:** `(cd auth && npm ci)`, in the same shell. Each of these can change the sign-in stylesheet.
- **For `npm run test:contract`, the `api/` dependencies:** `(cd api && npm ci)`. One of the contract tests imports the API handler.
- **Playwright's headless shell.** The Playwright specs in `islands/` and the sign-in end-to-end test in `auth/` both launch the `chromium-headless-shell` channel, not Google Chrome. [Run the tests](run-the-tests.md#4-run-the-island-browser-tests-local) shows how to install it and how to opt into Chrome.
- **A branch tied to an HFY record**, as in [Deploy a site change](deploy-a-site-change.md#before-you-start). Agents also follow the lifecycle in [`AGENTS.md`](../../AGENTS.md).
- **io's go-ahead and operator AWS credentials, if the sign-in stylesheet changes.** Redeploying `hfy-auth-edge` is a CloudFormation deploy of `<app-stack>`, which needs both ([Deploy the app stack](deploy-the-app-stack.md#before-you-start)). A Cloudflare purge needs io's go-ahead too.

Find your change in this table. It tells you what to edit, what the build will rewrite, and how the result ships.

| To change | Edit | The build also rewrites | Ships with |
|---|---|---|---|
| How an element of the site looks | A partial in `islands/src/theme/` | `css/hfy-theme.css`; its `?v=` in every page; the `hfy-asset-versions` blocks in `sw.js` and `js/feature-flags.js`, and so their `?v=` in the pages | A site deploy |
| How an island looks | The island's stylesheet: `islands/src/islands/<name>.css`, or `islands/src/shell.css`, `posts.css` or `comments.css` | The bundles in `js/islands/`, and the same stamps and `?v=` values | A site deploy |
| How the sign-in pages look | `islands/src/auth-edge/auth-edge.css` | `css/auth-edge.css`, and `theme.cssUrl` in `auth/edge.manifest.json` | A site deploy, then an `hfy-auth-edge` redeploy |
| A token's value: a colour, size, space or font stack | Nothing in this repository. The values come from `@io-kit/tokens`, so move to a release that has the new value. | `css/hfy-theme.css` and everything that names it, and usually `css/auth-edge.css` and `theme.cssUrl`. When the surface colour changes, also the `theme-color` meta in every page and the colours in `manifest.webmanifest`. | A site deploy, then an `hfy-auth-edge` redeploy if `css/auth-edge.css` changed |
| A brand font's files | Its `@fontsource` pin in `islands/package.json` | `fonts/`, whose file names carry a hash of their bytes; the `@font-face` rules in both stylesheets, and so `theme.cssUrl`; and, when the UI face changed, the font preload in every page | A site deploy, then an `hfy-auth-edge` redeploy if `css/auth-edge.css` changed |
| Which pages get the theme | `PAGES` in `islands/heads.mjs` | The new page's head blocks and `?v=` values | A site deploy |

## Steps

### 1. Make the change

Do the part that matches your change.

#### Edit a theme partial

1. Choose the partial by what it covers. [Theme and asset build: Partials](../reference/theme-and-asset-build.md#partials) lists the seven partials. The build imports every file in `islands/src/theme/` whose name is two digits, a hyphen and a name ending in `.css`, such as `50-gallery.css`, in ascending order, after the token files. It ignores other names. A new partial therefore takes its place in the cascade from its number.
2. Write the rule with tokens only: `var(--io-*)`, or `var(--bs-*)` where a Bootstrap variable is meant. Never write a literal colour, a `px`, `rem` or `em` length, or a font name. Step 2 checks this.
3. Leave `11ty/css/main.css` alone. It is Eleventy output and is never edited. The theme loads right after it, so a theme rule wins wherever its selector is at least as specific.
4. Put no site rules in `10-kit-aliases.css`. It only maps the short variables that the kit packages read to `--io-*` tokens, and it is the one file allowed to read them.

#### Edit the sign-in stylesheet

1. Edit `islands/src/auth-edge/auth-edge.css`, never `11ty/css/auth-edge.css`.
2. The kit links the stylesheet before its own inline `<style>`, so an inline rule of equal specificity wins. Prefix a rule that must beat one with `html`, as the existing rules do: `html main` beats the kit's `main`, and `html:root` beats its `:root`.
3. Keep the three `@import` lines at the top. The build resolves them into one file, so the page makes one stylesheet request. Add no `@import` of your own and no URL on another origin: the sign-in pages' Content-Security-Policy allows stylesheets only from `https://<site>`, inline and Google's sign-in stylesheet, and fonts only from `'self'` ([Identity services: Page theme and HFY overrides](../reference/identity-services.md#page-theme-and-hfy-overrides)).

The sign-in pages' markup comes from `@io-kit/auth` and the overrides in [`auth/src/edge.js`](../../auth/src/edge.js), and most of their text from the `copy` block of [`auth/edge.manifest.json`](../../auth/edge.manifest.json). A change to either is not a stylesheet change. It ships with an `hfy-auth-edge` redeploy alone ([Deploy the app stack](deploy-the-app-stack.md)).

#### Move to a new `@io-kit/tokens` release

```sh
(cd islands && npm install --save-exact @io-kit/tokens@<version>)
```

This updates `islands/package.json` and `islands/package-lock.json`. Check that `package.json` names the exact version, with no `^`. The build reads the theme, the bridges and the surface colour from this top-level copy, `islands/node_modules/@io-kit/tokens`.

Several tests pin approved values as literals, such as `SURFACE = "rgb(20, 18, 16)"` in [`theme-foundation.spec.mjs`](../../islands/tests/theme-foundation.spec.mjs) and in [`auth/e2e/signin-theme.e2e.mjs`](../../auth/e2e/signin-theme.e2e.mjs). Other specs in `islands/tests/` pin colours and font names too. If the release changes such a value on purpose, update the expected value wherever a test pins it, in the same commit. If the change is not intended, stay on the current release.

#### Move a brand font to a new `@fontsource` pin

The three faces come from these dev dependencies:

| Package | Family | Role |
|---|---|---|
| `@fontsource-variable/source-sans-3` | Source Sans 3 | The UI face, preloaded on every page |
| `@fontsource/libre-caslon-text` | Libre Caslon Text | The display serif |
| `@fontsource-variable/source-code-pro` | Source Code Pro | The monospace face |

Move one to a new version, keeping it an exact dev dependency:

```sh
(cd islands && npm install --save-dev --save-exact @fontsource/libre-caslon-text@<version>)
```

[`islands/fonts.mjs`](../../islands/fonts.mjs) reads each package's `metadata.json`, `unicode.json`, `LICENSE` and the latin and latin-ext `.woff2` files it ships. A release that renames the family or the files stops the build (see [Troubleshooting](#troubleshooting)).

Replacing a family with another one is more than a pin change. The family names come from the font stacks in `@io-kit/tokens` (`--io-typography-font-ui`, `-display` and `-mono`), so it needs a tokens release that names the new family. Then change `FAMILIES` in `fonts.mjs` (and `PRELOAD` for the UI face), the dev dependency, and the family names and face counts that the tests expect: `theme-delivery.test.mjs`, `bundle.test.mjs`, the Playwright specs and `signin-theme.e2e.mjs`. The new family must be self-hosted the same way. `theme-delivery.test.mjs` fails on a Google Fonts, Typekit, Bunny Fonts or Adobe Fonts origin, the sign-in pages allow fonts only from `'self'` (`theme.fontOrigins` is `["self"]`), and [the privacy model](../explanation/family-data-privacy.md#fonts-come-from-the-site-itself) explains why.

#### Register a new page

Every HTML page of the site must be in `PAGES` in [`islands/heads.mjs`](../../islands/heads.mjs), or `theme-delivery.test.mjs` fails with `pages without a head-block registration (add them to heads.mjs PAGES): <page>`.

1. Add the page's path, relative to `11ty/`, to `PAGES`, for example `"gallery/index.html"`.
2. The page needs a `/css/main.css` link or a `</title>`. The build writes block A before the `main.css` link and block B after it, or both right after `</title>` on a page without `main.css`.
3. If the page has no `main.css` link, also add it to `REPO_ONLY` in [`islands/tests/theme-delivery.test.mjs`](../../islands/tests/theme-delivery.test.mjs). Otherwise the test expects one.
4. If the page never loads `js/feature-flags.js`, add it to `NO_HINT` in `heads.mjs`, so that block A carries no shell hint. Nothing on such a page would mount the shell or clear the hint's class.
5. If the page is written in the repository and has inline styles, add it to `REPO_PAGES` in [`islands/tests/theme-lint.test.mjs`](../../islands/tests/theme-lint.test.mjs), so that the lint checks them.
6. If the page is written in the repository rather than rendered by the Eleventy source, the next refresh deletes it unless it is excluded. Add its path to the refresh `rsync` excludes in [`11ty/README.md`](../../11ty/README.md) and to the Eleventy excludes in [`scripts/check-deployment-sync.sh`](../../scripts/check-deployment-sync.sh), together. `scripts/infra/test/run.sh` fails when the two lists differ ([Refresh the Eleventy output](refresh-the-eleventy-output.md)).

The build does not look for pages under the top-level `js/`, `css/`, `fonts/`, `images/`, `media/`, `uploads/`, `_data/`, `family/`, `event/`, `note/` or `place/` directories. A page there gets neither the head blocks nor `?v=` values.

### 2. Run the theme lint

```sh
(cd islands && npm run lint:css)
```

It covers every stylesheet under `islands/src/`, theme partials and the sign-in stylesheet included, and the inline styles of the pages in `REPO_PAGES`. Each finding names the file, the line and the declaration, then the reason, for example:

```text
src/theme/40-site.css:12 padding: 12px  <- literal length 12px
```

The reasons are `literal hex colour`, `literal rgb/hsl colour`, `literal length`, `names a font family (alias --io-typography-font-*)` and `reads --<name> (only --io-* / --bs-* may be read)`. Fix each one with the token that holds the value:

```css
/* fails the lint */
.example { padding: 12px; color: #fff; font-family: Georgia, serif; }
/* passes */
.example { padding: var(--io-space-3); color: var(--io-color-semantic-text); font-family: var(--io-typography-font-display); }
```

The token names are in `islands/node_modules/@io-kit/tokens/dist/harrisonfamily/theme.css`. The full rules are in [Theme and asset build: Theme lint](../reference/theme-and-asset-build.md#theme-lint). The lint lets these through: `0`, a `1px` hairline, percentages, `vh` and `vw`, unitless numbers, `calc(100vw - 32px)`, `url(...)` contents, `@font-face` blocks, and at-rule conditions such as `@media (min-width: 43rem)`, which cannot use `var()`.

Every linted file must also parse without esbuild warnings. A comment closed early, for example by a `**/` inside it, silently drops the rules after it. To lint only the files you changed while you iterate, pass globs relative to `islands/`:

```sh
(cd islands && HFY_LINT_ONLY='src/theme/40-*.css src/auth-edge/*.css' npm run lint:css)
```

Run the whole lint again before you commit. The summary must show `fail 0`.

### 3. Try the change in a scratch build

A scratch build leaves `11ty/` and `auth/edge.manifest.json` untouched, and the sign-in test needs one. Copy the site, or refresh an earlier copy, and build into it:

```sh
rsync -a --delete 11ty/ <scratch-site>/
(cd islands && node build.mjs --site <scratch-site>)
```

The build prints `built <n> files into <scratch-site> (<m> written)`. If esbuild prints a CSS warning, fix the source and build again. Then check the head blocks and run the specs against the copy:

```sh
(cd islands && HFY_SITE=<scratch-site> node --test tests/theme-delivery.test.mjs)
(cd islands && HFY_SITE=<scratch-site> PW_PORT=8090 npx playwright test)
```

- `theme-delivery` checks that every page is registered and carries both head blocks, that block B links `/css/hfy-theme.css?v=<sha8>` of the built file, that the `theme-color` meta and the manifest colours are the surface token, and that the 12 faces and three licences are in `fonts/`.
- Set `PW_PORT` to a free port whenever you set `HFY_SITE`. Playwright reuses any server already on its port, so with the default port `8089` and a preview server running over `11ty/`, the specs would test `11ty/` instead of the copy.
- To look at the copy yourself, serve it with `(cd islands && npx http-server <scratch-site> -p 8090 -a 127.0.0.1 -c-1)` and open <http://127.0.0.1:8090/>. Playwright reuses that server.
- `(cd islands && HFY_SITE=<scratch-site> PW_PORT=8090 npm test)` runs every `node:test` suite and the specs against the copy in one go.

If the sign-in stylesheet changed, run the sign-in pages in the headless shell against the copy. A token or font change usually changes it too. This prints `changed` when it did:

```sh
cmp -s 11ty/css/auth-edge.css <scratch-site>/css/auth-edge.css || echo changed
(cd auth && SITE=<scratch-site> npm run e2e:theme)
```

It serves the real auth edge pages, with their real Content-Security-Policy, on `http://localhost:4175` (another port with `E2E_PORT`), and serves `/css` and `/fonts` from `SITE`. It ends with `<passed>/<total> checks passed` and exits `0` when every check passed. To look at the pages, add `E2E_SHOTS=<dir>`, which saves a screenshot of each page at 375 and 1024 px. [Run the tests: Sign-in pages](run-the-tests.md#sign-in-pages) describes the checks.

### 4. Build into `11ty/` and check it

```sh
(cd islands && npm run build)
(cd islands && npm run check:islands)
```

The build rewrites `11ty/` and, for a sign-in stylesheet change, `theme.cssUrl` in `auth/edge.manifest.json`. `check:islands` must print `<repo>/11ty is up to date (<n> generated files)`. Then run the suites against `11ty/`:

```sh
(cd islands && npm test)
```

`npm test` runs `test:contract` (the lint, `theme-delivery`, `asset-versions`, `copy`, `bundle` and the other `node:test` suites) and then every Playwright spec, against `11ty/` on port `8089`. If a server is already running on that port, it must serve `11ty/`, because Playwright reuses it. Neither part may report a failure.

If `theme.cssUrl` changed, also run the two suites that compare it with the committed stylesheet:

```sh
(cd auth && npm test)
scripts/infra/test/run.sh
```

Vitest must report no failed test. `run.sh` must end with `scripts/infra tests: <n> passed, 0 failed`. [Run the tests](run-the-tests.md#5-run-the-infrastructure-script-tests-offline) lists the tools it needs.

The Eleventy source's head partial emits both head blocks with a theme `?v=` and a font file name written into the template. Leave them as they are. They go stale with every theme or font change, and the islands build rewrites both blocks in `11ty/` on every run ([Refresh the Eleventy output](refresh-the-eleventy-output.md#mirror-the-repositorys-files-into-the-source)).

### 5. Commit the source and the generated files together

```sh
git status --short islands 11ty auth
git add islands 11ty auth/edge.manifest.json
git diff --cached --stat
```

The first command lists what changed. Besides your source change, expect some of: `11ty/css/hfy-theme.css`, `11ty/css/auth-edge.css`, `11ty/fonts/`, `11ty/js/islands/`, most pages under `11ty/`, `11ty/js/feature-flags.js`, `11ty/sw.js`, `11ty/manifest.webmanifest` and `auth/edge.manifest.json`. Also stage any test you updated outside `islands/`, such as `auth/e2e/signin-theme.e2e.mjs`, and, for a new page, `11ty/README.md` and `scripts/check-deployment-sync.sh`.

Commit everything in one commit, with the HFY record ID first in the message. A commit that carries the source without its output ships the old output, and `check:islands` fails on it. Never edit a `?v=`, a stamped block or a generated file to make a check pass: build again.

### 6. Deploy the site

Ship the commit with [Deploy a site change](deploy-a-site-change.md): open the pull request, merge it, and watch the `io-kit-deploy.yml` run to the end of its `smoke` job. No workflow runs the lint or `check:islands`, and the suites CI does run do not cover the theme, so steps 2 to 4 are the only checks the change gets.

### 7. Redeploy `hfy-auth-edge` if the sign-in stylesheet's URL changed

Compare the URL that the commit names with the one the live sign-in page links:

```sh
jq -r .theme.cssUrl auth/edge.manifest.json
curl -s https://<site>/auth/login | grep -o 'auth-edge\.css?v=[0-9a-f]*' | head -1
```

If both name the same `auth-edge.css?v=<sha8>`, skip this step. Otherwise the live sign-in pages still link the previous version, and they can be served the old or the new stylesheet under it.

Redeploy only after the site deploy's run is green, so that the file the new URL names is already in the site bucket. A request for the new URL that arrives earlier gets the old file, and Cloudflare then keeps the old bytes under the new URL for up to 4 hours. For the same reason, do not fetch the new URL yourself before then.

With io's go-ahead and operator credentials, follow [Deploy the app stack](deploy-the-app-stack.md) for a code-only update: steps 2 to 4 build the packages, upload them under keys named after the commit, and deploy them through a reviewed change set. The manifest ships inside `hfy-auth-edge.zip`.

## Verify

Run these checks from the root of an up-to-date `main` checkout. Fetch only versioned URLs: a bare URL such as `https://<site>/css/hfy-theme.css` can return Cloudflare's copy, up to 4 hours old, after a green deploy. Cloudflare does not cache HTML, so the pages always name the current versions.

1. **The pages link the committed theme, and that URL serves it.**

   ```sh
   V="$(shasum -a 256 < 11ty/css/hfy-theme.css | cut -c1-8)"; echo "$V"
   curl -s https://<site>/ | grep -o '/css/hfy-theme\.css?v=[0-9a-f]*'
   curl -s "https://<site>/css/hfy-theme.css?v=$V" | shasum -a 256 | cut -c1-8
   ```

   The second line ends in the same eight hex digits as the first, and the third line repeats them.

2. **The fonts are live.** A font's file name carries the hash of its bytes, so each new face has a new URL:

   ```sh
   for f in 11ty/fonts/*.woff2; do
     n="$(basename "$f")"; want="${n%.woff2}"; want="${want##*.}"
     got="$(curl -s "https://<site>/fonts/$n" | shasum -a 256 | cut -c1-8)"
     [ "$got" = "$want" ] && echo "same: $n" || echo "DIFFERENT: $n"
   done
   ```

   Each line says `same`.

3. **After a token change, the page colour matches.**

   ```sh
   curl -s https://<site>/ | grep -o '<meta name="theme-color" content="[^"]*"'
   grep -o '<meta name="theme-color" content="[^"]*"' 11ty/index.html
   ```

   Both lines are the same.

4. **After the `hfy-auth-edge` redeploy, the sign-in pages link the new stylesheet, and it is live.**

   ```sh
   S="$(jq -r .theme.cssUrl auth/edge.manifest.json | grep -o 'auth-edge\.css?v=[0-9a-f]*')"; echo "$S"
   curl -s https://<site>/auth/login | grep -o 'auth-edge\.css?v=[0-9a-f]*' | head -1
   curl -s "https://<site>/css/$S" | shasum -a 256 | cut -c1-8
   ```

   The first two lines are the same, and the third prints the eight hex digits after `?v=`.

5. **The change shows in a browser.** Open `https://<site>/` in a private window, so that no preview override applies, and look at what you changed. For sign-in changes, open `https://<site>/auth/login`. In the installed app, a theme change gives `sw.js` a new `?v=`, so the shell registers a new service worker with its own cache. The worker fetches the theme from the network first, and a reload shows the change.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| The lint reports `literal length`, `literal hex colour`, `literal rgb/hsl colour` or `names a font family`. | The declaration holds a value instead of a token. | Use the token, as in [step 2](#2-run-the-theme-lint). |
| The lint reports `reads --<name> (only --io-* / --bs-* may be read)`. | The rule reads a kit short variable or a variable of its own. | Read the `--io-*` token. Only `10-kit-aliases.css` may read the kit's short variables. |
| `parses without warnings` fails, or the build prints a CSS warning. | A syntax slip, such as a comment closed early by `**/`. | Fix the line it names, and lint again. |
| The build stops with `<package>: metadata family is "<name>", expected "<name>"`, with `<package>: unicode.json has no "<subset>" range`, or with `ENOENT` on a `.woff2` under the package's `files/`. | The new `@fontsource` release renamed the family or its files. | Pin the previous version again, or treat the change as replacing a family ([step 1](#move-a-brand-font-to-a-new-fontsource-pin)). |
| The build stops with `theme.css: no :root block`, `theme.css: cannot resolve --io-color-semantic-surface` or `theme.css: no [data-theme="light"] block`. | The new `@io-kit/tokens` release changed the shape of the harrisonfamily theme. | Pin the previous version again, and raise the change with the kit. |
| The build stops with `<page>: no main.css link and no </title> to anchor the theme head block`. | A page in `PAGES` has neither. | Give the page a `<title>`. |
| `theme-delivery` fails with `pages without a head-block registration`. | A page is missing from `PAGES`. | Register it ([step 1](#register-a-new-page)). |
| `theme-delivery` fails with `main.css link present` on a new page. | The page has no `main.css` link and is not in `REPO_ONLY`. | Add it to `REPO_ONLY` in `theme-delivery.test.mjs`. |
| `check:islands` reports `stale auth/edge.manifest.json`, or `auth` `npm test` or `run.sh` fails on `theme.cssUrl`. | The sign-in stylesheet changed, and the manifest still names the old `?v=`. Either the build ran only into a scratch copy, or the manifest was not committed. | Run `npm run build` in `islands/` without `--site`, and commit `auth/edge.manifest.json`. |
| `check:islands` reports `stale`, `missing` or `extra` files. | The committed output does not match the source. | Build again and commit the result with the source. |
| `e2e:theme` exits `2` with `SITE must name a built site copy containing css/auth-edge.css`. | `SITE` is unset, or names a directory that was not built. | Build the scratch copy ([step 3](#3-try-the-change-in-a-scratch-build)) and pass its absolute path. |
| The specs pass with `HFY_SITE`, but do not show the change. | Playwright reused a server on its port that serves another directory. | Stop that server, or set `PW_PORT` to a free port. |
| A spec or `e2e:theme` fails on a colour after a token change. | The test pins the approved value as a literal. | If the new value is intended, update the expected value in the same commit. Otherwise stay on the current release. |
| After the deploy, the sign-in page still links the old `auth-edge.css?v=`. | `hfy-auth-edge` has not been redeployed from the commit. | Do [step 7](#7-redeploy-hfy-auth-edge-if-the-sign-in-stylesheets-url-changed). |
| A check in [Verify](#verify) prints `DIFFERENT`, or a hash that does not match. | The deploy did not ship the committed file, or an edge fetched the new URL while the deploy's sync ran, got the old file, and Cloudflare kept it. A rerun of the deploy does not replace Cloudflare's copy. | First check that the deploy run is green ([Deploy a site change](deploy-a-site-change.md#3-watch-the-runs)). If it is, wait up to 4 hours for Cloudflare's copy to expire, then check again. A Cloudflare purge needs io's go-ahead. |

## Undo the change

Revert the change's merge, as in [Roll back a site deploy: Roll back by revert](roll-back-a-site-deploy.md#roll-back-by-revert). The revert restores the previous source and every generated file with its `?v=` values, so the pages name the previous files again. If the reverted commit changed `theme.cssUrl`, redeploy `hfy-auth-edge` from the revert commit once its site deploy is green, as in [step 7](#7-redeploy-hfy-auth-edge-if-the-sign-in-stylesheets-url-changed). Then run [Verify](#verify) against the reverted files.

## Limits

- **Token values are not set here.** Colours, sizes, spacing, radii and font stacks come from `@io-kit/tokens`, outside this repository. This repository chooses which token each element uses, and which release to pin.
- **The sign-in pages lag the site.** Until `hfy-auth-edge` is redeployed, they link the previous stylesheet URL. The site deploy does not ship `auth/edge.manifest.json`.
- **A bare URL can be stale for 4 hours.** Cloudflare caches static files under the URL it first fetched them by, and the deploy's CloudFront invalidation does not reach it. The `?v=` values and the hashed font names are what get a deploy past it ([Edge and origin design](../explanation/edge-and-origin-design.md#static-files-and-versioned-urls-hfy-tsk-086)).

## Related pages

- [The design system theme layer](../explanation/design-system-theme-layer.md): why the theme is a static stylesheet built from tokens, why only tokens hold values, and why the fonts are self-hosted.
- [Theme and asset build](../reference/theme-and-asset-build.md): every output of the islands build, the cascade, the lint and the `?v=<sha8>` versions.
- [Front end](../reference/front-end.md#theme-layer-and-head-blocks): the partials, the head blocks and the asset versions.
- [Identity services](../reference/identity-services.md#page-theme-and-hfy-overrides): the sign-in pages' stylesheet, Content-Security-Policy and overrides.
- [Build and preview the islands](build-and-preview-the-islands.md): the build, the scratch copy and the local preview.
- [Run the tests](run-the-tests.md): every suite this page runs.
- [Deploy a site change](deploy-a-site-change.md) and [Deploy the app stack](deploy-the-app-stack.md): the two deploys a theme change can need.
- [Refresh the Eleventy output](refresh-the-eleventy-output.md): rebuild the pages from the Eleventy source, then the islands over them.
