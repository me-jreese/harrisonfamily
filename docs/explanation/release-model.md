# Why releases ship through a pipeline and feature flags

This page explains how a change reaches visitors of the family site, and why that path has separate switches: one puts code in production, one decides whether a visitor sees it, and a third, the private data gate, decides whether family data and member photos need a session. It explains why the third switch is tied to the `authV2` flag and moves only in a fixed order, and what that order means once the cutover has run. It also explains the constraints that shape the pipeline: a private package registry that CI cannot reach, a deploy role that cannot change infrastructure, a kit that has no way to ship Lambda@Edge functions, and a second cache in front of CloudFront that the pipeline's invalidation never reaches. For flag names, file locations and workflow steps, use the reference and how-to pages listed at the end.

## Two switches, not one

A release has two independent switches:

1. **A deploy puts code in production.** The pipeline ships the static files and nothing else (the kit manifest has no Lambda target, HFY-TSK-317). The CloudFormation app stack, which holds the API (with the MCP server mounted in it), the auth edge and their data, is deployed by hand. So are the CloudFront behaviors, the CloudFront Function on the default behavior and the two Lambda@Edge stacks (see [why the deploy role is narrow](#why-the-deploy-role-is-narrow)).
2. **A flag decides whether a visitor sees it.** The code is already on the page. The flag decides whether the browser activates the new surface or keeps the page without it.

If the two were one switch, every deploy would be a launch. Keeping them apart let the new code (the shell, search, person, posts and notification islands, and the new sign-in path) sit in production while dark. Every new surface shipped default-off (plan ruling HFY-R8), and its build-time value in [`11ty/_data/flags.json`](../../11ty/_data/flags.json) stayed `false` until its after-state audit passed and io approved the flip. The production cutover on 2026-10-12 flipped all six flags for everyone in one commit (HFY-TSK-069). What the published file says at any moment is a check, not something to remember: `curl -s https://<site>/_data/flags.json | jq .authV2`.

The result is that a deploy becomes routine, and a launch becomes a one-line change to a data file that another one-line change can reverse. That holds for every flag except `authV2` while the private data gate is attached. Under the gate, `authV2` is no longer reversible by a single line.

The gate is a third switch. Attaching it is neither a deploy nor a flag flip. It is a change to the CloudFront distribution that puts a session check in front of the family data and member photos. Unlike the first two, it cannot be flipped independently: the gate can go on only while `authV2` is on, and `authV2` can go off only while the gate is off. Going back to a client with `authV2` off can also depend on a fourth piece, the CloudFront Function on the default behavior. While that function runs its default-deny code, such a client gets its data back only if the function is rolled back too ([below](#why-removing-the-gate-can-leave-the-data-unreachable)).

## The gate is a third switch, and the order matters

The gate is the Lambda@Edge function `hfy-edge-gate`. [`add-data-gate-behaviors.sh`](../../scripts/infra/add-data-gate-behaviors.sh) attaches it as the viewer-request function of seven CloudFront behaviors. It creates six for the family data: `/person/*.json`, `/family/*`, `/event/*`, `/note/*`, `/place/*` and `/media/*`. The seventh, `/uploads/*`, where member post photos live, already exists because [`add-uploads-behavior.sh`](../../scripts/infra/add-uploads-behavior.sh) made it, so the script gates it in place and keeps its position and origin. Without the gate, nothing checks a session on these paths. `/uploads/*` serves a photo to anyone who holds its URL. The data paths fall through to the distribution's default behavior, and what they get there depends on the code its CloudFront Function runs: the site bucket's files, served to anyone, or a `404` for everyone ([below](#why-removing-the-gate-can-leave-the-data-unreachable)). With the gate, a request reaches either only with a valid `io_id` session cookie, the cookie the auth edge sets at sign-in. [The privacy model for family data](family-data-privacy.md#gating-the-json) explains what the gate checks, and [Edge and origin design](edge-and-origin-design.md#the-data-gate-viewer-request) explains why it runs at the edge.

`authV2` decides whether a page's data requests can pass the gate. With the flag on, the page keeps its edge session alive: its data requests carry the `io_id` cookie, a lapsed cookie is refreshed, and a gate `401` is retried once. With the flag off, the cookie is still sent, but nothing refreshes it (the legacy Google sign-in and its `X-HFY-Session` header, which nothing validated, were removed by HFY-TSK-317). Once the hour is up the gate refuses those requests.

That gives four states:

| `authV2` | Gate | What visitors get |
| --- | --- | --- |
| off | detached | The unrefreshed client. Member photos are public to anyone holding a URL. The data is either public, as before release 2, or refused to everyone (see below the table). |
| on | detached | The new client, with the same access as the row above; only the client has changed. |
| on | attached | The new client, and data and photos that need a session. The target state. |
| off | attached | Broken. The client gets `401` for person, search and photo data once `io_id` lapses. |

The two detached rows depend on `HFYAppendIndex`, the CloudFront Function on the default behavior. With the code it ran before release 2, the data paths reach the site bucket and anyone can read them, so both detached states work and only the fourth is broken. With its default-deny code, the data paths answer `404` to every visitor, members included, so both detached states leave the family data unreachable, apart from any path that an older, broader behavior catches first ([below](#why-removing-the-gate-can-leave-the-data-unreachable)).

Ruling HFY-R67 orders every move so that the site never passes through the fourth state:

- **Going on: flip `authV2`, deploy and confirm, then attach the gate.** Flipping `authV2` first is harmless, because without the gate it changes only which credential the client sends. The deploy must finish, and the new `flags.json` must be confirmed live, before the gate goes on. Until then visitors still run the old client, and a gate attached first would refuse their data for as long as the deploy took, and for longer if the deploy were rolled back.
- **Going off: the same steps in reverse.** Remove the gate first and wait for the distribution to deploy. Only then, and only if the `authV2` client itself is at fault, turn `authV2` off. Never turn `authV2` off while the gate is attached. While `HFYAppendIndex` runs its default-deny code, this path has a third step, rolling the function back, because removing the gate alone leaves the data unreachable. Fixing forward with `authV2` on is then the better way out ([below](#why-removing-the-gate-can-leave-the-data-unreachable)).

The production cutover took the first path on 2026-10-12 (HFY-TSK-069, HFY-R67). Per the HFY records, the flipped site was live for everyone at 12:36Z and the gate was attached at 12:40Z, deploy first and gate second. Since then the second path is the one that applies to any rollback. A signed-out request for `/person/index.json` shows where the gate stands. It answers `401` while the data is gated. Without the gate, it answers `200` when the request reaches the site bucket, and `404` when the default-deny code of `HFYAppendIndex` answers it ([cut over to the private data gate](../how-to/cut-over-to-the-private-data-gate.md#find-your-starting-point)).

The 12:40Z attachment predates the script's support for `/uploads/*`, which merged later the same day. Gating `/uploads/*` is a rerun of the same script, and the repository does not record whether that rerun has happened. A signed-out request for a photo URL, `https://<site>/uploads/posts/<ulid>/<name>`, answers `401` once it has.

Removing the gate is more than a deletion. `add-data-gate-behaviors.sh --remove` deletes the six data behaviors, but it does not delete `/uploads/*`. It puts that behavior back, in place, to its public state, which includes the response headers policy for uploads that the app stack defines. The script reads that policy from the app stack's outputs, and the stack name it falls back on is not the live one, so a production removal has to name the live stack, `<app-stack>` ([placeholders](../reference/private-data-and-secrets.md#placeholders)). Without it, while `/uploads/*` is gated, the script refuses and changes nothing, and the rollback stalls at its first step. [Roll back](../how-to/cut-over-to-the-private-data-gate.md#roll-back) in the cut-over page has the options. After a removal member photos are public to anyone holding a URL, and the family data is public or unreachable, depending on the CloudFront Function ([below](#why-removing-the-gate-can-leave-the-data-unreachable)).

That is why `authV2` lost its one-line rollback. Turning it off is at least two steps, and the first is a change to the distribution, not an edit to a data file. While the CloudFront Function runs its default-deny code, it is three. Anything else that sets `authV2` back to `false` carries the same hazard: a revert of the flip commit, a hand edit of `flags.json`, and the pipeline's own automatic rollback ([below](#why-a-kit-pipeline)).

No move happens without io. The global `authV2` flip and the gate attachment each needed io's G-prod approval, one of the HFY-PLN-001 gates, not only a go-ahead in the session; the flip commit records that approval, given on 2026-10-12. Going back needs the same care: setting `authV2` to `false` is a global flag flip, a real `--remove` run needs io's go-ahead like any real run of a behavior script, and so does a rollback of the CloudFront Function. The pipeline can neither attach nor remove the gate, nor roll the function back: its role can invalidate the distribution's cache, but it cannot change the distribution's configuration or publish its CloudFront Function. [Cut over to authV2 and the private data gate](../how-to/cut-over-to-the-private-data-gate.md) has the sequence, the checks and the rollback.

### Why removing the gate can leave the data unreachable

The gate is not the only thing in front of the data paths. `HFYAppendIndex`, the CloudFront Function on the distribution's default behavior, has rewritten the site's clean URLs since before release 2. Since the gate hardening (HFY-TSK-082), its code in [`append-index.js`](../../scripts/cloudfront/append-index.js) also denies private paths. Any request that reaches the default behavior with a first path segment of `family`, `event`, `note`, `place`, `media` or `uploads`, or with `.json` anywhere under `person/`, gets `404` with `cache-control: private, no-store` and never reaches the site bucket. The deny is there to catch spellings that miss the gate's case-sensitive patterns, such as `/Person/index.json`. While the gate is attached, a real data request matches its gated pattern first and never meets the deny. [Edge and origin design](edge-and-origin-design.md#why-the-cloudfront-function-also-denies) explains the mechanism.

The function cannot tell whether the gate is attached, so its rules cover the exact data paths as well. Once the gate is removed, those paths fall through to the default behavior and get the same `404`, from every client, members included. The exception is a path that an older, broader behavior, such as a legacy `/person/*`, matches before the default behavior: that behavior serves it to anyone. Member photos keep their own `/uploads/*` behavior, which a removal ungates rather than deletes, so they become public instead. A removal therefore fails closed for the data, but it no longer gives that client its data back.

The function is a separate switch, published by hand apart from the gate and the site, and the repository does not record whether its `LIVE` stage runs the default-deny code. A request that misses the gate shows it even while the gate is attached: a signed-out `/Person/index.json` answers `404` with `cache-control: private, no-store` only under the default-deny code. While it runs that code, a return to a client with `authV2` off needs the gate removed and the function rolled back to its earlier code, and the function rollback needs io's go-ahead as well. The preferred way out of a live `authV2: false` under the gate is therefore to fix forward: leave the gate attached, and get a release with `authV2: true` live again. [Roll back a site deploy](../how-to/roll-back-a-site-deploy.md#check-authv2-after-a-failed-deploy) has both ways out, and [Publish a change to the HFYAppendIndex CloudFront Function](../how-to/publish-the-cloudfront-function.md) has the function rollback.

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

One override is limited by the gate. Forcing `authV2` off in a tab while the gate is attached puts that tab in the fourth state: its pages get `401` for the family data once `io_id` lapses. Only that tab is affected, so the override stays safe for everyone else.

## What a flag does not protect

A flag hides UI. It does not hide endpoints. The API under `/api/*` (Lambda `hfy-api`), the MCP server under `/mcp` (mounted in the same Lambda) and the auth edge under `/auth/*` (Lambda `hfy-auth-edge`) answer as soon as their CloudFront behaviors exist, whatever `flags.json` says. The flag is evaluated in the visitor's browser, which the visitor controls, so a direct request to an endpoint never passes through it.

Security therefore never rests on a flag. For the endpoints, it rests on authentication at the auth edge, on the allowlist that maps a verified identity to a family record, and on the API verifying each session cookie or MCP access token against the keys the edge publishes. For the family data and member photos, it also rests on the Lambda@Edge gate, and only on the paths the gate is attached to. A path without the gate checks no session, whatever any flag says. It is public wherever the request reaches the site bucket, and closed to everyone, members included, only where the default-deny code of `HFYAppendIndex` answers it ([above](#why-removing-the-gate-can-leave-the-data-unreachable)). The signed-out requests [above](#the-gate-is-a-third-switch-and-the-order-matters) show which paths are gated.

`authV2` is the one flag that does more than choose what a page shows. It decides which credential the page's data requests carry, and so whether they can pass the gate. It still grants nothing: it cannot open data the gate refuses, and without the gate it closes nothing. Every other flag remains a statement about presentation, not about access. The same reasoning covers the override: anyone can add it to a URL, so a flagged surface must enforce authentication on every data call it makes. See [The identity model](identity-model.md), [Edge and origin design](edge-and-origin-design.md) and the [MCP server reference](../reference/mcp-server.md).

## Why searchV2 implies shellV2

`searchV2` is meant to replace both ways into search: the navbar autocomplete and the search page. The page is replaced by the search island. The navbar autocomplete is replaced by a launcher that lives in the shell island. Without the shell, `searchV2` could deliver only the page, reached from the old navbar.

So the resolver turns `shellV2` on whenever `searchV2` is on (HFY-R48). A build-time `shellV2: false` does not stop this. The only exception is an explicit `-shellV2` in the per-browser override, which lets a tester look at search without the shell on purpose.

The legacy search scripts stood down only after their replacement had mounted (HFY-R58). HFY-TSK-317 deleted them, so there is no fallback: if the search island fails to load, `/search/` stays empty until the bundle is back.

## Why a kit pipeline

Production deploys run through the shared io-kit CI pipeline (`@io-kit/ci`), adopted for this repo in HFY-TSK-060. A push to `main` runs [`io-kit-deploy.yml`](../../.github/workflows/io-kit-deploy.yml). The only other deploy workflow, [`deploy-gcf-legacy.yml`](../../.github/workflows/deploy-gcf-legacy.yml), ships the legacy Google Cloud Function `getAllowlist`. Neither workflow ships a legacy piece on a push any more (HFY-TSK-317): the GCF workflow runs only when started by hand, and the kit manifest dropped its `hfy-check-allowed` Lambda target and made the parity report blocking. The legacy pieces themselves stay in AWS and Google Cloud until io retires them, and that retirement is a change of its own ([The identity model](identity-model.md)). What neither workflow ships goes by hand, for reasons the later sections give. Each part of the kit answers a specific problem:

- **One manifest, rendered workflows.** A repo describes its build and deploy targets in [`ci.manifest.yaml`](../../ci.manifest.yaml), and the kit renders the GitHub workflows and composite actions from it. Every io project uses the same templates, so a fix to deploy logic is made once in the kit and re-rendered everywhere, instead of being patched by hand in each repo. The files are rendered into the repo rather than referenced, because io-kit is private and a workflow cannot reference actions across owners (HFY-R14).
- **A release artifact per commit.** The build output is packaged as `io-kit-release-<sha>` and deployed from that artifact. What went to production is a stored, named object, not whatever a runner happened to produce.
- **Smoke checks with automatic rollback.** After the deploy and the cache invalidation, the pipeline requests the home page and `/family-login/`. If either fails, it redeploys the artifact from the previous successful deploy run. Recovery does not depend on someone noticing, with one exception. The rollback restores the whole site, `flags.json` included, and knows nothing about the gate, which its role could not remove anyway. Under an attached gate, a restored `flags.json` with `authV2: false` turns `authV2` off and locks every visitor out of the family data, and removing the gate may not undo that ([above](#why-removing-the-gate-can-leave-the-data-unreachable)). So, while the gate is attached, every automatic rollback is followed by a look at the live `flags.json`. [Roll back a site deploy](../how-to/roll-back-a-site-deploy.md#check-authv2-after-a-failed-deploy) has the check and the ways out.
- **A parity report.** Pull request CI reports pipeline drift, meaning rendered files that were edited by hand or AWS deploy commands in workflows outside the kit. On this repo it blocks: drift fails the pull request check (HFY-TSK-317).
- **Secret scanning.** Pull request CI runs TruffleHog over the commit range.

### Why the rendered YAML is never hand-edited

Every rendered file starts with a "do not edit" header that carries a sha256 of the rest of the file. The manifest is the source, and the YAML is output. A hand edit would be lost at the next re-render, and it would make this repo diverge from every other consumer of the kit. The drift check exists to catch such edits. To change the pipeline, change the manifest (or the kit) and re-render.

### Why a deploy changes the static URLs

The pipeline's last word on caching is an invalidation of `/*`, which it waits for before the smoke checks run. That invalidation reaches only CloudFront. Cloudflare proxies `<site>` in front of CloudFront, and it keeps static files (scripts, stylesheets, fonts and `sw.js`) for 4 h under the URL it first fetched them by. No CloudFront invalidation purges it. Before the asset URLs were versioned, a green deploy therefore reached visitors piecemeal for up to four hours: a new stylesheet with an old `shell.js`, or a stale service worker.

The HTML is the one thing Cloudflare does not cache (its responses show `cf-cache-status: DYNAMIC`), so the fix starts from the HTML. The islands build names every same-origin script, stylesheet, manifest and preload that a page references by its content, `?v=` followed by the first 8 hex digits of the file's SHA-256. It also stamps the hashes of the files that are loaded at runtime (the island entries, the theme, the manifest and the service worker) into `js/feature-flags.js` and `sw.js`. A deploy that changes a file changes the URL that every page asks for, so Cloudflare holds nothing under the new URL. A deploy that leaves a file alone keeps its URL and every cached copy. Island chunks and fonts need no `?v`, because their file names already carry a content hash.

The pipeline did not have to change for this. The versions are committed output, like the bundles ([below](#why-island-bundles-are-committed-output)), and the kit still runs one `aws s3 sync --delete` followed by the waited invalidation. That also marks what the pipeline cannot promise. A versioned URL helps only if the file it names is live when the HTML that names it goes live. The safe order uploads everything except the HTML first, then the HTML, then invalidates, but the kit's sync is a single step with no such ordering. CloudFront's default cache policy ignores query strings, so until the invalidation reaches an edge, CloudFront can answer a request for a new `?v` with the old object, and Cloudflare then keeps those old bytes under the new URL for up to 4 h. The smoke checks request only HTML pages, so a green run shows that the pages answer, not that every file they name is the new one. [Edge and origin design](edge-and-origin-design.md#static-files-and-versioned-urls-hfy-tsk-086) explains the cache layers, and the [theme and asset build reference](../reference/theme-and-asset-build.md#asset-versions) describes the stamping.

## Why CI never builds from the private registry

The `@io-kit` packages live in a private package registry. CI has no way into it. The build job runs with no AWS credentials, and the deploy role that the later jobs assume has no registry permissions. The kit is built around that limit: its workflows and actions are rendered into the repo instead of referenced, and its drift check is vendored with no dependencies so that CI can run it without registry access.

Anything that does need the registry is built outside CI. Two consequences follow.

### Why island bundles are committed output

The islands are bundled from `@io-kit` packages, so CI cannot build them. The same build, [`islands/build.mjs`](../../islands/build.mjs), writes much more than bundles. It cannot run without its `@io-kit` dependencies, which come from the private registry, so none of what it writes can be produced in CI:

- the island bundles under `11ty/js/islands/`: entries, shared chunks and the notification worker script;
- the design system's theme layer, `css/hfy-theme.css`, built from `@io-kit/tokens`, and the sign-in pages' stylesheet, `css/auth-edge.css`;
- the self-hosted fonts in `fonts/`, copied from pinned `@fontsource` packages;
- the head blocks and the family-voice copy that it writes into the generated pages, and the colours in `manifest.webmanifest`;
- the content hashes: the `?v` on every page's script, stylesheet and manifest references, the stamped version blocks in `sw.js` and `js/feature-flags.js`, and the versioned stylesheet URL in [`auth/edge.manifest.json`](../../auth/edge.manifest.json).

The deploy syncs `11ty/` to the site bucket with `--delete`, which removes every object missing from the output except the excluded data and upload prefixes. An output that is not in the repo would never reach production, and one uploaded by hand would be deleted by the next deploy.

Ruling HFY-R58 therefore makes the build's output committed. Whoever changes an island, the theme or anything else the build reads rebuilds locally, with `cd islands && npm run build` or with [`scripts/ci/build-islands.sh`](../../scripts/ci/build-islands.sh), which installs the dependencies first, and commits every output with the source change. What is reviewed and merged is then exactly what is deployed, and a flag flip never depends on a build step the pipeline lacks.

The price is the usual cost of committed build output. Diffs carry minified code, hashed chunk names and version stamps that change whenever the files they describe do, and a contributor can forget to rebuild. `npm run check:islands` rebuilds in memory and fails when anything committed differs from what the source produces. No workflow runs it, so it catches a stale output only when someone runs it. An Eleventy refresh is the other way to go stale: a regenerated page comes back with stale head-block values and without the family-voice copy and the `?v` versions, and it goes stale at Cloudflare again until the islands build runs over it ([Refresh the Eleventy output](../how-to/refresh-the-eleventy-output.md)). [Build and preview the islands](../how-to/build-and-preview-the-islands.md) covers the build.

### Why the app Lambdas are packaged by hand

The API and the auth edge also depend on `@io-kit` packages, so their zips are built outside CI as well, by [`scripts/ci/package-api.sh`](../../scripts/ci/package-api.sh) and [`scripts/ci/package-auth.sh`](../../scripts/ci/package-auth.sh). Each runs a locked `npm ci` that needs a CodeArtifact token. That is one of two reasons they ship by hand. The other is the deploy role.

The gate's script, [`scripts/ci/package-edge-gate.sh`](../../scripts/ci/package-edge-gate.sh), shows what changes when a function needs nothing from the registry. The gate has no dependencies, so the script needs no token and installs nothing. Its zip is reproducible: fixed file times and no extra attributes give the same bytes from the same sources. Its S3 key is content-addressed, named after the zip's SHA-256, so new code is always a new key. The registry is therefore not what keeps the gate out of CI. The kit and the role are ([why the edge functions ship by hand](#why-the-edge-functions-ship-by-hand)).

Built by hand does not mean shipped unreviewed. The app Lambdas' code goes to `<code-bucket>` under commit-named keys, `lambda/hfy-api-<sha>.zip` and `lambda/hfy-auth-edge-<sha>.zip`, and reaches the live app stack, `<app-stack>`, through a CloudFormation change set. The commit-named key does two jobs. CloudFormation updates a function's code only when its key changes, so a new key is what makes the update happen, and afterwards the stack's parameters name the commit that is running.

The change set is reviewed before it is executed, because the stack holds more than code. The table and the user pool are `Retain`, and the Function URLs are the origins that CloudFront sends `/api/*`, `/auth/*` and `/mcp*` to. The review is where an unintended replacement shows up. One line in it is expected noise: both Function URLs show `Conditional` replacement, because their target is the function's ARN, which CloudFormation treats as dynamic while the function is being updated. A code update keeps the ARN, so the URLs survive. Checking after execution that the `FunctionUrl` and `AuthFunctionUrl` outputs are unchanged confirms it.

Some site changes need this road as well as the pipeline. The auth edge renders the sign-in pages from `auth/edge.manifest.json` and the HFY overrides in [`auth/src/edge.js`](../../auth/src/edge.js), and both are packaged into its zip. A change to the sign-in copy or the overrides, or a new versioned URL for the sign-in stylesheet, therefore reaches visitors only when `hfy-auth-edge` is redeployed. A site deploy on its own ships the new `css/auth-edge.css` while the sign-in pages keep linking the old URL. The redeploy follows the site deploy, for the same reason the HTML goes last: a URL should name a file that is already live. In the same way, a change to the push notification copy in `api/` is live only once `hfy-api` is redeployed.

## Why the deploy role is narrow

The pipeline acts in AWS through one role, defined in [`github-roles.yaml`](../../infrastructure/cloudformation/github-roles.yaml), which GitHub assumes through OIDC. The role trusts only workflow runs on `main`, and it can do little. It can read and write the site bucket, create and read invalidations on the one distribution, and update code, versions and aliases on three named Lambda functions, all in `us-west-2`. It has no CloudFormation, IAM, function-creation, DynamoDB or Cognito permissions, and it cannot change the distribution's configuration or its CloudFront Functions. A compromised or mistaken workflow can replace the site's files and function code, but it cannot change infrastructure or grant itself more access. When the kit arrived, the role gained what the kit's own steps call: the reads that let it wait for a function update or an invalidation to finish, and the version and alias actions that its Lambda deploy and rollback use (HFY-R60). The same change added `s3:GetObject` on the site bucket and named `hfy-api` and `hfy-auth-edge` in the Lambda grants ahead of HFY-R32, described below, although the kit manifest does not deploy either function today. Every grant still names its function, bucket or distribution.

The role also denies writes and deletes under `uploads/`, where member post photos live (HFY-R58). The sync already excludes that prefix, but an exclude is one line in a manifest. The deny holds even if that line is changed or lost, so the site deploy can never delete what members have uploaded.

The price of a narrow role is that the app stack ships by hand. [`app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml) holds the DynamoDB table, the Cognito user pool, the two app Lambdas with their IAM roles and Function URLs, and the response headers policy for uploads, which describes the public, ungated state of `/uploads/*`. Scripts in [`scripts/infra/`](../../scripts/infra/) change the distribution:

- **The behaviors.** They add `/api/*`, `/auth/*` and `/uploads/*`; `/mcp*` and the MCP server's protected-resource metadata path ([`add-mcp-behavior.sh`](../../scripts/infra/add-mcp-behavior.sh)); and the gate's seven patterns, six of them created and `/uploads/*` updated in place.
- **The gate's response headers policies.** The gate script also creates two policies, `hfy-private-no-store` for the six data behaviors and `hfy-uploads-private` for `/uploads/*`, which also keeps the uploads' `nosniff` header and sandbox Content-Security-Policy. Both set `Cache-Control: private, no-store` on every gated response, so that Cloudflare, which proxies the site, never stores one.
- **The CloudFront Function.** [`publish-append-index.sh`](../../scripts/infra/publish-append-index.sh) publishes `HFYAppendIndex`, the default behavior's viewer-request function, which also refuses case and suffix variants of the private prefixes that the gated patterns would otherwise miss, and the exact data paths too whenever the gate is detached ([above](#why-removing-the-gate-can-leave-the-data-unreachable)). The kit has a `cloudfront_function` target kind, but the manifest declares no such target and the role has no permission to update or publish a CloudFront Function.

Two `us-east-1` stacks ship by hand as well ([below](#why-the-edge-functions-ship-by-hand)). None of that can go through a role without CloudFormation, IAM or CloudFront configuration permissions, and widening the role would give every workflow run that power.

The plan intends the app Lambdas' code to ship through kit Lambda targets eventually (HFY-R32). The role already names both functions, so that move needs no wider role. It does need a way to build their zips, which runs into the registry limit above.

### Why the edge functions ship by hand

The site's two Lambda@Edge functions live in their own stacks in `us-east-1`, the only Region where Lambda@Edge functions can be created. `hfy-mcp-edge401` ([`mcp-edge401.us-east-1.yaml`](../../infrastructure/mcp-edge401.us-east-1.yaml)) carries its code inline in the template. `hfy-edge-gate` ([`edge-gate-stack.yaml`](../../infrastructure/cloudformation/edge-gate-stack.yaml)) loads its code from a private bucket in that Region, `<edge-code-bucket>`. The gate needs nothing from the registry, so a runner could build it. It still ships by hand, because neither the kit nor the role can deploy it:

- **The kit has no way to.** The rendered actions under [`.github/actions/io-kit-ci/`](../../.github/actions/io-kit-ci/) build, package, sync static files, update Lambda code, invalidate, smoke-test, roll back, scan for secrets and report drift. None deploys a CloudFormation stack or a Lambda@Edge function, and `@io-kit/ci` 0.1.3 has no such target kind: its kinds are `s3_static`, `lambda`, `cloudfront_function` and `codeartifact`. The `lambda` kind updates a function in the manifest's single deploy Region, `us-west-2` here, and can publish a version behind an alias. CloudFront, however, runs only the numbered version that a behavior names, and no kit step edits the distribution's behaviors. The `cloudfront_function` kind publishes CloudFront Functions, which can do neither job ([Edge and origin design](edge-and-origin-design.md#two-deliberate-lambdaedge-exceptions)).
- **The role has no permission to.** The deploy role has no CloudFormation permission, and its Lambda grants name only `hfy-check-allowed` (no manifest target uses it any more), `hfy-api` and `hfy-auth-edge`, all in `us-west-2`. It cannot change the distribution's configuration either.

Widening either would be the wrong fix. Pointing the gated behaviors at a new gate version is the gate switch itself, and that belongs with io's approval, not with a merge to `main`.

Shipping by hand follows two rules that come from how Lambda@Edge runs:

- **Versions are retained.** CloudFront replicates the version it is given to its edge locations, and a version cannot be deleted while those replicas exist. Both stacks keep the old version when they publish a new one (`DeletionPolicy` and `UpdateReplacePolicy` are `Retain`), so a stack update never tries to delete a version the distribution may still be running. CloudFront removes the replicas some hours after the last association is gone.
- **Code is content-addressed.** CloudFormation publishes a new version only when the version resource changes, so code that changes without a new version is a silent no-op. `package-edge-gate.sh` therefore names the gate's S3 key after the zip's hash and hands the hash to the stack. New gate code is always a new key and a new version, and a zip that does not match its hash fails the stack update before anything reaches CloudFront. The 401-restore function's version carries a hash of its inline code in its description, and a test fails whenever the code and that hash disagree.

A stack update alone changes nothing that a visitor sees. A new gate version takes traffic only when `add-data-gate-behaviors.sh` runs again and repoints every gated behavior to it, `/uploads/*` included once it is gated. A new 401-restore version takes traffic only when `add-mcp-behavior.sh` names it. The deploy procedure invokes a new gate version directly with synthetic viewer requests, and checks that it refuses or redirects each one as it should, before any behavior is repointed to it ([Deploy the edge functions](../how-to/deploy-the-edge-functions.md#5-validate-the-published-version-before-anything-attaches-it)). That check is a step of the procedure: neither the script nor the stack enforces it. Deploying and attaching stay separate switches here too.

## Further reading

- [Front-end reference](../reference/front-end.md): the flags, the resolver and the island loader.
- [Theme and asset build](../reference/theme-and-asset-build.md): what the islands build writes, and how the asset versions are stamped.
- [Repository operations](../reference/repository-operations.md): the workflows, the kit manifest, the scripts, and which pieces ship by pipeline or by hand.
- [Toggle a feature flag](../how-to/toggle-a-feature-flag.md): preview a surface in one browser, or flip it for everyone.
- [Cut over to authV2 and the private data gate](../how-to/cut-over-to-the-private-data-gate.md): flip `authV2`, attach the gate in that order, and roll back in reverse.
- [Deploy a site change](../how-to/deploy-a-site-change.md): ship a static change through the kit pipeline.
- [Roll back a site deploy](../how-to/roll-back-a-site-deploy.md): what the automatic rollback covers, and how to drill it.
- [Change the CI pipeline](../how-to/change-the-ci-pipeline.md): edit the manifest and re-render.
- [Deploy the app stack](../how-to/deploy-the-app-stack.md): the manual path for the API, the MCP server and the auth edge.
- [Deploy the edge functions](../how-to/deploy-the-edge-functions.md): build, deploy and validate the two `us-east-1` Lambda@Edge stacks.
- [Publish a change to the HFYAppendIndex CloudFront Function](../how-to/publish-the-cloudfront-function.md): ship `HFYAppendIndex` by hand, and roll it back.
- [Build and preview the islands](../how-to/build-and-preview-the-islands.md): rebuild and commit the islands build output.
- [The privacy model for family data](family-data-privacy.md): what the gate protects, and why gated responses are never stored.
- [Edge and origin design](edge-and-origin-design.md): the cache layers, why the gate and the MCP 401 restore run at the edge, and why the CloudFront Function also denies.
- [Why the site's look is one built theme layer](design-system-theme-layer.md): why the theme, the sign-in stylesheet and the fonts are built and committed by the islands build.
- [Islands on Eleventy](islands-on-eleventy.md): why the new surfaces are islands on a static site.
