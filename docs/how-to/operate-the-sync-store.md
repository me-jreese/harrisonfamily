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
4. **Sweep the copies the render left, when the site bucket is versioned.** The live files still held the removed value until the render rewrote them, and a versioned bucket keeps each overwritten file as a noncurrent version that holds it. Run the same line again after the render, dry run first. A whole-record line needs nothing added. A `--path` line needs `--sweep` (and the same `--replacement`), because the table is already scrubbed and the path is no longer found; without it the run is refused as a typo. The sweep rewrites nothing in the table: it deletes the noncurrent site versions and the old snapshot versions. Skip this step on a bucket that is not versioned: the dry run says so.
5. **Check.** Run the dry run again (with `--sweep` for a `--path` line): the log entries and heads read `0`, and on a versioned bucket so do the noncurrent site versions.

**Record, whole.** The record must already be a tombstone: a live one is refused (withdraw or delete it first). Every `SYNC#LOG` entry of the handle, found through `RECHIST` and the head's own seq, and the head get `obj_json` null and `expunged: true`; `hash` and `seq` stay. The open and decided sync conflicts of the handle lose their values. Then every snapshot under `snapshots/` is deleted with all its versions and the snapshot is rebuilt; the shadow copies (`render-shadow/<site key>`) of the record's file, of the index files and of the pages that embedded it are deleted with all their versions; and, when the site bucket is versioned, the noncurrent versions of those keys are deleted there. The pages that embedded it are found from every stored version of every record, not from the references that are live now: a delete that cleaned a reference away (a Note taken off its Person, a Person taken off its Family) leaves the Person, spouse and family pages out of the live graph, while their earlier versions still hold the text. The script reads the whole `SYNC#LOG` once per run for this, so a run takes longer on a large tree.

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

**What the epoch does.** Every record run raises `SYNC#HEAD.expunge_epoch` by one in the transaction that rewrites the head. The store view in every warm Lambda and the cached snapshot check it, so none of them can keep the removed value in memory or in `snapshots/`.

**Proposal.** `PROP#<ulid>` META and every `IDX#` copy lose the proposal document and their index keys and stay as an expunged stub, so no list or page shows them. The proposal thread's comments and reactions are deleted, the audit rows of those comments keep who, what and when and lose the text they copied, and the comments' photos are deleted from the site bucket with every version. The proposal's own `AUDIT#proposal:<ulid>` rows keep who, what and when and lose `before`, `after` and any decision `reason`. The `IDEM#` receipts whose result echoes the proposal (a create or a decision) are deleted: they are found by one filtered table scan, so the run needs `dynamodb:Scan` and takes a moment on a large table. A system proposal's `PROPREQ#<request id>` item loses its content hash (the id still resolves to the expunged stub, and the request id cannot be reused for a different suggestion). The inbox rows of a decision can hold the reason an admin typed; they expire 90 days after they are read and are not touched.

**Chat.** The chat hub nulls the message text through its admin route, then the `CHAT#<conv>` / `M#<seq>` mirror row is deleted. The hub goes first so that a later archive batch cannot write the text back. Set `CHAT_HUB_ADMIN_URL` (https) and `CHAT_HUB_ADMIN_TOKEN`. The route is `POST <url>/admin/expunge` with `{conv, seq}` and a bearer token; it answers `200 {nulled: 0|1}` or `404` when the hub holds no such message. **That route is a contract this script defines and the chat worker must implement** (`hfy-chat-worker`, which is not in this repo): until it ships, a `--chat` dry run works but `--apply` fails at the hub call before any mirror row is deleted. The hub must keep the message's seq and sender and null only the text, so the conversation order survives. `<conv>:<seq>` is the conversation id, a colon and the seq, for example `g:<id>:42`.

**Upload.** Every version and delete marker of the object under `uploads/posts/` or `uploads/comments/`, and its `UPLOAD#` binding. A post that still names the photo keeps a dangling link: remove the attachment from the post as well.

**Withdraws and the 72-hour grace.** A privacy withdraw tombstones the head at once (no read serves it, the next render removes the files) and writes `EXPUNGE#<Class>#<handle>`, due 72 hours later. Until then `sync-admin resurrect --include-withdrawn` can bring a mistaken mass withdraw back and cancels the schedule. After it, the expunge is queued and runs when io next runs `node scripts/expunge.mjs --due` (dry run, then `--apply`, which needs io's step-up token): **nothing runs it for you, so "72 hours" is the earliest it can happen, not a promise of when.** The privacy text must say "queued after 72 hours and run by io", and io should run `--due` at least weekly; the dry run's first line, `due: N scheduled expunges past the 72-hour grace`, is the overdue count (an overdue alert belongs to the status and alerting task). `--now` takes every scheduled item at once and exists for tests and for a withdraw that must not wait. A schedule item whose record is live again is dropped.

**What it cannot reach.** The DynamoDB point-in-time recovery tail (35 days) keeps older copies of the table until they age out; so do backups taken outside this stack. The graph builder's face crops under `media/faces/` are outside it too (see Media photo). The privacy text and this runbook say so, and nothing here shortens it.

