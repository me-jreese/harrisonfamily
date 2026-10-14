# How to rotate the session signing key

The auth edge, `hfy-auth-edge`, signs every edge session (the `io_id` cookie) and every MCP access token with one RS256 key. The key is stored in the Secrets Manager secret `harrisonfamily/auth-edge/session-signing-key`. This page replaces that key with a new one under a new `kid`, recycles the edge so it loads the new key, records the new `kid` in the repository, and confirms that the edge publishes the new key. Rotation makes every outstanding `io_id` and MCP access token stop verifying. Clients that hold a refresh token, which means MCP clients and the site under `authV2`, silently refresh and get tokens signed with the new key. [The identity model](../explanation/identity-model.md#one-signing-key-one-key-jwks) explains why there is no overlap period. [Identity services](../reference/identity-services.md) describes the secret format, the JWKS and the refresh routes.

Values in angle brackets, such as `<site>` and `<gramps-id>`, are placeholders. `<n>` is the number in the new key ID. The forms are listed in [Private data and secrets](../reference/private-data-and-secrets.md#placeholders).

## Before you start

- **io's explicit go-ahead, in the session or in the dispatch or plan that authorizes it.** [`AGENTS.md`](../../AGENTS.md) lists rotating the session signing key among the operations that need it. Pick a quiet window too.
- **Every outstanding edge token stops verifying.** The JWKS at `/auth/.well-known/jwks.json` publishes a single key. When the edge switches to the new key, every token signed with the old one stops verifying. That covers the `io_id` session cookie at `/auth/session`, at `/api/*` and at the data gate, and every MCP access token at `/mcp`. The verifiers outside the edge notice at different times, as described in [Other JWKS consumers](#other-jwks-consumers).
- **Clients with a refresh token recover on their own.** Refresh tokens are opaque records in the `hfy-app` table, not JWTs, so the rotation does not revoke them. An MCP client refreshes through `/auth/token`. The site under `authV2` refreshes through `/auth/refresh` when a page finds its session signed out, and when the gate refuses a data request ([Session continuity under authV2](../explanation/identity-model.md#session-continuity-under-authv2)). Both get tokens signed with the new key, so members under `authV2` normally see no sign-in prompt.
- **Check which client the site runs, and whether the gate is attached.** The production cutover on 2026-10-12 (HFY-TSK-069, HFY-R67) set `authV2` to `true` and then attached the data gate. A flag or the gate can change without a docs edit, so read both before you rotate:

  ```bash
  curl -s https://<site>/_data/flags.json | jq .authV2
  curl -s -o /dev/null -w '%{http_code}\n' https://<site>/person/index.json
  ```

  The first command prints the deployed flag. The second, sent signed out, prints one of three codes:

  - `401`: the gate is attached.
  - `200`: the gate is not attached, and the data is served to anyone. `HFYAppendIndex`, the CloudFront Function on the default behavior, runs its older code, or a broader legacy behavior such as `/person/*` serves the path before the function sees it.
  - `404`: the gate is not attached, and `HFYAppendIndex` runs its default-deny code ([`scripts/cloudfront/append-index.js`](../../scripts/cloudfront/append-index.js)). The data is refused to every visitor, members included.

  [Why the CloudFront Function also denies](../explanation/edge-and-origin-design.md#why-the-cloudfront-function-also-denies) explains the difference.

  Cloudflare caches none of these answers. It does not cache JSON by default, and the `401` and `404` also carry `Cache-Control: private, no-store`.

  Then choose by both answers:

  - **`true`, with `401` or `200`.** The site refreshes as described above, so members normally see no sign-in prompt. Plan for the gate's lag in [Other JWKS consumers](#other-jwks-consumers) when the second command prints `401`.
  - **Not `true`, with `200`.** This is the state of a new environment before its cutover, or of production after a rollback that removed the gate. In both cases it appears only while nothing refuses the data: `HFYAppendIndex` runs its older code, or a legacy behavior serves the path first. The site does not refresh edge sessions, and an edge session serves only the `/auth/*` pages, tabs that preview `authV2` through the `?hfy_flags=` override, and MCP. A preview tab refreshes like the site under the flag. Anyone else signed in at `/auth/login` signs in again, so tell them to expect it. No member signs in any other way: the legacy Google sign-in is gone, and its Lambda, `hfy-check-allowed`, was deleted on 2026-10-14 (HFY-TSK-326; see [The legacy path after the cutover](../explanation/identity-model.md#the-legacy-path-after-the-cutover)).
  - **Not `true`, with `401`.** The site is serving a page with `authV2` off behind the gate. It never refreshes `io_id`, so members cannot see family data once the hour is up. Do not rotate. Follow [Check authV2 after a failed deploy](roll-back-a-site-deploy.md#check-authv2-after-a-failed-deploy) first.
  - **`404`, whatever the flag.** Members cannot read person, search or media data with either client. Do not rotate: fix that first, or check 3 in [Verify](#verify) fails for a reason that has nothing to do with the key. Follow [Check authV2 after a failed deploy](roll-back-a-site-deploy.md#check-authv2-after-a-failed-deploy), then [Find your starting point](cut-over-to-the-private-data-gate.md#find-your-starting-point) in the cutover page.
- **Do not use `create-session-key.sh`.** [`scripts/infra/create-session-key.sh`](../../scripts/infra/create-session-key.sh) is not a rotation tool. It does nothing when the secret already exists.
- **After a suspected exposure, plan for no rollback.** [Undo](#undo) restores the old key. Use it only to recover from a rotation that failed, never to return to a key that may have leaked.

You need:

- AWS credentials for `us-west-2` that allow:
  - `secretsmanager:PutSecretValue`, `secretsmanager:ListSecretVersionIds` and `secretsmanager:DescribeSecret` on the secret, plus `secretsmanager:UpdateSecret` for the optional description update in step 1.6 and its undo, and `secretsmanager:UpdateSecretVersionStage` if you need to undo.
  - `lambda:UpdateFunctionConfiguration` and `lambda:GetFunctionConfiguration` on `hfy-auth-edge`, and on `hfy-api` if you recycle it too.
  - `logs:FilterLogEvents` on the `/aws/lambda/hfy-auth-edge` log group, for the log check in [Verify](#verify).
- The AWS CLI, `openssl`, `jq` and `curl`.
- For check 4 in [Verify](#verify): a second browser, or a separate browser profile, that signs in at `https://<site>/auth/login` shortly before step 1, so that it holds an `io_id` signed with the old key. An `io_id` lasts an hour. Close every other tab of the site in it, and do not use it for check 3, so nothing replaces or refreshes that session before the check. Private windows of one browser share their cookies, so a second private window is not enough.
- For the MCP check: Node 22 or later, and `npm ci` already run in `auth/`, which needs a CodeArtifact token (see [Run the tests](run-the-tests.md#7-run-the-mcp-token-smoke-check-live)).

## Other JWKS consumers

The edge's own routes, such as `/auth/session`, use the new key as soon as [step 2](#step-2-recycle-the-auth-edge) recycles the edge. The other verifiers cache the JWKS in each warm container, so each one lags behind the rotation:

| Verifier | Still accepts an old token for up to | Can refuse a new token for up to | How the lag ends |
| --- | --- | --- | --- |
| The data gate, `hfy-edge-gate`, while it is attached | 5 minutes after step 2 | 30 s | Wait. You cannot recycle the gate the way step 2 recycles a regional function: its containers run a published Lambda@Edge version, and replacing that version is a release ([Deploy the edge functions](deploy-the-edge-functions.md)). |
| `hfy-api`, on `/api/*` | 10 minutes after step 2 | 30 s | Wait, or recycle `hfy-api` in step 2.3. |
| The MCP mount at `/mcp`, in `hfy-api` | 1 hour, the life of an access token | None: it refetches as soon as a token names an unknown `kid` | Wait, or recycle `hfy-api` in step 2.3. |

What the lags mean for members:

- **Gated data.** The site under `authV2` refreshes the session and retries a data request that the gate refuses, so members normally see nothing. Only if the retry is refused too does a page the member opened go to `/auth/login`.
- **Photos.** Images under `/media/*` and `/uploads/*` load as plain images, which are not refreshed or retried. At a gate container that fetched the key set just before step 2, a photo may fail to load for up to 30 s. It loads again when the member reloads the page.
- **API calls.** The islands' `/api` calls do not refresh or retry. A call that a warm `hfy-api` container refuses in its 30 s window fails, and works again once the window ends.

The mechanisms are in [Identity services: JWKS cache](../reference/identity-services.md#jwks-cache) and [Client consumers](../reference/identity-services.md#client-consumers) for the gate and the site's refresh, [API: Session verification](../reference/api.md#session-verification) for `hfy-api`, and [MCP server: Configuration](../reference/mcp-server.md#configuration) for the MCP mount.

## Step 1: Put a new key in the secret

Run every step on this page from one shell, because later steps reuse the variables set here.

1. Find the key ID the edge publishes now:

   ```bash
   curl -s https://<site>/auth/.well-known/jwks.json | jq -r '.keys[].kid'
   ```

   The command prints one ID, such as `hfy-session-1`.

2. Set the names. Choose a new key ID by adding one to the current number. Never reuse an earlier ID. Every JWKS consumer refetches only for a `kid` it does not know. Under a reused ID, a warm `hfy-api` container rejects every new session for up to ten minutes, the gate refuses gated data for up to five minutes, and the MCP mount rejects new access tokens for up to an hour.

   ```bash
   NAME=harrisonfamily/auth-edge/session-signing-key
   REGION=us-west-2
   NEW_KID=hfy-session-<n>
   ```

3. Record the version that is current now. [Undo](#undo) needs it. A version ID is not secret, so keep a note of it outside the shell as well.

   ```bash
   OLD_VERSION=$(aws secretsmanager list-secret-version-ids --region "$REGION" --secret-id "$NAME" \
     --query "Versions[?contains(VersionStages, 'AWSCURRENT')].VersionId" --output text)
   echo "old version: $OLD_VERSION"
   ```

4. Generate an RSA-2048 key in a private temporary directory, build the secret JSON `{privateKeyPem, kid}`, store it as a new version, and delete the directory. The block runs in a subshell, so `umask 077` and the cleanup trap do not leak into your shell. The key is written only to that directory and is never printed. The block prints only the new version ID.

   ```bash
   NEW_VERSION=$(
     set -euo pipefail
     umask 077
     TMP=$(mktemp -d)
     trap 'rm -rf "$TMP"' EXIT
     openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$TMP/key.pem" 2>/dev/null
     jq -n --rawfile k "$TMP/key.pem" --arg kid "$NEW_KID" '{privateKeyPem: $k, kid: $kid}' > "$TMP/secret.json"
     aws secretsmanager put-secret-value --region "$REGION" --secret-id "$NAME" \
       --secret-string "file://$TMP/secret.json" --query VersionId --output text
   )
   echo "new version: $NEW_VERSION"
   ```

   If `new version:` is empty, the block failed before it stored anything. Fix the cause and run it again.

5. Confirm the labels. The new version holds `AWSCURRENT`, and the old version holds `AWSPREVIOUS`:

   ```bash
   aws secretsmanager describe-secret --region "$REGION" --secret-id "$NAME" --query VersionIdsToStages
   ```

6. Optional: update the secret's description. `create-session-key.sh` wrote one that names the key ID it created the secret with, and a rotation does not change it. The description is only a label, and nothing reads it, so you may leave it naming the old ID. Changing it does not create a new version:

   ```bash
   aws secretsmanager update-secret --region "$REGION" --secret-id "$NAME" \
     --description "harrisonfamily auth edge RS256 session signing key (kid $NEW_KID)" --query Name --output text
   ```

To check the new key, use the published JWKS in [Verify](#verify). Do not run `get-secret-value`, because it prints the private key.

## Step 2: Recycle the auth edge

The edge reads the secret once per container, on its first request ([`auth/src/index.js`](../../auth/src/index.js)). Warm containers keep signing with the old key until they are replaced. Until you recycle them, new containers sign with the new key while warm ones sign with the old key, and the two publish different JWKS. Run this step straight after step 1.

1. Change the function's description. Any configuration change sends new requests to fresh containers, and the description is the one setting nothing reads:

   ```bash
   aws lambda update-function-configuration --region "$REGION" --function-name hfy-auth-edge \
     --description "session signing key $NEW_KID" --query LastUpdateStatus --output text
   ```

   Do not use `--environment` for this. It replaces the whole variable map, including the `ORIGIN_VERIFY` value that the stack resolved from its secret.

2. Wait until the update finishes:

   ```bash
   aws lambda wait function-updated --region "$REGION" --function-name hfy-auth-edge
   ```

3. Optional: to end old sessions at the API and old access tokens at the MCP mount now, rather than within ten minutes and an hour, recycle `hfy-api` the same way. Fresh containers fetch the new key set on their first token, so this also closes the 30 s window in which a warm container can refuse the new `kid`:

   ```bash
   aws lambda update-function-configuration --region "$REGION" --function-name hfy-api \
     --description "reload session JWKS for $NEW_KID" --query LastUpdateStatus --output text
   aws lambda wait function-updated --region "$REGION" --function-name hfy-api
   ```

[`app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml) does not set a description, so a later stack deploy may clear it. That is harmless.

## Step 3: Record the new kid in the repository

The secret's `kid` overrides the manifest's, so the edge already uses the new ID. Two files still name the old one. Open a pull request that changes both:

| File | Change |
| --- | --- |
| [`auth/edge.manifest.json`](../../auth/edge.manifest.json) | Set `session.kid` to the new ID. The edge falls back to this value when the secret has no `kid`. |
| [`scripts/mcp/token-smoke.sh`](../../scripts/mcp/token-smoke.sh) | Replace the hard-coded `kid === "hfy-session-1"` with the new ID. Until you do, the smoke check fails against the rotated edge. |

In the same pull request, update the old ID where these pages quote it:

- the `session.kid` row in [Identity services](../reference/identity-services.md#edgemanifestjson)
- the signature row in [MCP token smoke](../reference/repository-operations.md#mcp-token-smoke-scriptsmcptoken-smokesh) and the `token-smoke.sh` entry in [Known code issues](../reference/repository-operations.md#known-code-issues), both in Repository operations
- the key-ID sentence at the end of step 7 of [Run the tests](run-the-tests.md#7-run-the-mcp-token-smoke-check-live)
- the sample output in [Start with four requests](diagnose-sign-in-and-api-failures.md#start-with-four-requests), and the expected-`kid` sentence in step 2 of [The MCP server refuses a client](diagnose-sign-in-and-api-failures.md#the-mcp-server-refuses-a-client)
- the sentence in check 2 of [Verify](deploy-the-app-stack.md#verify) in Deploy the app stack that says the JWKS prints `hfy-session-1` unless you chose another ID. Reword it to name the current key ID, `hfy-session-<n>` after a rotation.

Leave the `--kid` default in `create-session-key.sh`, the places that state that default in [Repository operations](../reference/repository-operations.md#create-session-keysh-and-create-origin-verifysh) and in step 1 of [Deploy the app stack](deploy-the-app-stack.md#1-create-the-secrets), and the IDs in `auth/test/`, `auth/e2e/`, `api/test/` and `edge-gate/test/`, as they are. The script uses its default only when it creates the secret for the first time, and the tests sign with their own keys.

No workflow builds or deploys `hfy-auth-edge`, so merging this pull request does not change production. The new manifest reaches the edge with its next hand deploy from a commit that includes it ([Deploy the app stack](deploy-the-app-stack.md)), and its `session.kid` matters only if the secret ever lacks a `kid`.

## Verify

1. **The JWKS shows the new key.** Run this several times, so that more than one container answers. Every run prints only the new ID:

   ```bash
   curl -s https://<site>/auth/.well-known/jwks.json | jq -r '.keys[].kid'
   ```

   CloudFront does not cache `/auth/*`, and Cloudflare, which proxies the site, does not cache JSON by default, so `curl` sees the edge directly. A browser may show the old JWKS for up to five minutes, because the edge sends `max-age=300`.

2. **The edge started cleanly.** A malformed secret makes every route return `500 {"code":"AUTH_CONFIG"}`. This command prints nothing when all is well:

   ```bash
   aws logs tail /aws/lambda/hfy-auth-edge --region "$REGION" --since 15m --filter-pattern '"hfy-auth-edge failed"'
   ```

3. **A fresh sign-in works.** In a private window of your usual browser, not the second browser kept for check 4, sign in at `https://<site>/auth/login`. Then:
   - `https://<site>/auth/session` shows `"authenticated":true`.
   - `https://<site>/api/posts` returns `200` with `{items, cursor}`, not `"error":"unauthenticated"`.
   - Your own person page, `https://<site>/person/?id=<gramps-id>`, loads its data. In DevTools > Network, `/person/<gramps-id>.json` answers `200`. This proves the new key at the gate only while the gate is attached, as the check in [Before you start](#before-you-start) shows. Without the gate, the file is public (`200`) or refused to everyone (`404`), depending on the code `HFYAppendIndex` runs and on any legacy behavior that serves the path first, so the check proves nothing about the key.

   If `/api/posts` returns `"error":"unauthenticated"` right after the rotation and you skipped step 2.3, a warm `hfy-api` container may not have reloaded the JWKS yet. It refetches on an unknown `kid` at most once every 30 seconds. Wait 30 seconds and try again, or recycle `hfy-api` as in [step 2](#step-2-recycle-the-auth-edge). A gated request refused in the same way is refreshed and retried by the page itself, as described in [Other JWKS consumers](#other-jwks-consumers).

   The session response names your `<gramps-id>`, and the posts response and the person page hold family content, so do not paste any of them anywhere public.

4. **An old session is rejected.** In the second browser that signed in at `/auth/login` before step 1, open `https://<site>/auth/session` directly, before any other page of the site. It shows `{"authenticated":false}`.

   Check `/auth/session` itself, not a site page. Under `authV2`, a site page refreshes the session under the new key first, so `/auth/session` would then show `"authenticated":true` and prove nothing about the old key. A session older than an hour proves nothing either, because an `io_id` expires after an hour anyway.

   Then open `https://<site>/person/?id=<gramps-id>` in the same browser. DevTools > Network shows `POST /auth/refresh` answering `200`, the page does not go to `/auth/login`, and `/auth/session` shows `"authenticated":true` again. That is the recovery members get.

   If the check in [Before you start](#before-you-start) printed anything but `true` for `authV2`, nothing refreshes outside a preview tab: the browser stays signed out at the edge until you sign in at `/auth/login` again. In that state, a browser that never signed in at `/auth/login` proves nothing, because it never had an `io_id` cookie.

5. **MCP tokens verify.** Get a new access token through the authorization-code and PKCE flow against `/auth/authorize` and `/auth/token`, for example from the MCP inspector. From a checkout that has the step 3 change, enter the token without echoing it and run the smoke check:

   ```bash
   read -rs MCP_TOKEN && export MCP_TOKEN
   scripts/mcp/token-smoke.sh
   ```

   Every line starts with `ok`, and the signature line names the new `kid`. The script verifies against the live JWKS, so a token issued before the rotation fails there. The output prints the token's `sub`, which is a real Gramps ID, so treat it as private. Run `unset MCP_TOKEN` when you finish.

   A client that was connected before the rotation, as in [Connect an MCP client](connect-an-mcp-client.md), renews its access token with its refresh token, so it keeps working without being connected again. If you skipped step 2.3, a warm `hfy-api` container may go on accepting its old access token until that token expires.

If a check fails, see [Diagnose sign-in and API failures](diagnose-sign-in-and-api-failures.md).

## Undo

Use this only when the rotation itself failed, for example when the edge returns `AUTH_CONFIG`. Undoing is a rotation back to the old key: tokens issued under the new key stop verifying, clients with a refresh token refresh again, and the verifiers in [Other JWKS consumers](#other-jwks-consumers) lag in the same way.

1. Move `AWSCURRENT` back to the old version. Secrets Manager moves `AWSPREVIOUS` to the version that loses `AWSCURRENT`.

   ```bash
   aws secretsmanager update-secret-version-stage --region "$REGION" --secret-id "$NAME" \
     --version-stage AWSCURRENT --move-to-version-id "$OLD_VERSION" --remove-from-version-id "$NEW_VERSION"
   ```

   If the variables are gone, read both IDs from `describe-secret --query VersionIdsToStages`. The old version is the one labeled `AWSPREVIOUS`.

2. Recycle the edge again. The description must differ from the one step 2 set, or there is no configuration change and the warm containers keep the new key:

   ```bash
   aws lambda update-function-configuration --region "$REGION" --function-name hfy-auth-edge \
     --description "session signing key rollback from $NEW_KID" --query LastUpdateStatus --output text
   aws lambda wait function-updated --region "$REGION" --function-name hfy-auth-edge
   ```

   If you recycled `hfy-api` in step 2.3, recycle it the same way:

   ```bash
   aws lambda update-function-configuration --region "$REGION" --function-name hfy-api \
     --description "reload session JWKS after rollback from $NEW_KID" --query LastUpdateStatus --output text
   aws lambda wait function-updated --region "$REGION" --function-name hfy-api
   ```

3. Check that the JWKS prints the old ID again, then close or revert the step 3 pull request. If you updated the secret's description in step 1.6, set it back to the old ID the same way.

## Related pages

- [The identity model](../explanation/identity-model.md): why one key, why rotation is a replacement, how `authV2` keeps a session going, and the revocation tradeoff.
- [Identity services](../reference/identity-services.md): the secret formats, the JWKS, the token claims, the refresh routes and the gate's JWKS cache.
- [MCP server](../reference/mcp-server.md): how the MCP mount checks bearer tokens and caches the JWKS.
- [Private data and secrets](../reference/private-data-and-secrets.md): where the signing key lives and who can read it.
- [Repository operations](../reference/repository-operations.md): `create-session-key.sh` and `token-smoke.sh`.
- [Deploy the edge functions](deploy-the-edge-functions.md): how a gate version is released, and why it is not recycled here.
- [Rotate the origin-verify secret](rotate-the-origin-verify-secret.md): the other secret the edge depends on.
- [Manage family access](manage-family-access.md): removing one member, and when a rotation is worth ending every edge session.
