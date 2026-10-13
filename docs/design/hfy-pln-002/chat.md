# HFY-PLN-002 design: webchat (domain `chat`, package `@io-kit/chat`)

Requirements: **R-33, R-34, R-35, R-36, R-37, R-38, R-39, R-40, R-41**.
Related: R-18 (the contact-info guard applies to chat text and group names, §12), R-13 (the notifications domain owns the inbox, the bell and the app badge; chat only adds one push type, §13), R-20/R-21 (the nav domain owns the top bar; chat adds one entry icon, §15.4).
Research intake: io's report **DOC-926937A24A07** (scratchpad `pln2/research/DOC-926937A24A07.md`), which arrived during this design pass. §3 says what is adopted, what deviates and what stays optional.
**Transport: decided.** io decided "chat on cloudflare" on 2026-10-13 (relayed by the orchestrator; the intake task records it verbatim on the record). The transport is Cloudflare Workers plus Durable Objects with WebSocket Hibernation.
Verified by the orchestrator:
- io's Cloudflare account already has an active **Workers Paid** subscription, so there is no billing gate.
- The `harrisonfamily.us` zone is on the Free Website plan, proxied, and has **no Worker routes yet**.
- A wrangler deploy with a scoped API token in CI is available.

Status: design draft. No repository was edited. Every id, name and message in this document is synthetic (`I9001`, `I9002` and `{name}` placeholders). Cloudflare account and zone ids are not written here; they belong only in deploy configuration, the same rule as `AGENTS.md:75`.

---

## 1. Problem

io wants a chat that copies the pre-Google+ Gmail Chat (2006–2013), built first as an io-kit package and then installed on harrisonfamily.us. In io's words: "simple/basic is always better", "NO BELLS AND WHISTLES", and "stability, low latency, and simple intuitive UX are the priorities".

The rules are fixed. They come from io's verbatim intent (DOC-2CFAE07B546C), and this design keeps each one exactly:

| id | rule |
|---|---|
| R-33 | Built as an io-kit package first, then installed. It imitates Gmail Chat closely. Simple beats clever. |
| R-34 | Text and emoji only. No reactions, photos, GIFs or attachments. |
| R-35 | Messages disappear from view after 30 days but are kept on the server. |
| R-36 | Direct chats and group chats. Anyone can start either by picking people from an easy search. |
| R-37 | Online status shows on profiles, in the chat's family section, and in every direct and group chat the user is in. |
| R-38 | The creator names the group. A group is private (only the creator invites) or open (any member invites). Members can leave at any time and must be invited back. A late joiner sees only messages from the moment they joined. |
| R-39 | Direct-chat pacing: when only one person is online, only one message may be sent at a time. Both people must be online for consecutive sends without a reply. |
| R-40 | Every chat has typing indicators. Group chats show several people typing. |
| R-41 | No extras. Stability, low latency and simple UX come first. |

What exists today, and why none of it carries chat:

- **No realtime path.** `hfy-api` is a Lambda Function URL with `InvokeMode: BUFFERED` (`infrastructure/cloudformation/app-stack.yaml:140-145`). It has no WebSocket, no streaming and no AppSync. Every route requires a session (`api/src/handler.js:80-81`).
- **The session cookie is HttpOnly and host-only.** `io_id` is an RS256 JWT verified against `/auth/.well-known/jwks.json`, with issuer `https://harrisonfamily.us/auth` and audience `harrisonfamily-web` (`app-stack.yaml:16-19`, HFY-R38). The kit sets `SameSite=Lax` (`iokit packages/auth/src/edge/index.ts:81`). Page JavaScript never sees the cookie, and the kit's stated posture is "nothing secret reaches page JavaScript" (`iokit packages/auth/src/passkey-client.ts:3`). So only a same-host endpoint can authenticate a socket without a new JS-readable token.
- **The kit's only realtime decision is L-09.** It says signals only, sent over AppSync Events (`iokit docs/explanation/realtime-and-feeds.md:12-18`). A chat that pushes message bodies over the socket needs a dated amendment there (`:33-35`).
- **The site is a multi-page Eleventy site, not a single-page app.** Each navigation is a full page load, so a socket and any docked windows are rebuilt on every page (§6.6).
- **Web Push already exists.** It is the API notifier (`api/src/notify.js:36-56`) on `@io-kit/notify` 0.4.0, which is content-free at level 0 by default and has no inbox. It is the only way to reach a backgrounded iPhone.

## 2. Scope, non-goals, rulings

**In scope:**
- The `@io-kit/chat` package:
  - protocol v1;
  - a runtime-neutral server core;
  - a Cloudflare Durable Object adapter;
  - a transport-agnostic client;
  - the React UI;
  - a conformance suite and a load harness.
- The harrisonfamily install:
  - a chat Worker and Durable Object;
  - three `hfy-api` service routes;
  - one push type;
  - one island and one page;
  - presence on profiles;
  - one flag.
- Load, latency and failure testing, UAT and the flip.

**Not in scope.** Each of these is something io excluded or did not ask for:
- reactions, photos, GIFs, attachments, voice or video (R-34);
- read receipts and delivery ticks;
- message edit and delete;
- chat search;
- an admin chat viewer;
- chat over MCP;
- a "last seen" time;
- the extras listed as optional in §3.3.

**Rulings respected:**
- HFY-R8 and HFY-R42: the surface is default-off behind the `chatV1` flag, with the runtime `?hfy_flags=` override for UAT.
- D-11: the design and after-state audit gate the flip.
- Q-3: infrastructure stays per stack. The kit ships code; harrisonfamily runs its own Worker and Durable Object.
- D-15: chat messages are immutable. The message log, with actor and timestamp on every row and system rows for every membership change, is the audit trail.
- HFY-R68: labels are never email addresses. The directory comes from `api/src/labels.js`.
- HFY-R65: no response is cached.
- HFY-R43: Worker-to-API calls go through CloudFront, which adds `X-Origin-Verify`.

**Amendments.** These follow from io's transport decision (CHAT-D1). Each lands as a dated note in the same change set as the code it explains:
1. **L-09 (io-kit), dated note.** `@io-kit/chat` carries message bodies on its socket. L-09's reason for signals only, a single enforcement point, still holds by construction: the chat server is both the only store and the only reader of chat data, and no HTTP route serves chat messages.
2. **BRD D-10 and `docs/explanation/edge-and-origin-design.md:1-5`.** These say one backend and one CloudFront distribution front everything. They gain one exception: a Cloudflare Worker route for `/chat/ws*` and `/chat/v1/*` sits ahead of CloudFront on the same host.
3. **No HFY ruling is superseded.** This keeps the HFY-R31/R59 pattern of same-origin paths with no new DNS name or certificate.

## 3. Research intake (DOC-926937A24A07)

### 3.1 Adopted as written

- **Transport.** Cloudflare Durable Objects with WebSocket Hibernation, behind a same-origin Worker that verifies `io_id` on upgrade. The runner-up is API Gateway WebSocket + Lambda + DynamoDB.
- **Reliability protocol:**
  - a client message id (`cmid`, a ULID) for idempotency;
  - a gap-free `seq` per conversation, assigned by the server;
  - an explicit `ack`;
  - at-least-once delivery with deduplication by `seq`;
  - gap fill;
  - `hello` with `resume` per conversation.
- **Membership epochs** `(join_seq, left_seq)` for late join and rejoin.
- **Timings:**
  - presence is bound to connections, with a **20 s offline grace** and **idle after 15 min** without input;
  - app ping every 25 s;
  - typing **refresh at most every 3 s, `paused` after 5 s, receiver expiry after 7 s**.
- **Pacing.** Enforced inside the single-threaded object, with the code `PACE_WAIT`.
- **Gmail fidelity:**
  - docked "moles" on desktop and a full-screen sheet on iPhone;
  - Enter sends;
  - green, orange-with-clock and grey presence;
  - sparse timestamps with a "sent at …" line after a gap (patent US7814159);
  - "is typing…" and "has entered text";
  - grey italic system lines;
  - an optimistic grey message that darkens on `ack`;
  - "reconnecting…" only after 2 s.
- **Offline wake path.** The existing AWS Web Push. iOS 16.4+ needs a Home Screen install; Declarative Web Push needs iOS 18.4+.
- **Test plan.** The protocol matrix, chaos, load (500 clients, 20 groups of 30), a real-iPhone matrix and a 72 h soak.

### 3.2 Deviations, with reasons

| research says | this design | why |
|---|---|---|
| Three object kinds: one Durable Object per conversation, one per user, one family-presence object | **One `ChatHub` Durable Object per stack** (CHAT-D3). The kit core keeps per-conversation state isolated, so a later split is mechanical. | At family scale (about 40 active members, a peak of tens of frames per second) one object is far below its limits: a soft 1,000 req/s, 32,768 sockets, 128 MB. One object lets the pacing check read presence and conversation state in one synchronous critical section, with no cross-object presence cache. The research's own design reads "the peer's User DO cache (pushed on change)", which lags. One object also removes a hop from the latency budget and leaves one SQLite file to back up. The research topology is the documented scale-out path (§5.3). |
| "Idle = no input for 15 minutes **or tab hidden**" | Idle means 15 min without input only. A hidden **mobile** page closes its socket, which starts the 20 s grace and then goes offline. A hidden **desktop** tab stays connected and goes idle by the 15-minute rule. | Gmail's documented rule is "automatic after 15 minutes away from the computer" (help answer 29298/161809). Counting a hidden desktop tab as idle would turn most desktop members orange all the time. A hidden iPhone PWA is suspended anyway. |
| The "Sent at 3:42 PM on Tuesday" wording | `sent at 3:42 pm on tuesday` | The io-approved design-system voice uses lowercase sentences (HFY-R13). The exact Gmail string is unverified either way. |
| A nightly export to S3 (optional) | An **archive mirror into DynamoDB `hfy-app`**, batched every 10 min (CHAT-D9) | This keeps a copy of the retained history (R-35) in the existing system of record and its point-in-time recovery. It needs no S3 credential in the Worker. It also feeds the runner-up if Cloudflare is ever dropped. |
| On a Worker auth failure, "fall back to a short-lived ticket from your HTTP API" | No ticket. Auth failures are reported with **WebSocket close codes** (§6.5). | A browser cannot read the HTTP status of a failed upgrade. Close codes 4401 and 4403 tell the client exactly what happened. A ticket would put a credential in page JavaScript. |

### 3.3 Things the report adds that io did not ask for: optional, not default

These are **not built** in v1. Each one would need a new io decision.

| item | default | note |
|---|---|---|
| Busy (red) | off | A manual state. io asked only for "online status". |
| Custom status message | off | |
| Invisible | **never** | It breaks R-39: an invisible sender either leaks being online through unpaced sends, or gets paced while online. |
| Off the record | **never** | It contradicts R-35 ("stored on server"). |
| Mobile-device presence icon | off | |
| Sounds | off | Gmail had them on by default, but R-41 ("no bells") wins. |
| Block a contact | off | Family scope. The gap is listed under risks (§26). |
| Chat history search | off | |
| Read receipts, "last seen" | **never** | io did not ask for them, and they add surveillance. |
| Per-chat mute, app badge from chat | off | The notifications domain owns the badge. |
| Adaptive timestamp threshold (T = 4 × median gap) | off | A fixed 5-minute threshold. |

These fidelity items **are** default, because they are the Gmail experience io asked to imitate (R-33): moles, pop-out, Enter sends, `me:` prefixes, the sparse "sent at" line, the typing strings, rendering typed emoticons as emoji, the flashing title bar, and `q` to focus chat search. Each one can be cut at UAT without touching the protocol.

## 4. Transport (CHAT-D1: decided by io, 2026-10-13, "chat on cloudflare")

The comparison below is kept as the record of why, and as the contingency if Cloudflare ever has to be dropped. It is no longer an open gate.

### 4.1 Options and the HttpOnly cookie

| | **A. Durable Objects + Hibernation on a same-host Worker route** (default) | **B. AppSync Events** (L-09 transport) | **C. API Gateway WebSocket behind CloudFront** (runner-up) |
|---|---|---|---|
| Does `io_id` reach the endpoint? | Yes. The upgrade is a same-origin `GET https://<site>/chat/ws` and carries the host-only `SameSite=Lax` cookie. | **No**, because the endpoint is a different host. The `/event` and `/event/realtime` paths would also collide with the gated `/event/*` behavior (`docs/reference/architecture.md:66`). | Yes, through a new CloudFront behavior `/chat/ws` that forwards `Cookie` and `Sec-WebSocket-*`. |
| Token in page JavaScript | None | **Required.** It needs a new mint endpoint for a short-lived subscribe-only JWT, which breaks the passkey-client posture. | None |
| Verifier | The Worker checks RS256 with WebCrypto against the JWKS. It is a second verifier, like the data gate (`edge-gate/src/gate.mjs:79-99`). | OIDC mode needs `<issuer>/.well-known/openid-configuration`, which returns 404 today, or a Lambda authorizer. | The `$connect` Lambda reuses `createAuthenticator` (`api/src/auth.js:34-53`). |
| Session expiry mid-socket (`io_id` lives 1 h) | The server closes with 4401 at expiry. The client refreshes and resumes, making the new socket before breaking the old (§6.5). | Refresh the token and resubscribe. | Close at expiry by hand. API Gateway also forces a reconnect every 2 h and after 10 min idle. |
| Message path latency | Edge-terminated, in-memory fan-out, no cold start | Signal, then fetch over CloudFront → Lambda → DynamoDB, plus cold starts | One Lambda per frame, a DynamoDB lookup, and one PostToConnection per recipient |
| Presence | Bound to connections, with real close events and a liveness sweep | Heartbeat POSTs only, because handlers are `onPublish`/`onSubscribe` with no connect or disconnect hook | `$disconnect` is best effort, so a TTL sweep is needed |
| Race-free pacing | Single-threaded object, one synchronous section | DynamoDB `TransactWriteItems` with a `ConditionCheck` on presence, which needs `Update`/`ConditionCheck` support added to `transact()` (`api/src/txn.js:32-38`) | Same as B |
| New platform | **Yes**: a Cloudflare Worker, a Durable Object, wrangler for builds, and a scoped API token as a CI secret | No | No |
| Monthly cost at family scale | About $0 extra. The account's existing Workers Paid subscription covers it within its included quotas (§23). | About $1–11 | About $1–5 plus Lambda |
| Fit (research §2B) | 5 | 3 | 4 |

