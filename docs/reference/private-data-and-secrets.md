# Private data and secrets inventory

Reference for every private asset the site and its tooling depend on: where it lives, who reads it, and how docs name it.

Values, file contents and listings never appear in these docs. That covers secret values (whole or truncated), tokens, real email addresses, real people and their dates, Gramps IDs from the real tree, bucket listings and sync output. Each entry below gives the asset's name, its location as a placeholder, its format, and the code that reads or writes it.

For why the project draws these lines, see [The privacy model for family data](../explanation/family-data-privacy.md). For the steps that touch these assets, see [Sync Gramps with the website](../how-to/sync-gramps-with-the-website.md), [Manage family access](../how-to/manage-family-access.md), [Run the tests](../how-to/run-the-tests.md), [Rotate the session signing key](../how-to/rotate-the-session-signing-key.md), [Rotate the origin-verify secret](../how-to/rotate-the-origin-verify-secret.md), [Turn on push notifications](../how-to/turn-on-push-notifications.md), [Deploy the edge functions](../how-to/deploy-the-edge-functions.md), [Publish the CloudFront function](../how-to/publish-the-cloudfront-function.md) and [Cut over to authV2 and the private data gate](../how-to/cut-over-to-the-private-data-gate.md).

## Placeholders

Every doc uses these forms in place of deployment-specific values.

