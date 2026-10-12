# How to diagnose sign-in and API failures

Use this page when sign-in, the members API at `/api/*`, the auth edge at `/auth/*` or an MCP client stops working. Find the symptom in the table, run the check in its section, apply the fix, then [verify the fix](#verify-the-fix). Checks only read state. Each fix says what it changes.

For why the system is built this way, see [The identity model](../explanation/identity-model.md) and [Edge and origin design](../explanation/edge-and-origin-design.md). For every status code and response body, see [Identity services](../reference/identity-services.md) and the [API reference](../reference/api.md).

Placeholders on this page:

- `<config-bucket>` is the private config bucket, and `<site-bucket>` is the site bucket.
- `<distribution-id>` is the CloudFront distribution, the `--distribution` default in the behavior scripts.
- `<legacy-origin-id>` is the ID of the CloudFront origin in front of `hfy-check-allowed`, an API Gateway (`execute-api`) host.
- `<email>` and `<gramps-id>` stand for a member's address and record ID.
- `<redirect-uri>`, `<client-origin>` and `<resource>` are an MCP client's callback URL, web origin and resource URL.

Never put real values for any of these in a ticket or in this repository.

## Before you start

- **Tools:** `curl`, `jq` and the AWS CLI. The MCP smoke check also needs Node 22 and the `auth/` dependencies.
- **AWS read access** to the log groups `/aws/lambda/hfy-api`, `/aws/lambda/hfy-auth-edge` and `/aws/lambda/hfy-check-allowed`. Some checks also read the `hfy-app` stack, the functions' configuration, the distribution configuration, the `hfy-api-role` policy, the Cognito user pool, the config bucket or the `hfy-app` table. Fixes that change something say so.
- **`secretsmanager:GetSecretValue` on the origin-verify secret.** The 403 check compares digests of the secret with what CloudFront and the functions hold, and never prints a value. Without this permission it cannot tell you whether CloudFront is right.
- **A browser with DevTools.** You will use the Network panel, the Console and **Application > Cookies**. Sign in as a member when the symptom needs it.
- **A shell at the repository root:**

  ```bash
  export AWS_REGION=us-west-2
  unset ORIGIN_VERIFY
  SITE=https://harrisonfamily.us
  ```

  The functions, their logs and the secrets are in `us-west-2`. The behavior scripts take no `--region` flag. They also use `$ORIGIN_VERIFY` instead of the secret when it is set, so keep it unset.

Two rules apply to every step:

- **Select fields. Never dump whole objects.** The output of `aws lambda get-function-configuration` and `aws cloudfront get-distribution-config` contains the origin-verify secret. The commands on this page pick fields with `--query` or `jq`. Keep it that way.
- **Keep tokens and logs private.** Read a cookie or token with `read -rs`, decode it locally, and `unset` it when you finish. `hfy-check-allowed` logs the Gramps ID of every successful sign-in, and tokens carry an email address. Do not paste either into a ticket or a chat.

To read a function's recent log, run `aws logs tail /aws/lambda/<function> --since 30m`. Add `--filter-pattern '"<text>"'` to keep only matching lines.

## Find your symptom

| Symptom | Section |
| --- | --- |
| `403 {"error":"forbidden"}` from a path under `/api/` or `/auth/` | [Every /api or /auth request gets 403 forbidden](#every-api-or-auth-request-gets-403-forbidden) |
| `500 {"code":"AUTH_CONFIG"}` from `/auth/*` | [The auth edge returns 500](#the-auth-edge-returns-500) |
| "Not on the family access list", or a `403` with `not_allowlisted` | [A member is told they are not on the access list](#a-member-is-told-they-are-not-on-the-access-list) |
| Email and password sign-in fails, a password reset is refused or never arrives, or setting a password fails | [Password sign-in, reset or setup fails](#password-sign-in-reset-or-setup-fails) |
| Sign-in at `/family-login/` fails, and `/api/check-allowed` returns `403` | [Legacy sign-in is refused with 403](#legacy-sign-in-is-refused-with-403) |
| `/api/check-allowed` returns `404` | [Legacy check-allowed returns 404](#legacy-check-allowed-returns-404) |
| `/api/*` returns `401` while you are signed in | [The API returns 401 while you are signed in](#the-api-returns-401-while-you-are-signed-in) |
| A member you removed can still get in | [A removed member still has access](#a-removed-member-still-has-access) |
| A feature flag is on, but the page has not changed | [A flag is on but nothing changes](#a-flag-is-on-but-nothing-changes) |
| A post photo does not upload or does not show | [A photo upload fails](#a-photo-upload-fails) |
| No push notifications arrive | [No push notifications arrive](#no-push-notifications-arrive) |
| An MCP client cannot connect, or its token is refused | [An MCP client cannot connect](#an-mcp-client-cannot-connect) |

If you are not sure which symptom you have, start with three requests.

## Start with three requests

```bash
curl -s -w '  %{http_code}\n' "$SITE/auth/session"
curl -s -w '  %{http_code}\n' "$SITE/api/posts"
curl -s "$SITE/auth/.well-known/jwks.json" | jq -r '.keys[].kid'
```

On a healthy site, without a session, they print:

```text
{"authenticated":false}  200
{"error":"unauthenticated","message":"sign in required"}  401
hfy-session-1
```

The `401` is the correct answer. The request passed CloudFront, reached `hfy-api`, and was refused only because it carried no session. The last line is the `kid` of the current signing key. After a key rotation it is a later ID.

| If you see | Go to |
| --- | --- |
| `{"error":"forbidden"}  403` on the first or second line | [Every /api or /auth request gets 403 forbidden](#every-api-or-auth-request-gets-403-forbidden) |
| `{"code":"AUTH_CONFIG"}  500` on the first line | [The auth edge returns 500](#the-auth-edge-returns-500) |
| A `jq` error on the third line | The edge is not serving its keys. Fix whatever the first line shows. `hfy-api` fetches these keys to verify sessions, so every signed-in API call fails with `401` once its cached copy expires, within 10 minutes. |

## Every /api or /auth request gets 403 forbidden

**What you see.** The body is exactly `{"error":"forbidden"}`, with no `message`. Both functions check the `X-Origin-Verify` header before any routing ([`api/src/origin.js`](../../api/src/origin.js), [`auth/src/origin.js`](../../auth/src/origin.js)), so the 403 covers every path, JWKS included. Two other 403s look similar but are different problems:

- A 403 from `/api/*` whose body also has a `message` is a permission refusal, such as editing someone else's post. See the [API reference](../reference/api.md).
- A 403 from `/auth/*` with `{"code":"AUTH_FORBIDDEN"}` is a sign-in refusal. See [A member is told they are not on the access list](#a-member-is-told-they-are-not-on-the-access-list).

**Causes.**

- **You called a Function URL directly.** A request that bypasses CloudFront carries no header, so it is always refused. This is intended. Use `$SITE`.
- **CloudFront sends a value the functions do not hold.** CloudFront gets its value when `add-api-behavior.sh` or `add-auth-behavior.sh` last ran. The functions get theirs when the stack was last deployed. The two drift when one side is updated without the other. A common case: after a rotation to a new secret name, someone runs a behavior script without `--secret-name`, and it writes the old default secret back.
- **`ORIGIN_VERIFY` is empty on a function.** The check then fails closed.

**Check.**

1. Find the secret the stack uses:

   ```bash
   NAME=$(aws cloudformation describe-stacks --stack-name hfy-app \
     --query "Stacks[0].Parameters[?ParameterKey=='OriginVerifySecretName'].ParameterValue" --output text)
   echo "$NAME"
   ```

2. Compare the secret with the header on both CloudFront origins and with both functions. This prints the first 12 characters of each SHA-256 digest, never a value:

   ```bash
   show() { printf '%-16s %s\n' "$1" "$(printf '%s' "$2" | shasum -a 256 | cut -c1-12)"; }
   show secret "$(aws secretsmanager get-secret-value --secret-id "$NAME" --query SecretString --output text)"
   for o in hfy-auth-origin hfy-api-origin; do
     show "$o" "$(aws cloudfront get-distribution-config --id <distribution-id> | jq -r --arg o "$o" \
       '.DistributionConfig.Origins.Items[] | select(.Id == $o) | .CustomHeaders.Items[]? | select(.HeaderName == "X-Origin-Verify") | .HeaderValue')"
   done
   for f in hfy-api hfy-auth-edge; do
     show "$f" "$(aws lambda get-function-configuration --function-name "$f" \
       --query Environment.Variables.ORIGIN_VERIFY --output text)"
   done
   ```

   | Output | Meaning |
   | --- | --- |
   | All five digests match | Every hop holds the secret's value. The 403 came from a direct call to a Function URL. |
   | `secret` shows `e3b0c44298fc` | That is the digest of an empty value: you could not read the secret, and the AWS CLI error above it says why. The other lines mean nothing until you can. |
   | An origin's digest differs from `secret` | CloudFront sends a different value. `e3b0c44298fc` here means the origin is missing or sends no header. |
   | A function's digest differs from `secret` | The function holds a different value. An unset variable prints as `None`, which gives a different digest. |

**Fix.**

- **CloudFront differs.** Preview each script first. The dry runs change nothing:

  ```bash
  bash scripts/infra/add-auth-behavior.sh --secret-name "$NAME" --dry-run
  bash scripts/infra/add-api-behavior.sh --secret-name "$NAME" --dry-run
  ```

  When only the header is wrong, a dry run lists the cache behaviors before and after, then prints `(only the X-Origin-Verify header value differs)`. Any diff it prints has every header value redacted. If it prints `(dry-run) origin-verify secret not read; using a placeholder`, it compared CloudFront with a placeholder, so its diff tells you nothing. Other diff lines mean someone changed that origin or its behaviors by hand. Read them before you apply, because a run resets every field the script manages. If `add-api-behavior.sh` stops with a line that starts with `refusing:` and exit status 3, fix the legacy route first, as in [Legacy check-allowed returns 404](#legacy-check-allowed-returns-404).

  Then run both scripts without `--dry-run`, one after the other, because each reads the distribution's current ETag. Wait for the edges:

  ```bash
  bash scripts/infra/add-auth-behavior.sh --secret-name "$NAME"
  bash scripts/infra/add-api-behavior.sh --secret-name "$NAME"
  aws cloudfront wait distribution-deployed --id <distribution-id>
  ```

  This changes the distribution's two app origins and their behaviors. Before each update, a script saves the previous distribution config under `~/.local/state/hfy-infra/cloudfront/` (mode 600) and prints a rollback command. That file holds the old header value, so treat it as a secret.

- **A function differs.** The stack resolves the secret only when the function resource changes, so a redeploy under the same secret name does nothing. Follow [Rotate the origin-verify secret](rotate-the-origin-verify-secret.md), which moves both functions and CloudFront to a new secret name.

## The auth edge returns 500

**What you see.** `500 {"code":"AUTH_CONFIG"}` from paths under `/auth/`. The edge returns it when its start-up fails, and for any unhandled error while it serves a request ([`auth/src/index.js`](../../auth/src/index.js)).

**Check.** Read the reason:

```bash
aws logs tail /aws/lambda/hfy-auth-edge --since 1h --filter-pattern '"hfy-auth-edge failed"'
```

| Logged `error` | Cause | Fix |
| --- | --- | --- |
| `environment variable <NAME> is not set` | `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`, `GOOGLE_CLIENT_ID` or `AUTH_TABLE` is missing or empty | Set the stack parameter behind it, then deploy the stack. `GoogleClientId` has no default. |
| An error from Secrets Manager, such as `AccessDeniedException` or `ResourceNotFoundException`, or `signing key secret has no string value` | The edge cannot read the signing key that its manifest names | Check the signing-key secret (below). |
| A JSON or key-decoding error | The secret is neither `{"privateKeyPem": ..., "kid": ...}` nor a bare PKCS8 PEM | Store a valid key, as in [Rotate the session signing key](rotate-the-session-signing-key.md). |
| `corsOrigins must be exact https origins (no wildcard)` | An entry in `McpCorsOrigins` has a wildcard or a path, or is not `https` | Correct the parameter, then deploy the stack. |
| A manifest validation message | The deployed [`auth/edge.manifest.json`](../../auth/edge.manifest.json) is invalid | Correct it and deploy a new package. |
| Anything else | An error while serving a request | The message names it. |

Node's JSON parse errors quote part of the input. If the logged message contains key material, treat the signing key as exposed and rotate it.

To see the runtime IDs and the CORS list without printing any secret:

```bash
aws lambda get-function-configuration --function-name hfy-auth-edge \
  --query 'Environment.Variables.[COGNITO_USER_POOL_ID, COGNITO_CLIENT_ID, GOOGLE_CLIENT_ID, AUTH_TABLE, MCP_CORS_ORIGINS]'
```

A `null` or `""` in the list is the missing value.

**Check the signing-key secret.** Two names are involved. The edge reads the secret named by `session.signingKeySecretName` in the manifest. The stack's `SigningKeySecretName` parameter only scopes the function's role, which may read secrets named `<SigningKeySecretName>-*`. The two must name the same secret. Compare them, then check the manifest's secret without reading it:

```bash
KEYNAME=$(jq -r .session.signingKeySecretName auth/edge.manifest.json)
echo "$KEYNAME"
aws cloudformation describe-stacks --stack-name hfy-app \
  --query "Stacks[0].Parameters[?ParameterKey=='SigningKeySecretName'].ParameterValue" --output text
aws secretsmanager describe-secret --secret-id "$KEYNAME" --query '{Name: Name, DeletedDate: DeletedDate}'
```

The manifest read here is the repository copy. The deployed package carries the copy from the commit it was built from.

| Finding | Cause |
| --- | --- |
| The first two lines differ | The role may not read the secret the manifest names, so the edge gets `AccessDeniedException`. |
| `describe-secret` fails with `ResourceNotFoundException` | The secret the manifest names does not exist. |
| `DeletedDate` is set | The secret is scheduled for deletion and cannot be read. |

**Fix.** The edge discards a failed start and tries again on the next request.

- **The names differ.** Make them name the same secret: set `SigningKeySecretName` and deploy the stack ([Deploy the app stack](deploy-the-app-stack.md#4-deploy-the-stack)), or change the manifest and deploy a new package.
- **The secret does not exist.** Create it under the manifest's name with [`scripts/infra/create-session-key.sh`](../../scripts/infra/create-session-key.sh) `--name "$KEYNAME"`. This generates a new signing key, so every existing session stops verifying and members sign in again.
- **The secret is scheduled for deletion.** Run `aws secretsmanager restore-secret --secret-id "$KEYNAME"`. This cancels the deletion and leaves the key unchanged. The edge reads it on the next request.
- **An environment variable is wrong.** Correct the stack parameter and deploy the stack.

An allowlist the edge cannot read does not cause this 500. Sign-in then fails with `not_allowlisted`, as described in the next section.

## A member is told they are not on the access list

**What you see.** The sign-in page shows "This email address is not on the family access list. Ask a family administrator to add it." In the Network panel, `POST /auth/google` or `POST /auth/password` returns `403 {"code":"AUTH_FORBIDDEN","detail":"not_allowlisted"}`. An MCP client gets `access_denied` with "not on the family access list".

**Causes.**

- **The email is not in `config/userGrampsID.json`.** Google sign-in uses the Google account's address, which may not be the one you listed.
- **Its Gramps ID is empty.** The edge drops an entry without one.
- **The member was added a moment ago.** Each edge instance keeps the file for 300 s. MCP membership keeps it for 60 s.
- **The edge has never been able to read the file.** Then every member is refused. A malformed upload refuses everyone on new instances, while warm instances keep their last good copy, so the refusals come and go. The edge does not log these refusals.

**Check.**

1. Look up the email in the published file:

   ```bash
   aws s3 cp s3://<config-bucket>/config/userGrampsID.json - \
     | jq --arg e '<email>' 'with_entries(.key |= ascii_downcase) | .[$e | ascii_downcase]'
   ```

   | Output | Meaning |
   | --- | --- |
   | A Gramps ID, or an object with a non-empty `gramps_id` | The member is listed. If you just added them, wait 300 s. |
   | `null` | The email is not listed. |
   | `""` | The Gramps ID is empty. |
   | A `jq` parse error | The file is malformed. New edge instances refuse everyone. |

2. If the file is valid and every member is refused, check that the edge may read it. The manifest's resolver names the object the edge reads. The stack's `ConfigBucket` and `AllowlistKey` parameters scope the function's `s3:GetObject` permission, so they must name the same object:

   ```bash
   jq -c .resolver auth/edge.manifest.json
   aws cloudformation describe-stacks --stack-name hfy-app \
     --query "Stacks[0].Parameters[?ParameterKey=='ConfigBucket' || ParameterKey=='AllowlistKey']" --output table
   ```

**Fix.** Add or correct the entry as in [Manage family access](manage-family-access.md), wait 300 s, and sign in again in a private window. For a malformed file, publish a valid one the same way. For a permission mismatch, correct the parameters and deploy the stack.

A `403` with `link_conflict` instead of `not_allowlisted` is a different problem: the email is already linked to another Gramps ID. See [Identity services](../reference/identity-services.md#principal-resolution).

## Password sign-in, reset or setup fails

**What you see.** The email and password form at `/auth/login`, the reset page at `/auth/password/forgot` or the set-a-password page at `/auth/link` shows an error, or a reset email never arrives. Find the request in the Network panel:

| Request | Response | Cause |
| --- | --- | --- |
| `POST /auth/password` | `401 {"code":"AUTH_FORBIDDEN","detail":"invalid_credentials"}` | The password is wrong, or the member has no password yet. Check the pool user (below). |
| `POST /auth/password` | `403 {"code":"AUTH_FORBIDDEN","detail":"unconfirmed"}` | Someone signed this email up through Cognito before self-service sign-up was turned off, and the sign-up was never confirmed. |
| `POST /auth/password` | `403 {"code":"AUTH_FORBIDDEN","detail":"challenge_unsupported"}` | Cognito wants a new password, because the user was created with a temporary one outside the edge. |
| `POST /auth/password/forgot` | `429 {"code":"AUTH_FORBIDDEN","detail":"rate_limited"}` and a `Retry-After` header | Too many reset requests. The edge allows 3 an hour for one email from one IP address, and 10 a day from one IP address ([`auth/src/ratelimit.js`](../../auth/src/ratelimit.js)). |
| `POST /auth/password/forgot` | `503 {"code":"AUTH_NETWORK"}` | No email was sent. Either the rate limiter could not write to the `hfy-app` table, which the edge logs as `forgot-password rate limiter unavailable`, or the call to Cognito failed or was refused as over a limit. One such limit is the default email sender's quota of about 50 emails a day for the whole account. |
| `POST /auth/password/forgot` | `200 {"ok":true}`, but no email arrives | The answer is the same whether or not a pool user exists, and Cognito sends nothing when there is none. Check the pool user (below). |
| `POST /auth/link` | `400 {"code":"AUTH_FORBIDDEN","detail":"weak_password"}` | The password is shorter than 8 characters. |
| `POST /auth/link` | `503 {"code":"AUTH_NETWORK"}` | A Cognito admin call failed, and the edge logs nothing. Most often the password passed the edge's 8-character check but not the pool's policy: at least 12 characters, with upper case, lower case and a number. |
| `POST /auth/verify` | `410 {"code":"AUTH_FORBIDDEN","detail":"signup_disabled"}` | Expected. Self-service sign-up is off, so there is no sign-up to confirm. |

**Cause.** The pool accepts no self-service sign-up (`AllowAdminCreateUserOnly` in [`app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml)). The edge creates a member's pool user only when the member, already signed in, sets a password at `/auth/link` ([`auth/src/cognito.js`](../../auth/src/cognito.js)). A member who has only ever used Google has no password to sign in with or reset.

**Check the pool user.** This reads the user's status only:

```bash
POOL=$(aws cloudformation describe-stacks --stack-name hfy-app \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" --output text)
aws cognito-idp admin-get-user --user-pool-id "$POOL" --username '<email>' \
  --query '{status: UserStatus, enabled: Enabled}'
```

| Output | Meaning |
| --- | --- |
| `UserNotFoundException` | The member has never set a password. |
| `"status": "CONFIRMED"` | The user exists, so the password is wrong. |
| `"status": "UNCONFIRMED"` | A self sign-up from before the pool was locked down. |
| `"status": "FORCE_CHANGE_PASSWORD"` | The user was created with a temporary password outside the edge. |
| `"enabled": false` | Someone disabled the user in Cognito. Password sign-in fails with `invalid_credentials` until it is enabled again. |

**Fix.**

- **No user, `UNCONFIRMED` or `FORCE_CHANGE_PASSWORD`.** The member signs in with Google, opens `/auth/link` and sets a password that meets the pool policy. The edge then creates the user, or confirms it and marks its email verified, and sets the password as permanent.
- **`CONFIRMED`.** The member resets the password at `/auth/password/forgot`.
- **`429`.** Wait the number of seconds in `Retry-After`. Nothing else resets the counters.
- **`503` from `/auth/password/forgot`.** Read the edge log for `forgot-password rate limiter unavailable`. If it is not there, the Cognito call failed. To lift the email quota, set the `SesIdentityArn` parameter to a verified SES identity in `us-west-2`, and `SesFromAddress` if you want a sender address, then deploy the stack. The pool then sends its email through SES.
- **`503` from `/auth/link` with a password that meets the policy.** The function's role may lack the `CognitoAdminLink` permissions in `app-stack.yaml`. Deploy the stack.

To confirm, sign in with the email and password at `/auth/login`, then run step 2 of [The API returns 401 while you are signed in](#the-api-returns-401-while-you-are-signed-in). It reports `authenticated: true`.

## Legacy sign-in is refused with 403

**What you see.** While `authV2` is off, `/family-login/` is the sign-in for everyone. After the Google pop-up, the navigation stays signed out. The page posts the Google ID token to `/api/check-allowed`. Find that request in the Network panel and read its body:

| Body | Meaning |
| --- | --- |
| `403 {"allowed":false}` | `hfy-check-allowed` refused the email. Continue below. |
| `403 {"allowed":false,"error":"unverified email"}` | Google reports the account's address as unverified. |
| `500 {"allowed":false,"error":"server error"}` | The Google token did not verify, or S3 or Secrets Manager failed. The log line `Error verifying request` has the message. |
| `403 {"error":"forbidden"}` or `404 {"error":"not_found",...}` | The request reached `hfy-api`, not the legacy Lambda. See [Legacy check-allowed returns 404](#legacy-check-allowed-returns-404). |

**Causes.** [`lambda/hfy-check-allowed/index.mjs`](../../lambda/hfy-check-allowed/index.mjs) admits an email only when its HMAC digest is in `config/allowed_hashes.json` **and** `config/userGrampsID.json` has a value under the exact lower-case key. The test is `Boolean(mapping[email])`: a missing key or an empty string is refused, but any object passes, even `{"gramps_id":""}`. It loads both files once per instance and never reloads them, so a published fix reaches only new instances.

**Check.**

1. Read the refusal:

   ```bash
   aws logs tail /aws/lambda/hfy-check-allowed --since 30m \
     --filter-pattern '"Email not on allowlist or missing Gramps ID"'
   ```

   The email appears only in redacted form.

   - `hasMapping: false`: the key is missing, its value is an empty string, or the key has capital letters.
   - `hasMapping: true`: the digest is missing. The email is not in `harrisonfamily-allowlist.json`, or the publish stopped before it uploaded the digests.

2. Check the published files as in [Manage family access](manage-family-access.md#verify-an-addition). If both are correct, the running instances hold older copies.

**Fix.** Correct the files and publish them ([Manage family access](manage-family-access.md#add-a-member)). Then make Lambda start new instances by changing the description, which nothing reads:

```bash
aws lambda update-function-configuration --function-name hfy-check-allowed \
  --description "allowlist published <yyyy-mm-dd>" --query LastUpdateStatus --output text
aws lambda wait function-updated --function-name hfy-check-allowed
```

A push to `main` has the same effect, because [`io-kit-deploy.yml`](../../.github/workflows/io-kit-deploy.yml) updates the function's code, as the `lambda` target in [`ci.manifest.yaml`](../../ci.manifest.yaml) says.

## Legacy check-allowed returns 404

**What you see.** `POST /api/check-allowed` returns `404 {"error":"not_found","message":"no such route"}`. That body comes from `hfy-api` ([`api/src/handler.js`](../../api/src/handler.js)), which has no `check-allowed` route.

**Cause.** CloudFront tries its cache behaviors in list order and uses the first pattern that matches. The legacy sign-in reaches `hfy-check-allowed` through its API Gateway origin, which this repository does not define. [`add-api-behavior.sh`](../../scripts/infra/add-api-behavior.sh) keeps that route with a `/api/check-allowed*` behavior placed above `/api/*`. When it creates that pin, it copies whichever behavior serves `/api/check-allowed` at that moment. A 404 means no pin above `/api/*` targets the legacy origin. Someone moved the pin below `/api/*` or deleted it, the pin targets `hfy-api-origin`, or `/api/*` was pointed at `hfy-api` before any pin existed. The script moves a misplaced pin back on its own. In the other cases it refuses, as the check below shows. The rules are in [Repository operations](../reference/repository-operations.md#the-legacy-apicheck-allowed-pin).

**Check.**

1. List the behaviors in evaluation order, then the origins, by ID and host only:

   ```bash
   aws cloudfront get-distribution-config --id <distribution-id> \
     | jq -r '.DistributionConfig.CacheBehaviors.Items[] | "\(.PathPattern)\t\(.TargetOriginId)"'
   aws cloudfront get-distribution-config --id <distribution-id> \
     | jq -r '.DistributionConfig.Origins.Items[] | "\(.Id)\t\(.DomainName)"'
   ```

   The legacy sign-in works only when `/api/check-allowed*` is listed above `/api/*` and targets the origin whose host is an `execute-api` address. That origin's ID is `<legacy-origin-id>`.

2. Ask the script what it would do. `$NAME` is the stack's origin-verify secret, from step 1 of the [403 check](#every-api-or-auth-request-gets-403-forbidden). The dry run changes nothing:

   ```bash
   bash scripts/infra/add-api-behavior.sh --secret-name "$NAME" --dry-run; echo "exit $?"
   ```

   | Output | Meaning |
   | --- | --- |
   | `legacy /api/check-allowed stays on origin <legacy-origin-id> via /api/check-allowed* (ordered before /api/*; retired by HFY-TSK-069)` | The script can restore the route. The `cache behaviors after` line shows the pin back above `/api/*`. |
   | `refusing: /api/check-allowed is already routed to hfy-api-origin by /api/* and no /api/check-allowed* behavior exists; ...` and `exit 3` | No pin, and nothing left to copy. |
   | `refusing: no cache behavior serves /api/check-allowed today (only the default behavior), ...` and `exit 3` | No pin, and nothing to copy. |
   | `refusing: the existing /api/check-allowed* behavior targets hfy-api-origin; ...` and `exit 3` | The pin points at the API. |

**Fix.** Each run without `--dry-run` changes the distribution, and saves a backup first as described in the [403 fix](#every-api-or-auth-request-gets-403-forbidden).

- **The script can restore the route.** Run it without `--dry-run`. It also resets `/api/*` and `hfy-api-origin` to their managed settings.

  ```bash
  bash scripts/infra/add-api-behavior.sh --secret-name "$NAME"
  aws cloudfront wait distribution-deployed --id <distribution-id>
  ```

- **No pin, and nothing to copy.** Name the legacy origin. The script then creates `/api/check-allowed*` on that origin with the same settings as `/api/*`, directly above the first behavior that matches the path. It refuses an ID that is not an origin of the distribution.

  ```bash
  bash scripts/infra/add-api-behavior.sh --secret-name "$NAME" --legacy-origin <legacy-origin-id> --dry-run
  bash scripts/infra/add-api-behavior.sh --secret-name "$NAME" --legacy-origin <legacy-origin-id>
  aws cloudfront wait distribution-deployed --id <distribution-id>
  ```

- **The pin points at the API.** The script never retargets a pin. In the CloudFront console, on the distribution's **Behaviors** tab, delete the `/api/check-allowed*` behavior. Then run the script with `--legacy-origin`, as in the previous item.

To confirm that the route now reaches the legacy Lambda, send an empty body. It is refused before any token check:

```bash
curl -s -w '  %{http_code}\n' -X POST "$SITE/api/check-allowed" -H 'content-type: application/json' -d '{}'
```

It prints `{"allowed":false,"error":"missing id_token"}  400`.

## The API returns 401 while you are signed in

**What you see.** A request to `/api/*` returns `401 {"error":"unauthenticated","message":"sign in required"}`, and the islands treat you as signed out. `hfy-api` reads only the `io_id` cookie that the auth edge sets ([`api/src/auth.js`](../../api/src/auth.js)).

**Check.**

1. **Is the cookie sent?** In the Network panel, open the failing request and look for `io_id` in the `Cookie` request header. It is missing when:

   - **You signed in only through `/family-login/`.** The legacy path sets no `io_id`, so the API sees no session. Sign in at `/auth/login`.
   - **You are on another host name.** `io_id` is a host-only cookie for `harrisonfamily.us`. On a `www.` name or the CloudFront domain, the browser does not send it.
   - **The cookie has expired.** It lasts 3600 s, and no site script refreshes it.

2. **Does the edge accept the cookie?** In the Console, run:

   ```js
   await (await fetch("/auth/session")).json()
   ```

   - `{authenticated: false}`: the edge rejects the cookie too. It has expired, or it was signed with a key the edge no longer holds. Sign in again.
   - `{authenticated: true, ...}`: the edge accepts the cookie but the API does not. Go to step 3.

3. **Compare the token with the API's settings.** In **Application > Cookies**, copy the value of `io_id`. Scripts cannot read it, because it is `HttpOnly`. Decode only the fields you need, locally:

   ```bash
   read -rs IO_ID   # paste the value; nothing is echoed
   printf '%s' "$IO_ID" | jq -R 'split(".")[0:2] | map(gsub("-";"+") | gsub("_";"/") | @base64d | fromjson)
     | {kid: .[0].kid, iss: .[1].iss, aud: .[1].aud, expires: (.[1].exp | todate)}'
   unset IO_ID
   curl -s "$SITE/auth/.well-known/jwks.json" | jq -r '.keys[].kid'
   aws cloudformation describe-stacks --stack-name hfy-app \
     --query "Stacks[0].Parameters[?starts_with(ParameterKey, 'Session')]" --output table
   ```

   | Finding | Cause | Fix |
   | --- | --- | --- |
   | `expires` is in the past | The session ended | Sign in again. |
   | The token's `kid` is not the JWKS `kid` | The token predates a key rotation | Sign in again. |
   | The `kid`s match, and the key was rotated in the last 10 minutes under the same `kid` | A warm `hfy-api` container keeps the old public key for up to 600 s. It refetches early only when it meets an unknown `kid`. | Wait 10 minutes, or recycle `hfy-api` (below). Always rotate to a new `kid`. |
   | The JWKS `kid` changes between runs of the `curl` | The edge was not recycled after a rotation, so warm instances still publish the old key | Recycle `hfy-auth-edge`, as in [Rotate the session signing key](rotate-the-session-signing-key.md#step-2-recycle-the-auth-edge). |
   | `iss` differs from `SessionIssuer`, or `aud` from `SessionAudience` | The stack parameters disagree with `session.issuer` and `session.audience` in the manifest | Correct the parameters and deploy the stack. |
   | `SessionCookie` is not `io_id` | The API reads a different cookie | Correct the parameter and deploy the stack. |

   To recycle `hfy-api`, which only changes its description:

   ```bash
   aws lambda update-function-configuration --function-name hfy-api \
     --description "reload session JWKS" --query LastUpdateStatus --output text
   aws lambda wait function-updated --function-name hfy-api
   ```

4. **Confirm in the API log.**

   ```bash
   aws logs tail /aws/lambda/hfy-api --since 15m --filter-pattern '"session rejected"'
   ```

   Each rejected token logs `AUTH_EXPIRED`, whatever the actual reason, so the log shows that the API rejected the cookie but not why. A request without a cookie logs nothing.

## A removed member still has access

**What you see.** You removed a member from the allowlist, and they can still use the site or an MCP client.

**Cause.** Removal stops new sign-ins and refreshes. It does not end what was already issued, because `hfy-api` verifies tokens with the public key and never reads the allowlist. A site session or an MCP access token lasts up to 1 h after it was issued. The legacy sign-in keeps admitting the member until `hfy-check-allowed` starts new instances. For the full timing, see [The identity model](../explanation/identity-model.md#what-removal-does-and-does-not-do).

**Check.**

1. The published file no longer has the email. This prints `false`:

   ```bash
   aws s3 cp s3://<config-bucket>/config/userGrampsID.json - \
     | jq --arg e '<email>' 'with_entries(.key |= ascii_downcase) | has($e | ascii_downcase)'
   ```

2. Less than an hour has passed since the removal. Within that hour, continued access is expected.
3. For the legacy path, `hfy-check-allowed` changed after the publish:

   ```bash
   aws lambda get-function-configuration --function-name hfy-check-allowed --query LastModified --output text
   ```

**Fix.** Recycle `hfy-check-allowed` as in [Legacy sign-in is refused with 403](#legacy-sign-in-is-refused-with-403). To end every edge session and MCP token now, instead of within the hour, [rotate the session signing key](rotate-the-session-signing-key.md). That signs out every member, not only the one you removed.

The removal has taken full effect when a sign-in as that member, on either path, is refused as not on the access list. Run the checks in [Manage family access](manage-family-access.md#verify-a-removal).

## A flag is on but nothing changes

**What you see.** A flag is on in `flags.json` or in your preview override, and the page still shows the legacy version. The loader in [`11ty/js/feature-flags.js`](../../11ty/js/feature-flags.js) injects `/js/islands/<name>.js`. If that file cannot be fetched, the loader clears any preview override, and the page keeps or returns to its legacy version without telling you. Only the shell, search and notifications loaders pass an error handler: the first two restore the legacy parts they hid, and the notifications page keeps its "not enabled" text. The person and posts loaders pass none, so the page simply stays as it was. A parse or runtime error in a bundle that did load triggers no fallback: the error shows in the Console, and the page is left without the island.

**Check.**

1. **The browser sees the flag.** In the Console, run `await HFYFeatureFlags.resolveFlags()`. If the flag is not `true`:

   - Check the published value with `curl -s "$SITE/_data/flags.json" | jq .`.
   - Check the override with `sessionStorage.getItem("hfy:flags")`. It applies to one tab only, and a "Preview flags on — turn off" banner shows while it is active. An entry such as `-postsV2` forces the flag off. Open `?hfy_flags=` to clear the override. If a bundle or `/auth/session` was unavailable, the loader has already cleared it and logged `[HFYFeatureFlags] preview flags turned off: ...` in the Console.

2. **You are on a page the flag changes.**

   | Flag | Page | Bundle |
   | --- | --- | --- |
   | `shellV2` | Any page | `shell` |
   | `searchV2` | `/search/` (it also turns on `shellV2`, unless the override forces `-shellV2`) | `search` |
   | `personV2` | `/person/?id=<gramps-id>` | `person` |
   | `postsV2` | `/`, `/posts/`, `/person/?id=<gramps-id>` | `timeline`, `posts`, `my-posts` |
   | `notifyV2` | `/me/notifications/` | `notifications` |

   `authV2` loads no island. Once `/auth/session` answers with JSON, it makes `/family-login/` redirect a signed-out visitor to `/auth/login` ([`11ty/js/auth-v2.js`](../../11ty/js/auth-v2.js)). A visitor already signed in at the edge stays on the legacy page. If `/auth/session` does not answer, nothing changes and the preview override is cleared.

3. **The bundles are published.**

   ```bash
   for n in shell search person my-posts timeline posts notifications; do
     printf '%-14s' "$n"; curl -s -o /dev/null -w '%{http_code} %{content_type}\n' "$SITE/js/islands/$n.js"
   done
   ```

   Each line must show `200` and a JavaScript content type. Anything else makes the loader fall back.

4. **The service worker is not serving an old copy.** With `shellV2` on, `/sw.js` fetches island entry files from the network first and uses its cache only when the network fails. A browser still running the worker from before HFY-R58, which answered `/js/islands/*` from its cache first, can keep serving an old copy until the new worker takes over. In DevTools, tick **Application > Service workers > Bypass for network** and reload.
5. **The island did not fail while it ran.** If the bundle loads with `200` and still nothing renders, look for an error in the Console. The loader falls back only when the file fails to load. An error inside the island does not trigger the fallback ([Front end](../reference/front-end.md)).

**Fix.** The bundles are committed build output in `11ty/js/islands/`. For a missing or stale bundle, rebuild them ([Build and preview the islands](build-and-preview-the-islands.md)), commit `11ty/js/islands/` with the source change, and merge to `main` ([Deploy a change to the static site](deploy-a-site-change.md)). Every push to `main` runs [`io-kit-deploy.yml`](../../.github/workflows/io-kit-deploy.yml), which syncs `11ty/` to the bucket with `--delete`. A bundle uploaded by hand without a commit is therefore removed by the next deploy. For an error inside an island, fix the island source and ship it the same way.

To confirm, reload the page in a new tab. The island renders, and `await HFYFeatureFlags.whenIsland("<bundle>")` returns `true` in the Console.

## A photo upload fails

**What you see.** The post composer on a member's own `/person/` page reports an error, or the post shows a broken image. An upload is two requests. `POST /api/uploads` returns a presigned URL and the headers to send ([`api/src/uploads.js`](../../api/src/uploads.js), [`api/src/presign.js`](../../api/src/presign.js)). Then the browser sends a `PUT` with the image straight to `<site-bucket>`, under `uploads/posts/<ulid>/` ([`islands/src/lib/upload.js`](../../islands/src/lib/upload.js)), which throws `Upload failed (HTTP <status>).` when the `PUT` fails. The URL signs `Content-Type` and `Content-Length`, so S3 accepts only the type and size that were presigned. The post then shows the image from `$SITE/uploads/posts/...`, which CloudFront serves through the `/uploads/*` behavior. In the Network panel, find which request failed.

| Request | Result | Cause | Fix |
| --- | --- | --- | --- |
| `POST /api/uploads` | `400 validation` | The `message` names the problem: no file name, a type other than JPEG, PNG, WebP or HEIC (including no type at all), a size that is not a positive whole number, or a file over 10 MB. | Use a supported image. |
| `POST /api/uploads` | `401 unauthenticated` | No valid session | See [The API returns 401 while you are signed in](#the-api-returns-401-while-you-are-signed-in). |
| `POST /api/uploads` | `503 unavailable`, "uploads are not configured" | The handler has no presigner. The deployed [`api/src/index.js`](../../api/src/index.js) always supplies one, so the function is not running this repository's code. | Deploy `hfy-api` from `main`. |
| `PUT` to S3 | The Console reports the request was blocked by CORS policy | The bucket has no CORS rule for `PUT` from the site | Apply the rule (below). |
| `PUT` to S3 | `400` with `BadDigest`, on every upload | `hfy-api` runs a build from before `presign.js`. That build signed a checksum of an empty body into every URL, so no real image matches it. | Deploy `hfy-api` from `main` ([Deploy the app stack](deploy-the-app-stack.md)). |
| `PUT` to S3 | `403` with `SignatureDoesNotMatch` | The `Content-Type` or the size sent differs from what was signed | A client fault. The client must send the `headers` that `POST /api/uploads` returned, with the same file. |
| `PUT` to S3 | `403` with "Request has expired" | More than 300 s passed between the presign and the `PUT` | Try again. |
| `PUT` to S3 | `403` with `AccessDenied` | The function's role does not allow the key. It may put objects only under `uploads/posts/*` in the bucket that `MediaBucket` names. A role from an older template allows `media/posts/*` instead. | Check the role (below), then deploy the stack. |
| Both succeed | The image is broken in the post | `MediaPublicBase` does not point at the site, `MediaBucket` is not the bucket the site is served from, or the `/uploads/*` behavior targets another origin | Check the parameters and the behavior (below). |

**Check the CORS rule, the media parameters, the role and the behavior.**

```bash
aws s3api get-bucket-cors --bucket <site-bucket>
aws cloudformation describe-stacks --stack-name hfy-app \
  --query "Stacks[0].Parameters[?starts_with(ParameterKey, 'Media')]" --output table
aws iam get-role-policy --role-name hfy-api-role --policy-name hfy-api \
  --query "PolicyDocument.Statement[?Sid=='PostPhotoUploads'].Resource" --output text
aws cloudfront get-distribution-config --id <distribution-id> \
  | jq -r '.DistributionConfig.CacheBehaviors.Items[] | select(.PathPattern == "/uploads/*") | "\(.TargetOriginId)\t\(.ResponseHeadersPolicyId)"'
aws cloudformation describe-stacks --stack-name hfy-app \
  --query "Stacks[0].Outputs[?OutputKey=='UploadsResponseHeadersPolicyId'].OutputValue" --output text
```

- The CORS output must include a rule that allows `PUT` from `https://harrisonfamily.us` with the headers `Content-Type` and `Content-Length`. A `NoSuchCORSConfiguration` error means the bucket has no rule at all.
- The role's resource must end in `/uploads/posts/*`, in the bucket that `MediaBucket` names.
- The `/uploads/*` line must name the bucket's S3 origin, the default behavior's origin, and a policy ID equal to the last line. No line means the behavior is missing. The default behavior then serves the image, so it still shows, but without the `nosniff` and sandbox headers that keep a mislabelled upload inert.

**Fix.**

- **CORS.** Apply [`media-bucket-cors.json`](../../infrastructure/cloudformation/media-bucket-cors.json) as in [Deploy the app stack](deploy-the-app-stack.md#7-apply-the-photo-upload-cors-rule). `put-bucket-cors` replaces the bucket's whole CORS configuration, so carry over any other rules first.
- **Role, `MediaBucket` or `MediaPublicBase`.** Correct the parameter and deploy the stack, which also updates the role.
- **The `/uploads/*` behavior.** Run [`add-uploads-behavior.sh`](../../scripts/infra/add-uploads-behavior.sh). It needs no secret. It adds or updates `/uploads/*` on the default behavior's origin with the stack's response headers policy, and saves a backup first, as in the [403 fix](#every-api-or-auth-request-gets-403-forbidden).

  ```bash
  bash scripts/infra/add-uploads-behavior.sh --dry-run
  bash scripts/infra/add-uploads-behavior.sh
  aws cloudfront wait distribution-deployed --id <distribution-id>
  ```

To confirm, post a photo from the composer. Both requests succeed, and the image shows in the post. `curl -sI <image-url>` on the image's address shows `x-content-type-options: nosniff` and the sandbox `content-security-policy`.

## No push notifications arrive

**What you see.** Members get no push notifications for new posts, replies or mentions.

**Check.**

1. **Push is on.** Signed in, run this in the Console:

   ```js
   await (await fetch("/api/notifications/vapid-public-key")).json()
   ```

   An empty `public_key` means push is off. Find out why:

   ```bash
   aws cloudformation describe-stacks --stack-name hfy-app \
     --query "Stacks[0].Parameters[?ParameterKey=='VapidSecretName'].ParameterValue" --output text
   aws logs tail /aws/lambda/hfy-api --since 1d --filter-pattern '"push disabled"'
   ```

   An empty `VapidSecretName` turns push off: subscriptions and preferences are stored, but nothing is sent. If the name is set, a `push disabled` line means the secret could not be read or parsed. It must be JSON with `subject`, `publicKey` and `privateKey`.

2. **The recipient has a subscription.** Subscriptions are stored under `SUB#<principal>` in the `hfy-app` table:

   ```bash
   aws dynamodb query --table-name hfy-app \
     --key-condition-expression 'PK = :p' \
     --expression-attribute-values '{":p": {"S": "SUB#<gramps-id>"}}' \
     --select COUNT --query Count
   ```

   `0` means the member never turned on notifications on a device, or the push service reported every subscription as gone (`404` or `410`) and it was removed. The member turns notifications on at `/me/notifications/`, which needs `notifyV2`. The same page can turn off a notification type.

3. **The event notifies that member.** From [`api/src/notify.js`](../../api/src/notify.js):

   - Nobody is notified of their own action.
   - A newly published post notifies every member who has a subscription.
   - A comment notifies the author of the comment it replies to, everyone who commented earlier on the same record or post, each person mentioned as `@<gramps-id>`, and the record's person or the post's author.

4. **Sending did not fail.** A failed send to one member logs `notify failed`. A failed fan-out logs `comment notification failed` or `publish notification failed`:

   ```bash
   aws logs tail /aws/lambda/hfy-api --since 1d --filter-pattern '?"notify failed" ?"notification failed"'
   ```

**Fix.** To turn push on, store the VAPID keys in a secret, set `VapidSecretName` and deploy the stack. The function's role may read the secret only when the parameter is set. Each container loads the keys once, so after you repair a secret under the same name, recycle `hfy-api` as in [The API returns 401 while you are signed in](#the-api-returns-401-while-you-are-signed-in).

To confirm, publish a test post as a member other than the recipient. A notification arrives on the recipient's subscribed device.

## An MCP client cannot connect

**What you see.** An MCP client fails to add the server, the member's browser shows an error during authorization, or the resource refuses the token. The edge's authorization server is [`auth/src/oauth.js`](../../auth/src/oauth.js). Its settings come from three stack parameters: `McpRedirectUris`, `McpResources` and `McpCorsOrigins`. List them:

```bash
aws cloudformation describe-stacks --stack-name hfy-app \
  --query "Stacks[0].Parameters[?starts_with(ParameterKey, 'Mcp')]" --output table
```

**Check, in order.**

1. **The server is on, and discoverable at the root.**

   ```bash
   curl -s "$SITE/auth/.well-known/oauth-authorization-server" | jq -r '.issuer // .code'
   curl -s -o /dev/null -w '%{http_code} %{content_type}\n' "$SITE/.well-known/oauth-authorization-server/auth"
   ```

   The first prints `https://harrisonfamily.us/auth`, and the second `200 application/json`. `NOT_FOUND` from the first means `McpRedirectUris` is empty, which turns every OAuth route off. If only the second fails, CloudFront has no root-discovery behavior: run `add-auth-behavior.sh --secret-name "$NAME"` as in the [403 fix](#every-api-or-auth-request-gets-403-forbidden).

2. **The redirect URI is allowed.** `/auth/register` stores nothing and checks the URI against the list:

   ```bash
   curl -s -X POST "$SITE/auth/register" -H 'content-type: application/json' \
     -d '{"redirect_uris": ["<redirect-uri>"]}' | jq -r '.client_id // .error'
   ```

   `mcp-harrisonfamily` means the URI is allowed. `invalid_redirect_uri` means it is not on `McpRedirectUris`. The match is exact.

3. **The browser origin is allowed.** This matters only for a client that calls `/auth/token` from a web page:

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' -X OPTIONS "$SITE/auth/token" \
     -H 'Origin: <client-origin>' -H 'Access-Control-Request-Method: POST'
   ```

   `204` means allowed. `403` means the origin is not on `McpCorsOrigins`.

4. **The resource matches.** The `resource` the client sends must equal an entry in `McpResources` exactly, including any path and trailing slash. When the client sends none, the first entry is used.

The error the client reports points to the cause. These are the ones that need a fix on this side or a fresh start. Every other error is listed under [MCP authorization server](../reference/identity-services.md#mcp-authorization-server).

| Error | Cause |
| --- | --- |
| `400` JSON, "redirect_uri is not registered", shown in the browser instead of a redirect | The client's callback is not on `McpRedirectUris`. See step 2. |
| "unknown client_id": `400 invalid_request` from `/auth/authorize`, or `401 invalid_client` from `/auth/token` or `/auth/revoke` | The client does not use the ID that `/auth/register` returns. |
| `invalid_target` | The resource is not on `McpResources`, or differs from the one authorized. See step 4. |
| `access_denied`, "not on the family access list" | See [A member is told they are not on the access list](#a-member-is-told-they-are-not-on-the-access-list). Membership is cached for 60 s. |
| `invalid_grant`, "invalid, expired or already used code" | The code is older than 120 s, was used twice, or the token request's `redirect_uri` differs from the authorize request's. Start the flow again. |
| `invalid_grant`, "subject is no longer on the family access list" | The member was removed. |
| `503 {"error":"server_error"}` | The allowlist could not be read and no copy was ever loaded. The edge logs `oauth failure` and `allowlist unavailable`. |

5. **The token verifies.** Once the client has a token, run [`scripts/mcp/token-smoke.sh`](../../scripts/mcp/token-smoke.sh) as in [Run the tests](run-the-tests.md#7-run-the-mcp-token-smoke-check-live). It checks the discovery document, then the token's signature against the live JWKS, its `kid`, `iss`, `aud`, `sub`, `groups` and expiry. Pass `--audience <resource>` when the token was issued for a resource other than the script's default. The script expects the `kid` `hfy-session-1`, so after a rotation to a new `kid` it fails on that line even for a good token. Its output includes the token's `sub`, a Gramps ID, so keep it private.

**Fix.** Correct the parameter and deploy the stack ([Deploy the app stack](deploy-the-app-stack.md#4-deploy-the-stack)). Each `McpCorsOrigins` entry must be an exact `https://<host>` origin. A wildcard or a path stops the whole edge with `500 AUTH_CONFIG`.

## Verify the fix

1. Run the check from the section you used again. It now gives the healthy result that section describes, and the section's closing check succeeds where it has one.
2. Run [Start with three requests](#start-with-three-requests) again.
3. Run the end-to-end check that covers the path you fixed. Do the one-time setup in [Run the tests](run-the-tests.md) first.

   - **Sign-in with `authV2` on:** the `auth-v2` Playwright suite. The suite's configuration writes only an HTML report and runs both Chromium and WebKit, so ask for terminal output and one browser:

     ```bash
     cd tests/login-flow
     export HFY_SITE_BASE="$SITE" HFY_AUTH_V2=1
     export HFY_TEST_EMAIL=<test-email> HFY_EXPECT_GRAMPS=<gramps-id>
     read -rs HFY_TEST_PASSWORD && export HFY_TEST_PASSWORD
     npx playwright test auth-v2 --reporter=list --project=chromium
     unset HFY_TEST_PASSWORD
     ```

     It checks the `/family-login/` redirect, the two sign-in paths, the published JWKS, the signed-out session, and a password sign-in whose `sub` matches `HFY_EXPECT_GRAMPS`. Before `authV2` is on, its redirect test fails, so use the legacy spec instead ([Run the tests](run-the-tests.md#legacy-sign-in)).
   - **MCP:** `token-smoke.sh` with a fresh token, as in step 5 of [An MCP client cannot connect](#an-mcp-client-cannot-connect).

## Related pages

- [The identity model](../explanation/identity-model.md): why sign-in resolves to a Gramps ID, why there are two paths, and why removal is not instant.
- [Edge and origin design](../explanation/edge-and-origin-design.md): CloudFront in front of both functions, and the origin-verify header.
- [Islands on Eleventy](../explanation/islands-on-eleventy.md) and [The release model](../explanation/release-model.md): why new surfaces load behind flags and fall back.
- [Identity services](../reference/identity-services.md), [API reference](../reference/api.md) and [Front end](../reference/front-end.md): every route, status code and fallback.
- [Repository operations](../reference/repository-operations.md#cloudfront-behavior-scripts): what the CloudFront behavior scripts change, their output and their exit status.
- [Private data and secrets](../reference/private-data-and-secrets.md): where the allowlist and the secrets live.
- [Manage family access](manage-family-access.md), [Rotate the origin-verify secret](rotate-the-origin-verify-secret.md), [Rotate the session signing key](rotate-the-session-signing-key.md), [Deploy the app stack](deploy-the-app-stack.md), [Toggle a feature flag](toggle-a-feature-flag.md), [Run the tests](run-the-tests.md).
