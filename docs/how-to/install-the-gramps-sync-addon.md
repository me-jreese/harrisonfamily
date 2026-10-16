# How to install and run the Gramps sync addon

Use this page to put the `hfy_sync` addon into Gramps on the Mac that holds the family tree, check that it sees the tree, and bind the tree to the website. The addon is the desktop half of the sync design (HFY-PLN-002). This build is the skeleton (HFY-TSK-179) with the sign-in (HFY-TSK-180), the pull (HFY-TSK-205) and the push (HFY-TSK-206): it installs, reports status, binds a tree, signs you in to the website, shows and applies what the website changed, restores a backup, pushes the tree's changes, and refuses unsafe starts. It sends nothing until you run `push --yes` against a website whose cloud store has been bound to this tree, so installing it, and every other action on this page, changes nothing on the website.

## Before you start

- **Gramps.app 6.0.6** in `/Applications`. The addon registers for Gramps 6.0 and database schema 21 and refuses anything else (error D04).
- **This repository** checked out on that Mac, and `python3` and `zip` on the path (both ship with macOS).
- **Gramps closed** for the command-line steps. The tree must not be open in the Gramps window: the command line refuses a tree with a `lock` file.

## Steps

### 1. Install or update the addon

```sh
cd <repo>
gramps/scripts/install-addon.sh
```

The script builds `gramps/dist/hfy_sync-<version>/` and replaces `~/Library/Application Support/gramps/gramps60/plugins/hfy_sync` with it. Nothing else in the plugins folder is touched. Run it again after every update of the addon. To try it without touching Gramps, pass a throwaway folder: `gramps/scripts/install-addon.sh --dest <folder>`.

Restart Gramps. The tool is under **Tools > Family Tree Processing > Website sync...**.

### 2. Check that the command line sees the tree

With Gramps closed:

```sh
gramps/bin/hfy-sync status --tree "<tree name>"
```

The first line reads `hfy-sync status: ok (exit 0)`. `<tree name>` is the name in Gramps' Family Trees manager. The same run is `Gramps -O "<tree name>" -a tool -p name=hfy_sync,action=status`; the wrapper adds a run id and turns the result into an exit code. To save typing the tree name, export `HFY_SYNC_TREE`, or bind the tree (below), after which it comes from `config.json`.

### 3. Bind the tree

```sh
gramps/bin/hfy-sync bind --tree "<tree name>"          # a dry run: exit 10, nothing written
gramps/bin/hfy-sync bind --tree "<tree name>" --yes    # writes the marker, the sidecar and config.json
```

Binding writes a small marker into the tree (inside one Gramps transaction, together with the sidecar that remembers it), creates `~/Library/Application Support/hfy_sync/<dbid>/state.sqlite`, and writes `~/Library/Application Support/hfy_sync/config.json`. Nothing is sent to the website. In the Gramps window, **Website sync...** shows the status and offers the same bind. Binding twice does nothing the second time.

### 4. Sign in

With Gramps closed:

```sh
gramps/bin/hfy-sync login --tree "<tree name>"
```

Your browser opens the website's sign-in page. Sign in as the tree's owner and approve; the page then says you can close the tab. The addon waits five minutes. The refresh token is kept in your login Keychain, in an item that only the Python inside Gramps (and the `security` tool that created it) may read without a prompt. The short-lived access token is never stored. If macOS asks to unlock the Keychain, unlock it and run the command again (exit 77). `login --step-up` asks for a fresh sign-in and a second factor; the website requires it for deletes and rebinding. A token that has gone unused for 30 days expires, and the next run says `login`.

If the sign-in fails with a certificate message (exit 78), do not work around it: the Mac's trust file is `/etc/ssl/cert.pem`, and the addon never turns verification off.

### 5. See what the website changed

With Gramps closed:

```sh
gramps/bin/hfy-sync check --tree "<tree name>"
```

