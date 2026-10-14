# How to install and run the Gramps sync addon

Use this page to put the `hfy_sync` addon into Gramps on the Mac that holds the family tree, check that it sees the tree, and bind the tree to the website. The addon is the desktop half of the sync design (HFY-PLN-002). This build is the skeleton (HFY-TSK-179): it installs, reports status and binds a tree, and refuses unsafe starts. It does not send or fetch any family data yet, so installing it changes nothing on the website.

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

## Exit codes

The wrapper exits with the `exit_code` in `~/Library/Application Support/hfy_sync/<dbid>/status.json`, which holds counts and codes only.

| Code | Meaning | What to do |
| --- | --- | --- |
| `0` | Done, or nothing to do | None |
| `10` | A dry run found changes (a `bind` without `--yes`) | Run again with `--yes` if the plan is right |
| `64` | `--force-unlock` was given, or the options were wrong | Run again without it. The addon never forces a lock |
| `69` | The action is not in this build (`login`, `check`, `pull`, `push`, `sync`) | Wait for the later tasks |
| `70` | An internal error, or `status.json` is missing or belongs to another run (D41) | Read the newest file in `<dbid>/logs/` |
| `75` | The tree is open in Gramps (D01), another run holds `state.lock` (D14) | Close Gramps and run again, or wait for the other run |
| `78` | Wrong tree (D03), unsupported schema or Gramps version (D04), sync state missing (D12) or damaged (D13) | See below |

If Gramps is closed and the command still says the tree is open, the `lock` file is left over from a crash. Open the tree once in the Gramps window and close it normally. Never use `Gramps -u` or `--force-unlock`: the wrapper and the tool both refuse it.

## When the tree is refused as the wrong tree (D03)

The addon follows one tree. It checks that the tree's folder name, a marker stored in the tree and the sidecar agree, and that at least 90 % of the objects the last sync saw are still in the tree. A few creates and deletes between syncs never trip this. A different tree does: one restored from an old copy, re-imported from an export, or with more than a tenth of its objects deleted.

Open the bound tree and run again. To make the website follow the new tree on purpose, the rebind goes through a fresh sign-in, a new sidecar, rebase mode (objects equal to the website's copy are re-based, everything else becomes a conflict that you resolve in the Gramps window) and the mass-delete guard. Those steps arrive with the pull and push tasks; until then the addon only refuses. D12 and D13 are the same family: the sync state for the tree is gone or damaged, and rebasing it is a Gramps-window action that sends nothing by itself.

## Run the addon's tests

```sh
python3 -m unittest discover gramps/tests/unit          # anywhere: the runtime, the wrapper, the build and the installer
gramps/tests/gramps/run.sh test_addon_skeleton.py       # a Mac with Gramps 6.0.6: the real Gramps on copies of the fixture tree
```

The second command makes a throwaway Gramps home, installs the addon into it, and drives the Gramps command line and the wrapper on copies of the synthetic fixture tree. It never opens your real trees or the real `~/Library/Application Support` folders. Add `test_addon_skeleton.py` to a `run.sh` call to run only it; with no argument `run.sh` runs every Gramps test.

## Related

- [`gramps/README.md`](../../gramps/README.md#the-desktop-addon-skeleton): the files, the binding rules and `status.json`.
- [Run the test suites](run-the-tests.md)
