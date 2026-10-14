# Family API (hfy-api)

Reference for hfy-api, the members-only JSON API served at `/api/*`. This page covers the runtime, the request pipeline, every route, the data each route reads and writes, the contact-information guard, profile links, permissions, audit records, notifications, uploads, configuration, session verification, the capability document and packaging.

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
| [`handler.js`](../../api/src/handler.js) | The pipeline: path, route, session, body. Wires the posts, comments, profile links, notification and upload services for each request. Also exposes `handler.invoke(actor, routeName, {params, query, body})`, which runs a route's own handler without the HTTP steps, for the MCP tools. |
| [`routes.js`](../../api/src/routes.js) | The route registry `ROUTES` (including each MCP tool's definition and each route's `gate`), `defineRoutes`, `matchRoute`, `MCP_RESOURCE`, and `buildCaps` for `caps.json`. |
| [`features.js`](../../api/src/features.js) | The [feature gate](#feature-gate): `requireFeature`, `serverSwitch` and `gateExempt` for `ROUTES` entries, the flags-file reader `createFlagSource`, `createFeatureGate`, the `x-hfy-preview` parser, and `featureOn` for producers. |
| [`http.js`](../../api/src/http.js) | JSON responses, `HttpError` (with its optional `details`), error mapping, cookie parsing. |
| [`origin.js`](../../api/src/origin.js) | The `X-Origin-Verify` check. |
| [`auth.js`](../../api/src/auth.js) | Remote JWKS, session authenticator (which resolves the actor's label), admin list. |
| [`labels.js`](../../api/src/labels.js) | Author labels: `cleanLabel`, `fallbackLabel` and the cached person-record resolver `createLabelResolver` (see [Author label](#author-label)). Used by the cookie path and the MCP path. |
| [`mcp.js`](../../api/src/mcp.js) | The MCP mount: `isMcpPath`, `loadMcpConfig`, the bearer edge, the tool registry built from `ROUTES`, and the actor a tool runs as. See [MCP server](mcp-server.md). |
| [`mcp-caps.js`](../../api/src/mcp-caps.js) | Build-time views of the MCP surface for `gen-caps`: the `tools/list` result and the `@io-kit/parity` caps document. |
| [`policy.js`](../../api/src/policy.js) | The MCP permission table `POLICY_ROWS`, the step-up settings, `policyDocument` for `dist/policy.json`, and the groups resolver for `config/groups.json` (the MCP groups, the feature gate's `uat` group and the `gramps-owner` group of the sync API), whose shape is documented at the top of the file. |
| [`content.js`](../../api/src/content.js) | Posts, as an `@io-kit/content` ContentSource, including the upload binding of new attachments. |
| [`comments.js`](../../api/src/comments.js) | Comments and reactions, as an `@io-kit/comments` CommentSource. |
| [`comment-photos.js`](../../api/src/comment-photos.js) | Comment photo attachments: `normalizeNew` (the shape check), and `createUploadPhotos` with its `parse`, `owned` and `bind` (the `UPLOAD#` binding, `headUpload` and `checkLocation`). `uploadPhotosFor` wires it over the API's S3 client. See [Comment photos](#comment-photos). |
| [`contrib.js`](../../api/src/contrib.js) | The contributions ledger: the `CONTRIB#` event and `CSTAT#` counter builders `contribOps`, `revokeOps`, `hideOps` and `mergeOps`, whose fragments commit in the post and comment transactions, and the event read `getEvent`. See [Contributions ledger](#contributions-ledger). |
| [`contrib-read.js`](../../api/src/contrib-read.js) | The contributions read side: `createContribReader` (the `list`, `stats` and `site` behind `/contributions`), the pure feed-line rule `pickLine` with its `CANDIDATES` and `lineText`, `hrefOf`, and the default `proposalVisible`. See [Contributions read API](#contributions-read-api). |
| [`links.js`](../../api/src/links.js) | Profile links: `createLinks` (the `get` and `put` behind `/people/:id/links`), `LINKS_ID_RE`, `linksKeys` and `linksAuditId`. It validates with the shared [`profile-links.mjs`](../../shared/profile-links.mjs). See [Profile links](#profile-links). |
| [`guard.js`](../../api/src/guard.js) | The R-18 contact-information guard on post and comment text: `createGuard`, `GuardError`, `guardDobFromEnv`. See [Contact-information guard](#contact-information-guard). |
| [`upload-guard.js`](../../api/src/upload-guard.js) | `checkLocation(bucket, key)`: refuses an upload whose stored bytes carry location metadata. See [Location check](#location-check). `headUpload(bucket, key)`: the `HeadObject` of a comment photo, with a 2 s timeout. See [Comment photos](#comment-photos). |
| [`txn.js`](../../api/src/txn.js) | Audit item builder, `transact()` (puts, deletes, updates, condition checks, `ClientRequestToken`, conflict retry), `mapCancellationReasons`, `counterUpdate`, `mergeUpdates`, `assertTxnSize`, `GSI1` paging. |
| [`sync/store.js`](../../api/src/sync/store.js) | The cloud record store's keys and items (`REC#`, `SYNC#LOG`, `SYNC#HEAD`, `SYNC#BATCH#`, `GID#`, `IDALIAS#`), the batch id and request token, and the reads `applyBatch` needs. See [The cloud record store](#the-cloud-record-store). |
| [`records/read.js`](../../api/src/records/read.js) | The read-only records API (HFY-TSK-175): `publishView`, `applyModOverlay`, `viewRecord` and the two `/api/records` routes. See [Records read API](#records-read-api). |
| [`records/edit-bundle.js`](../../api/src/records/edit-bundle.js) | The editing API core (HFY-TSK-182): the edit bundle (`GET /api/edit/:cls/:ref`), the schema route (`GET /api/edit/schema/:cls`), the `HFY_EDITING` gate `editingGate` and the `ownRecord` and `editing` fields of `/api/me`. See [Editing API core](#editing-api-core). |
| [`sync/apply.js`](../../api/src/sync/apply.js) | `applyBatch()`, the one write path into the record store. The desktop push routes call it (HFY-TSK-173); the edit routes will. See [The cloud record store](#the-cloud-record-store). |
| [`records/index.js`](../../api/src/records/index.js) | Read accessors over the record store: `get`, `byGrampsId` (GSI1, tombstones excluded), `backrefs`, `graph` (cached up to 60 s) and `customTypes`, on a store view (snapshot plus `SYNC#LOG` fold). The records read routes (`records/read.js`) and the edit routes (`records/edit-bundle.js`) call it. |
| [`sync/hooks.js`](../../api/src/sync/hooks.js) | The commit-hook registry: `registerContributor` and `registerAfterCommit`. |
| [`sync/validator.js`](../../api/src/sync/validator.js) | The server validator `applyBatch()` runs on every call: step-up and the destructive budget, schema, privacy, ids and integrity (HFY-TSK-245). See [The server validator](#the-server-validator). |
| [`sync/checker.js`](../../api/src/sync/checker.js) | The privacy checker inside it: redaction policy v1, detection only, with RFC 6901 pointers, for one object list (`privacyVerdict`) or a batch against the store view (`batchViolations`). |
| [`sync/schema.js`](../../api/src/sync/schema.js) | The Gramps 6.0.6 JSON Schema per class and the `MediaRef.rect` rule. |
| [`sync/view.js`](../../api/src/sync/view.js), [`sync/errors.js`](../../api/src/sync/errors.js) | The store view the validator reads (heads, id guard, referrers, destructive budget) and `SyncError`. |
| [`sync/auth.js`](../../api/src/sync/auth.js), [`sync/guard.js`](../../api/src/sync/guard.js), [`sync/routes.js`](../../api/src/sync/routes.js) | The desktop sync API's front door (HFY-TSK-172): the `sync-bearer` authenticator with `requireOwner`, `requireStepUp` and `requireConflictDecision`; the `SYNC_API_ENABLED` switch, the handshake and the per-request middleware; and the `sync.meta` and `sync.bind` routes. See [The sync API](#the-sync-api). |
| [`sync/push.js`](../../api/src/sync/push.js), [`sync/media.js`](../../api/src/sync/media.js) | The desktop push routes (HFY-TSK-173): the push sessions (open, complete, abort), `POST /api/sync/batches` through `applyBatch()`, and the blob path (presign, staging, finalize). See [The push routes](#the-push-routes). |
| [`keys.js`](../../api/src/keys.js) | Key helpers. |
| [`notify.js`](../../api/src/notify.js) | Notification types, templates and fan-out, with the persist-first inbox gate (`featureOn("inboxV1", recipient)`). |
| [`uploads.js`](../../api/src/uploads.js) | Presigned photo uploads: validation, the server-chosen object key and the `UPLOAD#` binding. |
| [`presign.js`](../../api/src/presign.js) | The S3 presigner for uploads, kept apart so tests can sign offline. |
| [`records/ops.js`](../../api/src/records/ops.js) | The EditOp engine for the editing work: `applyOps`, `invertOps`, `rebaseOps` (clean, no-op or conflict per op), keyed list segments (`@ref=`, `@=`, `@k=`) and `mintHandle`. It imports nothing, so it runs in Node and in a browser, and no route calls it yet. See [The EditOp engine](#the-editop-engine). |
| [`records/semantics.js`](../../api/src/records/semantics.js) | The Gramps rules for edited records: dates and `sortval`, handle references, two-sided family links, family sanity, ancestry cycles and the derived `birth_ref_index` and `death_ref_index`. `checkSemantics` runs on the objects an EditOp batch produced. It imports only the EditOp engine and the calendar port, and no route calls it yet. See [Gramps semantics](#gramps-semantics). |
| [`records/field-policy.js`](../../api/src/records/field-policy.js), [`records/edit-plan.js`](../../api/src/records/edit-plan.js) | Who may save what (editing design 3.3, 4; BRD2 D2-13). `field-policy.js` holds the policy table (`FIELD_POLICY_ROWS`: class, pointer pattern, own, other; admins direct unless the row says otherwise), the Q2-15 section (`Q2_15_ROWS`, one switch per row, set through `createFieldPolicy({ answers })`), `ownRecord` (the one Person for the session's `gramps_id`, else null), `relationOf` and `classifyOps`. `edit-plan.js` splits a submission into dependency-closed direct, review and refused groups and writes the plain-language summaries. An unmatched pointer is a proposal. Pure given a read-only store view. `GET /api/me` calls `ownRecord`, and `edit.get` calls `relationOf` and the policy table's `document()` (see [Editing API core](#editing-api-core)); no route calls `edit-plan.js` yet. |
| [`records/gcalendar.js`](../../api/src/records/gcalendar.js) | A port of Gramps' calendar arithmetic (`*_sdn` in `gen/lib/gcalendar.py`): Gregorian, Julian, Hebrew, French Republican, Persian, Islamic and Swedish. It imports nothing. |
| [`records/relationships.js`](../../api/src/records/relationships.js) | The relationship intent compiler: `parents`, `children`, `spouse` and `unlink` intents to the Gramps Family and ChildRef EditOps, checked with `checkSemantics`. It imports only the EditOp engine, the Gramps semantics and the duplicate matcher, and no route calls it yet. See [Relationship compiler](#relationship-compiler). |
| [`records/duplicates.js`](../../api/src/records/duplicates.js) | The duplicate matcher for new people (case-folded, accent-stripped). It imports nothing. See [Relationship compiler](#relationship-compiler). |

### Dependencies

| Package | Version (lockfile) | Used for |
| --- | --- | --- |
| `@io-kit/content` | 0.3.1 | Post types and visibilities, `can` and visibility policy, `ContentError`, audit entry shape, list limits |
| `@io-kit/comments` | 0.3.1 | Comment `can` policy, emoji check, `CommentError`, audit entry shape, list limits |
| `@io-kit/notify` (`/server`) | 0.6.0 | The notification routes (five push routes and three inbox routes), the inbox store, persist-first delivery (`createDelivery`), subscription and preference stores, push payloads and sending |
| `@io-kit/auth` (`/server`) | 2.2.0 | `resolveAuth`: JWT verification and claim mapping for the session cookie |
| `@io-kit/mcp` (`/edge`, `/core`) | 0.1.0 | The MCP mount: bearer-token gate, protected-resource metadata and `401` challenges (`/edge`), and the JSON-RPC tools server evaluated against the policy table (`/core`) |
| `@io-kit/feed` | 1.1.1 | `createUlidFactory`: monotonic ULIDs for record ids and audit sort keys |
| `jose` | 6.2.12 | `createRemoteJWKSet` for the session keys |
| `web-push` | 3.6.7 | Push delivery. Imported only when the VAPID keys load. |
| `@aws-sdk/*` | 3.1000.0 | DynamoDB document client, S3 and the S3 request presigner, Secrets Manager |

[`api/package.json`](../../api/package.json) pins every runtime dependency to an exact version, and the lockfile holds the same versions. [`api/test/kit-pins.test.js`](../../api/test/kit-pins.test.js) checks that every `@io-kit` pin in `api/` and `islands/` is exact and matches its lockfile.

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
7. **Session required.** Without a verified session: `401 unauthenticated`. Every route requires a session, reads included. A route with `auth: "sync-bearer"` (`/api/sync/*`) takes steps 5 to 7 differently: see [The sync API](#the-sync-api).
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
| `401` from a `sync-bearer` route | the JSON headers, plus `www-authenticate: Bearer realm="harrisonfamily.us/api/sync"` (an `HttpError` may carry `headers`) |

A `204` response has an empty body.

### Error shape

```json
{ "error": "<code>", "message": "<text>", "details": { }, "errors": [ ] }
```

`details` appears only on an error that carries it: a kit error with details, an `HttpError` constructed with them, or a record-store conflict ([The cloud record store](#the-cloud-record-store)). `errors` appears only on a contact-information refusal ([Contact-information guard](#contact-information-guard)). An error that carries both sends both. Post errors may carry `{"field": ...}` or `{"id": ...}`. Comment validation errors carry `{"field": ...}`. Profile links errors carry `{"fields": [...]}` on a `422` and `{"current": ...}` on a `409` ([Profile links](#profile-links)). Any error that is not one of the API's or the kits' typed errors becomes `500` with `{"error":"internal","message":"internal error"}`, and the log line holds only `{name, code, route, requestId}` (never the message or stack, which can quote stored text; HFY-TSK-235). The origin-check `403` and the notification routes use shorter bodies, described in their sections.

Two statuses exist for validation. Checks on the request itself (body parsing, a missing `subject` on a comment route, upload input, the shape of a profile links body and its person id) return `400 validation`. Checks on post, comment and profile link content return `422 validation`.

| Status | `error` | Raised by |
| --- | --- | --- |
| 400 | `validation` | Unparseable or non-object body; missing `subject` on a comment route; upload input; a profile links person id, `links` or `version` of the wrong shape |
| 400 | `cursor_invalid` | A posts or comments cursor that is malformed, or a posts cursor from another filter |
| 400 | `photo_has_location` | A new post or comment attachment whose stored bytes carry location metadata ([Location check](#location-check)) |
| 400 | `upload_missing` | A new post or comment attachment whose object is missing or empty, or whose type differs from the one it was presigned for; a comment photo over 10 MB |
| 401 | `unauthenticated` | No session cookie, or a token that fails verification |
| 403 | `forbidden` | Failed origin check; caller lacks the permission for a post, comment or profile links action |
| 403 | `self_react` | Reacting to your own comment |
| 403 | `upload_not_owned` | A new post or comment attachment that is not the caller's own, unexpired, not yet attached upload of the same purpose ([Upload binding](#upload-binding), [Comment photos](#comment-photos)) |
| 404 | `not_found` | Unknown route; a route behind a feature gate that is closed to the caller; comment `attachments` on a create or edit, or an upload with `purpose` `comment`, while `commentPhotosV1` is closed to the caller; post missing or not visible to the caller; comment missing; malformed subject or comment id |
| 405 | `method_not_allowed` | Known path, other method |
| 409 | `conflict` | A post or comment write's transaction was cancelled by a failed condition, usually because the record changed or was deleted after it was read (see [Concurrent writes](#concurrent-writes)); a profile links write whose `version` is not the stored one, with the stored links in `details.current` |
| 415 | `unsupported_media_type` | A write without a JSON content type |
| 422 | `validation` | Post body, type, visibility, title, subject or attachments, or a post over the size cap; comment body or attachments; malformed subject on comment create; emoji; profile link fields, listed in `details.fields` |
| 422 | `contact_info` | A phone number, email address, street address, PO box or contact-channel link in a post's body, title or attachment description, or a comment's body or attachment description ([Contact-information guard](#contact-information-guard)) |
| 422 | `dob_not_allowed` | Only while `HFY_GUARD_DOB` is `on`: a birth day or month, and nothing else the guard refuses, in the same fields |
| 500 | `server` | A comment create, edit or delete failed for a reason other than a cancelled transaction |
| 500 | `internal` | Anything else |
| 503 | `busy` | A post, comment or profile links write's transaction was cancelled by `TransactionConflict` on every one of its 4 attempts (see [Concurrent writes](#concurrent-writes)); nothing was written, retry |
| 503 | `unavailable` | A post write failed for a reason other than a failed condition or a conflict; a profile links transaction cancelled for any other reason, such as throttling; uploads with no presigner; the `UPLOAD#` write of a presign failed; a new post or comment attachment on a handler built without an S3 client; a comment photo's `HeadObject` that fails or takes longer than 2 s |

## Routes

All paths are under `/api`, and every route needs a session, except the `sync-bearer` routes of [The sync API](#the-sync-api), which need the desktop client's bearer token instead. Routes ignore body and query fields they do not name. The route names in the first column are the action names in [`caps.json`](#capsjson).

| Name | Method | Path | Input | Success | Notes |
| --- | --- | --- | --- | --- | --- |
| `me.get` | GET | `/me` | none | `200 {id, label, admin, can: {moderate, graduate, approve}}`, plus `badges: {accessRequests}` for admins only | Not an MCP tool. `admin` is `actor.admin` from `config/admins.json`, and `can.*` is computed on the server; clients never infer admin from `can.delete`. `badges.accessRequests` counts the GSI1 partition `ACCESSREQS#pending` (`0` when empty). If the badge count fails it is logged and `badges` is omitted (id, label, admin and `can.*` still return). Fields are additive only. `ownRecord` is `{cls: "Person", handle, gramps_id}` for the one live Person with the session's `gramps_id`, else `null` (0 or 2+ people; a lookup failure is `null` too), and `editing` is `true` while `HFY_EDITING` is `on` (see [Editing API core](#editing-api-core)). Exempt from the [feature gate](#feature-gate) (`gateExempt`). `no-store`. |
| `comments.list` | GET | `/comments` | query `subject` (required), `order` (`asc` default, or `desc` for newest first), `cursor`, `limit` | `200` thread | A cursor works only with the order that issued it: the other order answers `400 cursor_invalid` |
| `comments.create` | POST | `/comments` | body `subject`, `body`, optional `parentId`, optional `attachments` | `201` comment | Sends notifications. `attachments` (up to 4; an empty `body` is allowed with one) is dark until `commentPhotosV1` is on: see [Comment photos](#comment-photos) |
| `comments.update` | PATCH | `/comments/:id` | body `body`, optional `attachments`; `subject` in the body or the query | `200` comment | Author only. Photos can be removed or re-described, never added |
| `comments.delete` | DELETE | `/comments/:id` | query `subject` (required), optional `reason` | `204` | Author or admin. `subject` is read from the query only. |
| `comments.react` | POST | `/comments/:id/react` | body `emoji`; `subject` in the body or the query | `200` `{removed, reaction?}` | Set or toggle off |
| `posts.list` | GET | `/posts` | query `cursor`, `limit`, `subject`, `type`, `author`, `visibility` | `200` `{items, cursor}` | Newest first |
| `posts.get` | GET | `/posts/:id` | none | `200` post | |
| `posts.create` | POST | `/posts` | body `body`, optional `type`, `visibility`, `subject`, `title`, `attachments` | `201` post | Publishing sends notifications |
| `posts.update` | PATCH | `/posts/:id` | body, all optional: `title`, `subject`, `body`, `attachments` | `200` post | Author only. `null` clears `title` or `subject`. |
| `posts.visibility` | POST | `/posts/:id/visibility` | body `visibility` | `200` post | Author only |
| `posts.delete` | DELETE | `/posts/:id` | none | `204` | Author or admin. Also removes the post's comment thread. |
| `uploads.presign` | POST | `/uploads` | body `contentType`, `size`, optional `purpose` (`post` default, or `comment`); a `filename` is ignored | `201` | Presigned S3 PUT under `uploads/posts/`, or `uploads/comments/` for `purpose` `comment` (jpeg, png or webp only; needs `commentPhotosV1`) |
| `contributions.list` | GET | `/contributions` | query `author` (required), `cursor`, `limit` (1 to 50, default 10) | `200` `{items, cursor}` | Newest first. Not an MCP tool. Behind `requireFeature("contribV1")`. See [Contributions read API](#contributions-read-api). |
| `contributions.stats` | GET | `/contributions/stats` | query `author` | `200` `{author, total, by_kind, first_at?}` | A member's counters, zeros for an unknown member. Behind `contribV1`. Not an MCP tool. |
| `contributions.site` | GET | `/contributions/stats` | none (no `author`) | `200` `{total, line, computed_at}` | The site total and the feed line, through the cached `CSTAT#site/LINE` row. Shares its path with `contributions.stats`: `?author=` picks that route. Behind `contribV1`. Not an MCP tool. |
| `records.get` | GET | `/records/:class/:handle` | none | `200` `{class, handle, gramps_id, version, obj}` with `ETag: "v<version>"` | Read-only, not an MCP tool, behind `HFY_EDITING`. `404` for a tombstone, an unknown handle or class. See [Records read API](#records-read-api) |
| `records.byGrampsId` | GET | `/records/Person/by-id/:gramps_id` | none | `200`, as `records.get` | `404` when no live Person has the id, `409 ambiguous_gramps_id` when two do |
| `edit.schema` | GET | `/edit/schema/:cls` | none | `200` `{class, schema, sha256, schemaHash}` | Not an MCP tool, behind `HFY_EDITING` (`404 not_found` for everyone while it is not `on`). `404` for a class with no schema (Tag). See [Editing API core](#editing-api-core) |
| `edit.get` | GET | `/edit/:cls/:ref` | none | `200` the edit bundle `{key, version, etag, obj, related, relation, viewer, policy, pending, customTypes, schemaHash}` | `ref` is a gramps_id or `h:<handle>`. Not an MCP tool, behind `HFY_EDITING`. `404` for an unknown or hidden record, `409 ambiguous_id` when two live records share the gramps_id. See [Editing API core](#editing-api-core) |
| `links.get` | GET | `/people/:id/links` | none | `200` `{links, version, can: {edit}}` | Any member. Behind `requireFeature("profileLinks")`. See [Profile links](#profile-links). |
| `links.put` | PUT | `/people/:id/links` | body `links` (platform to string or `null`), `version` | `200` `{links, version}` | Owner sets or clears; an admin only clears. Behind `requireFeature("profileLinks")`. |
| `subscriptions.get` | GET | `/subscriptions` | query `subject` (`person:<gramps_id>`) | `200` `{subject, subscribed}` | `400` for a bad subject. Shares its path with `subscriptions.list`: `?subject=` picks this route. Behind `requireFeature("recordSubsV1")`. Not an MCP tool. See [Record follows](#record-follows). |
| `subscriptions.list` | GET | `/subscriptions` | query `cursor`, `limit` (1 to 100, default 25) | `200` `{items: [{subject, created_at}], cursor}` | My follows, newest first; `400 cursor_invalid`. Behind `recordSubsV1`. Not an MCP tool. |
| `subscriptions.put` | PUT | `/subscriptions/person/:id` | body `{}` | `200` `{subject, subscribed: true}` | Idempotent. `404` for an unknown person, `400 self_subscribe` for your own page, `503` if the person lookup fails. Behind `recordSubsV1`. |
| `subscriptions.remove` | DELETE | `/subscriptions/person/:id` | none | `204` | Idempotent. Named `remove`, never `*.delete`, so the policy glob does not read it as an admin step-up action. Behind `recordSubsV1`. |
| `notifications.vapid-public-key` | GET | `/notifications/vapid-public-key` | none | `200` `{public_key}` | Kit route |
| `notifications.subscribe` | POST | `/notifications/subscribe` | body: a push subscription | `200` `{ok: true}` | Kit route |
| `notifications.unsubscribe` | DELETE | `/notifications/subscribe` | body `{endpoint}` | `200` `{ok: true}` | Kit route |
| `notifications.preferences.get` | GET | `/notifications/preferences` | none | `200` preferences | Kit route |
| `notifications.preferences.put` | PUT | `/notifications/preferences` | body: preferences | `200` preferences | Kit route |
| `notifications.inbox.list` | GET | `/notifications/inbox` | query `filter` (`unread` or `all`), `cursor`, `limit` | `200` `{items, next_cursor, has_more}` | Kit route; dark behind `inboxV1` |
| `notifications.inbox.count` | GET | `/notifications/inbox/unread-count` | none | `200` `{unread}` | Kit route; dark behind `inboxV1` |
| `notifications.inbox.read` | POST | `/notifications/inbox/read` | body `{ids}` or `{all: true}` | `200` `{updated, unread, ...}` | Kit route; dark behind `inboxV1`; no MCP tool and no policy row |

The eight notification routes are delegated to `createNotifyHandler` from `@io-kit/notify/server`, with the session's member id as the principal. See [Notifications](#notifications).

Twelve routes are behind the [feature gate](#feature-gate): the four `subscriptions.*` routes, with `requireFeature("recordSubsV1")`, `links.get` and `links.put`, with `requireFeature("profileLinks")`, the three inbox routes (`notifications.inbox.list`, `notifications.inbox.count` and `notifications.inbox.read`), with `requireFeature("inboxV1")`, and the three contribution routes (`contributions.list`, `contributions.stats` and `contributions.site`), with `requireFeature("contribV1")`. The comments, posts, uploads and five push notification routes predate it, and `me.get` is its declared exemption. Every route added from HFY-PLN-002 on declares a feature or a server switch.

Seven routes are also MCP tools, through the `mcp` member of their `ROUTES` entry: `comments.list`, `comments.create`, `comments.delete`, `posts.list`, `posts.get`, `posts.create` (drafts only) and `posts.delete`. See [MCP server: Tools](mcp-server.md#tools). `me.get`, `links.get`, `links.put`, the four `subscriptions.*` routes and the three `contributions.*` routes are session-only routes with no tool, and the header of [`api/parity/map.yaml`](../../api/parity/map.yaml) says so.

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
- **Cache.** 60 s per container from the last successful read, and concurrent requests share one read. Routes with a feature gate read the file, and so does any handler that calls `c.featureOn`: `comments.create` and `comments.update` when the request carries `attachments`, and `uploads.presign` for `purpose` `comment` ([Comment photos](#comment-photos)).
- **Failures.** A non-2xx status, a body that is not a JSON object, a timeout or a network error keeps the last good copy for up to 10 minutes after the last successful read. After that every feature is off until a read succeeds. A failed read is retried after 5 s. The log line is `flags read failed (keeping the last good flags)` or `flags read failed (features off)`, with only the error's name and code.
- **Values.** Only boolean values are kept, and a feature is on only when its value is exactly `true`.
- **Flips.** A change to `flags.json` reaches the API within about 60 s of the site deploy, with no API deploy.

### `featureOn` for producers

`featureOn(name, principal)` applies the same rule outside a route. `principal` is a gramps id or an actor: a `uat` principal gets `true`, anyone else the deployed value. `index.js` configures it with the deployed gate; until then it returns `false`. A route handler gets `c.featureOn(name)` for its caller, which counts the caller's preview header when they are `uat`.

**Comment photos** ([`routes.js`](../../api/src/routes.js)). `comments.create`, `comments.update` and `uploads.presign` predate the gate and declare none. Their handlers call `c.featureOn("commentPhotosV1")` when the request carries comment `attachments` or `purpose` `comment`, and answer `404 not_found` while it is off for the caller. Requests without them never read the flag ([Comment photos](#comment-photos)).

**Persist-first inbox writes** ([`notify.js`](../../api/src/notify.js)). The notifier stores an inbox item for a recipient, and puts the recipient's unread count in the push as `app_badge`, only while `featureOn("inboxV1", recipient)`. While `inboxV1` is off, no inbox item is stored for anyone outside `uat`, and pushes carry no badge. `new_family_post` is push-only and never stored. `index.js` wires a `DynamoNotificationStore` on the app table (`INBOX#<principal>` rows, `@io-kit/notify` 0.6.0). Delivery is the kit's `createDelivery`: it stores first, then pushes. Storing needs no `VAPID_SECRET`; only the push does. Unread items have no TTL, and a 90-day TTL starts when an item is read. The three inbox routes are dark behind `inboxV1` too (404 outside `uat`).

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
| `body` | string | Required. At most 20,000 characters (JavaScript string length), otherwise `422` "body too long". Stored as sent, not trimmed. It may be empty or blank only while the post has at least one attachment, a photo-only post (HFY-TSK-315); a post with neither is `422` "body is required" with `details.field` `body`. A body that is not a string is the same error. |
| `attachments` | array | At most 10, each a member upload. See [Attachments](#attachments). Otherwise `422` with `details.field` `attachments`. |
| `visibility` | `draft`, `published` or `withdrawn` | See below |
| `created_at`, `updated_at` | ISO 8601 | |
| `can` | `{edit, publish, delete, moderate}` | Computed for the caller on every response. `moderate` is always `false`: the posts store does not declare the kit's `moderation` capability. |

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

An attachment the post did not already hold, on create or on a `PATCH` that replaces `attachments`, must also pass the [upload binding](#upload-binding) and the [location check](#location-check). Attachments the post already holds are not checked again, so a post made before these checks keeps its photos. `caps.json` still declares attachments "metadata-only": the post stores the attachment's metadata, never its bytes.

### Upload binding

Each presign writes an `UPLOAD#<ulid>` / `META` item ([Uploads](#uploads)). For each new attachment, `bindUploads` in [`content.js`](../../api/src/content.js) reads that item and refuses with `403 upload_not_owned` unless all of these hold:

- the item exists, its `owner` is the caller and its `purpose` is `post`;
- its `key` is exactly the attachment's path, without the leading `/`;
- it is not attached to another post, and, while unattached, its `ttl` is still in the future (24 hours from the presign).

The attachment's `mime` must equal the item's `contentType`, and the stored object's `Content-Type` must too, otherwise `400 upload_missing`. The same upload twice in one post is `422 validation`.

The post write then attaches each upload in the same transaction: `SET attached = <post id> REMOVE ttl`, on the condition that the owner and purpose are unchanged and the upload is still unattached (or already attached to this post). If another write took the upload between the read and the transaction, the whole write is cancelled and the answer is `403 upload_not_owned`; nothing is stored. An attached upload has no `ttl`, so it is never expired. A post that is deleted does not release its uploads.

### Location check

`checkLocation(bucket, key)` in [`upload-guard.js`](../../api/src/upload-guard.js) runs on every new attachment of a post or a comment ([Comment photos](#comment-photos)), after the binding checks and before the write. It reads the object with `GetObject` and `Range: bytes=0-262143`, so the first 256 KiB is inspected. A WebP whose data runs past that read is read a second time with `Range: bytes=-262144`, because its `EXIF` and `XMP ` chunks follow the image data. The object's size comes from the first read's `Content-Range`, or from the RIFF size when S3 gives none. The check refuses `400 photo_has_location` when the bytes carry any of:

| Metadata | Where it is looked for | Counts as a location when |
| --- | --- | --- |
| EXIF GPS (IFD0 tag `0x8825`) | A JPEG APP1 `Exif` segment, a PNG `eXIf` chunk, a WebP `EXIF` chunk, and any other `Exif\0\0` TIFF header in the bytes (where HEIC keeps it) | `GPSLatitude`, `GPSLongitude`, `GPSDestLatitude` or `GPSDestLongitude` has a non-zero value. A GPS IFD that is present but cannot be read counts too. |
| XMP | Anywhere in the bytes, plus zlib-compressed PNG `iTXt` | A non-empty `exif:GPS*` property other than `GPSVersionID`, `photoshop:City`, `photoshop:State` or `Iptc4xmpCore:Location`, in attribute or element form, under any prefix bound to those namespaces |
| IPTC IIM | A JPEG APP13 Photoshop block, resource `0x0404` | A non-empty City (2:90), Sub-location (2:92) or Province/State (2:95) |

- A missing object (S3 answers `403 AccessDenied` for a missing key, because the role has no `s3:ListBucket`), `404`, `416` or an empty object is `400 upload_missing`. Any other S3 error is `500 internal`.
- The refusal names nothing that was found, and nothing is logged.
- In a WebP read twice, the end of the file is scanned without its chunk boundaries: every `EXIF` and `XMP ` chunk header whose length fits is tried, then the scans that work in any container. If the VP8X flags say the file has an `EXIF` or `XMP ` chunk and neither read holds one whole, the photo is refused. A WebP whose metadata sits in the middle of a large file and whose flags do not announce it is not caught.
- Metadata after the first 256 KiB of a JPEG, PNG or HEIC file is not seen. JPEG and PNG keep their metadata at the front. A HEIC file may store its EXIF item later in the file, and that is a known gap.
- The work is bounded, because any member can upload. Every scan is linear in the bytes read. Compressed XMP inflates to at most 1 MiB in all (`XMP_MAX_INFLATED`), and a truncated stream is scanned as far as it goes. A file that would need more is refused as if it carried a location (fail closed): more compressed XMP than that, more than 256 location properties in one XMP text (`XMP_MAX_PROPERTIES`), a location property whose value or closing tag is not within 64 KiB of its name (`XMP_VALUE_WINDOW`), or more than 16 `Exif\0\0` headers or trailing WebP `EXIF` chunks (`MAX_EXIF_HEADERS`). No camera writes any of these.
- The handler wires the check only when it has an S3 client (`deps.s3`, the API's own client in `index.js`). Without one, a new attachment is `503 unavailable`.
- The role's `UploadReads` statement grants the `s3:GetObject` it needs ([Environment](#environment)).

The browser is meant to remove location data before the upload, so this check is the server's backstop. The post composer does not yet re-encode photos (the `hfy-comment-photos-ui` normalization, behind `commentPhotosV1`), so a phone photo that carries GPS data is refused until it does.

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
- Create and `PATCH` run the [contact-information guard](#contact-information-guard) before any write.
- `PATCH` replaces `body` and `attachments` when given, sets `title` and `subject` when given, and removes them when they are `null`. The body rule applies to the post the patch leaves: emptying a photo post's body is accepted, and removing the last attachment of a post whose body is blank is `422` "body is required". It always refreshes `updated_at` and writes an audit item, even when nothing else changed. Removing `subject` also deletes the post's `IDX#SUBJECT` item.
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
| Profile links, first write | The `PLINKS#` item does not exist yet |
| Profile links, later write | The stored `version` equals the body's `version` |

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

`{id, threadId, parentId?, author: {id, label}, body, attachments?, created_at, edited_at?, can: {edit, delete, react}}`

- `body` is a required string on create and edit. A missing or non-string `body` is `422 validation` "body is required", with or without photos, so an edit that leaves `body` out never empties a comment. It is trimmed and may be at most 1000 characters after trimming. It may be empty only while the comment holds a photo; otherwise an empty body is `422`. The trimmed text is stored.
- `attachments` appears only on a comment with photos ([Comment photos](#comment-photos)).
- `threadId` is the subject.
- `author.label` is the caller's display label, never an email address ([Session verification](#session-verification)).

### Listing

`GET /comments?subject=...` returns:

```json
{ "thread": { "id": "<subject>", "topic": "default", "comments": [], "reactions": {}, "cursor": "<next>" }, "cursor": "<next>" }
```

- Comments are oldest first, by id, unless `order=desc` (newest first); a cursor encodes the order that issued it. `limit` defaults to 50 and is clamped to 1 through 200. A `limit` that is not a number is not clamped: it becomes `NaN` and is sent as the DynamoDB query's `Limit`. If the query succeeds, `comments` is empty and there is no cursor. If DynamoDB rejects the value, the response is `500 internal`.
- `cursor` is the base64url encoding of `a:<id>` (oldest first) or `d:<id>` (newest first), where `<id>` is the last comment id on the page. It appears, both inside `thread` and at the top level, only when more comments remain. A cursor works only with the order that issued it. A bare comment id, the cursor issued before `order` existed, is still accepted as an oldest-first cursor. Anything else, including a cursor from the other order, is `400 cursor_invalid`.
- `reactions` maps a target to its reactions, oldest first. Targets are `comment:<id>` for the comments on the page, plus `root`. No route creates `root` reactions. A reaction is `{emoji, by, created_at}`.

### Create, edit, delete

- **Create.** A `parentId`, if given, must name a comment in the same thread, otherwise `404`. Any comment can be a parent, so replies can nest. Returns `201`.
- **Edit.** Author only. If the trimmed text equals the stored body and the photos are unchanged, the comment is returned unchanged with no write. Otherwise the body is replaced and `edited_at` is set. An edit can remove photos or change their `alt`, never add one ([Comment photos](#comment-photos)).
- Create and edit run the [contact-information guard](#contact-information-guard) on `body` as sent and on every photo `alt`, before the unchanged-body shortcut and before any write.
- **Delete.** Author or admin. Returns `204`. The comment and every reaction on it are deleted in one transaction with the audit item. Replies are not deleted and keep their `parentId`. The same transaction revokes the comment's credit, if it has one: its event delete and five counter updates ([Contributions ledger](#contributions-ledger)). A DynamoDB transaction holds at most 100 actions, so a credited comment with more than 92 reactions cannot be deleted, nor a comment from before the ledger (which has no event) with more than 98. Such a delete is `500 server` and changes nothing. See [Permissions](#permissions) for `reason`.
- A create, edit or delete transaction cancelled by a failed condition, such as an edit that races another edit or a delete, is `409 conflict` ("comment changed concurrently"). One that stays cancelled by `TransactionConflict` after its retries is `503 busy`. Any other store failure is `500 server`.
- On a `post:<ulid>` thread, list, create, edit and react first check that the caller can see the post ([Subjects](#subjects)).

### Reactions

- `emoji` must be 1 to 32 UTF-16 code units made only of emoji code points (pictographs, regional indicators, keycaps, zero-width joiners, variation selectors, skin-tone modifiers, tag characters). Otherwise `422`.
- The comment must exist, otherwise `404`. Reacting to your own comment is `403 self_react`.
- Each member has at most one reaction per comment, stored at `R#comment:<id>#<member id>`. Sending the emoji you already have removes it and returns `{removed: true}`. Sending a different emoji, or the first one, stores it, replacing any earlier one, and returns `{removed: false, reaction}`. Both return `200`.
- The route always targets `comment:<id>`. `react` in `comments.js` also accepts the target `root`, returns `404 not_found` for an `attachment:` target and `422 validation` for any other target, but no route reaches any of these.
- Reactions are single `PutItem` and `DeleteItem` calls, not transactions, and are not audited.

## Record follows

`api/src/subscriptions.js` (HFY-TSK-254, BRD2 D2-16, R-12) stores one `RSUB#<principal>` / `REC#person:<gramps_id>` item per follow, with `GSI1PK` `RECSUB#person:<gramps_id>` and `GSI1SK` the principal. The same item answers "my follows" (a Query on the partition) and fan-out (one GSI1 Query per changed subject, `queryFollowers`). Follows are explicit, are not audited and never tell the followed person. The routes are dark behind `recordSubsV1` (404 for everyone outside the `uat` group). `subscriptions.put` checks that `person/<id>.json` exists with the same S3 read the label resolver uses (`createPersonExists`); an absent record is `404`, a failed read is `503`.

`notifier.onRecordChanged(changes, { silent, import, seed })` is called only by the render-outbox consumer (`hfy-record-change-fanout`). It sends nothing when `silent`, `import` or `seed` is `true`; the consumer passes `seed` from `SYNC#SESSION.seed`. The owner gets `record_updated_mine` only when a member and not the actor. Followers (not the actor, not the owner) get `record_updated_followed`, grouped by `rec:<subject>` so a repeat update coalesces; a follower with more than 3 pages in one call gets one `records_updated_followed_digest`. A non-silent call with more than 50 distinct subjects is never refused: every follower gets one digest and every member owner one `record_updated_mine`.

## Profile links

[`links.js`](../../api/src/links.js) stores each member's links to their own profiles elsewhere (HFY-TSK-193; HFY-PLN-002 surfaces.md 6.3, R-16 and R-17). Both routes are behind `requireFeature("profileLinks")`, so they answer `404 not_found` while the flag is not `true`, except to a `uat` member ([Feature gate](#feature-gate)). Neither route is an MCP tool.

### Links object

`GET /people/:id/links` returns `{links, version, can: {edit}}`. `PUT /people/:id/links` returns `{links, version}`.

| Field | Value |
| --- | --- |
| `links` | An object keyed by platform. `facebook`, `instagram`, `snapchat`, `tiktok`, `linktree` and `linkedin` each hold `{url, handle}`, and `website` holds `{url, host}`. `url` is the canonical URL the validator produced. A platform with no link is absent, so a person with none has `{}`. |
| `version` | An integer: `0` before the first write, then one more after each write that changes something. |
| `can.edit` | `true` only when the caller's member id is `:id`. It is `false` for an admin on someone else's page, although the admin may clear links there. |

- `:id` is a gramps id matching `^[A-Za-z0-9_-]{1,64}$` (`LINKS_ID_RE`). Any other value is `400 validation` ("invalid person id").
- A well-formed id with no stored item reads as `{links: {}, version: 0}`. The API does not check that the person exists.
- The read is strongly consistent, so a member sees their own write at once.

### Writing links

`PUT /people/:id/links` takes `{links: {<platform>: <string or null>}, version}`, where `version` is the one the client last read. The checks run in this order, and the first that fails decides the response:

1. The caller is neither the owner (their member id is `:id`) nor an admin: `403 forbidden`, before the body is looked at.
2. `links` is not an object, or `version` is not a non-negative integer: `400 validation`.
3. An admin who is not the owner gives any platform a value other than `null` or a blank string: `403 forbidden` ("an admin can only clear links"). An admin who owns the page has the owner's rights.
4. Every field goes through `validateLinks` in [`shared/profile-links.mjs`](../../shared/profile-links.mjs), the one validator for the API and the browser (surfaces.md 6.2). A failure is `422 validation`, and `details.fields` lists each failed field as `{field, code, suggest?, message?}`. A value of a known platform that is not a string fails as `invalid_url` before the validator runs. Nothing is written.
5. The body's `version` differs from the stored one (`0` when there is no item): `409 conflict`, with the stored `{links, version, updatedAt?}` in `details.current`.

```json
{ "error": "validation", "message": "some links are not valid", "details": { "fields": [ { "field": "website", "code": "wrong_platform", "suggest": "instagram" } ] } }
```

The field codes are the validator's `ERROR_CODES`: `invalid_url`, `scheme_not_allowed`, `wrong_platform` (with `suggest`, the field the link belongs in), `not_a_profile`, `short_link`, `contact_channel`, `contact_info`, `too_long` and `invalid_handle`, plus `unknown_platform` for a key that is not one of the seven platforms. A legacy `linkedin.com/pub/` address is `not_a_profile` with a `message` telling the member to copy their `/in/` address.

After the checks:

- A platform the body does not name keeps its link. `null` or a blank string removes one.
- A body that changes nothing, such as an empty `links` or clears of platforms that are not set, returns `200` with the stored links and writes nothing: no version bump and no audit item.
- Any other body writes the `PLINKS#` item, with `version` one higher, and its audit item in one `TransactWriteItems` call, conditioned as described in [Concurrent writes](#concurrent-writes). The response is the new `{links, version}`.
- A transaction cancelled by its condition, because a concurrent write won, is `409 conflict` with the winner's links in `details.current`. One that stays cancelled by `TransactionConflict` after its retries is `503 busy`, and any other cancellation is `503 unavailable`. A store failure that is not a cancellation is `500 internal`.

**R-18.** Profile links do not go through `guard.js`. The validator applies R-18 itself: every field refuses contact channels (`contact_channel`), and handles, URL paths, queries and fragments are scanned with the shared detector's `scanText` (`contact_info`). The hit is reported only as a field code, never as the matched text. The website field also refuses every host of the six platforms (R-17).

## Contact-information guard

R-18 (HFY-PLN-002 BRD2 section 5.2): personal contact information is never stored. [`guard.js`](../../api/src/guard.js) runs the shared detector, [`shared/privacy-guard.mjs`](../../shared/privacy-guard.mjs) (`rejectContactInfo`), on every free-text field of today's member write paths:

| Write | Fields | Pointers |
| --- | --- | --- |
| Post create | `body`, `title`, every attachment `alt` | `/body`, `/title`, `/attachments/<i>/alt` |
| Post `PATCH` | The fields the request sends: `body`; `title` when it is a string; every `alt` when `attachments` is sent | The same |
| Comment create and edit | `body`, as sent (before trimming); every attachment `alt` when `attachments` is sent | `/body`, `/attachments/<i>/alt` |

The MCP tools `hfy_posts_create` and `hfy_comments_create` run these same route handlers through `handler.invoke`, so they are guarded too.

A refusal is `422` and stores nothing:

```json
{ "error": "contact_info", "message": "this looks like a phone number or street address. we don't keep those on the site, so please remove it to continue.", "errors": [ { "pointer": "/body", "kind": "phone", "span": [11, 19] } ] }
```

- `errors` lists every hit across the fields: its JSON pointer, its `kind` (`phone`, `email`, `street_address`, `po_box`, `contact_url` or `dob_heuristic`) and its `span`, `[start, end)` in UTF-16 code units of the field as sent. The matched text is never in the response.
- `error` is `dob_not_allowed`, with the message "we only keep the birth year on the site.", only when every hit is `dob_heuristic`. Any contact hit makes it `contact_info`.
- An MCP tool call gets the message as its tool error text.
- There is no override. The same text is refused until the member removes the hit.

**The DOB switch.** `dob_heuristic` hits are refused only when `HFY_GUARD_DOB` is `on` (stack parameter `GuardDob`, default `off`; [Environment](#environment)). Off, the guard scans the contact kinds only, so a birthday mention is stored. The switch waits for io's answer to Q2-17 line 5 of HFY-PLN-002. Contact kinds are refused whatever its value.

**Logging.** Each refusal logs one line, `privacy_guard` with `{surface, op, counts}`, where `surface` is `posts` or `comments`, `op` is `create` or `update`, and `counts` is the number of hits per code (`{"contact_info": 2}`). The line never holds text, offsets, pointers or ids.

**The composers.** The post composer and the comment composer run the same detector in the browser before sending ([Front end](front-end.md)). That pre-check is for the member's benefit; the API's `422` is the rule.

**Existing posts and comments.** [`api/scripts/scan-contact-info.mjs`](../../api/scripts/scan-contact-info.mjs) is a one-off, read-only scan of what the table already holds. It reads the `GSI1` partitions `POSTS` and `COMMENTS` with `Query` only, runs every kind of the detector (the DOB heuristic included) over the guarded fields, and prints one JSON object of counts: items scanned, items with a hit, and hits per kind. It prints no text, ids, keys or offsets, and it writes nothing. Run it from `api/` after `npm ci`, with a read-only AWS profile:

```sh
AWS_PROFILE=<read-only-profile> node scripts/scan-contact-info.mjs --table hfy-app --region us-west-2
```

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

### Profile links

From `createLinks` in [`links.js`](../../api/src/links.js). The owner is the member whose id is the route's `:id`.

| Action | Owner | Admin (not the owner) | Other member |
| --- | --- | --- | --- |
| Read | yes | yes | yes |
| Set a link | yes | no (`403`) | no (`403`) |
| Clear a link | yes | yes | no (`403`) |
| `can.edit` | `true` | `false` | `false` |

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

The keys of every item (`PK`, `SK`, the `GSI1` keys and `ttl`) are listed once, in [System architecture: Item layout](architecture.md#item-layout). The API writes post items, with their author and subject index items ([`content.js`](../../api/src/content.js)), comment and reaction items ([`comments.js`](../../api/src/comments.js)), profile links items ([`links.js`](../../api/src/links.js)), audit items ([`txn.js`](../../api/src/txn.js)), contribution events and counters ([`contrib.js`](../../api/src/contrib.js)), and, through `@io-kit/notify`, push subscription and notification preference items.

What the items hold:

- All three post items carry `entity: "post"` and the full post under `post`, so a listing needs no second read.
- Comment items carry `entity: "comment"` and `comment`.
- Reaction items carry `entity: "reaction"`, `target` and `reaction`. There is one per member per target, and `target` is `root` or `comment:<id>`.
- Profile links items (`PLINKS#<gramps-id>` / `META`), one per person, carry `entity: "plinks"`, `links` (as in [Links object](#links-object)), `version`, `updatedAt` and `updatedBy` (the member id of the last writer). A person whose links were never written has no item.
- Audit items are listed under [Audit records](#audit-records).
- Upload binding items (`UPLOAD#<ulid>` / `META`) carry `entity: "upload"`, `owner` (the uploader's member id), `purpose` (`post` or `comment`), `key`, `contentType`, `size`, `created_at`, and `ttl` until a post or comment of the same purpose attaches the upload, then `attached` (the post or comment id) instead of `ttl`. See [Upload binding](#upload-binding) and [Comment photos](#comment-photos).
- Contribution events and counters are listed under [Contributions ledger](#contributions-ledger). A credited post or comment carries `contrib: { id }`, the id of its event, on every stored copy.

Code note: [`keys.js`](../../api/src/keys.js) exports `commentKeys` (`COMMENT#<id>` / `META`) and `gsiThread`. Neither is used, because comments live under `THREAD#<subject>` ([item layout](architecture.md#item-layout)).

## Contributions ledger

[`contrib.js`](../../api/src/contrib.js) credits members for what they add, and takes the credit back when it is deleted. Each credit is an event under `CONTRIB#<principal>` plus five counter updates, and they commit in the same `TransactWriteItems` call as the write that earned them ([item layout](architecture.md#item-layout)). The ledger is written whatever the `contribV1` flag says; the flag only gates the routes that read it.

| Write | Ledger change |
| --- | --- |
| Comment create | Credit 1 plus 1 per photo (`kind: comment`; [Comment photos](#comment-photos)). The stored comment gets `contrib: { id }`. A comment with 2 photos adds 3. |
| Comment delete, by its author or an admin | Revoke the event of the comment's author. |
| Post created published, or a draft's first publish | Credit 1 plus 1 per image attachment (`kind: post`), once per post. All three post items get `contrib: { id }`. A post with 3 photos adds 4. |
| Withdraw, or return to draft | The event is hidden. No count changes. |
| Republish | The event is shown again. No count changes. |
| Post delete, by its author or an admin | Revoke the event of the post's author. |
| Post delete, for each comment removed with the post | Revoke each comment's event. The revokes of one transaction are merged, so 30 comments by one author in one month are one decrement per counter key. |

Not counted: edits of posts and comments (so photos added to a published post by a later edit earn nothing, and a photo removed from a comment by an edit keeps its credit: the photo credit is fixed at first publish, and a delete returns exactly what was credited), reactions, drafts, and desktop pushes. A comment made through an MCP tool is credited like any other and its event carries `via: "mcp"`; HTTP calls carry `via: "ui"`. An MCP post is always a draft, so it earns nothing until a person publishes it. A write that the R-18 guard or the upload binding refuses stores nothing, so it earns nothing: the guard runs before the transaction, and the upload bindings commit in the same transaction as the credit.

An event is `{ entity: "contrib", id, kind, actor: { id, label }, at, weight, photos, via, ref: { type, id, thread? }, subject?, hidden? }`. It copies no body text. `weight` is what the event adds to `n`: 1 for the kind plus `photos`. The counter rows hold `n`, `n_<kind>` for `post`, `comment`, `proposal_accepted`, `self_edit`, `tag` and `photo_to_record`, `n_photo`, and on `TOTAL` rows `first_at`. Readers clamp a negative value to 0, because revoking a credit whose `D#` row has already expired leaves a negative row that expires within days.

The builders are `contribOps`, `revokeOps`, `hideOps` and `mergeOps`. `contribOps` yields six writes for one credit: the event Put and the five counter updates. The caller adds the seventh, the `contrib: { id }` link on the item it writes, and a `self_edit` adds a daily `CAP#` marker Put. They return `{ puts, deletes, updates, checks }` fragments that a caller merges into its own `transact()` call. Credits for proposals, self-edits, tags and photo graduation are added by the code that owns those writes, through the same builders.

A withdraw or republish hides or shows the event only if it exists, so a post whose event is missing still changes visibility; the backfill repairs that orphan. If a comment's author deletes it while a thread purge is running, the purge re-reads its events and commits the batch once more, so the revoke happens once. Content written before the ledger has no events. [Backfill the contributions ledger](../how-to/backfill-the-contributions-ledger.md) credits it and rebuilds the counters.

## Contributions read API

[`contrib-read.js`](../../api/src/contrib-read.js) reads what the [ledger](#contributions-ledger) writes (HFY-TSK-256, BRD2 D2-17). The three routes are dark behind `requireFeature("contribV1")`: `404` for everyone, signed in or not, until the flag is on or the caller is in the `uat` group. `contributions.stats` and `contributions.site` share `GET /contributions/stats`; a route's `when(query)` member, which `matchRoute` reads, sends a request with `?author=` to the first and one without to the second.

### List

`GET /contributions?author=<gramps_id>&cursor=&limit=` queries `CONTRIB#<author>` for `E#` items, newest first, and returns `{items, cursor}`. `author` is required (`400 validation` if missing or not a gramps id); `limit` is a whole number from 1 to 50 (default 10, else `400 validation`); a cursor that this route did not issue is `400 cursor_invalid`. An unknown author gives `{items: [], cursor: null}`.

A row is `{id, kind, at, weight, photos, ref: {type, id, thread?}, subject?, href, hidden?}`. It carries no body text, no actor and no origin. `cursor` is opaque and `null` at the end. A page is filled across events the viewer cannot see: the route reads up to five pages of events to find `limit` visible ones, and hands back a cursor to continue when it gives up. `items.length < limit` therefore does not mean the end while `cursor` is not `null`: a client keeps paging until `cursor` is `null`.

Who sees which event:

| Event | Shown to |
| --- | --- |
| `hidden` (a withdrawn post, a moderated item) | The author and admins, with `hidden: true`. Nobody else. |
| A post event, or a comment on a `post:<id>` thread | A viewer for whom `canView` of the current post is true (the author, admins, and everyone while it is published and not hidden by moderation). A withdrawn or deleted post hides the event, and so does a post that could not be read. |
| A comment on a `proposal:<ulid>` thread | The proposal's visibility set only: the proposer, admins and the owners of the targeted pages. A third member gets nothing, and so does anyone when the proposal is gone. |
| Anything else (a person-thread comment, a record, tag, accepted proposal or graduated photo) | Every signed-in member. A `proposal` ref event (`proposal_accepted`) is written only when a proposal is accepted, and an accepted proposal is public, so it needs no proposal check. Person pages are not per-viewer in the design, so a person-thread or record event needs no target check either. |

The checks read the current posts and proposals with `BatchGet` in chunks of at most 20 distinct keys (`POST#<id>/META`, `PROP#<ulid>/META`). Unprocessed keys are retried once; an event whose item is still unread is omitted, so the check fails closed. A page with nothing to check makes no `BatchGet`. The default proposal rule is `proposalVisible`: the proposer, the member whose page the proposal is about (`subject.gramps_id`), the members listed in `owners[]` if the proposal store records them, and admins. `proposal-store-api` (or `proposal-decision-api`) has a hard dependency here: it must write `owners[]` for every targeted page, or replace the rule through `createContribReader({proposalVisible})`. Until then the circle is narrower than the design and fails closed.

`href` is computed by the server:

| Ref | `href` |
| --- | --- |
| `post` | `/posts/?id=<post id>` |
| `comment` on a person thread | `/person/?id=<gramps id>#comment-<ulid>` |
| `comment` on a post thread | `/posts/?id=<post id>#comment-<ulid>` |
| `comment` on a proposal thread | `/person/?id=<gramps id of the page the proposal is about>#comment-<ulid>` |
| `proposal`, `record`, `tag` | `/person/?id=<subject>` |
| `media` | `/person/?id=<subject>#photos` |

`href` is `null` when the page cannot be named.

### Stats

`GET /contributions/stats?author=<gramps_id>` reads `CSTAT#person:<author>/TOTAL` and returns `{author, total, by_kind: {post, comment, photo, self_edit, proposal_accepted, tag, photo_to_record}, first_at?}`. Every value is clamped at 0, and an unknown author reads as zeros, not `404`. Hidden events still count (hide and withdraw change no counter), so a withdrawn or moderated contribution still raises the total and `by_kind` that other members see. Only a count leaks, never content; a test pins this.

### Site total and the feed line

`GET /contributions/stats` (no `author`) returns `{total, line, computed_at}`. `line` is `{x, y, unit, window_days, text}`, for example `12 contributions in the past 3 days`, or `null` when no window reaches 3 (the page then shows its no-number line).

The line is cached in `CSTAT#site/LINE`. A read serves the cached row while it is under one hour old (`LINE_TTL_MS`), reading nothing more than the total and the row. Past an hour it reads the `D#` day rows of the last 366 days (and the `M#` month rows when the site is at least 730 days old), recomputes with `pickLine`, and writes the row back with a 2 hour `ttl`. A failed cache write is logged and the computed line is still served. The clock is `deps.now`, so tests inject it.

`pickLine(buckets, today, firstAt, prev?)` is pure:

1. **Windows**, shortest first: 1 to 6 days, 7, 14 and 21 days (weeks), 30, 60, 90 and 180 days (months), then 365 days times 1 to 10 (years). A window is eligible only when the site's history is at least as long, so a young site never claims a long span. Windows over 400 days sum `M#` month buckets (12 per year, the partial current month included), so `window_days` is approximate for them. The years stop at 10 (`MAX_YEARS`); the design sets no upper bound. Concurrent cold requests each recompute and write the row, which is harmless.
2. **Hot**: the shortest eligible window of 30 days or fewer with `X >= 5` and `X >= P`, where `X` is the sum of the window's buckets, today included, and `P` the same number of buckets before it.
3. **Volume**: otherwise the shortest eligible window with `X >= 3`.
4. **Null**: otherwise, so a "1 contribution in the past day" line is never produced.
5. **Dwell**: a pick cached earlier on the same UTC day is kept, with its current count, while its window is still eligible with `X >= 3` and the fresh pick is within one candidate step of it.

A negative or non-numeric bucket reads as 0. The golden table is in [`contrib-read.test.js`](../../api/test/contrib-read.test.js).

## Audit records

Every post create, update, visibility change and delete, every comment create, edit and delete, and every profile links write that changes something writes one audit item ([`txn.js`](../../api/src/txn.js), `auditItem`).

| Attribute | Value |
| --- | --- |
| `PK` | `AUDIT#<record id>`: the post id, the comment id, or `plinks:<gramps-id>` for a person's profile links |
| `SK` | `<at>#<ulid>` |
| `GSI1PK`, `GSI1SK` | `AUDIT`, and the same value as `SK` |
| `entity` | `audit` |
| `op` | The operation (below) |
| `id` | The record id |
| `principal` | The caller's member id |
| `at` | ISO 8601 time of the change |
| `before` | The full record before the change, or `null` on create. For profile links, `{links, version}`, which is `{links: {}, version: 0}` on the first write. |
| `after` | The full record after the change, or `null` on delete. For profile links, the new `{links, version}`. |
| `reason` | On an admin's delete of another member's comment, when given; `post deleted` on each comment removed with its post |

| Record | `op` values |
| --- | --- |
| Post | `create`, `update`, `visibility`, `delete` |
| Comment | `create`, `edit`, `delete` |
| Profile links | `links.clear` when the body names platforms only to clear them, `links.update` for any other change |

The data change and its audit item are written in a single `TransactWriteItems` call (`transact` in `txn.js`). Both land or neither does, so a failed write leaves no audit item.

Comments removed with their post are audited too, each in the same transaction as its delete ([Writes](#writes)). Not audited: reactions, notification subscriptions and preferences, uploads, and writes that change nothing (a visibility set to its current value, a comment edit with identical text, a profile links body that changes no link). No route reads audit items. The `GSI1` partition `AUDIT` lists them all in time order.

## Notifications

[`notify.js`](../../api/src/notify.js) defines the types and the fan-out. `@io-kit/notify/server` stores subscriptions and preferences and sends the pushes.

### Types and levels

| Type | Title | Level 0 body | Level 1 body |
| --- | --- | --- | --- |
| `comment_on_my_record` | Harrison Family | someone commented on your page. | {actor} commented on your page. |
| `reply_to_me` | Harrison Family | someone replied to you. | {actor} replied to you. |
| `new_family_post` | Harrison Family | there's a new family post. | {actor} shared a new family post. |
| `mention` | Harrison Family | you were mentioned. | {actor} mentioned you. |

The registry also holds the PLN-002 types. The field whitelist is `actor`, `subject`, `item`, `count`. `new_family_post` and `chat_message` are push-only (`inbox:false`); every other type is stored in the inbox while `inboxV1` is on. `notifyContract()` in `notify.js` is the one source that `hfy-inbox-ui`'s `CATALOG` and the chat routes compare against, and [`notify-producers.test.js`](../../api/test/notify-producers.test.js) pins it.

| Type | Recipients | Producer | Group key |
| --- | --- | --- | --- |
| `comment_on_my_record`, `reply_to_me` | as above | `onComment` | `thread:<t>` |
| `proposal_submitted` | admins except the proposer | `onProposalSubmitted` | `proposals` |
| `proposal_accepted`, `proposal_declined`, `proposal_needs_changes`, `proposal_stale` | the proposer | `onProposalDecided` | none |
| `record_updated_mine` | the record's owner, when a member and not the actor | `onRecordChanged` | `rec:<subject>` |
| `record_updated_followed` | followers, not the actor | `onRecordChanged` | `rec:<subject>` |
| `records_updated_followed_digest` | a follower with more than 3 pages in one call | `onRecordChanged` | `recdigest` |
| `moderation_hidden`, `moderation_request`, `moderation_question`, `moderation_unhidden` | the item's author, not the actor | `onModeration` | none |
| `moderation_resolved` | the admin who asked | `onModeration` | `mod:<target>` |
| `photo_graduated` | the photo's author, not the actor | `onGraduated` | none |
| `chat_message` | the chat service's recipient (push only, no message text) | `notify` | none |

Producers run after a commit and never fail the write. `onRecordChanged` is called only by the render-outbox consumer (`hfy-record-change-fanout`) and takes `silent: true` for imports, seeding and backfills. A producer whose source (`getAdmins`, `listMembers`, `followersOf`) is absent notifies nobody. An admin's note is the inbox `detail` and is never pushed.

The text is `TEMPLATE_REGISTRY` in [`notify.js`](../../api/src/notify.js), written in the design system's family voice: every title is the site name, and the bodies are lowercase and say "page", never "record". The lock-screen preview on `/me/notifications/` (the `CATALOG` in [`islands/src/lib/notify-catalog.js`](../../islands/src/lib/notify-catalog.js)) repeats the same strings word for word. [`notify-catalog.test.mjs`](../../islands/tests/notify-catalog.test.mjs) checks that its types are the registry's, less `chat_message`, which the chat task adds, and that their titles and level 0 and level 1 strings match. [`api.test.js`](../../api/test/api.test.js) and [`producers.test.js`](../../api/test/producers.test.js) check the API's bodies. Pushes carry the text that the deployed `hfy-api` holds, so a change to it reaches members only after an `hfy-api` redeploy ([Packaging and deploy](#packaging-and-deploy)).

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

### Producer notes (HFY-TSK-253)

- The acting admin is excluded from `onProposalDecided` and `onModeration` recipients, so deciding or moderating your own item notifies nobody.
- Callers must validate an admin `note` with the shared contact-information validator (R-18) before calling a producer. The producer only caps `detail` at 1000 characters, and the inbox UI must render `detail` as text, never HTML.
- The decline type is `proposal_declined` (editing.md still says `proposal_rejected`; other domains must use `proposal_declined`).
- Beyond the design table, `many` strings exist for `proposal_submitted`, `record_updated_mine`, `record_updated_followed` and `moderation_resolved`, and `records_updated_followed_digest` has an `inboxText`. `notifyContract()` exposes `many`, `inboxText` and the `groups` templates so a surface that shows the inbox can read them. The CATALOG holds every type but `chat_message` (hfy-inbox-ui, HFY-TSK-185); the chat entry belongs to hfy-chat-api-service-routes.
- `comment_on_my_record` and `reply_to_me` share the group `thread:<t>` (social.md); the kit coalesces by recipient and group, so a recipient who gets both types on one thread sees one item that keeps the first type.
- `onRecordChanged` runs follower lookups 8 at a time and handles at most 500 subjects per call. It has no caller until hfy-record-change-fanout, which must dedupe on `rec:<seq>:<subject>` and pass `silent: true` for seed and import sessions.
- Member principals come from `config/userGrampsID.json`; the API role's `config/*` `s3:GetObject` grant (app-stack.yaml, AdminList statement) covers it. An empty set logs a warning and fails closed.

### Notification routes

These responses come from the kit. Kit errors have the shape `{"error": "<text>"}`, with no `message`.

| Route | Request body | Response | Errors |
| --- | --- | --- | --- |
| `GET /notifications/vapid-public-key` | none | `{public_key}` | |
| `POST /notifications/subscribe` | `{endpoint, keys: {p256dh, auth}, expirationTime?}` | `{ok: true}` | `400 {"error":"invalid subscription"}` |
| `DELETE /notifications/subscribe` | `{endpoint}` | `{ok: true}` | `400 {"error":"endpoint required"}` |
| `GET /notifications/preferences` | none | `{enabled: true, types: {<type>: {enabled, level}}, extra: {}}` | |
| `PUT /notifications/preferences` | `{types: {<type>: {enabled, level}}}`, `enabled` a boolean and `level` 0 or 1 | Same shape as `GET` | `400 {"error":"invalid preferences"}` |
| `GET /notifications/inbox` | none; query `filter` (`unread` or `all`), `cursor`, `limit` | `{items, next_cursor, has_more}` | `400` on a bad `filter`, `cursor` or `limit` |
| `GET /notifications/inbox/unread-count` | none | `{unread}` | |
| `POST /notifications/inbox/read` | `{ids}` (1 to 100 ids) or `{all: true}` | `{updated, unread, ...}` | `400` on an empty or invalid body |

- The three inbox routes exist only when an inbox store is wired, and are 404 outside `uat` while `inboxV1` is off.
- The kit stores an inbox item whether or not the recipient disabled that type in preferences: preferences gate only the push, and the inbox keeps the item for the recipient (ruling P2-R35).
- A subscription is stored with a 90-day `ttl`. Subscribing again refreshes it.
- `PUT` replaces the whole preference record. The kit does not check type names against the registry, so any type name is stored. `GET` lists only the types that are stored.
- The `DELETE` body is read by the kit itself, so it needs no JSON content type.

## Comment photos

hfy-comments-photos-desc-api (BRD2 9.2). Behind `commentPhotosV1` (default off; a dark call is `404 not_found`).

1. `POST /uploads` with `purpose: "comment"` writes `UPLOAD#<ulid>` `{owner, purpose: "comment", key, contentType, ttl 24 h}` and returns `uploads/comments/<ulid>/photo.<ext>`. The name is the server's; a client file name is ignored. HEIC is refused (`400 validation`).
2. `comments.create` takes `attachments`: at most 4 of `{url, mime, width?, height?, alt?}`. `url` is `<MEDIA_PUBLIC_BASE>/uploads/comments/<ulid>/<name>` or the same path relative; `mime` is jpeg, png or webp; `alt` is 500 characters or fewer; `width` and `height` are integers from 1 to 100000. The stored attachment is `{id: <upload ulid>, kind: "image", url: /uploads/comments/<ulid>/<name>, mime, width?, height?, alt?}`.
3. Each photo must be the actor's own upload with purpose `comment`, unexpired and not yet attached, or the write is `403 upload_not_owned`. The API then HEADs the object (it exists, its `ContentType` equals the declared `mime` and the type presigned, and it is at most 10 MB; 2 s timeout, in parallel) and reads the first 256 KiB with `checkLocation`: `400 upload_missing` when HEAD finds no object (S3's `403` or `404`), the type differs or the object is over 10 MB, `400 photo_has_location` when the bytes carry a position or place, and `503 unavailable` when HEAD fails otherwise or takes longer than 2 s. A handler built without an S3 client answers `503 unavailable` to any comment with `attachments`.
4. The comment write attaches each upload in the same transaction (`SET attached = <comment id> REMOVE ttl`, conditional on owner, purpose and not attached), so a binding that changes after the read cancels the write (`403 upload_not_owned`, nothing stored).
5. `body` may be the empty string while the comment holds a photo. It must still be sent: a missing or non-string `body` is `422 validation` "body is required" on create and edit. `body` and every `alt` run the contact-information guard (`422 contact_info`, pointer `/attachments/<n>/alt`).
6. `comments.update` can remove attachments or change an `alt` (matched by `url`, ids kept); an unchanged body and photo list is a no-op with no audit entry. It cannot add a photo: another member's key is `403 upload_not_owned`, anything else `422 validation` on `attachments`. Deleting a comment keeps its objects.

## Uploads

`POST /uploads` returns a presigned S3 PUT for one post photo, or one comment photo with `purpose` `comment` ([`uploads.js`](../../api/src/uploads.js), [`presign.js`](../../api/src/presign.js)). The Lambda never handles the image bytes.

### Request

`{contentType, size, purpose?}`. Each failure is `400 validation`, except `purpose` `comment` while `commentPhotosV1` is closed to the caller, which is `404 not_found` before any other check.

| Field | Rule |
| --- | --- |
| `contentType` | `image/jpeg`, `image/png`, `image/webp` or `image/heic`. For `purpose` `comment`, `image/jpeg`, `image/png` or `image/webp` only (`COMMENT_IMAGE_TYPES`) |
| `size` | Positive integer, in bytes, at most 10 MB (10,485,760) |
| `purpose` | Optional: `post` (the default) or `comment` |

A `filename` field is accepted and ignored. The islands send a fixed `filename: "photo"`, never the file's own name, because the `hfy-api` deployed before the RG-2 change set refuses a presign without one (`400 validation`, "filename is required") and the site goes live on merge, ahead of that API. That API builds the key from the name too, so its keys are `photo.<ext>` as well.

### Object key

The key is `uploads/posts/<ulid>/photo.<ext>` in `MEDIA_BUCKET` (`UPLOAD_PREFIX`, HFY-R58), or `uploads/comments/<ulid>/photo.<ext>` for `purpose` `comment` (`COMMENT_UPLOAD_PREFIX`), where `<ext>` is `jpg`, `png`, `webp` or `heic` for the content type. The server chooses the whole key, so the uploader's file name, which can name a person, never reaches the bucket or a URL. The key is never under `media/`, which the Gramps data sync mirrors with `--delete`.

Uploads made before this rule keep keys built from the uploader's cleaned file name. Posts that already hold them keep them.

### Binding

Before presigning, the API writes the `UPLOAD#<ulid>` / `META` item that binds the upload to its uploader: `owner`, `purpose` (`post` or `comment`), `key`, `contentType`, `size`, `created_at` and a `ttl` 24 hours later, on the condition that the item does not exist yet. If that write fails, the answer is `503 unavailable` and no URL is issued. The purpose decides what may attach the upload: a post, on the terms in [Upload binding](#upload-binding), or a comment, on the terms in [Comment photos](#comment-photos). A post takes only `uploads/posts/` URLs and a comment only `uploads/comments/` URLs (`422 validation` otherwise), and each also requires its own `purpose` on the binding item (`403 upload_not_owned`).

### Response

`201` with:

| Field | Value |
| --- | --- |
| `uploadUrl` | The presigned PUT URL, valid for 300 s |
| `publicUrl` | `MEDIA_PUBLIC_BASE` + `/` + `key` |
| `key` | The object key |
| `headers` | `{"Content-Type": <contentType>}` |
| `expiresIn` | `300` |

The presigner signs `content-type` and `content-length` into the URL (`signableHeaders`), so S3 rejects a PUT whose `Content-Type` differs from the validated image type or whose body is not exactly `size` bytes. Send the returned `headers` exactly. The URL carries no checksum parameters: the S3 client is built with `requestChecksumCalculation: "WHEN_REQUIRED"`, because the SDK default would sign a checksum of an empty body and every real upload would fail with `400 BadDigest`. The API records the binding item and nothing else. The client puts `publicUrl` into the post's or comment's `attachments`. Nothing removes objects that no post or comment references; their binding items expire after 24 hours.

`uploadUrl` points at the bucket's own S3 endpoint (`https://<site-bucket>.s3.<region>.amazonaws.com/...`, in the function's region), never at `<site>`, so the PUT goes straight to S3 and never passes through CloudFront or the private data gate. [`presign.test.js`](../../api/test/presign.test.js) checks the host. `publicUrl` is on `<site>`, and reading it back goes through CloudFront ([Reading photos back](#reading-photos-back)).

### When uploads fail

- The handler returns `503 unavailable` ("uploads are not configured") only when it was built without a presigner. `index.js` always supplies one, and `MEDIA_BUCKET` and `MEDIA_PUBLIC_BASE` have defaults, so the deployed function never returns `503` for missing `MEDIA_*` settings. A wrong bucket shows up later, as a failed PUT.
- The browser's PUT goes straight to S3 on another origin, so it needs the bucket CORS rule in [`site-bucket-cors.json`](../../infrastructure/cloudformation/site-bucket-cors.json): `PUT` from `https://<site>` or `https://www.<site>`, with the `Content-Type` header. The browser sets `Content-Length` itself, outside the preflight, so the rule does not list it, though the URL signs it. The site bucket is not managed by `app-stack.yaml`, so that rule is applied by hand. Without it the browser blocks the PUT. `scripts/infra/check-site-bucket-cors.sh` checks the live rule ([Architecture](architecture.md#site-bucket)).
- The Lambda role may put objects only under `uploads/posts/*` and `uploads/comments/*` in the media bucket (`PostPhotoUploads` and `CommentPhotoUploads` in [`app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml)).
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

**Not built here.** The non-blocking warnings of editing design section 6.2 (a person who already has birth parents, a parent under 13 years older than the child, a possible duplicate person) are deferred to `edit-api-changes`; `warnings` is always `[]`. The [relationship compiler](#relationship-compiler) raises them for the relationship proposals it builds. Erratum to the design text: Death is EventType 13 (Birth is 12), as in Gramps 6.0.6 and the goldens, not 5.

The birth-date precision rule (day and month never stored for a birth) is the guard's, not this module's (`edit-guard-wiring`).

**Goldens.** The expectations in the tests are what Gramps 6.0.6 itself computes, committed in [`api/test/records/fixtures/gramps-semantics.golden.json`](../../api/test/records/fixtures/gramps-semantics.golden.json): 454 synthetic Dates (383 valid Gregorian and Julian, plus the other calendars, slash, new-year, text-only and invalid ones) with Gramps' accept or reject, `sortval` and settled calendar, and 170 birth/death scenarios with the indexes Gramps sets before and after an event-list change and an Event type change. Other workers test against that file. It needs no Gramps to use: `python3 scripts/records/check_gramps_goldens.py` re-derives every Gregorian and Julian `sortval`, validity and index with the standard library alone and checks the file's SHA-256, and `python3 -m unittest discover gramps/tests/unit` runs it in CI. Regenerating the file needs Gramps.app: see [Regenerate the Gramps goldens](../how-to/regenerate-the-gramps-goldens.md).

The tests are [`api/test/records/semantics.node-test.js`](../../api/test/records/semantics.node-test.js), run by `npm test` after vitest, or alone with `node --test test/records/semantics.node-test.js`.

## Relationship compiler

[`api/src/records/relationships.js`](../../api/src/records/relationships.js) turns what a member says about their family into the EditOps that make Gramps' Family and ChildRef objects say it (editing design, section 8; R-24). It is a library: no route, tool or Lambda path calls it yet (HFY-TSK-251), and it ships in the `hfy-api` zip unreachable until `relationship-api` calls it. It imports only the EditOp engine, [`semantics.js`](../../api/src/records/semantics.js) and [`duplicates.js`](../../api/src/records/duplicates.js), so it runs in Node and in a browser.

```
compileRelationship({ intent, get, version?, people?, confirmDistinct?, mode?, mint?, admin?, today?, maxActions? })
  -> { ok: true, alreadyRecorded, destructive, subject, ops, base_versions, read_versions, summary, warnings, duplicates,
       followUps, stats: { ops, created, touched, actions }, preview: { objects, minted, created, touched } }
  -> { ok: false, errors: [{ code, message, ... }] }
```

`intent` is one of the four of editing design section 8.2: `parents`, `children`, `spouse`, `unlink`. A person is `{ ref: "Person:<handle>" }` or `{ new: <stub> }`. `get(key)` reads the stored Persons, Families, Events and Places. `people` is the list of people the viewer may see, as `summarizePerson` makes them, for the duplicate search. `confirmDistinct` is the list of `new:n` stubs the member said are different people. `mode` is `"preview"` (the default) or `"commit"`: a commit always enforces the duplicate gate (an absent `confirmDistinct` counts as `[]`), a preview enforces it only when `confirmDistinct` is given and otherwise only reports the duplicates. `version(key)` gives the stored version of an object: with it, `base_versions` guards every object the ops change (a changed object with no version is a `compile_conflict`) and `read_versions` guards the objects a decision was based on but the ops leave alone (a family with children, an existing Marriage or Divorce event, the people whose birth years were read); the proposal store must check both. `mint` is for the validation pass and tests: the returned `ops` keep their `new:n` temporaries, and the commit mints the real handles. `alreadyRecorded: true` means the tree already says it, with `ops: []` (the API answers 409 `already_recorded`, which is informational). `destructive: true` (unlink) needs the admin's fresh sign-in at approval.

| Rule | How it shows |
| --- | --- |
| **Reuse before create.** A family whose parents are exactly the people chosen is reused, with the ChildRef and the `parent_family_list` entry added on both sides. A parent's single-parent family is reused when one parent is chosen. A person already in the family is skipped; a half-made link (one side only) is completed. | `ops` of kind `add` on the existing Family and Person |
| **Single-parent families.** With two parents chosen and one of them alone in a family, the second takes the empty slot only when that family has no children. When it has children, a new family is made and the result carries a warning: filling the slot would give those children a new parent without anyone saying so. | `set` of the slot with `base: null`; or warning `single_parent_family_has_children` |
| **Slots.** Male goes to `father_handle`, female to `mother_handle`; otherwise the first person chosen goes to `father_handle` (partner1) and the second to `mother_handle` (partner2). A lone parent: a woman is the mother, anyone else the father. A ChildRef's `frel` belongs to the father slot and `mrel` to the mother slot, whoever was chosen first. | `assignSlots`; the new Family's `father_handle` and `mother_handle` |
| **Append.** A new family is appended to each parent's `family_list` and to the child's `parent_family_list`, after the families already there, so the first (main) parents do not change. | `add` ops; the golden scenarios compare the lists |
| **Stubs** (a new person). A Birth Name primary name with one primary surname, the chosen gender, a year-only Birth event when a year was given, a Death event when `living` is `no` and a death year was given, and an **empty `gramps_id`**. Every created object (Person, Family, Event, Place) has an empty `gramps_id`: it is minted at approval from the reserved block (Q2-03, `store-id-policy`) or assigned later by the desktop, and the compiler does not decide it. | `create` ops; `new:1`, `new:2`, ... in the order the stubs appear in the intent |
| **Numbering.** The stubs are `new:1` to `new:k`, which is what `duplicates[].for` and `confirmDistinct` name. Then come each stub's Birth and Death events, a new Place, the Marriage and Divorce events, and last the Family. The `create` ops come first in that order, then the changes to existing objects. | `ops[].obj` |
| **Spouse.** A family of the same pair is reused. Its type changes only when `relType` is given and differs; an omitted `relType` leaves it alone (a divorce year on a married pair keeps it married). Otherwise a childless single-parent family of either person is filled with the other (as `parents` and `children` do; with children in it a new family is made and `single_parent_family_has_children` warns), and failing that a family is created with the type chosen (Unknown when none was). An existing marriage or divorce is never replaced, even when the year differs: it is left with a warning. A year-only Marriage event (role Family, `about` makes the date "about") and a Divorce event when `ended.how` is `divorced`. A marriage or divorce the family already has is left alone with a warning. Widowed adds an `offer_death_year` follow-up when no death is recorded. A new place is limited to the kinds a member may name (not Street, Building or Number). | `create` Events; `followUps`; warnings `marriage_already_recorded`, `divorce_already_recorded` |
| **Unlink.** A child: the ChildRef and the `parent_family_list` entry are removed. A partner: the slot is cleared and the family leaves the person's `family_list`. The family itself is never deleted; when it is left with no parents the result warns. Someone who is not linked is already unlinked. | `remove` and `set` ops with `base`; `destructive`; warning `family_has_no_parents` |
| **Limits.** More than 10 children: `too_many_children`. An approval transaction of more than 100 actions: `proposal_too_large` (decision D2-30). | errors `too_many_children`, `proposal_too_large` |
| **Checks.** The compiled ops are applied to the stored objects and `checkSemantics` runs on the result: two-sided links, family sense, dates (a member cannot enter a stub year before 1000 or in the future), and the ancestry rule. An intent that would make someone their own ancestor fails with `cycle` and returns no ops. Errors on a created object name its `new:n`. | error `cycle` and the `checkSemantics` codes |
| **Warnings** (never block). A child who already has birth parents; a parent under 13 years older than the child (Gramps' `min-generation-years`). | `child_has_birth_parents`, `parent_too_young` |

Other errors: `bad_intent` (the request is malformed, a person is chosen twice, a parent is their own child, an unknown relation word), `unknown_object` (a reference that does not exist), `bad_stub` (a stub with no name, a bad gender, a fractional year, or a death year before the birth year) and `unconfirmed_duplicate`. No error message repeats what the member typed.

**The approval transaction.** `approvalActionCount({ touched, created, extra? })` counts what approving the proposal writes: 3 for the batch (head, receipt, audit), 2 for each object (head and log), 1 more for each created object (the guard that mints its id), 3 for the proposal (META, the by-proposer copy, the audit) and 1 for each object's per-record copy (sync design 4.1, editing design 5.2). `extra` is for items the caller adds. `stats.actions` is the count for this compile and `maxActions` (default 100) the budget. The caps of a proposal document itself (64 KB, 50 ops, 10 new objects) belong to the proposal store, which reads `stats`.

**Duplicates.** [`duplicates.js`](../../api/src/records/duplicates.js) looks for people who may already be the stub: names compared case-folded and accent-stripped, the primary name and the alternate (married) names, one slip in a longer name, an initial or a short form that starts the given name, and a gender or a birth year (more than 3 years apart) that rules a person out. A short form of a given name that only starts the other ("Ann" for "Anna", "Anneliese") counts only with an exact surname, and a part that is empty on both sides adds no weight. It returns `[{ for: "new:1", candidates: [{ handle, displayName, lifespan }] }]` and nothing else about a person. It knows only the people it is handed, so the caller passes the viewer's redacted view: a candidate's years are never more than the viewer can already read.

**Not built here.** The R-18/R-19 guard over the stub fields and the note runs in the record API on the whole resulting state (`edit-guard-wiring`), the proposal document caps are the proposal store's, and the routes are `relationship-api`'s. `relationship-api` must: call `checkObjects()` on the compiled state before any proposal write; pass `mode: "commit"` on every write; build `people` from the viewer-redacted record view; and either use the shared `assertTxnSize` cost model or pin it to `approvalActionCount` with a test.

**Goldens.** The expectations in the tests are what Gramps 6.0.6 itself leaves in a database: [`api/test/records/fixtures/gramps-relationships.golden.json`](../../api/test/records/fixtures/gramps-relationships.golden.json) holds a synthetic tree and a set of scenarios, each the steps Gramps' editors perform through its DB API (`Family()`, `ChildRef()`, `Person.add_family_handle`, `commit_family`, `set_birth_death_index`), read back. They cover reusing a two-parent family, a single-parent family with and without children, never filling a slot of a family that has children, children with an unknown other parent, a spouse married then divorced, unlinking a child and a partner, stubs, places and relations. Other workers test against that file. It needs no Gramps to use: `python3 scripts/records/check_relationship_goldens.py` verifies it with the standard library alone and `python3 -m unittest discover gramps/tests/unit` runs that check in CI. Regenerating the file needs Gramps.app: see [Regenerate the Gramps goldens](../how-to/regenerate-the-gramps-goldens.md).

The tests are [`api/test/records/relationships.node-test.js`](../../api/test/records/relationships.node-test.js), run by `npm test` after vitest, or alone with `node --test test/records/relationships.node-test.js`.

## The cloud record store

[`api/src/sync/`](../../api/src/sync/) holds the cloud record store and its one write path, `applyBatch()` (HFY-TSK-243). The desktop push routes call it (`POST /api/sync/batches`, [The push routes](#the-push-routes)), with origin `desktop`, or `seed` inside the seed session; the edit and proposal routes will call it with their own origins. The design is in the HFY-PLN-002 BRD (section 4, the key registry).

### Items

| Item | PK | SK | GSI1PK / GSI1SK | Holds |
| --- | --- | --- | --- | --- |
| Record head | `REC#<Class>#<handle>` | `HEAD` | `RECS#<Class>` / `<gramps_id>#<handle>` (a Tag: `#<handle>`) | `version`, `seq`, `deleted`, `obj_json` (the canonical redacted Gramps object without `change`, written by `shared/canonical.mjs`, null for a tombstone), `hash` (its sha256), `origin`, `updated_by`, `updated_at` |
| Change log entry | `SYNC#LOG` | the seq, 12 digits | `RECHIST#<Class>#<handle>` / the version, 8 digits | One entry per op: `op`, `version`, `base_version`, `obj_json`, `batch_id`, `principal`, `origin`, `on_behalf_of` |
| Sequence head | `SYNC#HEAD` | `META` | - | `seq`, `live_heads` (the count of live heads, kept by every batch), `writes_enabled`, `seeded`, `merges_enabled`, `tree_id` |
| Batch receipt | `SYNC#BATCH#<batch_id>` | `META` | `SYNCBATCH` / `<at>#<batch_id>` | `request_hash`, `seq_from`, `seq_to`, `results`. Kept for ever |
| gramps_id guard | `GID#<Class>#<gramps_id>` | `META` | - | `handle`, and for a retired id `retired: true` and `reason` |
| ID alias | `IDALIAS#<Class>#<old_gramps_id>` | `META` | - | `handle`, `current_gramps_id`, `reason` (`merge` or `renumber`). Written for Person ids only |
| Destructive budget | `SYNC#BUDGET#<yyyymmddhh>` | `META` | - | `count` of delete and withdraw ops committed in that UTC hour, and a `ttl` three days out. Written only by a batch that has one |
| Batch audit | `AUDIT#records:<batch_id>` | `<at>#<uid>` | `AUDIT` / same as SK | `op: "records.batch"`, `before` and `after` lists of `{class, handle, version}` |

`applyBatch` creates none of `SYNC#HEAD`'s settings: the bind and seed routes own `writes_enabled`, `seeded`, `merges_enabled` and `tree_id`. It owns `seq` and `live_heads`. Only `SYNC#HEAD`, `REC#`, `SYNC#LOG`, `SYNC#BATCH#`, `GID#`, `IDALIAS#`, `SYNC#BUDGET#` and the audit item are its own; counters, proposal state and notifications belong to its callers.

### One call, one transaction

`applyBatch(ctx, {principal, origin, onBehalfOf?, idempotencyKey, ops, extra?})` writes a batch of at most 24 ops in one `TransactWriteItems` of at most 100 actions (`assertTxnSize`). `origin` is one of `desktop`, `seed`, `self`, `admin`, `proposal`, `graduation`, `moderation` or `tag`. An op is `create`, `update`, `delete`, `withdraw` or `marker`. The caller sends whole redacted objects with a `base_version`; the server never merges. The repository's validator always runs, because the version-conflict body returns stored objects and is safe only after it has run: a call cannot drop it by passing a partial `ctx.validate`. A plain `ctx.validate` function is an extra layer after it, a `createValidator({...})` result is the whole validator with other options in its place, and only `ctx.unsafeNoValidate: true` (the seed and tests) skips the default. A `ctx.validate` that is not a function throws a `TypeError`.

Three op fields are **provisional**: `renumber: true` (a Person update that changes its `gramps_id`; the validator refuses it always, with or without the id change, because the design leaves a renumber to a future io-approved path, and only `unsafeNoValidate` tooling reaches the alias path), `merged_into` (the survivor's `gramps_id`, at most 64 characters, required on a Person delete with `reason: "merge"`) and `blob` (a Media descriptor object). They serve the retire-plus-alias contract and appear nowhere in the BRD wire format, so the sync push routes and `identity-merge-rekey` must match or replace them. The `renumber_blocked` check here duplicates a rule that the validator also owns, so it is a backstop inside the transaction.

- **Seq.** Every op takes the next seq, so seqs stay dense. The `SYNC#HEAD` update is conditioned on the seq that was read. A batch that loses the race re-reads `SYNC#HEAD`, runs `ctx.validate` again on the refreshed view and rebuilds, up to 3 times, then answers `503 retryable`. The `ClientRequestToken` is a hash of `batch_id:seq_from`, so a rebuilt item set never reuses a token; the `SYNC#BATCH` condition `attribute_not_exists` is the guard across attempts.
- **Idempotency.** `batch_id` is derived from the principal and the `Idempotency-Key`; a principal may not contain `:`, so two pairs never share a `batch_id`. A key seen before with the same request (origin, `on_behalf_of`, ops and `extra`) returns the stored body with `replayed: true`; with a different request it is `422 idempotency_key_reused`. A missing key is `428 idempotency_key_required`. A replay is answered before the store gate, because it writes nothing: a client that lost the response still gets the stored body while writes are paused (open question for io: swap the two steps in `applyBatch` if a pause should refuse replays too).
- **Versions.** A stale `base_version` is `409 version_conflict` with `details.conflicts`, one entry per op: `{op_id, class, handle, reason, current_version, current}`, where `current` is the stored redacted object. A create over a live object is `409 exists`. A tombstone is kept; it can be created over again only with `base_version` equal to its version.
- **The store gate.** `SYNC#HEAD` is read inside every call. While it is absent or `seeded` is not true, every origin except `seed` gets `503 store_not_seeded`. While `writes_enabled` is false, every origin, `seed` included, gets `503 sync_paused`. A store that is both unseeded and paused answers `store_not_seeded` to every origin but `seed`, and an absent `writes_enabled` counts as not paused. The `SYNC#HEAD` update in the transaction pins `writes_enabled` (and `seeded`, for a non-seed origin) as read, so a pause or an un-seed between the check and the commit fails the transaction and the retry is refused.
- **Extra items.** `extra` (`{puts, deletes, updates, checks}`, the `transact()` shapes) commits in the same transaction, as do the items of registered contributors. A failed condition on one of the caller's own items surfaces as the `TxnCancelled`, with the caller's `tag`.
- **Validator.** `applyBatch` runs the server validator ([below](#the-server-validator)) on every call, from every origin, before the version check; `ctx.validate(view)` runs after it as an extra layer (a `createValidator({...})` result replaces it, to change its options), and `ctx.unsafeNoValidate: true` skips the default (the seed and tests only). A withdraw op must carry `reason: "private"`; any other reason, or none, is `400 validation`. This is a contract change for callers: no moderation or graduation code in the tree sends a sync `withdraw` today, and the moderation and graduation tasks must send the reason.

### The cloud ID policy

`api/src/sync/id-policy.js` holds the Q2-03 policy (HFY-TSK-246). `ctx.idPolicy` (built with `createIdPolicy({ mode, accessRequestOf, completeAccessRequest })`) or the `HFY_ID_POLICY` environment variable picks one branch from the `q2-03-id-block` answer; the other branch is off. With neither set, every create needs a `gramps_id`, as before.

| Mode | Web-origin create (`self`, `admin`, `proposal`, `graduation`, `tag`, `moderation`) | Desktop |
| --- | --- | --- |
| `mint` | An empty or absent `gramps_id` is minted from `SYNC#HEAD.id_next.<Class>` (`I8000` to `I8999`, `F8000`, ...). The counter is written by the same `TransactWriteItems` as the record, under the `SYNC#HEAD` seq condition and the `GID#` claim; a taken number is skipped; past 8999 the answer is `409 id_block_exhausted`. A web-origin id that is supplied and inside the block is `409 reserved_id_block`. | A create into the block, or an update that moves an object into it, is `409 reserved_id_block`. A minted Person id is permanent (retired on delete, withdraw or merge, never released). |
| `assign` | The `gramps_id` stays empty; no `GID#` item is written; the renderer gives the person no file. | The first empty-to-ID update is allowed once, under the `GID#` guard (`gramps_id_taken`, `gramps_id_retired`), and is not `renumber_blocked`. Any later change of a Person id is `409 renumber_blocked`. A web origin assigning an id is `renumber_blocked` too. The block is not reserved. After the commit, `completeAccessRequest(requestId, grampsId)` runs for a Person that `accessRequestOf` ties to an access request; a failure is logged and never fails the write. |

**Status and open links (HFY-TSK-246).**

- **The mode must be set before the push routes are switched on.** The rule covers the routes that call `applyBatch`: the sessions, batches and media routes of [the push routes](#the-push-routes) (HFY-TSK-173), which are now in `ROUTES` and read the mode from `HFY_ID_POLICY` on every request. The handshake and bind routes of HFY-TSK-172 (`sync.meta`, `sync.bind`) never call `applyBatch`, so they need no mode and can be turned on with `SyncApiEnabled=1` while `HFY_ID_POLICY` is unset. With no mode the store keeps the pre-Q2-03 behaviour and neither branch is active. A production profile should refuse to switch the push routes on while `HFY_ID_POLICY` is unset; the gate task does that, and `app-stack.yaml` sets no `HFY_ID_POLICY` today. `policyOf(ctx)` validates once per ctx; a bad value is logged as `id_policy_misconfigured` and answered `500 id_policy_misconfigured`. Call it at wiring time to fail early.
- **The branch is a deploy-time setting, not read from the recorded answer.** Acceptance criterion 3 (the branch is taken from the `q2-03-id-block` answer) stays **open** until io or the gate task wires that answer to `HFY_ID_POLICY`. Consumers that must reference the answer: `render-lambda` (no person file without an ID) and `addon-push` (the assignment test). Both are Python with `unittest` suites (the renderer in `gramps/hfygramps/render/`, the add-on standard-library only), so neither can import `id-policy.js`. They take the branch from another carrier, such as the `HFY_ID_POLICY` value or the recorded `q2-03-id-block` answer.
- **Assign mode, who assigns.** Only the desktop gives an ID-less object an id, for every class: any other origin is `409 renumber_blocked` (Person) or `409 assign_desktop_only` (other classes). The assignment is GID-guarded for every class.
- **Mint mode, the block.** A web-origin create or update cannot supply an id inside the block unless the store already minted it for that object.
- **Access-request completion is best effort.** `completeAccessRequest` runs after the commit, with no outbox. A crash between the commit and the call leaves the request open, and a replay returns the receipt without re-running it. `accessRequestOf` and `completeAccessRequest` are supplied by `surf-access-admin-api`, which should also add a reconcile pass that completes any request whose Person already holds an id.
- **Deploy proof.** Acceptance criterion 4 (the green `io-kit-deploy` run for the merge commit) cannot exist before merge; the code is reachable from no route.

### The server validator

[`validator.js`](../../api/src/sync/validator.js) is the gate in front of the transaction (HFY-TSK-245, sync design 5.7 and 7.2). `applyBatch` calls it as `validate(view)` with `{ops, origin, principal, on_behalf_of, sync_head, record, store, stepUp, expected}`, runs it again after every lost seq race, and builds nothing until it passes. It reads the batch as it will stand once it commits: the store view overlaid with the batch's creates, updates, deletes and withdraws. A refusal is a `SyncError` whose `details.violations` list `{rule, class, handle, pointer, op_id}`: where, never what. The first family that finds anything answers:

| Order | Family | Answer | What it refuses |
| --- | --- | --- | --- |
| 1 | Step-up | `403 step_up_required` | A desktop `delete` without `stepUp`. A destructive batch over the budget without `stepUp`, or any destructive batch on a non-empty tree whose `live_heads` is unusable (`details.reason: heads_unknown`; below). `stepUp: true` is the route's verdict that the caller presented a fresh step-up. |
| 2 | Schema | `400 validation` | An object that does not match the Gramps 6.0.6 schema per class ([`gramps/schema/gramps-6.0.6.schema.json`](../../gramps/schema/gramps-6.0.6.schema.json), read by [`schema.js`](../../api/src/sync/schema.js)). A `MediaRef.rect` that is not `null` or four ordered integers 0 to 100, and `[0,0,100,100]` (`media.rect.full_frame`, `media.rect.degenerate_or_float`). A fraction never gets this far: the store's canonical JSON refuses it first. |
| 3 | Privacy | `422 privacy_violation` | Every rule of [the redaction policy](redaction-policy.md) marked `server: detect`, with the policy's rule ids and RFC 6901 pointers, from every origin: private flags and elements, birth-like dates (day, month or non-year text), birth citations and Birth names, age, time and id attributes, addresses, e-mail and channel Urls, Place types, codes and coordinates, alt_loc fields, and the shared text detector over the listed free-text fields. |
| 4 | Ids | `422 integrity_violation`, `409 reserved_id_block`, `409 gramps_id_retired`, `409 renumber_blocked` | A gramps_id that is not a safe file name, or is `index`, `search-index`, `search-store` or `graph` (`id.shape`, `id.reserved_name`). A `desktop` or `seed` create, or an update that changes the id, into `<prefix>8000` to `<prefix>8999`. A Person create or update that claims a retired id, or recreates a retired person. A Person whose id changes, or any op that carries the `renumber` flag. |
| 5 | Integrity | `422 withdrawn_reference`, `422 integrity_violation` | A reference that resolves in none of the store view, the batch and the open session's `expected` set (`integrity.unresolved_reference`). For `self`, `admin`, `proposal`, `graduation`, `tag` and `moderation`: a reference to a withdrawn handle (`withdrawn_reference`), a Person and Family link that is not two-sided (`integrity.symmetry.spouse`, `integrity.symmetry.child`) and a `birth_ref_index` or `death_ref_index` out of range. The desktop's symmetry is checked when its push session completes. |

**Birth-likeness across objects.** The checker asks `isBirthLike` of the event after the batch: by its type, or because a person in the batch or in the store points at it with `birth_ref_index`. It also checks what the batch makes birth-like without writing it: an event that a written person newly targets, and the citations of every birth-like event the batch touches, including those cited by an EventRef. Those findings carry the handle of the stored object and the `op_id` of the op that caused the check, and only the birth rules (`birth.date.*`, `birth.citation.date`). The stored side comes from `view.referrers`, which pages the `RECS#Person`, `RECS#Family` and `RECS#Event` partitions of `GSI1` (eventually consistent) once per class per call, and only when a decision needs it. It stands in for the backrefs of the store-view fold (`records-accessors`), which replaces it through `ctx.storeView`.

**The destructive budget.** Delete and withdraw ops count together, per batch and over a rolling 24 hours: the counters `SYNC#BUDGET#<hour>` of the current hour and the 24 before it. More than 10 objects, or more than 5 % of `SYNC#HEAD.live_heads`, needs a step-up: 11 withdraws without one are `403 step_up_required`. `live_heads` counts from the first batch the store sees and must be the real number of live heads. A store filled any other way MUST have `SYNC#HEAD.live_heads` backfilled with the true count before this ships: until then a non-empty tree (`seq` above 0) whose `live_heads` is missing, negative or not an integer answers every destructive batch `403 step_up_required` with `details.reason: heads_unknown` (fail closed), and `applyBatch` leaves a missing count missing instead of counting from a partial number. A too-small positive count cannot be told from a real one, so the backfill is the control. The budget is read on the same view as the `SYNC#HEAD` seq that the transaction is conditional on, so two destructive batches that both pass the check cannot both commit: the second loses the seq race and is re-checked against the first one's counter.

**The golden vectors.** [`sync-checker.test.js`](../../api/test/sync-checker.test.js) runs every vector of [`gramps/redaction/vectors/`](../../gramps/redaction/vectors/) through `privacyVerdict()` and expects `expected.server` exactly. The cross-object cases are in [`validator-batches.json`](../../api/test/vectors/validator-batches.json): a store, a batch and the expected findings, run against an in-memory store and against the store view over the fake table. [`sync-validator.test.js`](../../api/test/sync-validator.test.js) covers each rule through `applyBatch` from every origin.


### Gramps ids

One `GID#` write per distinct id decides the batch as a whole, so a swap or a rotation of non-person ids commits in one batch. Two claims on one id in a batch are `409 gid_conflict`; a claim on an id in use is `409 gramps_id_taken`.

- **Person ids are permanent.** A delete, withdraw, merge or renumber rewrites `GID#Person#<id>` as `{handle, retired: true, reason}` and writes an `IDALIAS#` item for a merge or renumber. Nothing deletes either item (`gidDelete` refuses a Person), and another person claiming a retired id is `409 gramps_id_retired`. A create over a Person tombstone is refused with `409 gramps_id_retired` (any id, so a merged person cannot return while its alias points elsewhere, and a deleted one cannot slip past the renumber guard); so is a renumber back onto an id the person retired. Bringing a Person back is the operator `resurrect` tooling, not a batch op. A non-person tombstone can still be created over with its version.
- **A person's id does not change** (`409 renumber_blocked`) unless the op carries `renumber: true`. A Person merge (a delete with `reason: "merge"` and `merged_into`) is `409 merges_disabled` until `SYNC#HEAD.merges_enabled` is true.
- **Canonical JSON.** `obj_json` and `blob` are written by `canonicalJson` in `shared/canonical.mjs`, the module `gramps/hfygramps/canonical.py` matches byte for byte (sync.md 4.1). An object or blob that it refuses, such as one with a fraction, an integer beyond +/-(2^53 - 1), a lone surrogate or nesting deeper than 200, is `400 validation` before any read, even on the seed path, which runs no validator. Otherwise the desktop add-on and the renderer could not rebuild the stored hash.
- **Size.** A batch holds at most 24 ops, `2 x sum(obj_json bytes) + sum(blob bytes)` at most 3.5 MB, one `obj_json` at most 200 KB and one `blob` at most 4 KB, so a head stays under DynamoDB's 400 KB item limit. A batch whose ops could need more than 100 transaction items (a Person renumber takes up to 5, a merge 4) is refused with `413 batch_too_large` before any read: clients split those batches. A store rejection for item size is also `413`, never a retryable `503`.
- **Left to other tasks.** The `expunged` flag of BRD2 section 4 is not written here: `privacy-expunge` sets it when it nulls `obj_json`, and a head or log entry without it is not expunged.
- **Other ids are released** on delete or renumber. No identity is keyed by a non-person id: comment threads are `person:<id>` or `post:<ulid>`, record follows and profile links are keyed by a Person id, and allowlist grants by email.

### Commit hooks

[`sync/hooks.js`](../../api/src/sync/hooks.js) exports `registerContributor(fn)` and `registerAfterCommit(fn)`; both lists start empty.

- A contributor, `fn(batch, origin)`, returns extra transaction items for the batch's own transaction. It runs on every attempt, so it must be pure. The self-edit and tag contribution ops come only from the contributor that `hfy-record-change-fanout` registers; no caller adds them.
- An after-commit hook, `fn({batch_id, origin, seq_from, seq_to})`, runs once per committed batch, after the commit, and never for a replay or a refused batch. A hook that throws is logged by name and code and never fails the write. If the process dies between the commit and the hook, the hook does not run for that batch.
- Record-change notifications do not come from here. They come from the render outbox.

## Records read API

[`src/records/read.js`](../../api/src/records/read.js) (HFY-TSK-175). `GET /api/records/:class/:handle` and `GET /api/records/Person/by-id/:gramps_id` return one stored record to a signed-in member as `{class, handle, gramps_id, version, obj}` with `ETag: "v<version>"`. The editing, proposals and tagging domains read through it. There is no write route and no MCP tool; the edit bundle and `hfy_records_get` call the same `viewRecord()`.

- **What is stored.** `obj` is the redacted Gramps JSON of the cloud record store ([The cloud record store](#the-cloud-record-store)). A tombstone, an unknown handle, an unknown class or a malformed handle answers `404 not_found`. The ETag carries the version only and the body depends on the viewer, so the response is `no-store` with `Vary: Cookie`; the route does not answer `If-None-Match` with `304`.
- **`publishView(obj, viewer)` (Q2-04b, HFY-R76).** A non-admin gets every date at year precision: day and month (also the second day and month of a range or span) become `0`, `sortval` becomes `0`, and `text` becomes the year or an empty string. Admins, the member's own Person and the member's own-only events are not reduced; an own-only event is an Event that only the member's own Person references, as Primary. It returns a copy. Birth dates are reduced like any other date (redaction already stores them as a year, so nothing changes today). A text-only range keeps its first year. An own-only event needs an explicit Primary role on the member's `event_ref`; a missing role does not count.
- **`applyModOverlay(obj, viewer, mods)` (D2-19, D2-34).** `loadMods()` reads the open, hidden `MOD#note:<handle>`, `MOD#mediaref:<holder handle>:<media handle>` and `MOD#media:<handle>` items for the references in `obj`. The overlay removes hidden note handles from every `note_list`, and hidden MediaRefs and MediaRefs of hidden Media from every `media_list`, unless the viewer is an admin or the item's `author_id`. A hidden Note or Media record itself is a `404` to everyone else. A failed `MOD#` read is an error, never an unfiltered record. The owner who keeps a hidden item is the member whose own Person holds it (seen on their own Person page, or as the Note or Media record itself, never on someone else's page; R2-25, D2-19: the page owner) and also the member who raised the `MOD#` item (`author_id`).
- **The `HFY_EDITING` switch.** While it is not `on`, the routes answer `404 not_found` to everyone except admins and a member reading their own record: their own Person (also by id), an own-only Event (their Primary event that no other record references; a shared Event is not their own record), or a Note or Media their own Person references. A signed-out caller gets `404` while it is off and `401` when it is on.
- **Cost.** The own record costs one index query and one read per request; the reference index (the store view) is read only for an Event that holds a day-precise date. The own-Person lookup is shared by the gate and the handler of one request. A record that references more than 1000 notes or media answers 503. A duplicate `gramps_id` answers `409 ambiguous_gramps_id` to admins and `404` to members. A failed own-record lookup is logged and answers 404 (fail closed). `viewRecord` and the `store` route context are the reusable read view for edit-api-core and edit-mcp-tools.

## Editing API core

[`src/records/edit-bundle.js`](../../api/src/records/edit-bundle.js) (HFY-TSK-182; editing design sections 4 and 7). It serves the data an editor needs and writes nothing. `POST /api/changes` and the proposal routes are separate tasks.

- **The `HFY_EDITING` switch.** `editingGate()` is a `serverSwitch("HFY_EDITING")` that passes only when the stack parameter `HfyEditing` is `on`. While it is not, `edit.get` and `edit.schema` answer `404 not_found` to everyone, admins and signed-out callers included. The gate runs before the 401. This differs from the [records routes](#records-read-api), which let an admin or a member's own record through.
- **`GET /api/edit/:cls/:ref`.** `ref` is a gramps_id or `h:<handle>`. The body is `{key, version, etag, obj, related, relation, viewer, policy, pending, customTypes, schemaHash}`, where `etag` is `<key>@<version>`. `obj` and every non-Person entry of `related` go through `viewRecord`, so `publishView` (no day or month on another person's non-birth date, Q2-04b) and `applyModOverlay` (no hidden note, MediaRef or Media for a non-owner) apply as on the records API. A hidden Note or Media is `404`, and left out of `related`. `related` holds the objects `obj` references, one level deep (at most 200): `{version, obj}`, or for a Person `{version, stub: {displayName, gender, isLiving, lifespan}}` where `lifespan` is year-only and `isLiving` is a display hint. `relation` is `own` or `other` (`relationOf`). `policy` is the field-policy table (`createFieldPolicy().document()`); the server decides, the client copy is for labels. `customTypes` and `schemaHash` come from the store view and the committed schemas.
- **`pending[]`.** `{proposalId, state, paths}` for each open (`pending`, `needs_changes` or `stale`) proposal on this record, read from the per-record index (`GSI1 PROPREC#<Class>:<handle>`). A viewer sees their own proposals, every proposal if they are an admin, and any proposal whose targets include their own Person or a Family they belong to. Anyone else gets `[]`. It carries no op values, note or decision.
- **`GET /api/edit/schema/:cls`.** `{class, schema, sha256, schemaHash}` from `api/src/records/schemas/<class>.schema.json`; `schemaHash` is the hash over all nine files, and equals the bundle's.
- **`GET /api/me`.** `ownRecord` comes from `ownRecord()` in `field-policy.js`, which reads only the verified session id.

## The sync API

`/api/sync/*` is the desktop add-on's door into the cloud record store (HFY-TSK-172; design: HFY-PLN-002 sync.md section 7, BRD2 section 11.1). Its routes have `auth: "sync-bearer"` in `ROUTES` and `caps.json`. This page covers the shared middleware, the handshake routes, `GET /api/sync/meta` and `POST /api/sync/bind`, and [the push routes](#the-push-routes) (`sessions`, `batches`, `media/presign`, HFY-TSK-173). The pull routes (`snapshot`, `changes`) are added by their own task as more entries in `SYNC_ROUTES` ([`sync/routes.js`](../../api/src/sync/routes.js)); they inherit everything below.

### What a sync request goes through

The handler runs these steps in place of steps 5 to 7 of the [request pipeline](#request-pipeline). The first that fails decides the response. Errors use the usual `{error, message, details?}` body.

| Step | Check | Failure |
| --- | --- | --- |
| 1 | **Switch.** `SYNC_API_ENABLED` must be `1` (stack parameter `SyncApiEnabled`, default `0`). It runs before the token is read, so a closed API answers everyone alike. | `404 not_enabled` |
| 2 | **Bearer.** `Authorization: Bearer <access token>`. The session cookie is never read here, so an `hfy-admin` cookie alone cannot reach a sync route. RS256 through the auth edge's JWKS; `iss` is the auth edge issuer, `aud` includes `https://harrisonfamily.us/api/sync`, `client_id` is `hfy-sync-desktop` and `token_use` is `access`. Every failure is one answer, so a caller learns nothing about which check failed. | `401 unauthenticated` with a `WWW-Authenticate: Bearer` challenge |
| 3 | **Body size.** A body over 2 MiB. | `413 batch_too_large` |
| 4 | **Handshake.** The four `X-HFY-*` headers below, against the terms in `SYNC#HEAD`. | `426 upgrade_required`, `409 redaction_version_mismatch` |
| 5 | **Owner.** The subject must be in the `gramps-owner` group of `config/groups.json`. The token's own `groups` claim is ignored, and so are emails; an unreadable or malformed file means nobody is the owner. | `403 not_owner` |
| 6 | **Pause.** A write route while `SYNC#HEAD.writes_enabled` is `false`. (`applyBatch()` repeats the check for every origin.) | `503 sync_paused` |
| 7 | Content type and body, as for every route. | `415`, `400` |

The route handler then gets `c.sync`: `{head, terms, handshake, treeId, writesEnabled, store, checkTree(), requireStepUp(reason), stepUp()}`. `checkTree()` is `403 tree_mismatch` unless `X-HFY-Tree-Id` equals the bound tree (a store with no bound tree passes); the push and pull routes call it, `meta` and `bind` do not. `stepUp()` is the boolean a push route passes to `applyBatch()` as `stepUp`.

The validation order of sync.md 7.2 puts the handshake before authorization. The implementation authenticates the bearer first (step 2) because the handshake terms live in a table read that an unauthenticated caller should not trigger; the visible order for a valid token is as designed.

### Handshake

Every call carries these headers (any case). A value is never echoed back.

| Header | Accepted | Otherwise |
| --- | --- | --- |
| `X-HFY-Sync-Client: hfy_sync/<semver>` | at least `min_client` (`SYNC#HEAD.min_client`, default `0.1.0`) | `426`, `details.reason` `client_header` or `client_too_old` |
| `X-HFY-Gramps-Version: 6.0.6` | major.minor `6.0` | `426`, `gramps_version` |
| `X-HFY-Gramps-Schema: 21` | a member of `SYNC#HEAD.accepted_schema` (default `[21]`) | `426`, `schema` |
| `X-HFY-Redaction-Version: 1` | equal to `SYNC#HEAD.redaction_version` (default `1`) | `409 redaction_version_mismatch`; a missing header is `426`, `redaction_header` |
| `X-HFY-Tree-Id: <uuid>` | read by `checkTree()` only | `403 tree_mismatch` |

A `426` carries `details: {reason, min_client, accepted: {gramps, schema}, redaction_version}`, so the add-on can tell the owner what to install.

### Step-up

`stepUpFresh` (in [`sync/auth.js`](../../api/src/sync/auth.js)) is true when `amr` includes `mfa` and `auth_time` is at most 300 s old. `passkey`, `hwk` and `swk` alone do not count (HFY-R67). A missing, zero, non-numeric or future `auth_time` is stale (`auth_time` is never refreshed, HFY-R64). The rules that use it:

| Action | Rule | Where |
| --- | --- | --- |
| A rebind (`POST /api/sync/bind` with `rebind: true` on a bound store) | fresh step-up, else `403 step_up_required` (`details.reason` `rebind`) | `sync.bind` |
| Delete ops, and withdraws above the delete/withdraw budget | fresh step-up, else `403 step_up_required`. The route passes `c.sync.stepUp()` as `applyBatch()`'s `stepUp`; [the validator](#the-server-validator) decides whether an op or the budget needs it. | the push route |
| A conflict decision | `requireConflictDecision(actor)`: gramps-owner **and** step-up. An `hfy-admin` cookie alone is refused (`403 not_owner`), because a cookie actor carries no `sync` member. | the conflict route |

### `GET /api/sync/meta`

Owner bearer, any state of the store. Returns `{api_version: 1, min_client, accepted: {gramps, schema}, redaction_version, tree_id, bound: {dbid, fingerprint} | null, head_seq, rendered_seq, writes_enabled, seeded, merges_enabled, limits: {max_ops, max_obj_bytes, max_body_bytes}, id_block, retired_person_ids}`.

- `merges_enabled` is `true` only when `SYNC#HEAD.merges_enabled` is literally `true`; it stays `false` until `identity-merge-rekey` ships.
- `retired_person_ids` lists every Person id whose head is a tombstone (deleted, withdrawn or merged away), sorted, from the `RECS#Person` index. The add-on holds a local create that reuses one (D44); the server refuses it anyway with `409 gramps_id_retired`. The index is eventually consistent and the server stays the authority. Renumbers are blocked in this release; when they ship, the list must also read retired `GID#` items.
- `id_block` is the range the cloud mints from (`I8000-I8999` and the other classes' prefixes); a desktop create may not use it. Under `HFY_ID_POLICY=assign` nothing is minted and the validator does not reserve the block ([The cloud ID policy](#the-cloud-id-policy)); the handshake still reports it, so the add-on holds ids in it either way.
- `bound` never includes the tree-name hash. `rendered_seq` is `SYNC#RENDER.rendered_seq`, `0` before the first render.

### `POST /api/sync/bind`

Body `{dbid, fingerprint, tree_name_sha256, rebind?}`: `dbid` 1 to 128 characters of `A-Za-z0-9._-`, `fingerprint` 8 to 256 characters of `A-Za-z0-9._:-`, `tree_name_sha256` 64 lowercase hex characters, `rebind` a boolean. A bad field is `400 validation` with `details.fields[0].field`.

- **First bind** (nothing bound): mints `tree_id` (a UUID) and stores `tree_id`, `bound: {dbid, fingerprint, tree_name_sha256, bound_at, by}` and `bound_at` on `SYNC#HEAD`, with an `AUDIT#sync:bind` item in the same transaction. Returns `{tree_id}`. It changes no other `SYNC#HEAD` attribute, so the seq counter, `seeded` and `writes_enabled` are untouched.
- **Already bound**: `409 already_bound` when `rebind` is absent, or when the body names the tree already bound.
- **Rebind** (`rebind: true`, a different tree): needs a fresh step-up (`403 step_up_required`), keeps the existing `tree_id` and is audited. A `rebind: true` on an unbound store is a plain first bind.
- The write is conditional on `bound_at`, so two racing binds cannot both win; the loser is `409 already_bound`.
- While writes are paused (`SYNC#HEAD.writes_enabled` false) a bind is `503 sync_paused`.

The tree marker uuid, the similarity guard and the sidecar are the add-on's side of binding (sync.md 8.3 step 1).

### Switch and group settings

- `SYNC_API_ENABLED` (`0` or `1`) is read from the environment on every request.
- `gramps-owner` is a group in `config/groups.json` with `subjects` only: `{"groups": {"gramps-owner": {"subjects": ["<gramps_id>"]}}}`. It grants no MCP tool and no feature. Publishing `groups.json` needs io's go-ahead ([AGENTS.md](../../AGENTS.md)).

## The push routes

HFY-TSK-173 (design: HFY-PLN-002 sync.md sections 7.2 and 9, BRD2 section 11.1 7.2). Code: [`sync/push.js`](../../api/src/sync/push.js) and [`sync/media.js`](../../api/src/sync/media.js). Each route is a `sync-bearer` write route in `SYNC_ROUTES`, so [every step above](#what-a-sync-request-goes-through) applies first (`404 not_enabled`, `401`, `403 not_owner`, the handshake's `426` and `409`, and `503 sync_paused`), and none has an MCP tool. Every route calls `checkTree()`: `403 tree_mismatch` unless `X-HFY-Tree-Id` is the bound tree.

| Route | Success | Errors besides the middleware's |
| --- | --- | --- |
| `POST /api/sync/sessions` `{expected?}` | `201 {session_id, expires_at, seed}` | `400 validation`, `409 not_bound`, `409 session_open` (details: `session_id`, `opened_at`, `expires_at`, `seed`), `413 batch_too_large` (more than 8000 announced handles) |
| `POST /api/sync/sessions/:id/complete` | `200 {seq}` (the marker's seq) | `404 session_not_found`, `409 session_closed` (aborted), `409 session_expired`, `422 integrity_violation` or `withdrawn_reference` with `details.violations` |
| `POST /api/sync/sessions/:id/abort` | `200 {session_id, state: "aborted"}` | `404 session_not_found`, `409 session_closed` (already complete) |
| `POST /api/sync/batches` `{tree_id?, session_id?, client_run_id?, ops}` with an `Idempotency-Key` header | `200 {batch_id, seq_from, seq_to, results}`; a replay adds `Idempotent-Replayed: true` | Everything `applyBatch()` answers ([One call, one transaction](#one-call-one-transaction), [The server validator](#the-server-validator)): `400`, `403 step_up_required`, `409 version_conflict`, `exists`, `gramps_id_taken`, `gramps_id_retired`, `reserved_id_block`, `renumber_blocked`, `413`, `422 privacy_violation`, `integrity_violation`, `idempotency_key_reused`, `unknown_class`, `428`, `503 store_not_seeded`, `retryable`. Also `404 session_not_found`, `409 session_closed`, `session_expired`, and `422 blob_not_uploaded`, `blob_mismatch` |
| `POST /api/sync/media/presign` | `200 {upload_url, headers, key, expires_in: 300}` | `400 validation` (`details.fields[0].field`), `503 unavailable` (no presigner wired) |

**Origin and notifications.** A batch is written by `applyBatch()` with origin `desktop`, or `seed` inside the seed session, and the principal is the token's subject. The request produces no notification: nothing writes an inbox, follower or push item. Record-change notifications come only from the renderer's outbox, which reads the change log, where a seed batch is recognisable by its origin and is silent. The one hook point is `registerAfterCommit` ([`sync/hooks.js`](../../api/src/sync/hooks.js)): it fires exactly once per committed batch with `{batch_id, origin, seq_from, seq_to}` and never for a replay or a refused batch. The handler passes `deps.syncHooks` as `ctx.hooks`, and falls back to the process-wide registry without it.

**Sessions.** A session spans several batches (the seed, a large edit). One is open at a time: `SYNC#HEAD.open_session` names it. The `SYNC#SESSION#<id>` item holds `state` (`open`, `complete` or `aborted`), `seed`, `expected` (the announced `"Class#handle"` strings), `opened_at`, `start_seq`, the opener and a 7-day `ttl`. The server treats an open session as expired at `opened_at + 7 d` without waiting for the TTL delete: a new open replaces it, a batch into it is `409 session_expired`, and it can still be aborted. A pointer to a closed or expired session never blocks a new open.

- **`expected`.** A batch in a session may reference an announced handle that is not written yet. Without the announcement, or outside a session, the same reference is `422 integrity_violation`. The announcement stops counting at completion: every reference must resolve then.
- **Seed.** The first session while `SYNC#HEAD.seeded` is not `true` has `seed: true`. Its batches carry origin `seed`, which the store gate accepts before the seed and which the renderer treats as silent. Completing a seed session sets `seeded`. A `delete` inside it still needs the fresh step-up that a desktop delete needs. Outside a session an unseeded store answers `503 store_not_seeded`.
- **Complete.** The session's integrity check reads the session's own `SYNC#LOG` entries (a consistent Query since `start_seq`, the latest entry per object) and runs the validator's integrity rules with hard symmetry on them: every reference resolves in the store or the session, and every person-family link is symmetric. A desktop batch is not checked for symmetry on its own, because the links cross batch boundaries, so a batch outside a session gets the reference check only. Then a `marker` entry (reason `session_complete`, the session's origin) is appended in the same transaction that sets the session to `complete`. Setting `SYNC#HEAD.seeded` (seed session) and removing `open_session` follow as two idempotent updates. The call is idempotent: the marker's batch key is `session-complete:<session_id>`, so a repeat returns the same `seq` and writes nothing more.
- **Abort.** Any `gramps-owner` can abort (the add-on's own session after a sidecar loss, D48). It writes the session state and an `AUDIT#sync:session:<id>` item. What the session already pushed stays: every batch was atomic and committed.
- **D48 for the add-on.** On `409 session_open` the add-on resumes the `session_id` it kept in its outbox, or, with the owner's confirmation, aborts the session named in `details.session_id` and opens a new one.
- **Replays.** A batch whose `Idempotency-Key` was committed is answered with the stored body even after its session closed (the client lost the response, D23). A new batch into a closed session is not. Inside a session each batch's transaction also holds a condition check that the session is still `open`, so a session closed during the request fails the batch (`409 session_closed`) and writes nothing.

**Media blobs.** The cloud copy of a photo is `media/<handle><ext>`, with `<ext>` from the content type (`image/jpeg` `.jpg`, `image/png` `.png`, `image/gif` `.gif`, `image/tiff` `.tif`, `application/pdf` `.pdf`; HEIC and WebP are refused; at most 25 MB). Every blob goes through staging, so a blob whose Media op is refused is never at a served key and a blob update is atomic with its Media op:

1. `POST /api/sync/media/presign {handle, content_type, size, sha256_b64, md5_hex}` returns a presigned PUT to `media/.staging/<handle>/<sha256 hex>`. `Content-Type`, `Content-Length` and `x-amz-checksum-sha256` are signed, so S3 refuses bytes that do not hash to the checksum, and the client sends the returned `headers` exactly. A `SYNC#UPLOAD#<handle>` / `<sha256>` item (`ttl` +1 h) records the upload.
2. The Media op carries `blob: {sha256, md5, size, content_type}` (hex hashes), or `blob: {state: "missing"}` for a held blob. The server never stores the client's descriptor: it builds `{s3_key, sha256, md5, size, content_type, state}` itself, with the key derived from the handle and the type. Before the first commit it requires a live pending item that matches the claim and a `HeadObject` (checksum mode) of the staging object with the same size, SHA-256 and type, else `422 blob_not_uploaded` or `422 blob_mismatch`. A claim equal to the blob the head already holds needs no upload. A held blob never replaces a good cloud blob, and a Media update that names no `blob` keeps the head's descriptor (`applyBatch()` carries it forward).
3. After the Media op commits, and again on every replay of the batch, the server runs `CopyObject` from the staging object to the final key with `ChecksumAlgorithm: SHA256` and compares the returned checksum with the signed one. It then deletes the staging object, the binary an extension change orphaned (`media/<handle><old ext>`, only a key of that exact shape for the same handle) and the pending item. Every step is idempotent. If one fails, the answer is `503 retryable` although the Media op is committed, and the client repeats the batch with the same `Idempotency-Key`, which finishes the copy.

Notes for the clients (`addon-media`, the sync dev harness):

- **A create stages too.** The design stages updates only; the route stages creates as well, so a refused create never reaches the served key and a create and an update behave the same. The `key` in the presign response is therefore always a `media/.staging/<handle>/<sha256>` key. A blob is at `media/<handle><ext>` only after its Media op committed and finalize ran, never directly after the upload. A client must not assume the final key exists before the batch answers `200`.
- **A held blob replays cleanly.** `blob: {state: "missing"}` stays on the op whatever the head holds, and `applyBatch()` keeps the head's present descriptor, so the same `Idempotency-Key` with the same body replays as `200` (never `422 idempotency_key_reused`).
- **Finalize survives an expired pending item.** The pending item's `ttl` is pushed out by another hour when the staged object is verified. If the item is gone anyway, the replay checks the final key's checksum, copies from staging when the final key does not hold the blob and the Media head still names it, and otherwise leaves the objects alone.
- **S3 403.** The `hfy-api` role has no `s3:ListBucket` on the media bucket, so S3 answers 403 for a key that is not there. The routes read a 403 as a missing key (`422 blob_not_uploaded` before the commit) and log it at warn; a role or bucket-policy fault shows up there.
- **Abort.** Any `gramps-owner` bearer may abort any session, not only the one that opened it; the audit item records the opener (`before.opened_by`) and the aborting principal.
- **Staging leaks.** A staging object whose batch was refused stays where it is, not served and unreferenced, until the lifecycle rule in [`site-bucket-lifecycle.json`](../../infrastructure/cloudformation/site-bucket-lifecycle.json) (2 days; applied by hand, the bucket is not stack-managed, see [Stand up the static site](../how-to/stand-up-the-static-site.md#1-create-the-site-bucket)) or an operator removes it.

**Store errors.** A throttled or failing DynamoDB or S3 call is `503 retryable`. The batch is atomic, so the client retries with the same `Idempotency-Key`. A lost seq race is retried inside the request (up to 3 times) with a new `ClientRequestToken`.

**Operations.** The `hfy-api` role needs `s3:GetObject`, `s3:PutObject` and `s3:DeleteObject` on `media/*` of the media bucket (the `MediaBinaries` statement in [`app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml)). `s3:DeleteObject` is the action the release adds: it is granted on all of `media/*`, but the code deletes only a staging object and the binary an extension change orphaned (`media/<handle><old ext>`), and the change-set summary for io lists it. The routes ship in the `hfy-api` zip with the release group's change set ([Deploy the app stack](../how-to/deploy-the-app-stack.md)), and `SyncApiEnabled` stays `0` until the seed.

## The pull routes

HFY-TSK-174 (design: HFY-PLN-002 sync.md sections 4.2 and 7.2, BRD2 section 11.1, reviews SI-30 and PS-22). Code: [`sync/pull.js`](../../api/src/sync/pull.js). Each route is a `sync-bearer` route in `SYNC_ROUTES`, so [every step of the sync middleware](#what-a-sync-request-goes-through) applies. The change feed, `GET /api/sync/changes`, is phase B (`changes-feed`) and is not here. A paused store (`writes_enabled` false) still serves every pull route: the POST routes set `pausedOk`.

| Route | Success | Errors besides the middleware's |
| --- | --- | --- |
| `GET /api/sync/snapshot` | `200 {seq, url, body_sha256, count, generated_at}`; `url` is a presigned GET valid for 300 s | `503 retryable` (store or S3), `503 unavailable` (no sync bucket or signer wired) |
| `POST /api/sync/media/:handle/download` | `200 {url, sha256, md5, size, content_type, expires_in: 300}` | `404 no_blob` (unknown or malformed handle, a tombstone, a held blob, no descriptor), `503 retryable` |
| `POST /api/sync/status` | `204` | `400 validation` |
| `GET /api/sync/conflicts?state=open&limit=<1..100>&cursor=` | `200 {state, conflicts, next_cursor}`, oldest first | `400 validation` (state, limit), `400 bad_cursor` |
| `POST /api/sync/conflicts/:id/decision` `{decision}` | `200` the updated conflict | `400 validation`, `403 not_owner`, `403 step_up_required`, `404 not_found`, `409 already_resolved` |

**The snapshot file.** It is built on demand from the store view (the heads, tombstones included, never a GSI read) and cached per seq at `snapshots/<seq>.jsonl.gz` in the sync bucket (`SYNC_BUCKET`, default `harrisonfamily-sync`); the object's metadata holds `body_sha256`, `count`, `generated_at` and `tree_id`, so a repeat call at the same seq costs one `HeadObject`. A cached object is reused only while its metadata also matches the current redaction version, schema version and `SYNC#HEAD.expunge_epoch`; privacy-expunge must increment `expunge_epoch` in its transaction so the next snapshot is rebuilt without the expunged value. Conflict queue reads are sync-bearer only; the admin-cookie read in sync.md 7.2 belongs to the phase B admin page task (RG-7). A decision fails with a retryable error if the cloud head moves while it is recorded. The snapshot is built in memory. `snapshots/latest.json` records the newest. Line 1 is the header `{"type":"header","tree_id","seq","schema":21,"redaction":1,"count","body_sha256"}`. Every further line is `{"class","handle","gramps_id","version","seq","deleted","obj"}` in class then handle order, as canonical JSON ending in `\n`; a tombstone, a withdrawn head or an expunged entry has `deleted: true` and `obj: null`. `body_sha256` is the SHA-256 (hex) of the uncompressed body, every byte after the header line. The gzip header carries no mtime, so the same heads give the same bytes. The add-on checks the header (`tree_id`, `schema`, `redaction`, `count`), the digest, and `seq >= last_pull_seq` (D10, D11).

**Blob downloads.** The descriptor on the Media head decides: a present blob under `media/<handle><ext>` is presigned for 300 s with its recorded content type, and the response carries the checksums the add-on verifies (D33). A blob whose key is not of that shape is never presigned.

**Status.** The body is `{client_instance_id, dbid, fingerprint, addon_version, gramps_version, schema, last_run: {run_id, action, result, exit_code?, counts?, finished_at}}`, every field shape-checked; unknown fields are dropped. It replaces the single `SYNC#CLIENT#<client_instance_id>` item. The body carries no tree name, person, path or free text.

**Conflicts.** `SYNC#CONFLICT#<ulid>` items are read through GSI1 `SYNCCONFLICT#<state>`. The cursor is opaque, rebuilt from the last item, and can only walk the partition it is used with. A decision needs the sync bearer: a `gramps-owner` whose sign-in has `amr` `mfa` and `auth_time` within 300 s (`requireConflictDecision`, checked before the item is read). An `hfy-admin` session cookie alone is refused (`401` with no bearer, `403 not_owner` for an admin bearer). The conditional update stores `{decision, cloud_version, cloud_value_hash}` with the state `resolved` and an audit item (`AUDIT#conflict:<id>`). `cloud_version` is the version of the object's head when the decision was made; `cloud_value_hash` is the SHA-256 of the canonical JSON of `[{path, cloud}]` from the conflict's own `paths`, the values the admin saw. The add-on applies the decision only while both still match, else it reopens the conflict (SI-30). A conflict that is not open, including a dismissed one, is `409 already_resolved`. Nothing in this release writes a `SYNC#CONFLICT#` item: the desktop's mirror of parked conflicts and the proposals domain's `proposal_stale` source are later tasks.

**Operations.** The `hfy-api` role reads and writes `snapshots/*` in the sync bucket (the `SyncSnapshots` statement in [`app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml)), and the stack sets `SYNC_BUCKET`. The routes answer `404 not_enabled` until `SYNC_API_ENABLED` is `1`.

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
| `SYNC_BUCKET` | `harrisonfamily-sync` | `SyncBucketName` | Private bucket for the sync snapshots (`snapshots/<seq>.jsonl.gz`), see [The pull routes](#the-pull-routes) |
| `MEDIA_PUBLIC_BASE` | `https://<site>` | `MediaPublicBase` | Origin that serves `uploads/`. Upload `publicUrl`s start with it, and attachment URLs must. |
| `HFY_GUARD_DOB` | unset: off | `GuardDob` (`off` or `on`, default `off`) | `on` makes the contact-information guard refuse `dob_not_allowed`. Any other value is off. See [Contact-information guard](#contact-information-guard). |
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
- The role may read only `person/*` in `MediaBucket` (the `PersonRecords` statement) and may put objects only under `uploads/posts/*` (`PostPhotoUploads`) and `uploads/comments/*` (`CommentPhotoUploads`), and may read objects only under those two prefixes (`UploadReads`). The one other grant on that bucket is `MediaBinaries`: get, put and delete under `media/*`, for the desktop sync's blobs ([The push routes](#the-push-routes)). The `Table` statement includes `dynamodb:ConditionCheckItem` for `transact()` condition checks.

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
| `auth` | `{scheme: "session-cookie", issuer_env: "SESSION_ISSUER", reads_require_session: true, sync_bearer: {scheme, issuer, audience, client_id, group, step_up}}` |
| `sync` | `{api_version, enabled_by: "SYNC_API_ENABLED", min_client, accepted, handshake_headers, limits}` |
| `subjects` | `["person:<gramps_id>", "post:<ulid>"]` |
| `actions` | One per route: `{name, method, path, auth: "session", write, summary}`, plus `gate` when the route declares one: `{feature}`, `{switch}` or `{exempt}` ([Feature gate](#feature-gate)). `write` is true for every method except GET. |
| `content` | `{source: "posts", capabilities, post_types, visibilities}`. `capabilities`: `list`, `get`, `createDraft`, `update`, `setVisibility`, `delete`, `drafts` and `audit` are true; `subscribe` and `since` are false; `attachments` is `"metadata-only"`; `filters` are `subject`, `type`, `author`, `visibility`. |
| `comments` | `{reactions: "one-emoji-per-principal-per-comment", threading: "parentId (reply)", max_body: 1000, subject_param}` |
| `mcp` | `{resource, tools}`. `resource` is `MCP_RESOURCE` (`https://<site>/mcp`). `tools` has one entry per route with an `mcp` member: `{name, action, write}`, where `name` is the tool name (for example `hfy_posts_get`), `action` the route name and `write` the route's `write`. |
| `notifications` | `{types: NOTIFY_TYPES, default_level: 0}`. `NOTIFY_TYPES` is every type in `TEMPLATE_REGISTRY`, in registry order, PLN-002 types included. |
| `audit` | `{item: "AUDIT#", fields: ["op", "id", "principal", "at", "before", "after"], ops: ["create", "update", "delete", "visibility", "links.update", "links.clear"]}` |

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