### 4.2 Decision and its consequences

**A is decided** (io, 2026-10-13). It was also this design's recommendation. It is the only option that keeps the cookie-only auth posture, gives true connection presence, and enforces pacing race-free with no added machinery. Each of these maps to R-41.

What the decision brings, all designed below:

- **The plan.** Workers Paid is already active on io's account (verified), so CHAT-D2 is resolved, with no billing gate and no hard daily limits. The zone stays on its Free Website plan. Worker routes work on every zone plan.
- **The second platform.** The Worker, the Durable Object and the route are **deployed by CI** with a scoped Cloudflare API token held as a GitHub Actions secret (§17.1, CHAT-D18). wrangler is used locally for builds, dev and staging.
- **The L-09 and D-10 amendments** in §2.
- **One route on the zone.** The zone has no Worker routes today. `harrisonfamily.us/chat/ws*` and `harrisonfamily.us/chat/v1/*` are the first, and every other path keeps reaching CloudFront unchanged. The spike verifies that this coexists with the CloudFront proxy (§25).

**The contingency is C, if Cloudflare must ever be dropped.** Nothing above the transport changes:
- **The protocol and client stay.** C carries the same WebSocket and JSON frames (§6).
- **The server core runs under Lambda.** `ChatCore` (§16) runs against a DynamoDB `ChatStore`, whose `append` with a guard (§7.4) maps to one `TransactWriteItems`.
- **The data is already in AWS.** The DynamoDB `CHAT#` archive (§7.2) holds the retained history.
- **Tasks.** These contingency tasks are not filed: `chat-kit-store-dynamo` and `hfy-chat-apigw`.

B was rejected. It would put a credential in page JavaScript, add a new host or DNS name, use heartbeat presence, and add a fetch round trip to every message.

## 5. Architecture

### 5.1 Components

```
 iPhone PWA / desktop browser  (islands: chat.jsx on every page when chatV1 is on; /chat/ page)
        │  wss://<site>/chat/ws  (same origin, io_id cookie)            https://<site>/*  (everything else)
        ▼                                                                       ▼
 Cloudflare proxy ── Worker route /chat/ws*, /chat/v1/* ──►  hfy-chat Worker      CloudFront (unchanged)
                                                              │ verify io_id (WebCrypto RS256, JWKS cache 300 s)
                                                              │ Origin check, kill switch, UAT allowlist
                                                              ▼
                                                    ChatHub Durable Object (one per stack, idFromName("family"))
                                                    SQLite: conv, member, msg, readpos, presence, directory, outboxes
                                                    Hibernating sockets, tagged by uid; attachments hold presence
                                                              │ service JWT (ES256), via <site>/api/* → CloudFront → hfy-api
                                                              ▼
                                       hfy-api: GET /api/chat/directory · POST /api/chat/push · POST /api/chat/archive
                                                 │ notifier (webpush + VAPID)        │ DynamoDB hfy-app CHAT#…
```

### 5.2 Request paths

- **Socket.** The browser connects to the Worker, which forwards to the hub, which accepts the socket (`ctx.acceptWebSocket(ws, [uid])`). All chat traffic stays on this socket. A typical cost is one connect per page view in the multi-page site (§6.6).
- **Directory.** The hub fetches `/api/chat/directory` at most every 5 min, only when a `hello` finds the snapshot stale. The snapshot lives in SQLite, so it survives hibernation.
- **Push.** After commit, the hub writes `push_outbox` rows. An alarm drains them to `/api/chat/push`.
- **Archive.** An alarm sends committed rows past `archive_cursor` to `/api/chat/archive` every 10 min while any are pending.
- **Health.** `GET /chat/v1/health` is anonymous and returns only `{ok, version, protocol}`. It is used by the deploy smoke check.

### 5.3 Why one hub, and when to split

The hub serializes every chat event for the stack. Family scale is about 40 active members (`cost-estimate.md` traffic model), with about 800 messages, 2,400 typing frames and a few hundred presence frames a day. That is 3–4 orders of magnitude below one object's limits.

**Split triggers**, measured in hardening (§20) and in production logs:
- sustained over 200 inbound frames per second;
- over 5,000 concurrent sockets;
- SQLite over 1 GB;
- p99 handler time over 50 ms.

**The split.** Move to the research topology: one `ConversationObject` per conversation and a presence object. The core already separates per-conversation state behind `ChatStore`. Pacing then reads presence pushed from the presence object, a documented and bounded lag.

## 6. Protocol v1

JSON text frames, one object per frame, with `t` as the discriminator. Inbound frames are at most 8 KiB; a larger frame closes the socket with 1009. The server stamps every timestamp (epoch ms). Client clocks are never trusted.

### 6.1 Client to server

```jsonc
{ "t": "hello", "v": 1, "sid": "<tab ULID>", "vis": true, "resume": { "dm:I9001:I9002": 41, "g:01JC…": 7 } }
{ "t": "send",   "conv": "dm:I9001:I9002", "cmid": "01JC…", "text": "dinner at 6? 🙂" }   // a DM row is created on its first send
{ "t": "create", "cmid": "01JC…", "members": ["I9002", "I9003"], "name": "cousins", "policy": "private" }  // groups only
{ "t": "invite", "conv": "g:01JC…", "cmid": "01JC…", "members": ["I9004"] }
{ "t": "leave",  "conv": "g:01JC…", "cmid": "01JC…" }
{ "t": "rename", "conv": "g:01JC…", "cmid": "01JC…", "name": "cousins 2026" }   // creator only; "" clears the name
{ "t": "policy", "conv": "g:01JC…", "cmid": "01JC…", "policy": "open" }         // creator only
{ "t": "typing", "conv": "g:01JC…", "state": "on" }        // on | paused | off
{ "t": "state",  "s": "idle", "vis": false }                // active | idle; vis = document.visibilityState === "visible"
{ "t": "read",   "conv": "g:01JC…", "seq": 48 }
{ "t": "page",   "conv": "g:01JC…", "before": 20, "limit": 50, "rid": "r7" }   // or "after": n (gap fill)
{ "t": "ping" }                                             // answered by setWebSocketAutoResponse, without waking the hub
```

### 6.2 Server to client

```jsonc
{ "t": "welcome", "v": 1, "me": "I9001", "serverTs": 1760371200000,
  "people":   [ { "id": "I9002", "label": "{name}" } ],                 // eligible members only (§8.1)
  "presence": { "I9002": "active", "I9003": "idle" },                   // absent = offline
  "convs":    [ Summary ], "limits": { "text": 1000, "lines": 20, "group": 50, "name": 60 } }
// Summary = { id, kind: "dm"|"group", name?, creator, policy?, members: [uid], lastSeq, lastTs, lastMsgSeq?, lastMsgFrom?, readSeq }
{ "t": "ack",   "cmid": "01JC…", "conv": "dm:I9001:I9002", "seq": 42, "ts": 1760371200123 }
{ "t": "msg",   "conv": "dm:I9001:I9002", "seq": 42, "cmid": "01JC…", "from": "I9001", "kind": "msg", "text": "dinner at 6? 🙂", "ts": 1760371200123 }
{ "t": "msg",   "conv": "g:01JC…", "seq": 9, "cmid": "01JC…", "from": "I9002", "kind": "sys", "sys": { "op": "added", "who": ["I9004"] }, "ts": … }
{ "t": "batch", "conv": "g:01JC…", "rid": "r7", "msgs": [ Msg ], "more": false }
{ "t": "conv",  "conv": Summary }                            // created, joined, renamed, policy changed, member change
{ "t": "conv",  "id": "g:01JC…", "removed": true }           // you left
{ "t": "typing","conv": "g:01JC…", "user": "I9002", "state": "on" }
{ "t": "presence", "user": "I9002", "state": "offline" }
{ "t": "read",  "conv": "g:01JC…", "seq": 48 }                // your own other tabs
{ "t": "err",   "cmid": "01JC…", "conv": "dm:I9001:I9002", "code": "PACE_WAIT", "msg": "…", "spans": [[12, 24, "phone"]] }
{ "t": "reauth","exp": 1760374800 }                           // session about to lapse; the server closes 4401 at exp + 60 s
{ "t": "pong" }
```

`sys.op` values:
- `created` with `{members, name?, policy}`;
- `named` with `{name}`;
- `added` with `{who: [uid]}`;
- `left` (the actor is `from`);
- `policy` with `{policy}`.

### 6.3 Ordering, idempotency, acknowledgement

- **Ordering.** The hub assigns `seq = conv.last_seq + 1` inside one `transactionSync` that inserts the row and updates `conv`. A conversation's `seq` is gap-free and totally ordered. System rows share the sequence.
- **Idempotency.** `(conv, from_uid, cmid)` is unique (§7.1). A repeated `send`, `invite`, `leave`, `rename` or `policy` with the same `cmid` gets the original `ack` again and changes nothing. `create` deduplicates on `(creator, created_cmid)`.
- **When `ack` is sent.** Only after commit. The Durable Object output gate holds outgoing frames until the write is durable, so an `ack` means the message is stored.
- **Fan-out.** One `msg` goes to every live socket of every current member, the sender's other tabs included. The sender's own tab matches the `ack` to its pending row by `cmid`.
- **Client deduplication.** By `(conv, seq)`.
- **Gap detection.** If `seq > lastSeq + 1` arrives, the client sends `page {after: lastSeq}`.

### 6.4 Resume

**At connect:**
1. `hello.resume` lists the last `seq` the client holds for each conversation it has cached.
2. The hub answers with `welcome`, then one `batch` per resumed conversation. A batch holds the visible rows after that `seq`, capped at 200, with `more: true` when there are more. The client keeps paging with `page {after}`.
3. Conversations not in `resume` get a summary only. Their messages load with `page` when they are opened.

**Reconnect timing.** Backoff runs from 500 ms to 30 s with 50–100 % jitter. These are the same constants as the kit's AppSync client (`iokit packages/feed/src/appsync.ts:32-42`), copied rather than imported, so the package has no feed dependency. The client reconnects at once on `visibilitychange: visible`, `pageshow` and `online`. It shows "reconnecting…" only after 2 s.

### 6.5 Auth lifecycle and close codes

**The upgrade.** The Worker checks, in this order:
1. `Origin` is exactly `https://<site>`;
2. the kill switch;
3. the `io_id` signature, `alg` RS256, `kid`, `iss`, `aud`, `exp`/`nbf` with 60 s skew, and the shape of `sub`. These are the same checks as the gate (`edge-gate/src/gate.mjs:79-99`; `edge-gate/gate.config.json`);
4. the UAT allowlist.

**Rejections.** A browser cannot read the HTTP status of a failed upgrade, so every rejection **accepts** the socket from a `WebSocketPair` inside the Worker and closes it at once with an application code. The hub never sees it.

**Accepted sockets.** The Worker forwards `x-chat-uid` and `x-chat-exp` to the hub. The hub stores `exp` in the socket attachment. At `exp − 120 s` the hub sends `reauth`; at `exp + 60 s` it closes with 4401.

**Client refresh.** The client reads `exp` from `/auth/session` (`auth/src/edge.js:279-285`). At `exp − 120 s` it:
1. calls the page's single-flight refresh (`11ty/js/feature-flags.js:518`, which needs to be exported as `HFYFeatureFlags.refreshSession`);
2. opens a new socket with `hello`/`resume`;
3. closes the old socket with 4010.

| code | meaning | client action |
|---|---|---|
| 1000 | normal (page hidden on mobile, page unload) | none |
| 1001 / 1006 / 1012 | going away, abnormal, service restart (a deploy) | backoff, then reconnect and resume |
| 1009 | frame too big | drop the frame, report "that's too long for chat.", reconnect |
| 4010 | replaced by a newer socket from the same tab, or the user exceeded 10 sockets | no reconnect from this socket |
| 4400 | malformed frame or protocol violation | reconnect once; if repeated, stop and log |
| 4401 | unauthenticated or session expired | refresh once, then reconnect; if refresh fails, show "sign in to chat." |
| 4403 | forbidden: bad origin, not an eligible member, not in UAT | stop, hide chat for this page |
| 4408 | liveness timeout (no ping) | reconnect at once |
| 4409 | protocol version unsupported | show "a newer chat is ready. reload the page." |
| 4429 | too many frames | wait 60 s, then reconnect |
| 4503 | chat disabled (kill switch) or the directory is unavailable with no snapshot | wait 5 min, then reconnect; show "chat isn't available right now." |

### 6.6 Multi-page site behavior

Every navigation closes the socket (code 1000 on `pagehide`) and the next page opens a new one, usually within 1 s. The 20 s presence grace keeps this from flapping.

The client keeps a per-tab snapshot in `sessionStorage` under the key `hfy:chat:v1:<uid>`:
- conversation summaries;
- the last 50 visible messages of each open conversation;
- open moles `{id, minimized}`;
- drafts;
- at most **one** queued outbox message per conversation.

The snapshot is capped at 200 KB; on a quota error the message cache is dropped first. The next page renders from the snapshot at once and resumes from its `seq`. Sign-out clears every `hfy:chat:` key (`islands/src/islands/shell.jsx:125` gains the prefix sweep). Using `sessionStorage` instead of `localStorage` keeps cached text from outliving the tab on a shared computer.

### 6.7 Rate limits (per user, in the hub, token buckets in the socket attachment)

| frames | limit | over the limit |
|---|---|---|
| `send` | 5/s, burst 10 | `err RATE_LIMITED`, `retry: true` |
| `typing` | 1/s per conversation | dropped silently |
| `create` | 10/min | `err RATE_LIMITED` |
| `invite` | 20/min | `err RATE_LIMITED` |
| `page` | 10/s | `err RATE_LIMITED` |
| all frames together | 30/s sustained for 5 s | close 4429 |
| sockets per user | 10 | the oldest closes with 4010 |

## 7. Data model (exact keys)

### 7.1 Hub SQLite (Durable Object storage, schema v1)

The hub runs these idempotent statements on every cold start. `wrangler.toml` declares the class with `new_sqlite_classes = ["ChatHub"]` (migration tag `v1`). A Durable Object class is **never** renamed or deleted, because a delete migration destroys its data (§26).

