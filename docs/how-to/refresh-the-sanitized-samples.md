# How to refresh the sanitized samples

Use this page to update the synthetic samples that the repository carries in place of private files, so that collaborators see the current shape of the data and configuration without any real content. Do this when the shape changes, for example when the ETL adds a field. A family-data refresh does not need it ([Refresh the family data](refresh-the-family-data.md)), and neither does the site's Eleventy output in `11ty/` ([Refresh the Eleventy output](refresh-the-eleventy-output.md)). Both of those can still change the workspace that this procedure exports: every Eleventy build rewrites a sample, and a family-tree run with its default options adds diagrams drawn from the real family data. [Step 1](#1-bring-the-workspace-up-to-date) removes those files before each export.

You bring the workspace copies at `<project>/workspace/` up to date with the repository, edit the samples there, copy them into the checkout at `<project>/repo` with a script, and review the diff before you commit. The script replaces whole directories, so the first step and the review are what keep unrelated changes, reverted files and real data out of Git.

- What each sample mirrors: [Private data and secrets](../reference/private-data-and-secrets.md#in-repo-sanitized-samples).
- What the two helper scripts read and write: [Repository operations](../reference/repository-operations.md#workspace-helper-scripts).
- Why the repository holds samples and not data: [The privacy model for family data](../explanation/family-data-privacy.md).

> **Warning: the export replaces every sample directory wholesale.** [`export_workspace_samples.sh`](../../scripts/export_workspace_samples.sh) deletes `allowlist/`, `cloudfront/`, `etl-output/`, `gcloud/`, `harrisonfamily-frontend/` and `tests/login-flow/` in the repository, each one that exists in the workspace, and copies the workspace directory in its place. The workspace copy, not the repository, decides what is left after the export. The workspace copies must carry the current repository files, or the next export reverts them:
>
> - The pointer READMEs: [`allowlist/README.md`](../../allowlist/README.md), [`cloudfront/README.md`](../../cloudfront/README.md), [`etl-output/README.md`](../../etl-output/README.md), [`harrisonfamily-frontend/README.md`](../../harrisonfamily-frontend/README.md) and [`tests/login-flow/README.md`](../../tests/login-flow/README.md).
> - The sample [`cloudfront/distribution.json`](../../cloudfront/distribution.json), with the legacy `/api/*` behavior on the `api-gateway-hfy-check-allowed` origin and none of the behaviors that the `scripts/infra/` scripts add.
> - Everything else in [`tests/login-flow/`](../../tests/login-flow/), both specs included.
>
> A reverted `distribution.json` also breaks the offline infrastructure tests: [`scripts/infra/test/run.sh`](../../scripts/infra/test/run.sh) dry-runs `add-api-behavior.sh` and `add-data-gate-behaviors.sh` against it, and expects the `/api/check-allowed*` pin to stay on that origin and all seven gated patterns, `/uploads/*` included, to go to the default behavior's `s3-origin`. [Step 1](#1-bring-the-workspace-up-to-date) brings the workspace copies up to date.

Placeholders: `<project>` is the directory that holds the checkout at `<project>/repo`, and `<eleventy-source>` is the Eleventy project at `<project>/workspace/11ty-dev` (see the [codebase map](../reference/codebase-map.md)).

## Before you start

- **Use the checkout at `<project>/repo`.** Both scripts find `<project>` from their own location. The export writes to `<project>/repo` by path, whichever checkout runs it, and the sync script writes only under `<project>/workspace/`. Run the copies under `<project>/repo/scripts/`. A copy in another checkout, such as a Git worktree, resolves a different directory ([what each script does there](../reference/repository-operations.md#workspace-helper-scripts)).
- **Start from a clean tree.** `git -C <project>/repo status` shows no changes. Everything in the diff at step 5 then comes from this procedure, and the committed files that step 1 copies match the working tree.
- **Invented records only.** The data and allowlist samples hold synthetic values: invented names and dates, `example.com` addresses and placeholder IDs. Never copy a file from `<project>/workspace-local/`, or any real Gramps record, into `<project>/workspace/`. `coming-soon-index.html` is public page copy, not a data sample.
- **Expect generated files in the workspace.** Two tools write into `<project>/workspace/harrisonfamily-frontend/` by default, so the workspace can hold family-derived files even if nobody copied any in:
  - Every `npm run build` or `npm run dev` in `<eleventy-source>` starts with `build:search`, which runs `<project>/scripts/search/build_search_index.js`. Without `HFY_PERSON_DIR`, it reads every person record in `person/`, replaces the sample manifest `person/index.json` and writes `person/search-index.json` ([Refresh the Eleventy output](refresh-the-eleventy-output.md#before-you-start)).
  - `<project>/scripts/etl/build_family_tree_media.py`, run without `--person-dir` and `--media-dir`, reads relationships from the real Gramps database and writes a `tree_<gramps-id>.svg` diagram into `media/` for each person record in `person/`. With `--attach`, it also rewrites those person records ([Refresh the family data](refresh-the-family-data.md#2-build-the-family-trees)).

  Step 1 shows what they leave behind and removes it. They write it again on the next build or default run, so do step 1 before every export.

## Steps

### 1. Bring the workspace up to date

Compare each path that the export replaces with its repository copy:

```sh
cd <project>
for p in allowlist cloudfront etl-output gcloud harrisonfamily-frontend tests/login-flow; do
  diff -rq "workspace/$p" "repo/$p"
done
diff -q workspace/coming-soon-index.html repo/coming-soon-index.html
```

Read each line as what the next export would do:

- `Files workspace/… and repo/… differ`: the export replaces the repository file with the workspace one.
- `Only in repo/…`: the export deletes it. Under `tests/login-flow/`, `node_modules/`, `playwright-report/`, `test-results/` and `logs/` are untracked local files; the export deletes them too, and you reinstall the suite as in [Run the tests](run-the-tests.md#6-run-the-login-flow-live-production).
- `Only in workspace/…`: the export adds it to the repository. If it does not belong there, take it out of `<project>/workspace/`. A file that someone put there stays out once removed. A generated file, described below, comes back with the next build or tree run. The placeholders described below are the exception: leave them.
- `No such file or directory` for a workspace path: the export skips that path and leaves the repository copy alone.

**Generated files and real records.** Expect these lines from the tools named in [Before you start](#before-you-start), and from records that do not belong in the workspace:

- After any Eleventy build: `Files workspace/harrisonfamily-frontend/person/index.json and repo/harrisonfamily-frontend/person/index.json differ`, and `Only in workspace/harrisonfamily-frontend/person: search-index.json`.
- After a family-tree run with the default directories: `Only in workspace/harrisonfamily-frontend/media: tree_<gramps-id>.svg` lines. With `--attach`, also a `Files … differ` line for each sample person record that got a diagram.
- After an ETL export into the workspace: `Only in workspace/etl-output: …` lines, such as `person` or `family`. The repository's `etl-output/` holds only READMEs.
- Any `Only in workspace/harrisonfamily-frontend/<kind>: …` line for a record that is not one of the repository's samples. These records can be real family data.

Remove the generated files. Remove macOS `.DS_Store` files too: they also show as `Only in workspace`, and the export copies them into the repository, where only `.gitignore` keeps them out of a commit.

```sh
cd <project>/workspace
rm -f harrisonfamily-frontend/person/search-index.json
find harrisonfamily-frontend/media -name 'tree_*.svg' -delete
find allowlist cloudfront etl-output gcloud harrisonfamily-frontend tests/login-flow -name .DS_Store -delete
```

Then take out of `<project>/workspace/` every other `Only in workspace/etl-output` and `Only in workspace/harrisonfamily-frontend` entry that is not a sample you mean to add. If you still need a real record, keep it under `<project>/workspace-local/`, never in the workspace. The restore below puts back `person/index.json` and any sample person record that `--attach` rewrote.

**Placeholders.** `<project>/workspace/cloudfront/` also holds `original-config.json`, `updated-config.json` and `test.txt`, which the comparison lists as `Only in workspace/cloudfront`. They are placeholders that `sync_sanitized_assets.py --sync` ([step 3](#3-add-placeholders-for-new-private-files)) wrote for private files of the same names in `<project>/workspace-local/cloudfront/`. Each is a small JSON object marked `"placeholder": true`, `test.txt` included. They hold no data, but they are not samples, and the repository's `cloudfront/` holds only `README.md` and `distribution.json`. Leave them in the workspace: if you remove them, step 3 reports them as missing and `--sync` writes them again. Step 5 removes them from the repository after the export.

**Restore out-of-date files.** Copy the repository version over every workspace file that is out of date, that is every difference that is not an edit you mean to export. For the pointer READMEs, `cloudfront/`, `etl-output/`, the person samples and `tests/login-flow/`:

```sh
git -C <project>/repo archive HEAD \
  allowlist/README.md cloudfront etl-output harrisonfamily-frontend/README.md \
  harrisonfamily-frontend/person tests/login-flow \
  | tar -xf - -C <project>/workspace
```

The command writes the committed version of every tracked file in these paths over the workspace copy: the pointer READMEs, `distribution.json`, `etl-output/sample_bundle/README.md`, the sample person records with their manifest `person/index.json`, and the login-flow suite. It deletes nothing from the workspace and copies no untracked file. Leave out any path that holds an edit you mean to export. Every path the export replaces is tracked, so you can add any other out-of-date path to the same command. Changes made in the repository, such as new links in the pointer READMEs, reach the workspace only this way.

**Remove local test output.** The export also copies untracked files from the workspace. If `<project>/workspace/tests/login-flow/` holds `playwright-report/`, `test-results/` or `logs/` from a run there, delete them now. They can show family data, and the suite's `.gitignore` hides them from the diff at step 5.

Run the comparison again. Only these lines should remain:

- `Only in repo/` lines for untracked files, such as those under `tests/login-flow/`.
- The three `Only in workspace/cloudfront` placeholders.
- `No such file or directory` for a workspace path that does not exist. The export skips that path.
- Lines for workspace edits you already mean to export.

Any other line is a file that the export would copy, delete or overwrite. Fix it before you go on.

### 2. Edit the samples in the workspace

Make the changes under `<project>/workspace/`, not in the repository. Step 4 replaces the repository's sample directories with the workspace copies, so an edit made only in the repository is lost.

### 3. Add placeholders for new private files

Check that the script's three private inputs exist:

```sh
ls -d <project>/workspace-local/allowlist <project>/workspace-local/cloudfront <project>/workspace-local/coming-soon-index.html
```

The script skips a missing input without saying so, so a `No such file or directory` line here means that its OK line checks nothing for that input. When `<project>/workspace-local/` is missing altogether, the OK line checks nothing at all ([Repository operations](../reference/repository-operations.md#workspace-helper-scripts)). Then run:

```sh
python3 <project>/repo/scripts/sync_sanitized_assets.py
```

A clean run prints `[OK] Sanitized workspace mirrors workspace-local for tracked assets.`. Otherwise the script prints a `[MISSING]` line, such as `[MISSING] cloudfront: <file>`, for each private file that has no counterpart in `<project>/workspace/`, and ends with `[WARN] Found <n> missing sanitized files. Re-run with --sync to create placeholders.`. It checks only the allowlist directory, the CloudFront directory and the coming-soon page, not the family data.

To create placeholders for the missing files, run it again with `--sync`. It prints a `[SYNCED] Created sanitized placeholder at <path>` line for each. Then run it once more without arguments, and expect the OK line. It never copies real data and never overwrites an existing file. Its docstring mentions a `--check` flag, but the script rejects it.

A placeholder takes the private file's name. If a sample such as `workspace/cloudfront/distribution.json` were missing and `workspace-local/cloudfront/` held a file of that name, `--sync` would write a placeholder JSON there, and the export would put it in the repository in place of the sample. Step 1 rules this out by restoring the samples first.

### 4. Copy the workspace into the repository

```sh
<project>/repo/scripts/export_workspace_samples.sh
```

The script prints an `[OK] Copied …` line for each path it replaces. For each of these paths that exists in `<project>/workspace/`, it deletes the repository copy and copies the workspace version in its place:

- `allowlist/`, `cloudfront/`, `etl-output/`, `gcloud/` and `harrisonfamily-frontend/`
- `tests/login-flow/`
- `coming-soon-index.html`, which it overwrites

It replaces all of them, whichever ones you edited. Anything the repository held that the workspace lacks is deleted, pointer READMEs and untracked files included.

### 5. Review the diff and revert unrelated changes

```sh
cd <project>/repo
rm -f cloudfront/original-config.json cloudfront/updated-config.json cloudfront/test.txt
git add -A -- allowlist cloudfront etl-output gcloud harrisonfamily-frontend tests/login-flow coming-soon-index.html
git status
git diff --cached
```

The `rm` takes out the three placeholders that the export copied from `workspace/cloudfront/` (step 1). `git add -A` stages every change under the exported paths, new files included, so `git diff --cached` shows the full content of each new file. A plain `git diff` leaves out untracked files, and new files are the likeliest way for real data to get in.

- Keep only the changes you made in steps 2 and 3.
- Restore every other modified or deleted file with `git restore --staged --worktree -- <path>`, then make the same correction in `<project>/workspace/` (step 1), or the next export reverts it again.
- Remove every other new file that you did not add on purpose with `git rm -f -- <path>`, and take it out of `<project>/workspace/` too. A `search-index.json`, a `tree_*.svg` or a record that is not a sample means that step 1 missed a generated file.
- Check that `cloudfront/` holds only `README.md` and `distribution.json`, and that these two and `tests/login-flow/` are unchanged unless you meant to change them.
- Read the whole staged diff. It must contain no real names, dates or Gramps records, and every email address in the data and allowlist samples must be at `example.com`. The exception is `coming-soon-index.html`: it is public page copy, not a data sample, and its contact `mailto:` link is expected.

### 6. Commit

Commit the staged changes from `<project>/repo`.

## Verify

- `git -C <project>/repo show --stat HEAD` lists only the sample files you meant to change, with no `search-index.json`, `tree_*.svg` or other generated file.
- `git -C <project>/repo status` shows a clean tree, with no untracked file under `cloudfront/`.
- From `<project>/repo`, `scripts/infra/test/run.sh` ends with `scripts/infra tests: <n> passed, 0 failed`. It dry-runs the API and data-gate behavior scripts against `cloudfront/distribution.json` ([Run the tests](run-the-tests.md#5-run-the-infrastructure-script-tests-offline)).

## Related pages

- [Private data and secrets](../reference/private-data-and-secrets.md#in-repo-sanitized-samples): each sample and what it mirrors.
- [Repository operations](../reference/repository-operations.md#workspace-helper-scripts): the workspace helper scripts in detail.
- [The privacy model for family data](../explanation/family-data-privacy.md): why the repository carries samples.
- [Run the tests](run-the-tests.md): the offline infrastructure tests that read `cloudfront/distribution.json`, and the login flow suite in `tests/login-flow/`.
- [Refresh the family data](refresh-the-family-data.md): publish real data to the site. Its tree step writes into the workspace when run with the default directories.
- [Refresh the Eleventy output](refresh-the-eleventy-output.md): update `11ty/` from the Eleventy source, which this export does not touch. Its build rewrites the sample `person/index.json`.
