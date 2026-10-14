# How to rotate the Google sign-in client

The auth edge accepts a Google ID token only when its audience is the site's Google OAuth web client. This page replaces that client with a new one, for example to move it to another Google Cloud project, and then deletes the old one. To create the first client, follow step 7 of [Stand up the static site](stand-up-the-static-site.md#7-create-the-google-web-client). For how the edge checks the token, see [Identity services](../reference/identity-services.md). Since HFY-TSK-317 the edge is the only place that holds the client ID that matters: the pages carry no client ID and no Google script, and the `HFY_GOOGLE_CLIENT_ID` repository secret is no longer read by any workflow.

Values in angle brackets, such as `<site>`, `<app-stack>`, `<github-owner>`, `<github-repo>` and `<google-web-client-id>`, are placeholders. The forms are listed in [Private data and secrets](../reference/private-data-and-secrets.md#placeholders). The client ID is public, because the sign-in page at `/auth/login` carries it, but do not commit it.

## Before you start

- **Google sign-in fails for a short window.** One place holds the client ID: `hfy-auth-edge`, from the `GoogleClientId` parameter of `<app-stack>`. At startup the edge puts it into its in-memory copy of the manifest's `google` provider (`loadManifest` in [`auth/src/edge.js`](../../auth/src/edge.js); the committed [`edge.manifest.json`](../../auth/edge.manifest.json) keeps the `REPLACED_AT_RUNTIME_FROM_GOOGLE_CLIENT_ID` marker), so the edge's sign-in page at `/auth/login` and its token check always use the same ID.

  The edge changes in one step. After step 2, only an `/auth/login` page that was opened before it fails, and reloading it fixes that. Email-and-password and passkey sign-in on the edge are not affected, because neither uses the Google client. Edge sessions and MCP access tokens already issued keep working, because the edge signs them with its own key. The private data gate checks those sessions, not Google tokens, so it is not affected either.
- **The legacy Lambda keeps the old ID, on purpose.** The `hfy-check-allowed` function has its own `GOOGLE_CLIENT_ID` variable. It is on no sign-in path any more ([Identity services: Retired legacy sign-in](../reference/identity-services.md#retired-legacy-sign-in)), nothing in the repository sets its environment, and this page does not touch it. Once the old client is deleted, a direct call to `/api/check-allowed` with a token for the old client simply fails.
- **The old client is your way back.** Do not delete it until [Verify](#verify) passes.
- **io's go-ahead.** Step 2 is a CloudFormation deploy of the app stack, which [`AGENTS.md`](../../AGENTS.md) lists among the operations that need it.

You need:

- Access to the Google Cloud project that holds the current client, and to the project for the new one if it is different.
- AWS credentials, used by hand, that can:
  - update `<app-stack>` through a change set with `CAPABILITY_NAMED_IAM`: describe the stack, and create, describe, execute and delete change sets. CloudFormation acts with these credentials, so they also need the Lambda permissions to update `hfy-auth-edge`, `iam:PassRole` on `hfy-auth-edge-role`, because the update passes the function's `Role`, and `secretsmanager:GetSecretValue` on the origin-verify secret, which the stack resolves again when it updates the function.
  - get the configuration of `hfy-auth-edge` (`lambda:GetFunctionConfiguration`).

  The CI deploy role has no CloudFormation permissions and cannot update a function's configuration ([Architecture](../reference/architecture.md#harrisonfamily-github-roles)).
- The AWS CLI, `jq`, `openssl` and `curl`.

You do not need a checkout, unless step 2 prints `Function URLs CHANGED`: the fallback then runs a behavior script from one, with `ORIGIN_VERIFY` unset. Step 2 reuses the template the stack was last deployed with, and every parameter value except `GoogleClientId`, so the change set can change nothing but the client ID. The kept values include `CodeKey` and `AuthCodeKey`, the keys of the commit-named zips of `hfy-api` and `hfy-auth-edge`, so the change set ships no code. A change under `auth/src/` or to `auth/edge.manifest.json` that is not live yet, such as a new `theme.cssUrl` stamp, still needs [Deploy the app stack](deploy-the-app-stack.md).

## Set up your shell

Run every command in one shell.

```sh
export AWS_REGION=us-west-2
OLD_ID=$(aws cloudformation describe-stacks --stack-name <app-stack> \
  --query "Stacks[0].Parameters[?ParameterKey=='GoogleClientId'].ParameterValue" --output text)
```

`OLD_ID` is the client the stack uses now. You need it for [Undo](#undo). You set `NEW_ID` in step 1.

## Step 1: Create the new client

1. In the Google Cloud console, open the project for the new client. If it is a new project, set up **Google Auth Platform** as in step 7 of [Stand up the static site](stand-up-the-static-site.md#7-create-the-google-web-client): branding, audience **External**, and the app published.
2. Under **Clients**, create a client of type **Web application**. Give it the same authorized JavaScript origins as the old client: `https://<site>`, `https://www.<site>`, and `http://localhost` with `http://localhost:<port>` if you test locally. Leave the redirect URIs empty, and do not store the client secret.
3. Keep the new client ID:

   ```sh
   NEW_ID=<google-web-client-id>
   ```

Google can take from a few minutes to a few hours to apply a new client's settings. Until it does, Google sign-in with the new ID fails because the origin is not allowed for the client ID. Wait before step 2.

## Step 2: Point the auth edge at the new client

The stack passes `GoogleClientId` to `hfy-auth-edge` as `GOOGLE_CLIENT_ID`, and to nothing else ([`app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml)). The change goes through a CloudFormation change set: you create it, review it, and only then execute it.

### Create the change set

Build the parameter list from the stack itself: every parameter keeps its current value except `GoogleClientId`. The file is created outside any checkout.

```sh
PARAMS="$(mktemp)"
aws cloudformation describe-stacks --stack-name <app-stack> --query 'Stacks[0].Parameters' --output json \
  | jq --arg id "$NEW_ID" 'map(if .ParameterKey == "GoogleClientId"
      then {ParameterKey, ParameterValue: $id}
      else {ParameterKey, UsePreviousValue: true} end)' > "$PARAMS"
jq -r '.[] | select(.UsePreviousValue != true) | .ParameterKey' "$PARAMS"
```

The last command prints only `GoogleClientId`. Then create the change set from the stack's current template and wait for it:

```sh
CS="hfy-google-client-$(date -u +%Y%m%d%H%M%S)"
aws cloudformation create-change-set --stack-name <app-stack> --change-set-name "$CS" \
  --use-previous-template --capabilities CAPABILITY_NAMED_IAM \
  --parameters "file://$PARAMS" > /dev/null
aws cloudformation wait change-set-create-complete --stack-name <app-stack> --change-set-name "$CS"
rm -f "$PARAMS"
```

`CAPABILITY_NAMED_IAM` is required because the template names its roles. The `wait` command returns with no output once the change set is ready. If it reports `Waiter ChangeSetCreateComplete failed`, read the reason:

```sh
aws cloudformation describe-change-set --stack-name <app-stack> --change-set-name "$CS" \
  --query '[Status, StatusReason]' --output text
```

`FAILED` with a reason that starts `The submitted information didn't contain changes` means the stack already uses `$NEW_ID`. Delete the change set, as below, and go on to [Verify](#verify). For any other reason, delete it, fix the cause, and run this step again.

### Review the change set

```sh
aws cloudformation describe-change-set --stack-name <app-stack> --change-set-name "$CS" \
  --query "Parameters[?ParameterKey=='GoogleClientId'].ParameterValue" --output text
aws cloudformation describe-change-set --stack-name <app-stack> --change-set-name "$CS" \
  --query 'Changes[].ResourceChange.[Action, LogicalResourceId, ResourceType, Replacement]' --output text
```

The first command prints the new client ID, the same value as `$NEW_ID`. The second lists one row per resource, and for this change it lists only these, in any order:

```
Modify	AuthFunction	AWS::Lambda::Function	False
Modify	AuthFunctionUrl	AWS::Lambda::Url	Conditional
```

- `AuthFunction` (`hfy-auth-edge`) changes its environment in place, with no replacement.
- `AuthFunctionUrl` shows replacement `Conditional`, and that is expected. Its `TargetFunctionArn` is `!GetAtt AuthFunction.Arn`, which CloudFormation treats as dynamic while it computes the change set. An environment change keeps the function's ARN, so the URL stays. The output check below confirms it.

Do not execute the change set if it shows any other resource, any `Remove`, or a replacement of `True`. Delete it instead, which leaves the stack as it was:

```sh
aws cloudformation delete-change-set --stack-name <app-stack> --change-set-name "$CS"
```

Executing modifies `AuthFunction`, so CloudFormation also resolves the origin-verify secret again for `hfy-auth-edge` ([Architecture: `ORIGIN_VERIFY`](../reference/architecture.md#origin_verify)). Check that the secret still holds the value the function has. Neither value is printed:

```sh
OV_NAME="$(aws cloudformation describe-stacks --stack-name <app-stack> \
  --query "Stacks[0].Parameters[?ParameterKey=='OriginVerifySecretName'].ParameterValue" --output text)"
WANT="$(aws secretsmanager get-secret-value --secret-id "$OV_NAME" \
  --query SecretString --output text | openssl dgst -sha256)"
HAVE="$(aws lambda get-function-configuration --function-name hfy-auth-edge \
  --query Environment.Variables.ORIGIN_VERIFY --output text | openssl dgst -sha256)"
if [ "$HAVE" = "$WANT" ]; then echo "hfy-auth-edge: matches $OV_NAME"; else echo "hfy-auth-edge: DIFFERS from $OV_NAME"; fi
```

It must print `matches`. `DIFFERS`, or an error from any command, means stop: executing would give the auth edge a value that CloudFront does not send, and every `/auth/*` request would return `403`. Delete the change set and follow [Rotate the origin-verify secret](rotate-the-origin-verify-secret.md) first.

### Execute it and check the Function URLs

Record the two Function URL outputs first. No command here prints the URLs themselves:

```sh
fn_urls() {
  aws cloudformation describe-stacks --stack-name <app-stack> \
    --query "Stacks[0].Outputs[?OutputKey=='FunctionUrl' || OutputKey=='AuthFunctionUrl'].[OutputKey, OutputValue]" \
    --output text | sort
}
URLS_BEFORE="$(fn_urls)"
aws cloudformation execute-change-set --stack-name <app-stack> --change-set-name "$CS"
aws cloudformation wait stack-update-complete --stack-name <app-stack>
if [ "$(fn_urls)" = "$URLS_BEFORE" ]; then echo "Function URLs unchanged"; else echo "Function URLs CHANGED"; fi
```

The `wait` command returns with no output when the update is complete, and the last line must print `Function URLs unchanged`. `Function URLs CHANGED` means the auth edge's Function URL was replaced, and CloudFront still sends `/auth/*` to the old host, so every `/auth/*` request fails until the behavior is rewritten. From a checkout of `main`, rerun `add-auth-behavior.sh` as in [Deploy the app stack: Add the auth behaviors](deploy-the-app-stack.md#add-the-auth-behaviors). `OV_NAME` is already set in this shell. Run `unset ORIGIN_VERIFY` first, because the script uses that variable in preference to the secret. A real run of a behavior script needs io's go-ahead. If the `wait` reports `Waiter StackUpdateComplete failed`, the stack rolls back to the old client ID. See [Deploy the app stack: If the deploy fails](deploy-the-app-stack.md#if-the-deploy-fails).

## Verify

1. **The stack and the edge hold the new ID.**

   ```sh
   aws cloudformation describe-stacks --stack-name <app-stack> \
     --query "Stacks[0].Parameters[?ParameterKey=='GoogleClientId'].ParameterValue" --output text
   aws lambda get-function-configuration --function-name hfy-auth-edge \
     --query Environment.Variables.GOOGLE_CLIENT_ID --output text
   ```

   Both lines equal `$NEW_ID`.
2. **The sign-in page carries the new ID.**

   ```sh
   curl -s "https://<site>/auth/login" | grep -cF "data-client_id=\"$NEW_ID\""
   ```

   It does not print `0`. It reads the Google configuration that `hfy-auth-edge` renders into its sign-in page, which Cloudflare does not cache.
3. **Edge sign-in works.** In a private window, open `https://<site>/auth/login` and sign in with Google, using an allowlisted account. Then open `https://<site>/auth/session` in the same window. It shows `authenticated` as `true`.
4. **Delete the old client.** Once checks 1 to 3 pass, delete the client whose ID is `$OLD_ID` in the Google Cloud console.

| Symptom | Likely cause |
| --- | --- |
| Google sign-in fails because the origin is not allowed for the client ID | The new client is missing that origin, or Google has not applied its settings yet. On `/auth/login` only, `hfy-auth-edge` may also run a build with `@io-kit/auth` older than 2.1.2, which sends `Referrer-Policy: no-referrer`, so Google cannot see the page's origin. `curl -s -D - -o /dev/null https://<site>/auth/login \| grep -i '^referrer-policy'` must show `strict-origin-when-cross-origin`. If it shows `no-referrer`, redeploy `hfy-auth-edge` from `main` through [Deploy the app stack](deploy-the-app-stack.md), because step 2 keeps the code the function runs now. See [Identity services: Page theme and HFY overrides](../reference/identity-services.md#page-theme-and-hfy-overrides). |
| `/auth/google` returns `401 {"code":"AUTH_EXPIRED","detail":"wrong_audience"}` | The stack still has the old `GoogleClientId`, or the browser still has a sign-in page with the old ID. Reload the page. |
| `/auth/login` still carries the old ID | The stack update did not finish, or it rolled back. Check 1 shows the value `hfy-auth-edge` has. Run step 2 again. |
| Every `/auth/*` request returns `403 {"error":"forbidden"}` after step 2 | The update gave `hfy-auth-edge` an origin-verify value that CloudFront does not send. See [Diagnose sign-in and API failures](diagnose-sign-in-and-api-failures.md#every-api-or-auth-request-gets-403-forbidden). |

## Undo

Use this only while the old client still exists. Repeat step 2 with `NEW_ID="$OLD_ID"`, then run [Verify](#verify) checks 1 to 3. Delete the new client afterwards if you no longer need it.

## Related pages

- [Stand up the static site](stand-up-the-static-site.md): creating the first client.
- [Deploy the app stack](deploy-the-app-stack.md): the `GoogleClientId` parameter, the change set procedure for `<app-stack>`, and redeploying `hfy-auth-edge`.
- [Architecture](../reference/architecture.md#app-stack): the stack's parameters and outputs, and what a change set to it shows.
- [Identity services](../reference/identity-services.md): how the edge checks the Google ID token, the edge's sign-in page headers, and the passkey and password providers.
- [Diagnose sign-in and API failures](diagnose-sign-in-and-api-failures.md).