```sql
CREATE TABLE IF NOT EXISTS schema_version (v INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS conv (
  id            TEXT PRIMARY KEY,          -- 'dm:<uidA>:<uidB>' with uidA < uidB (code-point order) | 'g:<ULID>'
  kind          TEXT NOT NULL CHECK (kind IN ('dm','group')),
  name          TEXT,                      -- group only, <= 60 code points; NULL = unnamed
  creator       TEXT NOT NULL,             -- gramps_id (session sub)
  policy        TEXT CHECK (policy IN ('private','open')),   -- group only
  created_at    INTEGER NOT NULL,
  created_cmid  TEXT NOT NULL,
  last_seq      INTEGER NOT NULL DEFAULT 0,
  last_ts       INTEGER NOT NULL,
  last_msg_seq  INTEGER,                   -- newest kind='msg' row
  last_msg_from TEXT                       -- its author: the R-39 pacing input
);
CREATE UNIQUE INDEX IF NOT EXISTS conv_created ON conv(creator, created_cmid);
CREATE TABLE IF NOT EXISTS member (
  conv       TEXT NOT NULL,
  uid        TEXT NOT NULL,
  epoch      INTEGER NOT NULL,             -- 1, 2, … per (conv, uid)
  join_seq   INTEGER NOT NULL,             -- seq of the 'created'/'added' row (DM: 1)
  left_seq   INTEGER,                      -- seq of their 'left' row; NULL = current member
  invited_by TEXT,
  PRIMARY KEY (conv, uid, epoch)
);
CREATE INDEX IF NOT EXISTS member_uid ON member(uid, left_seq);
CREATE TABLE IF NOT EXISTS msg (
  conv     TEXT NOT NULL,
  seq      INTEGER NOT NULL,
  cmid     TEXT NOT NULL,
  from_uid TEXT NOT NULL,
  kind     TEXT NOT NULL CHECK (kind IN ('msg','sys')),
  text     TEXT,                           -- kind='msg': normalized text (§12.2)
  sys      TEXT,                           -- kind='sys': JSON {op, …}
  ts       INTEGER NOT NULL,
  PRIMARY KEY (conv, seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS msg_cmid ON msg(conv, from_uid, cmid);
CREATE INDEX IF NOT EXISTS msg_ts ON msg(conv, ts);
CREATE TABLE IF NOT EXISTS readpos (
  uid          TEXT NOT NULL,
  conv         TEXT NOT NULL,
  read_seq     INTEGER NOT NULL DEFAULT 0,
  notified_seq INTEGER NOT NULL DEFAULT 0, -- push sent for the unread run that starts after read_seq
  PRIMARY KEY (uid, conv)
);
CREATE TABLE IF NOT EXISTS presence (
  uid         TEXT PRIMARY KEY,
  state       TEXT NOT NULL CHECK (state IN ('active','idle','offline')),
  since       INTEGER NOT NULL,
  grace_until INTEGER                      -- set when the last socket closes; offline is announced then
);
CREATE TABLE IF NOT EXISTS directory (uid TEXT PRIMARY KEY, label TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);   -- 'directory_at', 'jwks' is NOT here (Worker memory)
CREATE TABLE IF NOT EXISTS push_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT NOT NULL, conv TEXT NOT NULL, seq INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS archive_cursor (conv TEXT PRIMARY KEY, seq INTEGER NOT NULL DEFAULT 0);
```

The **socket attachment** (16 KiB maximum, it survives hibernation) holds:
- `uid`, `sid`, `exp`;
- `st` (`active` or `idle`), `vis`, `at` (connect time);
- `typ`, the conversations where this socket last sent `typing on` or `paused`;
- `tb`, the token-bucket state.

The socket tag is `uid`.

**The visibility query** (R-35, R-38). It is the only read path for message rows:

```sql
SELECT m.* FROM msg m
JOIN member e ON e.conv = m.conv AND e.uid = :uid
WHERE m.conv = :conv
  AND m.seq >= e.join_seq AND (e.left_seq IS NULL OR m.seq <= e.left_seq)
  AND m.ts  >= :now - 2592000000          -- 30 days
  AND m.seq >  :after                      -- or m.seq < :before … ORDER BY seq DESC
ORDER BY m.seq LIMIT :limit;
```

Any read for a user with no epoch row in the conversation returns `NOT_MEMBER`.

### 7.2 DynamoDB archive mirror (`hfy-app`, written only by `POST /api/chat/archive`)

| PK | SK | attributes |
|---|---|---|
| `CHAT#<convId>` | `META` | `entity:"chat_conv"`, `kind`, `name`, `creator`, `policy`, `created_at`, `last_seq`, `archived_at` (overwritten on each batch) |
| `CHAT#<convId>` | `E#<uid>#<epoch:4 digits>` | `entity:"chat_member"`, `join_seq`, `left_seq`, `invited_by` |
| `CHAT#<convId>` | `M#<seq:10 digits>` | `entity:"chat_msg"`, `seq`, `cmid`, `from`, `kind`, `text` or `sys`, `ts` |

- **No `ttl` attribute, ever.** The table's TTL attribute is `ttl` (`app-stack.yaml:61`), and R-35 requires retention.
- **No GSI1 attributes.** This is an archive, never queried by the UI.
- **Point-in-time recovery** covers it (`app-stack.yaml:62`).
- **Retries are safe.** Message rows are immutable, so the mirror writes `BatchWriteItem` puts that a retry can repeat. The role already allows `BatchWriteItem` (`app-stack.yaml:90`).
- **`api/src/keys.js` gains** `chatConvKeys(id)`, `chatMemberKeys(id, uid, epoch)` and `chatMsgKeys(id, seq)`.

### 7.3 Client keys

- `sessionStorage['hfy:chat:v1:<uid>']`, the snapshot described in §6.6.
- `localStorage['hfy:chat:panel']`: `"open"` or `"closed"`, the roster panel state on desktop. It holds no content.

### 7.4 `ChatStore` interface (kit, runtime-neutral)

```ts
interface ChatStore {
  getConv(id: string): ConvRow | null;
  currentMembers(conv: string): string[];
  epochsOf(conv: string, uid: string): Epoch[];
  convsOf(uid: string): ConvRow[];
  // Atomic: checks guard, assigns seq = last_seq + 1, inserts the row, updates conv, opens or closes epochs. Returns the row or a guard failure.
  append(conv: string, row: DraftRow, guard: { pacing?: { sender: string; peerOnline: boolean }; membership?: MembershipChange }): Appended | GuardFail;
  createConv(row: NewConv, members: string[]): Appended;   // seq 1 'created' row for groups; DM: no row
  visible(uid: string, conv: string, q: { after?: number; before?: number; limit: number; now: number }): MsgRow[];
  setRead(uid: string, conv: string, seq: number): void;
  // presence, directory, push_outbox, archive_cursor accessors …
}
```

`SqlStore` implements it over `ctx.storage.sql.exec` with `transactionSync`. `MemoryStore` serves tests. A future `DynamoStore` (runner-up C) implements `append` as one `TransactWriteItems`:
- an `Update` on `conv` with the condition `last_seq = :expected` (plus `last_msg_from <> :sender` when the pacing guard is set and the peer is offline);
- a `Put` of the message with the condition `attribute_not_exists(PK)`.

## 8. Conversations, membership and groups (R-36, R-38)

### 8.1 Who can chat

**Eligible members** are the principals in the family allowlist: the gramps_ids that are values of `config/userGrampsID.json`. Each comes with a label from `createLabelResolver` (`api/src/labels.js:41`), which is never an email (HFY-R68, `labels.js:19-23`). The hub gets them from `GET /api/chat/directory`, so the Worker never sees the allowlist or any email.

During UAT the set is narrowed to `CHAT_UAT_SUBJECTS` (§18). This stops testers from messaging, and pushing to, members who cannot open chat yet.

**Starting a chat** (R-36):
- **Direct chat.** Pick one person in the roster search. The conversation id is `dm:<a>:<b>`, computed by the client. The row is created on the first `send`. Messaging yourself is rejected (`UNKNOWN_USER`).
- **Group.** "new group", pick 1 to 49 people, give an optional name, choose private (the default) or open. This sends `create`.
- **"add people" from a direct chat** opens the same picker with the peer pre-selected and creates a **new** group. The direct chat's history is never carried over (R-38).

### 8.2 Group rules

| action | allowed for | effect (system row) | errors |
|---|---|---|---|
| create | any eligible member | `created {members, name?, policy}`, seq 1. Every initial member gets epoch 1 with `join_seq = 1`. | `UNKNOWN_USER`, `GROUP_FULL` (over 50), `NAME_INVALID`, `CONTACT_INFO` (name) |
| rename | **creator only**, while a current member | `named {name}` | `NOT_ALLOWED`, `NAME_INVALID`, `CONTACT_INFO` |
| policy | **creator only**, while a current member | `policy {policy}` | `NOT_ALLOWED` |
| invite | private: **creator only**. Open: **any current member**. | `added {who}`, then a new epoch for each invitee with `join_seq` = that row's seq | `NOT_ALLOWED`, `UNKNOWN_USER`, `ALREADY_MEMBER` (ignored per id), `GROUP_FULL` |
| leave | any current member of a group | `left` (actor = `from`). Their epoch closes with `left_seq` = that row's seq. They get `conv {removed}`. | `NOT_MEMBER`; in a direct chat, `NOT_ALLOWED` |

Notes:
- **Direct chats** have exactly two members and cannot be left. Closing the window is not leaving.
- **Private group after the creator leaves.** It becomes invite-locked, because nobody else may invite (R-38 read literally). It keeps working for the members who remain. The creator cannot return, because only the creator may invite. This is documented in the help line on leave: "you'll need an invite to come back."
- **Open group after the creator leaves.** The name and policy are frozen.
- **A group whose last member leaves** stays in storage and the archive, and is invisible to everyone.
- **What a returning member sees (CHAT-D11).** The union of their epochs: what was said while they were in the chat. Messages from the time they were away are never visible. A late joiner's first epoch starts at the `added` row, so they see only what comes after it (R-38).

### 8.3 The 30-day window (R-35)

**Server.** Every read path applies `ts >= now − 30 days` (§7.1). Rows are never deleted from the hub or the archive.

**Client.** Every 10 minutes, and on each render, the client drops messages older than 30 days from the view and from the snapshot, so an open window also "disappears" them.

**Retention.** Indefinite. There is no UI access past 30 days. Access is an operator export only, a DynamoDB query of the `CHAT#` archive, under io's go-ahead (CHAT-D9).

## 9. Direct-chat pacing (R-39)

**Definition of online (CHAT-D5, io-owned).** A user is online when either is true:
- they have at least one live socket. Idle counts as online; idle changes only the dot;
- their last socket closed less than **20 s** ago (the grace period).

The hub decides this, and it is exactly the state the hub has announced in `presence` frames. A hidden mobile page closes its socket (§10.2), so an iPhone in a pocket is offline about 20 s after the screen locks.

**Rule.** On a `send` in `dm:<s>:<p>` from sender `s`, with peer `p`:

```
if presence(p) is offline AND conv.last_msg_from == s  →  err PACE_WAIT   (nothing stored)
otherwise                                              →  append
```

Equivalently, while the peer is offline, the sender may have at most one message after the peer's last message. While both are online, consecutive sends are free. Groups are never paced. System rows do not count, because `last_msg_from` tracks only `kind='msg'`.

**Why there is no race.** The hub handles one event at a time. The `PACE_WAIT` check, the `seq` assignment, the insert and the `conv` update run in one `transactionSync` with no `await` in between. The hub also applies presence transitions: socket close, grace expiry by alarm, liveness sweep. So no send can interleave with another send, or with a presence change, between the check and the write. Two tabs sending at once are serialized: the second sees `last_msg_from == s`. A retry with the same `cmid` returns the original `ack` and is not counted twice.

**Client pre-check.** The same rule runs in the client from `presence` frames and the summary's `lastMsgFrom`, so the composer is disabled before a send rather than after it.

**UI:**
- **Before sending one message to an offline peer**, a grey line above the composer reads "{name} is offline. they'll see your message when they're back."
- **After that one message**, the composer is disabled and the line reads "{name} is offline. you can send another message after they reply."
- **When the peer comes online, or a reply arrives,** the composer is enabled again at once.
- **If the server still answers `PACE_WAIT`** (the client view was stale), the pending row is removed and its text goes back into the composer with the same line. There is no pop-up.
- **While disconnected**, one message per conversation may queue ("sends when you're back online"). Enter is disabled after that, which avoids queuing a run that pacing would reject.

## 10. Presence (R-37)

### 10.1 States

| state | dot | text | rule |
|---|---|---|---|
| `active` | green, filled | "online" | at least one socket with input in the last 15 min |
| `idle` | orange with white clock hands | "idle" | sockets exist, and none has had input for 15 min. Gmail: "automatic after 15 minutes … cannot be selected manually". |
| `offline` | grey ring (hollow) | "offline" | no sockets, and the 20 s grace has passed |

Shape plus text, never colour alone (WCAG 1.4.1). The dot tokens must meet 3:1 against `surface` (WCAG 1.4.11).

### 10.2 Sources and timing

**Client:**
- Input is `keydown`, `pointerdown`, `touchstart`, `wheel` or `scroll` (throttled to once a second), or `focus`.
- After 15 min with no input the client sends `state idle`; the next input sends `state active`.
- On iOS and Android (`detectPlatform()` from `@io-kit/shell/react`), `visibilitychange: hidden` and `pagehide` close the socket with 1000. Desktop keeps the socket while hidden.
- `ping` every 25 s.

**Hub:**
- **User state** is the strongest state across the user's sockets (active > idle).
- **Last socket closed** sets `grace_until = now + 20 s` and an alarm. If no socket returns before then, the hub announces `offline`.
- **Liveness sweep.** An alarm every 30 s, only while any socket is connected, closes any socket whose `getWebSocketAutoResponseTimestamp` is older than 60 s, or 150 s when `vis = false`. Chrome throttles timers in hidden tabs to one wake-up a minute. Closed sockets get code 4408.
- **On a cold start** after eviction, every `presence` row whose user has no socket is set to `grace_until = now + 20 s`, so a restart does not flash everyone offline.
- **Fan-out.** Transitions go to every connected eligible member. Presence is family-scoped: every eligible member sees every other member's state (CHAT-D15). There is no "last seen".

