# The privacy model for family data

The Harrison family site publishes a family archive to a small, closed audience. Most of what makes it worth visiting is private: records of real people, many of them alive, and things family members write and upload. This page explains what the project treats as private, how that data is kept out of git and away from the public, what can leave the family boundary and how, where the design is fragile, and why documents, fixtures and commits are held to the same rules as code.

This is an explanation. For the inventory of private assets, secret names and placeholders, see [Private data and secrets](../reference/private-data-and-secrets.md). For the steps to publish new family data safely, see [Refresh the family data](../how-to/refresh-the-family-data.md).

## What counts as private

The project treats the following as private:

- **The Gramps database and everything exported from it.** That covers the person, family, event, note and place JSON, the media binaries, the generated family-tree SVGs, and the search manifest and index (`person/index.json`, `person/search-index.json`). The search files are easy to overlook. They are derived data, but they hold every name and lifespan in the tree.
- **Data about living people.** This includes a name and a birth year, with no further detail needed.
- **Member emails.** The allowlist maps each member's email address to their Gramps ID, and the MCP groups file, `config/groups.json`, can name members by email too. The admin list says which members can moderate. All of these are private, and so is each member's sign-in account. An MCP access token also carries its member's email (see [MCP: an agent channel out of the family boundary](#mcp-an-agent-channel-out-of-the-family-boundary)).
- **Member-generated content.** That means posts, comments, reactions and uploaded photos, plus the audit records that keep a copy of each change.

None of this enters git, for one reason: a repository cannot forget. A file that is committed and then deleted stays in the history, in every clone and in every fork. The repository is also built to be shared, so other families can adapt it. For both reasons, the only safe amount of private data in the repo is none.

What the repo carries instead is **sanitized samples**: directory templates and placeholder files with no real content. Examples are [`etl-output/`](../../etl-output/README.md), which holds READMEs only, [`harrisonfamily-frontend/`](../../harrisonfamily-frontend/README.md), and the `allowlist/` samples with `example.com` addresses. The samples are illustrative, not current: the `harrisonfamily-frontend/` person sample predates the ETL's present record shape, so nothing should be built against it.

Two scripts maintain most of these samples. [`scripts/export_workspace_samples.sh`](../../scripts/export_workspace_samples.sh) copies the sanitized tree `<project>/workspace/` into the repo. [`scripts/sync_sanitized_assets.py`](../../scripts/sync_sanitized_assets.py) keeps that tree mirroring `<project>/workspace-local/` with placeholders and never copies real data. The copy script is the one deliberate crossing of the physical boundary described in the next section, so `<project>/workspace/` must itself stay clean: whatever sits there reaches the repo on the next export.

## The pipeline boundary

There are two separate paths to production, and they meet only in the S3 bucket.

| Path | What it carries | Where it runs |
| --- | --- | --- |
| Code path | Eleventy output (`11ty/`), islands, the API, auth-edge and edge-gate code, infrastructure templates | This repository. The kit pipeline ([`io-kit-deploy.yml`](../../.github/workflows/io-kit-deploy.yml)) ships `11ty/`, including the committed island bundles, and the legacy Lambda; [`deploy-gcf-legacy.yml`](../../.github/workflows/deploy-gcf-legacy.yml) ships the legacy Cloud Function; the API, the auth edge, the app stack and the two us-east-1 edge functions (the data gate and the MCP 401 function) are deployed by hand (see [Why releases ship through a pipeline and feature flags](release-model.md) and [Deploy the edge functions](../how-to/deploy-the-edge-functions.md)) |
| Data path | Gramps exports, media, family trees, search index | The maintainer's machine. The ETL scripts, the Gramps database and the `workspace-local/` output all live in the project workspace, outside the repository, and `<project>/scripts/etl/sync_to_s3.py` uploads the result to the private prefixes |

The boundary is physical, not a `.gitignore` rule. The private trees sit outside the repository directory, so git cannot stage them by accident. The Eleventy source also lives outside the repo, and only its output is committed. That output contains page shells and no Gramps-export data. The only family material in it is the deliberately public homepage imagery. The person page and search fetch their data in the browser at runtime, after sign-in. CI never has private data to leak, because none ever reaches the checkout it deploys from. The same holds for the parts of the code path that ship by hand: none of them carries family data. The data gate's build, for example, bakes in only an issuer, an audience and a key URL ([`edge-gate/gate.config.json`](../../edge-gate/gate.config.json)).

