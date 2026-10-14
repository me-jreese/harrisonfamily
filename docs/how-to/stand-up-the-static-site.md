# How to stand up the static site and its deploy access

Use this page once per environment to set up the static hosting edge, the CI deploy access and the Google sign-in client. The hosting edge is the site bucket and its upload CORS rule, the certificate, the CloudFront distribution and its default behavior, the `HFYAppendIndex` CloudFront Function, and DNS. The deploy access is the GitHub OIDC deploy role and the repository secrets. It is also the first step when you adapt the repo for another family. For why the edge is shaped this way, read [Edge and origin design](../explanation/edge-and-origin-design.md).

A full environment is built in this order:

1. This page. Its [Verify](#verify) section runs the first site deploy.
2. [Deploy the edge functions](deploy-the-edge-functions.md): `hfy-mcp-edge401` and `hfy-edge-gate` in `us-east-1`. You test the gate's published version by invoking it with synthetic viewer-request events. Nothing is attached yet. The app stack page needs `hfy-mcp-edge401` before it can route `/mcp`, and the gate's checks pass before the auth edge exists.
3. [Manage family access](manage-family-access.md): publish the allowlist, `config/userGrampsID.json`, which the app stack page checks for before it deploys, and the MCP groups, `config/groups.json`. `config/admins.json` may stay absent, which means there are no moderators. That page's sign-in checks work only once the app stack is deployed.
4. [Deploy the app stack](deploy-the-app-stack.md): `hfy-api`, `hfy-auth-edge`, the `/auth/*`, `/api/*` and `/uploads/*` behaviors, a check of the upload CORS rule, and the MCP routing: `/mcp*` and the protected-resource metadata, with `hfy-mcp-edge401` on origin-response. From then on, members can sign in at `/auth/login`.
5. [Sync Gramps with the website](sync-gramps-with-the-website.md): the private Gramps data under the bucket's six data prefixes.
6. [Cut over to authV2 and the private data gate](cut-over-to-the-private-data-gate.md): attach the gate, which creates the six data behaviors and gates `/uploads/*` in place, then purge Cloudflare's copies of the gated paths. Start from that page's [Find your starting point](cut-over-to-the-private-data-gate.md#find-your-starting-point) checks. The committed [`flags.json`](../../11ty/_data/flags.json) sets `authV2` and the other five flags to `true`. Unless your copy changed that, the first deploy already shipped the `authV2` client, and the checks send you to its step 2: confirm the client, then attach the gate.
7. Optional: [Turn on push notifications](turn-on-push-notifications.md), and [Connect an MCP client](connect-an-mcp-client.md).

Every change to `11ty/` ships through [Deploy a site change](deploy-a-site-change.md), including the first deploy in [Verify](#verify). Part of `11ty/` is written by the islands build, which no workflow runs. A change under `islands/` therefore ships only once its rebuilt output is committed ([Build and preview the islands](build-and-preview-the-islands.md)).

> **Warning: in a new environment, the gate is attached last, in step 6.** This applies to a new environment only. On one that already serves visitors, the checks in [Find your starting point](cut-over-to-the-private-data-gate.md#find-your-starting-point) show where it stands. Until step 6, two things hold:
>
> - **Nobody can read the family data, members included.** The six data paths, `/person/*.json`, `/family/*`, `/event/*`, `/note/*`, `/place/*` and `/media/*`, have no behavior of their own yet, so requests for them reach the default behavior. There, `HFYAppendIndex` ([step 4](#4-create-and-attach-hfyappendindex)) answers `404` without reaching the bucket. The data is not exposed, but person pages, search and family photos fail.
> - **Member photos are public.** [Deploy the app stack](deploy-the-app-stack.md#6-serve-member-photos-under-uploads) creates the `/uploads/*` behavior ungated. Once members can sign in, they can post photos, and anyone who holds a photo's URL can read it. Cloudflare may store those photos too.
>
> Deploy and test the edge functions before you refresh the family data, run the cutover straight after the refresh, and purge Cloudflare as part of the cutover.

Values in angle brackets, such as `<site>`, `<site-bucket>`, `<config-bucket>`, `<app-stack>`, `<distribution-id>`, `<aws-account-id>`, `<github-owner>`, `<github-repo>` and `<google-web-client-id>`, are placeholders. Their forms are listed in [Private data and secrets](../reference/private-data-and-secrets.md#placeholders). Never commit the real values: keep filled-in copies of the samples outside the repository.

## Before you start

- You have admin credentials for the target AWS account, the AWS CLI v2, and `jq`.
- You have Node.js 20 or later, to run the `HFYAppendIndex` tests in [step 4](#4-create-and-attach-hfyappendindex). The tests list the checkout's tracked files with `git`.
- You control the DNS for `<site>`.
- `gh` is installed and authenticated with a token that has Secrets: write and Actions: write on the repository. Step 6, step 7 and [Verify](#verify) set secrets, start a workflow run and watch it.
- You have a Google account that can create a Google Cloud project and an OAuth client.
- You run every command from the root of a checkout. The CLI paths, such as `fileb://scripts/...`, are relative to that root.

### If you are adapting the repo for another family

Several files carry this environment's names, so a copy for another family needs edits before its first deploy. The distribution ID is known only after step 3. Edit your working copy before [step 6](#6-create-the-deploy-role-and-its-secret), and commit the edits. How each edit reaches the site:

- Edits to `11ty/`, `ci.manifest.yaml` and the workflows ship with [Deploy a site change](deploy-a-site-change.md). The run from that merge is the first deploy in [Verify](#verify).
- Edits under `islands/`, and edits to any script, stylesheet or manifest the pages reference (`11ty/js/`, `11ty/css/` and `11ty/manifest.webmanifest`), need the islands build before you commit. The build rewrites the outputs that carry your values and stamps a new `?v=` version on every changed file, including the manifest's, which it also stamps into `11ty/js/feature-flags.js` and `11ty/sw.js` ([Build and preview the islands](build-and-preview-the-islands.md)). `(cd islands && npm run check:islands)` fails until the committed output matches.
- Edits under `api/`, `auth/` and `edge-gate/` reach AWS only in the packages that [Deploy the app stack](deploy-the-app-stack.md) and [Deploy the edge functions](deploy-the-edge-functions.md) build from a clean checkout. That includes `auth/edge.manifest.json`, and the `theme.cssUrl` version that the islands build stamps into it.
- The islands build and the API and auth packages install the `@io-kit` packages from the private CodeArtifact registry that their `.npmrc` files name. You need read access to that registry.

| File | Values | Change to |
| --- | --- | --- |
| [`ci.manifest.yaml`](../../ci.manifest.yaml) | The `s3_static` target's `bucket` and `distribution`; the `smoke` URLs; `deploy.region` | `<site-bucket>`, `<distribution-id>` and `https://<site>/...`. The manifest has no Lambda target (HFY-TSK-317). Then re-render the workflows: [Change the CI pipeline](change-the-ci-pipeline.md). Never edit the rendered files directly. |
| [`github-roles.yaml`](../../infrastructure/cloudformation/github-roles.yaml) | Defaults of `GitHubOrg`, `GitHubRepo` and `OIDCProviderArn` | Pass your own values as `--parameter-overrides` in step 6, or edit the defaults |
| [`github-roles.yaml`](../../infrastructure/cloudformation/github-roles.yaml) | Bucket ARNs in `S3SiteSync` and `ProtectMemberUploads`; the distribution in `CloudFrontInvalidation`; the function ARNs in `LambdaDeploy` | `<site-bucket>`, `<distribution-id>`, and your function names and region |
| [`auth/edge.manifest.json`](../../auth/edge.manifest.json) | `site`, `authOrigin`, `cookieDomain`, `returnOrigins`, `idp.domain`, `session.issuer`, `session.audience`, `session.signingKeySecretName`, `resolver.bucket`, `theme.cssUrl`, `theme.fontOrigins`, the family-voice text of the sign-in pages in `copy`, and the passkey provider's `rpId`, `rpName` and `origins` | Your host name, issuer, audience, secret name, `<config-bucket>` and family name. In `theme.cssUrl`, change only the host, to `https://<site>/css/auth-edge.css`. The islands build stamps the `?v=` and stops while the host differs from `SITE_ORIGIN` in `islands/assets.mjs`. Keep `theme.fontOrigins` as `["self"]`, because the fonts are served from the site itself. Rewrite `copy` in your family's own voice: `subtitle`, `passkey_failed`, `denied_body`, `invalid_credentials`, `unconfirmed` and `generic_error` name this family or one of its contacts. For passkeys, set `rpId` to `<site>`, `rpName` to the family name a member's device shows when it saves a passkey, and `origins` to `https://<site>`. Set them before any member enrols a passkey, because a passkey works only for the `rpId` it was created under. Keep the session values in step with the `app-stack.yaml` parameters and `gate.config.json` below. |
| [`edge-gate/gate.config.json`](../../edge-gate/gate.config.json) | `issuer`, `audience`, `jwksUrl` | `session.issuer` and `session.audience` from `auth/edge.manifest.json`, and `<session.issuer>/.well-known/jwks.json`. The build bakes this file into the gate's zip, because Lambda@Edge has no environment variables, so a later change ships only as a new gate version ([Deploy the edge functions](deploy-the-edge-functions.md#ship-a-change-to-the-gate)). [`gate.test.mjs`](../../edge-gate/test/gate.test.mjs) fails while the two files disagree. |
| [`app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml) parameters | `ConfigBucket`, `MediaBucket`, `MediaPublicBase`, `SessionIssuer`, `SessionAudience`, `SessionJwksUrl`, `McpResources`, `SigningKeySecretName`, `OriginVerifySecretName` | Pass your values as `--parameter-overrides` in [Deploy the app stack](deploy-the-app-stack.md#4-deploy-the-stack), or edit the defaults |
| [`api/src/index.js`](../../api/src/index.js) defaults | `SESSION_JWKS_URL`, `SESSION_ISSUER` and `MEDIA_PUBLIC_BASE`; `GROUPS_BUCKET` and `ADMIN_LIST_BUCKET`; `MEDIA_BUCKET` | The `https://<site>/...` forms; `<config-bucket>`; `<site-bucket>`. The stack sets each of these as an environment variable except `GROUPS_BUCKET`. The API therefore reads `config/groups.json` from the `GROUPS_BUCKET` default, and its role may read only `<config-bucket>/config/*`. A wrong default leaves every MCP caller with an empty tool list. The other defaults are fallbacks, but keep them in step. |
| [`api/src/routes.js`](../../api/src/routes.js) and [`auth/src/oauth.js`](../../auth/src/oauth.js) | `MCP_RESOURCE` and `DEFAULT_MCP_RESOURCE` | `https://<site>/mcp`. `MCP_RESOURCE` is the resource the MCP server advertises and the token audience it accepts. The stack does not override it, so it must also be listed in `McpResources`, normally first: the auth edge refuses any other resource with `invalid_target`. `DEFAULT_MCP_RESOURCE` applies only when `McpResources` is empty. The client ID `mcp-harrisonfamily` can stay. To rename it, change `DEFAULT_CLIENT_ID` in `oauth.js` and the `MCP_CLIENT_IDS` default in [`api/src/mcp.js`](../../api/src/mcp.js) together. |
| `config/userGrampsID.json`, `config/groups.json` and `config/admins.json` in `<config-bucket>`, outside the repository | Your members' `<email>` and `<gramps-id>` values | Your own files, published with [Manage family access](manage-family-access.md). Never start from another environment's copies. `groups.json` takes the shape documented at the top of [`api/src/policy.js`](../../api/src/policy.js). Without it the MCP server fails closed and nobody gets MCP tools. `admins.json` may be absent, which means there are no moderators. |
| [`site-bucket-cors.json`](../../infrastructure/cloudformation/site-bucket-cors.json) | `AllowedOrigins` | `https://<site>` and `https://www.<site>`. Change `SITE_ORIGINS` in [`scripts/infra/test/run.sh`](../../scripts/infra/test/run.sh) with it: the test fails on any other origin. |
| [`check-site-bucket-cors.sh`](../../scripts/infra/check-site-bucket-cors.sh) | The `URL` default | `https://<site-bucket>.s3.<region>.amazonaws.com/uploads/posts/smoke/x.jpg`, with the `deploy.region` of `ci.manifest.yaml`. `scripts/infra/test/run.sh` fails while it names another bucket or Region than the manifest. |
| [`11ty/manifest.webmanifest`](../../11ty/manifest.webmanifest) | `name`, `short_name` | Your family's names for the installed app. Leave `background_color` and `theme_color` alone: the islands build writes them from the theme's surface colour. |
| [`islands/assets.mjs`](../../islands/assets.mjs) | `SITE_ORIGIN` | `https://<site>`. The build treats absolute URLs on this origin as the site's own files when it adds the `?v=` versions, and it versions `theme.cssUrl` only on this origin. |
| [`islands/copy.mjs`](../../islands/copy.mjs) | `HERO`, `TITLES`, `FOOTER` and `HERO_IMAGES`, and the fallback navbar wordmark in `applyCopy` | Your site name, host, page titles and hero photos. The module rewrites this family's old Eleventy copy on the committed pages until the Eleventy source carries the new copy, and [`copy.test.mjs`](../../islands/tests/copy.test.mjs) checks the result on every page. Change the module and the test together. |
| The site name in the islands and the repo-owned files | The shell's `title` and `hfy-bar__brand` in [`shell.jsx`](../../islands/src/islands/shell.jsx); the sign-in wordmark in [`auth-edge.css`](../../islands/src/auth-edge/auth-edge.css); the push title in `TEMPLATE_REGISTRY` in [`api/src/notify.js`](../../api/src/notify.js) and in `CATALOG` in [`notify-catalog.js`](../../islands/src/lib/notify-catalog.js), which repeats the push text word for word; the page title that [`person-page.js`](../../11ty/js/person-page.js) sets; the title of [`offline.html`](../../11ty/offline.html) | Your family's site name |
| The family-voice strings that name a family contact | `VOICE` in [`11ty/js/person-page.js`](../../11ty/js/person-page.js); `COPY` in [`posts-ui.jsx`](../../islands/src/lib/posts-ui.jsx) and [`comment-source.js`](../../islands/src/lib/comment-source.js); `SEARCH_COPY` in [`people-corpus.js`](../../islands/src/lib/people-corpus.js); `LABELS` and `LOAD_FAILED` in [`notifications.jsx`](../../islands/src/islands/notifications.jsx); `KIT_STRINGS` in [`auth/src/edge.js`](../../auth/src/edge.js); and the manifest `copy` keys above | Your own contact, or none. The auth edge test, the sign-in theme end-to-end test and the islands' browser specs check several of these strings, so change them with the source. |
| The `harrisonfamily` theme | The `@io-kit/tokens/harrisonfamily/...` imports and `tokensDir` in [`islands/build.mjs`](../../islands/build.mjs), the same imports in [`auth-edge.css`](../../islands/src/auth-edge/auth-edge.css), the HFY partials in [`islands/src/theme/`](../../islands/src/theme/), and the search colours in [`cloudscape-theme.js`](../../islands/src/lib/cloudscape-theme.js) | Keep them, or move to your own theme as in [Change the theme or brand fonts](change-the-theme-or-brand-fonts.md). [Theme and asset build](../reference/theme-and-asset-build.md) lists what the build writes from them. |
| [`scripts/cloudfront/append-index.js`](../../scripts/cloudfront/append-index.js) | `PUBLIC_PERSON_FILES` | The files of your `11ty/person/`. A test fails while the two differ. The header comment names this site's distribution, which has no effect on the code. |
| The `scripts/infra/` scripts | The `--distribution` default of the behavior scripts and of `publish-append-index.sh`; the `--stack` default, `hfy-app`, of `add-auth-behavior.sh`, `add-api-behavior.sh`, `add-uploads-behavior.sh` and `add-mcp-behavior.sh`; the `--app-stack` default of `add-data-gate-behaviors.sh`, also `hfy-app`; the secret-name defaults, `--secret-name` in the auth, API and MCP behavior scripts and `--name` in `create-session-key.sh` and `create-origin-verify.sh` | Pass `--distribution <distribution-id>`, `--stack <app-stack>` and `--secret-name` every time, as [Deploy the app stack](deploy-the-app-stack.md) does. Pass `--distribution <distribution-id>` to `publish-append-index.sh` too, from [step 4](#4-create-and-attach-hfyappendindex) on, and `--app-stack <app-stack>` to every `add-data-gate-behaviors.sh --remove`. A run without `--stack` reads the outputs of a stack named `hfy-app`. If your `SigningKeySecretName` or `OriginVerifySecretName` differs from the template default, also pass it as `--name` to the matching `create-*.sh` script. The `--stack` of `add-data-gate-behaviors.sh` names the `us-east-1` gate stack instead. Its default, `hfy-edge-gate`, is the name [Deploy the edge functions](deploy-the-edge-functions.md) gives it, as is `hfy-mcp-edge401`, the `--edge-stack` default of `add-mcp-behavior.sh`. `hfy-edge-gate` is also the `--gate-function-name` default of `add-uploads-behavior.sh`, which uses it to leave a gated `/uploads/*` alone. Keep those names, and never pass `--stack <app-stack>` to `add-data-gate-behaviors.sh`. |

The test suites pin several of these values. Examples are `gate.test.mjs`, the auth edge's manifest and passkey tests, and the OAuth tests' resource. [`auth/test/edge.test.js`](../../auth/test/edge.test.js) and [`scripts/infra/test/run.sh`](../../scripts/infra/test/run.sh) pin the host in `theme.cssUrl`, and `copy.test.mjs` pins the copy on the Eleventy pages. Update them with the source and run the suites ([Run the tests](run-the-tests.md)). To find a value the table misses, search the checkout for the current host, bucket names and site name. [Private data and secrets](../reference/private-data-and-secrets.md#placeholders) lists the files that carry `<site>`, `<site-bucket>` and `<config-bucket>`.

`11ty/` also carries the family's own pages and text, rendered from `<eleventy-source>`. Rebuild them from your own source with [Refresh the Eleventy output](refresh-the-eleventy-output.md). Run the islands build after every refresh. It rewrites the theme blocks in the page heads, which the Eleventy head partial emits with hard-coded values that go stale, and it puts back the family-voice copy and the `?v=` versions, which the Eleventy templates do not emit yet.

### Legacy pieces

The legacy Google sign-in is gone from the pages and the pipeline (HFY-TSK-317): no page loads it, and members sign in only through the auth edge once [Deploy the app stack](deploy-the-app-stack.md) has run. Its cloud pieces were deleted on 2026-10-14, and their source is gone from the repository: the `hfy-check-allowed` Lambda with its API Gateway (HFY-TSK-326, ruling P2-R48), and the `getAllowlist` Cloud Function with its Secret Manager secret and its deploy workflow (HFY-TSK-325). Once `/api/*` exists, a request to `/api/check-allowed` reaches `hfy-api`, which answers `404`. A new environment needs none of them, and nothing in Google Cloud besides the OAuth client in [step 7](#7-create-the-google-web-client). [Identity services](../reference/identity-services.md#retired-legacy-sign-in) records what they did, and [The identity model](../explanation/identity-model.md#retirement-order-once-authv2-is-flipped) gives the order in which they retired.

Keep `authV2` set to `true`, as committed. With it off, the pages do not refresh `io_id`, and there is no other sign-in.

The allowlist publisher in [Manage family access](manage-family-access.md#2-publish) needs no secret. It uploads `config/userGrampsID.json`, the list the auth edge reads, and nothing else. Its digest list, `config/allowed_hashes.json`, and the `HFY_ALLOWLIST_HMAC_SECRET` secret that keyed it were retired on 2026-10-14 (ruling P2-R51), so a new environment creates neither.

## Steps

### 1. Create the site bucket

Create the bucket in `us-west-2`, the region the deploy workflow uses, and turn on all four Block Public Access settings:

```sh
aws s3api create-bucket --bucket <site-bucket> --region us-west-2 \
  --create-bucket-configuration LocationConstraint=us-west-2
aws s3api put-public-access-block --bucket <site-bucket> \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

The bucket policy admits only the distribution, through Origin Access Control. It names the distribution, so you apply it at the end of step 3. Save this sample now as `bucket-policy.json`, outside the repository:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowCloudFrontOAC",
      "Effect": "Allow",
      "Principal": { "Service": "cloudfront.amazonaws.com" },
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::<site-bucket>/*",
      "Condition": {
        "StringEquals": {
          "AWS:SourceArn": "arn:aws:cloudfront::<aws-account-id>:distribution/<distribution-id>"
        }
      }
    }
  ]
}
```

The policy grants `s3:GetObject` and nothing else. A path with no object therefore returns `403`, not `404`, through CloudFront as well as directly. The deploy role writes to the bucket with its own IAM permissions, which this policy does not limit.

Then apply the bucket's CORS rule. Members' browsers upload the photos they attach to posts and comments straight to the bucket's S3 endpoint, with presigned `PUT` URLs that `hfy-api` issues. That endpoint is a different origin from the site, so without the rule the browser blocks every upload. The rule is in [`site-bucket-cors.json`](../../infrastructure/cloudformation/site-bucket-cors.json): `PUT` only, the `Content-Type` header only, from `https://<site>` and `https://www.<site>`. [Architecture](../reference/architecture.md#site-bucket) explains each part.

`put-bucket-cors` replaces the bucket's whole CORS configuration, so look at the current one first:

```sh
aws s3api get-bucket-cors --bucket <site-bucket>
```

A new bucket answers with a `NoSuchCORSConfiguration` error. If an existing bucket prints rules that are not in the file, find out what they are for before you replace them. The file is the bucket's whole CORS configuration, and [`scripts/infra/test/run.sh`](../../scripts/infra/test/run.sh) fails if it allows any method other than `PUT`, any origin other than the two site origins, or any header other than `Content-Type`. Apply the file as committed:

```sh
aws s3api put-bucket-cors --bucket <site-bucket> --cors-configuration file://infrastructure/cloudformation/site-bucket-cors.json
```

The command prints nothing when it succeeds. No stack manages the bucket, and the deploy role cannot change its CORS configuration, so apply the file again by hand whenever it changes. [Verify](#verify) checks the rule with the browser's preflight request, and so does every successful deploy run after that.

Last, expire the desktop sync's leftover staging blobs. The sync push routes upload every photo to `media/.staging/<handle>/<sha256>` first and delete it after the copy into `media/<handle><ext>`; a blob whose Media op was refused, or whose batch was abandoned, stays there, unreferenced and not served. [`site-bucket-lifecycle.json`](../../infrastructure/cloudformation/site-bucket-lifecycle.json) expires that prefix after 2 days and aborts incomplete multipart uploads after 1. `put-bucket-lifecycle-configuration` replaces the bucket's whole lifecycle configuration, so read the current one first and merge its rules into the file if it has any:

```sh
aws s3api get-bucket-lifecycle-configuration --bucket <site-bucket>
aws s3api put-bucket-lifecycle-configuration --bucket <site-bucket> --lifecycle-configuration file://infrastructure/cloudformation/site-bucket-lifecycle.json
```

A new bucket answers the first command with `NoSuchLifecycleConfiguration`. No stack manages the bucket, so apply the file by hand whenever it changes. The rule never touches the served keys: the prefix is `media/.staging/` only.

### 2. Request the certificate

CloudFront accepts certificates only from `us-east-1`, wherever the bucket is.

```sh
aws acm request-certificate --region us-east-1 \
  --domain-name <site> --subject-alternative-names www.<site> \
  --validation-method DNS --query CertificateArn --output text
```

Keep the printed `<certificate-arn>`. List the validation records, add each one at your DNS provider as a DNS-only CNAME, and wait for the certificate to be issued:

```sh
aws acm describe-certificate --region us-east-1 --certificate-arn <certificate-arn> \
  --query 'Certificate.DomainValidationOptions[].ResourceRecord' --output table
aws acm wait certificate-validated --region us-east-1 --certificate-arn <certificate-arn>
```

The validation records can take a minute to appear in the first command's output. Leave them in place, because ACM uses them to renew the certificate.

### 3. Create the distribution

Start from [`cloudfront/distribution.json`](../../cloudfront/distribution.json). The template is not ready to create as it stands: its origin has no Origin Access Control, it has no `CallerReference`, root object or headers policy, and its `Comment` is longer than the 128 characters CloudFront accepts. First create the two resources the distribution refers to.

**a. Create the Origin Access Control.**

```sh
aws cloudfront create-origin-access-control --origin-access-control-config \
  Name=<site-bucket>-oac,SigningProtocol=sigv4,SigningBehavior=always,OriginAccessControlOriginType=s3 \
  --query 'OriginAccessControl.Id' --output text
```

Keep the printed `<oac-id>`.

**b. Create the security-headers response policy.** Save this as `security-headers.json`. It sets four security headers: `Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options` and `Referrer-Policy`.

```json
{
  "Name": "<policy-name>",
  "Comment": "Security headers for the family site",
  "SecurityHeadersConfig": {
    "StrictTransportSecurity": { "Override": true, "AccessControlMaxAgeSec": 31536000, "IncludeSubdomains": true, "Preload": true },
    "ContentTypeOptions": { "Override": true },
    "FrameOptions": { "Override": true, "FrameOption": "DENY" },
    "ReferrerPolicy": { "Override": true, "ReferrerPolicy": "strict-origin-when-cross-origin" }
  }
}
```

`IncludeSubdomains` applies HTTPS-only to every subdomain of `<site>`. `Preload` only adds the directive. It takes effect once the domain is submitted to the browsers' preload list, and that is slow to undo. Drop either setting if it does not fit your domain.

```sh
aws cloudfront create-response-headers-policy \
  --response-headers-policy-config file://security-headers.json \
  --query 'ResponseHeadersPolicy.Id' --output text
```

Keep the printed `<headers-policy-id>`.

**c. Fill in a copy of the template.** Copy `cloudfront/distribution.json` outside the repository and make these changes. The template has one origin, the S3 origin, and only the default behavior: `CacheBehaviors` has `Quantity` `0`. Later steps add the other origins and behaviors, starting with [Deploy the app stack](deploy-the-app-stack.md). Every field in the table sits inside `DistributionConfig`, `CallerReference` included.

| Field | Template | Set to |
| --- | --- | --- |
| `CallerReference` | Absent | Any string unique to this request, such as `site-<yyyymmdd>` |
| `Comment` | A note of more than 128 characters about the sanitized sample | A short description of 128 characters or fewer, such as `Family site`. A longer one makes `create-distribution` fail with `InvalidArgument`. |
| `Aliases.Items` | `example.com`, `www.example.com` | `<site>`, `www.<site>` |
| `Origins.Items[0].DomainName` | `example-bucket.s3.amazonaws.com` | `<site-bucket>.s3.us-west-2.amazonaws.com` |
| `Origins.Items[0].OriginAccessControlId` | Absent | `<oac-id>`. Keep `S3OriginConfig` with its empty `OriginAccessIdentity`; an S3 origin that uses OAC needs both. |
| `DefaultRootObject` | Absent | `index.html` |
| `DefaultCacheBehavior.ResponseHeadersPolicyId` | Absent | `<headers-policy-id>` |
| `ViewerCertificate.ACMCertificateArn` | Placeholder | `<certificate-arn>` |

Keep the rest of the template as it is. That includes `PriceClass_100`, `redirect-to-https`, compression, GET and HEAD only, and cache policy `658327ea-f89d-4fab-a63d-7e88639e58f6` (the managed CachingOptimized policy).

**d. Create the distribution and wait for it.**

```sh
aws cloudfront create-distribution --cli-input-json file://<path-to-copy>/distribution.json \
  --query 'Distribution.[Id,DomainName,ARN]' --output text
aws cloudfront wait distribution-deployed --id <distribution-id>
```

Keep the ID as `<distribution-id>` and the domain name, which ends in `cloudfront.net`, for step 5.

**e. Admit the distribution to the bucket.** Put the distribution ID and account ID into `bucket-policy.json` from step 1, then apply it:

```sh
aws s3api put-bucket-policy --bucket <site-bucket> --policy file://bucket-policy.json
```

### 4. Create and attach HFYAppendIndex

`HFYAppendIndex` is the CloudFront Function on the default behavior's viewer-request event. Its source is [`scripts/cloudfront/append-index.js`](../../scripts/cloudfront/append-index.js), and it does two things:

- **Clean URLs.** It appends `index.html` to a URI that ends in `/`, and `/index.html` to a URI with no `.`. Without it, a clean URL such as `/about/` returns `403`.
- **Default-deny of the private paths.** It answers `404` with `cache-control: private, no-store`, without reaching the bucket, when the first path segment is `family`, `event`, `note`, `place`, `media` or `uploads`, and for anything under `person/` other than the public person-page shell, `/person/index.html`. It percent-decodes and lowercases the URI and resolves dot segments first, so variant spellings such as `/Person/index.json` are refused too.

Until the cutover attaches the gate, the exact data paths reach the function as well, so it refuses them to everyone (see the warning at the top of this page). Once the gate's behaviors exist, real requests for the data match them first, and only variant spellings reach the function. [Architecture](../reference/architecture.md#hfyappendindex) lists the rules, and [Edge and origin design](../explanation/edge-and-origin-design.md#why-the-cloudfront-function-also-denies) explains why the function denies.

You create the function and attach it once, here. [`publish-append-index.sh`](../../scripts/infra/publish-append-index.sh) never creates a function. After this step, publish every code change with that script, as in [Publish a change to the CloudFront Function](publish-the-cloudfront-function.md), not with raw `update-function` and `publish-function` commands. The script tests the code on the function's `DEVELOPMENT` stage before it publishes, and it saves the previous code. On a distribution that already serves visitors, do not use this step: follow that page instead. [`AGENTS.md`](../../AGENTS.md) lists the production operations that need io's go-ahead.

1. **Run the function's tests.**

   ```sh
   node --test scripts/cloudfront/test/*.test.mjs
   ```

   Every test passes. The tests run the rewrite and deny cases in [`append-index.cases.json`](../../scripts/cloudfront/test/append-index.cases.json), check that no file the site ships under `11ty/` is denied, and run an ES5.1 guard, because the function runs on `cloudfront-js-1.0`. A public file you added under `11ty/person/` must also be listed in `PUBLIC_PERSON_FILES`, or a test fails.

2. **Create the function.** Check whether it already exists:

   ```sh
   aws cloudfront describe-function --name HFYAppendIndex --query ETag --output text
   ```

   If it prints an ETag, the function exists, for example from an earlier attempt. Do not overwrite it by hand. Go to substep 3, whose dry run shows how its code differs from the repository's.

   If the command fails with `NoSuchFunctionExists`, create it, with the same comment the publish script sets:

   ```sh
   aws cloudfront create-function --name HFYAppendIndex \
     --function-config '{"Comment":"Append index.html to directory paths; 404 for private data prefix variants (HFY data gate)","Runtime":"cloudfront-js-1.0"}' \
     --function-code fileb://scripts/cloudfront/append-index.js
   ```

   A new function exists only in the `DEVELOPMENT` stage. Viewers get the `LIVE` stage.

3. **Test it on CloudFront and publish it.** Run the publish script, a dry run first. Always pass `--distribution <distribution-id>`, because the script's default is this repository's production distribution.

   ```sh
   scripts/infra/publish-append-index.sh --dry-run --distribution <distribution-id>
   scripts/infra/publish-append-index.sh --distribution <distribution-id>
   ```

   For a function you just created, the dry run prints `local unit tests pass`, then `note: HFYAppendIndex is not associated with the default cache behavior of <distribution-id> (publishing only updates the function)`, `(no LIVE stage yet)` and `DEVELOPMENT holds exactly the repo code`. It ends with `(dry-run) no changes made`. For a function that already existed, it prints a diff of each stage against the repository file instead.

   The real run tests the `DEVELOPMENT` stage with CloudFront's `test-function` and the `awsSamples` cases, and prints `all <n> test-function cases pass`. It then publishes to `LIVE`, reads `LIVE` back, and prints `published: HFYAppendIndex LIVE now runs the repo code`. If any case fails, it stops with `refusing to publish`, and `LIVE` is unchanged.

4. **Attach it to the default behavior on viewer-request.**

   ```sh
   FN_ARN=$(aws cloudfront describe-function --name HFYAppendIndex --stage LIVE \
     --query 'FunctionSummary.FunctionMetadata.FunctionARN' --output text)
   aws cloudfront get-distribution-config --id <distribution-id> > dist-current.json
   jq --arg arn "$FN_ARN" '.DistributionConfig
     | .DefaultCacheBehavior.FunctionAssociations =
         {Quantity: 1, Items: [{FunctionARN: $arn, EventType: "viewer-request"}]}' \
     dist-current.json > dist-new.json
   aws cloudfront update-distribution --id <distribution-id> \
     --if-match "$(jq -r .ETag dist-current.json)" --distribution-config file://dist-new.json
   aws cloudfront wait distribution-deployed --id <distribution-id>
   ```

   This replaces any other function association on the default behavior, which a new distribution does not have. Never associate the function with any other behavior. There it would answer `404` to the data itself, and the publish script refuses to publish while it is associated that way. The association names the function, not a version, so later publishes take effect without a distribution update.

5. **Confirm the association and the code.** Run the dry run again:

   ```sh
   scripts/infra/publish-append-index.sh --dry-run --distribution <distribution-id>
   ```

   It prints `HFYAppendIndex is the viewer-request function of the default cache behavior of <distribution-id>` and ends with `function HFYAppendIndex already runs the repo code on LIVE: no change`.

### 5. Point DNS at the distribution

Point the apex and `www` at the distribution's `cloudfront.net` domain.

- **Route 53.** Create an alias `A` record for each name. Its target is the distribution domain, with hosted zone ID `Z2FDTNDATAQYW2`, the fixed zone for CloudFront aliases.
- **Another provider.** Create a CNAME for `www`. For the apex, use the record type your provider offers for pointing an apex at a hostname: ALIAS, ANAME or a flattened CNAME.

If Cloudflare proxies the records, set its SSL/TLS mode to Full (strict). Cloudflare then caches in front of CloudFront, and the deploy's CloudFront invalidation does not purge Cloudflare's copies. Cloudflare decides what to store by file extension, whatever CloudFront's cache policy says. That matters in two places.

**Static files.** Cloudflare, and then the browser, keeps scripts, stylesheets, fonts and `sw.js` for 4 h under the URL it first fetched them at. It does not cache the HTML. The `?v=<sha8>` versions in the pages handle this. The islands build gives every same-origin script and stylesheet reference a hash of the file's content, so a changed file is fetched under a new URL as soon as the new HTML is served. The versions are committed build output, so nothing on this page sets them up. [Edge and origin design](../explanation/edge-and-origin-design.md#static-files-and-versioned-urls-hfy-tsk-086) explains them, and [Theme and asset build](../reference/theme-and-asset-build.md) lists the stamped files.

**The gated paths.** These are `/person/*.json`, `/family/*`, `/event/*`, `/note/*`, `/place/*`, `/media/*` and `/uploads/*`. By extension, Cloudflare would store the images, SVG and PDF files under `/media/` and the member photos under `/uploads/`. Three points apply:

- **Once the gate is attached, they answer `Cache-Control: private, no-store`.** That covers the gate's own `401` and `302` and every response it lets through, and Cloudflare does not store such responses. The `404`s of `HFYAppendIndex` carry the same header. [Edge and origin design](../explanation/edge-and-origin-design.md#cloudflare-in-front-of-cloudfront-hfy-r65) explains why.
- **No Cloudflare Cache Rule may override the edge TTL on them.** The protection works only while Cloudflare honors the origin's `Cache-Control`. A rule that overrides it would let Cloudflare store a member's response and serve it to visitors who never reach the gate. A Cache Rule that bypasses the cache for the seven prefixes is optional extra protection.
- **Purge them right after you attach the gate.** Until then, `/uploads/*` serves member photos to anyone, cached, and Cloudflare serves any copy it stored until its TTL ends, without the request reaching the gate. [Cut over to authV2 and the private data gate](cut-over-to-the-private-data-gate.md#4-optional-purge-cloudflare) gives the purge of all seven prefixes.

### 6. Create the deploy role and its secret

The deploy workflow uses no stored AWS keys. It assumes `harrisonfamily-github-deploy-role` through GitHub's OIDC provider, and the stack only references that provider. Check that the account has one:

```sh
aws iam list-open-id-connect-providers --query 'OpenIDConnectProviderList[].Arn' --output text
```

If no ARN ends in `token.actions.githubusercontent.com`, create the provider:

```sh
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com --client-id-list sts.amazonaws.com
```

Deploy the stack. The overrides can be left out when the template defaults already match your environment.

```sh
aws cloudformation deploy --stack-name harrisonfamily-github-roles \
  --template-file infrastructure/cloudformation/github-roles.yaml \
  --capabilities CAPABILITY_NAMED_IAM --region us-west-2 \
  --parameter-overrides GitHubOrg=<github-owner> GitHubRepo=<github-repo> \
    OIDCProviderArn=arn:aws:iam::<aws-account-id>:oidc-provider/token.actions.githubusercontent.com
```

Set the repository secret from the stack's `DeployRoleArn` output:

```sh
gh secret set AWS_DEPLOY_ROLE_TO_ASSUME --repo <github-owner>/<github-repo> --body "$(
  aws cloudformation describe-stacks --stack-name harrisonfamily-github-roles --region us-west-2 \
    --query "Stacks[0].Outputs[?OutputKey=='DeployRoleArn'].OutputValue" --output text)"
```

Only runs on `main` can assume the role. It may write to `<site-bucket>` except under `uploads/`, create and read invalidations on `<distribution-id>`, and update the code, versions and aliases of the three named functions. Nothing else is granted. In particular, it cannot update CloudFront Functions, so `HFYAppendIndex` is always published by hand. The trust policy and permissions are listed in [Repository operations](../reference/repository-operations.md#deploy-role-github-rolesyaml).

### 7. Create the Google web client

The auth edge renders the Google Identity Services button and checks the Google ID token itself, so Google redirects nowhere and the client needs only authorized JavaScript origins. [The identity model](../explanation/identity-model.md#one-edge-several-methods) explains how the edge uses the token.

1. In the Google Cloud console, choose or create a project. Under **Google Auth Platform**, fill in the branding, set the audience to **External**, and publish the app. While it is in **Testing**, only listed test users can sign in.
2. Under **Clients**, create a client of type **Web application**. Add `https://<site>` and `https://www.<site>` as authorized JavaScript origins. Add both `http://localhost` and `http://localhost:<port>` only if you test sign-in against a local server.
3. Leave the redirect URIs empty. Nothing uses the client secret that Google generates, so do not store it. The client needs no redirect URIs, no client secret and no other Google API.
4. Keep the client ID, `<google-web-client-id>`, for the `GoogleClientId` parameter in [Deploy the app stack](deploy-the-app-stack.md). No repository secret holds it: the pages carry no client ID (HFY-TSK-317).

 To replace the client later, follow [Rotate the Google sign-in client](rotate-the-google-client.md).

## Verify

The bucket is empty until the first deploy, so run that first.

1. **The first deploy is green.** Ship through [Deploy a site change](deploy-a-site-change.md), or start a run on `main` by hand and watch it:

   ```sh
   gh workflow run io-kit-deploy.yml --repo <github-owner>/<github-repo> --ref main
   gh run list --repo <github-owner>/<github-repo> --workflow io-kit-deploy.yml --limit 1
   gh run watch <run-id> --repo <github-owner>/<github-repo>
   ```

   `build`, `deploy`, `invalidate` and `smoke` succeed. On the first deploy there is no earlier release, so if `smoke` fails, `rollback_on_smoke_fail` fails too, with `no previous successful run`.
2. **The site answers through CloudFront.**

   ```sh
   curl -sI "https://<site>/" | grep -iE '^(HTTP|x-cache|strict-transport-security)'
   ```

   You see a `200` status line, an `x-cache` header from CloudFront, and the `strict-transport-security` header from step 3.
3. **HFYAppendIndex resolves clean URLs and refuses the private paths.**

   ```sh
   for p in /about/ /about /person/; do
     curl -s -o /dev/null -w "%{http_code} $p\n" "https://<site>$p"
   done
   for p in /person/index.json /Person/index.json /media/x /Uploads/x; do
     printf '%s: ' "$p"
     curl -sS -o /dev/null -D - "https://<site>$p" | grep -iE '^(HTTP|cache-control)' | tr -d '\r' | paste -sd ' ' -
   done
   ```

   The first three lines start with `200`. Each of the other four answers `404` with `cache-control: private, no-store`. `/person/index.json` and `/media/x` answer `404` only until the cutover attaches the gate. From then on the gate answers them, with `401`.
4. **The pages carry versioned asset URLs.**

   ```sh
   curl -s "https://<site>/" | grep -oE '/(css|js)/[a-z0-9.-]+\?v=[0-9a-f]{8}' | sort -u
   ```

   It prints the page's scripts and stylesheets, `/css/hfy-theme.css?v=<sha8>` among them. If it prints nothing, the committed pages were not built with the islands build ([Build and preview the islands](build-and-preview-the-islands.md)).
5. **The bucket is not reachable directly.**

   ```sh
   curl -s -o /dev/null -w "%{http_code}\n" "https://<site-bucket>.s3.us-west-2.amazonaws.com/index.html"
   ```

   The result is `403`.
6. **Browsers can upload photos to the bucket.**

   ```sh
   scripts/infra/check-site-bucket-cors.sh
   ```

   It needs no credentials. It sends the browser's CORS preflight, an `OPTIONS` request, for a `PUT` to `uploads/posts/smoke/x.jpg` on the bucket's S3 endpoint. Its last line ends with `0 failed`: `https://<site>` and `https://www.<site>` each get `200` and their own origin back in `Access-Control-Allow-Origin`, and a foreign origin, a `DELETE` and an extra request header each get `403`. The object need not exist, because S3 answers a preflight from the CORS configuration alone. After every successful deploy run, [`post-deploy-checks.yml`](../../.github/workflows/post-deploy-checks.yml) runs the same check.

| Symptom | Likely cause |
| --- | --- |
| The `build` job fails | The runner, or `11ty/` is missing from the checkout (the build command only echoes) |
| The `deploy` job fails at the AWS credentials step | `AWS_DEPLOY_ROLE_TO_ASSUME` is missing or wrong, the run is not on `main`, or `GitHubOrg`/`GitHubRepo` do not match the repository |
| The `smoke` job fails | The site does not answer on the `smoke` URLs in `ci.manifest.yaml`. Check the next rows. |
| Every path returns `403` | The bucket policy is missing or names the wrong distribution, the origin has no OAC, or the bucket is still empty |
| `/` works but `/about/` returns `403` | `HFYAppendIndex` is not published to `LIVE` or not attached on viewer-request |
| `/about/` works but `/Person/index.json` returns `403`, not `404` | `HFYAppendIndex` runs code without the default-deny, for example a function that already existed in the account. Publish the repository code with `publish-append-index.sh` ([step 4](#4-create-and-attach-hfyappendindex), substep 3). |
| Signed-in members cannot load person pages, search or family photos, and the data requests answer `404` | Expected until the cutover attaches the gate. Run [Cut over to authV2 and the private data gate](cut-over-to-the-private-data-gate.md). |
| `publish-append-index.sh` stops with `refusing: cannot describe function HFYAppendIndex` | The function does not exist. Create it ([step 4](#4-create-and-attach-hfyappendindex), substep 2). |
| `publish-append-index.sh` stops with `refusing: cannot read distribution` | `--distribution <distribution-id>` is missing, so the script read its default, which is another distribution, or the credentials cannot read yours |
| `publish-append-index.sh` stops with `refusing (exit 3)` | The function is associated with a behavior other than the default one. Remove that association and run the script again. |
| No `?v=` URLs in the home page | The committed `11ty/` pages were not built with the islands build, for example after an Eleventy refresh. Build, run `(cd islands && npm run check:islands)`, commit and deploy. |
| TLS error | The certificate is not issued or does not cover the name, or DNS still points elsewhere |
| `check-site-bucket-cors.sh` prints `expected 200` for a site origin | The bucket has no CORS rule for that origin, so photo uploads from it fail. Apply the file as in [step 1](#1-create-the-site-bucket). |
| `check-site-bucket-cors.sh` prints `expected 403, got 200` | The bucket's CORS configuration is wider than the file. Find out what the extra rule is for, then apply the file as in [step 1](#1-create-the-site-bucket). |

## Related pages

- [Edge and origin design](../explanation/edge-and-origin-design.md): why one distribution fronts everything, the bucket is reachable only through it, the data paths are gated at the edge, and the static files are versioned.
- [The privacy model for family data](../explanation/family-data-privacy.md): what the gate protects and why.
- [Architecture](../reference/architecture.md): the distribution, `HFYAppendIndex`, the buckets, the stacks, the deploy role and the secrets, as built.
- [Theme and asset build](../reference/theme-and-asset-build.md): the theme layer, fonts, head blocks and `?v=` versions that the islands build writes into `11ty/`.
- [Identity services](../reference/identity-services.md): the auth edge's manifest, passkeys, and the gate's configuration.
- [MCP server](../reference/mcp-server.md): the `/mcp` mount, its resource, and the groups in `config/groups.json`.
- [Private data and secrets](../reference/private-data-and-secrets.md): placeholders, and where real values may live.
- [Repository operations](../reference/repository-operations.md): the deploy workflow, the behavior scripts and the repo's guards.
- [Publish a change to the CloudFront Function](publish-the-cloudfront-function.md): every later change to `HFYAppendIndex`.
- [Build and preview the islands](build-and-preview-the-islands.md) and [Change the theme or brand fonts](change-the-theme-or-brand-fonts.md): the islands build that adapting the repo needs.
- [Deploy the edge functions](deploy-the-edge-functions.md), [Manage family access](manage-family-access.md), [Deploy the app stack](deploy-the-app-stack.md), [Sync Gramps with the website](sync-gramps-with-the-website.md), [Cut over to authV2 and the private data gate](cut-over-to-the-private-data-gate.md), [Deploy a site change](deploy-a-site-change.md), [Rotate the Google sign-in client](rotate-the-google-client.md), [Diagnose sign-in and API failures](diagnose-sign-in-and-api-failures.md).