`check` downloads the website's snapshot, verifies it (its sha256, its header, the tree it names, the database schema and the redaction version), and compares it with your tree and with what the last sync left in the sidecar. It writes a preview file, `~/Library/Application Support/hfy_sync/<dbid>/previews/<run id>.json`, and nothing else: your tree, the sidecar's base and the website are unchanged. (Gramps itself rewrites `sqlite.db` on every open, because it stores a Python set in its metadata in a random order; `hfy-sync` starts Gramps with `PYTHONHASHSEED=0`, so a look-only run leaves the file byte for byte the same. A Gramps window you open yourself does not, and the first open after an install can rewrite it once.) The command line prints the run id and counts only (`status.json` holds the same counts); the preview file holds, for each object, where it differs and the values the website would carry, so it is family data. Read it yourself, in an editor. Do not paste a preview, a backup or a log into an agent session. Exit `10` means there are changes to apply; `0` means the two sides agree; `20` means something needs a person (a conflict, a privacy incident, a change held back). A snapshot older than the last one you pulled is refused (the website was restored from an older state), so a rollback on the website's side can never overwrite your tree.

### 6. Apply the website's changes

```sh
gramps/bin/hfy-sync pull --tree "<tree name>" --yes
```

(`sync --yes` is the same in this build: it runs the pull half only and sends nothing. Send the tree's changes with `push`, in [section 9](#9-push-the-trees-changes).) In order, the run downloads and verifies the snapshot (or, with the change feed on, rebuilds it from the cache and the website's changes, see below), plans, and writes the preview; downloads the files of new or changed media into the `media_root` of `config.json` (each is checked against the website's SHA-256, MD5 and size, and then for a GPS location; a photo that carries one is not written, its details still sync, and the sidecar's `holds` table says `media.exif_gps.hold`); takes a backup; re-reads every object it will touch (if you edited one meanwhile, it plans again); and applies every change in **one Gramps transaction**, "Website sync: pull seq N". In the Gramps window that transaction is a single entry under **Edit > Undo**. Undo puts the tree back, but the next sync would then offer to push those values to the website again: it labels such a change "reverts a website change (origin)", and the command line parks it, in `push` as well as in `check`. Prefer **Restore backup** (below) to undo a pull. Any failure inside the transaction rolls all of it back.

What a run never does on its own:

- It does not decide a conflict. A conflict (you and the website both changed the same field, a website change to the year of a birth you hold a day and month for, a website delete of an object that holds desktop-only data) leaves both sides as they are and stays open on every later run until the two sides agree or you decide it in the Gramps window. The command line parks it and exits `20`.
- It does not apply a website decision unless the website's value is still the one it was made against ([Web decisions on a pull](#web-decisions-on-a-pull)).
- It does not apply a website delete. A delete needs `--allow-deletes`, and more than 10 deletes or 5 % of the tree are never applied by the command line.
- It does not apply a pulled object that shows a date of birth you hold. Every pulled object is scanned for the dates of birth in your tree. A hit is skipped, counted as a privacy incident (`privacy_incidents` in `status.json`, counts only), and offered as a withdraw-and-expunge push, which `push` does not send yet. Exit `20`, `next_action: review_incidents`.
- It does not push a value the website scrubbed. If the website scrubs an object in place (the same version, a different hash), the sidecar follows the website and your local value is held, so it is never sent back.

#### Web decisions on a pull

The owner can decide a parked conflict on the website (`/admin/sync/`: keep the website's value, or keep the desktop's). The decision stores the version of the website's record and a hash of the website's values at the conflict's paths when it was made (SI-30). Every `check`, `pull` and `sync` asks the website which decisions are waiting (`POST /api/sync/conflicts/reconcile`), and applies one **only while the website's value is still the one it was made against**:

| The website's record | What the run does |
| --- | --- |
| Is the version the decision names, with the same values at the conflict's paths | Applies it. `keep website`: your value at that path is replaced by the website's. `keep desktop`: your value stays and goes up in the next `push`. Either way the conflict closes (`decision` is recorded in the sidecar). The run sends the website a receipt for `keep website`; for `keep desktop` the receipt waits for the `push` that carries your value, so a push that fails leaves the decision pending (the run shows it as `held`, reason `awaiting_push`) |
| Has a newer version (`version_changed`), has other values at the same version, for example after a scrub (`value_changed`), or the decision carries no hash to check (`no_hash`) | Applies **nothing**. The website reopens the conflict (open again, with the old decision kept in its history, and the note "cloud value changed" on `/admin/sync/`), and your conflict stays open |
| Agrees with the website's answer but not with the snapshot this run planned from | The decision is held for this run (`held`, reason `changed_since_check`) and checked again on the next |

