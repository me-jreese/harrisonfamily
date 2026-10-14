# How to deploy the app stack and its CloudFront behaviors

Use this page to create or update the app stack, `<app-stack>`, and to put it behind CloudFront: `/auth/*` and `/api/*`, the MCP server at `/mcp*` with its protected-resource metadata (PRM) under `/.well-known/oauth-protected-resource*`, and member photos under `/uploads/*`, with a check of the bucket CORS rule that lets browsers upload them. Follow it for a first deploy and for every change to `api/` or `auth/`. That includes [`auth/edge.manifest.json`](../../auth/edge.manifest.json), which holds the sign-in pages' text and, in `theme.cssUrl`, the `?v=` stamp that the islands build writes whenever the sign-in stylesheet changes. Changes to `11ty/` ship another way: see [Deploy a site change](deploy-a-site-change.md).

The stack, built from [`app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml), holds the DynamoDB table `hfy-app`, the Cognito user pool `hfy-users`, and two Lambda functions behind Function URLs. `hfy-api` serves the member API and, at `/mcp`, the MCP server. `hfy-auth-edge` handles sign-in with Google, a password or a passkey, the sessions, and the OAuth authorization server that MCP clients use. The secrets, the code packages, the access configuration, the CloudFront behaviors and the bucket CORS rule all live outside the stack, so a first deploy takes eight steps instead of one. [Architecture](../reference/architecture.md#app-stack) lists every resource, parameter and output.

The private data gate is not part of this page. [Deploy the edge functions](deploy-the-edge-functions.md) deploys it. [Cut over to authV2 and the private data gate](cut-over-to-the-private-data-gate.md) attaches it to the six family-data paths and, in place, to the `/uploads/*` behavior that step 6 creates. That page also shows how to check whether a distribution is gated. The production cutover ran on 2026-10-12 (HFY-TSK-069, HFY-R67). Step 6 and [Verify](#verify) cover `/uploads/*` both before and after it is gated.

> **Operator credentials only.** The GitHub deploy role cannot run any of this. Its policy in [`github-roles.yaml`](../../infrastructure/cloudformation/github-roles.yaml) allows a sync to the site bucket, CloudFront invalidations, and code, version and alias updates on three named functions, but no CloudFormation, IAM, Cognito or distribution change. No workflow builds or deploys `hfy-api` or `hfy-auth-edge`. [The release model](../explanation/release-model.md#why-the-deploy-role-is-narrow) explains why.

Values in angle brackets, such as `<site>`, `<app-stack>`, `<code-bucket>`, `<config-bucket>`, `<site-bucket>`, `<distribution-id>`, `<google-web-client-id>` and `<user-pool-id>`, are placeholders. [Private data and secrets](../reference/private-data-and-secrets.md#placeholders) lists them.

`<app-stack>` is the name of the live app stack. It is not `hfy-app`, the `--stack` default of `add-auth-behavior.sh`, `add-api-behavior.sh`, `add-uploads-behavior.sh` and `add-mcp-behavior.sh`, so every command on this page names the stack, and every run of those scripts passes `--stack <app-stack>`. A run that leaves `--stack` out stops with `stack hfy-app has no output <output-key>`, for example `stack hfy-app has no output FunctionUrl`, before it reads the distribution. `hfy-app` is still the name of the table, and the roles keep their names, `hfy-api-role` and `hfy-auth-edge-role`.

## Before you start

- **io's go-ahead.** CloudFormation deploys of `<app-stack>` need it, because the table and the user pool hold members' data. So does every real run of a behavior script in steps 5, 6 and 8 ([`AGENTS.md`](../../AGENTS.md)).
- **Operator AWS credentials.** They must be able to:
  - deploy CloudFormation through a change set (create, describe, execute and delete change sets) with named IAM roles, covering IAM, Lambda, DynamoDB, Cognito, CloudWatch Logs and CloudFront response headers policies. CloudFormation acts with these credentials, so they also need `s3:GetObject` on the packages in `<code-bucket>`, because Lambda fetches the code with the caller's permissions. They also need `secretsmanager:GetSecretValue` on the origin-verify secret, which the stack resolves at deploy time.
  - create and read Secrets Manager secrets.
  - write to `<code-bucket>`. The bucket must be in `us-west-2`, the functions' region, because Lambda loads code only from a bucket in its own region.
  - get a CodeArtifact token, which takes `codeartifact:GetAuthorizationToken` and `sts:GetServiceBearerToken`.
  - read the configuration of `hfy-api` and `hfy-auth-edge` (`lambda:GetFunctionConfiguration`), for the secret check in step 5.
  - read and update the CloudFront distribution, and list the account's custom response headers policies (`cloudfront:ListResponseHeadersPolicies`) for check 11.
  - for step 8: read the `hfy-mcp-edge401` stack in `us-east-1` (`cloudformation:DescribeStacks`), and associate a Lambda@Edge version with the distribution, which AWS allows only with `lambda:GetFunction` and `lambda:EnableReplication*` on `hfy-mcp-edge401` and, the first time, `iam:CreateServiceLinkedRole`.
  - put the CORS configuration of `<site-bucket>` (`s3:PutBucketCORS`), only if step 7 finds the rule missing.
  - read object metadata under `config/` in `<config-bucket>`, for the check below.

  Set the region for the shell:

  ```sh
  export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2
  ```

  The secret scripts default to `us-west-2`. The behavior scripts take no region. They read the stack outputs and the origin-verify secret from the shell's default region. `add-mcp-behavior.sh` also reads the `hfy-mcp-edge401` stack, and it asks `us-east-1` for that one itself.
- **Tools.** The AWS CLI version 2, `jq`, `openssl`, `zip`, `unzip`, `curl`, and Node.js 22 with npm. Check 13 in [Verify](#verify) also needs a browser with DevTools and a member account that can sign in.
- **Somewhere outside the repository for distribution backups.** Before each real update, the behavior scripts save the distribution configuration, origin-verify value included, to `${HFY_CF_BACKUP_DIR:-~/.local/state/hfy-infra/cloudfront}`, mode 600. Keep that directory private.
- **A CodeArtifact token in the shell.** The `@io-kit/*` packages come from a private registry, and both package scripts stop if `CODEARTIFACT_AUTH_TOKEN` is unset:

  ```sh
  export CODEARTIFACT_AUTH_TOKEN="$(aws codeartifact get-authorization-token --domain io --query authorizationToken --output text)"
  ```

  Do not echo the token or write it to a file. It expires after 12 hours by default.
- **The access configuration in `<config-bucket>`.** The stack does not create it. Check which objects exist without reading them:

  ```sh
  for k in config/userGrampsID.json config/groups.json config/admins.json; do
    if aws s3api head-object --bucket <config-bucket> --key "$k" >/dev/null 2>&1; then echo "$k present"; else echo "$k missing"; fi
  done
  ```

  `missing` also appears when your credentials cannot read the object.

  - `config/userGrampsID.json` must be present. The auth edge resolves every sign-in against it. If it is missing, stop and follow [Manage family access](manage-family-access.md).
  - `config/groups.json` holds the MCP groups, `mcp-authors` and `hfy-admin`, in the shape documented at the top of [`api/src/policy.js`](../../api/src/policy.js) and in [MCP server: Groups](../reference/mcp-server.md#groups). Without it the MCP server fails closed: every caller gets an empty tool list and no tool runs. You can deploy without it, but publish it before anyone connects an MCP client. Step 8 says when.
  - `config/admins.json` may be missing. That means there are no moderators: nobody is a site admin, and no MCP token carries the `admins` group. It is not an error. `hfy-api` then logs `admin list unavailable (failing closed)` and the auth edge `admin list unavailable (nobody is admin)`, and both are expected. To add a moderator, follow [Manage family access](manage-family-access.md).
- **`<google-web-client-id>`.** This is the Google OAuth web client ID, the same value as the `HFY_GOOGLE_CLIENT_ID` repository secret. The stack requires it as `GoogleClientId` and has no default.
- **A clean checkout of the commit to deploy.** Step 3 names the uploads after the commit, so `git status --short` must print nothing. The `api/` and `auth/` suites should pass ([Run the tests](run-the-tests.md)). If the commit changes the sign-in pages' look, `(cd islands && npm run check:islands)` must pass too, because it fails while the `?v=` in `theme.cssUrl` does not match the committed stylesheet. For such a change, `npm run e2e:theme` in `auth/` can also check those pages in Chrome under their real Content-Security-Policy, against a scratch build of the site ([Identity services: Page theme and HFY overrides](../reference/identity-services.md#page-theme-and-hfy-overrides)).
- **The commit's site deploy, when the sign-in stylesheet changed.** Compare the stylesheet URL that the commit names with the one the live sign-in page links:

  ```sh
  jq -r .theme.cssUrl auth/edge.manifest.json
  curl -s https://<site>/auth/login | grep -o '<link rel="stylesheet" href="[^"]*">'
  ```

  If the two URLs differ, this deploy changes the stylesheet that the sign-in pages load, [`11ty/css/auth-edge.css`](../../11ty/css/auth-edge.css). The `io-kit-deploy.yml` run for this commit on `main` must then have finished its `invalidate` job before you execute the change set in step 4 ([Deploy a site change: Watch the runs](deploy-a-site-change.md#3-watch-the-runs)). The redeployed `hfy-auth-edge` links the new URL at once. A request for that URL that arrives before the new file is in `<site-bucket>` gets the old file, and Cloudflare then keeps those old bytes under the new URL for up to 4 hours ([Edge and origin design](../explanation/edge-and-origin-design.md#static-files-and-versioned-urls-hfy-tsk-086)). For the same reason, do not fetch the new URL yourself before that run has finished.

Run every command on this page from the repository root, in one shell. Steps 3, 4 and 5 set shell variables that later steps and [Verify](#verify) use.

## Steps

Every step is safe to re-run. The secret scripts report `no change` when the secret exists. Repeating step 4 with the same keys changes nothing: the deploy stops with `No changes to deploy` and leaves no change set to execute. The behavior scripts print `no change` and make no update when the distribution already matches. Step 7 only reads.

On a code-only update, run steps 2 to 4, then [Verify](#verify). A change to `auth/edge.manifest.json` alone, such as new sign-in text or a new `theme.cssUrl` stamp, is a code-only update, because the manifest ships inside `hfy-auth-edge.zip`. Run step 5 on a first deploy, and again only when a function's URL changes. Run step 6 on a first deploy, and again only when the stack's uploads policy changes. While `/uploads/*` is members-only, step 6 changes nothing. Run step 7 on a first deploy, and whenever photo uploads fail. Run step 8 on a first deploy, once on a distribution that has no `/mcp*` behavior yet, and again when the `hfy-api` Function URL changes. Step 8 depends on step 5, not on steps 6 or 7.

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

The origin-verify secret must exist before step 4, or the deploy fails. The push key pair, `harrisonfamily/api/vapid`, is optional and is not created here: see [Turn on push notifications](turn-on-push-notifications.md).

### 2. Build the packages

```sh
scripts/ci/package-api.sh
scripts/ci/package-auth.sh
```

Both scripts install from the committed lockfile into a temporary directory, so they need no `npm ci` in `api/` or `auth/` first. [`package-api.sh`](../../scripts/ci/package-api.sh) then runs [`gen-caps.mjs`](../../api/scripts/gen-caps.mjs) there, against the packages it just installed. That writes four generated documents into the zip: `dist/caps.json`, `dist/policy.json` (the MCP permission table), `dist/mcp/tools.json` and `dist/mcp/parity-caps.json`. The script stops if the generator fails or `dist/caps.json` is empty. It does not check the other three.

Each script prints `built <repo>/dist/<name>.zip (<size>)`, for `hfy-api.zip` and `hfy-auth-edge.zip`. `dist/` is gitignored.

Check that each package holds its handler, the edge's manifest and the generated documents:

```sh
unzip -l dist/hfy-api.zip src/index.js dist/caps.json dist/policy.json 'dist/mcp/*.json'
unzip -l dist/hfy-auth-edge.zip src/index.js edge.manifest.json
```

The first listing ends with a total of `5 files` and the second with `2 files`. A smaller count means the package is missing a file. Rebuild it before you go on. For what each package contains, see [API: Packaging and deploy](../reference/api.md#packaging-and-deploy) and [Identity services: Runtime and mount](../reference/identity-services.md#runtime-and-mount).

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

The deploy goes through a CloudFormation change set: you create it, review it, and only then execute it. [Architecture: Updating code](../reference/architecture.md#updating-code) describes what a code update changes, and [the release model](../explanation/release-model.md#why-the-app-lambdas-are-packaged-by-hand) explains why the change set is reviewed.

#### Create the change set

On an update, first check the resource that the auth edge mints MCP tokens for:

```sh
aws cloudformation describe-stacks --stack-name <app-stack> \
  --query "Stacks[0].Parameters[?ParameterKey=='McpResources'].ParameterValue" --output text
```

It must print `https://<site>/mcp`. A stack created before the MCP server moved to a path on the site still holds the old value, `https://mcp.<site>`, because an update keeps a parameter's current value even after the template default changes. Then every token is minted for the wrong resource and the MCP server rejects it. If it prints anything else, add `McpResources=https://<site>/mcp` to the `--parameter-overrides` below, this once. Later deploys keep it. MCP clients that connected before the change must connect again, because a refresh keeps the resource of the original grant ([Connect an MCP client](connect-an-mcp-client.md)).

Then create the change set:

```sh
aws cloudformation deploy \
  --stack-name <app-stack> \
  --template-file infrastructure/cloudformation/app-stack.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --no-execute-changeset \
  --fail-on-empty-changeset \
  --parameter-overrides \
    CodeBucket=<code-bucket> \
    CodeKey="lambda/hfy-api-$SHA.zip" \
    AuthCodeKey="lambda/hfy-auth-edge-$SHA.zip" \
    GoogleClientId=<google-web-client-id>
```

- `CAPABILITY_NAMED_IAM` is required because the template names its roles, `hfy-api-role` and `hfy-auth-edge-role`.
- `--no-execute-changeset` creates the change set and exits without changing the stack. `--fail-on-empty-changeset` turns "nothing to change" into an error, so a reused key cannot pass unnoticed (see the gotcha below).
- On a first deploy, every parameter you leave out takes its template default. `ConfigBucket` and `MediaBucket` default to the production `<config-bucket>` and `<site-bucket>`. `VapidSecretName` defaults to empty, so notifications are stored but no push is sent ([Turn on push notifications](turn-on-push-notifications.md)). `SesIdentityArn` defaults to empty, so Cognito sends verification and reset email from its default sender, which allows about 50 emails a day for the account. To send through SES instead, pass a verified SES identity ARN in the same region as `SesIdentityArn`, and a bare `SesFromAddress` such as `no-reply@<site-domain>` (no display name). `hfy-api` and `hfy-auth-edge` may call `ses:SendEmail` only with that exact From address, so a display-name form is rejected. `SesIdentityArn` requires `SesFromAddress`, and `SesConfigurationSet` requires `SesIdentityArn`; the stack refuses the change set otherwise.
- On an update, a parameter you leave out keeps the stack's current value, as `McpResources` shows. To change one, add it to `--parameter-overrides`. [Architecture](../reference/architecture.md#parameters) lists the parameters.

#### The sync and render change set (HFY-TSK-247)

The change set that adds the sync bucket, the table stream, `hfy-sync-render`, its 15-minute schedule, the alarm topic, the `hfy-data-breakglass` role and the `hfy-graph-render` placeholder has three extra inputs:

1. Package and upload the two no-op placeholders first: `bash scripts/ci/package-placeholders.sh`, then copy `dist/placeholders/hfy-sync-render-placeholder.zip` and `dist/placeholders/hfy-graph-render-placeholder.zip` to `lambda/` in `<code-bucket>` under those names (the `RenderCodeKey` and `GraphRenderCodeKey` defaults). The renderer placeholder does nothing under `RenderMode=off` and fails loudly under any other mode.
2. Pass `BreakGlassPrincipalArn=<io-iam-principal-arn>` (it has no default, and it is compared by ARN, so it is never stored in the repository) and `AlarmEmail=<io-email>`. The first change set must pass `BreakGlassPrincipalArn` explicitly, because a stack that predates the parameter has no previous value to reuse. Every later change set passes `UsePreviousValue=true` for both, or it fails on the missing required parameter. After the execute, confirm the subscription from the email SNS sends; an unconfirmed subscription delivers no alarm.
3. Pass every other new parameter at its default (`SyncApiEnabled=0`, `RenderMode=off`, `HfyEditing=off`, `AccessRequests=off`, and empty `TurnstileSiteKey`, `SesConfigurationSet` and `ChatServicePublicKeys`). Every later change to these is parameter-only: use `--use-previous-template` and `UsePreviousValue` for each other parameter.

`hfy-data-breakglass` can read and write all of `person/*`, `family/*`, `event/*`, `note/*`, `place/*` and `media/*`, which is wider than the `*.json` keys the later bucket-policy deny covers. The width is deliberate, for break-glass repair of binaries and shell files. Until the cutover task scopes the deny, `hfy-api` can also overwrite `media/*.json`, because its `media/*` binary grant cannot exclude a suffix.

The review must show no `Remove` action and no `Replacement` for the table, `hfy-api`, `hfy-auth-edge`, the user pool or the two Function URLs beyond the `Conditional` ones above. The table gains a stream in place. Reserved concurrency of 1 on each of the two new functions needs the account to keep at least 10 unreserved executions.

`config/groups.json` gains the `gramps-owner` group in the config bucket by hand, not through this stack: copy the current object to a dated backup key first, add the group with io's subject, and upload. Nothing in this stack or its code writes that file.

The command prints `Changeset created successfully. Run the following command to review changes:`, then an `aws cloudformation describe-change-set --change-set-name <change-set-arn>` line. The change set's name starts with `awscli-cloudformation-package-deploy-`. Keep its ARN in the shell:

```sh
CS='<change-set-arn>'
```

If the command instead prints `No changes to deploy. Stack <app-stack> is up to date` and exits non-zero, nothing changed and no change set is left to execute. If it prints `Failed to create the changeset`, see [If the deploy fails](#if-the-deploy-fails).

#### Review the change set

```sh
aws cloudformation describe-change-set --change-set-name "$CS" \
  --query '[Status, ExecutionStatus]' --output text
aws cloudformation describe-change-set --change-set-name "$CS" \
  --query "Parameters[?ParameterKey=='CodeKey' || ParameterKey=='AuthCodeKey'].[ParameterKey, ParameterValue]" --output text
aws cloudformation describe-change-set --change-set-name "$CS" \
  --query 'Changes[].ResourceChange.[Action, LogicalResourceId, ResourceType, Replacement]' --output text
```

The first command prints `CREATE_COMPLETE` and `AVAILABLE`. The second prints both keys, each ending in `-$SHA.zip` for this commit. The third lists one row per resource. For a code-only update it lists exactly these four, in any order:

```
Modify	Function	AWS::Lambda::Function	False
Modify	FunctionUrl	AWS::Lambda::Url	Conditional
Modify	AuthFunction	AWS::Lambda::Function	False
Modify	AuthFunctionUrl	AWS::Lambda::Url	Conditional
```

- The two functions change their code in place, with no replacement.
- The two Function URLs show replacement `Conditional`, and that is expected. Their `TargetFunctionArn` is `!GetAtt Function.Arn` or `!GetAtt AuthFunction.Arn`, which CloudFormation treats as dynamic while it computes the change set, so it cannot rule out a replacement. A code update keeps the function's ARN, so the URLs stay. The output check below confirms it.
- A parameter you named adds the changes it feeds. `McpResources` changes only the environment of `AuthFunction`, which is already listed. `VapidSecretName` also modifies `Role`.
- On a first deploy, every row is `Add`.

Do not execute the change set if it shows any `Remove`, a replacement of `True`, or `Table`, `UserPool` or `UserPoolClient` when you passed no parameter that feeds them, or any row you cannot explain. Discard it instead, which leaves the stack as it was:

```sh
aws cloudformation delete-change-set --change-set-name "$CS"
```

A code update also resolves the origin-verify secret again for each function it modifies ([Architecture: `ORIGIN_VERIFY`](../reference/architecture.md#origin_verify)). If the secret's value may have been changed in place since the last stack deploy, run [the secret check in step 5](#check-the-secret-the-scripts-will-send) before you execute. If it says `DIFFERS`, executing would give the functions a value that CloudFront does not send. Discard the change set and follow [Rotate the origin-verify secret](rotate-the-origin-verify-secret.md).

#### Execute it and check the Function URLs

On an update, record the two Function URL outputs first. The shell function below reads them, and no command here prints the URLs themselves:

```sh
fn_urls() {
  aws cloudformation describe-stacks --stack-name <app-stack> \
    --query "Stacks[0].Outputs[?OutputKey=='FunctionUrl' || OutputKey=='AuthFunctionUrl'].[OutputKey, OutputValue]" \
    --output text | sort
}
URLS_BEFORE="$(fn_urls)"; printf '%s\n' "$URLS_BEFORE" | cut -f1
```

The last line prints `AuthFunctionUrl` and `FunctionUrl`, the names of the two outputs it recorded, not their values. Then execute the change set and wait for the stack:

```sh
aws cloudformation execute-change-set --change-set-name "$CS"
aws cloudformation wait stack-update-complete --stack-name <app-stack>
```

On a first deploy, wait with `aws cloudformation wait stack-create-complete --stack-name <app-stack>` instead. The `wait` command returns with no output when the stack is complete. If it reports `Waiter StackUpdateComplete failed` or `Waiter StackCreateComplete failed`, see [If the deploy fails](#if-the-deploy-fails).

On an update, compare the outputs:

```sh
if [ "$(fn_urls)" = "$URLS_BEFORE" ]; then echo "Function URLs unchanged"; else echo "Function URLs CHANGED"; fi
```

It must print `Function URLs unchanged`. `Function URLs CHANGED` means a Function URL was replaced. CloudFront still sends `/auth/*`, `/api/*` and `/mcp*` to the old host, so those requests fail until the origins are rewritten. Run step 5 and step 8 now. On a first deploy there is nothing to compare.

> **Gotcha: re-uploading to a fixed key changes nothing.** CloudFormation updates a function's code only when `CodeBucket`, `CodeKey` or `AuthCodeKey` changes. If you upload a new zip over an existing key and deploy again, the stack sees no change and the functions keep the old code. With `--fail-on-empty-changeset`, the deploy then stops with `No changes to deploy. Stack <app-stack> is up to date` and a non-zero exit status. Without that option, the AWS CLI version 2 prints the same message and exits `0`. If you also changed a parameter, the change set is not empty, but it still carries no code change. Use a new key for every build, as in step 3. For a code-only fix you can instead point a function at the new object directly:
>
> ```sh
> aws lambda update-function-code --function-name hfy-api \
>   --s3-bucket <code-bucket> --s3-key "lambda/hfy-api-$SHA.zip"
> ```
>
> The stack's `CodeKey` then no longer names the running code, until a later stack deploy changes it. Prefer a stack deploy, so that the stack parameters record which build is live.

### 5. Route `/auth/*` and `/api/*` through CloudFront

Run this step on a first deploy. Run it again only when a function gets a new Function URL, for example after a new `FunctionName` or `AuthFunctionName`, or when the output check in step 4 prints `Function URLs CHANGED`. A code-only update keeps both Function URLs, which that check confirms, so skip this step, apart from the secret check that step 8 needs. To change the secret that CloudFront sends, follow [Rotate the origin-verify secret](rotate-the-origin-verify-secret.md) instead.

Each script adds one Function URL to the distribution as an HTTPS custom origin that sends the origin-verify secret as `X-Origin-Verify`, plus that origin's path behaviors. The scripts read the URLs from the stack outputs `AuthFunctionUrl` and `FunctionUrl` of the stack named by `--stack`, and redact the header value in every diff they print. They default to the production distribution, so pass `--distribution` to make the target explicit. [Repository operations](../reference/repository-operations.md#cloudfront-behavior-scripts) describes what a run does and every message it prints.

| Script | Origin | Behaviors |
| --- | --- | --- |
| [`add-auth-behavior.sh`](../../scripts/infra/add-auth-behavior.sh) | `hfy-auth-origin` | `/auth/*`, `/.well-known/oauth-authorization-server*` |
| [`add-api-behavior.sh`](../../scripts/infra/add-api-behavior.sh) | `hfy-api-origin` | `/api/*`, plus the legacy pin `/api/check-allowed*` on the origin that served `/api/check-allowed` before |

#### Check the secret the scripts will send

The scripts write whatever value the secret holds now. The functions hold the value that CloudFormation resolved when it last updated them. Compare the two by hash before you change the distribution. Neither value is printed.

```sh
unset ORIGIN_VERIFY
OV_NAME="$(aws cloudformation describe-stacks --stack-name <app-stack> \
  --query "Stacks[0].Parameters[?ParameterKey=='OriginVerifySecretName'].ParameterValue" --output text)"
WANT="$(aws secretsmanager get-secret-value --secret-id "$OV_NAME" \
  --query SecretString --output text | openssl dgst -sha256)"
for f in hfy-auth-edge hfy-api; do
  HAVE="$(aws lambda get-function-configuration --function-name "$f" \
    --query Environment.Variables.ORIGIN_VERIFY --output text | openssl dgst -sha256)"
  if [ "$HAVE" = "$WANT" ]; then echo "$f: matches $OV_NAME"; else echo "$f: DIFFERS from $OV_NAME"; fi
done
```

Both lines must say `matches`. If either says `DIFFERS`, or any command prints an error, stop. Applying the scripts would then send a value the functions reject, and every request through that origin would return `403`. Follow [Rotate the origin-verify secret](rotate-the-origin-verify-secret.md) instead. Keep `ORIGIN_VERIFY` unset, because the scripts use it in preference to the secret. Pass `--secret-name "$OV_NAME"` to every script run below and in step 8, so that the scripts read the secret the stack uses even after a rotation.

#### Add the auth behaviors

Add the auth behaviors first. `hfy-api` verifies every session against the edge's public keys at `https://<site>/auth/.well-known/jwks.json` (stack parameter `SessionJwksUrl`), which it fetches back through CloudFront. Until `/auth/*` is routed, the API cannot accept any session.

```sh
scripts/infra/add-auth-behavior.sh --stack <app-stack> --distribution <distribution-id> --secret-name "$OV_NAME" --dry-run
scripts/infra/add-auth-behavior.sh --stack <app-stack> --distribution <distribution-id> --secret-name "$OV_NAME"
```

On a first deploy, the dry-run diff only adds `hfy-auth-origin` and its two behaviors and raises the matching `Quantity` counts. On a re-run against a correct distribution, it prints `distribution <distribution-id> already has ...: no change` and stops. The real run prints where it saved the pre-change configuration, a rollback command, and the distribution status, `InProgress`.

#### Add the API behavior and the legacy pin

The legacy sign-in is still deployed, and every push to `main` still ships its Lambda, `hfy-check-allowed` ([Deploy a site change](deploy-a-site-change.md)). Its page, `/family-login/`, posts a Google sign-in to `/api/check-allowed` on the `hfy-check-allowed` API Gateway, but only while `authV2` is off. With `authV2` on, `/family-login/` sends a signed-out visitor to `/auth/login` instead. `add-api-behavior.sh` keeps the legacy path where it is, so the legacy sign-in still works if `authV2` is turned off again. Before it points `/api/*` at `hfy-api`, it clones whichever behavior serves `/api/check-allowed` under the pattern `/api/check-allowed*`, and orders the clone ahead of `/api/*` (HFY-R58). [Edge and origin design](../explanation/edge-and-origin-design.md#one-origin-for-the-browser) explains why the path needs its own behavior.

```sh
scripts/infra/add-api-behavior.sh --stack <app-stack> --distribution <distribution-id> --secret-name "$OV_NAME" --dry-run
```

Read the dry run:

- A line `legacy /api/check-allowed stays on origin <origin-id> via /api/check-allowed* (ordered before /api/*; retired by HFY-TSK-069)`. `<origin-id>` must be the legacy API Gateway origin, never `hfy-api-origin`. The line's wording names HFY-TSK-069, the cutover task, but the cutover left the legacy Lambda and this pin in place, so keep the pin.
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
scripts/infra/add-api-behavior.sh --stack <app-stack> --distribution <distribution-id> --secret-name "$OV_NAME"
aws cloudfront wait distribution-deployed --id <distribution-id>
```

The `wait` command returns with no output once the distribution is deployed. If it times out, run it again.

Three messages mean stop, in this step and in step 8:

- `cannot read secret <name>` on a real run, or `(dry-run) origin-verify secret not read; using a placeholder` on a dry run. The script could not read `$OV_NAME`. Check the name, the region and your `GetSecretValue` permission.
- `stack hfy-app has no output ...`: `--stack <app-stack>` is missing.
- `unknown arg ...`: a flag is misspelled.

To undo a behavior change, run the rollback command the script printed, with the distribution's current ETag from `aws cloudfront get-distribution-config --id <distribution-id> --query ETag --output text`. The backup file holds the origin-verify value, so delete it once you no longer need it.

### 6. Serve member photos under `/uploads/*`

Member photos are uploaded to `uploads/posts/` in `<site-bucket>`. [`add-uploads-behavior.sh`](../../scripts/infra/add-uploads-behavior.sh) creates the `/uploads/*` behavior in its public state. In that state the behavior serves the prefix from the bucket's S3 origin to anyone who holds a photo's URL, with `CachingOptimized` and the stack's `UploadsResponseHeadersPolicy`, which adds `X-Content-Type-Options: nosniff` and a sandboxing Content-Security-Policy (HFY-R58). The script reads the policy ID from the output `UploadsResponseHeadersPolicyId` of the stack named by `--stack`, and uses the default behavior's origin unless you pass `--origin-id`.

The private data gate later makes the same behavior members-only, in place. [`add-data-gate-behaviors.sh`](../../scripts/infra/add-data-gate-behaviors.sh) adds the `hfy-edge-gate` viewer-request association, `CachingDisabled` and the response headers policy `hfy-uploads-private`, which sends the same two headers and adds `Cache-Control: private, no-store`. `add-uploads-behavior.sh` never undoes that.

```sh
scripts/infra/add-uploads-behavior.sh --stack <app-stack> --distribution <distribution-id> --dry-run
scripts/infra/add-uploads-behavior.sh --stack <app-stack> --distribution <distribution-id>
aws cloudfront wait distribution-deployed --id <distribution-id>
```

The dry run prints one of three results:

- **No `/uploads/*` behavior yet, or a public one that differs.** It prints `serving /uploads/* from origin <origin-id> with response headers policy <policy-id>`, and its diff adds or changes only the `/uploads/*` behavior.
- **A public behavior that already matches.** It prints the same `serving` line, then `distribution <distribution-id> already has the /uploads/* behavior with response headers policy <policy-id>: no change`.
- **A members-only behavior**, one that carries the `hfy-edge-gate` association. It prints `/uploads/* is members-only (hfy-edge-gate association, add-data-gate-behaviors.sh): left as it is. add-data-gate-behaviors.sh --remove ungates it.`, then `distribution <distribution-id> already has the members-only /uploads/* behavior: no change`. The real run changes nothing either. If the gate function has another name on your distribution, pass it with `--gate-function-name`.

`origin '<id>' is not in distribution ...` means the default behavior's origin was not found: pass the S3 origin's ID with `--origin-id`.

If the family-data paths are gated but `/uploads/*` is not, photos are still served to anyone with the URL. `curl -s -o /dev/null -w '%{http_code}\n' https://<site>/person/index.json` prints `401` when the data paths are gated, and the same request for `https://<site>/uploads/x` prints `401` when `/uploads/*` is. To gate `/uploads/*` in place, follow [step 3 of the cutover](cut-over-to-the-private-data-gate.md#3-attach-the-gate), which needs io's G-prod approval, then purge `/uploads/` from Cloudflare as its [step 4](cut-over-to-the-private-data-gate.md#4-optional-purge-cloudflare) describes.

The members-only policy keeps the Content-Security-Policy of the stack's policy, which is held in `UPLOADS_CSP` in [`scripts/infra/lib/cf-common.sh`](../../scripts/infra/lib/cf-common.sh). If you change that header in [`app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml), change `UPLOADS_CSP` with it. `scripts/infra/test/run.sh` fails while the two differ.

### 7. Check the photo-upload CORS rule

Browsers upload photos straight to `<site-bucket>`, using presigned `PUT` URLs that `hfy-api` issues, so the bucket needs a CORS rule. The upload does not pass through CloudFront, so the private data gate does not affect it. No stack manages the bucket: the rule in [`site-bucket-cors.json`](../../infrastructure/cloudformation/site-bucket-cors.json) is applied by hand in [step 1 of Stand up the static site](stand-up-the-static-site.md#1-create-the-site-bucket). Check that it is in place:

```sh
scripts/infra/check-site-bucket-cors.sh
```

The script sends the browser's CORS preflight, with no credentials, and its last line ends with `0 failed`. If it prints `expected 200` for a site origin, the bucket has no rule for that origin: apply the file as in that step 1. Photo uploads from the `postsV2` composer depend on this rule ([Toggle a feature flag](toggle-a-feature-flag.md)).

### 8. Route `/mcp` and the protected-resource metadata

The MCP server runs inside `hfy-api`, on the same Function URL as `/api/*` ([MCP server](../reference/mcp-server.md)). [`add-mcp-behavior.sh`](../../scripts/infra/add-mcp-behavior.sh) adds two behaviors on `hfy-api-origin`: `/mcp*`, the MCP endpoint, and `/.well-known/oauth-protected-resource*`, the PRM that tells an MCP client where to sign in. Both are uncached, forward every viewer header except `Host`, allow all seven methods, and run the `hfy-mcp-edge401` Lambda@Edge function on `origin-response`. A Function URL renames the `WWW-Authenticate` header of the server's `401` to `x-amzn-remapped-www-authenticate`, and that function copies it back, so MCP clients can find the PRM ([Edge and origin design](../explanation/edge-and-origin-design.md#the-mcp-401-restore-origin-response)). The script also writes `hfy-api-origin` with the origin-verify header, as step 5 does.

Before you run it:

- **`hfy-mcp-edge401` is deployed in `us-east-1`.** Follow [Deploy the edge functions](deploy-the-edge-functions.md#1-deploy-the-mcp-401-restore-function). The script reads that stack's `Edge401FunctionVersionArn` output itself, so you pass no ARN.
- **`OV_NAME` is set and the secret check says `matches`.** Run [the secret check in step 5](#check-the-secret-the-scripts-will-send) in this shell, even if you skipped the rest of step 5.
- **`/auth/*` is routed** (step 5). MCP clients get their tokens from the auth edge.

Run the dry run and review it:

```sh
scripts/infra/add-mcp-behavior.sh --stack <app-stack> --secret-name "$OV_NAME" --dry-run --distribution <distribution-id>
```

- It must not print `(dry-run) Lambda@Edge version ARN not resolved; using a placeholder`. That line means the script could not read `hfy-mcp-edge401` in `us-east-1`: deploy that stack, or check that your credentials can read it. A real run would stop with `no Lambda@Edge version ARN: deploy infrastructure/mcp-edge401.us-east-1.yaml (us-east-1) and pass --edge401-arn`.
- On the first run, the `after` line of the two `cache behaviors ... (in evaluation order)` lines ends with `/mcp* -> hfy-api-origin, /.well-known/oauth-protected-resource* -> hfy-api-origin, default -> <origin-id>`. New behaviors go after the existing ones.
- On the first run, the diff adds those two behaviors and raises the `CacheBehaviors` `Quantity` by two. Each new behavior carries one Lambda function association: `EventType` `origin-response`, `IncludeBody` `false` and a `LambdaFunctionARN` of the form `arn:aws:lambda:us-east-1:<aws-account-id>:function:hfy-mcp-edge401:<n>`. `hfy-api-origin` does not change, because step 5 wrote the same origin.
- On a re-run against a matching distribution, it prints `distribution <distribution-id> already has the MCP behaviors (/mcp* /.well-known/oauth-protected-resource*) with the Lambda@Edge 401 restore: no change` and stops.

If the script stops with exit status `3` and a message such as `refusing: <pattern> is ordered before the MCP behavior for /mcp and would shadow it`, an earlier behavior already matches `/mcp` or `/.well-known/oauth-protected-resource`. CloudFront uses the first behavior that matches, so that one would answer instead. The script never reorders behaviors. Stop, and find out what the earlier behavior is for before you change it.

If the dry run is as described, apply it and wait:

```sh
scripts/infra/add-mcp-behavior.sh --stack <app-stack> --secret-name "$OV_NAME" --distribution <distribution-id>
aws cloudfront wait distribution-deployed --id <distribution-id>
```

The real run prints where it saved the pre-change configuration, a rollback command, and the status `InProgress`. A Lambda@Edge association takes several minutes to deploy. If the `wait` times out, run it again.

Then, if the check in [Before you start](#before-you-start) found `config/groups.json` missing, publish it now: follow [Manage family access](manage-family-access.md). Until it exists, every MCP caller gets an empty tool list. To connect a client and check what it can do, see [Connect an MCP client](connect-an-mcp-client.md).

## Verify

Checks 1 to 12 need no session. Check 13 uses your own signed-in browser. None prints a secret.

1. **The stack is complete, runs this build, and kept its Function URLs.**

   ```sh
   aws cloudformation describe-stacks --stack-name <app-stack> --query 'Stacks[0].StackStatus' --output text
   aws cloudformation describe-stacks --stack-name <app-stack> \
     --query "Stacks[0].Parameters[?ParameterKey=='CodeKey' || ParameterKey=='AuthCodeKey' || ParameterKey=='McpResources'].[ParameterKey, ParameterValue]" --output text
   ```

   The first command prints `CREATE_COMPLETE` or `UPDATE_COMPLETE`. The second prints both keys, each ending in `-$SHA.zip` for the commit you deployed, and `McpResources` as `https://<site>/mcp`. After an update, run the comparison from [step 4](#execute-it-and-check-the-function-urls) again in the same shell. It prints `Function URLs unchanged`.
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
3. **Root discovery reaches the edge and lists the userinfo endpoint.**

   ```sh
   curl -s https://<site>/.well-known/oauth-authorization-server/auth | jq -r '.issuer, .userinfo_endpoint'
   ```

   The command prints `https://<site>/auth` and `https://<site>/auth/userinfo`, which also proves the `/.well-known/oauth-authorization-server*` behavior. `null` twice means the edge answered `404 {"code":"NOT_FOUND"}`, which it does when `McpRedirectUris` is empty and MCP OAuth is off.
4. **The sign-in page comes from this build.** The page's passkey button text and stylesheet URL come from the manifest in the package, and its headers come from the kit version and `auth/src/edge.js`:

   ```sh
   LOGIN_PAGE="$(mktemp)"; LOGIN_HEADERS="$(mktemp)"
   curl -s -D "$LOGIN_HEADERS" -o "$LOGIN_PAGE" https://<site>/auth/login
   jq -r '.copy.passkey_button, .theme.cssUrl' auth/edge.manifest.json
   grep -o '<button type="button" id="pk-btn">[^<]*</button>' "$LOGIN_PAGE"
   grep -o '<link rel="stylesheet" href="[^"]*">' "$LOGIN_PAGE"
   grep -i '^referrer-policy:' "$LOGIN_HEADERS"
   grep -i '^content-security-policy:' "$LOGIN_HEADERS" | grep -o -E "(style|font)-src [^;]*"
   rm -f "$LOGIN_PAGE" "$LOGIN_HEADERS"
   ```

   - `jq` prints the manifest's `passkey_button` text, then its `theme.cssUrl`, `https://<site>/css/auth-edge.css?v=<sha8>`.
   - The button line carries the same `passkey_button` text, and the stylesheet line the same URL. Different text or a different URL means `hfy-auth-edge` runs another package: compare its `AuthCodeKey` in check 1. No button line means the page has no passkey path at all.
   - `referrer-policy: strict-origin-when-cross-origin`. `no-referrer` means the function was built with `@io-kit/auth` older than `2.1.2`, and Google refuses sign-in on `/auth/login`.
   - `style-src 'unsafe-inline' https://<site> https://accounts.google.com/gsi/style` and `font-src 'self'`. The stylesheet and the fonts are allowed only from the site itself ([Identity services: Page theme and HFY overrides](../reference/identity-services.md#page-theme-and-hfy-overrides)).
5. **The sign-in stylesheet matches its version.**

   ```sh
   CSS_URL="$(jq -r .theme.cssUrl auth/edge.manifest.json)"
   curl -s -o /dev/null -w '%{http_code}\n' "$CSS_URL"
   echo "named ${CSS_URL##*v=}, served $(curl -s "$CSS_URL" | openssl dgst -sha256 | awk '{print substr($NF, 1, 8)}')"
   ```

   The first command prints `200`, and the second line shows the same eight hex digits twice. The `?v=` value is the start of the stylesheet's SHA-256, so two different values mean visitors get a different file from the one this build names. Either the commit's site deploy has not finished, or a request reached the new URL before it finished, and Cloudflare now keeps the old bytes under that URL for up to 4 hours. See the site-deploy prerequisite in [Before you start](#before-you-start). Clearing that one URL from Cloudflare sooner is a purge, which needs io's go-ahead.
6. **The API answers through CloudFront.**

   ```sh
   curl -s -w '\n%{http_code}\n' https://<site>/api/posts
   ```

   The command prints `{"error":"unauthenticated","message":"sign in required"}` and `401`. That shows CloudFront reached `hfy-api` with the right header and the request got as far as the session check. Other results:

   - `{"error":"forbidden"}` and `403`: the header the distribution sends does not match the function's `ORIGIN_VERIFY`. See [Diagnose sign-in and API failures](diagnose-sign-in-and-api-failures.md#every-api-or-auth-request-gets-403-forbidden).
   - A body with only a `message` key, such as `{"message":"Not Found"}` or `{"message":"Missing Authentication Token"}`: API Gateway answered, so `/api/*` still targets the legacy origin. Run [Add the API behavior](#add-the-api-behavior-and-the-legacy-pin), or wait for the distribution to finish deploying.
   - An error page from the site bucket: no `/api/*` behavior exists.
   - A `5xx` status: CloudFront reached `hfy-api`, but the function failed, for example because a module is missing from the package. Read its log with `aws logs tail /aws/lambda/hfy-api --since 15m`, then rebuild and redeploy from step 2.
7. **The MCP server challenges a request without a token.**

   ```sh
   curl -s -D - -o /dev/null -X POST -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"ping"}' https://<site>/mcp \
     | grep -i -E '^HTTP/|^www-authenticate:|^x-amzn-remapped-www-authenticate:'
   ```

   The status line ends in `401`, and a `www-authenticate:` line reads `Bearer realm="<site>", resource_metadata="https://<site>/.well-known/oauth-protected-resource", scope="openid email profile"`. An `x-amzn-remapped-www-authenticate:` line with the same value may also appear, because the 401-restore function copies that header and leaves it in place. Other results:

   - `x-amzn-remapped-www-authenticate:` with no `www-authenticate:` line: the `/mcp*` behavior has no 401-restore association, or the distribution has not finished deploying. Run the dry run of step 8 again.
   - `403` with no challenge: the header the distribution sends does not match `hfy-api`'s `ORIGIN_VERIFY`.
   - Any other status: the `/mcp*` behavior is missing. Run step 8.
8. **The protected-resource metadata is served.**

   ```sh
   curl -s https://<site>/.well-known/oauth-protected-resource/mcp | jq -r '.resource, .authorization_servers[0]'
   ```

   The command prints `https://<site>/mcp` and `https://<site>/auth`. A `jq` parse error means the site bucket answered, so the `/.well-known/oauth-protected-resource*` behavior is missing. Run step 8.
9. **The Function URLs refuse direct calls.**

   ```sh
   API_URL="$(aws cloudformation describe-stacks --stack-name <app-stack> \
     --query "Stacks[0].Outputs[?OutputKey=='FunctionUrl'].OutputValue" --output text)"
   AUTH_URL="$(aws cloudformation describe-stacks --stack-name <app-stack> \
     --query "Stacks[0].Outputs[?OutputKey=='AuthFunctionUrl'].OutputValue" --output text)"
   curl -s -w ' %{http_code}\n' "${API_URL}api/posts"
   curl -s -w ' %{http_code}\n' "${AUTH_URL}auth/session"
   ```

   Both lines print `{"error":"forbidden"} 403`. The Function URLs use AuthType `NONE`, so this header check is the only thing that stops callers from bypassing CloudFront.
10. **The legacy sign-in route survived.** The legacy sign-in, used whenever `authV2` is off, reaches its Lambda through the pin.

    ```sh
    curl -s -w ' %{http_code}\n' -X POST -H 'content-type: application/json' -d '{}' \
      https://<site>/api/check-allowed
    ```

    The command prints `{"allowed":false,"error":"missing id_token"} 400`. That is the legacy Lambda refusing the empty request ([`lambda/hfy-check-allowed/index.mjs`](../../lambda/hfy-check-allowed/index.mjs)). `{"error":"not_found","message":"no such route"} 404` comes from `hfy-api` and means the request never reached the legacy Lambda. Go back to [Add the API behavior and the legacy pin](#add-the-api-behavior-and-the-legacy-pin).
11. **The behaviors are in order, and uploads carry the policy for their state.**

    ```sh
    aws cloudfront get-distribution-config --id <distribution-id> \
      --query 'DistributionConfig.CacheBehaviors.Items[].[PathPattern, TargetOriginId, ResponseHeadersPolicyId, LambdaFunctionAssociations.Items[0].EventType]' --output text
    aws cloudformation describe-stacks --stack-name <app-stack> \
      --query "Stacks[0].Outputs[?OutputKey=='UploadsResponseHeadersPolicyId'].OutputValue" --output text
    aws cloudfront list-response-headers-policies --type custom \
      --query "ResponseHeadersPolicyList.Items[?ResponseHeadersPolicy.ResponseHeadersPolicyConfig.Name=='hfy-uploads-private'].ResponseHeadersPolicy.Id" --output text
    curl -s -o /dev/null -w '%{http_code}\n' https://<site>/uploads/x
    ```

    The first command lists one row per behavior, in evaluation order. Its last column is the event type of the behavior's Lambda@Edge association, or `None` when it has none.

    - `/api/check-allowed*` is listed before `/api/*`.
    - The `/mcp*` and `/.well-known/oauth-protected-resource*` rows target `hfy-api-origin` and end in `origin-response`.
    - The `/uploads/*` row matches the `curl` result:
      - When `curl` prints anything other than `401`, `/uploads/*` is public. The row ends in `None` and carries the stack's policy ID, which the second command prints. This is the state after a first deploy, before the gate is attached.
      - When `curl` prints `401`, `/uploads/*` is members-only. The row ends in `viewer-request` and carries the `hfy-uploads-private` ID, which the third command prints.
    - Once the private data gate is attached, the six family-data rows (`/person/*.json`, `/family/*`, `/event/*`, `/note/*`, `/place/*` and `/media/*`) also end in `viewer-request`, so seven rows do in all. If those six do and `/uploads/*` does not, gate it as described at the end of [step 6](#6-serve-member-photos-under-uploads).
12. **The CORS rule is in place.** The check in [step 7](#7-check-the-photo-upload-cors-rule) ends with `0 failed`.
13. **A signed-in session reports when it expires.** Sign in at `https://<site>/auth/login` in a browser, open DevTools on any page of `https://<site>`, and run this in the console. It logs no identity, only whether you are signed in and how long the session has left:

    ```js
    fetch("/auth/session").then((r) => r.json()).then((s) => console.log(s.authenticated, typeof s.exp, Math.round(s.exp - Date.now() / 1000)))
    ```

    It logs `true number <seconds>`, where `<seconds>` is above `0` and at most `3600`, the session's lifetime. Pages use `exp` to refresh the session silently through `/auth/refresh` before it lapses. `true undefined NaN` means `hfy-auth-edge` does not run this build. `false` means the browser is not signed in.

If a check fails, see [Diagnose sign-in and API failures](diagnose-sign-in-and-api-failures.md), and for MCP clients, [An MCP client cannot connect](diagnose-sign-in-and-api-failures.md#an-mcp-client-cannot-connect).

## If the deploy fails

If the deploy printed `Failed to create the changeset: ... Status: FAILED. Reason: <reason>`, the stack did not change. Fix what the reason names and run step 4 again.

If the change set was executed and the stack failed, read the stack events to find the resource that failed and the reason:

```sh
aws cloudformation describe-stack-events --stack-name <app-stack> --max-items 25 \
  --query 'StackEvents[].[LogicalResourceId,ResourceStatus,ResourceStatusReason]' --output text
```

- **The origin-verify secret cannot be resolved,** as the change set's reason or in a stack event. The secret does not exist in `us-west-2`. Run step 1, then deploy again.
- **A failed update** ends in `UPDATE_ROLLBACK_COMPLETE`. The previous code and configuration stay live. Fix the cause and repeat step 4.
- **A failed first create** ends in `ROLLBACK_COMPLETE`. A stack in that state cannot be updated. The table `hfy-app` and the user pool `hfy-users` have `DeletionPolicy: Retain`, so the rollback keeps them. A second create then fails because the table name is taken, and it would add a second `hfy-users` pool. Clean up before you retry:

  1. Delete the stack and wait for it to go:

     ```sh
     aws cloudformation delete-stack --stack-name <app-stack>
     aws cloudformation wait stack-delete-complete --stack-name <app-stack>
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

Because each build has its own keys, the previous build is still in `<code-bucket>`. To return to it, check out the earlier commit, set `SHA` to that commit with the `git rev-parse` command from step 3, and repeat step 4 from that checkout, review included, so that the template and the code match. Steps 2 and 3 are needed only if that commit's zips are no longer in the bucket. The table and the user pool keep their data through a rollback, and the stack keeps its current `McpResources`. A rollback does not change the Function URLs, which the output check in step 4 confirms, so steps 5, 6 and 8 are not needed.

Before step 4, check in the earlier commit's checkout which kit version it pins, and whether `authV2` is on:

```sh
jq -r '.dependencies["@io-kit/auth"]' auth/package.json
curl -s https://<site>/_data/flags.json | jq .authV2
```

If the first command prints a version older than `2.1.2`, that build sends `Referrer-Policy: no-referrer`, and Google refuses sign-in on `/auth/login` as an origin that is not allowed for the client ID. If the second command prints `true`, `/auth/login` is where every member signs in. In that case do not roll back that far: fix forward instead. An earlier build also shows its own manifest's sign-in text and links its own stylesheet URL.

To undo a CloudFront change from step 5, 6 or 8, use the rollback command that the script printed for its backup, as described at the end of [step 5](#add-the-api-behavior-and-the-legacy-pin). The backup holds the whole distribution configuration as it was before that run. Restoring it also undoes every later change to the distribution, the private data gate's included. Restore only the backup of the run you are undoing, before anything else changes the distribution, and run check 11 afterwards.

Then run every check in [Verify](#verify). Check 1 shows both keys ending in the earlier commit's `SHA`. Checks of features that the earlier commit lacks fail as expected. Check 4 shows the earlier manifest's text and stylesheet URL. Check 5 can show two different values once the site serves a newer `auth-edge.css` than the earlier build names.

## Related pages

- [Architecture](../reference/architecture.md#app-stack): the stack's resources, parameters and outputs, the CloudFront behaviors and the secrets.
- [MCP server](../reference/mcp-server.md): what `/mcp` and the protected-resource metadata serve, the groups config, and the `401` challenge.
- [Deploy the edge functions](deploy-the-edge-functions.md): the `us-east-1` stacks `hfy-mcp-edge401`, which step 8 attaches, and `hfy-edge-gate`.
- [Cut over to authV2 and the private data gate](cut-over-to-the-private-data-gate.md): how to tell whether a distribution is gated, how to attach the gate to the family-data paths and to `/uploads/*`, and how to roll it back.
- [Identity services: Page theme and HFY overrides](../reference/identity-services.md#page-theme-and-hfy-overrides) and [Theme and asset build](../reference/theme-and-asset-build.md): what the sign-in pages load, the HTML overrides in `auth/src/edge.js`, and how the `theme.cssUrl` stamp is made.
- [Connect an MCP client](connect-an-mcp-client.md): connecting a client to `/mcp` and running an admin delete.
- [Edge and origin design](../explanation/edge-and-origin-design.md): why one distribution fronts everything, why the Function URLs are gated by a shared header, and why MCP lives at a path on `hfy-api`.
- [The identity model](../explanation/identity-model.md) and [Identity services](../reference/identity-services.md): what the auth edge does and how sessions work.
- [API](../reference/api.md): the routes, packaging and configuration of `hfy-api`.
- [Private data and secrets](../reference/private-data-and-secrets.md): the placeholders and the handling rules for secrets.
- [Rotate the origin-verify secret](rotate-the-origin-verify-secret.md), [Rotate the session signing key](rotate-the-session-signing-key.md), [Manage family access](manage-family-access.md), [Turn on push notifications](turn-on-push-notifications.md), [Deploy a site change](deploy-a-site-change.md), [Toggle a feature flag](toggle-a-feature-flag.md), [Run the tests](run-the-tests.md).
