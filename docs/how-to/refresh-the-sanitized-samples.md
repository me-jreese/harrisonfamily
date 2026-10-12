# How to refresh the sanitized samples

Use this page to update the synthetic samples that the repository carries in place of private files, so that collaborators see the current shape of the data and configuration without any real content. Do this when the shape changes, for example when the ETL adds a field. A family-data refresh does not need it ([Refresh the family data](refresh-the-family-data.md)).

You bring the workspace copies at `<project>/workspace/` up to date with the repository, edit the samples there, copy them into the checkout at `<project>/repo` with a script, and review the diff before you commit. The script replaces whole directories, so the first step and the review are what keep unrelated changes, reverted files and real data out of Git.

- What each sample mirrors: [Private data and secrets](../reference/private-data-and-secrets.md#in-repo-sanitized-samples).
- What the two helper scripts read and write: [Repository operations](../reference/repository-operations.md#workspace-helper-scripts).
- Why the repository holds samples and not data: [The privacy model for family data](../explanation/family-data-privacy.md).

> **Warning: the export replaces `cloudfront/` and `tests/login-flow/` wholesale.** [`export_workspace_samples.sh`](../../scripts/export_workspace_samples.sh) deletes each of these directories in the repository and copies the workspace directory in its place, so the workspace copy, not the repository, decides what is left after the export. The workspace copies must carry the current repository files: the pointer README [`cloudfront/README.md`](../../cloudfront/README.md), [`cloudfront/distribution.json`](../../cloudfront/distribution.json) as release 2 ships it, with the legacy `/api/*` behavior on the `api-gateway-hfy-check-allowed` origin, and everything in [`tests/login-flow/`](../../tests/login-flow/), its pointer README and both specs included. Otherwise the next export reverts them. A reverted `distribution.json` also breaks the offline infrastructure tests: [`scripts/infra/test/run.sh`](../../scripts/infra/test/run.sh) dry-runs the behavior scripts against it and expects the `/api/check-allowed*` pin to stay on that origin. [Step 1](#1-bring-the-workspace-up-to-date) brings the workspace copies up to date.

Placeholders: `<project>` is the directory that holds the checkout at `<project>/repo` (see the [codebase map](../reference/codebase-map.md)).

## Before you start

- **Use the checkout at `<project>/repo`.** Both scripts find `<project>` from their own location and write into `<project>/workspace` and `<project>/repo`, never into the checkout that runs them. Run the copies under `<project>/repo/scripts/`. A copy in another checkout, such as a Git worktree, resolves a different directory ([what each script does there](../reference/repository-operations.md#workspace-helper-scripts)).
- **Start from a clean tree.** `git -C <project>/repo status` shows no changes. Everything in the diff at step 5 then comes from this procedure, and the committed files that step 1 copies match the working tree.
- **Invented records only.** Samples hold synthetic values: invented names and dates, `example.com` addresses and placeholder IDs. Never copy a file from `<project>/workspace-local/`, or any real Gramps record, into `<project>/workspace/`.

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
- `Only in workspace/…`: the export adds it to the repository. If it does not belong there, move it out of `<project>/workspace/`, or every export adds it again.
- `No such file or directory` for a workspace path: the export skips that path and leaves the repository copy alone.

Copy the repository version over every workspace file that is out of date, that is every difference that is not an edit you mean to export. For `cloudfront/` and `tests/login-flow/`:

```sh
git -C <project>/repo archive HEAD cloudfront tests/login-flow | tar -xf - -C <project>/workspace
```

The command writes the committed version of every tracked file in the two directories over the workspace copy, the pointer READMEs and `distribution.json` included. It deletes nothing from the workspace and copies no untracked file. Every path the export replaces is tracked, so you can add any other out-of-date path to the same command.

The export also copies untracked files from the workspace. If `<project>/workspace/tests/login-flow/` holds `playwright-report/`, `test-results/` or `logs/` from a run there, delete them now. They can show family data, and the repository's `.gitignore` hides them from the diff at step 5.

Run the comparison again. Only the `Only in repo/` lines for untracked files should remain.

### 2. Edit the samples in the workspace

Make the changes under `<project>/workspace/`, not in the repository. Step 4 replaces the repository's sample directories with the workspace copies, so an edit made only in the repository is lost.

### 3. Add placeholders for new private files

```sh
python3 <project>/repo/scripts/sync_sanitized_assets.py
```

Without arguments, the script prints a `[MISSING]` line for each private file that has no counterpart in `<project>/workspace/`. It checks only the allowlist directory, the CloudFront directory and the coming-soon page, not the family data. To create placeholders for the missing files, run it again with `--sync`. It never copies real data and never overwrites an existing file. Its docstring mentions a `--check` flag, but the script rejects it.

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
git status
git diff
```

- Keep only the changes you made in steps 2 and 3.
- Restore every other modified or deleted file with `git restore -- <path>`, then make the same correction in `<project>/workspace/` (step 1), or the next export reverts it again. Remove any new file under the replaced paths that you did not add on purpose.
- Check that `cloudfront/README.md`, `cloudfront/distribution.json` and `tests/login-flow/` are unchanged unless you meant to change them.
- Read what remains. It must contain no real names, dates, email addresses or Gramps records. Every email address must be at `example.com`.

### 6. Commit

Commit the remaining changes from `<project>/repo`.

## Verify

- `git -C <project>/repo show --stat HEAD` lists only the sample files you meant to change.
- `git -C <project>/repo status` shows a clean tree.
- From `<project>/repo`, `scripts/infra/test/run.sh` ends with `0 failed`. It dry-runs the behavior scripts against `cloudfront/distribution.json` ([Run the tests](run-the-tests.md#5-run-the-infrastructure-script-tests-offline)).

## Related pages

- [Private data and secrets](../reference/private-data-and-secrets.md#in-repo-sanitized-samples): each sample and what it mirrors.
- [Repository operations](../reference/repository-operations.md#workspace-helper-scripts): the workspace helper scripts in detail.
- [The privacy model for family data](../explanation/family-data-privacy.md): why the repository carries samples.
- [Run the tests](run-the-tests.md): the offline infrastructure tests that read `cloudfront/distribution.json`, and the login flow suite in `tests/login-flow/`.
- [Refresh the family data](refresh-the-family-data.md): publish real data to the site.
