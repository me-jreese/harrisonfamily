# How to rotate the Google sign-in client

Both sign-in paths accept a Google ID token only when its audience is the site's Google OAuth web client. This page replaces that client with a new one, for example to move it to another Google Cloud project, and then deletes the old one. To create the first client, follow step 7 of [Stand up the static site](stand-up-the-static-site.md#7-create-the-google-web-client). For how each path checks the token, see [Identity services](../reference/identity-services.md).

Values in angle brackets, such as `<site>`, `<github-owner>`, `<github-repo>` and `<google-web-client-id>`, are placeholders. The forms are listed in [Private data and secrets](../reference/private-data-and-secrets.md#placeholders). The client ID is public, because every deployed page carries it, but do not commit it: the repository keeps the placeholder.

## Before you start

- **Google sign-in fails for a short window.** Three places hold the client ID, and each holds exactly one:
  - the deployed pages, from the `HFY_GOOGLE_CLIENT_ID` repository secret;
  - `hfy-auth-edge`, from the `GoogleClientId` parameter of the `hfy-app` stack;
  - the legacy `hfy-check-allowed` Lambda, from its own `GOOGLE_CLIENT_ID` environment variable.

  From the first of steps 3 to 5 until the last, a page and its back end disagree, and Google sign-in on that path fails. Run the three steps back to back. Email-and-password sign-in on the edge is not affected, and edge sessions already issued keep working, because the edge signs them with its own key.
- **The old client is your way back.** Do not delete it until [Verify](#verify) passes.

You need:

- Access to the Google Cloud project that holds the current client, and to the project for the new one if it is different.
- `gh`, authenticated with a token that has Secrets: write and Actions: write on the repository.
- AWS credentials, used by hand, that can deploy the `hfy-app` stack with `CAPABILITY_NAMED_IAM`, and get and update the configuration of `hfy-check-allowed` (`lambda:GetFunctionConfiguration`, `lambda:UpdateFunctionConfiguration`). The CI deploy role can do neither ([Architecture](../reference/architecture.md#harrisonfamily-github-roles)).
- The AWS CLI, `jq` and `curl`.
- A checkout of the commit the `hfy-app` stack was last deployed from, normally `main`. The deploy in step 3 should change nothing but the client ID.

## Set up your shell

Run every command from the root of the checkout, in one shell.

```sh
export AWS_REGION=us-west-2
OLD_ID=$(aws cloudformation describe-stacks --stack-name hfy-app \
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

Google can take from a few minutes to a few hours to apply a new client's settings. Until it does, the sign-in button reports that the origin is not allowed for the client ID. Wait before step 3.

## Step 2: Update the repository secret

```sh
gh secret set HFY_GOOGLE_CLIENT_ID --repo <github-owner>/<github-repo> --body "$NEW_ID"
```

Nothing changes for visitors until the deploy in step 5.

## Step 3: Point the auth edge at the new client

```sh
aws cloudformation deploy --stack-name hfy-app \
  --template-file infrastructure/cloudformation/app-stack.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides GoogleClientId="$NEW_ID"
```

Every parameter you leave out keeps the stack's current value. The stack passes `GoogleClientId` to `hfy-auth-edge` as `GOOGLE_CLIENT_ID` ([`app-stack.yaml`](../../infrastructure/cloudformation/app-stack.yaml)). If the deploy fails, see [Deploy the app stack](deploy-the-app-stack.md#if-the-deploy-fails).

## Step 4: Point the legacy Lambda at the new client

Skip this step if `hfy-check-allowed` has been retired.

`aws lambda update-function-configuration --environment` replaces the function's whole variable map. Read the current map, change only `GOOGLE_CLIENT_ID`, and write the whole map back. The files are created outside the checkout.

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
gh workflow run io-kit-deploy.yml --repo <github-owner>/<github-repo> --ref main
gh run list --repo <github-owner>/<github-repo> --workflow io-kit-deploy.yml --limit 1
gh run watch <run-id> --repo <github-owner>/<github-repo> --exit-status
```

The run rebuilds the release from `main` as it is, so it ships nothing else. If its `smoke` job fails, the pipeline puts back the previous release, which still carries the old ID: see [Roll back a site deploy](roll-back-a-site-deploy.md#after-an-automatic-rollback). For other failures, see the table in [Deploy a site change](deploy-a-site-change.md#3-watch-the-runs).

## Verify

1. **The stack and both functions hold the new ID.**

   ```sh
   aws cloudformation describe-stacks --stack-name hfy-app \
     --query "Stacks[0].Parameters[?ParameterKey=='GoogleClientId'].ParameterValue" --output text
   for fn in hfy-auth-edge hfy-check-allowed; do
     aws lambda get-function-configuration --function-name "$fn" \
       --query Environment.Variables.GOOGLE_CLIENT_ID --output text
   done
   ```

   Each of the three lines equals `$NEW_ID`.
2. **The pages carry the new ID.**

   ```sh
   curl -s "https://<site>/js/auth.js" | grep -c "$NEW_ID"
   curl -s "https://<site>/family-login/" | grep -c "$NEW_ID"
   ```

   Neither command prints `0`.
3. **Legacy sign-in works.** While `authV2` is off, open `https://<site>/family-login/` in a private window and sign in with Google, using an allowlisted account. The page takes you to your record at `/person/?id=...`.
4. **Edge sign-in works.** In a private window, open `https://<site>/auth/login` and sign in with Google. Then open `https://<site>/auth/session` in the same window. It shows `"authenticated": true`.
5. **Delete the old client.** Once steps 1 to 4 pass, delete the client whose ID is `$OLD_ID` in the Google Cloud console.

| Symptom | Likely cause |
| --- | --- |
| The sign-in button reports that the origin is not allowed for the client ID | The new client is missing that origin, or Google has not applied its settings yet |
| `/auth/google` returns `401` with `wrong_audience` | The stack still has the old `GoogleClientId`, or the browser still has a page with the old ID. Reload the page. |
| `/api/check-allowed` returns `500` after the Google sign-in | `hfy-check-allowed` still has the old `GOOGLE_CLIENT_ID`. Its logs show the token check failing. |
| `/api/check-allowed` returns `500` and the logs show an S3 or Secrets Manager error | Step 4 dropped a variable. Restore it with the same read-merge-write sequence. |
| A page still carries the old ID | The run failed before the sync, its smoke check failed and it rolled back, or the secret was not updated. Check step 2 and the run. |

## Undo

Use this only while the old client still exists. Repeat steps 2 to 5 with `NEW_ID="$OLD_ID"`, then run [Verify](#verify) steps 1 to 4. Delete the new client afterwards if you no longer need it.

## Related pages

- [Stand up the static site](stand-up-the-static-site.md): creating the first client.
- [Deploy the app stack](deploy-the-app-stack.md): the `GoogleClientId` parameter and the stack deploy.
- [Identity services](../reference/identity-services.md): how the edge and the legacy Lambda check the Google ID token.
- [Diagnose sign-in and API failures](diagnose-sign-in-and-api-failures.md).
