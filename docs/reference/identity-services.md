# Identity services

Reference for the services that sign members in, issue tokens and check them: the auth edge with its passkeys, its MCP authorization server and `/auth/userinfo`, the private data gate, and the retired legacy sign-in path.

This page describes what each service accepts, returns, stores and reads, and where that behavior lives in the code. For why identity is shaped this way, see [The identity model](../explanation/identity-model.md) and [Edge and origin design](../explanation/edge-and-origin-design.md). For how the API checks the session these services issue, see the [API reference](api.md). For how the MCP server checks the access tokens, see [MCP server](mcp-server.md). For secret names and private objects, see [Private data and secrets](private-data-and-secrets.md).

All values on this page come from the code in this repository and from the `@io-kit/auth` package pinned at `2.2.0` in [`auth/package.json`](../../auth/package.json). [`api/package.json`](../../api/package.json) pins the same version. Much of the edge's behavior (kit routes, page markup, passkey ceremonies, error codes, cookie attributes, refresh-store records, token claims, resolver normalization and the Cognito error mapping) lives in that package, not in this repository. The package is not vendored. It installs from a private registry, so its source is on disk only after `npm ci` in `auth/`. Each section below names the kit module it draws on, as a path under `auth/node_modules/@io-kit/auth/dist/src/`. `<site>` stands for the site's host name, and other values in angle brackets follow [Private data and secrets: Placeholders](private-data-and-secrets.md#placeholders). Email addresses and Gramps IDs in examples are placeholders.

## Services at a glance

| Service | Code | Runtime | Reached at | Status |
| --- | --- | --- | --- | --- |
| Auth edge (`hfy-auth-edge`) | [`auth/`](../../auth/) | AWS Lambda, `nodejs22.x`, arm64 | `https://<site>/auth/*` and `/.well-known/oauth-authorization-server*` through CloudFront | Production sign-in for every visitor: `authV2` on in [`11ty/_data/flags.json`](../../11ty/_data/flags.json) since 2026-10-12 (HFY-TSK-069). The `authV2` sign-in: Google, email and password, and passkeys. `auth-v2.js` and the session helpers in `feature-flags.js` use it when `authV2` resolves on for a page. The comments thread and the `my-posts` island call `/auth/session`, and several islands link to `/auth/login`, whatever `authV2` is. See [Client consumers](#client-consumers). |
| MCP authorization server | [`auth/src/oauth.js`](../../auth/src/oauth.js), inside `hfy-auth-edge` | Same Lambda | `/auth/authorize`, `/auth/token`, `/auth/register`, `/auth/revoke`, `/auth/userinfo` and the discovery documents | On in the stack, which sets `MCP_REDIRECT_URIS` from `McpRedirectUris`, whose default is non-empty. An empty value turns it off (see [MCP authorization server](#mcp-authorization-server)). |
| Private data gate (`hfy-edge-gate`) | [`edge-gate/`](../../edge-gate/) | Lambda@Edge, viewer-request, `nodejs22.x`, x86_64. Stack `hfy-edge-gate` in us-east-1. | The CloudFront behaviors that [`add-data-gate-behaviors.sh`](../../scripts/infra/add-data-gate-behaviors.sh) attaches it to: `/person/*.json`, `/family/*`, `/event/*`, `/note/*`, `/place/*`, `/media/*` and `/uploads/*` | Attached to the six data behaviors on 2026-10-12 at 12:40Z (HFY-R67). For `/uploads/*`, see [Where the gate is attached](#where-the-gate-is-attached). A second verifier of `io_id`, alongside the API and `/auth/session`. It protects only the behaviors that carry its association; a variant spelling that misses them gets a `404` from `HFYAppendIndex` instead (see [Gated behaviors](#gated-behaviors)). See [Private data gate: hfy-edge-gate](#private-data-gate-hfy-edge-gate). |
| `hfy-check-allowed` | None: deleted (HFY-TSK-326) | Was an AWS Lambda behind an API Gateway HTTP API, defined outside this repository | Nothing: deleted. `/api/check-allowed` now reaches `hfy-api`, which answers `404`. | Deleted on 2026-10-14 (ruling P2-R48), with its API Gateway, IAM role and log group. HFY-TSK-317 had already removed every caller and its deploy target. See [hfy-check-allowed (deleted)](#hfy-check-allowed-deleted). |
| `getAllowlist` | None: deleted (HFY-TSK-325) | Was a Google Cloud Function (2nd gen), Python 3.11 | Nothing: deleted | Deleted on 2026-10-14 with io's approval, with its Secret Manager secret. It was never used in any sign-in path. See [getAllowlist (deleted)](#getallowlist-deleted). |

## Auth edge

### Runtime and mount

| Item | Value | Source |
| --- | --- | --- |
| Function | `hfy-auth-edge`: `nodejs22.x`, arm64, 512 MB, 15 s timeout, handler `src/index.handler` | [`infrastructure/cloudformation/app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml) |
| Entry point | Wires the AWS clients, the identity service, the passkey service and the OAuth server, and builds the app on the first request | [`auth/src/index.js`](../../auth/src/index.js) |
| Mount adapter | Path mount, JWKS, `/auth/passkeys`, `/auth/session`, host-only cookies, return-target normalization, the forgot-password limit, and the HTML overrides on the kit's pages | [`auth/src/edge.js`](../../auth/src/edge.js) |
| Package | `dist/hfy-auth-edge.zip` holds `src/`, `edge.manifest.json`, `package.json` and the production dependencies. A change under `auth/src/` or to `auth/edge.manifest.json`, including the `theme.cssUrl` stamp that the islands build writes, reaches production only when `hfy-auth-edge` is redeployed through the app stack change set ([Deploy the app stack](../how-to/deploy-the-app-stack.md)). | [`scripts/ci/package-auth.sh`](../../scripts/ci/package-auth.sh) |
| Dependencies | `@io-kit/auth` pinned to `2.2.0`, `jose` `6.2.12`. The kit brings `@simplewebauthn/server` and `@simplewebauthn/browser` `13.1.2`. The AWS SDK v3 comes from the Lambda runtime and is not bundled. Development: `vitest` `3.2.4` and `@playwright/test` `1.55.0`. | [`auth/package.json`](../../auth/package.json), [`auth/package-lock.json`](../../auth/package-lock.json) |
| Scripts | `npm test` runs `vitest run`. `npm run e2e` runs [`auth/e2e/passkey.e2e.mjs`](../../auth/e2e/passkey.e2e.mjs): the edge app on `http://localhost` with in-memory stores, a synthetic allowlist and a Chromium virtual authenticator. It needs `npx playwright install chromium` first. `npm run e2e:theme` runs [`auth/e2e/signin-theme.e2e.mjs`](../../auth/e2e/signin-theme.e2e.mjs), described under [Page theme and HFY overrides](#page-theme-and-hfy-overrides). See [Run the tests](../how-to/run-the-tests.md). | [`auth/package.json`](../../auth/package.json) |
| Front door | Lambda Function URL with `AuthType: NONE`. Each request must carry the CloudFront `X-Origin-Verify` header (see [Failure responses](#failure-responses)). | [`auth/src/origin.js`](../../auth/src/origin.js), [`scripts/infra/add-auth-behavior.sh`](../../scripts/infra/add-auth-behavior.sh) |

The edge is built on the kit's `createEdgeApp` (kit `edge/deploy/app.js`), which is written for a dedicated `auth.<site>` host with its routes at the root. `createAuthEdge` in `edge.js` adapts it to the `/auth` path on the main site:

- **Mount.** Only `/auth` and `/auth/*` are served. Any other path returns `404 {"code":"NOT_FOUND"}`. The one exception is the root discovery document described under [MCP authorization server](#mcp-authorization-server).
- **Root routes.** The kit's root routes (`/login`, `/verify`, `/link`, `/password/forgot`, `/password/reset`) are reached as `/auth/<route>`.
- **Rewritten responses.** A `Location` header that points at one of those root routes gets the `/auth` prefix, and so does an encoded `returnTo` value that names one of them: the kit's signed-out `/link` redirect, `/login?returnTo=%2Flink`, becomes `/auth/login?returnTo=%2Fauth%2Flink`, so the member comes back to the account page after sign-in. In HTML responses, quoted absolute links to the root routes are rewritten the same way.
- **HTML overrides.** HTML responses also get the changes listed under [Page theme and HFY overrides](#page-theme-and-hfy-overrides).
- **Host-only cookies.** The `Domain` attribute is removed from every `Set-Cookie` value, both in the `cookies` array and in `set-cookie` headers. Cookies therefore belong to `<site>` only, even though the manifest declares `cookieDomain`.
- **Added routes.** `GET /auth/.well-known/jwks.json`, `GET /auth/passkeys` and `GET /auth/session`. The kit does not ship them (see [Routes added by HFY](#routes-added-by-hfy)).
- **Return targets.** Every post-sign-in target is normalized by `safeReturnTo` (see [Return targets](#return-targets)) before the kit sees or sends it: the `returnTo` query of `/auth/login`, the `returnTo` in a `200` JSON body from `/auth/password` and from `/auth/passkey/login/verify`, and the `Location` of a redirect from `/auth/callback` (HFY-R58).
- **Authorize return.** A request to `/auth/login?next=/auth/authorize?...` that has no `returnTo` is passed to the kit with `returnTo` set to the normalized `next` value, but only when that value still starts with `/auth/authorize?`. This is how a signed-out MCP authorization, or one that asked for a fresh sign-in, resumes after sign-in.
- **No self-service sign-up.** `POST /auth/verify` returns `410 {"code":"AUTH_FORBIDDEN","detail":"signup_disabled"}` before the kit sees it. Users are created only by `POST /auth/link` (see [Cognito user pool](#cognito-user-pool)), so there is nothing for `ConfirmSignUp` to confirm.
- **Forgot-password rate limit.** `POST /auth/password/forgot` is counted and limited before the kit sends any email (see [Forgot-password rate limit](#forgot-password-rate-limit)).

Requests are handled in this order:

1. Origin verification ([`auth/src/origin.js`](../../auth/src/origin.js)), before any routing.
2. Initialization, once per container. Init failures are retried on the next request.
3. `/.well-known/oauth-authorization-server/auth`, the root discovery document.
4. Paths outside `/auth` return 404.
5. `/auth/.well-known/jwks.json`.
6. `/auth/passkeys`: `GET` or `HEAD` gets a `302` to `/auth/link`, and any other method `405`.
7. `/auth/session`.
8. OAuth routes, including `/auth/userinfo`, if the authorization server is enabled.
9. `POST /auth/verify`, refused with `410`.
10. `POST /auth/password/forgot`, counted against the rate limit; a request over the limit stops here with `429`.
11. Everything else goes to the kit app, with `/auth/login`'s `returnTo` normalized first. The kit's response is then rewritten (cookies, `Location`, links and the HTML overrides). The JSON `returnTo` of `/auth/password` and `/auth/passkey/login/verify`, and the `Location` of a `/auth/callback` redirect, are normalized afterwards.

### edge.manifest.json

[`auth/edge.manifest.json`](../../auth/edge.manifest.json) is the committed configuration. The kit's `validateManifest` (kit `edge/deploy/manifest.js`) checks it on startup, and that check rejects key material or secret-named keys in the file.

| Field | Value | Notes |
| --- | --- | --- |
| `version` | `1` | |
| `site` | `<site>` | |
| `authOrigin` | `https://<site>` | POST and DELETE requests that send an `Origin` header must match this value. |
| `cookieDomain` | `.<site>` | The kit validator requires it. The mount adapter strips it from cookies. |
| `returnOrigins` | `["https://<site>"]` | An absolute `returnTo` is honored only for these origins. A relative path that starts with a single `/` is always honored. Anything else becomes `/`. |
| `idp.kind` | `cognito` | |
| `idp.userPoolId` | Placeholder | Replaced at runtime from `COGNITO_USER_POOL_ID`. The region is the part before `_`. |
| `idp.clientId` | Placeholder | Replaced at runtime from `COGNITO_CLIENT_ID`. |
| `idp.domain` | `https://<site>/auth` | |
| `providers[0]` | `{ "kind": "google", "mode": "gis_id_token" }` | `clientId` is replaced at runtime from `GOOGLE_CLIENT_ID`. `autoPrompt` is not set, so the kit (2.2.0) renders the GIS block with `data-auto_prompt="false"`: `/auth/login` shows the Google button but no automatic One Tap prompt (kit `edge/deploy/pages.js`; 2.1.x always wrote `"true"`). The kit's `validateManifest` accepts `autoPrompt` only as a boolean and only with mode `gis_id_token` (kit `edge/deploy/manifest.js`). |
| `providers[1]` | `{ "kind": "password" }` | Email and password, checked by Cognito. |
| `providers[2]` | `{ "kind": "passkey", "rpId": "<site>", "rpName": "Harrison Family", "origins": ["https://<site>"] }` | Turns on passkeys (see [Passkeys](#passkeys)). `rpId` is the WebAuthn relying-party ID, `rpName` the name an authenticator shows, and `origins` the page origins a ceremony may come from. The validator requires `origins` to be `https://` URLs. |
| `session.issuer` | `https://<site>/auth` | `iss` of every token the edge signs. It is also the OAuth issuer. |
| `session.audience` | `harrisonfamily-web` | `aud` of the ID token, and `client_id` of the session access token. |
| `session.kid` | `hfy-session-1` | Default key id. A `kid` stored in the signing secret overrides it. |
| `session.signingKeySecretName` | `harrisonfamily/auth-edge/session-signing-key` | Secrets Manager secret that holds the RS256 private key. |
| `session.accessTtlSeconds` | `3600` | Lifetime of the ID token, the access token and the `io_id` cookie. |
| `session.profile` | `installed` | Refresh profile: 30 days, sliding. |
| `store` | `{ "kind": "dynamodb", "tableEnv": "AUTH_TABLE" }` | The table name is read from `AUTH_TABLE`. |
| `resolver` | `{ "kind": "s3_allowlist", "bucket": "<config-bucket>", "key": "config/userGrampsID.json", "cacheSeconds": 300 }` | See [Principal resolution](#principal-resolution). |
| `theme.cssUrl` | `https://<site>/css/auth-edge.css?v=<sha8>` | The sign-in stylesheet (see [Page theme and HFY overrides](#page-theme-and-hfy-overrides)). `<sha8>` is the first 8 hex digits of the SHA-256 of `11ty/css/auth-edge.css`. The islands build ([`islands/assets.mjs`](../../islands/assets.mjs), `versionManifestCss`) rewrites this one value in place when it builds into `11ty/`, and `npm run check:islands` fails while it is stale. There is no `theme.vars`. |
| `theme.fontOrigins` | `["self"]` | Read by the kit (2.2.0) into the pages' CSP `font-src`, which lets the pages load the self-hosted fonts under `https://<site>/fonts/`. |
| `copy` | Every key of the kit's `DEFAULT_COPY` (kit `edge/deploy/manifest.js`): `title`, `subtitle`, `google_heading`, `password_heading`, `email_label`, `password_label`, `sign_in`, `forgot`, `verify_link`, `passkey_heading`, `passkey_button`, `passkey_failed`, `passkey_add_title`, `passkey_add_body`, `passkey_add`, `passkey_later`, `passkey_manage`, `passkey_remove`, `denied_title`, `denied_body`, `invalid_credentials`, `unconfirmed`, `generic_error`, `forgot_title`, `forgot_done`, `reset_title`, `verify_title`, `link_title`, `link_password`, `code_label`, `new_password_label`, `submit`, `done` | The family-voice text of the sign-in, password, passkey, denied, forgot and reset, verify and account (`/auth/link`) pages. No `DEFAULT_COPY` text is shown. The kit literals named under [On the kit pages](#on-the-kit-pages), the linked-method items on `/auth/link` (`<kind> (<email>)`, or `-` when none), and the HTML 404 text "Not found" remain. A test in [`auth/test/edge.test.js`](../../auth/test/edge.test.js) checks that every key is set. |

`loadManifest` in `edge.js` copies the manifest and fills in the three runtime ids. If `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID` or `GOOGLE_CLIENT_ID` is missing, it throws `environment variable <NAME> is not set`. Startup fails closed: every request then returns `500 {"code":"AUTH_CONFIG"}`. Set `EDGE_MANIFEST_PATH` to load the manifest from a different path.

### Endpoints

Every POST route below, and `DELETE /auth/passkey/<id>`, requires the header `X-Requested-With: io-kit`. If the request also sends an `Origin` header, it must equal `https://<site>`. Requests that fail either check get `403 {"code":"AUTH_FORBIDDEN"}`. The kit's JSON errors have the shape `{"code": "...", "detail": "..."}`, and `detail` is optional.

**Kit routes.** The sign-in page, the password lifecycle routes, `/auth/link` and `/auth/passkey/client.js` come from `createEdgeApp` (kit `edge/deploy/app.js`), and their HTML from kit `edge/deploy/pages.js`. The edge-handler routes `/auth/google`, `/auth/password`, `/auth/refresh`, `/auth/logout`, `/auth/callback` and `/auth/passkey/*` come from `createAuthEdgeHandler` (kit `edge/index.js`). Cognito error codes come from `cognitoPasswordAuthenticator` and `cognitoLifecycle` (kit `edge/deploy/idp.js`), Google token checks, refresh and linking from kit `server/identity.js`, and the passkey ceremonies from kit `server/passkey.js`.

| Method | Path | Request | Response |
| --- | --- | --- | --- |
| GET | `/auth/login?returnTo=` | | HTML sign-in page with three paths: the Google button (with no automatic One Tap prompt, see `providers[0]` under [edge.manifest.json](#edgemanifestjson)), an email and password form, and the passkey button (`id="pk-btn"`, labelled with the manifest's `passkey_button`). The email field has `autocomplete="username webauthn"`, so a browser with passkey autofill offers saved passkeys from that field. The page posts to `/auth/google`, `/auth/password` and the passkey routes. A failed sign-in shows the manifest text for its `detail`: `denied_body` for `not_allowlisted`, `invalid_credentials`, `unconfirmed`, `passkey_failed` for `passkey_unknown`, `passkey_assertion_failed` and `passkey_clone_suspected` (and for a passkey ceremony that throws), and otherwise `generic_error` (kit `edge/deploy/pages.js`, `ioFail`). See [Passkeys: On the kit pages](#on-the-kit-pages) and [Page theme and HFY overrides](#page-theme-and-hfy-overrides). |
| POST | `/auth/google` | `{ credential, profile? }` (a Google ID token) | `200 {ok, exp}` and session cookies. `400` for a malformed body. `401 AUTH_EXPIRED` for an invalid Google token (`detail` such as `expired`, `wrong_audience`, `email_unverified`). `403 AUTH_FORBIDDEN` with `not_allowlisted` or `link_conflict`. `503 AUTH_NETWORK` when Google's keys cannot be fetched. |
| POST | `/auth/password` | `{ email, password, returnTo?, profile? }` | `200 {ok, exp, returnTo}` and session cookies. `returnTo` is normalized by `safeReturnTo`. `401 invalid_credentials`. `403` with `unconfirmed`, `email_unverified`, `not_allowlisted` or `challenge_unsupported`. `503 AUTH_NETWORK`. |
| GET, POST, DELETE | `/auth/passkey/*` | See [Passkeys](#passkeys) | Passkey enrolment, sign-in, listing and removal. |
| POST | `/auth/refresh` | `io_rt` cookie | `200 {idToken, accessToken, expiresIn, exp}` and rotated cookies. A missing cookie returns `401 AUTH_REFRESH_FAILED`. For an `ios_` token, an unknown, revoked, reused or expired token, or a failed principal lookup, also returns `401 AUTH_REFRESH_FAILED`, and clears `io_rt` and `io_id`. Only an error coded `AUTH_NETWORK` returns `503` and keeps the cookies. A token without the `ios_` prefix goes to Cognito instead, as described after this table. See [Session refresh](#session-refresh). |
| POST | `/auth/logout` | `io_rt` cookie | `200 {ok: true, revoked}`, and clears `io_rt` and `io_id` whether or not anything was revoked. For an `ios_` token that is found, the refresh-token family is revoked and `revoked` is `true`. |
| GET, POST | `/auth/password/forgot` | POST `{ email }` | GET serves the page. POST returns `200 {ok: true}` and calls Cognito `ForgotPassword`. Errors other than network errors are swallowed, so the response never reveals whether an account exists. Over the rate limit: `429 {"code":"AUTH_FORBIDDEN","detail":"rate_limited"}` with `Retry-After`, and no email is sent. If the limiter cannot be reached: `503 {"code":"AUTH_NETWORK"}`, and no email is sent. |
| GET, POST | `/auth/password/reset` | POST `{ email, code, password }` | Calls Cognito `ConfirmForgotPassword`. `400 invalid_code` or `weak_password` on failure. The page shows its own text for these two, which the edge replaces (`kitVoice`, see [Page theme and HFY overrides](#page-theme-and-hfy-overrides)). |
| GET, POST | `/auth/verify` | POST `{ email, code }` | GET serves the kit's page. POST always returns `410 {"code":"AUTH_FORBIDDEN","detail":"signup_disabled"}`, and Cognito `ConfirmSignUp` is never called. |
| GET, POST | `/auth/link` | POST `{ password }` | Requires a signed-in visitor (a valid `io_id`). GET is the account page: it lists the linked sign-in methods, offers to set a password when none is linked, and lists the member's passkeys under the `passkey_manage` heading, with a `passkey_remove` button for each and a `passkey_add` button (the page script calls `/auth/passkey/list`, `/auth/passkey/register/*` and `DELETE /auth/passkey/<id>`). The edge adds a link back to `/` at the end of the page. POST sets the password (see [Cognito user pool](#cognito-user-pool)) and returns `{ok, linked}`. The edge rejects passwords shorter than 8 characters with `400 weak_password`, and the Cognito pool policy requires at least 12 characters with upper case, lower case and a number. A password that passes the edge check but fails the pool policy makes `AdminSetUserPassword` fail, which the kit returns as `503 AUTH_NETWORK`. `403 no_verified_email` means the signed-in `sub` has no link record, or its record holds no email. `403 not_allowlisted` means the email is no longer on the allowlist. `403 link_conflict` means the email now resolves to a different principal. A signed-out GET is redirected to `/auth/login?returnTo=%2Fauth%2Flink` (the kit sends `/login?returnTo=%2Flink`, and the edge mounts both), and a signed-out POST gets `401 AUTH_EXPIRED`. |

`/auth/callback` is also routed to the kit's hosted-UI callback. No configured provider starts that flow, because the manifest has no `broker` provider and `/auth/login` serves the page. A request to it redirects to `/?auth_error=login_failed`. The edge normalizes the `Location` of any redirect it returns.

### Passkeys

The manifest's `passkey` provider turns on WebAuthn sign-in (HFY-TSK-078). `init()` in [`auth/src/index.js`](../../auth/src/index.js) builds the service with the kit's `createPasskeyService` (kit `server/passkey.js`) and hands it, with the browser bundle from `loadPasskeyBrowserBundle()` (kit `edge/deploy/passkey-bundle.js`), to `createAuthEdge`. The kit serves the routes only when both the service and a `passkey` provider exist; otherwise every `/auth/passkey/*` request is `404 {"code":"NOT_FOUND"}`. A passkey is added to an existing member and never creates one.

**Settings** (from `init()`, with the kit defaults it does not override):

| Setting | Value |
| --- | --- |
| `rpID` | The provider's `rpId`, `<site>`. The fallback is the manifest's `site`. |
| `rpName` | The provider's `rpName`. The fallback is the manifest's `site`. |
| `origin` | The provider's `origins`, `["https://<site>"]`. The fallback is `authOrigin`. |
| `userVerification` | `preferred` (HFY-R67). Every ceremony asks the authenticator to verify the user, and none requires it. A sign-in without verification still succeeds, but its `amr` has no `mfa` (see [Token claims](#token-claims)). |
| `store` | `hfyPasskeyStore({ client, tableName })` from [`auth/src/passkeystore.js`](../../auth/src/passkeystore.js), wrapping the kit's `ddbPasskeyStore` (see [Stored records](#stored-records)) |
| `challenges` | The kit's `ddbChallengeStore`, in the same table |
| Challenge lifetime | 300 s (kit default `challengeTtlSeconds`). Each challenge can be used once. |
| Per-member limit | 20 passkeys (kit default `maxPerPrincipal`). A member who has 20 gets `403 passkey_limit` from `register/options`. |
| Ceremony timeout | 60 s, sent to the browser in the options |

**Routes.** "Session" means the `io_rt` refresh cookie, not `io_id`: the kit's passkey routes resolve `io_rt` with the identity service's `sessionOf`. That needs an `ios_` token whose record exists and is not revoked, rotated or expired, and whose email still resolves to the same `sub` on the allowlist. `io_rt` has `Path=/auth`, so the browser sends it to these routes. A route that needs a session and has none returns `401 {"code":"AUTH_EXPIRED"}`.

| Method | Path | Session | Request | Response |
| --- | --- | --- | --- | --- |
| POST | `/auth/passkey/register/options` | Required | `{}` | `200 {options}`: WebAuthn creation options. The credential must be discoverable (`residentKey: "required"`), attestation is `none`, `excludeCredentials` lists the member's existing passkeys, the user name is the session's email, the display name its label, and the user handle a SHA-256 of the `sub`. `403 passkey_limit` at the limit. |
| POST | `/auth/passkey/register/verify` | Required | `{ response, label? }` | `200 {ok: true, passkey}`. The challenge must be a registration challenge issued to the same `sub`. `label`, when it is a non-empty string, is stored cut to 80 characters. `403 passkey_exists` when the credential is already stored. `401 passkey_registration_failed` when verification fails. |
| POST | `/auth/passkey/login/options` | None | `{ hint? }` | `200 {options}`: WebAuthn request options. With no `hint` the sign-in is usernameless (`allowCredentials` is empty and the authenticator offers its discoverable credentials). A `hint` is a `sub`, and limits `allowCredentials` to that member's passkeys. |
| POST | `/auth/passkey/login/verify` | None | `{ response, returnTo?, profile? }` | `200 {ok: true, exp, returnTo}` and the same session cookies as every other sign-in. `returnTo` is normalized by the kit and again by `safeReturnTo`. Errors are listed below. |
| GET | `/auth/passkey/list` | Required | | `200 {passkeys: [{id, label?, createdAt, lastUsedAt?, transports?, deviceType, backedUp}]}`, oldest first. Only the caller's own passkeys. No `X-Requested-With` needed. |
| DELETE | `/auth/passkey/<id>` | Required | `<id>` is the URL-encoded credential id | `200 {ok: true}` when the credential belongs to the caller and is deleted. A credential of another member, or an unknown id, returns `404 {"code":"NOT_FOUND"}` and nothing is deleted. |
| GET | `/auth/passkey/client.js` | None | | `200`, the `@simplewebauthn/browser` UMD bundle (global `SimpleWebAuthnBrowser`) with `content-type: text/javascript; charset=utf-8`, `cache-control: public, max-age=3600` and `x-content-type-options: nosniff`. Served by `createEdgeApp` for GET only. |

Any other method or path under `/auth/passkey/` returns `404 {"code":"NOT_FOUND"}`.

**Sign-in rules** (`signInPasskey` in kit `server/identity.js`):

- **The allowlist is checked on every passkey sign-in.** The credential's stored email is resolved again. A member who has been removed gets `403 {"code":"AUTH_FORBIDDEN","detail":"not_allowlisted"}` and no cookies, even with a valid credential. A credential whose email now resolves to a different `sub` gets `403 principal_changed`.
- **Linking.** A successful sign-in records a `passkey` link for the email, with IdP issuer `webauthn:<site>` and the credential id as subject. An email linked to a different principal is refused with `403 link_conflict`.
- **Session.** The new session has provider `passkey`, `auth_time` set to now and the passkey `amr` (see [Token claims](#token-claims)).
- **Counter.** Each sign-in stores the authenticator's new signature counter and `lastUsedAt`. When the authenticator reports a counter that does not increase past the stored one, the sign-in returns `401 passkey_clone_suspected`.
- **Removed credentials.** A deleted passkey no longer signs in: `401 passkey_unknown`.

**Errors.** A rejected ceremony is `401 {"code":"AUTH_EXPIRED","detail":"<reason>"}`, where the reason is `passkey_malformed_response`, `passkey_challenge_unknown`, `passkey_challenge_expired`, `passkey_challenge_purpose`, `passkey_challenge_binding`, `passkey_unknown`, `passkey_user_handle_mismatch`, `passkey_assertion_failed`, `passkey_clone_suspected` or `passkey_registration_failed`. A refusal is `403 {"code":"AUTH_FORBIDDEN","detail":"<reason>"}` with `not_allowlisted`, `principal_changed`, `link_conflict`, `passkey_limit`, `passkey_exists` or `passkey_not_owned`. A network failure, and any other error, is `503 {"code":"AUTH_NETWORK"}`.

**Step-up routes.** The kit also serves `POST /auth/passkey/stepup/options` and `POST /auth/passkey/stepup/verify`, both with a session. The options list the caller's passkeys. A verified assertion from one of them (another member's credential is `403 passkey_not_owned`) returns `200 {method: "webauthn", auth_time, assertion, exp}`. `assertion` is an RS256 JWT signed with the session key, with header `typ: step-up+jwt` and claims `iss`, `sub`, `iat`, `exp` (300 s later), `auth_time`, `amr`, `acr: "aal2"`, `proof_method: "webauthn"` and `jti` (kit `server/identity.js`, `issueStepUpAssertion`). Nothing in this repository calls these routes or reads the assertion. The MCP step-up uses a fresh sign-in through `/auth/authorize` with `max_age` instead (see [MCP authorization server](#mcp-authorization-server)).

#### On the kit pages

From kit `edge/deploy/pages.js`:

- **Sign-in page.** The page loads `/auth/passkey/client.js`, and its Content-Security-Policy adds `'self'` to `script-src` for it. The passkey button runs `login/options`, the browser ceremony and `login/verify`, then goes to the returned `returnTo`. When the browser supports passkey autofill (conditional UI), the page also starts a `login/options` request on load and waits for the visitor to pick a passkey from the email field's suggestions.
- **The add-a-passkey prompt** (`id="pk-prompt"`, titled with `passkey_add_title`). After a Google or password sign-in, the page checks `/auth/passkey/list`. When the browser supports WebAuthn, the list is empty and the visitor has not dismissed the prompt before, the page hides the sign-in paths and shows `passkey_add_body` with two buttons, `passkey_add` and `passkey_later`. Adding runs `register/options` and `register/verify` with the label `navigator.platform` (or `This device`), then continues to the return target. `passkey_later` sets `io-passkey-dismissed` to `1` in `localStorage` and continues. A passkey sign-in never shows the prompt.
- **Account page.** `/auth/link` lists the member's passkeys by label (`Passkey` when there is none), removes one with `DELETE /auth/passkey/<id>`, and adds one the same way as the prompt. `/auth/passkeys` redirects there.
- **Text.** Every heading, button and message above comes from the manifest's `copy` keys named in [edge.manifest.json](#edgemanifestjson). The labels `navigator.platform`, `This device` and `Passkey` are kit literals.

### Page theme and HFY overrides

The kit renders every HTML page of the edge (`/auth/login`, `/auth/link`, `/auth/password/forgot`, `/auth/password/reset`, `/auth/verify`, the denied page and the HTML 404) in kit `edge/deploy/pages.js`, and sends them from kit `edge/deploy/app.js`.

**Response headers** of every kit HTML page:

| Header | Value |
| --- | --- |
| `Content-Type` | `text/html; charset=utf-8` |
| `Cache-Control` | `no-store` |
| `Content-Security-Policy` | Nonce-based, described below |
| `X-Frame-Options` | `DENY` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin`, also sent as `<meta name="referrer">` (`@io-kit/auth` 2.1.2 and later; older kits sent `no-referrer`). A cross-origin request carries only the origin, never the path or query. Why Google sign-in needs it: [The identity model: One edge, several methods](../explanation/identity-model.md#one-edge-several-methods). |

**Content-Security-Policy** (kit `cspFor`), with a fresh nonce per response. This manifest has a GIS provider, a passkey provider, a `cssUrl` on `https://<site>` and `fontOrigins: ["self"]`, so every page gets the same policy:

```text
default-src 'none'; script-src 'nonce-<nonce>' 'self' https://accounts.google.com/gsi/client; style-src 'unsafe-inline' https://<site> https://accounts.google.com/gsi/style; img-src https: data:; font-src 'self'; connect-src 'self' https://accounts.google.com/gsi/; frame-src https://accounts.google.com/gsi/; form-action 'self'; base-uri 'none'; frame-ancestors 'none'
```

- `style-src` names the stylesheet's origin only, so a new `?v=<sha8>` needs no policy change, and the stylesheet must be served from `https://<site>`.
- `font-src 'self'` comes from `theme.fontOrigins`, so the fonts must be served from `https://<site>` too.
- `'self'` in `script-src` is for `/auth/passkey/client.js`.

**Stylesheet.** `theme.cssUrl` points at [`11ty/css/auth-edge.css`](../../11ty/css/auth-edge.css), a repo-owned build output of [`islands/src/auth-edge/auth-edge.css`](../../islands/src/auth-edge/auth-edge.css). `islands/build.mjs` bundles the self-hosted font faces, the `@io-kit/tokens` harrisonfamily theme and kit bridge, and the sign-in rules into one same-origin file with no runtime `@import`. The kit links it ahead of its inline base stylesheet, whose colours, fonts and sizes read the `--io-auth-*` variables that the kit bridge declares. For why the sign-in pages have a stylesheet of their own, see [The design system theme layer: Why the sign-in pages have their own stylesheet](../explanation/design-system-theme-layer.md#why-the-sign-in-pages-have-their-own-stylesheet). It is not Eleventy output, so an Eleventy refresh must exclude it (see the repo-owned files table in [`11ty/README.md`](../../11ty/README.md)). For how it is built and versioned, see [Theme and asset build](theme-and-asset-build.md).

**Overrides.** `adapt()` in [`auth/src/edge.js`](../../auth/src/edge.js) rewrites each HTML response after the kit renders it. Each override records its kit root cause in a comment beside it, and [`auth/test/edge.test.js`](../../auth/test/edge.test.js) tests each one.

| Override | Applies to | Change |
| --- | --- | --- |
| `cspWithFontSrc` | The `Content-Security-Policy` of every HTML response | Appends `font-src 'self'` when the policy has no `font-src`. With 2.2.0 and `theme.fontOrigins` it changes nothing, and it stays as a guard. |
| `gisButtonDark` | The Google button | Sets the `g_id_signin` element's `data-theme` to `filled_black` (the kit writes `outline`) and `data-width` to `343` (the kit writes `280`). Google still draws the button. |
| `gisFocusRing` | Pages with a `.gsi` row and a script nonce | Appends a script, under the page's own nonce, that sets `data-gis-focus` on `.gsi` while keyboard focus is inside Google's iframe, and clears it when focus or a pointer returns to the page. The stylesheet draws the focus ring on that attribute, because the page cannot style the iframe's own ring. |
| `allowlistNotice` | Pages with the kit's `ioFail` (the sign-in page) and a script nonce | Wraps the kit's `ioFail` and `ioMsg`. A `not_allowlisted` failure marks its message `data-detail="not_allowlisted"`, which the stylesheet draws as a neutral notice rather than an error, and, when an email was typed, appends a button that copies it (or selects the field when the clipboard is refused). Any other message clears the mark. |
| `deniedNotice` | The `403` denied page | Marks the page's sentence `data-state="not_allowlisted"`, for the same notice style |
| `kitVoice` | The form pages (forgot, reset, verify) | Replaces the messages the kit hard-codes for `invalid_code` and `weak_password` with family-voice text. Only the exact kit literals are replaced. |
| `backToSite` | The signed-in `/auth/link` page | Appends a link back to `/` as the last element of `main` |

These changes, and any change to `auth-edge.css` (which changes `cssUrl`), reach production only with a redeploy of `hfy-auth-edge` (see [Runtime and mount](#runtime-and-mount)).

**End-to-end check.** `npm run e2e:theme` in `auth/` runs [`auth/e2e/signin-theme.e2e.mjs`](../../auth/e2e/signin-theme.e2e.mjs). It serves the real edge pages, with their real CSP header and the versioned `cssUrl`, on `http://localhost:$E2E_PORT` (default `4175`), and serves `/css` and `/fonts` from `SITE`, a scratch copy of the site built with `node build.mjs --site <dir>` in `islands/`. Without `SITE` it exits `2`. It drives Chrome (Playwright `channel: "chrome"`) at 375 and 1024 px wide over `/auth/login`, `/auth/password/forgot`, `/auth/password/reset`, a signed-out `/auth/link` and the denied page, with test-only wiring: a password stub, in-memory stores and a synthetic allowlist. `E2E_SHOTS=<dir>` saves a screenshot per page and width, and `E2E_OFFLINE=1` blocks the Google requests. It never contacts production.

### Return targets

`safeReturnTo` in [`auth/src/edge.js`](../../auth/src/edge.js) decides where a visitor may be sent after sign-in. The kit's own check rejects only CR, LF and backslash, so a value such as `/\t/evil.example` would pass it, and browsers strip the tab and land on another site. The edge replaces the kit's value with its own result, in the `/auth/login` query, in the JSON `returnTo` of `/auth/password` and `/auth/passkey/login/verify`, and in the `Location` of a redirect from `/auth/callback` (`sanitizeLocation`):

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
- **Client IP.** `CloudFront-Viewer-Address` when present, except that when that address is inside Cloudflare's committed ranges (`auth/src/cloudflare-ranges.js`, pinned with its source date by a test) the `CF-Connecting-IP` header is used instead, and a `CF-Connecting-IP` from any other viewer is ignored. The accepted address is returned in one canonical spelling (lowercase IPv6, IPv4-mapped as dotted IPv4), so equivalent spellings share a counter. The trust is range-based: any Cloudflare tenant that proxies to the origin is believed about its own client address. The committed list is a snapshot of `cloudflare.com/ips-v4` and `ips-v6` and goes stale, so refresh it by hand from time to time and update the pinned list and date together. Otherwise the right-most `X-Forwarded-For` entry that CloudFront appended, otherwise the caller's source IP.
- **Over the limit.** `429 {"code":"AUTH_FORBIDDEN","detail":"rate_limited"}` with a `Retry-After` header giving the seconds until the latest exhausted window ends.
- **Limiter failure.** The route fails closed with `503 {"code":"AUTH_NETWORK"}`, logs `forgot-password rate limiter unavailable`, and sends no email.
- **Storage.** One counter item per key and window in the `AUTH_TABLE` table, updated with one atomic `ADD`. The key is a SHA-256 of the email and IP, so neither is stored. The item expires through the table's `ttl` attribute 300 s after its window ends. The keys are listed in [System architecture: Item layout](architecture.md#item-layout).

**Refresh tokens without the `ios_` prefix.** The kit treats a cookie that does not start with `ios_` as a Cognito refresh token, not as unknown. `/auth/refresh` sends it to Cognito `GetTokensFromRefreshToken` with the app client id. A network error, a Cognito 5xx or a 429 returns `503 AUTH_NETWORK` and keeps the cookies, and any other Cognito failure returns `401 AUTH_REFRESH_FAILED` and clears them. If Cognito accepts the token, `io_id` is set to Cognito's ID token, which `/auth/session`, the API and the data gate reject because it does not carry the edge's issuer, audience and signing key. `/auth/logout` posts such a token to `<idp.domain>/oauth2/revoke`, which is `https://<site>/auth/oauth2/revoke`. The edge does not serve that path, so `revoked` is `false`.

**Unknown paths and wrong methods.** The handling depends on the route:

| Request | Response |
| --- | --- |
| An unknown path under `/auth/` | `404 {"code":"NOT_FOUND"}` |
| An unknown path or method under `/auth/passkey/`, including `HEAD /auth/passkey/client.js` | `404 {"code":"NOT_FOUND"}` |
| An edge-handler route (`/auth/google`, `/auth/password`, `/auth/refresh`, `/auth/logout`, `/auth/callback`) with the wrong method | `405 {"code":"AUTH_FORBIDDEN"}` |
| `/auth/login` with any method other than GET, or any request to bare `/auth` | The kit's HTML `404` page with the text "Not found" |
| `/auth/verify`, `/auth/link`, `/auth/password/forgot` or `/auth/password/reset` with any method other than GET | Handled as POST |

The OAuth routes have their own method handling, described under [MCP authorization server](#mcp-authorization-server).

Every route except JWKS, discovery and `/auth/passkey/client.js` sends `Cache-Control: no-store`. The headers of the HTML pages are listed under [Page theme and HFY overrides](#page-theme-and-hfy-overrides).

#### Routes added by HFY

In [`auth/src/edge.js`](../../auth/src/edge.js):

| Method | Path | Response |
| --- | --- | --- |
| GET, HEAD | `/auth/.well-known/jwks.json` | `200 {"keys":[<public JWK>]}` with `Cache-Control: public, max-age=300`. Other methods return `405 {"code":"METHOD_NOT_ALLOWED"}`. |
| GET, HEAD | `/auth/passkeys` | `302` to `/auth/link`, the kit's account page, which lists and removes the member's passkeys. `Cache-Control: no-store`. Other methods return `405 {"code":"METHOD_NOT_ALLOWED"}`. |
| GET | `/auth/session` | Always `200`: `{authenticated: true, sub, grampsId, label, exp}` or `{authenticated: false}`. Other methods return `405 {"code":"METHOD_NOT_ALLOWED"}`. Details below. |

**`/auth/session`.** The `io_id` cookie is verified against the edge's own key, issuer and audience, and must be an ID token (`token_use: id`). A missing, expired or invalid cookie gives `{authenticated: false}`. A valid one gives:

| Field | Value |
| --- | --- |
| `sub` | The member's Gramps ID |
| `grampsId` | Equal to `sub` |
| `label` | The token's `name` claim, which is the allowlist `label`. The allowlist defaults it to the email, so `label` may be the email. With no `name` it is the token's email, and with neither the `sub`. |
| `exp` | When `io_id` expires, in epoch seconds (HFY-R66). The cookie is HttpOnly, so this is how a page knows to call `POST /auth/refresh` before the session lapses. |

The response never carries `email`, `amr` or `auth_time` as fields of their own. It is sent with `Cache-Control: no-store`.

The OAuth routes are listed under [MCP authorization server](#mcp-authorization-server).

### Principal resolution

A sign-in turns a verified email into a host principal, whose `sub` is a Gramps ID. The resolver is the composite resolver in [`auth/src/allowlist.js`](../../auth/src/allowlist.js) (HFY-TSK-134). `index.js` passes it to `createIdentityService` and to `cognitoProvisioner`. It checks DynamoDB `ALLOW#` items first and the kit's `s3_allowlist` second (`buildResolver` and `parseAllowlist` in kit `edge/deploy/resolver.js`), which reads the S3 object named in the manifest, `config/userGrampsID.json` in `<config-bucket>`. The manifest's resolver stays `s3_allowlist`, so `auth/edge.manifest.json` is unchanged. `resolveHostPrincipal`, linking and the refresh checks are in kit `server/identity.js`.

#### Composite precedence

For one email, the composite resolver decides in this order:

| DynamoDB `ALLOW#<email>` | S3 file | Result |
| --- | --- | --- |
| `active` | listed or not | The principal: `sub` from the item, `label` the email, `roles` `["member"]`, `claims` `{}`. The item's `sub` wins over the file's. |
| `revoked` | listed or not | `null`, so `403 not_allowlisted`. A revoked item beats the file. |
| any other `state`, or no `sub` | any | `null`. A malformed item denies; it does not fall through. |
| no item | listed | The file's principal, exactly as before. |
| no item | not listed | `null` |
| read fails | listed | The file's principal. |
| read fails | not listed | `null`. If the file has never loaded either, the lookup throws, which denies. |

The item is read with a strongly consistent `GetItem` on every lookup and is not cached, so a revoke applies to the next sign-in, passkey sign-in, password set and refresh. The S3 file keeps its 300 s cache. With no `ALLOW#` item in the table, the resolver answers exactly as the S3 resolver alone does. A DynamoDB error is logged by error name only, never with an address.

The items, their keys and who writes them are in [Allowlist grants in DynamoDB](../how-to/manage-family-access.md#allowlist-grants-in-dynamodb). The legacy `hfy-check-allowed` Lambda never read them, and it was deleted on 2026-10-14.

The object is a JSON object that maps an email address to an entry:

```json
{
  "member-one@example.com": "<gramps-id>",
  "member-two@example.com": { "gramps_id": "<gramps-id>", "label": "<display name>", "roles": ["member", "<role>"] }
}
```

| Entry form | Resulting principal |
| --- | --- |
| A string | `sub` is the string, `label` is the email, `roles` is `["member"]`, `claims` is `{}`. |
| `{ gramps_id \| sub, label?, roles?, claims? }` | `sub` is `sub` if present, otherwise `gramps_id`. `label` defaults to the email, `roles` to `["member"]` and `claims` to `{}`. |
| An empty string, or an object with neither `sub` nor `gramps_id` | The entry is dropped. That email gets `403 not_allowlisted`. |

- **Matching.** Keys are trimmed and lower-cased when the object is parsed, and lookups are normalized the same way, so matching ignores case.
- **Cache.** The parsed object is cached for 300 s. If a refresh fails, the last good copy stays in use. If no copy was ever loaded, the lookup throws and the sign-in is denied.
- **Denial.** A lookup that returns nothing, an empty `sub` or an error ends in `403 {"code":"AUTH_FORBIDDEN","detail":"not_allowlisted"}`. For an HTML form POST, the kit serves its denied page, `403` HTML with the manifest's `denied_title` and `denied_body`, and the edge marks that sentence `data-state="not_allowlisted"` (`deniedNotice`). On the sign-in page, the edge turns a `not_allowlisted` failure into a neutral notice with a button that copies the typed email (`allowlistNotice`, see [Page theme and HFY overrides](#page-theme-and-hfy-overrides)).
- **Tenant.** A string `claims.tenant` becomes the `custom:tenant` token claim.
- **Linking.** A link is recorded only for a verified email. An email that is already linked to a different principal is refused with `403 link_conflict`.
- **Passkey sign-in.** Every passkey sign-in resolves the credential's email again (see [Passkeys](#passkeys)). So do the passkey routes that need a session, through `sessionOf`.
- **Refresh.** Every `/auth/refresh` resolves the principal again. If the email has been removed, the whole refresh family is revoked (`not_allowlisted`). A lookup that fails is treated the same way: if the allowlist was never loaded in the container (for example, an S3 read failure on a cold start), `resolveHostPrincipal` throws and the family is revoked as `not_allowlisted`, so a transient S3 error signs the member out. If the email now resolves to a different `sub`, the family is also revoked (`principal_changed`). Reusing an already-rotated refresh token revokes the family as well. The response does not say which of these happened: every one is `401 AUTH_REFRESH_FAILED`.

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

The edge uses the DynamoDB table named by `AUTH_TABLE` (`hfy-app` in the stack). Tokens, codes and the forgot-password keys are stored only as hashes. The keys of every item (`PK`, `SK`, the `GSI1` keys and `ttl`) are listed once, in [System architecture: Item layout](architecture.md#item-layout). This table lists what each record holds, by its `PK` prefix. The kit records are written by kit `server/ddb.js` (refresh, family, link) and kit `server/passkey.js` (passkeys and challenges), and the `MCP*` records by the store in [`auth/src/oauth.js`](../../auth/src/oauth.js).

| Record (`PK` prefix) | Written by | Holds |
| --- | --- | --- |
| `REFRESH#` | Kit refresh store | Email, host `sub`, provider, IdP issuer and subject, profile, family, expiry, `authTime` (the time of the sign-in that started the family, carried to every rotated record) and `amr`, plus the rotated or revoked flags |
| `FAMILY#` | Kit, on revoke; or an operator, by hand, in [Sign a member out on every device](../how-to/manage-family-access.md#sign-a-member-out-on-every-device) | `revoked: true`. Any item under the key revokes the family: the kit only checks that it exists. |
| `LINK#` | Kit link store, wrapped by `hfyLinkStore` ([`auth/src/linkstore.js`](../../auth/src/linkstore.js)) | The providers linked for that email, passkeys included. The wrapper writes `GSI1SK` (equal to the item's `PK`) on every put, so `GSI1` indexes the item and the lookup by `sub` finds it (HFY-R58). A link item written without `GSI1SK` is repaired, with a conditional put, the next time it is read. |
| `PASSKEY#` | Kit passkey store, wrapped by `hfyPasskeyStore` ([`auth/src/passkeystore.js`](../../auth/src/passkeystore.js)) | One credential, keyed by its id: host `sub`, email, public key, signature counter, transports, device type, backed-up flag, label, AAGUID, and the created and last-used times. `GSI1PK` is `PASSKEYSUB#<sub>`. The kit writes no `GSI1SK`, and `GSI1` indexes only items that carry both keys, so the wrapper writes `GSI1SK` equal to the item's `PK` on every put (HFY-R67). The kit's `listByPrincipal` queries `GSI1`, and the passkey list, the per-member limit, `excludeCredentials` and `allowCredentials` all depend on it. An item written without `GSI1SK` gets it the next time it is read, by a conditional update that sets only `GSI1SK` and never rewrites the credential, so it cannot undo a concurrent counter update. A failed repair logs `passkey index backfill failed`, and the read still succeeds. |
| `PASSKEYCHAL#` | Kit challenge store | One challenge: its purpose (`register`, `login` or `stepup`), the `sub` it is bound to (registration and step-up), and its expiry 300 s after issue. Taken with an atomic delete on first use. `ttl` is one hour after expiry. No `GSI1` keys. |
| `ALLOW#` | Not written by the edge. Read by [`auth/src/allowlist.js`](../../auth/src/allowlist.js) and [`membership.js`](../../auth/src/membership.js); written by `hfy-api` ([`api/src/allowlist-store.js`](../../api/src/allowlist-store.js)) | `sub`, `state` (`active` or `revoked`), `source`, `requestId?`, `at`, `by`, and `revokedAt` and `revokedBy` once revoked. |
| `RATE#` | [`auth/src/ratelimit.js`](../../auth/src/ratelimit.js) | A request counter `n` for one forgot-password window. No email or IP. |
| `MCPCODE#` | OAuth | Authorization code binding: client, `redirect_uri`, PKCE challenge, `sub`, resource, scope, expiry, and the sign-in facts: `email`, `amr`, `authTime` (`0` means unknown) and `name` |
| `MCPRT#` | OAuth | MCP refresh token: client, `sub`, resource, scope, family, expiry, and the same `email`, `amr`, `authTime` and `name` |
| `MCPRTUSED#` | OAuth | Marker for a used refresh token, with its family |
| `MCPFAM#` | OAuth, on replay or `/auth/revoke`; or an operator, by hand, as above | `revoked: true`. Any item under the key revokes the family. |

### Cookies

All three cookies are `HttpOnly; Secure; SameSite=Lax` and have no `Domain` attribute, so they are host-only on `<site>`. The kit builds them in kit `edge/index.js`, the refresh token format comes from kit `server/identity.js`, and the refresh profiles are `REFRESH_PROFILES` in kit `providers.js`. The mount adapter in [`auth/src/edge.js`](../../auth/src/edge.js) removes `Domain`.

| Cookie | Value | Path | Max-Age | Set by | Cleared by |
| --- | --- | --- | --- | --- | --- |
| `io_id` | Host ID token (RS256 JWT) | `/` | 3600 s | `/auth/google`, `/auth/password`, `/auth/passkey/login/verify`, `/auth/refresh` | `/auth/logout`, a failed refresh |
| `io_rt` | Opaque refresh token, `ios_` plus 32 random bytes in base64url | `/auth` | 2,592,000 s (30 days). Each refresh issues a new token and restarts the 30 days (the `installed` profile slides). | Same as `io_id` | Same as `io_id` |
| `io_pkce` | Hosted-UI login state and PKCE verifier | `/` | 600 s | Only the kit's hosted-UI login start, which no route on this mount reaches | `/auth/callback` |

A sign-in body (`/auth/google`, `/auth/password` or `/auth/passkey/login/verify`) may set `profile` to `"standard"` (24 hours, absolute) or `"installed"` to override the manifest default. No client in this repository sends it.

The API reads `io_id` on `/api/*` (see the [API reference](api.md)), and the data gate reads it on the gated data paths (see [Private data gate: hfy-edge-gate](#private-data-gate-hfy-edge-gate)). The passkey routes read `io_rt`.

#### Session refresh

`POST /auth/refresh` (kit `edge/index.js` and `refresh` in kit `server/identity.js`) re-mints `io_id` from `io_rt`. Under `authV2`, the site calls it silently from [`11ty/js/feature-flags.js`](../../11ty/js/feature-flags.js) so a member is not sent back to sign in every hour (HFY-R66, see [Client consumers](#client-consumers)). With `authV2` off, nothing in this repository calls it.

| Case | Response |
| --- | --- |
| No `X-Requested-With: io-kit`, or a foreign `Origin` | `403 {"code":"AUTH_FORBIDDEN"}`. The cookies are not read or changed. |
| No `io_rt` cookie | `401 {"code":"AUTH_REFRESH_FAILED"}` |
| A valid `io_rt` | `200 {idToken, accessToken, expiresIn, exp}` with `Cache-Control: no-store`. It sets a new host-only `io_id` (Max-Age 3600) and a rotated `io_rt`. `exp` is the new `io_id`'s expiry in epoch seconds. The new tokens keep the original `auth_time` and `amr` (HFY-R68). |
| A rotated `io_rt` presented again | `401 AUTH_REFRESH_FAILED`, clears both cookies, and revokes the whole refresh family, so the token that replaced it stops working too |
| Revoked, expired, unknown, removed from the allowlist, or remapped to another `sub` | `401 AUTH_REFRESH_FAILED`, clears both cookies. A removal or remap also revokes the family. |
| An error coded `AUTH_NETWORK` | `503 {"code":"AUTH_NETWORK"}`, cookies kept. Any other error, a table read failure included, is the `401` above. |

The browser sends `io_rt` to this route because its `Path=/auth` covers `/auth/refresh`. Page scripts cannot read either cookie.

### Token claims

The kit signs both session tokens in `mint` in kit `server/identity.js`.

**ID token** (the `io_id` cookie value, and `idToken` in the `/auth/refresh` body). The header is `alg: RS256` with `kid` set to the session key id.

| Claim | Value |
| --- | --- |
| `iss` | `https://<site>/auth` |
| `sub` | Host principal: the Gramps ID from the allowlist |
| `aud` | `harrisonfamily-web` |
| `iat`, `exp` | `exp` is `iat` plus 3600 |
| `auth_time` | Epoch seconds of the sign-in that started the session. A refresh copies it from the refresh record and never advances it (since `@io-kit/auth` 2.1.1). A session refreshed from a record written before 2.1.1 carries `0`. |
| `amr` | How the member signed in: `["pwd"]` for a password, `["fed"]` for Google, and for a passkey `"passkey"`, then `"hwk"` (a device-bound credential) or `"swk"` (a synced one), then `"mfa"` only when the authenticator verified the user (`passkeyAmr` in kit `providers.js`). A refresh keeps the stored value. Omitted when empty. |
| `email` | Verified email, lower-cased |
| `email_verified` | `true` |
| `name` | Allowlist `label`. It defaults to the email. |
| `cognito:groups` | Allowlist `roles`. The default is `["member"]`. |
| `custom:tenant` | Present only when the entry has a string `claims.tenant` |
| `token_use` | `id` |

**Session access token** (`accessToken` in the `/auth/refresh` body only, never in a cookie). It carries the same `iss`, `sub`, `iat`, `exp`, `auth_time`, `amr`, `email`, `email_verified`, `name`, `cognito:groups` and `custom:tenant` claims as the ID token, has no `aud`, and adds:

| Claim | Value |
| --- | --- |
| `token_use` | `access` |
| `client_id` | `harrisonfamily-web` |
| `io:principal_type` | `human` |
| `io:provider` | `google:gis_id_token`, `password` or `passkey` |
| `io:idp_issuer`, `io:idp_sub` | Issuer and subject at Google or Cognito. For a passkey, `webauthn:<site>` and the credential id. |

Its `auth_time` is the original sign-in time, the same as the ID token's. It is never `iat`, and a refresh never advances it.

**Signing key.** `parseSigningSecret` in [`auth/src/index.js`](../../auth/src/index.js) accepts two secret formats:

- JSON `{"privateKeyPem": "...", "kid": "..."}`. `privateKey` or `pem` are accepted in place of `privateKeyPem`. If `kid` is absent, the manifest's `kid` is used. [`scripts/infra/create-session-key.sh`](../../scripts/infra/create-session-key.sh) writes this form.
- A bare PKCS8 PEM. The manifest's `kid` is used.

The public key is derived from the private key at startup. The JWKS publishes exactly one key, `{kty, n, e, kid, alg: "RS256", use: "sig"}`, with `max-age=300`. A token signed with any other key fails verification once a new key is live. MCP access tokens are signed with the same key and `kid`. The API, the MCP server, the data gate and `/auth/userinfo` verify against it. To replace the key, see [Rotate the session signing key](../how-to/rotate-the-session-signing-key.md).

### MCP authorization server

[`auth/src/oauth.js`](../../auth/src/oauth.js) is an OAuth 2.1 authorization server for MCP clients. It runs in the same Lambda and uses the same sign-in cookie. It supports public clients only (`createOAuthServer({ clients })`: the MCP client, and optionally the Gramps desktop client), requires PKCE with S256, and accepts no client secret. The resource server that accepts its tokens is the MCP server at `/mcp`, described in [MCP server](mcp-server.md).

**Enablement and configuration** (set in `init()` in [`auth/src/index.js`](../../auth/src/index.js)):

| Setting | Source | Value |
| --- | --- | --- |
| Enabled | `MCP_REDIRECT_URIS` | On only when the variable has at least one entry. When it is off, `/auth/authorize`, `/auth/token`, `/auth/register`, `/auth/revoke`, `/auth/userinfo` and both discovery URLs return `404 {"code":"NOT_FOUND"}`. |
| Issuer | `session.issuer` | `https://<site>/auth` |
| Client id | `MCP_CLIENT_ID` | `mcp-harrisonfamily` by default. The stack does not set this variable. |
| Redirect URIs | `MCP_REDIRECT_URIS`, comma-separated | Exact match. The stack default is `https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback`. |
| Desktop client | `HFY_SYNC_DESKTOP_CLIENT` | Off unless set to `1`. When on, registers `hfy-sync-desktop` (see [Desktop client](#desktop-client-hfy-sync-desktop)). |
| Resources | `MCP_RESOURCES`, comma-separated | Default `https://<site>/mcp` (`DEFAULT_MCP_RESOURCE` in `oauth.js`, and the `McpResources` stack default; HFY-R59). The first entry is used when a request names no resource. |
| Key set | `init()` | A local JWKS holding the edge's own public key, used by `/auth/userinfo` |
| CORS origins | `MCP_CORS_ORIGINS`, comma-separated | See [CORS on OAuth routes](#cors-on-oauth-routes). |

### Desktop client (hfy-sync-desktop)

Registered only when `HFY_SYNC_DESKTOP_CLIENT=1` (default off; HFY-TSK-120). It is for the Gramps desktop add-on.

- **Redirect:** `http://127.0.0.1/callback`, matched by scheme, host and path with any port (RFC 8252 section 7.3). A different host (including `localhost`), path or scheme, port 0, userinfo, query or fragment is refused with a 400 and no redirect. The MCP client keeps exact matching.
- **Resource:** `https://harrisonfamily.us/api/sync`; access tokens carry that `aud`, `client_id` `hfy-sync-desktop` and scope `sync`.
- **Binding:** codes and refresh tokens belong to the client that received them. The other client's code is refused, and another client's refresh token is refused without being consumed.
- **Refresh:** rotating, and expiring 30 days after the last use. `auth_time` is never advanced (HFY-R64).
- **Registration:** `/auth/register` still serves only the MCP client; the desktop client cannot be registered dynamically.
- **Redirect spelling:** the raw redirect must be the canonical `http://127.0.0.1[:port]/callback`; backslashes, whitespace, IPv4 shorthand (`127.1`, `0x7f.1`) and dot segments are refused.
- **Scopes:** the desktop client may request only `sync` (anything else is `invalid_scope`), and `sync` is reserved to it: the MCP client cannot request it. The sync routes should authorize on `aud` and `client_id`, not on the scope claim.
- **`/auth/userinfo`:** accepts MCP-resource tokens only. A sync-audience desktop token is refused there, so the sync audience stays resource-specific.
- **Who may sign in:** the OAuth server issues desktop tokens to any family-list member. The gramps-owner restriction is enforced by the sync routes, not here ([API: The sync API](api.md#the-sync-api)).
- **Replay:** presenting an already-used refresh token revokes its family whichever `client_id` accompanies it.
- **Stack switch:** the `SyncDesktopClient` parameter of `app-stack.yaml` (default `0`) sets `HFY_SYNC_DESKTOP_CLIENT` on the auth function. Set it to `1` in the same change set as the sync routes (AC6 RG-4).

**Discovery.** The same RFC 8414 document is served at:

- `https://<site>/.well-known/oauth-authorization-server/auth`, the path-insertion form for the issuer `https://<site>/auth`. CloudFront routes it to the edge.
- `https://<site>/auth/.well-known/oauth-authorization-server`

Both send `Cache-Control: public, max-age=300`.

| Metadata field | Value |
| --- | --- |
| `issuer` | `https://<site>/auth` |
| `authorization_endpoint` | `<issuer>/authorize` |
| `token_endpoint` | `<issuer>/token` |
| `registration_endpoint` | `<issuer>/register` |
| `revocation_endpoint` | `<issuer>/revoke` |
| `revocation_endpoint_auth_methods_supported` | `["none"]` |
| `userinfo_endpoint` | `<issuer>/userinfo` |
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
| GET, HEAD | `/auth/userinfo` | None. `Authorization: Bearer <access-token>` (see [/auth/userinfo](#authuserinfo)). |

A wrong method returns `405 {"error":"invalid_request","error_description":"use <METHOD>"}` with an `Allow` header. An unexpected failure, including an unreadable allowlist, returns `503 {"error":"server_error"}` and logs `oauth failure`. All responses other than discovery and a successful preflight send `Cache-Control: no-store` and `Pragma: no-cache`.

**`/auth/authorize` validation**, in order:

| Check | On failure |
| --- | --- |
| `client_id` is the configured client | `400 {"error":"invalid_request"}` as JSON, with no redirect |
| `redirect_uri` is present and on the list | `400 {"error":"invalid_request"}` as JSON, with no redirect |
| `response_type=code` | Redirect with `error=unsupported_response_type` |
| `code_challenge` is 43 base64url characters and `code_challenge_method=S256` | Redirect with `error=invalid_request` |
| `resource`, if given, is a configured resource | Redirect with `error=invalid_target` |
| `max_age`, if given, matches `^[0-9]{1,9}$` (a whole number of seconds) | Redirect with `error=invalid_request`, with or without a session |
| The `io_id` cookie verifies, `prompt` does not include `login`, and, when `max_age` is given, the session's sign-in is no more than `max_age` seconds old | `302` to `/auth/login?next=<this authorize URL>`, described below |
| The `sub` is a member (see [Membership groups](#membership-groups)) | Redirect with `error=access_denied` |

- **Fresh sign-in (HFY-R64, RFC 9470).** `prompt` is a space-delimited list, so `prompt=consent login` also counts. The session's sign-in time is the `io_id` token's `auth_time`, or its `iat` when it has none. A time of `0` means unknown and never satisfies `max_age`. `max_age=0` is satisfied only by a sign-in in the same second.
- **The login redirect.** The `next` URL is this authorize request with `prompt` removed, so the request after sign-in does not loop, and `max_age` kept, which a fresh sign-in satisfies. The mount adapter passes `next` to the kit's page as `returnTo` (see [Runtime and mount](#runtime-and-mount)). A signed-out request takes the same redirect.
- **Success.** Every error redirect, and the success redirect, carries `iss`, and `state` when the client sent one. On success the redirect also carries `code`: 32 random bytes in base64url. The code can be used once and expires after 120 s. It is bound to the client, `redirect_uri`, `code_challenge`, `sub`, resource and scope, and records the session's `email`, `amr`, sign-in time and display name for the token. A requested `scope` is kept if it matches `[A-Za-z0-9:._/ -]{1,200}`. Otherwise the scope is `mcp`.

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
| `iss` | `https://<site>/auth` |
| `sub` | The member's Gramps ID |
| `aud` | The resource, for example `https://<site>/mcp` |
| `iat`, `exp` | `exp` is `iat` plus 3600 (1 hour) |
| `jti` | 12 random bytes in base64url |
| `groups` | Membership groups at the time of issue |
| `scope` | Granted scope |
| `client_id` | The configured client |
| `token_use` | `access` |
| `email` | The session's verified email, when it has one |
| `name` | The member's display label, only when it is usable: the session label trimmed, not empty, not the `sub`, at most 200 characters, with no `@` and no control characters (`displayNameOf`). The session label is the allowlist `label`, which defaults to the email, so a member without a label gets no `name`. The MCP server uses it to label the actor ([MCP server: Actor and label](mcp-server.md#actor-and-label), HFY-R68). |
| `amr` | The session's `amr`, only when it is not empty |
| `auth_time` | Always present. The session's sign-in time in epoch seconds, or `0` when it is unknown. |

**Refresh tokens.** An MCP refresh token is `hfyrt_` followed by 32 random bytes in base64url. It is stored only as a hash and can be used once. Each use returns a new refresh token in the same family with a new 30-day lifetime. Presenting a token that was already used revokes the whole family, so every token in it stops working. Membership is checked again on every grant. A refresh grant copies `email`, `amr`, `auth_time` and `name` from the stored record, so `auth_time` stays the original sign-in time while `iat` advances. A record written before HFY-R64 has none of these, and its tokens carry `auth_time: 0` and no `amr`, `email` or `name` for the life of the family.

**`/auth/register`** is a registration facade. It stores nothing and always returns the one fixed public client:

- `redirect_uris`, if sent, must be an array of strings (otherwise `400 invalid_client_metadata`), and every entry must be on the allowed list (otherwise `400 invalid_redirect_uri`).
- `token_endpoint_auth_method`, if sent, must be `none` (otherwise `400 invalid_client_metadata`).
- The response is `201 {client_id, client_name, token_endpoint_auth_method: "none", grant_types, response_types: ["code"], redirect_uris, scope: "mcp"}`. `client_name` is the requested name cut to 100 characters, or `Harrison Family MCP`. `redirect_uris` holds the requested URIs, or the whole allowed list when none were requested.

**`/auth/revoke`** (RFC 7009) returns `200 {}` for any token, whether or not it is known. A `client_id` that does not match the configured client returns `401 invalid_client`. The route-level responses also apply: `405` for a wrong method and `503 server_error` for a store failure, as described above, and `403` for a preflight from a disallowed origin (see [CORS on OAuth routes](#cors-on-oauth-routes)). When the token starts with `hfyrt_` and is known, either unused or as a used-token marker, its family is revoked. An unused token is also deleted. Access tokens cannot be revoked and expire within an hour.

### /auth/userinfo

`userinfo` in [`auth/src/oauth.js`](../../auth/src/oauth.js) answers who an MCP access token belongs to, and whether that member is still on the allowlist (HFY-R55). Tested in [`auth/test/userinfo.test.js`](../../auth/test/userinfo.test.js). No code in this repository calls it: the MCP server verifies its bearer tokens itself.

| Step | On failure |
| --- | --- |
| `Authorization: Bearer <token>` is present and well formed (the scheme matches in any case) | `401 {"error":"invalid_token"}` with `WWW-Authenticate: Bearer` |
| A key set is configured | `503 {"error":"server_error"}`. `init()` always configures one. |
| The token verifies against the key set: `RS256` only, `iss` equal to the issuer, `aud` one of the configured resources, `exp` and `nbf` with 5 s of clock tolerance | `401 {"error":"invalid_token"}` with `WWW-Authenticate: Bearer error="invalid_token"` |
| `token_use` is `access` and `sub` is a string | The same `401` |
| The `sub` is a member: the [membership check](#membership-groups) runs on every call, so a removed member stops working within its 60 s cache, not at token expiry | The same `401` |

A valid token returns `200 {sub, groups, email_verified: true}`, with `Cache-Control: no-store`. `groups` comes from the membership check at the time of the call, not from the token. `email_verified` is always `true`, because the allowlist admits only addresses verified by Google or Cognito. The response carries no email.

- **Tokens it rejects.** An ID token (`token_use: id`), a session access token (no `aud`), and a token for any audience outside `MCP_RESOURCES` all get `401`.
- **Key rotation.** The Lambda passes a local key set that holds its own public key, so `/auth/userinfo` accepts exactly the tokens the running instance could sign. `createOAuthServer` also accepts a remote key set; with one, a token under a rotated `kid` verifies once the key set has refetched, and a token under the retired `kid` is refused.
- **Failures.** An allowlist that has never loaded makes the membership check throw, which the route turns into `503 {"error":"server_error"}`.
- **CORS** applies, as for the other OAuth routes. The preflight allows `GET, OPTIONS`.

### Membership groups

[`auth/src/membership.js`](../../auth/src/membership.js) decides who may hold an MCP token, and with which groups. `/auth/authorize`, both `/auth/token` grants and `/auth/userinfo` call it.

| Item | Value |
| --- | --- |
| Allowlist | The composite allowlist: the resolver's object (`config/userGrampsID.json`), parsed with the kit's `parseAllowlist` and keyed by `sub`, plus the DynamoDB `ALLOW#` items of that `sub` (`Query` on `GSI1PK = ALLOWSUB#<sub>`). A `sub` is a member when one of its items is `active`, or when the file lists one of its emails and no `ALLOW#` item exists for that email. A `revoked` item removes the file's entry for that email only. The shared reader is `createCompositeMemberReader` in [`shared/allowlist-store.mjs`](../../shared/allowlist-store.mjs). |
| Admin list | `ADMIN_LIST_KEY` (default `config/admins.json`) in the resolver's bucket. It is a JSON array of `sub` strings or `{"admins": [...]}`, and entries that are not strings are ignored. The object may be absent: the read fails, and nobody is in `admins`. |
| Groups | `members`, plus every allowlist role except the default `member`, plus `admins` when the `sub` is on the admin list. Duplicates are removed. A `sub` that is not on the allowlist gets no groups and is refused. |
| Roles | From the S3 entries that still count. A DynamoDB grant carries the member role only, so it adds no group beyond `members`. |
| Cache | 60 s for the file, and 60 s for each `sub`'s `ALLOW#` items. This cache is separate from the resolver's 300 s cache. |
| Allowlist read failure | If no copy of the file has ever loaded and no active `ALLOW#` item decides it, the call throws and the OAuth route returns `503 server_error` (fail closed). After a successful load, the last good copy stays in use and the read is retried 5 s later. |
| DynamoDB read failure | Logged as `allowlist table unavailable (the file decides)`. The file alone decides that call: a listed `sub` stays a member, an unlisted one is refused. The failure is not cached. |
| Admin list read failure | Logged as `admin list unavailable (nobody is admin)`. Nobody is an admin until a read succeeds. |

These groups are the access token's `groups` claim and the `groups` that `/auth/userinfo` returns. The MCP server ignores the `groups` claim: it decides `mcp-authors` and `hfy-admin` from its own `config/groups.json` ([MCP server: Groups](mcp-server.md#groups)).

### CORS on OAuth routes

CORS applies to the discovery document, `/auth/token`, `/auth/register`, `/auth/revoke` and `/auth/userinfo`. It does not apply to `/auth/authorize`, which is a top-level browser navigation.

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
| `AUTH_TABLE` | Yes | `TableName` (`hfy-app`) | Refresh, family and link records, passkeys and their challenges, forgot-password counters, and OAuth records |
| `MCP_REDIRECT_URIS` | No | `McpRedirectUris` | Turns the authorization server on and lists its redirect URIs |
| `MCP_RESOURCES` | No | `McpResources` (default `https://<site>/mcp`) | Token audiences |
| `MCP_CORS_ORIGINS` | No | `McpCorsOrigins` | CORS allow list |
| `ADMIN_LIST_KEY` | No | `AdminListKey` | Admin list key. The default is `config/admins.json`. |
| `MCP_CLIENT_ID` | No | Not set | Overrides `mcp-harrisonfamily` |
| `HFY_SYNC_DESKTOP_CLIENT` | No | Not set | `1` registers the `hfy-sync-desktop` client |
| `EDGE_MANIFEST_PATH` | No | Not set | Overrides the manifest path |

The allowlist bucket and key come from the manifest, not from the stack. The stack parameters `ConfigBucket`, `AllowlistKey` and `AdminListKey` scope the function's `s3:GetObject` permission, so they must name the same objects. The role also allows `GetItem`, `PutItem`, `UpdateItem`, `DeleteItem` and `Query` on the table and its indexes, `secretsmanager:GetSecretValue` on the signing-key secret, and `AdminGetUser`, `AdminCreateUser`, `AdminSetUserPassword`, `AdminConfirmSignUp` and `AdminUpdateUserAttributes` on the user pool.

The `SesIdentityArn` and `SesFromAddress` stack parameters are not passed to the function. They set the user pool's email configuration (see [Cognito user pool](#cognito-user-pool)).

## Private data gate: hfy-edge-gate

[`edge-gate/src/gate.mjs`](../../edge-gate/src/gate.mjs) is a Lambda@Edge viewer-request function that verifies the `io_id` cookie before CloudFront serves the family data and member photos (HFY-TSK-080, HFY-R63). It is a second verifier of the token the auth edge mints. It does not call the edge for each request: it needs only the edge's JWKS, which it caches. It has no dependencies (`node:crypto` only). For why the gate exists and where it fits, see [The privacy model for family data: Gating the JSON](../explanation/family-data-privacy.md#gating-the-json) and [Edge and origin design: The data gate](../explanation/edge-and-origin-design.md#the-data-gate-viewer-request).

| Item | Value | Source |
| --- | --- | --- |
| Function | `hfy-edge-gate`: `nodejs22.x`, x86_64, 128 MB, 5 s timeout, handler `index.handler`, no environment variables | [`infrastructure/cloudformation/edge-gate-stack.yaml`](../../infrastructure/cloudformation/edge-gate-stack.yaml) |
| Stack | `hfy-edge-gate` in us-east-1. Deploying a new build publishes a new numbered version, which the `EdgeGateVersionArn` output names; `add-data-gate-behaviors.sh` accepts only such a qualified ARN. Old versions are retained, because CloudFront replicas pin them. | Same |
| Package | `dist/hfy-edge-gate.zip` holds `index.mjs`, `gate.mjs` and `config.json`. It is uploaded to `<edge-code-bucket>` under the content-addressed key `lambda/hfy-edge-gate-<16 hex>.zip`, with its `CodeSha256`. | [`scripts/ci/package-edge-gate.sh`](../../scripts/ci/package-edge-gate.sh) |
| Attachment | Viewer-request association on seven behaviors, listed under [Gated behaviors](#gated-behaviors). `--remove` deletes the six data behaviors, so those paths fall to the default behavior (see [Where the gate is attached](#where-the-gate-is-attached)), and puts `/uploads/*` back to its ungated state. | [`scripts/infra/add-data-gate-behaviors.sh`](../../scripts/infra/add-data-gate-behaviors.sh) |
| Tests | `npm test` in `edge-gate/` (`node --test`) | [`edge-gate/test/gate.test.mjs`](../../edge-gate/test/gate.test.mjs) |

The procedures are in [How to deploy and update the Lambda@Edge functions](../how-to/deploy-the-edge-functions.md), whose step 5 exercises a new version with synthetic viewer requests before anything attaches it, and in [How to cut over to authV2 and the private data gate](../how-to/cut-over-to-the-private-data-gate.md). The production cutover ran on 2026-10-12 (HFY-TSK-069, HFY-R67): the site with `authV2` on was deployed first, and the gate was attached to the six data behaviors after it. Gating `/uploads/*` is a later run of the same script, which the repository does not record; [Where the gate is attached](#where-the-gate-is-attached) shows how to check it.

### Gated behaviors

`add-data-gate-behaviors.sh` gives each pattern the `hfy-edge-gate` viewer-request association (the qualified version ARN), `CachingDisabled`, and `GET` and `HEAD` only. Both response headers policies are custom policies that the script finds by name, creates when missing and repairs when they no longer match. Neither belongs to a stack.

| Pattern | Origin | Response headers policy |
| --- | --- | --- |
| `/person/*.json`, `/family/*`, `/event/*`, `/note/*`, `/place/*`, `/media/*` | The default behavior's S3 origin, or `--origin-id`. The script creates these six behaviors. | `hfy-private-no-store`: a custom `Cache-Control: private, no-store` header, with override |
| `/uploads/*` | Kept. The script updates the behavior that [`add-uploads-behavior.sh`](../../scripts/infra/add-uploads-behavior.sh) made in place, keeping its position and origin. When no `/uploads/*` behavior exists, it creates one already gated, on the default behavior's origin. | `hfy-uploads-private`: `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox; default-src 'none'; img-src 'self'` and a custom `Cache-Control: private, no-store`, each with override |

- **The uploads CSP** is the same string as the app stack's `UploadsResponseHeadersPolicy`: `UPLOADS_CSP` in [`scripts/infra/lib/cf-common.sh`](../../scripts/infra/lib/cf-common.sh) holds it, [`test_app_stack.py`](../../scripts/infra/test/test_app_stack.py) checks that the two match, and `rhp_uploads_private` in [`cf.jq`](../../scripts/infra/lib/cf.jq) checks all three headers of an existing `hfy-uploads-private` before the script reuses it.
- **Options.** `--response-headers-policy-id` and `--uploads-response-headers-policy-id` skip the lookup and use the ID as given. `--response-headers-policy-name` (default `hfy-private-no-store`) and `--uploads-response-headers-policy-name` (default `hfy-uploads-private`) name the policies to find or create.
- **Ungated `/uploads/*`.** `add-uploads-behavior.sh` sets the public state: no association, `CachingOptimized`, and the app stack's `UploadsResponseHeadersPolicyId`. It never undoes the gate: when `/uploads/*` already carries the `hfy-edge-gate` association (its `--gate-function-name`, default `hfy-edge-gate`), it leaves the behavior as it is and prints `no change`. `add-data-gate-behaviors.sh --remove` restores the public state, taking the policy ID from `--restore-uploads-policy-id` or from the `UploadsResponseHeadersPolicyId` output of `--app-stack`, whose default is `hfy-app`, so a live run names `<app-stack>`.
- **Photos and members.** An image request is not a navigation (see [Allow and deny](#allow-and-deny)), so a signed-out request for a gated `/uploads/...` URL gets the `401`. The posts islands render photos as same-origin `<img src>`, for which the browser sends `io_id`, so members see them ([`islands/tests/uploads-gate.test.mjs`](../../islands/tests/uploads-gate.test.mjs)). A script that fetches a photo must send `credentials: "same-origin"`. Presigned uploads go straight to the S3 endpoint, not through CloudFront, so the gate never sees them ([`api/test/presign.test.js`](../../api/test/presign.test.js)).
- **Variant spellings.** CloudFront path patterns are case-sensitive and `/person/*.json` is anchored on its suffix, so spellings such as `/Person/index.json`, `/person/<gramps-id>.JSON`, `/Media/<file>`, `%2F`, backslash and dot-segment variants match none of these patterns and never reach `hfy-edge-gate`. They fall to the default behavior, where the default-deny code of `HFYAppendIndex` ([`scripts/cloudfront/append-index.js`](../../scripts/cloudfront/append-index.js)) answers `404` with `Cache-Control: private, no-store` and never reaches S3. See [System architecture: HFYAppendIndex](architecture.md#hfyappendindex) and [Edge and origin design: Why the CloudFront Function also denies](../explanation/edge-and-origin-design.md#why-the-cloudfront-function-also-denies).

The script's output and dry runs are described in [Repository operations](repository-operations.md#data-gate-behaviors).

### Where the gate is attached

The repository does not record which behaviors carry the association on the live distribution, or whether `HFYAppendIndex` runs its default-deny code. These signed-out requests show both. A path without the gate falls to the default behavior, so its answer depends on that function's code:

| Request | Gated | Not gated, default-deny `HFYAppendIndex` published | Not gated, older `HFYAppendIndex` |
| --- | --- | --- | --- |
| `curl -s -o /dev/null -w '%{http_code}' https://<site>/person/index.json` | `401` | `404` (with `cache-control: private, no-store`) | `200` |
| `curl -s -o /dev/null -w '%{http_code}' https://<site>/uploads/posts/<ulid>/<name>` for an existing photo | `401` | `200` | `200` |
| `curl -sI -H 'Sec-Fetch-Mode: navigate' https://<site>/person/index.json` | `302` to `/auth/login?returnTo=%2Fperson%2Findex.json`, `cache-control: private, no-store` | `404`, `cache-control: private, no-store` | `200` |

`/uploads/*` keeps its own behavior when ungated, and that behavior runs no CloudFront Function, so its answer does not depend on `HFYAppendIndex`. A path that a broader behavior, such as a legacy `/person/*`, matches before the default behavior never reaches the function either.

A variant spelling shows which code `HFYAppendIndex` runs, whether or not the gate is attached:

| Request | Default-deny code | Older code |
| --- | --- | --- |
| `curl -sI https://<site>/Person/index.json` | `404`, `cache-control: private, no-store` | Anything else: the request reaches S3 |

On a gated path, `cf-cache-status` is never `HIT`: every answer, allowed or denied, carries `Cache-Control: private, no-store`. So does the function's `404`. See [System architecture: HFYAppendIndex](architecture.md#hfyappendindex), and [Publish a change to the HFYAppendIndex CloudFront Function](../how-to/publish-the-cloudfront-function.md) for how the code is published.

### Configuration

Lambda@Edge has no environment variables, so [`edge-gate/gate.config.json`](../../edge-gate/gate.config.json) is copied into the zip as `config.json` and read by [`edge-gate/src/index.mjs`](../../edge-gate/src/index.mjs). Changing a value is a code release. `createGate` throws if `issuer`, `audience` or `jwksUrl` is missing, and `package-edge-gate.sh` refuses to build without them. A test pins `issuer`, `audience` and `jwksUrl` to the auth edge manifest.

| Key | Value | Use |
| --- | --- | --- |
| `issuer` | `https://<site>/auth` | Required `iss` (the manifest's `session.issuer`) |
| `audience` | `harrisonfamily-web` | Required `aud` (the manifest's `session.audience`) |
| `jwksUrl` | `https://<site>/auth/.well-known/jwks.json` | The auth edge's key set |
| `cookie` | `io_id` | Cookie to read |
| `loginPath` | `/auth/login` | Target of the navigation redirect |
| `skewSeconds` | `60` | Clock skew allowed on `exp` and `nbf` |
| `jwksTtlSeconds` | `300` | How long fetched keys count as fresh |
| `minRefetchSeconds` | `30` | Minimum wait after a successful fetch before another |
| `failureBackoffSeconds` | `2` | Wait after a failed fetch before a retry |
| `fetchTimeoutMs` | `3000` | JWKS fetch timeout |

### Token checks

The gate reads the first `io_id` value from the request's `Cookie` headers. With no `io_id`, the request is denied. Otherwise the checks run in this order, and the first failure denies the request with the reason in brackets:

1. The token is a string of 1 to 8192 characters in three base64url parts, whose header and payload parse as JSON [`malformed`].
2. The header has `alg: RS256` and a string `kid` [`alg-or-kid`].
3. A key with that `kid` is in the JWKS cache, after a refetch if needed (see [JWKS cache](#jwks-cache)) [`unknown-kid`].
4. The RSA-SHA256 signature verifies with that key [`bad-signature`], and the payload is a JSON object [`malformed`].
5. `iss` equals `issuer` [`iss`].
6. `aud`, as a string or as one entry of an array, equals `audience` [`aud`].
7. `exp` is a number and the current time is no later than `exp` plus 60 s [`expired`].
8. `nbf`, when present, is a number no later than the current time plus 60 s [`nbf`].
9. `sub` is a non-empty string [`sub`].

A request that passes is returned to CloudFront unchanged. Any thrown error is a deny.

**What it does not check.** The gate does not read `token_use`, the allowlist or any revocation record, and it makes no call per request beyond a JWKS refetch. The audience check is what keeps other tokens out: an MCP access token has the MCP resource as its audience, and a session access token has no `aud`. A member removed from the allowlist therefore keeps reading gated data until their `io_id` expires, up to 3600 s after it was minted plus the 60 s skew. Their next refresh is refused (see [Session refresh](#session-refresh)).

### Allow and deny

| Outcome | Response |
| --- | --- |
| Allowed | The request goes on to the behavior's S3 origin. The behavior's response headers policy sets `Cache-Control: private, no-store` on the response (HFY-R65): `hfy-private-no-store` on the six data patterns, and `hfy-uploads-private`, which also sets the nosniff and sandbox CSP headers, on `/uploads/*` (see [Gated behaviors](#gated-behaviors)). |
| Denied navigation | `302` with `Location: /auth/login?returnTo=<path>` and `Cache-Control: private, no-store`. `<path>` is the request URI with its leading slashes collapsed to one, plus `?<query>` when there is one, URL-encoded, so it can never be protocol-relative. |
| Denied, anything else | `401` with `Content-Type: application/json`, `Cache-Control: private, no-store` and the body `{"error":"unauthenticated"}` |

**The navigation rule** (`isNavigation`): a request whose `Accept` contains `application/json` is never a navigation. Otherwise, when `Sec-Fetch-Mode` is present, it is a navigation only if that is `navigate`. Without `Sec-Fetch-Mode`, it is a navigation when `Accept` contains `text/html`. So fetches, XHR and subresources such as images get the `401`, and a page load gets the redirect.

The gate's own responses carry `private, no-store` because Cloudflare proxies the site in front of CloudFront, and a shared cache must never keep a gate answer, allowed or denied ([Edge and origin design: Cloudflare in front of CloudFront](../explanation/edge-and-origin-design.md#cloudflare-in-front-of-cloudfront-hfy-r65)).

### JWKS cache

The cache is a map from `kid` to public key, held in module scope for the life of the container:

- **Lookup.** A known `kid` is used while the keys are younger than 300 s. An unknown `kid`, or stale keys, trigger a refetch.
- **Rate limit.** After a successful fetch, no refetch for 30 s, so a stream of forged `kid`s cannot turn the gate into a JWKS load. After a failed fetch, the next request may retry once 2 s have passed, so one slow answer from a cold auth edge does not lock a new container out for 30 s. While a refetch is cooling down, the gate answers from the keys it has.
- **Single flight.** Requests that arrive while a fetch is under way wait for it and share its result.
- **Failure.** A network error, a timeout (3000 ms), a non-2xx answer or a key set with no usable key is a failed fetch. The last good keys stay in use. With no key at all, every request is denied (fail closed).
- **Usable keys.** Only `kty: RSA` keys with a string `kid`, whose `use`, if present, is `sig` and whose `alg`, if present, is `RS256`. A key that Node cannot import is skipped.
- **Rotation.** A token under a new `kid` is accepted after the refetch that its unknown `kid` triggers. A token under a retired `kid` is refused once the cache holds the new key set.

### Logs

Lambda@Edge writes to a log group named `/aws/lambda/us-east-1.hfy-edge-gate` in the Region of the edge location that ran the request. The gate logs these lines, and never the token or its claims:

| Line | When |
| --- | --- |
| `edge-gate: deny <reason>` | An `io_id` cookie was present and failed a check. `<reason>` is one of the bracketed reasons under [Token checks](#token-checks). |
| `edge-gate: deny error <message>` | An unexpected error, which is denied |
| `edge-gate: jwks refresh failed: <message>` | A JWKS fetch failed. The previous keys stay in use. |
| `edge-gate: jwks had no usable RS256 keys` | A JWKS answer held no usable key |

A request with no `io_id` cookie is denied without a log line.

## Client consumers

Every consumer below reads the flags through `HFYFeatureFlags.resolveFlags()`: the build value in [`11ty/_data/flags.json`](../../11ty/_data/flags.json), with the tab's `?hfy_flags=` override laid over it. The production cutover on 2026-10-12 (HFY-TSK-069, HFY-R67) set all six flags to `true` in that file. The value a visitor gets is the served file, which `curl -s https://<site>/_data/flags.json | jq .authV2` prints. A page that resolves `authV2` off (a build with it `false`, or a `?hfy_flags=-authV2` override) gets no edge session probe and no refresh; the legacy Google sign-in it used to fall back to is gone (HFY-TSK-317).

**[`11ty/js/auth-v2.js`](../../11ty/js/auth-v2.js)** does nothing unless `authV2` resolves on. It reads the flag through `HFYFeatureFlags.resolveFlags()`, or from `/_data/flags.json` when that function is not available. With the flag on:

| Behavior | Detail |
| --- | --- |
| Session first | The probe is `HFYFeatureFlags.edgeSession()`, described below. Without `feature-flags.js` it falls back to its own `GET /auth/session` (same-origin, `no-store`). If the probe resolves `null`, because `/auth/session` did not answer with a JSON body whose `authenticated` is a boolean, the script calls `HFYFeatureFlags.flagUnavailable("/auth/session")`, which drops a preview override if there is one, and leaves the page as it is. |
| Sign-in links | Signed out, the script points every `familyLoginLink` at `/auth/login?returnTo=<this page>`. The return target is a same-origin path: one leading `/` and not `//`, no backslash, no control character, at most 2048 characters, and not under `/auth` or `/family-login`. Anything else gives `/` (`safeReturnPath`). The static `href` in the pages is `/auth/login` with no return. |
| `/family-login/` | Not this script's job any more. [`11ty/family-login/index.html`](../../11ty/family-login/index.html) is a static page whose inline script replaces itself with `/auth/login?returnTo=<next>`, for the same `next` rule (a bare or unsafe `next` gives `/`), and whose `<noscript>` meta refresh goes to `/auth/login`. Old bookmarks and any `/family-login/?next=<path>` link still work ([`tests/client/auth-continuity.test.mjs`](../../tests/client/auth-continuity.test.mjs)). |
| Navigation | When `authenticated` is true, the script points `[data-my-record-link]` at `/person/?id=<sub>`, hides `familyLoginLink` and shows `logoutLink`. It applies these again after `load` and 600 ms later, because `feature-flags.js` toggles the same items. |
| Sign-out | Intercepts clicks on every `[data-auth-signout-link]`. Clears `hfy:edge-session` in `localStorage`, calls `HFYFeatureFlags.forgetEdgeSession()`, sends `POST /auth/logout` with `X-Requested-With: io-kit`, body `{}` and `keepalive`, waits for it for at most 4 s, then goes to `/logged-out/`. |
| Retired keys | On every page, removes what the retired Google sign-in left in the browser: `HFY_AUTH_ID_TOKEN` and `HFY_AUTH_USER_GRAMPS_ID` in `localStorage`, `HFY_GATEWAY_SESSION_V1` in `sessionStorage`. |

**[`11ty/js/feature-flags.js`](../../11ty/js/feature-flags.js)** keeps the edge session going under `authV2` (HFY-R66). With `authV2` off, none of this runs: `edgeSession()` resolves `null` and `dataFetch()` is plain `fetch`.

| Function | Behavior |
| --- | --- |
| `edgeSession()` | One `GET /auth/session` per page (same-origin, `no-store`), shared by `auth-v2.js`, the shell, the data fetches and the islands that ask it (below). It resolves `null` when `authV2` is off or `/auth/session` is unreachable. When the answer is signed in but within 120 s of its `exp`, or signed out while `hfy:edge-session` is `1` in `localStorage`, it calls `POST /auth/refresh` once and asks again. A signed-in answer sets `hfy:edge-session` and lays `{loggedIn, userGrampsID, hasRecord}` over the page's default feature state, so My Record and Log out follow the edge session. |
| Refresh | One `POST /auth/refresh` at a time, with `X-Requested-With: io-kit` and no body. It never reads the response body. A `401` or `403` removes `hfy:edge-session`. A failed refresh is not tried again on that page. |
| `dataFetch(url, init, {interactive})` | Sends a gated-data request with the `io_id` cookie (`credentials: "same-origin"`) and no `X-HFY-Session`. Before the first data fetch on a page, it refreshes once if the session is signed out or near expiry. On a gate `401` it refreshes once (or reuses a refresh that finished meanwhile) and retries once. When that fails, an interactive load goes to `/auth/login?returnTo=<current page>`, unless this tab was sent there in the last 10 minutes (`hfy:auth-bounce` in `sessionStorage`). A background load (`interactive: false`) never redirects. |
| `forgetEdgeSession()` | Removes `hfy:edge-session` and the overlay, so later pages do not try to refresh |

[Front end](front-end.md#auth-v2js-behavior) has the details. Without `authV2`, nothing in this repository calls `/auth/refresh`: `io_id` lapses after 3600 s, and `/auth/session` then returns `{authenticated: false}`. For the flag mechanism, see [Front end](front-end.md) and [Toggle a feature flag](../how-to/toggle-a-feature-flag.md).

**`authV2` off while the gate is attached.** A page that resolves `authV2` off sends a plain same-origin request, which carries whatever `io_id` the browser holds, and nothing on the page refreshes it. There is no other sign-in. So while the gate is attached, such a page gets `401` on gated data once the visitor's `io_id` lapses, or at once when there is none (HFY-R67). Four things make a page resolve off:

- an automatic rollback after a failed smoke check that restores a release whose `flags.json` has `authV2` false
- a revert of the flip
- an edit that sets `authV2` to `false` in `flags.json`
- a `?hfy_flags=-authV2` override, in that tab only

Removing the gate does not by itself give such a page the data back. After `add-data-gate-behaviors.sh --remove`, the six data prefixes fall to the default behavior: they answer `404` to everyone, members included, while `HFYAppendIndex` runs the default-deny code, and are public from S3 only while it runs the older code (see [Where the gate is attached](#where-the-gate-is-attached)). What to do, including the order of a gate rollback (`--remove` first, then the flag revert), is in [Cut over to authV2 and the private data gate: Roll back](../how-to/cut-over-to-the-private-data-gate.md#roll-back) and [Roll back a site deploy: After an automatic rollback](../how-to/roll-back-a-site-deploy.md#after-an-automatic-rollback).

**Islands.** [`islands/src/lib/api.js`](../../islands/src/lib/api.js) holds the islands' session helpers:

| Export | Behavior |
| --- | --- |
| `getSession()` | `GET /auth/session` with `credentials: "include"`. Returns `{authenticated: true, sub, label}` or `{authenticated: false}`, never throws, and does not refresh. It runs whatever `authV2` is. |
| `edgeSignedOut()` | `true` only when `HFYFeatureFlags.edgeSession()` answered `authenticated: false`. With `authV2` off, no `feature-flags.js`, an unreachable `/auth/session` or any error, it is `false`. |
| `createApi()` | Sends the `io_id` cookie to `/api`. With `skipWhenSignedOut`, the default for the base `/api`, a request is not sent when `edgeSignedOut()` is `true`: it throws `ApiError(401, "unauthenticated")` instead, because every `/api` route would answer `401`. |
| `signedOutResponse()` | The same `401` as a `Response`, for callers that take a `fetch` function |

The `loadIsland` calls in [`11ty/js/feature-flags.js`](../../11ty/js/feature-flags.js) load each island when its flag resolves on:

| Island | Loaded when | Edge calls |
| --- | --- | --- |
| `person` | `personV2`, on `/person/?id=` | The comments thread ([`comments-ui.jsx`](../../islands/src/lib/comments-ui.jsx)): `getSession()`, and for a signed-out visitor a sign-in link to `/auth/login?returnTo=<page>`. Gated data through `HFYFeatureFlags.dataFetch`, as a background load. |
| `my-posts` | `postsV2`, on `/person/?id=` | `getSession()` |
| `posts` | `postsV2`, on `/posts/` | The comments thread in the single-post view. Its signed-out notice links to `/auth/login?returnTo=<page>`. |
| `timeline` | `postsV2`, on `/` | `edgeSignedOut()` first. A signed-out visitor gets nothing rendered and no `/api` call. |
| `shell` | `shellV2`, on every page | `HFYFeatureFlags.edgeSession()` for the account control. Signed out, a sign-in link to `/auth/login?returnTo=<here>` (`<here>` is the path, query and hash). Signed in, a sheet whose sign-out clicks the navbar link that `auth-v2.js` wired; on a page without it, the shell calls `forgetEdgeSession()`, removes the same `localStorage` and `sessionStorage` keys, sends `POST /auth/logout` itself (as `auth-v2.js` does, waiting at most 4 s), then goes to `/logged-out/`. Its search suggestions (`searchV2`) use the people corpus. |
| `search` | `searchV2`, on `/search/` | The people corpus ([`people-corpus.js`](../../islands/src/lib/people-corpus.js)): gated data through `HFYFeatureFlags.dataFetch` with the `io_id` cookie. The Lunr page and the navbar search are gone (HFY-TSK-317): this island is the only search. |
| `notifications` | `notifyV2`, on `/me/notifications/` | `edgeSignedOut()`. Signed out, it shows only a sign-in link to `/auth/login?returnTo=<page>`, and its `/api` calls are answered locally with `signedOutResponse()`. |

## Retired legacy sign-in

HFY-TSK-317 retired the legacy Google sign-in from the code and the pipeline. It deleted nothing in AWS or Google Cloud (ruling P2-R42). The cloud pieces were deleted later, on 2026-10-14: the Google Cloud pieces with io's approval (HFY-TSK-325), and the `hfy-check-allowed` Lambda with its API Gateway under ruling P2-R48 (HFY-TSK-326). What is gone, and what remains:

| Piece | State |
| --- | --- |
| Google Identity Services in the pages | Gone. No page loads `accounts.google.com/gsi/client`, `11ty/js/auth.js` is deleted, and so are the `HFY_AUTH_CONFIG` block and the `REPLACE_WITH_GOOGLE_CLIENT_ID` placeholder with its CI patch step. Google sign-in goes through the auth edge (`/auth/login`, Cognito federation). |
| Gateway session | Gone. `verifySession`, `acceptSession`, `requireSessionToken` and the `HFY_GATEWAY_SESSION_V1` cache are removed from `feature-flags.js`, with the `gateway` block of the page configuration (no page names `/api/check-allowed`). |
| `X-HFY-Session` | No code sends it. `person-page.js`, the islands and the people corpus send the `io_id` cookie only (`credentials: "same-origin"`, through `HFYFeatureFlags.dataFetch`). The repository never contained a check of the header, and the gate ignored it. |
| Magic link | Gone with `auth.js`. It never worked: `hfy-check-allowed` had no magic-link branch. |
| Lunr search | Gone. `js/search-navbar.js` and `js/search-results.js` are deleted, the navbar search markup is out of the pages, and `/search/` has only the Search 1.0 island. |
| `/family-login/` | A static redirect page to `/auth/login` (see [Client consumers](#client-consumers)). |
| `hfy-check-allowed` | Deleted on 2026-10-14 (HFY-TSK-326, ruling P2-R48): the function, its API Gateway, its IAM role and its log group. The repository no longer has its source, the `/api/check-allowed*` pin in [`add-api-behavior.sh`](../../scripts/infra/add-api-behavior.sh), the pre-commit sync check's comparison, or the grant in the deploy role's template. The deployed deploy-role stack keeps that grant until the GitHub-roles stack is next updated; a grant on a deleted function allows nothing. See [hfy-check-allowed (deleted)](#hfy-check-allowed-deleted). |
| `config/allowed_hashes.json` and `HFY_ALLOWLIST_HMAC_SECRET` | Retired on 2026-10-14 (ruling P2-R51). The allowlist publisher no longer reads the secret or writes the digest list. The object was deleted, and the secret was scheduled for deletion on 2026-11-13. See [`publish_allowlists.sh`](private-data-and-secrets.md#publish_allowlistssh). |
| `getAllowlist` | Deleted on 2026-10-14 with io's approval: the function with its Cloud Run service, the `harrisonfamily-allowlist` secret it read, and the only user-managed key of the service account that deployed it. HFY-TSK-325 removed `deploy-gcf-legacy.yml`, the source in `functions/get-allowlist/` and `gcloud/allowlist-fn/`, and the pre-commit sync check's comparison of them. |

### hfy-check-allowed (deleted)

`hfy-check-allowed` was an AWS Lambda behind an API Gateway HTTP API, reached through CloudFront at `POST /api/check-allowed`, the `gateway.endpoint` the retired pages posted to. It took a Google ID token (`id_token`, or `token`), verified it with `GOOGLE_CLIENT_ID` as the audience, and required `email_verified`. It admitted the trimmed, lower-cased email only if the email's HMAC-SHA256 digest, keyed with the `HFY_ALLOWLIST_HMAC_SECRET` secret, was in `config/allowed_hashes.json` and `config/userGrampsID.json` had a non-empty value for it. It answered `200` with `allowed`, the Gramps ID and a session token of 32 random bytes that nothing on the server stored or could validate, and `403` otherwise. It loaded the digest list, the map and the key once per container. Unlike the edge, it did not lower-case the map's keys, and it returned an object-form entry unchanged as the Gramps ID.

Production CloudFront had no `/api/check-allowed*` behavior and no API Gateway origin when read on 2026-10-13. On 2026-10-14 (HFY-TSK-326, ruling P2-R48), the function, its API Gateway, its IAM role and its log group were deleted, after the last code package and the role's policy were saved with the task record. A request to `/api/check-allowed` now goes through `/api/*` to `hfy-api`, which has no such route and answers `404` with code `not_found`. The last source is in the Git history: `git log --diff-filter=D --oneline -- lambda/hfy-check-allowed` names the commit that removed it.

### getAllowlist (deleted)

`getAllowlist` was a Google Cloud Function (2nd gen, `python311`, `us-west2`, entry point `get_allowlist`) behind an IAM-authenticated HTTP trigger. It returned `200 {"allowlist": <secret value>}` from the latest version of the Secret Manager secret `harrisonfamily-allowlist`. Nothing in any sign-in path used it: it served only as a manual check that an allowlist update had reached Secret Manager.

With io's approval, the function, its Cloud Run service, the secret and the deploy service account's only user-managed key were deleted on 2026-10-14. HFY-TSK-325 removed its deploy workflow and source from the repository, so nothing can redeploy it. The last source is in the Git history: `git log --diff-filter=D --oneline -- functions/get-allowlist` names the commit that removed it.

## Related pages

- [The identity model](../explanation/identity-model.md): why sign-in resolves to a Gramps ID, why there are two paths, how passkeys and step-up fit, and what removal does.
- [Edge and origin design](../explanation/edge-and-origin-design.md): the CloudFront front door, the origin-verify header and the two Lambda@Edge functions.
- [The privacy model for family data](../explanation/family-data-privacy.md): why the data paths and member photos are gated, and what the gate does not check.
- [The release model](../explanation/release-model.md): how a flag such as `authV2` reaches production, and why the site deploys before the gate attaches (HFY-R67).
- [The design system theme layer](../explanation/design-system-theme-layer.md) and [Theme and asset build](theme-and-asset-build.md): the theme the sign-in stylesheet shares with the site, and how `auth-edge.css` and its `?v=` are built.
- [API reference](api.md): how `hfy-api` verifies `io_id` against the JWKS.
- [MCP server](mcp-server.md): how `/mcp` checks the access tokens this authorization server issues.
- [Architecture](architecture.md), [Codebase map](codebase-map.md), [Front end](front-end.md) and [Repository operations](repository-operations.md).
- [Manage family access](../how-to/manage-family-access.md), [Deploy the app stack](../how-to/deploy-the-app-stack.md), [Deploy the edge functions](../how-to/deploy-the-edge-functions.md), [Cut over to the private data gate](../how-to/cut-over-to-the-private-data-gate.md), [Publish a change to the HFYAppendIndex CloudFront Function](../how-to/publish-the-cloudfront-function.md), [Roll back a site deploy](../how-to/roll-back-a-site-deploy.md), [Toggle a feature flag](../how-to/toggle-a-feature-flag.md), [Connect an MCP client](../how-to/connect-an-mcp-client.md), [Rotate the session signing key](../how-to/rotate-the-session-signing-key.md), [Rotate the Google sign-in client](../how-to/rotate-the-google-client.md), [Rotate the origin-verify secret](../how-to/rotate-the-origin-verify-secret.md), [Change the theme or brand fonts](../how-to/change-the-theme-or-brand-fonts.md), [Diagnose sign-in and API failures](../how-to/diagnose-sign-in-and-api-failures.md), [Run the tests](../how-to/run-the-tests.md).
