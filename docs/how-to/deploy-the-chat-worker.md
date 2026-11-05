# How to build, test, stage and deploy the chat Worker

The chat Worker answers two paths on the site's host, `/chat/ws*` and `/chat/v1/*`, ahead of CloudFront, and holds the `ChatHub` Durable Object that carries every chat conversation ([`chat-worker/`](../../chat-worker/)). This page rebuilds its committed bundle, runs its checks and tests, exercises it with real sockets locally and on a staging Worker, and ships it. The normal path to production is CI: the `worker` job of the kit deploy workflow uploads the committed bundle with a scoped Cloudflare token (the `cloudflare-worker` target in [`ci.manifest.yaml`](../../ci.manifest.yaml), HFY-TSK-200), described in [Deploy through CI](#deploy-through-ci-the-normal-path). Local wrangler is for staging and for emergencies, and the by-hand procedure under [Deploy the Worker to production](#deploy-the-worker-to-production) is what created the Worker, its routes and its service key and is what you fall back on if CI is unavailable. Rotating the key later is [Rotate the chat service key](rotate-the-chat-service-key.md), and the CI token's rotation is [Rotate the Cloudflare deploy token](rotate-the-cloudflare-deploy-token.md).

Values in angle brackets are placeholders. The forms are listed in [Private data and secrets](../reference/private-data-and-secrets.md#placeholders).

## Before you start

- **Chat ships dark.** The committed `wrangler.toml` sets `CHAT_OPEN_TO` to `uat` and declares no `CHAT_UAT_SUBJECTS`: the tester list is a Worker secret that is not in Git, so nobody can connect until someone sets it ([Name the UAT members](#name-the-uat-members)), and the committed [`flags.json`](../../11ty/_data/flags.json) keeps the island flag `chatV1` off. What is deployed can differ: check it with [Check where the Worker stands](#check-where-the-worker-stands). Only that section changes who can chat; no other step on this page does.
- **Node 22 or later**, and `CODEARTIFACT_AUTH_TOKEN` exported before any install, because `@io-kit/chat` comes from CodeArtifact ([Build and preview the islands](build-and-preview-the-islands.md) shows how to get a token). The AWS identity that can mint it is the `product-lead` profile.
- **Why the bundle is committed.** CI cannot read CodeArtifact (HFY-R62) and installs no npm package (HFY-R14), so it cannot build the Worker. You build it, and commit [`chat-worker/dist/`](../../chat-worker/dist/) with the source change, exactly like the islands output (HFY-R58).

## Rebuild the bundle

Rebuild after any change to `chat-worker/src/`, `wrangler.toml`, `package.json`, the lockfile, or [`shared/privacy-guard.mjs`](../../shared/privacy-guard.mjs), which the Worker bundles as the hub's R-18 detector.

```sh
cd chat-worker
npm ci
npm run build
```

`npm run build` runs `wrangler deploy --dry-run` (no login, no network) to bundle [`src/index.mjs`](../../chat-worker/src/index.mjs) into `dist/index.js`, then writes `dist/deploy.json` from `wrangler.toml`: the Durable Object binding, the `v1` migration with `new_sqlite_classes`, the compatibility date, the vars and the two routes. The production deploy uploads `dist/index.js` as it is and adds the commit sha as `CHAT_WORKER_VERSION` at upload, so the bundle stays byte-identical between merges ([Deploy the Worker to production](#deploy-the-worker-to-production)). The `cloudflare-worker` CI target uploads those two files the same way, and never builds.

Commit everything under `chat-worker/dist/`. Then check it:

```sh
npm run check
```

It rebuilds in a temporary directory and exits `1` and names each file that is missing, stale or extra. It prints `chat-worker/dist is fresh` when the committed bundle is what the source builds to.

CI cannot run this check (the install needs CodeArtifact), so a change to `shared/privacy-guard.mjs` or `src/` can merge with a stale `dist/`. A check that needs no install catches a bundle that was edited or half-committed, though not one that is merely stale against the source: the bundle's SHA-256 must equal the one `deploy.json` records.

```sh
test "$(shasum -a 256 chat-worker/dist/index.js | cut -d' ' -f1)" = "$(jq -r .bundle.sha256 chat-worker/dist/deploy.json)" && echo "bundle matches deploy.json"
```

The production deploy runs it first. Recording a hash of the bundled inputs and comparing it in CI would close the rest of the gap; that follow-up is not done.

## Install from the lockfile

```sh
cd chat-worker
npm ci
```

The lockfile is generated with a local CodeArtifact token (`npm install`), and `npm ci` from it must pass. Every dependency is an exact pin; `npm test` fails on a `^` or `~`. To move `@io-kit/chat` to a newer released version, change the pin in `package.json`, run `npm install`, rebuild `dist/` and commit all three.

## Run the tests

```sh
cd chat-worker
npm test
```

`node --test test/*.test.mjs`, offline, in process. They run the committed `dist/index.js`:

| File | What it pins |
| --- | --- |
| `bundle.test.mjs` | `deploy.json` and `wrangler.toml`: every Durable Object class is in `new_sqlite_classes` (no key-value class, rename or delete), exactly the two routes, observability off, a staging Worker with its own name and test JWKS, no timer (`setTimeout`, `setInterval`) in the bundle, a tagged `acceptWebSocket` and a registered `setWebSocketAutoResponse`, one text-free log line, exact pins and a clean lockfile. |
| `worker.test.mjs` | The upgrade checks (exact `Origin`, then the kill switch, the session, the UAT list, each as a close code); the Durable Object is handed a new `Request` whose identity headers are only `x-chat-uid` and `x-chat-exp`, plus the WebSocket handshake headers the kit needs (`Upgrade`, `Connection`, `Sec-WebSocket-*`), never the `Cookie` or `Authorization`; the first `get()` carries `locationHint: "wnam"`; every other request on the routes goes on with `fetch(request)`; no header or cookie reaches the console. |
| `hub.test.mjs` | The hub on a fake `DurableObjectState` with SQLite: the socket tag, the auto-response, no timers across connect, send, close and the alarm, and no frame text on the console, failures included. |
| `expunge.test.mjs` | The admin expunge route (HFY-TSK-337), below: the Worker front door (token checked before the hub is woken, only the token and the body forwarded, no route without the secret), the hub route (200/404/401/400/405/413), each copy of the text (every SQLite table, the archive batch and post, a drain in flight, a walk of the hub object for any in-memory copy), the history read (`text: null, expunged: true`, order and senders unchanged, both the `page` and the `resume` path), no console output, and `api/scripts/expunge.mjs --chat --apply` end to end over a local HTTP socket. |
| `guard.test.mjs` | [`shared/privacy-guard.mjs`](../../shared/privacy-guard.mjs) as the bundle carries it, against [`shared/privacy-guard.vectors.json`](../../shared/privacy-guard.vectors.json), and through the hub (`CONTACT_INFO`). |

## Smoke the Worker with real sockets

The smoke script ([`test/smoke.mjs`](../../chat-worker/test/smoke.mjs)) opens real WebSockets. It checks health (200, `no-store`, `protocol: 1`), that a non-upgrade request is not the hub's, that no cookie closes `4401` and a wrong or missing `Origin` closes `4403`, that a test-key cookie gets `welcome`, that a direct message reaches its recipient, and that a phone number is refused `CONTACT_INFO` without being echoed. All data is synthetic: ids `I9001` and up, and keys made for the run.

Locally, in `workerd` (no login, no network, nothing deployed):

```sh
cd chat-worker
npm run smoke -- --local          # the staging entry
npm run smoke -- --local-prod     # the production entry that dist/ is built from, with a local JWKS and API stand-in
```

Each starts `wrangler dev`, runs the checks and stops it. Afterwards `pgrep -fl workerd` prints nothing.

## Stage the Worker on workers.dev

Staging is the production wiring in a separate Worker, `hfy-chat-worker-staging`, so it has its own Durable Object namespace and SQLite. Its entry, [`src/staging.mjs`](../../chat-worker/src/staging.mjs), trusts a test JWKS (the `TEST_JWKS` var) and answers the hub's directory, push and archive calls itself, so nothing of production is behind it. Production's bundle contains neither (a test pins that). Staging is deployed by hand, never by CI, and carries the load tests (the `@io-kit/chat/testing/load` harness).

1. Log in to Cloudflare on this machine (`npx wrangler login`), or export a Cloudflare API token for the account. Do not write it into a file in the repository.
2. Deploy:

   ```sh
   cd chat-worker
   npm run staging:deploy
   ```

   It makes `chat-worker/.staging/keys.json` when absent (an RSA pair for test cookies and an ES256 service key; the directory is ignored by Git), deploys with the public JWKS as a var and the commit sha as `CHAT_WORKER_VERSION`, and sets the staging service key as a Worker secret in the same deploy (`--secrets-file`, a temporary file in `.staging/` removed afterwards), so the Worker is never live without its key. `--dry-run` builds the staging bundle and prints the command with the key material left out.
3. Smoke it, with the host `wrangler` printed:

   ```sh
   npm run smoke -- --url https://hfy-chat-worker-staging.<account-subdomain>.workers.dev
   ```

   It reads the private keys from `.staging/keys.json`. The staging `SITE_ORIGIN` is the synthetic `https://chat-staging.test`; the script sends exactly that `Origin`.

The stand-in API stores nothing. To check that the archive mirror writes `CHAT#` items with no `ttl`, point `API_BASE` of the staging env at a stack that trusts the staging service key (its public half is in `.staging/keys.json`, as `ChatServicePublicKeys` expects) and sample the items in DynamoDB. That needs an app-stack change and io's go-ahead.

## Deploy through CI (the normal path)

Every push to `main` runs [`io-kit-deploy.yml`](../../.github/workflows/io-kit-deploy.yml), and its `worker` job deploys the Worker from the committed `chat-worker/dist/`. The job needs no npm package and no CodeArtifact access: it is the rendered `deploy-worker` action (`curl` and `jq`), with the Cloudflare account and zone ids from the manifest and the token from the repository secret `CLOUDFLARE_API_TOKEN`. It runs in the GitHub environment `production`, which allows `main` only and has io as the required reviewer, so nothing deploys until io approves the job. The site's own jobs do not wait for it, and a failed Worker job never rolls the site back.

**What a run does, in order.**

1. **Skip an unchanged bundle.** It reads the Worker's active deployment. When that deployment's tag equals the SHA-256 of `dist/deploy.json` and its note carries the digest of every uploaded file, the bundle is already live: the job makes no Cloudflare write at all and goes on to the checks. A site-only merge, a docs merge, and a `workflow_dispatch` re-run on the same bundle all end here, and the Worker's deployments list does not change. A deployment with no tag, as the hand-deployed Worker has until CI uploads it once, counts as changed, so the first CI run uploads.
2. **Upload when it changed.** `PUT` to the script with `dist/index.js`, the Durable Object binding, the vars of `deploy.json`, the compatibility date, `keep_bindings` for the Worker's existing secrets (`CHAT_SERVICE_PRIVATE_KEY`, `CHAT_ADMIN_TOKEN`, `CHAT_UAT_SUBJECTS` stay), and the migration only when the Worker's migration tag differs from `v1`. It adds the commit sha as the plain-text var `CHAT_WORKER_VERSION`, so the committed bundle never changes between merges and `GET /chat/v1/health` reports the sha of the commit that uploaded it. It tags the deployment with the hash of `deploy.json` and notes the bundle digest and the commit.
3. **Verify the routes, read-only.** It lists the zone's Worker routes and fails when this Worker's routes differ from the two in `deploy.json`. It never creates or edits a route: the routes were created once, by hand, and a different list is a stop, not something to repair from CI.
4. **Smoke.** `GET https://<site>/chat/v1/health` must answer `200` with `version` equal to the sha that uploaded the bundle (on an unchanged bundle, the sha recorded by the active deployment, which is why a site-only merge still passes), and a signed-out `GET https://<site>/person/index.json` must answer `401` and `GET https://<site>/` `200`, so only the chat paths moved.
5. **Roll back the Worker only.** If the routes differ or the smoke fails after an upload, the job redeploys the previous deployment of this Worker through the deployments API and exits non-zero. If it fails on an unchanged bundle, nothing is rolled back, because nothing was uploaded. Durable Object data is never touched, and the migration list only grows.

[`scripts/ci/test/deploy-worker.test.mjs`](../../scripts/ci/test/deploy-worker.test.mjs) runs the rendered action against a mock Cloudflare API and pins each of those: the upload on an untagged Worker, zero writes on an unchanged bundle, the rollback selecting the previous deployment after a failing smoke, and no route write.

**Deploy a Worker change.**

1. Change `chat-worker/src/`, `wrangler.toml` or `shared/privacy-guard.mjs`, rebuild and commit `chat-worker/dist/` ([Rebuild the bundle](#rebuild-the-bundle)). `npm run check` must print `chat-worker/dist is fresh`.
2. Merge to `main` in a window io chose. **Every Worker deploy closes every open chat socket.** Clients reconnect and resume by sequence number, but pick a quiet time. Approve the `worker` job of the run only then. A merge that changes `dist/` and lands outside that window can wait: the site's jobs finish without the Worker job, which stays waiting for approval. If you reject it instead, start the deploy later with a `workflow_dispatch` of **io-kit deploy** on `main` when io is ready.
3. Read the job log: `uploaded sha256:...`, `zone routes match deploy.json`, then three `ok` lines. `curl -sS https://<site>/chat/v1/health` reports the commit.

A run that only touches the site waits for the same approval, because the kit renders the `worker` job without a path filter and the environment's reviewer gate comes before the job's own unchanged-bundle skip. Approve it and it ends with no write, or reject it and the Worker is just as unchanged. The cost is that the run stays in the waiting state until someone decides, and the workflow's concurrency group (`io-kit-deploy-<ref>`, which never cancels) queues the next push's run behind it. Decide the job after each merge, or the next site deploy does not start. A `paths` filter on the job, which the kit does not render yet, would remove the wait: it is a kit follow-up (HFY-R28), not something to hand-edit into the rendered workflow, which `io-kit-ci check` rejects.

**Vars and the emergency switch.** An upload replaces the Worker's vars with the ones in `dist/deploy.json`. A value set only by hand, such as `CHAT_ENABLED=0` from [Roll back and stop](#roll-back-and-stop), is therefore reset by the next upload of a changed bundle, and an unchanged bundle makes no write and keeps it. If a stop has to last, commit the value and rebuild `dist/` first. Changing `CHAT_OPEN_TO` or `CHAT_ENABLED` is a committed change deployed this way.

**What CI does not do.** It does not build the bundle, create or edit routes, set a secret (`CHAT_SERVICE_PRIVATE_KEY`, `CHAT_ADMIN_TOKEN` and `CHAT_UAT_SUBJECTS` are set by hand and kept by every upload), change the app stack's `ChatServicePublicKeys`, or deploy staging. Those stay with the by-hand procedures on this page. A failing run that is a token problem is read in [Diagnose a failed token](rotate-the-cloudflare-deploy-token.md#diagnose-a-failed-token).

## Deploy the Worker to production

This is the by-hand deploy: how the Worker, its two routes and its service key were first created (HFY-TSK-199), and the fallback when CI cannot deploy. A change to the code is normally [deployed through CI](#deploy-through-ci-the-normal-path). It deploys the committed bundle as the Worker `hfy-chat-worker`, creates its two routes in the site's Cloudflare zone, sets the hub's service key as a Worker secret, and then trusts the key's public half in the app stack. Everything else on the host keeps going Cloudflare, CloudFront, S3 and Lambda, and the Worker passes any request it does not own on to that origin ([why](../explanation/edge-and-origin-design.md#the-deliberate-exception-the-chat-worker-routes)).

**History.** The first production deploy ran on 2026-11-04 (HFY-TSK-199), by hand, with the procedure below: the Worker first, then the change set. Nothing on this page records what is live now. [Check where the Worker stands](#check-where-the-worker-stands) gives the checks.

**The Worker is dormant until UAT members are named.** `CHAT_OPEN_TO` is `uat` and `CHAT_UAT_SUBJECTS` is a Worker secret this deploy never sets, so with it absent or empty no member passes the upgrade check and every signed-in socket closes `4403`. Until `ChatServicePublicKeys` holds the key's public half, every call the hub makes to `hfy-api` answers `401`. The order below deploys the Worker first for that reason: it can sit deployed with nobody able to use it.

### Prerequisites

- **io's go-ahead, in the session or in the dispatch or plan that authorizes it.** The deploy creates routes in the production zone and a secret on the Worker. The change set in step 6 also needs io's G-prod approval: the `ChatServicePublicKeys` flip is named in the gate list of the HFY-PLN-002 BRD (`BRD2.md`, the G-prod row). Post the `describe-change-set` summary before you execute it.
- **Durable Object jurisdiction is decided, and this procedure never changes it.** Object ids differ per jurisdiction and cannot change after launch, so the choice was recorded on 2026-11-04, before any production `get()`: no jurisdiction, with the `wnam` location hint (`CHAT_LOCATION_HINT`). Never add a jurisdiction to the namespace later, because it would address different, empty objects.
- **A clean checkout of the `main` commit that holds the bundle.** Use a worktree of `origin/main`. This procedure never builds the bundle ([Rebuild the bundle](#rebuild-the-bundle) does that, and it is committed), so it needs no `npm ci` and no CodeArtifact token, except for the smoke in step 7.
- **wrangler 4.145.0**, the version `chat-worker/package.json` pins. Older copies lack `--secrets-file`. The commands below run it with `npx` from a scratch directory outside the repository, so the repository's `.npmrc` (CodeArtifact) is not involved; `chat-worker/node_modules/.bin/wrangler` is the same version after `npm ci`.
- **A Cloudflare credential in the shell environment**, for wrangler and for the API calls in steps 4 and 5. Either the account key as `CLOUDFLARE_API_KEY` with `CLOUDFLARE_EMAIL`, or a token with account Workers Scripts: Edit (which covers Durable Object classes and migrations) and zone Workers Routes: Edit. The commands below use the key form; for a token send `Authorization: Bearer $CLOUDFLARE_API_TOKEN` instead of the two `X-Auth-` headers. If the credential can reach more than one account, also export `CLOUDFLARE_ACCOUNT_ID` (`<cloudflare-account-id>`), or wrangler cannot choose. Never write a credential into a file, a worklog or a command line, and never turn on `set -x` in this shell.
- **AWS credentials for `us-west-2`** that can create, review and execute a change set on `<app-stack>`, as in [Deploy the app stack](deploy-the-app-stack.md#4-deploy-the-stack).
- **Tools:** Node 22 or later, `jq`, `curl`, the AWS CLI and `git`.

### 1. Check out the commit and check the bundle

```sh
git fetch origin
git worktree add --detach <worktree> origin/main
cd <worktree>/chat-worker
SHA="$(git rev-parse HEAD)"
test "$(shasum -a 256 dist/index.js | cut -d' ' -f1)" = "$(jq -r .bundle.sha256 dist/deploy.json)" && echo "bundle matches deploy.json"
```

The last line must print `bundle matches deploy.json`. `SHA` becomes the version that `GET /chat/v1/health` reports.

### 2. Derive the production config

`wrangler.toml` points `main` at the source. The deploy uploads the committed bytes instead, so the derived config differs in that one line:

```sh
WORK="$(mktemp -d)"
sed "s|^main = \"src/index.mjs\"|main = \"$PWD/dist/index.js\"|" wrangler.toml > "$WORK/wrangler.production.toml"
grep -c '^main = ".*/dist/index.js"$' "$WORK/wrangler.production.toml"
wr() { (cd "$WORK" && WRANGLER_SEND_METRICS=false npx --yes wrangler@4.145.0 "$@"); }
```

The `grep` must print `1`. The vars, the two routes, the `CHAT_HUB` binding, the `v1` migration (`new_sqlite_classes`) and the observability settings all come from the file, so they are the committed ones. `$WORK` holds the key files in the next step; step 8 removes it.

### 3. Make the service key and deploy

Save this as `$WORK/make-service-key.mjs`. It makes one ES256 (P-256) pair in memory, writes the private half only into the secrets file (mode `0600`) and the public half, in the shape `ChatServicePublicKeys` takes, into a second file:

```sh
cat > "$WORK/make-service-key.mjs" <<'EOF'
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";

const { SECRETS_FILE, PUBLIC_FILE, KID } = process.env;
if (!SECRETS_FILE || !PUBLIC_FILE || !KID) throw new Error("set SECRETS_FILE, PUBLIC_FILE and KID");
const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const pem = privateKey.export({ type: "pkcs8", format: "pem" });
writeFileSync(SECRETS_FILE, `${JSON.stringify({ CHAT_SERVICE_PRIVATE_KEY: pem })}\n`, { mode: 0o600 });
const spki = publicKey.export({ type: "spki", format: "der" }).toString("base64");
writeFileSync(PUBLIC_FILE, `${JSON.stringify([{ kid: KID, spki }])}\n`);
console.log(`made key ${KID}`);
EOF
```

Then make the key and deploy in one subshell. The `trap` removes the secrets file whether the deploy succeeds or fails, and the key is uploaded in the same call as the code, so the Worker never runs without it:

```sh
export SECRETS_FILE="$WORK/secrets.json" PUBLIC_FILE="$WORK/chat-service-public-keys.json"
export KID="$(sed -n 's/^CHAT_SERVICE_KID = "\(.*\)"$/\1/p' wrangler.toml | head -1)"
echo "$KID"
(
  set -e
  trap 'rm -f "$SECRETS_FILE"' EXIT
  node "$WORK/make-service-key.mjs"
  wr deploy --config "$WORK/wrangler.production.toml" --env "" --no-bundle \
    --var "CHAT_WORKER_VERSION:$SHA" --secrets-file "$SECRETS_FILE"
)
```

- `KID` is read from `wrangler.toml`, so the key's `kid` and the Worker's `CHAT_SERVICE_KID` cannot drift. The `echo` must print `hfy-chat-1` for the first key.
- `--env ""` targets the top-level production environment. The file also defines `[env.staging]`, which this never touches.
- `--no-bundle` uploads `dist/index.js` unchanged, which is why no install is needed. The first deploy applies the `v1` migration that creates the SQLite-backed `ChatHub` class.
- The same deploy creates the two routes from the config. CI's scoped token cannot create routes, only read them.
- A failed deploy leaves the Worker missing or on its previous version, and sets no key. Run the step again: it makes a new pair and discards the old public half.
- Never print the secrets file, never copy it, and never pass the key with `--var` (a var is plain text in the deploy and the dashboard).

### 4. Check the routes in the zone

```sh
cf_api() {
  curl -sS --config - "$@" <<EOF
header = "X-Auth-Email: $CLOUDFLARE_EMAIL"
header = "X-Auth-Key: $CLOUDFLARE_API_KEY"
EOF
}
CF=https://api.cloudflare.com/client/v4
ZONE_ID="$(cf_api "$CF/zones?name=<site>" | jq -r '.result[0].id')"
cf_api "$CF/zones/$ZONE_ID/workers/routes" | jq -r '.result[] | [.pattern, .script] | @tsv' | sort
```

`curl --config -` keeps the credential out of the process list. The list must be exactly these two lines, with `<site>` as the host:

```text
<site>/chat/v1/*	hfy-chat-worker
<site>/chat/ws*	hfy-chat-worker
```

A third route for this script, or any other route in the zone that names it, is a mistake to fix before you go on. Keep `ZONE_ID` in the shell; do not write the zone id down.

### 5. Check that the Worker answers and nothing else moved

```sh
curl -sS -D - https://<site>/chat/v1/health
curl -sS -o /dev/null -w '%{http_code}\n' https://<site>/
```

Health answers `200` with `cache-control: no-store` and the body `{"ok":true,"version":"<SHA>","protocol":1}`, where `<SHA>` is the commit from step 1 and the body holds nothing else. `/` still answers `200`. The data gate is unaffected: the signed-out `/person/index.json` answer is the one that [Find your starting point](cut-over-to-the-private-data-gate.md#find-your-starting-point) lists for the state you were in before.

To see the dormant gate with a member session, sign in to the site in a browser tab and run this in the tab's console. The Worker closes the socket with `4403` while the UAT list is empty:

```js
const ws = new WebSocket("wss://<site>/chat/ws"); ws.onclose = (e) => console.log(e.code, e.reason);
```

### 6. Trust the key's public half in the app stack

This is a parameter-only change set. It needs io's G-prod approval ([Prerequisites](#prerequisites)). It builds the parameter list from the stack's own, so every other parameter keeps its value:

```sh
aws cloudformation describe-stacks --stack-name <app-stack> --query 'Stacks[0].Parameters[].ParameterKey' --output json \
  | jq --arg v "$(cat "$PUBLIC_FILE")" '[.[] | if . == "ChatServicePublicKeys" then {ParameterKey: ., ParameterValue: $v} else {ParameterKey: ., UsePreviousValue: true} end]' \
  > "$WORK/params.json"
CS="$(aws cloudformation create-change-set --stack-name <app-stack> \
  --change-set-name "hfy-chat-service-keys-$(date -u +%Y%m%d%H%M)" \
  --use-previous-template --parameters "file://$WORK/params.json" \
  --capabilities CAPABILITY_NAMED_IAM --query Id --output text)"
aws cloudformation wait change-set-create-complete --change-set-name "$CS"
aws cloudformation describe-change-set --change-set-name "$CS" \
  --query 'Changes[].ResourceChange.[Action, LogicalResourceId, ResourceType, Replacement]' --output text
aws cloudformation describe-change-set --change-set-name "$CS" \
  --query "Changes[?ResourceChange.LogicalResourceId=='Function'].ResourceChange.Details[].Target.[Attribute, Name]" --output text
```

The change set must list exactly two rows, and the second query must print only `Properties	Environment`:

```text
Modify	Function	AWS::Lambda::Function	False
Modify	FunctionUrl	AWS::Lambda::Url	Conditional
```

The function changes only its environment variable `CHAT_SERVICE_PUBLIC_KEYS`, in place. The Function URL shows `Conditional` for the reason [Deploy the app stack](deploy-the-app-stack.md#review-the-change-set) gives, and the `FunctionUrl` and `AuthFunctionUrl` outputs must not change. Discard the change set (`aws cloudformation delete-change-set --change-set-name "$CS"`) if it shows any other row, a `Remove` or a replacement of `True`.

Execute it the way [Execute it and check the Function URLs](deploy-the-app-stack.md#execute-it-and-check-the-function-urls) does: record the two Function URL outputs first, run `aws cloudformation execute-change-set --change-set-name "$CS"` and the `wait`, then compare. Then print the kids the API trusts:

```sh
aws cloudformation describe-stacks --stack-name <app-stack> \
  --query "Stacks[0].Parameters[?ParameterKey=='ChatServicePublicKeys'].ParameterValue" --output text | jq -r '.[].kid'
```

For the first key it prints `hfy-chat-1`. The parameter holds public keys only, so printing it is safe.

### 7. Smoke it

The anonymous smoke needs `npm ci` in `chat-worker/` with `CODEARTIFACT_AUTH_TOKEN` ([Before you start](#before-you-start)). Pass the production origin: the script's default `Origin` is the synthetic staging one, and without `--origin` its no-cookie check reports `FAIL`.

```sh
(cd <worktree>/chat-worker && npm ci && node test/smoke.mjs --url https://<site> --prod --origin https://<site>)
```

It checks health, that a non-upgrade request goes on to the origin, that no cookie closes `4401`, and that a wrong or missing `Origin` closes `4403`. Every line must start `ok`.

Then check that a token signed by a key the API does not trust gets nothing. This mints a service token with all valid claims and a throwaway key, under the real `kid`:

```sh
TOKEN="$(node --input-type=module -e '
import { generateKeyPairSync, sign, randomUUID } from "node:crypto";
const b64u = (b) => Buffer.from(b).toString("base64url");
const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const iat = Math.floor(Date.now() / 1000);
const head = b64u(JSON.stringify({ alg: "ES256", kid: process.argv[1], typ: "JWT" }));
const body = b64u(JSON.stringify({ iss: "hfy-chat", aud: "hfy-api/chat", sub: "chat-hub", iat, exp: iat + 60, jti: randomUUID() }));
console.log(`${head}.${body}.${b64u(sign("sha256", Buffer.from(`${head}.${body}`), { key: privateKey, dsaEncoding: "ieee-p1363" }))}`);
' "$KID")"
curl -sS -o /dev/null -w '%{http_code}\n' https://<site>/api/chat/directory
curl -sS -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" https://<site>/api/chat/directory
```

Both print `401`: no token, and a valid-looking token with the wrong signature. A token with an unknown `kid` is `401` too. That token is worthless and may appear in the terminal.

**What this does not prove.** No check from outside shows that the hub's own token is accepted, because only the hub holds the private half. That first appears when a UAT member connects: the socket stays open and receives `welcome`. A socket that closes `4503` for a UAT member means the hub could not fetch the directory (see [Troubleshooting](#troubleshooting)).

### 8. Check the secret and clean up

The private half now exists in one place, the Worker secret `CHAT_SERVICE_PRIVATE_KEY`, which nobody can read back. Check that it is there, by name only:

```sh
wr secret list --name hfy-chat-worker
```

It lists `CHAT_SERVICE_PRIVATE_KEY`, `CHAT_ADMIN_TOKEN` once [that secret is set](#the-admin-expunge-route), and `CHAT_UAT_SUBJECTS` once [the UAT members are named](#name-the-uat-members). Then remove everything the steps made:

```sh
rm -rf "$WORK"; unset WORK SECRETS_FILE PUBLIC_FILE KID TOKEN ZONE_ID CS
git worktree remove <worktree>
```

### Redeploy without changing the key

A later by-hand deploy of a new bundle or of changed vars (the kill switch, `CHAT_OPEN_TO`) runs steps 1 to 5 with step 3 shortened to the `wr deploy` line **without** `--secrets-file`. Cloudflare documents that a deploy never deletes secrets, so the key stays, and the `ChatServicePublicKeys` entry stays valid; so do `CHAT_ADMIN_TOKEN` and `CHAT_UAT_SUBJECTS`. Every deploy replaces the vars with the ones in `wrangler.toml`, so a value set only in the dashboard or by an earlier `--var` is gone after it, and `CHAT_WORKER_VERSION` must be passed again. Cloudflare defers a Durable Object's code update by default, for up to 5 minutes or until the object hibernates, and a socket accepted through the Hibernation API (the hub's) stays connected across the update unless the object is still active when that delay ends; the client reconnects if one drops. Until the object adopts the new version, the hub runs the version it had, secrets and vars included.

### Check where the Worker stands

None of this is recorded in the repository. Each line checks one thing (`cf_api`, `CF` and `ZONE_ID` are the ones from step 4 and `wr` is the one from step 2; define them again in a new shell):

```sh
curl -sS https://<site>/chat/v1/health
cf_api "$CF/zones/$ZONE_ID/workers/routes" | jq -r '.result[] | [.pattern, .script] | @tsv'
aws cloudformation describe-stacks --stack-name <app-stack> \
  --query "Stacks[0].Parameters[?ParameterKey=='ChatServicePublicKeys'].ParameterValue" --output text | jq -r '.[].kid'
curl -s https://<site>/_data/flags.json | jq .chatV1
curl -sS -X POST -o /dev/null -w '%{http_code}\n' https://<site>/chat/v1/admin/expunge
wr secret list --name hfy-chat-worker
```

- **Health:** the JSON body means the routes and the Worker are there, and `version` is the deployed commit. Anything else (the site's HTML, a CloudFront error) means the routes are missing.
- **Routes:** exactly the two lines of step 4.
- **Kids:** the keys the API trusts. No output means the parameter is empty and every hub call answers `401`.
- **`chatV1`:** the island flag the page serves. The Worker's own gate (`CHAT_OPEN_TO`, committed in `wrangler.toml` and `dist/deploy.json`, and the Worker secret `CHAT_UAT_SUBJECTS`) decides who may connect, whatever the flag says.
- **Admin route:** `401` means `CHAT_ADMIN_TOKEN` is set and the route is open to a bearer token. Any other code means the secret is not set and the route is closed (the request goes on to the origin).
- **Secrets:** names only, never values. `CHAT_UAT_SUBJECTS` in the list means a tester list is set; its absence means that, while `CHAT_OPEN_TO` is `uat`, nobody can connect. The list cannot show who is on it.

### Roll back and stop

Pick the smallest step that does the job. None of them deletes data.

- **Stop new connections now.** Run the `wr deploy` command of step 3 without `--secrets-file`, and with `--var CHAT_ENABLED:0` added next to the `CHAT_WORKER_VERSION` var. Every new upgrade then closes `4503`; sockets that are already open are not closed by it. The config still says `"1"`, so the next deploy from `main` turns chat on again: if the stop has to last, commit `CHAT_ENABLED = "0"` and rebuild `dist/` first.
- **Close chat to everyone but keep it deployed.** While `CHAT_OPEN_TO` is `uat`, `wr secret delete CHAT_UAT_SUBJECTS --name hfy-chat-worker` empties the tester list, with no deploy and no rebuild ([Name the UAT members](#name-the-uat-members) has the timing). Unlike the kill switch, it also closes sockets that are already open, once the hub takes the change, and it needs no commit to undo: put the list again.
- **Take the Worker off the two paths.** Delete its routes. `/chat/ws` then falls through to CloudFront, which answers `404`, and the client backs off. The data gate, `authV2` and `HFYAppendIndex` are untouched.

  ```sh
  cf_api "$CF/zones/$ZONE_ID/workers/routes" | jq -r '.result[] | select(.script == "hfy-chat-worker") | .id' \
    | while read -r ID; do cf_api -X DELETE "$CF/zones/$ZONE_ID/workers/routes/$ID" | jq .success; done
  ```

  Running the deploy again recreates the routes from the config.
- **Make the API refuse the hub.** A parameter-only change set that sets `ChatServicePublicKeys` to an empty string, built like step 6, returns every service call to `401`. The hub keeps a directory snapshot it already holds; with none, new sockets close `4503`.

**Never delete the Worker or a Durable Object class.** Deleting the script deletes its Durable Objects and every conversation in them. A migration that renames or deletes a class does the same: `v1` stays the only migration, `ChatHub` stays in `new_sqlite_classes`, and the key-value classes (`new_classes`) are never used. Cloudflare's point-in-time recovery is not a restore plan.

### Never tail production

Cloudflare's documentation for the Workers `tail()` handler says a tail event's request headers are redacted by default: the value becomes `REDACTED` when the header name is `cookie` or `set-cookie`, or contains `auth`, `key`, `secret`, `token` or `jwt`. It also says the rules are heuristic, with false positives and negatives, and that a Tail Worker can bypass them with `getUnredacted()`. Recheck that page before you rely on it. So:

- Production is never tailed while the session cookie is in play: no `wrangler tail`, no dashboard live log, and no Tail Worker (`tail_consumers`) on `hfy-chat-worker`.
- No Tail Worker uses `getUnredacted()` on it.
- The Worker keeps `[observability]` and its invocation logs off in `wrangler.toml` (a test pins it), and the hub's own log lines carry event names and counts only.

Cloudflare also notes that `wrangler tail` output for a request that was upgraded to a WebSocket is delayed until the socket closes, which is one more reason not to attach it to a Worker that carries sockets. If you need to debug a socket, use staging, whose cookies and keys are synthetic.

## Name the UAT members

While `CHAT_OPEN_TO` is `uat`, the tester list is the Worker secret `CHAT_UAT_SUBJECTS`: comma-separated Gramps IDs, in the form `<gramps-id>,<gramps-id>`. It is a secret and not a `[vars]` entry so that no Gramps ID is in Git, so that a deploy keeps it (Cloudflare documents that a deploy never deletes secrets), and so that changing it needs no commit, rebuild or deploy. The Worker reads an absent secret exactly like an empty one, and an empty one lets nobody in: nobody connects, appears in the directory or receives a push.

1. Have the Cloudflare credential and wrangler 4.145.0 from [Prerequisites](#prerequisites) in the shell (`wr` from step 2, or `chat-worker/node_modules/.bin/wrangler` after `npm ci`).
2. Run the put. It prompts for the value, so type or paste the list at the prompt:

   ```sh
   wrangler secret put CHAT_UAT_SUBJECTS --name hfy-chat-worker
   ```

   The list is private data. Never put it on the command line, in a file in the repository, in a chat or in a worklog, and never pipe it in with `echo`, which lands it in the shell history. A put replaces the whole list, so give the full list every time.
3. Check by name only: `wr secret list --name hfy-chat-worker` lists `CHAT_UAT_SUBJECTS`. Nobody can read the value back.

**When it takes effect.** The put publishes a new Worker version with the new value, so no deploy is needed. The Worker's upgrade check applies it to the next connection. The hub adopts it when its Durable Object takes that version, which Cloudflare defers for up to 5 minutes or until the object hibernates (see [Redeploy without changing the key](#redeploy-without-changing-the-key)). When the hub next refreshes its directory (a hello refreshes a snapshot older than a minute), the directory and push delivery follow the list, and a member who is no longer on it loses their sockets with `4403`.

**Clear the list.** `wrangler secret delete CHAT_UAT_SUBJECTS --name hfy-chat-worker` closes chat to everyone, with the same timing. It affects only `CHAT_OPEN_TO` being `uat`: with `all` the Worker does not read the list.

**The flip to `all` is still a committed change.** Setting `CHAT_OPEN_TO` to `all` is an edit of `wrangler.toml`, a rebuilt `dist/` and a deploy, so it stays reviewed and tied to a commit. The secret does not change that, and it needs no cleanup afterwards.

## The admin expunge route

`api/scripts/expunge.mjs --chat <conv>:<seq> --apply` (privacy-expunge, [Remove something from the cloud](operate-the-sync-store.md#remove-something-from-the-cloud)) removes one chat message from every cloud copy. The hub's copy is removed through this route, then the script deletes the `CHAT#<conv>` / `M#<seq>` mirror row. HFY-TSK-337 added the route; chat stays dark behind the same flag and UAT list.

**The contract.**

| | |
| --- | --- |
| Request | `POST https://harrisonfamily.us/chat/v1/admin/expunge`, header `Authorization: Bearer <CHAT_ADMIN_TOKEN>`, JSON body `{"conv": "<conversation id>", "seq": <positive integer>}` and nothing else. The conversation id is `dm:<a>:<b>` or `g:<id>`, as the script checks. The body is at most 1024 characters. It sits under the existing `/chat/v1/*` route, so no new Cloudflare route is needed. |
| `200 {"nulled": 1}` | The message existed and had text. The text is now `NULL` in the hub's storage. `seq`, sender, `cmid`, timestamp and kind stay, so the order, a retried send's ack and the 30-day window do not move. |
| `200 {"nulled": 0}` | The message exists and has no text to null: it was already nulled (posting the same message again is always this), or it is a system row (a group renamed, someone added or left). |
| `404 {"error": "not_found"}` | No such conversation or no such seq. `expunge.mjs` reads it as "nothing to null". |
| `401 {"error": "unauthorized"}` | No bearer token, a wrong one, or another scheme. Nothing is read or written. |
| `503 {"error": "archive_busy"}` | An archive drain would not settle (the route waits for up to 20 in a row, with `Retry-After: 5`). Nothing was nulled and nothing is reported as nulled, so the text may still be in a batch in flight. Run the same command again in a minute. `expunge.mjs` stops on it before it deletes the mirror row. |
| `400`, `405`, `413` | A body that is not exactly `{conv, seq}`; a method other than `POST` once the token is right; a body over the cap. The body is read with a byte cap (4096 bytes), so a chunked body with no `content-length` is cut off at the cap, not read whole. |
| No secret | With `CHAT_ADMIN_TOKEN` unset, empty or under 32 characters the Worker does not own the path: the request goes on to the origin like any other unowned request on `/chat/v1/*`. |

The answer carries a count and nothing else, and the route writes no log line: no token, conversation id, seq or text reaches the console (a test pins it).

**Where the text lives, and what the route does to each copy.** The hub is the kit's `ChatHub` (`@io-kit/chat` 0.3.0) with `src/expunge.mjs` wrapped around it.

1. **The Durable Object's SQLite `msg` table.** `text` becomes `NULL` in one synchronous step with the read that found it.
2. **The archive.** The archive drain posts rows to `POST /api/chat/archive` in batches it reads from the table, so a pending batch is simply the table: it now carries the row at its `seq` with an empty `text`. A batch the drain is posting at that moment was read earlier and holds the text in memory, so the route waits for a drain in flight to settle before it nulls: it loops until none is running, at most 20 drains in a row (the bundle has no timer, so the bound is a count), and checks again inside the synchronous step that does the update. If a drain is still running, it nulls nothing and answers `503 archive_busy`, so a caller is never told "nulled" while a batch with the text may still be posted. The script deletes the mirror row only after the route answered, so a late post cannot bring the text back.
3. **No ring buffer, history cache or outbox carries text.** Pushes are `{recipient, conv, seq, actor}`; the directory is labels; the welcome frame lists conversations by seq, not by text. A test walks the whole hub object (core, server, store) for the text and fails if a later kit version adds a copy.
4. **A client's own copy** (a browser tab that already loaded the message) is the client's. The route does not push a removal to connected sockets; the next history read replaces it.

**What a client sees.** A `page` reply, and the `resume` batch of a `hello`, return the message as `{conv, seq, cmid, from, ts, kind: "msg", text: null, expunged: true}` at the same `seq`, between its neighbours. The kit builds those frames, so the hub wraps `store.visible()`, `store.archiveBatches()` and `core.toMsg()` on the instance; if a kit version renames one, the hub constructor throws and the first test fails.

**Chat does not need to be dark for an expunge.** `@io-kit/chat` 0.3.0 (pinned exactly in `chat-worker/package.json` and `islands/package.json`) accepts `{text: null, expunged: true}` in a history batch and shows the message as removed, so `expunge.mjs --chat --apply` is safe while chat is live, once the 0.3.0 island and this Worker are both deployed (until then a deployed older island may not render removed messages, so keep chat dark). The kit's own tests cover how the client renders a removed message; the tests here cover the hub's frames and the pin. A test in `chat-worker/test/expunge.test.mjs` runs the hub's `page` and `resume` batches through the kit's own client decoder, and another pins that the decoder takes a removed message: when a kit upgrade makes either fail, the kit has changed the removed-message contract, so stop and read its release notes. One residual gap remains: a browser tab that loaded the message before the expunge keeps its copy until its next history read (the route does not push a removal to connected sockets; see item 4 above). The task that moved the pin is HFY-TSK-342.

**Still open in `@io-kit/chat`, not done here (one package per PR).** A native expunge notion in the kit (the removed marker in `store.visible`, `archiveBatches` and `toMsg`, and a settle-the-archive call), so `src/expunge.mjs` can drop the instance patches it makes today.

**Instance patches are brittle.** The hub wraps `store.visible()`, `store.archiveBatches()` and `core.toMsg()` on the kit's instance and reads the kit's private `server.archiving`. The constructor throws if one of the three methods is missing; tests pin `server.archiving` (falsy at rest, a promise during a drain) and the history shape. Run `npm test` on every kit upgrade, and treat a failure there as the signal to do the kit follow-up above.

**Set, rotate and remove the secret.** The token is a Worker secret, set once with `wrangler secret put CHAT_ADMIN_TOKEN --name hfy-chat-worker` (wrangler 4.145.0 as in [Deploy the Worker to production](#deploy-the-worker-to-production); it prompts; never put it on the command line, in a file in the repository or in a worklog). Make it with `openssl rand -hex 32`. The operator keeps the same value in `CHAT_HUB_ADMIN_TOKEN` for the one shell that runs `expunge.mjs`, with `CHAT_HUB_ADMIN_URL=https://harrisonfamily.us/chat/v1` (for staging, `https://hfy-chat-worker-staging.<account-subdomain>.workers.dev/chat/v1`). The script requires `https` unless the host is `localhost`.

- **Rotate** when someone who knew it no longer should, after any suspected exposure, and at least once a year: run `wrangler secret put CHAT_ADMIN_TOKEN` with a new value. It takes effect at once and there is one token at a time, so a call made in the gap answers `401`; update `CHAT_HUB_ADMIN_TOKEN` and run it again. Rotation does not touch `CHAT_SERVICE_PRIVATE_KEY` or any member session.
- **Close the route** with `wrangler secret delete CHAT_ADMIN_TOKEN`. The path then goes to the origin as if it did not exist.
- The two secrets are separate on purpose: the service key proves the hub to hfy-api, and this token lets an operator remove a message. One leaking does not open the other.

**Residual copies.** The route reaches the hub's live storage. Cloudflare keeps point-in-time recovery for SQLite-backed Durable Objects (`new_sqlite_classes` in `chat-worker/wrangler.toml`); an expunge does not reach it, so the removed text can survive there until that retention ends. The chat service (Cloudflare) keeps its own recovery copies; Cloudflare says they reach back 30 days, so a removed chat message can stay there for up to 30 days. Check Cloudflare's current retention before you quote a number. The DynamoDB mirror row is deleted by the script, but its point-in-time tail runs 35 days. The two backup tails run in parallel, not one after the other: the Cloudflare tail is 30 days and the DynamoDB tail is 35 days, so the longest a removed chat message can last in a backup is 35 days. The rewritten SQLite pages are also not zeroed on demand. The privacy page (section 7) carries the 35-day database sentence now. The Cloudflare sentence above goes onto the page at the chat flip (HFY-TSK-267), because the page must not announce a feature that is not live, and it is in the approved draft and in [the privacy explanation](../explanation/family-data-privacy.md#removed-data-and-backups) until then (HFY-TSK-359, P2-R79).

**The secret is a step of its own.** The production deploy sets `CHAT_SERVICE_PRIVATE_KEY` only. `CHAT_ADMIN_TOKEN` is set with `wrangler secret put` as above, and a later deploy keeps it, because Cloudflare documents that a deploy never deletes secrets. Until it is set on the production Worker, `--apply` against production fails at the hub call before any mirror row is deleted. [Check where the Worker stands](#check-where-the-worker-stands) shows whether the route is open.

## Design versus task conflict: non-upgrade GET /chat/ws

The design (`chat.md` section 6 and its test list) says a non-upgrade `GET /chat/ws` answers `426 {error: upgrade_required}`. The task's acceptance criteria say every request that is not the upgrade or the health check goes on to the origin with `fetch(request)`. The Worker follows the acceptance criteria: only the upgrade is the hub's, and the kit's own 426 is never reached from the Worker. The `chat.md` owner should reconcile the design text (the test list at the 426 line) with this behaviour.

## What the settings do

| Setting | Where | Meaning |
| --- | --- | --- |
| `CHAT_ENABLED` | `[vars]` | `"1"` serves chat. Anything else is the kill switch: every upgrade closes `4503`. |
| `CHAT_OPEN_TO` | `[vars]` | `uat` lets only the Gramps ids in `CHAT_UAT_SUBJECTS` connect, appear in the directory or receive pushes. `all` opens chat to every eligible member. Only a committed change to `wrangler.toml` followed by a rebuild of `dist/` flips it; never set it in the Cloudflare dashboard or by an upload that keeps other bindings, because a deploy replaces the vars with the ones in `wrangler.toml` (and `dist/deploy.json`). |
| `CHAT_UAT_SUBJECTS` | Worker secret | The comma-separated Gramps ids that may chat while `CHAT_OPEN_TO` is `uat`. Absent or empty lets nobody in. Never in the repository, and `dist/deploy.json` declares no secret bindings. A deploy keeps it. Set, change and clear it as in [Name the UAT members](#name-the-uat-members). |
| `CHAT_SERVICE_KID` | `[vars]` | The `kid` in the header of the hub's service tokens. It must name an entry of `ChatServicePublicKeys` whose public half belongs to `CHAT_SERVICE_PRIVATE_KEY`. Changing it is part of [rotating the key](rotate-the-chat-service-key.md). |
| `CHAT_LOCATION_HINT` | `[vars]` | `wnam`. Every hub object is created with it, and no jurisdiction is set. An unhinted object landed in London in the spike. |
| `CHAT_WORKER_VERSION` | added at deploy (`--var`) | What `GET /chat/v1/health` reports. Not in `wrangler.toml` or `deploy.json`. The health route is unauthenticated and its body is exactly `{ok, version, protocol}`: the deployed commit sha and the protocol number, no env value (a test pins the key set). A deploy check compares the sha with the commit it deployed. |
| `CHAT_SERVICE_PRIVATE_KEY` | Worker secret | The ES256 key the hub signs its calls to hfy-api with. Never in the repository. Set by the production deploy's `--secrets-file`; a later deploy keeps it, because Cloudflare documents that a deploy never deletes secrets. [Rotate the chat service key](rotate-the-chat-service-key.md) replaces it. |
| `CHAT_ADMIN_TOKEN` | Worker secret | The bearer token of `POST /chat/v1/admin/expunge` (below). Its own secret: not `CHAT_SERVICE_PRIVATE_KEY`, not a member session. At least 32 characters, or the route stays closed. Never in the repository, and `dist/deploy.json` declares no secret bindings. A deploy keeps it. |
| `CHAT_PASSTHROUGH` | staging `[vars]` | `off` answers 404 to a request the Worker does not own, because workers.dev has no origin behind it. Unset in production, where such a request goes on to CloudFront with `fetch(request)`. |
| `[observability]` | `wrangler.toml` | Off. A platform log can record request headers, and a header can carry the session cookie. The hub's own log lines carry event names and counts only. Production is never tailed either ([Never tail production](#never-tail-production)). |

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `npm ci` fails with `E401` or `E403` | `CODEARTIFACT_AUTH_TOKEN` is missing or expired. Mint a new one. |
| `npm run check` prints `stale: index.js` | The source, the lockfile, `wrangler.toml` or `shared/privacy-guard.mjs` changed. Run `npm run build` and commit `dist/`. |
| `npm run check` prints `stale` on a clean checkout | `npm ci` installed a different `wrangler` or `esbuild` than the lockfile names. Delete `node_modules` and run `npm ci` again. |
| The smoke script times out starting `wrangler dev` | Another process holds the port, or `workerd` did not install. Run `npx wrangler dev --env staging --local` by hand to read the error. |
| Every socket closes `4503` | `CHAT_ENABLED` is not `"1"`, or the hub has no directory: the API call failed and there is no stored snapshot. The usual cause of the second is the next row. |
| A UAT member's socket closes `4503` although `CHAT_ENABLED` is `"1"` | The hub's call to `GET /api/chat/directory` failed. If `hfy-api` answered `401`, `ChatServicePublicKeys` is empty, has no entry whose `kid` equals `CHAT_SERVICE_KID`, or holds a public half that is not the one for `CHAT_SERVICE_PRIVATE_KEY`; the API logs `chat service token rejected` (an error code, never the token) or `ChatServicePublicKeys unusable` for a malformed value. Compare the kids from [Check where the Worker stands](#check-where-the-worker-stands) with `CHAT_SERVICE_KID`, then fix the parameter with a change set or deploy again with a matching key. |
| Every socket closes `4403` | The `Origin` is not exactly `SITE_ORIGIN`, or `CHAT_OPEN_TO` is `uat` and the member is not in `CHAT_UAT_SUBJECTS`. An absent or empty `CHAT_UAT_SUBJECTS` secret lets nobody in: list the secrets as in [Check where the Worker stands](#check-where-the-worker-stands), then [name the members](#name-the-uat-members). |
| `GET /chat/v1/health` returns the site's HTML or a CloudFront error, not JSON | The routes are missing, or the Worker is not deployed. List the zone's routes as in step 4 of [Deploy the Worker to production](#deploy-the-worker-to-production), then deploy again: the deploy recreates the routes from the config. |
| `health.version` is not the commit you deployed | Through CI, `version` is the commit that last uploaded the bundle, not the latest merge: a merge that leaves `dist/` unchanged makes no upload, so the version stays. If you changed `dist/`, check that the `worker` job was approved and printed `uploaded`. By hand, an older bundle or deploy is serving: run the deploy again from the commit, and check that step 1 printed `bundle matches deploy.json`. |
| The `worker` job fails with `ROUTE DRIFT` or an HTTP `401` or `403` | See [Diagnose a failed token](rotate-the-cloudflare-deploy-token.md#diagnose-a-failed-token). A route difference is fixed by hand with [step 4](#4-check-the-routes-in-the-zone), never from CI. |
| `wrangler deploy` cannot choose an account | The credential reaches more than one account. Export `CLOUDFLARE_ACCOUNT_ID` in the shell; never put the id in the repository. |
