# Sync errors and exit codes

Every exit code of `hfy-sync`, every error code of the sync API, and the rows that BRD2 section 11.1 added to the sync error catalog (D44 to D52 and S19 to S22). It is the lookup for the operator runbook in [Sync Gramps with the website](../how-to/sync-gramps-with-the-website.md). The map from each catalog row to the tests that trigger it is [Sync error catalog and its tests](sync-error-catalog.md); the commands are in [Install the Gramps sync addon](../how-to/install-the-gramps-sync-addon.md) and [Operate the sync store](../how-to/operate-the-sync-store.md).

A test (`api/test/sync-errors-reference.test.js`, in `cd api && npm test`) reads the sources and fails if an exit code or an API error code is missing from the two tables below. Add a code to the source and to this page together. The API check reads `api/src/sync/*.js` for a status followed by a quoted code, or by a ternary whose two arms are quoted codes; a code built in a variable or thrown through a helper is outside its reach. Another test fails if a code with the prefix `sync_`, `seed_` or `session_`, or `tree_mismatch` or `store_not_seeded`, is thrown outside that folder; any other code thrown outside it is not checked.

## Exit codes

The wrapper `gramps/bin/hfy-sync` exits with the `exit_code` in `~/Library/Application Support/hfy_sync/<dbid>/status.json`, which holds counts and codes only. The constants are the `EXIT_*` names in [`gramps/hfygramps/addon/consts.py`](../../gramps/hfygramps/addon/consts.py). Never paste any file other than `status.json` into an agent session.

<!-- sync-exit-codes:start -->

| Code | Constant | Meaning | `next_action` |
| --- | --- | --- | --- |
| `0` | `EXIT_OK` | In sync, or the changes were applied | none |
| `10` | `EXIT_DRY_RUN_CHANGES` | A dry run found changes, or `--plan <run_id>` found a different plan than the one reviewed | `review_preview` |
| `20` | `EXIT_PARTIAL` | Partial: a conflict is parked (a pulled change that would leave a dangling reference or a one-sided link is parked as an integrity conflict that names the class and the Gramps ID, D19), a field is held, a delete waits for a step-up, or a change was skipped as a privacy incident | `resolve_conflicts`, `review_incidents`, `step_up` |
| `64` | `EXIT_USAGE` | Usage: a wrong option or action, `--force-unlock` (D02), or a named plan or backup that does not exist | none |
| `65` | `EXIT_SERVER_REFUSED` | The server refused data for privacy or integrity (D24, D25), a snapshot failed verification, or the relationship check inside the pull's transaction failed (the D19 backstop; nothing was applied) | open the preview |
| `69` | `EXIT_NOT_ENABLED` | Sync is paused (the kill switch, D27) or not enabled | none |
| `70` | `EXIT_INTERNAL` | An internal error, or `status.json` is missing or belongs to another run (D41) | read the log |
| `75` | `EXIT_TEMPORARY` | Temporary: the tree is open in Gramps (D01), an edit window is open (D45), another run holds the lock (D14), no disk space (D15), the network or the cloud moved (D08, D22) | `retry`, `close_gramps` |
| `77` | `EXIT_SIGN_IN` | Sign-in or step-up is needed (D06, D07), or the Keychain is locked (D42) | `login`, `step_up` |
| `78` | `EXIT_CONFIG` | Configuration: the wrong tree (D03), an unsupported schema (D04), an addon that is too old (D05), the sync state missing or damaged (D12, D13), the cloud tree changed (D50) | `open_bound_tree`, `update_addon`, `rebase`, `bind` |

<!-- sync-exit-codes:end -->

## API error codes

The sync routes answer a flat body, `{error: "<code>", message, details?}`, with the status below. `details` holds pointers, classes and opaque handles, never a value. The desktop maps the status and code to the row it acts on.

