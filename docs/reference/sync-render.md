# The render Lambda (hfy-sync-render)

`hfy-sync-render` renders the family data site from the cloud record store: `person/`, `family/`, `event/`, `note/`, `place/` and `media/` JSON, plus `person/index.json`, `person/search-index.json`, `place/index.json` and `media/index.json`. It is the only writer of those keys once `RenderMode` is `live` (HFY-PLN-002 sync.md section 11, BRD2 D2-05; HFY-TSK-176). The pure rendering is [`gramps/hfygramps/render/`](../../gramps/hfygramps/render/) (`render_site`); this page covers the Lambda around it. The app stack creates the function, its stream mapping, its schedule and its alarms; this package replaces the no-op placeholder by changing only the `RenderCodeKey` parameter.

Nothing in the Lambda is wired to a flag other than `RenderMode`: `off` is the default and returns at once without an AWS call.

## Where the code is

| Path | What it is |
|---|---|
| [`lambda/hfy-sync-render/handler.py`](../../lambda/hfy-sync-render/handler.py) | The entry point, `handler.handler`. Builds the boto3 adapters, runs one pass, answers a stream batch with `{"batchItemFailures": []}`. |
| [`lambda/hfy-sync-render/hfy_render/engine.py`](../../lambda/hfy-sync-render/hfy_render/engine.py) | One pass: session guard, store view, render, privacy re-check, diff, guards, writes, manifest, report, cursor and outbox, daily reconcile. |
| [`hfy_render/view.py`](../../lambda/hfy-sync-render/hfy_render/view.py), [`refs.py`](../../lambda/hfy-sync-render/hfy_render/refs.py) | The store view fold of `SYNC#LOG`, and the reference walk (a port of `collectRefs` in `api/src/records/semantics.js`) that maps a change to the people it can alter. |
| [`hfy_render/privacy.py`](../../lambda/hfy-sync-render/hfy_render/privacy.py) | The re-check of every output file. |
| [`hfy_render/keys.py`](../../lambda/hfy-sync-render/hfy_render/keys.py) | Which keys the renderer owns. |
| [`hfy_render/errors.py`](../../lambda/hfy-sync-render/hfy_render/errors.py) | Failure rule ids, and the rule that no message leaves a pass. |
| [`hfy_render/aws.py`](../../lambda/hfy-sync-render/hfy_render/aws.py) | The only module that imports boto3: the DynamoDB table, S3 bucket and CloudWatch adapters. |
| [`scripts/ci/package-render.sh`](../../scripts/ci/package-render.sh) | Builds `dist/hfy-sync-render.zip` and prints the `RenderCodeKey`. |
| `gramps/tests/unit/test_render_lambda*.py`, `render_lambda_support.py` | The tests and their in-memory fakes. |

## Settings

