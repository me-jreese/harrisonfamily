# Why releases ship through a pipeline and feature flags

This page explains how a change reaches visitors of the family site, and why that path has two separate switches. It also explains the two constraints that shape the pipeline: a private package registry that CI cannot reach, and a deploy role that cannot change infrastructure. For flag names, file locations and workflow steps, use the reference and how-to pages listed at the end.

## Two switches, not one

A release has two independent switches:

1. **A deploy puts code in production.** The pipeline ships the static files and the legacy sign-in Lambda. The CloudFormation app stack, which holds the API, the auth edge and their data, is deployed by hand (see [why the deploy role is narrow](#why-the-deploy-role-is-narrow)).
2. **A flag decides whether a visitor sees it.** The code is already on the page. The flag decides whether the browser activates the new surface or keeps the legacy one.

If the two were one switch, every deploy would be a launch. Keeping them apart lets the release-1 code (the shell, search, person, posts and notification islands, and the new sign-in path) sit in production while dark. Every new surface ships default-off (plan ruling HFY-R8). Its build-time value in [`11ty/_data/flags.json`](../../11ty/_data/flags.json) stays `false` until its after-state audit passes and io approves the flip.

The result is that a deploy becomes routine, and a launch becomes a one-line change to a data file that another one-line change can reverse.

## Why the flags are resolved in the browser

The site is static HTML produced by Eleventy and served from S3 through CloudFront. No server renders a page per request, so no server can decide per visitor what to show. The only place a static site can make that decision without a new build is the browser.

[`11ty/js/feature-flags.js`](../../11ty/js/feature-flags.js) does it. It reads the published flag values, then applies a per-browser override that a tester sets through a URL parameter. The [front-end reference](../reference/front-end.md#feature-flags) gives the syntax, the storage and the resolution order.

The override is what makes the flags useful (HFY-R42). io and testers can use a surface on production, against real data, real CloudFront behaviors and real sign-in, in their own browser only. That takes no deploy and has no effect on any other visitor. The audit that gates a flip therefore runs against production, not against a staging copy that might differ from it.

### Why the override is limited to one tab and made visible

Anyone can set the override, because it arrives in a URL. A link that someone else crafted can therefore put a browser into preview without its owner asking for it. An override that persisted across sessions, with nothing on the page to show it, would leave that browser on unreleased surfaces until someone thought to clear it. The first version of the resolver worked that way.

Ruling HFY-R58 bounds that risk in three ways:

- **It lasts for one tab.** The override survives moving between pages, so a tester does not have to re-add the parameter to every link, but it ends when the tab closes.
- **It is visible.** While an override is active, the page shows a small banner that says preview flags are on, with a control that turns them off. A browser is never in preview without saying so.
- **It gives up on failure.** When a flagged piece is unavailable, for example an island bundle that fails to load, the resolver drops the override. A broken preview ends there instead of following the visitor from page to page.

The resolver also deletes any override that an earlier build left in persistent storage, so a link followed before the change cannot keep a browser in preview either.

### Why the override wins the merge

The resolver applies the published values first and the override second, so a per-browser value beats the published one in both directions. That is the purpose of an override. Before a flip it must be able to force a surface on. After a flip it must be able to force the surface off, to compare against the legacy page, to reproduce a report, or to get out of a broken surface without a redeploy. If the published value won, the override could only add surfaces, and the "off" state could not be tested once a flag had been flipped.

## What a flag does not protect

A flag hides UI. It does not hide endpoints. The API under `/api/*` (Lambda `hfy-api`) and the auth edge under `/auth/*` (Lambda `hfy-auth-edge`) answer as soon as their CloudFront behaviors exist, whatever `flags.json` says. The flag is evaluated in the visitor's browser, which the visitor controls, so a direct request to an endpoint never passes through it.

Security therefore never rests on a flag. It rests on authentication at the auth edge, on the allowlist that maps a verified identity to a family record, and on the API verifying each session against the keys the edge publishes. A flag that is off is a statement about presentation, not about access. The same reasoning covers the override: anyone can add it to a URL, so a flagged surface must enforce authentication on every data call it makes. See [The identity model](identity-model.md) and [Edge and origin design](edge-and-origin-design.md).

## Why searchV2 implies shellV2

`searchV2` is meant to replace both ways into search: the navbar autocomplete and the search page. The page is replaced by the search island. The navbar autocomplete is replaced by a launcher that lives in the shell island. Without the shell, `searchV2` could deliver only the page, reached from the old navbar.

So the resolver turns `shellV2` on whenever `searchV2` is on (HFY-R48). A build-time `shellV2: false` does not stop this. The only exception is an explicit `-shellV2` in the per-browser override, which lets a tester look at search without the shell on purpose.

Each legacy search script stands down only after its replacement has mounted (HFY-R58). If the search island or the shell fails to load, the old search keeps working, so a failed island never leaves the site without search.

## Why a kit pipeline

Production deploys run through the shared io-kit CI pipeline (`@io-kit/ci`), adopted for this repo in HFY-TSK-060. A push to `main` runs [`io-kit-deploy.yml`](../../.github/workflows/io-kit-deploy.yml). The one piece outside the kit is the legacy Google Cloud Function, which deploys from its own hand-written workflow until the new sign-in path retires it (HFY-TSK-062). Each part of the kit answers a specific problem:

- **One manifest, rendered workflows.** A repo describes its build and deploy targets in [`ci.manifest.yaml`](../../ci.manifest.yaml), and the kit renders the GitHub workflows and composite actions from it. Every io project uses the same templates, so a fix to deploy logic is made once in the kit and re-rendered everywhere, instead of being patched by hand in each repo. The files are rendered into the repo rather than referenced, because io-kit is private and a workflow cannot reference actions across owners (HFY-R14).
- **A release artifact per commit.** The build output and the Lambda zip are packaged as `io-kit-release-<sha>` and deployed from that artifact. What went to production is a stored, named object, not whatever a runner happened to produce.
- **Smoke checks with automatic rollback.** After the deploy and the cache invalidation, the pipeline requests a few URLs. If any of them fails, it redeploys the artifact from the previous successful deploy run. Recovery does not depend on someone noticing.
- **A parity report.** Pull request CI reports pipeline drift, meaning rendered files that were edited by hand or AWS deploy commands in workflows outside the kit. On this repo it runs in report mode, so it informs but does not block.
- **Secret scanning.** Pull request CI runs TruffleHog over the commit range.

### Why the rendered YAML is never hand-edited

Every rendered file starts with a "do not edit" header that carries a sha256 of the rest of the file. The manifest is the source, and the YAML is output. A hand edit would be lost at the next re-render, and it would make this repo diverge from every other consumer of the kit. The drift check exists to catch such edits. To change the pipeline, change the manifest (or the kit) and re-render.

## Why CI never builds from the private registry

The `@io-kit` packages live in a private package registry. CI has no way into it. The build job runs with no AWS credentials, and the deploy role that the later jobs assume has no registry permissions. The kit is built around that limit: its workflows and actions are rendered into the repo instead of referenced, and its drift check is vendored with no dependencies so that CI can run it without registry access.

Anything that does need the registry is built outside CI. Two consequences follow.

### Why island bundles are committed output

The islands are bundled from `@io-kit` packages, so CI cannot build them. The deploy syncs the build output to the site bucket with `--delete`, which removes every object missing from the output except the excluded data and upload prefixes. A bundle that is not in the repo would never reach production, and one uploaded by hand would be deleted by the next deploy.

Ruling HFY-R58 therefore makes `11ty/js/islands/` committed build output. Whoever changes an island rebuilds the bundles locally with [`scripts/ci/build-islands.sh`](../../scripts/ci/build-islands.sh) and commits them with the source change. What is reviewed and merged is then exactly what is deployed, and a flag flip never depends on a build step the pipeline lacks.

The price is the usual cost of committed build output. Diffs carry minified code and hashed chunk names that change whenever the shared code does, and a contributor can forget to rebuild. `npm run check:islands` rebuilds in memory and fails when the committed bundles differ from the source, which catches a stale bundle whenever it runs. [Build and preview the islands](../how-to/build-and-preview-the-islands.md) covers the build.

### Why the app Lambdas are packaged by hand

The API and the auth edge also depend on `@io-kit` packages, so their zips are built outside CI as well, by [`scripts/ci/package-api.sh`](../../scripts/ci/package-api.sh) and [`scripts/ci/package-auth.sh`](../../scripts/ci/package-auth.sh). That is one of two reasons they ship by hand. The other is the deploy role.

## Why the deploy role is narrow

The pipeline acts in AWS through one role, defined in [`github-roles.yaml`](../../infrastructure/cloudformation/github-roles.yaml), which GitHub assumes through OIDC. The role trusts only workflow runs on `main`, and it can do little. It can write to the site bucket, create and read invalidations on the one distribution, and update code, versions and aliases on three named Lambda functions. It has no CloudFormation, IAM, function-creation, DynamoDB or Cognito permissions. A compromised or mistaken workflow can replace the site's files and function code, but it cannot change infrastructure or grant itself more access. When the kit arrived, the role grew only by what the kit's own steps call: the reads that let it wait for a function update or an invalidation to finish, and the version and alias actions that its Lambda rollback uses (HFY-R60). Every grant still names its function, bucket or distribution.

The role also denies writes and deletes under `uploads/`, where member post photos live (HFY-R58). The sync already excludes that prefix, but an exclude is one line in a manifest. The deny holds even if that line is changed or lost, so the site deploy can never delete what members have uploaded.

The price of a narrow role is that the app stack ships by hand. [`app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml) holds the DynamoDB table, the Cognito user pool, the two app Lambdas with their IAM roles and Function URLs, and the response headers policy for uploads. The CloudFront behaviors for `/api/*`, `/auth/*` and `/uploads/*` are added by scripts in [`scripts/infra/`](../../scripts/infra/). None of that can go through a role without CloudFormation, IAM or distribution permissions, and widening the role would give every workflow run that power.

The plan intends the app Lambdas' code to ship through kit Lambda targets eventually (HFY-R32). The role already names both functions, so that move needs no wider role. It does need a way to build their zips, which runs into the registry limit above.

## Further reading

- [Front-end reference](../reference/front-end.md): the flags, the resolver and the island loader.
- [Repository operations](../reference/repository-operations.md): the workflows, the kit manifest, the scripts, and which pieces ship by pipeline or by hand.
- [Toggle a feature flag](../how-to/toggle-a-feature-flag.md): preview a surface in one browser, or flip it for everyone.
- [Deploy a site change](../how-to/deploy-a-site-change.md): ship a static change through the kit pipeline.
- [Roll back a site deploy](../how-to/roll-back-a-site-deploy.md): what the automatic rollback covers, and how to drill it.
- [Change the CI pipeline](../how-to/change-the-ci-pipeline.md): edit the manifest and re-render.
- [Deploy the app stack](../how-to/deploy-the-app-stack.md): the manual path for the API and the auth edge.
- [Build and preview the islands](../how-to/build-and-preview-the-islands.md): rebuild the committed bundles.
- [Islands on Eleventy](islands-on-eleventy.md): why the new surfaces are islands on a static site.
