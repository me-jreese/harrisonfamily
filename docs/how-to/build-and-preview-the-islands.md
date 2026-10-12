# How to build and preview the React islands

This page shows how to install the island dependencies, rebuild the island bundles in `11ty/js/islands/` after a change to `islands/`, check that the committed bundles match the source, and view them in a local browser with a feature flag turned on.

The bundles are committed build output (HFY-R58). No workflow builds them: the next deploy ships exactly what is committed in `11ty/js/islands/`. So every change to `islands/` is committed together with its rebuilt bundles, and `npm run check:islands` confirms that the two match.

For why the bundles are committed, see [the release model](../explanation/release-model.md#why-island-bundles-are-committed-output). For the esbuild settings, the output layout and the pinned package versions, see the [front-end reference](../reference/front-end.md#island-build).

Placeholder used on this page: `<aws-account-id>` is the AWS account that owns the `io` CodeArtifact domain. It is the number in the registry host name in [`islands/.npmrc`](../../islands/.npmrc). Placeholder forms are listed in [Private data and secrets](../reference/private-data-and-secrets.md#placeholders).

## Before you start

You need:

- **Node 22 or later.** [`islands/package.json`](../../islands/package.json) declares `"node": ">=22"`.
- **The AWS CLI, with credentials for `us-west-2`** that allow `codeartifact:GetAuthorizationToken` on the `io` domain and `sts:GetServiceBearerToken`. Installing the packages also needs `codeartifact:ReadFromRepository` on the `io-kit` repository, because the token carries the permissions of the principal that requested it.
- **Google Chrome, for the test step only.** [`islands/playwright.config.mjs`](../../islands/playwright.config.mjs) launches the `chrome` channel unless `PW_CHANNEL` names another. See [How to run the test suites](run-the-tests.md).

A clean checkout already holds the committed bundles, so you can [preview](#4-preview-with-a-flag-override) without building. Build only after you change something under `islands/`, or when `check:islands` reports the bundles stale.

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

### 2. Build the bundles

From the repository root:

```bash
bash scripts/ci/build-islands.sh
```

[`scripts/ci/build-islands.sh`](../../scripts/ci/build-islands.sh) stops with an error naming `CODEARTIFACT_AUTH_TOKEN` if the variable is unset, and never prints the token. It silences npm's normal output, but errors still appear. It ends with `built islands -> 11ty/js/islands`. The files it writes are listed in the [front-end reference](../reference/front-end.md#island-build).

The manual equivalent, when you want npm's full output:

```bash
cd islands
npm ci
npm run build:islands
```

Unlike the script, this runs package install scripts and skips the final check. After changing island source, rerun `npm run build:islands` from `islands/`. You only need `npm ci` again when `islands/package-lock.json` changes.

Each build deletes `11ty/js/islands/` and writes it again, so anything you place there by hand is lost on the next run. Chunk names carry a content hash, so a change to shared code renames chunks: expect deleted and added files under `chunks/` in `git status`.

### 3. Check the bundles against the source

```bash
(cd islands && npm run check:islands)
```

It prints `11ty/js/islands is up to date (<n> files)` and exits `0`. Otherwise it lists each `missing`, `stale` or `extra` file and exits `1`: build again from the current source. The check rebuilds in memory and writes nothing.

### 4. Preview with a flag override

The server does not need the token, so any terminal will do. From the repository root, start a static server over `11ty/`:

```bash
cd islands
npx http-server ../11ty -p 8089 -a 127.0.0.1 -c-1
```

This is the server and port that the Playwright config uses. `http-server` is a pinned dev dependency, so `npx` runs the installed copy. `-c-1` turns off HTTP caching so a rebuild shows on reload. The server runs in the foreground. Leave it running in this terminal.

Open <http://127.0.0.1:8089/?hfy_flags=shellV2>.

A **Preview flags on — turn off** banner appears at the bottom left. The override is saved in this tab's `sessionStorage` under `hfy:flags` for `127.0.0.1:8089`. It applies to every page you open in this tab until you press **turn off**, open <http://127.0.0.1:8089/?hfy_flags=>, or close the tab. A new value replaces the stored list rather than adding to it, and a leading `-` forces a flag off. If an island bundle fails to load, the override turns itself off and the banner disappears. The full rules are in [How to turn a feature flag on for one tab or for everyone](toggle-a-feature-flag.md).

What each flag shows on the local preview:

| Flag | Open | What you see locally |
|---|---|---|
| `shellV2` | `/?hfy_flags=shellV2`, or any page | The kit shell with the old navbar hidden. At phone width (688 px or less, for example Chrome DevTools device mode at 375 × 812, the size the specs use), a bottom bar with Home, Family, Posts and Me. Wider than that, the same links in the top bar. A Search button either way. It needs no other data. |
| `searchV2` | `/search/?hfy_flags=searchV2` | The search island inside the shell, because `searchV2` turns on `shellV2` unless `-shellV2` is also given. It shows the loading skeleton for about 8 seconds, then redirects to `/family-login/?next=...`. The rendered pages set `enforceAssets: true` and the local preview has no session token, so the island never fetches `/person/index.json`. Typing in the shell's Search box with `searchV2` on loads the same index and redirects the same way. To see results, run [`islands/tests/search.spec.mjs`](../../islands/tests/search.spec.mjs), which seeds a synthetic session token and stubs `/person/index.json` and `/person/search-index.json`. |
| `personV2`, `postsV2`, `notifyV2` | The pages listed in the [island catalog](../reference/front-end.md#catalog) | The bundle loads, but these islands need person data or `/api`. On `/person/?id=<id>`, which hosts the `person` and `my-posts` islands, [`11ty/js/person-page.js`](../../11ty/js/person-page.js) waits about 8 seconds for a session token and then redirects to `/family-login/`. See [Limits](#limits). |

With `shellV2` on, the shell island registers `/sw.js` for `127.0.0.1:8089`. The worker fetches the island entry modules from the network first and serves the hashed chunks from its cache, so a reload after a rebuild runs the new build. If you still see an old build, in Chrome DevTools open **Application > Service workers** and tick **Bypass for network** while you iterate.

### 5. Commit the bundles with the source

```bash
git add islands 11ty/js/islands
git status --short islands 11ty/js/islands
```

Commit the source change and the rebuilt bundles together, in one commit. A commit that changes `islands/src/` without its bundles ships the old bundles, and `check:islands` fails on it.

## Verify

In a second terminal, from the repository root:

1. The bundles exist and match the source:

   ```bash
   ls 11ty/js/islands
   (cd islands && npm run check:islands)
   ```

   Expect the seven `.js` files, the seven `.css` files, `chunks/` and `notify-sw.js`, then `11ty/js/islands is up to date (<n> files)`.

2. The server serves the shell bundle:

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8089/js/islands/shell.js
   ```

   Expect `200`.

3. The shell mounted. On <http://127.0.0.1:8089/?hfy_flags=shellV2>, once the page has loaded, run this in the browser console:

   ```js
   !!document.querySelector('#hfy-shell-root .io-shell')
   ```

   Expect `true`. This is the element the Playwright shell spec waits for. If it is `false`, check `document.documentElement.classList.contains("hfy-shell-v2")`. The loader adds that class before it injects `shell.js` and removes it only if the script fails to load. A `false` class means the bundle was not found, so rerun checks 1 and 2. A `true` class means the bundle loaded but did not mount, so look for an error in the console.

4. The browser specs pass:

   ```bash
   cd islands
   npx playwright test
   ```

   This runs the Playwright specs at 375 × 812 against `http://127.0.0.1:8089`. Playwright reuses your preview server if it is still running and starts its own otherwise. The specs load the bundles in `11ty/js/islands/`, so rebuild after any source change first. `npm test` runs the `node:test` tests first, including the bundle test, and the contract tests among them also need `api/` dependencies installed. See [How to run the test suites](run-the-tests.md) for that, for running one spec, and for using another browser channel.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| The build script stops with an error naming `CODEARTIFACT_AUTH_TOKEN`. | The variable is not set in this shell. | Repeat step 1 in the shell you build from. |
| `get-authorization-token` fails with access denied. | The credentials lack `codeartifact:GetAuthorizationToken` or `sts:GetServiceBearerToken`. | Use credentials that have both, in `us-west-2`. |
| `npm ci` fails with a 401 or 403 on an `@io-kit` package. | The token expired, was issued for another account, or its principal cannot read the `io-kit` repository. | Repeat step 1. Check that `<aws-account-id>` matches the host name in `islands/.npmrc`. |
| `?hfy_flags=shellV2` still shows the old navbar. | `shell.js` was not found, so the loader removed `hfy-shell-v2`. Either the build did not run or the server is not serving `11ty/`. | Run verify checks 1 and 2. Start the server from `islands/` with `../11ty` as its root. |
| The shell shows no bottom bar. | The window is wider than 688 px, where the shell puts its links in the top bar. | Narrow the window, or use DevTools device mode at 375 × 812. |
| The page jumps to `/family-login/` after a few seconds. | A gated page with no session token on the local preview: the search island, a Search box query with `searchV2` on, or a `/person/?id=` page. | Expected. Use the Playwright specs, which seed a synthetic token, or the deployed site. |
| A flag stays on for every page in the tab. | The override lasts for the tab. | Press **turn off** in the banner, open `/?hfy_flags=`, or close the tab. |
| The banner disappears by itself and the page shows the legacy version. | An island bundle failed to load, so the loader turned the override off. | Run verify checks 1 and 2, and look for the failed request in the Network panel. |
| `check:islands` reports `stale`, `missing` or `extra` files. | The committed bundles do not match the source. | Build again (step 2) and commit the result with the source. |
| Island changes do not show after a rebuild. | The browser or the service worker served a cached copy. | Bypass or unregister the worker in DevTools, and check that the server runs with `-c-1`. |
| Playwright cannot launch a browser. | Google Chrome is not installed. | Install Chrome, or set `PW_CHANNEL` (see [How to run the test suites](run-the-tests.md)). |

## Limits

- **The local preview has no API, auth or person data.** `http-server` serves only the files in `11ty/`, so `/api` and `/auth` return 404, and the repository holds no person records. Islands that call `/auth/session` therefore treat you as signed out. The API-backed islands (`person`, `my-posts`, `timeline`, `posts`, `notifications`) and the `search` island render against data only inside the Playwright specs, which stub those routes with synthetic fixtures.
- **Gated pages redirect to sign-in.** The search island, a Search box query with `searchV2` on, and `/person/?id=` pages wait about 8 seconds for a session token, then redirect to `/family-login/`. The local preview cannot sign you in, so these pages cannot be viewed there.
- **A live API needs the deployed site.** To exercise an island against real `/api` and `/auth`, use the deployed site with an override. It serves the bundles committed on `main` as of the last deploy.
- **Building publishes nothing; merging does.** A local build only changes your working tree. Once the rebuilt bundles are committed and merged to `main`, the next deploy ships them ([How to deploy a change to the static site](deploy-a-site-change.md)). No workflow builds them or runs `check:islands`, so run it yourself before you open the pull request.
- **The preview serves the committed `11ty/` as it is.** It does not rebuild the Eleventy pages. For that, see [How to refresh `11ty/` from the Eleventy source without losing E5 files](refresh-the-eleventy-output.md).

## Related pages

- [Why React islands on a generated Eleventy site](../explanation/islands-on-eleventy.md): why the islands exist and where their bundles come from.
- [Why releases ship through a pipeline and feature flags](../explanation/release-model.md): how flags stage a release and roll it back.
- [Front end](../reference/front-end.md): the flag resolver, island catalog, build settings and service worker.
- [How to turn a feature flag on for one browser or for everyone](toggle-a-feature-flag.md): build-time values and per-browser overrides.
- [How to run the test suites](run-the-tests.md): the contract tests and the Playwright specs.
