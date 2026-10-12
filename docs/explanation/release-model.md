# Why releases ship through a pipeline and feature flags

This page explains how a change reaches visitors of the family site, and why that path has separate switches: one puts code in production, one decides whether a visitor sees it, and a third, the private data gate, decides whether family data needs a session. It explains why the third switch is tied to the `authV2` flag and moves only in a fixed order. It also explains the constraints that shape the pipeline: a private package registry that CI cannot reach, a deploy role that cannot change infrastructure, and a kit that has no way to ship Lambda@Edge functions. For flag names, file locations and workflow steps, use the reference and how-to pages listed at the end.

## Two switches, not one

A release has two independent switches:

1. **A deploy puts code in production.** The pipeline ships the static files and the legacy sign-in Lambda. The CloudFormation app stack, which holds the API (with the MCP server mounted in it), the auth edge and their data, is deployed by hand. So are the CloudFront behaviors and the two Lambda@Edge stacks (see [why the deploy role is narrow](#why-the-deploy-role-is-narrow)).
2. **A flag decides whether a visitor sees it.** The code is already on the page. The flag decides whether the browser activates the new surface or keeps the legacy one.

If the two were one switch, every deploy would be a launch. Keeping them apart lets the new code (the shell, search, person, posts and notification islands, and the new sign-in path) sit in production while dark. Every new surface ships default-off (plan ruling HFY-R8). Its build-time value in [`11ty/_data/flags.json`](../../11ty/_data/flags.json) stays `false` until its after-state audit passes and io approves the flip.

The result is that a deploy becomes routine, and a launch becomes a one-line change to a data file that another one-line change can reverse. That holds for every flag until the private data gate is attached. From then on, `authV2` is no longer reversible by a single line.

The gate is a third switch. Attaching it is neither a deploy nor a flag flip. It is a change to the CloudFront distribution that puts a session check in front of the family data. Unlike the first two, it cannot be flipped independently: the gate can go on only while `authV2` is on, and `authV2` can go off only while the gate is off.

## The gate is a third switch, and the order matters

The gate is the Lambda@Edge function `hfy-edge-gate`. [`add-data-gate-behaviors.sh`](../../scripts/infra/add-data-gate-behaviors.sh) attaches it as the viewer-request function of six CloudFront behaviors, for `/person/*.json`, `/family/*`, `/event/*`, `/note/*`, `/place/*` and `/media/*`, and its `--remove` option detaches it. Until it is attached, the distribution's default behavior serves those paths from the site bucket with no check. Once it is attached, a request reaches the data only with a valid `io_id` session cookie, the cookie the auth edge sets at sign-in. [The privacy model for family data](family-data-privacy.md#gating-the-json) explains what the gate checks, and [Edge and origin design](edge-and-origin-design.md#the-data-gate-viewer-request) explains why it runs at the edge.

`authV2` decides whether a page's data requests can pass the gate. With the flag on, the page signs in at the auth edge, and its data requests carry the `io_id` cookie and no legacy header. With the flag off, the page signs in through the legacy path, which never sets `io_id`, and its data requests carry the legacy `X-HFY-Session` header, which nothing validates. The gate refuses those requests.

That gives four states, and only three of them are safe:

| `authV2` | Gate | What visitors get |
| --- | --- | --- |
| off | detached | The legacy client and public data: the site before release 2. |
| on | detached | The new client. The data is exactly as public as before; only the client has changed. |
| on | attached | The new client, and data that needs a session. The target state. |
| off | attached | Broken. The legacy client gets `401` for person, search and photo data. |

Ruling HFY-R67 orders every move so that the site never passes through the fourth state:

- **Going on: flip `authV2`, deploy and confirm, then attach the gate.** Flipping `authV2` first is harmless, because without the gate it changes only which credential the client sends. The deploy must finish, and the new `flags.json` must be confirmed live, before the gate goes on. Until then visitors still run the old client, and a gate attached first would refuse their data for as long as the deploy took, and for longer if the deploy were rolled back.
- **Going off: the same steps in reverse.** Remove the gate first and wait for the distribution to deploy. Only then, and only if the `authV2` client itself is at fault, turn `authV2` off. Never turn `authV2` off while the gate is attached.

That is why `authV2` lost its one-line rollback. Turning it off is now two steps, and the first is a change to the distribution, not an edit to a data file. Anything else that sets `authV2` back to `false` carries the same hazard, including the pipeline's own automatic rollback ([below](#why-a-kit-pipeline)).

Neither move happens without io. The global `authV2` flip and the gate attachment each need io's G-prod approval, one of the HFY-PLN-001 gates, not only a go-ahead in the session. The pipeline could not attach the gate anyway: its role can invalidate the distribution's cache, but it cannot change the distribution's configuration. [Cut over to authV2 and the private data gate](../how-to/cut-over-to-the-private-data-gate.md) has the sequence, the checks and the rollback.

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

A flag hides UI. It does not hide endpoints. The API under `/api/*` (Lambda `hfy-api`), the MCP server under `/mcp` (mounted in the same Lambda) and the auth edge under `/auth/*` (Lambda `hfy-auth-edge`) answer as soon as their CloudFront behaviors exist, whatever `flags.json` says. The flag is evaluated in the visitor's browser, which the visitor controls, so a direct request to an endpoint never passes through it.

Security therefore never rests on a flag. For the endpoints, it rests on authentication at the auth edge, on the allowlist that maps a verified identity to a family record, and on the API verifying each session cookie or MCP access token against the keys the edge publishes. For the family data, it also rests on the Lambda@Edge gate once the gate is attached. Until then, the six data paths are as public as they have always been, whatever any flag says.

`authV2` is the one flag that does more than choose what a page shows. It decides which credential the page's data requests carry, and so whether they can pass the gate. It still grants nothing: it cannot open data the gate refuses, and without the gate it closes nothing. Every other flag remains a statement about presentation, not about access. The same reasoning covers the override: anyone can add it to a URL, so a flagged surface must enforce authentication on every data call it makes. See [The identity model](identity-model.md), [Edge and origin design](edge-and-origin-design.md) and the [MCP server reference](../reference/mcp-server.md).

## Why searchV2 implies shellV2

`searchV2` is meant to replace both ways into search: the navbar autocomplete and the search page. The page is replaced by the search island. The navbar autocomplete is replaced by a launcher that lives in the shell island. Without the shell, `searchV2` could deliver only the page, reached from the old navbar.

So the resolver turns `shellV2` on whenever `searchV2` is on (HFY-R48). A build-time `shellV2: false` does not stop this. The only exception is an explicit `-shellV2` in the per-browser override, which lets a tester look at search without the shell on purpose.

Each legacy search script stands down only after its replacement has mounted (HFY-R58). If the search island or the shell fails to load, the old search keeps working, so a failed island never leaves the site without search.

## Why a kit pipeline

Production deploys run through the shared io-kit CI pipeline (`@io-kit/ci`), adopted for this repo in HFY-TSK-060. A push to `main` runs [`io-kit-deploy.yml`](../../.github/workflows/io-kit-deploy.yml). The only other deploy workflow, [`deploy-gcf-legacy.yml`](../../.github/workflows/deploy-gcf-legacy.yml), ships the legacy Google Cloud Function until the new sign-in path retires it (HFY-TSK-062). What neither workflow ships goes by hand, for reasons the later sections give. Each part of the kit answers a specific problem:

- **One manifest, rendered workflows.** A repo describes its build and deploy targets in [`ci.manifest.yaml`](../../ci.manifest.yaml), and the kit renders the GitHub workflows and composite actions from it. Every io project uses the same templates, so a fix to deploy logic is made once in the kit and re-rendered everywhere, instead of being patched by hand in each repo. The files are rendered into the repo rather than referenced, because io-kit is private and a workflow cannot reference actions across owners (HFY-R14).
- **A release artifact per commit.** The build output and the Lambda zip are packaged as `io-kit-release-<sha>` and deployed from that artifact. What went to production is a stored, named object, not whatever a runner happened to produce.
- **Smoke checks with automatic rollback.** After the deploy and the cache invalidation, the pipeline requests a few URLs. If any of them fails, it redeploys the artifact from the previous successful deploy run. Recovery does not depend on someone noticing, with one exception. The rollback restores the whole site, `flags.json` included, and knows nothing about the gate. Once the gate is attached, the artifact it restores can still have `authV2: false`, which turns `authV2` off under an attached gate. So an automatic rollback after the gate is attached is paired with `add-data-gate-behaviors.sh --remove`, unless the live `flags.json` still shows `authV2: true`.
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

The API and the auth edge also depend on `@io-kit` packages, so their zips are built outside CI as well, by [`scripts/ci/package-api.sh`](../../scripts/ci/package-api.sh) and [`scripts/ci/package-auth.sh`](../../scripts/ci/package-auth.sh). Each runs a locked `npm ci` that needs a CodeArtifact token. That is one of two reasons they ship by hand. The other is the deploy role.

The gate's script, [`scripts/ci/package-edge-gate.sh`](../../scripts/ci/package-edge-gate.sh), shows what changes when a function needs nothing from the registry. The gate has no dependencies, so the script needs no token and installs nothing. Its zip is reproducible: fixed file times and no extra attributes give the same bytes from the same sources. Its S3 key is content-addressed, named after the zip's SHA-256, so new code is always a new key. The registry is therefore not what keeps the gate out of CI. The kit and the role are ([why the edge functions ship by hand](#why-the-edge-functions-ship-by-hand)).

Built by hand does not mean shipped unreviewed. The app Lambdas' code goes to `<code-bucket>` under commit-named keys, `lambda/hfy-api-<sha>.zip` and `lambda/hfy-auth-edge-<sha>.zip`, and reaches the live app stack, `<app-stack>`, through a CloudFormation change set. The commit-named key does two jobs. CloudFormation updates a function's code only when its key changes, so a new key is what makes the update happen, and afterwards the stack's parameters name the commit that is running.

The change set is reviewed before it is executed, because the stack holds more than code. The table and the user pool are `Retain`, and the Function URLs are the origins that CloudFront sends `/api/*`, `/auth/*` and `/mcp*` to. The review is where an unintended replacement shows up. One line in it is expected noise: both Function URLs show `Conditional` replacement, because their target is the function's ARN, which CloudFormation treats as dynamic while the function is being updated. A code update keeps the ARN, so the URLs survive. Checking after execution that the `FunctionUrl` and `AuthFunctionUrl` outputs are unchanged confirms it.

## Why the deploy role is narrow

The pipeline acts in AWS through one role, defined in [`github-roles.yaml`](../../infrastructure/cloudformation/github-roles.yaml), which GitHub assumes through OIDC. The role trusts only workflow runs on `main`, and it can do little. It can write to the site bucket, create and read invalidations on the one distribution, and update code, versions and aliases on three named Lambda functions, all in `us-west-2`. It has no CloudFormation, IAM, function-creation, DynamoDB or Cognito permissions, and it cannot change the distribution's configuration. A compromised or mistaken workflow can replace the site's files and function code, but it cannot change infrastructure or grant itself more access. When the kit arrived, the role grew only by what the kit's own steps call: the reads that let it wait for a function update or an invalidation to finish, and the version and alias actions that its Lambda rollback uses (HFY-R60). Every grant still names its function, bucket or distribution.

The role also denies writes and deletes under `uploads/`, where member post photos live (HFY-R58). The sync already excludes that prefix, but an exclude is one line in a manifest. The deny holds even if that line is changed or lost, so the site deploy can never delete what members have uploaded.

The price of a narrow role is that the app stack ships by hand. [`app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml) holds the DynamoDB table, the Cognito user pool, the two app Lambdas with their IAM roles and Function URLs, and the response headers policy for uploads. Scripts in [`scripts/infra/`](../../scripts/infra/) add the CloudFront behaviors: `/api/*`, `/auth/*` and `/uploads/*`; `/mcp*` and the MCP server's protected-resource metadata path ([`add-mcp-behavior.sh`](../../scripts/infra/add-mcp-behavior.sh)); and the six gated data paths. The gate script also creates the response headers policy `hfy-private-no-store`, which marks every gated response `private, no-store`, so that Cloudflare, which proxies the site, never stores one. Two `us-east-1` stacks ship by hand as well ([below](#why-the-edge-functions-ship-by-hand)). None of that can go through a role without CloudFormation, IAM or distribution permissions, and widening the role would give every workflow run that power.

The plan intends the app Lambdas' code to ship through kit Lambda targets eventually (HFY-R32). The role already names both functions, so that move needs no wider role. It does need a way to build their zips, which runs into the registry limit above.

### Why the edge functions ship by hand

The site's two Lambda@Edge functions live in their own stacks in `us-east-1`, the only Region where Lambda@Edge functions can be created. `hfy-mcp-edge401` ([`mcp-edge401.us-east-1.yaml`](../../infrastructure/mcp-edge401.us-east-1.yaml)) carries its code inline in the template. `hfy-edge-gate` ([`edge-gate-stack.yaml`](../../infrastructure/cloudformation/edge-gate-stack.yaml)) loads its code from a private bucket in that Region, `<edge-code-bucket>`. The gate needs nothing from the registry, so a runner could build it. It still ships by hand, because neither the kit nor the role can deploy it:

- **The kit has no way to.** The rendered actions under [`.github/actions/io-kit-ci/`](../../.github/actions/io-kit-ci/) build, package, sync static files, update Lambda code, invalidate, smoke-test, roll back, scan for secrets and report drift. None deploys a CloudFormation stack or a Lambda@Edge function, and `@io-kit/ci` 0.1.3 has no such target kind: its kinds are `s3_static`, `lambda`, `cloudfront_function` and `codeartifact`. The `lambda` kind updates a function in the manifest's single deploy Region, `us-west-2` here, and can publish a version behind an alias. CloudFront, however, runs only the numbered version that a behavior names, and no kit step edits the distribution's behaviors. The `cloudfront_function` kind publishes CloudFront Functions, which can do neither job ([Edge and origin design](edge-and-origin-design.md#two-deliberate-lambdaedge-exceptions)).
- **The role has no permission to.** The deploy role has no CloudFormation permission, and its Lambda grants name only `hfy-check-allowed`, `hfy-api` and `hfy-auth-edge`, all in `us-west-2`. It cannot change the distribution's configuration either.

Widening either would be the wrong fix. Pointing the gated behaviors at a new gate version is the gate switch itself, and that belongs with io's approval, not with a merge to `main`.

Shipping by hand follows two rules that come from how Lambda@Edge runs:

- **Versions are retained.** CloudFront replicates the version it is given to its edge locations, and a version cannot be deleted while those replicas exist. Both stacks keep the old version when they publish a new one (`DeletionPolicy` and `UpdateReplacePolicy` are `Retain`), so a stack update never tries to delete a version the distribution may still be running. CloudFront removes the replicas some hours after the last association is gone.
- **Code is content-addressed.** CloudFormation publishes a new version only when the version resource changes, so code that changes without a new version is a silent no-op. `package-edge-gate.sh` therefore names the gate's S3 key after the zip's hash and hands the hash to the stack. New gate code is always a new key and a new version, and a zip that does not match its hash fails the stack update before anything reaches CloudFront. The 401-restore function's version carries a hash of its inline code in its description, and a test fails whenever the code and that hash disagree.

A stack update alone changes nothing that a visitor sees. A new version takes traffic only when `add-data-gate-behaviors.sh` or `add-mcp-behavior.sh` runs again to name it, and a new gate version runs only after it has been invoked with synthetic viewer requests and has refused or redirected each one as it should. Deploying and attaching stay separate switches here too.

## Further reading

- [Front-end reference](../reference/front-end.md): the flags, the resolver and the island loader.
- [Repository operations](../reference/repository-operations.md): the workflows, the kit manifest, the scripts, and which pieces ship by pipeline or by hand.
- [Toggle a feature flag](../how-to/toggle-a-feature-flag.md): preview a surface in one browser, or flip it for everyone.
- [Cut over to authV2 and the private data gate](../how-to/cut-over-to-the-private-data-gate.md): flip `authV2`, attach the gate in that order, and roll back in reverse.
- [Deploy a site change](../how-to/deploy-a-site-change.md): ship a static change through the kit pipeline.
- [Roll back a site deploy](../how-to/roll-back-a-site-deploy.md): what the automatic rollback covers, and how to drill it.
- [Change the CI pipeline](../how-to/change-the-ci-pipeline.md): edit the manifest and re-render.
- [Deploy the app stack](../how-to/deploy-the-app-stack.md): the manual path for the API, the MCP server and the auth edge.
- [Deploy the edge functions](../how-to/deploy-the-edge-functions.md): build, deploy and validate the two `us-east-1` Lambda@Edge stacks.
- [Build and preview the islands](../how-to/build-and-preview-the-islands.md): rebuild the committed bundles.
- [Edge and origin design](edge-and-origin-design.md): why the gate and the MCP 401 restore run at the edge, and how their versions are published.
- [Islands on Eleventy](islands-on-eleventy.md): why the new surfaces are islands on a static site.