The decision is applied the way a change is: the run plans again with the decided conflict closed in the direction chosen, so the preview, the backup, the one Gramps transaction and the sidecar update are the ordinary ones, and a run with `--plan` needs a preview that already shows it. A conflict that still conflicts after the decision (a birth date with a day and month only you hold, or a value you changed again) is `held` with the reason `conflict_remains` and stays open for the Gramps window. A decision about a conflict that the desktop knew and has closed (you made the two sides agree first) is receipted as `moot`. A decision about a conflict the desktop has no record of at all is not dropped: it is `held` with the reason `no_local_conflict`, shown in the preview and offered again on the next run. A conflict on a whole object (a delete against an edit) is `held` with the reason `whole_object` and is resolved in the Gramps window. The website weighs at most 50 decisions per call and the add-on keeps asking while it says there are more.

Where to read it: the preview file has a `decisions` list (`id`, `decision`, `status` of `applied`, `reopened`, `held` or `moot`, `reason`, the paths and the desktop conflict ids; ids and words, never values), and a `check` lists what it would do (`applied` means "would apply") and `reopened` what a real run would reopen, without changing the website. After a real run the sidecar keeps the last report in `meta.web_decisions` (counts, and the reopened and held ones) and links each desktop conflict to the website's in `conflicts.cloud_conflict_id`. The run log has one line, `decisions: applied=… held=… moot=… reopened=…`. A website that does not have the route, or does not answer it, is skipped with one log line (`decisions: skipped (<code>)`) and the pull goes on.  This behaviour is in the add-on version that has `decisions.py`; an add-on installed before it never reads a decision, and an update reaches a Mac only through the seed-and-shadow copy or an update you run ([step 1](#1-install-or-update-the-addon)).

#### Delta pulls (the change feed)

When the website's store has the change feed switched on ([Operate the sync store](operate-the-sync-store.md#switch-the-change-feed-on-or-off)), steps 5 and 6 do not download a full snapshot every time. The addon keeps the last cloud state it built (`cache/snapshot-<seq>.jsonl.gz` and `cache/cloud-state.json` in the tree's state folder) and asks `GET /api/sync/changes` only for what came after it. The state it rebuilds hashes to the same `body_sha256` a snapshot at that seq would carry (a record the website expunged stays a tombstone that says so), so the preview, the plan hash and everything after them are the same as with a snapshot. `status.json` says which route a run took in `cloud.via` (`delta` or `snapshot`); the key is absent while the feed is off.

The run falls back to a full snapshot, with the reason as one word in `logs/<run id>.log`, when it has no cache or the cache is damaged (`no_cache`, `cache_invalid`), the website's expunge epoch changed (`expunge_epoch`), a seq or version does not follow the cache (`gap`), an object does not hash to its op (`hash_mismatch`), an op was scrubbed (`expunged`), the feed answered `400`, `404` or `410` (`feed_<code>`) or kept failing with `429` or `5xx` after the retries (`feed_unavailable`), or its answer was not the documented shape (`bad_feed`, `no_progress`). Every 7th sync (six deltas, then one) downloads the full snapshot anyway and checks the replay against it; the log says `delta verify ok`, or `delta verify MISMATCH` when the two differ, in which case the snapshot is used and replaces the cache. To stay on snapshots whatever the website offers, set `"changes_feed": false` in `config.json`.

### 7. Review, then apply (headless)

```sh
gramps/bin/hfy-sync check --tree "<tree name>"            # the line it prints names the run id; read the preview of that run
gramps/bin/hfy-sync sync --tree "<tree name>" --yes --plan <run id>
```

`--plan` applies only when the changes now equal the ones in that preview. If the website or the tree moved since you reviewed it, the run applies nothing and exits `10`; run `check` again and review the new preview.

### 8. Restore from a backup

Every apply keeps a backup under `~/Library/Application Support/hfy_sync/<dbid>/backups/`: `<UTC time>-<action>-seq<N>.sqlite`, `.sidecar.sqlite` (the sidecar of that moment) and `.sha256`. Quit Gramps, then:

```sh
gramps/bin/hfy-sync restore <backup name> --tree "<tree name>"
```

The backup name is the file name without `.sqlite`. The command refuses unless Gramps is closed and `<tree folder>/lock` does not exist. It checks the sha256 of the backup and of its sidecar copy, takes `state.lock`, moves `sqlite.db`, `sqlite.db-journal`, `-wal`, `-shm` and `lock` to `pre-restore-<time>/` in the tree folder, copies the backup in, runs `PRAGMA integrity_check` (and puts everything back if that fails), restores the sidecar saved with the backup, and then runs a dry-run `check`. The database and the sidecar always travel together: a database restored without its sidecar would show everything the website changed since as your edits. The check after a restore shows the changes the website still has to give you again, and sends nothing; it exits `10` when there are some. In the Gramps window, **Website sync... > Restore backup...** tells you the same command, because a running Gramps holds the tree.

