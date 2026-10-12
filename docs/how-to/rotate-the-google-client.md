# How to rotate the Google sign-in client

Both sign-in paths accept a Google ID token only when its audience is the site's Google OAuth web client. This page replaces that client with a new one, for example to move it to another Google Cloud project, and then deletes the old one. To create the first client, follow step 7 of [Stand up the static site](stand-up-the-static-site.md#7-create-the-google-web-client). For how each path checks the token, see [Identity services](../reference/identity-services.md).

Values in angle brackets, such as `<site>`, `<app-stack>`, `<github-owner>`, `<github-repo>` and `<google-web-client-id>`, are placeholders. The forms are listed in [Private data and secrets](../reference/private-data-and-secrets.md#placeholders). The client ID is public, because every deployed page carries it, but do not commit it: the repository keeps the placeholder.

## Before you start

- **Find out which path is the sign-in path.**

  ```sh
  curl -s https://<site>/_data/flags.json | jq .authV2
  ```

  `true` means the site sends members to the edge's sign-in page at `/auth/login`. `false` means they sign in on the legacy page at `/family-login/`. The production cutover to `authV2` ran on 2026-10-12 (HFY-TSK-069, HFY-R67). The legacy pieces are still deployed, and every push to `main` still ships them, so this page updates both paths whatever the check prints. Check 4 in [Verify](#verify) depends on the answer.
- **Google sign-in fails for a short window.** Three places hold the client ID, and each holds exactly one:
  - `hfy-auth-edge`, from the `GoogleClientId` parameter of `<app-stack>`. At startup the edge puts it into its in-memory copy of the manifest's `google` provider (`loadManifest` in [`auth/src/edge.js`](../../auth/src/edge.js); the committed [`edge.manifest.json`](../../auth/edge.manifest.json) keeps the `REPLACED_AT_RUNTIME_FROM_GOOGLE_CLIENT_ID` marker), so the edge's sign-in page at `/auth/login` and its token check always use the same ID.
  - the deployed pages, from the `HFY_GOOGLE_CLIENT_ID` repository secret. The legacy Google button on `/family-login/` uses it. While `authV2` is on, `/family-login/` sends a visitor who is not signed in to `/auth/login`, so the legacy button is reached only by a visitor already signed in at the edge, or when `/auth/session` does not answer ([Identity services](../reference/identity-services.md#legacy-sign-in-hfy-check-allowed)).
  - the legacy `hfy-check-allowed` Lambda, from its own `GOOGLE_CLIENT_ID` environment variable. It checks the legacy button's tokens.

  The edge changes in one step. After step 3, only an `/auth/login` page that was opened before it fails, and reloading it fixes that. On the legacy path, the pages and `hfy-check-allowed` disagree from step 4 until the run in step 5 finishes, and Google sign-in there fails. Run steps 3 to 5 back to back. Email-and-password and passkey sign-in on the edge are not affected, because neither uses the Google client. Edge sessions and MCP access tokens already issued keep working, because the edge signs them with its own key. The private data gate checks those sessions, not Google tokens, so it is not affected either.
- **The old client is your way back.** Do not delete it until [Verify](#verify) passes.
- **io's go-ahead.** Step 3 is a CloudFormation deploy of the app stack, which [`AGENTS.md`](../../AGENTS.md) lists among the operations that need it.

You need:

- Access to the Google Cloud project that holds the current client, and to the project for the new one if it is different.
- `gh`, authenticated with a token that has Secrets: write and Actions: write on the repository.
- AWS credentials, used by hand, that can:
  - update `<app-stack>` through a change set with `CAPABILITY_NAMED_IAM`: describe the stack, and create, describe, execute and delete change sets. CloudFormation acts with these credentials, so they also need the Lambda permissions to update `hfy-auth-edge`, `iam:PassRole` on `hfy-auth-edge-role`, because the update passes the function's `Role`, and `secretsmanager:GetSecretValue` on the origin-verify secret, which the stack resolves again when it updates the function.
  - get the configuration of `hfy-auth-edge` and `hfy-check-allowed`, and update the configuration of `hfy-check-allowed` (`lambda:GetFunctionConfiguration`, `lambda:UpdateFunctionConfiguration`).

  The CI deploy role has no CloudFormation permissions and cannot update a function's configuration ([Architecture](../reference/architecture.md#harrisonfamily-github-roles)).
- The AWS CLI, `jq`, `openssl` and `curl`.

You do not need a checkout, unless step 3 prints `Function URLs CHANGED`: the fallback then runs a behavior script from one, with `ORIGIN_VERIFY` unset. Step 3 reuses the template the stack was last deployed with, and every parameter value except `GoogleClientId`, so the change set can change nothing but the client ID. The kept values include `CodeKey` and `AuthCodeKey`, the keys of the commit-named zips of `hfy-api` and `hfy-auth-edge`, so the change set ships no code. A change under `auth/src/` or to `auth/edge.manifest.json` that is not live yet, such as a new `theme.cssUrl` stamp, still needs [Deploy the app stack](deploy-the-app-stack.md).

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

Google can take from a few minutes to a few hours to apply a new client's settings. Until it does, Google sign-in with the new ID fails because the origin is not allowed for the client ID. Wait before step 3.

## Step 2: Update the repository secret

```sh
gh secret set HFY_GOOGLE_CLIENT_ID --repo <github-owner>/<github-repo> --body "$NEW_ID"
```

Nothing changes for visitors until the deploy in step 5.

## Step 3: Point the auth edge at the new client

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

`FAILED` with a reason that starts `The submitted information didn't contain changes` means the stack already uses `$NEW_ID`. Delete the change set, as below, and go on to step 4. For any other reason, delete it, fix the cause, and run this step again.

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

## Step 4: Point the legacy Lambda at the new client

`hfy-check-allowed` is still deployed. The `lambda` target in [`ci.manifest.yaml`](../../ci.manifest.yaml) updates its code on every push to `main`, but nothing in the repository sets its environment, so the new ID reaches it only through this step.

`aws lambda update-function-configuration --environment` replaces the function's whole variable map. Read the current map, change only `GOOGLE_CLIENT_ID`, and write the whole map back. The files are created outside any checkout.

```sh
ENV_CUR="$(mktemp)"; ENV_NEW="$(mktemp)"
aws lambda get-function-configuration --function-name hfy-check-allowed \
  --query Environment --output json > "$ENV_CUR"
jq --arg id "$NEW_ID" '{Variables: (.Variables + {GOOGLE_CLIENT_ID: $id})}' "$ENV_CUR" > "$ENV_NEW"
diff <(jq -r '.Variables | keys[]' "$ENV_CUR") <(jq -r '.Variables | keys[]' "$ENV_NEW")
```

The `diff` compares variable names only and prints nothing when the two maps have the same names. If it prints anything, stop: the new map has lost or gained a variable. [Identity services](../reference/identity-services.md#legacy-sign-in-hfy-check-allowed) lists the variables the function reads. Then write the map back:

```sh
aws lambda update-function-configuration --function-name hfy-check-allowed \
  --environment "file://$ENV_NEW" --query LastUpdateStatus --output text
aws lambda wait function-updated --function-name hfy-check-allowed
rm -f "$ENV_CUR" "$ENV_NEW"
```

## Step 5: Redeploy the site

The deploy pipeline's build step writes the new ID into the pages, and the run invalidates the whole distribution and waits for it. Start a run on `main` by hand:

```sh
date -u +%Y-%m-%dT%H:%M:%SZ
gh workflow run io-kit-deploy.yml --repo <github-owner>/<github-repo> --ref main
```

The first line prints the time of the dispatch. A new run takes a few seconds to appear, so wait a moment, then find it among the dispatched runs on `main`:

```sh
gh run list --repo <github-owner>/<github-repo> --workflow io-kit-deploy.yml \
  --event workflow_dispatch --branch main --limit 1 --json databaseId,createdAt
```

Check that its `createdAt` is later than the time the first command printed. If it is earlier, the list still shows an older run: wait and list again. Then watch the run, with its `databaseId` as `<run-id>`:

```sh
gh run watch <run-id> --repo <github-owner>/<github-repo> --exit-status
```

The run rebuilds the release from `main` as it is, so it ships only what `main` already holds: the site, including its `flags.json`, and the code of `hfy-check-allowed`. It does not touch the function's environment, which step 4 set.

If the run fails, start with [Check authV2 after a failed deploy](roll-back-a-site-deploy.md#check-authv2-after-a-failed-deploy). A failed `smoke` job makes the pipeline put back the previous release, with the old ID and that release's `flags.json`. While the private data gate is attached, a `flags.json` with `authV2` false shuts every visitor out of the family data. That check tells you whether to remove the gate or to leave it attached and fix forward, which depends on the code `HFYAppendIndex` runs. Then follow [Roll back a site deploy: After an automatic rollback](roll-back-a-site-deploy.md#after-an-automatic-rollback), or for other failures the table in [Deploy a site change](deploy-a-site-change.md#3-watch-the-runs), and run this step again once the cause is fixed.

## Verify

1. **The stack and both functions hold the new ID.**

   ```sh
   aws cloudformation describe-stacks --stack-name <app-stack> \
     --query "Stacks[0].Parameters[?ParameterKey=='GoogleClientId'].ParameterValue" --output text
   for fn in hfy-auth-edge hfy-check-allowed; do
     aws lambda get-function-configuration --function-name "$fn" \
       --query Environment.Variables.GOOGLE_CLIENT_ID --output text
   done
   ```

   Each of the three lines equals `$NEW_ID`.
2. **Both sign-in pages carry the new ID.**

   ```sh
   curl -s "https://<site>/auth/login" | grep -cF "data-client_id=\"$NEW_ID\""
   curl -s "https://<site>/family-login/" | grep -cF "$NEW_ID"
   ```

   Neither command prints `0`. The first reads the Google configuration that `hfy-auth-edge` renders into its sign-in page. The second reads the client ID in the legacy page's inline configuration, which the run in step 5 wrote. Neither page is cached at Cloudflare.
3. **Edge sign-in works.** In a private window, open `https://<site>/auth/login` and sign in with Google, using an allowlisted account. Then open `https://<site>/auth/session` in the same window. It shows `authenticated` as `true`.
4. **Legacy sign-in works.** Run the `authV2` check from [Before you start](#before-you-start) again.
   - If it prints `false`, open `https://<site>/family-login/` in a private window and sign in with Google, using an allowlisted account. The page takes you to your record at `/person/?id=...`.
   - If it prints `true`, use the same private window as check 3, where you are signed in at the edge. Open `https://<site>/family-login/`. It does not send you on to `/auth/login`, and it shows the legacy Google button without the One Tap prompt. Sign in with the button, using the same account. The page posts the token to `/api/check-allowed` and takes you to your record at `/person/?id=...`. This exercises the client ID in the page configuration that step 5 wrote, and `hfy-check-allowed`'s `GOOGLE_CLIENT_ID`.
5. **Delete the old client.** Once checks 1 to 4 pass, delete the client whose ID is `$OLD_ID` in the Google Cloud console.

| Symptom | Likely cause |
| --- | --- |
| Google sign-in fails because the origin is not allowed for the client ID | The new client is missing that origin, or Google has not applied its settings yet. On `/auth/login` only, `hfy-auth-edge` may also run a build with `@io-kit/auth` older than 2.1.2, which sends `Referrer-Policy: no-referrer`, so Google cannot see the page's origin. `curl -s -D - -o /dev/null https://<site>/auth/login \| grep -i '^referrer-policy'` must show `strict-origin-when-cross-origin`. If it shows `no-referrer`, redeploy `hfy-auth-edge` from `main` through [Deploy the app stack](deploy-the-app-stack.md), because step 3 keeps the code the function runs now. See [Identity services: Page theme and HFY overrides](../reference/identity-services.md#page-theme-and-hfy-overrides). |
| `/auth/google` returns `401 {"code":"AUTH_EXPIRED","detail":"wrong_audience"}` | The stack still has the old `GoogleClientId`, or the browser still has a sign-in page with the old ID. Reload the page. |
| `/auth/login` still carries the old ID | The stack update did not finish, or it rolled back. Check 1 shows the value `hfy-auth-edge` has. Run step 3 again. |
| Every `/auth/*` request returns `403 {"error":"forbidden"}` after step 3 | The update gave `hfy-auth-edge` an origin-verify value that CloudFront does not send. See [Diagnose sign-in and API failures](diagnose-sign-in-and-api-failures.md#every-api-or-auth-request-gets-403-forbidden). |
| `/api/check-allowed` returns `500` after the Google sign-in | `hfy-check-allowed` still has the old `GOOGLE_CLIENT_ID`. Its logs show the token check failing. |
| `/api/check-allowed` returns `500` and the logs show an S3 or Secrets Manager error | Step 4 dropped a variable. Restore it with the same read-merge-write sequence. |
| `/family-login/` still carries the old ID | The run failed before the sync, its smoke check failed and it rolled back, or the secret was not updated. Check step 2 and the run. |
| `/js/auth.js?v=<sha8>` still carries the old ID | Cloudflare, which proxies the site, keeps static files for up to 4 hours, and the run's CloudFront invalidation does not purge it. The `?v` hashes the committed file, which holds the placeholder, so a new client ID does not change the script's URL ([Front end: Asset versions](../reference/front-end.md#asset-versions)). Sign-in is not affected, because the page's inline configuration sets the client ID and wins over the script's default. The copy goes when its Cloudflare cache time runs out. A Cloudflare purge removes it sooner, but needs io's go-ahead. |

## Undo

Use this only while the old client still exists. Repeat steps 2 to 5 with `NEW_ID="$OLD_ID"`, then run [Verify](#verify) checks 1 to 4. Delete the new client afterwards if you no longer need it.

## Related pages

- [Stand up the static site](stand-up-the-static-site.md): creating the first client.
- [Deploy the app stack](deploy-the-app-stack.md): the `GoogleClientId` parameter, the change set procedure for `<app-stack>`, and redeploying `hfy-auth-edge`.
- [Architecture](../reference/architecture.md#app-stack): the stack's parameters and outputs, and what a change set to it shows.
- [Identity services](../reference/identity-services.md): how the edge and the legacy Lambda check the Google ID token, the edge's sign-in page headers, and the passkey and password providers.
- [Roll back a site deploy](roll-back-a-site-deploy.md): the `authV2` check and the gate after a failed run.
- [Diagnose sign-in and API failures](diagnose-sign-in-and-api-failures.md).
