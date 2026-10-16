# How to install and run the Gramps sync addon

Use this page to put the `hfy_sync` addon into Gramps on the Mac that holds the family tree, check that it sees the tree, and bind the tree to the website. The addon is the desktop half of the sync design (HFY-PLN-002). This build is the skeleton (HFY-TSK-179) with the sign-in (HFY-TSK-180) and the push (HFY-TSK-206): it installs, reports status, binds a tree, signs you in to the website, pushes the tree's changes, and refuses unsafe starts. It does not fetch or apply website changes yet (that is the pull), and it sends nothing until you run `push --yes` against a website whose cloud store has been bound to this tree, so installing it changes nothing on the website.

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

### 5. Push the tree's changes

With Gramps closed and the website's sync switched on and bound to this tree:

```sh
gramps/bin/hfy-sync push --tree "<tree name>"                         # a dry run: exit 10 when there is something to push, nothing sent
gramps/bin/hfy-sync push --tree "<tree name>" --yes                   # sends it
gramps/bin/hfy-sync push --tree "<tree name>" --yes --allow-deletes   # and the deletes, if you have a fresh step-up
```

The dry run writes `previews/<run id>.json` in the sync state folder: what would be created, updated or deleted, what is held, blocked or in conflict, by class, handle and path only, never a value. The real run sends batches of at most 24 objects, in dependency order. When it takes more than one batch, or the website has not been seeded yet, it opens a push session and completes it at the end. Every batch is written to the sidecar's outbox before it is sent, so if the answer is lost the next run sends the same batch again under the same key and the website answers from what it stored.

Only the redacted form of each object is sent. Phone numbers, mail addresses, street addresses and exact birth days and months stay on the Mac (sync.md section 5; `docs/reference/redaction-policy.md`). A run that holds something ends with exit `20`; the sidecar's `holds` table says which object and which rule, and the run log lists counts only.

**Deletes.** The website accepts a delete only after a fresh sign-in with a second factor. Run `gramps/bin/hfy-sync login --step-up`, then push within five minutes with `--allow-deletes`. Without the step-up, with the flag missing, or for more than 10 deletes (or more than 5 % of the synced objects) the deletes are parked: nothing is sent for them, the rest of the push goes, and the run ends with exit `20`. The command line never pushes a mass delete; do that from the Gramps window.

**Things the push will not do.** It does not renumber a person who is already on the website (restore the old ID in Gramps; an ID the website holds as empty can be assigned once). It holds a new record whose ID is in the website's own block (`I8000` to `I8999`, and the same range for other classes) and a new person who reuses the ID of a deleted one ("Gramps reused a retired website ID; renumber this new record."): give the new record a different ID and run again. It holds a person merge until the website says merges are on, and never pushes a merge that would merge away a signed-in family member ("Merge the other way"). The push finds a merge by the `Merged Gramps ID` attribute on the surviving person (a new one since the last sync) next to the deletion of the person with that ID. A merge is only pushed from the Gramps window, with a fresh sign-in. Until the website lists the signed-in members in its handshake, a merge is held as unverifiable; list them yourself under `member_person_ids` in `config.json` (Gramps IDs, for example `["I0001", "I0002"]`) to allow it.

**If the website changed something too.** Changes to the same object on both sides merge field by field. A change to the same field on both sides, a type change on a birth-like event, or a birth year change over a local day and month is a conflict: the command line parks it (exit `20`, `next_action` `resolve_conflicts`), the desktop value stays, and the website value is what is sent. The pull and the Gramps-window resolution come with their own tasks. A push that meets a website edit made while it ran stops with exit `75`; run it again.

## Exit codes

The wrapper exits with the `exit_code` in `~/Library/Application Support/hfy_sync/<dbid>/status.json`, which holds counts and codes only.

| Code | Meaning | What to do |
| --- | --- | --- |
| `0` | Done, or nothing to do | None |
| `10` | A dry run found changes (a `bind` or `push` without `--yes`) | Run again with `--yes` if the plan is right |
| `20` | A push finished with something held, blocked, parked or in conflict (`next_action`: `resolve_conflicts`, `step_up` or none) | Read `<dbid>/status.json` for the counts and the sidecar's `holds` for the rules; `login --step-up` for parked deletes |
| `65` | The website refused some content (privacy or integrity) in a push; the rest was pushed | File a bug: the addon's rules and the website's differ |
| `64` | `--force-unlock` was given, or the options were wrong | Run again without it. The addon never forces a lock |
| `69` | The action is not in this build (`check`, `pull`, `sync`), or the website's sync is paused or switched off | Wait for the later tasks, or for the website |
| `70` | An internal error, or `status.json` is missing or belongs to another run (D41) | Read the newest file in `<dbid>/logs/` |
| `75` | The tree is open in Gramps (D01), another run holds `state.lock` (D14), the network or the website was unavailable after three retries, or a push met a website change made while it ran (409) | Close Gramps and run again, or wait for the other run or the network |
| `77` | You are not signed in, the sign-in was reused, revoked or expired, a fresh sign-in is needed (`step_up`), or the Keychain is locked (D42) | `gramps/bin/hfy-sync login` (add `--step-up` when `next_action` says `step_up`); unlock the Keychain |
| `78` | Wrong tree (D03), unsupported schema or Gramps version (D04), sync state missing (D12) or damaged (D13), the website's store was re-seeded (D50, `rebase`), the website is not bound yet (`bind`), the addon is too old for the website (`update_addon`), or the website's certificate could not be verified | See below |

If Gramps is closed and the command still says the tree is open, the `lock` file is left over from a crash. Open the tree once in the Gramps window and close it normally. Never use `Gramps -u` or `--force-unlock`: the wrapper and the tool both refuse it.

## When the tree is refused as the wrong tree (D03)

The addon follows one tree. It checks that the tree's folder name, a marker stored in the tree and the sidecar agree, and that at least 90 % of the objects the last sync saw are still in the tree. A few creates and deletes between syncs never trip this. A different tree does: one restored from an old copy, re-imported from an export, or with more than a tenth of its objects deleted.

Open the bound tree and run again. To make the website follow the new tree on purpose, the rebind goes through a fresh sign-in, a new sidecar, rebase mode (objects equal to the website's copy are re-based, everything else becomes a conflict that you resolve in the Gramps window) and the mass-delete guard. Those steps arrive with later tasks (`addon-pull-apply` and `addon-gui-preview` for the new sidecar and rebase mode; the push side of the mass-delete guard and the step-up are in this build, `addon-pull-apply` adds the pull side); until then the addon only refuses. D12 and D13 are the same family: the sync state for the tree is gone or damaged, and rebasing it is a Gramps-window action that sends nothing by itself.

## Run the addon's tests

```sh
python3 -m unittest discover gramps/tests/unit          # anywhere: the runtime, the wrapper, the build, the installer and the push
gramps/tests/gramps/run.sh test_addon_skeleton.py       # a Mac with Gramps 6.0.6: the real Gramps on copies of the fixture tree
gramps/tests/e2e/run.sh scenario_push.py                # the same Mac, plus node 22 and api/node_modules: the push against the local dev server
```

The second command makes a throwaway Gramps home, installs the addon into it, and drives the Gramps command line and the wrapper on copies of the synthetic fixture tree. It never opens your real trees or the real `~/Library/Application Support` folders. Add `test_addon_skeleton.py` to a `run.sh` call to run only it; with no argument `run.sh` runs every Gramps test.

## Related

- [`gramps/README.md`](../../gramps/README.md#the-desktop-addon-skeleton): the files, the binding rules, the push and `status.json`.
- [Run the test suites](run-the-tests.md)
