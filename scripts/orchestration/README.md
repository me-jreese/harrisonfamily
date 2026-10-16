# Orchestration tooling for HFY-PLN-002

Reference for the scripts that the HFY-PLN-002 orchestrator uses to build, merge and ship plan tasks and to keep the plan catalog current. The orchestrator is a Claude Code session on io's Mac. The scripts hold no credentials, session IDs or local paths. Each run takes them as Workflow args or as environment variables.

The plan's design and task data are in [`docs/design/hfy-pln-002/`](../../docs/design/hfy-pln-002/README.md). The live dispatch catalog is the docstore document DOC-981BF41F2443, and the Enceladus tracker is authoritative for task status.

## Placeholders

The shared placeholders, such as `<project>`, `<eleventy-source>`, `<github-owner>` and `<github-repo>`, are defined in [private data and secrets](../../docs/reference/private-data-and-secrets.md#placeholders). These ones are defined only on this page:

| Placeholder | Stands for |
|---|---|
| `<repo>` | A harrisonfamily checkout that holds this folder and `docs/design/hfy-pln-002/`. |
| `<state-dir>` | The orchestration state directory: a disposable working directory outside the repository. See [State directory](#state-directory). |
| `<worktrees>` | The directory that holds the task worktrees, one per task, each on the branch `agent/hfy-tsk-<nnn>-<key>`. |
| `<read-worktree>` | A detached, read-only worktree of `origin/main`, made with `git worktree add --detach <dir> origin/main`. |
| `<eleventy-workspace>` | `<project>/workspace`, the directory that holds `<eleventy-source>` (`11ty-dev/`) and `backups/`. |
| `<ses>`, `<sci>` | A claimed Enceladus session ID and its Session Claim ID (SCI), from `coordination agent.register` and `agent.claim`. Never committed. |

## Tools

| Tool | Kind | Inputs | Writes |
|---|---|---|---|
| [`make_batch.py`](make_batch.py) | Python 3 | `HFY_ORCH_STATE`, `HFY_ORCH_REPO`, `HFY_ORCH_WT`; a batch name and task keys | `<state-dir>/pln2/<batch>.json`, a worktree per new harrisonfamily task; prints the batch workflow's args |
| [`pln002-batch.js`](pln002-batch.js) | Workflow script | Args `stateDir`, `repoDir`, `batchFile`, `tasks`; optional `wtRoot` | Local commits on each task's worktree branch; returns one report per task |
| [`ship3.js`](ship3.js) | Workflow script | Args `stateDir`, `repoDir`, `session`, `sci`, `hf`, `hf2`, `kit`; optional `governanceHash` | PR title and body files in `<state-dir>/pr/`; pushes, pull requests, merges, tracker lifecycle and acceptance evidence |
| [`ship.js`](ship.js) | Workflow script | As `ship3.js`, without `hf2` | As `ship3.js` |
| [`mergeship.js`](mergeship.js) | Workflow script | Args `stateDir`, `repoDir`, `session`, `sci`, `items`; optional `governanceHash`, `gitName`, `gitEmail` | Merge commits on each item's branch, then everything `ship3.js` writes |
| [`hfdesk.sh`](hfdesk.sh) | bash | A `prdesk.sh` subcommand and its arguments | Whatever the subcommand does on `<github-owner>/<github-repo>` |
| [`automerge.sh`](automerge.sh) | bash | `<owner>/<name>` of the repository and a pull request number | The merge |
| [`mirror_sync.sh`](mirror_sync.sh) | bash | `HFY_ORCH_REPO`, `HFY_DROPBOX_SITE`; optional `--check` | Changed repository-owned files under `<eleventy-source>/public/`, and their backups |
| [`catalog/refresh_status.py`](catalog/refresh_status.py) | Python 3 | `HFY_ORCH_STATE`, `HFY_ORCH_REPO`; the tracker through ELR | `<state-dir>/catalog2/status.json`, `.ids.txt` |
| [`catalog/gen_board.py`](catalog/gen_board.py) | Python 3 | `HFY_ORCH_STATE`, `HFY_ORCH_REPO` | `<state-dir>/catalog2/20-order.md`, `30-board.md` |
| [`catalog/sync.py`](catalog/sync.py) | Python 3 | `HFY_ORCH_STATE`; optional `--all`, `--dry-run` | Section patches of DOC-981BF41F2443 through ELR; `<state-dir>/catalog2/.synced.json`, `.body-*` |

## Inputs

### Environment variables

| Variable | Used by | Stands for |
|---|---|---|
| `HFY_ORCH_STATE` | `make_batch.py`, the three `catalog/` tools | `<state-dir>` |
| `HFY_ORCH_REPO` | `make_batch.py`, `refresh_status.py`, `gen_board.py` | `<repo>`. `make_batch.py` also cuts the new worktrees from it. |
| `HFY_ORCH_REPO` | `mirror_sync.sh` | `<read-worktree>`. The script moves it to `origin/main`, so it refuses, with exit 2, a checkout that is on a branch. |
| `HFY_ORCH_WT` | `make_batch.py` | `<worktrees>` |
| `HFY_DROPBOX_SITE` | `mirror_sync.sh` | `<eleventy-workspace>`. The script refuses, with exit 2, a directory without `11ty-dev/public/`. |

A tool exits with a message that names the variable when a variable it needs is unset or is not a directory.

### Workflow args

| Arg | Used by | Value |
|---|---|---|
| `stateDir` | All four | `<state-dir>` |
| `repoDir` | All four | `<repo>`. The ship scripts run `hfdesk.sh` and `automerge.sh` from its `scripts/orchestration/`, and the CodeArtifact domain owner is read from the registry URL in its `api/.npmrc`. |
| `session`, `sci` | `ship.js`, `ship3.js`, `mergeship.js` | `<ses>` and `<sci>`. `mergeship.js` passes them to `ship3.js`. A clerk whose session has retired registers and claims a new one, and reports it. |
| `governanceHash` | `ship.js`, `ship3.js`, `mergeship.js` | The Enceladus governance hash. Defaults to the hash the scripts were written against. |
| `batchFile`, `tasks` | `pln002-batch.js` | As printed by `make_batch.py`. Each task is `{ id, key, wt, model, effort }`. |
| `wtRoot` | `pln002-batch.js` | `<worktrees>`. A task whose `wt` is under it is treated as a git worktree, and any other as an out-of-repo directory. Without it, a `wt` that contains `/e0/wt/` is a worktree. |
| `hf`, `hf2`, `kit` | `ship3.js` (`ship.js` takes `hf` and `kit`) | Lists of tasks to ship: `{ id, key, wt, branch, repo, report, prExtra }`, and for `kit` also `pkg` and `version`. `repo` is `harrisonfamily` or `io-kit`. `report` defaults to `<state-dir>/pln2/batch1-result.json`. |
| `items` | `mergeship.js` | `{ id, key, wt, branch, report, notes, shipNotes }` per branch. |
| `gitName`, `gitEmail` | `mergeship.js` | The commit identity, passed as `git -c`. Without both, commits use the worktree's configured identity. |

A workflow script throws before it starts any agent when a required arg is missing.

## Repository data the tools read

| File in `docs/design/hfy-pln-002/` | Read by | Use |
|---|---|---|
| `tasks.json` | `make_batch.py`, `gen_board.py` | Each task's key, wave, repo, ACs, notes, test_plan, requirements, model and effort. |
| `tracker-idmap.json` | `make_batch.py`, `gen_board.py`, `refresh_status.py` | Plan key to tracker ID. |
| `addenda.json` | `make_batch.py` | Plan key to the orchestrator's notes for that task, appended to the task pack's notes under `ORCHESTRATOR ADDENDA:`. Optional. |
| `BRD2.md` and the domain files | The `pln002-batch.js` workers | The design the workers implement against. |

## State directory

`<state-dir>` is never committed and never backed up. It can hold session IDs and worker output. Anything that must outlast it lives in the docstore or in this repository: the catalog is DOC-981BF41F2443, io's verbatim intent is DOC-2CFAE07B546C, and the task data and these tools are here.

| Path in `<state-dir>` | Written by | Holds |
|---|---|---|
| `pln2/<batch>.json` | `make_batch.py` | The task packs the batch workers read. |
| `pln2/<batch>-result.json` | The orchestrator, from the batch workflow's result | The worker reports the ship scripts read (the task's `report`). |
| `pr/` | The ship clerks | Pull request title and body files. |
| `pln002-intent.md` | The orchestrator | A copy of DOC-2CFAE07B546C that the batch workers read. |
| `catalog2/10-rulings.md` to `catalog2/70-trueup.md` | The orchestrator; `gen_board.py` writes `20-order.md` and `30-board.md` | One file per catalog section. The first line is the heading of the section of DOC-981BF41F2443 that the rest of the file replaces. |
| `catalog2/status.json` | `refresh_status.py` | Plan key to tracker status, with an optional ` (<note>)` suffix. |
| `catalog2/.synced.json`, `.ids.txt`, `.body-*` | `sync.py`, `refresh_status.py` | Bookkeeping: section hashes, the ID list and the patch bodies. |

## How to run each tool

### Build a batch: `make_batch.py` and `pln002-batch.js`

```bash
export HFY_ORCH_STATE=<state-dir> HFY_ORCH_REPO=<repo> HFY_ORCH_WT=<worktrees>
python3 <repo>/scripts/orchestration/make_batch.py <batch> <key>[:<worktree-dir>] ...
```

- For each harrisonfamily key whose worktree directory does not exist, it runs `git worktree add` at `<worktrees>/<worktree-dir>` (default `hfy-<key>`) on `agent/<id>-<key>` from `origin/main`. It then clones `api/node_modules` and `islands/node_modules` with `cp -cR`, an APFS clone, from any worktree in `<worktrees>` whose lockfile matches `origin/main`.
- It prints `{ stateDir, repoDir, wtRoot, batchFile, tasks }`. A task's `model` is its `tasks.json` model when that is `sonnet`, `opus` or `haiku`, and `sonnet` otherwise; `effort` defaults to `medium`.

Pass that JSON as the args of a Workflow run of `<repo>/scripts/orchestration/pln002-batch.js`. Each task runs as one pipeline: implement, two review lenses (design and intent fidelity; code and tests), fix, then a final verify. Workers commit locally. They never push and never call tracker or lifecycle tools. Save the result as `<state-dir>/pln2/<batch>-result.json` for the ship scripts.

### Ship built tasks: `ship3.js` and `ship.js`

```json
{
  "stateDir": "<state-dir>", "repoDir": "<repo>", "session": "<ses>", "sci": "<sci>",
  "hf": [{ "id": "HFY-TSK-<nnn>", "key": "<key>", "wt": "<worktrees>/<dir>", "branch": "agent/hfy-tsk-<nnn>-<key>",
           "repo": "harrisonfamily", "report": "<state-dir>/pln2/<batch>-result.json", "prExtra": "<optional PR body notes>" }],
  "hf2": [],
  "kit": []
}
```

These are the args of a Workflow run of `<repo>/scripts/orchestration/ship3.js`. Each list ships its tasks one at a time, and the lists run in parallel. Per task, a release clerk checks out the task, rebases on `origin/main`, pushes, opens the pull request with its `CCI-...` line, runs `automerge.sh`, and advances the record through `coding-complete`, `committed`, `pr`, `merged-main`, `deploy-init` and `deploy-success`. It then sets the acceptance evidence, and closes the record only when every AC is accepted. It never retires a session.

`ship.js` is the earlier version, with two lists (`hf` and `kit`). It lacks `ship3.js`'s rules for docs and lockfile conflicts, for browser tests and against retiring the session.

### Merge, review, then ship: `mergeship.js`

Pass `{ stateDir, repoDir, session, sci, items }` as the args of a Workflow run of `<repo>/scripts/orchestration/mergeship.js`, for branches whose rebase stopped on source conflicts. It handles the items one at a time. For each item, an agent merges `origin/main` into the branch and resolves the conflicts keeping both sides, then a second agent reviews the merge adversarially, then a fix pass runs if the review says `fix-first`. Last, `ship3.js` ships the item as a sub-workflow.

### GitHub: `hfdesk.sh` and `automerge.sh`

```bash
bash <repo>/scripts/orchestration/hfdesk.sh <subcommand> [args]
bash <repo>/scripts/orchestration/automerge.sh <owner>/<name> <pr>
```

- `hfdesk.sh` runs `prdesk.sh`, the Enceladus kit tool at `~/enceladus/cutover-safety-net/kit-tools/prdesk.sh`, against `<github-owner>/<github-repo>` with this repository's GitHub App installation. `prdesk.sh` mints an installation token for each call and never prints it. The ship clerks use `push <branch>` (run from the worktree), `create <branch> <title-file> <body-file>`, `runs <sha>`, `jobs <run_id>` and `get pulls/<n>`.
- `automerge.sh` uses this repository's App installation for a `<github-owner>/*` repository, and `prdesk.sh`'s default installation otherwise. It waits 15 seconds, then polls `prdesk.sh status` up to 80 times:
  - It waits while no run is registered or any run is in progress, queued, pending, waiting or awaiting approval.
  - It exits 1 with `FAILED: <conclusion> <workflow>` when the newest run of any workflow concluded other than `success`, `skipped` or `neutral`.
  - It merges when the merge state is `CLEAN`, `UNSTABLE` or `HAS_HOOKS`, and updates the branch when it is `BEHIND`.
  - It stops at once if the pull request is already merged.

  Then it prints `MERGED <merged_at> <merge_commit_sha>`.

### Mirror the repository-owned `11ty/` files: `mirror_sync.sh`

```bash
HFY_ORCH_REPO=<read-worktree> HFY_DROPBOX_SITE=<eleventy-workspace> <repo>/scripts/orchestration/mirror_sync.sh [--check]
```

It fetches, detaches `<read-worktree>` at `origin/main`, and compares each repository-owned `11ty/` file that the pattern in the script names (HFY-R46) with its copy under `<eleventy-source>/public/`. It copies each file that differs and keeps the old copy as `<eleventy-workspace>/backups/11ty-dev/public/<file>.bak-<UTC timestamp>`, never beside the file. With `--check`, it prints `DIFF <file>` for each difference and changes nothing. It never deletes a file. It ends with a count line and warns about any backup file inside `public/`. To check the mirror by hand, see [Check whether the mirror is done](../../docs/how-to/refresh-the-eleventy-output.md#check-whether-the-mirror-is-done).

### Keep the catalog current: `catalog/`

```bash
export HFY_ORCH_STATE=<state-dir> HFY_ORCH_REPO=<repo>
python3 <repo>/scripts/orchestration/catalog/refresh_status.py
python3 <repo>/scripts/orchestration/catalog/gen_board.py
python3 <repo>/scripts/orchestration/catalog/sync.py --dry-run
python3 <repo>/scripts/orchestration/catalog/sync.py
```

- `refresh_status.py` reads the status of every `HFY-TSK` ID in `tracker-idmap.json` with `elr batch_get` (ELR at `~/.enceladus/elr/elr`) and rewrites `status.json`. A key keeps its ` (<note>)` suffix only while its status is unchanged. Wave objectives are left out.
- `gen_board.py` writes `30-board.md`, the tasks grouped by wave `W0` to `W6` plus `Follow-ups` for tasks without a wave, one line per task (`<id> <key> [<repo>] <status>`) with the totals. It also writes `20-order.md`, the order of operations.
- `sync.py` patches each section whose file's SHA-256 differs from `.synced.json`, or every section with `--all`, with `elr doc_patch --op replace`. The anchor is the file's first heading. On exit 3, a stale document hash, it refreshes the digest and retries once. It records a hash only after a successful patch, never in a dry run, and exits 1 if any patch failed.

## Secrets and personal data

- Session IDs, SCIs, tokens and `<state-dir>` are never committed. They reach the scripts only as args or environment variables.
- No script prints a token. The CodeArtifact token is minted with `--profile product-lead`, with the domain owner read from `<repo>/api/.npmrc`, and is never echoed.
- The batch workers write synthetic data only, as [`AGENTS.md`](../../AGENTS.md#no-pii-and-no-secrets-rule-hard) requires.
