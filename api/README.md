# hfy-api

Node 22 ESM Lambda (`src/index.handler`) behind CloudFront at `/api/*`. One handler, one route registry (`src/routes.js`).
Kits: `@io-kit/content` (posts, CS suite), `@io-kit/comments` (comments, CC suite), `@io-kit/notify/server` (push), `@io-kit/auth/server` (session cookie).

## Auth and permissions

Every route needs a session: the auth-edge cookie (`SESSION_COOKIE`, default `io_id`) is an RS256 token verified with `resolveAuth` against the public half of the signing key in Secrets Manager (`SESSION_JWKS_URL`; PEM or JSON `{privateKey, kid}`). `iss` must be `SESSION_ISSUER`, `aud` `SESSION_AUDIENCE`. No or bad cookie is 401. `sub` is the member's gramps_id.
Q-4: authors edit and delete their own posts and comments; admins (gramps_ids in `s3://$ADMIN_LIST_BUCKET/$ADMIN_LIST_KEY`, default `harrisonfamily/config/admins.json`, a JSON array or `{"admins": [...]}`, cached 60 s, fail closed) delete any. `can` is computed server-side on every item. POST/PUT/PATCH require `content-type: application/json` (CSRF defence with SameSite cookies).

## Routes (`/api`)

`GET|POST /comments?subject=`, `PATCH|DELETE /comments/:id` and `POST /comments/:id/react` (these three need `subject` in the query or body), `GET|POST /posts`, `GET|PATCH|DELETE /posts/:id`, `POST /posts/:id/visibility`, `GET /notifications/vapid-public-key`, `POST|DELETE /notifications/subscribe`, `GET|PUT /notifications/preferences`. Subjects: `person:<gramps_id>`, `post:<ulid>`. `node scripts/gen-caps.mjs` writes `dist/caps.json` from the registry.

## Table `hfy-app` (single table, GSI1, TTL `ttl`)

| Entity | PK | SK | GSI1PK / GSI1SK |
| --- | --- | --- | --- |
| Post | `POST#<id>` | `META` | `POSTS` / id |
| Post by author | `POST#<id>` | `IDX#AUTHOR` | `AUTHOR#<gramps_id>` / id |
| Post by subject | `POST#<id>` | `IDX#SUBJECT` | `SUBJECT#<subject>` / id |
| Comment | `THREAD#<subject>` | `C#<ulid>` | `COMMENTS` / id |
| Reaction | `THREAD#<subject>` | `R#<target>#<by>` | none |
| Push subscription (kit) | `SUB#<principal>` | `ENDPOINT#<endpoint>` | none, `ttl` |
| Preferences (kit) | `PREF#<principal>` | `PREFS` | none |
| Audit (D-15) | `AUDIT#<record id>` | `<iso at>#<ulid>` | `AUDIT` / same SK |

Post index items carry the full post so lists need no second read. Each create, edit, delete and visibility change is one `TransactWriteItems` containing the data change and its `AUDIT#` item `{op, id, principal, at, before, after}`.
Writes are optimistic: post update/visibility/delete are conditioned on the stored `post.updated_at` that was read, and comment edit/delete on `comment.edited_at` (absent = never edited). A concurrent change cancels the transaction and the API returns `409 conflict`, so nothing is silently overwritten and every audit `before` is the exact version replaced.

## Posts, threads and uploads

- Post fields are validated on create and PATCH (422): `title` string <= 200, `subject` a record id (`I0044`, `person:<id>`, `post:<ulid>`; `[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}`), `attachments` an array of <= 10 `{kind: image|file, url, mime, alt?, width?, height?}` whose `url` is a member upload (`$MEDIA_PUBLIC_BASE/uploads/posts/<ulid>/<name>` or that path relative); unknown attachment keys are dropped; the serialized post is capped at 100 KB.
- A `post:<ulid>` comment thread is exactly as visible as its post: list, create, edit and react are 404 when the viewer cannot see the post (draft, withdrawn, deleted). Deleting your own comment still works. Deleting a post purges its thread (comments and reactions), with a `delete` audit item (reason `post deleted`) per removed comment.
- Push fan-out and the thread purge run after the write commits and never fail the request; with no VAPID secret configured they do no reads at all.
- `POST /uploads` presigns a PUT to `s3://$MEDIA_BUCKET/uploads/posts/<ulid>/<safe-name>` (not `media/`, which the ETL sync mirrors with `--delete`). The URL signs `content-type` and `content-length` and carries no checksum parameters (`src/presign.js`), so the browser must PUT with exactly the returned `headers`. CloudFront serves `/uploads/*` with `X-Content-Type-Options: nosniff` and a `sandbox` CSP.

## Tests and packaging

`npm test` runs the CS and CC kit contract suites plus auth, audit, notification and caps tests against an in-memory DynamoDB fake. Install needs `CODEARTIFACT_AUTH_TOKEN`. `scripts/ci/package-api.sh` builds `dist/hfy-api.zip` from a clean checkout: it runs the locked `npm ci` in a stage and generates `dist/caps.json` there afterwards.

## MCP (`/mcp`)

Mounted in this Lambda at `https://harrisonfamily.us/mcp` on `@io-kit/mcp` 0.1.0; tools derive from the registry (`mcp` member of a route), authorization from `src/policy.js` + `config/groups.json`. See `docs/mcp.md`. `node scripts/gen-caps.mjs` also writes `dist/policy.json`, `dist/mcp/tools.json` and `dist/mcp/parity-caps.json`.

## Notes

The Function URL is AuthType NONE behind CloudFront (HFY-R43): every request must carry the secret `X-Origin-Verify` header that CloudFront injects (`ORIGIN_VERIFY`, from Secrets Manager `harrisonfamily/cloudfront/origin-verify`); anything else is 403 before routing.