This split is why the repo's docs describe ETL scripts that the repo does not contain. The scripts belong to the data path, and only their documentation and sample output shapes belong to the code path.

## Living people: classified at the source

The ETL is the first line of defence for living people, because it is the only stage that sees the whole Gramps record. Its rule is deliberately blunt: **a person with no death event recorded is treated as living.** The rule errs toward privacy. Someone who died long ago but has no death record stays classified as living until a researcher adds the event. The opposite error, treating a living person as dead, is the one that matters, and the rule cannot make it.

The result is an `isLiving` flag. The ETL writes it on every person record and on every relative stub embedded in another person's record. The flag travels with the data, so every consumer can act on it without re-deriving it. Today the consumers use it to withhold death details and death years and to label people as living.

`isLiving` is a classification, not a redaction. A living person's record is still exported to the private prefixes. Once the data gate is attached, the gate keeps it from anyone without a member session (see [Gating the JSON](#gating-the-json)). Anything that must not reach even signed-in members, such as sensitive notes, has to be removed in Gramps or reviewed before export. [Refresh the family data](../how-to/refresh-the-family-data.md#before-you-start) lists that manual review. A Gramps user might expect the per-record private flag to do this job, but the ETL ignores Gramps's private flag, so removal or pre-export review is the only control. Nor does `isLiving` suppress sensitive notes, as older sample notes claimed.

## One bucket for the site and the data

The static site and the private data share one S3 bucket. The site lives at the root, the Gramps data lives under the `person/`, `family/`, `event/`, `note/`, `place/` and `media/` prefixes, and the photos that members attach to posts live under `uploads/posts/`. This was a deliberate trade:

- **One origin.** Pages and data come from the same host, so data fetches are same-origin with credentials included. No CORS policy is needed for the data, and session handling is simpler: the host-only `io_id` session cookie reaches the data paths with no extra work, which is what the data gate relies on.
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

Before release 2, nothing in this repository checked a request for the family data. The legacy client sends an `X-HFY-Session` header with its data requests, but the token in it is 32 random bytes that the legacy Lambda neither signs nor records ([`lambda/hfy-check-allowed/index.mjs`](../../lambda/hfy-check-allowed/index.mjs)). Nothing could validate it, and nothing did. The repository's sanitized sample of the distribution, [`cloudfront/distribution.json`](../../cloudfront/distribution.json), records the same thing: its default behavior serves the data prefixes straight from the bucket, and no behavior checks them. Release 2 adds the first check on those paths that can be read and tested: the private data gate (HFY-R63).

### What the gate checks

[`edge-gate/src/gate.mjs`](../../edge-gate/src/gate.mjs) is a Lambda@Edge viewer-request function. [`scripts/infra/add-data-gate-behaviors.sh`](../../scripts/infra/add-data-gate-behaviors.sh) attaches it to `/person/*.json`, `/family/*`, `/event/*`, `/note/*`, `/place/*` and `/media/*`. The person pattern is `/person/*.json`, not `/person/*`, because `/person/` itself is the public page shell, which holds no data. The search files `person/index.json` and `person/search-index.json` match that pattern, so the search corpus is gated along with the records.

For each request, the gate reads the `io_id` cookie that the auth edge mints at sign-in. It verifies the RS256 signature against the auth edge's published keys. It then checks the issuer, the audience (`harrisonfamily-web`), `exp` and `nbf` with 60 s of clock skew, and that a subject is present. A request that passes goes on to S3 unchanged. Every other request is refused: a fetch, or an embedded image, gets a JSON 401, and a page navigation is redirected to `/auth/login`. The gate fails closed. No cookie, a malformed or forged token, an unknown key, no keys at all because none could be fetched, and any error all end in a refusal.

### What it does not check, and why

