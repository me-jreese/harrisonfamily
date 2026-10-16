# How to run the test suites

Use this page to run each test suite in the repository with the right prerequisites, and to know before you start which suites reach production. CI runs only three CodeArtifact-free suites ([Where each suite runs](#where-each-suite-runs)); no workflow runs the others, so run the ones that cover your change before you open a pull request ([Deploy a site change](deploy-a-site-change.md)). io-kit CI does scan each pull request's commits with TruffleHog. That is a scan of the Git commit range, and it differs from the filesystem scan in step 13. The workflow's `parity` job runs only a pipeline drift check, because the manifest sets no parity baseline. It is unrelated to the MCP parity check in step 11 ([`io-kit-ci.yml`](../reference/repository-operations.md#io-kit-ciyml)). For what each suite exercises, file by file, see the [test suites table](../reference/repository-operations.md#test-suites) in Repository operations and the **Tests** row of the [codebase map](../reference/codebase-map.md).

Values in angle brackets are placeholders. `<project>` is the private project directory, which holds the tooling and data kept outside this repository. `<site>` is the site's host name, `<gramps-id>` is the test account's Gramps ID, and `<test-email>` is the sign-in email of the Cognito test user. `<app-stack>` is the name of the live app stack, which is not `hfy-app`, the `--stack` default of the app behavior scripts. `<distribution-id>` is the CloudFront distribution and `<aws-account-id>` is the AWS account. The forms are listed in [Private data and secrets](../reference/private-data-and-secrets.md#placeholders). `<policy-id>` is the ID of a CloudFront response headers policy, as the step 12 scripts print it. `<scratch-site>` is an absolute path to a directory you choose for a scratch build of the site.

## Which suites touch production

| Suite | Runs | What it reaches |
| --- | --- | --- |
| API, [`api/test/`](../../api/test/) | Offline | In process only: an in-memory DynamoDB fake, loopback test servers, and keys generated for the run, or the kit's committed test-only fixture keys for the MCP files. `api`, `package-api` and `mcp-infra` also run repository scripts in child processes, on fixture input, with no AWS call. The run writes generated documents to `api/dist/`, which is gitignored. |
| Auth edge, [`auth/test/`](../../auth/test/) | Offline | In process only: fixture environment values, in-memory stores, a fake DynamoDB table and a loopback JWKS server. |
| Passkey end to end, [`auth/e2e/passkey.e2e.mjs`](../../auth/e2e/passkey.e2e.mjs) | Local | The real auth edge app, served in process at `http://localhost:<E2E_PORT>` (default `4173`) with test-only wiring and synthetic data, driven by Playwright's Chromium with a virtual authenticator. The login page still requests Google's sign-in script. |
| Sign-in pages end to end, [`auth/e2e/signin-theme.e2e.mjs`](../../auth/e2e/signin-theme.e2e.mjs) | Local | The real auth edge pages, with their real CSP, served in process at `http://localhost:<E2E_PORT>` (default `4175`) with test-only wiring and a synthetic allowlist, plus `/css` and `/fonts` from the scratch site that `SITE` names. Playwright's bundled headless shell drives them. The login page requests Google's sign-in script unless `E2E_OFFLINE=1`. |
| Edge gate, [`edge-gate/test/`](../../edge-gate/test/) | Offline | In process only: RSA keys generated for the run, a stubbed JWKS fetch and a fixed clock. |
| Chat Worker, [`chat-worker/test/`](../../chat-worker/test/) | Offline; needs `CODEARTIFACT_AUTH_TOKEN` to install | `npm run check` and `npm test` run the committed `dist/index.js` in process: a fake Durable Object state over `node:sqlite`, a fake namespace, stubbed `fetch` and a console spy, with generated RSA and ES256 keys and synthetic ids. `test/smoke.mjs --local` and `--local-prod` also start `wrangler dev` (workerd) on `127.0.0.1` with a local JWKS and API stand-in; nothing is deployed. |
| Gramps goldens, [`gramps/tests/unit/test_gramps_goldens.py`](../../gramps/tests/unit/test_gramps_goldens.py) and [`test_gramps_relationship_goldens.py`](../../gramps/tests/unit/test_gramps_relationship_goldens.py) | Offline | Read the committed golden files ([semantics](../../api/test/records/fixtures/gramps-semantics.golden.json), [relationships](../../api/test/records/fixtures/gramps-relationships.golden.json)) only, with the standard library. They need no Gramps; regenerating the files does ([Regenerate the Gramps goldens](regenerate-the-gramps-goldens.md)). |
| Gramps addon pull, [`test_addon_pull.py`](../../gramps/tests/unit/test_addon_pull.py), [`test_addon_pull_safety.py`](../../gramps/tests/unit/test_addon_pull_safety.py), [`test_addon_media.py`](../../gramps/tests/unit/test_addon_media.py) and [`test_addon_restore.py`](../../gramps/tests/unit/test_addon_restore.py) | Offline | In process, standard library only, over the synthetic fixture: a fake tree with a real transaction semantics, a fake cloud that builds snapshots the way `api/src/sync/pull.js` does, and a temporary `HOME`. They cover snapshot verification, the plan and the preview, the backup and its retention, media down, fault injection at every step boundary (raised and killed), the stale check, open conflicts over three more runs, the inbound privacy scan, reverts, expunge notices, the reviewed plan and the restore. |
| Gramps addon rebase, [`gramps/tests/unit/test_addon_rebase.py`](../../gramps/tests/unit/test_addon_rebase.py) | Offline | In process, standard library only, over the same fake tree and fake cloud as the pull tests: a recovered cloud (a new tree id, versions and seqs from 1) meets a settled tree. D50 at the handshake, a dry run that changes nothing, the re-base of equal objects, conflicts for the rest, no write to the tree or the cloud, rejected outbox entries, a fault before the sidecar write, and the summary line. |
| Store recovery, [`api/test/sync-recovery.test.js`](../../api/test/sync-recovery.test.js) | Offline | Part of the API suite (step 1). `sync-admin.mjs` `pause --all`, `rebuild-heads`, `copy-back` and `bump-tree-id` over the in-memory table (a router over two fakes stands in for the side table): the refold equals what `applyBatch()` wrote byte for byte, a damaged head, id guard or alias is repaired, a rollback to a seq appends admin entries but leaves a privacy withdraw (without `--include-withdrawn`), a merge and a Media as tombstones, a damaged log is refused, a copy-back touches only the four sync partitions and raises `expunge_epoch` so a warm store view and the snapshot cache of the abandoned timeline are dropped, and a bumped tree id makes the desktop's routes answer `403 tree_mismatch`. The re-seed test checks the seed session is silent. |
| Gramps addon, [`gramps/tests/unit/test_addon_runtime.py`](../../gramps/tests/unit/test_addon_runtime.py) and [`test_addon_wrapper.py`](../../gramps/tests/unit/test_addon_wrapper.py) | Offline | In process and child processes, standard library only. A fake tree stands in for Gramps, a fake Gramps command for `Gramps -O <tree> -a tool`, and a temporary `HOME` and `GRAMPSHOME` hold every file; the build and install tests use a temporary plugins folder. Needs `bash` and `zip`. |
| Gramps addon, Gramps lane, [`gramps/tests/gramps/test_addon_skeleton.py`](../../gramps/tests/gramps/test_addon_skeleton.py) and [`test_addon_pull.py`](../../gramps/tests/gramps/test_addon_pull.py) | Local, on a Mac with Gramps 6.0.6 (`io-mac-gramps`) | Run `gramps/tests/gramps/run.sh test_addon_skeleton.py test_addon_pull.py` (about one to three minutes). `test_addon_pull.py` proves the apply against a real Gramps database: one `DbTxn` named for the seq, one Edit > Undo entry, and a full rollback (byte for byte) on a failed check, a changed object or a fault. It installs the addon into a throwaway `GRAMPSHOME` and drives the real Gramps command line and the `hfy-sync` wrapper on copies of the synthetic fixture tree; the audit hook forbids the real Gramps and Pictures folders for the whole run. CI does not run it. See [Install and run the Gramps sync addon](install-the-gramps-sync-addon.md). |
| Expunge, [`api/test/expunge.test.js`](../../api/test/expunge.test.js) | Offline | Part of the API suite (step 1). [`api/scripts/expunge.mjs`](../../api/scripts/expunge.mjs) against the fake table and a fake versioned S3, one group per mode (record, path, proposal, chat, upload, due), a Media record's photo, the two credential sets under the data-write guard, the pages that embedded a record in an earlier version, the render-then-`--sweep` order, the step-up check and the readers that see an expunged entry. Synthetic objects only. |
| Sync dev server, [`api/test/sync-dev-server.test.js`](../../api/test/sync-dev-server.test.js) | Offline | Part of the API suite (step 1). The real server, [`api/scripts/sync-dev-server.mjs`](../../api/scripts/sync-dev-server.mjs), started in process on an ephemeral `127.0.0.1` port and driven with `fetch`: the dev sign-in endpoints, the sync routes over the in-memory table, presigned uploads into a temporary directory, and the request log. Nothing leaves the machine. |
| Sync end-to-end scenarios, [`gramps/tests/e2e/`](../../gramps/tests/e2e/) | Local, on a Mac with Gramps 6.0.6 (`io-mac-gramps`) | Step 15. The installed addon and the addon's own sign-in and transport against that dev server, on copies of the synthetic fixture tree, inside Gramps' bundled Python and under the same audit hook as the Gramps lane. CI does not run the scenarios; it runs their plumbing, [`test_e2e_support.py`](../../gramps/tests/unit/test_e2e_support.py), with a stub in place of the server. |
| Render Lambda, [`gramps/tests/unit/test_render_lambda.py`](../../gramps/tests/unit/test_render_lambda.py) and its siblings `test_render_lambda_privacy.py`, `test_render_lambda_view.py` and `test_render_lambda_aws.py` | Offline | In process only: the real render pass over in-memory fakes of the table and the buckets (`render_lambda_support.py`), on the synthetic tree. Standard library only; the boto3 adapter tests use botocore's Stubber and skip when boto3 is not installed, and one test runs `node` on `api/src/records/semantics.js` when `node` is installed. No call reaches AWS. See [The render Lambda](../reference/sync-render.md). |
| Graph builder, [`graph/test/`](../../graph/test/) | Offline | In process, plus child processes of the builder's own command line on synthetic input. One test runs the real `sqlite3` on a database it creates in a temporary directory; the others use a stub. Nothing is read from a real tree. |
| Client scripts, [`tests/client/`](../../tests/client/) | Offline | In process only: the real `11ty/js/feature-flags.js` and `auth-v2.js` in a `vm` sandbox with stubbed `fetch`, storage and location. |
| Island `node:test` suites, `islands/tests/*.test.mjs` | Offline | In process only. The content contract drives the real `api/` handler over the DynamoDB fake, and the comments contract uses an in-memory store. The theme, copy, asset-version and bundle tests read the site in `11ty/`, or the scratch site that `HFY_SITE` names, and the bundle test rebuilds every build output in memory to compare. |
| Island browser tests, `islands/tests/*.spec.mjs` | Local | A static server on `127.0.0.1:<PW_PORT>` (default `8089`) that serves `11ty/`, or the scratch site that `HFY_SITE` names. The specs stub the API, `/auth/*` and data requests they make with synthetic data. No page requests Google's sign-in script any more (HFY-TSK-317), and a `d11-fixes` test fails if one does; a few specs still abort that request to stay hermetic. The `shell` and `settings-hub` specs also run axe-core, a pinned dev dependency injected from `node_modules` by `islands/tests/axe.mjs`, and fail on a serious or critical finding. |
| CloudFront Function tests, [`scripts/cloudfront/test/`](../../scripts/cloudfront/test/) | Offline | In process only: the source of `HFYAppendIndex` in a `vm` sandbox, the shared case table, and `git ls-files 11ty`. |
| MCP conformance gate, [`scripts/ci/mcp-conformance.sh`](../../scripts/ci/mcp-conformance.sh) | Offline; needs `CODEARTIFACT_AUTH_TOKEN` | In process only: three files of the API suite, then `io-kit parity diff` over documents it generates in `api/dist/`. When `api/node_modules` is missing, it first installs from the private registry. |
| Login flow, [`tests/login-flow/`](../../tests/login-flow/) | **Live** | The production site, signed in as a real test account. Get io's go-ahead first. |
| MCP token smoke, [`scripts/mcp/token-smoke.sh`](../../scripts/mcp/token-smoke.sh) | **Live**, read only | The production auth edge's OAuth metadata and JWKS. |
| Infrastructure script tests, [`scripts/infra/test/`](../../scripts/infra/test/) | Offline | A stub `aws` command, fixture distribution configs, and scratch copies and a scratch Git repository in a temporary directory. No call reaches AWS. |
| Infrastructure dry runs, [`scripts/infra/`](../../scripts/infra/) | **Live**, read only, or offline | Production AWS reads: secret metadata, the origin-verify secret, stack outputs in `us-west-2` and `us-east-1`, the CloudFront distribution config, the account's response headers policies and the code of the `HFYAppendIndex` function. Nothing changes. All five `add-*` scripts can also run fully offline. |
| Secret scan | Local; may contact providers to verify a finding | Every file on disk under the repository root, including installed `node_modules/` and leftover test reports. By default the scanner calls the matching provider's API to check each candidate secret. |

## Where each suite runs

Suites run in one of four places (BRD2 section 10.4). Most need the private registry, which CI cannot read (HFY-R62), so they run on the worker's checkout and the orchestrator re-runs them on the rebased head before it merges.

| Where | What runs there | How |
| --- | --- | --- |
| CI | The `test` job of `io-kit-ci.yml`, on pull requests, on Node 22, running the `tests` entries of `ci.manifest.yaml` one after another: the family-data guard `bash scripts/ci/check-no-family-data.sh`, the infrastructure script tests `bash scripts/infra/test/run.sh` (step 5; it includes the CloudFront Function tests), the Gramps unit tests `python3 -m unittest discover gramps/tests/unit`, and the client licence gate. The Gramps step passes while `gramps/tests/unit` does not exist yet. It covers the R-18 scanner port, the synthetic fixture goldens, the site renderer (`gramps/hfygramps/render/`) and the addon runtime, wrapper, build and installer, on Python 3.12 or later with the standard library only. The gate is two entries: the unit tests `node --test 'scripts/ci/test/**/*.test.mjs'` (every `*.test.mjs` under that folder, including `editing-docs.test.mjs`, which runs the field-policy page drift check, the editing routes check of the API reference and a relative-link check over the editing docs pages; the drift check installs nothing, because its generator stands in for the two `@io-kit` error classes that `api/src/http.js` imports, and one of its tests runs it in a copy with no `node_modules`) and then `node scripts/ci/check-client-licenses.mjs`. It reads the lockfile `license` fields of `islands/` (required) and `chat-worker/` (once it exists) and fails any GPL, AGPL, LGPL, EPL or SSPL package, a package with no licence, and any licence off the allow list, in the production closure plus the devDependencies named in `shippedDevDependencies` (the font packages copied into the build). Other devDependencies are not checked. A reviewed exception for a third-party package goes in the `overrides` of [`scripts/ci/license-overrides.json`](../../scripts/ci/license-overrides.json) for one exact version. First-party `@io-kit/*` packages pass by scope through its `firstPartyScopes` entry: any version with the licence `UNLICENSED` passes when its lockfile `resolved` URL starts with the io-kit CodeArtifact registry URL, and an `@io-kit/*` package resolved from anywhere else, or with no resolved URL, fails whatever its licence. `UNLICENSED` on any other package still needs an exact-version override. | `ci.manifest.yaml` `tests`, rendered with `io-kit-ci render`; see [Change the CI pipeline](change-the-ci-pipeline.md). No entry installs from CodeArtifact, and a failing command fails the PR check. |
| Worker-local | Every suite that needs `CODEARTIFACT_AUTH_TOKEN`: the API suite, the auth edge suite, the island suites and `check:islands`, the MCP conformance gate; and the offline suites that CI does not run: the edge gate and client script tests. | Steps 1 to 5, 8, 9 and 11 below, on your checkout. |
| io's Mac with Gramps 6.0.6 | The suites that need a Gramps install: the fixture tree, the schema export, the Gramps-generated goldens, the addon, the gramplet and the round-trip end-to-end test. | By hand on that Mac. |
| Production UAT | Flips, audits, seeds and every step that reaches production, including the live login flow and the GUI screenshots. | io's G-uat handoffs on production. |

Add a suite to CI only if it needs nothing from CodeArtifact: put its command in the manifest `tests` and re-render.

## Before you start

- **Node 22 or later.** `node --version` prints `v22` or higher. The `api/`, `auth/`, `chat-worker/`, `edge-gate/`, `graph/` and `islands/` packages declare `"node": ">=22"`. `tests/client/` and `scripts/cloudfront/test/` have no package and run on the same Node.
- **`CODEARTIFACT_AUTH_TOKEN` exported** before any install in `api/`, `auth/`, `chat-worker/` or `islands/`, and before `scripts/ci/mcp-conformance.sh`, which stops without it even when `api/` is already installed. Their `.npmrc` files fetch the `@io-kit/*` packages from a private CodeArtifact registry with that token. [Build and preview the islands](build-and-preview-the-islands.md) shows how to get one. `edge-gate/` has no dependencies, and `tests/client/` and `scripts/cloudfront/test/` have no package, so none of them installs anything. `tests/login-flow/` installs from the public registry and does not need the token.
- **Playwright's headless shell installed** for the island browser tests (step 4) and the sign-in pages end-to-end test (step 10). Neither needs Google Chrome: they launch the bundled `chromium-headless-shell` unless `PW_CHANNEL` names another channel.
- **Start each block from the repository root.** Every command below assumes it. Blocks that change directory do so inside parentheses, in a subshell, so your shell is back at the root when each block ends.

## Steps

Run the steps that cover your change:

| You changed | Run |
| --- | --- |
| `api/` | Step 1. For MCP changes, also step 11. |
| `auth/` | Step 2. For passkey changes, also the passkey test in step 10. |
| The sign-in pages' styling (`islands/src/auth-edge/`) or `auth/edge.manifest.json` | Steps 2, 3 and 5, and the sign-in pages test in step 10. |
| `islands/`, a theme partial or an `11ty/` page | Steps 3 and 4. |
| `edge-gate/` | Step 8. |
| `chat-worker/`, or `shared/privacy-guard.mjs` | Step 16. |
| `graph/` | Step 14. |
| `11ty/js/feature-flags.js`, `auth-v2.js`, `person-page.js` or `11ty/family-login/index.html` | Step 9. |
| `scripts/infra/`, `scripts/cloudfront/`, or a file under `11ty/person/` | Step 5. |
| `11ty/README.md` or `scripts/check-deployment-sync.sh` | Step 5, which checks that both list the same repo-owned `11ty/` files. |
| [`infrastructure/cloudformation/app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml) | Steps 2 and 5. The auth edge's store tests read the table's key schema from it. |
| `infrastructure/cloudformation/edge-gate-stack.yaml` or `github-roles.yaml` | Step 5. |
| [`infrastructure/mcp-edge401.us-east-1.yaml`](../../infrastructure/mcp-edge401.us-east-1.yaml) | Steps 1 and 5. |
| `scripts/ci/package-api.sh` | Step 1. |
| `scripts/ci/package-edge-gate.sh` | Step 5. |
| `scripts/ci/package-render.sh` | Step 5. |
| `api/scripts/sync-dev-server.mjs`, or `gramps/tests/e2e/` | Step 1 (the server's own tests), and step 15. With `gramps/tests/e2e/e2e_support.py`, also `python3 -m unittest discover gramps/tests/unit -p test_e2e_support.py`. |
| `lambda/hfy-sync-render/` or `gramps/hfygramps/render/` | Step 5, and `python3 -m unittest discover gramps/tests/unit` (the render Lambda's tests are `test_render_lambda*.py`). |
| `scripts/ci/mcp-conformance.sh` | Steps 1 and 11. Step 1 runs `shellcheck` on it when `shellcheck` is installed. |
| `scripts/mcp/token-smoke.sh` | Step 7. |
| `tests/login-flow/` | Step 6, with io's go-ahead. |

No test suite covers the other scripts in `scripts/ci/`. The `build` job of io-kit CI runs the manifest's echo-only build command on each pull request.

Steps 3 and 4 need the `api/` install from step 1. Step 10 needs the `auth/` install from step 2, and its sign-in pages test also needs the `islands/` install from step 3. Run the secret scan, step 13, last.

### 1. Run the API suite (offline)

```sh
(cd api && npm ci && npm test)
```

`npm test` runs `vitest run` over every `test/**/*.test.js` file ([`vitest.config.js`](../../api/vitest.config.js)), then `node --test` over `test/records/*.node-test.js`, the pure `node:test` suites of the editing core: the EditOp engine (`node --test test/records/ops.node-test.js`), the Gramps semantics (`node --test test/records/semantics.node-test.js`) and the relationship compiler with its duplicate matcher (`node --test test/records/relationships.node-test.js`), which run alone with no install and no network. The vitest run covers: the API's routes and rules, the MCP server and its conformance corpus, the packaging script and the MCP behavior script. The tests run against the in-memory DynamoDB fake in [`fake-ddb.js`](../../api/test/fake-ddb.js). They sign test tokens with keys generated for the run, or, in the MCP files, with the kit's committed test-only fixture keys, so they need no AWS credentials. The [test suites table](../reference/repository-operations.md#test-suites) lists what each file covers.

Three files run repository scripts in child processes, so the suite also needs `bash` and `jq`:

- `mcp-infra` dry-runs [`add-mcp-behavior.sh`](../../scripts/infra/add-mcp-behavior.sh) offline against the infra fixture config. When `shellcheck` is installed, it also runs it on that script and on `scripts/ci/mcp-conformance.sh`.
- `package-api` runs the real [`package-api.sh`](../../scripts/ci/package-api.sh) on a temporary copy, with `npm` and `zip` replaced by shims.
- `api` runs `scripts/gen-caps.mjs`, which writes the generated documents to `api/dist/`. That directory is gitignored.

### 2. Run the auth edge suite (offline)

```sh
(cd auth && npm ci && npm test)
```

`npm test` runs `vitest run` over [`auth/test/`](../../auth/test/): the edge's mount and sign-in pages as [`auth/src/edge.js`](../../auth/src/edge.js) changes them, password provisioning, the OAuth server for MCP, passkeys, the identity link and passkey stores, the origin-verify check and `/auth/userinfo`. The [test suites table](../reference/repository-operations.md#test-suites) lists what each file covers.

The tests read the committed [`edge.manifest.json`](../../auth/edge.manifest.json) and supply their own environment values. Three files also read files outside `auth/`, so a change there can fail them:

- `linkstore` and `passkeystore` read the table's key schema from [`app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml).
- `edge` compares the `?v=` in `theme.cssUrl` with the hash of the committed [`11ty/css/auth-edge.css`](../../11ty/css/auth-edge.css). After a change to `islands/src/auth-edge/auth-edge.css`, it fails until you rebuild the islands and commit both files ([Build and preview the islands](build-and-preview-the-islands.md)).

### 3. Run the island `node:test` suites (offline)

[`content-contract.test.mjs`](../../islands/tests/content-contract.test.mjs) imports the real API handler and its test harness from `api/`, so `api/` needs its dependencies installed. If you skipped step 1, run `(cd api && npm ci)` first. Then:

```sh
(cd islands && npm ci && npm run test:contract)
```

Keep the dev dependencies in the install: do not pass `--omit=dev` or set `NODE_ENV=production`. The build copies the brand fonts from the `@fontsource` dev dependencies.

`test:contract` runs `node --test tests/*.test.mjs`, every `node:test` suite in `islands/tests/`: the kit's content and comment contracts, the theme lint and the kit alias map, the head blocks and fonts in every page, the family-voice copy, the `?v=` asset versions, the uploads gate's client side, the time format, and the build outputs. The [test suites table](../reference/repository-operations.md#test-suites) lists what each file covers, and [If a suite fails](#if-a-suite-fails) gives the fix for `bundle`, `theme-delivery`, `copy`, `theme-lint` and `kit-aliases` failures.

[`bundle.test.mjs`](../../islands/tests/bundle.test.mjs) runs `node build.mjs --check` and `git check-ignore`, so run it from a Git checkout. `theme-delivery`, `copy`, `asset-versions` and `bundle` check `11ty/`. With `HFY_SITE=<scratch-site>` they check a scratch build instead (step 4), and `asset-versions` then skips its `auth/edge.manifest.json` check, because only a build into `11ty/` stamps that file.

To run only the comparison of the site with a fresh build, with a list of what differs:

```sh
(cd islands && npm run check:islands)
```

It prints `<site> is up to date (<n> generated files)`, where `<site>` is the absolute path of `11ty/`, and exits `0`. Otherwise it prints `` <site> is out of date with islands/ (run `npm run build` and commit): `` and one `missing <path>`, `stale <path>` or `extra <path>` line for each file that differs, and exits `1`. It compares every build output, not only the bundles: the theme stylesheet, the sign-in stylesheet, the fonts, the head blocks and copy in the pages, the manifest colours, the version stamps and `auth/edge.manifest.json`. Rebuild and commit them ([Build and preview the islands](build-and-preview-the-islands.md)). It writes nothing.

To run only the theme lint:

```sh
(cd islands && npm run lint:css)
(cd islands && HFY_LINT_ONLY='src/theme/40-*.css' npm run lint:css)
```

It covers `islands/src/**/*.css` and the inline styles of the fourteen repo-owned pages, `posts/index.html`, `me/index.html`, `me/notifications/index.html`, `me/links/index.html`, `me/inbox/index.html`, `me/review/index.html`, `me/requests/index.html`, `admin/sync/index.html`, `tree/index.html`, `edit/index.html`, `edit/family/index.html`, `join/index.html`, `chat/index.html` and `offline.html`. It fails on a literal colour, length or font family, and on a `var()` read of a property that is not `--io-*` or `--bs-*`. Every linted file must also parse without esbuild warnings. `HFY_LINT_ONLY` takes globs relative to `islands/`, several separated by spaces. [Theme and asset build](../reference/theme-and-asset-build.md) describes the lint, and [Change the theme or brand fonts](change-the-theme-or-brand-fonts.md) shows how to use a token instead of a literal.

### 4. Run the island browser tests (local)

1. Make sure the site matches the source. The specs serve the site as it is on disk, `11ty/` by default, with its bundles, theme stylesheet, fonts and pages. If you changed anything under `islands/`, rebuild into `11ty/` first ([Build and preview the islands](build-and-preview-the-islands.md)), or test a scratch build as below. `npm run check:islands` from step 3 tells you whether `11ty/` is current.
2. Run the specs you changed, one file at a time:

   ```sh
   (cd islands && npx playwright test tests/<spec>.spec.mjs --workers=1)
   ```

   Name more files to run more specs. `npx playwright test` with no file runs every spec, and `npm test` runs the `node:test` suites from step 3 first and then every spec, so it also needs the `api/` install. Run the whole suite only when the change reaches every page, such as the committed `flags.json`, and not on a machine someone else is using.

[`playwright.config.mjs`](../../islands/playwright.config.mjs) starts the local server for you: `npx http-server <site> -p <port> -a 127.0.0.1 -s -c-1`, at a 375 × 812 viewport. The site defaults to `../11ty` and the port to `8089`. If something is already listening on the port, Playwright reuses it, so stop any other server there first, or choose another port with `PW_PORT`.

To test a scratch build without touching `11ty/`, build into a copy of the site ([Build into a scratch copy instead](build-and-preview-the-islands.md#build-into-a-scratch-copy-instead)) and point both kinds of test at it:

```sh
rsync -a --delete 11ty/ <scratch-site>/
(cd islands && node build.mjs --site <scratch-site>)
(cd islands && HFY_SITE=<scratch-site> PW_PORT=8090 npm test)
```

`rsync --delete` makes `<scratch-site>` an exact copy of `11ty/` each time, so you can reuse the same directory for later runs and for step 10. Do not use `cp -R 11ty <scratch-site>` on a directory that already exists: it copies `11ty/` inside it, as `<scratch-site>/11ty`, and the build then runs on the old copy.

The [test suites table](../reference/repository-operations.md#test-suites) lists the specs. Each sets the flags it tests. Some serve their own `/_data/flags.json`. Others, such as `shell` and `notifications`, expect the committed [`flags.json`](../../11ty/_data/flags.json) to turn their flag on, and test the off state by forcing it off, as in `?hfy_flags=-shellV2`. After a change to the committed `flags.json`, run the whole suite.

The specs that measure the design system's look, `islands-look`, `legacy-pages`, `person-page`, `qa-fixes`, `qa2-fixes`, `shell` and `theme-foundation`, fail when the theme stylesheet or the fonts are stale, not only when a bundle is.

The specs launch Playwright's bundled headless shell, the `chromium-headless-shell` channel, and never your installed Chrome. Outside CI the config runs at most 2 workers and one spec file per worker (`fullyParallel` is off); `--workers=1` runs one. Install the shell once, which adds a build to Playwright's cache and nothing to the system:

```sh
(cd islands && npx playwright install chromium-headless-shell)
```

To drive system Google Chrome or Playwright's full Chromium instead, set `PW_CHANNEL=chrome` or `PW_CHANNEL=chromium` (after `npx playwright install chromium`). Both are explicit opt-ins. Chrome opens full browser windows on the machine, so use it only for a bug that shows only there.

When a run ends, no browser should remain. This prints nothing:

```sh
pgrep -fl playwright_chromiumdev_profile
```

If it lists browsers that you started, stop them with `pkill -f playwright_chromiumdev_profile`. That pattern also matches the browsers of other runs on the machine, so check the list first. Do not start a run in a loop or in watch or `--ui` mode.

Failure output goes to `islands/test-results/`, which is gitignored.

### 5. Run the infrastructure script tests (offline)

```sh
scripts/infra/test/run.sh
```

[`run.sh`](../../scripts/infra/test/run.sh) puts a stub `aws` first on `PATH`, so no call reaches AWS. It runs four of the five behavior scripts against fixture distribution configs, the CloudFront Function tests and [`publish-append-index.sh`](../../scripts/infra/publish-append-index.sh), the checks on `app-stack.yaml`, `github-roles.yaml` and the two `us-east-1` edge stack templates, the check that the `/privacy/` and `/terms/` pages carry the approved privacy and terms amendment, the gate's packaging script [`package-edge-gate.sh`](../../scripts/ci/package-edge-gate.sh), and `check-deployment-sync.sh` in a scratch Git repository. `add-mcp-behavior.sh` is covered by the `mcp-infra` file of the API suite instead (step 1). The [test suites table](../reference/repository-operations.md#test-suites) lists every check.

Some checks compare files that are edited by hand, and fail when the files disagree. Change them together:

- **The uploads sandbox CSP.** The Content-Security-Policy of `UploadsResponseHeadersPolicy` in `app-stack.yaml` must equal `UPLOADS_CSP` in [`scripts/infra/lib/cf-common.sh`](../../scripts/infra/lib/cf-common.sh), the string that `add-data-gate-behaviors.sh` gives `hfy-uploads-private`.
- **The repo-owned `11ty/` files.** The `11ty/` excludes of `check-deployment-sync.sh` must be exactly the excludes of the refresh `rsync` in [`11ty/README.md`](../../11ty/README.md), apart from `.DS_Store`. Both, and the README's repo-owned files table, must list `js/person-page.js`, `family-login/`, `css/auth-edge.css`, `css/hfy-theme.css` and `fonts/`.
- **The sign-in stylesheet's version.** `theme.cssUrl` in `auth/edge.manifest.json` must be the site's `/css/auth-edge.css`, with `?v=` the hash of `11ty/css/auth-edge.css`, as in step 2.

It needs `bash`, `jq`, `python3` with PyYAML, and `shasum` for the stylesheet version. The `package-render.sh` checks also need `zip` and `python3`, and the `package-edge-gate.sh` checks also need `node`, `zip` and `openssl`, the CloudFront Function checks need `node`, and the sync-check run needs `rsync` and `git`. When those are missing, the script prints `(node, zip or openssl missing: package-edge-gate.sh checks skipped)`, `(node not installed: scripts/cloudfront tests skipped)`, `(node not installed: publish-append-index.sh tests skipped)` or `(rsync or git missing: check-deployment-sync.sh run skipped)` and goes on. `cfn-lint`, on `app-stack.yaml` and the two edge stack templates, and `shellcheck` run when they are installed, and otherwise print `(cfn-lint not installed: skipped)` or `(shellcheck not installed: skipped)`. Every such line ends in `skipped)`. It ends with `scripts/infra tests: <n> passed, <m> failed` and exits non-zero if any check failed. The two `create-*` scripts are not covered: dry-run them as in step 12.

#### Run only the CloudFront Function tests

```sh
node --test scripts/cloudfront/test/*.test.mjs
```

Nothing to install. The tests load [`scripts/cloudfront/append-index.js`](../../scripts/cloudfront/append-index.js) as CloudFront gets it and run the shared case table, [`append-index.cases.json`](../../scripts/cloudfront/test/append-index.cases.json). They use `git ls-files` to check that no path shipped in `11ty/` is denied, so run them from a Git checkout. They also fail when `DENY_FIRST_SEGMENTS` no longer matches the gated patterns of `add-data-gate-behaviors.sh`, or `PUBLIC_PERSON_FILES` the files in `11ty/person/` ([If a suite fails](#if-a-suite-fails)). These tests cover the source. The live function changes only when it is published ([Publish the CloudFront function](publish-the-cloudfront-function.md)).

### 6. Run the login flow (live production)

> **Warning.** This suite signs in to the production site as a real account and opens real family pages. Get io's go-ahead before you run it. Its HTML report, failure videos and logs, in `playwright-report/`, `test-results/` and `logs/`, can show family data. All three are gitignored. Keep them on your machine and delete them when you are done, as shown at the end of this step.

Install once:

```sh
(cd tests/login-flow && npm install && npx playwright install chromium webkit)
```

The suite has no lockfile, so use `npm install`. Every test runs in both the `chromium` and the `webkit` project ([`playwright.config.ts`](../../tests/login-flow/playwright.config.ts)).

Rules for every run:

- **Set `HFY_SITE_BASE` explicitly.** When it is unset, the config and the spec fall back to the production site.
- **Pass credentials as environment variables.** The config does not load a `.env` file. Neither `.gitignore` lists `.env`, so a `.env` file in the checkout would be picked up by `git add`. Never create one there, and never commit one.
- **Read secrets with `read -rs`**, as below, so that they stay out of your shell history.
- **Run each block whole, with its parentheses.** The variables then exist only in that subshell. When the block ends, the secrets are gone, and `HFY_AUTH_V2=1` from an authV2 run cannot carry over into a later run.
- **Name the spec file.** Playwright treats each file argument as a case-insensitive regular expression and matches it against the spec's full path. The spec sits under `tests/login-flow/tests/`.

#### Choose the spec

There is one spec, the `authV2` sign-in. The production cutover, on 2026-10-12 (HFY-TSK-069, HFY-R67), turned `authV2` on and then attached the private data gate, and HFY-TSK-317 deleted the legacy Google sign-in spec with the sign-in it drove. Check which state the site is in, and whether the gate is attached, from a shell with no cookies:

```sh
curl -s https://<site>/_data/flags.json | jq .authV2
curl -s -o /dev/null -w '%{http_code}\n' https://<site>/person/index.json
```

Run the spec when the first command prints `true`. With `false` (or `null`, a `jq` error, or a `flags.json` that fails to load, which the site treats as every flag off, see [Toggle a feature flag](toggle-a-feature-flag.md)), the redirect test of the spec still passes, because `/family-login/` is a static page, but the page does not refresh `io_id`. With `false` and `401` (gate attached), members are locked out of the family data: remove the gate first, as in [Roll back](toggle-a-feature-flag.md#roll-back).

#### authV2 sign-in

[`auth-v2.spec.ts`](../../tests/login-flow/tests/auth-v2.spec.ts) is skipped unless `HFY_AUTH_V2=1`. Its redirect test passes only while the published `flags.json` has `authV2` set to `true`. The password test needs a user in the production user pool who is on the allowlist, and it is skipped when `HFY_TEST_EMAIL` or `HFY_TEST_PASSWORD` is missing.

```sh
(
  cd tests/login-flow
  export HFY_SITE_BASE=https://<site> HFY_AUTH_V2=1
  export HFY_TEST_EMAIL=<test-email> HFY_EXPECT_GRAMPS=<gramps-id>
  read -rs HFY_TEST_PASSWORD && export HFY_TEST_PASSWORD   # type the password; nothing is echoed
  npx playwright test tests/auth-v2.spec.ts
)
```

The spec checks that `/family-login/` (the static redirect page) redirects to `/auth/login`; that the login page has exactly two `section.path` elements, with the password form's email and password fields and a Google sign-in element; the published JWKS; the signed-out session; and a password sign-in whose session `sub` and **My Record** link match `HFY_EXPECT_GRAMPS`. It asserts structure, never copy, so the family-voice text of the sign-in pages does not affect it.

Its count of exactly two paths predates passkeys. An edge whose manifest lists the passkey provider, as the committed [`auth/edge.manifest.json`](../../auth/edge.manifest.json) does, renders four `section.path` elements: the Google, password and passkey paths, and the hidden prompt to add a passkey. Against such an edge, that one test fails while the other tests still show whether sign-in works.

#### After a run

Open the report, then delete the report, the failure output and the logs:

```sh
(cd tests/login-flow && npx playwright show-report)
(cd tests/login-flow && rm -rf playwright-report test-results logs)
```

`show-report` serves the report until you press Ctrl+C. If you exported any of the variables directly in your shell instead of inside a block, clear them all with `unset HFY_TEST_PASSWORD HFY_AUTH_V2 HFY_TEST_EMAIL`.

### 7. Run the MCP token smoke check (live)

The script validates an MCP access token against the production auth edge. It only reads the edge's metadata and JWKS, and it never prints the token.

1. Install the `auth/` dependencies. The script imports `jose` from `auth/node_modules` and stops with `run npm ci in auth/ first (needs jose)` if it is missing.

   ```sh
   (cd auth && npm ci)
   ```

2. Get an access token for the resource `https://<site>/mcp` by running the authorization-code flow with PKCE against `/auth/authorize` and `/auth/token`, for example from an MCP inspector. Those routes answer only when MCP redirect URIs are configured on the edge, and only for a callback listed exactly in the `McpRedirectUris` stack parameter. The stack default lists only Claude's two callbacks, so an inspector's callback must be added first ([An MCP client cannot connect](diagnose-sign-in-and-api-failures.md#an-mcp-client-cannot-connect), [Identity services](../reference/identity-services.md#mcp-authorization-server)).
3. From the repository root, run:

   ```sh
   read -rs MCP_TOKEN && export MCP_TOKEN
   scripts/mcp/token-smoke.sh
   unset MCP_TOKEN
   ```

   The script targets the production edge by default: the issuer base `https://<site>/auth` and the expected audience `https://<site>/mcp`. `--base` and `--audience` override them. Pass `--audience` only for a token issued for another resource.

The script checks the discovery document (issuer, PKCE with S256 only, public client only, both grant types, and the authorization, token and registration endpoints), then the token: its RS256 signature against the live JWKS, its key ID, issuer, audience, a `sub` that is a gramps_id, `groups` that include `members`, and a lifetime of at most an hour. Each passing check prints a line that starts with `ok`. The first failing check prints `FAIL <check>` and exits 1. A token that fails signature, issuer, audience or expiry verification also exits non-zero. The output includes the token's `sub`, which is a gramps_id, and its groups, so do not paste it anywhere public.

The script requires the key ID `hfy-session-1`. After the signing key is rotated to a new key ID, that check fails until the script is updated ([Rotate the session signing key](rotate-the-session-signing-key.md)).

### 8. Run the edge gate tests (offline)

```sh
(cd edge-gate && npm test)
```

The gate has no dependencies, so there is nothing to install and no token to export. `npm test` runs `node --test test/*.test.mjs` over [`gate.test.mjs`](../../edge-gate/test/gate.test.mjs), which runs [`src/gate.mjs`](../../edge-gate/src/gate.mjs) with RSA keys generated for the run, a stubbed JWKS fetch and a fixed clock, and checks its allow and deny answers, token checks, JWKS handling and headers. It also compares [`gate.config.json`](../../edge-gate/gate.config.json) with the session settings in `auth/edge.manifest.json`, so a change to either can fail it. The [test suites table](../reference/repository-operations.md#test-suites) lists the checks.

These tests cover the source. A published version of the gate is checked separately before anything attaches it, by invoking it with synthetic viewer-request events: see [step 5 of Deploy the edge functions](deploy-the-edge-functions.md#5-validate-the-published-version-before-anything-attaches-it).

### 9. Run the client script tests (offline)

From the repository root:

```sh
node --test tests/client/*.test.mjs
```

Nothing to install. Both files load the real [`11ty/js/feature-flags.js`](../../11ty/js/feature-flags.js) into a `vm` sandbox with stubbed `fetch`, storage and location, and record every request it makes. [`data-fetch.test.mjs`](../../tests/client/data-fetch.test.mjs) checks how data requests change with `authV2`. [`auth-continuity.test.mjs`](../../tests/client/auth-continuity.test.mjs) also loads [`11ty/js/auth-v2.js`](../../11ty/js/auth-v2.js) and checks the session check, the silent refresh and retry, and (by running the inline script of the `/family-login/` redirect page) the hand-over from `?next=` to `returnTo`. The [test suites table](../reference/repository-operations.md#test-suites) has the details.

The `auth-continuity` spec in step 4 checks the same session behavior in a browser.

### 10. Run the auth edge end-to-end tests (local)

Both tests need the `auth/` install from step 2, run the real auth edge app in process with test-only wiring and synthetic data, and reach no AWS service. They are not part of `npm test`.

#### Passkeys

```sh
(cd auth && npx playwright install chromium && npm run e2e)
```

`npx playwright install chromium` downloads the Chromium build for the Playwright version that `auth/` pins, `1.55.0`. The islands pin a different version, so a Chromium installed from `islands/` does not serve here. After the first run, `(cd auth && npm run e2e)` is enough.

`npm run e2e` runs [`passkey.e2e.mjs`](../../auth/e2e/passkey.e2e.mjs). It serves the real auth edge app from [`auth/src/edge.js`](../../auth/src/edge.js) in process on `127.0.0.1`, port `E2E_PORT` (default `4173`), and drives Chromium at `http://localhost:<port>` with a virtual authenticator that performs user verification. The relying party is `localhost`, the password provider is a stub, the stores are in memory, the signing key is generated for the run, and the allowlist holds one `example.com` address. To use another port:

```sh
(cd auth && E2E_PORT=4180 npm run e2e)
```

The scenarios run in order: the login page offers a passkey; password sign-in; enrolling a passkey and listing it; sign-out; usernameless passkey sign-in, whose session `amr` includes `passkey` and `mfa`; refusal with `403` after the address is removed from the allowlist, and sign-in again after it is restored; and refusal with `401` for a deleted credential. Each prints `PASS  <scenario>` or `FAIL  <scenario>  <detail>`, and the run ends with `<passed>/<total> scenarios passed`. It exits 1 if any scenario failed, and writes no files.

#### Sign-in pages

[`signin-theme.e2e.mjs`](../../auth/e2e/signin-theme.e2e.mjs) checks the styled sign-in pages with the stylesheet built from the current source. It needs the headless shell build for the Playwright version that `auth/` pins (`(cd auth && npx playwright install chromium-headless-shell)` installs it), and a scratch site built with the `islands/` install from step 3:

```sh
rsync -a --delete 11ty/ <scratch-site>/
(cd islands && node build.mjs --site <scratch-site>)
(cd auth && SITE=<scratch-site> npm run e2e:theme)
```

As in step 4, `rsync --delete` refreshes the copy in place, so the same `<scratch-site>` serves both steps.

It serves the real edge pages, with their real CSP, on `http://localhost:<E2E_PORT>` (default `4175`), and serves `/css` and `/fonts` from `SITE`. The pages link the stylesheet with the `?v=` of the committed `theme.cssUrl`. It drives the headless shell (`PW_CHANNEL=chrome` opts into system Chrome) at 375 and 1024 px over `/auth/login`, the forgot-password and reset pages, `/auth/link` signed out and signed in, and the denied page. Its checks include the self-hosted fonts loading, no horizontal scroll, sizes and colours from the design system, the notice for an address that is not on the allowlist, the keyboard focus ring on the Google button, the prompt to add a passkey, and no CSP violations. The wiring is test-only: a stub password provider, in-memory stores, a signing key generated for the run and a synthetic allowlist.

- `E2E_OFFLINE=1` blocks the requests to Google's sign-in script.
- `E2E_SHOTS=<dir>` saves a full-page screenshot of each page at each width.

Each check prints `PASS  <check>` or `FAIL  <check>  <detail>`, and the run ends with `<passed>/<total> checks passed`. It exits 1 if any check failed. Without `SITE`, or when `SITE` has no `css/auth-edge.css`, it exits 2 with `SITE must name a built site copy containing css/auth-edge.css (see the header of this file)`.

### 11. Run the MCP conformance gate (offline)

```sh
scripts/ci/mcp-conformance.sh blocking
```

The argument is `blocking`, the default, or `report-only`. The script works in `api/` from any directory. It stops at once if `CODEARTIFACT_AUTH_TOKEN` is unset, even when `api/` is installed. It runs `npm ci` only when `api/node_modules` is missing and otherwise uses the existing install as it is, so after a change to the `api/` dependencies run `(cd api && npm ci)` first. Then, ending at the first step that fails, it:

1. runs `scripts/gen-caps.mjs`, which writes `dist/caps.json`, `dist/policy.json`, `dist/mcp/tools.json` and `dist/mcp/parity-caps.json` under `api/`;
2. runs Vitest on `test/mcp-conformance.test.js`, `test/mcp.test.js` and `test/mcp-infra.test.js`, the MCP files of the API suite from step 1;
3. runs `io-kit parity diff` over the generated tool list and capabilities, against [`api/parity/routes.yaml`](../../api/parity/routes.yaml) and [`api/parity/map.yaml`](../../api/parity/map.yaml).

In `blocking` mode, each parity finding prints a `PARITY-FAIL` line and the script exits 1. In `report-only` mode, the same findings print as `PARITY-WARN` and the script exits 0, so read the output. Either way, the parity step ends with a summary line that starts with `hfy covered`. [MCP server](../reference/mcp-server.md#conformance-gate) describes what the gate checks.

### 12. Dry-run the infrastructure scripts (live read only, or offline)

Every script in [`scripts/infra/`](../../scripts/infra/) accepts `--dry-run` and changes nothing in that mode. A dry run still reads production AWS, so you need the `aws` CLI, `jq` for the five `add-*` scripts and `publish-append-index.sh`, and operator credentials that can read:

- the secrets' metadata, and the value of the origin-verify secret (`secretsmanager:GetSecretValue`);
- the outputs and parameters of `<app-stack>` in `us-west-2`, and the outputs of `hfy-mcp-edge401` and `hfy-edge-gate` in `us-east-1`;
- the distribution config and the account's response headers policies;
- the `HFYAppendIndex` function (`cloudfront:DescribeFunction` and `cloudfront:GetFunction`).

`publish-append-index.sh` also runs the CloudFront Function unit tests first when `node` is installed. Without `node`, it prints `(local unit tests not run: needs node and the repo's own append-index.js; test-function still gates the publish)` and goes on.

The two `create-*` scripts default to `us-west-2`. The four app behavior scripts, `add-api-behavior.sh`, `add-auth-behavior.sh`, `add-uploads-behavior.sh` and `add-mcp-behavior.sh`, take no region: they read `<app-stack>`, and all but the uploads script read the origin-verify secret, in the CLI's default region, so set it to `us-west-2` first. With another default region, they stop because the stack is not found. `add-mcp-behavior.sh` reads `hfy-mcp-edge401`, and `add-data-gate-behaviors.sh` reads `hfy-edge-gate`, in `us-east-1` whatever the default region is.

Pass `--stack <app-stack>` to the four app behavior scripts. Their `--stack` default, `hfy-app`, is not the deployed name, and without the flag they stop with `Stack with id hfy-app does not exist`. Do not pass it to `add-data-gate-behaviors.sh`: its `--stack` names the `us-east-1` gate stack, and its default, `hfy-edge-gate`, is the deployed name. Its `--remove` reads `<app-stack>` through `--app-stack` instead, whose default is also `hfy-app`. Read the origin-verify secret's name from the stack and pass it with `--secret-name`, so that the scripts compare against the secret the functions use even after a [rotation](rotate-the-origin-verify-secret.md).

```sh
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2
unset ORIGIN_VERIFY
aws sts get-caller-identity
OV_NAME="$(aws cloudformation describe-stacks --stack-name <app-stack> \
  --query "Stacks[0].Parameters[?ParameterKey=='OriginVerifySecretName'].ParameterValue" --output text)"
scripts/infra/create-session-key.sh --dry-run
scripts/infra/create-origin-verify.sh --dry-run
scripts/infra/add-api-behavior.sh --dry-run --stack <app-stack> --distribution <distribution-id> --secret-name "$OV_NAME"
scripts/infra/add-auth-behavior.sh --dry-run --stack <app-stack> --distribution <distribution-id> --secret-name "$OV_NAME"
scripts/infra/add-uploads-behavior.sh --dry-run --stack <app-stack> --distribution <distribution-id>
scripts/infra/add-mcp-behavior.sh --dry-run --stack <app-stack> --distribution <distribution-id> --secret-name "$OV_NAME"
scripts/infra/add-data-gate-behaviors.sh --dry-run --distribution <distribution-id>
scripts/infra/add-data-gate-behaviors.sh --remove --dry-run --distribution <distribution-id> --app-stack <app-stack>
scripts/infra/publish-append-index.sh --dry-run --distribution <distribution-id>
```

`ORIGIN_VERIFY` is unset because the scripts use it in preference to the secret. The `--remove` dry run shows what the gate's rollback would do, without doing it.

| Script | What the dry run reads | Output when it passes |
| --- | --- | --- |
| [`create-session-key.sh`](../../scripts/infra/create-session-key.sh) | The signing-key secret's metadata | `secret … already exists in us-west-2: no change`, or `(dry-run) would generate an RSA-2048 key (kid …) and create secret … in us-west-2` |
| [`create-origin-verify.sh`](../../scripts/infra/create-origin-verify.sh) | The origin-verify secret's metadata | `secret … already exists in us-west-2: no change`, or `(dry-run) would create secret … in us-west-2 with a random 256-bit value` |
| [`add-api-behavior.sh`](../../scripts/infra/add-api-behavior.sh) | The `FunctionUrl` output of `<app-stack>`, the origin-verify secret (never printed) and the distribution config | `distribution … already has origin hfy-api-origin and /api/*: no change`, or the behaviors before and after with a diff, the header value redacted, followed by `(dry-run) no changes made` |
| [`add-auth-behavior.sh`](../../scripts/infra/add-auth-behavior.sh) | The `AuthFunctionUrl` output of `<app-stack>`, the origin-verify secret (never printed) and the distribution config | `distribution … already has origin hfy-auth-origin and the /auth/* /.well-known/oauth-authorization-server* behaviors: no change`, or a diff as for `add-api-behavior.sh` |
| [`add-uploads-behavior.sh`](../../scripts/infra/add-uploads-behavior.sh) | The distribution config and, only while `/uploads/*` is not gated, the `UploadsResponseHeadersPolicyId` output of `<app-stack>` | While `/uploads/*` is gated: `/uploads/* is members-only (hfy-edge-gate association, add-data-gate-behaviors.sh): left as it is. add-data-gate-behaviors.sh --remove ungates it.`, then `distribution … already has the members-only /uploads/* behavior: no change`. While it is not: `serving /uploads/* from origin … with response headers policy …`, then `no change` or a diff and `(dry-run) no changes made` |
| [`add-mcp-behavior.sh`](../../scripts/infra/add-mcp-behavior.sh) | The `FunctionUrl` output of `<app-stack>`, the `Edge401FunctionVersionArn` output of `hfy-mcp-edge401` in `us-east-1`, the origin-verify secret (never printed) and the distribution config | `distribution … already has the MCP behaviors (/mcp* /.well-known/oauth-protected-resource*) with the Lambda@Edge 401 restore: no change`, or the behaviors before and after with a diff and `(dry-run) no changes made` |
| [`add-data-gate-behaviors.sh`](../../scripts/infra/add-data-gate-behaviors.sh) | The distribution config, the `EdgeGateVersionArn` output of `hfy-edge-gate` in `us-east-1`, and the account's custom response headers policies, to find `hfy-private-no-store` and `hfy-uploads-private`. It does not read the origin-verify secret. | A line for each policy, then `gating /person/*.json /family/* /event/* /note/* /place/* /media/* /uploads/* on origin … with arn:aws:lambda:us-east-1:<aws-account-id>:function:hfy-edge-gate:<n> (CachingDisabled, response headers policy <policy-id>: Cache-Control: private, no-store; /uploads/* keeps its origin and gets policy <policy-id>)`. The rest depends on how much of the gate is attached: see the table after this one. |
| `add-data-gate-behaviors.sh --remove` | The distribution config and, while `/uploads/*` is gated, the `UploadsResponseHeadersPolicyId` output of `<app-stack>` | With all seven patterns gated: the behaviors before and after, a diff that deletes the six data behaviors and puts `/uploads/*` back, in place, to no gate, `CachingOptimized` and the app stack's uploads policy, then `(dry-run) no changes made`. With the six data behaviors gated and `/uploads/*` not: a diff that deletes only the six data behaviors and leaves `/uploads/*` as it is, then `(dry-run) no changes made`. Without the gate: `distribution … already has no hfy-edge-gate-gated data behaviors (…) and /uploads/* back to its ungated state: no change` |
| [`publish-append-index.sh`](../../scripts/infra/publish-append-index.sh) | The `DEVELOPMENT` and `LIVE` stages of `HFYAppendIndex`, and the distribution config | `local unit tests pass (scripts/cloudfront/test/append-index.test.mjs)` and `HFYAppendIndex is the viewer-request function of the default cache behavior of <distribution-id>`. Then, when `LIVE` runs the repository's code, `LIVE runs exactly the repo code` and `function HFYAppendIndex already runs the repo code on LIVE: no change`. Otherwise the `LIVE` and `DEVELOPMENT` diffs, `(dry-run) would save the previous code to …, update-function HFYAppendIndex (…), test-function <n> cases on DEVELOPMENT, then publish-function` and `(dry-run) no changes made`. A real run changes what every visitor gets: see [Publish the CloudFront function](publish-the-cloudfront-function.md). |

The `add-data-gate-behaviors.sh` dry run ends in one of three ways:

| Distribution | Policy lines | Then |
| --- | --- | --- |
| All seven patterns gated, at the stack's current version | `response headers policy hfy-private-no-store (<policy-id>) already forces Cache-Control: private, no-store` and `response headers policy hfy-uploads-private (<policy-id>) already forces Cache-Control: private, no-store and the nosniff + sandbox CSP security headers` | `distribution … already has the data-gate behaviors (…) on … with response headers policies <policy-id> and <policy-id>: no change` |
| The six data behaviors gated, `/uploads/*` not yet gated | The `hfy-private-no-store` line as above. For `hfy-uploads-private`, `(dry-run) would create response headers policy hfy-uploads-private (Cache-Control: private, no-store, override and the nosniff + sandbox CSP security headers)` while that policy does not exist, or its `already forces …` line once it does. | The behaviors before and after, in the same order, and a diff that changes only `/uploads/*`, in place: `CachePolicyId` to CachingDisabled, the gate version in `LambdaFunctionAssociations`, and `ResponseHeadersPolicyId` to `hfy-uploads-private`, shown as `<new hfy-uploads-private policy id>` while that policy does not exist. Then `(dry-run) no changes made`. |
| No gate, such as a new environment | `(dry-run) would create response headers policy …` for each missing policy | A diff that adds the six data behaviors and changes `/uploads/*` in place, or creates it, already gated, where it is missing. Then `(dry-run) no changes made`. |

Production may be in the second row. The gate was attached at 12:40Z on 2026-10-12, before the script gated `/uploads/*`, and the repository does not record whether the rerun that gates it has happened ([Release model](../explanation/release-model.md)). A real run in that state is the rerun in [step 3 of Cut over to authV2 and the private data gate](cut-over-to-the-private-data-gate.md#3-attach-the-gate), a production change that needs io's G-prod approval.

Other lines from these scripts change what the result means:

- `(dry-run) origin-verify secret not read; using a placeholder`, from the API, auth or MCP script, means the credentials could not read the secret, usually for lack of `secretsmanager:GetSecretValue` or because of the wrong region or secret name. The script still ends with `(dry-run) no changes made`, but it compared against a placeholder, not the real secret, so the dry run is not meaningful. Fix the credentials, the region or `OV_NAME` and run it again.
- `(dry-run) Lambda@Edge version ARN not resolved; using a placeholder`, from `add-mcp-behavior.sh`, means it could not read `hfy-mcp-edge401` in `us-east-1`. The diff then compares against a made-up ARN, so the dry run is not meaningful. A real run would stop. Deploy the stack ([Deploy the edge functions](deploy-the-edge-functions.md#1-deploy-the-mcp-401-restore-function)), or check that your credentials can read it.
- `(only the X-Origin-Verify header value differs)`, from a run that read the real secret, means the distribution's header does not match the secret, and a real run would update the header ([Rotate the origin-verify secret](rotate-the-origin-verify-secret.md)).
- A diff that changes only the version at the end of a `LambdaFunctionARN`, from `add-mcp-behavior.sh` or `add-data-gate-behaviors.sh`, means the edge stack has published a newer version than the one attached. A real run would move live traffic to it: for the gate, on every gated behavior, `/uploads/*` included. For the gate, validate that version first, as in [step 5 of Deploy the edge functions](deploy-the-edge-functions.md#5-validate-the-published-version-before-anything-attaches-it).
- A diff in the existing `/uploads/*` behavior alone, from `add-data-gate-behaviors.sh` with the six data behaviors attached, means one of two things. Either `/uploads/*` has not been gated yet, which is expected until the rerun in [step 3 of Cut over to authV2 and the private data gate](cut-over-to-the-private-data-gate.md#3-attach-the-gate), or the behavior has drifted, for example because someone changed its cache policy. [Find your starting point](cut-over-to-the-private-data-gate.md#find-your-starting-point) shows which. Either way, a real run is a production change that needs io's G-prod approval: follow step 3 of Cut over, not this page.
- `(dry-run) would put response headers policy hfy-private-no-store (<policy-id>) back …` or `(dry-run) would put response headers policy hfy-uploads-private (<policy-id>) back …`, from `add-data-gate-behaviors.sh`, means someone changed that policy so that it no longer forces `Cache-Control: private, no-store`, or, for `hfy-uploads-private`, no longer sends `nosniff` and the sandbox Content-Security-Policy. A real run would restore it.
- `note: HFYAppendIndex is not associated with the default cache behavior of <distribution-id> (publishing only updates the function)`, from `publish-append-index.sh`, means the function does not run for any visitor of that distribution: the clean URLs and the denial of the private path variants are not in place. See [Publish the CloudFront function](publish-the-cloudfront-function.md).
- A message that starts with `refusing`, with exit status `3`: from `add-mcp-behavior.sh`, an earlier behavior would shadow an MCP path ([Deploy the app stack](deploy-the-app-stack.md#8-route-mcp-and-the-protected-resource-metadata)); from `publish-append-index.sh`, `HFYAppendIndex` is associated with a behavior other than the default one, where it would answer `404` for the gated data itself.

Run `aws sts get-caller-identity` first because the two `create-*` scripts discard errors from their existence check. Without working credentials, they print `(dry-run) would …` even when the secret exists.

To dry-run the `add-*` scripts with no AWS access at all, pass a saved config and the stack values the script would read. With `--config-file`, the scripts never read Secrets Manager or look up a response headers policy, and `add-mcp-behavior.sh` never reads `hfy-mcp-edge401`:

```sh
scripts/infra/add-api-behavior.sh --dry-run \
  --config-file cloudfront/distribution.json \
  --function-url https://example.lambda-url.us-west-2.on.aws/
scripts/infra/add-uploads-behavior.sh --dry-run \
  --config-file cloudfront/distribution.json --response-headers-policy-id example-policy-id
scripts/infra/add-mcp-behavior.sh --dry-run \
  --config-file cloudfront/distribution.json \
  --function-url https://example.lambda-url.us-west-2.on.aws/
scripts/infra/add-data-gate-behaviors.sh --dry-run \
  --config-file cloudfront/distribution.json \
  --version-arn arn:aws:lambda:us-east-1:000000000000:function:hfy-edge-gate:1
```

`--config-file` accepts either the output of `aws cloudfront get-distribution-config` or a bare `DistributionConfig`, and the scripts refuse it without `--dry-run`. `add-auth-behavior.sh` takes the same flags as `add-api-behavior.sh`. `publish-append-index.sh` has no offline mode. With the sanitized sample [`cloudfront/distribution.json`](../../cloudfront/distribution.json), which has only the S3 origin `s3-origin` and the default behavior, and no cache behaviors (`CacheBehaviors` is `{"Quantity": 0}`):

- the API dry run adds `/api/*` on a new `hfy-api-origin`, with the header value shown as `<redacted>`, as in every diff;
- the uploads dry run adds `/uploads/*` on the default behavior's origin with `example-policy-id`;
- the MCP dry run adds `/mcp*` and `/.well-known/oauth-protected-resource*` on a new `hfy-api-origin`;
- the data gate dry run adds the six gated data behaviors on the default behavior's origin, each with the placeholder `<hfy-private-no-store policy id>`, and, because the sample has no `/uploads/*`, creates it already gated, with `<hfy-uploads-private policy id>`.

Offline, the API, auth and MCP scripts print `(dry-run) origin-verify secret not read; using a placeholder`, the MCP script also prints `(dry-run) Lambda@Edge version ARN not resolved; using a placeholder` unless you pass `--edge401-arn`, and the data gate script prints `(dry-run) response headers policy hfy-private-no-store not looked up (offline); using a placeholder id` and the same line for `hfy-uploads-private`. All of them are expected there. Because every diff redacts the header value, the origin-verify line, not the diff, is what shows that no real secret was read.

### 13. Run the secret scan

Delete any login-flow reports first (end of step 6), and any sign-in screenshots you saved with `E2E_SHOTS` inside the repository, because the scan reads them too. From the repository root:

```sh
trufflehog --no-update --fail filesystem .
echo $?
```

Exit `0` means nothing was found. Exit `183` means findings: `--fail` sets that code. Any other code is a scanner error. The scan reads every file on disk under the directory, tracked or not, including installed `node_modules/`, so it can be slow and can report findings outside the source tree. It does not scan Git history. Install the scanner with `brew install trufflehog` if it is missing.

`--no-update` only skips the scanner's update check. By default trufflehog calls the matching provider's API to verify each candidate secret it finds. To keep the scan on your machine, add `--no-verification`.

The `secret_scan` job of io-kit CI also runs TruffleHog on each pull request, with `--results=verified,unknown`. It scans the pull request's commit range, not the files on disk, and it runs only after you push, so it does not replace this scan.

To run the scan on every commit, enable the repository's hooks:

```sh
git config core.hooksPath scripts/git-hooks
```

The [pre-commit hook](../../scripts/git-hooks/pre-commit) then runs the deployment sync check and this scan. It blocks the commit when the sync check fails, for example because `rsync` is missing or staged `11ty/` or `lambda/` files differ from their sources, when the scan finds something, or when `trufflehog` is not on `PATH`. [Repository operations](../reference/repository-operations.md#git-hook-scriptsgit-hookspre-commit) describes the sync check.

### 15. Run the sync end-to-end scenarios (local, Gramps 6.0.6)

The scenarios drive the installed addon and the addon's own sign-in and transport against a local copy of the sync server, on copies of the synthetic fixture tree. They need the Gramps 6.0.6 bundle at `/Applications/Gramps.app` (`HFY_GRAMPS_APP` names another), Node 22 or later, and the `api/` install from step 1 (the server runs from `api/node_modules`). From the repository root:

```sh
gramps/tests/e2e/run.sh --list                   # the scenario files
gramps/tests/e2e/run.sh                          # all of them
gramps/tests/e2e/run.sh scenario_smoke.py        # bind, status, the empty check, and the request-log greps
gramps/tests/e2e/run.sh scenario_push.py         # the push: seed, edits, replay, 409, deletes, merges, ids, the privacy greps, and the pull and push together
gramps/tests/e2e/run.sh scenario_pull.py         # the pull: check, apply, faults, conflicts, privacy, expunge, restore, reviewed plan (about 4 minutes)
gramps/tests/e2e/run.sh scenario_rebase.py       # a recovered website store (a new cloud tree, D50): pull stops, rebase re-bases and parks conflicts, nothing is sent (about 30 seconds)
```

`scenario_changes_feed.py` (HFY-TSK-277) turns `SYNC#HEAD.changes_feed` on and checks the delta pull end to end: only `/api/sync/changes` is fetched after the first pull, a delta pull and a snapshot pull give the same preview, a scrub in place discards the cache through the expunge epoch, and the 7th sync is verified against a snapshot (about 1 minute).

`scenario_pull.py` seeds the dev server through the real push routes with what the desktop projects, makes the "website" change an object (the same routes), signs the addon in through a refresh token held in a file (honoured only while `HFY_SYNC_TEST=1`; the login Keychain is never used), and then drives `hfy-sync` as io does. A fault is injected with `HFY_SYNC_FAULT=<step>` or `HFY_SYNC_FAULT=crash:<step>` (the process ends at once), also honoured only under `HFY_SYNC_TEST=1`; the steps are `after_snapshot`, `after_media`, `after_backup`, `mid_apply`, `after_commit` and `after_sidecar`. The smoke scenario's "empty check" also runs the addon's own `check` against the server.

`run.sh` is [the Gramps lane's runner](install-the-gramps-sync-addon.md) with this folder as the lane. It makes a throwaway `GRAMPSHOME` and `HOME`, imports the fixture once into a template tree, copies the template for each scenario file, and runs the file inside the bundled Python under the audit hook that forbids the real Gramps and Pictures folders. It exits `1` when any scenario or any of its negative controls fails. The login Keychain is never used: the scenarios sign in through a Keychain held in memory.

Each scenario test starts its own server, [`api/scripts/sync-dev-server.mjs`](../../api/scripts/sync-dev-server.mjs), on an ephemeral `127.0.0.1` port and stops it at the end, so no test sees another's cloud state. The server serves the real `/api/sync/*` handler over an in-memory table, a temporary directory in place of S3, and a development sign-in server that issues short-lived tokens for a synthetic owner. To run it by hand:

```sh
node api/scripts/sync-dev-server.mjs --port 0         # prints one JSON line with the origin and the log file when it listens
node api/scripts/sync-dev-server.mjs --help
```

It writes every request to `requests.jsonl` in its data directory (`--log-file` moves it) before it answers: one JSON object per line, a JSON body embedded as written, so a test can `grep` for `"dbid":"…"` and for the absence of a name. The `Authorization` header is never logged, and the sign-in endpoint's body is logged as field names only. Because bodies are logged as written, the "no tree content in the log" grep means something only for requests that carry ids and hashes, as the bind scenario's do. A scenario that pushes objects logs what it pushes, which is the projected objects only: the push scenarios (HFY-TSK-206) grep that log for the planted fixture values (phones, mail, street addresses and the exact birth days and months), and finding none is the check that held content never reaches the server. The credential grep holds for every scenario.

`--data-dir DIR` keeps `DIR` and uses only a folder the server owns inside it, `DIR/hfy-sync-dev/`, whose `s3/` store it empties at every start (the table is in memory, so a leftover object would be an orphan). It never touches anything else in `DIR`, refuses an existing `hfy-sync-dev/` it did not make, and refuses a `--log-file` that names a file that already has content. With no `--data-dir` the server makes a temporary directory and removes it on exit.

`/_dev/scrub` (`POST {class, handle, obj}`) rewrites one live head in place at the same version and seq and raises `expunge_epoch`, which is what `expunge.mjs --path` leaves behind (that script runs against AWS, so the in-memory dev table has this route instead); the pull scenarios use it. `/_dev/head` (`PATCH`) sets the store's switches (`writes_enabled`, `seeded`, `merges_enabled`, `changes_feed`, `min_client`, and `tree_id`, which stands in for `sync-admin bump-tree-id`) in place of `sync-admin`, and `/_dev/auth` (`PATCH`) sets the access-token lifetime or revokes every sign-in. The pull scenarios use the presigned `PUT`/`GET` store under `/_s3/` (media, the scrub), the change-feed scenario uses the `changes_feed` switch, the rebase scenario uses `tree_id`, and the push scenarios use `merges_enabled` and the snapshot half of that store; the token-lifetime knob is reserved for the later scenarios (push conflicts, step-up, lost-response replay). `POST /_dev/apply` runs a batch through the real `applyBatch()` as a website writer (`{origin, principal, idempotency_key, ops, step_up}`; origin `admin` by default), which is how a scenario makes a website-side edit or a cloud-created object (with `--id-policy assign`, a person with no ID yet); `GET /_dev/items?prefix=` lists the keys, never the contents, of the table items under a key prefix, for the question "is there an `IDALIAS#` item?".

The server is a development tool: it binds loopback only, refuses a request whose `Host` is not its own address, and keeps nothing after it exits. Its `/auth/authorize` endpoint has no sign-in page and approves any well-formed sign-in request for the synthetic owner at once, for any loopback port, so any process on the machine can obtain an owner token for the synthetic data. Run it only on a machine you trust, and never point it at real data. It has no deployed route; [`scripts/ci/package-api.sh`](../../scripts/ci/package-api.sh) leaves `api/scripts/` out of the Lambda package.

### 14. Run the graph builder tests (offline)

From the repository root:

```sh
(cd graph && npm ci && node --test)
```

`npm ci` installs `ajv`, the only dependency and a dev one, from the public registry, so no `CODEARTIFACT_AUTH_TOKEN` is needed. The suites build the family graph from synthetic Gramps objects and check the allowlist projection, the messy-genealogy golden, `verify()`, the schema against ajv, shuffled input giving identical bytes, atomic writes, the exit codes and `--verify-against`. They start the builder's command line as a child process. The `--from-gramps-copy` tests use a stub `sqlite3`; one more creates a small database in a temporary directory and runs the real `sqlite3` on it, and is skipped when `sqlite3` is not installed. Every temporary directory is removed afterwards. An intended change to the output needs `UPDATE_GOLDEN=1 node --test test/build.test.mjs` to rewrite the golden file. See the [graph builder README](../../graph/README.md).

## Verify

Each command you ran exits `0`. Check with `echo $?` straight after it, and read the summary:

| Suite | A pass looks like |
| --- | --- |
| API, auth edge | Vitest reports every test file passed and none failed. |
| Island `node:test` suites, theme lint, CloudFront Function tests, edge gate, client scripts, graph builder | The `node --test` summary shows `fail 0`, prefixed `ℹ` by the spec reporter or `#` by the TAP reporter, which Node 22 uses when the output is piped. |
| Passkey end to end | Every scenario line starts with `PASS`, and the last line reads `<n>/<n> scenarios passed`, with both numbers equal. |
| Sign-in pages end to end | Every check line starts with `PASS`, and the last line reads `<n>/<n> checks passed`, with both numbers equal. |
| Island browser tests | Playwright reports `passed` with no `failed`. |
| Login flow | Playwright reports `passed` with no `failed`, except, in the authV2 run against an edge with passkeys, the path-count test described in [authV2 sign-in](#authv2-sign-in). A skipped password test means `HFY_TEST_EMAIL` or `HFY_TEST_PASSWORD` was not set, so that path was not tested. |
| MCP conformance gate | Vitest reports all three files passed, and no line starts with `PARITY-FAIL`. In `report-only` mode, also check that no line starts with `PARITY-WARN`. |
| MCP token smoke | Every line starts with `ok`. |
| Site check (`check:islands`) | `<site> is up to date (<n> generated files)`. |
| Infrastructure script tests | `scripts/infra tests: <n> passed, 0 failed`. Any line that ends with `skipped)`, such as `(cfn-lint not installed: skipped)`, names checks that did not run because a tool is missing. |
| Infrastructure dry runs | Each script prints `no change` or `(dry-run) would …`, or ends with `(dry-run) no changes made`. In a live dry run, no `add-*` script printed a line that ends with `using a placeholder`. In an offline dry run, the placeholder lines listed at the end of step 12 are expected. `publish-append-index.sh` printed no `refusing` line and no `note: HFYAppendIndex is not associated …` line. |
| Sync end-to-end scenarios | Every test line ends `ok`, each scenario file ends `OK`, and the last line reads `[PASS] <n> test file(s) on per-test copies; … none under the real Gramps or Pictures folder`. |
| Secret scan | Exit `0`. |

## If a suite fails

| Symptom | Cause | Fix |
| --- | --- | --- |
| `npm ci` fails with 401 or 403 on an `@io-kit/*` package | `CODEARTIFACT_AUTH_TOKEN` is missing or expired | Export a fresh token ([Build and preview the islands](build-and-preview-the-islands.md)). |
| `mcp-conformance.sh` stops at once with `set CODEARTIFACT_AUTH_TOKEN` | The token is not exported. The script checks it even when `api/` is installed. | Export a token, then run it again. |
| `mcp-conformance.sh` fails after a change to the `api/` dependencies | It installs only when `api/node_modules` is missing, so it ran against the old install | `(cd api && npm ci)`, then run it again. |
| The content contract cannot find a package | `api/` dependencies are not installed | `(cd api && npm ci)` |
| The auth `edge` test fails on `theme.cssUrl` | The `?v=` in `auth/edge.manifest.json` is not the hash of the committed `11ty/css/auth-edge.css` | Rebuild the islands and commit both files ([Build and preview the islands](build-and-preview-the-islands.md)). The sign-in pages use the new stylesheet only after `hfy-auth-edge` is redeployed ([Deploy the app stack](deploy-the-app-stack.md)). |
| Playwright reports `Executable doesn't exist` under `chromium_headless_shell-…` | The `chromium-headless-shell` build for that package's Playwright version is not installed. `islands/` and `auth/` pin different versions, so each needs its own. | `(cd islands && npx playwright install chromium-headless-shell)`, or the same in `auth/`, as in steps 4 and 10. |
| Playwright cannot find the `chrome` distribution | `PW_CHANNEL=chrome` is set and Google Chrome is not installed | Unset `PW_CHANNEL`, which restores the headless shell, or install Chrome. |
| Island specs time out waiting for an island | The site is stale, or another server holds the port | Run `(cd islands && npm run check:islands)`; if it reports differences, rebuild with `(cd islands && npm run build)` and commit the result. Stop the other server, or set `PW_PORT`. |
| The bundle test or `check:islands` fails | The site's build outputs do not match `islands/` | Rebuild and commit every output ([Build and preview the islands](build-and-preview-the-islands.md)). `stale auth/edge.manifest.json` means the sign-in stylesheet changed: commit the manifest and redeploy `hfy-auth-edge`. |
| `theme-delivery` or `copy` fails after an Eleventy refresh | The refresh brought back pages without the head blocks or with the old copy | `(cd islands && npm run build)` and commit the pages ([Refresh the Eleventy output](refresh-the-eleventy-output.md)). |
| `theme-delivery` reports a page that is not registered | A new HTML page is missing from `PAGES` in [`islands/heads.mjs`](../../islands/heads.mjs) | Add it, then rebuild and commit. |
| `theme-lint` fails on a file | The CSS uses a literal colour, length or font family, or reads a variable that is not `--io-*` or `--bs-*` | Use a token instead ([Change the theme or brand fonts](change-the-theme-or-brand-fonts.md)). |
| `kit-aliases` fails after an `@io-kit` upgrade | The new kit CSS reads a short variable that `10-kit-aliases.css` does not map | Map it to an `--io-*` token in `10-kit-aliases.css`. |
| The CloudFront Function tests fail on `PUBLIC_PERSON_FILES` | A file was added to or removed from `11ty/person/` | Make `PUBLIC_PERSON_FILES` in [`append-index.js`](../../scripts/cloudfront/append-index.js) list exactly the files in `11ty/person/`, then publish the function ([Publish the CloudFront function](publish-the-cloudfront-function.md)). |
| The CloudFront Function tests fail on `DENY_FIRST_SEGMENTS` | The gated patterns in `add-data-gate-behaviors.sh` changed | Make `DENY_FIRST_SEGMENTS` match them, then publish the function. |
| The CloudFront Function tests fail on `git ls-files` | They ran outside a Git checkout | Run them from a clone or worktree of the repository. |
| The passkey end-to-end run prints `FAIL  e2e run completed` with a browser launch error | Playwright's Chromium for the `auth/` version is not installed | `(cd auth && npx playwright install chromium)`, then run it again. |
| An end-to-end run stops with `EADDRINUSE` | Another process holds port 4173 (passkeys) or 4175 (sign-in pages) | Stop it, or set `E2E_PORT` to a free port. |
| The sign-in pages run exits 2 | `SITE` is unset, or names a directory without `css/auth-edge.css` | Build a scratch site and pass it as `SITE`, as in step 10. |
| `scripts/infra/test/run.sh` reports `python3 with PyYAML is required for test_app_stack.py` | PyYAML is not installed | `python3 -m pip install pyyaml`, then run it again. |
| `scripts/infra/test/run.sh` prints `FAIL [check-deployment-sync.sh: repo-owned 11ty files (person-page-not-repo-owned)]: …` | The `11ty/` excludes of `check-deployment-sync.sh`, the refresh `rsync` in `11ty/README.md` and the README's repo-owned files table no longer agree, or `theme.cssUrl` is stale. The rest of the line names the check. | Make the three agree, as in step 5. For `theme.cssUrl`, rebuild the islands and commit both files ([Build and preview the islands](build-and-preview-the-islands.md)). |
| The authV2 spec's path test expects 2 `section.path` elements and finds 4 | The spec predates passkeys, and the edge renders the passkey path and the hidden passkey prompt | Not a sign-in fault. Read the other tests' results. |
| The authV2 spec's redirect test fails | The published `flags.json` does not have `authV2` set to `true` | Run the checks in [Choose the spec](#choose-the-spec). |
| `token-smoke.sh` fails the RS256 check on the key ID | The signing key was rotated to a new key ID | Update the script ([Rotate the session signing key](rotate-the-session-signing-key.md)). |
| `token-smoke.sh` fails audience verification | The token was issued for a resource other than `https://<site>/mcp` | Pass that resource with `--audience`, or get a token for `https://<site>/mcp`. |
| An app behavior script stops with `Stack with id hfy-app does not exist` | `--stack <app-stack>` was not passed | Add `--stack <app-stack>` and run it again. |
| `add-data-gate-behaviors.sh --remove` stops with `pass --restore-uploads-policy-id ID …` | `--app-stack <app-stack>` was not passed, or the CLI region is not `us-west-2`, so it could not read the uploads policy that `/uploads/*` gets back | Add `--app-stack <app-stack>` and export `AWS_REGION=us-west-2`, then run it again. |
| An `add-*` dry run prints `origin-verify secret not read; using a placeholder` | The credentials lack `secretsmanager:GetSecretValue`, the CLI region is not `us-west-2`, or `--secret-name` names the wrong secret | Fix the credentials, export `AWS_REGION=us-west-2`, or set `OV_NAME` from the stack as in step 12, then run the dry run again. |
| `add-mcp-behavior.sh` prints `Lambda@Edge version ARN not resolved; using a placeholder` | `hfy-mcp-edge401` is not deployed in `us-east-1`, or the credentials cannot read it | [Deploy the edge functions](deploy-the-edge-functions.md), or fix the credentials. |
| `add-data-gate-behaviors.sh` stops with an error about `hfy-edge-gate` or `stack hfy-edge-gate has no output EdgeGateVersionArn` | The gate stack is not deployed in `us-east-1`, or the credentials cannot read it | [Deploy the edge functions](deploy-the-edge-functions.md), or fix the credentials. |
| `publish-append-index.sh` stops with `refusing: cannot describe function HFYAppendIndex …` | The credentials lack `cloudfront:DescribeFunction`, or the function does not exist in this account. The script never creates it. | Fix the credentials. For a new environment, create the function once, as in [Stand up the static site](stand-up-the-static-site.md). |
| `gramps/tests/e2e/run.sh` stops with `node 22 or later is needed` or `api/node_modules is missing` | The dev server runs under Node and from the `api/` install | Install Node 22, and `(cd api && npm ci)` with `CODEARTIFACT_AUTH_TOKEN` exported. |
| A scenario fails with `the dev server was not ready` | The server exited at start-up or the machine is overloaded; its stderr is in the message | Run `node api/scripts/sync-dev-server.mjs --port 0` by hand and read its error; on a busy machine the wait is 30 seconds. |
| A scenario fails with `D01` or exit 75 on `bind` | A Gramps window is in the process list | The scenarios replace the process list with a fixed one; if it still happens, the run did not go through `gramps/tests/e2e/run.sh`. |

## Related pages

- [Repository operations](../reference/repository-operations.md): the workflows, the pre-commit hook, the scripts and the test suites.
- [Codebase map](../reference/codebase-map.md): where each suite lives and what it covers.
- [Theme and asset build](../reference/theme-and-asset-build.md): the islands build's outputs, the theme lint and the asset versions that the island tests check.
- [Identity services](../reference/identity-services.md): the auth edge, its OAuth server, passkeys, the session key and the private data gate.
- [API](../reference/api.md): the routes and rules the API suite covers.
- [MCP server](../reference/mcp-server.md): the MCP server and its conformance gate.
- [Release model](../explanation/release-model.md): why live checks run against production rather than a staging copy.
- [Build and preview the islands](build-and-preview-the-islands.md), [Change the theme or brand fonts](change-the-theme-or-brand-fonts.md), [Deploy a site change](deploy-a-site-change.md), [Deploy the app stack](deploy-the-app-stack.md), [Deploy the edge functions](deploy-the-edge-functions.md), [Publish the CloudFront function](publish-the-cloudfront-function.md), [Cut over to authV2 and the private data gate](cut-over-to-the-private-data-gate.md), [Connect an MCP client](connect-an-mcp-client.md), [Rotate the origin-verify secret](rotate-the-origin-verify-secret.md), [Toggle a feature flag](toggle-a-feature-flag.md).

### 16. Run the chat Worker suites (offline, and local workerd)

```sh
(cd chat-worker && npm ci && npm run check && npm test)
```

`npm run check` rebuilds the bundle in a temporary directory and exits `1` when `chat-worker/dist/` is missing, stale or extra. `npm test` runs `node --test test/*.test.mjs` over the committed bundle: the `wrangler.toml` and `deploy.json` declarations, the Durable Object rules (no timers, a tagged `acceptWebSocket`, a registered auto-response), the request the Worker hands the hub (only `x-chat-uid` and `x-chat-exp`, never the `Cookie`), the pass-through of other requests, the console staying free of headers and frame text, and the shared R-18 vectors on the bundled guard. See [Build, test and stage the chat Worker](deploy-the-chat-worker.md).

To exercise real sockets, add (needs the `workerd` binary that `npm ci` installs, and no login):

```sh
(cd chat-worker && npm run smoke -- --local && npm run smoke -- --local-prod)
```

Afterwards `pgrep -fl workerd` prints nothing. CI does not run these: the install needs CodeArtifact.
