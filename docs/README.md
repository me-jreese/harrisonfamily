# Harrison Family Website documentation

This documentation is organized with the [Diátaxis](https://diataxis.fr) framework. Every page is exactly one of four kinds, because each serves a different need:

- **Explanation** answers *why*: the ideas and the design reasoning, best read away from the keyboard.
- **Reference** answers *what*: neutral, complete descriptions of the machinery, and a map from each capability to the code.
- **How-to** answers *how do I…*: directions for a competent reader with a specific goal.
- **Tutorial** answers *teach me*: a guided first lesson. This project applies Diátaxis pragmatically. There is no tutorial track, so that kind is deliberately absent rather than stubbed out.

If you are an automated agent, your entry point is not here. It is [`AGENTS.md`](../AGENTS.md), the agent operating contract.

## Explanation — understand the thinking

The reasoning behind the system. Start here if you want to know *what was built and why*.

- [Why React islands on a generated Eleventy site](explanation/islands-on-eleventy.md) — why the front end is a static Eleventy site with flag-gated React islands, and why `11ty/` has two sources of truth.
- [Why the site's look is one built theme layer](explanation/design-system-theme-layer.md) — why the design system ships as a static stylesheet built from tokens, with render-blocking head blocks and self-hosted fonts.
- [The identity model: one edge, one allowlist](explanation/identity-model.md) — why one allowlist decides membership, why Google, password and passkey sign-in all end at the same auth edge, and why the legacy path stays deployed for a release.
- [Why releases ship through a pipeline and feature flags](explanation/release-model.md) — why a deploy, a flag flip and attaching the private data gate are separate switches, and why their order matters.
- [The privacy model for family data](explanation/family-data-privacy.md) — what counts as private, how it stays out of git, and how the edge keeps the data and member photos members-only.
- [Why one CloudFront distribution fronts everything](explanation/edge-and-origin-design.md) — one origin for the browser, the two Lambda@Edge exceptions, and the Cloudflare cache in front that the versioned URLs get past.
- [How editing and suggested changes work](explanation/editing-and-proposals.md) — why a change saves now, goes to review or is refused, what a suggestion is, and why editing ships behind a server switch and its site flags.
- [How member content stays accountable](explanation/member-content-design.md) — the rules behind posts, comments, reactions and photos, and the audit record every post and comment change leaves.

## Reference — find the facts (and the code)

Neutral descriptions of the machinery. Consult these; you don't read them front to back. Deployment-specific values appear as placeholders such as `<site-bucket>`, defined in the private data and secrets inventory below.

- [Codebase map](reference/codebase-map.md) — each capability routed to the files that implement it, including the pieces outside the repository.
- [System architecture](reference/architecture.md) — the deployed system: request routing, origins, buckets, compute, the identity store, the `hfy-app` table and the CloudFormation stacks.
- [Family API (hfy-api)](reference/api.md) — the members-only API at `/api/*`: routes, permissions, audit records, notifications, uploads and configuration.
- [Field policy](reference/field-policy.md) — who may change which field, on which record and how: the generated table, the Q2-15 switches and the withheld types. Checked against `field-policy.js` by a test.
- [MCP server (/mcp)](reference/mcp-server.md) — the MCP endpoint that `hfy-api` serves: tools, policy, groups, step-up, audit and the conformance gate.
- [Identity services](reference/identity-services.md) — the auth edge, the private data gate and the legacy sign-in path: routes, tokens, cookies, session refresh and configuration.
- [Front end](reference/front-end.md) — what `11ty/` contains: the feature flags and preview override, the `authV2` data path, the island loader and islands, and the PWA shell.
- [Theme and asset build](reference/theme-and-asset-build.md) — everything the islands build writes besides the bundles, from the theme layer and fonts to the `?v=<sha8>` asset versions, and the checks that hold them.
- [Repository operations](reference/repository-operations.md) — the CI workflows, deploy role, scripts, hooks and test suites that build, check and ship the repo.
- [Orchestration tooling for HFY-PLN-002](../scripts/orchestration/README.md) — the orchestrator's workflow scripts and its batch, catalog, GitHub and mirror tools: each one's inputs, outputs and how to run it.
- [The render Lambda (hfy-sync-render)](reference/sync-render.md) — how the data site is rendered from the cloud store: modes, the diff write, the guards, the privacy re-check, the cursor and outbox, and the operator payloads.
- [Redaction policy v1](reference/redaction-policy.md) — what never goes to the cloud as a declarative rule file: the one birth-like list, the rules by class, the tables they read and the golden vectors. Generated from `gramps/redaction/redaction-v1.json`.
- [Private data and secrets inventory](reference/private-data-and-secrets.md) — every private asset and secret by name and location, the family-data contract and the placeholder vocabulary.
- [App backend cost estimate](reference/cost-estimate.md) — the estimated monthly AWS cost of the app backend line by line, and the static-site baseline.

## How-to — get something done

Goal-oriented directions for a reader who already has the basics.

### Set up an environment

For a new environment, for this family or another, in this order. The first page also lists what to change when you adapt the repo for another family. Steps 2 and 4 are also where later code changes to the edge functions, `hfy-api` and `hfy-auth-edge` ship.

1. [Stand up the static site and its deploy access](how-to/stand-up-the-static-site.md) — one-time setup of the bucket, certificate, distribution, `HFYAppendIndex`, DNS, deploy role and Google client, ending with the first site deploy.
2. [Deploy and update the Lambda@Edge functions in us-east-1](how-to/deploy-the-edge-functions.md) — deploy `hfy-mcp-edge401` and `hfy-edge-gate`, validate the gate before anything attaches it, and later ship a change to either.
3. [Add or remove a family member's access](how-to/manage-family-access.md) — publish the allowlist, the admin list and the MCP groups, and later change who has access or sign a member out on every device.
4. [Deploy the app stack and its CloudFront behaviors](how-to/deploy-the-app-stack.md) — create or update `<app-stack>` from commit-named code zips through a reviewed change set, and add its behaviors.
5. [Sync Gramps with the website](how-to/sync-gramps-with-the-website.md) — sync the Gramps tree through the cloud store, cut the site over (deny first, then live, then verify) and roll it back.
6. [Cut over to authV2 and the private data gate, and roll back](how-to/cut-over-to-the-private-data-gate.md) — find which state a site is in, flip `authV2` before attaching the gate, and roll back in the reverse order; production cut over on 2026-10-12.
7. [Turn on push notifications](how-to/turn-on-push-notifications.md) — optional: give the API a VAPID key pair, and later turn push off, replace the keys or correct their subject.

### Ship a change

- [Deploy a change to the static site](how-to/deploy-a-site-change.md) — ship `11ty/` or the legacy sign-in functions through the pipeline and confirm the change is live past Cloudflare's cache.
- [Roll back, or drill a rollback of, a site deploy](how-to/roll-back-a-site-deploy.md) — undo a release or rehearse it, checking `authV2` first while the gate is attached.
- [Turn on editing](how-to/turn-on-editing.md) — name the approvers, set `HfyEditing`, try the editor and the relationship wizard in one tab, flip `proposalReview`, `recordEdit` and `relationshipWizard` in that order, and turn it off again.
- [Review suggested changes](how-to/review-suggested-changes.md) — as an admin, open the queue and approve, ask for changes, decline or edit then approve.
- [Delete a page and review possible duplicates](how-to/delete-a-page-and-review-duplicates.md) — as an admin, delete a person, family, event, place, source, citation or photo on the website, and read the list of people who may be in the tree twice.
- [Turn a feature flag on or off, for one tab or for everyone](how-to/toggle-a-feature-flag.md) — preview a flag with the per-tab override, publish it in `flags.json`, and roll it back.
- [Build and preview the React islands](how-to/build-and-preview-the-islands.md) — rebuild everything the islands build writes, check it against the source, and view it locally with a flag on.
- [Change the theme or brand fonts](how-to/change-the-theme-or-brand-fonts.md) — change the colours, a theme partial or a font with the theme lint passing, and ship it.
- [Refresh `11ty/` from the Eleventy source without losing E5 files](how-to/refresh-the-eleventy-output.md) — promote new Eleventy output while keeping the repo-owned files, then rebuild the islands over it.
- [Publish a change to the HFYAppendIndex CloudFront Function](how-to/publish-the-cloudfront-function.md) — test, dry-run, publish and roll back `scripts/cloudfront/append-index.js`.
- [Run the test suites](how-to/run-the-tests.md) — run each suite with its prerequisites, and know which ones reach production.
- [Regenerate the Gramps goldens](how-to/regenerate-the-gramps-goldens.md) — rebuild the values Gramps 6.0.6 computes for dates, birth and death indexes, and the relationship scenarios, compare them byte for byte, and check them without Gramps.
- [Install and run the Gramps sync addon](how-to/install-the-gramps-sync-addon.md) — put the `hfy_sync` addon into Gramps, check it from the command line, bind the tree, and read its exit codes.
- [Change the CI pipeline](how-to/change-the-ci-pipeline.md) — edit `ci.manifest.yaml`, re-render the workflows and check for drift.

### Operate and maintain

- [Connect an MCP client and run an admin delete](how-to/connect-an-mcp-client.md) — add the site's MCP server to a client, check your tools, and step up with a passkey before a delete.
- [Refresh the sanitized samples](how-to/refresh-the-sanitized-samples.md) — update the synthetic samples the repo carries in place of private files.
- [Backfill the contributions ledger](how-to/backfill-the-contributions-ledger.md) — credit the posts and comments written before the ledger, rebuild the counters, and check a second run changes nothing.
- [Operate the sync store](how-to/operate-the-sync-store.md) — pause and resume store writes, force a render (`--full`, `--allow-mass-delete`, `--prune-foreign`) and resurrect a mistaken delete or withdraw, each with a dry run and only with io's go-ahead.
- [Rotate the session signing key](how-to/rotate-the-session-signing-key.md) — replace the auth edge's signing key, which invalidates every outstanding `io_id` and MCP access token.
- [Rotate the origin-verify secret](how-to/rotate-the-origin-verify-secret.md) — replace the CloudFront-to-Lambda shared secret with the shortest possible `403` window.
- [Rotate the Google sign-in client](how-to/rotate-the-google-client.md) — move both sign-in paths to a new Google OAuth web client.
- [Diagnose sign-in and API failures](how-to/diagnose-sign-in-and-api-failures.md) — symptom-first checks and fixes for sign-in, `/api/*`, `/auth/*`, the private data gate and the MCP server.

### Not covered yet

- **Restoring member content.** The app table (`hfy-app`) has point-in-time recovery on, and every post and comment change leaves an `AUDIT#` item with the record's `before` state (System architecture, "Definition"; Family API, "Audit records"), but there is no procedure for restoring from either. A point-in-time restore creates a new table, which the stack does not manage. Plan one with io before you need it.
