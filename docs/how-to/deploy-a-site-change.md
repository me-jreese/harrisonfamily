# How to deploy a change to the static site

Use this page to ship a change to `11ty/` (the pages, the committed output of the islands build and [`flags.json`](../../11ty/_data/flags.json)), to the legacy `hfy-check-allowed` Lambda or to the legacy `getAllowlist` Cloud Function, and to confirm that it is live.

Some changes do not ship this way:

- `api/` or `auth/`: use [Deploy the app stack](deploy-the-app-stack.md). That includes a new sign-in stylesheet URL. When the islands build changes `theme.cssUrl` in [`auth/edge.manifest.json`](../../auth/edge.manifest.json), the change reaches visitors only with a redeploy of `hfy-auth-edge`. Do that redeploy after this deploy is green ([Verify](#verify), check 8).
- `edge-gate/`, the private data gate, or the MCP 401-restore function in [`mcp-edge401.us-east-1.yaml`](../../infrastructure/mcp-edge401.us-east-1.yaml): use [Deploy the edge functions](deploy-the-edge-functions.md).
- `HFYAppendIndex`, the CloudFront Function in [`scripts/cloudfront/append-index.js`](../../scripts/cloudfront/append-index.js): use [Publish a change to the CloudFront Function](publish-the-cloudfront-function.md).
- Attaching or removing the data gate on the distribution, including gating `/uploads/*`: use [Cut over to authV2 and the private data gate](cut-over-to-the-private-data-gate.md).
- The pipeline itself: use [Change the CI pipeline](change-the-ci-pipeline.md).

To change the theme or the brand fonts, follow [Change the theme or brand fonts](change-the-theme-or-brand-fonts.md) first, then ship the result with this page. For why a deploy and a feature flag are separate switches, see [the release model](../explanation/release-model.md).

Values in angle brackets, such as `<site>`, `<repo>`, `<app-stack>`, `<distribution-id>`, `<pr-number>` and `<run-id>`, are placeholders. The forms are listed in [Private data and secrets](../reference/private-data-and-secrets.md#placeholders).

## What ships

A push to `main` starts two independent workflow runs, whatever the change touched:

- **[`io-kit-deploy.yml`](../../.github/workflows/io-kit-deploy.yml)**, the kit pipeline. It builds a release from the commit, syncs `11ty/` to `<site-bucket>` with `--delete`, updates the code of `hfy-check-allowed`, invalidates `/*` on CloudFront and waits for the invalidation, then requests `https://<site>/` and `https://<site>/family-login/`. If either smoke request fails, it redeploys the release of the previous successful run.
- **[`deploy-gcf-legacy.yml`](../../.github/workflows/deploy-gcf-legacy.yml)**, which deploys `getAllowlist`. Nothing rolls it back.

The sync never writes or deletes the family data prefixes or member uploads: it excludes `person/*.json`, `media/*`, `family/*`, `event/*`, `note/*`, `place/*` and `uploads/*`.

Everything the islands build writes ships exactly as committed, because no workflow builds it. That covers the bundles in `js/islands/`, `css/hfy-theme.css`, `css/auth-edge.css`, `fonts/`, the stamped `sw.js` and `js/feature-flags.js`, the colours in `manifest.webmanifest`, and the head blocks, family-voice copy and `?v=<sha8>` versions in the pages. The [theme and asset build reference](../reference/theme-and-asset-build.md) lists every output.

These do not ship with this pipeline:

- The app stack, including `hfy-api` and `hfy-auth-edge`. `auth/edge.manifest.json` ships inside the `hfy-auth-edge` package.
- The Lambda@Edge functions `hfy-edge-gate` and `hfy-mcp-edge401`.
- `HFYAppendIndex`.
- CloudFront configuration changes, including the data gate's behaviors.

[Repository operations](../reference/repository-operations.md#workflows) lists every job and step, and [what no workflow ships or runs](../reference/repository-operations.md#what-no-workflow-ships-or-runs).

Cloudflare proxies `<site>` in front of CloudFront. It caches scripts, stylesheets, fonts and `sw.js` for 4 h under the URL it first fetched them by, and the pipeline's `/*` invalidation never reaches it. It does not cache HTML or JSON. A deploy reaches visitors at once only because every page names its scripts and stylesheets by content, as `?v=<sha8>`, and the island loader and the service worker read the same hashes from stamped blocks. The pipeline does not order the upload: `deploy-static` is one `aws s3 sync --delete`, HTML included, followed by the invalidation. While it runs, an edge can answer a new `?v=` URL with the old file. The smoke checks request only HTML pages, so a green run shows that the pages answer, not that every file they name is new. That is why [Verify](#verify) fetches versioned URLs. [Edge and origin design](../explanation/edge-and-origin-design.md#static-files-and-versioned-urls-hfy-tsk-086) explains the cache layers and the window.

## Before you start

- The repository secrets `AWS_DEPLOY_ROLE_TO_ASSUME`, `HFY_GOOGLE_CLIENT_ID` and `GCP_SERVICE_ACCOUNT_KEY` exist. `gh secret list` shows their names. If one is missing, follow [Stand up the static site](stand-up-the-static-site.md).
- The change is on a branch tied to an HFY record, for example `agent/hfy-tsk-<n>-<slug>`, and the record ID leads each commit message (`HFY-TSK-<n>: <summary>`). Agents also follow the lifecycle in [`AGENTS.md`](../../AGENTS.md), including the `CCI-...` value that the PR Commit Gate requires in the pull request body.
- Any `11ty/` change taken from the Eleventy source followed [Refresh the Eleventy output](refresh-the-eleventy-output.md), including the islands build after it. `11ty/` is build output, and its source lives outside the repository. A refreshed page committed without the islands build keeps unversioned URLs and goes stale at Cloudflare.
- The islands build ran, and every output it changed is committed with the change, if any of these is true:
  - the change touches `islands/`, the theme or the fonts;
  - it edits a script or stylesheet in `11ty/` that a page links, such as `js/person-page.js`, because every page names that file by its hash;
  - it came from an Eleventy refresh.

  Commit `islands/` together with every output the build changed: `11ty/js/islands/`, `11ty/css/hfy-theme.css`, `11ty/css/auth-edge.css`, `11ty/fonts/`, the touched pages, `11ty/js/feature-flags.js`, `11ty/sw.js`, `11ty/manifest.webmanifest` and `auth/edge.manifest.json`. `git status --short islands 11ty auth/edge.manifest.json` lists them. [Build and preview the islands](build-and-preview-the-islands.md) covers the build. Then this prints `<repo>/11ty is up to date (<n> generated files)`:

  ```sh
  (cd islands && npm run check:islands)
  ```

  The check rebuilds in memory, so it needs the dependencies that `npm ci` installs with a CodeArtifact token. A `missing`, `stale` or `extra` line means the committed output differs from the source: build again and commit. Never edit a `?v=` value or an `hfy-asset-versions` block by hand.
- `REPLACE_WITH_GOOGLE_CLIENT_ID` is left as is in the committed files. The pipeline substitutes the real client ID on the runner, so the repository never carries it. `grep -rl REPLACE_WITH_GOOGLE_CLIENT_ID 11ty | wc -l` prints `11`: the ten rendered pages and `js/auth.js`.
- The suites that cover your change pass locally ([Run the tests](run-the-tests.md)). CI runs only the three CodeArtifact-free suites on a pull request; no workflow runs the others.
- If the change edits `flags.json`, read [Toggle a feature flag](toggle-a-feature-flag.md) first. A global flip needs io's G-prod approval. Never publish an `authV2` value other than `true` while the data gate is attached. This prints `401` while it is attached:

  ```sh
  curl -s -o /dev/null -w '%{http_code}\n' https://<site>/person/index.json
  ```

  In an environment that has not cut over yet, such as a new one, turning `authV2` on is step 1 of [Cut over to authV2 and the private data gate](cut-over-to-the-private-data-gate.md).
- You know what an automatic rollback would put back. From an up-to-date checkout:

  ```sh
  git fetch origin
  PREV="$(gh run list --workflow io-kit-deploy.yml --branch main --status success --limit 1 --json headSha --jq '.[0].headSha')"
  git show "$PREV:11ty/_data/flags.json" | jq .authV2
  ```

  This is the release that `rollback_on_smoke_fail` redeploys if your run fails its smoke check. If it prints anything but `true` while the gate is attached, a failed smoke check would lock members out of the family data. Have operator AWS credentials ready for the warning under [Watch the runs](#3-watch-the-runs).

## Steps

### 1. Open a pull request

```sh
git push -u origin agent/hfy-tsk-<n>-<slug>
gh pr create --base main --title "HFY-TSK-<n>: <summary>" --body "<what changed and how it was tested>"
gh pr checks <pr-number> --watch
```

The pull request runs [`io-kit-ci.yml`](../../.github/workflows/io-kit-ci.yml): the release build (client ID patch and Lambda package), the pipeline drift report and a TruffleHog scan of the commit range. All three must pass. The drift report runs in report mode, so it passes even when it finds drift. Open the `parity` job's summary and confirm that it says `no pipeline_drift`. Drift means a rendered workflow file was edited by hand; see [Change the CI pipeline](change-the-ci-pipeline.md).

No check runs a test suite or `check:islands`. The other gates are local:

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
| `deploy`, at the sync | Possibly part of the new `11ty/`, which can include pages that name files not yet uploaded. Nothing rolls back. | First run the `authV2` check in the warning below. Then fix the cause and `gh run rerun <run-id> --failed`, or [roll back](roll-back-a-site-deploy.md#when-nothing-rolled-back). |
| `deploy`, at the Lambda update | The new static site with the old `hfy-check-allowed`. | As above. |
| `invalidate` | The new files and Lambda, but CloudFront can serve cached copies. No smoke check runs. | `gh run rerun <run-id> --failed`. |
| `smoke` | `rollback_on_smoke_fail` redeployed the previous release, `flags.json` included. `main` still holds your change. | First run the `authV2` check in the warning below. Then follow [Roll back a site deploy](roll-back-a-site-deploy.md#after-an-automatic-rollback). |
| `rollback_on_smoke_fail` | The new release, which failed its smoke check. | Follow [Roll back a site deploy](roll-back-a-site-deploy.md#if-the-automatic-rollback-fails). |

> **Warning: while the data gate is attached, a release whose `flags.json` does not say `"authV2": true` locks every visitor out of the family data (HFY-R67).** The production cutover ran on 2026-10-12 (HFY-TSK-069): `authV2` went on for everyone, and the gate was attached after it. `rollback_on_smoke_fail` redeploys the previous successful release's `11ty/`, and with it that release's `_data/flags.json`. Every release built before the flip says `"authV2": false`. The legacy client does not send the `io_id` cookie, so the gate refuses its data requests, and person pages, search and photos fail for every visitor. After every automatic rollback, and after a `deploy` job that failed during the sync, run these checks. They need no credentials:
>
> ```sh
> curl -s https://<site>/_data/flags.json | jq .authV2
> curl -s -o /dev/null -w '%{http_code}\n' https://<site>/person/index.json
> curl -sS -o /dev/null -D - https://<site>/Person/index.json | grep -iE '^(HTTP|cache-control)'
> ```
>
> If the first prints `true`, the client and the gate agree. Otherwise, and while the second prints `401`, members are locked out:
>
> - **If the third shows `404` with `cache-control: private, no-store`,** `HFYAppendIndex` runs its default-deny code, and removing the gate would not give the legacy client its data back. Get a release with `"authV2": true` deployed again, by fixing forward or reverting ([Roll back a site deploy](roll-back-a-site-deploy.md#after-an-automatic-rollback)), or follow the cutover's [Roll back](cut-over-to-the-private-data-gate.md#roll-back).
> - **Otherwise remove the gate at once.** You need operator AWS credentials and io's go-ahead; the GitHub deploy role cannot change the distribution. Do a dry run first:
>
>   ```sh
>   export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2
>   scripts/infra/add-data-gate-behaviors.sh --remove --dry-run --distribution <distribution-id> --app-stack <app-stack>
>   scripts/infra/add-data-gate-behaviors.sh --remove --distribution <distribution-id> --app-stack <app-stack>
>   aws cloudfront wait distribution-deployed --id <distribution-id>
>   ```
>
>   - `--app-stack <app-stack>` names the stack whose `UploadsResponseHeadersPolicyId` output is the policy that `/uploads/*` gets back. The script reads it in the CLI's default region, so the block sets `us-west-2` first. The option's default, `hfy-app`, is not the live stack. While `/uploads/*` is gated, a run without `--app-stack <app-stack>` or `--restore-uploads-policy-id <id>`, the dry run included, exits `1` with `pass --restore-uploads-policy-id ID to name the response headers policy /uploads/* gets back` and changes nothing.
>   - Do not pass `--stack <app-stack>`. This script's `--stack` names the `us-east-1` gate stack, and `--remove` does not read it.
>   - The dry run's diff must remove the six gated data behaviors, so `CacheBehaviors.Quantity` falls by 6. If `/uploads/*` is gated, the diff also modifies it in place: no Lambda association, `CachingOptimized`, and the app stack's uploads policy. Stop if it changes anything else. If nothing is gated, both runs print `distribution <distribution-id> already has no hfy-edge-gate-gated data behaviors (...) and /uploads/* back to its ungated state: no change`.
>   - Once the distribution is deployed, the family data is public again, and so are member photos, to anyone who holds a URL. The policies `hfy-private-no-store` and `hfy-uploads-private` stay in the account, unused. The alternative to `--remove` is restoring the backup that the attaching run saved, with `aws cloudfront update-distribution`, as in the cutover's [Roll back](cut-over-to-the-private-data-gate.md#roll-back).
>
> Then make the rollback last ([Roll back a site deploy](roll-back-a-site-deploy.md#after-an-automatic-rollback)). Attach the gate again only after a deploy with `authV2` set to `true` has finished green ([Cut over to authV2 and the private data gate](cut-over-to-the-private-data-gate.md#3-attach-the-gate)).

Then watch the `deploy-gcf-legacy.yml` run. If it fails, the previous revision of `getAllowlist` keeps serving. Fix the cause and rerun it. Nothing in any sign-in path calls the function.

## Verify

Run these checks from the root of an up-to-date `main` checkout.

1. **The deploy run is green.** `gh run view <run-id>` shows `build`, `deploy`, `invalidate` and `smoke` succeeded and `rollback_on_smoke_fail` skipped. The `smoke` log has an `ok` line for each URL. The `invalidate` job waits for the invalidation to finish, so CloudFront serves the new files when the checks below run. Cloudflare does not cache HTML or JSON. It can still answer an unversioned script or stylesheet URL, such as `/js/islands/shell.js`, with its own copy, up to 4 h old. So the checks below fetch the versioned URLs that the pages reference.
2. **The pages answer.**

   ```sh
   for p in / /family-login/; do
     curl -s -o /dev/null -w "%{http_code} $p\n" "https://<site>$p"
   done
   ```

   Each line starts with a 2xx or 3xx code.
3. **The published flags match the committed file.**

   ```sh
   curl -s "https://<site>/_data/flags.json" | diff - 11ty/_data/flags.json && echo "flags match"
   ```

4. **The pages name the committed asset versions.**

   ```sh
   for p in / /family-login/ /person/ /posts/; do
     if diff <(curl -s "https://<site>$p" | grep -oE '/[A-Za-z0-9/._-]+\?v=[0-9a-f]{8}' | sort -u) \
             <(grep -oE '/[A-Za-z0-9/._-]+\?v=[0-9a-f]{8}' "11ty${p}index.html" | sort -u) >/dev/null
     then echo "same: $p"; else echo "DIFFERENT: $p"; fi
   done
   ```

   Each line says `same`. Cloudflare does not cache HTML, so this shows the pages CloudFront serves. The client ID patch does not touch the `?v=` values.
5. **The island bundles at their versioned URLs are the committed ones.**

   ```sh
   for f in shell.js shell.css search.js notify-sw.js; do
     v="$(shasum -a 256 < "11ty/js/islands/$f" | cut -c1-8)"
     [ "$(curl -s "https://<site>/js/islands/$f?v=$v" | shasum -a 256 | cut -c1-8)" = "$v" ] \
       && echo "same: $f" || echo "DIFFERENT: $f"
   done
   ```

   `$v` is the `?v=` that the island loader and the service worker request. The build stamps each bundle's hash into `js/feature-flags.js`, and the hash of `notify-sw.js` into `sw.js`, and `check:islands` confirmed the stamps. In a browser, `HFYFeatureFlags.assetVersions` in the DevTools console shows the map that the loader uses.

   Each line says `same`. The bundles carry no client ID placeholder, so the deploy does not change them. A `DIFFERENT` line means that the URL serves other bytes. Either the deploy did not ship the committed file, or an edge answered the new URL with the old file while the sync ran, and Cloudflare kept that copy. Cloudflare keeps it for up to 4 h. A Cloudflare purge needs io's go-ahead ([`AGENTS.md`](../../AGENTS.md)).
6. **The client ID placeholder was replaced.**

   ```sh
   curl -s "https://<site>/family-login/" | grep -o '"clientId":"[^"]*"'
   AUTH_JS="$(curl -s "https://<site>/family-login/" | grep -o '/js/auth\.js?v=[0-9a-f]*')"
   curl -s "https://<site>$AUTH_JS" | grep -c REPLACE_WITH_GOOGLE_CLIENT_ID
   ```

   The first command prints a `clientId` that is neither empty nor the placeholder. The last prints `0`. Its `?v=` hashes the committed file, which still carries the placeholder, so the served bytes do not match that hash. That is expected.
7. **Sign-in still works.** Which check applies depends on the published `authV2` value, which `curl -s https://<site>/_data/flags.json | jq .authV2` prints. Use a private window, so that no preview override applies. If a check fails, see [Diagnose sign-in and API failures](diagnose-sign-in-and-api-failures.md).
   - **`true`: the `io_id` session and the gate.** The production cutover on 2026-10-12 published this value. Sign in at `https://<site>/auth/login`, then open a person page, `https://<site>/person/?id=<gramps-id>`. In DevTools > Network, the `/person/<gramps-id>.json` request carries a `Cookie` header that includes `io_id`, and no `X-HFY-Session` header. Do not copy the cookie value anywhere. Then, signed out, from a shell with no cookies:

     ```sh
     curl -sS -o /dev/null -D - https://<site>/person/index.json | grep -iE '^(HTTP|cache-control)'
     ```

     While the gate is attached, the status is `401`, with `cache-control: private, no-store`. A `200` means that the gate is not attached and the data is public. A `404` means that it is not attached and `HFYAppendIndex` refuses the data to everyone, members included. For either, find out why before you go on ([Cut over to authV2 and the private data gate](cut-over-to-the-private-data-gate.md#find-your-starting-point)).
   - **Anything else: the legacy client.** In production, that follows only a rollback, a revert or a deliberate return to the legacy client. In a new environment, it is the state before the cutover. If the `curl` above prints `401`, the gate is attached: remove it now, as in the warning under [Watch the runs](#3-watch-the-runs). Otherwise, open `https://<site>/family-login/` and sign in with an allowlisted Google account. The navigation switches to the signed-in state: **LOG OUT**, plus **MY RECORD** for an account mapped to a record. This check cannot run while `authV2` is on, because `/family-login/` then sends a signed-out visitor to `/auth/login`.
8. **If the build changed `theme.cssUrl`, the sign-in pages link the new stylesheet.** This check applies after you redeploy `hfy-auth-edge` from a commit that carries the new `auth/edge.manifest.json` ([Deploy the app stack](deploy-the-app-stack.md)). Redeploy only once this deploy is green, so that the file the new URL names is already live. Otherwise an edge can cache the old stylesheet under the new URL.

   ```sh
   V="$(jq -r .theme.cssUrl auth/edge.manifest.json | grep -o 'auth-edge\.css?v=[0-9a-f]*')"
   echo "$V"
   curl -s https://<site>/auth/login | grep -o 'auth-edge\.css?v=[0-9a-f]*' | head -1
   curl -s "https://<site>/css/$V" | shasum -a 256 | cut -c1-8
   ```

   The first two lines name the same `auth-edge.css?v=<sha8>`. Until the redeploy, the second names the previous version. The last line prints the same `<sha8>`.

If you changed the Lambda or the Cloud Function, confirm the update with operator credentials:

```sh
aws lambda get-function-configuration --function-name hfy-check-allowed --region us-west-2 \
  --query '[LastModified,LastUpdateStatus]' --output text
gcloud functions describe getAllowlist --project <gcp-project> --region us-west2 --gen2 \
  --format 'value(state,updateTime)'
```

The Lambda shows a `LastModified` time after the run started and `Successful`. The function shows `ACTIVE` and an `updateTime` after the run started.

## If the change has to come out

Follow [Roll back a site deploy](roll-back-a-site-deploy.md). It covers the automatic rollback, a durable rollback by revert, and the cases nothing rolls back. A revert or a rollback to a release built before the 2026-10-12 flip publishes `"authV2": false`. While the gate is attached, remove the gate first, as in the warning under [Watch the runs](#3-watch-the-runs).

## Related pages

- [Release model](../explanation/release-model.md): why deploys and flags are separate, why a deploy changes the static URLs, and why the pipeline is shaped as it is.
- [Edge and origin design](../explanation/edge-and-origin-design.md#caching-posture): CloudFront's and Cloudflare's caches, and why the asset URLs are versioned.
- [Theme and asset build](../reference/theme-and-asset-build.md): every output of the islands build, the `?v=<sha8>` versions and the stamped blocks.
- [Repository operations](../reference/repository-operations.md): the workflows, the kit manifest, the deploy role, the [CloudFront behavior scripts](../reference/repository-operations.md#cloudfront-behavior-scripts) and the pre-commit hook.
- [Cut over to authV2 and the private data gate](cut-over-to-the-private-data-gate.md): the `authV2` flip, the gate, and their rollback order.
- [Deploy the edge functions](deploy-the-edge-functions.md): `hfy-edge-gate` and `hfy-mcp-edge401`, which this pipeline does not ship.
- [Publish a change to the CloudFront Function](publish-the-cloudfront-function.md): `HFYAppendIndex`, which this pipeline does not ship.
- [Change the theme or brand fonts](change-the-theme-or-brand-fonts.md), [Build and preview the islands](build-and-preview-the-islands.md), [Refresh the Eleventy output](refresh-the-eleventy-output.md).
- [Roll back a site deploy](roll-back-a-site-deploy.md), [Change the CI pipeline](change-the-ci-pipeline.md), [Toggle a feature flag](toggle-a-feature-flag.md), [Run the tests](run-the-tests.md), [Deploy the app stack](deploy-the-app-stack.md).
