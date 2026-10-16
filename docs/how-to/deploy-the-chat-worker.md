# How to build, test and stage the chat Worker

The chat Worker answers two paths on the site's host, `/chat/ws*` and `/chat/v1/*`, ahead of CloudFront, and holds the `ChatHub` Durable Object that carries every chat conversation ([`chat-worker/`](../../chat-worker/)). This page rebuilds its committed bundle, runs its checks and tests, and exercises it with real sockets, locally and on a staging Worker. It does not deploy production: the first production deploy and the CI deploy target are separate tasks in the plan (`hfy-chat-worker-prod` and `hfy-chat-worker-ci`), and each needs io's go-ahead.

Values in angle brackets are placeholders. The forms are listed in [Private data and secrets](../reference/private-data-and-secrets.md#placeholders).

## Open steps that need io's go-ahead

These are not done, and nothing here claims them:

1. **Smoke against a deployed staging Worker.** The smoke passes 14 of 14 under local `wrangler dev`. Run `npm run staging:deploy`, then `node test/smoke.mjs --url https://hfy-chat-worker-staging.<account-subdomain>.workers.dev`. Needs a Cloudflare login.
2. **Archive mirror writes `CHAT#` items with no `ttl`.** Needs a staging Worker whose `API_BASE` points at a stack that trusts the staging service key, then a DynamoDB sample. Depends on the hfy-api archive route (HFY-TSK-164) being deployed there.
3. **A CodeArtifact-free staleness check for `dist/`.** CI cannot run `npm run check` (the install needs CodeArtifact), so a change to `shared/privacy-guard.mjs` or `src/` can merge with a stale `dist/`. Follow-up: record a hash of the bundled inputs and compare it in CI, or run `npm run check` in a path that has a token.

## Before you start

- **Chat ships dark.** The island flag `chatV1` stays `false`, and the Worker's `CHAT_OPEN_TO` is `uat` with an empty `CHAT_UAT_SUBJECTS`, so nobody can connect until a committed change names them. Nothing on this page changes who can chat.
- **Node 22 or later**, and `CODEARTIFACT_AUTH_TOKEN` exported before any install, because `@io-kit/chat` comes from CodeArtifact ([Build and preview the islands](build-and-preview-the-islands.md) shows how to get a token). The AWS identity that can mint it is the `product-lead` profile.
- **Why the bundle is committed.** CI cannot read CodeArtifact (HFY-R62) and installs no npm package (HFY-R14), so it cannot build the Worker. You build it, and commit [`chat-worker/dist/`](../../chat-worker/dist/) with the source change, exactly like the islands output (HFY-R58).

## Rebuild the bundle

Rebuild after any change to `chat-worker/src/`, `wrangler.toml`, `package.json`, the lockfile, or [`shared/privacy-guard.mjs`](../../shared/privacy-guard.mjs), which the Worker bundles as the hub's R-18 detector.

```sh
cd chat-worker
npm ci
npm run build
```

`npm run build` runs `wrangler deploy --dry-run` (no login, no network) to bundle [`src/index.mjs`](../../chat-worker/src/index.mjs) into `dist/index.js`, then writes `dist/deploy.json` from `wrangler.toml`: the Durable Object binding, the `v1` migration with `new_sqlite_classes`, the compatibility date, the vars and the two routes. The `cloudflare-worker` target of `@io-kit/ci` uploads those two files with `curl`; it injects the commit sha as `CHAT_WORKER_VERSION` at upload, so the bundle stays byte-identical between merges.

Commit everything under `chat-worker/dist/`. Then check it:

```sh
npm run check
```

It rebuilds in a temporary directory and exits `1` and names each file that is missing, stale or extra. It prints `chat-worker/dist is fresh` when the committed bundle is what the source builds to.

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

## Design versus task conflict: non-upgrade GET /chat/ws

The design (`chat.md` section 6 and its test list) says a non-upgrade `GET /chat/ws` answers `426 {error: upgrade_required}`. The task's acceptance criteria say every request that is not the upgrade or the health check goes on to the origin with `fetch(request)`. The Worker follows the acceptance criteria: only the upgrade is the hub's, and the kit's own 426 is never reached from the Worker. The `chat.md` owner should reconcile the design text (the test list at the 426 line) with this behaviour.

## What the settings do

| Setting | Where | Meaning |
| --- | --- | --- |
| `CHAT_ENABLED` | `[vars]` | `"1"` serves chat. Anything else is the kill switch: every upgrade closes `4503`. |
| `CHAT_OPEN_TO`, `CHAT_UAT_SUBJECTS` | `[vars]` | `uat` lets only the listed Gramps ids connect, appear in the directory or receive pushes. `all` opens chat to every eligible member. The UAT list is set only by a committed change to `wrangler.toml` followed by a rebuild of `dist/`; never set it in the Cloudflare dashboard or by an upload that keeps other bindings, because the CI upload replaces vars with the ones in `dist/deploy.json`. |
| `CHAT_LOCATION_HINT` | `[vars]` | `wnam`. Every hub object is created with it. An unhinted object landed in London in the spike. |
| `CHAT_WORKER_VERSION` | injected at upload | What `GET /chat/v1/health` reports. Not in `wrangler.toml` or `deploy.json`. The health route is unauthenticated and its body is exactly `{ok, version, protocol}`: the deployed commit sha and the protocol number, no env value (a test pins the key set). The first-deploy check compares the sha with the commit. |
| `CHAT_SERVICE_PRIVATE_KEY` | Worker secret | The ES256 key the hub signs its calls to hfy-api with. Never in the repository; CI keeps it across uploads. |
| `CHAT_PASSTHROUGH` | staging `[vars]` | `off` answers 404 to a request the Worker does not own, because workers.dev has no origin behind it. Unset in production, where such a request goes on to CloudFront with `fetch(request)`. |
| `[observability]` | `wrangler.toml` | Off. A platform log can record request headers, and a header can carry the session cookie. The hub's own log lines carry event names and counts only. |

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `npm ci` fails with `E401` or `E403` | `CODEARTIFACT_AUTH_TOKEN` is missing or expired. Mint a new one. |
| `npm run check` prints `stale: index.js` | The source, the lockfile, `wrangler.toml` or `shared/privacy-guard.mjs` changed. Run `npm run build` and commit `dist/`. |
| `npm run check` prints `stale` on a clean checkout | `npm ci` installed a different `wrangler` or `esbuild` than the lockfile names. Delete `node_modules` and run `npm ci` again. |
| The smoke script times out starting `wrangler dev` | Another process holds the port, or `workerd` did not install. Run `npx wrangler dev --env staging --local` by hand to read the error. |
| Every socket closes `4503` | `CHAT_ENABLED` is not `"1"`, or the hub has no directory: the API call failed and there is no stored snapshot. |
| Every socket closes `4403` | The `Origin` is not exactly `SITE_ORIGIN`, or `CHAT_OPEN_TO` is `uat` and the member is not in `CHAT_UAT_SUBJECTS`. |
