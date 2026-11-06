# How to sync Gramps with the website

Use this page to run the sync day to day (install, first time, daily use, restore, upgrade, recovery and removal), to move changes between the Gramps tree on the desktop and the family site, to check the render mode and the write guard, and to roll the cloud render back. The desktop addon pushes the tree to the cloud store. The render Lambda `hfy-sync-render` renders the store into the site's data files, and `hfy-graph-render` rebuilds `person/graph.json` and `media/faces/` after each live pass. The render cutover ran on 2026-11-05 (HFY-TSK-153), and since then nothing else writes those files (HFY-PLN-002; BRD2 D2-05). Read the current state with [the checks](#check-the-render-mode-and-the-write-guard) rather than assuming it.

The legacy publish, the ETL scripts and `sync_to_s3.py`, is break-glass only. The scripts refuse to run without `--legacy-break-glass`, and the bucket policy refuses their writes. The procedure is at the end of this page, as [the legacy ETL publish](#the-legacy-etl-publish-break-glass-only), and is used only as the last resort in [Roll back](#roll-back), with io's explicit approval.

Placeholders: `<site-bucket>` is the site bucket, `<app-stack>` the app stack, `<tree name>` the name in Gramps' Family Trees manager, and `<account-id>` your AWS account. Use `--profile <aws-profile>` on each `aws` command if you use a named profile.

## How the sync works

| Piece | What it does | Where to read more |
| --- | --- | --- |
| The `hfy_sync` addon | Reads the tree, shows what differs, and pushes or pulls changes through the sync API | [Install the Gramps sync addon](install-the-gramps-sync-addon.md) |
| The cloud store | The record log in the app table. Only the sync API writes it | [Operate the sync store](operate-the-sync-store.md) |
| `hfy-sync-render` | Renders `person/`, `family/`, `event/`, `note/`, `place/` and `media/*.json` from the store, and writes only the keys that changed. Modes `off`, `shadow` and `live` | [The render Lambda](../reference/sync-render.md) |
| The write guard | A bucket-policy deny that leaves the renderers and break-glass as the only writers of those keys | [Check and restore it](#check-the-render-mode-and-the-write-guard) |

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
4. Open the tree. **Website sync... > Sign in...** (a passkey), then **Bind this tree**. That binds the tree on this Mac only and sends nothing.
5. **Bind the website's store to the tree, once** ([below](#bind-the-websites-store-to-the-tree)). Close the tree in Gramps, then from the command line: `gramps/bin/hfy-sync cloud-bind --tree "<tree name>"` (a look, exit `10`), then the same with `--yes`. This writes app-table items (the store's binding and its audit record), so run it only after the G-seed message in step 1; until sync is enabled it exits `69`. Without it `check` and `Apply` stop with exit `78` and `cloud_unbound`.
6. **Check** (a dry run). Read the **To the website** list: everything is a create. Held items name the rule and the characters to edit in Gramps.
7. **Apply.** It opens a push session, uploads the blobs and completes the session. This writes app-table items.
8. In a new environment, the orchestrator runs the shadow render and tells you when it is done. Read the parity report on your Mac ([Review the shadow parity report](review-the-shadow-parity-report.md)); it prints counts only, and you send those back. The render goes live only after you approve it ([Put the write guard and the live render back on](#put-the-write-guard-and-the-live-render-back-on)).

#### Bind the website's store to the tree

The website's store starts with no tree bound to it, and the Gramps window's **Bind this tree** does not change that. `hfy-sync cloud-bind` is the step that does, and it belongs between `login` and the first `check`. Run it with Gramps closed, once:

```sh
gramps/bin/hfy-sync cloud-bind --tree "<tree name>"          # a look: exit 10; prints field names and byte lengths, sends nothing
gramps/bin/hfy-sync cloud-bind --tree "<tree name>" --yes    # sends the bind; exit 0 when it is bound
```

It needs the tree bound on this Mac (`hfy-sync bind --yes`, or the window's **Bind this tree**) and the owner's sign-in (`hfy-sync login`). Running it again is safe: for the same tree it exits `0`. Read the result in the line it prints and in the exit code:

| Exit | Code word | Meaning | What to do |
| --- | --- | --- | --- |
| `0` | none, or `already_bound` | Bound, or already bound to this tree | Run `check` |
| `10` | none | The look; nothing was sent | Run it again with `--yes` |
| `65` | `validation` | The website refused the values; nothing was stored | Run `status` and `check`, and ask io |
| `69` | `not_enabled`, `sync_paused` | The website's sync is switched off or paused | Wait for the orchestrator's message that sync is enabled; nothing is wrong on this Mac |
| `70` | `bad_bind_answer` | The website answered in a form this addon does not read | Run `check` to see whether the bind took |
| `75` | `network`, `retryable` and the like | The website could not be reached or was busy | Run it again |
| `77` | `not_signed_in`, `unauthenticated`, `invalid_grant`, `keychain_unavailable`, `step_up_required` | No usable owner sign-in | `hfy-sync login` (`--step-up` when it says `step_up`); unlock the Keychain |
| `78` | `bound_other_tree` | The website is already bound to a different tree | Open that tree. Binding another tree on purpose is a rebind, which needs a fresh sign-in and is not part of this command |
| `78` | `not_owner` | The sign-in is not the tree owner's | `hfy-sync login` with the owner's account |
| `78` | `unbound`, `D03`, `D13`, `config_unreadable`, `upgrade_required`, `tls_verify_failed` | This Mac's side is not ready, or the addon or the certificate check is the problem | The message names the fix |

**`check` exits `78` with `cloud_unbound`: this step is missing.** Run `cloud-bind`, then `check` again. **Exit `69` and exit `78` are different.** `69` is the website's switch (sync is not enabled, or writes are paused): only the orchestrator changes it, so wait. `78` is something to fix: a different tree is bound, the sign-in is not the owner's, the addon is too old, or the store has no tree bound yet. The exit codes keep their usual meaning for every other command ([Sync errors and exit codes](../reference/sync-errors.md#exit-codes)); the command's design and what it sends are in the [Gramps README](../../gramps/README.md#binding-the-websites-store).

### Daily use

This is runbook 19.3. Open Gramps, then **Website sync... > Check for changes**, review, then **Apply**. Apply writes app-table items for what you push.

Headless, with Gramps closed:

```sh
gramps/bin/hfy-sync check --tree "<tree name>"            # the line it prints names the run id
gramps/bin/hfy-sync sync --tree "<tree name>" --yes --plan <run_id>
```

`--plan <run_id>` applies only the plan you reviewed. When the new plan's hash differs from that preview, the run applies nothing and exits `10`; run `check` again and review the new preview. The exit codes and the details in `status.json` are in [Sync errors and exit codes](../reference/sync-errors.md#exit-codes). The site shows the change after the next render, usually within a minute. If it does not, check the render state with `node api/scripts/sync-admin.mjs render --dry-run --full` ([Operate the sync store](operate-the-sync-store.md#force-a-render)).

### Conflicts and held items

Runbook 19.4. Open the Website sync window and pick per field. Held items name the rule and the characters to edit in Gramps. The command line never decides a conflict: it parks it and exits `20`, and the path stays pinned until you decide it in the window.

### Send photos that have a location without it

By default a JPEG, PNG or TIFF photo with a GPS position is held: the website gets the Media's details and not the photo (`media.exif_gps.hold`), and you remove the location from the file before it can go. To keep the location in your files and in Gramps and still put the photo on the website, turn on the per-tree setting `strip_location`. The push then uploads a COPY of each JPEG or PNG that is held only for its position. The copy has minimal metadata: the picture byte for byte, its colour profile and its Orientation, and nothing else (no camera data, no dates, no comments, no XMP, no place names). It is image-lossless and not metadata-lossless. Your file, `Media.path` and the Gramps database are never written, and the setting never leaves this Mac. A TIFF, or a photo the add-on cannot read with certainty (a depth map or a motion clip after the image, an application segment it does not know, extended XMP), stays held.

```sh
cd ~/harrisonfamily
gramps/bin/hfy-sync settings --tree "<tree name>"                         # shows: strip_location off
gramps/bin/hfy-sync settings --tree "<tree name>" --strip-location on      # looks only, exit 10
gramps/bin/hfy-sync settings --tree "<tree name>" --strip-location on --yes
gramps/bin/hfy-sync push --tree "<tree name>" --json                       # the look: counts.media_location_stripped_pending is the number of photos that would go without a location
```

`hfy-sync settings ... --strip-location off --yes` turns it off again. If the website ends up with another file for one of these photos, the sync lists it as held back until you choose (`hfy-sync stripped --accept-website-file <Gramps ID> --yes` or `--send-again <Gramps ID> --yes`). What it removes, how the check works, the limits and what stays held are in [Install and run the Gramps sync addon](install-the-gramps-sync-addon.md#9-push-the-trees-changes). When you review the shadow render against the legacy export, give the report the same count: [Account for media sent without their location](review-the-shadow-parity-report.md#account-for-media-sent-without-their-location).

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
- Never run the legacy ETL scripts (`sync_to_s3.py`, `export_person_data.py`, `build_family_tree_media.py`) or the retired P1 graph wrapper without io's explicit approval. They refuse without `--legacy-break-glass`, and the bucket policy denies their writes anyway (S16). [The legacy ETL publish](#the-legacy-etl-publish-break-glass-only) is the last resort in [Roll back](#roll-back).
- Never paste previews, backups or logs other than `status.json` into an agent session.

### Remove something from the cloud

Runbook 19.11. Use this when sensitive data reached the cloud: a date of birth in a note, a contact detail, a photo with a location. The tool is `api/scripts/expunge.mjs` ([full procedure](operate-the-sync-store.md#remove-something-from-the-cloud)). **It writes app-table items and deletes S3 versions, so it needs io's go-ahead, a dry run first, and io's step-up to apply** (`EXPUNGE_ACCESS_TOKEN`, a fresh sign-in within 300 seconds). Once the data-write guard is applied, a `--record` run also needs io's break-glass session for the site bucket. Its output holds counts only.

| What you remove | Mode |
| --- | --- |
| A whole withdrawn or deleted record | `--record <Class>:<handle>` |
| One value of a record | `--record <Class>:<handle> --path <pointer>` |
| A proposal and its discussion | `--proposal <ulid>` |
| One chat message | `--chat <conv>:<seq>` |
| An uploaded photo | `--upload <key>` |
| Withdrawn records whose grace has passed | `--due` |

Two time limits apply, and the privacy text says both:

- **The 72-hour withdraw grace.** Marking a record Gramps-private (or otherwise withdrawing it) hides it at once and the next render removes its files, but the scheduled expunge of its history comes due after 72 hours and runs only when io runs `expunge.mjs --due` (a `--record` removal or `--due --now` can go sooner). Until then `sync-admin.mjs resurrect --include-withdrawn` brings a mistaken withdraw back. Nothing runs the expunge for you, so run `--due` at least weekly.
- **The 35-day point-in-time tail.** DynamoDB point-in-time recovery keeps older copies of the table for 35 days, and nothing here shortens that. After a restore to a point before an expunge, run the expunge again ([Operate the sync store](operate-the-sync-store.md#recover-the-store), step 4).

After a record or path expunge: render again (`render --apply --full`), let the graph follow, then sweep the noncurrent site versions. The steps are in the linked procedure.

### Tree pictures (the interim)

The family-tree SVGs, `media/tree_<gramps-id>.svg`, are legacy: they are not renderer-owned, and they froze at the cutover on 2026-11-05. A person created in the cloud (on the website, through a suggestion) has no SVG. With the `familyViz` flag on, the person page shows the **see in the family tree** link to the `/tree/` page instead, which reads `person/graph.json` ([Front end](../reference/front-end.md)); with it off, the link is absent and `/tree/` says the tree is not turned on yet ([Turn a feature flag on or off](toggle-a-feature-flag.md)). Check the flag in `flags.json` rather than assuming it. Retiring the SVGs is on hold until the person page's small, expandable visual tree has shipped and io approves (P2-R117; [the design addendum](../design/hfy-pln-002/viz-hourglass-addendum.md)); until then the existing SVGs stay as they are, and nobody regenerates them: the legacy script that wrote them, `build_family_tree_media.py`, refuses to run without `--legacy-break-glass`. Decided in BRD2 D2-25 and sync design section 11.5 ([why](../explanation/family-data-source-of-truth.md#tree-pictures)).

## Check the render mode and the write guard

The cloud render cutover ran on 2026-11-05 (HFY-TSK-153). The data-write bucket guard was applied first. `RenderMode` then moved from `shadow` to `live` by a parameter-only change set, and the first live pass wrote every desired file with no deletes and no foreign keys. This page does not say what the mode or the guard is now, because both can change without a docs edit. Read them with these checks. None of them writes anything.

1. **The render mode and the cursor.** `node api/scripts/sync-admin.mjs render --dry-run --full --region <region>` prints the mode, the head seq and `rendered_seq`, and invokes nothing. `live` with `rendered_seq` at the head seq means the site is current. `off` means the render is rolled back and the site is frozen on its last good render.
2. **The stack parameter.** `aws cloudformation describe-stacks --stack-name <app-stack> --region <region> --query "Stacks[0].Parameters[?ParameterKey=='RenderMode'].ParameterValue" --output text` prints `off`, `shadow` or `live`.
3. **The write guard.** `scripts/infra/apply-data-write-guard.sh --dry-run` prints the merged policy and a summary, and changes nothing. `(dry-run) the policy already matches: no change` means the bucket policy holds the two guard statements as the script would write them. `(dry-run) the policy would change` means the guard is off or differs, so do not assume the renderer is the only writer.
4. **The data gate.** From a shell with no cookies, `curl -sS -o /dev/null -D - https://<site>/person/index.json | grep -iE '^(HTTP|cache-control)'` prints `401` while the gate is attached. For `200` or `404`, follow [Find your starting point](cut-over-to-the-private-data-gate.md#find-your-starting-point).

## Put the write guard and the live render back on

Use this section after a rollback, when `RenderMode` is `off` or `shadow` and you want the cloud render to be the only writer again. The order is fixed: **deny first, then live, then verify**. The deny is applied before `RenderMode` is `live`, so no window exists in which a legacy publish and the renderer both write the same files (review R2-02). An agent runs a step only after io's go-ahead for that step is on the record in the session, and writes the go-ahead into the worklog with the dry-run output. The 2026-11-05 cutover ran in this order.

Before you start:

- io's G-cutover approval is on record for the guard, and io's go-ahead is on record for the change set. A CloudFormation deploy of `<app-stack>` needs it ([`AGENTS.md`](../../AGENTS.md)).
- The roles `hfy-sync-render`, `hfy-graph-render`, `hfy-api` and `hfy-data-breakglass` exist (`BreakGlassRoleArn` is an output of `<app-stack>`).
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

   It calls `aws iam simulate-custom-policy` for each case of the matrix, and ends with `simulation passed` or exits `1` on the first mismatch. The cases include the renderer putting `person/<id>.json` (allowed), a role outside the exceptions putting it (denied), the deploy role putting `person/index.html` (allowed) and `person/x.json` (denied), and `hfy-api` putting `media/x.json` (denied) and `media/x.jpg` (allowed). The IAM API documents `--caller-arn` as an IAM user, but a read-only run against live IAM accepted the role ARNs and evaluated `aws:PrincipalArn` from them, and the script passes the policies as compact inline JSON because the API rejects a pretty-printed `file://` item. If a later run is refused, stop and ask the orchestrator: do not skip the check. A simulation models the policy, not S3, so the real canary Put in [Then verify](#then-verify) stays required. The script's policy tests pin the same cases offline. The exception ARNs match both `role/<name>` and `role/<path>/<name>`; the five default role names exist in the stack templates and need confirming only if a stack renames them.

3. Apply, with io's G-cutover approval on the record. The `--confirm-g-cutover` flag is that approval: pass it only when io's G-cutover approval is on record for this run, and never together with `--dry-run` or `--simulate` (the script refuses the mix). The guard goes on before `RenderMode` is `live`, never after. The deny also covers `s3:DeleteObjectVersion`, which the design text does not list, so a versioned delete cannot slip past it.

   ```sh
   scripts/infra/apply-data-write-guard.sh --confirm-g-cutover
   ```

   The script saves the policy it replaced under `~/.local/state/hfy-infra/s3-policy` and prints the path. A rerun changes nothing.

4. Confirm a CI deploy still works. Push nothing for this: re-run the latest successful `io-kit deploy` run on `main` from the Actions page, or wait for the next merge, and check that it is green. A red deploy here is the SI-05 failure, and it means the deny covers more than the data: take the guard off ([Take the write guard off](#take-the-write-guard-off)) and report it.

### Then live

1. Create a parameter-only change set on `<app-stack>` that sets `RenderMode=live`, as in [Deploy the app stack](deploy-the-app-stack.md#ship-the-real-renderer-hfy-tsk-176), step 3: `--use-previous-template`, `RenderMode=live` and `UsePreviousValue=true` for every other parameter.
2. Review the change set before you execute it. It must change `RenderMode` and nothing else: no `Remove` action, no `Replacement`, and the `FunctionUrl` and `AuthFunctionUrl` outputs unchanged. Post the `describe-change-set` summary for io and wait for the go-ahead. Execute it.
3. Watch the first pass finish. A pass in `live` after another mode writes every desired key and deletes nothing ([The first live pass](../reference/sync-render.md#the-first-live-pass)). `node api/scripts/sync-admin.mjs render --dry-run --full --region <region>` shows `rendered_seq` reaching the head seq.
4. Read `render/reports/<seq>.json` in the sync bucket: keys and counts only. The expected number of deletes is `0`.

### Then verify

1. Every key under the data prefixes that the renderer wrote is current: the report has no failed writes and no `RenderPrivacyBlock` alarm.
2. The legacy publish is refused. This is the check that the deny works, so run it from a role that is not an exception: `aws s3api put-object --bucket <site-bucket> --key person/guard-probe.json --body /dev/null` must fail with `AccessDenied`. If it succeeds, the deny is not working: delete the probe object and stop.
3. Review the report's foreign keys. Prune the reviewed ones only, with io's go-ahead: `node api/scripts/sync-admin.mjs render --apply --prune-foreign` ([Operate the sync store](operate-the-sync-store.md#force-a-render)).
4. Open the site as a signed-in member and check a person page, a family page and the search. Then check the graph: `/tree/` reads `person/graph.json`, which `hfy-graph-render` rebuilds after each live pass ([Deploy the graph renderer](deploy-the-graph-renderer.md)).
5. Check the data stays private. From a shell with no cookies, the probe in [Check the render mode and the write guard](#check-the-render-mode-and-the-write-guard), step 4, prints `401` while the gate is attached, and so does `https://<site>/person/graph.json`. A `200` means the data is public: stop, and go to [Find your starting point](cut-over-to-the-private-data-gate.md#find-your-starting-point).

## Roll back

The primary rollback is `RENDER_MODE=off`, set through the stack parameter `RenderMode`. It freezes the files that are live now: the renderer stops, nothing is deleted and no republish happens, so the site keeps serving the last good render. Leave the write guard in place. Any record change made in the meantime waits in the store, and the next `live` pass catches up.

### Stop the renderer

1. Look first. `node api/scripts/sync-admin.mjs render --dry-run --full --region <region>` prints the mode, the head seq, `rendered_seq` and `last_error`. Note them in the worklog.
2. Create a parameter-only change set on `<app-stack>` (never the template default `hfy-app`) that sets `RenderMode=off`, as in [Deploy the app stack](deploy-the-app-stack.md#ship-the-real-renderer-hfy-tsk-176), step 3: `--use-previous-template`, `RenderMode=off` and `UsePreviousValue=true` for every other parameter.
3. Review it. The only change is `RenderMode`: no `Remove` action, no `Replacement`, and the `FunctionUrl` and `AuthFunctionUrl` outputs unchanged. Post the `describe-change-set` summary for io and wait for the go-ahead, then execute it.
4. Check it took. Step 2 of [Check the render mode and the write guard](#check-the-render-mode-and-the-write-guard) prints `off`, and the dry run in step 1 still shows the cursor where it was.
5. Check the site still serves: a signed-in member can open a person page. Nothing was deleted, so no file went missing.
6. To go back to `live`, follow [Then live](#then-live). The guard is still on, so [Deny first](#deny-first) is not needed.

### Republish from the legacy ETL (last resort)

Republishing from the legacy ETL is a last resort, for the case where the store itself cannot be repaired (a store fault is repaired store-scoped, [Operate the sync store](operate-the-sync-store.md)). It needs io's explicit approval, because the legacy scripts refuse to run without `--legacy-break-glass`. It needs all of these, in this order:

1. **A desktop pull first.** Run `hfy-sync check`, review the changes that would come from the website, and apply them, so the Gramps tree holds everything the store holds. The ETL publishes from the tree, so anything not pulled is lost from the site.
2. **A break-glass run with `--no-delete`.** Assume `hfy-data-breakglass` (io only, MFA, one hour; [Rehearse the break-glass sign-in](rehearse-the-break-glass-sign-in.md)). It is an exception to the write guard, so the guard can stay on. Run the legacy sync with its break-glass escape, `--legacy-break-glass`, and with `--no-delete`, so nothing the tree lacks is removed. Member photos and every key the tree does not know stay in place. The procedure is [The legacy ETL publish](#the-legacy-etl-publish-break-glass-only).
3. **Moderation hides re-applied by a script.** The legacy export does not know about moderation, so every record hidden since the cutover is public again after step 2. Re-apply the hides before you tell anyone the site is back, with [`scripts/moderation/reapply-moderation-hides.sh`](../../scripts/moderation/reapply-moderation-hides.sh), which `hfy-moderation-record-targets` ships and HFY-TSK-378 completed. The check below fails closed if the script is missing, and it must pass before step 2 starts:

   ```sh
   test -x scripts/moderation/reapply-moderation-hides.sh || { echo 'moderation re-apply script missing: rollback step 2 is blocked (hfy-moderation-record-targets)' >&2; exit 1; }
   ```

   The script reads the open record hides (`MOD#note:`, `MOD#media:` and `MOD#mediaref:` items in the moderation queue) and removes the note and media files it can name. It prints counts only, never an id, key or content. It is read-only by default; the real run needs `--confirm-reapply` and `--break-glass` (the statement that step 2 ran under io's approval), and it refuses with exit `2` unless the `RENDER_MODE` of the renderer function (`--render-function`, default `hfy-sync-render`) is `off`. Hidden posts, comments and member photos need no step here: they live in the store and under `uploads/`, which the legacy publish cannot write, and the API applies their hides on every read. The write guard denies deletes under `note/` and `media/` to everyone but the renderers and `hfy-data-breakglass`, and that role does not reach the table. The script therefore reads the queue and the render mode with your usual credentials and runs only the deletes under `--breakglass-profile` (the profile of the step 2 break-glass session). It discards AWS error text, prints `failed: N` and exits `1` if any delete fails. Confirm the render is stopped first (`node api/scripts/sync-admin.mjs render --dry-run --full`); the script reads `RENDER_MODE` twice, before paging the queue and right before the deletes, but sees no other renderer. The hides on posts, comments and photos are applied at read time (`moderationVisible` in `api/src/moderation.js`). The site bucket is versioned, so a delete leaves a delete marker and noncurrent versions of hidden notes and media remain until `expunge.mjs` clears them. Run it as a dry run first, then with io's go-ahead on record, then check:

   ```sh
   scripts/moderation/reapply-moderation-hides.sh --table <app-table> --site-bucket <site-bucket> --region us-west-2 --dry-run
   scripts/moderation/reapply-moderation-hides.sh --table <app-table> --site-bucket <site-bucket> --region us-west-2 --confirm-reapply --break-glass --breakglass-profile <break-glass-profile>
   scripts/moderation/reapply-moderation-hides.sh --table <app-table> --site-bucket <site-bucket> --region us-west-2 --verify
   ```

   The last line is `result: ...`. Exit `3` is expected even when every delete succeeded: hidden notes, media and MediaRefs stay in the page files until the first `live` render pass after the rollback rewrites them, so that pass is the real fix and you do not tell anyone the site is back before it has run.

   The script follows every page of the queue. It exits `3`, with a warning, whenever any hidden item is open, not only a MediaRef: a hidden note's text is embedded in `person/<id>.json`, a hidden Media is named in the person, event and family files, `media/index.json` and `person/search-index.json`, and a MediaRef lives in the page, so only the renderer rewrites those. It does not delete the binary `media/<handle>.<ext>` either. `--verify` exits `1` while a named file is still served and `3` once only the page files remain. The first live pass after the rollback ([Then live](#then-live)) applies the overlay to every key, so do not announce the site until that pass has finished and the report shows no failed write.

### Take the write guard off

The policy-level rollback is needed only for the break-glass republish above and for a deploy that the guard breaks. It drops the two guard statements and keeps every other statement.

1. Look first. This prints the policy it would leave, and changes nothing:

   ```sh
   scripts/infra/apply-data-write-guard.sh --remove --dry-run
   ```

   Read the summary: `guard: 0` and the `others kept` count you expect.
2. Apply, with io's G-cutover approval on the record:

   ```sh
   scripts/infra/apply-data-write-guard.sh --remove --confirm-g-cutover
   ```

   The script saves the policy it replaced and prints the path.
3. Check it: `aws s3api get-bucket-policy --bucket <site-bucket> --query Policy --output text | jq '[.Statement[] | (.Sid // "") | select(startswith("HfyDataWriteGuard"))]'` prints `[]`.
4. After the legacy republish, put the guard back with the apply command in [Deny first](#deny-first) before `RenderMode` goes to `live` again.

## The legacy ETL publish (break-glass only)

Before the cloud render, the Gramps ETL scripts published the site's data from the maintainer's machine. The cutover to the cloud render (2026-11-05, HFY-TSK-153) retired that path. `export_person_data.py`, `build_family_tree_media.py` and `sync_to_s3.py`, in `<project>/scripts/etl/` outside the repository, now refuse to run without `--legacy-break-glass`: they print one line to stderr and exit `2`. With the write guard on, the bucket policy refuses their writes anyway, except from `hfy-data-breakglass`. Add the flag only for the last-resort republish in [Roll back](#roll-back), with io's explicit approval.

The P1 graph publish wrapper, `<project>/scripts/io/p1-publish-family-graph.sh`, calls `sync_to_s3.py`, so it refuses too, and it is retired. `person/graph.json` and `media/faces/` are produced by `hfy-graph-render` from the cloud store (HFY-TSK-274; [Deploy the graph renderer](deploy-the-graph-renderer.md)). A break-glass republish does not rebuild them, and the legacy graph builder is not part of it. To compare a build from a Gramps copy with the cloud graph, use [the graph builder's README](../../graph/README.md).

### What the republish writes

All local output goes to `<project>/workspace-local/harrisonfamily-frontend/`. That directory is outside the checkout and is never committed.

| Step | Script (under `<project>/`) | Writes |
| --- | --- | --- |
| 1. Export | `scripts/etl/export_person_data.py` | `person/<gramps-id>.json`; `family/`, `event/`, `note/` and `place/` records named by Gramps handle; media binaries and `media/<handle>.json`; the manifests `person/index.json`, `media/index.json` and `place/index.json` |
| 2. Trees | `scripts/etl/build_family_tree_media.py` | `media/tree_<gramps-id>.svg`. With `--attach`, also a `familyTreeMedia` field in each person file |
| 3. Search | `scripts/search/build_search_index.js` | `person/search-index.json`, and a new `person/index.json` in the form `{count, generatedAt, people}` |
| 4. Sync | `scripts/etl/sync_to_s3.py` | The `person/`, `event/`, `family/`, `note/`, `place/` and `media/` prefixes of `<site-bucket>`. Never `uploads/` |
| 5. Invalidate | AWS CLI | CloudFront cache entries for those prefixes. They matter only while the private data gate is not attached |

The script options are in [Private data and secrets](../reference/private-data-and-secrets.md#out-of-repo-tooling). Steps 1 and 2 are only needed to rebuild what the tree holds; the options and warnings below are the ones that bite.

### Before you start

- **io's approval and a break-glass session.** An agent needs io's explicit approval for the run, written into the worklog with the dry-run output, and a `hfy-data-breakglass` session from io. Each of the three Python scripts below takes `--legacy-break-glass`. [`AGENTS.md`](../../AGENTS.md) lists the operations that need io's go-ahead.
- **A desktop pull done.** See [Roll back](#republish-from-the-legacy-etl-last-resort), step 1.
- **Gramps database.** You need a local Gramps SQLite database: the `sqlite.db` file in a Gramps family-tree directory. Close Gramps before you export. Both Python scripts take `--db`. Without it they use `HFY_GRAMPS_DB` if that file exists, and otherwise a discovered database, so confirm which file is used ([Private data and secrets](../reference/private-data-and-secrets.md#export_person_datapy)).
- **Tools.** Python 3 with the `gramps` package (the ETL was built against Gramps 6.0.5), Graphviz (`dot -V`) for step 2, and Node (`node --version`) for step 3.
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

Then check the old upload prefix. Before release-1, the API presigned member photo uploads under `media/posts/<ulid>/`, inside the `media/` prefix that step 4 syncs. HFY-R58 moved new uploads to `uploads/posts/`, and nothing in the repository moves objects that were already under `media/posts/`.

```sh
aws s3 ls s3://<site-bucket>/media/posts/ --recursive | wc -l
```

If this prints more than `0`, record the count: those objects exist only in S3, and a sync that deletes under `media/` removes them. Step 4 always runs with `--no-delete` here, which keeps them.

### Steps

#### 1. Export from Gramps

Start with a dry run. It reads and transforms every person but writes nothing:

```sh
python3 scripts/etl/export_person_data.py --legacy-break-glass --output workspace-local/harrisonfamily-frontend --dry-run
```

The dry run ends with `[SUCCESS] Dry run complete.`. Check that the `Processing <n> person(s).` line matches the number of people in Gramps. Then run it again without `--dry-run`. It ends with `[SUCCESS] ETL export complete.`.

- **Missing media.** A relative media path is resolved from the current directory, not from the Gramps base media directory. When the file is not found, the record is kept with `missing: true` and a placeholder image, and a `[WARNING] Media binary missing` line is logged.
- **Partial exports are for testing.** `--person-id` and `--limit` rewrite `person/index.json` to list only the exported subset; step 3 rebuilds the full manifest. Run a full export before you sync.
- **Nothing is deleted.** The export never removes files from the output directory. To take a record off the site, delete its local file before you sync.
- **Re-exporting drops the trees.** The exported record has no `familyTreeMedia` field, so run step 2 again after every export.

#### 2. Build the family trees

```sh
python3 scripts/etl/build_family_tree_media.py --legacy-break-glass \
  --person-dir workspace-local/harrisonfamily-frontend/person \
  --media-dir workspace-local/harrisonfamily-frontend/media \
  --attach
```

Always pass both directories. Their defaults point at `<project>/workspace/harrisonfamily-frontend`, the sanitized samples. With the defaults, the script reads relationships from the real database and writes diagrams drawn from real family data into the sanitized workspace. The script logs `Rendered <n> SVG tree(s).`; that count should equal the number of people.

#### 3. Build the search manifests

```sh
HFY_PERSON_DIR=workspace-local/harrisonfamily-frontend/person node scripts/search/build_search_index.js
```

The script reads every person file in the directory, writes `person/search-index.json` and replaces `person/index.json` with a manifest of all of them. It ends with `[Search Index] Search index build complete.`. Run it after every export. The search island and the shell's launcher read these two files ([`islands/src/lib/people-corpus.js`](../../islands/src/lib/people-corpus.js)).

#### 4. Sync the data

> **Warning: never run `aws s3 sync --delete` against the bucket root.** Member photos under `uploads/posts/` exist only in S3. No copy exists in the repository, in the ETL output or on anyone's machine. A root-level sync from the ETL output would delete them along with the static site. Sync only through `sync_to_s3.py`: its `--prefix` accepts only the six data prefixes, so it never reaches `uploads/`.

Start with a dry run, with `--no-delete`, as the rollback requires. Always pass `--destination`, because the default is the production bucket:

```sh
python3 scripts/etl/sync_to_s3.py --legacy-break-glass --destination s3://<site-bucket> --no-delete --dry-run
```

Read the output. A `(dryrun) delete:` line means `--no-delete` is missing, so stop. Then run the same command without `--dry-run`. The `person` sync excludes `index.html`, so the page shell that the site deploy owns at `person/index.html` is neither replaced nor deleted.

With `--no-delete`, a record removed from Gramps stays in the bucket. Take it off the site by removing it from the cloud store, not by this sync ([Remove something from the cloud](#remove-something-from-the-cloud)).

#### 5. Invalidate the CloudFront cache

Whether this step matters depends on the private data gate. Check it from a shell with no cookies:

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://<site>/person/index.json
```

- **`401`: the gate is attached.** Its behaviors for the six data prefixes use the CachingDisabled cache policy ([`add-data-gate-behaviors.sh`](../../scripts/infra/add-data-gate-behaviors.sh)). CloudFront keeps no copy of the data, so the invalidation does not matter for them. You can skip it.
- **`200`: the gate is not attached.** The default behavior serves the data paths to anyone and caches them, so invalidate them, with the distribution id from the deploy configuration:

  ```sh
  aws cloudfront create-invalidation --distribution-id <distribution-id> \
    --paths "/person/*" "/media/*" "/family/*" "/event/*" "/note/*" "/place/*"
  ```

- **`404`: the gate is not attached, and `HFYAppendIndex` runs its default-deny code.** Follow [Find your starting point](cut-over-to-the-private-data-gate.md#find-your-starting-point).

The CloudFront invalidation does not reach Cloudflare. A stale copy there can come only from a time when the gate was not attached. If a changed tree or photo still shows the old version, purge the data prefixes in Cloudflare, with io's go-ahead, as in [Cut over to authV2 and the private data gate](cut-over-to-the-private-data-gate.md#4-optional-purge-cloudflare).

### Verify

1. **The data is fresh.** `aws s3 ls s3://<site-bucket>/person/index.json` and `aws s3 ls s3://<site-bucket>/person/search-index.json` show a time from this run.
2. **Member photos are intact.** `aws s3 ls s3://<site-bucket>/uploads/posts/ --recursive | wc -l` is at least the count you recorded before you started. `sync_to_s3.py` cannot reach `uploads/`, so a lower count means something else deleted photos, such as a root-level `aws s3 sync --delete`. Stop and find it. Those photos cannot be rebuilt from any local source. If you recorded a non-zero `media/posts/` count, count that prefix again too. It must not have dropped.
3. **The site shows the change.** Check which sign-in the site serves with `curl -s https://<site>/_data/flags.json | jq '{authV2, searchV2}'`. If `authV2` is `false` while the gate answers `401`, members are locked out of the family data: go to [Find your starting point](cut-over-to-the-private-data-gate.md#find-your-starting-point). Otherwise open `https://<site>/person/?id=<gramps-id>` and `https://<site>/search/` as a signed-in member.
4. **The data is still private.** The probe in [Check the render mode and the write guard](#check-the-render-mode-and-the-write-guard), step 4, prints `401` for the data paths while the gate is attached.
5. **The moderation hides are back.** Re-applied by the script in [Roll back](#republish-from-the-legacy-etl-last-resort), step 3.
6. **The checkout is clean.** `git status` in your checkout shows no changes from this procedure. Any change there means a script wrote into the repository. Find out why before you commit anything.

### Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| A legacy script prints one line and exits `2` | It refuses without `--legacy-break-glass` | Add the flag only with io's explicit approval, as part of the last-resort republish |
| `AccessDenied` from `sync_to_s3.py` | The write guard is on and the session is not `hfy-data-breakglass` | Use io's break-glass session ([Rehearse the break-glass sign-in](rehearse-the-break-glass-sign-in.md)); do not take the guard off to get past it |
| `ModuleNotFoundError: No module named 'gramps'` | The `python3` you ran has no `gramps` package | Install it into that interpreter, for example `pip3 install --user gramps==6.0.5` |
| `FileNotFoundError: Gramps database not found` | `--db` names a missing file, or no database was found | Pass the full path to `sqlite.db` |
| `Graphviz 'dot' binary not found` | Graphviz is not installed or not on `PATH` | Install Graphviz and check `dot -V` |
| Many `Media binary missing` warnings | Gramps stores relative media paths, which are resolved from the current directory | Convert the paths to absolute in Gramps (**Tools > Utilities > Media Manager**), or run step 1 from the directory they are relative to |
| `[ERROR] No person files found in <dir>` | `--person-dir` names the wrong directory | Point it at `workspace-local/harrisonfamily-frontend/person` |
| A person page shows no tree | Step 1 ran after step 2, or step 2 ran without `--attach` or with the default directories | Repeat step 2, then steps 4 and 5 |
| A new person is missing from search | Step 3 was skipped or ran against the default directory | Repeat step 3, then steps 4 and 5 |
| A changed tree or photo still shows the old version | Cloudflare serves a copy of the `/media/` file that it cached while the gate was not attached | With io's go-ahead, purge the data prefixes in Cloudflare, as in [Cut over to authV2 and the private data gate](cut-over-to-the-private-data-gate.md#4-optional-purge-cloudflare) |

## Related pages

- [The privacy model for family data](../explanation/family-data-privacy.md): living-person classification, the shared bucket and its writers.
- [Architecture](../reference/architecture.md#site-bucket): the bucket prefixes and who writes each one.
- [The render Lambda](../reference/sync-render.md): modes, the diff write, the guards and the first live pass.
- [Deploy the graph renderer](deploy-the-graph-renderer.md) and [the family graph builder](../../graph/README.md): who produces `person/graph.json`, and the flags and exit codes of the builder.
- [Private data and secrets](../reference/private-data-and-secrets.md): where the real data lives, what never goes in the repository, and the legacy scripts' options.
- [Codebase map](../reference/codebase-map.md): the scripts outside the repository and the sanitized sample directories.
- [Front end](../reference/front-end.md): the person page and both search surfaces.
- [Cut over to authV2 and the private data gate](cut-over-to-the-private-data-gate.md): checking whether the gate is attached, rolling it back, and purging Cloudflare's copies of the data paths.
- [API reference](../reference/api.md#author-label): how the author label is chosen and how long it is cached.
- [Refresh the sanitized samples](refresh-the-sanitized-samples.md): update the synthetic samples in the repository when the shape of the data changes.
- [Deploy a change to the static site](deploy-a-site-change.md), [Toggle a feature flag](toggle-a-feature-flag.md), [Diagnose sign-in and API failures](diagnose-sign-in-and-api-failures.md).
