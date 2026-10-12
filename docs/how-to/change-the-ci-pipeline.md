# How to change the CI pipeline

Use this page to change what the kit pipeline builds, deploys, excludes or smoke-checks, or to move it to a newer `@io-kit/ci`. You edit [`ci.manifest.yaml`](../../ci.manifest.yaml), re-render the workflows and composite actions from it, and confirm that the drift check is clean.

The rendered files are [`.github/workflows/io-kit-ci.yml`](../../.github/workflows/io-kit-ci.yml), [`.github/workflows/io-kit-deploy.yml`](../../.github/workflows/io-kit-deploy.yml) and everything under [`.github/actions/io-kit-ci/`](../../.github/actions/io-kit-ci/). Never edit them by hand: the next render overwrites the edit, and the drift check reports it. [`deploy-gcf-legacy.yml`](../../.github/workflows/deploy-gcf-legacy.yml) and the scripts in [`scripts/ci/`](../../scripts/ci/) are hand-maintained, so change them directly. [Repository operations](../reference/repository-operations.md#kit-manifest-cimanifestyaml) lists every manifest field and what each rendered file does, and [the release model](../explanation/release-model.md#why-a-kit-pipeline) explains why the pipeline is rendered rather than written.

Values in angle brackets are placeholders. The forms are listed in [Private data and secrets](../reference/private-data-and-secrets.md#placeholders).

## Before you start

- **Node 22 or later.** `@io-kit/ci` requires it.
- **AWS credentials for CodeArtifact**, which allow `codeartifact:GetAuthorizationToken` on the `io` domain and `sts:GetServiceBearerToken`, and read access to the `io-kit` repository. The package is private.
- **A branch tied to an HFY record**, from an up-to-date `origin/main`, with a clean tree: `git status --short` prints nothing.
- **Know where each value belongs.** Secret values never go in the manifest. A build variable that needs a secret is written `{secret: <NAME>}`, which renders as a reference to the GitHub secret, and the schema rejects a literal secret. The bucket and distribution identifiers already live in the manifest and the deploy role. Do not copy them anywhere else.

## Steps

### 1. Edit the manifest

Change `ci.manifest.yaml`. Common changes:

| Goal | Field |
| --- | --- |
| Run another script in the release build | `build.cmd`. Keep `scripts/ci/patch-client-id.sh` first, so the client ID is patched before anything is packaged. |
| Pass another value to the build | `build.env`, as `{secret: <NAME>}` or `{value: "<text>"}` |
| Keep a new bucket prefix out of the site sync | `deploy.targets[0].exclude`. A prefix that another writer owns, such as data or member uploads, must be excluded here in the same change that creates it, or the next deploy's `--delete` removes it. |
| Check another URL after each deploy | `deploy.smoke` |
| Ship another file in the release artifact | `artifacts` |
| Deploy another Lambda | A new `kind: lambda` entry in `deploy.targets`. Add an `alias` if a rollback should repoint an alias rather than re-upload the previous zip. |

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

It prints nothing and `exit 0`. A `pipeline_drift: <file>` line means a rendered file does not match its header (`hand_edit`), a kit file lost its header (`missing_header`), or another workflow runs an AWS deploy command (`deploy_outside_kit`). Render again for the first two. For the third, move the deploy into the manifest: only the kit's workflows may sync S3, update Lambda code or invalidate CloudFront.

### 5. Review the diff

```sh
git status --short
git diff --stat
```

Only `ci.manifest.yaml` and files under `.github/workflows/io-kit-*` and `.github/actions/io-kit-ci/` change, plus any `scripts/ci/` script you changed on purpose. Each rendered file starts with a header of the form `# @io-kit/ci <version> rendered — do not edit; sha256:<hash>`. Read the rendered diff as well as the manifest diff: it is what will run.

### 6. Give the deploy role what the change needs

The deploy role cannot change its own permissions. If the change deploys to something new, such as another Lambda target, another bucket or another distribution, update [`github-roles.yaml`](../../infrastructure/cloudformation/github-roles.yaml) and deploy that stack by hand with admin credentials before you merge, as in [Stand up the static site](stand-up-the-static-site.md#6-create-the-deploy-role-and-its-secret). A new `{secret: <NAME>}` needs its repository secret first: `gh secret set <NAME> --repo <github-owner>/<github-repo>`. Otherwise the first deploy after the merge fails.

### 7. Open the pull request and merge

Commit and open a pull request as in [Deploy a site change](deploy-a-site-change.md#1-open-a-pull-request). The pull request runs the rendered `io-kit-ci.yml` from your branch. Its `parity` job summary must say `no pipeline_drift`.

A push runs the workflows in the pushed commit, so the merge to `main` already deploys with the new pipeline.

## Verify

1. **The deploy run after the merge is green**, as in [Deploy a site change](deploy-a-site-change.md#verify). Read the log of the step your change affects, for example the `sync ... (excluding: ...)` line of the `deploy` job for a new exclude, or the `ok` lines of the `smoke` job for a new URL.
2. **The drift check stays clean on `main`.** `node .github/actions/io-kit-ci/parity-report/check.cjs` prints nothing from an up-to-date `main` checkout.
3. **If the change touched the deploy, smoke or rollback jobs, drill the rollback** with [Roll back a site deploy](roll-back-a-site-deploy.md#drill-the-rollback), so a broken rollback path shows up before a real failure needs it.

## Related pages

- [Repository operations](../reference/repository-operations.md): the manifest fields, the rendered workflows and actions, the drift check and the deploy role.
- [The release model](../explanation/release-model.md): why one manifest renders the pipeline, and why the rendered YAML is never hand-edited.
- [Deploy a site change](deploy-a-site-change.md), [Roll back a site deploy](roll-back-a-site-deploy.md).
