# Repository operations

Reference for the workflows, deploy role, scripts, hooks and test suites that build, check and ship this repository.

Paths are relative to the repository root and link to the code. For why a release is split into a deploy and a flag flip, see [the release model](../explanation/release-model.md). For step-by-step tasks, see [deploy a site change](../how-to/deploy-a-site-change.md), [roll back a site deploy](../how-to/roll-back-a-site-deploy.md), [change the CI pipeline](../how-to/change-the-ci-pipeline.md) and [run the tests](../how-to/run-the-tests.md).

## Placeholders

Identifiers that belong to the live environment are written as placeholders. The full list is in [private data and secrets](private-data-and-secrets.md#placeholders).

| Placeholder | Stands for |
|---|---|
| `<site>` | The site's public hostname. |
| `<site-bucket>` | The S3 bucket that holds the static site, the private data prefixes and member uploads. |
| `<distribution-id>` | The CloudFront distribution in front of the bucket, the API and the auth edge. |
| `<github-owner>` | The GitHub user or organization that owns the repository (the `GitHubOrg` parameter of `github-roles.yaml`). |
| `<github-repo>` | The GitHub repository name (the `GitHubRepo` parameter of `github-roles.yaml`). |
| `<gcp-project>` | The Google Cloud project of the legacy allowlist function. |
| `<allowlist-secret>` | The Secret Manager secret that the legacy allowlist function reads. |
| `<project>` | The directory that contains the checkout. See the [codebase map](codebase-map.md). |
| `<eleventy-source>` | The Eleventy project that builds `11ty/`, at `<project>/workspace/11ty-dev`. It is not under Git. See the [codebase map](codebase-map.md). |
| `<parent>` | The checkout's parent directory when the checkout is not at `<project>/repo`, as in a standalone clone or a Git worktree. |
| `<gramps-id>` | A Gramps record ID. |
| `<access-token>` | An MCP access token issued by the auth edge. |

Inside quoted messages, file names and artifact names, other angle-bracket words, such as `<sha>`, `<name>` or `<region>`, stand for the value at run time.

## Workflows

| Workflow file | Name | Triggers | What it does | Source |
|---|---|---|---|---|
| [`io-kit-ci.yml`](../../.github/workflows/io-kit-ci.yml) | io-kit CI | `pull_request`, `workflow_dispatch` | Builds, reports pipeline drift, scans for secrets. | Rendered from `ci.manifest.yaml` |
| [`io-kit-deploy.yml`](../../.github/workflows/io-kit-deploy.yml) | io-kit deploy | `push` to `main`, `workflow_dispatch` | Builds and packages a release, syncs `11ty/` to `<site-bucket>`, deploys `hfy-check-allowed`, invalidates CloudFront, runs smoke checks, and rolls back after a failed smoke check. | Rendered from `ci.manifest.yaml` |
| [`deploy-gcf-legacy.yml`](../../.github/workflows/deploy-gcf-legacy.yml) | Deploy GCF (legacy) | `push` to `main`, `workflow_dispatch` | Deploys the legacy `getAllowlist` Google Cloud Function. | Hand-maintained |

A push to `main` starts `io-kit-deploy.yml` and `deploy-gcf-legacy.yml` as separate, independent runs. The drift check and the secret scan run only in `io-kit-ci.yml`, so they run on pull requests and manual runs, not on a push to `main`. No workflow runs a test suite or builds the islands. See [what no workflow ships or runs](#what-no-workflow-ships-or-runs).

### Kit manifest: `ci.manifest.yaml`

[`ci.manifest.yaml`](../../ci.manifest.yaml) is the source of the two rendered workflows and the composite actions, rendered by `@io-kit/ci` 0.1.3.

| Field | Value | Meaning |
|---|---|---|
| `stack` | `static` | Kit stack type. |
| `branch` | `main` | Deploy branch. |
| `node_version` | `"20"` | Node version for `actions/setup-node`. |
| `build.cmd` | `bash scripts/ci/patch-client-id.sh && bash scripts/ci/package-lambda.sh` | Build command, run from the checkout root. See [build scripts](#build-scripts-scriptsci). |
| `build.out` | `11ty` | Build output directory. The build fails if it does not exist afterwards. |
| `build.env.HFY_GOOGLE_CLIENT_ID` | `{secret: HFY_GOOGLE_CLIENT_ID}` | Passed to the build from the GitHub secret. |
| `artifacts` | `dist/hfy-check-allowed.zip` | Extra files in the release artifact. |
| `parity.mode` | `report` | Drift is reported, not blocking. No `parity.baseline` is set. |
| `secrets_scan` | `trufflehog` | Secret scanner for CI. |
| `deploy.aws_role_secret` | `AWS_DEPLOY_ROLE_TO_ASSUME` | Secret that holds the OIDC deploy role ARN. |
| `deploy.region` | `us-west-2` | AWS region. |
| `deploy.targets[0]` | `kind: s3_static`, `bucket: <site-bucket>`, `distribution: <distribution-id>`, `invalidate: ["/*"]`, and seven `exclude` patterns: `person/*.json`, `media/*`, `family/*`, `event/*`, `note/*`, `place/*`, `uploads/*` | Static site target. The sync never deletes or overwrites objects under the excluded patterns: the family data prefixes and member uploads. |
| `deploy.targets[1]` | `kind: lambda`, `name: hfy-check-allowed`, `zip: dist/hfy-check-allowed.zip`, no alias | Lambda target. Without an alias, a deploy updates `$LATEST`. |
| `deploy.smoke` | `https://<site>/`, `https://<site>/family-login/` | URLs checked after a deploy. |
| `deploy.rollback.strategy` | `previous_artifact` | Rollback redeploys the release artifact of the previous successful deploy run. |

### `io-kit-ci.yml`

Workflow **io-kit CI**. Permissions: `contents: read`. Concurrency group `io-kit-ci-<ref>`, which cancels an in-progress run for the same ref. It makes no AWS call.

| Job | Needs | Steps | Fails when |
|---|---|---|---|
| `build` | | Checkout; `build` with `HFY_GOOGLE_CLIENT_ID` | The client ID is unset or empty, `npm ci` or `zip` fails, or `11ty` is missing afterwards. |
| `parity` | `build` | Checkout; `build` again (jobs do not share a workspace); `parity-report` | The drift check errors (exit 2), or drift is found in `block` mode. In `report` mode, drift goes to the step summary only. |
| `secret_scan` | | Checkout with `fetch-depth: 0`; `secret-scan` | TruffleHog reports a verified or unknown result in the commit range. |

### `io-kit-deploy.yml`

Workflow **io-kit deploy**, run name `io-kit deploy <target_environment or branch>`. `workflow_dispatch` takes two optional inputs:

- `target_environment`: a label that appears only in the run name.
- `smoke_url`: one `http://` or `https://` URL that replaces the manifest smoke URLs for that run, for a rollback drill without a manifest change. Any other value fails the smoke job, which starts the rollback.

Top-level permissions: `contents: read`. Concurrency group `io-kit-deploy-<ref>`, which does not cancel an in-progress run. A new run waits for the running one, and GitHub keeps only the newest waiting run in the group.

| Job | Needs | Extra permissions | Steps |
|---|---|---|---|
| `build` | | | Checkout; `build`; `package`, which uploads artifact `io-kit-release-<sha>` |
| `deploy` | `build` | `id-token: write` | Checkout; download `io-kit-release-<sha>` into the checkout; OIDC with `AWS_DEPLOY_ROLE_TO_ASSUME`; `deploy-static`; `deploy-lambda` |
| `invalidate` | `deploy` | `id-token: write` | Checkout; OIDC; `invalidate` (creates `/*` and waits for completion) |
| `smoke` | `invalidate` | | Checkout; `smoke`, with `override-url` from the `smoke_url` input |
| `rollback_on_smoke_fail` | `smoke` | `actions: read`, `id-token: write` | Runs only when `smoke` failed. Checkout; OIDC; `rollback` |

Every job checks out the repository because each one uses the local composite actions under `.github/actions/io-kit-ci/`. The deploy role trusts only `main` (see [deploy role](#deploy-role-github-rolesyaml)), so a manual run from another branch fails at the OIDC step of `deploy`.

Rollback runs only after a failed smoke job. If `deploy` or `invalidate` fails, `smoke` is skipped and nothing rolls back, though the bucket may already be synced. [Roll back a site deploy](../how-to/roll-back-a-site-deploy.md) covers each case.

### Composite actions: `.github/actions/io-kit-ci/`

Each action lives in its own directory under [`.github/actions/io-kit-ci/`](../../.github/actions/io-kit-ci/). Their input defaults are baked in from the manifest at render time.

| Action | What it does |
|---|---|
| `build` | Sets up Node, runs `bash -c "<build.cmd>"`, then checks that `build.out` exists. |
| `package` | Writes `.io-kit-ci/release.json` (`sha`, `ref`, `run_id`) and uploads `11ty/`, `dist/hfy-check-allowed.zip` and `release.json` as artifact `io-kit-release-<sha>`. It fails if no files are found. Retention is 90 days. |
| `deploy-static` | For each `s3_static` target: `aws s3 sync <out>/ s3://<bucket>/ --delete --only-show-errors` with one `--exclude` per pattern. |
| `deploy-lambda` | For each `lambda` target: `update-function-code`, then `aws lambda wait function-updated`. With an alias, it also publishes a version and points the alias at it. In rollback mode, an aliased target is repointed to the previous published version, and a target without an alias gets the restored zip re-uploaded. |
| `invalidate` | For each target with a distribution: `create-invalidation` on the target's paths, then `aws cloudfront wait invalidation-completed`. |
| `smoke` | Runs `curl` on each URL without following redirects (20 s timeout, 3 retries 5 s apart). A 2xx or 3xx status passes. Any other status, or no response, fails. Every URL is checked before the step fails. |
| `rollback` | Uses `gh run list` with the job's `github.token` to find the most recent successful run of `io-kit-deploy.yml` on the same branch, deletes `11ty/`, and downloads that run's `io-kit-release-<sha>`. It then runs `deploy-static`, `deploy-lambda` in rollback mode, and `invalidate`. It fails when no earlier successful run exists, as on the first run, or when that run's artifact has expired. |
| `parity-report` | Runs the vendored, dependency-free `check.cjs` and writes the result to the step summary. If `parity.baseline` is set, it also runs `npx --no-install io-kit-parity baseline check`. With no baseline, it reports "no baseline" and passes. |
| `secret-scan` | `trufflesecurity/trufflehog@v3.88.0` with `--results=verified,unknown` over the pushed or pull-request commit range. |

### Pipeline drift check: `check.cjs`

[`check.cjs`](../../.github/actions/io-kit-ci/parity-report/check.cjs) walks every `.yml`, `.yaml` and `.cjs` file under `.github/workflows/` and `.github/actions/`. It exits 0 when clean, 1 on drift and 2 on error, and reports three kinds of drift:

| Drift reason | Meaning |
|---|---|
| `hand_edit` | The file's header hash does not match its body. |
| `missing_header` | A file in `.github/actions/io-kit-ci/` or a `.github/workflows/io-kit-*` file has no rendered header. |
| `deploy_outside_kit` | Another workflow runs `aws s3 sync`, a Lambda code, configuration, version or alias update, or a CloudFront invalidation or function update. |

`deploy-gcf-legacy.yml` has no header and runs no AWS deploy command, so it reports no drift.

### Rendered and hand-maintained files

Each rendered file starts with a header line of this form:

```
# @io-kit/ci 0.1.3 rendered — do not edit; sha256:<hash of the rest of the file>
```

Rendered files are not edited by hand. A pipeline change is made in `ci.manifest.yaml` and re-rendered with the `io-kit-ci render` command of `@io-kit/ci` ([Change the CI pipeline](../how-to/change-the-ci-pipeline.md)). The `parity` job reports a hand edit as `hand_edit` drift.

| Rendered | Hand-maintained |
|---|---|
| `.github/workflows/io-kit-ci.yml`, `.github/workflows/io-kit-deploy.yml`, every file under `.github/actions/io-kit-ci/` | `ci.manifest.yaml`, `.github/workflows/deploy-gcf-legacy.yml`, every script under `scripts/ci/` |

### `deploy-gcf-legacy.yml`

Workflow **Deploy GCF (legacy)**, one job, `deploy`, on `ubuntu-latest`, with permissions `contents: read` and `id-token: write`. It has no concurrency group. Its first line is the comment `# retired by HFY-TSK-062`, and it still runs on every push to `main`.

| Variable | Value |
|---|---|
| `GCP_PROJECT_ID` | `<gcp-project>` |
| `GCF_REGION` | `us-west2` |
| `GCF_FUNCTION` | `getAllowlist` |
| `GCF_ENV_VARS` | `HFY_ALLOWLIST_SECRET=<allowlist-secret>,GCP_PROJECT=<gcp-project>` |

| # | Step | What it runs |
|---|---|---|
| 1 | Checkout | `actions/checkout@v4` |
| 2 | Authenticate to Google Cloud | `google-github-actions/auth@v2` with `credentials_json: secrets.GCP_SERVICE_ACCOUNT_KEY`, a long-lived service-account JSON key, not workload identity federation |
| 3 | Setup gcloud CLI | `google-github-actions/setup-gcloud@v2` with `project_id: <gcp-project>` |
| 4 | Verify gcloud authentication | `gcloud config set project`, `gcloud auth list` |
| 5 | Deploy Google Cloud Function | `gcloud functions deploy getAllowlist --region=us-west2 --gen2 --runtime=python311 --source=functions/get-allowlist --entry-point=get_allowlist --trigger-http --no-allow-unauthenticated --set-env-vars=$GCF_ENV_VARS`, which deploys [`functions/get-allowlist/`](../../functions/get-allowlist/) as a 2nd-gen HTTP function for authenticated callers only |

## Deploy role: `github-roles.yaml`

[`infrastructure/cloudformation/github-roles.yaml`](../../infrastructure/cloudformation/github-roles.yaml) defines the IAM role that `io-kit-deploy.yml` assumes through GitHub OIDC. Its `DeployRoleArn` output is the value of the `AWS_DEPLOY_ROLE_TO_ASSUME` secret. The stack is deployed by hand with admin credentials, as its description states. No workflow deploys it.

Trust: `sts:AssumeRoleWithWebIdentity` from the account's GitHub OIDC provider, with audience `sts.amazonaws.com` and subject `repo:<github-owner>/<github-repo>:ref:refs/heads/main`. Maximum session: 3600 seconds.

| Statement | Effect | Actions | Resources |
|---|---|---|---|
| `S3SiteSync` | Allow | `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`, `s3:ListBucket` | `<site-bucket>` and every object in it |
| `ProtectMemberUploads` | Deny | `s3:DeleteObject`, `s3:PutObject` | `<site-bucket>/uploads/*` |
| `CloudFrontInvalidation` | Allow | `cloudfront:CreateInvalidation`, `cloudfront:GetInvalidation` | `<distribution-id>` |
| `LambdaDeploy` | Allow | `lambda:UpdateFunctionCode`, `lambda:GetFunction`, `lambda:GetFunctionConfiguration`, `lambda:ListVersionsByFunction`, `lambda:PublishVersion`, `lambda:GetAlias`, `lambda:CreateAlias`, `lambda:UpdateAlias` | `hfy-check-allowed`, `hfy-api` and `hfy-auth-edge` in `us-west-2`, each with its versions and aliases |

`ProtectMemberUploads` (HFY-R58) backs up the `uploads/*` sync exclude: an explicit Deny wins over the Allow, so the role cannot write or delete any object under `uploads/`, even if a sync tried to. `GetFunctionConfiguration` and `GetInvalidation` are what the `wait` commands in `deploy-lambda` and `invalidate` poll, and the version and alias actions cover `deploy-lambda`'s aliased and rollback paths (HFY-R60).

The role has no CloudFormation, IAM, Secrets Manager or CloudFront distribution-update permissions. [`scripts/infra/test/test_app_stack.py`](../../scripts/infra/test/test_app_stack.py) checks the `ProtectMemberUploads` statement.

## GitHub secrets

| Secret | Used by | Holds |
|---|---|---|
| `AWS_DEPLOY_ROLE_TO_ASSUME` | `io-kit-deploy.yml` jobs `deploy`, `invalidate` and `rollback_on_smoke_fail` | The ARN of the OIDC deploy role, the `DeployRoleArn` output of [`github-roles.yaml`](../../infrastructure/cloudformation/github-roles.yaml). |
| `HFY_GOOGLE_CLIENT_ID` | The `build` job of `io-kit-ci.yml` and `io-kit-deploy.yml`, and the `parity` job of `io-kit-ci.yml` | The Google OAuth web client ID that replaces `REPLACE_WITH_GOOGLE_CLIENT_ID`. It appears in the served pages once deployed. |
| `GCP_SERVICE_ACCOUNT_KEY` | `deploy-gcf-legacy.yml` | A Google service-account JSON key, used only for the legacy Cloud Function. |

No workflow uses `CODEARTIFACT_AUTH_TOKEN`; it is a local shell variable for the build scripts. The rollback uses the automatic `github.token` with `actions: read`, not a repository secret. Where each value comes from, and who can read it, is in [private data and secrets](private-data-and-secrets.md).

## What no workflow ships or runs

| Item | Built or run by | How it reaches production |
|---|---|---|
| Island bundles in `11ty/js/islands/` | [`scripts/ci/build-islands.sh`](../../scripts/ci/build-islands.sh), or `npm run build` in `islands/`, by hand | They are committed build output (HFY-R58, see [`.gitignore`](../../.gitignore)) and ship with the `11ty/` sync. No workflow builds them or checks them against `islands/src/`. See [build and preview the islands](../how-to/build-and-preview-the-islands.md). |
| Lambda `hfy-api` | [`scripts/ci/package-api.sh`](../../scripts/ci/package-api.sh) builds `dist/hfy-api.zip` | By hand. The manifest's only Lambda target is `hfy-check-allowed`, although the deploy role's `LambdaDeploy` statement also covers this function. See [deploy the app stack](../how-to/deploy-the-app-stack.md). |
| Lambda `hfy-auth-edge` | [`scripts/ci/package-auth.sh`](../../scripts/ci/package-auth.sh) builds `dist/hfy-auth-edge.zip` | Same as `hfy-api`. |
| App stack ([`app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml)) and deploy-role stack | `aws cloudformation deploy`, by hand | The deploy role has no CloudFormation or IAM permissions. |
| Distribution changes and secrets | [`scripts/infra/`](#infrastructure-scripts-scriptsinfra), [`append-index.js`](#cloudfront-function-scriptscloudfrontappend-indexjs) | Applied by hand. |
| Every test suite | By hand | No workflow runs any [test suite](#test-suites). |

## Build scripts: `scripts/ci/`

| Script | Run by | Inputs | Output | Behavior |
|---|---|---|---|---|
| [`patch-client-id.sh`](../../scripts/ci/patch-client-id.sh) | `build.cmd` | `HFY_GOOGLE_CLIENT_ID`; every `*.html` and `*.js` file under `11ty/` | The same files, edited in place | Exits at once if `HFY_GOOGLE_CLIENT_ID` is unset or empty. Replaces `REPLACE_WITH_GOOGLE_CLIENT_ID` with the client ID in each file that contains it. It uses the GNU form of `sed -i`, as on the Linux runner. Run in a working checkout, it leaves the committed files modified. |
| [`package-lambda.sh`](../../scripts/ci/package-lambda.sh) | `build.cmd` | `lambda/hfy-check-allowed/` | `dist/hfy-check-allowed.zip` | Runs `npm ci` in `lambda/hfy-check-allowed`, then `zip -r` of `index.mjs`, `package.json`, `package-lock.json` and `node_modules`. |
| [`build-islands.sh`](../../scripts/ci/build-islands.sh) | Hand | `islands/package.json`, `islands/package-lock.json`, `islands/src/` | `11ty/js/islands/` (committed) | Runs `npm ci --ignore-scripts` (output suppressed) and `npm run build:islands`, then requires `11ty/js/islands/shell.js` and `shell.css` to be non-empty. |
| [`package-api.sh`](../../scripts/ci/package-api.sh) | Hand | `api/src/`, `api/scripts/`, `api/package.json`, `api/package-lock.json`, `api/.npmrc` | `dist/hfy-api.zip` (handler `src/index.handler`); `api/dist/caps.json` | Copies the inputs to a temporary stage and runs `npm ci --omit=dev --ignore-scripts` there. It removes `.npmrc` and the lockfile from the stage, then runs [`api/scripts/gen-caps.mjs`](../../api/scripts/gen-caps.mjs) inside the stage, against the packages just installed, and removes `scripts/`. It exits 1 if `dist/caps.json` is missing or empty. It copies `caps.json` to `api/dist/`, zips the stage with `-X`, and prints the zip path and size. It does not use `api/node_modules/`. |
| [`package-auth.sh`](../../scripts/ci/package-auth.sh) | Hand | `auth/src/`, `auth/edge.manifest.json`, `auth/package.json`, `auth/package-lock.json`, `auth/.npmrc` | `dist/hfy-auth-edge.zip` (handler `src/index.handler`) | Same staging and install as `package-api.sh`, with no capabilities step. |

`patch-client-id.sh` and `package-lambda.sh` resolve paths from the current directory, which is the checkout root when the `build` action runs them. The other three resolve the repository root from their own location, so they run from any directory. Those three need `CODEARTIFACT_AUTH_TOKEN` for the `@io-kit/*` packages: the `.npmrc` in each package reads it from the environment. Get it with `aws codeartifact get-authorization-token --domain io`. Each exits at once if it is unset and never prints it. `package-lambda.sh` installs from the public registry and needs no token. Outputs under `dist/` and `api/dist/` are gitignored.

## Infrastructure scripts: `scripts/infra/`

All five scripts are idempotent, accept `--dry-run`, exit 2 on an unknown argument, and never print a secret value. They run under `umask 077`, and their temporary files are deleted on exit.

| Script | Needs |
|---|---|
| [`create-session-key.sh`](../../scripts/infra/create-session-key.sh) | AWS CLI, `openssl`, `jq` |
| [`create-origin-verify.sh`](../../scripts/infra/create-origin-verify.sh) | AWS CLI, `openssl` |
| [`add-api-behavior.sh`](../../scripts/infra/add-api-behavior.sh), [`add-auth-behavior.sh`](../../scripts/infra/add-auth-behavior.sh), [`add-uploads-behavior.sh`](../../scripts/infra/add-uploads-behavior.sh) | AWS CLI, `jq`, and the shared helpers in [`scripts/infra/lib/`](../../scripts/infra/lib/) |

The offline tests for these scripts are in [`scripts/infra/test/`](../../scripts/infra/test/). See [test suites](#test-suites).

### `create-session-key.sh` and `create-origin-verify.sh`

| | `create-session-key.sh` | `create-origin-verify.sh` |
|---|---|---|
| Creates | The auth edge's RS256 session signing key (HFY-R38) | The CloudFront-to-Lambda `X-Origin-Verify` shared secret (HFY-R43) |
| Value | RSA-2048 generated locally, stored as JSON `{privateKeyPem, kid}` | 32 random bytes as hex, stored as a plain string |
| `--name` default | `harrisonfamily/auth-edge/session-signing-key` | `harrisonfamily/cloudfront/origin-verify` |
| `--kid` default | `hfy-session-1` | (no such option) |
| `--region` default | `us-west-2` | `us-west-2` |

Both scripts behave the same way:

1. Run `describe-secret`. If it succeeds, print `secret <name> already exists in <region>: no change` and exit 0. Any failure, including missing credentials, counts as "does not exist".
2. With `--dry-run`, print what would be created and exit 0.
3. Otherwise, generate the value in a temporary file, call `create-secret` with `--secret-string file://…` so the value never appears on a command line, and print the name and region of the new secret.

Neither script rotates an existing secret. See [rotate the session signing key](../how-to/rotate-the-session-signing-key.md) and [rotate the origin-verify secret](../how-to/rotate-the-origin-verify-secret.md).

### CloudFront behavior scripts

The three `add-*-behavior.sh` scripts add cache behaviors, and for the API and the auth edge an origin, to the distribution.

| | `add-api-behavior.sh` | `add-auth-behavior.sh` | `add-uploads-behavior.sh` |
|---|---|---|---|
| Path patterns | `/api/*`, plus the legacy pin `/api/check-allowed*` | `/auth/*`, `/.well-known/oauth-authorization-server*` (HFY-R44) | `/uploads/*` (HFY-R58) |
| Origin | `hfy-api-origin` (added or updated) | `hfy-auth-origin` (added or updated) | The default behavior's origin (the bucket's S3 origin), or `--origin-id`. No origin is added. |
| `--distribution` | `<distribution-id>` | `<distribution-id>` | `<distribution-id>` |
| `--stack` | `hfy-app` | `hfy-app` | `hfy-app` |
| Value read from the stack | `--function-url`, else output `FunctionUrl` | `--function-url`, else output `AuthFunctionUrl` | `--response-headers-policy-id`, else output `UploadsResponseHeadersPolicyId` |
| `--secret-name` | `harrisonfamily/cloudfront/origin-verify` | `harrisonfamily/cloudfront/origin-verify` | (no such option) |
| `ORIGIN_VERIFY` (environment) | If set, used instead of Secrets Manager | If set, used instead of Secrets Manager | Not used |
| Other options | `--legacy-origin ORIGIN_ID` | | `--origin-id ORIGIN_ID` |
| `--config-file FILE` | Dry runs only | Dry runs only | Dry runs only |

#### Origin and behavior settings

The API and auth origins are plain HTTPS custom origins at the Function URL host. Each has no Origin Access Control, injects `X-Origin-Verify`, and uses `https-only`, TLSv1.2, a 30 s read timeout and a 5 s keep-alive.

| Setting | `/api/*`, `/auth/*`, `/.well-known/oauth-authorization-server*` | `/uploads/*` |
|---|---|---|
| Viewer protocol | Redirect HTTP to HTTPS | Redirect HTTP to HTTPS |
| Compression | On | On |
| Allowed methods | All seven | `GET`, `HEAD` |
| Cached methods | `GET`, `HEAD` | `GET`, `HEAD` |
| Cache policy | Managed `CachingDisabled` | Managed `CachingOptimized` (each upload key is unique) |
| Origin request policy | Managed `AllViewerExceptHostHeader` | None |
| Response headers policy | None | The stack's `UploadsResponseHeadersPolicy`: `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox; default-src 'none'; img-src 'self'` |
| Function associations | None | None, so `HFYAppendIndex` does not run for `/uploads/*` |

#### What a run does

1. Refuse `--config-file` without `--dry-run`: print `refusing to update from --config-file (an exported config may be stale); use --dry-run, or drop --config-file to read the live config` and exit 2.
2. Resolve the stack value (the Function URL, or the response headers policy ID). If the stack has no such output, print `stack <stack> has no output <key>` and exit 1.
3. API and auth only: resolve the `X-Origin-Verify` value from `ORIGIN_VERIFY`, or from Secrets Manager unless `--config-file` is given. If neither works, a dry run prints `(dry-run) origin-verify secret not read; using a placeholder` and uses the literal `<origin-verify-secret>`, and a real run prints `cannot read secret <name> (run scripts/infra/create-origin-verify.sh)` and exits 1.
4. Read the config from `--config-file` (ETag `offline`), or with `get-distribution-config`, keeping its ETag.
5. Uploads only: check that the target origin exists in the distribution. If not, print `origin '<id>' is not in distribution <distribution-id> (pass --origin-id)` and exit 1.
6. Build the new config. An origin with the same ID, or a behavior with the same path pattern, is updated in place: it keeps its position in the list and every field the script does not manage. A missing one is appended at the end of its list. `add-api-behavior.sh` also places the legacy pin (below).
7. Compare the before and after configs in a normalized form. If they are equal, print `distribution <distribution-id> already has <what>: no change` and exit 0 without calling `update-distribution`.
8. Print the cache behaviors before and after, in evaluation order, and a unified diff with every `X-Origin-Verify` value replaced by `<redacted>`. If the redacted copies are equal, print `(only the X-Origin-Verify header value differs)`, which is what a secret rotation looks like.
9. With `--dry-run`, print `(dry-run) no changes made` and exit 0.
10. Save the pre-change config as a backup (below), print its path and a rollback command, then run `aws cloudfront update-distribution --if-match <ETag>` and print the distribution status.

The normalized form sorts string lists such as methods and TLS protocols, drops empty `Items` lists, and treats an empty string as absent for optional IDs such as `OriginRequestPolicyId` and `OriginAccessControlId`. It is used only for the comparison. The update sends the merged config as built.

The `If-Match` ETag means the update applies only if the distribution has not changed since step 4. Otherwise CloudFront rejects it, the AWS CLI's error ends the script, and nothing changes. A fully offline dry run needs `--config-file` together with `--function-url`, or with `--response-headers-policy-id` for the uploads script, and makes no AWS call.

#### Pre-change backup

Before each real update, the script saves the fetched `DistributionConfig` as `<backup-dir>/<distribution-id>-<UTC timestamp>-before.json`, mode 600. `<backup-dir>` is `HFY_CF_BACKUP_DIR` if set, otherwise `$XDG_STATE_HOME/hfy-infra/cloudfront`, otherwise `~/.local/state/hfy-infra/cloudfront`. The file holds the live `X-Origin-Verify` value, so it is a secret. The printed rollback command has the form `aws cloudfront update-distribution --id <distribution-id> --if-match <current ETag> --distribution-config file://<backup>`.

#### The legacy `/api/check-allowed*` pin

The legacy sign-in still posts to `/api/check-allowed` on the origin that serves it before the API is added. `add-api-behavior.sh` keeps that path there with a more specific `/api/check-allowed*` behavior (HFY-R58), resolved from the config before the change:

| Config before the change | Result |
|---|---|
| A `/api/check-allowed*` behavior exists and targets another origin | Kept exactly as it is. |
| A `/api/check-allowed*` behavior exists and targets `hfy-api-origin` | Refused, exit 3. |
| No pin; the first behavior matching `/api/check-allowed` targets another origin | That behavior is cloned under `/api/check-allowed*`, with the same origin, policies and associations. |
| No pin; the first behavior matching `/api/check-allowed` targets `hfy-api-origin`, or no behavior matches it and only the default behavior serves it | With `--legacy-origin <id>`, a pin to that origin is created with the API behavior settings, and an origin ID that is not in the distribution is refused with exit 3. Without it, refused with exit 3. |

The pin is placed immediately before the first other behavior that matches `/api/check-allowed`, unless it already comes before it. The script never removes or retargets the pin; HFY-TSK-069 retires it. Each run that resolves the pin prints `legacy /api/check-allowed stays on origin <origin-id> via /api/check-allowed* (ordered before /api/*; retired by HFY-TSK-069)`, and notes when `--legacy-origin` was given but not used. A refusal prints a message that starts with `refusing:`.

#### Exit status

| Status | Meaning |
|---|---|
| 0 | Updated, dry run finished, or no change needed. |
| 1 | A stack output is missing, the origin-verify secret cannot be read on a real run, or the uploads target origin is not in the distribution. |
| 2 | Unknown argument, or `--config-file` without `--dry-run`. |
| 3 | `add-api-behavior.sh` only: the legacy pin cannot be resolved. |
| Other non-zero | An AWS CLI call failed, for example `update-distribution` rejected because the ETag no longer matches. |

### Shared helpers: `scripts/infra/lib/`

| File | Contents |
|---|---|
| [`cf-common.sh`](../../scripts/infra/lib/cf-common.sh) | Sourced by the three `add-*-behavior.sh` scripts, not run on its own. It defines the managed policy IDs and the functions for argument checks, stack outputs, the origin-verify value, loading the config, and the compare, diff, backup and update step. |
| [`cf.jq`](../../scripts/infra/lib/cf.jq) | Pure `jq` functions over a `DistributionConfig`, loaded with `jq -L scripts/infra/lib 'include "cf"; …'`: `norm`, CloudFront path-pattern matching (`pattern_matches`), in-place `upsert_origin` and `upsert_behavior`, `resolve_pin` and `place_pin` for the legacy pin, and `redact_origin_verify`. |

## Other scripts

### CloudFront Function: `scripts/cloudfront/append-index.js`

[`scripts/cloudfront/append-index.js`](../../scripts/cloudfront/append-index.js) is the source of the CloudFront Function `HFYAppendIndex`. It runs on viewer requests to the default (S3) behavior.

| Request URI | Rewritten to |
|---|---|
| Ends with `/` | URI + `index.html` |
| Contains no `.` anywhere | URI + `/index.html` |
| Anything else | Unchanged |

The dot test looks at the whole URI, so a path with a dot in any segment is never rewritten. The function is published by hand with `aws cloudfront update-function` and `publish-function` (see [Stand up the static site](../how-to/stand-up-the-static-site.md#4-create-and-attach-hfyappendindex)). No workflow or stack manages it. For why the function exists, see [edge and origin design](../explanation/edge-and-origin-design.md).

### MCP token smoke: `scripts/mcp/token-smoke.sh`

[`scripts/mcp/token-smoke.sh`](../../scripts/mcp/token-smoke.sh) checks an MCP access token against the live auth edge without printing the token.

```
MCP_TOKEN=<access-token> scripts/mcp/token-smoke.sh [--base URL] [--audience URL]
```

| Argument | Default |
|---|---|
| `MCP_TOKEN` (environment, required) | None. Get one through the authorization-code + PKCE flow against `/auth/authorize` and `/auth/token`. |
| `--base` | `https://<site>/auth` |
| `--audience` | `https://mcp.<site>` |

It needs `npm ci` in `auth/` first, because it uses `jose` from `auth/node_modules`. Without it, the script prints `run npm ci in auth/ first (needs jose)` and exits 1. An unknown argument exits 2, and an unset `MCP_TOKEN` stops the script before any check.

Each check below prints a line that starts with `ok` or `FAIL`, and the first `FAIL` exits 1. Token verification is different: if the signature, issuer, audience or expiry is wrong, or the token is malformed, `jose` throws, and `node` exits non-zero with the `jose` error instead of a `FAIL` line. An unreachable metadata URL fails the same way.

| Check | Passes when |
|---|---|
| Metadata issuer | `<base>/.well-known/oauth-authorization-server` reports `issuer` equal to `--base`. |
| PKCE | `code_challenge_methods_supported` is exactly `S256`. |
| Public client | `token_endpoint_auth_methods_supported` is exactly `none`. |
| Grant types | Includes `authorization_code` and `refresh_token`. |
| Endpoints | Authorization, token and registration endpoints are present. |
| Signature | The token verifies as RS256 against `jwks_uri`, with the metadata issuer and the expected audience (a failure throws, as above). The `ok` line then also requires `kid` `hfy-session-1`. |
| `sub` | Matches `^[A-Za-z0-9_-]+$` (a gramps_id). |
| `groups` | An array that includes `members`. |
| Lifetime | `exp - iat` is at most 3600 seconds. |

The output prints the token's `sub`, which is a real gramps_id, and its groups, so it is private.

## Git hook: `scripts/git-hooks/pre-commit`

[`scripts/git-hooks/pre-commit`](../../scripts/git-hooks/pre-commit) runs from the repository root, in this order:

1. If [`scripts/check-deployment-sync.sh`](../../scripts/check-deployment-sync.sh) is executable, run it. A failure blocks the commit. If it is not executable, print a warning and continue.
2. Require `trufflehog` on `PATH`. If it is missing, exit 1.
3. Run `trufflehog --no-update --fail filesystem .`. This scans the files on disk under the checkout, not only the staged changes.

| Exit status | Meaning |
|---|---|
| 0 | No findings. The commit proceeds. |
| 183 | TruffleHog found potential secrets. |
| Any other non-zero | The sync check failed, `trufflehog` is missing, or TruffleHog itself failed. |

The hook is active in a clone whose `core.hooksPath` is `scripts/git-hooks` (`git config core.hooksPath scripts/git-hooks`). `SKIP_DEPLOYMENT_SYNC_CHECK=1` skips the sync check. The TruffleHog scan still runs.

## Workspace helper scripts

These scripts predate the E5 release. They assume the checkout sits at `<project>/repo`, with `<project>/workspace/`, `<project>/workspace-local/` and `<project>/docs/` beside it. Each one takes `<project>` to be the checkout's parent directory.

| Script | Reads | Writes | Options |
|---|---|---|---|
| [`check-deployment-sync.sh`](../../scripts/check-deployment-sync.sh) | Staged file names. For staged `11ty/*`: `<eleventy-source>/_site` against `11ty/`, with the excludes listed below. For staged `lambda/*`: `<project>/scripts/auth/check-allowed-lambda` against `lambda/hfy-check-allowed`, excluding `node_modules/`. For staged `functions/*`: `<project>/workspace/gcloud/allowlist-fn` against `functions/get-allowlist`. | Nothing | `SKIP_DEPLOYMENT_SYNC_CHECK=1` |
| [`validate_build.sh`](../../scripts/validate_build.sh) | `<eleventy-source>/_site/index.html` | Nothing | None |
| [`promote_workspace_assets.sh`](../../scripts/promote_workspace_assets.sh) | A session-log JSON whose `changes[]` entries have `promote: true`, `workspace_path` (relative to `<project>`), `repo_path` (relative to the checkout) and `notes` | The listed paths in this checkout | `--log FILE` (required, relative to the current directory), `--dry-run` or `-n`, `-h` |
| [`export_workspace_samples.sh`](../../scripts/export_workspace_samples.sh) | `<project>/workspace/{allowlist,cloudfront,etl-output,gcloud,harrisonfamily-frontend}`, `<project>/workspace/tests/login-flow`, `<project>/workspace/coming-soon-index.html` | The same paths under `<project>/repo/` | None |
| [`sync_sanitized_assets.py`](../../scripts/sync_sanitized_assets.py) | `<project>/workspace-local/allowlist/`, `<project>/workspace-local/cloudfront/`, `<project>/workspace-local/coming-soon-index.html` | Placeholders under `<project>/workspace/` (with `--sync`) | `--sync` |

Behavior details:

- **`check-deployment-sync.sh`** needs `rsync`, and exits 1 without it even when nothing relevant is staged. It compares with `rsync -ain --delete --omit-dir-times` and fails on any itemized line. It compares the working tree, not the staged content. `rsync` matches on size and modification time, so files with the same content but different timestamps, as in a fresh clone, also count as differences. A missing source or destination directory is an error. It names `<project>/docs/deployment.md` in its messages but does not read it.
- **The `11ty/` comparison excludes** the data directories (`person/`, `family/`, `event/`, `note/`, `media/`, `place/`), `private/`, `uploads/`, `README.md` and `.DS_Store`, and the repository-owned E5 files that `<eleventy-source>` does not produce: `_data/flags.json`, `js/islands/`, `js/auth-v2.js`, `js/feature-flags.js`, `js/search-navbar.js`, `js/search-results.js`, `sw.js`, `manifest.webmanifest`, `offline.html`, `images/pwa-*.png`, `posts/` and `me/`. It does not exclude the E5-edited `index.html` pages outside `person/` and `private/`. Each carries an `auth-v2.js` script tag that `<eleventy-source>` does not emit, so while the source lacks that tag those pages count as differences and a commit that stages any `11ty/` file fails the check (see the [codebase map](codebase-map.md)).
- **`validate_build.sh`** fails if `index.html` lacks `"enforceAssets":true` or contains `"clientId":""`. It warns if `REPLACE_WITH_GOOGLE_CLIENT_ID` is present. It validates the Eleventy build in the workspace, not `11ty/` in this checkout.
- **`promote_workspace_assets.sh`** needs `python3`, which parses the session log, and `rsync`. It copies a file entry with `rsync -a`. It mirrors a directory entry with `rsync -a --delete`, which removes files in the destination directory that the source lacks, `README.md` files included. A missing workspace path prints a warning and is skipped.
- **`export_workspace_samples.sh`** deletes each destination directory, including the READMEs in it, before copying the workspace directory in. Whatever the workspace holds replaces what the repository holds. It also replaces `tests/login-flow/`, its `.gitignore` included, and `coming-soon-index.html`. It writes to `<project>/repo` by name, not to the checkout that runs it.
- **`sync_sanitized_assets.py`** reports each private file with no sanitized counterpart, and with `--sync` it writes a placeholder for it. Placeholders are a JSON list of two `example.com` addresses for the allowlist, a `{"placeholder": true, …}` JSON for CloudFront files, and an HTML comment for the coming-soon page. It never copies real data, never overwrites an existing file and never writes into the checkout. It always exits 0. Run with no arguments, it reports.

How each behaves when the parent directory is `<parent>` rather than `<project>`:

| Script | Behavior |
|---|---|
| `check-deployment-sync.sh` | Exits 0 when no `11ty/`, `lambda/` or `functions/` file is staged. Otherwise the sources under `<parent>` are missing, so it exits 1 and blocks the commit unless `SKIP_DEPLOYMENT_SYNC_CHECK=1` is set. |
| `validate_build.sh` | Exits 1 because the build directory under `<parent>` is not found. |
| `promote_workspace_assets.sh` | Reads workspace paths from `<parent>`. Missing paths are skipped with a warning, and anything found is written into this checkout. |
| `export_workspace_samples.sh` | Prints nothing and does nothing when `<parent>` has no `workspace/` directories. If it has them, the script writes to `<parent>/repo/`, which is not this checkout. |
| `sync_sanitized_assets.py` | When `<parent>` has no `workspace-local/`, it skips every entry and prints `[OK] Sanitized workspace mirrors workspace-local for tracked assets.`, an OK that checked nothing. |

## Test suites

No workflow runs any of these. For the order to run them in, see [run the tests](../how-to/run-the-tests.md).

| Suite | Runner | Command | Target | Needs | Artifacts |
|---|---|---|---|---|---|
| API | Vitest 3.2.4 | `cd api && npm ci && npm test` | In-process: [`api/test/`](../../api/test/) (`api`, `contracts`, `hardening`, `jwks`, `origin`, `package-api`, `presign`, `producers`) against an in-memory DynamoDB fake ([`api/test/fake-ddb.js`](../../api/test/fake-ddb.js)) and locally generated keys. `package-api` runs the real `scripts/ci/package-api.sh` on a temporary copy with `npm` and `zip` replaced by shims. `presign` runs the AWS SDK presigner offline with fake credentials. | Node 22+; `CODEARTIFACT_AUTH_TOKEN`; `bash` | Console only |
| Auth edge | Vitest 3.2.4 | `cd auth && npm ci && npm test` | In-process: [`auth/test/`](../../auth/test/) (`cognito`, `edge`, `linkstore`, `oauth`, `origin`). `linkstore` reads the table's key schema from `app-stack.yaml`. | Node 22+; `CODEARTIFACT_AUTH_TOKEN` | Console only |
| Island contracts | `node --test` | `cd islands && npm run test:contract` | In-process. `contract.test.mjs` runs the kit CommentSource contract over an in-memory store. `content-contract.test.mjs` runs the kit ContentSource contract through the real API handler, and imports [`api/test/world.js`](../../api/test/world.js) and `api/src/content.js`. `bundle.test.mjs` checks that the entry bundles in `11ty/js/islands/` are non-empty, that the directory is not gitignored, and that `node build.mjs --check` finds them up to date with `islands/src/`. | Node 22+; `CODEARTIFACT_AUTH_TOKEN`; `npm ci` in both `islands/` and `api/`; a Git checkout (for `git check-ignore`) | Console only |
| Island Playwright | Playwright 1.64.0 | `cd islands && npx playwright test` (`npm test` runs the contracts first, then this) | `11ty/` served by `http-server` at `http://127.0.0.1:8089` with caching off; viewport 375×812; browser channel `PW_CHANNEL` (default `chrome`, an installed Google Chrome). Specs: `flags-fallback`, `notifications`, `person`, `posts`, `search`, `shell`, `sw`. Network calls are mocked with `page.route` and [synthetic fixtures](../../islands/tests/fixtures/). | `npm ci` in `islands/`; the committed bundles, rebuilt after any `islands/src/` change; port 8089 free, or already serving `11ty/` (the server is reused) | `list` reporter to the console; `islands/test-results/` on failure (gitignored) |
| Infra scripts | bash, Python `unittest` | `scripts/infra/test/run.sh` | Offline. Runs the three `add-*-behavior.sh` scripts against a fixture distribution config with a stub `aws` first on `PATH`, so no call reaches AWS. Covers the `cf.jq` helpers, the legacy pin and its refusals, no-op reruns, dry runs, backups and secret redaction. [`test_app_stack.py`](../../scripts/infra/test/test_app_stack.py) checks `app-stack.yaml` and `github-roles.yaml`. `cfn-lint` and `shellcheck` run when installed and are skipped otherwise. The `create-*` scripts are not covered. | `bash`, `jq`, `python3` with PyYAML | Console only. Prints `scripts/infra tests: <n> passed, <m> failed` and exits non-zero if any check failed. |
| Login flow | Playwright `^1.48.0` | `cd tests/login-flow && npm install && npx playwright install chromium webkit && npm test` | **Live production by default** (`HFY_SITE_BASE`, default `https://<site>`). Projects `chromium` (Desktop Chrome) and `webkit` (Desktop Safari). | The environment below; a test identity on the allowlist | `logs/console-<ts>.log`, `logs/requests-<ts>.log`, `playwright-report/`, failure videos in `test-results/` |
| MCP token smoke | bash + Node (`jose`) | `MCP_TOKEN=<access-token> scripts/mcp/token-smoke.sh` | Live auth edge | `npm ci` in `auth/`; a valid access token | Console only |

### Login-flow environment

[`tests/login-flow/`](../../tests/login-flow/) has no lockfile, so it installs with `npm install`. [`playwright.config.ts`](../../tests/login-flow/playwright.config.ts) sets a 90 s test timeout and a 10 s `expect` timeout, an HTML reporter, video on failure and trace on first retry. No retries are configured, so traces are recorded only when a run passes `--retries`.

| Variable | Read by | Default | Effect |
|---|---|---|---|
| `HFY_SITE_BASE` | Config, `login-flow.spec.ts` | `https://<site>` | Site under test. |
| `HFY_TEST_ID_TOKEN` | `login-flow.spec.ts` | Unset | A Google ID token used as-is. When set, the mint helper is not run. |
| `HFY_MINT_HELPER` | `login-flow.spec.ts` | `../../scripts/auth/mint_test_id_token.py`, from the current directory | Run with `python3` to mint a token when `HFY_TEST_ID_TOKEN` is unset. The helper is outside the repository at `<project>/scripts/auth/mint_test_id_token.py`. See [known code issues](#known-code-issues). |
| `HFY_EXPECT_GRAMPS` | Both specs | `<gramps-id>` (see [known code issues](#known-code-issues)) | The gramps_id expected in the My Record link and, for `auth-v2`, in the session `sub`. |
| `HFY_LOGIN_LOG_DIR` | `login-flow.spec.ts` | `logs/` under the current directory | Where the console and requests logs are written. |
| `HFY_AUTH_V2` | `auth-v2.spec.ts` | Unset | `1` enables the `auth-v2` spec. Otherwise it is skipped. |
| `HFY_TEST_EMAIL` | `auth-v2.spec.ts` | Unset | A Cognito user on the allowlist. With `HFY_TEST_PASSWORD`, this enables the password-path test. |
| `HFY_TEST_PASSWORD` | `auth-v2.spec.ts` | Unset | That user's password. |

What the specs assert:

- [`login-flow.spec.ts`](../../tests/login-flow/tests/login-flow.spec.ts) always runs. It signs in through the legacy path by passing the token to `window.HFY_AUTH.handleCredentialResponse` on `/family-login/`. It then expects the sign-out controls and a My Record link to `/person/?id=<expected>`. It types a hard-coded surname into the navbar search and expects results there and on `/search/`. It expects a revisit of `/family-login/` to redirect to My Record, and sign-out to land on `/logged-out/`.
- [`auth-v2.spec.ts`](../../tests/login-flow/tests/auth-v2.spec.ts) checks four things: `/family-login/` redirects to `/auth/login`; the login page offers both Google and email-and-password sign-in; `/auth/.well-known/jwks.json` publishes an RS256 key with no private member; and `/auth/session` reports unauthenticated. The password-path test signs in, then checks that `/auth/session` returns `sub` equal to `HFY_EXPECT_GRAMPS` and that the My Record link matches.

About the artifacts:

- The console log and the requests log are written at the end of the test body. Only a run that passes every assertion writes them, and the requests log is written only if a request failed.
- [`tests/login-flow/.gitignore`](../../tests/login-flow/.gitignore) ignores `playwright-report/`, `test-results/` and `logs/`, and the root `.gitignore` ignores `*.log`. These artifacts can hold signed-in family data, such as a failure video of a production page, so they are not force-added, attached or shared. See [family data privacy](../explanation/family-data-privacy.md).

## Known limitations

- No workflow runs a test suite. Nothing in CI checks the committed island bundles against `islands/src/`, the infra scripts, or the API and auth edge code.
- No workflow deploys `hfy-api`, `hfy-auth-edge`, the app stack, the deploy-role stack, distribution changes or `HFYAppendIndex`. See [what no workflow ships or runs](#what-no-workflow-ships-or-runs).
- Rollback starts only after a failed smoke job. A failure in `deploy` or `invalidate` leaves whatever was already synced or updated. Rollback needs an earlier successful run whose artifact is still within the 90-day retention, and it restores `11ty/` and `hfy-check-allowed` only.
- `hfy-check-allowed` has no alias, so a deploy updates `$LATEST` and a rollback re-uploads the earlier zip.
- The repository has no root `package.json`, so nothing installs `@io-kit/parity`, and `npx --no-install io-kit-parity` has nothing to run. That step runs only when `parity.baseline` is set, and none is set.
- `deploy-gcf-legacy.yml` authenticates with a long-lived service-account JSON key.
- The drift check and the secret scan run on pull requests and manual runs of `io-kit-ci.yml` only. A push straight to `main` deploys without them.

## Known code issues

- The `target_environment` input description in `io-kit-deploy.yml` names `io-kit-promote.yml` as the approval gate. The repository has no such workflow, so the input is a label only and there is no approval gate.
- The docstring of `sync_sanitized_assets.py` advertises `--check`, which is not defined. That flag exits 2 with an argparse error.
- Both login-flow specs hard-code a real record's ID as the default for `HFY_EXPECT_GRAMPS`. It is shown on this page as `<gramps-id>`. Set the variable explicitly, and do not copy the default into docs, issues or logs.
- The `HFY_MINT_HELPER` default points, from `tests/login-flow` in the checkout, at a file that does not exist, so a run from the checkout needs `HFY_MINT_HELPER` or `HFY_TEST_ID_TOKEN`.
- `token-smoke.sh` hard-codes `kid` `hfy-session-1`, so its signature check fails after a key rotation to a new `kid` until the script is updated.

## Related pages

- [Codebase map](codebase-map.md): where each of these files sits among the rest of the code.
- [Architecture](architecture.md): the components these pipelines deploy.
- [Private data and secrets](private-data-and-secrets.md): secret names, storage and placeholders.
- [The release model](../explanation/release-model.md): why deploys and flag flips are separate, and why the deploy role is narrow.
- [Why React islands on a generated Eleventy site](../explanation/islands-on-eleventy.md): why `11ty/` is output and the islands are built separately.
- [Edge and origin design](../explanation/edge-and-origin-design.md): the distribution these scripts configure.
- How-to: [deploy a site change](../how-to/deploy-a-site-change.md), [roll back a site deploy](../how-to/roll-back-a-site-deploy.md), [change the CI pipeline](../how-to/change-the-ci-pipeline.md), [build and preview the islands](../how-to/build-and-preview-the-islands.md), [deploy the app stack](../how-to/deploy-the-app-stack.md), [run the tests](../how-to/run-the-tests.md), [refresh the Eleventy output](../how-to/refresh-the-eleventy-output.md), [stand up the static site](../how-to/stand-up-the-static-site.md).
