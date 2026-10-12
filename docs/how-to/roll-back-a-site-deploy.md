# How to roll back, or drill a rollback of, a site deploy

Use this page when a deploy of the static site has broken production, to put back the previous release and make that stick, or to rehearse the pipeline's automatic rollback before you need it. It covers what [`io-kit-deploy.yml`](../../.github/workflows/io-kit-deploy.yml) deploys: `11ty/` in `<site-bucket>` and the code of the legacy `hfy-check-allowed` Lambda.

Other rollbacks live elsewhere:

- A feature flag: [Toggle a feature flag](toggle-a-feature-flag.md#roll-back).
- `hfy-api`, `hfy-auth-edge` or the app stack: [Deploy the app stack](deploy-the-app-stack.md#roll-back).
- A CloudFront behavior change: the backup the behavior script saved ([Repository operations](../reference/repository-operations.md#pre-change-backup)).

Values in angle brackets, such as `<site>`, `<run-id>` and `<sha>`, are placeholders. The forms are listed in [Private data and secrets](../reference/private-data-and-secrets.md#placeholders).

## What the automatic rollback does

When the `smoke` job of a deploy run fails, the `rollback_on_smoke_fail` job finds the most recent successful run of `io-kit-deploy.yml` on `main`, downloads that run's release artifact `io-kit-release-<sha>`, and deploys it: `11ty/` synced to the bucket with `--delete` and the usual excludes, the `hfy-check-allowed` zip uploaded again, and `/*` invalidated. [Repository operations](../reference/repository-operations.md#composite-actions-githubactionsio-kit-ci) describes the job.

Its limits decide what you do next:

- It runs only after a failed smoke check. A failed `build`, `deploy` or `invalidate` job rolls nothing back.
- It needs an earlier successful run whose artifact still exists. Artifacts are kept for 90 days.
- It restores the previous release's artifact, not a commit. `main` still holds the change, and the next push to `main` deploys it again.
- It does not touch the `getAllowlist` Cloud Function, which [`deploy-gcf-legacy.yml`](../../.github/workflows/deploy-gcf-legacy.yml) deploys with no rollback, nor the app stack, the family data or member uploads.

## Before you start

- `gh`, authenticated with a token that has Actions: write and Contents: write on the repository.
- For a drill: io's go-ahead. A drill redeploys production twice, in quick succession.
- Optional: AWS credentials that can read `hfy-check-allowed`'s configuration, for the Lambda check in [Verify](#verify).

## After an automatic rollback

1. Confirm what happened. In the failed run, `smoke` failed and `rollback_on_smoke_fail` succeeded:

   ```sh
   gh run view <run-id>
   gh run view <run-id> --log | grep -E 'smoke FAIL|rolling back to run'
   ```

   The first matching lines name each URL that failed. The last one reads `rolling back to run <previous-run-id> (<previous-sha>)`, the release that is now live.
2. Check production with [Verify](#verify), using `<previous-sha>`.
3. Make the rollback durable. Until `main` changes, any push deploys the failing change again. Either fix forward with a new pull request through [Deploy a site change](deploy-a-site-change.md), or [revert the change](#roll-back-by-revert).

## If the automatic rollback fails

Production then holds the release that failed its smoke check. Read the `rollback_on_smoke_fail` log:

- `rollback: no previous successful run of io-kit-deploy.yml on main`, or a failed artifact download: there is nothing to restore, as on the first deploy or after the artifact expired. [Revert the change](#roll-back-by-revert).
- An AWS error during the restore: when the cause is fixed, run `gh run rerun <run-id> --failed`. It runs `smoke` again and, if that fails again, the rollback.

## When nothing rolled back

A failed `deploy` or `invalidate` job leaves whatever it had already done: part of the new `11ty/` synced, the Lambda updated or not, cached copies still served. No smoke check runs, so no rollback starts.

- If the cause was outside the change, such as an AWS error, fix it and run `gh run rerun <run-id> --failed`. The rerun deploys the same artifact again.
- If the change itself is at fault, [revert it](#roll-back-by-revert).

For the Cloud Function, a failed `deploy-gcf-legacy.yml` run leaves the previous revision serving. A successful one that deployed a bad change stays until a later push: revert the change to `functions/get-allowlist/` as below, and the push deploys the reverted source.

## Roll back by revert

Revert the merge on a branch and merge the revert. The push to `main` deploys the reverted tree through the normal pipeline, with its own smoke check.

```sh
git fetch origin
git switch -c agent/hfy-tsk-<n>-revert origin/main
git revert -m 1 <merge-sha>        # for a squash merge: git revert <sha>
git push -u origin agent/hfy-tsk-<n>-revert
gh pr create --base main --title "Revert HFY-TSK-<n>: <summary>" --body "<why>"
gh pr merge <pr-number> --merge
```

Then watch and verify the run as in [Deploy a site change](deploy-a-site-change.md#3-watch-the-runs). A revert deploys what Git holds, so it also restores the island bundles as they were committed before the change.

Do not roll back by re-running an older deploy run. A rerun deploys that run's commit, which leaves `main` and production out of step, and the next push deploys the change again.

## Drill the rollback

The `smoke_url` input of `io-kit-deploy.yml` replaces the manifest's smoke URLs for one manual run, so you can make a smoke check fail on purpose without changing the manifest.

1. Find the release the drill will restore:

   ```sh
   gh run list --workflow io-kit-deploy.yml --branch main --status success --limit 1 \
     --json databaseId,headSha,createdAt
   git rev-parse origin/main
   ```

   Go on only if the run is less than 90 days old and its `headSha` equals `origin/main`. The drill then deploys and restores the release that is already live, so production ends where it started. If the latest successful run is for an older commit, the drill would put production back to that older release. Stop and deploy `main` successfully first.
2. Check that no deploy is running. This prints nothing:

   ```sh
   gh run list --workflow io-kit-deploy.yml --status in_progress
   ```

3. Start the drill with a smoke URL that cannot succeed. A path with no page returns `403` from the bucket:

   ```sh
   gh workflow run io-kit-deploy.yml --ref main \
     -f target_environment=rollback-drill \
     -f smoke_url="https://<site>/rollback-drill-no-such-page/"
   gh run list --workflow io-kit-deploy.yml --event workflow_dispatch --limit 1
   gh run watch <run-id>
   ```

4. Expect `smoke` to fail, after its retries, and `rollback_on_smoke_fail` to succeed. The run as a whole is marked failed. That is the result a drill is after.
5. Run [Verify](#verify) with the `headSha` from step 1. Record the drill's run ID and result in the HFY record's worklog.

If `rollback_on_smoke_fail` fails in a drill, production holds the release from step 1 anyway, because the drill deployed the same commit. Read its log as in [If the automatic rollback fails](#if-the-automatic-rollback-fails), fix the cause, and drill again.

## Verify

Use the commit that should now be live as `<sha>`: `<previous-sha>` after an automatic rollback, the `headSha` from step 1 after a drill, or the revert's merge commit after a revert.

1. **The run did what you expect.** `gh run view <run-id> --log | grep -E 'rolling back to run|invalidated'` shows the restore and the invalidation, for an automatic rollback or a drill. For a revert, `gh run view <run-id>` shows `smoke` succeeded and `rollback_on_smoke_fail` skipped.
2. **The pages answer.**

   ```sh
   for p in / /family-login/; do
     curl -s -o /dev/null -w "%{http_code} $p\n" "https://<site>$p"
   done
   ```

   Each line starts with a 2xx or 3xx code.
3. **Production serves that release.** From a checkout that has `<sha>`:

   ```sh
   curl -s "https://<site>/_data/flags.json" | diff - <(git show <sha>:11ty/_data/flags.json) && echo "flags match"
   [ "$(curl -s "https://<site>/js/islands/shell.js" | shasum -a 256)" = "$(git show <sha>:11ty/js/islands/shell.js | shasum -a 256)" ] \
     && echo "shell bundle matches"
   ```

   Both lines print.
4. **The Lambda was redeployed.**

   ```sh
   aws lambda get-function-configuration --function-name hfy-check-allowed --region us-west-2 \
     --query '[LastModified,LastUpdateStatus]' --output text
   ```

   `LastModified` is after the rollback or revert run started, and the status is `Successful`.

## Related pages

- [Repository operations](../reference/repository-operations.md#io-kit-deployyml): the deploy jobs, the rollback action and its limits.
- [The release model](../explanation/release-model.md#why-a-kit-pipeline): why the pipeline rolls back on a failed smoke check.
- [Deploy a site change](deploy-a-site-change.md), [Change the CI pipeline](change-the-ci-pipeline.md), [Toggle a feature flag](toggle-a-feature-flag.md).
