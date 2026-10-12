# Codebase map

Reference for where each capability lives in the repository, and for the few that live outside it.

Paths are relative to the repository root, and in-repo paths link to the code. Two placeholders stand for locations outside the repository:

- `<project>` is the project directory that contains the repository checkout. The workspace helper scripts in `scripts/` treat the checkout's parent directory as `<project>`, and one of them writes to `<project>/repo` by name, so they expect the checkout at `<project>/repo`.
- `<eleventy-source>` is the Eleventy project at `<project>/workspace/11ty-dev`. It holds the templates, data files and public assets that produce `11ty/`. It is not under Git.

For the components and how requests move between them, see the [architecture reference](architecture.md). For why the front end is a generated site with React islands on top, see [Why React islands on a generated Eleventy site](../explanation/islands-on-eleventy.md).

## Capability → code

Each capability has a section below with its paths, the facts that change how you work with them (generated or hand-maintained, gated by a flag, deployed by CI or not), and the page that describes it in full.

| Capability | Main paths | Reference page |
|---|---|---|
| [Static site output](#static-site-output) | `11ty/` | [Front end](front-end.md) |
| [Front-end runtime](#front-end-runtime) | `11ty/js/`, `11ty/_data/flags.json`, `11ty/sw.js` | [Front end](front-end.md) |
| [React islands](#react-islands) | `islands/`, `11ty/js/islands/` | [Front end](front-end.md) |
| [Family API](#family-api) | `api/` | [API](api.md) |
| [Auth edge and MCP authorization server](#auth-edge-and-mcp-authorization-server) | `auth/` | [Identity services](identity-services.md) |
| [Legacy sign-in](#legacy-sign-in) | `lambda/`, `functions/`, `gcloud/` | [Identity services](identity-services.md) |
| [Infrastructure](#infrastructure) | `infrastructure/`, `scripts/infra/`, `scripts/cloudfront/`, `cloudfront/` | [Architecture](architecture.md) |
| [CI and repo operations](#ci-and-repo-operations) | `ci.manifest.yaml`, `.github/`, `scripts/ci/`, `scripts/git-hooks/`, the workspace helpers in `scripts/` | [Repository operations](repository-operations.md) |
| [Tests](#tests) | `api/test/`, `auth/test/`, `islands/tests/`, `scripts/infra/test/`, `tests/login-flow/`, `scripts/mcp/` | [Repository operations](repository-operations.md) |
| [Sanitized samples](#sanitized-samples) | `allowlist/`, `harrisonfamily-frontend/`, `etl-output/`, `gramps_exports/`, `cloudfront/` | [Private data and secrets](private-data-and-secrets.md) |
| [Outside the repository](#outside-the-repository) | `<eleventy-source>`, `<project>/scripts/`, `<project>/workspace-local/` | [Private data and secrets](private-data-and-secrets.md) |

## Static site output

Paths:

- [`11ty/`](../../11ty/): the deployable site. Each file is classified in [What in `11ty/` is generated](#what-in-11ty-is-generated).
- [`11ty/README.md`](../../11ty/README.md): a short pointer into these docs.
- [`workspace/11ty-dev/src/_data/featureFlags.js`](../../workspace/11ty-dev/src/_data/featureFlags.js): a stray tracked copy of one source data file.

Facts:

- `11ty/` is Eleventy output plus repo-owned files. Its source is `<eleventy-source>`, outside the repository.
- CI deploys `11ty/` as committed and builds nothing into it. Its one change in CI is `scripts/ci/patch-client-id.sh`, which replaces the `REPLACE_WITH_GOOGLE_CLIENT_ID` placeholder in the HTML and JS files of the CI checkout. The committed files keep the placeholder.
- `11ty/js/islands/` is committed build output. See [React islands](#react-islands).
- When any staged path is under `11ty/`, the pre-commit check [`scripts/check-deployment-sync.sh`](../../scripts/check-deployment-sync.sh) compares `<project>/workspace/11ty-dev/_site` with `11ty/` using `rsync -ain --delete`. Any difference fails the commit.
- That comparison excludes the data directories (`person/`, `family/`, `event/`, `note/`, `media/`, `place/`), `private/`, `uploads/`, `README.md`, `.DS_Store` and the repo-owned files.
- The HTML pages are still compared, `auth-v2.js` tag included. The source templates do not emit that tag yet (see [What in `11ty/` is generated](#what-in-11ty-is-generated)).
- `SKIP_DEPLOYMENT_SYNC_CHECK=1` skips the check.
- `workspace/11ty-dev/src/_data/featureFlags.js` is the legacy `window.HFY_FEATURE_FLAGS` config. Nothing in the repository builds from it, so it has no effect.

## Front-end runtime

Paths:

- [`11ty/js/feature-flags.js`](../../11ty/js/feature-flags.js): the legacy visibility gating and session cache (`window.HFYFeatureFlags`), with the E5 island loader in the middle.
- [`11ty/js/auth.js`](../../11ty/js/auth.js): the legacy Google Identity Services sign-in. It posts the ID token to `/api/check-allowed`.
- [`11ty/js/auth-v2.js`](../../11ty/js/auth-v2.js): the `authV2` sign-in through `/auth`.
- [`11ty/js/person-page.js`](../../11ty/js/person-page.js): renders the person page.
- [`11ty/js/search-results.js`](../../11ty/js/search-results.js), [`11ty/js/search-navbar.js`](../../11ty/js/search-navbar.js): the Lunr search page and navbar search.
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
- Flags:
  - `shell` loads on `shellV2`.
  - `search` loads on `searchV2`, on `/search/`.
  - `person` loads on `personV2`, on `/person/?id=…`.
  - Under `postsV2`, `my-posts` loads on `/person/?id=…`, `timeline` on `/`, and `posts` on `/posts/`.
  - `notifications` loads on `notifyV2`, on `/me/notifications/`.
- Installing needs `CODEARTIFACT_AUTH_TOKEN` for the `@io-kit/*` packages ([`islands/.npmrc`](../../islands/.npmrc)). `package.json` requires Node 22 or later.
- How to rebuild: [Build and preview the islands](../how-to/build-and-preview-the-islands.md).

## Family API

Paths:

- [`api/src/`](../../api/src/):
  - `index.js`: Lambda entry and AWS clients.
  - `handler.js`: Function URL handler.
  - `routes.js`: route registry.
  - `http.js`: HTTP helpers.
  - `auth.js`: session principal and admin list.
  - `origin.js`: the `X-Origin-Verify` check.
  - `content.js`: posts.
  - `comments.js`: comments and reactions.
  - `txn.js`: transactions and audit items.
  - `keys.js`: table key layout.
  - `notify.js`: push notifications.
  - `uploads.js`: the upload route.
  - `presign.js`: the presigned S3 PUT.
- [`api/scripts/gen-caps.mjs`](../../api/scripts/gen-caps.mjs): derives `api/dist/caps.json` from `routes.js`.
- [`api/README.md`](../../api/README.md): a short pointer to the [API reference](api.md).
- [`scripts/ci/package-api.sh`](../../scripts/ci/package-api.sh): builds `dist/hfy-api.zip`.

Facts:

- Lambda `hfy-api` (`nodejs22.x`) uses the single DynamoDB table `hfy-app`. It serves `/api/*` behind CloudFront once [`add-api-behavior.sh`](../../scripts/infra/add-api-behavior.sh) has run.
- Every route needs the auth-edge session cookie, which the API verifies against the edge's public JWKS.
- Requests without the `X-Origin-Verify` header that CloudFront injects are rejected before routing.
- `POST /api/uploads` returns a presigned S3 PUT for a key under `uploads/posts/<ulid>/` in the site bucket. The content type is signed, so S3 rejects a PUT with a different `Content-Type`.
- `api/dist/` is gitignored.
- `package-api.sh` needs `CODEARTIFACT_AUTH_TOKEN`.
- No workflow deploys `hfy-api`.

## Auth edge and MCP authorization server

Paths:

- [`auth/src/`](../../auth/src/):
  - `index.js`: Lambda entry, which wires the manifest, signing key, Cognito and stores.
  - `edge.js`: the `/auth/*` mount over `@io-kit/auth`, plus `/auth/.well-known/jwks.json` and `/auth/session`.
  - `oauth.js`: the OAuth 2.1 server for MCP clients.
  - `membership.js`: the allowlist and admin groups for MCP tokens.
  - `cognito.js`: Cognito user provisioning for `POST /auth/link`.
  - `linkstore.js`: the account-link store.
  - `ratelimit.js`: request counters.
  - `origin.js`: the `X-Origin-Verify` check.
- [`auth/edge.manifest.json`](../../auth/edge.manifest.json): the edge manifest.
- [`scripts/ci/package-auth.sh`](../../scripts/ci/package-auth.sh): builds `dist/hfy-auth-edge.zip`.

Facts:

- Lambda `hfy-auth-edge` (`nodejs22.x`) runs behind CloudFront. It serves `/auth/*` and the root discovery path `/.well-known/oauth-authorization-server*`.
- Members sign in with Google, or with a Cognito email and password. The session is an RS256 cookie, and only the edge holds the signing key.
- The manifest is committed with placeholders for the Cognito user pool ID, the Cognito client ID and the Google client ID. `edge.js` fills them from the Lambda environment and fails if one is missing.
- The user pool allows only admin-created users. `cognito.js` creates a user only on `POST /auth/link`, after the allowlist check.
- `linkstore.js` writes `GSI1SK` on every `LINK#` item, so links are found through `GSI1`. It also repairs older items when it reads them.
- `ratelimit.js` limits `POST /auth/password/forgot` with fixed-window counters in `hfy-app`.
- The OAuth routes are on only when `MCP_REDIRECT_URIS` is set.
- `auth/src/origin.js` is byte-identical to `api/src/origin.js`.
- No workflow deploys `hfy-auth-edge`.

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
- [`infrastructure/cloudformation/github-roles.yaml`](../../infrastructure/cloudformation/github-roles.yaml): the OIDC role that GitHub Actions assumes.
- [`infrastructure/cloudformation/media-bucket-cors.json`](../../infrastructure/cloudformation/media-bucket-cors.json): the site bucket's CORS for browser uploads.
- [`scripts/infra/`](../../scripts/infra/):
  - `create-session-key.sh`: the session signing key.
  - `create-origin-verify.sh`: the origin-verify secret.
  - `add-api-behavior.sh`, `add-auth-behavior.sh`, `add-uploads-behavior.sh`: CloudFront origins and behaviors.
- [`scripts/infra/lib/`](../../scripts/infra/lib/): `cf-common.sh` (fetch, compare and apply plumbing) and `cf.jq` (the config transforms). The `add-*` scripts share both.
- [`scripts/cloudfront/append-index.js`](../../scripts/cloudfront/append-index.js): the CloudFront Function that maps directory URLs to `index.html`.
- [`cloudfront/distribution.json`](../../cloudfront/distribution.json): a sanitized sample distribution template with the S3 origin only. [`cloudfront/README.md`](../../cloudfront/README.md) is a short pointer into these docs.

Facts:

- The stack does not manage the site bucket. Its CORS is applied by hand.
- `UploadsResponseHeadersPolicy` sets `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox; default-src 'none'; img-src 'self'`. The stack exports its ID as `UploadsResponseHeadersPolicyId`.
- `github-roles.yaml` is deployed once by hand.
- The deploy role denies `s3:PutObject` and `s3:DeleteObject` under `uploads/*` in the site bucket.
- The deploy role's Lambda permissions cover `hfy-check-allowed`, `hfy-api` and `hfy-auth-edge`.
- `add-auth-behavior.sh` adds the `hfy-auth-edge` origin and two behaviors, `/auth/*` and `/.well-known/oauth-authorization-server*`.
- `add-api-behavior.sh` adds the `hfy-api` origin and the `/api/*` behavior. Before `/api/*`, it pins a `/api/check-allowed*` behavior, cloned from the one that serves `/api/check-allowed` now. This keeps the legacy sign-in from being shadowed.
- It exits with status 3 when it cannot find that origin and no pin exists, unless `--legacy-origin` names the origin.
- `add-uploads-behavior.sh` adds a GET and HEAD `/uploads/*` behavior on the default behavior's S3 origin, with the uploads response headers policy.
- The `scripts/infra/` scripts are idempotent, accept `--dry-run`, and never print secret values.
- The `add-*` scripts skip `update-distribution` when nothing would change. Before a real update, they save the pre-change config outside the repository.
- `distribution.json` shows the pre-app layout: an S3 origin, plus an API Gateway origin that serves `/api/*`. It shows none of the behaviors that the `add-*` scripts add.

## CI and repo operations

Paths:

- [`ci.manifest.yaml`](../../ci.manifest.yaml): the pipeline definition.
- [`.github/workflows/io-kit-ci.yml`](../../.github/workflows/io-kit-ci.yml), [`.github/workflows/io-kit-deploy.yml`](../../.github/workflows/io-kit-deploy.yml): rendered from `ci.manifest.yaml` by `@io-kit/ci` 0.1.3. Each carries a "do not edit" header.
- [`.github/actions/io-kit-ci/`](../../.github/actions/io-kit-ci/): the composite actions those workflows call. They are `build`, `package`, `deploy-static`, `deploy-lambda`, `invalidate`, `smoke`, `rollback`, `parity-report` and `secret-scan`.
- [`.github/workflows/deploy-gcf-legacy.yml`](../../.github/workflows/deploy-gcf-legacy.yml): the `getAllowlist` deploy.
- [`scripts/ci/`](../../scripts/ci/):
  - `patch-client-id.sh` and `package-lambda.sh` are the manifest build command.
  - `build-islands.sh`, `package-api.sh` and `package-auth.sh` are local build scripts.
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
- The pipeline builds no islands and deploys neither `hfy-api` nor `hfy-auth-edge`. `ci.manifest.yaml` has no target for either.
- `build-islands.sh`, `package-api.sh` and `package-auth.sh` are not run by any workflow.
- `deploy-gcf-legacy.yml` deploys `getAllowlist` on push to `main`. See [Legacy sign-in](#legacy-sign-in).
- The pre-commit hook runs `check-deployment-sync.sh`, then a `trufflehog` filesystem scan. It fails when `trufflehog` is not installed.
- The hook runs only when `core.hooksPath` is `scripts/git-hooks`.
- The workspace helpers treat the checkout's parent directory as `<project>`.

## Tests

Paths:

- [`api/test/`](../../api/test/): Vitest. The suites are `api`, `contracts`, `hardening`, `jwks`, `origin`, `package-api`, `presign` and `producers`. `fake-ddb.js` and `world.js` are helpers.
- [`auth/test/`](../../auth/test/): Vitest. The suites are `cognito`, `edge`, `linkstore`, `oauth` and `origin`.
- [`islands/tests/`](../../islands/tests/):
  - `node:test` suites: `bundle.test.mjs`, `contract.test.mjs` and `content-contract.test.mjs`.
  - Playwright specs: `shell`, `search`, `person`, `posts`, `notifications`, `flags-fallback` and `sw`.
  - Fixture: `fixtures/person-synthetic.json`.
- [`scripts/infra/test/`](../../scripts/infra/test/):
  - `run.sh`: offline tests for `scripts/infra`.
  - `test_app_stack.py`: static checks on the CloudFormation templates.
  - `stub/aws`, `cf-echo.jq` and `fixtures/live-like.json`: test doubles.
- [`tests/login-flow/`](../../tests/login-flow/): Playwright specs `login-flow.spec.ts` and `auth-v2.spec.ts`.
- [`scripts/mcp/token-smoke.sh`](../../scripts/mcp/token-smoke.sh): a live MCP token check.

Facts:

- The API suites run against an in-memory DynamoDB fake. They include the `@io-kit` content and comments contract suites.
- `package-api.test.js` runs `package-api.sh` against a temporary copy of the repository, with `npm` and `zip` shimmed.
- `presign.test.js` signs offline with fake credentials.
- The islands content-contract test drives the real `api/` handler.
- `bundle.test.mjs` checks that `11ty/js/islands/` is tracked and identical to a fresh build.
- The island Playwright specs run at 375 px width against a static server on `11ty/` at `127.0.0.1:8089`, so they use the committed bundles.
- `/api`, `/auth` and the data files are stubbed per test. All island fixtures are synthetic.
- `scripts/infra/test/run.sh` puts `stub/aws` first on `PATH` and never reaches AWS. It needs `bash`, `jq`, and `python3` with PyYAML.
- `tests/login-flow` targets the live site by default (`HFY_SITE_BASE`).
- The legacy spec reads its Google ID token from `HFY_TEST_ID_TOKEN`. Without that variable, it runs the helper named by `HFY_MINT_HELPER` with `python3`.
- The `HFY_MINT_HELPER` default is `../../scripts/auth/mint_test_id_token.py`, relative to the working directory. The default finds the helper from neither copy of the suite:
  - From `<project>/workspace/tests/login-flow`, it resolves to `<project>/workspace/scripts/auth/`, which does not exist.
  - From the repository copy, it resolves to `<project>/repo/scripts/auth/`, which does not exist either.
- The helper is at `<project>/scripts/auth/mint_test_id_token.py`. The suite therefore needs either `HFY_MINT_HELPER` set to that path or `HFY_TEST_ID_TOKEN`.
- The `auth-v2` spec is skipped unless `HFY_AUTH_V2=1`. Its password path also needs `HFY_TEST_EMAIL` and `HFY_TEST_PASSWORD`.
- `token-smoke.sh` validates an MCP access token from `MCP_TOKEN` against the live auth edge, without printing it.
- No workflow runs any of these suites. How to run them: [Run the tests](../how-to/run-the-tests.md).

## Sanitized samples

Paths: [`allowlist/`](../../allowlist/), [`harrisonfamily-frontend/`](../../harrisonfamily-frontend/), [`etl-output/`](../../etl-output/), [`gramps_exports/`](../../gramps_exports/), [`cloudfront/`](../../cloudfront/), [`coming-soon-index.html`](../../coming-soon-index.html).

Facts:

- These are placeholders that show the shape of the private data. The real files live under `<project>/workspace-local/`.
- `allowlist/` holds example addresses and hashes.
- `harrisonfamily-frontend/` is a synthetic set of person, family, event, media, note and place records.
- `etl-output/` holds only READMEs, and `gramps_exports/` holds only `.gitkeep`.
- The top-level README in each sample directory is a short pointer into these docs.
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

Every file under `11ty/` falls into one of the kinds below. E5 is the release that added the islands, the auth edge and the API.

- "Generated" means Eleventy output, kept as the source produced it.
- "E5-edited" means a generated file that was then changed in the repository.
- "E5-only" means a file added in the repository for E5.

Two more columns show how each kind is treated:

- "Plain refresh" is a `rsync -a --delete` from the source output that excludes only `README.md`, `private/`, `media/`, `person/`, `family/`, `event/` and `note/`: the refresh `11ty/README.md` documented before E5.
- "Sync check" is the pre-commit `check-deployment-sync.sh`.

To rebuild from the source without losing E5 files, follow [Refresh the Eleventy output](../how-to/refresh-the-eleventy-output.md).

| Files | Kind | Plain refresh | Sync check |
|---|---|---|---|
| `css/main.css`, `css/main.css.map`; `images/` except `pwa-*`; `js/auth.js`, `js/person-page.js`, `js/bootstrap.bundle.min.js` | Generated. The scripts are copied from the source's `public/js/`. | Replaced from source output. Nothing is lost. | Compared. |
| `index.html`, and `index.html` under `about/`, `contact/`, `family-login/`, `logged-out/`, `person/`, `privacy/`, `search/` and `terms/` | E5-edited. Each page has one added line, `<script src="/js/auth-v2.js" defer></script>`. | Overwritten. The tag is lost unless the source output has it. | Compared, tag included. |
| `private/index.html` | E5-edited, with the same added line. | Excluded: the refresh does not touch `private/`.[^private] | Excluded.[^private] |
| `js/search-navbar.js`, `js/search-results.js` | E5-edited. A comment and a `hfySearchV2Live()` helper at the top (lines 2–5). Stand-down checks `if (await hfySearchV2Live())` before the data load: line 103 in `search-navbar.js`, and lines 174 and 391 (in `bootstrap()`) in `search-results.js`. | Excluded. | Excluded. |
| `js/feature-flags.js` | E5-edited. The island-loader block is E5-only. It runs from `window.HFYFeatureFlags = featureAPI;` (line 253) to `onReady(applyFeatureVisibility);` (line 498). It holds flag resolution, the `?hfy_flags=` override and banner, `loadIsland` and the per-flag loaders. The rest matches the source output. | Excluded. | Excluded. |
| `_data/flags.json`, `js/auth-v2.js`, `sw.js`, `manifest.webmanifest`, `offline.html`, `posts/index.html`, `me/notifications/index.html`, `images/pwa-192.png`, `images/pwa-512.png`, `images/pwa-maskable-512.png` | E5-only. | Excluded. | Excluded. |
| `js/islands/`, including `chunks/` and `notify-sw.js` | E5-only. Committed build output of [`islands/build.mjs`](../../islands/build.mjs). | Excluded. | Excluded. |
| `README.md` | Repository note for the directory. | Excluded. | Excluded. |

[^private]: The tracked `private/index.html` is the only file under `private/`. Both the plain refresh and the sync check exclude the whole directory, so neither of them overwrites, deletes or compares it.

A copy of source output that uses `--delete` without these excludes deletes the E5-only files, including the committed islands. It also overwrites the E5-edited files.

## Top-level directories

The reverse lookup: from a directory to the capability sections above.

| Directory or file | Capability |
|---|---|
| `.github/workflows/`, `.github/actions/`, `ci.manifest.yaml` | CI and repo operations |
| `11ty/` | Static site output, front-end runtime, React islands (`11ty/js/islands/`) |
| `allowlist/`, `etl-output/`, `gramps_exports/`, `harrisonfamily-frontend/`, `coming-soon-index.html` | Sanitized samples |
| `api/` | Family API |
| `auth/` | Auth edge and MCP authorization server |
| `cloudfront/` | Infrastructure (sample distribution), sanitized samples |
| `docs/` | This documentation. |
| `functions/`, `gcloud/`, `lambda/` | Legacy sign-in |
| `infrastructure/` | Infrastructure |
| `islands/` | React islands |
| `scripts/` | CI and repo operations, infrastructure, tests |
| `tests/` | Tests |
| `workspace/` | Static site output (the stray `featureFlags.js` only) |

## Notes

- This page is a routing index, not an inventory of record. Where it and the code disagree, the code is authoritative.
- The feature flags all ship `false` in `11ty/_data/flags.json`. Until a flag is turned on, the island and `auth-v2.js` paths above are inert in production ([Toggle a feature flag](../how-to/toggle-a-feature-flag.md)). The [release model](../explanation/release-model.md) explains why.
- The `@io-kit/*` packages used by `api/`, `auth/` and `islands/` come from a private CodeArtifact registry. Each of those directories has an `.npmrc` that reads `CODEARTIFACT_AUTH_TOKEN` from the environment, so no token is stored in the repository. See [Private data and secrets](private-data-and-secrets.md).
