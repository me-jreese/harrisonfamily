# How to install and run the Gramps sync addon

Use this page to put the `hfy_sync` addon into Gramps on the Mac that holds the family tree, check that it sees the tree, and bind the tree to the website. The addon is the desktop half of the sync design (HFY-PLN-002). This build is the skeleton (HFY-TSK-179) with the sign-in (HFY-TSK-180) and the pull (HFY-TSK-205): it installs, reports status, binds a tree, signs you in to the website, shows and applies what the website changed, restores a backup, and refuses unsafe starts. It does not send anything to the website yet (that is `addon-push`), so installing it, and every action on this page, changes nothing on the website.

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

(`sync --yes` is the same in this build; it will also push once `addon-push` lands.) In order, the run downloads and verifies the snapshot, plans, and writes the preview; downloads the files of new or changed media into the `media_root` of `config.json`; takes a backup; re-reads every object it will touch (if you edited one meanwhile, it plans again); and applies every change in **one Gramps transaction**, "Website sync: pull seq N". In the Gramps window that transaction is a single entry under **Edit > Undo**. Undo puts the tree back, but the next sync would then offer to push those values to the website again: it labels such a change "reverts a website change (origin)", and the command line parks it. Prefer **Restore backup** (below) to undo a pull. Any failure inside the transaction rolls all of it back.

What a run never does on its own:

- It does not decide a conflict. A conflict (you and the website both changed the same field, a website change to the year of a birth you hold a day and month for, a website delete of an object that holds desktop-only data) leaves both sides as they are and stays open on every later run until the two sides agree or you decide it in the Gramps window. The command line parks it and exits `20`.
- It does not apply a website delete. A delete needs `--allow-deletes`, and more than 10 deletes or 5 % of the tree are never applied by the command line.
- It does not apply a pulled object that shows a date of birth you hold. Every pulled object is scanned for the dates of birth in your tree. A hit is skipped, counted as a privacy incident (`privacy_incidents` in `status.json`, counts only), and offered as a withdraw-and-expunge push for when `addon-push` lands. Exit `20`, `next_action: review_incidents`.
- It does not push a value the website scrubbed. If the website scrubs an object in place (the same version, a different hash), the sidecar follows the website and your local value is held, so it is never sent back.

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

## Exit codes

The wrapper exits with the `exit_code` in `~/Library/Application Support/hfy_sync/<dbid>/status.json`, which holds counts and codes only.

| Code | Meaning | What to do |
| --- | --- | --- |
| `0` | Done, or nothing to do | None |
| `10` | A dry run found changes (a `bind` or `pull` without `--yes`, or `check`), or `--plan` found a different plan | Read the preview; run again with `--yes` (and `--plan <run id>`) if the plan is right |
| `20` | Partial: a conflict is open, a pulled object was skipped as a privacy incident, a change was held back, or desktop changes are waiting to go (this build cannot push) | `next_action` says which: `resolve_conflicts`, `review_incidents`, `review_preview` |
| `64` | `--force-unlock` was given, the options were wrong, or `--plan` or `restore` named something that does not exist | Run again without it. The addon never forces a lock |
| `65` | The snapshot failed verification, or a relationship check failed inside the apply (nothing was applied) | Run `check` and read the preview; report it if it persists |
| `69` | The action is not in this build (`push`), or the website's sync is paused or switched off | Wait for the later tasks, or for the website |
| `70` | An internal error, or `status.json` is missing or belongs to another run (D41) | Read the newest file in `<dbid>/logs/`; if a pull stopped halfway, run it again: every step is safe to repeat |
| `75` | The tree is open in Gramps (D01), a Gramps edit window is open (D45), another run holds `state.lock` (D14), there is not enough disk space for the backup, or the network or the website was unavailable after three retries | Close Gramps (and its edit windows) and run again, or wait for the other run or the network |
| `77` | You are not signed in, the sign-in was reused, revoked or expired, a fresh sign-in is needed (`step_up`), or the Keychain is locked (D42) | `gramps/bin/hfy-sync login` (add `--step-up` when `next_action` says `step_up`); unlock the Keychain |
| `78` | Wrong tree (D03), the website holds another tree (D50), unsupported schema or Gramps version (D04), sync state missing (D12) or damaged (D13), the addon is too old for the website (`update_addon`), or the website's certificate could not be verified | See below |

If Gramps is closed and the command still says the tree is open, the `lock` file is left over from a crash. Open the tree once in the Gramps window and close it normally. Never use `Gramps -u` or `--force-unlock`: the wrapper and the tool both refuse it.

## When the tree is refused as the wrong tree (D03)

The addon follows one tree. It checks that the tree's folder name, a marker stored in the tree and the sidecar agree, and that at least 90 % of the objects the last sync saw are still in the tree. A few creates and deletes between syncs never trip this. A different tree does: one restored from an old copy, re-imported from an export, or with more than a tenth of its objects deleted.

Open the bound tree and run again. To make the website follow the new tree on purpose, the rebind goes through a fresh sign-in, a new sidecar, rebase mode (objects equal to the website's copy are re-based, everything else becomes a conflict that you resolve in the Gramps window) and the mass-delete guard. Those steps arrive with later tasks (`addon-push` for the step-up, `addon-gui-preview` for the new sidecar and rebase mode; the pull side's mass-delete guard is in this build); until then the addon only refuses. D12 and D13 are the same family: the sync state for the tree is gone or damaged, and rebasing it is a Gramps-window action that sends nothing by itself.

## Run the addon's tests

```sh
python3 -m unittest discover gramps/tests/unit          # anywhere: the runtime, the wrapper, the pull, the restore, the build and the installer
gramps/tests/gramps/run.sh test_addon_skeleton.py test_addon_pull.py   # a Mac with Gramps 6.0.6: the real Gramps on copies of the fixture tree
gramps/tests/e2e/run.sh scenario_pull.py                # the same, against the local sync dev server (needs node 22 and api/node_modules)
```

The second command makes a throwaway Gramps home, installs the addon into it, and drives the Gramps command line and the wrapper on copies of the synthetic fixture tree. It never opens your real trees or the real `~/Library/Application Support` folders. Add `test_addon_skeleton.py` to a `run.sh` call to run only it; with no argument `run.sh` runs every Gramps test.

## Related

- [`gramps/README.md`](../../gramps/README.md#the-desktop-addon-skeleton): the files, the binding rules and `status.json`.
- [Run the test suites](run-the-tests.md)
