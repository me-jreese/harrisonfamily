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

## Tests and packaging

`npm test` runs the CS and CC kit contract suites plus auth, audit, notification and caps tests against an in-memory DynamoDB fake. Install needs `CODEARTIFACT_AUTH_TOKEN`. `scripts/ci/package-api.sh` builds `dist/hfy-api.zip`.

## Notes

The Function URL is AuthType NONE behind CloudFront (HFY-R43): every request must carry the secret `X-Origin-Verify` header that CloudFront injects (`ORIGIN_VERIFY`, from Secrets Manager `harrisonfamily/cloudfront/origin-verify`); anything else is 403 before routing.
