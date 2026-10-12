# The identity model: one edge, one allowlist

This page explains how the family site decides who a visitor is and what they may do. It covers why sign-in methods only prove an email address, why one allowlist decides membership, why every method ends at the same auth edge, how an AI agent signs in as a member and when it must step up, and what the legacy sign-in path still does while `authV2` is off. It describes the design and its tradeoffs. For routes, token claims and configuration, use [Identity services](../reference/identity-services.md). To add or remove a member, use [Manage family access](../how-to/manage-family-access.md).

Plan rulings cited as HFY-R*n*, and BRD decisions cited as Q-*n*, are recorded in the HFY-PLN-001 planning documents in Enceladus.

## The problem: membership, not accounts

The site is a private archive for one family. The question it has to answer about a visitor is not "does this person have an account?" It is "is this person one of the family, and which person in the tree are they?"

No sign-in method can answer that. Google can prove that a visitor controls a Google account with a verified email address. A password can prove that a visitor knows the secret set for an address. A passkey can prove that a visitor holds a key enrolled for an address. None of them knows anything about the family tree.

So the model separates two jobs (Q-1, HFY-R4):

- **A sign-in method proves control of an email address.** That is all it is trusted to do.
- **The allowlist decides membership,** and says which person in the tree the address belongs to.

It follows that the session's subject is never an identifier a provider assigns, such as the Google `sub`, the Cognito user's `sub` or a passkey's credential ID. It is the member's place in the tree.

## The allowlist is the authority

The allowlist is one JSON object, `config/userGrampsID.json`, in the private config bucket. Each key is an email address. Each value is the `gramps_id` of that member's person record. The edge also accepts an entry in object form, which carries a display label and extra roles:

```json
{
  "member@example.com": "<gramps_id>",
  "relative@example.org": { "gramps_id": "<gramps_id>", "label": "<display name>", "roles": ["<role>"] }
}
```

Case-insensitive matching and the object form belong to the edge, which lower-cases the keys when it parses the file. The legacy Lambda, which still serves sign-in while `authV2` is off, lower-cases only the visitor's address and looks it up with the key exactly as stored, and it hands an object entry back unchanged as the `gramps_id` ([`lambda/hfy-check-allowed/index.mjs`](../../lambda/hfy-check-allowed/index.mjs)). So while the legacy path is live, the file has to use lower-case keys and the plain string form. [Manage family access](../how-to/manage-family-access.md#1-edit-the-source-files) gives the editing rules.

The auth edge resolves the verified email through this file (the `s3_allowlist` resolver in [`auth/edge.manifest.json`](../../auth/edge.manifest.json)), and the `gramps_id` becomes the `sub` of the session token it mints. From then on, everything downstream speaks `gramps_id`: the API's actor id, the author of a comment or post, the owner of a passkey, the subject of an MCP token, the entries in the admin list and the subjects in the MCP groups config.

Making one file the authority has these consequences:

