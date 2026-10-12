# How to deploy a change to the static site

Use this page to ship a change to `11ty/` (the pages, the committed island bundles and [`flags.json`](../../11ty/_data/flags.json)), to the legacy `hfy-check-allowed` Lambda or to the legacy `getAllowlist` Cloud Function, and to confirm that it is live.

Changes to `api/` or `auth/` do not ship this way: use [Deploy the app stack](deploy-the-app-stack.md). To change the pipeline itself, use [Change the CI pipeline](change-the-ci-pipeline.md). For why a deploy and a feature flag are separate switches, see [the release model](../explanation/release-model.md).

Values in angle brackets, such as `<site>`, `<pr-number>` and `<run-id>`, are placeholders. The forms are listed in [Private data and secrets](../reference/private-data-and-secrets.md#placeholders).

## What ships

A push to `main` starts two independent workflow runs, whatever the change touched:

- **[`io-kit-deploy.yml`](../../.github/workflows/io-kit-deploy.yml)**, the kit pipeline. It builds a release from the commit, syncs `11ty/` to `<site-bucket>` with `--delete`, updates the code of `hfy-check-allowed`, invalidates `/*` on CloudFront and waits for the invalidation, then requests `https://<site>/` and `https://<site>/family-login/`. If either smoke request fails, it redeploys the release of the previous successful run.
- **[`deploy-gcf-legacy.yml`](../../.github/workflows/deploy-gcf-legacy.yml)**, which deploys `getAllowlist`. Nothing rolls it back.

The sync never writes or deletes the family data prefixes or member uploads: it excludes `person/*.json`, `media/*`, `family/*`, `event/*`, `note/*`, `place/*` and `uploads/*`. The island bundles ship exactly as committed in `11ty/js/islands/`, because no workflow builds them. `hfy-api`, `hfy-auth-edge`, the app stack and CloudFront configuration changes do not ship. [Repository operations](../reference/repository-operations.md#workflows) lists every job and step.

## Before you start

- The repository secrets `AWS_DEPLOY_ROLE_TO_ASSUME`, `HFY_GOOGLE_CLIENT_ID` and `GCP_SERVICE_ACCOUNT_KEY` exist. `gh secret list` shows their names. If one is missing, follow [Stand up the static site](stand-up-the-static-site.md).
- The change is on a branch tied to an HFY record, for example `agent/hfy-tsk-<n>-<slug>`, and the record ID leads each commit message (`HFY-TSK-<n>: <summary>`). Agents also follow the lifecycle in [`AGENTS.md`](../../AGENTS.md), including the `CCI-...` value that the PR Commit Gate requires in the pull request body.
- Any `11ty/` change taken from the Eleventy source followed [Refresh the Eleventy output](refresh-the-eleventy-output.md). `11ty/` is build output, and its source lives outside the repository.
- If the change touches `islands/`, the bundles were rebuilt and committed with it ([Build and preview the islands](build-and-preview-the-islands.md)), and this prints `11ty/js/islands is up to date (<n> files)`:

  ```sh
  (cd islands && npm run check:islands)
  ```

- `REPLACE_WITH_GOOGLE_CLIENT_ID` is left as is in the committed files. The pipeline substitutes the real client ID on the runner, so the repository never carries it. `grep -rl REPLACE_WITH_GOOGLE_CLIENT_ID 11ty | wc -l` prints `11`: the ten rendered pages and `js/auth.js`.
- The suites that cover your change pass locally ([Run the tests](run-the-tests.md)). No workflow runs them.
- If the change sets a flag to `true` in `flags.json`, read [Toggle a feature flag](toggle-a-feature-flag.md) first.

## Steps

### 1. Open a pull request

```sh
git push -u origin agent/hfy-tsk-<n>-<slug>
gh pr create --base main --title "HFY-TSK-<n>: <summary>" --body "<what changed and how it was tested>"
gh pr checks <pr-number> --watch
```

The pull request runs [`io-kit-ci.yml`](../../.github/workflows/io-kit-ci.yml): the release build (client ID patch and Lambda package), the pipeline drift report and a TruffleHog scan of the commit range. All three must pass. The drift report runs in report mode, so it passes even when it finds drift. Open the `parity` job's summary and confirm that it says `no pipeline_drift`. Drift means a rendered workflow file was edited by hand; see [Change the CI pipeline](change-the-ci-pipeline.md).

No check runs a test suite. The other gates are local:

- The pre-commit hook, [`scripts/git-hooks/pre-commit`](../../scripts/git-hooks/pre-commit), runs the deployment sync check and a `trufflehog` scan. It is active only after `git config core.hooksPath scripts/git-hooks`.
- The suites and `check:islands` from [Before you start](#before-you-start).

Read the diff yourself as well. It must contain nothing from the family data paths listed under [What ships](#what-ships), no real client ID and no other secret.

### 2. Merge to main

Branch protection is strict, so bring the branch up to date with `origin/main` first, then merge:

```sh
gh pr merge <pr-number> --merge
```

The merge starts both workflows. Only `main` can deploy: the deploy role trusts `ref:refs/heads/main` only ([`github-roles.yaml`](../../infrastructure/cloudformation/github-roles.yaml)).

`io-kit-deploy.yml` runs one deploy at a time. A run that starts while another is in progress waits for it, and GitHub keeps only the newest waiting run, so if you merge several changes in quick succession, a waiting run can be cancelled in favor of a later one. The run that does go ahead deploys the newest `main`, which includes the cancelled run's commit.

### 3. Watch the runs

```sh
SHA="$(gh pr view <pr-number> --json mergeCommit --jq .mergeCommit.oid)"
gh run list --workflow io-kit-deploy.yml --branch main --commit "$SHA" --limit 1
gh run list --workflow deploy-gcf-legacy.yml --branch main --commit "$SHA" --limit 1
gh run watch <run-id> --exit-status
```

If a `run list` prints nothing, the run has not started yet. Run it again after a few seconds. Watch the `io-kit-deploy.yml` run first. Its jobs run in this order: `build`, `deploy`, `invalidate`, `smoke`, and `rollback_on_smoke_fail` only if `smoke` failed. What is live after a failure depends on the job:

| Failed job | What is live | What to do |
| --- | --- | --- |
| `build` | Nothing changed. | Read the log. An unset or empty `HFY_GOOGLE_CLIENT_ID` stops the client ID patch. A value containing `/` or a line break breaks its `sed`. Fix, then `gh run rerun <run-id>`. |
| `deploy`, at the AWS credentials step | Nothing changed. | Check `AWS_DEPLOY_ROLE_TO_ASSUME`, and that the run is on `main`. |
| `deploy`, at the sync | Possibly part of the new `11ty/`. Nothing rolls back. | Fix the cause and `gh run rerun <run-id> --failed`, or [roll back](roll-back-a-site-deploy.md#when-nothing-rolled-back). |
| `deploy`, at the Lambda update | The new static site with the old `hfy-check-allowed`. | As above. |
| `invalidate` | The new files and Lambda, but CloudFront can serve cached copies. No smoke check runs. | `gh run rerun <run-id> --failed`. |
| `smoke` | `rollback_on_smoke_fail` redeployed the previous release. `main` still holds your change. | Follow [Roll back a site deploy](roll-back-a-site-deploy.md#after-an-automatic-rollback). |
| `rollback_on_smoke_fail` | The new release, which failed its smoke check. | Follow [Roll back a site deploy](roll-back-a-site-deploy.md#if-the-automatic-rollback-fails). |

Then watch the `deploy-gcf-legacy.yml` run. If it fails, the previous revision of `getAllowlist` keeps serving. Fix the cause and rerun it. Nothing in any sign-in path calls the function.

## Verify

1. **The deploy run is green.** `gh run view <run-id>` shows `build`, `deploy`, `invalidate` and `smoke` succeeded and `rollback_on_smoke_fail` skipped. The `smoke` log has an `ok` line for each URL. The `invalidate` job waits for the invalidation to finish, so the checks below see the new files at once.
2. **The pages answer.**

   ```sh
   for p in / /family-login/; do
     curl -s -o /dev/null -w "%{http_code} $p\n" "https://<site>$p"
   done
   ```

   Each line starts with a 2xx or 3xx code.
3. **The published flags match the committed file.** From the root of an up-to-date `main` checkout:

   ```sh
   curl -s "https://<site>/_data/flags.json" | diff - 11ty/_data/flags.json && echo "flags match"
   ```

4. **The island bundles are the committed ones.**

   ```sh
   for f in shell.js search.js notify-sw.js; do
     [ "$(curl -s "https://<site>/js/islands/$f" | shasum -a 256)" = "$(shasum -a 256 < "11ty/js/islands/$f")" ] \
       && echo "same: $f" || echo "DIFFERENT: $f"
   done
   ```

   Each line says `same`. The bundles carry no client ID placeholder, so the deploy does not change them.
5. **The client ID placeholder was replaced.**

   ```sh
   curl -s "https://<site>/family-login/" | grep -o '"clientId":"[^"]*"'
   curl -s "https://<site>/js/auth.js" | grep -c REPLACE_WITH_GOOGLE_CLIENT_ID
   ```

   The first command prints a `clientId` that is neither empty nor the placeholder. The second prints `0`.
6. **Legacy sign-in still works.** Open `https://<site>/family-login/` in a private window, so that no preview override applies, and sign in with an allowlisted Google account. The navigation switches to the signed-in state: **LOG OUT**, plus **MY RECORD** for an account mapped to a record. If it does not, see [Diagnose sign-in and API failures](diagnose-sign-in-and-api-failures.md).

If you changed the Lambda or the Cloud Function, confirm the update with operator credentials:

```sh
aws lambda get-function-configuration --function-name hfy-check-allowed --region us-west-2 \
  --query '[LastModified,LastUpdateStatus]' --output text
gcloud functions describe getAllowlist --project <gcp-project> --region us-west2 --gen2 \
  --format 'value(state,updateTime)'
```

The Lambda shows a `LastModified` time after the run started and `Successful`. The function shows `ACTIVE` and an `updateTime` after the run started.

## If the change has to come out

Follow [Roll back a site deploy](roll-back-a-site-deploy.md). It covers the automatic rollback, a durable rollback by revert, and the cases nothing rolls back.

## Related pages

- [Release model](../explanation/release-model.md): why deploys and flags are separate, and why the pipeline is shaped as it is.
- [Repository operations](../reference/repository-operations.md): the workflows, the kit manifest, the deploy role and the pre-commit hook.
- [Roll back a site deploy](roll-back-a-site-deploy.md), [Change the CI pipeline](change-the-ci-pipeline.md), [Toggle a feature flag](toggle-a-feature-flag.md), [Run the tests](run-the-tests.md), [Deploy the app stack](deploy-the-app-stack.md).