The gate does not read the allowlist, and it does not look at `token_use`. It is a signature and claims check with no lookup per request. Membership is enforced earlier, at the auth edge: the edge checks the allowlist when it mints `io_id` at sign-in, and again each time it re-mints `io_id` from the refresh cookie (see [The identity model](identity-model.md)). `token_use` is not needed either. An MCP access token is signed with the same key as `io_id`, but its audience is the MCP resource, not `harrisonfamily-web`, so the audience check refuses it.

The price is the one the API already pays: removal lags. A member removed from the allowlist keeps reading family data until their current `io_id` expires, up to an hour after it was minted. The auth edge's five-minute allowlist cache can let one more sign-in or refresh through, which can stretch that by a few minutes. After that, their refresh is refused and the gate denies them. When that is too long, rotating the session signing key ends every session ([Rotate the session signing key](../how-to/rotate-the-session-signing-key.md)).

### When it applies

The gate protects nothing until it is attached to the distribution, and it is attached only after the `authV2` cutover (HFY-R67). Until then, the data paths are exactly as they were before release 2. The cutover runs flags first, then the gate: turn `authV2` on and deploy the site, confirm that the client sends the cookie, and only then attach the gate ([Cut over to authV2 and the private data gate](../how-to/cut-over-to-the-private-data-gate.md)).