### 9. Push the tree's changes

With Gramps closed and the website's sync switched on and bound to this tree (read [section 5](#5-see-what-the-website-changed) first to see what the website changed, and [section 6](#6-apply-the-websites-changes) to take it):

```sh
gramps/bin/hfy-sync push --tree "<tree name>"                         # a dry run: exit 10 when there is something to push, nothing sent
gramps/bin/hfy-sync push --tree "<tree name>" --yes                   # sends it
gramps/bin/hfy-sync push --tree "<tree name>" --yes --allow-deletes   # and the deletes, if you have a fresh step-up
```

The dry run writes `previews/<run id>.json` in the sync state folder: what would be created, updated or deleted, what is held, blocked or in conflict, by class, handle and path only, never a value. The real run sends batches of at most 24 objects, in dependency order. When it takes more than one batch, or the website has not been seeded yet, it opens a push session and completes it at the end. Every batch is written to the sidecar's outbox before it is sent, so if the answer is lost the next run sends the same batch again under the same key and the website answers from what it stored.

Only the redacted form of each object is sent. Phone numbers, mail addresses, street addresses and exact birth days and months stay on the Mac (sync.md section 5; `docs/reference/redaction-policy.md`). A run that holds something ends with exit `20`; the sidecar's `holds` table says which object and which rule, and the run log lists counts only.

