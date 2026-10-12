# How to turn on push notifications

Members can save notification preferences on `/me/notifications/` as soon as `notifyV2` is on, but `hfy-api` sends a push only when it has a VAPID key pair. Without one it stores subscriptions and preferences and sends nothing. Use this page to create the key pair, give it to the API, and confirm that a push arrives. It also covers turning push off again and replacing the key pair.

For what a notification says and who receives it, see [API: Notifications](../reference/api.md#notifications). For why the default message carries no content, see [How member content stays accountable](../explanation/member-content-design.md#notifications-that-say-little).

Values in angle brackets are placeholders. `<vapid-secret-name>` is the Secrets Manager name you choose for the key pair, for example `harrisonfamily/api/vapid`. `<vapid-subject>` is the contact that push services may use to reach the sender: a `mailto:` address or an `https://` URL. Other forms are listed in [Private data and secrets](../reference/private-data-and-secrets.md#placeholders).

## Before you start

- **The app stack is deployed** ([Deploy the app stack](deploy-the-app-stack.md)), and you have a clean checkout of the commit it was last deployed from, so that the stack deploy below changes nothing but this setting.
- **io's go-ahead.** A CloudFormation deploy of `hfy-app` needs it ([`AGENTS.md`](../../AGENTS.md)).
- **Operator AWS credentials** in `us-west-2` that can create and read a Secrets Manager secret, deploy the `hfy-app` stack with `CAPABILITY_NAMED_IAM`, and read the `hfy-api` function's configuration and logs.
- **Node 22 or later, `jq` and the AWS CLI.** The key pair is generated with the public `web-push` package, the same version the API uses, so no private registry token is needed.

```sh
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2
```

## Steps

### 1. Create the key pair in Secrets Manager

Check that the name is free. This must fail with `ResourceNotFoundException`:

```sh
aws secretsmanager describe-secret --secret-id "<vapid-secret-name>"
```

Generate the keys into a private temporary directory, build the secret from them, and store it. The private key goes from file to file and is never printed or put on a command line:

```sh
(
  umask 077
  TMP="$(mktemp -d)"
  npx --yes web-push@3.6.7 generate-vapid-keys --json > "$TMP/keys.json"
  jq --arg s "<vapid-subject>" '{subject: $s, publicKey: .publicKey, privateKey: .privateKey}' \
    "$TMP/keys.json" > "$TMP/secret.json"
  aws secretsmanager create-secret --name "<vapid-secret-name>" \
    --description "hfy-api web push VAPID key pair" \
    --secret-string "file://$TMP/secret.json" --query Name --output text
  rm -rf "$TMP"
)
```

The last command prints the secret's name. The value has the shape `hfy-api` expects: JSON `{subject, publicKey, privateKey}` ([`api/src/index.js`](../../api/src/index.js)).

### 2. Point the stack at the secret

```sh
aws cloudformation deploy --stack-name hfy-app \
  --template-file infrastructure/cloudformation/app-stack.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides VapidSecretName="<vapid-secret-name>"
```

Every parameter you leave out keeps the stack's current value. A non-empty `VapidSecretName` turns on the stack's `HasVapid` condition, which sets `VAPID_SECRET` on `hfy-api` and lets its role read that one secret ([System architecture](../reference/architecture.md#conditions)). The environment change starts new containers, and each one loads the keys on its first request. If the deploy fails, see [Deploy the app stack](deploy-the-app-stack.md#if-the-deploy-fails).

### 3. Check that browsers can receive pushes

Delivery in the browser runs in the site's service worker, which the shell island registers, and which imports the kit's push handler from the committed bundles. This prints `200`:

```sh
curl -s -o /dev/null -w '%{http_code}\n' "https://<site>/js/islands/notify-sw.js"
```

Members reach the settings page with `notifyV2` and get the service worker with `shellV2`. To try it in your own browser first, use the per-tab override in [Toggle a feature flag](toggle-a-feature-flag.md#turn-a-flag-on-in-one-browser-tab).

## Verify

1. **The function has the setting.**

   ```sh
   aws lambda get-function-configuration --function-name hfy-api \
     --query 'Environment.Variables.VAPID_SECRET' --output text
   ```

   It prints `<vapid-secret-name>`.
2. **The keys loaded.** A new container loads them on its first request that passes the origin check, signed in or not. Send one, then check the log. The `curl` prints `401`, and the log command prints nothing:

   ```sh
   curl -s -o /dev/null -w '%{http_code}\n' "https://<site>/api/posts"
   aws logs tail /aws/lambda/hfy-api --since 15m --filter-pattern '"push disabled"'
   ```

   A `push disabled` line means the secret could not be read or parsed. Check the name and the JSON shape.
3. **The API serves the public key.** Signed in at `https://<site>/auth/login`, run this in the browser console on the site:

   ```js
   (await (await fetch('/api/notifications/vapid-public-key', { credentials: 'include' })).json()).public_key
   ```

   It prints the same value as this command, which reads only the public half:

   ```sh
   aws secretsmanager get-secret-value --secret-id "<vapid-secret-name>" \
     --query SecretString --output text | jq -r .publicKey
   ```

   An empty string means the function has not loaded the keys yet.
4. **A push arrives.** In a browser with `?hfy_flags=shellV2,notifyV2`, signed in at `/auth/login`, open `/me/notifications/`, turn push on and allow notifications. Then have another member comment on your person record, with `personV2` on in their tab. A notification arrives that says "Someone commented on your record.", unless you chose the detailed level for that type. Clear the override afterwards with `?hfy_flags=`.

## Turn push off

Deploy the stack as in step 2 with `VapidSecretName=""`. The function stops sending, and the API stops reading for recipients. Subscriptions and preferences stay in the table, so turning push on again with the same key pair resumes delivery.

## Replace the key pair

Browsers bind each push subscription to the public key it was created with, so a new key pair stops delivery to every existing subscription until its member subscribes again from `/me/notifications/`. Replace the keys only when the private key may have leaked.

1. Repeat step 1 with a new `<vapid-secret-name>`. A new name, not a new value under the old one, makes the stack deploy change the function's environment, so every container picks up the new keys at once.
2. Repeat step 2 with the new name, then run [Verify](#verify).
3. Ask members to turn push on again on `/me/notifications/`.
4. Once the new keys work, schedule the old secret for deletion with `aws secretsmanager delete-secret --secret-id "<old-vapid-secret-name>"`, which keeps it recoverable for 30 days.

## Related pages

- [API reference](../reference/api.md#notifications): types, levels, recipients, payload and the notification routes.
- [Private data and secrets](../reference/private-data-and-secrets.md#secrets-manager): the VAPID secret among the others.
- [Front end](../reference/front-end.md#service-worker): the service worker that delivers the push.
- [Deploy the app stack](deploy-the-app-stack.md), [Toggle a feature flag](toggle-a-feature-flag.md), [Diagnose sign-in and API failures](diagnose-sign-in-and-api-failures.md).
