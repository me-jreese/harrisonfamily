# How to refresh the sanitized samples

Use this page to update the synthetic samples that the repository carries in place of private files, so that collaborators see the current shape of the data and configuration without any real content. Do this when the shape changes, for example when the ETL adds a field. A family-data refresh does not need it ([Refresh the family data](refresh-the-family-data.md)).

You edit the samples in `<project>/workspace/`, copy them into the checkout at `<project>/repo` with a script, and review the diff before you commit. The script replaces whole directories, so the review is the step that keeps unrelated changes and real data out of Git.

- What each sample mirrors: [Private data and secrets](../reference/private-data-and-secrets.md#in-repo-sanitized-samples).
- What the two helper scripts read and write: [Repository operations](../reference/repository-operations.md#workspace-helper-scripts).
- Why the repository holds samples and not data: [The privacy model for family data](../explanation/family-data-privacy.md).

Placeholders: `<project>` is the directory that holds the checkout at `<project>/repo` (see the [codebase map](../reference/codebase-map.md)).

## Before you start

- **Use the checkout at `<project>/repo`.** Both scripts find `<project>` from their own location and write into `<project>/workspace` and `<project>/repo`, never into the checkout that runs them. Run the copies under `<project>/repo/scripts/`. A copy in another checkout, such as a Git worktree, resolves a different directory ([what each script does there](../reference/repository-operations.md#workspace-helper-scripts)).
- **Start from a clean tree.** `git -C <project>/repo status` shows no changes. Everything in the diff at step 4 then comes from this procedure.
- **Invented records only.** Samples hold synthetic values: invented names and dates, `example.com` addresses and placeholder IDs. Never copy a file from `<project>/workspace-local/`, or any real Gramps record, into `<project>/workspace/`.

## Steps

### 1. Edit the samples in the workspace

Make the changes under `<project>/workspace/`, not in the repository. Step 3 replaces the repository's sample directories with the workspace copies, so an edit made only in the repository is lost.

### 2. Add placeholders for new private files

```sh
python3 <project>/repo/scripts/sync_sanitized_assets.py
```

Without arguments, the script prints a `[MISSING]` line for each private file that has no counterpart in `<project>/workspace/`. It checks only the allowlist directory, the CloudFront directory and the coming-soon page, not the family data. To create placeholders for the missing files, run it again with `--sync`. It never copies real data and never overwrites an existing file. Its docstring mentions a `--check` flag, but the script rejects it.

### 3. Copy the workspace into the repository

```sh
<project>/repo/scripts/export_workspace_samples.sh
```

The script prints an `[OK] Copied …` line for each path it replaces. For each of these paths that exists in `<project>/workspace/`, it deletes the repository copy and copies the workspace version in its place:

- `allowlist/`, `cloudfront/`, `etl-output/`, `gcloud/` and `harrisonfamily-frontend/`
- `tests/login-flow/`
- `coming-soon-index.html`, which it overwrites

It replaces all of them, whichever ones you edited. Anything the repository held that the workspace lacks is deleted, READMEs included.

### 4. Review the diff and revert unrelated changes

```sh
cd <project>/repo
git status
git diff
```

- Keep only the changes you made in steps 1 and 2.
- Restore every other modified or deleted file with `git restore -- <path>`. Remove any new file under the replaced paths that you did not add on purpose.
- Read what remains. It must contain no real names, dates, email addresses or Gramps records. Every email address must be at `example.com`.

### 5. Commit

Commit the remaining changes from `<project>/repo`.

## Verify

- `git -C <project>/repo show --stat HEAD` lists only the sample files you meant to change.
- `git -C <project>/repo status` shows a clean tree.

## Related pages

- [Private data and secrets](../reference/private-data-and-secrets.md#in-repo-sanitized-samples): each sample and what it mirrors.
- [Repository operations](../reference/repository-operations.md#workspace-helper-scripts): the workspace helper scripts in detail.
- [The privacy model for family data](../explanation/family-data-privacy.md): why the repository carries samples.
- [Refresh the family data](refresh-the-family-data.md): publish real data to the site.
