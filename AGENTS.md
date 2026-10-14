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

- **The kit pipeline deploys `main`.** A push to `main` runs `io-kit-deploy.yml`, and pull requests run `io-kit-ci.yml`. `.github/workflows/io-kit-*.yml` and `.github/actions/io-kit-ci/*` are rendered from `ci.manifest.yaml` (HFY-TSK-060): change the manifest and re-render, never hand-edit them. See [Change the CI pipeline](docs/how-to/change-the-ci-pipeline.md). The manifest deploys the static site only (HFY-TSK-317, ruling P2-R41): no Lambda target, and the parity report is blocking (`parity.mode: block`), so a `pipeline_drift` line fails the pull request check. `post-deploy-checks.yml` is hand-maintained; it runs `scripts/infra/check-site-bucket-cors.sh` after every successful deploy run because the kit's `deploy.smoke` takes only URLs it requests with `GET`.
- **The cutover is history; its rollback hazards are current.** The production cutover ran on 2026-10-12 (HFY-TSK-069, HFY-R67): PR #8 set all six flags in `11ty/_data/flags.json` to `true`, the site deployed, and the private data gate was attached after it. Never write that the flags ship `false` or that the gate or the cutover is pending. Check the live state rather than assume it, with [Find your starting point](docs/how-to/cut-over-to-the-private-data-gate.md#find-your-starting-point): `curl -s https://<site>/_data/flags.json | jq .authV2`, and a signed-out `curl -sS -o /dev/null -D - https://<site>/person/index.json | grep -iE '^(HTTP|cache-control)'`. `401` means the gate is attached. `200` means the gate is off and the data is public. `404` with `cache-control: private, no-store` means the gate is off and the default-deny code of `HFYAppendIndex` refuses the data to everyone, members included. While the gate is attached, anything that serves `authV2` as `false` locks every visitor out of the family data: an automatic rollback to an older artifact, a revert of the flip, or an edit of `flags.json`. Never turn `authV2` off while the gate is attached (HFY-R67). The rollback order is the gate (and `HFYAppendIndex` too, if it runs the default-deny code), then the flag.
- **A failed smoke check rolls back; nothing else does.** The automatic rollback restores the previous successful run's `11ty/`, `flags.json` included, and never changes the distribution's behaviors or `HFYAppendIndex`, so the gate stays attached. After any failed deploy, run [Check authV2 after a failed deploy](docs/how-to/roll-back-a-site-deploy.md#check-authv2-after-a-failed-deploy) before you assume production is back where it was. If `authV2` is not `true` while the gate is attached, first check which code `HFYAppendIndex` runs: a signed-out `curl -sS -o /dev/null -D - https://<site>/Person/index.json` that returns `404` with `cache-control: private, no-store` means the default-deny code. Under the default-deny code, never remove the gate alone. That does not give the legacy client its data back, because the data paths then fall through to the function, which answers `404` to everyone, and it makes member photos public. Instead, leave the gate attached and get a release with `"authV2": true` live again (fix forward or revert), or remove the gate and also roll `HFYAppendIndex` back, which needs io's go-ahead too. Under older code, remove the gate at once. The linked section has the procedure for each case.
- **Gate removal invariants.** `scripts/infra/add-data-gate-behaviors.sh --remove` takes the six data behaviors off and puts `/uploads/*` back to its ungated state, so member photos become public to anyone who holds a URL. The family data is public again only if `HFYAppendIndex` runs older code; under the default-deny code, the data paths that reach it are refused to everyone. Every production `--remove`, `--dry-run` included, passes `--app-stack <app-stack>` with `us-west-2` as the AWS CLI region, or `--restore-uploads-policy-id <id>`: without either, while `/uploads/*` is gated, it exits `1` and changes nothing. Its `--stack` names the `us-east-1` gate stack, whose default, `hfy-edge-gate`, is correct: never pass `--stack <app-stack>` to this script. Procedure: [Cut over to authV2 and the private data gate: Roll back](docs/how-to/cut-over-to-the-private-data-gate.md#roll-back).
- **The legacy Google sign-in is retired from the code and the pipeline (HFY-TSK-317), and its cloud functions were deleted on 2026-10-14.** No page loads Google Identity Services or calls `/api/check-allowed`; `js/auth.js`, `js/search-navbar.js`, `js/search-results.js` and the legacy `X-HFY-Session` paths are gone; `/family-login/` is a static page that redirects to `/auth/login` and carries `?next=` over as `returnTo`; search is the Search 1.0 island alone. No push ships `hfy-check-allowed`. The Google Cloud pieces are gone: with io's approval, the `getAllowlist` Cloud Function (with its Cloud Run service), the `harrisonfamily-allowlist` Secret Manager secret and the only user-managed key of the `github-actions` service account were deleted on 2026-10-14, and HFY-TSK-325 removed `deploy-gcf-legacy.yml`, the function source and its sync check. The AWS function is gone too (HFY-TSK-326, ruling P2-R48): production CloudFront had no `/api/check-allowed*` behavior or API Gateway origin when read on 2026-10-13, and the `hfy-check-allowed` Lambda, its API Gateway, its IAM role and its log group were deleted on 2026-10-14. The repository dropped the Lambda's source, the pin logic and `--legacy-origin` in `add-api-behavior.sh`, its sync check and its grant in `github-roles.yaml`; `/api/check-allowed` now gets `hfy-api`'s `404`. The hashed allowlist is gone too (ruling P2-R51, 2026-10-14): the allowlist publisher's digest and Google steps were removed, so it uploads only `config/userGrampsID.json`; `config/allowed_hashes.json` was deleted (the bucket is versioned, so that can be reversed); and the `HFY_ALLOWLIST_HMAC_SECRET` secret, which nothing reads, is scheduled for deletion on 2026-11-13 and can be recovered until then. What remains in AWS is the deployed deploy role's grant on the deleted function, until the GitHub-roles stack is next updated. The `io_id` cookie is the only data credential: the gate checks nothing else, and the client sends no `X-HFY-Session`. Members keep their one-hour `io_id` past the hour because the client renews it from the `io_rt` refresh cookie; signing a member out on every device without removing their access takes the `FAMILY#` records listed under the go-ahead operations below. The Eleventy source's layout still emits the retired tags until it is ported: never refresh `11ty/` from it before [the mirror check](docs/how-to/refresh-the-eleventy-output.md#check-whether-the-mirror-is-done) passes.
- **The islands build output is committed (HFY-R58).** `cd islands && npm run build` writes `11ty/js/islands/`, `11ty/css/hfy-theme.css`, `11ty/css/auth-edge.css`, `11ty/fonts/`, the hfy-theme head blocks, the family-voice copy on the Eleventy pages, the `manifest.webmanifest` colours, the `hfy-asset-versions` blocks in `11ty/sw.js` and `11ty/js/feature-flags.js`, the `?v=` on every page, and `auth/edge.manifest.json` `theme.cssUrl`. Rebuild with every `islands/` change, and commit every file the build touched. `npm run check:islands` runs `node build.mjs --check`, which builds in memory and exits `1` when any output is missing, stale or extra. The build needs `node_modules` from `npm ci` with the dev dependencies, which needs `CODEARTIFACT_AUTH_TOKEN`. See [Theme and asset build](docs/reference/theme-and-asset-build.md).
- **Cloudflare caches static files for 4 hours, and no CloudFront invalidation reaches it.** Cloudflare sits in front of CloudFront. It caches js, css, fonts and `sw.js` under the URL first fetched, and does not cache the HTML. The islands build therefore versions every same-origin script, stylesheet and manifest reference with `?v=<sha8>` of the file, and the loader and the service worker read their versions from the stamped `hfy-asset-versions` blocks. Never hand-edit a `?v=` or a stamped block: rebuild. The deploy is one `aws s3 sync 11ty/ s3://<site-bucket>/ --delete` with the manifest's `exclude` globs (the data prefixes and `uploads/*`, which it never deletes), then the `/*` invalidation, with no HTML-last ordering. To verify a deploy, fetch the versioned URL the page references, not the bare path, which can return Cloudflare's copy for up to 4 hours. `/_data/flags.json` is JSON, which Cloudflare does not cache.
- **The live app stack is `<app-stack>`, not the template default `hfy-app`.** Every `add-api-behavior.sh`, `add-auth-behavior.sh`, `add-uploads-behavior.sh` and `add-mcp-behavior.sh` run passes `--stack <app-stack>`, and every `add-data-gate-behaviors.sh --remove` passes `--app-stack <app-stack>`. Lambda code ships as commit-named zips, `<code-bucket>/lambda/hfy-api-<sha>.zip` and `hfy-auth-edge-<sha>.zip`, through a reviewed CloudFormation change set. The change set shows `Conditional` replacement for the two Function URLs, which is expected, and the `FunctionUrl` and `AuthFunctionUrl` outputs must be unchanged after it executes.
- **What no workflow does.** `io-kit-ci.yml` runs only the CodeArtifact-free suites named in the `tests` key of `ci.manifest.yaml` (the family-data guard, `scripts/infra/test/run.sh` and the Gramps unit tests) on Node 22. No workflow builds the islands or runs any other test suite: not the `edge-gate/`, `tests/client/`, `scripts/cloudfront/`, `auth/` e2e or MCP conformance suites, nor the others. No workflow deploys `api/` (the MCP server included), `auth/`, the app stack, or the `us-east-1` stacks `hfy-edge-gate` (its code in `<edge-code-bucket>`) and `hfy-mcp-edge401`. No workflow runs a CloudFront behavior script (`add-mcp-behavior.sh` and `add-data-gate-behaviors.sh` included), publishes the `HFYAppendIndex` CloudFront Function, or publishes `config/groups.json`. `ci.manifest.yaml` declares no CloudFront Function target, and the deploy role can only invalidate the distribution. Those ship by hand: see [Deploy the app stack](docs/how-to/deploy-the-app-stack.md), [Deploy the edge functions](docs/how-to/deploy-the-edge-functions.md) and [Publish the CloudFront Function](docs/how-to/publish-the-cloudfront-function.md).
- **The repository does not record whether follow-up live operations ran.** That covers gating `/uploads/*`, publishing `HFYAppendIndex`, and the `hfy-auth-edge` and `hfy-api` redeploys that `auth/` and `api/` changes need, among them those of PRs #11 to #13: the design-system sign-in copy and `theme.fontOrigins` on `@io-kit/auth` 2.2.0, the `theme.cssUrl` `?v=` stamp, and the QA round 2 sign-in and push notification copy. Treat any `auth/` or `api/` change as not live until you have checked. Check before you rely on any of them, for example with `scripts/infra/publish-append-index.sh --dry-run`. In docs, describe the procedure and its check, never a claimed live state.

## Repo-shape traps

- `11ty/` is deployable **output**, and its source, `<eleventy-source>`, lives outside the repository. Unless the source has been mirrored ([Check whether the mirror is done](docs/how-to/refresh-the-eleventy-output.md#check-whether-the-mirror-is-done)), it lacks the E5 files. Mirrored or not, it never holds the islands build's outputs, so never `rsync --delete` into `11ty/`. Refresh it only with [Refresh the Eleventy output](docs/how-to/refresh-the-eleventy-output.md).
- After every Eleventy refresh, and after `promote_workspace_assets.sh`, run `cd islands && npm run build`, then `npm run check:islands`. The source does not emit the family-voice copy or the `?v=` versions, and the islands build stays authoritative for the head blocks. A page committed without that rebuild keeps the old copy and unversioned URLs, and goes stale at Cloudflare.
- `js/person-page.js` and `family-login/index.html` are repo-owned too. Unless `person-page.js` has been mirrored into the source, the source's copy waits for the legacy token, which breaks person pages while the data gate is attached; the source's `family-login/` page is the retired Google sign-in, which the refresh excludes. `css/auth-edge.css`, `css/hfy-theme.css` and `fonts/` are islands-build outputs: never mirror them into the source.
- `11ty/README.md`'s repo-owned table and refresh `rsync` are machine-checked by `scripts/infra/test/run.sh`. The table must name `js/person-page.js`, `family-login/`, `css/auth-edge.css`, `css/hfy-theme.css` and `fonts/`, and the `rsync` excludes must equal the Eleventy excludes in `scripts/check-deployment-sync.sh`, apart from `.DS_Store`. The README is deployed publicly with the rest of `11ty/`, so it never names a private or absolute local path.
- App CSS aliases tokens and never holds a literal value. `npm run lint:css` (`islands/tests/theme-lint.test.mjs`) fails on a literal colour, font family, radius or length in `islands/src/**/*.css` (the theme partials and the sign-in stylesheet source) and in the inline styles of the repo-owned pages.
- Generated files are never edited by hand: `11ty/js/islands/`, `11ty/css/hfy-theme.css`, `11ty/css/auth-edge.css` (its source is `islands/src/auth-edge/auth-edge.css`), `11ty/fonts/`, the hfy-theme head blocks, the stamped blocks in `sw.js` and `js/feature-flags.js`, and every `?v=`. A new HTML page goes into `PAGES` in `islands/heads.mjs`, or `islands/tests/theme-delivery.test.mjs` fails.
- `auth/edge.manifest.json` `theme.cssUrl` carries `?v=<sha8 of 11ty/css/auth-edge.css>`, stamped by the islands build. The sign-in pages link the new URL only after `hfy-auth-edge` is redeployed. Execute that change set only after the `io-kit-deploy` run for the same commit has finished its `invalidate` job, and do not fetch the new URL before then: an earlier request gets the old `auth-edge.css`, and Cloudflare keeps those bytes under the new URL for up to 4 hours ([Deploy the app stack: Before you start](docs/how-to/deploy-the-app-stack.md#before-you-start)).
- `scripts/cloudfront/append-index.js`, the `HFYAppendIndex` function, rewrites clean URLs and answers `404` to case and suffix variants of the private data prefixes. It may only sit on the default behavior: on any other behavior it would answer `404` to the gated data itself, and `publish-append-index.sh` refuses such an association. Tests pin `DENY_FIRST_SEGMENTS` to the gate script's patterns and `PUBLIC_PERSON_FILES` to the files in `11ty/person/`, so a new public file under `11ty/person/` goes into `PUBLIC_PERSON_FILES`.
- `edge-gate/gate.config.json` is baked into a content-addressed zip by `scripts/ci/package-edge-gate.sh`, because Lambda@Edge has no environment variables. A config or code change is a new `CodeKey`. Never overwrite a deployed `CodeKey`: the stack would keep the old code and fail to publish a version.
- The workspace helper scripts in `scripts/` assume the `<project>/repo` layout and misbehave in worktrees. Set `SKIP_DEPLOYMENT_SYNC_CHECK=1` only with the reason recorded in the worklog.
- Family data stays out of Git by rule (D-03). `.gitignore` ignores `etl-output/`, `harrisonfamily-frontend/`, `workspace/`, `workspace-local/`, `gramps_exports/`, `graph/out/`, `*.gazetteer/` and every `*.gramps`, `*.sqlite`, `*.db` and `graph/**/*.jsonl` file except the tracked synthetic samples (listed in `scripts/ci/data-sample-allowlist.txt`, which includes the Gramps fixture goldens), and `scripts/ci/check-no-family-data.sh` (run by `scripts/git-hooks/pre-commit`) fails on any other tracked file there. A new synthetic sample needs a `.gitignore` negation and a line in `scripts/ci/data-sample-allowlist.txt`. The old `export_workspace_samples.sh` is removed; edit samples in the repository.

## No-PII and no-secrets rule (hard)

Never write any of the following into code, docs, commits, PR bodies, worklogs or test fixtures:

- Secret or token values, whole or truncated.
- Real email addresses.
- Real people's names or dates.
- Gramps IDs or records from the real tree.
- Private bucket listings or object contents.
- The CloudFront distribution ID or the AWS account ID. They already appear in the deploy configuration that needs them: `ci.manifest.yaml` and the actions rendered from it, `github-roles.yaml`, the `scripts/infra/` defaults (`add-data-gate-behaviors.sh` and `publish-append-index.sh` included) and their tests, the header comment of `scripts/cloudfront/append-index.js`, and the `.npmrc` registry URLs and the lockfile URLs resolved through them. Never add them anywhere else.

Use the placeholder vocabulary in [Private data and secrets](docs/reference/private-data-and-secrets.md#placeholders). Secret *names* may be cited. Fixtures must be synthetic. Enable the trufflehog pre-commit hook with `git config core.hooksPath scripts/git-hooks`.

The header comment of `api/src/policy.js` names a real Gramps ID. Never copy it anywhere; its removal is to be raised on an HFY record.

Some family-voice UI strings name a family contact by initial: in the islands, `11ty/js/person-page.js`, `auth/edge.manifest.json` and `auth/src/edge.js`. In docs, cite the file or manifest key, or write `<family-contact>`; never quote the string.

## Operations that need io's explicit go-ahead, in the session or in the dispatch or plan that authorizes the release

- Any `aws s3 sync --delete` outside CI.
- `sync_to_s3.py` on `media` without `--no-delete`.
- Rotating the session signing key, which invalidates every outstanding `io_id` and MCP access token, or the origin-verify secret, which opens a `403` window.
- CloudFormation deploys of `<app-stack>`, whose data resources are `Retain`. That includes the `hfy-api` and `hfy-auth-edge` code redeploys.
- Deploys of the `us-east-1` stacks `hfy-edge-gate` and `hfy-mcp-edge401`.
- Any real (non `--dry-run`) run of a behavior script in `scripts/infra/`, `--remove` included.
- Any real (non `--dry-run`) run of `scripts/infra/publish-append-index.sh`. It changes what every visitor gets from the default behavior. Publish only while the gate is attached and verified ([step 5 of the cutover](docs/how-to/cut-over-to-the-private-data-gate.md#5-close-the-variant-paths-with-hfyappendindex)): without the gate, the function refuses the data to members too.
- Publishing the allowlist, the admin list or `config/groups.json`.
- A Cloudflare purge or Cache Rule change.
- Writing or deleting items in the app table by hand, for example deleting a `PASSKEY#` credential or writing the `FAMILY#` records that sign a member out on every device.
- Running the live login-flow suites against production.

## Operations that need io's G-prod approval

Global flag flips in `11ty/_data/flags.json`, turning a flag off included, and attaching the data gate (a real `add-data-gate-behaviors.sh` run without `--remove`, a re-attach after a rollback included), need io's G-prod approval, one of the HFY-PLN-001 gates, not only a go-ahead in the session. The 2026-10-12 cutover ran under that approval (HFY-TSK-069). See [Cut over to authV2 and the private data gate](docs/how-to/cut-over-to-the-private-data-gate.md).

## Where to find things

1. [Codebase map](docs/reference/codebase-map.md) first.
2. Then the component reference: [API](docs/reference/api.md), [MCP server](docs/reference/mcp-server.md), [Identity services](docs/reference/identity-services.md), [Front end](docs/reference/front-end.md), [Theme and asset build](docs/reference/theme-and-asset-build.md), [Architecture](docs/reference/architecture.md) and [Repository operations](docs/reference/repository-operations.md).
3. How-to pages for procedures, explanation pages for rationale, all listed in [`docs/README.md`](docs/README.md). The rationale for sign-in, the edge and the private data starts at [The identity model](docs/explanation/identity-model.md), [Edge and origin design](docs/explanation/edge-and-origin-design.md) and [The privacy model for family data](docs/explanation/family-data-privacy.md); for the look of the site, at [The design system theme layer](docs/explanation/design-system-theme-layer.md). Production changes start from [Deploy the app stack](docs/how-to/deploy-the-app-stack.md), [Deploy the edge functions](docs/how-to/deploy-the-edge-functions.md) and [Publish the CloudFront Function](docs/how-to/publish-the-cloudfront-function.md). The gate's rollback and re-attach are in [Cut over to authV2 and the private data gate](docs/how-to/cut-over-to-the-private-data-gate.md). Theme, font and brand changes follow [Change the theme or brand fonts](docs/how-to/change-the-theme-or-brand-fonts.md).

Out-of-repo code (the Gramps ETL, the allowlist publisher, the test-token mint helper and the Eleventy source) is named by placeholder path, such as `<project>/scripts/...` or `<eleventy-source>`. Read it, but never quote private data from it.

## Definition of done

- Run the suites for the components you touched, and record the results as acceptance evidence:
  - `api/`: `npm test`. For MCP changes, also `scripts/ci/mcp-conformance.sh blocking`.
  - `auth/`: `npm test`. For passkey changes, also `npx playwright install chromium && npm run e2e`. For a sign-in styling or `edge.manifest.json` change, also `SITE=<scratch-site> npm run e2e:theme` (Chrome), where `<scratch-site>` is an absolute path, outside the repository, to a scratch copy of `11ty/` (`cp -R 11ty <scratch-site>`) rebuilt with `node build.mjs --site <scratch-site>` in `islands/`.
  - `edge-gate/`: `npm test`.
  - `islands/`, the theme, or an Eleventy page: `npm run check:islands`, `npm run test:contract` (which includes the theme lint, `npm run lint:css`) and `npm test`. `HFY_SITE` and `PW_PORT` point the tests at a scratch `--site` build.
  - `11ty/js/feature-flags.js`, `auth-v2.js`, `person-page.js` or the `/family-login/` redirect page: `node --test tests/client/*.test.mjs` from the repository root, and `npm test` in `islands/`, whose browser specs load these scripts.
  - `scripts/cloudfront/`: `node --test scripts/cloudfront/test/*.test.mjs` from the repository root. `scripts/infra/test/run.sh` runs it too.
  - `scripts/infra/`: `scripts/infra/test/run.sh`. Besides bash, `jq` and python3 with PyYAML, it wants node, `zip`, `openssl`, `rsync`, `git` and `shasum`.
  - The pipeline: `node .github/actions/io-kit-ci/parity-report/check.cjs` prints no `pipeline_drift`.
- Docs changes:
  - Each page stays exactly one Diátaxis kind: explanation, reference or how-to. There is no tutorial track.
  - When you add or move a capability, update the codebase map and the relevant reference page.
  - Component READMEs stay short pointers into `docs/`, except the machine-checked blocks in `11ty/README.md`.
  - Docs never state test counts, or the `authV2` or gate state as live. Both change without a docs edit. Give the reader a check to run, or dated history.
  - Remove stale material rather than annotating it.

## Optional companion

A one-line `CLAUDE.md` containing `@AGENTS.md` makes Claude Code load this contract automatically.
