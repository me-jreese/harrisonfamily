# How to rotate the session signing key

The auth edge, `hfy-auth-edge`, signs every site session and every MCP access token with one RS256 key. The key is stored in the Secrets Manager secret `harrisonfamily/auth-edge/session-signing-key`. This page replaces that key with a new one under a new `kid`, recycles the edge so it loads the new key, records the new `kid` in the repository, and confirms that the edge publishes the new key. Rotation signs out every edge session: every `io_id` session issued through `/auth/login` and every MCP access token. While `authV2` is off, legacy Google sign-ins through `hfy-check-allowed` are not affected, because that path never uses the signing key ([The legacy path, still the default](../explanation/identity-model.md#the-legacy-path-still-the-default)). [The identity model](../explanation/identity-model.md#one-signing-key-one-key-jwks) explains why there is no overlap period. [Identity services](../reference/identity-services.md) describes the secret format and the JWKS.

Values in angle brackets are placeholders. `<n>` is the number in the new key ID, and `<access-token>` is an MCP access token. The other forms are listed in [Private data and secrets](../reference/private-data-and-secrets.md).

## Before you start

- **Every edge session is signed out at once.** The JWKS at `/auth/.well-known/jwks.json` publishes a single key. When the edge switches to the new key, every outstanding token signed with the old one stops verifying. That covers the `io_id` session cookie at `/auth/session` and at `/api/*`, and every MCP access token.
- **Sessions recover at the next refresh.** Refresh tokens are opaque records in the `hfy-app` table, not JWTs, so the rotation does not revoke them. An MCP client that refreshes through `/auth/token` gets a new access token signed with the new key. On the site, no script calls `/auth/refresh`, so in practice members sign in again.
- **The API can lag for up to ten minutes.** A warm `hfy-api` container caches the JWKS for up to 600 seconds ([`api/src/auth.js`](../../api/src/auth.js)). Until it reloads, it can still accept a token signed with the old key. The new `kid` makes it reload early: the first token it sees under an unknown `kid` triggers a fetch, at most once every 30 seconds. To cut off old sessions at the API immediately, recycle `hfy-api` too, as in [step 2](#step-2-recycle-the-auth-edge).
- **Pick a quiet window and get io's go-ahead.** Tell members who use the new sign-in at `/auth/login` to expect a sign-in prompt. Members on the legacy Google sign-in see no change.
- **Do not use `create-session-key.sh`.** [`scripts/infra/create-session-key.sh`](../../scripts/infra/create-session-key.sh) is not a rotation tool. It does nothing when the secret already exists.
- **After a suspected exposure, plan for no rollback.** [Undo](#undo) restores the old key. Use it only to recover from a rotation that failed, never to return to a key that may have leaked.

You need:

- AWS credentials for `us-west-2` that allow:
  - `secretsmanager:PutSecretValue`, `secretsmanager:ListSecretVersionIds` and `secretsmanager:DescribeSecret` on the secret, plus `secretsmanager:UpdateSecretVersionStage` if you need to undo.
  - `lambda:UpdateFunctionConfiguration` and `lambda:GetFunctionConfiguration` on `hfy-auth-edge`, and on `hfy-api` if you recycle it too.
  - `logs:FilterLogEvents` on the `/aws/lambda/hfy-auth-edge` log group, for the log check in [Verify](#verify).
- The AWS CLI, `openssl`, `jq` and `curl`.
- For the MCP check: Node 22 or later, and `npm ci` already run in `auth/` (see [Run the tests](run-the-tests.md)).

Run every step from one shell, because later steps reuse the variables set in step 1.

## Step 1: Put a new key in the secret

1. Find the key ID the edge publishes now:

   ```bash
   curl -s https://harrisonfamily.us/auth/.well-known/jwks.json | jq -r '.keys[].kid'
   ```

   The command prints one ID, such as `hfy-session-1`.

2. Set the names. Choose a new key ID by adding one to the current number. Never reuse an earlier ID. A warm `hfy-api` that finds the old key under the same `kid` does not reload, and it rejects every new session until its cache expires.

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

The edge reads the secret once, when a container starts ([`auth/src/index.js`](../../auth/src/index.js)). Warm containers keep signing with the old key until they are replaced. Until you recycle them, new containers sign with the new key while warm ones sign with the old key, and the two publish different JWKS. Run this step straight after step 1.

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

3. Optional: to end old sessions at the API now, rather than within ten minutes, recycle `hfy-api` the same way:

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

- the `session.kid` row in [Identity services](../reference/identity-services.md)
- the token-smoke signature check in [Repository operations](../reference/repository-operations.md)
- the key-ID sentence in section 6 of [Run the tests](run-the-tests.md#7-run-the-mcp-token-smoke-check-live)
- the expected-`kid` sentence in step 5 of [An MCP client cannot connect](diagnose-sign-in-and-api-failures.md#an-mcp-client-cannot-connect)

Leave the `--kid` default in `create-session-key.sh` and the IDs in `auth/test/` and `api/test/` as they are. The script uses its default only when it creates the secret for the first time, and the tests sign with their own keys.

No pipeline deploys `hfy-auth-edge` ([Repository operations](../reference/repository-operations.md)), so merging this pull request does not change production.

## Verify

1. **The JWKS shows the new key.** Run this several times, so that more than one container answers. Every run prints only the new ID:

   ```bash
   curl -s https://harrisonfamily.us/auth/.well-known/jwks.json | jq -r '.keys[].kid'
   ```

   CloudFront does not cache `/auth/*`, so `curl` sees the edge directly. A browser may show the old JWKS for up to five minutes, because the edge sends `max-age=300`.

2. **The edge started cleanly.** A malformed secret makes every route return `500 {"code":"AUTH_CONFIG"}`. This command prints nothing when all is well:

   ```bash
   aws logs tail /aws/lambda/hfy-auth-edge --region "$REGION" --since 15m --filter-pattern '"hfy-auth-edge failed"'
   ```

3. **A fresh sign-in works.** In a private window, sign in at `https://harrisonfamily.us/auth/login`. Then:
   - `https://harrisonfamily.us/auth/session` shows `"authenticated":true`.
   - `https://harrisonfamily.us/api/posts` returns `200` with `{items, cursor}`, not `"error":"unauthenticated"`.

   If `/api/posts` returns `"error":"unauthenticated"` right after the rotation and you skipped step 2.3, a warm `hfy-api` container may not have reloaded the JWKS yet. It refetches on an unknown `kid` at most once every 30 seconds. Wait 30 seconds and try again, or recycle `hfy-api` as in [step 2](#step-2-recycle-the-auth-edge).

   The session response names your `<gramps-id>`, and the posts response holds family content, so do not paste either anywhere public.

4. **An old session is rejected.** Use a browser that signed in at `/auth/login` within the hour before step 1 and showed `"authenticated":true` at `/auth/session` just before the rotation. After the rotation, `/auth/session` in that browser shows `{"authenticated":false}`. An older session proves nothing, because an `io_id` access token expires after an hour anyway. Neither does a browser signed in through the legacy Google sign-in, which never had an `io_id` cookie.

5. **MCP tokens verify.** Get a new access token through the authorization-code and PKCE flow against `/auth/authorize` and `/auth/token`, for example from the MCP inspector. Tokens issued before the rotation no longer verify. From a checkout that has the step 3 change, enter the token without echoing it and run the smoke check:

   ```bash
   read -rs MCP_TOKEN && export MCP_TOKEN
   scripts/mcp/token-smoke.sh
   ```

   Every line starts with `ok`, and the signature line names the new `kid`. The output prints the token's `sub`, which is a real gramps_id, so treat it as private. Run `unset MCP_TOKEN` when you finish.

If a check fails, see [Diagnose sign-in and API failures](diagnose-sign-in-and-api-failures.md).

## Undo

Use this only when the rotation itself failed, for example when the edge returns `AUTH_CONFIG`. Undoing signs every edge session out again, because sessions issued under the new key stop verifying.

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

## Related

- [The identity model](../explanation/identity-model.md): why one key, why rotation is a replacement, and the revocation tradeoff.
- [Identity services](../reference/identity-services.md): the secret formats, the JWKS, the token claims and the refresh routes.
- [Private data and secrets](../reference/private-data-and-secrets.md): where the signing key lives and who can read it.
- [Repository operations](../reference/repository-operations.md): `create-session-key.sh` and `token-smoke.sh`.
- [Rotate the origin-verify secret](rotate-the-origin-verify-secret.md): the other secret the edge depends on.
- [Manage family access](manage-family-access.md): removing one member, and when a rotation is worth ending every edge session.
