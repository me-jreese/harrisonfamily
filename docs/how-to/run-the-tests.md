# How to run the test suites

Use this page to run each test suite in the repository with the right prerequisites, and to know before you start which suites reach production. No workflow runs these suites, so run the ones that cover your change before you open a pull request ([Deploy a site change](deploy-a-site-change.md)). For what each suite exercises, see the **Tests** row of the [codebase map](../reference/codebase-map.md).

Values in angle brackets are placeholders. `<project>` is the private project directory, which holds the tooling and data kept outside this repository. `<site>` is the site's host name, `<gramps-id>` is the test account's Gramps ID, `<test-email>` is the sign-in email of the Cognito test user, and `<mcp-audience>` is the audience an MCP access token is issued for. The forms are listed in [Private data and secrets](../reference/private-data-and-secrets.md#placeholders).

## Which suites touch production

| Suite | Runs | What it reaches |
| --- | --- | --- |
| API, [`api/test/`](../../api/test/) | Offline | In process only: an in-memory DynamoDB fake and loopback test servers. |
| Auth edge, [`auth/test/`](../../auth/test/) | Offline | In process only: fixture environment values and in-memory stores. |
| Island contracts and bundle check, `islands/tests/*.test.mjs` | Offline | In process only: the content contract drives the real `api/` handler over the DynamoDB fake; the comments contract uses an in-memory store; the bundle test rebuilds the islands in memory and compares them with the committed ones. |
| Island browser tests, `islands/tests/*.spec.mjs` | Local | A static server on `127.0.0.1:8089` that serves `11ty/`. API, session and person-data requests are stubbed with synthetic data. Pages still request Google's sign-in script. |
| Login flow, [`tests/login-flow/`](../../tests/login-flow/) | **Live** | The production site, signed in as a real test account. Get io's go-ahead first. |
| MCP token smoke, [`scripts/mcp/token-smoke.sh`](../../scripts/mcp/token-smoke.sh) | **Live**, read only | The production auth edge's OAuth metadata and JWKS. |
| Infrastructure script tests, [`scripts/infra/test/`](../../scripts/infra/test/) | Offline | A stub `aws` command and a fixture distribution config. No call reaches AWS. |
| Infrastructure dry runs, [`scripts/infra/`](../../scripts/infra/) | **Live**, read only, or offline | Production AWS reads: secret metadata, stack outputs, the CloudFront distribution config and the origin-verify secret. Nothing changes. The three `add-*` scripts can also run fully offline. |
| Secret scan | Local; may contact providers to verify a finding | Every file on disk under the repository root, including installed `node_modules/` and leftover test reports. By default the scanner calls the matching provider's API to check each candidate secret. |

## Before you start

- **Node 22 or later.** `node --version` prints `v22` or higher. The `api/`, `auth/` and `islands/` packages declare `"node": ">=22"`.
- **`CODEARTIFACT_AUTH_TOKEN` exported** before any install in `api/`, `auth/` or `islands/`. Their `.npmrc` files fetch the `@io-kit/*` packages from a private CodeArtifact registry with that token. [Build and preview the islands](build-and-preview-the-islands.md) shows how to get one. `tests/login-flow/` installs from the public registry and does not need it.
- **Start each block from the repository root.** Every command below assumes it. Blocks that change directory do so inside parentheses, in a subshell, so your shell is back at the root when each block ends.

## Steps

### 1. Run the API suite (offline)

```sh
(cd api && npm ci && npm test)
```

`npm test` runs `vitest run` over `test/**/*.test.js` ([`vitest.config.js`](../../api/vitest.config.js)): `api`, `contracts`, `hardening`, `jwks`, `origin`, `package-api`, `presign` and `producers`. The suites run against the in-memory DynamoDB fake in [`fake-ddb.js`](../../api/test/fake-ddb.js) and sign test tokens with keys generated for each run, so they need no AWS credentials. `package-api` runs the real packaging script on a temporary copy, with `npm` and `zip` replaced by shims, so it also needs `bash`. `presign` signs offline with fake credentials.

### 2. Run the auth edge suite (offline)

```sh
(cd auth && npm ci && npm test)
```

`npm test` runs `vitest run` over [`auth/test/`](../../auth/test/): `cognito` (password provisioning), `edge` (the mount, return targets, the forgot-password rate limit and the refused sign-up confirmation), `linkstore`, `oauth` and `origin`. The tests read the committed [`edge.manifest.json`](../../auth/edge.manifest.json) and supply their own environment values. `linkstore` also reads the table's key schema from [`app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml).

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

[`playwright.config.mjs`](../../islands/playwright.config.mjs) starts the local server for you: `http-server` on `127.0.0.1:8089`, serving `../11ty`, at a 375 × 812 viewport. If something is already listening on port 8089, Playwright reuses it, so stop any other server on that port first. The specs are `flags-fallback`, `notifications`, `person`, `posts`, `search`, `shell` and `sw`. Each turns its island on with `?hfy_flags=`, so the suite passes with every flag `false` in the committed [`flags.json`](../../11ty/_data/flags.json). `flags-fallback` checks that a missing bundle or an unreachable `/auth/session` returns the page to its legacy behavior and turns the preview override off.

The default browser channel is `chrome`, which needs Google Chrome installed. To use Playwright's bundled Chromium instead:

```sh
(cd islands && npx playwright install chromium && PW_CHANNEL=chromium npx playwright test)
```

Failure output goes to `islands/test-results/`, which is gitignored.

### 5. Run the infrastructure script tests (offline)

```sh
scripts/infra/test/run.sh
```

[`run.sh`](../../scripts/infra/test/run.sh) runs the three `add-*-behavior.sh` scripts against a fixture distribution config, with a stub `aws` first on `PATH`, so no call reaches AWS. It covers the config transforms, the legacy `/api/check-allowed*` pin and its refusals, no-op re-runs, dry runs, backups and secret redaction, and it runs [`test_app_stack.py`](../../scripts/infra/test/test_app_stack.py) over `app-stack.yaml` and `github-roles.yaml`. It needs `bash`, `jq` and `python3` with PyYAML. `cfn-lint` and `shellcheck` run when they are installed and are skipped otherwise. It ends with `scripts/infra tests: <n> passed, <m> failed` and exits non-zero if any check failed. The two `create-*` scripts are not covered: dry-run them as in step 8.

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

[`login-flow.spec.ts`](../../tests/login-flow/tests/login-flow.spec.ts) drives the legacy Google sign-in, so run it while `authV2` is `false` in the published `flags.json`. It needs a Google ID token for an allowlisted test account, from one of two variables:

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

1. Install the `auth/` dependencies. The script imports `jose` from `auth/node_modules` and stops with `run npm ci in auth/ first` if it is missing.

   ```sh
   (cd auth && npm ci)
   ```

2. Get an access token by running the authorization-code flow with PKCE against `/auth/authorize` and `/auth/token`, for example from an MCP inspector. Those routes answer only when MCP redirect URIs are configured on the edge ([Identity services](../reference/identity-services.md)).
3. From the repository root, run:

   ```sh
   read -rs MCP_TOKEN && export MCP_TOKEN
   scripts/mcp/token-smoke.sh
   unset MCP_TOKEN
   ```

   The script targets the production edge by default. `--base https://<site>/auth` and `--audience <mcp-audience>` override the issuer base and the expected audience.

Each passing check prints a line that starts with `ok`. The first failing check prints `FAIL <check>` and exits 1. A token that fails signature, issuer, audience or expiry verification also exits non-zero. The output includes the token's `sub`, which is a gramps_id, so do not paste it anywhere public.

The script requires the key ID `hfy-session-1`. After the signing key is rotated to a new key ID, that check fails until the script is updated ([Rotate the session signing key](rotate-the-session-signing-key.md)).

### 8. Dry-run the infrastructure scripts (live read only, or offline)

Every script in [`scripts/infra/`](../../scripts/infra/) accepts `--dry-run` and changes nothing in that mode. A dry run still reads production AWS, so you need the `aws` CLI, operator credentials with read access, including `secretsmanager:GetSecretValue` on the origin-verify secret, and, for the three `add-*` scripts, `jq`.

The two `create-*` scripts default to `us-west-2`, but the three `add-*` scripts take no region and use the CLI's default region. Set the region first so that all five read `us-west-2`. With another default region, the `add-*` scripts stop because the stack is not found, and the secret read falls back to a placeholder.

```sh
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2
aws sts get-caller-identity
scripts/infra/create-session-key.sh --dry-run
scripts/infra/create-origin-verify.sh --dry-run
scripts/infra/add-api-behavior.sh --dry-run
scripts/infra/add-auth-behavior.sh --dry-run
scripts/infra/add-uploads-behavior.sh --dry-run
```

| Script | What the dry run reads | Output when it passes |
| --- | --- | --- |
| [`create-session-key.sh`](../../scripts/infra/create-session-key.sh) | The signing-key secret's metadata | `secret … already exists in us-west-2: no change`, or `(dry-run) would generate an RSA-2048 key (kid …) and create secret … in us-west-2` |
| [`create-origin-verify.sh`](../../scripts/infra/create-origin-verify.sh) | The origin-verify secret's metadata | `secret … already exists in us-west-2: no change`, or `(dry-run) would create secret … in us-west-2 with a random 256-bit value` |
| [`add-api-behavior.sh`](../../scripts/infra/add-api-behavior.sh) | The `FunctionUrl` stack output, the origin-verify secret (never printed) and the distribution config | A `legacy /api/check-allowed stays on origin …` line, then `distribution … already has …: no change`, or the behaviors before and after with a diff, the header value redacted, followed by `(dry-run) no changes made` |
| [`add-auth-behavior.sh`](../../scripts/infra/add-auth-behavior.sh) | The `AuthFunctionUrl` stack output, the origin-verify secret (never printed) and the distribution config | As for `add-api-behavior.sh`, without the legacy line |
| [`add-uploads-behavior.sh`](../../scripts/infra/add-uploads-behavior.sh) | The `UploadsResponseHeadersPolicyId` stack output and the distribution config | `serving /uploads/* from origin … with response headers policy …`, then `no change` or a diff and `(dry-run) no changes made` |

Other lines from the `add-*` scripts change what the result means:

- `(dry-run) origin-verify secret not read; using a placeholder` means the credentials could not read the secret, usually for lack of `secretsmanager:GetSecretValue` or because of the wrong region. The script still ends with `(dry-run) no changes made`, but it compared against a placeholder, not the real secret, so the dry run is not meaningful. Fix the credentials or the region and run it again.
- `(only the X-Origin-Verify header value differs)`, from a run that read the real secret, means the distribution's header does not match the secret, and a real run would update the header ([Rotate the origin-verify secret](rotate-the-origin-verify-secret.md)).
- A message that starts with `refusing:`, with exit status `3`, from `add-api-behavior.sh`: it cannot resolve the legacy `/api/check-allowed*` pin ([Deploy the app stack](deploy-the-app-stack.md#add-the-api-behavior-and-the-legacy-pin)).

Run `aws sts get-caller-identity` first because the two `create-*` scripts discard errors from their existence check. Without working credentials, they print `(dry-run) would …` even when the secret exists.

To dry-run the `add-*` scripts with no AWS access at all, pass a saved config and the stack value the script would read. With `--config-file`, the scripts never read Secrets Manager:

```sh
scripts/infra/add-api-behavior.sh --dry-run \
  --config-file cloudfront/distribution.json \
  --function-url https://example.lambda-url.us-west-2.on.aws/
scripts/infra/add-uploads-behavior.sh --dry-run \
  --config-file cloudfront/distribution.json --response-headers-policy-id example-policy-id
```

`--config-file` accepts either the output of `aws cloudfront get-distribution-config` or a bare `DistributionConfig`, and the scripts refuse it without `--dry-run`. With the sanitized sample [`cloudfront/distribution.json`](../../cloudfront/distribution.json), whose legacy `/api/*` behavior targets an API Gateway origin, the API dry run shows that behavior cloned as the `/api/check-allowed*` pin and `/api/*` retargeted to the new origin, with the header shown as `<origin-verify-secret>`. Offline, the API and auth scripts print `(dry-run) origin-verify secret not read; using a placeholder`, which is expected there. `add-auth-behavior.sh` takes the same flags as `add-api-behavior.sh`.

### 9. Run the secret scan

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
| Island contracts | The `node --test` summary shows `fail 0` (`ℹ fail 0` in a terminal, `# fail 0` when piped). |
| Island browser tests, login flow | Playwright reports `passed` with no `failed`. In the authV2 run, a skipped password test means `HFY_TEST_EMAIL` or `HFY_TEST_PASSWORD` was not set, so that path was not tested. |
| MCP token smoke | Every line starts with `ok`. |
| Island bundle check | `11ty/js/islands is up to date (<n> files)`. |
| Infrastructure script tests | `scripts/infra tests: <n> passed, 0 failed`. |
| Infrastructure dry runs | Each script prints `no change` or `(dry-run) would …`, or ends with `(dry-run) no changes made`, and no `add-*` script printed `(dry-run) origin-verify secret not read; using a placeholder`. |
| Secret scan | Exit `0`. |

## If a suite fails

| Symptom | Cause | Fix |
| --- | --- | --- |
| `npm ci` fails with 401 or 403 on an `@io-kit/*` package | `CODEARTIFACT_AUTH_TOKEN` is missing or expired | Export a fresh token ([Build and preview the islands](build-and-preview-the-islands.md)). |
| The content contract cannot find a package | `api/` dependencies are not installed | `(cd api && npm ci)` |
| Playwright cannot find the `chrome` distribution | Google Chrome is not installed | Use `PW_CHANNEL=chromium`, as in step 4. |
| Island specs time out waiting for an island | The bundles are missing or stale, or another server holds port 8089 | Run `(cd islands && npm run check:islands)`; if it reports stale files, rebuild with `(cd islands && npm run build)` and commit the result. Stop the other server. |
| The bundle test or `check:islands` fails | The committed bundles do not match `islands/src/` | Rebuild and commit them ([Build and preview the islands](build-and-preview-the-islands.md)). |
| `scripts/infra/test/run.sh` reports `python3 with PyYAML is required for test_app_stack.py` | PyYAML is not installed | `python3 -m pip install pyyaml`, then run it again. |
| The legacy spec fails before the page loads, with a `python3` error | `HFY_MINT_HELPER` is unset, so the spec runs the default path, which does not reach the helper | Set `HFY_TEST_ID_TOKEN`, or set `HFY_MINT_HELPER` to the helper's absolute path. |
| The legacy spec never shows the signed-in navigation | The token expired, the account is not on the allowlist, or `authV2` is on | Mint a new token, or see [Diagnose sign-in and API failures](diagnose-sign-in-and-api-failures.md). |
| `token-smoke.sh` fails the RS256 check on the key ID | The signing key was rotated to a new key ID | Update the script ([Rotate the session signing key](rotate-the-session-signing-key.md)). |
| An `add-*` dry run prints `origin-verify secret not read; using a placeholder` | The credentials lack `secretsmanager:GetSecretValue`, or the CLI region is not `us-west-2` | Fix the credentials or export `AWS_REGION=us-west-2`, then run the dry run again. |

## Related pages

- [Repository operations](../reference/repository-operations.md): the workflows, the pre-commit hook and the scripts.
- [Codebase map](../reference/codebase-map.md): where each suite lives and what it covers.
- [Identity services](../reference/identity-services.md): the auth edge, its OAuth server and the session key.
- [API](../reference/api.md): the routes and rules the API suite covers.
- [Release model](../explanation/release-model.md): why live checks run against production rather than a staging copy.
- [Build and preview the islands](build-and-preview-the-islands.md), [Deploy a site change](deploy-a-site-change.md), [Deploy the app stack](deploy-the-app-stack.md), [Rotate the origin-verify secret](rotate-the-origin-verify-secret.md), [Toggle a feature flag](toggle-a-feature-flag.md).
