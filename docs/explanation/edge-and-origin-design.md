# Why one CloudFront distribution fronts everything

The site is delivered through a single CloudFront distribution under a single hostname. Static pages, the member API and the auth edge all sit behind it as path behaviors. This page explains why the delivery layer has this shape: the origin protections chosen for each backend, the edge logic that was deliberately left out, the caching posture, the one flow that bypasses the distribution, and what drives the bill.

In outline, the default behavior serves the static site from S3, `/uploads/*` serves member photos from the same bucket with stricter response headers, `/api/*` goes to the `hfy-api` Lambda, and `/auth/*` and the authorization-server discovery path go to the `hfy-auth-edge` Lambda. The exact behaviors, origins and policies are listed in the [request routing section of the architecture reference](../reference/architecture.md#request-routing). For the procedures, see the how-to pages linked at the end. Plan rulings cited as HFY-R*n* are recorded in the HFY-PLN-001 planning documents in Enceladus.

One flow skips the distribution on purpose: browsers upload post photos straight to S3. See [the deliberate exception](#the-deliberate-exception-presigned-photo-uploads).

## One origin for the browser

The main reason for the single distribution is that the browser sees one origin. Ruling HFY-R31 mounted the auth edge at `https://<site>/auth/*` and the API at `https://<site>/api/*` as path behaviors. It replaced the earlier plan to give the edge its own `auth.<site>` hostname, and three things follow from it.

- **The session cookie needs no special handling.** The auth edge sets a host-only session cookie and strips the `Domain` attribute that the auth kit would otherwise add ([`auth/src/edge.js`](../../auth/src/edge.js)). Because `/api/*` is on the same host, the browser sends that cookie with every API call. Without the shared host, the cookie would need a parent-domain scope, which exposes it to every subdomain. For how sessions themselves work, see [the identity model](identity-model.md).
- **The site's own calls need no CORS.** The islands call relative paths such as `/api/...` with `credentials: "include"`, so there are no preflight requests, no credentialed-CORS headers to keep correct, and no origin allow-list for the site itself. The only CORS rules on the dynamic side are for outside callers. The auth edge allows an exact list of MCP client origins, never a wildcard, on its token, registration and revocation endpoints and on its authorization-server discovery metadata ([`auth/src/oauth.js`](../../auth/src/oauth.js)). The other rule is the S3 upload exception described below.
- **One certificate and one DNS name.** CloudFront already holds the site's ACM certificate and DNS already points at the distribution. A new hostname would have meant a new certificate name, a DNS validation record and a new record at the DNS provider, each one a manual step for the operator.

There is a cost. The distribution becomes the one place where every route is configured, so a mistake in it affects the whole site. Behavior order also matters. The legacy allowlist check at `/api/check-allowed` predates this design and runs behind API Gateway. While it still exists, it needs a more specific behavior ordered ahead of `/api/*`, and [`add-api-behavior.sh`](../../scripts/infra/add-api-behavior.sh) pins it there, refusing to run when it cannot tell which origin to pin (HFY-R58). The pin retires along with the old sign-in path (see [the release model](release-model.md)).

## S3 behind Origin Access Control

No stack in this repository manages the site's bucket or the default behavior. They are created by hand, following [stand up the static site](../how-to/stand-up-the-static-site.md), and recorded in the [architecture reference](../reference/architecture.md#request-routing). In that setup, all public access to the bucket is blocked, and its bucket policy allows `s3:GetObject` only to the CloudFront service principal, on the condition that the request comes from this distribution's ARN. There is no other read path, so every page view passes through CloudFront's caching, TLS and response headers. Writes are different: the deploy workflow syncs the site into the bucket with the deploy role's credentials, and browsers upload post photos through presigned URLs (see [the deliberate exception](#the-deliberate-exception-presigned-photo-uploads)).

OAC replaced the older Origin Access Identity (OAI) for these reasons:

- AWS treats OAI as legacy and recommends OAC for new distributions.
- OAC signs every origin request with Signature Version 4, works with SSE-KMS-encrypted objects, and is supported in every Region. OAI has gaps in each.
- The bucket policy names the CloudFront service principal and a single distribution ARN, rather than a special CloudFront user. Access is scoped to this distribution, not to any distribution that shares an identity.

In the sample configuration, the default behavior allows only `GET`, `HEAD` and `OPTIONS`. Because S3 requests through CloudFront never carry a body, the body-hash requirement that ruled out OAC for the Lambdas (next section) never comes up for S3.

## Lambda Function URLs with an origin-verify header (HFY-R43)

Each Lambda is reached through a Function URL, configured as a plain HTTPS custom origin. CloudFront attaches a secret `X-Origin-Verify` header to every request it forwards to that origin. Both Lambdas check the header before they do anything else.

### Why not API Gateway

API Gateway was the obvious alternative. For this API and the auth edge, it would have added a layer without adding anything the design needed:

- **Routing.** CloudFront already routes by path prefix, and each Lambda routes internally. The API has a route table in [`api/src/routes.js`](../../api/src/routes.js), and the auth kit has its own router. A gateway would be a third router.
- **TLS and domain.** CloudFront already terminates TLS for the one hostname. A gateway would just be another HTTPS origin behind it, with a stage path and its own configuration.
- **Authorization.** The API verifies sessions in code against the auth edge's published JWKS (HFY-R38). Gateway authorizers would duplicate that check.
- **Origin protection.** A gateway endpoint is public in the same way a Function URL is. Some mechanism would still be needed to reject traffic that bypasses CloudFront.
- **Cost and parts.** A gateway adds a per-request charge on top of Lambda and CloudFront, plus more resources in the stack.

A Function URL is a property of the function. It has no charge of its own, it deploys with the function in the same CloudFormation stack ([`app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml), HFY-R32), and it passes the request to the handler unchanged.

### Why the URLs are AuthType NONE

The first design kept the Lambdas behind OAC as well. Each URL would use `AuthType AWS_IAM`, and CloudFront would sign every origin request. That works for `GET`. For `POST` and `PUT`, however, Lambda requires the signed request to carry a SHA-256 hash of the body in the `x-amz-content-sha256` header, and CloudFront does not compute it. The client has to send it.

The site's own fetch wrapper could have added the header. The auth edge, however, also serves as the authorization server for MCP clients (HFY-TSK-076). Those clients POST to its token, registration and revocation endpoints, and they never send that header. Ruling HFY-R43 therefore dropped OAC and IAM auth for both Function URLs. It replaced them with `AuthType NONE` plus a shared secret that only CloudFront knows.

Both URLs are `AuthType NONE`, with resource-based permissions that let anyone invoke them. The template's top-level `Description` still says "IAM-auth Function URL". That wording is left over from the dropped design and does not describe what the template deploys.

### How the check works

The check lives in [`api/src/origin.js`](../../api/src/origin.js) and [`auth/src/origin.js`](../../auth/src/origin.js). The two files are identical copies, so each Lambda package ships complete on its own. Four properties matter:

- **It runs first.** Each handler calls it before routing. In the auth edge, it also runs before initialization, so a rejected request never loads the signing key, touches DynamoDB or reaches the auth kit. The response is a `403` with a small JSON body, `{"error":"forbidden"}`, and `cache-control: no-store`.
- **It is constant-time.** The received header and the configured secret are both hashed with SHA-256 before they are compared with `timingSafeEqual`. The comparison always runs over two 32-byte digests, so its timing reveals neither how many leading characters match nor how long the secret is.
- **It fails closed.** If the secret is unset or empty in the Lambda's environment, every request is rejected. A missing or empty header is also rejected. A configuration mistake therefore makes the API unavailable rather than open.
- **Viewers cannot supply the header themselves.** When a viewer request carries a header with the same name as an origin custom header, CloudFront overwrites it with the configured value. The only way to present a valid header is to call the Function URL directly with the secret, and the secret is never published.

The secret is resolved from Secrets Manager into each function's environment by a CloudFormation dynamic reference when CloudFormation creates or updates the function. The behavior scripts ([`add-api-behavior.sh`](../../scripts/infra/add-api-behavior.sh), [`add-auth-behavior.sh`](../../scripts/infra/add-auth-behavior.sh)) write the same value into the distribution's origin configuration, and they redact it from every diff they print. This means the value lives in two configurations: the functions' and the distribution's. Anyone with read access to either can see it. It proves that a request came through CloudFront; it is not a credential for any user. Where the secret is stored, and who can read it, is covered in [private data and secrets](../reference/private-data-and-secrets.md).

This design does not stop direct calls from reaching the function. A request to a raw Function URL still invokes the Lambda and is billed as an invocation. It just ends at the 403 before any real work is done.

## Why there is no Lambda@Edge

The distribution runs exactly one piece of edge code: the CloudFront Function `HFYAppendIndex` ([`scripts/cloudfront/append-index.js`](../../scripts/cloudfront/append-index.js)). On viewer requests to the default behavior, it rewrites `/about/` to `/about/index.html` and an extensionless path such as `/about` to `/about/index.html`. The rewrite is needed because OAC requires S3's REST endpoint, which has no index-document support. Without it, clean URLs would return S3's `AccessDenied` XML.

The API and auth behaviors have no function associations. Otherwise, an extensionless API path such as `/api/posts` would be rewritten to `/api/posts/index.html`.

Everything else runs at the origin, in regional Lambdas. Lambda@Edge would have cost more on each of these counts:

- Lambda@Edge charges more per request than a CloudFront Function and adds duration charges. A URL rewrite needs neither the extra runtime nor the network access that Lambda@Edge provides.
- Lambda@Edge functions cannot use environment variables, so the configuration pattern the two Lambdas rely on would not carry over.
- Lambda@Edge functions are deployed from `us-east-1` as numbered versions and replicated worldwide. Their logs land in whichever Region served the request. The origin Lambdas deploy with the rest of the stack and log to one place.

The host plan for the MCP work (Amendment 1a of the program BRD, under rulings HFY-R31 and HFY-R59) lists a Lambda@Edge "401 restore" as part of the MCP connector's CloudFront setup. Nothing in this repository creates or attaches one: all three behavior scripts set the Lambda association count to zero. If one is ever added, it would be the first exception to this posture.

## Caching posture

The rule is simple: cache what is static, and cache nothing that depends on who is asking.

- **Static content is cached and invalidated on every deploy.** The default behavior uses a caching policy (`CachingOptimized` in the sample configuration). After every sync to the bucket, the deploy pipeline ([`io-kit-deploy.yml`](../../.github/workflows/io-kit-deploy.yml)) invalidates `/*` and waits for the invalidation to finish before its smoke checks run. A blanket invalidation fits this site because most output keeps stable file names. Eleventy pages and the island entry bundles are not fingerprinted; only shared island chunks carry a content hash. A `/*` invalidation also counts as a single path for billing. See [deploy a site change](../how-to/deploy-a-site-change.md).
- **Member photos are cached hard.** `/uploads/*` uses `CachingOptimized` too. Each upload gets a fresh ULID key and is never rewritten, so a cached copy can never be stale.
- **`/api/*` and `/auth/*` use the managed `CachingDisabled` policy.** Responses depend on the session cookie, and API responses also send `cache-control: no-store`. The origin request policy is `AllViewerExceptHostHeader`. It forwards cookies, query strings and viewer headers to the Lambda, but not `Host`, because a Function URL answers only to its own hostname.
- **JWKS and discovery set their own short lifetime.** The auth edge's key set and its authorization-server metadata are public documents that change rarely. They are served with `public, max-age=300`. CloudFront does not cache them, because their behaviors use `CachingDisabled`, so that lifetime applies to clients: browsers, MCP clients and other verifiers. The API's own verifier keeps the key set in memory for each container.

## The deliberate exception: presigned photo uploads

Post photos are the one flow that does not go through the distribution. To add a photo, the browser asks `POST /api/uploads` for a presigned S3 `PUT` URL ([`api/src/uploads.js`](../../api/src/uploads.js)). The API checks the session, content type and size (images only, at most 10 MB) before it signs. The browser then sends the bytes straight to the bucket, and the Lambda never handles them.

Routing the bytes through CloudFront and the Lambda would not work well:

- A Function URL caps a buffered request payload at 6 MB, which is less than the 10 MB photo limit.
- The Lambda would be billed for the whole duration of every upload.

A presigned URL avoids both problems. Its authority comes from the API role's narrow `s3:PutObject` grant on the post-photo prefix, and it expires after five minutes.

The cost is CORS. The presigned URL points at the bucket's own S3 endpoint, which is a different origin from the page, so the bucket needs a CORS rule that allows `PUT` from the site origin. The site bucket predates the app stack and is not managed by it. The rule in [`media-bucket-cors.json`](../../infrastructure/cloudformation/media-bucket-cors.json) is therefore applied by hand, once. Because `put-bucket-cors` replaces the bucket's whole CORS configuration, any later change to that configuration has to keep this rule.

Reads are not part of the exception. The API returns a public URL on the site's own origin, so photos are viewed through CloudFront like every other static object, through their own `/uploads/*` behavior (HFY-R58). Serving member files from the site's own origin is what makes that behavior necessary: a file a member uploaded, if a browser sniffed it as HTML, would run with the site's privileges. The behavior's response headers forbid sniffing and sandbox the response, so an upload can only ever display as an image. Each presigned URL also signs the content type, so the stored type is the one the API approved. For how posts and photos fit into the member features, see [member content design](member-content-design.md).

## One accepted origin secret

Each Lambda accepts exactly one origin-verify value. That keeps the check simple, but it means rotation cannot be seamless. Two places have to change: the functions' environment, through a stack deploy that changes the reference (for example, by pointing `OriginVerifySecretName` at a new secret), and the distribution's origin headers, through the behavior scripts. They cannot change at the same instant.

Distribution updates also take minutes to reach every edge location. During that time, some edges send the old value and others send the new one. Whichever side changes first, some `/api/*` and `/auth/*` requests get a 403 until both sides agree. Static pages are unaffected.

Updating the secret's value in Secrets Manager does nothing by itself. The functions keep the value CloudFormation resolved when it last updated them, and a redeploy with the same secret name and an unchanged template does not resolve it again. CloudFront keeps the header it was last given. [Rotate the origin-verify secret](../how-to/rotate-the-origin-verify-secret.md) covers why the procedure rotates to a new secret name.

Removing the window would mean accepting a previous value as well as the current one:

- Both `origin.js` copies would compare the header against two secrets.
- The template would pass a second value, for example the secret's `AWSPREVIOUS` version, into each function.
- Rotation would take three steps: deploy the stack so the functions accept both values, switch CloudFront and wait for it to finish deploying, then deploy again to drop the old value.

For a family site whose rotations are rare, manual and can be scheduled for a quiet moment, a short 403 window costs less than that extra code and the extra step. The procedure is in [rotate the origin-verify secret](../how-to/rotate-the-origin-verify-secret.md).

## What drives cost

The backend was sized for roughly forty active members. At that scale, most charges are rounding errors, so the useful question is which charges grow and what makes them grow. The numbers are in the [cost estimate](../reference/cost-estimate.md).

- **Secrets Manager is the largest fixed line.** Each secret has a flat monthly charge, whether or not it is read. The secrets are the auth edge's signing key, the origin-verify secret, the optional VAPID key for push, and the legacy allowlist HMAC secret, which lasts until the old sign-in path retires. Reads hardly matter: the signing key, the VAPID key and the legacy HMAC secret are each read once per Lambda container (the last by the legacy `hfy-check-allowed` Lambda), and the origin-verify secret is read only at deploy time. The cost lever is the number of secrets, not traffic. The line drops by one secret when the legacy path retires (see [the release model](release-model.md)). The origin-verify secret was added after the original estimate (HFY-TSK-063) was drawn up.
- **Notification fan-out scans the table on every publish.** When a post is published, the API finds push subscribers with a DynamoDB `Scan` filtered to subscription items ([`api/src/notify.js`](../../api/src/notify.js)). A filtered `Scan` is billed for every item it reads, not just the items that match, so the cost of each publish grows with the size of the whole table rather than with the number of subscribers. The scan is also capped at twenty pages. At family scale this costs a few read units per publish. The estimate's suggested fix for a much larger family is a single subscriber-index item.
- **CloudFront requests and data transfer.** Every API and auth call is a CloudFront request as well as a Lambda invocation, and none of it is cached. Static pages are mostly served from cache. Photos are the largest objects served, so they dominate bytes out as posts accumulate. At the estimated traffic, requests and data transfer fall within CloudFront's free-tier allowance, provided other workloads in the account have not used it up; the cost estimate does not subtract it. The sample configuration uses `PriceClass_100`, which limits edge locations to cheaper Regions.
- **Photo storage grows without bound.** Each photo can be up to 10 MB. It is stored in the site bucket, and nothing in this repository expires it. Storage grows with every post, and every view of a photo adds data transfer.

Rejected direct calls to the Function URLs are a small, open-ended item: each one is a billed Lambda invocation, even though it ends at the 403 check.

## Further reading

- [Architecture reference](../reference/architecture.md): every component of the delivery layer, the app stack and the static site.
- [Rotate the origin-verify secret](../how-to/rotate-the-origin-verify-secret.md): the rotation procedure and how to confirm it worked.
- [Deploy the app stack](../how-to/deploy-the-app-stack.md) and [Stand up the static site](../how-to/stand-up-the-static-site.md): how the origins and behaviors described here are created.
- [Diagnose sign-in and API failures](../how-to/diagnose-sign-in-and-api-failures.md#every-api-or-auth-request-gets-403-forbidden): includes the 403s this design produces when the secret is out of step.
- [The identity model](identity-model.md): the session cookie and token verification that the single origin makes simple.
