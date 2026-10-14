# Backfill the contributions ledger

Credit the posts and comments written before the contributions ledger existed, and rebuild every `CSTAT#` counter from the events, so the counts are true when the `contribV1` flag is turned on.

This is a scripted write to the app table. Run `--apply` only after io's go-ahead in the session, recorded with the dry-run output, and with no other process writing contributions while it runs.

## Before you start

- The `hfy-api` code that writes the ledger is deployed to `<app-stack>` ([Deploy the app stack](deploy-the-app-stack.md)). Until it is, new posts and comments carry no event, and the backfill would have to run again. Check the deployed code rather than assume it.
- You have AWS credentials for the app stack's account and region, and read and write access to the app table.
- You are in `api/` with the dependencies installed (`npm ci`).

## Steps

1. Plan. This writes nothing:

   ```sh
   cd api
   node scripts/contrib-backfill.mjs --dry-run --table <app-table> --region <region>
   ```

   The output lists one `event` line per contribution it would credit (kind, event id, the credited member, time, weight and the post or comment id) and one `count` line per counter row it would change, then a `plan:` summary. It prints ids, kinds and counts only, never text.

2. Read the plan.
   - A post is credited at its first publish, taken from its audit history, and a post that is not published now gets a hidden event. A draft that was never published is not credited.
   - A comment is credited at its `created_at`.
   - `already linked` items already carry an event. They are left alone.
3. After io's go-ahead, apply:

   ```sh
   node scripts/contrib-backfill.mjs --apply --table <app-table> --region <region>
   ```

   Each event is written with the `contrib: { id }` link on the stored post or comment in one transaction. The counters are then set to the totals of all events, the ones already there included.
4. Run `--dry-run` again. The summary must read `0 event(s) to create (none), 0 counter row(s) to set`. If it does not, stop and raise it on the record.

## Notes

- Event ids are derived from the time and the item, so a run that stopped part way resumes without crediting anything twice, and a second `--apply` changes nothing.
- The `LINE` cache row is not touched. `D#` day rows older than 800 days are not rebuilt, because they would already have expired.
- A counter row that nothing supports any more is set to 0, once.

Reference: [API: Contributions ledger](../reference/api.md#contributions-ledger).
