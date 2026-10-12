# How to publish a change to the HFYAppendIndex CloudFront Function

Use this page after you edit [`scripts/cloudfront/append-index.js`](../../scripts/cloudfront/append-index.js), the source of the CloudFront Function `HFYAppendIndex`, to put the new code in front of visitors and to roll it back. It also covers adding a public file under `11ty/person/`, which the function refuses until it lists the file. To create the function and attach it in a new environment, use [step 4 of Stand up the static site](stand-up-the-static-site.md#4-create-and-attach-hfyappendindex) instead. The publish script never creates a function.

`HFYAppendIndex` is the viewer-request function of the distribution's default behavior. It does two things:

- It rewrites clean URLs, such as `/about/` to `/about/index.html`.
- It answers `404` with `cache-control: private, no-store` to case and suffix variants of the private data paths, such as `/Person/index.json`, without reaching the bucket.

[Architecture](../reference/architecture.md#hfyappendindex) lists its rules. [Edge and origin design](../explanation/edge-and-origin-design.md#why-the-cloudfront-function-also-denies) explains why the function denies.

No workflow publishes the function. A merge to `main` changes only the repository file, and visitors keep getting the code on the function's `LIVE` stage. You publish by hand with [`publish-append-index.sh`](../../scripts/infra/publish-append-index.sh), never with raw `update-function` and `publish-function` commands. The script refuses to publish while the function is associated with any behavior other than the default one. It saves the previous code outside the repository. It updates the `DEVELOPMENT` stage, which no visitor gets, and tests it there with CloudFront's `test-function`. It publishes to `LIVE` only when every case passes. The default behavior's association names the function, not a version, so the published code takes effect without a distribution update. The repository does not record which code `LIVE` runs. The dry run in [step 2](#2-dry-run-the-publish) shows it.

Values in angle brackets, such as `<site>`, `<distribution-id>` and `<repo>`, are placeholders. Their forms are listed in [Private data and secrets](../reference/private-data-and-secrets.md#placeholders).

## Before you start

- **io's go-ahead for the real run.** [`AGENTS.md`](../../AGENTS.md) lists every real run of `publish-append-index.sh` among the operations that need it, because the run changes what every visitor gets from the default behavior. A rollback needs it too. The tests and the dry run do not.
- **Tools.** Node.js 20 or later, `jq` and the AWS CLI v2. Run every command from the root of a Git checkout, because the tests list the tracked files under `11ty/` with `git`.
- **A clean checkout of the commit to publish.** The script publishes the file in the working tree, whatever commit it came from. Publish code that has been reviewed and merged to `main`, so that the repository says what `LIVE` runs. `git status --short` prints nothing.
- **Operator AWS credentials.** The dry run needs `cloudfront:DescribeFunction`, `cloudfront:GetFunction` and `cloudfront:GetDistributionConfig`. The real run also needs `cloudfront:UpdateFunction`, `cloudfront:TestFunction` and `cloudfront:PublishFunction`. The GitHub deploy role has none of these. CloudFront is a global service, so the shell's Region does not matter here.
- **The gated behaviors exist.** The function refuses the exact data paths as well as their variants. Real requests for the data stay away from it only because CloudFront matches the gated behaviors before the default one. Check that they are all there:

  ```sh
  aws cloudfront get-distribution-config --id <distribution-id> \
    --query 'DistributionConfig.CacheBehaviors.Items[].PathPattern' --output text
  curl -s -o /dev/null -w '%{http_code}\n' https://<site>/person/index.json
  ```

  The first command's output includes `/person/*.json`, `/family/*`, `/event/*`, `/note/*`, `/place/*`, `/media/*` and `/uploads/*`. The second, run without a cookie, prints `401`, which is the gate's answer. If a pattern is missing, or the second command prints anything else, stop. The function would refuse that data to everyone, members included. Start from [Find your starting point](cut-over-to-the-private-data-gate.md#find-your-starting-point) in the cutover page.

## Steps

### 1. Test the change

If the change adds a public file under `11ty/person/`, first make the edits in [Add a public file under `11ty/person/`](#add-a-public-file-under-11typerson).

Add a case to [`append-index.cases.json`](../../scripts/cloudfront/test/append-index.cases.json) for each rule you changed. A `rewrite` case gives a `uri` and the rewritten URI it must become, `expect`. A `deny` case is a URI that must get the `404`. `awsSamples` is the subset that the publish script sends to `test-function`, and each of its URIs must also be a `rewrite` or `deny` case. Add a sample for each case that CloudFront's own runtime should confirm. Then run the tests:

```sh
node --test scripts/cloudfront/test/*.test.mjs
```

The run ends with `ℹ fail 0`. The tests load the source as CloudFront does and run the case table. They also check four things:

- No path that the site ships under `11ty/` is denied.
- `DENY_FIRST_SEGMENTS` equals the non-person patterns of [`add-data-gate-behaviors.sh`](../../scripts/infra/add-data-gate-behaviors.sh).
- `PUBLIC_PERSON_FILES` equals the files in `11ty/person/`.
- The source stays ES5.1 and under 10 KB, because the function runs on `cloudfront-js-1.0`.

Then run the infrastructure suite. It runs the same tests again, and it drives the publish script, with your code and case table, against a stub `aws`:

```sh
scripts/infra/test/run.sh
```

It ends with `scripts/infra tests: <n> passed, 0 failed`. [Run the tests](run-the-tests.md#5-run-the-infrastructure-script-tests-offline) lists the tools it needs.

No workflow runs these suites, so the pull request's checks do not cover this code. Record the results as the task's acceptance evidence, then merge the pull request once it is reviewed. The merge does not publish the function.

### 2. Dry-run the publish

From a clean checkout of `main` at the merged commit:

```sh
scripts/infra/publish-append-index.sh --dry-run --distribution <distribution-id>
```

The script's `--distribution` default is this repository's production distribution. Pass the flag anyway, so that the command names its target. The dry run only reads. Review its output in order:

1. `local unit tests pass (scripts/cloudfront/test/append-index.test.mjs)`. Without `node`, it prints `(local unit tests not run: needs node and the repo's own append-index.js; test-function still gates the publish)`. Step 1 still has to pass.
2. `HFYAppendIndex is the viewer-request function of the default cache behavior of <distribution-id>`. If it prints `note: HFYAppendIndex is not associated with the default cache behavior of <distribution-id> (publishing only updates the function)` instead, the function runs for no visitor. See [If something fails](#if-something-fails).
3. The `LIVE` diff, after `--- LIVE vs repo (<repo>/scripts/cloudfront/append-index.js) ---`. Lines that start with `-` are what visitors get now. Lines that start with `+` are what they would get. The diff should show your change and nothing else. A larger diff means `LIVE` runs older code, and the publish ships everything in between, so read all of it. If `DENY_FIRST_SEGMENTS` appears only on `+` lines, `LIVE` predates the default-deny code, and the publish also starts refusing the variant paths. That is safe once the gated behaviors exist, as checked in [Before you start](#before-you-start).
4. The `DEVELOPMENT` diff, after `--- DEVELOPMENT vs repo ---`. `DEVELOPMENT holds exactly the repo code` is the usual line. A diff here is a draft that nobody published. The real run saves it and replaces it.
5. The plan: `(dry-run) would save the previous code to <backup-dir>, update-function HFYAppendIndex (DEVELOPMENT := repo), test-function <n> cases on DEVELOPMENT, then publish-function`, then `(dry-run) no changes made`. `<backup-dir>` is `$HFY_CF_BACKUP_DIR` when it is set, and otherwise `hfy-infra/cloudfront` under `$XDG_STATE_HOME`, or under `~/.local/state` when that is not set either.

If the dry run prints `LIVE runs exactly the repo code` and ends with `function HFYAppendIndex already runs the repo code on LIVE: no change`, there is nothing to publish. A line that starts with `refusing` stops the run: see [If something fails](#if-something-fails).

Show io the `LIVE` diff when you ask for the go-ahead.

### 3. Publish, with io's go-ahead

```sh
scripts/infra/publish-append-index.sh --distribution <distribution-id>
```

The run repeats the dry run's checks and diffs, then:

1. It saves the current `LIVE` code as `<backup-dir>/HFYAppendIndex-LIVE-<timestamp>-before.js`, mode 600, and prints `saved the previous LIVE code to …`. It saves a `DEVELOPMENT` draft that differs from both `LIVE` and the repository the same way, as `HFYAppendIndex-DEVELOPMENT-<timestamp>-before.js`.
2. It updates `DEVELOPMENT` to the repository code, reads it back and prints `updated HFYAppendIndex DEVELOPMENT to the repo code`. It skips this when `DEVELOPMENT` already holds that code.
3. It runs `test-function` on `DEVELOPMENT` for each `awsSamples` case and prints `all <n> test-function cases pass`. This is the gate: it runs the code on CloudFront's runtime, not on Node's. Any failure prints a `FAIL` line for each case and stops with `refusing to publish`. `LIVE` is then unchanged.
4. It publishes to `LIVE`, reads it back and prints `published: HFYAppendIndex LIVE now runs the repo code (the distribution picks it up within a minute or two; no update-distribution needed)`.
5. It prints `roll back with:` and two `aws cloudfront` commands that restore the saved code. Keep them until you have verified the publish. They name the backup file and hold no secret.

If you changed how the function decodes, normalizes or matches a URI, add `--all-cases`. It sends every `rewrite` and `deny` case to `test-function` instead of the samples, at about 0.8 s a case.

The function runs before CloudFront looks in its cache, so the new code needs no invalidation.

## Verify

Wait a minute or two after the publish, then check, without a cookie:

1. The dry run reports no change:

   ```sh
   scripts/infra/publish-append-index.sh --dry-run --distribution <distribution-id>
   ```

   It prints `LIVE runs exactly the repo code` and ends with `function HFYAppendIndex already runs the repo code on LIVE: no change`.
2. Clean URLs and the public person-page shell still load:

   ```sh
   for p in '' about/ about family-login/ person/ person person/index.html; do
     printf '/%s ' "$p"; curl -s -o /dev/null -w '%{http_code}\n' "https://<site>/$p"
   done
   ```

   Each line ends in `200`. Cloudflare does not cache HTML, so these answers come from CloudFront.
3. Case and suffix variants of the private paths are refused, and the answer is not stored:

   ```sh
   for p in Person/index.json PERSON/index.json person/index.JSON person/index.json/ Person/ Family/x Media/x Uploads/x; do
     printf '/%s: ' "$p"
     curl -sS -o /dev/null -D - "https://<site>/$p" | grep -iE '^(HTTP|cache-control)' | tr -d '\r' | paste -sd ' ' -
   done
   ```

   Each line shows `404` and `cache-control: private, no-store`. The encoded, backslash and dot-segment spellings are left out here, because a proxy in front of CloudFront may rewrite them. The unit tests and `test-function` cover them.
4. The gate still answers for the exact data paths: `curl -s -o /dev/null -w '%{http_code}\n' https://<site>/person/index.json` prints `401`.
5. Signed in, a person page loads its data, search returns results, and family photos show. Post photos load on the home page.
6. If the change added a public file under `11ty/person/`, it answers `200` once the site deploy that ships it has finished.

## Add a public file under `11ty/person/`

The function refuses everything under `/person/` that reaches it, except the paths in `PUBLIC_PERSON_FILES`. In the repository, that list holds only the person-page shell, `/person/index.html`. `/person/` and `/person` are rewritten to the shell. A new file under `11ty/person/`, such as a stylesheet for the person page, therefore answers `404` until a function that lists it is published. A JSON file can never be public there: the function refuses any path under `/person/` that contains `.json`, whatever the list says.

Make these edits in the same pull request as the file:

1. **Add the path to `PUBLIC_PERSON_FILES`** in [`append-index.js`](../../scripts/cloudfront/append-index.js), exactly as the page requests it and in the same case, for example `'/person/<name>.css'`. The function compares the rewritten URI as it is, so a page in a subdirectory is listed as `/person/<dir>/index.html`.
2. **Add the path to the allowed `/person/` paths in the test.** In [`append-index.test.mjs`](../../scripts/cloudfront/test/append-index.test.mjs), the test `no real site path is denied` accepts only `/person/` and `/person/index.html` under `/person/`. Until you add the new path, and `/person/<dir>/` too for a subdirectory, it fails with `<path> is in 11ty/person/`, even though `PUBLIC_PERSON_FILES` lists the file.
3. **Add the cases.** Add a `rewrite` case for the new path, and add its `uri` to `awsSamples`. For a file, `uri` and `expect` are both the path. For a page in a subdirectory, `uri` is `/person/<dir>/` and `expect` is `/person/<dir>/index.html`. If a `deny` case names the same path, remove it.
4. **A new HTML page also goes into `PAGES`** in [`islands/heads.mjs`](../../islands/heads.mjs), or the islands tests fail ([Theme and asset build](../reference/theme-and-asset-build.md)).

Then follow [Steps](#steps). The merge ships the file with the site deploy ([Deploy a site change](deploy-a-site-change.md)). Until you publish the function, the file answers `404` with `cache-control: private, no-store`. Neither CloudFront nor Cloudflare keeps that answer, so the file is served as soon as the function is published.

## Roll back

Roll back when the published code misbehaves, for example when public pages answer `404` or `403`, or every page fails with an error from the function. A rollback needs io's go-ahead.

1. **Restore the saved code.** Run the two commands that the real run printed after `roll back with:`. They have this form:

   ```sh
   aws cloudfront update-function --name HFYAppendIndex \
     --if-match "$(aws cloudfront describe-function --name HFYAppendIndex --stage DEVELOPMENT --query ETag --output text)" \
     --function-config '{"Comment":"<previous comment>","Runtime":"cloudfront-js-1.0"}' \
     --function-code fileb://<backup-dir>/HFYAppendIndex-LIVE-<timestamp>-before.js
   aws cloudfront publish-function --name HFYAppendIndex \
     --if-match "$(aws cloudfront describe-function --name HFYAppendIndex --stage DEVELOPMENT --query ETag --output text)"
   ```

   If you no longer have them, the backups are only on the machine that ran the publish. The newest `HFYAppendIndex-LIVE-*-before.js` in `<backup-dir>` is the code that `LIVE` ran before the last publish from that machine. Any comment of up to 128 characters works. The publish script sets `Append index.html to directory paths; 404 for private data prefix variants (HFY data gate)`.

   These commands skip `test-function`, because they put back code that already ran. Do not roll back with `publish-append-index.sh --source <backup>`. The script tests any source against the current case table, so it refuses older code that fails a case added since.
2. **Check the result.** Run the dry run again. Its `LIVE` diff now shows the rolled-back change on the `+` side. Repeat the checks in [Verify](#verify): the lines that change are the ones the rolled-back code handled.
3. **Bring the repository and `LIVE` back together.** Either fix the code and publish it with this page, or revert the change in the repository.

If the saved code predates the default-deny code, rolling back to it stops the refusals. The variant spellings then reach the bucket with no gate again, and some of them, percent-encoded ones among them, can name a real data file ([Edge and origin design](../explanation/edge-and-origin-design.md#why-the-cloudfront-function-also-denies)). Fix forward instead where you can. To roll the function back as part of taking the gate off, follow [Cut over to authV2 and the private data gate](cut-over-to-the-private-data-gate.md#roll-back).

## If something fails

| Message or symptom | Cause | Fix |
| --- | --- | --- |
| `refusing: the local unit tests of <repo>/scripts/cloudfront/append-index.js fail`, after the failing test's output | A unit test fails. | Fix the code, the case table or the lists, and run step 1 again. |
| `refusing: <repo>/scripts/cloudfront/append-index.js is over the 10 KB CloudFront Functions limit` | The file is over 10,240 bytes. Comments count. | Shorten it. |
| `refusing: <repo>/scripts/cloudfront/append-index.js does not define function handler(event)` | The entry point was renamed or removed. | CloudFront calls `handler`. Restore it. |
| `refusing: cannot describe function HFYAppendIndex (it must exist; create it once with aws cloudfront create-function)` | The credentials lack `cloudfront:DescribeFunction`, or belong to another account, or the function does not exist. | Fix the credentials. In a new environment, create the function as in [step 4 of Stand up the static site](stand-up-the-static-site.md#4-create-and-attach-hfyappendindex). |
| `refusing: HFYAppendIndex runs <runtime>, this script publishes cloudfront-js-1.0 (ES5.1) code only` | The function's runtime was changed. | Stop and raise it on an HFY record. The code and its tests target `cloudfront-js-1.0`. |
| `refusing: cannot read distribution <distribution-id> (use --distribution none to skip the association check)` | The ID is wrong, or the credentials lack `cloudfront:GetDistributionConfig`. | Fix the ID or the credentials. Never pass `--distribution none` for production: it skips the association check. |
| `refusing (exit 3): HFYAppendIndex is associated with cache behavior(s) <patterns> of <distribution-id>. …` | Someone associated the function with another behavior. None of the behavior scripts does that. While the association exists, those paths answer `404` to everyone. | Remove the function from that behavior's `FunctionAssociations` with `update-distribution`, with io's go-ahead. Then run the dry run again. |
| `FAIL "<uri>": got [<result>], want [<expected>]`, then `refusing to publish: <k> of <n> test-function cases failed. DEVELOPMENT holds the new code, LIVE is untouched` | The code behaves differently on CloudFront's runtime than in Node, typically through a language feature or method that `cloudfront-js-1.0` lacks. `got [error …]` is an exception in the function. `got [test-function call failed: …]` is a failed API call, often a missing `cloudfront:TestFunction`. | Visitors are unaffected, because nobody gets `DEVELOPMENT`. Fix the code or the permission, add the URI to the case table, and start again from step 1. The next run replaces the `DEVELOPMENT` draft. |
| `PreconditionFailed` from `update-function`, `test-function` or `publish-function` | The function changed after the script read it. | Run the dry run again and review the new diffs. |
| `DEVELOPMENT does not hold the repo code after update-function; LIVE untouched` | The read-back differs, for example after a concurrent update. | Start again from step 2. |
| `LIVE does not hold the repo code after publish-function` | The publish ran, but the read-back differs. | Run the dry run to see what `LIVE` runs, and [roll back](#roll-back) if it is not what you published. |
| `note: HFYAppendIndex is not associated with the default cache behavior of <distribution-id> …`, or `/about/` answers `403` | The function runs for no visitor, so clean URLs fail and the variants are not refused. | Find out why it was detached before you change anything. Attaching it is substep 4 of [step 4 of Stand up the static site](stand-up-the-static-site.md#4-create-and-attach-hfyappendindex), and on a live distribution it needs io's go-ahead. |
| Person, search and photo data answer `404` with `cache-control: private, no-store` for everyone | The gated behaviors are missing, so data requests reach the function. | This is not a function fault. See [Cut over to authV2 and the private data gate](cut-over-to-the-private-data-gate.md#if-something-fails). |
| A new file under `/person/` answers `404` | The code on `LIVE` does not list it in `PUBLIC_PERSON_FILES`. | Follow [Add a public file under `11ty/person/`](#add-a-public-file-under-11typerson) and publish. |

## Related pages

- [Stand up the static site](stand-up-the-static-site.md#4-create-and-attach-hfyappendindex): creating the function and attaching it to the default behavior, once per environment.
- [Run the tests](run-the-tests.md#run-only-the-cloudfront-function-tests): the function's tests, and the [dry runs](run-the-tests.md#12-dry-run-the-infrastructure-scripts-live-read-only-or-offline) of every infrastructure script.
- [Architecture](../reference/architecture.md#hfyappendindex): the function's rewrite and deny rules, and where it sits among the behaviors.
- [Edge and origin design](../explanation/edge-and-origin-design.md#why-the-cloudfront-function-also-denies): why the function denies, and why it is published by hand.
- [Cut over to authV2 and the private data gate](cut-over-to-the-private-data-gate.md): the gated behaviors this function relies on, and the order of a rollback.
- [Deploy a site change](deploy-a-site-change.md): how a file under `11ty/` reaches the bucket.
- [The release model](../explanation/release-model.md): why the function ships by hand, apart from the pipeline that deploys the site.
- [Private data and secrets](../reference/private-data-and-secrets.md): the placeholders, and what docs may cite.
