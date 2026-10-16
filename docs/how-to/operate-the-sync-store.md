# Operate the sync store

Pause the cloud record store, resume it, switch the change feed on or off, force the renderer to run, bring back the records of a mistaken delete or withdraw, and recover the store itself when its heads or its log are damaged. The tool is `api/scripts/sync-admin.mjs` (HFY-TSK-177, and HFY-TSK-275 for the recovery). It is an operator script: it is never deployed, and no workflow runs it.

**io's go-ahead is required.** Every `--apply` is a production write: `pause`, `resume`, `feed-on`, `feed-off`, `resurrect`, `rebuild-heads`, `copy-back` and `bump-tree-id` write app-table items, and `render` makes the renderer write and delete site files. Run `--apply` only after io's go-ahead in the session. Record that go-ahead verbatim in the worklog, with the dry-run output (AGENTS.md; review DL-28). The seed approval covers setting `writes_enabled` for the seed and nothing else. Run `--dry-run` first, every time. The output names classes, opaque handles, versions, reasons and counts, never record text or a Gramps ID.

## Before you start

- You are in `api/` with the dependencies installed (`npm ci`).
- You have AWS credentials for the app stack's account and region, with read and write access to the app table and, for `render`, permission to invoke the render function (`hfy-sync-render`).
- Common flags: `--table <app-table>` (default `hfy-app`) and `--region <region>` (default `us-west-2`). Every command takes exactly one of `--dry-run` or `--apply` (each given once). `--help` prints the usage.

## Pause and resume the store

`pause --all` sets `SYNC#HEAD.writes_enabled` to `false`. From then on `applyBatch()` refuses every origin with `503 sync_paused`: the desktop push (and the seed session), the web editor, proposals, graduation, moderation and tagging. The desktop's sync routes answer the same, so one switch stops every writer of the store. The conflict queue keeps working. `resume --all` sets it back to `true`. (`--all` names that store-wide scope; the command has no narrower form. `SYNC_API_ENABLED` is the separate environment switch that stops the desktop only.)

```sh
cd api
node scripts/sync-admin.mjs pause --all --dry-run --table <app-table> --region <region>
node scripts/sync-admin.mjs pause --all --apply --by <your-name> --table <app-table> --region <region>
node scripts/sync-admin.mjs resume --all --apply --by <your-name> --table <app-table> --region <region>
```

Each change is pinned to the value it read and writes one `AUDIT#sync-admin:` item. A second `pause` changes nothing. A store with no `SYNC#HEAD` item is refused: the seed creates it, and a script-made one would break the seed.

## Switch the change feed on or off

