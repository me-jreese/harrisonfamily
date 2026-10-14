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
| 2b. Graph | `graph/bin/build-graph.mjs` (in the checkout) | `person/graph.json` and `media/faces/<gramps-id>-<sha8>.webp` |
| 3. Search | `scripts/search/build_search_index.js` | `person/search-index.json`, and a new `person/index.json` in the form `{count, generatedAt, people}` |
| 4. Sync | `scripts/etl/sync_to_s3.py` | The `person/`, `event/`, `family/`, `note/`, `place/` and `media/` prefixes of `<site-bucket>`. Never `uploads/` |
| 5. Invalidate | AWS CLI | CloudFront cache entries for those prefixes. They matter only while the private data gate is not attached |

The sync can also change how members are named on new posts and comments. For a member whose allowlist entry is a plain string, as [Manage family access](manage-family-access.md) recommends, the API takes the author label from the `displayName` in their person record, `person/<gramps-id>.json`. It reads that record straight from `<site-bucket>`, not through CloudFront or the gate. Each API container caches a label it found for 1 h, so a changed `displayName` reaches the author label of new posts and comments within an hour of the sync. Stored labels stay: posts and comments written before the change keep the label they were stored with, and nothing rewrites them ([API reference](../reference/api.md#author-label)).

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
- **Node.** `node --version` prints a version. The search script uses only Node's built-in modules. Step 2b needs Node 22 or later, the `sqlite3` command-line tool, and `npm ci` run once in `graph/` of the checkout (`sharp` and `d3-dag` live there).
- **A fresh copy of the Gramps tree, for step 2b only.** Close Gramps, then copy the whole tree directory to a scratch location outside the checkout. Step 2b reads that copy with `sqlite3 -readonly`. Never point it at the live database: the repository allows direct SQL only against a copy.
- **AWS CLI credentials.** The credentials must be able to list `<site-bucket>`, put and delete objects under the six data prefixes, create invalidations on `<distribution-id>`, and read invalidation status (`cloudfront:GetInvalidation`) for the wait in step 5. The two CloudFront permissions are needed only while the gate is not attached. The GitHub deploy role does not work here, because its trust policy accepts only `main` ([Architecture](../reference/architecture.md#harrisonfamily-github-roles)). If you use a named profile, add `--profile <aws-profile>` to each `sync_to_s3.py` and `aws` command.
- **Reviewed data.** The export treats anyone without a death event as living. It copies notes and media exactly as they are in Gramps, and it ignores Gramps's per-record private flag. Before you export, remove from Gramps anything that signed-in members must not see:
  - Confirm that no living person has a death event recorded. The export treats anyone with one as not living.
  - Remove identifiers, account numbers, medical details and anything else members should not read from notes.
  - Rename media files whose names reveal an address or a phone number.
  - Plan to read the exported `person/index.json` before you sync, and stop if it lists anyone you did not expect.
- **Working directory.** Run every command from `<project>`. Relative paths are resolved from the current directory. That includes `--output`, `HFY_PERSON_DIR` and any relative media paths stored in Gramps.
- **io's go-ahead, if you are an agent.** Get it in the session, or in the dispatch or plan that authorizes the refresh, before any real (non-dry-run) sync in step 4. `sync_to_s3.py` runs `aws s3 sync --delete` outside CI, and the single-call form also syncs `media` without `--no-delete`. A Cloudflare purge needs the go-ahead too. [`AGENTS.md`](../../AGENTS.md) lists these operations.

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

Always pass both directories. Their defaults point at `<project>/workspace/harrisonfamily-frontend`, the sanitized samples. With the defaults, the script reads relationships from the real database and writes diagrams drawn from real family data into the sanitized workspace.

- The script reads the same database as step 1. Pass the same `--db`, or rely on `HFY_GRAMPS_DB`.
- `--attach` adds `familyTreeMedia` to each person file. The person page shows a tree only when that field is present ([`11ty/js/person-page.js`](../../11ty/js/person-page.js)).
- `--only <gramps-id> …` renders a subset.

The script logs `Generated tree_<gramps-id>.svg` for each person and ends with `Rendered <n> SVG tree(s).`. That count should equal the number of people. A Graphviz failure for one person logs an `[ERROR]` line and the run moves on, so a lower count means some trees are missing.

### 2b. Build the family graph

The graph is the one static file, `person/graph.json`, that the family-tree page will read, plus the face crops it shows. Nothing reads it yet, so publishing it changes nothing a member sees. The builder is in the checkout, not in `<project>/scripts/`, and it runs after steps 1 and 2 because it crops faces from the media files that step 1 staged. Run it from `<project>` with a fresh copy of the Gramps tree (see [Before you start](#before-you-start)):

```sh
node <project>/repo/graph/bin/build-graph.mjs --from-gramps-copy <gramps-copy>/sqlite.db \
  --out workspace-local/harrisonfamily-frontend \
  --verify-against workspace-local/harrisonfamily-frontend/person
```

- `--out` writes `person/graph.json` (a temp file, then a rename) and `media/faces/` under the staging directory. Without `--out` the run is a dry run that projects and verifies and writes nothing, so start with that.
- `--verify-against` compares each person's `living` flag with the `isLiving` in the `person/<gramps-id>.json` that step 1 wrote. A mismatch stops the build (exit `5`) and writes nothing. It also fails (exit `2`) if no person file matches, so run step 1 first.
- The size ceiling is the builder's default, 150 KiB gzipped. Over it the build exits `3` and writes nothing. The design target is 25 KB gzipped at about 230 people ([`graph/README.md`](../../graph/README.md)), so the dry run's summary is the check: note the gzipped size and the number of people, and record both on the HFY record. If the size is near 25 KB, add `--max-gzip-bytes 25600` to hold that target on later runs. This flag is an addition to the design's reference command, there to hold the target, not a requirement. Do not set it below what your tree needs.
- The build uses the offline gazetteer when `$HFY_GAZETTEER_DIR` holds one ([`graph/README.md`](../../graph/README.md#geocoding)). Without it, the build continues with Gramps coordinates only. It never touches the network.
- The run writes a local report to `<project>/workspace-local/graph-build-report.json`. The report names Gramps IDs, so keep it local: it sits outside the synced staging directory.
- The exit codes are in the [graph README](../../graph/README.md). Exit `4` means the privacy check refused the graph, `6` means Gramps is open on the copy.

Then check the staged file again on its own, before anything is synced:

```sh
node <project>/repo/graph/bin/build-graph.mjs --verify workspace-local/harrisonfamily-frontend/person/graph.json \
  --verify-against workspace-local/harrisonfamily-frontend/person
```

It must exit `0`. Stop on any other code: the file is not syncable. `sync_to_s3.py` needs no change, because step 4 already syncs `person/` and `media/`, and the site deploy already excludes both ([`ci.manifest.yaml`](../../ci.manifest.yaml)). Step 3 globs the person files, and `graph.json` sits in the same directory, so after step 3 run the check below before step 4. Step 4's dry run should show `person/graph.json` and the files under `media/faces/` as the only new uploads beyond your changes.

Check that step 3 left the graph out of both search files (run it after step 3, before step 4). Both counts must be `0`. Record the result on the HFY record under the HFY-R16 prefix:

```sh
grep -ciE 'graph\.json|"graph"' workspace-local/harrisonfamily-frontend/person/index.json workspace-local/harrisonfamily-frontend/person/search-index.json
```

Any other count means `graph.json` was indexed as a person: stop, and do not sync.

Repeat step 2b after every export, because a new export changes who is living and which media exist.

### 3. Build the search manifests

```sh
HFY_PERSON_DIR=workspace-local/harrisonfamily-frontend/person node scripts/search/build_search_index.js
```

The script reads every person file in the directory. It writes `person/search-index.json` and replaces `person/index.json` with a manifest of all of them, which also repairs the partial manifest left by a `--person-id` or `--limit` export. It ends with `[Search Index] Search index build complete.`. Run it after every export.

Both search surfaces read these two files:

- The legacy search page and navbar: [`11ty/js/search-results.js`](../../11ty/js/search-results.js) and [`11ty/js/search-navbar.js`](../../11ty/js/search-navbar.js). They still ship with the site. When `searchV2` is on, they stop loading data only once the island has mounted, so they keep working if it fails to mount.
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

Whether this step matters depends on the private data gate. Check whether it answers for the data paths, from a shell with no cookies:

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://<site>/person/index.json
```

The production cutover attached the gate on 2026-10-12 (HFY-TSK-069, HFY-R67), so expect `401` from production unless the gate has been removed since.

- **`401`: the gate is attached.** Its behaviors for the six data prefixes, `/person/*.json`, `/family/*`, `/event/*`, `/note/*`, `/place/*` and `/media/*`, use the CachingDisabled cache policy ([`add-data-gate-behaviors.sh`](../../scripts/infra/add-data-gate-behaviors.sh)). CloudFront keeps no copy of the data, and the next request reads the new files from the bucket, so the invalidation does not matter for them. You can skip it. Running it is harmless.
- **`200`: the gate is not attached,** for example in a new environment or after a rollback with `add-data-gate-behaviors.sh --remove`. The default behavior serves the data paths to anyone and caches them, so invalidate them:

  ```sh
  aws cloudfront create-invalidation --distribution-id <distribution-id> \
    --paths "/person/*" "/media/*" "/family/*" "/event/*" "/note/*" "/place/*"
  aws cloudfront wait invalidation-completed --distribution-id <distribution-id> --id <invalidation-id>
  ```

  `<invalidation-id>` is the `Invalidation.Id` in the output of the first command. `/person/*` also covers the `person/index.html` shell, which is never gated. The next request fetches the shell from the bucket again, which is harmless.
- **`404`: the gate is not attached, and `HFYAppendIndex` runs its default-deny code.** That CloudFront Function, on the default behavior, refuses the data paths to everyone, members included, so nobody can read the refreshed data. The refresh did not cause this. Run the invalidation above anyway: if the fix is to roll the function back rather than attach the gate, the default behavior serves the data again, from its cache. Then follow [Find your starting point](cut-over-to-the-private-data-gate.md#find-your-starting-point).

The CloudFront invalidation does not reach Cloudflare, which proxies `<site>` in front of CloudFront and caches images, SVG and PDF files by extension. Every response from the gate's behaviors carries `Cache-Control: private, no-store`, so Cloudflare stores no copy of them. A stale copy can come only from a time when the gate was not attached: Cloudflare then caches `/media/` files, such as family-tree diagrams and photos, and serves them until their TTL ends. If a changed tree or photo still shows the old version, purge the data prefixes in Cloudflare, with io's go-ahead, as in [Cut over to authV2 and the private data gate](cut-over-to-the-private-data-gate.md#4-optional-purge-cloudflare).

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
4. **The site shows the change.** First check which sign-in and which search page the site serves:

   ```sh
   curl -s https://<site>/_data/flags.json | jq '{authV2, searchV2}'
   ```

   If `authV2` is `true`, sign in at `https://<site>/auth/login`, in a window with no preview override, such as a private window. If it is `false`, the site runs the legacy client, and you sign in with Google at `https://<site>/family-login/` instead. If `authV2` is `false` while step 5 printed `401`, members are locked out of the family data: go to [Find your starting point](cut-over-to-the-private-data-gate.md#find-your-starting-point).

   Open `https://<site>/person/?id=<gramps-id>`. The page shows the updated details and renders the family tree. Then open `https://<site>/search/` and search for the person's name. The person is listed. Both search surfaces read the same two files. If `searchV2` is `true`, `/search/` shows the island. To check the legacy page as well, open `https://<site>/search/?hfy_flags=-searchV2` ([Force a flag off in one tab](toggle-a-feature-flag.md#force-a-flag-off-in-one-tab)). If it is `false`, preview the island with `?hfy_flags=searchV2` instead ([Turn a flag on in one browser tab](toggle-a-feature-flag.md#turn-a-flag-on-in-one-browser-tab)). Either way, clear the override afterwards with `?hfy_flags=`.

   With the gate attached, a refused data request is a `401 {"error":"unauthenticated"}` from the gate, or a `302` to `/auth/login?returnTo=<path>` for a page navigation. The client refreshes the session and retries once before it sends you to sign in. If you are refused while signed in, see [Diagnose sign-in and API failures](diagnose-sign-in-and-api-failures.md) and the table in [Cut over to authV2 and the private data gate](cut-over-to-the-private-data-gate.md#if-something-fails).
5. **The graph is published, and private.** First verify the copy in the bucket, then probe it from outside.

   ```sh
   scratch=$(mktemp -d); trap 'rm -rf "$scratch"' EXIT
   aws s3 cp s3://<site-bucket>/person/graph.json "$scratch/graph.json" \
     && node <project>/repo/graph/bin/build-graph.mjs --verify "$scratch/graph.json"
   ```

   The trap removes the private copy when the shell exits, even if a step fails.

   It must exit `0`, as it did on the staged file. Then probe the live site from a shell with no cookies. These probes apply with the data gate attached. If it is not attached, the site is ungated: expect `200` on the plain probe, and go to [Find your starting point](cut-over-to-the-private-data-gate.md#find-your-starting-point) before you go on.

   ```sh
   curl -sS -o /dev/null -D - https://<site>/person/graph.json | grep -iE '^(HTTP|cache-control)'
   curl -sS -o /dev/null -w '%{http_code}\n' 'https://<site>/person/graph.json?x=1' https://<site>/Person/graph.json
   curl -sS -o /dev/null -w '%{http_code}\n' https://<site>/tree/
   curl -sS https://<site>/tree/ | grep -c schemaVersion
   ```

   - Signed out, `/person/graph.json` returns `401` with `cache-control: private, no-store`. Any `200` means the data is public: stop, and go to [Find your starting point](cut-over-to-the-private-data-gate.md#find-your-starting-point).
   - Signed out, the two variants (a query string, a different case) must not print `200`. A `200` is a gate bypass: stop, as above.
   - Signed out, `/tree/` returns `200` or `404`, and the last probe, which counts `schemaVersion` in its body, prints `0` (no graph content). It is `404` until the tree page ships.
   - Signed in, a fetch of `/person/graph.json` returns `200` with `schemaVersion` `1`. In a browser window signed in to the site, run `fetch('/person/graph.json', {credentials: 'include'}).then(async r => [r.status, (await r.json()).schemaVersion])` in the console. It prints `[200, 1]`. Do not save the response or paste any of it anywhere.
6. **The checkout is clean.** `git status` in your checkout shows no changes from this procedure. Any change there means a script wrote into the repository. Find out why before you commit anything.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `ModuleNotFoundError: No module named 'gramps'` | The `python3` you ran has no `gramps` package | Install it into that interpreter, for example `pip3 install --user gramps==6.0.5` |
| `FileNotFoundError: Gramps database not found` | `--db` names a missing file, or no database was found | Pass the full path to `sqlite.db` |
| `Graphviz 'dot' binary not found` | Graphviz is not installed or not on `PATH` | Install Graphviz and check `dot -V` |
| Many `Media binary missing` warnings | Gramps stores relative media paths, which are resolved from the current directory | Convert the paths to absolute in Gramps (**Tools > Utilities > Media Manager**). Or run step 1 from the directory they are relative to, with the script and `--output` both given as absolute paths: `python3 <project>/scripts/etl/export_person_data.py --output <project>/workspace-local/harrisonfamily-frontend`. Then return to `<project>` for steps 2 to 5 |
| `[ERROR] No person files found in <dir>` | `--person-dir` names the wrong directory | Point it at `workspace-local/harrisonfamily-frontend/person` |
| A person page shows no tree | Step 1 ran after step 2, or step 2 ran without `--attach` or with the default directories | Repeat step 2, then steps 4 and 5 |
| `build-graph` exits `5` (`LIVING_MISMATCH`) | The copy of the tree differs from the one step 1 exported, or step 1 is older than the copy | Copy the tree again, rerun step 1, then step 2b |
| `build-graph` exits `3` (`SIZE_BUDGET`) | The graph is over the size ceiling (150 KiB by default, or the `--max-gzip-bytes` you passed) | Do not raise the number to get past it. The budget is a design decision: raise it on the HFY record |
| `build-graph` exits `4` (`PRIVACY_VIOLATION`) | The privacy check refused the graph. The message names JSON pointers and rules, never values | Fix the record in Gramps, copy the tree and rerun. Never sync a graph that failed |
| A new person is missing from search | Step 3 was skipped or ran against the default directory, or, without the gate, the invalidation has not finished | Repeat step 3, then steps 4 and 5 |
| A changed tree or photo still shows the old version | Cloudflare serves a copy of the `/media/` file that it cached while the gate was not attached. Neither the gate nor the CloudFront invalidation removes it | With io's go-ahead, purge the data prefixes in Cloudflare, as in [Cut over to authV2 and the private data gate](cut-over-to-the-private-data-gate.md#4-optional-purge-cloudflare) |
| New posts or comments still carry a member's old name | Each API container caches a found label for 1 h. Or the member's allowlist entry carries its own usable label, which the API prefers to `displayName`. Older posts and comments keep the label they were stored with | Wait an hour for new posts and comments. If the entry carries a label, use the plain string form that [Manage family access](manage-family-access.md#1-edit-the-source-files) asks for. Stored labels do not change |

## Related pages

- [The privacy model for family data](../explanation/family-data-privacy.md): living-person classification, the shared bucket and its three writers.
- [Architecture](../reference/architecture.md#site-bucket): the bucket prefixes and who writes each one.
- [The family graph builder](../../graph/README.md): the flags, exit codes and what the file holds.
- [Private data and secrets](../reference/private-data-and-secrets.md): where the real data lives and what never goes in the repository.
- [Codebase map](../reference/codebase-map.md): the scripts outside the repository and the sanitized sample directories.
- [Front end](../reference/front-end.md): the person page and both search surfaces.
- [Cut over to authV2 and the private data gate](cut-over-to-the-private-data-gate.md): checking whether the gate is attached, rolling it back, and purging Cloudflare's copies of the data paths.
- [API reference](../reference/api.md#author-label): how the author label is chosen and how long it is cached.
- [Refresh the sanitized samples](refresh-the-sanitized-samples.md): update the synthetic samples in the repository when the shape of the data changes.
- [Deploy a change to the static site](deploy-a-site-change.md), [Toggle a feature flag](toggle-a-feature-flag.md), [Diagnose sign-in and API failures](diagnose-sign-in-and-api-failures.md).
