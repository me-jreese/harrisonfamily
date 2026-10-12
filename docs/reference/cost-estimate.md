# App backend cost estimate

Reference for the estimated monthly AWS cost of the app backend (HFY-TSK-063 AC3).

Prices are AWS list prices taken on 2026-10-12 from the AWS Price List bulk API (offer files published between 2026-09-11 and 2026-10-09), for US West (Oregon), `us-west-2`, not `us-east-1`. The app stack runs in `us-west-2`: [`app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml) resolves the origin-verify secret and grants the signing-key secret in its own region, and [`create-origin-verify.sh`](../../scripts/infra/create-origin-verify.sh) and [`create-session-key.sh`](../../scripts/infra/create-session-key.sh) create those secrets in `us-west-2` by default. CloudFront is a global service and is priced at its United States rates. The [original estimate](https://github.com/me-jreese/harrisonfamily/blob/e35af0eb37dfc897f416d289d23270b8b6b56c20/docs/cost-estimate.md) (HFY-TSK-063, commit `e35af0e`) used `us-east-1` list prices; every unit price it used is the same in `us-west-2`. This page replaces it.

All amounts are in USD. They come from assumed traffic, not from a bill. For what drives these numbers and which ones grow, read [What drives cost](../explanation/edge-and-origin-design.md#what-drives-cost). For the components themselves, see the [architecture reference](architecture.md).

## Scope

Priced:

| Component | Defined in | Billed on |
| --- | --- | --- |
| Lambda `hfy-api` (`arm64`, 256 MB) and its Function URL | `Function`, `FunctionUrl` in [`app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml) | Requests and GB-seconds. The Function URL has no charge of its own. |
| Lambda `hfy-auth-edge` (`arm64`, 512 MB) and its Function URL | `AuthFunction`, `AuthFunctionUrl` in [`app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml) | Requests and GB-seconds |
| Cognito user pool `hfy-users` | `UserPool` in [`app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml) | Monthly active users (MAU) |
| DynamoDB table `hfy-app` (on-demand, `GSI1`, point-in-time recovery) | `Table` in [`app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml) | Request units, storage, PITR storage |
| CloudWatch log groups for both functions (30-day retention) | `LogGroup`, `AuthLogGroup` in [`app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml) | Ingestion and storage |
| Secrets Manager secrets in play | See [Secrets](#secrets) | Per secret per month, and per API call |
| CloudFront requests to `/api/*`, `/auth/*` and `/.well-known/oauth-authorization-server*` | [`add-api-behavior.sh`](../../scripts/infra/add-api-behavior.sh), [`add-auth-behavior.sh`](../../scripts/infra/add-auth-behavior.sh) | Requests and data transfer out. These behaviors use `CachingDisabled` and run no CloudFront Function. The legacy `/api/check-allowed*` pin is not priced, with the rest of the legacy path. |
| Config reads: the admin list (API); the allowlist (auth edge sign-in resolver); the allowlist and the admin list (auth edge MCP membership) | [`api/src/auth.js`](../../api/src/auth.js), [`auth/edge.manifest.json`](../../auth/edge.manifest.json), [`auth/src/membership.js`](../../auth/src/membership.js) | S3 GET requests |
| Post photo uploads under `uploads/posts/` in the site bucket | [`api/src/uploads.js`](../../api/src/uploads.js) | S3 PUT requests and storage. The browser PUTs straight to S3 with a presigned URL; the Lambda never handles the bytes. |
| Forgot-password rate-limit counters | [`auth/src/ratelimit.js`](../../auth/src/ratelimit.js) | One DynamoDB write per `POST /auth/password/forgot` and scope; included in the auth edge's DynamoDB use |

Not priced:

- **The legacy Google Cloud pieces.** The `getAllowlist` Cloud Function and its Google Secret Manager secret are outside AWS and outside this estimate.
- **The legacy `hfy-check-allowed` Lambda and the API Gateway in front of it.** They are not in `app-stack.yaml` and retire with the old sign-in path. Their Secrets Manager secret is counted, because a secret is billed monthly whether or not it is read.
- **The static site.** S3 storage for the site, the default CloudFront behavior, the CloudFront Function and invalidations are shown separately in [Static-site baseline](#static-site-baseline) and are not in the app-backend total.
- **The MCP resource server.** MCP access tokens are issued for the resource named by the `McpResources` stack parameter. The server behind that resource is not in `app-stack.yaml` or in this repository, so its compute and its own JWKS fetches are not priced here. Only the authorization side, which runs in `hfy-auth-edge`, is.
- **Everything else around the stack.** DNS and the domain, the public ACM certificate, the Lambda code packages in the code bucket, and CI.

## Pricing conventions

- List prices only: no discounts, credits or Savings Plans.
- Where a service's own rate prices its first units at zero, the line uses that. This covers DynamoDB's first 25 GB-month of storage (the first tier of the `us-west-2` storage rate), CloudFront Functions' first 2,000,000 executions and the first 1,000 invalidation paths each month.
- AWS Free Tier allowances are not subtracted: Lambda's 1,000,000 requests and 400,000 GB-seconds, CloudFront's 10,000,000 requests and 1 TB out, CloudWatch Logs' 5 GB, and Cognito's 10,000 MAU. The price list carries the Lambda, CloudWatch Logs and Cognito allowances as separate global free-tier rows, apart from the regional rates, and Cognito's regional Essentials rate starts at the first MAU. Each allowance applies per account and is shared with anything else running in it. Their effect is shown in [With the AWS Free Tier](#with-the-aws-free-tier).
- Annual figures are 12 times the monthly figure, with photo storage held at its first-month value. Photo storage growth is shown on its own line.
- Totals are summed before rounding, so a column of rounded lines can differ from its total by 0.01.

## Traffic model

All of these are assumptions, not measurements.

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
| `/auth/*` requests | **10,000 a month** | Sign-ins, refreshes, sign-in pages and the API's JWKS fetches. Access tokens last one hour (`accessTtlSeconds: 3600` in [`auth/edge.manifest.json`](../../auth/edge.manifest.json)) and the API caches the JWKS for 10 minutes ([`api/src/auth.js`](../../api/src/auth.js)). 800 sessions at about 5 calls each is 4,000, plus at most 4,320 JWKS fetches from one warm API container, rounded up. MCP OAuth traffic (HFY-TSK-076) is assumed to fit in the remaining 1,680: the discovery documents, `/auth/register`, `/auth/authorize`, `/auth/token` and `/auth/revoke` ([`auth/src/oauth.js`](../../auth/src/oauth.js)). MCP access tokens last one hour (`ACCESS_TTL_S`), so a member who uses an MCP client every day makes on the order of 100 of these requests a month. |
| `hfy-auth-edge` average duration | 300 ms | Covers Cognito and DynamoDB round trips. Container start-up also reads the signing key from Secrets Manager. |
| Auth-edge DynamoDB use | About 10,000 RRU and 5,000 WRU a month | Refresh-token and link store, and the forgot-password counters, in `hfy-app` |
| `hfy-auth-edge` logs | About 0.05 GB a month | |
| Average response size through CloudFront | 5 KB | JSON and sign-in pages |
| Config reads | At most about 138,000 S3 GETs a month | Three cached readers, each re-reading only when a request needs the file and its cache has expired. The API reads the admin list, cached 60 s ([`api/src/auth.js`](../../api/src/auth.js)): 43,200. The auth edge's sign-in resolver reads the allowlist, cached 300 s ([`auth/edge.manifest.json`](../../auth/edge.manifest.json)): 8,640. The auth edge's MCP membership reads both the allowlist and the admin list, cached 60 s, on each `/auth/authorize` and `/auth/token` grant ([`auth/src/membership.js`](../../auth/src/membership.js)): 86,400. The bound assumes one warm container per function for the whole month, with a read every time a cache expires: 43,200 + 8,640 + 86,400 = 138,240. Each concurrent warm container adds its own reads, so more than one per function raises the bound in proportion. |
| Photo uploads | 100 a month, 3 MB average | Each upload is one S3 PUT, capped at 10 MB (`MAX_UPLOAD_BYTES` in [`api/src/uploads.js`](../../api/src/uploads.js)) |

## Line items

Base traffic, monthly. Unit prices are `us-west-2` list prices, or United States rates for CloudFront.

| Line | Basis | Unit price | Monthly USD |
| --- | --- | --- | --- |
| DynamoDB reads | 180,000 RRU (API) + 10,000 RRU (auth edge) | $0.125 per million RRU | 0.02 |
| DynamoDB writes | 50,000 WRU (API) + 5,000 WRU (auth edge) | $0.625 per million WRU | 0.03 |
| DynamoDB storage | Under 0.2 GB | First 25 GB-month $0.00, then $0.25 per GB-month | 0.00 |
| DynamoDB PITR | 0.2 GB | $0.20 per GB-month | 0.04 |
| Lambda `hfy-api` | 100,000 × 150 ms × 0.25 GB = 3,750 GB-s; 100,000 requests | $0.0000133334 per GB-s (`arm64`); $0.20 per million requests | 0.07 |
| Lambda `hfy-auth-edge` | 10,000 × 300 ms × 0.5 GB = 1,500 GB-s; 10,000 requests | Same as above | 0.02 |
| Cognito user pool | About 40 MAU | $0.015 per MAU (Essentials, the plan a user pool gets when `UserPoolTier` is not set, as in `app-stack.yaml`). The 10,000-MAU allowance is Free Tier. | 0.60 |
| Secrets Manager | 3 secrets, or 4 with VAPID; a few hundred reads | $0.40 per secret per month; $0.05 per 10,000 API calls | 1.20 to 1.60 |
| CloudWatch Logs | 0.15 GB ingested; at most 0.15 GB stored | $0.50 per GB ingested; $0.03 per GB-month stored | 0.08 |
| CloudFront requests | 110,000 HTTPS (100,000 `/api/*`, 10,000 `/auth/*`) | $0.0100 per 10,000 | 0.11 |
| CloudFront data transfer out | 110,000 × 5 KB ≈ 0.55 GB | $0.085 per GB. Request bodies sent on to the origin cost $0.020 per GB and round to zero. | 0.05 |
| S3 config reads | At most 138,240 GETs | $0.004 per 10,000 GETs | 0.06 |
| Photo upload PUTs | 100 PUTs | $0.005 per 1,000 | 0.00 |
| Photo storage | 0.3 GB added each month and kept | $0.023 per GB-month | 0.01 in the first month, about 0.08 after 12 months |
| **Total** | | | **2.29 a month with 3 secrets, 2.69 with 4; about 27 to 32 a year** |

Without the secrets, the other lines come to about 1.09 a month, of which 0.60 is Cognito.

### Secrets

The secrets line is the largest. It counts every Secrets Manager secret the backend holds, not only the ones in `app-stack.yaml`. The original estimate counted two: the session key and VAPID.

| Secret | Status | Read by | Monthly USD |
| --- | --- | --- | --- |
| Session signing key | Always present | `hfy-auth-edge`, once per container | 0.40 |
| Origin-verify | Always present (HFY-R43, added after the original estimate) | CloudFormation at deploy time, and the behavior scripts; never at runtime | 0.40 |
| Legacy allowlist HMAC (`HFY_ALLOWLIST_HMAC_SECRET`) | Present until the legacy sign-in path retires | `hfy-check-allowed`, once per container | 0.40 |
| VAPID key | Optional. Only when the `VapidSecretName` stack parameter is set | `hfy-api`, once per container | 0.40 |

So the line is 1.20 a month without VAPID and 1.60 with it. Once the legacy sign-in path retires, it drops to 0.80 or 1.20. For the secrets' names and handling rules, see [Private data and secrets](private-data-and-secrets.md).

## Stress check at 5x

Five times the base traffic: 500,000 `/api/*` requests, 50,000 `/auth/*` requests and 500 photo uploads a month. The table is assumed to grow to 1 GB.

| Line | Base | 5x | What changes |
| --- | --- | --- | --- |
| DynamoDB reads | 0.02 | 0.12 | 950,000 RRU |
| DynamoDB writes | 0.03 | 0.17 | 275,000 WRU |
| DynamoDB storage | 0.00 | 0.00 | 1 GB, still inside the zero-priced 25 GB |
| DynamoDB PITR | 0.04 | 0.20 | 1 GB |
| Lambda `hfy-api` | 0.07 | 0.35 | 18,750 GB-s; 500,000 requests |
| Lambda `hfy-auth-edge` | 0.02 | 0.11 | 7,500 GB-s; 50,000 requests |
| Cognito user pool | 0.60 | 0.60 | Traffic, not MAU, grows |
| Secrets Manager | 1.20 to 1.60 | 1.20 to 1.60 | Fixed |
| CloudWatch Logs | 0.08 | 0.40 | 0.75 GB ingested |
| CloudFront requests | 0.11 | 0.55 | 550,000 requests |
| CloudFront data transfer out | 0.05 | 0.23 | 2.75 GB |
| S3 config reads | 0.06 | 0.06 | Bounded by the cache periods, not by traffic, while one warm container per function carries the load |
| Photo upload PUTs | 0.00 | 0.00 | 500 PUTs |
| Photo storage, first month | 0.01 | 0.03 | 1.5 GB added each month; about 0.41 a month after 12 months |
| **Total** | **2.29 to 2.69** | **4.02 to 4.42** | |
| **Per year** | **about 27 to 32** | **about 48 to 53** | |

The original estimate checked against a target of 30 USD a year. The base estimate is under it only without VAPID: about 27 a year with three secrets, about 32 with four. At 5x it is over in both cases. The original stress check came to about 29 a year, but it priced two secrets, had no Cognito or config-read lines, and left out the auth edge, `/auth/*` requests and response transfer. The extra secrets add 4.80 to 9.60 a year and the Cognito line adds 7.20. With the Free Tier allowances, both traffic levels are under the target; see the next section.

## With the AWS Free Tier

If the account's Free Tier allowances are not used up by other workloads, the Lambda, CloudFront, CloudWatch Logs and Cognito lines cost nothing at both traffic levels. Each use below is inside its allowance.

| Allowance | Per account per month | Use at base | Use at 5x | Line it brings to 0.00 |
| --- | --- | --- | --- | --- |
| Lambda requests | 1,000,000 | 110,000 | 550,000 | Both Lambda lines |
| Lambda compute | 400,000 GB-s | 5,250 GB-s | 26,250 GB-s | Both Lambda lines |
| CloudFront requests | 10,000,000 | 110,000 | 550,000 | CloudFront requests |
| CloudFront data transfer out | 1 TB | 0.55 GB | 2.75 GB | CloudFront data transfer out |
| CloudWatch Logs | 5 GB | 0.15 GB | 0.75 GB | CloudWatch Logs |
| Cognito MAU (Lite and Essentials) | 10,000 | About 40 | About 40 | Cognito user pool (0.60) |

| | Monthly USD | Per year |
| --- | --- | --- |
| Base | 1.36 to 1.76 | About 16 to 21 |
| 5x | 1.78 to 2.18 | About 21 to 26 |

What remains is mostly the secrets line.

## Static-site baseline

The static site's cost is not part of the app-backend total. Two pre-E5 documents estimated it: [`cloudfront/README.md`](https://github.com/me-jreese/harrisonfamily/blob/3a6ada5bacaa73aa20e5a6511caba717fda22225/cloudfront/README.md) and [`harrisonfamily-frontend/README.md`](https://github.com/me-jreese/harrisonfamily/blob/3a6ada5bacaa73aa20e5a6511caba717fda22225/harrisonfamily-frontend/README.md) as of commit `3a6ada5`. Both directories now hold short pointers. Both documents used generic volumes, not this site's measured traffic. The table re-prices their volumes at the same list prices.

| Line | Volume | Unit price | Monthly USD | Older figure |
| --- | --- | --- | --- | --- |
| CloudFront HTTPS requests | 1,000,000 | $0.0100 per 10,000 | 1.00 | About 0.50 in `cloudfront/README.md` |
| CloudFront data transfer out | 50 GB | $0.085 per GB | 4.25 | About 5 in `cloudfront/README.md`; 5 to 10 in `harrisonfamily-frontend/README.md` |
| CloudFront Function (`HFYAppendIndex`), if attached to the default behavior | One execution per default-behavior request, so 1,000,000 | First 2,000,000 a month $0.00 | 0.00 | Not given |
| Invalidations | One `/*` path per deploy, and one more per rollback (the `invalidate` list in [`ci.manifest.yaml`](../../ci.manifest.yaml)) | First 1,000 paths a month $0.00 | 0.00 | Not given |
| S3 storage, site bucket | The bucket's size in GB | $0.023 per GB-month | 1 to 3 if the older figure is right, which implies 43 to 130 GB | 1 to 3 in `harrisonfamily-frontend/README.md` |
| S3 GETs on cache misses | Only requests CloudFront cannot answer from cache | $0.004 per 10,000 | Under 0.05 (100,000 misses would be 0.04) | Not given |
| **Total** | | | **About 6.30 to 8.30 a month, about 75 to 100 a year** | Under 10 a month in `cloudfront/README.md` |

Reconciliation notes:

- `cloudfront/README.md` priced 1,000,000 requests at about 0.50. At the US HTTPS rate of $0.0100 per 10,000 they cost 1.00. Even the HTTP rate of $0.0075 per 10,000 gives 0.75, and every behavior redirects HTTP to HTTPS.
- `harrisonfamily-frontend/README.md` gives monthly lines of 1 to 3 (S3) and 5 to 10 (CloudFront transfer), which add up to 6 to 13 a month, or 72 to 156 a year. Its "total annual cost" of under 30 contradicts its own lines, so it is dropped here. The monthly "under 10" in `cloudfront/README.md` is consistent with the re-priced lines.
- Where the account has the CloudFront Free Tier allowances, these request and transfer volumes cost nothing. That leaves S3 storage as the static site's main cost.
- Views of post photos count here, not in the app-backend total. Photos are served from the site bucket through the `/uploads/*` behavior (`MediaPublicBase` in [`app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml); `CachingOptimized`, no function), so each GB viewed is $0.085 of transfer out. For example, 100 photos of 3 MB each, each viewed 40 times, is 12 GB, about 1.02 a month.

## Related pages

- [Edge and origin design: What drives cost](../explanation/edge-and-origin-design.md#what-drives-cost), [Member content design](../explanation/member-content-design.md), [Release model](../explanation/release-model.md)
- [Architecture reference](architecture.md), [Codebase map](codebase-map.md), [Private data and secrets](private-data-and-secrets.md)
- [Deploy the app stack](../how-to/deploy-the-app-stack.md), [Stand up the static site](../how-to/stand-up-the-static-site.md)
