# Why one CloudFront distribution fronts everything

The site is delivered through a single CloudFront distribution under a single hostname. Static pages, the family data, the member API, the MCP server and the auth edge all sit behind it as path behaviors. This page explains why the delivery layer has this shape: the origin protections chosen for each backend, why edge code is kept to a minimum and the two places where it is not, the caching posture (including the Cloudflare cache in front of CloudFront), the one flow that bypasses the distribution, and what drives the bill.

In outline, Cloudflare proxies `<site>` in front of CloudFront. Behind it, the default behavior serves the static site from S3, and `/uploads/*` serves member photos from the same bucket with stricter response headers. Six behaviors serve the family data from that bucket only after a Lambda@Edge gate has verified the visitor's session: `/person/*.json`, `/family/*`, `/event/*`, `/note/*`, `/place/*` and `/media/*`. `/api/*`, `/mcp*` and `/.well-known/oauth-protected-resource*` all go to the `hfy-api` Lambda through one origin, `hfy-api-origin`. `/auth/*` and the authorization-server discovery path go to the `hfy-auth-edge` Lambda. The exact behaviors, origins and policies are listed in the [request routing section of the architecture reference](../reference/architecture.md#request-routing). For the procedures, see the how-to pages linked at the end. Plan rulings cited as HFY-R*n* are recorded in the HFY-PLN-001 planning documents in Enceladus.