### 10.3 Surfaces (R-37)

1. **Profiles.** On `/person/?id=X`, when X is eligible, the chat island inserts `<p class="hfy-presence" data-hfy-presence="X">` (dot, state text, and a "chat" button when X is not you) after the `h1` inside `.person-heading` (`11ty/js/person-page.js:334`). It waits for the hero with a MutationObserver, because `renderHero` (`:318-343`) runs after the data loads. Non-members, such as people without an account or deceased people, get nothing.
2. **The family section.** The roster's "family" list (§15).
3. **Every chat.** A direct chat's title bar shows the peer's dot. A group's title bar shows "{n} people · {k} online", with a strip of member dots under it (expanded on hover or tap).

## 11. Typing indicators (R-40)

**Client:**
- The first keystroke with non-empty text sends `typing on`.
- While keys continue, `on` is re-sent at most every **3 s**.
- **5 s** after the last keystroke, with text still in the box, the client sends `paused`.
- Clearing the box, or a blur with an empty box, sends `off`.
- On send the client sends nothing; the hub synthesizes `off`.

**Hub:**
- Relays `typing` to the other current members' sockets. It is never stored.
- On `send`, broadcasts `off` for the sender in that conversation.
- On the user's last socket close, broadcasts `off` for every conversation in the closing sockets' `typ`.

**Receiver:**
- `on` expires after **7 s** without a refresh.
- `paused` stays until `off`, a message from that user, or a 60 s safety expiry.

**Strings** (the line under the transcript; grey; names as labels):

| typing | paused only |
|---|---|
| 1: "{name} is typing…" | 1: "{name} has entered text." |
| 2: "{a} and {b} are typing…" | 2: "{a} and {b} have entered text." |
| 3 or more: "several people are typing…" | 3 or more: "several people have entered text." |

