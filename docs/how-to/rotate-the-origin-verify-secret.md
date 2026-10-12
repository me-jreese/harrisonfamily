# How to rotate the origin-verify secret

CloudFront sends a shared secret in the `X-Origin-Verify` header to both Lambda Function URLs, and `hfy-api` and `hfy-auth-edge` refuse any request that does not carry it. This page replaces that secret with a new value stored under a new secret name, keeping the `403` window as short as it can be. For why there is a header at all, and why rotation cannot be seamless, see [Edge and origin design](../explanation/edge-and-origin-design.md#one-accepted-origin-secret). The check itself is described in the [API reference](../reference/api.md#request-pipeline) and the [identity services reference](../reference/identity-services.md#failure-responses).

Values in angle brackets, such as `<repo>`, are placeholders. The forms are listed in [Private data and secrets](../reference/private-data-and-secrets.md#placeholders). On this page, `<api-function-url-host>` and `<auth-function-url-host>` also stand for the hosts of the `hfy-app` stack outputs `FunctionUrl` and `AuthFunctionUrl`. Never paste the secret's value into a terminal log, an issue or a doc. None of the commands below print it.

## Before you start

- **There will be a short outage on `/api/*` and `/auth/*`.** Each Lambda accepts exactly one value ([`api/src/origin.js`](../../api/src/origin.js), [`auth/src/origin.js`](../../auth/src/origin.js)). From the moment the functions take the new value until every CloudFront edge location sends it, those paths return `403 {"error":"forbidden"}`. Sign-in, member features and OAuth discovery for MCP clients fail during that window. Static pages are unaffected.
- **Rotate to a new secret name.** A new value put under the existing name does not reach the functions, so this page creates a new secret and points the stack at it. For why, see [Edge and origin design](../explanation/edge-and-origin-design.md#one-accepted-origin-secret). For how the stack resolves the secret, see [`ORIGIN_VERIFY`](../reference/architecture.md#origin_verify) in the architecture reference.
- **The old secret is your way back.** It stays in place until you schedule its deletion in [Afterwards](#afterwards).

You need:

- AWS credentials, used by hand, that can:
  - create, describe and read secrets in Secrets Manager, and later schedule one for deletion. CloudFormation resolves the new secret with the deploying identity's permissions, so that identity needs `secretsmanager:GetSecretValue` on it.
  - deploy the `hfy-app` stack with `CAPABILITY_NAMED_IAM`. The CI deploy role has no CloudFormation or IAM permissions ([Repository operations](../reference/repository-operations.md)).
  - get and update the distribution configuration (`cloudfront:GetDistributionConfig`, `cloudfront:UpdateDistribution`) and read its status (`cloudfront:GetDistribution`).
- The AWS CLI, `jq`, `openssl`, `shasum` and `curl`.
- A checkout of the commit the stack was last deployed from, normally `main`. The deploy in Step 3 should change nothing but the secret name.
- A quiet moment. Expect the window to last about as long as a CloudFront deployment, usually a few minutes.

## Set up your shell

Run every command from the repository root, `<repo>`, in one shell, and keep that shell open until you have finished [Afterwards](#afterwards).

```bash
export AWS_REGION=us-west-2
unset ORIGIN_VERIFY
OLD=$(aws cloudformation describe-stacks --stack-name hfy-app \
  --query "Stacks[0].Parameters[?ParameterKey=='OriginVerifySecretName'].ParameterValue" --output text)
NEW=harrisonfamily/cloudfront/origin-verify-v2
DIST=$(sed -n 's/^DIST=\([^;]*\);.*/\1/p' scripts/infra/add-api-behavior.sh)
echo "$OLD -> $NEW on $DIST"
```

- `AWS_REGION` matters because the behavior scripts take no `--region` flag. They read the stack outputs and the secret in the CLI's default region, and both live in `us-west-2`.
- `ORIGIN_VERIFY` must be unset. When it is set, the behavior scripts use it in preference to the secret named by `--secret-name`.
- `OLD` is the name the stack uses now. **Do not assign `OLD` again in this shell.** [Afterwards](#afterwards) and [Roll back](#roll-back) use it to name the old secret, and after Step 3 the same lookup returns the new name.
- For `NEW`, pick a name that has never existed. On a later rotation, use the next suffix (`-v3`, and so on).
- `DIST` is the production distribution, `<distribution-id>`, read from the behavior scripts' `--distribution` default.

## Step 1: Create the new secret

```bash
bash scripts/infra/create-origin-verify.sh --name "$NEW"
```

[`create-origin-verify.sh`](../../scripts/infra/create-origin-verify.sh) stores 32 random bytes, as hex, and prints `created secret <name> in us-west-2`. It never prints the value.

If it prints `already exists ... no change`, a secret with that name already exists. Choose a different name and run it again.

Nothing has changed for visitors yet.

## Step 2: Dry-run both behavior scripts

Do this before the stack deploy. The dry runs read the new secret and the live distribution and change nothing, so a problem found here costs no outage. The deploy in Step 3 changes neither the Function URLs nor the distribution, so the result still holds after it.

First list the origins and the cache behaviors in order. These queries print IDs and path patterns only, never a header value:

```bash
aws cloudfront get-distribution-config --id "$DIST" \
  --query 'DistributionConfig.Origins.Items[].Id' --output text
aws cloudfront get-distribution-config --id "$DIST" \
  --query 'DistributionConfig.CacheBehaviors.Items[].[PathPattern,TargetOriginId]' --output text
```

Then run both dry runs, one after the other:

```bash
bash scripts/infra/add-auth-behavior.sh --secret-name "$NEW" --dry-run
bash scripts/infra/add-api-behavior.sh --secret-name "$NEW" --dry-run
```

The scripts use the production distribution and the `hfy-app` stack by default, so no other flags are needed. Both redact the header value in every diff they print, and every dry run ends with `(dry-run) no changes made`.

The scripts merge their origins and behaviors into the live configuration in place, so a rotation changes nothing but the header value ([Repository operations](../reference/repository-operations.md#cloudfront-behavior-scripts)). A good dry run of each script prints:

- two `cache behaviors ... (in evaluation order)` lines, `before` and `after`, that list the same behaviors in the same order;
- no diff lines, because the only difference is the redacted header value;
- `(only the X-Origin-Verify header value differs)`;
- from `add-api-behavior.sh` only, `legacy /api/check-allowed stays on origin <origin-id> via /api/check-allowed* (ordered before /api/*; retired by HFY-TSK-069)`, naming the legacy API Gateway origin.

Stop, and do not go on to Step 3, if a dry run shows any of these:

| Dry-run output | Meaning |
| --- | --- |
| `(dry-run) origin-verify secret not read; using a placeholder` | The script could not read `$NEW`: a wrong name, a wrong region or missing `GetSecretValue`. The real run would fail with `cannot read secret`. |
| `distribution ... already has ...: no change` | CloudFront already sends the value the script read. Either this rotation has already run, or `ORIGIN_VERIFY` is set in your shell. |
| Any `-` or `+` diff line, or `before` and `after` behavior lines that differ | Applying would change something besides the header, for example a different Function URL host or a policy that was changed by hand. Find out why the live configuration differs from what the script builds before you go on. |
| `refusing: ...`, with exit status `3` | `add-api-behavior.sh` cannot resolve the legacy `/api/check-allowed*` pin. See [Deploy the app stack](deploy-the-app-stack.md#add-the-api-behavior-and-the-legacy-pin). |

## Step 3: Point the stack at the new secret

```bash
aws cloudformation deploy --stack-name hfy-app \
  --template-file infrastructure/cloudformation/app-stack.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides OriginVerifySecretName="$NEW"
```

- Parameters you do not override keep their current values, including `CodeBucket` and `GoogleClientId`, which have no defaults.
- The update should modify exactly two resources, `Function` (`hfy-api`) and `AuthFunction` (`hfy-auth-edge`). If the template in your checkout differs from the deployed one, more resources change and the window grows. To check first, run the same command with `--no-execute-changeset` and describe the change set it names. Reviewing it costs nothing, because the window has not started.
- **The `403` window starts during this deploy**, as each function takes the new value. The command waits for the update and prints `Successfully created/updated stack - hfy-app`. Move to Step 4 straight away.
- If it prints `No changes to deploy`, the stack already uses `$NEW`. Check the `echo` output from [Set up your shell](#set-up-your-shell).

## Step 4: Point CloudFront at the new secret

```bash
bash scripts/infra/add-auth-behavior.sh --secret-name "$NEW"
bash scripts/infra/add-api-behavior.sh --secret-name "$NEW"
```

Run them one after the other, not in parallel. Each reads the distribution's current configuration and ETag.

A real run does not stop to ask. Each prints the same lines as its dry run, then `saved the pre-change DistributionConfig to <backup> (mode 600, holds the origin-verify header)`, a `roll back with: ...` command, and the distribution status, `InProgress`. The backups hold the old secret value. [Afterwards](#afterwards) deletes them.

If a real run fails:

| Output | What to do |
| --- | --- |
| `cannot read secret ...` | The script could not read `$NEW`. Check `AWS_REGION` and the name, then run the same script again. |
| `PreconditionFailed` from `UpdateDistribution` | The distribution changed after the script read it, and nothing was applied. Run the same script again. |

If you have to stop after Step 3, the `403` window stays open until both sides use the same secret. Either fix the problem and finish Steps 4 and 5, or end the window by going back to `$OLD`: run Step 3 with `OriginVerifySecretName="$OLD"`, run any behavior script whose real run already printed `InProgress` again with `--secret-name "$OLD"`, and wait as in Step 5.

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

3. **Direct calls are still refused.** Both lines end in `403`, because a request that bypasses CloudFront carries no header:

   ```bash
   for k in FunctionUrl AuthFunctionUrl; do
     url=$(aws cloudformation describe-stacks --stack-name hfy-app \
       --query "Stacks[0].Outputs[?OutputKey=='$k'].OutputValue" --output text)
     printf '%s ' "$k"; curl -s -o /dev/null -w '%{http_code}\n' "$url"
   done
   ```

4. **CloudFront sends the new value.** This prints the first 12 characters of the SHA-256 digest of the secret and of each origin's header, never a value:

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

A `403` in check 1 or 2 means the two sides still disagree.

- **An origin's digest differs from the secret's.** That origin does not send `$NEW`. Run its script again as in [Step 4](#step-4-point-cloudfront-at-the-new-secret), then wait as in Step 5.
- **All three digests match.** CloudFront is right, so look at the stack. This prints the secret name the stack uses, which should be the same name as `$NEW`:

  ```bash
  aws cloudformation describe-stacks --stack-name hfy-app \
    --query "Stacks[0].Parameters[?ParameterKey=='OriginVerifySecretName'].ParameterValue" --output text
  ```

  Do not assign its output to `OLD`. [Afterwards](#afterwards) and [Roll back](#roll-back) need `$OLD` to keep naming the old secret.

[Diagnose sign-in and API failures](diagnose-sign-in-and-api-failures.md#every-api-or-auth-request-gets-403-forbidden) compares the functions' values with the secret and covers the other causes.

## Afterwards

1. **Make the new name stick.** Four places still default to the old name: the `SECRET=` default in both behavior scripts, the `NAME=` default in `create-origin-verify.sh`, and the `OriginVerifySecretName` default in `app-stack.yaml`. A behavior script run without `--secret-name` writes the old value back into its origin, and every request on that script's paths gets a `403` until it is fixed. Either pass `--secret-name` on every run from now on, or change all four defaults in one pull request. If you change the defaults, also update the secret name where the docs cite it: [Private data and secrets](../reference/private-data-and-secrets.md), [API](../reference/api.md), [Identity services](../reference/identity-services.md), [Architecture reference](../reference/architecture.md), [Repository operations](../reference/repository-operations.md) and [Deploy the app stack](deploy-the-app-stack.md). `grep -rl 'harrisonfamily/cloudfront/origin-verify' docs/` lists every page that cites it. Later stack deploys keep the current parameter value unless they override it, so the template default only matters for a new stack.
2. **Delete the distribution backups from Step 4.** Each real run saved one under `${HFY_CF_BACKUP_DIR:-~/.local/state/hfy-infra/cloudfront}`, named `<distribution-id>-<UTC timestamp>-before.json`. They hold the old secret value, so once [Verify](#verify) passes, delete the two this rotation wrote.
3. **Schedule deletion of the old secret.** Do this only after every check in [Verify](#verify) passes. Each secret has a monthly charge, so keeping both costs money. First run `echo "$OLD -> $NEW"` and confirm that it prints two different names, the old one first.

   ```bash
   aws secretsmanager delete-secret --secret-id "$OLD" --recovery-window-in-days 7
   ```

   For seven days, `aws secretsmanager restore-secret --secret-id "$OLD"` brings it back. While it waits for deletion, nothing can read it. A behavior script run without `--secret-name` then fails with `cannot read secret` instead of writing the old value. The old name cannot be reused until the deletion completes.

## Roll back

While the old secret exists, you can go back to it with the same procedure. If you have already scheduled it for deletion, restore it first with `aws secretsmanager restore-secret --secret-id "$OLD"`. Until you do, nothing can read it, so neither the stack deploy nor the behavior scripts can use it.

1. Run the dry runs in Step 2 with `--secret-name "$OLD"`.
2. Run Step 3 with `OriginVerifySecretName="$OLD"`.
3. Run Step 4 with `--secret-name "$OLD"`.
4. Wait as in Step 5, then run [Verify](#verify), with `$OLD` in place of `$NEW` in check 4.

The rollback has its own `403` window. Afterwards, schedule deletion of the unused new secret.

## Related

- [Edge and origin design](../explanation/edge-and-origin-design.md): why each Lambda accepts one value, and what accepting two would cost.
- [Private data and secrets](../reference/private-data-and-secrets.md): the secret, where its value ends up, and who can read it.
- [Architecture reference](../reference/architecture.md): the `hfy-app` stack and its parameters.
- [Repository operations](../reference/repository-operations.md#cloudfront-behavior-scripts): what each behavior script run does, step by step.
- [Deploy the app stack](deploy-the-app-stack.md): the full stack deploy.
- [Rotate the session signing key](rotate-the-session-signing-key.md): the other secret the auth edge depends on.
