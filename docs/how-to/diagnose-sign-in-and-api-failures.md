# How to diagnose sign-in and API failures

Use this page when sign-in or the sign-in pages, the members API at `/api/*`, the auth edge at `/auth/*`, the private data gate in front of the family data and member photos, or the MCP server at `/mcp` stops working. Find the symptom in the table, run the check in its section, apply the fix, then [verify the fix](#verify-the-fix). Checks only read state. Each fix says what it changes.

For why the system is built this way, see [The identity model](../explanation/identity-model.md), [Edge and origin design](../explanation/edge-and-origin-design.md) and [The privacy model for family data](../explanation/family-data-privacy.md). For every status code and response body, see [Identity services](../reference/identity-services.md), the [API reference](../reference/api.md) and [MCP server](../reference/mcp-server.md).

Placeholders on this page:

- `<site>` is the site's host name.
- `<app-stack>` is the name of the live app stack. It is not `hfy-app`, the default that the behavior scripts use for it. `add-auth-behavior.sh`, `add-api-behavior.sh`, `add-uploads-behavior.sh` and `add-mcp-behavior.sh` take it as `--stack <app-stack>`. `add-data-gate-behaviors.sh` takes it as `--app-stack <app-stack>`, because its own `--stack` names the `us-east-1` gate stack.
- `<config-bucket>` is the private config bucket, and `<site-bucket>` is the site bucket.
- `<distribution-id>` is the CloudFront distribution, the `--distribution` default in the behavior scripts and in `publish-append-index.sh`.
- `<legacy-origin-id>` is the ID of the CloudFront origin in front of `hfy-check-allowed`, an API Gateway (`execute-api`) host.
- `<edge-region>` is an AWS Region that holds a Lambda@Edge log group (see [Before you start](#before-you-start)).
- `<email>` and `<gramps-id>` stand for a member's address and record ID.
- `<image-url>` is the address of a post photo, `https://<site>/uploads/posts/<ulid>/<name>`. It names a member's private file.
- `<redirect-uri>`, `<client-origin>` and `<resource>` are an MCP client's callback URL, web origin and resource URL.
- `<new-kid>` is a session signing key ID that no earlier key has used, such as `hfy-session-2` after `hfy-session-1`.

The placeholders shared across these docs are listed in [Private data and secrets](../reference/private-data-and-secrets.md#placeholders). `<legacy-origin-id>`, `<edge-region>`, `<image-url>`, `<redirect-uri>`, `<client-origin>`, `<resource>` and `<new-kid>` belong to this page and are defined above. Never put real values for any of these in a ticket or in this repository.

## Before you start

- **Tools:** `curl`, `jq`, `openssl` and the AWS CLI. The MCP token check also needs Node 22 and the `auth/` dependencies (`npm ci` in `auth/`). The `HFYAppendIndex` check runs local unit tests when Node is installed.
- **AWS read access** to the log groups `/aws/lambda/hfy-api`, `/aws/lambda/hfy-auth-edge` and `/aws/lambda/hfy-check-allowed` in `us-west-2`, and to the Lambda@Edge log groups `/aws/lambda/us-east-1.hfy-edge-gate` and `/aws/lambda/us-east-1.hfy-mcp-edge401`. CloudFront's copies of those two functions log in the Region of the edge location that ran them, not in `us-east-1`. To find the Regions that hold them (this needs `ec2:DescribeRegions` and `logs:DescribeLogGroups`):

  ```bash
  for r in $(aws ec2 describe-regions --query 'Regions[].RegionName' --output text); do
    n="$(aws logs describe-log-groups --region "$r" --log-group-name-prefix /aws/lambda/us-east-1.hfy- \
      --query 'length(logGroups)' --output text)"
    [ "$n" = 0 ] || echo "$r: $n"
  done
  ```

  Each line names a Region, `<edge-region>`, and how many of the two groups it holds. Some checks also read the `<app-stack>` stack and its table, the functions' configuration, the distribution configuration, its custom response headers policies and the CloudFront Function `HFYAppendIndex`, the `hfy-api-role` policy, the Cognito user pool, `config/` in the config bucket or `person/` in the site bucket. Fixes that change something say so.
- **`secretsmanager:GetSecretValue` on the origin-verify secret,** and on the VAPID secret for the push check. The 403 check compares digests of the secret with what CloudFront and the functions hold, and never prints a value. Without this permission it cannot tell you whether CloudFront is right. The push check prints the VAPID secret's shape, never a key.
- **io's go-ahead before any fix that changes production.** That covers a real run of any behavior script, `--remove` included, a deploy of `<app-stack>` or of the `us-east-1` stacks, a publish of `HFYAppendIndex`, publishing the allowlist, the admin list or `config/groups.json`, rotating the session signing key or the origin-verify secret, writing app-table items by hand, a Cloudflare purge, and running the live login-flow suites. A real `add-data-gate-behaviors.sh` run without `--remove` needs io's G-prod approval instead. [`AGENTS.md`](../../AGENTS.md) holds the lists.
- **A browser with DevTools.** You will use the Network panel, the Console and **Application > Cookies**. Sign in as a member when the symptom needs it.
- **A shell at the repository root:**

  ```bash
  export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2
  unset ORIGIN_VERIFY
  SITE=https://<site>
  TABLE=$(aws cloudformation describe-stacks --stack-name <app-stack> \
    --query "Stacks[0].Outputs[?OutputKey=='TableName'].OutputValue" --output text)
  ```

  The functions, their logs, the stack and the secrets are in `us-west-2`. `$TABLE` is the stack's DynamoDB table. The behavior scripts take no `--region` flag, and read stack outputs in the CLI's default Region. They also use `$ORIGIN_VERIFY` instead of the secret when it is set, so keep it unset.

Two rules apply to every step:

- **Select fields. Never dump whole objects.** The output of `aws lambda get-function-configuration` and `aws cloudfront get-distribution-config` contains the origin-verify secret. The commands on this page pick fields with `--query` or `jq`. Keep it that way.
- **Keep tokens, logs and photo URLs private.** Read a cookie or token with `read -rs`, decode it locally, and `unset` it when you finish. `hfy-check-allowed` logs the Gramps ID of every successful sign-in, tokens carry an email address, and `/auth/session` returns the member's Gramps ID and a label that is often their email. A `/media/` or `/uploads/` URL names a private file. Do not paste any of these into a ticket or a chat.

To read a function's recent log, run `aws logs tail /aws/lambda/<function> --since 30m`. For a Lambda@Edge group, add `--region <edge-region>`. Add `--filter-pattern '"<text>"'` to keep only matching lines.

## Find your symptom

| Symptom | Section |
| --- | --- |
| `403 {"error":"forbidden"}` from a path under `/api/`, `/auth/` or `/mcp` | [Every /api or /auth request gets 403 forbidden](#every-api-or-auth-request-gets-403-forbidden) |
| `500 {"code":"AUTH_CONFIG"}` from `/auth/*` | [The auth edge returns 500](#the-auth-edge-returns-500) |
| The sign-in page says the email is not on the list, or a `403` with `not_allowlisted` | [A member is told they are not on the access list](#a-member-is-told-they-are-not-on-the-access-list) |
| Signing in with a passkey fails, or adding, listing or removing a passkey fails | [Passkey sign-in fails](#passkey-sign-in-fails) |
| Email and password sign-in fails, a password reset is refused or never arrives, or setting a password fails | [Password sign-in, reset or setup fails](#password-sign-in-reset-or-setup-fails) |
| Google sign-in on `/auth/login` fails because the origin is not allowed for the client ID | [Google sign-in is refused on /auth/login](#google-sign-in-is-refused-on-authlogin) |
| The sign-in pages look unstyled, or keep an old look after a restyle | [The sign-in page is unstyled or out of date](#the-sign-in-page-is-unstyled-or-out-of-date) |
| A legacy Google sign-in at `/family-login/` fails, and `/api/check-allowed` returns `403` | [Legacy sign-in is refused with 403](#legacy-sign-in-is-refused-with-403) |
| `/api/check-allowed` returns `404` | [Legacy check-allowed returns 404](#legacy-check-allowed-returns-404) |
| `/api/*` returns `401` while you are signed in, or an island acts signed out | [The API returns 401 while you are signed in](#the-api-returns-401-while-you-are-signed-in) |
| Person pages, search, photos or post photos fail: `401 {"error":"unauthenticated"}` from `/person/*.json`, `/family/*`, `/event/*`, `/note/*`, `/place/*`, `/media/*` or `/uploads/*`, a page load sent to `/auth/login?returnTo=...`, or "Your sign-in has expired" on a person page | [Person, search or photo data is refused (data gate)](#person-search-or-photo-data-is-refused-data-gate) |
| A private path, or a different spelling of one such as `/Person/index.json`, answers `404` with `cache-control: private, no-store` | [A private path answers 404](#a-private-path-answers-404) |
| A member you removed can still get in | [A removed member still has access](#a-removed-member-still-has-access) |
| A feature flag is on, but the page has not changed, or still runs old code after a deploy | [A flag is on but nothing changes](#a-flag-is-on-but-nothing-changes) |
| A post photo does not upload or does not show | [A photo upload fails or does not show](#a-photo-upload-fails-or-does-not-show) |
| No push notifications arrive | [No push notifications arrive](#no-push-notifications-arrive) |
| A post, comment or notification names its author by Gramps ID instead of by name | [An author label shows a Gramps ID instead of a name](#an-author-label-shows-a-gramps-id-instead-of-a-name) |
| An MCP client cannot add the server, its sign-in shows an error, or its token request is refused | [An MCP client cannot connect](#an-mcp-client-cannot-connect) |
| An MCP client is connected, but `/mcp` answers `401`, the tool list is empty, or deletes stay disabled | [The MCP server refuses a client](#the-mcp-server-refuses-a-client) |

If you are not sure which symptom you have, start with four requests.

## Start with four requests

```bash
curl -s -w '  %{http_code}\n' "$SITE/auth/session"
curl -s -w '  %{http_code}\n' "$SITE/api/posts"
curl -s "$SITE/auth/.well-known/jwks.json" | jq -r '.keys[].kid'
curl -s -o /dev/null -w '%{http_code}\n' "$SITE/person/index.json"
```

On a healthy site, without a session, they print:

```text
{"authenticated":false}  200
{"error":"unauthenticated","message":"sign in required"}  401
hfy-session-1
401
```

The `401` on the second line is the correct answer. The request passed CloudFront, reached `hfy-api`, and was refused only because it carried no session. The third line is the `kid` of the current signing key. After a key rotation it is a later ID. The last line is the data gate refusing a signed-out request for the person manifest. The production cutover attached the gate on 2026-10-12 (HFY-TSK-069, HFY-R67), so on production any other answer there needs action.

| If you see | Go to |
| --- | --- |
| `{"error":"forbidden"}  403` on the first or second line | [Every /api or /auth request gets 403 forbidden](#every-api-or-auth-request-gets-403-forbidden) |
| `{"code":"AUTH_CONFIG"}  500` on the first line | [The auth edge returns 500](#the-auth-edge-returns-500) |
| A `jq` error on the third line | The edge is not serving its keys. Fix whatever the first line shows. Three verifiers fetch these keys. `hfy-api` fails every signed-in API call with `401` once its cached copy expires, within 10 minutes. The MCP server and the data gate keep their last good copy, but a new MCP server container answers `503`, and a new gate copy denies every request. |
| `200` on the last line | The data paths are not gated, and the family data is served to anyone. Run [Find your starting point](cut-over-to-the-private-data-gate.md#find-your-starting-point) on the cutover page at once. |
| `404` on the last line | The gated data behaviors are missing, and `HFYAppendIndex` refuses the family data to everyone, members included. See [A private path answers 404](#a-private-path-answers-404). |

## Every /api or /auth request gets 403 forbidden

**What you see.** The body is exactly `{"error":"forbidden"}`, with no `message`. Both functions check the `X-Origin-Verify` header before any routing ([`api/src/origin.js`](../../api/src/origin.js), [`auth/src/origin.js`](../../auth/src/origin.js)), so the 403 covers every path, JWKS included. The MCP server runs inside `hfy-api`, so `/mcp` gets the same 403. Two other 403s look similar but are different problems:

- A 403 from `/api/*` whose body also has a `message` is a permission refusal, such as editing someone else's post. See the [API reference](../reference/api.md).
- A 403 from `/auth/*` with `{"code":"AUTH_FORBIDDEN"}` is a sign-in refusal. See [A member is told they are not on the access list](#a-member-is-told-they-are-not-on-the-access-list).

**Causes.**

- **You called a Function URL directly.** A request that bypasses CloudFront carries no header, so it is always refused. This is intended. Use `$SITE`.
- **CloudFront sends a value the functions do not hold.** CloudFront gets its value when `add-api-behavior.sh`, `add-auth-behavior.sh` or `add-mcp-behavior.sh` last ran. The functions get theirs when the stack was last deployed. The two drift when one side is updated without the other. A common case: after a rotation to a new secret name, someone runs a behavior script without `--secret-name`, and it writes the old default secret back.
- **`ORIGIN_VERIFY` is empty on a function.** The check then fails closed.

**Check.**

1. Find the secret the stack uses:

   ```bash
   NAME=$(aws cloudformation describe-stacks --stack-name <app-stack> \
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

- **CloudFront differs.** Preview each script first. The dry runs change nothing. Both scripts read their Function URL from the stack's outputs, so they need `--stack <app-stack>`. Without it they stop with an AWS error saying that stack `hfy-app` does not exist.

  ```bash
  bash scripts/infra/add-auth-behavior.sh --stack <app-stack> --secret-name "$NAME" --dry-run
  bash scripts/infra/add-api-behavior.sh --stack <app-stack> --secret-name "$NAME" --dry-run
  ```

  When only the header is wrong, a dry run lists the cache behaviors before and after, then prints `(only the X-Origin-Verify header value differs)`. The `X-Origin-Verify` value is redacted in any diff it prints. If it prints `(dry-run) origin-verify secret not read; using a placeholder`, it compared CloudFront with a placeholder, so its diff tells you nothing. Other diff lines mean someone changed that origin or its behaviors by hand. Read them before you apply, because a run resets every field the script manages. If `add-api-behavior.sh` stops with a line that starts with `refusing:` and exit status 3, fix the legacy route first, as in [Legacy check-allowed returns 404](#legacy-check-allowed-returns-404).

  Then run both scripts without `--dry-run`, one after the other, because each reads the distribution's current ETag. Wait for the edges:

  ```bash
  bash scripts/infra/add-auth-behavior.sh --stack <app-stack> --secret-name "$NAME"
  bash scripts/infra/add-api-behavior.sh --stack <app-stack> --secret-name "$NAME"
  aws cloudfront wait distribution-deployed --id <distribution-id>
  ```

  This changes the distribution's two app origins and their behaviors. `add-api-behavior.sh` writes the header on `hfy-api-origin`, which also serves `/mcp`, so `add-mcp-behavior.sh` is not needed for this fix. When you do run it, pass it the same `--secret-name`. Before each update, a script saves the previous distribution config under `~/.local/state/hfy-infra/cloudfront/` (mode 600) and prints a rollback command. That file holds the old header value, so treat it as a secret.

- **A function differs.** A function holds the value CloudFormation resolved when it last modified that function ([Architecture: `ORIGIN_VERIFY`](../reference/architecture.md#origin_verify)). A stack deploy that changes nothing is a no-op, and a code deploy picks up whatever value the secret holds now, which may not be what CloudFront sends. Follow [Rotate the origin-verify secret](rotate-the-origin-verify-secret.md), which moves both functions and CloudFront to a new secret name.

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
aws cloudformation describe-stacks --stack-name <app-stack> \
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
- **The secret does not exist.** Create it under the manifest's name with a new key ID:

  ```bash
  bash scripts/infra/create-session-key.sh --name "$KEYNAME" --kid <new-kid>
  ```

  Without `--kid`, [`create-session-key.sh`](../../scripts/infra/create-session-key.sh) uses its default, `hfy-session-1`. Pass a `kid` no earlier key used, such as the next number after the manifest's `session.kid` (`jq -r .session.kid auth/edge.manifest.json`), because every JWKS consumer refetches only for a `kid` it does not know. Under a reused `kid`, a warm `hfy-api` container keeps the old public key for up to 600 s and a gate copy for up to 300 s, and both refuse new sessions until their copy expires. The gate logs those refusals as `edge-gate: deny bad-signature`. The script generates a new signing key, so every existing session stops verifying and members sign in again. Afterwards, record the new `kid` as in [Step 3 of Rotate the session signing key](rotate-the-session-signing-key.md#step-3-record-the-new-kid-in-the-repository). Until then, `token-smoke.sh` expects `hfy-session-1` and fails on its `kid` line, as check 2 of [The MCP server refuses a client](#the-mcp-server-refuses-a-client) says.
- **The secret is scheduled for deletion.** Run `aws secretsmanager restore-secret --secret-id "$KEYNAME"`. This cancels the deletion and leaves the key unchanged. The edge reads it on the next request.
- **An environment variable is wrong.** Correct the stack parameter and deploy the stack.

An allowlist the edge cannot read does not cause this 500. Sign-in then fails with `not_allowlisted`, as described in the next section.

## A member is told they are not on the access list

**What you see.** The sign-in page shows the `denied_body` text from the `copy` block of [`auth/edge.manifest.json`](../../auth/edge.manifest.json) as a neutral notice rather than an error. `allowlistNotice` in [`auth/src/edge.js`](../../auth/src/edge.js) marks the message `data-detail="not_allowlisted"` and, when an email was typed, adds a button that copies it. A Google callback or a form post that the allowlist refused gets the `403` denied page instead, whose sentence carries `data-state="not_allowlisted"`. In the Network panel, `POST /auth/google`, `POST /auth/password` or `POST /auth/passkey/login/verify` returns `403 {"code":"AUTH_FORBIDDEN","detail":"not_allowlisted"}`. An MCP client gets `access_denied` with "not on the family access list".

**Causes.**

- **The email is not in `config/userGrampsID.json`.** Google sign-in uses the Google account's address, which may not be the one you listed. A passkey sign-in uses the email stored with the passkey when it was added.
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
   aws cloudformation describe-stacks --stack-name <app-stack> \
     --query "Stacks[0].Parameters[?ParameterKey=='ConfigBucket' || ParameterKey=='AllowlistKey']" --output table
   ```

**Fix.** Add or correct the entry as in [Manage family access](manage-family-access.md), wait 300 s, and sign in again in a private window. For a malformed file, publish a valid one the same way. For a permission mismatch, correct the parameters and deploy the stack.

A `403` with `link_conflict` instead of `not_allowlisted` is a different problem: the email is already linked to another Gramps ID. See [Identity services](../reference/identity-services.md#principal-resolution).

## Passkey sign-in fails

**What you see.** The passkey button at `/auth/login`, whose label is the manifest's `passkey_button` text, or a passkey picked from the email field's suggestions, does not sign the member in. Or adding, listing or removing a passkey fails, on the account page at `/auth/link` (where `/auth/passkeys` leads) or in the prompt to add one after a Google or password sign-in (`passkey_add_title`). The page shows the access-list notice, the manifest's `passkey_failed` text or its `generic_error` text. Find the request under `/auth/passkey/` in the Network panel. The routes and every error code are in [Identity services: Passkeys](../reference/identity-services.md#passkeys).

| Request | Response | Cause | Fix |
| --- | --- | --- | --- |
| `POST /auth/passkey/login/verify` | `403 {"code":"AUTH_FORBIDDEN","detail":"not_allowlisted"}` | The passkey is valid, but the email stored with it is no longer on the allowlist. Every passkey sign-in checks the allowlist again, and the page shows the access-list notice. | See [A member is told they are not on the access list](#a-member-is-told-they-are-not-on-the-access-list). |
| `POST /auth/passkey/login/verify` | `401 {"code":"AUTH_EXPIRED","detail":"passkey_unknown"}` | The passkey was removed from the member's account, but the device still offers it. No session is created. | Sign in another way. The member deletes the passkey from the device and, if they want one, adds a new one at `/auth/link`. |
| `POST /auth/passkey/register/options` | `403 {"code":"AUTH_FORBIDDEN","detail":"passkey_limit"}` | The member already has 20 passkeys, the kit's limit per member. | Remove passkeys they no longer use at `/auth/link`, then add the new one. |
| `POST /auth/passkey/login/verify` or `register/verify` | `401 {"code":"AUTH_EXPIRED","detail":"passkey_challenge_expired"}` or `"passkey_challenge_unknown"` | More than 300 s passed between the options request and the verify, or the challenge was already used. Each challenge works once. | Try again. |
| `POST /auth/passkey/login/verify` | `401 {"code":"AUTH_EXPIRED","detail":"passkey_clone_suspected"}` | The authenticator's signature counter went backwards, which suggests a copied credential. | Remove that passkey at `/auth/link` and add a new one. |
| `POST /auth/passkey/login/verify` | `403 {"code":"AUTH_FORBIDDEN","detail":"principal_changed"}` | The email stored with the passkey now maps to a different Gramps ID. | See [Change a member's record or email](manage-family-access.md#change-a-members-record-or-email). |
| `POST /auth/passkey/register/verify` | `403 {"code":"AUTH_FORBIDDEN","detail":"passkey_exists"}` | This credential is already stored. | Nothing to fix. The passkey is already on the account. |
| Any `POST` or `DELETE` under `/auth/passkey/` | `403 {"code":"AUTH_FORBIDDEN"}` with no `detail` | The request came from an origin other than `https://<site>`, such as `www.<site>`, or lacked `X-Requested-With: io-kit`. | Use `https://<site>/auth/login` and `https://<site>/auth/link`. |
| `POST /auth/passkey/register/options`, `GET /auth/passkey/list` or `DELETE /auth/passkey/<id>` | `401 {"code":"AUTH_EXPIRED"}` with no `detail` | These routes use the refresh cookie `io_rt`, not `io_id`. It is missing, expired or revoked, or the member is no longer on the allowlist. | Sign in again at `/auth/login`. |

**The account page lists no passkeys, but the member signs in with one.** A credential item written before HFY-R67 lacks the `GSI1SK` index key, so the passkey list, the 20-passkey limit, and the `excludeCredentials` and `allowCredentials` lists sent to the browser all miss it. The edge adds the key the next time it reads the item, which every sign-in and every removal with that passkey does ([`auth/src/passkeystore.js`](../../auth/src/passkeystore.js)). If that repair fails, the edge logs `passkey index backfill failed` with the error, and the sign-in still succeeds. Check both:

```bash
aws logs tail /aws/lambda/hfy-auth-edge --since 1d --filter-pattern '"passkey index backfill failed"'
aws dynamodb scan --table-name "$TABLE" --select COUNT \
  --filter-expression 'begins_with(PK, :p) AND attribute_exists(GSI1PK) AND attribute_not_exists(GSI1SK)' \
  --expression-attribute-values '{":p": {"S": "PASSKEY#"}}' --query Count
```

The scan needs `dynamodb:Scan` on the table and prints only a number. `0` means every passkey is indexed. Any other count falls as members sign in with those passkeys. If the log shows the repair failing, its error names the cause. The edge's role needs `dynamodb:UpdateItem` on the table, which the `RefreshAndLinkStore` statement in [`app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml) grants. Deploy the stack if the role lacks it.

## Password sign-in, reset or setup fails

**What you see.** The email and password form at `/auth/login`, the reset page at `/auth/password/forgot` or the set-a-password page at `/auth/link` shows an error, or a reset email never arrives. Find the request in the Network panel:

| Request | Response | Cause |
| --- | --- | --- |
| `POST /auth/password` | `401 {"code":"AUTH_FORBIDDEN","detail":"invalid_credentials"}` | The password is wrong, or the member has no password yet. Check the pool user (below). |
| `POST /auth/password` | `403 {"code":"AUTH_FORBIDDEN","detail":"unconfirmed"}` | Someone signed this email up through Cognito before self-service sign-up was turned off, and the sign-up was never confirmed. |
| `POST /auth/password` | `403 {"code":"AUTH_FORBIDDEN","detail":"challenge_unsupported"}` | Cognito wants a new password, because the user was created with a temporary one outside the edge. |
| `POST /auth/password/forgot` | `429 {"code":"AUTH_FORBIDDEN","detail":"rate_limited"}` and a `Retry-After` header | Too many reset requests. The edge allows 3 an hour for one email from one IP address, and 10 a day from one IP address ([`auth/src/ratelimit.js`](../../auth/src/ratelimit.js)). |
| `POST /auth/password/forgot` | `503 {"code":"AUTH_NETWORK"}` | No email was sent. The rate limiter could not write to the stack's table, and the edge logs `forgot-password rate limiter unavailable` ([`auth/src/edge.js`](../../auth/src/edge.js)). |
| `POST /auth/password/forgot` | `502 {"code":"AUTH_NETWORK"}` | No email was sent. Cognito was unreachable, answered with a 5xx, or refused the call with `TooManyRequestsException` or `LimitExceededException`. One such limit is the default email sender's quota of about 50 emails a day for the whole account. The edge logs nothing for this case. |
| `POST /auth/password/forgot` | `200 {"ok":true}`, but no email arrives | The answer is the same whether or not a pool user exists, and Cognito sends nothing when there is none. Check the pool user (below). |
| `POST /auth/link` | `400 {"code":"AUTH_FORBIDDEN","detail":"weak_password"}` | The password is shorter than 8 characters. |
| `POST /auth/link` | `503 {"code":"AUTH_NETWORK"}` | A Cognito admin call failed, and the edge logs nothing. Most often the password passed the edge's 8-character check but not the pool's policy: at least 12 characters, with upper case, lower case and a number. |
| `POST /auth/verify` | `410 {"code":"AUTH_FORBIDDEN","detail":"signup_disabled"}` | Expected. Self-service sign-up is off, so there is no sign-up to confirm. |

**Cause.** The pool accepts no self-service sign-up (`AllowAdminCreateUserOnly` in [`app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml)). The edge creates a member's pool user only when the member, already signed in, sets a password at `/auth/link` ([`auth/src/cognito.js`](../../auth/src/cognito.js)). A member who has only ever used Google or a passkey has no password to sign in with or reset.

**Check the pool user.** This reads the user's status only:

```bash
POOL=$(aws cloudformation describe-stacks --stack-name <app-stack> \
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

- **No user, `UNCONFIRMED` or `FORCE_CHANGE_PASSWORD`.** The member signs in with Google or a passkey, opens `/auth/link` and sets a password that meets the pool policy. The edge then creates the user, or confirms it and marks its email verified, and sets the password as permanent.
- **`CONFIRMED`.** The member resets the password at `/auth/password/forgot`.
- **`429`.** Wait the number of seconds in `Retry-After`. Nothing else resets the counters.
- **`503` from `/auth/password/forgot`.** Read the edge log for `forgot-password rate limiter unavailable`. Its `error` names the cause. The limiter writes with `dynamodb:UpdateItem`, which the `RefreshAndLinkStore` statement in `app-stack.yaml` grants the edge's role on the table. If the error says the role is not authorized to perform `dynamodb:UpdateItem`, deploy the stack.
- **`502` from `/auth/password/forgot`.** The Cognito call failed or was refused, and the edge logs nothing. A short Cognito outage or throttling clears by itself, so try again later. If it keeps failing, the default sender's daily email quota may be spent. To lift it, set the `SesIdentityArn` parameter to a verified SES identity in `us-west-2`, and `SesFromAddress` if you want a sender address, then deploy the stack. The pool then sends its email through SES.
- **`503` from `/auth/link` with a password that meets the policy.** The function's role may lack the `CognitoAdminLink` permissions in `app-stack.yaml`. Deploy the stack.

To confirm, sign in with the email and password at `/auth/login`, then run step 2 of [The API returns 401 while you are signed in](#the-api-returns-401-while-you-are-signed-in). It reports `authenticated: true`.

## Google sign-in is refused on /auth/login

**What you see.** On `/auth/login`, the Google button does not sign the member in, and Google reports that the origin is not allowed for the given client ID, in the Console or in its pop-up. No `POST /auth/google` is sent.

**Check.**

```bash
curl -s -D - -o /dev/null "$SITE/auth/login" | grep -i '^referrer-policy'
```

It must print `referrer-policy: strict-origin-when-cross-origin`. Google Identity Services reads the page origin from the `Referer` of its own requests.

| Finding | Cause | Fix |
| --- | --- | --- |
| `no-referrer` | `hfy-auth-edge` runs a build with `@io-kit/auth` older than 2.1.2, which hides the origin from Google. `auth/package.json` pins a later version. | Deploy `hfy-auth-edge` from `main` ([Deploy the app stack](deploy-the-app-stack.md)). |
| `strict-origin-when-cross-origin` | The Google client does not list `https://<site>` as an authorized JavaScript origin, or Google has not applied a recent change to the client yet, which can take from minutes to hours. | Check the client's origins in the Google Cloud console, as in [Rotate the Google client](rotate-the-google-client.md). |

`401 {"code":"AUTH_EXPIRED","detail":"wrong_audience"}` from `POST /auth/google` is a different problem: the edge holds another client ID than the page. See [Rotate the Google client](rotate-the-google-client.md).

## The sign-in page is unstyled or out of date

**What you see.** `/auth/login`, the forgot and reset pages, `/auth/link` or the denied page shows only the kit's plain base style, without the family theme and fonts. Or, after a change to the sign-in look, the pages keep the old one.

The kit renders these pages, and they link one stylesheet: the manifest's `theme.cssUrl`, `https://<site>/css/auth-edge.css?v=<sha8>`. That file is [`11ty/css/auth-edge.css`](../../11ty/css/auth-edge.css), which the islands build makes from [`islands/src/auth-edge/auth-edge.css`](../../islands/src/auth-edge/auth-edge.css). Every time the file changes, the build writes the new `?v=` into the manifest. The page's Content-Security-Policy loads stylesheets only from `https://<site>` and from Google's sign-in styles, and fonts only from the site itself (`font-src 'self'`). Cloudflare, in front of CloudFront, keeps static files for 4 hours under the URL it first fetched, and CloudFront invalidations do not reach it. [Identity services: Page theme and HFY overrides](../reference/identity-services.md#page-theme-and-hfy-overrides) describes the pages.

**Check.**

```bash
jq -r .theme.cssUrl auth/edge.manifest.json
LINKED=$(curl -s "$SITE/auth/login" | grep -o '<link rel="stylesheet" href="[^"]*">' | head -1 | cut -d'"' -f4)
echo "$LINKED"
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' "$LINKED"
echo "named ${LINKED##*v=}, served $(curl -s "$LINKED" | openssl dgst -sha256 | awk '{print substr($NF, 1, 8)}')"
curl -s -D - -o /dev/null "$SITE/auth/login" | grep -i '^content-security-policy:' | grep -o -E "(style|font)-src [^;]*"
```

On a healthy site, the first two lines show the same URL, the third shows `200` and a CSS content type, the fourth shows the same eight hex digits twice, and the last two show `style-src 'unsafe-inline' https://<site> https://accounts.google.com/gsi/style` and `font-src 'self'`. In DevTools, the Console of `/auth/login` names any stylesheet or font that the policy refused.

| Finding | Cause | Fix |
| --- | --- | --- |
| The linked URL is `https://<site>/css/main.css`, has no `?v=`, or is missing | `hfy-auth-edge` runs a package built before the sign-in stylesheet. | Deploy `hfy-auth-edge` from `main` ([Deploy the app stack](deploy-the-app-stack.md)). |
| The linked URL differs from the repository's `theme.cssUrl` | The stylesheet changed, but `hfy-auth-edge` was not redeployed. The function links the new URL only once it runs a package with the new manifest. Until then, Cloudflare keeps serving the bytes it cached under the old URL. | Deploy `hfy-auth-edge`, after the site deploy that ships the new stylesheet. |
| The stylesheet does not answer `200` | The file is not in `<site-bucket>`. It is repo-owned build output, not Eleventy output, so an Eleventy refresh that does not exclude it drops it. | Run `cd islands && npm run build` and `npm run check:islands`. Commit `11ty/css/auth-edge.css`, and `auth/edge.manifest.json` if its `cssUrl` changed, then deploy the site ([Deploy a site change](deploy-a-site-change.md)). Deploy `hfy-auth-edge` too if the `cssUrl` changed. |
| `named` and `served` differ | The URL serves other bytes than it names. Either the site deploy with that stylesheet has not finished, or a request reached the new URL before it finished. CloudFront ignores the query string, so until the deploy's invalidation reaches an edge, it serves the old file under the new URL, and Cloudflare then keeps those bytes for up to 4 hours. | Let the site deploy finish. Then wait out Cloudflare's 4 hours, or purge that one URL from Cloudflare, which needs io's go-ahead. Next time, deploy the site before `hfy-auth-edge`. |
| `style-src` does not name `https://<site>`, or `font-src 'self'` is missing | `hfy-auth-edge` runs an older kit or an older [`auth/src/edge.js`](../../auth/src/edge.js). | Deploy `hfy-auth-edge` from `main`. |

Checks 4 and 5 of [Deploy the app stack: Verify](deploy-the-app-stack.md#verify) confirm the fix.

## Legacy sign-in is refused with 403

**What you see.** After the Google pop-up on `/family-login/`, the navigation stays signed out. The legacy page posts the Google ID token to `/api/check-allowed`. Find that request in the Network panel and read its body.

The legacy sign-in runs only where `authV2` does not take over the page. That is the case when the published `flags.json` has `authV2` set to `false` (`curl -s "$SITE/_data/flags.json" | jq .authV2`), or when the tab's preview override forces it off (`sessionStorage.getItem("hfy:flags")` shows `-authV2`). It is also the case when `/auth/session` did not answer with JSON, and when the visitor is already signed in at the edge. Otherwise `/family-login/` sends a signed-out visitor to `/auth/login`, and the sections above apply. The legacy pieces still ship with every push to `main`: `hfy-check-allowed` through [`io-kit-deploy.yml`](../../.github/workflows/io-kit-deploy.yml), and `getAllowlist` through [`deploy-gcf-legacy.yml`](../../.github/workflows/deploy-gcf-legacy.yml). While the data gate is attached, a legacy sign-in reads no family data and no `/api` route, because both accept only the `io_id` cookie.

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

**What you see.** `POST /api/check-allowed` returns `404 {"error":"not_found","message":"no such route"}`. That body comes from `hfy-api` ([`api/src/handler.js`](../../api/src/handler.js)), which has no `check-allowed` route. The legacy sign-in then fails wherever it runs, and `add-api-behavior.sh` refuses to run until the route is fixed.

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
   bash scripts/infra/add-api-behavior.sh --stack <app-stack> --secret-name "$NAME" --dry-run; echo "exit $?"
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
  bash scripts/infra/add-api-behavior.sh --stack <app-stack> --secret-name "$NAME"
  aws cloudfront wait distribution-deployed --id <distribution-id>
  ```

- **No pin, and nothing to copy.** Name the legacy origin. The script then creates `/api/check-allowed*` on that origin with the same settings as `/api/*`, directly above the first behavior that matches the path. It refuses an ID that is not an origin of the distribution.

  ```bash
  bash scripts/infra/add-api-behavior.sh --stack <app-stack> --secret-name "$NAME" --legacy-origin <legacy-origin-id> --dry-run
  bash scripts/infra/add-api-behavior.sh --stack <app-stack> --secret-name "$NAME" --legacy-origin <legacy-origin-id>
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

1. **Is the request sent, with the cookie?** In the Network panel, open the failing request and look for `io_id` in the `Cookie` request header.

   - **There is no `/api` request at all.** Where `authV2` resolves on, the islands' API client sends no `/api` call once `/auth/session` has answered `authenticated: false`. It treats the call as a `401` without sending it ([`islands/src/lib/api.js`](../../islands/src/lib/api.js)). Go to step 2.
   - **You signed in only through `/family-login/`.** The legacy sign-in sets no `io_id`, so the API sees no session. Sign in at `/auth/login`.
   - **You are on another host name.** `io_id` is a host-only cookie for `<site>`. On `www.<site>` or the CloudFront domain, the browser does not send it.
   - **The cookie has expired.** It lasts 3600 s. Where `authV2` resolves on, [`11ty/js/feature-flags.js`](../../11ty/js/feature-flags.js) refreshes it from the `io_rt` refresh cookie: when a page loads and the session is within 120 s of its expiry, or is signed out in a browser that has had an edge session, and when the data gate answers `401`. An `/api/*` call is not retried, so a page left open past the expiry keeps getting `401` until something on it refreshes the session, at the latest when you reload it. In the Network panel, `POST /auth/refresh` answers `200` when the refresh worked. A `401` there means the refresh cookie is gone, expired or revoked, or the member is no longer on the allowlist: sign in again. Where `authV2` resolves off, no site script refreshes `io_id`, so sign in again.

2. **Does the edge accept the cookie?** In the Console, run this. It prints only whether you are signed in and when the session expires:

   ```js
   const s = await (await fetch("/auth/session", { cache: "no-store" })).json();
   ({ authenticated: s.authenticated, expires: s.exp ? new Date(s.exp * 1000).toISOString() : null })
   ```

   - `authenticated: false`: the edge rejects the cookie too. It has expired, or it was signed with a key the edge no longer holds. Sign in again.
   - `authenticated: true`: the edge accepts the cookie but the API does not. Go to step 3.

3. **Compare the token with the API's settings.** In **Application > Cookies**, copy the value of `io_id`. Scripts cannot read it, because it is `HttpOnly`. Decode only the fields you need, locally:

   ```bash
   read -rs IO_ID   # paste the value; nothing is echoed
   printf '%s' "$IO_ID" | jq -R 'split(".")[0:2] | map(gsub("-";"+") | gsub("_";"/") | @base64d | fromjson)
     | {kid: .[0].kid, iss: .[1].iss, aud: .[1].aud, expires: (.[1].exp | todate)}'
   unset IO_ID
   curl -s "$SITE/auth/.well-known/jwks.json" | jq -r '.keys[].kid'
   aws cloudformation describe-stacks --stack-name <app-stack> \
     --query "Stacks[0].Parameters[?starts_with(ParameterKey, 'Session')]" --output table
   ```

   | Finding | Cause | Fix |
   | --- | --- | --- |
   | `expires` is in the past | The session ended | Reload the page. Where `authV2` resolves on, the page refreshes the session. If it does not, or `POST /auth/refresh` answers `401`, sign in again. |
   | The token's `kid` is not the JWKS `kid` | The token predates a key rotation | Reload the page so it refreshes, as in the previous row. Otherwise sign in again. |
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

## Person, search or photo data is refused (data gate)

**What you see.** The Lambda@Edge function `hfy-edge-gate` ([`edge-gate/src/gate.mjs`](../../edge-gate/src/gate.mjs)) checks the `io_id` cookie on every request that matches one of its seven path patterns. Six are the family data: `/person/*.json`, `/family/*`, `/event/*`, `/note/*`, `/place/*` and `/media/*`. The seventh is `/uploads/*`, where member post photos live, once [`add-data-gate-behaviors.sh`](../../scripts/infra/add-data-gate-behaviors.sh) has gated it. [Find your starting point](cut-over-to-the-private-data-gate.md#find-your-starting-point) on the cutover page shows which paths are gated. When the cookie is missing or fails a check:

- A fetch, XHR or image gets `401` with the body `{"error":"unauthenticated"}`. Search finds nothing, photos, post photos and family trees do not load, and the person page cannot load its record.
- A page load of one of those paths, such as a photo opened in its own tab, gets a `302` to `/auth/login?returnTo=<path>`.
- A person page shows "Your sign-in has expired. Sign in again to see this page." when its data request is still refused after the client's one refresh and retry, and the client did not send the tab to sign-in itself (check 6).

The person page, `/person/?id=<gramps-id>`, is public and never gated. Every answer from the gate carries `cache-control: private, no-store`.

Where `authV2` resolves on, the client sends these requests with the `io_id` cookie and no `X-HFY-Session` header. On a gate `401` it calls `POST /auth/refresh` once and retries the request once. Only when that fails does a page go to `/auth/login?returnTo=<page>` ([Front end](../reference/front-end.md#authv2-data-fetch-and-session-continuity)). Post photos load as same-origin `<img>` elements, which send the cookie too.

**Check, in order.**

1. **`authV2` resolves on.**

   ```bash
   curl -s "$SITE/_data/flags.json" | jq .authV2
   ```

   It must print `true`. `false` while the gate is attached is an outage: the legacy client signs in through `/family-login/`, which sets no `io_id`, so the gate refuses its data requests. Go to the first item of Fix at once. A failed site deploy whose automatic rollback restored an older `flags.json` is one way to get there ([Roll back a site deploy](roll-back-a-site-deploy.md#check-authv2-after-a-failed-deploy)). In a single tab, a preview override can force the flag off: in the Console, `sessionStorage.getItem("hfy:flags")` then shows `-authV2`. Open `?hfy_flags=` to clear it.

2. **The request carries the cookie, and only the cookie.** In the Network panel, open the refused request. Its `Cookie` request header includes `io_id`, and there is no `X-HFY-Session` header. Do not copy the cookie value.

   - `X-HFY-Session` is present: this tab runs the legacy client. See check 1.
   - `io_id` is missing: the browser is not signed in at the edge, or it is on another host name, such as `www.<site>`. The cookie is host-only for `<site>`.
   - `io_id` is missing on a script's own request for a photo: a script that fetches a gated file must pass `credentials: "same-origin"`.

3. **The edge accepts the session.** Run the Console command from step 2 of [The API returns 401 while you are signed in](#the-api-returns-401-while-you-are-signed-in).

   - `authenticated: false`: the session is gone, and the refresh failed too. In the Network panel, `POST /auth/refresh` answered `401`: the refresh cookie expired or was revoked, or the member is no longer on the allowlist. Sign in again at `/auth/login`.
   - `authenticated: true` with `expires` in the future: the edge accepts the cookie but the gate does not. Go on.

4. **The token's `kid` is in the published key set.** Decode the cookie's `kid`, `iss`, `aud` and expiry and fetch the JWKS `kid`, as in step 3 of [The API returns 401 while you are signed in](#the-api-returns-401-while-you-are-signed-in). The gate requires `iss` `https://<site>/auth` and `aud` `harrisonfamily-web`, which the build bakes into its zip from [`edge-gate/gate.config.json`](../../edge-gate/gate.config.json). Each gate copy keeps the key set it fetched for 300 s. A token under an unknown `kid` makes it fetch the key set again, but not within 30 s of its last successful fetch, or 2 s of a failed one ([Identity services: JWKS cache](../reference/identity-services.md#jwks-cache)).

   | Finding | Cause |
   | --- | --- |
   | The `kid`s differ | The token predates a key rotation. The client's refresh replaces it. If the refresh failed, sign in again. |
   | The `kid`s match, and the key was rotated in the last 5 minutes under the same `kid` | A gate copy still holds the old key under that `kid` until its key set is 300 s old. Wait. Always rotate to a new `kid`. |
   | A new `kid` was published in the last 30 s | A gate copy that fetched just before the rotation refuses the new `kid` until its 30 s pause ends. Wait. |
   | The JWKS `kid` changes between runs of the `curl` | The auth edge was not recycled after a rotation. Recycle it, as in [Rotate the session signing key](rotate-the-session-signing-key.md#step-2-recycle-the-auth-edge). |
   | `iss` or `aud` differs from the values above | The auth edge mints sessions for an issuer or audience the gate was not built for. The gate needs a new build ([Deploy the edge functions](deploy-the-edge-functions.md#ship-a-change-to-the-gate)). |

5. **Read the gate's log** in each `<edge-region>` from [Before you start](#before-you-start):

   ```bash
   aws logs tail /aws/lambda/us-east-1.hfy-edge-gate --region <edge-region> --since 30m
   ```

   | Line | Meaning |
   | --- | --- |
   | `edge-gate: deny unknown-kid` | The token's `kid` is not in the gate's key set. See check 4. |
   | `edge-gate: deny bad-signature` | The key under that `kid` did not sign the token: a rotation reused the `kid`, or the token is forged. See check 4. |
   | `edge-gate: deny expired` | `io_id` is more than 60 s past its expiry, and the client did not replace it. Look for `POST /auth/refresh` in the Network panel. |
   | `edge-gate: deny iss` or `edge-gate: deny aud` | See the last row of check 4. |
   | `edge-gate: deny malformed`, `alg-or-kid`, `nbf` or `sub` | The cookie is damaged or is not a site session token. Sign out, then sign in again. |
   | `edge-gate: jwks refresh failed: <message>` or `edge-gate: jwks had no usable RS256 keys` | The gate cannot fetch `https://<site>/auth/.well-known/jwks.json`. A copy keeps its last good keys, but a new copy with none denies every request. Run [Start with four requests](#start-with-four-requests). |
   | `edge-gate: deny error <message>` | An unexpected error, which the gate treats as a deny |
   | No line for the request | It carried no `io_id` cookie. See check 2. |

   The gate never logs a token, a claim or a path.

6. **The sign-in redirect is not held back.** In the Console, run `sessionStorage.getItem("hfy:auth-bounce")`. A number is the time, in milliseconds, when this tab was last sent to `/auth/login` by a refused data request. For 10 minutes after that, the client does not redirect the tab again, so it cannot loop. The person page shows "Your sign-in has expired" with a sign-in link instead. The next data request that succeeds clears the value. If the browser blocks storage, the client never redirects on its own. Before you test again, run `sessionStorage.removeItem("hfy:auth-bounce")`.

7. **No shared cache holds a gate answer, and the behaviors are in place.** Signed out:

   ```bash
   for i in 1 2; do
     curl -sS -o /dev/null -D - "$SITE/person/index.json" | grep -iE '^(HTTP|cache-control|cf-cache-status)'
   done
   ```

   Both answers are `401` with `cache-control: private, no-store`, and `cf-cache-status` is never `HIT`. Signed in, the data responses in the Network panel also show `cache-control: private, no-store`. A `HIT`, or a `200` signed out, means Cloudflare or CloudFront serves the data without the gate. A `404` means the behavior is missing ([A private path answers 404](#a-private-path-answers-404)). List the gated behaviors in evaluation order, then the custom response headers policies by name:

   ```bash
   aws cloudfront get-distribution-config --id <distribution-id> | jq -r '
     .DistributionConfig.CacheBehaviors.Items[]
     | select(.PathPattern | test("^/(person|family|event|note|place|media|uploads)/"))
     | [.PathPattern,
        (.LambdaFunctionAssociations.Items[0] // {} | "\(.EventType // "none") \(.LambdaFunctionARN // "" | split(":") | .[6:] | join(":"))"),
        .CachePolicyId, (.ResponseHeadersPolicyId // "none")] | @tsv'
   aws cloudfront list-response-headers-policies --type custom \
     --query "ResponseHeadersPolicyList.Items[].ResponseHeadersPolicy.[ResponseHeadersPolicyConfig.Name, Id]" --output text
   ```

   - Each of the six data patterns shows `viewer-request hfy-edge-gate:<n>`, where `<n>` is the version you validated, the cache policy `4135ea2d-6df8-44a3-9df3-4b5a84be39ad` (CachingDisabled), and the ID of `hfy-private-no-store`.
   - A gated `/uploads/*` shows the same association and cache policy, and the ID of `hfy-uploads-private`. An ungated one shows `none`, `658327ea-f89d-4fab-a63d-7e88639e58f6` (CachingOptimized) and the app stack's uploads policy, which the list names after the API function, `hfy-api-uploads-sandbox` by default.
   - A gated pattern must come before any broader pattern that also matches it, such as a legacy `/person/*`. A pattern that is missing, misplaced, or shows `none` where it should be gated lets the data through or, where `HFYAppendIndex` runs its default-deny code, answers `404`.

**Fix.**

- **`authV2` is `false` while the gate is attached.** What gets members their data back depends on the code that `HFYAppendIndex` runs. Check it:

  ```bash
  curl -sS -o /dev/null -D - "$SITE/Person/index.json" | grep -iE '^(HTTP|cache-control)'
  ```

  - **Anything but `404` with `cache-control: private, no-store`:** the function runs older code. Remove the gate at once (next item). The legacy client can then read the data.
  - **`404` with `cache-control: private, no-store`:** the function runs its default-deny code. Removing the gate does not give the legacy client its data back, because the six data paths then fall through to the function, which answers `404` to everyone. Instead, get a release with `"authV2": true` deployed again, by fixing forward or reverting ([Roll back a site deploy](roll-back-a-site-deploy.md#after-an-automatic-rollback)). The other way out is to remove the gate and roll the function back as well ([Publish a change to the CloudFront Function](publish-the-cloudfront-function.md)).
- **Remove the gate.** Do this only as the cutover page's [Roll back](cut-over-to-the-private-data-gate.md#roll-back) describes. If a new gate version is at fault, point the behaviors back at a retained earlier version instead, as in [Deploy the edge functions](deploy-the-edge-functions.md#roll-back), and the data stays gated. A real `--remove` needs io's go-ahead:

  ```bash
  bash scripts/infra/add-data-gate-behaviors.sh --remove --dry-run --app-stack <app-stack>
  bash scripts/infra/add-data-gate-behaviors.sh --remove --app-stack <app-stack>
  aws cloudfront wait distribution-deployed --id <distribution-id>
  ```

  - `--app-stack <app-stack>` names the stack whose output `UploadsResponseHeadersPolicyId` is the policy that `/uploads/*` gets back. The script reads it in the CLI's default Region, which the shell from [Before you start](#before-you-start) sets to `us-west-2`. While `/uploads/*` is gated, a run without `--app-stack <app-stack>` or `--restore-uploads-policy-id <id>`, the dry run included, prints `pass --restore-uploads-policy-id ID to name the response headers policy /uploads/* gets back`, exits `1` and changes nothing.
  - Do not pass `--stack <app-stack>`. This script's `--stack` names the `us-east-1` gate stack, whose default, `hfy-edge-gate`, is the deployed name, and `--remove` does not read it.
  - The dry run's diff removes the six data behaviors that carry an `hfy-edge-gate` association, so `CacheBehaviors.Quantity` falls by 6. If `/uploads/*` is gated, the diff also changes it in place: no Lambda association, CachingOptimized, and the app stack's uploads policy. Nothing else changes. If nothing is gated, both runs print `distribution <distribution-id> already has no hfy-edge-gate-gated data behaviors (/person/*.json /family/* /event/* /note/* /place/* /media/*) and /uploads/* back to its ungated state: no change`.

  Once the distribution is deployed, member photos are readable by anyone who holds a URL, and the family data is public again unless `HFYAppendIndex` runs its default-deny code. The `hfy-private-no-store` and `hfy-uploads-private` policies stay in the account, unused. Restoring the backup that the attaching run saved, with `aws cloudfront update-distribution`, is the alternative, as the cutover page shows. Then deal with the flag.
- **The session ended, or the refresh failed.** Sign in again at `/auth/login`. A member who is no longer on the allowlist is refused there, as intended.
- **A key problem.** Make the auth edge serve its key set first ([Every /api or /auth request gets 403 forbidden](#every-api-or-auth-request-gets-403-forbidden), [The auth edge returns 500](#the-auth-edge-returns-500)). After a rotation, recycle the auth edge and allow 300 s for every gate copy to fetch the new key set.
- **A behavior or a response headers policy is wrong, or Cloudflare served a `HIT`.** Run `bash scripts/infra/add-data-gate-behaviors.sh --dry-run`, review the diff, then apply it, as in [step 3 of the cutover](cut-over-to-the-private-data-gate.md#3-attach-the-gate). The real run needs io's G-prod approval. It puts the six data behaviors, the gated `/uploads/*` and both policies back. Then purge Cloudflare's copies, as in [step 4](cut-over-to-the-private-data-gate.md#4-optional-purge-cloudflare), which needs io's go-ahead.

To confirm, run the [Verify](cut-over-to-the-private-data-gate.md#verify) checks of the cutover page.

## A private path answers 404

**What you see.** A request for a path under `/person/`, `/family/`, `/event/`, `/note/`, `/place/`, `/media/` or `/uploads/` answers `404` with `cache-control: private, no-store`. A person page shows its generic error line, and the Console logs `Failed to load person` with the HTTP status.

That answer comes from `HFYAppendIndex`, the CloudFront Function on the distribution's default behavior ([`scripts/cloudfront/append-index.js`](../../scripts/cloudfront/append-index.js)), not from S3. Besides its clean-URL rewrite, the function refuses any request whose first path segment is `family`, `event`, `note`, `place`, `media` or `uploads`, and any `.json` under `person/`. Under `person/`, only the public shell, `/person/index.html`, passes, reached as `/person/` or `/person`. Before it matches, the function percent-decodes the path up to four times, lowercases it, turns backslashes into `/`, strips `;params`, resolves dot segments, and trims trailing dots and spaces. Exact requests for private data match their gated behavior first, so they never reach the function. [Edge and origin design](../explanation/edge-and-origin-design.md#why-the-cloudfront-function-also-denies) explains why it denies.

| Request | Meaning |
| --- | --- |
| A different spelling of a private path, such as `/Person/index.json`, `/person/<gramps-id>.JSON`, `/person/index.json/`, `/Media/<file>` or `/Uploads/<path>`, or one with `%2F`, `%252e`, a backslash, `..`, a `;` or a trailing dot or space | Expected. CloudFront path patterns are case-sensitive, and `/person/*.json` is anchored on its suffix, so such a variant matches no gated behavior. The function refuses it so that it never reaches S3. Request the exact lower-case path. |
| The exact path, such as `/person/index.json`, for everyone, signed in or not | The gated behavior for that pattern is missing, so the request fell through to the default behavior. Run check 7 of [the data gate section](#person-search-or-photo-data-is-refused-data-gate), and restore the behavior as in its Fix. |
| A photo under `/uploads/`, for everyone | The `/uploads/*` behavior is missing. See [A photo upload fails or does not show](#a-photo-upload-fails-or-does-not-show). |
| A new public file under `/person/`, other than the shell | `PUBLIC_PERSON_FILES` in `append-index.js` lists only `/person/index.html`. A public file added under `11ty/person/` must be added there too, and the function published. A test pins the list to the files in `11ty/person/`. |
| `/person/`, or a page outside those prefixes | The deny rules do not cause this. Check the code the function runs (below). |

**Check the function.** This dry run only reads. It runs the local unit tests when Node is installed, checks where the function is associated, and compares the published (`LIVE`) and draft (`DEVELOPMENT`) code with the repository's:

```bash
bash scripts/infra/publish-append-index.sh --dry-run; echo "exit $?"
```

| Output | Meaning |
| --- | --- |
| `HFYAppendIndex is the viewer-request function of the default cache behavior of <distribution-id>` | It sits where it belongs. |
| `refusing (exit 3): HFYAppendIndex is associated with cache behavior(s) <patterns> of <distribution-id>. ...` | It also sits on another behavior, where it answers `404` to the data that behavior serves. Rerun the behavior script that owns that behavior, which writes no function associations, or remove the association in the CloudFront console. |
| `function HFYAppendIndex already runs the repo code on LIVE: no change` | The function runs the repository's code. |
| A `--- LIVE vs repo` diff, then `(dry-run) no changes made` | It runs other code. Publish the repository's code as in [Publish a change to the CloudFront Function](publish-the-cloudfront-function.md), which needs io's go-ahead. |

Any other `refusing:` line names its cause, such as credentials that cannot describe the function or read the distribution. That page lists them.

## A removed member still has access

**What you see.** You removed a member from the allowlist, and they can still use the site or an MCP client.

**Cause.** Removal stops new sign-ins and refreshes. It does not end what was already issued, because `hfy-api`, the data gate and the MCP server verify a token with the public key and never read the allowlist. A site session (`io_id`) or an MCP access token keeps working until it expires, up to 1 h after it was issued. The allowlist is checked again at:

- **Every sign-in,** passkeys included, once the edge instance's copy of the file is older than 300 s.
- **Every site refresh,** with the same 300 s copy. Where `authV2` resolves on, `feature-flags.js` sends `POST /auth/refresh` when the session nears its expiry and when the gate answers `401`. For a removed member, the refresh fails with `401`, clears both cookies and revokes the session's refresh family. Where `authV2` resolves off, no site script refreshes, so the member keeps the session until `io_id` expires and is refused at the next sign-in.
- **Every MCP code exchange and refresh grant,** and every `/auth/userinfo` call, with a 60 s copy.

MCP tools follow `config/groups.json`, not the allowlist, so a removed member listed there keeps their tools until their access token expires. The legacy sign-in keeps admitting the member until `hfy-check-allowed` starts new instances. While the data gate is attached, that legacy sign-in reads no family data and no `/api` route. For the full timing, see [The identity model](../explanation/identity-model.md#what-removal-does-and-does-not-do).

**Check.**

1. The published file no longer has the email. This prints `false`:

   ```bash
   aws s3 cp s3://<config-bucket>/config/userGrampsID.json - \
     | jq --arg e '<email>' 'with_entries(.key |= ascii_downcase) | has($e | ascii_downcase)'
   ```

2. Less than an hour has passed since the removal. Within that hour, continued access with an existing token is expected.
3. For the legacy path, `hfy-check-allowed` changed after the publish:

   ```bash
   aws lambda get-function-configuration --function-name hfy-check-allowed --query LastModified --output text
   ```

4. For MCP, the member is in no group. This prints `false`:

   ```bash
   aws s3 cp s3://<config-bucket>/config/groups.json - | jq --arg g '<gramps-id>' --arg e '<email>' \
     '[.groups[]? | ((.subjects // []) | index($g) != null), ((.emails // []) | map(ascii_downcase) | index($e | ascii_downcase) != null)] | any'
   ```

**Fix.**

- **The legacy path.** Recycle `hfy-check-allowed` as in [Legacy sign-in is refused with 403](#legacy-sign-in-is-refused-with-403).
- **MCP tools.** Remove the member's Gramps ID and email from `config/groups.json`, as in [Manage family access](manage-family-access.md). `hfy-api` reads the file again within 60 s, and from then on the member's token lists no tools.
- **Every edge session and MCP token now, instead of within the hour.** [Rotate the session signing key](rotate-the-session-signing-key.md), which recycles the auth edge, and then recycle `hfy-api` as in [The API returns 401 while you are signed in](#the-api-returns-401-while-you-are-signed-in), so that neither its cookie check nor its MCP server keeps the old key. Every `io_id` and MCP access token signed with the old key stops verifying, and the gate drops the old key within 300 s. Where `authV2` resolves on, this does not sign everyone out: members' pages refresh silently from the refresh cookie, and MCP clients refresh their tokens, both under the new key. The removed member's refresh is refused. Where `authV2` resolves off, nothing refreshes `io_id`, so members who signed in at `/auth/login` sign in again. Legacy sign-ins are not affected.

The removal has taken full effect when a sign-in as that member at `/auth/login` is refused as not on the access list. Where the legacy sign-in runs, a sign-in at `/family-login/` must be refused too. Run the checks in [Manage family access](manage-family-access.md#verify-a-removal).

## A flag is on but nothing changes

**What you see.** A flag is on in `flags.json` or in your preview override, and the page still shows the legacy version, or still runs old code after a deploy. The loader in [`11ty/js/feature-flags.js`](../../11ty/js/feature-flags.js) appends the island's stylesheet, `/js/islands/<name>.css?v=<sha8>`, and then its module, `/js/islands/<name>.js?v=<sha8>`. Each `?v` is the start of the file's SHA-256, stamped into `feature-flags.js` by the islands build ([Front end: Asset versions](../reference/front-end.md#asset-versions)). If the module cannot be fetched, the loader clears any preview override, and the page keeps or returns to its legacy version without telling you. Only the shell, search and notifications loaders pass an error handler: the first two restore the legacy parts they hid, and the notifications page keeps its "not enabled" text. The person and posts loaders pass none, so the page simply stays as it was. A parse or runtime error in a bundle that did load triggers no fallback: the error shows in the Console, and the page is left without the island.

Cloudflare, in front of CloudFront, keeps static files for 4 hours under the URL it first fetched, and CloudFront invalidations do not reach it. It does not cache the HTML or `/_data/flags.json`. So check files under the versioned URLs that the page uses. A bare URL such as `/js/islands/shell.js` can return a copy up to 4 hours old even after a green deploy.

**Check.**

1. **The browser sees the flag.** In the Console, run `await HFYFeatureFlags.resolveFlags()`. If the flag is not `true`:

   - Check the published value with `curl -s "$SITE/_data/flags.json" | jq .`.
   - Check the override with `sessionStorage.getItem("hfy:flags")`. It applies to one tab only, and a "preview flags on — turn off" banner shows while it is active. An entry such as `-postsV2` forces the flag off. Open `?hfy_flags=` to clear the override. If a bundle or `/auth/session` was unavailable, the loader has already cleared it and logged `[HFYFeatureFlags] preview flags turned off: ...` in the Console.

2. **You are on a page the flag changes.**

   | Flag | Page | Bundle |
   | --- | --- | --- |
   | `shellV2` | Any page | `shell` |
   | `searchV2` | `/search/` (it also turns on `shellV2`, unless the override forces `-shellV2`) | `search` |
   | `personV2` | `/person/?id=<gramps-id>` | `person` |
   | `postsV2` | `/`, `/posts/`, `/person/?id=<gramps-id>` | `timeline`, `posts`, `my-posts` |
   | `notifyV2` | `/me/notifications/` | `notifications` |
   | `navMe` | `/me/` | `settings` |

   `authV2` loads no island. It moves the person, search and photo data requests to the `io_id` cookie as soon as the flag resolves. Once `/auth/session` answers with JSON, it also makes `/family-login/` send a signed-out visitor to `/auth/login?returnTo=<path>`. `<path>` is the page's `next` parameter when that is a same-origin path outside `/auth` and `/family-login`, and `/` otherwise ([`11ty/js/auth-v2.js`](../../11ty/js/auth-v2.js)). A visitor already signed in at the edge stays on the legacy page. If `/auth/session` does not answer, the sign-in and navigation stay as they were and the preview override is cleared.

3. **The page uses versioned URLs.** List the page's script and stylesheet references that carry no version. `PAGE` is the page's path, such as `/search/`:

   ```bash
   PAGE=/search/
   curl -s "$SITE$PAGE" | grep -oE '(src|href)="/(js|css)/[^"]*"' | grep -vE '\?v=[0-9a-f]{8}"$'
   ```

   It prints nothing on a page the islands build has stamped. A line means the page was not rebuilt after an Eleventy refresh, so Cloudflare can hand it files up to 4 hours old after every deploy.

4. **The bundles are published, and current.** On the page, run this in the Console. It fetches each island's entry and stylesheet under its versioned URL, past the browser cache, and compares the bytes with the version:

   ```js
   const sha8 = async (r) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", await r.arrayBuffer()))]
     .map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 8);
   for (const [name, v] of Object.entries(HFYFeatureFlags.assetVersions.islands)) {
     for (const kind of ["js", "css"]) {
       const r = await fetch(`/js/islands/${name}.${kind}?v=${v[kind]}`, { cache: "no-store" });
       console.log(name, kind, r.status, r.headers.get("content-type"), (await sha8(r)) === v[kind] ? "current" : "STALE");
     }
   }
   ```

   Each line must show `200`, a JavaScript or CSS content type, and `current`. A `404` means the file is not in the bucket. `STALE` means the URL serves other bytes than it names. The deploy that ships them has not finished, or a request reached the new URL before it finished: CloudFront ignores the query string, so until the deploy's `/*` invalidation reaches an edge it serves the old file under the new URL, and Cloudflare then keeps those bytes for up to 4 hours.

5. **The service worker is not serving an old copy.** With `shellV2` on, the shell registers `/sw.js?v=<sha8>`. The worker fetches island entries, the theme and the manifest from the network first, and keeps a copy only for offline use. It answers chunks and fonts, whose file names carry a content hash, from its cache first ([Front end: Service worker](../reference/front-end.md#service-worker)). In DevTools, **Application > Service workers** shows the registered script, whose `?v` must equal `HFYFeatureFlags.assetVersions.sw`. If it differs, reload: the shell registers the current worker, which takes over at once and deletes the other caches. To rule the worker out, tick **Bypass for network** and reload.
6. **The island did not fail while it ran.** If the bundle loads with `200` and still nothing renders, look for an error in the Console. The loader falls back only when the file fails to load. An error inside the island does not trigger the fallback ([Front end](../reference/front-end.md)).

**Fix.** The bundles, their versions and the page stamps are committed build output, written by `cd islands && npm run build` ([Build and preview the islands](build-and-preview-the-islands.md)).

- **A missing or stale bundle, or a page without versions.** Rebuild, run `npm run check:islands`, commit everything the build changed with the source change, and merge to `main` ([Deploy a site change](deploy-a-site-change.md)). After an Eleventy refresh, rebuild before you commit ([Refresh the Eleventy output](refresh-the-eleventy-output.md)). Every push to `main` runs [`io-kit-deploy.yml`](../../.github/workflows/io-kit-deploy.yml), which syncs `11ty/` to the bucket with `--delete` and then invalidates `/*`. A bundle uploaded by hand without a commit is therefore removed by the next deploy.
- **`STALE` after the deploy finished.** Wait out Cloudflare's 4 hours, or purge the stale URLs from Cloudflare, which needs io's go-ahead.
- **An error inside an island.** Fix the island source and ship it the same way.

To confirm, reload the page in a new tab. The island renders, and `await HFYFeatureFlags.whenIsland("<bundle>")` returns `true` in the Console. [Theme and asset build](../reference/theme-and-asset-build.md) describes the versioning.

## A photo upload fails or does not show

**What you see.** The post composer on a member's own `/person/` page reports an error, or a post shows a broken image. An upload is two requests. `POST /api/uploads` returns a presigned URL and the headers to send ([`api/src/uploads.js`](../../api/src/uploads.js), [`api/src/presign.js`](../../api/src/presign.js)). Then the browser sends a `PUT` with the image straight to `<site-bucket>`, under `uploads/posts/<ulid>/` ([`islands/src/lib/upload.js`](../../islands/src/lib/upload.js)), which throws `Upload failed (HTTP <status>).` when the `PUT` fails. The `PUT` goes to the S3 endpoint, not through CloudFront, so the data gate never sees an upload. The URL signs `Content-Type` and `Content-Length`, so S3 accepts only the type and size that were presigned.

The post then shows the image from `https://<site>/uploads/posts/...` as a same-origin `<img>`, which CloudFront serves through the `/uploads/*` behavior. That behavior is in one of two states. The cutover page's [Find your starting point](cut-over-to-the-private-data-gate.md#find-your-starting-point) shows which.

- **Members only.** `add-data-gate-behaviors.sh` gated it. `hfy-edge-gate` checks the `io_id` cookie, and the `hfy-uploads-private` policy adds `Cache-Control: private, no-store` to the `nosniff` and sandbox headers, so neither Cloudflare nor a browser stores a photo. A signed-out request gets `401`, or a `302` to sign-in for a page load. The browser sends `io_id` with an `<img>`, so members see their photos.
- **Public.** [`add-uploads-behavior.sh`](../../scripts/infra/add-uploads-behavior.sh) made it, with CachingOptimized and the app stack's `UploadsResponseHeadersPolicyId`, which sets only the `nosniff` and sandbox headers. Anyone who holds a URL can read the photo, and Cloudflare caches it.

In the Network panel, find which request failed.

| Request | Result | Cause | Fix |
| --- | --- | --- | --- |
| `POST /api/uploads` | `400 validation` | The `message` names the problem: no file name, a type other than JPEG, PNG, WebP or HEIC (including no type at all), a size that is not a positive whole number, or a file over 10 MB. | Use a supported image. |
| `POST /api/uploads` | `401 unauthenticated`, or no request at all | No valid session. The islands send no `/api` call once the edge session reports signed out. | See [The API returns 401 while you are signed in](#the-api-returns-401-while-you-are-signed-in). |
| `POST /api/uploads` | `503 unavailable`, "uploads are not configured" | The handler has no presigner. The deployed [`api/src/index.js`](../../api/src/index.js) always supplies one, so the function is not running this repository's code. | Deploy `hfy-api` from `main` ([Deploy the app stack](deploy-the-app-stack.md)). |
| `PUT` to S3 | The Console reports the request was blocked by CORS policy | The bucket has no CORS rule for `PUT` from the page's origin, `https://<site>` or `https://www.<site>` | Apply the rule (below). |
| `PUT` to S3 | `400` with `BadDigest`, on every upload | `hfy-api` runs a build from before `presign.js`. That build signed a checksum of an empty body into every URL, so no real image matches it. | Deploy `hfy-api` from `main` ([Deploy the app stack](deploy-the-app-stack.md)). |
| `PUT` to S3 | `403` with `SignatureDoesNotMatch` | The `Content-Type` or the size sent differs from what was signed | A client fault. The client must send the `headers` that `POST /api/uploads` returned, with the same file. |
| `PUT` to S3 | `403` with "Request has expired" | More than 300 s passed between the presign and the `PUT` | Try again. |
| `PUT` to S3 | `403` with `AccessDenied` | The function's role does not allow the key. It may put objects only under `uploads/posts/*` in the bucket that `MediaBucket` names. A role from an older template allows `media/posts/*` instead. | Check the role (below), then deploy the stack. |
| `GET` of the photo | `401 {"error":"unauthenticated"}` | `/uploads/*` is members only, and the request carried no valid `io_id`: the viewer is signed out, the session lapsed, or a script fetched the photo without `credentials: "same-origin"`. | See [Person, search or photo data is refused (data gate)](#person-search-or-photo-data-is-refused-data-gate). |
| `GET` of the photo | `404` with `cache-control: private, no-store`, for every viewer | There is no `/uploads/*` behavior. The request fell through to the default behavior, where `HFYAppendIndex` refuses every path under `/uploads/`. | Restore the behavior (below). |
| Both requests succeed | The image is broken in the post | `MediaPublicBase` does not point at the site, `MediaBucket` is not the bucket the site is served from, or the `/uploads/*` behavior targets another origin | Check the parameters and the behavior (below). |

**Check the CORS rule, the media parameters, the role and the behavior.**

```bash
scripts/infra/check-site-bucket-cors.sh
aws cloudformation describe-stacks --stack-name <app-stack> \
  --query "Stacks[0].Parameters[?starts_with(ParameterKey, 'Media')]" --output table
aws iam get-role-policy --role-name hfy-api-role --policy-name hfy-api \
  --query "PolicyDocument.Statement[?Sid=='PostPhotoUploads'].Resource" --output text
aws cloudfront get-distribution-config --id <distribution-id> | jq -r '
  .DistributionConfig.DefaultCacheBehavior.TargetOriginId as $def
  | .DistributionConfig.CacheBehaviors.Items[] | select(.PathPattern == "/uploads/*")
  | [(if .TargetOriginId == $def then "default origin" else "other origin: \(.TargetOriginId)" end),
     (.LambdaFunctionAssociations.Items[0] // {} | "\(.EventType // "none") \(.LambdaFunctionARN // "" | split(":") | .[6:] | join(":"))"),
     .CachePolicyId, .ResponseHeadersPolicyId] | @tsv'
aws cloudformation describe-stacks --stack-name <app-stack> \
  --query "Stacks[0].Outputs[?OutputKey=='UploadsResponseHeadersPolicyId'].OutputValue" --output text
aws cloudfront list-response-headers-policies --type custom \
  --query "ResponseHeadersPolicyList.Items[].ResponseHeadersPolicy.[ResponseHeadersPolicyConfig.Name, Id]" --output text
```

- The CORS check, which sends the browser's preflight without credentials, must end with `0 failed`. Each `expected 200` line names a site origin whose uploads the bucket blocks; a bucket with no CORS configuration at all blocks both. An `expected 403, got 200` line means the bucket allows more than the committed rule.
- The role's resource must end in `/uploads/posts/*`, in the bucket that `MediaBucket` names.
- The `/uploads/*` line must start with `default origin`, the bucket's S3 origin. Then:
  - **Members only:** `viewer-request hfy-edge-gate:<n>`, `4135ea2d-6df8-44a3-9df3-4b5a84be39ad` (CachingDisabled), and the ID that the policy list gives for `hfy-uploads-private`.
  - **Public:** `none`, `658327ea-f89d-4fab-a63d-7e88639e58f6` (CachingOptimized), and the stack output's ID.
  - Any other mix means someone changed the behavior by hand. No line means the behavior is missing. Without it, an older `HFYAppendIndex` lets the default behavior serve the image without the `nosniff` and sandbox headers that keep a mislabelled upload inert, and the default-deny one answers `404`.

**Fix.**

- **CORS.** Apply [`site-bucket-cors.json`](../../infrastructure/cloudformation/site-bucket-cors.json) as in [step 1 of Stand up the static site](stand-up-the-static-site.md#1-create-the-site-bucket). `put-bucket-cors` replaces the bucket's whole CORS configuration, so find out what any other rule is for first.
- **Role, `MediaBucket` or `MediaPublicBase`.** Correct the parameter and deploy the stack, which also updates the role.
- **The `/uploads/*` behavior, where the data paths are gated.** Rerun `add-data-gate-behaviors.sh` as in the last Fix item of [the data gate section](#person-search-or-photo-data-is-refused-data-gate). It updates `/uploads/*` in place, keeping its position and origin, or creates it already gated if it is missing. The real run needs io's G-prod approval.
- **The `/uploads/*` behavior, where the data paths are not gated.** Run `add-uploads-behavior.sh`. It needs no secret, but it reads the policy ID from the stack's `UploadsResponseHeadersPolicyId` output, so pass `--stack <app-stack>`. It adds or updates `/uploads/*` on the default behavior's origin with that policy, and saves a backup first, as in the [403 fix](#every-api-or-auth-request-gets-403-forbidden). The real run needs io's go-ahead.

  ```bash
  bash scripts/infra/add-uploads-behavior.sh --stack <app-stack> --dry-run
  bash scripts/infra/add-uploads-behavior.sh --stack <app-stack>
  aws cloudfront wait distribution-deployed --id <distribution-id>
  ```

  On a gated `/uploads/*`, it changes nothing. It prints `/uploads/* is members-only (hfy-edge-gate association, add-data-gate-behaviors.sh): left as it is. add-data-gate-behaviors.sh --remove ungates it.` and then `distribution <distribution-id> already has the members-only /uploads/* behavior: no change`.

To confirm, post a photo from the composer. Both requests succeed, and the image shows in the post. In DevTools, the photo's response shows `x-content-type-options: nosniff` and `content-security-policy: sandbox; default-src 'none'; img-src 'self'`. On a gated `/uploads/*`, it also shows `cache-control: private, no-store`, with `cf-cache-status` `DYNAMIC` or `BYPASS`, and a signed-out request answers `401` with `cf-cache-status` never `HIT`:

```bash
curl -sS -o /dev/null -D - '<image-url>' | grep -iE '^(HTTP|cache-control|cf-cache-status)'
```

## No push notifications arrive

**What you see.** Members get no push notifications for new posts, replies or mentions.

**Check.**

1. **Push is on.** Signed in, run this in the Console:

   ```js
   await (await fetch("/api/notifications/vapid-public-key")).json()
   ```

   An empty `public_key` means push is off. Find out why:

   ```bash
   VAPID=$(aws cloudformation describe-stacks --stack-name <app-stack> \
     --query "Stacks[0].Parameters[?ParameterKey=='VapidSecretName'].ParameterValue" --output text)
   echo "$VAPID"
   aws logs tail /aws/lambda/hfy-api --since 1d --filter-pattern '"push disabled"'
   ```

   An empty `VapidSecretName` turns push off: subscriptions and preferences are stored, but nothing is sent. On the live stack it is `harrisonfamily/api/vapid`. If the name is set, a `push disabled` line means the secret could not be read or parsed.

2. **The secret has the right shape.** It must be JSON with `subject`, `publicKey` and `privateKey`, and `subject` must be an `https://` URL, so that no email address is sent to the push services ([API: VAPID keys](../reference/api.md#vapid-keys)). This prints the shape, not the keys:

   ```bash
   aws secretsmanager get-secret-value --secret-id "$VAPID" --query SecretString --output text \
     | jq -c '{subject_https: (.subject | type == "string" and startswith("https://")), publicKey: (.publicKey | type), privateKey: (.privateKey | type)}'
   ```

   A healthy secret prints `{"subject_https":true,"publicKey":"string","privateKey":"string"}`. A bad subject or key makes every send fail, and those failures are not logged (step 5).

3. **The recipient has a subscription.** Subscriptions are stored under `SUB#<principal>` in the stack's table:

   ```bash
   aws dynamodb query --table-name "$TABLE" \
     --key-condition-expression 'PK = :p' \
     --expression-attribute-values '{":p": {"S": "SUB#<gramps-id>"}}' \
     --select COUNT --query Count
   ```

   `0` means the member never turned on notifications on a device, or the push service reported every subscription as gone (`404` or `410`) and it was removed. The member turns notifications on at `/me/notifications/`, which needs `notifyV2`. The same page can turn off a notification type.

4. **The event notifies that member.** From [`api/src/notify.js`](../../api/src/notify.js):

   - Nobody is notified of their own action.
   - A newly published post notifies every member who has a subscription.
   - A comment notifies the author of the comment it replies to, everyone who commented earlier on the same record or post, each person mentioned as `@<gramps-id>`, and the record's person or the post's author.

5. **Sending did not fail.** `notify failed` is logged when a recipient's preferences or subscriptions could not be read. `comment notification failed` or `publish notification failed` is logged when the fan-out itself failed:

   ```bash
   aws logs tail /aws/lambda/hfy-api --since 1d --filter-pattern '?"notify failed" ?"notification failed"'
   ```

   A push service that refuses a single send is not logged, and the subscription is kept. Only a `404` or `410` from the push service removes it. So a bad VAPID subject or key pair shows up as silence, which is why step 2 checks the secret directly.

**Fix.** To turn push on, or to replace a bad secret, follow [Turn on push notifications](turn-on-push-notifications.md). The function's role may read the secret only when `VapidSecretName` is set. Each container loads the keys once, so after you repair a secret under the same name, recycle `hfy-api` as in [The API returns 401 while you are signed in](#the-api-returns-401-while-you-are-signed-in). A new secret name, as in [Replace the key pair](turn-on-push-notifications.md#replace-the-key-pair), reaches every container with the stack deploy.

To confirm, publish a test post as a member other than the recipient. A notification arrives on the recipient's subscribed device.

## An author label shows a Gramps ID instead of a name

**What you see.** A post, a comment, or a push notification names its author by Gramps ID instead of by name. The label is shown to every member, so it is never an email address (HFY-R68). `hfy-api` uses the first of these that is usable ([`api/src/labels.js`](../../api/src/labels.js), [API: Author label](../reference/api.md#author-label)):

1. The name in the session or MCP access token. A plain-string allowlist entry gives the member's email as that name, so it is rejected.
2. The person's `displayName` from `s3://<site-bucket>/person/<gramps-id>.json`.
3. The Gramps ID.

**Cause.** The person record for that Gramps ID is missing or unreadable, or its `displayName` is empty, contains `@` or is longer than 200 characters. Each `hfy-api` container caches a miss for 1 min and a name it found for 1 h. A label is stored with the post or comment when it is written, so a later fix changes only what is written after it.

**Check.** These print no name:

```bash
aws s3 cp s3://<site-bucket>/person/<gramps-id>.json - \
  | jq '.displayName | type == "string" and length > 0 and length <= 200 and (contains("@") | not)'
aws logs tail /aws/lambda/hfy-api --since 1h --filter-pattern '"author label unavailable"'
aws iam get-role-policy --role-name hfy-api-role --policy-name hfy-api \
  --query "PolicyDocument.Statement[?Sid=='PersonRecords'].Resource" --output text
```

| Finding | Meaning |
| --- | --- |
| `aws s3 cp` fails with `404` or `403` | No record is published for that Gramps ID. |
| `false` | The record has no usable `displayName`. |
| `author label unavailable (using the gramps_id)` lines | The lookup failed: S3 refused it, the 3 s timeout passed, or the record is not valid JSON. Each line names the Gramps ID and the error, so keep it private. The role cannot list the bucket, so a missing record usually shows here as `403`. |
| The role's resource is missing, or does not end in `/person/*` in the bucket that `MediaBucket` names | The role predates HFY-R68 and cannot read person records. |

**Fix.** Publish the member's person record with a `displayName` ([Refresh the family data](refresh-the-family-data.md)), or deploy the stack to update the role ([Deploy the app stack](deploy-the-app-stack.md)). Posts and comments written after that carry the name within a minute. Those already stored keep the Gramps ID.

## An MCP client cannot connect

**What you see.** An MCP client fails to add the server, the member's browser shows an error during authorization, or the token request is refused. This section covers the authorization server, the auth edge's [`auth/src/oauth.js`](../../auth/src/oauth.js). If the client is connected and the MCP server itself refuses it, see [The MCP server refuses a client](#the-mcp-server-refuses-a-client). The authorization server's settings come from three stack parameters: `McpRedirectUris`, `McpResources` and `McpCorsOrigins`. List them:

```bash
aws cloudformation describe-stacks --stack-name <app-stack> \
  --query "Stacks[0].Parameters[?starts_with(ParameterKey, 'Mcp')]" --output table
```

**Check, in order.**

1. **The server is on, and discoverable at the root.**

   ```bash
   curl -s "$SITE/auth/.well-known/oauth-authorization-server" | jq -r '.issuer // .code'
   curl -s -o /dev/null -w '%{http_code} %{content_type}\n' "$SITE/.well-known/oauth-authorization-server/auth"
   ```

   The first prints `https://<site>/auth`, and the second `200 application/json`. `NOT_FOUND` from the first means `McpRedirectUris` is empty, which turns every OAuth route off. If only the second fails, CloudFront has no root-discovery behavior: run `bash scripts/infra/add-auth-behavior.sh --stack <app-stack> --secret-name "$NAME"` as in the [403 fix](#every-api-or-auth-request-gets-403-forbidden).

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

4. **The resource matches.** The `resource` the client sends, `<resource>`, must equal an entry in `McpResources` exactly, including any path and trailing slash. When the client sends none, the first entry is used. The MCP server accepts only tokens issued for `https://<site>/mcp`, so that URL must be the first entry. An older stack may still hold `https://mcp.<site>`.

The error the client reports points to the cause. These are the ones that need a fix on this side or a fresh start. Every other error is listed under [MCP authorization server](../reference/identity-services.md#mcp-authorization-server).

| Error | Cause |
| --- | --- |
| `400` JSON, "redirect_uri is not registered", shown in the browser instead of a redirect | The client's callback is not on `McpRedirectUris`. See step 2. |
| "unknown client_id": `400 invalid_request` from `/auth/authorize`, or `401 invalid_client` from `/auth/token` or `/auth/revoke` | The client does not use the ID that `/auth/register` returns. |
| `invalid_target` | The resource is not on `McpResources`, or differs from the one authorized. See step 4. |
| `invalid_request`, "max_age must be a non-negative integer" | The client sent a `max_age` that is not a whole number of seconds. A client fault. |
| `access_denied`, "not on the family access list" | See [A member is told they are not on the access list](#a-member-is-told-they-are-not-on-the-access-list). Membership is cached for 60 s. |
| `invalid_grant`, "invalid, expired or already used code" | The code is older than 120 s, was used twice, or the token request's `redirect_uri` differs from the authorize request's. Start the flow again. |
| `invalid_grant`, "invalid or already used refresh token" | The refresh token was used twice. The edge revoked its whole family. Disconnect and connect the client again. |
| `invalid_grant`, "refresh token revoked or expired" | The refresh token is older than 30 days, or its family was revoked. Disconnect and connect the client again. |
| `invalid_grant`, "subject is no longer on the family access list" | The member was removed. |
| `503 {"error":"server_error"}` | The allowlist could not be read and no copy was ever loaded. The edge logs `oauth failure` and `allowlist unavailable`. |

**Fix.** Correct the parameter and deploy the stack ([Deploy the app stack](deploy-the-app-stack.md#4-deploy-the-stack)). Each `McpCorsOrigins` entry must be an exact `https://<host>` origin. A wildcard or a path stops the whole edge with `500 AUTH_CONFIG`.

## The MCP server refuses a client

**What you see.** The client is connected and holds a token, but calls to `https://<site>/mcp` fail with `401` or `503`, the tool list is empty, or the delete tools stay disabled. The MCP server runs inside `hfy-api` ([`api/src/mcp.js`](../../api/src/mcp.js)). It verifies the bearer token itself, and it grants tools from `config/groups.json` ([`api/src/policy.js`](../../api/src/policy.js)), never from the token's own `groups` claim. The full behavior is in [MCP server](../reference/mcp-server.md).

**Check, in order.**

1. **The server answers, and its challenge reaches the client.** Without a token:

   ```bash
   curl -s -o /dev/null -D - -X POST "$SITE/mcp" | grep -iE '^(HTTP|www-authenticate|x-amzn-remapped-www-authenticate)'
   curl -s "$SITE/.well-known/oauth-protected-resource/mcp" | jq -c '{resource, authorization_servers}'
   ```

   A healthy server answers `401` with `www-authenticate: Bearer realm="<site>", resource_metadata="https://<site>/.well-known/oauth-protected-resource", scope="openid email profile"`, and the second command prints `{"resource":"https://<site>/mcp","authorization_servers":["https://<site>/auth"]}`.

   | Finding | Cause |
   | --- | --- |
   | `x-amzn-remapped-www-authenticate` and no `www-authenticate` | `hfy-mcp-edge401` is not attached. A Lambda Function URL renames the header, and only that function, on the behavior's `origin-response`, restores it. Without it, a client cannot find the authorization server from the `401`. |
   | `403` | See [Every /api or /auth request gets 403 forbidden](#every-api-or-auth-request-gets-403-forbidden). |
   | Any other status, or an HTML body | No `/mcp*` behavior. Another behavior serves the request. |

   To see what is attached, by function name and version only:

   ```bash
   aws cloudfront get-distribution-config --id <distribution-id> | jq -r '
     .DistributionConfig.CacheBehaviors.Items[]
     | select(.PathPattern | startswith("/mcp") or startswith("/.well-known/oauth-protected-resource"))
     | [.PathPattern, (.LambdaFunctionAssociations.Items[0] // {} | "\(.EventType // "none") \(.LambdaFunctionARN // "" | split(":") | .[6:] | join(":"))")] | @tsv'
   ```

   Both `/mcp*` and `/.well-known/oauth-protected-resource*` show `origin-response hfy-mcp-edge401:<n>`.

2. **The token is valid for this server.** Get an access token for the member as in [Run the tests](run-the-tests.md#7-run-the-mcp-token-smoke-check-live), then run [`scripts/mcp/token-smoke.sh`](../../scripts/mcp/token-smoke.sh):

   ```bash
   read -rs MCP_TOKEN && export MCP_TOKEN   # paste the token; nothing is echoed
   scripts/mcp/token-smoke.sh
   unset MCP_TOKEN
   ```

   The script checks the authorization server's metadata, then the token's signature against the live JWKS, its `kid`, `iss`, `aud`, `sub`, `groups` and expiry. Its default `--audience` is `https://<site>/mcp`, the audience the MCP server requires, and its default `--base` is `https://<site>/auth`. Each check prints `ok` or `FAIL`. A token that fails signature, issuer, audience or expiry verification stops the script with a `jose` error instead, such as `unexpected "aud" claim value`. The script expects the `kid` `hfy-session-1`, so after a rotation to a new `kid` it fails on that line even for a good token. Its output includes the token's `sub`, a Gramps ID, so keep it private.

3. **Read the server's view.** The MCP server logs one `mcp.edge.request` line per request, with a hash of the `sub`, never the `sub`:

   ```bash
   aws logs tail /aws/lambda/hfy-api --since 30m --filter-pattern '"mcp.edge.request"'
   ```

   A refused request has `outcome` `deny` and a `reason`: `missing_token`, `malformed_token`, `unsupported_alg`, `unknown_kid`, `bad_signature`, `wrong_issuer`, `expired`, `bad_token_use`, `binding_mismatch` or `jwks_unavailable`. The audience check runs after this line is written, so a token for the wrong resource logs `allow` and is still refused (first row below).

4. **The caller is in the right group.** This prints three booleans and no names:

   ```bash
   aws s3 cp s3://<config-bucket>/config/groups.json - | jq --arg g '<gramps-id>' --arg e '<email>' '{
     author_by_id: ((.groups["mcp-authors"].subjects // []) | index($g) != null),
     author_by_email: ((.groups["mcp-authors"].emails // []) | map(ascii_downcase) | index($e | ascii_downcase) != null),
     admin: ((.groups["hfy-admin"].subjects // []) | index($g) != null)}'
   aws logs tail /aws/lambda/hfy-api --since 1h --filter-pattern '"groups config unavailable"'
   ```

   A `jq` parse error, or an `aws s3 cp` error, means the file is not JSON or cannot be read, and the log then shows `groups config unavailable (failing closed)`. `mcp-authors` matches by Gramps ID or by the token's `email` claim. `hfy-admin` matches by Gramps ID only. `config/admins.json` plays no part here, and may be absent.

| What the client gets | Cause | Fix |
| --- | --- | --- |
| `401`, `invalid_token`, "token not issued for this resource" | The token's `aud` is not `https://<site>/mcp`. Usually `McpResources` still holds its old value, `https://mcp.<site>`, so the authorization server issues tokens for that resource. `token-smoke.sh` stops with `unexpected "aud" claim value`. | Make `https://<site>/mcp` the first entry of `McpResources`, deploy the stack, and disconnect and connect the client again. A refreshed token keeps the old audience. |
| `401`, `invalid_token`, "signing key not found" | The token was signed under a key the edge no longer publishes, after a rotation. | The client's refresh gets a token under the new key. If it does not refresh, reconnect it. |
| `401`, `invalid_token`, "token expired or not yet valid" | Access tokens last 3600 s, and the client did not refresh. | If its refresh fails, see the `invalid_grant` rows in [An MCP client cannot connect](#an-mcp-client-cannot-connect). |
| `401`, `invalid_token`, "issuer mismatch" | The token's `iss` is not the stack's `SessionIssuer`, which the MCP server pins. The auth edge mints the manifest's `session.issuer`. | Make `SessionIssuer` equal the manifest's `session.issuer`, and deploy the stack. |
| `401`, `invalid_token`, "token not issued to this client" or "unsupported token use" | The bearer is not an MCP access token from `/auth/token`, for example a site session token. | A client fault. |
| `401 {"error":"unauthorized"}` | No `Authorization: Bearer` header reached the server. | A client fault. |
| `503 {"error":"temporarily_unavailable"}` with `Retry-After: 5` | `hfy-api` could not fetch the JWKS, while it held no keys or while it looked up a `kid` it did not know. | Run [Start with four requests](#start-with-four-requests) and fix the auth edge. |
| `tools/list` returns no tools, and `_meta.reason.code` is `not_in_group` | The caller is in neither `mcp-authors` nor `hfy-admin`, or `groups.json` is missing or cannot be read or parsed, which puts nobody in any group. An email entry matches only when the token carries an `email` claim. A connection made before the auth edge added that claim (HFY-R64) keeps a token without it through every refresh. | Fix `config/groups.json` ([Manage family access](manage-family-access.md)), wait 60 s, and list the tools again. For an email entry on an old connection, reconnect the client. |
| The delete tools are listed with `disabled: true` and `reason.code` `step_up_required`, or a delete returns `isError` with that reason | The token shows no recent sign-in that verified the member: its `amr` has no `mfa`, or its `auth_time` is more than 300 s old, or `0`. | Follow [Run an admin delete](connect-an-mcp-client.md#3-run-an-admin-delete). |
| JSON-RPC error `-32602`, `Unknown tool: <name>` | The caller may not see that tool, or the name is wrong. The server answers the same for both. Only `hfy-admin` sees the delete tools. | Add the Gramps ID to the `subjects` of `hfy-admin`. An email there does not count. |
| JSON-RPC error `-32602`, `Invalid params: ...` | The call has no `name`, its `arguments` is not an object, or `mode` is not `dry_run` or `execute`. | A client fault. |

**`/auth/userinfo`.** Some clients call it to confirm the member. To see what it answers for a token:

```bash
read -rs MCP_TOKEN   # paste the token; nothing is echoed
curl -s -H @- "$SITE/auth/userinfo" <<<"Authorization: Bearer $MCP_TOKEN" | jq -c '{groups, error}'
unset MCP_TOKEN
```

The token is read from standard input, so it never appears on the command line. A healthy answer has `groups`, the allowlist groups such as `members`, not the MCP tool groups.

- **`401` with `{"error":"invalid_token"}`:** the token is expired, was signed under a key the edge no longer holds, names a resource that is not on `McpResources`, is not an access token, or belongs to a member who is no longer on the allowlist. `/auth/userinfo` checks membership on every call, with a 60 s cache.
- **`503` with `{"error":"server_error"}`:** the edge could not read the allowlist and has never loaded it. It logs `oauth failure` and `allowlist unavailable`.

**Fix.**

- **The 401 restore is missing.** Deploy `hfy-mcp-edge401` as in [Deploy the edge functions](deploy-the-edge-functions.md#1-deploy-the-mcp-401-restore-function), then attach it. The script reads the Function URL from `<app-stack>` and the function's version from the `hfy-mcp-edge401` stack in `us-east-1`. `$NAME` is the origin-verify secret, from step 1 of the [403 check](#every-api-or-auth-request-gets-403-forbidden):

  ```bash
  bash scripts/infra/add-mcp-behavior.sh --stack <app-stack> --secret-name "$NAME" --dry-run
  bash scripts/infra/add-mcp-behavior.sh --stack <app-stack> --secret-name "$NAME"
  aws cloudfront wait distribution-deployed --id <distribution-id>
  ```

  It exits with status 3 when an earlier behavior already matches `/mcp` or `/.well-known/oauth-protected-resource` and would shadow the new one. Like the other behavior scripts, it saves a backup before it changes anything.
- **Any other cause.** Apply the fix in its row above.

## Verify the fix

1. Run the check from the section you used again. It now gives the healthy result that section describes, and the section's closing check succeeds where it has one.
2. Run [Start with four requests](#start-with-four-requests) again.
3. Run the end-to-end check that covers the path you fixed. Do the one-time setup in [Run the tests](run-the-tests.md) first.

   - **Sign-in:** the `auth-v2` Playwright spec, against production. It signs in as a real test account, so it needs io's go-ahead. Run it in a subshell, with terminal output and one browser:

     ```bash
     (
       cd tests/login-flow
       export HFY_SITE_BASE="$SITE" HFY_AUTH_V2=1
       export HFY_TEST_EMAIL=<test-email> HFY_EXPECT_GRAMPS=<gramps-id>
       read -rs HFY_TEST_PASSWORD && export HFY_TEST_PASSWORD   # type the password; nothing is echoed
       npx playwright test tests/auth-v2.spec.ts --reporter=list --project=chromium --grep-invert "offers both paths"
     )
     (cd tests/login-flow && rm -rf playwright-report test-results logs)
     ```

     It checks the `/family-login/` redirect, the published JWKS, the signed-out session, and a password sign-in whose `sub` matches `HFY_EXPECT_GRAMPS`. `--grep-invert` leaves out its test of the login page's Google and password paths. That test expects exactly two `section.path` elements, and the passkey-enabled edge renders four, so it fails on a healthy site ([Run the tests: authV2 sign-in](run-the-tests.md#authv2-sign-in)). Its redirect test passes only while the published `flags.json` has `authV2` set to `true`. Where it is `false`, use the legacy spec instead ([Run the tests](run-the-tests.md#legacy-sign-in)).
   - **The sign-in pages' look:** checks 4 and 5 of [Deploy the app stack: Verify](deploy-the-app-stack.md#verify).
   - **The data gate and member photos:** the signed-out and signed-in checks in [Verify](cut-over-to-the-private-data-gate.md#verify) on the cutover page.
   - **MCP:** `token-smoke.sh` with a fresh token, as in check 2 of [The MCP server refuses a client](#the-mcp-server-refuses-a-client), then list the tools from the client.

## Related pages

- [The identity model](../explanation/identity-model.md): why sign-in resolves to a Gramps ID, why the legacy path is still deployed, why removal is not instant, and why a delete through MCP needs a fresh step-up.
- [Edge and origin design](../explanation/edge-and-origin-design.md): CloudFront in front of both functions, the origin-verify header, the two Lambda@Edge functions, why `HFYAppendIndex` also denies, and why static URLs carry a version.
- [The privacy model for family data](../explanation/family-data-privacy.md): why the data paths and member photos are gated at the edge and never stored by a shared cache.
- [Islands on Eleventy](../explanation/islands-on-eleventy.md) and [The release model](../explanation/release-model.md): why new surfaces load behind flags and fall back.
- [How member content stays accountable](../explanation/member-content-design.md#labels-that-never-publish-an-address): why an author label is never an email.
- [Identity services](../reference/identity-services.md), [API reference](../reference/api.md), [MCP server](../reference/mcp-server.md) and [Front end](../reference/front-end.md): every route, status code, log line and fallback.
- [Theme and asset build](../reference/theme-and-asset-build.md): the sign-in stylesheet, the `?v=` versions and the stamps the islands build writes.
- [Repository operations](../reference/repository-operations.md#cloudfront-behavior-scripts): what the CloudFront behavior scripts change, their output and their exit status.
- [Private data and secrets](../reference/private-data-and-secrets.md): where the allowlist, the groups file and the secrets live.
- [Manage family access](manage-family-access.md), [Rotate the origin-verify secret](rotate-the-origin-verify-secret.md), [Rotate the session signing key](rotate-the-session-signing-key.md), [Rotate the Google client](rotate-the-google-client.md), [Deploy the app stack](deploy-the-app-stack.md), [Deploy the edge functions](deploy-the-edge-functions.md), [Cut over to authV2 and the private data gate](cut-over-to-the-private-data-gate.md), [Publish a change to the CloudFront Function](publish-the-cloudfront-function.md), [Roll back a site deploy](roll-back-a-site-deploy.md), [Build and preview the islands](build-and-preview-the-islands.md), [Connect an MCP client](connect-an-mcp-client.md), [Turn on push notifications](turn-on-push-notifications.md), [Toggle a feature flag](toggle-a-feature-flag.md), [Run the tests](run-the-tests.md).