`feed-on` sets `SYNC#HEAD.changes_feed` to `true` (HFY-TSK-277). `GET /api/sync/changes` then serves the delta feed, and `GET /api/sync/meta` reports `changes_feed: true`, which lets the desktop add-on pull deltas instead of a full snapshot ([Install and run the Gramps sync addon](install-the-gramps-sync-addon.md#delta-pulls-the-change-feed)). `feed-off` sets it back to `false`; the add-on takes full snapshots again at its next run. The feed ships off. An absent attribute counts as off.

```sh
cd api
node scripts/sync-admin.mjs feed-on --dry-run --table <app-table> --region <region>
node scripts/sync-admin.mjs feed-on --apply --by <your-name> --table <app-table> --region <region>
node scripts/sync-admin.mjs feed-off --apply --by <your-name> --table <app-table> --region <region>
```

Each change is pinned to the value it read and writes one `AUDIT#sync-admin:` item, like `pause`. Flip it on only after the `hfy-api` release that holds the route has executed (the route is `404 not_enabled` while the switch is off, and a build without the route answers `404 not_found`). A desktop that cannot use the feed (an old add-on, a `410`) falls back to snapshots by itself, so switching it off is never needed to keep the desktop working.

## Force a render

`render` invokes the render function with an operator payload. Each of the three flags forces a full pass, even when `rendered_seq` already equals the head seq:

| Flag | Payload | Use |
|---|---|---|
| `--full` | `{"force": true}` | Re-render everything. |
| `--allow-mass-delete` | adds `{"allow_mass_delete": true}` | Perform the deletions the mass-delete guard refused. Read `render/reports/<seq>.json` (`refused_deletes`) first. |
| `--prune-foreign` | adds `{"prune_foreign": true}` | Delete the renderer-shaped keys under the data prefixes that the renderer never wrote. Read the foreign list in the report first. |

```sh
node scripts/sync-admin.mjs render --dry-run --full --region <region>
node scripts/sync-admin.mjs render --apply --full --region <region>
```

The dry run reads `SYNC#HEAD` and `SYNC#RENDER` (head seq, `rendered_seq`, mode, `last_error`) and prints the payload; it invokes nothing. `--apply` calls `aws lambda invoke` (pass `--function <name>` if the function is not `hfy-sync-render`) and reads the response from a temporary file and fails (exit 1) if the CLI reports a `FunctionError` or the body is an error (for example `RenderFailed`), so a refused pass is never reported as success. It passes `--cli-read-timeout 0` so the CLI waits for a full pass; if the call is interrupted anyway, check `SYNC#RENDER` before retrying, so two full passes do not overlap. A render in `RENDER_MODE=off` returns at once. See [The render Lambda](../reference/sync-render.md#operator-payloads).

## Resurrect a batch of deletes or withdraws

A delete or withdraw tombstones the head at once, but the log still holds the version before it. `resurrect` re-creates the heads of one batch from that log, within the 72-hour grace that a withdraw keeps before its history is expunged (a withdraw writes an `EXPUNGE#<Class>#<handle>` item due 72 hours later; `resurrect` deletes it, so a record that came back is never expunged).

1. Find the `batch_id` of the mistaken batch (the `SYNC#BATCH#` receipt, or the audit item `AUDIT#records:<batch_id>`).
2. Plan:

   ```sh
   node scripts/sync-admin.mjs resurrect --batch <batch_id> --dry-run --table <app-table> --region <region>
   ```

   One `will re-create` line per object (class, handle, the tombstone's version and the version it comes back from) and one `refused` line per object it will not touch, then `plan: N to re-create, M refused`.
3. Read the refusals. Each names its reason:

   | Reason | Meaning |
   |---|---|
   | `past_grace` | The tombstone is older than 72 hours. |
   | `no_prior_version` | The log has no earlier version with an object (it was expunged or never existed). |
   | `hash_mismatch` | The earlier version's text does not match its hash. Stop and raise it on the record. |
   | `head_moved` | The head changed after the tombstone, so it is no longer this batch's. |
   | `already_live` | The head is live again, for example because this command already ran. |
   | `withdrawn_private_needs_flag` | The op was a privacy withdraw (reason `private`). Re-creating it puts the record back in the store and the next render republishes it, so it needs `--include-withdrawn` and io's explicit go-ahead for the withdrawn records. The dry run with the flag prints a WARNING naming the count. |
   | `merge` | A person merge. The alias and the survivor are the merge's business. |
   | `media_blob_not_in_log` | A Media's blob descriptor is on the head, not in the log. |
   | `gramps_id_taken` | Another object now holds the id. |
4. After io's go-ahead, apply:

   ```sh
   node scripts/sync-admin.mjs resurrect --batch <batch_id> --apply --by <your-name> --table <app-table> --region <region>
   ```

   Objects are written in transactions of at most 20. Each transaction adds a new head at the next version, a log entry (`op: create`, origin `admin`, principal `operator:sync-admin`, with `resurrected_from`) at the next seq, a re-claimed GID item (a Person's retired id is claimed again by its own person only), the `live_heads` count and one audit item, all pinned to the `SYNC#HEAD` seq it read. If the pin fails, another writer got in first: stop, and rerun the dry run.
5. Run the dry run again. Every object must now read `already_live`. The renderer picks the new log entries up from the stream, or within 15 minutes from the schedule.

The 35-day point-in-time recovery tail is separate: it cannot bring a record back through this tool, and the privacy text discloses it.

## Recover the store

This replaces the old disaster runbook (19.8), which restored the whole table from point-in-time recovery to a new name and swapped `TABLE_NAME`. A swap rolls back every domain that lives in the table (members, posts, comments, uploads, chat, notifications) and breaks the stack, which is review SI-04. The recovery is **store-scoped**: it rewrites the four sync partitions, `REC#` (the record heads), `SYNC#` (the log, the head, receipts, sessions, conflicts), `GID#` (the Gramps-id guard) and `IDALIAS#` (renumber and merge aliases), and nothing else. Every other item in the table is left byte for byte as it is; the tests prove it. `TABLE_NAME` is never changed.

io's go-ahead is required for every `--apply`, as above. Work through these steps in order, and stop at the first one that is enough.

1. **Pause every writer.** `pause --all --apply`. Every `--apply` below refuses to run until the store is paused, and each write transaction is guarded by a check that the store is still paused.

2. **Find out whether the log is whole.** The log, `SYNC#LOG`, is append-only and is the authority: every head, id guard and alias is derived from it.

   ```sh
   node scripts/sync-admin.mjs rebuild-heads --to-seq head --dry-run --table <app-table> --region <region>
   ```

   It reads the log and checks it (dense seqs 1 to `SYNC#HEAD.seq`, every object text against its hash, every object's versions counting up by one), folds it with the rules `applyBatch()` uses, and compares the result with the stored `REC#`, `GID#` and `IDALIAS#` items. It prints counts, field names, classes and opaque handles, never record text or a Gramps id. `plan: nothing to change` means the heads already equal the log (this is also the check to run after any step below). If it says `the log is damaged`, go to step 4.

3. **Log whole, heads wrong: rebuild the heads from the log.** After reading the dry run, `rebuild-heads --to-seq <N> --apply`:

   - `--to-seq head` (the log's last seq) rewrites only what differs: missing, edited or orphaned heads, id guards and aliases, and a wrong `live_heads` count. The log is read, never changed. A Media head's blob descriptor (it is on the head, not in the log) and a head whose last entry was expunged are kept as they are.
   - `--to-seq <N>` with N before the last seq puts the store **back to its state at seq N**. This is more than a pure refold, and io should confirm the reading: a refold of the heads to N while the log still runs past N would leave heads that disagree with `SYNC#HEAD.seq` and with the log, so the tool does not do that. Instead it **appends new log entries** after the tail (the existing entries are never edited or removed). The log stays append-only: the tool appends one admin entry (origin `admin`, principal `operator:sync-admin`, batch `rebuild:<N>:<last seq>`) for every object whose state differs, a delete if it did not exist then, an update back to the older text, or a create over a tombstone, and moves `SYNC#HEAD.seq` past them (in transactions of at most 20 entries and about 3 MB). Then it rewrites the heads from the whole log. A Person id stays retired even when the person is rolled back to not existing. Edits made after N are not lost from the log (the history keeps them) but are no longer the current state: the desktop will see them as differences when it rebases. Several cases are reported rather than guessed. An object a privacy erasure expunged (its text is gone from the log on purpose) is **left as it is** and listed as `expunged: left as is`: a rollback never writes a live entry without text. A Media object rolled back to different text keeps its newest blob descriptor, because the blob is on the head and not in the log: the plan says so, and each such file's sha256 and size must be checked afterwards.

   **A rollback does not republish what was withdrawn.** Putting an object back over a tombstone is the same act as `resurrect`, so it keeps `resurrect`'s refusals. The object keeps its tombstone and the plan lists it as `refused  left as is <Class> <handle>: <reason>`, with a note that counts them:

   | Reason | Meaning |
   |---|---|
   | `withdrawn_private_needs_flag` | The last entry is a privacy withdraw. Re-creating it puts the record back in the store and the next render republishes it, so it needs `--include-withdrawn` and io's explicit go-ahead for the withdrawn records. With the flag the dry run prints the same WARNING as `resurrect`, naming the count. |
   | `past_grace` | The withdraw is older than 72 hours, so its expunge is queued. No flag brings it back. |
   | `merge` | The last entry is a person merge. The alias and the survivor are the merge's business. |
   | `media_blob_not_in_log` | A Media's blob descriptor is on the head, which the delete dropped, and not in the log. |

   A plain delete of any other class is rolled back whatever its age, which is what the command is for. A withdraw that `--include-withdrawn` re-creates leaves its `EXPUNGE#<Class>#<handle>` schedule item in place (unlike `resurrect`, which deletes it). That is harmless: `expunge.mjs --due` skips a live head and drops the item.

   Run the dry run again: it must report nothing to change. One `SYNC#ADMIN` audit item records each run (the recovery copy-back never overwrites or deletes that partition).

4. **Log damaged: copy back from a point-in-time copy.** Restore the app table by point-in-time recovery **to a new table name** (never over the live table):

   ```sh
   aws dynamodb restore-table-to-point-in-time --source-table-name <app-table> --target-table-name <app-table>-pitr-<date> \
     --restore-date-time <time before the damage> --region <region>
   ```

   Wait until the side table is active, then:

   ```sh
   node scripts/sync-admin.mjs copy-back --from-table <app-table>-pitr-<date> --dry-run --table <app-table> --region <region>
   node scripts/sync-admin.mjs copy-back --from-table <app-table>-pitr-<date> --apply --by <your-name> --table <app-table> --region <region>
   ```

   The dry run lists, per partition, what it would write and delete, and refuses a side table that is the live table, has no `SYNC#HEAD`, or has a damaged log of its own (restore from an earlier time then). `--apply` copies only `REC#`, `SYNC#`, `GID#` and `IDALIAS#` items that differ, and **it also deletes** live sync items the side table lacks (a true restore removes what was written after the restore point); the dry run prints the write and delete counts per partition and one line per item, so read the delete counts before approving. `SYNC#ADMIN`, the audit trail of earlier recoveries, is excluded from the copy and from the deletes and is always kept. The writes go in transactions of at most 25 items and 3 MB. It writes `SYNC#HEAD` last, **with `writes_enabled` forced to `false`**, so the restored store is still paused. `expunge_epoch` is the one `SYNC#HEAD` field that is **not** the restore point's: it is written as the larger of the live table's and the restore point's, plus one, and the dry run reports it (`expunge_epoch: live L, restore point R: written as E`). A restore moves `seq` backwards, so a cache of the abandoned timeline can sit at a seq the new timeline reaches again; the epoch is the other value every cache already checks, so the raise drops them all: the store view of each warm Lambda, `snapshots/<seq>.jsonl.gz` (otherwise the desktop's `hfy-sync rebase`, the next step, could be handed the abandoned timeline's snapshot, which passes its own sha256 check), the graph renderer's `SYNC#GRAPH` marker (the next render pass rebuilds `person/graph.json`) and the desktop's delta cache. A second `copy-back` dry run, once nothing else differs, leaves the epoch where it is. Every other `SYNC#HEAD` field is the restore point's, `changes_feed` included: check the feed switch (`feed-on` / `feed-off`) before you resume. Posts, comments, uploads, chat and every other partition that changed since the restore point are not touched. **Notifications:** the restore rewinds the log, so new writes use seqs the abandoned timeline already used, and the record-change notification claims (`RECFAN#<seq>/<subject>`, 35-day lifetime) of those seqs are outside the four partitions and stay. A notification for a reused seq can be dropped as already sent. At family scale this is accepted; the dry run prints a note when it applies. (`rebuild-heads` never reuses a seq, so it has no such effect.) Then run `rebuild-heads --to-seq head --dry-run`: it must report nothing to change. Delete the side table when you are done (a separate deletion, with io's go-ahead).

   The renderer's `SYNC#RENDER` state comes back with the copy. If the restored store is behind the live site, run `render --full` after the store is resumed; if the site was rendered from newer data than the restored store holds, read the render report's refused deletes before approving any mass delete.

   **Privacy expunges and the copy-back.** The side table is a copy from before the damage, so it still holds any text that [`expunge.mjs`](#remove-something-from-the-cloud) removed after the restore point, and the copy writes it back into `SYNC#LOG` and the heads. Restore to a point after the last expunge when you can. If you cannot, run the same expunge again for each record or path removed since the restore point, then `render --full` and the sweep, before you resume; the `AUDIT#expunge:` items hold counts only, so work from the worklog's go-ahead entries. The `EXPUNGE#` schedule items are outside the four partitions and stay: one whose record the restored log does not hold makes each `expunge.mjs --due` run report that record as failed (`no_such_record`) and keep the item. `rebuild-heads --to-seq` never undoes an expunge: an object whose entry was expunged is left as it is.

   **Withdraws and the copy-back.** The same rewind undoes every privacy withdraw made after the restore point, not only an expunge: the side table holds the record live, and the copy writes it back live, with no `--include-withdrawn`, no 72-hour check and no warning (the `rebuild-heads` refusals above do not apply to a copy-back). The withdraw's `EXPUNGE#<Class>#<handle>` schedule item stays, outside the four partitions, and `expunge.mjs --due` drops it once the record is live. Restore to a point after the last privacy withdraw when you can. If you cannot, list the withdraws made since the restore point before you apply (the worklog's go-ahead entries and the `SYNC#BATCH#` receipts of that period), and withdraw each record again as soon as the store is resumed: until you do, the restored store holds it live and a render pass publishes it. Then `render --full` and read the render report.

5. **Give the store a new tree id.** The desktop must stop trusting the history it remembers:

   ```sh
   node scripts/sync-admin.mjs bump-tree-id --dry-run --table <app-table> --region <region>
   node scripts/sync-admin.mjs bump-tree-id --apply --by <your-name> --table <app-table> --region <region>
   ```

   The new `SYNC#HEAD.tree_id` makes every desktop request that names the old one fail with `403 tree_mismatch`, and a pull stop at the handshake with D50. The binding to the desktop's tree is kept. Add `--reseed` only when the store was emptied on purpose and the desktop must send everything again (over a store that still holds heads it changes no head, but the seed session's creates for handles that already have a head are refused `409 exists`, so the seed cannot finish; the test pins this): it also marks the store not seeded and clears the open session, so web and proposal writes are refused (`503 store_not_seeded`) until a seed session completes. The next session then carries `seed: true`, its batches are origin `seed`, and they are silent: no notification, inbox row or push goes out for them.

6. **Resume, and have the desktop rebase.** `resume --all --apply`. On the Mac, with Gramps closed, `hfy-sync rebase` looks (exit 10), `hfy-sync rebase --yes` re-bases the objects both sides agree on and turns the rest into conflicts, changes nothing in the tree and sends nothing ([When the website's store was recovered](install-the-gramps-sync-addon.md#when-the-websites-store-was-recovered-d50)). Resolve the conflicts, then `hfy-sync pull`.

7. **Re-render if needed.** `render --dry-run --full`, then `--apply --full`.

If the recovery has to roll back further than the log reaches (the log itself was lost and every point-in-time copy is damaged), the last resort is a re-seed: restore a pre-seed side table with `copy-back`, `bump-tree-id --reseed`, resume, and run the first-sync seed from the desktop again. That needs io's decision, because everything written on the website since the seed is lost.

## What is proven and what is not yet

The tests (`api/test/sync-recovery.test.js`) run every command against an in-memory DynamoDB fake with synthetic objects. They prove, for the fake: every item outside `REC#`, `SYNC#`, `GID#` and `IDALIAS#` is byte for byte unchanged by `rebuild-heads` and `copy-back`; the log stays append-only; the refold equals what `applyBatch()` wrote; a rollback leaves a privacy withdraw, a merge and a Media as tombstones; a warm store view and the snapshot cache of the abandoned timeline are dropped by a copy-back. They are **not** the dry run on a real non-production copy that the acceptance criteria ask for. That evidence needs an AWS session (product-lead profile) and io's go-ahead, and is still to be recorded: restore a non-production side table from point in time, run `rebuild-heads --to-seq head --dry-run` and then `--apply` on a copy of the app table, run `copy-back --from-table <side> --dry-run` and then `--apply`, and record only the counts the tool prints (never object text, handles or ids), together with a before and after item count of every other partition.

`pause --all` and `resume --all` name the store-wide scope: there is no narrower form and no second code path (the check is inside `applyBatch()` for every origin, and the desktop's sync routes answer the same).

## Remove something from the cloud

`api/scripts/expunge.mjs` (HFY-TSK-204, BRD2 D2-33, runbook 19.11, catalog entry S19) removes a record, one value of a record, a proposal, a chat message or an upload from every cloud copy. Use it when a report or io finds sensitive data that reached the cloud. It is an operator script: it is never deployed, and no workflow runs it.

**It is a dry run unless you pass `--apply`.** `--apply` needs io's step-up: the sync access token of the tree owner's fresh sign-in (`amr` `mfa`, `auth_time` within 300 seconds, a `gramps-owner`), in the environment variable `EXPUNGE_ACCESS_TOKEN`. The script verifies it against the auth edge's keys and the groups file before it writes anything, and refuses a stale or non-owner token. Pass the token in the environment, never as an argument. Each `--apply` writes one `AUDIT#expunge:<id>` item with the mode and counts only. The output names counts and classes, never a handle, an id or text. Record io's go-ahead verbatim in the worklog with the dry-run output. Never paste previews, backups or logs other than `status.json` into an agent session.

| You want to remove | Command |
| --- | --- |
| A whole withdrawn or deleted record | `node scripts/expunge.mjs --record <Class>:<handle>` |
| One value of a record (a note's text, a name part) | `node scripts/expunge.mjs --record <Class>:<handle> --path /text/string` |
| A proposal and its discussion | `node scripts/expunge.mjs --proposal <ulid>` |
| One chat message | `node scripts/expunge.mjs --chat <conv>:<seq>` |
| An uploaded photo | `node scripts/expunge.mjs --upload uploads/posts/<ulid>/photo.jpg` |
| Withdrawn records whose grace has passed | `node scripts/expunge.mjs --due` |

Add `--apply` to the line you ran as a dry run. Common flags: `--table <app-table>`, `--region <region>`, `--sync-bucket <name>` and `--site-bucket <name>`.

1. **Dry run first.** It reads and prints counts: log entries, heads, snapshot versions, shadow versions, noncurrent site versions, and for a Media record the photo file versions. Check that the count of log entries matches the versions you expect.
2. **Apply** after io's go-ahead, with `EXPUNGE_ACCESS_TOKEN` set. Once the data-write guard is applied, a `--record` run also needs the break-glass session for the site bucket (see Credentials of a record run, below).
3. **Render again.** After a record or path expunge run `node scripts/sync-admin.mjs render --apply --full`, so the live files are rewritten from the store. The expunge does not move `seq`, so the renderer would not notice it on its own.
   **Then let the graph follow.** `person/graph.json` is the graph renderer's file, not the sync renderer's, and the full render does not rewrite it itself. A live render pass starts `hfy-graph-render` ([Graph trigger](../reference/sync-render.md#graph-trigger)), which rebuilds when `SYNC#GRAPH.expunge_epoch` differs from `SYNC#HEAD.expunge_epoch` (an absent field reads as `0`), whatever `seq` says; the 15-minute schedule tick does the same. Wait for its debounce (15 seconds by default) and check in the app table that `SYNC#GRAPH.expunge_epoch` equals `SYNC#HEAD.expunge_epoch` and that `SYNC#GRAPH` has no `last_error`. If the graph function is not wired to the render (its `GRAPH_RENDER_FUNCTION` is unset) or the pass failed, rebuild it by hand with `{"force": true}` ([Deploy the graph renderer: Smoke and verify](deploy-the-graph-renderer.md#smoke-and-verify)). Do not start step 4 before the epochs match: the sweep keeps each file's current version, so until the graph has been rebuilt the live `person/graph.json` still holds the removed value.
4. **Sweep the copies the render left, when the site bucket is versioned.** The live files still held the removed value until the render rewrote them, and a versioned bucket keeps each overwritten file as a noncurrent version that holds it. `person/graph.json` is one of those files for a Person, Family, Event, Place or Media record: the graph renderer writes a new version of it whenever its content changes. Run the same line again after the render and the graph pass, dry run first. A whole-record line needs nothing added. A `--path` line needs `--sweep` (and the same `--replacement`), because the table is already scrubbed and the path is no longer found; without it the run is refused as a typo. The sweep rewrites nothing in the table: it deletes the noncurrent site versions and the old snapshot versions. Skip this step on a bucket that is not versioned: the dry run says so.
5. **Check.** Run the dry run again (with `--sweep` for a `--path` line): the log entries and heads read `0`, and on a versioned bucket so do the noncurrent site versions.

**Record, whole.** The record must already be a tombstone: a live one is refused (withdraw or delete it first). Every `SYNC#LOG` entry of the handle, found through `RECHIST` and the head's own seq, and the head get `obj_json` null and `expunged: true`; `hash` and `seq` stay. The open and decided sync conflicts of the handle lose their values. Then every snapshot under `snapshots/` is deleted with all its versions and the snapshot is rebuilt; the shadow copies (`render-shadow/<site key>`) of the record's file, of the index files and of the pages that embedded it are deleted with all their versions; and, when the site bucket is versioned, the noncurrent versions of those keys are deleted there. The keys include `person/graph.json` for every class the graph builder reads (Person, Family, Event, Place and Media; never a Note). That file has no shadow copy: only its noncurrent site versions are swept. The pages that embedded it are found from every stored version of every record, not from the references that are live now: a delete that cleaned a reference away (a Note taken off its Person, a Person taken off its Family) leaves the Person, spouse and family pages out of the live graph, while their earlier versions still hold the text. The script reads the whole `SYNC#LOG` once per run for this, so a run takes longer on a large tree.

**Media photo.** `--record Media:<handle>` also deletes the photo: every version of `media/<handle>.<ext>` (an older extension of the same handle included) and of the staging copies under `media/.staging/<handle>/`. The renderer never writes or deletes a binary, and a deleted or withdrawn head no longer names the file, so the script finds it by the handle, and the dry run reports it as `photo file versions`. `--path` on a Media record leaves the file in place: only the whole record removes it. The graph builder's face crops (`media/faces/<gramps id>-<hash>.webp`) are keyed by the Person, not the Media, and this script does not reach them; the graph builder removes a crop on its next run once the graph no longer names it ([graph README: Face crops](../../graph/README.md)), so look at `media/faces/` after that build.

**Credentials of a record run.** One process reaches three places: the table and the sync bucket (snapshots, `render-shadow/` with their versions), which io's usual administrator credentials reach, and the rendered data prefixes of the site bucket (`person/`, `family/`, `event/`, `note/`, `place/` and `media/`). The write guard of `apply-data-write-guard.sh` denies `s3:PutObject`, `s3:DeleteObject` and `s3:DeleteObjectVersion` on `person/*.json`, `family/*`, `event/*`, `note/*`, `place/*` and `media/*.json`, and `s3:DeleteObject` and `s3:DeleteObjectVersion` on `media/*`, to every principal except `hfy-sync-render`, `hfy-graph-render` and `hfy-data-breakglass` (and `hfy-api` for `media/*`). Once the guard is applied, your usual administrator credentials therefore cannot delete a noncurrent version of a rendered key or a Media photo. Only `hfy-data-breakglass` (MFA, one hour) can, and it reaches neither the table nor the sync bucket, so it cannot run the whole command alone. The script takes the break-glass session as a second set of credentials, used for the site bucket's data prefixes only. The table, the sync bucket, `uploads/` (the `--proposal` and `--upload` photos, which the guard does not cover) and the step-up check keep the usual credentials. Put the session in the environment, never in an argument, without printing it (`BreakGlassRoleArn` is an output of `<app-stack>`):

```sh
read -r EXPUNGE_SITE_AWS_ACCESS_KEY_ID EXPUNGE_SITE_AWS_SECRET_ACCESS_KEY EXPUNGE_SITE_AWS_SESSION_TOKEN <<<"$(
  aws sts assume-role --role-arn <break-glass-role-arn> --role-session-name expunge \
    --serial-number <mfa-device-arn> --token-code <code> \
    --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text)"
export EXPUNGE_SITE_AWS_ACCESS_KEY_ID EXPUNGE_SITE_AWS_SECRET_ACCESS_KEY EXPUNGE_SITE_AWS_SESSION_TOKEN
```

The role holds `s3:ListBucketVersions`, `s3:GetBucketVersioning`, `s3:GetObjectVersion` and `s3:DeleteObjectVersion` only from the revision of `app-stack.yaml` that added them: check the role's policy in the account before you rely on it, and do not assume the change set was executed. All three variables or none; a partial set is refused. Unset them when the run is done. With none set, every call uses the usual credentials, which is right only while the guard is off. If the guard refuses a delete, the run stops after the table is rewritten with `the site bucket refused a delete` and the variable names (a `--due` run reports `ExpungeError site_denied` for that record and goes on), and the same command, run again with the session set, finishes it, as under "If a run stops part-way".

**If a run stops part-way.** The head rewrite also writes `EXPUNGE#SWEEP`, and that item is deleted (with the record's `EXPUNGE#<Class>#<handle>` schedule item) only after the snapshot versions were replaced. A crash, a network error or an S3 error before then leaves it, and the table is already done: run the same command again. A `--record` rerun finds nothing left to rewrite, still removes the shadow and site copies, a Media photo and the old snapshot versions, and a `--path` rerun does the same instead of refusing the path as absent. `--due` runs the snapshot step whenever `EXPUNGE#SWEEP` exists, even with no record due. A transaction cancelled by a racing resurrect or edit is read again once; if it is cancelled again the record is reported as failed (`record_moved`) and a `--due` run goes on to the next record. A failure line names the class, the error name and a code, never a handle or a value.

**Record, one value (`--path`).** The pointer is RFC 6901 into the object, for example `/text/string`. In every log entry and in the head, a string becomes `--replacement` (default empty) and any other object member is removed; an array element that is not a string is refused, and so are `handle`, `_class` and `gramps_id`. This rewrites append-only history, an audited exception (SI-18). The hashes are recomputed and the version and seq do not move, so the desktop add-on sees a changed hash at an unchanged version and treats it as an expunge notice: it refreshes its base and holds the local value. The snapshot and shadow steps are the same as for a whole record, and a Media photo is not touched. The live site files keep the old value until the render has rewritten them: do step 3, then step 4 with `--sweep`.

**What the epoch does.** Every record run raises `SYNC#HEAD.expunge_epoch` by one in the transaction that rewrites the head. The store view in every warm Lambda and the cached snapshot check it, so none of them can keep the removed value in memory or in `snapshots/`. The graph renderer keeps the epoch it built under in `SYNC#GRAPH.expunge_epoch` and rebuilds `person/graph.json` when the two differ, so an expunge that leaves `seq` alone still reaches the graph. `sync-admin.mjs copy-back` raises the epoch for the same reason: it moves `seq` backwards.

**Proposal.** `PROP#<ulid>` META and every `IDX#` copy lose the proposal document and their index keys and stay as an expunged stub, so no list or page shows them. The proposal thread's comments and reactions are deleted, the audit rows of those comments keep who, what and when and lose the text they copied, and the comments' photos are deleted from the site bucket with every version. The proposal's own `AUDIT#proposal:<ulid>` rows keep who, what and when and lose `before`, `after` and any decision `reason`. The `IDEM#` receipts whose result echoes the proposal (a create or a decision) are deleted: they are found by one filtered table scan, so the run needs `dynamodb:Scan` and takes a moment on a large table. A system proposal's `PROPREQ#<request id>` item loses its content hash (the id still resolves to the expunged stub, and the request id cannot be reused for a different suggestion). The inbox rows of a decision can hold the reason an admin typed; they expire 90 days after they are read and are not touched.

**Chat.** The chat hub nulls the message text through its admin route, then the `CHAT#<conv>` / `M#<seq>` mirror row is deleted. The hub goes first so that a later archive batch cannot write the text back. Set `CHAT_HUB_ADMIN_URL` (https; `https://harrisonfamily.us/chat/v1`) and `CHAT_HUB_ADMIN_TOKEN` (the value of the Worker secret `CHAT_ADMIN_TOKEN`, a secret of its own, never the service key or a member session). The route is `POST <url>/admin/expunge` with `{conv, seq}` and a bearer token; it answers `200 {nulled: 0|1}` (`0` when the message was already nulled, which is what running the same command again gives) or `404` when the hub holds no such message, `401` for a wrong token. The chat Worker implements it (HFY-TSK-337, `chat-worker/src/expunge.mjs`): it nulls the text and keeps the message's seq, sender and timestamp so the conversation order survives, removes the text from the hub's storage, waits for an archive drain in flight, and a client's next history read returns the message as removed (`text: null, expunged: true`). **Run `--chat --apply` only while chat is dark:** the pinned chat client (0.1.6) cannot decode a history that holds a removed message until the kit follow-up ships (the script prints this warning on every run). A `503` means an archive drain was running: nothing was nulled, run the same command again. The exact contract, the copies it reaches, the secret's rotation and the residual Cloudflare point-in-time tail are in [Build, test and stage the chat Worker](deploy-the-chat-worker.md#the-admin-expunge-route). Until the Worker is deployed with the secret set, a `--chat` dry run works but `--apply` fails at the hub call before any mirror row is deleted. `<conv>:<seq>` is the conversation id, a colon and the seq, for example `g:<id>:42`.

**Upload.** Every version and delete marker of the object under `uploads/posts/` or `uploads/comments/`, and its `UPLOAD#` binding. A post that still names the photo keeps a dangling link: remove the attachment from the post as well.

**Withdraws and the 72-hour grace.** A privacy withdraw tombstones the head at once (no read serves it, the next render removes the files) and writes `EXPUNGE#<Class>#<handle>`, due 72 hours later. Until then `sync-admin resurrect --include-withdrawn` can bring a mistaken mass withdraw back and cancels the schedule. After it, the expunge is queued and runs when io next runs `node scripts/expunge.mjs --due` (dry run, then `--apply`, which needs io's step-up token): **nothing runs it for you, so "72 hours" is the earliest it can happen, not a promise of when.** The privacy text must say "queued after 72 hours and run by io", and io should run `--due` at least weekly; the dry run's first line, `due: N scheduled expunges past the 72-hour grace`, is the overdue count (an overdue alert belongs to the status and alerting task). `--now` takes every scheduled item at once and exists for tests and for a withdraw that must not wait. A schedule item whose record is live again is dropped.

**What it cannot reach.** The DynamoDB point-in-time recovery tail (35 days) keeps older copies of the table until they age out; so do backups taken outside this stack. The graph builder's face crops under `media/faces/` are outside it too (see Media photo). `person/graph.json` is inside it, but only its noncurrent versions: its live file is the graph renderer's to rewrite (step 3). The privacy text and this runbook say so, and nothing here shortens it.
