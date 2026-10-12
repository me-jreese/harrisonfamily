# System architecture

Reference for the deployed system: edge, storage, compute, identity store, data and stacks.

The region is `us-west-2`, except for the parts that AWS requires in `us-east-1`: the CloudFront certificate, because CloudFront only accepts certificates from that region, and the two Lambda@Edge stacks, `hfy-edge-gate` and `hfy-mcp-edge401`, because Lambda@Edge functions can only be created there. `<edge-code-bucket>`, which holds the gate's code, is in `us-east-1` too, because Lambda loads code only from a bucket in the function's own region. CloudFront runs Lambda@Edge replicas at its edge locations, so their logs land in the regions of those locations, not only in `us-east-1` ([Compute](#compute)). Values in angle brackets, such as `<site>`, `<app-stack>`, `<site-bucket>`, `<edge-code-bucket>`, `<distribution-id>`, `<aws-account-id>` and `<github-owner>`, are placeholders for deployment-specific identifiers; the forms are listed in [Private data and secrets](private-data-and-secrets.md#placeholders). For why the system is shaped this way, read [Why one CloudFront distribution fronts everything](../explanation/edge-and-origin-design.md), [The identity model](../explanation/identity-model.md) and [The privacy model for family data](../explanation/family-data-privacy.md).

## Overview

```text
browser ──HTTPS──▶ Cloudflare (proxies <site>) ──HTTPS──▶ CloudFront <distribution-id>   (ACM certificate in us-east-1)
  ├─ /api/check-allowed* (legacy pin, ordered before /api/*)
  │          ──────────────────▶ API Gateway ▶ Lambda hfy-check-allowed
  ├─ /api/*  ──X-Origin-Verify──▶ Function URL ▶ Lambda hfy-api
  ├─ /auth/*,
  │  /.well-known/oauth-authorization-server*
  │          ──X-Origin-Verify──▶ Function URL ▶ Lambda hfy-auth-edge
  ├─ /uploads/* ──OAC───────────▶ S3 <site-bucket>/uploads/   (nosniff + sandbox CSP)
  ├─ /person/*.json, /family/*, /event/*, /note/*, /place/*, /media/*
  │          viewer-request: Lambda@Edge hfy-edge-gate (io_id session check; 401 or 302 when it fails)
  │          ──OAC───────────▶ S3 <site-bucket>   (CachingDisabled, Cache-Control: private, no-store)
  ├─ /mcp*,
  │  /.well-known/oauth-protected-resource*
  │          ──X-Origin-Verify──▶ Function URL ▶ Lambda hfy-api (MCP mount)
  │          origin-response: Lambda@Edge hfy-mcp-edge401 (restores WWW-Authenticate on 401)
  └─ default (*) ──OAC──────────▶ S3 <site-bucket>   (HFYAppendIndex on viewer-request)

hfy-api         ▶ DynamoDB hfy-app
                ▶ S3 <config-bucket>/config/ (admins.json; groups.json for MCP)
                ▶ S3 <site-bucket>: presigned PUT into uploads/posts/; GetObject on person/* (author labels)
                ▶ JWKS from https://<site>/auth/.well-known/jwks.json (back through Cloudflare and CloudFront)
                ▶ Secrets Manager (VAPID secret) and web push services (subscription endpoints), only when HasVapid
hfy-auth-edge   ▶ DynamoDB hfy-app (refresh tokens, links, passkeys and their challenges, MCP codes and tokens, rate counters)
                ▶ S3 <config-bucket> (allowlist, admins) · Cognito hfy-users
                ▶ Secrets Manager (session signing key)
                ▶ Google signing keys, to verify GIS ID tokens (the kit's Google provider)
hfy-edge-gate   ▶ JWKS from https://<site>/auth/.well-known/jwks.json (back through Cloudflare and CloudFront)
hfy-mcp-edge401 ▶ nothing; it edits the response it is given
```

The diagram shows every outbound dependency of the app stack's two functions and of the two Lambda@Edge functions. Passkey credentials and challenges are stored by the auth edge, in the same table as its other records; nothing on the API side reads them. While `authV2` is `false`, the default, sign-in goes through the legacy `/api/check-allowed` path, not the auth edge; see [Legacy check-allowed route](#legacy-check-allowed-route). The six gated data behaviors exist only once the gate is attached, which the cutover does after it flips `authV2` ([How to cut over to authV2 and the private data gate](../how-to/cut-over-to-the-private-data-gate.md)).

## Request routing

One CloudFront distribution, `<distribution-id>`, serves the whole site, with Cloudflare proxying `<site>` in front of it ([Distribution settings](#distribution-settings)). The live distribution configuration is not in the repository. [`cloudfront/distribution.json`](../../cloudfront/distribution.json) is a sanitized template of the configuration before the behavior scripts ran: the S3 origin, plus the legacy API Gateway origin behind `/api/*`. Values marked *(sample)* come from the sanitized sample configuration that predates E5, so the default behavior below is documented, not verifiable. The behaviors that the scripts in [`scripts/infra/`](../../scripts/infra/) add are defined exactly by those scripts. The legacy pin copies whatever behavior served `/api/check-allowed` before.

| Path pattern | Origin | Viewer protocol | Allowed methods | Cache policy | Origin request policy | Response headers policy | Functions | Defined by |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `/api/check-allowed*` (legacy pin) | The origin that served `/api/check-allowed` before, normally the `hfy-check-allowed` API Gateway | Copied | Copied | Copied | Copied | Copied | Copied | Cloned by [`scripts/infra/add-api-behavior.sh`](../../scripts/infra/add-api-behavior.sh) (HFY-R58); see [Legacy check-allowed route](#legacy-check-allowed-route) |
| `/api/*` | `hfy-api-origin` | redirect-to-https | GET, HEAD, OPTIONS, PUT, POST, PATCH, DELETE | CachingDisabled | AllViewerExceptHostHeader | none | none | [`scripts/infra/add-api-behavior.sh`](../../scripts/infra/add-api-behavior.sh) |
| `/auth/*` | `hfy-auth-origin` | redirect-to-https | GET, HEAD, OPTIONS, PUT, POST, PATCH, DELETE | CachingDisabled | AllViewerExceptHostHeader | none | none | [`scripts/infra/add-auth-behavior.sh`](../../scripts/infra/add-auth-behavior.sh) |
| `/.well-known/oauth-authorization-server*` | `hfy-auth-origin` | redirect-to-https | GET, HEAD, OPTIONS, PUT, POST, PATCH, DELETE | CachingDisabled | AllViewerExceptHostHeader | none | none | [`scripts/infra/add-auth-behavior.sh`](../../scripts/infra/add-auth-behavior.sh) |
| `/uploads/*` | The default behavior's S3 origin, or `--origin-id` | redirect-to-https | GET, HEAD | CachingOptimized | none | The stack's `UploadsResponseHeadersPolicy`: `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox; default-src 'none'; img-src 'self'` | none, so `HFYAppendIndex` does not run | [`scripts/infra/add-uploads-behavior.sh`](../../scripts/infra/add-uploads-behavior.sh) (HFY-R58) |
| `/person/*.json` | The default behavior's S3 origin, or `--origin-id` | redirect-to-https | GET, HEAD | CachingDisabled | none | `hfy-private-no-store` | Lambda@Edge viewer-request: `hfy-edge-gate`. No CloudFront Function | [`scripts/infra/add-data-gate-behaviors.sh`](../../scripts/infra/add-data-gate-behaviors.sh) (HFY-TSK-080) |
| `/family/*` | The default behavior's S3 origin, or `--origin-id` | redirect-to-https | GET, HEAD | CachingDisabled | none | `hfy-private-no-store` | Lambda@Edge viewer-request: `hfy-edge-gate`. No CloudFront Function | [`scripts/infra/add-data-gate-behaviors.sh`](../../scripts/infra/add-data-gate-behaviors.sh) |
| `/event/*` | The default behavior's S3 origin, or `--origin-id` | redirect-to-https | GET, HEAD | CachingDisabled | none | `hfy-private-no-store` | Lambda@Edge viewer-request: `hfy-edge-gate`. No CloudFront Function | [`scripts/infra/add-data-gate-behaviors.sh`](../../scripts/infra/add-data-gate-behaviors.sh) |
| `/note/*` | The default behavior's S3 origin, or `--origin-id` | redirect-to-https | GET, HEAD | CachingDisabled | none | `hfy-private-no-store` | Lambda@Edge viewer-request: `hfy-edge-gate`. No CloudFront Function | [`scripts/infra/add-data-gate-behaviors.sh`](../../scripts/infra/add-data-gate-behaviors.sh) |
| `/place/*` | The default behavior's S3 origin, or `--origin-id` | redirect-to-https | GET, HEAD | CachingDisabled | none | `hfy-private-no-store` | Lambda@Edge viewer-request: `hfy-edge-gate`. No CloudFront Function | [`scripts/infra/add-data-gate-behaviors.sh`](../../scripts/infra/add-data-gate-behaviors.sh) |
| `/media/*` | The default behavior's S3 origin, or `--origin-id` | redirect-to-https | GET, HEAD | CachingDisabled | none | `hfy-private-no-store` | Lambda@Edge viewer-request: `hfy-edge-gate`. No CloudFront Function | [`scripts/infra/add-data-gate-behaviors.sh`](../../scripts/infra/add-data-gate-behaviors.sh) |
| `/mcp*` and `/.well-known/oauth-protected-resource*` | `hfy-api-origin` | redirect-to-https | GET, HEAD, OPTIONS, PUT, POST, PATCH, DELETE | CachingDisabled | AllViewerExceptHostHeader | none | Lambda@Edge origin-response: `hfy-mcp-edge401`, `IncludeBody` false | [`scripts/infra/add-mcp-behavior.sh`](../../scripts/infra/add-mcp-behavior.sh) |
| Default (`*`) | S3 `<site-bucket>` via OAC | redirect-to-https | GET, HEAD, OPTIONS (sample) | CachingOptimized (sample) | CORS-S3Origin (sample) | Custom security-headers policy: `Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` (sample) | `HFYAppendIndex`, viewer-request | Not in the repo; created by [How to stand up the static site](../how-to/stand-up-the-static-site.md#3-create-the-distribution) |

- **The gated data behaviors.** The pattern is `/person/*.json`, not `/person/*`, because `/person/` itself is the public person-page shell, which the default behavior's `HFYAppendIndex` resolves to `/person/index.html`. A gated `/person/*` would also catch the shell, gate a public page and skip that rewrite. Each gated behavior's association names a numbered version of `hfy-edge-gate` with `IncludeBody` false. The gate checks the `io_id` session cookie. It passes a valid request on unchanged, and answers any other with `401` for fetch, XHR and subresource requests or `302` to `/auth/login?returnTo=<path>` for a top-level navigation, both with `Cache-Control: private, no-store` ([`edge-gate/src/gate.mjs`](../../edge-gate/src/gate.mjs)). See [The privacy model for family data: Gating the JSON](../explanation/family-data-privacy.md#gating-the-json).
- **The MCP behaviors.** The association names a numbered version of `hfy-mcp-edge401` from the `us-east-1` stack of that name. On a `401`, the function copies `x-amzn-remapped-www-authenticate`, the name under which a Function URL returns the header, back into `WWW-Authenticate`, unless the response already has one. See [MCP server: CloudFront behaviors](mcp-server.md#cloudfront-behaviors).

The managed policies the scripts use:

| Policy | Kind | ID |
| --- | --- | --- |
| CachingDisabled | Cache policy | `4135ea2d-6df8-44a3-9df3-4b5a84be39ad` |
| CachingOptimized | Cache policy | `658327ea-f89d-4fab-a63d-7e88639e58f6` |
| AllViewerExceptHostHeader | Origin request policy | `b689b0a8-53d0-40ab-baf2-68738e2966ac` |

The custom response headers policies:

| Policy | Created by | Headers |
| --- | --- | --- |
| `<FunctionName>-uploads-sandbox`, `hfy-api-uploads-sandbox` with the default `FunctionName` | The app stack's `UploadsResponseHeadersPolicy` resource; its ID is the stack output `UploadsResponseHeadersPolicyId` | `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox; default-src 'none'; img-src 'self'`, both with override |
| `hfy-private-no-store` | [`add-data-gate-behaviors.sh`](../../scripts/infra/add-data-gate-behaviors.sh), not a stack (HFY-R65). The script finds the policy by name, creates it when it is missing, and puts it back when it no longer forces the header. `--response-headers-policy-name` changes the name; `--response-headers-policy-id` skips the lookup. `--remove` leaves the policy in place, unused | A single custom header, `Cache-Control: private, no-store`, with `Override: true` |

Apart from the cloned pin, all the script-built behaviors set `Compress: true` and have no CloudFront Function. `/api/*`, `/auth/*`, root discovery and `/uploads/*` have no Lambda@Edge association either; the gated behaviors and the MCP behaviors have one each, as above. Both Lambda@Edge scripts refuse a `$LATEST` or unqualified function ARN. `CachedMethods` is GET, HEAD on every script-built behavior, which has no effect under CachingDisabled: nothing on the Lambda paths or the gated data paths is cached by CloudFront. On `/uploads/*`, each upload key is unique, so caching is safe.

- **Order.** CloudFront tries cache behaviors in list order and uses the first match; the default behavior applies last. The scripts merge in place: an origin with the same ID, or a behavior with the same path pattern, keeps its position and every field the script does not manage, and a missing one is appended at the end of its list. Three rules can change that:
  - `add-api-behavior.sh` places the legacy pin immediately before the first other behavior that matches `/api/check-allowed` (`place_pin` in [`cf.jq`](../../scripts/infra/lib/cf.jq)).
  - `add-data-gate-behaviors.sh` moves each gated pattern just ahead of the first other behavior that would also match it, such as a legacy `/person/*` (`place_before_shadow` in `cf.jq`). A gated behavior that is already ahead, or that nothing else matches, stays where it is.
  - `add-mcp-behavior.sh` moves nothing. When an earlier behavior already matches `/mcp` or `/.well-known/oauth-protected-resource` and would shadow the MCP behavior, it exits `3` and changes nothing.

  The resulting order is: the existing behaviors, the pin, `/api/*`, `/auth/*` and root discovery, `/uploads/*`, the six gated patterns, then `/mcp*` and `/.well-known/oauth-protected-resource*`. Apart from the pin and the gated patterns, no two of these patterns match the same path, so their relative order does not affect routing.
- **Re-runs.** A script whose result equals the live configuration (compared in a normalized form) prints `no change` and makes no `update-distribution` call. Before a real update it saves the configuration it read as a backup. [Repository operations](repository-operations.md#cloudfront-behavior-scripts) has the full behavior.
- **Gate rollback.** `add-data-gate-behaviors.sh --remove` deletes the six gated patterns, but only those that carry an `hfy-edge-gate` association (`remove_gate_behaviors` in `cf.jq`). The data paths then fall through to the default behavior, or to any legacy behavior that matches them, and are public again.
- **Stack names.** `add-api-behavior.sh`, `add-auth-behavior.sh`, `add-uploads-behavior.sh` and `add-mcp-behavior.sh` read outputs of the stack named by `--stack`, whose default, `hfy-app`, is not the live app stack's name, so each run passes `--stack <app-stack>`. `add-mcp-behavior.sh` also reads `Edge401FunctionVersionArn` from the `us-east-1` stack named by `--edge-stack` (default `hfy-mcp-edge401`), unless `--edge401-arn` or `$EDGE401_ARN` gives the ARN. `add-data-gate-behaviors.sh` reads `EdgeGateVersionArn` from the `us-east-1` stack named by its own `--stack`, whose default, `hfy-edge-gate`, is the live name, unless `--version-arn` gives the ARN.
- **Root discovery.** The auth edge's issuer is `https://<site>/auth`, so RFC 8414 discovery is served at `/.well-known/oauth-authorization-server/auth`. [`auth/src/edge.js`](../../auth/src/edge.js) answers that path; the same document is also served under `/auth/.well-known/`. Both answer only when MCP OAuth is enabled, that is when `MCP_REDIRECT_URIS` (stack parameter `McpRedirectUris`) is not empty ([`auth/src/index.js`](../../auth/src/index.js)). Otherwise both return `404 {"code":"NOT_FOUND"}`. See [Identity services](identity-services.md#mcp-authorization-server).

### Legacy check-allowed route

While `authV2` is `false`, the default in [`11ty/_data/flags.json`](../../11ty/_data/flags.json), this is the live sign-in path. The pages set `gateway.endpoint` to `/api/check-allowed`, and both [`11ty/js/feature-flags.js`](../../11ty/js/feature-flags.js) and the legacy sign-in in [`11ty/js/auth.js`](../../11ty/js/auth.js) POST to it. An API Gateway HTTP API serves the path, and `hfy-check-allowed` is the Lambda behind it. Before the app behaviors, the gateway was reached through the old `/api/*` behavior, as in [`cloudfront/distribution.json`](../../cloudfront/distribution.json). The gateway, its origin and that behavior are not in the repo IaC.

[`add-api-behavior.sh`](../../scripts/infra/add-api-behavior.sh) keeps the path on the gateway when it points `/api/*` at `hfy-api` (HFY-R58). It clones the behavior that serves `/api/check-allowed` before the change under the pattern `/api/check-allowed*`, with the same origin, policies and associations, and orders it ahead of `/api/*`. An existing pin is kept exactly as it is on every rerun. When only `hfy-api` or the default behavior would serve the path and no pin exists, the script refuses with exit `3` unless `--legacy-origin <origin-id>` names the origin to pin to. The pin is never removed by the script; HFY-TSK-069 retires it. [Repository operations](repository-operations.md#the-legacy-apicheck-allowed-pin) gives each case.

If the pin is missing, `POST /api/check-allowed` reaches `hfy-api`, which has no such route and returns `404` with code `not_found` ([`api/src/handler.js`](../../api/src/handler.js)), and legacy sign-in is broken for as long as `authV2` is off. The live order is shown by `aws cloudfront get-distribution-config --id <distribution-id>`. The symptom is in [How to diagnose sign-in and API failures](../how-to/diagnose-sign-in-and-api-failures.md#legacy-check-allowed-returns-404).

### HFYAppendIndex

A CloudFront Function (runtime `cloudfront-js-1.0`) on the default behavior's viewer-request event. Source: [`scripts/cloudfront/append-index.js`](../../scripts/cloudfront/append-index.js). It is created and published by hand ([How to stand up the static site](../how-to/stand-up-the-static-site.md#4-create-and-attach-hfyappendindex)). It does not run on `/uploads/*` or on the gated data behaviors, which have no CloudFront Function.

| Request URI | Rewritten to |
| --- | --- |
| Ends in `/` | URI + `index.html` |
| Contains no `.` | URI + `/index.html` |
| Anything else | Unchanged |

### Distribution settings

| Setting | Value | Source |
| --- | --- | --- |
| Aliases | Apex and `www` of `<site>` | Sample and template |
| Viewer certificate | ACM certificate in `us-east-1`, `sni-only` | Template |
| Price class | `PriceClass_100` | Sample and template |
| Default root object | `index.html` | Sample |
| In front of the distribution | Cloudflare proxies `<site>` (HFY-R65). Cloudflare caches some responses by file extension, such as images, SVG and PDF, whatever CloudFront's cache policy says, unless the response says `private` or `no-store`. The gated behaviors therefore carry `hfy-private-no-store`, and no Cloudflare Cache Rule may override the edge TTL on the gated prefixes | Operational; the header of [`add-data-gate-behaviors.sh`](../../scripts/infra/add-data-gate-behaviors.sh), [How to cut over to authV2 and the private data gate](../how-to/cut-over-to-the-private-data-gate.md) |

## Origins

| Origin ID | Domain | Connection | Access control | Custom header | Defined by |
| --- | --- | --- | --- | --- | --- |
| Not in the repo | `<site-bucket>` S3 endpoint | S3 origin | Origin Access Control | None | Console or CLI ([How to stand up the static site](../how-to/stand-up-the-static-site.md#3-create-the-distribution)). Also the origin of `/uploads/*` and the gated behaviors, unless `--origin-id` names another |
| `hfy-api-origin` | Host of the `<app-stack>` output `FunctionUrl` | Custom origin, `https-only`, `TLSv1.2`, ports 80/443, read timeout 30 s, keep-alive 5 s, empty origin path | None (`OriginAccessControlId` is empty) | `X-Origin-Verify` | [`add-api-behavior.sh`](../../scripts/infra/add-api-behavior.sh) and [`add-mcp-behavior.sh`](../../scripts/infra/add-mcp-behavior.sh), which write the same settings |
| `hfy-auth-origin` | Host of the `<app-stack>` output `AuthFunctionUrl` | Same as `hfy-api-origin` | None | `X-Origin-Verify` | [`add-auth-behavior.sh`](../../scripts/infra/add-auth-behavior.sh) |
| Not in the repo (`api-gateway-hfy-check-allowed` in the sample) | The legacy `hfy-check-allowed` API Gateway endpoint | Custom origin with an origin path (sample: `https-only`, `TLSv1.2`) | None | None | Console or CLI, before E5. Reached through the `/api/check-allowed*` pin |

- **Header value.** `add-api-behavior.sh`, `add-auth-behavior.sh` and `add-mcp-behavior.sh` each take the `X-Origin-Verify` value from `$ORIGIN_VERIFY` or from the Secrets Manager secret `harrisonfamily/cloudfront/origin-verify`, write it into the distribution config, and redact it in every diff they print. `--dry-run` prints the redacted diff and changes nothing. The distribution holds its own copy of the value.
- **Origin check.** Both Lambdas check the header before any routing ([`api/src/origin.js`](../../api/src/origin.js), [`auth/src/origin.js`](../../auth/src/origin.js)), so it also guards `/mcp*` and the protected-resource metadata. The comparison is constant-time over SHA-256 digests. A missing or wrong header, or an unset `ORIGIN_VERIFY`, returns `403 {"error":"forbidden"}`.
- **Timeouts.** Both functions time out at 15 s, inside the 30 s origin read timeout.

## Buckets

None of the buckets is managed by a stack.

### `<site-bucket>`

| Prefix | Contents | Written by | Excluded from the deploy's `--delete` |
| --- | --- | --- | --- |
| Root | The static site, synced from `11ty/` | The `s3_static` target in [`ci.manifest.yaml`](../../ci.manifest.yaml), run by [`.github/workflows/io-kit-deploy.yml`](../../.github/workflows/io-kit-deploy.yml) | No (this is what the sync owns) |
| `person/`, `family/`, `event/`, `note/`, `place/`, `media/` | Private Gramps data and media. Served through the six gated behaviors once the gate is attached | The private data sync ([How to refresh the family data from Gramps](../how-to/refresh-the-family-data.md)), which syncs these six prefixes and nothing else | Yes: `person/*.json`, `media/*`, `family/*`, `event/*`, `note/*`, `place/*` |
| `uploads/posts/<ulid>/<name>` | Photos attached to member posts (`UPLOAD_PREFIX` in [`api/src/uploads.js`](../../api/src/uploads.js), HFY-R58). Served through the `/uploads/*` CloudFront behavior | Browsers, by presigned PUT issued by `hfy-api` | Yes: `uploads/*`. The deploy role also denies `s3:PutObject` and `s3:DeleteObject` here ([`github-roles.yaml`](../../infrastructure/cloudformation/github-roles.yaml), `ProtectMemberUploads`) |
| `media/posts/<ulid>/<name>` | Legacy: photos uploaded before HFY-R58, if any remain. Nothing moved them | No writer since HFY-R58 | Yes, under `media/*`. The private data sync deletes them unless run with `--no-delete` |
| `js/islands/` | Island bundles | The `11ty/` sync, from the committed build output (HFY-R58) | No (this is site output) |

- **Reads.** CloudFront reads the bucket through OAC. The bucket policy that [How to stand up the static site](../how-to/stand-up-the-static-site.md#1-create-the-site-bucket) applies allows `s3:GetObject` only to `cloudfront.amazonaws.com` for this distribution, with Block Public Access on. Inside the account, `hfy-api` reads `person/<gramps-id>.json` for author labels through its role's `PersonRecords` statement (HFY-R68), and nothing else in the bucket.
- **Island bundles.** `11ty/js/islands/` is committed, so every deploy ships the bundles in the commit and its `--delete` sync removes any bundle that is not committed. See [How to build and preview the React islands](../how-to/build-and-preview-the-islands.md).
- **Uploads.** `/uploads/*` is served from the same S3 origin through its own behavior, with the uploads response headers policy and without the gate. The private data sync cannot name `uploads/`, and the site deploy excludes it.
- **CORS rule.** Applied by hand from [`infrastructure/cloudformation/media-bucket-cors.json`](../../infrastructure/cloudformation/media-bucket-cors.json), after its `_comment` key is removed. It allows origin `https://<site>`, method `PUT`, headers `Content-Type` and `Content-Length`, and `MaxAgeSeconds` 3000.

### `<config-bucket>`

| Key | Contents | Read by |
| --- | --- | --- |
| `config/userGrampsID.json` | Map of verified email to Gramps ID | `hfy-auth-edge` (sign-in resolver, cached 300 s; MCP membership, cached 60 s); `hfy-check-allowed` (legacy, cached per container) |
| `config/allowed_hashes.json` | Array of HMAC-SHA256 hex digests of allowlisted emails | `hfy-check-allowed` (legacy, cached per container) |
| `config/admins.json` | Array of Gramps IDs, or `{"admins": [...]}`. May be absent, which means no admins (no moderators) | `hfy-api` (cached 60 s, fails closed); `hfy-auth-edge` (MCP `admins` group, cached 60 s) |
| `config/groups.json` | The MCP groups `mcp-authors` and `hfy-admin`; the shape is in [`api/src/policy.js`](../../api/src/policy.js) and [MCP server: Groups](mcp-server.md#groups) | `hfy-api`, for MCP authorization only (cached 60 s, fails closed) |

- **Locations.** The edge takes this bucket and the allowlist key from [`auth/edge.manifest.json`](../../auth/edge.manifest.json) (`resolver`), and the admin key from `ADMIN_LIST_KEY`. The API takes the admin list from `ADMIN_LIST_BUCKET` and `ADMIN_LIST_KEY`, and the groups file from `GROUPS_BUCKET` and `GROUPS_KEY`. The stack sets neither `GROUPS_*` variable, so the code defaults, `<config-bucket>` and `config/groups.json`, apply.
- **A missing or unreadable file.** A missing `config/admins.json` makes nobody an admin: `hfy-api` logs `admin list unavailable (failing closed)` and retries after 5 s, and the edge's MCP membership logs `admin list unavailable (nobody is admin)` and grants no `admins` group. A missing or unparsable `config/groups.json` grants no MCP group to anyone and is retried after 5 s.
- **Writers.** No script in the repository writes `config/groups.json`. See [How to add or remove a family member's access](../how-to/manage-family-access.md).

### `<code-bucket>`

| Key | Contents | Built by |
| --- | --- | --- |
| `lambda/hfy-api-<sha>.zip` | `hfy-api` package, built from commit `<sha>` | [`scripts/ci/package-api.sh`](../../scripts/ci/package-api.sh), into `dist/hfy-api.zip` |
| `lambda/hfy-auth-edge-<sha>.zip` | `hfy-auth-edge` package, including `edge.manifest.json`, built from commit `<sha>` | [`scripts/ci/package-auth.sh`](../../scripts/ci/package-auth.sh), into `dist/hfy-auth-edge.zip` |

- **Commit-named keys.** Each deploy uploads the packages under keys named for the commit and passes them as `CodeKey` and `AuthCodeKey`. CloudFormation updates a function's code only when its code location changes, so a new zip uploaded over a key the stack already uses would not reach the function.
- **Template defaults.** `CodeKey` defaults to `lambda/hfy-api.zip` and `AuthCodeKey` to `lambda/hfy-auth-edge.zip`. Deploys never use them.
- **Uploads.** No script uploads the zips; that is a manual step before a stack deploy. See [How to deploy the app stack](../how-to/deploy-the-app-stack.md).

### `<edge-code-bucket>`

A private S3 bucket in `us-east-1` that holds the gate's code. `<code-bucket>` cannot, because Lambda loads code only from a bucket in the function's own region.

| Key | Contents | Built by |
| --- | --- | --- |
| `lambda/hfy-edge-gate-<16 hex>.zip` | `hfy-edge-gate` package: `index.mjs`, `gate.mjs` and `config.json`, a copy of [`edge-gate/gate.config.json`](../../edge-gate/gate.config.json) | [`scripts/ci/package-edge-gate.sh`](../../scripts/ci/package-edge-gate.sh), into `dist/hfy-edge-gate.zip`. It prints `CodeKey` and `CodeSha256` and writes them to `dist/hfy-edge-gate.params` |

- **Content-addressed keys.** `<16 hex>` is the first 16 hex digits of the zip's SHA-256. The zip is reproducible, with fixed modification times, so the same sources always give the same key. The stack's `CodeKey` parameter accepts only this form.
- **Never overwritten.** New code is always a new key. Different bytes uploaded to a deployed key would leave the function's code unchanged, and the new `CodeSha256` would then fail the version publish.
- **Size.** The package script refuses a zip of 1 MB or more, the limit for a viewer-request function.
- **Uploads.** Manual, with `--region us-east-1`. See [How to deploy and update the Lambda@Edge functions](../how-to/deploy-the-edge-functions.md). `hfy-mcp-edge401` needs no bucket: its code is inline in its template.

## Compute

| Function | Runtime and architecture | Memory | Timeout | Handler | Invoked through | Defined by |
| --- | --- | --- | --- | --- | --- | --- |
| `hfy-api` | `nodejs22.x`, `arm64` | 256 MB | 15 s | `src/index.handler` | Function URL, AuthType `NONE`, `BUFFERED`, behind `/api/*`, `/mcp*` and `/.well-known/oauth-protected-resource*` | [`app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml) |
| `hfy-auth-edge` | `nodejs22.x`, `arm64` | 512 MB | 15 s | `src/index.handler` | Function URL, AuthType `NONE`, `BUFFERED`, behind `/auth/*` and root discovery | [`app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml) |
| `hfy-edge-gate` | `nodejs22.x`, `x86_64` | 128 MB | 5 s | `index.handler` | Lambda@Edge, viewer-request, on the six gated behaviors | [`edge-gate-stack.yaml`](../../infrastructure/cloudformation/edge-gate-stack.yaml), stack `hfy-edge-gate` in `us-east-1`; code in [`edge-gate/`](../../edge-gate/) |
| `hfy-mcp-edge401` | `nodejs22.x`; the template sets no architecture, so the Lambda default, `x86_64` | 128 MB | 3 s | `index.handler`, inline code | Lambda@Edge, origin-response, on `/mcp*` and `/.well-known/oauth-protected-resource*` | [`mcp-edge401.us-east-1.yaml`](../../infrastructure/mcp-edge401.us-east-1.yaml), stack `hfy-mcp-edge401` in `us-east-1` |
| `hfy-check-allowed` (legacy) | Not in the repo; the kit build packages it with Node 20 | Not in the repo | Not in the repo | `handler` exported from [`index.mjs`](../../lambda/hfy-check-allowed/index.mjs) | `/api/check-allowed`, through API Gateway ([route](#legacy-check-allowed-route)) | Not in IaC; code shipped by the `lambda` target in [`ci.manifest.yaml`](../../ci.manifest.yaml), through [`io-kit-deploy.yml`](../../.github/workflows/io-kit-deploy.yml) |
| `getAllowlist` (legacy, Google Cloud) | `python311`, Cloud Functions gen2, region `us-west2` | Default | Default | `get_allowlist` in [`main.py`](../../functions/get-allowlist/main.py) | HTTP trigger with `--no-allow-unauthenticated` | [`deploy-gcf-legacy.yml`](../../.github/workflows/deploy-gcf-legacy.yml) (`gcloud functions deploy`) |

- **App stack functions.** `hfy-api` and `hfy-auth-edge` each have a log group `/aws/lambda/<name>` with 30-day retention, a role `<name>-role`, and two resource policies for principal `*`: `lambda:InvokeFunctionUrl` with `FunctionUrlAuthType: NONE`, and `lambda:InvokeFunction` with `InvokedViaFunctionUrl: true`. The origin check is the only gate on the URL.
- **Lambda@Edge functions.** CloudFront runs them only through a numbered version, which each stack publishes and keeps (`Retain`) because CloudFront replicas pin it. They have no Function URL and no resource policy, and neither stack creates a log group: Lambda@Edge writes to a log group named `/aws/lambda/us-east-1.<function>` in the region of the edge location that ran the function, so the logs are spread across the edge regions. Neither function holds a secret: the gate verifies sessions against the auth edge's public JWKS.
- **Legacy functions.** Both are scheduled to be replaced by the auth edge (HFY-TSK-062), and both are still deployed on every push to `main`: [`io-kit-deploy.yml`](../../.github/workflows/io-kit-deploy.yml) updates `hfy-check-allowed`, and [`deploy-gcf-legacy.yml`](../../.github/workflows/deploy-gcf-legacy.yml) deploys `getAllowlist`.
  - `hfy-check-allowed` is on the live sign-in path. `authV2` is `false`, the default in [`11ty/_data/flags.json`](../../11ty/_data/flags.json), and with it off [`11ty/js/auth-v2.js`](../../11ty/js/auth-v2.js) does nothing and the legacy flow runs: `/api/check-allowed` to `hfy-check-allowed` ([route](#legacy-check-allowed-route)). The auth edge handles sign-in only when `authV2` is on.
  - `getAllowlist` is on no sign-in path, and nothing in the repo calls it. The first line of its workflow marks it `retired by HFY-TSK-062`, but the workflow's triggers are active ([Identity services](identity-services.md#legacy-getallowlist)).
  - The planned retirement order is in [The identity model](../explanation/identity-model.md#retirement-order-once-authv2-is-flipped).

### Environment

| Function | Variables set by the stack |
| --- | --- |
| `hfy-api` | `TABLE_NAME`, `SESSION_JWKS_URL`, `ORIGIN_VERIFY`, `SESSION_ISSUER`, `SESSION_AUDIENCE`, `SESSION_COOKIE`, `ADMIN_LIST_BUCKET`, `ADMIN_LIST_KEY`, `MEDIA_BUCKET`, `MEDIA_PUBLIC_BASE`, and `VAPID_SECRET` only when `HasVapid` is true |
| `hfy-auth-edge` | `AUTH_TABLE`, `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`, `GOOGLE_CLIENT_ID`, `MCP_REDIRECT_URIS`, `MCP_RESOURCES`, `MCP_CORS_ORIGINS`, `ORIGIN_VERIFY`, `ADMIN_LIST_KEY` |
| `hfy-edge-gate` | None. Lambda@Edge has no environment variables. The issuer, audience, JWKS URL, cookie name (`io_id`), login path (`/auth/login`) and JWKS cache timings are baked into the zip from [`edge-gate/gate.config.json`](../../edge-gate/gate.config.json) |
| `hfy-mcp-edge401` | None |

- **Not set by the stack.** `hfy-api` also reads `GROUPS_BUCKET`, `GROUPS_KEY` and the `MCP_*` variables (`MCP_RESOURCE_URL`, `MCP_AUDIENCE`, `MCP_TOKEN_ISSUER`, `MCP_CLIENT_IDS`, `MCP_SCOPES`). The stack sets none of them, so their code defaults apply; see [MCP server: Configuration](mcp-server.md#configuration). `hfy-auth-edge` also reads `MCP_CLIENT_ID` and `EDGE_MANIFEST_PATH` when they are set; the stack sets neither.
- **Edge manifest.** The auth edge's remaining settings, such as issuer, audience, signing-key secret name, key ID and allowlist location, come from [`auth/edge.manifest.json`](../../auth/edge.manifest.json), which is packaged with the code. For the API routes and the edge endpoints, see [API](api.md) and [Identity services](identity-services.md).

### IAM

| Role | Statement | Actions | Resource |
| --- | --- | --- | --- |
| `hfy-api-role` | `Logs` | `logs:CreateLogStream`, `logs:PutLogEvents` | Its own log group |
| | `Table` | `dynamodb:GetItem`, `PutItem`, `UpdateItem`, `DeleteItem`, `Query`, `Scan`, `BatchGetItem`, `BatchWriteItem` | `hfy-app` and `hfy-app/index/*` |
| | `AdminList` | `s3:GetObject` | `<config-bucket>/config/*`, which covers `admins.json` and `groups.json` |
| | `PostPhotoUploads` | `s3:PutObject` | `<site-bucket>/uploads/posts/*` only |
| | `PersonRecords` | `s3:GetObject` | `<site-bucket>/person/*`, for author labels (HFY-R68) |
| | `Secrets` (only when `HasVapid`) | `secretsmanager:GetSecretValue` | The VAPID secret |
| `hfy-auth-edge-role` | `Logs` | `logs:CreateLogStream`, `logs:PutLogEvents` | Its own log group |
| | `RefreshAndLinkStore` | `dynamodb:GetItem`, `PutItem`, `UpdateItem`, `DeleteItem`, `Query` | `hfy-app` and `hfy-app/index/*` |
| | `Allowlist` | `s3:GetObject` | `<config-bucket>/config/userGrampsID.json` and `<config-bucket>/config/admins.json` |
| | `SigningKey` | `secretsmanager:GetSecretValue` | `harrisonfamily/auth-edge/session-signing-key-*` |
| | `CognitoAdminLink` | `cognito-idp:AdminGetUser`, `AdminCreateUser`, `AdminSetUserPassword`, `AdminConfirmSignUp`, `AdminUpdateUserAttributes` | User pool `hfy-users` |
| `<FunctionName>-role` of the gate stack, `hfy-edge-gate-role` by default | `Logs` | `logs:CreateLogGroup`, `logs:CreateLogStream`, `logs:PutLogEvents` | Log groups `/aws/lambda/us-east-1.<FunctionName>` in any region |
| `Edge401Role` of `hfy-mcp-edge401`, with no fixed name | AWS managed policy `AWSLambdaBasicExecutionRole` | `logs:CreateLogGroup`, `logs:CreateLogStream`, `logs:PutLogEvents` | All log groups |

The two app stack roles trust `lambda.amazonaws.com`. The two edge roles trust `lambda.amazonaws.com` and `edgelambda.amazonaws.com`, as Lambda@Edge requires.

## Identity store

Cognito user pool `hfy-users`, logical ID `UserPool` in [`app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml).

| Setting | Value |
| --- | --- |
| Deletion and replacement policy | `Retain` |
| Username | Email (`UsernameAttributes: [email]`); email is auto-verified |
| Sign-up | Admin-created users only (`AllowAdminCreateUserOnly: true`, HFY-R58) |
| Email change | `AttributesRequireVerificationBeforeUpdate: [email]` |
| MFA | `OFF` |
| Password policy | At least 12 characters; lowercase, uppercase and a number required; symbols not required; temporary passwords valid 7 days |
| Account recovery | Verified email |
| Verification | `CONFIRM_WITH_CODE` |
| Email sending | `COGNITO_DEFAULT`; with `HasSes`, `DEVELOPER` through the SES identity `SesIdentityArn`, and `From` set to `SesFromAddress` with `HasSesFrom` |
| Schema | `email`, required and mutable |

App client `hfy-web`, logical ID `UserPoolClient`:

| Setting | Value |
| --- | --- |
| Client secret | None (`GenerateSecret: false`) |
| Auth flows | `ALLOW_USER_PASSWORD_AUTH`, `ALLOW_REFRESH_TOKEN_AUTH` |
| User existence errors | Prevented (`ENABLED`) |
| Identity providers | `COGNITO` |
| Token lifetimes | Refresh 30 days; access 60 minutes; ID 60 minutes |

The edge, not the browser, calls Cognito with `USER_PASSWORD_AUTH`, then mints its own RS256 session. It also uses the five admin calls in `CognitoAdminLink` to give an allowlisted, linked member a password, and to repair a user left from before the pool was locked down ([`auth/src/cognito.js`](../../auth/src/cognito.js)). Passkeys do not involve Cognito: the edge stores them in the table ([Item layout](#item-layout)).

## DynamoDB table `hfy-app`

### Definition

| Property | Value |
| --- | --- |
| Billing | `PAY_PER_REQUEST` |
| Primary key | `PK` (string, hash), `SK` (string, range) |
| Index `GSI1` | `GSI1PK` (string, hash), `GSI1SK` (string, range), projection `ALL` |
| Time to live | Attribute `ttl`, enabled |
| Point-in-time recovery | Enabled |
| Server-side encryption | Enabled (`SSEEnabled: true`) |
| Deletion and replacement policy | `Retain` |

### Item layout

This section is the single list of the table's keys: every item's `PK`, `SK`, `GSI1` keys and `ttl`. What each item holds is listed with the service that writes it, in [API: Table layout](api.md#table-layout) and [Identity services: Stored records](identity-services.md#stored-records), and those pages link here for the keys.

`<principal>` and `<gramps-id>` are the member's Gramps ID, which is the session `sub`. `<thread-id>` is `person:<gramps-id>` or `post:<ulid>`. `<credential-id>` is a passkey's WebAuthn credential ID. A dash means the attribute is not set.

Written by `hfy-api`:

| Item | PK | SK | GSI1PK / GSI1SK | `ttl` | Source |
| --- | --- | --- | --- | --- | --- |
| Post | `POST#<ulid>` | `META` | `POSTS` / `<ulid>` | - | [`api/src/content.js`](../../api/src/content.js) |
| Post, author index | `POST#<ulid>` | `IDX#AUTHOR` | `AUTHOR#<gramps-id>` / `<ulid>` | - | [`api/src/content.js`](../../api/src/content.js) |
| Post, subject index (only when the post has a subject) | `POST#<ulid>` | `IDX#SUBJECT` | `SUBJECT#<subject>` / `<ulid>` | - | [`api/src/content.js`](../../api/src/content.js) |
| Comment | `THREAD#<thread-id>` | `C#<ulid>` | `COMMENTS` / `<ulid>` | - | [`api/src/comments.js`](../../api/src/comments.js) |
| Reaction, one per principal per target | `THREAD#<thread-id>` | `R#<target>#<principal>` | - | - | [`api/src/comments.js`](../../api/src/comments.js) |
| Audit entry | `AUDIT#<record-id>` | `<iso-time>#<ulid>` | `AUDIT` / same as SK | - | [`api/src/txn.js`](../../api/src/txn.js) |
| Push subscription | `SUB#<principal>` | `ENDPOINT#<endpoint-url>` | - | 90 days after write | `@io-kit/notify` `DynamoSubscriptionStore` |
| Notification preferences | `PREF#<principal>` | `PREFS` | - | - | `@io-kit/notify` `DynamoPreferencesStore` |

Each post and comment change is one `TransactWriteItems` call that carries the data change and its `AUDIT#` item. All three post items carry the full post, so a list needs no second read. `<target>` is `root` or `comment:<ulid>`. Reactions are plain puts and deletes with no audit item.

Written by `hfy-auth-edge`, through the `@io-kit/auth` 2.1.1 stores and the local stores wired in [`auth/src/index.js`](../../auth/src/index.js). `<scope>` is `email+ip` or `ip`, and the hash covers the email and client IP, so neither is stored:

| Item | PK | SK | GSI1PK / GSI1SK | `ttl` | Source |
| --- | --- | --- | --- | --- | --- |
| Session refresh token | `REFRESH#<sha256-hex-of-token>` | `META` | - | Token expiry plus 1 day | Kit `ddbRefreshStore` |
| Revoked refresh family | `FAMILY#<family>` | `META` | - | 32 days after revocation | Kit `ddbRefreshStore` |
| Identity link, one per email | `LINK#<email>` | `META` | `SUB#<gramps-id>` / `LINK#<email>` (its own PK) | - | [`auth/src/linkstore.js`](../../auth/src/linkstore.js), around the kit `ddbLinkStore` |
| Passkey credential, one per credential | `PASSKEY#<credential-id>` | `META` | `PASSKEYSUB#<gramps-id>` / `PASSKEY#<credential-id>` (its own PK) | - | [`auth/src/passkeystore.js`](../../auth/src/passkeystore.js), around the kit `ddbPasskeyStore` |
| Passkey challenge, single use | `PASSKEYCHAL#<challenge>` | `META` | - | Challenge expiry plus 1 hour. A challenge expires 300 s after it is issued, so the item can be removed about 65 minutes after it is written | Kit `ddbChallengeStore` |
| Forgot-password counter, one per key and window | `RATE#forgot:<scope>#<sha256-base64url>` | `W#<window-seconds>#<window-start>` | - | Window end plus 300 s | [`auth/src/ratelimit.js`](../../auth/src/ratelimit.js) |

Written by `hfy-auth-edge` for MCP OAuth ([`auth/src/oauth.js`](../../auth/src/oauth.js)). Codes and tokens are stored only as base64url SHA-256 digests:

| Item | PK | SK | `ttl` |
| --- | --- | --- | --- |
| Authorization code, consumed by an atomic delete | `MCPCODE#<digest>` | `META` | 180 s |
| Refresh token | `MCPRT#<digest>` | `META` | 30 days plus 1 hour |
| Used refresh token, for replay detection | `MCPRTUSED#<digest>` | `META` | 30 days plus 1 hour |
| Revoked token family | `MCPFAM#<family>` | `META` | 30 days plus 1 hour |

Two of these items carry sign-in facts besides their keys:

- **`REFRESH#`.** The kit's record (`rec`) also stores the sign-in's `authTime` and, when it has one, its `amr`. A refresh carries both forward unchanged, so a refreshed session keeps its original authentication time. A record written before 2.1.1 has no `authTime` and refreshes with `0`.
- **`MCPCODE#` and `MCPRT#`.** Each also stores `email`, `amr`, `authTime` and `name`, the member's display label (HFY-R64, HFY-R68). The access token copies them into its `email`, `amr`, `auth_time` and `name` claims, and a token refresh never moves `auth_time` forward.

### Notes

- **GSI1 needs both keys.** DynamoDB indexes an item in `GSI1` only when the item has both `GSI1PK` and `GSI1SK`. The kit's link and passkey stores set only `GSI1PK`, so [`linkstore.js`](../../auth/src/linkstore.js) and [`passkeystore.js`](../../auth/src/passkeystore.js) wrap them to write `GSI1SK` equal to the item's own `PK`. An item written without it is healed on its next read: a link by a conditional `PutItem`, a passkey by a conditional `UpdateItem` that sets only `GSI1SK`, so that a concurrent update of the signature counter is not undone. Both conditions are `attribute_exists(PK) AND attribute_not_exists(GSI1SK)`.
- **`SUB#` appears twice without collision.** It is the PK of subscription items and the GSI1PK of link items. These are different attributes. The API's subscriber scan filters on `begins_with(PK, "SUB#")`, which link items (PK `LINK#`) and passkey items (PK `PASSKEY#`, GSI1PK `PASSKEYSUB#`) never match, and subscription items set no `GSI1PK`.
- **Access.** Both roles cover the whole table and its indexes, with no key-prefix condition. The API may `Scan`; the edge may not. The API's only scan is `scanSubscribedPrincipals` in [`api/src/notify.js`](../../api/src/notify.js), which finds push subscribers when a post is published.
- **Expiry.** TTL deletion is not immediate, so readers check `expiresAt` or `ttl` themselves.

## CloudFormation stacks

### `<app-stack>`

Template: [`infrastructure/cloudformation/app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml), deployed by hand in `us-west-2` as the stack `<app-stack>` ([How to deploy the app stack](../how-to/deploy-the-app-stack.md)). Because the roles are named, the deploy needs `CAPABILITY_NAMED_IAM`.

`hfy-app`, the `--stack` default of the app behavior scripts, is the stack name the repository assumes, not the live stack's name, so every run of those scripts passes `--stack <app-stack>` ([Request routing](#request-routing)). `hfy-app` remains the name of the DynamoDB table (the `TableName` default).

#### Parameters

| Parameter | Default | Used for |
| --- | --- | --- |
| `TableName` | `hfy-app` | Table name; `TABLE_NAME`, `AUTH_TABLE` |
| `FunctionName` | `hfy-api` | API function, log group and role names; the uploads response headers policy name |
| `CodeBucket` | None (required) | `<code-bucket>` |
| `CodeKey` | `lambda/hfy-api.zip` | API package key. Deploys pass `lambda/hfy-api-<sha>.zip` ([`<code-bucket>`](#code-bucket)) |
| `ConfigBucket` | `<config-bucket>` | `ADMIN_LIST_BUCKET`; S3 grants for both roles. Not `GROUPS_BUCKET` ([Discrepancies](#discrepancies-in-the-code)) |
| `MediaBucket` | `<site-bucket>` | `MEDIA_BUCKET`; the API's `PostPhotoUploads` grant on `uploads/posts/*` and `PersonRecords` grant on `person/*` |
| `MediaPublicBase` | `https://<site>` | `MEDIA_PUBLIC_BASE`, the origin that serves `uploads/` |
| `AdminListKey` | `config/admins.json` | `ADMIN_LIST_KEY` for both functions; edge S3 grant |
| `VapidSecretName` | Empty | `VAPID_SECRET`; drives `HasVapid` |
| `SessionIssuer` | `https://<site>/auth` | `SESSION_ISSUER` |
| `SessionAudience` | `harrisonfamily-web` | `SESSION_AUDIENCE` |
| `SessionJwksUrl` | `https://<site>/auth/.well-known/jwks.json` | `SESSION_JWKS_URL` |
| `SessionCookie` | `io_id` | `SESSION_COOKIE` |
| `AuthFunctionName` | `hfy-auth-edge` | Edge function, log group and role names |
| `AuthCodeKey` | `lambda/hfy-auth-edge.zip` | Edge package key. Deploys pass `lambda/hfy-auth-edge-<sha>.zip` |
| `UserPoolName` | `hfy-users` | User pool name |
| `AllowlistKey` | `config/userGrampsID.json` | Edge S3 grant |
| `SigningKeySecretName` | `harrisonfamily/auth-edge/session-signing-key` | Edge Secrets Manager grant |
| `McpRedirectUris` | `https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback` | `MCP_REDIRECT_URIS`; empty turns the MCP OAuth routes off |
| `McpResources` | `https://<site>/mcp` | `MCP_RESOURCES`, the resources the auth edge mints an `aud` for; the first is the default |
| `McpCorsOrigins` | `https://claude.ai,https://claude.com` | `MCP_CORS_ORIGINS` |
| `OriginVerifySecretName` | `harrisonfamily/cloudfront/origin-verify` | Dynamic reference for `ORIGIN_VERIFY` |
| `GoogleClientId` | None (required, public value) | `GOOGLE_CLIENT_ID` |
| `SesIdentityArn` | Empty | A verified SES identity, in the stack's region, for Cognito email; drives `HasSes` |
| `SesFromAddress` | Empty | The `From` address when `SesIdentityArn` is set; drives `HasSesFrom` |

#### Conditions

- `HasVapid` is true when `VapidSecretName` is not empty. It adds the `Secrets` statement to `hfy-api-role` and sets `VAPID_SECRET`. When it is false, notifications are stored and configured but not sent. [How to turn on push notifications](../how-to/turn-on-push-notifications.md) sets it. The live secret is `harrisonfamily/api/vapid`, a JSON object `{subject, publicKey, privateKey}` whose `subject` is an `https://` URL, so no email address is sent to the push services.
- `HasSes` is true when `SesIdentityArn` is not empty. The user pool then sends email through SES instead of Cognito's default sender, which allows about 50 emails a day for the account.
- `HasSesFrom` is true when `HasSes` is true and `SesFromAddress` is not empty.

#### Resources

| Logical ID | Type | Name or key properties |
| --- | --- | --- |
| `Table` | `AWS::DynamoDB::Table` | `hfy-app` ([definition](#definition)) |
| `LogGroup` | `AWS::Logs::LogGroup` | `/aws/lambda/hfy-api`, 30 days |
| `Role` | `AWS::IAM::Role` | `hfy-api-role` |
| `Function` | `AWS::Lambda::Function` | `hfy-api` |
| `FunctionUrl` | `AWS::Lambda::Url` | AuthType `NONE`, `BUFFERED` |
| `InvokeUrlPermission` | `AWS::Lambda::Permission` | `lambda:InvokeFunctionUrl`, principal `*` |
| `InvokeFunctionPermission` | `AWS::Lambda::Permission` | `lambda:InvokeFunction`, principal `*`, via Function URL |
| `UploadsResponseHeadersPolicy` | `AWS::CloudFront::ResponseHeadersPolicy` | `<FunctionName>-uploads-sandbox`: `X-Content-Type-Options: nosniff`, and `Content-Security-Policy: sandbox; default-src 'none'; img-src 'self'`, both with override |
| `UserPool` | `AWS::Cognito::UserPool` | `hfy-users`, `Retain` |
| `UserPoolClient` | `AWS::Cognito::UserPoolClient` | `hfy-web` |
| `AuthLogGroup` | `AWS::Logs::LogGroup` | `/aws/lambda/hfy-auth-edge`, 30 days |
| `AuthRole` | `AWS::IAM::Role` | `hfy-auth-edge-role` |
| `AuthFunction` | `AWS::Lambda::Function` | `hfy-auth-edge` |
| `AuthFunctionUrl` | `AWS::Lambda::Url` | AuthType `NONE`, `BUFFERED` |
| `AuthInvokeUrlPermission` | `AWS::Lambda::Permission` | `lambda:InvokeFunctionUrl`, principal `*` |
| `AuthInvokeFunctionPermission` | `AWS::Lambda::Permission` | `lambda:InvokeFunction`, principal `*`, via Function URL |

#### Outputs

| Output | Value | Read by |
| --- | --- | --- |
| `FunctionUrl` | `hfy-api` Function URL | `add-api-behavior.sh`, `add-mcp-behavior.sh` |
| `TableName` | Table name | |
| `FunctionName` | `hfy-api` | |
| `UploadsResponseHeadersPolicyId` | The uploads response headers policy | `add-uploads-behavior.sh` |
| `AuthFunctionUrl` | `hfy-auth-edge` Function URL | `add-auth-behavior.sh` |
| `AuthFunctionName` | `hfy-auth-edge` | |
| `UserPoolId` | User pool ID | |
| `UserPoolClientId` | `hfy-web` client ID | |

No output is exported.

#### Updating code

New code reaches the functions through new `CodeKey` and `AuthCodeKey` values ([`<code-bucket>`](#code-bucket)), applied as a CloudFormation change set that is reviewed before it is executed.

- **Function URLs in the change set.** `FunctionUrl` and `AuthFunctionUrl` show replacement `Conditional`. Their `TargetFunctionArn` is `!GetAtt Function.Arn` and `!GetAtt AuthFunction.Arn`, which CloudFormation treats as dynamic while it computes the change set, so it cannot rule out a replacement.
- **After execution.** The `FunctionUrl` and `AuthFunctionUrl` outputs are unchanged. The CloudFront origins `hfy-api-origin` and `hfy-auth-origin` hold those hosts, so a changed output would leave them pointing at a URL that no longer serves the function until the behavior scripts are rerun with `--stack <app-stack>`.
- **`ORIGIN_VERIFY`.** A code update modifies the function resource, so it also resolves the origin-verify reference again for that function ([`ORIGIN_VERIFY`](#origin_verify)).

#### `ORIGIN_VERIFY`

Both functions set `ORIGIN_VERIFY` to `{{resolve:secretsmanager:<OriginVerifySecretName>:SecretString}}`, with no version stage or version ID, so it names the `AWSCURRENT` version. The resolved value is stored in each function's environment configuration, and neither function reads Secrets Manager for it at runtime.

CloudFormation resolves a `secretsmanager` dynamic reference only when it creates the resource or applies an update that modifies that resource ([AWS: Secrets Manager dynamic references, Considerations](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/dynamic-references-secretsmanager.html#dynamic-references-secretsmanager-considerations)). So:

- A new value under the same secret name reaches neither function. A stack deploy that changes neither the template nor the parameters is a no-op, and one that modifies only other resources leaves both functions on the old value.
- An update that modifies one function for another reason, such as a new `CodeKey`, resolves the reference again for that function only.
- A new value takes an update that modifies both function resources, plus a re-run of the behavior scripts that write the header. [How to rotate the origin-verify secret](../how-to/rotate-the-origin-verify-secret.md) does this by creating a new secret and changing `OriginVerifySecretName`, which changes both functions' environment.

### `hfy-edge-gate`

Template: [`infrastructure/cloudformation/edge-gate-stack.yaml`](../../infrastructure/cloudformation/edge-gate-stack.yaml). It is deployed by hand in `us-east-1` as the stack `hfy-edge-gate`, with `CAPABILITY_NAMED_IAM` because the role is named ([How to deploy and update the Lambda@Edge functions](../how-to/deploy-the-edge-functions.md)).

| Parameter | Default | Used for |
| --- | --- | --- |
| `FunctionName` | `hfy-edge-gate` | Function and role names |
| `CodeBucket` | None (required) | `<edge-code-bucket>` |
| `CodeKey` | None (required). `AllowedPattern` `^lambda/hfy-edge-gate-[0-9a-f]{16}\.zip$` | The content-addressed key printed by `package-edge-gate.sh` |
| `CodeSha256` | None (required). `AllowedPattern` `^[A-Za-z0-9+/]{43}=$`, a 44-character base64 SHA-256 | The zip's SHA-256, printed by `package-edge-gate.sh`. The version publish checks the function's code against it |

**Rule.** `UsEast1Only` asserts that `AWS::Region` is `us-east-1`, so the template cannot be deployed anywhere else.

| Logical ID | Type | Name or key properties |
| --- | --- | --- |
| `Role` | `AWS::IAM::Role` | `<FunctionName>-role` ([IAM](#iam)) |
| `Function` | `AWS::Lambda::Function` | `<FunctionName>` ([Compute](#compute)); code from `CodeBucket` and `CodeKey`; no `Environment` |
| `Version` | `AWS::Lambda::Version` | `DeletionPolicy` and `UpdateReplacePolicy` `Retain`; `CodeSha256` from the parameter; `Description` `code <CodeSha256> (s3 <CodeKey>)` |

**Updates.** A new `CodeKey` updates `Function`'s code. The changed `CodeSha256` and `Description` replace `Version`, which publishes a new numbered version that must match `CodeSha256`; a mismatch fails the update, which rolls back. The old version is retained. Nothing moves to the new version until `add-data-gate-behaviors.sh` is rerun.

**Validation before attachment.** A stack deploy attaches nothing. The published version is checked by invoking it with synthetic viewer-request events before any behavior names it: no cookie gives `401`, a forged token gives `401`, a top-level navigation gives `302`, and each answer carries `Cache-Control: private, no-store` ([How to deploy and update the Lambda@Edge functions, step 5](../how-to/deploy-the-edge-functions.md#5-validate-the-published-version-before-anything-attaches-it)).

**Outputs.** `EdgeGateVersionArn`, the version's qualified ARN, read by `add-data-gate-behaviors.sh`; `EdgeGateFunctionName`. Neither is exported.

### `hfy-mcp-edge401`

Template: [`infrastructure/mcp-edge401.us-east-1.yaml`](../../infrastructure/mcp-edge401.us-east-1.yaml), outside `cloudformation/`. It is deployed by hand in `us-east-1` as the stack `hfy-mcp-edge401`, with `CAPABILITY_IAM` because the role is unnamed. It has no parameters and no region rule.

| Logical ID | Type | Name or key properties |
| --- | --- | --- |
| `Edge401Role` | `AWS::IAM::Role` | No `RoleName`, so CloudFormation generates one; managed policy `AWSLambdaBasicExecutionRole` ([IAM](#iam)) |
| `Edge401Function` | `AWS::Lambda::Function` | `hfy-mcp-edge401` ([Compute](#compute)); inline `ZipFile` code, the CommonJS twin of the `@io-kit/mcp` 401-header function |
| `Edge401Version` | `AWS::Lambda::Version` | `DeletionPolicy` and `UpdateReplacePolicy` `Retain`; `Description` `restore WWW-Authenticate on 401 (code sha256 <16 hex>)`, the first 16 hex digits of the SHA-256 of the inline code |

**Updates.** An edit to the inline code updates only `$LATEST`. Updating the hash in the `Description` replaces `Edge401Version`, which publishes a new numbered version from the new code. [`test_mcp_edge401_stack.py`](../../scripts/infra/test/test_mcp_edge401_stack.py), run by [`scripts/infra/test/run.sh`](../../scripts/infra/test/run.sh), fails and prints the expected hash when the code and the `Description` disagree. After a redeploy, `add-mcp-behavior.sh` moves the MCP behaviors to the new version.

**Output.** `Edge401FunctionVersionArn`, the version's qualified ARN, read by `add-mcp-behavior.sh`. It is not exported.

### `harrisonfamily-github-roles`

Template: [`infrastructure/cloudformation/github-roles.yaml`](../../infrastructure/cloudformation/github-roles.yaml). It is deployed once by hand with admin credentials, `CAPABILITY_NAMED_IAM`, in `us-west-2`.

| Parameter | Default |
| --- | --- |
| `GitHubOrg` | `<github-owner>` |
| `GitHubRepo` | `harrisonfamily` |
| `OIDCProviderArn` | `arn:aws:iam::<aws-account-id>:oidc-provider/token.actions.githubusercontent.com` (an existing provider; the stack does not create it) |

The single resource, `GitHubDeployRole`, is the role `harrisonfamily-github-deploy-role`, with a maximum session of 3600 s.

**Trust.** `sts:AssumeRoleWithWebIdentity` from the OIDC provider, when `token.actions.githubusercontent.com:aud` equals `sts.amazonaws.com` and `token.actions.githubusercontent.com:sub` matches `repo:<github-owner>/harrisonfamily:ref:refs/heads/main`. Only runs on `main` can assume it, so a manual dispatch from another branch cannot.

**Permissions** (inline policy `HarrisonFamilyDeployPolicy`):

| Statement | Effect | Actions | Resource |
| --- | --- | --- | --- |
| `S3SiteSync` | Allow | `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`, `s3:ListBucket` | `arn:aws:s3:::<site-bucket>` and `arn:aws:s3:::<site-bucket>/*` |
| `ProtectMemberUploads` | Deny | `s3:DeleteObject`, `s3:PutObject` | `arn:aws:s3:::<site-bucket>/uploads/*` |
| `CloudFrontInvalidation` | Allow | `cloudfront:CreateInvalidation`, `cloudfront:GetInvalidation` | `arn:aws:cloudfront::<aws-account-id>:distribution/<distribution-id>` |
| `LambdaDeploy` | Allow | `lambda:UpdateFunctionCode`, `GetFunction`, `GetFunctionConfiguration`, `ListVersionsByFunction`, `PublishVersion`, `GetAlias`, `CreateAlias`, `UpdateAlias` | `hfy-check-allowed`, `hfy-api` and `hfy-auth-edge` in `us-west-2`, each with its versions and aliases |

Nothing else is granted. CI cannot write under `uploads/`, and cannot update any stack, any IAM or Cognito resource, any `us-east-1` function, the distribution's configuration, `<config-bucket>`, `<code-bucket>` or `<edge-code-bucket>`. The role could update the code of `hfy-api` and `hfy-auth-edge`, but `ci.manifest.yaml` has no target for them. Why each grant exists is in [Repository operations](repository-operations.md#deploy-role-github-rolesyaml).

**Output.** `DeployRoleArn`, exported as `harrisonfamily-github-roles-DeployRoleArn`. Its value goes in the repository secret `AWS_DEPLOY_ROLE_TO_ASSUME`.

## Not managed by any stack

| Component | How it is managed |
| --- | --- |
| CloudFront distribution and its default behavior | Console or CLI; not in the repo |
| `/api/*`, `/auth/*` and root-discovery behaviors and their origins; the legacy `/api/check-allowed*` pin; the `/uploads/*` behavior | [`scripts/infra/add-api-behavior.sh`](../../scripts/infra/add-api-behavior.sh), [`scripts/infra/add-auth-behavior.sh`](../../scripts/infra/add-auth-behavior.sh), [`scripts/infra/add-uploads-behavior.sh`](../../scripts/infra/add-uploads-behavior.sh) |
| `/mcp*` and `/.well-known/oauth-protected-resource*` behaviors | [`scripts/infra/add-mcp-behavior.sh`](../../scripts/infra/add-mcp-behavior.sh), which also writes `hfy-api-origin` |
| The six gated data behaviors | [`scripts/infra/add-data-gate-behaviors.sh`](../../scripts/infra/add-data-gate-behaviors.sh); `--remove` deletes them |
| Response headers policy `hfy-private-no-store` | Found or created by [`add-data-gate-behaviors.sh`](../../scripts/infra/add-data-gate-behaviors.sh) |
| `HFYAppendIndex` | Created and published with the CLI ([How to stand up the static site](../how-to/stand-up-the-static-site.md#4-create-and-attach-hfyappendindex)); the code is in [`scripts/cloudfront/append-index.js`](../../scripts/cloudfront/append-index.js) ([details](#hfyappendindex)) |
| ACM certificate (`us-east-1`) | Console or CLI ([How to stand up the static site](../how-to/stand-up-the-static-site.md#2-request-the-certificate)) |
| `<site-bucket>`, `<config-bucket>`, `<code-bucket>`, `<edge-code-bucket>` | Not in the repo |
| `<site-bucket>` CORS rule | Manual `put-bucket-cors` from [`media-bucket-cors.json`](../../infrastructure/cloudformation/media-bucket-cors.json) |
| `config/groups.json` and the other files in `<config-bucket>/config/` | By hand; no script in the repository writes `groups.json` ([How to add or remove a family member's access](../how-to/manage-family-access.md)) |
| Uploads to `<code-bucket>` and `<edge-code-bucket>` | Manual, after the package scripts |
| Secrets Manager secrets | [`scripts/infra/create-origin-verify.sh`](../../scripts/infra/create-origin-verify.sh), [`scripts/infra/create-session-key.sh`](../../scripts/infra/create-session-key.sh); others, such as the VAPID secret, by hand |
| Cloudflare zone configuration (DNS, proxying, any Cache Rules, cache purges) | Cloudflare dashboard or API; not in the repo |
| GitHub OIDC provider | Pre-existing; referenced by ARN |
| `hfy-check-allowed` and its API Gateway | Configuration not in the repo; code updated by [`io-kit-deploy.yml`](../../.github/workflows/io-kit-deploy.yml) |
| `getAllowlist` (Google Cloud) | [`deploy-gcf-legacy.yml`](../../.github/workflows/deploy-gcf-legacy.yml) |

## Secrets

The secrets inventory is owned by [Private data and secrets](private-data-and-secrets.md): each secret's name, contents, readers, creator and rotation are listed under [Secrets Manager](private-data-and-secrets.md#secrets-manager), [Google Cloud](private-data-and-secrets.md#google-cloud-legacy-retiring), [GitHub repository secrets](private-data-and-secrets.md#github-repository-secrets) and [Local-only tokens and environment variables](private-data-and-secrets.md#local-only-tokens-and-environment-variables).

This page covers only where secrets shape the system: the `X-Origin-Verify` header under [Origins](#origins) and [`ORIGIN_VERIFY`](#origin_verify), the `SigningKey` and `Secrets` statements under [IAM](#iam), and the [`HasVapid` condition](#conditions). The API holds no signing key; it verifies sessions against the edge's JWKS ([API: Session verification](api.md#session-verification)), and so does the data gate.

## Discrepancies in the code

- The `app-stack.yaml` `Description` says `hfy-api` is "behind an IAM-auth Function URL", but both Function URLs are AuthType `NONE`, gated only by `X-Origin-Verify`.
- The stack parameters `SigningKeySecretName` and `AllowlistKey`, and `ConfigBucket` as far as the edge is concerned, only scope the edge's IAM grants. The edge reads the secret name, bucket and allowlist key from [`auth/edge.manifest.json`](../../auth/edge.manifest.json). If one side changes without the other, the edge reads a resource its role cannot access.
- The stack does not pass `GROUPS_BUCKET` or `GROUPS_KEY` to `hfy-api`, so the code default bucket, `<config-bucket>`, is read whatever `ConfigBucket` says ([`api/src/index.js`](../../api/src/index.js)). The role's `AdminList` grant follows `ConfigBucket`, so if `ConfigBucket` names another bucket the read is denied and every MCP caller fails closed with no groups.
- `createGroupResolver` in [`api/src/policy.js`](../../api/src/policy.js) accepts `emailsFor`, an allowlist lookup of a subject's emails, and the file's header describes matching `mcp-authors` emails that way, but `index.js` does not pass it. Only the token's `email` claim is matched.
- `hfy-api` advertises the scope from `MCP_SCOPES`, default `openid email profile`, in its protected-resource metadata and 401 challenge ([`api/src/mcp.js`](../../api/src/mcp.js)), while the auth edge's metadata has `scopes_supported: ["mcp"]` ([`auth/src/oauth.js`](../../auth/src/oauth.js)). See [MCP server: Discrepancies](mcp-server.md#discrepancies).
- The `policy.js` header and [`api/scripts/gen-caps.mjs`](../../api/scripts/gen-caps.mjs) say the UI reads `dist/policy.json`, so UI and MCP cannot disagree. Nothing in `islands/` or `11ty/js/` reads it.
- [`api/src/keys.js`](../../api/src/keys.js) exports `commentKeys` (`COMMENT#<id>` / `META`) and `gsiThread`, which no module uses. Comments live under `THREAD#` / `C#` ([`api/src/comments.js`](../../api/src/comments.js)).
- [`cloudfront/distribution.json`](../../cloudfront/distribution.json) uses `S3OriginConfig` with an empty OAI rather than OAC, and has none of the script-managed behaviors described above. [How to stand up the static site](../how-to/stand-up-the-static-site.md#3-create-the-distribution) adds the OAC.

## Related pages

- [Why one CloudFront distribution fronts everything](../explanation/edge-and-origin-design.md), [The identity model](../explanation/identity-model.md), [How member content stays accountable](../explanation/member-content-design.md), [The privacy model for family data](../explanation/family-data-privacy.md), [Why releases ship through a pipeline and feature flags](../explanation/release-model.md)
- [Codebase map](codebase-map.md), [API](api.md), [MCP server](mcp-server.md), [Identity services](identity-services.md), [Repository operations](repository-operations.md), [Private data and secrets](private-data-and-secrets.md), [Cost estimate](cost-estimate.md)
- [How to stand up the static site](../how-to/stand-up-the-static-site.md), [How to deploy the app stack](../how-to/deploy-the-app-stack.md), [How to deploy and update the Lambda@Edge functions](../how-to/deploy-the-edge-functions.md), [How to cut over to authV2 and the private data gate](../how-to/cut-over-to-the-private-data-gate.md), [How to connect an MCP client](../how-to/connect-an-mcp-client.md), [How to turn on push notifications](../how-to/turn-on-push-notifications.md), [How to rotate the origin-verify secret](../how-to/rotate-the-origin-verify-secret.md), [How to rotate the session signing key](../how-to/rotate-the-session-signing-key.md), [How to diagnose sign-in and API failures](../how-to/diagnose-sign-in-and-api-failures.md)
