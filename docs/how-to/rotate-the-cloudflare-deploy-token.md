# How to rotate the Cloudflare deploy token

The `worker` job of [`io-kit-deploy.yml`](../../.github/workflows/io-kit-deploy.yml) uploads the chat Worker's committed bundle with the GitHub Actions secret `CLOUDFLARE_API_TOKEN`. The token expires 90 days after it is created, so it is replaced on a schedule, and at once after any suspected exposure. This page creates the new token, stores it, proves it with a CI run and removes the old one. It is not the chat service key, which the Worker signs `hfy-api` calls with ([Rotate the chat service key](rotate-the-chat-service-key.md)), and not the by-hand credential of the first deploy ([Deploy the Worker to production](deploy-the-chat-worker.md#deploy-the-worker-to-production)).

Values in angle brackets are placeholders. The forms are listed in [Private data and secrets](../reference/private-data-and-secrets.md#placeholders).

## What the token can do

Everything in CI is bounded by this one credential, which is why it is narrow:

- **Account Workers Scripts: Edit** on the one account, `<cloudflare-account-id>`. It covers uploading the script, its Durable Object classes and its migrations, and reading and changing its deployments (the rollback).
- **Zone Workers Routes: Read** on the one zone, `<cloudflare-zone-id>`. The `deploy-worker` action lists the zone's routes to check that this Worker has exactly the two routes in `chat-worker/dist/deploy.json`. It never writes a route.
- **Nothing else.** No Workers Routes: Edit, no DNS, cache, WAF, SSL, Pages, R2, Workers KV or user permission, and no other zone or account.
- **A lifetime of 90 days**, set when the token is created (`expires_on`).

The routes `<site>/chat/ws*` and `<site>/chat/v1/*` are created once by the orchestrator with a separate, short-lived credential, with io's go-ahead, and CI only verifies them. A deploy that finds a different route list fails and, if it uploaded, rolls the Worker back. Because the token cannot edit routes, a leaked CI token cannot repoint the site's traffic.

Also keep these two limits in place, because they are the rest of the gate on the token:

- The GitHub environment `production` allows deployments from `main` only and has io as a required reviewer. The `worker` job runs in it, so a branch or a pull request cannot read the secret into a run, and every run of the deploy workflow waits for io before the Worker job starts.
- The secret is stored as a repository secret that only the `worker` job reads. No other workflow names it.

## Before you start

- **io's go-ahead, in the session or in the dispatch or plan that authorizes it.** Creating the token and `gh secret set` are both go-ahead operations ([AGENTS.md](../../AGENTS.md)).
- **A quiet window.** The proving run in step 3 is a no-write run when the bundle is unchanged, but run it when no Worker change is waiting to merge, so that a failure is clearly the token's.
- **Tools:** `curl`, `jq` and `gh`, with a GitHub credential that can write this repository's secrets. Mint the credential per shell as [AGENTS.md](../../AGENTS.md#github-access) describes. Never run `gh auth login`.
- **A Cloudflare credential that can create API tokens.** That is io's login to the dashboard, or the account key in the operator's shell as in [Deploy the Worker to production](deploy-the-chat-worker.md#prerequisites).

Never write a token into a file, a command line, a worklog, a commit or a pull request body, and never turn on `set -x` in a shell that holds one. The commands below read the value with `read -rs` and pass it on standard input.

## When to rotate

- **On the calendar.** Every 90 days, in the last two weeks before `expires_on`, so that an expired token never stops a deploy. [Check the token](#check-the-token) gives the date.
- **At once** when the value may have been seen: a terminal scrollback, a pasted command, a log, a screenshot, a person who left. Do every step in one sitting and delete the old token in step 4 as soon as step 3 is green. A deleted token stops working immediately.
- **After a run fails** with `cloudflare GET ... failed: http 401` or `403` in the `worker` job. [Diagnose a failed token](#diagnose-a-failed-token) tells the two apart.

## Check the token

```sh
read -rs -p 'Token to check: ' TOKEN; echo
curl -sS -H "Authorization: Bearer $TOKEN" https://api.cloudflare.com/client/v4/user/tokens/verify | jq '.result | {status, expires_on}'
unset TOKEN
```

This prints the status (`active`) and the expiry. It does not print the value. You only hold the value when you have just created the token: GitHub never shows a stored secret again, so to check the stored one, read `expires_on` from the token's page in the Cloudflare dashboard (My Profile, API Tokens), which lists it by name.

## 1. Create the new token

In the Cloudflare dashboard, My Profile, API Tokens, Create Token, Create Custom Token:

1. **Name:** `hfy-ci-chat-worker-<yyyy-mm-dd>`, so two tokens never share a name while both exist.
2. **Permissions:** two rows only. Account, Workers Scripts, Edit. Zone, Workers Routes, Read.
3. **Account Resources:** Include, the one account. **Zone Resources:** Include, Specific zone, the site's zone.
4. **Client IP Address Filtering:** leave it empty, because GitHub-hosted runners have no stable address.
5. **TTL:** a start of today and an end 90 days after it.
6. Create it, and copy the value once into the next command. Do not paste it anywhere else.

The same token can be made through the API with the account key, by listing the permission groups and posting the policy. List the groups (`GET /user/tokens/permission_groups`), pick the ids of the two groups the dashboard shows as Workers Scripts: Edit and Workers Routes: Read, and post a token with two policies, each limited to its resource, and a `not_before` and `expires_on` 90 days apart. The response holds the value once. Whichever way you create it, read the policies back before you store it:

```sh
curl -sS -H "X-Auth-Email: $CLOUDFLARE_EMAIL" -H "X-Auth-Key: $CLOUDFLARE_API_KEY" \
  https://api.cloudflare.com/client/v4/user/tokens/<token-id> | jq '.result | {name, status, expires_on, policies: [.policies[] | {effect, permission_groups: [.permission_groups[].name], resources}]}'
```

It lists exactly two policies with those two permission groups, the single account and the single zone, and `expires_on` about 90 days out. It shows no value. Keep this listing as the acceptance evidence for the token: a policy listing, never the value.

## 2. Store it as the secret

```sh
read -rs -p 'New token: ' NEWTOKEN; echo
printf '%s' "$NEWTOKEN" | gh secret set CLOUDFLARE_API_TOKEN --repo <github-owner>/<github-repo>
unset NEWTOKEN
```

`gh secret set` replaces the value in place. Nothing is echoed. `--repo` names the repository, so the secret never lands in whichever checkout you are standing in.

## 3. Prove it with a run

Start the deploy workflow by hand on `main`:

```sh
gh workflow run io-kit-deploy.yml --repo <github-owner>/<github-repo> --ref main
```

The `worker` job pauses for the `production` environment: approve it. Then read the job log for these lines:

- `hfy-chat-worker: bundle unchanged (...); no Cloudflare write` when `main`'s bundle is already live, or `uploaded sha256:...` when it is not.
- `hfy-chat-worker: zone routes match deploy.json [...]`, which is the read-only route check and proves the Routes: Read permission.
- `ok   hfy-chat-worker smoke: version=<sha>` and the two `ok ... check` lines.

An unchanged bundle makes no write, so a green run with the first line proves the token can read the deployments, the script list and the routes. It does not prove the upload permission. To prove that too, run it in the window of the next real Worker change, which uploads. If you must prove the upload now, rebuild nothing and merge nothing: a deliberate re-upload is a Worker deploy, which closes every open chat socket, so it needs io's chosen window and go-ahead like any other Worker deploy.

The `Deploy Worker` step prints no part of the token: the action reads it into a curl config file and unsets it. If a log ever shows a value, treat the token as exposed and start again at step 1.

## 4. Delete the old token

In the dashboard, My Profile, API Tokens, find the previous `hfy-ci-chat-worker-...` token and delete it. Deleting it ends the overlap. Run [Check the token](#check-the-token) against the old value only if you still hold it: it must now answer `401`.

Record, in the worklog: the new token's name, `expires_on`, the policy listing without any value, the green run's link, and that the old token was deleted. Never record a value, even truncated.

## Diagnose a failed token

| The `worker` job says | Meaning | Fix |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN is empty` | The secret is not set, or the run could not read it (a branch run, or the environment's branch rule). | Run from `main`. If the secret is missing, [store it](#2-store-it-as-the-secret). |
| `CLOUDFLARE_API_TOKEN has characters outside [A-Za-z0-9_-]` | The stored value has a stray character, usually a trailing newline or quote. | Store it again with `printf '%s'` as in step 2. |
| `cloudflare GET ... failed: http 401` | The token has expired, was deleted or is not a token. | Rotate: steps 1 to 3. |
| `cloudflare GET /zones/.../workers/routes failed: http 403` | The token lacks zone Workers Routes: Read, or its zone resource is not the site's zone. | Create a token with both permissions and the right resources. |
| `cloudflare PUT /accounts/.../workers/scripts/hfy-chat-worker failed: http 403` | The token lacks account Workers Scripts: Edit, or its account resource is wrong. | The same. |
| `ROUTE DRIFT on the zone for hfy-chat-worker` | The zone's routes for this Worker differ from `deploy.json`. This is not a token problem. | Routes are created by hand, never by CI: see [Check where the Worker stands](deploy-the-chat-worker.md#check-where-the-worker-stands). |

## What to do if the token leaks

Delete the token in the dashboard first: that ends its use. Then read the Worker's [deployments](deploy-the-chat-worker.md#check-where-the-worker-stands) for any version you did not make, and the zone's route list for a route you did not make (the token cannot create one, so a new route would mean a different credential). Then create and store a new token. The Worker's secrets (`CHAT_SERVICE_PRIVATE_KEY`, `CHAT_ADMIN_TOKEN` and `CHAT_UAT_SUBJECTS`) cannot be read back through the API, and an upload keeps them, but a token that can edit scripts can overwrite the bundle: if a deployment you did not make is live, redeploy the committed bundle by hand and [rotate the service key](rotate-the-chat-service-key.md).
