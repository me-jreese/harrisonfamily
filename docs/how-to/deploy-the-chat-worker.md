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

**Chat does not need to be dark for an expunge.** `@io-kit/chat` 0.3.0 (pinned exactly in `chat-worker/package.json` and `islands/package.json`) accepts `{text: null, expunged: true}` in a history batch and shows the message as removed, so `expunge.mjs --chat --apply` is safe while chat is live. A test in `chat-worker/test/expunge.test.mjs` runs the hub's `page` and `resume` batches through the kit's own client decoder, and another pins that the decoder takes a removed message: when a kit upgrade makes either fail, the kit has changed the removed-message contract, so stop and read its release notes. One residual gap remains: a browser tab that loaded the message before the expunge keeps its copy until its next history read (the route does not push a removal to connected sockets; see item 4 above). The task that moved the pin is HFY-TSK-342.

**Still open in `@io-kit/chat`, not done here (one package per PR).** A native expunge notion in the kit (the removed marker in `store.visible`, `archiveBatches` and `toMsg`, and a settle-the-archive call), so `src/expunge.mjs` can drop the instance patches it makes today.

**Instance patches are brittle.** The hub wraps `store.visible()`, `store.archiveBatches()` and `core.toMsg()` on the kit's instance and reads the kit's private `server.archiving`. The constructor throws if one of the three methods is missing; tests pin `server.archiving` (falsy at rest, a promise during a drain) and the history shape. Run `npm test` on every kit upgrade, and treat a failure there as the signal to do the kit follow-up above.

**Set, rotate and remove the secret.** The token is a Worker secret, set once with `wrangler secret put CHAT_ADMIN_TOKEN` (it prompts; never put it on the command line, in a file in the repository or in a worklog). Make it with `openssl rand -hex 32`. The operator keeps the same value in `CHAT_HUB_ADMIN_TOKEN` for the one shell that runs `expunge.mjs`, with `CHAT_HUB_ADMIN_URL=https://harrisonfamily.us/chat/v1` (for staging, `https://hfy-chat-worker-staging.<account-subdomain>.workers.dev/chat/v1`). The script requires `https` unless the host is `localhost`.

- **Rotate** when someone who knew it no longer should, after any suspected exposure, and at least once a year: run `wrangler secret put CHAT_ADMIN_TOKEN` with a new value. It takes effect at once and there is one token at a time, so a call made in the gap answers `401`; update `CHAT_HUB_ADMIN_TOKEN` and run it again. Rotation does not touch `CHAT_SERVICE_PRIVATE_KEY` or any member session.
- **Close the route** with `wrangler secret delete CHAT_ADMIN_TOKEN`. The path then goes to the origin as if it did not exist.
- The two secrets are separate on purpose: the service key proves the hub to hfy-api, and this token lets an operator remove a message. One leaking does not open the other.

**Residual copies.** The route reaches the hub's live storage. Cloudflare keeps point-in-time recovery for SQLite-backed Durable Objects; an expunge does not reach it, so the removed text can survive there until that retention ends. Check Cloudflare's current retention before you quote a number, and disclose it beside the 35-day DynamoDB point-in-time tail in the privacy text and the runbook (the DynamoDB mirror row is deleted by the script, but its point-in-time tail runs 35 days; the Cloudflare tail is on top of that). The rewritten SQLite pages are also not zeroed on demand. **Open item:** the privacy text does not carry this disclosure yet. BRD2 D2-33 requires it; it is an io/privacy-text change outside this task and is listed in the task's open issues.

**Cloudflare token gate, and what is pending.** The bundle is committed and the CI deploy target belongs to `hfy-chat-worker-ci`. Putting the secret and deploying the Worker need the Cloudflare token (gate G-cf-token), which this change did not use. AC4 (merged and deployed by CI with a green deploy) is **pending**: the push, the CI deploy and `wrangler secret put CHAT_ADMIN_TOKEN` have not happened. Until the Worker is deployed with `CHAT_ADMIN_TOKEN` set, `--apply` against production fails at the hub call before any mirror row is deleted, exactly as before.

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
| `CHAT_ADMIN_TOKEN` | Worker secret | The bearer token of `POST /chat/v1/admin/expunge` (below). Its own secret: not `CHAT_SERVICE_PRIVATE_KEY`, not a member session. At least 32 characters, or the route stays closed. Never in the repository. Whether the CI upload keeps an existing secret is not verified here, and `dist/deploy.json` declares no secret bindings: check it at the first deploy, and set the secret again if the upload dropped it. |
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
