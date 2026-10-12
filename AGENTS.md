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
- **A failed smoke check rolls back; nothing else does.** See [Roll back a site deploy](docs/how-to/roll-back-a-site-deploy.md) before you assume production is back where it was. Once the data gate is attached, an automatic rollback can restore a `flags.json` with `authV2` false and lock every visitor out of the family data. While the gate is attached, pair any automatic rollback with `scripts/infra/add-data-gate-behaviors.sh --remove` unless `https://<site>/_data/flags.json` still shows `authV2` true. Never turn `authV2` off while the gate is attached (HFY-R67).
- **The island bundles are committed.** `11ty/js/islands/` is committed build output (HFY-R58). Rebuild and commit it with every `islands/` change. `cd islands && npm run check:islands` fails when it is stale.
- **The live app stack is `<app-stack>`, not the template default `hfy-app`.** Every `add-api-behavior.sh`, `add-auth-behavior.sh`, `add-uploads-behavior.sh` and `add-mcp-behavior.sh` run passes `--stack <app-stack>`. Lambda code ships as commit-named zips, `<code-bucket>/lambda/hfy-api-<sha>.zip` and `hfy-auth-edge-<sha>.zip`, through a reviewed CloudFormation change set. The change set shows `Conditional` replacement for the two Function URLs, which is expected, and the `FunctionUrl` and `AuthFunctionUrl` outputs must be unchanged after it executes.
- **What no workflow does.** No workflow builds the islands or runs any test suite: not the `edge-gate/`, `tests/client/`, `auth/` e2e or MCP conformance suites, nor the others. No workflow deploys `api/` (the MCP server included), `auth/`, the app stack, or the `us-east-1` stacks `hfy-edge-gate` (its code in `<edge-code-bucket>`) and `hfy-mcp-edge401`. No workflow runs a CloudFront behavior script (`add-mcp-behavior.sh` and `add-data-gate-behaviors.sh` included) or publishes `config/groups.json`. Those ship by hand: see [Deploy the app stack](docs/how-to/deploy-the-app-stack.md) and [Deploy the edge functions](docs/how-to/deploy-the-edge-functions.md).

## Repo-shape traps

- `11ty/` is deployable **output**, and its source, `<eleventy-source>`, lives outside the repository. The E5 files exist only in `11ty/`, so never `rsync --delete` into it. Refresh it only with [Refresh the Eleventy output](docs/how-to/refresh-the-eleventy-output.md).
- `js/person-page.js` is repo-owned too: the source's copy still waits for the legacy token, which breaks person pages once the data gate is attached.
- `11ty/README.md`'s repo-owned table and refresh `rsync` are machine-checked by `scripts/infra/test/run.sh`. Keep them equal to the Eleventy excludes in `scripts/check-deployment-sync.sh`.
- `11ty/js/islands/` is a build product of `islands/`. Never edit it by hand.
- `edge-gate/gate.config.json` is baked into a content-addressed zip by `scripts/ci/package-edge-gate.sh`, because Lambda@Edge has no environment variables. A config or code change is a new `CodeKey`. Never overwrite a deployed `CodeKey`: the stack would keep the old code and fail to publish a version.
- The workspace helper scripts in `scripts/` assume the `<project>/repo` layout and misbehave in worktrees. Set `SKIP_DEPLOYMENT_SYNC_CHECK=1` only with the reason recorded in the worklog.
- `scripts/export_workspace_samples.sh` wipes and re-copies the sanitized directories, pointer READMEs included, from `<project>/workspace/`. It also replaces `cloudfront/` wholesale, `distribution.json` included. Change the workspace copy too, or the next export reverts the repo copy.

## No-PII and no-secrets rule (hard)

Never write any of the following into code, docs, commits, PR bodies, worklogs or test fixtures:

- Secret or token values, whole or truncated.
- Real email addresses.
- Real people's names or dates.
- Gramps IDs or records from the real tree.
- Private bucket listings or object contents.
- The CloudFront distribution ID or the AWS account ID. They already appear in the deploy configuration that needs them: `ci.manifest.yaml` and the actions rendered from it, `github-roles.yaml`, the `scripts/infra/` defaults (`add-data-gate-behaviors.sh` included) and their tests, and the `.npmrc` registry URLs. Never add them anywhere else.

