# Operate the sync store

Pause the cloud record store, resume it, force the renderer to run, bring back the records of a mistaken delete or withdraw, and recover the store itself when its heads or its log are damaged. The tool is `api/scripts/sync-admin.mjs` (HFY-TSK-177, and HFY-TSK-275 for the recovery). It is an operator script: it is never deployed, and no workflow runs it.

**io's go-ahead is required.** Every `--apply` is a production write: `pause`, `resume` and `resurrect` write app-table items, and `render` makes the renderer write and delete site files. Run `--apply` only after io's go-ahead in the session. Record that go-ahead verbatim in the worklog, with the dry-run output (AGENTS.md; review DL-28). The seed approval covers setting `writes_enabled` for the seed and nothing else. Run `--dry-run` first, every time. The output names classes, opaque handles, versions, reasons and counts, never record text or a Gramps ID.

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

A delete or withdraw tombstones the head at once, but the log still holds the version before it. `resurrect` re-creates the heads of one batch from that log, within the 72-hour grace that `privacy-expunge` keeps before it removes a withdrawn record's history.

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
   - `--to-seq <N>` with N before the last seq puts the store **back to its state at seq N**. This is more than a pure refold, and io should confirm the reading: a refold of the heads to N while the log still runs past N would leave heads that disagree with `SYNC#HEAD.seq` and with the log, so the tool does not do that. Instead it **appends new log entries** after the tail (the existing entries are never edited or removed). The log stays append-only: the tool appends one admin entry (origin `admin`, principal `operator:sync-admin`, batch `rebuild:<N>:<last seq>`) for every object whose state differs, a delete if it did not exist then, an update back to the older text, or a create over a tombstone, and moves `SYNC#HEAD.seq` past them (in transactions of at most 20 entries and about 3 MB). Then it rewrites the heads from the whole log. A Person id stays retired even when the person is rolled back to not existing. Edits made after N are not lost from the log (the history keeps them) but are no longer the current state: the desktop will see them as differences when it rebases. Two cases are reported rather than guessed. An object a privacy erasure expunged (its text is gone from the log on purpose) is **left as it is** and listed as `expunged: left as is`: a rollback never writes a live entry without text. A Media object rolled back to different text keeps its newest blob descriptor, because the blob is on the head and not in the log: the plan says so, and each such file's sha256 and size must be checked afterwards.

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

   The dry run lists, per partition, what it would write and delete, and refuses a side table that is the live table, has no `SYNC#HEAD`, or has a damaged log of its own (restore from an earlier time then). `--apply` copies only `REC#`, `SYNC#`, `GID#` and `IDALIAS#` items that differ, and **it also deletes** live sync items the side table lacks (a true restore removes what was written after the restore point); the dry run prints the write and delete counts per partition and one line per item, so read the delete counts before approving. `SYNC#ADMIN`, the audit trail of earlier recoveries, is excluded from the copy and from the deletes and is always kept. The writes go in transactions of at most 25 items and 3 MB. It writes `SYNC#HEAD` last, **with `writes_enabled` forced to `false`**, so the restored store is still paused. Posts, comments, uploads, chat and every other partition that changed since the restore point are not touched. **Notifications:** the restore rewinds the log, so new writes use seqs the abandoned timeline already used, and the record-change notification claims (`RECFAN#<seq>/<subject>`, 35-day lifetime) of those seqs are outside the four partitions and stay. A notification for a reused seq can be dropped as already sent. At family scale this is accepted; the dry run prints a note when it applies. (`rebuild-heads` never reuses a seq, so it has no such effect.) Then run `rebuild-heads --to-seq head --dry-run`: it must report nothing to change. Delete the side table when you are done (a separate deletion, with io's go-ahead).

   The renderer's `SYNC#RENDER` state comes back with the copy. If the restored store is behind the live site, run `render --full` after the store is resumed; if the site was rendered from newer data than the restored store holds, read the render report's refused deletes before approving any mass delete.

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

The tests (`api/test/sync-recovery.test.js`) run every command against an in-memory DynamoDB fake with synthetic objects. They prove, for the fake: every item outside `REC#`, `SYNC#`, `GID#` and `IDALIAS#` is byte for byte unchanged by `rebuild-heads` and `copy-back`; the log stays append-only; the refold equals what `applyBatch()` wrote. They are **not** the dry run on a real non-production copy that the acceptance criteria ask for. That evidence needs an AWS session (product-lead profile) and io's go-ahead, and is still to be recorded: restore a non-production side table from point in time, run `rebuild-heads --to-seq head --dry-run` and then `--apply` on a copy of the app table, run `copy-back --from-table <side> --dry-run` and then `--apply`, and record only the counts the tool prints (never object text, handles or ids), together with a before and after item count of every other partition.

`pause --all` and `resume --all` name the store-wide scope: there is no narrower form and no second code path (the check is inside `applyBatch()` for every origin, and the desktop's sync routes answer the same).
