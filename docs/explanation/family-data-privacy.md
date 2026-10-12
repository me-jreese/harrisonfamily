# The privacy model for family data

The Harrison family site publishes a family archive to a small, closed audience. Most of what makes it worth visiting is private: records of real people, many of them alive, and things family members write and upload. This page explains what the project treats as private, how that data is kept out of git and away from the public, where the design is fragile, and why documents, fixtures and commits are held to the same rules as code.

This is an explanation. For the inventory of private assets, secret names and placeholders, see [Private data and secrets](../reference/private-data-and-secrets.md). For the steps to publish new family data safely, see [Refresh the family data](../how-to/refresh-the-family-data.md).

## What counts as private

The project treats the following as private:

- **The Gramps database and everything exported from it.** That covers the person, family, event, note and place JSON, the media binaries, the generated family-tree SVGs, and the search manifest and index (`person/index.json`, `person/search-index.json`). The search files are easy to overlook. They are derived data, but they hold every name and lifespan in the tree.
- **Data about living people.** This includes a name and a birth year, with no further detail needed.
- **Member emails.** The allowlist maps each member's email address to their Gramps ID. The admin list says which members can moderate. Both are private, and so is each member's sign-in account.
- **Member-generated content.** That means posts, comments, reactions and uploaded photos, plus the audit records that keep a copy of each change.

None of this enters git, for one reason: a repository cannot forget. A file that is committed and then deleted stays in the history, in every clone and in every fork. The repository is also built to be shared, so other families can adapt it. For both reasons, the only safe amount of private data in the repo is none.

What the repo carries instead is **sanitized samples**: directory templates and placeholder files with no real content. Examples are [`etl-output/`](../../etl-output/README.md), which holds READMEs only, [`harrisonfamily-frontend/`](../../harrisonfamily-frontend/README.md), and the `allowlist/` samples with `example.com` addresses. The samples are illustrative, not current: the `harrisonfamily-frontend/` person sample predates the ETL's present record shape, so nothing should be built against it.

Two scripts maintain most of these samples. [`scripts/export_workspace_samples.sh`](../../scripts/export_workspace_samples.sh) copies the sanitized tree `<project>/workspace/` into the repo. [`scripts/sync_sanitized_assets.py`](../../scripts/sync_sanitized_assets.py) keeps that tree mirroring `<project>/workspace-local/` with placeholders and never copies real data. The copy script is the one deliberate crossing of the physical boundary described in the next section, so `<project>/workspace/` must itself stay clean: whatever sits there reaches the repo on the next export.

## The pipeline boundary

There are two separate paths to production, and they meet only in the S3 bucket.

| Path | What it carries | Where it runs |
| --- | --- | --- |
| Code path | Eleventy output (`11ty/`), islands, API and auth-edge code, infrastructure templates | This repository. The kit pipeline ([`io-kit-deploy.yml`](../../.github/workflows/io-kit-deploy.yml)) ships `11ty/`, including the committed island bundles, and the legacy Lambda; [`deploy-gcf-legacy.yml`](../../.github/workflows/deploy-gcf-legacy.yml) ships the legacy Cloud Function; the API, auth edge and app stack are deployed by hand (see [Why releases ship through a pipeline and feature flags](release-model.md)) |
| Data path | Gramps exports, media, family trees, search index | The maintainer's machine. The ETL scripts, the Gramps database and the `workspace-local/` output all live in the project workspace, outside the repository, and `<project>/scripts/etl/sync_to_s3.py` uploads the result to the private prefixes |

The boundary is physical, not a `.gitignore` rule. The private trees sit outside the repository directory, so git cannot stage them by accident. The Eleventy source also lives outside the repo, and only its output is committed. That output contains page shells and no Gramps-export data. The only family material in it is the deliberately public homepage imagery. The person page and search fetch their data in the browser at runtime, after sign-in. CI never has private data to leak, because none ever reaches the checkout it deploys from. The same holds for the parts of the code path that ship by hand: none of them carries family data.

This split is why the repo's docs describe ETL scripts that the repo does not contain. The scripts belong to the data path, and only their documentation and sample output shapes belong to the code path.

## Living people: classified at the source

