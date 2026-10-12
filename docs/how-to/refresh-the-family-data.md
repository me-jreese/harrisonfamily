# How to refresh the family data from Gramps

Use this page to publish a new export of the Gramps database to the site. You re-export the people, rebuild their family-tree diagrams and the search files, and sync the six data prefixes of `<site-bucket>`. The procedure leaves the static site and the photos that members attached to posts in place. Those photos live under `uploads/posts/<ulid>/` (`UPLOAD_PREFIX` in [`api/src/uploads.js`](../../api/src/uploads.js)), outside the data prefixes.

Family data never goes through Git or CI. The site deploy excludes the data prefixes and `uploads/` ([`ci.manifest.yaml`](../../ci.manifest.yaml); [Deploy a change to the static site](deploy-a-site-change.md)), so this procedure is the only thing that writes Gramps data to the bucket. The site, the data and the member photos share one bucket, and that sharing is why some steps below carry warnings. For the reasoning, see [The privacy model for family data](../explanation/family-data-privacy.md#one-bucket-for-the-site-and-the-data).

The ETL and search scripts live in `<project>/scripts/`, outside the repository. This page follows the scripts as they are, and their argument parsers are authoritative ([Private data and secrets](../reference/private-data-and-secrets.md#out-of-repo-tooling)). Older notes show flags the scripts now reject, such as `--gramps-db`, `--force`, `--skip-media` and `--bucket`, and a root-level `aws s3 sync --delete`, which you must never run (see [step 4](#4-sync-the-data)).

Placeholders: `<project>` is the directory that holds the checkout at `<project>/repo` (see the [codebase map](../reference/codebase-map.md)). `<site-bucket>`, `<distribution-id>` and `<site>` are the site bucket, its CloudFront distribution and the site's host name. `<gramps-id>` is a person's Gramps ID, and `<aws-profile>` is an AWS CLI profile.

## What the refresh writes

All local output goes to `<project>/workspace-local/harrisonfamily-frontend/`. That directory is outside the checkout and is never committed.

| Step | Script (under `<project>/`) | Writes |
| --- | --- | --- |
| 1. Export | `scripts/etl/export_person_data.py` | `person/<gramps-id>.json`; `family/`, `event/`, `note/` and `place/` records named by Gramps handle; media binaries and `media/<handle>.json`; the manifests `person/index.json`, `media/index.json` and `place/index.json` |
| 2. Trees | `scripts/etl/build_family_tree_media.py` | `media/tree_<gramps-id>.svg`. With `--attach`, also a `familyTreeMedia` field in each person file |
| 3. Search | `scripts/search/build_search_index.js` | `person/search-index.json`, and a new `person/index.json` in the form `{count, generatedAt, people}` |
| 4. Sync | `scripts/etl/sync_to_s3.py` | The `person/`, `event/`, `family/`, `note/`, `place/` and `media/` prefixes of `<site-bucket>`. Never `uploads/` |
| 5. Invalidate | AWS CLI | CloudFront cache entries for those prefixes |

The refresh does not touch the synthetic samples in the repository. If the shape of the data has changed and collaborators need new samples, see [Refresh the sanitized samples](refresh-the-sanitized-samples.md).

## Before you start

- **Gramps database.** You need a local Gramps SQLite database: the `sqlite.db` file in a Gramps family-tree directory. Close Gramps before you export. Both Python scripts take `--db`. Without it they use `HFY_GRAMPS_DB` if that file exists. Otherwise they use the `sqlite.db` in the most recently modified family-tree directory, looking in the macOS Gramps directory (`~/Library/Application Support/gramps/grampsdb`) first and then in `~/.local/share/gramps/grampsdb`, and finally a fixed legacy path in `common.py`. A mistyped `HFY_GRAMPS_DB` falls back silently, so confirm which file is used. Run this from `<project>` to print the path the scripts will use:

  ```sh
  export HFY_GRAMPS_DB=<path-to>/sqlite.db
  python3 -c 'import sys; sys.path.insert(0, "."); from scripts.etl.common import DEFAULT_DB; print(DEFAULT_DB)'
  ```

- **Python 3 with the `gramps` package.** The ETL was built against Gramps 6.0.5. This prints the installed version:

  ```sh
  python3 -c "from gramps.version import VERSION; print(VERSION)"
  ```

- **Graphviz.** `dot -V` prints a version.
- **Node.** `node --version` prints a version. The search script uses only Node's built-in modules.
- **AWS CLI credentials.** The credentials must be able to list `<site-bucket>`, put and delete objects under the six data prefixes, create invalidations on `<distribution-id>`, and read invalidation status (`cloudfront:GetInvalidation`) for the wait in step 5. The GitHub deploy role does not work here, because its trust policy accepts only `main` ([Architecture](../reference/architecture.md#harrisonfamily-github-roles)). If you use a named profile, add `--profile <aws-profile>` to each `sync_to_s3.py` and `aws` command.
- **Reviewed data.** The export treats anyone without a death event as living. It copies notes and media exactly as they are in Gramps, and it ignores Gramps's per-record private flag. Before you export, remove from Gramps anything that signed-in members must not see:
  - Confirm that no living person has a death event recorded. The export treats anyone with one as not living.
  - Remove identifiers, account numbers, medical details and anything else members should not read from notes.
  - Rename media files whose names reveal an address or a phone number.
  - Plan to read the exported `person/index.json` before you sync, and stop if it lists anyone you did not expect.
- **Working directory.** Run every command from `<project>`. Relative paths are resolved from the current directory. That includes `--output`, `HFY_PERSON_DIR` and any relative media paths stored in Gramps.

Record how many member photos are in the bucket now. You compare against this count in [Verify](#verify).

```sh
aws s3 ls s3://<site-bucket>/uploads/posts/ --recursive | wc -l
```

Then check the old upload prefix. Before release-1, the API presigned member photo uploads under `media/posts/<ulid>/`, inside the `media/` prefix that step 4 syncs with `--delete`. HFY-R58 moved new uploads to `uploads/posts/`, and nothing in the repository moves objects that were already under `media/posts/`.

```sh
aws s3 ls s3://<site-bucket>/media/posts/ --recursive | wc -l
```

If this prints `0`, step 4 is a single call. If it prints more, record the count: those objects exist only in S3, and step 4 must use [the two-call form](#if-photos-remain-under-mediaposts).

## Steps

### 1. Export from Gramps

Start with a dry run. It reads and transforms every person but writes nothing:

```sh
python3 scripts/etl/export_person_data.py --output workspace-local/harrisonfamily-frontend --dry-run
```

The dry run ends with `[SUCCESS] Dry run complete.`. Check that the `Processing <n> person(s).` line matches the number of people in Gramps. A missing module or a bad database path fails here, as it would in the real run.

Then export:

```sh
python3 scripts/etl/export_person_data.py --output workspace-local/harrisonfamily-frontend
```

The export takes these options:

- `--db <path-to>/sqlite.db` names the database.
- `--person-id <gramps-id>` exports only that person. You can repeat it.
- `--limit <n>` exports only the first `n` people.

The run ends with `[SUCCESS] ETL export complete.`. Before that it prints `created`, `updated` and `unchanged` counts for each record type, and a `Media binaries: copied=… reused=… missing=…` line. A file whose content has not changed is not rewritten.

- **Missing media.** The export copies each media file from the path stored in Gramps. A relative path is resolved from the current directory, not from the Gramps base media directory. When the file is not found, the record is kept with `missing: true` and a placeholder image, and a `[WARNING] Media binary missing` line is logged.
- **Partial exports are for testing.** `--person-id` and `--limit` rewrite `person/index.json` to list only the exported subset; step 3 rebuilds the full manifest. Each person file also embeds short records of that person's relatives. A change to one person reaches the relatives' files only when the relatives are exported too. Run a full export before you sync.
- **Nothing is deleted.** The export never removes files from the output directory. A person removed from Gramps keeps a local file, so step 4 keeps the record in the bucket. To take a record off the site, delete its local file before you sync.
- **Re-exporting drops the trees.** The exported record has no `familyTreeMedia` field. Every person file that had a tree attached is rewritten without one, so run step 2 again after every export.

### 2. Build the family trees

```sh
python3 scripts/etl/build_family_tree_media.py \
  --person-dir workspace-local/harrisonfamily-frontend/person \
  --media-dir workspace-local/harrisonfamily-frontend/media \
  --attach
```

Always pass both directories. Their defaults point at `<project>/workspace/harrisonfamily-frontend`, the sanitized samples. With the defaults, the script reads relationships from the real database and writes the diagrams into the sanitized workspace, which `export_workspace_samples.sh` copies into the repository.

- The script reads the same database as step 1. Pass the same `--db`, or rely on `HFY_GRAMPS_DB`.
- `--attach` adds `familyTreeMedia` to each person file. The person page shows a tree only when that field is present ([`11ty/js/person-page.js`](../../11ty/js/person-page.js)).
- `--only <gramps-id> …` renders a subset.

The script logs `Generated tree_<gramps-id>.svg` for each person and ends with `Rendered <n> SVG tree(s).`. That count should equal the number of people. A Graphviz failure for one person logs an `[ERROR]` line and the run moves on, so a lower count means some trees are missing.

### 3. Build the search manifests

```sh
HFY_PERSON_DIR=workspace-local/harrisonfamily-frontend/person node scripts/search/build_search_index.js
```

The script reads every person file in the directory. It writes `person/search-index.json` and replaces `person/index.json` with a manifest of all of them, which also repairs the partial manifest left by a `--person-id` or `--limit` export. It ends with `[Search Index] Search index build complete.`. Run it after every export.

Both search surfaces read these two files:

- The legacy search page and navbar: [`11ty/js/search-results.js`](../../11ty/js/search-results.js) and [`11ty/js/search-navbar.js`](../../11ty/js/search-navbar.js).
- The `searchV2` island: [`islands/src/lib/people-corpus.js`](../../islands/src/lib/people-corpus.js).

Nothing else rebuilds them from the real data. The Eleventy source's `npm run build` runs this same script without `HFY_PERSON_DIR`, so it rebuilds the sanitized samples instead.

### 4. Sync the data

> **Warning: never run `aws s3 sync --delete` against the bucket root.** Member photos under `uploads/posts/` exist only in S3. No copy exists in the repository, in the ETL output or on anyone's machine. A root-level sync from the ETL output would delete them along with the static site. Sync only through `sync_to_s3.py`: its `--prefix` accepts only the six data prefixes, so it never reaches `uploads/`.

Start with a dry run:

```sh
python3 scripts/etl/sync_to_s3.py --destination s3://<site-bucket> --dry-run
```

With no `--prefix`, the script syncs all six data prefixes. It syncs each one from `workspace-local/harrisonfamily-frontend/<prefix>`, its default `--source`, using `aws s3 sync --delete`. Always pass `--destination`, because the default is the production bucket.

Read the `(dryrun) delete:` lines. An object is deleted only when the local tree lacks it, so expect few or none. Many deletes mean the local tree is incomplete, for example a fresh output directory filled by a `--limit` export. Stop and fix the local tree. A `delete:` line for a key under `media/posts/` means photos remain under the old upload prefix. Stop and use the two-call form below.

Then run the same command without `--dry-run`.

The `person` sync excludes `index.html`, so the page shell that the site deploy owns at `person/index.html` is neither replaced nor deleted. Afterwards the script prints `person/ sync excluded index.html; re-upload the SPA shell separately.` You can ignore this message, because the shell was never touched.

#### If photos remain under `media/posts/`

Sync `media` in a call of its own with `--no-delete`. `--no-delete` applies to every prefix in the same call, so the five record prefixes keep their deletes in a separate call:

```sh
python3 scripts/etl/sync_to_s3.py --destination s3://<site-bucket> \
  --prefix person --prefix event --prefix family --prefix note --prefix place \
  --dry-run
python3 scripts/etl/sync_to_s3.py --destination s3://<site-bucket> --prefix media --no-delete --dry-run
```

Check the first dry run as above. The media dry run should list only `(dryrun) upload:` lines. A `delete:` line means `--no-delete` is missing, so stop. Otherwise run both commands without `--dry-run`.

With `--no-delete`, media that was removed from Gramps stays in the bucket. If you need to prune it, sync with the AWS CLI directly and exclude the `posts/` subtree. `aws s3 sync --delete` never deletes an excluded key:

```sh
aws s3 sync workspace-local/harrisonfamily-frontend/media s3://<site-bucket>/media \
  --delete --exclude 'posts/*' --exclude '.DS_Store' --exclude 'Thumbs.db' --dryrun
```

Check that no `(dryrun) delete:` line names a key under `media/posts/`. Only then run the command without `--dryrun`.

### 5. Invalidate the CloudFront cache

```sh
aws cloudfront create-invalidation --distribution-id <distribution-id> \
  --paths "/person/*" "/media/*" "/family/*" "/event/*" "/note/*" "/place/*"
aws cloudfront wait invalidation-completed --distribution-id <distribution-id> --id <invalidation-id>
```

`<invalidation-id>` is the `Invalidation.Id` in the output of the first command. `/person/*` also covers the `person/index.html` shell. The next request fetches the shell from the bucket again, which is harmless.

## Verify

1. **The data is fresh.**

   ```sh
   aws s3 ls s3://<site-bucket>/person/index.json
   aws s3 ls s3://<site-bucket>/person/search-index.json
   ```

   Both show a time from this refresh. Step 3 rewrites both files on every run, so their newer modification time makes every refresh upload them.
2. **Member photos are intact.**

   ```sh
   aws s3 ls s3://<site-bucket>/uploads/posts/ --recursive | wc -l
   ```

   The count is at least the one you recorded before you started. Members may have uploaded more in the meantime. `sync_to_s3.py` cannot reach `uploads/`, so a lower count means something else deleted photos, such as a root-level `aws s3 sync --delete`. Stop and find it. Those photos cannot be rebuilt from any local source. If you recorded a non-zero `media/posts/` count, count that prefix again too. It must not have dropped.
3. **The trees are in the bucket.** `aws s3 ls s3://<site-bucket>/media/tree_<gramps-id>.svg` lists a person you changed.
4. **The site shows the change.** Sign in at `https://<site>/family-login/` and open `https://<site>/person/?id=<gramps-id>`. The page shows the updated details and renders the family tree. Then open `https://<site>/search/` and search for the person's name. The person is listed. Both search surfaces read the same files. To check the island as well, preview it with `?hfy_flags=searchV2` ([Toggle a feature flag](toggle-a-feature-flag.md)). If the data requests fail with 403, see [Diagnose sign-in and API failures](diagnose-sign-in-and-api-failures.md).
5. **The checkout is clean.** `git status` in your checkout shows no changes from this procedure. Any change there means a script wrote into the repository. Find out why before you commit anything.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `ModuleNotFoundError: No module named 'gramps'` | The `python3` you ran has no `gramps` package | Install it into that interpreter, for example `pip3 install --user gramps==6.0.5` |
| `FileNotFoundError: Gramps database not found` | `--db` names a missing file, or no database was found | Pass the full path to `sqlite.db` |
| `Graphviz 'dot' binary not found` | Graphviz is not installed or not on `PATH` | Install Graphviz and check `dot -V` |
| Many `Media binary missing` warnings | Gramps stores relative media paths, which are resolved from the current directory | Convert the paths to absolute in Gramps (**Tools > Utilities > Media Manager**). Or run step 1 from the directory they are relative to, with the script and `--output` both given as absolute paths: `python3 <project>/scripts/etl/export_person_data.py --output <project>/workspace-local/harrisonfamily-frontend`. Then return to `<project>` for steps 2 to 5 |
| `[ERROR] No person files found in <dir>` | `--person-dir` names the wrong directory | Point it at `workspace-local/harrisonfamily-frontend/person` |
| A person page shows no tree | Step 1 ran after step 2, or step 2 ran without `--attach` or with the default directories | Repeat step 2, then steps 4 and 5 |
| A new person is missing from search | Step 3 was skipped or ran against the default directory, or the invalidation has not finished | Repeat step 3, then steps 4 and 5 |

## Related pages

- [The privacy model for family data](../explanation/family-data-privacy.md): living-person classification, the shared bucket and its three writers.
- [Architecture](../reference/architecture.md#site-bucket): the bucket prefixes and who writes each one.
- [Private data and secrets](../reference/private-data-and-secrets.md): where the real data lives and what never goes in the repository.
- [Codebase map](../reference/codebase-map.md): the scripts outside the repository and the sanitized sample directories.
- [Front end](../reference/front-end.md): the person page and both search surfaces.
- [Refresh the sanitized samples](refresh-the-sanitized-samples.md): update the synthetic samples in the repository when the shape of the data changes.
- [Deploy a change to the static site](deploy-a-site-change.md), [Toggle a feature flag](toggle-a-feature-flag.md), [Diagnose sign-in and API failures](diagnose-sign-in-and-api-failures.md).