Use the placeholder vocabulary in [Private data and secrets](docs/reference/private-data-and-secrets.md#placeholders). Secret *names* may be cited. Fixtures must be synthetic. Enable the trufflehog pre-commit hook with `git config core.hooksPath scripts/git-hooks`.

The header comment of `api/src/policy.js` names a real Gramps ID. Never copy it anywhere; its removal is to be raised on an HFY record.

## Operations that need io's explicit go-ahead, in the session or in the dispatch or plan that authorizes the release

- Any `aws s3 sync --delete` outside CI.
- `sync_to_s3.py` on `media` without `--no-delete`.
- Rotating the session signing key, which invalidates every outstanding `io_id` and MCP access token, or the origin-verify secret, which opens a `403` window.
- CloudFormation deploys of `<app-stack>`, whose data resources are `Retain`.
- Deploys of the `us-east-1` stacks `hfy-edge-gate` and `hfy-mcp-edge401`.
- Any real (non `--dry-run`) run of a behavior script in `scripts/infra/`, `--remove` included.
- Publishing the allowlist, the admin list or `config/groups.json`.
- A Cloudflare purge or Cache Rule change.
- Writing or deleting items in the app table by hand, for example deleting a `PASSKEY#` credential or writing the `FAMILY#` records that sign a member out on every device.
- Running the live login-flow suites against production.

## Operations that need io's G-prod approval

Global flag flips in `11ty/_data/flags.json`, and attaching the data gate (a real `add-data-gate-behaviors.sh` run without `--remove`), need io's G-prod approval, one of the HFY-PLN-001 gates, not only a go-ahead in the session. See [Cut over to authV2 and the private data gate](docs/how-to/cut-over-to-the-private-data-gate.md).

## Where to find things

1. [Codebase map](docs/reference/codebase-map.md) first.
2. Then the component reference: [API](docs/reference/api.md), [MCP server](docs/reference/mcp-server.md), [Identity services](docs/reference/identity-services.md), [Front end](docs/reference/front-end.md), [Architecture](docs/reference/architecture.md) and [Repository operations](docs/reference/repository-operations.md).
3. How-to pages for procedures, explanation pages for rationale, all listed in [`docs/README.md`](docs/README.md). The rationale for sign-in, the edge and the private data starts at [The identity model](docs/explanation/identity-model.md), [Edge and origin design](docs/explanation/edge-and-origin-design.md) and [The privacy model for family data](docs/explanation/family-data-privacy.md). Production changes start from [Deploy the app stack](docs/how-to/deploy-the-app-stack.md), [Deploy the edge functions](docs/how-to/deploy-the-edge-functions.md) and [Cut over to authV2 and the private data gate](docs/how-to/cut-over-to-the-private-data-gate.md).

Out-of-repo code (the Gramps ETL, the allowlist publisher, the test-token mint helper and the Eleventy source) is named by placeholder path, such as `<project>/scripts/...` or `<eleventy-source>`. Read it, but never quote private data from it.

## Definition of done

- Run the suites for the components you touched, and record the results as acceptance evidence:
  - `api/`: `npm test`. For MCP changes, also `scripts/ci/mcp-conformance.sh blocking`.
  - `auth/`: `npm test`. For passkey changes, also `npx playwright install chromium && npm run e2e`.
  - `edge-gate/`: `npm test`.
  - `islands/`: `npm run check:islands`, `npm run test:contract` and `npm test`.
  - `11ty/js/feature-flags.js`, `auth-v2.js`, `person-page.js` or the search scripts (`search-navbar.js`, `search-results.js`): `node --test tests/client/*.test.mjs` from the repository root.
  - `scripts/infra/`: `scripts/infra/test/run.sh`. Besides bash, `jq` and python3 with PyYAML, it wants node, `zip`, `openssl`, `rsync` and `git`.
  - The pipeline: `node .github/actions/io-kit-ci/parity-report/check.cjs` prints no `pipeline_drift`.
- Docs changes:
  - Each page stays exactly one Diátaxis kind: explanation, reference or how-to. There is no tutorial track.
  - When you add or move a capability, update the codebase map and the relevant reference page.
  - Component READMEs stay short pointers into `docs/`, except the machine-checked blocks in `11ty/README.md`.
  - Docs never state test counts, or the `authV2` state as live. Both change without a docs edit.
  - Remove stale material rather than annotating it.

## Optional companion

A one-line `CLAUDE.md` containing `@AGENTS.md` makes Claude Code load this contract automatically.
