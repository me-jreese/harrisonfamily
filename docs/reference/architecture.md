# System architecture

Reference for the deployed system: edge, storage, compute, identity store, data and stacks.

The region is `us-west-2`, except for the parts that AWS requires in `us-east-1`: the CloudFront certificate, because CloudFront only accepts certificates from that region, and the two Lambda@Edge stacks, `hfy-edge-gate` and `hfy-mcp-edge401`, because Lambda@Edge functions can only be created there. `<edge-code-bucket>`, which holds the gate's code, is in `us-east-1` too, because Lambda loads code only from a bucket in the function's own region. CloudFront runs Lambda@Edge replicas at its edge locations, so their logs land in the regions of those locations, not only in `us-east-1` ([Compute](#compute)). Values in angle brackets, such as `<site>`, `<app-stack>`, `<site-bucket>`, `<edge-code-bucket>`, `<distribution-id>`, `<aws-account-id>` and `<github-owner>`, are placeholders for deployment-specific identifiers; the forms are listed in [Private data and secrets](private-data-and-secrets.md#placeholders). For why the system is shaped this way, read [Why one CloudFront distribution fronts everything](../explanation/edge-and-origin-design.md), [The identity model](../explanation/identity-model.md) and [The privacy model for family data](../explanation/family-data-privacy.md).

## Overview

```text
browser ──HTTPS──▶ Cloudflare (proxies <site>) ──HTTPS──▶ CloudFront <distribution-id>   (ACM certificate in us-east-1)
  ├─ /api/*  ──X-Origin-Verify──▶ Function URL ▶ Lambda hfy-api
  ├─ /auth/*,
  │  /.well-known/oauth-authorization-server*
  │          ──X-Origin-Verify──▶ Function URL ▶ Lambda hfy-auth-edge
  ├─ /uploads/*
  │          members-only: viewer-request Lambda@Edge hfy-edge-gate, CachingDisabled, hfy-uploads-private
  │          public:       no function, CachingOptimized, the app stack's uploads policy
  │          ──OAC───────────▶ S3 <site-bucket>/uploads/   (nosniff + sandbox CSP in both states)
  ├─ /person/*.json, /family/*, /event/*, /note/*, /place/*, /media/*
  │          viewer-request: Lambda@Edge hfy-edge-gate (io_id session check; 401 or 302 when it fails)
  │          ──OAC───────────▶ S3 <site-bucket>   (CachingDisabled, Cache-Control: private, no-store)
  ├─ /mcp*,
  │  /.well-known/oauth-protected-resource*
  │          ──X-Origin-Verify──▶ Function URL ▶ Lambda hfy-api (MCP mount)
  │          origin-response: Lambda@Edge hfy-mcp-edge401 (restores WWW-Authenticate on 401)
  └─ default (*) ──OAC──────────▶ S3 <site-bucket>
             viewer-request: CloudFront Function HFYAppendIndex (clean URLs)
             the repo's default-deny code also answers 404 for the private prefixes;
             the repo does not record whether LIVE runs that code

hfy-api         ▶ DynamoDB hfy-app
                ▶ S3 <config-bucket>/config/ (admins.json; groups.json for MCP)
                ▶ S3 <site-bucket>: presigned PUT into uploads/posts/ and uploads/comments/;
                  ranged GetObject on both (location check), HEAD on comment photos;
                  GetObject on person/* (author labels)
                ▶ JWKS from https://<site>/auth/.well-known/jwks.json (back through Cloudflare and CloudFront)
                ▶ Secrets Manager (VAPID secret) and web push services (subscription endpoints), only when HasVapid
hfy-auth-edge   ▶ DynamoDB hfy-app (refresh tokens, links, passkeys and their challenges, MCP codes and tokens, rate counters)
                ▶ S3 <config-bucket> (allowlist, admins) · Cognito hfy-users
                ▶ Secrets Manager (session signing key)
                ▶ Google signing keys, to verify GIS ID tokens (the kit's Google provider)
hfy-edge-gate   ▶ JWKS from https://<site>/auth/.well-known/jwks.json (back through Cloudflare and CloudFront)
hfy-mcp-edge401 ▶ nothing; it edits the response it is given
```

The diagram shows every outbound dependency of the app stack's two functions and of the two Lambda@Edge functions. Passkey credentials and challenges are stored by the auth edge, in the same table as its other records; nothing on the API side reads them.

- **Sign-in path.** Sign-in goes through the auth edge. The legacy `/api/check-allowed` path is retired: HFY-TSK-317 removed its callers, and HFY-TSK-326 deleted its Lambda and API Gateway on 2026-10-14 ([Retired check-allowed route](#retired-check-allowed-route)); `authV2` decides only whether a page keeps the edge session fresh. The committed [`11ty/_data/flags.json`](../../11ty/_data/flags.json) sets `authV2` and the other five flags to `true` (HFY-TSK-069). `curl -s https://<site>/_data/flags.json | jq .authV2` shows the value the site serves.
- **Gate history.** The production cutover ran on 2026-10-12: the site with `authV2` on was deployed first, and the private data gate was attached after it (HFY-TSK-069, HFY-R67; [How to cut over to authV2 and the private data gate](../how-to/cut-over-to-the-private-data-gate.md)). A signed-out `curl -s -o /dev/null -w '%{http_code}' https://<site>/person/index.json` returns `401` while the gate is attached. When it is not, it returns `200` if the request reaches S3, or `404` if the repo's default-deny `HFYAppendIndex` answers it ([Gate rollback](#request-routing), [HFYAppendIndex](#hfyappendindex)).
- **Two states of `/uploads/*`.** The gate script gates `/uploads/*` as well as the six data patterns. The repository does not record whether that version of the script has run in production. [Request routing](#request-routing) gives the two states and the check that tells them apart.

## Request routing

One CloudFront distribution, `<distribution-id>`, serves the whole site, with Cloudflare proxying `<site>` in front of it ([Distribution settings](#distribution-settings)). The live distribution configuration is not in the repository. [`cloudfront/distribution.json`](../../cloudfront/distribution.json) is a sanitized template of the configuration before the behavior scripts ran: the S3 origin and the default behavior, with no cache behaviors. Its legacy API Gateway origin and `/api/*` behavior were removed when `hfy-check-allowed` was retired (HFY-TSK-326). The default behavior below is the one that [How to stand up the static site](../how-to/stand-up-the-static-site.md#3-create-the-distribution) creates from that template; the live default behavior is not recorded in the repository, and `aws cloudfront get-distribution-config --id <distribution-id>` shows it. The behaviors that the scripts in [`scripts/infra/`](../../scripts/infra/) add are defined exactly by those scripts.

| Path pattern | Origin | Viewer protocol | Allowed methods | Cache policy | Origin request policy | Response headers policy | Functions | Defined by |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `/api/*` | `hfy-api-origin` | redirect-to-https | GET, HEAD, OPTIONS, PUT, POST, PATCH, DELETE | CachingDisabled | AllViewerExceptHostHeader | none | none | [`scripts/infra/add-api-behavior.sh`](../../scripts/infra/add-api-behavior.sh) |
| `/auth/*` | `hfy-auth-origin` | redirect-to-https | GET, HEAD, OPTIONS, PUT, POST, PATCH, DELETE | CachingDisabled | AllViewerExceptHostHeader | none | none | [`scripts/infra/add-auth-behavior.sh`](../../scripts/infra/add-auth-behavior.sh) |
| `/.well-known/oauth-authorization-server*` | `hfy-auth-origin` | redirect-to-https | GET, HEAD, OPTIONS, PUT, POST, PATCH, DELETE | CachingDisabled | AllViewerExceptHostHeader | none | none | [`scripts/infra/add-auth-behavior.sh`](../../scripts/infra/add-auth-behavior.sh) |
| `/uploads/*`, public state | The default behavior's S3 origin, or `--origin-id` | redirect-to-https | GET, HEAD | CachingOptimized | none | The stack's `UploadsResponseHeadersPolicy`: `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox; default-src 'none'; img-src 'self'` | none, so `HFYAppendIndex` does not run | [`scripts/infra/add-uploads-behavior.sh`](../../scripts/infra/add-uploads-behavior.sh) (HFY-R58). `add-data-gate-behaviors.sh --remove` restores this state |
| `/uploads/*`, members-only state | The origin the behavior already has. A new behavior gets the default behavior's S3 origin, or `--origin-id` | redirect-to-https | GET, HEAD | CachingDisabled | none | `hfy-uploads-private` | Lambda@Edge viewer-request: `hfy-edge-gate`. No CloudFront Function | [`scripts/infra/add-data-gate-behaviors.sh`](../../scripts/infra/add-data-gate-behaviors.sh), which updates the existing behavior in place |
| `/person/*.json` | The default behavior's S3 origin, or `--origin-id` | redirect-to-https | GET, HEAD | CachingDisabled | none | `hfy-private-no-store` | Lambda@Edge viewer-request: `hfy-edge-gate`. No CloudFront Function | [`scripts/infra/add-data-gate-behaviors.sh`](../../scripts/infra/add-data-gate-behaviors.sh) (HFY-TSK-080) |
| `/family/*` | The default behavior's S3 origin, or `--origin-id` | redirect-to-https | GET, HEAD | CachingDisabled | none | `hfy-private-no-store` | Lambda@Edge viewer-request: `hfy-edge-gate`. No CloudFront Function | [`scripts/infra/add-data-gate-behaviors.sh`](../../scripts/infra/add-data-gate-behaviors.sh) |
| `/event/*` | The default behavior's S3 origin, or `--origin-id` | redirect-to-https | GET, HEAD | CachingDisabled | none | `hfy-private-no-store` | Lambda@Edge viewer-request: `hfy-edge-gate`. No CloudFront Function | [`scripts/infra/add-data-gate-behaviors.sh`](../../scripts/infra/add-data-gate-behaviors.sh) |
| `/note/*` | The default behavior's S3 origin, or `--origin-id` | redirect-to-https | GET, HEAD | CachingDisabled | none | `hfy-private-no-store` | Lambda@Edge viewer-request: `hfy-edge-gate`. No CloudFront Function | [`scripts/infra/add-data-gate-behaviors.sh`](../../scripts/infra/add-data-gate-behaviors.sh) |
| `/place/*` | The default behavior's S3 origin, or `--origin-id` | redirect-to-https | GET, HEAD | CachingDisabled | none | `hfy-private-no-store` | Lambda@Edge viewer-request: `hfy-edge-gate`. No CloudFront Function | [`scripts/infra/add-data-gate-behaviors.sh`](../../scripts/infra/add-data-gate-behaviors.sh) |
| `/media/*` | The default behavior's S3 origin, or `--origin-id` | redirect-to-https | GET, HEAD | CachingDisabled | none | `hfy-private-no-store` | Lambda@Edge viewer-request: `hfy-edge-gate`. No CloudFront Function | [`scripts/infra/add-data-gate-behaviors.sh`](../../scripts/infra/add-data-gate-behaviors.sh) |
| `/mcp*` and `/.well-known/oauth-protected-resource*` | `hfy-api-origin` | redirect-to-https | GET, HEAD, OPTIONS, PUT, POST, PATCH, DELETE | CachingDisabled | AllViewerExceptHostHeader | none | Lambda@Edge origin-response: `hfy-mcp-edge401`, `IncludeBody` false | [`scripts/infra/add-mcp-behavior.sh`](../../scripts/infra/add-mcp-behavior.sh) |
| Default (`*`) | S3 `<site-bucket>` via OAC | redirect-to-https | GET, HEAD | CachingOptimized | none | The custom security-headers policy the how-to creates: `Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` | `HFYAppendIndex`, viewer-request: clean URLs, and, in the repo's default-deny code, a `404` for the private prefixes ([HFYAppendIndex](#hfyappendindex)) | The template [`cloudfront/distribution.json`](../../cloudfront/distribution.json), completed by [How to stand up the static site](../how-to/stand-up-the-static-site.md#3-create-the-distribution) (step 3 adds OAC and the headers policy, step 4 attaches `HFYAppendIndex`) |

- **The default behavior.** The how-to keeps the template's GET and HEAD, `Compress: true` and CachingOptimized, and adds no origin request policy. A pre-E5 description of the distribution, which the repository no longer carries, gave the default behavior GET, HEAD and OPTIONS and the managed CORS-S3Origin origin request policy. Whether the live default behavior has them cannot be checked from the repository.
- **The gated data behaviors.** The pattern is `/person/*.json`, not `/person/*`, because `/person/` itself is the public person-page shell, which the default behavior's `HFYAppendIndex` resolves to `/person/index.html`. A gated `/person/*` would also catch the shell, gate a public page and skip that rewrite. Each gated behavior's association names a numbered version of `hfy-edge-gate` with `IncludeBody` false. The gate checks the `io_id` session cookie. It passes a valid request on unchanged, and answers any other with `401` for fetch, XHR and subresource requests or `302` to `/auth/login?returnTo=<path>` for a top-level navigation, both with `Cache-Control: private, no-store` ([`edge-gate/src/gate.mjs`](../../edge-gate/src/gate.mjs)). See [The privacy model for family data: Gating the JSON](../explanation/family-data-privacy.md#gating-the-json).
- **The two `/uploads/*` rows.** They are one behavior in two states. `add-uploads-behavior.sh` creates it in the public state. `add-data-gate-behaviors.sh` gates the existing behavior in place: it keeps its position and `TargetOriginId`, and gets the gate association, CachingDisabled and `hfy-uploads-private`. When no `/uploads/*` behavior exists, the gate script creates one already gated. A rerun of `add-uploads-behavior.sh` never undoes the gate: on a gated behavior it prints `/uploads/* is members-only (hfy-edge-gate association, add-data-gate-behaviors.sh): left as it is. add-data-gate-behaviors.sh --remove ungates it.`, then `no change`. Only `add-data-gate-behaviors.sh --remove` puts the public state back (**Gate rollback**, below).
- **Which `/uploads/*` state is live.** The repository does not record it. A signed-out `curl -s -o /dev/null -w '%{http_code}' https://<site>/uploads/posts/<ulid>/<name>` returns `401` in the members-only state and `200` in the public state. `aws cloudfront get-distribution-config --id <distribution-id>` shows whether the `/uploads/*` behavior has an `hfy-edge-gate` entry in `LambdaFunctionAssociations`.
- **Variants of the gated paths.** A request that spells a gated prefix in a form that no gated pattern matches, such as `/Person/index.json` or `/person/<gramps-id>.JSON`, reaches the default behavior. The repository's `HFYAppendIndex` answers it with `404` before S3 is reached ([HFYAppendIndex](#hfyappendindex)).
- **The MCP behaviors.** The association names a numbered version of `hfy-mcp-edge401` from the `us-east-1` stack of that name. On a `401`, the function copies `x-amzn-remapped-www-authenticate`, the name under which a Function URL returns the header, back into `WWW-Authenticate`, unless the response already has one. See [MCP server: CloudFront behaviors](mcp-server.md#cloudfront-behaviors).

The managed policies the scripts use:

| Policy | Kind | ID |
| --- | --- | --- |
| CachingDisabled | Cache policy | `4135ea2d-6df8-44a3-9df3-4b5a84be39ad` |
| CachingOptimized | Cache policy | `658327ea-f89d-4fab-a63d-7e88639e58f6` |
| AllViewerExceptHostHeader | Origin request policy | `b689b0a8-53d0-40ab-baf2-68738e2966ac` |

The custom response headers policies:

| Policy | Created by | Headers | Used by |
| --- | --- | --- | --- |
| `<FunctionName>-uploads-sandbox`, `hfy-api-uploads-sandbox` with the default `FunctionName` | The app stack's `UploadsResponseHeadersPolicy` resource; its ID is the stack output `UploadsResponseHeadersPolicyId` | `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox; default-src 'none'; img-src 'self'`, both with override | `/uploads/*` in its public state |
| `hfy-private-no-store` | [`add-data-gate-behaviors.sh`](../../scripts/infra/add-data-gate-behaviors.sh), not a stack (HFY-R65). The script finds the policy by name, creates it when it is missing, and puts it back when it no longer forces the header (`rhp_forces_cache_control` in [`cf.jq`](../../scripts/infra/lib/cf.jq)). `--response-headers-policy-name` changes the name; `--response-headers-policy-id` skips the lookup | A single custom header, `Cache-Control: private, no-store`, with `Override: true` | The six gated data behaviors |
| `hfy-uploads-private` | `add-data-gate-behaviors.sh`, not a stack, found, created or repaired by name in the same way. It is put back when it no longer forces the header or has lost either security header (`rhp_uploads_private` in `cf.jq`). `--uploads-response-headers-policy-name` changes the name; `--uploads-response-headers-policy-id` skips the lookup | `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox; default-src 'none'; img-src 'self'` and a custom header `Cache-Control: private, no-store`, all three with override. The CSP is `UPLOADS_CSP` in [`cf-common.sh`](../../scripts/infra/lib/cf-common.sh), the same string as the app stack's policy, which [`test_app_stack.py`](../../scripts/infra/test/test_app_stack.py) checks | `/uploads/*` in its members-only state |

`--remove` leaves both custom policies in the account, unused. A `--dry-run` never creates or updates a policy. An offline dry run with `--config-file` and `--version-arn` makes no AWS call and shows placeholder IDs, such as `<hfy-uploads-private policy id>`. With `--config-file` alone, the script still calls `describe-stacks` in `us-east-1` for `EdgeGateVersionArn`. A `--remove` dry run needs only `--config-file` to stay offline, because `--remove` never resolves the version ARN.

All the script-built behaviors set `Compress: true` and have no CloudFront Function. `/api/*`, `/auth/*`, root discovery and the public `/uploads/*` have no Lambda@Edge association. The gated behaviors, including a members-only `/uploads/*`, and the MCP behaviors have one each, as described above. Both Lambda@Edge scripts refuse a `$LATEST` or unqualified function ARN. `CachedMethods` is GET, HEAD on every script-built behavior, which has no effect under CachingDisabled: CloudFront caches nothing on the Lambda paths or the gated paths. The public `/uploads/*` uses CachingOptimized, which is safe at CloudFront because each upload key is unique. Cloudflare also stores those image responses ([Distribution settings](#distribution-settings)); a members-only `/uploads/*` stops that with `Cache-Control: private, no-store`.

- **Order.** CloudFront tries cache behaviors in list order and uses the first match; the default behavior applies last. The scripts merge in place: an origin with the same ID, or a behavior with the same path pattern, keeps its position and every field the script does not manage, and a missing one is appended at the end of its list. Two rules can change that:
  - `add-data-gate-behaviors.sh` moves each gated pattern just ahead of the first other behavior that would also match it, such as a legacy `/person/*` (`place_before_shadow` in [`cf.jq`](../../scripts/infra/lib/cf.jq)). A gated behavior that is already ahead, or that nothing else matches, stays where it is.
  - `add-mcp-behavior.sh` moves nothing. When an earlier behavior already matches `/mcp` or `/.well-known/oauth-protected-resource` and would shadow the MCP behavior, it exits `3` and changes nothing.

  So the resulting order depends on the behaviors the distribution already has, and on the order in which the scripts ran. A new behavior that no other behavior matches is appended after the existing ones. On the live-shaped test fixture [`live-like.json`](../../scripts/infra/test/fixtures/live-like.json), whose behaviors are a legacy `/person/*` and the legacy `/api/*`, [`run.sh`](../../scripts/infra/test/run.sh) checks two results:
  - After `add-auth-behavior.sh`, `add-api-behavior.sh` and `add-uploads-behavior.sh`: `/person/*`, `/api/*`, `/auth/*`, `/.well-known/oauth-authorization-server*`, `/uploads/*`. `/api/*` is retargeted in place, not appended.
  - After `add-data-gate-behaviors.sh` on that fixture with an ungated `/uploads/*`: `/person/*.json`, `/person/*`, `/api/*`, `/uploads/*`, `/family/*`, `/event/*`, `/note/*`, `/place/*`, `/media/*`. `/person/*.json` moves ahead of the legacy `/person/*`, `/uploads/*` keeps its position when it is gated, and the five other data patterns are appended.

  On a live-shaped distribution the order therefore starts `/person/*.json`, `/person/*`, `/api/*`. Apart from `/person/*.json` and `/person/*`, no two of these patterns match the same path, so the position of the rest, `/mcp*` and `/.well-known/oauth-protected-resource*` included, does not affect routing.
- **Re-runs.** A script whose result equals the live configuration (compared in a normalized form) prints `no change` and makes no `update-distribution` call. Before a real update it saves the configuration it read as a backup. [Repository operations](repository-operations.md#cloudfront-behavior-scripts) has the full behavior.
- **Gate rollback.** `add-data-gate-behaviors.sh --remove` deletes exactly the six data behaviors that carry an `hfy-edge-gate` association (`remove_gate_behaviors` in `cf.jq`), so `CacheBehaviors.Quantity` drops by six. A data path then goes to the first legacy behavior that matches it, or else to the default behavior.
  - **The data paths.** On the default behavior, the result depends on the `HFYAppendIndex` code on the `LIVE` stage, which the repository does not record ([HFYAppendIndex](#hfyappendindex)). Without the default-deny code, the default behavior serves the data paths from S3 to anyone. With it, they answer `404` to everyone, members and every other client included, because the function denies their first segments and any `.json` under `person/`. In both cases, a path that a legacy behavior such as `/person/*` matches first never reaches the default behavior, and that behavior serves it instead. In the live-shaped test fixture [`live-like.json`](../../scripts/infra/test/fixtures/live-like.json), `/person/*` sends it to S3 with no function, so anyone can read it. `/uploads/*` becomes public either way.
  - **`/uploads/*`.** The script never deletes it. A gated `/uploads/*` is put back in place with no Lambda@Edge association, CachingOptimized and the app stack's `UploadsResponseHeadersPolicyId` (`behavior_gated` and `ungate_behavior` in `cf.jq`). After that, anyone who holds a photo URL can read the photo again. When `/uploads/*` is gated, the reviewed diff removes six behaviors and modifies `/uploads/*`.
  - **The restored policy.** It comes from `--restore-uploads-policy-id` when that is given. Otherwise the script reads it from the output of the stack named by `--app-stack` (default `hfy-app`), in the CLI's default region. The script looks the policy up only while `/uploads/*` is gated. A production `--remove` at that point, including `--remove --dry-run`, passes `--app-stack <app-stack>` with `us-west-2` as the CLI's region, or `--restore-uploads-policy-id`. Without either, it exits `1`, prints `pass --restore-uploads-policy-id ID to name the response headers policy /uploads/* gets back` and changes nothing. An offline `--config-file` dry run uses a placeholder named after `--app-stack`, `<hfy-app UploadsResponseHeadersPolicyId>` by default.
  - **No-op and alternative.** A run that finds nothing to remove prints `distribution <distribution-id> already has no hfy-edge-gate-gated data behaviors (<six patterns>) and /uploads/* back to its ungated state: no change`. The alternative to `--remove` is to restore the pre-change backup with `update-distribution`.
  - **Order with `authV2`.** The production cutover attached the gate on 2026-10-12 (HFY-R67), so this order applies now. The gate comes off before `authV2` is turned off, never after. Turning the flag off while the gate is attached locks every visitor out of the family data. A CI rollback that restores a `flags.json` with `authV2` false counts as turning it off, so pair it with a `--remove`. Turning `authV2` off after `--remove` gives that client its data back only if `HFYAppendIndex` runs code without the default-deny. Under the default-deny code, `HFYAppendIndex` must also be rolled back to its earlier code, with the `roll back with:` commands that `publish-append-index.sh` printed when it published. The other way out is to fix forward with `authV2` true. [How to cut over to authV2 and the private data gate](../how-to/cut-over-to-the-private-data-gate.md#roll-back) gives the steps.
- **Stack names.** `add-api-behavior.sh`, `add-auth-behavior.sh`, `add-uploads-behavior.sh` and `add-mcp-behavior.sh` read outputs of the stack named by `--stack`. Its default, `hfy-app`, is not the live app stack's name, so each run passes `--stack <app-stack>`. `add-mcp-behavior.sh` also reads `Edge401FunctionVersionArn` from the `us-east-1` stack named by `--edge-stack` (default `hfy-mcp-edge401`), unless `--edge401-arn` or `$EDGE401_ARN` gives the ARN. `add-data-gate-behaviors.sh` reads `EdgeGateVersionArn` from the `us-east-1` stack named by its own `--stack`, unless `--version-arn` gives the ARN. That default, `hfy-edge-gate`, is the live name, so never pass `--stack <app-stack>` to it. It names the app stack with `--app-stack` instead, which only `--remove` reads.
- **Root discovery.** The auth edge's issuer is `https://<site>/auth`, so RFC 8414 discovery is served at `/.well-known/oauth-authorization-server/auth`. [`auth/src/edge.js`](../../auth/src/edge.js) answers that path; the same document is also served under `/auth/.well-known/`. Both answer only when MCP OAuth is enabled, that is when `MCP_REDIRECT_URIS` (stack parameter `McpRedirectUris`) is not empty ([`auth/src/index.js`](../../auth/src/index.js)). Otherwise both return `404 {"code":"NOT_FOUND"}`. See [Identity services](identity-services.md#mcp-authorization-server).

### Retired check-allowed route

This was the sign-in path whenever `authV2` was off: an API Gateway HTTP API in front of the `hfy-check-allowed` Lambda. It was reached through the old `/api/*` behavior and, once the app behaviors existed, through an `/api/check-allowed*` pin that `add-api-behavior.sh` kept ahead of `/api/*` (HFY-R58). HFY-TSK-317 removed every caller: no page sets `gateway.endpoint` or posts to `/api/check-allowed`, `11ty/js/auth.js` is deleted, and `/family-login/` is a static redirect to `/auth/login`. Production CloudFront had no pin and no API Gateway origin when read on 2026-10-13. On 2026-10-14, HFY-TSK-326 (ruling P2-R48) deleted the gateway, the Lambda, its IAM role and its log group. [`add-api-behavior.sh`](../../scripts/infra/add-api-behavior.sh) no longer creates or keeps a pin, and its `--legacy-origin` option is gone.

`POST /api/check-allowed` now reaches `hfy-api` through `/api/*`. `hfy-api` has no such route and returns `404` with code `not_found` ([`api/src/handler.js`](../../api/src/handler.js)). Nothing on the site calls the route, so no visitor sees it. The symptom is in [How to diagnose sign-in and API failures](../how-to/diagnose-sign-in-and-api-failures.md#the-retired-check-allowed-route-returns-404).

### HFYAppendIndex

A CloudFront Function on the default behavior's viewer-request event. Its runtime is `cloudfront-js-1.0`, so the code is ES5.1 only and at most 10 KB. Source: [`scripts/cloudfront/append-index.js`](../../scripts/cloudfront/append-index.js). No script-built behavior has a CloudFront Function, so it never runs on `/uploads/*`, the gated data behaviors or the Lambda paths. It must stay on the default behavior only: on a gated behavior it would answer `404` for the data itself.

It does two things, in order. First, it rewrites clean URLs:

| Request URI | Rewritten to |
| --- | --- |
| Ends in `/` | URI + `index.html` |
| Contains no `.` | URI + `/index.html` |
| Anything else | Unchanged |

Second, it denies the private prefixes by default. It checks the rewritten URI and answers `404 Not Found` with `cache-control: private, no-store`, without reaching S3, when:

- The first path segment is `family`, `event`, `note`, `place`, `media` or `uploads` (`DENY_FIRST_SEGMENTS`).
- The first segment is `person`, and the URI contains `.json` anywhere or is anything other than the public person-page shell, `/person/index.html` (`PUBLIC_PERSON_FILES`). `/person/` and `/person` are rewritten to that shell, so they pass.

Before the segments are matched, the URI is percent-decoded up to four rounds and lowercased. Backslashes become `/`, a `;params` suffix is stripped from each segment, `.` and `..` segments are resolved, and trailing dots and spaces are trimmed. A malformed escape is left as it is rather than throwing, because a throwing function would fail every request on the default behavior.

- **Why it denies.** CloudFront path patterns are case-sensitive, and `/person/*.json` is anchored on its suffix. Variants such as `/Person/index.json`, `/FAMILY/...`, `/person/<gramps-id>.JSON`, `/person/<gramps-id>.json/`, a trailing dot or space, `;params`, `%20`, `%2F` or `%252e`, backslashes and dot segments match no gated behavior. They fall through to the ungated default behavior, which reaches S3, and they were safe only because every S3 key is lowercase. While the gate is attached, a real request for gated data always matches its exact gated pattern first and never reaches the function, so the deny affects only variants and probes. Without the gate's behaviors, the exact data paths reach the function too, and it refuses them to everyone (**Gate rollback**, under [Request routing](#request-routing)). [Why one CloudFront distribution fronts everything](../explanation/edge-and-origin-design.md#why-the-cloudfront-function-also-denies) gives the reasoning.
- **Tests.** `node --test scripts/cloudfront/test/*.test.mjs` runs the shared case table [`append-index.cases.json`](../../scripts/cloudfront/test/append-index.cases.json), which has `rewrite`, `deny` and `awsSamples` cases. The tests also check that no file shipped in `11ty/` outside `person/` is denied, and they run an ES5 guard. They pin `DENY_FIRST_SEGMENTS` to the non-person patterns of `add-data-gate-behaviors.sh`, and `PUBLIC_PERSON_FILES` to the files in `11ty/person/`. A new public file under `11ty/person/` must therefore be added to `PUBLIC_PERSON_FILES`. [`scripts/infra/test/run.sh`](../../scripts/infra/test/run.sh) runs the same tests, and so does the publish script before it touches AWS.
- **Publishing.** The function is created once by hand, published and associated with the default behavior ([How to stand up the static site](../how-to/stand-up-the-static-site.md#4-create-and-attach-hfyappendindex)). Later code changes go out with [`scripts/infra/publish-append-index.sh`](../../scripts/infra/publish-append-index.sh) ([How to publish a change to the HFYAppendIndex CloudFront Function](../how-to/publish-the-cloudfront-function.md)). The script never creates the function. It refuses to publish while the function is associated with any behavior other than the default one (exit `3`). It updates the `DEVELOPMENT` stage and runs `test-function` there with the `awsSamples` cases, or every case with `--all-cases`. It publishes to `LIVE` only when every case passes, and saves the previous code under `${HFY_CF_BACKUP_DIR:-~/.local/state/hfy-infra/cloudfront}` first. The association holds the function ARN, so a publish needs no `update-distribution`. The function's comment is `Append index.html to directory paths; 404 for private data prefix variants (HFY data gate)`. [Repository operations](repository-operations.md) lists the options and exit statuses.
- **Which code is live.** The repository does not record whether the default-deny version has been published. `publish-append-index.sh --dry-run` only reads. It prints `function HFYAppendIndex already runs the repo code on LIVE: no change` when the `LIVE` stage matches the repository file, and a diff otherwise. From outside, a case variant such as `curl -sI https://<site>/Person/index.json` answers `404` with `cache-control: private, no-store` under the default-deny code, while `/about/` and `/person/` still answer `200`.
- **Not a pipeline target.** `ci.manifest.yaml` has no `cloudfront_function` target, although `@io-kit/ci` 0.1.3 supports that kind, and the deploy role has no CloudFront Function permissions ([`harrisonfamily-github-roles`](#harrisonfamily-github-roles)). A publish runs by hand with operator credentials that allow `cloudfront:DescribeFunction`, `GetFunction`, `UpdateFunction`, `TestFunction`, `PublishFunction` and `GetDistributionConfig`.

### Distribution settings

| Setting | Value | Source |
| --- | --- | --- |
| Aliases | Apex and `www` of `<site>` | Template |
| Viewer certificate | ACM certificate in `us-east-1`, `sni-only` | Template |
| Price class | `PriceClass_100` | Template |
| Default root object | `index.html` | How-to: [How to stand up the static site](../how-to/stand-up-the-static-site.md#3-create-the-distribution), step 3c; the template has none |
| In front of the distribution | Cloudflare proxies `<site>` (HFY-R65) | Operational |
| Cloudflare caching of private responses | Cloudflare caches responses by file extension, such as images, SVG and PDF, whatever CloudFront's cache policy says, unless the response says `private` or `no-store`. The gated behaviors therefore carry `hfy-private-no-store` or `hfy-uploads-private`, and no Cloudflare Cache Rule may override the edge TTL on the gated prefixes | The header of [`add-data-gate-behaviors.sh`](../../scripts/infra/add-data-gate-behaviors.sh); [How to cut over to authV2 and the private data gate](../how-to/cut-over-to-the-private-data-gate.md) |
| Cloudflare caching of static files | Cloudflare and then the browser keep static files, scripts and stylesheets included, for 4 h under the URL first fetched. A CloudFront invalidation, the deploy's `/*` included, does not reach Cloudflare's cache. Cloudflare does not cache the HTML (`cf-cache-status: DYNAMIC`). So the islands build gives every same-origin script and stylesheet reference a `?v=<sha8>` content hash, stamped into the uncached HTML, and a changed file is fetched under a new URL at once ([Theme and asset build](theme-and-asset-build.md)) | The header of [`islands/assets.mjs`](../../islands/assets.mjs) |
| Access logging and alarms | None. The repository configures no CloudFront standard or real-time logs and no CloudWatch alarms; `cloudfront/distribution.json` has no `Logging` block | Template |

## Origins

| Origin ID | Domain | Connection | Access control | Custom header | Defined by |
| --- | --- | --- | --- | --- | --- |
| Not in the repo | `<site-bucket>` S3 endpoint | S3 origin | Origin Access Control | None | Console or CLI ([How to stand up the static site](../how-to/stand-up-the-static-site.md#3-create-the-distribution)). Also the origin of `/uploads/*` and the gated behaviors, unless `--origin-id` names another |
| `hfy-api-origin` | Host of the `<app-stack>` output `FunctionUrl` | Custom origin, `https-only`, `TLSv1.2`, ports 80/443, read timeout 30 s, keep-alive 5 s, empty origin path | None (`OriginAccessControlId` is empty) | `X-Origin-Verify` | [`add-api-behavior.sh`](../../scripts/infra/add-api-behavior.sh) and [`add-mcp-behavior.sh`](../../scripts/infra/add-mcp-behavior.sh), which write the same settings |
| `hfy-auth-origin` | Host of the `<app-stack>` output `AuthFunctionUrl` | Same as `hfy-api-origin` | None | `X-Origin-Verify` | [`add-auth-behavior.sh`](../../scripts/infra/add-auth-behavior.sh) |

- **Header value.** `add-api-behavior.sh`, `add-auth-behavior.sh` and `add-mcp-behavior.sh` each take the `X-Origin-Verify` value from `$ORIGIN_VERIFY` or from the Secrets Manager secret `harrisonfamily/cloudfront/origin-verify`, write it into the distribution config, and redact it in every diff they print. `--dry-run` prints the redacted diff and changes nothing. The distribution holds its own copy of the value.
- **Origin check.** Both Lambdas check the header before any routing ([`api/src/origin.js`](../../api/src/origin.js), [`auth/src/origin.js`](../../auth/src/origin.js)), so it also guards `/mcp*` and the protected-resource metadata. The comparison is constant-time over SHA-256 digests. A missing or wrong header, or an unset `ORIGIN_VERIFY`, returns `403 {"error":"forbidden"}`.
- **Timeouts.** Both functions time out at 15 s, inside the 30 s origin read timeout.

## Buckets

None of the buckets is managed by a stack.

### `<site-bucket>`

| Prefix | Contents | Written by | Excluded from the deploy's `--delete` |
| --- | --- | --- | --- |
| Root | The static site, synced from `11ty/` | The `s3_static` target in [`ci.manifest.yaml`](../../ci.manifest.yaml), run by [`.github/workflows/io-kit-deploy.yml`](../../.github/workflows/io-kit-deploy.yml) | No (this is what the sync owns) |
| `person/`, `family/`, `event/`, `note/`, `place/`, `media/` | Private Gramps data and media. Served through the six gated behaviors | The private data sync ([How to refresh the family data from Gramps](../how-to/sync-gramps-with-the-website.md)), which syncs these six prefixes and nothing else | Yes: `person/*.json`, `media/*`, `family/*`, `event/*`, `note/*`, `place/*` |
| `uploads/posts/<ulid>/photo.<ext>` | Photos attached to member posts (`UPLOAD_PREFIX` in [`api/src/uploads.js`](../../api/src/uploads.js), HFY-R58). The server names every new upload `photo.<ext>`; older uploads keep the uploader's cleaned file name. Served through the `/uploads/*` CloudFront behavior, in its public or members-only state ([Request routing](#request-routing)) | Browsers, by presigned PUT issued by `hfy-api` | Yes: `uploads/*`. The deploy role also denies `s3:PutObject` and `s3:DeleteObject` here ([`github-roles.yaml`](../../infrastructure/cloudformation/github-roles.yaml), `ProtectMemberUploads`) |
| `uploads/comments/<ulid>/photo.<ext>` | Photos attached to member comments, behind `commentPhotosV1` (`COMMENT_UPLOAD_PREFIX` in [`api/src/uploads.js`](../../api/src/uploads.js); [API: Comment photos](api.md#comment-photos)). JPEG, PNG or WebP only, named `photo.<ext>` by the server. Removing a photo from a comment, or deleting the comment, leaves the object in place. Served through the same `/uploads/*` behavior as post photos | Browsers, by presigned PUT issued by `hfy-api` for `purpose` `comment` | Yes: `uploads/*`, under the same deploy-role denial |
| `media/posts/<ulid>/<name>` | Legacy: photos uploaded before HFY-R58, if any remain. Nothing moved them | No writer since HFY-R58 | Yes, under `media/*`. The private data sync deletes them unless run with `--no-delete` |
| `js/islands/` | Island bundles | The `11ty/` sync, from the committed build output (HFY-R58) | No (this is site output) |
| `css/hfy-theme.css`, `css/auth-edge.css`, `fonts/` | The design system's theme layer, the auth edge's sign-in stylesheet, and the self-hosted brand fonts with content-hashed file names ([Theme and asset build](theme-and-asset-build.md)) | The `11ty/` sync, from the committed islands-build output | No (this is site output) |

- **Reads.** CloudFront reads the bucket through OAC. The bucket policy that [How to stand up the static site](../how-to/stand-up-the-static-site.md#1-create-the-site-bucket) applies allows `s3:GetObject` only to `cloudfront.amazonaws.com` for this distribution, with Block Public Access on. Inside the account, `hfy-api` reads `person/<gramps-id>.json` for author labels through its role's `PersonRecords` statement (HFY-R68), and nothing else in the bucket.
- **Island bundles and theme files.** `11ty/js/islands/`, the two stylesheets and `11ty/fonts/` are committed, so every deploy ships the files in the commit and its `--delete` sync removes any that is not committed. See [How to build and preview the React islands](../how-to/build-and-preview-the-islands.md).
- **The sign-in stylesheet.** The auth edge's HTML pages load `https://<site>/css/auth-edge.css?v=<sha8>`, the `theme.cssUrl` in [`auth/edge.manifest.json`](../../auth/edge.manifest.json). Their CSP `style-src` is `'unsafe-inline' https://<site>`, plus Google's GIS stylesheet on the login page. It names the site's origin, not a path, so the `?v=` passes, and the stylesheet must be served from `https://<site>` ([Identity services](identity-services.md)).
- **Uploads.** `/uploads/*` is served from the same S3 origin through its own behavior.
  - **Public state.** Anyone who holds a photo's URL can read it, and Cloudflare caches it, because the behavior uses CachingOptimized and the file has an image extension.
  - **Members-only state.** A signed-out request gets the gate's `401`, or a `302` to `/auth/login?returnTo=<path>` for a navigation, always with `Cache-Control: private, no-store`. Neither Cloudflare nor browsers store the photos. Members see them unchanged, because the posts islands render them as same-origin `<img src>` and the browser sends `io_id` ([`islands/tests/uploads-gate.test.mjs`](../../islands/tests/uploads-gate.test.mjs)). A script that fetches a photo must use `credentials: 'same-origin'`.
  - **Uploading.** Uploading is the same in both states. The presigned PUT goes to the bucket's S3 endpoint, not through CloudFront ([`api/test/presign.test.js`](../../api/test/presign.test.js)).
  - **Syncs.** The private data sync cannot name `uploads/`, and the site deploy excludes it.
- **CORS rule.** Members' browsers `PUT` the photos they attach to posts and comments straight to the bucket's S3 endpoint, with presigned URLs from `hfy-api`: post photos under `uploads/posts/`, and comment photos under `uploads/comments/` (the role's `CommentPhotoUploads` grant, HFY-TSK-236). That endpoint is a different origin from the page, so the browser first sends a CORS preflight, and without a matching rule it blocks the upload. An S3 CORS rule applies to the whole bucket, not to a prefix, so one rule covers both. [`infrastructure/cloudformation/site-bucket-cors.json`](../../infrastructure/cloudformation/site-bucket-cors.json) is the bucket's whole CORS configuration, the single rule `hfy-member-photo-uploads`:
  - **Origins:** `https://<site>` and `https://www.<site>`, the two host names the site is served under. A page uploads from the origin it was loaded from. No wildcard.
  - **Methods:** `PUT` only. Uploading is the rule's only purpose. The photos are read back through CloudFront under `/uploads/*`, same-origin, which needs no CORS, and no page code reads, lists or deletes objects on the S3 endpoint.
  - **Request headers:** `Content-Type` only. The presigned URL signs the content type, so the browser must send the exact type the API returned. The browser sets `Content-Length` itself, and it is never part of a preflight.
  - **`ExposeHeaders` and `MaxAgeSeconds`:** `ETag`, which lets a script read the stored object's `ETag` (the islands do not read it), and 3000, so a browser reuses a preflight answer for up to 50 minutes.
  - **Applied by hand.** No stack manages the bucket, and the deploy role cannot change its CORS configuration. [How to stand up the static site](../how-to/stand-up-the-static-site.md#1-create-the-site-bucket) applies the file with `aws s3api put-bucket-cors`, which replaces the bucket's whole CORS configuration.
  - **Checked twice.** [`scripts/infra/test/run.sh`](../../scripts/infra/test/run.sh) fails if the committed file allows any method other than `PUT`, any origin other than the two site origins, or any header other than `Content-Type`. After every successful deploy run, [`post-deploy-checks.yml`](../../.github/workflows/post-deploy-checks.yml) runs [`scripts/infra/check-site-bucket-cors.sh`](../../scripts/infra/check-site-bucket-cors.sh), which sends preflights to the live bucket without credentials. Both site origins must get `200` with their own origin in `Access-Control-Allow-Origin`, and a foreign origin, a `DELETE` and an extra request header must each get `403`. A failure there rolls nothing back.

### `<config-bucket>`

| Key | Contents | Read by |
| --- | --- | --- |
| `config/userGrampsID.json` | Map of verified email to Gramps ID | `hfy-auth-edge` (sign-in resolver, cached 300 s; MCP membership, cached 60 s) |
| `config/admins.json` | Array of Gramps IDs, or `{"admins": [...]}`. May be absent, which means no admins (no moderators) | `hfy-api` (cached 60 s, fails closed); `hfy-auth-edge` (MCP `admins` group, cached 60 s) |
| `config/groups.json` | The MCP groups `mcp-authors` and `hfy-admin`; the shape is in [`api/src/policy.js`](../../api/src/policy.js) and [MCP server: Groups](mcp-server.md#groups) | `hfy-api`, for MCP authorization only (cached 60 s, fails closed) |

- **Locations.** The edge takes this bucket and the allowlist key from [`auth/edge.manifest.json`](../../auth/edge.manifest.json) (`resolver`), and the admin key from `ADMIN_LIST_KEY`. The API takes the admin list from `ADMIN_LIST_BUCKET` and `ADMIN_LIST_KEY`, and the groups file from `GROUPS_BUCKET` and `GROUPS_KEY`. The stack sets neither `GROUPS_*` variable, so the code defaults, `<config-bucket>` and `config/groups.json`, apply.
- **A missing or unreadable file.** A missing `config/admins.json` makes nobody an admin: `hfy-api` logs `admin list unavailable (failing closed)` and retries after 5 s, and the edge's MCP membership logs `admin list unavailable (nobody is admin)` and grants no `admins` group. A missing or unparsable `config/groups.json` grants no MCP group to anyone and is retried after 5 s.
- **Writers.** No script in the repository writes `config/groups.json`. See [How to add or remove a family member's access](../how-to/manage-family-access.md).
- **Retired key.** `config/allowed_hashes.json`, the HMAC digest list that only the legacy `hfy-check-allowed` Lambda read, was deleted on 2026-10-14 (ruling P2-R51), and the allowlist publisher no longer writes it.

### `<code-bucket>`

| Key | Contents | Built by |
| --- | --- | --- |
| `lambda/hfy-api-<sha>.zip` | `hfy-api` package, built from commit `<sha>` | [`scripts/ci/package-api.sh`](../../scripts/ci/package-api.sh), into `dist/hfy-api.zip` |
| `lambda/hfy-auth-edge-<sha>.zip` | `hfy-auth-edge` package, including `edge.manifest.json` with its `theme.cssUrl` as the islands build stamped it, built from commit `<sha>` | [`scripts/ci/package-auth.sh`](../../scripts/ci/package-auth.sh), into `dist/hfy-auth-edge.zip` |

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
| `hfy-edge-gate` | `nodejs22.x`, `x86_64` | 128 MB | 5 s | `index.handler` | Lambda@Edge, viewer-request, on the six gated data behaviors and on `/uploads/*` in its members-only state | [`edge-gate-stack.yaml`](../../infrastructure/cloudformation/edge-gate-stack.yaml), stack `hfy-edge-gate` in `us-east-1`; code in [`edge-gate/`](../../edge-gate/) |
| `hfy-mcp-edge401` | `nodejs22.x`; the template sets no architecture, so the Lambda default, `x86_64` | 128 MB | 3 s | `index.handler`, inline code | Lambda@Edge, origin-response, on `/mcp*` and `/.well-known/oauth-protected-resource*` | [`mcp-edge401.us-east-1.yaml`](../../infrastructure/mcp-edge401.us-east-1.yaml), stack `hfy-mcp-edge401` in `us-east-1` |

- **App stack functions.** `hfy-api` and `hfy-auth-edge` each have a log group `/aws/lambda/<name>` with 30-day retention, a role `<name>-role`, and two resource policies for principal `*`: `lambda:InvokeFunctionUrl` with `FunctionUrlAuthType: NONE`, and `lambda:InvokeFunction` with `InvokedViaFunctionUrl: true`. The origin check is the only gate on the URL.
- **Lambda@Edge functions.** CloudFront runs them only through a numbered version, which each stack publishes and keeps (`Retain`) because CloudFront replicas pin it. They have no Function URL and no resource policy, and neither stack creates a log group: Lambda@Edge writes to a log group named `/aws/lambda/us-east-1.<function>` in the region of the edge location that ran the function, so the logs are spread across the edge regions. Neither function holds a secret: the gate verifies sessions against the auth edge's public JWKS.
- **Legacy functions.** Both are deleted. `hfy-check-allowed` was replaced by the auth edge (HFY-TSK-062), left the kit manifest with HFY-TSK-317, and was deleted on 2026-10-14 with its API Gateway, IAM role and log group (HFY-TSK-326, ruling P2-R48); its source left the repository with it ([Retired check-allowed route](#retired-check-allowed-route)). The other legacy function, `getAllowlist` in Google Cloud, was deleted the same day with io's approval, together with its Secret Manager secret; HFY-TSK-325 removed its source and its deploy workflow from the repository.
  - The `X-HFY-Session` code paths in `feature-flags.js`, `person-page.js` and the search scripts are deleted.
  - Turning `authV2` off again works only after the gate is removed. The gate checks only `io_id`, and a page with `authV2` off never refreshes it, so while the gate is attached such a page cannot read the gated data once the hour is up ([Gate rollback](#request-routing)). Removing the gate is not enough while `HFYAppendIndex` runs the default-deny code, which answers `404` to every client for the data paths that reach the default behavior: that client gets its data back only if `HFYAppendIndex` is also rolled back to its earlier code. The other way out is to fix forward with `authV2` true ([How to cut over to authV2 and the private data gate](../how-to/cut-over-to-the-private-data-gate.md#roll-back)).
  - `getAllowlist` was on no sign-in path, and nothing in the repo called it ([Identity services](identity-services.md#getallowlist-deleted)).
  - The retirement order for the legacy pieces is in [The identity model](../explanation/identity-model.md).

### Environment

| Function | Variables set by the stack |
| --- | --- |
| `hfy-api` | `TABLE_NAME`, `SESSION_JWKS_URL`, `ORIGIN_VERIFY`, `SESSION_ISSUER`, `SESSION_AUDIENCE`, `SESSION_COOKIE`, `ADMIN_LIST_BUCKET`, `ADMIN_LIST_KEY`, `MEDIA_BUCKET`, `MEDIA_PUBLIC_BASE`, and `VAPID_SECRET` only when `HasVapid` is true |
| `hfy-auth-edge` | `AUTH_TABLE`, `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`, `GOOGLE_CLIENT_ID`, `MCP_REDIRECT_URIS`, `MCP_RESOURCES`, `MCP_CORS_ORIGINS`, `ORIGIN_VERIFY`, `ADMIN_LIST_KEY` |
| `hfy-edge-gate` | None. Lambda@Edge has no environment variables. The issuer, audience, JWKS URL, cookie name (`io_id`), login path (`/auth/login`) and JWKS cache timings are baked into the zip from [`edge-gate/gate.config.json`](../../edge-gate/gate.config.json) |
| `hfy-mcp-edge401` | None |

- **Not set by the stack.** `hfy-api` also reads `GROUPS_BUCKET`, `GROUPS_KEY` and the `MCP_*` variables (`MCP_RESOURCE_URL`, `MCP_AUDIENCE`, `MCP_TOKEN_ISSUER`, `MCP_CLIENT_IDS`, `MCP_SCOPES`). The stack sets none of them, so their code defaults apply; see [MCP server: Configuration](mcp-server.md#configuration). `hfy-auth-edge` also reads `MCP_CLIENT_ID` and `EDGE_MANIFEST_PATH` when they are set; the stack sets neither.
- **Edge manifest.** The auth edge's remaining settings come from [`auth/edge.manifest.json`](../../auth/edge.manifest.json), which is packaged with the code. They include the issuer, audience, signing-key secret name, key ID and allowlist location. They also include the sign-in pages' `theme`, which has `cssUrl` (the versioned `auth-edge.css`) and `fontOrigins` (`self`), and their family-voice `copy`. For the API routes and the edge endpoints, see [API](api.md) and [Identity services](identity-services.md).

### IAM

| Role | Statement | Actions | Resource |
| --- | --- | --- | --- |
| `hfy-api-role` | `Logs` | `logs:CreateLogStream`, `logs:PutLogEvents` | Its own log group |
| | `Table` | `dynamodb:GetItem`, `PutItem`, `UpdateItem`, `DeleteItem`, `Query`, `Scan`, `BatchGetItem`, `BatchWriteItem`, `ConditionCheckItem` | `hfy-app` and `hfy-app/index/*` |
| | `AdminList` | `s3:GetObject` | `<config-bucket>/config/*`, which covers `admins.json` and `groups.json` |
| | `PostPhotoUploads` | `s3:PutObject` | `<site-bucket>/uploads/posts/*` only |
| | `CommentPhotoUploads` | `s3:PutObject` | `<site-bucket>/uploads/comments/*` only (HFY-TSK-236) |
| | `UploadReads` | `s3:GetObject` | `<site-bucket>/uploads/comments/*` and `<site-bucket>/uploads/posts/*`, for HEAD and copy-source reads (HFY-TSK-236). No grant on `media/*` or `config/*` is added. |
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
| Profile links, one per person | `PLINKS#<gramps-id>` | `META` | - | - | [`api/src/links.js`](../../api/src/links.js) |
| Record follow, one per principal and person | `RSUB#<principal>` | `REC#person:<gramps-id>` | `RECSUB#person:<gramps-id>` | `<principal>` | [`api/src/subscriptions.js`](../../api/src/subscriptions.js) |
| Profile links audit entry | `AUDIT#plinks:<gramps-id>` | `<iso-time>#<ulid>` | `AUDIT` / same as SK | - | [`api/src/links.js`](../../api/src/links.js), through `auditItem` |
| Record head | `REC#<Class>#<handle>` | `HEAD` | `RECS#<Class>` / `<gramps-id>#<handle>` | - | [`api/src/sync/store.js`](../../api/src/sync/store.js), written by [`api/src/sync/apply.js`](../../api/src/sync/apply.js), which the desktop push routes call |
| Record change log | `SYNC#LOG` | the seq, 12 digits | `RECHIST#<Class>#<handle>` / the version, 8 digits | - | `api/src/sync/apply.js` |
| Record store sequence head | `SYNC#HEAD` | `META` | - | - | `api/src/sync/apply.js` (the seq); the bind route and the push routes own the rest (`open_session`, `seeded`) |
| Record push session | `SYNC#SESSION#<session-id>` | `META` | - | 7 days; treated as expired at `opened_at` + 7 days without waiting for the delete | [`api/src/sync/push.js`](../../api/src/sync/push.js); `SYNC#HEAD.open_session` names the open one |
| Pending blob upload | `SYNC#UPLOAD#<handle>` | the blob's SHA-256, hex | - | 1 hour after the presign; removed when the blob is finalized | [`api/src/sync/media.js`](../../api/src/sync/media.js) |
| Record batch receipt | `SYNC#BATCH#<batch-id>` | `META` | `SYNCBATCH` / `<iso-time>#<batch-id>` | - (kept) | `api/src/sync/apply.js` |
| gramps_id guard | `GID#<Class>#<gramps-id>` | `META` | - | - (a Person item is never deleted) | `api/src/sync/apply.js` |
| gramps_id alias | `IDALIAS#<Class>#<old-gramps-id>` | `META` | - | - (never deleted) | `api/src/sync/apply.js` |
| Record batch audit | `AUDIT#records:<batch-id>` | `<iso-time>#<uid>` | `AUDIT` / same as SK | - | `api/src/sync/apply.js`, through `auditItem` |
| Upload binding, one per presign | `UPLOAD#<ulid>` | `META` | - | 24 hours after the presign; removed when a post or comment of the upload's `purpose` attaches it | [`api/src/uploads.js`](../../api/src/uploads.js), attached by [`api/src/content.js`](../../api/src/content.js) (`purpose` `post`) or by [`api/src/comment-photos.js`](../../api/src/comment-photos.js) in the comment write of [`api/src/comments.js`](../../api/src/comments.js) (`purpose` `comment`) |
| Allowlist grant, one per email | `ALLOW#<email>` | `META` | `ALLOWSUB#<gramps-id>` / `ALLOW#<email>` (its own PK) | - | [`api/src/allowlist-store.js`](../../api/src/allowlist-store.js) (writes), read by `hfy-auth-edge` |
| Allowlist audit entry | `AUDIT#allow:<sha256-hex-of-email>` | `<iso-time>#<ulid>` | `AUDIT` / same as SK | - | [`api/src/allowlist-store.js`](../../api/src/allowlist-store.js), through `auditItem` |
| Push subscription | `SUB#<principal>` | `ENDPOINT#<endpoint-url>` | - | 90 days after write | `@io-kit/notify` `DynamoSubscriptionStore` |
| Notification preferences | `PREF#<principal>` | `PREFS` | - | - | `@io-kit/notify` `DynamoPreferencesStore` |
| Inbox item, its unread copy, the unread counter and the coalescing pointer | `INBOX#<principal>` | `N#<ulid>`, `U#<ulid>`, `COUNT`, `G#<group>` | - | none while unread; 90 days after read | `@io-kit/notify` `DynamoNotificationStore` |
| Contribution event, one per credited contribution | `CONTRIB#<principal>` | `E#<ulid>` | `CONTRIBS` / `<ulid>` | - | [`api/src/contrib.js`](../../api/src/contrib.js) |
| Self-edit daily marker (at most one self-edit credit per record per UTC day) | `CONTRIB#<principal>` | `CAP#self_edit#<subject>#<YYYY-MM-DD>` | - | 2 days after the write | [`api/src/contrib.js`](../../api/src/contrib.js) |
| Site counters | `CSTAT#site` | `TOTAL`; `D#<YYYY-MM-DD>`; `M#<YYYY-MM>`; `LINE` (the feed-line cache, written by [`contrib-read.js`](../../api/src/contrib-read.js)) | - | `D#` rows 800 days after their day; `LINE` 2 hours | [`api/src/contrib.js`](../../api/src/contrib.js) |
| Person counters | `CSTAT#person:<principal>` | `TOTAL`; `M#<YYYY-MM>` | - | - | [`api/src/contrib.js`](../../api/src/contrib.js) |

Each post, comment and profile links change is one `TransactWriteItems` call that carries the data change and its `AUDIT#` item, and, when a post or comment change earns or loses a contribution, the `CONTRIB#` event and the `CSTAT#` counters ([API: Contributions ledger](api.md#contributions-ledger)). All three post items carry the full post, so a list needs no second read. `<target>` is `root` or `comment:<ulid>`. Reactions are plain puts and deletes with no audit item.

Written by `hfy-auth-edge`, through the `@io-kit/auth` 2.2.0 stores and the local stores wired in [`auth/src/index.js`](../../auth/src/index.js). `<scope>` is `email+ip` or `ip`, and the hash covers the email and client IP, so neither is stored:

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

- **`REFRESH#`.** The kit's record (`rec`) also stores the sign-in's `authTime` and, when it has one, its `amr`. A refresh carries both forward unchanged, so a refreshed session keeps its original authentication time. The kit has done this since 2.1.1. A record written before 2.1.1 has no `authTime` and refreshes with `0`.
- **`MCPCODE#` and `MCPRT#`.** Each also stores `email`, `amr`, `authTime` and `name`, the member's display label (HFY-R64, HFY-R68). The access token copies them into its `email`, `amr`, `auth_time` and `name` claims, and a token refresh never moves `auth_time` forward.

### Notes

- **GSI1 needs both keys.** DynamoDB indexes an item in `GSI1` only when the item has both `GSI1PK` and `GSI1SK`. The kit's link and passkey stores set only `GSI1PK`, so [`linkstore.js`](../../auth/src/linkstore.js) and [`passkeystore.js`](../../auth/src/passkeystore.js) wrap them to write `GSI1SK` equal to the item's own `PK`. An item written without it is healed on its next read: a link by a conditional `PutItem`, a passkey by a conditional `UpdateItem` that sets only `GSI1SK`, so that a concurrent update of the signature counter is not undone. Both conditions are `attribute_exists(PK) AND attribute_not_exists(GSI1SK)`.
- **`SUB#` appears twice without collision.** It is the PK of subscription items and the GSI1PK of link items. These are different attributes. The API's subscriber scan filters on `begins_with(PK, "SUB#")`, which link items (PK `LINK#`) and passkey items (PK `PASSKEY#`, GSI1PK `PASSKEYSUB#`) never match, and subscription items set no `GSI1PK`.
- **Access.** Both roles cover the whole table and its indexes, with no key-prefix condition. The API may `Scan`; the edge may not. The API's only scan is `scanSubscribedPrincipals` in [`api/src/notify.js`](../../api/src/notify.js), which finds push subscribers when a post is published.
- **Expiry.** TTL deletion is not immediate, so readers check `expiresAt` or `ttl` themselves.

## CloudFormation stacks

### `<app-stack>`

Template: [`infrastructure/cloudformation/app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml), deployed by hand in `us-west-2` as the stack `<app-stack>` ([How to deploy the app stack](../how-to/deploy-the-app-stack.md)). Because the roles are named, the deploy needs `CAPABILITY_NAMED_IAM`.

`hfy-app`, the `--stack` default of the app behavior scripts and the `--app-stack` default of `add-data-gate-behaviors.sh`, is the stack name the repository assumes, not the live stack's name. So every run of those behavior scripts passes `--stack <app-stack>`, and a production `add-data-gate-behaviors.sh --remove` passes `--app-stack <app-stack>` ([Request routing](#request-routing)). `hfy-app` remains the name of the DynamoDB table (the `TableName` default).

#### Parameters

| Parameter | Default | Used for |
| --- | --- | --- |
| `TableName` | `hfy-app` | Table name; `TABLE_NAME`, `AUTH_TABLE` |
| `FunctionName` | `hfy-api` | API function, log group and role names; the uploads response headers policy name |
| `CodeBucket` | None (required) | `<code-bucket>` |
| `CodeKey` | `lambda/hfy-api.zip` | API package key. Deploys pass `lambda/hfy-api-<sha>.zip` ([`<code-bucket>`](#code-bucket)) |
| `ConfigBucket` | `<config-bucket>` | `ADMIN_LIST_BUCKET`; S3 grants for both roles. Not `GROUPS_BUCKET` ([Discrepancies](#discrepancies-in-the-code)) |
| `MediaBucket` | `<site-bucket>` | `MEDIA_BUCKET`; the API's `PostPhotoUploads` grant on `uploads/posts/*`, `CommentPhotoUploads` on `uploads/comments/*`, `UploadReads` on both upload prefixes, and `PersonRecords` grant on `person/*` |
| `MediaPublicBase` | `https://<site>` | `MEDIA_PUBLIC_BASE`, the origin that serves `uploads/` |
| `AdminListKey` | `config/admins.json` | `ADMIN_LIST_KEY` for both functions; edge S3 grant |
| `VapidSecretName` | Empty | `VAPID_SECRET`; drives `HasVapid` |
| `SessionIssuer` | `https://<site>/auth` | `SESSION_ISSUER` |
| `SessionAudience` | `harrisonfamily-web` | `SESSION_AUDIENCE` |
| `SessionJwksUrl` | `https://<site>/auth/.well-known/jwks.json` | `SESSION_JWKS_URL` |
| `SessionCookie` | `io_id` | `SESSION_COOKIE` |
| `GuardDob` | `off` (`off` or `on`) | `HFY_GUARD_DOB`: `on` makes the API refuse `dob_not_allowed` on posts and comments ([API: Contact-information guard](api.md#contact-information-guard)) |
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
| `JoinSesIdentityArn` | Empty | The verified SES identity of the join subdomain that sends access-request mail from the auth edge; drives `HasJoinSes` and the edge's `ses:SendEmail` grant |
| `JoinFromAddress` | Empty | The bare `From` address on that identity (`JOIN_FROM_ADDRESS`); the grant is conditioned on it |
| `JoinSesConfigurationSet` | Empty | The configuration set for access-request mail only (`JOIN_SES_CONFIGURATION_SET`); required whenever `JoinSesIdentityArn` is set (the stack refuses one without the other), and the code route answers `503 unavailable` while it is empty |
| `JoinBounceAlarmName`, `JoinComplaintAlarmName` | `hfy-access-request-bounce`, `hfy-access-request-complaint` | The CloudWatch alarms the code route reads (`JOIN_MAIL_ALARMS`); the edge may call `cloudwatch:DescribeAlarms` (read-only, on `*`: the call is list-style and AWS may not honor an alarm ARN for it; the code asks for these two names only, and the RG-4 route smoke checks the real IAM behavior) |

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
| `UploadsResponseHeadersPolicy` | `AWS::CloudFront::ResponseHeadersPolicy` | `<FunctionName>-uploads-sandbox`: `X-Content-Type-Options: nosniff`, and `Content-Security-Policy: sandbox; default-src 'none'; img-src 'self'`, both with override. The policy of `/uploads/*` in its public state; the members-only state uses `hfy-uploads-private` instead ([custom response headers policies](#request-routing)) |
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
| `UploadsResponseHeadersPolicyId` | The uploads response headers policy | `add-uploads-behavior.sh`; `add-data-gate-behaviors.sh --remove`, from the stack named by `--app-stack`, unless `--restore-uploads-policy-id` is given |
| `AuthFunctionUrl` | `hfy-auth-edge` Function URL | `add-auth-behavior.sh` |
| `AuthFunctionName` | `hfy-auth-edge` | |
| `UserPoolId` | User pool ID | |
| `UserPoolClientId` | `hfy-web` client ID | |

No output is exported.

#### Updating code

New code reaches the functions through new `CodeKey` and `AuthCodeKey` values ([`<code-bucket>`](#code-bucket)), applied as a CloudFormation change set that is reviewed before it is executed.

- **When `hfy-auth-edge` needs a new package.** After any change under `auth/src/`, or to `auth/edge.manifest.json`. That includes the `theme.cssUrl` stamp, which the islands build rewrites whenever `11ty/css/auth-edge.css` changes ([Theme and asset build](theme-and-asset-build.md)). Until the redeploy, the sign-in pages keep the old stylesheet URL and the old copy.
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

**Updates.** A new `CodeKey` updates `Function`'s code. The changed `CodeSha256` and `Description` replace `Version`, which publishes a new numbered version that must match `CodeSha256`; a mismatch fails the update, which rolls back. The old version is retained. Nothing moves to the new version until `add-data-gate-behaviors.sh` is rerun. The rerun points all seven gated behaviors at the new version, so its diff changes seven `LambdaFunctionARN` values. If `/uploads/*` was still public, the same run also gates it.

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
| `LambdaDeploy` | Allow | `lambda:UpdateFunctionCode`, `GetFunction`, `GetFunctionConfiguration`, `ListVersionsByFunction`, `PublishVersion`, `GetAlias`, `CreateAlias`, `UpdateAlias` | `hfy-api` and `hfy-auth-edge` in `us-west-2`, each with its versions and aliases. The template dropped `hfy-check-allowed` when the function was deleted (HFY-TSK-326); the deployed stack keeps that grant until the GitHub-roles stack is next updated, and it allows nothing on a deleted function |

Nothing else is granted. CI cannot write under `uploads/`. It also cannot update any stack, any IAM or Cognito resource, any `us-east-1` function, the distribution's configuration, any CloudFront Function or response headers policy, `<config-bucket>`, `<code-bucket>` or `<edge-code-bucket>`. The role could update the code of `hfy-api` and `hfy-auth-edge`, but `ci.manifest.yaml` has no target for them. Why each grant exists is in [Repository operations](repository-operations.md#deploy-role-github-rolesyaml).

**Output.** `DeployRoleArn`, exported as `harrisonfamily-github-roles-DeployRoleArn`. Its value goes in the repository secret `AWS_DEPLOY_ROLE_TO_ASSUME`.

## Not managed by any stack

| Component | How it is managed |
| --- | --- |
| CloudFront distribution and its default behavior | Console or CLI; not in the repo |
| `/api/*`, `/auth/*` and root-discovery behaviors and their origins; the `/uploads/*` behavior in its public state | [`scripts/infra/add-api-behavior.sh`](../../scripts/infra/add-api-behavior.sh), [`scripts/infra/add-auth-behavior.sh`](../../scripts/infra/add-auth-behavior.sh), [`scripts/infra/add-uploads-behavior.sh`](../../scripts/infra/add-uploads-behavior.sh) |
| `/mcp*` and `/.well-known/oauth-protected-resource*` behaviors | [`scripts/infra/add-mcp-behavior.sh`](../../scripts/infra/add-mcp-behavior.sh), which also writes `hfy-api-origin` |
| The six gated data behaviors, and the members-only state of `/uploads/*` | [`scripts/infra/add-data-gate-behaviors.sh`](../../scripts/infra/add-data-gate-behaviors.sh). `--remove` deletes the six and puts `/uploads/*` back to its public state |
| Response headers policies `hfy-private-no-store` and `hfy-uploads-private` | Found, created or repaired by [`add-data-gate-behaviors.sh`](../../scripts/infra/add-data-gate-behaviors.sh); kept by `--remove` |
| `HFYAppendIndex` | Created once with the CLI ([How to stand up the static site](../how-to/stand-up-the-static-site.md#4-create-and-attach-hfyappendindex)). Code changes are published with [`scripts/infra/publish-append-index.sh`](../../scripts/infra/publish-append-index.sh) ([How to publish a change to the HFYAppendIndex CloudFront Function](../how-to/publish-the-cloudfront-function.md)). The code is in [`scripts/cloudfront/append-index.js`](../../scripts/cloudfront/append-index.js) ([details](#hfyappendindex)) |
| ACM certificate (`us-east-1`) | Console or CLI ([How to stand up the static site](../how-to/stand-up-the-static-site.md#2-request-the-certificate)) |
| `<site-bucket>`, `<config-bucket>`, `<code-bucket>`, `<edge-code-bucket>` | Not in the repo |
| `<site-bucket>` CORS rule | Manual `put-bucket-cors` from [`site-bucket-cors.json`](../../infrastructure/cloudformation/site-bucket-cors.json). [`post-deploy-checks.yml`](../../.github/workflows/post-deploy-checks.yml) checks it after every successful deploy run |
| `config/groups.json` and the other files in `<config-bucket>/config/` | By hand; no script in the repository writes `groups.json` ([How to add or remove a family member's access](../how-to/manage-family-access.md)) |
| Uploads to `<code-bucket>` and `<edge-code-bucket>` | Manual, after the package scripts |
| Secrets Manager secrets | [`scripts/infra/create-origin-verify.sh`](../../scripts/infra/create-origin-verify.sh), [`scripts/infra/create-session-key.sh`](../../scripts/infra/create-session-key.sh); others, such as the VAPID secret, by hand |
| Cloudflare zone configuration (DNS, proxying, any Cache Rules, cache purges) | Cloudflare dashboard or API; not in the repo |
| GitHub OIDC provider | Pre-existing; referenced by ARN |

## Secrets

The secrets inventory is owned by [Private data and secrets](private-data-and-secrets.md): each secret's name, contents, readers, creator and rotation are listed under [Secrets Manager](private-data-and-secrets.md#secrets-manager), [Google Cloud](private-data-and-secrets.md#google-cloud-legacy-deleted), [GitHub repository secrets](private-data-and-secrets.md#github-repository-secrets) and [Local-only tokens and environment variables](private-data-and-secrets.md#local-only-tokens-and-environment-variables).

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
- [Codebase map](codebase-map.md), [API](api.md), [MCP server](mcp-server.md), [Identity services](identity-services.md), [Theme and asset build](theme-and-asset-build.md), [Repository operations](repository-operations.md), [Private data and secrets](private-data-and-secrets.md), [Cost estimate](cost-estimate.md)
- [How to stand up the static site](../how-to/stand-up-the-static-site.md), [How to deploy the app stack](../how-to/deploy-the-app-stack.md), [How to deploy and update the Lambda@Edge functions](../how-to/deploy-the-edge-functions.md), [How to cut over to authV2 and the private data gate](../how-to/cut-over-to-the-private-data-gate.md), [How to publish a change to the HFYAppendIndex CloudFront Function](../how-to/publish-the-cloudfront-function.md), [How to connect an MCP client](../how-to/connect-an-mcp-client.md), [How to turn on push notifications](../how-to/turn-on-push-notifications.md), [How to rotate the origin-verify secret](../how-to/rotate-the-origin-verify-secret.md), [How to rotate the session signing key](../how-to/rotate-the-session-signing-key.md), [How to diagnose sign-in and API failures](../how-to/diagnose-sign-in-and-api-failures.md)
