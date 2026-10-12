# Identity services

Reference for the services that sign members in and issue tokens: the auth edge, its MCP authorization server, and the legacy sign-in path.

This page describes what each service accepts, returns, stores and reads, and where that behavior lives in the code. For why identity is shaped this way, see [The identity model](../explanation/identity-model.md) and [Edge and origin design](../explanation/edge-and-origin-design.md). For how the API checks the session these services issue, see the [API reference](api.md). For secret names and private objects, see [Private data and secrets](private-data-and-secrets.md).

All values on this page come from the code in this repository and from the `@io-kit/auth` package pinned at `2.0.0` in [`auth/package.json`](../../auth/package.json). Much of the edge's behavior (kit routes, error codes, cookie attributes, refresh-store records, token claims, resolver normalization and the Cognito error mapping) lives in that package, not in this repository. The package is not vendored. It installs from a private registry, so its source is on disk only after `npm ci` in `auth/`. Each section below names the kit module it draws on, as a path under `auth/node_modules/@io-kit/auth/dist/src/`. Email addresses and Gramps IDs in examples are placeholders.

## Services at a glance

| Service | Code | Runtime | Reached at | Status |
| --- | --- | --- | --- | --- |
| Auth edge (`hfy-auth-edge`) | [`auth/`](../../auth/) | AWS Lambda, `nodejs22.x`, arm64 | `https://harrisonfamily.us/auth/*` and `/.well-known/oauth-authorization-server*` through CloudFront | Release-1 sign-in. `auth-v2.js` uses it only when `authV2` is on. The person and posts islands (`personV2`, `postsV2`) call `/auth/session` and link to `/auth/login` whatever `authV2` is. See [Client consumers](#client-consumers). |
| MCP authorization server | [`auth/src/oauth.js`](../../auth/src/oauth.js), inside `hfy-auth-edge` | Same Lambda | `/auth/authorize`, `/auth/token`, `/auth/register`, `/auth/revoke` and the discovery documents | On only when `MCP_REDIRECT_URIS` is set |
| `hfy-check-allowed` | [`lambda/hfy-check-allowed/`](../../lambda/hfy-check-allowed/) | AWS Lambda, defined outside this repository | `/api/check-allowed`, the endpoint set in the page configuration | Legacy. The default sign-in while `authV2` is off. |
| `getAllowlist` | [`functions/get-allowlist/`](../../functions/get-allowlist/) | Google Cloud Function (2nd gen), Python 3.11 | IAM-authenticated HTTP trigger | Legacy. Not used in any sign-in path. |

## Auth edge

### Runtime and mount

| Item | Value | Source |
| --- | --- | --- |
| Function | `hfy-auth-edge`: `nodejs22.x`, arm64, 512 MB, 15 s timeout, handler `src/index.handler` | [`infrastructure/cloudformation/app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml) |
| Entry point | Wires the AWS clients and builds the app on the first request | [`auth/src/index.js`](../../auth/src/index.js) |
| Mount adapter | Path mount, JWKS, `/auth/session`, host-only cookies | [`auth/src/edge.js`](../../auth/src/edge.js) |
| Dependencies | `@io-kit/auth` pinned to `2.0.0`, `jose` `6.2.12`. The AWS SDK v3 comes from the Lambda runtime and is not bundled. | [`auth/package.json`](../../auth/package.json) |
| Front door | Lambda Function URL with `AuthType: NONE`. Each request must carry the CloudFront `X-Origin-Verify` header (see [Failure responses](#failure-responses)). | [`auth/src/origin.js`](../../auth/src/origin.js), [`scripts/infra/add-auth-behavior.sh`](../../scripts/infra/add-auth-behavior.sh) |

The edge is built on the kit's `createEdgeApp` (kit `edge/deploy/app.js`), which is written for a dedicated `auth.<site>` host with its routes at the root. `createAuthEdge` in `edge.js` adapts it to the `/auth` path on the main site:

- **Mount.** Only `/auth` and `/auth/*` are served. Any other path returns `404 {"code":"NOT_FOUND"}`. The one exception is the root discovery document described under [MCP authorization server](#mcp-authorization-server).
- **Root routes.** The kit's root routes (`/login`, `/verify`, `/link`, `/password/forgot`, `/password/reset`) are reached as `/auth/<route>`.
- **Rewritten responses.** A `Location` header that points at one of those root routes gets the `/auth` prefix. In HTML responses, quoted absolute links to them are rewritten the same way.
- **Host-only cookies.** The `Domain` attribute is removed from every `Set-Cookie` value, both in the `cookies` array and in `set-cookie` headers. Cookies therefore belong to `harrisonfamily.us` only, even though the manifest declares `cookieDomain`.
- **Added routes.** `GET /auth/.well-known/jwks.json` and `GET /auth/session`. The kit does not ship either.
- **Return targets.** Every post-sign-in target is normalized by `safeReturnTo` (see [Return targets](#return-targets)) before the kit sees or sends it: the `returnTo` query of `/auth/login`, the `returnTo` in a `200` body from `/auth/password`, and the `Location` of a redirect from `/auth/callback` (HFY-R58).
- **Authorize return.** A request to `/auth/login?next=/auth/authorize?...` that has no `returnTo` is passed to the kit with `returnTo` set to the normalized `next` value, but only when that value still starts with `/auth/authorize?`. This is how a signed-out MCP authorization resumes after sign-in.
- **No self-service sign-up.** `POST /auth/verify` returns `410 {"code":"AUTH_FORBIDDEN","detail":"signup_disabled"}` before the kit sees it. Users are created only by `POST /auth/link` (see [Cognito user pool](#cognito-user-pool)), so there is nothing for `ConfirmSignUp` to confirm.
- **Forgot-password rate limit.** `POST /auth/password/forgot` is counted and limited before the kit sends any email (see [Forgot-password rate limit](#forgot-password-rate-limit)).

Requests are handled in this order:

1. Origin verification ([`auth/src/origin.js`](../../auth/src/origin.js)), before any routing.
2. Initialization, once per container. Init failures are retried on the next request.
3. `/.well-known/oauth-authorization-server/auth`, the root discovery document.
4. Paths outside `/auth` return 404.
5. `/auth/.well-known/jwks.json`.
6. `/auth/session`.
7. OAuth routes, if the authorization server is enabled.
8. `POST /auth/verify`, refused with `410`.
9. `POST /auth/password/forgot`, counted against the rate limit; a request over the limit stops here with `429`.
10. Everything else goes to the kit app, with `/auth/login`'s `returnTo` normalized first. The responses of `/auth/password` and `/auth/callback` are normalized afterwards.

### edge.manifest.json

[`auth/edge.manifest.json`](../../auth/edge.manifest.json) is the committed configuration. The kit's `validateManifest` (kit `edge/deploy/manifest.js`) checks it on startup, and that check rejects key material or secret-named keys in the file.

| Field | Value | Notes |
| --- | --- | --- |
| `version` | `1` | |
| `site` | `harrisonfamily.us` | |
| `authOrigin` | `https://harrisonfamily.us` | POST requests that send an `Origin` header must match this value. |
| `cookieDomain` | `.harrisonfamily.us` | The kit validator requires it. The mount adapter strips it from cookies. |
| `returnOrigins` | `["https://harrisonfamily.us"]` | An absolute `returnTo` is honored only for these origins. A relative path that starts with a single `/` is always honored. Anything else becomes `/`. |
| `idp.kind` | `cognito` | |
| `idp.userPoolId` | Placeholder | Replaced at runtime from `COGNITO_USER_POOL_ID`. The region is the part before `_`. |
| `idp.clientId` | Placeholder | Replaced at runtime from `COGNITO_CLIENT_ID`. |
| `idp.domain` | `https://harrisonfamily.us/auth` | |
| `providers[0]` | `{ "kind": "google", "mode": "gis_id_token" }` | `clientId` is replaced at runtime from `GOOGLE_CLIENT_ID`. |
| `providers[1]` | `{ "kind": "password" }` | Email and password, checked by Cognito. |
| `session.issuer` | `https://harrisonfamily.us/auth` | `iss` of every token the edge signs. It is also the OAuth issuer. |
| `session.audience` | `harrisonfamily-web` | `aud` of the ID token, and `client_id` of the session access token. |
| `session.kid` | `hfy-session-1` | Default key id. A `kid` stored in the signing secret overrides it. |
| `session.signingKeySecretName` | `harrisonfamily/auth-edge/session-signing-key` | Secrets Manager secret that holds the RS256 private key. |
| `session.accessTtlSeconds` | `3600` | Lifetime of the ID token, the access token and the `io_id` cookie. |
| `session.profile` | `installed` | Refresh profile: 30 days, sliding. |
| `store` | `{ "kind": "dynamodb", "tableEnv": "AUTH_TABLE" }` | The table name is read from `AUTH_TABLE`. |
| `resolver` | `{ "kind": "s3_allowlist", "bucket": "harrisonfamily", "key": "config/userGrampsID.json", "cacheSeconds": 300 }` | See [Principal resolution](#principal-resolution). |
| `theme` | `cssUrl` and three `--io-*` custom properties | Styling for the kit's pages. |
| `copy` | `title`, `subtitle`, `denied_body` | Overrides the kit's default page text. |

`loadManifest` in `edge.js` copies the manifest and fills in the three runtime ids. If `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID` or `GOOGLE_CLIENT_ID` is missing, it throws `environment variable <NAME> is not set`. Startup fails closed: every request then returns `500 {"code":"AUTH_CONFIG"}`. Set `EDGE_MANIFEST_PATH` to load the manifest from a different path.

### Endpoints

Every POST route below requires the header `X-Requested-With: io-kit`. If the request also sends an `Origin` header, it must equal `https://harrisonfamily.us`. Requests that fail either check get `403 {"code":"AUTH_FORBIDDEN"}`. The kit's JSON errors have the shape `{"code": "...", "detail": "..."}`, and `detail` is optional.

**Kit routes.** The sign-in page, the password lifecycle routes and `/auth/link` come from `createEdgeApp` (kit `edge/deploy/app.js`). The edge-handler routes `/auth/google`, `/auth/password`, `/auth/refresh`, `/auth/logout` and `/auth/callback` come from `createAuthEdgeHandler` (kit `edge/index.js`). Cognito error codes come from `cognitoPasswordAuthenticator` and `cognitoLifecycle` (kit `edge/deploy/idp.js`), and Google token checks, refresh and linking from kit `server/identity.js`.

| Method | Path | Request | Response |
| --- | --- | --- | --- |
| GET | `/auth/login?returnTo=` | | HTML sign-in page with the Google button and an email and password form. The page posts to the two routes below. |
| POST | `/auth/google` | `{ credential, profile? }` (a Google ID token) | `200 {ok, exp}` and session cookies. `400` for a malformed body. `401 AUTH_EXPIRED` for an invalid Google token (`detail` such as `expired`, `wrong_audience`, `email_unverified`). `403 AUTH_FORBIDDEN` with `not_allowlisted` or `link_conflict`. `503 AUTH_NETWORK` when Google's keys cannot be fetched. |
| POST | `/auth/password` | `{ email, password, returnTo?, profile? }` | `200 {ok, exp, returnTo}` and session cookies. `returnTo` is normalized by `safeReturnTo`. `401 invalid_credentials`. `403` with `unconfirmed`, `email_unverified`, `not_allowlisted` or `challenge_unsupported`. `503 AUTH_NETWORK`. |
| POST | `/auth/refresh` | `io_rt` cookie | `200 {idToken, accessToken, expiresIn, exp}` and rotated cookies. A missing cookie returns `401 AUTH_REFRESH_FAILED`. For an `ios_` token, an unknown, revoked, reused or expired token, or a failed principal lookup, also returns `401 AUTH_REFRESH_FAILED`, and clears `io_rt` and `io_id`. Only an error coded `AUTH_NETWORK` returns `503` and keeps the cookies. A token without the `ios_` prefix goes to Cognito instead, as described after this table. |
| POST | `/auth/logout` | `io_rt` cookie | `200 {ok: true, revoked}`, and clears `io_rt` and `io_id` whether or not anything was revoked. For an `ios_` token that is found, the refresh-token family is revoked and `revoked` is `true`. |
| GET, POST | `/auth/password/forgot` | POST `{ email }` | GET serves the page. POST returns `200 {ok: true}` and calls Cognito `ForgotPassword`. Errors other than network errors are swallowed, so the response never reveals whether an account exists. Over the rate limit: `429 {"code":"AUTH_FORBIDDEN","detail":"rate_limited"}` with `Retry-After`, and no email is sent. If the limiter cannot be reached: `503 {"code":"AUTH_NETWORK"}`, and no email is sent. |
| GET, POST | `/auth/password/reset` | POST `{ email, code, password }` | Calls Cognito `ConfirmForgotPassword`. `400 invalid_code` or `weak_password` on failure. |
| GET, POST | `/auth/verify` | POST `{ email, code }` | GET serves the kit's page. POST always returns `410 {"code":"AUTH_FORBIDDEN","detail":"signup_disabled"}`, and Cognito `ConfirmSignUp` is never called. |
| GET, POST | `/auth/link` | POST `{ password }` | Requires a signed-in visitor. GET lists the linked sign-in methods and offers to set a password when none is linked. POST sets the password (see [Cognito user pool](#cognito-user-pool)) and returns `{ok, linked}`. The edge rejects passwords shorter than 8 characters with `400 weak_password`, and the Cognito pool policy requires at least 12 characters with upper case, lower case and a number. A password that passes the edge check but fails the pool policy makes `AdminSetUserPassword` fail, which the kit returns as `503 AUTH_NETWORK`. `403 no_verified_email` means the signed-in `sub` has no link record, or its record holds no email. `403 not_allowlisted` means the email is no longer on the allowlist. `403 link_conflict` means the email now resolves to a different principal. A signed-out GET is redirected to `/auth/login?returnTo=%2Flink`, and a signed-out POST gets `401 AUTH_EXPIRED`. |

`/auth/callback` is also routed to the kit's hosted-UI callback. No configured provider starts that flow, because the manifest has no `broker` provider and `/auth/login` serves the page. A request to it redirects to `/?auth_error=login_failed`. The edge normalizes the `Location` of any redirect it returns.

### Return targets

`safeReturnTo` in [`auth/src/edge.js`](../../auth/src/edge.js) decides where a visitor may be sent after sign-in. The kit's own check rejects only CR, LF and backslash, so a value such as `/\t/evil.example` would pass it, and browsers strip the tab and land on another site. The edge replaces the kit's value with its own result:

| Value | Result |
| --- | --- |
| Not a string, empty, or longer than 2048 characters | `/` |
| Contains a control character (U+0000 to U+001F, U+007F) or a backslash | `/` |
| Resolves, with the WHATWG URL parser against `authOrigin`, to the site's own origin | Its path, query and fragment, unless that starts with `//`, which gives `/` |
| Resolves to an origin in `returnOrigins`, over `http` or `https` | The full URL |
| Anything else | `/` |

### Forgot-password rate limit

`POST /auth/password/forgot` is the only anonymous route that makes Cognito send an email, so the edge counts it in fixed windows before the kit runs (HFY-R58; [`auth/src/ratelimit.js`](../../auth/src/ratelimit.js)):

| Scope | Limit | Window |
| --- | --- | --- |
| Email and client IP together | 3 requests | 3600 s |
| Client IP, across emails | 10 requests | 86,400 s |

- **What counts.** Only requests the kit would act on: they carry `X-Requested-With: io-kit`, and their `Origin`, if present, is the site origin. Others are left to the kit, which refuses them with `403`.
- **Client IP.** `CloudFront-Viewer-Address` when present, otherwise the right-most `X-Forwarded-For` entry that CloudFront appended, otherwise the caller's source IP.
- **Over the limit.** `429 {"code":"AUTH_FORBIDDEN","detail":"rate_limited"}` with a `Retry-After` header giving the seconds until the latest exhausted window ends.
- **Limiter failure.** The route fails closed with `503 {"code":"AUTH_NETWORK"}`, logs `forgot-password rate limiter unavailable`, and sends no email.
- **Storage.** One counter item per key and window in the `AUTH_TABLE` table, updated with one atomic `ADD`. The key is a SHA-256 of the email and IP, so neither is stored. The item expires through the table's `ttl` attribute 300 s after its window ends. The keys are listed in [System architecture: Item layout](architecture.md#item-layout).

**Refresh tokens without the `ios_` prefix.** The kit treats a cookie that does not start with `ios_` as a Cognito refresh token, not as unknown. `/auth/refresh` sends it to Cognito `GetTokensFromRefreshToken` with the app client id. A network error, a Cognito 5xx or a 429 returns `503 AUTH_NETWORK` and keeps the cookies, and any other Cognito failure returns `401 AUTH_REFRESH_FAILED` and clears them. If Cognito accepts the token, `io_id` is set to Cognito's ID token, which `/auth/session` and the API reject because it does not carry the edge's issuer, audience and signing key. `/auth/logout` posts such a token to `<idp.domain>/oauth2/revoke`, which is `https://harrisonfamily.us/auth/oauth2/revoke`. The edge does not serve that path, so `revoked` is `false`.

**Unknown paths and wrong methods.** The handling depends on the route:

| Request | Response |
| --- | --- |
| An unknown path under `/auth/` | `404 {"code":"NOT_FOUND"}` |
| An edge-handler route (`/auth/google`, `/auth/password`, `/auth/refresh`, `/auth/logout`, `/auth/callback`) with the wrong method | `405 {"code":"AUTH_FORBIDDEN"}` |
| `/auth/login` with any method other than GET, or any request to bare `/auth` | The kit's HTML `404` page with the text "Not found" |
| `/auth/verify`, `/auth/link`, `/auth/password/forgot` or `/auth/password/reset` with any method other than GET | Handled as POST |

The OAuth routes have their own method handling, described under [MCP authorization server](#mcp-authorization-server).

The kit's HTML pages are sent with a nonce-based Content-Security-Policy, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. Every route except JWKS and discovery sends `Cache-Control: no-store`.

**Routes added by HFY** (in [`auth/src/edge.js`](../../auth/src/edge.js)):

| Method | Path | Response |
| --- | --- | --- |
| GET, HEAD | `/auth/.well-known/jwks.json` | `200 {"keys":[<public JWK>]}` with `Cache-Control: public, max-age=300`. Other methods return `405 {"code":"METHOD_NOT_ALLOWED"}`. |
| GET | `/auth/session` | Always `200`: `{authenticated: true, sub, grampsId, label}` or `{authenticated: false}`. `grampsId` equals `sub`. `label` is the token's display name, or `sub` when there is none. Other methods return `405 {"code":"METHOD_NOT_ALLOWED"}`. The `io_id` cookie is verified against the edge's own key, issuer and audience. A missing, expired or invalid cookie gives `{authenticated: false}`. |

The OAuth routes are listed under [MCP authorization server](#mcp-authorization-server).

### Principal resolution

A sign-in turns a verified email into a host principal, whose `sub` is a Gramps ID. The resolver is the kit's `s3_allowlist` (`buildResolver` and `parseAllowlist` in kit `edge/deploy/resolver.js`). It reads the S3 object named in the manifest, `config/userGrampsID.json` in the config bucket. `resolveHostPrincipal`, linking and the refresh checks are in kit `server/identity.js`.

The object is a JSON object that maps an email address to an entry:

```json
{
  "member-one@example.com": "<gramps_id>",
  "member-two@example.com": { "gramps_id": "<gramps_id>", "label": "<display name>", "roles": ["member", "<role>"] }
}
```

| Entry form | Resulting principal |
| --- | --- |
| A string | `sub` is the string, `label` is the email, `roles` is `["member"]`, `claims` is `{}`. |
| `{ gramps_id \| sub, label?, roles?, claims? }` | `sub` is `sub` if present, otherwise `gramps_id`. `label` defaults to the email, `roles` to `["member"]` and `claims` to `{}`. |
| An empty string, or an object with neither `sub` nor `gramps_id` | The entry is dropped. That email gets `403 not_allowlisted`. |

- **Matching.** Keys are trimmed and lower-cased when the object is parsed, and lookups are normalized the same way, so matching ignores case.
- **Cache.** The parsed object is cached for 300 s. If a refresh fails, the last good copy stays in use. If no copy was ever loaded, the lookup throws and the sign-in is denied.
- **Denial.** A lookup that returns nothing, an empty `sub` or an error ends in `403 {"code":"AUTH_FORBIDDEN","detail":"not_allowlisted"}`. For an HTML form POST, the kit serves its "access not granted" page with the manifest's `denied_body` text.
- **Tenant.** A string `claims.tenant` becomes the `custom:tenant` token claim.
- **Linking.** A link is recorded only for a verified email. An email that is already linked to a different principal is refused with `403 link_conflict`.
- **Refresh.** Every `/auth/refresh` resolves the principal again. If the email has been removed, the whole refresh family is revoked (`not_allowlisted`). A lookup that fails is treated the same way: if the allowlist was never loaded in the container (for example, an S3 read failure on a cold start), `resolveHostPrincipal` throws and the family is revoked as `not_allowlisted`, so a transient S3 error signs the member out. If the email now resolves to a different `sub`, the family is also revoked (`principal_changed`). Reusing an already-rotated refresh token revokes the family as well.

### Cognito user pool

Cognito checks email and password sign-ins. The edge mints its own session, and Cognito tokens never reach the browser. The pool and its app client are `UserPool` and `UserPoolClient` in [`infrastructure/cloudformation/app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml).

| Setting | Value |
| --- | --- |
| Pool name | `UserPoolName` parameter, default `hfy-users`. `DeletionPolicy: Retain`. |
| Username | Email (`UsernameAttributes: [email]`). `email` is required and auto-verified. |
| Self sign-up | Off (`AllowAdminCreateUserOnly: true`, HFY-R58). Only `AdminCreateUser` creates users. |
| Email change | `AttributesRequireVerificationBeforeUpdate: [email]`: a changed email stays unverified, and the old one stays in effect, until the new address confirms its code |
| Verification and reset email | Codes (`CONFIRM_WITH_CODE`), sent by Cognito's default sender (`COGNITO_DEFAULT`, about 50 emails a day for the account), or by SES when the `SesIdentityArn` stack parameter names a verified SES identity in the same region (`EmailSendingAccount: DEVELOPER`, with `From` set from `SesFromAddress` when given) |
| MFA | Off |
| Account recovery | Verified email |
| Password policy | At least 12 characters, with upper case, lower case and a number. Symbols are not required. Temporary passwords last 7 days. |
| App client | `hfy-web`, no secret. Supported identity provider `COGNITO` only. |
| Auth flows | `ALLOW_USER_PASSWORD_AUTH` and `ALLOW_REFRESH_TOKEN_AUTH` |
| `PreventUserExistenceErrors` | `ENABLED` |
| Client token lifetimes | Refresh token 30 days, access and ID tokens 60 minutes |

Because the pool is admin-create-only, Cognito's public `SignUp` API refuses every request, so a holder of the app client id cannot pre-register a member's email with a password of their own. A pool user still gets no session without an allowlist entry, because `POST /auth/password` resolves the principal after Cognito accepts the password (see [Principal resolution](#principal-resolution)).

**Password provisioning** (`POST /auth/link`, `cognitoProvisioner` in [`auth/src/cognito.js`](../../auth/src/cognito.js)). In order:

1. The email is normalized and resolved through the allowlist. A failed lookup, or no entry, is `403 not_allowlisted`. An entry for a different `sub` than the signed-in visitor is `403 link_conflict`. Nothing is created in Cognito before this check passes.
2. `AdminGetUser`. Only a `UserNotFoundException` leads to `AdminCreateUser`, with `MessageAction: SUPPRESS` and `email` plus `email_verified=true`. Any other error stops the request.
3. A user left from before the pool was locked down is repaired: an `UNCONFIRMED` user gets `AdminConfirmSignUp`, and a user whose `email_verified` is not `true` gets `AdminUpdateUserAttributes` setting it. The email is known to be verified, because it reached the edge through a verified sign-in.
4. `AdminSetUserPassword` with `Permanent: true`. The new password method is linked to the same principal.

**Cognito calls.**

| Call | Made by | Notes |
| --- | --- | --- |
| `InitiateAuth` (`USER_PASSWORD_AUTH`) | `POST /auth/password` | The edge uses the `email`, `email_verified`, `iss` and `sub` claims of the Cognito ID token. A challenge response is refused with `403 challenge_unsupported`. |
| `ForgotPassword`, `ConfirmForgotPassword` | The password lifecycle routes | Public client API calls (`fetch` to `cognito-idp.<region>.amazonaws.com`). `ForgotPassword` runs only within the rate limit. `ConfirmSignUp` is never called, because the edge refuses `POST /auth/verify`. |
| `AdminGetUser`, `AdminCreateUser`, `AdminConfirmSignUp`, `AdminUpdateUserAttributes`, `AdminSetUserPassword` | `POST /auth/link` | [Password provisioning](#cognito-user-pool), above. These calls go through the AWS SDK with the Lambda role (`CognitoAdminLink`). They are the only code that creates Cognito users. |

### Stored records

The edge uses the DynamoDB table named by `AUTH_TABLE` (`hfy-app` in the stack). Tokens and codes are stored only as hashes. The keys of every item (`PK`, `SK`, the `GSI1` keys and `ttl`) are listed once, in [System architecture: Item layout](architecture.md#item-layout). This table lists what each record holds, by its `PK` prefix. The kit records are written by kit `server/ddb.js`, and the `MCP*` records by the store in [`auth/src/oauth.js`](../../auth/src/oauth.js).

| Record (`PK` prefix) | Written by | Holds |
| --- | --- | --- |
| `REFRESH#` | Kit refresh store | Email, host `sub`, provider, IdP issuer and subject, profile, family, expiry, rotated or revoked flags |
| `FAMILY#` | Kit, on revoke | `revoked: true` |
| `LINK#` | Kit link store, wrapped by `hfyLinkStore` ([`auth/src/linkstore.js`](../../auth/src/linkstore.js)) | The providers linked for that email. The wrapper writes `GSI1SK` (equal to the item's `PK`) on every put, so `GSI1` indexes the item and the lookup by `sub` finds it (HFY-R58). A link item written without `GSI1SK` is repaired, with a conditional put, the next time it is read. |
| `RATE#` | [`auth/src/ratelimit.js`](../../auth/src/ratelimit.js) | A request counter `n` for one forgot-password window. No email or IP. |
| `MCPCODE#` | OAuth | Authorization code binding |
| `MCPRT#` | OAuth | MCP refresh token |
| `MCPRTUSED#` | OAuth | Marker for a used refresh token, with its family |
| `MCPFAM#` | OAuth | `revoked: true` |

### Cookies

All three cookies are `HttpOnly; Secure; SameSite=Lax` and have no `Domain` attribute, so they are host-only on `harrisonfamily.us`. The kit builds them in kit `edge/index.js`, the refresh token format comes from kit `server/identity.js`, and the refresh profiles are `REFRESH_PROFILES` in kit `providers.js`. The mount adapter in [`auth/src/edge.js`](../../auth/src/edge.js) removes `Domain`.

| Cookie | Value | Path | Max-Age | Set by | Cleared by |
| --- | --- | --- | --- | --- | --- |
| `io_id` | Host ID token (RS256 JWT) | `/` | 3600 s | `/auth/google`, `/auth/password`, `/auth/refresh` | `/auth/logout`, a failed refresh |
| `io_rt` | Opaque refresh token, `ios_` plus 32 random bytes in base64url | `/auth` | 2,592,000 s (30 days). Each refresh issues a new token and restarts the 30 days (the `installed` profile slides). | Same as `io_id` | Same as `io_id` |
| `io_pkce` | Hosted-UI login state and PKCE verifier | `/` | 600 s | Only the kit's hosted-UI login start, which no route on this mount reaches | `/auth/callback` |

A request body may set `profile` to `"standard"` (24 hours, absolute) or `"installed"` to override the manifest default. No client in this repository sends it.

The API reads `io_id` on `/api/*`. See the [API reference](api.md).

### Token claims

The kit signs both session tokens in `mint` in kit `server/identity.js`.

**ID token** (the `io_id` cookie value, and `idToken` in the `/auth/refresh` body). The header is `alg: RS256` with `kid` set to the session key id.

| Claim | Value |
| --- | --- |
| `iss` | `https://harrisonfamily.us/auth` |
| `sub` | Host principal: the Gramps ID from the allowlist |
| `aud` | `harrisonfamily-web` |
| `iat`, `exp` | `exp` is `iat` plus 3600 |
| `email` | Verified email, lower-cased |
| `email_verified` | `true` |
| `name` | Allowlist `label`. It defaults to the email. |
| `cognito:groups` | Allowlist `roles`. The default is `["member"]`. |
| `custom:tenant` | Present only when the entry has a string `claims.tenant` |
| `token_use` | `id` |

**Session access token** (`accessToken` in the `/auth/refresh` body only, never in a cookie). It carries the same `iss`, `sub`, `iat`, `exp`, `email`, `email_verified`, `name`, `cognito:groups` and `custom:tenant` claims as the ID token, has no `aud`, and adds:

| Claim | Value |
| --- | --- |
| `token_use` | `access` |
| `client_id` | `harrisonfamily-web` |
| `auth_time` | Equal to `iat` |
| `io:principal_type` | `human` |
| `io:provider` | `google:gis_id_token` or `password` |
| `io:idp_issuer`, `io:idp_sub` | Issuer and subject at Google or Cognito |

**Signing key.** `parseSigningSecret` in [`auth/src/index.js`](../../auth/src/index.js) accepts two secret formats:

- JSON `{"privateKeyPem": "...", "kid": "..."}`. `privateKey` or `pem` are accepted in place of `privateKeyPem`. If `kid` is absent, the manifest's `kid` is used. [`scripts/infra/create-session-key.sh`](../../scripts/infra/create-session-key.sh) writes this form.
- A bare PKCS8 PEM. The manifest's `kid` is used.

The public key is derived from the private key at startup. The JWKS publishes exactly one key, `{kty, n, e, kid, alg: "RS256", use: "sig"}`, with `max-age=300`. A token signed with any other key fails verification once a new key is live. MCP access tokens are signed with the same key and `kid`. To replace the key, see [Rotate the session signing key](../how-to/rotate-the-session-signing-key.md).

### MCP authorization server

[`auth/src/oauth.js`](../../auth/src/oauth.js) is an OAuth 2.1 authorization server for MCP clients. It runs in the same Lambda and uses the same sign-in cookie. It supports one public client, requires PKCE with S256, and accepts no client secret.

**Enablement and configuration** (set in `init()` in [`auth/src/index.js`](../../auth/src/index.js)):

| Setting | Source | Value |
| --- | --- | --- |
| Enabled | `MCP_REDIRECT_URIS` | On only when the variable has at least one entry. When it is off, `/auth/authorize`, `/auth/token`, `/auth/register`, `/auth/revoke` and both discovery URLs return `404 {"code":"NOT_FOUND"}`. |
| Issuer | `session.issuer` | `https://harrisonfamily.us/auth` |
| Client id | `MCP_CLIENT_ID` | `mcp-harrisonfamily` by default. The stack does not set this variable. |
| Redirect URIs | `MCP_REDIRECT_URIS`, comma-separated | Exact match. The stack default is `https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback`. |
| Resources | `MCP_RESOURCES`, comma-separated | Default `https://mcp.harrisonfamily.us`. The first entry is used when a request names no resource. |
| CORS origins | `MCP_CORS_ORIGINS`, comma-separated | See [CORS on OAuth routes](#cors-on-oauth-routes). |

**Discovery.** The same RFC 8414 document is served at:

- `https://harrisonfamily.us/.well-known/oauth-authorization-server/auth`, the path-insertion form for the issuer `https://harrisonfamily.us/auth`. CloudFront routes it to the edge.
- `https://harrisonfamily.us/auth/.well-known/oauth-authorization-server`

Both send `Cache-Control: public, max-age=300`.

| Metadata field | Value |
| --- | --- |
| `issuer` | `https://harrisonfamily.us/auth` |
| `authorization_endpoint` | `<issuer>/authorize` |
| `token_endpoint` | `<issuer>/token` |
| `registration_endpoint` | `<issuer>/register` |
| `revocation_endpoint` | `<issuer>/revoke` |
| `revocation_endpoint_auth_methods_supported` | `["none"]` |
| `jwks_uri` | `<issuer>/.well-known/jwks.json` |
| `response_types_supported` | `["code"]` |
| `grant_types_supported` | `["authorization_code", "refresh_token"]` |
| `code_challenge_methods_supported` | `["S256"]` |
| `token_endpoint_auth_methods_supported` | `["none"]` |
| `scopes_supported` | `["mcp"]` |
| `authorization_response_iss_parameter_supported` | `true` |

**Endpoints.**

| Method | Path | Body |
| --- | --- | --- |
| GET, HEAD | `/auth/authorize` | Query string |
| POST | `/auth/token` | Form-encoded, or JSON when `Content-Type` contains `json` |
| POST | `/auth/register` | Same as `/auth/token` |
| POST | `/auth/revoke` | Same as `/auth/token` |

A wrong method returns `405 {"error":"invalid_request","error_description":"use <METHOD>"}` with an `Allow` header. An unexpected failure, including an unreadable allowlist, returns `503 {"error":"server_error"}` and logs `oauth failure`. All responses other than discovery and a successful preflight send `Cache-Control: no-store` and `Pragma: no-cache`.

**`/auth/authorize` validation**, in order:

| Check | On failure |
| --- | --- |
| `client_id` is the configured client | `400 {"error":"invalid_request"}` as JSON, with no redirect |
| `redirect_uri` is present and on the list | `400 {"error":"invalid_request"}` as JSON, with no redirect |
| `response_type=code` | Redirect with `error=unsupported_response_type` |
| `code_challenge` is 43 base64url characters and `code_challenge_method=S256` | Redirect with `error=invalid_request` |
| `resource`, if given, is a configured resource | Redirect with `error=invalid_target` |
| The `io_id` cookie verifies | `302` to `/auth/login?next=<this authorize URL>`. The authorization resumes after sign-in. |
| The `sub` is a member (see [Membership groups](#membership-groups)) | Redirect with `error=access_denied` |

Every error redirect, and the success redirect, carries `iss`, and `state` when the client sent one. On success the redirect also carries `code`: 32 random bytes in base64url. The code can be used once and expires after 120 s. It is bound to the client, `redirect_uri`, `code_challenge`, `sub`, resource and scope. A requested `scope` is kept if it matches `[A-Za-z0-9:._/ -]{1,200}`. Otherwise the scope is `mcp`.

**`/auth/token` with `grant_type=authorization_code`:**

| Rule | On failure |
| --- | --- |
| `code`, `redirect_uri` and `code_verifier` are present | `400 invalid_request` |
| `client_id` equals the configured client. It is required for this grant. | `401 invalid_client` |
| `code_verifier` matches `[A-Za-z0-9._~-]{43,128}` | `400 invalid_request` |
| The code exists, has not expired, and matches the client and `redirect_uri`. The code is consumed even when a later check fails. | `400 invalid_grant` |
| `BASE64URL(SHA-256(code_verifier))` equals the stored challenge | `400 invalid_grant` |
| `resource`, if given, equals the authorized resource | `400 invalid_target` |
| The `sub` is still a member | `400 invalid_grant` |

**`/auth/token` with `grant_type=refresh_token`:**

| Rule | On failure |
| --- | --- |
| `refresh_token` is present | `400 invalid_request` |
| `client_id`, if sent, equals the configured client | `401 invalid_client` |
| The token is unused. If it was already used, its whole family is revoked. | `400 invalid_grant` |
| The token has not expired, the client matches, and the family is not revoked | `400 invalid_grant` |
| `resource`, if given, equals the granted resource | `400 invalid_target` |
| The `sub` is still a member | `400 invalid_grant` |

Any other `grant_type` returns `400 unsupported_grant_type`.

A successful grant returns `200 {access_token, token_type: "Bearer", expires_in: 3600, refresh_token, scope}`.

| Access-token field | Value |
| --- | --- |
| Header | `alg: RS256`, `kid` set to the session key id, `typ: at+jwt` |
| `iss` | `https://harrisonfamily.us/auth` |
| `sub` | The member's Gramps ID |
| `aud` | The resource, for example `https://mcp.harrisonfamily.us` |
| `iat`, `exp` | `exp` is `iat` plus 3600 (1 hour) |
| `jti` | 12 random bytes in base64url |
| `groups` | Membership groups at the time of issue |
| `scope` | Granted scope |
| `client_id` | The configured client |
| `token_use` | `access` |

**Refresh tokens.** An MCP refresh token is `hfyrt_` followed by 32 random bytes in base64url. It is stored only as a hash and can be used once. Each use returns a new refresh token in the same family with a new 30-day lifetime. Presenting a token that was already used revokes the whole family, so every token in it stops working. Membership is checked again on every grant.

**`/auth/register`** is a registration facade. It stores nothing and always returns the one fixed public client:

- `redirect_uris`, if sent, must be an array of strings (otherwise `400 invalid_client_metadata`), and every entry must be on the allowed list (otherwise `400 invalid_redirect_uri`).
- `token_endpoint_auth_method`, if sent, must be `none` (otherwise `400 invalid_client_metadata`).
- The response is `201 {client_id, client_name, token_endpoint_auth_method: "none", grant_types, response_types: ["code"], redirect_uris, scope: "mcp"}`. `client_name` is the requested name cut to 100 characters, or `Harrison Family MCP`. `redirect_uris` holds the requested URIs, or the whole allowed list when none were requested.

**`/auth/revoke`** (RFC 7009) returns `200 {}` for any token, whether or not it is known. A `client_id` that does not match the configured client returns `401 invalid_client`. The route-level responses also apply: `405` for a wrong method and `503 server_error` for a store failure, as described above, and `403` for a preflight from a disallowed origin (see [CORS on OAuth routes](#cors-on-oauth-routes)). When the token starts with `hfyrt_` and is known, either unused or as a used-token marker, its family is revoked. An unused token is also deleted. Access tokens cannot be revoked and expire within an hour.

### Membership groups

[`auth/src/membership.js`](../../auth/src/membership.js) decides who may hold an MCP token, and with which groups. `/auth/authorize` and both `/auth/token` grants call it.

| Item | Value |
| --- | --- |
| Allowlist | The resolver's object (`config/userGrampsID.json`), parsed with the kit's `parseAllowlist`, keyed by `sub` |
| Admin list | `ADMIN_LIST_KEY` (default `config/admins.json`) in the resolver's bucket. It is a JSON array of `sub` strings or `{"admins": [...]}`, and entries that are not strings are ignored. |
| Groups | `members`, plus every allowlist role except the default `member`, plus `admins` when the `sub` is on the admin list. Duplicates are removed. A `sub` that is not on the allowlist gets no groups and is refused. |
| Cache | 60 s. This cache is separate from the resolver's 300 s cache. |
| Allowlist read failure | If no copy has ever loaded, the call throws and the OAuth route returns `503 server_error` (fail closed). After a successful load, the last good copy stays in use and the read is retried 5 s later. |
| Admin list read failure | Logged as `admin list unavailable`. Nobody is an admin until a read succeeds. |

### CORS on OAuth routes

CORS applies to the discovery document, `/auth/token`, `/auth/register` and `/auth/revoke`. It does not apply to `/auth/authorize`, which is a top-level browser navigation.

- **Allow list.** `MCP_CORS_ORIGINS` is an exact list of origins. Each entry must match `^https://[^/*\s]+$`. A wildcard, a path or a non-https origin makes `createOAuthServer` throw at startup, so every request then returns `500 AUTH_CONFIG`. The stack default is `https://claude.ai,https://claude.com`.
- **Responses.** When the request's `Origin` is on the list, the response carries `Access-Control-Allow-Origin: <origin>`. Every response on these routes carries `Vary: Origin`. Requests without an `Origin` header, such as server-to-server calls, are unaffected.
- **No credentials.** `Access-Control-Allow-Credentials` is never sent.
- **Preflight.** `OPTIONS` from an allowed origin returns `204` with `Access-Control-Allow-Origin`, `Access-Control-Allow-Methods: <METHOD>, OPTIONS`, `Access-Control-Allow-Headers: Content-Type, Authorization`, `Access-Control-Max-Age: 600` and `Vary: Origin`. From any other origin it returns `403 {"error":"invalid_request","error_description":"origin not allowed"}`.

### Failure responses

| Condition | Status | Body |
| --- | --- | --- |
| `X-Origin-Verify` is missing or wrong, or `ORIGIN_VERIFY` is unset | 403 | `{"error":"forbidden"}` |
| Initialization failed, or any unhandled exception | 500 | `{"code":"AUTH_CONFIG"}` |
| Path outside `/auth` | 404 | `{"code":"NOT_FOUND"}` |
| `POST /auth/verify` | 410 | `{"code":"AUTH_FORBIDDEN","detail":"signup_disabled"}` |
| `POST /auth/password/forgot` over the rate limit | 429 | `{"code":"AUTH_FORBIDDEN","detail":"rate_limited"}`, with `Retry-After` |
| `POST /auth/password/forgot` with the limiter unavailable | 503 | `{"code":"AUTH_NETWORK"}` |
| OAuth route failure | 503 | `{"error":"server_error"}` |

The origin check runs before any routing, so the 403 applies to every path, including JWKS and both discovery URLs. It compares SHA-256 digests in constant time. A direct call to the Function URL, which does not pass through CloudFront, gets this 403. See [Rotate the origin-verify secret](../how-to/rotate-the-origin-verify-secret.md).

Initialization can fail for these reasons:

- a missing runtime id
- a manifest that fails validation
- an unreadable or malformed signing secret
- a missing `AUTH_TABLE`
- an invalid `MCP_CORS_ORIGINS`

The failure is logged as `{"msg":"hfy-auth-edge failed","error":"..."}`. The cached app is discarded, so the next invocation runs initialization again.

### Environment variables

Defined on `AuthFunction` in [`infrastructure/cloudformation/app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml) unless noted.

| Variable | Required | Stack source | Use |
| --- | --- | --- | --- |
| `ORIGIN_VERIFY` | Yes | Resolved from Secrets Manager `harrisonfamily/cloudfront/origin-verify` | Expected `X-Origin-Verify` value. If it is unset, every request is refused. |
| `COGNITO_USER_POOL_ID` | Yes | `UserPool` | Manifest `idp.userPoolId`, and the region |
| `COGNITO_CLIENT_ID` | Yes | `UserPoolClient` (`hfy-web`, no secret) | Manifest `idp.clientId` |
| `GOOGLE_CLIENT_ID` | Yes | `GoogleClientId` parameter | Required audience of Google ID tokens |
| `AUTH_TABLE` | Yes | `TableName` (`hfy-app`) | Refresh, link and OAuth records |
| `MCP_REDIRECT_URIS` | No | `McpRedirectUris` | Turns the authorization server on and lists its redirect URIs |
| `MCP_RESOURCES` | No | `McpResources` | Token audiences |
| `MCP_CORS_ORIGINS` | No | `McpCorsOrigins` | CORS allow list |
| `ADMIN_LIST_KEY` | No | `AdminListKey` | Admin list key. The default is `config/admins.json`. |
| `MCP_CLIENT_ID` | No | Not set | Overrides `mcp-harrisonfamily` |
| `EDGE_MANIFEST_PATH` | No | Not set | Overrides the manifest path |

The allowlist bucket and key come from the manifest, not from the stack. The stack parameters `ConfigBucket`, `AllowlistKey` and `AdminListKey` scope the function's `s3:GetObject` permission, so they must name the same objects. The role also allows DynamoDB item and query access on the table and its indexes, `secretsmanager:GetSecretValue` on the signing-key secret, and `AdminGetUser`, `AdminCreateUser`, `AdminSetUserPassword`, `AdminConfirmSignUp` and `AdminUpdateUserAttributes` on the user pool.

The `SesIdentityArn` and `SesFromAddress` stack parameters are not passed to the function. They set the user pool's email configuration (see [Cognito user pool](#cognito-user-pool)).

## Client consumers

**[`11ty/js/auth-v2.js`](../../11ty/js/auth-v2.js)** does nothing unless `authV2` is true. It reads the flag through `HFYFeatureFlags.resolveFlags()`, which honors the `?hfy_flags=` override, or from `/_data/flags.json` when that function is not available. `authV2` is `false` in the committed [`11ty/_data/flags.json`](../../11ty/_data/flags.json). With the flag on:

| Behavior | Detail |
| --- | --- |
| Session first | `GET /auth/session` (same-origin, `no-store`). If it does not answer with a JSON body whose `authenticated` is a boolean, the script drops the preview override and leaves the page to the legacy flow. |
| Redirect | On `/family-login/`, only a signed-out visitor is sent to `/auth/login?returnTo=%2F`. A visitor already signed in at the edge keeps the legacy sign-in on that page, because the edge session does not mint the legacy `X-HFY-Session` token. |
| Navigation | When `authenticated` is true, the script points `[data-my-record-link]` at `/person/?id=<sub>`, hides `familyLoginLink` and shows `logoutLink`. It applies these again after `load` and 600 ms later, because the legacy scripts toggle the same items. |
| Sign-out | Intercepts clicks on every `[data-auth-signout-link]`. Clears the legacy credentials, sends `POST /auth/logout` with `X-Requested-With: io-kit`, body `{}` and `keepalive`, waits for it for at most 4 s, then runs the legacy `signOut`, or goes to `/logged-out/` |

[Front end: `auth-v2.js` behavior](front-end.md#auth-v2js-behavior) has the details.

**Islands.** `getSession()` in [`islands/src/lib/api.js`](../../islands/src/lib/api.js) calls `GET /auth/session` with `credentials: "include"`. It returns `{authenticated: true, sub, label}` or `{authenticated: false}` and never throws. Island API calls made with `createApi` send the `io_id` cookie to `/api`. The comments thread in [`islands/src/lib/comments-ui.jsx`](../../islands/src/lib/comments-ui.jsx) calls `getSession()` and shows signed-out visitors a "Sign in to comment" link to `/auth/login?returnTo=<page>`.

These calls run whenever the island is loaded, whatever `authV2` is. The `loadIsland` calls in [`11ty/js/feature-flags.js`](../../11ty/js/feature-flags.js) load the islands on `personV2` and `postsV2`:

| Island | Loaded when | Edge calls |
| --- | --- | --- |
| `person` | `personV2` is on, on `/person/?id=` | The comments thread: `getSession()` and the sign-in link |
| `my-posts` | `postsV2` is on, on `/person/?id=` | `getSession()` |
| `posts` | `postsV2` is on, on `/posts/` | The comments thread, in the single-post view |
| `timeline` | `postsV2` is on, on `/` | None. It calls `/api` only. |

`personV2` and `postsV2` are `false` in the committed `flags.json`, and the `?hfy_flags=` override can turn them on.

No script in this repository calls `/auth/refresh`, so nothing renews `io_id` in the background. After its 3600 s lifetime, `/auth/session` returns `{authenticated: false}`. For the flag mechanism, see [Front end](front-end.md) and [Toggle a feature flag](../how-to/toggle-a-feature-flag.md).

## Legacy sign-in: hfy-check-allowed

[`lambda/hfy-check-allowed/index.mjs`](../../lambda/hfy-check-allowed/index.mjs) checks a Google ID token against the allowlist and returns an opaque session token.

- **Dependencies.** `google-auth-library`, `@aws-sdk/client-s3` and `@aws-sdk/client-secrets-manager` ([`package.json`](../../lambda/hfy-check-allowed/package.json)).
- **Deployment.** The kit build step runs [`scripts/ci/package-lambda.sh`](../../scripts/ci/package-lambda.sh) on Node 20, and the `lambda` target in [`ci.manifest.yaml`](../../ci.manifest.yaml) updates the function's code (`$LATEST`, no alias) on every push to `main` through [`io-kit-deploy.yml`](../../.github/workflows/io-kit-deploy.yml). A rollback after a failed smoke check re-uploads the previous release's zip. The function's runtime, environment and URL are not defined anywhere in this repository. See [Repository operations](repository-operations.md#workflows).

**Request.** `POST` with a JSON body `{ "id_token": "<Google ID token>", "context": "site" }`. `token` is accepted in place of `id_token`, and `context` is ignored. The site sends this request to `/api/check-allowed`, the `gateway.endpoint` in the page configuration.

**Checks**, in order:

1. The method is `OPTIONS` (answered with `204` and the CORS headers) or `POST`.
2. `id_token` or `token` is present.
3. The Google ID token verifies (`OAuth2Client.verifyIdToken` with audience `GOOGLE_CLIENT_ID`). A failure throws and produces a 500.
4. The payload has an email and `email_verified === true`. The email is trimmed and lower-cased.
5. The HMAC-SHA256 of the email (hex, keyed with the HMAC secret) is in the hash list, **and** the mapping has a truthy value for the email. Both are required.

**Response** (`200`):

| Field | Value |
| --- | --- |
| `allowed` | `true` |
| `grampsId` | The mapping value for the email |
| `sessionToken` | 32 random bytes in base64url |
| `issuedAt`, `expiresAt` | ISO 8601 timestamps |
| `expiresIn` | `SESSION_TTL_SECONDS` (default 900) |

The session token is not stored or recorded anywhere on the server, and no code in this repository can validate it.

**Errors:**

| Status | Body | Cause |
| --- | --- | --- |
| 400 | `{"allowed":false,"error":"missing id_token"}` | No `id_token` or `token` |
| 403 | `{"allowed":false,"error":"unverified email"}` | Missing email, or `email_verified` is not `true` |
| 403 | `{"allowed":false}` | Hash not listed, or no mapping value |
| 405 | `{"error":"Method Not Allowed"}` | A method other than `POST` or `OPTIONS` |
| 500 | `{"allowed":false,"error":"server error"}` | Invalid Google token, malformed JSON, or an S3 or Secrets Manager failure |

**Environment variables:**

| Variable | Default | Use |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | None | Token audience |
| `HASH_BUCKET`, `HASH_KEY` | `harrisonfamily`, `config/allowed_hashes.json` | JSON array of hex HMAC digests |
| `MAPPING_BUCKET`, `MAPPING_KEY` | `harrisonfamily`, `config/userGrampsID.json` | Email-to-Gramps-ID map. By default this is the same object the auth edge resolves against. |
| `SECRET_NAME` | `HFY_ALLOWLIST_HMAC_SECRET` | Secrets Manager secret that holds the HMAC key |
| `ALLOWED_ORIGINS` | Empty | Comma-separated CORS origins |
| `SESSION_TTL_SECONDS` | `900` | Session token lifetime |

**CORS.** `Access-Control-Allow-Origin` is set as follows:

- the request's `origin` header, when it is in `ALLOWED_ORIGINS`
- otherwise the first configured origin
- otherwise `*`

Responses also send `Access-Control-Allow-Methods: POST,OPTIONS`, `Access-Control-Allow-Headers: Content-Type` and `Vary: Origin`. No `Access-Control-Allow-Credentials` header is sent.

**Caching.** The hash list, the mapping and the HMAC secret are each loaded once and kept for the life of the container. They are never refreshed, so allowlist changes reach only new containers.

**Logs.** Log lines are prefixed `[HFY_CHECK_ALLOWED]`. Each request logs its request id, method, origin and path. Emails are logged only in redacted form: the first three characters of the local part, then `***@` and the domain. A match logs `grampsId` and `expiresAt`. An error logs the message and the stack.

**Differences from the edge on the shared mapping object:**

- The legacy lookup does not lower-case the stored keys, so a key with upper-case letters never matches.
- The legacy Lambda treats each mapping value as opaque, so an object-form entry written for the edge is returned to legacy clients as an object in `grampsId`.
- Both services deny an email whose Gramps ID is empty.

## Legacy client contract

| Piece | Behavior | Code |
| --- | --- | --- |
| Google sign-in | GIS popup. The client id is patched into `HFY_AUTH_CONFIG` at deploy time, replacing `REPLACE_WITH_GOOGLE_CLIENT_ID`. The Google ID token is kept in `localStorage` under `HFY_AUTH_ID_TOKEN`, and the Gramps ID under `HFY_AUTH_USER_GRAMPS_ID`. | [`11ty/js/auth.js`](../../11ty/js/auth.js) |
| Gateway session | `verifySession` POSTs to `gateway.endpoint`. On success it stores `{token, grampsId, expiresAt, verifiedAt}` in `sessionStorage` under `HFY_GATEWAY_SESSION_V1`. `requireSessionToken()` returns the token until `expiresAt`. | [`11ty/js/feature-flags.js`](../../11ty/js/feature-flags.js) |
| Protected JSON | Person and search requests send `X-HFY-Session: <token>`. On `harrisonfamily.us`, `gateway.enforceAssets` is forced to true, and search then waits up to 8 s for a token and fails without one. | `11ty/js/person-page.js`, `11ty/js/search-navbar.js`, `11ty/js/search-results.js` |
| Magic link | `requestMagicLink` and `verifyMagicLink` POST `{email}` and `{magic_token, email}` to the same endpoint. `hfy-check-allowed` has no magic-link branch, so both calls get `400 missing id_token`. | [`11ty/js/auth.js`](../../11ty/js/auth.js) |

The repository does not contain any server-side check of the `X-HFY-Session` header. No code here validates the token or rejects a request that lacks it. The repository also does not define the origin that serves `/api/check-allowed`. [`scripts/infra/add-api-behavior.sh`](../../scripts/infra/add-api-behavior.sh) routes `/api/*` to `hfy-api`, which has no `check-allowed` route, and keeps `/api/check-allowed` on the origin that served it before with a `/api/check-allowed*` behavior ordered ahead of `/api/*` (HFY-R58; see [Repository operations](repository-operations.md#the-legacy-apicheck-allowed-pin)).

## Legacy getAllowlist

[`functions/get-allowlist/main.py`](../../functions/get-allowlist/main.py) is a Google Cloud Function with the entry point `get_allowlist`.

| Item | Value |
| --- | --- |
| Deployment | [`deploy-gcf-legacy.yml`](../../.github/workflows/deploy-gcf-legacy.yml) on every push to `main`: `--gen2`, `--runtime=python311`, `--region=us-west2`, `--trigger-http`, `--no-allow-unauthenticated` (only IAM-authenticated callers can invoke it). A deploy with `--allow-unauthenticated` would make the stored email list public. Nothing rolls this deploy back. |
| Reads | Secret Manager secret `HFY_ALLOWLIST_SECRET` (default `harrisonfamily-allowlist`), latest version. The value may be a full `projects/...` resource path, or a secret name that is combined with `GCP_PROJECT`. |
| Returns | `200 {"allowlist": <secret value>}`, parsed as JSON when possible and otherwise the raw string. A failure returns `500 {"error":"allowlist_unavailable"}`. The function does not check the HTTP method. |
| Used by | Nothing in any sign-in path. No site script, Lambda or edge route calls it. It was used only as a manual check that an allowlist update had reached Secret Manager. |
| Status | Legacy. The workflow's first line marks it `retired by HFY-TSK-062`, but its triggers are active, so it still deploys. |

## Related pages

- [The identity model](../explanation/identity-model.md): why sign-in resolves to a Gramps ID, and why there are two paths.
- [Edge and origin design](../explanation/edge-and-origin-design.md): the CloudFront front door and the origin-verify header.
- [The release model](../explanation/release-model.md): why `authV2` ships dark.
- [API reference](api.md): how `hfy-api` verifies `io_id` against the JWKS.
- [Architecture](architecture.md) and [Codebase map](codebase-map.md).
- [Manage family access](../how-to/manage-family-access.md), [Deploy the app stack](../how-to/deploy-the-app-stack.md), [Rotate the session signing key](../how-to/rotate-the-session-signing-key.md), [Rotate the origin-verify secret](../how-to/rotate-the-origin-verify-secret.md), [Diagnose sign-in and API failures](../how-to/diagnose-sign-in-and-api-failures.md).
