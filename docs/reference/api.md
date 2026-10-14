# Family API (hfy-api)

Reference for hfy-api, the members-only JSON API served at `/api/*`. This page covers the runtime, the request pipeline, every route, the data each route reads and writes, permissions, audit records, notifications, uploads, configuration, session verification, the capability document and packaging.

The same Lambda function also serves the MCP server at `/mcp` and the protected-resource metadata at `/.well-known/oauth-protected-resource*`. Those paths authenticate with a bearer access token, not the session cookie, and are described in [MCP server](mcp-server.md). This page covers them only where they share code or configuration with `/api/*`.

For the reasoning behind these rules, see [How member content stays accountable](../explanation/member-content-design.md). For why the API sits behind CloudFront with a shared-secret header, see [Why one CloudFront distribution fronts everything](../explanation/edge-and-origin-design.md).

## Runtime

| Item | Value | Source |
| --- | --- | --- |
| Lambda function | `hfy-api` | [`app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml) |
| Runtime | Node.js 22 (`nodejs22.x`, arm64), ES modules | [`api/package.json`](../../api/package.json), `app-stack.yaml` |
| Handler | `src/index.handler` | [`api/src/index.js`](../../api/src/index.js) |
| Memory and timeout | 256 MB, 15 s | `app-stack.yaml` |
| Invocation | Lambda Function URL, `AuthType: NONE`, `InvokeMode: BUFFERED`, payload format 2.0 | `app-stack.yaml`, [`api/src/handler.js`](../../api/src/handler.js) |
| Public path, API | `/api/*` on the site's CloudFront distribution, with caching disabled and all viewer headers except `Host` forwarded | [`scripts/infra/add-api-behavior.sh`](../../scripts/infra/add-api-behavior.sh) |
| Public paths, MCP | `/mcp*` and `/.well-known/oauth-protected-resource*`, on the same origin (`hfy-api-origin`) with the same cache and origin request policies, plus the `hfy-mcp-edge401` Lambda@Edge function on `origin-response` ([MCP server: Mount](mcp-server.md#mount)) | [`scripts/infra/add-mcp-behavior.sh`](../../scripts/infra/add-mcp-behavior.sh) |
| Table | DynamoDB `hfy-app`: one table, index `GSI1`, TTL attribute `ttl` | `app-stack.yaml` |

### Source files

| File | Role |
| --- | --- |
| [`index.js`](../../api/src/index.js) | Lambda entry. Creates the AWS clients and the admin-list, label and groups resolvers, runs the origin check, builds the handler on the first verified request, and sends MCP paths to the MCP mount. |
| [`handler.js`](../../api/src/handler.js) | The pipeline: path, route, session, body. Wires the posts, comments, notification and upload services for each request. Also exposes `handler.invoke(actor, routeName, {params, query, body})`, which runs a route's own handler without the HTTP steps, for the MCP tools. |
| [`routes.js`](../../api/src/routes.js) | The route registry `ROUTES` (including each MCP tool's definition and each route's `gate`), `defineRoutes`, `matchRoute`, `MCP_RESOURCE`, and `buildCaps` for `caps.json`. |
| [`features.js`](../../api/src/features.js) | The [feature gate](#feature-gate): `requireFeature`, `serverSwitch` and `gateExempt` for `ROUTES` entries, the flags-file reader `createFlagSource`, `createFeatureGate`, the `x-hfy-preview` parser, and `featureOn` for producers. |
| [`http.js`](../../api/src/http.js) | JSON responses, `HttpError`, error mapping, cookie parsing. |
| [`origin.js`](../../api/src/origin.js) | The `X-Origin-Verify` check. |
| [`auth.js`](../../api/src/auth.js) | Remote JWKS, session authenticator (which resolves the actor's label), admin list. |
| [`labels.js`](../../api/src/labels.js) | Author labels: `cleanLabel`, `fallbackLabel` and the cached person-record resolver `createLabelResolver` (see [Author label](#author-label)). Used by the cookie path and the MCP path. |
| [`mcp.js`](../../api/src/mcp.js) | The MCP mount: `isMcpPath`, `loadMcpConfig`, the bearer edge, the tool registry built from `ROUTES`, and the actor a tool runs as. See [MCP server](mcp-server.md). |
| [`mcp-caps.js`](../../api/src/mcp-caps.js) | Build-time views of the MCP surface for `gen-caps`: the `tools/list` result and the `@io-kit/parity` caps document. |
| [`policy.js`](../../api/src/policy.js) | The MCP permission table `POLICY_ROWS`, the step-up settings, `policyDocument` for `dist/policy.json`, and the groups resolver for `config/groups.json` (the MCP groups and the feature gate's `uat` group), whose shape is documented at the top of the file. |
| [`content.js`](../../api/src/content.js) | Posts, as an `@io-kit/content` ContentSource. |
| [`comments.js`](../../api/src/comments.js) | Comments and reactions, as an `@io-kit/comments` CommentSource. |
| [`txn.js`](../../api/src/txn.js) | Audit item builder, `transact()` (puts, deletes, updates, condition checks, `ClientRequestToken`, conflict retry), `mapCancellationReasons`, `counterUpdate`, `mergeUpdates`, `assertTxnSize`, `GSI1` paging. |
| [`keys.js`](../../api/src/keys.js) | Key helpers. |
| [`notify.js`](../../api/src/notify.js) | Notification types, templates and fan-out, with the persist-first inbox gate (`featureOn("inboxV1", recipient)`). |
| [`uploads.js`](../../api/src/uploads.js) | Presigned photo uploads: validation and the object key. |
| [`presign.js`](../../api/src/presign.js) | The S3 presigner for uploads, kept apart so tests can sign offline. |
| [`records/ops.js`](../../api/src/records/ops.js) | The EditOp engine for the editing work: `applyOps`, `invertOps`, `rebaseOps` (clean, no-op or conflict per op), keyed list segments (`@ref=`, `@=`, `@k=`) and `mintHandle`. It imports nothing, so it runs in Node and in a browser, and no route calls it yet. See [The EditOp engine](#the-editop-engine). |
| [`records/semantics.js`](../../api/src/records/semantics.js) | The Gramps rules for edited records: dates and `sortval`, handle references, two-sided family links, family sanity, ancestry cycles and the derived `birth_ref_index` and `death_ref_index`. `checkSemantics` runs on the objects an EditOp batch produced. It imports only the EditOp engine and the calendar port, and no route calls it yet. See [Gramps semantics](#gramps-semantics). |
| [`records/gcalendar.js`](../../api/src/records/gcalendar.js) | A port of Gramps' calendar arithmetic (`*_sdn` in `gen/lib/gcalendar.py`): Gregorian, Julian, Hebrew, French Republican, Persian, Islamic and Swedish. It imports nothing. |

### Dependencies

| Package | Version (lockfile) | Used for |
| --- | --- | --- |
| `@io-kit/content` | 0.1.0 | Post types and visibilities, `can` and visibility policy, `ContentError`, audit entry shape, list limits |
| `@io-kit/comments` | 0.1.0 | Comment `can` policy, emoji check, `CommentError`, audit entry shape, list limits |
| `@io-kit/notify` (`/server`) | 0.4.0 | The five notification routes, subscription and preference stores, push payloads and sending |
| `@io-kit/auth` (`/server`) | 2.2.0 | `resolveAuth`: JWT verification and claim mapping for the session cookie |
| `@io-kit/mcp` (`/edge`, `/core`) | 0.1.0 | The MCP mount: bearer-token gate, protected-resource metadata and `401` challenges (`/edge`), and the JSON-RPC tools server evaluated against the policy table (`/core`) |
| `@io-kit/feed` | 1.1.1 | `createUlidFactory`: monotonic ULIDs for record ids and audit sort keys |
| `jose` | 6.2.12 | `createRemoteJWKSet` for the session keys |
| `web-push` | 3.6.7 | Push delivery. Imported only when the VAPID keys load. |
| `@aws-sdk/*` | 3.1000.0 | DynamoDB document client, S3 and the S3 request presigner, Secrets Manager |

[`api/package.json`](../../api/package.json) pins every runtime dependency to an exact version except `@io-kit/content` (`^0.1.0`) and `@io-kit/notify` (`^0.4.0`), which the lockfile holds at the versions above.

`@io-kit/auth` is pinned to the same version here and in [`auth/package.json`](../../auth/package.json). The moves from 2.1.1 to 2.1.2 and then 2.2.0 changed only the kit's edge code, which renders the auth edge's pages: the referrer policy, the theme's font origins and the page styling ([Identity services](identity-services.md)). The `/server` code that the API imports is unchanged, so [Session verification](#session-verification) behaves as it did under 2.1.1.

Development dependencies, which `package-api.sh` leaves out of the zip (`npm ci --omit=dev`):

| Package | Version | Used for |
| --- | --- | --- |
| `@io-kit/ci` | 0.1.3 | The `io-kit-ci render` command that renders the CI workflows and actions from `ci.manifest.yaml` ([Repository operations](repository-operations.md#kit-manifest-cimanifestyaml)) |
| `@io-kit/parity` | 0.3.0 | The `io-kit parity diff` check in [`scripts/ci/mcp-conformance.sh`](../../scripts/ci/mcp-conformance.sh), against [`api/parity/`](../../api/parity/) and the generated `dist/mcp/` files |
| `vitest` | 3.2.4 | The test suites |

The `@io-kit/*` packages are private. They come from the io CodeArtifact npm registry that [`api/.npmrc`](../../api/.npmrc) configures for the `@io-kit` scope. `npm ci` reads the registry token from `CODEARTIFACT_AUTH_TOKEN` (`aws codeartifact get-authorization-token --domain io`).

## Request pipeline

Every request goes through these steps in order. The first step that fails decides the response.

1. **Origin check** ([`origin.js`](../../api/src/origin.js), called from `index.js`). The `x-origin-verify` header, matched in any case, must equal `ORIGIN_VERIFY`. The two values are compared as SHA-256 digests with a constant-time comparison. If `ORIGIN_VERIFY` is unset or empty, every request fails. Failure: `403` with the body `{"error":"forbidden"}`. This step runs for every path, MCP paths included, before routing and before the handler is built.
2. **MCP paths** (`index.js`). When `isMcpPath` in [`mcp.js`](../../api/src/mcp.js) matches `rawPath` (`/mcp`, `/mcp/...`, `/.well-known/oauth-protected-resource` or `/.well-known/oauth-protected-resource/...`), the request goes to the MCP mount, which `createMcpMount` builds on the first such request in the container. The mount authenticates with a bearer access token and never reads the session cookie. These requests never reach the steps below. See [MCP server: Routing in `index.js`](mcp-server.md#routing-in-indexjs).
3. **Prefix check.** Trailing slashes are removed from `rawPath`. Any other path outside `/api/`, including `/api` itself, is `404 not_found`.
4. **Route match.** `/api` is removed and the rest is matched against `ROUTES`. Path parameters are URL-decoded with `decodeURIComponent`. A path parameter with malformed percent-encoding (for example `%E0%A4%A`) makes it throw, which is `500 internal`, before the session is checked. No path match is `404 not_found`. A path that matches with a different method is `405 method_not_allowed`. That includes `OPTIONS` and `HEAD`: the API does no CORS handling. The exception is a path whose every route is behind a [feature gate](#feature-gate) that is closed to the caller: the session is read, and the answer is `404 not_found`, so the wrong method does not reveal a dark route.
5. **Session.** The session cookie is verified (see [Session verification](#session-verification)). A missing or invalid cookie is not refused yet.
6. **Feature gate.** A route that declares a feature or a server switch is refused when it is closed to the caller ([Feature gate](#feature-gate)): `404 not_found`, the same response as a route that does not exist, or a switch's own error. This runs before the session is required, so a signed-out caller also gets `404` from a dark route.
7. **Session required.** Without a verified session: `401 unauthenticated`. Every route requires a session, reads included.
8. **Content type**, for `POST`, `PUT` and `PATCH` only. `content-type` must start with `application/json`, ignoring case. Otherwise `415 unsupported_media_type`.
9. **Body**, for `POST`, `PUT` and `PATCH` only. A base64-encoded body is decoded. An empty body counts as `{}`. A body that does not parse is `400 validation` ("invalid JSON body"). A body that parses to anything other than an object (an array, `null`, a string or a number) is `400 validation` ("body must be a JSON object"). `DELETE` bodies are not read here.
10. **Route handler.**

Because the session is required only at step 7, a request without a session to an unknown path gets `404`, and one with the wrong method on an ungated path gets `405`, not `401`.

On the first request in a container that passes step 1, whatever its path, `index.js` loads the VAPID keys (if configured) and builds the handler. Both are kept for the life of the container. The MCP mount reuses that handler's `invoke`, so a tool call runs the same route handler as the HTTP route and passes the same feature gate (step 6), but skips the other steps from 3 to 9.

The rest of this page describes the `/api/*` responses. The MCP mount's responses are in [MCP server: What the mount answers](mcp-server.md#what-the-mount-answers).

### Response headers

| Response | Headers |
| --- | --- |
| JSON responses from the API, including errors and `204` | `content-type: application/json; charset=utf-8`, `cache-control: no-store`, `vary: authorization, cookie` |
| Notification routes | The kit's `content-type: application/json`, plus `cache-control: no-store` added by the handler. No `vary`. |
| Origin-check `403` | `content-type: application/json`, `cache-control: no-store` |

A `204` response has an empty body.

### Error shape

```json
{ "error": "<code>", "message": "<text>", "details": { } }
```

`details` appears only on kit errors that carry it. Post errors may carry `{"field": ...}` or `{"id": ...}`. Comment validation errors carry `{"field": ...}`. Any error that is not one of the API's or the kits' typed errors becomes `500` with `{"error":"internal","message":"internal error"}`, and the log line holds only `{name, code, route, requestId}` (never the message or stack, which can quote stored text; HFY-TSK-235). The origin-check `403` and the notification routes use shorter bodies, described in their sections.

Two statuses exist for validation. Checks on the request itself (body parsing, a missing `subject` on a comment route, upload input) return `400 validation`. Checks on post and comment content return `422 validation`.

| Status | `error` | Raised by |
| --- | --- | --- |
| 400 | `validation` | Unparseable or non-object body; missing `subject` on a comment route; upload input |
| 400 | `cursor_invalid` | A posts or comments cursor that is malformed, or a posts cursor from another filter |
| 401 | `unauthenticated` | No session cookie, or a token that fails verification |
| 403 | `forbidden` | Failed origin check; caller lacks the permission for a post or comment action |
| 403 | `self_react` | Reacting to your own comment |
| 404 | `not_found` | Unknown route; a route behind a feature gate that is closed to the caller; post missing or not visible to the caller; comment missing; malformed subject or comment id |
| 405 | `method_not_allowed` | Known path, other method |
| 409 | `conflict` | A post or comment write's transaction was cancelled by a failed condition, usually because the record changed or was deleted after it was read (see [Concurrent writes](#concurrent-writes)) |
| 415 | `unsupported_media_type` | A write without a JSON content type |
| 422 | `validation` | Post body, type, visibility, title, subject or attachments, or a post over the size cap; comment body; malformed subject on comment create; emoji |
| 500 | `server` | A comment create, edit or delete failed for a reason other than a cancelled transaction |
| 500 | `internal` | Anything else |
| 503 | `busy` | A post or comment write's transaction was cancelled by `TransactionConflict` on every one of its 4 attempts (see [Concurrent writes](#concurrent-writes)); nothing was written, retry |
| 503 | `unavailable` | A post write failed for a reason other than a failed condition or a conflict; uploads with no presigner |

## Routes

All paths are under `/api`, and every route needs a session. Routes ignore body and query fields they do not name. The route names in the first column are the action names in [`caps.json`](#capsjson).

| Name | Method | Path | Input | Success | Notes |
| --- | --- | --- | --- | --- | --- |
| `me.get` | GET | `/me` | none | `200 {id, label, admin, can: {moderate, graduate, approve}}`, plus `badges: {accessRequests}` for admins only | Not an MCP tool. `admin` is `actor.admin` from `config/admins.json`, and `can.*` is computed on the server; clients never infer admin from `can.delete`. `badges.accessRequests` counts the GSI1 partition `ACCESSREQS#pending` (`0` when empty). If the badge count fails it is logged and `badges` is omitted (id, label, admin and `can.*` still return). Fields are additive only: later tasks add `ownRecord` and `editing`. Exempt from the [feature gate](#feature-gate) (`gateExempt`). `no-store`. |
| `comments.list` | GET | `/comments` | query `subject` (required), `cursor`, `limit` | `200` thread | Oldest first |
| `comments.create` | POST | `/comments` | body `subject`, `body`, optional `parentId` | `201` comment | Sends notifications |
| `comments.update` | PATCH | `/comments/:id` | body `body`; `subject` in the body or the query | `200` comment | Author only |
| `comments.delete` | DELETE | `/comments/:id` | query `subject` (required), optional `reason` | `204` | Author or admin. `subject` is read from the query only. |
| `comments.react` | POST | `/comments/:id/react` | body `emoji`; `subject` in the body or the query | `200` `{removed, reaction?}` | Set or toggle off |
| `posts.list` | GET | `/posts` | query `cursor`, `limit`, `subject`, `type`, `author`, `visibility` | `200` `{items, cursor}` | Newest first |
| `posts.get` | GET | `/posts/:id` | none | `200` post | |
| `posts.create` | POST | `/posts` | body `body`, optional `type`, `visibility`, `subject`, `title`, `attachments` | `201` post | Publishing sends notifications |
| `posts.update` | PATCH | `/posts/:id` | body, all optional: `title`, `subject`, `body`, `attachments` | `200` post | Author only. `null` clears `title` or `subject`. |
| `posts.visibility` | POST | `/posts/:id/visibility` | body `visibility` | `200` post | Author only |
| `posts.delete` | DELETE | `/posts/:id` | none | `204` | Author or admin. Also removes the post's comment thread. |
| `uploads.presign` | POST | `/uploads` | body `filename`, `contentType`, `size` | `201` | Presigned S3 PUT under `uploads/posts/` |
| `notifications.vapid-public-key` | GET | `/notifications/vapid-public-key` | none | `200` `{public_key}` | Kit route |
| `notifications.subscribe` | POST | `/notifications/subscribe` | body: a push subscription | `200` `{ok: true}` | Kit route |
| `notifications.unsubscribe` | DELETE | `/notifications/subscribe` | body `{endpoint}` | `200` `{ok: true}` | Kit route |
| `notifications.preferences.get` | GET | `/notifications/preferences` | none | `200` preferences | Kit route |
| `notifications.preferences.put` | PUT | `/notifications/preferences` | body: preferences | `200` preferences | Kit route |

The five notification routes are delegated to `createNotifyHandler` from `@io-kit/notify/server`, with the session's member id as the principal. See [Notifications](#notifications).

None of these routes is behind the [feature gate](#feature-gate). The comments, posts, uploads and notification routes predate it, and `me.get` is its declared exemption. Every route added from HFY-PLN-002 on declares a feature or a server switch.

Seven routes are also MCP tools, through the `mcp` member of their `ROUTES` entry: `comments.list`, `comments.create`, `comments.delete`, `posts.list`, `posts.get`, `posts.create` (drafts only) and `posts.delete`. See [MCP server: Tools](mcp-server.md#tools).

## Feature gate

[`features.js`](../../api/src/features.js) is the one server-side gate for the routes of HFY-PLN-002 (HFY-TSK-238; BRD2 D2-28). The flags in `flags.json` decide what the islands show. This gate decides what the API answers, so a dark route cannot be reached with `curl`, an MCP tool or a member's `?hfy_flags` before its flip.

### Declaring a gate

A `ROUTES` entry may carry `gate`:

| Declaration | Meaning |
| --- | --- |
| `requireFeature("<flag>")` | `404 not_found` unless `<flag>` is `true` in the deployed flags file or the caller is in the `uat` group. |
| `serverSwitch("<switch>", check)` | `<switch>` is one of `HFY_EDITING`, `ACCESS_REQUESTS`, `CHAT_SERVICE_AUTH` or `SYNC_API_ENABLED`. `check({actor})` runs before the handler: `true` continues, anything else is `404 not_found`, and it may throw the switch's own error instead. The declaring route supplies `check`, and `serverSwitch` refuses a declaration without one. Membership of `uat` does not open a switch. |
| `gateExempt("<reason>")` | Not gated. Only `me.get` carries it (BRD2 10.1). |
| none | The routes that predate the gate ([Routes](#routes)). |

[`features.test.js`](../../api/test/features.test.js) holds the rule: every `caps.json` action outside its list of pre-gate routes declares a feature or a switch, and only `GET /api/me` is exempt. A new route without a gate fails it.

### Who passes a feature

| Caller | Flag `true` | Flag not `true`, or the file unreadable for more than 10 minutes |
| --- | --- | --- |
| Signed out | `401` ([step 7](#request-pipeline)) | `404` |
| Member or admin | The route runs | `404` |
| `uat` member | The route runs, unless their `x-hfy-preview` names `-<flag>` (then `404`) | The same |

- **`uat` group.** The `subjects` (gramps ids) of the `uat` group in `config/groups.json`. An `emails` list under it is ignored, and being an admin does not make anyone `uat`. It is read through the same cached, fail-closed resolver as the MCP groups ([MCP server: Groups](mcp-server.md#groups)), so a failed read makes nobody `uat`. No MCP policy row names it.
- **`x-hfy-preview`.** A request header carrying the page's `?hfy_flags` value: comma-separated names, `-name` for off, at most 32 names. The API applies it only for a `uat` caller, for whom `-name` closes that feature for the request. Anyone else's header is ignored, so a member's preview neither opens a dark route nor closes a live one. No island sets the header at present, and a `uat` caller reaches dark routes without it.
- **MCP.** `handler.invoke` checks the same gate for the tool's actor, with no preview header.

### The flags file

- **Source.** `GET https://<site>/_data/flags.json`: the file the site itself serves, read over HTTPS through the CDN, so the role needs no S3 grant. `FLAGS_URL` overrides it ([Environment](#environment)). A URL that is not `https://` stops the function at start-up. Redirects are refused, and a read times out after 3 s.
- **Cache.** 60 s per container from the last successful read, and concurrent requests share one read. Only routes with a feature gate read the file.
- **Failures.** A non-2xx status, a body that is not a JSON object, a timeout or a network error keeps the last good copy for up to 10 minutes after the last successful read. After that every feature is off until a read succeeds. A failed read is retried after 5 s. The log line is `flags read failed (keeping the last good flags)` or `flags read failed (features off)`, with only the error's name and code.
- **Values.** Only boolean values are kept, and a feature is on only when its value is exactly `true`.
- **Flips.** A change to `flags.json` reaches the API within about 60 s of the site deploy, with no API deploy.

### `featureOn` for producers

`featureOn(name, principal)` applies the same rule outside a route. `principal` is a gramps id or an actor: a `uat` principal gets `true`, anyone else the deployed value. `index.js` configures it with the deployed gate; until then it returns `false`. A route handler gets `c.featureOn(name)` for its caller, which counts the caller's preview header when they are `uat`.

**Persist-first inbox writes** ([`notify.js`](../../api/src/notify.js)). The notifier stores an inbox item for a recipient, and puts the recipient's unread count in the push as `app_badge`, only while `featureOn("inboxV1", recipient)`. While `inboxV1` is off, no inbox item is stored for anyone outside `uat`, and pushes carry no badge. `new_family_post` is push-only and never stored. `index.js` wires no inbox store yet (`hfy-inbox-delivery-api` adds it), so today the notifier behaves as described in [Notifications](#notifications).

## Subjects

A subject names a comment thread ([`comments.js`](../../api/src/comments.js), `SUBJECT_RE`).

| Form | Pattern | Names |
| --- | --- | --- |
| `person:<gramps-id>` | `person:` followed by 1 to 64 characters from `A-Z a-z 0-9 _ . -` | A person record in the family tree |
| `post:<ulid>` | `post:` followed by a 26-character Crockford base32 ULID | A post |

- There is no list of threads. A well-formed subject with no comments lists as an empty thread (`200`), and the first comment starts it. The API does not check that a `person:` id exists in the tree.
- Only create may name a new thread. On create, a malformed subject is `422 validation` with `details.field` set to `threadId`. On list, edit, delete and react, a malformed subject is `404 not_found`, and so is a comment id that does not exist in that thread.
- A missing subject is `400 validation` ("subject is required") on every comment route.
- A `post:<ulid>` thread is exactly as visible as its post (HFY-R58). List, create, edit and react return `404 not_found` when the post does not exist or the caller cannot see it, for example a draft or withdrawn post of another member. Delete is the exception: an author or admin can always remove a comment, even under a withdrawn post. `person:` threads have no such check.

A post's comment thread is always `post:<post id>`. The post's own `subject` field is a separate value, described under [Posts](#posts).

## Posts

Posts are implemented in [`content.js`](../../api/src/content.js) against the `@io-kit/content` contract.

### Post object

| Field | Type | Rules |
| --- | --- | --- |
| `id` | ULID | Assigned at create |
| `type` | `post`, `article` or `document` | Default `post`. Any other value is `422`. |
| `author` | `{id, label}` | The caller's member id (gramps id) and display label. The label is never an email address ([Session verification](#session-verification)). |
| `subject` | string, optional | A record id the post is about: a bare Gramps ID, `person:<gramps-id>`, `post:<ulid>` or another plain identifier. It must match `^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$`, otherwise `422` with `details.field` `subject`. Indexes the post under `SUBJECT#<subject>`. |
| `title` | string, optional | At most 200 characters, otherwise `422` with `details.field` `title`. |
| `body` | string | Required and not blank. At most 20,000 characters (JavaScript string length). Stored as sent, not trimmed. Otherwise `422`. |
| `attachments` | array | At most 10, each a member upload. See [Attachments](#attachments). Otherwise `422` with `details.field` `attachments`. |
| `visibility` | `draft`, `published` or `withdrawn` | See below |
| `created_at`, `updated_at` | ISO 8601 | |
| `can` | `{edit, publish, delete}` | Computed for the caller on every response |

On create, a `title` or `subject` of `null` means "not set". On `PATCH`, `null` removes it. The serialized post, after these checks, may be at most 100 KB (UTF-8 bytes of its JSON); a larger post is `422` with `details.field` `body` ("post is too large"). The cap keeps every post item, and the audit item that holds both `before` and `after`, well inside DynamoDB's 400 KB item limit.

### Attachments

[`normalizeAttachments`](../../api/src/content.js) checks `attachments` on create and on `PATCH`, and stores a normalized copy:

| Rule | Value |
| --- | --- |
| Shape | An array of at most 10 objects |
| `kind` | `image` or `file` |
| `url` | A member upload: `<MEDIA_PUBLIC_BASE>/uploads/posts/<ulid>/<name>`, or the same path relative (`/uploads/posts/<ulid>/<name>`). `<name>` is 1 to 81 characters from `a-z 0-9 . _ -`, starting with a letter or digit. At most 2048 characters. A URL on any other host or path is refused. |
| `mime` | A media type such as `image/jpeg`. For `kind: image` it must be `image/jpeg`, `image/png`, `image/webp` or `image/heic`. |
| `alt` | Optional string, at most 500 characters |
| `width`, `height` | Optional positive integers up to 100,000 |
| Other keys | Dropped |

`caps.json` still declares attachments "metadata-only": the API checks the URL's shape, not that the object exists.

### Visibility

- Create accepts only `draft` or `published`. Any other value is `422`. An omitted visibility means `draft`. A post created as `published` is one write with one audit item, so `created_at` equals `updated_at`.
- `POST /posts/:id/visibility` accepts `draft`, `published` or `withdrawn`. Any other value is `422`. Setting the current value returns the post unchanged, with no write and no audit item.
- A `new_family_post` notification goes out when a post is created as `published`, and when its visibility changes from any other value to `published`.

### Listing

- `GET /posts` returns `{items, cursor}`, newest first, from a descending query on `GSI1`. The partition is `SUBJECT#<subject>` when `subject` is given, otherwise `AUTHOR#<author>` when `author` is given, otherwise `POSTS`. The remaining filters, and whether the caller may see the post, are checked on each item. Posts the caller may not see are skipped.
- The query reads 100 index items per page and up to 50 pages per request, stopping when it has one more matching post than the limit.
- `limit` defaults to 50 and is clamped to 1 through 200. A `limit` that is not a number is not clamped: it becomes `NaN`, the query reads until its 50-page cap or the end of the partition, and the response is `{"items": [], "cursor": null}`.
- `cursor` has the form `c1.<ulid>.<filterhash>`. `<ulid>` is the last post on the page, and `<filterhash>` is a hash of the four filter values. A malformed cursor, or a cursor from a listing with different filters, is `400 cursor_invalid`. `cursor` is `null` on the last page.

### Writes

- Every single-post read and write first loads the post and checks that the caller may see it. A post the caller may not see is `404 not_found`, for writes too.
- `PATCH` replaces `body` and `attachments` when given, sets `title` and `subject` when given, and removes them when they are `null`. It always refreshes `updated_at` and writes an audit item, even when nothing else changed. Removing `subject` also deletes the post's `IDX#SUBJECT` item.
- A transaction cancelled by a failed condition is `409 conflict` ("record changed concurrently"); one that stays cancelled by `TransactionConflict` after its retries is `503 busy`. See [Concurrent writes](#concurrent-writes). Any other store failure is `503 unavailable`.
- **Delete takes the thread with it.** After the post's items and audit item are committed, the handler removes the `post:<ulid>` thread: every comment and reaction in it, with one `delete` audit item per comment (`reason` `post deleted`, `principal` the member who deleted the post), at most 100 items per transaction. This runs after the response's write has committed and never fails the request. A failure is logged as `post thread purge failed (write already committed)` and leaves the remaining thread items in place.

### Concurrent writes

Every write that changes an existing record is conditioned on the version that was read (HFY-R58), so a concurrent change cancels the write instead of being silently overwritten, and every audit `before` is exactly the version replaced ([`txn.js`](../../api/src/txn.js), `versionGuard`):

| Write | Condition on the main item |
| --- | --- |
| Post create | The id does not exist yet |
| Post update, visibility change, delete | The item exists and its stored `post.updated_at` equals the value read |
| Comment create | The id does not exist yet |
| Comment edit, delete | The item exists and its stored `comment.edited_at` equals the value read, or is still absent for a never-edited comment |

A failed condition cancels the whole transaction, audit item included, and the API returns `409 conflict`. A client recovers by reading the record again before it retries.

#### `transact()` v2

`transact(ddb, cmds, table, spec, opts)` in [`txn.js`](../../api/src/txn.js) is the one writer every later feature builds on (HFY-TSK-235). `spec` holds `puts`, `deletes`, `updates` (`{key, update, condition?, names?, values?}`), `checks` (`{key, condition, ...}`, a `ConditionCheck` on an item the call does not write) and `clientRequestToken`. They go out as one `TransactWriteItems` call in that order, at most 100 items (`assertTxnSize`), and each item may carry a `tag` that comes back in a failure. The Lambda's command bag includes `UpdateCommand`.

- **Token.** `clientRequestToken` is 1 to 36 characters, or a fresh UUID. It is set once and reused on every retry, so a retry after a lost response is applied once.
- **Conflict retry.** A cancellation whose reasons are only `TransactionConflict` is retried up to 3 times (waits of about 20, 60 and 150 ms, each jittered) with the same token. `ConditionalCheckFailed` is never retried, nor is a mix of the two.
- **Failure.** A cancellation that ends the call throws `TxnCancelled`, whose `reasons` are DynamoDB codes by item index, `failures` are `{index, code, tag?}`, and `kind` is `condition` (409), `conflict` (retries exhausted, `busy`, 503) or `other` (throttling and the like, and a cancellation that carries no reasons list at all: 503 `unavailable`, never 409). `mapCancellationReasons` copies codes only: a reason's `Message` and `Item` never leave the DynamoDB error. A `TransactionInProgressException` (another request holds the same token) is retried like a conflict and ends as `busy`; an `IdempotentParameterMismatchException` (a token reused for a different payload) throws `TxnTokenMismatch`, a caller bug with fixed text.
- **Hooks.** `opts.onRetry({attempt, delayMs, codes})` and `opts.onBusy({attempts, codes})` are the places to emit the `txn_conflict_retry` and `txn_busy` telemetry events. They carry counts and DynamoDB codes only, and a throwing hook never fails the write. Nothing is wired to them yet; a later observability task owns that.
- **Counters.** `counterUpdate(key, {n: 1, unread: -1}, {ttl, ifNotExists, condition})` builds `ADD` deltas plus `SET ttl = if_not_exists(...)`. One transaction may not touch an item twice, so `mergeUpdates` folds counter updates on the same key into one and sums their deltas. The placeholders `#cnt*`, `#cs*` and `#ttl` belong to `counterUpdate`. An attribute named by more than one of the deltas, `ifNotExists` and `ttl` throws (DynamoDB rejects two actions on one path). `mergeUpdates` compares conditions, names, values and tags regardless of key order, and refuses updates that differ.

## Comments and reactions

Comments and reactions are implemented in [`comments.js`](../../api/src/comments.js) against the `@io-kit/comments` contract.

### Comment object

`{id, threadId, parentId?, author: {id, label}, body, created_at, edited_at?, can: {edit, delete, react}}`

- `body` is trimmed, must not be empty, and may be at most 1000 characters after trimming. Otherwise `422`. The trimmed text is stored.
- `threadId` is the subject.
- `author.label` is the caller's display label, never an email address ([Session verification](#session-verification)).

### Listing

`GET /comments?subject=...` returns:

```json
{ "thread": { "id": "<subject>", "topic": "default", "comments": [], "reactions": {}, "cursor": "<next>" }, "cursor": "<next>" }
```

- Comments are oldest first, by id. `limit` defaults to 50 and is clamped to 1 through 200. A `limit` that is not a number is not clamped: it becomes `NaN` and is sent as the DynamoDB query's `Limit`. If the query succeeds, `comments` is empty and there is no cursor. If DynamoDB rejects the value, the response is `500 internal`.
- `cursor` is the base64url encoding of the last comment id on the page. It appears, both inside `thread` and at the top level, only when more comments remain. A value that does not decode to a ULID is `400 cursor_invalid`.
- `reactions` maps a target to its reactions, oldest first. Targets are `comment:<id>` for the comments on the page, plus `root`. No route creates `root` reactions. A reaction is `{emoji, by, created_at}`.

### Create, edit, delete

- **Create.** A `parentId`, if given, must name a comment in the same thread, otherwise `404`. Any comment can be a parent, so replies can nest. Returns `201`.
- **Edit.** Author only. If the trimmed text equals the stored body, the comment is returned unchanged with no write. Otherwise the body is replaced and `edited_at` is set.
- **Delete.** Author or admin. Returns `204`. The comment and every reaction on it are deleted in one transaction with the audit item. Replies are not deleted and keep their `parentId`. A DynamoDB transaction holds at most 100 actions, so a comment with more than 98 reactions cannot be deleted. See [Permissions](#permissions) for `reason`.
- A create, edit or delete transaction cancelled by a failed condition, such as an edit that races another edit or a delete, is `409 conflict` ("comment changed concurrently"). One that stays cancelled by `TransactionConflict` after its retries is `503 busy`. Any other store failure is `500 server`.
- On a `post:<ulid>` thread, list, create, edit and react first check that the caller can see the post ([Subjects](#subjects)).

### Reactions

- `emoji` must be 1 to 32 UTF-16 code units made only of emoji code points (pictographs, regional indicators, keycaps, zero-width joiners, variation selectors, skin-tone modifiers, tag characters). Otherwise `422`.
- The comment must exist, otherwise `404`. Reacting to your own comment is `403 self_react`.
- Each member has at most one reaction per comment, stored at `R#comment:<id>#<member id>`. Sending the emoji you already have removes it and returns `{removed: true}`. Sending a different emoji, or the first one, stores it, replacing any earlier one, and returns `{removed: false, reaction}`. Both return `200`.
- The route always targets `comment:<id>`. `react` in `comments.js` also accepts the target `root`, returns `404 not_found` for an `attachment:` target and `422 validation` for any other target, but no route reaches any of these.
- Reactions are single `PutItem` and `DeleteItem` calls, not transactions, and are not audited.

## Permissions

The kits compute `can` on every post and comment the API returns. Clients render from `can` and never work it out themselves. A denied action is `403 forbidden`, except that a post the caller may not see is `404`.

### Posts

From `computeCan` and `canView` in `@io-kit/content`:

| Action | Author | Admin (not the author) | Other member |
| --- | --- | --- | --- |
| See a published post | yes | yes | yes |
| See a draft or withdrawn post | yes | yes | no (`404`) |
| Edit (`can.edit`) | yes | no | no |
| Change visibility (`can.publish`) | yes | no | no |
| Delete (`can.delete`) | yes | yes | no |

Drafts and withdrawn posts are visible only to their author and to admins. For anyone else they do not exist: `get` and every write return `404`, and lists skip them.

### Comments

From `computeCan` in `@io-kit/comments`. An admin is passed to the kit as a principal with the `admin` role.

| Action | Author | Admin (not the author) | Other member |
| --- | --- | --- | --- |
| List, create | yes | yes | yes |
| Edit (`can.edit`) | yes | no | no |
| Delete (`can.delete`) | yes | yes | no |
| React (`can.react`) | no (`self_react`) | yes | yes |

On a `post:<ulid>` thread, every comment action except delete also requires that the post is visible to the caller. Otherwise it is `404 not_found`.

### Admins

- The admin list is a JSON object in S3 at `ADMIN_LIST_BUCKET` / `ADMIN_LIST_KEY` (defaults `<config-bucket>` and `config/admins.json`). It holds member ids (gramps ids), either as an array or as `{"admins": [...]}`. Entries that are not strings are ignored. Any other shape means nobody is an admin.
- It is read after the session verifies and cached in the container for 60 s.
- If it cannot be read or parsed, the API logs "admin list unavailable (failing closed)" with the error message, treats nobody as an admin, and tries again after 5 s.
- The file may be absent. An absent `config/admins.json` means there are no admins. The read then fails every time, so each container logs "admin list unavailable (failing closed)" and retries at most once every 5 s, whenever a request with a valid session arrives.
- The Lambda role may read only `config/*` in the config bucket, so `ADMIN_LIST_KEY` must stay under `config/`.
- The admin list applies to the cookie path only. On the MCP path, admin comes from the `hfy-admin` group in `config/groups.json`, and `config/admins.json` plays no part ([MCP server: Groups](mcp-server.md#groups)).

### Recording a reason

- `DELETE /comments/:id?subject=...&reason=<text>` records `reason` on the audit item only when the caller is an admin and is not the comment's author. In every other case the parameter is ignored.
- Post deletes take no reason.

## Table layout

The API's items in the `hfy-app` table. The table definition and the auth edge's items are in [System architecture](architecture.md#dynamodb-table-hfy-app).

The keys of every item (`PK`, `SK`, the `GSI1` keys and `ttl`) are listed once, in [System architecture: Item layout](architecture.md#item-layout). The API writes post items, with their author and subject index items ([`content.js`](../../api/src/content.js)), comment and reaction items ([`comments.js`](../../api/src/comments.js)), audit items ([`txn.js`](../../api/src/txn.js)), contribution events and counters ([`contrib.js`](../../api/src/contrib.js)), and, through `@io-kit/notify`, push subscription and notification preference items.

What the items hold:

- All three post items carry `entity: "post"` and the full post under `post`, so a listing needs no second read.
- Comment items carry `entity: "comment"` and `comment`.
- Reaction items carry `entity: "reaction"`, `target` and `reaction`. There is one per member per target, and `target` is `root` or `comment:<id>`.
- Audit items are listed under [Audit records](#audit-records).
- Contribution events and counters are listed under [Contributions ledger](#contributions-ledger). A credited post or comment carries `contrib: { id }`, the id of its event, on every stored copy.

Code note: [`keys.js`](../../api/src/keys.js) exports `commentKeys` (`COMMENT#<id>` / `META`) and `gsiThread`. Neither is used, because comments live under `THREAD#<subject>` ([item layout](architecture.md#item-layout)).

## Contributions ledger

[`contrib.js`](../../api/src/contrib.js) credits members for what they add, and takes the credit back when it is deleted. Each credit is an event under `CONTRIB#<principal>` plus five counter updates, and they commit in the same `TransactWriteItems` call as the write that earned them ([item layout](architecture.md#item-layout)). The ledger is written whatever the `contribV1` flag says; the flag only gates the routes that read it.

| Write | Ledger change |
| --- | --- |
| Comment create | Credit 1 (`kind: comment`). The stored comment gets `contrib: { id }`. |
| Comment delete, by its author or an admin | Revoke the event of the comment's author. |
| Post created published, or a draft's first publish | Credit 1 plus 1 per image attachment (`kind: post`), once per post. All three post items get `contrib: { id }`. A post with 3 photos adds 4. |
| Withdraw, or return to draft | The event is hidden. No count changes. |
| Republish | The event is shown again. No count changes. |
| Post delete, by its author or an admin | Revoke the event of the post's author. |
| Post delete, for each comment removed with the post | Revoke each comment's event. The revokes of one transaction are merged, so 30 comments by one author in one month are one decrement per counter key. |

Not counted: edits of posts and comments, reactions, drafts, and desktop pushes. A comment made through an MCP tool is credited like any other and its event carries `via: "mcp"`; HTTP calls carry `via: "ui"`. An MCP post is always a draft, so it earns nothing until a person publishes it.

An event is `{ entity: "contrib", id, kind, actor: { id, label }, at, weight, photos, via, ref: { type, id, thread? }, subject?, hidden? }`. It copies no body text. `weight` is what the event adds to `n`: 1 for the kind plus `photos`. The counter rows hold `n`, `n_<kind>` for `post`, `comment`, `proposal_accepted`, `self_edit`, `tag` and `photo_to_record`, `n_photo`, and on `TOTAL` rows `first_at`. Readers clamp a negative value to 0, because revoking a credit whose `D#` row has already expired leaves a negative row that expires within days.

The builders are `contribOps`, `revokeOps`, `hideOps` and `mergeOps`. They return `{ puts, deletes, updates, checks }` fragments that a caller merges into its own `transact()` call. Credits for proposals, self-edits, tags and photo graduation are added by the code that owns those writes, through the same builders.

Content written before the ledger has no events. [Backfill the contributions ledger](../how-to/backfill-the-contributions-ledger.md) credits it and rebuilds the counters.

## Audit records

Every post create, update, visibility change and delete, and every comment create, edit and delete, writes one audit item ([`txn.js`](../../api/src/txn.js), `auditItem`).

| Attribute | Value |
| --- | --- |
| `PK` | `AUDIT#<record id>`, the post id or comment id |
| `SK` | `<at>#<ulid>` |
| `GSI1PK`, `GSI1SK` | `AUDIT`, and the same value as `SK` |
| `entity` | `audit` |
| `op` | The operation (below) |
| `id` | The record id |
| `principal` | The caller's member id |
| `at` | ISO 8601 time of the change |
| `before` | The full record before the change, or `null` on create |
| `after` | The full record after the change, or `null` on delete |
| `reason` | On an admin's delete of another member's comment, when given; `post deleted` on each comment removed with its post |

| Record | `op` values |
| --- | --- |
| Post | `create`, `update`, `visibility`, `delete` |
| Comment | `create`, `edit`, `delete` |

The data change and its audit item are written in a single `TransactWriteItems` call (`transact` in `txn.js`). Both land or neither does, so a failed write leaves no audit item.

Comments removed with their post are audited too, each in the same transaction as its delete ([Writes](#writes)). Not audited: reactions, notification subscriptions and preferences, uploads, and writes that change nothing (a visibility set to its current value, a comment edit with identical text). No route reads audit items. The `GSI1` partition `AUDIT` lists them all in time order.

## Notifications

[`notify.js`](../../api/src/notify.js) defines the types and the fan-out. `@io-kit/notify/server` stores subscriptions and preferences and sends the pushes.

### Types and levels

| Type | Title | Level 0 body | Level 1 body |
| --- | --- | --- | --- |
| `comment_on_my_record` | Harrison Family | someone commented on your page. | {actor} commented on your page. |
| `reply_to_me` | Harrison Family | someone replied to you. | {actor} replied to you. |
| `new_family_post` | Harrison Family | there's a new family post. | {actor} shared a new family post. |
| `mention` | Harrison Family | you were mentioned. | {actor} mentioned you. |

The text is `TEMPLATE_REGISTRY` in [`notify.js`](../../api/src/notify.js), written in the design system's family voice: every title is the site name, and the bodies are lowercase and say "page", never "record". The lock-screen preview on `/me/notifications/` (the `CATALOG` in [`islands/src/islands/notifications.jsx`](../../islands/src/islands/notifications.jsx)) repeats the same strings word for word. No code or test ties the two together; they are kept equal by hand. [`api.test.js`](../../api/test/api.test.js) and [`producers.test.js`](../../api/test/producers.test.js) check the API's bodies. Pushes carry the text that the deployed `hfy-api` holds, so a change to it reaches members only after an `hfy-api` redeploy ([Packaging and deploy](#packaging-and-deploy)).

Level 0 carries no content. Level 1 adds the actor's display label, the `author.label` of the comment or post, which is never an email address ([Session verification](#session-verification)). The kit cleans it and cuts it to 80 characters. Each recipient chooses per type in their preferences. A type with no stored preference is enabled at level 0. If a level-1 message cannot be rendered, level 0 is sent.

### Recipients of a new comment

The commenter never gets a notification, and each recipient gets at most one per comment. Types are assigned in this order, so the priority is `reply_to_me` > `mention` > `comment_on_my_record`:

1. `reply_to_me`: the parent comment's author, if the comment is a reply, and everyone who has commented on the same subject before. Earlier commenters get it even when the new comment is not a reply.
2. `mention`: members mentioned in the body.
3. `comment_on_my_record`: the record's owner. For `person:<gramps-id>`, that is the member whose id is that gramps id. For `post:<ulid>`, it is the post's author.

A mention is `@` followed by a member id of the form `I` plus 4 to 8 digits ([`notify.js`](../../api/src/notify.js), `mentionsOf`). It must come at the start of the body or after a character that is not an ASCII letter, digit, underscore or `@`, and the digits must be followed by the end of the body or a character that is not an ASCII letter, digit or underscore. So `@I123456789` and `@I1234_` are not mentions. Duplicates count once, and only the first 10 distinct ids are used.

### Recipients of a published post

`new_family_post` goes to every member who holds at least one push subscription, except the author. The list comes from a `Scan` of the table filtered on the `PK` prefix `SUB#`, up to 20 pages.

### Deep links and payload

| Event | `navigate` |
| --- | --- |
| Comment on `post:<ulid>`, new post | `/posts/?id=<ulid>` |
| Comment on `person:<gramps-id>` | `/person/?id=<gramps-id>` |

The payload is a Declarative Web Push message, `{"web_push": 8030, "notification": {"title", "body", "navigate"}}`. It is sent to each of the recipient's subscriptions with a push TTL of 86,400 s. A `404` or `410` from the push service deletes that subscription.

### VAPID keys

`VAPID_SECRET` names a Secrets Manager secret whose value is JSON:

```json
{ "subject": "<https-url>", "publicKey": "<vapid-public-key>", "privateKey": "<vapid-private-key>" }
```

- The deployed secret is `harrisonfamily/api/vapid`. The stack's `VapidSecretName` parameter carries that name into `VAPID_SECRET`.
- `subject` must be an `https://` URL, so no email address is sent to the push services. `index.js` passes `subject` to `web-push` as given and does not check it.

It is read once per container. If `VAPID_SECRET` is unset, or the secret cannot be read or parsed (logged as "push disabled"), nothing is sent. The routes still store subscriptions and preferences, and `GET /notifications/vapid-public-key` returns `{"public_key": ""}`. The Lambda role may read the secret only when the stack's `VapidSecretName` parameter is set.

### Failure isolation

Notification fan-out runs after the write has committed and never fails the request ([`handler.js`](../../api/src/handler.js), `afterCommit`; [`notify.js`](../../api/src/notify.js)):

- **Push off.** With no VAPID keys loaded and no inbox store wired, the producers return at once and do no reads at all: no post lookup, no thread query for earlier commenters and no `SUB#` scan. With an inbox store, comment notifications still run so that items are stored first ([`featureOn` for producers](#featureon-for-producers)).
- **Push on.** Finding the recipients and sending to them are both guarded. A failure is logged (for example `comment notification failed (write already committed)`, `publish notification failed` or `notify failed`) and the response is the write's normal success.
- A failed send to one recipient does not stop the others.

### Notification routes

These responses come from the kit. Kit errors have the shape `{"error": "<text>"}`, with no `message`.

| Route | Request body | Response | Errors |
| --- | --- | --- | --- |
| `GET /notifications/vapid-public-key` | none | `{public_key}` | |
| `POST /notifications/subscribe` | `{endpoint, keys: {p256dh, auth}, expirationTime?}` | `{ok: true}` | `400 {"error":"invalid subscription"}` |
| `DELETE /notifications/subscribe` | `{endpoint}` | `{ok: true}` | `400 {"error":"endpoint required"}` |
| `GET /notifications/preferences` | none | `{enabled: true, types: {<type>: {enabled, level}}, extra: {}}` | |
| `PUT /notifications/preferences` | `{types: {<type>: {enabled, level}}}`, `enabled` a boolean and `level` 0 or 1 | Same shape as `GET` | `400 {"error":"invalid preferences"}` |

- A subscription is stored with a 90-day `ttl`. Subscribing again refreshes it.
- `PUT` replaces the whole preference record. Type names are not checked against the four types. `GET` lists only the types that are stored.
- The `DELETE` body is read by the kit itself, so it needs no JSON content type.

## Uploads

`POST /uploads` returns a presigned S3 PUT for one post photo ([`uploads.js`](../../api/src/uploads.js), [`presign.js`](../../api/src/presign.js)). The Lambda never handles the image bytes.

### Request

`{filename, contentType, size}`. Each failure is `400 validation`.

| Field | Rule |
| --- | --- |
| `filename` | Non-empty string |
| `contentType` | `image/jpeg`, `image/png`, `image/webp` or `image/heic` |
| `size` | Positive integer, in bytes, at most 10 MB (10,485,760) |

### Object key

The key is `uploads/posts/<ulid>/<safe-name>` in `MEDIA_BUCKET` (`UPLOAD_PREFIX`, HFY-R58). It is never under `media/`, which the Gramps data sync mirrors with `--delete`. The safe name is built like this:

1. Keep the part after the last `/` or `\`.
2. Drop the final extension.
3. Apply Unicode NFKD normalization and lowercase.
4. Replace each run of characters outside `a-z 0-9 . _ -` with `-`.
5. Trim leading and trailing `.`, `_` and `-`.
6. Keep the first 60 characters. If nothing is left, use `photo`.
7. Append the extension for the content type: `jpg`, `png`, `webp` or `heic`.

For example, `../Beach Day.JPEG` sent as `image/jpeg` becomes `beach-day.jpg`.

### Response

`201` with:

| Field | Value |
| --- | --- |
| `uploadUrl` | The presigned PUT URL, valid for 300 s |
| `publicUrl` | `MEDIA_PUBLIC_BASE` + `/` + `key` |
| `key` | The object key |
| `headers` | `{"Content-Type": <contentType>}` |
| `expiresIn` | `300` |

The presigner signs `content-type` and `content-length` into the URL (`signableHeaders`), so S3 rejects a PUT whose `Content-Type` differs from the validated image type or whose body is not exactly `size` bytes. Send the returned `headers` exactly. The URL carries no checksum parameters: the S3 client is built with `requestChecksumCalculation: "WHEN_REQUIRED"`, because the SDK default would sign a checksum of an empty body and every real upload would fail with `400 BadDigest`. The API records nothing about the upload. The client puts `publicUrl` into the post's `attachments`. Nothing removes objects that no post references.

`uploadUrl` points at the bucket's own S3 endpoint (`https://<site-bucket>.s3.<region>.amazonaws.com/...`, in the function's region), never at `<site>`, so the PUT goes straight to S3 and never passes through CloudFront or the private data gate. [`presign.test.js`](../../api/test/presign.test.js) checks the host. `publicUrl` is on `<site>`, and reading it back goes through CloudFront ([Reading photos back](#reading-photos-back)).

### When uploads fail

- The handler returns `503 unavailable` ("uploads are not configured") only when it was built without a presigner. `index.js` always supplies one, and `MEDIA_BUCKET` and `MEDIA_PUBLIC_BASE` have defaults, so the deployed function never returns `503` for missing `MEDIA_*` settings. A wrong bucket shows up later, as a failed PUT.
- The browser's PUT goes straight to S3 on another origin, so it needs the bucket CORS rule in [`site-bucket-cors.json`](../../infrastructure/cloudformation/site-bucket-cors.json): `PUT` from `https://<site>` or `https://www.<site>`, with the `Content-Type` header. The browser sets `Content-Length` itself, outside the preflight, so the rule does not list it, though the URL signs it. The site bucket is not managed by `app-stack.yaml`, so that rule is applied by hand. Without it the browser blocks the PUT. `scripts/infra/check-site-bucket-cors.sh` checks the live rule ([Architecture](architecture.md#site-bucket)).
- The Lambda role may put objects only under `uploads/posts/*` in the media bucket (`PostPhotoUploads` in [`app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml)).
- The site deploy's sync excludes `uploads/*` (the `exclude` list in [`ci.manifest.yaml`](../../ci.manifest.yaml)), and the deploy role is denied `s3:PutObject` and `s3:DeleteObject` under `uploads/*` ([Repository operations](repository-operations.md#deploy-role-github-rolesyaml)), so uploaded photos survive site deploys.
- The private data gate does not affect uploading, because the PUT goes to S3 directly. A failed upload is never a `401` from the gate.

### Reading photos back

Photos are read back at `publicUrl`, through the CloudFront `/uploads/*` behavior. The API takes no part. That behavior is one behavior in two states ([System architecture: Request routing](architecture.md#request-routing)):

| | Public state | Members-only state |
| --- | --- | --- |
| Set by | [`add-uploads-behavior.sh`](../../scripts/infra/add-uploads-behavior.sh); also what `add-data-gate-behaviors.sh --remove` restores | [`add-data-gate-behaviors.sh`](../../scripts/infra/add-data-gate-behaviors.sh), which updates the existing behavior in place, keeping its position and origin |
| Who can read a photo | Anyone who holds the URL | A signed-in member. The `hfy-edge-gate` viewer-request function checks the `io_id` session cookie. |
| Signed-out request | `200` with the photo | `401` from the gate, or a `302` to `/auth/login?returnTo=<path>` for a top-level navigation, both with `Cache-Control: private, no-store` |
| Cache policy | CachingOptimized | CachingDisabled |
| Response headers policy | The app stack's `UploadsResponseHeadersPolicy` (stack output `UploadsResponseHeadersPolicyId`) | `hfy-uploads-private`, which the gate script finds, creates or repairs by name |
| Headers on every photo | `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox; default-src 'none'; img-src 'self'` | The same two, plus `Cache-Control: private, no-store`, all with override |
| Kept by caches | Cloudflare, which proxies `<site>` in front of CloudFront, caches the image responses | Neither Cloudflare nor browsers keep them |

- **Both policies carry the same CSP.** `UPLOADS_CSP` in [`scripts/infra/lib/cf-common.sh`](../../scripts/infra/lib/cf-common.sh) holds the string for `hfy-uploads-private`. [`test_app_stack.py`](../../scripts/infra/test/test_app_stack.py) checks that the stack's policy uses the same string. `rhp_uploads_private` in [`cf.jq`](../../scripts/infra/lib/cf.jq) checks that a found `hfy-uploads-private` still sets all three headers.
- **The headers make an upload inert.** A photo is served from the site's own origin, so a file that claims to be an image but holds HTML or script can never run there: the browser may not sniff another type, and the sandbox CSP allows nothing but same-origin images.
- **How members' browsers load photos.** The posts islands render each image attachment as a plain same-origin `<img src>`, so the browser sends the `io_id` cookie and the gate lets it through ([`islands/tests/uploads-gate.test.mjs`](../../islands/tests/uploads-gate.test.mjs)). A script that fetches a photo must send the cookie too: `credentials: "same-origin"`, the `fetch` default, or `"include"`. With `credentials: "omit"`, the members-only state answers `401`.
- **Which state is live.** The repository does not record it. [System architecture: Request routing](architecture.md#request-routing) gives the checks, and [How to cut over to authV2 and the private data gate](../how-to/cut-over-to-the-private-data-gate.md) gives the steps that gate `/uploads/*` along with the family data.
- **Without the behavior.** A request that no `/uploads/*` behavior matches, such as `/Uploads/...`, falls to the default behavior. Under the default-deny code of `HFYAppendIndex`, the default behavior's CloudFront Function, it answers `404` with `Cache-Control: private, no-store` and never reaches S3 ([System architecture: HFYAppendIndex](architecture.md#hfyappendindex)).
- **Rolling the gate back.** `add-data-gate-behaviors.sh --remove` puts `/uploads/*` back in the public state, with the policy ID that it reads from the stack named by `--app-stack` (default `hfy-app`) or takes from `--restore-uploads-policy-id`. The live app stack is `<app-stack>`, so a production `--remove` passes `--app-stack <app-stack>` or `--restore-uploads-policy-id` (the **Gate rollback** notes in [System architecture: Request routing](architecture.md#request-routing)). Afterwards anyone who holds a photo URL can read the photo again.

For why member photos sit behind the gate, see [The privacy model for family data](../explanation/family-data-privacy.md).

## The EditOp engine

[`api/src/records/ops.js`](../../api/src/records/ops.js) turns a list of EditOps into changed Gramps objects, the ops that undo them, and a three-way verdict for a stale proposal. It is a library: no route, tool or Lambda path calls it yet (HFY-TSK-234), and it ships in the `hfy-api` zip unreachable. It is pure: it imports nothing (no AWS SDK, no `node:` module), reads no environment and makes no network call. Its canonical JSON and SHA-256 are its own, so the editor and the API compute the same key hashes. The op format is the one in the editing design, section 5.3.

Objects travel as a map `{ "Person:<handle>": <Gramps JSON> }`. An op is `{ id, op, obj, path, base, value, before }` with `op` one of `set`, `add`, `remove`, `move`, `create` and `delete`.

| Call | Result |
| --- | --- |
| `applyOps(objects, ops, ctx?)` | `{ ok, objects, minted, results, conflicts, inverse }`. All or nothing: any conflict leaves the objects as given. It never mutates its input. |
| `invertOps(objects, ops, ctx?)` | The ops that undo `ops`. Throws when they do not apply. |
| `rebaseOps(ops, current, ctx?)` | `{ status: "current" \| "clean" \| "conflict", results, conflicts, objects }`. |
| `mintHandle()` | A lowercase-hex handle in the shape of Gramps' `create_id()`. |
| `keyFor(listName, array, index)` and `keySegment` | The key segment of a list element, for building paths. |

**List elements are addressed by key, never by position.** A path is an RFC 6901 pointer whose list segments are keys:

| Segment | Names | Lists |
| --- | --- | --- |
| `@ref=<handle>[#<n>][:<hash12>]` | an element by its `ref`; `#n` is the occurrence among equal refs; `:<hash12>` is a base content-hash check (required in `media_list`) | `event_ref_list`, `child_ref_list`, `media_list`, `placeref_list`, `person_ref_list`, `reporef_list` |
| `@=<string>` | a handle in a list of handles | `family_list`, `parent_family_list`, `note_list`, `citation_list`, `tag_list` |
| `@k=<hash12>` | an element by the first 12 hex of the SHA-256 of its canonical JSON | every other list of objects |

`media_list` keys must carry `#n` and the hash, so two tags of one person in one photo are two elements, the same key as the sync merge (SI-22). A `media_list` key without `:<hash12>` (in a path or a `before`) is `invalid_path`: occurrence alone could select a different tag after the list was edited. Only `media_list` has to match the merge key exactly. The other ref lists use the plain `@ref=<handle>` form (with `#n` and the hash added only when a ref repeats), as the editing design does. Keys are read against the objects at the start of the call, so a key still names its element after an earlier op in the batch moved or edited it; an op marked `seq: true` reads its keys after the ops ahead of it, and every inverse op is `seq`. A key that no longer matches is a conflict (`stale_key`, `key_not_found` or `ambiguous_key`), never a different element.

**Rebase** gives each op one status, from the table in the editing design, section 7.5:

| Op | Clean when | No-op when |
| --- | --- | --- |
| `set` | the current value deep-equals `base`; or the property is absent and `base` is `null` (it creates the property) | it already equals the proposed value |
| `add` | the list exists and the key is absent | an identical element is present |
| `remove` | the element (or property) is present with the same content hash | the key says it is not there (`key_not_found`, or an absent property). An `@k` key whose element was edited since base is a `stale_key` conflict, never a no-op, and an `@ref` with changed content is `content_changed` |
| `move` | both keys are present | |
| `create` | the key is free | an identical object is already stored. A different object under the key is an `object_exists` conflict (restoring the inverse of a `delete` therefore conflicts if the handle was reused) |
| `delete` | the object exists and its hash equals `base` | |

An `add` or `move` whose `before` key is gone is a conflict (`key_not_found`) rather than an append: the proposer's position would be lost silently. An op whose target object is not in the store (`delete`, `remove`, `set`, ...) is a `missing_object` conflict, not a no-op: a deleted target belongs to the superseded flow, not to rebase. `remove` of an object property is allowed for the inverse of a property-creating `set`; `handle` and `_class` can never be added or removed.

Every other outcome is a conflict row: `{ opId, obj, op, path, reason, base, current, proposed }`. Malformed ops are conflicts with the reason `invalid_op`, `invalid_path` or `missing_base`. A value or base that carries an own `__proto__` key is `invalid_op`.

**Reduced Dates.** A viewer who saw a Date through `publishView` never saw its day and month. Their `set` carries `base_version` instead of `base`, and rebase compares the object's version from `ctx.versions`. The version is the only staleness guard such an op has, so a missing `ctx.versions` entry for the object is a `missing_version` conflict (it never applies unchecked, in `applyOps` or `rebaseOps`). `base_version` is honoured only on a Date or inside one; elsewhere the op needs a plain `base`. A whole-Date `set` of that kind keeps the stored day, month, second day and month, text and `sortval` unless the op lists `day`, `month`, `day2`, `month2` or `text` in `sets`.

**Handles.** A `create` of `new:<n>` mints a handle and replaces every `new:<n>` in the batch: in `obj`, paths and `before`, and in string values that sit in a reference field (`ref`, `place`, `*_handle` and the handle lists `family_list`, `parent_family_list`, `note_list`, `citation_list`, `tag_list`). Free text that reads `new:1` is left as typed. A `create` with a real `Class:<handle>` object key restores that object, which is how the inverse of a `delete` works.

The tests are [`api/test/records/ops.node-test.js`](../../api/test/records/ops.node-test.js), run by `npm test` after vitest, or alone with `node --test`. The GitHub workflows (`io-kit-ci`) build and package only; they do not run `api` tests, so the gate is the `api/` row of AGENTS.md (`npm test`) before a PR.

## Gramps semantics

[`api/src/records/semantics.js`](../../api/src/records/semantics.js) applies the rules Gramps itself applies when someone edits a record (editing design, section 6.2). It is a library: no route, tool or Lambda path calls it yet (HFY-TSK-249), and it ships in the `hfy-api` zip unreachable until `edit-api-changes` calls it. It imports only [`ops.js`](../../api/src/records/ops.js) (for canonical JSON) and [`gcalendar.js`](../../api/src/records/gcalendar.js), so it runs in Node and in a browser.

```
checkSemantics({ before, after, get, eventReferrers?, referrers?, admin?, today? })
  -> { ok, errors: [{ code, obj, path?, message, ... }], warnings, objects, derivedKeys, derived }
```

`before` and `after` are the touched objects as maps `{ "Person:<handle>": <Gramps JSON> }`: `after` is `applyOps(...).objects`, and a key in `before` and not in `after` is a delete. `get(key)` reads the stored object for everything else. `objects` is `after` with the derived fields filled in; a Person the change forced to recompute, though it was not in the batch, is added and listed in `derivedKeys`, so the caller writes it too. Errors carry RFC 6901 pointers into the resulting object.

The check judges the data as it will be after the ops apply, and it reports only what the change introduces. A tree that already breaks a rule, such as a dangling handle from an old import, does not block an unrelated edit to the same object, but the edit cannot add a new violation. A Date that is unchanged is not judged again, but its `sortval` is put back to the stored value, so a client cannot change it by sending a different one. `today` must be `{ y, m, d }`, a `Date` or `YYYY-MM-DD`; anything else throws a `TypeError`, and a caller that knows the member's time zone should pass the member's local day.

| Rule | Codes |
| --- | --- |
| **Dates.** Each new or changed Date is validated, then its `sortval` is recomputed. Members: Gregorian and Julian only, years 1000 to today, no date after today (a year alone means January 1, and a Julian date is compared as the day it is), a day that fits its month and leap year, a month 1 to 12, a day needs a month and a month a year, a range or span must start strictly before it ends (an equal start and end is refused; Gramps itself accepts it, so this is a deliberate stricter reading of the design wording, pending io's confirmation), and `text` only on a text-only date. Admins may use the other five calendars and any year from 1 to 9999, and may enter a future date; in those calendars only month and day ceilings are checked. | `date_shape`, `calendar_not_allowed`, `year_out_of_range`, `date_in_future`, `day_out_of_range`, `month_out_of_range`, `month_required`, `year_required`, `range_order`, `range_incomplete`, `date_empty_modifier`, `text_required`, `text_not_allowed`, `text_date_has_value`, `newyear_not_allowed` |
| **`sortval`.** What Gramps' `Date.set()` computes: the first part of the date decides (a range's end does not), a slash (dual-dated) date moves to the Julian calendar, a new-year offset (Mar 1, Mar 25, Sep 1) moves a date at or past the split into the previous year, and a text-only or empty date is 0. A `sortval` from a client is overwritten, never trusted. | |
| **References.** Every handle in a ref field exists, as an object of the class that field holds; a `new:n` temporary handle left over is an error; deleting an object that something still points to is refused. A change that deletes anything must pass `referrers`; without it the result is `referrers_required` rather than a silent pass. | `missing_reference`, `unminted_handle`, `still_referenced`, `bad_object` |
| **Two-sided links** (`editfamily.py:1274-1297`). `Family.father_handle` or `mother_handle` is `p` exactly when `p.family_list` holds the Family, and a ChildRef for `c` exists exactly when `c.parent_family_list` holds it. The error is on the Person whose list needs the fix. | `link_missing_family_list`, `link_orphan_family_list`, `link_missing_parent_family`, `link_orphan_parent_family`, `dangling_family_link`, `duplicate_family_link` |
| **Family sense** (`editfamily.py:1223-1240`). The father or mother is not also a child of the family, father is not mother, no ChildRef twice. | `parent_is_child`, `same_parent`, `duplicate_child_ref` |
| **Ancestry.** No person is their own ancestor. Every child-to-parent edge the change adds (over `parent_family_list` and the Family's father and mother) is checked for whether the parent already reaches the child, so a second cycle that shares people with one already in the tree is caught. | `ancestry_cycle`, `ancestry_limit` |
| **Call name.** A new or changed Name's `call` (primary or alternate) is one of the words of its `first_name`; an empty call is fine. | `call_name_not_in_first_name` |
| **Derived indexes.** `birth_ref_index` and `death_ref_index` are recomputed with Gramps' `set_birth_death_index` (`gen/db/base.py:2025-2047`: the first primary-role Birth event, EventType 12, and the first primary-role Death event, EventType 13) for every Person whose `event_ref_list` changed, every Person in the batch that uses an Event whose type changed, and every stored Person that `eventReferrers(eventHandle)` returns for such an Event. A type change without `eventReferrers` is an error. | `referrers_required` |

**Not built here.** The non-blocking warnings of editing design section 6.2 (a person who already has birth parents, a parent under 13 years older than the child, a possible duplicate person) are deferred to `edit-api-changes` and the relationship compiler; `warnings` is always `[]`. Erratum to the design text: Death is EventType 13 (Birth is 12), as in Gramps 6.0.6 and the goldens, not 5.

The birth-date precision rule (day and month never stored for a birth) is the guard's, not this module's (`edit-guard-wiring`).

**Goldens.** The expectations in the tests are what Gramps 6.0.6 itself computes, committed in [`api/test/records/fixtures/gramps-semantics.golden.json`](../../api/test/records/fixtures/gramps-semantics.golden.json): 454 synthetic Dates (383 valid Gregorian and Julian, plus the other calendars, slash, new-year, text-only and invalid ones) with Gramps' accept or reject, `sortval` and settled calendar, and 170 birth/death scenarios with the indexes Gramps sets before and after an event-list change and an Event type change. Other workers test against that file. It needs no Gramps to use: `python3 scripts/records/check_gramps_goldens.py` re-derives every Gregorian and Julian `sortval`, validity and index with the standard library alone and checks the file's SHA-256, and `python3 -m unittest discover gramps/tests/unit` runs it in CI. Regenerating the file needs Gramps.app: see [Regenerate the Gramps goldens](../how-to/regenerate-the-gramps-goldens.md).

The tests are [`api/test/records/semantics.node-test.js`](../../api/test/records/semantics.node-test.js), run by `npm test` after vitest, or alone with `node --test test/records/semantics.node-test.js`.

## Environment

Read in [`index.js`](../../api/src/index.js) and, for the `MCP_*` variables, in `loadMcpConfig` in [`mcp.js`](../../api/src/mcp.js). A default in code applies only when the variable is absent. [`app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml) sets the variables in the first table, each from a stack parameter.

| Variable | Default in code | Stack parameter | Purpose |
| --- | --- | --- | --- |
| `ORIGIN_VERIFY` | none: **required** | `OriginVerifySecretName` | Expected `X-Origin-Verify` value. Unset or empty means every request is `403`. |
| `TABLE_NAME` | `hfy-app` | `TableName` | DynamoDB table |
| `SESSION_JWKS_URL` | `https://<site>/auth/.well-known/jwks.json` | `SessionJwksUrl` | Auth edge's public keys, for the session cookie and for MCP access tokens |
| `SESSION_ISSUER` | `https://<site>/auth` | `SessionIssuer` | Required `iss`. Also the MCP token issuer while `MCP_TOKEN_ISSUER` is unset. |
| `SESSION_AUDIENCE` | `harrisonfamily-web` | `SessionAudience` | Required audience |
| `SESSION_COOKIE` | `io_id` | `SessionCookie` | Session cookie name |
| `ADMIN_LIST_BUCKET` | `<config-bucket>` | `ConfigBucket` | Bucket holding the admin list |
| `ADMIN_LIST_KEY` | `config/admins.json` | `AdminListKey` | Admin list key |
| `MEDIA_BUCKET` | `<site-bucket>` | `MediaBucket` | Bucket that uploads are presigned into, and that person records (`person/<gramps-id>.json`) are read from for [author labels](#author-label) |
| `MEDIA_PUBLIC_BASE` | `https://<site>` | `MediaPublicBase` | Origin that serves `uploads/`. Upload `publicUrl`s start with it, and attachment URLs must. |
| `VAPID_SECRET` | unset: push is not sent | `VapidSecretName` (left out when empty) | Secret holding the VAPID keys |

The stack does not set these. Their defaults in code apply on the deployed function:

| Variable | Default in code | Purpose |
| --- | --- | --- |
| `GROUPS_BUCKET` | `<config-bucket>` | Bucket holding the MCP groups config |
| `GROUPS_KEY` | `config/groups.json` | Groups config key: the MCP groups and the feature gate's `uat` group. Its shape is documented in [`policy.js`](../../api/src/policy.js) and in [MCP server: Groups](mcp-server.md#groups). |
| `FLAGS_URL` | `https://<site>/_data/flags.json` (`DEFAULT_FLAGS_URL` in `features.js`) | The flags file the [feature gate](#feature-gate) reads. Must be `https://`. |
| `MCP_RESOURCE_URL` | `https://<site>/mcp` (`MCP_RESOURCE` in `routes.js`) | The MCP resource URL |
| `MCP_AUDIENCE` | `MCP_RESOURCE_URL`, else `MCP_RESOURCE` | The `aud` every MCP access token must carry |
| `MCP_TOKEN_ISSUER` | `SESSION_ISSUER`, else `https://<site>/auth` | The `iss` every MCP access token must carry |
| `MCP_CLIENT_IDS` | `mcp-harrisonfamily` | Comma-separated `client_id` values an MCP access token may carry |
| `MCP_SCOPES` | `openid email profile` | Scopes advertised in the metadata and the `401` challenge |

What each MCP variable does is in [MCP server: Configuration](mcp-server.md#configuration).

- The role may read only `config/*` in the stack's `ConfigBucket` (the `AdminList` statement), so `ADMIN_LIST_KEY` and `GROUPS_KEY` must stay under `config/`. Because the stack does not set `GROUPS_BUCKET`, the groups config is always read from the default bucket. With any other `ConfigBucket`, the role grants no read on that default bucket, so the groups read fails closed and no MCP caller gets a group.
- The role may read only `person/*` in `MediaBucket` (the `PersonRecords` statement) and may put objects only under `uploads/posts/*` (`PostPhotoUploads`) and `uploads/comments/*` (`CommentPhotoUploads`), and may read objects only under those two prefixes (`UploadReads`). The `Table` statement includes `dynamodb:ConditionCheckItem` for `transact()` condition checks.

The stack sets `ORIGIN_VERIFY` with a Secrets Manager dynamic reference to the secret named by `OriginVerifySecretName` (default `harrisonfamily/cloudfront/origin-verify`). CloudFormation resolves it when the stack is created or updated, so a new secret value reaches the function only after a stack update. See [How to rotate the origin-verify secret](../how-to/rotate-the-origin-verify-secret.md).

## Session verification

[`auth.js`](../../api/src/auth.js) builds the authenticator. Verification itself is `resolveAuth` from `@io-kit/auth/server`.

- **Credential.** The cookie named `SESSION_COOKIE` (default `io_id`), read from the payload-v2 `cookies` array and from the `Cookie` header. An `Authorization` header is not read.
- **Checks.**
  - The signature verifies against the remote JWKS at `SESSION_JWKS_URL`. The kit accepts RS256 and ES256. The auth edge signs with RS256.
  - `iss` equals `SESSION_ISSUER`.
  - At least one of the `aud` values, `client_id` or `azp` equals `SESSION_AUDIENCE`. The three claims are pooled and checked together, so a token whose `aud` names another client still passes when its `client_id` or `azp` matches.
  - Expiry is checked with 5 s of clock tolerance.
  - `token_use` is not checked, but a token whose `typ` claim is `ID` is rejected.
- **JWKS.** `createRemoteJWKSet` from `jose`, with a 30 s cooldown between refetches, a 600 s maximum cache age and a 5 s fetch timeout. It is created once per container.
- **Failure.** The request gets `401 unauthenticated`. A missing cookie is not logged. Any token failure is logged as `session rejected AUTH_EXPIRED`: `@io-kit/auth` raises every verification failure with that code and puts the specific reason in the error's `detail` field, which `auth.js` does not log. The log therefore does not separate expiry from a bad signature, a wrong `iss` or audience, a malformed token, an ID token (`typ` `ID`) or a JWKS fetch failure.
- **Actor.** `{id, label, admin}`. `id` is the token's `sub`, the member's gramps id. `label` is described under [Author label](#author-label). `admin` is whether `id` is on the [admin list](#admins).

The API never holds the signing key. It sees only the public keys that the auth edge publishes, and its role has no access to the signing-key secret. See [Identity services](identity-services.md) and [How to rotate the session signing key](../how-to/rotate-the-session-signing-key.md).

### Author label

The actor's `label` is stored as `author.label` on posts and comments, their index items and their audit items, and names the actor in level-1 notifications. Every member sees it, so it is never an email address (HFY-R68). `resolveLabel`, built by `createLabelResolver` in [`labels.js`](../../api/src/labels.js) and passed to the authenticator by `index.js`, returns the first of these that is usable:

1. **The session's own name**, if `cleanLabel` accepts it. The name is the principal's `displayName`, which `@io-kit/auth` takes from the token's `name` claim, else `email`, else the username claims. `cleanLabel` trims it and rejects it when it is empty, equals the `sub`, is longer than 200 characters, contains `@`, or contains a control character (U+0000 to U+001F or U+007F). With a plain-string allowlist entry, the session's name is the member's email, which this step rejects.
2. **The person's `displayName`** from `s3://<site-bucket>/person/<gramps-id>.json` (`MEDIA_BUCKET`, key `PERSON_KEY` in `labels.js`), if `cleanLabel` accepts it. The record is looked up only when the `sub` matches `^[A-Za-z0-9_-]{1,64}$`. Any other `sub` goes straight to step 3, so no other value is ever turned into an S3 key. The lookup is an S3 `GetObject` by the function's role, not a request through CloudFront, so the private data gate on `/person/*.json` does not apply to it.
3. **The gramps id** (the `sub`), trimmed, unless it is empty or contains `@` or a control character.
4. **`family member`.**

The email is never used, at any step.

The person-record lookups are cached in memory, per container:

| Lookup result | Cached for |
| --- | --- |
| A usable `displayName` | 1 h |
| A definite miss: no such record (`NoSuchKey` or `404`), an `AccessDenied` or `403` (which S3 returns for a missing key when the caller cannot list the bucket), a record that is not valid JSON, or a record without a usable `displayName` | 1 min |
| Any other failure, including the 3 s fetch timeout | 5 s |

- The cache holds at most 1,000 entries. Adding a new id to a full cache clears it first.
- When a refresh fails after a good label was cached, the last good label keeps being served.
- Concurrent lookups for the same id share one fetch.
- Every failed fetch except an absent record (`NoSuchKey` or `404`) is logged as `author label unavailable (using the gramps_id)` with the gramps id and the error message. The role cannot list the bucket, so a missing record usually arrives as `403` and is logged.
- A label failure never ends a valid session. If `resolveLabel` throws, `auth.js` uses step 3 or 4.
- The label is resolved on every request with a valid session, reads included. The cache limits that to one S3 read per member per container each hour when the record has a usable `displayName`, and each minute when it does not.
- The MCP path uses the same resolver instance, and so the same cache, with the access token's `name` claim in step 1 ([MCP server: Actor and label](mcp-server.md#actor-and-label)).

## caps.json

`caps.json` is a machine-readable description of the API, built by `buildCaps` in [`routes.js`](../../api/src/routes.js).

- `npm run gen-caps` in `api/` runs [`scripts/gen-caps.mjs`](../../api/scripts/gen-caps.mjs). It writes `api/dist/caps.json`, and with it `api/dist/policy.json`, `api/dist/mcp/tools.json` and `api/dist/mcp/parity-caps.json`, which are described in [MCP server: Generated documents](mcp-server.md#generated-documents). It makes no AWS or network call.
- `api/dist/` is gitignored, so the files are not in the repository. The package script regenerates them and ships them in the zip under `dist/`. No route serves any of them.
- The handler dispatches from `ROUTES`, the MCP tools are built from `ROUTES`, and `buildCaps` lists `ROUTES`, so the action list, the tool list and the routes come from the same source and cannot drift.

| Field | Value |
| --- | --- |
| `name` | `hfy-api` |
| `version` | `0.1.0` (`API_VERSION` in `routes.js`) |
| `base_path` | `/api` |
| `auth` | `{scheme: "session-cookie", issuer_env: "SESSION_ISSUER", reads_require_session: true}` |
| `subjects` | `["person:<gramps_id>", "post:<ulid>"]` |
| `actions` | One per route: `{name, method, path, auth: "session", write, summary}`, plus `gate` when the route declares one: `{feature}`, `{switch}` or `{exempt}` ([Feature gate](#feature-gate)). `write` is true for every method except GET. |
| `content` | `{source: "posts", capabilities, post_types, visibilities}`. `capabilities`: `list`, `get`, `createDraft`, `update`, `setVisibility`, `delete`, `drafts` and `audit` are true; `subscribe` and `since` are false; `attachments` is `"metadata-only"`; `filters` are `subject`, `type`, `author`, `visibility`. |
| `comments` | `{reactions: "one-emoji-per-principal-per-comment", threading: "parentId (reply)", max_body: 1000, subject_param}` |
| `mcp` | `{resource, tools}`. `resource` is `MCP_RESOURCE` (`https://<site>/mcp`). `tools` has one entry per route with an `mcp` member: `{name, action, write}`, where `name` is the tool name (for example `hfy_posts_get`), `action` the route name and `write` the route's `write`. |
| `notifications` | `{types: <the four types>, default_level: 0}` |
| `audit` | `{item: "AUDIT#", fields: ["op", "id", "principal", "at", "before", "after"], ops: ["create", "update", "delete", "visibility"]}` |

`actions` and `mcp.tools` are derived from `ROUTES`. The other fields are written by hand in `buildCaps` and differ from the code in two places:

- `audit.ops` leaves out the comment op `edit`, and `audit.fields` leaves out `reason`.
- `comments.subject_param` says the subject may be given in the query or the body on PATCH, DELETE and react. DELETE reads it from the query only.

## Packaging and deploy

[`scripts/ci/package-api.sh`](../../scripts/ci/package-api.sh) builds `dist/hfy-api.zip` at the repository root (`dist/` is gitignored). It works from a clean checkout and never uses `api/node_modules/`:

1. Exits unless `CODEARTIFACT_AUTH_TOKEN` is set.
2. Copies `api/src`, `api/scripts`, `package.json`, `package-lock.json` and `.npmrc` to a temporary directory.
3. Runs `npm ci --omit=dev --ignore-scripts` there, then removes `.npmrc` and the lockfile.
4. Runs `gen-caps` inside the stage, against the packages just installed, then removes `scripts/`. Exits 1 if `dist/caps.json` is missing or empty. The other three generated files are not checked.
5. Copies `caps.json`, and only `caps.json`, to `api/dist/caps.json`, so the local copy matches the zip.
6. Zips the result with `-X`. The zip root holds `src/`, `node_modules/`, `package.json` and `dist/` with `caps.json`, `policy.json`, `mcp/tools.json` and `mcp/parity-caps.json`, which matches the handler `src/index.handler`.

The zip is rolled out by the CloudFormation stack built from [`app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml):

- **Stack name.** No script in the repository creates or names the stack. The live stack is `<app-stack>`. Its name differs from the `--stack hfy-app` default that [`add-api-behavior.sh`](../../scripts/infra/add-api-behavior.sh), [`add-mcp-behavior.sh`](../../scripts/infra/add-mcp-behavior.sh), [`add-auth-behavior.sh`](../../scripts/infra/add-auth-behavior.sh) and [`add-uploads-behavior.sh`](../../scripts/infra/add-uploads-behavior.sh) use to read its outputs. Runs of those scripts against the live stack need `--stack <app-stack>`. [`add-data-gate-behaviors.sh`](../../scripts/infra/add-data-gate-behaviors.sh) names the app stack with `--app-stack` instead, which only its `--remove` reads ([Reading photos back](#reading-photos-back)).
- **Code.** The stack reads the code from `<code-bucket>` at `CodeKey`. The template's default is `lambda/hfy-api.zip`. A release uploads the zip under a commit-named key, `<code-bucket>/lambda/hfy-api-<sha>.zip`, and sets `CodeKey` to it through a CloudFormation change set on `<app-stack>` that is reviewed before it is executed. In that change set the `FunctionUrl` resource shows `Conditional` replacement, because its target, `Function.Arn`, is not known until deploy time (`AuthFunctionUrl` shows the same when the auth edge ships in the same change set). After execution the stack's `FunctionUrl` and `AuthFunctionUrl` outputs must be unchanged, since CloudFront's origins point at those hosts.
- **CloudFront.** The `/api/*` behavior is added by `add-api-behavior.sh`. The `/mcp*` and `/.well-known/oauth-protected-resource*` behaviors are added by `add-mcp-behavior.sh`, which also needs the published version of the `hfy-mcp-edge401` Lambda@Edge function: the `Edge401FunctionVersionArn` output of the us-east-1 stack `hfy-mcp-edge401`, built from [`mcp-edge401.us-east-1.yaml`](../../infrastructure/mcp-edge401.us-east-1.yaml), or `--edge401-arn` ([How to deploy the Lambda@Edge functions](../how-to/deploy-the-edge-functions.md)).
- **Pipeline.** No workflow builds or deploys hfy-api. The GitHub deploy role's `LambdaDeploy` statement names the function, but `ci.manifest.yaml` has no target for it (see [Why releases ship through a pipeline and feature flags](../explanation/release-model.md)). For the steps, see [How to deploy the app stack and its CloudFront behaviors](../how-to/deploy-the-app-stack.md).

`npm test` in `api/` runs the Vitest suites against an in-memory DynamoDB fake. [`scripts/ci/mcp-conformance.sh`](../../scripts/ci/mcp-conformance.sh) runs `gen-caps`, the MCP suites and `io-kit parity diff`. CI runs neither. See [How to run the test suites](../how-to/run-the-tests.md).

## Related pages

- [System architecture](architecture.md): the table definition, the stack, IAM and buckets.
- [MCP server](mcp-server.md): the `/mcp` surface that the same function serves, its tools, policy and groups.
- [Identity services](identity-services.md): the auth edge that issues the session cookie and the MCP access tokens, and publishes the JWKS.
- [Front end](front-end.md): the islands that call this API.
- [Private data and secrets inventory](private-data-and-secrets.md): where secrets and private family data are kept.
- [Codebase map](codebase-map.md): where each capability lives.
- [How member content stays accountable](../explanation/member-content-design.md): why the permission, audit and notification rules are what they are, including the post body limit.
- [The identity model: one edge, one allowlist](../explanation/identity-model.md): how a sign-in becomes a member id.
- [How to diagnose sign-in and API failures](../how-to/diagnose-sign-in-and-api-failures.md): working from a status code back to its cause.
- [How to add or remove a family member's access](../how-to/manage-family-access.md): who can sign in.
- [How to deploy the app stack and its CloudFront behaviors](../how-to/deploy-the-app-stack.md): shipping a new `hfy-api` build.
- [How to deploy and update the Lambda@Edge functions in us-east-1](../how-to/deploy-the-edge-functions.md): the `hfy-mcp-edge401` function the MCP behaviors need.
- [How to connect an MCP client and run an admin delete](../how-to/connect-an-mcp-client.md): using the MCP server as a member.
- [How to turn on push notifications](../how-to/turn-on-push-notifications.md): the VAPID secret.
- [How to cut over to authV2 and the private data gate, and roll back](../how-to/cut-over-to-the-private-data-gate.md): gating the family data and `/uploads/*`, and taking the gate off again.
- [The privacy model for family data](../explanation/family-data-privacy.md): why member photos are served only to members.