The order follows from what each client sends. The old client sends only `X-HFY-Session`, which the gate ignores. Attached first, the gate would refuse person, search and media data to every visitor still running the old client until the site deploy finished. Turning `authV2` on first changes nothing about who can read the data. It only moves clients to the cookie. So by the time the gate is attached, no visitor is still running a client it would lock out. Rolling back runs the same way in reverse. Removing the gate behaviors (the script's `--remove`) returns the data paths to the default behavior, which serves them with no check.

### Gated responses are never stored

Cloudflare proxies the site in front of CloudFront, and it caches some file types, such as images, SVG and PDF, whatever CloudFront's cache policy says. A member's `/media/` response stored there would be served to the next visitor without that request ever reaching the gate. So every gated behavior uses `CachingDisabled` and the `hfy-private-no-store` response headers policy, which sets `Cache-Control: private, no-store` on every response. The gate's own 401 and 302 carry the same header (HFY-R65). Cloudflare and other shared caches therefore never keep member data, and the browser's HTTP cache does not store it either.

Two limits apply. The protection rests on Cloudflare honoring the origin's `Cache-Control`, which is its default. A Cloudflare cache rule that overrides the edge TTL for these paths would undo it, and Cloudflare's configuration lives outside this repository. Also, responses that Cloudflare cached before the gate was attached stay there until they expire or are purged, which is why the cutover includes an optional purge.

### Uploads stay outside the gate

`/uploads/*` is deliberately not gated. Member photos keep their own behavior and, as before, are reached by an unguessable URL. See [Member-generated content](#member-generated-content).

### The client side

With `authV2` off, the client behaves as it always has. The legacy pages, and the islands that reuse their data, send `X-HFY-Session` when they have a session token. `gateway.enforceAssets` decides what search does when it has none yet. With it `true`, search waits up to 8 s for the token and then fails or redirects to sign-in. With it `false`, search fetches without the header. HFY-ISS-015 showed why that value cannot be left to a build variable: in a build without the flag, search fetched before the token arrived, and signed-in members could not reliably load data after sign-in. Two guards came out of it:

- At runtime, [`11ty/js/feature-flags.js`](../../11ty/js/feature-flags.js) checks for the production hostname, forces `enforceAssets` to `true`, and logs an error if it had to. A bad build therefore degrades into a console error, not an outage. This is the only one of the two that acts on its own.
- [`scripts/validate_build.sh`](../../scripts/validate_build.sh) is a manual pre-deploy check that fails if the workspace build's `index.html` lacks `"enforceAssets":true`. CI does not run it, and it does not look at the committed `11ty/` that CI deploys.

Neither guard ever protected the data. They make the legacy client behave correctly, and they matter only while `authV2` is off.

With `authV2` on, the header and the token wait are gone. Data requests go through `HFYFeatureFlags.dataFetch` in the same file, which sends only the same-origin `io_id` cookie. That cookie is HttpOnly, so page scripts never hold the token. Before the first data fetch on a page, `dataFetch` refreshes a session that is close to expiry from the refresh cookie. When the gate answers 401, it refreshes once and retries the request once. Only when that fails does it send the member to sign in (HFY-R66). The refresh is where the auth edge re-checks the allowlist, so this continuity never outlasts membership.

The API was gated in code from the start. Every `hfy-api` route under `/api` requires the same signed `io_id` cookie, and the API verifies it in [`api/src/auth.js`](../../api/src/auth.js). The legacy sign-in exchange at `/api/check-allowed` also sits under `/api`, but `hfy-check-allowed` serves it, and it takes a Google ID token, not a session cookie (see [Edge and origin design](edge-and-origin-design.md)). The MCP server at `/mcp` takes a bearer access token instead; see [MCP: an agent channel out of the family boundary](#mcp-an-agent-channel-out-of-the-family-boundary).

## Member-generated content

Posts, comments and reactions live in the app's single DynamoDB table, not in S3 (see [Member content design](member-content-design.md)). Four privacy properties follow from the design:

- **Content changes are audited in the same transaction.** Every create, edit, delete and visibility change to a post or comment is one `TransactWriteItems` call. The call holds the data change and an `AUDIT#` item recording `{op, id, principal, at, before, after}`. Such a change cannot happen without its audit record, and an audit record cannot exist for a change that failed. Reactions, uploads and notification settings are written without an audit item; see [Member content design](member-content-design.md#why-reactions-are-not-audited) for why.
- **Deletion is not erasure.** A delete removes the post or comment, but the audit item keeps the full `before` copy. The table also has point-in-time recovery turned on. The audit trail is therefore as private as the content itself and carries the same classification.
- **Post visibility is decided on the server.** Posts are `draft`, `published` or `withdrawn`. The API filters posts on every read, and the client is not trusted to filter. A post's comment thread follows the post: a member who cannot see the post cannot read or add to its thread either, and deleting the post removes the thread, with an audit record for each comment removed (HFY-R58; see [Member content design](member-content-design.md#a-discussion-is-as-visible-as-its-post)).
- **An author label is never an email (HFY-R68).** Every post and comment stores an `author.label` that every member sees, and the same label names the actor in a level-1 notification. The session's `name` claim comes from the member's allowlist entry, and for a plain-string entry the auth kit falls back to the member's email, so the claim cannot be trusted as a label. [`api/src/labels.js`](../../api/src/labels.js) therefore picks the label in a fixed order: a usable `name` claim first, then the person's `displayName` from their record on the site, then the Gramps ID. A candidate containing `@` is never used. To read the record, `hfy-api` may get objects under `<site-bucket>/person/*` and nothing else among the data prefixes (the `PersonRecords` statement in [`app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml)). The label is copied onto the post or comment, its index items and its audit entry when they are written, and nothing in the repository rewrites it later. A later change to a person's `displayName` does not relabel old content, and content written before HFY-R68 keeps the label it was stored with.

Photos take a different route. The browser asks `/api/uploads` for a presigned S3 `PUT` and uploads the image straight to the bucket, so the API Lambda never handles the bytes ([`api/src/uploads.js`](../../api/src/uploads.js)). The server limits what can arrive: images only, at most 10 MB, a URL valid for five minutes, and a key the server chooses under `uploads/posts/<ulid>/`. Two consequences are worth knowing:

- **The filename is cleaned, not anonymised.** The server lowercases it and strips unusual characters, but a filename that names a person still names them.
- **Photos outlive their posts.** The API role can put objects under `uploads/posts/` but not delete them, so removing a post leaves its photos in S3. Photos are served through their own `/uploads/*` CloudFront behavior ([`scripts/infra/add-uploads-behavior.sh`](../../scripts/infra/add-uploads-behavior.sh)). It adds `nosniff` and a sandboxing Content-Security-Policy, so a mislabelled file cannot run script on the site, but it attaches no function, and the data gate leaves `/uploads/*` out on purpose. A photo's URL is enough to fetch it. The random part of the ULID in the key is the only barrier.

## MCP: an agent channel out of the family boundary

Release 2 adds a second way for member content to leave the site: an MCP server at `/mcp`, mounted in the `hfy-api` Lambda ([`api/src/mcp.js`](../../api/src/mcp.js)). A member signs in at the auth edge and authorizes an AI client, and the client then calls tools with a bearer access token. Whatever a tool returns goes to that client and to the service behind it, which is outside the family's control, much as a push notification is. The design therefore limits who can open the channel, what crosses it and what is recorded about it.

- **Only named members can use it.** Tools are listed and run only for members in the `mcp-authors` or `hfy-admin` group of `config/groups.json` (its shape is documented in [`api/src/policy.js`](../../api/src/policy.js)). The API reads that file itself, caches it for 60 s and fails closed, and it ignores the token's own `groups` claim. A member in neither group can authorize a client, but the client sees an empty tool list. `mcp-authors` may be empty, and then only the admin subjects can use the channel.
- **Posts and comments, nothing else.** The tools list and get posts, list comments, and create both. Members of `hfy-admin` can also delete, but only after a fresh, user-verified sign-in. No tool reads the Gramps data under the gated prefixes. Each tool runs the site's own route handler as the member, so the visibility and thread rules above apply unchanged: a client sees what its member would see on the site.
- **A new post is a draft.** `hfy_posts_create` always creates a draft and has no visibility argument, so publishing to the family stays a human action in the site UI. A comment has no draft state. One created through MCP is visible at once, like one typed on the site, and it gets the same `AUDIT#` record because it goes through the same handler.
- **The token carries the member's email.** An access token holds the member's `email` claim, `amr` and `auth_time` (HFY-R64), and also `name` when the session has a usable non-email label. The client keeps the token, so the member's email address travels with it. The API uses the email only to match `mcp-authors` entries. It never becomes a label.
- **Calls are logged, their content is not.** Each tool call writes an `mcp.audit` log line with the tool, the mode, the outcome, the sign-in method and time, and the principal's `sub` and groups. The line does not carry the arguments, the result or the email, but its `sub` is a Gramps ID, so the log is private too. It goes to the API's CloudWatch log group, which keeps it for 30 days, not to the table's `AUDIT#` items.
- **Access ends with membership.** An access token lasts an hour. Each refresh re-checks the allowlist at the auth edge, so a removed member's clients stop at their next refresh. Removing someone from `mcp-authors` takes effect at the API within a minute.

## Notifications carry no content by default

Push notifications leave the system's control. They travel through the browser vendors' push services and appear on lock screens, where anyone nearby can read them. So the default is **level 0: content-free.** A recipient sees "Someone commented on your record." and no name.

Level 1 adds the actor's name ("*A family member* commented on your record."). It is opt-in, per recipient and per notification type, from the `/me/notifications` settings ([`api/src/notify.js`](../../api/src/notify.js)). The template registry allows exactly one field, `actor`, so not even a level-1 message can carry post or comment text. The payload still carries a deep link, which holds a Gramps ID or a post ULID and no name. A Gramps ID names no one by itself; it identifies a person only next to other facts from the family data, which someone reading a lock screen does not have. A failed push is logged and never undoes the write. The write is committed before any notification is attempted.

The push services also learn who is sending. `hfy-api` signs each push with the VAPID key pair in the secret named by the `VapidSecretName` stack parameter (in production, `harrisonfamily/api/vapid`), and that secret's `subject` is the sender contact every push service receives. In production the subject is an `https://` URL, not a `mailto:` address, so no email address goes to the push services. The code does not enforce this. It depends on what the secret holds ([Turn on push notifications](../how-to/turn-on-push-notifications.md)).

## The search corpus stays in memory

The search island builds its index from the same two files as the legacy search, the person manifest and the search index. With `authV2` off, it fetches them with the `X-HFY-Session` header, as the legacy search does. Under `authV2`, it fetches them with the `io_id` cookie through the data gate ([`islands/src/lib/people-corpus.js`](../../islands/src/lib/people-corpus.js)). Either way, it deliberately keeps the index in memory and not in IndexedDB ([`islands/src/islands/search.jsx`](../../islands/src/islands/search.jsx)). The index is a list of every person in the tree, and it should not outlive the session that was allowed to load it. When the tab closes or the member signs out, nothing from the search corpus is left in browser storage. The service worker follows the same rule: it caches only the offline shell and island bundles, and never `/api`, `/auth` or any data path.

The member's own sign-in state is a separate matter. Under the legacy sign-in, [`11ty/js/auth.js`](../../11ty/js/auth.js) keeps the member's Google ID token, which carries their email, and their Gramps ID in `localStorage` until sign-out. Under `authV2`, the session lives in HttpOnly cookies that page scripts cannot read. Web storage holds only small markers, and none of them carries a token, a name or an email:

| Key | Storage | What it holds |
| --- | --- | --- |
| `hfy:edge-session` | `localStorage` | `"1"`, a marker that this browser has held an edge session, so a lapsed session is worth refreshing. Removed at sign-out and when a refresh is refused ([`11ty/js/feature-flags.js`](../../11ty/js/feature-flags.js)) |
| `hfy:auth-bounce` | `sessionStorage` | A timestamp of when a failed data fetch last sent this tab to sign-in. It stops redirect loops for 10 minutes and is removed by the next successful data fetch |
| `hfy:flags` | `sessionStorage` | Preview flag overrides from `?hfy_flags=`, for this tab only. Used with either sign-in |
| `io-passkey-dismissed` | `localStorage` | `"1"` once the member declines the auth edge's offer to add a passkey. Set by the sign-in page that `@io-kit/auth` serves |

The in-memory property belongs to the island. The legacy navbar search runs while `searchV2` is off, which is the build default, under either sign-in. It caches the manifest and search index in `sessionStorage`, and neither sign-out path removes that cache. The cache ends when the tab closes, not at sign-out. Retiring the legacy search closes this gap. Until then, the in-memory guarantee holds only with `searchV2` on.

## Why the documentation follows the same rules

Writing about the system must not leak what the system protects, so docs, fixtures and commit messages are held to the same rules as code. The rules themselves, the placeholder forms and what a doc may cite, are in [Private data and secrets](../reference/private-data-and-secrets.md#placeholders). Two of their reasons are less obvious than the rest.

**A bucket listing identifies people without containing a record.** Person records are keyed by Gramps ID (`person/<gramps-id>.json`) and family-tree images by Gramps ID too (`tree_<gramps-id>.svg`). Gramps media are keyed by handle, and member uploads by the uploader's own cleaned filename. A filename that names a person still names them. A Gramps ID in a doc or a log sits next to the facts that tie it to someone: a relationship, a date, a neighbouring key, an allowlist entry. That is why object listings and sync output stay out of docs, and why Gramps IDs in examples are placeholders, even though a notification can carry one safely on its own.

**The pre-commit hook detects secrets, not people.** [`scripts/git-hooks/pre-commit`](../../scripts/git-hooks/pre-commit) runs `trufflehog` and blocks commits that look like they contain credentials. It is active only in clones that set `core.hooksPath` to `scripts/git-hooks`. A real name, birth date or email in a doc passes it untouched, and once committed it stays in the history. The placeholder rule is the control, and the hook catches only one kind of mistake.

## Further reading

- [Private data and secrets](../reference/private-data-and-secrets.md): every private asset, where it lives, secret names and the placeholder forms.
- [Refresh the family data](../how-to/refresh-the-family-data.md): running the ETL and syncing without deleting member uploads.
- [Cut over to authV2 and the private data gate](../how-to/cut-over-to-the-private-data-gate.md): the flags-first order, attaching the gate, the optional Cloudflare purge and the rollback.
- [Identity services](../reference/identity-services.md): the auth edge's cookies and token claims, and its section on the private data gate.
- [MCP server](../reference/mcp-server.md): the tools, the policy table, the groups file and the access token claims.
- [The identity model](identity-model.md): how members are recognised, how sessions are issued and what removal does.
- [Member content design](member-content-design.md): posts, comments and the audit trail in more depth.
- [Edge and origin design](edge-and-origin-design.md): the single distribution and how requests reach S3, the API and the auth edge.
- [Why releases ship through a pipeline and feature flags](release-model.md): which parts of the code path CI ships and which ship by hand.
