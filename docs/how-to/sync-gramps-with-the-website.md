# How to sync Gramps with the website

Use this page to run the sync day to day (install, first time, daily use, restore, upgrade, recovery and removal), to move changes between the Gramps tree on the desktop and the family site, to cut the site over from the legacy publish to the cloud store, and to roll that cutover back. The desktop addon pushes the tree to the cloud store. The render Lambda `hfy-sync-render` renders the store into the site's data files. Nothing else writes those files once the cutover is done (HFY-PLN-002; BRD2 D2-05).

The legacy publish, the ETL scripts and `sync_to_s3.py`, is kept at the end of this page as [the legacy procedure](#the-legacy-etl-publish-retired-at-the-cutover). It applies only before the cutover. After the cutover the bucket policy refuses it.

Placeholders: `<site-bucket>` is the site bucket, `<app-stack>` the app stack, `<tree name>` the name in Gramps' Family Trees manager, and `<account-id>` your AWS account. Use `--profile <aws-profile>` on each `aws` command if you use a named profile.

## How the sync works

| Piece | What it does | Where to read more |
| --- | --- | --- |
| The `hfy_sync` addon | Reads the tree, shows what differs, and pushes or pulls changes through the sync API | [Install the Gramps sync addon](install-the-gramps-sync-addon.md) |
| The cloud store | The record log in the app table. Only the sync API writes it | [Operate the sync store](operate-the-sync-store.md) |
| `hfy-sync-render` | Renders `person/`, `family/`, `event/`, `note/`, `place/` and `media/*.json` from the store, and writes only the keys that changed. Modes `off`, `shadow` and `live` | [The render Lambda](../reference/sync-render.md) |
| The write guard | A bucket-policy deny that leaves the renderers and break-glass as the only writers of those keys | [Cut over](#cut-over-to-the-cloud-store) |

## Sync day to day

This is the operator runbook (sync design section 19, as amended by BRD2 section 11.1). It is for io on the Mac that holds the Gramps tree. The addon pages hold the detail: [Install the Gramps sync addon](install-the-gramps-sync-addon.md) for each command and its exit codes, [Operate the sync store](operate-the-sync-store.md) for the operator script, and [Sync errors and exit codes](../reference/sync-errors.md) for every code. [Where the family data lives](../explanation/family-data-source-of-truth.md) explains why the tree and the cloud store both hold it.

**Rules that apply to every step below.**

- **Every production use of `api/scripts/sync-admin.mjs` (and of `api/scripts/expunge.mjs`) needs io's go-ahead in the session** (AGENTS.md; review DL-28). An agent runs a dry run freely and an `--apply` only after io's go-ahead is on the record, written into the worklog with the dry-run output. The seed approval covers setting `writes_enabled` for the seed and nothing else.
- **A step that writes app-table items says so.** The desktop's own push writes the store through the sync API, with io signed in, and is not a script. Every `sync-admin.mjs` command other than `render --dry-run` and the dry runs writes app-table items (or, for `render`, site files), and each step below says so.
- **Never paste previews, backups or logs other than `status.json` into an agent session.** A preview holds pointers and projected values, a backup is the whole tree, and a log can name records. `status.json` holds counts and codes only. If an agent needs to help, read it the `status.json` and the exit code.

### Install or update the addon

```sh
cd ~/harrisonfamily && gramps/scripts/install-addon.sh
```

Restart Gramps. **Tools > Family Tree Processing > Website sync...** appears. Run it again after every update of the addon ([Install the Gramps sync addon](install-the-gramps-sync-addon.md#1-install-or-update-the-addon)).

### The first time (the migration)

This is runbook 19.2. It writes the cloud store: the Apply at the end pushes the whole tree as the seed.

1. **Wait for the orchestrator's message that sync is enabled and writes are on** (the G-seed message). Until it arrives, do not Apply. It confirms that `writes_enabled` is on, which io's G-seed approval covers and which is a `sync-admin.mjs` write the orchestrator makes after io's go-ahead.
2. **Close every Gramps edit window, and do not edit the tree until Apply has finished.** The window refuses to apply while an editor is open (D45), and an edit made during the run is a stale-hash re-plan (D18).
3. Mark the Dropbox media folders **Available offline**. About half the record media are online-only, and a placeholder file cannot be uploaded (D29).
4. Open the tree. **Website sync... > Sign in...** (a passkey), then **Bind this tree**.
5. **Check** (a dry run). Read the **To the website** list: everything is a create. Held items name the rule and the characters to edit in Gramps.
6. **Apply.** It opens a push session, uploads the blobs and completes the session. This writes app-table items.
7. The orchestrator runs the shadow render and sends the parity report. Approve the cutover only after you have read it ([Cut over to the cloud store](#cut-over-to-the-cloud-store)).

### Daily use

This is runbook 19.3. Open Gramps, then **Website sync... > Check for changes**, review, then **Apply**. Apply writes app-table items for what you push.

Headless, with Gramps closed:

```sh
gramps/bin/hfy-sync check --tree "<tree name>"            # the line it prints names the run id
gramps/bin/hfy-sync sync --tree "<tree name>" --yes --plan <run_id>
```

`--plan <run_id>` applies only the plan you reviewed. When the new plan's hash differs from that preview, the run applies nothing and exits `10`; run `check` again and review the new preview. The exit codes and the details in `status.json` are in [Sync errors and exit codes](../reference/sync-errors.md#exit-codes). The site shows the change after the next render, usually within a minute. If it does not, check the render state with `node api/scripts/sync-admin.mjs render --dry-run` ([Operate the sync store](operate-the-sync-store.md#force-a-render)).

### Conflicts and held items

Runbook 19.4. Open the Website sync window and pick per field. Held items name the rule and the characters to edit in Gramps. The command line never decides a conflict: it parks it and exits `20`, and the path stays pinned until you decide it in the window.

### Restore from a backup

Runbook 19.5 is the addon's `restore` action, not a hand copy. Quit Gramps, then:

```sh
gramps/bin/hfy-sync restore <backup name> --tree "<tree name>"
```

It checks the sha256 of the backup and its sidecar, moves the journal, WAL, SHM and lock aside, runs `PRAGMA integrity_check`, and restores the matching sidecar snapshot, so the next sync does not push the old values back as your edits. The Gramps window's **Restore backup...** refuses while the tree is open and shows the same command. After a recovery the window's **Rebase after a recovery...** runs the same re-base. Details: [Restore from a backup](install-the-gramps-sync-addon.md#8-restore-from-a-backup). The cloud is unaffected and restore writes nothing to it; the check after the restore shows what the website still has to give you again, and a push that would revert a website change is labelled and needs confirmation (D47).

### Upgrading Gramps

Runbook 19.6. Do not upgrade Gramps until the addon's release notes list the new version. Then upgrade and run `gramps/bin/hfy-sync status --tree "<tree name>"`. A newer Gramps or schema stops the sync with exit `78` (D04); it never corrupts anything.

### Pause everything

Runbook 19.7. **This writes app-table items and needs io's go-ahead.** `pause --all` sets `writes_enabled` to `false`, so every writer of the store is refused with `503 sync_paused`; `resume --all` reverses it. Use the product-lead credentials, a dry run first ([Pause and resume the store](operate-the-sync-store.md#pause-and-resume-the-store)). `render --full` re-renders, and `render --allow-mass-delete` and `--prune-foreign` follow a reviewed dry run; each of them writes site files and needs io's go-ahead.

### When the cloud store is damaged

Runbook 19.8 is store-scoped (`sync-store-recovery`), and it **writes app-table items at each `--apply`, each with io's go-ahead**. It never swaps `TABLE_NAME`. In short: `pause --all`; `rebuild-heads --to-seq N --dry-run`, then `--apply`, from the append-only log; if the log is damaged, restore the table by point in time to a side table and `copy-back` only `REC#`, `SYNC#`, `GID#` and `IDALIAS#` items; then `bump-tree-id`, `resume --all`. On the Mac the desktop refuses the recovered store (D11, D50) until `hfy-sync rebase` re-bases it. A re-seed after a recovery runs as a seed session with `seed: true`: its batches are origin `seed` and silent. The full procedure, the order and the traps are in [Operate the sync store: Recover the store](operate-the-sync-store.md#recover-the-store).

### A lost laptop

Runbook 19.9. Revoke the sign-in at `/auth/revoke` from another device, or have the orchestrator delete the refresh-token family (that deletes app-table items, with io's go-ahead). Then bind the new Mac again with a step-up sign-in ([Install the Gramps sync addon](install-the-gramps-sync-addon.md#when-the-tree-is-refused-as-the-wrong-tree-d03)). A desktop refresh token also expires after 30 days without use.

### Never

Runbook 19.10.

- Never run Reorder Gramps IDs in **Change** mode. A synced person's ID is permanent, and the addon blocks a renumber (D35).
- Never open the tree with `--force-unlock`. The wrapper refuses it (D02).
- Never run the retired `sync_to_s3.py`. It refuses, and the bucket policy denies its writes anyway (S16).
- Never paste previews, backups or logs other than `status.json` into an agent session.

### Remove something from the cloud

Runbook 19.11. Use this when sensitive data reached the cloud: a date of birth in a note, a contact detail, a photo with a location. The tool is `api/scripts/expunge.mjs` ([full procedure](operate-the-sync-store.md#remove-something-from-the-cloud)). **It writes app-table items and deletes S3 versions, so it needs io's go-ahead, a dry run first, and io's step-up to apply** (`EXPUNGE_ACCESS_TOKEN`, a fresh sign-in within 300 seconds). Its output holds counts only.

| What you remove | Mode |
| --- | --- |
| A whole withdrawn or deleted record | `--record <Class>:<handle>` |
| One value of a record | `--record <Class>:<handle> --path <pointer>` |
| A proposal and its discussion | `--proposal <ulid>` |
| One chat message | `--chat <conv>:<seq>` |
| An uploaded photo | `--upload <key>` |
| Withdrawn records whose grace has passed | `--due` |

Two time limits apply, and the privacy text says both:

- **The 72-hour withdraw grace.** Marking a record Gramps-private (or otherwise withdrawing it) hides it at once and the next render removes its files, but its history is expunged only after 72 hours, and only when io runs `expunge.mjs --due`. Until then `sync-admin.mjs resurrect --include-withdrawn` brings a mistaken withdraw back. Nothing runs the expunge for you, so run `--due` at least weekly.
- **The 35-day point-in-time tail.** DynamoDB point-in-time recovery keeps older copies of the table for 35 days, and nothing here shortens that. After a restore to a point before an expunge, run the expunge again ([Operate the sync store](operate-the-sync-store.md#recover-the-store), step 4).

After a record or path expunge: render again (`render --apply --full`), let the graph follow, then sweep the noncurrent site versions. The steps are in the linked procedure.

### Tree pictures (the interim)

The family-tree SVGs, `media/tree_<gramps-id>.svg`, are legacy: they are not renderer-owned, and they freeze at the cutover. A person created in the cloud (on the website, through a suggestion) has no SVG, so the person page shows the **see in the family tree** link to the `/tree/` page instead, which reads `person/graph.json` ([Front end](../reference/front-end.md)). The `viz-v2-retire-graphviz` task retires the SVGs; until then the existing SVGs stay as they are, and nobody regenerates them: the legacy ETL that wrote them is retired at the cutover. Decided in BRD2 D2-25 and sync design section 11.5 ([why](../explanation/family-data-source-of-truth.md#tree-pictures)).

## Cut over to the cloud store

The cutover is io's decision (gate G-cutover) and the order below is fixed: **deny first, then live, then verify**. The deny is applied before `RENDER_MODE=live`, so no window exists in which the legacy publish and the renderer both write the same files (review R2-02). The cutover is run by the orchestrator (`cutover-live-render`); this section is its runbook. An agent runs a step only after io's go-ahead for that step is on the record in the session, and writes that go-ahead into the worklog with the dry-run output.

Before you start:

- The seed is done, the shadow render ran, and io approved its parity report.
- `RENDER_MODE` is `shadow`, and the hfy-sync-render, hfy-graph-render, hfy-api and `hfy-data-breakglass` roles exist (`BreakGlassRoleArn` is an output of `<app-stack>`).
- Your credentials can read and write the bucket policy of `<site-bucket>` and, for the simulation, call `iam:SimulateCustomPolicy`.
- You know what the bucket policy holds now: the script keeps every statement that is not its own, and `--dry-run` shows them.

### Deny first

The script is [`scripts/infra/apply-data-write-guard.sh`](../../scripts/infra/apply-data-write-guard.sh). It denies `s3:PutObject`, `s3:DeleteObject` and `s3:DeleteObjectVersion` on `person/*.json`, `family/*`, `event/*`, `note/*`, `place/*` and `media/*.json`, and `s3:DeleteObject` and `s3:DeleteObjectVersion` on `media/*`, for every principal except `hfy-sync-render`, `hfy-graph-render`, `hfy-data-breakglass` and, for media binaries only, `hfy-api`. `hfy-api` is not an exception for the `*.json` keys. `person/index.html`, the person page shell, stays outside the deny, so the CI deploy keeps working: the deploy role still puts `person/index.html` and cannot put `person/<id>.json`.

1. Look first. This prints the merged policy and changes nothing:

   ```sh
   scripts/infra/apply-data-write-guard.sh --dry-run
   ```

   Read the summary line (`others kept` is the number of statements that are not the guard's) and the merged policy. The guard adds two statements, `HfyDataWriteGuardRecords` and `HfyDataWriteGuardMediaDelete`.

2. Run the matrix against the merged policy, still without changing anything:

   ```sh
   scripts/infra/apply-data-write-guard.sh --simulate
   ```

   It calls `aws iam simulate-custom-policy` for 19 cases, and ends with `simulation passed` or exits `1` on the first mismatch. The cases include the renderer putting `person/<id>.json` (allowed), a role outside the exceptions putting it (denied), the deploy role putting `person/index.html` (allowed) and `person/x.json` (denied), and `hfy-api` putting `media/x.json` (denied) and `media/x.jpg` (allowed). The IAM API documents `--caller-arn` as an IAM user, but a read-only run against live IAM accepted the role ARNs and evaluated `aws:PrincipalArn` from them (all 19 cases passed, and the script passes the policies as compact inline JSON because the API rejects a pretty-printed `file://` item). If a later run is refused, stop and ask the orchestrator: do not skip the check. A simulation models the policy, not S3, so the real canary Put in [Then verify](#then-verify) stays required. The script's policy tests pin the same cases offline. The exception ARNs match both `role/<name>` and `role/<path>/<name>`; the five default role names exist in the stack templates and need confirming only if a stack renames them.

3. Apply, with io's G-cutover approval on the record. The `--confirm-g-cutover` flag is that approval: pass it only when io's G-cutover approval is on record for this run, and never together with `--dry-run` or `--simulate` (the script refuses the mix). The guard goes on before `RenderMode` is `live`, never after. The deny also covers `s3:DeleteObjectVersion`, which the design text does not list, so a versioned delete cannot slip past it; io or cutover-live-render confirms this at G-cutover, together with the rule that `hfy-api` may not Put `media/*.json`.

   

   ```sh
   scripts/infra/apply-data-write-guard.sh --confirm-g-cutover
   ```

   The script saves the policy it replaced under `~/.local/state/hfy-infra/s3-policy` and prints the path. A rerun changes nothing.

4. Confirm a CI deploy still works. Push nothing for this: re-run the latest successful `io-kit deploy` run on `main` from the Actions page, or wait for the next merge, and check that it is green. A red deploy here is the SI-05 failure, and it means the deny covers more than the data: run `--remove` (below) and report it.

### Then live

1. Set `RenderMode` to `live` on `<app-stack>` with a parameter-only change set ([Deploy the app stack](deploy-the-app-stack.md)). Review the change set before you execute it. It must change `RenderMode` and nothing else.
2. The first live pass writes every desired key and deletes nothing, because no live manifest exists ([The first live pass](../reference/sync-render.md#the-first-live-pass)). Watch it finish: `node api/scripts/sync-admin.mjs render --dry-run` shows `rendered_seq` reaching the head seq.
3. Read `render/reports/<seq>.json` in the sync bucket: keys and counts only. The expected number of deletes is `0`.

### Then verify

1. Every key under the data prefixes that the renderer wrote is current: the report has no failed writes and no `RenderPrivacyBlock` alarm.
2. The legacy publish is refused. This is the check that the deny works, so run it from a role that is not an exception: `aws s3api put-object --bucket <site-bucket> --key person/guard-probe.json --body /dev/null` must fail with `AccessDenied`. If it succeeds, the deny is not working: delete the probe object and stop.
3. Review the report's foreign keys. Prune the reviewed ones only, with io's go-ahead: `node api/scripts/sync-admin.mjs render --apply --prune-foreign` ([Operate the sync store](operate-the-sync-store.md#force-a-render)).
4. Open the site as a signed-in member and check a person page, a family page and the search.

## Roll back

The primary rollback is `RENDER_MODE=off`. It freezes the files that are live now: the renderer stops, nothing is deleted and no republish happens, so the site keeps serving the last good render. Set `RenderMode` back to `off` with a parameter-only change set. Leave the write guard in place. Any record change made in the meantime waits in the store, and the next `live` pass catches up.

Republishing from the legacy ETL is a last resort, for the case where the store itself cannot be repaired (a store fault is repaired store-scoped, [Operate the sync store](operate-the-sync-store.md)). It needs all of these, in this order:

1. **A desktop pull first.** Run `hfy-sync check`, review the changes that would come from the website, and apply them, so the Gramps tree holds everything the store holds. The ETL publishes from the tree, so anything not pulled is lost from the site.
2. **A break-glass run with `--no-delete`.** Assume `hfy-data-breakglass` (io only, MFA, one hour). It is an exception to the write guard, so the guard can stay on. Run the legacy sync with its break-glass escape, `--legacy-break-glass`, and with `--no-delete`, so nothing the tree lacks is removed. Member photos and every key the tree does not know stay in place.
3. **Moderation hides re-applied by a script.** The legacy export does not know about moderation, so every record hidden since the cutover is public again after step 2. Re-apply the hides before you tell anyone the site is back, with the moderation re-apply script that `hfy-moderation-record-targets` ships. Until that script exists, do not run step 2. The check below fails closed while it is absent, and it must pass before step 2 starts:

   ```sh
   test -x scripts/moderation/reapply-moderation-hides.sh || { echo 'moderation re-apply script missing: rollback step 2 is blocked (hfy-moderation-record-targets)' >&2; exit 1; }
   ```

   The rollback is only partly delivered by this page: this step is blocked on `hfy-moderation-record-targets`, which must ship `scripts/moderation/reapply-moderation-hides.sh` (path to be confirmed there) before G-cutover.

The policy-level rollback, taking the write guard off, is needed only for step 2 and for a deploy that the guard breaks. It is checked with a dry run first, so the policy it would leave is on screen before anything changes:

```sh
scripts/infra/apply-data-write-guard.sh --remove --dry-run
scripts/infra/apply-data-write-guard.sh --remove --confirm-g-cutover
```

`--remove` drops the two guard statements and keeps every other statement. After the legacy republish, put the guard back with the apply command in [Deny first](#deny-first) before `RenderMode` goes to `live` again.

## The legacy ETL publish (retired at the cutover)

Everything below this heading is the procedure that the cloud sync replaces. It is kept for the window before the cutover and for the break-glass republish above. After the cutover, the scripts it runs refuse without `--legacy-break-glass` and the bucket policy denies their writes.

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

> **After the cutover this step is not yours.** Once the renderer is `live` and the write guard is on, your role is denied `person/graph.json` and `media/faces/`: `hfy-graph-render` rebuilds them from the cloud store after each live pass ([Deploy the graph renderer](deploy-the-graph-renderer.md)). Use this step before the cutover, and to compare a build from a Gramps copy with the cloud graph.

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

- The legacy search page and navbar search, which read the same files, are gone (HFY-TSK-317): the search island and the shell's launcher are the only readers of the two index files.
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

   If `authV2` is `true`, sign in at `https://<site>/auth/login`, in a window with no preview override, such as a private window. If it is `false`, you still sign in at the same address, but the page never refreshes your session. If `authV2` is `false` while step 5 printed `401`, members are locked out of the family data: go to [Find your starting point](cut-over-to-the-private-data-gate.md#find-your-starting-point).

   Open `https://<site>/person/?id=<gramps-id>`. The page shows the updated details and renders the family tree. Then open `https://<site>/search/` and search for the person's name. The person is listed. The shell's search launcher reads the same two files. If `searchV2` is `true`, `/search/` shows the island. If it is `false`, preview the island with `?hfy_flags=searchV2` ([Turn a flag on in one browser tab](toggle-a-feature-flag.md#turn-a-flag-on-in-one-browser-tab)) and clear the override afterwards with `?hfy_flags=`.

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