- **No entry means no session.** If the email is not on the list, the edge answers 403 `not_allowlisted` and sets no cookie, and the sign-in page tells the visitor to ask a family administrator.
- **An empty `gramps_id` is denied at the edge.** The allowlist parser drops an entry whose `gramps_id` is empty, so it behaves exactly like a missing entry. The legacy Lambda denies it too. There is no way to sign in and browse without a record in the tree.
- **"My Record" is simply `/person/?id=<sub>`.** The session already carries the `gramps_id`, so [`11ty/js/auth-v2.js`](../../11ty/js/auth-v2.js) builds the link from `GET /auth/session` with no second lookup.
- **An email is never silently re-pointed.** Editing the allowlist alone does not move a member to a different person. When an email is mapped to a new `gramps_id`, a refresh of the old site session fails with `principal_changed` and revokes its refresh family, though the site refreshes only under `authV2` (see [Session continuity under authV2](#session-continuity-under-authv2)). An MCP refresh for the old `gramps_id` fails too, once no entry names it. A passkey enrolled for the old person is refused with `principal_changed` too, because the credential records the `sub` it was enrolled for. But the edge has already recorded the email as linked to the old `gramps_id`, in a `LINK#<email>` item in `hfy-app`. At the next sign-in, the kit's link check (`recordLink` in `@io-kit/auth` 2.1.1) finds that item, sees that it names a different `sub`, and refuses with 403 `link_conflict`. The member can sign in as the new person only after that link item is removed. Meanwhile the `io_id` cookie already issued keeps naming the old person until it expires, up to an hour after issue. The kit does this on purpose: its rule is that an email linked to one principal is never re-pointed to another, so a remap takes a second, explicit step instead of following from a file edit. The cost is that a member is locked out until someone takes that step. [Manage family access](../how-to/manage-family-access.md#change-a-members-record-or-email) covers the remap.
- **It fails closed.** The edge caches the file for five minutes. If a reload fails, it keeps serving the last good copy. If it has never loaded a copy, every sign-in is denied.

## One edge, several methods

Every sign-in method ends at the same auth edge: the `hfy-auth-edge` Lambda ([`auth/src/index.js`](../../auth/src/index.js), [`auth/src/edge.js`](../../auth/src/edge.js)), built on `@io-kit/auth` 2.1.1, which [`auth/package.json`](../../auth/package.json) and [`api/package.json`](../../api/package.json) both pin exactly. A method only has to tie the visitor to a verified email. The edge then does the same three things for every method. It resolves the email through the allowlist, records that this method is linked to that member, and mints its own RS256 session.

Three methods exist:

- **Google Identity Services.** The browser gets a Google ID token from the GIS button and posts it to the edge. The edge checks the signature, the issuer, the audience (the site's own Google client) and that the email is verified. Google is not federated through Cognito. The user pool knows only its own users.
- **Email and password through Cognito.** The edge, not the browser, calls Cognito with the email and password (the `USER_PASSWORD_AUTH` flow in [`infrastructure/cloudformation/app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml)). Cognito holds the password and handles the verification and reset codes. The browser never talks to Cognito and never receives a Cognito token. What it receives is the edge's session. A Cognito account is not membership: an account whose email is not on the allowlist gets no session.
- **Passkeys.** WebAuthn runs on the same edge (`providers[2]` in the manifest, with `rpId` `<site>`). Credentials are discoverable, so sign-in is usernameless: the login page offers the member's passkeys in the browser's autofill (conditional UI) or from a "Sign in with a passkey" button, without asking for an email first. A passkey carries no email of its own. It is added to an account that already exists, by a member who is signed in, and the edge files it under that member's `sub` and email. A passkey never creates an account. Every passkey sign-in resolves that email through the allowlist again, so a passkey does not outlive membership: a removed member gets 403 and no cookie ([`auth/e2e/passkey.e2e.mjs`](../../auth/e2e/passkey.e2e.mjs) checks this). Each member may hold up to 20 passkeys, the kit's default, which the site does not change. Enrolling one more is refused with `passkey_limit`.

The edge asks for user verification at passkey sign-in as `preferred`, not `required` (HFY-R67). User verification means the authenticator checked a biometric or a PIN. Requiring it would turn away authenticators that cannot do it, such as a security key with no PIN set, and members would lose a working way in. Leaving it preferred keeps sign-in open to any authenticator. Strength is demanded only where it matters: at the step-up for destructive agent actions, which accepts only a sign-in in which user verification was performed (see [Step-up for destructive agent actions](#step-up-for-destructive-agent-actions)).

All three methods resolve to the same `gramps_id`. A member who uses Google one day, a password the next and a passkey after that is therefore the same person to the site, the API and the comment history. The sign-in page says so: Google, email and password, or a passkey all reach the same account.

A member adds a password or a passkey after signing in, at `/auth/link`. That is the only way a Cognito account comes into existence (HFY-R58). The user pool accepts no self-service sign-up, and the edge creates the Cognito user only after the allowlist has confirmed the email ([`auth/src/cognito.js`](../../auth/src/cognito.js)). In practice, then, a member's first sign-in is with Google. The reason is pre-registration. With open sign-up, anyone holding the app's public client ID could register a family member's email with a password of their own before the member ever set one, and once that member was added to the allowlist, the stranger's password would sign in as them. Tying account creation to a verified sign-in that the allowlist already accepted closes that path. Passkeys follow the same rule for the same reason.

The password path still has one anonymous entry point: "forgot password", which makes Cognito send an email to any address it is given. The edge counts those requests per email and client IP, and per IP across emails, and refuses the excess with `429` before Cognito sends anything. Without that, anyone could use the site to flood a member's inbox, or spend the account's small daily allowance of Cognito email so that a real reset code never arrives.

Passkeys were the third method the plan called for (HFY-R52, HFY-TSK-078), built on the WebAuthn support shared through `@io-kit/auth`. Adding them changed nothing else in this model: the allowlist, the session and the `sub` stayed the same.

That is the reason for the shape. Adding a method means adding a verifier at the edge. The API, the pages, the allowlist and the admin list do not change.

## Why the edge is path-mounted at /auth/*

The kit's edge is designed to run on its own host, `auth.<site>`. For this site it runs at `https://<site>/auth/*` instead, as a CloudFront path behavior on the site's own distribution (HFY-R31). The API sits beside it at `/api/*`. The path mount gives:

- **One origin.** The pages, the edge and the API share one origin, so the browser's calls to `/auth/*` and `/api/*` are same-origin requests. Under `authV2`, a page learns about its session through `HFYFeatureFlags.edgeSession()` in [`11ty/js/feature-flags.js`](../../11ty/js/feature-flags.js): one `GET /auth/session` per page, which may `POST /auth/refresh` first when the session has lapsed or is about to. `auth-v2.js` posts `/auth/logout`, and the person and search pages fetch their data with the `io_id` cookie. All of these use `credentials: "same-origin"`. The islands call `/api` with `credentials: "include"`. On one origin both send the cookie. The site's own calls need no CORS configuration, trigger no preflights, and have no allowed-origin list to get wrong. The only CORS in the edge is on the OAuth discovery, token, registration, revocation and userinfo routes for MCP clients. It is an exact list of origins, without credentials.
- **No new hostname.** A subdomain would have needed a new certificate and a DNS change, each waiting on io, before anything could be tested. A path behavior on the existing distribution needs neither. The MCP server followed the same reasoning: it lives at the path `/mcp` on the main host (HFY-R59), not on a subdomain.
- **Host-only cookies.** The session cookie, `io_id`, is `HttpOnly`, `Secure` and `SameSite=Lax`. The refresh cookie, `io_rt`, has the same attributes and is scoped to `Path=/auth`, so only the edge ever receives it. The committed manifest still sets `cookieDomain` ([`auth/edge.manifest.json`](../../auth/edge.manifest.json)), and the kit turns it into a `Domain` attribute on the cookie, as it expects to on `auth.<site>`, where the cookie has to reach the site. On one origin that is unnecessary, so the wrapper strips the `Domain` attribute. Without `Domain`, the browser returns the cookie only to `<site>` itself, never to a subdomain. `SameSite=Lax` lets the cookie travel on an ordinary link into the site, but not on cross-site subrequests.
- **Page script cannot read the session.** Because the cookies are `HttpOnly`, no script on the page can read them. The legacy path keeps its Google ID token in `localStorage` and its session token in `sessionStorage`, where any script on the page can.

The cost is a small adapter. The kit's pages and redirects assume root paths such as `/login`. [`auth/src/edge.js`](../../auth/src/edge.js) rewrites them to `/auth/login` and its siblings, strips the cookie domain, and adds three routes the kit does not ship: the JWKS; `GET /auth/session`, which now also returns `exp`, the time the `io_id` token expires, because page script cannot read the cookie to find out; and `GET /auth/passkeys`, a `302` to `/auth/link`, the kit's account page, where a member adds, lists and removes their own passkeys. How CloudFront reaches the edge, and how the edge rejects requests that did not come through CloudFront (HFY-R43), is covered in [Edge and origin design](edge-and-origin-design.md).

## Why the API only ever sees public keys

Only the edge holds the private signing key (HFY-R38). It reads the key from AWS Secrets Manager when it starts, and of the stack's two Lambda roles, only the edge's may read that secret. The API's role may read one secret, the optional VAPID key for web push. The edge publishes the public half at `/auth/.well-known/jwks.json`.

The API, `hfy-api`, verifies the `io_id` cookie against that JWKS, with the edge's issuer and the site's audience, and takes the token's `sub` as the actor ([`api/src/auth.js`](../../api/src/auth.js)). The MCP mount in the same Lambda verifies bearer access tokens against the same JWKS. Beyond fetching and caching the JWKS, neither calls the edge, and neither consults the allowlist. The private data gate ([`edge-gate/src/gate.mjs`](../../edge-gate/src/gate.mjs)), a Lambda@Edge function that guards the family data once it is attached, verifies `io_id` the same way, with only the public keys.

The reason is blast radius. The API is the larger surface and the one that changes most: comments, posts, uploads, notifications and the MCP tools. If it is compromised, an attacker who holds only public keys cannot sign a session for anyone. Keeping signing in one small Lambda keeps the code that can create an identity small.

Today the separation covers the key, but not yet the storage. The edge keeps its records in the same DynamoDB table (`hfy-app`) that the API uses: refresh tokens (`REFRESH#`), MCP authorization codes and refresh tokens, email links (`LINK#`), and now passkey credentials (`PASSKEY#<credential id>`, indexed on GSI1 under `PASSKEYSUB#<sub>`) and the single-use WebAuthn challenges (`PASSKEYCHAL#`). The API's role may read and write any item in that table and its indexes, with no condition on the key (the `Table` statement of the `hfy-api` policy in [`app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml)). The API's role can also read everything under `config/`, which includes the allowlist.

The consequence is accepted for now. A compromised API still cannot sign a token, but it can write records the edge trusts. It could plant a refresh record and redeem it at `/auth/refresh`. It could plant a passkey credential the edge accepts: a public key of the attacker's choosing, filed under a member's `sub` and email, would sign in as that member, and the allowlist check would pass because the member is on the list. Narrowing the API's access to the table and to `config/` would make the boundary match the intent.

## Admins are a separate list

Moderation rights come from a second file, `config/admins.json`. It lists `gramps_id` values, not emails. The API marks an actor as an admin when its `sub` is on the list. Admins may delete any comment or post, while other members may delete only their own (Q-4). The edge also writes the same fact into MCP tokens as an `admins` group, but the MCP server does not use it (see below). The file may be absent, in which case nobody is a moderator.

Membership and moderation are kept apart for four reasons:

- **They change at different rates.** The allowlist grows each time a relative is added. Moderation rights change rarely and should take a deliberate edit. With two files, editing membership cannot grant moderation by accident.
- **Rights follow the person.** The admin list names `gramps_id` values, so an admin keeps the role whichever sign-in method or email address they use.
- **Admin implies member.** Nobody gets a session without an allowlist entry. An admin entry for someone who has been removed from the allowlist does nothing.
- **They fail in opposite directions.** When the admin list is absent, or cannot be read or parsed, nobody is an admin, and the API tries again a few seconds later. When the allowlist cannot be reloaded, the edge keeps the last good copy. Locking every member out during a brief storage error is worse than serving an old list for a few more minutes. Losing moderation rights for a few seconds costs nothing.

The MCP server at `/mcp` ignores the groups in the token. It authorizes from a third file, `config/groups.json`, whose shape is documented in [`api/src/policy.js`](../../api/src/policy.js). It has two groups. `mcp-authors` may list and create comments and posts, and names its members by subject or by email. `hfy-admin` may also delete, after a step-up, and names subjects only. Neither group follows from `config/admins.json`: a site moderator is not an MCP admin unless the groups file says so. A separate list, failing closed, is deliberate:

- **Agent authoring is opt-in and curated.** Being a member does not put an agent to work in the archive. A member in neither group can connect a client, but sees no tools.
- **An email claim can never grant deletes.** `hfy-admin` accepts subjects only, so no address in a token, however it got there, reaches the delete tools.
- **A load failure grants nothing.** When the file cannot be read or parsed, every caller has no groups, and the API tries again five seconds later. For agent rights, the safe failure is refusal, as it is for moderation.

## What removal does and does not do

Removing an email from the allowlist stops new access quickly. It does not cut off access that has already been granted.

| What | When removal takes effect |
| --- | --- |
| A new sign-in, by any method | When the edge's cached copy expires: up to five minutes on each running instance |
| A passkey sign-in | The same. Every passkey sign-in re-checks the allowlist, so a removed member gets 403 and no cookie. The credential stays in the table, but no longer leads to a session |
| A refresh of a site session | At the first refresh after the cached copy expires. The refresh is re-checked against the allowlist, and the session's whole refresh family is revoked. The site refreshes only under `authV2`, and then within the hour |
| An MCP code exchange or refresh | Within about a minute (the MCP membership cache holds for 60 seconds) |
| A token already issued (the `io_id` cookie, or an MCP access token) | When it expires, up to one hour after issue. Neither the API, the data gate nor the MCP server consults the allowlist |
| The member's Cognito account | Never. The account stays, but no longer leads to a session |

The refresh row depends on `authV2`. While `authV2` is off, nothing in the site calls `/auth/refresh`. The `io_id` cookie expires after an hour and the member signs in again, and that new sign-in is where the allowlist is checked. So removal takes effect at the first sign-in after the current `io_id` expires, and that is also where a remap surfaces, as the `link_conflict` described above. With `authV2` on, `feature-flags.js` refreshes silently when the session nears expiry and when the data gate answers 401 (HFY-R66). Removal then takes effect at the next refresh, within about an hour, and revokes the refresh family. A remap surfaces at that refresh as `principal_changed`, and at the sign-in that follows as `link_conflict`.

This trades revocation latency for simplicity. The API and the gate verify a token with a public key and nothing else: no allowlist lookup, no revocation list, and no call to the edge per request. The price is that a removed member can keep an existing session for up to an hour. For a family archive, removals are rare and seldom urgent. When an hour is too long, rotating the signing key invalidates every outstanding `io_id` and access token at once. Clients that refresh come back through the allowlist check, and a removed member is refused there. Everyone else signs in again (see the next section).

The legacy path is slower to react: its Lambda caches the hash list and the mapping for the life of each instance, with no expiry.

### Session continuity under authV2

`io_id` lives one hour. Once the data gate is attached, every request for person, search or media data needs a valid `io_id`, so without a refresh a gated site would send members back to `/auth/login` every hour. Under `authV2`, `feature-flags.js` keeps the session going from the refresh cookie, `io_rt`, which lives far longer (the manifest's `installed` profile: 30 days, renewed at each refresh). It refreshes when a page loads or before its first data fetch, if `io_id` is gone or within two minutes of the `exp` that `/auth/session` reports, and once after a gate 401, retrying the request once. Only when that fails does an interactive page go to `/auth/login?returnTo=...` (HFY-R66).

The refresh is also the allowlist checkpoint. Each one resolves the member's email again, so continuity never extends access past membership: a removed or remapped member is refused at the next refresh.

Continuity has a cost when a device is lost while it is still signed in. Its refresh cookie keeps it signed in, and each refresh renews the 30 days, because the allowlist check passes: the member is still a member. Removing a lost passkey does not change that, since the session no longer depends on how it began. The edge has no "sign out everywhere". `/auth/logout` revokes only the calling browser's refresh family, so an operator revokes the member's other families by hand ([Sign a member out on every device](../how-to/manage-family-access.md#sign-a-member-out-on-every-device)).

The `hfy:edge-session` marker in `localStorage` limits refresh attempts to browsers that have had an edge session. The page-load probe refreshes a signed-out session only when the marker is set, so a visitor who has never signed in at the edge does not send a refresh from every page. A data fetch, which cannot succeed without a session, still tries one refresh before it gives up. A refresh that fails with 401 or 403, and sign-out, remove the marker.

## One signing key, one-key JWKS

The edge signs with exactly one RS256 key, identified by one `kid`, and the JWKS publishes exactly that key. Site sessions and MCP access tokens are signed with the same key.

So rotation is a replacement, not an overlap. When the key changes, the JWKS changes with it. Once the new key is in place, every outstanding `io_id` and access token signed with the old one stops verifying, wherever the JWKS is used: at `/auth/session`; at the data gate, which caches the JWKS for 300 s and fetches it again when it meets an unknown `kid`; at `hfy-api`; and at the MCP mount in the same Lambda. Refresh tokens are not signed tokens. They are opaque records in the table (`REFRESH#` for site sessions, and their MCP counterparts), so rotation does not revoke them. A browser under `authV2` and an MCP client refresh, pass the allowlist check, and get tokens under the new key. With `authV2` off nothing refreshes, so a member's edge session simply ends and they sign in again, as does anyone without a refresh cookie. The legacy Google sign-in never used this key and is not affected.

The tradeoff is accepted for now. Overlap would mean publishing two keys, signing with one, and retiring the other on a schedule. That adds moving parts to the one component that can create identities. Under `authV2` most members will not notice, because their next page load refreshes. For the rest of a family-sized audience a forced sign-in costs a minute, and rotation is expected to be rare: after a suspected exposure, or as deliberate hygiene. If rotation becomes routine, a two-key JWKS is the change to make. The steps are in [Rotate the session signing key](../how-to/rotate-the-session-signing-key.md).

## Agents as members

An AI assistant that connects through MCP signs in as a member, not as a separate kind of user. The edge doubles as an OAuth 2.1 authorization server for MCP clients (HFY-TSK-076, [`auth/src/oauth.js`](../../auth/src/oauth.js)), and the same allowlist decides membership ([`auth/src/membership.js`](../../auth/src/membership.js)).

- **One fixed public client.** There is one client id and no client secret. Dynamic registration is a facade: it always returns that client, never issues a secret, and accepts only redirect URIs from a fixed list set in the stack.
- **PKCE with S256 is required.** An authorization code is useless without the verifier, and it can be used once, within two minutes.
- **A person authorizes it.** Authorization requires a signed-in site session, so the member signs in through the same edge, by any method. The edge then checks membership before it issues a code, again when the code is exchanged, and again at every refresh.
- **Tokens are bound to a resource.** The access token's audience is the MCP resource it was requested for, not `harrisonfamily-web`, so the site's API and the data gate would reject it even if it were presented there.
- **Refresh tokens rotate.** Each refresh issues a new refresh token and retires the old one. If a retired token is presented again, the edge assumes it was stolen and revokes every refresh token in that rotation family. Access tokens already issued run to expiry, up to an hour.
- **Groups are carried but not used.** The token still carries `members`, any extra roles from the allowlist entry, and `admins` when the `gramps_id` is on the admin list. The MCP server at `/mcp` ignores them and authorizes from `config/groups.json` instead (see [Admins are a separate list](#admins-are-a-separate-list)).
- **Tokens carry sign-in facts.** Access tokens now carry `email`, `amr` (how the member signed in) and `auth_time` (when), and `name` when the member has a usable display label. The resource server needs the assurance facts to decide a step-up, and it needs a label for the comments and posts an agent writes that is never an email address, because every member sees it (HFY-R64, HFY-R68). The edge never mints a `name` that looks like an email; without one, the API labels the author from the person's own record.

Membership is reused because an agent should be trusted no more than the person who authorized it. Removing a member removes their agents at the next MCP refresh, through the same allowlist that decides their browser sign-ins. The MCP server is in [`api/src/mcp.js`](../../api/src/mcp.js), mounted at `/mcp` in `hfy-api`. [MCP server](../reference/mcp-server.md) describes its tools, policy and configuration.

### Step-up for destructive agent actions

A delete through MCP needs more than membership in `hfy-admin`. The access token must also show a recent sign-in in which the member's authenticator verified them (HFY-R64, narrowed by HFY-R67). [`api/src/policy.js`](../../api/src/policy.js) sets this for every `*.delete` action: `amr` must contain `mfa`, and `auth_time` must be no more than 300 s old.

Only `mfa` counts, because it is the one value that says user verification was performed. A passkey sign-in always records `passkey`, plus `hwk` for a device-bound key or `swk` for a synced one, and adds `mfa` only when the authenticator checked a biometric or PIN. `passkey`, `hwk` or `swk` alone is a single possession factor: a security key with no PIN, left in a shared computer, produces it. `pwd` (a password) and `fed` (Google) never count. The default in `@io-kit/mcp` would also accept `passkey` and `hwk`; the site narrows it to `mfa`.

The window is 300 s, and `auth_time` is the time of the original sign-in. Under `@io-kit/auth` 2.1.1 it survives both refresh paths: the browser's `POST /auth/refresh` and the MCP refresh grant both carry the stored time forward and never advance it. A session signed in days ago and refreshed since still reads as days old, so a long-lived refreshed session cannot pass. A record from before that version has no sign-in time and reads as 0, which is always stale.

A client does not have to wait for the member to sign in again on their own. `/auth/authorize` honors the OIDC `max_age` and `prompt=login` parameters. When the session is older than `max_age`, or the client sends `prompt=login`, the edge sends the member to `/auth/login` and then back to the same authorization request, so the new token carries a fresh `auth_time`.

## The legacy path, the default until the cutover

Until the cutover sets `authV2` to `true` in [`11ty/_data/flags.json`](../../11ty/_data/flags.json), the legacy path is what visitors get. With the flag off, `auth-v2.js` does nothing and the original Google sign-in runs unchanged. A single browser can opt in with the `?hfy_flags=` override. See [Toggle a feature flag](../how-to/toggle-a-feature-flag.md) and [Why releases ship through a pipeline and feature flags](release-model.md).

The legacy flow ([`11ty/js/auth.js`](../../11ty/js/auth.js), [`11ty/js/feature-flags.js`](../../11ty/js/feature-flags.js), [`lambda/hfy-check-allowed/index.mjs`](../../lambda/hfy-check-allowed/index.mjs)) works like this:

1. The GIS button gives the page a Google ID token, which the page keeps in `localStorage`.
2. The page posts the token to `/api/check-allowed`, which the `hfy-check-allowed` Lambda serves.
3. The Lambda verifies the token and requires a verified email. It computes an HMAC-SHA256 of the email with a key held in AWS Secrets Manager. It accepts only if that hash is in `config/allowed_hashes.json` and the email has a non-empty mapping in `config/userGrampsID.json`.
4. It returns the `gramps_id` and an opaque session token with a 15-minute expiry by default. The page keeps the token in `sessionStorage` and sends it as an `X-HFY-Session` header when it fetches person and search JSON.

The differences from the edge explain why the legacy path is being replaced. Membership lives in two files that have to agree. The session token is random bytes that the Lambda neither signs nor records, so it carries nothing another component can verify, and nothing does: the data paths do not check the header. The tokens sit in web storage that page script can read. The Lambda's caches never expire.

**The Google Secret Manager allowlist and the `getAllowlist` function were never in the sign-in path.** Earlier setup notes described a Secret Manager copy of the email list that pre-filters Google sign-ins. Google Identity Services has no hook that consults such a list, and no sign-in code calls the function. [`functions/get-allowlist/main.py`](../../functions/get-allowlist/main.py) only returns the stored list, and the hand-written deploy workflow still deploys it. Both are retiring (Q-1, HFY-R4).

The two paths share a route prefix. The legacy endpoint lives under `/api/`, so once the new `/api/*` behavior exists, `/api/check-allowed` must still route to the legacy Lambda. [`add-api-behavior.sh`](../../scripts/infra/add-api-behavior.sh) pins it there with a more specific `/api/check-allowed*` behavior, cloned from whatever served it before and ordered ahead of `/api/*` (HFY-R58). The pin retires with the legacy path.

The two paths also share pages while both are live. Under `authV2`, the person and search pages no longer need the legacy `X-HFY-Session` token: their data fetches go through `HFYFeatureFlags.dataFetch()`, which sends the `io_id` cookie instead. A visitor already signed in at the edge who lands on `/family-login/` still gets the legacy Google sign-in, but now only to avoid a redirect loop back to `/auth/login`. The header comment in `auth-v2.js` still gives the older reason, the missing legacy token; [Front end](../reference/front-end.md#auth-v2js-behavior) describes what the script does. Signing out ends both sessions: the edge session and the legacy credentials in web storage.

The data gate is a second verifier of `io_id`, after the API. It is a Lambda@Edge viewer-request function on the gated data paths (`/person/*.json`, `/family/*`, `/event/*`, `/note/*`, `/place/*`, `/media/*`), and it admits a request only with a valid `io_id`. Once it is attached, the legacy client cannot read data: the gate checks only `io_id`, and the legacy token proves nothing it can check. That is why the gate is attached only after the site has moved to `authV2`, and why the legacy path cannot be the rollback once the gate is in place.

### Retirement order once authV2 is flipped

The order follows from what depends on what:

1. **Flip `authV2`** (HFY-TSK-069), once the after-state audit passes and io gives the G-prod approval. The passkey work it used to wait on (HFY-R52) has landed.
2. **Confirm the client.** On the deployed site, a signed-in member's person and search requests carry the `io_id` cookie and no `X-HFY-Session` header, and data and photos load. Without the gate, the flip changes nothing about who can read data, so this step is safe to take slowly.
3. **Attach the data gate** (HFY-TSK-080, HFY-R67). Attaching it first would refuse person, search and media data to every visitor still on the old client until the site deploy finished. [Cut over to the private data gate](../how-to/cut-over-to-the-private-data-gate.md) gives the steps.
4. **Keep the legacy path deployed for one release** (HFY-R4). Rollback now means removing the gate first, and only then turning the flag off if the `authV2` client itself is at fault. Never turn `authV2` off while the gate is attached: the legacy client cannot read gated data. A CI rollback of the site that restores an artifact with `authV2` off counts as turning it off.
5. **Remove the legacy sign-in code from the pages.** After that, nothing calls `/api/check-allowed`.
6. **Retire `hfy-check-allowed`**, its `/api/check-allowed` route, `config/allowed_hashes.json` and the HMAC key. The edge already does the Lambda's job; the plan describes the Lambda as folding into the edge.
7. **Retire the Google Secret Manager copy, `getAllowlist`, and the deploy step that ships it.** Nothing in sign-in depends on them, so this step has no ordering constraint and can happen earlier. It removes a second copy of the member list.

`config/userGrampsID.json` stays. It is the allowlist.

## Further reading

- [Identity services](../reference/identity-services.md): the edge's routes, tokens, cookies and configuration, mapped to code.
- [MCP server](../reference/mcp-server.md): the tools at `/mcp`, the policy table, the groups config and the step-up rule.
- [Private data and secrets](../reference/private-data-and-secrets.md): where the allowlist, the admin list and the signing key live, and who can read them.
- [Manage family access](../how-to/manage-family-access.md): add, remove or remap a member, or change the admin list.
- [Cut over to the private data gate](../how-to/cut-over-to-the-private-data-gate.md): flip `authV2`, attach the gate, and roll back in the right order.
- [Connect an MCP client](../how-to/connect-an-mcp-client.md)
- [Rotate the session signing key](../how-to/rotate-the-session-signing-key.md)
- [Diagnose sign-in and API failures](../how-to/diagnose-sign-in-and-api-failures.md)
- [Edge and origin design](edge-and-origin-design.md) and [Family data privacy](family-data-privacy.md)
