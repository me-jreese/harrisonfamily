# App backend cost estimate

Reference for the estimated monthly AWS cost of the app backend (HFY-TSK-063 AC3).

Prices are AWS list prices taken on 2026-10-12 from the AWS Price List bulk API (offer files published between 2026-09-11 and 2026-10-09). The app stack runs in US West (Oregon), `us-west-2`, not `us-east-1`: [`app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml) resolves the origin-verify secret and grants the signing-key secret in its own region, and [`create-origin-verify.sh`](../../scripts/infra/create-origin-verify.sh) and [`create-session-key.sh`](../../scripts/infra/create-session-key.sh) create those secrets in `us-west-2` by default. Its lines use `us-west-2` prices. The two Lambda@Edge functions are created in `us-east-1`, as Lambda@Edge requires, and CloudFront runs them in the Regions nearest the viewers. The price list gives Lambda@Edge the same request and duration rates in `us-east-1`, `us-east-2`, `us-west-1` and `us-west-2`, and those are the rates used. `<edge-code-bucket>` is priced at the `us-east-1` S3 rate. CloudFront is a global service and is priced at its United States rates. The original estimate, `docs/cost-estimate.md` at commit `e35af0e` (HFY-TSK-063; read it with `git show e35af0e:docs/cost-estimate.md`), used `us-east-1` list prices; every unit price it used is the same in `us-west-2`. This page replaces it.

All amounts are in USD. They come from assumed traffic, not from a bill. For what drives these numbers and which ones grow, read [What drives cost](../explanation/edge-and-origin-design.md#what-drives-cost). For the components themselves, see the [architecture reference](architecture.md). Placeholders such as `<site>`, `<config-bucket>` and `<edge-code-bucket>` are listed in [Private data and secrets](private-data-and-secrets.md#placeholders).

## Scope

Priced:

| Component | Defined in | Billed on |
| --- | --- | --- |
| Lambda `hfy-api` (`arm64`, 256 MB) and its Function URL, including the MCP server at `/mcp` | `Function`, `FunctionUrl` in [`app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml); the MCP mount in [`api/src/mcp.js`](../../api/src/mcp.js), routed in [`api/src/index.js`](../../api/src/index.js) | Requests and GB-seconds. The Function URL has no charge of its own. The MCP server runs inside this function, so its compute, its JWKS fetches and its `config/groups.json` reads are `hfy-api` work. |
| Lambda `hfy-auth-edge` (`arm64`, 512 MB) and its Function URL | `AuthFunction`, `AuthFunctionUrl` in [`app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml) | Requests and GB-seconds |
| Lambda@Edge `hfy-edge-gate` (128 MB), the viewer-request function of the six gated behaviors | `Function`, `Version` in [`edge-gate-stack.yaml`](../../infrastructure/cloudformation/edge-gate-stack.yaml), stack `hfy-edge-gate` in `us-east-1`; attached by [`add-data-gate-behaviors.sh`](../../scripts/infra/add-data-gate-behaviors.sh) | Requests and GB-seconds at Lambda@Edge rates, on every request to `/person/*.json`, `/family/*`, `/event/*`, `/note/*`, `/place/*` and `/media/*`, allowed or denied |
| Lambda@Edge `hfy-mcp-edge401` (128 MB), the origin-response function of the two MCP behaviors | `Edge401Function`, `Edge401Version` in [`mcp-edge401.us-east-1.yaml`](../../infrastructure/mcp-edge401.us-east-1.yaml), stack `hfy-mcp-edge401` in `us-east-1`; attached by [`add-mcp-behavior.sh`](../../scripts/infra/add-mcp-behavior.sh) | Requests and GB-seconds at Lambda@Edge rates, on every response from `/mcp*` and `/.well-known/oauth-protected-resource*` |
| Cognito user pool `hfy-users` | `UserPool` in [`app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml) | Monthly active users (MAU) |
| DynamoDB table `hfy-app` (on-demand, `GSI1`, point-in-time recovery) | `Table` in [`app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml) | Request units, storage, PITR storage |
| CloudWatch log groups for `hfy-api` and `hfy-auth-edge` (30-day retention) | `LogGroup`, `AuthLogGroup` in [`app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml) | Ingestion and storage |
| CloudWatch log groups for the two Lambda@Edge functions | Neither `us-east-1` stack defines one. Lambda@Edge writes to `/aws/lambda/us-east-1.<function>` in each Region that ran the function, and nothing sets a retention period, so the logs are kept. | Ingestion and storage, at each Region's rate |
| Secrets Manager secrets in play | See [Secrets](#secrets) | Per secret per month, and per API call |
| CloudFront requests to `/api/*`, `/auth/*`, `/.well-known/oauth-authorization-server*`, `/mcp*` and `/.well-known/oauth-protected-resource*` | [`add-api-behavior.sh`](../../scripts/infra/add-api-behavior.sh), [`add-auth-behavior.sh`](../../scripts/infra/add-auth-behavior.sh), [`add-mcp-behavior.sh`](../../scripts/infra/add-mcp-behavior.sh) | Requests and data transfer out. These behaviors use `CachingDisabled` and run no CloudFront Function; the two MCP behaviors carry `hfy-mcp-edge401`. The legacy `/api/check-allowed*` pin is not priced, with the rest of the legacy path. |
| Config and person-record reads | [`api/src/auth.js`](../../api/src/auth.js), [`api/src/policy.js`](../../api/src/policy.js), [`api/src/labels.js`](../../api/src/labels.js), [`auth/edge.manifest.json`](../../auth/edge.manifest.json), [`auth/src/membership.js`](../../auth/src/membership.js) | S3 GET requests; see [Config and person-record reads](#config-and-person-record-reads) |
| Post photo uploads under `uploads/posts/` in the site bucket | [`api/src/uploads.js`](../../api/src/uploads.js) | S3 PUT requests and storage. The browser PUTs straight to S3 with a presigned URL; the Lambda never handles the bytes. |
| Forgot-password rate-limit counters | [`auth/src/ratelimit.js`](../../auth/src/ratelimit.js) | One DynamoDB write per `POST /auth/password/forgot` and scope; included in the auth edge's DynamoDB use |
| The gate's code in `<edge-code-bucket>` | [`package-edge-gate.sh`](../../scripts/ci/package-edge-gate.sh); the `CodeBucket` and `CodeKey` parameters of [`edge-gate-stack.yaml`](../../infrastructure/cloudformation/edge-gate-stack.yaml) | S3 storage |

Not priced:

- **The legacy Google Cloud pieces.** The `getAllowlist` Cloud Function and its Google Secret Manager secret are outside AWS and outside this estimate.
- **The legacy `hfy-check-allowed` Lambda and the API Gateway in front of it.** They are not in `app-stack.yaml` and retire with the old sign-in path. Their Secrets Manager secret is counted, because a secret is billed monthly whether or not it is read.
- **The static site.** S3 storage for the site, the default CloudFront behavior, the CloudFront Function, invalidations, and the CloudFront requests, data transfer and S3 GETs of the gated data paths are shown separately in [Static-site baseline](#static-site-baseline) and are not in the app-backend total. The gate's own Lambda@Edge charges are in the app-backend total.
- **Cloudflare.** Cloudflare proxies `<site>` in front of CloudFront. It is outside AWS and outside this estimate.
- **Everything else around the stacks.** DNS and the domain, the public ACM certificate, the app stack's Lambda packages in `<code-bucket>` (a commit-named zip for each function per code deploy), the push requests `hfy-api` sends to browsers' push services, and CI.

## Pricing conventions

- List prices only: no discounts, credits or Savings Plans.
- Where a service's own rate prices its first units at zero, the line uses that. This covers DynamoDB's first 25 GB-month of storage (the first tier of the `us-west-2` storage rate), CloudFront Functions' first 2,000,000 executions and the first 1,000 invalidation paths each month.
- AWS Free Tier allowances are not subtracted: Lambda's 1,000,000 requests and 400,000 GB-seconds, CloudFront's 10,000,000 requests and 1 TB out, CloudWatch Logs' 5 GB, and Cognito's 10,000 MAU. The price list carries the Lambda, CloudWatch Logs and Cognito allowances as separate global free-tier rows, apart from the regional rates, and Cognito's regional Essentials rate starts at the first MAU. The Lambda rows cover Lambda's own request and duration usage. Lambda@Edge is billed in separate request and duration groups that have no free-tier row, so no allowance applies to it. Each allowance applies per account and is shared with anything else running in it. Their effect is shown in [With the AWS Free Tier](#with-the-aws-free-tier).
- Annual figures are 12 times the monthly figure, with photo storage held at its first-month value. Photo storage growth is shown on its own line.
- Totals are summed before rounding, so a column of rounded lines can differ from its total by 0.01.

## Traffic model

All of these are assumptions, not measurements. They describe the system after the cutover: `authV2` on for every visitor, then the private data gate attached ([How to cut over to authV2 and the private data gate, and roll back](../how-to/cut-over-to-the-private-data-gate.md)). `authV2` is `false` in [`11ty/_data/flags.json`](../../11ty/_data/flags.json) until the flip. Until then, the session probes, refreshes and gated requests below do not happen, sign-in runs on the legacy path, and the default behavior serves the data paths.

Carried over from the original estimate:

| Assumption | Value |
| --- | --- |
| Active family members | About 40 |
| Sessions | 20 per member per month |
| API calls per session | 15, so 12,000 a month |
| Headroom for polling, retries and bots | About 8x, so **100,000 `/api/*` requests a month** |
| Read and write split | 90% reads, 10% writes |
| DynamoDB reads | About 2 read request units (RRU) per read request, so 180,000 RRU |
| DynamoDB writes | About 5,000 transactional writes a month at about 10 write request units (WRU) each, so 50,000 WRU |
| `hfy-api` average duration | 150 ms |
| Table size | Under 0.2 GB |
| `hfy-api` logs | About 0.1 GB a month |

Assumptions not in the original estimate:

| Assumption | Value | Basis |
| --- | --- | --- |
| Page views | 10 per session, so 8,000 a month | Each page makes one session probe under `authV2`; see [Auth edge requests](#auth-edge-requests) |
| `/auth/*` requests | **30,000 a month** | Session probes, refreshes, sign-ins, JWKS fetches and MCP OAuth, broken down in [Auth edge requests](#auth-edge-requests) |
| `hfy-auth-edge` average duration | 300 ms | Covers Cognito and DynamoDB round trips. Session probes and JWKS responses make neither, because the edge checks the cookie against its own public key, so this overstates them. Container start-up also reads the signing key from Secrets Manager. |
| Auth-edge DynamoDB use | About 10,000 RRU and 5,000 WRU a month | Refresh-token and link store, passkey credentials and challenges, MCP authorization codes and refresh tokens, and the forgot-password counters, all in `hfy-app` |
| `hfy-auth-edge` logs | About 0.05 GB a month | |
| MCP requests | **5,000 a month** to `/mcp*` and `/.well-known/oauth-protected-resource*` | Tools are shown and run only for members in the `mcp-authors` or `hfy-admin` group of `config/groups.json` ([`api/src/policy.js`](../../api/src/policy.js)): a handful of members at about 1,000 requests each. Each request is an `hfy-api` invocation and an `hfy-mcp-edge401` invocation. Tool calls run the API's own route handlers, and their table use is assumed to fit in the API's DynamoDB figures. |
| Gated data and media requests | **100,000 a month** | About 60 a session (person records, the person manifest and search index, family-tree SVGs and media files), so 48,000, about doubled for requests the gate denies: signed-out visitors, bots, and requests sent with a lapsed cookie. After a gate `401` the client refreshes and retries the request once, which is a second gated request ([`11ty/js/feature-flags.js`](../../11ty/js/feature-flags.js)). |
| Lambda@Edge billed duration | 50 ms an invocation, at 128 MB | Both functions are 128 MB ([`edge-gate-stack.yaml`](../../infrastructure/cloudformation/edge-gate-stack.yaml), [`mcp-edge401.us-east-1.yaml`](../../infrastructure/mcp-edge401.us-east-1.yaml)). The gate checks a signature against a key it already holds, and the 401 restore returns at once unless the status is `401`. The figure leaves room for cold starts and for the gate's JWKS fetches, which it abandons after 3 s (`fetchTimeoutMs` in [`edge-gate/gate.config.json`](../../edge-gate/gate.config.json)). |
| Lambda@Edge logs | About 0.03 GB a month | About 0.3 KB of platform log lines an invocation, plus a line for each cookie the gate rejects ([`edge-gate/src/gate.mjs`](../../edge-gate/src/gate.mjs)) |
| Average response size through CloudFront | 5 KB | JSON and sign-in pages on the app paths |
| Config and person-record reads | At most about 210,000 S3 GETs a month | See [Config and person-record reads](#config-and-person-record-reads) |
| Photo uploads | 100 a month, 3 MB average | Each upload is one S3 PUT, capped at 10 MB (`MAX_UPLOAD_BYTES` in [`api/src/uploads.js`](../../api/src/uploads.js)) |
| Published posts | 100 a month | With push on, each publish scans the table; see [Notification scans](#notification-scans) |
| Gate builds kept in `<edge-code-bucket>` | Under 20 MB | Each build adds one zip under a new content-addressed key, and [`package-edge-gate.sh`](../../scripts/ci/package-edge-gate.sh) refuses a zip of 1 MB or more, so 20 builds stay under 20 MB |

### Auth edge requests

| Source | Requests a month | Basis |
| --- | --- | --- |
| Session probes | 8,800 | Under `authV2`, each page calls `GET /auth/session` once, through `edgeSession()` in [`11ty/js/feature-flags.js`](../../11ty/js/feature-flags.js): 8,000. After a successful refresh it asks once more: 800. |
| Refreshes, sign-ins and account pages | 4,000 | About 5 a session, as in the earlier model. The page sends `POST /auth/refresh` when `/auth/session` reports the session signed out or within 120 s of expiry, and once after a gate `401`, before it retries that request. The `io_id` cookie lasts one hour (`accessTtlSeconds: 3600` in [`auth/edge.manifest.json`](../../auth/edge.manifest.json)), so most sessions refresh once. The rest is the sign-in pages, password, Google and passkey sign-ins (each passkey ceremony is an options request and a verify request), passkey registration and removal, and sign-out. |
| JWKS fetches | At most 13,680 | Three verifiers fetch `/auth/.well-known/jwks.json` through CloudFront and keep it per container: the API's cookie check for 10 minutes ([`api/src/auth.js`](../../api/src/auth.js)), at most 4,320; the MCP mount for one hour (the `@io-kit/mcp/edge` key cache), at most 720; the gate for 300 s (`jwksTtlSeconds` in [`edge-gate/gate.config.json`](../../edge-gate/gate.config.json)), at most 8,640. The bound assumes one warm container per function for the whole month, refetching each time its copy expires. The gate runs in each Region that serves viewers, and every Region's containers keep their own copy, so each warm gate container adds up to 8,640. |
| MCP OAuth | About 1,000 | The discovery documents, `/auth/register`, `/auth/authorize`, `/auth/token`, `/auth/revoke` and `/auth/userinfo` ([`auth/src/oauth.js`](../../auth/src/oauth.js)). MCP access tokens last one hour (`ACCESS_TTL_S`), so a member who uses an MCP client every day makes on the order of 100 of these requests a month. |
| **Total** | **27,480, rounded up to 30,000** | |

### Config and person-record reads

Five cached readers, each re-reading only when a request needs the object and its copy has expired:

| Reader | Object | Cached for | At most a month |
| --- | --- | --- | --- |
| `hfy-api`, admin list | `config/admins.json` in `<config-bucket>` | 60 s ([`api/src/auth.js`](../../api/src/auth.js)) | 43,200 |
| `hfy-auth-edge`, sign-in resolver | The allowlist, `config/userGrampsID.json` | 300 s (`resolver.cacheSeconds` in [`auth/edge.manifest.json`](../../auth/edge.manifest.json)) | 8,640 |
| `hfy-auth-edge`, MCP membership, on `/auth/authorize`, `/auth/token` and `/auth/userinfo` | The allowlist and `config/admins.json` | 60 s ([`auth/src/membership.js`](../../auth/src/membership.js)) | 86,400 |
| `hfy-api`, MCP groups, on MCP requests | `config/groups.json` | 60 s (`createGroupResolver` in [`api/src/policy.js`](../../api/src/policy.js)) | 43,200 |
| `hfy-api`, author labels | `person/<gramps-id>.json` in `<site-bucket>`, for its `displayName` | 1 h for each member found, 1 min when there is no usable record (`createLabelResolver` in [`api/src/labels.js`](../../api/src/labels.js)) | 28,800: 40 members × 720 hours |
| **Total** | | | **210,240** |

- The bound assumes one warm container per function for the whole month, with a read every time a copy expires. Each concurrent warm container adds its own reads, so more than one per function raises the bound in proportion.
- When `config/admins.json` is absent, as it is when there are no moderators, the API's admin list fails closed and retries after 5 s instead of 60 s ([`api/src/auth.js`](../../api/src/auth.js)). Its reads are then bounded by one every 5 s and by one per API request with a valid session: up to 100,000 at base instead of 43,200, which adds at most 0.02 a month, and up to 500,000 at 5x, which adds at most 0.18. The auth edge's membership treats the same absence as an empty admin list and keeps its 60 s cache, so its reads do not rise.

### Notification scans

With push on, publishing a post notifies every subscriber, and `hfy-api` finds them with a DynamoDB `Scan` of `hfy-app` filtered to subscription items (`scanSubscribedPrincipals` in [`api/src/notify.js`](../../api/src/notify.js)). A filter does not reduce what a `Scan` reads, so each publish reads the table, up to 20 pages of at most 1 MB each. At 0.5 RRU per 4 KB for an eventually consistent read, that is at most 2,560 RRU a publish, or 256,000 RRU for 100 publishes. A table of a few megabytes reads a few hundred RRU a publish.

## Line items

Base traffic, monthly. Unit prices are `us-west-2` list prices unless the line names other rates; CloudFront uses its United States rates.

| Line | Basis | Unit price | Monthly USD |
| --- | --- | --- | --- |
| DynamoDB reads | 180,000 RRU (API) + 10,000 RRU (auth edge) | $0.125 per million RRU | 0.02 |
| DynamoDB notification scans | At most 100 publishes × 2,560 RRU = 256,000 RRU | $0.125 per million RRU | 0.03 |
| DynamoDB writes | 50,000 WRU (API) + 5,000 WRU (auth edge) | $0.625 per million WRU | 0.03 |
| DynamoDB storage | Under 0.2 GB | First 25 GB-month $0.00, then $0.25 per GB-month | 0.00 |
| DynamoDB PITR | 0.2 GB | $0.20 per GB-month | 0.04 |
| Lambda `hfy-api` | 105,000 requests (100,000 `/api/*`, 5,000 MCP) × 150 ms × 0.25 GB = 3,937.5 GB-s | $0.0000133334 per GB-s (`arm64`); $0.20 per million requests | 0.07 |
| Lambda `hfy-auth-edge` | 30,000 × 300 ms × 0.5 GB = 4,500 GB-s; 30,000 requests | Same as above | 0.07 |
| Lambda@Edge `hfy-edge-gate` | 100,000 × 50 ms × 0.125 GB = 625 GB-s; 100,000 requests | $0.00005001 per GB-s; $0.60 per million requests | 0.09 |
| Lambda@Edge `hfy-mcp-edge401` | 5,000 × 50 ms × 0.125 GB = 31.25 GB-s; 5,000 requests | Same as above | 0.00 |
| Cognito user pool | About 40 MAU | $0.015 per MAU (Essentials, the plan a user pool gets when `UserPoolTier` is not set, as in `app-stack.yaml`). The 10,000-MAU allowance is Free Tier. | 0.60 |
| Secrets Manager | 4 secrets; a few hundred reads | $0.40 per secret per month; $0.05 per 10,000 API calls | 1.60 |
| CloudWatch Logs, `hfy-api` and `hfy-auth-edge` | 0.15 GB ingested; at most 0.15 GB stored | $0.50 per GB ingested; $0.03 per GB-month stored | 0.08 |
| CloudWatch Logs, Lambda@Edge | 0.03 GB ingested and kept, spread over the Regions that ran the functions | The same rates in `us-east-1`, `us-east-2` and `us-west-2`. `us-west-1` charges $0.67 per GB ingested and $0.033 per GB-month; the line rounds to the same figure either way. | 0.02 |
| CloudFront requests | 135,000 HTTPS (100,000 `/api/*`, 30,000 `/auth/*`, 5,000 MCP) | $0.0100 per 10,000 | 0.14 |
| CloudFront data transfer out | 135,000 × 5 KB ≈ 0.68 GB | $0.085 per GB. Request bodies sent on to the origin cost $0.020 per GB and round to zero. | 0.06 |
| S3 config and person-record reads | At most 210,240 GETs | $0.004 per 10,000 GETs | 0.08 |
| Photo upload PUTs | 100 PUTs | $0.005 per 1,000 | 0.00 |
| Photo storage | 0.3 GB added each month and kept | $0.023 per GB-month | 0.01 in the first month, about 0.08 after 12 months |
| Gate code in `<edge-code-bucket>` | Under 20 MB | $0.023 per GB-month (`us-east-1`) | 0.00 |
| **Total** | | | **2.95 a month; about 35 a year** |

Without the secrets, the other lines come to about 1.35 a month, of which 0.60 is Cognito.

### Secrets

The secrets line is the largest. It counts every Secrets Manager secret the backend holds, not only the ones in `app-stack.yaml`. The original estimate counted two: the session key and VAPID.

| Secret | Status | Read by | Monthly USD |
| --- | --- | --- | --- |
| Session signing key | Always present | `hfy-auth-edge`, once per container | 0.40 |
| Origin-verify | Always present (HFY-R43, added after the original estimate) | CloudFormation at deploy time, and the behavior scripts; never at runtime | 0.40 |
| Legacy allowlist HMAC (`HFY_ALLOWLIST_HMAC_SECRET`) | Present until the legacy sign-in path retires | `hfy-check-allowed`, once per container | 0.40 |
| VAPID key pair (`harrisonfamily/api/vapid`) | In use. The stack's `VapidSecretName` parameter names it, which turns on push sending. | `hfy-api`, once per container | 0.40 |

So the line is 1.60 a month. Once the legacy sign-in path retires, it drops to 1.20. Neither Lambda@Edge function reads a secret: Lambda@Edge has no environment variables, and the gate verifies sessions against the auth edge's public JWKS. For the secrets' names and handling rules, see [Private data and secrets](private-data-and-secrets.md).

## Stress check at 5x

Five times the base traffic: 500,000 `/api/*`, 150,000 `/auth/*` and 25,000 MCP requests, 500,000 gated requests, 500 photo uploads and 500 publishes a month. The table is assumed to grow to 1 GB. Scaling `/auth/*` whole overstates it, because its JWKS share is bounded by the cache periods, not by traffic.

| Line | Base | 5x | What changes |
| --- | --- | --- | --- |
| DynamoDB reads | 0.02 | 0.12 | 950,000 RRU |
| DynamoDB notification scans | 0.03 | 0.16 | 1,280,000 RRU; still at most 20 pages a publish |
| DynamoDB writes | 0.03 | 0.17 | 275,000 WRU |
| DynamoDB storage | 0.00 | 0.00 | 1 GB, still inside the zero-priced 25 GB |
| DynamoDB PITR | 0.04 | 0.20 | 1 GB |
| Lambda `hfy-api` | 0.07 | 0.37 | 19,687.5 GB-s; 525,000 requests |
| Lambda `hfy-auth-edge` | 0.07 | 0.33 | 22,500 GB-s; 150,000 requests |
| Lambda@Edge `hfy-edge-gate` | 0.09 | 0.46 | 3,125 GB-s; 500,000 requests |
| Lambda@Edge `hfy-mcp-edge401` | 0.00 | 0.02 | 156.25 GB-s; 25,000 requests |
| Cognito user pool | 0.60 | 0.60 | Traffic, not MAU, grows |
| Secrets Manager | 1.60 | 1.60 | Fixed |
| CloudWatch Logs, `hfy-api` and `hfy-auth-edge` | 0.08 | 0.40 | 0.75 GB ingested |
| CloudWatch Logs, Lambda@Edge | 0.02 | 0.08 | 0.15 GB ingested |
| CloudFront requests | 0.14 | 0.68 | 675,000 requests |
| CloudFront data transfer out | 0.06 | 0.29 | 3.38 GB |
| S3 config and person-record reads | 0.08 | 0.08 | Bounded by the cache periods and the number of members, not by traffic, while one warm container per function carries the load |
| Photo upload PUTs | 0.00 | 0.00 | 500 PUTs |
| Photo storage, first month | 0.01 | 0.03 | 1.5 GB added each month; about 0.41 a month after 12 months |
| Gate code in `<edge-code-bucket>` | 0.00 | 0.00 | Grows with builds, not traffic |
| **Total** | **2.95** | **5.59** | |
| **Per year** | **about 35** | **about 67** | |

The original estimate checked against a target of 30 USD a year. The base estimate is now over it, at about 35 a year, and 5x is about 67. The original stress check came to about 29 a year, but it priced two secrets, had no Cognito, config-read, notification-scan or Lambda@Edge lines, and left out the auth edge, `/auth/*` and MCP requests, and response transfer. Against it, the two extra secrets add 9.60 a year, the Cognito line 7.20 and the gate about 1.10. With the Free Tier allowances, the base estimate is under the target, at about 23 a year, and 5x is over it, at about 34; see the next section.

## With the AWS Free Tier

If the account's Free Tier allowances are not used up by other workloads, the Lambda, CloudFront, CloudWatch Logs and Cognito lines cost nothing at both traffic levels. Each use below is inside its allowance.

| Allowance | Per account per month | Use at base | Use at 5x | Line it brings to 0.00 |
| --- | --- | --- | --- | --- |
| Lambda requests | 1,000,000 | 135,000 | 675,000 | Both Lambda lines |
| Lambda compute | 400,000 GB-s | 8,437.5 GB-s | 42,187.5 GB-s | Both Lambda lines |
| CloudFront requests | 10,000,000 | 135,000 | 675,000 | CloudFront requests |
| CloudFront data transfer out | 1 TB | 0.68 GB | 3.38 GB | CloudFront data transfer out |
| CloudWatch Logs | 5 GB | 0.18 GB | 0.9 GB | Both CloudWatch Logs lines |
| Cognito MAU (Lite and Essentials) | 10,000 | About 40 | About 40 | Cognito user pool (0.60) |

The Lambda@Edge lines stay, because no allowance covers Lambda@Edge. The CloudFront allowances are shared with the static site: the re-priced volumes in [Static-site baseline](#static-site-baseline) add 1,000,000 requests and 50 GB, which still fit.

| | Monthly USD | Per year |
| --- | --- | --- |
| Base | 1.92 | About 23 |
| 5x | 2.85 | About 34 |

What remains is mostly the secrets line. At 5x, DynamoDB and the gate make up most of the rest.

## Static-site baseline

The static site's cost is not part of the app-backend total. Two pre-E5 documents estimated it: `cloudfront/README.md` ("Expected monthly costs", in `git show 63900a0:cloudfront/README.md`) and `harrisonfamily-frontend/README.md` ("Estimated costs", in `git show 90577c5:harrisonfamily-frontend/README.md`). Both directories now hold short pointers. Both documents used generic volumes, not this site's measured traffic, and both predate the private data gate. The table re-prices their volumes at the same list prices and adds the S3 reads that the gated paths cause.

| Line | Volume | Unit price | Monthly USD | Older figure |
| --- | --- | --- | --- | --- |
| CloudFront HTTPS requests | 1,000,000, including every gated data and media request | $0.0100 per 10,000 | 1.00 | About 0.50 in `cloudfront/README.md` |
| CloudFront data transfer out | 50 GB, including every gated response | $0.085 per GB | 4.25 | About 5 in `cloudfront/README.md`; 5 to 10 in `harrisonfamily-frontend/README.md` |
| CloudFront Function (`HFYAppendIndex`), if attached to the default behavior | One execution per default-behavior request, so at most 1,000,000 | First 2,000,000 a month $0.00 | 0.00 | Not given |
| Invalidations | One `/*` path per deploy, and one more per rollback (the `invalidate` list in [`ci.manifest.yaml`](../../ci.manifest.yaml)) | First 1,000 paths a month $0.00 | 0.00 | Not given |
| S3 storage, site bucket | The bucket's size in GB | $0.023 per GB-month | 1 to 3 if the older figure is right, which implies 43 to 130 GB | 1 to 3 in `harrisonfamily-frontend/README.md` |
| S3 GETs, gated paths | Every allowed request to a gated path, so at most the 100,000 gated requests in the [traffic model](#traffic-model) | $0.004 per 10,000 | 0.04 | Not given |
| S3 GETs, other cache misses | Only requests to the cached behaviors that CloudFront cannot answer from cache | $0.004 per 10,000 | Under 0.05 (100,000 misses would be 0.04) | Not given |
| **Total** | | | **About 6.30 to 8.35 a month, about 75 to 100 a year** | Under 10 a month in `cloudfront/README.md` |

What the gate changes:

- The six gated behaviors, `/person/*.json`, `/family/*`, `/event/*`, `/note/*`, `/place/*` and `/media/*`, use `CachingDisabled` and the response headers policy `hfy-private-no-store`, which sets `Cache-Control: private, no-store` on every response ([`add-data-gate-behaviors.sh`](../../scripts/infra/add-data-gate-behaviors.sh)). So every allowed data or media request is a CloudFront request, an S3 GET and an `hfy-edge-gate` invocation. A request the gate denies ends at the gate with a `401` or a `302`: a CloudFront request and an invocation, with no S3 GET. The invocations are priced in the app-backend [line items](#line-items), not here.
- Cloudflare caches images, SVG and PDF by file extension, so it used to answer repeat requests for `/media/` files without reaching CloudFront. It does not store a `private, no-store` response, and neither do browsers, so every view of a media file now reaches CloudFront and is transferred again. For example, if each of the traffic model's 800 sessions loads 50 media files averaging 0.5 MB, that is 20 GB a month, 1.70 of transfer out, inside the 50 GB above.
- Before the gate is attached, the default behavior serves the data paths, and CloudFront and Cloudflare can answer repeat requests from their caches.

Reconciliation notes:

- `cloudfront/README.md` priced 1,000,000 requests at about 0.50. At the US HTTPS rate of $0.0100 per 10,000 they cost 1.00. Even the HTTP rate of $0.0075 per 10,000 gives 0.75, and every behavior redirects HTTP to HTTPS.
- `harrisonfamily-frontend/README.md` gives monthly lines of 1 to 3 (S3) and 5 to 10 (CloudFront transfer), which add up to 6 to 13 a month, or 72 to 156 a year. Its "total annual cost" of under 30 contradicts its own lines, so it is dropped here. The monthly "under 10" in `cloudfront/README.md` is consistent with the re-priced lines.
- Where the account has the CloudFront Free Tier allowances, these request and transfer volumes cost nothing. That leaves S3 storage as the static site's main cost, with the S3 GETs on the gated paths after it.
- Views of post photos count here, not in the app-backend total. Photos are served from the site bucket through the `/uploads/*` behavior (`MediaPublicBase` in [`app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml); `CachingOptimized`, no function), so each GB viewed through CloudFront is $0.085 of transfer out. For example, 100 photos of 3 MB each, each viewed 40 times, is 12 GB, about 1.02 a month. That behavior does not set `no-store`, so Cloudflare can answer repeat views of the image types it caches, which lowers the figure.

## Related pages

- [Why one CloudFront distribution fronts everything: What drives cost](../explanation/edge-and-origin-design.md#what-drives-cost), [How member content stays accountable](../explanation/member-content-design.md), [Why releases ship through a pipeline and feature flags](../explanation/release-model.md)
- [System architecture](architecture.md), [MCP server](mcp-server.md), [Identity services](identity-services.md), [Codebase map](codebase-map.md), [Private data and secrets](private-data-and-secrets.md)
- [How to deploy the app stack and its CloudFront behaviors](../how-to/deploy-the-app-stack.md), [How to deploy and update the Lambda@Edge functions in us-east-1](../how-to/deploy-the-edge-functions.md), [How to cut over to authV2 and the private data gate, and roll back](../how-to/cut-over-to-the-private-data-gate.md), [How to turn on push notifications](../how-to/turn-on-push-notifications.md), [How to stand up the static site and its deploy access](../how-to/stand-up-the-static-site.md)
