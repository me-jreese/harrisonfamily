# How to turn on push notifications

Members can save notification preferences on `/me/notifications/` as soon as `notifyV2` is on, but `hfy-api` sends a push only when it has a VAPID key pair. Without one it sends nothing, and the page saves preferences but cannot subscribe a device, because it has no public key to subscribe with. Use this page to create the key pair, give it to the API through a reviewed change set on the app stack, and confirm that a push arrives. It also covers turning push off again, replacing the key pair and correcting the key pair's subject.

For what a notification says and who receives it, see [API: Notifications](../reference/api.md#notifications). For why the default message carries no content, see [How member content stays accountable](../explanation/member-content-design.md#notifications-that-say-little).

Values in angle brackets are placeholders. `<app-stack>` is the name of the live app stack, and `<site>` is the site's host name. `<vapid-secret-name>` is the Secrets Manager name of the key pair: production uses `harrisonfamily/api/vapid`, and any other environment uses a name of its own. `<vapid-subject>` is the contact that push services may use to reach the sender, and it must be an `https://` URL, for example `https://<site>/`. `hfy-api` sends the subject to every push service with each push, inside the signed VAPID header, so an email address there would reach those services. The API passes the subject to `web-push` as given and does not check its form, so the commands on this page check it. Other forms are listed in [Private data and secrets](../reference/private-data-and-secrets.md#placeholders).

## Before you start

- **The app stack `<app-stack>` is deployed** ([Deploy the app stack](deploy-the-app-stack.md)). Step 2 reuses the template the stack was last deployed with and keeps every other parameter at its current value, so you need no checkout of the repository.
- **io's go-ahead.** Executing a change set on `<app-stack>` needs it ([`AGENTS.md`](../../AGENTS.md)).
- **Operator AWS credentials** in `us-west-2`. They must be able to:
  - create, describe, execute and delete change sets on `<app-stack>` with `CAPABILITY_NAMED_IAM`, and read its parameters, outputs and events. CloudFormation acts with these credentials, so they also need to update the role `hfy-api-role` and the function `hfy-api`, and to read the origin-verify secret, which the stack resolves again whenever it updates the function.
  - create, read, update and restore the VAPID secret in Secrets Manager, and, to [replace the key pair](#replace-the-key-pair), schedule the old one for deletion.
  - read the `hfy-api` function's configuration and its log group `/aws/lambda/hfy-api`, and, to [correct the subject](#correct-the-subject) or recycle the function, update that configuration.
  - to [turn push off](#turn-push-off), scan the stack's DynamoDB table, which counts the stored subscriptions.
- **Node 22 or later, `jq`, `openssl`, `curl` and the AWS CLI.** The key pair is generated with the public `web-push` package, the same version the API uses ([`api/package.json`](../../api/package.json)), so no private registry token is needed.
- **For [Verify](#verify) check 5, a browser that can receive web push, and a second member** who can sign in and comment.

```sh
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2
```

## Steps

Check first whether push is already on. This prints the stack's current `VapidSecretName`:

```sh
aws cloudformation describe-stacks --stack-name <app-stack> \
  --query "Stacks[0].Parameters[?ParameterKey=='VapidSecretName'].ParameterValue" --output text
```

An empty line means push is off: start at step 1. A secret name means push is on: run [Verify](#verify) against that name instead.

### 1. Create the key pair in Secrets Manager

Check whether the name is taken:

```sh
aws secretsmanager describe-secret --secret-id "<vapid-secret-name>" \
  --query '[Name,DeletedDate]' --output text
```

- A `ResourceNotFoundException` error means the name is free: create the key pair below.
- The name followed by `None` means a key pair is already stored there, for example from before push was turned off. Do not create another one. Check its subject as in [Verify](#verify) check 1, then go to step 2 with that name. Reusing the key pair keeps the subscriptions still stored for it valid ([Turn push off](#turn-push-off)).
- The name followed by a date means the secret is scheduled for deletion, for example the old one after [Replace the key pair](#replace-the-key-pair) step 4. `hfy-api` cannot read it, so step 2 would leave push off, and the name cannot be used for a new secret. To use it, restore it with `aws secretsmanager restore-secret --secret-id "<vapid-secret-name>"` and continue as for a stored key pair. Otherwise pick another name.

Generate the keys into a private temporary directory, build the secret from them, and store it. The block refuses a subject that is not an `https://` URL. The private key goes from file to file and is never printed or put on a command line:

```sh
(
  umask 077
  SUBJECT="<vapid-subject>"
  case "$SUBJECT" in https://?*) ;; *) echo "refusing: the subject must be an https:// URL" >&2; exit 1 ;; esac
  TMP="$(mktemp -d)"
  npx --yes web-push@3.6.7 generate-vapid-keys --json > "$TMP/keys.json"
  jq --arg s "$SUBJECT" '{subject: $s, publicKey: .publicKey, privateKey: .privateKey}' \
    "$TMP/keys.json" > "$TMP/secret.json"
  aws secretsmanager create-secret --name "<vapid-secret-name>" \
    --description "hfy-api web push VAPID key pair" \
    --secret-string "file://$TMP/secret.json" --query Name --output text
  rm -rf "$TMP"
)
```

The last command prints the secret's name. The value has the shape `hfy-api` expects: JSON `{subject, publicKey, privateKey}` ([`api/src/index.js`](../../api/src/index.js)). A `refusing:` line means nothing was created: set `SUBJECT` to an `https://` URL and run the block again.

### 2. Point the stack at the secret through a change set

Set the name the stack should use, and record the stack's two Function URLs, so that you can check after the update that neither changed:

```sh
VAPID_NAME="<vapid-secret-name>"
urls() {
  aws cloudformation describe-stacks --stack-name <app-stack> \
    --query "Stacks[0].Outputs[?OutputKey=='FunctionUrl' || OutputKey=='AuthFunctionUrl'].[OutputKey,OutputValue]" \
    --output text | sort
}
BEFORE="$(urls)"
```

Create the change set. It reuses the template the stack was last deployed with, sets `VapidSecretName` to `$VAPID_NAME`, and passes every other parameter as its previous value, so nothing else can change. That includes `CodeKey`, the commit-named package `lambda/hfy-api-<sha>.zip` that `hfy-api` runs: this change set ships no new code. A change to the notification wording in [`api/src/notify.js`](../../api/src/notify.js) reaches members only through a code deploy ([Deploy the app stack](deploy-the-app-stack.md)).

```sh
PARAMS="$(aws cloudformation describe-stacks --stack-name <app-stack> \
  --query 'Stacks[0].Parameters[].ParameterKey' --output json \
  | jq -c --arg v "$VAPID_NAME" 'map(if . == "VapidSecretName"
      then {ParameterKey: ., ParameterValue: $v}
      else {ParameterKey: ., UsePreviousValue: true} end)')"
aws cloudformation create-change-set --stack-name <app-stack> --change-set-name hfy-vapid \
  --use-previous-template --capabilities CAPABILITY_NAMED_IAM --parameters "$PARAMS" >/dev/null
aws cloudformation wait change-set-create-complete --stack-name <app-stack> --change-set-name hfy-vapid
```

The `wait` command returns with no output once the change set is ready.

- If `create-change-set` reports `AlreadyExistsException`, an earlier `hfy-vapid` change set was never executed. Delete it with `aws cloudformation delete-change-set --stack-name <app-stack> --change-set-name hfy-vapid` and create it again.
- If the `wait` fails, read the reason with `aws cloudformation describe-change-set --stack-name <app-stack> --change-set-name hfy-vapid --query StatusReason --output text`. `The submitted information didn't contain changes` means the stack already uses `$VAPID_NAME`. Delete the change set and go to [Verify](#verify).

Review the change set:

```sh
aws cloudformation describe-change-set --stack-name <app-stack> --change-set-name hfy-vapid \
  --query 'Changes[].ResourceChange.[Action,LogicalResourceId,Replacement]' --output text
```

Expect these rows:

- `Modify Role False`: `hfy-api-role`. Its `hfy-api` policy gains the `Secrets` statement, which allows `secretsmanager:GetSecretValue` on this secret. The statement names it by the ARN pattern `<vapid-secret-name>-*`, so it also covers any other secret whose name begins with `<vapid-secret-name>-`. Give no other secret such a name. A non-empty `VapidSecretName` turns on the stack's `HasVapid` condition, which adds the statement ([Architecture](../reference/architecture.md#conditions)).
- `Modify Function False`: `hfy-api`. Its environment gains `VAPID_SECRET`.
- Possibly `Modify FunctionUrl Conditional`. The Function URL's target is `Function.Arn`, which CloudFormation treats as dynamic while `Function` is updated ([Architecture: Updating code](../reference/architecture.md#updating-code)). The update modifies the function in place, so the URL is kept. Another resource that only points at `hfy-api` may show `Conditional` for the same reason.

If any row shows `True`, or names a resource of the auth edge, the table or the user pool, delete the change set and stop.

Before you execute the change set, check that the origin-verify secret still holds the value that `hfy-api` has. Updating `Function` resolves that reference again ([Architecture: `ORIGIN_VERIFY`](../reference/architecture.md#origin_verify)), so a value changed in place since the function's last update would reach it now, and every request through CloudFront would get `403`. Neither value is printed:

```sh
OV_NAME="$(aws cloudformation describe-stacks --stack-name <app-stack> \
  --query "Stacks[0].Parameters[?ParameterKey=='OriginVerifySecretName'].ParameterValue" --output text)"
WANT="$(aws secretsmanager get-secret-value --secret-id "$OV_NAME" \
  --query SecretString --output text | openssl dgst -sha256)"
HAVE="$(aws lambda get-function-configuration --function-name hfy-api \
  --query Environment.Variables.ORIGIN_VERIFY --output text | openssl dgst -sha256)"
if [ "$HAVE" = "$WANT" ]; then echo "hfy-api: matches $OV_NAME"; else echo "hfy-api: DIFFERS from $OV_NAME"; fi
```

It must print `matches`. If it prints `DIFFERS`, or any command prints an error, delete the change set and follow [Rotate the origin-verify secret](rotate-the-origin-verify-secret.md) first.

Execute the change set and wait for the update:

```sh
aws cloudformation execute-change-set --stack-name <app-stack> --change-set-name hfy-vapid
aws cloudformation wait stack-update-complete --stack-name <app-stack>
```

The `wait` command returns with no output once the update is complete. If it reports a failure, the stack has rolled back and the previous configuration is still live. Read the reason:

```sh
aws cloudformation describe-stack-events --stack-name <app-stack> --max-items 15 \
  --query 'StackEvents[].[LogicalResourceId,ResourceStatus,ResourceStatusReason]' --output text
```

Then confirm that the Function URLs are unchanged:

```sh
if [ "$(urls)" = "$BEFORE" ]; then echo "Function URLs unchanged"; else echo "Function URLs CHANGED"; fi
```

It prints `Function URLs unchanged`. `CHANGED` means the CloudFront origins `hfy-api-origin` and `hfy-auth-origin` still point at the old hosts. Rerun the behavior scripts that write them, each with `--stack <app-stack>`: [`add-api-behavior.sh`](../../scripts/infra/add-api-behavior.sh) and [`add-mcp-behavior.sh`](../../scripts/infra/add-mcp-behavior.sh) for `FunctionUrl`, and [`add-auth-behavior.sh`](../../scripts/infra/add-auth-behavior.sh) for `AuthFunctionUrl` ([Deploy the app stack](deploy-the-app-stack.md)). A real run of a behavior script needs io's go-ahead.

The environment change starts new containers, and each one loads the keys on its first request.

### 3. Check that browsers can receive pushes

Delivery in the browser runs in the site's service worker. The shell island registers it at `/sw.js?v=<sha8>`, and the worker imports the kit's push handler, `/js/islands/notify-sw.js?v=<sha8>`, from the committed bundles ([Front end: Service worker](../reference/front-end.md#service-worker)). Cloudflare keeps static files for up to 4 hours under the URL they were first fetched at, so check the versioned URL the worker loads, not the bare path. This follows the version stamps from the home page to `notify-sw.js`:

```sh
asset_v() { awk '/const ASSET_V = /{sub(/.*= /, ""); on=1} on{print} on && /^ *};/{exit}' | sed 's/;$//'; }
ff=$(curl -s https://<site>/ | grep -o '/js/feature-flags.js?v=[0-9a-f]*' | head -n 1)
sw=$(curl -s "https://<site>$ff" | asset_v | jq -r .sw)
nv=$(curl -s "https://<site>/sw.js?v=$sw" | asset_v | jq -r .notify)
printf 'notify-sw '; curl -s -o /dev/null -w '%{http_code}\n' "https://<site>/js/islands/notify-sw.js?v=$nv"
```

It prints `notify-sw 200`. Anything else, or a `jq` error, means the deployed site lacks the push handler or its version stamps. Run the island bundle check in [Toggle a feature flag](toggle-a-feature-flag.md#check-the-prerequisites), check 1, which covers every island and says what each failure means.

Members get the settings page with `notifyV2` and the service worker with the shell, which `shellV2` turns on, and `searchV2` as well ([Front end: Feature flags](../reference/front-end.md#feature-flags)). Check the values the site publishes:

```sh
curl -s https://<site>/_data/flags.json | jq -c '{notifyV2, shell: (.shellV2 or .searchV2)}'
```

It prints `{"notifyV2":true,"shell":true}` when members can turn push on. On 2026-10-12, PR #8 (HFY-TSK-069) set every flag to `true`, but the values this command prints are what count. If either value is `false`, for example in a new environment or after a rollback, members cannot turn push on yet. Turn `notifyV2` or `shellV2` on for everyone with [Toggle a feature flag](toggle-a-feature-flag.md#turn-a-flag-on-for-everyone), which needs io's G-prod approval, or try push in your own tab first with the [per-tab override](toggle-a-feature-flag.md#turn-a-flag-on-in-one-browser-tab).

## Verify

1. **The subject is an `https://` URL.** This prints only the result of the check, never the keys:

   ```sh
   aws secretsmanager get-secret-value --secret-id "<vapid-secret-name>" \
     --query SecretString --output text | jq -r '.subject | startswith("https://")'
   ```

   It prints `true`. `false`, or a `jq` error, means the subject is missing or is not an `https://` URL. Follow [Correct the subject](#correct-the-subject).
2. **The function has the setting.**

   ```sh
   aws lambda get-function-configuration --function-name hfy-api \
     --query 'Environment.Variables.VAPID_SECRET' --output text
   ```

   It prints `<vapid-secret-name>`.
3. **The keys loaded.** A new container loads them on its first request that passes the origin check, signed in or not. Send one, then check the log. The `curl` prints `401`, and the log command prints nothing:

   ```sh
   curl -s -o /dev/null -w '%{http_code}\n' "https://<site>/api/posts"
   aws logs tail /aws/lambda/hfy-api --since 15m --filter-pattern '"push disabled"'
   ```

   The 15-minute window fits a check right after step 2, when every container is new. If push was already on when you started, the `curl` most likely reaches a warm container, and a container that failed may have logged it long before. Use `--since 1d` instead, as [Diagnose sign-in and API failures](diagnose-sign-in-and-api-failures.md#no-push-notifications-arrive) does.

   A `push disabled` line means that container could not read or parse the secret, and it will not try again (check 4). The rest of the line says why:

   - `is not authorized to perform` `secretsmanager:GetSecretValue`, right after step 2, means the role's new statement had not taken effect yet when the container started. IAM changes can take a short time to apply.
   - Anything else: check the name, and check the JSON shape as in [Diagnose sign-in and API failures](diagnose-sign-in-and-api-failures.md#no-push-notifications-arrive) check 2. Fix the secret in place under the same name.

   In both cases, recycle `hfy-api` with the `update-function-configuration --description` command in [Correct the subject](#correct-the-subject), so that new containers load the keys. Then run Verify again, with a `--since` window that starts after the recycle, for example `--since 5m`.

   A `403` from the `curl` means the function holds a different origin-verify value from the one CloudFront sends: see [Diagnose sign-in and API failures](diagnose-sign-in-and-api-failures.md#every-api-or-auth-request-gets-403-forbidden).
4. **The API serves the public key.** Signed in at `https://<site>/auth/login`, run this in the browser console on the site:

   ```js
   (await (await fetch('/api/notifications/vapid-public-key', { credentials: 'include' })).json()).public_key
   ```

   It prints the same value as this command, which prints only the public half:

   ```sh
   aws secretsmanager get-secret-value --secret-id "<vapid-secret-name>" \
     --query SecretString --output text | jq -r .publicKey
   ```

   An empty string means the container that answered has no public key: `VAPID_SECRET` is unset on it (check 2), its load failed (check 3), or the secret has no `publicKey`. Waiting does not help. Each container loads the keys once, on its first request that passes the origin check, and keeps the result, a failed load included, for as long as it runs. Fix the cause, then recycle `hfy-api` as in check 3.
5. **A push arrives.** The test uses the settings page, which needs the flags from step 3, and a comment on your own person page, which needs `personV2`. This prints `true` when the person page carries its comments:

   ```sh
   curl -s https://<site>/_data/flags.json | jq .personV2
   ```

   If a flag is off, add it to the [per-tab override](toggle-a-feature-flag.md#turn-a-flag-on-in-one-browser-tab) in the tab that needs it, for example `?hfy_flags=shellV2,notifyV2` for yours or `?hfy_flags=personV2` for the commenter's. Clear an override afterwards with `?hfy_flags=`.

   1. Sign in at `https://<site>/auth/login` and open `https://<site>/me/notifications/`.
   2. Turn on the **texts on this device** switch and allow notifications when the browser asks. On an iPhone or iPad, add the site to the home screen and open it from there first, as the page says.
   3. Leave **someone comments on my page** on, set to **hide the details**, which is the default.
   4. Have another member sign in at `/auth/login` and comment on your person page, `https://<site>/person/?id=<gramps-id>` with your own Gramps ID. Everyone who commented earlier on that page gets a notification as well ([API: Recipients of a new comment](../reference/api.md#recipients-of-a-new-comment)). The commenter can delete the comment afterwards.

   A notification arrives with the title "Harrison Family" and the text "someone commented on your page.". That holds while your page has no earlier comment of yours. If it has one, you count as an earlier commenter, so the push says "someone replied to you." and follows the **someone replies to me** setting, and a comment that mentions you as `@<gramps-id>` says "you were mentioned." ([API: Recipients of a new comment](../reference/api.md#recipients-of-a-new-comment)). With **show who** chosen for that type, it says "`<label>` commented on your page.", where the label is the commenter's display label, never an email address. Opening the notification goes to your person page. If nothing arrives, see [Diagnose sign-in and API failures](diagnose-sign-in-and-api-failures.md#no-push-notifications-arrive).

   The wording comes from the code `hfy-api` runs, so it changes only with a code deploy ([Deploy the app stack](deploy-the-app-stack.md)). A package built from a commit before PR #13 (HFY-TSK-084) still sends the earlier wording, "Someone commented on your record." under the title "Family tree". The lock-screen preview on `/me/notifications/` ships with the site instead, so after a site deploy it can show the new wording while the push still carries the old. The stack's `CodeKey` names the commit the function runs, as `lambda/hfy-api-<sha>.zip`:

   ```sh
   aws cloudformation describe-stacks --stack-name <app-stack> \
     --query "Stacks[0].Parameters[?ParameterKey=='CodeKey'].ParameterValue" --output text
   ```

   The repository does not record whether `hfy-api` was redeployed after PR #13 ([`AGENTS.md`](../../AGENTS.md)), so compare `<sha>` with `b617aff`, the PR #13 commit that changed the wording, in a checkout of the repository:

   ```sh
   git fetch -q origin
   SHA=<sha>
   if ! git cat-file -e "$SHA^{commit}" 2>/dev/null; then echo "unknown commit"
   elif git merge-base --is-ancestor b617aff "$SHA"; then echo "new wording"
   else echo "earlier wording"; fi
   ```

   `unknown commit` means the checkout lacks that commit. `CodeKey` names the running package only while nobody has pointed the function at another one directly ([Deploy the app stack](deploy-the-app-stack.md#4-deploy-the-stack)).

## Turn push off

Run step 2 with `VAPID_NAME=""`. The review shows the same two `Modify` rows, `Role` and `Function`, because the `Secrets` statement leaves `hfy-api-role` and `VAPID_SECRET` leaves the `hfy-api` environment, and `FunctionUrl` may again show `Conditional`. Check the origin-verify value before you execute the change set, and the Function URLs after, as in step 2.

The function stops sending, and the API stops reading for recipients. `GET /api/notifications/vapid-public-key` returns an empty `public_key`. Preferences and the secret stay. Subscriptions stay only for members who do not open `/me/notifications/` while push is off. On each visit by a signed-in member, the page compares the device's subscription with the public key the API serves ([`notifications.jsx`](../../islands/src/islands/notifications.jsx), `@io-kit/notify` `NotificationSettings`). An empty key never matches, so the page removes the subscription from the browser and from the table, and without a key it cannot subscribe the device again. The **texts on this device** switch then shows off.

Running step 2 again with the same name resumes delivery to the subscriptions that are left. Members whose subscription was removed turn the **texts on this device** switch on again once push is back. Keep the off period short. To see how many subscriptions it cost, count the stored subscriptions before you turn push off and again after you turn it back on. This prints a number, no names:

```sh
TABLE=$(aws cloudformation describe-stacks --stack-name <app-stack> \
  --query "Stacks[0].Outputs[?OutputKey=='TableName'].OutputValue" --output text)
aws dynamodb scan --table-name "$TABLE" --filter-expression 'begins_with(PK, :p)' \
  --expression-attribute-values '{":p": {"S": "SUB#"}}' --select COUNT --query Count
```

Each `SUB#` item is one device's subscription ([Architecture: Item layout](../reference/architecture.md#item-layout)). The count also falls when a push service reports a subscription gone or a subscription reaches its 90-day `ttl`.

## Replace the key pair

Browsers bind each push subscription to the public key it was created with, so a new key pair stops delivery to every existing subscription until its member opens `/me/notifications/` on that device. The page sees that the public key changed and subscribes the device again with the new key by itself, without a permission prompt. Replace the keys only when the private key may have leaked.

1. Repeat step 1 with a new `<vapid-secret-name>`. Choose a name that does not begin with the old name followed by `-`, and that no other secret's name begins with followed by `-`, because the `Secrets` statement covers every name that begins with the stack's secret name and `-` (step 2). A new name, not a new value under the old one, changes the function's environment, so the change set updates `hfy-api` and every container picks up the new keys at once.
2. Repeat step 2 with `VAPID_NAME` set to the new name. The review shows the same rows: the `Secrets` statement in `hfy-api-role` now names the new secret, and `VAPID_SECRET` changes. Then run [Verify](#verify).
3. Ask members to open `/me/notifications/` once on each device, signed in. The page subscribes again with the new public key by itself. The **texts on this device** switch needs no action unless it shows off.
4. Once the new keys work, schedule the old secret for deletion with `aws secretsmanager delete-secret --secret-id "<old-vapid-secret-name>"`, which keeps it recoverable for 30 days.

## Correct the subject

If [Verify](#verify) check 1 fails, the stored subject is missing or is not an `https://` URL. A subject that holds an email address sends that address to every push service with each push. Keep the keys, so that every subscription stays valid, and store them again under the same name with a corrected subject. The keys go from file to file and are never printed:

```sh
(
  umask 077
  SUBJECT="<vapid-subject>"
  case "$SUBJECT" in https://?*) ;; *) echo "refusing: the subject must be an https:// URL" >&2; exit 1 ;; esac
  TMP="$(mktemp -d)"
  aws secretsmanager get-secret-value --secret-id "<vapid-secret-name>" \
    --query SecretString --output text > "$TMP/old.json"
  jq --arg s "$SUBJECT" '.subject = $s' "$TMP/old.json" > "$TMP/secret.json"
  aws secretsmanager put-secret-value --secret-id "<vapid-secret-name>" \
    --secret-string "file://$TMP/secret.json" --query Name --output text
  rm -rf "$TMP"
)
```

The last command prints the secret's name. Each warm container keeps the value it loaded, and a change set has nothing to change because the name is the same. Recycle `hfy-api` instead. This changes only the function's description, which the stack does not manage, and starts new containers:

```sh
aws lambda update-function-configuration --function-name hfy-api \
  --description "reload VAPID keys" --query LastUpdateStatus --output text
aws lambda wait function-updated --function-name hfy-api
```

Then run [Verify](#verify) again. Members need not subscribe again, because the public key is unchanged.

## Related pages

- [API reference](../reference/api.md#notifications): types, levels, recipients, payload, the VAPID secret and the notification routes.
- [Architecture](../reference/architecture.md#app-stack): the stack's parameters, the `HasVapid` condition, and how a change set treats the Function URLs.
- [Private data and secrets](../reference/private-data-and-secrets.md#secrets-manager): the VAPID secret among the others.
- [Front end](../reference/front-end.md#service-worker): the service worker that delivers the push.
- [Why releases ship through a pipeline and feature flags](../explanation/release-model.md#why-the-app-lambdas-are-packaged-by-hand): why changes to the app stack go through a reviewed change set.
- [Deploy the app stack](deploy-the-app-stack.md), [Toggle a feature flag](toggle-a-feature-flag.md), [Diagnose sign-in and API failures](diagnose-sign-in-and-api-failures.md).