| Placeholder | Stands for | Where the real value is set |
| --- | --- | --- |
| `<project>` | The project directory that contains the repository checkout. It also holds the out-of-repo tooling and the private data. | The parent of the checkout. The workspace helpers in `scripts/` assume the checkout is at `<project>/repo`. |
| `<eleventy-source>` | The Eleventy project that builds `11ty/`, at `<project>/workspace/11ty-dev`. Not under Git. | Fixed path under `<project>`. |
| `<repo>` | The repository checkout root, a local path. Not the GitHub repository name, which is `<github-repo>`. | Normally `<project>/repo`. |
| `<site>` | The site's host name, the apex domain the distribution serves (also served at `www.<site>`). URLs are written `https://<site>/...`. | The distribution's aliases and certificate; the `smoke` URLs in [`ci.manifest.yaml`](../../ci.manifest.yaml); the `MediaPublicBase`, `SessionIssuer`, `SessionJwksUrl` and `McpResources` defaults in [`app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml); the site, origins and issuer, the passkey provider's `rpId` and `origins`, and `theme.cssUrl`, in [`auth/edge.manifest.json`](../../auth/edge.manifest.json); `SITE_ORIGIN` in [`islands/assets.mjs`](../../islands/assets.mjs), which decides which absolute URLs the build versions; the `isProductionHost` host check in [`11ty/js/feature-flags.js`](../../11ty/js/feature-flags.js), which forces `enforceAssets` on that host; `FOOTER` in [`islands/copy.mjs`](../../islands/copy.mjs); the `issuer` and `jwksUrl` in [`edge-gate/gate.config.json`](../../edge-gate/gate.config.json), which the build bakes into the gate's zip; `MCP_RESOURCE` in [`api/src/routes.js`](../../api/src/routes.js) and `DEFAULT_MCP_RESOURCE` in [`auth/src/oauth.js`](../../auth/src/oauth.js); the session issuer, JWKS URL and media base defaults in [`api/src/index.js`](../../api/src/index.js), and the issuer default in [`api/src/mcp.js`](../../api/src/mcp.js); the `publicBase` default in [`api/src/uploads.js`](../../api/src/uploads.js) and the `mediaPublicBase` default in [`api/src/content.js`](../../api/src/content.js); the `--base` and `--audience` defaults in [`scripts/mcp/token-smoke.sh`](../../scripts/mcp/token-smoke.sh); the two allowed origins, `https://<site>` and `https://www.<site>`, in [`site-bucket-cors.json`](../../infrastructure/cloudformation/site-bucket-cors.json), and `SITE_ORIGINS` in [`scripts/infra/test/run.sh`](../../scripts/infra/test/run.sh), which pins them; the `theme.cssUrl` check in [`scripts/infra/test/run.sh`](../../scripts/infra/test/run.sh), which expects that URL on `https://<site>`. Many tests pin the host as well; the list to change for another site is in [Stand up the static site](../how-to/stand-up-the-static-site.md#if-you-are-adapting-the-repo-for-another-family). |
| `<github-owner>` | The GitHub user or organization that owns the repository. | The `GitHubOrg` parameter of [`github-roles.yaml`](../../infrastructure/cloudformation/github-roles.yaml). |
| `<github-repo>` | The GitHub repository's name, without the owner. `gh` commands name the repository as `<github-owner>/<github-repo>`. | The `GitHubRepo` parameter of [`github-roles.yaml`](../../infrastructure/cloudformation/github-roles.yaml), whose default is `harrisonfamily`. |
| `<site-bucket>` | The S3 bucket that serves the static site, the family data and member uploads. | The `s3_static` target's `bucket` in [`ci.manifest.yaml`](../../ci.manifest.yaml), rendered into the defaults of the `.github/actions/io-kit-ci/` actions; `MediaBucket` in [`app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml); the bucket defaults in [`api/src/uploads.js`](../../api/src/uploads.js) and [`api/src/index.js`](../../api/src/index.js); the `URL` default in [`scripts/infra/check-site-bucket-cors.sh`](../../scripts/infra/check-site-bucket-cors.sh); the deploy role's resources in [`github-roles.yaml`](../../infrastructure/cloudformation/github-roles.yaml); the default destination of `sync_to_s3.py`. |
| `<config-bucket>` | The S3 bucket that holds the access configuration under `config/`. | `ConfigBucket` in `app-stack.yaml`; `resolver.bucket` in [`auth/edge.manifest.json`](../../auth/edge.manifest.json); the `ADMIN_LIST_BUCKET` and `GROUPS_BUCKET` defaults in [`api/src/index.js`](../../api/src/index.js); `HFY_CONFIG_BUCKET` in `publish_allowlists.sh`. |
| `<code-bucket>` | The S3 bucket in `us-west-2` that holds the app stack's Lambda packages under commit-named keys, `lambda/hfy-api-<sha>.zip` and `lambda/hfy-auth-edge-<sha>.zip`. `<sha>` is the commit the zips were built from. | `CodeBucket` in `app-stack.yaml` (no default). The keys are passed as `CodeKey` and `AuthCodeKey`, whose template defaults, `lambda/hfy-api.zip` and `lambda/hfy-auth-edge.zip`, a deploy overrides. |
| `<edge-code-bucket>` | The private S3 bucket in `us-east-1` that holds the data gate's zips, under the content-addressed keys `lambda/hfy-edge-gate-<16 hex>.zip` that [`scripts/ci/package-edge-gate.sh`](../../scripts/ci/package-edge-gate.sh) prints. | The `CodeBucket` parameter of the `hfy-edge-gate` stack, [`edge-gate-stack.yaml`](../../infrastructure/cloudformation/edge-gate-stack.yaml) (no default). The commands `package-edge-gate.sh` prints name it `<us-east-1 code bucket>`. |
| `<app-stack>` | The name of the live app stack, deployed from `app-stack.yaml`. | Chosen with `--stack-name` when the stack was first deployed. It is not `hfy-app`, which is the default of two flags. One is the `--stack` of `add-api-behavior.sh`, `add-auth-behavior.sh`, `add-uploads-behavior.sh` and `add-mcp-behavior.sh`, the stack whose outputs those scripts read. The other is the `--app-stack` of [`add-data-gate-behaviors.sh`](../../scripts/infra/add-data-gate-behaviors.sh). While `/uploads/*` is gated, its `--remove` reads the `UploadsResponseHeadersPolicyId` output of the `--app-stack` stack, in the CLI's default Region, unless `--restore-uploads-policy-id` names the policy. When that lookup fails, it exits 1 and changes nothing, `--dry-run` included; only an offline `--config-file` dry run uses a placeholder instead. The `--stack` of `add-data-gate-behaviors.sh` names the `us-east-1` gate stack, not the app stack, and its default, `hfy-edge-gate`, is the deployed name. The commands are in [Deploy the app stack](../how-to/deploy-the-app-stack.md), [Cut over to authV2 and the private data gate](../how-to/cut-over-to-the-private-data-gate.md) and [Stand up the static site](../how-to/stand-up-the-static-site.md). |
| `<distribution-id>` | The CloudFront distribution. | The `s3_static` target's `distribution` in [`ci.manifest.yaml`](../../ci.manifest.yaml), rendered into the `deploy-static` and `invalidate` action defaults; the `--distribution` default in the `scripts/infra/add-*-behavior.sh` scripts, in [`add-data-gate-behaviors.sh`](../../scripts/infra/add-data-gate-behaviors.sh) and in [`publish-append-index.sh`](../../scripts/infra/publish-append-index.sh); the header comment of [`scripts/cloudfront/append-index.js`](../../scripts/cloudfront/append-index.js); [`github-roles.yaml`](../../infrastructure/cloudformation/github-roles.yaml); and the tests in [`scripts/infra/test/run.sh`](../../scripts/infra/test/run.sh), which expect those defaults. |
| `<aws-account-id>` | The AWS account. | The OIDC provider ARN default in `github-roles.yaml`; the CodeArtifact registry URL in each `.npmrc`. It is also part of every Lambda ARN, including the `EdgeGateVersionArn` and `Edge401FunctionVersionArn` stack outputs that the CloudFront scripts print. |
| `<google-web-client-id>` | The Google OAuth web client ID. Public, but still written as a placeholder. | The `GoogleClientId` stack parameter. |
| `<user-pool-id>` | The Cognito user pool. | The `UserPoolId` stack output, passed to `hfy-auth-edge` as `COGNITO_USER_POOL_ID`. |
| `<email>` | A member's email address. | `config/userGrampsID.json`, and the `mcp-authors` `emails` in `config/groups.json`. In JSON examples, use `example.com` addresses so the example stays valid. |
| `<gramps-id>` | A Gramps person ID. It is also the session and access-token subject (`sub`), and the form of an admin list entry and of a `subjects` entry in `config/groups.json`. | The Gramps database. |
| `<handle>` | A Gramps internal handle. Family, event, note, place and media files are named by handle. | The Gramps database. |
| `<family-contact>` | The family member whom the site's sign-in and error copy tells a visitor to text. | The `copy` block of [`auth/edge.manifest.json`](../../auth/edge.manifest.json); `KIT_STRINGS` in [`auth/src/edge.js`](../../auth/src/edge.js); `VOICE` in [`11ty/js/person-page.js`](../../11ty/js/person-page.js); the error copy in [`islands/src/lib/posts-ui.jsx`](../../islands/src/lib/posts-ui.jsx), [`comment-source.js`](../../islands/src/lib/comment-source.js) and [`people-corpus.js`](../../islands/src/lib/people-corpus.js); `FOLLOW_COPY.failed` and `FOLLOW_COPY.listFailed` in [`islands/src/lib/follow.js`](../../islands/src/lib/follow.js); `LABELS` and `LOAD_FAILED` in [`islands/src/islands/notifications.jsx`](../../islands/src/islands/notifications.jsx). Tests that check this copy repeat it. |
| `<test-email>`, `<test-password>` | The sign-in of the Cognito test user that the `auth-v2` spec uses. | `HFY_TEST_EMAIL`, `HFY_TEST_PASSWORD` in the tester's shell. |
| `<access-token>` | Any bearer value: an MCP access or refresh token, an `io_id` session cookie or `io_rt` refresh cookie, a Google ID token. | Issued at runtime. Never recorded. |

**What docs may cite.** Secret names, stack parameter names, environment variable names, S3 key names under `config/`, data prefix names and file names in the tooling. Docs never cite a value, a file's contents, an object listing, or command output that prints object keys.

**Markers in code are not doc placeholders.** The code uses its own markers, which a build or the runtime replaces. The `REPLACED_AT_RUNTIME_FROM_*` values in `auth/edge.manifest.json` are filled from the Lambda environment by [`auth/src/edge.js`](../../auth/src/edge.js).

[`islands/build.mjs`](../../islands/build.mjs) writes three more kinds of marker on every build, and the results are committed:

- The `/* hfy-asset-versions:start ... */` to `/* hfy-asset-versions:end */` blocks in [`11ty/js/feature-flags.js`](../../11ty/js/feature-flags.js) and [`11ty/sw.js`](../../11ty/sw.js). Each holds `const ASSET_V`, the content hashes of the files that script loads.
- The `<!-- hfy-theme:start A -->` and `<!-- hfy-theme:start B -->` head blocks in every page, each closed by its `hfy-theme:end` comment, written through [`islands/heads.mjs`](../../islands/heads.mjs).
- The `?v=<sha8>` query strings that [`islands/assets.mjs`](../../islands/assets.mjs) puts on every same-origin script, stylesheet and manifest reference in `11ty/**/*.html`, and on `theme.cssUrl` in `auth/edge.manifest.json`. `<sha8>` is the first 8 hex digits of the SHA-256 of the referenced file as committed.

`cd islands && npm run build` rewrites them, so a hand edit lasts only until the next build, and `npm run check:islands` fails while one is stale. Docs write a version as `?v=<sha8>`, never as a real hash. The deployed files are exactly the committed ones (HFY-TSK-317 removed the client-ID patch step), so every `?v` hashes the bytes that are served. See [Theme and asset build](theme-and-asset-build.md).

## Family data and uploads in `<site-bucket>`

The static site, the family data and member uploads share one bucket. Three writers touch it. The two that sync do so with `--delete`, and each stays off the other prefixes through excludes or a fixed prefix list.

| Prefix | Holds | Written by | Deleted by |
| --- | --- | --- | --- |
| Everything outside the prefixes below, including `person/index.html` | Eleventy output from `11ty/` | Site deploy: the `s3_static` target in [`ci.manifest.yaml`](../../ci.manifest.yaml), which [`io-kit-deploy.yml`](../../.github/workflows/io-kit-deploy.yml) runs as `aws s3 sync 11ty/ s3://<site-bucket>/ --delete` with the manifest's `exclude` globs. Its rollback job resyncs the previous release artifact the same way. | Site deploy, for any key that no exclude covers |
| `person/` | `<gramps-id>.json` person records; `index.json`, the person manifest; `search-index.json` | ETL sync (`sync_to_s3.py`, prefix `person`), which excludes `index.html` | ETL sync, by default. The site deploy excludes `person/*.json`. |
| `family/`, `event/`, `note/`, `place/` | One `<handle>.json` per Gramps record, named by handle, not Gramps ID. `place/` also holds `index.json`. | ETL sync | ETL sync, by default. The site deploy excludes each prefix. |
| `media/` | Media binaries named `<handle><ext>`; `<handle>.json` media records; `index.json`; family-tree SVGs named `tree_<gramps-id>.svg` | ETL sync | ETL sync, by default. The site deploy excludes `media/*`. |
| `uploads/posts/<ulid>/photo.<ext>` | Member post photos. Runtime data, not ETL output, and the only copy. | Members' browsers, by presigned `PUT` from `POST /api/uploads` ([`api/src/uploads.js`](../../api/src/uploads.js), [`api/src/presign.js`](../../api/src/presign.js)). The `hfy-api` role may put objects under `uploads/posts/*` (the `PostPhotoUploads` statement in `app-stack.yaml`) and `uploads/comments/*` (`CommentPhotoUploads`), may read both prefixes (`UploadReads`), and cannot delete them. | Nothing. The ETL sync has no `uploads` prefix. The site deploy excludes `uploads/*`, and the deploy role in [`github-roles.yaml`](../../infrastructure/cloudformation/github-roles.yaml) is denied `s3:PutObject` and `s3:DeleteObject` on `uploads/*` as a backstop. The API has no delete path, so deleting a post leaves its photo. |
| `uploads/comments/<ulid>/<name>` | Member comment photos. Runtime data, not ETL output, and the only copy. | The same `hfy-api` role puts and reads objects here (`CommentPhotoUploads`, `UploadReads`), and cannot delete them. A `HEAD` or copy of a missing key answers `403`, not `404`, because the role has no `s3:ListBucket`; callers must treat both as "upload missing". | Nothing. The ETL sync has no `uploads` prefix. The site deploy excludes `uploads/*`, and the deploy role in [`github-roles.yaml`](../../infrastructure/cloudformation/github-roles.yaml) is denied `s3:PutObject` and `s3:DeleteObject` on `uploads/*` as a backstop. The API has no delete path, so deleting a post leaves its photo. |

- The server names every post photo `photo.<ext>`, the extension set by the declared content type (`jpg`, `png`, `webp` or `heic`), and ignores the uploader's file name. The islands send a fixed `photo` in its place, never the file's own name. Uploads made before that rule have keys built from the uploader's cleaned file name, so those keys, and the URLs of the posts that hold them, can still carry a name.
- Each presign writes an `UPLOAD#<ulid>` item binding the upload to its uploader for 24 hours. A post may attach only its author's own, unexpired, not yet attached uploads, and the API refuses one whose first 256 KiB (and, for a larger WebP, last 256 KiB) carries location metadata ([API: Upload binding](api.md#upload-binding), [Location check](api.md#location-check)).
- Each presigned URL is valid for 300 s and signs `Content-Type` and `Content-Length`. The API accepts JPEG, PNG, WebP and HEIC up to 10 MB.
- The browser `PUT`s the photo to the bucket's S3 endpoint, not through CloudFront ([`api/test/presign.test.js`](../../api/test/presign.test.js)), so the data gate never sees an upload.
- CloudFront serves uploads back through the `/uploads/*` behavior. [`add-uploads-behavior.sh`](../../scripts/infra/add-uploads-behavior.sh) creates it public: the stack's `UploadsResponseHeadersPolicy` (`X-Content-Type-Options: nosniff` and the CSP `sandbox; default-src 'none'; img-src 'self'`), `CachingOptimized` and no viewer function, so anyone who holds an upload's URL can fetch it. [`add-data-gate-behaviors.sh`](../../scripts/infra/add-data-gate-behaviors.sh) then makes the same behavior members-only in place (see [Reads](#reads)). When `/uploads/*` already carries the `hfy-edge-gate` association, `add-uploads-behavior.sh` leaves it as it is and prints `no change`, so a rerun never ungates it.
- The bucket's upload CORS rule is applied by hand from [`site-bucket-cors.json`](../../infrastructure/cloudformation/site-bucket-cors.json), because no stack manages the bucket. It allows only `PUT` with `Content-Type` from the two site origins ([Architecture](architecture.md#site-bucket)).
- The next site deploy deletes any key that the site build does not produce and that no exclude in `ci.manifest.yaml` covers. The ETL sync touches only its six prefixes.
- Before HFY-R58, the API presigned uploads under `media/posts/`. Any object an API build of that era wrote is inside the ETL's `media` prefix, so a default media sync deletes it.

### Reads

| What | Read by | Access |
| --- | --- | --- |
| `person/*.json`, and every key under `family/`, `event/`, `note/`, `place/` and `media/` | Browsers, through CloudFront | Members only while the private data gate is attached. [`add-data-gate-behaviors.sh`](../../scripts/infra/add-data-gate-behaviors.sh) attaches `hfy-edge-gate` as the viewer-request function of `/person/*.json`, `/family/*`, `/event/*`, `/note/*`, `/place/*` and `/media/*`. A request then reaches the bucket only with a valid `io_id` session cookie ([`edge-gate/src/gate.mjs`](../../edge-gate/src/gate.mjs)). Any other request gets `401 {"error":"unauthenticated"}`, or a `302` to `/auth/login?returnTo=<path>` when it is a page navigation. Without the gate's behaviors (a new environment, or after `--remove`), these requests fall to the default behavior, unless another behavior, such as a legacy `/person/*`, matches first. On the default behavior, the repo's default-deny `HFYAppendIndex` answers them `404`, members included, and an older version of the function on LIVE passes them to S3. Whatever reaches S3 this way is served to anyone, and nothing validates the legacy `X-HFY-Session` header. |
| `uploads/posts/` | Browsers, through CloudFront | Members only once gated. `add-data-gate-behaviors.sh` gives `/uploads/*` the same `hfy-edge-gate` association and the same `401` and `302`, with `CachingDisabled` and the `hfy-uploads-private` policy. Ungated, as `add-uploads-behavior.sh` creates it and as `--remove` leaves it, an upload is public to anyone who holds its URL. |
| `person/index.html` and the rest of the Eleventy output | Browsers, through CloudFront | Public. The gate covers `/person/*.json`, not `/person/*`, because `/person/` is the public person-page shell. Under `person/`, `HFYAppendIndex` lets through only `/person/index.html`, which `/person/` and `/person` rewrite to. |
| Case, suffix and encoding variants of the private paths, such as `/Person/index.json`, `/FAMILY/<handle>.json`, `/person/<gramps-id>.JSON`, `/person/index.json/` or `/Uploads/<path>` | Nobody | CloudFront path patterns are case-sensitive and `/person/*.json` is anchored on its suffix, so these match no gated behavior. Where they reach the default behavior, its viewer-request CloudFront Function, `HFYAppendIndex` ([`scripts/cloudfront/append-index.js`](../../scripts/cloudfront/append-index.js)), answers each with `404` and `cache-control: private, no-store`, and never reaches S3. |
| `person/<gramps-id>.json` | `hfy-api`, from S3 directly, so the gate does not apply | `displayName` only, for author labels (HFY-R68). The role's `PersonRecords` statement in `app-stack.yaml` allows `s3:GetObject` on `person/*` in `MediaBucket`, and the role has no other read in the bucket. See [Consumers](#consumers). |

- `hfy-edge-gate` is a Lambda@Edge function in the `us-east-1` stack [`edge-gate-stack.yaml`](../../infrastructure/cloudformation/edge-gate-stack.yaml). It checks the cookie's RS256 signature against the auth edge's public JWKS, and its issuer, audience and expiry. It holds no secret: the issuer, audience and JWKS URL come from [`edge-gate/gate.config.json`](../../edge-gate/gate.config.json), baked into the zip.
- The production cutover attached the gate on 2026-10-12 (HFY-TSK-069, HFY-R67). Whether it is attached now is live state, which the repository does not record. A signed-out `curl -s -o /dev/null -w '%{http_code}' https://<site>/person/index.json` answers `401` while it is attached. Any other status means it is not: `200` when the request reaches S3, `404` when the default-deny `HFYAppendIndex` answers it. The same request for an existing upload, `https://<site>/uploads/posts/<ulid>/<name>`, answers `401` while `/uploads/*` is gated.
- The six data behaviors use `CachingDisabled` and the response headers policy `hfy-private-no-store`, which sets `Cache-Control: private, no-store` on every response. A gated `/uploads/*` uses `CachingDisabled` and `hfy-uploads-private`, which sets that header, `X-Content-Type-Options: nosniff` and the CSP `sandbox; default-src 'none'; img-src 'self'`, each with override. That CSP is the same string as in the app stack's `UploadsResponseHeadersPolicy`: `UPLOADS_CSP` in [`lib/cf-common.sh`](../../scripts/infra/lib/cf-common.sh) holds it, and [`test_app_stack.py`](../../scripts/infra/test/test_app_stack.py) checks that the two match. The script finds each policy by name, and creates it or puts it back when it no longer sets those headers.
- The gate's own `401` and `302` carry the same `Cache-Control`. Cloudflare proxies `<site>` in front of CloudFront and caches by file extension (images, SVG and PDF: most of `media/`, and member photos), so this header is what keeps a member's response out of Cloudflare's cache and out of browser caches. Responses Cloudflare stored before a path was gated, member photos included, stay there until their edge TTL ends or a purge removes them ([Cut over to authV2 and the private data gate](../how-to/cut-over-to-the-private-data-gate.md#4-optional-purge-cloudflare)).
- Members' photos load in the posts islands as plain same-origin `<img src>`, so the browser sends the `io_id` cookie the gate checks ([`islands/tests/uploads-gate.test.mjs`](../../islands/tests/uploads-gate.test.mjs)). A script that fetches a photo must pass `credentials: "same-origin"`.
- `HFYAppendIndex` matches on a normalized copy of the rewritten URI: percent-decoded up to four rounds, lowercased, backslashes turned into `/`, `;params` stripped, dot segments resolved, and trailing dots and spaces trimmed. It denies when the first segment is `family`, `event`, `note`, `place`, `media` or `uploads`. Under `person/` it denies any `.json` and any path not in `PUBLIC_PERSON_FILES`. While the gate is attached, a real request for private data matches its gated pattern first and never reaches the function. It may be associated only with the default behavior: on a gated behavior it would deny the data itself. [`scripts/cloudfront/test/append-index.test.mjs`](../../scripts/cloudfront/test/append-index.test.mjs) pins its deny list to the gate script's patterns and `PUBLIC_PERSON_FILES` to the files in `11ty/person/`, so a new public file there must be added to that list. Code changes go out through [`publish-append-index.sh`](../../scripts/infra/publish-append-index.sh) ([Publish the CloudFront function](../how-to/publish-the-cloudfront-function.md)), which refuses while the function is associated with any other behavior.
- `add-data-gate-behaviors.sh --remove` deletes exactly the six data behaviors that carry an `hfy-edge-gate` association. It then puts `/uploads/*` back in place, never deleting it: no Lambda association, `CachingOptimized` and the app stack's `UploadsResponseHeadersPolicyId`. Afterwards member photos are public to anyone who holds a URL, and the six data paths are ungated as the first row of the table describes: public where they reach S3, and a `404` for everyone where the default-deny `HFYAppendIndex` answers them. Both `hfy-private-no-store` and `hfy-uploads-private` stay in the account, unused. The policy to restore comes from `--restore-uploads-policy-id`, or else from the `--app-stack` output (see `<app-stack>` in [Placeholders](#placeholders)).

## Data contract

The ETL writes the files below, and the site reads them in the browser after sign-in. Examples use synthetic values only. Where a sanitized sample in the repository disagrees with this section, this section matches the ETL code and the sample is out of date (see [In-repo sanitized samples](#in-repo-sanitized-samples)).

### Person record: `person/<gramps-id>.json`

Written by `export_person_data.py`. `familyTreeMedia` is added afterwards by `build_family_tree_media.py --attach`.

| Key | Shape | Notes |
| --- | --- | --- |
| `grampsId` | string | `<gramps-id>`. Also the file name. |
| `handle` | string | The Gramps internal handle. |
| `displayName`, `givenName`, `surname` | string | From the primary name. `displayName` is `"<given> <surname>"`, or `"Unknown"` when both are empty. |
| `gender` | string | `female`, `male` or `unspecified`. |
| `isLiving` | boolean | `true` when Gramps has no death event for the person. Resolved relative stubs carry it too. |
| `lifespan` | object | `{birth: {year, place}, death: {year, place}, summary}`. `place` is a place summary or `null`. `summary` is `"1900–1980"`, `"1900–"`, `"–1980"` or `""`. |
| `events` | array | Sorted by date. Each item: `handle`, `grampsId`, `label`, `type: {string, code}`, `date: {text, sortValue, year}`, `place`, `description`. |
| `familyTree` | object | `{parentFamilies, spouseFamilies}`. Each family: `handle`, `grampsId`, `father`, `mother` (`null` when absent), `children`. Each relative is one of two stubs. A resolved relative has `handle`, `grampsId`, `displayName`, `isLiving`, `gender` and `lifespan`, where `lifespan` is `{birth: {year}, death: {year}, summary}` with no `place`. A relative the ETL could not resolve (no person record, or no primary name) is `{handle}` alone. |
| `mediaGallery` | array | Media items in the shape below. A reference to a media object that is missing from the database is written as `{handle, title: null, missing: false, checksum: null, size: null}`. The export first marks it `missing: true`, then its media-metadata pass overwrites `missing`, `checksum` and `size` from the exported media records, and a dangling handle has none. So `missing: true` never marks a dangling reference. Only `title: null` and the absence of `s3Key` and `mime` do. |
| `primaryPhoto` | object or `null` | The first `mediaGallery` item, including the dangling-reference stub when that item is one. |
| `notes` | array | Each item: `handle`, `grampsId`, `raw` (text) and `html` (rendered from Gramps styled text). |
| `familyTreeMedia` | object | `{path: "tree_<gramps-id>.svg", mime: "image/svg+xml"}`. Present only after `--attach`. |

```json
{
  "grampsId": "<gramps-id>",
  "handle": "<handle>",
  "givenName": "Ada",
  "surname": "Example",
  "displayName": "Ada Example",
  "gender": "female",
  "isLiving": false,
  "lifespan": {
    "birth": { "year": 1900, "place": { "handle": "<handle>", "grampsId": "P9001", "displayName": "Sample Town", "latitude": null, "longitude": null } },
    "death": { "year": 1980, "place": null },
    "summary": "1900–1980"
  },
  "events": [
    {
      "handle": "<handle>",
      "grampsId": "E9001",
      "label": "Birth",
      "type": { "string": "Birth", "code": 12 },
      "date": { "text": "1900", "sortValue": 2415021, "year": 1900 },
      "place": null,
      "description": null
    }
  ],
  "familyTree": {
    "parentFamilies": [
      {
        "handle": "<handle>",
        "grampsId": "F9001",
        "father": {
          "handle": "<handle>",
          "grampsId": "<gramps-id>",
          "displayName": "Sam Example",
          "isLiving": false,
          "gender": "male",
          "lifespan": { "birth": { "year": 1870 }, "death": { "year": 1940 }, "summary": "1870–1940" }
        },
        "mother": { "handle": "<handle>" },
        "children": []
      }
    ],
    "spouseFamilies": []
  },
  "mediaGallery": [],
  "primaryPhoto": null,
  "notes": [ { "handle": "<handle>", "grampsId": "N9001", "raw": "Synthetic note.", "html": "<p>Synthetic note.</p>" } ],
  "familyTreeMedia": { "path": "tree_<gramps-id>.svg", "mime": "image/svg+xml" }
}
```

In the example, `father` is a resolved relative and `mother` is an unresolved one.

### Media record: `media/<handle>.json`

The same shape appears in a person's `mediaGallery` and `primaryPhoto`.

```json
{
  "handle": "<handle>",
  "grampsId": "O9001",
  "title": "Synthetic photo",
  "mime": "image/jpeg",
  "sourcePath": "<path on the maintainer's machine>",
  "s3Key": "media/<handle>.jpg",
  "placeholderImage": "https://placehold.co/600x800?text=O9001",
  "missing": false,
  "checksum": "<sha-256 hex>",
  "size": 123456
}
```

- `title` is the Gramps description, or the Gramps ID when there is none.
- `sourcePath` is the file's path in the maintainer's Gramps media directory. It ships inside person records, so local directory and file names are visible to every signed-in member.
- `placeholderImage` is a third-party URL that contains the media's Gramps ID. `person-page.js` loads it when the media image fails to load.
- `missing` is `true`, with `checksum` and `size` `null`, when the media object exists in Gramps but its binary was not found at export.

### Manifests and search index

| File | Shape | Written by |
| --- | --- | --- |
| `person/index.json` | `{count, generatedAt, people: [...]}`. Each entry: `handle`, `grampsId`, `displayName`, `givenName`, `surname`, `isLiving`, `birthYear`, `deathYear`, `lifespanSummary`, `primaryPhoto` (a string: the `s3Key`, else the `placeholderImage`). | `build_search_index.js`. `export_person_data.py` first writes the same entries as a bare array, and both readers accept either form. |
| `person/search-index.json` | `{generatedAt, documents: [{grampsId, searchText}]}`. `searchText` is the lowercased display name, given name, surname, Gramps ID, birth year and lifespan summary. | `build_search_index.js` |
| `media/index.json` | Array of `{handle, grampsId, s3Key, checksum, size, missing}` | `export_person_data.py` |
| `place/index.json` | Array of `{handle, grampsId, displayName}` | `export_person_data.py` |

`lifespanSummary` exists only in the manifest. The person record carries `lifespan.summary`.

### Consumers

| Consumer | Reads | Fields it depends on |
| --- | --- | --- |
| [`11ty/js/person-page.js`](../../11ty/js/person-page.js) | `person/<gramps-id>.json`, media binaries, the tree SVG | All person keys. It hides the death details when `isLiving` is `true`, inserts `notes[].html` as-is, and builds media URLs from `s3Key`, else from `handle` and `mime`. |
| Search island: [`islands/src/islands/search.jsx`](../../islands/src/islands/search.jsx) through [`islands/src/lib/people-corpus.js`](../../islands/src/lib/people-corpus.js) | The same two files | The same manifest fields. It derives surname and given name from `displayName`, and years from `lifespanSummary`. |
| Person island: [`islands/src/islands/person.jsx`](../../islands/src/islands/person.jsx) (`personV2`) | `person/<gramps-id>.json` | `notes[].raw` only, rendered as Markdown under the kit's user-content policy. |
| `<project>/scripts/search/build_search_index.js` | Every person record in its directory | `handle`, `grampsId`, `displayName`, `givenName`, `surname`, `isLiving`, `lifespan.birth.year`, `lifespan.death.year`, `lifespan.summary`, `primaryPhoto.s3Key`, `primaryPhoto.placeholderImage`. |
| `hfy-api` author labels: `createLabelResolver` in [`api/src/labels.js`](../../api/src/labels.js), wired in [`api/src/index.js`](../../api/src/index.js) | `person/<gramps-id>.json` of the signed-in member or MCP caller, from `MEDIA_BUCKET` | `displayName` only (HFY-R68). It becomes `author.label` when the session's or access token's `name` is not a usable label, and the label is never an email address. A found label is cached for 1 h per container, a missing record or unusable `displayName` for 1 min, and any other failure for 5 s. Without a usable `displayName` the label is the `<gramps-id>`. |

The committed [`11ty/_data/flags.json`](../../11ty/_data/flags.json) ships `authV2` as `true`, so a site serves it off only after a rollback to an older artifact, a revert of the flip or an edit of `flags.json`. A `?hfy_flags=-authV2` preview override turns it off in one browser tab, and a page that cannot load `/_data/flags.json` treats it as off. The legacy `X-HFY-Session` header is gone (HFY-TSK-317). The browser readers' JSON and tree SVG requests go through `HFYFeatureFlags.dataFetch` in [`11ty/js/feature-flags.js`](../../11ty/js/feature-flags.js) with `credentials: "same-origin"`, and images load from the same origin, so the browser sends the `io_id` cookie that the gate checks. With `authV2` on, a gate `401` leads to one `POST /auth/refresh` and one retry (HFY-R66); with it off, nothing refreshes the cookie. The production flip to `authV2` ran on 2026-10-12 (HFY-TSK-069). To see which path a site serves now, run `curl -s https://<site>/_data/flags.json | jq .authV2`. See [Front end](front-end.md).

## Out-of-repo tooling

These scripts live under `<project>/scripts/`, outside the repository. The synopses below come from each script's argument parser, and the parser is authoritative where the two drift apart. Older notes show flags these scripts do not accept, including `--gramps-db`, `--force`, `--skip-media`, `--verbose`, `--bucket` and `--include-relatives`. The run order is in [Sync Gramps with the website](../how-to/sync-gramps-with-the-website.md).

### export_person_data.py

```text
python3 <project>/scripts/etl/export_person_data.py --output DIR [--db PATH] [--person-id ID]... [--limit N] [--dry-run]
```

- Reads the Gramps SQLite database. `--db` defaults to the first of these paths that exists, in this order (`_discover_db_candidates` in `<project>/scripts/etl/common.py`):
  1. `HFY_GRAMPS_DB`, when set.
  2. Each `sqlite.db` under the macOS Gramps database root, `~/Library/Application Support/gramps/grampsdb`, newest database directory first by modification time.
  3. The same under the Linux root, `~/.local/share/gramps/grampsdb`.
  4. A fixed legacy database path under the Linux root. When nothing exists, this path is still the default, and opening it fails.
- Writes `person/`, `family/`, `event/`, `note/`, `place/` and `media/` under `--output`. It copies media binaries as `<handle><ext>` with their SHA-256 and size, and writes the person, media and place manifests.
- `--person-id` may repeat. `--limit` applies after filtering. `--dry-run` writes nothing.
- It rewrites every person record it exports, which removes `familyTreeMedia` until `build_family_tree_media.py --attach` runs again.

### build_family_tree_media.py

```text
python3 <project>/scripts/etl/build_family_tree_media.py [--db PATH] [--person-dir DIR] [--media-dir DIR] [--only ID...] [--attach]
```

- Needs Graphviz `dot` on the `PATH`.
- Writes `tree_<gramps-id>.svg` into `--media-dir` for each person in `--person-dir`, or only those named by `--only`. `--attach` adds `familyTreeMedia` to each person record.
- `--person-dir` and `--media-dir` default to `<project>/workspace/harrisonfamily-frontend/person` and `.../media`, the sanitized workspace. A run that omits either works on sample data, not the real tree.

### export_person_bundle.py

```text
python3 <project>/scripts/export_person_bundle.py [--db PATH] [--glob-root DIR] [person_json ...]
```

- Lives in `<project>/scripts/`, not `<project>/scripts/etl/`.
- Takes raw Gramps person exports (`gramps_person_*.json` from `<project>/scripts/export_gramps_person.py`). With no positional arguments it globs `--glob-root`, which defaults to `reports` in the current directory.
- Writes a `<gramps-id>/` directory beside each input with the raw records it references. An inspection aid, not part of the publish path. Its output is private.

### sync_to_s3.py

```text
python3 <project>/scripts/etl/sync_to_s3.py [--source DIR] [--destination s3://BUCKET[/PREFIX]] [--prefix NAME]... [--profile NAME] [--dry-run] [--quiet] [--no-delete]
```

- `--source` defaults to `<project>/workspace-local/harrisonfamily-frontend`, and `--destination` to `s3://<site-bucket>`.
- `--prefix` may repeat. Choices: `event`, `family`, `note`, `place`, `media`, `person`. The default is all six. No choice reaches `uploads/` or the site files.
- Runs one `aws s3 sync` per prefix. It excludes `.DS_Store` and `Thumbs.db`, and for `person` also `index.html`.
- **Deletes by default.** `--no-delete` drops the `--delete` flag. A prefix with no local directory is skipped with a warning, so nothing under it is deleted.
- `--dry-run` passes `--dryrun`, and `--quiet` passes `--only-show-errors`. Without `--quiet`, the output lists object keys, which fall under the citation rule above.

### build_search_index.js

```text
HFY_PERSON_DIR=DIR node <project>/scripts/search/build_search_index.js
```

- Reads every `*.json` in `HFY_PERSON_DIR` except `index.json`, `search-index.json` and `search-store.json`. Overwrites `index.json` and `search-index.json` in the same directory.
- Without `HFY_PERSON_DIR` it uses `<project>/workspace/harrisonfamily-frontend/person`, the sanitized workspace. The `build:search` script in `<eleventy-source>` runs it that way, and that project's `build` and `dev` scripts run `build:search` first.

### publish_allowlists.sh

```text
<project>/scripts/infra/publish_allowlists.sh
```

- Takes no arguments. Checks that `<project>/docs/dev/userGrampsID.json` and `<project>/docs/dev/harrisonfamily-allowlist.json` exist, and stops if either is missing.
- Uploads the map to `config/userGrampsID.json`, the file the auth edge reads, and does nothing else. It does not validate the map, and it reads nothing from the email array.
- The upload uses `aws s3 cp --acl private`, so the caller needs `s3:PutObjectAcl` as well as `s3:PutObject`.
- It does not write `config/admins.json` or `config/groups.json`, and it keeps no audit log.
- History: until 2026-10-14 the script also read `HFY_ALLOWLIST_HMAC_SECRET` from Secrets Manager, uploaded HMAC digests of the array to `config/allowed_hashes.json`, and added a version of the array to the Google secret `harrisonfamily-allowlist`. Ruling P2-R51 removed both steps, after the digests' only reader, the `hfy-check-allowed` Lambda, and the Google secret had been deleted (HFY-TSK-326, HFY-TSK-325). The overrides for those steps, `HFY_ALLOWED_HASHES_KEY`, `HFY_HMAC_SECRET_NAME` and `HFY_GCP_SECRET_NAME`, went with them. A copy of the old script is kept beside it, outside the repository.

| Environment override | Default |
| --- | --- |
| `AWS_PROFILE` | `default` |
| `AWS_REGION` | `us-west-2` |
| `HFY_CONFIG_BUCKET` | `<config-bucket>` |
| `HFY_USER_GRAMPS_KEY` | `config/userGrampsID.json` |

### mint_test_id_token.py

```text
python3 <project>/scripts/auth/mint_test_id_token.py [--json]
```

- Reads `HFY_GOOGLE_CLIENT_ID`, `HFY_GOOGLE_CLIENT_SECRET` and `HFY_GOOGLE_REFRESH_TOKEN` from the environment and exchanges the refresh token for a fresh Google ID token.
- Prints the `id_token` on stdout, or the whole token response with `--json`. The printed token is a live credential for an allowlisted Google account.
- Nothing in the repository runs it any more: the `login-flow` spec that read its output through `HFY_MINT_HELPER` was deleted with the legacy sign-in (HFY-TSK-317).

## Access configuration in `<config-bucket>/config/`

| Key | Format | Read by | Cache and failure behavior | Written by |
| --- | --- | --- | --- | --- |
| `userGrampsID.json` | Object keyed by `<email>`. Each value is `"<gramps-id>"`, or `{"gramps_id": "<gramps-id>", "label": "…", "roles": ["…"]}`. | Auth edge sign-in and password provisioning, through the manifest's `s3_allowlist` resolver ([`auth/edge.manifest.json`](../../auth/edge.manifest.json), [`auth/src/cognito.js`](../../auth/src/cognito.js)); auth edge MCP membership ([`auth/src/membership.js`](../../auth/src/membership.js)) | Sign-in: cached for `cacheSeconds: 300`, email matched case-insensitively. If a refresh fails it keeps serving the last good copy and retries on the next request; if no copy has ever loaded, the failed read denies sign-in (fails closed). Membership: 60 s; on a read failure it keeps the last good copy and retries in 5 s, and it fails closed if no copy was ever loaded. | `publish_allowlists.sh` |
| `admins.json` | Array of `<gramps-id>` strings, or `{"admins": [...]}` | `hfy-api` ([`api/src/auth.js`](../../api/src/auth.js)), for the `admin` flag on the HTTP API; auth edge MCP membership, for the `admins` token group | 60 s in both. If the API cannot read it, nobody is an admin and it retries in 5 s. If the membership reader cannot, no token gets the `admins` group. The file may be absent, which means no moderators: every read fails, and the API logs `admin list unavailable (failing closed)` at most once every 5 s per container. | No script. Uploaded by hand. |
| `groups.json` | `{"version": 1, "groups": {"mcp-authors": {"emails": [...], "subjects": [...]}, "hfy-admin": {"subjects": [...]}}}`. `subjects` are `<gramps-id>` strings and `emails` are `<email>` strings. The shape is documented in [`api/src/policy.js`](../../api/src/policy.js). | `hfy-api`, for MCP calls only (`createGroupResolver` in `policy.js`, wired in [`api/src/index.js`](../../api/src/index.js)) | Cached for 60 s. A failed read or a body that is not JSON grants no groups to anyone and drops any copy loaded earlier (fails closed), and the read is retried after 5 s. A missing group or list grants nothing. | No script. Written by hand. |

```json
{
  "member-one@example.com": "<gramps-id>",
  "member-two@example.com": { "gramps_id": "<gramps-id>", "label": "Member Two", "roles": ["editors"] }
}
```

```json
{ "admins": ["<gramps-id>"] }
```

```json
{
  "version": 1,
  "groups": {
    "mcp-authors": { "emails": ["member-one@example.com"], "subjects": ["<gramps-id>"] },
    "hfy-admin": { "subjects": ["<gramps-id>"] }
  }
}
```

- The auth edge is the only reader of `userGrampsID.json`, and it accepts both entry forms and matches keys case-insensitively. The legacy Lambda, which returned an object entry whole as the Gramps ID and matched keys exactly, no longer exists.
- `allowed_hashes.json`, the array of HMAC-SHA256 digests that only that Lambda read, was deleted on 2026-10-14 (ruling P2-R51), and `publish_allowlists.sh` no longer writes it. The bucket is versioned, so a delete marker stands in its place and the deletion can be reversed.
- `roles` adds group names to MCP tokens. `members` is added for every allowlisted member and `admins` for every Gramps ID in `admins.json`. These token groups decide whether `/auth/authorize` and `/auth/token` issue a token at all (a subject not on the allowlist gets none), and `/auth/userinfo` returns them.
- The MCP server ignores the token's `groups` claim. It authorizes each call from `groups.json` alone, so `admins.json` plays no part there, and an `hfy-admin` subject need not be on it. An `mcp-authors` `emails` entry matches the access token's `email` claim, case-insensitively, unless the token's `email_verified` claim is `false`; `hfy-admin` matches `subjects` only. See [MCP server: Groups](mcp-server.md#groups).
- The auth edge reads the allowlist from the bucket and key in `edge.manifest.json`, and the admin list from the same bucket under `ADMIN_LIST_KEY` (the `AdminListKey` parameter). The `ConfigBucket` and `AllowlistKey` parameters only scope its read permission. When they disagree with the manifest, the read is denied and sign-in fails closed. `hfy-api` reads `ADMIN_LIST_BUCKET` and `ADMIN_LIST_KEY`, set from `ConfigBucket` and `AdminListKey`.
- `hfy-api` reads `groups.json` from `GROUPS_BUCKET` and `GROUPS_KEY`. The stack sets neither, so the code defaults apply: `<config-bucket>` and `config/groups.json`. The role's `AdminList` statement allows `s3:GetObject` on `config/*` in `ConfigBucket`, so the read succeeds only while `ConfigBucket` is that same bucket.

### Where the private source copies live

Every path below is outside the repository. Docs name these files and directories; they never quote what is in them.

| Asset | Private location | Published to |
| --- | --- | --- |
| Gramps database | The Gramps database directory on the maintainer's machine | Never published |
| Family data | `<project>/workspace-local/harrisonfamily-frontend/` | `<site-bucket>` data prefixes, by `sync_to_s3.py` |
| ETL working output | `<project>/workspace-local/etl-output/`, by convention | Not published directly |
| Raw Gramps exports and inspection bundles | `<project>/reports/`, the default `--glob-root` of `export_person_bundle.py` when run from `<project>`. It also holds Gramps metadata reports. | Never published |
| Email-to-Gramps-ID map and email array | `<project>/docs/dev/userGrampsID.json`, `<project>/docs/dev/harrisonfamily-allowlist.json`; a second copy of the array in `<project>/workspace-local/docs-dev/` | The map only: `config/userGrampsID.json`, by `publish_allowlists.sh` (from `<project>/docs/dev/` only). The array is not published; the script only checks that it exists. |
| Member email CSV | `<project>/docs/dev/initial_allowlist.csv` | Not read by any script |
| Local digest array | `<project>/workspace-local/allowlist/allowed_hashes.json` | Not written or read by any script. A leftover of the digest list retired on 2026-10-14 (ruling P2-R51). |
| Admin list | None | `config/admins.json`, by hand |
| MCP groups config | None | `config/groups.json`, by hand |
| OAuth client files | `oauth_harrisonfamily*.json` and `oauth_harrisonfamily*.txt`, in both `<project>/docs/dev/` and `<project>/workspace-local/docs-dev/` | Not published |
| Google service account key | `<project>/docs/dev/github-actions-service-account.json`, a JSON key file that contains a private key | By its name, the local copy of the `GCP_SERVICE_ACCOUNT_KEY` repository secret. If it holds a key of the `github-actions` service account, as its name says, that key no longer works: the account's only user-managed key was deleted on 2026-10-14. Remove the file. |
| gcloud CLI configuration | `<project>/workspace-local/gcloud-config/`, which includes `credentials.db`, `access_tokens.db` and `legacy_credentials/`. gcloud uses it only when `CLOUDSDK_CONFIG` points at it, and no script sets that. | Not published |
| Exported distribution configurations | `<project>/workspace-local/cloudfront/` (`original-config.json`, `updated-config.json` and a text file). An export taken after the origin-verify header was added holds that secret's value. | Not published |
| Pre-change distribution backups | `${HFY_CF_BACKUP_DIR:-${XDG_STATE_HOME:-~/.local/state}/hfy-infra/cloudfront}/<distribution-id>-<timestamp>-before.json`, written mode 600 by the `scripts/infra/add-*-behavior.sh` scripts and `add-data-gate-behaviors.sh` ([`lib/cf-common.sh`](../../scripts/infra/lib/cf-common.sh)) before each real update. Each is a whole distribution configuration, so each holds the origin-verify value. [`publish-append-index.sh`](../../scripts/infra/publish-append-index.sh) saves the function code it replaces in the same directory, mode 600: `HFYAppendIndex-LIVE-<timestamp>-before.js`, and a `-DEVELOPMENT-` copy when that stage held other code. Those hold function code only, no secret. | Not published |
| Maintainer notes | `<project>/docs/dev/`: plans, runbooks, dated session logs and a `debugging/` directory | Not published. Not read by any script. |

`publish_allowlists.sh` reads `<project>/docs/dev/`. A copy kept only in `workspace-local/docs-dev/` is never published. No generator produces the two JSON files from the CSV (there is no `generate_allowlist_artifacts.py`), so they are maintained by hand and the CSV can drift from them. Neither sign-in path admits an email without a Gramps ID, and `publish_allowlists.sh` writes no audit log.

## Secrets Manager

All are expected in `us-west-2`, the region the stack and the scripts default to.

| Secret name | Holds | Read by | Created by | Rotation |
| --- | --- | --- | --- | --- |
| `harrisonfamily/auth-edge/session-signing-key` | JSON `{privateKeyPem, kid}`, RSA-2048. A bare PKCS8 PEM is also accepted. | `hfy-auth-edge`, once per container at init ([`auth/src/index.js`](../../auth/src/index.js)) | [`scripts/infra/create-session-key.sh`](../../scripts/infra/create-session-key.sh) | [Rotate the session signing key](../how-to/rotate-the-session-signing-key.md) |
| `harrisonfamily/cloudfront/origin-verify` | A plain string: 32 random bytes as hex | CloudFront, as the `X-Origin-Verify` origin header that [`add-api-behavior.sh`](../../scripts/infra/add-api-behavior.sh) and [`add-mcp-behavior.sh`](../../scripts/infra/add-mcp-behavior.sh) write into the `hfy-api-origin` origin and [`add-auth-behavior.sh`](../../scripts/infra/add-auth-behavior.sh) writes into `hfy-auth-origin`; `hfy-api` and `hfy-auth-edge`, as `ORIGIN_VERIFY`, resolved into each Lambda's environment by a dynamic reference when the stack deploys | [`scripts/infra/create-origin-verify.sh`](../../scripts/infra/create-origin-verify.sh) | [Rotate the origin-verify secret](../how-to/rotate-the-origin-verify-secret.md) |
| `harrisonfamily/api/vapid`, the deployed name. The stack takes it in the `VapidSecretName` parameter, which is empty by default and then disables push. | JSON `{subject, publicKey, privateKey}`. [Turn on push notifications](../how-to/turn-on-push-notifications.md) creates it with an `https://` subject and refuses any other, and its [Verify](../how-to/turn-on-push-notifications.md#verify) step checks the stored subject. With an `https://` subject, no email address is sent to the push services. `hfy-api` passes the subject to `web-push` as given and does not check its form. | `hfy-api`, through `VAPID_SECRET`, on the first request in a container ([`api/src/index.js`](../../api/src/index.js)). A failed read disables push for the rest of that container's life. The public key is served to browsers. | By hand: [Turn on push notifications](../how-to/turn-on-push-notifications.md) | [Turn on push notifications](../how-to/turn-on-push-notifications.md#replace-the-key-pair). Browsers bind each push subscription to the public key, so a new key pair invalidates existing subscriptions. |

- Both creation scripts are idempotent, accept `--dry-run`, and never print the value. If the secret exists, they change nothing.
- The API, the MCP server and the data gate never read the signing key. They verify sessions and access tokens against the public JWKS that the edge publishes at `/auth/.well-known/jwks.json`.
- The resolved origin-verify value sits in each Lambda's environment configuration, in the distribution's origin configuration, and in every pre-change backup that the `add-*-behavior.sh` scripts and `add-data-gate-behaviors.sh` save (see [Where the private source copies live](#where-the-private-source-copies-live)). Anyone who can read any of these can read it. The scripts redact it from the diffs they print. A new secret value reaches the Lambdas only through a stack update that resolves the reference again; see the rotation how-to.
- `HFY_ALLOWLIST_HMAC_SECRET`, the HMAC key of the retired `allowed_hashes.json`, was scheduled on 2026-10-14 for deletion on 2026-11-13 (ruling P2-R51). Nothing reads it, and it can be recovered until that date.

## Google Cloud (legacy, deleted)

With io's approval, the Google Cloud pieces of the legacy allowlist were deleted on 2026-10-14 in the legacy Google Cloud project: the `getAllowlist` Cloud Function with its Cloud Run service, the Secret Manager secret below, and the only user-managed key of the `github-actions` service account that deployed the function. HFY-TSK-325 removed `deploy-gcf-legacy.yml` and the function source from the repository. No sign-in path ever used any of them.

| Name | Kind | State |
| --- | --- | --- |
| `harrisonfamily-allowlist` | Google Secret Manager secret: a JSON array of emails, which `getAllowlist` read | Deleted. `publish_allowlists.sh` no longer writes to it (ruling P2-R51). |
| `GCP_SERVICE_ACCOUNT_KEY` | GitHub repository secret: a JSON key of the `github-actions` service account, which `deploy-gcf-legacy.yml` used to deploy `getAllowlist` | The key is deleted on the service account, and no workflow reads the secret. |

With that key deleted, CI holds no working long-lived credential: the AWS side uses OIDC, and the client ID is public. The `github-actions` service account itself still exists, with no user-managed key. What is left are copies of the dead key: the `GCP_SERVICE_ACCOUNT_KEY` repository secret, which can be deleted in the repository settings, the local key file `<project>/docs/dev/github-actions-service-account.json`, and the gcloud credential stores in `<project>/workspace-local/gcloud-config/`.

## GitHub repository secrets

| Secret | Holds | Used by | Source of the value |
| --- | --- | --- | --- |
| `AWS_DEPLOY_ROLE_TO_ASSUME` | The ARN of the OIDC deploy role | [`io-kit-deploy.yml`](../../.github/workflows/io-kit-deploy.yml): the `deploy`, `invalidate` and `rollback_on_smoke_fail` jobs, through `aws-actions/configure-aws-credentials`. Named by `deploy.aws_role_secret` in `ci.manifest.yaml`. | The `DeployRoleArn` output of [`github-roles.yaml`](../../infrastructure/cloudformation/github-roles.yaml). The role trusts only the repository's `main` branch. |
| `HFY_GOOGLE_CLIENT_ID` | `<google-web-client-id>`, the public web client ID | No workflow. The build jobs read it until HFY-TSK-317 removed the client-ID patch step; the repository secret can stay or be deleted, because the `GoogleClientId` stack parameter is the copy that matters. | The Google Cloud console. The same value goes into the `GoogleClientId` stack parameter. |
| `GCP_SERVICE_ACCOUNT_KEY` | A Google service account key that no longer works. See [Google Cloud](#google-cloud-legacy-deleted). | No workflow. Its only reader, `deploy-gcf-legacy.yml`, was removed (HFY-TSK-325), so the repository secret can be deleted. | A key created on the `github-actions` service account, deleted there on 2026-10-14. `<project>/docs/dev/github-actions-service-account.json` is the on-disk copy. |

The deployed site, its Lambdas and CI use no Google client secret, and the Cognito app client is created without one. The only Google client secret in the system is `HFY_GOOGLE_CLIENT_SECRET`, which the test-token helper reads from a local shell. The rollback job also uses `github.token`, GitHub's per-run token, to download the previous release artifact. It is not a repository secret.

## Local-only tokens and environment variables

| Variable | Read by | Holds |
| --- | --- | --- |
| `CODEARTIFACT_AUTH_TOKEN` | [`api/.npmrc`](../../api/.npmrc), [`auth/.npmrc`](../../auth/.npmrc), [`islands/.npmrc`](../../islands/.npmrc); the `scripts/ci/` scripts that install `@io-kit/*`: `package-api.sh`, `package-auth.sh`, `build-islands.sh` and `mcp-conformance.sh` | A CodeArtifact token for the private `@io-kit/*` packages |
| `MCP_TOKEN` | [`scripts/mcp/token-smoke.sh`](../../scripts/mcp/token-smoke.sh) | An MCP access token, `<access-token>` |
| `ORIGIN_VERIFY` | `add-api-behavior.sh`, `add-auth-behavior.sh` and `add-mcp-behavior.sh`, when set (`cf_origin_verify` in [`lib/cf-common.sh`](../../scripts/infra/lib/cf-common.sh)). Otherwise they read the secret. | The origin-verify value |
| `EDGE401_ARN` | `add-mcp-behavior.sh`, when `--edge401-arn` is not given. Otherwise it reads the `hfy-mcp-edge401` stack output. | The numbered version ARN of `hfy-mcp-edge401`. Not a secret, but it contains `<aws-account-id>`. |
| `HFY_CF_BACKUP_DIR` | `lib/cf-common.sh`, for every real update by the `add-*-behavior.sh` scripts, `add-data-gate-behaviors.sh` and `publish-append-index.sh` | The directory for pre-change backups. Not a secret, but the distribution backups written there hold the origin-verify value. |
| `CF_ZONE_ID`, `CF_API_TOKEN` | The optional Cloudflare purge command in [Cut over to authV2 and the private data gate](../how-to/cut-over-to-the-private-data-gate.md#4-optional-purge-cloudflare). No script reads them. | The Cloudflare zone ID, and an API token with the Zone > Cache Purge permission. The token is a credential. The how-to reads it into the shell with `read -rs`, so it is never typed into a command or saved in the shell history, and it is never recorded. `curl` still receives it in its arguments while the purge runs, where other local users can see it in the process list. |
| `HFY_TEST_EMAIL`, `HFY_TEST_PASSWORD` | [`tests/login-flow/tests/auth-v2.spec.ts`](../../tests/login-flow/tests/auth-v2.spec.ts) | `<test-email>`, `<test-password>` |
| `HFY_GOOGLE_CLIENT_ID`, `HFY_GOOGLE_CLIENT_SECRET`, `HFY_GOOGLE_REFRESH_TOKEN` | `mint_test_id_token.py` (out of repository; nothing in the repository runs it now) | The OAuth client and a refresh token for an allowlisted Google account |
| `HFY_EXPECT_GRAMPS` | `tests/login-flow/tests/auth-v2.spec.ts` | The test member's `<gramps-id>`. Not a secret, but a real ID. |

- No value in this table belongs in a committed file or in printed output. The exception in the code is `HFY_EXPECT_GRAMPS`: the login-flow spec falls back to a committed default when it is unset, and that default is a real Gramps ID.
- xtrace (`set -x`) prints expanded commands, values included, so any shell that holds these values leaks them with xtrace on.
- The `scripts/infra/` scripts and `scripts/ci/build-islands.sh` do not print the values they handle. The CloudFront scripts' output does name the distribution and print Lambda version ARNs, which contain the account ID, so docs quote it only with `<distribution-id>` and `<aws-account-id>` in place of those values. `token-smoke.sh` does not print the token, but its output includes the token's `sub` (the member's real Gramps ID), its groups and its expiry, so that output is private in the same way as sync output. `mint_test_id_token.py` prints the token by design.
- The login-flow spec's HTML report and failure videos come from a signed-in session on the live site, so they are private. `tests/login-flow/.gitignore` ignores them.

## Runtime stores

Three stores hold private data created at runtime. None has a copy outside AWS.

| Store | Holds | Defined in |
| --- | --- | --- |
| DynamoDB table (`TableName`, default `hfy-app`) | Posts, comments, reactions and their `AUDIT#` items; push subscriptions and notification preferences; the auth edge's session refresh tokens and identity links; passkey credentials (`PASSKEY#<credential-id>`, each a public key keyed to a member's `sub` through `GSI1`, [`auth/src/passkeystore.js`](../../auth/src/passkeystore.js)) and passkey challenges (`PASSKEYCHAL#<challenge>`, expired through `ttl`); MCP OAuth records ([`auth/src/oauth.js`](../../auth/src/oauth.js)): authorization codes (`MCPCODE#`) and refresh tokens (`MCPRT#`), keyed by a SHA-256 of the code or token, which hold the member's `sub`, `email`, `amr`, `authTime` and display `name`, plus refresh-token rotation markers (`MCPRTUSED#`, `MCPFAM#`); forgot-password rate-limit counters, keyed by a hash so no email or IP is stored, and expired through the table's `ttl` attribute ([`auth/src/ratelimit.js`](../../auth/src/ratelimit.js)) | `app-stack.yaml`. Point-in-time recovery is on, and the table is retained on stack deletion. See [Member content design](../explanation/member-content-design.md) and [Identity services: Stored records](identity-services.md#stored-records). |
| Cognito user pool (`UserPoolName`, default `hfy-users`) | Email and password accounts. The pool is `AdminCreateUserOnly`. `hfy-auth-edge` creates a user ([`auth/src/cognito.js`](../../auth/src/cognito.js)) only when an allowlisted member sets a password (`POST /auth/link`), and Google and password sign-in for that email reach the same member. The same path confirms and repairs any user who signed up before the pool was locked down. | `app-stack.yaml`. Email goes out through Cognito's default sender, or through SES when the optional `SesIdentityArn` (and `SesFromAddress`) parameters are set. See [Identity services](identity-services.md). |
| CloudWatch Logs | `/aws/lambda/hfy-api`, among its other lines, holds one `mcp.audit` line per audited MCP tool call, with the caller's `sub` (a real `<gramps-id>`) and MCP groups, the tool, the outcome and the sign-in method and time ([MCP server: Audit](mcp-server.md#audit)). The data gate logs to `/aws/lambda/us-east-1.hfy-edge-gate` in the Region of each edge location that ran it: deny reasons such as `expired` or `bad-signature`, and JWKS fetch errors. Its lines carry no token, cookie, `sub` or path. | `/aws/lambda/hfy-api` is the `LogGroup` in `app-stack.yaml`, kept 30 days. The gate's role in `edge-gate-stack.yaml` may create its log groups; no stack defines them or sets their retention. |

An `mcp.audit` line names a real member, so `hfy-api` log output is private in the same way as sync output.

## In-repo sanitized samples

| Path | Mirrors | Notes |
| --- | --- | --- |
| [`allowlist/allowed_hashes.json`](../../allowlist/allowed_hashes.json) | `config/allowed_hashes.json`, deleted on 2026-10-14 (ruling P2-R51) | Two 32-character hex strings. Real digests are 64 characters, so these never match. Kept as a record of the retired format. |
| [`allowlist/harrisonfamily-allowlist.json`](../../allowlist/harrisonfamily-allowlist.json) | The email array that `publish_allowlists.sh` requires but does not read, and the format of the deleted Google secret | `example.com` addresses. |
| [`harrisonfamily-frontend/`](../../harrisonfamily-frontend/) | `<project>/workspace-local/harrisonfamily-frontend/` | One synthetic record per prefix, plus manifests. The shape predates the ETL: the person sample has `lifespanSummary` and `familyTree.families` in place of `lifespan`, `parentFamilies` and `spouseFamilies`; the media sample uses `mimeType` in place of `mime`; `person/index.json` is a bare array. It is not a valid fixture for the current contract. |
| [`etl-output/`](../../etl-output/), including `sample_bundle/` | `<project>/workspace-local/etl-output/` | READMEs only. No data. |
| [`cloudfront/distribution.json`](../../cloudfront/distribution.json) | The live distribution configuration before the `add-*-behavior.sh` scripts | A template with `example.com` aliases, one origin and the default behavior: the S3 origin, `s3-origin`, with an empty OAI and no OAC, and `CacheBehaviors` set to `{"Quantity": 0}`. Its placeholder API Gateway origin and the legacy `/api/*` behavior in front of it were removed with HFY-TSK-326, to match production. It has no `hfy-api`, `/auth/*`, `/uploads/*`, `/mcp*` or data-gate behavior, no Lambda@Edge association and no `X-Origin-Verify` header. |
| [`islands/tests/fixtures/person-synthetic.json`](../../islands/tests/fixtures/person-synthetic.json) | One person record | A synthetic person whose note holds hostile markup, for the sanitisation tests. Used by `islands/tests/person.spec.mjs`, `islands/tests/posts.spec.mjs` and `islands/tests/auth-continuity.spec.mjs`. |
| [`islands/tests/fixtures/person-legacy.json`](../../islands/tests/fixtures/person-legacy.json) | One person record, with relatives, media and a tree reference | Synthetic `I90xx` people, for `islands/tests/person-page.spec.mjs`, which tests the legacy person page. |
| [`islands/tests/fixtures/tree-synthetic.svg`](../../islands/tests/fixtures/tree-synthetic.svg) | A `tree_<gramps-id>.svg` from `build_family_tree_media.py` | Graphviz output in the ETL's attribute shape, with synthetic people and no family data. Used by `person-page.spec.mjs`. |
| [`islands/tests/fixtures/islands-look.json`](../../islands/tests/fixtures/islands-look.json) | The signed-in member, posts, comments, reactions and notification preferences as the API returns them, plus a person record and a person manifest | Made-up people and posts, for `islands-look.spec.mjs`, `qa-fixes.spec.mjs` and `qa2-fixes.spec.mjs`. |
| [`scripts/infra/test/fixtures/`](../../scripts/infra/test/fixtures/) | The live distribution configuration: `live-like.json`, and `live-with-uploads.json`, which adds the ungated `/uploads/*` behavior | Placeholder account IDs and no `X-Origin-Verify` header. Used by `scripts/infra/test/run.sh`. |
| [`gramps/tests/fixtures/`](../../gramps/tests/fixtures/) | A Gramps tree, as Gramps XML (`synthetic-tree.gramps`) and as one Gramps 6 `json_data` object per line (`synthetic-tree.jsonl`), with its media files | Generated by `make_synthetic_tree.py` under the bundled Gramps, with invented people, 555-01xx phones, example.org mail and documentation-style addresses. The two goldens are allowlisted and re-included by name in `.gitignore`; any other `.gramps`, `.jsonl` or database file there fails the guard. See [`gramps/README.md`](../../gramps/README.md). |
| [`gramps/tests/fixtures/render/`](../../gramps/tests/fixtures/render/) | The renderer's parity inputs, and the live ETL's output for them: `golden/legacy/` (one JSON file per rendered key) and `expected-deltas.json` | Written by `make_legacy_golden.py` from the fixture tree plus a few hand-written fictional objects (`parity.py`), with invented people and `example.org`-style values only. Only `.json` files, so the guard does not list them; the guard still fails on a `.jsonl`, `.gramps` or database file there. See [`gramps/README.md`](../../gramps/README.md#the-site-renderer). |

The samples are edited by hand in the repository, and no script copies workspace data into it (`export_workspace_samples.sh` was removed under D-03). `.gitignore` ignores every data directory except the tracked synthetic samples (the allowlist, including the Gramps fixture goldens, is the list), and [`scripts/ci/check-no-family-data.sh`](../../scripts/ci/check-no-family-data.sh) checks tracked files against [`scripts/ci/data-sample-allowlist.txt`](../../scripts/ci/data-sample-allowlist.txt) (path and sha256). [`scripts/sync_sanitized_assets.py`](../../scripts/sync_sanitized_assets.py) (`--sync`) creates placeholder files in `<project>/workspace/` for the private files under `workspace-local/allowlist/` and `workspace-local/cloudfront/`, and for `workspace-local/coming-soon-index.html`. It never copies real data, and it covers no other private tree. See [Refresh the sanitized samples](../how-to/refresh-the-sanitized-samples.md).

## Related pages

- [The privacy model for family data](../explanation/family-data-privacy.md): why these assets are private and how the pipeline boundary keeps them out of git.
- [The identity model](../explanation/identity-model.md) and [Identity services](identity-services.md): how the allowlist, the admin list and the signing key are used.
- [Edge and origin design](../explanation/edge-and-origin-design.md): the shared bucket, the origin-verify header, the data gate, the default-deny in `HFYAppendIndex` and the Cloudflare cache.
- [API reference](api.md): the upload route, the admin checks and the author label.
- [MCP server](mcp-server.md): the groups config, the access-token claims and the `mcp.audit` line.
- [Repository operations](repository-operations.md): the kit CI manifest and workflows, the CloudFront scripts, the hooks and the workspace helpers.
- [Theme and asset build](theme-and-asset-build.md): the build that writes the `hfy-asset-versions` blocks, the `hfy-theme` head blocks and the `?v=` versions.
- [Codebase map](codebase-map.md): where each of the paths above sits in the repository.
- [Sync Gramps with the website](../how-to/sync-gramps-with-the-website.md), [Manage family access](../how-to/manage-family-access.md), [Deploy the app stack](../how-to/deploy-the-app-stack.md), [Deploy the edge functions](../how-to/deploy-the-edge-functions.md), [Publish the CloudFront function](../how-to/publish-the-cloudfront-function.md), [Cut over to authV2 and the private data gate](../how-to/cut-over-to-the-private-data-gate.md), [Connect an MCP client](../how-to/connect-an-mcp-client.md), [Turn on push notifications](../how-to/turn-on-push-notifications.md), [Run the tests](../how-to/run-the-tests.md), [Diagnose sign-in and API failures](../how-to/diagnose-sign-in-and-api-failures.md).