One flow skips the distribution on purpose: browsers upload post photos straight to S3. See [the deliberate exception](#the-deliberate-exception-presigned-photo-uploads).

## One origin for the browser

The main reason for the single distribution is that the browser sees one origin. Ruling HFY-R31 mounted the auth edge at `https://<site>/auth/*` and the API at `https://<site>/api/*` as path behaviors. It replaced the earlier plan to give the edge its own `auth.<site>` hostname, and three things follow from it.

- **The session cookie needs no special handling.** The auth edge sets a host-only session cookie and strips the `Domain` attribute that the auth kit would otherwise add ([`auth/src/edge.js`](../../auth/src/edge.js)). Because `/api/*` and the family-data paths are on the same host, the browser sends that cookie with every API call and every data fetch, and the [data gate](#the-data-gate-viewer-request) checks the same cookie the API does. Without the shared host, the cookie would need a parent-domain scope, which exposes it to every subdomain. For how sessions themselves work, see [the identity model](identity-model.md).
- **The site's own calls need no CORS.** The islands call relative paths such as `/api/...` with `credentials: "include"`, so there are no preflight requests, no credentialed-CORS headers to keep correct, and no origin allow-list for the site itself. The only CORS rules on the dynamic side are for outside callers. The auth edge allows an exact list of MCP client origins, never a wildcard, on its token, registration, revocation and userinfo endpoints (`/auth/token`, `/auth/register`, `/auth/revoke` and `/auth/userinfo`) and on its authorization-server discovery metadata ([`auth/src/oauth.js`](../../auth/src/oauth.js)). The other rule is the S3 upload exception described below.
- **One certificate and one DNS name.** CloudFront already holds the site's ACM certificate, and the site's DNS name already leads to the distribution through Cloudflare's proxy. A new hostname would have meant a new certificate name, a DNS validation record and a new record at the DNS provider, each one a manual step for the operator.

There is a cost. The distribution becomes the one place where every route is configured, so a mistake in it affects the whole site. Behavior order also matters. The legacy allowlist check at `/api/check-allowed` predates this design and runs behind API Gateway. While it still exists, it needs a more specific behavior ordered ahead of `/api/*`, and [`add-api-behavior.sh`](../../scripts/infra/add-api-behavior.sh) pins it there, refusing to run when it cannot tell which origin to pin (HFY-R58). The pin retires along with the old sign-in path (see [the release model](release-model.md)). The later scripts guard order in the same spirit. [`add-mcp-behavior.sh`](../../scripts/infra/add-mcp-behavior.sh) refuses to run when an earlier behavior would match an MCP path first. [`add-data-gate-behaviors.sh`](../../scripts/infra/add-data-gate-behaviors.sh) moves a gated pattern ahead of any broader behavior, such as a legacy `/person/*`, that would otherwise catch its requests and skip the gate.

## S3 behind Origin Access Control

No stack in this repository manages the site's bucket or the default behavior. They are created by hand, following [stand up the static site](../how-to/stand-up-the-static-site.md), and recorded in the [architecture reference](../reference/architecture.md#request-routing). In that setup, all public access to the bucket is blocked, and its bucket policy allows `s3:GetObject` only to the CloudFront service principal, on the condition that the request comes from this distribution's ARN. There is no other public read path, so every page view passes through CloudFront's caching, TLS and response headers, and every read of the family data passes through the gate. Inside the account, the API's own role may also read `person/*` objects directly, to label authors with the person's display name (HFY-R68). Writes are different: the deploy workflow syncs the site into the bucket with the deploy role's credentials, and browsers upload post photos through presigned URLs (see [the deliberate exception](#the-deliberate-exception-presigned-photo-uploads)).

OAC replaced the older Origin Access Identity (OAI) for these reasons:

- AWS treats OAI as legacy and recommends OAC for new distributions.
- OAC signs every origin request with Signature Version 4, works with SSE-KMS-encrypted objects, and is supported in every Region. OAI has gaps in each.
- The bucket policy names the CloudFront service principal and a single distribution ARN, rather than a special CloudFront user. Access is scoped to this distribution, not to any distribution that shares an identity.

In the sample configuration, the default behavior allows only `GET`, `HEAD` and `OPTIONS`, and the gated data behaviors allow only `GET` and `HEAD`. Because S3 requests through CloudFront never carry a body, the body-hash requirement that ruled out OAC for the Lambdas (next section) never comes up for S3.

## Lambda Function URLs with an origin-verify header (HFY-R43)

Each Lambda is reached through a Function URL, configured as a plain HTTPS custom origin. CloudFront attaches a secret `X-Origin-Verify` header to every request it forwards to that origin. Both Lambdas check the header before they do anything else.

### Why not API Gateway

API Gateway was the obvious alternative. For this API and the auth edge, it would have added a layer without adding anything the design needed:

- **Routing.** CloudFront already routes by path prefix, and each Lambda routes internally. The API has a route table in [`api/src/routes.js`](../../api/src/routes.js), and the auth kit has its own router. A gateway would be a third router.
- **TLS and domain.** CloudFront already terminates TLS for the one hostname. A gateway would just be another HTTPS origin behind it, with a stage path and its own configuration.
- **Authorization.** The API verifies session cookies, and its MCP mount verifies bearer access tokens, in code against the auth edge's published JWKS (HFY-R38). Gateway authorizers would duplicate that check.
- **Origin protection.** A gateway endpoint is public in the same way a Function URL is. Some mechanism would still be needed to reject traffic that bypasses CloudFront.
- **Cost and parts.** A gateway adds a per-request charge on top of Lambda and CloudFront, plus more resources in the stack.

A Function URL is a property of the function. It has no charge of its own, it deploys with the function in the same CloudFormation stack ([`app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml), HFY-R32), and it passes the request to the handler unchanged.

### Why the URLs are AuthType NONE

The first design kept the Lambdas behind OAC as well. Each URL would use `AuthType AWS_IAM`, and CloudFront would sign every origin request. That works for `GET`. For `POST` and `PUT`, however, Lambda requires the signed request to carry a SHA-256 hash of the body in the `x-amz-content-sha256` header, and CloudFront does not compute it. The client has to send it.

The site's own fetch wrapper could have added the header. The auth edge, however, also serves as the authorization server for MCP clients (HFY-TSK-076). Those clients POST to its token, registration and revocation endpoints, and they never send that header. Ruling HFY-R43 therefore dropped OAC and IAM auth for both Function URLs. It replaced them with `AuthType NONE` plus a shared secret that only CloudFront knows. The same constraint now applies to the API's URL a second way: MCP clients POST to `/mcp`, which the API Lambda serves (see [why MCP lives at a path on `hfy-api`](#why-mcp-lives-at-a-path-on-hfy-api-hfy-r59)).

Both URLs are `AuthType NONE`, with resource-based permissions that let anyone invoke them. The template's top-level `Description` still calls the API's URL an "IAM-auth Function URL", next to "(AuthType NONE)". The first phrase is left over from the dropped design and does not describe what the template deploys.

### How the check works

The check lives in [`api/src/origin.js`](../../api/src/origin.js) and [`auth/src/origin.js`](../../auth/src/origin.js). The two files are identical copies, so each Lambda package ships complete on its own. Four properties matter:

- **It runs first.** Each handler calls it before routing. In the API, that is also before a request is split between the MCP mount and the API routes ([`api/src/index.js`](../../api/src/index.js)), so the MCP server needs no check of its own. In the auth edge, it also runs before initialization, so a rejected request never loads the signing key, touches DynamoDB or reaches the auth kit. The response is a `403` with a small JSON body, `{"error":"forbidden"}`, and `cache-control: no-store`.
- **It is constant-time.** The received header and the configured secret are both hashed with SHA-256 before they are compared with `timingSafeEqual`. The comparison always runs over two 32-byte digests, so its timing reveals neither how many leading characters match nor how long the secret is.
- **It fails closed.** If the secret is unset or empty in the Lambda's environment, every request is rejected. A missing or empty header is also rejected. A configuration mistake therefore makes the API unavailable rather than open.
- **Viewers cannot supply the header themselves.** When a viewer request carries a header with the same name as an origin custom header, CloudFront overwrites it with the configured value. The only way to present a valid header is to call the Function URL directly with the secret, and the secret is never published.

The secret is resolved from Secrets Manager into each function's environment by a CloudFormation dynamic reference when CloudFormation creates or updates the function. The behavior scripts ([`add-api-behavior.sh`](../../scripts/infra/add-api-behavior.sh), [`add-auth-behavior.sh`](../../scripts/infra/add-auth-behavior.sh), [`add-mcp-behavior.sh`](../../scripts/infra/add-mcp-behavior.sh)) write the same value into the distribution's origin configuration, and they redact it from every diff they print. `add-mcp-behavior.sh` writes `X-Origin-Verify` into `hfy-api-origin`, the same origin that `add-api-behavior.sh` writes, so whichever of the two ran last set the header that origin sends. Each script has its own `--secret-name` option, and all three default to `harrisonfamily/cloudfront/origin-verify`. A rotation to a new secret name therefore has to pass that name to every script: a later run of `add-mcp-behavior.sh` with its default would put the default secret's value back on `hfy-api-origin`.

The value lives in two configurations: the functions' and the distribution's. Anyone with read access to either can see it. It proves that a request came through CloudFront; it is not a credential for any user. Where the secret is stored, and who can read it, is covered in [private data and secrets](../reference/private-data-and-secrets.md).

This design does not stop direct calls from reaching the function. A request to a raw Function URL still invokes the Lambda and is billed as an invocation. It just ends at the 403 before any real work is done.

## Why MCP lives at a path on hfy-api (HFY-R59)

Ruling HFY-R59 put the MCP server at `https://<site>/mcp`, a path on the main host, and mounted it inside the `hfy-api` Lambda ([`api/src/mcp.js`](../../api/src/mcp.js)) instead of giving it a hostname or a function of its own. The reasons extend the single-origin argument above.

- **One origin for browsers and MCP clients.** The resource that MCP access tokens are issued for (`https://<site>/mcp`), its protected-resource metadata under `/.well-known/oauth-protected-resource`, and the authorization server at `https://<site>/auth` share the site's host, certificate and DNS name. A client finds the whole chain from one hostname. The two discovery documents still come from different Lambdas. The protected-resource metadata describes the resource, so `hfy-api` serves it; the authorization-server metadata stays with the auth edge (HFY-R44).
- **One origin and one origin check.** `/mcp*` and the protected-resource path use `hfy-api-origin`, the origin `/api/*` already uses, with the same `X-Origin-Verify` header. The API's handler runs the origin check before it looks at the path, so the mount inherits that protection. Nothing new had to be secured between CloudFront and a Lambda.
- **The same route handlers.** The MCP tools are derived from the API's route registry ([`api/src/routes.js`](../../api/src/routes.js)). A route with an `mcp` member becomes a tool, and calling the tool runs that route's own handler as the member the token names, with the same validation, permission rules and audit records as the site's own call. There is no second implementation of any write to keep in step.

What differs is authentication. The mount accepts only a bearer access token, verified against the auth edge's key set, and never consults the session cookie. Its permissions come from `config/groups.json` in `<config-bucket>` (shape in [`api/src/policy.js`](../../api/src/policy.js)), not from any groups claim in the token. The tools, groups and step-up rules are listed in the [MCP server reference](../reference/mcp-server.md), and [connect an MCP client](../how-to/connect-an-mcp-client.md) has the steps.

The cost is coupling. The MCP server ships in the API's package and deploys with it, so a broken API package breaks MCP as well. Serving MCP from a Function URL also creates the one problem that the next section's second exception exists to solve.

## Two deliberate Lambda@Edge exceptions

The distribution's general-purpose edge code is one CloudFront Function, `HFYAppendIndex` ([`scripts/cloudfront/append-index.js`](../../scripts/cloudfront/append-index.js)). On viewer requests to the default behavior, it rewrites `/about/` to `/about/index.html` and an extensionless path such as `/about` to `/about/index.html`. The rewrite is needed because OAC requires S3's REST endpoint, which has no index-document support. Without it, clean URLs would return S3's `AccessDenied` XML.

The posture still holds for the app paths. The `/api/*` and `/auth/*` behaviors, and `/uploads/*`, have no function associations of either kind. Otherwise, an extensionless API path such as `/api/posts` would be rewritten to `/api/posts/index.html`. Everything that depends on who is asking runs at the origin, in regional Lambdas, because Lambda@Edge costs more on each of these counts:

- Lambda@Edge charges more per request than a CloudFront Function and adds duration charges. A URL rewrite needs neither the extra runtime nor the network access that Lambda@Edge provides.
- Lambda@Edge functions cannot use environment variables, so the configuration pattern the two Lambdas rely on does not carry over.
- Lambda@Edge functions are deployed from `us-east-1` as numbered versions and replicated worldwide. Their logs land in whichever Region served the request. The origin Lambdas deploy with the rest of the stack and log to one place.

Two jobs cannot be done at the origin or in a CloudFront Function. Each got one Lambda@Edge function, attached only to the behaviors that need it and deployed from its own `us-east-1` stack. Both carry the per-request, deployment and logging costs above, which is why neither does anything else. [Deploy the edge functions](../how-to/deploy-the-edge-functions.md) covers how they are built and released.

### The data gate (viewer-request)

The family data under the six data prefixes used to be served publicly by the default behavior. The gate closes that (HFY-R63). [`edge-gate/`](../../edge-gate/) is a dependency-free function, `hfy-edge-gate`, which [`add-data-gate-behaviors.sh`](../../scripts/infra/add-data-gate-behaviors.sh) attaches as the viewer-request association of the six gated behaviors. It verifies the `io_id` session cookie that the auth edge mints: the RS256 signature against the auth edge's JWKS, then the issuer, audience, expiry and not-before, with 60 s of clock skew ([`edge-gate/src/gate.mjs`](../../edge-gate/src/gate.mjs)). A verified request passes through unchanged. Anything else is denied: a top-level navigation gets a `302` to `/auth/login?returnTo=<path>`, and a fetch or subresource request gets `401 {"error":"unauthenticated"}`.

Lambda@Edge is the only place this check fits:

- **The origin cannot verify a cookie.** The data are plain objects in S3, read through OAC. S3 has no notion of a session, so the check has to happen at CloudFront.
- **A CloudFront Function cannot fetch a JWKS.** CloudFront Functions have no network access, and the check needs the auth edge's current public keys. Building a key into the function would tie every signing-key rotation to a gate release.

Running at the edge shapes the rest of the design:

- **Its configuration is baked into the zip.** Lambda@Edge has no environment variables, so the issuer, audience, JWKS URL and cache timings come from [`edge-gate/gate.config.json`](../../edge-gate/gate.config.json), which [`package-edge-gate.sh`](../../scripts/ci/package-edge-gate.sh) copies into the package. Changing any of them is a code release.
- **Every build gets a new key and a new version.** The package lives in a private `us-east-1` bucket, `<edge-code-bucket>`, under a content-addressed `CodeKey` (`lambda/hfy-edge-gate-<16 hex>.zip`), and the stack ([`edge-gate-stack.yaml`](../../infrastructure/cloudformation/edge-gate-stack.yaml)) takes the zip's `CodeSha256` alongside it. CloudFormation updates a function's code only when its S3 key changes, so re-uploading to a fixed key could never ship a fix. A new key updates the code, and the new `CodeSha256` replaces the `AWS::Lambda::Version`, which publishes a numbered version only if the uploaded code matches that hash. A mismatched zip fails the stack update, so nothing half-applied reaches CloudFront. Old versions are retained, because CloudFront's replicas pin the version they were given and it cannot be deleted while still in use.
- **It fails closed.** Any error is a deny. The gate keeps the JWKS in memory for each container; a failed fetch keeps the last good keys, and with no usable key nobody gets in. A gate that wrongly denies would lock every member out of the data, so a new version is exercised with synthetic viewer requests before it is attached.
- **It covers `/person/*.json`, not `/person/*`.** `/person/` itself is the public person-page shell. The gated behaviors run no CloudFront Function, so gating the whole prefix would also have taken the shell away from `HFYAppendIndex`, which resolves `/person/` to `index.html` under the default behavior.

The gate accepts only the `io_id` cookie, which the `authV2` client uses. The legacy client cannot read gated data, so the cutover turns the flag on and deploys the site first, and attaches the gate only after that deploy is confirmed (HFY-R67). The cookie lives one hour; under `authV2` the client refreshes it silently at `/auth/refresh` (HFY-R66), so the gate does not send members back to sign in every hour. [Cut over to the private data gate](../how-to/cut-over-to-the-private-data-gate.md) has the sequence and the rollback. For why the data is private at all, see [the privacy model for family data](family-data-privacy.md).

### The MCP 401 restore (origin-response)

An MCP client that calls `/mcp` without a valid token gets a `401` whose `WWW-Authenticate` header points to the protected-resource metadata. That header is how the client discovers where to sign in. Two platform limits get in the way. A Lambda Function URL does not pass `WWW-Authenticate` through: it renames it to `x-amzn-remapped-www-authenticate`. And a CloudFront Function, which could otherwise copy the header back, cannot run on a 4xx response.

So the stack `hfy-mcp-edge401` ([`mcp-edge401.us-east-1.yaml`](../../infrastructure/mcp-edge401.us-east-1.yaml)) deploys a small origin-response function, and [`add-mcp-behavior.sh`](../../scripts/infra/add-mcp-behavior.sh) attaches it to `/mcp*` and the protected-resource path. On a `401` that carries the renamed header and no `WWW-Authenticate`, it copies the value back. Every other response passes through unchanged.

The function's code is inline in the template, which creates a versioning trap. Lambda@Edge needs a numbered version, and CloudFormation publishes one only when the `AWS::Lambda::Version` resource itself changes. An edit to the inline code alone updates `$LATEST` and leaves the published version, and the ARN CloudFront uses, on the old code. The version's `Description` therefore carries a hash of the source. Editing the code means updating the hash, the changed `Description` replaces the version, and the replacement publishes the new code. A test ([`test_mcp_edge401_stack.py`](../../scripts/infra/test/test_mcp_edge401_stack.py)) fails whenever the code and the hash disagree. As with the gate, old versions are retained for CloudFront's replicas, and a new version reaches the distribution only when `add-mcp-behavior.sh` runs again.

## Caching posture

The rule is simple: cache what is static, and cache nothing that depends on who is asking.

- **Static content is cached and invalidated on every deploy.** The default behavior uses a caching policy (`CachingOptimized` in the sample configuration). After every sync to the bucket, the deploy pipeline ([`io-kit-deploy.yml`](../../.github/workflows/io-kit-deploy.yml)) invalidates `/*` and waits for the invalidation to finish before its smoke checks run. A blanket invalidation fits this site because most output keeps stable file names. Eleventy pages and the island entry bundles are not fingerprinted; only shared island chunks carry a content hash. A `/*` invalidation also counts as a single path for billing. See [deploy a site change](../how-to/deploy-a-site-change.md).
- **Member photos are cached hard.** `/uploads/*` uses `CachingOptimized` too. Each upload gets a fresh ULID key and is never rewritten, so a cached copy can never be stale.
- **Gated family data is never stored.** The six data behaviors use the managed `CachingDisabled` policy, so no response is ever shared between users. They also carry the response headers policy `hfy-private-no-store`, which overrides `Cache-Control` with `private, no-store` on every response. That header is aimed at the caches in front of CloudFront; see [Cloudflare in front of CloudFront](#cloudflare-in-front-of-cloudfront-hfy-r65).
- **`/api/*`, `/auth/*`, `/mcp*` and both discovery paths use `CachingDisabled`.** Responses depend on the session cookie or the bearer token, and API responses also send `cache-control: no-store`. The origin request policy is `AllViewerExceptHostHeader`. It forwards cookies, query strings and viewer headers to the Lambda, but not `Host`, because a Function URL answers only to its own hostname.
- **JWKS and discovery set their own short lifetime.** The auth edge's key set and its authorization-server metadata are public documents that change rarely. They are served with `public, max-age=300`. CloudFront does not cache them, because their behaviors use `CachingDisabled`, so that lifetime applies to clients: browsers, MCP clients and other verifiers. Three verifiers in this repository keep their own copy in memory, per container. The API's cookie check keeps it for up to ten minutes and refetches at most once per 30 s ([`api/src/auth.js`](../../api/src/auth.js)). The MCP mount checks bearer tokens against the same key set through `@io-kit/mcp/edge`. The gate keeps it for 300 s. For an unknown `kid` it refetches at most once per 30 s after a successful fetch, or once 2 s have passed after a failed one; it abandons a fetch after 3 s; and a failed fetch keeps the last good keys. The short retry after a failure means one slow answer from a cold auth edge does not lock a fresh gate container into denying everyone for half a minute.

### Cloudflare in front of CloudFront (HFY-R65)

Cloudflare proxies `<site>` in front of CloudFront, and it is a second shared cache that CloudFront's cache policies do not control. `CachingDisabled` governs only CloudFront's own cache; it does not change the `Cache-Control` header a response carries. Cloudflare decides what to store by file extension: by default it caches images, SVG and PDF, which is everything under `/media/`, but not JSON. Left alone, it would store a member's `/media/` response and serve it to the next visitor, who would never reach the gate at all, because the gate runs at CloudFront, behind Cloudflare.

So every gated response says it must not be stored. The `hfy-private-no-store` policy sets `Cache-Control: private, no-store` on everything the six behaviors return, and the gate sets the same header on its own `401` and `302` ([`edge-gate/src/gate.mjs`](../../edge-gate/src/gate.mjs)). A stored denial would be as wrong as a stored success: it would turn away members who are signed in. Cloudflare does not store `private` or `no-store` responses, and browsers do not keep them after sign-out.

This depends on Cloudflare honoring the origin's `Cache-Control`, which is its default. No Cloudflare Cache Rule may override the edge TTL for the gated paths, because such a rule would bring the leak back. Cloudflare's configuration lives in its dashboard, outside this repository, so nothing here can enforce that. Anything Cloudflare stored before the gate was attached is still served from Cloudflare until its edge TTL runs out, which is why a purge of the gated prefixes follows attachment ([cut over to the private data gate](../how-to/cut-over-to-the-private-data-gate.md)).

## The deliberate exception: presigned photo uploads

Post photos are the one flow that does not go through the distribution. To add a photo, the browser asks `POST /api/uploads` for a presigned S3 `PUT` URL ([`api/src/uploads.js`](../../api/src/uploads.js)). The API checks the session, content type and size (images only, at most 10 MB) before it signs. The browser then sends the bytes straight to the bucket, and the Lambda never handles them.

Routing the bytes through CloudFront and the Lambda would not work well:

- A Function URL caps a buffered request payload at 6 MB, which is less than the 10 MB photo limit.
- The Lambda would be billed for the whole duration of every upload.

A presigned URL avoids both problems. Its authority comes from the API role's narrow `s3:PutObject` grant on the post-photo prefix, and it expires after five minutes.

The cost is CORS. The presigned URL points at the bucket's own S3 endpoint, which is a different origin from the page, so the bucket needs a CORS rule that allows `PUT` from the site origin. The site bucket predates the app stack and is not managed by it. The rule in [`media-bucket-cors.json`](../../infrastructure/cloudformation/media-bucket-cors.json) is therefore applied by hand, once. Because `put-bucket-cors` replaces the bucket's whole CORS configuration, any later change to that configuration has to keep this rule.

Reads are not part of the exception. The API returns a public URL on the site's own origin, so photos are viewed through CloudFront like every other static object, through their own `/uploads/*` behavior (HFY-R58). Serving member files from the site's own origin is what makes that behavior necessary: a file a member uploaded, if a browser sniffed it as HTML, would run with the site's privileges. The behavior's response headers forbid sniffing and sandbox the response, so an upload can only ever display as an image. Each presigned URL also signs the content type, so the stored type is the one the API approved. For how posts and photos fit into the member features, see [member content design](member-content-design.md).

## One accepted origin secret

Each Lambda accepts exactly one origin-verify value. That keeps the check simple, but it means rotation cannot be seamless. Two places have to change: the functions' environment, through a stack deploy that changes the reference (for example, by pointing `OriginVerifySecretName` at a new secret), and the distribution's origin headers, through the behavior scripts (all three, since two of them write `hfy-api-origin`). They cannot change at the same instant.

Distribution updates also take minutes to reach every edge location. During that time, some edges send the old value and others send the new one. Whichever side changes first, some `/api/*`, `/mcp` and `/auth/*` requests get a 403 until both sides agree. Static pages are unaffected. The gate fetches its key set from `/auth/.well-known/jwks.json` through the same distribution, so a gate container that has no keys yet can be refused too, and it denies data requests until a later fetch succeeds. Containers that already hold keys keep them.

Updating the secret's value in Secrets Manager does nothing by itself. The functions keep the value CloudFormation resolved when it last updated them, and a redeploy with the same secret name and an unchanged template does not resolve it again. CloudFront keeps the header it was last given. [Rotate the origin-verify secret](../how-to/rotate-the-origin-verify-secret.md) covers why the procedure rotates to a new secret name.

Removing the window would mean accepting a previous value as well as the current one:

- Both `origin.js` copies would compare the header against two secrets.
- The template would pass a second value, for example the secret's `AWSPREVIOUS` version, into each function.
- Rotation would take three steps: deploy the stack so the functions accept both values, switch CloudFront and wait for it to finish deploying, then deploy again to drop the old value.

For a family site whose rotations are rare, manual and can be scheduled for a quiet moment, a short 403 window costs less than that extra code and the extra step. The procedure is in [rotate the origin-verify secret](../how-to/rotate-the-origin-verify-secret.md).

## What drives cost

The backend was sized for roughly forty active members. At that scale, most charges are rounding errors, so the useful question is which charges grow and what makes them grow. The numbers are in the [cost estimate](../reference/cost-estimate.md).

- **Secrets Manager is the largest fixed line.** Each secret has a flat monthly charge, whether or not it is read. The secrets are the auth edge's signing key, the origin-verify secret, the VAPID key for push (`harrisonfamily/api/vapid`, only when push is turned on), and the legacy allowlist HMAC secret, which lasts until the old sign-in path retires. Reads hardly matter: the signing key, the VAPID key and the legacy HMAC secret are each read once per Lambda container (the last by the legacy `hfy-check-allowed` Lambda), and the origin-verify secret is read only at deploy time. The cost lever is the number of secrets, not traffic. The line drops by one secret when the legacy path retires (see [the release model](release-model.md)). The origin-verify secret was added after the original estimate (HFY-TSK-063) was drawn up.
- **The data gate makes every data read paid work.** Each request to a gated path is a Lambda@Edge invocation, with its request and duration charges, on top of the CloudFront request. Data and media are no longer cached at CloudFront or at Cloudflare, so every one of those requests is also an S3 `GET`. A person page that loads several photos pays all three for each file. Each gate container also fetches the key set from `/auth` for itself, so the auth edge sees JWKS requests from every Region where the gate runs.
- **The 401 restore runs on every MCP response.** Its origin-response association fires on each response that `/mcp*` and the protected-resource path return, and nothing there is cached, so every MCP request adds one small Lambda@Edge invocation, even though the function returns at once unless the status is `401`.
- **Notification fan-out scans the table on every publish.** When push is turned on and a post is published, the API finds push subscribers with a DynamoDB `Scan` filtered to subscription items ([`api/src/notify.js`](../../api/src/notify.js)). A filtered `Scan` is billed for every item it reads, not just the items that match, so the cost of each publish grows with the size of the whole table rather than with the number of subscribers. The scan is also capped at twenty pages. At family scale this costs a few read units per publish. The estimate's suggested fix for a much larger family is a single subscriber-index item.
- **CloudFront requests and data transfer.** Every API, auth and MCP call is a CloudFront request as well as a Lambda invocation, and none of it is cached. Static pages are mostly served from cache. Photos, from family media and member uploads, are the largest objects served, so they dominate bytes out as posts accumulate. At the estimated traffic, requests and data transfer fall within CloudFront's free-tier allowance, provided other workloads in the account have not used it up; the cost estimate does not subtract it. The sample configuration uses `PriceClass_100`, which limits edge locations to cheaper Regions.
- **Photo storage grows without bound.** Each photo can be up to 10 MB. It is stored in the site bucket, and nothing in this repository expires it. Storage grows with every post, and every view of a photo adds data transfer.

Rejected direct calls to the Function URLs are a small, open-ended item: each one is a billed Lambda invocation, even though it ends at the 403 check.

## Further reading

- [Architecture reference: request routing](../reference/architecture.md#request-routing): every behavior, origin and policy described here, in order.
- [Deploy the edge functions](../how-to/deploy-the-edge-functions.md): how the gate and the 401 restore are built, validated and released from their `us-east-1` stacks.
- [Cut over to the private data gate](../how-to/cut-over-to-the-private-data-gate.md): the flags-first order, attaching the gate, the Cloudflare purge and the rollback.
- [MCP server reference](../reference/mcp-server.md) and [connect an MCP client](../how-to/connect-an-mcp-client.md): the server mounted at `/mcp` and how a client reaches it.
- [Rotate the origin-verify secret](../how-to/rotate-the-origin-verify-secret.md): the rotation procedure and how to confirm it worked.
- [Deploy the app stack](../how-to/deploy-the-app-stack.md) and [Stand up the static site](../how-to/stand-up-the-static-site.md): how the origins and behaviors described here are created.
- [Diagnose sign-in and API failures](../how-to/diagnose-sign-in-and-api-failures.md#every-api-or-auth-request-gets-403-forbidden): includes the 403s this design produces when the secret is out of step.
- [The identity model](identity-model.md): the session cookie and token verification that the single origin makes simple.
- [The privacy model for family data](family-data-privacy.md): what the gate protects and why.
- [Cost estimate](../reference/cost-estimate.md): the numbers behind [what drives cost](#what-drives-cost).
