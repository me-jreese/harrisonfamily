# Family API (hfy-api)

Reference for hfy-api, the members-only JSON API served at `/api/*`. This page covers the runtime, the request pipeline, every route, the data each route reads and writes, permissions, audit records, notifications, uploads, configuration, session verification, the capability document and packaging.

For the reasoning behind these rules, see [How member content stays accountable](../explanation/member-content-design.md). For why the API sits behind CloudFront with a shared-secret header, see [Why one CloudFront distribution fronts everything](../explanation/edge-and-origin-design.md).

## Runtime

| Item | Value | Source |
| --- | --- | --- |
| Lambda function | `hfy-api` | [`app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml) |
| Runtime | Node.js 22 (`nodejs22.x`, arm64), ES modules | [`api/package.json`](../../api/package.json), `app-stack.yaml` |
| Handler | `src/index.handler` | [`api/src/index.js`](../../api/src/index.js) |
| Memory and timeout | 256 MB, 15 s | `app-stack.yaml` |
| Invocation | Lambda Function URL, `AuthType: NONE`, `InvokeMode: BUFFERED`, payload format 2.0 | `app-stack.yaml`, [`api/src/handler.js`](../../api/src/handler.js) |
| Public path | `/api/*` on the site's CloudFront distribution, with caching disabled and all viewer headers except `Host` forwarded | [`scripts/infra/add-api-behavior.sh`](../../scripts/infra/add-api-behavior.sh) |
| Table | DynamoDB `hfy-app`: one table, index `GSI1`, TTL attribute `ttl` | `app-stack.yaml` |

### Source files

| File | Role |
| --- | --- |
| [`index.js`](../../api/src/index.js) | Lambda entry. Creates the AWS clients, runs the origin check, and builds the handler on the first verified request. |
| [`handler.js`](../../api/src/handler.js) | The pipeline: path, route, session, body. Wires the posts, comments, notification and upload services for each request. |
| [`routes.js`](../../api/src/routes.js) | The route registry `ROUTES`, `matchRoute`, and `buildCaps` for `caps.json`. |
| [`http.js`](../../api/src/http.js) | JSON responses, `HttpError`, error mapping, cookie parsing. |
| [`origin.js`](../../api/src/origin.js) | The `X-Origin-Verify` check. |
| [`auth.js`](../../api/src/auth.js) | Remote JWKS, session authenticator, admin list. |
| [`content.js`](../../api/src/content.js) | Posts, as an `@io-kit/content` ContentSource. |
| [`comments.js`](../../api/src/comments.js) | Comments and reactions, as an `@io-kit/comments` CommentSource. |
| [`txn.js`](../../api/src/txn.js) | Audit item builder, `TransactWriteItems` helper, `GSI1` paging. |
| [`keys.js`](../../api/src/keys.js) | Key helpers. |
| [`notify.js`](../../api/src/notify.js) | Notification types, templates and fan-out. |
| [`uploads.js`](../../api/src/uploads.js) | Presigned photo uploads: validation and the object key. |
| [`presign.js`](../../api/src/presign.js) | The S3 presigner for uploads, kept apart so tests can sign offline. |

### Dependencies

| Package | Version (lockfile) | Used for |
| --- | --- | --- |
| `@io-kit/content` | 0.1.0 | Post types and visibilities, `can` and visibility policy, `ContentError`, audit entry shape, list limits |
| `@io-kit/comments` | 0.1.0 | Comment `can` policy, emoji check, `CommentError`, audit entry shape, list limits |
| `@io-kit/notify` (`/server`) | 0.4.0 | The five notification routes, subscription and preference stores, push payloads and sending |
| `@io-kit/auth` (`/server`) | 2.0.0 | `resolveAuth`: JWT verification and claim mapping |
| `@io-kit/feed` | 1.1.1 | `createUlidFactory`: monotonic ULIDs for record ids and audit sort keys |
| `jose` | 6.2.12 | `createRemoteJWKSet` for the session keys |
| `web-push` | 3.6.7 | Push delivery. Imported only when the VAPID keys load. |
| `@aws-sdk/*` | 3.1000.0 | DynamoDB document client, S3 and the S3 request presigner, Secrets Manager |

The `@io-kit/*` packages are private. They come from the io CodeArtifact npm registry that [`api/.npmrc`](../../api/.npmrc) configures for the `@io-kit` scope. `npm ci` reads the registry token from `CODEARTIFACT_AUTH_TOKEN` (`aws codeartifact get-authorization-token --domain io`).

## Request pipeline

Every request goes through these steps in order. The first step that fails decides the response.

1. **Origin check** ([`origin.js`](../../api/src/origin.js), called from `index.js`). The `x-origin-verify` header, matched in any case, must equal `ORIGIN_VERIFY`. The two values are compared as SHA-256 digests with a constant-time comparison. If `ORIGIN_VERIFY` is unset or empty, every request fails. Failure: `403` with the body `{"error":"forbidden"}`. This step runs before routing and before the handler is built.
2. **Prefix check.** Trailing slashes are removed from `rawPath`. A path outside `/api/`, including `/api` itself, is `404 not_found`.
3. **Route match.** `/api` is removed and the rest is matched against `ROUTES`. Path parameters are URL-decoded with `decodeURIComponent`. A path parameter with malformed percent-encoding (for example `%E0%A4%A`) makes it throw, which is `500 internal`, before the session is checked. No path match is `404 not_found`. A path that matches with a different method is `405 method_not_allowed`. That includes `OPTIONS` and `HEAD`: the API does no CORS handling.
4. **Session.** The session cookie must verify (see [Session verification](#session-verification)). Otherwise `401 unauthenticated`. Every route requires a session, reads included.
5. **Content type**, for `POST`, `PUT` and `PATCH` only. `content-type` must start with `application/json`, ignoring case. Otherwise `415 unsupported_media_type`.
6. **Body**, for `POST`, `PUT` and `PATCH` only. A base64-encoded body is decoded. An empty body counts as `{}`. A body that does not parse is `400 validation` ("invalid JSON body"). A body that parses to anything other than an object (an array, `null`, a string or a number) is `400 validation` ("body must be a JSON object"). `DELETE` bodies are not read here.
7. **Route handler.**

Because the session is checked at step 4, a request without a session to an unknown path gets `404`, and one with the wrong method gets `405`, not `401`.

On the first request in a container that passes step 1, `index.js` loads the VAPID keys (if configured) and builds the handler. Both are kept for the life of the container.

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

`details` appears only on kit errors that carry it. Post errors may carry `{"field": ...}` or `{"id": ...}`. Comment validation errors carry `{"field": ...}`. Any error that is not one of the API's or the kits' typed errors becomes `500` with `{"error":"internal","message":"internal error"}`, and the stack is logged. The origin-check `403` and the notification routes use shorter bodies, described in their sections.

Two statuses exist for validation. Checks on the request itself (body parsing, a missing `subject` on a comment route, upload input) return `400 validation`. Checks on post and comment content return `422 validation`.

| Status | `error` | Raised by |
| --- | --- | --- |
| 400 | `validation` | Unparseable or non-object body; missing `subject` on a comment route; upload input |
| 400 | `cursor_invalid` | A posts or comments cursor that is malformed, or a posts cursor from another filter |
| 401 | `unauthenticated` | No session cookie, or a token that fails verification |
| 403 | `forbidden` | Failed origin check; caller lacks the permission for a post or comment action |
| 403 | `self_react` | Reacting to your own comment |
| 404 | `not_found` | Unknown route; post missing or not visible to the caller; comment missing; malformed subject or comment id |
| 405 | `method_not_allowed` | Known path, other method |
| 409 | `conflict` | A post or comment write's transaction was cancelled, usually because the record changed or was deleted after it was read (see [Concurrent writes](#concurrent-writes)) |
| 415 | `unsupported_media_type` | A write without a JSON content type |
| 422 | `validation` | Post body, type, visibility, title, subject or attachments, or a post over the size cap; comment body; malformed subject on comment create; emoji |
| 500 | `server` | A comment create, edit or delete failed for a reason other than a cancelled transaction |
| 500 | `internal` | Anything else |
| 503 | `unavailable` | A post write failed for a reason other than cancellation; uploads with no presigner |

## Routes

All paths are under `/api`, and every route needs a session. Routes ignore body and query fields they do not name. The route names in the first column are the action names in [`caps.json`](#capsjson).

| Name | Method | Path | Input | Success | Notes |
| --- | --- | --- | --- | --- | --- |
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
| `author` | `{id, label}` | The caller's member id (gramps id) and display label |
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
- A cancelled transaction is `409 conflict` ("record changed concurrently"). See [Concurrent writes](#concurrent-writes). Any other store failure is `503 unavailable`.
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

## Comments and reactions

Comments and reactions are implemented in [`comments.js`](../../api/src/comments.js) against the `@io-kit/comments` contract.

### Comment object

`{id, threadId, parentId?, author: {id, label}, body, created_at, edited_at?, can: {edit, delete, react}}`

- `body` is trimmed, must not be empty, and may be at most 1000 characters after trimming. Otherwise `422`. The trimmed text is stored.
- `threadId` is the subject.

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
- A cancelled create, edit or delete transaction, such as an edit that races another edit or a delete, is `409 conflict` ("comment changed concurrently"). Any other store failure is `500 server`.
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
- If it cannot be read or parsed, the API logs "admin list unavailable (failing closed)", treats nobody as an admin, and tries again after 5 s.
- The Lambda role may read only `config/*` in the config bucket, so `ADMIN_LIST_KEY` must stay under `config/`.

### Recording a reason

- `DELETE /comments/:id?subject=...&reason=<text>` records `reason` on the audit item only when the caller is an admin and is not the comment's author. In every other case the parameter is ignored.
- Post deletes take no reason.

## Table layout

The API's items in the `hfy-app` table. The table definition and the auth edge's items are in [System architecture](architecture.md#dynamodb-table-hfy-app).

The keys of every item (`PK`, `SK`, the `GSI1` keys and `ttl`) are listed once, in [System architecture: Item layout](architecture.md#item-layout). The API writes post items, with their author and subject index items ([`content.js`](../../api/src/content.js)), comment and reaction items ([`comments.js`](../../api/src/comments.js)), audit items ([`txn.js`](../../api/src/txn.js)), and, through `@io-kit/notify`, push subscription and notification preference items.

What the items hold:

- All three post items carry `entity: "post"` and the full post under `post`, so a listing needs no second read.
- Comment items carry `entity: "comment"` and `comment`.
- Reaction items carry `entity: "reaction"`, `target` and `reaction`. There is one per member per target, and `target` is `root` or `comment:<id>`.
- Audit items are listed under [Audit records](#audit-records).

Code note: [`keys.js`](../../api/src/keys.js) exports `commentKeys` (`COMMENT#<id>` / `META`) and `gsiThread`. Neither is used, because comments live under `THREAD#<subject>` ([item layout](architecture.md#item-layout)).

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
| `comment_on_my_record` | Family tree | Someone commented on your record. | {actor} commented on your record. |
| `reply_to_me` | Family tree | Someone replied to you. | {actor} replied to you. |
| `new_family_post` | Family news | There is a new family post. | {actor} shared a new family post. |
| `mention` | Family tree | You were mentioned. | {actor} mentioned you. |

Level 0 carries no content. Level 1 adds the actor's display label, which the kit cleans and cuts to 80 characters. Each recipient chooses per type in their preferences. A type with no stored preference is enabled at level 0. If a level-1 message cannot be rendered, level 0 is sent.

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
{ "subject": "<mailto-or-https-contact>", "publicKey": "<vapid-public-key>", "privateKey": "<vapid-private-key>" }
```

It is read once per container. If `VAPID_SECRET` is unset, or the secret cannot be read or parsed (logged as "push disabled"), nothing is sent. The routes still store subscriptions and preferences, and `GET /notifications/vapid-public-key` returns `{"public_key": ""}`. The Lambda role may read the secret only when the stack's `VapidSecretName` parameter is set.

### Failure isolation

Notification fan-out runs after the write has committed and never fails the request ([`handler.js`](../../api/src/handler.js), `afterCommit`; [`notify.js`](../../api/src/notify.js)):

- **Push off.** With no VAPID keys loaded, the producers return at once and do no reads at all: no post lookup, no thread query for earlier commenters and no `SUB#` scan.
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

### When uploads fail

- The handler returns `503 unavailable` ("uploads are not configured") only when it was built without a presigner. `index.js` always supplies one, and `MEDIA_BUCKET` and `MEDIA_PUBLIC_BASE` have defaults, so the deployed function never returns `503` for missing `MEDIA_*` settings. A wrong bucket shows up later, as a failed PUT.
- The browser's PUT goes straight to S3 on another origin, so it needs the bucket CORS rule in [`media-bucket-cors.json`](../../infrastructure/cloudformation/media-bucket-cors.json): `PUT` from the site origin, with the `Content-Type` and `Content-Length` headers. The site bucket is not managed by `app-stack.yaml`, so that rule is applied by hand. Without it the browser blocks the PUT.
- The Lambda role may put objects only under `uploads/posts/*` in the media bucket (`PostPhotoUploads` in [`app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml)).
- The site deploy's sync excludes `uploads/*` (the `exclude` list in [`ci.manifest.yaml`](../../ci.manifest.yaml)), and the deploy role is denied `s3:PutObject` and `s3:DeleteObject` under `uploads/*` ([Repository operations](repository-operations.md#deploy-role-github-rolesyaml)), so uploaded photos survive site deploys.
- Photos are read back through the CloudFront `/uploads/*` behavior, which adds `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox; default-src 'none'; img-src 'self'` ([System architecture](architecture.md#request-routing)). Without that behavior, `/uploads/*` falls to the default behavior and is served without those headers.

## Environment

Read in [`index.js`](../../api/src/index.js). The stack sets each one from a parameter of [`app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml).

| Variable | Default in code | Stack parameter | Purpose |
| --- | --- | --- | --- |
| `ORIGIN_VERIFY` | none: **required** | `OriginVerifySecretName` | Expected `X-Origin-Verify` value. Unset or empty means every request is `403`. |
| `TABLE_NAME` | `hfy-app` | `TableName` | DynamoDB table |
| `SESSION_JWKS_URL` | `https://harrisonfamily.us/auth/.well-known/jwks.json` | `SessionJwksUrl` | Auth edge's public keys |
| `SESSION_ISSUER` | `https://harrisonfamily.us/auth` | `SessionIssuer` | Required `iss` |
| `SESSION_AUDIENCE` | `harrisonfamily-web` | `SessionAudience` | Required audience |
| `SESSION_COOKIE` | `io_id` | `SessionCookie` | Session cookie name |
| `ADMIN_LIST_BUCKET` | `<config-bucket>` | `ConfigBucket` | Bucket holding the admin list |
| `ADMIN_LIST_KEY` | `config/admins.json` | `AdminListKey` | Admin list key |
| `MEDIA_BUCKET` | `<site-bucket>` | `MediaBucket` | Bucket that uploads are presigned into |
| `MEDIA_PUBLIC_BASE` | `https://harrisonfamily.us` | `MediaPublicBase` | Origin that serves `uploads/`. Upload `publicUrl`s start with it, and attachment URLs must. |
| `VAPID_SECRET` | unset: push is not sent | `VapidSecretName` (left out when empty) | Secret holding the VAPID keys |

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
- **Actor.** `{id, label, admin}`. `id` is the token's `sub`, the member's gramps id. `label` is the display name the kit maps from the token (the `name` claim, then `email`, then the username claims), or `sub` if there is none. `admin` is whether `id` is on the admin list.

The API never holds the signing key. It sees only the public keys that the auth edge publishes, and its role has no access to the signing-key secret. See [Identity services](identity-services.md) and [How to rotate the session signing key](../how-to/rotate-the-session-signing-key.md).

## caps.json

`caps.json` is a machine-readable description of the API, built by `buildCaps` in [`routes.js`](../../api/src/routes.js).

- `npm run gen-caps` in `api/` runs [`scripts/gen-caps.mjs`](../../api/scripts/gen-caps.mjs) and writes `api/dist/caps.json`.
- `api/dist/` is gitignored, so the file is not in the repository. The package script regenerates it and ships it in the zip as `dist/caps.json`. No route serves it.
- The handler dispatches from `ROUTES` and `buildCaps` lists `ROUTES`, so the action list and the routes are generated from the same source and cannot drift.

| Field | Value |
| --- | --- |
| `name` | `hfy-api` |
| `version` | `0.1.0` (`API_VERSION` in `routes.js`) |
| `base_path` | `/api` |
| `auth` | `{scheme: "session-cookie", issuer_env: "SESSION_ISSUER", reads_require_session: true}` |
| `subjects` | `["person:<gramps_id>", "post:<ulid>"]` |
| `actions` | One per route: `{name, method, path, auth: "session", write, summary}`. `write` is true for every method except GET. |
| `content` | `{source: "posts", capabilities, post_types, visibilities}`. `capabilities`: `list`, `get`, `createDraft`, `update`, `setVisibility`, `delete`, `drafts` and `audit` are true; `subscribe` and `since` are false; `attachments` is `"metadata-only"`; `filters` are `subject`, `type`, `author`, `visibility`. |
| `comments` | `{reactions: "one-emoji-per-principal-per-comment", threading: "parentId (reply)", max_body: 1000, subject_param}` |
| `notifications` | `{types: <the four types>, default_level: 0}` |
| `audit` | `{item: "AUDIT#", fields: ["op", "id", "principal", "at", "before", "after"], ops: ["create", "update", "delete", "visibility"]}` |

Only `actions` is derived from the routes. The other fields are written by hand in `buildCaps` and differ from the code in two places:

- `audit.ops` leaves out the comment op `edit`, and `audit.fields` leaves out `reason`.
- `comments.subject_param` says the subject may be given in the query or the body on PATCH, DELETE and react. DELETE reads it from the query only.

## Packaging and deploy

[`scripts/ci/package-api.sh`](../../scripts/ci/package-api.sh) builds `dist/hfy-api.zip` at the repository root (`dist/` is gitignored). It works from a clean checkout and never uses `api/node_modules/`:

1. Exits unless `CODEARTIFACT_AUTH_TOKEN` is set.
2. Copies `api/src`, `api/scripts`, `package.json`, `package-lock.json` and `.npmrc` to a temporary directory.
3. Runs `npm ci --omit=dev --ignore-scripts` there, then removes `.npmrc` and the lockfile.
4. Runs `gen-caps` inside the stage, against the packages just installed, then removes `scripts/`. Exits 1 if `dist/caps.json` is missing or empty.
5. Copies `caps.json` to `api/dist/caps.json`, so the local copy matches the zip.
6. Zips the result with `-X`. The zip root holds `src/`, `node_modules/`, `package.json` and `dist/caps.json`, which matches the handler `src/index.handler`.

The zip is rolled out by the CloudFormation stack built from [`app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml). No script in the repository creates or names the stack. The CloudFront scripts in [`scripts/infra/`](../../scripts/infra/) default to `--stack hfy-app` when they read its outputs. The stack reads the code from `<code-bucket>` at `CodeKey` (default `lambda/hfy-api.zip`). The `/api/*` CloudFront behavior is added separately by [`add-api-behavior.sh`](../../scripts/infra/add-api-behavior.sh). No workflow builds or deploys hfy-api. The GitHub deploy role's `LambdaDeploy` statement names the function, but `ci.manifest.yaml` has no target for it (see [Why releases ship through a pipeline and feature flags](../explanation/release-model.md)). For the steps, see [How to deploy the app stack and its CloudFront behaviors](../how-to/deploy-the-app-stack.md).

`npm test` in `api/` runs the Vitest suites against an in-memory DynamoDB fake. CI does not run them. See [How to run the test suites](../how-to/run-the-tests.md).

## Related pages

- [System architecture](architecture.md): the table definition, the stack, IAM and buckets.
- [Identity services](identity-services.md): the auth edge that issues the session cookie and publishes the JWKS.
- [Front end](front-end.md): the islands that call this API.
- [Private data and secrets inventory](private-data-and-secrets.md): where secrets and private family data are kept.
- [Codebase map](codebase-map.md): where each capability lives.
- [How member content stays accountable](../explanation/member-content-design.md): why the permission, audit and notification rules are what they are, including the post body limit.
- [The identity model: one edge, one allowlist](../explanation/identity-model.md): how a sign-in becomes a member id.
- [How to diagnose sign-in and API failures](../how-to/diagnose-sign-in-and-api-failures.md): working from a status code back to its cause.
- [How to add or remove a family member's access](../how-to/manage-family-access.md): who can sign in.
