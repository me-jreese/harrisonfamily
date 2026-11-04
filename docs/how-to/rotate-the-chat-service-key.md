# How to rotate the chat service key

The chat hub signs every call it makes to `hfy-api` (the directory, content-free pushes and the archive mirror) with an ES256 key. The private half is the Worker secret `CHAT_SERVICE_PRIVATE_KEY` and the `kid` is the Worker var `CHAT_SERVICE_KID`. `hfy-api` trusts the public halves listed in the app-stack parameter `ChatServicePublicKeys` and picks the one whose `kid` equals the token's. This page replaces the key without a gap in which the hub's calls fail: it adds the new public half next to the old one, deploys the Worker with the new key and `kid`, waits, proves the new key, and only then removes the old entry. [Deploy the Worker to production](deploy-the-chat-worker.md#deploy-the-worker-to-production) sets the first key; this page is the later change.

Values in angle brackets are placeholders. The forms are listed in [Private data and secrets](../reference/private-data-and-secrets.md#placeholders).

## How the key is checked

- The hub signs a fresh token for each API call, with `iss` `hfy-chat`, `aud` `hfy-api/chat`, `sub` `chat-hub` and a lifetime of at most 60 seconds. No token outlives a rotation step by more than that.
- `hfy-api` reads `ChatServicePublicKeys` on every call, finds the entry with the token's `kid`, and verifies the signature with that entry alone. An unknown `kid`, a wrong signature and an empty or malformed parameter are the same `401` ([API: the chat service routes](../reference/api.md#the-chat-service-routes)). A malformed value refuses every call and is logged as `ChatServicePublicKeys unusable`.
- The array may hold any number of entries, so two keys can be trusted at once. The first entry with a matching `kid` wins, which is why a `kid` is never reused.
- Cloudflare defers a Durable Object's code update by default: an active object keeps running its existing version for up to 5 minutes, or until it hibernates, before it adopts a new one. The hub's secret and `kid` are part of that version, so after the Worker deploy it can keep signing with the old key for a few minutes. That is the reason the old entry stays until you have waited.

## Before you start

- **io's go-ahead, in the session or in the dispatch or plan that authorizes it.** The Worker deploy replaces a secret, and both parameter changes need io's G-prod approval ([Deploy the Worker to production: Prerequisites](deploy-the-chat-worker.md#prerequisites)). Post each `describe-change-set` summary before you execute it.
- **Why you are rotating decides the pace.**
  - After a suspected exposure of the private half (a secrets file left on disk, a terminal scrollback or a log that held it), do every step in one sitting and remove the old entry as soon as the wait in step 5 has passed. The old entry is what a leaked key still opens: with it, someone can call the directory, push and archive routes until it goes.
  - For a planned rotation, keep both entries until the new key is proven (step 6). The design sets no schedule for the service key.
- **A new `kid` that was never used.** Take the next number after the ones in use, and check that no commit has ever named it (step 1). Never reuse a `kid`, not even one that was removed.
- **The same tools and credentials as the production deploy:** wrangler 4.145.0 through `npx`, the Cloudflare credential in the shell environment, AWS credentials for `us-west-2` that can create and execute a change set on `<app-stack>` and read the `hfy-api` log group (`logs:FilterLogEvents`), Node 22 or later, `jq`, `curl`, `git`, and a CodeArtifact token for the rebuild in step 1 ([Deploy the Worker to production: Prerequisites](deploy-the-chat-worker.md#prerequisites)).
- **No other Worker deploy between step 1 and step 4.** From the merge in step 1 until step 4 finishes, `main` names a `kid` that the live Worker's secret does not match, so an ordinary redeploy from `main` would leave the hub signing with a key under the wrong name.

## 1. Choose the new `kid` and commit it

```sh
aws cloudformation describe-stacks --stack-name <app-stack> \
  --query "Stacks[0].Parameters[?ParameterKey=='ChatServicePublicKeys'].ParameterValue" --output text | jq -r '.[].kid'
git log --oneline -S'"hfy-chat-2"' -- chat-worker/wrangler.toml
```

The first command lists the `kid`s the API trusts now (`hfy-chat-1` after the first deploy). Pick the next number, here `hfy-chat-2`. The second command, with your choice in the quotes, must print nothing: if it prints a commit, that `kid` was used before, so take the next number.

In a worktree, set the top-level `CHAT_SERVICE_KID` in `chat-worker/wrangler.toml` (the one under `[vars]`, not the staging value) to the new `kid`, then rebuild and check:

```sh
cd chat-worker
npm ci && npm run build && npm run check && npm test
```

The build rewrites `dist/deploy.json` (the bundle itself is unchanged). Commit both files, and merge to `main` by the usual pull request. Every deploy replaces the vars with the ones in `wrangler.toml`, so the `kid` has to be committed: a `--var` on one deploy would be undone by the next.

## 2. Make the new pair

Run [step 1](deploy-the-chat-worker.md#1-check-out-the-commit-and-check-the-bundle) and [step 2](deploy-the-chat-worker.md#2-derive-the-production-config) of the production deploy on the merged `main` commit. They check the bundle and define `SHA`, `WORK`, `wr` and the derived config, and leave you in `chat-worker/`. Then save the key script exactly as [step 3](deploy-the-chat-worker.md#3-make-the-service-key-and-deploy) does (the `cat > "$WORK/make-service-key.mjs"` block), and make the pair without deploying:

```sh
export SECRETS_FILE="$WORK/secrets.json" PUBLIC_FILE="$WORK/chat-service-public-keys.json"
export KID="$(sed -n 's/^CHAT_SERVICE_KID = "\(.*\)"$/\1/p' wrangler.toml | head -1)"
echo "$KID"
node "$WORK/make-service-key.mjs"
```

`echo` must print the new `kid`. The `kid` comes from the committed file, so the pair and the Worker's `CHAT_SERVICE_KID` cannot drift. The private half is now in the `0600` secrets file and nowhere else; the public half is in `$PUBLIC_FILE`. If you abandon the rotation here, remove the scratch directory as in step 8.

## 3. Add the new public half next to the old one

```sh
aws cloudformation describe-stacks --stack-name <app-stack> \
  --query "Stacks[0].Parameters[?ParameterKey=='ChatServicePublicKeys'].ParameterValue" --output text > "$WORK/previous-keys.json"
jq -c --slurpfile add "$PUBLIC_FILE" '. + $add[0]' "$WORK/previous-keys.json" > "$WORK/merged-keys.json"
jq -r '.[].kid' "$WORK/merged-keys.json"
```

The last command prints the old `kid` and then the new one. Keep `previous-keys.json` until step 7 is verified: it is public, and it is how you put the old entry back.

Make and review the change set as in [step 6](deploy-the-chat-worker.md#6-trust-the-keys-public-half-in-the-app-stack) of the production deploy, reading `$WORK/merged-keys.json` where that step reads `$PUBLIC_FILE`:

```sh
aws cloudformation describe-stacks --stack-name <app-stack> --query 'Stacks[0].Parameters[].ParameterKey' --output json \
  | jq --arg v "$(cat "$WORK/merged-keys.json")" '[.[] | if . == "ChatServicePublicKeys" then {ParameterKey: ., ParameterValue: $v} else {ParameterKey: ., UsePreviousValue: true} end]' \
  > "$WORK/params.json"
CS="$(aws cloudformation create-change-set --stack-name <app-stack> \
  --change-set-name "hfy-chat-service-keys-$(date -u +%Y%m%d%H%M)" \
  --use-previous-template --parameters "file://$WORK/params.json" \
  --capabilities CAPABILITY_NAMED_IAM --query Id --output text)"
aws cloudformation wait change-set-create-complete --change-set-name "$CS"
aws cloudformation describe-change-set --change-set-name "$CS" \
  --query 'Changes[].ResourceChange.[Action, LogicalResourceId, ResourceType, Replacement]' --output text
```

The review is the same as there: exactly `Modify Function ... False` and `Modify FunctionUrl ... Conditional`, no `Remove`, no replacement of `True`, and the `FunctionUrl` and `AuthFunctionUrl` outputs unchanged after it executes ([Execute it and check the Function URLs](deploy-the-app-stack.md#execute-it-and-check-the-function-urls)). Discard the change set with `aws cloudformation delete-change-set --change-set-name "$CS"` if it differs. After it executes, the `kid` list shows both entries. The hub is still signing with the old key, and the API still accepts it, so nothing has changed for members.

## 4. Deploy the Worker with the new key

Note the time in milliseconds first, then deploy the merged commit's bundle with the secrets file you made in step 2:

```sh
START_MS=$(( $(date +%s) * 1000 ))
(
  set -e
  wr deploy --config "$WORK/wrangler.production.toml" --env "" --no-bundle \
    --var "CHAT_WORKER_VERSION:$SHA" --secrets-file "$SECRETS_FILE"
  rm -f "$SECRETS_FILE"
)
```

The secret and the new `CHAT_SERVICE_KID` go up in one version, so they cannot be out of step. The secrets file is removed only when the deploy succeeds: if it fails, the Worker is still on its previous version with the old key, both entries are in the API, and you can run the same command again. Check the deploy:

```sh
curl -sS https://<site>/chat/v1/health
```

`version` must be `SHA`. The routes are untouched by a redeploy (the same two, as in [step 4](deploy-the-chat-worker.md#4-check-the-routes-in-the-zone) of the production deploy).

## 5. Wait

Wait at least 10 minutes. By then Cloudflare's deferral window (5 minutes by default) has passed and the hub runs the version with the new key. For a planned rotation, use the time to confirm that nothing else changed (`health`, the routes).

## 6. Prove the new key

Only a call from the hub proves it, and the API logs only rejections, never successes. The hub calls the API when a member connects and its directory snapshot is older than 60 seconds, when it sends a push, and in the archive batch it posts about every 10 minutes while there are new messages. Have a UAT member connect (and send a direct message to another tester if you can), then count rejections since the deploy:

```sh
aws logs filter-log-events --region us-west-2 --log-group-name /aws/lambda/hfy-api \
  --start-time "$START_MS" --filter-pattern '"chat service token rejected"' --query 'length(events)'
```

`0` is the result you want, after a call has happened. The log lines carry an error code and never a token. A UAT member's socket that stays open and gets `welcome` also shows that the hub could fetch its directory.

While chat has no UAT member, nothing makes the hub call the API, and nothing can be proved. In a planned rotation, leave both entries in place until the first UAT session proves the key, then continue with step 7. After a suspected exposure, continue without proof and accept the failure paths below.

## 7. Remove the old entry

```sh
jq -c --arg drop "<old-kid>" 'map(select(.kid != $drop))' "$WORK/merged-keys.json" > "$WORK/final-keys.json"
jq -r '.[].kid' "$WORK/final-keys.json"
```

Replace `<old-kid>` with the old `kid` (`hfy-chat-1` for the first rotation). The second command must print only the new `kid`. Make, review and execute a change set as in step 3, with `$WORK/final-keys.json` as the value. Its review is the same two rows.

Then repeat step 6 with a new `START_MS`: connect a UAT member, then count rejections. `0` means the hub is on the new key and the old one is gone.

## 8. Clean up

```sh
rm -rf "$WORK"; unset WORK SECRETS_FILE PUBLIC_FILE KID START_MS CS SHA
```

Do this only after step 7 is verified, because `previous-keys.json` is how you undo it. The old private half exists nowhere, and the new one only as the Worker secret, which nobody can read back (`wr secret list --name hfy-chat-worker` shows its name).

## If something fails

| Where | Symptom | Cause and fix |
| --- | --- | --- |
| Step 3 | The change set shows any other row, a `Remove`, or a replacement of `True` | Discard it (`delete-change-set`). Nothing changed. Check that the parameter list came from `describe-stacks` and that every other parameter is `UsePreviousValue`. |
| Step 4 | The deploy fails | The Worker is on its previous version and the secrets file is still there. Run the same command again. If you give up, the old key is still the live one, and the extra entry in the API is harmless until you remove it with a change set from `previous-keys.json`. |
| Step 4 or 6 | Rejections appear while both entries are present | The new pair and `CHAT_SERVICE_KID` do not match, or the public half in the parameter is not the half of the secret. The API trusts the old key and not this one, so a hub on the new key is refused. Start again with a fresh pair under a new `kid` (`hfy-chat-3`), from step 1. Never reuse `hfy-chat-2`. |
| Step 7 | Rejections appear after the old entry is gone, and fewer than 10 minutes passed since step 4 | The hub is still on the old version. Put the old entry back by executing a change set with `$WORK/previous-keys.json` merged with the new entry (as in step 3), wait longer, and try step 7 again. |
| Step 7 | Rejections persist after a long wait | The pair and the `kid` do not match. As above, start again under a new `kid`. The old private half cannot come back: it was never stored. |
| Any step | `ChatServicePublicKeys unusable` in the `hfy-api` log | The parameter value is malformed JSON or holds a non-P-256 key. Every service call is refused until it is fixed. Re-apply `previous-keys.json` with a change set. |
| After step 7 | A UAT member's socket closes `4503` | The hub could not fetch its directory. See [Troubleshooting](deploy-the-chat-worker.md#troubleshooting). |

There is no rollback to the old private key: it exists only in the Worker secret that the deploy replaced, so a failed rotation is repaired by rotating forward to a fresh `kid`. What you can always undo is the API side, by executing a change set whose value is `previous-keys.json`.

## What never to do

- **Never reuse a `kid`.** The first matching entry wins, and a reused name makes a log line ambiguous.
- **Never print or copy the private half.** It lives in the `0600` secrets file during steps 2 to 4 and then only in the Worker secret. Do not `cat` the file, paste it into a ticket, a worklog or a shell history, or commit it. Do not pass it with `--var`: a var is plain text in the deploy and the dashboard.
- **Never remove the old entry before the wait**, and never deploy the Worker with the new `kid` before the new public half is in the API.
- **Never set `CHAT_SERVICE_KID` only on the command line or in the dashboard.** The next deploy replaces it with the committed value.
- **Never edit `ChatServicePublicKeys` from memory or in the console.** Build the value with `jq` from the stack's current value, so a typo cannot empty the list and refuse every service call.
- **Never tail production while the key is in play** ([Never tail production](deploy-the-chat-worker.md#never-tail-production)).
