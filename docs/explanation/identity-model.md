# The identity model: one edge, one allowlist

This page explains how the family site decides who a visitor is and what they may do. It covers why sign-in methods only prove an email address, why one allowlist decides membership, why every method ends at the same auth edge, and what the legacy sign-in path still does while `authV2` is off. It describes the design and its tradeoffs. For routes, token claims and configuration, use [Identity services](../reference/identity-services.md). To add or remove a member, use [Manage family access](../how-to/manage-family-access.md).

Plan rulings cited as HFY-R*n*, and BRD decisions cited as Q-*n*, are recorded in the HFY-PLN-001 planning documents in Enceladus.

## The problem: membership, not accounts

The site is a private archive for one family. The question it has to answer about a visitor is not "does this person have an account?" It is "is this person one of the family, and which person in the tree are they?"

No sign-in method can answer that. Google can prove that a visitor controls a Google account with a verified email address. A password can prove that a visitor knows the secret set for an address. Neither knows anything about the family tree.

So the model separates two jobs (Q-1, HFY-R4):

- **A sign-in method proves control of an email address.** That is all it is trusted to do.
- **The allowlist decides membership,** and says which person in the tree the address belongs to.

It follows that the session's subject is never an identifier a provider assigns, such as the Google `sub` or the Cognito user's `sub`. It is the member's place in the tree.

## The allowlist is the authority

The allowlist is one JSON object, `config/userGrampsID.json`, in the private config bucket. Each key is an email address. Each value is the `gramps_id` of that member's person record. The edge also accepts an entry in object form, which carries a display label and extra roles:

```json
{
  "member@example.com": "<gramps_id>",
  "relative@example.org": { "gramps_id": "<gramps_id>", "label": "<display name>", "roles": ["<role>"] }
}
```

Case-insensitive matching and the object form belong to the edge, which lower-cases the keys when it parses the file. The legacy Lambda, which still serves sign-in while `authV2` is off, lower-cases only the visitor's address and looks it up with the key exactly as stored, and it hands an object entry back unchanged as the `gramps_id` ([`lambda/hfy-check-allowed/index.mjs`](../../lambda/hfy-check-allowed/index.mjs)). So while the legacy path is live, the file has to use lower-case keys and the plain string form. [Manage family access](../how-to/manage-family-access.md#1-edit-the-source-files) gives the editing rules.

The auth edge resolves the verified email through this file (the `s3_allowlist` resolver in [`auth/edge.manifest.json`](../../auth/edge.manifest.json)), and the `gramps_id` becomes the `sub` of the session token it mints. From then on, everything downstream speaks `gramps_id`: the API's actor id, the author of a comment or post, the subject of an MCP token, and the entries in the admin list.

Making one file the authority has these consequences:

- **No entry means no session.** If the email is not on the list, the edge answers 403 `not_allowlisted` and sets no cookie, and the sign-in page tells the visitor to ask a family administrator.
- **An empty `gramps_id` is denied at the edge.** The allowlist parser drops an entry whose `gramps_id` is empty, so it behaves exactly like a missing entry. The legacy Lambda denies it too. There is no way to sign in and browse without a record in the tree.
- **"My Record" is simply `/person/?id=<sub>`.** The session already carries the `gramps_id`, so [`11ty/js/auth-v2.js`](../../11ty/js/auth-v2.js) builds the link from `GET /auth/session` with no second lookup.
- **An email is never silently re-pointed.** Editing the allowlist alone does not move a member to a different person. When an email is mapped to a new `gramps_id`, a refresh of the old session, if a client makes one, fails with `principal_changed`. But the edge has already recorded the email as linked to the old `gramps_id`, in a `LINK#<email>` item in `hfy-app`. At the next sign-in, the kit's link check (`recordLink` in `@io-kit/auth` 2.0.0) finds that item, sees that it names a different `sub`, and refuses with 403 `link_conflict`. The member can sign in as the new person only after that link item is removed. Meanwhile the `io_id` cookie already issued keeps naming the old person until it expires, up to an hour after issue. The kit does this on purpose: its rule is that an email linked to one principal is never re-pointed to another, so a remap takes a second, explicit step instead of following from a file edit. The cost is that a member is locked out until someone takes that step. [Manage family access](../how-to/manage-family-access.md#change-a-members-record-or-email) covers the remap.
- **It fails closed.** The edge caches the file for five minutes. If a reload fails, it keeps serving the last good copy. If it has never loaded a copy, every sign-in is denied.

