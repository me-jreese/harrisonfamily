# Operate the sync store

Pause the cloud record store, resume it, switch the change feed on or off, force the renderer to run, and bring back the records of a mistaken delete or withdraw. The tool is `api/scripts/sync-admin.mjs` (HFY-TSK-177). It is an operator script: it is never deployed, and no workflow runs it.

**io's go-ahead is required.** Every `--apply` is a production write: `pause`, `resume` and `resurrect` write app-table items, and `render` makes the renderer write and delete site files. Run `--apply` only after io's go-ahead in the session. Record that go-ahead verbatim in the worklog, with the dry-run output (AGENTS.md; review DL-28). The seed approval covers setting `writes_enabled` for the seed and nothing else. Run `--dry-run` first, every time. The output names classes, opaque handles, versions, reasons and counts, never record text or a Gramps ID.

## Before you start

- You are in `api/` with the dependencies installed (`npm ci`).
- You have AWS credentials for the app stack's account and region, with read and write access to the app table and, for `render`, permission to invoke the render function (`hfy-sync-render`).
- Common flags: `--table <app-table>` (default `hfy-app`) and `--region <region>` (default `us-west-2`). Every command takes exactly one of `--dry-run` or `--apply` (each given once). `pause --all` and `resume --all` are accepted and change nothing: the switch is store-wide. `--help` prints the usage.

## Pause and resume the store

`pause` sets `SYNC#HEAD.writes_enabled` to `false`. From then on `applyBatch()` refuses every origin with `503 sync_paused` (the desktop push, the web editor, proposals, graduation, moderation). The conflict queue keeps working. `resume` sets it back to `true`.

```sh
cd api
node scripts/sync-admin.mjs pause --dry-run --table <app-table> --region <region>
node scripts/sync-admin.mjs pause --apply --by <your-name> --table <app-table> --region <region>
node scripts/sync-admin.mjs resume --apply --by <your-name> --table <app-table> --region <region>
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
