# How to run the test suites

Use this page to run each test suite in the repository with the right prerequisites, and to know before you start which suites reach production. No workflow runs these suites, so run the ones that cover your change before you open a pull request ([Deploy a site change](deploy-a-site-change.md)). For what each suite exercises, see the **Tests** row of the [codebase map](../reference/codebase-map.md) and the [test suites table](../reference/repository-operations.md#test-suites) in Repository operations.

Values in angle brackets are placeholders. `<project>` is the private project directory, which holds the tooling and data kept outside this repository. `<site>` is the site's host name, `<gramps-id>` is the test account's Gramps ID, and `<test-email>` is the sign-in email of the Cognito test user. `<app-stack>` is the name of the live app stack, which is not `hfy-app`, the `--stack` default of the app behavior scripts. `<distribution-id>` is the CloudFront distribution and `<aws-account-id>` is the AWS account. The forms are listed in [Private data and secrets](../reference/private-data-and-secrets.md#placeholders).

## Which suites touch production

| Suite | Runs | What it reaches |
| --- | --- | --- |
| API, [`api/test/`](../../api/test/) | Offline | In process only: an in-memory DynamoDB fake, loopback test servers and keys generated for the run. `api`, `package-api` and `mcp-infra` also run repository scripts in child processes, on fixture input, with no AWS call. The run writes generated documents to `api/dist/`, which is gitignored. |
| Auth edge, [`auth/test/`](../../auth/test/) | Offline | In process only: fixture environment values, in-memory stores, a fake DynamoDB table and a loopback JWKS server. |
| Passkey end to end, [`auth/e2e/passkey.e2e.mjs`](../../auth/e2e/passkey.e2e.mjs) | Local | The real auth edge app, served in process at `http://localhost:<E2E_PORT>` (default `4173`) with test-only wiring and synthetic data, driven by Playwright's Chromium with a virtual authenticator. The login page still requests Google's sign-in script. |
| Edge gate, [`edge-gate/test/`](../../edge-gate/test/) | Offline | In process only: RSA keys generated for the run, a stubbed JWKS fetch and a fixed clock. |
| Client scripts, [`tests/client/`](../../tests/client/) | Offline | In process only: the real `11ty/js/feature-flags.js` and `auth-v2.js` in a `vm` sandbox with stubbed `fetch`, storage and location. |
| Island contracts and bundle check, `islands/tests/*.test.mjs` | Offline | In process only: the content contract drives the real `api/` handler over the DynamoDB fake; the comments contract uses an in-memory store; the bundle test rebuilds the islands in memory and compares them with the committed ones. |
| Island browser tests, `islands/tests/*.spec.mjs` | Local | A static server on `127.0.0.1:8089` that serves `11ty/`. The specs stub the API, `/auth/*` and data requests they make with synthetic data. The `notifications`, `search` and `shell` specs let pages request Google's sign-in script; the others block it. |
| MCP conformance gate, [`scripts/ci/mcp-conformance.sh`](../../scripts/ci/mcp-conformance.sh) | Offline; needs `CODEARTIFACT_AUTH_TOKEN` | In process only: three files of the API suite, then `io-kit parity diff` over documents it generates in `api/dist/`. When `api/node_modules` is missing, it first installs from the private registry. |
| Login flow, [`tests/login-flow/`](../../tests/login-flow/) | **Live** | The production site, signed in as a real test account. Get io's go-ahead first. |
| MCP token smoke, [`scripts/mcp/token-smoke.sh`](../../scripts/mcp/token-smoke.sh) | **Live**, read only | The production auth edge's OAuth metadata and JWKS. |
| Infrastructure script tests, [`scripts/infra/test/`](../../scripts/infra/test/) | Offline | A stub `aws` command, a fixture distribution config, and scratch copies and a scratch Git repository in a temporary directory. No call reaches AWS. |
| Infrastructure dry runs, [`scripts/infra/`](../../scripts/infra/) | **Live**, read only, or offline | Production AWS reads: secret metadata, the origin-verify secret, stack outputs in `us-west-2` and `us-east-1`, the CloudFront distribution config and the account's response headers policies. Nothing changes. All five `add-*` scripts can also run fully offline. |
| Secret scan | Local; may contact providers to verify a finding | Every file on disk under the repository root, including installed `node_modules/` and leftover test reports. By default the scanner calls the matching provider's API to check each candidate secret. |

## Before you start

- **Node 22 or later.** `node --version` prints `v22` or higher. The `api/`, `auth/`, `edge-gate/` and `islands/` packages declare `"node": ">=22"`. `tests/client/` has no package and runs on the same Node.
- **`CODEARTIFACT_AUTH_TOKEN` exported** before any install in `api/`, `auth/` or `islands/`, and before `scripts/ci/mcp-conformance.sh`, which stops without it even when `api/` is already installed. Their `.npmrc` files fetch the `@io-kit/*` packages from a private CodeArtifact registry with that token. [Build and preview the islands](build-and-preview-the-islands.md) shows how to get one. `edge-gate/` has no dependencies and `tests/client/` has no package, so neither installs anything. `tests/login-flow/` installs from the public registry and does not need the token.
- **Start each block from the repository root.** Every command below assumes it. Blocks that change directory do so inside parentheses, in a subshell, so your shell is back at the root when each block ends.

## Steps

Run the steps that cover your change. Steps 3 and 4 need the `api/` install from step 1, and step 10 needs the `auth/` install from step 2. Run the secret scan, step 13, last.

### 1. Run the API suite (offline)

```sh
(cd api && npm ci && npm test)
```

`npm test` runs `vitest run` over `test/**/*.test.js` ([`vitest.config.js`](../../api/vitest.config.js)): `api`, `contracts`, `hardening`, `jwks`, `labels`, `mcp`, `mcp-conformance`, `mcp-infra`, `origin`, `package-api`, `presign` and `producers`. The suites run against the in-memory DynamoDB fake in [`fake-ddb.js`](../../api/test/fake-ddb.js) and sign test tokens with keys generated for each run, so they need no AWS credentials.

- `labels` checks that author labels come from the person record's `displayName`, never from an email address (HFY-R68).
- `mcp` drives the mounted MCP server through the groups config, the permission policy and the API's own route handlers.
- `mcp-conformance` runs the `@io-kit/mcp` conformance corpus, MCP-C01 to MCP-C12, against this repository's MCP edge and core, with the corpus's test-only keys.
- `mcp-infra` runs [`add-mcp-behavior.sh`](../../scripts/infra/add-mcp-behavior.sh) as an offline dry run against the infra fixture config, so it needs `bash` and `jq`, and it runs `shellcheck` on the script when `shellcheck` is installed. It also runs the inline 401-restore code of [`mcp-edge401.us-east-1.yaml`](../../infrastructure/mcp-edge401.us-east-1.yaml) and checks that `tools/list` matches the capabilities.
- `package-api` runs the real packaging script on a temporary copy, with `npm` and `zip` replaced by shims, so it also needs `bash`.
- `presign` signs offline with fake credentials.

The `api` suite runs `scripts/gen-caps.mjs`, which writes the generated documents to `api/dist/`. That directory is gitignored.

### 2. Run the auth edge suite (offline)

```sh
(cd auth && npm ci && npm test)
```

`npm test` runs `vitest run` over [`auth/test/`](../../auth/test/):

- `cognito`: password provisioning.
- `edge`: the mount, return targets, the forgot-password rate limit and the refused sign-up confirmation.
- `linkstore`: the identity link store on a fake table that applies DynamoDB's sparse-index rule.
- `oauth`: the MCP authorization server.
- `origin`: the origin-verify check.
- `passkey`: passkey enrolment and sign-in through the edge with a software authenticator, the `amr` that reaches the session and the MCP access token, and the allowlist check on every passkey sign-in.
- `passkeystore`: the repository's passkey store on the same kind of fake table, and passkey listing and removal through `/auth/passkey`.
- `userinfo`: `/auth/userinfo` and the default MCP resource, with key rotation against a loopback JWKS server.

The tests read the committed [`edge.manifest.json`](../../auth/edge.manifest.json) and supply their own environment values. `linkstore` and `passkeystore` also read the table's key schema from [`app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml).

### 3. Run the island contract tests (offline)

[`content-contract.test.mjs`](../../islands/tests/content-contract.test.mjs) imports the real API handler and its test harness from `api/`, so `api/` needs its dependencies installed. If you skipped step 1, run `(cd api && npm ci)` first. Then:

```sh
(cd islands && npm ci && npm run test:contract)
```

`test:contract` runs `node --test tests/*.test.mjs`: the content contract; the comments contract in [`contract.test.mjs`](../../islands/tests/contract.test.mjs), which runs over an in-memory store; and [`bundle.test.mjs`](../../islands/tests/bundle.test.mjs), which fails when the committed bundles in `11ty/js/islands/` are missing, gitignored or different from a fresh build of `islands/src/`. The bundle test runs `git check-ignore`, so run it from a Git checkout.

To run only the bundle comparison, with a list of what differs:

```sh
(cd islands && npm run check:islands)
```

It prints `11ty/js/islands is up to date (<n> files)`. Anything else means the committed bundles are stale: rebuild and commit them ([Build and preview the islands](build-and-preview-the-islands.md)).

### 4. Run the island browser tests (local)

1. Make sure the bundles match the source. The specs load the committed bundles from `11ty/js/islands/`. If you changed anything under `islands/src/`, rebuild first ([Build and preview the islands](build-and-preview-the-islands.md)); `npm run check:islands` from step 3 tells you whether you need to.
2. Run the suite:

   ```sh
   (cd islands && npm test)
   ```

   `npm test` runs the contract tests from step 3 and then `playwright test`, so it also needs the `api/` install. To run only the browser tests, run `(cd islands && npx playwright test)` instead.

[`playwright.config.mjs`](../../islands/playwright.config.mjs) starts the local server for you: `http-server` on `127.0.0.1:8089`, serving `../11ty`, at a 375 × 812 viewport. If something is already listening on port 8089, Playwright reuses it, so stop any other server on that port first. The specs are `auth-continuity`, `flags-fallback`, `notifications`, `person`, `posts`, `search`, `shell` and `sw`. Each spec turns on the flags it needs with `?hfy_flags=`, so the suite passes with every flag `false` in the committed [`flags.json`](../../11ty/_data/flags.json).

- `auth-continuity` checks `authV2` session continuity on the real pages (HFY-R66). A lapsed session is refreshed once through `/auth/refresh` before the data fetch. A gate `401` is refreshed and the request retried once. A lost refresh token sends the visitor to `/auth/login` once, with no loop. With `authV2` off, pages make no `/auth/session` or `/auth/refresh` request.
- `flags-fallback` checks that a missing bundle or an unreachable `/auth/session` returns the page to its legacy behavior and turns the preview override off.

The default browser channel is `chrome`, which needs Google Chrome installed. To use Playwright's bundled Chromium instead:

```sh
(cd islands && npx playwright install chromium && PW_CHANNEL=chromium npx playwright test)
```

Failure output goes to `islands/test-results/`, which is gitignored.

### 5. Run the infrastructure script tests (offline)

```sh
scripts/infra/test/run.sh
```

[`run.sh`](../../scripts/infra/test/run.sh) puts a stub `aws` first on `PATH`, so no call reaches AWS. It covers:

- **Four of the five behavior scripts.** `add-api-behavior.sh`, `add-auth-behavior.sh`, `add-uploads-behavior.sh` and `add-data-gate-behaviors.sh` run against a fixture distribution config. The checks cover the config transforms, the legacy `/api/check-allowed*` pin and its refusals, the gated data behaviors and their order, version ARN refusals, the lookup, creation and repair of the `hfy-private-no-store` response headers policy, `--remove`, no-op re-runs, dry runs, offline dry runs against [`cloudfront/distribution.json`](../../cloudfront/distribution.json), backups and secret redaction. `add-mcp-behavior.sh` is covered by the `mcp-infra` file of the API suite instead (step 1).
- **The templates.** [`test_app_stack.py`](../../scripts/infra/test/test_app_stack.py) checks `app-stack.yaml` and `github-roles.yaml`. [`test_edge_gate_stack.py`](../../scripts/infra/test/test_edge_gate_stack.py) and [`test_mcp_edge401_stack.py`](../../scripts/infra/test/test_mcp_edge401_stack.py) check the two `us-east-1` edge stack templates.
- **The gate's package.** It runs [`package-edge-gate.sh`](../../scripts/ci/package-edge-gate.sh) on a scratch copy and checks the content-addressed `CodeKey`, the reproducible build, and a new key after a code or config change.
- **The `11ty/` refresh excludes.** It checks that the `11ty/` excludes of `check-deployment-sync.sh` match the refresh `rsync` in [`11ty/README.md`](../../11ty/README.md), then runs `check-deployment-sync.sh` in a scratch Git repository.

It needs `bash`, `jq` and `python3` with PyYAML. The `package-edge-gate.sh` checks also need `node`, `zip` and `openssl`, and the sync-check run needs `rsync` and `git`. When those are missing, the script prints `(node, zip or openssl missing: package-edge-gate.sh checks skipped)` or `(rsync or git missing: check-deployment-sync.sh run skipped)` and goes on. `cfn-lint`, on the three templates, and `shellcheck` run when they are installed and are skipped otherwise. It ends with `scripts/infra tests: <n> passed, <m> failed` and exits non-zero if any check failed. The two `create-*` scripts are not covered: dry-run them as in step 12.

### 6. Run the login flow (live production)

> **Warning.** This suite signs in to the production site as a real account and opens real family pages. Get io's go-ahead before you run it. Its HTML report, failure videos and logs, in `playwright-report/`, `test-results/` and `logs/`, can show family data. All three are gitignored. Keep them on your machine and delete them when you are done, as shown at the end of this step.

Install once:

```sh
(cd tests/login-flow && npm install && npx playwright install chromium webkit)
```

The suite has no lockfile, so use `npm install`. Every test runs in both the `chromium` and the `webkit` project ([`playwright.config.ts`](../../tests/login-flow/playwright.config.ts)).

Rules for every run:

- **Set `HFY_SITE_BASE` explicitly.** When it is unset, the config and both specs fall back to the production site.
- **Pass credentials as environment variables.** The config does not load a `.env` file. Neither `.gitignore` lists `.env`, so a `.env` file in the checkout would be picked up by `git add`. Never create one there, and never commit one.
- **Read secrets with `read -rs`**, as below, so that they stay out of your shell history.
- **Run each block whole, with its parentheses.** The variables then exist only in that subshell. When the block ends, the secrets are gone, and `HFY_AUTH_V2=1` from an authV2 run cannot carry over into a later run.
- **Name the spec file.** Playwright treats each file argument as a case-insensitive regular expression and matches it against the spec's full path. Both specs sit under `tests/login-flow/tests/`, so a filter such as `login-flow` matches both files.

#### Legacy sign-in

[`login-flow.spec.ts`](../../tests/login-flow/tests/login-flow.spec.ts) drives the legacy Google sign-in, so run it only while `authV2` is `false` in the published `flags.json`, which is before the [cut-over](cut-over-to-the-private-data-gate.md). It needs a Google ID token for an allowlisted test account, from one of two variables:

- `HFY_TEST_ID_TOKEN`: a token you minted beforehand. A Google ID token expires about an hour after it is minted.
- `HFY_MINT_HELPER`: the path to `<project>/scripts/auth/mint_test_id_token.py`, which lives outside the repository. The spec runs it with `python3` and reads the token from its output. The default path, `../../scripts/auth/mint_test_id_token.py` relative to the current directory, does not reach the helper from the repository or from `<project>/workspace/tests/login-flow`, so always set `HFY_MINT_HELPER` to the helper's absolute path.

```sh
(
  cd tests/login-flow
  export HFY_SITE_BASE=https://<site>
  export HFY_EXPECT_GRAMPS=<gramps-id>
  read -rs HFY_TEST_ID_TOKEN && export HFY_TEST_ID_TOKEN   # paste the token; nothing is echoed
  npx playwright test tests/login-flow.spec.ts
)
```

`HFY_EXPECT_GRAMPS` is the test account's record ID. The spec signs in, checks that **My Record** links to `/person/?id=<gramps-id>`, runs a search, checks that `/family-login/` now redirects to that record, and signs out. If the test passes, it writes the browser console log, and any failed-request log, to `logs/`. A failing run writes nothing there.

#### authV2 sign-in

[`auth-v2.spec.ts`](../../tests/login-flow/tests/auth-v2.spec.ts) is skipped unless `HFY_AUTH_V2=1`. Run it once `authV2` is `true` in the published `flags.json`. Before that, its redirect test fails. The password test needs a user in the production user pool who is on the allowlist, and it is skipped when `HFY_TEST_EMAIL` or `HFY_TEST_PASSWORD` is missing.

```sh
(
  cd tests/login-flow
  export HFY_SITE_BASE=https://<site> HFY_AUTH_V2=1
  export HFY_TEST_EMAIL=<test-email> HFY_EXPECT_GRAMPS=<gramps-id>
  read -rs HFY_TEST_PASSWORD && export HFY_TEST_PASSWORD   # type the password; nothing is echoed
  npx playwright test tests/auth-v2.spec.ts
)
```

The spec checks the `/family-login/` redirect to `/auth/login`, the two sign-in paths on that page, the published JWKS, the signed-out session, and a password sign-in whose session `sub` and **My Record** link match `HFY_EXPECT_GRAMPS`.

#### After either run

Open the report, then delete the report, the failure output and the logs:

```sh
(cd tests/login-flow && npx playwright show-report)
(cd tests/login-flow && rm -rf playwright-report test-results logs)
```

`show-report` serves the report until you press Ctrl+C. If you exported any of the variables directly in your shell instead of inside a block, clear them all with `unset HFY_TEST_ID_TOKEN HFY_TEST_PASSWORD HFY_AUTH_V2 HFY_TEST_EMAIL`.

### 7. Run the MCP token smoke check (live)

The script validates an MCP access token against the production auth edge. It only reads the edge's metadata and JWKS, and it never prints the token.

1. Install the `auth/` dependencies. The script imports `jose` from `auth/node_modules` and stops with `run npm ci in auth/ first (needs jose)` if it is missing.

   ```sh
   (cd auth && npm ci)
   ```

2. Get an access token for the resource `https://<site>/mcp` by running the authorization-code flow with PKCE against `/auth/authorize` and `/auth/token`, for example from an MCP inspector. Those routes answer only when MCP redirect URIs are configured on the edge, and only for a callback listed exactly in the `McpRedirectUris` stack parameter. The stack default lists only Claude's two callbacks, so an inspector's callback must be added first ([An MCP client cannot connect](diagnose-sign-in-and-api-failures.md#an-mcp-client-cannot-connect), [Identity services](../reference/identity-services.md#mcp-authorization-server)).
3. From the repository root, run:

   ```sh
   read -rs MCP_TOKEN && export MCP_TOKEN
   scripts/mcp/token-smoke.sh
   unset MCP_TOKEN
   ```

   The script targets the production edge by default: the issuer base `https://<site>/auth` and the expected audience `https://<site>/mcp`. `--base` and `--audience` override them. Pass `--audience` only for a token issued for another resource.

The script checks the discovery document (issuer, PKCE with S256 only, public client only, both grant types, and the authorization, token and registration endpoints), then the token: its RS256 signature against the live JWKS, its key ID, issuer, audience, a `sub` that is a gramps_id, `groups` that include `members`, and a lifetime of at most an hour. Each passing check prints a line that starts with `ok`. The first failing check prints `FAIL <check>` and exits 1. A token that fails signature, issuer, audience or expiry verification also exits non-zero. The output includes the token's `sub`, which is a gramps_id, and its groups, so do not paste it anywhere public.

The script requires the key ID `hfy-session-1`. After the signing key is rotated to a new key ID, that check fails until the script is updated ([Rotate the session signing key](rotate-the-session-signing-key.md)).

### 8. Run the edge gate tests (offline)

```sh
(cd edge-gate && npm test)
```

The gate has no dependencies, so there is nothing to install and no token to export. `npm test` runs `node --test test/*.test.mjs` over [`gate.test.mjs`](../../edge-gate/test/gate.test.mjs), which runs [`src/gate.mjs`](../../edge-gate/src/gate.mjs) with RSA keys generated for the run, a stubbed JWKS fetch and a fixed clock. It covers:

- a valid session passing unchanged, a `401` JSON answer for fetches, and a `302` to `/auth/login?returnTo=` for page navigations;
- the signature, key ID, issuer, audience, expiry and `nbf` checks;
- the JWKS refetch for an unknown key ID, its rate limit, the short backoff after a failed fetch, and failing closed during an outage;
- `Cache-Control: private, no-store` on every response the gate makes (HFY-R65);
- [`gate.config.json`](../../edge-gate/gate.config.json) against the session settings in `auth/edge.manifest.json`.

These tests cover the source. A published version of the gate is checked separately before anything attaches it, by invoking it with synthetic viewer-request events: see [step 5 of Deploy the edge functions](deploy-the-edge-functions.md#5-validate-the-published-version-before-anything-attaches-it).

### 9. Run the client script tests (offline)

From the repository root:

```sh
node --test tests/client/*.test.mjs
```

Nothing to install. Both files load the real [`11ty/js/feature-flags.js`](../../11ty/js/feature-flags.js) into a `vm` sandbox with stubbed `fetch`, storage and location, and record every request it makes. `auth-continuity` also loads [`11ty/js/auth-v2.js`](../../11ty/js/auth-v2.js).

- [`data-fetch.test.mjs`](../../tests/client/data-fetch.test.mjs) checks the `authV2` data-fetch path (HFY-TSK-080). With `authV2` off, callers keep their legacy `X-HFY-Session` request. With it on, data requests use same-origin credentials and no `X-HFY-Session` header. The `?hfy_flags=authV2` preview override turns it on for the tab, and a gate `401` sends the visitor to the edge sign-in and back.
- [`auth-continuity.test.mjs`](../../tests/client/auth-continuity.test.mjs) checks session continuity (HFY-R66): one `/auth/session` request per page; a refresh through `/auth/refresh` before the first data fetch when the session is signed out or near expiry; a single shared refresh and one retry after a gate `401`; one trip to `/auth/login` when the refresh fails, and none for a background load; and no session or refresh request with `authV2` off.

The `auth-continuity` spec in step 4 checks the same behavior in a browser.

### 10. Run the passkey end-to-end test (local)

This needs the `auth/` install from step 2. Then:

```sh
(cd auth && npx playwright install chromium && npm run e2e)
```

`npx playwright install chromium` downloads the Chromium build for the Playwright version that `auth/` pins, `1.55.0`. The islands pin a different version, so a Chromium installed from `islands/` does not serve here. After the first run, `(cd auth && npm run e2e)` is enough.

`npm run e2e` runs [`passkey.e2e.mjs`](../../auth/e2e/passkey.e2e.mjs). It serves the real auth edge app from [`auth/src/edge.js`](../../auth/src/edge.js) in process on `127.0.0.1`, port `E2E_PORT` (default `4173`), and drives Chromium at `http://localhost:<port>` with a virtual authenticator that performs user verification. The wiring is test-only and the data is synthetic: the relying party is `localhost`, the password provider is a stub, the stores are in memory, the signing key is generated for the run, and the allowlist holds one `example.com` address. It reaches no AWS service. To use another port:

```sh
(cd auth && E2E_PORT=4180 npm run e2e)
```

The scenarios run in order: the login page offers a passkey; password sign-in; enrolling a passkey and listing it; sign-out; usernameless passkey sign-in, whose session `amr` includes `passkey` and `mfa`; refusal with `403` after the address is removed from the allowlist, and sign-in again after it is restored; and refusal with `401` for a deleted credential. Each prints `PASS  <scenario>` or `FAIL  <scenario>  <detail>`, and the run ends with `<passed>/<total> scenarios passed`. It exits 1 if any scenario failed, and writes no files.

### 11. Run the MCP conformance gate (offline)

```sh
scripts/ci/mcp-conformance.sh blocking
```

The argument is `blocking`, the default, or `report-only`. The script works in `api/` from any directory. It stops at once if `CODEARTIFACT_AUTH_TOKEN` is unset, even when `api/` is installed. It runs `npm ci` only when `api/node_modules` is missing and otherwise uses the existing install as it is, so after a change to the `api/` dependencies run `(cd api && npm ci)` first. Then, ending at the first step that fails, it:

1. runs `scripts/gen-caps.mjs`, which writes `dist/caps.json`, `dist/policy.json`, `dist/mcp/tools.json` and `dist/mcp/parity-caps.json` under `api/`;
2. runs Vitest on `test/mcp-conformance.test.js`, `test/mcp.test.js` and `test/mcp-infra.test.js`, the MCP files of the API suite from step 1;
3. runs `io-kit parity diff` over the generated tool list and capabilities, against [`api/parity/routes.yaml`](../../api/parity/routes.yaml) and [`api/parity/map.yaml`](../../api/parity/map.yaml).

In `blocking` mode, each parity finding prints a `PARITY-FAIL` line and the script exits 1. In `report-only` mode, the same findings print as `PARITY-WARN` and the script exits 0, so read the output. Either way, the parity step ends with a summary line that starts with `hfy covered`. [MCP server](../reference/mcp-server.md#conformance-gate) describes what the gate checks.

### 12. Dry-run the infrastructure scripts (live read only, or offline)

Every script in [`scripts/infra/`](../../scripts/infra/) accepts `--dry-run` and changes nothing in that mode. A dry run still reads production AWS, so you need the `aws` CLI, `jq` for the five `add-*` scripts, and operator credentials that can read:

- the secrets' metadata, and the value of the origin-verify secret (`secretsmanager:GetSecretValue`);
- the outputs and parameters of `<app-stack>` in `us-west-2`, and the outputs of `hfy-mcp-edge401` and `hfy-edge-gate` in `us-east-1`;
- the distribution config and the account's response headers policies.

The two `create-*` scripts default to `us-west-2`. The four app behavior scripts, `add-api-behavior.sh`, `add-auth-behavior.sh`, `add-uploads-behavior.sh` and `add-mcp-behavior.sh`, take no region: they read `<app-stack>`, and all but the uploads script read the origin-verify secret, in the CLI's default region, so set it to `us-west-2` first. With another default region, they stop because the stack is not found. `add-mcp-behavior.sh` reads `hfy-mcp-edge401`, and `add-data-gate-behaviors.sh` reads `hfy-edge-gate`, in `us-east-1` whatever the default region is.

Pass `--stack <app-stack>` to the four app behavior scripts. Their `--stack` default, `hfy-app`, is not the deployed name, and without the flag they stop with `Stack with id hfy-app does not exist`. Do not pass it to `add-data-gate-behaviors.sh`: its `--stack` names the `us-east-1` gate stack, and its default, `hfy-edge-gate`, is the deployed name. Read the origin-verify secret's name from the stack and pass it with `--secret-name`, so that the scripts compare against the secret the functions use even after a [rotation](rotate-the-origin-verify-secret.md).

```sh
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2
unset ORIGIN_VERIFY
aws sts get-caller-identity
OV_NAME="$(aws cloudformation describe-stacks --stack-name <app-stack> \
  --query "Stacks[0].Parameters[?ParameterKey=='OriginVerifySecretName'].ParameterValue" --output text)"
scripts/infra/create-session-key.sh --dry-run
scripts/infra/create-origin-verify.sh --dry-run
scripts/infra/add-api-behavior.sh --dry-run --stack <app-stack> --distribution <distribution-id> --secret-name "$OV_NAME"
scripts/infra/add-auth-behavior.sh --dry-run --stack <app-stack> --distribution <distribution-id> --secret-name "$OV_NAME"
scripts/infra/add-uploads-behavior.sh --dry-run --stack <app-stack> --distribution <distribution-id>
scripts/infra/add-mcp-behavior.sh --dry-run --stack <app-stack> --distribution <distribution-id> --secret-name "$OV_NAME"
scripts/infra/add-data-gate-behaviors.sh --dry-run --distribution <distribution-id>
```

`ORIGIN_VERIFY` is unset because the scripts use it in preference to the secret.

| Script | What the dry run reads | Output when it passes |
| --- | --- | --- |
| [`create-session-key.sh`](../../scripts/infra/create-session-key.sh) | The signing-key secret's metadata | `secret … already exists in us-west-2: no change`, or `(dry-run) would generate an RSA-2048 key (kid …) and create secret … in us-west-2` |
| [`create-origin-verify.sh`](../../scripts/infra/create-origin-verify.sh) | The origin-verify secret's metadata | `secret … already exists in us-west-2: no change`, or `(dry-run) would create secret … in us-west-2 with a random 256-bit value` |
| [`add-api-behavior.sh`](../../scripts/infra/add-api-behavior.sh) | The `FunctionUrl` output of `<app-stack>`, the origin-verify secret (never printed) and the distribution config | A `legacy /api/check-allowed stays on origin …` line, then `distribution … already has …: no change`, or the behaviors before and after with a diff, the header value redacted, followed by `(dry-run) no changes made` |
| [`add-auth-behavior.sh`](../../scripts/infra/add-auth-behavior.sh) | The `AuthFunctionUrl` output of `<app-stack>`, the origin-verify secret (never printed) and the distribution config | As for `add-api-behavior.sh`, without the legacy line |
| [`add-uploads-behavior.sh`](../../scripts/infra/add-uploads-behavior.sh) | The `UploadsResponseHeadersPolicyId` output of `<app-stack>` and the distribution config | `serving /uploads/* from origin … with response headers policy …`, then `no change` or a diff and `(dry-run) no changes made` |
| [`add-mcp-behavior.sh`](../../scripts/infra/add-mcp-behavior.sh) | The `FunctionUrl` output of `<app-stack>`, the `Edge401FunctionVersionArn` output of `hfy-mcp-edge401` in `us-east-1`, the origin-verify secret (never printed) and the distribution config | `distribution … already has the MCP behaviors (/mcp* /.well-known/oauth-protected-resource*) with the Lambda@Edge 401 restore: no change`, or the behaviors before and after with a diff and `(dry-run) no changes made` |
| [`add-data-gate-behaviors.sh`](../../scripts/infra/add-data-gate-behaviors.sh) | The distribution config, the `EdgeGateVersionArn` output of `hfy-edge-gate` in `us-east-1`, and the account's custom response headers policies, to find `hfy-private-no-store`. It does not read the origin-verify secret. | A policy line: `response headers policy hfy-private-no-store (<policy-id>) already forces Cache-Control: private, no-store`, or `(dry-run) would create response headers policy hfy-private-no-store …` before the first attach. Then `gating /person/*.json /family/* /event/* /note/* /place/* /media/* on origin … with arn:aws:lambda:us-east-1:<aws-account-id>:function:hfy-edge-gate:<n> …`. Once the gate is attached, `distribution … already has the data-gate behaviors …: no change`. Before the [cut-over](cut-over-to-the-private-data-gate.md), a diff that adds the six gated behaviors, and `(dry-run) no changes made`. |

Other lines from the `add-*` scripts change what the result means:

- `(dry-run) origin-verify secret not read; using a placeholder`, from the API, auth or MCP script, means the credentials could not read the secret, usually for lack of `secretsmanager:GetSecretValue` or because of the wrong region or secret name. The script still ends with `(dry-run) no changes made`, but it compared against a placeholder, not the real secret, so the dry run is not meaningful. Fix the credentials, the region or `OV_NAME` and run it again.
- `(dry-run) Lambda@Edge version ARN not resolved; using a placeholder`, from `add-mcp-behavior.sh`, means it could not read `hfy-mcp-edge401` in `us-east-1`. The diff then compares against a made-up ARN, so the dry run is not meaningful. A real run would stop. Deploy the stack ([Deploy the edge functions](deploy-the-edge-functions.md#1-deploy-the-mcp-401-restore-function)), or check that your credentials can read it.
- `(only the X-Origin-Verify header value differs)`, from a run that read the real secret, means the distribution's header does not match the secret, and a real run would update the header ([Rotate the origin-verify secret](rotate-the-origin-verify-secret.md)).
- A diff that changes only the version at the end of a `LambdaFunctionARN`, from `add-mcp-behavior.sh` or `add-data-gate-behaviors.sh`, means the edge stack has published a newer version than the one attached. A real run would move live traffic to it. For the gate, validate that version first, as in [step 5 of Deploy the edge functions](deploy-the-edge-functions.md#5-validate-the-published-version-before-anything-attaches-it).
- `(dry-run) would put response headers policy hfy-private-no-store (<policy-id>) back …`, from `add-data-gate-behaviors.sh`, means someone changed the policy so that it no longer forces `Cache-Control: private, no-store`. A real run would restore it.
- A message that starts with `refusing:`, with exit status `3`: from `add-api-behavior.sh`, it cannot resolve the legacy `/api/check-allowed*` pin ([Deploy the app stack](deploy-the-app-stack.md#add-the-api-behavior-and-the-legacy-pin)); from `add-mcp-behavior.sh`, an earlier behavior would shadow an MCP path ([Deploy the app stack](deploy-the-app-stack.md#8-route-mcp-and-the-protected-resource-metadata)).

Run `aws sts get-caller-identity` first because the two `create-*` scripts discard errors from their existence check. Without working credentials, they print `(dry-run) would …` even when the secret exists.

To dry-run the `add-*` scripts with no AWS access at all, pass a saved config and the stack values the script would read. With `--config-file`, the scripts never read Secrets Manager or look up the response headers policy, and `add-mcp-behavior.sh` never reads `hfy-mcp-edge401`:

```sh
scripts/infra/add-api-behavior.sh --dry-run \
  --config-file cloudfront/distribution.json \
  --function-url https://example.lambda-url.us-west-2.on.aws/
scripts/infra/add-uploads-behavior.sh --dry-run \
  --config-file cloudfront/distribution.json --response-headers-policy-id example-policy-id
scripts/infra/add-mcp-behavior.sh --dry-run \
  --config-file cloudfront/distribution.json \
  --function-url https://example.lambda-url.us-west-2.on.aws/
scripts/infra/add-data-gate-behaviors.sh --dry-run \
  --config-file cloudfront/distribution.json \
  --version-arn arn:aws:lambda:us-east-1:000000000000:function:hfy-edge-gate:1
```

`--config-file` accepts either the output of `aws cloudfront get-distribution-config` or a bare `DistributionConfig`, and the scripts refuse it without `--dry-run`. `add-auth-behavior.sh` takes the same flags as `add-api-behavior.sh`. With the sanitized sample [`cloudfront/distribution.json`](../../cloudfront/distribution.json), whose legacy `/api/*` behavior targets an API Gateway origin:

- the API dry run shows that behavior cloned as the `/api/check-allowed*` pin and `/api/*` retargeted to the new origin, with the header shown as `<origin-verify-secret>`;
- the MCP dry run adds `/mcp*` and `/.well-known/oauth-protected-resource*` after the existing behaviors;
- the data gate dry run adds the six gated behaviors on the default behavior's origin, each with the placeholder `<hfy-private-no-store policy id>`.

Offline, the API, auth and MCP scripts print `(dry-run) origin-verify secret not read; using a placeholder`, the MCP script also prints `(dry-run) Lambda@Edge version ARN not resolved; using a placeholder` unless you pass `--edge401-arn`, and the data gate script prints `(dry-run) response headers policy hfy-private-no-store not looked up (offline); using a placeholder id`. All three are expected there.

### 13. Run the secret scan

Delete any login-flow reports and logs first (end of step 6), because the scan reads them too. From the repository root:

```sh
trufflehog --no-update --fail filesystem .
echo $?
```

Exit `0` means nothing was found. Exit `183` means findings: `--fail` sets that code. Any other code is a scanner error. The scan reads every file on disk under the directory, tracked or not, including installed `node_modules/`, so it can be slow and can report findings outside the source tree. It does not scan Git history. Install the scanner with `brew install trufflehog` if it is missing.

`--no-update` only skips the scanner's update check. By default trufflehog calls the matching provider's API to verify each candidate secret it finds. To keep the scan on your machine, add `--no-verification`.

To run the scan on every commit, enable the repository's hooks:

```sh
git config core.hooksPath scripts/git-hooks
```

The [pre-commit hook](../../scripts/git-hooks/pre-commit) then runs the deployment sync check and this scan. It blocks the commit when the sync check fails, for example because `rsync` is missing or staged `11ty/`, `lambda/` or `functions/` files differ from their sources, when the scan finds something, or when `trufflehog` is not on `PATH`. [Repository operations](../reference/repository-operations.md#git-hook-scriptsgit-hookspre-commit) describes the sync check.

## Verify

Each command you ran exits `0`. Check with `echo $?` straight after it, and read the summary:

| Suite | A pass looks like |
| --- | --- |
| API, auth edge | Vitest reports every test file passed and none failed. |
| Island contracts, edge gate, client scripts | The `node --test` summary shows `fail 0` (`ℹ fail 0` in a terminal, `# fail 0` when piped). |
| Passkey end to end | Every scenario line starts with `PASS`, and the last line reads `<n>/<n> scenarios passed`, with both numbers equal. |
| Island browser tests, login flow | Playwright reports `passed` with no `failed`. In the authV2 run, a skipped password test means `HFY_TEST_EMAIL` or `HFY_TEST_PASSWORD` was not set, so that path was not tested. |
| MCP conformance gate | Vitest reports all three files passed, and no line starts with `PARITY-FAIL`. In `report-only` mode, also check that no line starts with `PARITY-WARN`. |
| MCP token smoke | Every line starts with `ok`. |
| Island bundle check | `11ty/js/islands is up to date (<n> files)`. |
| Infrastructure script tests | `scripts/infra tests: <n> passed, 0 failed`. Any line that ends with `skipped` names checks that did not run because a tool is missing. |
| Infrastructure dry runs | Each script prints `no change` or `(dry-run) would …`, or ends with `(dry-run) no changes made`, and no `add-*` script printed a line that ends with `using a placeholder`. |
| Secret scan | Exit `0`. |

## If a suite fails

| Symptom | Cause | Fix |
| --- | --- | --- |
| `npm ci` fails with 401 or 403 on an `@io-kit/*` package | `CODEARTIFACT_AUTH_TOKEN` is missing or expired | Export a fresh token ([Build and preview the islands](build-and-preview-the-islands.md)). |
| `mcp-conformance.sh` stops at once with `set CODEARTIFACT_AUTH_TOKEN` | The token is not exported. The script checks it even when `api/` is installed. | Export a token, then run it again. |
| `mcp-conformance.sh` fails after a change to the `api/` dependencies | It installs only when `api/node_modules` is missing, so it ran against the old install | `(cd api && npm ci)`, then run it again. |
| The content contract cannot find a package | `api/` dependencies are not installed | `(cd api && npm ci)` |
| Playwright cannot find the `chrome` distribution | Google Chrome is not installed | Use `PW_CHANNEL=chromium`, as in step 4. |
| Island specs time out waiting for an island | The bundles are missing or stale, or another server holds port 8089 | Run `(cd islands && npm run check:islands)`; if it reports stale files, rebuild with `(cd islands && npm run build)` and commit the result. Stop the other server. |
| The bundle test or `check:islands` fails | The committed bundles do not match `islands/src/` | Rebuild and commit them ([Build and preview the islands](build-and-preview-the-islands.md)). |
| The passkey end-to-end run prints `FAIL  e2e run completed` with a browser launch error | Playwright's Chromium for the `auth/` version is not installed | `(cd auth && npx playwright install chromium)`, then run it again. |
| The passkey end-to-end run stops with `EADDRINUSE` | Another process holds port 4173 | Stop it, or set `E2E_PORT` to a free port. |
| `scripts/infra/test/run.sh` reports `python3 with PyYAML is required for test_app_stack.py` | PyYAML is not installed | `python3 -m pip install pyyaml`, then run it again. |
| The legacy spec fails before the page loads, with a `python3` error | `HFY_MINT_HELPER` is unset, so the spec runs the default path, which does not reach the helper | Set `HFY_TEST_ID_TOKEN`, or set `HFY_MINT_HELPER` to the helper's absolute path. |
| The legacy spec never shows the signed-in navigation | The token expired, the account is not on the allowlist, or `authV2` is on | Mint a new token, or see [Diagnose sign-in and API failures](diagnose-sign-in-and-api-failures.md). |
| `token-smoke.sh` fails the RS256 check on the key ID | The signing key was rotated to a new key ID | Update the script ([Rotate the session signing key](rotate-the-session-signing-key.md)). |
| `token-smoke.sh` fails audience verification | The token was issued for a resource other than `https://<site>/mcp` | Pass that resource with `--audience`, or get a token for `https://<site>/mcp`. |
| An app behavior script stops with `Stack with id hfy-app does not exist` | `--stack <app-stack>` was not passed | Add `--stack <app-stack>` and run it again. |
| An `add-*` dry run prints `origin-verify secret not read; using a placeholder` | The credentials lack `secretsmanager:GetSecretValue`, the CLI region is not `us-west-2`, or `--secret-name` names the wrong secret | Fix the credentials, export `AWS_REGION=us-west-2`, or set `OV_NAME` from the stack as in step 12, then run the dry run again. |
| `add-mcp-behavior.sh` prints `Lambda@Edge version ARN not resolved; using a placeholder` | `hfy-mcp-edge401` is not deployed in `us-east-1`, or the credentials cannot read it | [Deploy the edge functions](deploy-the-edge-functions.md), or fix the credentials. |
| `add-data-gate-behaviors.sh` stops with an error about `hfy-edge-gate` or `stack hfy-edge-gate has no output EdgeGateVersionArn` | The gate stack is not deployed in `us-east-1`, or the credentials cannot read it | [Deploy the edge functions](deploy-the-edge-functions.md), or fix the credentials. |

## Related pages

- [Repository operations](../reference/repository-operations.md): the workflows, the pre-commit hook, the scripts and the test suites.
- [Codebase map](../reference/codebase-map.md): where each suite lives and what it covers.
- [Identity services](../reference/identity-services.md): the auth edge, its OAuth server, passkeys, the session key and the private data gate.
- [API](../reference/api.md): the routes and rules the API suite covers.
- [MCP server](../reference/mcp-server.md): the MCP server and its conformance gate.
- [Release model](../explanation/release-model.md): why live checks run against production rather than a staging copy.
- [Build and preview the islands](build-and-preview-the-islands.md), [Deploy a site change](deploy-a-site-change.md), [Deploy the app stack](deploy-the-app-stack.md), [Deploy the edge functions](deploy-the-edge-functions.md), [Cut over to authV2 and the private data gate](cut-over-to-the-private-data-gate.md), [Connect an MCP client](connect-an-mcp-client.md), [Rotate the origin-verify secret](rotate-the-origin-verify-secret.md), [Toggle a feature flag](toggle-a-feature-flag.md).
