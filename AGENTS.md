# AGENTS.md

AGENTS.md — the operating contract for automated agents in the harrisonfamily repo.

Humans start at [`docs/README.md`](docs/README.md). For agent behavior, this file overrides the per-directory READMEs.

## Governance via Enceladus

- The project is **harrisonfamily**, prefix **HFY**, governed in Enceladus.
- Bootstrap per `governance://agents/bootstrap-template.md`: `connection_health()`, then `governance_get("agents.md")`, `governance_dictionary()` and the lifecycle primer, `governance_get("agents/lifecycle-primer.md")`.
- Every change maps to an HFY-TSK, HFY-ISS or HFY-FTR record.
- Prefer ELR, the Enceladus Local Runner, for governed reads when its diagnostics report READY. Lifecycle writes (checkout, status advances, worklogs, acceptance evidence) stay on MCP.

## Source of truth for E5 work

The HFY-PLN-001 coding-task catalog, document DOC-5BB4A7956A88, holds the rulings (HFY-R*n*), the order of operations, the board, io's gates and the review findings.

- Cite rulings by ID rather than restating them, for example HFY-R43 (the origin-verify header) or HFY-R48 (`searchV2` implies `shellV2`).
- Never contradict the catalog in code or docs. If the code and the catalog disagree, raise it on the record; do not pick a side silently.

## Lifecycle quick reference

1. Set `components` and `transition_type` on the record before `checkout_task`.
2. Work in a dedicated worktree.
3. `coding-complete` returns a `CAI`.
4. Push, then mark `committed` with `commit_sha` to get a `CCI`.
5. Put `CCI-...` in the PR body. The PR Commit Gate rejects a PR without it.
6. Merge or rebase `origin/main` before merging. Branch protection is strict.
7. Re-run the checks after an edit to the PR body alone. Workflow payloads can lag body-only edits.

## GitHub access

- Mint a GitHub App installation token per shell with `mint_app_token.sh --export` (the prdesk pattern). Never print the token.
- Never run `gh auth login`, and never store a token in a shell profile.
- Run `git` and `gh` from the task worktree's directory.
- Push before advancing a record to `committed`. The commit SHA is checked against the remote.
- Never rewrite published history.

## Pipeline facts you must know

- **The kit pipeline deploys `main`.** A push to `main` runs `io-kit-deploy.yml` and `deploy-gcf-legacy.yml`, and pull requests run `io-kit-ci.yml`. `.github/workflows/io-kit-*.yml` and `.github/actions/io-kit-ci/*` are rendered from `ci.manifest.yaml` (HFY-TSK-060): change the manifest and re-render, never hand-edit them. See [Change the CI pipeline](docs/how-to/change-the-ci-pipeline.md). `deploy-gcf-legacy.yml` is hand-maintained.
- **A failed smoke check rolls back; nothing else does.** See [Roll back a site deploy](docs/how-to/roll-back-a-site-deploy.md) before you assume production is back where it was.
- **The island bundles are committed.** `11ty/js/islands/` is committed build output (HFY-R58). Rebuild and commit it with every `islands/` change. `cd islands && npm run check:islands` fails when it is stale.
- **What no workflow does.** No workflow builds the islands, runs a test suite, or deploys `api/`, `auth/` or the `hfy-app` stack. Those ship by hand: see [Deploy the app stack](docs/how-to/deploy-the-app-stack.md).

## Repo-shape traps

- `11ty/` is deployable **output**, and its source, `<eleventy-source>`, lives outside the repository. The E5 files exist only in `11ty/`, so never `rsync --delete` into it. Refresh it only with [Refresh the Eleventy output](docs/how-to/refresh-the-eleventy-output.md).
- `11ty/js/islands/` is a build product of `islands/`. Never edit it by hand.
- The workspace helper scripts in `scripts/` assume the `<project>/repo` layout and misbehave in worktrees. Set `SKIP_DEPLOYMENT_SYNC_CHECK=1` only with the reason recorded in the worklog.
- `scripts/export_workspace_samples.sh` wipes and re-copies the sanitized directories, pointer READMEs included, from `<project>/workspace/`. Change the workspace copy too, or the next export reverts the repo copy.

## No-PII and no-secrets rule (hard)

Never write any of the following into code, docs, commits, PR bodies, worklogs or test fixtures:

- Secret or token values, whole or truncated.
- Real email addresses.
- Real people's names or dates.
- Gramps IDs or records from the real tree.
- Private bucket listings or object contents.
- The CloudFront distribution ID or the AWS account ID. They already appear in the deploy configuration that needs them (`ci.manifest.yaml`, `github-roles.yaml`, the `scripts/infra/` defaults, the `.npmrc` registry URLs). Never add them anywhere else.

Use the placeholder vocabulary in [Private data and secrets](docs/reference/private-data-and-secrets.md#placeholders). Secret *names* may be cited. Fixtures must be synthetic. Enable the trufflehog pre-commit hook with `git config core.hooksPath scripts/git-hooks`.

## Operations that need io's explicit go-ahead in the session

- Any `aws s3 sync --delete` outside CI.
- `sync_to_s3.py` on `media` without `--no-delete`.
- Rotating the session signing key, which signs everyone out, or the origin-verify secret, which opens a `403` window.
- CloudFormation deploys of `hfy-app`, whose data resources are `Retain`.
- Publishing the allowlist or the admin list.
- Global flag flips in `11ty/_data/flags.json`.
- Running the live login-flow suites against production.

## Where to find things

1. [Codebase map](docs/reference/codebase-map.md) first.
2. Then the component reference: [API](docs/reference/api.md), [Identity services](docs/reference/identity-services.md), [Front end](docs/reference/front-end.md), [Architecture](docs/reference/architecture.md) and [Repository operations](docs/reference/repository-operations.md).
3. How-to pages for procedures and explanation pages for rationale, all listed in [`docs/README.md`](docs/README.md).

Out-of-repo code (the Gramps ETL, the allowlist publisher, the test-token mint helper and the Eleventy source) is named by placeholder path, such as `<project>/scripts/...` or `<eleventy-source>`. Read it, but never quote private data from it.

## Definition of done

- Run the suites for the components you touched, and record the results as acceptance evidence:
  - `api/`: `npm test`
  - `auth/`: `npm test`
  - `islands/`: `npm run check:islands`, `npm run test:contract` and `npm test`.
  - `scripts/infra/`: `scripts/infra/test/run.sh`.
  - The pipeline: `node .github/actions/io-kit-ci/parity-report/check.cjs` prints no `pipeline_drift`.
- Docs changes:
  - Each page stays exactly one Diátaxis kind: explanation, reference or how-to. There is no tutorial track.
  - When you add or move a capability, update the codebase map and the relevant reference page.
  - Component READMEs stay short pointers into `docs/`.
  - Remove stale material rather than annotating it.

## Optional companion

A one-line `CLAUDE.md` containing `@AGENTS.md` makes Claude Code load this contract automatically.