| Source | Name | Meaning |
|---|---|---|
| Stack parameter | `RenderMode` (env `RENDER_MODE`) | `off` (default), `shadow` or `live`. Any other value fails loudly. |
| Environment | `TABLE_NAME`, `SYNC_BUCKET`, `SITE_BUCKET`, `METRICS_NAMESPACE` | The `hfy-app` table, the sync bucket, the site bucket and the metric namespace (`HFY/SyncRender`). |
| Invoke payload | `{"source": "schedule"}` | What the 15-minute schedule sends. |
| Invoke payload (operator) | `{"allow_mass_delete": true}`, `{"prune_foreign": true}`, `{"force": true}`, `{"reconcile": true}` | A flag counts only when it is exactly `true`. See [Operator payloads](#operator-payloads). |

Triggers: the table stream (filtered to `SYNC#LOG`; only a wake-up, the log cursor is the truth), the schedule, and an operator invoke.

## Modes

| Mode | Writes to | Manifest | Outbox |
|---|---|---|---|
| `off` | nothing; no AWS call | none | none |
| `shadow` | `s3://<sync-bucket>/render-shadow/<site key>`: exactly what `live` would write | `render/manifest-shadow.json` | none |
| `live` | `s3://<site-bucket>/<site key>` | `render/manifest-live.json` | `SYNC#RENDERED/<seq>` |

The manifests live in the sync bucket and are mode-scoped. Each is `{"version", "mode", "seq", "keys": {key: sha256 hex}}`; a key whose value is `null` is owned but not yet written or verified.

## One pass

1. `RENDER_MODE=off` returns `{"status": "noop"}`.
2. Read `SYNC#RENDER/STATE` and `SYNC#HEAD` (both strongly consistent). An empty store (`seq` 0) skips.
3. **Session guard.** While `SYNC#HEAD.open_session` names an open `SYNC#SESSION#<id>` that is younger than 10 minutes, the pass skips and does not advance. A session of 10 minutes or more counts as abandoned; one of 7 days or more counts as expired. The scheduled run therefore renders an abandoned session within 15 minutes of the 10-minute mark. An open session whose `opened_at` cannot be read is dated from its 7-day `ttl`; with neither, it is treated as young (a half-pushed tree is not rendered), `RenderError` is raised and `last_error` is `RenderFailed:session.opened_at_invalid` until the session is aborted (`POST /api/sync/sessions/:id/abort`) or its TTL delete runs.
4. A pass is due when the mode changed since the last pass (a **first pass** in that mode), `SYNC#HEAD.seq` is greater than `rendered_seq`, or an operator flag is set. Otherwise it skips, and on a scheduled run the daily reconcile may still run.
5. **Store view.** Fold `SYNC#LOG` from seq 1 to the head seq with a strongly consistent Query. Nothing is cached between invocations, so an expunged `obj_json` can never survive in memory. For each object only the newest entry counts; a `delete`, a `withdraw`, a `marker`-only range and an entry whose `obj_json` is null (expunged) leave no object. The fold records which objects the range since `rendered_seq` touched, with their principals, origins and the object as it was before the range.
6. **Render.** `hfygramps.render.render(...)` over the live objects. `generatedAt` in the index files is the `at` of the newest log entry, so a re-render is byte-stable. Media blob facts (`sha256`, `size`, the extension of `s3_key`) come from the Media heads read with `BatchGetItem` (the log entry does not carry `blob`). A Person with an empty `gramps_id` gets no file and appears in no index until an ID is assigned.
7. **Privacy re-check** of every output ([below](#privacy-re-check)). A failing file is not written and not deleted.
8. **Diff.** Compare each output's sha256 with the mode's manifest; write only keys that differ. Keys in the manifest that left the desired set are deletions.
9. **Guards.** Mass-delete guard and key ownership ([below](#guards)).
10. **Write.** Deletes first (an exposure-reducing change should land first), then writes, through a small thread pool. The manifest is saved before the first write (a key being written is owned, content unknown), every 250 completions, and in a `finally`, so a crash can never leave an owned file the next pass would call foreign. The Lambda's remaining time is checked per key; with less than 20 seconds left the pass stops with `timeout.budget`, and the next invocation continues from the manifest.
11. **Report.** `render/reports/<seq>.json` in the sync bucket: counts, and keys and rule ids only, never text.
12. **Advance.** One `TransactWriteItems`: `SYNC#RENDER.rendered_seq` (conditional on the value the pass read) and, in live mode, the `SYNC#RENDERED/<seq>` outbox item. A pass that failed anywhere earlier does not advance, so a retry is idempotent: it writes only what the first attempt did not, and the outbox is written exactly once.

### The first live pass

A pass in `live` mode after any other mode (or with no state) **ignores every manifest**, writes every desired key and verifies each with `HeadObject` in checksum mode (`ChecksumSHA256` must equal the sha256 of the bytes). Nothing that existed before is deleted, because no manifest says the renderer wrote it. Keys under the data prefixes that look like renderer output and are not in the manifest are **foreign**: they are counted in `SYNC#RENDER.foreign_keys` and listed in the report, and never deleted unless an operator passes `prune_foreign` after reviewing them.

If the first live pass cannot finish (the time budget, a failed write), the next one resumes from its own manifest instead of starting over: `SYNC#RENDER.first_live_attempt` and the manifest's `attempt` carry the same value while the attempt is open, and the commit that advances the cursor removes it. A manifest from an earlier live period never matches.

A first pass in any mode writes a **baseline** outbox item (live only), with no people, so a cutover never sends notifications. Every mode change counts (live to shadow and back, or off to live after another mode ran), so record changes made while the site was in the other mode are not notified when `live` returns: the baseline covers them silently. This is deliberate (the site is rebuilt from the store, so nothing is stale); an operator who needs those notifications sends them by hand.

## Graph trigger

After a `live` pass has rendered and committed its cursor, the engine invokes `hfy-graph-render` asynchronously (`InvocationType=Event`, payload `{"source":"render","seq":<seq>}`) when the `GRAPH_RENDER_FUNCTION` environment variable names it. Shadow passes, held passes, push-session skips and `off` never do. A schedule tick (every 15 minutes) that finds the site current (a `current` skip or a reconcile-only pass) also invokes it, because the graph function is idempotent and skips when its marker already matches the head and the hidden-item set; this is how a moderation hide or unhide that does not move the store seq, or a graph pass that was skipped or failed earlier, reaches the graph within one schedule interval. A failed invoke never fails the pass: the cursor has moved and the site is rendered, so it raises the `RenderError` metric and the next live pass (or an operator invoke) starts the graph again. The graph function debounces and skips a seq it has already built; see the [graph README](../../graph/README.md#the-cloud-source-hfy-graph-render).

## Key ownership

The renderer owns exactly these keys, and its writer and deleter refuse any other (a `ProtectedKey` failure, whatever a manifest or listing says):

- `person/<gramps_id>.json`, `person/index.json`, `person/search-index.json`;
- `family|event|note|place|media/<handle>.json`, `place/index.json`, `media/index.json`.

Never touched: `person/index.html` and every other shell file, `person/graph.json` and `person/search-store.json` (the graph builder's), media binaries (`media/<handle><ext>`; only `api/scripts/expunge.mjs --record Media:<handle>` deletes one, with the record's history), `media/faces/*`, `media/tree_*.svg`, `media/.staging/*` and `uploads/*`. A tampered manifest listing such a key is ignored, and the key is dropped from the manifest on the next save.

## Guards

- **Mass-delete guard.** More than `max(10, 10 % of the manifest)` deletions in one pass and the pass refuses every non-exempt deletion, keeps the refused keys owned, does not advance, raises the `MassDeleteGuard` metric and stores `last_error = RenderFailed:guard.mass_delete`. Writes in the same pass still happen. (The design text says the guard refuses all deletes when it trips; the implementation refuses only the non-exempt ones and lets the exempt, exposure-reducing deletes through, which is what AC7 requires and the deliberate reading of that text.) The scheduled run retries and alarms again every 15 minutes until an operator reviews and passes `allow_mass_delete`.
- **Exempt deletions.** A deletion caused by a `withdraw` log entry (the person's file, and the files of the objects only that person's page was built from: families, events, notes, media, places reachable from the person's previous object without passing through another person) or by a moderation hide (the `overlay` hook below) is exempt from the guard, so a withdraw of 15 people renders with no override. Exempt deletions still alarm however few there are: any pass with at least one raises `MassDeleteGuard` once, and the count is in the report (`counts.exempt_deletes`) and the log.
- **Withdraw with a blocked file.** A privacy-blocked file keeps its last good copy, and that copy (`person/index.json`, a search entry, a family file) may still name a person withdrawn or hidden in the same pass. In live mode, when a pass withdraws or hides anyone (a withdraw in the range, an exempt delete, or a first live pass over a store that holds withdrawn people) and any file is blocked, the pass still writes and deletes (the exposure-reducing deletes land) but **does not advance the cursor**: no outbox item, `last_error = RenderFailed:guard.withdraw_blocked`, status `blocked`. `RenderPrivacyBlock` fires on every attempt, and the schedule retries every 15 minutes until the blocked file renders clean or an operator removes the stale copy. Shadow mode is not held (it is not public).
- **Moderation overlay.** The `MOD#` overlay read is not in this package (review DL-15; it belongs to `hfy-moderation-record-targets`). The engine takes an optional `overlay` object with `apply(objects) -> (objects, exempt_delete_keys)`; the default is none. The overlay removes hidden objects before the render, and the keys it returns are the exempt deletions.
- **Foreign keys** are reported, never deleted by default.
- **Access.** The renderer role lists only some prefixes of the site bucket (see the stack's `RenderedDataList`). A prefix it cannot list is recorded in the report as `foreign_unlisted_prefixes` and does not fail the pass; today that is `media/`, so foreign `media/*.json` keys cannot be found by the Lambda.

## Privacy re-check

`render_site` withholds what its text gate flags. The re-check is a second, independent gate over the bytes about to be written (sync.md 5.7), so a regressed rule or a store value in a field the transforms publish unscanned still cannot reach the site. A file fails when:

| Rule id | Meaning |
|---|---|
| `privacy.sort_value` | A `sortValue` or `sortval` key anywhere (the exact Julian day of a full date). |
| `privacy.source_path` | A `sourcePath` key anywhere. |
| `privacy.date_text` | A `date.text` with a day or a month: a month name, `d/m`, `y/m`, or a day-precise date. |
| `privacy.detector.<kind>` | The R-18 detector (`hfygramps.scanner`) found a `phone`, `email`, `street_address`, `po_box`, `contact_url` or `dob_heuristic` in any string value. |
| `privacy.text.<class>` | The live ETL's generic scanner found a `date_day`, `phone`, `email` or `address`. |
| `privacy.identifier_shape` | An identifier field is not shaped like one: `handle` (hex, 16 to 64, or a letter-led slug of 16 to 64 characters), `grampsId` (`^[A-Z]{1,3}[0-9]{1,6}$`), `s3Key` (`media/<hex>.<ext>`), `checksum` (64 hex), `mime` (`type/subtype`), `generatedAt` (an ISO-8601 UTC time). These fields reach the published JSON and the S3 key names, so a phone-like Gramps ID is blocked rather than published. |
| `output.not_json` | The output does not parse. |
| `key.unowned` | The renderer produced a key it does not own (a Gramps ID that is not a file name). |

Identifier fields are checked by shape, not skipped (`privacy.identifier_shape`); a value that has the shape is not scanned as text (a slug-shaped or digits-only `handle` is). Hash-like values (16 to 64 hex characters with at least one letter) and media S3 keys under other keys are not scanned, and `latitude` / `longitude` are not while they are decimal numbers.

A failing file keeps its last good copy on the site (it is neither rewritten nor deleted). Unless the pass also withdrew or hid someone (see [Guards](#guards)), the pass still advances, `RenderPrivacyBlock` is raised with the number of files, and `SYNC#RENDER.last_error` is `RenderPrivacyBlock:<first rule id>`. The next change to the object renders it again.

## Failures carry no message

A stored value can quote a date, a phone number or a note, and so can an exception message. Nothing in a pass keeps one:

- `SYNC#RENDER.last_error` holds `<exception class>` or `<class>:<rule id>`, and `last_error_at`.
- Log lines hold counts, the exception class and the rule id. No log call passes an exception or a traceback.
- The exception that leaves the handler is `RenderFailed(rule id)` raised `from None`, so the Lambda runtime prints the rule id only. A schedule or operator invoke fails with it. A **stream** invocation does not: the stream is only a wake-up (the log cursor is the truth), the pass has already recorded the failure and raised `RenderError`, and the schedule retries, so the handler logs the rule id and answers `{"batchItemFailures": []}` instead of making the event source mapping replay the same records against the same fault. A fault that is not a render failure (a missing setting) is still raised.
- The `RenderError` metric is raised on every failed pass.

## State, outbox and metrics

`SYNC#RENDER` / `STATE`:

| Attribute | Meaning |
|---|---|
| `rendered_seq` | The log seq the site reflects in `mode`. |
| `mode` | The mode of the last completed pass. A different `RENDER_MODE` makes the next pass a first pass. |
| `renderer_version`, `last_full_at`, `last_pass` | Version, time and counts of the last completed pass. |
| `blocked_files`, `foreign_keys` | Privacy-blocked outputs, and foreign keys found, in the last completed pass. |
| `last_error`, `last_error_at` | See above; cleared by a clean pass. |
| `refused_deletes`, `mode_attempted` | Set while the mass-delete guard or the withdraw hold keeps a pass from advancing. |
| `first_live_attempt` | Set while a first live pass is unfinished. |
| `last_reconcile_at`, `last_reconcile_mismatches` | The daily reconcile. |

`SYNC#RENDERED` / `<seq_to, 12 digits>` (live passes only; the only source of record-change notifications, SI-20; TTL 400 days): `seq_from`, `seq_to`, `baseline`, `changed_people`, `changed_count`, `deleted_people`, `deleted_count`, `principals`, `origins`, `entries`, `truncated`, `at`, `ttl`. `changed_people` is the Gramps ID of every live person whose page a change in the range can alter, computed from the store's backrefs: a person maps to itself and to the people of the families that hold them; any other object maps through whatever references it until people are reached; people are terminal, so a change never spreads over the whole tree. `deleted_people` is the people whose last head is a delete or a withdraw. Each list is capped at 10 000 (`truncated`). The consumer ([API: Record-change fan-out](api.md#record-change-fan-out)) dedupes on `rec:<seq_to>:<subject>`, treats a baseline pass, a seed-origin range (one seed entry silences the whole range, on purpose) and an import-marked range as silent, and drops the people a withdraw alone changed.

Metrics, namespace `HFY/SyncRender`, each a count the stack's alarms read: `RenderError`, `RenderPrivacyBlock`, `MassDeleteGuard`, `HeadMismatch`. `MassDeleteGuard` covers the refused-delete guard and any exempt delete; `RenderError` also covers an open session with no usable clock; `last_error` tells them apart.

## Daily reconcile

On a scheduled run, at most once every 24 hours (or on `{"reconcile": true}`), the pass compares the view with the heads: for every class, each head in `GSI1 RECS#<Class>` against the folded head (deleted flag, version, and the sha256 of `obj_json` against the head's `hash`). A head newer than the view's seq is skipped. Each suspect is re-read with a strongly consistent `BatchGetItem` before it counts, because the GSI is eventually consistent. Confirmed differences raise `HeadMismatch`. The stack has no daily rule of its own; the 15-minute schedule carries it.

## Known limits

- The store view folds the whole `SYNC#LOG` on every pass. The desktop snapshot that `GET /api/sync/snapshot` caches at `snapshots/<seq>.jsonl.gz` in the sync bucket (HFY-TSK-174; [API: The pull routes](api.md#the-pull-routes)) could bound that, but the render pass does not read it: it exists only after a desktop pull, it expires after 30 days, and it is valid only while its metadata matches the current `SYNC#HEAD.expunge_epoch`, tree id, redaction and schema versions, so the pass would need that same check to avoid rendering what an expunge dropped. The fold is a strongly consistent Query of the log, which stays small for a family tree. Revisit when the log passes a few hundred megabytes.
- The renderer does not read the `MOD#` overlay (see [Guards](#guards)); until `hfy-moderation-record-targets` supplies an `overlay`, a moderation hide does not change what is rendered.
- `render_site` holds the interim local copy of the redaction rule lists (`gramps/hfygramps/render/policy.py`, `places.py`); replacing them with an import of `gramps/redaction/redaction-v1.json` is still open (the TODO in `policy.py`).

## Operator payloads

| Payload | Effect |
|---|---|
| `{"allow_mass_delete": true}` | Performs the deletions the guard refused. Review `render/reports/<seq>.json` (`refused_deletes`) first. |
| `{"prune_foreign": true}` | Also deletes the foreign keys found in this pass, after review. Never a protected key. |
| `{"force": true}` | Runs a full pass although `rendered_seq` already equals the head seq. |
| `{"reconcile": true}` | Runs the reconcile now. |

`api/scripts/sync-admin.mjs render` sends these payloads for the operator, with `--full`, `--allow-mass-delete` and `--prune-foreign`, and only with io's go-ahead ([Operate the sync store](../how-to/operate-the-sync-store.md)).

## Package and tests

`bash scripts/ci/package-render.sh` builds `dist/hfy-sync-render.zip`: `handler.py`, `hfy_render/`, and from `gramps/` only `hfygramps/__init__.py`, `scanner.py` and `render/`. It checks that the stage imports on its own, builds with fixed mtimes and sorted entries (the same sources give the same bytes), and prints `RenderCodeKey=lambda/hfy-sync-render-<first 12 hex of the zip's SHA-256>.zip`. A code change is a new key. `bash scripts/infra/test/run.sh` checks the package (contents, key, reproducibility, import from the zip alone).

`python3 -m unittest discover gramps/tests/unit` runs the renderer tests with the standard library only (the boto3 adapter tests skip when boto3 is not installed). The pass runs unchanged over in-memory fakes of the table and buckets. A local run on the fixture store (`test_live_reproduces_the_golden_site`) loads the projected synthetic tree as a store, runs a live pass, and requires the site bucket to equal `render_site` on the same tree byte for byte, and the legacy ETL golden to differ only where `expected-deltas.json` says so.

Shipping is release group RG-4 ([Deploy the app stack](../how-to/deploy-the-app-stack.md#ship-the-real-renderer-hfy-tsk-176)): only `RenderCodeKey` changes, and `RenderMode` stays `off`.