When some people are typing and others have paused, "typing" wins. The line is not an `aria-live` region, because it would be too chatty. "has entered text" is flagged as **unverified Gmail wording** in the research (it may be MSN's); it can be cut at UAT.

## 12. Composer and content policy (R-34, R-18)

### 12.1 Composer

- **Input.** A single line that grows to 4 lines. Enter sends; Shift+Enter inserts a new line on desktop. On a coarse pointer there is a visible 44 px "send" button and `enterkeyhint="send"`.
- **Placeholder.** "type a message. press enter to send." on desktop; "type a message" on mobile. This is Gmail's fix for its missing Send button.
- **Emoji.** A blue smiley button at the right edge opens a fixed grid of 32 Unicode emoji, which inserts at the caret. Typed emoticons (`:) :-) :( :-( ;) ;-) :D :-D :P :-P :O <3 B-) :'(`, each a whitespace-bounded token) render as their emoji in the transcript. The stored text is unchanged, and the original token is in the accessible name. Any Unicode emoji from the keyboard is allowed.
- **Paste and drop.** If `clipboardData` or `dataTransfer` carries files, or HTML with no plain text, the default action is cancelled and an inline line reads "chat is text and emoji only." Rich paste inserts `text/plain` only. There is no file input anywhere.
- **Counter.** It appears at 900 of 1,000 characters.

### 12.2 Server text policy (`checkText`, kit; the same function runs in the client)

1. Must be a string, normalized to NFC.
2. Silently strip:
   - control characters except `\n` (a tab becomes a space);
   - bidi controls U+202A–U+202E and U+2066–U+2069;
   - U+200B, U+2060, U+FEFF and U+FFF9–U+FFFB.
   U+200D and U+FE0F stay, because emoji sequences need them.
3. Trim. An empty result is `EMPTY`.
4. Over 1,000 code points or 20 lines is `TOO_LONG`.
5. A `data:` URI anywhere is `MEDIA_URL`, because it is an attachment in disguise.
6. **Links stay text.** `http(s)` links are allowed as text and rendered as plain anchors (`rel="noopener noreferrer nofollow ugc"`), with **no preview, unfurl or inline media, ever**. A URL is `MEDIA_URL` when:
   - its path ends in `.gif .png .jpg .jpeg .webp .heic .heif .avif .bmp .svg .mp4 .mov .webm .m4v .mp3 .m4a .wav`; or
   - its host, or a parent domain, is in `mediaHosts`. The default list, host-configurable, is `giphy.com tenor.com gfycat.com imgur.com i.redd.it v.redd.it media.discordapp.net cdn.discordapp.com pbs.twimg.com video.twimg.com i.pinimg.com`.

   This rejects "URLs as media", which would otherwise smuggle in GIFs and photos (R-34). Other links are ordinary text (CHAT-D8).
7. **`contactGuard(text)`, host-injected.** harrisonfamily injects the **R-18 detector** from the privacy-guards domain, which must be pure ESM with no Node APIs so it runs in the Worker, the Lambda and the browser. Any hit is `CONTACT_INFO` with `spans`. The default (CHAT-D7) applies the R-18 guard to chat text **and** group names, because io's rule is universal ("universally across the app … when phone numbers or addresses are detected in submissions, the user should get an error message until they remove it").

**Group names** go through steps 1–3 and 7. They must be 60 code points or fewer with no newline; otherwise `NAME_INVALID`.

**Rendering** uses text nodes only, never HTML. The linkifier builds anchors through DOM APIs.

**When `CONTACT_INFO` comes back:**
- the message is not stored;
- the text goes back into the composer, with the first span selected (`setSelectionRange`) and `aria-invalid="true"`;
- the line reads "chat can't carry phone numbers or addresses. remove the highlighted part to send." This wording is shared with the privacy domain.

## 13. Offline delivery (web push)

The **push condition** is evaluated per recipient after a message commits:
- the recipient has **no live socket**. Presence is never used here, so a peer in the 20 s grace still gets a push. Presence is also never used to decide whether a message is stored;
- the recipient is eligible;
- `readpos.notified_seq <= readpos.read_seq`, meaning nothing has been pushed since they last read.

When all three hold, the hub enqueues a `push_outbox` row and sets `notified_seq = seq`. The result is **one push per conversation per unread run**: a burst of ten messages makes one notification. Reading the conversation re-arms it.

**Drain.**
- An alarm posts up to 50 items to `POST /api/chat/push`.
- Retries come after 1 min, 5 min and 30 min. After that the item is dropped and logged as `chat.push.dropped` (conversation id and seq only).
- Unread state is rebuilt from `readpos` on the next `welcome`, so a lost push loses nothing.

**Server push.** It goes through the existing `createNotifier().notify` (`api/src/notify.js:36-56`), with the new type **`chat_message`**:
- `TEMPLATE_REGISTRY` (`notify.js:5-15`): `{ title: "Harrison Family", level0: "you have a new chat message.", level1: "{actor} sent you a chat message." }`.
- `navigate`: `/chat/?c=<encoded conv id>`.
- No message text, ever, at any level. This matches the "notifications carry no content by default" posture in `docs/explanation/family-data-privacy.md`.
- No `app_badge`; the notifications domain owns the badge.
- The type is enabled by default, as `featurePref` defaults to enabled (`iokit packages/notify/src/server.ts:114-117`).
- **Kept in sync by hand:** the islands `CATALOG` in `islands/src/islands/notifications.jsx:13-21` gains the entry `chat_message: { group: "family", label: "someone sends me a chat message", desc: "a chat message while you're away from the site.", title, generic, detailed }`.
- Without VAPID the notifier is a no-op (`notify.js:26,37`), and the route returns `{sent: 0, disabled: true}`.

**Coming back.** On reconnect, the `welcome` summaries show unread state:
- the roster shows the person or group in bold;
- the chat entry icon shows a dot;
- nothing opens by itself. This is Gmail's "delivered at next sign-in", without the inbox.

## 14. APIs

### 14.1 Worker routes (Cloudflare, ahead of CloudFront on `<site>`)

| route | auth | response |
|---|---|---|
| `GET /chat/ws` with `Upgrade: websocket` | `io_id` cookie + Origin + UAT/kill switch | 101. Rejections are close codes (§6.5). A non-upgrade GET gets 426 `{error: "upgrade_required"}`. |
| `GET /chat/v1/health` | none | 200 `{ok: true, version: "<worker sha>", protocol: 1}`, `cache-control: no-store` |
| anything else under `/chat/v1/` | — | 404 `{error: "not_found"}`, `no-store` |

`/chat/` and `/chat/index.html` do **not** match these routes. They are served by CloudFront through `HFYAppendIndex`, like any page.

**Worker environment** (`wrangler.toml` `[vars]` plus secrets):

| name | value or default |
|---|---|
| `SITE_ORIGIN` | `https://harrisonfamily.us` |
| `SESSION_ISSUER` | `https://harrisonfamily.us/auth` |
| `SESSION_AUDIENCE` | `harrisonfamily-web` |
| `SESSION_JWKS_URL` | `https://harrisonfamily.us/auth/.well-known/jwks.json` |
| `SESSION_COOKIE` | `io_id` |
| `CHAT_ENABLED` | `"1"` or `"0"` |
| `CHAT_OPEN_TO` | `"uat"` or `"all"` |
| `CHAT_UAT_SUBJECTS` | comma-separated gramps_ids |
| `API_BASE` | `https://harrisonfamily.us/api` |
| `CHAT_SERVICE_KID` | `hfy-chat-1` |
| `CHAT_SERVICE_PRIVATE_KEY` | secret, a PKCS8 ES256 key |

### 14.2 Service token (Worker → hfy-api)

A JWT signed with ES256:
- **header:** `{alg: "ES256", kid: "hfy-chat-1", typ: "JWT"}`;
- **claims:** `{iss: "hfy-chat", aud: "hfy-api/chat", sub: "chat-hub", iat, exp <= iat + 60, jti: <ULID>}`;
- **sent as** `Authorization: Bearer <jwt>`. The `/api/*` behavior forwards every viewer header (`AllViewerExceptHostHeader`, `docs/reference/architecture.md:59`).

**Verification.** The API verifies with the public key(s) from a new app-stack parameter, `ChatServicePublicKeys`. It is a JSON array of `{kid, spki}`; it is public, so it is not a secret and adds no Secrets Manager line. Two entries allow rotation without downtime. When the parameter is empty, the routes answer 503 `unavailable`.

**Replay.** The 60 s lifetime bounds it. Every route is idempotent: directory reads, archive puts, and pushes that are rare and content-free.

### 14.3 hfy-api service routes (new; `auth: "service"`)

**Handler changes:**
- `routes.js:129` changes the forced `auth: "session"` to `auth: r.auth ?? "session"`.
- `handler.js:80` branches: `route.auth === "service" ? authenticateService(event) : authenticate(event)`.
- The service actor is `{id: "service:chat", label: "chat", admin: false, service: true}`.

**Exclusions.** No `mcp` member, no `POLICY_ROWS` row (so the routes are not MCP tools), and listed in `buildCaps` with `auth: "service"` (`routes.js:143-156`). The 415 JSON rule and `no-store` still apply.

| name | method, path | body | 2xx | errors |
|---|---|---|---|---|
| `chat.directory` | `GET /api/chat/directory` | — | 200 `{version: 1, generated_at, members: [{id, label}]}`. The ids are the unique allowlist values matching `^[A-Za-z0-9_-]{1,64}$`; labels come from `resolveLabel`. Cached in memory for 5 min. | 401 `unauthenticated` (bad, expired or wrong-`aud` token), 503 `unavailable` (allowlist unreadable: fail closed; the hub keeps its snapshot) |
| `chat.push` | `POST /api/chat/push` | `{items: [{recipient, conv, seq, actor}]}`, 1 to 50 items | 200 `{sent, skipped, disabled?}` | 400 `validation` (bad shape, a recipient or actor not id-shaped, more than 50 items), 401 |
| `chat.archive` | `POST /api/chat/archive` | `{conv: {id, kind, name, creator, policy, created_at, last_seq}, members: [{uid, epoch, join_seq, left_seq, invited_by}], msgs: [{seq, cmid, from, kind, text?, sys?, ts}]}`, at most 100 messages | 200 `{stored, through_seq}` | 400 `validation` (an id not shaped `dm:…`/`g:…`, text over 4,000 bytes, a `seq` that is not an integer), 401, 503 |

`api/src/routes.js` also documents the three routes in `docs/reference/api.md`. A new module `api/src/chat.js` holds the handlers, `authenticateService` and the key functions. `api/src/notify.js` gains `chat_message`.

## 15. UX: Gmail Chat fidelity spec

Every value below is a token in `packages/chat/src/tokens.css` (`--io-chat-*`, in rem). harrisonfamily aliases them in the theme layer, because `theme-lint` forbids literals in islands CSS (`AGENTS.md:58`). The source of each value is tagged **[S]** for sourced, **[I]** for inferred from the research and to be measured from archived screenshots in the intake, or **[DS]** for the io-approved design system, which wins conflicts.

### 15.1 Desktop, 64rem (1024 px) and wider: every page

- **Roster panel, bottom-left.** This is Gmail's 2006 placement of the chat admin area [S: TechCrunch, Feb 2006]. The design system has no sidebar (HFY-R72).
  - A title bar 2.75rem (44 px) tall [DS], showing your own dot, "chat", and minimize.
  - Expanded it is 15rem wide [I] and `min(28rem, 70vh)` tall.
  - Contents:
    1. a search field "search family" (16 px text [DS]); `q` focuses it when focus is not in an input or textarea [S: Gmail shortcut `q`];
    2. **groups**: your groups by last activity, bold when unread, a "new group" button at the top;
    3. **family**: online members first (active, then idle, alphabetical), then the people you chatted with in the last 30 days by recency, up to 40 rows in all [S: Gmail's 40-contact cap]. The search reaches every eligible member.
  - "recent" uses only your own conversations, so no ranking reveals who talks to whom.
  - The open or closed state is remembered (`hfy:chat:panel`).
- **Moles, bottom-right**, laid out right to left [S].
  - Width 16rem (256 px) [I: 225–260 px], body 20rem tall [I: 300–350 px], gap 0.5rem, right margin `--io-space-6`.
  - Title bar 2.75rem [DS] with:
    - a presence dot, then the name or group title. An unnamed group shows "{a}, {b} and {n} more";
    - an options button (person-plus icon) [S: 2012 "Add people to this chat"]: add people, rename and make private/open (creator only), leave chat;
    - minimize (clicking the title bar also toggles it) [S: 2012 help], pop-out ↗ [S], close ×.
  - **Body:** the transcript, the typing line, then the composer.
  - **Count.** As many moles show as fit: `floor((viewport − panel − margins) / (mole + gap))`, at least 1. The rest collapse into a "{n} more" chip that lists them [I]. Opening a hidden one swaps it with the least recently focused.
  - **Pop-out** opens `/chat/?c=<id>&popout=1` in a 420 × 560 window that survives navigation in the main tab. That is the Gmail answer to the multi-page site.
  - **An incoming message** for a conversation with no open mole opens one unfocused, with its title bar flashing. If the tab is hidden, `document.title` alternates "{name} says…" every 1.5 s until focus [I]. Under `prefers-reduced-motion` both become a static highlight.
- **Transcript** [S: patent US7814159, plus screenshots]:
  - **Runs.** The first line of a run is `me: {text}` for you and `{name}: {text}` for others; later lines of the run are indented with no name.
  - **"sent at" line.** A centred grey line `sent at 3:42 pm on tuesday` goes under a message when the next message, or now for the last one, is more than 5 min later. Older than 6 days, it reads `on oct 3`. The exact time of each message is in its `title` and accessible name.
  - **System rows** are grey italic: "{a} started this chat.", "{a} named the chat "{n}".", "{a} added {b}.", "{b} left.", "{a} made this chat open: anyone in it can add people.", "{a} made this chat private: only {a} can add people." A late joiner's first line is "you joined. you'll see messages from here on."
  - **Your pending message** is grey and darkens on `ack`. A failure shows "not sent. tap to retry.", except `PACE_WAIT`, `CONTACT_INFO` and `MEDIA_URL`, which put the text back into the composer (§9, §12).
  - New messages in a focused mole are announced once by a polite live region: "{name}: {text}".

### 15.2 `/chat/` page, desktop

A two-pane page: the roster in a left column and the selected conversation filling the main column, the literal "left roster". Other open moles stay docked. `?c=` selects a conversation. This is the push landing page.

### 15.3 Medium, 43rem to 64rem (688–1024 px)

The same dock. The panel is collapsed by default, and usually one mole fits.

### 15.4 Phone, under 43rem (375 px reference)

- **Entry.** A chat icon (speech bubble, a `currentColor` mask like the other shell icons) with an unread dot, in `.hfy-bar__end` before the account button (`islands/src/islands/shell.jsx:199`). It links to `/chat/`. The bottom bar keeps its 5 items (`iokit packages/shell/src/registry.ts:24`). Coordinate with the notifications domain's bell and the nav domain's gear (§26).
- **`/chat/` roster.** Full screen: search at the top, then groups, then family, with 44 px rows [DS].
- **Conversation.** Full screen, with `history.pushState` so Back returns to the roster.
  - Header: back, dot, name, ⋯ options.
  - The composer is pinned above the safe area (`--io-shell-safe-*`) with a visible "send" button.
  - `html.hfy-chat-convo` hides the shell's compact bottom bar while a conversation is open, so the keyboard and composer have room.
- **D-11 at 375 px.** 16 px inputs, 44 px targets, one control height per row, no horizontal scroll, axe clean, an installed-PWA pass.
- **No auto-opening.** An incoming message updates the entry dot and the roster only. Gmail's mobile web app had no group chat; ours does, in the same full-screen view [S, deliberately different].

### 15.5 Copy (design-system voice: lowercase sentences; names as labels)

| key | copy |
|---|---|
| placeholder (desktop / mobile) | "type a message. press enter to send." / "type a message" |
| peer offline (first message) | "{name} is offline. they'll see your message when they're back." |
| pacing | "{name} is offline. you can send another message after they reply." |
| contact info | "chat can't carry phone numbers or addresses. remove the highlighted part to send." |
| media URL | "chat is text and emoji only. links to photos, gifs or videos can't be sent." |
| paste or drop of a file | "chat is text and emoji only." |
| too long | "that's too long for chat. keep it under 1,000 characters." |
| queued | "sends when you're back online." |
| reconnecting (after 2 s) | "reconnecting…" |
| unavailable | "chat isn't available right now." |
| signed out | "sign in to chat." |
| new version | "a newer chat is ready. reload the page." |
| leave confirm | "leave this chat? you'll need an invite to come back." |
| page with the flag off | "chat isn't turned on yet." (static fallback text in `11ty/chat/index.html`) |

## 16. Kit changes: new package `@io-kit/chat` 0.1.x

The layout follows the `comments` template (`iokit packages/comments/package.json`):

```
packages/chat/
  package.json        exports ".", "./react", "./server", "./cloudflare", "./testing", "./chat.css", "./tokens.css"
                      peer: react >=18.3 <20 (optional). Runtime deps: none. Dev: @cloudflare/workers-types, jsdom, @testing-library/*
  src/index.ts        protocol v1 types + decodeClientFrame/decodeServerFrame (hand validators), ERROR_CODES, CLOSE_CODES,
                      checkText/checkGroupName (+ ContactGuard hook, mediaHosts option), EMOTICONS, timeMarks() (sent-at rule),
                      typingLine(), TIMINGS {idleMs: 900000, graceMs: 20000, pingMs: 25000, typingRefreshMs: 3000, typingPausedMs: 5000, typingExpireMs: 7000}
  src/client.ts       ChatClient: transport-agnostic engine (hello/resume, outbox, dedupe, gap fill, backoff, visibility,
                      make-before-break at exp, idle, typing emitter, pacing pre-check, 30-day prune, snapshot via host storage)
  src/transport.ts    ChatTransport { open(onFrame, onClose) → { send, close } } + websocketTransport(url)
  src/server/core.ts  ChatCore: handle(uid, frame, now) → Effect[] (append, fan-out, typing relay, presence, push enqueue, errors); pacing; epochs; rate limits
  src/server/store.ts ChatStore interface, MemoryStore, SqlStore (DDL §7.1; works on ctx.storage.sql and on node:sqlite through a shim)
  src/cloudflare/     ChatHubObject (hibernation API: acceptWebSocket + tags, serializeAttachment, setWebSocketAutoResponse,
                      getWebSocketAutoResponseTimestamp, alarms for grace/sweep/outboxes), createChatWorker(config),
                      verifySessionCookie (WebCrypto RS256 + JWKS cache, gate-parity checks), signServiceToken (ES256)
  src/react.tsx       PresenceDot, ConversationView, Composer, EmojiPicker, TypingLine, Roster, RosterPanel, MoleDock, Mole,
                      ChatPage (two-pane / full-screen), NewChatPicker, GroupOptions, ChatEntryButton, useChat, ChatProvider
  src/chat.css, src/tokens.css   tokens only; token lint as in comments (HFY-R30 px exceptions: 16px input, 44px control)
  testing/            memoryTransport, loopbackServer(ChatCore+MemoryStore), conformance suite CH-01…CH-30, fakeClock,
                      load/ (node client on the global WebSocket, scenarios, histogram), testKeys (RSA JWKS + ES256 for staging)
  docs/               explanation/chat-architecture.md (+ the L-09 dated amendment note in docs/explanation/realtime-and-feeds.md)
```

**Registration in the kit:**
- root `vitest.config.ts` aliases (as at `:10-12`);
- `tsconfig.json` paths (`:9`);
- `scripts/docs/lib.mjs` `AREAS` (`:6`) gains `"chat"`;
- a changeset with `doc_impact` in each PR (HFY-R7: one package per PR);
- no workflow changes.

**Runtime rules:**
- `src/index.ts`, `src/server/*` and `src/cloudflare/*` import no `node:` modules, because they run in Workers.
- The Cloudflare adapter is tested in plain vitest against a fake `DurableObjectState`, so the kit needs no Workers test pool.
- The real runtime is verified in harrisonfamily with `wrangler dev` and on staging.

**No other kit package changes:**
- `@io-kit/notify` is used unchanged, server-side, in hfy-api.
- `@io-kit/shell` needs nothing; the bottom-bar hide is HFY CSS.
- Backoff constants are copied from `@io-kit/feed` (cited) rather than imported.

## 17. harrisonfamily changes (by task)

| area | files |
|---|---|
| Worker (new) | `chat-worker/wrangler.toml` (Durable Object binding `CHAT_HUB` → class `ChatHub`; migration `v1` `new_sqlite_classes`; routes `harrisonfamily.us/chat/ws*` and `harrisonfamily.us/chat/v1/*`; `[env.staging]` on `workers.dev` with its own Durable Object namespace and a test JWKS), `chat-worker/src/index.mjs` (about 30 lines wiring `createChatWorker` and `ChatHubObject` with the HFY `contactGuard`), `chat-worker/package.json` + lockfile (exact pins of `@io-kit/chat` and `wrangler`), **`chat-worker/dist/`** (the built bundle, committed output like the islands, HFY-R58; `npm run build` = `wrangler deploy --dry-run --outdir dist`, plus `dist/deploy.json` holding the bindings, migrations, compatibility date and routes taken from `wrangler.toml`), `chat-worker/test/smoke.mjs`, `scripts/infra/create-chat-service-key.sh` (ES256 pair: the private half to the Worker secret, the public half printed for `ChatServicePublicKeys`) |
| CI | `ci.manifest.yaml` gains a `cloudflare-worker` target (`dir: chat-worker`, `environment: production`). The workflows are **re-rendered** with `io-kit-ci render`, never hand-edited (`AGENTS.md:41`, HFY-R14). New GitHub Actions secret `CLOUDFLARE_API_TOKEN`; account and zone ids as non-secret repository variables. |
| API | `api/src/chat.js` (new), `api/src/routes.js` (3 routes, `auth` passthrough), `api/src/handler.js:80` (service branch), `api/src/notify.js` (`chat_message`), `api/src/keys.js` (chat keys), `api/src/index.js` (env), tests `api/test/chat.test.js`, `scripts/gen-caps.mjs` output |
| Stack | `app-stack.yaml`: parameter `ChatServicePublicKeys` (default `""`) → env `CHAT_SERVICE_PUBLIC_KEYS`. Nothing else, because the role already has `BatchWriteItem` and `config/*` read. |
| Islands | `islands/src/islands/chat.jsx` + `chat.css` (aliases), `islands/package.json` (pin `@io-kit/chat`), `islands/tests/bundle.test.mjs:18` (add `chat.js`, `chat.css`), `islands/tests/chat.spec.mjs` (new) |
| Pages | `11ty/chat/index.html` (repo-owned, static fallback text), `islands/heads.mjs` `PAGES` (`:21`), `islands/copy.mjs` `COPY_EXTRA` (`:118`), `11ty/README.md` repo-owned list (machine-checked, `AGENTS.md:57`), mirrored to the Eleventy source per HFY-R46 |
| Loader | `11ty/js/feature-flags.js`: export `refreshSession` (`:518`); in the shell's `onLoad` (`:782-792`), `if (flags.chatV1 === true) loadIsland("chat")` when signed in; `/chat/` always requests it when the flag is on |
| Shell | `shell.jsx`: an empty `<span id="hfy-chat-entry" data-hfy-chat-entry/>` in `.hfy-bar__end` when `chatV1` (`useFlag`, `:96-100`); the sign-out sweep of `hfy:chat:` (`:125`); `shell.css` rule `html.hfy-chat-convo` hiding the compact bottom bar |
| Person page | none in `person-page.js`: the chat island injects into `.person-heading` (`:334`) |
| Service worker | `11ty/sw.js`: `/chat/v1/` network-only (WebSockets are never intercepted) |
| Flags | `11ty/_data/flags.json` gains `"chatV1": false` (and the Eleventy source copy) |
| Docs | `docs/reference/architecture.md` (request routing: a Worker route row ahead of the behaviors table `:56-70`), `docs/explanation/edge-and-origin-design.md` (the Worker-route exception and why), `docs/explanation/family-data-privacy.md` (a "chat" section: Cloudflare as a processor, 30-day view, indefinite retention, content-free push), `docs/reference/cost-estimate.md` (the Workers line), `docs/how-to/deploy-the-chat-worker.md`, `docs/how-to/rotate-the-chat-service-key.md`, `docs/how-to/toggle-a-feature-flag.md` (`chatV1`, `CHAT_OPEN_TO`, `CHAT_ENABLED`), `docs/drafts/privacy-terms-2026-10-update.md` (a chat clause for io) |

### 17.1 Worker deploy pipeline (CI with a scoped token)

**Where the code lives.** The wrangler config and the Worker entry live in the harrisonfamily repo (`chat-worker/`). The kit ships only the reference Durable Object and Worker code (`@io-kit/chat/cloudflare`). This follows Q-3: infrastructure per stack, convergence at the code contract.

**Why the bundle is committed.** CI cannot build the Worker:
- the bundle includes `@io-kit/chat` from CodeArtifact, and harrisonfamily CI has no CodeArtifact read (HFY-R62);
- consumers install no npm packages at CI time (HFY-R14).

So the bundle is built locally and committed, exactly like the islands output (HFY-R58). The orchestrator runs `cd chat-worker && npm ci && npm run build` with a CodeArtifact token. `npm run check` rebuilds in memory and fails when `dist/` is stale. That check is an AC of every PR that touches `chat-worker/`.

**The CI target.** A new `@io-kit/ci` target type, `cloudflare-worker`. Kit task `ci-kit-cloudflare-worker-target`; a kit gap found by an adopter goes to the kit (HFY-R28). Its rendered composite action has no npm dependency, the same posture as HFY-R56. In order, it:
1. Reads `dist/deploy.json` and uploads `dist/` with the bindings, the Durable Object `migrations` (tag `v1`, `new_sqlite_classes: ["ChatHub"]`), the compatibility date and the vars. This uses the Cloudflare Workers script upload API with `curl` and `CLOUDFLARE_API_TOKEN`.
2. Puts each route in `deploy.json` on the zone (`zones/<zone>/workers/routes`). This is idempotent.
3. Runs a smoke check. `GET https://<site>/chat/v1/health` must report `version` equal to the commit sha. A signed-out `GET /person/index.json` must still return 401, and `GET /` must return 200, proving that only the chat paths moved.
4. On a failed smoke check, rolls back to the previous Worker deployment through the deployments API. Durable Object data is never touched; migrations are append-only.

**Fallback.** If the spike finds that the upload API does not apply the `v1` migration, the action instead runs a pinned `wrangler deploy --no-bundle` from a vendored tarball whose checksum is verified. This stays off the CodeArtifact path.

**Environment.** The job runs in the existing production environment of the rendered workflows, so io's production approval per release (D-13) gates it.

**The token** (`CLOUDFLARE_API_TOKEN`, a GitHub Actions secret):
- **Scope:**
  - Account › Workers Scripts: Edit, which covers Durable Object classes and migrations;
  - Zone `harrisonfamily.us` › Workers Routes: Edit;
  - nothing else. No DNS, cache, WAF or other zones.
- **Lifetime:** a TTL of 1 year.
- **Who creates it:** io, or the orchestrator with io's go-ahead using the existing local Cloudflare API auth. It is stored with `gh secret set` (a secret write, an io go-ahead operation). It is never printed, logged, committed or put in a URL.
- **Rotation:** `docs/how-to/rotate-the-cloudflare-deploy-token.md`.
- **The ids:** the account id and zone id are repository variables and `ci.manifest.yaml` values. `AGENTS.md:75`'s list of where ids may appear gains the Cloudflare ids, with the same rule as the distribution id.

**Worker secrets.** `CHAT_SERVICE_PRIVATE_KEY` is set once with `wrangler secret put`, by the orchestrator with io's go-ahead, outside CI. CI never needs it: uploads keep existing secrets (`keep_secrets`/inherit bindings).

**Staging.** `wrangler deploy --env staging` is run locally by the orchestrator for the load tests. Staging uses its own Durable Object namespace and test keys, never production data.

## 18. Flags and dark launch

| control | where | values | purpose |
|---|---|---|---|
| `chatV1` | `11ty/_data/flags.json` and the Eleventy source | default `false` (HFY-R8) | loads the chat island (dock, entry icon, profile presence) and the `/chat/` island |
| `?hfy_flags=chatV1` | runtime override (HFY-R42, session-scoped with a banner, HFY-R58) | — | io's UAT on production before the flip |
| `CHAT_OPEN_TO` | Worker var | `uat` (default) or `all` | the server-side gate: only `CHAT_UAT_SUBJECTS` can connect, appear in `people` or receive pushes |
| `CHAT_ENABLED` | Worker var | `"1"` or `"0"` | kill switch: every upgrade closes 4503; the island shows "chat isn't available right now." and hides presence |
| route removal | the Cloudflare API with the deploy token, or the dashboard | — | last resort: `/chat/ws` falls through to CloudFront and 404s, and the client backs off |

`CHAT_OPEN_TO` and `CHAT_ENABLED` are vars in `wrangler.toml`. Changing one is a committed change deployed by the CI target. An emergency `CHAT_ENABLED=0` may be applied by the orchestrator with the deploy token and recorded afterwards.

The client flag alone is not a security boundary. `CHAT_OPEN_TO` is.

## 19. Testing

### 19.1 Kit conformance suite (CH-xx; runs on MemoryStore and on SqlStore via `node:sqlite`)

| id | case |
|---|---|
| CH-01 | `seq` is gap-free and strictly increasing per conversation under 1,000 interleaved sends from 5 users |
| CH-02 | A repeated `cmid` (send, invite, leave, rename, policy, create) returns the original result; there is exactly one row |
| CH-03 | `ack` follows the commit; a store failure gives `SERVER_ERROR` and no `msg` fan-out |
| CH-04 | Pacing matrix: {peer active, idle, in grace, offline} × {last `msg` by sender, by peer, none} × {DM, group}. Only "offline × by sender × DM" is `PACE_WAIT`. |
| CH-05 | Pacing ignores system rows; a retry of an accepted send is not paced |
| CH-06 | Two "tabs" of one sender send at the same instant while the peer is offline: exactly one is accepted |
| CH-07 | The peer's last socket closes, then a send at +19 s is allowed (grace) and a second send at +21 s is `PACE_WAIT` |
| CH-08 | A late joiner sees rows from `join_seq` only; resume and `page {before}` never cross `join_seq` |
| CH-09 | Leave closes the epoch; nothing after `left_seq` is visible; `conv {removed}` is sent; leaving a DM is `NOT_ALLOWED` |
| CH-10 | Re-invite opens epoch 2: the union of epochs is visible and the gap is not |
| CH-11 | Private group: a non-creator invite is `NOT_ALLOWED`. Open group: a member invite succeeds. A non-member invite is `NOT_MEMBER`. |
| CH-12 | Rename and policy are creator-only; after the creator leaves, a private group is invite-locked |
| CH-13 | `GROUP_FULL` at 51; `UNKNOWN_USER` for an ineligible or self id |
| CH-14 | 30-day window: a row at `now − 30 d − 1 ms` is never returned by any path; nothing is deleted |
| CH-15 | Text policy table: empty, too long, too many lines, controls stripped, bidi stripped, ZWJ emoji kept, `data:` URI, every media extension and host, a plain link accepted, `CONTACT_INFO` spans passed through |
| CH-16 | Group name policy |
| CH-17 | Typing is relayed to other members only, never stored; the hub sends `off` on send and on the last socket close |
| CH-18 | Presence: active/idle aggregation over sockets; offline exactly at grace expiry; no flap on a close and reopen within 20 s; cold start sets grace |
| CH-19 | Liveness sweep: a 60 s visible / 150 s hidden ping silence closes 4408 |
| CH-20 | Push: one push per unread run per recipient; none while the recipient has a live socket; re-armed by `read`; never for ineligible users |
| CH-21 | `read` updates `read_seq` monotonically and is echoed to the same user's other sockets only |
| CH-22 | Rate limits: send, typing, create, invite, page; 4429 on a sustained flood |
| CH-23 | Socket cap: the 11th socket closes the oldest with 4010 |
| CH-24 | Session expiry: `reauth` at exp − 120 s, 4401 at exp + 60 s |
| CH-25 | Bad frames: unknown `t`, wrong types, over 8 KiB → `err BAD_FRAME` or 1009; three in a row → 4400 |
| CH-26 | Welcome: `people` only from the eligible set; `presence` omits offline users; summaries carry `readSeq` and `lastMsgFrom` |
| CH-27 | Directory: a stale snapshot is used while a refresh fails; no snapshot and a failed fetch → 4503 |
| CH-28 | Archive: rows past the cursor are sent once, in order; the cursor advances only on 2xx |
| CH-29 | UAT: with `open_to=uat`, a non-UAT uid closes 4403 and is absent from `people` and push |
| CH-30 | `visible()` uses the epoch join and the 30-day bound (an SQL plan check on SqlStore) |

### 19.2 Kit client tests (vitest, client against `loopbackServer`)

- **Chaos.** 10 % of frames dropped, duplicates injected, acks reordered, sockets killed in the middle of a send, the client clock skewed ±10 min. Assert zero loss and zero duplicates on every client, and monotonic rendering.
- **Resume, gap fill and the `more` paging.**
- **Make-before-break at `exp`:** no visible gap and no duplicate.
- **Outbox:** one queued message per conversation while disconnected.
- **Typing emitter timings** with a fake clock (3, 5 and 7 s).
- **Idle at 15 min.**
- **Mobile close-on-hidden.**

### 19.3 Kit UI tests (vitest + Testing Library + axe)

- **Composer:** Enter versus Shift+Enter, paste and drop blocks, the counter, error lines with span selection, the pacing-disabled state.
- **Transcript rendering:** runs, the `me:` prefix, "sent at" lines from fixtures, system rows, pending and failed states, emoticon rendering, the linkifier (no previews; `javascript:` is not a link).
- **Typing line strings** for 1, 2 and 3+ people, typing and paused.
- **Presence dot** accessible names.
- **Roster** ordering and the `q` shortcut.
- **Mole dock** fitting and overflow, with a mocked viewport width.
- **Token lint.**

### 19.4 harrisonfamily

- **`api`:** `node --test api/test/chat.test.js` covers:
  - service tokens: bad signature, wrong `aud`, `exp` over 60 s, an unknown `kid`, two-key rotation;
  - the directory never contains `@` and holds only ID-shaped values;
  - archive puts repeated with no change in effect;
  - push is a no-op without VAPID;
  - service routes refuse a session cookie, and session routes refuse a service token;
  - caps snapshot updated.
- **`chat-worker`:** `wrangler dev` smoke script (`chat-worker/test/smoke.mjs`):
  - a health 200;
  - a non-upgrade 426;
  - upgrade with no cookie → 4401;
  - a wrong `Origin` → 4403;
  - a test-key cookie against the staging JWKS → `welcome`.
- **`islands/tests/chat.spec.mjs` (Playwright 1.64, `page.routeWebSocket('/chat/ws')` bridged to the kit `loopbackServer`):**
  - flag off: no `chat.js` request and no socket;
  - flag override on: entry icon, roster, mole send/ack, profile presence dot;
  - pacing UI;
  - `CONTACT_INFO` inline error;
  - paste block;
  - 375 px: `/chat/` roster and conversation, no horizontal scroll, 16 px inputs, 44 px targets, bottom bar hidden in a conversation;
  - axe clean;
  - `npm run check:islands` passes.
- **Existing specs updated:** `shell.spec.mjs` (the entry slot only with the flag), `bundle.test.mjs`, `theme-delivery.test.mjs` (the new page in `PAGES`).

## 20. Hardening: load, latency and failure modes

### 20.1 Service-level objectives (measured in `hfy-chat-load-latency`, enforced at UAT)

| metric | target |
|---|---|
| send → `ack`, warm, same continent | p50 ≤ 100 ms, p99 ≤ 300 ms |
| send → peer render (server `ts` → render, with the clock offset from `welcome.serverTs`) | p50 ≤ 150 ms, p99 ≤ 500 ms |
| connect → `welcome` (page load) | p50 ≤ 250 ms, p95 ≤ 600 ms |
| reconnect + resume complete after a forced close | p95 ≤ 1.5 s |
| presence: online propagation / offline announce | ≤ 2 s / grace + ≤ 5 s |
| typing `on` → rendered | p95 ≤ 300 ms |
| loss, duplicates, `seq` regressions under chaos | 0 |
| hub handler time | p99 ≤ 20 ms (the split trigger is 50 ms) |

### 20.2 Latency budget per hop (design targets, to be measured)

| hop | budget |
|---|---|
| device → Cloudflare edge, warm socket | 20–40 ms |
| Worker → hub, which may be in another region | 5–40 ms |
| SQLite write, `seq`, output gate | < 5 ms |
| hub → peer socket (edge) | 10–40 ms |
| edge → peer device + render | 20–50 ms |

One hub removes the research's object-to-object hop. A wake from hibernation adds the object's warm-up time, which is to be measured in the spike.

### 20.3 Load scenarios (kit harness, against the **staging** Worker on `workers.dev`, which has its own Durable Object namespace and a test JWKS, never production data or keys)

| id | scenario | pass |
|---|---|---|
| L1 | steady: 300 clients, 20 groups of 30, 100 DMs, 50 msgs/user/day compressed to 2 msg/s for 30 min, with typing | the SLOs in §20.1 |
| L2 | burst: 60 users sending 1 msg/s for 5 min, with 5 people typing at once in one group | p99 render ≤ 500 ms, no `RATE_LIMITED` for well-behaved clients |
| L3 | reconnect storm: kill all 300 sockets at once (a deploy) | all resumed within 30 s, zero loss, hub CPU recovers within 60 s |
| L4 | chaos: 10 % drops, duplicates, reorders, ±10 min skew | zero loss and zero duplicates |
| L5 | soak: 72 h of synthetic chatter (24 h minimum if the budget forces it) | no memory growth, reconnect rate < 1/client/h without a forced cause, alarms healthy, archive lag < 15 min |
| L6 | multi-page navigation: 50 clients each loading a page every 20 s for 30 min | no presence flap; connect → `welcome` within SLO |

### 20.4 Real devices (UAT)

At least three iOS versions (one ≥ 18.4), as an installed PWA and in Safari, plus one Android device and two desktop browsers:
- background for 30 s, 5 min and 1 h, then resume;
- airplane mode on and off;
- a Wi-Fi to LTE handoff;
- a locked phone getting a push, then a correct catch-up on open;
- the pacing matrix with two real phones;
- send → `ack` RTT read from a debug overlay (`?hfy_chat_debug=1`, client-only, no telemetry endpoint).

### 20.5 Failure modes (behavior by design)

| failure | effect | handling |
|---|---|---|
| Worker or Durable Object code deploy | every socket drops at once | Deploy in quiet hours. Clients back off with jitter and resume. Presence grace on cold start avoids an offline flash. |
| Hub evicted while hibernating | none visible | State is in SQLite and attachments. |
| Hub crash in the middle of a handler | that frame is lost before commit | The client sees no `ack` and resends the same `cmid` on reconnect; deduplication makes it exactly-once. |
| JWKS unreachable | new upgrades | Use the cached keys (TTL 300 s, refetch at most every 30 s, as the gate does). With no keys, close 4503 (fail closed). |
| Directory unreachable | new eligibles not seen | Use the snapshot; with no snapshot, close 4503. |
| hfy-api down | pushes and archive delayed | Outbox and cursor retries; chat itself is unaffected. |
| Cloudflare outage | the whole site is down already (Cloudflare proxies everything) | No new single point beyond today's. |
| iOS suspends the PWA without a close | the peer stays "online" until the sweep | The mobile client closes on `hidden`; otherwise the 60/150 s sweep catches it. |
| Session refresh fails | chat stops on that page | "sign in to chat."; the rest of the page behaves as the site does today. |
| Clock skew | none | Only server `ts` is used; the client offset comes from `welcome`. |
| SQLite growth | slow | Log `chat.storage.bytes` daily; warn at 1 GB, below the 10 GB object limit. |
| Bad frame or a buggy client loop | load | Rate limits; close 4429/4400; Workers Paid keeps a loop from becoming a hard daily-limit outage (CHAT-D2). |

## 21. Rollout and rollback

1. **Intake and spike.** No standing production change; the spike route is removed afterwards. The transport is decided. io decides CHAT-D5.
2. **Kit.** `@io-kit/chat` publishes in order: protocol → core → client → Cloudflare adapter → UI → load harness. Each is a PR with a changeset. `@io-kit/ci` gains the `cloudflare-worker` target.
3. **API service routes** deploy through an app-stack change set (io go-ahead). They are dormant: without `ChatServicePublicKeys` they answer 503; with it, only the Worker can call them.
4. **Worker deploy.** The first deploy is `hfy-chat-worker`, run by the orchestrator with a local wrangler and io's go-ahead; it creates the Durable Object class and the route. From `hfy-chat-worker-ci` on, every deploy goes through the CI target with the scoped token. It starts with `CHAT_OPEN_TO=uat` and `CHAT_UAT_SUBJECTS` set to io and the testers. Evidence:
   - `GET /chat/v1/health` returns 200;
   - signed-out `/person/index.json` is still 401 and `/` is still 200 (CloudFront paths unaffected).
5. **Island, shell and profile presence** ship with `chatV1: false`. No member loads any chat code.
6. **Load and latency** on staging (§20.3).
7. **UAT.** io and the testers use `?hfy_flags=chatV1` on production with real phones (§20.4), plus the D-11 per-surface audit (dock, `/chat/` desktop, `/chat/` 375 px, profile presence). io approves.
8. **Flip.** `chatV1: true` in `flags.json` and the Eleventy source, and `CHAT_OPEN_TO=all`, in the same window.

**Rollback**, in this order:
1. `chatV1: false`. New page loads stop; open sockets end at the next navigation.
2. If needed, `CHAT_OPEN_TO=uat` or `CHAT_ENABLED=0` (a Worker redeploy, which drops sockets).
3. As a last resort, remove the route.

Data is never rolled back: the hub and the archive keep everything. A rollback never touches the data gate, `authV2` or `HFYAppendIndex` (`AGENTS.md:42-44`).

## 22. Error-handling catalog

| code | layer | cause | client behavior | server behavior and log |
|---|---|---|---|---|
| `PACE_WAIT` | hub | DM, peer offline, last `msg` by the sender | remove pending; text back to the composer; pacing line; composer disabled until the peer is online or replies | nothing stored; `chat.pace` (conv, no text) |
| `CONTACT_INFO` | client + hub | the R-18 detector matched (text or group name) | text back; select the first span; error line | nothing stored; `chat.policy.contact` (conv, counts only) |
| `MEDIA_URL` | client + hub | `data:` URI, media extension or media host | text back; error line | nothing stored |
| `TOO_LONG` | client + hub | over 1,000 code points or 20 lines | counter, error line | nothing stored |
| `EMPTY` | client + hub | blank after normalization | Enter does nothing | — |
| `NAME_INVALID` | hub | group name too long, newline, empty after stripping | inline under the name field | — |
| `NOT_MEMBER` | hub | the actor has no open epoch (send, invite, leave, page) | remove the conversation from view; refetch summaries | `chat.denied` |
| `NOT_ALLOWED` | hub | private invite by a non-creator; rename or policy by a non-creator; leaving a DM | the option is hidden in the UI; a raced call shows "only the person who started this chat can do that." | — |
| `UNKNOWN_USER` | hub | an invitee or DM peer that is not eligible, or yourself | "that person can't use chat yet." | — |
| `UNKNOWN_CONV` | hub | malformed or unknown conversation id (non-DM) | drop the local conversation | — |
| `ALREADY_MEMBER` | hub | invitee is already in | ignored per id | — |
| `GROUP_FULL` | hub | more than 50 members | "a group can have up to 50 people." | — |
| `RATE_LIMITED` | hub | §6.7 limits | retry after `retry_ms`; for `send`, keep pending | `chat.ratelimit` (uid) |
| `BAD_FRAME` | hub | schema violation | log locally; three in a row → 4400 | `chat.badframe` |
| `SERVER_ERROR` | hub | store exception | keep pending, retry the same `cmid` after reconnect | `chat.error` (stack, no text) |
| close 4401 / 4403 / 4409 / 4429 / 4503 / 4408 / 4010 | Worker or hub | §6.5 | §6.5 | `chat.close` (code, uid) |
| HTTP 401 `unauthenticated` | hfy-api service routes | bad service token | the hub retries with a fresh token once, then backs off | `chat.service.auth` |
| HTTP 503 `unavailable` | hfy-api | key parameter empty, allowlist unreadable | hub: keep the snapshot or outbox, retry | logged by the API (`errorResponse`, `api/src/http.js:24-32`) |
| HTTP 400 `validation` | hfy-api | malformed push or archive batch | the hub drops that batch and logs it (a bug) | `chat.archive.rejected` |

Logs never carry message text, group names or labels: ids, sequence numbers, codes and sizes only.

## 23. Cost

io's account already pays for Workers Paid (verified 2026-10-13), and it already runs 4 Workers. Chat adds no subscription. It only uses the included quotas the account shares.

| line | marginal cost |
|---|---|
| Cloudflare Workers + Durable Objects | About $0. Family use is about 7k hub requests a day: sends, typing, presence, hellos and alarms. Incoming WebSocket messages bill at 20:1, and auto-answered pings are free. That is about 0.2M requests a month against the 1M included, and duration is far below the 400k GB-s included, since hibernating sockets are not billed. Overage above the shared quotas would be $0.15 per million requests. |
| hfy-api service calls | Under 10k requests a month through CloudFront and Lambda: cents. |
| DynamoDB archive | About 25k WRU and well under 0.1 GB a month: under $0.05. |
| Web Push | Existing path, negligible. |
| **Delta** | **About $0.05 a month.** `cost-estimate.md` gains a Cloudflare line that names the existing $5 subscription as an account cost shared with other Workers, not as a harrisonfamily line. |

The Workers Paid limits also remove the Free plan's hard daily request cap. That cap would have turned a runaway client loop into a chat outage.

## 24. Decisions

| id | question | default | needs io |
|---|---|---|---|
| CHAT-D1 | Transport for `@io-kit/chat` on harrisonfamily | **DECIDED by io 2026-10-13 ("chat on cloudflare"):** Cloudflare Workers + Durable Objects with WebSocket Hibernation, behind a same-host Worker route `/chat/ws*`, `/chat/v1/*`. It brings the L-09 dated amendment and the D-10 and one-distribution exception. The contingency is API Gateway WebSocket behind CloudFront. | no (decided) |
| CHAT-D2 | Cloudflare plan | **Resolved:** the account's existing Workers Paid subscription; no billing gate. The zone stays on its Free Website plan. | no (resolved) |
| CHAT-D3 | Object topology | One `ChatHub` Durable Object per stack. The research's per-conversation, per-user and presence objects are the scale-out path, with triggers in §5.3. | no |
| CHAT-D4 | Payloads on the socket versus L-09 signals-only | Payloads, scoped to `@io-kit/chat` only. Dated note in `realtime-and-feeds.md` plus a BRD inference-register line. Rides on D1. | no |
| CHAT-D5 | What "online" means for R-39 and R-37 | At least one live socket (idle counts) or within 20 s of the last close. Mobile closes its socket when hidden, so a locked phone is offline in about 20 s and pacing applies to most phone-to-phone DMs. Desktop goes idle after 15 min without input. | **yes** (it defines how io's pacing rule feels) |
| CHAT-D6 | Presence states offered | Green (online), orange with a clock (idle, automatic at 15 min), grey (offline). Busy, custom status and the mobile icon are optional and off; invisible is never offered. | no |
| CHAT-D7 | Contact-info scanning in chat | The R-18 guard applies to chat text and group names, server-enforced, with client pre-check and highlighting | no (io: "universally across the app") |
| CHAT-D8 | Links and media URLs | Links allowed as plain text with no previews ever. `data:` URIs and media URLs (extensions, GIF and image hosts) are rejected as `MEDIA_URL`. | no |
| CHAT-D9 | Retention | Visible 30 days, server-enforced on every read path. Stored indefinitely in hub SQLite plus a DynamoDB `CHAT#` archive (no `ttl`). Access past 30 days is an operator export under io's go-ahead only. | no |
| CHAT-D10 | Group mechanics | The creator names and renames, and sets and changes private/open. Invites add at once (no accept step). Cap of 50. DMs are fixed pairs and cannot be left. "add people" from a DM creates a new group. A private group whose creator has left is invite-locked. | no |
| CHAT-D11 | What a re-invited member sees | The union of their membership epochs (what was said while they were in), never the gap | no |
| CHAT-D12 | Offline delivery | Push type `chat_message`: content-free by default, at most the actor's label at level 1, never message text. One push per conversation per unread run, only when the recipient has no live socket. No app badge. | no |
| CHAT-D13 | Desktop and mobile layout | Desktop: roster panel bottom-left (Gmail 2006 position; the design system has no sidebar), moles bottom-right, `/chat/` two-pane. Phone: a top-bar entry icon and full-screen `/chat/`. | no (the D-11 design approval covers the look) |
| CHAT-D14 | Fidelity extras | Default on: moles, pop-out, Enter sends, `me:` runs, the sparse "sent at" line, the typing strings, emoticon rendering, the title flash, `q`. Optional and off: sounds, busy, status text, block, history search. Never: invisible, off the record, receipts, last seen. | no |
| CHAT-D15 | Roster contents and visibility | Groups, then family (online first, then your own recent contacts, 40 rows). Search reaches every eligible member. Every eligible member sees every other member's presence. | no |
| CHAT-D16 | Who can chat | Allowlisted principals, through `GET /api/chat/directory` (labels never emails), narrowed to `CHAT_UAT_SUBJECTS` until the flip | no |
| CHAT-D17 | Package boundary | The kit ships a runtime-neutral core, the client, the UI, the Cloudflare adapter and the testing tools. harrisonfamily owns the Worker deployment, keys, routes and data (Q-3). | no |
| CHAT-D18 | Deploying the Worker | **By CI** through a new `@io-kit/ci` `cloudflare-worker` target. It runs in the production environment with io's approval per release (D-13), uses a committed bundle (no CodeArtifact or npm at CI time), and calls the Cloudflare API with the scoped secret `CLOUDFLARE_API_TOKEN` (Workers Scripts: Edit on the account, Workers Routes: Edit on this zone only). The first deploy and the Worker secret are run by the orchestrator with wrangler. Staging is local wrangler. | no (creating and storing the token is an io go-ahead operation, gate G-cf-token) |
| CHAT-D19 | Session expiry on long-lived sockets | Server `reauth` at exp − 120 s, close 4401 at exp + 60 s. The client refreshes and makes the new socket before breaking the old. No ticket endpoint. | no |
| CHAT-D20 | Message limits | 1,000 code points, 20 lines, text and Unicode emoji only, invisible and bidi characters stripped | no |

## 25. Tasks

Arcs follow the computed task brief: harrisonfamily tasks are `github_pr_deploy`, io-kit tasks `code_only`, and research and ops tasks `no_code`. Note that HFY-R15 ran io-kit tasks as `github_pr_deploy` on comp-io-kit in PLN-001; the orchestrator reconciles that.

Each kit task is one package PR with a changeset (HFY-R7). Each harrisonfamily task is one PR.

| key | wave | repo / arc | reqs | depends on | size |
|---|---|---|---|---|---|
| chat-research-intake | W0 | none / no_code | R-33, R-41 (all) | — (DOC-926937A24A07 has arrived) | 1 d |
| chat-cf-spike | W0 | none / no_code | R-41, R-37 | — (io go-ahead for a temporary production-zone route) | 1 d |
| chat-kit-protocol | W1 | io-kit / code_only | R-33, R-34, R-40 | — | 2 d |
| chat-kit-server-core | W1 | io-kit / code_only | R-35, R-36, R-37, R-38, R-39, R-40 | chat-kit-protocol | 3 d |
| chat-kit-client | W1 | io-kit / code_only | R-39, R-40, R-41 | chat-kit-protocol | 3 d |
| chat-kit-cloudflare | W2 | io-kit / code_only | R-37, R-39, R-41 | chat-kit-server-core | 2–3 d |
| ci-kit-cloudflare-worker-target | W2 | io-kit (`@io-kit/ci`) / code_only | R-41 | chat-cf-spike (upload-API migration finding) | 2 d |
| chat-kit-react-conversation | W2 | io-kit / code_only | R-33, R-34, R-37, R-40 | chat-kit-client, chat-research-intake (fidelity sheet) | 3 d |
| chat-kit-react-shell | W3 | io-kit / code_only | R-33, R-36, R-37, R-38 | chat-kit-react-conversation | 3 d |
| chat-kit-load-harness | W2 | io-kit / code_only | R-41 | chat-kit-client, chat-kit-server-core | 1–2 d |
| hfy-chat-api-service-routes | W2 | harrisonfamily / github_pr_deploy | R-35, R-36, R-37 | — (the transport is decided) | 2 d |
| hfy-chat-worker | W3 | harrisonfamily / github_pr_deploy | R-35, R-37, R-39, R-41 | chat-kit-cloudflare, hfy-chat-api-service-routes, chat-cf-spike, privacy-domain R-18 detector module | 2–3 d |
| hfy-chat-worker-ci | W3 | harrisonfamily / github_pr_deploy | R-41 | hfy-chat-worker, ci-kit-cloudflare-worker-target, io gate G-cf-token (token creation + `gh secret set`) | 1 d |
| hfy-chat-island | W4 | harrisonfamily / github_pr_deploy | R-33, R-34, R-36, R-38, R-40 | chat-kit-react-shell, hfy-chat-worker | 3 d |
| hfy-chat-shell-presence | W4 | harrisonfamily / github_pr_deploy | R-37 | hfy-chat-island | 1–2 d |
| hfy-chat-load-latency | W4 | none / no_code | R-41 | hfy-chat-worker (staging env), chat-kit-load-harness | 2 d + soak |
| hfy-chat-uat | W5 | none / no_code | R-33…R-41 | hfy-chat-island, hfy-chat-shell-presence, hfy-chat-load-latency | 1–2 d |
| hfy-chat-flip | W5 | harrisonfamily / github_pr_deploy | R-33…R-41 | hfy-chat-uat (io approval), hfy-chat-worker-ci | 0.5 d |

**Acceptance criteria:**

- **chat-research-intake**
  1. An ADR doc in docstore, linked to HFY-PLN-002 and DOC-926937A24A07, lists each research item as adopted, deviated (with reason, §3.2) or optional/never (§3.3).
  2. Recorded verbatim with dates: io's transport decision ("chat on cloudflare", 2026-10-13); the verified Workers Paid status; and io's decision on CHAT-D5.
  3. A fidelity value sheet tags every §15 value [S]/[I]/[DS]. The [I] mole dimensions and the "has entered text" and "sent at" wording are checked against at least two archived 2006–2012 screenshots, or left [I] with a note.
  4. The L-09 amendment text is drafted for `chat-kit-protocol`.
- **chat-cf-spike**
  1. A throwaway Worker plus a hibernating Durable Object on `harrisonfamily.us/chat/spike*` shows that the upgrade carries `io_id` and the exact `Origin`, and that WebCrypto RS256 verification against the live JWKS succeeds.
  2. `curl` of `/`, `/api/posts` (signed out: 401) and `/person/index.json` (signed out: 401) is unchanged while the route exists.
  3. The interaction of a pending alarm with hibernation is measured and recorded.
  4. Connect-to-first-frame and echo RTT p50/p95 are recorded from an installed iPhone PWA and from desktop.
  5. Zone settings that touch WebSockets on the Free Website plan (Bot Fight Mode, security level, WebSockets toggle) are recorded.
  6. A bundle upload through the Workers script upload API (curl, no wrangler) applies a `new_sqlite_classes` migration. The result decides the CI target's path in §17.1.
  7. The spike Worker and route are deleted. Evidence: the zone's Worker-route list is empty again.
- **chat-kit-protocol**
  1. Package scaffold registered: vitest aliases, tsconfig paths, `AREAS`, changeset.
  2. Frame decoders accept every §6.1/§6.2 example and reject 20 malformed fixtures.
  3. `checkText` and `checkGroupName` pass the CH-15/16 tables, as unit tests in this package.
  4. `timeMarks` and `typingLine` match fixture tables.
  5. `memoryTransport` is exported from `./testing`.
  6. The L-09 dated note and `chat-architecture.md` are added.
  7. No `node:` imports in `src/index.ts` (a lint test).
- **chat-kit-server-core**
  1. CH-01…CH-30, excluding 19, 24, 27 and 29 (those need the adapter), pass on MemoryStore and on SqlStore through `node:sqlite`.
  2. `ChatStore.append` is the only writer of `msg` and `member`.
  3. The pacing guard is evaluated in the same synchronous call as the `seq` assignment, which a test proves by injecting a presence change between frames.
- **chat-kit-client**
  1. The §19.2 chaos run (10,000 frames, 5 clients) ends with identical transcripts, zero loss and zero duplicates.
  2. Resume, gap fill and `more` paging tests pass.
  3. The exp make-before-break test shows no missing `seq` and a single `presence` stream.
  4. Fake-clock tests pin 3/5/7 s typing, 15 min idle and 25 s ping.
  5. The mobile close-on-hidden test passes.
  6. At most one queued outbox message per conversation.
- **chat-kit-cloudflare**
  1. Fake-`DurableObjectState` tests cover CH-19, 24, 27, 29 and the §6.5 close-code table.
  2. `verifySessionCookie` passes a port of every gate verification case (alg, kid, iss, aud, exp/nbf skew, sub, size).
  3. Attachments stay under 16 KiB with full token-bucket and typing state (a test asserts the size).
  4. No `node:` imports.
- **ci-kit-cloudflare-worker-target** (`@io-kit/ci`)
  1. The manifest schema accepts `targets[].type: cloudflare-worker` with `dir`, `environment`, `smoke` (url, expected version) and `routes_from: dist/deploy.json`.
  2. `io-kit-ci render` emits a composite action that uses `curl` and `jq` only (no npm, no wrangler at CI time) and does, in order: upload (bindings, migrations, compatibility date, vars, existing secrets kept), routes put, smoke, and rollback to the previous deployment on smoke failure.
  3. `io-kit-ci check` reports `pipeline_drift` for a hand-edited rendered file.
  4. Fixture tests run against a mocked Cloudflare API: success, an upload 4xx, a smoke failure triggering rollback, and the token never echoed (log scan).
  5. If `chat-cf-spike` AC6 failed, the alternative path (a vendored pinned wrangler tarball with checksum, `--no-bundle`) replaces step 1, with the same tests.
  6. A changeset is included; the Release job publishes, with CodeArtifact evidence.
- **chat-kit-react-conversation**
  1. Testing Library tests for every §19.3 composer and transcript item.
  2. axe has no violations for ConversationView and Composer.
  3. The token lint passes, with px only for the 16px and 44px exceptions.
  4. Copy strings come from one exported `CHAT_COPY` table that the host can override.
- **chat-kit-react-shell**
  1. Tests for roster ordering (online first, recent next, cap 40), search reaching every member, `q` focus rules, mole fitting and overflow at 1024/1280/1920 px mocked widths, the group options visibility matrix (creator/member × private/open) and NewChatPicker (DM versus group).
  2. axe has no violations.
  3. The release publishes `@io-kit/chat` with `react` exports. Evidence: CodeArtifact lists the version.
- **chat-kit-load-harness**
  1. `@io-kit/chat/testing/load` runs L1–L6 profiles against `loopbackServer` at a CI size of 50 clients, printing a p50/p95/p99 histogram as JSON.
  2. `testKeys` mints staging cookies against a generated JWKS; no production key path exists.
- **hfy-chat-api-service-routes**
  1. Three routes with the §14.3 payloads and errors; caps regenerated.
  2. §19.4 API tests pass.
  3. `chat_message` added to `TEMPLATE_REGISTRY` and to the islands `CATALOG` with identical strings (a test compares them).
  4. The app-stack change set adds only `ChatServicePublicKeys` and its env.
  5. Deployed, with io's go-ahead. Evidence: `GET /api/chat/directory` without a token returns 401, and with a token signed by a non-configured key also 401.
- **hfy-chat-worker**
  1. `chat-worker/` contains `wrangler.toml` (the `ChatHub` binding, migration `v1` `new_sqlite_classes`, routes `harrisonfamily.us/chat/ws*` and `harrisonfamily.us/chat/v1/*` only, `[env.staging]`), the entry, exact pins and the committed `dist/` with `deploy.json`. `npm run check` exits 0, meaning `dist/` is fresh.
  2. The staging env uses its own Durable Object namespace and a test JWKS.
  3. The smoke script passes against staging and production.
  4. First production deploy by the orchestrator (local wrangler, io's go-ahead), with `CHAT_OPEN_TO=uat`. `CHAT_SERVICE_PRIVATE_KEY` set as a Worker secret. Evidence:
     - health 200, reporting the commit sha;
     - a non-UAT member socket closes 4403;
     - signed-out `/person/index.json` is 401 and `/` is 200;
     - the zone's Worker-route list shows exactly the two chat routes.
  5. The archive mirror writes `CHAT#` items with no `ttl` (sampled).
  6. Docs updated: architecture, edge-and-origin, privacy, cost, `deploy-the-chat-worker.md`, `rotate-the-chat-service-key.md`.
- **hfy-chat-worker-ci**
  1. `ci.manifest.yaml` has the `cloudflare-worker` target. Workflows are re-rendered by `io-kit-ci render`, and `io-kit-ci check` reports no drift.
  2. The scoped token exists, with exactly the account Workers Scripts: Edit and zone Workers Routes: Edit permissions (a screenshot or API listing of its policies, with no value shown). It is stored with `gh secret set CLOUDFLARE_API_TOKEN` under io's go-ahead. Account and zone ids are repository variables, and `AGENTS.md:75` lists them.
  3. A no-op Worker change merged to `main` deploys through CI in the production environment: the smoke check is green and `health.version` equals the merge sha.
  4. A deliberately failing smoke on a branch dry run shows the rollback step selecting the previous deployment (mocked or staging).
  5. `docs/how-to/rotate-the-cloudflare-deploy-token.md` exists, and `deploy-the-chat-worker.md` describes CI as the normal path and local wrangler only for staging and emergencies.
- **hfy-chat-island**
  1. §19.4 Playwright `chat.spec.mjs` passes, including flag-off making no chat request and the 375 px checks.
  2. `npm run check:islands` exits 0, and every built output is committed.
  3. `/chat/` is in `PAGES`, `COPY_EXTRA` and the README list, and is mirrored to the Eleventy source.
  4. The client R-18 pre-check uses the same detector module as the server.
  5. `chatV1` is `false` in both `flags.json` copies.
- **hfy-chat-shell-presence**
  1. The entry icon renders only with `chatV1` and a signed-in session.
  2. The unread dot reflects summaries.
  3. The profile dot and text appear for eligible members only, never on non-member pages (a spec with fixtures).
  4. The bottom bar is hidden only while a mobile conversation is open.
  5. Sign-out clears `hfy:chat:*`.
  6. `shell.spec.mjs` and `person-page.spec.mjs` are updated and pass.
- **hfy-chat-load-latency**
  1. L1–L6 run against staging, with results compared to §20.1 in a report doc linked from the task.
  2. Any miss becomes a filed fix task, or a recorded io waiver.
  3. iPhone RTT samples are attached.
- **hfy-chat-uat**
  1. The D-11 audit is green for the dock, `/chat/` desktop, `/chat/` 375 px and profile presence, with screenshots under the task asset prefix (HFY-R16).
  2. The R-33…R-41 checklist is executed on production with `?hfy_flags=chatV1` and UAT subjects: the pacing matrix on two phones, late join, leave and re-invite, three-person typing, a push to a locked phone, and the 30-day boundary on a seeded staging conversation.
  3. io's approval is recorded verbatim.
- **hfy-chat-flip**
  1. `chatV1: true` in `flags.json` and the Eleventy source, and `CHAT_OPEN_TO=all`, in the same window.
  2. Evidence: `curl /_data/flags.json | jq .chatV1` returns `true`; a non-UAT member connects and gets `welcome`.
  3. The rollback steps (§21) are in the PR body.

## 26. Risks

- **A second platform and a new CI credential.** Cloudflare compute adds a toolchain and a long-lived deploy token in GitHub secrets. Mitigations:
  - the token is scoped to Workers Scripts on the account and Workers Routes on this one zone, with a 1-year TTL and a rotation how-to;
  - deploys run only in the io-approved production environment;
  - the bundle is committed and checked fresh;
  - the rendered pipeline is drift-checked;
  - nothing in Cloudflare is configured outside `chat-worker/` and the CI target.

  The zone's other settings (WAF, cache) stay dashboard-only, as today (`edge-and-origin-design.md:175`).
- **A second session verifier outside CloudFront.** The Worker re-implements the gate's checks. Mitigation: port the gate's test cases (AC on `chat-kit-cloudflare`), and use the same JWKS and skew.
- **Pacing on phones (CHAT-D5).** Because iOS suspends background PWAs, nearly every phone-to-phone direct chat will be paced. This is io's rule working as written, and io should see it at UAT. Any looser definition (a longer grace) is io's call.
- **Hourly reconnects and a reconnect per page view.** These come from the 1 h `io_id` and the multi-page site. Mitigations: make-before-break, the snapshot and the grace. Hub load is trivial, but every page view pays one connect (L6 measures it).
- **One hub.** A deploy or crash drops every socket at once (L3), and a bug in the core affects every conversation. Mitigations: the conformance suite, the staging soak, and the split path.
- **Durable Object data loss by migration error.** A `deleted_classes` or rename migration destroys the hub. Mitigations: the archive mirror in DynamoDB, a written rule in `deploy-the-chat-worker.md`, and Cloudflare's SQLite point-in-time recovery.
- **Cross-domain coupling:**
  - the R-18 detector (privacy-guards domain) must be pure ESM;
  - the notifications domain owns the bell, the inbox and the app badge;
  - the nav domain (R-20/R-21) owns the top bar.
  
  Three domains want space in `.hfy-bar__end` at 375 px, so a joint 375 px layout check is needed.
- **Unverified Gmail details.** Mole sizes, the "has entered text" wording, the timing of the "sent at" line, and overflow behaviour are not confirmed. Mitigations: tagged [I], checked in the intake, and cuttable at UAT.
- **No moderation or block in chat.** R-32 does not cover chat, and io excluded extras. A harassment case has no in-product tool, only an operator export. Listed as optional (§3.3).
- **Privacy disclosure.** Chat content is stored at Cloudflare, a new processor. The privacy and terms update needs a chat clause that io approves before the flip.
- **Shared Workers Paid quotas.** The account's subscription and its included quotas are shared with 4 other Workers. A runaway Worker elsewhere could push the account into overage, which is billed, not blocked. The marginal cost of chat is about $0.05 a month (§23).
- **The upload-API path for Durable Object migrations is unproven.** The CI target's zero-dependency upload must apply `new_sqlite_classes`. `chat-cf-spike` AC6 tests it; the fallback is a vendored pinned wrangler (§17.1).
- **Kit release friction.** harrisonfamily sits outside the bump bot and pins by hand. Two release conventions also conflict for a new package's first release.
- **Cloudflare zone settings** (WAF, Bot Fight, rules) could challenge or close WebSockets. The spike checks for this, but they are dashboard settings no repo controls.

## 27. Requirement coverage

| req | where in this design | tasks |
|---|---|---|
| R-33 | §2, §3, §15, §16 | chat-research-intake, chat-kit-protocol, chat-kit-react-conversation, chat-kit-react-shell, hfy-chat-island, hfy-chat-uat |
| R-34 | §12, §15.5 | chat-kit-protocol, chat-kit-react-conversation, hfy-chat-island |
| R-35 | §7, §8.3, CHAT-D9 | chat-kit-server-core, hfy-chat-api-service-routes, hfy-chat-worker |
| R-36 | §8.1, §15.1 | chat-kit-server-core, chat-kit-react-shell, hfy-chat-api-service-routes, hfy-chat-island |
| R-37 | §10 | chat-kit-server-core, chat-kit-cloudflare, chat-kit-react-shell, hfy-chat-shell-presence |
| R-38 | §8.2 | chat-kit-server-core, chat-kit-react-shell, hfy-chat-island |
| R-39 | §9 | chat-kit-server-core, chat-kit-client, chat-kit-cloudflare, hfy-chat-worker, hfy-chat-uat |
| R-40 | §11 | chat-kit-protocol, chat-kit-server-core, chat-kit-client, chat-kit-react-conversation |
| R-41 | §4, §5.3, §17.1, §20 | chat-cf-spike, chat-kit-load-harness, ci-kit-cloudflare-worker-target, hfy-chat-worker-ci, hfy-chat-load-latency, hfy-chat-uat |
