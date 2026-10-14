# MCP server (/mcp)

Reference for the MCP server that hfy-api serves at `https://<site>/mcp`: mount and routing, configuration, protected-resource metadata and 401 challenges, tools, policy, groups, the actor and its label, execution, dry runs, audit, generated documents and the conformance gate.

For why an AI assistant signs in as a member, see [The identity model: Agents as members](../explanation/identity-model.md#agents-as-members), and for why deletes need a fresh, user-verified sign-in, [Step-up for destructive agent actions](../explanation/identity-model.md#step-up-for-destructive-agent-actions). For why a tool call obeys the same permission, audit and notification rules as the site, see [How member content stays accountable](../explanation/member-content-design.md). The procedures are in [How to deploy the app stack and its CloudFront behaviors](../how-to/deploy-the-app-stack.md) (its MCP routing step), [How to deploy and update the Lambda@Edge functions](../how-to/deploy-the-edge-functions.md) and [How to connect an MCP client and run an admin delete](../how-to/connect-an-mcp-client.md).

## Mount

| Item | Value | Source |
| --- | --- | --- |
| Public URL | `https://<site>/mcp`. A path on the site, not a subdomain (HFY-R59). | [`api/src/routes.js`](../../api/src/routes.js) (`MCP_RESOURCE`) |
| Lambda | `hfy-api`: the same function and Function URL as `/api/*` ([API: Runtime](api.md#runtime)) | [`api/src/index.js`](../../api/src/index.js) |
| Dependency | `@io-kit/mcp` 0.1.0, pinned exactly: `@io-kit/mcp/edge` (bearer gate, protected-resource metadata, 401) and `@io-kit/mcp/core` (JSON-RPC `tools/list` and `tools/call` over a registry, evaluated against a policy) | [`api/package.json`](../../api/package.json) |
| Protocol | MCP `2025-06-18`. JSON-RPC over `POST` only: no SSE stream (`GET /mcp` is `405` with `Allow: POST`) and no batches. `initialize` reports `serverInfo` `{name: "hfy-mcp", version: "0.1.0"}` and `tools.listChanged: false`. | `@io-kit/mcp/core`, `createMcpCore` in `mcp.js` |
| Authorization server | The auth edge, issuer `https://<site>/auth` (HFY-R44). Its metadata and endpoints are served there, not by this mount. See [Identity services: MCP authorization server](identity-services.md#mcp-authorization-server). | [`auth/src/oauth.js`](../../auth/src/oauth.js) |
| CloudFront | `/mcp*` and `/.well-known/oauth-protected-resource*` behaviors on the `hfy-api-origin` origin, with caching disabled, all viewer headers except `Host` forwarded, all seven methods allowed, and the `hfy-mcp-edge401` Lambda@Edge function on `origin-response` | [`scripts/infra/add-mcp-behavior.sh`](../../scripts/infra/add-mcp-behavior.sh), [`infrastructure/mcp-edge401.us-east-1.yaml`](../../infrastructure/mcp-edge401.us-east-1.yaml) |

### Source files

| File | Role |
| --- | --- |
| [`api/src/mcp.js`](../../api/src/mcp.js) | `isMcpPath`, `loadMcpConfig`, the edge (`createMcpEdge`), the tool registry (`buildMcpRegistry`), the core (`createMcpCore`), the actor (`actorFor`, `tokenLabel`) and the mount (`createMcpMount`) |
| [`api/src/policy.js`](../../api/src/policy.js) | `POLICY_ROWS`, `STEP_UP_MAX_AGE_SECONDS`, `STRONG_AMR`, `policyDocument`, and the groups parser and resolver |
| [`api/src/routes.js`](../../api/src/routes.js) | `MCP_RESOURCE` and the `MCP` map: each tool's name, description, input schema and argument mapping |
| [`api/src/labels.js`](../../api/src/labels.js) | `cleanLabel`, `fallbackLabel` and the person-record label resolver, shared with the HTTP path |
| [`api/src/mcp-caps.js`](../../api/src/mcp-caps.js) | Build-time views: `mcpToolsList`, `mcpParityCaps` |
| [`api/src/handler.js`](../../api/src/handler.js) | `invoke`, which runs a route's handler for a tool |

### Routing in `index.js`

1. **Origin check.** The `X-Origin-Verify` check runs first, for every path (HFY-R43). Failure is `403 {"error":"forbidden"}`. The kit edge's own origin check is not configured, because this one already ran.
2. **API handler.** On the first verified request in a container, `index.js` loads the VAPID keys, when `VAPID_SECRET` names a secret, and builds the API handler. The tools call its `invoke` ([Execution](#execution)).
3. **MCP paths.** `isMcpPath` in `mcp.js` matches `rawPath` against `/mcp`, `/mcp/*`, `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/*`. A match goes to the mount, which `createMcpMount` builds on the first such request and keeps for the life of the container. The [configuration](#configuration) is read at that moment.
4. **Everything else** goes to the API pipeline ([API: Request pipeline](api.md#request-pipeline)).

The API's session cookie is never consulted on MCP paths. The mount authenticates by bearer token only. Trailing slashes are not removed, so `/mcp/` reaches the mount and then gets `404`.

The kit's Lambda adapter rebuilds the request URL on the resource's origin (`https://<site>`), because behind CloudFront the `Host` header is the Function URL's host.

### CloudFront behaviors

[`scripts/infra/add-mcp-behavior.sh`](../../scripts/infra/add-mcp-behavior.sh) upserts the `hfy-api-origin` origin (the app stack's `FunctionUrl` output, with the `X-Origin-Verify` header) and the two behaviors `/mcp*` and `/.well-known/oauth-protected-resource*`. Unless `--function-url` is given, it reads the Function URL from the stack named by `--stack`, whose default `hfy-app` is not the live stack's name, so a live run passes `--stack <app-stack>`. It follows the contract of the other `add-*-behavior.sh` scripts: a rerun against a matching distribution changes nothing, `--dry-run` prints a redacted diff, and the origin-verify value is never printed. It exits `3` when an earlier behavior already matches `/mcp` or `/.well-known/oauth-protected-resource` and would shadow the new one.

### What the mount answers

| Path | Method | Token | Response |
| --- | --- | --- | --- |
| `/.well-known/oauth-protected-resource`, `/.well-known/oauth-protected-resource/mcp` | `GET`, `HEAD` | none | `200`, the [metadata](#protected-resource-metadata-and-challenges) |
| The same two paths | `OPTIONS` | none | `204` |
| The same two paths | any other | none | `405` with `Allow: GET, HEAD, OPTIONS` |
| Any routed path | `OPTIONS` | none | `204` with no CORS grant |
| `/mcp` | `POST` | required | JSON-RPC (below) |
| `/mcp` | any other except `OPTIONS` | required | `405` with `Allow: POST` |
| Any other routed path, such as `/mcp/x` or `/.well-known/oauth-protected-resource/x` | any | required | `404` with an empty body |

Without a valid token, every path that needs one gets the [401 challenge](#401-responses) first.

JSON-RPC on `POST /mcp`:

| Request | Result |
| --- | --- |
| `initialize`, `ping`, `tools/list`, `tools/call` | `200` with a JSON-RPC result or error |
| Any other method | Error `-32601` |
| A notification (no `id`) | `202` with no body |
| A body that is not valid JSON | `400`, error `-32700` |
| A JSON array (batch) or a malformed request object | Error `-32600` |

The kit edge can also answer `/.well-known/oauth-authorization-server`, but `isMcpPath` does not route that path to the mount. CloudFront sends `/.well-known/oauth-authorization-server*` to the auth edge ([`add-auth-behavior.sh`](../../scripts/infra/add-auth-behavior.sh)).

## Configuration

`loadMcpConfig` in [`mcp.js`](../../api/src/mcp.js) and the S3 loaders in [`index.js`](../../api/src/index.js) read these variables. A variable that is set is used as is: the defaults apply only when it is absent.

| Variable | Default in code | Set by `app-stack.yaml` | Used for |
| --- | --- | --- | --- |
| `MCP_RESOURCE_URL` | `MCP_RESOURCE` in [`routes.js`](../../api/src/routes.js): `https://<site>/mcp` | No | The metadata's `resource`, the challenge's `realm` (its host) and `resource_metadata` (its origin), and the origin the request URL is rebuilt on |
| `MCP_AUDIENCE` | `MCP_RESOURCE_URL`, else `MCP_RESOURCE` | No | The `aud` every token must carry (RFC 8707) |
| `MCP_TOKEN_ISSUER` | `SESSION_ISSUER`, else `https://<site>/auth` | No | The pinned `iss`, and the metadata's `authorization_servers` |
| `SESSION_ISSUER` | Falls through to `https://<site>/auth` | Yes, from `SessionIssuer` | The issuer, because `MCP_TOKEN_ISSUER` is unset |
| `SESSION_JWKS_URL` | `<issuer>/.well-known/jwks.json` | Yes, from `SessionJwksUrl` | The auth edge's public keys |
| `MCP_CLIENT_IDS` | `mcp-harrisonfamily` (comma-separated list) | No | The `client_id` values an access token may carry |
| `MCP_SCOPES` | `openid email profile` (separated by spaces or commas) | No | The scope advertised in the metadata and the challenge. Not enforced. |
| `GROUPS_BUCKET` | `<config-bucket>` | No | Bucket of the [groups config](#groups) |
| `GROUPS_KEY` | `config/groups.json` | No | Key of the groups config |
| `MEDIA_BUCKET` | `<site-bucket>` | Yes, from `MediaBucket` | Person records for [labels](#actor-and-label) (and member uploads) |

- `app-stack.yaml` sets none of the `MCP_*` or `GROUPS_*` variables on `hfy-api`, so the code defaults run. Its `McpResources` parameter sets `MCP_RESOURCES` on `hfy-auth-edge` only: the resources the authorization server will mint an `aud` for, the first being the default. That parameter and `MCP_RESOURCE` must name the same URL, or every token fails the audience check.
- `SESSION_ISSUER`, `SESSION_JWKS_URL` and `MEDIA_BUCKET` come from stack parameters, the same ones the cookie path uses ([API: Environment](api.md#environment)).
- The cookie path and the MCP edge keep separate JWKS caches. The kit edge caches the keys for 3600 s, refetches at most once per lookup when a token names an unknown `kid`, and keeps serving the previous keys when a scheduled refresh fails.

## Protected resource metadata and challenges

### Metadata

Served without a token at both `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp`, with `content-type: application/json; charset=utf-8` and `cache-control: no-store`:

```json
{
  "resource": "https://<site>/mcp",
  "authorization_servers": ["https://<site>/auth"],
  "bearer_methods_supported": ["header"],
  "scopes_supported": ["openid", "email", "profile"]
}
```

### Token checks

The kit edge checks, in this order ([`@io-kit/mcp/edge`](../../api/package.json), `verifyBearer`):

1. An `Authorization: Bearer <token>` header is present.
2. The token is a three-part JWT whose header and payload decode to JSON objects.
3. The header's `alg` is `RS256`, and its `kid` names a key in the JWKS at `SESSION_JWKS_URL`.
4. The RS256 signature verifies.
5. `iss` equals the pinned issuer (`MCP_TOKEN_ISSUER`, else `SESSION_ISSUER`).
6. `exp` is in the future and `nbf`, if present, is not. There is no clock tolerance.
7. `token_use` is `access` and `client_id` is in `MCP_CLIENT_IDS`. (The kit also passes a `token_use` of `id` whose `aud` names one of those client ids. Any other `token_use` fails.)

Then the mount checks:

8. `aud` equals the audience (`MCP_AUDIENCE`), as a string or as one entry of an array. This rejects an ID token that passed step 7, and a site session token, whose audience is `harrisonfamily-web`.

The `scope` claim is not checked.

### 401 responses

Every `401` has `content-type: application/json; charset=utf-8` and `cache-control: no-store`.

| Case | Body | `WWW-Authenticate` |
| --- | --- | --- |
| No `Authorization: Bearer` header | `{"error":"unauthorized"}` | `Bearer realm="<site>", resource_metadata="https://<site>/.well-known/oauth-protected-resource", scope="openid email profile"` |
| A failed edge check (steps 2 to 7) | `{"error":"invalid_token","error_description":"<text>"}` | The same, followed by `, error="invalid_token", error_description="<text>"` |
| `aud` is not the resource (step 8) | `{"error":"invalid_token","error_description":"token not issued for this resource"}` | The same, with that description |

The edge's `<text>` values: `malformed token`, `unsupported signing algorithm`, `signing key not found`, `signature verification failed`, `issuer mismatch`, `token expired or not yet valid`, `unsupported token use` and `token not issued to this client`. If the edge has to fetch the JWKS and the fetch fails, the response is `503 {"error":"temporarily_unavailable"}` with `Retry-After: 5`. That happens when no keys are cached, or when the token's `kid` is not among the cached keys. A failed scheduled refresh alone does not cause it: a token whose `kid` is cached still verifies against the previous keys.

**Through CloudFront.** A Lambda Function URL renames a `WWW-Authenticate` response header to `x-amzn-remapped-www-authenticate`, and a CloudFront Function cannot run on a `4xx` response. The `hfy-mcp-edge401` function, attached on `origin-response` to both MCP behaviors, copies the first `x-amzn-remapped-www-authenticate` value back as `WWW-Authenticate` on a `401` when the response has no `WWW-Authenticate`. It leaves every other status alone and does not remove the remapped header.

| Item | Value |
| --- | --- |
| Stack | `hfy-mcp-edge401`, in `us-east-1` (Lambda@Edge functions must live there) |
| Function | `hfy-mcp-edge401`: Node.js 22, 128 MB, 3 s, inline code (a CommonJS copy of the kit's `infra/edge-401-header.mjs`) |
| Output | `Edge401FunctionVersionArn`, a numbered version. `add-mcp-behavior.sh` takes the ARN from `--edge401-arn`, else `$EDGE401_ARN`, else this output, and refuses one that is not a numbered `us-east-1` version. |
| Republishing | The `Edge401Version` description carries the first 16 hex characters of the SHA-256 of the inline code. Changing the code means changing that hash, which replaces the version resource and publishes a new number. Old versions are retained for CloudFront replicas. |

For the deploy steps, see [How to deploy and update the Lambda@Edge functions](../how-to/deploy-the-edge-functions.md).

## Tools

The tools are derived from the `MCP` map in [`routes.js`](../../api/src/routes.js): each route with an `mcp` member becomes one tool (`buildMcpRegistry` in `mcp.js`). Annotations are computed from the route: `readOnly` for a route that does not write, `destructive` for a `DELETE`, `idempotent` for anything but a `POST`. On the wire they are `readOnlyHint`, `destructiveHint` and `idempotentHint`.

| Tool | Route action | HTTP route | `write` | Annotations | Notes |
| --- | --- | --- | --- | --- | --- |
| `hfy_comments_list` | `comments.list` | `GET /api/comments` | false | readOnly, idempotent | Oldest first by default; `order` `desc` for newest first, with reactions |
| `hfy_comments_create` | `comments.create` | `POST /api/comments` | true | none | A reply when `parentId` is given. Sends notifications. |
| `hfy_comments_delete` | `comments.delete` | `DELETE /api/comments/:id` | true | destructive, idempotent | Admin with a fresh step-up only |
| `hfy_posts_list` | `posts.list` | `GET /api/posts` | false | readOnly, idempotent | Newest first |
| `hfy_posts_get` | `posts.get` | `GET /api/posts/:id` | false | readOnly, idempotent | |
| `hfy_posts_create` | `posts.create` | `POST /api/posts` | true | none | Always a draft: the tool sets `visibility: "draft"` and has no visibility argument. Publishing is a person's action in the site. No `attachments` argument. |
| `hfy_posts_delete` | `posts.delete` | `DELETE /api/posts/:id` | true | destructive, idempotent | Admin with a fresh step-up only. Also removes the post's comment thread. |
| `hfy_records_get` | `edit.get` | `GET /api/edit/:cls/:ref` | false | readOnly, idempotent | The edit bundle, through `publishView` and `applyModOverlay`; `pending[]` lists only suggestions the caller may see. 404 while `HFY_EDITING` is off. |
| `hfy_changes_submit` | `changes.post` | `POST /api/changes` | true | none | Submits EditOps. An agent call returns the plan and writes nothing (see [Editing tools](#editing-tools)). A real submission needs an `idempotency_key`. |
| `hfy_proposals_list` | `proposals.list` | `GET /api/proposals` | false | readOnly, idempotent | Only suggestions the caller may see; `view=queue` is 403 for a non-admin. |
| `hfy_proposals_get` | `proposals.get` | `GET /api/proposals/:id` | false | readOnly, idempotent | 404 outside the proposer, admins and the owners of the targeted pages. |

No other route is a tool: comment edits and reactions, post edits and visibility changes, uploads, notification settings and profile links are reachable only from the site. [`api/parity/map.yaml`](../../api/parity/map.yaml) pairs each tool with the route handler a person uses for the same action, and [`api/parity/routes.yaml`](../../api/parity/routes.yaml) lists the site pages that call those handlers.

Comment photos ([API: Comment photos](api.md#comment-photos), behind `commentPhotosV1`) are site-only too. `hfy_comments_create` has no `attachments` argument, and `comments.update` and `uploads.presign` are not tools. A photo-only comment, whose `body` is the empty string, cannot be made through MCP: `args` drops an empty `body`, and the route then answers `body is required`.

### Arguments

Every input schema is an object with `additionalProperties: false`. The `required` lists below are copied from `routes.js`. Each tool's `args` function maps its arguments onto the `params`, `query` and `body` the route handler receives.

| Tool | `required` | Other properties | Passed to the route as |
| --- | --- | --- | --- |
| `hfy_comments_list` | `["subject"]` | `order` (`asc` or `desc`), `cursor`, `limit` (integer, 1 to 100) | query `subject`, `order`, `cursor`, `limit` |
| `hfy_comments_create` | `["subject", "body"]` | `parentId`; `body` has `maxLength` 1000 | body `subject`, `body`, `parentId` |
| `hfy_comments_delete` | `["subject", "id"]` | `reason` | param `id`; query `subject`, `reason` |
| `hfy_posts_list` | `[]` | `subject`, `type` (`post`, `article`, `document`), `author`, `visibility` (`draft`, `published`, `withdrawn`), `cursor`, `limit` (integer, 1 to 100) | query, the same names |
| `hfy_posts_get` | `["id"]` | none | param `id` |
| `hfy_posts_create` | `["body"]` | `type` (`post`, `article`, `document`), `subject`, `title` (`maxLength` 200) | body `type`, `subject`, `title`, `body`, plus `visibility: "draft"` |
| `hfy_posts_delete` | `["id"]` | none | param `id` |
| `hfy_records_get` | `["cls", "ref"]` | `cls` is a record class, `ref` a gramps_id or `h:<handle>` | params `cls`, `ref` |
| `hfy_changes_submit` | `["ops"]` | `target`, `base_versions`, `note` (`maxLength` 1000), `route` (`auto`, `review`), `idempotency_key` | body, the same names |
| `hfy_proposals_list` | `[]` | `view` (`queue`, `mine`, `about-me`), `state`, `cursor`, `limit` (integer, 1 to 50) | query, the same names |
| `hfy_proposals_get` | `["id"]` | none | param `id` |

- `@io-kit/mcp` 0.1.0 does not validate arguments against the schema. `args` keeps only the properties it names and drops any whose value is `undefined` or an empty string. The route handler's own checks then apply: a missing `subject`, for example, comes back as an `isError` result with the text `subject is required`, and a `limit` above 100 is not refused: the API clamps it to 1 through 200 ([API: Listing](api.md#listing)).
- `mode` is reserved for [dry runs](#dry-runs) and is removed before `args` runs.

### Results

| Outcome | `tools/call` result |
| --- | --- |
| The route returns a body | `content: [{type: "text", text: <the body as JSON>}]`, plus `structuredContent` (the body) when the body is an object |
| The route returns no body (a delete's `204`) | The same, for `{"ok": true, "action": "<route action>"}` |
| The route throws (validation, not found, conflict) | `isError: true` with `content` holding the error's message only. The HTTP status and error code are not returned. The error is logged as `tool <name> failed`. |
| The contact-information guard refuses the text (`hfy_posts_create` body or title, `hfy_comments_create` body) | `isError: true` with `content` holding the guard's copy only ("this looks like a phone number or street address. …", or "we only keep the birth year on the site." while `HFY_GUARD_DOB` is `on`). Nothing is stored, and the matched text is not returned ([API: Contact-information guard](api.md#contact-information-guard)). |
| The policy denies the call | `isError: true`, `content` holding the reason's message (or its code when it has none), and `structuredContent: {reason: {code, message?}}` |
| The tool is hidden from the caller, or does not exist | JSON-RPC error `-32602`, `Unknown tool: <name>`. A hidden tool and an unknown one cannot be told apart (M-07). |
| `name` missing, `arguments` not an object, or `mode` not `dry_run` or `execute` | JSON-RPC error `-32602` |

## Policy

`POLICY_ROWS` in [`policy.js`](../../api/src/policy.js). Action ids are route names.

| `action` | `show` | `execute` | `minAssurance` | `agentMode` |
| --- | --- | --- | --- | --- |
| `comments.list` | `mcp-authors`, `hfy-admin` | `mcp-authors`, `hfy-admin` | none (session) | none |
| `posts.list` | `mcp-authors`, `hfy-admin` | `mcp-authors`, `hfy-admin` | none (session) | none |
| `posts.get` | `mcp-authors`, `hfy-admin` | `mcp-authors`, `hfy-admin` | none (session) | none |
| `comments.create` | `mcp-authors`, `hfy-admin` | `mcp-authors`, `hfy-admin` | none (session) | `dry_run` |
| `posts.create` | `mcp-authors`, `hfy-admin` | `mcp-authors`, `hfy-admin` | none (session) | `dry_run` |
| `edit.get` | `mcp-authors`, `hfy-admin` | `mcp-authors`, `hfy-admin` | none (session) | none |
| `proposals.list` | `mcp-authors`, `hfy-admin` | `mcp-authors`, `hfy-admin` | none (session) | none |
| `proposals.get` | `mcp-authors`, `hfy-admin` | `mcp-authors`, `hfy-admin` | none (session) | none |
| `changes.post` | `mcp-authors`, `hfy-admin` | `mcp-authors`, `hfy-admin` | none (session) | `dry_run` |
| `*.delete` | `hfy-admin` | `hfy-admin` | `step_up` | `dry_run` |

- `POLICY` is `{rows: POLICY_ROWS, defaultGroup: "mcp-authors"}`. `defaultGroup` names the group an empty tool list asks for.
- An exact action beats a glob, and among globs the longest pattern wins. `*.delete` covers `comments.delete`, `posts.delete` and any later `*.delete` route. An action with no row is hidden from everyone.
- **Listing** (`tools/list`, per caller): a tool is hidden when the caller is in none of the row's `show` groups; listed with `disabled: true` and `reason.code` `step_up_required` when the row needs `step_up` and the caller lacks it; listed with `disabled: true` and `policy_denied` when the caller is in none of the `execute` groups; otherwise listed with `disabled: false`. An empty list carries `_meta.reason`: `not_in_group` (with `group: "mcp-authors"`) when the caller is not in `mcp-authors`, else `policy_denied`.
- **Calling** (`tools/call`): a hidden tool is `-32602`. Otherwise the call is denied, as an `isError` result, when the caller is in none of the `execute` groups (`policy_denied`) or lacks a required step-up (`step_up_required`).
- `agentMode` is published in the policy document, but no principal on this server is an agent, so it changes nothing ([Dry runs](#dry-runs)).

### Step-up

`createMcpCore` passes `STEP_UP_MAX_AGE_SECONDS` (300) and `STRONG_AMR` (`["mfa"]`) to the core, replacing the kit's default strong list of `mfa`, `hwk` and `passkey` (HFY-R67). A caller has `step_up` assurance when both hold:

- `amr` contains `mfa`, and
- `auth_time` is no more than 300 seconds before the server's clock.

Otherwise the assurance is `session`.

- `auth_time` `0` means unknown, and counts as stale. The auth edge always sets `auth_time` on an MCP access token, with `0` when the sign-in time is unknown, and a refresh never advances it. (If a token had no numeric `auth_time`, the kit edge would use `iat` instead.)
- `passkey`, `hwk`, `swk`, `pwd` or `fed` without `mfa` never count. A passkey sign-in carries `mfa` only when the device verified the user.
- For the `amr` values the auth edge mints, see [Identity services: Token claims](identity-services.md#token-claims). For asking the authorization server for a fresh sign-in (`max_age`, `prompt=login`), see [Identity services: MCP authorization server](identity-services.md#mcp-authorization-server).

## What a caller sees

From [`api/test/mcp.test.js`](../../api/test/mcp.test.js):

| Caller | `tools/list` | Calling a delete tool |
| --- | --- | --- |
| Valid token, in neither group | `{"tools": [], "_meta": {"reason": {"code": "not_in_group", "group": "mcp-authors", ...}}}` | `-32602` |
| `mcp-authors` member | The five read and create tools. No delete tools. | `-32602`, as for an unknown tool |
| `hfy-admin`, no fresh step-up | All seven tools. `hfy_comments_delete` and `hfy_posts_delete` have `disabled: true` and `reason.code` `step_up_required`. | `isError: true` with `structuredContent.reason.code` `step_up_required` |
| `hfy-admin` with a fresh step-up | All seven tools, none disabled | Runs. An admin can delete any post or comment. |

Other cases the tests pin:

- A `groups` claim in the token grants nothing, even `["mcp-authors", "hfy-admin", "admins"]`.
- An `mcp-authors` email entry matches a token `email` claim case-insensitively, and does not match when the token says `email_verified: false`.
- A groups config that cannot be read gives every caller an empty list.
- A presence-only passkey (`amr` `["passkey"]`, `["passkey", "hwk"]`, `["passkey", "swk"]`, `["hwk"]`), `["fed"]` or `["pwd"]` leaves the deletes disabled, however recent. `["mfa"]` or `["passkey", "swk", "mfa"]` within 300 s enables them, and `["passkey", "hwk", "mfa"]` 900 s old does not.

## Groups

`createGroupResolver` in [`policy.js`](../../api/src/policy.js) reads `s3://<config-bucket>/config/groups.json` (`GROUPS_BUCKET` / `GROUPS_KEY`):

```json
{
  "version": 1,
  "groups": {
    "mcp-authors": { "emails": ["member-one@example.com"], "subjects": ["<gramps-id>"] },
    "hfy-admin": { "subjects": ["<gramps-id>"] },
    "uat": { "subjects": ["<gramps-id>"] }
  }
}
```

- **Read-only.** The API never writes the file, and no script in the repository does. The `hfy-api` role reads it through the `AdminList` statement, which allows `s3:GetObject` on `config/*` in `ConfigBucket`. To edit it, see [How to add or remove a family member's access](../how-to/manage-family-access.md).
- **Parsing.** Only `groups` is read; `version` is not checked. Each list keeps its non-empty strings, trimmed, and `mcp-authors` emails are lowercased. A missing group, list or object yields an empty set, so an unexpected shape grants nothing. `mcp-authors` may be empty.
- **Cache.** 60 s per container. A failed read or a body that is not JSON logs `groups config unavailable (failing closed)` with the error message, grants no groups to anyone, and is retried after 5 s. A failure also discards a copy loaded earlier.
- **`mcp-authors`** matches when the token's `sub` (a gramps id) is in `subjects`, or when `emails` is not empty and the token's `email` claim matches an entry case-insensitively. The email counts only when `email_verified` is not `false`. MCP access tokens from the auth edge carry no `email_verified` claim, so their `email` always counts when present.
- **`hfy-admin`** matches `subjects` only. An `emails` list under it is ignored.
- **`uat`** matches `subjects` only, like `hfy-admin`. It grants no tool, because no policy row names it. The API's feature gate reads it: its members reach routes that are still behind a flag ([API: Feature gate](api.md#feature-gate)).
- A token with no `sub` gets no groups.
- The token's own `groups` claim (`members`, `admins` and allowlist roles from the auth edge) is ignored. `config/admins.json` plays no part in MCP authorization, and an `hfy-admin` subject need not be on it.
- `createGroupResolver` also accepts `emailsFor(sub)`, an allowlist lookup of the emails bound to a subject. It exists in `policy.js` but is not wired in `index.js`, so only the token's `email` claim is matched.

## Actor and label

A tool runs as the actor `{id, label, admin}`, the shape the HTTP path builds from the session cookie (`actorFor` in [`mcp.js`](../../api/src/mcp.js)):

| Field | Value |
| --- | --- |
| `id` | The token's `sub`, the member's gramps id |
| `label` | See below |
| `admin` | `true` when the [groups](#groups) include `hfy-admin` |

`label` is stored as `author.label` on comments, posts, their index items and audit items, and names the actor in push notifications. Every member can see it, so it is never an email address (HFY-R68). It is the first of these that is usable:

1. The token's `name` claim, trimmed (`tokenLabel`, which applies `cleanLabel`).
2. The person's `displayName` from `s3://<site-bucket>/person/<gramps-id>.json`.
3. The gramps id.
4. `family member`, when the gramps id is empty or itself contains `@` or a control character.

`cleanLabel` in [`labels.js`](../../api/src/labels.js) rejects a value that is not a string, is empty after trimming, equals the gramps id, is longer than 200 characters, contains `@`, or contains a control character. The `email` claim is never a candidate. Step 2 runs only for a gramps id of 1 to 64 letters, digits, `_` or `-`.

- The label is resolved only when a tool executes. `initialize`, `tools/list` and dry runs read no person record.
- The lookup is the same `createLabelResolver` instance the HTTP path uses, so one member has one label on both paths, and both share its cache. The cache timings and the record lookup are in [API: Session verification](api.md#session-verification).
- The `hfy-api` role may read only `person/*` in `MediaBucket` (the `PersonRecords` statement).

## Execution

`buildMcpRegistry` gives each tool a `run` that calls `handler.invoke(actor, routeName, {params, query, body})` ([`api/src/handler.js`](../../api/src/handler.js)). `invoke` finds the route by name and calls the route's own handler with the services built for that actor. A tool call therefore gets the same validation, Q-4 permissions, D-15 `AUDIT#` items and notifications as the HTTP route ([API: Permissions](api.md#permissions), [API: Audit records](api.md#audit-records), [API: Notifications](api.md#notifications)).

- What `invoke` skips is the HTTP framing: route matching, the session cookie, the content-type check and body parsing. The tool's `args` supplies `params`, `query` and `body` directly.
- What `invoke` keeps is the route's [feature gate](api.md#feature-gate). A tool whose route is behind a flag that is off answers `404 not_found` unless the actor is in `uat`. A tool call has no preview header.
- `admin` comes from `hfy-admin`, so an `hfy-admin` caller is an API admin for the call: `hfy_posts_list` and `hfy_posts_get` show other members' drafts and withdrawn posts, and a `reason` on `hfy_comments_delete` is recorded when the comment is someone else's.
- Audit items record the actor's `id` as `principal`. Comments removed with a deleted post are audited with that `id` and the reason `post deleted`.
- `hfy_posts_create` makes drafts only, so it never sends `new_family_post`. `hfy_comments_create` sends the usual comment notifications when push is configured.

### Editing tools

HFY-TSK-211 (editing design 7.6). The four editing tools are listed to `mcp-authors` and `hfy-admin` and hidden from everyone else, and the routes behind them answer 404 while the `HFY_EDITING` stack switch is off.

- **There is no decide tool** (DEC-E5). Approving, denying, amending and withdrawing a suggestion are people's actions in the site: `proposals.decide`, `proposals.amend` and `proposals.withdraw` have no `mcp` member and no policy row, and a `tools/call` naming a decide tool is `-32602`.
- **`hfy_changes_submit` for an agent.** A principal of type `agent` defaults to `dry_run` and is denied `execute` with `agent_dry_run_only`. The dry run adds the route's own plan to the ResolvedCall: `plan` (`{direct, review}`), `warnings` and `errors`, or `planError` (`{status, error, message, errors}`) when the route refuses the submission. It runs the planning steps of `POST /api/changes` with `dry_run: true`, which write nothing (no receipt, `PROP#`, `IDX#` or `THREAD#` row). The shipped edge builds every principal as `human`, so for a person's session the plan comes from an explicit `mode: "dry_run"`, and a call without `mode` submits.
- **Failures keep their status.** A tool with `mcp.problem` set in `routes.js` returns a failing route as `isError: true` whose text is JSON, `{status, error, message, errors?, details?}`: the HTTP body, so a privacy-guard refusal reads as `422` with positions and codes only, never the matched text.
- **Reads go through the record views.** `hfy_records_get` hides moderated items from callers who are not an admin or the page owner and shows non-birth dates as the year only, and `pending` lists only the caller's own suggestions, those about their page and, for an admin, all of them.

## Dry runs

A `tools/call` on a write tool (any tool that is not `readOnly`) with `arguments.mode` set to `dry_run` returns a ResolvedCall v1 and writes nothing:

```json
{
  "version": "1",
  "kind": "resolved_call",
  "mode": "dry_run",
  "tool": "hfy_posts_delete",
  "action": "posts.delete",
  "arguments": { "id": "<ulid>" },
  "principal": { "type": "human", "sub": "<gramps-id>" },
  "decision": {
    "effect": "deny",
    "reason": { "code": "step_up_required", "message": "Recent step-up authentication is required." },
    "assurance": { "required": "step_up", "actual": "session" }
  },
  "wouldExecute": false,
  "idempotent": true,
  "effects": [{ "description": "<the tool description>", "destructive": true }]
}
```

- It comes back as both `content` (text) and `structuredContent`, never as `isError`. A denied dry run carries `decision.effect` `deny` and `wouldExecute: false`.
- A dry run checks the policy only: the row's `show` groups and the step-up. `wouldExecute` is true when the dry run is allowed and an execute would be allowed too. The route handler does not run, so its validation does not either, and `wouldExecute: true` does not promise the call will succeed.
- `mode: "execute"` and a missing `mode` both execute. A call without `mode` executes (`create post is always a draft` in `mcp.test.js`).
- Read tools always execute. `mode` is removed from their arguments and ignored.
- **`agentMode`** is published in the policy (`dist/policy.json`). In the installed `@io-kit/mcp` 0.1.0 the core applies it only to principals of type `agent`: for them a write tool defaults to `dry_run`, an execute is denied with `agent_dry_run_only` unless the row's `agentMode` is `execute`, and a row with `agentMode: "deny"` lists the tool as disabled and denies every call. The kit does not put `agentMode` in `tools/list`. The 0.1.0 edge builds every principal with type `human`, so on this server `agentMode` is never applied.

## Audit

Each `tools/call` that reaches the policy writes one structured log line, `mcp.audit`, through `console.info` to the CloudWatch Logs group `/aws/lambda/hfy-api` (30-day retention in `app-stack.yaml`). It is not a DynamoDB item. A call to a hidden or unknown tool, or with invalid parameters, is answered with `-32602` and not audited.

| Field | Value |
| --- | --- |
| `ts` | Epoch seconds |
| `tool`, `action` | Tool name and route action |
| `mode` | `execute` or `dry_run` |
| `outcome` | `executed`, `error`, `denied` or `dry_run` |
| `auth_method` | The first `amr` value, or `unknown` |
| `auth_time` | The principal's `auth_time` |
| `assurance` | `session` or `step_up` |
| `principal` | Only `{type, sub, groups}`. The label is dropped. |

- `tools/list`, `initialize` and `ping` are not audited.
- The edge also logs `mcp.edge.request` for every request: `ts`, `method`, `path`, `status`, `sub_hash` (the first 16 hex characters of the SHA-256 of `sub`), `token_use`, `outcome` (`public`, `allow` or `deny`) and, on a denial, `reason`.
- The `mcp.audit` line carries the member's gramps id, so the log is private ([Private data and secrets inventory](private-data-and-secrets.md)).
- Route writes still write their own `AUDIT#` items in the same transaction as the change ([API: Audit records](api.md#audit-records)).

## Generated documents

[`api/scripts/gen-caps.mjs`](../../api/scripts/gen-caps.mjs) (`npm run gen-caps` in `api/`) writes four files under `api/dist/`, which is gitignored. Nothing reaches AWS or the network.

| File | Built by | Contents |
| --- | --- | --- |
| `dist/caps.json` | `buildCaps` in [`routes.js`](../../api/src/routes.js) | The API capability document ([API: caps.json](api.md#capsjson)), now with an `mcp` field: `{resource: MCP_RESOURCE, tools: [{name, action, write}]}`, one entry per tool |
| `dist/policy.json` | `policyDocument()` in [`policy.js`](../../api/src/policy.js) | `{version: 1, defaultGroup: "mcp-authors", adminGroup: "hfy-admin", stepUp: {maxAgeSeconds: 300, amr: ["mfa"]}, rows: POLICY_ROWS}` |
| `dist/mcp/tools.json` | `mcpToolsList` in [`mcp-caps.js`](../../api/src/mcp-caps.js) | The `tools/list` result for a build principal in both groups with a fresh `mfa` step-up: all seven tools, none disabled |
| `dist/mcp/parity-caps.json` | `mcpParityCaps` in `mcp-caps.js` | An `@io-kit/parity` caps document (`schemaVersion` `1.1.0`, `surface` `hfy-mcp`, a fixed `generatedAt`), with one action per tool named like the tool: `title` (the description up to its first period), `inputSchema`, `outputSchema: null`, `annotations`, `requiresGovernanceHash: false`, `via: "top-level"`, and `dryRun` true for each write tool |

[`scripts/ci/package-api.sh`](../../scripts/ci/package-api.sh) runs `gen-caps` inside its staging directory and zips the whole `dist/`, so all four files ship in `hfy-api.zip`. It checks only that `caps.json` is not empty, and copies only `caps.json` back to `api/dist/`. No route serves any of the four.

## Conformance gate

```text
scripts/ci/mcp-conformance.sh [report-only|blocking]
```

[`scripts/ci/mcp-conformance.sh`](../../scripts/ci/mcp-conformance.sh), default `blocking`, works in `api/`:

1. Exits unless `CODEARTIFACT_AUTH_TOKEN` is set.
2. Runs `npm ci --ignore-scripts` when `api/node_modules` is missing.
3. Runs `gen-caps`.
4. Runs `vitest` over [`test/mcp-conformance.test.js`](../../api/test/mcp-conformance.test.js), [`test/mcp.test.js`](../../api/test/mcp.test.js) and [`test/mcp-infra.test.js`](../../api/test/mcp-infra.test.js).
5. Runs `io-kit parity diff --mode <mode> --stack hfy --caps dist/mcp/parity-caps.json --routes parity/routes.yaml --mapping parity/map.yaml --mcp-tools dist/mcp/tools.json` (`@io-kit/parity` 0.3.0, a dev dependency).

The mode reaches only the parity diff. A failing test fails the script in either mode.

| Suite | Covers |
| --- | --- |
| `mcp-conformance.test.js` | The kit's packaged corpus, MCP-C01 to MCP-C12. C01 to C09 drive `createMcpEdge` behind the Lambda adapter with the corpus's test-only keys: metadata, authorization-server metadata, PKCE wiring, CORS on the token legs, the bearer gate on every path, `token_use`, JWKS caching and rotation, and the `WWW-Authenticate` shape. C10 to C12 drive `createMcpCore` over the corpus's own registry and policy: dry runs, per-caller listing, and delete tools for admins with step-up only. |
| `mcp.test.js` | The mounted server end to end over the in-memory DynamoDB fake: discovery and the gate, listing per caller, tools running the route handlers, dry runs, step-up, labels, and the policy document |
| `mcp-infra.test.js` | `add-mcp-behavior.sh` in `--dry-run` against a fixture distribution config (adds both behaviors, a rerun is a no-op, the secret is never printed, an unversioned ARN and a shadowing behavior are refused), the `hfy-mcp-edge401` inline code, and that the parity caps, `caps.json` and `tools/list` name the same tools |

No workflow runs the script. `npm test` in `api/` runs the three suites with the rest, but not the parity diff. See [How to run the test suites](../how-to/run-the-tests.md).

## Discrepancies

These are differences between the code, its comments and its configuration, as of this page. See also [System architecture: Discrepancies in the code](architecture.md#discrepancies-in-the-code).

1. **Scope.** The challenge and the metadata advertise the scope `openid email profile` (`MCP_SCOPES`), while the authorization server's `scopes_supported` is `["mcp"]` ([`auth/src/oauth.js`](../../auth/src/oauth.js)). Neither side enforces a scope: the authorization server keeps any requested scope that matches its pattern (else `mcp`), and the MCP server does not read the `scope` claim.
2. **`dist/policy.json` and the UI.** The `policy.js` header and `gen-caps.mjs` say the UI reads `dist/policy.json` (M-09), so UI and MCP cannot disagree. Nothing in `islands/` or `11ty/js/` reads it, and it ships only inside the Lambda zip, where no route serves it.
3. **`emailsFor`.** `createGroupResolver` can match `mcp-authors` emails through the family allowlist, and the `policy.js` header describes that path, but `index.js` does not pass `emailsFor`. Only the token's `email` claim is matched.
4. **`GROUPS_BUCKET`.** The stack does not pass `GROUPS_BUCKET`, so the code default `<config-bucket>` is read whatever `ConfigBucket` says. The role may read only `ConfigBucket`'s `config/*`, so if `ConfigBucket` names another bucket the read is denied and every caller fails closed with no groups.
5. **`agentMode`.** The policy publishes `agentMode: "dry_run"` on the create and delete rows, which reads as agents defaulting to dry runs. The 0.1.0 edge builds every principal as `human`, so no call is ever treated as an agent's, and calls without `mode` execute.

## Related pages

- [API](api.md): the routes, permissions, audit items and notifications the tools reuse.
- [Identity services](identity-services.md): the authorization server, its token claims and the session JWKS.
- [System architecture](architecture.md): the CloudFront behaviors, the stacks and IAM.
- [Private data and secrets inventory](private-data-and-secrets.md): `config/` in `<config-bucket>`, person records and the placeholders used here.
- [Codebase map](codebase-map.md): where each capability lives.
- [The identity model](../explanation/identity-model.md) and [How member content stays accountable](../explanation/member-content-design.md): the reasoning.
- [How to deploy the app stack and its CloudFront behaviors](../how-to/deploy-the-app-stack.md), [How to deploy and update the Lambda@Edge functions](../how-to/deploy-the-edge-functions.md), [How to connect an MCP client and run an admin delete](../how-to/connect-an-mcp-client.md), [How to add or remove a family member's access](../how-to/manage-family-access.md), [How to run the test suites](../how-to/run-the-tests.md), [How to diagnose sign-in and API failures](../how-to/diagnose-sign-in-and-api-failures.md).
