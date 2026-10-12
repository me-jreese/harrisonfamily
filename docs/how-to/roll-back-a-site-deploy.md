# How to roll back, or drill a rollback of, a site deploy

Use this page when a deploy of the static site has broken production, to put back the previous release and make that stick, or to rehearse the pipeline's automatic rollback before you need it. It covers what [`io-kit-deploy.yml`](../../.github/workflows/io-kit-deploy.yml) deploys: `11ty/` in `<site-bucket>` and the code of the legacy `hfy-check-allowed` Lambda.

Other rollbacks live elsewhere:

- A feature flag: [Toggle a feature flag](toggle-a-feature-flag.md#roll-back).
- `hfy-api`, which also serves `/mcp`, `hfy-auth-edge` or the app stack: [Deploy the app stack](deploy-the-app-stack.md#roll-back).
- The private data gate, to take it off the data paths: `add-data-gate-behaviors.sh --remove`, in [Cut over to authV2 and the private data gate](cut-over-to-the-private-data-gate.md#roll-back). It makes the family data public again.
- A bad version of the gate's code, `hfy-edge-gate`: rerun `add-data-gate-behaviors.sh` with `--version-arn` set to a retained earlier version ([Deploy the edge functions](deploy-the-edge-functions.md#roll-back)).
- A bad version of the MCP behaviors' 401-restore function, `hfy-mcp-edge401`: rerun `add-mcp-behavior.sh --stack <app-stack>` with `--edge401-arn` set to a retained earlier version (same page).
- Any other CloudFront behavior change: the backup the behavior script saved ([Repository operations](../reference/repository-operations.md#pre-change-backup)).

Values in angle brackets, such as `<site>`, `<distribution-id>`, `<run-id>` and `<sha>`, are placeholders. The forms are listed in [Private data and secrets](../reference/private-data-and-secrets.md#placeholders).

## What the automatic rollback does

When the `smoke` job of a deploy run fails, the `rollback_on_smoke_fail` job finds the most recent successful run of `io-kit-deploy.yml` on `main`, downloads that run's release artifact `io-kit-release-<sha>`, and deploys it: `11ty/` synced to the bucket with `--delete` and the usual excludes, the `hfy-check-allowed` zip uploaded again, and `/*` invalidated. [Repository operations](../reference/repository-operations.md#composite-actions-githubactionsio-kit-ci) describes the job.

Its limits decide what you do next:

- It runs only after a failed smoke check. A failed `build`, `deploy` or `invalidate` job rolls nothing back.
- It needs an earlier successful run whose artifact still exists. Artifacts are kept for 90 days.
- It restores the previous release's artifact, not a commit. `main` still holds the change, and the next push to `main` deploys it again.
- It does not touch the `getAllowlist` Cloud Function, which [`deploy-gcf-legacy.yml`](../../.github/workflows/deploy-gcf-legacy.yml) deploys with no rollback, nor the app stack, the family data or member uploads.
- It restores the previous release's `flags.json` with the rest of `11ty/`, but it never changes the distribution's behaviors, so an attached data gate stays attached. Once the gate is attached, a rollback to an artifact with `"authV2": false` shuts every visitor out of the gated data: the legacy client does not sign in with an `io_id` session, so the gate refuses its requests, and person pages, search and photos fail. The artifact is whatever the last successful run deployed, so check rather than assume: [Check authV2 after a failed deploy](#check-authv2-after-a-failed-deploy) removes the gate unless `/_data/flags.json` still shows `authV2` as `true`.

## Before you start

- `gh`, authenticated with a token that has Actions: write and Contents: write on the repository.
- For a drill: io's go-ahead. A drill redeploys production twice, in quick succession.
- `curl` and `jq`, for the `authV2` check.
- For a gate removal: the AWS CLI and operator AWS credentials that can read and update the distribution. The GitHub deploy role can only invalidate the distribution's cache. A real run saves the distribution configuration, which holds the origin-verify value, under `${HFY_CF_BACKUP_DIR:-~/.local/state/hfy-infra/cloudfront}` with mode 600 ([Repository operations](../reference/repository-operations.md#pre-change-backup)), so leave `HFY_CF_BACKUP_DIR` unset or point it at a private directory outside the repository.
- Optional: AWS credentials that can read `hfy-check-allowed`'s configuration, for the Lambda check in [Verify](#verify).

Run the commands on this page from the repository root.

## Check authV2 after a failed deploy

Do this first after any failed run of `io-kit-deploy.yml`, whether or not anything rolled back. A rollback restores the previous release's `flags.json`, and a `deploy` job that failed part-way may or may not have replaced it.

1. Read the published value:

   ```sh
   curl -s https://<site>/_data/flags.json | jq .authV2
   ```

   If it prints `true`, the gate and the client agree. Go on to the section that fits the failure.
2. Otherwise, whatever it prints, remove the gate at once. Do a dry run first:

   ```sh
   scripts/infra/add-data-gate-behaviors.sh --remove --dry-run --distribution <distribution-id>
   scripts/infra/add-data-gate-behaviors.sh --remove --distribution <distribution-id>
   aws cloudfront wait distribution-deployed --id <distribution-id>
   ```

   The dry run's diff removes only the six gated behaviors and lowers `CacheBehaviors.Quantity` by 6. If the gate is not attached, both runs print `distribution <distribution-id> already has no hfy-edge-gate-gated data behaviors (...): no change`, and nothing changes. Do not pass `--stack <app-stack>`: this script's `--stack` names the `us-east-1` gate stack, and `--remove` does not read it. The `wait` command returns with no output once the distribution is deployed; if it times out, run it again.

   The family data is then public again, as it was before the release, and the legacy client can read it. Attach the gate again only after a deploy with `authV2` set to `true` has finished green, as in [step 3 of the cutover](cut-over-to-the-private-data-gate.md#3-attach-the-gate).

## After an automatic rollback

1. Confirm what happened. In the failed run, `smoke` failed and `rollback_on_smoke_fail` succeeded:

   ```sh
   gh run view <run-id>
   gh run view <run-id> --log | grep -E 'smoke FAIL|rolling back to run'
   ```

   The first matching lines name each URL that failed. The last one reads `rolling back to run <previous-run-id> (<previous-sha>)`, the release that is now live.
2. [Check authV2](#check-authv2-after-a-failed-deploy), and remove the gate unless it prints `true`.
3. Check production with [Verify](#verify), using `<previous-sha>`.
4. Make the rollback durable. Until `main` changes, any push deploys the failing change again. Either fix forward with a new pull request through [Deploy a site change](deploy-a-site-change.md), or [revert the change](#roll-back-by-revert).

## If the automatic rollback fails

Production then holds the release that failed its smoke check, or part of the restore. [Check authV2](#check-authv2-after-a-failed-deploy) first. Then read the `rollback_on_smoke_fail` log:

- `rollback: no previous successful run of io-kit-deploy.yml on main`, or a failed artifact download: there is nothing to restore, as on the first deploy or after the artifact expired. [Revert the change](#roll-back-by-revert).
- An AWS error during the restore: when the cause is fixed, run `gh run rerun <run-id> --failed`. It runs `smoke` again and, if that fails again, the rollback.

## When nothing rolled back

A failed `deploy` or `invalidate` job leaves whatever it had already done: part of the new `11ty/` synced, the Lambda updated or not, cached copies still served. No smoke check runs, so no rollback starts. [Check authV2](#check-authv2-after-a-failed-deploy) first, then:

- If the cause was outside the change, such as an AWS error, fix it and run `gh run rerun <run-id> --failed`. The rerun deploys the same artifact again.
- If the change itself is at fault, [revert it](#roll-back-by-revert).

For the Cloud Function, a failed `deploy-gcf-legacy.yml` run leaves the previous revision serving. A successful one that deployed a bad change stays until a later push: revert the change to `functions/get-allowlist/` as below, and the push deploys the reverted source.

## Roll back by revert

Revert the merge on a branch and merge the revert. The push to `main` deploys the reverted tree through the normal pipeline, with its own smoke check.

If the change you revert set `authV2` to `true` and the gate is attached, the revert turns `authV2` off under the gate. Remove the gate first, with the commands in [Check authV2 after a failed deploy](#check-authv2-after-a-failed-deploy), and wait for the distribution before you merge the revert. [Cut over to authV2 and the private data gate](cut-over-to-the-private-data-gate.md#roll-back) gives the order.

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

   Go on only if the run is less than 90 days old and its `headSha` equals `origin/main`. The drill then deploys and restores the release that is already live, so production ends where it started, `authV2` included, which keeps a drill safe while the gate is attached. If the latest successful run is for an older commit, the drill would put production back to that older release. Stop and deploy `main` successfully first.
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
4. **`authV2` and the gate agree.**

   ```sh
   curl -s https://<site>/_data/flags.json | jq .authV2
   curl -s -o /dev/null -w '%{http_code}\n' https://<site>/person/index.json
   ```

   The second command prints `401` while the gate is attached and `200` while the data is public. With `401`, the first must print `true`. If it does not, remove the gate as in [Check authV2 after a failed deploy](#check-authv2-after-a-failed-deploy).
5. **The Lambda was redeployed.**

   ```sh
   aws lambda get-function-configuration --function-name hfy-check-allowed --region us-west-2 \
     --query '[LastModified,LastUpdateStatus]' --output text
   ```

   `LastModified` is after the rollback or revert run started, and the status is `Successful`.

## Related pages

- [Repository operations](../reference/repository-operations.md#io-kit-deployyml): the deploy jobs, the rollback action and its limits.
- [The release model](../explanation/release-model.md#why-a-kit-pipeline): why the pipeline rolls back on a failed smoke check, and [why the gate and `authV2` move in a fixed order](../explanation/release-model.md#the-gate-is-a-third-switch-and-the-order-matters).
- [Cut over to authV2 and the private data gate](cut-over-to-the-private-data-gate.md): attaching the gate, and removing it again.
- [Deploy the edge functions](deploy-the-edge-functions.md): rolling the gate or the MCP 401-restore function back to an earlier version.
- [Deploy a site change](deploy-a-site-change.md), [Change the CI pipeline](change-the-ci-pipeline.md), [Toggle a feature flag](toggle-a-feature-flag.md).