**Photos and documents.** A Media object goes up as its details and its file. The addon reads each file from the path Gramps shows (a relative path is read under the tree's base media path), takes its MD5 and SHA-256, and sends the MD5 of the file itself as the object's checksum, so a stale checksum in Gramps never reaches the website (the preview lists such a file under `warnings` as `media_checksum_stale`; nothing in Gramps changes). The file is uploaded to a staging key with a signed SHA-256 just before the batch that names it, and the website moves it into place only after that batch commits, so a conflicting or refused batch never shows new bytes with old details. A file the website already holds (the sidecar's `media_local` row says so) is not uploaded again. A file that cannot go does not stop the push: its details sync and the sidecar's `holds` table says what to do, with these rules. `media_blob_empty` (0 bytes) and `media_blob_placeholder` (a Dropbox online-only file): in Dropbox, mark the media folders "Available offline", then push again; the next run uploads the file. `media_blob_missing` or `media_blob_unreadable`: fix the path or the permissions in Gramps. `media_blob_unsupported` (the website takes JPEG, PNG, GIF, TIFF and PDF; HEIC and WebP are not accepted) and `media_blob_too_large` (over 25 MB). `media.exif_gps.hold`: the photo carries a GPS location, so the whole Media object stays on the Mac; remove the location info from the file (for example by exporting a copy without metadata), then push again. A PDF is held too (`media.pdf.hold`) until io releases it. A good file on the website is never replaced by an empty or online-only one: the details go and the website keeps the file it has. A file that cannot be uploaded after one more try (`media_upload_failed`) holds only that Media and the records that refer to it; run the push again.

**Deletes.** The website accepts a delete only after a fresh sign-in with a second factor. Run `gramps/bin/hfy-sync login --step-up`, then push within five minutes with `--allow-deletes`. Without the step-up, with the flag missing, or for more than 10 deletes (or more than 5 % of the synced objects) the deletes are parked: nothing is sent for them, the rest of the push goes, and the run ends with exit `20`. The command line never pushes a mass delete; do that from the Gramps window.

**Things the push will not do.** It does not renumber a person who is already on the website (restore the old ID in Gramps; an ID the website holds as empty can be assigned once). It holds a new record whose ID is in the website's own block (`I8000` to `I8999`, and the same range for other classes) and a new person who reuses the ID of a deleted one ("Gramps reused a retired website ID; renumber this new record."): give the new record a different ID and run again. It holds a person merge until the website says merges are on, and never pushes a merge that would merge away a signed-in family member ("Merge the other way"). The push finds a merge by the `Merged Gramps ID` attribute on the surviving person (a new one since the last sync) next to the deletion of the person with that ID. A merge is only pushed from the Gramps window, with a fresh sign-in. Until the website lists the signed-in members in its handshake, a merge is held as unverifiable; list them yourself under `member_person_ids` in `config.json` (Gramps IDs, for example `["I0001", "I0002"]`) to allow it.

**A change that undoes a pull.** A change that puts a field back to the value one of your last 5 pulls replaced (after **Edit > Undo** of a pull, say), a delete of an object a pull created, or a create of one a pull deleted, is "reverts a website change (origin)". The command line never sends it, with or without `--yes` or `--allow-deletes`: the run ends with exit `20` and the sidecar's `holds` carry `revert_parked` for the object. Keep the website's value in Gramps (**Restore backup** takes a pull back cleanly), or send the change from the Gramps window, where you confirm it.

**If the website changed something too.** Changes to the same object on both sides merge field by field. A change to the same field on both sides, a type change on a birth-like event, or a birth year change over a local day and month is a conflict: the command line parks it (exit `20`, `next_action` `resolve_conflicts`), the desktop value stays, and the website value is what is sent. The conflict stays open on every later run, pull or push, until the two sides agree or you decide it in the Gramps window. A push never puts back a value that the website scrubbed in place (the pull records those as `expunge.notice` holds). A push that meets a website edit made while it ran stops with exit `75`; run it again.

### 10. Use the Website sync window

Open the bound tree in Gramps and choose **Tools > Family Tree Processing > Website sync...**. The window does what sections 5, 6 and 9 do, with a preview you can read and answers you can give, in one run. It needs the sign-in of [section 4](#4-sign-in); **Sign in...** in the window does it for you.

The header names the tree, the website, who you are signed in as, the last sync and the website's version (`seq N`, with a tick when the site has been rendered up to it). **Check for changes** reads the website again and rebuilds the preview, **Open backups** opens the backups folder and **View log** shows the newest run log (step names and codes, never a value). **More...** has "Restore backup..." (which tells you the command to run with Gramps closed) and "Rebase after a recovery...".

Below the header are five sections, each with a count, and each row opens to the field-level differences:

| Section | What it lists |
| --- | --- |
| From the website | What **Apply** will change in this tree: new, changed and deleted records, with each field as it was at the last sync and as the website has it now. |
| To the website | What **Push** will send: the projected change per field. A delete waits for your confirmation and a fresh sign-in; it says so on its row. |
| Conflicts | Each conflict with three columns: the base, the website and **yours**. Yours is read from the database while the window is open, so it shows a day and month, or a street-level place, that never leaves this computer (the website columns come from the preview file, which holds only what the website may see). Choose **Keep mine**, **Take website** or **Skip for now** for each one. A date conflict where the website changed the year of a birth you hold a day and month for offers three: **Keep mine**, **Take the website year and keep my day and month** (the default) and **Take the website value and clear my day and month**, which asks you to confirm. A website delete of a record you edited offers keep mine (the record is created again on the website) or delete here (confirmed). |
| Held back | What the redaction policy keeps on this computer (a phone number in a note, a street address, a held photo), a photo or document from the website whose file was not saved here (it carries a location, or it is empty) and stays listed until it has a file in Gramps, a file or record the last sync could not send (with the reason, and "run the push again"), and any event that was once a birth and still has a day and month: those say "Release day and month..." and, once you confirm, the next push publishes them. A push that would publish a day and month on such an event is flagged here and is not sent until you release it. |
| Blocked | What cannot be sent or applied until something else changes: a person's renumber, a merge of a signed-in member, a record a privacy check kept out, a record waiting for a media file. |

A person's name in a row is a link to that person's page on the website. It has no underline in any state and looks like the text around it; Tab reaches it and shows the focus ring. A record with no Gramps ID shows the name as plain text.

**Apply 3 · Push 5** does the whole thing in one run, in this order:

1. If any Gramps edit window is open (a person, family, event or any other editor), the window stops with "close open edit windows to sync". Close them and press the button again. Nothing was requested or changed.
2. Each choice that needs a confirmation asks for it, then, if you chose anything other than **Skip for now** for a conflict, the window says how many conflicts it is about to decide and how many of them send your value over the website's (**Keep mine** is the default for a plain field, so pressing the button without touching a conflict decides it as keep mine; set **Skip for now** to leave one open). Incoming deletes, a mass of them (more than 10 records or 5 % of the tree) and the outgoing deletes, reverts and merges each get a list with every record they cover; declining leaves them out.
3. The pull applies, with your decisions carried out in the same plan: a backup first, then one Gramps transaction, one **Edit > Undo** entry. If the website changed since the preview, nothing is applied and the window says to check again.
4. If deletes are going out and the sign-in is older than five minutes, the window asks you to sign in again, then sends the delete batches first and the rest after, so the five-minute window cannot lapse during a long push.

The window runs a check, an apply and a sign-in on Gramps's main thread, because the database handle must not leave it, so it does not repaint while a slow request runs (it shows "Checking the website..." or "Working..." first). **Open backups** opens the folder in Finder, and tells you the folder's path when the system cannot open it.
5. A banner shows the counts, the backup path and the undo warning: undoing the sync will revert those changes on the website at the next sync.

The window never stores a value it shows, and the command line never prints one: previews, `status.json` and logs hold ids, paths and counts, and the preview's values are projected (no local-only part).

How the window was checked: `python3 -m unittest gramps/tests/unit/test_addon_review.py` drives the same flow without Gtk; `gramps/tests/gramps/run.sh test_addon_gui.py` draws it over a fixture-tree copy and renders offscreen screenshots (`HFY_GUI_SHOTS=<folder>` keeps them), and checks the edit-window refusal with real Gramps editor objects; `gramps/tests/e2e/run.sh scenario_gui.py` runs the flow against the dev server and greps its request log. Screenshots from those runs are worker-rendered evidence of the layout. The manual UAT on a fixture copy is io's G-uat handoff (or a computer-use step on io's Mac), and the evidence for it says which.

## Exit codes

The wrapper exits with the `exit_code` in `~/Library/Application Support/hfy_sync/<dbid>/status.json`, which holds counts and codes only.

| Code | Meaning | What to do |
| --- | --- | --- |
| `0` | Done, or nothing to do | None |
| `10` | A dry run found changes (a `bind`, `pull` or `push` without `--yes`, or `check`), or `--plan` found a different plan | Read the preview; run again with `--yes` (and `--plan <run id>` for a pull) if the plan is right |
| `20` | Partial: a conflict is open, a pulled object was skipped as a privacy incident, a change was held back, a push finished with something held, blocked, parked or in conflict, or desktop changes are waiting to go (`sync` only pulls: run `push`) | `next_action` says which: `resolve_conflicts`, `review_incidents`, `review_preview`, `step_up` or none. After a push read `<dbid>/status.json` for the counts and the sidecar's `holds` for the rules; `login --step-up` for parked deletes |
| `64` | `--force-unlock` was given, the options were wrong, or `--plan` or `restore` named something that does not exist | Run again without it. The addon never forces a lock |
| `65` | The snapshot failed verification, a relationship check failed inside the apply (nothing was applied), or the website refused some content (privacy or integrity) in a push; the rest was pushed | Run `check` and read the preview; for a push, file a bug: the addon's rules and the website's differ |
| `69` | The website's sync is paused or switched off | Wait for the website |
| `70` | An internal error, or `status.json` is missing or belongs to another run (D41) | Read the newest file in `<dbid>/logs/`; if a pull stopped halfway, run it again: every step is safe to repeat |
| `75` | The tree is open in Gramps (D01), a Gramps edit window is open (D45), another run holds `state.lock` (D14), there is not enough disk space for the backup, the network or the website was unavailable after three retries, or a push met a website change made while it ran (409) | Close Gramps (and its edit windows) and run again, or wait for the other run or the network |
| `77` | You are not signed in, the sign-in was reused, revoked or expired, a fresh sign-in is needed (`step_up`), or the Keychain is locked (D42) | `gramps/bin/hfy-sync login` (add `--step-up` when `next_action` says `step_up`); unlock the Keychain |
| `78` | Wrong tree (D03), the website holds another cloud tree (D50: run `rebase`), unsupported schema or Gramps version (D04), sync state missing (D12) or damaged (D13), the website is not bound yet (`bind`), the addon is too old for the website (`update_addon`), or the website's certificate could not be verified | See below |

If Gramps is closed and the command still says the tree is open, the `lock` file is left over from a crash. Open the tree once in the Gramps window and close it normally. Never use `Gramps -u` or `--force-unlock`: the wrapper and the tool both refuse it.

## When the tree is refused as the wrong tree (D03)

The addon follows one tree. It checks that the tree's folder name, a marker stored in the tree and the sidecar agree, and that at least 90 % of the objects the last sync saw are still in the tree. A few creates and deletes between syncs never trip this. A different tree does: one restored from an old copy, re-imported from an export, or with more than a tenth of its objects deleted.

Open the bound tree and run again. To make the website follow the new tree on purpose, the rebind goes through a fresh sign-in, a new sidecar, rebase mode (objects equal to the website's copy are re-based, everything else becomes a conflict that you resolve in the Gramps window) and the mass-delete guard. The step-up and both sides of the mass-delete guard are in this build, and the Gramps window decides conflicts ([section 10](#10-use-the-website-sync-window)); the new sidecar and rebase mode for a re-imported tree (D12) are not built yet, so until then the addon only refuses. D12 and D13 are the same family: the sync state for the tree is gone or damaged, and rebasing it is a Gramps-window action that sends nothing by itself.

## When the website's store was recovered (D50)

After a recovery of the website's record store (an operator ran `bump-tree-id`, see [Operate the sync store](operate-the-sync-store.md#recover-the-store)) the website is a different cloud tree than the one this tree last synced with. Every version and base copy in the sync state belongs to the old one, so `pull`, `check` and `sync` stop at the handshake with exit `78`, error `D50` and `next_action: rebase`. The server's `403 tree_mismatch` on a push means the same. Nothing was changed.

With Gramps closed:

```sh
gramps/bin/hfy-sync rebase --tree "<tree name>"          # look only: exit 10, counts, nothing changed
gramps/bin/hfy-sync rebase --yes --tree "<tree name>"    # re-base
```

(In the Gramps window, Tools > Family Tree Processing > Website sync > "Rebase after a recovery...".) The rebase downloads the new store's snapshot (the guard against an older snapshot is waived, because a recovered store may be at a lower seq), then, object by object, with no common base:

- the desktop and the website hold equal copies: **re-based** (the new base);
- they differ: a **conflict**, parked on the command line and open in the window, with both sides left as they are;
- the object exists only on the website, or only in this tree: left for the next `pull` (website only) or the later push (desktop only);
- the website holds it, and this tree **deleted it since the last sync**: counted apart ("deleted on the desktop but still on the website"). The rebase drops the old sync state, which is where the pending delete was remembered, so the next `pull` would bring the object back. Delete it on the website first if it should stay gone.

It takes a verified backup first, closes the conflicts of the old tree, rejects unsent push entries addressed to it, forgets the push session it left open, and moves the sync state to the new tree. **It writes nothing to the Gramps tree and sends nothing to the website.** Exit `20` with `next_action: resolve_conflicts` means conflicts are open; `0` means every shared object agreed. Then run `hfy-sync pull`, which brings in the website-only objects through the usual preview. A second `rebase` finds nothing to do.

If the sync state itself is missing or damaged (D12, D13) the same `next_action` is shown; this build's `rebase` handles the changed cloud tree (D50) only, so recover the sync state by restoring a backup ([Restore from a backup](#8-restore-from-a-backup)) first.

## Run the addon's tests

```sh
python3 -m unittest discover gramps/tests/unit          # anywhere: the runtime, the wrapper, the pull, the restore, the push, the build and the installer
gramps/tests/gramps/run.sh test_addon_skeleton.py test_addon_pull.py test_addon_gui.py   # a Mac with Gramps 6.0.6: the real Gramps on copies of the fixture tree
gramps/tests/e2e/run.sh scenario_pull.py scenario_rebase.py   # the same, against the local sync dev server (needs node 22 and api/node_modules)
gramps/tests/e2e/run.sh scenario_push.py                # the same Mac, plus node 22 and api/node_modules: the push against the local dev server
gramps/tests/e2e/run.sh scenario_decisions.py           # the same: a web conflict decision applied, or reopened because the website moved (HFY-TSK-338)
```

The second command makes a throwaway Gramps home, installs the addon into it, and drives the Gramps command line and the wrapper on copies of the synthetic fixture tree. It never opens your real trees or the real `~/Library/Application Support` folders. Add `test_addon_skeleton.py` to a `run.sh` call to run only it; with no argument `run.sh` runs every Gramps test.

## Related

- [`gramps/README.md`](../../gramps/README.md#the-desktop-addon-skeleton): the files, the binding rules, the push and `status.json`.
- [Run the test suites](run-the-tests.md)
