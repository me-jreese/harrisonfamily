# Repository operations

Reference for the workflows, deploy role, scripts, hooks and test suites that build, check and ship this repository.

Paths are relative to the repository root and link to the code. For why a release is split into a deploy and a flag flip, see [the release model](../explanation/release-model.md). For step-by-step tasks, see [deploy a site change](../how-to/deploy-a-site-change.md), [roll back a site deploy](../how-to/roll-back-a-site-deploy.md), [deploy the app stack](../how-to/deploy-the-app-stack.md), [deploy the edge functions](../how-to/deploy-the-edge-functions.md), [cut over to the private data gate](../how-to/cut-over-to-the-private-data-gate.md), [publish a change to the HFYAppendIndex CloudFront Function](../how-to/publish-the-cloudfront-function.md), [change the CI pipeline](../how-to/change-the-ci-pipeline.md) and [run the tests](../how-to/run-the-tests.md). Everything the islands build writes is described in [theme and asset build](theme-and-asset-build.md).

## Placeholders

Identifiers that belong to the live environment are written as placeholders. The shared list is in [private data and secrets](private-data-and-secrets.md#placeholders). One placeholder in the table below is defined only on this page: `<parent>`.

| Placeholder | Stands for |
|---|---|
| `<site>` | The site's public hostname. |
| `<site-bucket>` | The S3 bucket that holds the static site, the private data prefixes and member uploads. |
| `<distribution-id>` | The CloudFront distribution in front of the bucket, the API and the auth edge. |
| `<app-stack>` | The deployed app stack, built from [`app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml), in `us-west-2`. Its name is not `hfy-app`, which is the `--stack` default of the four app-stack behavior scripts (`add-api-behavior.sh`, `add-auth-behavior.sh`, `add-uploads-behavior.sh` and `add-mcp-behavior.sh`) and the `--app-stack` default of `add-data-gate-behaviors.sh`. |
| `<code-bucket>` | The S3 bucket that holds the app Lambda packages, under commit-named keys `lambda/hfy-api-<sha>.zip` and `lambda/hfy-auth-edge-<sha>.zip`. |
| `<edge-code-bucket>` | The private `us-east-1` bucket that holds the gate's packages under content-addressed keys. |
| `<config-bucket>` | The S3 bucket that holds the access configuration under `config/`, including `config/groups.json`. |
| `<github-owner>` | The GitHub user or organization that owns the repository (the `GitHubOrg` parameter of `github-roles.yaml`). |
| `<github-repo>` | The GitHub repository name (the `GitHubRepo` parameter of `github-roles.yaml`). |
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
| [`io-kit-deploy.yml`](../../.github/workflows/io-kit-deploy.yml) | io-kit deploy | `push` to `main`, `workflow_dispatch` | Builds and packages a release, syncs `11ty/` to `<site-bucket>`, invalidates CloudFront, runs smoke checks, and rolls back after a failed smoke check. | Rendered from `ci.manifest.yaml` |
| [`post-deploy-checks.yml`](../../.github/workflows/post-deploy-checks.yml) | post-deploy checks | `workflow_run` of `io-kit deploy` on `main` (completed; its job runs only when that run succeeded), `workflow_dispatch` | Checks the site bucket's CORS rule with preflight requests ([`check-site-bucket-cors.sh`](#check-site-bucket-corssh)). Deploys nothing and rolls nothing back. | Hand-maintained |

A push to `main` starts `io-kit-deploy.yml`. When the `io-kit-deploy.yml` run succeeds, `post-deploy-checks.yml` starts. The drift check and the secret scan run only in `io-kit-ci.yml`, so they run on pull requests and manual runs, not on a push to `main`. `io-kit-ci.yml` runs the CodeArtifact-free suites in its `test` job on pull requests (the `tests` key; see [Run the tests](../how-to/run-the-tests.md#where-each-suite-runs)), and no workflow runs the islands build or the other suites. See [what no workflow ships or runs](#what-no-workflow-ships-or-runs).

`deploy-gcf-legacy.yml`, which deployed the legacy `getAllowlist` Google Cloud Function when started by hand, is gone. With io's approval, the function and its secret were deleted on 2026-10-14, and HFY-TSK-325 removed the workflow and the function source, so nothing in the repository can redeploy it ([Identity services](identity-services.md#getallowlist-deleted)).

### Kit manifest: `ci.manifest.yaml`

[`ci.manifest.yaml`](../../ci.manifest.yaml) is the source of the two rendered workflows and the composite actions, rendered by `@io-kit/ci` 0.1.3.

| Field | Value | Meaning |
|---|---|---|
| `stack` | `static` | Kit stack type. |
| `branch` | `main` | Deploy branch. |
| `node_version` | `"22"` | Node version for `actions/setup-node`. |
| `build.cmd` | `echo "11ty/ is committed output; nothing to build"` | Build command, run from the checkout root. It builds nothing: `11ty/` is committed output, and HFY-TSK-317 removed the client-ID patch and the Lambda zip. See [build scripts](#build-scripts-scriptsci). |
| `build.out` | `11ty` | Build output directory. The build fails if it does not exist afterwards. |
| `parity.mode` | `block` | Pipeline drift fails the `parity` job and so the pull request check (`pipeline_drift`). No `parity.baseline` is set. |
| `secrets_scan` | `trufflehog` | Secret scanner for CI. |
| `deploy.aws_role_secret` | `AWS_DEPLOY_ROLE_TO_ASSUME` | Secret that holds the OIDC deploy role ARN. |
| `deploy.region` | `us-west-2` | AWS region. |
| `deploy.targets[0]` | `kind: s3_static`, `bucket: <site-bucket>`, `distribution: <distribution-id>`, `invalidate: ["/*"]`, and seven `exclude` patterns: `person/*.json`, `media/*`, `family/*`, `event/*`, `note/*`, `place/*`, `uploads/*` | Static site target. The sync never deletes or overwrites objects under the excluded patterns: the family data prefixes and member uploads. |
| `deploy.smoke` | `https://<site>/`, `https://<site>/family-login/` | URLs checked after a deploy. Both are HTML pages, and the second is the redirect page to `/auth/login`. |
| `deploy.rollback.strategy` | `previous_artifact` | Rollback redeploys the release artifact of the previous successful deploy run. |

The manifest has no `lambda` target (ruling P2-R41: API, auth and edge ship through app-stack change sets, so the manifest keeps the static site target only) and no `cloudfront_function` target. `@io-kit/ci` 0.1.3 supports that kind, but `HFYAppendIndex` is published by hand ([CloudFront Function](#cloudfront-function-scriptscloudfrontappend-indexjs)).

### `io-kit-ci.yml`

Workflow **io-kit CI**. Permissions: `contents: read`. Concurrency group `io-kit-ci-<ref>`, which cancels an in-progress run for the same ref. It makes no AWS call.

| Job | Needs | Steps | Fails when |
|---|---|---|---|
| `build` | | Checkout; `build` | The build command fails, or `11ty` is missing afterwards. |
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
| `deploy` | `build` | `id-token: write` | Checkout; download `io-kit-release-<sha>` into the checkout; OIDC with `AWS_DEPLOY_ROLE_TO_ASSUME`; `deploy-static` |
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
| `package` | Writes `.io-kit-ci/release.json` (`sha`, `ref`, `run_id`) and uploads `11ty/` and `release.json` as artifact `io-kit-release-<sha>`. It fails if no files are found. Retention is 90 days. |
| `deploy-static` | For each `s3_static` target: one `aws s3 sync <out>/ s3://<bucket>/ --delete --only-show-errors` with one `--exclude` per pattern. The single sync uploads the HTML pages and the files they reference in no set order. |
| `invalidate` | For each target with a distribution: `create-invalidation` on the target's paths, then `aws cloudfront wait invalidation-completed`. It invalidates CloudFront only. |
| `smoke` | Runs `curl` on each URL without following redirects (20 s timeout, 3 retries 5 s apart). A 2xx or 3xx status passes. Any other status, or no response, fails. Every URL is checked before the step fails. |
| `rollback` | Uses `gh run list` with the job's `github.token` to find the most recent successful run of `io-kit-deploy.yml` on the same branch, deletes `11ty/`, and downloads that run's `io-kit-release-<sha>`. It then runs `deploy-static` and `invalidate`. It fails when no earlier successful run exists, as on the first run, or when that run's artifact has expired. |
| `parity-report` | Runs the vendored, dependency-free `check.cjs` and writes the result to the step summary. If `parity.baseline` is set, it also runs `npx --no-install io-kit-parity baseline check`. With no baseline, it reports "no baseline" and passes. |
| `secret-scan` | `trufflesecurity/trufflehog@v3.88.0` with `--results=verified,unknown` over the pushed or pull-request commit range. |

### Caches in front of the pipeline

| Item | Fact |
|---|---|
| Cloudflare | Proxies `<site>` in front of CloudFront. No workflow, action or GitHub secret refers to Cloudflare, so the pipeline never purges its cache. |
| Static files | Cloudflare caches scripts, stylesheets, fonts and `sw.js` for 4 h under the URL first fetched. |
| HTML | Not cached by Cloudflare (`cf-cache-status: DYNAMIC`). |
| `invalidate` | Its `/*` invalidation clears CloudFront's cache only. |
| Asset versions | The committed HTML carries `?v=<sha8>`, the first 8 hex digits of the file's SHA-256, on every same-origin script, stylesheet, manifest and module-preload reference. The islands build writes them ([theme and asset build](theme-and-asset-build.md#asset-versions)). The pipeline does not compute or check them. |
| `smoke` | Fetches the two HTML pages in `deploy.smoke`, or the `smoke_url` input instead. It requests no script, stylesheet or font. |

The reasoning is in [static files and versioned URLs](../explanation/edge-and-origin-design.md#static-files-and-versioned-urls-hfy-tsk-086).

### Pipeline drift check: `check.cjs`

[`check.cjs`](../../.github/actions/io-kit-ci/parity-report/check.cjs) walks every `.yml`, `.yaml` and `.cjs` file under `.github/workflows/` and `.github/actions/`. It exits 0 when clean, 1 on drift and 2 on error, and reports three kinds of drift:

| Drift reason | Meaning |
|---|---|
| `hand_edit` | The file's header hash does not match its body. |
| `missing_header` | A file in `.github/actions/io-kit-ci/` or a `.github/workflows/io-kit-*` file has no rendered header. |
| `deploy_outside_kit` | Another workflow runs `aws s3 sync`, a Lambda code, configuration, version or alias update, or a CloudFront invalidation or function update. |

`post-deploy-checks.yml` has no header and runs no AWS deploy command, so it reports no drift. The `parity` job runs in `block` mode, so any drift fails the pull request.

### Rendered and hand-maintained files

Each rendered file starts with a header line of this form:

```
# @io-kit/ci 0.1.3 rendered — do not edit; sha256:<hash of the rest of the file>
```

Rendered files are not edited by hand. A pipeline change is made in `ci.manifest.yaml` and re-rendered with the `io-kit-ci render` command of `@io-kit/ci` ([Change the CI pipeline](../how-to/change-the-ci-pipeline.md)). The `parity` job reports a hand edit as `hand_edit` drift.

| Rendered | Hand-maintained |
|---|---|
| `.github/workflows/io-kit-ci.yml`, `.github/workflows/io-kit-deploy.yml`, every file under `.github/actions/io-kit-ci/` | `ci.manifest.yaml`, `.github/workflows/post-deploy-checks.yml`, every script under `scripts/ci/` |

## Deploy role: `github-roles.yaml`

[`infrastructure/cloudformation/github-roles.yaml`](../../infrastructure/cloudformation/github-roles.yaml) defines the IAM role that `io-kit-deploy.yml` assumes through GitHub OIDC. Its `DeployRoleArn` output is the value of the `AWS_DEPLOY_ROLE_TO_ASSUME` secret. The stack is deployed by hand with admin credentials, as its description states. No workflow deploys it.

Trust: `sts:AssumeRoleWithWebIdentity` from the account's GitHub OIDC provider, with audience `sts.amazonaws.com` and subject `repo:<github-owner>/<github-repo>:ref:refs/heads/main`. Maximum session: 3600 seconds.

| Statement | Effect | Actions | Resources |
|---|---|---|---|
| `S3SiteSync` | Allow | `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`, `s3:ListBucket` | `<site-bucket>` and every object in it |
| `ProtectMemberUploads` | Deny | `s3:DeleteObject`, `s3:PutObject` | `<site-bucket>/uploads/*` |
| `CloudFrontInvalidation` | Allow | `cloudfront:CreateInvalidation`, `cloudfront:GetInvalidation` | `<distribution-id>` |
| `LambdaDeploy` | Allow | `lambda:UpdateFunctionCode`, `lambda:GetFunction`, `lambda:GetFunctionConfiguration`, `lambda:ListVersionsByFunction`, `lambda:PublishVersion`, `lambda:GetAlias`, `lambda:CreateAlias`, `lambda:UpdateAlias` | `hfy-api` and `hfy-auth-edge` in `us-west-2`, each with its versions and aliases |

The template dropped the grant on `hfy-check-allowed` when that function was deleted on 2026-10-14 (HFY-TSK-326). The deployed stack keeps the old grant until the GitHub-roles stack is next updated by hand; a grant on a deleted function allows nothing. [`test_app_stack.py`](../../scripts/infra/test/test_app_stack.py) checks that `LambdaDeploy` names only `hfy-api` and `hfy-auth-edge`.

`ProtectMemberUploads` (HFY-R58) backs up the `uploads/*` sync exclude: an explicit Deny wins over the Allow, so the role cannot write or delete any object under `uploads/`, even if a sync tried to. `GetFunctionConfiguration` and `GetInvalidation` are what the `wait` commands in `deploy-lambda` and `invalidate` poll, and the version and alias actions cover `deploy-lambda`'s aliased and rollback paths (HFY-R60).

The role has no CloudFormation, IAM or Secrets Manager permissions, no CloudFront permission besides the two invalidation actions (so it can neither update the distribution nor update or publish a CloudFront Function), and no Lambda grant in `us-east-1`, where the two Lambda@Edge functions live. [`scripts/infra/test/test_app_stack.py`](../../scripts/infra/test/test_app_stack.py) checks the `ProtectMemberUploads` statement.

## GitHub secrets

| Secret | Used by | Holds |
|---|---|---|
| `AWS_DEPLOY_ROLE_TO_ASSUME` | `io-kit-deploy.yml` jobs `deploy`, `invalidate` and `rollback_on_smoke_fail` | The ARN of the OIDC deploy role, the `DeployRoleArn` output of [`github-roles.yaml`](../../infrastructure/cloudformation/github-roles.yaml). |
| `GCP_SERVICE_ACCOUNT_KEY` | No workflow since HFY-TSK-325 removed `deploy-gcf-legacy.yml` | A Google service-account JSON key. That key was deleted on the service account on 2026-10-14, so the secret no longer authenticates and can be deleted ([Private data and secrets](private-data-and-secrets.md#google-cloud-legacy-deleted)). |

### `post-deploy-checks.yml`

Workflow **post-deploy checks**, one job, `site-bucket-cors`, on `ubuntu-latest`, with permission `contents: read` and no AWS credentials. It is triggered by `workflow_run` when a run of the workflow named `io-kit deploy`, the rendered name of `io-kit-deploy.yml`, completes on `main`, the manifest's `branch`. The job runs only when that run's conclusion is `success`. It can also be started by hand. It checks out the commit the deploy run built, `github.event.workflow_run.head_sha`, and runs `bash scripts/infra/check-site-bucket-cors.sh`.

It exists because the kit's smoke job cannot express the check. `deploy.smoke` in `@io-kit/ci` 0.1.3 takes URLs only, requests each with `GET`, and passes any `2xx` or `3xx`. A preflight needs `OPTIONS` with request headers, and one of its expected answers is `403`. A failed smoke job also redeploys the previous release, which cannot repair a bucket CORS rule. A failure here rolls nothing back. A `workflow_run` trigger names the workflow, not the file, so renaming the deploy workflow through `workflows.deploy` in `ci.manifest.yaml`, or changing its `branch`, needs the same change here: `scripts/infra/test/run.sh` fails until they agree.

No workflow uses `CODEARTIFACT_AUTH_TOKEN`; it is a local shell variable for the build scripts, the islands build and the MCP conformance gate. The rollback uses the automatic `github.token` with `actions: read`, not a repository secret. Where each value comes from, and who can read it, is in [private data and secrets](private-data-and-secrets.md).

## What no workflow ships or runs

| Item | Built or run by | How it reaches production |
|---|---|---|
| Islands build output: `11ty/js/islands/`, `11ty/css/hfy-theme.css`, `11ty/css/auth-edge.css`, `11ty/fonts/`, the head blocks, Voice copy and `?v=<sha8>` versions in the pages, the `11ty/manifest.webmanifest` colours, the stamped `11ty/sw.js` and `11ty/js/feature-flags.js`, and `theme.cssUrl` in `auth/edge.manifest.json` | [`scripts/ci/build-islands.sh`](../../scripts/ci/build-islands.sh), or `npm run build` in `islands/`, by hand | All of it is committed build output (HFY-R58, see [`.gitignore`](../../.gitignore)). Everything under `11ty/` ships with the `11ty/` sync. The `cssUrl` reaches the sign-in pages only when `hfy-auth-edge` is redeployed (below). No workflow builds any of it or runs `npm run check:islands`, which reports stale output. See [build and preview the islands](../how-to/build-and-preview-the-islands.md) and [theme and asset build](theme-and-asset-build.md). |
| Lambda `hfy-api` | [`scripts/ci/package-api.sh`](../../scripts/ci/package-api.sh) builds `dist/hfy-api.zip` | By hand. The zip is uploaded to `<code-bucket>` as `lambda/hfy-api-<sha>.zip` and reaches `<app-stack>` through a CloudFormation change set. A change under `api/src/`, such as the push notification copy in [`api/src/notify.js`](../../api/src/notify.js), reaches production only this way. The manifest has no Lambda target, although the deploy role's `LambdaDeploy` statement covers this function. See [deploy the app stack](../how-to/deploy-the-app-stack.md). |
| Lambda `hfy-auth-edge` | [`scripts/ci/package-auth.sh`](../../scripts/ci/package-auth.sh) builds `dist/hfy-auth-edge.zip`, which includes `auth/edge.manifest.json` | Same as `hfy-api`, under the key `lambda/hfy-auth-edge-<sha>.zip`. A change under `auth/src/` or to `auth/edge.manifest.json` reaches production only this way, including the sign-in copy, the HTML overrides and the `theme.cssUrl` that the islands build restamps whenever `11ty/css/auth-edge.css` changes. |
| App stack ([`app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml)) and deploy-role stack | CloudFormation, by hand | The deploy role has no CloudFormation or IAM permissions. |
| Lambda@Edge `hfy-edge-gate` | [`scripts/ci/package-edge-gate.sh`](../../scripts/ci/package-edge-gate.sh) builds `dist/hfy-edge-gate.zip` and `dist/hfy-edge-gate.params` | By hand, in `us-east-1`. The zip is uploaded to its content-addressed `CodeKey` in `<edge-code-bucket>`, and stack `hfy-edge-gate` ([`edge-gate-stack.yaml`](../../infrastructure/cloudformation/edge-gate-stack.yaml)) is deployed with that `CodeKey` and its `CodeSha256`, which publishes a numbered version. The version is invoked with synthetic viewer-request events before [`add-data-gate-behaviors.sh`](#data-gate-behaviors) attaches it. See [deploy the edge functions](../how-to/deploy-the-edge-functions.md) and [cut over to the private data gate](../how-to/cut-over-to-the-private-data-gate.md). |
| Lambda@Edge `hfy-mcp-edge401` | Nothing to build: the code is inline in [`mcp-edge401.us-east-1.yaml`](../../infrastructure/mcp-edge401.us-east-1.yaml) | By hand. Stack `hfy-mcp-edge401` is deployed in `us-east-1`, then [`add-mcp-behavior.sh`](#cloudfront-behavior-scripts) attaches its version to the MCP behaviors. |
| Distribution changes | The five `add-*` scripts in [`scripts/infra/`](#infrastructure-scripts-scriptsinfra), including `add-mcp-behavior.sh` and `add-data-gate-behaviors.sh`, which also makes `/uploads/*` members-only | Applied by hand. The deploy role cannot change the distribution's configuration. |
| CloudFront Function `HFYAppendIndex` | [`publish-append-index.sh`](#publish-append-indexsh) publishes [`append-index.js`](#cloudfront-function-scriptscloudfrontappend-indexjs) | By hand, with operator credentials that allow `cloudfront:DescribeFunction`, `GetFunction`, `UpdateFunction`, `TestFunction`, `PublishFunction` and `GetDistributionConfig`. The deploy role has none of these, and the manifest has no `cloudfront_function` target. See [publish a change to the HFYAppendIndex CloudFront Function](../how-to/publish-the-cloudfront-function.md). |
| Secrets | [`create-session-key.sh`](#create-session-keysh-and-create-origin-verifysh), [`create-origin-verify.sh`](#create-session-keysh-and-create-origin-verifysh); the web push secret `harrisonfamily/api/vapid` has no script | Created by hand. See [turn on push notifications](../how-to/turn-on-push-notifications.md) for the VAPID secret. |
| `config/groups.json` | Written by hand. Its shape is documented in [`api/src/policy.js`](../../api/src/policy.js). | Uploaded by hand to `<config-bucket>`. `hfy-api` reads it, read-only, for the MCP groups and grants no group when it is missing or unreadable. The repository holds no copy. See [manage family access](../how-to/manage-family-access.md). |
| Every test suite except three, and the MCP conformance gate | By hand | The `test` job runs only the family-data guard, `scripts/infra/test/run.sh` and the Gramps unit tests. No workflow runs any other [test suite](#test-suites), including the `edge-gate/`, `tests/client/` and `scripts/cloudfront/test/` suites, `npm run check:islands`, the two auth end-to-end runs, or [`mcp-conformance.sh`](../../scripts/ci/mcp-conformance.sh). |

## Build scripts: `scripts/ci/`

| Script | Run by | Inputs | Output | Behavior |
|---|---|---|---|---|
| [`build-islands.sh`](../../scripts/ci/build-islands.sh) | Hand | `islands/package.json`, `islands/package-lock.json`, `islands/build.mjs` and its modules, `islands/src/` | Everything the islands build writes, all committed: `11ty/js/islands/`, `11ty/css/hfy-theme.css`, `11ty/css/auth-edge.css`, `11ty/fonts/`, the pages it edits, `11ty/manifest.webmanifest`, `11ty/sw.js`, `11ty/js/feature-flags.js` and `auth/edge.manifest.json`. See [theme and asset build](theme-and-asset-build.md). | Runs `npm ci --ignore-scripts` (output suppressed), which also installs the `@fontsource` dev dependencies the build reads, and `npm run build:islands`. It then requires `11ty/js/islands/shell.js` and `shell.css` to be non-empty and prints `built islands -> 11ty/js/islands`. It checks none of the other outputs. |
| [`package-api.sh`](../../scripts/ci/package-api.sh) | Hand | `api/src/`, `api/scripts/`, `api/package.json`, `api/package-lock.json`, `api/.npmrc` | `dist/hfy-api.zip` (handler `src/index.handler`); `api/dist/caps.json` | Copies the inputs to a temporary stage and runs `npm ci --omit=dev --ignore-scripts` there. It removes `.npmrc` and the lockfile from the stage, then runs [`api/scripts/gen-caps.mjs`](../../api/scripts/gen-caps.mjs) inside the stage, against the packages just installed, and removes `scripts/`. `gen-caps.mjs` writes `dist/caps.json`, `dist/policy.json` (the permission table, from [`api/src/policy.js`](../../api/src/policy.js)), `dist/mcp/tools.json` and `dist/mcp/parity-caps.json` into the stage, so all four are in the zip. The script exits 1 if `dist/caps.json` is missing or empty. It copies only `caps.json` to `api/dist/`, zips the stage with `-X`, and prints the zip path and size. It does not use `api/node_modules/`. |
| [`package-auth.sh`](../../scripts/ci/package-auth.sh) | Hand | `auth/src/`, `auth/edge.manifest.json`, `auth/package.json`, `auth/package-lock.json`, `auth/.npmrc` | `dist/hfy-auth-edge.zip` (handler `src/index.handler`) | Same staging and install as `package-api.sh`, with no capabilities step. |
| [`package-edge-gate.sh`](../../scripts/ci/package-edge-gate.sh) | Hand | `edge-gate/src/index.mjs`, `edge-gate/src/gate.mjs`, `edge-gate/gate.config.json` | `dist/hfy-edge-gate.zip` (handler `index.handler`); `dist/hfy-edge-gate.params` | Copies the two sources and the config, renamed `config.json`, to a temporary stage, and fails if the config lacks `issuer`, `audience` or `jwksUrl`. It installs nothing: the gate has no dependencies, and Lambda@Edge has no environment variables, so the config is baked in. It sets fixed file times and zips with `-X`, so the same sources always give the same bytes. It exits 1 if the zip is 1 MB or larger, the Lambda@Edge viewer-trigger limit. It computes `CodeSha256`, the base64 SHA-256 of the zip, and `CodeKey`, the content-addressed key `lambda/hfy-edge-gate-<first 16 hex of the SHA-256>.zip`, writes both as `KEY=VALUE` lines to `dist/hfy-edge-gate.params`, and prints them with an `aws s3 cp` upload command and an `aws cloudformation deploy` command for stack `hfy-edge-gate`, the bucket left as a placeholder for `<edge-code-bucket>`. |
| [`package-render.sh`](../../scripts/ci/package-render.sh) | Hand | `lambda/hfy-sync-render/` (`handler.py`, `hfy_render/`), and from `gramps/hfygramps/` only `__init__.py`, `scanner.py` and `render/` | `dist/hfy-sync-render.zip` (handler `handler.handler`, Python 3.13); `dist/hfy-sync-render.params` | Stages the inputs, checks that the stage imports on its own, and zips it with sorted entries and fixed mtimes, so the same sources give the same bytes. Prints `RenderCodeKey=lambda/hfy-sync-render-<first 12 hex of the zip's SHA-256>.zip`. Needs `zip` and `python3`. See [The render Lambda](sync-render.md). |
| [`check-sync-catalog.mjs`](../../scripts/ci/check-sync-catalog.mjs) | Hand, and the last entry of the manifest's `tests` key (every pull request) | [`scripts/ci/sync-error-catalog.json`](../../scripts/ci/sync-error-catalog.json), the files it names under `gramps/tests/`, `api/test/` and `scripts/infra/test/`, and [`sync-error-catalog.md`](sync-error-catalog.md); `--root <repo>` and `--write-doc` | Nothing, except with `--write-doc`, which rewrites the table in `docs/reference/sync-error-catalog.md`; console | Reads files only: no install, no network, no CodeArtifact. Exits 1 when a row of the sync error catalog (D01 to D52, S01 to S22) has no entry or no test, when the map holds an unknown row ID, when a mapped test is not declared in its file, when a mapped file is outside the five suite folders, or when the page's table differs from the map. It does not run the tests. See [Sync error catalog and its tests](sync-error-catalog.md). |
| [`mcp-conformance.sh`](../../scripts/ci/mcp-conformance.sh) | Hand | `api/`; one optional argument, `report-only` or `blocking` (default `blocking`) | `api/dist/caps.json`, `api/dist/policy.json`, `api/dist/mcp/tools.json`, `api/dist/mcp/parity-caps.json`; console | The MCP conformance gate (HFY-TSK-077, HFY-TSK-073). Works in `api/`. Runs `npm ci --ignore-scripts` only when `api/node_modules` is missing, so an existing install is used as it is. Runs `gen-caps.mjs`, then Vitest on `test/mcp-conformance.test.js`, `test/mcp.test.js` and `test/mcp-infra.test.js`, then `npx io-kit parity diff --mode <argument> --stack hfy --caps dist/mcp/parity-caps.json --routes parity/routes.yaml --mapping parity/map.yaml --mcp-tools dist/mcp/tools.json`. `io-kit` comes from `@io-kit/parity` 0.3.0, a dev dependency of `api/`. The first failing step ends the script. |

The scripts resolve the repository root from their own location, so they run from any directory. HFY-TSK-317 deleted `patch-client-id.sh` and `package-lambda.sh`. `build-islands.sh`, `package-api.sh`, `package-auth.sh` and `mcp-conformance.sh` need `CODEARTIFACT_AUTH_TOKEN` for the `@io-kit/*` packages: the `.npmrc` in each package reads it from the environment. Get it with `aws codeartifact get-authorization-token --domain io`. Each exits at once if it is unset and never prints it. `package-edge-gate.sh` installs nothing, so it needs no token. It needs `node`, `zip` and `openssl`. Outputs under `dist/` and `api/dist/` are gitignored.

## Infrastructure scripts: `scripts/infra/`

The eight scripts that change AWS are idempotent, accept `--dry-run`, exit 2 on an unknown argument, and never print a secret value. They run under `umask 077`, and their temporary files are deleted on exit. The ninth, `check-site-bucket-cors.sh`, only sends unauthenticated requests, so it has no `--dry-run`; it also exits 2 on an unknown argument.

| Script | Needs |
|---|---|
| [`create-session-key.sh`](../../scripts/infra/create-session-key.sh) | AWS CLI, `openssl`, `jq` |
| [`create-origin-verify.sh`](../../scripts/infra/create-origin-verify.sh) | AWS CLI, `openssl` |
| [`add-api-behavior.sh`](../../scripts/infra/add-api-behavior.sh), [`add-auth-behavior.sh`](../../scripts/infra/add-auth-behavior.sh), [`add-uploads-behavior.sh`](../../scripts/infra/add-uploads-behavior.sh), [`add-mcp-behavior.sh`](../../scripts/infra/add-mcp-behavior.sh), [`add-data-gate-behaviors.sh`](../../scripts/infra/add-data-gate-behaviors.sh), [`add-csp-headers.sh`](../../scripts/infra/add-csp-headers.sh) (the site CSP, report-only then enforced: [Add the site CSP](../how-to/add-the-site-content-security-policy.md)) | AWS CLI, `jq`, and the shared helpers in [`scripts/infra/lib/`](../../scripts/infra/lib/) |
| [`publish-append-index.sh`](../../scripts/infra/publish-append-index.sh) | AWS CLI, `jq`, `cmp`, `diff` and the shared helpers; `node` for the local unit tests, which are skipped without it |
| [`check-site-bucket-cors.sh`](../../scripts/infra/check-site-bucket-cors.sh) | `curl`, `jq`; no credentials |

The offline tests for these scripts are in [`scripts/infra/test/`](../../scripts/infra/test/), except for `add-mcp-behavior.sh`, which the API suite's `mcp-infra` test covers. See [test suites](#test-suites).

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

The five `add-*` scripts add cache behaviors to the distribution, and the API, auth and MCP scripts also add or update an origin.

| | `add-api-behavior.sh` | `add-auth-behavior.sh` | `add-uploads-behavior.sh` | `add-mcp-behavior.sh` | `add-data-gate-behaviors.sh` |
|---|---|---|---|---|---|
| Path patterns | `/api/*` | `/auth/*`, `/.well-known/oauth-authorization-server*` (HFY-R44) | `/uploads/*` (HFY-R58), in its public, ungated state | `/mcp*`, `/.well-known/oauth-protected-resource*` | Seven: the six data patterns `/person/*.json`, `/family/*`, `/event/*`, `/note/*`, `/place/*`, `/media/*` (HFY-TSK-080, HFY-R63), which it creates, and `/uploads/*`, which it updates in place, or creates already gated when it is missing |
| Origin | `hfy-api-origin` (added or updated) | `hfy-auth-origin` (added or updated) | The default behavior's origin (the bucket's S3 origin), or `--origin-id`. No origin is added. | `hfy-api-origin` (added or updated), the same origin as `/api/*`, because the MCP server runs inside `hfy-api` | The default behavior's origin, or `--origin-id`, for the six data behaviors. An existing `/uploads/*` keeps its origin. No origin is added. |
| `--dry-run` | Prints the diff and changes nothing | Same | Same | Same | Same. It never creates or changes either response headers policy. |
| `--distribution` | `<distribution-id>` | `<distribution-id>` | `<distribution-id>` | `<distribution-id>` | `<distribution-id>` |
| `--stack` | `hfy-app` | `hfy-app` | `hfy-app` | `hfy-app` | `hfy-edge-gate`, read in `us-east-1` |
| Value read from the stack | `--function-url`, else output `FunctionUrl` | `--function-url`, else output `AuthFunctionUrl` | `--response-headers-policy-id`, else output `UploadsResponseHeadersPolicyId`; not read when `/uploads/*` is already gated | `--function-url`, else output `FunctionUrl` | `--version-arn`, else output `EdgeGateVersionArn`. With `--remove`: `--restore-uploads-policy-id`, else output `UploadsResponseHeadersPolicyId` of `--app-stack` ([remove mode](#remove-mode)). |
| Lambda@Edge version | None | None | None | `--edge401-arn`, else `EDGE401_ARN` (environment), else output `Edge401FunctionVersionArn` of `--edge-stack` (default `hfy-mcp-edge401`), read in `us-east-1` | The version ARN above, a version of `--function-name` (default `hfy-edge-gate`) |
| `--secret-name` | `harrisonfamily/cloudfront/origin-verify` | `harrisonfamily/cloudfront/origin-verify` | (no such option) | `harrisonfamily/cloudfront/origin-verify` | (no such option) |
| `ORIGIN_VERIFY` (environment) | If set, used instead of Secrets Manager | If set, used instead of Secrets Manager | Not used | If set, used instead of Secrets Manager | Not used |
| Other options | | | `--origin-id ORIGIN_ID`, `--gate-function-name NAME` (default `hfy-edge-gate`) | `--write-after FILE` (dry runs only) | `--remove`, `--origin-id ORIGIN_ID`, `--response-headers-policy-id ID`, `--response-headers-policy-name NAME` (default `hfy-private-no-store`), `--uploads-response-headers-policy-id ID`, `--uploads-response-headers-policy-name NAME` (default `hfy-uploads-private`), `--app-stack STACK` (default `hfy-app`) and `--restore-uploads-policy-id ID`, the last two read only by `--remove` |
| `--config-file FILE` | Dry runs only | Dry runs only | Dry runs only | Dry runs only | Dry runs only |

The deployed app stack is named `<app-stack>`, not `hfy-app`. A real run of the four scripts whose `--stack` names the app stack, every script except `add-data-gate-behaviors.sh`, therefore passes `--stack <app-stack>`, or gives the value itself with `--function-url` or `--response-headers-policy-id`. The `--stack` of `add-data-gate-behaviors.sh` names the `us-east-1` gate stack, and its default, `hfy-edge-gate`, is the deployed name: do not pass `--stack <app-stack>` to it. Its `--remove` reads the app stack through `--app-stack` instead, so a production `--remove` passes `--app-stack <app-stack>` ([remove mode](#remove-mode)).

#### Origin and behavior settings

`hfy-api-origin`, which serves `/api/*` and the MCP paths, and `hfy-auth-origin` are plain HTTPS custom origins at the Function URL host. Each has no Origin Access Control, injects `X-Origin-Verify`, and uses `https-only`, TLSv1.2, a 30 s read timeout and a 5 s keep-alive.

`/uploads/*` has two states. `add-uploads-behavior.sh` sets the public one, and `add-data-gate-behaviors.sh` turns it into the members-only one in place. `add-data-gate-behaviors.sh --remove` puts it back.

| Setting | `/api/*`, `/auth/*`, `/.well-known/oauth-authorization-server*` | `/mcp*`, `/.well-known/oauth-protected-resource*` | `/uploads/*`, public | `/uploads/*`, members-only | The six gated data patterns |
|---|---|---|---|---|---|
| Viewer protocol | Redirect HTTP to HTTPS | Redirect HTTP to HTTPS | Redirect HTTP to HTTPS | Redirect HTTP to HTTPS | Redirect HTTP to HTTPS |
| Compression | On | On | On | On | On |
| Allowed methods | All seven | All seven | `GET`, `HEAD` | `GET`, `HEAD` | `GET`, `HEAD` |
| Cached methods | `GET`, `HEAD` | `GET`, `HEAD` | `GET`, `HEAD` | `GET`, `HEAD` | `GET`, `HEAD` |
| Cache policy | Managed `CachingDisabled` | Managed `CachingDisabled` | Managed `CachingOptimized` (each upload key is unique) | Managed `CachingDisabled` | Managed `CachingDisabled` (no response is shared between users) |
| Origin request policy | Managed `AllViewerExceptHostHeader` | Managed `AllViewerExceptHostHeader` | None | None | None |
| Response headers policy | None | None | The app stack's `UploadsResponseHeadersPolicy`: `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox; default-src 'none'; img-src 'self'` | `hfy-uploads-private`: the same two headers, plus `Cache-Control: private, no-store`, each with override on | `hfy-private-no-store`: `Cache-Control: private, no-store`, with override on (HFY-R65) |
| Function associations | None | None | None, so `HFYAppendIndex` does not run for `/uploads/*` | None | None |
| Lambda@Edge associations | None | The `hfy-mcp-edge401` version, `origin-response`, body not included | None | The `hfy-edge-gate` version, `viewer-request`, body not included | The `hfy-edge-gate` version, `viewer-request`, body not included |

The default behavior is not changed by these scripts. Its viewer-request function is `HFYAppendIndex` ([CloudFront Function](#cloudfront-function-scriptscloudfrontappend-indexjs)).

#### What a run does

1. Refuse `--config-file` without `--dry-run`: print `refusing to update from --config-file (an exported config may be stale); use --dry-run, or drop --config-file to read the live config` and exit 2. `add-mcp-behavior.sh` also refuses `--write-after` without `--dry-run`: it prints `--write-after is only for --dry-run` and exits 2.
2. Resolve the stack value (the Function URL, the response headers policy ID, or the gate's version ARN). If the stack has no such output, print `stack <stack> has no output <key>` and exit 1. The API, auth and MCP scripts take the host from the Function URL, and when it is empty print `no function URL host` and exit 1. `add-mcp-behavior.sh` then resolves and checks its Lambda@Edge version ARN, and `add-data-gate-behaviors.sh` checks its version ARN ([MCP behaviors](#mcp-behaviors), [data gate behaviors](#data-gate-behaviors)).
3. API, auth and MCP only: resolve the `X-Origin-Verify` value from `ORIGIN_VERIFY`, or from Secrets Manager unless `--config-file` is given. If neither works, a dry run prints `(dry-run) origin-verify secret not read; using a placeholder` and uses the literal `<origin-verify-secret>`, and a real run prints `cannot read secret <name> (run scripts/infra/create-origin-verify.sh)` and exits 1.
4. Read the config from `--config-file` (ETag `offline`), or with `get-distribution-config`, keeping its ETag.
5. Uploads and data gate only: check that the target origin exists in the distribution. If not, print `origin '<id>' is not in distribution <distribution-id> (pass --origin-id)` and exit 1. The data gate script then resolves its two response headers policies.
6. Build the new config. An origin with the same ID, or a behavior with the same path pattern, is updated in place: it keeps its position in the list and every field the script does not manage. A missing one is appended at the end of its list. `add-mcp-behavior.sh` refuses a behavior that would shadow its own, and `add-data-gate-behaviors.sh` moves a gated behavior ahead of a broader one that would shadow it.
7. Compare the before and after configs in a normalized form. If they are equal, print `distribution <distribution-id> already has <what>: no change` and exit 0 without calling `update-distribution`.
8. Print the cache behaviors before and after, in evaluation order, and a unified diff with every `X-Origin-Verify` value replaced by `<redacted>`. If the redacted copies are equal, print `(only the X-Origin-Verify header value differs)`, which is what a secret rotation looks like.
9. With `--dry-run`, print `(dry-run) no changes made` and exit 0.
10. Save the pre-change config as a backup (below), print its path and a rollback command, then run `aws cloudfront update-distribution --if-match <ETag>` and print the distribution status.

`add-uploads-behavior.sh` and `add-data-gate-behaviors.sh` read the config (step 4) before they resolve their stack value (step 2), so a real run reads the live config even when it then refuses. When `/uploads/*` already carries the gate association, `add-uploads-behavior.sh` stops after step 4 and goes straight to step 7 ([uploads behavior](#uploads-behavior)). With `--remove`, `add-data-gate-behaviors.sh` skips steps 3 and 5 and resolves no version ARN; it reads the app stack only for the `/uploads/*` restore ([remove mode](#remove-mode)).

The normalized form sorts string lists such as methods and TLS protocols, drops empty `Items` lists, and treats an empty string as absent for optional IDs such as `OriginRequestPolicyId`, `ResponseHeadersPolicyId` and `OriginAccessControlId`. It is used only for the comparison. The update sends the merged config as built.

The `If-Match` ETag means the update applies only if the distribution has not changed since step 4. Otherwise CloudFront rejects it, the AWS CLI's error ends the script, and nothing changes. A fully offline dry run makes no AWS call. It needs `--config-file` together with `--function-url` for the API, auth and MCP scripts, `--response-headers-policy-id` for the uploads script (unless the file's `/uploads/*` is already gated), and `--version-arn` for the data gate script, whose `--remove` needs only `--config-file`.

#### Pre-change backup

Before each real update, the script saves the fetched `DistributionConfig` as `<backup-dir>/<distribution-id>-<UTC timestamp>-before.json`, mode 600. `<backup-dir>` is `HFY_CF_BACKUP_DIR` if set, otherwise `$XDG_STATE_HOME/hfy-infra/cloudfront`, otherwise `~/.local/state/hfy-infra/cloudfront`. The file holds the live `X-Origin-Verify` value, so it is a secret. The printed rollback command has the form `aws cloudfront update-distribution --id <distribution-id> --if-match <current ETag> --distribution-config file://<backup>`.

#### The retired `/api/check-allowed*` pin

`add-api-behavior.sh` used to keep the legacy `POST /api/check-allowed` on its old origin, the `hfy-check-allowed` API Gateway, with a more specific `/api/check-allowed*` behavior ordered ahead of `/api/*` (HFY-R58), and refused with exit 3 when it could not tell where that path should go unless `--legacy-origin` named the origin. Production CloudFront had no such behavior and no API Gateway origin when read on 2026-10-13, and the function and its gateway were deleted on 2026-10-14 (HFY-TSK-326, ruling P2-R48). The script now only adds the origin and creates or retargets `/api/*`. It neither creates nor removes a pin, `--legacy-origin` is an unknown argument (exit 2), and `/api/check-allowed` reaches `hfy-api`, which answers `404`.

#### Uploads behavior

`add-uploads-behavior.sh` (HFY-R58) creates or updates `/uploads/*` in its public, ungated state, with the settings above and the app stack's `UploadsResponseHeadersPolicyId`. Before the diff it prints `serving /uploads/* from origin <origin-id> with response headers policy <id>`, and its no-change message names `the /uploads/* behavior with response headers policy <id>`.

It never undoes the gate. When the existing `/uploads/*` behavior carries a Lambda@Edge association with a numbered version of `--gate-function-name` (default `hfy-edge-gate`), the script leaves it exactly as it is, without reading the stack. It prints `/uploads/* is members-only (hfy-edge-gate association, add-data-gate-behaviors.sh): left as it is. add-data-gate-behaviors.sh --remove ungates it.`, then `distribution <distribution-id> already has the members-only /uploads/* behavior: no change`, and exits 0, on a dry run too.

#### MCP behaviors

`add-mcp-behavior.sh` (HFY-R59) points `/mcp*` and `/.well-known/oauth-protected-resource*` at `hfy-api-origin`. The second pattern serves the protected-resource metadata both bare and with the `/mcp` suffix. The authorization-server metadata stays on the auth edge's `/.well-known/oauth-authorization-server*` behavior. Each MCP behavior carries the `hfy-mcp-edge401` version as an `origin-response` association, which restores `WWW-Authenticate` on a 401: a Function URL renames that header, and a CloudFront Function cannot run on a 4xx response. See the [MCP server](mcp-server.md) reference.

- **Version ARN.** `--edge401-arn` wins over `EDGE401_ARN`, which wins over the `Edge401FunctionVersionArn` output of `--edge-stack`, read in `us-east-1` only when `--config-file` is not given. When no ARN is found, a dry run uses a placeholder and prints `(dry-run) Lambda@Edge version ARN not resolved; using a placeholder`, and a real run prints `no Lambda@Edge version ARN: deploy infrastructure/mcp-edge401.us-east-1.yaml (us-east-1) and pass --edge401-arn` and exits 1. The ARN must be a qualified `us-east-1` Lambda ARN whose qualifier starts with a digit. Anything else, such as `$LATEST`, an unqualified ARN or another Region, is refused with `--edge401-arn must be a us-east-1 versioned (not $LATEST) function ARN` and exit 2. Only the first character of the qualifier is checked, so a qualifier such as `1abc` passes, and the function name is not checked. `add-data-gate-behaviors.sh`, by contrast, checks both the function name and that the whole qualifier is numeric ([data gate behaviors](#data-gate-behaviors)).
- **Shadow check.** After the merge, the first behavior that matches `/mcp`, and the first that matches `/.well-known/oauth-protected-resource`, must be the MCP behavior itself. Otherwise the script prints `refusing: <pattern> is ordered before the MCP behavior for <path> and would shadow it` and exits 3, and nothing changes. Unlike the data gate script, it does not reorder behaviors.
- **`--write-after FILE`.** In a dry run, writes the merged config to `FILE`. The API suite's `mcp-infra` test uses it to check that a rerun on the result is a no-op.

After a new `hfy-mcp-edge401` version is published, a rerun of `add-mcp-behavior.sh` points both behaviors at it.

#### Data gate behaviors

`add-data-gate-behaviors.sh` attaches the private data gate (HFY-TSK-080, HFY-R63) to seven patterns. It creates the six data behaviors and makes `/uploads/*` members-only. The person pattern is `/person/*.json`, not `/person/*`, because `/person/` itself is the public person-page shell, which the default behavior's `HFYAppendIndex` resolves to `index.html`. For what the gate checks, see [edge and origin design](../explanation/edge-and-origin-design.md), and for what members and visitors see, [family data privacy](../explanation/family-data-privacy.md).

- **Version ARN.** `--version-arn`, else the `EdgeGateVersionArn` output of `--stack`, read in `us-east-1`. The ARN must be a qualified `us-east-1` ARN of `--function-name` that ends in a numeric version. Anything else, such as `$LATEST`, an unqualified ARN, another Region or another function, is refused with exit 2 and a message that starts with `version ARN must`. CloudFront accepts only a published version for Lambda@Edge.
- **Origin.** `--origin-id`, else the default behavior's origin, for the six data behaviors. One that is not in the distribution is refused with exit 1. An existing `/uploads/*` keeps its `TargetOriginId`, even when `--origin-id` is given.
- **`/uploads/*`.** The behavior that `add-uploads-behavior.sh` made is updated in place. It keeps its origin and every other field, and its position unless an earlier, broader behavior would shadow it (see **Order**, below). It gets the gate's `viewer-request` association, `CachingDisabled` and `hfy-uploads-private`. A rerun puts back any of these that drifted. When no `/uploads/*` behavior exists, the script creates one, already gated, on the resolved origin. It never deletes `/uploads/*`.
- **Response headers policies (HFY-R65).** Every gated behavior also gets a custom policy that forces `Cache-Control: private, no-store`. For why, see [Cloudflare in front of CloudFront](../explanation/edge-and-origin-design.md#cloudflare-in-front-of-cloudfront-hfy-r65). The script finds, creates or repairs each policy by name:

  | | `hfy-private-no-store` | `hfy-uploads-private` |
  |---|---|---|
  | Attached to | The six data behaviors | `/uploads/*` |
  | Name option | `--response-headers-policy-name` | `--uploads-response-headers-policy-name` |
  | ID option, used as given with no lookup | `--response-headers-policy-id` | `--uploads-response-headers-policy-id` |
  | Created with, each with override on | Custom header `Cache-Control: private, no-store` | `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox; default-src 'none'; img-src 'self'`, and custom header `Cache-Control: private, no-store` |
  | Counts as correct when | It has exactly one `Cache-Control` custom header, with the value `private, no-store` and override on, and does not also remove `Cache-Control`. Header names are compared without regard to case. | The same, and it also sets content type options and that exact Content-Security-Policy, both with override on |

  The Content-Security-Policy is the one in the app stack's `UploadsResponseHeadersPolicy`. `UPLOADS_CSP` in [`cf-common.sh`](../../scripts/infra/lib/cf-common.sh) holds the string, [`test_app_stack.py`](../../scripts/infra/test/test_app_stack.py) checks that the template and the script agree, and `rhp_uploads_private` in [`cf.jq`](../../scripts/infra/lib/cf.jq) is the correctness check. In the messages below, `<headers>` is empty for `hfy-private-no-store` and is ` and the nosniff + sandbox CSP security headers` for `hfy-uploads-private`:

  | Policy | Real run | `--dry-run` | Offline dry run (`--config-file`) |
  |---|---|---|---|
  | Missing | Created. Prints `created response headers policy <name> (<id>): Cache-Control: private, no-store, override<headers>`. | Not created. Prints `(dry-run) would create response headers policy <name> (Cache-Control: private, no-store, override<headers>)`, and the diff uses `<new hfy-private-no-store policy id>` or `<new hfy-uploads-private policy id>`. | Not looked up. Prints `(dry-run) response headers policy <name> not looked up (offline); using a placeholder id`, and the diff uses `<hfy-private-no-store policy id>` or `<hfy-uploads-private policy id>`. |
  | Present and correct | Used as it is, with no write. Prints `response headers policy <name> (<id>) already forces Cache-Control: private, no-store<headers>`. | Same | Not looked up, as above |
  | Present, not correct | Put back to the created config with `update-response-headers-policy --if-match <ETag>`, keeping its ID. Prints `updated response headers policy <name> (<id>): Cache-Control: private, no-store, override<headers>`. | Not changed. Prints `(dry-run) would put response headers policy <name> (<id>) back to Cache-Control: private, no-store, override<headers>`. | Not looked up, as above |

  The policies are resolved only after the version ARN and the origin pass their checks, so a refused run creates nothing.
- **Order.** A new data behavior is appended after the existing behaviors, and an existing `/uploads/*` keeps its position. Each of the seven gated behaviors, `/uploads/*` included, is then checked against the behaviors ahead of it. When an earlier, broader behavior would also match its test path, as a legacy `/person/*` matches `/person/*.json`, the gated behavior is moved to just before it (`place_before_shadow` in [`cf.jq`](../../scripts/infra/lib/cf.jq)). The test path for each pattern is the pattern with every `*` replaced by `x`, so `/uploads/*` is tested with `/uploads/x`. Nothing else is reordered.

Before the diff, the script prints `gating /person/*.json /family/* /event/* /note/* /place/* /media/* /uploads/* on origin <origin-id> with <version ARN> (CachingDisabled, response headers policy <id>: Cache-Control: private, no-store; /uploads/* keeps its origin and gets policy <uploads-id>)`. When nothing needs to change, it prints `distribution <distribution-id> already has the data-gate behaviors (/person/*.json /family/* /event/* /note/* /place/* /media/* /uploads/*) on <version ARN> with response headers policies <id> and <uploads-id>: no change`.

On a distribution with the public `/uploads/*`, the first attach adds six behaviors (`CacheBehaviors.Quantity` grows by 6) and modifies `/uploads/*` in place. On one without `/uploads/*`, such as the sample [`cloudfront/distribution.json`](../../cloudfront/distribution.json), it adds seven. On one whose six data behaviors the script already gated before it handled `/uploads/*`, a rerun modifies only `/uploads/*`, because the six data behaviors are built exactly as before. A new published gate version is attached by running the script again: all seven behaviors are repointed in place, so the diff changes seven `LambdaFunctionARN` values.

#### Remove mode

`add-data-gate-behaviors.sh --remove` is the gate's rollback. After reading the config, it:

1. Deletes each behavior whose path pattern is one of the six data patterns and that carries a Lambda@Edge association with a numbered version of `--function-name`. On a gated distribution, `CacheBehaviors.Quantity` drops by 6. A behavior with a data pattern but no such association is not the script's, and is kept.
2. Puts `/uploads/*` back to its public state in place, when it carries such an association: no Lambda@Edge association, `CachingOptimized`, and the response headers policy to restore. Its position, origin and other fields are kept, and it is never deleted. An `/uploads/*` without the association is left as it is, and no policy is looked up for it.
3. Runs steps 7 to 10 above, so `--remove --dry-run` prints the diff only, and a real run saves a backup before it updates.

The policy to restore is `--restore-uploads-policy-id ID` if given. Otherwise it is the `UploadsResponseHeadersPolicyId` output of the stack named by `--app-stack`, default `hfy-app`, read in the AWS CLI's default Region. The live app stack is `<app-stack>` in `us-west-2`. So while `/uploads/*` is gated, every production `--remove`, `--remove --dry-run` included, passes `--app-stack <app-stack>` with `us-west-2` as the CLI's Region, or `--restore-uploads-policy-id`. Without either, the lookup of `hfy-app` fails: after any AWS CLI error, the script prints `stack hfy-app has no output UploadsResponseHeadersPolicyId` and `pass --restore-uploads-policy-id ID to name the response headers policy /uploads/* gets back`, exits 1, and changes nothing. An offline `--config-file` dry run looks nothing up: it prints `(dry-run) uploads policy to restore not looked up (offline); using a placeholder id`, and the diff uses `<hfy-app UploadsResponseHeadersPolicyId>`, named after `--app-stack`. `--stack` is not read by `--remove`.

With `--remove`, the script resolves no version ARN, checks no origin, reads no secret, and never reads, creates or changes a response headers policy. `hfy-private-no-store` and `hfy-uploads-private` stay in the account, unused, for the next attach. A second `--remove`, or one on a distribution without the gate, changes nothing and exits 0, printing `distribution <distribution-id> already has no hfy-edge-gate-gated data behaviors (/person/*.json /family/* /event/* /note/* /place/* /media/*) and /uploads/* back to its ungated state: no change`. Restoring the [pre-change backup](#pre-change-backup) of the attach with `update-distribution` is the alternative.

After a removal, member photos are readable by anyone who holds a URL, and cacheable again. `remove_gate_behaviors` in [`cf.jq`](../../scripts/infra/lib/cf.jq) deletes only the gated behaviors and leaves every other behavior in place. So each of the six data paths goes to the first remaining behavior that matches it, which is the default behavior unless another behavior matches first. A broader behavior that matches first, such as a legacy `/person/*` on the S3 origin with no function or Lambda@Edge association, as in the [`live-like.json`](../../scripts/infra/test/fixtures/live-like.json) fixture, serves those paths from S3 to anyone: with it, `/person/<gramps-id>.json` and the search index under `person/` are public. For the paths that reach the default behavior, the result depends on the `HFYAppendIndex` code on its LIVE stage:

| `HFYAppendIndex` on LIVE | Data paths that reach the default behavior |
|---|---|
| The clean-URL-only code | Served from S3 to anyone. |
| The default-deny code | `404` for every client, the legacy one included. It denies their first segments and any `.json` under `person/` ([CloudFront Function](#cloudfront-function-scriptscloudfrontappend-indexjs)). |

The default-deny code never runs for a path that another behavior matches first. [Reads](private-data-and-secrets.md#reads) in the private data and secrets reference lists what each data prefix serves in each state, and [roll back](../how-to/cut-over-to-the-private-data-gate.md#roll-back) in the cut-over how-to gives the order in which to remove the gate and turn the `authV2` flag off.

#### Exit status

| Status | Meaning |
|---|---|
| 0 | Updated, dry run finished, or no change needed. This includes a `--remove` run, and an `add-uploads-behavior.sh` run that leaves a gated `/uploads/*` as it is. |
| 1 | A stack output is missing; the API, auth or MCP script gets no host from the Function URL (`no function URL host`); the origin-verify secret cannot be read on a real run; the uploads or data gate target origin is not in the distribution; `add-mcp-behavior.sh` has no Lambda@Edge version ARN on a real run; `add-data-gate-behaviors.sh` gets no ID or ETag back for a response headers policy; or `add-data-gate-behaviors.sh --remove` cannot determine the policy `/uploads/*` gets back. |
| 2 | Unknown argument, or `--config-file` without `--dry-run`. `add-mcp-behavior.sh`: `--write-after` without `--dry-run`, or an ARN that is not a qualified `us-east-1` ARN whose qualifier starts with a digit. `add-data-gate-behaviors.sh`: an invalid or unqualified gate version ARN. |
| 3 | `add-mcp-behavior.sh`: an earlier behavior matches an MCP path and would shadow it. |
| Other non-zero | An AWS CLI call failed, for example `update-distribution` rejected because the ETag no longer matches. |

### `publish-append-index.sh`

[`publish-append-index.sh`](../../scripts/infra/publish-append-index.sh) publishes [`scripts/cloudfront/append-index.js`](#cloudfront-function-scriptscloudfrontappend-indexjs) as the CloudFront Function `HFYAppendIndex`. It never creates the function: the first creation and the association with the default behavior are manual ([stand up the static site](../how-to/stand-up-the-static-site.md)). For the procedure, see [publish a change to the HFYAppendIndex CloudFront Function](../how-to/publish-the-cloudfront-function.md).

```
scripts/infra/publish-append-index.sh [--dry-run] [--name HFYAppendIndex] [--source FILE]
    [--distribution <distribution-id>|none] [--cases FILE] [--all-cases] [--comment TEXT]
```

| Option | Default | Effect |
|---|---|---|
| `--dry-run` | Off | Reads only: prints the diffs and the plan. |
| `--name` | `HFYAppendIndex` | The function to publish. |
| `--source` | `scripts/cloudfront/append-index.js` | The code to publish. Any other file skips the local unit tests. |
| `--distribution` | `<distribution-id>` | The distribution whose associations are checked. `none` skips the check, for a scratch function. |
| `--cases` | `scripts/cloudfront/test/append-index.cases.json` | The case table for `test-function`. |
| `--all-cases` | Off | Runs every rewrite and deny case through `test-function`, about 0.8 s each, instead of the `awsSamples` subset. |
| `--comment` | `Append index.html to directory paths; 404 for private data prefix variants (HFY data gate)` | The function comment, set with the code. At most 128 characters. |

What a run does:

1. Refuse, with exit 2 and no AWS call, a missing or empty source or case file, a source over 10 KB, a source with no `function handler(`, a comment over 128 characters, or a case table without `rewrite`, `deny` and `awsSamples` cases.
2. When the source is the repository file and `node` is installed, run `node --test scripts/cloudfront/test/append-index.test.mjs` and refuse with exit 1 if it fails.
3. Describe and get the `DEVELOPMENT` and `LIVE` stages. A function that does not exist is refused with exit 1 (`refusing: cannot describe function HFYAppendIndex (it must exist; create it once with aws cloudfront create-function)`), and so is a runtime other than `cloudfront-js-1.0`.
4. Unless `--distribution none`, read the distribution config, and refuse with exit 3 when the function is associated with any cache behavior other than the default, naming that behavior. An unreadable distribution is refused with exit 1. It prints whether the function is the default behavior's viewer-request function.
5. Print the diffs of `LIVE` and of `DEVELOPMENT` against the source. If `LIVE` already runs the source, print `function HFYAppendIndex already runs the repo code on LIVE: no change` and exit 0, leaving a different `DEVELOPMENT` draft alone.
6. With `--dry-run`, print the plan and `(dry-run) no changes made`, and exit 0.
7. Save the current `LIVE` code when a `LIVE` stage exists, and a `DEVELOPMENT` copy that differs from both `LIVE` and the source, as `HFYAppendIndex-<stage>-<UTC timestamp>-before.js`, mode 600, in the [backup directory](#pre-change-backup) of the behavior scripts.
8. Unless `DEVELOPMENT` already holds the source, run `update-function` with `--if-match`, the source and the comment, and read `DEVELOPMENT` back. If `update-function` returns no ETag, print `update-function returned no ETag` and exit 1.
9. Run `test-function` on `DEVELOPMENT` for each case, as a `GET` viewer request. A rewrite case must come back as the expected URI, and a deny case as `404` with `cache-control: private, no-store`. Any mismatch or function error prints a `FAIL` line, and the script refuses to publish with exit 1, leaving `LIVE` untouched.
10. Run `publish-function`, read `LIVE` back, and print `published: HFYAppendIndex LIVE now runs the repo code`. No `update-distribution` is needed, because the association holds the function ARN. When a `LIVE` stage existed before the run, so that step 7 saved its code, it then prints the rollback commands after `roll back with:`: `update-function` with the saved `LIVE` code and comment, and `publish-function`. A run that published the first `LIVE` stage prints none.

A run interrupted after step 8 resumes on a rerun: `DEVELOPMENT` already holds the source, so the run goes straight to the tests and the publish. Because every run tests the deny cases, the script refuses to publish the earlier clean-URL-only code. The printed rollback commands are the way back to it.

| Status | Meaning |
|---|---|
| 0 | Published, dry run finished, or `LIVE` already runs the source. |
| 1 | The local unit tests or a `test-function` case failed; the function does not exist; its runtime is not `cloudfront-js-1.0`; the distribution cannot be read; `update-function` returned no ETag; or a stage does not hold the source after `update-function` or `publish-function`. |
| 2 | Unknown argument, or one of the input refusals in step 1. |
| 3 | The function is associated with a cache behavior other than the default. |
| Other non-zero | An AWS CLI call failed, for example on an ETag that no longer matches. |

### `check-site-bucket-cors.sh`

```sh
scripts/infra/check-site-bucket-cors.sh [--url URL] [--rule FILE]
```

A live, read-only check of the site bucket's CORS rule (HFY-TSK-314). It sends CORS preflights, `OPTIONS` requests, to `--url`, by default `https://<site-bucket>.s3.us-west-2.amazonaws.com/uploads/posts/smoke/x.jpg`, and nothing else. S3 answers a preflight from the bucket's CORS configuration alone, so the object need not exist. The origins it expects come from `--rule`, by default [`site-bucket-cors.json`](../../infrastructure/cloudformation/site-bucket-cors.json). Each `curl` call has a 20 s timeout and 3 retries 5 s apart.

| Probe | Passes on |
|---|---|
| `PUT` with `Content-Type`, from each origin in the rule | `200`, `Access-Control-Allow-Origin` equal to that origin, and `PUT` in `Access-Control-Allow-Methods` |
| `PUT` with `Content-Type`, from `https://cors-check.invalid` | `403` |
| `DELETE`, from the rule's first origin | `403` |
| `PUT` with `Content-Type` and `x-amz-acl`, from the rule's first origin | `403` |

It prints an `ok` line for each probe that passes and a GitHub Actions `::error::` line for each that fails, then `site bucket CORS: <n> probes, <m> failed`. No response at all fails a probe, including one that expects `403`.

| Status | Meaning |
|---|---|
| 0 | Every probe passed. |
| 1 | A probe failed. |
| 2 | Unknown argument, a `--url` that is not `https://`, a rule file that cannot be read or allows no origin or a wildcard origin, or `curl` or `jq` missing. No request is sent. |

[`post-deploy-checks.yml`](#post-deploy-checksyml) runs it after every successful deploy run. Its offline tests run it against [`stub-curl/curl`](../../scripts/infra/test/stub-curl/curl), which answers a preflight as S3 does from a CORS configuration in the test's state directory.

### Shared helpers: `scripts/infra/lib/`

| File | Contents |
|---|---|
| [`cf-common.sh`](../../scripts/infra/lib/cf-common.sh) | Sourced by the five `add-*` scripts and `publish-append-index.sh`, not run on its own. It defines the managed policy IDs (`CachingDisabled`, `CachingOptimized`, `AllViewerExceptHostHeader`), `UPLOADS_CSP` (the Content-Security-Policy of the app stack's `UploadsResponseHeadersPolicy`), and the functions for argument checks (`cf_check_args`), stack outputs (`cf_stack_output`), the origin-verify value (`cf_origin_verify`), the backup directory (`cf_backup_dir`), loading the config (`cf_load`), and the compare, diff, backup and update step (`cf_apply`). `cf_response_headers_policy` is the find, create or repair of a custom response headers policy by name that the data gate script uses for both of its policies; given a CSP, it also checks the uploads policy's security headers. |
| [`cf.jq`](../../scripts/infra/lib/cf.jq) | Pure `jq` functions over a `DistributionConfig`, loaded with `jq -L scripts/infra/lib 'include "cf"; …'`: `norm`, CloudFront path-pattern matching (`pattern_matches`), in-place `upsert_origin` and `upsert_behavior`, `place_before_shadow` for the gated behaviors' order, `remove_gate_behaviors` for `--remove`, `behavior_gated` (does a behavior carry the gate association) and `ungate_behavior` (the `/uploads/*` restore), `rhp_forces_cache_control` and `rhp_uploads_private` for the response headers policy checks, and `redact_origin_verify`. |

## Other scripts

### CloudFront Function: `scripts/cloudfront/append-index.js`

[`scripts/cloudfront/append-index.js`](../../scripts/cloudfront/append-index.js) is the source of the CloudFront Function `HFYAppendIndex`, runtime `cloudfront-js-1.0`: ES5.1 only, at most 10 KB. It runs on viewer requests to the default (S3) behavior, and must not be associated with any other behavior, where it would answer `404` for the gated data itself. `publish-append-index.sh` refuses to publish while it is.

It first rewrites clean URLs:

| Request URI | Rewritten to |
|---|---|
| Ends with `/` | URI + `index.html` |
| Contains no `.` anywhere | URI + `/index.html` |
| Anything else | Unchanged |

The dot test looks at the whole URI, so a path with a dot in any segment is never rewritten.

It then default-denies on the rewritten URI. To find the first path segment, it percent-decodes the URI up to four rounds (a malformed escape is kept as it is), lowercases it, turns backslashes into `/`, strips `;params` and surrounding spaces from each segment, resolves `.` and `..` segments, and trims trailing dots and spaces.

| First segment | Result |
|---|---|
| `family`, `event`, `note`, `place`, `media` or `uploads` (`DENY_FIRST_SEGMENTS`) | `404` |
| `person`, when the decoded, lowercased URI contains `.json` | `404` |
| `person`, when the rewritten URI is not in `PUBLIC_PERSON_FILES`, which holds only `/person/index.html` (reached from `/person/` and `/person`) | `404` |
| Anything else | The request goes on to S3 |

The `404` response has status description `Not Found` and the header `cache-control: private, no-store`, and never reaches S3.

CloudFront path patterns are case-sensitive, and `/person/*.json` is anchored on its suffix. A request reaches the function only through the default behavior:

| Request | Reaches `HFYAppendIndex` |
|---|---|
| A variant spelling of a private path that no gated pattern matches, such as `/Person/index.json`, `/person/x.JSON` or `/person/x.json/` | Yes, unless another behavior matches it first |
| An exact data path, such as `/person/index.json`, while the gate is attached | No. Its gated behavior matches first. |
| An exact data path without the gate | Yes, unless another behavior, such as a legacy `/person/*`, matches it first ([remove mode](#remove-mode)) |
| An exact `/uploads/` path | No, while a `/uploads/*` behavior exists, gated or not |

For the reasoning, see [why the CloudFront Function also denies](../explanation/edge-and-origin-design.md#why-the-cloudfront-function-also-denies).

Tests pin the two lists: `DENY_FIRST_SEGMENTS` must equal the non-person patterns of `add-data-gate-behaviors.sh`, and `PUBLIC_PERSON_FILES` the files in `11ty/person/`. A new public file under `11ty/person/` is added to `PUBLIC_PERSON_FILES` in the same change. The tests are `node --test scripts/cloudfront/test/*.test.mjs` ([test suites](#test-suites)).

The function is created and associated by hand the first time ([stand up the static site](../how-to/stand-up-the-static-site.md)), and later code changes are published with [`publish-append-index.sh`](#publish-append-indexsh). No workflow or stack manages it.

### MCP token smoke: `scripts/mcp/token-smoke.sh`

[`scripts/mcp/token-smoke.sh`](../../scripts/mcp/token-smoke.sh) checks an MCP access token against the live auth edge without printing the token.

```
MCP_TOKEN=<access-token> scripts/mcp/token-smoke.sh [--base URL] [--audience URL]
```

| Argument | Default |
|---|---|
| `MCP_TOKEN` (environment, required) | None. Get one through the authorization-code + PKCE flow against `/auth/authorize` and `/auth/token`. See [connect an MCP client](../how-to/connect-an-mcp-client.md). |
| `--base` | `https://<site>/auth` |
| `--audience` | `https://<site>/mcp` |

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

### Orchestration tooling: `scripts/orchestration/`

[`scripts/orchestration/`](../../scripts/orchestration/README.md) holds the HFY-PLN-002 orchestrator's Workflow scripts and its batch, catalog, GitHub and mirror tools. Its README lists each tool's inputs and outputs and how to run it. No workflow runs them.

## Git hook: `scripts/git-hooks/pre-commit`

[`scripts/git-hooks/pre-commit`](../../scripts/git-hooks/pre-commit) runs from the repository root, in this order:

1. If [`scripts/check-deployment-sync.sh`](../../scripts/check-deployment-sync.sh) is executable, run it. A failure blocks the commit. If it is not executable, print a warning and continue.
2. Run [`scripts/ci/check-no-family-data.sh`](../../scripts/ci/check-no-family-data.sh), the family-data guard: it fails when a tracked file in a data directory, or any `*.gramps`, `*.sqlite` or `*.db` file, is not on [`data-sample-allowlist.txt`](../../scripts/ci/data-sample-allowlist.txt) (path and sha256). A missing guard script blocks the commit. It needs no CodeArtifact access.
3. Require `trufflehog` on `PATH`. If it is missing, exit 1.
4. Run `trufflehog --no-update --fail filesystem .`. This scans the files on disk under the checkout, not only the staged changes.

| Exit status | Meaning |
|---|---|
| 0 | No findings. The commit proceeds. |
| 183 | TruffleHog found potential secrets. |
| Any other non-zero | The sync check or the family-data guard failed, `trufflehog` is missing, or TruffleHog itself failed. |

The hook is active in a clone whose `core.hooksPath` is `scripts/git-hooks` (`git config core.hooksPath scripts/git-hooks`). `SKIP_DEPLOYMENT_SYNC_CHECK=1` skips the sync check. The TruffleHog scan still runs.

## Workspace helper scripts

These scripts predate the E5 release. They assume the checkout sits at `<project>/repo`, with `<project>/workspace/`, `<project>/workspace-local/` and `<project>/docs/` beside it. Each one takes `<project>` to be the checkout's parent directory.

| Script | Reads | Writes | Options |
|---|---|---|---|
| [`check-deployment-sync.sh`](../../scripts/check-deployment-sync.sh) | Staged file names. For staged `11ty/*`: `<eleventy-source>/_site` against `11ty/`, with the excludes listed below. Nothing else: HFY-TSK-326 removed the `lambda/*` comparison with the deleted `hfy-check-allowed` source, and HFY-TSK-325 removed the `functions/*` comparison with the deleted `getAllowlist` source. | Nothing | `SKIP_DEPLOYMENT_SYNC_CHECK=1` |
| [`validate_build.sh`](../../scripts/validate_build.sh) | `<eleventy-source>/_site/index.html` | Nothing | None |
| [`promote_workspace_assets.sh`](../../scripts/promote_workspace_assets.sh) | A session-log JSON whose `changes[]` entries have `promote: true`, `workspace_path` (relative to `<project>`), `repo_path` (relative to the checkout) and `notes` | The listed paths in this checkout | `--log FILE` (required, relative to the current directory), `--dry-run` or `-n`, `-h` |
| [`sync_sanitized_assets.py`](../../scripts/sync_sanitized_assets.py) | `<project>/workspace-local/allowlist/`, `<project>/workspace-local/cloudfront/`, `<project>/workspace-local/coming-soon-index.html` | Placeholders under `<project>/workspace/` (with `--sync`) | `--sync` |

Behavior details:

- **`check-deployment-sync.sh`** needs `rsync`, and exits 1 without it even when nothing relevant is staged. It compares with `rsync -ain --delete --omit-dir-times` and fails on any itemized line. It compares the working tree, not the staged content. `rsync` matches on size and modification time, so files with the same content but different timestamps, as in a fresh clone, also count as differences. A missing source or destination directory is an error. It names `<project>/docs/deployment.md` in its messages but does not read it.
- **The `11ty/` comparison excludes** the data directories (`person/`, `family/`, `event/`, `note/`, `media/`, `place/`), `private/`, `uploads/`, `README.md` and `.DS_Store`, and the repository-owned files that `<eleventy-source>` does not produce or produces only in an older form: `_data/flags.json`, `js/islands/`, `js/auth-v2.js`, `js/feature-flags.js`, `js/person-page.js` (which carries the `authV2` data-gate path, HFY-TSK-080), `family-login/` (the redirect page to `/auth/login`, HFY-TSK-317), `css/auth-edge.css`, `css/hfy-theme.css` and `fonts/` (islands build output), `sw.js`, `manifest.webmanifest`, `offline.html`, `images/pwa-*.png`, `posts/` and `me/`. This list must equal the exclude list of the refresh rsync in [`11ty/README.md`](../../11ty/README.md), apart from `.DS_Store`, and `scripts/infra/test/run.sh` fails when they differ. It does not exclude the Eleventy pages outside the excluded directories, which the repository changes after the Eleventy build: each carries an `auth-v2.js` script tag that `<eleventy-source>` does not emit, and the islands build rewrites their head blocks, Voice copy and `?v=<sha8>` versions. Those pages count as differences, so a commit that stages any `11ty/` file fails the check (see the [codebase map](codebase-map.md)).
- **`validate_build.sh`** fails if a page of the Eleventy build still loads the retired Google sign-in or Lunr search (`accounts.google.com/gsi/client`, `/api/check-allowed`, `/js/auth.js`, `/js/search-navbar.js`, `/js/search-results.js`), if the build still emits `js/auth.js`, `js/search-navbar.js` or `js/search-results.js`, or if its `family-login/index.html` is not the redirect to `/auth/login` (HFY-TSK-317). Run it before a refresh: it is what tells you the Eleventy layout has been ported. It validates the Eleventy build in the workspace, not `11ty/` in this checkout.
- **`promote_workspace_assets.sh`** needs `python3`, which parses the session log, and `rsync`. It copies a file entry with `rsync -a`. It mirrors a directory entry with `rsync -a --delete`, which removes files in the destination directory that the source lacks, `README.md` files included. It has no exclude list. A directory entry that mirrors the Eleventy output into `11ty/` would delete the repository-owned files the workspace does not produce, such as `js/islands/`, `css/hfy-theme.css`, `css/auth-edge.css` and `fonts/`, and overwrite those it holds an older copy of, such as `js/person-page.js` and `js/auth.js`. Promoted pages also lack the islands build's head blocks, Voice copy and versions until the islands build runs again ([refresh the Eleventy output](../how-to/refresh-the-eleventy-output.md)). A missing workspace path prints a warning and is skipped. An unknown argument prints the usage and exits 1.
- **`sync_sanitized_assets.py`** reports each private file with no sanitized counterpart, and with `--sync` it writes a placeholder for it. Placeholders are a JSON list of two `example.com` addresses for the allowlist, a `{"placeholder": true, …}` JSON for CloudFront files, and an HTML comment for the coming-soon page. It never copies real data, never overwrites an existing file and never writes into the checkout. It always exits 0. Run with no arguments, it reports.

How each behaves when the parent directory is `<parent>` rather than `<project>`:

| Script | Behavior |
|---|---|
| `check-deployment-sync.sh` | Exits 0 when no `11ty/` or `lambda/` file is staged. Otherwise the sources under `<parent>` are missing, so it exits 1 and blocks the commit unless `SKIP_DEPLOYMENT_SYNC_CHECK=1` is set. |
| `validate_build.sh` | Exits 1 because the build directory under `<parent>` is not found. |
| `promote_workspace_assets.sh` | Reads workspace paths from `<parent>`. Missing paths are skipped with a warning, and anything found is written into this checkout. |
| `sync_sanitized_assets.py` | When `<parent>` has no `workspace-local/`, it skips every entry and prints `[OK] Sanitized workspace mirrors workspace-local for tracked assets.`, an OK that checked nothing. |

## Test suites

No workflow runs any of these. For the order to run them in, see [run the tests](../how-to/run-the-tests.md).

| Suite | Runner | Command | Target | Needs | Artifacts |
|---|---|---|---|---|---|
| API | Vitest 3.2.4, then `node --test` for `api/test/records/*.node-test.js` | `cd api && npm ci && npm test` | In-process: [`api/test/records/ops.node-test.js`](../../api/test/records/ops.node-test.js) (the EditOp engine: the apply-then-inverse property over 1,500 random sequences and 1,500 random batches, one test per rebase row, key addressing under reordering, MediaRef `ref#n` keys, Dates edited from a reduced view, handle minting and purity; it imports nothing outside the module and needs no install), [`api/test/records/semantics.node-test.js`](../../api/test/records/semantics.node-test.js) (the Gramps rules: every date, birth and death index and calendar against the values Gramps 6.0.6 computed, plus one test per rule for member and admin dates, references, two-sided family links, family sanity and ancestry cycles; it needs no install), [`api/test/records/relationships.node-test.js`](../../api/test/records/relationships.node-test.js) (the relationship compiler and the duplicate matcher: every golden scenario compiled and compared object by object with what Gramps 6.0.6 left in its database, the slot rule, family reuse and the single-parent rule, cycles, stubs, the 10-children and 100-action limits, unlink, and the matcher on a synthetic near-duplicate name; it needs no install) and [`api/test/`](../../api/test/) (`api`, `contracts`, `hardening`, `jwks`, `labels`, `mcp`, `mcp-conformance`, `mcp-infra`, `origin`, `package-api`, `presign`, `producers`, `txn`) against an in-memory DynamoDB fake ([`api/test/fake-ddb.js`](../../api/test/fake-ddb.js)) and locally generated keys. `package-api` runs the real `scripts/ci/package-api.sh` on a temporary copy with `npm` and `zip` replaced by shims. `presign` runs the AWS SDK presigner offline with fake credentials, and checks that the upload `PUT` goes to the bucket's S3 endpoint, never to the site host, so the members-only `/uploads/*` behavior never sees an upload. `labels` checks that author labels come from the person record's `displayName`, never an email (HFY-R68). `mcp` drives the mounted MCP server through the group config, the permission policy and the API's own route handlers. `mcp-conformance` runs the `@io-kit/mcp` conformance corpus, MCP-C01 to MCP-C12, against this repository's MCP edge and core. `txn` covers `transact()` v2 (update and condition-check items, token reuse, the `TransactionConflict` retry, cancellation-reason mapping, the counter, merge and size helpers), the fake's Update, `CancellationReasons`, `Select: COUNT` and `failNext`, the `503 busy` and `409` mappings, and that `errorResponse` logs only `{name, code, route, requestId}`. `mcp-infra` runs `add-mcp-behavior.sh` as an offline dry run against the infra fixture config, runs the inline code of `mcp-edge401.us-east-1.yaml` and compares it with the packaged `edge-401-header.mjs`, and checks that `tools/list` matches the capabilities. | Node 22+; `CODEARTIFACT_AUTH_TOKEN`; `bash` and `jq`; `shellcheck` is used when installed | Console only |
| MCP conformance gate | bash, Vitest 3.2.4 and `io-kit parity` | `scripts/ci/mcp-conformance.sh [report-only\|blocking]` | In-process: the `mcp-conformance`, `mcp` and `mcp-infra` files of the API suite, then `io-kit parity diff` of the MCP tools against [`api/parity/routes.yaml`](../../api/parity/routes.yaml) and [`api/parity/map.yaml`](../../api/parity/map.yaml). See [build scripts](#build-scripts-scriptsci). | Node 22+; `CODEARTIFACT_AUTH_TOKEN`; `bash` and `jq` | The generated files in `api/dist/` (gitignored); console |
| Auth edge | Vitest 3.2.4 | `cd auth && npm ci && npm test` | In-process: [`auth/test/`](../../auth/test/) (`cognito`, `edge`, `linkstore`, `oauth`, `origin`, `passkey`, `passkeystore`, `userinfo`). `edge` also covers the sign-in pages: the `Referrer-Policy` (`strict-origin-when-cross-origin`, never `no-referrer`), `font-src 'self'`, the CSP `style-src` origin, the versioned `theme.cssUrl`, the manifest copy keys, and each HTML override in [`auth/src/edge.js`](../../auth/src/edge.js). `linkstore` and `passkeystore` read the table's key schema from `app-stack.yaml`. `passkeystore` runs the repository's passkey store on a fake table that applies DynamoDB's sparse-index rule. | Node 22+; `CODEARTIFACT_AUTH_TOKEN` | Console only |
| Passkey end to end | Node script driving Playwright 1.55.0's Chromium | `cd auth && npm ci && npx playwright install chromium && npm run e2e` | `http://localhost:<E2E_PORT>` (default 4173; the server binds `127.0.0.1`), served in-process by the real auth edge app with test-only wiring: relying party `localhost`, a stub password provider, in-memory stores and a synthetic allowlist. Chromium uses a CDP virtual authenticator with user verification. [`auth/e2e/passkey.e2e.mjs`](../../auth/e2e/passkey.e2e.mjs) covers the login page's passkey option, password sign-in, passkey enrolment and listing, sign-out, usernameless passkey sign-in with `amr` including `passkey` and `mfa`, refusal (403) after removal from the allowlist and recovery after re-adding, and refusal (401) of a deleted credential. | Node 22+; `CODEARTIFACT_AUTH_TOKEN`; Playwright's Chromium; the port free | Console only: a `PASS` or `FAIL` line per scenario and a `<passed>/<total> scenarios passed` line. Exits 1 if any scenario failed. |
| Sign-in theme end to end | Node script driving Playwright 1.55.0 with its bundled headless shell (`channel: chromium-headless-shell`; `PW_CHANNEL` names another) | `cd auth && npm ci && SITE=<scratch-site> npm run e2e:theme`, where `<scratch-site>` is a copy of `11ty/` built with `cd islands && node build.mjs --site <scratch-site>` | `http://localhost:<E2E_PORT>` (default 4175; the server binds `127.0.0.1`): the real auth edge pages with their real CSP and test-only wiring (a stub password provider, in-memory stores, a synthetic allowlist). The manifest's versioned `cssUrl` is pointed at the same server, which serves `/css` and `/fonts` from `SITE`. [`auth/e2e/signin-theme.e2e.mjs`](../../auth/e2e/signin-theme.e2e.mjs) checks `/auth/login`, the forgot and reset password pages, `/auth/link` signed out and the denied page, at 375 and 1024 px. `E2E_OFFLINE=1` blocks Google Identity Services requests. | Node 22+; `CODEARTIFACT_AUTH_TOKEN`; the headless shell build for Playwright 1.55.0 (`npx playwright install chromium-headless-shell` in `auth/`); a scratch site; the port free | Console: a `PASS` or `FAIL` line per check and a `<passed>/<total> checks passed` line. With `E2E_SHOTS=<dir>`, a full-page screenshot per page and width. Exits 2 without `SITE`, and 1 if any check failed. |
| Edge gate | `node --test` | `cd edge-gate && npm test` | Offline: [`edge-gate/test/gate.test.mjs`](../../edge-gate/test/gate.test.mjs) runs `src/gate.mjs` with locally generated RSA keys, a stubbed JWKS fetch and a fixed clock. It covers the allow and deny responses, the signature, issuer, audience and expiry checks, JWKS refetch, backoff and outage behavior, `Cache-Control: private, no-store` on every gate response, and `gate.config.json` against `auth/edge.manifest.json`. | Node 22+; no install (the gate has no dependencies) | Console only |
| Gramps goldens | `python3 -m unittest discover gramps/tests/unit` (in CI), `python3 scripts/records/check_gramps_goldens.py`, `python3 scripts/records/check_relationship_goldens.py`; regeneration `python3 scripts/records/gen-gramps-semantics-goldens.py [--check]`, `python3 scripts/records/gen-gramps-relationship-goldens.py [--check]` | `python3 -m unittest discover gramps/tests/unit` | Offline, standard library only: [`gramps/tests/unit/test_gramps_goldens.py`](../../gramps/tests/unit/test_gramps_goldens.py) runs [`check_gramps_goldens.py`](../../scripts/records/check_gramps_goldens.py), which verifies [`gramps-semantics.golden.json`](../../api/test/records/fixtures/gramps-semantics.golden.json) without Gramps: the SHA-256, the counts (at least 200 valid Gregorian and Julian dates), every Gregorian and Julian `sortval` and validity against an independent computation, and every birth and death index against the `set_birth_death_index` rule; and that a hand edit is caught. [`test_gramps_relationship_goldens.py`](../../gramps/tests/unit/test_gramps_relationship_goldens.py) runs [`check_relationship_goldens.py`](../../scripts/records/check_relationship_goldens.py) over [`gramps-relationships.golden.json`](../../api/test/records/fixtures/gramps-relationships.golden.json): the SHA-256 and counts, two-sided family links, family sanity and the ancestry rule over the whole tree before and after every scenario, what a scenario may change and that lists grow by appending, the father/mother slot rule on every new family, the shape of every created object (an empty `gramps_id`, the stub's Birth Name, year-only events with an independently computed `sortval`), that the acceptance cases are all present, and that a tampered file is caught. Only regeneration needs Gramps.app 6.0.6 (see [Regenerate the Gramps goldens](../how-to/regenerate-the-gramps-goldens.md)). | Python 3 (3.13 and Gramps.app 6.0.6 for regeneration only) | Console only; regeneration uses a temporary `GRAMPSHOME`, removed on exit |
| Graph builder | `node --test` | `cd graph && npm ci && node --test` | Offline: [`graph/test/`](../../graph/test/) builds the graph from synthetic Gramps objects. It covers the allowlist projection, the messy-genealogy golden, `verify()` and the schema (cross-checked with ajv), shuffled input giving identical bytes, atomic writes, the exit codes and `--verify-against`. The `--from-gramps-copy` tests use a stub `sqlite3`, and one more uses the real `sqlite3` when it is installed. | Node 22+; `npm ci` installs `ajv`, a dev dependency, from the public registry | Console only; temp directories removed |
| CloudFront Function | `node --test` | `node --test scripts/cloudfront/test/*.test.mjs`, from the repository root | Offline: [`scripts/cloudfront/test/append-index.test.mjs`](../../scripts/cloudfront/test/append-index.test.mjs) loads `append-index.js` into a bare `vm` context, as CloudFront runs it, and runs the shared case table [`append-index.cases.json`](../../scripts/cloudfront/test/append-index.cases.json) (`rewrite`, `deny` and `awsSamples` cases). It checks the clean-URL rewrite, the `404` with `cache-control: private, no-store` for every deny case, that no path tracked under `11ty/` is denied, that `PUBLIC_PERSON_FILES` and `DENY_FIRST_SEGMENTS` match `11ty/person/` and the gate script's patterns, and that the source is ES5.1 and under 10 KB. `scripts/infra/test/run.sh` and `publish-append-index.sh` run it too. | Node 22+; a Git checkout (it lists the tracked `11ty/` files); no install | Console only |
| Client scripts | `node --test` | `node --test tests/client/*.test.mjs`, from the repository root | Offline: [`tests/client/`](../../tests/client/) loads the real `11ty/js/feature-flags.js`, and `auth-v2.js`, into a `vm` sandbox with stubbed `fetch`, storage and location. `data-fetch` checks the `authV2` data-fetch path (HFY-TSK-080). `auth-continuity` checks session continuity (HFY-R66): the session check, the silent `POST /auth/refresh` before a data fetch or after a gate 401, and the single retry. It also runs the inline script of the `/family-login/` redirect page: `?next=<path>` hands a same-origin path to `/auth/login` as `returnTo`, and a missing or unsafe one falls back to `/`. | Node 22+; no install | Console only |
| Gramps unit tests | Python `unittest` | `python3 -m unittest discover gramps/tests/unit` (Python 3.12 or later, standard library only; CI runs it) | Offline: `test_scanner` (the R-18 detector port against `shared/privacy-guard.vectors.json`), `test_synthetic_fixture` (the synthetic tree's goldens and census) and the renderer suites (`test_render_*`). The renderer suites render P(fixture) with `hfygramps.render.render_site` and require every file to match the live ETL's committed golden except the listed deltas, assert the D-02 contract and the note vectors, and prove the renderer opens no file or socket. Two fixture tests regenerate the goldens and skip unless `/Applications/Gramps.app` is Gramps 6.0.6. | Python 3.12 or later; no install | Console only |
| Island node tests | `node --test` | `cd islands && npm run test:contract` (`node --test tests/*.test.mjs`); `npm run lint:css` runs the theme lint alone | In-process. `contract.test.mjs` runs the kit CommentSource contract over an in-memory store. `content-contract.test.mjs` runs the kit ContentSource contract through the real API handler, and imports [`api/test/world.js`](../../api/test/world.js) and `api/src/content.js`. `bundle.test.mjs` checks that the island bundles, the theme layer, the sign-in stylesheet and the fonts are present and not gitignored, and that `node build.mjs --check` finds every build output up to date. `asset-versions`, `theme-delivery` and `copy` check the `?v=<sha8>` versions and stamped blocks, the head blocks, and the Voice copy in the pages. `theme-lint` rejects literal colours, font families and lengths in the islands CSS and the repository-owned pages. `kit-aliases` checks that every short variable the installed kit CSS reads is mapped. `uploads-gate` checks that the islands load member photos only as same-origin `<img src>`, that the upload goes straight to S3, and that the presign request works with both the `hfy-api` deployed before the RG-2 change set, which requires a `filename`, and the current one. `time` checks the site's time format. `HFY_SITE=<dir>` points the site checks at a `--site` scratch build instead of `11ty/`. | Node 22+; `CODEARTIFACT_AUTH_TOKEN`; `npm ci` in both `islands/` and `api/`, with the dev dependencies; a Git checkout (for `git check-ignore`) | Console only |
| Island Playwright | Playwright 1.64.0 | `cd islands && npx playwright test` (`npm test` runs the node tests first, then this). Name spec files to run only those; outside CI at most 2 workers run, one spec file each (`fullyParallel` is off). | The site served by `npx http-server <site> -p <port> -a 127.0.0.1 -s -c-1`: `<site>` is `HFY_SITE` (default `../11ty`) and `<port>` is `PW_PORT` (default 8089). Viewport 375×812; browser channel `PW_CHANNEL` (default `chromium-headless-shell`, Playwright's bundled headless shell; `chrome` opts into an installed Google Chrome). Specs: `asset-versions`, `auth-continuity`, `d11-fixes`, `flags-fallback`, `islands-look`, `legacy-pages`, `notifications`, `person`, `person-page`, `posts`, `qa-fixes`, `qa2-fixes`, `search`, `shell`, `sw`, `theme-foundation`. Network calls, including `/auth/*` and the gated data paths, are mocked with `page.route` and [synthetic fixtures](../../islands/tests/fixtures/). | `npm ci` in `islands/`; the headless shell build for Playwright 1.64.0 (`npx playwright install chromium-headless-shell`); the committed build output, rebuilt after any `islands/` change, or a `--site` scratch build named by `HFY_SITE`; the port free, or already serving that site (the server is reused) | `list` reporter to the console; `islands/test-results/` on failure (gitignored) |
| Infra scripts | bash, Python `unittest` | `scripts/infra/test/run.sh` | Offline. Runs `add-api-behavior.sh`, `add-auth-behavior.sh`, `add-uploads-behavior.sh`, `add-data-gate-behaviors.sh` and `publish-append-index.sh` with a stub `aws` first on `PATH`, so no call reaches AWS. The behavior scripts run against fixture distribution configs: [`live-like.json`](../../scripts/infra/test/fixtures/live-like.json), and [`live-with-uploads.json`](../../scripts/infra/test/fixtures/live-with-uploads.json), which adds the public `/uploads/*` behavior. Covers the `cf.jq` helpers, `/api/*` retargeted in place with no `/api/check-allowed*` pin and `--legacy-origin` refused as an unknown argument (HFY-TSK-326), the gated behaviors and their order, version ARN refusals, the lookup, creation and repair of both response headers policies, `/uploads/*` gated in place and its drift repair, `add-uploads-behavior.sh` leaving a gated `/uploads/*` alone, `--remove` and its `/uploads/*` restore (`--restore-uploads-policy-id` over the stack output, the refusal when the policy cannot be determined, a second `--remove` as a no-op, both policies kept), no-op reruns, dry runs, backups and secret redaction. For `publish-append-index.sh`, the stub runs the function code in a bare V8 context in place of `test-function`, and the suite covers the diffs, the `test-function` gate, the publish, the backup, idempotency and the refusals. It runs the CloudFront Function suite. [`test_app_stack.py`](../../scripts/infra/test/test_app_stack.py) checks `app-stack.yaml` and `github-roles.yaml`, including that the `UploadsResponseHeadersPolicy` CSP equals `UPLOADS_CSP` and the gate script's uploads policy. [`test_edge_gate_stack.py`](../../scripts/infra/test/test_edge_gate_stack.py) and [`test_mcp_edge401_stack.py`](../../scripts/infra/test/test_mcp_edge401_stack.py) check the two `us-east-1` templates; the second fails when the inline code and the hash in its version description disagree. [`test_privacy_terms_pages.py`](../../scripts/infra/test/test_privacy_terms_pages.py) checks that `11ty/privacy/index.html` and `11ty/terms/index.html` carry each required section of the approved privacy and terms amendment, [`docs/drafts/privacy-terms-2026-10-update.md`](../drafts/privacy-terms-2026-10-update.md), in that text's wording (each pinned sentence must also be in the draft), with its `Last updated` date and the `[DOT]` contact line, that none of the statements it replaced is back, and that section 4 keeps the rows the amendment gives no purpose for in a separate Data Type and Retention table, with no empty Purpose cells. It needs only the Python standard library. It runs `package-edge-gate.sh` on a scratch copy (content-addressed `CodeKey`, reproducible build, new key after a code or config change). It checks that the `11ty/` excludes of `check-deployment-sync.sh` match the refresh rsync in `11ty/README.md`; that `js/person-page.js`, `js/auth.js`, `css/auth-edge.css`, `css/hfy-theme.css` and `fonts/` each appear in the sync check's excludes, the README's rsync excludes and its repository-owned files table; and that `theme.cssUrl` in `auth/edge.manifest.json` is `https://<site>/css/auth-edge.css?v=<sha8 of 11ty/css/auth-edge.css>`. It runs `check-deployment-sync.sh` in a scratch Git repository, including that a staged `lambda/` or `functions/` path starts no comparison. It checks that [`site-bucket-cors.json`](../../infrastructure/cloudformation/site-bucket-cors.json) allows no method but `PUT`, no origin but `https://<site>` and `https://www.<site>`, and no request header but `Content-Type`, and that mutated copies fail that check. It runs `check-site-bucket-cors.sh` against [`stub-curl/curl`](../../scripts/infra/test/stub-curl/curl), a `curl` stub that answers as S3 would, so no request leaves the machine, and checks the `post-deploy-checks.yml` trigger against the rendered deploy workflow's name. `cfn-lint` (on the three templates) and `shellcheck` (on `scripts/infra/`) run when installed and are skipped otherwise. `add-mcp-behavior.sh` is covered by the API suite instead, and the `create-*` scripts are not covered. | `bash`, `jq`, `shasum`, `python3` with PyYAML; `node` for the CloudFront Function and `publish-append-index.sh` checks, `node`, `zip` and `openssl` for the `package-edge-gate.sh` checks, and `rsync` and `git` for the sync-check run, each skipped when missing | Console only. Prints `scripts/infra tests: <n> passed, <m> failed` and exits non-zero if any check failed. |
| Login flow | Playwright `^1.48.0` | `cd tests/login-flow && npm install && npx playwright install chromium webkit && npm test` | **Live production by default** (`HFY_SITE_BASE`, default `https://<site>`). Projects `chromium` (Desktop Chrome) and `webkit` (Desktop Safari). | The environment below; for the password test, a test identity on the allowlist | `playwright-report/`, failure videos in `test-results/` |
| MCP token smoke | bash + Node (`jose`) | `MCP_TOKEN=<access-token> scripts/mcp/token-smoke.sh` | Live auth edge | `npm ci` in `auth/`; a valid access token | Console only |
| Site bucket CORS | bash + `curl` | `scripts/infra/check-site-bucket-cors.sh` | Live: the site bucket's S3 endpoint, by unauthenticated preflights ([details](#check-site-bucket-corssh)) | `curl`, `jq`; no credentials | Console only. `post-deploy-checks.yml` runs it after every successful deploy run. |

### Editing end to end

[`api/test/edit-e2e.test.js`](../../api/test/edit-e2e.test.js) (in `cd api && npm test`) and [`islands/tests/edit-e2e.spec.mjs`](../../islands/tests/edit-e2e.spec.mjs) run five editing scenarios against the real API handler over the DynamoDB fake, [`api/test/edit-e2e-world.js`](../../api/test/edit-e2e-world.js): the browser spec routes the pages' `/api` calls to that handler ([`islands/tests/edit-e2e-bridge.mjs`](../../islands/tests/edit-e2e-bridge.mjs)), so it needs `api/` installed as well as `islands/`. [`islands/tests/edit-d11-audit.spec.mjs`](../../islands/tests/edit-d11-audit.spec.mjs) measures the D-11 checklist on the same stack; see [Editing: the D-11 audit](editing-d11-audit.md).

Photo tagging has its own three scenarios on the same stack ([`api/test/tag-edit-e2e.test.js`](../../api/test/tag-edit-e2e.test.js), [`islands/tests/tag-edit-e2e.spec.mjs`](../../islands/tests/tag-edit-e2e.spec.mjs)) and its own audit ([`islands/tests/tag-edit-d11-audit.spec.mjs`](../../islands/tests/tag-edit-d11-audit.spec.mjs)); see [Photo tagging: the D-11 audit](tagging-d11-audit.md).

### Login-flow environment

[`tests/login-flow/`](../../tests/login-flow/) has no lockfile, so it installs with `npm install`. [`playwright.config.ts`](../../tests/login-flow/playwright.config.ts) sets a 90 s test timeout and a 10 s `expect` timeout, an HTML reporter, video on failure and trace on first retry. No retries are configured, so traces are recorded only when a run passes `--retries`.

| Variable | Read by | Default | Effect |
|---|---|---|---|
| `HFY_SITE_BASE` | Config | `https://<site>` | Site under test. |
| `HFY_EXPECT_GRAMPS` | `auth-v2.spec.ts` | `<gramps-id>` (see [known code issues](#known-code-issues)) | The gramps_id expected in the My Record link and in the session `sub`. |
| `HFY_AUTH_V2` | `auth-v2.spec.ts` | Unset | `1` enables the `auth-v2` spec. Otherwise it is skipped. |
| `HFY_TEST_EMAIL` | `auth-v2.spec.ts` | Unset | A Cognito user on the allowlist. With `HFY_TEST_PASSWORD`, this enables the password-path test. |
| `HFY_TEST_PASSWORD` | `auth-v2.spec.ts` | Unset | That user's password. |

What the spec asserts (the legacy `login-flow.spec.ts` drove the Google sign-in on `/family-login/` and was deleted with it, HFY-TSK-317):

- [`auth-v2.spec.ts`](../../tests/login-flow/tests/auth-v2.spec.ts) is the live check while `authV2` is on. It checks four things: `/family-login/` redirects to `/auth/login` (the static redirect page); the login page offers both Google and email-and-password sign-in; `/auth/.well-known/jwks.json` publishes an RS256 key with no private member; and `/auth/session` reports unauthenticated. The password-path test signs in, then checks that `/auth/session` returns `sub` equal to `HFY_EXPECT_GRAMPS` and that the My Record link matches. It asserts the page structure, not its copy.

About the artifacts:

- [`tests/login-flow/.gitignore`](../../tests/login-flow/.gitignore) ignores `playwright-report/`, `test-results/` and `logs/`, and the root `.gitignore` ignores `*.log`. These artifacts can hold signed-in family data, such as a failure video of a production page, so they are not force-added, attached or shared. See [family data privacy](../explanation/family-data-privacy.md).

## Known limitations

- No workflow runs a test suite other than the ones in the `tests` key (the family-data guard, `scripts/infra/test/run.sh`, the Gramps unit tests, the `scripts/ci/test/` node tests, the client licence gate and the sync error catalog check), `npm run check:islands` or the MCP conformance gate. Nothing in CI checks the committed islands build output against `islands/`, the infra scripts, the edge gate, the CloudFront Function, the client scripts, or the API and auth edge code.
- No workflow deploys `hfy-api`, `hfy-auth-edge`, the app stack, the deploy-role stack, distribution changes or `HFYAppendIndex`. The two `us-east-1` edge stacks, `hfy-edge-gate` and `hfy-mcp-edge401`, the gate's package in `<edge-code-bucket>`, the MCP and data gate behaviors (`/uploads/*` included) are shipped by hand as well, and so is `config/groups.json`. See [what no workflow ships or runs](#what-no-workflow-ships-or-runs).
- `deploy-static` uploads HTML and the files it references in one sync, with no HTML-last order. The default behavior's `CachingOptimized` cache policy leaves the query string out of the cache key, so until the `/*` invalidation completes CloudFront can answer a `?v=<new sha8>` URL with the old file, which Cloudflare then caches under the new URL.
- Rollback starts only after a failed smoke job. A failure in `deploy` or `invalidate` leaves whatever was already synced or updated. Rollback needs an earlier successful run whose artifact is still within the 90-day retention, and it restores `11ty/` only.
- A rollback restores the earlier artifact's `11ty/_data/flags.json` too. If that artifact still has `authV2` off while the data gate is attached, the restored client cannot read gated data. Such a rollback is paired with `add-data-gate-behaviors.sh --remove --app-stack <app-stack>` ([cut over to the private data gate](../how-to/cut-over-to-the-private-data-gate.md)).

- The repository has no root `package.json`. `@io-kit/parity` is a dev dependency of `api/` only, and the `parity-report` action runs at the checkout root, where nothing installs it, so `npx --no-install io-kit-parity` has nothing to run there. That step runs only when `parity.baseline` is set, and none is set.
- The drift check and the secret scan run on pull requests and manual runs of `io-kit-ci.yml` only. A push straight to `main` deploys without them.
- The `@io-kit/mcp` conformance corpus embeds `$fixture:` references inside header values, such as `Bearer $fixture:<path>`, but the packaged `resolveRefs` replaces only a reference that is the whole string. [`api/test/mcp-conformance.test.js`](../../api/test/mcp-conformance.test.js) expands the references in header values itself. A harness that relies on `resolveRefs` alone would send the literal reference.

## Known code issues

- The `target_environment` input description in `io-kit-deploy.yml` names `io-kit-promote.yml` as the approval gate. The repository has no such workflow, so the input is a label only and there is no approval gate.
- The docstring of `sync_sanitized_assets.py` advertises `--check`, which is not defined. That flag exits 2 with an argparse error.
- The login-flow spec hard-codes a real record's ID as the default for `HFY_EXPECT_GRAMPS`. It is shown on this page as `<gramps-id>`. Set the variable explicitly, and do not copy the default into docs, issues or logs.

- `token-smoke.sh` hard-codes `kid` `hfy-session-1`, so its signature check fails after a key rotation to a new `kid` until the script is updated.
- `build-islands.sh` checks only `shell.js` and `shell.css` and reports `built islands -> 11ty/js/islands`, although the build also writes the theme layer, the sign-in stylesheet, the fonts, the pages, the stamped files and `auth/edge.manifest.json`. `npm run check:islands` is the check for all of them.

## Related pages

- [Codebase map](codebase-map.md): where each of these files sits among the rest of the code.
- [Architecture](architecture.md): the components these pipelines deploy.
- [Theme and asset build](theme-and-asset-build.md): everything the islands build writes, including the `?v=<sha8>` versions.
- [MCP server](mcp-server.md): the MCP mount that `add-mcp-behavior.sh` routes to, and the conformance gate's subject.
- [Private data and secrets](private-data-and-secrets.md): secret names, storage and placeholders.
- [The release model](../explanation/release-model.md): why deploys and flag flips are separate, why the deploy role is narrow, and why the edge functions ship by hand.
- [Why React islands on a generated Eleventy site](../explanation/islands-on-eleventy.md): why `11ty/` is output and the islands are built separately.
- [Edge and origin design](../explanation/edge-and-origin-design.md): the distribution these scripts configure, the two Lambda@Edge functions, the default-deny in `HFYAppendIndex`, and Cloudflare's static cache.
- How-to: [deploy a site change](../how-to/deploy-a-site-change.md), [roll back a site deploy](../how-to/roll-back-a-site-deploy.md), [change the CI pipeline](../how-to/change-the-ci-pipeline.md), [build and preview the islands](../how-to/build-and-preview-the-islands.md), [change the theme or brand fonts](../how-to/change-the-theme-or-brand-fonts.md), [deploy the app stack](../how-to/deploy-the-app-stack.md), [deploy the edge functions](../how-to/deploy-the-edge-functions.md), [cut over to the private data gate](../how-to/cut-over-to-the-private-data-gate.md), [publish a change to the HFYAppendIndex CloudFront Function](../how-to/publish-the-cloudfront-function.md), [connect an MCP client](../how-to/connect-an-mcp-client.md), [run the tests](../how-to/run-the-tests.md), [refresh the Eleventy output](../how-to/refresh-the-eleventy-output.md), [stand up the static site](../how-to/stand-up-the-static-site.md).
