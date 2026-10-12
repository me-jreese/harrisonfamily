# Harrison Family Website documentation

This documentation is organized with the [Diátaxis](https://diataxis.fr) framework. Every page is exactly one of four kinds, because each serves a different need:

- **Explanation** answers *why*: the ideas and the design reasoning, best read away from the keyboard.
- **Reference** answers *what*: neutral, complete descriptions of the machinery, and a map from each capability to the code.
- **How-to** answers *how do I…*: directions for a competent reader with a specific goal.
- **Tutorial** answers *teach me*: a guided first lesson. This project applies Diátaxis pragmatically. There is no tutorial track, so that kind is deliberately absent rather than stubbed out.

If you are an automated agent, your entry point is not here. It is [`AGENTS.md`](../AGENTS.md), the agent operating contract.

## Explanation — understand the thinking

The reasoning behind the system. Start here if you want to know *what was built and why*.

- [Why React islands on a generated Eleventy site](explanation/islands-on-eleventy.md) — why the front end is a static Eleventy site with flag-gated React islands on top, and why `11ty/` has two sources of truth.
- [The identity model: one edge, one allowlist](explanation/identity-model.md) — why one allowlist decides membership, why Google, password and passkey sign-in all end at the same auth edge, and why an MCP delete needs a recent step-up.
- [Why releases ship through a pipeline and feature flags](explanation/release-model.md) — why a deploy, a flag flip and attaching the private data gate are three separate switches, and why the gate goes on only after `authV2`.
- [The privacy model for family data](explanation/family-data-privacy.md) — what counts as private, how it stays out of git, how the data gate enforces sign-in at the edge, and where the design is fragile.
- [Why one CloudFront distribution fronts everything](explanation/edge-and-origin-design.md) — one origin for the browser, the origin-verify header, the two Lambda@Edge exceptions, Cloudflare in front, and what drives the bill.
- [How member content stays accountable](explanation/member-content-design.md) — the rules behind posts, comments, reactions and photos: members only, who may change what, and an audit record for every change.

## Reference — find the facts (and the code)

Neutral descriptions of the machinery. Consult these; you don't read them front to back. Deployment-specific values appear as placeholders such as `<site-bucket>`; the forms are listed in [Private data and secrets](reference/private-data-and-secrets.md#placeholders).

- [Codebase map](reference/codebase-map.md) — each capability routed to the directories and files that implement it, including the pieces outside the repository (the fastest way to find the engineering).
- [System architecture](reference/architecture.md) — the deployed system: request routing, origins, buckets, compute, identity store, the `hfy-app` table and the CloudFormation stacks.
- [Family API (hfy-api)](reference/api.md) — the members-only API at `/api/*`: routes, permissions, audit records, notifications, uploads and configuration.
- [MCP server](reference/mcp-server.md) — the MCP endpoint that `hfy-api` serves at `/mcp`: tools, policy, groups, step-up, audit and the conformance gate.
- [Identity services](reference/identity-services.md) — the auth edge (passkeys and the MCP authorization server included), the private data gate and the legacy sign-in path: routes, tokens, cookies and configuration.
- [Front end](reference/front-end.md) — what `11ty/` contains, the feature flags and preview override, the `authV2` data path, the island loader and islands, and the PWA shell.
- [Repository operations](reference/repository-operations.md) — the CI workflows, deploy role, scripts, hooks and test suites that build, check and ship the repo.
- [Private data and secrets](reference/private-data-and-secrets.md) — every private asset and secret by name and location, the family-data contract, and the placeholder vocabulary.
- [App backend cost estimate](reference/cost-estimate.md) — the estimated monthly AWS cost of the app backend line by line, and the static-site baseline.

## How-to — get something done

Goal-oriented directions for a reader who already has the basics.

### Set up an environment

For this family or another, in this order. The first page also lists what to change when you adapt the repo for another family.

1. [Stand up the static site and its deploy access](how-to/stand-up-the-static-site.md) — one-time setup of the bucket, certificate, distribution, DNS, deploy role and Google sign-in client, ending with the first site deploy.
2. [Deploy and update the Lambda@Edge functions in us-east-1](how-to/deploy-the-edge-functions.md) — deploy or update `hfy-mcp-edge401` and `hfy-edge-gate`, and test the gate's published version before anything attaches it.
3. [Add or remove a family member's access](how-to/manage-family-access.md) — publish the allowlist, the admin list and the MCP groups, and later add or remove a member, an admin or an MCP author, remove a lost passkey, or sign a member out on every device.
4. [Deploy the app stack and its CloudFront behaviors](how-to/deploy-the-app-stack.md) — create or update `<app-stack>` (`hfy-api` and `hfy-auth-edge`) from commit-named code zips through a reviewed change set, and add its CloudFront behaviors.
5. [Refresh the family data from Gramps](how-to/refresh-the-family-data.md) — re-export, rebuild the trees and search files, and sync the data prefixes without touching member uploads, now and whenever the tree changes.
6. [Cut over to authV2 and the private data gate, and roll back](how-to/cut-over-to-the-private-data-gate.md) — flip `authV2` and ship the site, then attach the gate, and undo it in the reverse order. Needs io's G-prod approval.
7. [Turn on push notifications](how-to/turn-on-push-notifications.md) — optional: store a VAPID key pair with an `https://` subject in a secret (`harrisonfamily/api/vapid` in production) and give it to the API; later turn push off, replace the key pair or correct its subject.

### Ship a change

- [Deploy a change to the static site](how-to/deploy-a-site-change.md) — ship `11ty/` or the legacy sign-in functions through the pipeline and confirm the change is live.
- [Roll back, or drill a rollback of, a site deploy](how-to/roll-back-a-site-deploy.md) — after an automatic rollback, when nothing rolled back, by revert, and as a rehearsal.
- [Turn a feature flag on for one tab or for everyone](how-to/toggle-a-feature-flag.md) — preview a flag with the per-tab override, publish it in `flags.json`, and roll back.
- [Build and preview the React islands](how-to/build-and-preview-the-islands.md) — rebuild the committed bundles, check them against the source, and view them locally with a flag on.
- [Refresh `11ty/` from the Eleventy source without losing E5 files](how-to/refresh-the-eleventy-output.md) — rebuild and promote the Eleventy output while keeping the repo-owned files.
- [Run the test suites](how-to/run-the-tests.md) — run each suite with its prerequisites, and know which ones reach production.
- [Change the CI pipeline](how-to/change-the-ci-pipeline.md) — edit `ci.manifest.yaml`, re-render the workflows and check for drift.

### Operate and maintain

- [Connect an MCP client and run an admin delete](how-to/connect-an-mcp-client.md) — add the site's MCP server at `/mcp` to a client, check your tools, and step up with a passkey before a delete.
- [Refresh the sanitized samples](how-to/refresh-the-sanitized-samples.md) — update the synthetic samples the repo carries in place of private files.
- [Rotate the session signing key](how-to/rotate-the-session-signing-key.md) — replace the auth edge's signing key, which invalidates every outstanding `io_id` and MCP access token.
- [Rotate the origin-verify secret](how-to/rotate-the-origin-verify-secret.md) — replace the CloudFront-to-Lambda shared secret with the shortest possible `403` window.
- [Rotate the Google sign-in client](how-to/rotate-the-google-client.md) — move both sign-in paths to a new Google OAuth web client.
- [Diagnose sign-in and API failures](how-to/diagnose-sign-in-and-api-failures.md) — symptom-first checks and fixes for sign-in (passkeys included), `/api/*`, `/auth/*`, the private data gate, and the MCP server and its clients.

### Not covered yet

- **Restoring member content.** The app table (`hfy-app`) has point-in-time recovery on, and every post and comment change leaves an `AUDIT#` item with the record's `before` state ([System architecture: Definition](reference/architecture.md#definition), [Family API: Audit records](reference/api.md#audit-records)), but there is no procedure for restoring from either. A point-in-time restore creates a new table, which the stack does not manage. Plan one with io before you need it.
