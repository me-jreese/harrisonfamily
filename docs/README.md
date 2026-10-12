# Harrison Family Website documentation

This documentation is organized with the [Diátaxis](https://diataxis.fr) framework. Every page is exactly one of four kinds, because each serves a different need:

- **Explanation** answers *why*: the design reasoning behind the site, best read away from the keyboard.
- **Reference** answers *what*: neutral, complete descriptions of the machinery, and a map from each capability to the code.
- **How-to** answers *how do I…*: directions for a competent reader with a specific goal.
- **Tutorial** answers *teach me*: a guided first lesson. This project applies Diátaxis pragmatically. There is no tutorial track, so that kind is deliberately absent rather than stubbed out.

If you are an automated agent, your entry point is not here. It is [`AGENTS.md`](../AGENTS.md), the agent operating contract.

## Explanation — understand the thinking

The reasoning behind the system. Start here if you want to know *what was built and why*.

- [Why React islands on a generated Eleventy site](explanation/islands-on-eleventy.md) — why the front end is a static Eleventy site with flag-gated React islands on top, and why `11ty/` now has two sources of truth.
- [The identity model: one edge, one allowlist](explanation/identity-model.md) — why sign-in methods only prove an email address, why one allowlist decides membership, and why every method ends at the same auth edge.
- [Why releases ship through a pipeline and feature flags](explanation/release-model.md) — why a deploy and a flag flip are separate switches, and what shapes the pipeline.
- [The privacy model for family data](explanation/family-data-privacy.md) — what counts as private, how it stays out of git and away from the public, and where the design is fragile.
- [Why one CloudFront distribution fronts everything](explanation/edge-and-origin-design.md) — one origin for the browser, the origin-verify header on the Lambda origins, the presigned-upload exception, and what drives the bill.
- [How member content stays accountable](explanation/member-content-design.md) — the rules behind posts, comments, reactions and photos: members only, who may change what, and an audit record for every change.

## Reference — find the facts (and the code)

Neutral descriptions of the machinery. Consult these; you don't read them front to back. Deployment-specific values appear as placeholders such as `<site-bucket>`; the forms are listed in [Private data and secrets](reference/private-data-and-secrets.md#placeholders).

- [Codebase map](reference/codebase-map.md) — each capability routed to the directories and files that implement it, including the pieces that live outside the repository (the fastest way to find the engineering).
- [System architecture](reference/architecture.md) — the deployed system: request routing, origins, buckets, compute, identity store, data and stacks.
- [Family API (hfy-api)](reference/api.md) — the members-only API at `/api/*`: routes, permissions, audit records, notifications, uploads and configuration.
- [Identity services](reference/identity-services.md) — the auth edge, its MCP authorization server and the legacy sign-in path: routes, tokens, cookies and configuration.
- [Front end](reference/front-end.md) — what `11ty/` contains, the feature flags and preview override, the island loader and islands, and the PWA shell.
- [Repository operations](reference/repository-operations.md) — the CI workflows, deploy role, scripts, hooks and test suites that build, check and ship the repo.
- [Private data and secrets](reference/private-data-and-secrets.md) — every private asset and secret by name and location, the family-data contract, and the placeholder vocabulary.
- [App backend cost estimate](reference/cost-estimate.md) — the estimated monthly AWS cost of the app backend, line by line.

## How-to — get something done

Goal-oriented directions for a reader who already has the basics.

### Set up an environment

For this family or another, in this order. [Stand up the static site](how-to/stand-up-the-static-site.md) also lists what to change when you adapt the repo for another family.

1. [Stand up the static site and its deploy access](how-to/stand-up-the-static-site.md) — one-time setup of the bucket, certificate, distribution, DNS, deploy role and Google sign-in client.
2. [Deploy the app stack and its CloudFront behaviors](how-to/deploy-the-app-stack.md) — deploy `hfy-api`, `hfy-auth-edge` and their data, route `/api/*`, `/auth/*` and `/uploads/*` to them, and apply the upload CORS rule.
3. [Add or remove a family member's access](how-to/manage-family-access.md) — edit and publish the allowlist and the admin list, then confirm on both sign-in paths.
4. [Refresh the family data from Gramps](how-to/refresh-the-family-data.md) — re-export, rebuild the trees and search files, and sync the data prefixes without touching member uploads.
5. [Deploy a change to the static site](how-to/deploy-a-site-change.md) — ship `11ty/` through the kit pipeline; the first run is the environment's first deploy.
6. [Turn on push notifications](how-to/turn-on-push-notifications.md) — optional: create the VAPID key pair and give it to the API.

### Ship a change

- [Deploy a change to the static site](how-to/deploy-a-site-change.md) — ship a change to `11ty/` or the legacy sign-in functions and confirm it is live.
- [Roll back, or drill a rollback of, a site deploy](how-to/roll-back-a-site-deploy.md) — after an automatic rollback, when nothing rolled back, by revert, and as a rehearsal.
- [Turn a feature flag on for one tab or for everyone](how-to/toggle-a-feature-flag.md) — preview a flag with the per-tab override, publish it in `flags.json`, and roll back.
- [Build and preview the React islands](how-to/build-and-preview-the-islands.md) — rebuild the committed bundles, check them against the source, and view them locally with a flag on.
- [Refresh `11ty/` from the Eleventy source](how-to/refresh-the-eleventy-output.md) — rebuild and promote the Eleventy output without losing the E5 files.
- [Run the test suites](how-to/run-the-tests.md) — run each suite with its prerequisites, and know which suites reach production.
- [Change the CI pipeline](how-to/change-the-ci-pipeline.md) — edit `ci.manifest.yaml`, re-render the workflows and check for drift.

### Operate and maintain

- [Add or remove a family member's access](how-to/manage-family-access.md) and [Refresh the family data from Gramps](how-to/refresh-the-family-data.md), as in set-up.
- [Refresh the sanitized samples](how-to/refresh-the-sanitized-samples.md) — update the synthetic samples the repo carries in place of private files.
- [Rotate the session signing key](how-to/rotate-the-session-signing-key.md) — replace the auth edge's signing key; every edge session is signed out.
- [Rotate the origin-verify secret](how-to/rotate-the-origin-verify-secret.md) — replace the CloudFront-to-Lambda shared secret with the shortest possible `403` window.
- [Rotate the Google sign-in client](how-to/rotate-the-google-client.md) — move both sign-in paths to a new Google OAuth web client.
- [Diagnose sign-in and API failures](how-to/diagnose-sign-in-and-api-failures.md) — symptom-first checks and fixes for sign-in, `/api/*`, `/auth/*` and MCP clients.

### Not covered yet

- **Restoring member content.** The `hfy-app` table has point-in-time recovery on, and every post and comment change leaves an `AUDIT#` item with the record's `before` state ([System architecture](reference/architecture.md#definition), [API: Audit records](reference/api.md#audit-records)), but there is no procedure for restoring from either. A point-in-time restore creates a new table, which the stack does not manage. Plan one with io before you need it.