<!-- sync-api-codes:start -->

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `validation` | The request or an object does not match the schema; `details.violations` or `details.fields` point at the field |
| 400 | `bad_cursor` | A change-feed or pull cursor is malformed |
| 401 | `unauthenticated` | No valid bearer token |
| 401 | `step_up_required` | A conflict decision needs a sign-in within 300 seconds (`details.reason` `conflict_decision`); the page answers with a fresh sign-in |
| 403 | `step_up_required` | A destructive batch needs a fresh step-up (`amr` `mfa` within 300 seconds); nothing is written (D07) |
| 403 | `not_owner` | The caller is not in `gramps-owner` |
| 403 | `not_allowed` | The status page is for the people who look after the site only |
| 403 | `tree_mismatch` | The request names a cloud tree that is not the current one (after a recovery or re-seed, D50) |
| 404 | `not_enabled` | The sync API or the change feed is switched off |
| 404 | `not_found` | The object or snapshot does not exist |
| 404 | `session_not_found` | The push session does not exist or has expired |
| 404 | `no_blob` | There is no blob for this media object |
| 409 | `already_bound` | The cloud store is already bound to a tree |
| 409 | `not_bound` | Bind the tree before opening a push session |
| 409 | `already_resolved` | The conflict was already decided |
| 409 | `not_resolved` | The conflict is not decided yet, so it cannot be applied or acknowledged |
| 409 | `conflict` | A client instance record belongs to another principal |
| 409 | `version_conflict` | An op's `base_version` is stale (D22); `details.conflicts` lists the current versions |
| 409 | `exists` | A create names a handle that already exists |
| 409 | `session_open` | A push session is already open (D48) |
| 409 | `session_closed` | The push session is closed: a batch into a complete or aborted session, a complete of an aborted one, or an abort of a complete one, is refused (a repeat of the same close is not an error); nothing is written |
| 409 | `session_expired` | The push session is past its 7 days (D48): a batch into it, or a complete of it, is refused; it can still be aborted |
| 409 | `redaction_version_mismatch` | The addon's redaction version differs from the server's (D05) |
| 409 | `gid_conflict` | A Gramps ID guard condition failed in the transaction |
| 409 | `gramps_id_taken` | The Gramps ID belongs to another object (D26) |
| 409 | `gramps_id_retired` | The Gramps ID of a deleted, withdrawn or merged person is retired for good (D44) |
| 409 | `reserved_id_block` | The desktop used an ID from the block the website mints from (D26) |
| 409 | `id_block_exhausted` | The website's ID block has no free number |
| 409 | `renumber_blocked` | A person's Gramps ID cannot change (D35) |
| 409 | `merges_disabled` | Person merges are held (`merges_enabled` is false, D51) |
| 409 | `assign_desktop_only` | Only the desktop assigns a Gramps ID to an object that has none |
| 410 | `gap_too_large` | The change feed cannot cover the gap; do a full pull |
| 413 | `batch_too_large` | The batch or an object is over the size limit (D40) |
| 422 | `integrity_violation` | A reference does not resolve or a link is one-sided (D25); rules in `details.violations` |
| 422 | `privacy_violation` | An object holds something that never goes to the cloud (D24); rule and pointer, never the value |
| 422 | `withdrawn_reference` | A web write references a withdrawn handle |
| 422 | `unknown_class` | The class of an object is not known |
| 422 | `idempotency_key_reused` | The key was used with another payload (D28) |
| 422 | `blob_mismatch` | The uploaded blob does not match its checksum or size |
| 422 | `blob_not_uploaded` | The Media op names a blob that was never uploaded |
| 426 | `upgrade_required` | The addon is too old (D05) |
| 428 | `idempotency_key_required` | A write came without an `Idempotency-Key` |
| 500 | `id_policy_misconfigured` | The ID policy settings are wrong; an operator fixes them |
| 503 | `sync_paused` | Writes are paused (`writes_enabled` is false, D27) |
| 503 | `store_not_seeded` | The store has no seed yet, so only the seed origin may write |
| 503 | `retryable` | A transient store fault; retry with the same key (D08) |
| 503 | `unavailable` | Snapshots or blob transfers are not configured on this deployment |

<!-- sync-api-codes:end -->

The write path's content refusals and their rules have one named test each: see [The wire codes](sync-error-catalog.md#the-wire-codes).

## Rows added by BRD2 section 11.1

The catalog (52 desktop rows, D01 to D52, and 22 cloud rows, S01 to S22) is in [Sync error catalog and its tests](sync-error-catalog.md). These are the rows the second design pass added. D07 and D19 were repaired: D07 asks for the step-up in the same run, just before the parked deletes; D19 reports a dangling reference as an integrity conflict that names the class and the Gramps ID.

| ID | Failure | Behaviour | Recovery |
| --- | --- | --- | --- |
| D44 | Gramps reused a retired website person ID | Held before sending: "Gramps reused a retired website ID; renumber this new record" | Renumber the new local record |
| D45 | A Gramps edit window is open at Apply (GUI) | Apply is refused, exit `75` | Close the edit windows and run again |
| D46 | A restore from a backup is needed | `hfy-sync restore <backup>`: Gramps closed, lock absent, sha256 checked, journal, WAL and lock moved aside, `integrity_check`, the matching sidecar restored, then a dry-run check | Review the dry run |
| D47 | A push would revert a website change (after a restore, an Undo or a stale editor) | Labelled "reverts a website change"; the GUI asks to confirm; the CLI parks it | Confirm, or keep the website value |
| D48 | `409 session_open`, or an own session left open after the sidecar was lost | Resume the own `session_id` from the outbox, or abort it after confirmation; the server expires sessions after 7 days | None |
| D49 | An outbox entry is `pending`, or a replay was answered `409`, `422` or `410` | The entry is discarded and re-planned; only a `2xx` or `Idempotent-Replayed` response advances the base | None |
| D50 | `403 tree_mismatch` after a cloud re-seed or recovery | Exit `78`; `rebase` re-bases the equal objects and turns the rest into conflicts; nothing is sent | Resolve in the Gramps window |
| D51 | A person merge is held (`merges_enabled` false), a member principal would be merged away, or the "Merged Gramps ID" attribute is not new since the base | Held with guidance; never pushed as a merge | Merge the other way, or wait for `merges_enabled` |
| D52 | A presigned snapshot or media URL expired during the download | Requested again once, then that object is deferred | Run again |
| S19 | Sensitive data was found in the cloud's history | `expunge.mjs` (record, path, proposal, chat, upload), with io's go-ahead and step-up | [Remove something from the cloud](../how-to/sync-gramps-with-the-website.md#remove-something-from-the-cloud) |
| S20 | `IdempotentParameterMismatch` on an internal retry | The retry token is `hash(batch_id:seq_from)`, and validation runs again | None |
| S21 | The render stalled: a skip with no later trigger, a failure in the dead-letter queue, or an alarm with no confirmed subscriber | A 15-minute scheduled re-render; alarms go to io's confirmed email | The operator runs `render --full` |
| S22 | A head mismatch in the daily reconcile, or withdraw-driven deletes above the mass-delete threshold | The `HeadMismatch` alarm; withdraw and `MOD#` deletes are exempt from the guard but alarmed | The operator reviews, then `rebuild-heads` |

## Related

- [Sync Gramps with the website](../how-to/sync-gramps-with-the-website.md): the runbook that uses these codes.
- [Where the family data lives](../explanation/family-data-source-of-truth.md): why the tree and the store both hold the data.
