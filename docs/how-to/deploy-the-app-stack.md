# How to deploy the app stack and its CloudFront behaviors

Use this page to create or update the `hfy-app` CloudFormation stack, to route `/auth/*` and `/api/*` to it through CloudFront, to serve member photos under `/uploads/*`, and to apply the CORS rule that lets browsers upload them. Follow it for a first deploy and for every change to `api/` or `auth/`. Changes to `11ty/` ship another way: see [Deploy a site change](deploy-a-site-change.md).

The stack, built from [`app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml), holds the DynamoDB table `hfy-app`, the Cognito user pool `hfy-users`, and two Lambda functions behind Function URLs: `hfy-api`, the member API, and `hfy-auth-edge`, which handles sign-in and sessions. The secrets, the code packages, the CloudFront behaviors and the bucket CORS rule all live outside the stack, so a first deploy takes seven steps instead of one. [Architecture](../reference/architecture.md#hfy-app) lists every resource, parameter and output.

> **Operator credentials only.** The GitHub deploy role cannot run any of this. Its policy in [`github-roles.yaml`](../../infrastructure/cloudformation/github-roles.yaml) allows a sync to the site bucket, CloudFront invalidations, and code, version and alias updates on three named functions, but no CloudFormation, IAM, Cognito or distribution change. No workflow builds or deploys `hfy-api` or `hfy-auth-edge`. [The release model](../explanation/release-model.md#why-the-deploy-role-is-narrow) explains why.

Values in angle brackets, such as `<site>`, `<code-bucket>`, `<config-bucket>`, `<site-bucket>`, `<distribution-id>`, `<google-web-client-id>` and `<user-pool-id>`, are placeholders. [Private data and secrets](../reference/private-data-and-secrets.md#placeholders) lists them.

## Before you start

- **io's go-ahead.** CloudFormation deploys of `hfy-app` need it, because the table and the user pool hold members' data ([`AGENTS.md`](../../AGENTS.md)).
- **Operator AWS credentials.** They must be able to:
  - deploy CloudFormation with named IAM roles, covering IAM, Lambda, DynamoDB, Cognito and CloudWatch Logs. CloudFormation acts with these credentials, so they also need `s3:GetObject` on the packages in `<code-bucket>`, because Lambda fetches the code with the caller's permissions. They also need `secretsmanager:GetSecretValue` on the origin-verify secret, which the stack resolves at deploy time.
  - create and read Secrets Manager secrets.
  - write to `<code-bucket>`. The bucket must be in `us-west-2`, the functions' region, because Lambda loads code only from a bucket in its own region.
  - get a CodeArtifact token, which takes `codeartifact:GetAuthorizationToken` and `sts:GetServiceBearerToken`.
  - read the configuration of `hfy-api` and `hfy-auth-edge` (`lambda:GetFunctionConfiguration`), for the secret check in step 5.
  - read and update the CloudFront distribution.
  - read and put the CORS configuration of `<site-bucket>`.

  Set the region for the shell:

  ```sh
  export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2
  ```

  The secret scripts default to `us-west-2`. The behavior scripts take no region. They read the stack outputs and the origin-verify secret from the shell's default region.
- **Tools.** The AWS CLI, `jq`, `openssl`, `zip`, `unzip`, `curl`, and Node.js 22 with npm.
- **Somewhere outside the repository for distribution backups.** Before each real update, the behavior scripts save the distribution configuration, origin-verify value included, to `${HFY_CF_BACKUP_DIR:-~/.local/state/hfy-infra/cloudfront}`, mode 600. Keep that directory private.
- **A CodeArtifact token in the shell.** The `@io-kit/*` packages come from a private registry, and both package scripts stop if `CODEARTIFACT_AUTH_TOKEN` is unset:

  ```sh
  export CODEARTIFACT_AUTH_TOKEN="$(aws codeartifact get-authorization-token --domain io --query authorizationToken --output text)"
  ```

  Do not echo the token or write it to a file. It expires after 12 hours by default.
- **The access configuration in `<config-bucket>`.** The stack does not create it. The auth edge resolves every sign-in against `config/userGrampsID.json`. `hfy-api` and the edge's MCP membership read `config/admins.json`. Check that both objects exist without reading them:

  ```sh
  for k in config/userGrampsID.json config/admins.json; do
    aws s3api head-object --bucket <config-bucket> --key "$k" >/dev/null && echo "$k present"
  done
  ```

  If one is missing, follow [Manage family access](manage-family-access.md).
- **`<google-web-client-id>`.** This is the Google OAuth web client ID, the same value as the `HFY_GOOGLE_CLIENT_ID` repository secret. The stack requires it as `GoogleClientId` and has no default.
- **A clean checkout of the commit to deploy.** Step 3 names the uploads after the commit, so `git status --short` must print nothing. The `api/` and `auth/` suites should pass ([Run the tests](run-the-tests.md)).

Run every command on this page from the repository root.

## Steps

Every step is safe to re-run. The secret scripts report `no change` when the secret exists. Repeating step 4 with the same keys changes nothing. The behavior scripts print `no change` and make no update when the distribution already matches. Re-applying the same CORS file leaves the same rule.

On a code-only update, run steps 2 to 4, then [Verify](#verify). Run steps 5 and 6 on a first deploy, and again only when a function's URL or the uploads policy changes. Run step 7 only when the CORS file changes.

### 1. Create the secrets

The stack depends on two Secrets Manager secrets that no stack manages. Each script generates its value locally, never prints it, and never replaces an existing secret. Preview each one with `--dry-run`, then run it for real.

```sh
scripts/infra/create-session-key.sh --dry-run
scripts/infra/create-session-key.sh
scripts/infra/create-origin-verify.sh --dry-run
scripts/infra/create-origin-verify.sh
```

- [`create-session-key.sh`](../../scripts/infra/create-session-key.sh) creates `harrisonfamily/auth-edge/session-signing-key`, the auth edge's signing key. Its key ID is `hfy-session-1` unless you pass `--kid <kid>`.
- [`create-origin-verify.sh`](../../scripts/infra/create-origin-verify.sh) creates `harrisonfamily/cloudfront/origin-verify`, the header value CloudFront sends to both functions.

A dry run prints `(dry-run) would ...`. A real run prints `created secret <name> ... in us-west-2`. Either one prints `secret <name> already exists in us-west-2: no change` if the secret is already there. To replace a secret, use [Rotate the session signing key](rotate-the-session-signing-key.md) or [Rotate the origin-verify secret](rotate-the-origin-verify-secret.md). [Private data and secrets](../reference/private-data-and-secrets.md#secrets-manager) describes both secrets and who reads them.

The origin-verify secret must exist before step 4, or the deploy fails.

### 2. Build the packages

```sh
scripts/ci/package-api.sh
scripts/ci/package-auth.sh
```

Both scripts install from the committed lockfile into a temporary directory, so they need no `npm ci` in `api/` or `auth/` first. [`package-api.sh`](../../scripts/ci/package-api.sh) also generates `dist/caps.json` there, from the packages it just installed, and stops if that fails.

Each script prints `built <repo>/dist/<name>.zip (<size>)`, for `hfy-api.zip` and `hfy-auth-edge.zip`. `dist/` is gitignored.

Check that the files the handlers load are in place:

```sh
unzip -l dist/hfy-api.zip src/index.js dist/caps.json
unzip -l dist/hfy-auth-edge.zip src/index.js edge.manifest.json
```

Each listing names both files and ends with a total of `2 files`. `1 file` means the package is missing one of them. Rebuild it before you go on. For what each package contains, see [API: Packaging and deploy](../reference/api.md#packaging-and-deploy) and [Identity services: Runtime and mount](../reference/identity-services.md#runtime-and-mount).

### 3. Upload the packages under unique keys

```sh
SHA="$(git rev-parse --short=12 HEAD)"
aws s3 cp dist/hfy-api.zip "s3://<code-bucket>/lambda/hfy-api-$SHA.zip"
aws s3 cp dist/hfy-auth-edge.zip "s3://<code-bucket>/lambda/hfy-auth-edge-$SHA.zip"
```

Check that each object has the size of the local zip:

```sh
for f in hfy-api hfy-auth-edge; do
  echo "$f: local $(wc -c < "dist/$f.zip" | tr -d ' '), uploaded $(aws s3api head-object \
    --bucket <code-bucket> --key "lambda/$f-$SHA.zip" --query ContentLength --output text)"
done
```

Each line shows the same number twice. Keep `SHA` set in this shell for step 4. Do not upload to the stack's default keys, `lambda/hfy-api.zip` and `lambda/hfy-auth-edge.zip`. The next step explains why.

### 4. Deploy the stack

```sh
aws cloudformation deploy \
  --stack-name hfy-app \
  --template-file infrastructure/cloudformation/app-stack.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    CodeBucket=<code-bucket> \
    CodeKey="lambda/hfy-api-$SHA.zip" \
    AuthCodeKey="lambda/hfy-auth-edge-$SHA.zip" \
    GoogleClientId=<google-web-client-id>
```

- `CAPABILITY_NAMED_IAM` is required because the template names its roles, `hfy-api-role` and `hfy-auth-edge-role`.
- On a first deploy, every parameter you leave out takes its template default. `ConfigBucket` and `MediaBucket` default to the production `<config-bucket>` and `<site-bucket>`. `VapidSecretName` defaults to empty, so notifications are stored but no push is sent ([Turn on push notifications](turn-on-push-notifications.md)). `SesIdentityArn` defaults to empty, so Cognito sends verification and reset email from its default sender, which allows about 50 emails a day for the account. To send through SES instead, pass a verified SES identity ARN in the same region as `SesIdentityArn`, and optionally `SesFromAddress`.
- On an update, a parameter you leave out keeps the stack's current value. To change one, add it to `--parameter-overrides`. [Architecture](../reference/architecture.md#parameters) lists the parameters.
- The command waits for the stack to finish and reports success or failure. If it fails, see [If the deploy fails](#if-the-deploy-fails).

> **Gotcha: re-uploading to a fixed key changes nothing.** CloudFormation updates a function's code only when `CodeBucket`, `CodeKey` or `AuthCodeKey` changes. If you upload a new zip over an existing key and deploy again, the stack sees no change and the functions keep the old code. `aws cloudformation deploy` then reports that there are no changes to deploy and exits non-zero. Use a new key for every build, as in step 3. For a code-only fix you can instead point a function at the new object directly:
>
> ```sh
> aws lambda update-function-code --function-name hfy-api \
>   --s3-bucket <code-bucket> --s3-key "lambda/hfy-api-$SHA.zip"
> ```
>
> The stack's `CodeKey` then no longer names the running code, until a later stack deploy changes it. Prefer a stack deploy, so that the stack parameters record which build is live.

### 5. Route `/auth/*` and `/api/*` through CloudFront

Run this step on a first deploy. Run it again only when a stack change replaces a function, for example a new `FunctionName` or `AuthFunctionName`, because that gives the function a new Function URL. A code-only update keeps both Function URLs, so skip this step. To change the secret that CloudFront sends, follow [Rotate the origin-verify secret](rotate-the-origin-verify-secret.md) instead.

Each script adds one Function URL to the distribution as an HTTPS custom origin that sends the origin-verify secret as `X-Origin-Verify`, plus that origin's path behaviors. The scripts read the URLs from the `hfy-app` stack outputs, `AuthFunctionUrl` and `FunctionUrl`, and redact the header value in every diff they print. Both default to the production distribution, so pass `--distribution` to make the target explicit. [Repository operations](../reference/repository-operations.md#cloudfront-behavior-scripts) describes what a run does and every message it prints.

| Script | Origin | Behaviors |
| --- | --- | --- |
| [`add-auth-behavior.sh`](../../scripts/infra/add-auth-behavior.sh) | `hfy-auth-origin` | `/auth/*`, `/.well-known/oauth-authorization-server*` |
| [`add-api-behavior.sh`](../../scripts/infra/add-api-behavior.sh) | `hfy-api-origin` | `/api/*`, plus the legacy pin `/api/check-allowed*` on the origin that served `/api/check-allowed` before |

#### Check the secret the scripts will send

The scripts write whatever value the secret holds now. The functions hold the value that CloudFormation resolved when it last updated them. Compare the two by hash before you change the distribution. Neither value is printed.

```sh
unset ORIGIN_VERIFY
OV_NAME="$(aws cloudformation describe-stacks --stack-name hfy-app \
  --query "Stacks[0].Parameters[?ParameterKey=='OriginVerifySecretName'].ParameterValue" --output text)"
WANT="$(aws secretsmanager get-secret-value --secret-id "$OV_NAME" \
  --query SecretString --output text | openssl dgst -sha256)"
for f in hfy-auth-edge hfy-api; do
  HAVE="$(aws lambda get-function-configuration --function-name "$f" \
    --query Environment.Variables.ORIGIN_VERIFY --output text | openssl dgst -sha256)"
  if [ "$HAVE" = "$WANT" ]; then echo "$f: matches $OV_NAME"; else echo "$f: DIFFERS from $OV_NAME"; fi
done
```

Both lines must say `matches`. If either says `DIFFERS`, or any command prints an error, stop. Applying the scripts would then send a value the functions reject, and every request through that origin would return `403`. Follow [Rotate the origin-verify secret](rotate-the-origin-verify-secret.md) instead. Keep `ORIGIN_VERIFY` unset, because the scripts use it in preference to the secret. Pass `--secret-name "$OV_NAME"` to every script run below, so that the scripts read the secret the stack uses even after a rotation.

#### Add the auth behaviors

Add the auth behaviors first. `hfy-api` verifies every session against the edge's public keys at `https://<site>/auth/.well-known/jwks.json` (stack parameter `SessionJwksUrl`), which it fetches back through CloudFront. Until `/auth/*` is routed, the API cannot accept any session.

```sh
scripts/infra/add-auth-behavior.sh --distribution <distribution-id> --secret-name "$OV_NAME" --dry-run
scripts/infra/add-auth-behavior.sh --distribution <distribution-id> --secret-name "$OV_NAME"
```

On a first deploy, the dry-run diff only adds `hfy-auth-origin` and its two behaviors and raises the matching `Quantity` counts. On a re-run against a correct distribution, it prints `distribution <distribution-id> already has ...: no change` and stops. The real run prints where it saved the pre-change configuration, a rollback command, and the distribution status, `InProgress`.

#### Add the API behavior and the legacy pin

While `authV2` is off, every visitor signs in through the legacy page, which posts to `/api/check-allowed` on the `hfy-check-allowed` API Gateway. `add-api-behavior.sh` keeps that path there: before it points `/api/*` at `hfy-api`, it clones whichever behavior serves `/api/check-allowed` under the pattern `/api/check-allowed*` and orders it ahead of `/api/*` (HFY-R58). [Edge and origin design](../explanation/edge-and-origin-design.md#one-origin-for-the-browser) explains why the path needs its own behavior.

```sh
scripts/infra/add-api-behavior.sh --distribution <distribution-id> --secret-name "$OV_NAME" --dry-run
```

Read the dry run:

- A line `legacy /api/check-allowed stays on origin <origin-id> via /api/check-allowed* (ordered before /api/*; retired by HFY-TSK-069)`. `<origin-id>` must be the legacy API Gateway origin, never `hfy-api-origin`.
- Two `cache behaviors ... (in evaluation order)` lines. In the `after` line, `/api/check-allowed* -> <origin-id>` comes before `/api/* -> hfy-api-origin`.
- A diff that touches only `hfy-api-origin`, `/api/*` and, on the first run, the new pin.

If the script stops with exit status `3` and a message that starts with `refusing:`, it could not tell which origin serves the legacy path, for example because `/api/*` already points at `hfy-api` and no pin exists. Find the legacy API Gateway origin:

```sh
aws cloudfront get-distribution-config --id <distribution-id> \
  --query "DistributionConfig.Origins.Items[?contains(DomainName, 'execute-api')].Id" --output text
```

If it prints one origin ID, add `--legacy-origin <origin-id>` to both the dry run and the real run. If it prints nothing, the legacy origin is gone and there is nothing to pin to: stop and find out how `/api/check-allowed` is served before you go on.

Then apply it and wait for the distribution:

```sh
scripts/infra/add-api-behavior.sh --distribution <distribution-id> --secret-name "$OV_NAME"
aws cloudfront wait distribution-deployed --id <distribution-id>
```

The `wait` command returns with no output once the distribution is deployed. If it times out, run it again.

Two messages mean stop:

- `cannot read secret <name>` on a real run, or `(dry-run) origin-verify secret not read; using a placeholder` on a dry run. The script could not read `$OV_NAME`. Check the name, the region and your `GetSecretValue` permission.
- `unknown arg ...`: a flag is misspelled.

To undo a behavior change, run the rollback command the script printed, with the distribution's current ETag from `aws cloudfront get-distribution-config --id <distribution-id> --query ETag --output text`. The backup file holds the origin-verify value, so delete it once you no longer need it.

### 6. Serve member photos under `/uploads/*`

Member photos are uploaded to `uploads/posts/` in `<site-bucket>`. [`add-uploads-behavior.sh`](../../scripts/infra/add-uploads-behavior.sh) serves that prefix from the bucket's S3 origin with the stack's `UploadsResponseHeadersPolicy`, which adds `X-Content-Type-Options: nosniff` and a sandboxing Content-Security-Policy (HFY-R58). It reads the policy ID from the stack output `UploadsResponseHeadersPolicyId` and uses the default behavior's origin unless you pass `--origin-id`.

```sh
scripts/infra/add-uploads-behavior.sh --distribution <distribution-id> --dry-run
scripts/infra/add-uploads-behavior.sh --distribution <distribution-id>
aws cloudfront wait distribution-deployed --id <distribution-id>
```

The dry run prints `serving /uploads/* from origin <origin-id> with response headers policy <policy-id>`, and its diff adds only the `/uploads/*` behavior. `origin '<id>' is not in distribution ...` means the default behavior's origin was not found: pass the S3 origin's ID with `--origin-id`.

### 7. Apply the photo-upload CORS rule

Browsers upload post photos straight to `<site-bucket>`, using presigned `PUT` URLs that `hfy-api` issues, so the bucket needs a CORS rule. No stack manages the bucket. The rule is in [`media-bucket-cors.json`](../../infrastructure/cloudformation/media-bucket-cors.json). That file also carries a `_comment` key, which the AWS CLI rejects as an unknown parameter, so strip it before you apply the rule.

`put-bucket-cors` replaces the bucket's whole CORS configuration. Look at the current configuration first:

```sh
aws s3api get-bucket-cors --bucket <site-bucket>
```

A `NoSuchCORSConfiguration` error means there is none. If the output shows rules that are not in the file, add them to your stripped copy before you apply it, or they are lost.

```sh
CORS="$(mktemp)"
jq 'del(._comment)' infrastructure/cloudformation/media-bucket-cors.json > "$CORS"
aws s3api put-bucket-cors --bucket <site-bucket> --cors-configuration "file://$CORS"
rm -f "$CORS"
```

The `postsV2` flag depends on this rule ([Toggle a feature flag](toggle-a-feature-flag.md)). Apply it once, and again only when the file changes.

## Verify

None of these checks needs a session or prints a secret.

1. **The stack is complete and runs this build.**

   ```sh
   aws cloudformation describe-stacks --stack-name hfy-app --query 'Stacks[0].StackStatus' --output text
   aws cloudformation describe-stacks --stack-name hfy-app \
     --query "Stacks[0].Parameters[?ParameterKey=='CodeKey' || ParameterKey=='AuthCodeKey'].ParameterValue" --output text
   ```

   The first command prints `CREATE_COMPLETE` or `UPDATE_COMPLETE`. The second prints both keys, each ending in `-$SHA.zip` for the commit you deployed.
2. **The auth edge publishes its key.**

   ```sh
   curl -s https://<site>/auth/.well-known/jwks.json | jq -r '.keys[].kid'
   ```

   The command prints the key ID from step 1, `hfy-session-1` unless you chose another. A `jq` error, such as `Cannot iterate over null` or a parse error, means the response was not a key set. To see what came back, run:

   ```sh
   curl -s -w '\n%{http_code}\n' https://<site>/auth/.well-known/jwks.json
   ```

   - `{"code":"AUTH_CONFIG"}` and `500`: the edge could not start, most often because it cannot read the signing key.
   - `{"error":"forbidden"}` and `403`: the header the distribution sends does not match the edge's `ORIGIN_VERIFY`.
   - Anything else, such as an error page from the site bucket: the `/auth/*` behavior is missing or not yet deployed.
3. **Root discovery reaches the edge.**

   ```sh
   curl -s https://<site>/.well-known/oauth-authorization-server/auth | jq -r .issuer
   ```

   The command prints `https://<site>/auth`, which also proves the `/.well-known/oauth-authorization-server*` behavior. `null` means the edge answered `404 {"code":"NOT_FOUND"}`, which it does when `McpRedirectUris` is empty and MCP OAuth is off.
4. **The API answers through CloudFront.**

   ```sh
   curl -s -w '\n%{http_code}\n' https://<site>/api/posts
   ```

   The command prints `{"error":"unauthenticated","message":"sign in required"}` and `401`. That shows CloudFront reached `hfy-api` with the right header and the request got as far as the session check. Other results:

   - `{"error":"forbidden"}` and `403`: the header the distribution sends does not match the function's `ORIGIN_VERIFY`. See [Diagnose sign-in and API failures](diagnose-sign-in-and-api-failures.md#every-api-or-auth-request-gets-403-forbidden).
   - A body with only a `message` key, such as `{"message":"Not Found"}` or `{"message":"Missing Authentication Token"}`: API Gateway answered, so `/api/*` still targets the legacy origin. Run [Add the API behavior](#add-the-api-behavior-and-the-legacy-pin), or wait for the distribution to finish deploying.
   - An error page from the site bucket: no `/api/*` behavior exists.
   - A `5xx` status: CloudFront reached `hfy-api`, but the function failed, for example because a module is missing from the package. Read its log with `aws logs tail /aws/lambda/hfy-api --since 15m`, then rebuild and redeploy from step 2.
5. **The Function URLs refuse direct calls.**

   ```sh
   API_URL="$(aws cloudformation describe-stacks --stack-name hfy-app \
     --query "Stacks[0].Outputs[?OutputKey=='FunctionUrl'].OutputValue" --output text)"
   AUTH_URL="$(aws cloudformation describe-stacks --stack-name hfy-app \
     --query "Stacks[0].Outputs[?OutputKey=='AuthFunctionUrl'].OutputValue" --output text)"
   curl -s -w ' %{http_code}\n' "${API_URL}api/posts"
   curl -s -w ' %{http_code}\n' "${AUTH_URL}auth/session"
   ```

   Both lines print `{"error":"forbidden"} 403`. The Function URLs use AuthType `NONE`, so this header check is the only thing that stops callers from bypassing CloudFront.
6. **The legacy sign-in route survived.**

   ```sh
   curl -s -w ' %{http_code}\n' -X POST -H 'content-type: application/json' -d '{}' \
     https://<site>/api/check-allowed
   ```

   The command prints `{"allowed":false,"error":"missing id_token"} 400`. That is the legacy Lambda refusing the empty request ([`lambda/hfy-check-allowed/index.mjs`](../../lambda/hfy-check-allowed/index.mjs)). `{"error":"not_found","message":"no such route"} 404` comes from `hfy-api` and means the request never reached the legacy Lambda. Go back to [Add the API behavior and the legacy pin](#add-the-api-behavior-and-the-legacy-pin).
7. **The behaviors are in order, and uploads carry their policy.**

   ```sh
   aws cloudfront get-distribution-config --id <distribution-id> \
     --query 'DistributionConfig.CacheBehaviors.Items[].[PathPattern,TargetOriginId,ResponseHeadersPolicyId]' --output text
   aws cloudformation describe-stacks --stack-name hfy-app \
     --query "Stacks[0].Outputs[?OutputKey=='UploadsResponseHeadersPolicyId'].OutputValue" --output text
   ```

   `/api/check-allowed*` is listed before `/api/*`, and the `/uploads/*` row carries the policy ID that the second command prints.
8. **The CORS rule is in place.**

   ```sh
   aws s3api get-bucket-cors --bucket <site-bucket> \
     | jq -c '.CORSRules[] | {AllowedMethods, AllowedOrigins, AllowedHeaders, MaxAgeSeconds}'
   ```

   One line reads `{"AllowedMethods":["PUT"],"AllowedOrigins":["https://<site>"],"AllowedHeaders":["Content-Type","Content-Length"],"MaxAgeSeconds":3000}`. Any other lines are rules you kept from the earlier configuration.

To try the new surfaces in one browser before anyone else sees them, see [Toggle a feature flag](toggle-a-feature-flag.md). If a check fails, see [Diagnose sign-in and API failures](diagnose-sign-in-and-api-failures.md).

## If the deploy fails

Read the stack events to find the resource that failed and the reason:

```sh
aws cloudformation describe-stack-events --stack-name hfy-app --max-items 25 \
  --query 'StackEvents[].[LogicalResourceId,ResourceStatus,ResourceStatusReason]' --output text
```

- **The origin-verify secret cannot be resolved.** The secret does not exist in `us-west-2`. Run step 1, then deploy again.
- **A failed update** ends in `UPDATE_ROLLBACK_COMPLETE`. The previous code and configuration stay live. Fix the cause and repeat step 4.
- **A failed first create** ends in `ROLLBACK_COMPLETE`. A stack in that state cannot be updated. The table `hfy-app` and the user pool `hfy-users` have `DeletionPolicy: Retain`, so the rollback keeps them. A second create then fails because the table name is taken, and it would add a second `hfy-users` pool. Clean up before you retry:

  1. Delete the stack and wait for it to go:

     ```sh
     aws cloudformation delete-stack --stack-name hfy-app
     aws cloudformation wait stack-delete-complete --stack-name hfy-app
     ```

  2. Confirm that the table and the pool are empty leftovers of the failed create. These commands only read, and they print counts and IDs, not member data:

     ```sh
     aws dynamodb scan --table-name hfy-app --select COUNT --query Count --output text
     aws cognito-idp list-user-pools --max-results 60 \
       --query "UserPools[?Name=='hfy-users'].[Id,CreationDate]" --output text
     aws cognito-idp list-users --user-pool-id <user-pool-id> --max-items 1 --query 'length(Users)' --output text
     ```

     The scan prints `0`. The pool listing prints one row, created at the time of the failed deploy. Use its ID as `<user-pool-id>`. The user count prints `0`.
  3. Only if both counts are `0`, remove the leftovers:

     ```sh
     aws dynamodb delete-table --table-name hfy-app
     aws cognito-idp delete-user-pool --user-pool-id <user-pool-id>
     ```

  4. Repeat step 4.

  If either count is not `0`, or the listing shows more than one pool, stop. Those resources may belong to an established stack. There they hold members' posts, comments and accounts, so never remove them.

## Roll back

Because each build has its own keys, the previous build is still in `<code-bucket>`. To return to it, check out the earlier commit, set `SHA` to that commit with the `git rev-parse` command from step 3, and repeat step 4 from that checkout so that the template and the code match. Steps 2 and 3 are needed only if that commit's zips are no longer in the bucket. The table and the user pool keep their data through a rollback. A rollback does not change the Function URLs, so steps 5 and 6 are not needed.

To undo a CloudFront change from step 5 or 6, use the rollback command that the script printed for its backup, as described at the end of [step 5](#add-the-api-behavior-and-the-legacy-pin).

Then run every check in [Verify](#verify). Check 1 shows both keys ending in the earlier commit's `SHA`.

## Related pages

- [Architecture](../reference/architecture.md): the stack's resources, parameters and outputs, the CloudFront behaviors and the secrets.
- [Edge and origin design](../explanation/edge-and-origin-design.md): why one distribution fronts everything and why the Function URLs are gated by a shared header.
- [The identity model](../explanation/identity-model.md) and [Identity services](../reference/identity-services.md): what the auth edge does and how sessions work.
- [API](../reference/api.md): the routes, packaging and configuration of `hfy-api`.
- [Private data and secrets](../reference/private-data-and-secrets.md): the placeholders and the handling rules for secrets.
- [Rotate the origin-verify secret](rotate-the-origin-verify-secret.md), [Rotate the session signing key](rotate-the-session-signing-key.md), [Manage family access](manage-family-access.md), [Deploy a site change](deploy-a-site-change.md), [Toggle a feature flag](toggle-a-feature-flag.md), [Run the tests](run-the-tests.md).