## One edge, several methods

Every sign-in method ends at the same auth edge: the `hfy-auth-edge` Lambda ([`auth/src/index.js`](../../auth/src/index.js), [`auth/src/edge.js`](../../auth/src/edge.js)), built on `@io-kit/auth` 2.0. A method only has to produce a verified email. The edge then does the same three things for every method. It resolves the email through the allowlist, records that this method is linked to that member, and mints its own RS256 session.

Two methods exist today:

- **Google Identity Services.** The browser gets a Google ID token from the GIS button and posts it to the edge. The edge checks the signature, the issuer, the audience (the site's own Google client) and that the email is verified. Google is not federated through Cognito. The user pool knows only its own users.
- **Email and password through Cognito.** The edge, not the browser, calls Cognito with the email and password (the `USER_PASSWORD_AUTH` flow in [`infrastructure/cloudformation/app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml)). Cognito holds the password and handles the verification and reset codes. The browser never talks to Cognito and never receives a Cognito token. What it receives is the edge's session. A Cognito account is not membership: an account whose email is not on the allowlist gets no session.

Both methods resolve to the same `gramps_id`. A member who uses Google one day and a password the next is therefore the same person to the site, the API and the comment history. The sign-in page says so: both methods reach the same account.

A member gets a password by signing in with Google first and then setting one at `/auth/link`. That is the only way a Cognito account comes into existence (HFY-R58). The user pool accepts no self-service sign-up, and the edge creates the Cognito user only after the allowlist has confirmed the email ([`auth/src/cognito.js`](../../auth/src/cognito.js)). The reason is pre-registration. With open sign-up, anyone holding the app's public client ID could register a family member's email with a password of their own before the member ever set one, and once that member was added to the allowlist, the stranger's password would sign in as them. Tying account creation to a verified sign-in that the allowlist already accepted closes that path.

The password path still has one anonymous entry point: "forgot password", which makes Cognito send an email to any address it is given. The edge counts those requests per email and client IP, and per IP across emails, and refuses the excess with `429` before Cognito sends anything. Without that, anyone could use the site to flood a member's inbox, or spend the account's small daily allowance of Cognito email so that a real reset code never arrives.

**Planned for launch: passkeys.** The plan (HFY-R52) adds passkeys as a third, equal method on the same edge. Shared WebAuthn support is being added to `@io-kit/auth` under DVP-TSK-A59. HFY-TSK-078 turns it on for the family site, with a prompt to enroll a passkey and a place to manage passkeys. A passkey sign-in resolves through the same allowlist, and the allowlist is checked again at every passkey sign-in, so a registered passkey does not outlive membership. The `authV2` flip is gated on this work. Nothing else in this model changes: the allowlist, the session and the `sub` stay the same.

That is the reason for the shape. Adding a method means adding a verifier at the edge. The API, the pages, the allowlist and the admin list do not change.

## Why the edge is path-mounted at /auth/*

The kit's edge is designed to run on its own host, `auth.<site>`. For this site it runs at `https://harrisonfamily.us/auth/*` instead, as a CloudFront path behavior on the site's own distribution (HFY-R31). The API sits beside it at `/api/*`. The path mount gives:

- **One origin.** The pages, the edge and the API share one origin, so the browser's calls to `/auth/*` and `/api/*` are same-origin requests. `auth-v2.js` fetches `/auth/session` and `/auth/logout` with `credentials: "same-origin"`, and the islands call `/api` with `credentials: "include"`. On one origin both send the cookie. The site's own calls need no CORS configuration, trigger no preflights, and have no allowed-origin list to get wrong. The only CORS in the edge is on the OAuth discovery, token, registration and revocation routes for MCP clients. It is an exact list of origins, without credentials.
- **No new hostname.** A subdomain would have needed a new certificate and a DNS change, each waiting on io, before anything could be tested. A path behavior on the existing distribution needs neither.
- **Host-only cookies.** The session cookie, `io_id`, is `HttpOnly`, `Secure` and `SameSite=Lax`. The committed manifest still sets `cookieDomain` ([`auth/edge.manifest.json`](../../auth/edge.manifest.json)), and the kit turns it into a `Domain` attribute on the cookie, as it expects to on `auth.<site>`, where the cookie has to reach the site. On one origin that is unnecessary, so the wrapper strips the `Domain` attribute. Without `Domain`, the browser returns the cookie only to `harrisonfamily.us` itself, never to a subdomain such as a future MCP host. `SameSite=Lax` lets the cookie travel on an ordinary link into the site, but not on cross-site subrequests.
- **Page script cannot read the session.** Because the cookie is `HttpOnly`, no script on the page can read it. The legacy path keeps its Google ID token in `localStorage` and its session token in `sessionStorage`, where any script on the page can.

The cost is a small adapter. The kit's pages and redirects assume root paths such as `/login`. [`auth/src/edge.js`](../../auth/src/edge.js) rewrites them to `/auth/login` and its siblings, strips the cookie domain, and adds two routes the kit does not ship: the JWKS and `GET /auth/session`. How CloudFront reaches the edge, and how the edge rejects requests that did not come through CloudFront (HFY-R43), is covered in [Edge and origin design](edge-and-origin-design.md).

## Why the API only ever sees public keys

Only the edge holds the private signing key (HFY-R38). It reads the key from AWS Secrets Manager when it starts, and of the stack's two Lambda roles, only the edge's may read that secret. The edge publishes the public half at `/auth/.well-known/jwks.json`.

The API, `hfy-api`, verifies the `io_id` cookie against that JWKS, with the edge's issuer and the site's audience, and takes the token's `sub` as the actor ([`api/src/auth.js`](../../api/src/auth.js)). Beyond fetching and caching the JWKS, it does not call the edge, and it does not consult the allowlist.

The reason is blast radius. The API is the larger surface and the one that changes most: comments, posts, uploads and notifications. If it is compromised, an attacker who holds only public keys cannot mint a session for anyone. Keeping signing in one small Lambda keeps the code that can create an identity small.

Today the separation covers the key, but not yet the storage. The edge keeps its refresh-token and authorization-code records in the same DynamoDB table (`hfy-app`) that the API's role can read and write. The API's role can also read everything under `config/`, which includes the allowlist. A compromised API still cannot sign a token, but it could tamper with records the edge trusts when it refreshes a session. Narrowing the API's access to the table and to `config/` would make the boundary match the intent.

## Admins are a separate list

Moderation rights come from a second file, `config/admins.json`. It lists `gramps_id` values, not emails. The API marks an actor as an admin when its `sub` is on the list. Admins may delete any comment or post, while other members may delete only their own (Q-4). MCP tokens carry the same fact as an `admins` group.

Membership and moderation are kept apart for four reasons:

- **They change at different rates.** The allowlist grows each time a relative is added. Moderation rights change rarely and should take a deliberate edit. With two files, editing membership cannot grant moderation by accident.
- **Rights follow the person.** The admin list names `gramps_id` values, so an admin keeps the role whichever sign-in method or email address they use.
- **Admin implies member.** Nobody gets a session without an allowlist entry. An admin entry for someone who has been removed from the allowlist does nothing.
- **They fail in opposite directions.** When the admin list cannot be read or parsed, nobody is an admin, and the API tries again a few seconds later. When the allowlist cannot be reloaded, the edge keeps the last good copy. Locking every member out during a brief storage error is worse than serving an old list for a few more minutes. Losing moderation rights for a few seconds costs nothing.

## What removal does and does not do

Removing an email from the allowlist stops new access quickly. It does not cut off access that has already been granted.

| What | When removal takes effect |
| --- | --- |
| A new sign-in, by any method | When the edge's cached copy expires: up to five minutes on each running instance |
| A refresh of a site session | At the first refresh after that. The refresh is re-checked against the allowlist, and the session's whole refresh family is revoked |
| An MCP code exchange or refresh | Within about a minute (the MCP membership cache holds for 60 seconds) |
| A token already issued (the `io_id` cookie, or an MCP access token) | When it expires, up to one hour after issue. The API does not consult the allowlist |
| The member's Cognito account | Never. The account stays, but no longer leads to a session |

The refresh row describes what the edge does when a client refreshes. Nothing in the site calls `/auth/refresh`: neither `auth-v2.js` nor the islands do. In practice the `io_id` cookie expires after an hour and the member signs in again, and that new sign-in is where the allowlist is checked. So removal takes effect at the first sign-in after the current `io_id` expires, and that is also where a remap surfaces, as the `link_conflict` described above. The refresh check covers clients that do refresh.

This trades revocation latency for simplicity. The API verifies a token with a public key and nothing else: no allowlist lookup, no revocation list, and no call to the edge per request. The price is that a removed member can keep an existing session for up to an hour. For a family archive, removals are rare and seldom urgent. When an hour is too long, rotating the signing key ends every session at once, at the cost of signing everyone else out too (see the next section).

The legacy path is slower to react: its Lambda caches the hash list and the mapping for the life of each instance, with no expiry.

## One signing key, one-key JWKS

The edge signs with exactly one RS256 key, identified by one `kid`, and the JWKS publishes exactly that key. Site sessions and MCP access tokens are signed with the same key.

So rotation is a replacement, not an overlap. When the key changes, the JWKS changes with it. Once the new key is in place, every outstanding token signed with the old one stops verifying, at `/auth/session`, at the API, and wherever MCP tokens are checked. In effect, everyone is signed out and signs in again.

The tradeoff is accepted for now. Overlap would mean publishing two keys, signing with one, and retiring the other on a schedule. That adds moving parts to the one component that can create identities. For a family-sized audience a forced sign-in costs a minute, and rotation is expected to be rare: after a suspected exposure, or as deliberate hygiene. If rotation becomes routine, a two-key JWKS is the change to make. The steps are in [Rotate the session signing key](../how-to/rotate-the-session-signing-key.md).

## Agents as members

An AI assistant that connects through MCP signs in as a member, not as a separate kind of user. The edge doubles as an OAuth 2.1 authorization server for MCP clients (HFY-TSK-076, [`auth/src/oauth.js`](../../auth/src/oauth.js)), and the same allowlist decides membership ([`auth/src/membership.js`](../../auth/src/membership.js)).

- **One fixed public client.** There is one client id and no client secret. Dynamic registration is a facade: it always returns that client, never issues a secret, and accepts only redirect URIs from a fixed list set in the stack.
- **PKCE with S256 is required.** An authorization code is useless without the verifier, and it can be used once, within two minutes.
- **A person authorizes it.** Authorization requires a signed-in site session, so the member signs in through the same edge, by any method. The edge then checks membership before it issues a code, again when the code is exchanged, and again at every refresh.
- **Tokens are bound to a resource.** The access token's audience is the MCP resource it was requested for, not `harrisonfamily-web`, so the site's API would reject it even if it were presented there.
- **Refresh tokens rotate.** Each refresh issues a new refresh token and retires the old one. If a retired token is presented again, the edge assumes it was stolen and revokes every refresh token in that rotation family. Access tokens already issued run to expiry, up to an hour.
- **Groups carry roles.** The token carries `members`, any extra roles from the allowlist entry, and `admins` when the `gramps_id` is on the admin list. The MCP server can therefore authorize moderation without keeping a list of its own.

Membership is reused because an agent should be trusted no more than the person who authorized it. Removing a member removes their agents at the next MCP refresh, through the same allowlist that decides their browser sign-ins. The MCP server itself (HFY-TSK-077) is not in this repository yet.

## The legacy path, still the default

`authV2` is `false` in the committed [`11ty/_data/flags.json`](../../11ty/_data/flags.json). With the flag off, `auth-v2.js` does nothing and the original Google sign-in runs unchanged. A single browser can opt in with the `?hfy_flags=` override. See [Toggle a feature flag](../how-to/toggle-a-feature-flag.md) and [Why releases ship through a pipeline and feature flags](release-model.md).

The legacy flow ([`11ty/js/auth.js`](../../11ty/js/auth.js), [`11ty/js/feature-flags.js`](../../11ty/js/feature-flags.js), [`lambda/hfy-check-allowed/index.mjs`](../../lambda/hfy-check-allowed/index.mjs)) works like this:

1. The GIS button gives the page a Google ID token, which the page keeps in `localStorage`.
2. The page posts the token to `/api/check-allowed`, which the `hfy-check-allowed` Lambda serves.
3. The Lambda verifies the token and requires a verified email. It computes an HMAC-SHA256 of the email with a key held in AWS Secrets Manager. It accepts only if that hash is in `config/allowed_hashes.json` and the email has a non-empty mapping in `config/userGrampsID.json`.
4. It returns the `gramps_id` and an opaque session token with a 15-minute expiry by default. The page keeps the token in `sessionStorage` and sends it as an `X-HFY-Session` header when it fetches person and search JSON.

The differences from the edge explain why the legacy path is being replaced. Membership lives in two files that have to agree. The session token is random bytes that the Lambda neither signs nor records, so it carries nothing another component can verify. The tokens sit in web storage that page script can read. The Lambda's caches never expire.

**The Google Secret Manager allowlist and the `getAllowlist` function were never in the sign-in path.** Earlier setup notes described a Secret Manager copy of the email list that pre-filters Google sign-ins. Google Identity Services has no hook that consults such a list, and no sign-in code calls the function. [`functions/get-allowlist/main.py`](../../functions/get-allowlist/main.py) only returns the stored list, and the hand-written deploy workflow still deploys it. Both are retiring (Q-1, HFY-R4).

The two paths share a route prefix. The legacy endpoint lives under `/api/`, so once the new `/api/*` behavior exists, `/api/check-allowed` must still route to the legacy Lambda. [`add-api-behavior.sh`](../../scripts/infra/add-api-behavior.sh) pins it there with a more specific `/api/check-allowed*` behavior, cloned from whatever served it before and ordered ahead of `/api/*` (HFY-R58). The pin retires with the legacy path.

The two paths also share pages while both are live. A visitor can hold an edge session and still need the legacy session token, because the person and search pages fetch their data with the legacy `X-HFY-Session` header, which the edge does not mint. So with `authV2` on, a visitor already signed in at the edge who lands on `/family-login/` gets the legacy Google sign-in rather than another redirect to `/auth/login`, which would loop. Signing out ends both sessions: the edge session and the legacy credentials in web storage.

### Retirement order once authV2 is flipped

The order follows from what depends on what:

1. **Flip `authV2`** (HFY-TSK-069), once the after-state audit passes, io approves, and the passkey work has landed (HFY-R52).
2. **Keep the legacy path deployed for one release** (HFY-R4). Turning the flag off is the rollback, and that only works while the old path still exists.
3. **Remove the legacy sign-in code from the pages.** After that, nothing calls `/api/check-allowed`.
4. **Retire `hfy-check-allowed`**, its `/api/check-allowed` route, `config/allowed_hashes.json` and the HMAC key. The edge already does the Lambda's job; the plan describes the Lambda as folding into the edge.
5. **Retire the Google Secret Manager copy, `getAllowlist`, and the deploy step that ships it.** Nothing in sign-in depends on them, so this step has no ordering constraint and can happen earlier. It removes a second copy of the member list.

`config/userGrampsID.json` stays. It is the allowlist.

## Further reading

- [Identity services](../reference/identity-services.md): the edge's routes, tokens, cookies and configuration, mapped to code.
- [Private data and secrets](../reference/private-data-and-secrets.md): where the allowlist, the admin list and the signing key live, and who can read them.
- [Manage family access](../how-to/manage-family-access.md): add, remove or remap a member, or change the admin list.
- [Rotate the session signing key](../how-to/rotate-the-session-signing-key.md)
- [Diagnose sign-in and API failures](../how-to/diagnose-sign-in-and-api-failures.md)
- [Edge and origin design](edge-and-origin-design.md) and [Family data privacy](family-data-privacy.md)
