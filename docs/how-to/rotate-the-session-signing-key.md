# How to rotate the session signing key

The auth edge, `hfy-auth-edge`, signs every edge session (the `io_id` cookie) and every MCP access token with one RS256 key. The key is stored in the Secrets Manager secret `harrisonfamily/auth-edge/session-signing-key`. This page replaces that key with a new one under a new `kid`, recycles the edge so it loads the new key, records the new `kid` in the repository, and confirms that the edge publishes the new key. Rotation makes every outstanding `io_id` and MCP access token stop verifying. Clients that hold a refresh token, which means MCP clients and the site under `authV2`, silently refresh and get tokens signed with the new key. [The identity model](../explanation/identity-model.md#one-signing-key-one-key-jwks) explains why there is no overlap period. [Identity services](../reference/identity-services.md) describes the secret format, the JWKS and the refresh routes.

Values in angle brackets, such as `<site>` and `<gramps-id>`, are placeholders. `<n>` is the number in the new key ID. The forms are listed in [Private data and secrets](../reference/private-data-and-secrets.md#placeholders).

## Before you start

- **io's go-ahead in the session.** [`AGENTS.md`](../../AGENTS.md) lists rotating the session signing key among the operations that need it. Pick a quiet window too.
- **Every outstanding edge token stops verifying.** The JWKS at `/auth/.well-known/jwks.json` publishes a single key. When the edge switches to the new key, every token signed with the old one stops verifying. That covers the `io_id` session cookie at `/auth/session`, at `/api/*` and at the data gate, and every MCP access token at `/mcp`. The verifiers outside the edge notice at different times, as described in [Other JWKS consumers](#other-jwks-consumers).
- **Clients with a refresh token recover on their own.** Refresh tokens are opaque records in the `hfy-app` table, not JWTs, so the rotation does not revoke them. An MCP client refreshes through `/auth/token`. The site under `authV2` refreshes through `/auth/refresh` when a page finds its session signed out, and when the gate refuses a data request ([Session continuity under authV2](../explanation/identity-model.md#session-continuity-under-authv2)). Both get tokens signed with the new key, so members under `authV2` normally see no sign-in prompt.
- **While `authV2` is off, edge sessions serve only the `/auth/*` pages, preview tabs and MCP.** A tab that previews `authV2` through the `?hfy_flags=` override refreshes like the site under the flag. Anyone else signed in at `/auth/login` signs in again, so tell them to expect it. The legacy Google sign-in through `hfy-check-allowed` never uses the signing key, so members on it see no change ([The legacy path, the default until the cutover](../explanation/identity-model.md#the-legacy-path-the-default-until-the-cutover)).
- **Do not use `create-session-key.sh`.** [`scripts/infra/create-session-key.sh`](../../scripts/infra/create-session-key.sh) is not a rotation tool. It does nothing when the secret already exists.
- **After a suspected exposure, plan for no rollback.** [Undo](#undo) restores the old key. Use it only to recover from a rotation that failed, never to return to a key that may have leaked.

You need:

- AWS credentials for `us-west-2` that allow:
  - `secretsmanager:PutSecretValue`, `secretsmanager:ListSecretVersionIds` and `secretsmanager:DescribeSecret` on the secret, plus `secretsmanager:UpdateSecretVersionStage` if you need to undo.
  - `lambda:UpdateFunctionConfiguration` and `lambda:GetFunctionConfiguration` on `hfy-auth-edge`, and on `hfy-api` if you recycle it too.
  - `logs:FilterLogEvents` on the `/aws/lambda/hfy-auth-edge` log group, for the log check in [Verify](#verify).
- The AWS CLI, `openssl`, `jq` and `curl`.
- For check 4 in [Verify](#verify): a second browser, or a separate browser profile, that signs in at `https://<site>/auth/login` shortly before step 1, so that it holds an `io_id` signed with the old key. An `io_id` lasts an hour. Close every other tab of the site in it, and do not use it for check 3, so nothing replaces or refreshes that session before the check. Private windows of one browser share their cookies, so a second private window is not enough.
- For the MCP check: Node 22 or later, and `npm ci` already run in `auth/`, which needs a CodeArtifact token (see [Run the tests](run-the-tests.md#7-run-the-mcp-token-smoke-check-live)).

## Other JWKS consumers

The edge checks `io_id` and access tokens with its own key, at `/auth/session`, at `/auth/authorize` and at `/auth/userinfo` ([`auth/src/index.js`](../../auth/src/index.js)). Those routes follow the rotation as soon as [step 2](#step-2-recycle-the-auth-edge) recycles the edge. `/auth/userinfo` can also take a remote key set, which refetches on a rotated `kid` ([`auth/test/userinfo.test.js`](../../auth/test/userinfo.test.js)), but the deployed edge passes its own key.

The other verifiers fetch the JWKS from `https://<site>/auth/.well-known/jwks.json` and keep it in memory in each container, so each one lags:

- **The data gate, `hfy-edge-gate`, once it is attached.** Each container keeps the key set for 300 s ([`edge-gate/gate.config.json`](../../edge-gate/gate.config.json)). Until it refetches, it still accepts an `io_id` signed with the old key, for up to five minutes after step 2 finishes. A token under the new `kid` makes it refetch, but at most once every 30 s after a successful fetch ([`edge-gate/src/gate.mjs`](../../edge-gate/src/gate.mjs)). So a container that fetched the old key set shortly before answers gated data with `401` for the rest of those 30 s. The site under `authV2` recovers by itself: it refreshes the session once and retries the request once ([`11ty/js/feature-flags.js`](../../11ty/js/feature-flags.js)). Only if the retry is refused too does a page the member opened go to `/auth/login`, unless that tab was already sent there in the last 10 minutes. A background load never redirects. You cannot recycle the gate the way step 2 recycles a regional function. Its containers run a published Lambda@Edge version, and replacing that version is a release ([Deploy the edge functions](deploy-the-edge-functions.md)). Wait out the five minutes instead.
- **`hfy-api`, which checks `io_id` on `/api/*`.** A warm container keeps the key set for up to 600 s, and refetches for an unknown `kid` at most once every 30 s ([`api/src/auth.js`](../../api/src/auth.js)). So it can accept an old `io_id` for up to ten minutes, and refuse a new one for up to 30 s. The islands' API calls do not refresh or retry.
- **The MCP mount at `/mcp`, in the same function.** `@io-kit/mcp` keeps its own copy of the key set for up to 3600 s, and refetches as soon as a token names an unknown `kid` ([MCP server: Configuration](../reference/mcp-server.md#configuration)). A token under the new key verifies at once. An access token under the old key can keep working at a warm container until it expires, at most an hour after it was issued.

Recycling `hfy-api` in step 2.3 ends both of its lags.

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
- the sample output in [Start with four requests](diagnose-sign-in-and-api-failures.md#start-with-four-requests), and the expected-`kid` sentence in step 5 of [An MCP client cannot connect](diagnose-sign-in-and-api-failures.md#an-mcp-client-cannot-connect)

Leave the `--kid` default in `create-session-key.sh`, and the IDs in `auth/test/`, `auth/e2e/`, `api/test/` and `edge-gate/test/`, as they are. The script uses its default only when it creates the secret for the first time, and the tests sign with their own keys.

No workflow builds or deploys `hfy-auth-edge` ([Deploy the app stack](deploy-the-app-stack.md)), so merging this pull request does not change production.

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
   - Once the gate is attached, your own person page, `https://<site>/person/?id=<gramps-id>`, loads its data. In DevTools > Network, `/person/<gramps-id>.json` answers `200`.

   If `/api/posts` returns `"error":"unauthenticated"` right after the rotation and you skipped step 2.3, a warm `hfy-api` container may not have reloaded the JWKS yet. It refetches on an unknown `kid` at most once every 30 seconds. Wait 30 seconds and try again, or recycle `hfy-api` as in [step 2](#step-2-recycle-the-auth-edge). A gated request refused in the same way is refreshed and retried by the page itself, as described in [Other JWKS consumers](#other-jwks-consumers).

   The session response names your `<gramps-id>`, and the posts response and the person page hold family content, so do not paste any of them anywhere public.

4. **An old session is rejected.** In the second browser that signed in at `/auth/login` before step 1, open `https://<site>/auth/session` directly, before any other page of the site. It shows `{"authenticated":false}`.

   Check `/auth/session` itself, not a site page. Under `authV2`, and in a tab that previews it, a site page refreshes the session under the new key first, so `/auth/session` would then show `"authenticated":true` and prove nothing about the old key. A session older than an hour proves nothing either, because an `io_id` expires after an hour anyway. Neither does a browser signed in through the legacy Google sign-in, which never had an `io_id` cookie.

   Under `authV2`, then open `https://<site>/person/?id=<gramps-id>` in the same browser. DevTools > Network shows `POST /auth/refresh` answering `200`, the page does not go to `/auth/login`, and `/auth/session` shows `"authenticated":true` again. With `authV2` off, the browser stays signed out at the edge until you sign in at `/auth/login` again.

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

3. Check that the JWKS prints the old ID again, then close or revert the step 3 pull request.

## Related pages

- [The identity model](../explanation/identity-model.md): why one key, why rotation is a replacement, how `authV2` keeps a session going, and the revocation tradeoff.
- [Identity services](../reference/identity-services.md): the secret formats, the JWKS, the token claims, the refresh routes and the gate's JWKS cache.
- [MCP server](../reference/mcp-server.md): how the MCP mount checks bearer tokens and caches the JWKS.
- [Private data and secrets](../reference/private-data-and-secrets.md): where the signing key lives and who can read it.
- [Repository operations](../reference/repository-operations.md): `create-session-key.sh` and `token-smoke.sh`.
- [Deploy the edge functions](deploy-the-edge-functions.md): how a gate version is released, and why it is not recycled here.
- [Rotate the origin-verify secret](rotate-the-origin-verify-secret.md): the other secret the edge depends on.
- [Manage family access](manage-family-access.md): removing one member, and when a rotation is worth ending every edge session.