The ETL is the first line of defence for living people, because it is the only stage that sees the whole Gramps record. Its rule is deliberately blunt: **a person with no death event recorded is treated as living.** The rule errs toward privacy. Someone who died long ago but has no death record stays classified as living until a researcher adds the event. The opposite error, treating a living person as dead, is the one that matters, and the rule cannot make it.

The result is an `isLiving` flag. The ETL writes it on every person record and on every relative stub embedded in another person's record. The flag travels with the data, so every consumer can act on it without re-deriving it. Today the consumers use it to withhold death details and death years and to label people as living.

`isLiving` is a classification, not a redaction. A living person's record is still exported to the private prefixes, and the access gate (next sections) keeps it from the public. Anything that must not reach even signed-in members, such as sensitive notes, has to be removed in Gramps or reviewed before export. [Refresh the family data](../how-to/refresh-the-family-data.md#before-you-start) lists that manual review. A Gramps user might expect the per-record private flag to do this job, but the ETL ignores Gramps's private flag, so removal or pre-export review is the only control. Nor does `isLiving` suppress sensitive notes, as older sample notes claimed.

## One bucket for the site and the data

The static site and the private data share one S3 bucket. The site lives at the root, the Gramps data lives under the `person/`, `family/`, `event/`, `note/`, `place/` and `media/` prefixes, and the photos that members attach to posts live under `uploads/posts/`. This was a deliberate trade:

- **One origin.** Pages and data come from the same host, so data fetches are same-origin with credentials included. No CORS policy is needed for the data, and session handling is simpler.
- **One distribution.** One CloudFront distribution, one certificate and one cache serve everything, which keeps cost and moving parts low. See [Edge and origin design](edge-and-origin-design.md).

The cost of the trade is that **every `aws s3 sync --delete` becomes a hazard.** `--delete` removes any object in the destination that is missing from the source, unless an exclude rule protects it. Two writers share one namespace, and each holds only part of the picture, so either writer's `--delete` can destroy objects the other owns. The bucket now has three writers:

