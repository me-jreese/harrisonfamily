# How to roll back, or drill a rollback of, a site deploy

Use this page when a deploy of the static site has broken production, to put back the previous release and make that stick, or to rehearse the pipeline's automatic rollback before you need it. It covers what [`io-kit-deploy.yml`](../../.github/workflows/io-kit-deploy.yml) deploys: `11ty/` in `<site-bucket>`. The pipeline deploys no Lambda since HFY-TSK-317.

The production cutover ran on 2026-10-12 (HFY-TSK-069, HFY-R67): the site deploy that turned `authV2` on went first, and the private data gate was attached after it. The pipeline cannot remove the gate, so every site rollback on this page happens with the gate in place unless someone removed it by hand. While it is attached, anything that publishes a `flags.json` without `"authV2": true` locks every visitor out of person, search and photo data. [Check authV2 after a failed deploy](#check-authv2-after-a-failed-deploy) shows where production stands.

Other rollbacks live elsewhere:

- A feature flag: [Toggle a feature flag](toggle-a-feature-flag.md#roll-back).
- `hfy-api`, which also serves `/mcp`, `hfy-auth-edge` or the app stack: [Deploy the app stack](deploy-the-app-stack.md#roll-back).
- The private data gate, to take it off the data paths: `add-data-gate-behaviors.sh --remove --app-stack <app-stack>`, in [Cut over to authV2 and the private data gate](cut-over-to-the-private-data-gate.md#roll-back). It makes the family data public again, and member photos too, to anyone who holds a URL.
- A bad version of the gate's code, `hfy-edge-gate`: rerun `add-data-gate-behaviors.sh` with `--version-arn` set to a retained earlier version ([Deploy the edge functions](deploy-the-edge-functions.md#roll-back)).
- A bad version of the MCP behaviors' 401-restore function, `hfy-mcp-edge401`: rerun `add-mcp-behavior.sh --stack <app-stack>` with `--edge401-arn` set to a retained earlier version (same page).
- `HFYAppendIndex`, the default behavior's CloudFront Function: the `roll back with:` commands that `publish-append-index.sh` printed when it published ([Publish a change to the CloudFront Function](publish-the-cloudfront-function.md)).
- Any other CloudFront behavior change: the backup the behavior script saved ([Repository operations](../reference/repository-operations.md#pre-change-backup)).

Values in angle brackets, such as `<site>`, `<distribution-id>`, `<app-stack>`, `<run-id>` and `<sha>`, are placeholders. The forms are listed in [Private data and secrets](../reference/private-data-and-secrets.md#placeholders).

## What the automatic rollback does

When the `smoke` job of a deploy run fails, the `rollback_on_smoke_fail` job finds the most recent successful run of `io-kit-deploy.yml` on `main`, downloads that run's release artifact `io-kit-release-<sha>`, and deploys it: `11ty/` synced to the bucket with `--delete` and the usual excludes, and `/*` invalidated. [Repository operations](../reference/repository-operations.md#composite-actions-githubactionsio-kit-ci) describes the job.

A restored file's versioned URL can briefly serve the failed release's bytes from Cloudflare, which then keeps them for up to 4 h. Step 3 of [Verify](#verify) checks for this. [Why a deploy changes the static URLs](../explanation/release-model.md#why-a-deploy-changes-the-static-urls) and [Edge and origin design](../explanation/edge-and-origin-design.md#static-files-and-versioned-urls-hfy-tsk-086) explain why.

Its limits decide what you do next:

- It runs only after a failed smoke check. A failed `build`, `deploy` or `invalidate` job rolls nothing back.
- It needs an earlier successful run whose artifact still exists. Artifacts are kept for 90 days.
- It restores the previous release's artifact, not a commit. `main` still holds the change, and the next push to `main` deploys it again.
- It does not touch the app stack, the family data or member uploads. The sign-in pages are part of the app stack: `hfy-auth-edge` links `/css/auth-edge.css?v=<sha8>` with the hash it was built with. A rollback restores that stylesheet's file but not the link, which changes only when `hfy-auth-edge` is redeployed ([Deploy the app stack](deploy-the-app-stack.md)).
- It restores the previous release's `flags.json` with the rest of `11ty/`, but it never changes the distribution's behaviors or `HFYAppendIndex`, so an attached gate stays attached. A rollback to an artifact with `"authV2": false` then shuts every visitor out of the gated data. A page with `authV2` off never refreshes `io_id`, so the gate refuses its requests once the hour is up, and person pages, search and photos fail. The artifact is whatever the last successful run deployed, so check rather than assume: run [Check authV2 after a failed deploy](#check-authv2-after-a-failed-deploy) after every failed run.

## Before you start

- `gh`, authenticated with a token that has Actions: write, Contents: write and Pull requests: write on the repository, and Workflows: write as well if a revert changes a file in `.github/workflows/`.
- For a drill: io's go-ahead. A drill redeploys production twice, in quick succession.
- `curl` and `jq`, for the `authV2` check.
- For a gate removal:
  - io's go-ahead. Every real run of a behavior script needs it, `--remove` included.
  - The AWS CLI, and operator AWS credentials that can read and update the distribution and read the outputs of `<app-stack>` in `us-west-2`. The GitHub deploy role can only invalidate the distribution's cache.
  - A private backup directory. A real run saves the distribution configuration, which holds the origin-verify value, under `${HFY_CF_BACKUP_DIR:-~/.local/state/hfy-infra/cloudfront}` with mode 600 ([Repository operations](../reference/repository-operations.md#pre-change-backup)). Leave `HFY_CF_BACKUP_DIR` unset or point it at a private directory outside the repository.

Run the commands on this page from the repository root.

## Check authV2 after a failed deploy

Do this first after any failed run of `io-kit-deploy.yml`, whether or not anything rolled back. A rollback restores the previous release's `flags.json`, and a `deploy` job that failed part-way may or may not have replaced it.

1. Read the published flag and the state of the gate. None of these requests needs a session or AWS credentials:

   ```sh
   curl -s https://<site>/_data/flags.json | jq .authV2
   curl -s -o /dev/null -w '%{http_code}\n' https://<site>/person/index.json
   curl -sS -o /dev/null -D - https://<site>/Person/index.json | grep -iE '^(HTTP|cache-control)'
   ```

   `/_data/flags.json` is JSON, which Cloudflare does not cache, so the first command shows what CloudFront serves.

   | `authV2` | `/person/index.json` | What it means |
   | --- | --- | --- |
   | `true` | `401` or `200` | The client matches the gate, attached or not. Go on to the section that fits the failure. |
   | Anything else | `401` | The gate is attached and every visitor is locked out of the family data. Go to step 2 now. |
   | Anything else | `200` | The gate is not attached, and the data is readable as it was before the release. There is nothing to remove. Go on to the section that fits the failure. |
   | Any | `404` | The gate is not attached, and `HFYAppendIndex` refuses the data to everyone, members included. Use [Find your starting point](cut-over-to-the-private-data-gate.md#find-your-starting-point) to see what the site needs. |

2. If step 1 sent you here, choose by the third command, which shows the code that `HFYAppendIndex` runs:
   - **Anything but `404` with `cache-control: private, no-store`.** It runs its older code. Remove the gate, as in step 3. The data is then readable.
   - **`404` with `cache-control: private, no-store`.** It runs the default-deny code. Removing the gate does not give that client its data back. The six data paths then fall through to the default behavior, where the function answers `404` to every request for them, and member photos become public. Leave the gate attached and get a release with `"authV2": true` live again: fix forward through [Deploy a site change](deploy-a-site-change.md), or [revert the change](#roll-back-by-revert). The other way out is to remove the gate and also roll `HFYAppendIndex` back to its earlier code ([Publish a change to the CloudFront Function](publish-the-cloudfront-function.md)), which needs io's go-ahead too.
3. Remove the gate. Do a dry run first:

   ```sh
   export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2
   scripts/infra/add-data-gate-behaviors.sh --remove --dry-run --distribution <distribution-id> --app-stack <app-stack>
   scripts/infra/add-data-gate-behaviors.sh --remove --distribution <distribution-id> --app-stack <app-stack>
   aws cloudfront wait distribution-deployed --id <distribution-id>
   ```

   - `--app-stack <app-stack>` names the stack whose output `UploadsResponseHeadersPolicyId` is the response headers policy that `/uploads/*` gets back. The script reads that output in the CLI's default Region, which is why the block sets `us-west-2` first. The option's default, `hfy-app`, is not the live stack. While `/uploads/*` is gated, a run without it, the dry run included, exits `1` with `pass --restore-uploads-policy-id ID to name the response headers policy /uploads/* gets back` and changes nothing. `--restore-uploads-policy-id <id>` names the policy directly instead. Pass one of the two on every production `--remove`. It costs nothing when `/uploads/*` is not gated.
   - Do not pass `--stack <app-stack>`. This script's `--stack` names the `us-east-1` gate stack, and `--remove` does not read it.
   - Review the dry run's diff. It removes the six data behaviors, only ones that carry an `hfy-edge-gate` association, so `CacheBehaviors.Quantity` falls by 6. If `/uploads/*` is gated, the diff also modifies it in place: no Lambda association, the `CachingOptimized` cache policy, and the app stack's uploads policy. The script never deletes `/uploads/*`. Stop if the diff changes anything else.
   - If the gate is not attached, both runs print `distribution <distribution-id> already has no hfy-edge-gate-gated data behaviors (/person/*.json /family/* /event/* /note/* /place/* /media/*) and /uploads/* back to its ungated state: no change`, and nothing changes.
   - The `wait` command returns with no output once the distribution is deployed. If it times out, run it again.

   The family data is then public again, as it was before the release, and anyone can read it. So are member photos, to anyone who holds a URL. The response headers policies `hfy-private-no-store` and `hfy-uploads-private` stay in the account, unused. The alternative to `--remove` is restoring the backup that the last real attach run saved, with `aws cloudfront update-distribution`, as the cutover's [Roll back](cut-over-to-the-private-data-gate.md#roll-back) shows. Attach the gate again only after a deploy with `authV2` set to `true` has finished green, as in [step 3 of the cutover](cut-over-to-the-private-data-gate.md#3-attach-the-gate). That run needs io's G-prod approval.

## After an automatic rollback

1. Confirm what happened. In the failed run, `smoke` failed and `rollback_on_smoke_fail` succeeded:

   ```sh
   gh run view <run-id>
   gh run view <run-id> --log | grep -E 'smoke FAIL [0-9]+ |rolling back to run [0-9]'
   ```

   Each `##[error]smoke FAIL <code> <url>` line names a URL that failed. The last line reads `rolling back to run <previous-run-id> (<previous-sha>)`, the release that is now live. The log also prints each step's script, which a looser pattern such as `smoke FAIL` would match as well.
2. [Check authV2](#check-authv2-after-a-failed-deploy), and act on what it shows.
3. Check production with [Verify](#verify), using `<previous-sha>`.
4. Make the rollback durable. Until `main` changes, any push deploys the failing change again. Either fix forward with a new pull request through [Deploy a site change](deploy-a-site-change.md), or [revert the change](#roll-back-by-revert).

## If the automatic rollback fails

Production then holds the release that failed its smoke check, or part of the restore. [Check authV2](#check-authv2-after-a-failed-deploy) first. Then read the `rollback_on_smoke_fail` log:

- `rollback: no previous successful run of io-kit-deploy.yml on main`, or a failed artifact download: there is nothing to restore, as on the first deploy or after the artifact expired. [Revert the change](#roll-back-by-revert).
- An AWS error during the restore: fix the cause, then run the `rollback_on_smoke_fail` job again on its own. Or skip the rerun and [revert the change](#roll-back-by-revert).

  ```sh
  gh run view <run-id> --json jobs --jq '.jobs[] | select(.name == "rollback_on_smoke_fail") | .databaseId'
  gh run rerun --job <rollback-job-id>
  gh run watch <run-id>
  ```

  The first command prints the job's ID, which is not the job number in its URL. A rerun of this job alone keeps the earlier `failure` of `smoke`, so the job's condition still holds, and it restores the release of the most recent successful run again.

  Do not run `gh run rerun <run-id> --failed`. It runs `smoke` first, against a production that holds part of the restore. If the two smoke pages answer, the rollback is skipped, production stays mixed, and the run ends as a success. Its artifact, the release that failed, then becomes the one that the next automatic rollback restores.

  When the rerun succeeds, run [Verify](#verify) with the `<previous-sha>` that its `rolling back to run` line names. Then make the rollback durable, as in step 4 of [After an automatic rollback](#after-an-automatic-rollback): `main` still holds the failing change.

## When nothing rolled back

A failed `deploy` or `invalidate` job leaves whatever it had already done: part of the new `11ty/` synced, cached copies still served. No smoke check runs, so no rollback starts. [Check authV2](#check-authv2-after-a-failed-deploy) first, then:

- If the cause was outside the change, such as an AWS error, fix it and run `gh run rerun <run-id> --failed`. The rerun deploys the same artifact again, then runs `smoke` and, if that fails, the rollback. When it is green, run [Verify](#verify) with the run's own commit, which `gh run view <run-id> --json headSha --jq .headSha` prints. If its smoke check fails, follow [After an automatic rollback](#after-an-automatic-rollback).
- If the change itself is at fault, [revert it](#roll-back-by-revert).

## Roll back by revert

Revert the merge on a branch and merge the revert. The push to `main` deploys the reverted tree through the normal pipeline, with its own smoke check.

Before you merge, read the revert's diff of `11ty/_data/flags.json`. A revert that sets `authV2` back to `false` while the gate is attached turns it off under the gate. A revert of the flip itself, PR #8 (HFY-TSK-069), does that, and turns the other five flags off as well. Such a revert is a global flag flip, so it needs io's G-prod approval. Remove the gate first, as in step 3 of [Check authV2 after a failed deploy](#check-authv2-after-a-failed-deploy), and wait for the distribution before you merge the revert. If `HFYAppendIndex` runs its default-deny code, roll it back too, or the old client still cannot read the data. [Cut over to authV2 and the private data gate](cut-over-to-the-private-data-gate.md#roll-back) gives the order.

```sh
git fetch origin
git switch -c agent/hfy-tsk-<n>-revert origin/main
git revert --no-edit -m 1 <merge-sha>        # for a squash merge, leave out -m 1
git commit --amend -m "HFY-TSK-<n>: Revert <summary>" -m "This reverts commit <merge-sha>."
git push -u origin agent/hfy-tsk-<n>-revert
gh pr create --base main --title "HFY-TSK-<n>: Revert <summary>" --body "<why> CCI-..."
gh pr checks <pr-number> --watch
gh pr merge <pr-number> --merge
```

- The amend makes the commit message start with the record ID, as every commit's must.
- Agents get the `CCI-...` value for the body by marking the record `committed` with the pushed `commit_sha`, as in [`AGENTS.md`](../../AGENTS.md). The PR Commit Gate rejects a pull request without it.
- Merge only when every check has passed. The checks are the ones in [step 1 of Deploy a site change](deploy-a-site-change.md#1-open-a-pull-request).
- Branch protection is strict. If `main` moved while the checks ran, bring the branch up to date with `gh pr update-branch <pr-number>`, then watch the checks again.

Then watch the run as in [Deploy a site change](deploy-a-site-change.md#3-watch-the-runs), and check it with [Verify](#verify). A revert deploys what Git holds, so it also restores the island bundles as they were committed before the change, with the `?v=` versions stamped for them.

If the reverted change touched `auth/edge.manifest.json` or `11ty/css/auth-edge.css`, redeploy `hfy-auth-edge` from the reverted `main` once the revert's run is green, as a code-only update in [Deploy the app stack](deploy-the-app-stack.md), and run check 8 of [Verify in Deploy a site change](deploy-a-site-change.md#verify). Until then, the live sign-in pages still link `/css/auth-edge.css?v=<sha8>` with the hash they were built with, while the bucket now serves the restored stylesheet.

Do not roll back by re-running an older deploy run. A rerun deploys that run's commit, which leaves `main` and production out of step, and the next push deploys the change again.

## Drill the rollback

The `smoke_url` input of `io-kit-deploy.yml` replaces the manifest's smoke URLs for one manual run, so you can make a smoke check fail on purpose without changing the manifest.

1. Find the release the drill will restore:

   ```sh
   gh run list --workflow io-kit-deploy.yml --branch main --status success --limit 1 \
     --json databaseId,headSha,createdAt
   git fetch origin
   git rev-parse origin/main
   ```

   Go on only if the run is less than 90 days old and its `headSha` equals `origin/main`. The drill then deploys and restores the release that is already live, so production ends where it started, `authV2` included, which keeps a drill safe with the gate attached. If the latest successful run is for an older commit, the drill would put production back to that older release. Stop and deploy `main` successfully first.
2. Check that no deploy is in progress, queued or waiting. This prints nothing:

   ```sh
   gh run list --workflow io-kit-deploy.yml --limit 10 --json databaseId,status \
     --jq '.[] | select(.status != "completed")'
   ```

   If it prints a run, wait for that run to finish, then go back to step 1.
3. Start the drill with a smoke URL that cannot succeed. A path with no page returns `403` from the bucket:

   ```sh
   gh workflow run io-kit-deploy.yml --ref main \
     -f target_environment=rollback-drill \
     -f smoke_url="https://<site>/rollback-drill-no-such-page/"
   gh run list --workflow io-kit-deploy.yml --event workflow_dispatch --limit 1
   gh run watch <run-id>
   ```

   The drill's run is titled `io-kit deploy rollback-drill` and is seconds old. If the list shows no such run, or only an older one, run `gh run list` again after a few seconds.
4. Expect `smoke` to fail and `rollback_on_smoke_fail` to succeed. The run as a whole is marked failed. That is the result a drill is after.
5. Run [Verify](#verify) with the `headSha` from step 1. Record the drill's run ID and result in the HFY record's worklog.

If `rollback_on_smoke_fail` fails in a drill, production holds the release from step 1 anyway, because the drill deployed the same commit. Read its log as in [If the automatic rollback fails](#if-the-automatic-rollback-fails), fix the cause, and drill again.

## Verify

Use the commit that should now be live as `<sha>`: `<previous-sha>` after an automatic rollback or a rerun of the rollback job, the `headSha` from step 1 after a drill, the revert's merge commit after a revert, or the run's own commit after a rerun of a failed `deploy` or `invalidate` job.

1. **The run did what you expect.** For an automatic rollback, a rerun of the rollback job or a drill, `gh run view <run-id> --log | grep -E 'rolling back to run [0-9]|invalidated [A-Za-z0-9]+:'` shows `rolling back to run <previous-run-id> (<previous-sha>)` and, after it, the restore's `invalidated <distribution-id>: /*`. The pattern skips the steps' script lines that the log also prints. For a revert or a rerun of a failed `deploy` or `invalidate` job, `gh run view <run-id>` shows `smoke` succeeded and `rollback_on_smoke_fail` skipped.
2. **The pages answer.**

   ```sh
   for p in / /family-login/; do
     curl -s -o /dev/null -w "%{http_code} $p\n" "https://<site>$p"
   done
   ```

   Each line starts with a 2xx or 3xx code.
3. **Production serves that release.** From a checkout that has `<sha>`:

   ```sh
   curl -s https://<site>/_data/flags.json | diff - <(git show <sha>:11ty/_data/flags.json) && echo "flags match"
   refs() { grep -oE '[A-Za-z0-9_./-]+\?v=[0-9a-f]{8}'; }
   diff <(curl -s https://<site>/ | refs) <(git show <sha>:11ty/index.html | refs) && echo "page versions match"
   v=$(git show <sha>:11ty/js/islands/shell.js | shasum -a 256 | cut -c1-8)
   [ "$(curl -s "https://<site>/js/islands/shell.js?v=$v" | shasum -a 256)" = "$(git show <sha>:11ty/js/islands/shell.js | shasum -a 256)" ] \
     && echo "shell bundle matches"
   ```

   All three lines print.
   - Cloudflare does not cache `flags.json` or the HTML, so the first two lines compare what CloudFront serves. The second compares every versioned script and stylesheet reference in the home page with the release's.
   - The third fetches the shell bundle by the `?v=` that the release's island loader requests. `$v` is the hash the build stamped into `js/feature-flags.js`, which a browser console shows as `HFYFeatureFlags.assetVersions.islands.shell.js`. Never check a static file by its bare URL, such as `/js/islands/shell.js`: Cloudflare can answer it with a copy up to 4 h old.
   - If the first two lines print and the third does not, Cloudflare may hold the wrong bytes under that URL from the restore window. Repeat the request with a query no one has used, such as `"https://<site>/js/islands/shell.js?v=$v&check=$(date +%s)"`. Cloudflare has no copy under that URL, and CloudFront ignores the query string. If that copy matches, only Cloudflare's copy is wrong. It expires within 4 h, or a purge of that URL removes it, which needs io's go-ahead.
4. **`authV2` and the gate agree.**

   ```sh
   curl -s https://<site>/_data/flags.json | jq .authV2
   for p in person/index.json uploads/x; do
     printf '/%s ' "$p"; curl -s -o /dev/null -w '%{http_code}\n' "https://<site>/$p"
   done
   ```

   `/person/index.json` prints `401` while the gate is attached, `200` while the data is public, and `404` when the gate is off and `HFYAppendIndex` refuses the data to everyone. With `401`, the first command must print `true`; if it does not, go back to [Check authV2 after a failed deploy](#check-authv2-after-a-failed-deploy). After a gate removal, `/person/index.json` prints `200` and `/uploads/x` prints anything but `401`. A `404` needs the cutover's [Find your starting point](cut-over-to-the-private-data-gate.md#find-your-starting-point).
## Related pages

- [Repository operations](../reference/repository-operations.md#io-kit-deployyml): the deploy jobs, the rollback action and its limits, and the gate script's [remove mode](../reference/repository-operations.md#remove-mode).
- [The release model](../explanation/release-model.md#why-a-kit-pipeline): why the pipeline rolls back on a failed smoke check, [why the gate and `authV2` move in a fixed order](../explanation/release-model.md#the-gate-is-a-third-switch-and-the-order-matters), and [why a deploy changes the static URLs](../explanation/release-model.md#why-a-deploy-changes-the-static-urls).
- [Edge and origin design](../explanation/edge-and-origin-design.md#static-files-and-versioned-urls-hfy-tsk-086): Cloudflare's cache in front of CloudFront, and the versioned asset URLs.
- [Cut over to authV2 and the private data gate](cut-over-to-the-private-data-gate.md): attaching the gate, and removing it again.
- [Deploy the edge functions](deploy-the-edge-functions.md): rolling the gate or the MCP 401-restore function back to an earlier version.
- [Publish a change to the CloudFront Function](publish-the-cloudfront-function.md): publishing `HFYAppendIndex`, and rolling it back.
- [Deploy a site change](deploy-a-site-change.md), [Change the CI pipeline](change-the-ci-pipeline.md), [Toggle a feature flag](toggle-a-feature-flag.md).
