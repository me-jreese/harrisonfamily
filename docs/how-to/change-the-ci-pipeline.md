# How to change the CI pipeline

Use this page to change what the kit pipeline builds, deploys, excludes or smoke-checks, or to move it to a newer `@io-kit/ci`. You edit [`ci.manifest.yaml`](../../ci.manifest.yaml), re-render the workflows and composite actions from it, and confirm that the drift check is clean. Some changes cannot be made through the manifest today: deploying a Lambda@Edge function or a CloudFormation stack, publishing the CloudFront Function `HFYAppendIndex`, and running anything that needs the private package registry, such as the islands build, `check:islands` or the MCP conformance gate. [What the manifest cannot add](#what-the-manifest-cannot-add) says where each one goes instead.

The rendered files are [`.github/workflows/io-kit-ci.yml`](../../.github/workflows/io-kit-ci.yml), [`.github/workflows/io-kit-deploy.yml`](../../.github/workflows/io-kit-deploy.yml) and everything under [`.github/actions/io-kit-ci/`](../../.github/actions/io-kit-ci/). Never edit them by hand: the next render overwrites the edit, and the drift check reports it. [`deploy-gcf-legacy.yml`](../../.github/workflows/deploy-gcf-legacy.yml) and the scripts in [`scripts/ci/`](../../scripts/ci/) are hand-maintained, so change them directly. [Repository operations](../reference/repository-operations.md#kit-manifest-cimanifestyaml) lists every manifest field and what each rendered file does, and [the release model](../explanation/release-model.md#why-a-kit-pipeline) explains why the pipeline is rendered rather than written.

Values in angle brackets are placeholders. The forms are listed in [Private data and secrets](../reference/private-data-and-secrets.md#placeholders).

## What the manifest cannot add

The manifest can turn on only what `@io-kit/ci` 0.1.3 renders, and the rendered pipeline can do only what the deploy role allows. Three kinds of change are out of reach today. Do not work around any of them by editing the rendered files.

### Edge and CloudFormation deploys

The rendered actions under [`.github/actions/io-kit-ci/`](../../.github/actions/io-kit-ci/) build, package, sync static files, update Lambda code, invalidate, smoke-test, roll back, scan for secrets and report drift. None of them deploys a CloudFormation stack or a Lambda@Edge function, and the kit has no target that would add one:

- In `@io-kit/ci` 0.1.3, `deploy.targets` accepts four kinds: `s3_static`, `lambda`, `cloudfront_function` and `codeartifact`.
- A `lambda` target names its function by bare name, in the manifest's single `deploy.region`, which is `us-west-2`. It cannot reach a function in `us-east-1`, the only Region where Lambda@Edge functions are created. With an `alias` it publishes a version, but no kit step points a CloudFront behavior at a version.
- A `cloudfront_function` target publishes a CloudFront Function, not a Lambda@Edge function. The site's one CloudFront Function does not ship that way either ([The CloudFront Function](#the-cloudfront-function)).
- `stack` changes nothing that is rendered. The kit validates the field but never reads it, so `stack: edge` or `stack: mcp` adds no job and no target.

The deploy role in [`github-roles.yaml`](../../infrastructure/cloudformation/github-roles.yaml) blocks the same changes from the other side. It has no CloudFormation permission, its Lambda grants name only `hfy-check-allowed`, `hfy-api` and `hfy-auth-edge` in `us-west-2`, and it cannot change the distribution's configuration. A hand-maintained workflow that assumed this role would hit the same limits. Widening the role is the trade-off that [why the deploy role is narrow](../explanation/release-model.md#why-the-deploy-role-is-narrow) argues against, and [why the edge functions ship by hand](../explanation/release-model.md#why-the-edge-functions-ship-by-hand) gives the rest of the reasoning.

### The CloudFront Function

`HFYAppendIndex`, built from [`scripts/cloudfront/append-index.js`](../../scripts/cloudfront/append-index.js), is the viewer-request function of the distribution's default behavior. It rewrites clean URLs, and it answers `404` with `cache-control: private, no-store` to case and suffix variants of the private data prefixes, which the case-sensitive gated patterns miss ([Why the CloudFront Function also denies](../explanation/edge-and-origin-design.md#why-the-cloudfront-function-also-denies)). `@io-kit/ci` 0.1.3 has a `cloudfront_function` target kind, but the manifest declares no such target, and adding one is not how this function ships:

- **The role cannot run it.** The `deploy-edge` action that the kind renders calls `aws cloudfront describe-function`, `update-function` and `publish-function`. The deploy role's only CloudFront grants are `CreateInvalidation` and `GetInvalidation`.
- **The action skips the checks that keep the function safe.** It updates the `DEVELOPMENT` stage and publishes it to `LIVE` on every deploy run, and again in the rollback job, with no `test-function` run and no check of which behaviors the function is attached to. The function may sit only on the default behavior. On any other behavior it would answer `404` to the gated data itself.
- **A publish changes what every visitor gets.** A real run needs io's go-ahead ([`AGENTS.md`](../../AGENTS.md)), not only a merge to `main`.

Publish a code change with [`scripts/infra/publish-append-index.sh`](../../scripts/infra/publish-append-index.sh) and operator credentials that allow `cloudfront:DescribeFunction`, `GetFunction`, `UpdateFunction`, `TestFunction`, `PublishFunction` and `GetDistributionConfig`. The script runs the local unit tests, refuses an association with any behavior but the default one, runs test cases through `test-function` on the `DEVELOPMENT` stage before it publishes, and saves the previous `LIVE` code first. [Publish a change to the CloudFront Function](publish-the-cloudfront-function.md) has the steps. The script never creates the function: creating it the first time is manual, in [step 4 of Stand up the static site](stand-up-the-static-site.md#4-create-and-attach-hfyappendindex).

No workflow runs the function's tests, `node --test scripts/cloudfront/test/*.test.mjs`. [`scripts/infra/test/run.sh`](../../scripts/infra/test/run.sh) runs them, and so does the publish script before it touches AWS.

### Work that needs the private registry

No workflow can install the `@io-kit/*` packages, because none has a `CODEARTIFACT_AUTH_TOKEN`. `io-kit-ci.yml` runs with `contents: read` and no AWS credentials, the deploy role has no CodeArtifact permission, and a token stored as a repository secret would expire within 12 hours. Three kinds of work need those packages, so they stay out of the pipeline:

- **The islands build.** [`islands/build.mjs`](../../islands/build.mjs) writes much more than the bundles in `11ty/js/islands/`. It also writes `css/hfy-theme.css`, `css/auth-edge.css` and `fonts/`, the head blocks and family-voice copy in the generated pages, the colours in `manifest.webmanifest`, the stamped `sw.js` and `js/feature-flags.js`, every `?v=<sha8>` asset reference, and `theme.cssUrl` in [`auth/edge.manifest.json`](../../auth/edge.manifest.json). All of it is committed, and the pipeline ships the committed `11ty/` exactly as it is. `npm run check:islands` reports a stale output, but no workflow runs it. [Why island bundles are committed output](../explanation/release-model.md#why-island-bundles-are-committed-output) explains the choice.
- **The app Lambda zips.** [`package-api.sh`](../../scripts/ci/package-api.sh) and [`package-auth.sh`](../../scripts/ci/package-auth.sh) run a locked `npm ci` against the registry. The deploy role already names `hfy-api` and `hfy-auth-edge`, but neither can be a kit target until its zip can be built without the registry.
- **The MCP conformance gate.** [`scripts/ci/mcp-conformance.sh`](../../scripts/ci/mcp-conformance.sh) runs the `@io-kit/*` packages and stops at its token check when the variable is unset.

Neither manifest field that adds CI work changes that:

- **`tests`** renders a `test` job that runs each command after `build`. Its step receives neither `build.env` nor AWS credentials, so the conformance script stops at its token check, and `npm ci` in `islands/` cannot authenticate to the registry. The job also runs on the manifest's Node version, `20`, and `api/` and `islands/` require Node 22.
- **`workflows.ci_jobs_file`** names a repo-relative YAML file holding a map of jobs. In `@io-kit/ci` 0.1.3 those jobs replace every generated job in `io-kit-ci.yml` rather than being added to them, and the triggers become `pull_request` and a push to `main`, without `workflow_dispatch`. The kit then stops rendering the `parity-report` and `secret-scan` actions, so the render removes them, together with the vendored `check.cjs` that [step 4](#4-check-for-drift) runs. Adding one job this way means writing the build and secret-scan jobs by hand and losing the vendored drift check, and the new job still has no token.

Run the checks by hand instead, from the repository root, with Node 22 and the token from [step 2](#2-get-a-codeartifact-token) set:

```sh
scripts/ci/mcp-conformance.sh blocking
(cd islands && npm ci && npm run check:islands)
```

The conformance script ends with a non-zero exit at its first failing step. [MCP server](../reference/mcp-server.md#conformance-gate) lists what it runs. `check:islands` prints `<repo>/11ty is up to date (<n> generated files)` and exits `0`. Otherwise it lists each `missing`, `stale` or `extra` file and exits `1`: rebuild and commit the outputs as in [Build and preview the islands](build-and-preview-the-islands.md#3-check-the-output-against-the-source).

### What ships by hand

These ship outside the pipeline, with operator credentials. [What no workflow ships or runs](../reference/repository-operations.md#what-no-workflow-ships-or-runs) lists them all, and [`AGENTS.md`](../../AGENTS.md) lists which of them need io's go-ahead or G-prod approval.

- **The `us-east-1` stacks** `hfy-edge-gate` and `hfy-mcp-edge401`, and the gate's package in `<edge-code-bucket>`: [Deploy the edge functions](deploy-the-edge-functions.md).
- **Distribution changes**, through the scripts in [`scripts/infra/`](../../scripts/infra/):
  - The MCP behaviors: [step 8 of Deploy the app stack](deploy-the-app-stack.md#8-route-mcp-and-the-protected-resource-metadata).
  - The gate's behaviors, through [`add-data-gate-behaviors.sh`](../../scripts/infra/add-data-gate-behaviors.sh). It attaches the gate to the six data patterns, gates `/uploads/*` in place with the `hfy-uploads-private` response headers policy, and moves every gated behavior to a new gate version: [Cut over to the private data gate](cut-over-to-the-private-data-gate.md) and [Ship a change to the gate](deploy-the-edge-functions.md#ship-a-change-to-the-gate).
- **`HFYAppendIndex`**, through `publish-append-index.sh` ([The CloudFront Function](#the-cloudfront-function)).
- **`<app-stack>`, including the `hfy-api` and `hfy-auth-edge` code**: [Deploy the app stack](deploy-the-app-stack.md). Some changes that look like site changes need this too:
  - `hfy-auth-edge` is redeployed after a change to the sign-in copy in `auth/edge.manifest.json`, to the HFY overrides in [`auth/src/edge.js`](../../auth/src/edge.js), or to the `theme.cssUrl` stamp that the islands build writes when the sign-in stylesheet changes. Redeploy it only after the site deploy that ships the new stylesheet is green ([Deploy a site change](deploy-a-site-change.md#verify)).
  - `hfy-api` is redeployed after a change to the push notification copy, `TEMPLATE_REGISTRY` in [`api/src/notify.js`](../../api/src/notify.js).
- **The deploy-role stack**: [step 6](#6-give-the-deploy-role-what-the-change-needs) below.

## Before you start

- **Node 22 or later.** `@io-kit/ci` requires it.
- **AWS credentials for CodeArtifact**, which allow `codeartifact:GetAuthorizationToken` on the `io` domain and `sts:GetServiceBearerToken`, and read access to the `io-kit` repository. The package is private.
- **A branch tied to an HFY record**, from an up-to-date `origin/main`, with a clean tree: `git status --short` prints nothing.
- **Know where each value belongs.** Secret values never go in the manifest. A build variable that needs a secret is written `{secret: <NAME>}`, which renders as a reference to the GitHub secret, and the schema rejects a literal secret. The bucket name and the distribution ID already live in the manifest and the deploy role, and the distribution ID also in the files that the no-PII rule in [`AGENTS.md`](../../AGENTS.md) lists, such as the `scripts/infra/` defaults and the header comment of `append-index.js`. Do not copy either anywhere else. In docs, write `<site-bucket>` and `<distribution-id>`.

## Steps

### 1. Edit the manifest

Change `ci.manifest.yaml`. Common changes:

| Goal | Field |
| --- | --- |
| Run another script in the release build | `build.cmd`. Keep `scripts/ci/patch-client-id.sh` first, so the client ID is patched before anything is packaged. The build runs without registry access, so it cannot run the islands build ([Work that needs the private registry](#work-that-needs-the-private-registry)). |
| Pass another value to the build | `build.env`, as `{secret: <NAME>}` or `{value: "<text>"}` |
| Keep a new bucket prefix out of the site sync | `deploy.targets[0].exclude`, which today lists the six family data prefixes, `uploads/*` and `README.md` (the repository note is not served). A prefix that another writer owns, such as data or member uploads, must be excluded here in the same change that creates it, or the next deploy's `--delete` removes it. If the prefix holds private data, an exclude is not enough. It also needs a gated pattern in [`add-data-gate-behaviors.sh`](../../scripts/infra/add-data-gate-behaviors.sh) and the same first path segment in `DENY_FIRST_SEGMENTS` in [`append-index.js`](../../scripts/cloudfront/append-index.js). A test fails while those two disagree, and both ship by hand ([What ships by hand](#what-ships-by-hand)). |
| Check another URL after each deploy | `deploy.smoke`. The `smoke` job requests each URL with `curl`, with no cookies and without following redirects, and fails on any status outside `2xx` and `3xx`. A failure redeploys the previous release, so pick a public HTML page. A gated data path answers such a request with `401`, and a case or suffix variant of one answers `404` from `HFYAppendIndex`, so either fails every run. A script or stylesheet URL proves little: the job reads only the status, and Cloudflare can answer a static file from its own copy, up to 4 h old. |
| Change what is invalidated after the sync | `deploy.targets[0].invalidate`, today `["/*"]`. The `invalidate` job waits for the invalidation to finish before `smoke` runs, but it reaches only CloudFront. Cloudflare keeps scripts, stylesheets, fonts and `sw.js` for 4 h whatever is invalidated, and no manifest field changes that. Visitors get new files because the islands build names them by content, `?v=<sha8>`, in the committed HTML ([Edge and origin design](../explanation/edge-and-origin-design.md#static-files-and-versioned-urls-hfy-tsk-086)). A Cloudflare purge needs io's go-ahead. |
| Ship another file in the release artifact | `artifacts` |
| Deploy another Lambda | A new `kind: lambda` entry in `deploy.targets`, for a function in `us-west-2` whose zip `build.cmd` can produce without the private registry. List the zip in `artifacts` too: the `deploy` job does not build, it deploys from the release artifact. Add an `alias` if a rollback should repoint an alias rather than re-upload the previous zip. The app Lambdas and the Lambda@Edge functions cannot be added this way ([What the manifest cannot add](#what-the-manifest-cannot-add)). |
| Publish `HFYAppendIndex` | Not a manifest change. See [The CloudFront Function](#the-cloudfront-function). |

### 2. Get a CodeArtifact token

```sh
export CODEARTIFACT_AUTH_TOKEN="$(aws codeartifact get-authorization-token --domain io \
  --region us-west-2 --query authorizationToken --output text)"
test -n "$CODEARTIFACT_AUTH_TOKEN" && echo "token set"
```

Do not echo the token or write it to a file. It expires after 12 hours by default.

### 3. Render

The repository has no root `package.json`, so run the CLI with `npx`, taking the `@io-kit` registry settings from `api/.npmrc`. From the repository root:

```sh
npx --yes --userconfig api/.npmrc --package @io-kit/ci@0.1.3 -- \
  io-kit-ci render --manifest ci.manifest.yaml --out .
```

The command prints a `rendered <file>` line for each file it writes and a `removed <file>` line for each rendered file the manifest no longer needs. It exits `2` and prints the schema error if the manifest is invalid. Fix the manifest and render again.

To move to a newer kit, use that version in `--package` instead. Every rendered file's header then names the new version.

### 4. Check for drift

Run the same drift check that the `parity` job runs, from its vendored copy. It needs no registry access:

```sh
node .github/actions/io-kit-ci/parity-report/check.cjs; echo "exit $?"
```

It prints nothing and `exit 0`. A `pipeline_drift: <file>` line means a rendered file does not match its header (`hand_edit`), a kit file lost its header (`missing_header`), or another workflow or action runs an AWS deploy command (`deploy_outside_kit`): an S3 sync, a Lambda code, configuration, version or alias update, or a CloudFront invalidation or function update or publish. Render again for the first two. For the third, move the deploy into the manifest if a target kind covers it, so that only the kit's workflows deploy. If none does, the deploy ships by hand ([What the manifest cannot add](#what-the-manifest-cannot-add)).

The check reads only the YAML under `.github/workflows/` and `.github/actions/`. A deploy command inside a script that a workflow calls, such as `publish-append-index.sh` or an `add-*` script, is not reported. Do not call such a script from a workflow: the deploy role could not run it, and the script's real runs need io's go-ahead.

### 5. Review the diff

```sh
git status --short
git diff --stat
```

Only `ci.manifest.yaml` and files under `.github/workflows/io-kit-*` and `.github/actions/io-kit-ci/` change, plus any `scripts/ci/` script you changed on purpose. Each rendered file starts with a header of the form `# @io-kit/ci <version> rendered — do not edit; sha256:<hash>`. Read the rendered diff as well as the manifest diff: it is what will run.

### 6. Give the deploy role what the change needs

The deploy role cannot change its own permissions. If the change deploys to something new, such as another Lambda target, another bucket or another distribution, update [`github-roles.yaml`](../../infrastructure/cloudformation/github-roles.yaml) and deploy that stack by hand with admin credentials before you merge, as in [Stand up the static site](stand-up-the-static-site.md#6-create-the-deploy-role-and-its-secret). Grant only the actions that the kit's steps call for that target, and name its resource, as the existing statements do. Keep the `ProtectMemberUploads` deny: it stops the role from writing or deleting anything under `uploads/`, even if the sync exclude is lost. A new `{secret: <NAME>}` needs its repository secret first: `gh secret set <NAME> --repo <github-owner>/<github-repo>`. Otherwise the first deploy after the merge fails.

### 7. Open the pull request and merge

Commit and open a pull request as in [Deploy a site change](deploy-a-site-change.md#1-open-a-pull-request). The pull request runs the rendered `io-kit-ci.yml` from your branch. Its `parity` job summary must say `no pipeline_drift`.

A push runs the workflows in the pushed commit, so the merge to `main` already deploys with the new pipeline.

## Verify

1. **The deploy run after the merge is green**, as in [Deploy a site change](deploy-a-site-change.md#verify). Read the log of the step your change affects, for example the `sync ... (excluding: ...)` line of the `deploy` job for a new exclude, or the `ok` lines of the `smoke` job for a new URL.
2. **The drift check stays clean on `main`.** `node .github/actions/io-kit-ci/parity-report/check.cjs` prints nothing from an up-to-date `main` checkout.
3. **If the change touched the deploy, smoke or rollback jobs, drill the rollback** with [Roll back a site deploy](roll-back-a-site-deploy.md#drill-the-rollback), so a broken rollback path shows up before a real failure needs it. The rollback restores the whole previous release, `flags.json` included, so follow that page's checks before the drill.

## Related pages

- [Repository operations](../reference/repository-operations.md): the manifest fields, the rendered workflows and actions, the drift check, the deploy role, and what no workflow ships or runs.
- [The release model](../explanation/release-model.md): why one manifest renders the pipeline, why the rendered YAML is never hand-edited, why build output is committed, and why the deploy role is narrow and the edge functions ship by hand.
- [Deploy a site change](deploy-a-site-change.md), [Roll back a site deploy](roll-back-a-site-deploy.md).
- [Deploy the edge functions](deploy-the-edge-functions.md), [Deploy the app stack](deploy-the-app-stack.md), [Cut over to the private data gate](cut-over-to-the-private-data-gate.md), [Publish a change to the CloudFront Function](publish-the-cloudfront-function.md): what ships outside the pipeline.
- [Build and preview the islands](build-and-preview-the-islands.md): the build that CI cannot run.
- [Edge and origin design](../explanation/edge-and-origin-design.md): why the CloudFront Function denies, and how Cloudflare's cache shapes a deploy.
- [MCP server](../reference/mcp-server.md#conformance-gate): the conformance gate that runs by hand.