| Writer | What it owns | Deletes by default? | What protects the others |
| --- | --- | --- | --- |
| Site deploy (CI) | Everything outside the data prefixes and `uploads/`, including the `person/index.html` page shell | Yes | `exclude` globs in [`ci.manifest.yaml`](../../ci.manifest.yaml): the data prefixes, excluded since HFY-ISS-023, and `uploads/*`, since HFY-R58. The deploy role is also denied puts and deletes under `uploads/` |
| ETL sync (`<project>/scripts/etl/sync_to_s3.py`, outside the repo; options in [Private data and secrets](../reference/private-data-and-secrets.md#sync_to_s3py)) | The six data prefixes | Yes. `--no-delete` is opt-in | The sync is scoped to the data prefixes, since `--prefix` accepts only those six names. It excludes `index.html` under `person/` so it does not remove the page shell |
| Members' browsers | `uploads/posts/<ulid>/…` photo uploads | Never deletes | Each presigned URL allows one `PUT` to one key that the server chose, and the API role may put objects only under `uploads/posts/` |

The last row used to be the live hazard. Member photos exist **only** in S3. No copy exists in the repo, in the ETL output or on anyone's machine. Until HFY-R58 the uploads went under `media/posts/`, inside a prefix that the ETL sync mirrors with `--delete`. A default sync of `media` would have deleted every member photo, and the site deploy was safe only because its `media/*` exclude happened to cover the subtree. HFY-R58 gave the uploads a prefix that no writer's `--delete` reaches. The ETL sync cannot name it, the site deploy excludes it, and the deploy role's deny holds even if that exclude is lost ([The release model](release-model.md)). Photos uploaded before the move were not migrated, so [Refresh the family data](../how-to/refresh-the-family-data.md) checks for any left under `media/posts/` before it syncs.

The general lesson: **any new prefix in the bucket needs an exclude in every `--delete` sync in the same change.** Whoever adds the prefix knows about it. The sync script does not.

## Gating the JSON

The legacy pages, and the islands that reuse their data, request person JSON and the search files with an `X-HFY-Session` header. The header carries the session token issued at sign-in (see [The identity model](identity-model.md)). Every client sends `X-HFY-Session` when it has a session token. `gateway.enforceAssets` decides what the search code does when it has none yet: with it `true`, search waits up to 8 s and then fails or redirects to sign-in; with it `false`, search fetches without the header. That value used to come from a build variable.

HFY-ISS-015 showed why a build variable is not good enough. Signed-in members could not reliably load protected data after sign-in. In a build without the flag, search fetched before the token arrived, so the request went out without the header and got HTTP 403. The fix, recorded under HFY-ISS-015 in Enceladus, made `enforceAssets` a production default, not a build-time choice. The durable lesson is that **on the production host, search must wait for the token, whatever the build said.** One guard enforces that, and one check supports it:

- At runtime, [`11ty/js/feature-flags.js`](../../11ty/js/feature-flags.js) checks for the production hostname, forces `enforceAssets` to `true`, and logs an error if it had to. A bad build therefore degrades into a console error, not an outage. This is the only one of the two that acts on its own.
- [`scripts/validate_build.sh`](../../scripts/validate_build.sh) is a manual pre-deploy check that fails if the workspace build's `index.html` lacks `"enforceAssets":true`. CI does not run it, and it does not look at the committed `11ty/` that CI deploys.

Neither protects the data. They make the client behave correctly, and the server side cannot do much more. The legacy Lambda issues the token as 32 random bytes that it neither signs nor records, so no component can verify it. Whatever produced the documented 403s could at most check that the header was present, and that check is not in this repository. Neither the sample CloudFront configuration in `cloudfront/` nor the infrastructure templates and scripts contain one. Whether it still exists, and whether it covers every data prefix, cannot be verified from the code. Until that enforcement is found and documented, treat the private prefixes as protected by configuration you cannot see. Do not assume a property of the code protects them.

The newer API is different. Every `hfy-api` route under `/api` requires a signed session cookie, and the API verifies it in code ([`api/src/auth.js`](../../api/src/auth.js)). Member-generated content is gated in a place you can read and test. The legacy sign-in exchange at `/api/check-allowed` also sits under `/api`, but `hfy-check-allowed` serves it, and it takes a Google ID token, not a session cookie (see [Edge and origin design](edge-and-origin-design.md)).

## Member-generated content

Posts, comments and reactions live in the app's single DynamoDB table, not in S3 (see [Member content design](member-content-design.md)). Three privacy properties follow from the design:

- **Content changes are audited in the same transaction.** Every create, edit, delete and visibility change to a post or comment is one `TransactWriteItems` call. The call holds the data change and an `AUDIT#` item recording `{op, id, principal, at, before, after}`. Such a change cannot happen without its audit record, and an audit record cannot exist for a change that failed. Reactions, uploads and notification settings are written without an audit item; see [Member content design](member-content-design.md#why-reactions-are-not-audited) for why.
- **Deletion is not erasure.** A delete removes the post or comment, but the audit item keeps the full `before` copy. The table also has point-in-time recovery turned on. The audit trail is therefore as private as the content itself and carries the same classification.
- **Post visibility is decided on the server.** Posts are `draft`, `published` or `withdrawn`. The API filters posts on every read, and the client is not trusted to filter. A post's comment thread follows the post: a member who cannot see the post cannot read or add to its thread either, and deleting the post removes the thread, with an audit record for each comment removed (HFY-R58; see [Member content design](member-content-design.md#a-discussion-is-as-visible-as-its-post)).

Photos take a different route. The browser asks `/api/uploads` for a presigned S3 `PUT` and uploads the image straight to the bucket, so the API Lambda never handles the bytes ([`api/src/uploads.js`](../../api/src/uploads.js)). The server limits what can arrive: images only, at most 10 MB, a URL valid for five minutes, and a key the server chooses under `uploads/posts/<ulid>/`. Two consequences are worth knowing:

- **The filename is cleaned, not anonymised.** The server lowercases it and strips unusual characters, but a filename that names a person still names them.
- **Photos outlive their posts.** The API role can put objects under `uploads/posts/` but not delete them, so removing a post leaves its photos in S3. Photos are served through their own `/uploads/*` CloudFront behavior ([`scripts/infra/add-uploads-behavior.sh`](../../scripts/infra/add-uploads-behavior.sh)). It adds `nosniff` and a sandboxing Content-Security-Policy, so a mislabelled file cannot run script on the site, but it attaches no function. Nothing in the repository checks a session on that path, so as far as the code shows, a photo's URL is enough to fetch it. The random part of the ULID in the key is the only barrier.

## Notifications carry no content by default

Push notifications leave the system's control. They travel through the browser vendors' push services and appear on lock screens, where anyone nearby can read them. So the default is **level 0: content-free.** A recipient sees "Someone commented on your record." and no name.

Level 1 adds the actor's name ("*A family member* commented on your record."). It is opt-in, per recipient and per notification type, from the `/me/notifications` settings ([`api/src/notify.js`](../../api/src/notify.js)). The template registry allows exactly one field, `actor`, so not even a level-1 message can carry post or comment text. The payload still carries a deep link, which holds a Gramps ID or a post ULID and no name. A Gramps ID names no one by itself; it identifies a person only next to other facts from the family data, which someone reading a lock screen does not have. A failed push is logged and never undoes the write. The write is committed before any notification is attempted.

## The search corpus stays in memory

The search island builds its index from the same signed-session files as the legacy search. It deliberately keeps that index in memory and not in IndexedDB ([`islands/src/islands/search.jsx`](../../islands/src/islands/search.jsx), [`islands/src/lib/people-corpus.js`](../../islands/src/lib/people-corpus.js)). The index is a list of every person in the tree, and it should not outlive the session that was allowed to load it. When the tab closes or the member signs out, nothing from the search corpus is left in browser storage. The service worker follows the same rule: it caches only the offline shell and island bundles, and never `/api`, `/auth` or any data path. The member's own sign-in state is a separate matter: under the default legacy sign-in, [`11ty/js/auth.js`](../../11ty/js/auth.js) keeps the member's Google ID token, which carries their email, and their Gramps ID in `localStorage` until sign-out.

That property belongs to the island. The legacy navbar search runs while `searchV2` is off, which is the build default. It caches the manifest and search index in `sessionStorage`, and sign-out does not remove that cache. The cache ends when the tab closes, not at sign-out. Retiring the legacy search closes this gap. Until then, the in-memory guarantee holds only with `searchV2` on.

## Why the documentation follows the same rules

Writing about the system must not leak what the system protects, so docs, fixtures and commit messages are held to the same rules as code. The rules themselves, the placeholder forms and what a doc may cite, are in [Private data and secrets](../reference/private-data-and-secrets.md#placeholders). Two of their reasons are less obvious than the rest.

**A bucket listing identifies people without containing a record.** Person records are keyed by Gramps ID (`person/<gramps-id>.json`) and family-tree images by Gramps ID too (`tree_<gramps-id>.svg`). Gramps media are keyed by handle, and member uploads by the uploader's own cleaned filename. A filename that names a person still names them. A Gramps ID in a doc or a log sits next to the facts that tie it to someone: a relationship, a date, a neighbouring key, an allowlist entry. That is why object listings and sync output stay out of docs, and why Gramps IDs in examples are placeholders, even though a notification can carry one safely on its own.

**The pre-commit hook detects secrets, not people.** [`scripts/git-hooks/pre-commit`](../../scripts/git-hooks/pre-commit) runs `trufflehog` and blocks commits that look like they contain credentials. It is active only in clones that set `core.hooksPath` to `scripts/git-hooks`. A real name, birth date or email in a doc passes it untouched, and once committed it stays in the history. The placeholder rule is the control, and the hook catches only one kind of mistake.

## Further reading

- [Private data and secrets](../reference/private-data-and-secrets.md): every private asset, where it lives, secret names and the placeholder forms.
- [Refresh the family data](../how-to/refresh-the-family-data.md): running the ETL and syncing without deleting member uploads.
- [The identity model](identity-model.md): how members are recognised and how session tokens are issued.
- [Member content design](member-content-design.md): posts, comments and the audit trail in more depth.
- [Edge and origin design](edge-and-origin-design.md): the single distribution and how requests reach S3, the API and the auth edge.
- [Why releases ship through a pipeline and feature flags](release-model.md): which parts of the code path CI ships and which ship by hand.
