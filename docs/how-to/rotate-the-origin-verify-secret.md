# How to rotate the origin-verify secret

CloudFront sends a shared secret in the `X-Origin-Verify` header to both Lambda Function URLs, and `hfy-api` and `hfy-auth-edge` refuse any request that does not carry it. This page replaces that secret with a new value stored under a new secret name, keeping the `403` window as short as it can be. For why there is a header at all, and why rotation cannot be seamless, see [Edge and origin design](../explanation/edge-and-origin-design.md#one-accepted-origin-secret). The check itself is described in the [API reference](../reference/api.md#request-pipeline) and the [identity services reference](../reference/identity-services.md#failure-responses).

Values in angle brackets, such as `<repo>`, are placeholders. The forms are listed in [Private data and secrets](../reference/private-data-and-secrets.md#placeholders). `<app-stack>` is the name of the live app stack. It is not `hfy-app`, the `--stack` default of the behavior scripts, so every script run on this page passes `--stack <app-stack>`. Never paste the secret's value into a terminal log, an issue or a doc. None of the commands below print it.

## Before you start

- **io's go-ahead.** The rotation opens a `403` window and deploys `<app-stack>`, and both need it ([`AGENTS.md`](../../AGENTS.md)).
- **There will be a short outage on `/api/*`, `/mcp` and `/auth/*`.** Each Lambda accepts exactly one value ([`api/src/origin.js`](../../api/src/origin.js), [`auth/src/origin.js`](../../auth/src/origin.js)). CloudFront sends the header from two origins. `hfy-auth-origin` serves `/auth/*` and `/.well-known/oauth-authorization-server*`. `hfy-api-origin` serves `/api/*`, and also `/mcp*` and `/.well-known/oauth-protected-resource*`, because the MCP server runs inside `hfy-api` ([MCP server](../reference/mcp-server.md#cloudfront-behaviors)). From the moment the functions take the new value until every CloudFront edge location sends it, all of those paths return `403 {"error":"forbidden"}`. Sign-in through the auth edge, session refresh, member features, and MCP clients with their OAuth discovery fail during that window. Static pages, and the legacy `/api/check-allowed*` route, which has its own origin, are unaffected. If the private data gate is attached, a gate instance that holds no keys yet cannot fetch them from `/auth/.well-known/jwks.json` either, so it denies data requests until the window closes. Instances that already hold keys keep using them.
- **Rotate to a new secret name.** A new value put under the existing name does not reach the functions, so this page creates a new secret and points the stack at it. For why, see [Edge and origin design](../explanation/edge-and-origin-design.md#one-accepted-origin-secret). For how the stack resolves the secret, see [`ORIGIN_VERIFY`](../reference/architecture.md#origin_verify) in the architecture reference.
- **The old secret is your way back.** It stays in place until you schedule its deletion in [Afterwards](#afterwards).

You need:

- AWS credentials, used by hand, that can:
  - create, describe and read secrets in Secrets Manager, and later schedule one for deletion. CloudFormation resolves the new secret with the deploying identity's permissions, so that identity needs `secretsmanager:GetSecretValue` on it.
  - create, describe, execute and delete change sets on `<app-stack>` with `CAPABILITY_NAMED_IAM`. CloudFormation updates the two functions with the same credentials. The CI deploy role has no CloudFormation or IAM permissions ([Repository operations](../reference/repository-operations.md)).
  - describe the `hfy-mcp-edge401` stack in `us-east-1`. `add-mcp-behavior.sh` reads the MCP behaviors' Lambda@Edge version from its output.
  - get and update the distribution configuration (`cloudfront:GetDistributionConfig`, `cloudfront:UpdateDistribution`) and read its status (`cloudfront:GetDistribution`).
- The AWS CLI, `jq`, `openssl`, `shasum` and `curl`.
- A checkout of the commit the stack was last deployed from. The stack's `CodeKey` parameter names it:

  ```bash
  aws cloudformation describe-stacks --region us-west-2 --stack-name <app-stack> \
    --query "Stacks[0].Parameters[?ParameterKey=='CodeKey'].ParameterValue" --output text
  ```

  It prints `lambda/hfy-api-<sha>.zip`, where `<sha>` is that commit. With that commit's template, the change set in Step 3 changes nothing but the secret name.
- A quiet moment. Expect the window to last about as long as a CloudFront deployment, usually a few minutes.

## Set up your shell

Run every command from the repository root, `<repo>`, in one shell, and keep that shell open until you have finished [Afterwards](#afterwards).

```bash
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2
unset ORIGIN_VERIFY EDGE401_ARN
OLD=$(aws cloudformation describe-stacks --stack-name <app-stack> \
  --query "Stacks[0].Parameters[?ParameterKey=='OriginVerifySecretName'].ParameterValue" --output text)
NEW=harrisonfamily/cloudfront/origin-verify-v2
DIST=$(sed -n 's/^DIST=\([^;]*\);.*/\1/p' scripts/infra/add-api-behavior.sh)
urls() { aws cloudformation describe-stacks --stack-name <app-stack> \
  --query "Stacks[0].Outputs[?OutputKey=='FunctionUrl' || OutputKey=='AuthFunctionUrl'].[OutputKey,OutputValue]" --output text | sort; }
URLS=$(urls)
echo "$OLD -> $NEW on $DIST"
```

- The region matters because the behavior scripts take no `--region` flag. They read the outputs of `<app-stack>` and the secret in the CLI's default region, and both live in `us-west-2`. `add-mcp-behavior.sh` reads the `hfy-mcp-edge401` stack in `us-east-1` by itself.
- `ORIGIN_VERIFY` must be unset. When it is set, the behavior scripts use it in preference to the secret named by `--secret-name`. `EDGE401_ARN`, when set, overrides the version that `add-mcp-behavior.sh` reads from `hfy-mcp-edge401`.
- `OLD` is the name the stack uses now. **Do not assign `OLD` again in this shell.** [Afterwards](#afterwards) and [Roll back](#roll-back) use it to name the old secret, and after Step 3 the same lookup returns the new name.
- For `NEW`, pick a name that has never existed. On a later rotation, use the next suffix (`-v3`, and so on).
- `DIST` is the production distribution, `<distribution-id>`, read from the behavior scripts' `--distribution` default. The scripts use that default, so the commands below do not pass `--distribution`.
- `URLS` holds the two Function URLs, for the check at the end of Step 3. Nothing prints them.

## Step 1: Create the new secret

```bash
bash scripts/infra/create-origin-verify.sh --name "$NEW"
```

[`create-origin-verify.sh`](../../scripts/infra/create-origin-verify.sh) stores 32 random bytes, as hex, and prints `created secret <name> in us-west-2`. It never prints the value.

If it prints `already exists ... no change`, a secret with that name already exists. Choose a different name and run it again.

Nothing has changed for visitors yet.

## Step 2: Dry-run the three behavior scripts

Do this before the stack deploy. The dry runs read the new secret and the live distribution and change nothing, so a problem found here costs no outage. Step 3 changes neither the distribution nor, as its last check confirms, the Function URLs, so the result still holds after it.

First list the origins and the cache behaviors in order. These queries print IDs and path patterns only, never a header value:

```bash
aws cloudfront get-distribution-config --id "$DIST" \
  --query 'DistributionConfig.Origins.Items[].Id' --output text
aws cloudfront get-distribution-config --id "$DIST" \
  --query 'DistributionConfig.CacheBehaviors.Items[].[PathPattern,TargetOriginId]' --output text
```

Then run the three dry runs, one after the other:

```bash
bash scripts/infra/add-auth-behavior.sh --stack <app-stack> --secret-name "$NEW" --dry-run
bash scripts/infra/add-api-behavior.sh --stack <app-stack> --secret-name "$NEW" --dry-run
bash scripts/infra/add-mcp-behavior.sh --stack <app-stack> --secret-name "$NEW" --dry-run
```

Each script reads its Function URL from the outputs of the stack that `--stack` names. `add-mcp-behavior.sh` also needs the version ARN of the `hfy-mcp-edge401` Lambda@Edge function, which it reads from that stack's `Edge401FunctionVersionArn` output. All three redact the header value in every diff they print, and a dry run that finds a change ends with `(dry-run) no changes made`.

The scripts merge their origins and behaviors into the live configuration in place, so a rotation changes nothing but the header value ([Repository operations](../reference/repository-operations.md#cloudfront-behavior-scripts)). `add-api-behavior.sh` and `add-mcp-behavior.sh` both write `hfy-api-origin`, so their dry runs show the same change. A good dry run of each script prints:

- two `cache behaviors ... (in evaluation order)` lines, `before` and `after`, that list the same behaviors in the same order;
- no diff lines, because the only difference is the redacted header value;
- `(only the X-Origin-Verify header value differs)`;
- from `add-api-behavior.sh` only, `legacy /api/check-allowed stays on origin <origin-id> via /api/check-allowed* (ordered before /api/*; retired by HFY-TSK-069)`, naming the legacy API Gateway origin.

Stop, and do not go on to Step 3, if a dry run shows any of these:

| Dry-run output | Meaning |
| --- | --- |
| `Stack with id hfy-app does not exist`, or `stack ... has no output ...` | `--stack <app-stack>` is missing or names the wrong stack. |
| `(dry-run) origin-verify secret not read; using a placeholder` | The script could not read `$NEW`: a wrong name, a wrong region or missing `GetSecretValue`. The real run would fail with `cannot read secret`. |
| `(dry-run) Lambda@Edge version ARN not resolved; using a placeholder` | `add-mcp-behavior.sh` could not read the `hfy-mcp-edge401` output in `us-east-1`, so its diff compares the live behaviors with a placeholder ARN. A real run would stop with `no Lambda@Edge version ARN`. Check your access to that stack, or pass the version the behaviors use now with `--edge401-arn`, as described below the table. |
| `distribution ... already has ...: no change` | CloudFront already sends the value the script read. Either this rotation has already run, or `ORIGIN_VERIFY` is set in your shell. |
| From `add-mcp-behavior.sh`, a diff that changes only the version number at the end of `LambdaFunctionARN` in the `/mcp*` and `/.well-known/oauth-protected-resource*` behaviors | The MCP behaviors use a different `hfy-mcp-edge401` version from the one the stack outputs, for example after a [rollback](deploy-the-edge-functions.md#roll-back). Applying would move them. Pass the version they use now with `--edge401-arn` on every `add-mcp-behavior.sh` run on this page, and run the dry run again. |
| Any other `-` or `+` diff line, or `before` and `after` behavior lines that differ | Applying would change something besides the header, for example a different Function URL host or a policy that was changed by hand. Find out why the live configuration differs from what the script builds before you go on. |
| `refusing: ...`, with exit status `3` | From `add-api-behavior.sh`, it cannot resolve the legacy `/api/check-allowed*` pin. See [Deploy the app stack](deploy-the-app-stack.md#add-the-api-behavior-and-the-legacy-pin). From `add-mcp-behavior.sh`, an earlier behavior matches an MCP path and would shadow it, which means the behaviors were changed by hand. Find out why before you go on. |

To read the version the MCP behaviors use now:

```bash
aws cloudfront get-distribution-config --id "$DIST" \
  --query "DistributionConfig.CacheBehaviors.Items[?PathPattern=='/mcp*'].LambdaFunctionAssociations.Items[0].LambdaFunctionARN" --output text
```

It prints `arn:aws:lambda:us-east-1:<aws-account-id>:function:hfy-mcp-edge401:<n>`. Add `--edge401-arn` with that ARN to the `add-mcp-behavior.sh` command.

## Step 3: Point the stack at the new secret

Create a change set, review it, then execute it. Nothing changes until you execute it, so the review costs no outage.

```bash
aws cloudformation deploy --stack-name <app-stack> \
  --template-file infrastructure/cloudformation/app-stack.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides OriginVerifySecretName="$NEW" \
  --no-execute-changeset
```

- Parameters you do not override keep their current values. That includes `CodeBucket` and `GoogleClientId`, which have no defaults, and `CodeKey` and `AuthCodeKey`, so both functions keep the code they run now.
- The command prints `Changeset created successfully.`, followed by a `describe-change-set` command that names the change set's ARN.
- If it prints `No changes to deploy` instead, the stack already uses `$NEW`. Check the `echo` output from [Set up your shell](#set-up-your-shell).

Keep the ARN in the shell, and review the change set:

```bash
CS='<change-set-arn>'
aws cloudformation describe-change-set --change-set-name "$CS" \
  --query 'Changes[].ResourceChange.[LogicalResourceId,Action,Replacement]' --output text
```

It lists exactly these four rows, in any order:

| Logical ID | Action | Replacement |
| --- | --- | --- |
| `Function` (`hfy-api`) | `Modify` | `False` |
| `AuthFunction` (`hfy-auth-edge`) | `Modify` | `False` |
| `FunctionUrl` | `Modify` | `Conditional` |
| `AuthFunctionUrl` | `Modify` | `Conditional` |

The functions change because the secret name is part of their `ORIGIN_VERIFY` reference. `Conditional` on the Function URLs is expected: each URL's target is its function's ARN, which CloudFormation treats as dynamic while it computes the change set. An environment change keeps the ARN, so the URLs stay ([Updating code](../reference/architecture.md#updating-code) in the architecture reference).

Any other row, a `True` replacement, or an `Add` or `Remove` means that the template in your checkout, or a parameter, differs from what is deployed. Executing it would change more than the secret and could lengthen the window. Delete the change set with `aws cloudformation delete-change-set --change-set-name "$CS"`, and find out why before you go on.

If the review shows the four rows, execute the change set and wait for the update. **The `403` window starts during this update**, as each function takes the new value.

```bash
aws cloudformation execute-change-set --change-set-name "$CS"
aws cloudformation wait stack-update-complete --stack-name <app-stack>
[ "$(urls)" = "$URLS" ] && echo "Function URLs unchanged" || echo "Function URLs CHANGED"
```

The waiter returns, with no output, when the update is complete, and the last line prints `Function URLs unchanged`. Move to Step 4 straight away.

- **`Waiter StackUpdateComplete failed`.** The update failed and rolled back. Both functions are back on the value of `$OLD`, and CloudFront has not changed, so the window has closed. Do not go on to Step 4. Find the cause in the stack events, as in [Deploy the app stack](deploy-the-app-stack.md#if-the-deploy-fails).
- **`Function URLs CHANGED`.** CloudFormation replaced a Function URL, so its origin points at a host that no longer serves the function. Go on to Step 4 anyway. The behavior scripts read the new URL from `<app-stack>` and write it into the origin together with the new header, so their output also shows that origin's `DomainName` changing.

## Step 4: Point CloudFront at the new secret

```bash
bash scripts/infra/add-auth-behavior.sh --stack <app-stack> --secret-name "$NEW"
bash scripts/infra/add-api-behavior.sh --stack <app-stack> --secret-name "$NEW"
bash scripts/infra/add-mcp-behavior.sh --stack <app-stack> --secret-name "$NEW"
```

If you added `--edge401-arn` in Step 2, add it to the `add-mcp-behavior.sh` command here too. Run the scripts one after the other, not in parallel. Each reads the distribution's current configuration and ETag.

A real run does not stop to ask. `add-auth-behavior.sh` and `add-api-behavior.sh` each print the same lines as their dry runs, then `saved the pre-change DistributionConfig to <backup> (mode 600, holds the origin-verify header)`, a `roll back with: ...` command, and the distribution status, `InProgress`. The backups hold the old secret value. [Afterwards](#afterwards) deletes them.

`add-mcp-behavior.sh` finds that `hfy-api-origin` already sends the new value, because `add-api-behavior.sh` has just written it into the origin they share. It prints `distribution <distribution-id> already has the MCP behaviors (/mcp* /.well-known/oauth-protected-resource*) with the Lambda@Edge 401 restore: no change`, makes no update and saves no backup. That confirms the MCP paths need nothing more.

If a real run fails:

| Output | What to do |
| --- | --- |
| `cannot read secret ...` | The script could not read `$NEW`. Check `AWS_REGION` and the name, then run the same script again. |
| `no Lambda@Edge version ARN: ...` | `add-mcp-behavior.sh` could not read the `hfy-mcp-edge401` output. `add-api-behavior.sh` has already given `hfy-api-origin` the new value, so the MCP paths are not affected. Run it again with `--edge401-arn`, as in Step 2. |
| `PreconditionFailed` from `UpdateDistribution` | The distribution changed after the script read it, and nothing was applied. Run the same script again. |

If you have to stop after Step 3, the `403` window stays open until both sides use the same secret. Either fix the problem and finish Steps 4 and 5, or end the window by going back to `$OLD`: run Step 3 with `OriginVerifySecretName="$OLD"`, run any behavior script whose real run already printed `InProgress` again with `--stack <app-stack> --secret-name "$OLD"`, and wait as in Step 5.

## Step 5: Wait for CloudFront to finish deploying

```bash
aws cloudfront wait distribution-deployed --id "$DIST"
```

The waiter returns, with no output, when every edge location has the new configuration. If it times out, run it again. Until it returns, some edges still send the old value.

## Verify

1. **The API accepts CloudFront.** This prints `401`, because the request reached `hfy-api` with a valid header and was then refused for having no session:

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' https://<site>/api/posts
   ```

2. **The auth edge accepts CloudFront.** This prints `200`:

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' https://<site>/auth/.well-known/jwks.json
   ```

3. **The MCP paths accept CloudFront.** The first line prints `200`, for the protected-resource metadata. The second prints `401`, because the request reached the MCP server in `hfy-api` with a valid header and was then refused for having no bearer token:

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' https://<site>/.well-known/oauth-protected-resource/mcp
   curl -s -o /dev/null -w '%{http_code}\n' https://<site>/mcp
   ```

4. **Direct calls are still refused.** Both lines end in `403`, because a request that bypasses CloudFront carries no header:

   ```bash
   for k in FunctionUrl AuthFunctionUrl; do
     url=$(aws cloudformation describe-stacks --stack-name <app-stack> \
       --query "Stacks[0].Outputs[?OutputKey=='$k'].OutputValue" --output text)
     printf '%s ' "$k"; curl -s -o /dev/null -w '%{http_code}\n' "$url"
   done
   ```

5. **CloudFront sends the new value.** This prints the first 12 characters of the SHA-256 digest of the secret and of each origin's header, never a value. `hfy-api-origin` carries the header for `/api/*` and for the MCP paths:

   ```bash
   digest() { printf '%s' "$1" | shasum -a 256 | cut -c1-12; }
   printf '%-16s %s\n' secret "$(digest "$(aws secretsmanager get-secret-value --secret-id "$NEW" \
     --query SecretString --output text)")"
   for o in hfy-api-origin hfy-auth-origin; do
     printf '%-16s %s\n' "$o" "$(digest "$(aws cloudfront get-distribution-config --id "$DIST" \
       --query "DistributionConfig.Origins.Items[?Id=='$o'].CustomHeaders.Items[0].HeaderValue" --output text)")"
   done
   ```

   All three digests match.

A `403` in checks 1 to 3 means the two sides still disagree.

- **An origin's digest differs from the secret's.** That origin does not send `$NEW`. Run its script again as in [Step 4](#step-4-point-cloudfront-at-the-new-secret), `add-api-behavior.sh` for `hfy-api-origin` or `add-auth-behavior.sh` for `hfy-auth-origin`, then wait as in Step 5.
- **All three digests match.** CloudFront is right, so look at the stack. This prints the secret name the stack uses, which should be the same name as `$NEW`:

  ```bash
  aws cloudformation describe-stacks --stack-name <app-stack> \
    --query "Stacks[0].Parameters[?ParameterKey=='OriginVerifySecretName'].ParameterValue" --output text
  ```

  Do not assign its output to `OLD`. [Afterwards](#afterwards) and [Roll back](#roll-back) need `$OLD` to keep naming the old secret.

[Diagnose sign-in and API failures](diagnose-sign-in-and-api-failures.md#every-api-or-auth-request-gets-403-forbidden) compares the functions' values with the secret and covers the other causes.

## Afterwards

1. **Make the new name stick.** Five places still default to the old name: the `SECRET=` default in `add-api-behavior.sh`, `add-auth-behavior.sh` and `add-mcp-behavior.sh`, the `NAME=` default in `create-origin-verify.sh`, and the `OriginVerifySecretName` default in `app-stack.yaml`. While the old secret can still be read, a behavior script run without `--secret-name` writes the old value back into its origin. From `add-api-behavior.sh` or `add-mcp-behavior.sh`, that is `hfy-api-origin`, and every request to `/api/*`, `/mcp` and the protected-resource metadata gets a `403` until it is fixed. From `add-auth-behavior.sh`, it is `hfy-auth-origin`, and `/auth/*` breaks the same way. Either pass `--secret-name` on every run from now on, or change all five defaults in one pull request. If you change the defaults, also update the usage comments in the scripts and the docs that cite the name. `grep -rl 'harrisonfamily/cloudfront/origin-verify' --include='*.md' --exclude-dir=node_modules .` lists the pages. Later stack deploys keep the current parameter value unless they override it, so the template default only matters for a new stack.
2. **Delete the distribution backups from Step 4.** Each real run that updated the distribution saved one under `${HFY_CF_BACKUP_DIR:-~/.local/state/hfy-infra/cloudfront}`, named `<distribution-id>-<UTC timestamp>-before.json`. They hold the old secret value, so once [Verify](#verify) passes, delete the ones this rotation wrote, normally two, from `add-auth-behavior.sh` and `add-api-behavior.sh`.
3. **Schedule deletion of the old secret.** Do this only after every check in [Verify](#verify) passes. Each secret has a monthly charge, so keeping both costs money. First run `echo "$OLD -> $NEW"` and confirm that it prints two different names, the old one first.

   ```bash
   aws secretsmanager delete-secret --secret-id "$OLD" --recovery-window-in-days 7
   ```

   For seven days, `aws secretsmanager restore-secret --secret-id "$OLD"` brings it back. While it waits for deletion, nothing can read it. A behavior script run without `--secret-name` then fails with `cannot read secret` instead of writing the old value. The old name cannot be reused until the deletion completes.

## Roll back

While the old secret exists, you can go back to it with the same procedure. If you have already scheduled it for deletion, restore it first with `aws secretsmanager restore-secret --secret-id "$OLD"`. Until you do, nothing can read it, so neither the stack deploy nor the behavior scripts can use it.

1. Run the dry runs in Step 2 with `--secret-name "$OLD"`.
2. Run Step 3 with `OriginVerifySecretName="$OLD"`. The change set lists the same four rows.
3. Run Step 4 with `--secret-name "$OLD"`.
4. Wait as in Step 5, then run [Verify](#verify), with `$OLD` in place of `$NEW` in check 5.

The rollback has its own `403` window. Afterwards, schedule deletion of the unused new secret.

## Related

- [Edge and origin design](../explanation/edge-and-origin-design.md): why each Lambda accepts one value, and what accepting two would cost.
- [Private data and secrets](../reference/private-data-and-secrets.md): the secret, where its value ends up, and who can read it.
- [Architecture reference](../reference/architecture.md#app-stack): `<app-stack>`, its parameters, and how a change set updates it.
- [Repository operations](../reference/repository-operations.md#cloudfront-behavior-scripts): what each behavior script run does, step by step.
- [MCP server](../reference/mcp-server.md): what `/mcp` and the protected-resource metadata serve from `hfy-api`.
- [Deploy the app stack](deploy-the-app-stack.md): the full stack deploy.
- [Deploy the edge functions](deploy-the-edge-functions.md): the `hfy-mcp-edge401` version that the MCP behaviors carry.
- [Rotate the session signing key](rotate-the-session-signing-key.md): the other secret the auth edge depends on.
