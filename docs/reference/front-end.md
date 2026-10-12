# Front end

Reference for the browser side of the site: what `11ty/` contains, the feature flags, the `authV2` data path, the island loader and islands, and the PWA shell.

For why the front end is a generated site with React islands on top, see [Why React islands on a generated Eleventy site](../explanation/islands-on-eleventy.md). For how flags stage a release, see [the release model](../explanation/release-model.md). For why person data is gated and what the client does about it, see [the privacy model for family data](../explanation/family-data-privacy.md#the-client-side).

Placeholders used on this page:

- `<eleventy-source>` is the Eleventy project outside the repository that renders `11ty/`. The [codebase map](codebase-map.md) says where it sits.
- `<name>` is an island name, such as `shell`.
- `<gramps_id>` is a person's Gramps record ID, and `<ulid>` is a post ID.
- `<sub>` is the signed-in member's subject at the auth edge. `/auth/session` returns it as both `sub` and `grampsId`, so it is that member's Gramps ID.

## What `11ty/` contains

The deploy pipeline ([`io-kit-deploy.yml`](../../.github/workflows/io-kit-deploy.yml), see [Repository operations](repository-operations.md#workflows)) syncs `11ty/` to the site bucket as it is, so every file in it ships. CI builds nothing into it.

| Kind | Files | Origin | Notes |
|---|---|---|---|
| Eleventy-generated | `css/main.css`, `css/main.css.map`; `images/` except `pwa-*`; `js/auth.js`, `js/bootstrap.bundle.min.js` | Copied unchanged from a build of `<eleventy-source>`, whose `public/` directory passes through to the site root. | A fresh build replaces them and loses nothing. |
| Eleventy-generated, then edited for E5 | The ten rendered pages: `index.html`, and `index.html` under `about/`, `contact/`, `family-login/`, `logged-out/`, `person/`, `privacy/`, `private/`, `search/` and `terms/`. Also `js/feature-flags.js`, `js/person-page.js`, `js/search-navbar.js` and `js/search-results.js`. | Rendered by `<eleventy-source>`, then changed in the repository. | Each page has an added `<script src="/js/auth-v2.js" defer></script>`. `feature-flags.js` has the flag resolver, the preview override, the `authV2` data API (see [authV2 data fetch and session continuity](#authv2-data-fetch-and-session-continuity)) and the island loader inserted after `window.HFYFeatureFlags = featureAPI;`, plus the [edge overlay](#edge-overlay) in its pre-E5 part. `person-page.js` fetches its data through `HFYFeatureFlags.dataFetch`. With `authV2` on it skips the legacy token wait, and it shows "Your sign-in has expired. Sign in again" when the record is still refused. The two search scripts have a `hfySearchV2Live()` helper at the top, and their data loads stand down once the search island has mounted. They also choose the credential with an `edgeSessionInit()` helper and fetch the person index files through `dataFetch`. A fresh build drops all of these edits. |
| Repo-authored, output-only (E5) | `_data/flags.json`, `js/auth-v2.js`, `sw.js`, `manifest.webmanifest`, `offline.html`, `images/pwa-192.png`, `images/pwa-512.png`, `images/pwa-maskable-512.png`, `posts/index.html`, `me/notifications/index.html` | Written in the repository. They have no counterpart in `<eleventy-source>`. | `11ty/` holds the only copy. A refresh that copies with `--delete` removes them. |
| Island build products | `js/islands/` | Produced by [`islands/build.mjs`](../../islands/build.mjs). | Committed build output (HFY-R58). It ships with the `11ty/` sync, and `npm run check:islands` fails when it is stale. See [Island build](#island-build). |
| CI-patched placeholder | The string `REPLACE_WITH_GOOGLE_CLIENT_ID` in `js/auth.js` and in the inlined `window.HFY_AUTH_CONFIG` of the ten rendered pages | `<eleventy-source>` emits it when `HFY_GOOGLE_CLIENT_ID` is unset at build time. | The kit build step runs [`scripts/ci/patch-client-id.sh`](../../scripts/ci/patch-client-id.sh), which replaces it in every `.html` and `.js` file under `11ty/` with the `HFY_GOOGLE_CLIENT_ID` repository secret on the CI runner, before the release artifact is packaged. The committed files keep the placeholder. |
| Repository note | `README.md` | Written in the repository. | A pointer into `docs/`, plus two blocks that [`scripts/infra/test/run.sh`](../../scripts/infra/test/run.sh) checks: the table under `## Repo-owned files`, which must list `js/person-page.js`, and the refresh `rsync -a --delete -n -i` command, whose `--exclude` list must equal the Eleventy check's in [`scripts/check-deployment-sync.sh`](../../scripts/check-deployment-sync.sh), apart from `.DS_Store`. The refresh excludes the README itself. |

`/posts/` and `/me/notifications/` are minimal hand-written pages. They load `feature-flags.js`, but not the inlined `window.HFY_FEATURE_FLAGS` config, `auth.js`, `auth-v2.js` or the Bootstrap navbar. `offline.html` loads no scripts.

### Data fetched at runtime

Person data and media are not in `11ty/`. Pages fetch them at runtime. The deploy's sync excludes `person/*.json`, `media/*`, `family/*`, `event/*`, `note/*`, `place/*` and `uploads/*` (the `exclude` list in [`ci.manifest.yaml`](../../ci.manifest.yaml)), so a deploy neither uploads nor deletes them. What those paths hold and who may read them is in [private data and secrets](private-data-and-secrets.md).

| Build variable | Rendered into | Default | Value in the committed `person/index.html` |
|---|---|---|---|
| `HFY_DATA_BASE` | `window.HFY_PERSON_CONFIG.dataBase`: the base URL for `<gramps_id>.json` | `/person/` | `/person/` |
| `HFY_MEDIA_BASE` | `window.HFY_PERSON_CONFIG.mediaBase`: the base URL for photos and media | `/media/` | `/media/` |
| `HFY_ENV` | `window.HFY_PERSON_CONFIG.env` | `dev` | `dev`. [`person-page.js`](../../11ty/js/person-page.js) stores it and reads it nowhere else. |

The production build in [Refresh the Eleventy output](../how-to/refresh-the-eleventy-output.md) sets both bases to absolute URLs on the production host, but the person template does not read them. The committed person page carries the defaults, so it requests data from the origin that served the page.

The search scripts and the search island use two fixed paths: `/person/index.json` (the person manifest) and `/person/search-index.json`. They come from `window.HFY_SEARCH_CONFIG` on the rendered pages and from [`people-corpus.js`](../../islands/src/lib/people-corpus.js) in the islands.

How a request for person data is authenticated depends on the merged `authV2` flag:

| `authV2` | Person-data requests (the record JSON and the two index files) |
|---|---|
| Off | A plain `fetch`: callers still go through `HFYFeatureFlags.dataFetch`, which passes the request through unchanged. Once a legacy gateway session exists, the request sends its token in an `X-HFY-Session` header, with `credentials: "include"` (see [Legacy component gating](#legacy-component-gating)). |
| On | Sent through `HFYFeatureFlags.dataFetch` with `credentials: "same-origin"` and no `X-HFY-Session` header, so the HttpOnly `io_id` session cookie is the only credential. See [authV2 data fetch and session continuity](#authv2-data-fetch-and-session-continuity). |

Whatever the flag says, `person-page.js` fetches the family-tree SVG through `dataFetch` with `credentials: "same-origin"`, no header and `interactive: false`.

When the private data gate is attached, a Lambda@Edge function checks the `io_id` cookie on `/person/*.json`, `/family/*`, `/event/*`, `/note/*`, `/place/*` and `/media/*`, and ignores `X-HFY-Session`. Only the `authV2` path can then read person data. The gate is described in [the privacy model for family data](../explanation/family-data-privacy.md#gating-the-json), and the order of the switch in [Cut over to authV2 and the private data gate](../how-to/cut-over-to-the-private-data-gate.md).

### Script order on the rendered pages

Page-specific scripts (`person-page.js`, `search-results.js`) sit inside the page body and run first. The shared footer then runs, in this order:

1. The inline `window.HFY_FEATURE_FLAGS` block.
2. `/js/auth-v2.js`, with `defer`.
3. `/js/feature-flags.js`, which defines `window.HFYFeatureFlags`.
4. The inline `window.HFY_AUTH_CONFIG` block.
5. The Google Identity Services client, with `async defer`.
6. `/js/auth.js`.
7. The inline `window.HFY_SEARCH_CONFIG` block.
8. `/js/bootstrap.bundle.min.js`.
9. `/js/search-navbar.js`.

## Feature flags

### Build-time values

[`11ty/_data/flags.json`](../../11ty/_data/flags.json) is served at `/_data/flags.json`. It defines six flags: `authV2`, `notifyV2`, `personV2`, `postsV2`, `searchV2` and `shellV2`. All six are `false`.

`resolveFlags()` fetches the file with `cache: "no-store"`, once per page load. A network error, a non-2xx status or a body that is not JSON all produce an empty object. Every build-time flag then reads as off, and only the override can turn a flag on. A flag is on only when its merged value is exactly `true`.

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
- **Banner.** While an override is active, the page shows a fixed "Preview flags on — turn off" banner at the bottom left (raised above the shell's bottom bar when `shellV2` is on). Its button clears the override and reloads the page without the `hfy_flags` parameter. The banner carries `data-hfy-keep`, so the shell island leaves it in `<body>`.
- **Automatic clearing.** The override is cleared, and the banner removed, when a flagged dependency is unavailable: an island bundle fails to load, or `/auth/session` does not answer for `authV2`. The page then falls back to the legacy behavior, and a console warning names the dependency (`preview flags turned off: <what> unavailable`).
- **Old storage.** Builds before HFY-R58 kept the override in `localStorage` with no expiry. Every page load deletes `localStorage["hfy:flags"]`.
- If `sessionStorage` cannot be used, the `hfy_flags` parameter applies to the current page only.

[`feature-flags.js`](../../11ty/js/feature-flags.js) merges the flags in this order:

1. The build-time values from `/_data/flags.json`.
2. The override. It wins in both directions.
3. HFY-R48: if the merged `searchV2` is `true`, `shellV2` becomes `true` unless the override contains `-shellV2`. A build-time `shellV2: false` does not prevent this.

The legacy search scripts do not read the override. `search-navbar.js` and `search-results.js` always wire their handlers. Before each data load they call `HFYFeatureFlags.searchV2Live()`, and they stand down only when it resolves `true`: `searchV2` is on and the replacement (the shell's launcher for the navbar, the search island for `/search/`) has actually loaded. A missing or failed island therefore leaves the legacy search working.

### What each flag does

| Flag | `<html>` class | Pages | Loads | Navigation change | If the island fails to load |
|---|---|---|---|---|---|
| `shellV2` | `hfy-shell-v2`. The island also adds `io-no-focus-zoom`. | Every page that loads `feature-flags.js`: the ten rendered pages, `/posts/` and `/me/notifications/` | The `shell` island. Once it has loaded, the loader appends `<link rel="manifest" href="/manifest.webmanifest">` and `<meta name="theme-color" content="#12384f">`. | The kit shell bar replaces the Bootstrap navbar, which `shell.css` hides (`nav.navbar-hf`). Links: Home `/`, Family `/private/`, Posts `/posts/`, Me `/family-login/`. | The loader removes `hfy-shell-v2`, so the legacy navbar shows again. No manifest link or theme color is added. |
| `searchV2` | `hfy-search-v2`, plus an injected style rule that hides `[data-search-page]` | Only `/search` and `/search/`, where the island loads. | The `search` island. The flag also turns `shellV2` on. | The shell's search launcher offers local suggestions from the people corpus. The legacy navbar search stands down once the shell has loaded. | The loader removes the `hidden` attribute from the legacy section, the class and the style rule. The legacy scripts have not stood down, so the restored section loads results. |
| `personV2` | None | `/person/?id=<gramps_id>` | The `person` island | None | No handler is needed, because the legacy notes stay in place. |
| `postsV2` | None | `/person/?id=<gramps_id>`; `/` and `/index.html`; `/posts/` | `my-posts`, `timeline` and `posts` respectively | None | No handler. The page stays as it was, and `/posts/` keeps its "Family posts are loading" placeholder. |
| `notifyV2` | None | `/me/notifications` and `/me/notifications/` | The `notifications` island | Shell "Me" links to `/me/notifications/`. This applies only while `shellV2` is on. | The page keeps its "Notification settings are not enabled yet." text. |
| `authV2` | None | The ten rendered pages, through [`auth-v2.js`](../../11ty/js/auth-v2.js). The data path applies on every page that fetches person data. | No island. `auth-v2.js` probes the session with `HFYFeatureFlags.edgeSession()`, one `GET /auth/session` that may refresh once. On `/family-login/`, a visitor still signed out after that probe is redirected to `/auth/login?returnTo=%2F`. Person-data requests send the `io_id` cookie through `HFYFeatureFlags.dataFetch` instead of `X-HFY-Session`. | When the edge session has `authenticated: true` and a `sub`, the [edge overlay](#edge-overlay) shows the navbar search, "My Record" (linked to `/person/?id=<sub>`) and the sign-out item, and hides the sign-in item. See [`auth-v2.js` behavior](#auth-v2js-behavior). | If `/auth/session` does not answer with a JSON body whose `authenticated` is a boolean, `auth-v2.js` clears the preview override and changes nothing, so the legacy sign-in runs. Flags already resolved on the page do not change, so its data requests still use the cookie. |

The loader also clears the preview override whenever an island fails to load (see [Runtime override](#runtime-override-preview-flags)).

### `auth-v2.js` behavior

[`11ty/js/auth-v2.js`](../../11ty/js/auth-v2.js) does nothing unless the merged `authV2` is `true`. It reads the flag through `HFYFeatureFlags.resolveFlags()`, or from `/_data/flags.json` when that function is missing. With it on:

| Situation | What the script does |
|---|---|
| Every page | Probes the session with `HFYFeatureFlags.edgeSession()`. That is the page's one `GET /auth/session`, shared with the search scripts and the data fetches, and it may refresh once first (see [authV2 data fetch and session continuity](#authv2-data-fetch-and-session-continuity)). If `edgeSession` is missing, the script sends its own `GET /auth/session` (same-origin, `no-store`), with no refresh. |
| `/auth/session` unreachable, or not a JSON body with a boolean `authenticated` (edge not attached, network error, an HTML error page) | Calls `HFYFeatureFlags.flagUnavailable("/auth/session")`, which drops any preview override, and leaves the page to the legacy flow. |
| On `/family-login/`, signed out at the edge after the probe | `location.replace("/auth/login?returnTo=%2F")`. |
| On `/family-login/`, already signed in at the edge | No redirect. The page keeps the legacy Google sign-in rather than sending the visitor back to `/auth/login` in a loop. The signed-in navigation below still applies. |
| Signed in at the edge (`authenticated: true` and a `sub`), any page | Points `[data-my-record-link]` at `/person/?id=<sub>` and shows its list item, hides `familyLoginLink` and shows `logoutLink`. It applies this again at `load` and 600 ms later, because the legacy scripts toggle the same items. `edgeSession()` has already set the [edge overlay](#edge-overlay), which keeps `navbarSearch`, `myRecordLink` and `logoutLink` shown whenever `feature-flags.js` re-applies visibility. The script then wires the sign-out links. |
| Click on any `[data-auth-signout-link]`. The handler is wired only when the visitor is signed in at the edge. | Runs in the capture phase, prevents the default and stops other handlers. Clears the legacy credentials at once: `localStorage` keys `HFY_AUTH_ID_TOKEN`, `HFY_AUTH_USER_GRAMPS_ID` and `hfy:edge-session`, `sessionStorage` key `HFY_GATEWAY_SESSION_V1`, and Google auto-select (`google.accounts.id.disableAutoSelect()`). Calls `HFYFeatureFlags.forgetEdgeSession()`, which drops the edge overlay. Sends `POST /auth/logout` with `keepalive`, `X-Requested-With: io-kit` and body `{}`, and waits for it for at most 4 s. Then runs the legacy `HFY_AUTH.signOut()`, or goes to `/logged-out/` when that is not on the page. |

The script's header comment gives a different reason for the `/family-login/` case. See [Discrepancies](#discrepancies).

Flags gate UI, with one exception: `authV2` also selects the credential that person-data requests carry, the `io_id` cookie instead of `X-HFY-Session`. No server code reads a flag: nothing in `api/src/`, `auth/src/`, `edge-gate/src/` or `lambda/` refers to `flags.json` or to a flag name. The API, the auth edge and the data gate answer whatever the flags say, so every flagged surface must still authenticate its own data calls. See [What a flag does not protect](../explanation/release-model.md#what-a-flag-does-not-protect). Once the data gate is attached, a client with `authV2` off sends only `X-HFY-Session`, which the gate ignores, so it cannot read person data. That is why the cutover turns `authV2` on before it attaches the gate ([Cut over to authV2 and the private data gate](../how-to/cut-over-to-the-private-data-gate.md)).

To change a flag, follow [toggle a feature flag](../how-to/toggle-a-feature-flag.md).

## `window.HFYFeatureFlags`

[`11ty/js/feature-flags.js`](../../11ty/js/feature-flags.js) defines this object. The script loads synchronously. On the rendered pages it runs after the inline `window.HFY_FEATURE_FLAGS` block.

| Member | What it does |
|---|---|
| `config` | The inlined `window.HFY_FEATURE_FLAGS` object. On pages without one (`/posts/`, `/me/notifications/`) it is `{}`. |
| `getState()` | Returns a copy of the legacy session state: `loggedIn`, `sessionToken`, `userGrampsID`, `hasRecord`, `sessionExpiresAt`, `verifying` and `verifiedAt`. The edge overlay is not included. |
| `getUserGrampsID()` | The Gramps ID in the legacy state, or `null`. The edge overlay is not consulted. |
| `updateState(partial)` | Merges `partial` into the legacy state, then re-applies visibility. An explicit `sessionToken: null` also clears the session cache. |
| `shouldShow(key, overrides)` | Evaluates component `key`'s `showWhen` rules against the legacy state, with the edge overlay laid over it when set, merged with `overrides`. |
| `refresh()` | Re-applies visibility to every `[data-feature]` element, using the legacy state with the edge overlay laid over it. |
| `acceptSession(payload)` | Accepts a gateway payload of `{sessionToken, grampsId?, expiresAt? or expiresIn?}`, stores it and re-applies visibility. Returns `false` when `sessionToken` is missing. |
| `verifySession({ googleIdToken })` | POSTs `{id_token, context}` to `config.gateway.endpoint` with credentials. It succeeds only when the response contains both `allowed` and `sessionToken`. Otherwise it clears the session. Returns the payload, or `false`. |
| `requireSessionToken()` | Returns the legacy session token. Returns `null` when there is no token or the token has expired, and clears an expired token. |
| `resolveFlags()` | Returns a promise of the merged flags. It is memoized: the first call fetches, and every later call returns the same promise. A change to `flags.json` or to the override therefore takes effect on the next page load. |
| `loadIsland(name, { onError, onLoad })` | Appends `<link rel="stylesheet" href="/js/islands/<name>.css">` and `<script type="module" src="/js/islands/<name>.js">` to `<head>`, once per name. Returns the script element. |
| `whenIsland(name)` | Resolves `true` once the named island has loaded and run, and `false` if it failed or was never requested on this page. |
| `searchV2Live(part)` | Resolves `true` only when `searchV2` is on and the replacement has loaded: `"page"` waits for the `search` island, `"launcher"` for the `shell` island. The legacy search scripts call it before each data load. |
| `overrideActive()` | Whether a preview override is in effect on this page. |
| `clearOverride(reason)` | Removes the override from `sessionStorage` (and any old `localStorage` copy), removes the banner, and logs `reason` when given. The current page keeps the flags it has already resolved. |
| `flagUnavailable(what)` | Calls `clearOverride` when an override is active. The loader calls it when an island fails, and `auth-v2.js` when `/auth/session` does not answer. |
| `dataFetchInit()` | Resolves `{credentials: "same-origin"}` when the merged `authV2` is `true`, and `null` otherwise. Callers use it to choose between the cookie and the legacy `X-HFY-Session` request. |
| `dataFetch(url, init, { interactive })` | Resolves the `Response` for a person-data request. With `authV2` off it is exactly `fetch(url, init)`. With it on, it fetches with `credentials: "same-origin"` after the page's preflight, refreshes and retries once on a 401, and, for an interactive load, sends the visitor to sign in when that fails. `interactive` defaults to `true`, and only `interactive: false` marks a background load. |
| `dataResponse(response)` | Deprecated, kept for callers from before HFY-R66. Nothing in the repository calls it. Once `dataFetchInit` or `dataFetch` has seen `authV2` on this page, a 401 takes the guarded sign-in redirect and an `ok` response clears the redirect guard. It cannot retry. Returns `response`. |
| `edgeSession()` | Resolves the page's `/auth/session` answer: `{authenticated: true, sub, grampsId, label}`, plus `exp` when the token has one, or `{authenticated: false}`. Resolves `null` when `authV2` is off, or when `/auth/session` does not answer with a JSON body whose `authenticated` is a boolean. Memoized per page, and may refresh once first. An authenticated answer with a `sub` sets the edge overlay and `localStorage["hfy:edge-session"]`. |
| `forgetEdgeSession()` | Removes `localStorage["hfy:edge-session"]`, drops the edge overlay and re-applies visibility. `auth-v2.js` calls it on sign-out. |
| `signInUrl()` | Returns `/auth/login?returnTo=` followed by the current path, query and hash, URL-encoded. |

How `loadIsland` behaves:

- A second call with the same name adds nothing and returns the first script element. The callbacks passed to that second call are ignored.
- The stylesheet link is added even when the island has no CSS. Every current island imports CSS, so each build produces a `<name>.css`. A future island without CSS would make the page request a stylesheet that does not exist.
- On the script's `load` event, the island's `whenIsland` promise resolves `true` and `onLoad` runs.
- On the script's `error` event, the promise resolves `false`, the stylesheet link is removed, `flagUnavailable` clears any preview override, and `onError` runs. That event fires when the module, or a chunk it imports, cannot be fetched or parsed. An exception thrown while the island runs does not trigger it.

The flag handlers are three separate `resolveFlags().then(...)` callbacks. The first handles `personV2`, `postsV2` and `shellV2`, the second handles `searchV2`, and the third handles `notifyV2`.

### authV2 data fetch and session continuity

HFY-R66. The data gate checks `io_id`, which lives 3600 s. The longer-lived, HttpOnly `io_rt` refresh cookie lets `POST /auth/refresh` set a new `io_id`, and once `io_rt` is gone the refresh answers 401 ([Identity services: Cookies](identity-services.md#cookies)). `feature-flags.js` uses the refresh so that a member whose `io_id` has lapsed keeps reading data without signing in again, and so that no page loops through sign-in. With `authV2` off none of this runs: `edgeSession()` resolves `null`, and `dataFetch()` is exactly `fetch(url, init)`.

| Mechanism | Behavior |
|---|---|
| Session probe | `edgeSession()` sends one `GET /auth/session` per page (`credentials: "same-origin"`, `cache: "no-store"`), shared by `auth-v2.js`, the search scripts and the data fetches. A session counts as usable when it is authenticated and its `exp` is more than 120 s away, or it has no `exp`. An authenticated session near expiry is refreshed once and asked again. A signed-out answer is refreshed only when `localStorage["hfy:edge-session"]` is `"1"`, meaning this browser has had an edge session, so an anonymous visitor on a public page causes no refresh. After a successful refresh the page asks `/auth/session` once more. |
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
| [`person-page.js`](../../11ty/js/person-page.js) | `/person/<gramps_id>.json` | Interactive | The visitor is sent to sign in. If the bounce guard skips that, the page shows "Your sign-in has expired. Sign in again to view this record.", where "Sign in again" links to `signInUrl()`. |
| `person-page.js` | The family-tree SVG | Background | The tree area shows "Unable to load family tree visualization." The record stays. |
| [`search-results.js`](../../11ty/js/search-results.js) | `/person/index.json`, `/person/search-index.json` | Interactive, including the load it starts when `edgeSession()` reports an authenticated session | The status line shows "Unable to load search data. Please try again later." |
| [`search-navbar.js`](../../11ty/js/search-navbar.js) | The same two files | Interactive when a typed query starts the load. Background for the preloads: on focus, and the eager preload that starts when `edgeSession()` reports an authenticated session. | No suggestions. A preload never redirects. |
| [`person` island](../../islands/src/islands/person.jsx) | `/person/<gramps_id>.json` | Background | The legacy notes stay. The island never redirects. |
| [`people-corpus.js`](../../islands/src/lib/people-corpus.js) (search island, shell launcher) | The two index files | Interactive. It passes no options. | The corpus load fails. |

Under `authV2`, the search scripts' preloads follow the edge session, not the legacy `HFY_AUTH` state. A legacy Google token left in `localStorage` by an earlier sign-in therefore starts no data request.

## Legacy component gating

The first part of `feature-flags.js` predates E5. It shows or hides navigation elements according to sign-in state, and it holds the legacy gateway session. One newer piece sits in this part: the [edge overlay](#edge-overlay) (HFY-R66).

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
| `gateway.endpoint` | `/api/check-allowed` | The legacy allowlist check that `verifySession` calls. See [identity services](identity-services.md). |
| `gateway.context` | `site` | Sent as `context` in the verify request. |
| `gateway.enforceAssets` | `true` | With `authV2` off, search must have a session token before it requests the person index files. |
| `gateway.debug` | `false` | Rendered, but no script reads it. |
| `components` | Four entries, listed below | Visibility rules for `[data-feature]` elements. |

| Component | Shown when | Elements |
|---|---|---|
| `navbarSearch` | `loggedIn` is `true` | The navbar search wrapper. Its `assets` list (the person manifest and the search index) is descriptive only, and no script reads it. |
| `familyLoginLink` | `loggedIn` is `false`, unknown or `null` | The navbar sign-in item and the homepage "Family Login" button. |
| `logoutLink` | `loggedIn` is `true` | The navbar sign-out item. |
| `myRecordLink` | `loggedIn` and `hasRecord` are both `true` | The navbar "My Record" item. |

Visibility rules:

- An element is shown when its key has no component entry or the entry has no `showWhen`.
- Otherwise, every `showWhen` condition must match. The conditions are checked against the legacy state, with the edge overlay laid over it when set. Values are compared as strings, and a missing state value compares as `"unknown"`.
- A hidden element gets the `d-none` class, `aria-hidden="true"` and the `hidden` attribute. A shown element loses all three.
- Every gated element also gets `data-feature-visible`, set to `"true"` or `"false"`.
- Visibility is applied at `DOMContentLoaded` and again after every state change, and again when the edge overlay is set or dropped.

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

When the page's hostname is `harrisonfamily.us` and `gateway.enforceAssets` is not `true`, `feature-flags.js` logs a console error and sets it to `true`. `/posts/` and `/me/notifications/` have no inlined config, so on the production host the error is logged on every load of those pages. There, the forced value is set on a detached object, and `config.gateway` stays undefined.

The token waits and the `/family-login/` redirect below apply only with `authV2` off. With `enforceAssets` on, the legacy search scripts wait up to 8 seconds for a session token before they request the person index files, and fail if none arrives. The search island's people corpus also waits up to 8 seconds. If no token arrives, it redirects to `/family-login/?next=<path>`.

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
- The entry is removed when the gateway denies access, when verification fails, on `updateState({ sessionToken: null })`, and when `requireSessionToken` finds the token expired. The `auth-v2.js` sign-out also removes it.
- `sessionStorage` is scoped to one tab, so a new tab starts without the cached token.

## Islands

### Catalog

| Island | Flag | Page | Host element | Data sources | Fallback |
|---|---|---|---|---|---|
| [`shell`](../../islands/src/islands/shell.jsx) | `shellV2`, or `searchV2` through HFY-R48 | Every page that loads `feature-flags.js` | Creates `#hfy-shell-root` as the first child of `<body>`. It then moves the rest of the body, except `<script>`, `<noscript>` and elements marked `data-hfy-keep` (the preview banner), into its scrolling `<main>`. | `resolveFlags()` for `searchV2` and `notifyV2`. With `searchV2` on, the people corpus (`/person/index.json` and `/person/search-index.json`) supplies suggestions. Its requests send `X-HFY-Session` with `authV2` off and the `io_id` cookie with it on. | The loader removes `hfy-shell-v2`. |
| [`search`](../../islands/src/islands/search.jsx) | `searchV2` | `/search`, `/search/` | `#hfy-search-v2`, prepended to `<main>` | `/person/index.json` and `/person/search-index.json`, through `dataFetch`. With `authV2` off they carry `X-HFY-Session` and `credentials: "include"`, and with it on the `io_id` cookie only. The corpus is held in memory only. | The loader un-hides the legacy section, which then loads results. |
| [`person`](../../islands/src/islands/person.jsx) | `personV2` | `/person/?id=<gramps_id>` | Waits until `#person-content` is visible and contains `.notes-panel`. It then replaces the notes with `#hfy-notes-v2` and appends `#hfy-person-comments` to the `.col-lg-8` column. | `/person/<gramps_id>.json`, through `dataFetch` with `interactive: false`: `X-HFY-Session` with `authV2` off, the `io_id` cookie with it on. Also `/api/comments` for subject `person:<gramps_id>`, and `/auth/session`. | None. If the JSON fetch fails or the person has no notes, the legacy notes stay. The island never redirects to sign-in. |
| [`my-posts`](../../islands/src/islands/my-posts.jsx) | `postsV2` | `/person/?id=<gramps_id>` | `#hfy-my-posts`, inserted after `.notes-panel`. It renders only when the `sub` from `/auth/session` equals `<gramps_id>`. | `/auth/session`; `GET /api/posts?subject=<gramps_id>`; `POST /api/posts`; `POST /api/uploads`, then a `PUT` to the presigned URL | None |
| [`timeline`](../../islands/src/islands/timeline.jsx) | `postsV2` | `/`, `/index.html` | `#hfy-timeline`, appended to `<main>` | `GET /api/posts` (published, 20 per page, by cursor) | None |
| [`posts`](../../islands/src/islands/posts.jsx) | `postsV2` | `/posts/`; `?id=<ulid>` shows one post | `[data-island="posts"]`. Rendering replaces the placeholder text. | `GET /api/posts`; `GET /api/posts/<ulid>`; `/api/comments` for subject `post:<ulid>`; `/auth/session` | None. The placeholder stays. |
| [`notifications`](../../islands/src/islands/notifications.jsx) | `notifyV2` | `/me/notifications/` | `[data-island="notifications"]`. It removes `[data-notify-off]`. | The `@io-kit/notify` client on `/api`, sent with credentials: `/api/notifications/preferences`, `/api/notifications/subscribe` and `/api/notifications/vapid-public-key` | The "not enabled yet" text stays. |

Every `/api` call is same-origin and uses `credentials: "include"`, so it carries the auth-edge session cookie. Routes are described in the [API reference](api.md), and `/auth/session` in [identity services](identity-services.md). The islands' own `/auth/session` calls go through `getSession()` in `api.js`, separately from `HFYFeatureFlags.edgeSession()`, and never refresh.

Per-island details:

- **shell.** The navigation registry has four entries: Home, Family, Posts and Me. An install prompt appears when the browser offers installation, or on iOS, where it shows Add to Home Screen instructions instead of an Install button. It does not appear once the app is installed or running standalone, or after a dismissal, which it remembers in `localStorage["hfy:install-dismissed"]`. The shell also registers `/sw.js` (see [Service worker](#service-worker)).
- **search.** Reads the query from `?q=` or `?query=`, and focuses the input when `?focus=1` is present. It shows 30 results per page, with a load-more button. Each result links to `/person/?id=<gramps_id>`.
- **person.** Renders notes through `@io-kit/md` with the comments package's `userContentPolicy`.
- **my-posts.** The composer accepts JPEG, PNG, WebP and HEIC images, up to four attachments per post.
- **notifications.** Covers four types: `comment_on_my_record`, `reply_to_me`, `new_family_post` and `mention`. Each type has two detail levels, `generic` (the default, content-free) and `detailed` (may name the actor). A push nudge remembers its dismissal under `hfy:notify-nudge`. On iOS outside standalone mode, the page also shows Add to Home Screen steps.

### Shared libraries

All files are in [`islands/src/lib/`](../../islands/src/lib/).

| File | Exports | Behavior |
|---|---|---|
| [`mount.jsx`](../../islands/src/lib/mount.jsx) | `mountIsland(name, Component)`, `mountAt(place, node, id)` | `mountIsland` renders into every `[data-island="<name>"]` element and replaces its content. Props come from the element's `data-props` JSON, and invalid JSON means no props. `mountAt` creates a `div` with the given `id`, lets `place` insert it, renders into it and returns it. |
| [`api.js`](../../islands/src/lib/api.js) | `createApi`, `api`, `ApiError`, `getSession` | `createApi({ base = "/api", fetchImpl })` returns `request`, `get`, `post`, `patch` and `del`. Requests and responses are JSON, with `credentials: "include"`. Empty query values are dropped, and a 204 returns `undefined`. A failed response throws `ApiError(status, code, message, field)`. The `code` comes from the body's `error`, or else from the status: 401 `unauthenticated`, 403 `forbidden`, 404 `not_found`, 400 or 422 `validation`, anything else `server`. A network failure throws with status 0 and code `network`. `getSession()` calls `GET /auth/session` and returns `{authenticated, sub, label}`. It never throws: any failure returns signed-out. |
| [`content-source.js`](../../islands/src/lib/content-source.js) | `CAPABILITIES`, `createHfyContentSource(api)` | The `@io-kit/content` source over `/api/posts`. Capabilities: `drafts: false`, and `edit`, `subject`, `getById` and `audit` all `true`. `createDraft` publishes at once (`visibility: "published"`) and rejects `visibility: "draft"`. `setVisibility` always rejects, and every post's `can.publish` is forced to `false`. `ApiError` maps to `ContentError`, with `unauthenticated` becoming `forbidden`. |
| [`comment-source.js`](../../islands/src/lib/comment-source.js) | `createHfyCommentSource(api, { onList })` | The `@io-kit/comments` source over `/api/comments`. The thread ID is the subject. It supports list, create, edit, delete and react, and reactions are allowed only on `comment:` targets. The server computes each comment's `can.*`. `onList` receives every loaded page of comments. |
| [`comments-ui.jsx`](../../islands/src/lib/comments-ui.jsx) | `Comments({ subject })`, `linkify` | The comments thread for `person:<gramps_id>` or `post:<ulid>`. Signed out, the thread is read-only and shows a "Sign in to comment" link to `/auth/login?returnTo=<path and query>`. Moderator inference: the API exposes no roles, so the client gives the viewer the `admin` role when any loaded comment by someone else has `can.delete`. The server still decides each action. Mentions: record IDs (`I` followed by four or more digits) link to `/person/?id=`. |
| [`posts-ui.jsx`](../../islands/src/lib/posts-ui.jsx) | `source`, `postHref`, `Banner`, `Skeletons`, `usePosts`, `PostList` | `usePosts(filter)` loads published posts newest first, 20 per page by cursor, and drops duplicates. It returns `more`, `reload`, `remove` and `prepend`. `PostList` shows a delete action when `can.delete` is true, a "View post and comments" link to `/posts/?id=<ulid>`, and a "Load older posts" button. |
| [`upload.js`](../../islands/src/lib/upload.js) | `uploadPhoto(api, file)` | Sends `POST /api/uploads` with `{filename, contentType, size}`, then `PUT`s the bytes to the returned `uploadUrl`. Returns `{kind: "image", url: publicUrl, mime}`. |
| [`people-corpus.js`](../../islands/src/lib/people-corpus.js) | `peopleSource`, `peopleProperties`, `mapPerson`, `suggestPeople` | The local-only people corpus used by the search island and the shell launcher. It seeds from the person manifest and the search index through `HFYFeatureFlags.dataFetch`, as an interactive load. With `authV2` off it sends the gateway token, waiting for it as described under [`enforceAssets`](#enforceassets-on-the-production-host). With `authV2` on it sends the `io_id` cookie and does not wait. Facets: surname, given name, birth year, death year, living and has photo. `suggestPeople` returns up to six suggestions. |

### Island build

[`islands/build.mjs`](../../islands/build.mjs) runs esbuild with these settings:

| Setting | Value |
|---|---|
| Entry points | Every `.js` and `.jsx` file in `islands/src/islands/` |
| Output directory | `11ty/js/islands/`, deleted before each build. The directory is committed (HFY-R58). |
| Bundling | `bundle: true`, `splitting: true`, `format: "esm"` |
| Targets | `es2020`, `safari15` |
| JSX | Automatic runtime |
| Minification | On, with no source maps |
| Chunk names | `chunks/[name]-[hash]` |
| Defines | `process.env.NODE_ENV` set to `"production"` |
| CSS | CSS imported by an entry is bundled into `<name>.css` |
| After the build | Copies `node_modules/@io-kit/notify/sw/notify-sw.js` to `11ty/js/islands/notify-sw.js` |

`node build.mjs --check` (the `check:islands` script) builds the same entries in memory, without writing, and compares the result, plus `notify-sw.js`, byte for byte with the files in `11ty/js/islands/`. It ignores `.DS_Store`.

| Result | Output | Exit |
|---|---|---|
| Every file matches | `11ty/js/islands is up to date (<n> files)` | 0 |
| A file is absent, differs or is not produced by the build | A line that starts `11ty/js/islands is out of date with islands/src` and asks you to run `npm run build` and commit, then one `missing <file>`, `stale <file>` or `extra <file>` line per problem | 1 |

The output layout:

```text
11ty/js/islands/
  <name>.js                  one per island
  <name>.css                 one per island that imports CSS (currently all of them)
  chunks/<name>-<hash>.js    shared code (React, @io-kit/*); content hash, changes when that code changes
  notify-sw.js               imported by /sw.js
```

[`islands/package.json`](../../islands/package.json) pins every dependency to an exact version. The lockfile `islands/package-lock.json` is committed, and the package requires Node 22 or later.

| Package | Version |
|---|---|
| `@io-kit/comments` | 0.1.0 |
| `@io-kit/content` | 0.1.1 |
| `@io-kit/md` | 1.2.0 |
| `@io-kit/notify` | 0.4.0 |
| `@io-kit/search` | 1.0.1 |
| `@io-kit/search-ui` | 1.0.8 |
| `@io-kit/shell` | 0.6.6 |
| `@io-kit/tokens` | 0.4.0 |
| `react`, `react-dom` | 19.3.0 |
| `esbuild` | 0.28.2 |
| `@playwright/test` | 1.64.0 |
| `http-server` (dev) | 14.1.1 |

Its scripts are `build` and `build:islands`, which both run `node build.mjs`; `check:islands`, which runs `node build.mjs --check`; `test`, which runs the `node:test` tests and then Playwright; and `test:contract`, which runs the `node:test` tests only. Those include `bundle.test.mjs`, which fails when the committed bundles are missing, gitignored or stale.

[`islands/.npmrc`](../../islands/.npmrc) maps the `@io-kit` scope to the `io-kit` npm repository in AWS CodeArtifact (domain `io`, `us-west-2`, account `<aws-account-id>`). It reads the auth token from `${CODEARTIFACT_AUTH_TOKEN}`, so the token is never committed. `aws codeartifact get-authorization-token --domain io` issues one. Without it, `npm ci` cannot fetch the `@io-kit` packages.

[`scripts/ci/build-islands.sh`](../../scripts/ci/build-islands.sh) runs these steps:

1. Fails immediately if `CODEARTIFACT_AUTH_TOKEN` is unset. It never prints the token.
2. Runs `npm ci --ignore-scripts --no-audit --no-fund` in `islands/`, with output silenced.
3. Runs `npm run build:islands`.
4. Asserts that `11ty/js/islands/shell.js` and `11ty/js/islands/shell.css` exist and are non-empty. It checks no other output.

No workflow runs the script, `check:islands` or the island tests. The committed bundles ship with the `11ty/` sync, which runs with `--delete` and does not exclude `js/islands/`, so a bundle that is not committed is removed from the bucket by the next deploy. See [repository operations](repository-operations.md#what-no-workflow-ships-or-runs), and for the rebuild, [build and preview the islands](../how-to/build-and-preview-the-islands.md).

## Service worker

[`11ty/sw.js`](../../11ty/sw.js):

| Aspect | Behavior |
|---|---|
| Cache name | `hfy-shell-v2`. The version is bumped whenever the caching strategy changes, and activation deletes every other cache. |
| Precache | `/offline.html`, `/js/islands/shell.js`, `/js/islands/shell.css`, `/manifest.webmanifest` and `/images/pwa-192.png`. Each is added on its own and failures are ignored, so install succeeds even when the bundles are missing. |
| Imports | `importScripts("/js/islands/notify-sw.js")` inside `try`/`catch`. This adds push handling and notification-click deep links from `@io-kit/notify`, and is skipped silently when the file is absent. |
| Activate | Deletes every other cache, then claims open clients. |
| Message | `"SKIP_WAITING"` or `{type: "SKIP_WAITING"}` calls `skipWaiting()`. No code in the repository sends this message. |
| Fetch: ignored | Non-GET requests, cross-origin requests, and `/auth`, `/api` and every path below them. |
| Fetch: navigations | Network first. On a network failure the worker answers with the cached `/offline.html`. HTTP error responses pass through unchanged. |
| Fetch: `/js/islands/chunks/*` | Cache first. Chunk names carry a content hash, so a cached chunk never goes stale. A miss is fetched and, when the response is a same-origin `200`, stored for offline use. |
| Fetch: other `/js/islands/*` and the precached paths | Network first, storing each same-origin `200` in the cache. After a deploy, an entry module therefore always matches the chunk hashes on the server. The cached copy is used only when the network fails. |
| Fetch: other GETs | Not handled. The browser's default applies. |
| Registration | Only the shell island registers the worker, with `navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" })`, and it ignores errors. Nothing unregisters it. With `shellV2` off, new visitors never get the worker, but a browser that already registered it keeps it. |
| Caching headers | The file's header comment asks for `Cache-Control: no-cache`. The deploy's `aws s3 sync` uploads it without a `Cache-Control` value, and no other script sets one. `updateViaCache: "none"` makes the browser skip its HTTP cache on update checks. CloudFront caching follows the distribution's settings until the deploy's `/*` invalidation. |

## Web app manifest and offline page

[`11ty/manifest.webmanifest`](../../11ty/manifest.webmanifest):

| Field | Value |
|---|---|
| `name` | `Harrison Family Heritage` |
| `short_name` | `Harrison Family` |
| `start_url`, `scope` | `/` |
| `display` | `standalone` |
| `background_color`, `theme_color` | `#12384f` |

| Icon | Size | Purpose |
|---|---|---|
| `/images/pwa-192.png` | 192 × 192 | `any` |
| `/images/pwa-512.png` | 512 × 512 | `any` |
| `/images/pwa-maskable-512.png` | 512 × 512 | `maskable` |

No page links the manifest statically. The loader appends the manifest link, and the `theme-color` meta, only after the shell island has loaded (HFY-R58), so a failed shell leaves the page without them.

[`11ty/offline.html`](../../11ty/offline.html) is a self-contained page with inline styles and no scripts. It says the visitor is offline and links to `/`. The service worker serves it when a page navigation fails at the network level.

## Tests

| Suite | What it checks | How it runs |
|---|---|---|
| [`tests/client/data-fetch.test.mjs`](../../tests/client/data-fetch.test.mjs) | Loads the real `feature-flags.js` into a `node:vm` sandbox with a stubbed browser. Checks `dataFetchInit()` with `authV2` off, on and turned on by the `?hfy_flags=authV2` override, and the deprecated `dataResponse` redirect. Then reads the sources to check that `person-page.js`, the two search scripts, the `person` island and `people-corpus.js` take the `authV2` path before they build any `X-HFY-Session` request, and fetch data through `dataFetch`. | `node --test tests/client/*.test.mjs` from the repository root. It needs no install. |
| [`tests/client/auth-continuity.test.mjs`](../../tests/client/auth-continuity.test.mjs) | The same sandbox with a routed `fetch` stub that records every request. Covers flag-off parity, one `/auth/session` per page, the preflight refresh, the single-flight refresh with one retry on a 401, interactive and background loads after a failed refresh, the bounce guard, a refresh that does not cure the 401, the `hfy:edge-session` marker, the edge overlay, and `auth-v2.js` probing through `edgeSession`. | The same command. |
| [`islands/tests/auth-continuity.spec.mjs`](../../islands/tests/auth-continuity.spec.mjs) | Playwright against the committed `11ty/` pages served locally. Route interception stubs `/auth/session`, `/auth/refresh`, `/auth/login`, `/api` and the person data files, with synthetic data. The stubbed gate is open, closed, or lapsed (401 until a refresh succeeds). Covers the hourly lapse on the person page, a 401 mid-session, a refresh token that is gone (one trip to sign-in, then the sign-in link), the search-island corpus and `person`-island notes over a lapsed session, public pages with stale or lapsed sessions, navigation after an edge-only sign-in, and flag-off parity. | `npm test` in `islands/`, which runs the contract tests and then Playwright. |

No workflow runs these suites. See [Run the tests](../how-to/run-the-tests.md).

## Discrepancies

These are differences between the code and its comments, as of this page.

- **`auth-v2.js` and `/family-login/`.** The script's header comment says a visitor already signed in at the edge keeps the legacy sign-in on `/family-login/` because the edge session does not mint the legacy `X-HFY-Session` token that the person and search pages need. Under `authV2` those pages no longer use that token: they send the `io_id` cookie through `HFYFeatureFlags.dataFetch`. The branch still prevents a redirect loop back to `/auth/login`, which is the reason the inline comment at that branch gives.

## Related pages

- [Why React islands on a generated Eleventy site](../explanation/islands-on-eleventy.md)
- [The release model](../explanation/release-model.md)
- [The privacy model for family data](../explanation/family-data-privacy.md)
- [The identity model](../explanation/identity-model.md)
- [Edge and origin design](../explanation/edge-and-origin-design.md)
- [Codebase map](codebase-map.md)
- [API](api.md)
- [Identity services](identity-services.md)
- [Private data and secrets](private-data-and-secrets.md)
- [Repository operations](repository-operations.md)
- [Toggle a feature flag](../how-to/toggle-a-feature-flag.md)
- [Cut over to authV2 and the private data gate](../how-to/cut-over-to-the-private-data-gate.md)
- [Diagnose sign-in and API failures](../how-to/diagnose-sign-in-and-api-failures.md)
- [Build and preview the islands](../how-to/build-and-preview-the-islands.md)
- [Refresh the Eleventy output](../how-to/refresh-the-eleventy-output.md)
- [Deploy a site change](../how-to/deploy-a-site-change.md)
- [Run the tests](../how-to/run-the-tests.md)
