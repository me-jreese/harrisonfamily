# Codebase map

Reference for where each capability lives in the repository, and for the few that live outside it.

Paths are relative to the repository root, and in-repo paths link to the code. These placeholders stand for locations and names outside the repository:

- `<project>` is the project directory that contains the repository checkout. The workspace helper scripts in `scripts/` treat the checkout's parent directory as `<project>`, and one of them writes to `<project>/repo` by name, so they expect the checkout at `<project>/repo`.
- `<eleventy-source>` is the Eleventy project at `<project>/workspace/11ty-dev`. It holds the templates, data files and public assets that produce `11ty/`. It is not under Git.
- `<app-stack>` is the deployed name of the app stack defined by `app-stack.yaml`. It is not `hfy-app`, the `--stack` default of the behavior scripts.
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
| [Family API](#family-api) | `api/` | [API](api.md) |
| [MCP server](#mcp-server) | `api/src/mcp.js`, `api/src/policy.js`, `api/src/labels.js`, `api/src/mcp-caps.js`, `api/parity/`, `scripts/ci/mcp-conformance.sh`, `infrastructure/mcp-edge401.us-east-1.yaml`, `scripts/infra/add-mcp-behavior.sh` | [MCP server](mcp-server.md) |
| [Auth edge and MCP authorization server](#auth-edge-and-mcp-authorization-server) | `auth/` | [Identity services](identity-services.md) |
| [Private data gate](#private-data-gate) | `edge-gate/`, `infrastructure/cloudformation/edge-gate-stack.yaml`, `scripts/ci/package-edge-gate.sh`, `scripts/infra/add-data-gate-behaviors.sh` | [Identity services](identity-services.md#private-data-gate-hfy-edge-gate), [Architecture](architecture.md#hfy-edge-gate) |
| [Legacy sign-in](#legacy-sign-in) | `lambda/`, `functions/`, `gcloud/` | [Identity services](identity-services.md) |
| [Infrastructure](#infrastructure) | `infrastructure/`, `scripts/infra/`, `scripts/cloudfront/`, `cloudfront/` | [Architecture](architecture.md) |
| [CI and repo operations](#ci-and-repo-operations) | `ci.manifest.yaml`, `.github/`, `scripts/ci/`, `scripts/git-hooks/`, the workspace helpers in `scripts/` | [Repository operations](repository-operations.md) |
| [Tests](#tests) | `api/test/`, `auth/test/`, `auth/e2e/`, `edge-gate/test/`, `islands/tests/`, `scripts/infra/test/`, `tests/client/`, `tests/login-flow/`, `scripts/mcp/` | [Repository operations](repository-operations.md) |
| [Sanitized samples](#sanitized-samples) | `allowlist/`, `harrisonfamily-frontend/`, `etl-output/`, `gramps_exports/`, `cloudfront/` | [Private data and secrets](private-data-and-secrets.md) |
| [Outside the repository](#outside-the-repository) | `<eleventy-source>`, `<project>/scripts/`, `<project>/workspace-local/` | [Private data and secrets](private-data-and-secrets.md) |

## Static site output

Paths:

- [`11ty/`](../../11ty/): the deployable site. Each file is classified in [What in `11ty/` is generated](#what-in-11ty-is-generated).
- [`11ty/README.md`](../../11ty/README.md): a pointer into these docs, plus two machine-checked blocks: the repo-owned files table and the refresh `rsync`. See the constraint in [Notes](#notes).
- [`workspace/11ty-dev/src/_data/featureFlags.js`](../../workspace/11ty-dev/src/_data/featureFlags.js): a stray tracked copy of one source data file.

Facts:

- `11ty/` is Eleventy output plus repo-owned files. Its source is `<eleventy-source>`, outside the repository.
- CI deploys `11ty/` as committed and builds nothing into it. Its one change in CI is `scripts/ci/patch-client-id.sh`, which replaces the `REPLACE_WITH_GOOGLE_CLIENT_ID` placeholder in the HTML and JS files of the CI checkout. The committed files keep the placeholder.
- `11ty/js/islands/` is committed build output. See [React islands](#react-islands).
- When any staged path is under `11ty/`, the pre-commit check [`scripts/check-deployment-sync.sh`](../../scripts/check-deployment-sync.sh) compares `<project>/workspace/11ty-dev/_site` with `11ty/` using `rsync -ain --delete --omit-dir-times`. Any difference fails the commit.
- That comparison excludes the data directories (`person/`, `family/`, `event/`, `note/`, `media/`, `place/`), `private/`, `uploads/`, `README.md`, `.DS_Store` and the repo-owned files, `js/person-page.js` among them.
- Excluding `person/` and `private/` also excludes the one page in each, `person/index.html` and `private/index.html`. The other HTML pages are compared, `auth-v2.js` tag included. The source templates do not emit that tag yet (see [What in `11ty/` is generated](#what-in-11ty-is-generated)).
- `SKIP_DEPLOYMENT_SYNC_CHECK=1` skips the check.
- `workspace/11ty-dev/src/_data/featureFlags.js` is the legacy `window.HFY_FEATURE_FLAGS` config. Nothing in the repository builds from it, so it has no effect.

## Front-end runtime

Paths:

- [`11ty/js/feature-flags.js`](../../11ty/js/feature-flags.js): the legacy visibility gating and session cache (`window.HFYFeatureFlags`). It also holds, from E5:
  - the island loader: flag resolution, the `?hfy_flags=` override, `loadIsland`, `whenIsland` and `searchV2Live`;
  - the `authV2` data path: `dataFetchInit`, `dataFetch`, `edgeSession`, `forgetEdgeSession`, `signInUrl`, and the deprecated `dataResponse`;
  - the edge overlay, near the top of the file.
- [`11ty/js/auth.js`](../../11ty/js/auth.js): the legacy Google Identity Services sign-in. It posts the ID token to `/api/check-allowed`.
- [`11ty/js/auth-v2.js`](../../11ty/js/auth-v2.js): the `authV2` sign-in through `/auth`. It reads the session through `HFYFeatureFlags.edgeSession()` and calls `forgetEdgeSession()` on sign-out.
- [`11ty/js/person-page.js`](../../11ty/js/person-page.js): renders the person page. It is edited in the repository: its data requests go through `HFYFeatureFlags.dataFetch`.
- [`11ty/js/search-results.js`](../../11ty/js/search-results.js), [`11ty/js/search-navbar.js`](../../11ty/js/search-navbar.js): the Lunr search page and navbar search. Both are edited in the repository: they stand down for `searchV2`, and their data requests go through `HFYFeatureFlags.dataFetch`.
- [`11ty/_data/flags.json`](../../11ty/_data/flags.json): the build-time flags.
- [`11ty/sw.js`](../../11ty/sw.js): the service worker.

Facts:

- The island loader resolves flags from `/_data/flags.json` plus the `?hfy_flags=` preview override. It then loads islands with `loadIsland`.
- `searchV2` turns on `shellV2` too, unless the override forces `shellV2` off.
- The override lasts for the current tab only. It is kept in `sessionStorage` under `hfy:flags`. `-name` forces a flag off, and an empty `?hfy_flags=` clears the override.
- Earlier builds kept the override in `localStorage`. The script deletes that key on every load.
- While an override is active, the page shows a fixed "Preview flags on" banner with a "turn off" button.
- The override is cleared when a flagged dependency is unavailable: an island bundle fails to load, or `/auth/session` does not answer for `authV2`. The page then falls back to the legacy behaviour.
- `auth-v2.js` does nothing while `authV2` is off.
- With `authV2` off, `dataFetch` is exactly `fetch`, and the legacy `X-HFY-Session` requests are unchanged.
- With `authV2` on, data requests send the `io_id` cookie (`credentials: "same-origin"`) and no `X-HFY-Session` header. That cookie is what the [private data gate](#private-data-gate) checks.
- `edgeSession()` calls `GET /auth/session` once per page. When the session is near expiry, or signed out in a browser that has held an edge session before, it calls `POST /auth/refresh` once and asks again.
- `dataFetch` refreshes a lapsed session once before the page's first data request. On a 401 from the gate, it refreshes once and retries the request once.
- When recovery fails, an interactive load goes to `/auth/login?returnTo=…`, unless this tab was sent there in the last 10 minutes. A background load (`{interactive: false}`) never redirects.
- The edge overlay lays an authenticated edge session over the legacy state for `[data-feature]` visibility only. The legacy `auth.js` therefore cannot hide the signed-in navigation after an edge-only sign-in.
- The Lunr scripts stand down only after the search island has mounted (`HFYFeatureFlags.searchV2Live()`). A missing or failed island leaves the legacy search working.
- Only the shell island registers `sw.js`. `sw.js` loads `/js/islands/notify-sw.js` with `importScripts`.

## React islands

Paths:

- [`islands/src/islands/`](../../islands/src/islands/): one entry per island. The entries are `shell.jsx`, `search.jsx`, `person.jsx`, `my-posts.jsx`, `timeline.jsx`, `posts.jsx` and `notifications.jsx`, plus `search.css` and `notifications.css`.
- [`islands/src/lib/`](../../islands/src/lib/): shared adapters and UI. The files are `api.js`, `mount.jsx`, `comment-source.js`, `comments-ui.jsx`, `content-source.js`, `posts-ui.jsx`, `people-corpus.js` and `upload.js`. `islands/src/shell.css` and `islands/src/posts.css` sit beside the directory.
- [`islands/build.mjs`](../../islands/build.mjs): the esbuild bundler.
- [`islands/package.json`](../../islands/package.json): the scripts `build`, `build:islands`, `check:islands`, `test` and `test:contract`.
- [`scripts/ci/build-islands.sh`](../../scripts/ci/build-islands.sh): runs `npm ci` and the build, then checks that `shell.js` and `shell.css` exist.
- [`11ty/js/islands/`](../../11ty/js/islands/): the committed build output.

Facts:

- `build.mjs` deletes `11ty/js/islands/` at the start of every build.
- It writes `<name>.js` and `<name>.css` for each island.
- It splits shared code (React, `@io-kit/*`) into `11ty/js/islands/chunks/`, named `chunks/<name>-<hash>.js`.
- It copies `notify-sw.js` from `@io-kit/notify` into the output.
- The output is committed. The deploy syncs `11ty/` with `--delete` and builds no islands, so a bundle that is not committed is removed from the site at the next deploy.
- `npm run check:islands` (`node build.mjs --check`) and `islands/tests/bundle.test.mjs` fail when the committed output differs from a fresh build. No workflow runs either one.
- The person island (`person.jsx`) and the search corpus (`lib/people-corpus.js`) read family data through `HFYFeatureFlags.dataFetch` when it exists, so they follow the same `authV2` data path as the legacy scripts.
- Flags:
  - `shell` loads on `shellV2`.
  - `search` loads on `searchV2`, on `/search/`.
  - `person` loads on `personV2`, on `/person/?id=…`.
  - Under `postsV2`, `my-posts` loads on `/person/?id=…`, `timeline` on `/`, and `posts` on `/posts/`.
  - `notifications` loads on `notifyV2`, on `/me/notifications/`.
- Installing needs `CODEARTIFACT_AUTH_TOKEN` for the `@io-kit/*` packages ([`islands/.npmrc`](../../islands/.npmrc)). `package.json` requires Node 22 or later.
- How to rebuild: [How to build and preview the React islands](../how-to/build-and-preview-the-islands.md).

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
  - `txn.js`: transactions and audit items.
  - `keys.js`: table key layout.
  - `notify.js`: push notifications.
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
- Push notifications are sent only when the stack parameter `VapidSecretName` names a VAPID secret. The live secret is `harrisonfamily/api/vapid`, a JSON `{subject, publicKey, privateKey}` whose `subject` is an `https://` URL, so no email address goes to the push services. Without the secret, subscriptions and preferences are stored but nothing is sent. See [How to turn on push notifications](../how-to/turn-on-push-notifications.md).
- `api/dist/` is gitignored.
- `package-api.sh` needs `CODEARTIFACT_AUTH_TOKEN`. It runs `gen-caps.mjs` inside its staging copy, so the zip holds all four generated documents. Only `caps.json` is copied back to `api/dist/`.
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
  - `edge.js`: the `/auth/*` mount over `@io-kit/auth`, plus `/auth/.well-known/jwks.json`, `/auth/session` and `/auth/passkeys`, which redirects to the account page `/auth/link`.
  - `oauth.js`: the OAuth 2.1 server for MCP clients: metadata, `authorize`, `token`, `register`, `revoke` and `userinfo`.
  - `membership.js`: the allowlist and admin groups for MCP tokens.
  - `cognito.js`: Cognito user provisioning for `POST /auth/link`.
  - `linkstore.js`: the account-link store.
  - `passkeystore.js`: the passkey credential store.
  - `ratelimit.js`: request counters.
  - `origin.js`: the `X-Origin-Verify` check.
- [`auth/edge.manifest.json`](../../auth/edge.manifest.json): the edge manifest. Its providers are `google`, `password` and `passkey`.
- [`auth/e2e/passkey.e2e.mjs`](../../auth/e2e/passkey.e2e.mjs): the passkey end-to-end test. See [Tests](#tests).
- [`scripts/ci/package-auth.sh`](../../scripts/ci/package-auth.sh): builds `dist/hfy-auth-edge.zip`.

Facts:

- Lambda `hfy-auth-edge` (`nodejs22.x`) runs behind CloudFront. It serves `/auth/*` and the root discovery path `/.well-known/oauth-authorization-server*`.
- Members sign in with Google, with a Cognito email and password, or with a passkey. The session is an RS256 cookie, and only the edge holds the signing key.
- The kit's account page, `/auth/link`, lists and removes a member's own passkeys. Passkey sign-in asks for user verification as `preferred`, and the `amr` claim includes `mfa` only when the authenticator verified the user.
- `GET /auth/session` reports `exp`, the expiry of the `io_id` cookie. A page uses it to call the kit's `POST /auth/refresh`, which re-sets `io_id` from the `io_rt` refresh cookie, before the session lapses.
- The manifest is committed with placeholders for the Cognito user pool ID, the Cognito client ID and the Google client ID. `edge.js` fills them from the Lambda environment and fails if one is missing.
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
- [`scripts/infra/add-data-gate-behaviors.sh`](../../scripts/infra/add-data-gate-behaviors.sh): attaches the gate to the data paths, or detaches it with `--remove`.
- The client data path:
  - [`11ty/js/feature-flags.js`](../../11ty/js/feature-flags.js): `dataFetchInit`, `dataFetch` and `edgeSession` (see [Front-end runtime](#front-end-runtime)).
  - [`11ty/js/person-page.js`](../../11ty/js/person-page.js), [`11ty/js/search-navbar.js`](../../11ty/js/search-navbar.js), [`11ty/js/search-results.js`](../../11ty/js/search-results.js): the legacy callers.
  - [`islands/src/islands/person.jsx`](../../islands/src/islands/person.jsx), [`islands/src/lib/people-corpus.js`](../../islands/src/lib/people-corpus.js): the island callers.

Facts:

- The gate checks `/person/*.json`, `/family/*`, `/event/*`, `/note/*`, `/place/*` and `/media/*`. `/person/` itself is the public person-page shell and is not gated.
- It verifies the `io_id` session cookie: the RS256 signature against the auth edge's JWKS, the issuer, the audience, and `exp` and `nbf` with a clock skew.
- A request with a valid cookie passes unchanged. Otherwise a fetch, XHR or subresource request gets a 401, and a top-level navigation gets a 302 to `/auth/login?returnTo=<path>`. Any error is a deny.
- Every response the gate generates carries `Cache-Control: private, no-store`. Allowed responses get the same header from the `hfy-private-no-store` response headers policy. Cloudflare proxies the site in front of CloudFront, and these headers stop it from storing family data.
- Lambda@Edge has no environment variables, so `package-edge-gate.sh` copies `gate.config.json` into the zip as `config.json`.
- The zip is reproducible. The script prints the stack parameters `CodeKey` and `CodeSha256` and writes them to `dist/hfy-edge-gate.params`. `CodeKey` is content-addressed: `lambda/hfy-edge-gate-<first 16 hex digits of the zip's SHA-256>.zip`.
- The stack reads the code from `<edge-code-bucket>` and has no default key. A code change is therefore always a new key, so the stack updates the function and publishes a new numbered version.
- The gate is not behind a flag. It takes effect when `add-data-gate-behaviors.sh` attaches it.
- Once the gate is attached, visitors without `authV2` cannot read the family data. `authV2` is therefore turned on first and the gate attached after it. See [How to cut over to authV2 and the private data gate, and roll back](../how-to/cut-over-to-the-private-data-gate.md), and for the reasoning, [The gate is a third switch, and the order matters](../explanation/release-model.md#the-gate-is-a-third-switch-and-the-order-matters).
- No workflow builds, deploys or attaches the gate. Building, validating and deploying it: [How to deploy and update the Lambda@Edge functions in us-east-1](../how-to/deploy-the-edge-functions.md). Why it exists: [Gating the JSON](../explanation/family-data-privacy.md#gating-the-json).

## Legacy sign-in

Paths:

- [`lambda/hfy-check-allowed/index.mjs`](../../lambda/hfy-check-allowed/index.mjs): the `hfy-check-allowed` Lambda.
- [`functions/get-allowlist/`](../../functions/get-allowlist/): the `getAllowlist` Google Cloud Function. This is the deployed copy.
- [`gcloud/allowlist-fn/`](../../gcloud/allowlist-fn/): a byte-identical sample copy, refreshed by `scripts/export_workspace_samples.sh`.

Facts:

- `hfy-check-allowed` verifies a Google ID token and checks an HMAC of the email against the hashed allowlist. It looks the email up in the email-to-gramps_id map and returns a session token.
- `11ty/js/auth.js` calls it at `/api/check-allowed`. `add-api-behavior.sh` pins `/api/check-allowed*` to the origin that serves it, ahead of the new `/api/*` behavior.
- `io-kit-deploy.yml` deploys `hfy-check-allowed` on push to `main`. `scripts/ci/package-lambda.sh` builds its zip.
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
- [`scripts/infra/lib/`](../../scripts/infra/lib/): the behavior scripts share both files.
  - `cf-common.sh`: the fetch, compare and apply plumbing, and `cf_response_headers_policy`, which finds a custom response headers policy by name and creates it, or puts it back, when it does not force the wanted `Cache-Control`.
  - `cf.jq`: the config transforms, including the placement ahead of shadowing behaviors and the removal of the gate behaviors.
- [`scripts/cloudfront/append-index.js`](../../scripts/cloudfront/append-index.js): the CloudFront Function that maps directory URLs to `index.html`.
- [`cloudfront/distribution.json`](../../cloudfront/distribution.json): a sanitized sample distribution in the pre-app layout. [`cloudfront/README.md`](../../cloudfront/README.md) is a short pointer into these docs.

Facts:

- The app stack does not manage the site bucket. Its CORS is applied by hand.
- `UploadsResponseHeadersPolicy` sets `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox; default-src 'none'; img-src 'self'`. The stack exports its ID as `UploadsResponseHeadersPolicyId`.
- The live app stack is `<app-stack>`, not `hfy-app`. `add-api-behavior.sh`, `add-auth-behavior.sh`, `add-uploads-behavior.sh` and `add-mcp-behavior.sh` read its outputs through `--stack`, whose default is `hfy-app`, so pass `--stack <app-stack>` on every run.
- In `add-data-gate-behaviors.sh`, `--stack` names the us-east-1 gate stack instead. Its default, `hfy-edge-gate`, is the deployed name.
- The app stack reads the Lambda code from `<code-bucket>` at the keys in `CodeKey` and `AuthCodeKey`. Their defaults are `lambda/hfy-api.zip` and `lambda/hfy-auth-edge.zip`.
- Deploys upload commit-named zips, `lambda/hfy-api-<sha>.zip` and `lambda/hfy-auth-edge-<sha>.zip`, and apply them through a CloudFormation change set: see [How to deploy the app stack and its CloudFront behaviors](../how-to/deploy-the-app-stack.md).
- Lambda@Edge functions must live in us-east-1, so the gate and the MCP 401-restore function have their own stacks there, `hfy-edge-gate` and `hfy-mcp-edge401`. Both are deployed by hand: see [How to deploy and update the Lambda@Edge functions in us-east-1](../how-to/deploy-the-edge-functions.md).
- Each edge stack publishes a new numbered version only when its version resource changes: the gate's through `CodeSha256`, the 401-restore function's through the code hash in its `Description`. Old versions are retained, because CloudFront replicas pin them.
- `github-roles.yaml` is deployed once by hand.
- The deploy role denies `s3:PutObject` and `s3:DeleteObject` under `uploads/*` in the site bucket.
- The deploy role's Lambda permissions cover `hfy-check-allowed`, `hfy-api` and `hfy-auth-edge` in us-west-2.
- The deploy role has no permission on `hfy-edge-gate`, `hfy-mcp-edge401` or any CloudFormation stack, so CI cannot deploy either edge stack.
- `add-auth-behavior.sh` adds the `hfy-auth-edge` origin and two behaviors, `/auth/*` and `/.well-known/oauth-authorization-server*`.
- `add-api-behavior.sh` adds the `hfy-api` origin and the `/api/*` behavior. Before `/api/*`, it pins a `/api/check-allowed*` behavior, cloned from the one that serves `/api/check-allowed` now. This keeps the legacy sign-in from being shadowed.
- It exits with status 3 when it cannot find that origin and no pin exists, unless `--legacy-origin` names the origin.
- `add-uploads-behavior.sh` adds a GET and HEAD `/uploads/*` behavior on the default behavior's S3 origin, with the uploads response headers policy.
- `add-mcp-behavior.sh` adds `/mcp*` and `/.well-known/oauth-protected-resource*` on the `hfy-api` origin. Each carries the `hfy-mcp-edge401` version as its origin-response function, taken from `--edge401-arn`, `$EDGE401_ARN` or the `hfy-mcp-edge401` stack's output.
- `add-mcp-behavior.sh` exits with status 3 when an earlier behavior already matches one of the MCP paths.
- `add-data-gate-behaviors.sh` adds the six gated behaviors on the site's S3 origin, the default behavior's origin unless `--origin-id` names another. Each gets the gate version as its viewer-request function, `CachingDisabled` and the `hfy-private-no-store` response headers policy.
- It places a gated pattern just ahead of any broader behavior that would shadow it, and refuses an unqualified or `$LATEST` function ARN.
- `--remove` deletes exactly the gated behaviors that carry the gate's association. The data paths are then public again. The response headers policy is kept.
- The `scripts/infra/` scripts are idempotent, accept `--dry-run`, and never print secret values.
- The behavior scripts skip `update-distribution` when nothing would change. Before a real update, they save the pre-change config outside the repository.
- `distribution.json` shows the pre-app layout: an S3 origin, plus an API Gateway origin that serves `/api/*`. It shows none of the behaviors that the behavior scripts add.

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
- Workspace helpers: [`scripts/check-deployment-sync.sh`](../../scripts/check-deployment-sync.sh), [`scripts/export_workspace_samples.sh`](../../scripts/export_workspace_samples.sh), [`scripts/promote_workspace_assets.sh`](../../scripts/promote_workspace_assets.sh), [`scripts/sync_sanitized_assets.py`](../../scripts/sync_sanitized_assets.py), [`scripts/validate_build.sh`](../../scripts/validate_build.sh).

Facts:

- `io-kit-ci.yml` runs on pull requests and on manual dispatch. It runs the build, a parity report in report mode, and a TruffleHog scan.
- `io-kit-deploy.yml` runs on push to `main` and on manual dispatch. Its jobs run in this order: build, package, deploy, invalidate, smoke, then rollback if the smoke check fails.
- The build job runs `patch-client-id.sh`, then `package-lambda.sh`, on Node 20. The package job uploads `11ty/` and `dist/hfy-check-allowed.zip` as the artifact `io-kit-release-<sha>`.
- The deploy job syncs `11ty/` to the site bucket with `--delete` and then updates the `hfy-check-allowed` code.
- The sync excludes `person/*.json`, `media/*`, `family/*`, `event/*`, `note/*`, `place/*` and `uploads/*`, and never deletes the excluded paths.
- The invalidation covers `/*`.
- The smoke job requests the home page and `/family-login/`. Any status outside 2xx and 3xx fails it.
- The rollback strategy is `previous_artifact`. It redeploys the artifact of the last successful `io-kit-deploy.yml` run on the branch.
- The pipeline builds no islands, and deploys none of `hfy-api`, `hfy-auth-edge`, `hfy-edge-gate` and `hfy-mcp-edge401`. `ci.manifest.yaml` has no target for any of them.
- `build-islands.sh`, `package-api.sh`, `package-auth.sh`, `package-edge-gate.sh` and `mcp-conformance.sh` are not run by any workflow.
- `deploy-gcf-legacy.yml` deploys `getAllowlist` on push to `main`. See [Legacy sign-in](#legacy-sign-in).
- The pre-commit hook runs `check-deployment-sync.sh`, then a `trufflehog` filesystem scan. It fails when `trufflehog` is not installed.
- The hook runs only when `core.hooksPath` is `scripts/git-hooks`.
- The workspace helpers treat the checkout's parent directory as `<project>`.

## Tests

Paths:

- [`api/test/`](../../api/test/): Vitest. The suites are `api`, `contracts`, `hardening`, `jwks`, `labels`, `mcp`, `mcp-conformance`, `mcp-infra`, `origin`, `package-api`, `presign` and `producers`. `fake-ddb.js` and `world.js` are helpers.
- [`auth/test/`](../../auth/test/): Vitest. The suites are `cognito`, `edge`, `linkstore`, `oauth`, `origin`, `passkey`, `passkeystore` and `userinfo`. `fake-table.js` is a helper.
- [`auth/e2e/passkey.e2e.mjs`](../../auth/e2e/passkey.e2e.mjs): a Playwright end-to-end passkey test.
- [`edge-gate/test/gate.test.mjs`](../../edge-gate/test/gate.test.mjs): `node:test`.
- [`tests/client/`](../../tests/client/): `node:test` suites `auth-continuity.test.mjs` and `data-fetch.test.mjs`.
- [`islands/tests/`](../../islands/tests/):
  - `node:test` suites: `bundle.test.mjs`, `contract.test.mjs` and `content-contract.test.mjs`.
  - Playwright specs: `shell`, `search`, `person`, `posts`, `notifications`, `flags-fallback`, `sw` and `auth-continuity`.
  - Fixture: `fixtures/person-synthetic.json`.
- [`scripts/infra/test/`](../../scripts/infra/test/):
  - `run.sh`: offline tests for `scripts/infra`, `scripts/ci/package-edge-gate.sh` and `scripts/check-deployment-sync.sh`.
  - `test_app_stack.py`: static checks on `app-stack.yaml` and `github-roles.yaml`.
  - `test_edge_gate_stack.py` and `test_mcp_edge401_stack.py`: static checks on the two us-east-1 templates.
  - `stub/aws`, `cf-echo.jq` and `fixtures/live-like.json`: test doubles.
- [`tests/login-flow/`](../../tests/login-flow/): Playwright specs `login-flow.spec.ts` and `auth-v2.spec.ts`.
- [`scripts/mcp/token-smoke.sh`](../../scripts/mcp/token-smoke.sh): a live MCP token check.

Facts:

- The API suites run against an in-memory DynamoDB fake. They include the `@io-kit` content and comments contract suites.
- `mcp-conformance.test.js` runs the packaged `@io-kit/mcp` conformance corpus, MCP-C01 to MCP-C12, against this repository's edge and core factories.
- `mcp-infra.test.js` dry-runs `add-mcp-behavior.sh` on an exported config, runs the 401-restore code, and checks that `tools/list` matches the caps.
- `package-api.test.js` runs `package-api.sh` against a temporary copy of the repository, with `npm` and `zip` shimmed.
- `presign.test.js` signs offline with fake credentials.
- `passkeystore.test.js` uses `fake-table.js`, an in-memory table that reads the `hfy-app` key schema from `app-stack.yaml` and applies DynamoDB's sparse-index rule.
- `passkey.e2e.mjs` drives Chromium's virtual authenticator against the real edge app on `http://localhost`, with in-memory stores. It runs with `npm run e2e` in `auth/`, after `npx playwright install chromium`, and is not part of `npm test`.
- `edge-gate/` has no dependencies. `npm test` there runs `node --test`.
- `tests/client` loads the real `11ty/js/feature-flags.js` into a `vm` sandbox with a stubbed `fetch`. It needs no install: `node --test tests/client/*.test.mjs` from the repository root.
- The islands content-contract test drives the real `api/` handler.
- `bundle.test.mjs` checks that `11ty/js/islands/` is tracked and identical to a fresh build.
- The island Playwright specs run at 375 px width against a static server on `11ty/` at `127.0.0.1:8089`, so they use the committed bundles.
- `/api`, `/auth` and the data files are stubbed per test. The `auth-continuity` spec models the gate as a 401 until `/auth/refresh` has succeeded. All island fixtures are synthetic.
- `scripts/infra/test/run.sh` puts `stub/aws` first on `PATH` and never reaches AWS. It needs `bash`, `jq`, and `python3` with PyYAML.
- `run.sh` also needs `node`, `zip` and `openssl` for the `package-edge-gate.sh` checks, and `rsync` and `git` for the `check-deployment-sync.sh` run. It skips each of those blocks when its tools are missing, and uses `cfn-lint` and `shellcheck` when they are installed.
- `tests/login-flow` targets the live site by default (`HFY_SITE_BASE`).
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
- `scripts/export_workspace_samples.sh` replaces `allowlist/`, `cloudfront/`, `etl-output/`, `gcloud/`, `harrisonfamily-frontend/` and `tests/login-flow/` with their copies in `<project>/workspace/`. It also copies `coming-soon-index.html`.

## Outside the repository

Paths: `<eleventy-source>`; `<project>/scripts/etl/`; `<project>/scripts/search/build_search_index.js`; `<project>/scripts/infra/publish_allowlists.sh`; `<project>/scripts/auth/mint_test_id_token.py`; `<project>/workspace-local/`.

Facts:

- They are named here so you know they exist. These docs do not reproduce their contents.
- `<eleventy-source>` builds `11ty/`.
- The ETL scripts turn the Gramps export into person JSON and family-tree media.
- `build_search_index.js` builds the person manifest and search index. The source's `build:search` step runs it.
- `publish_allowlists.sh` publishes the allowlist to Secret Manager and the email-to-gramps_id map to the config bucket.
- `mint_test_id_token.py` mints test ID tokens for `tests/login-flow`.
- `workspace-local/` holds the private family data and the real credentials.
- The workspace sources of the legacy sign-in code are also outside the repository. See [Legacy sign-in](#legacy-sign-in).

## What in `11ty/` is generated

Every file under `11ty/` falls into one of the kinds below. E5 is the release line that added the islands, the auth edge, the API, the MCP server and the client side of the private data gate.

- "Generated" means Eleventy output, kept as the source produced it.
- "E5-edited" means a generated file that was then changed in the repository.
- "E5-only" means a file added in the repository for E5.

Three more columns show how each kind is treated:

- "Plain refresh" is a `rsync -a --delete` from the source output that excludes only `README.md`, `private/`, `media/`, `person/`, `family/`, `event/` and `note/`: the refresh `11ty/README.md` documented before E5.
- "README refresh" is the refresh `rsync` in `11ty/README.md` now. Its excludes are the sync check's, `.DS_Store` aside.
- "Sync check" is the pre-commit `check-deployment-sync.sh`.

To rebuild from the source without losing E5 files, follow [How to refresh `11ty/` from the Eleventy source without losing E5 files](../how-to/refresh-the-eleventy-output.md).

| Files | Kind | Plain refresh | README refresh | Sync check |
|---|---|---|---|---|
| `css/main.css`, `css/main.css.map`; `images/` except `pwa-*`; `js/auth.js`, `js/bootstrap.bundle.min.js` | Generated. The scripts are copied from the source's `public/js/`. | Replaced from source output. Nothing is lost. | Replaced from source output. | Compared. |
| `index.html`, and `index.html` under `about/`, `contact/`, `family-login/`, `logged-out/`, `privacy/`, `search/` and `terms/` | E5-edited. Each page has one added line, `<script src="/js/auth-v2.js" defer></script>`. | Overwritten. The tag is lost unless the source output has it. | Overwritten too, so re-add the tag before committing. | Compared, tag included. |
| `person/index.html`, `private/index.html` | E5-edited, with the same added line. | Excluded.[^dirs] | Excluded.[^dirs] | Excluded.[^dirs] |
| `js/search-navbar.js`, `js/search-results.js` | E5-edited. A comment and a `hfySearchV2Live()` helper at the top (lines 2–5), and `edgeSessionInit()` and `dataFetch()` helpers (lines 74–85 in `search-navbar.js`, 144–155 in `search-results.js`). Stand-down checks `if (await hfySearchV2Live())` before the data load: line 116 (in `loadData()`) in `search-navbar.js`, and lines 187 (in `loadData()`) and 417 (in `bootstrap()`) in `search-results.js`. Under `authV2`, the manifest and index load through `dataFetch` with the cookie only, `requireAuthenticated()` returns at once, and `subscribeToAuthChanges()` preloads on the edge session. | Overwritten with the source copy, which lacks these edits. | Excluded. | Excluded. |
| `js/feature-flags.js` | E5-edited. The edge overlay, `edgeOverlay` and `visibilityState()` (lines 18–24), is E5-only, and `shouldShow` (line 83) and `featureAPI.shouldShow` (line 232) read it. The E5 block runs between `window.HFYFeatureFlags = featureAPI;` (line 260) and `onReady(applyFeatureVisibility);` (line 731), so lines 261–730. It holds flag resolution, the `?hfy_flags=` override and banner, the `authV2` data path (lines 391–615), `loadIsland`, `whenIsland`, `searchV2Live` and the per-flag loaders. The rest matches the source output. | Overwritten with the source copy, which lacks these edits. | Excluded. | Excluded. |
| `js/person-page.js` | E5-edited. `dataFetch()` and `edgeSessionInit()` helpers (lines 147–162) send the data requests through `HFYFeatureFlags.dataFetch`. Under `authV2`, `requireAuthenticated()` (line 165) and `buildAuthorizedFetchOptions()` (line 277) use the cookie instead of the legacy token. `fetchPerson()` turns a final 401 into a sign-in link (lines 133–139), which `showSignIn()` (lines 112–126) shows. The family-tree SVG loads as a background request (line 610). | Overwritten with the source copy, which lacks the `authV2` data path. | Excluded. | Excluded. |
| `_data/flags.json`, `js/auth-v2.js`, `sw.js`, `manifest.webmanifest`, `offline.html`, `posts/index.html`, `me/notifications/index.html`, `images/pwa-192.png`, `images/pwa-512.png`, `images/pwa-maskable-512.png` | E5-only. | Deleted, or replaced by the source copy where the source output has one. | Excluded. | Excluded. |
| `js/islands/`, including `chunks/` and `notify-sw.js` | E5-only. Committed build output of [`islands/build.mjs`](../../islands/build.mjs). | Deleted, or replaced by the source copy where the source output has one. | Excluded. | Excluded. |
| `README.md` | Repository note for the directory. | Excluded. | Excluded. | Excluded. |

[^dirs]: The tracked `person/index.html` and `private/index.html` are the only files under `person/` and `private/`. Every refresh and the sync check exclude both whole directories, so none of them overwrites, deletes or compares these two pages. A change to either page in the source output reaches `11ty/` only when it is copied by hand.

A copy of source output that uses `--delete` without these excludes deletes every E5-only file that the source output lacks, including the committed islands. It also overwrites the E5-edited files.

## Top-level directories

The reverse lookup: from a directory to the capability sections above.

| Directory or file | Capability |
|---|---|
| `.github/workflows/`, `.github/actions/`, `ci.manifest.yaml` | CI and repo operations |
| `11ty/` | Static site output, front-end runtime, React islands (`11ty/js/islands/`), private data gate (the client data path) |
| `allowlist/`, `etl-output/`, `gramps_exports/`, `harrisonfamily-frontend/`, `coming-soon-index.html` | Sanitized samples |
| `api/` | Family API, MCP server |
| `auth/` | Auth edge and MCP authorization server |
| `cloudfront/` | Infrastructure (sample distribution), sanitized samples |
| `docs/`, `AGENTS.md` | This documentation. `AGENTS.md` is the entry point for automated agents. |
| `edge-gate/` | Private data gate |
| `functions/`, `gcloud/`, `lambda/` | Legacy sign-in |
| `infrastructure/` | Infrastructure, including the us-east-1 stacks of the MCP server and the private data gate |
| `islands/` | React islands |
| `scripts/` | CI and repo operations, infrastructure, tests |
| `tests/` (`client/`, `login-flow/`) | Tests |
| `workspace/` | Static site output (the stray `featureFlags.js` only) |

## Notes

- This page is a routing index, not an inventory of record. Where it and the code disagree, the code is authoritative.
- The feature flags all ship `false` in `11ty/_data/flags.json`. Until a flag is turned on, the island, `auth-v2.js` and `authV2` data paths above are inert in production ([How to turn a feature flag on for one tab or for everyone](../how-to/toggle-a-feature-flag.md)). The [release model](../explanation/release-model.md) explains why. The private data gate is not a flag: it applies from the moment `add-data-gate-behaviors.sh` attaches it.
- `11ty/README.md` is machine-checked. `scripts/infra/test/run.sh` reads two blocks from it and compares them with the Eleventy excludes in `scripts/check-deployment-sync.sh`:
  - the section from `## Repo-owned files` to `## Refreshing` must list `js/person-page.js`;
  - the excludes of the command that starts `rsync -a --delete -n -i`, read up to its `_site/` line, must equal the sync check's excludes, `.DS_Store` aside.

  Change the exclude list in both files together, and keep those two headings and that command line as they are, or `run.sh` fails.
- Some code comments cite READMEs that are now pointers. `scripts/ci/package-edge-gate.sh`, `infrastructure/cloudformation/edge-gate-stack.yaml` and `11ty/js/feature-flags.js` cite `cloudfront/README.md` ("Private data gate") for the deploy order and rollback. That material is now in [How to deploy and update the Lambda@Edge functions in us-east-1](../how-to/deploy-the-edge-functions.md) and [How to cut over to authV2 and the private data gate, and roll back](../how-to/cut-over-to-the-private-data-gate.md). `api/src/keys.js` cites `api/README.md` for the key layout, which is now in [API: Table layout](api.md#table-layout).
- The `@io-kit/*` packages used by `api/`, `auth/` and `islands/` come from a private CodeArtifact registry. Each of those directories has an `.npmrc` that reads `CODEARTIFACT_AUTH_TOKEN` from the environment, so no token is stored in the repository. `edge-gate/` and `tests/client/` need no packages. See [Private data and secrets](private-data-and-secrets.md).
